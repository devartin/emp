//! Database commands (SPEC §8, §11.3 "Databases").
//!
//! Thin, validated wrappers over the `emp-store` database repositories (`repo::{databases, rows, views}`,
//! `import::table`). Every mutation emits `db:changed { databaseId, dataRev, schemaRev, rowIds? }` (§11.4) so open
//! views refresh. Property, view and row commands address records by their own id; the owning database is resolved
//! through a bounded owner cache filled whenever schemas and rows pass through these commands, with a store lookup
//! as fallback for rows.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use emp_crypto::ExposeSecret;
use emp_store::Store;
use emp_store::dbmodel::{
    CellValue, ChartData, ChartSpec, DbCreate, DbCreated, DbPatch, DbSchema, Filter, FormulaCheck,
    GroupValue, Layout, PropType, Property, PropertyPatch, QueryRequest, QueryResponse,
    RelationOption, RowCreate, RowDto, RowGet, RowUpdate, SelectOptionInput, View, ViewPatch,
};
use emp_store::import::table::{ImportPreview, TableTarget};
use emp_store::model::PageMeta;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager, State, Webview};

use super::import::{InputFile, caps, cancelled_or, import_cell, remember_job, stage, take_file};
use super::job_sink;
use super::workspaces::IdReq;
use crate::error::{ApiError, ApiResult};
use crate::grants::GrantPurpose;
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Rows per `db_rows_*` call (§11.3: ≤ 1,000).
pub const MAX_BATCH: usize = 1_000;
/// Entries kept in the owner cache before it is reset.
pub const OWNER_CACHE_MAX: usize = 200_000;

// ───────────────────────────────────────────────────────────────────────────── db:changed and owners

/// `db:changed` payload (§11.4).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbChanged {
    /// Database.
    pub database_id: String,
    /// Data revision.
    pub data_rev: i64,
    /// Schema revision.
    pub schema_rev: i64,
    /// Changed rows, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_ids: Option<Vec<String>>,
}

static OWNERS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn note_owner(id: &str, db: &str) {
    let mut m = OWNERS.lock();
    if m.len() >= OWNER_CACHE_MAX {
        m.clear();
    }
    m.insert(id.to_owned(), db.to_owned());
}

/// Records the properties and views of `schema` as owned by its database.
pub fn note_schema(schema: &DbSchema) {
    let db = &schema.database.id;
    for p in &schema.properties {
        note_owner(&p.id, db);
    }
    for v in &schema.views {
        note_owner(&v.id, db);
    }
}

/// Records `rows` as owned by `db`.
pub fn note_rows(db: &str, rows: &[RowDto]) {
    for r in rows {
        note_owner(&r.id, db);
    }
}

/// The cached owning database of a property, view or row id.
#[must_use]
pub fn cached_owner(id: &str) -> Option<String> {
    OWNERS.lock().get(id).cloned()
}

/// The database of a row (cache, then the store).
pub fn row_owner(store: &Store, row_id: &str) -> ApiResult<String> {
    if let Some(db) = cached_owner(row_id) {
        return Ok(db);
    }
    let got = store.db_row_get(row_id)?;
    note_owner(row_id, &got.database_id);
    Ok(got.database_id)
}

/// Emits `db:changed` for `database_id` with its current revisions (best effort).
pub fn emit_db_changed(state: &AppState, store: &Store, database_id: &str, row_ids: Option<Vec<String>>) {
    match store.db_get_schema(database_id) {
        Ok(schema) => {
            note_schema(&schema);
            state.events.emit(
                crate::events::DB_CHANGED,
                DbChanged {
                    database_id: database_id.to_owned(),
                    data_rev: schema.database.data_rev,
                    schema_rev: schema.database.schema_rev,
                    row_ids,
                },
            );
        }
        Err(e) => tracing::debug!(code = e.code(), "db:changed not emitted"),
    }
}

fn emit_for_owner(state: &AppState, store: &Store, id: &str) {
    if let Some(db) = cached_owner(id) {
        emit_db_changed(state, store, &db, None);
    }
}

