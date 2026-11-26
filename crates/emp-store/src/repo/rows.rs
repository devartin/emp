//! Database rows (SPEC §8.1, §8.6, §10.2 `db_rows`, §11.3 `db_row_*` / `db_rows_*` / `db_query*` /
//! `db_chart_data` / `row_secret_reveal`).
//!
//! * Values are validated against their property type; derived columns (formula, rollup, created/updated time)
//!   are never stored. `unique_id` values come from the database's monotonic `uidSeq`.
//! * Two-way relations: writing a relation cell updates the paired property of every added / removed target row in
//!   the same transaction.
//! * Templates resolve `@today`, `@now`, `@today±N(d|w|m)`, `@name` and `@seq` when a row is created.
//! * `db_query` runs the [`crate::query::engine`] pipeline over the database and its related databases and returns
//!   a window plus a `queryRev`; a matching `knownQueryRev` short-circuits to `notModified`.
//! * Secret cells store their value in the `secrets` table (provider `emp:row`); rows only keep a mask.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use chrono::{Duration, Months};
use emp_crypto::{SecretString, TableTag};
use rusqlite::{Connection, params};
use serde_json::Value;

use crate::codec::{Codec, RecordLoc};
use crate::model::sort_key::n_keys_between;
use crate::model::{SearchHitKind, SecretKind, SecurityEvent, TipTapDoc, ids::new_id};
use crate::query::cells;
use crate::query::chart::{DEFAULT_MAX_POINTS, chart_data};
use crate::query::compute::{Evaluator, RowRec, World};
use crate::query::config::HasConfig;
use crate::query::dates::DateCtx;
use crate::query::engine::{self, MAX_WINDOW, QuerySpec, fnv64};
use crate::query::filter;
use crate::query::model::{
    CellValue, ChartData, ChartSpec, DateValue, Filter, FilterOp, GroupValue, PropType, Property,
    QueryRequest, QueryResponse, QueryResult, RowCreate, RowDto, RowGet, RowPayload, RowTemplate,
    RowUpdate, SecretMask, TemplateValue,
};
use crate::repo::databases::{
    bump, live_properties, load_db, load_world, page_info, save_db, uid_value,
};
use crate::repo::docs::{insert_or_replace_doc, load_doc};
use crate::repo::views::load_view;
use crate::search::SearchDoc;
use crate::vault::Session;
use crate::{Result, Store, StoreError};

/// Maximum rows per bulk call (SPEC §11.3 `db_rows_update` ≤ 1,000).
pub const MAX_BATCH: usize = 1_000;
/// Maximum rows per database.
pub const MAX_ROWS: usize = 1_000_000;
/// Maximum rows returned by `db_query_range`.
pub const MAX_RANGE_ROWS: usize = 5_000;
/// Internal provider of row secrets.
pub const ROW_SECRET_PROVIDER: &str = "emp:row";

pub(crate) fn row_loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::DbRows, id, u64::try_from(rev).unwrap_or(0))
}

const ROW_COLS: &str = "r.id, r.sort_key, r.created_at, r.updated_at, r.rev, r.enc, r.payload, \
     EXISTS(SELECT 1 FROM page_docs d WHERE d.owner_id = r.id), r.database_id, r.deleted_at";

fn read_row(codec: &Codec, r: &rusqlite::Row<'_>) -> Result<(RowRec, String, Option<i64>)> {
    let id: String = r.get(0)?;
    let rev: i64 = r.get(4)?;
    let enc: i64 = r.get(5)?;
    let payload: Vec<u8> = r.get(6)?;
    Ok((
        RowRec {
            payload: codec.decode(&row_loc(&id, rev), enc, &payload)?,
            id,
            sort_key: r.get(1)?,
            created_at: r.get(2)?,
            updated_at: r.get(3)?,
            rev,
            has_body: r.get(7)?,
        },
        r.get(8)?,
        r.get(9)?,
    ))
}

