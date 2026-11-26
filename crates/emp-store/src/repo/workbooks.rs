//! Workbooks (SPEC §10.2 `workbooks` / `sheets` / `sheet_bands`, §11.3 Sheets, §14.2): persistence of the
//! emp-sheets engine and workbook-level commands.
//!
//! **Storage.** A workbook is a `pages` row of kind `sheet` plus:
//! * `workbooks.payload` — `{v, styles[], names[], calc, nextSheetId}`;
//! * one `sheets` row per sheet — `{v, engineId, name, color, hidden, frozen, colWidths, rowHeights, merges,
//!   condFormats, charts, maxRow, maxCol}` with the tab order in the plaintext `sort_key`;
//! * one `sheet_bands` row per 256-row band — `{v, cells:[[rowOff, col, formula|null, value, styleId], …]}`. Cached
//!   formula results are stored, so opening a workbook only recalculates volatile and external cells.
//!
//! **Engine.** Edits run on an in-memory [`emp_sheets::Workbook`] cached per unlocked session (bounded, dropped
//! when the session ends) so that undo works across commands. After each edit only the bands, sheets and workbook
//! payload whose serialised form changed are written, in one transaction; if that write fails the cached engine is
//! discarded and reloaded from disk on the next call.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock, Weak};

use emp_crypto::TableTag;
use emp_sheets::workbook::packed::Frozen;
use emp_sheets::workbook::persist::{CellFile, NameFile, SheetFile, WorkbookFile};
use emp_sheets::{
    CacheHost, CalcSettings, CellStyle, Host, LintFinding, Rect, SheetError, SheetId, Value,
    Workbook,
};
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::codec::{Codec, RecordLoc};
use crate::model::sort_key::n_keys_between;
use crate::model::{PageKind, PageMeta, PagePayload, ids::new_id, validate_title};
use crate::query::engine::fnv64;
use crate::repo::pages::{insert_page, load_meta, load_page, position_key};
use crate::vault::{Session, StoreEvent};
use crate::{Result, Store, StoreError};

/// Rows per band (`band = row >> 8`).
pub const BAND_SHIFT: u32 = 8;
/// Cached engines per session.
pub const MAX_CACHED_ENGINES: usize = 8;
/// Maximum sheets per workbook.
pub const MAX_SHEETS: usize = 256;

// ───────────────────────────────────────────────────────────────────────────── payloads

/// `workbooks.payload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookPayload {
    /// Payload version.
    pub v: u32,
    /// Styles by id (index).
    #[serde(default)]
    pub styles: Vec<CellStyle>,
    /// Defined names.
    #[serde(default)]
    pub names: Vec<NameFile>,
    /// Calculation settings.
    #[serde(default)]
    pub calc: CalcSettings,
    /// Next engine sheet id.
    #[serde(default)]
    pub next_sheet_id: SheetId,
}

/// `sheets.payload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPayload {
    /// Payload version.
    pub v: u32,
    /// Engine sheet id (stable within the workbook).
    pub engine_id: SheetId,
    /// Name.
    pub name: String,
    /// Tab colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Hidden.
    #[serde(default)]
    pub hidden: bool,
    /// Frozen panes.
    #[serde(default)]
    pub frozen: Frozen,
    /// Column widths.
    #[serde(default)]
    pub col_widths: Vec<(u32, f64)>,
    /// Row heights.
    #[serde(default)]
    pub row_heights: Vec<(u32, f64)>,
    /// Merges.
    #[serde(default)]
    pub merges: Vec<Rect>,
    /// Conditional formats.
    #[serde(default)]
    pub cond_formats: Vec<serde_json::Value>,
    /// Charts.
    #[serde(default)]
    pub charts: Vec<serde_json::Value>,
    /// Last used row.
    #[serde(default)]
    pub max_row: u32,
    /// Last used column.
    #[serde(default)]
    pub max_col: u32,
}

/// One stored cell: `[rowOff, col, formula|null, value, styleId]`.
pub type BandCell = (u32, u32, Option<String>, Value, u32);

/// `sheet_bands.payload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BandPayload {
    /// Payload version.
    pub v: u32,
    /// Cells.
    pub cells: Vec<BandCell>,
}

/// `SheetMeta` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetMeta {
    /// Sheet id (UUID).
    pub id: String,
    /// Name.
    pub name: String,
    /// Tab colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Hidden.
    pub hidden: bool,
    /// Frozen panes.
    pub frozen: Frozen,
    /// Last used row.
    pub max_row: u32,
    /// Last used column.
    pub max_col: u32,
    /// Tab order.
    pub sort_key: String,
}

/// `sheet_workbook_get` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookInfo {
    /// Sheets in tab order.
    pub sheets: Vec<SheetMeta>,
    /// Styles by id.
    pub styles: BTreeMap<u32, CellStyle>,
    /// Defined names.
    pub named_ranges: Vec<NamedRange>,
    /// Calculation settings.
    pub calc: CalcSettings,
}

/// A defined name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NamedRange {
    /// Name.
    pub name: String,
    /// Reference text.
    #[serde(rename = "ref")]
    pub reference: String,
}