/// Every row of `database_id` in the order of `view_id` (or manual order), through query windows.
pub fn all_rows(store: &Store, database_id: &str, view_id: Option<&str>) -> ApiResult<Vec<RowDto>> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    loop {
        let mut q = QueryRequest::new(database_id, view_id, validate::MAX_WINDOW);
        q.window.offset = offset;
        match store.db_query(q)? {
            QueryResponse::Rows(r) => {
                let n = r.rows.len();
                out.extend(r.rows);
                offset += n;
                if n == 0 || offset >= r.total {
                    break;
                }
            }
            QueryResponse::NotModified { .. } => break,
        }
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────────────── validation helpers

fn check_config(field: &str, config: Option<&Map<String, Value>>) -> ApiResult<()> {
    if let Some(c) = config {
        let size = serde_json::to_vec(c).map(|v| v.len()).unwrap_or(usize::MAX);
        if size > 256 * 1024 {
            return Err(ApiError::invalid(field, "configuration is too large"));
        }
        if let Some(Value::String(f)) = c.get("expression").or_else(|| c.get("formula")) {
            validate::formula(field, f)?;
        }
    }
    Ok(())
}

fn check_values(field: &str, values: &BTreeMap<String, Option<CellValue>>) -> ApiResult<()> {
    validate::list_len(field, values.len(), 1_000)?;
    for (k, v) in values {
        validate::id(field, k)?;
        if let Some(v) = v {
            check_cell(field, v)?;
        }
    }
    Ok(())
}

/// Bounds a cell value at the IPC edge: finite numbers, decimal money, bounded text and lists.
pub fn check_cell(field: &str, v: &CellValue) -> ApiResult<()> {
    match v {
        CellValue::Number { v: Some(x) } | CellValue::Rating { v: Some(x) } | CellValue::Progress { v: Some(x) } => {
            validate::finite(field, *x)
        }
        CellValue::Money { v: Some(m), cur } => {
            validate::money(field, m)?;
            if cur.len() > 8 {
                return Err(ApiError::invalid(field, "invalid currency"));
            }
            Ok(())
        }
        CellValue::Text { v } => {
            validate::list_len(field, v.len(), 10_000)?;
            let len: usize = v.iter().map(|r| r.text.len()).sum();
            if len > 1_000_000 {
                return Err(ApiError::invalid(field, "text is too long"));
            }
            Ok(())
        }
        CellValue::Multi { v } | CellValue::Relation { v } => {
            validate::list_len(field, v.len(), 10_000)?;
            v.iter().try_for_each(|id| validate::bounded(field, id, 64))
        }
        CellValue::Url { v: Some(s) } => validate::bounded(field, s, validate::MAX_URL),
        CellValue::Email { v: Some(s) } | CellValue::Phone { v: Some(s) } | CellValue::Ticker { v: Some(s) } => {
            validate::bounded(field, s, validate::MAX_TITLE)
        }
        CellValue::Files { v } => validate::list_len(field, v.len(), 1_000),
        _ => Ok(()),
    }
}

/// An `{ ids }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdsReq {
    /// Record ids.
    pub ids: Vec<String>,
}

fn check_rows_window(ids: &[String]) -> ApiResult<()> {
    validate::ids("ids", ids, false)?;
    validate::list_len("ids", ids.len(), MAX_BATCH)
}

// ───────────────────────────────────────────────────────────────────────────── databases

/// `db_create({ workspaceId, parentId, title, inline, properties?, afterId? }) → { page, schema }`.
#[tauri::command]
pub async fn db_create(app: AppHandle, req: DbCreate) -> ApiResult<DbCreated> {
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    validate::opt_id("afterId", req.after_id.as_deref())?;
    validate::title("title", &req.title)?;
    if let Some(props) = &req.properties {
        validate::list_len("properties", props.len(), 200)?;
        for p in props {
            validate::title("properties.name", &p.name)?;
            check_config("properties.config", p.config.as_ref())?;
        }
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let created = state.session()?.db_create(req)?;
        note_schema(&created.schema);
        Ok(created)
    })
    .await
}

/// `db_get_schema({ id }) → DbSchema`.
#[tauri::command]
pub async fn db_get_schema(app: AppHandle, req: IdReq) -> ApiResult<DbSchema> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let schema = app.state::<AppState>().session()?.db_get_schema(&req.id)?;
        note_schema(&schema);
        Ok(schema)
    })
    .await
}

/// `db_update` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DbUpdateReq {
    id: String,
    patch: DbPatch,
}

/// `db_update({ id, patch: { description?, templates?, defaultTemplateId?, hideEmptyProps?, inline? } }) → DbSchema`.
#[tauri::command]
pub async fn db_update(app: AppHandle, req: DbUpdateReq) -> ApiResult<DbSchema> {
    validate::id("id", &req.id)?;
    if let Some(t) = &req.patch.templates {
        validate::list_len("patch.templates", t.len(), 100)?;
        for tpl in t {
            validate::title("patch.templates.name", &tpl.name)?;
        }
    }
    if let Some(Some(t)) = &req.patch.default_template_id {
        validate::id("patch.defaultTemplateId", t)?;
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let schema = store.db_update(&req.id, req.patch)?;
        emit_db_changed(&state, &store, &req.id, None);
        Ok(schema)
    })
    .await
}

/// `db_duplicate` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DbDuplicateReq {
    id: String,
    with_rows: bool,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `db_duplicate` result.
#[derive(Debug, Serialize)]
pub struct PageDto {
    /// The new page.
    pub page: PageMeta,
}

