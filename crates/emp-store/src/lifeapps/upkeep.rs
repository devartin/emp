//! Upkeep of installed apps: the vault-open upgrade of pre-1.0 installs and the calculated columns and rules
//! that keep generated databases consistent after every write.
//!
//! * [`Store::lifeapp_upgrade_all`] runs once per unlocked session (idempotent, recorded per instance as
//!   `InstancePayload.upgraded`). Level 1 brings an install made with an older manifest to the 1.0 shape: semantic
//!   roles on generated properties (`task.status`, `habit.name`, `iacct.type`, …) and in the database's role map,
//!   properties the 1.0 manifest added, and option ids equal to the manifest option keys (see
//!   [`crate::lifeapps::build::option_key_id`]) in options, cells (live and trashed rows), views and row templates.
//! * [`Store::lifeapp_react`] runs after writes to app databases (the app calls it from its `db:changed`
//!   listener): Tasks keeps `Done` / `Completed at` in step with the status and spawns the next occurrence of a
//!   completed recurring task; Habits refreshes the streak and 30-day-rate columns. Every rule is idempotent, so the
//!   writes it makes (which change the database again) settle after one more pass.
//! * [`Store::lifeapp_add_workbook`] creates a new spreadsheet from a Spreadsheet Studio template.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, LazyLock, Weak};

use chrono::{Duration, NaiveDate, NaiveTime};
use emp_crypto::TableTag;
use parking_lot::Mutex;
use rusqlite::params;
use serde_json::{Map, Value, json};

use crate::codec::RecordLoc;
use crate::life::recurrence::{Rule, next_after};
use crate::lifeapps::build::{self, DbRec};
use crate::lifeapps::ids::IdGen;
use crate::lifeapps::metrics;
use crate::lifeapps::plan;
use crate::model::PageMeta;
use crate::model::ids::new_id;
use crate::model::sort_key::key_between;
use crate::query::config::{HasConfig, options};
use crate::query::model::{
    CellValue, ComputedKind, ComputedValue, DateValue, PropType, Property, RecurrenceMode,
    RecurrenceValue, RowCreate, RowPayload, RowUpdate, StatusGroup, TemplateValue, ViewPayload,
};
use crate::repo::databases::{
    bump, insert_prop, load_db, load_props, load_schema, save_db, save_prop,
};
use crate::repo::lifeapps::{
    InstanceRow, disk_fingerprint, list_instances, load_instance, manifest_of, save_instance,
    wb_insert,
};
use crate::repo::pages::{decode_page, load_meta, load_page, position_key};
use crate::repo::rows::{load_rows, row_loc};
use crate::vault::{Session, StoreEvent};
use crate::{Result, Store, StoreError};

/// Current upgrade level of an instance (`InstancePayload.upgraded`); fresh installs are created at this level.
pub const UPGRADE_LEVEL: u32 = 1;

/// Sessions whose instances were already checked by [`Store::lifeapp_upgrade_all`] (dropped with the session).
static UPGRADED: LazyLock<Mutex<Vec<Weak<Session>>>> = LazyLock::new(|| Mutex::new(Vec::new()));

// ───────────────────────────────────────────────────────────────────────────── helpers

/// Replaces every JSON string equal to a key of `map`. Returns whether anything changed.
fn remap_strings(v: &mut Value, map: &BTreeMap<String, String>) -> bool {
    match v {
        Value::String(s) => match map.get(s.as_str()) {
            Some(n) => {
                s.clone_from(n);
                true
            }
            None => false,
        },
        Value::Array(a) => a.iter_mut().fold(false, |ch, x| remap_strings(x, map) | ch),
        Value::Object(o) => o
            .values_mut()
            .fold(false, |ch, x| remap_strings(x, map) | ch),
        _ => false,
    }
}

/// Remaps the option ids of a select / status / multi-select cell.
fn remap_cell(c: &mut CellValue, map: &BTreeMap<String, String>) -> bool {
    match c {
        CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) } => {
            match map.get(id.as_str()) {
                Some(n) => {
                    id.clone_from(n);
                    true
                }
                None => false,
            }
        }
        CellValue::Multi { v } => v
            .iter_mut()
            .fold(false, |ch, id| match map.get(id.as_str()) {
                Some(n) => {
                    id.clone_from(n);
                    true
                }
                None => ch,
            }),
        _ => false,
    }
}

