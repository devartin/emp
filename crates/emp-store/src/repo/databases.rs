//! Database schemas (SPEC §8.1–§8.2, §10.2 `databases` / `db_properties`, §11.3 Databases): create, schema reads,
//! property CRUD with every v1 type, two-way relations (both sides written in one transaction), select options,
//! type conversions (a `pre_bulk` schema version first, then every row converted in one transaction), formula
//! checks and relation pickers.
//!
//! A database is a `pages` row of kind `database` plus a `databases` row with the same id. `schema_rev` counts
//! property and view changes, `data_rev` counts row changes; both feed the query rev of `db_query`. Formula
//! expressions are stored with property ids (`prop("#<id>")`) and presented with current names.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::codec::{Codec, RecordLoc};
use crate::model::sort_key::key_between;
use crate::model::{
    BlockColor, PageKind, PageMeta, PagePayload, VersionReason, VersionTargetKind, ids::new_id,
    validate_title,
};
use crate::query::cells::{self, from_text};
use crate::query::compute::{DbData, Evaluator, MAX_WORLD_DBS, World, relation_targets};
use crate::query::config::{self, DualRef, HasConfig, RelationConfig, SelectConfig};
use crate::query::dates::DateCtx;
use crate::query::model::{
    CellValue, DatabasePayload, DbCreate, DbCreated, DbInfo, DbPatch, DbSchema, FormulaCheck,
    FormulaError, Layout, PropType, Property, PropertyPatch, PropertyPayload, RelationOption,
    SelectOption, SelectOptionInput, StatusGroup, ViewPayload, rich_plain,
};
use crate::query::sort::fold;
use crate::repo::pages::{decode_page, insert_page, load_page, position_key};
use crate::repo::rows::{load_rows, save_row_payload};
use crate::repo::views::{insert_view, load_views};
use crate::vault::{Session, StoreEvent};
use crate::{Progress, Result, Store, StoreError};

/// Maximum properties per database.
pub const MAX_PROPERTIES: usize = 500;
/// Maximum options per select property.
pub const MAX_OPTIONS: usize = 1_000;
/// Options created by a text → select conversion (SPEC §8.2).
pub const CONVERT_MAX_OPTIONS: usize = 200;

/// Palette used for new options, in order (SPEC §17.4 "assigned colours from the palette in order").
pub const OPTION_PALETTE: [BlockColor; 9] = [
    BlockColor::Gray,
    BlockColor::Brown,
    BlockColor::Orange,
    BlockColor::Yellow,
    BlockColor::Green,
    BlockColor::Blue,
    BlockColor::Purple,
    BlockColor::Pink,
    BlockColor::Red,
];

// ───────────────────────────────────────────────────────────────────────────── row access helpers

/// A raw `databases` row.
#[derive(Debug, Clone)]
pub(crate) struct DbRow {
    pub id: String,
    pub schema_rev: i64,
    pub data_rev: i64,
    pub rev: i64,
    pub payload: DatabasePayload,
}

fn rev_u(rev: i64) -> u64 {
    u64::try_from(rev).unwrap_or(0)
}

pub(crate) fn db_loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::Databases, id, rev_u(rev))
}

pub(crate) fn prop_loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::DbProperties, id, rev_u(rev))
}

/// Loads a database row (`NOT_FOUND` if missing).
pub(crate) fn load_db(conn: &Connection, codec: &Codec, id: &str) -> Result<DbRow> {
    let raw: Option<(i64, i64, i64, i64, Vec<u8>)> = conn
        .prepare_cached(
            "SELECT schema_rev, data_rev, rev, enc, payload FROM databases WHERE id = ?1",
        )?
        .query_row([id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .optional()?;
    let (schema_rev, data_rev, rev, enc, payload) = raw.ok_or(StoreError::NotFound("database"))?;
    Ok(DbRow {
        id: id.to_owned(),
        schema_rev,
        data_rev,
        rev,
        payload: codec.decode(&db_loc(id, rev), enc, &payload)?,
    })
}

/// Rewrites a database payload with `rev + 1`.
pub(crate) fn save_db(tx: &Connection, codec: &Codec, row: &DbRow, p: &DatabasePayload) -> Result<()> {
    let rev = row.rev + 1;
    let e = codec.encode(&db_loc(&row.id, rev), p)?;
    tx.prepare_cached("UPDATE databases SET rev = ?2, enc = ?3, payload = ?4 WHERE id = ?1")?
        .execute(params![row.id, rev, e.enc, e.payload])?;
    Ok(())
}

/// Bumps `schema_rev` and/or `data_rev`.
pub(crate) fn bump(tx: &Connection, db_id: &str, schema: bool, data: bool) -> Result<()> {
    tx.prepare_cached(
        "UPDATE databases SET schema_rev = schema_rev + ?2, data_rev = data_rev + ?3 WHERE id = ?1",
    )?
    .execute(params![db_id, i64::from(schema), i64::from(data)])?;
    Ok(())
}

/// A raw property row.
#[derive(Debug, Clone)]
pub(crate) struct PropRow {
    pub id: String,
    pub database_id: String,
    pub sort_key: String,
    pub deleted_at: Option<i64>,
    pub rev: i64,
    pub payload: PropertyPayload,
}

impl PropRow {
    pub(crate) fn to_property(&self) -> Property {
        Property {
            id: self.id.clone(),
            name: self.payload.name.clone(),
            kind: self.payload.kind,
            config: self.payload.config.clone(),
            role: self.payload.role.clone(),
            hidden: self.payload.hidden,
            sort_key: self.sort_key.clone(),
            description: self.payload.description.clone(),
        }
    }
}

const PROP_COLS: &str = "id, database_id, sort_key, deleted_at, rev, enc, payload";

fn prop_row(codec: &Codec, r: &rusqlite::Row<'_>) -> Result<PropRow> {
    let id: String = r.get(0)?;
    let rev: i64 = r.get(4)?;
    let enc: i64 = r.get(5)?;
    let payload: Vec<u8> = r.get(6)?;
    Ok(PropRow {
        payload: codec.decode(&prop_loc(&id, rev), enc, &payload)?,
        id,
        database_id: r.get(1)?,
        sort_key: r.get(2)?,
        deleted_at: r.get(3)?,
        rev,
    })
}

pub(crate) fn load_prop(conn: &Connection, codec: &Codec, id: &str) -> Result<Option<PropRow>> {
    let mut st = conn.prepare_cached(&format!("SELECT {PROP_COLS} FROM db_properties WHERE id = ?1"))?;
    let mut rows = st.query([id])?;
    match rows.next()? {
        Some(r) => Ok(Some(prop_row(codec, r)?)),
        None => Ok(None),
    }
}

/// Properties of a database in column order (live only unless `deleted`).
pub(crate) fn load_props(conn: &Connection, codec: &Codec, db_id: &str, deleted: bool) -> Result<Vec<PropRow>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {PROP_COLS} FROM db_properties WHERE database_id = ?1 ORDER BY sort_key, id"
    ))?;
    let mut rows = st.query([db_id])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let p = prop_row(codec, r)?;
        if deleted || p.deleted_at.is_none() {
            out.push(p);
        }
    }
    Ok(out)
}