/// `sheet_workbook_create` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkbookCreated {
    /// The workbook page.
    pub page: PageMeta,
    /// Its sheets.
    pub sheets: Vec<SheetMeta>,
}

/// `sheet_find` hit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindHit {
    /// Sheet id.
    pub sheet_id: String,
    /// Row.
    pub row: u32,
    /// Column.
    pub col: u32,
}

/// `sheet_lint` finding with the app-level sheet id.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintItem {
    /// Stable id.
    pub id: String,
    /// Sheet id.
    pub sheet_id: String,
    /// Rect.
    pub rect: Rect,
    /// Rule.
    pub rule: String,
    /// Message.
    pub message: String,
    /// Suggested fix.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

/// `sheet_eval` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EvalResult {
    /// Display string.
    pub display: String,
    /// Raw value.
    pub value: serde_json::Value,
    /// Error explanation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ───────────────────────────────────────────────────────────────────────────── engine

pub(crate) fn sheet_err(e: SheetError) -> StoreError {
    match e {
        SheetError::NotFound(_) => StoreError::NotFound("sheet"),
        SheetError::Invalid(m) | SheetError::Io(m) => StoreError::invalid(m),
        SheetError::Parse(p) => StoreError::invalid(p.message),
        SheetError::TooLarge(_) => StoreError::TooLarge("sheet"),
        SheetError::Internal(m) => StoreError::Internal(m),
    }
}

fn wb_loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::Workbooks, id, u64::try_from(rev).unwrap_or(0))
}

fn sheet_loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::Sheets, id, u64::try_from(rev).unwrap_or(0))
}

fn band_loc(sheet: &str, band: u32, rev: i64) -> Result<RecordLoc> {
    RecordLoc::sheet_band(sheet, band, u64::try_from(rev).unwrap_or(0))
}

fn hash_of<T: Serialize>(v: &T) -> u64 {
    serde_json::to_vec(v).map_or(0, |b| fnv64(&[&b]))
}

/// The cached engine of one workbook.
pub(crate) struct Engine {
    pub wb: Workbook,
    pub id: String,
    /// `(uuid, engine id)` of every persisted sheet.
    sheets: Vec<(String, SheetId)>,
    keys: HashMap<String, String>,
    wb_rev: i64,
    wb_hash: u64,
    sheet_rev: HashMap<SheetId, i64>,
    sheet_hash: HashMap<SheetId, u64>,
    band_rev: HashMap<(SheetId, u32), i64>,
    band_hash: HashMap<(SheetId, u32), u64>,
}

/// Writes computed by [`Engine::plan`].
#[derive(Default)]
struct Plan {
    wb: Option<(i64, WorkbookPayload, u64)>,
    sheets: Vec<(String, SheetId, String, i64, SheetPayload, u64, bool)>,
    rekey: Vec<(String, String)>,
    sheet_deletes: Vec<(String, SheetId)>,
    bands: Vec<(String, SheetId, u32, i64, BandPayload, u64, bool)>,
    band_deletes: Vec<(String, SheetId, u32)>,
}

fn sheet_payload(sf: &SheetFile, max_row: u32, max_col: u32) -> SheetPayload {
    SheetPayload {
        v: 1,
        engine_id: sf.id,
        name: sf.name.clone(),
        color: sf.color.clone(),
        hidden: sf.hidden,
        frozen: sf.frozen,
        col_widths: sf.col_widths.clone(),
        row_heights: sf.row_heights.clone(),
        merges: sf.merges.clone(),
        cond_formats: sf
            .cond_formats
            .iter()
            .filter_map(|c| serde_json::to_value(c).ok())
            .collect(),
        charts: sf.charts.clone(),
        max_row,
        max_col,
    }
}

fn bands_of(cells: &[CellFile]) -> BTreeMap<u32, BandPayload> {
    let mut out: BTreeMap<u32, BandPayload> = BTreeMap::new();
    for c in cells {
        let band = c.r >> BAND_SHIFT;
        out.entry(band)
            .or_insert_with(|| BandPayload {
                v: 1,
                cells: Vec::new(),
            })
            .cells
            .push((
                c.r - (band << BAND_SHIFT),
                c.c,
                c.f.clone(),
                c.v.clone(),
                c.s,
            ));
    }
    out
}

impl Engine {
    /// The uuid of an engine sheet.
    pub fn uuid(&self, sid: SheetId) -> Option<&str> {
        self.sheets
            .iter()
            .find(|(_, e)| *e == sid)
            .map(|(u, _)| u.as_str())
    }

    /// The engine id of a sheet uuid.
    pub fn engine_id(&self, uuid: &str) -> Result<SheetId> {
        self.sheets
            .iter()
            .find(|(u, _)| u == uuid)
            .map(|(_, e)| *e)
            .ok_or(StoreError::NotFound("sheet"))
    }

    /// Current data revision (bumped by every persisted edit).
    pub fn rev(&self) -> i64 {
        self.wb_rev
    }