const fn has_options(kind: PropType) -> bool {
    matches!(
        kind,
        PropType::Select | PropType::MultiSelect | PropType::Status
    )
}

/// Rewrites a row payload in place without touching `updated_at` (upkeep is not a user edit).
fn rewrite_row(
    tx: &rusqlite::Connection,
    codec: &crate::codec::Codec,
    id: &str,
    rev: i64,
    p: &RowPayload,
) -> Result<()> {
    let e = codec.encode(&row_loc(id, rev + 1), p)?;
    tx.prepare_cached("UPDATE db_rows SET rev = ?2, enc = ?3, payload = ?4 WHERE id = ?1")?
        .execute(params![id, rev + 1, e.enc, e.payload])?;
    Ok(())
}

fn view_loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::DbViews, id, u64::try_from(rev).unwrap_or(0))
}

/// Level-1 upgrade of one generated database. Returns `(schema changed, data changed)`.
fn upgrade_db(
    tx: &rusqlite::Connection,
    codec: &crate::codec::Codec,
    ids: &IdGen,
    d: &DbRec,
) -> Result<(bool, bool)> {
    let prefix = format!("{}.prop:", d.key);
    let disk = load_props(tx, codec, &d.id, true)?;
    let mut last = disk.iter().map(|p| p.sort_key.clone()).max();
    let mut schema = false;
    let mut data = false;
    let mut maps: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut live: BTreeSet<String> = disk
        .iter()
        .filter(|p| p.deleted_at.is_none())
        .map(|p| p.id.clone())
        .collect();
    for p in &d.props {
        let Some(prop_key) = p.key.strip_prefix(&prefix) else {
            continue;
        };
        let Some(x) = disk.iter().find(|x| x.id == p.id) else {
            // A property the 1.0 manifest added (additive schema, like a tune-up).
            let k = key_between(last.as_deref(), None)?;
            insert_prop(tx, codec, &d.id, &p.id, &k, &p.payload)?;
            last = Some(k);
            live.insert(p.id.clone());
            schema = true;
            continue;
        };
        let mut pl = x.payload.clone();
        if pl.role.is_none() && p.payload.role.is_some() {
            pl.role.clone_from(&p.payload.role);
        }
        if has_options(pl.kind) {
            let disk_opts = options(&pl.config);
            let mut map = BTreeMap::new();
            for o in options(&p.payload.config) {
                let legacy = build::legacy_option_id(ids, &d.key, prop_key, &o.id);
                if disk_opts.iter().any(|x| x.id == legacy)
                    && !disk_opts.iter().any(|x| x.id == o.id)
                {
                    map.insert(legacy, o.id.clone());
                }
            }
            if !map.is_empty() {
                let mut cfg = Value::Object(std::mem::take(&mut pl.config));
                remap_strings(&mut cfg, &map);
                if let Value::Object(c) = cfg {
                    pl.config = c;
                }
                maps.insert(p.id.clone(), map);
            }
        }
        if pl != x.payload {
            save_prop(tx, codec, x, &pl)?;
            schema = true;
        }
    }
    // Role map and row templates.
    let dbrow = load_db(tx, codec, &d.id)?;
    let mut dp = dbrow.payload.clone();
    for (role, pid) in &d.db.roles {
        if !dp.roles.contains_key(role) && live.contains(pid) {
            dp.roles.insert(role.clone(), pid.clone());
        }
    }
    for t in &mut dp.templates {
        for (pid, tv) in &mut t.values {
            if let (Some(map), TemplateValue::Cell(c)) = (maps.get(pid), tv) {
                remap_cell(c, map);
            }
        }
    }
    if dp != dbrow.payload {
        save_db(tx, codec, &dbrow, &dp)?;
        schema = true;
    }
    if maps.is_empty() {
        return Ok((schema, data));
    }
    // Cells of every row (trashed ones too, so a restore stays valid).
    let rows: Vec<(String, i64, i64, Vec<u8>)> = tx
        .prepare_cached("SELECT id, rev, enc, payload FROM db_rows WHERE database_id = ?1")?
        .query_map([&d.id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (id, rev, enc, raw) in rows {
        let mut p: RowPayload = match codec.decode(&row_loc(&id, rev), enc, &raw) {
            Ok(p) => p,
            Err(StoreError::Damaged { .. }) => continue,
            Err(e) => return Err(e),
        };
        let mut changed = false;
        for (pid, map) in &maps {
            if let Some(c) = p.values.get_mut(pid) {
                changed |= remap_cell(c, map);
            }
        }
        if changed {
            rewrite_row(tx, codec, &id, rev, &p)?;
            data = true;
        }
    }
    // Views (filters, groups, collapsed groups, card settings): option ids are unique UUIDs, so a string match is
    // exact.
    let all: BTreeMap<String, String> = maps
        .values()
        .flatten()
        .map(|(a, b)| (a.clone(), b.clone()))
        .collect();
    let views: Vec<(String, i64, i64, Vec<u8>)> = tx
        .prepare_cached("SELECT id, rev, enc, payload FROM db_views WHERE database_id = ?1")?
        .query_map([&d.id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (id, rev, enc, raw) in views {
        let p: ViewPayload = match codec.decode(&view_loc(&id, rev), enc, &raw) {
            Ok(p) => p,
            Err(StoreError::Damaged { .. }) => continue,
            Err(e) => return Err(e),
        };
        let mut v = serde_json::to_value(&p)?;
        if remap_strings(&mut v, &all) {
            let np: ViewPayload = serde_json::from_value(v)?;
            let e = codec.encode(&view_loc(&id, rev + 1), &np)?;
            tx.prepare_cached(
                "UPDATE db_views SET rev = ?2, enc = ?3, payload = ?4 WHERE id = ?1",
            )?
            .execute(params![id, rev + 1, e.enc, e.payload])?;
            schema = true;
        }
    }
    Ok((schema, data))
}

/// A property of an app database by role (database role map, then the property's own role), else by manifest key.
fn prop_of<'a>(
    props: &'a [Property],
    roles: &BTreeMap<String, String>,
    key_map: &BTreeMap<String, String>,
    db_key: &str,
    role: &str,
    key: &str,
) -> Option<&'a Property> {
    let id = roles
        .get(role)
        .cloned()
        .or_else(|| {
            props
                .iter()
                .find(|p| p.role.as_deref() == Some(role))
                .map(|p| p.id.clone())
        })
        .or_else(|| key_map.get(&format!("{db_key}.prop:{key}")).cloned())?;
    props.iter().find(|p| p.id == id)
}

fn option_of(v: Option<&CellValue>) -> Option<&str> {
    match v? {
        CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) } => Some(id),
        _ => None,
    }
}

