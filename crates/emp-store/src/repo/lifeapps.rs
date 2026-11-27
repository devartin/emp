//! Life-app commands (SPEC §11.3 "Life apps", §16.1): catalog, recommendations, preview, one-transaction
//! install, instances, tune-up (diff + apply with conflict handling), detach, uninstall, metrics, insights,
//! muting, sample data, checklist ticks and event-driven auto-ticks.
//!
//! **Instance record** (`lifeapp_instances.payload`): `{v, manifestVersion, answers, mode, disabledKeys, keyMap,
//! touched, muted, detached, rootPageId, checklist, fingerprints, schedules, sampleRows, packId}`. `app_id` and
//! `installed_at` are plaintext columns (documented leakage, §9.20).
//!
//! **Ids** are `UUIDv5(instance_id, key)`, so a rebuild from the stored answers reproduces the ids of everything
//! the app generated; tune-ups compare three fingerprints per record — generated at install, generated now and
//! on disk — to tell user edits (`touched`, reported as conflicts) from app changes.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, LazyLock, Weak};

use emp_crypto::TableTag;
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::codec::{Codec, RecordLoc};
use crate::lifeapps::advisor::{self, Insight};
use crate::lifeapps::answers::{AnswerContext, Mode};
use crate::lifeapps::build::{
    self, Build, BuildCtx, DbRec, ExtraRow, Fingerprints, ReminderSchedule, WbRec, fp,
};
use crate::lifeapps::manifest::{LifeAppManifest, TemplateKind};
use crate::lifeapps::metrics::{self, DbData, MetricData, MetricProvider, MetricValue, RowData};
use crate::lifeapps::plan::{self, GenerationPlan, PlanDiff, PlanItem, PlanUpdate, Selection};
use crate::lifeapps::recommend::{self, Recommendation};
use crate::lifeapps::{self as la, LifeAppSummary, sample};
use crate::model::sort_key::{key_between, n_keys_between};
use crate::model::{PageKind, PageMeta, VersionReason, VersionTargetKind, ids::new_id};
use crate::repo::databases::{db_loc, insert_prop, load_props, load_schema};
use crate::repo::docs::{insert_or_replace_doc, load_doc};
use crate::repo::pages::{
    decode_page, insert_page, load_meta, load_page, position_key, write_payload,
};
use crate::repo::rows::{insert_row, load_rows, save_row_payload};
use crate::repo::versions::insert_version;
use crate::repo::views::{insert_view, load_views};
use crate::vault::{Session, StoreEvent};
use crate::{Progress, Result, Store, StoreError};

// ───────────────────────────────────────────────────────────────────────────── DTOs

/// `lifeapp_preview` request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeappPreview {
    /// App id.
    pub app_id: String,
    /// Answers.
    #[serde(default)]
    pub answers: Map<String, Value>,
    /// Mode.
    pub mode: Mode,
    /// Opted-out template keys.
    #[serde(default)]
    pub disabled_keys: Vec<String>,
}

/// `lifeapp_install` request (the IPC layer strips `onEvent` and passes a [`Progress`]).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeappInstall {
    /// App id.
    pub app_id: String,
    /// Answers.
    #[serde(default)]
    pub answers: Map<String, Value>,
    /// Mode.
    pub mode: Mode,
    /// Opted-out template keys.
    #[serde(default)]
    pub disabled_keys: Vec<String>,
    /// Workspace.
    pub workspace_id: String,
    /// Also add sample data.
    #[serde(default)]
    pub sample_data: bool,
}

/// `lifeapp_install` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    /// New instance.
    pub instance_id: String,
    /// Hub page.
    pub root_page_id: String,
    /// Every created page / database / workbook id.
    pub created: Vec<String>,
}

/// A checklist item of an instance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChecklistState {
    /// Id.
    pub id: String,
    /// Label.
    pub label: String,
    /// Done.
    pub done: bool,
}

/// `LifeAppInstance` (§11.3).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeAppInstance {
    /// Id.
    pub id: String,
    /// App id.
    pub app_id: String,
    /// Manifest version it was installed (or last upgraded) with.
    pub version: String,
    /// Hub page.
    pub root_page_id: String,
    /// Installed at.
    pub installed_at: i64,
    /// A newer manifest is available.
    pub upgrade_available: bool,
    /// Detached.
    pub detached: bool,
    /// Checklist.
    pub checklist: Vec<ChecklistState>,
}

/// `lifeapp_tuneup_apply` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TuneupResult {
    /// Created or changed record ids.
    pub changed: Vec<String>,
}

/// `lifeapp_sample_data` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SampleResult {
    /// Rows added or removed.
    pub rows: usize,
}

/// Stored instance payload.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancePayload {
    /// Payload version.
    pub v: u32,
    /// Manifest version.
    pub manifest_version: String,
    /// Answers the user gave (unresolved).
    #[serde(default)]
    pub answers: Map<String, Value>,
    /// Wizard mode.
    #[serde(default = "quick")]
    pub mode: Mode,
    /// Opted-out keys.
    #[serde(default)]
    pub disabled_keys: Vec<String>,
    /// Record key → id.
    #[serde(default)]
    pub key_map: BTreeMap<String, String>,
    /// Record id → fields the user changed since generation.
    #[serde(default)]
    pub touched: BTreeMap<String, Vec<String>>,
    /// Rule id → muted until (`null` = until unmuted).
    #[serde(default)]
    pub muted: BTreeMap<String, Option<i64>>,
    /// Detached.
    #[serde(default)]
    pub detached: bool,
    /// Hub page.
    pub root_page_id: String,
    /// Item id → done at.
    #[serde(default)]
    pub checklist: BTreeMap<String, i64>,
    /// Fingerprints of the generated records.
    #[serde(default)]
    pub fingerprints: Fingerprints,
    /// Reminder id → re-arming schedule.
    #[serde(default)]
    pub schedules: BTreeMap<String, StoredSchedule>,
    /// Sample row ids.
    #[serde(default)]
    pub sample_rows: Vec<String>,
    /// Pack used for `pack.*`.
    #[serde(default)]
    pub pack_id: Option<String>,
    /// Vault-open upgrade level applied ([`crate::lifeapps::upkeep::UPGRADE_LEVEL`]; 0 = installed before 1.0).
    #[serde(default)]
    pub upgraded: u32,
}

fn quick() -> Mode {
    Mode::Quick
}

/// A recurring reminder's schedule with what it needs to be re-armed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSchedule {
    /// Schedule.
    #[serde(flatten)]
    pub schedule: ReminderSchedule,
    /// Target kind (`page|row`).
    pub target_kind: String,
    /// Target id.
    pub target_id: String,
    /// Text.
    pub text: String,
}

// ───────────────────────────────────────────────────────────────────────────── process-wide registries

static PACKS: LazyLock<RwLock<BTreeMap<String, Value>>> =
    LazyLock::new(|| RwLock::new(BTreeMap::new()));
static PROVIDER: LazyLock<RwLock<Option<Arc<dyn MetricProvider>>>> =
    LazyLock::new(|| RwLock::new(None));

struct CacheEntry {
    session: Weak<Session>,
    instance: String,
    signature: String,
    values: BTreeMap<String, MetricValue>,
}

/// Metric cache: in memory only, tied to the unlocked session (dropped with it).
static METRIC_CACHE: LazyLock<Mutex<Vec<CacheEntry>>> = LazyLock::new(|| Mutex::new(Vec::new()));

const MAX_CACHE: usize = 64;

fn loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(
        TableTag::LifeappInstances,
        id,
        u64::try_from(rev).unwrap_or(0),
    )
}

pub(crate) struct InstanceRow {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) app_id: String,
    pub(crate) installed_at: i64,
    pub(crate) rev: i64,
    pub(crate) payload: InstancePayload,
}