/// `db_duplicate({ id, withRows, onEvent })` (job) ⇒ `{ page }`.
#[tauri::command]
pub async fn db_duplicate(
    webview: Webview,
    state: State<'_, AppState>,
    req: DbDuplicateReq,
) -> ApiResult<JobRef> {
    validate::id("id", &req.id)?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    Ok(state
        .jobs
        .spawn("db_duplicate", true, store.now(), sink, move |ctx| {
            let page = store
                .db_duplicate(&req.id, req.with_rows, ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))?;
            Ok(PageDto { page })
        }))
}

// ───────────────────────────────────────────────────────────────────────────── properties

/// `db_property_create` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyCreateReq {
    database_id: String,
    name: String,
    #[serde(rename = "type")]
    kind: PropType,
    #[serde(default)]
    config: Option<Map<String, Value>>,
    #[serde(default)]
    after_id: Option<String>,
}

/// `db_property_create({ databaseId, name, type, config?, afterId? }) → Property` (two-way relations create their dual
/// atomically).
#[tauri::command]
pub async fn db_property_create(app: AppHandle, req: PropertyCreateReq) -> ApiResult<Property> {
    validate::id("databaseId", &req.database_id)?;
    validate::non_empty("name", &req.name, validate::MAX_TITLE)?;
    validate::title("name", &req.name)?;
    validate::opt_id("afterId", req.after_id.as_deref())?;
    check_config("config", req.config.as_ref())?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let p = store.db_property_create(
            &req.database_id,
            &req.name,
            req.kind,
            req.config,
            req.after_id.as_deref(),
        )?;
        note_owner(&p.id, &req.database_id);
        emit_db_changed(&state, &store, &req.database_id, None);
        Ok(p)
    })
    .await
}

/// `db_property_update` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyUpdateReq {
    id: String,
    patch: PropertyPatch,
}

/// `db_property_update({ id, patch: { name?, config?, hidden?, description? } }) → Property`.
#[tauri::command]
pub async fn db_property_update(app: AppHandle, req: PropertyUpdateReq) -> ApiResult<Property> {
    validate::id("id", &req.id)?;
    if let Some(n) = &req.patch.name {
        validate::non_empty("patch.name", n, validate::MAX_TITLE)?;
        validate::title("patch.name", n)?;
    }
    if let Some(d) = &req.patch.description {
        validate::bounded("patch.description", d, 4_096)?;
    }
    check_config("patch.config", req.patch.config.as_ref())?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let p = store.db_property_update(&req.id, req.patch)?;
        emit_for_owner(&state, &store, &req.id);
        Ok(p)
    })
    .await
}

/// `db_property_convert` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyConvertReq {
    id: String,
    to: PropType,
    #[serde(default)]
    config: Option<Map<String, Value>>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `db_property_convert({ id, to, config?, onEvent })` (job) ⇒ `Property` (a `pre_bulk` schema version keeps the old
/// values restorable).
#[tauri::command]
pub async fn db_property_convert(
    webview: Webview,
    state: State<'_, AppState>,
    req: PropertyConvertReq,
) -> ApiResult<JobRef> {
    validate::id("id", &req.id)?;
    check_config("config", req.config.as_ref())?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("db_property_convert", false, store.now(), sink, move |ctx| {
            let p = store.db_property_convert(&req.id, req.to, req.config, ctx)?;
            emit_for_owner(&app.state::<AppState>(), &store, &req.id);
            Ok(p)
        }))
}

/// `db_property_delete` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyDeleteReq {
    id: String,
    #[serde(default)]
    also_dual: Option<bool>,
}

/// `db_property_delete({ id, alsoDual? }) → void` (soft: restorable from Trash).
#[tauri::command]
pub async fn db_property_delete(app: AppHandle, req: PropertyDeleteReq) -> ApiResult<()> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        store.db_property_delete(&req.id, req.also_dual.unwrap_or(false))?;
        emit_for_owner(&state, &store, &req.id);
        Ok(())
    })
    .await
}

/// A `{ id, beforeId?, afterId? }` reorder request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderReq {
    id: String,
    #[serde(default)]
    before_id: Option<String>,
    #[serde(default)]
    after_id: Option<String>,
}

impl ReorderReq {
    fn check(&self) -> ApiResult<()> {
        validate::id("id", &self.id)?;
        validate::opt_id("beforeId", self.before_id.as_deref())?;
        validate::opt_id("afterId", self.after_id.as_deref())
    }
}

/// `db_property_reorder({ id, beforeId?, afterId? }) → Property`.
#[tauri::command]
pub async fn db_property_reorder(app: AppHandle, req: ReorderReq) -> ApiResult<Property> {
    req.check()?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let p = store.db_property_reorder(&req.id, req.before_id.as_deref(), req.after_id.as_deref())?;
        emit_for_owner(&state, &store, &req.id);
        Ok(p)
    })
    .await
}