    /// Registers a uuid for a sheet the engine created (persisted by the next plan).
    pub fn register(&mut self, sid: SheetId) -> String {
        if let Some(u) = self.uuid(sid) {
            return u.to_owned();
        }
        let u = new_id();
        self.sheets.push((u.clone(), sid));
        u
    }

    /// Sheet metadata in tab order.
    pub fn metas(&self) -> Vec<SheetMeta> {
        self.wb
            .sheet_infos()
            .into_iter()
            .filter_map(|i| {
                let id = self.uuid(i.id)?.to_owned();
                Some(SheetMeta {
                    sort_key: self.keys.get(&id).cloned().unwrap_or_default(),
                    id,
                    name: i.name,
                    color: i.color,
                    hidden: i.hidden,
                    frozen: i.frozen,
                    max_row: i.max_row,
                    max_col: i.max_col,
                })
            })
            .collect()
    }

    fn plan(&mut self) -> Result<Plan> {
        let file = self.wb.to_file();
        let infos: HashMap<SheetId, (u32, u32)> = self
            .wb
            .sheet_infos()
            .into_iter()
            .map(|i| (i.id, (i.max_row, i.max_col)))
            .collect();
        for sf in &file.sheets {
            self.register(sf.id);
        }
        let mut plan = Plan::default();
        let wp = WorkbookPayload {
            v: 1,
            styles: file.styles.clone(),
            names: file.names.clone(),
            calc: file.calc,
            next_sheet_id: file.next_sheet_id,
        };
        let h = hash_of(&wp);
        plan.wb = Some((self.wb_rev + 1, wp, h));
        // Tab order: regenerate keys when the stored order no longer matches.
        let order: Vec<String> = file
            .sheets
            .iter()
            .filter_map(|s| self.uuid(s.id).map(str::to_owned))
            .collect();
        let mut by_key = order.clone();
        by_key.sort_by(|a, b| {
            let ka = self.keys.get(a).map(String::as_str).unwrap_or("~");
            let kb = self.keys.get(b).map(String::as_str).unwrap_or("~");
            ka.cmp(kb)
        });
        let keys_ok = by_key == order && order.iter().all(|u| self.keys.contains_key(u));
        let mut new_keys: HashMap<String, String> = HashMap::new();
        if !keys_ok {
            let ks = n_keys_between(None, None, order.len().max(1))?;
            for (u, k) in order.iter().zip(ks) {
                new_keys.insert(u.clone(), k);
            }
        }
        for sf in &file.sheets {
            let uuid = self.uuid(sf.id).unwrap_or_default().to_owned();
            let (mr, mc) = infos.get(&sf.id).copied().unwrap_or((0, 0));
            let sp = sheet_payload(sf, mr, mc);
            let h = hash_of(&sp);
            let is_new = !self.sheet_rev.contains_key(&sf.id);
            let key = new_keys
                .get(&uuid)
                .cloned()
                .or_else(|| self.keys.get(&uuid).cloned())
                .unwrap_or_default();
            if is_new || self.sheet_hash.get(&sf.id) != Some(&h) {
                let rev = self.sheet_rev.get(&sf.id).copied().unwrap_or(0) + 1;
                plan.sheets
                    .push((uuid.clone(), sf.id, key.clone(), rev, sp, h, is_new));
            } else if new_keys.contains_key(&uuid) {
                plan.rekey.push((uuid.clone(), key.clone()));
            }
            let bands = bands_of(&sf.cells);
            for (band, bp) in &bands {
                let h = hash_of(bp);
                let k = (sf.id, *band);
                if self.band_hash.get(&k) != Some(&h) {
                    let is_new = !self.band_rev.contains_key(&k);
                    let rev = self.band_rev.get(&k).copied().unwrap_or(0) + 1;
                    plan.bands
                        .push((uuid.clone(), sf.id, *band, rev, bp.clone(), h, is_new));
                }
            }
            for &(sid, band) in self.band_rev.keys() {
                if sid == sf.id && !bands.contains_key(&band) {
                    plan.band_deletes.push((uuid.clone(), sid, band));
                }
            }
        }
        for (u, sid) in &self.sheets {
            if self.sheet_rev.contains_key(sid) && !file.sheets.iter().any(|s| s.id == *sid) {
                plan.sheet_deletes.push((u.clone(), *sid));
            }
        }
        // Keys of new sheets that were not part of a regeneration.
        for s in &mut plan.sheets {
            if s.2.is_empty() {
                let last = self.keys.values().max().cloned();
                s.2 = crate::model::sort_key::key_between(last.as_deref(), None)?;
            }
        }
        Ok(plan)
    }