/// Live properties as DTOs (storage-form formulas).
pub(crate) fn live_properties(conn: &Connection, codec: &Codec, db_id: &str) -> Result<Vec<Property>> {
    Ok(load_props(conn, codec, db_id, false)?
        .iter()
        .map(PropRow::to_property)
        .collect())
}

pub(crate) fn insert_prop(
    tx: &Connection,
    codec: &Codec,
    db_id: &str,
    id: &str,
    sort_key: &str,
    p: &PropertyPayload,
) -> Result<()> {
    let e = codec.encode(&prop_loc(id, 1), p)?;
    tx.prepare_cached(
        "INSERT INTO db_properties (id, database_id, sort_key, deleted_at, rev, enc, payload) VALUES (?1, ?2, ?3, NULL, 1, ?4, ?5)",
    )?
    .execute(params![id, db_id, sort_key, e.enc, e.payload])?;
    Ok(())
}

pub(crate) fn save_prop(tx: &Connection, codec: &Codec, row: &PropRow, p: &PropertyPayload) -> Result<()> {
    let rev = row.rev + 1;
    let e = codec.encode(&prop_loc(&row.id, rev), p)?;
    tx.prepare_cached("UPDATE db_properties SET rev = ?2, enc = ?3, payload = ?4 WHERE id = ?1")?
        .execute(params![row.id, rev, e.enc, e.payload])?;
    Ok(())
}

/// A sort key placing an item after `after` / before `before` (or at the end) among `sibs` (ordered).
pub(crate) fn key_among(
    sibs: &[(String, String)],
    after: Option<&str>,
    before: Option<&str>,
    exclude: Option<&str>,
) -> Result<String> {
    let sibs: Vec<&(String, String)> = sibs.iter().filter(|(id, _)| Some(id.as_str()) != exclude).collect();
    let (lo, hi) = if let Some(a) = after {
        let i = sibs
            .iter()
            .position(|(id, _)| id == a)
            .ok_or_else(|| StoreError::invalid_field("afterId", "not a sibling"))?;
        (Some(sibs[i].1.clone()), sibs.get(i + 1).map(|s| s.1.clone()))
    } else if let Some(b) = before {
        let i = sibs
            .iter()
            .position(|(id, _)| id == b)
            .ok_or_else(|| StoreError::invalid_field("beforeId", "not a sibling"))?;
        (i.checked_sub(1).map(|j| sibs[j].1.clone()), Some(sibs[i].1.clone()))
    } else {
        (sibs.last().map(|s| s.1.clone()), None)
    };
    match key_between(lo.as_deref(), hi.as_deref()) {
        Ok(k) => Ok(k),
        Err(_) => key_between(sibs.last().map(|s| s.1.as_str()), None),
    }
}

/// Page title / icon / app instance of a database page.
pub(crate) fn page_info(conn: &Connection, codec: &Codec, id: &str) -> Result<(PagePayload, String)> {
    let row = load_page(conn, id)?.ok_or(StoreError::NotFound("database"))?;
    if row.kind != PageKind::Database.as_str() {
        return Err(StoreError::invalid("the page is not a database"));
    }
    Ok((decode_page(codec, &row)?, row.workspace_id.clone()))
}

/// Formula expressions → display form (current names).
pub(crate) fn present(props: Vec<Property>) -> Vec<Property> {
    let names: BTreeMap<String, String> = props.iter().map(|p| (p.id.clone(), p.name.clone())).collect();
    props
        .into_iter()
        .map(|mut p| {
            if p.kind == PropType::Formula {
                let e = p.formula();
                if let Ok(d) = emp_sheets::dialect::row::to_display(&e, &|id| names.get(id).cloned()) {
                    p.config.insert("expression".into(), json!(d));
                }
            }
            p
        })
        .collect()
}

/// Formula expression → storage form (`prop("#id")`).
pub(crate) fn to_storage(expr: &str, props: &[Property]) -> Result<String> {
    if expr.trim().is_empty() {
        return Ok(String::new());
    }
    if expr.chars().count() > 8_192 {
        return Err(StoreError::TooLarge("formula"));
    }
    emp_sheets::dialect::row::to_storage(expr, &|name| {
        props
            .iter()
            .find(|p| p.name == name)
            .or_else(|| props.iter().find(|p| p.name.eq_ignore_ascii_case(name)))
            .map(|p| p.id.clone())
    })
    .map_err(|e| StoreError::invalid_field("expression", e.message))
}

/// The full schema (formulas in display form).
pub(crate) fn load_schema(conn: &Connection, codec: &Codec, db_id: &str) -> Result<DbSchema> {
    let (page, _) = page_info(conn, codec, db_id)?;
    let db = load_db(conn, codec, db_id)?;
    let props = present(live_properties(conn, codec, db_id)?);
    let views = load_views(conn, codec, db_id)?;
    Ok(DbSchema {
        database: DbInfo {
            id: db_id.to_owned(),
            title: page.title,
            icon: page.icon,
            description: db.payload.description.clone(),
            primary_prop_id: db.payload.primary_prop_id.clone(),
            schema_rev: db.schema_rev,
            data_rev: db.data_rev,
            templates: db.payload.templates.clone(),
            default_template_id: db.payload.default_template_id.clone(),
            hide_empty_props: db.payload.hide_empty_props,
            roles: db.payload.roles.clone(),
            app_instance_id: page.app_instance_id,
        },
        properties: props,
        views,
    })
}

/// One database with its live rows.
pub(crate) fn load_db_data(conn: &Connection, codec: &Codec, db_id: &str) -> Result<DbData> {
    let db = load_db(conn, codec, db_id)?;
    let (page, _) = page_info(conn, codec, db_id)?;
    let props = live_properties(conn, codec, db_id)?;
    let rows = load_rows(conn, codec, db_id)?;
    Ok(DbData::new(
        db_id.to_owned(),
        page.title,
        db.payload,
        props,
        rows,
        db.data_rev,
        db.schema_rev,
    ))
}