/// `db_select_option_upsert` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptionUpsertReq {
    property_id: String,
    option: SelectOptionInput,
}

/// `db_select_option_upsert({ propertyId, option: { id?, name, color, group? } }) → Property`.
#[tauri::command]
pub async fn db_select_option_upsert(app: AppHandle, req: OptionUpsertReq) -> ApiResult<Property> {
    validate::id("propertyId", &req.property_id)?;
    validate::title("option.name", &req.option.name)?;
    if let Some(id) = &req.option.id {
        validate::bounded("option.id", id, 64)?;
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let p = store.db_select_option_upsert(&req.property_id, req.option)?;
        emit_for_owner(&state, &store, &req.property_id);
        Ok(p)
    })
    .await
}

/// `db_select_option_delete` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptionDeleteReq {
    property_id: String,
    option_id: String,
}

/// `db_select_option_delete({ propertyId, optionId }) → Property`.
#[tauri::command]
pub async fn db_select_option_delete(app: AppHandle, req: OptionDeleteReq) -> ApiResult<Property> {
    validate::id("propertyId", &req.property_id)?;
    validate::non_empty("optionId", &req.option_id, 64)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let p = store.db_select_option_delete(&req.property_id, &req.option_id)?;
        emit_for_owner(&state, &store, &req.property_id);
        Ok(p)
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── queries

fn check_filter(field: &str, f: &Filter, depth: usize) -> ApiResult<()> {
    if depth > 16 {
        return Err(ApiError::invalid(field, "filter is nested too deeply"));
    }
    match f {
        Filter::And { and } => {
            validate::list_len(field, and.len(), 100)?;
            and.iter().try_for_each(|x| check_filter(field, x, depth + 1))
        }
        Filter::Or { or } => {
            validate::list_len(field, or.len(), 100)?;
            or.iter().try_for_each(|x| check_filter(field, x, depth + 1))
        }
        other => {
            let size = serde_json::to_vec(other).map(|v| v.len()).unwrap_or(usize::MAX);
            if size > 16 * 1024 {
                return Err(ApiError::invalid(field, "filter value is too large"));
            }
            Ok(())
        }
    }
}

/// `db_query({ databaseId, viewId?, override?, window, group?, props?, knownQueryRev?, reqId })`
/// → `{ reqId, notModified: true } | { reqId, queryRev, total, rows, groups?, aggs, tookMs }`.
#[tauri::command]
pub async fn db_query(app: AppHandle, req: QueryRequest) -> ApiResult<QueryResponse> {
    validate::id("databaseId", &req.database_id)?;
    validate::opt_id("viewId", req.view_id.as_deref())?;
    if req.window.limit == 0 || req.window.limit > validate::MAX_WINDOW {
        return Err(ApiError::invalid("window.limit", "must be 1–500"));
    }
    if let Some(o) = &req.override_ {
        if let Some(s) = &o.search {
            validate::query("override.search", s)?;
        }
        if let Some(f) = &o.filter {
            check_filter("override.filter", f, 0)?;
        }
        if let Some(s) = &o.sorts {
            validate::list_len("override.sorts", s.len(), 32)?;
        }
    }
    if let Some(g) = &req.group {
        validate::bounded("group", g, validate::MAX_TITLE)?;
    }
    if let Some(p) = &req.props {
        validate::list_len("props", p.len(), 1_000)?;
    }
    if let Some(k) = &req.known_query_rev {
        validate::bounded("knownQueryRev", k, 128)?;
    }
    blocking(move || {
        let db = req.database_id.clone();
        let r = app.state::<AppState>().session()?.db_query(req)?;
        if let QueryResponse::Rows(q) = &r {
            note_rows(&db, &q.rows);
        }
        Ok(r)
    })
    .await
}

/// `db_query_range` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryRangeReq {
    database_id: String,
    view_id: String,
    date_prop: String,
    from: String,
    to: String,
}

/// `db_query_range({ databaseId, viewId, dateProp, from, to }) → RowDTO[]` (calendar windows).
#[tauri::command]
pub async fn db_query_range(app: AppHandle, req: QueryRangeReq) -> ApiResult<Vec<RowDto>> {
    validate::id("databaseId", &req.database_id)?;
    validate::id("viewId", &req.view_id)?;
    validate::id("dateProp", &req.date_prop)?;
    let from = validate::ymd("from", &req.from)?;
    let to = validate::ymd("to", &req.to)?;
    if to < from {
        return Err(ApiError::invalid("to", "must not be before from"));
    }
    if (to - from).num_days() > 400 {
        return Err(ApiError::invalid("to", "ranges are limited to 400 days"));
    }
    blocking(move || {
        let rows = app.state::<AppState>().session()?.db_query_range(
            &req.database_id,
            &req.view_id,
            &req.date_prop,
            &req.from,
            &req.to,
        )?;
        note_rows(&req.database_id, &rows);
        Ok(rows)
    })
    .await
}