pub(crate) fn load_instance(
    conn: &Connection,
    codec: &Codec,
    id: &str,
) -> Result<Option<InstanceRow>> {
    let raw: Option<(String, String, i64, i64, i64, Vec<u8>)> = conn
        .prepare_cached("SELECT workspace_id, app_id, installed_at, rev, enc, payload FROM lifeapp_instances WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .optional()?;
    raw.map(|(ws, app, at, rev, enc, payload)| {
        Ok(InstanceRow {
            id: id.to_owned(),
            workspace_id: ws,
            app_id: app,
            installed_at: at,
            rev,
            payload: codec.decode(&loc(id, rev), enc, &payload)?,
        })
    })
    .transpose()
}

pub(crate) fn list_instances(
    conn: &Connection,
    codec: &Codec,
    ws: Option<&str>,
) -> Result<Vec<InstanceRow>> {
    let mut st = conn.prepare_cached(
        "SELECT id, workspace_id FROM lifeapp_instances ORDER BY installed_at, id",
    )?;
    let ids: Vec<(String, String)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for (id, w) in ids {
        if ws.is_some_and(|x| x != w) {
            continue;
        }
        match load_instance(conn, codec, &id) {
            Ok(Some(r)) => out.push(r),
            Ok(None) | Err(StoreError::Damaged { .. }) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

pub(crate) fn save_instance(
    tx: &Connection,
    codec: &Codec,
    row: &InstanceRow,
    p: &InstancePayload,
) -> Result<()> {
    let rev = row.rev + 1;
    let e = codec.encode(&loc(&row.id, rev), p)?;
    tx.prepare_cached(
        "UPDATE lifeapp_instances SET rev = ?2, enc = ?3, payload = ?4 WHERE id = ?1",
    )?
    .execute(params![row.id, rev, e.enc, e.payload])?;
    Ok(())
}

pub(crate) fn manifest_of(app_id: &str) -> Result<&'static LifeAppManifest> {
    la::manifest(app_id).ok_or(StoreError::NotFound("life app"))
}

/// Derived pack fields for Tax Organizer: `selectedDocuments` (the pack's document list filtered by the income,
/// event and deduction answers, with `expectedBy` dates in the filing year) and `estimatedPeriods`.
fn derive_pack(pack: &Value, answers: &Map<String, Value>) -> Value {
    let mut p = pack.clone();
    let chips = |k: &str| -> BTreeSet<String> {
        answers
            .get(k)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let (income, events) = (chips("income"), chips("events"));
    let deduction = answers
        .get("deductions")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let matches = |cond: &str| {
        cond.split('|').any(|c| match c.split_once(':') {
            Some(("income", v)) => income.contains(v),
            Some(("event", v)) => events.contains(v),
            Some(("deduction", v)) => deduction == v || deduction == "itemized" && v == "itemized",
            _ => false,
        })
    };
    let year = pack.get("year").and_then(Value::as_i64).unwrap_or(0);
    let expected = pack.get("expectedBy").cloned().unwrap_or(Value::Null);
    let mut docs = Vec::new();
    let mut seen = BTreeSet::new();
    for group in pack
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if !matches(
            group
                .get("when")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) {
            continue;
        }
        for d in group
            .get("docs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let Some(name) = d.as_str() else { continue };
            if !seen.insert(name.to_owned()) {
                continue;
            }
            let by = expected
                .get(name)
                .and_then(Value::as_str)
                .map(|md| format!("{}-{md}", year + 1));
            docs.push(json!({"name": name, "expectedBy": by, "key": crate::lifeapps::metrics::norm(name)}));
        }
    }
    if let Value::Object(o) = &mut p {
        o.insert("selectedDocuments".into(), Value::Array(docs));
        let periods = pack
            .get("estimated")
            .and_then(|e| e.get("periods"))
            .cloned()
            .unwrap_or(Value::Array(Vec::new()));
        o.insert("estimatedPeriods".into(), periods);
    }
    p
}

/// The pack of an instance: `answers` are the user's answers; the pack is derived from them after defaults and
/// recommendations are applied (quick mode leaves most steps unanswered).
pub(crate) fn pack_for(
    m: &LifeAppManifest,
    user: &Map<String, Value>,
    mode: Mode,
    today: chrono::NaiveDate,
) -> (Option<String>, Option<Value>) {
    if m.id != "tax-organizer" {
        return (None, None);
    }
    let resolved = crate::lifeapps::answers::resolve(m, user, mode, today)
        .map(|r| r.answers)
        .unwrap_or_else(|_| user.clone());
    let answers = &resolved;
    let j = answers.get("jurisdiction");
    let country = j
        .and_then(|j| j.get("country"))
        .and_then(Value::as_str)
        .unwrap_or("US")
        .to_lowercase();
    let year = j.and_then(|j| j.get("year")).and_then(Value::as_i64);
    let packs = PACKS.read();
    let pick = |id: &str| packs.get(id).map(|v| (id.to_owned(), v.clone()));
    let found = year
        .and_then(|y| pick(&format!("{country}-federal-{y}")))
        .or_else(|| {
            packs
                .iter()
                .filter(|(_, v)| {
                    v.get("country")
                        .and_then(Value::as_str)
                        .is_some_and(|c| c.eq_ignore_ascii_case(&country))
                })
                .max_by_key(|(_, v)| v.get("year").and_then(Value::as_i64).unwrap_or(0))
                .map(|(k, v)| (k.clone(), v.clone()))
        })
        .or_else(|| pick("generic"));
    match found {
        Some((id, v)) => (Some(id), Some(derive_pack(&v, answers))),
        None => (None, None),
    }
}

// ───────────────────────────────────────────────────────────────────────────── writing builds

fn db_insert(
    tx: &Connection,
    codec: &Codec,
    d: &DbRec,
    ws: &str,
    sort_key: &str,
    now: i64,
) -> Result<()> {
    insert_page(
        tx,
        codec,
        &d.id,
        ws,
        d.parent_id.as_deref(),
        PageKind::Database,
        sort_key,
        &d.page,
        now,
    )?;
    let e = codec.encode(&db_loc(&d.id, 1), &d.db)?;
    tx.prepare_cached("INSERT INTO databases (id, schema_rev, data_rev, rev, enc, payload) VALUES (?1, 1, 1, 1, ?2, ?3)")?
        .execute(params![d.id, e.enc, e.payload])?;
    for p in &d.props {
        insert_prop(tx, codec, &d.id, &p.id, &p.sort_key, &p.payload)?;
    }
    for v in &d.views {
        insert_view(tx, codec, &d.id, &v.id, &v.sort_key, &v.payload)?;
    }
    for r in &d.rows {
        insert_row(tx, codec, &d.id, &r.id, &r.sort_key, &r.payload, now)?;
    }
    Ok(())
}

fn wb_write_rows(tx: &Connection, codec: &Codec, w: &WbRec) -> Result<()> {
    let e = codec.encode(
        &RecordLoc::row(TableTag::Workbooks, &w.id, 1),
        &w.rows.workbook,
    )?;
    tx.prepare_cached(
        "INSERT INTO workbooks (id, rev, enc, payload) VALUES (?1, 1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET rev = workbooks.rev + 1, enc = excluded.enc, payload = excluded.payload",
    )?
    .execute(params![w.id, e.enc, e.payload])?;
    // On rewrite the workbook rev was bumped; re-encode with the stored rev.
    let rev: i64 = tx.query_row("SELECT rev FROM workbooks WHERE id = ?1", [&w.id], |r| {
        r.get(0)
    })?;
    if rev != 1 {
        let e = codec.encode(
            &RecordLoc::row(TableTag::Workbooks, &w.id, u64::try_from(rev).unwrap_or(0)),
            &w.rows.workbook,
        )?;
        tx.prepare_cached("UPDATE workbooks SET enc = ?2, payload = ?3 WHERE id = ?1")?
            .execute(params![w.id, e.enc, e.payload])?;
    }
    for (sid, key, sp) in &w.rows.sheets {
        let e = codec.encode(&RecordLoc::row(TableTag::Sheets, sid, 1), sp)?;
        tx.prepare_cached("INSERT INTO sheets (id, workbook_id, sort_key, rev, enc, payload) VALUES (?1, ?2, ?3, 1, ?4, ?5)")?
            .execute(params![sid, w.id, key, e.enc, e.payload])?;
    }
    for (sid, band, bp) in &w.rows.bands {
        let e = codec.encode(&RecordLoc::sheet_band(sid, *band, 1)?, bp)?;
        tx.prepare_cached("INSERT INTO sheet_bands (sheet_id, band, rev, enc, payload) VALUES (?1, ?2, 1, ?3, ?4)")?
            .execute(params![sid, band, e.enc, e.payload])?;
    }
    Ok(())
}

pub(crate) fn wb_insert(
    tx: &Connection,
    codec: &Codec,
    w: &WbRec,
    ws: &str,
    sort_key: &str,
    now: i64,
) -> Result<()> {
    insert_page(
        tx,
        codec,
        &w.id,
        ws,
        w.parent_id.as_deref(),
        PageKind::Sheet,
        sort_key,
        &w.page,
        now,
    )?;
    wb_write_rows(tx, codec, w)
}

fn reminder_insert(tx: &Connection, codec: &Codec, r: &build::RemRec) -> Result<()> {
    let e = codec.encode(&RecordLoc::row(TableTag::Reminders, &r.id, 1), &r.payload)?;
    tx.prepare_cached(
        "INSERT INTO reminders (id, fire_at, fired_at, rev, enc, payload) VALUES (?1, ?2, NULL, 1, ?3, ?4)",
    )?
    .execute(params![r.id, r.fire_at, e.enc, e.payload])?;
    Ok(())
}

fn schedules_of(b: &Build) -> BTreeMap<String, StoredSchedule> {
    b.reminders
        .iter()
        .filter_map(|r| {
            r.schedule.clone().map(|s| {
                (
                    r.id.clone(),
                    StoredSchedule {
                        schedule: s,
                        target_kind: serde_json::to_value(r.payload.target_kind)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_owned))
                            .unwrap_or_else(|| "page".into()),
                        target_id: r.payload.target_id.clone(),
                        text: r.payload.text.clone(),
                    },
                )
            })
        })
        .collect()
}

/// Writes a whole build (fresh install) with its hub under `root_parent` (top level when `None`). Returns created
/// page ids.
fn write_build(
    tx: &Connection,
    codec: &Codec,
    ws: &str,
    b: &Build,
    root_parent: Option<&str>,
    now: i64,
) -> Result<Vec<String>> {
    // Sort keys: the hub goes after the last page of its parent (or the workspace's last root page); children in
    // manifest order.
    let root_key = position_key(tx, ws, root_parent, None, None, None)?;
    let mut keys: BTreeMap<String, String> = BTreeMap::new();
    for children in b.children.values() {
        for (id, k) in children
            .iter()
            .zip(n_keys_between(None, None, children.len())?)
        {
            keys.insert(id.clone(), k);
        }
    }
    let root_id = b.key_map.get(&b.root_key).cloned();
    let key_of = |id: &str, parent: Option<&String>| -> String {
        if parent.is_none() || root_id.as_deref() == Some(id) {
            root_key.clone()
        } else {
            keys.get(id).cloned().unwrap_or_else(|| "V".into())
        }
    };
    let mut created = Vec::new();
    for p in &b.pages {
        insert_page(
            tx,
            codec,
            &p.id,
            ws,
            p.parent_id.as_deref(),
            p.kind,
            &key_of(&p.id, p.parent_id.as_ref()),
            &p.payload,
            now,
        )?;
        insert_or_replace_doc(tx, codec, &p.id, "page", &p.doc, 1, now)?;
        created.push(p.id.clone());
    }
    for d in &b.dbs {
        db_insert(tx, codec, d, ws, &key_of(&d.id, d.parent_id.as_ref()), now)?;
        created.push(d.id.clone());
    }
    for w in &b.workbooks {
        wb_insert(tx, codec, w, ws, &key_of(&w.id, w.parent_id.as_ref()), now)?;
        created.push(w.id.clone());
    }
    for r in &b.reminders {
        reminder_insert(tx, codec, r)?;
    }
    Ok(created)
}

// ───────────────────────────────────────────────────────────────────────────── on-disk fingerprints

pub(crate) fn disk_fingerprint(
    tx: &Connection,
    codec: &Codec,
    b: &Build,
    id: &str,
) -> Result<Option<BTreeMap<String, String>>> {
    if b.pages.iter().any(|p| p.id == id) || b.workbooks.iter().any(|w| w.id == id) {
        let Some(row) = load_page(tx, id)? else {
            return Ok(None);
        };
        if row.deleted_at.is_some() {
            return Ok(None);
        }
        let payload = decode_page(codec, &row)?;
        if row.kind == "sheet" {
            let mut bands = Vec::new();
            let mut st = tx.prepare_cached("SELECT s.id, b.band, b.rev, b.enc, b.payload FROM sheets s JOIN sheet_bands b ON b.sheet_id = s.id WHERE s.workbook_id = ?1 ORDER BY s.sort_key, s.id, b.band")?;
            let raw: Vec<(String, u32, i64, i64, Vec<u8>)> = st
                .query_map([id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            for (sid, band, rev, enc, p) in raw {
                let bp: crate::repo::workbooks::BandPayload = codec.decode(
                    &RecordLoc::sheet_band(&sid, band, u64::try_from(rev).unwrap_or(0))?,
                    enc,
                    &p,
                )?;
                bands.push((sid, band, bp));
            }
            // Generated order: the build lists sheets in tab order, which is the sort-key order on disk.
            return Ok(Some(fp::workbook(&payload.title, &bands)));
        }
        let doc = load_doc(tx, codec, id)?.map(|d| d.0);
        return Ok(Some(fp::page(&payload.title, doc.as_ref())));
    }
    if let Some(d) = b.dbs.iter().find(|d| d.id == id) {
        let Some(row) = load_page(tx, id)? else {
            return Ok(None);
        };
        if row.deleted_at.is_some() {
            return Ok(None);
        }
        let title = decode_page(codec, &row)?.title;
        let props = load_props(tx, codec, id, false)?;
        let mut gp = Vec::new();
        for p in &d.props {
            if let Some(x) = props.iter().find(|x| x.id == p.id) {
                gp.push((x.id.clone(), x.payload.clone()));
            }
        }
        let views = load_views(tx, codec, id)?;
        let gv: Vec<(String, crate::query::model::ViewPayload)> = d
            .views
            .iter()
            .filter_map(|v| {
                views
                    .iter()
                    .find(|x| x.id == v.id)
                    .map(|x| (x.id.clone(), crate::repo::views::view_payload(x)))
            })
            .collect();
        let pr: Vec<(&str, &crate::query::model::PropertyPayload)> =
            gp.iter().map(|(a, b)| (a.as_str(), b)).collect();
        let vr: Vec<(&str, &crate::query::model::ViewPayload)> =
            gv.iter().map(|(a, b)| (a.as_str(), b)).collect();
        return Ok(Some(fp::database(&title, &pr, &vr)));
    }
    if b.dbs.iter().any(|d| d.rows.iter().any(|r| r.id == id)) {
        let Some((row, _, deleted)) = crate::repo::rows::load_row(tx, codec, id)? else {
            return Ok(None);
        };
        if deleted.is_some() {
            return Ok(None);
        }
        return Ok(Some(fp::row(&row.payload.values)));
    }
    if b.reminders.iter().any(|r| r.id == id) {
        let raw: Option<(i64, i64, i64, Vec<u8>)> = tx
            .prepare_cached("SELECT fire_at, rev, enc, payload FROM reminders WHERE id = ?1")?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?;
        let Some((fire_at, rev, enc, payload)) = raw else {
            return Ok(None);
        };
        let p: crate::repo::reminders::ReminderPayload = codec.decode(
            &RecordLoc::row(TableTag::Reminders, id, u64::try_from(rev).unwrap_or(0)),
            enc,
            &payload,
        )?;
        return Ok(Some(fp::reminder(&p.text, fire_at)));
    }
    Ok(None)
}

/// One record's comparison for a tune-up.
struct Change {
    key: String,
    id: String,
    fields: Vec<String>,
    conflict: bool,
}

struct Diff {
    add: Vec<String>,
    changes: Vec<Change>,
    keep: Vec<String>,
    touched: BTreeMap<String, Vec<String>>,
}

fn record_ids(b: &Build) -> Vec<(String, String)> {
    let mut v = Vec::new();
    for p in &b.pages {
        v.push((p.key.clone(), p.id.clone()));
    }
    for d in &b.dbs {
        v.push((d.key.clone(), d.id.clone()));
        for r in &d.rows {
            v.push((r.key.clone(), r.id.clone()));
        }
    }
    for w in &b.workbooks {
        v.push((w.key.clone(), w.id.clone()));
    }
    for r in &b.reminders {
        v.push((format!("reminder:{}", r.key), r.id.clone()));
    }
    v
}

fn diff(tx: &Connection, codec: &Codec, inst: &InstancePayload, b: &Build) -> Result<Diff> {
    let new_fp = b.fingerprints();
    let mut out = Diff {
        add: Vec::new(),
        changes: Vec::new(),
        keep: Vec::new(),
        touched: inst.touched.clone(),
    };
    for (key, id) in record_ids(b) {
        let Some(disk) = disk_fingerprint(tx, codec, b, &id)? else {
            // Never generated, or deleted by the user: deleted records are only re-created when they are new.
            if !inst.fingerprints.contains_key(&id) {
                out.add.push(key);
            }
            continue;
        };
        let generated = inst.fingerprints.get(&id).cloned().unwrap_or_default();
        let fresh = new_fp.get(&id).cloned().unwrap_or_default();
        let touched: Vec<String> = generated
            .iter()
            .filter(|(f, h)| disk.get(*f).is_some_and(|d| d != *h))
            .map(|(f, _)| f.clone())
            .collect();
        if !touched.is_empty() {
            out.touched.insert(id.clone(), touched.clone());
        }
        let changed: Vec<String> = fresh
            .iter()
            .filter(|(f, h)| disk.get(*f) != Some(*h))
            .map(|(f, _)| f.clone())
            .collect();
        // Only fields the app itself changes count; a field the user edited and the app did not change is kept.
        let app_changed: Vec<String> = changed
            .into_iter()
            .filter(|f| generated.get(f) != fresh.get(f))
            .collect();
        if app_changed.is_empty() {
            out.keep.push(key);
        } else {
            let conflict = app_changed.iter().any(|f| touched.contains(f));
            out.changes.push(Change {
                key,
                id,
                fields: app_changed,
                conflict,
            });
        }
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────────────── Store API

/// `{ value, why, source }` of `lifeapp_recommend`.
pub type RecommendResult = Recommendation;

impl Store {
    pub(crate) fn build_ctx(&self, instance_id: &str, pack: Option<Value>) -> Result<BuildCtx> {
        let vs = self.vault_settings()?;
        Ok(BuildCtx {
            instance_id: instance_id.to_owned(),
            now_ms: self.now(),
            tz: vs.timezone.parse().unwrap_or(chrono_tz::UTC),
            currency: vs.base_currency.clone(),
            pack,
        })
    }

    /// Today in the vault's time zone.
    pub(crate) fn local_today(&self) -> Result<chrono::NaiveDate> {
        Ok(self
            .build_ctx("00000000-0000-0000-0000-000000000000", None)?
            .today())
    }

    /// Registers a pack (e.g. the `emp-finance` tax packs, by id such as `us-federal-2026`) for `pack.*`.
    pub fn lifeapps_register_pack(&self, id: &str, pack: Value) {
        PACKS.write().insert(id.to_owned(), pack);
    }

    /// Registers the app's metric implementations (they win over the built-ins they return `Some` for).
    pub fn lifeapps_set_metric_provider(&self, provider: Option<Arc<dyn MetricProvider>>) {
        *PROVIDER.write() = provider;
        METRIC_CACHE.lock().clear();
    }

    /// `lifeapp_list`: the catalog with installed counts (in `workspace_id`, or overall).
    pub fn lifeapp_list(&self, workspace_id: Option<&str>) -> Result<Vec<LifeAppSummary>> {
        let counts: BTreeMap<String, u32> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT app_id, workspace_id FROM lifeapp_instances")?;
            let rows: Vec<(String, String)> = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let mut m = BTreeMap::new();
            for (a, w) in rows {
                if workspace_id.is_none_or(|x| x == w) {
                    *m.entry(a).or_default() += 1;
                }
            }
            Ok(m)
        })?;
        Ok(la::catalog()
            .iter()
            .map(|m| LifeAppSummary::of(m, counts.get(&m.id).copied().unwrap_or(0)))
            .collect())
    }

    /// `lifeapp_manifest`.
    pub fn lifeapp_manifest(&self, id: &str) -> Result<LifeAppManifest> {
        manifest_of(id).cloned()
    }

    /// `lifeapp_recommend`.
    pub fn lifeapp_recommend(
        &self,
        app_id: &str,
        step_id: &str,
        answers: &Map<String, Value>,
    ) -> Result<Recommendation> {
        let m = manifest_of(app_id)?;
        let step = m.step(step_id).ok_or(StoreError::NotFound("step"))?;
        let r = step.recommend.as_deref().ok_or_else(|| {
            StoreError::invalid_field("stepId", "this step has no recommendation")
        })?;
        crate::lifeapps::answers::check_answers(answers)?;
        recommend::run(r, answers, self.build_ctx(&new_id(), None)?.today())
            .ok_or(StoreError::NotFound("recommender"))
    }

    /// `lifeapp_preview` (pure: nothing is written).
    pub fn lifeapp_preview(&self, req: &LifeappPreview) -> Result<GenerationPlan> {
        let m = manifest_of(&req.app_id)?;
        let (_, pack) = pack_for(m, &req.answers, req.mode, self.local_today()?);
        let cx = self.build_ctx("00000000-0000-0000-0000-000000000000", pack)?;
        let mut p = plan::plan(m, &req.answers, req.mode, &req.disabled_keys, &cx)?;
        if m.sensitivity == crate::lifeapps::manifest::Sensitivity::High && !self.is_encrypted()? {
            p.warnings
                .push("This data is sensitive — turn on encryption?".into());
        }
        Ok(p)
    }

    /// `lifeapp_install` (job): applies the plan in one transaction and returns the new instance.
    pub fn lifeapp_install(
        &self,
        req: &LifeappInstall,
        progress: &dyn Progress,
    ) -> Result<InstallResult> {
        self.lifeapp_install_in(req, None, progress)
    }

    /// The attached (not detached) instance of `app_id` in `workspace_id`, if any. One instance per app and
    /// workspace is the rule (Ultranote 1.0 brief §2.2); [`Self::lifeapp_install_in`] refuses a second one.
    pub fn lifeapp_installed(&self, workspace_id: &str, app_id: &str) -> Result<Option<String>> {
        let s = self.session()?;
        let rows = self.read(|c| list_instances(c, &s.codec, Some(workspace_id)))?;
        Ok(rows
            .into_iter()
            .find(|r| r.app_id == app_id && !r.payload.detached)
            .map(|r| r.id))
    }

    /// [`Self::lifeapp_install`] with the hub page created under `parent_id` (a live `doc` page of the same
    /// workspace, e.g. a project) instead of at the top level. A second attached instance of the same app in the
    /// workspace is refused with `CONFLICT` (the IPC layer words it "… is already set up").
    pub fn lifeapp_install_in(
        &self,
        req: &LifeappInstall,
        parent_id: Option<&str>,
        progress: &dyn Progress,
    ) -> Result<InstallResult> {
        let m = manifest_of(&req.app_id)?;
        if self.lifeapp_installed(&req.workspace_id, &m.id)?.is_some() {
            return Err(StoreError::Conflict { current_rev: 0 });
        }
        let s = self.session()?;
        let instance_id = new_id();
        let (pack_id, pack) = pack_for(m, &req.answers, req.mode, self.local_today()?);
        let cx = self.build_ctx(&instance_id, pack)?;
        progress.progress(0, 3, "Planning");
        let sel = plan::select(
            m,
            &req.answers,
            req.mode,
            &req.disabled_keys,
            cx.today(),
            cx.pack.as_ref(),
        )?;
        let extra = if req.sample_data {
            sample::generate(&m.sample.generator, m.sample.seed, cx.today())
        } else {
            Vec::new()
        };
        let b = build::build_with(m, &sel, &cx, &extra)?;
        if progress.cancelled() {
            return Err(StoreError::Cancelled);
        }
        progress.progress(1, 3, "Creating");
        let root_page_id = b
            .key_map
            .get(&b.root_key)
            .cloned()
            .ok_or_else(|| StoreError::Internal("no hub page".into()))?;
        let sample_rows: Vec<String> = b
            .dbs
            .iter()
            .flat_map(|d| {
                d.rows
                    .iter()
                    .filter(|r| r.source == "sample")
                    .map(|r| r.id.clone())
            })
            .collect();
        let payload = InstancePayload {
            v: 1,
            manifest_version: m.version.clone(),
            answers: req.answers.clone(),
            mode: req.mode,
            disabled_keys: req.disabled_keys.clone(),
            key_map: b.key_map.clone(),
            touched: BTreeMap::new(),
            muted: BTreeMap::new(),
            detached: false,
            root_page_id: root_page_id.clone(),
            checklist: BTreeMap::new(),
            fingerprints: b.fingerprints(),
            schedules: schedules_of(&b),
            sample_rows,
            pack_id,
            upgraded: crate::lifeapps::upkeep::UPGRADE_LEVEL,
        };
        let now = self.now();
        let ws = req.workspace_id.clone();
        let app_id = m.id.clone();
        let (iid, sess) = (instance_id.clone(), Arc::clone(&s));
        let mut b2 = b.clone();
        let parent = parent_id.map(str::to_owned);
        if let Some(p) = &parent
            && let Some(root) = b2.pages.iter_mut().find(|p| p.key == b2.root_key)
        {
            root.parent_id = Some(p.clone());
        }
        let (created, metas) = self.write(move |tx| {
            let codec = &sess.codec;
            let ok: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)", [&ws], |r| r.get(0))?;
            if !ok {
                return Err(StoreError::NotFound("workspace"));
            }
            if let Some(pid) = &parent {
                let row = load_page(tx, pid)?.ok_or(StoreError::NotFound("parent page"))?;
                if row.deleted_at.is_some() || row.workspace_id != ws {
                    return Err(StoreError::NotFound("parent page"));
                }
                if row.kind != "doc" {
                    return Err(StoreError::invalid_field("parentId", "apps can only be added to documents and projects"));
                }
                let app_parent = decode_page(codec, &row)?.app_instance_id.is_some();
                if app_parent {
                    return Err(StoreError::invalid_field("parentId", "apps can't be added inside another app"));
                }
            }
            // One attached instance per app and workspace, checked again inside the write.
            for other in list_instances(tx, codec, Some(&ws))? {
                if other.app_id == app_id && !other.payload.detached {
                    return Err(StoreError::Conflict { current_rev: 0 });
                }
            }
            let created = write_build(tx, codec, &ws, &b2, parent.as_deref(), now)?;
            let e = codec.encode(&loc(&iid, 1), &payload)?;
            tx.prepare_cached("INSERT INTO lifeapp_instances (id, workspace_id, app_id, installed_at, rev, enc, payload) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)")?
                .execute(params![iid, ws, app_id, now, e.enc, e.payload])?;
            let metas: Vec<PageMeta> = created.iter().filter_map(|id| load_meta(tx, codec, id).ok().flatten()).collect();
            let parent_meta = match &parent {
                Some(pid) => load_meta(tx, codec, pid)?,
                None => None,
            };
            Ok((created, (metas, parent_meta)))
        })?;
        let (metas, parent_meta) = metas;
        progress.progress(2, 3, "Indexing");
        self.after_write(&s, &b, &metas);
        if let Some(pm) = parent_meta {
            // The parent gained a child: re-announce it so trees update its disclosure.
            self.emit(StoreEvent::TreeChanged {
                workspace_id: pm.workspace_id.clone(),
                upserted: vec![pm],
                removed: Vec::new(),
            });
        }
        progress.progress(3, 3, "Done");
        Ok(InstallResult {
            instance_id,
            root_page_id,
            created,
        })
    }

    pub(crate) fn after_write(&self, s: &Arc<Session>, b: &Build, metas: &[PageMeta]) {
        for meta in metas {
            let doc = b.pages.iter().find(|p| p.id == meta.id).map(|p| &p.doc);
            self.index_page(s, meta, doc);
        }
        let _ = self.db_index_rows();
        if let Some(ws) = metas.first().map(|m| m.workspace_id.clone()) {
            self.emit(StoreEvent::TreeChanged {
                workspace_id: ws,
                upserted: metas.to_vec(),
                removed: Vec::new(),
            });
        }
        for d in &b.dbs {
            self.db_changed(&d.id);
        }
    }

    /// `lifeapp_instances`.
    pub fn lifeapp_instances(&self, workspace_id: &str) -> Result<Vec<LifeAppInstance>> {
        let s = self.session()?;
        let rows = self.read(|c| list_instances(c, &s.codec, Some(workspace_id)))?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let m = la::manifest(&r.app_id)?;
                Some(LifeAppInstance {
                    id: r.id.clone(),
                    app_id: r.app_id.clone(),
                    version: r.payload.manifest_version.clone(),
                    root_page_id: r.payload.root_page_id.clone(),
                    installed_at: r.installed_at,
                    upgrade_available: la::version_lt(&r.payload.manifest_version, &m.version),
                    detached: r.payload.detached,
                    checklist: m
                        .checklist
                        .iter()
                        .map(|c| ChecklistState {
                            id: c.id.clone(),
                            label: c.label.clone(),
                            done: r.payload.checklist.contains_key(&c.id),
                        })
                        .collect(),
                })
            })
            .collect())
    }

    /// The record key → id map of an installed instance (`"accounts"` → database id, `"accounts:checking"` → row
    /// id, …), so callers find generated databases, pages and rows exactly instead of matching titles.
    pub fn lifeapp_key_map(&self, instance_id: &str) -> Result<BTreeMap<String, String>> {
        let s = self.session()?;
        Ok(self.instance(&s, instance_id)?.payload.key_map)
    }

    /// The wizard answers of an installed instance, resolved the way generation saw them: the user's answers,
    /// then step defaults and recommendations for the steps they skipped (Quick mode).
    pub fn lifeapp_answers(&self, instance_id: &str) -> Result<Map<String, Value>> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        let m = la::manifest(&inst.app_id).ok_or(StoreError::NotFound("life app"))?;
        let today = self.local_today()?;
        Ok(
            crate::lifeapps::answers::resolve(m, &inst.payload.answers, inst.payload.mode, today)?
                .answers,
        )
    }

    /// The answers exactly as the user gave them (no defaults), as the tune-up wizard pre-fills them.
    pub fn lifeapp_raw_answers(&self, instance_id: &str) -> Result<Map<String, Value>> {
        let s = self.session()?;
        Ok(self.instance(&s, instance_id)?.payload.answers)
    }

    pub(crate) fn instance(&self, s: &Arc<Session>, id: &str) -> Result<InstanceRow> {
        self.read(|c| load_instance(c, &s.codec, id))?
            .ok_or(StoreError::NotFound("life app instance"))
    }

    pub(crate) fn rebuild(
        &self,
        inst: &InstanceRow,
        answers: &Map<String, Value>,
    ) -> Result<(Selection, Build, &'static LifeAppManifest, BuildCtx)> {
        let m = manifest_of(&inst.app_id)?;
        let (_, pack) = pack_for(m, answers, inst.payload.mode, self.local_today()?);
        let cx = self.build_ctx(&inst.id, pack)?;
        let sel = plan::select(
            m,
            answers,
            inst.payload.mode,
            &inst.payload.disabled_keys,
            cx.today(),
            cx.pack.as_ref(),
        )?;
        let b = build::build(m, &sel, &cx)?;
        Ok((sel, b, m, cx))
    }

    /// `lifeapp_tuneup_preview`: what re-running the wizard with `answers` would change.
    pub fn lifeapp_tuneup_preview(
        &self,
        instance_id: &str,
        answers: &Map<String, Value>,
    ) -> Result<PlanDiff> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        if inst.payload.detached {
            return Err(StoreError::invalid("this app was detached"));
        }
        let (sel, b, _, _) = self.rebuild(&inst, answers)?;
        let d = self.read(|c| diff(c, &s.codec, &inst.payload, &b))?;
        let add: Vec<PlanItem> = sel
            .items
            .iter()
            .filter(|i| i.enabled && d.add.contains(&i.key))
            .cloned()
            .chain(
                d.add
                    .iter()
                    .filter(|k| !sel.items.iter().any(|i| &i.key == *k) && k.contains(".row:"))
                    .map(|k| PlanItem {
                        key: k.clone(),
                        kind: "row".into(),
                        title: k.split(".row:").nth(1).unwrap_or_default().to_owned(),
                        parent_key: k.split(".row:").next().map(str::to_owned),
                        optional: false,
                        enabled: true,
                        count: None,
                    }),
            )
            .collect();
        Ok(PlanDiff {
            add,
            update: d
                .changes
                .iter()
                .map(|c| PlanUpdate {
                    key: c.key.clone(),
                    fields: c.fields.clone(),
                    conflict: c.conflict,
                })
                .collect(),
            keep: d.keep,
        })
    }

    /// `lifeapp_tuneup_apply` (job): creates new records and updates changed ones. Conflicting records (fields the
    /// user edited) are only overwritten when their key is in `accept_conflicts`; pages get a `pre_lifeapp`
    /// version first.
    pub fn lifeapp_tuneup_apply(
        &self,
        instance_id: &str,
        answers: &Map<String, Value>,
        accept_conflicts: &[String],
        progress: &dyn Progress,
    ) -> Result<TuneupResult> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        if inst.payload.detached {
            return Err(StoreError::invalid("this app was detached"));
        }
        let (_, b, _, _) = self.rebuild(&inst, answers)?;
        progress.progress(0, 2, "Comparing");
        let now = self.now();
        let accept: BTreeSet<String> = accept_conflicts.iter().cloned().collect();
        let answers = answers.clone();
        let sess = Arc::clone(&s);
        let b2 = b.clone();
        let (changed, metas, wb_changed) = self.write(move |tx| {
            let codec = &sess.codec;
            let d = diff(tx, codec, &inst.payload, &b2)?;
            let mut changed = Vec::new();
            let mut wb_changed = false;
            let mut fps = inst.payload.fingerprints.clone();
            let new_fp = b2.fingerprints();
            let add: BTreeSet<&str> = d.add.iter().map(String::as_str).collect();
            // Additions: whole records, rows of existing databases, views, reminders.
            for p in b2.pages.iter().filter(|p| add.contains(p.key.as_str())) {
                let parent = p.parent_id.clone().filter(|pid| load_page(tx, pid).ok().flatten().is_some_and(|r| r.deleted_at.is_none())).or_else(|| Some(inst.payload.root_page_id.clone()));
                let key = position_key(tx, &inst.workspace_id, parent.as_deref(), None, None, None)?;
                insert_page(tx, codec, &p.id, &inst.workspace_id, parent.as_deref(), p.kind, &key, &p.payload, now)?;
                insert_or_replace_doc(tx, codec, &p.id, "page", &p.doc, 1, now)?;
                changed.push(p.id.clone());
            }
            for db in &b2.dbs {
                if add.contains(db.key.as_str()) {
                    let parent = db.parent_id.clone().or_else(|| Some(inst.payload.root_page_id.clone()));
                    let key = position_key(tx, &inst.workspace_id, parent.as_deref(), None, None, None)?;
                    let mut d2 = db.clone();
                    d2.parent_id = parent;
                    db_insert(tx, codec, &d2, &inst.workspace_id, &key, now)?;
                    changed.push(db.id.clone());
                    continue;
                }
                if load_page(tx, &db.id)?.is_none_or(|r| r.deleted_at.is_some()) {
                    continue;
                }
                // Additive schema: missing properties and views.
                let props = load_props(tx, codec, &db.id, true)?;
                let mut last = props.iter().map(|p| p.sort_key.clone()).max();
                let mut schema_changed = false;
                for p in &db.props {
                    if !props.iter().any(|x| x.id == p.id) {
                        let k = key_between(last.as_deref(), None)?;
                        insert_prop(tx, codec, &db.id, &p.id, &k, &p.payload)?;
                        last = Some(k);
                        schema_changed = true;
                    }
                }
                let views = load_views(tx, codec, &db.id)?;
                let mut vlast = views.iter().map(|v| v.sort_key.clone()).max();
                for v in &db.views {
                    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM db_views WHERE id = ?1)", [&v.id], |r| r.get(0))?;
                    if !exists {
                        let k = key_between(vlast.as_deref(), None)?;
                        insert_view(tx, codec, &db.id, &v.id, &k, &v.payload)?;
                        vlast = Some(k);
                        schema_changed = true;
                    }
                }
                let rows = load_rows(tx, codec, &db.id)?;
                let mut rlast = rows.iter().map(|r| r.sort_key.clone()).max();
                let mut data_changed = false;
                for r in db.rows.iter().filter(|r| add.contains(r.key.as_str())) {
                    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM db_rows WHERE id = ?1)", [&r.id], |x| x.get(0))?;
                    if exists {
                        continue;
                    }
                    let k = key_between(rlast.as_deref(), None)?;
                    insert_row(tx, codec, &db.id, &r.id, &k, &r.payload, now)?;
                    rlast = Some(k);
                    data_changed = true;
                    changed.push(r.id.clone());
                }
                if schema_changed || data_changed {
                    crate::repo::databases::bump(tx, &db.id, schema_changed, data_changed)?;
                    if schema_changed {
                        changed.push(db.id.clone());
                    }
                }
            }
            for w in b2.workbooks.iter().filter(|w| add.contains(w.key.as_str())) {
                let parent = w.parent_id.clone().or_else(|| Some(inst.payload.root_page_id.clone()));
                let key = position_key(tx, &inst.workspace_id, parent.as_deref(), None, None, None)?;
                let mut w2 = w.clone();
                w2.parent_id = parent;
                wb_insert(tx, codec, &w2, &inst.workspace_id, &key, now)?;
                changed.push(w.id.clone());
            }
            for r in b2.reminders.iter().filter(|r| add.contains(format!("reminder:{}", r.key).as_str())) {
                reminder_insert(tx, codec, r)?;
                changed.push(r.id.clone());
            }
            // Updates.
            for c in &d.changes {
                if c.conflict && !accept.contains(&c.key) {
                    continue;
                }
                if let Some(p) = b2.pages.iter().find(|p| p.id == c.id) {
                    let row = load_page(tx, &p.id)?.ok_or(StoreError::NotFound("page"))?;
                    let mut payload = decode_page(codec, &row)?;
                    if c.fields.iter().any(|f| f == "title") {
                        payload.title.clone_from(&p.payload.title);
                        write_payload(tx, codec, &row, &payload, row.rev + 1, now)?;
                    }
                    if c.fields.iter().any(|f| f == "content") {
                        let cur = load_doc(tx, codec, &p.id)?;
                        let rev = cur.as_ref().map_or(0, |x| x.1);
                        if let Some((doc, _)) = cur {
                            insert_version(tx, codec, &p.id, VersionTargetKind::PageDoc, VersionReason::PreLifeapp, Some("Before tune-up".into()), &serde_json::to_value(&doc)?, now)?;
                        }
                        insert_or_replace_doc(tx, codec, &p.id, "page", &p.doc, rev + 1, now)?;
                    }
                } else if let Some(db) = b2.dbs.iter().find(|d| d.id == c.id) {
                    if c.fields.iter().any(|f| f == "title") {
                        let row = load_page(tx, &db.id)?.ok_or(StoreError::NotFound("page"))?;
                        let mut payload = decode_page(codec, &row)?;
                        payload.title.clone_from(&db.page.title);
                        write_payload(tx, codec, &row, &payload, row.rev + 1, now)?;
                    }
                } else if let Some((db, r)) = b2.dbs.iter().find_map(|d| d.rows.iter().find(|r| r.id == c.id).map(|r| (d, r))) {
                    if let Some((cur, _, _)) = crate::repo::rows::load_row(tx, codec, &r.id)? {
                        let mut p = cur.payload.clone();
                        for (k, v) in &r.payload.values {
                            p.values.insert(k.clone(), v.clone());
                        }
                        save_row_payload(tx, codec, &r.id, cur.rev, &p, now)?;
                        crate::repo::databases::bump(tx, &db.id, false, true)?;
                    }
                } else if let Some(w) = b2.workbooks.iter().find(|w| w.id == c.id) {
                    tx.prepare_cached("DELETE FROM sheets WHERE workbook_id = ?1")?.execute([&w.id])?;
                    wb_write_rows(tx, codec, w)?;
                    wb_changed = true;
                } else if let Some(r) = b2.reminders.iter().find(|r| r.id == c.id) {
                    let rev: i64 = tx.query_row("SELECT rev FROM reminders WHERE id = ?1", [&r.id], |x| x.get(0))?;
                    let e = codec.encode(&RecordLoc::row(TableTag::Reminders, &r.id, u64::try_from(rev + 1).unwrap_or(0)), &r.payload)?;
                    tx.prepare_cached("UPDATE reminders SET fire_at = ?2, fired_at = NULL, rev = ?3, enc = ?4, payload = ?5 WHERE id = ?1")?
                        .execute(params![r.id, r.fire_at, rev + 1, e.enc, e.payload])?;
                }
                if let Some(f) = new_fp.get(&c.id) {
                    fps.insert(c.id.clone(), f.clone());
                }
                changed.push(c.id.clone());
            }
            for id in changed.iter() {
                if let Some(f) = new_fp.get(id) {
                    fps.insert(id.clone(), f.clone());
                }
            }
            let mut p = inst.payload.clone();
            p.answers = answers;
            for (k, v) in &b2.key_map {
                p.key_map.insert(k.clone(), v.clone());
            }
            p.fingerprints = fps;
            p.touched = d.touched;
            for id in &changed {
                if accept.iter().any(|k| b2.key_map.get(k) == Some(id) || d.changes.iter().any(|c| &c.key == k && &c.id == id)) {
                    p.touched.remove(id);
                }
            }
            for (k, v) in schedules_of(&b2) {
                p.schedules.insert(k, v);
            }
            p.manifest_version = manifest_of(&inst.app_id)?.version.clone();
            save_instance(tx, codec, &inst, &p)?;
            changed.sort();
            changed.dedup();
            let metas: Vec<PageMeta> = changed.iter().filter_map(|id| load_meta(tx, codec, id).ok().flatten()).collect();
            Ok((changed, metas, wb_changed))
        })?;
        if wb_changed {
            crate::repo::workbooks::prune_engines(true);
        }
        progress.progress(1, 2, "Indexing");
        self.after_write(&s, &b, &metas);
        self.invalidate_metrics(instance_id);
        progress.progress(2, 2, "Done");
        Ok(TuneupResult { changed })
    }

    fn strip_app(
        tx: &Transaction<'_>,
        codec: &Codec,
        p: &InstancePayload,
        instance_id: &str,
        now: i64,
    ) -> Result<Vec<String>> {
        let mut out = Vec::new();
        let mut ids: BTreeSet<&String> = p.key_map.values().collect();
        ids.insert(&p.root_page_id);
        for id in ids {
            let Some(row) = load_page(tx, id)? else {
                continue;
            };
            let mut payload = decode_page(codec, &row)?;
            if payload.app_instance_id.as_deref() == Some(instance_id) {
                payload.app_instance_id = None;
                write_payload(tx, codec, &row, &payload, row.rev + 1, now)?;
                out.push(row.id.clone());
            }
        }
        Ok(out)
    }

    /// `lifeapp_detach`: generated content becomes ordinary content; metrics, insights and tune-ups stop.
    pub fn lifeapp_detach(&self, instance_id: &str) -> Result<()> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        let now = self.now();
        let (sess, iid) = (Arc::clone(&s), instance_id.to_owned());
        let metas = self.write(move |tx| {
            let codec = &sess.codec;
            let stripped = Self::strip_app(tx, codec, &inst.payload, &iid, now)?;
            let mut p = inst.payload.clone();
            p.detached = true;
            save_instance(tx, codec, &inst, &p)?;
            Ok(stripped
                .iter()
                .filter_map(|id| load_meta(tx, codec, id).ok().flatten())
                .collect::<Vec<_>>())
        })?;
        self.invalidate_metrics(instance_id);
        if let Some(ws) = metas.first().map(|m| m.workspace_id.clone()) {
            self.emit(StoreEvent::TreeChanged {
                workspace_id: ws,
                upserted: metas,
                removed: Vec::new(),
            });
        }
        Ok(())
    }

    /// `lifeapp_uninstall`: removes the instance and its reminders. With `keep_content` the generated pages stay
    /// (as ordinary pages); otherwise they move to the trash (restorable for the trash retention period). This is
    /// also the "Undo {App} setup" action.
    pub fn lifeapp_uninstall(&self, instance_id: &str, keep_content: bool) -> Result<()> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        let now = self.now();
        let (sess, iid) = (Arc::clone(&s), instance_id.to_owned());
        let p = inst.payload.clone();
        let metas = self.write(move |tx| {
            let codec = &sess.codec;
            let stripped = if keep_content {
                Self::strip_app(tx, codec, &p, &iid, now)?
            } else {
                Vec::new()
            };
            for (k, id) in &p.key_map {
                if k.starts_with("reminder:") {
                    tx.prepare_cached("DELETE FROM reminders WHERE id = ?1")?
                        .execute([id])?;
                }
            }
            tx.prepare_cached("DELETE FROM lifeapp_instances WHERE id = ?1")?
                .execute([&iid])?;
            Ok(stripped
                .iter()
                .filter_map(|id| load_meta(tx, codec, id).ok().flatten())
                .collect::<Vec<_>>())
        })?;
        self.invalidate_metrics(instance_id);
        if keep_content {
            if let Some(ws) = metas.first().map(|m| m.workspace_id.clone()) {
                self.emit(StoreEvent::TreeChanged {
                    workspace_id: ws,
                    upserted: metas,
                    removed: Vec::new(),
                });
            }
        } else {
            let tops: Vec<String> = self.read(|c| {
                let mut out = Vec::new();
                for id in inst
                    .payload
                    .key_map
                    .values()
                    .chain(std::iter::once(&inst.payload.root_page_id))
                {
                    if let Some(r) = load_page(c, id)?
                        && r.deleted_at.is_none()
                        && r.parent_id
                            .as_ref()
                            .is_none_or(|pid| !inst.payload.key_map.values().any(|v| v == pid))
                    {
                        out.push(r.id);
                    }
                }
                out.sort();
                out.dedup();
                Ok(out)
            })?;
            self.page_delete(&tops)?;
        }
        Ok(())
    }

    pub(crate) fn invalidate_metrics(&self, instance_id: &str) {
        METRIC_CACHE.lock().retain(|e| e.instance != instance_id);
    }

    /// Loads everything metric functions read for an instance.
    pub(crate) fn metric_data(
        &self,
        s: &Arc<Session>,
        inst: &InstanceRow,
        m: &LifeAppManifest,
    ) -> Result<(MetricData, String)> {
        let cx = self.build_ctx(&inst.id, None)?;
        let resolved = crate::lifeapps::answers::resolve(
            m,
            &inst.payload.answers,
            inst.payload.mode,
            cx.today(),
        )?;
        let (_, pack) = pack_for(
            m,
            &inst.payload.answers,
            inst.payload.mode,
            self.local_today()?,
        );
        let db_keys: Vec<String> = m
            .templates
            .iter()
            .filter(|t| t.kind == TemplateKind::Database)
            .map(|t| t.key.clone())
            .collect();
        let key_map = inst.payload.key_map.clone();
        let mut signature = format!("{}|{}", cx.today(), cx.now_ms / 60_000);
        let load = |c: &Connection,
                    km: &BTreeMap<String, String>,
                    keys: &[String],
                    sig: &mut String|
         -> Result<BTreeMap<String, DbData>> {
            let mut out = BTreeMap::new();
            for k in keys {
                let Some(id) = km.get(k) else { continue };
                let Some(row) = load_page(c, id)? else {
                    continue;
                };
                if row.deleted_at.is_some() {
                    continue;
                }
                let schema = load_schema(c, &s.codec, id)?;
                sig.push_str(&format!(
                    "|{id}:{}:{}",
                    schema.database.schema_rev, schema.database.data_rev
                ));
                let prefix = format!("{k}.prop:");
                let by_key = km
                    .iter()
                    .filter_map(|(kk, v)| {
                        kk.strip_prefix(&prefix).map(|p| (p.to_owned(), v.clone()))
                    })
                    .collect();
                let rows = load_rows(c, &s.codec, id)?
                    .into_iter()
                    .map(|r| RowData {
                        id: r.id,
                        values: r.payload.values,
                        created_at: r.created_at,
                    })
                    .collect();
                out.insert(
                    k.clone(),
                    DbData {
                        id: id.clone(),
                        props: schema.properties,
                        by_key,
                        roles: schema.database.roles,
                        rows,
                    },
                );
            }
            Ok(out)
        };
        let needs_others = m
            .metrics
            .iter()
            .any(|x| x.func.as_deref() == Some("tax.taxes_fund"));
        let (dbs, others) = self.read(|c| {
            let dbs = load(c, &key_map, &db_keys, &mut signature)?;
            let mut others = BTreeMap::new();
            if needs_others {
                for o in list_instances(c, &s.codec, Some(&inst.workspace_id))? {
                    if o.id == inst.id || o.payload.detached {
                        continue;
                    }
                    let Some(om) = la::manifest(&o.app_id) else {
                        continue;
                    };
                    let keys: Vec<String> = om
                        .templates
                        .iter()
                        .filter(|t| t.kind == TemplateKind::Database)
                        .map(|t| t.key.clone())
                        .collect();
                    others.insert(
                        o.app_id.clone(),
                        load(c, &o.payload.key_map, &keys, &mut signature)?,
                    );
                }
            }
            Ok((dbs, others))
        })?;
        let workbook_count: u32 = if m.id == "spreadsheet-studio" {
            let ws = inst.workspace_id.clone();
            self.read(move |c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM pages WHERE workspace_id = ?1 AND kind = 'sheet' AND deleted_at IS NULL",
                    [&ws],
                    |r| r.get(0),
                )?)
            })?
        } else {
            0
        };
        signature.push_str(&format!("|sheets:{workbook_count}"));
        let mut lint = BTreeMap::new();
        for t in m
            .templates
            .iter()
            .filter(|t| t.kind == TemplateKind::Workbook)
        {
            if let Some(id) = key_map.get(&t.key)
                && let Ok(items) = self.sheet_lint(id)
            {
                for i in items {
                    *lint.entry(i.rule).or_insert(0u32) += 1;
                }
                signature.push_str(&format!("|wb:{id}"));
            }
        }
        Ok((
            MetricData {
                app_id: m.id.clone(),
                instance_id: inst.id.clone(),
                answers: resolved.answers,
                today: cx.today(),
                now_ms: cx.now_ms,
                installed_at: inst.installed_at,
                currency: cx.currency,
                pack,
                dbs,
                others,
                lint,
                workbook_count,
            },
            signature,
        ))
    }

    fn compute_metrics(
        &self,
        s: &Arc<Session>,
        inst: &InstanceRow,
    ) -> Result<(BTreeMap<String, MetricValue>, MetricData)> {
        let m = manifest_of(&inst.app_id)?;
        let (data, mut sig) = self.metric_data(s, inst, m)?;
        // The provider's values are computed on every pass (they read data outside this instance's databases, e.g.
        // Portfolio and market prices) and are part of the cache signature, so a cached pass never serves stale ones.
        let provider = PROVIDER.read().clone();
        let overrides = provider
            .as_deref()
            .map(|p| p.overrides(self, &data))
            .unwrap_or_default();
        if !overrides.is_empty() {
            for (k, v) in &overrides {
                sig.push_str(&format!("|ov:{k}={}", v.value));
            }
        }
        let weak = Arc::downgrade(s);
        {
            let cache = METRIC_CACHE.lock();
            if let Some(e) = cache.iter().find(|e| {
                e.instance == inst.id && e.signature == sig && Weak::ptr_eq(&e.session, &weak)
            }) {
                return Ok((e.values.clone(), data));
            }
        }
        let values = metrics::compute_all(m, &data, &overrides);
        {
            let mut cache = METRIC_CACHE.lock();
            cache.retain(|e| e.session.strong_count() > 0 && e.instance != inst.id);
            if cache.len() >= MAX_CACHE {
                cache.remove(0);
            }
            cache.push(CacheEntry {
                session: weak,
                instance: inst.id.clone(),
                signature: sig,
                values: values.clone(),
            });
        }
        self.auto_tick_metrics(s, inst, m, &data, &values)?;
        Ok((values, data))
    }

    fn auto_tick_metrics(
        &self,
        s: &Arc<Session>,
        inst: &InstanceRow,
        m: &LifeAppManifest,
        data: &MetricData,
        values: &BTreeMap<String, MetricValue>,
    ) -> Result<()> {
        let ctx = metrics::context(data, values);
        let due: Vec<String> = m
            .checklist
            .iter()
            .filter(|c| !inst.payload.checklist.contains_key(&c.id))
            .filter(|c| {
                c.auto_tick.as_ref().is_some_and(|a| {
                    a.event == "metrics"
                        && crate::lifeapps::answers::test(a.where_.as_deref(), &ctx)
                })
            })
            .map(|c| c.id.clone())
            .collect();
        if !due.is_empty() {
            self.tick(s, &inst.id, &due)?;
        }
        Ok(())
    }

    pub(crate) fn tick(&self, s: &Arc<Session>, instance_id: &str, items: &[String]) -> Result<()> {
        let now = self.now();
        let (sess, iid, items) = (Arc::clone(s), instance_id.to_owned(), items.to_vec());
        self.write(move |tx| {
            let inst = load_instance(tx, &sess.codec, &iid)?
                .ok_or(StoreError::NotFound("life app instance"))?;
            let mut p = inst.payload.clone();
            for i in &items {
                p.checklist.entry(i.clone()).or_insert(now);
            }
            if p != inst.payload {
                save_instance(tx, &sess.codec, &inst, &p)?;
            }
            Ok(())
        })
    }

    /// `lifeapp_metrics`: the named metrics (all when `names` is empty).
    pub fn lifeapp_metrics(
        &self,
        instance_id: &str,
        names: &[String],
    ) -> Result<BTreeMap<String, MetricValue>> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        if inst.payload.detached {
            return Ok(BTreeMap::new());
        }
        let (mut values, _) = self.compute_metrics(&s, &inst)?;
        if !names.is_empty() {
            for n in names {
                if !values.contains_key(n) {
                    return Err(StoreError::invalid_field(
                        "names",
                        format!("unknown metric {n}"),
                    ));
                }
            }
            values.retain(|k, _| names.contains(k));
        }
        Ok(values)
    }

    /// `lifeapp_insights`: ranked insights of one instance, or of every attached instance when `None` (Home).
    pub fn lifeapp_insights(&self, instance_id: Option<&str>) -> Result<Vec<Insight>> {
        let s = self.session()?;
        let instances = match instance_id {
            Some(id) => vec![self.instance(&s, id)?],
            None => self.read(|c| list_instances(c, &s.codec, None))?,
        };
        let mut out = Vec::new();
        for inst in instances.iter().filter(|i| !i.payload.detached) {
            let Some(m) = la::manifest(&inst.app_id) else {
                continue;
            };
            let (values, data) = self.compute_metrics(&s, inst)?;
            out.extend(advisor::evaluate(
                m,
                &data,
                &values,
                &inst.payload.key_map,
                &inst.payload.muted,
            ));
        }
        advisor::rank(&mut out);
        Ok(out)
    }

    /// `lifeapp_insight_mute`: mutes a rule until `until` (`None` unmutes).
    pub fn lifeapp_insight_mute(
        &self,
        instance_id: &str,
        rule_id: &str,
        until: Option<i64>,
    ) -> Result<()> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        let m = manifest_of(&inst.app_id)?;
        if !m.advisor.iter().any(|r| r.id == rule_id) {
            return Err(StoreError::NotFound("advisor rule"));
        }
        let (sess, iid, rid) = (Arc::clone(&s), instance_id.to_owned(), rule_id.to_owned());
        self.write(move |tx| {
            let inst = load_instance(tx, &sess.codec, &iid)?
                .ok_or(StoreError::NotFound("life app instance"))?;
            let mut p = inst.payload.clone();
            match until {
                Some(t) => {
                    p.muted.insert(rid, Some(t));
                }
                None => {
                    p.muted.remove(&rid);
                }
            }
            save_instance(tx, &sess.codec, &inst, &p)
        })
    }

    /// `lifeapp_checklist_tick`.
    pub fn lifeapp_checklist_tick(&self, instance_id: &str, item_id: &str) -> Result<()> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        let m = manifest_of(&inst.app_id)?;
        if !m.checklist.iter().any(|c| c.id == item_id) {
            return Err(StoreError::NotFound("checklist item"));
        }
        self.tick(&s, instance_id, &[item_id.to_owned()])
    }

    /// Auto-ticks checklist items listening for `event` (`finance.import_committed`, `budget.assigned`, …).
    /// `data` fields are visible to `where` conditions as `answers.event_<field>`. Returns `(instance, item)` pairs.
    pub fn lifeapp_event(
        &self,
        event: &str,
        data: &Map<String, Value>,
    ) -> Result<Vec<(String, String)>> {
        let s = self.session()?;
        let instances = self.read(|c| list_instances(c, &s.codec, None))?;
        let mut out = Vec::new();
        for inst in instances.iter().filter(|i| !i.payload.detached) {
            let Some(m) = la::manifest(&inst.app_id) else {
                continue;
            };
            let mut answers = inst.payload.answers.clone();
            for (k, v) in data {
                answers.insert(format!("event_{k}"), v.clone());
            }
            let ctx = AnswerContext::new(&answers, self.build_ctx(&inst.id, None)?.today());
            let items: Vec<String> = m
                .checklist
                .iter()
                .filter(|c| !inst.payload.checklist.contains_key(&c.id))
                .filter(|c| {
                    c.auto_tick.as_ref().is_some_and(|a| {
                        a.event == event
                            && crate::lifeapps::answers::test(a.where_.as_deref(), &ctx)
                    })
                })
                .map(|c| c.id.clone())
                .collect();
            if !items.is_empty() {
                self.tick(&s, &inst.id, &items)?;
                out.extend(items.into_iter().map(|i| (inst.id.clone(), i)));
            }
        }
        Ok(out)
    }

    /// `lifeapp_sample_data`: adds (`on`) or removes the instance's sample rows. Returns the rows affected.
    pub fn lifeapp_sample_data(&self, instance_id: &str, on: bool) -> Result<SampleResult> {
        let s = self.session()?;
        let inst = self.instance(&s, instance_id)?;
        let now = self.now();
        let sess = Arc::clone(&s);
        if !on {
            let n = self.write(move |tx| {
                let codec = &sess.codec;
                let mut n = 0;
                let mut dbs = BTreeSet::new();
                for id in &inst.payload.sample_rows {
                    let db: Option<String> = tx
                        .query_row("SELECT database_id FROM db_rows WHERE id = ?1", [id], |r| {
                            r.get(0)
                        })
                        .optional()?;
                    if let Some(db) = db {
                        n += tx
                            .prepare_cached("DELETE FROM db_rows WHERE id = ?1")?
                            .execute([id])?;
                        dbs.insert(db);
                    }
                }
                for db in &dbs {
                    crate::repo::databases::bump(tx, db, false, true)?;
                }
                let mut p = inst.payload.clone();
                p.sample_rows.clear();
                save_instance(tx, codec, &inst, &p)?;
                Ok(n)
            })?;
            self.invalidate_metrics(instance_id);
            return Ok(SampleResult { rows: n });
        }
        let m = manifest_of(&inst.app_id)?;
        let (_, pack) = pack_for(
            m,
            &inst.payload.answers,
            inst.payload.mode,
            self.local_today()?,
        );
        let cx = self.build_ctx(&inst.id, pack)?;
        let sel = plan::select(
            m,
            &inst.payload.answers,
            inst.payload.mode,
            &inst.payload.disabled_keys,
            cx.today(),
            cx.pack.as_ref(),
        )?;
        let extra: Vec<ExtraRow> = sample::generate(&m.sample.generator, m.sample.seed, cx.today());
        let b = build::build_with(m, &sel, &cx, &extra)?;
        let n = self.write(move |tx| {
            let codec = &sess.codec;
            let mut ids = Vec::new();
            for d in &b.dbs {
                let exists = load_page(tx, &d.id)?.is_some_and(|r| r.deleted_at.is_none());
                if !exists {
                    continue;
                }
                let rows = load_rows(tx, codec, &d.id)?;
                let mut last = rows.iter().map(|r| r.sort_key.clone()).max();
                let mut changed = false;
                for r in d.rows.iter().filter(|r| r.source == "sample") {
                    let present: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM db_rows WHERE id = ?1)",
                        [&r.id],
                        |x| x.get(0),
                    )?;
                    if present {
                        continue;
                    }
                    let k = key_between(last.as_deref(), None)?;
                    insert_row(tx, codec, &d.id, &r.id, &k, &r.payload, now)?;
                    last = Some(k);
                    ids.push(r.id.clone());
                    changed = true;
                }
                if changed {
                    crate::repo::databases::bump(tx, &d.id, false, true)?;
                }
            }
            let mut p = inst.payload.clone();
            p.sample_rows.extend(ids.iter().cloned());
            p.sample_rows.sort();
            p.sample_rows.dedup();
            save_instance(tx, codec, &inst, &p)?;
            Ok(ids.len())
        })?;
        let _ = self.db_index_rows();
        self.invalidate_metrics(instance_id);
        Ok(SampleResult { rows: n })
    }

    /// Re-arms recurring life-app reminders that have fired: each gets its next occurrence. Call after the
    /// scheduler fires reminders. Returns the number re-armed.
    pub fn lifeapp_rearm_reminders(&self) -> Result<usize> {
        let s = self.session()?;
        let instances = self.read(|c| list_instances(c, &s.codec, None))?;
        let now = self.now();
        let tz: chrono_tz::Tz = self
            .vault_settings()?
            .timezone
            .parse()
            .unwrap_or(chrono_tz::UTC);
        let mut todo: Vec<(String, i64)> = Vec::new();
        for inst in &instances {
            for (id, sch) in &inst.payload.schedules {
                let fired: Option<Option<i64>> = self.read(|c| {
                    Ok(
                        c.prepare_cached("SELECT fired_at FROM reminders WHERE id = ?1")?
                            .query_row([id], |r| r.get(0))
                            .optional()?,
                    )
                })?;
                if !matches!(fired, Some(Some(_))) {
                    continue;
                }
                let Ok(rule) = crate::life::recurrence::Rule::parse(
                    &sch.schedule.rrule,
                    &sch.schedule.dtstart,
                    Some(tz.name()),
                ) else {
                    continue;
                };
                let after = now + sch.schedule.days_before * 86_400_000;
                if let Some(next) = crate::life::recurrence::next_after_ms(
                    &rule,
                    after,
                    crate::query::model::RecurrenceMode::Schedule,
                ) {
                    todo.push((id.clone(), next - sch.schedule.days_before * 86_400_000));
                }
            }
        }
        let n = todo.len();
        if n > 0 {
            self.write(move |tx| {
                for (id, at) in todo {
                    tx.prepare_cached(
                        "UPDATE reminders SET fire_at = ?2, fired_at = NULL WHERE id = ?1",
                    )?
                    .execute(params![id, at])?;
                }
                Ok(())
            })?;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_derivation_filters_documents() {
        let pack = json!({
            "id": "us-federal-2026", "country": "US", "year": 2026,
            "documents": [{"when": "income:employment", "docs": ["W-2"]}, {"when": "income:interest", "docs": ["1099-INT"]}, {"when": "event:bought_home|deduction:mortgage", "docs": ["1098"]}],
            "expectedBy": {"W-2": "01-31", "1098": "01-31"},
            "estimated": {"periods": [{"id": "Q1", "due": "2026-04-15"}]}
        });
        let answers = json!({"income": ["employment"], "events": ["bought_home"]})
            .as_object()
            .cloned()
            .unwrap();
        let d = derive_pack(&pack, &answers);
        let docs = d["selectedDocuments"].as_array().unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0]["expectedBy"], json!("2027-01-31"));
        assert_eq!(docs[1]["name"], json!("1098"));
        assert_eq!(d["estimatedPeriods"][0]["id"], json!("Q1"));
    }
}