fn day_of(v: Option<&CellValue>) -> Option<(NaiveDate, &DateValue)> {
    match v? {
        CellValue::Date { v: Some(d) } => NaiveDate::parse_from_str(d.start.get(..10)?, "%Y-%m-%d")
            .ok()
            .map(|n| (n, d)),
        _ => None,
    }
}

/// `d` moved to `day`, keeping its time of day (and zone) when it has one.
fn moved(d: &DateValue, day: NaiveDate) -> DateValue {
    let rest = d.start.get(10..).unwrap_or_default();
    DateValue {
        start: format!("{}{rest}", day.format("%Y-%m-%d")),
        end: None,
        time: d.time,
        tz: d.tz.clone(),
    }
}

/// The due day of the occurrence after a completed one: on schedule, the first occurrence after the old due day
/// (never earlier than today); after completion, the first occurrence after today.
#[must_use]
pub fn next_due(
    rv: &RecurrenceValue,
    due: Option<NaiveDate>,
    today: NaiveDate,
) -> Option<NaiveDate> {
    let rule = Rule::parse(&rv.rrule, &rv.dtstart, rv.tz.as_deref()).ok()?;
    let end_of = |d: NaiveDate| d.and_time(NaiveTime::from_hms_opt(23, 59, 59).unwrap_or_default());
    let next = match rv.mode {
        RecurrenceMode::Schedule => {
            let base = due.unwrap_or(today).max(today - Duration::days(1));
            next_after(&rule, end_of(base), RecurrenceMode::Schedule)?
        }
        RecurrenceMode::Completion => next_after(
            &rule,
            today.and_time(NaiveTime::from_hms_opt(12, 0, 0).unwrap_or_default()),
            RecurrenceMode::Completion,
        )?,
    };
    Some(next.date())
}

// ───────────────────────────────────────────────────────────────────────────── Store API