/// `db_chart_data` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDataReq {
    database_id: String,
    #[serde(default)]
    view_id: Option<String>,
    #[serde(default)]
    filter: Option<Filter>,
    spec: ChartSpec,
    #[serde(default)]
    max_points: Option<u32>,
}

/// `db_chart_data({ databaseId, viewId?, filter?, spec, maxPoints? }) → { x, series, currency? }`.
#[tauri::command]
pub async fn db_chart_data(app: AppHandle, req: ChartDataReq) -> ApiResult<ChartData> {
    validate::id("databaseId", &req.database_id)?;
    validate::opt_id("viewId", req.view_id.as_deref())?;
    if let Some(f) = &req.filter {
        check_filter("filter", f, 0)?;
    }
    if let Some(m) = req.max_points {
        validate::limit("maxPoints", m, 10_000)?;
    }
    blocking(move || {
        Ok(app.state::<AppState>().session()?.db_chart_data(
            &req.database_id,
            req.view_id.as_deref(),
            req.filter,
            &req.spec,
            req.max_points.map(|m| m as usize),
        )?)
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── rows

/// `db_row_get({ id }) → { row, doc, docRev, databaseId, prevId?, nextId? }`.
#[tauri::command]
pub async fn db_row_get(app: AppHandle, req: IdReq) -> ApiResult<RowGet> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let got = app.state::<AppState>().session()?.db_row_get(&req.id)?;
        note_owner(&got.row.id, &got.database_id);
        Ok(got)
    })
    .await
}

/// `db_row_create({ databaseId, values?, afterId?, viewId?, templateId? }) → RowDTO`.
#[tauri::command]
pub async fn db_row_create(app: AppHandle, req: RowCreate) -> ApiResult<RowDto> {
    validate::id("databaseId", &req.database_id)?;
    validate::opt_id("afterId", req.after_id.as_deref())?;
    validate::opt_id("viewId", req.view_id.as_deref())?;
    validate::opt_id("templateId", req.template_id.as_deref())?;
    if let Some(v) = &req.values {
        validate::list_len("values", v.len(), 1_000)?;
        for (k, c) in v {
            validate::id("values", k)?;
            check_cell("values", c)?;
        }
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let db = req.database_id.clone();
        let row = store.db_row_create(req)?;
        note_owner(&row.id, &db);
        emit_db_changed(&state, &store, &db, Some(vec![row.id.clone()]));
        Ok(row)
    })
    .await
}

/// `db_rows_update` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowsUpdateReq {
    updates: Vec<RowUpdate>,
}

fn emit_rows(state: &AppState, store: &Store, rows: &[String]) {
    let mut by_db: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in rows {
        if let Ok(db) = row_owner(store, id) {
            by_db.entry(db).or_default().push(id.clone());
        }
    }
    for (db, ids) in by_db {
        emit_db_changed(state, store, &db, Some(ids));
    }
}

/// `db_rows_update({ updates: { id, values, baseRev? }[] }) → RowDTO[]` (≤ 1,000 per call; `CONFLICT` on a stale
/// `baseRev`).
#[tauri::command]
pub async fn db_rows_update(app: AppHandle, req: RowsUpdateReq) -> ApiResult<Vec<RowDto>> {
    if req.updates.is_empty() {
        return Err(ApiError::invalid("updates", "must not be empty"));
    }
    validate::list_len("updates", req.updates.len(), MAX_BATCH)?;
    for u in &req.updates {
        validate::id("updates.id", &u.id)?;
        check_values("updates.values", &u.values)?;
        if u.base_rev.is_some_and(|r| r < 0) {
            return Err(ApiError::invalid("updates.baseRev", "must not be negative"));
        }
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let ids: Vec<String> = req.updates.iter().map(|u| u.id.clone()).collect();
        // Resolve owners before the write so rows are attributed even if the cache was cold.
        for id in &ids {
            let _ = row_owner(&store, id);
        }
        let rows = store.db_rows_update(req.updates)?;
        emit_rows(&state, &store, &ids);
        Ok(rows)
    })
    .await
}

/// `db_rows_delete({ ids }) → void` (soft; restorable).
#[tauri::command]
pub async fn db_rows_delete(app: AppHandle, req: IdsReq) -> ApiResult<()> {
    let ids = req.ids;
    check_rows_window(&ids)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        for id in &ids {
            let _ = row_owner(&store, id);
        }
        store.db_rows_delete(&ids)?;
        emit_rows(&state, &store, &ids);
        Ok(())
    })
    .await
}

/// `db_rows_restore({ ids }) → RowDTO[]`.
#[tauri::command]
pub async fn db_rows_restore(app: AppHandle, req: IdsReq) -> ApiResult<Vec<RowDto>> {
    let ids = req.ids;
    check_rows_window(&ids)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let rows = store.db_rows_restore(&ids)?;
        emit_rows(&state, &store, &ids);
        Ok(rows)
    })
    .await
}