/// The database and every database reachable through relations (breadth-first, at most 16).
pub(crate) fn load_world(conn: &Connection, codec: &Codec, db_id: &str) -> Result<World> {
    let mut dbs = vec![load_db_data(conn, codec, db_id)?];
    let mut seen: HashSet<String> = HashSet::from([db_id.to_owned()]);
    let mut queue: VecDeque<String> = relation_targets(&dbs[0].props).into();
    while let Some(t) = queue.pop_front() {
        if dbs.len() >= MAX_WORLD_DBS || !seen.insert(t.clone()) {
            continue;
        }
        match load_db_data(conn, codec, &t) {
            Ok(d) => {
                queue.extend(relation_targets(&d.props));
                dbs.push(d);
            }
            Err(StoreError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(World::new(dbs))
}

fn unique_name(existing: &[String], wanted: &str) -> String {
    let base = if wanted.trim().is_empty() { "Property" } else { wanted.trim() };
    let taken = |n: &str| existing.iter().any(|e| e.eq_ignore_ascii_case(n));
    if !taken(base) {
        return base.to_owned();
    }
    (2..)
        .map(|i| format!("{base} {i}"))
        .find(|n| !taken(n))
        .unwrap_or_else(|| base.to_owned())
}

fn default_status_options() -> Result<Vec<SelectOption>> {
    Ok(vec![
        SelectOption {
            id: new_id(),
            name: "Not started".into(),
            color: BlockColor::Gray,
            group: Some(StatusGroup::Todo),
        },
        SelectOption {
            id: new_id(),
            name: "In progress".into(),
            color: BlockColor::Blue,
            group: Some(StatusGroup::InProgress),
        },
        SelectOption {
            id: new_id(),
            name: "Done".into(),
            color: BlockColor::Green,
            group: Some(StatusGroup::Complete),
        },
    ])
}

/// Normalises select options: ids assigned, names bounded, duplicates removed.
fn normalize_options(config: &mut Map<String, Value>, status: bool) -> Result<()> {
    let raw = config.get("options").cloned().unwrap_or(Value::Array(Vec::new()));
    let Value::Array(items) = raw else {
        return Err(StoreError::invalid_field("config", "options must be a list"));
    };
    if items.len() > MAX_OPTIONS {
        return Err(StoreError::TooLarge("options"));
    }
    let mut out: Vec<SelectOption> = Vec::new();
    for (i, it) in items.into_iter().enumerate() {
        let name = it.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
        if name.is_empty() || out.iter().any(|o| o.name.eq_ignore_ascii_case(&name)) {
            continue;
        }
        validate_title(&name)?;
        let color = it
            .get("color")
            .cloned()
            .and_then(|c| serde_json::from_value(c).ok())
            .unwrap_or(OPTION_PALETTE[i % OPTION_PALETTE.len()]);
        let group = it
            .get("group")
            .cloned()
            .and_then(|g| serde_json::from_value(g).ok())
            .or(status.then_some(StatusGroup::Todo));
        let id = it
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| crate::model::ids::is_record_id(s))
            .map_or_else(new_id, str::to_owned);
        out.push(SelectOption { id, name, color, group });
    }
    if status && out.is_empty() {
        out = default_status_options()?;
    }
    config::set(config, "options", &out);
    Ok(())
}

// ───────────────────────────────────────────────────────────────────────────── property creation

/// Everything needed to create one property inside a transaction.
struct NewProp<'a> {
    db_id: &'a str,
    db_title: &'a str,
    name: &'a str,
    kind: PropType,
    config: Map<String, Value>,
    after_id: Option<&'a str>,
    now: i64,
}

/// Creates a property (and the dual of a two-way relation). Returns the created properties, this one first.
fn create_prop_tx(tx: &Connection, codec: &Codec, np: NewProp<'_>) -> Result<Vec<Property>> {
    validate_title(np.name)?;
    let existing = load_props(tx, codec, np.db_id, false)?;
    if existing.len() >= MAX_PROPERTIES {
        return Err(StoreError::TooLarge("properties"));
    }
    if np.kind == PropType::Title && existing.iter().any(|p| p.payload.kind == PropType::Title) {
        return Err(StoreError::invalid_field("type", "a database has exactly one title property"));
    }
    let names: Vec<String> = existing.iter().map(|p| p.payload.name.clone()).collect();
    let name = unique_name(&names, np.name);
    let sibs: Vec<(String, String)> = existing.iter().map(|p| (p.id.clone(), p.sort_key.clone())).collect();
    let sort_key = key_among(&sibs, np.after_id, None, None)?;
    let id = new_id();
    let mut config = np.config;
    let mut created_dual: Option<Property> = None;
    let mut db_row = load_db(tx, codec, np.db_id)?;
    let mut db_dirty = false;
    match np.kind {
        PropType::Select | PropType::MultiSelect => normalize_options(&mut config, false)?,
        PropType::Status => normalize_options(&mut config, true)?,
        PropType::Relation => {
            let mut rc: RelationConfig = config::read(&config);
            if rc.target_database_id.is_empty() {
                return Err(StoreError::invalid_field("config", "relations need targetDatabaseId"));
            }
            if rc.target_database_id != np.db_id {
                load_db(tx, codec, &rc.target_database_id)?;
            }
            let wants_dual = config.contains_key("dual") && !config["dual"].is_null()
                || config.get("twoWay").and_then(Value::as_bool) == Some(true);
            config.remove("twoWay");
            config.remove("dualName");
            if wants_dual {
                let target = rc.target_database_id.clone();
                let dual_id = new_id();
                let tprops = if target == np.db_id {
                    existing.clone()
                } else {
                    load_props(tx, codec, &target, false)?
                };
                let tnames: Vec<String> = tprops
                    .iter()
                    .map(|p| p.payload.name.clone())
                    .chain((target == np.db_id).then(|| name.clone()))
                    .collect();
                let dual_name = unique_name(&tnames, rc.dual_name.as_deref().unwrap_or(np.db_title));
                let tsibs: Vec<(String, String)> =
                    tprops.iter().map(|p| (p.id.clone(), p.sort_key.clone())).collect();
                let mut tkey = key_among(&tsibs, None, None, None)?;
                if target == np.db_id {
                    tkey = key_between(Some(&sort_key), None)?;
                }
                let dual_cfg = RelationConfig {
                    target_database_id: np.db_id.to_owned(),
                    dual: Some(DualRef { property_id: Some(id.clone()) }),
                    limit: Some("many".into()),
                    dual_name: None,
                };
                let payload = PropertyPayload {
                    v: 1,
                    name: dual_name,
                    kind: PropType::Relation,
                    config: serde_json::to_value(&dual_cfg)?
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    role: None,
                    hidden: false,
                    description: None,
                };
                insert_prop(tx, codec, &target, &dual_id, &tkey, &payload)?;
                bump(tx, &target, true, false)?;
                rc.dual = Some(DualRef { property_id: Some(dual_id.clone()) });
                created_dual = Some(Property {
                    id: dual_id,
                    name: payload.name,
                    kind: PropType::Relation,
                    config: payload.config,
                    role: None,
                    hidden: false,
                    sort_key: tkey,
                    description: None,
                });
            } else {
                rc.dual = None;
            }
            rc.dual_name = None;
            for (k, v) in serde_json::to_value(&rc)?.as_object().cloned().unwrap_or_default() {
                config.insert(k, v);
            }
        }
        PropType::Rollup => {
            let rel_id = config.get("relationPropId").and_then(Value::as_str).unwrap_or_default();
            if !rel_id.is_empty()
                && !existing
                    .iter()
                    .any(|p| p.id == rel_id && p.payload.kind == PropType::Relation)
            {
                return Err(StoreError::invalid_field("config", "relationPropId is not a relation of this database"));
            }
            if config.get("fn").is_some()
                && serde_json::from_value::<crate::query::model::RollupFn>(config["fn"].clone()).is_err()
            {
                return Err(StoreError::invalid_field("config", "unknown rollup function"));
            }
        }
        PropType::Formula => {
            let all: Vec<Property> = existing.iter().map(PropRow::to_property).collect();
            let expr = config.get("expression").and_then(Value::as_str).unwrap_or_default().to_owned();
            config.insert("expression".into(), json!(to_storage(&expr, &all)?));
        }
        PropType::UniqueId => {
            if let Some(prefix) = config.get("prefix").and_then(Value::as_str) {
                let prefix = prefix.trim().to_owned();
                if prefix.len() > 16 || !prefix.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return Err(StoreError::invalid_field("config", "prefixes are up to 16 letters and digits"));
                }
                db_row.payload.uid_prefix = (!prefix.is_empty()).then_some(prefix);
                db_dirty = true;
            }
        }
        _ => {}
    }
    let payload = PropertyPayload {
        v: 1,
        name,
        kind: np.kind,
        config,
        role: None,
        hidden: false,
        description: None,
    };
    insert_prop(tx, codec, np.db_id, &id, &sort_key, &payload)?;
    if np.kind == PropType::UniqueId {
        // Existing rows get ids in manual order.
        let rows = load_rows(tx, codec, np.db_id)?;
        let prefix = db_row.payload.uid_prefix.clone();
        for r in rows {
            db_row.payload.uid_seq += 1;
            let mut p = r.payload.clone();
            p.values.insert(id.clone(), uid_value(prefix.as_deref(), db_row.payload.uid_seq));
            save_row_payload(tx, codec, &r.id, r.rev, &p, r.updated_at)?;
        }
        db_dirty = true;
        bump(tx, np.db_id, false, true)?;
    }
    if db_dirty {
        save_db(tx, codec, &db_row, &db_row.payload)?;
    }
    bump(tx, np.db_id, true, false)?;
    let mut out = vec![Property {
        id,
        name: payload.name,
        kind: payload.kind,
        config: payload.config,
        role: None,
        hidden: false,
        sort_key,
        description: None,
    }];
    out.extend(created_dual);
    let _ = np.now;
    Ok(out)
}