    fn commit(&mut self, plan: &Plan) {
        if let Some((rev, _, h)) = &plan.wb {
            self.wb_rev = *rev;
            self.wb_hash = *h;
        }
        for (u, sid, key, rev, _, h, _) in &plan.sheets {
            self.sheet_rev.insert(*sid, *rev);
            self.sheet_hash.insert(*sid, *h);
            self.keys.insert(u.clone(), key.clone());
        }
        for (u, k) in &plan.rekey {
            self.keys.insert(u.clone(), k.clone());
        }
        for (u, sid) in &plan.sheet_deletes {
            self.sheet_rev.remove(sid);
            self.sheet_hash.remove(sid);
            self.keys.remove(u);
            self.band_rev.retain(|(s, _), _| s != sid);
            self.band_hash.retain(|(s, _), _| s != sid);
            self.sheets.retain(|(x, _)| x != u);
        }
        for (_, sid, band, rev, _, h, _) in &plan.bands {
            self.band_rev.insert((*sid, *band), *rev);
            self.band_hash.insert((*sid, *band), *h);
        }
        for (_, sid, band) in &plan.band_deletes {
            self.band_rev.remove(&(*sid, *band));
            self.band_hash.remove(&(*sid, *band));
        }
    }
}

fn apply_plan(tx: &Connection, codec: &Codec, wb_id: &str, plan: &Plan) -> Result<()> {
    if let Some((rev, wp, _)) = &plan.wb {
        let e = codec.encode(&wb_loc(wb_id, *rev), wp)?;
        tx.prepare_cached(
            "INSERT INTO workbooks (id, rev, enc, payload) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, enc = excluded.enc, payload = excluded.payload",
        )?
        .execute(params![wb_id, rev, e.enc, e.payload])?;
    }
    for (u, _) in &plan.sheet_deletes {
        tx.prepare_cached("DELETE FROM sheets WHERE id = ?1")?
            .execute([u])?;
    }
    for (u, _, key, rev, sp, _, _) in &plan.sheets {
        let e = codec.encode(&sheet_loc(u, *rev), sp)?;
        tx.prepare_cached(
            "INSERT INTO sheets (id, workbook_id, sort_key, rev, enc, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET sort_key = excluded.sort_key, rev = excluded.rev, enc = excluded.enc, payload = excluded.payload",
        )?
        .execute(params![u, wb_id, key, rev, e.enc, e.payload])?;
    }
    for (u, key) in &plan.rekey {
        tx.prepare_cached("UPDATE sheets SET sort_key = ?2 WHERE id = ?1")?
            .execute(params![u, key])?;
    }
    for (u, _, band) in &plan.band_deletes {
        tx.prepare_cached("DELETE FROM sheet_bands WHERE sheet_id = ?1 AND band = ?2")?
            .execute(params![u, band])?;
    }
    for (u, _, band, rev, bp, _, _) in &plan.bands {
        let e = codec.encode(&band_loc(u, *band, *rev)?, bp)?;
        tx.prepare_cached(
            "INSERT INTO sheet_bands (sheet_id, band, rev, enc, payload) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(sheet_id, band) DO UPDATE SET rev = excluded.rev, enc = excluded.enc, payload = excluded.payload",
        )?
        .execute(params![u, band, rev, e.enc, e.payload])?;
    }
    tx.prepare_cached("UPDATE pages SET updated_at = ?2 WHERE id = ?1")?
        .execute(params![wb_id, crate::db::system_now_ms()])?;
    Ok(())
}