/// `db_rows_move` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowsMoveReq {
    ids: Vec<String>,
    #[serde(default)]
    before_id: Option<String>,
    #[serde(default)]
    after_id: Option<String>,
    #[serde(default)]
    group_value: Option<GroupValue>,
}

/// `db_rows_move({ ids, beforeId?, afterId?, groupValue? }) → RowDTO[]` (manual order; dropping on a board column sets
/// the grouped value).
#[tauri::command]
pub async fn db_rows_move(app: AppHandle, req: RowsMoveReq) -> ApiResult<Vec<RowDto>> {
    check_rows_window(&req.ids)?;
    validate::opt_id("beforeId", req.before_id.as_deref())?;
    validate::opt_id("afterId", req.after_id.as_deref())?;
    if let Some(g) = &req.group_value {
        validate::id("groupValue.prop", &g.prop)?;
        check_cell("groupValue.value", &g.value)?;
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let rows = store.db_rows_move(
            &req.ids,
            req.before_id.as_deref(),
            req.after_id.as_deref(),
            req.group_value,
        )?;
        emit_rows(&state, &store, &req.ids);
        Ok(rows)
    })
    .await
}

/// `db_rows_duplicate({ ids }) → RowDTO[]`.
#[tauri::command]
pub async fn db_rows_duplicate(app: AppHandle, req: IdsReq) -> ApiResult<Vec<RowDto>> {
    let ids = req.ids;
    check_rows_window(&ids)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let db = row_owner(&store, &ids[0]).ok();
        let rows = store.db_rows_duplicate(&ids)?;
        if let Some(db) = db {
            note_rows(&db, &rows);
            emit_db_changed(&state, &store, &db, Some(rows.iter().map(|r| r.id.clone()).collect()));
        }
        Ok(rows)
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── views

/// `db_view_create` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewCreateReq {
    database_id: String,
    name: String,
    layout: Layout,
    #[serde(default)]
    from_view_id: Option<String>,
}

/// `db_view_create({ databaseId, name, layout, fromViewId? }) → View`.
#[tauri::command]
pub async fn db_view_create(app: AppHandle, req: ViewCreateReq) -> ApiResult<View> {
    validate::id("databaseId", &req.database_id)?;
    validate::title("name", &req.name)?;
    validate::opt_id("fromViewId", req.from_view_id.as_deref())?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let v = store.db_view_create(&req.database_id, &req.name, req.layout, req.from_view_id.as_deref())?;
        note_owner(&v.id, &req.database_id);
        emit_db_changed(&state, &store, &req.database_id, None);
        Ok(v)
    })
    .await
}

/// `db_view_update` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewUpdateReq {
    id: String,
    patch: ViewPatch,
}

/// `db_view_update({ id, patch: Partial<View> }) → View`.
#[tauri::command]
pub async fn db_view_update(app: AppHandle, req: ViewUpdateReq) -> ApiResult<View> {
    validate::id("id", &req.id)?;
    let p = &req.patch;
    if let Some(n) = &p.name {
        validate::title("patch.name", n)?;
    }
    if let Some(Some(f)) = &p.filter {
        check_filter("patch.filter", f, 0)?;
    }
    if let Some(s) = &p.sorts {
        validate::list_len("patch.sorts", s.len(), 32)?;
    }
    if let Some(v) = &p.visible_props {
        validate::list_len("patch.visibleProps", v.len(), 1_000)?;
    }
    if let Some(w) = &p.prop_widths {
        validate::list_len("patch.propWidths", w.len(), 1_000)?;
        for x in w.values() {
            validate::finite("patch.propWidths", *x)?;
        }
    }
    if let Some(c) = &p.collapsed_groups {
        validate::list_len("patch.collapsedGroups", c.len(), 1_000)?;
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let v = store.db_view_update(&req.id, req.patch)?;
        emit_for_owner(&state, &store, &req.id);
        Ok(v)
    })
    .await
}

/// `db_view_delete({ id }) → void`.
#[tauri::command]
pub async fn db_view_delete(app: AppHandle, req: IdReq) -> ApiResult<()> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        store.db_view_delete(&req.id)?;
        emit_for_owner(&state, &store, &req.id);
        Ok(())
    })
    .await
}

/// `db_view_reorder({ id, beforeId?, afterId? }) → View`.
#[tauri::command]
pub async fn db_view_reorder(app: AppHandle, req: ReorderReq) -> ApiResult<View> {
    req.check()?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let v = store.db_view_reorder(&req.id, req.before_id.as_deref(), req.after_id.as_deref())?;
        emit_for_owner(&state, &store, &req.id);
        Ok(v)
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── relations, formulas

/// `db_relation_options` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationOptionsReq {
    property_id: String,
    search: String,
    limit: u32,
}