/// A `unique_id` value.
pub(crate) fn uid_value(prefix: Option<&str>, seq: i64) -> CellValue {
    CellValue::Uid {
        v: match prefix {
            Some(p) => format!("{p}-{seq}"),
            None => seq.to_string(),
        },
    }
}

// ───────────────────────────────────────────────────────────────────────────── conversions

/// Whether a conversion is supported (SPEC §8.2), plus identical-shape renames among text-like types.
#[must_use]
pub fn conversion_supported(from: PropType, to: PropType) -> bool {
    use PropType as T;
    matches!(
        (from, to),
        (T::Text, T::Select)
            | (T::Select, T::Text)
            | (T::Number, T::Text)
            | (T::Text, T::Number)
            | (T::Date, T::Text)
            | (T::Checkbox, T::Text)
            | (T::MultiSelect, T::Text)
            | (T::Number, T::Money)
            | (T::Money, T::Number)
            | (T::Select, T::MultiSelect)
            | (T::Text, T::Url | T::Email | T::Phone)
            | (T::Url | T::Email | T::Phone, T::Text)
    )
}

fn convert_value(from: &Property, to: &Property, v: &CellValue) -> Option<CellValue> {
    use PropType as T;
    let text = cells::display(v, from);
    match (from.kind, to.kind) {
        (T::Checkbox, T::Text) => Some(CellValue::text(if cells::boolean(Some(v)) { "Yes" } else { "No" })),
        (T::Number, T::Money) => cells::number(Some(v)).and_then(|n| {
            let s = cells::fmt_num(n);
            cells::check_money(&s).ok().map(|m| CellValue::Money {
                v: Some(m),
                cur: to.money().currency.unwrap_or_else(|| "USD".into()),
            })
        }),
        (T::Money, T::Number) => cells::number(Some(v)).map(CellValue::number),
        (T::Select, T::MultiSelect) => match v {
            CellValue::Select { v: Some(id) } => Some(CellValue::Multi { v: vec![id.clone()] }),
            _ => None,
        },
        _ => from_text(to, &text),
    }
}

// ───────────────────────────────────────────────────────────────────────────── Store API

impl Store {
    pub(crate) fn db_changed(&self, database_id: &str) {
        // `db:changed` is forwarded by the app through `PageChanged` until a dedicated event exists.
        self.emit(StoreEvent::PageChanged {
            id: database_id.to_owned(),
            meta_rev: None,
            doc_rev: None,
        });
    }

    fn with_session<R>(&self, f: impl FnOnce(&Arc<Session>) -> Result<R>) -> Result<R> {
        let s = self.session()?;
        f(&s)
    }