/// Live rows of a database in manual order. Damaged rows are skipped (the integrity check reports them).
pub(crate) fn load_rows(conn: &Connection, codec: &Codec, db_id: &str) -> Result<Vec<RowRec>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {ROW_COLS} FROM db_rows r WHERE r.database_id = ?1 AND r.deleted_at IS NULL ORDER BY r.sort_key, r.id"
    ))?;
    let mut q = st.query([db_id])?;
    let mut out = Vec::new();
    while let Some(r) = q.next()? {
        match read_row(codec, r) {
            Ok((row, _, _)) => out.push(row),
            Err(StoreError::Damaged { .. }) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// One row (live or trashed) with its database id and `deleted_at`.
pub(crate) fn load_row(
    conn: &Connection,
    codec: &Codec,
    id: &str,
) -> Result<Option<(RowRec, String, Option<i64>)>> {
    let mut st =
        conn.prepare_cached(&format!("SELECT {ROW_COLS} FROM db_rows r WHERE r.id = ?1"))?;
    let mut q = st.query([id])?;
    match q.next()? {
        Some(r) => Ok(Some(read_row(codec, r)?)),
        None => Ok(None),
    }
}

pub(crate) fn insert_row(
    tx: &Connection,
    codec: &Codec,
    db_id: &str,
    id: &str,
    sort_key: &str,
    p: &RowPayload,
    now: i64,
) -> Result<()> {
    let e = codec.encode(&row_loc(id, 1), p)?;
    tx.prepare_cached(
        "INSERT INTO db_rows (id, database_id, sort_key, created_at, updated_at, deleted_at, rev, enc, payload)
         VALUES (?1, ?2, ?3, ?4, ?4, NULL, 1, ?5, ?6)",
    )?
    .execute(params![id, db_id, sort_key, now, e.enc, e.payload])?;
    Ok(())
}

/// Rewrites a row payload (`rev + 1`, `updated_at = now`). Returns the new rev.
pub(crate) fn save_row_payload(
    tx: &Connection,
    codec: &Codec,
    id: &str,
    old_rev: i64,
    p: &RowPayload,
    now: i64,
) -> Result<i64> {
    let rev = old_rev + 1;
    let e = codec.encode(&row_loc(id, rev), p)?;
    tx.prepare_cached(
        "UPDATE db_rows SET rev = ?2, updated_at = ?3, enc = ?4, payload = ?5 WHERE id = ?1",
    )?
    .execute(params![id, rev, now, e.enc, e.payload])?;
    Ok(rev)
}

fn row_keys(tx: &Connection, db_id: &str) -> Result<Vec<(String, String)>> {
    let mut st = tx.prepare_cached(
        "SELECT id, sort_key FROM db_rows WHERE database_id = ?1 AND deleted_at IS NULL ORDER BY sort_key, id",
    )?;
    let rows = st.query_map([db_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn count_rows(tx: &Connection, db_id: &str) -> Result<usize> {
    let n: i64 = tx.query_row(
        "SELECT count(*) FROM db_rows WHERE database_id = ?1 AND deleted_at IS NULL",
        [db_id],
        |r| r.get(0),
    )?;
    Ok(usize::try_from(n).unwrap_or(0))
}

#[allow(clippy::too_many_arguments)]
/// Updates the paired property of related rows after `row_id`'s relation `prop` changed from `old` to `new`.
fn sync_dual(
    tx: &Connection,
    codec: &Codec,
    prop: &Property,
    row_id: &str,
    old: &[String],
    new: &[String],
    now: i64,
    touched: &mut HashSet<String>,
) -> Result<()> {
    let rc = prop.relation();
    let Some(dual) = rc.dual_prop() else {
        return Ok(());
    };
    let target_props = live_properties(tx, codec, &rc.target_database_id)?;
    let Some(dprop) = target_props.iter().find(|p| p.id == dual) else {
        return Ok(());
    };
    let dual_single = dprop.relation().single();
    let added = new.iter().filter(|x| !old.contains(x));
    let removed = old.iter().filter(|x| !new.contains(x));
    for (tid, add) in added.map(|x| (x, true)).chain(removed.map(|x| (x, false))) {
        let Some((t, tdb, _)) = load_row(tx, codec, tid)? else {
            continue;
        };
        if tdb != rc.target_database_id {
            continue;
        }
        let mut p = t.payload.clone();
        let mut ids = cells::ids(p.values.get(dual));
        let before = ids.clone();
        if add {
            if dual_single {
                // The target row's previous partner loses it.
                for prev in ids.iter().filter(|x| x.as_str() != row_id) {
                    if let Some((pr, _, _)) = load_row(tx, codec, prev)? {
                        let mut pp = pr.payload.clone();
                        let mut pids = cells::ids(pp.values.get(&prop.id));
                        pids.retain(|x| x != tid);
                        set_relation(&mut pp, &prop.id, pids);
                        save_row_payload(tx, codec, &pr.id, pr.rev, &pp, now)?;
                    }
                }
                ids = vec![row_id.to_owned()];
            } else if !ids.iter().any(|x| x == row_id) {
                ids.push(row_id.to_owned());
            }
        } else {
            ids.retain(|x| x != row_id);
        }
        if ids != before {
            set_relation(&mut p, dual, ids);
            save_row_payload(tx, codec, &t.id, t.rev, &p, now)?;
            touched.insert(tdb);
        }
    }
    Ok(())
}

fn set_relation(p: &mut RowPayload, prop: &str, ids: Vec<String>) {
    if ids.is_empty() {
        p.values.remove(prop);
    } else {
        p.values
            .insert(prop.to_owned(), CellValue::Relation { v: ids });
    }
}

/// Resolves a template value for a property.
fn resolve_template(
    v: &TemplateValue,
    p: &Property,
    ctx: &DateCtx,
    profile: &str,
    seq: i64,
) -> Option<CellValue> {
    let tok = match v {
        TemplateValue::Cell(c) => return Some(c.clone()),
        TemplateValue::Token(t) => t.trim(),
    };
    let today = ctx.today();
    let date_cell = |d: chrono::NaiveDate| CellValue::Date {
        v: Some(DateValue {
            start: d.format("%Y-%m-%d").to_string(),
            end: None,
            time: false,
            tz: None,
        }),
    };
    if tok == "@now" {
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ctx.now_ms)?
            .with_timezone(&ctx.tz)
            .to_rfc3339();
        return Some(match p.kind {
            PropType::Date => CellValue::Date {
                v: Some(DateValue {
                    start: now,
                    end: None,
                    time: true,
                    tz: Some(ctx.tz.name().to_owned()),
                }),
            },
            _ => CellValue::text(&now),
        });
    }
    if let Some(rest) = tok.strip_prefix("@today") {
        let d = if rest.is_empty() {
            Some(today)
        } else {
            let (sign, body) = match rest.chars().next()? {
                '+' => (1, &rest[1..]),
                '-' => (-1, &rest[1..]),
                _ => return cells::from_text(p, tok),
            };
            let unit = body.chars().last()?;
            let n: i64 = body[..body.len() - 1].parse().ok()?;
            let n = n.clamp(0, 36_500) * sign;
            match unit {
                'd' => Some(today + Duration::days(n)),
                'w' => Some(today + Duration::weeks(n)),
                'm' => {
                    let m = Months::new(u32::try_from(n.unsigned_abs()).ok()?);
                    if n >= 0 {
                        today.checked_add_months(m)
                    } else {
                        today.checked_sub_months(m)
                    }
                }
                _ => None,
            }
        }?;
        return Some(match p.kind {
            PropType::Date => date_cell(d),
            _ => CellValue::text(&d.format("%Y-%m-%d").to_string()),
        });
    }
    match tok {
        "@name" => cells::from_text(p, profile).or_else(|| Some(CellValue::text(profile))),
        "@seq" => match p.kind {
            PropType::Number => Some(CellValue::number(seq as f64)),
            _ => Some(CellValue::text(&seq.to_string())),
        },
        other => cells::from_text(p, other),
    }
}

/// Simple `eq` conditions of a view filter used to pre-fill new rows created from that view.
fn prefill_from_filter(f: &Filter, props: &[Property], out: &mut BTreeMap<String, CellValue>) {
    match f {
        Filter::And { and } => and.iter().for_each(|k| prefill_from_filter(k, props, out)),
        Filter::Or { .. } => {}
        Filter::Cond { prop, op, value } => {
            let Some(p) = props.iter().find(|p| &p.id == prop) else {
                return;
            };
            let v = match (p.kind, op, value) {
                (PropType::Checkbox, FilterOp::Checked, _) => Some(CellValue::Check { v: true }),
                (PropType::Select, FilterOp::Eq, Some(Value::String(s))) => {
                    Some(CellValue::Select { v: Some(s.clone()) })
                }
                (PropType::Status, FilterOp::Eq, Some(Value::String(s))) => {
                    Some(CellValue::Status { v: Some(s.clone()) })
                }
                (
                    PropType::MultiSelect | PropType::Relation,
                    FilterOp::Contains | FilterOp::AnyOf,
                    Some(v),
                ) => {
                    let ids: Vec<String> = match v {
                        Value::String(s) => vec![s.clone()],
                        Value::Array(a) if a.len() == 1 => a
                            .iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect(),
                        _ => Vec::new(),
                    };
                    (!ids.is_empty()).then(|| {
                        if p.kind == PropType::Relation {
                            CellValue::Relation { v: ids }
                        } else {
                            CellValue::Multi { v: ids }
                        }
                    })
                }
                (
                    PropType::Text
                    | PropType::Number
                    | PropType::Url
                    | PropType::Email
                    | PropType::Phone,
                    FilterOp::Eq,
                    Some(Value::String(s)),
                ) => cells::from_text(p, s),
                (PropType::Number, FilterOp::Eq, Some(Value::Number(n))) => {
                    n.as_f64().map(CellValue::number)
                }
                _ => None,
            };
            if let Some(v) = v.and_then(|v| cells::validate(p, v).ok().flatten()) {
                out.entry(p.id.clone()).or_insert(v);
            }
        }
    }
}

/// Validated stored values from user input (read-only and unknown properties rejected).
fn checked_values(
    props: &[Property],
    values: BTreeMap<String, CellValue>,
) -> Result<BTreeMap<String, CellValue>> {
    let mut out = BTreeMap::new();
    for (k, v) in values {
        let p = props
            .iter()
            .find(|p| p.id == k)
            .ok_or_else(|| StoreError::invalid_field("values", "unknown property"))?;
        if p.kind.is_read_only() || p.kind == PropType::Secret {
            return Err(StoreError::invalid_field(
                "values",
                format!("{} is read-only", p.name),
            ));
        }
        if let Some(v) = cells::validate(p, v)? {
            out.insert(k, v);
        }
    }
    Ok(out)
}

/// Inputs of one row insert inside a transaction.
pub(crate) struct NewRow {
    pub values: BTreeMap<String, CellValue>,
    pub icon: Option<crate::model::Icon>,
    pub doc: Option<TipTapDoc>,
    pub tags: Option<Vec<String>>,
}

#[allow(clippy::too_many_arguments)]
/// Inserts a row (uid assignment, dual relations), returning its id. `sort_key` must already be computed.
pub(crate) fn create_row_tx(
    tx: &Connection,
    codec: &Codec,
    db_id: &str,
    props: &[Property],
    row: NewRow,
    sort_key: &str,
    now: i64,
    touched: &mut HashSet<String>,
) -> Result<String> {
    let mut dbr = load_db(tx, codec, db_id)?;
    let mut payload = RowPayload {
        v: 1,
        values: row.values,
        icon: row.icon,
        tags: row.tags,
        secrets: BTreeMap::new(),
    };
    let uid_props: Vec<&Property> = props
        .iter()
        .filter(|p| p.kind == PropType::UniqueId)
        .collect();
    if !uid_props.is_empty() {
        dbr.payload.uid_seq += 1;
        for p in uid_props {
            payload.values.insert(
                p.id.clone(),
                uid_value(dbr.payload.uid_prefix.as_deref(), dbr.payload.uid_seq),
            );
        }
        save_db(tx, codec, &dbr, &dbr.payload)?;
    }
    let id = new_id();
    insert_row(tx, codec, db_id, &id, sort_key, &payload, now)?;
    if let Some(d) = &row.doc {
        insert_or_replace_doc(tx, codec, &id, "row", d, 1, now)?;
    }
    for p in props.iter().filter(|p| p.kind == PropType::Relation) {
        let ids = cells::ids(payload.values.get(&p.id));
        if !ids.is_empty() {
            sync_dual(tx, codec, p, &id, &[], &ids, now, touched)?;
        }
    }
    touched.insert(db_id.to_owned());
    Ok(id)
}

/// The query rev inputs: `(db id, data_rev, schema_rev)` of a database and its related databases.
fn rev_inputs(conn: &Connection, codec: &Codec, db_id: &str) -> Result<Vec<(String, i64, i64)>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = vec![db_id.to_owned()];
    while let Some(d) = queue.pop() {
        if !seen.insert(d.clone()) || out.len() >= crate::query::compute::MAX_WORLD_DBS {
            continue;
        }
        let r: Option<(i64, i64)> = rusqlite::OptionalExtension::optional(
            conn.prepare_cached("SELECT data_rev, schema_rev FROM databases WHERE id = ?1")?
                .query_row([&d], |r| Ok((r.get(0)?, r.get(1)?))),
        )?;
        let Some((dr, sr)) = r else { continue };
        out.push((d.clone(), dr, sr));
        queue.extend(crate::query::compute::relation_targets(&live_properties(
            conn, codec, &d,
        )?));
    }
    out.sort();
    Ok(out)
}

impl Store {
    fn index_rows(&self, s: &Arc<Session>, world: &World, db_id: &str, ids: &[String]) {
        if !s.index_state.lock().ready {
            return;
        }
        let Some(ord) = world.ord(db_id) else { return };
        let d = world.at(ord);
        // Row bodies are searchable like page text (block ids let a hit jump to the block).
        let with_body: Vec<&String> = ids
            .iter()
            .filter(|id| d.row_index(id).is_some_and(|i| d.rows[i].has_body))
            .collect();
        let bodies: std::collections::HashMap<String, Vec<(String, String)>> =
            if with_body.is_empty() {
                std::collections::HashMap::new()
            } else {
                self.read(|c| {
                    let mut out = std::collections::HashMap::new();
                    for id in &with_body {
                        // A damaged body is reported by the integrity check; the row stays findable by title.
                        if let Ok(Some((doc, _))) = crate::repo::docs::load_doc(c, &s.codec, id) {
                            let blocks = crate::doc::index::extract(&doc)
                                .blocks
                                .into_iter()
                                .map(|b| (b.id, b.text))
                                .collect();
                            out.insert((*id).clone(), blocks);
                        }
                    }
                    Ok(out)
                })
                .unwrap_or_default()
            };
        let mut idx = s.search.write();
        for id in ids {
            match d.row_index(id) {
                Some(i) => idx.upsert(SearchDoc {
                    id: id.clone(),
                    kind: SearchHitKind::Row,
                    title: d.row_title(i),
                    icon: d.rows[i].payload.icon.clone(),
                    parent_id: Some(db_id.to_owned()),
                    db_id: Some(db_id.to_owned()),
                    updated_at: d.rows[i].updated_at,
                    blocks: bodies.get(id).cloned().unwrap_or_default(),
                    hidden: false,
                }),
                None => idx.remove(id),
            }
        }
    }

    /// Adds every live row of every database to the search index (call after `search:ready`; the page index
    /// build does not include rows).
    pub fn db_index_rows(&self) -> Result<usize> {
        let s = self.session()?;
        let dbs: Vec<String> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT id FROM databases")?;
            let rows = st.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        let mut n = 0;
        for db in dbs {
            let world = self.read(|c| load_world(c, &s.codec, &db))?;
            let ids: Vec<String> = world
                .db(&db)
                .map(|d| d.rows.iter().map(|r| r.id.clone()).collect())
                .unwrap_or_default();
            n += ids.len();
            self.index_rows(&s, &world, &db, &ids);
        }
        Ok(n)
    }

    /// Row DTOs (with derived values) of rows of one database.
    pub(crate) fn rows_dto(
        &self,
        s: &Arc<Session>,
        db_id: &str,
        ids: &[String],
    ) -> Result<Vec<RowDto>> {
        let ctx = self.date_ctx()?;
        let world = self.read(|c| {
            // Without formulas / rollups a row's DTO depends on the row alone: skip loading the database.
            let props = live_properties(c, &s.codec, db_id)?;
            if props
                .iter()
                .any(|p| matches!(p.kind, PropType::Formula | PropType::Rollup))
            {
                return load_world(c, &s.codec, db_id);
            }
            let mut rows = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some((r, d, None)) = load_row(c, &s.codec, id)?
                    && d == db_id
                {
                    rows.push(r);
                }
            }
            let db = load_db(c, &s.codec, db_id)?;
            Ok(World::new(vec![crate::query::compute::DbData::new(
                db_id.to_owned(),
                String::new(),
                db.payload,
                props,
                rows,
                db.data_rev,
                db.schema_rev,
            )]))
        })?;
        self.index_rows(s, &world, db_id, ids);
        let ev = Evaluator::new(&world, ctx);
        let ord = world.ord(db_id).ok_or(StoreError::NotFound("database"))?;
        let d = world.at(ord);
        Ok(ids
            .iter()
            .filter_map(|id| d.row_index(id))
            .filter_map(|i| ev.row_dto(ord, i, None))
            .collect())
    }

    fn notify_dbs(&self, dbs: impl IntoIterator<Item = String>) {
        self.db_changes(dbs.into_iter().map(|d| (d, None)).collect());
    }

    /// Like [`Self::notify_dbs`], naming the changed rows of each database when `rows` lists them.
    fn notify_dbs_rows(
        &self,
        dbs: impl IntoIterator<Item = String>,
        rows: Option<&BTreeMap<String, Vec<String>>>,
    ) {
        self.db_changes(
            dbs.into_iter()
                .map(|d| {
                    let ids = rows.and_then(|m| m.get(&d).cloned());
                    (d, ids)
                })
                .collect(),
        );
    }

    /// `db_row_create`: values, a template (or the database default) and the filter of `view_id` pre-fill the row.
    pub fn db_row_create(&self, req: RowCreate) -> Result<RowDto> {
        let s = self.session()?;
        let now = self.now();
        let ctx = self.date_ctx()?;
        let profile = self
            .vault_settings()
            .map(|v| v.profile_name)
            .unwrap_or_default();
        let sess = Arc::clone(&s);
        let db_id = req.database_id.clone();
        let (id, touched, is_txn) = self.write(move |tx| {
            let codec = &sess.codec;
            let dbr = load_db(tx, codec, &req.database_id)?;
            let is_txn = dbr.payload.roles.contains_key("txn.amount");
            if count_rows(tx, &req.database_id)? >= MAX_ROWS {
                return Err(StoreError::TooLarge("rows"));
            }
            let props = live_properties(tx, codec, &req.database_id)?;
            let mut values = checked_values(&props, req.values.unwrap_or_default())?;
            let tpl: Option<RowTemplate> = match req
                .template_id
                .as_ref()
                .or(dbr.payload.default_template_id.as_ref())
            {
                Some(t) => {
                    let found = dbr.payload.templates.iter().find(|x| &x.id == t).cloned();
                    if found.is_none() && req.template_id.is_some() {
                        return Err(StoreError::NotFound("template"));
                    }
                    found
                }
                None => None,
            };
            let mut icon = None;
            let mut doc = None;
            if let Some(t) = &tpl {
                let seq = dbr.payload.uid_seq + 1;
                for (k, tv) in &t.values {
                    let Some(p) = props.iter().find(|p| &p.id == k) else {
                        continue;
                    };
                    if values.contains_key(k) || p.kind.is_read_only() || p.kind == PropType::Secret
                    {
                        continue;
                    }
                    if let Some(v) = resolve_template(tv, p, &ctx, &profile, seq)
                        && let Ok(Some(v)) = cells::validate(p, v)
                    {
                        values.insert(k.clone(), v);
                    }
                }
                icon.clone_from(&t.icon);
                if let Some(d) = &t.doc {
                    let mut d = d.clone();
                    crate::doc::schema::regenerate_ids(&mut d)?;
                    crate::doc::schema::normalize(&mut d)?;
                    doc = Some(d);
                }
            }
            if let Some(v) = &req.view_id
                && let Some(f) = load_view(tx, codec, &req.database_id, v)?.filter
            {
                let mut pre = BTreeMap::new();
                prefill_from_filter(&f, &props, &mut pre);
                for (k, v) in pre {
                    values.entry(k).or_insert(v);
                }
            }
            let keys = row_keys(tx, &req.database_id)?;
            let key =
                crate::repo::databases::key_among(&keys, req.after_id.as_deref(), None, None)?;
            let mut touched = HashSet::new();
            let id = create_row_tx(
                tx,
                codec,
                &req.database_id,
                &props,
                NewRow {
                    values,
                    icon,
                    doc,
                    tags: None,
                },
                &key,
                now,
                &mut touched,
            )?;
            for d in &touched {
                bump(tx, d, false, true)?;
            }
            Ok((id, touched, is_txn))
        })?;
        self.notify_dbs(touched);
        if is_txn {
            self.tour_tick_quiet("add_transaction");
        }
        self.rows_dto(&s, &db_id, std::slice::from_ref(&id))?
            .pop()
            .ok_or(StoreError::NotFound("row"))
    }

    /// `db_row_get`: the row, its body document and its neighbours in manual order.
    pub fn db_row_get(&self, id: &str) -> Result<RowGet> {
        let s = self.session()?;
        let (db_id, doc, prev, next) = self.read(|c| {
            let (_, db, _) = load_row(c, &s.codec, id)?.ok_or(StoreError::NotFound("row"))?;
            let doc = load_doc(c, &s.codec, id)?;
            let keys = row_keys(c, &db)?;
            let pos = keys.iter().position(|(k, _)| k == id);
            let prev = pos
                .and_then(|i| i.checked_sub(1))
                .map(|i| keys[i].0.clone());
            let next = pos.and_then(|i| keys.get(i + 1)).map(|k| k.0.clone());
            Ok((db, doc, prev, next))
        })?;
        let row = match self.rows_dto(&s, &db_id, &[id.to_owned()])?.pop() {
            Some(r) => r,
            None => {
                // A trashed row: stored values only.
                let (r, _, _) = self
                    .read(|c| load_row(c, &s.codec, id))?
                    .ok_or(StoreError::NotFound("row"))?;
                RowDto {
                    id: r.id,
                    rev: r.rev,
                    sort_key: r.sort_key,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                    values: r.payload.values,
                    has_body: r.has_body,
                    icon: r.payload.icon,
                    sample: None,
                }
            }
        };
        let (doc, doc_rev) = match doc {
            Some((d, r)) => (Some(d), r),
            None => (None, 0),
        };
        Ok(RowGet {
            row,
            doc,
            doc_rev,
            database_id: db_id,
            prev_id: prev,
            next_id: next,
        })
    }

    /// `db_rows_update` (≤ 1,000): `null` clears a value; `baseRev` gives optimistic concurrency.
    pub fn db_rows_update(&self, updates: Vec<RowUpdate>) -> Result<Vec<RowDto>> {
        if updates.len() > MAX_BATCH {
            return Err(StoreError::TooLarge("too many rows"));
        }
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (by_db, touched, relations_changed) = self.write(move |tx| {
            let codec = &sess.codec;
            let mut by_db: BTreeMap<String, Vec<String>> = BTreeMap::new();
            let mut touched = HashSet::new();
            let mut relations_changed = false;
            let mut props_cache: BTreeMap<String, Vec<Property>> = BTreeMap::new();
            for u in updates {
                let (r, db, deleted) =
                    load_row(tx, codec, &u.id)?.ok_or(StoreError::NotFound("row"))?;
                if deleted.is_some() {
                    return Err(StoreError::invalid("the row is in the trash"));
                }
                if let Some(b) = u.base_rev
                    && b != r.rev
                {
                    return Err(StoreError::Conflict { current_rev: r.rev });
                }
                if !props_cache.contains_key(&db) {
                    props_cache.insert(db.clone(), live_properties(tx, codec, &db)?);
                }
                let props = &props_cache[&db];
                let mut p = r.payload.clone();
                let mut rel_changes = Vec::new();
                for (k, v) in u.values {
                    let prop = props
                        .iter()
                        .find(|x| x.id == k)
                        .ok_or_else(|| StoreError::invalid_field("values", "unknown property"))?;
                    if prop.kind.is_read_only() || prop.kind == PropType::Secret {
                        return Err(StoreError::invalid_field(
                            "values",
                            format!("{} is read-only", prop.name),
                        ));
                    }
                    let old_ids = cells::ids(p.values.get(&k));
                    match v.map(|v| cells::validate(prop, v)).transpose()?.flatten() {
                        Some(v) => p.values.insert(k.clone(), v),
                        None => p.values.remove(&k),
                    };
                    if prop.kind == PropType::Relation {
                        rel_changes.push((prop.clone(), old_ids, cells::ids(p.values.get(&k))));
                    }
                }
                save_row_payload(tx, codec, &r.id, r.rev, &p, now)?;
                for (prop, old, new) in rel_changes {
                    relations_changed = true;
                    sync_dual(tx, codec, &prop, &r.id, &old, &new, now, &mut touched)?;
                }
                touched.insert(db.clone());
                by_db.entry(db).or_default().push(r.id);
            }
            for d in &touched {
                bump(tx, d, false, true)?;
            }
            Ok((by_db, touched, relations_changed))
        })?;
        // Relation edits also rewrite paired rows (and rollups elsewhere): those need a full re-query.
        self.notify_dbs_rows(touched, (!relations_changed).then_some(&by_db));
        let mut out = Vec::new();
        for (db, ids) in by_db {
            out.extend(self.rows_dto(&s, &db, &ids)?);
        }
        Ok(out)
    }

    /// `db_rows_delete` (soft; restorable with `db_rows_restore`).
    pub fn db_rows_delete(&self, ids: &[String]) -> Result<()> {
        if ids.len() > MAX_BATCH {
            return Err(StoreError::TooLarge("too many rows"));
        }
        let s = self.session()?;
        let now = self.now();
        let ids_v = ids.to_vec();
        let touched = self.write(move |tx| {
            let mut touched = HashSet::new();
            for id in ids_v {
                let db: Option<String> = rusqlite::OptionalExtension::optional(
                    tx.prepare_cached(
                        "SELECT database_id FROM db_rows WHERE id = ?1 AND deleted_at IS NULL",
                    )?
                    .query_row([&id], |r| r.get(0)),
                )?;
                let Some(db) = db else { continue };
                tx.prepare_cached("UPDATE db_rows SET deleted_at = ?2 WHERE id = ?1")?
                    .execute(params![id, now])?;
                touched.insert(db);
            }
            for d in &touched {
                bump(tx, d, false, true)?;
            }
            Ok(touched)
        })?;
        {
            let mut idx = s.search.write();
            for id in ids {
                idx.remove(id);
            }
        }
        self.notify_dbs(touched);
        Ok(())
    }

    /// `db_rows_restore`.
    pub fn db_rows_restore(&self, ids: &[String]) -> Result<Vec<RowDto>> {
        if ids.len() > MAX_BATCH {
            return Err(StoreError::TooLarge("too many rows"));
        }
        let s = self.session()?;
        let ids_v = ids.to_vec();
        let by_db: BTreeMap<String, Vec<String>> = self.write(move |tx| {
            let mut by: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for id in ids_v {
                let db: Option<String> = rusqlite::OptionalExtension::optional(
                    tx.prepare_cached(
                        "SELECT database_id FROM db_rows WHERE id = ?1 AND deleted_at IS NOT NULL",
                    )?
                    .query_row([&id], |r| r.get(0)),
                )?;
                let Some(db) = db else { continue };
                tx.prepare_cached("UPDATE db_rows SET deleted_at = NULL WHERE id = ?1")?
                    .execute([&id])?;
                by.entry(db).or_default().push(id);
            }
            for d in by.keys() {
                bump(tx, d, false, true)?;
            }
            Ok(by)
        })?;
        let mut out = Vec::new();
        for (db, ids) in by_db {
            self.db_changed(&db);
            out.extend(self.rows_dto(&s, &db, &ids)?);
        }
        Ok(out)
    }

    /// Trashed rows of a database (newest first).
    pub fn db_rows_trash(&self, database_id: &str) -> Result<Vec<RowDto>> {
        let s = self.session()?;
        self.read(|c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT {ROW_COLS} FROM db_rows r WHERE r.database_id = ?1 AND r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC"
            ))?;
            let mut q = st.query([database_id])?;
            let mut out = Vec::new();
            while let Some(r) = q.next()? {
                let (r, _, _) = read_row(&s.codec, r)?;
                out.push(RowDto {
                    id: r.id,
                    rev: r.rev,
                    sort_key: r.sort_key,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                    values: r.payload.values,
                    has_body: r.has_body,
                    icon: r.payload.icon,
                    sample: None,
                });
            }
            Ok(out)
        })
    }

    /// Permanently deletes rows (their bodies and versions go with them; secrets are deleted).
    pub fn db_rows_purge(&self, ids: &[String]) -> Result<()> {
        if ids.len() > MAX_BATCH {
            return Err(StoreError::TooLarge("too many rows"));
        }
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let ids_v = ids.to_vec();
        let touched = self.write(move |tx| {
            let mut touched = HashSet::new();
            for id in ids_v {
                let Some((r, db, _)) = load_row(tx, &sess.codec, &id)? else {
                    continue;
                };
                for sid in r.payload.secrets.values() {
                    tx.prepare_cached("DELETE FROM secrets WHERE id = ?1")?
                        .execute([sid])?;
                }
                tx.prepare_cached("DELETE FROM db_rows WHERE id = ?1")?
                    .execute([&id])?;
                touched.insert(db);
            }
            for d in &touched {
                bump(tx, d, false, true)?;
            }
            Ok(touched)
        })?;
        {
            let mut idx = s.search.write();
            for id in ids {
                idx.remove(id);
            }
        }
        self.notify_dbs(touched);
        Ok(())
    }

    /// `db_rows_move`: manual reorder (keeping the given order) and, for board drags, the group value in the same
    /// transaction.
    pub fn db_rows_move(
        &self,
        ids: &[String],
        before_id: Option<&str>,
        after_id: Option<&str>,
        group_value: Option<GroupValue>,
    ) -> Result<Vec<RowDto>> {
        if ids.is_empty() || ids.len() > MAX_BATCH {
            return Err(StoreError::invalid_field("ids", "invalid number of rows"));
        }
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (ids_v, before, after) = (
            ids.to_vec(),
            before_id.map(str::to_owned),
            after_id.map(str::to_owned),
        );
        let (db, touched) = self.write(move |tx| {
            let codec = &sess.codec;
            let (_, db, _) = load_row(tx, codec, &ids_v[0])?.ok_or(StoreError::NotFound("row"))?;
            let keys: Vec<(String, String)> = row_keys(tx, &db)?
                .into_iter()
                .filter(|(id, _)| !ids_v.contains(id))
                .collect();
            let (lo, hi) = if let Some(a) = &after {
                let i = keys.iter().position(|(id, _)| id == a).ok_or_else(|| {
                    StoreError::invalid_field("afterId", "not a row of this database")
                })?;
                (
                    Some(keys[i].1.clone()),
                    keys.get(i + 1).map(|k| k.1.clone()),
                )
            } else if let Some(b) = &before {
                let i = keys.iter().position(|(id, _)| id == b).ok_or_else(|| {
                    StoreError::invalid_field("beforeId", "not a row of this database")
                })?;
                (
                    i.checked_sub(1).map(|j| keys[j].1.clone()),
                    Some(keys[i].1.clone()),
                )
            } else {
                (keys.last().map(|k| k.1.clone()), None)
            };
            let new_keys =
                n_keys_between(lo.as_deref(), hi.as_deref(), ids_v.len()).or_else(|_| {
                    n_keys_between(keys.last().map(|k| k.1.as_str()), None, ids_v.len())
                })?;
            let props = live_properties(tx, codec, &db)?;
            let mut touched = HashSet::from([db.clone()]);
            let gv = match &group_value {
                Some(g) => {
                    let p = props.iter().find(|p| p.id == g.prop).ok_or_else(|| {
                        StoreError::invalid_field("groupValue", "unknown property")
                    })?;
                    if p.kind.is_read_only() {
                        return Err(StoreError::invalid_field(
                            "groupValue",
                            "read-only property",
                        ));
                    }
                    Some((p.clone(), cells::validate(p, g.value.clone())?))
                }
                None => None,
            };
            for (id, key) in ids_v.iter().zip(new_keys) {
                let (r, rdb, _) = load_row(tx, codec, id)?.ok_or(StoreError::NotFound("row"))?;
                if rdb != db {
                    return Err(StoreError::invalid_field(
                        "ids",
                        "rows of several databases",
                    ));
                }
                tx.prepare_cached("UPDATE db_rows SET sort_key = ?2 WHERE id = ?1")?
                    .execute(params![id, key])?;
                if let Some((p, v)) = &gv {
                    let mut pl = r.payload.clone();
                    let old = cells::ids(pl.values.get(&p.id));
                    match v {
                        Some(v) => pl.values.insert(p.id.clone(), v.clone()),
                        None => pl.values.remove(&p.id),
                    };
                    save_row_payload(tx, codec, id, r.rev, &pl, now)?;
                    if p.kind == PropType::Relation {
                        let new = cells::ids(pl.values.get(&p.id));
                        sync_dual(tx, codec, p, id, &old, &new, now, &mut touched)?;
                    }
                }
            }
            for d in &touched {
                bump(tx, d, false, true)?;
            }
            Ok((db, touched))
        })?;
        self.notify_dbs(touched);
        self.rows_dto(&s, &db, ids)
    }

    /// `db_rows_duplicate`: copies rows (and their bodies) right after each original. Unique ids are re-issued and
    /// secrets are not copied.
    pub fn db_rows_duplicate(&self, ids: &[String]) -> Result<Vec<RowDto>> {
        if ids.len() > MAX_BATCH {
            return Err(StoreError::TooLarge("too many rows"));
        }
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let ids_v = ids.to_vec();
        let (by_db, touched) = self.write(move |tx| {
            let codec = &sess.codec;
            let mut by: BTreeMap<String, Vec<String>> = BTreeMap::new();
            let mut touched = HashSet::new();
            for id in ids_v {
                let Some((r, db, None)) = load_row(tx, codec, &id)? else {
                    continue;
                };
                let props = live_properties(tx, codec, &db)?;
                let keys = row_keys(tx, &db)?;
                let key = crate::repo::databases::key_among(&keys, Some(&id), None, None)?;
                let mut values = r.payload.values.clone();
                values.retain(|k, _| {
                    props.iter().any(|p| {
                        &p.id == k && !matches!(p.kind, PropType::UniqueId | PropType::Secret)
                    })
                });
                let doc = load_doc(tx, codec, &id)?
                    .map(|(mut d, _)| {
                        crate::doc::schema::regenerate_ids(&mut d)?;
                        Ok::<_, StoreError>(d)
                    })
                    .transpose()?;
                let new = create_row_tx(
                    tx,
                    codec,
                    &db,
                    &props,
                    NewRow {
                        values,
                        icon: r.payload.icon.clone(),
                        doc,
                        tags: r.payload.tags.clone(),
                    },
                    &key,
                    now,
                    &mut touched,
                )?;
                by.entry(db).or_default().push(new);
            }
            for d in &touched {
                bump(tx, d, false, true)?;
            }
            Ok((by, touched))
        })?;
        self.notify_dbs(touched);
        let mut out = Vec::new();
        for (db, ids) in by_db {
            out.extend(self.rows_dto(&s, &db, &ids)?);
        }
        Ok(out)
    }

    /// Stores the value of a `secret` cell (write-only; the row keeps `••••` plus the last 4 characters).
    pub fn db_row_secret_set(
        &self,
        row_id: &str,
        property_id: &str,
        value: &SecretString,
    ) -> Result<RowDto> {
        use emp_crypto::ExposeSecret;
        let s = self.session()?;
        let (row, db) = self
            .read(|c| load_row(c, &s.codec, row_id))?
            .map(|(r, db, _)| (r, db))
            .ok_or(StoreError::NotFound("row"))?;
        let props = self.read(|c| live_properties(c, &s.codec, &db))?;
        let p = props
            .iter()
            .find(|p| p.id == property_id && p.kind == PropType::Secret)
            .ok_or_else(|| StoreError::invalid_field("propertyId", "not a secret property"))?;
        let raw = value.expose_secret();
        if raw.is_empty() || raw.len() > 16 * 1024 {
            return Err(StoreError::invalid_field("value", "invalid secret length"));
        }
        let chars: Vec<char> = raw.chars().collect();
        let last4: String = chars[chars.len().saturating_sub(4)..].iter().collect();
        let info = self.secret_put_json(
            row.payload.secrets.get(property_id).map(String::as_str),
            ROW_SECRET_PROVIDER,
            &format!("row:{row_id}:{property_id}"),
            SecretKind::Field,
            Value::String(raw.to_owned()),
            Vec::new(),
            Some(last4.clone()),
        )?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (rid, pid, db2) = (row_id.to_owned(), p.id.clone(), db.clone());
        self.write(move |tx| {
            let codec = &sess.codec;
            let (r, _, _) = load_row(tx, codec, &rid)?.ok_or(StoreError::NotFound("row"))?;
            let mut pl = r.payload.clone();
            pl.secrets.insert(pid.clone(), info.id.clone());
            pl.values.insert(
                pid,
                CellValue::Secret {
                    v: Some(SecretMask {
                        masked: format!("••••{last4}"),
                    }),
                },
            );
            save_row_payload(tx, codec, &rid, r.rev, &pl, now)?;
            bump(tx, &db2, false, true)
        })?;
        self.db_changed_rows(&db, Some(vec![row_id.to_owned()]));
        self.rows_dto(&s, &db, &[row_id.to_owned()])?
            .pop()
            .ok_or(StoreError::NotFound("row"))
    }

    /// `row_secret_reveal` (reauth): the only command that returns a secret value. Logged as `secret_reveal`.
    pub fn row_secret_reveal(&self, row_id: &str, property_id: &str) -> Result<SecretString> {
        self.require_reauth()?;
        let s = self.session()?;
        let (row, _, _) = self
            .read(|c| load_row(c, &s.codec, row_id))?
            .ok_or(StoreError::NotFound("row"))?;
        let sid = row
            .payload
            .secrets
            .get(property_id)
            .ok_or(StoreError::NotFound("secret"))?;
        let v = self.secret_value(sid)?;
        self.log_security_event(SecurityEvent::SecretReveal)?;
        Ok(v)
    }

    fn query_spec(
        &self,
        s: &Arc<Session>,
        req_db: &str,
        view_id: Option<&str>,
        over: Option<&crate::query::model::QueryOverride>,
    ) -> Result<(QuerySpec, Value)> {
        let view = match view_id {
            Some(v) => Some(self.read(|c| load_view(c, &s.codec, req_db, v))?),
            None => None,
        };
        let mut spec = QuerySpec {
            filter: view.as_ref().and_then(|v| v.filter.clone()),
            sorts: view.as_ref().map(|v| v.sorts.clone()).unwrap_or_default(),
            group_by: view.as_ref().and_then(|v| v.group_by.clone()),
            search: None,
            aggs: view
                .as_ref()
                .map(|v| v.footer_aggs.clone())
                .unwrap_or_default(),
        };
        if let Some(o) = over {
            if let Some(f) = &o.filter {
                spec.filter = Some(f.clone());
            }
            if let Some(so) = &o.sorts {
                spec.sorts.clone_from(so);
            }
            if let Some(g) = &o.group_by {
                spec.group_by.clone_from(g);
            }
            if let Some(q) = &o.search {
                if q.chars().count() > 512 {
                    return Err(StoreError::TooLarge("search"));
                }
                spec.search = Some(q.clone()).filter(|q| !q.trim().is_empty());
            }
        }
        Ok((spec, serde_json::to_value(&view)?))
    }

    /// `db_query`.
    pub fn db_query(&self, req: QueryRequest) -> Result<QueryResponse> {
        let started = Instant::now();
        if req.window.limit > MAX_WINDOW {
            return Err(StoreError::invalid_field(
                "window",
                "query windows are limited to 500 rows",
            ));
        }
        let s = self.session()?;
        let ctx = self.date_ctx()?;
        let (spec, view_json) = self.query_spec(
            &s,
            &req.database_id,
            req.view_id.as_deref(),
            req.override_.as_ref(),
        )?;
        let props = self.read(|c| live_properties(c, &s.codec, &req.database_id))?;
        if let Some(f) = &spec.filter {
            filter::validate(f, &props)?;
        }
        // Fingerprint of everything the result depends on.
        let revs = self.read(|c| rev_inputs(c, &s.codec, &req.database_id))?;
        let uses_now = props.iter().any(|p| {
            p.kind == PropType::Formula
                && (p.formula().contains("now(") || p.formula().contains("today("))
        });
        let clock = if uses_now {
            (ctx.now_ms / 60_000).to_string()
        } else {
            ctx.today().to_string()
        };
        let fingerprint = serde_json::to_vec(&serde_json::json!({
            "revs": revs, "view": view_json, "override": req.override_, "window": req.window,
            "group": req.group, "props": req.props, "clock": clock, "tz": ctx.tz.name(), "ws": ctx.week_start,
        }))?;
        let query_rev = format!("{:016x}", fnv64(&[&fingerprint]));
        if req.known_query_rev.as_deref() == Some(query_rev.as_str()) {
            return Ok(QueryResponse::NotModified {
                req_id: req.req_id,
                not_modified: true,
            });
        }
        let world = self.read(|c| load_world(c, &s.codec, &req.database_id))?;
        let ord = world
            .ord(&req.database_id)
            .ok_or(StoreError::NotFound("database"))?;
        let ev = Evaluator::new(&world, ctx);
        let out = engine::run(&ev, ord, &spec);
        let (rows, total) = match (&req.group, &out.groups) {
            (Some(g), Some(groups)) => {
                let rows = groups
                    .iter()
                    .find(|x| &x.key == g)
                    .map(|x| x.rows.clone())
                    .unwrap_or_default();
                let n = rows.len();
                (rows, n)
            }
            _ => {
                let n = out.rows.len();
                (out.rows.clone(), n)
            }
        };
        let window: Vec<RowDto> = rows
            .iter()
            .skip(req.window.offset)
            .take(req.window.limit)
            .filter_map(|&r| ev.row_dto(ord, r, req.props.as_deref()))
            .collect();
        let groups = out
            .groups
            .as_ref()
            .map(|g| engine::group_dtos(&ev, ord, g, &spec.aggs));
        Ok(QueryResponse::Rows(QueryResult {
            req_id: req.req_id,
            query_rev,
            total,
            rows: window,
            groups,
            aggs: out.aggs,
            took_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        }))
    }

    /// `db_query_range`: rows of a view whose `date_prop` overlaps `[from, to]` (calendar months).
    pub fn db_query_range(
        &self,
        database_id: &str,
        view_id: &str,
        date_prop: &str,
        from: &str,
        to: &str,
    ) -> Result<Vec<RowDto>> {
        let s = self.session()?;
        let ctx = self.date_ctx()?;
        let (mut spec, _) = self.query_spec(&s, database_id, Some(view_id), None)?;
        let range = Filter::cond(
            date_prop,
            FilterOp::Between,
            Some(serde_json::json!([from, to])),
        );
        spec.filter = Some(match spec.filter.take() {
            Some(f) => Filter::And {
                and: vec![f, range],
            },
            None => range,
        });
        spec.group_by = None;
        let world = self.read(|c| load_world(c, &s.codec, database_id))?;
        let ord = world
            .ord(database_id)
            .ok_or(StoreError::NotFound("database"))?;
        if world.at(ord).prop(date_prop).is_none() {
            return Err(StoreError::invalid_field("dateProp", "unknown property"));
        }
        let ev = Evaluator::new(&world, ctx);
        let out = engine::run(&ev, ord, &spec);
        Ok(out
            .rows
            .iter()
            .take(MAX_RANGE_ROWS)
            .filter_map(|&r| ev.row_dto(ord, r, None))
            .collect())
    }

    /// `db_chart_data`.
    pub fn db_chart_data(
        &self,
        database_id: &str,
        view_id: Option<&str>,
        filter_: Option<Filter>,
        spec: &ChartSpec,
        max_points: Option<usize>,
    ) -> Result<ChartData> {
        let s = self.session()?;
        let ctx = self.date_ctx()?;
        let over = crate::query::model::QueryOverride {
            filter: filter_,
            ..Default::default()
        };
        let (mut qs, _) = self.query_spec(&s, database_id, view_id, Some(&over))?;
        qs.group_by = None;
        qs.aggs.clear();
        let world = self.read(|c| load_world(c, &s.codec, database_id))?;
        let ord = world
            .ord(database_id)
            .ok_or(StoreError::NotFound("database"))?;
        if let Some(f) = &qs.filter {
            filter::validate(f, &world.at(ord).props)?;
        }
        let ev = Evaluator::new(&world, ctx);
        let out = engine::run(&ev, ord, &qs);
        Ok(chart_data(
            &ev,
            ord,
            &out.rows,
            spec,
            max_points.unwrap_or(DEFAULT_MAX_POINTS),
        ))
    }

    /// Bulk insert used by importers and life apps: rows of already-validated values, appended in order, in one
    /// transaction. Returns the new ids.
    pub fn db_rows_insert_bulk(
        &self,
        database_id: &str,
        rows: Vec<BTreeMap<String, CellValue>>,
        tags: Option<Vec<String>>,
    ) -> Result<Vec<String>> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let db = database_id.to_owned();
        // Imported transactions (not tagged sample data) count as "Add a transaction" for Getting Started.
        let user_rows = tags.is_none() && !rows.is_empty();
        let (ids, touched, is_txn) = self.write(move |tx| {
            let codec = &sess.codec;
            let is_txn = load_db(tx, codec, &db)?
                .payload
                .roles
                .contains_key("txn.amount");
            let props = live_properties(tx, codec, &db)?;
            if count_rows(tx, &db)? + rows.len() > MAX_ROWS {
                return Err(StoreError::TooLarge("rows"));
            }
            let last = row_keys(tx, &db)?.pop().map(|k| k.1);
            let keys = n_keys_between(last.as_deref(), None, rows.len())?;
            let mut touched = HashSet::new();
            let mut ids = Vec::with_capacity(rows.len());
            for (values, key) in rows.into_iter().zip(keys) {
                let values = checked_values(&props, values)?;
                ids.push(create_row_tx(
                    tx,
                    codec,
                    &db,
                    &props,
                    NewRow {
                        values,
                        icon: None,
                        doc: None,
                        tags: tags.clone(),
                    },
                    &key,
                    now,
                    &mut touched,
                )?);
            }
            for d in &touched {
                bump(tx, d, false, true)?;
            }
            Ok((ids, touched, is_txn))
        })?;
        self.notify_dbs(touched);
        if is_txn && user_rows {
            self.tour_tick_quiet("add_transaction");
        }
        Ok(ids)
    }

    /// Writes a life-app `computed` cell (Rust jobs only; the IPC layer never exposes this).
    pub fn db_row_set_computed(
        &self,
        row_id: &str,
        property_id: &str,
        value: CellValue,
    ) -> Result<()> {
        if !matches!(value, CellValue::Computed { .. }) {
            return Err(StoreError::invalid_field("value", "computed cells only"));
        }
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (rid, pid) = (row_id.to_owned(), property_id.to_owned());
        let db = self.write(move |tx| {
            let codec = &sess.codec;
            let (r, db, _) = load_row(tx, codec, &rid)?.ok_or(StoreError::NotFound("row"))?;
            let props = live_properties(tx, codec, &db)?;
            if !props
                .iter()
                .any(|p| p.id == pid && p.kind == PropType::Computed)
            {
                return Err(StoreError::invalid_field(
                    "propertyId",
                    "not a computed property",
                ));
            }
            let mut pl = r.payload.clone();
            pl.values.insert(pid, value);
            save_row_payload(tx, codec, &rid, r.rev, &pl, now)?;
            bump(tx, &db, false, true)?;
            Ok(db)
        })?;
        self.db_changed_rows(&db, Some(vec![row_id.to_owned()]));
        Ok(())
    }

    /// Title of the database page and every live row title (pickers, exports).
    pub fn db_row_titles(&self, database_id: &str) -> Result<Vec<(String, String)>> {
        let s = self.session()?;
        let world = self.read(|c| load_world(c, &s.codec, database_id))?;
        let d = world
            .db(database_id)
            .ok_or(StoreError::NotFound("database"))?;
        let _ = self.read(|c| page_info(c, &s.codec, database_id))?;
        Ok((0..d.rows.len())
            .map(|i| (d.rows[i].id.clone(), d.row_title(i)))
            .collect())
    }
}