/// `db_relation_options({ propertyId, search, limit }) → { id, title, icon? }[]`.
#[tauri::command]
pub async fn db_relation_options(app: AppHandle, req: RelationOptionsReq) -> ApiResult<Vec<RelationOption>> {
    validate::id("propertyId", &req.property_id)?;
    validate::query("search", &req.search)?;
    let limit = validate::limit("limit", req.limit, validate::MAX_LIST)?;
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .db_relation_options(&req.property_id, &req.search, limit)?)
    })
    .await
}

/// `db_formula_check` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormulaCheckReq {
    database_id: String,
    expression: String,
}

/// `db_formula_check({ databaseId, expression }) → { ok, type?, error?, preview }` (Row dialect, §14.6).
#[tauri::command]
pub async fn db_formula_check(app: AppHandle, req: FormulaCheckReq) -> ApiResult<FormulaCheck> {
    validate::id("databaseId", &req.database_id)?;
    validate::formula("expression", &req.expression)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        crate::jobs::catch_panics(|| store.db_formula_check(&req.database_id, &req.expression))
            .map_err(|_| ApiError::internal("formula check panicked"))?
            .map_err(Into::into)
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── import / export

/// `db_import_preview({ grantId }) → { columns, rows, delimiter, encoding, sheets? }`. The file stays staged for the
/// `db_import_csv` that follows.
#[tauri::command]
pub async fn db_import_preview(app: AppHandle, req: super::import::GrantReq) -> ApiResult<ImportPreview> {
    validate::grant_id("grantId", &req.grant_id)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let f: InputFile = take_file(&state, &req.grant_id, &[GrantPurpose::Import], caps::TABLE)?;
        let preview = crate::jobs::catch_panics(|| store.db_import_preview(&f.name, &f.bytes))
            .map_err(|_| ApiError::invalid("grantId", "This file could not be read"))??;
        stage(&req.grant_id, &f);
        Ok(preview)
    })
    .await
}

/// `db_import_csv` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportCsvReq {
    grant_id: String,
    target: TableTarget,
    #[serde(default)]
    sheet: Option<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `db_import_csv({ grantId, target: { databaseId, mapping } | { workspaceId, parentId, title }, onEvent })` (job)
/// ⇒ `{ databaseId, inserted, importId, warnings }`. CSV, TSV and XLSX (`sheet` picks a worksheet).
#[tauri::command]
pub async fn db_import_csv(
    webview: Webview,
    state: State<'_, AppState>,
    req: ImportCsvReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    match &req.target {
        TableTarget::Existing {
            database_id,
            mapping,
        } => {
            validate::id("target.databaseId", database_id)?;
            validate::list_len("target.mapping", mapping.len(), 1_000)?;
            for (k, v) in mapping {
                validate::bounded("target.mapping", k, validate::MAX_TITLE)?;
                if v != "new" && v != "skip" {
                    validate::id("target.mapping", v)?;
                }
            }
        }
        TableTarget::New {
            workspace_id,
            parent_id,
            title,
        } => {
            validate::id("target.workspaceId", workspace_id)?;
            validate::opt_id("target.parentId", parent_id.as_deref())?;
            validate::title("target.title", title)?;
        }
    }
    if let Some(s) = &req.sheet {
        validate::title("sheet", s)?;
    }
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    let cell = import_cell();
    let out = std::sync::Arc::clone(&cell);
    let job = state
        .jobs
        .spawn("db_import_csv", true, store.now(), sink, move |ctx| {
            let state = app.state::<AppState>();
            let f = take_file(&state, &req.grant_id, &[GrantPurpose::Import], caps::TABLE)?;
            let r = store
                .db_import_table(&f.name, &f.bytes, req.target, req.sheet.as_deref(), ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))?;
            *out.lock() = Some(r.import_id.clone());
            emit_db_changed(&state, &store, &r.database_id, None);
            Ok(r)
        });
    remember_job(&job, cell);
    Ok(job)
}

/// Export formats of `db_export`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableFormat {
    /// CSV (formula-injection protected).
    Csv,
    /// XLSX.
    Xlsx,
}

/// `db_export` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DbExportReq {
    database_id: String,
    #[serde(default)]
    view_id: Option<String>,
    format: TableFormat,
    grant_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `db_export({ databaseId, viewId?, format: 'csv'|'xlsx', grantId, onEvent })` (job) ⇒ `{ rows }`.