impl Store {
    /// Vault-open upgrade of every attached instance below [`UPGRADE_LEVEL`] (once per unlocked session; later
    /// calls return at once). Returns the number of instances upgraded. Calculated columns are refreshed afterwards.
    /// An instance that fails to upgrade is left as it is (and retried next session); the first error is returned
    /// after every other instance was handled.
    pub fn lifeapp_upgrade_all(&self) -> Result<usize> {
        let s = self.session()?;
        let mut done = UPGRADED.lock();
        done.retain(|w| w.strong_count() > 0);
        let weak = Arc::downgrade(&s);
        if done.iter().any(|w| Weak::ptr_eq(w, &weak)) {
            return Ok(0);
        }
        let instances = self.read(|c| list_instances(c, &s.codec, None))?;
        let mut n = 0;
        let mut first_err = None;
        for inst in instances
            .iter()
            .filter(|i| !i.payload.detached && i.payload.upgraded < UPGRADE_LEVEL)
        {
            match self.upgrade_instance(&s, inst) {
                Ok(dbs) => {
                    n += 1;
                    self.invalidate_metrics(&inst.id);
                    for d in dbs {
                        self.db_changed(&d);
                    }
                }
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        done.push(weak);
        drop(done);
        let upkeep = self.lifeapp_upkeep_all();
        match first_err {
            Some(e) => Err(e),
            None => upkeep.map(|()| n),
        }
    }

    fn upgrade_instance(&self, s: &Arc<Session>, inst: &InstanceRow) -> Result<Vec<String>> {
        let (_, b, _, _) = self.rebuild(inst, &inst.payload.answers)?;
        let ids = IdGen::new(&inst.id)?;
        let sess = Arc::clone(s);
        let iid = inst.id.clone();
        self.write(move |tx| {
            let codec = &sess.codec;
            let Some(cur) = load_instance(tx, codec, &iid)? else {
                return Ok(Vec::new());
            };
            if cur.payload.upgraded >= UPGRADE_LEVEL || cur.payload.detached {
                return Ok(Vec::new());
            }
            let mut payload = cur.payload.clone();
            // Records the app generated and the user has not changed keep their "untouched" fingerprint.
            let mut before = BTreeMap::new();
            for d in &b.dbs {
                for id in std::iter::once(&d.id).chain(d.rows.iter().map(|r| &r.id)) {
                    if let Some(fp) = disk_fingerprint(tx, codec, &b, id)? {
                        before.insert(id.clone(), fp);
                    }
                }
            }
            let mut changed = Vec::new();
            for d in &b.dbs {
                let Some(page) = load_page(tx, &d.id)? else {
                    continue;
                };
                if page.deleted_at.is_some() {
                    continue;
                }
                let (schema, data) = upgrade_db(tx, codec, &ids, d)?;
                if schema || data {
                    bump(tx, &d.id, schema, data)?;
                    changed.push(d.id.clone());
                }
            }
            for (id, fp) in before {
                if payload.fingerprints.get(&id) == Some(&fp)
                    && let Some(after) = disk_fingerprint(tx, codec, &b, &id)?
                {
                    payload.fingerprints.insert(id, after);
                }
            }
            for (k, v) in &b.key_map {
                payload
                    .key_map
                    .entry(k.clone())
                    .or_insert_with(|| v.clone());
            }
            payload.upgraded = UPGRADE_LEVEL;
            save_instance(tx, codec, &cur, &payload)?;
            Ok(changed)
        })
    }

    /// Runs every upkeep rule over every attached instance (vault open, a new day). Returns the first error after
    /// every instance was handled.
    pub fn lifeapp_upkeep_all(&self) -> Result<()> {
        let s = self.session()?;
        let instances = self.read(|c| list_instances(c, &s.codec, None))?;
        let mut first_err = None;
        for inst in instances.iter().filter(|i| !i.payload.detached) {
            let r = match inst.app_id.as_str() {
                "life-os" => match inst.payload.key_map.get("tasks") {
                    Some(db) => self.upkeep_tasks(&s, inst, db, None),
                    None => Ok(()),
                },
                "habits" => self.upkeep_habits(&s, inst),
                _ => Ok(()),
            };
            if let Err(e) = r {
                first_err.get_or_insert(e);
            }
        }
        first_err.map_or(Ok(()), Err)
    }

    /// Upkeep after writes: `changed` lists `(database id, changed row ids or None for "anything")`. Returns the
    /// `(instance id, app id)` of every attached instance one of the databases belongs to.
    pub fn lifeapp_react(
        &self,
        changed: &[(String, Option<Vec<String>>)],
    ) -> Result<Vec<(String, String)>> {
        if changed.is_empty() {
            return Ok(Vec::new());
        }
        let s = self.session()?;
        let instances = self.read(|c| list_instances(c, &s.codec, None))?;
        let mut out = Vec::new();
        let mut first_err = None;
        for inst in instances.iter().filter(|i| !i.payload.detached) {
            let km = &inst.payload.key_map;
            let hit = |key: &str| {
                km.get(key)
                    .and_then(|id| changed.iter().find(|(d, _)| d == id))
            };
            let mine = changed.iter().any(|(d, _)| km.values().any(|v| v == d));
            if !mine {
                continue;
            }
            out.push((inst.id.clone(), inst.app_id.clone()));
            let r = match inst.app_id.as_str() {
                "life-os" => match hit("tasks") {
                    Some((db, rows)) => self.upkeep_tasks(&s, inst, db, rows.as_deref()),
                    None => Ok(()),
                },
                "habits" if hit("log").is_some() || hit("habits").is_some() => {
                    self.upkeep_habits(&s, inst)
                }
                _ => Ok(()),
            };
            if let Err(e) = r {
                first_err.get_or_insert(e);
            }
        }
        first_err.map_or(Ok(out), Err)
    }

    /// Tasks: `Done` follows the status (the Lists progress rollup reads it), `Completed at` is set when a task is
    /// done and cleared when it is reopened, and completing a recurring task creates its next occurrence (the
    /// completed one keeps its history and hands the repeat rule to the new one). Checks off "Create a list with a
    /// next action" once a list has a Next task.
    fn upkeep_tasks(
        &self,
        s: &Arc<Session>,
        inst: &InstanceRow,
        db_id: &str,
        only: Option<&[String]>,
    ) -> Result<()> {
        let (schema, rows) = self.read(|c| {
            let Some(page) = load_page(c, db_id)? else {
                return Ok((None, Vec::new()));
            };
            if page.deleted_at.is_some() {
                return Ok((None, Vec::new()));
            }
            Ok((
                Some(load_schema(c, &s.codec, db_id)?),
                load_rows(c, &s.codec, db_id)?,
            ))
        })?;
        let Some(schema) = schema else {
            return Ok(());
        };
        let km = &inst.payload.key_map;
        let roles = &schema.database.roles;
        let props = &schema.properties;
        let p = |role: &str, key: &str| prop_of(props, roles, km, "tasks", role, key);
        let Some(status) = p("task.status", "status") else {
            return Ok(());
        };
        let (recurrence, due, scheduled) = (
            p("task.recurrence", "recurrence"),
            p("task.due", "due"),
            p("task.scheduled", "scheduled"),
        );
        let (completed, done_flag, project) = (
            p("task.completed", "completed_at"),
            p("task.done", "done_flag"),
            p("task.project", "project"),
        );
        let opts = status.select_options();
        let is_done = |id: &str| {
            opts.iter()
                .find(|o| o.id == id)
                .is_some_and(|o| o.group == Some(StatusGroup::Complete) || o.id == "done")
        };
        let next_opt = opts
            .iter()
            .find(|o| o.id == "next")
            .or_else(|| opts.iter().find(|o| o.name.eq_ignore_ascii_case("next")))
            .or_else(|| opts.iter().find(|o| o.group != Some(StatusGroup::Complete)))
            .map(|o| o.id.clone());
        let status_cell = |id: Option<String>| match status.kind {
            PropType::Select => CellValue::Select { v: id },
            _ => CellValue::Status { v: id },
        };
        let today = self.local_today()?;
        let today_cell = CellValue::Date {
            v: Some(DateValue {
                start: today.format("%Y-%m-%d").to_string(),
                end: None,
                time: false,
                tz: None,
            }),
        };
        let mut updates = Vec::new();
        let mut creates = Vec::new();
        let mut has_next_action = false;
        for r in &rows {
            let v = &r.payload.values;
            let st = option_of(v.get(&status.id));
            if let (Some(pp), Some(st)) = (project, st)
                && (st == "next"
                    || opts
                        .iter()
                        .any(|o| o.id == st && o.name.eq_ignore_ascii_case("next")))
                && matches!(v.get(&pp.id), Some(CellValue::Relation { v }) if !v.is_empty())
            {
                has_next_action = true;
            }
            if only.is_some_and(|ids| !ids.contains(&r.id)) {
                continue;
            }
            let done = st.is_some_and(is_done);
            let mut vals: BTreeMap<String, Option<CellValue>> = BTreeMap::new();
            if let Some(df) = done_flag.filter(|df| df.kind == PropType::Checkbox) {
                let cur = matches!(v.get(&df.id), Some(CellValue::Check { v: true }));
                if cur != done {
                    vals.insert(df.id.clone(), Some(CellValue::Check { v: done }));
                }
            }
            if let Some(cp) = completed.filter(|cp| cp.kind == PropType::Date) {
                let has = matches!(v.get(&cp.id), Some(CellValue::Date { v: Some(_) }));
                if done && !has {
                    vals.insert(cp.id.clone(), Some(today_cell.clone()));
                } else if !done && has {
                    vals.insert(cp.id.clone(), None);
                }
            }
            if done
                && let Some(rp) = recurrence
                && let Some(CellValue::Recurrence { v: Some(rv) }) = v.get(&rp.id)
            {
                let old_due = due.and_then(|d| day_of(v.get(&d.id)));
                if let Some(next) = next_due(rv, old_due.map(|x| x.0), today) {
                    let mut nv: BTreeMap<String, CellValue> = BTreeMap::new();
                    let skip: BTreeSet<&str> = [Some(status), completed, done_flag, due, scheduled]
                        .into_iter()
                        .flatten()
                        .map(|x| x.id.as_str())
                        .collect();
                    for prop in props {
                        if skip.contains(prop.id.as_str())
                            || prop.kind.is_read_only()
                            || prop.kind == PropType::Secret
                            || prop.role.as_deref() == Some("task.top3")
                        {
                            continue;
                        }
                        if let Some(c) = v.get(&prop.id) {
                            nv.insert(prop.id.clone(), c.clone());
                        }
                    }
                    nv.insert(status.id.clone(), status_cell(next_opt.clone()));
                    if let Some(d) = due {
                        let dv = old_due.map_or_else(
                            || DateValue {
                                start: next.format("%Y-%m-%d").to_string(),
                                end: None,
                                time: false,
                                tz: None,
                            },
                            |(_, dv)| moved(dv, next),
                        );
                        nv.insert(d.id.clone(), CellValue::Date { v: Some(dv) });
                    }
                    if let (Some(sp), Some((old, _))) = (scheduled, old_due)
                        && let Some((sday, sv)) = day_of(v.get(&sp.id))
                    {
                        let shifted = sday + (next - old);
                        nv.insert(
                            sp.id.clone(),
                            CellValue::Date {
                                v: Some(moved(sv, shifted)),
                            },
                        );
                    }
                    creates.push((r.id.clone(), nv));
                    vals.insert(rp.id.clone(), None);
                }
            }
            if !vals.is_empty() {
                updates.push(RowUpdate {
                    id: r.id.clone(),
                    values: vals,
                    base_rev: None,
                });
            }
        }
        for chunk in updates.chunks(crate::repo::rows::MAX_BATCH) {
            self.db_rows_update(chunk.to_vec())?;
        }
        for (after, values) in creates {
            self.db_row_create(RowCreate {
                database_id: db_id.to_owned(),
                values: Some(values),
                after_id: Some(after),
                view_id: None,
                template_id: None,
            })?;
        }
        if has_next_action && !inst.payload.checklist.contains_key("project") {
            self.lifeapp_event("project.next_action_set", &Map::new())?;
        }
        Ok(())
    }

    /// Habits: the `Current streak`, `Best streak` and `30-day rate` columns of every habit.
    fn upkeep_habits(&self, s: &Arc<Session>, inst: &InstanceRow) -> Result<()> {
        let m = manifest_of(&inst.app_id)?;
        let (data, _) = self.metric_data(s, inst, m)?;
        let Some(h) = data.dbs.get("habits") else {
            return Ok(());
        };
        let col = |role: &str, key: &str| {
            h.col(role)
                .or_else(|| h.col(key))
                .filter(|id| {
                    h.props
                        .iter()
                        .any(|p| p.id == *id && p.kind == PropType::Computed)
                })
                .map(str::to_owned)
        };
        let (cur, best, rate) = (
            col("habit.streak", "current_streak"),
            col("habit.best", "best_streak"),
            col("habit.rate30", "rate_30d"),
        );
        let num = |n: f64, display: String| CellValue::Computed {
            v: ComputedValue {
                kind: ComputedKind::Number,
                value: json!(n),
                display,
            },
        };
        let mut updates = Vec::new();
        for c in metrics::habit_columns(&data) {
            if let Some(p) = &cur {
                updates.push((
                    c.row_id.clone(),
                    p.clone(),
                    num(f64::from(c.current), c.current.to_string()),
                ));
            }
            if let Some(p) = &best {
                updates.push((
                    c.row_id.clone(),
                    p.clone(),
                    num(f64::from(c.best), c.best.to_string()),
                ));
            }
            if let Some(p) = &rate {
                let r = (c.rate_30d * 1000.0).round() / 1000.0;
                updates.push((
                    c.row_id.clone(),
                    p.clone(),
                    num(r, format!("{:.0}%", r * 100.0)),
                ));
            }
        }
        let db = h.id.clone();
        self.lifeapp_set_computed(&db, updates)?;
        Ok(())
    }

    /// Writes app-calculated (`computed`) cells of one database in one transaction, skipping cells that already
    /// hold the value (so upkeep settles). Rows keep their "last edited" time. Returns the rows changed.
    pub fn lifeapp_set_computed(
        &self,
        database_id: &str,
        updates: Vec<(String, String, CellValue)>,
    ) -> Result<usize> {
        if updates.is_empty() {
            return Ok(0);
        }
        if updates
            .iter()
            .any(|(_, _, v)| !matches!(v, CellValue::Computed { .. }))
        {
            return Err(StoreError::invalid_field("value", "computed cells only"));
        }
        let s = self.session()?;
        let db = database_id.to_owned();
        let ids = self.write(move |tx| {
            let codec = &s.codec;
            let computed: BTreeSet<String> = load_props(tx, codec, &db, false)?
                .into_iter()
                .filter(|p| p.payload.kind == PropType::Computed)
                .map(|p| p.id)
                .collect();
            let mut by_row: BTreeMap<String, Vec<(String, CellValue)>> = BTreeMap::new();
            for (r, p, v) in updates {
                if computed.contains(&p) {
                    by_row.entry(r).or_default().push((p, v));
                }
            }
            let mut changed = Vec::new();
            for (rid, cells) in by_row {
                let Some((r, rdb, deleted)) = crate::repo::rows::load_row(tx, codec, &rid)? else {
                    continue;
                };
                if rdb != db || deleted.is_some() {
                    continue;
                }
                let mut p = r.payload.clone();
                for (pid, v) in cells {
                    if p.values.get(&pid) != Some(&v) {
                        p.values.insert(pid, v);
                    }
                }
                if p != r.payload {
                    rewrite_row(tx, codec, &rid, r.rev, &p)?;
                    changed.push(rid);
                }
            }
            if !changed.is_empty() {
                bump(tx, &db, false, true)?;
            }
            Ok(changed)
        })?;
        let n = ids.len();
        if n > 0 {
            self.db_changed_rows(database_id, Some(ids));
        }
        Ok(n)
    }

    /// `lifeapp_add_workbook`: a new spreadsheet from a Spreadsheet Studio template (`intent` is a value of the
    /// app's `intent` step other than `import`). It is an ordinary spreadsheet, not part of the app: it goes next to
    /// the Studio hub (top level, or inside the project that holds the hub) and every call makes a new one.
    pub fn lifeapp_add_workbook(&self, instance_id: &str, intent: &str) -> Result<PageMeta> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        if inst.app_id != "spreadsheet-studio" {
            return Err(StoreError::invalid_field(
                "instanceId",
                "not a Spreadsheet Studio app",
            ));
        }
        if inst.payload.detached {
            return Err(StoreError::invalid("this app was detached"));
        }
        let m = manifest_of(&inst.app_id)?;
        let known = m
            .step("intent")
            .and_then(|st| st.options.as_ref())
            .is_some_and(|o| o.iter().any(|o| o.value == intent));
        if !known || intent == "import" {
            return Err(StoreError::invalid_field("intent", "unknown template"));
        }
        let mut answers = inst.payload.answers.clone();
        answers.insert("intent".into(), Value::String(intent.to_owned()));
        // A fresh id namespace: every call builds new page and sheet ids.
        let cx = self.build_ctx(&new_id(), None)?;
        let sel = plan::select(
            m,
            &answers,
            inst.payload.mode,
            &inst.payload.disabled_keys,
            cx.today(),
            None,
        )?;
        let b = build::build(m, &sel, &cx)?;
        let key = format!("wb_{intent}");
        let mut w = b
            .workbooks
            .into_iter()
            .find(|w| w.key == key)
            .ok_or(StoreError::NotFound("template"))?;
        w.page.app_instance_id = None;
        w.page.template_key = None;
        let now = self.now();
        let (sess, ws, root) = (
            Arc::clone(&s),
            inst.workspace_id.clone(),
            inst.payload.root_page_id.clone(),
        );
        let meta = self.write(move |tx| {
            let codec = &sess.codec;
            let parent = match load_page(tx, &root)? {
                Some(r) if r.deleted_at.is_none() => r.parent_id.filter(|p| {
                    load_page(tx, p)
                        .ok()
                        .flatten()
                        .is_some_and(|x| x.deleted_at.is_none())
                }),
                _ => None,
            };
            // "Loan calculator", then "Loan calculator 2", … among its siblings.
            let sibling_ids: Vec<String> = match &parent {
                Some(p) => tx
                    .prepare_cached("SELECT id FROM pages WHERE workspace_id = ?1 AND parent_id = ?2 AND deleted_at IS NULL")?
                    .query_map(params![ws, p], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?,
                None => tx
                    .prepare_cached("SELECT id FROM pages WHERE workspace_id = ?1 AND parent_id IS NULL AND deleted_at IS NULL")?
                    .query_map(params![ws], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?,
            };
            let mut titles = BTreeSet::new();
            for id in sibling_ids {
                if let Some(r) = load_page(tx, &id)?
                    && let Ok(p) = decode_page(codec, &r)
                {
                    titles.insert(p.title);
                }
            }
            let base = w.page.title.clone();
            let mut n = 1;
            while titles.contains(&w.page.title) {
                n += 1;
                w.page.title = format!("{base} {n}");
            }
            let key = position_key(tx, &ws, parent.as_deref(), None, None, None)?;
            w.parent_id.clone_from(&parent);
            wb_insert(tx, codec, &w, &ws, &key, now)?;
            load_meta(tx, codec, &w.id)?.ok_or(StoreError::NotFound("page"))
        })?;
        self.index_page(&s, &meta, None);
        self.emit(StoreEvent::TreeChanged {
            workspace_id: meta.workspace_id.clone(),
            upserted: vec![meta.clone()],
            removed: Vec::new(),
        });
        self.invalidate_metrics(instance_id);
        Ok(meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaps_json_and_cells() {
        let map = BTreeMap::from([("old".to_owned(), "new".to_owned())]);
        let mut v = json!({"filter": {"prop": "p", "value": ["old", "x"]}, "n": 1});
        assert!(remap_strings(&mut v, &map));
        assert_eq!(v["filter"]["value"], json!(["new", "x"]));
        let mut c = CellValue::Multi {
            v: vec!["old".into(), "y".into()],
        };
        assert!(remap_cell(&mut c, &map));
        assert_eq!(
            c,
            CellValue::Multi {
                v: vec!["new".into(), "y".into()]
            }
        );
        let mut c = CellValue::Status {
            v: Some("z".into()),
        };
        assert!(!remap_cell(&mut c, &map));
    }

    #[test]
    fn next_due_follows_the_schedule_and_never_lands_in_the_past() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let rv = |mode| RecurrenceValue {
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            dtstart: "2026-11-02".into(),
            tz: None,
            mode,
        };
        // Due Monday 23rd, completed on Friday 27th: the next Monday.
        assert_eq!(
            next_due(
                &rv(RecurrenceMode::Schedule),
                Some(d("2026-11-23")),
                d("2026-11-27")
            ),
            Some(d("2026-11-30"))
        );
        // Completed on its due day: the following week.
        assert_eq!(
            next_due(
                &rv(RecurrenceMode::Schedule),
                Some(d("2026-11-30")),
                d("2026-11-30")
            ),
            Some(d("2026-12-07"))
        );
        let daily = RecurrenceValue {
            rrule: "FREQ=DAILY".into(),
            dtstart: "2026-01-01".into(),
            tz: None,
            mode: RecurrenceMode::Completion,
        };
        assert_eq!(
            next_due(&daily, Some(d("2026-11-01")), d("2026-11-27")),
            Some(d("2026-11-28"))
        );
    }
}