/// Loads a workbook from disk into a fresh engine.
fn load_engine(
    conn: &Connection,
    codec: &Codec,
    wb_id: &str,
    host: Arc<dyn Host>,
) -> Result<Engine> {
    let row: Option<(i64, i64, Vec<u8>)> = conn
        .prepare_cached("SELECT rev, enc, payload FROM workbooks WHERE id = ?1")?
        .query_row([wb_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    let (wb_rev, enc, payload) = row.ok_or(StoreError::NotFound("workbook"))?;
    let wp: WorkbookPayload = codec.decode(&wb_loc(wb_id, wb_rev), enc, &payload)?;
    let mut st = conn.prepare_cached("SELECT id, sort_key, rev, enc, payload FROM sheets WHERE workbook_id = ?1 ORDER BY sort_key, id")?;
    let srows: Vec<(String, String, i64, i64, Vec<u8>)> = st
        .query_map([wb_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut sheets_files = Vec::new();
    let mut eng = Engine {
        wb: Workbook::empty(Arc::clone(&host)),
        id: wb_id.to_owned(),
        sheets: Vec::new(),
        keys: HashMap::new(),
        wb_rev,
        wb_hash: hash_of(&wp),
        sheet_rev: HashMap::new(),
        sheet_hash: HashMap::new(),
        band_rev: HashMap::new(),
        band_hash: HashMap::new(),
    };
    for (sid, key, rev, enc, payload) in srows {
        let sp: SheetPayload = codec.decode(&sheet_loc(&sid, rev), enc, &payload)?;
        let mut cells = Vec::new();
        let mut bst = conn.prepare_cached(
            "SELECT band, rev, enc, payload FROM sheet_bands WHERE sheet_id = ?1 ORDER BY band",
        )?;
        let bands: Vec<(u32, i64, i64, Vec<u8>)> = bst
            .query_map([&sid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (band, brev, benc, bpayload) in bands {
            let bp: BandPayload = codec.decode(&band_loc(&sid, band, brev)?, benc, &bpayload)?;
            eng.band_rev.insert((sp.engine_id, band), brev);
            eng.band_hash.insert((sp.engine_id, band), hash_of(&bp));
            for (off, c, f, v, s) in bp.cells {
                cells.push(CellFile {
                    r: (band << BAND_SHIFT) + off,
                    c,
                    f,
                    v,
                    s,
                });
            }
        }
        eng.sheet_rev.insert(sp.engine_id, rev);
        eng.sheet_hash.insert(sp.engine_id, hash_of(&sp));
        eng.sheets.push((sid.clone(), sp.engine_id));
        eng.keys.insert(sid, key);
        sheets_files.push(SheetFile {
            id: sp.engine_id,
            name: sp.name,
            color: sp.color,
            hidden: sp.hidden,
            frozen: sp.frozen,
            cells,
            row_heights: sp.row_heights,
            col_widths: sp.col_widths,
            merges: sp.merges,
            cond_formats: sp
                .cond_formats
                .into_iter()
                .filter_map(|c| serde_json::from_value(c).ok())
                .collect(),
            charts: sp.charts,
        });
    }
    let file = WorkbookFile {
        v: emp_sheets::workbook::persist::WORKBOOK_FORMAT_VERSION,
        sheets: sheets_files,
        styles: wp.styles,
        names: wp.names,
        calc: wp.calc,
        next_sheet_id: wp.next_sheet_id,
    };
    eng.wb = Workbook::from_file(file, host).map_err(sheet_err)?;
    // Sheet payloads hash with the engine's view of max row / col.
    let f = eng.wb.to_file();
    for sf in &f.sheets {
        let info = eng.wb.sheet_infos().into_iter().find(|i| i.id == sf.id);
        let (mr, mc) = info.map_or((0, 0), |i| (i.max_row, i.max_col));
        eng.sheet_hash
            .insert(sf.id, hash_of(&sheet_payload(sf, mr, mc)));
    }
    Ok(eng)
}

struct CacheEntry {
    session: Weak<Session>,
    wb: String,
    engine: Arc<Mutex<Engine>>,
    used: u64,
}

static ENGINES: LazyLock<Mutex<(u64, Vec<CacheEntry>)>> =
    LazyLock::new(|| Mutex::new((0, Vec::new())));
static HOST: LazyLock<RwLock<Option<Arc<dyn Host>>>> = LazyLock::new(|| RwLock::new(None));

fn current_host() -> Arc<dyn Host> {
    HOST.read()
        .clone()
        .unwrap_or_else(|| Arc::new(CacheHost::new()))
}

/// Drops every cached engine of sessions that ended (and, with `all`, every engine).
pub(crate) fn prune_engines(all: bool) {
    let mut g = ENGINES.lock();
    g.1.retain(|e| !all && e.session.strong_count() > 0);
}

fn evict(s: &Arc<Session>, wb: &str) {
    let w = Arc::downgrade(s);
    ENGINES
        .lock()
        .1
        .retain(|e| !(e.wb == wb && Weak::ptr_eq(&e.session, &w)));
}

impl Store {
    /// Sets the formula host (clock, market / FX cache) used by workbooks loaded from now on.
    pub fn sheets_set_host(&self, host: Arc<dyn Host>) {
        *HOST.write() = Some(host);
        prune_engines(true);
    }

    /// Drops cached workbook engines (call on lock; engines of ended sessions are also dropped lazily).
    pub fn sheets_drop_cache(&self) {
        prune_engines(true);
    }

    /// The cached engine of a workbook (loaded on first use).
    pub(crate) fn engine(&self, s: &Arc<Session>, wb_id: &str) -> Result<Arc<Mutex<Engine>>> {
        let w = Arc::downgrade(s);
        {
            let mut g = ENGINES.lock();
            g.0 += 1;
            let tick = g.0;
            g.1.retain(|e| e.session.strong_count() > 0);
            if let Some(e) =
                g.1.iter_mut()
                    .find(|e| e.wb == wb_id && Weak::ptr_eq(&e.session, &w))
            {
                e.used = tick;
                return Ok(Arc::clone(&e.engine));
            }
        }
        let eng = self.read(|c| load_engine(c, &s.codec, wb_id, current_host()))?;
        let eng = Arc::new(Mutex::new(eng));
        let mut g = ENGINES.lock();
        g.0 += 1;
        let tick = g.0;
        if g.1.len() >= MAX_CACHED_ENGINES {
            if let Some(i) =
                g.1.iter()
                    .enumerate()
                    .min_by_key(|(_, e)| e.used)
                    .map(|(i, _)| i)
            {
                g.1.swap_remove(i);
            }
        }
        g.1.push(CacheEntry {
            session: w,
            wb: wb_id.to_owned(),
            engine: Arc::clone(&eng),
            used: tick,
        });
        Ok(eng)
    }

    /// Runs an edit on the engine and persists what changed. On a failed write the engine is discarded.
    pub(crate) fn sheet_mutate<T>(
        &self,
        wb_id: &str,
        f: impl FnOnce(&mut Engine) -> std::result::Result<T, StoreError>,
    ) -> Result<(T, i64)> {
        let s = self.session()?;
        let eng = self.engine(&s, wb_id)?;
        let mut g = eng.lock();
        let out = match f(&mut g) {
            Ok(v) => v,
            Err(e) => {
                drop(g);
                // The engine may be half-modified by a failing operation; reload next time.
                evict(&s, wb_id);
                return Err(e);
            }
        };
        let plan = g.plan()?;
        let sess = Arc::clone(&s);
        let id = wb_id.to_owned();
        let plan = Arc::new(plan);
        let p2 = Arc::clone(&plan);
        match self.write(move |tx| apply_plan(tx, &sess.codec, &id, &p2)) {
            Ok(()) => {
                g.commit(&plan);
                let rev = g.rev();
                Ok((out, rev))
            }
            Err(e) => {
                drop(g);
                evict(&s, wb_id);
                Err(e)
            }
        }
    }

    /// Reads from the engine.
    pub(crate) fn sheet_read<T>(
        &self,
        wb_id: &str,
        f: impl FnOnce(&Engine) -> Result<T>,
    ) -> Result<T> {
        let s = self.session()?;
        let eng = self.engine(&s, wb_id)?;
        let g = eng.lock();
        f(&g)
    }

    /// The workbook of a sheet uuid.
    pub(crate) fn workbook_of(&self, sheet_id: &str) -> Result<String> {
        self.session()?;
        self.read(|c| {
            c.prepare_cached("SELECT workbook_id FROM sheets WHERE id = ?1")?
                .query_row([sheet_id], |r| r.get(0))
                .optional()?
                .ok_or(StoreError::NotFound("sheet"))
        })
    }

    /// Creates a workbook page from an engine workbook (blank, imported or from a life-app template).
    pub fn sheet_workbook_create_from(
        &self,
        workspace_id: &str,
        parent_id: Option<&str>,
        title: &str,
        wb: Workbook,
    ) -> Result<WorkbookCreated> {
        validate_title(title)?;
        if wb.sheets().is_empty() {
            return Err(StoreError::invalid("a workbook needs at least one sheet"));
        }
        let s = self.session()?;
        let now = self.now();
        let mut eng = Engine {
            wb,
            id: String::new(),
            sheets: Vec::new(),
            keys: HashMap::new(),
            wb_rev: 0,
            wb_hash: 0,
            sheet_rev: HashMap::new(),
            sheet_hash: HashMap::new(),
            band_rev: HashMap::new(),
            band_hash: HashMap::new(),
        };
        let id = new_id();
        eng.id.clone_from(&id);
        let plan = Arc::new(eng.plan()?);
        let p2 = Arc::clone(&plan);
        let sess = Arc::clone(&s);
        let (ws, parent, title_o, id2) = (
            workspace_id.to_owned(),
            parent_id.map(str::to_owned),
            title.to_owned(),
            id.clone(),
        );
        let meta = self.write(move |tx| {
            let codec = &sess.codec;
            if let Some(p) = &parent {
                let row = load_page(tx, p)?.ok_or(StoreError::NotFound("parent page"))?;
                if row.workspace_id != ws || row.deleted_at.is_some() {
                    return Err(StoreError::invalid_field("parentId", "invalid parent"));
                }
            }
            let key = position_key(tx, &ws, parent.as_deref(), None, None, None)?;
            insert_page(
                tx,
                codec,
                &id2,
                &ws,
                parent.as_deref(),
                PageKind::Sheet,
                &key,
                &PagePayload::new(&title_o),
                now,
            )?;
            apply_plan(tx, codec, &id2, &p2)?;
            load_meta(tx, codec, &id2)?.ok_or(StoreError::NotFound("page"))
        })?;
        eng.commit(&plan);
        let sheets = eng.metas();
        // Cache the fresh engine.
        {
            let mut g = ENGINES.lock();
            g.0 += 1;
            let tick = g.0;
            g.1.push(CacheEntry {
                session: Arc::downgrade(&s),
                wb: id,
                engine: Arc::new(Mutex::new(eng)),
                used: tick,
            });
        }
        self.index_page(&s, &meta, None);
        self.emit(StoreEvent::TreeChanged {
            workspace_id: meta.workspace_id.clone(),
            upserted: vec![meta.clone()],
            removed: Vec::new(),
        });
        Ok(WorkbookCreated { page: meta, sheets })
    }

    /// `sheet_workbook_create`: a blank workbook with `Sheet1`. Named templates come from Spreadsheet Studio
    /// (`sheet_workbook_create_from`).
    pub fn sheet_workbook_create(
        &self,
        workspace_id: &str,
        parent_id: Option<&str>,
        title: &str,
        template: Option<&str>,
    ) -> Result<WorkbookCreated> {
        if template.is_some_and(|t| !t.is_empty() && t != "blank") {
            return Err(StoreError::Unsupported(
                "workbook templates are installed by Spreadsheet Studio",
            ));
        }
        let mut wb = Workbook::empty(current_host());
        wb.add_sheet(Some("Sheet1"), None).map_err(sheet_err)?;
        self.sheet_workbook_create_from(workspace_id, parent_id, title, wb)
    }

    /// `sheet_workbook_get`.
    pub fn sheet_workbook_get(&self, id: &str) -> Result<WorkbookInfo> {
        self.sheet_read(id, |e| {
            Ok(WorkbookInfo {
                sheets: e.metas(),
                styles: e
                    .wb
                    .styles()
                    .all()
                    .iter()
                    .enumerate()
                    .map(|(i, s)| (u32::try_from(i).unwrap_or(u32::MAX), s.clone()))
                    .collect(),
                named_ranges: e
                    .wb
                    .named_ranges()
                    .into_iter()
                    .map(|(name, reference)| NamedRange { name, reference })
                    .collect(),
                calc: e.wb.calc_settings(),
            })
        })
    }

    /// `sheet_undo` → changed sheet ids.
    pub fn sheet_undo(&self, workbook_id: &str) -> Result<Vec<String>> {
        let (ids, _) = self.sheet_mutate(workbook_id, |e| {
            let out = e.wb.undo();
            Ok(out
                .map(|o| {
                    o.changed_sheets
                        .iter()
                        .filter_map(|s| e.uuid(*s).map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default())
        })?;
        Ok(ids)
    }

    /// `sheet_redo` → changed sheet ids.
    pub fn sheet_redo(&self, workbook_id: &str) -> Result<Vec<String>> {
        let (ids, _) = self.sheet_mutate(workbook_id, |e| {
            let out = e.wb.redo();
            Ok(out
                .map(|o| {
                    o.changed_sheets
                        .iter()
                        .filter_map(|s| e.uuid(*s).map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default())
        })?;
        Ok(ids)
    }

    /// `sheet_named_range_set` (`None` removes the name).
    pub fn sheet_named_range_set(
        &self,
        workbook_id: &str,
        name: &str,
        reference: Option<&str>,
    ) -> Result<()> {
        self.sheet_mutate(workbook_id, |e| {
            e.wb.set_named_range(name, reference)
                .map(|_| ())
                .map_err(sheet_err)
        })?;
        Ok(())
    }

    /// Changes calculation settings (iterative, 1904 dates).
    pub fn sheet_calc_set(&self, workbook_id: &str, calc: CalcSettings) -> Result<()> {
        self.sheet_mutate(workbook_id, |e| {
            e.wb.set_calc_settings(calc).map(|_| ()).map_err(sheet_err)
        })?;
        Ok(())
    }

    /// `sheet_find`.
    pub fn sheet_find(
        &self,
        workbook_id: &str,
        query: &str,
        match_case: bool,
        whole_cell: bool,
        in_formulas: bool,
    ) -> Result<Vec<FindHit>> {
        if query.chars().count() > 512 {
            return Err(StoreError::TooLarge("query"));
        }
        self.sheet_read(workbook_id, |e| {
            Ok(e.wb
                .find(query, match_case, whole_cell, in_formulas)
                .into_iter()
                .take(10_000)
                .filter_map(|(s, row, col)| {
                    Some(FindHit {
                        sheet_id: e.uuid(s)?.to_owned(),
                        row,
                        col,
                    })
                })
                .collect())
        })
    }

    /// `sheet_replace` → number of replaced cells.
    pub fn sheet_replace(
        &self,
        workbook_id: &str,
        query: &str,
        replacement: &str,
        match_case: bool,
        whole_cell: bool,
    ) -> Result<usize> {
        if query.chars().count() > 512 || replacement.chars().count() > 8_192 {
            return Err(StoreError::TooLarge("query"));
        }
        let (n, _) = self.sheet_mutate(workbook_id, |e| {
            e.wb.replace(query, replacement, match_case, whole_cell)
                .map(|(n, _)| n)
                .map_err(sheet_err)
        })?;
        Ok(n)
    }

    /// `sheet_lint`.
    pub fn sheet_lint(&self, workbook_id: &str) -> Result<Vec<LintItem>> {
        self.sheet_read(workbook_id, |e| {
            Ok(e.wb
                .lint()
                .into_iter()
                .filter_map(|f: LintFinding| {
                    Some(LintItem {
                        sheet_id: e.uuid(f.sheet_id)?.to_owned(),
                        id: f.id,
                        rect: f.rect,
                        rule: f.rule,
                        message: f.message,
                        fix: f.fix,
                    })
                })
                .collect())
        })
    }

    /// `sheet_eval`: evaluates a formula in a workbook (or in scalar mode without one).
    pub fn sheet_eval(
        &self,
        workbook_id: Option<&str>,
        sheet_id: Option<&str>,
        formula: &str,
    ) -> Result<EvalResult> {
        if formula.chars().count() > 8_192 {
            return Err(StoreError::TooLarge("formula"));
        }
        let res = match workbook_id {
            Some(w) => self.sheet_read(w, |e| {
                let sid = sheet_id.map(|s| e.engine_id(s)).transpose()?;
                Ok(e.wb.eval_formula(sid, formula))
            })?,
            None => emp_sheets::eval_scalar(formula),
        };
        Ok(match res {
            Ok(v) => EvalResult {
                display: emp_sheets::format_value(
                    &v,
                    "General",
                    &emp_sheets::NumLocale::default(),
                    false,
                )
                .text,
                value: serde_json::to_value(&v).unwrap_or(serde_json::Value::Null),
                error: match &v {
                    Value::Error(k) => Some(format!("{k:?}")),
                    _ => None,
                },
            },
            Err(e) => EvalResult {
                display: String::new(),
                value: serde_json::Value::Null,
                error: Some(e.to_string()),
            },
        })
    }

    /// `sheet_export`: xlsx (whole workbook) or csv (one sheet, formula-injection protected).
    pub fn sheet_export(
        &self,
        workbook_id: &str,
        format: &str,
        sheet_id: Option<&str>,
    ) -> Result<Vec<u8>> {
        self.sheet_read(workbook_id, |e| match format {
            "xlsx" => emp_sheets::io::xlsx_export::export_xlsx(&e.wb).map_err(sheet_err),
            "csv" => {
                let sid = match sheet_id {
                    Some(s) => e.engine_id(s)?,
                    None => {
                        e.wb.sheets()
                            .first()
                            .map(|s| s.id)
                            .ok_or(StoreError::NotFound("sheet"))?
                    }
                };
                emp_sheets::io::csv::export_csv(&e.wb, sid, true).map_err(sheet_err)
            }
            _ => Err(StoreError::invalid_field("format", "xlsx or csv")),
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────── versions

/// Snapshot stored in `workbook` versions: the whole engine file plus the sheet uuids, so a restore keeps the
/// ids of sheets that still exist and gives deleted ones their old ids back.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkbookSnapshot {
    v: u32,
    workbook: WorkbookFile,
    #[serde(default)]
    sheets: Vec<SnapshotSheet>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotSheet {
    id: String,
    engine_id: SheetId,
}

fn snapshot_of(e: &Engine) -> Result<serde_json::Value> {
    let workbook = e.wb.to_file();
    let sheets = workbook
        .sheets
        .iter()
        .filter_map(|sf| {
            e.uuid(sf.id).map(|u| SnapshotSheet {
                id: u.to_owned(),
                engine_id: sf.id,
            })
        })
        .collect();
    Ok(serde_json::to_value(WorkbookSnapshot {
        v: 1,
        workbook,
        sheets,
    })?)
}

impl Store {
    fn live_workbook(&self, wb_id: &str) -> Result<()> {
        let page = self
            .read(|c| load_page(c, wb_id))?
            .ok_or(StoreError::NotFound("workbook"))?;
        if page.kind != PageKind::Sheet.as_str() {
            return Err(StoreError::NotFound("workbook"));
        }
        if page.deleted_at.is_some() {
            return Err(StoreError::invalid("the workbook is in the trash"));
        }
        Ok(())
    }

    /// `version_create({targetKind:'workbook'})`: a manual, labelled version of the whole workbook (every sheet,
    /// style, name and setting).
    pub(crate) fn workbook_version_create(
        &self,
        wb_id: &str,
        label: &str,
    ) -> Result<crate::model::VersionMeta> {
        self.live_workbook(wb_id)?;
        let snapshot = self.sheet_read(wb_id, snapshot_of)?;
        self.version_insert(
            wb_id,
            crate::model::VersionTargetKind::Workbook,
            crate::model::VersionReason::Manual,
            Some(label.to_owned()).filter(|l| !l.trim().is_empty()),
            snapshot,
        )
    }

    /// `version_restore` of a workbook version: the current state is kept as a `pre_restore` version, then the
    /// snapshot replaces the workbook (only the bands and sheets that differ are rewritten). The undo history of
    /// the workbook starts afresh. Returns the new workbook rev.
    pub(crate) fn workbook_version_restore(
        &self,
        wb_id: &str,
        snapshot: serde_json::Value,
    ) -> Result<i64> {
        self.live_workbook(wb_id)?;
        let snap: WorkbookSnapshot = serde_json::from_value(snapshot)
            .map_err(|_| StoreError::Integrity("unreadable workbook version".into()))?;
        let current = self.sheet_read(wb_id, snapshot_of)?;
        self.version_insert(
            wb_id,
            crate::model::VersionTargetKind::Workbook,
            crate::model::VersionReason::PreRestore,
            None,
            current,
        )?;
        let host = current_host();
        let ((), rev) = self.sheet_mutate(wb_id, move |e| {
            let mut file = snap.workbook;
            // Engine sheet ids are never reused: keep allocating after the highest id ever handed out.
            file.next_sheet_id = file.next_sheet_id.max(e.wb.to_file().next_sheet_id);
            let wb = Workbook::from_file(file, host).map_err(sheet_err)?;
            for s in snap.sheets {
                if e.uuid(s.engine_id).is_none() && !e.sheets.iter().any(|(u, _)| *u == s.id) {
                    e.sheets.push((s.id, s.engine_id));
                }
            }
            e.wb = wb;
            Ok(())
        })?;
        self.emit(StoreEvent::PageChanged {
            id: wb_id.to_owned(),
            meta_rev: None,
            doc_rev: None,
        });
        Ok(rev)
    }
}