    /// `db_create`: a database page with a title property, the requested properties and a default table view.
    pub fn db_create(&self, req: DbCreate) -> Result<DbCreated> {
        validate_title(&req.title)?;
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (meta, schema) = self.write(move |tx| {
            let codec = &sess.codec;
            if let Some(p) = &req.parent_id {
                let row = load_page(tx, p)?.ok_or(StoreError::NotFound("parent page"))?;
                if row.workspace_id != req.workspace_id || row.deleted_at.is_some() {
                    return Err(StoreError::invalid_field("parentId", "invalid parent"));
                }
            } else {
                let ok: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
                    [&req.workspace_id],
                    |r| r.get(0),
                )?;
                if !ok {
                    return Err(StoreError::NotFound("workspace"));
                }
            }
            let key = position_key(tx, &req.workspace_id, req.parent_id.as_deref(), req.after_id.as_deref(), None, None)?;
            let id = new_id();
            let mut page = PagePayload::new(&req.title);
            if req.inline {
                page.flags.inline = Some(true);
            }
            insert_page(tx, codec, &id, &req.workspace_id, req.parent_id.as_deref(), PageKind::Database, &key, &page, now)?;
            let specs = req.properties.clone().unwrap_or_default();
            let title_name = specs
                .iter()
                .find(|p| p.kind == PropType::Title)
                .map_or_else(|| "Name".to_owned(), |p| p.name.clone());
            let title_id = new_id();
            let payload = DatabasePayload {
                v: 1,
                description: None,
                primary_prop_id: title_id.clone(),
                uid_prefix: None,
                uid_seq: 0,
                inline: req.inline,
                templates: Vec::new(),
                default_template_id: None,
                hide_empty_props: false,
                roles: BTreeMap::new(),
            };
            let e = codec.encode(&db_loc(&id, 1), &payload)?;
            tx.prepare_cached(
                "INSERT INTO databases (id, schema_rev, data_rev, rev, enc, payload) VALUES (?1, 1, 0, 1, ?2, ?3)",
            )?
            .execute(params![id, e.enc, e.payload])?;
            validate_title(&title_name)?;
            insert_prop(
                tx,
                codec,
                &id,
                &title_id,
                &key_between(None, None)?,
                &PropertyPayload {
                    v: 1,
                    name: title_name,
                    kind: PropType::Title,
                    config: Map::new(),
                    role: None,
                    hidden: false,
                    description: None,
                },
            )?;
            for spec in specs.iter().filter(|p| p.kind != PropType::Title) {
                create_prop_tx(
                    tx,
                    codec,
                    NewProp {
                        db_id: &id,
                        db_title: &req.title,
                        name: &spec.name,
                        kind: spec.kind,
                        config: spec.config.clone().unwrap_or_default(),
                        after_id: None,
                        now,
                    },
                )?;
            }
            let props = live_properties(tx, codec, &id)?;
            let view = ViewPayload::new("Table", Layout::Table, props.iter().map(|p| p.id.clone()).collect());
            insert_view(tx, codec, &id, &new_id(), &key_between(None, None)?, &view)?;
            let meta = crate::repo::pages::load_meta(tx, codec, &id)?.ok_or(StoreError::NotFound("page"))?;
            let schema = load_schema(tx, codec, &id)?;
            Ok((meta, schema))
        })?;
        self.index_page(&s, &meta, None);
        self.emit(StoreEvent::TreeChanged {
            workspace_id: meta.workspace_id.clone(),
            upserted: vec![meta.clone()],
            removed: Vec::new(),
        });
        Ok(DbCreated { page: meta, schema })
    }

    /// `db_get_schema`.
    pub fn db_get_schema(&self, id: &str) -> Result<DbSchema> {
        self.with_session(|s| self.read(|c| load_schema(c, &s.codec, id)))
    }

    /// `db_update`.
    pub fn db_update(&self, id: &str, patch: DbPatch) -> Result<DbSchema> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        let schema = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_db(tx, codec, &id_owned)?;
            let mut p = row.payload.clone();
            if let Some(d) = patch.description {
                if rich_plain(&d).chars().count() > 10_000 {
                    return Err(StoreError::TooLarge("description"));
                }
                p.description = (!d.is_empty()).then_some(d);
            }
            if let Some(t) = patch.templates {
                if t.len() > 100 {
                    return Err(StoreError::TooLarge("templates"));
                }
                for tpl in &t {
                    validate_title(&tpl.name)?;
                }
                p.templates = t;
            }
            if let Some(d) = patch.default_template_id {
                if let Some(d) = &d
                    && !p.templates.iter().any(|t| &t.id == d)
                {
                    return Err(StoreError::invalid_field("defaultTemplateId", "unknown template"));
                }
                p.default_template_id = d;
            }
            if let Some(h) = patch.hide_empty_props {
                p.hide_empty_props = h;
            }
            if let Some(i) = patch.inline {
                p.inline = i;
            }
            if p.default_template_id.as_ref().is_some_and(|d| !p.templates.iter().any(|t| &t.id == d)) {
                p.default_template_id = None;
            }
            save_db(tx, codec, &row, &p)?;
            bump(tx, &id_owned, true, false)?;
            load_schema(tx, codec, &id_owned)
        })?;
        self.db_changed(id);
        Ok(schema)
    }

    /// Sets semantic roles (life apps): `role → propertyId` (unknown properties are rejected).
    pub fn db_set_roles(&self, id: &str, roles: BTreeMap<String, String>) -> Result<DbSchema> {
        let s = self.session()?;
        let id_owned = id.to_owned();
        let sess = Arc::clone(&s);
        self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_db(tx, codec, &id_owned)?;
            let props = live_properties(tx, codec, &id_owned)?;
            for pid in roles.values() {
                if !props.iter().any(|p| &p.id == pid) {
                    return Err(StoreError::invalid_field("roles", "unknown property"));
                }
            }
            let mut p = row.payload.clone();
            p.roles = roles;
            save_db(tx, codec, &row, &p)?;
            bump(tx, &id_owned, true, false)?;
            load_schema(tx, codec, &id_owned)
        })
    }

    /// `db_property_create` (a two-way relation creates its dual atomically: pass `config.dual: {}` or
    /// `config.twoWay: true`, optionally `config.dualName`).
    pub fn db_property_create(
        &self,
        database_id: &str,
        name: &str,
        kind: PropType,
        config: Option<Map<String, Value>>,
        after_id: Option<&str>,
    ) -> Result<Property> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (db, name, after) = (database_id.to_owned(), name.to_owned(), after_id.map(str::to_owned));
        let created = self.write(move |tx| {
            let codec = &sess.codec;
            let (page, _) = page_info(tx, codec, &db)?;
            let out = create_prop_tx(
                tx,
                codec,
                NewProp {
                    db_id: &db,
                    db_title: &page.title,
                    name: &name,
                    kind,
                    config: config.unwrap_or_default(),
                    after_id: after.as_deref(),
                    now,
                },
            )?;
            let all = live_properties(tx, codec, &db)?;
            let dual_db = out.get(1).map(|_| {
                RelationConfig::clone(&out[0].relation()).target_database_id
            });
            Ok((present(all).into_iter().find(|p| p.id == out[0].id), dual_db))
        })?;
        self.db_changed(database_id);
        if let Some(d) = created.1 {
            self.db_changed(&d);
        }
        created.0.ok_or(StoreError::Internal("created property vanished".into()))
    }

    /// `db_property_update` (configuration keys are merged; select options are re-normalised; formula expressions
    /// are converted to storage form).
    pub fn db_property_update(&self, id: &str, patch: PropertyPatch) -> Result<Property> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        let (prop, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &id_owned)?.ok_or(StoreError::NotFound("property"))?;
            let mut p = row.payload.clone();
            let others = load_props(tx, codec, &row.database_id, false)?;
            if let Some(n) = patch.name {
                validate_title(&n)?;
                let n = n.trim().to_owned();
                if n.is_empty() {
                    return Err(StoreError::invalid_field("name", "names cannot be empty"));
                }
                if others.iter().any(|o| o.id != row.id && o.payload.name.eq_ignore_ascii_case(&n)) {
                    return Err(StoreError::invalid_field("name", "another property has this name"));
                }
                p.name = n;
            }
            if let Some(cfg) = patch.config {
                for (k, v) in cfg {
                    if p.kind == PropType::Relation && matches!(k.as_str(), "targetDatabaseId" | "dual") {
                        // Retargeting and pairing are structural; they go through convert / delete.
                        continue;
                    }
                    p.config.insert(k, v);
                }
                match p.kind {
                    PropType::Select | PropType::MultiSelect => normalize_options(&mut p.config, false)?,
                    PropType::Status => normalize_options(&mut p.config, true)?,
                    PropType::Formula => {
                        let all: Vec<Property> = others.iter().map(PropRow::to_property).collect();
                        let e = p.formula();
                        p.config.insert("expression".into(), json!(to_storage(&e, &all)?));
                    }
                    _ => {}
                }
            }
            if let Some(h) = patch.hidden {
                p.hidden = h;
            }
            if let Some(d) = patch.description {
                if d.chars().count() > 2_000 {
                    return Err(StoreError::TooLarge("description"));
                }
                p.description = (!d.is_empty()).then_some(d);
            }
            save_prop(tx, codec, &row, &p)?;
            bump(tx, &row.database_id, true, false)?;
            let all = present(live_properties(tx, codec, &row.database_id)?);
            Ok((
                all.into_iter().find(|x| x.id == row.id).ok_or(StoreError::NotFound("property"))?,
                row.database_id,
            ))
        })?;
        self.db_changed(&db);
        Ok(prop)
    }

    /// Sets the semantic role of a property (`None` clears).
    pub fn db_property_set_role(&self, id: &str, role: Option<&str>) -> Result<Property> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let (id_owned, role) = (id.to_owned(), role.map(str::to_owned));
        self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &id_owned)?.ok_or(StoreError::NotFound("property"))?;
            let mut p = row.payload.clone();
            p.role = role;
            save_prop(tx, codec, &row, &p)?;
            bump(tx, &row.database_id, true, false)?;
            Ok(load_prop(tx, codec, &id_owned)?
                .ok_or(StoreError::NotFound("property"))?
                .to_property())
        })
    }

    /// `db_property_convert` (job): converts the type of a property. Takes a `pre_bulk` schema version (with the
    /// old values) and converts every row in one transaction.
    pub fn db_property_convert(
        &self,
        id: &str,
        to: PropType,
        config: Option<Map<String, Value>>,
        progress: &dyn Progress,
    ) -> Result<Property> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        progress.progress(0, 1, "convert");
        let (prop, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &id_owned)?.ok_or(StoreError::NotFound("property"))?;
            let from = row.to_property();
            if from.kind == to {
                return Ok((from, row.database_id));
            }
            if !conversion_supported(from.kind, to) {
                return Err(StoreError::Unsupported("this type conversion is not supported"));
            }
            let rows = load_rows(tx, codec, &row.database_id)?;
            // pre_bulk version: the property and every old value.
            let old: BTreeMap<String, CellValue> = rows
                .iter()
                .filter_map(|r| r.payload.values.get(&row.id).map(|v| (r.id.clone(), v.clone())))
                .collect();
            crate::repo::versions::insert_version(
                tx,
                codec,
                &row.database_id,
                VersionTargetKind::DbSchema,
                VersionReason::PreBulk,
                Some(format!("Before converting {} to {}", from.name, to.as_str())),
                &json!({ "property": from, "values": old }),
                now,
            )?;
            let mut cfg = config.unwrap_or_default();
            if matches!(to, PropType::Select | PropType::MultiSelect) {
                // Options from distinct values (max 200), keeping existing options when converting select → multi.
                let mut opts: Vec<SelectOption> = from.select_options();
                if opts.is_empty() {
                    let mut seen: Vec<String> = Vec::new();
                    for r in &rows {
                        if let Some(v) = r.payload.values.get(&row.id) {
                            let t = cells::display(v, &from).trim().to_owned();
                            if !t.is_empty() && !seen.iter().any(|x| x.eq_ignore_ascii_case(&t)) && seen.len() < CONVERT_MAX_OPTIONS {
                                seen.push(t);
                            }
                        }
                    }
                    opts = seen
                        .into_iter()
                        .enumerate()
                        .map(|(i, name)| SelectOption {
                            id: new_id(),
                            name,
                            color: OPTION_PALETTE[i % OPTION_PALETTE.len()],
                            group: None,
                        })
                        .collect();
                }
                config::set(&mut cfg, "options", &opts);
            }
            if to == PropType::Money && !cfg.contains_key("currency") {
                cfg.insert("currency".into(), json!("USD"));
            }
            let target = Property {
                kind: to,
                config: cfg.clone(),
                ..from.clone()
            };
            for r in &rows {
                let Some(v) = r.payload.values.get(&row.id) else { continue };
                let mut p = r.payload.clone();
                match convert_value(&from, &target, v) {
                    Some(nv) => p.values.insert(row.id.clone(), nv),
                    None => p.values.remove(&row.id),
                };
                save_row_payload(tx, codec, &r.id, r.rev, &p, now)?;
            }
            let mut payload = row.payload.clone();
            payload.kind = to;
            payload.config = cfg;
            save_prop(tx, codec, &row, &payload)?;
            bump(tx, &row.database_id, true, true)?;
            let all = present(live_properties(tx, codec, &row.database_id)?);
            Ok((
                all.into_iter().find(|x| x.id == row.id).ok_or(StoreError::NotFound("property"))?,
                row.database_id,
            ))
        })?;
        progress.progress(1, 1, "convert");
        self.db_changed(&db);
        Ok(prop)
    }

    /// `db_property_delete` (soft; restorable). With `also_dual`, the paired relation goes too; otherwise the
    /// pair becomes one-way. The title property cannot be deleted.
    pub fn db_property_delete(&self, id: &str, also_dual: bool) -> Result<()> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        let touched = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &id_owned)?.ok_or(StoreError::NotFound("property"))?;
            if row.payload.kind == PropType::Title {
                return Err(StoreError::invalid("the title property cannot be deleted"));
            }
            tx.prepare_cached("UPDATE db_properties SET deleted_at = ?2 WHERE id = ?1")?
                .execute(params![row.id, now])?;
            bump(tx, &row.database_id, true, false)?;
            let mut touched = vec![row.database_id.clone()];
            if row.payload.kind == PropType::Relation
                && let Some(dual) = row.payload.relation().dual_prop().map(str::to_owned)
                && let Some(drow) = load_prop(tx, codec, &dual)?
            {
                if also_dual {
                    tx.prepare_cached("UPDATE db_properties SET deleted_at = ?2 WHERE id = ?1")?
                        .execute(params![drow.id, now])?;
                } else {
                    let mut p = drow.payload.clone();
                    p.config.insert("dual".into(), Value::Null);
                    save_prop(tx, codec, &drow, &p)?;
                }
                bump(tx, &drow.database_id, true, false)?;
                touched.push(drow.database_id);
            }
            // Views stop referencing the property.
            crate::repo::views::forget_property(tx, codec, &row.database_id, &row.id)?;
            Ok(touched)
        })?;
        for d in touched {
            self.db_changed(&d);
        }
        Ok(())
    }

    /// Restores a soft-deleted property.
    pub fn db_property_restore(&self, id: &str) -> Result<Property> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        let (p, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &id_owned)?.ok_or(StoreError::NotFound("property"))?;
            tx.prepare_cached("UPDATE db_properties SET deleted_at = NULL WHERE id = ?1")?
                .execute([&row.id])?;
            bump(tx, &row.database_id, true, false)?;
            let all = present(live_properties(tx, codec, &row.database_id)?);
            Ok((
                all.into_iter().find(|x| x.id == row.id).ok_or(StoreError::NotFound("property"))?,
                row.database_id,
            ))
        })?;
        self.db_changed(&db);
        Ok(p)
    }

    /// Soft-deleted properties of a database (the Trash section of the schema editor).
    pub fn db_property_trash(&self, database_id: &str) -> Result<Vec<Property>> {
        let s = self.session()?;
        self.read(|c| {
            Ok(load_props(c, &s.codec, database_id, true)?
                .into_iter()
                .filter(|p| p.deleted_at.is_some())
                .map(|p| p.to_property())
                .collect())
        })
    }

    /// `db_property_reorder`.
    pub fn db_property_reorder(&self, id: &str, before_id: Option<&str>, after_id: Option<&str>) -> Result<Property> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let (id_owned, before, after) = (id.to_owned(), before_id.map(str::to_owned), after_id.map(str::to_owned));
        let (p, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &id_owned)?.ok_or(StoreError::NotFound("property"))?;
            let sibs: Vec<(String, String)> = load_props(tx, codec, &row.database_id, false)?
                .into_iter()
                .map(|p| (p.id, p.sort_key))
                .collect();
            let key = key_among(&sibs, after.as_deref(), before.as_deref(), Some(&row.id))?;
            tx.prepare_cached("UPDATE db_properties SET sort_key = ?2 WHERE id = ?1")?
                .execute(params![row.id, key])?;
            bump(tx, &row.database_id, true, false)?;
            let all = present(live_properties(tx, codec, &row.database_id)?);
            Ok((
                all.into_iter().find(|x| x.id == row.id).ok_or(StoreError::NotFound("property"))?,
                row.database_id,
            ))
        })?;
        self.db_changed(&db);
        Ok(p)
    }

    /// `db_select_option_upsert`.
    pub fn db_select_option_upsert(&self, property_id: &str, option: SelectOptionInput) -> Result<Property> {
        validate_title(&option.name)?;
        if option.name.trim().is_empty() {
            return Err(StoreError::invalid_field("name", "option names cannot be empty"));
        }
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let pid = property_id.to_owned();
        let (p, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &pid)?.ok_or(StoreError::NotFound("property"))?;
            if !matches!(row.payload.kind, PropType::Select | PropType::MultiSelect | PropType::Status) {
                return Err(StoreError::invalid("the property has no options"));
            }
            let mut cfg: SelectConfig = config::read(&row.payload.config);
            let name = option.name.trim().to_owned();
            match &option.id {
                Some(id) => {
                    if cfg.options.iter().any(|o| &o.id != id && o.name.eq_ignore_ascii_case(&name)) {
                        return Err(StoreError::invalid_field("name", "an option with this name exists"));
                    }
                    let o = cfg
                        .options
                        .iter_mut()
                        .find(|o| &o.id == id)
                        .ok_or(StoreError::NotFound("option"))?;
                    o.name = name;
                    o.color = option.color;
                    if row.payload.kind == PropType::Status {
                        o.group = option.group.or(o.group);
                    }
                }
                None => {
                    if cfg.options.iter().any(|o| o.name.eq_ignore_ascii_case(&name)) {
                        return Err(StoreError::invalid_field("name", "an option with this name exists"));
                    }
                    if cfg.options.len() >= MAX_OPTIONS {
                        return Err(StoreError::TooLarge("options"));
                    }
                    cfg.options.push(SelectOption {
                        id: new_id(),
                        name,
                        color: option.color,
                        group: if row.payload.kind == PropType::Status {
                            Some(option.group.unwrap_or(StatusGroup::Todo))
                        } else {
                            None
                        },
                    });
                }
            }
            let mut p = row.payload.clone();
            config::set(&mut p.config, "options", &cfg.options);
            save_prop(tx, codec, &row, &p)?;
            bump(tx, &row.database_id, true, false)?;
            Ok((load_prop(tx, codec, &pid)?.ok_or(StoreError::NotFound("property"))?.to_property(), row.database_id))
        })?;
        self.db_changed(&db);
        Ok(p)
    }

    /// `db_select_option_delete`: removes the option and clears it from every row.
    pub fn db_select_option_delete(&self, property_id: &str, option_id: &str) -> Result<Property> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (pid, oid) = (property_id.to_owned(), option_id.to_owned());
        let (p, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let row = load_prop(tx, codec, &pid)?.ok_or(StoreError::NotFound("property"))?;
            let mut cfg: SelectConfig = config::read(&row.payload.config);
            let before = cfg.options.len();
            cfg.options.retain(|o| o.id != oid);
            if cfg.options.len() == before {
                return Err(StoreError::NotFound("option"));
            }
            let mut p = row.payload.clone();
            config::set(&mut p.config, "options", &cfg.options);
            save_prop(tx, codec, &row, &p)?;
            let mut changed = false;
            for r in load_rows(tx, codec, &row.database_id)? {
                let Some(v) = r.payload.values.get(&row.id) else { continue };
                let nv = match v {
                    CellValue::Select { v: Some(x) } | CellValue::Status { v: Some(x) } if x == &oid => None,
                    CellValue::Multi { v } if v.contains(&oid) => {
                        Some(CellValue::Multi { v: v.iter().filter(|x| *x != &oid).cloned().collect() })
                    }
                    _ => continue,
                };
                let mut rp = r.payload.clone();
                match nv {
                    Some(nv) => rp.values.insert(row.id.clone(), nv),
                    None => rp.values.remove(&row.id),
                };
                save_row_payload(tx, codec, &r.id, r.rev, &rp, now)?;
                changed = true;
            }
            bump(tx, &row.database_id, true, changed)?;
            Ok((load_prop(tx, codec, &pid)?.ok_or(StoreError::NotFound("property"))?.to_property(), row.database_id))
        })?;
        self.db_changed(&db);
        Ok(p)
    }

    /// `db_formula_check`: parse, type check (with the property types of the database) and preview the first
    /// five rows.
    pub fn db_formula_check(&self, database_id: &str, expression: &str) -> Result<FormulaCheck> {
        if expression.chars().count() > 8_192 {
            return Err(StoreError::TooLarge("formula"));
        }
        let s = self.session()?;
        let ctx = self.date_ctx()?;
        let world = self.read(|c| load_world(c, &s.codec, database_id))?;
        let Some(ord) = world.ord(database_id) else {
            return Err(StoreError::NotFound("database"));
        };
        let db = world.at(ord);
        let ty_of = |key: &str| -> Option<emp_sheets::dialect::typecheck::Ty> {
            use emp_sheets::dialect::typecheck::Ty;
            let p = db.resolve(key)?;
            Some(match p.kind {
                PropType::Number | PropType::Money | PropType::Rating | PropType::Progress => Ty::Number,
                PropType::Checkbox => Ty::Bool,
                PropType::Date | PropType::CreatedTime | PropType::UpdatedTime => Ty::Date,
                PropType::MultiSelect | PropType::Files => Ty::List(Box::new(Ty::Text)),
                PropType::Relation => Ty::List(Box::new(Ty::Row)),
                PropType::Formula | PropType::Rollup | PropType::Computed => Ty::Any,
                _ => Ty::Text,
            })
        };
        let check = emp_sheets::dialect::row::check(expression, &ty_of);
        let mut out = FormulaCheck {
            ok: check.ok,
            kind: check.r#type,
            error: check.error.map(|e| FormulaError {
                message: e.message,
                from: e.from,
                to: e.to,
            }),
            preview: Vec::new(),
        };
        if out.ok {
            let stored = to_storage(expression, &db.props)?;
            let compiled = emp_sheets::dialect::row::compile(&stored).map_err(|e| StoreError::invalid(e.message))?;
            // Evaluate against a temporary formula property.
            let mut tmp = db.clone();
            let pid = "$check".to_owned();
            tmp.props.push(Property {
                id: pid.clone(),
                name: "$check".into(),
                kind: PropType::Formula,
                config: json!({ "expression": stored }).as_object().cloned().unwrap_or_default(),
                role: None,
                hidden: true,
                sort_key: "~".into(),
                description: None,
            });
            let _ = compiled;
            let mut dbs: Vec<DbData> = world.dbs().to_vec();
            dbs[ord] = tmp;
            let w2 = World::new(dbs);
            let ev = Evaluator::new(&w2, ctx);
            let p = w2.at(ord).prop(&pid).cloned();
            if let Some(p) = p {
                for r in 0..w2.at(ord).rows.len().min(5) {
                    out.preview.push(ev.value(ord, r, &p).map(|v| cells::plain_text(&v)).unwrap_or_default());
                }
            }
        }
        Ok(out)
    }

    /// `db_relation_options`: rows of the relation's target database whose title contains `search`.
    pub fn db_relation_options(&self, property_id: &str, search: &str, limit: usize) -> Result<Vec<RelationOption>> {
        if search.chars().count() > 512 {
            return Err(StoreError::TooLarge("search"));
        }
        let s = self.session()?;
        let limit = limit.clamp(1, 1_000);
        let needle = fold(search.trim());
        self.read(|c| {
            let p = load_prop(c, &s.codec, property_id)?.ok_or(StoreError::NotFound("property"))?;
            if p.payload.kind != PropType::Relation {
                return Err(StoreError::invalid("not a relation"));
            }
            let target = p.payload.relation().target_database_id;
            let d = load_db_data(c, &s.codec, &target)?;
            Ok((0..d.rows.len())
                .filter_map(|i| {
                    let t = d.row_title(i);
                    fold(&t).contains(&needle).then(|| RelationOption {
                        id: d.rows[i].id.clone(),
                        title: t,
                        icon: d.rows[i].payload.icon.clone(),
                    })
                })
                .take(limit)
                .collect())
        })
    }

    /// Databases of a workspace (id and title), for pickers and life apps.
    pub fn db_list(&self, workspace_id: &str) -> Result<Vec<PageMeta>> {
        Ok(self
            .page_tree(workspace_id)?
            .into_iter()
            .filter(|m| m.kind == PageKind::Database)
            .collect())
    }

    /// The query date context from vault settings (time zone, week start) and the injected clock.
    pub(crate) fn date_ctx(&self) -> Result<DateCtx> {
        let vs = self.vault_settings()?;
        Ok(DateCtx::new(self.now(), &vs.timezone, vs.week_start))
    }

    /// `db_duplicate` (job): copies the database page, its schema and views, and optionally its rows (relations
    /// inside the database are remapped; two-way relations to other databases become one-way in the copy).
    pub fn db_duplicate(&self, id: &str, with_rows: bool, progress: &dyn Progress) -> Result<PageMeta> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        progress.progress(0, 1, "duplicate");
        let meta = self.write(move |tx| {
            let codec = &sess.codec;
            let src_page = load_page(tx, &id_owned)?.ok_or(StoreError::NotFound("database"))?;
            let (mut page, ws) = page_info(tx, codec, &id_owned)?;
            page.title.push_str(" (copy)");
            page.template_key = None;
            let key = position_key(tx, &ws, src_page.parent_id.as_deref(), Some(&id_owned), None, None)?;
            let new_db = new_id();
            insert_page(tx, codec, &new_db, &ws, src_page.parent_id.as_deref(), PageKind::Database, &key, &page, now)?;
            let src = load_db(tx, codec, &id_owned)?;
            let props = load_props(tx, codec, &id_owned, false)?;
            let mut pmap: BTreeMap<String, String> = BTreeMap::new();
            for p in &props {
                pmap.insert(p.id.clone(), new_id());
            }
            let mut payload = src.payload.clone();
            payload.primary_prop_id = pmap.get(&payload.primary_prop_id).cloned().unwrap_or_default();
            payload.roles = payload
                .roles
                .iter()
                .filter_map(|(k, v)| pmap.get(v).map(|n| (k.clone(), n.clone())))
                .collect();
            for t in &mut payload.templates {
                t.values = t
                    .values
                    .iter()
                    .filter_map(|(k, v)| pmap.get(k).map(|n| (n.clone(), v.clone())))
                    .collect();
            }
            if !with_rows {
                payload.uid_seq = 0;
            }
            let e = codec.encode(&db_loc(&new_db, 1), &payload)?;
            tx.prepare_cached(
                "INSERT INTO databases (id, schema_rev, data_rev, rev, enc, payload) VALUES (?1, 1, 0, 1, ?2, ?3)",
            )?
            .execute(params![new_db, e.enc, e.payload])?;
            for p in &props {
                let mut pp = p.payload.clone();
                match pp.kind {
                    PropType::Relation => {
                        let mut rc = pp.relation();
                        if rc.target_database_id == id_owned {
                            rc.target_database_id = new_db.clone();
                            rc.dual = rc.dual.map(|d| DualRef {
                                property_id: d.property_id.and_then(|x| pmap.get(&x).cloned()),
                            });
                        } else {
                            rc.dual = None;
                        }
                        for (k, v) in serde_json::to_value(&rc)?.as_object().cloned().unwrap_or_default() {
                            pp.config.insert(k, v);
                        }
                    }
                    PropType::Rollup => {
                        for k in ["relationPropId"] {
                            if let Some(n) = pp.config.get(k).and_then(Value::as_str).and_then(|x| pmap.get(x)) {
                                pp.config.insert(k.into(), json!(n));
                            }
                        }
                        // The target property of a self-relation rollup lives in this database too.
                        if let Some(n) = pp.config.get("targetPropId").and_then(Value::as_str).and_then(|x| pmap.get(x)) {
                            pp.config.insert("targetPropId".into(), json!(n));
                        }
                    }
                    PropType::Formula => {
                        let e = pp.formula();
                        if let Ok(ne) = emp_sheets::dialect::row::to_display(&e, &|old| pmap.get(old).map(|n| format!("#{n}")))
                        {
                            pp.config.insert("expression".into(), json!(ne));
                        }
                    }
                    _ => {}
                }
                insert_prop(tx, codec, &new_db, &pmap[&p.id], &p.sort_key, &pp)?;
            }
            for v in load_views(tx, codec, &id_owned)? {
                let mut vp: ViewPayload = crate::repo::views::view_payload(&v);
                crate::repo::views::remap_props(&mut vp, &pmap);
                insert_view(tx, codec, &new_db, &new_id(), &v.sort_key, &vp)?;
            }
            if with_rows {
                let rows = load_rows(tx, codec, &id_owned)?;
                let rmap: BTreeMap<String, String> = rows.iter().map(|r| (r.id.clone(), new_id())).collect();
                for r in &rows {
                    let mut rp = r.payload.clone();
                    rp.secrets.clear();
                    rp.values = rp
                        .values
                        .into_iter()
                        .filter_map(|(k, v)| {
                            let nk = pmap.get(&k)?.clone();
                            let prop = props.iter().find(|p| p.id == k)?;
                            let v = match (prop.payload.kind, v) {
                                (PropType::Secret, _) => return None,
                                (PropType::Relation, CellValue::Relation { v }) => {
                                    if prop.payload.relation().target_database_id == id_owned {
                                        CellValue::Relation {
                                            v: v.iter().filter_map(|x| rmap.get(x).cloned()).collect(),
                                        }
                                    } else {
                                        CellValue::Relation { v }
                                    }
                                }
                                (_, v) => v,
                            };
                            Some((nk, v))
                        })
                        .collect();
                    crate::repo::rows::insert_row(tx, codec, &new_db, &rmap[&r.id], &r.sort_key, &rp, now)?;
                }
                bump(tx, &new_db, false, true)?;
            }
            crate::repo::pages::load_meta(tx, codec, &new_db)?.ok_or(StoreError::NotFound("page"))
        })?;
        progress.progress(1, 1, "duplicate");
        self.index_page(&s, &meta, None);
        self.emit(StoreEvent::TreeChanged {
            workspace_id: meta.workspace_id.clone(),
            upserted: vec![meta.clone()],
            removed: Vec::new(),
        });
        Ok(meta)
    }
}