#[tauri::command]
pub async fn db_export(
    webview: Webview,
    state: State<'_, AppState>,
    req: DbExportReq,
) -> ApiResult<JobRef> {
    validate::id("databaseId", &req.database_id)?;
    validate::opt_id("viewId", req.view_id.as_deref())?;
    validate::grant_id("grantId", &req.grant_id)?;
    let store = state.session()?;
    let target = super::import::take_export_target(&state, &req.grant_id)?;
    let sink = job_sink(&webview, &req.on_event);
    Ok(state
        .jobs
        .spawn("db_export", true, store.now(), sink, move |ctx| {
            let format = match req.format {
                TableFormat::Csv => "csv",
                TableFormat::Xlsx => "xlsx",
            };
            let (bytes, rows) = store
                .db_export(&req.database_id, req.view_id.as_deref(), format, ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))?;
            ctx.check_cancelled()?;
            super::import::write_atomic(&target, &bytes)?;
            Ok(json!({ "rows": rows }))
        }))
}

// ───────────────────────────────────────────────────────────────────────────── secrets

/// `row_secret_reveal` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretRevealReq {
    row_id: String,
    property_id: String,
}

/// `row_secret_reveal` result (the only command that returns a secret; the UI clears it after 30 s).
#[derive(Serialize)]
pub struct SecretValueDto {
    value: String,
}

impl std::fmt::Debug for SecretValueDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValueDto(***)")
    }
}

/// `row_secret_reveal({ rowId, propertyId }) (reauth) → { value }`.
#[tauri::command]
pub async fn row_secret_reveal(app: AppHandle, req: SecretRevealReq) -> ApiResult<SecretValueDto> {
    validate::id("rowId", &req.row_id)?;
    validate::id("propertyId", &req.property_id)?;
    blocking(move || {
        let store = app.state::<AppState>().require_reauth()?;
        let secret = store.row_secret_reveal(&req.row_id, &req.property_id)?;
        Ok(SecretValueDto {
            value: secret.expose_secret().to_owned(),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use emp_store::dbmodel::rich;

    #[test]
    fn db_changed_shape() {
        let v = serde_json::to_value(DbChanged {
            database_id: "d".into(),
            data_rev: 3,
            schema_rev: 2,
            row_ids: None,
        })
        .unwrap();
        assert_eq!(v, json!({ "databaseId": "d", "dataRev": 3, "schemaRev": 2 }));
    }

    #[test]
    fn owner_cache_records_and_resets() {
        note_owner("row-a", "db-1");
        assert_eq!(cached_owner("row-a").as_deref(), Some("db-1"));
        assert!(cached_owner("row-missing").is_none());
    }

    #[test]
    fn cells_are_bounded() {
        assert!(check_cell("v", &CellValue::Number { v: Some(f64::NAN) }).is_err());
        assert!(check_cell("v", &CellValue::Number { v: Some(1.5) }).is_ok());
        assert!(check_cell("v", &CellValue::Money { v: Some("1.123456789".into()), cur: "USD".into() }).is_err());
        assert!(check_cell("v", &CellValue::Money { v: Some("-12.50".into()), cur: "USD".into() }).is_ok());
        assert!(check_cell("v", &CellValue::Text { v: rich("hi") }).is_ok());
        assert!(check_cell("v", &CellValue::Url { v: Some("x".repeat(5_000)) }).is_err());
    }

    #[test]
    fn requests_deny_unknown_fields() {
        let ok: Result<RowsMoveReq, _> = serde_json::from_value(json!({ "ids": ["a"], "afterId": "b" }));
        assert!(ok.is_ok());
        let bad: Result<RowsMoveReq, _> = serde_json::from_value(json!({ "ids": ["a"], "path": "/etc" }));
        assert!(bad.is_err());
        let q: QueryRequest = serde_json::from_value(json!({
            "databaseId": "d", "window": { "offset": 0, "limit": 50 }, "reqId": 7,
            "override": { "search": "x", "groupBy": null }
        }))
        .unwrap();
        assert_eq!(q.req_id, 7);
    }

    #[test]
    fn filters_are_depth_limited() {
        let mut f = Filter::And { and: vec![] };
        for _ in 0..20 {
            f = Filter::And { and: vec![f] };
        }
        assert!(check_filter("filter", &f, 0).is_err());
        assert!(check_filter("filter", &Filter::Or { or: vec![] }, 0).is_ok());
    }

    #[test]
    fn import_targets_parse_both_shapes() {
        let a: ImportCsvReq = serde_json::from_value(json!({
            "grantId": "0123456789abcdef0123456789abcdef",
            "target": { "databaseId": "d", "mapping": { "Name": "new" } },
            "onEvent": "__CHANNEL__:1"
        }))
        .unwrap();
        assert!(matches!(a.target, TableTarget::Existing { .. }));
        let b: ImportCsvReq = serde_json::from_value(json!({
            "grantId": "0123456789abcdef0123456789abcdef",
            "target": { "workspaceId": "w", "parentId": null, "title": "T" },
            "onEvent": "__CHANNEL__:1"
        }))
        .unwrap();
        assert!(matches!(b.target, TableTarget::New { .. }));
    }
}
