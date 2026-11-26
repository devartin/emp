//! Sheet commands (SPEC §11.3 "Sheets", §14, §9.17).
//!
//! Validated wrappers over `emp-store`'s workbook repositories, which own the `emp-sheets` engines, persistence and
//! undo. Before the first sheet command of a vault the market-backed formula host ([`super::market::MarketHost`]) is
//! installed, so `STOCK`, `FX` and `CRYPTO` read the quote / FX caches and queue fetches for misses. Evaluation runs
//! inside `catch_panics` so a formula bug cannot take the session down.

use emp_sheets::workbook::sheet::CondFormatRule;
use emp_sheets::{
    Axis, CellEdit, CellInfo, ClearWhat, CopyResult, FillMode, FunctionInfo, PasteMode, Rect, StylePatch,
};
use emp_store::Store;
use emp_store::repo::sheets::{EditResult, RangeResult, SheetPatch, SortSpec, StyleResult};
use emp_store::repo::workbooks::{EvalResult, FindHit, LintItem, SheetMeta, WorkbookCreated, WorkbookInfo};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, Webview};

use super::db::PageDto;
use super::import::{caps, cancelled_or, take_file};
use super::job_sink;
use super::workspaces::IdReq;
use crate::error::{ApiError, ApiResult};
use crate::grants::GrantPurpose;
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Excel's grid (§9.16): 1,048,576 rows × 16,384 columns.
pub const MAX_ROWS: u32 = 1_048_576;
/// Columns.
pub const MAX_COLS: u32 = 16_384;
/// Edits per `sheet_set_cells`.
pub const MAX_EDITS: usize = 100_000;
/// Rectangles per style / clear call.
pub const MAX_RECTS: usize = 1_000;
/// Clipboard payloads.
pub const MAX_CLIP: usize = 32 * 1024 * 1024;

fn session(app: &AppHandle) -> ApiResult<Store> {
    let store = app.state::<AppState>().session()?;
    super::market::ensure_sheet_host(app, &store);
    Ok(store)
}

fn guarded<T>(f: impl FnOnce() -> emp_store::Result<T>) -> ApiResult<T> {
    crate::jobs::catch_panics(f)
        .map_err(|_| ApiError::internal("sheet engine panicked"))?
        .map_err(Into::into)
}

/// Validates a rectangle against the grid.
pub fn rect(field: &str, r: &Rect) -> ApiResult<()> {
    if r.r1 < r.r0 || r.c1 < r.c0 || r.r1 >= MAX_ROWS || r.c1 >= MAX_COLS {
        return Err(ApiError::invalid(field, "invalid rectangle"));
    }
    Ok(())
}

fn rects(field: &str, v: &[Rect]) -> ApiResult<()> {
    if v.is_empty() {
        return Err(ApiError::invalid(field, "must not be empty"));
    }
    validate::list_len(field, v.len(), MAX_RECTS)?;
    v.iter().try_for_each(|r| rect(field, r))
}

fn cell(field: &str, row: u32, col: u32) -> ApiResult<()> {
    if row >= MAX_ROWS || col >= MAX_COLS {
        return Err(ApiError::invalid(field, "outside the grid"));
    }
    Ok(())
}

fn span(axis: Axis, at: u32, count: u32) -> ApiResult<()> {
    let max = match axis {
        Axis::Rows => MAX_ROWS,
        Axis::Cols => MAX_COLS,
    };
    if count == 0 || at >= max || at.saturating_add(count) > max {
        return Err(ApiError::invalid("count", "outside the grid"));
    }
    Ok(())
}

fn color(field: &str, s: &str) -> ApiResult<()> {
    let ok = s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'#' | b'(' | b')' | b',' | b'.' | b' ' | b'%'));
    if ok { Ok(()) } else { Err(ApiError::invalid(field, "invalid colour")) }
}

// ───────────────────────────────────────────────────────────────────────────── workbooks

/// `sheet_workbook_create` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbookCreateReq {
    workspace_id: String,
    parent_id: Option<String>,
    title: String,
    #[serde(default)]
    template: Option<String>,
}

/// `sheet_workbook_create({ workspaceId, parentId, title, template? }) → { page, sheets }`.
#[tauri::command]
pub async fn sheet_workbook_create(app: AppHandle, req: WorkbookCreateReq) -> ApiResult<WorkbookCreated> {
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    validate::title("title", &req.title)?;
    if let Some(t) = &req.template {
        validate::non_empty("template", t, 64)?;
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| {
            store.sheet_workbook_create(
                &req.workspace_id,
                req.parent_id.as_deref(),
                &req.title,
                req.template.as_deref(),
            )
        })
    })
    .await
}

/// `sheet_workbook_get({ id }) → { sheets, styles, namedRanges, calc }`.
#[tauri::command]
pub async fn sheet_workbook_get(app: AppHandle, req: IdReq) -> ApiResult<WorkbookInfo> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_workbook_get(&req.id))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── reads

/// A `{ sheetId, rect }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetRectReq {
    sheet_id: String,
    rect: Rect,
}

/// `sheet_get_range({ sheetId, rect }) → { rev, cells, rowHeights, colWidths, merges, cf }` (≤ 1,000,000 cells).
#[tauri::command]
pub async fn sheet_get_range(app: AppHandle, req: SheetRectReq) -> ApiResult<RangeResult> {
    validate::id("sheetId", &req.sheet_id)?;
    rect("rect", &req.rect)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_get_range(&req.sheet_id, req.rect))
    })
    .await
}

/// `sheet_get_cell` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetCellReq {
    sheet_id: String,
    row: u32,
    col: u32,
}

/// `sheet_get_cell({ sheetId, row, col }) → { input, display, kind, error?, styleId, precedents, spillOf? }`.
#[tauri::command]
pub async fn sheet_get_cell(app: AppHandle, req: GetCellReq) -> ApiResult<CellInfo> {
    validate::id("sheetId", &req.sheet_id)?;
    cell("row", req.row, req.col)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_get_cell(&req.sheet_id, req.row, req.col))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── edits

/// `sheet_set_cells` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCellsReq {
    sheet_id: String,
    edits: Vec<CellEdit>,
    visible: Rect,
    #[serde(default)]
    undo_group: Option<String>,
}

/// `sheet_set_cells({ sheetId, edits, visible, undoGroup? }) → { rev, changed, dirtyRects, recalcMs, errors? }`.
#[tauri::command]
pub async fn sheet_set_cells(app: AppHandle, req: SetCellsReq) -> ApiResult<EditResult> {
    validate::id("sheetId", &req.sheet_id)?;
    rect("visible", &req.visible)?;
    if req.edits.is_empty() {
        return Err(ApiError::invalid("edits", "must not be empty"));
    }
    validate::list_len("edits", req.edits.len(), MAX_EDITS)?;
    for e in &req.edits {
        cell("edits", e.row, e.col)?;
        if let Some(i) = &e.input {
            validate::formula("edits.input", i)?;
        }
    }
    if let Some(g) = &req.undo_group {
        validate::bounded("undoGroup", g, 128)?;
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_set_cells(&req.sheet_id, req.edits, req.visible, req.undo_group))
    })
    .await
}

/// `sheet_set_style` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetStyleReq {
    sheet_id: String,
    rects: Vec<Rect>,
    patch: StylePatch,
}

/// `sheet_set_style({ sheetId, rects, patch }) → { styles, changed }`.
#[tauri::command]
pub async fn sheet_set_style(app: AppHandle, req: SetStyleReq) -> ApiResult<StyleResult> {
    validate::id("sheetId", &req.sheet_id)?;
    rects("rects", &req.rects)?;
    let size = serde_json::to_vec(&req.patch).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > 16 * 1024 {
        return Err(ApiError::invalid("patch", "style is too large"));
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_set_style(&req.sheet_id, req.rects, req.patch))
    })
    .await
}

/// `sheet_clear` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearReq {
    sheet_id: String,
    rects: Vec<Rect>,
    what: ClearWhat,
}

/// `sheet_clear({ sheetId, rects, what: 'all'|'contents'|'formats' }) → { changed, dirtyRects }`.
#[tauri::command]
pub async fn sheet_clear(app: AppHandle, req: ClearReq) -> ApiResult<EditResult> {
    validate::id("sheetId", &req.sheet_id)?;
    rects("rects", &req.rects)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_clear(&req.sheet_id, req.rects, req.what))
    })
    .await
}

/// `sheet_insert` / `sheet_delete_span` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpanReq {
    sheet_id: String,
    axis: Axis,
    at: u32,
    count: u32,
}

/// A `{ rev }` result.
#[derive(Debug, Serialize)]
pub struct RevDto {
    rev: i64,
}

/// `sheet_insert({ sheetId, axis, at, count }) → { rev }` (references shift like Excel).
#[tauri::command]
pub async fn sheet_insert(app: AppHandle, req: SpanReq) -> ApiResult<RevDto> {
    validate::id("sheetId", &req.sheet_id)?;
    span(req.axis, req.at, req.count)?;
    blocking(move || {
        let store = session(&app)?;
        let rev = guarded(|| store.sheet_insert(&req.sheet_id, req.axis, req.at, req.count))?;
        Ok(RevDto { rev })
    })
    .await
}

/// `sheet_delete_span({ sheetId, axis, at, count }) → { rev }` (references into the span become `#REF!`).
#[tauri::command]
pub async fn sheet_delete_span(app: AppHandle, req: SpanReq) -> ApiResult<RevDto> {
    validate::id("sheetId", &req.sheet_id)?;
    span(req.axis, req.at, req.count)?;
    blocking(move || {
        let store = session(&app)?;
        let rev = guarded(|| store.sheet_delete_span(&req.sheet_id, req.axis, req.at, req.count))?;
        Ok(RevDto { rev })
    })
    .await
}

/// `sheet_resize.size`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ResizeSize {
    /// Pixels.
    Px(f64),
    /// `'auto'`: fit content.
    Auto(AutoLiteral),
}

/// The literal `'auto'`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoLiteral {
    /// Auto size.
    Auto,
}

/// `sheet_resize` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeReq {
    sheet_id: String,
    axis: Axis,
    indices: Vec<u32>,
    size: ResizeSize,
}

/// `sheet_resize({ sheetId, axis, indices, size: number|'auto' }) → void`.
#[tauri::command]
pub async fn sheet_resize(app: AppHandle, req: ResizeReq) -> ApiResult<()> {
    validate::id("sheetId", &req.sheet_id)?;
    if req.indices.is_empty() {
        return Err(ApiError::invalid("indices", "must not be empty"));
    }
    validate::list_len("indices", req.indices.len(), MAX_COLS as usize)?;
    for i in &req.indices {
        span(req.axis, *i, 1)?;
    }
    let size = match req.size {
        ResizeSize::Px(x) => {
            validate::finite("size", x)?;
            if !(0.0..=4_096.0).contains(&x) {
                return Err(ApiError::invalid("size", "must be 0–4096"));
            }
            Some(x)
        }
        ResizeSize::Auto(_) => None,
    };
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_resize(&req.sheet_id, req.axis, req.indices, size))
    })
    .await
}

/// `sheet_merge` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeReq {
    sheet_id: String,
    rect: Rect,
    merge: bool,
}

/// `sheet_merge({ sheetId, rect, merge }) → void`.
#[tauri::command]
pub async fn sheet_merge(app: AppHandle, req: MergeReq) -> ApiResult<()> {
    validate::id("sheetId", &req.sheet_id)?;
    rect("rect", &req.rect)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_merge(&req.sheet_id, req.rect, req.merge))
    })
    .await
}

/// `sheet_freeze` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FreezeReq {
    sheet_id: String,
    rows: u32,
    cols: u32,
}

/// `sheet_freeze({ sheetId, rows, cols }) → SheetMeta`.
#[tauri::command]
pub async fn sheet_freeze(app: AppHandle, req: FreezeReq) -> ApiResult<SheetMeta> {
    validate::id("sheetId", &req.sheet_id)?;
    if req.rows > 1_000 || req.cols > 100 {
        return Err(ApiError::invalid("rows", "too many frozen rows or columns"));
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_freeze(&req.sheet_id, req.rows, req.cols))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── clipboard, fill, sort

/// `sheet_copy({ sheetId, rect }) → { tsv, html, clip }`.
#[tauri::command]
pub async fn sheet_copy(app: AppHandle, req: SheetRectReq) -> ApiResult<CopyResult> {
    validate::id("sheetId", &req.sheet_id)?;
    rect("rect", &req.rect)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_copy(&req.sheet_id, req.rect))
    })
    .await
}

/// A paste anchor.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct At {
    row: u32,
    col: u32,
}

/// `sheet_paste` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteReq {
    sheet_id: String,
    at: At,
    #[serde(default)]
    clip: Option<String>,
    #[serde(default)]
    tsv: Option<String>,
    #[serde(default)]
    html: Option<String>,
    mode: PasteMode,
    visible: Rect,
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Converts the first HTML `<table>` of a clipboard payload to TSV (plain text of each cell; markup is dropped).
#[must_use]
pub fn html_table_to_tsv(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<table")?;
    let end = lower[start..].find("</table>").map_or(lower.len(), |e| start + e);
    let body = &html[start..end];
    let lbody = &lower[start..end];
    let mut rows = Vec::new();
    let mut pos = 0;
    while let Some(tr) = lbody[pos..].find("<tr") {
        let tr_start = pos + tr;
        let tr_end = lbody[tr_start..].find("</tr>").map_or(lbody.len(), |e| tr_start + e);
        let mut cells = Vec::new();
        let mut cpos = tr_start;
        loop {
            let td = lbody[cpos..tr_end].find("<td").or_else(|| lbody[cpos..tr_end].find("<th"));
            let Some(td) = td else { break };
            let open = cpos + td;
            let Some(gt) = lbody[open..tr_end].find('>') else { break };
            let content_start = open + gt + 1;
            let close = ["</td>", "</th>"]
                .iter()
                .filter_map(|t| lbody[content_start..tr_end].find(t))
                .min()
                .map_or(tr_end, |c| content_start + c);
            let raw = &body[content_start..close];
            let mut text = String::new();
            let mut in_tag = false;
            for ch in raw.chars() {
                match ch {
                    '<' => in_tag = true,
                    '>' => in_tag = false,
                    c if !in_tag => text.push(c),
                    _ => {}
                }
            }
            let t = decode_entities(text.trim()).replace(['\t', '\n', '\r'], " ");
            cells.push(t);
            cpos = close;
            if cpos >= tr_end {
                break;
            }
        }
        rows.push(cells.join("\t"));
        pos = tr_end;
        if pos >= lbody.len() {
            break;
        }
    }
    (!rows.is_empty()).then(|| rows.join("\n"))
}

/// `sheet_paste({ sheetId, at, clip?, tsv?, html?, mode, visible }) → { changed, dirtyRects }`. The internal `clip`
/// wins (formulas and styles), then TSV, then the first HTML table (as text).
#[tauri::command]
pub async fn sheet_paste(app: AppHandle, req: PasteReq) -> ApiResult<EditResult> {
    validate::id("sheetId", &req.sheet_id)?;
    cell("at", req.at.row, req.at.col)?;
    rect("visible", &req.visible)?;
    for (f, v) in [("clip", &req.clip), ("tsv", &req.tsv), ("html", &req.html)] {
        if v.as_ref().is_some_and(|s| s.len() > MAX_CLIP) {
            return Err(ApiError::invalid(f, "clipboard content is too large"));
        }
    }
    let tsv = req.tsv.or_else(|| req.html.as_deref().and_then(html_table_to_tsv));
    if req.clip.is_none() && tsv.is_none() {
        return Err(ApiError::invalid("tsv", "nothing to paste"));
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| {
            store.sheet_paste(&req.sheet_id, (req.at.row, req.at.col), req.clip, tsv, req.mode, req.visible)
        })
    })
    .await
}

/// `sheet_fill` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FillReq {
    sheet_id: String,
    source: Rect,
    target: Rect,
    mode: FillMode,
}

/// `sheet_fill({ sheetId, source, target, mode: 'series'|'copy' }) → { changed }`.
#[tauri::command]
pub async fn sheet_fill(app: AppHandle, req: FillReq) -> ApiResult<EditResult> {
    validate::id("sheetId", &req.sheet_id)?;
    rect("source", &req.source)?;
    rect("target", &req.target)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_fill(&req.sheet_id, req.source, req.target, req.mode))
    })
    .await
}

/// `sheet_sort` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SortReq {
    sheet_id: String,
    rect: Rect,
    keys: Vec<SortSpec>,
    has_header: bool,
}

/// `sheet_sort({ sheetId, rect, keys, hasHeader }) → { changed }`.
#[tauri::command]
pub async fn sheet_sort(app: AppHandle, req: SortReq) -> ApiResult<EditResult> {
    validate::id("sheetId", &req.sheet_id)?;
    rect("rect", &req.rect)?;
    if req.keys.is_empty() {
        return Err(ApiError::invalid("keys", "must not be empty"));
    }
    validate::list_len("keys", req.keys.len(), 64)?;
    for k in &req.keys {
        cell("keys.col", 0, k.col)?;
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_sort(&req.sheet_id, req.rect, req.keys, req.has_header))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── find / replace

/// `sheet_find` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindReq {
    workbook_id: String,
    query: String,
    match_case: bool,
    whole_cell: bool,
    in_formulas: bool,
}

/// `sheet_find({ workbookId, query, matchCase, wholeCell, inFormulas }) → { sheetId, row, col }[]`.
#[tauri::command]
pub async fn sheet_find(app: AppHandle, req: FindReq) -> ApiResult<Vec<FindHit>> {
    validate::id("workbookId", &req.workbook_id)?;
    validate::non_empty("query", &req.query, validate::MAX_QUERY)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_find(&req.workbook_id, &req.query, req.match_case, req.whole_cell, req.in_formulas))
    })
    .await
}

/// `sheet_replace` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceReq {
    workbook_id: String,
    query: String,
    replacement: String,
    match_case: bool,
    whole_cell: bool,
}

/// `sheet_replace({ workbookId, query, replacement, matchCase, wholeCell }) → { count }`.
#[tauri::command]
pub async fn sheet_replace(app: AppHandle, req: ReplaceReq) -> ApiResult<Value> {
    validate::id("workbookId", &req.workbook_id)?;
    validate::non_empty("query", &req.query, validate::MAX_QUERY)?;
    validate::formula("replacement", &req.replacement)?;
    blocking(move || {
        let store = session(&app)?;
        let count = guarded(|| {
            store.sheet_replace(&req.workbook_id, &req.query, &req.replacement, req.match_case, req.whole_cell)
        })?;
        Ok(json!({ "count": count }))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── sheets of a workbook

/// `sheet_add` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddReq {
    workbook_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    after_id: Option<String>,
}

/// Validates a sheet name (Excel rules: ≤ 31 characters, none of `[]:*?/\`).
pub fn sheet_name(field: &str, s: &str) -> ApiResult<()> {
    validate::non_empty(field, s, 31)?;
    if s.chars().any(|c| matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\') || c.is_control()) {
        return Err(ApiError::invalid(field, "sheet names cannot contain [ ] : * ? / \\"));
    }
    Ok(())
}

/// `sheet_add({ workbookId, name?, afterId? }) → SheetMeta`.
#[tauri::command]
pub async fn sheet_add(app: AppHandle, req: AddReq) -> ApiResult<SheetMeta> {
    validate::id("workbookId", &req.workbook_id)?;
    if let Some(n) = &req.name {
        sheet_name("name", n)?;
    }
    validate::opt_id("afterId", req.after_id.as_deref())?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_add(&req.workbook_id, req.name.as_deref(), req.after_id.as_deref()))
    })
    .await
}

/// `sheet_update` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateReq {
    id: String,
    patch: SheetPatch,
}

/// `sheet_update({ id, patch: { name?, color?, hidden? } }) → SheetMeta`.
#[tauri::command]
pub async fn sheet_update(app: AppHandle, req: UpdateReq) -> ApiResult<SheetMeta> {
    validate::id("id", &req.id)?;
    if let Some(n) = &req.patch.name {
        sheet_name("patch.name", n)?;
    }
    if let Some(Some(c)) = &req.patch.color {
        color("patch.color", c)?;
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_update(&req.id, req.patch))
    })
    .await
}

/// `sheet_remove({ id }) → void` (the last visible sheet cannot be removed).
#[tauri::command]
pub async fn sheet_remove(app: AppHandle, req: IdReq) -> ApiResult<()> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_remove(&req.id))
    })
    .await
}

/// `sheet_reorder` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderReq {
    id: String,
    #[serde(default)]
    before_id: Option<String>,
    #[serde(default)]
    after_id: Option<String>,
}

/// `sheet_reorder({ id, beforeId?, afterId? }) → SheetMeta`.
#[tauri::command]
pub async fn sheet_reorder(app: AppHandle, req: ReorderReq) -> ApiResult<SheetMeta> {
    validate::id("id", &req.id)?;
    validate::opt_id("beforeId", req.before_id.as_deref())?;
    validate::opt_id("afterId", req.after_id.as_deref())?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_reorder(&req.id, req.before_id.as_deref(), req.after_id.as_deref()))
    })
    .await
}

/// `sheet_named_range_set` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedRangeReq {
    workbook_id: String,
    name: String,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

/// `sheet_named_range_set({ workbookId, name, ref: string|null }) → void` (`null` deletes).
#[tauri::command]
pub async fn sheet_named_range_set(app: AppHandle, req: NamedRangeReq) -> ApiResult<()> {
    validate::id("workbookId", &req.workbook_id)?;
    validate::non_empty("name", &req.name, 255)?;
    let ok = req
        .name
        .chars()
        .next()
        .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '\\')
        && req.name.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '\\'));
    if !ok {
        return Err(ApiError::invalid("name", "invalid name"));
    }
    if let Some(r) = &req.reference {
        validate::formula("ref", r)?;
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_named_range_set(&req.workbook_id, &req.name, req.reference.as_deref()))
    })
    .await
}

/// `sheet_cond_format_set` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CondFormatReq {
    sheet_id: String,
    rules: Vec<CondFormatRule>,
}

/// `sheet_cond_format_set({ sheetId, rules }) → void` (replaces the sheet's rules).
#[tauri::command]
pub async fn sheet_cond_format_set(app: AppHandle, req: CondFormatReq) -> ApiResult<()> {
    validate::id("sheetId", &req.sheet_id)?;
    validate::list_len("rules", req.rules.len(), 500)?;
    for r in &req.rules {
        rect("rules.rect", &r.rect)?;
        if let Some(f) = &r.formula {
            validate::formula("rules.formula", f)?;
        }
        if let Some(v) = &r.values {
            validate::list_len("rules.values", v.len(), 8)?;
            v.iter().try_for_each(|x| validate::formula("rules.values", x))?;
        }
        if let Some(c) = &r.colors {
            validate::list_len("rules.colors", c.len(), 8)?;
            c.iter().try_for_each(|x| color("rules.colors", x))?;
        }
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_cond_format_set(&req.sheet_id, req.rules))
    })
    .await
}

/// `sheet_chart_set` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartSetReq {
    sheet_id: String,
    chart: Value,
}

/// `sheet_chart_set({ sheetId, chart: { id?, spec, anchor } | { id, delete: true } }) → void`.
#[tauri::command]
pub async fn sheet_chart_set(app: AppHandle, req: ChartSetReq) -> ApiResult<()> {
    validate::id("sheetId", &req.sheet_id)?;
    if !req.chart.is_object() {
        return Err(ApiError::invalid("chart", "must be an object"));
    }
    let size = req.chart.to_string().len();
    if size > 64 * 1024 {
        return Err(ApiError::invalid("chart", "chart is too large"));
    }
    if let Some(r) = req.chart.pointer("/spec/range").and_then(Value::as_str) {
        validate::formula("chart.spec.range", r)?;
    }
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_chart_set(&req.sheet_id, req.chart))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── undo, eval, functions, lint

/// A `{ workbookId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbookReq {
    workbook_id: String,
}

/// `sheet_undo` / `sheet_redo` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedSheetsDto {
    changed_sheets: Vec<String>,
}

/// `sheet_undo({ workbookId }) → { changedSheets }`.
#[tauri::command]
pub async fn sheet_undo(app: AppHandle, req: WorkbookReq) -> ApiResult<ChangedSheetsDto> {
    validate::id("workbookId", &req.workbook_id)?;
    blocking(move || {
        let store = session(&app)?;
        let changed_sheets = guarded(|| store.sheet_undo(&req.workbook_id))?;
        Ok(ChangedSheetsDto { changed_sheets })
    })
    .await
}

/// `sheet_redo({ workbookId }) → { changedSheets }`.
#[tauri::command]
pub async fn sheet_redo(app: AppHandle, req: WorkbookReq) -> ApiResult<ChangedSheetsDto> {
    validate::id("workbookId", &req.workbook_id)?;
    blocking(move || {
        let store = session(&app)?;
        let changed_sheets = guarded(|| store.sheet_redo(&req.workbook_id))?;
        Ok(ChangedSheetsDto { changed_sheets })
    })
    .await
}

/// `sheet_eval` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvalReq {
    #[serde(default)]
    workbook_id: Option<String>,
    #[serde(default)]
    sheet_id: Option<String>,
    formula: String,
}

/// `sheet_eval({ workbookId?, sheetId?, formula }) → { display, value, error? }` (scalar mode without a workbook).
#[tauri::command]
pub async fn sheet_eval(app: AppHandle, req: EvalReq) -> ApiResult<EvalResult> {
    validate::opt_id("workbookId", req.workbook_id.as_deref())?;
    validate::opt_id("sheetId", req.sheet_id.as_deref())?;
    validate::formula("formula", &req.formula)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_eval(req.workbook_id.as_deref(), req.sheet_id.as_deref(), &req.formula))
    })
    .await
}

/// `sheet_functions({}) → { name, category, signature, description, example, args }[]`.
#[tauri::command]
pub async fn sheet_functions(app: AppHandle, req: super::Empty) -> ApiResult<Vec<FunctionInfo>> {
    let _ = req;
    blocking(move || {
        app.state::<AppState>().session()?;
        Ok(emp_sheets::function_infos())
    })
    .await
}

/// `sheet_lint({ workbookId }) → { id, sheetId, rect, rule, message, fix? }[]`.
#[tauri::command]
pub async fn sheet_lint(app: AppHandle, req: WorkbookReq) -> ApiResult<Vec<LintItem>> {
    validate::id("workbookId", &req.workbook_id)?;
    blocking(move || {
        let store = session(&app)?;
        guarded(|| store.sheet_lint(&req.workbook_id))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── files

/// `sheet_import_file` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportFileReq {
    grant_id: String,
    workspace_id: String,
    parent_id: Option<String>,
    as_database: bool,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `sheet_import_file` result.
#[derive(Debug, Serialize)]
pub struct ImportedDto {
    page: emp_store::model::PageMeta,
    warnings: Vec<String>,
}

/// `sheet_import_file({ grantId, workspaceId, parentId, asDatabase, onEvent })` (job) ⇒ `{ page, warnings }`: an
/// XLSX / ODS / CSV file as a workbook (or a database).
#[tauri::command]
pub async fn sheet_import_file(
    webview: Webview,
    state: State<'_, AppState>,
    req: ImportFileReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    let store = state.session()?;
    super::market::ensure_sheet_host(webview.app_handle(), &store);
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("sheet_import_file", true, store.now(), sink, move |ctx| {
            let state = app.state::<AppState>();
            let f = take_file(&state, &req.grant_id, &[GrantPurpose::Import], caps::WORKBOOK)?;
            let (page, warnings) = store
                .sheet_import_file(
                    &f.name,
                    &f.bytes,
                    &req.workspace_id,
                    req.parent_id.as_deref(),
                    req.as_database,
                    ctx,
                )
                .map_err(|e| cancelled_or(ctx, e.into()))?;
            Ok(ImportedDto { page, warnings })
        }))
}

/// Workbook export formats.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkbookFormat {
    /// XLSX (formulas written from parsed ASTs, §9.17).
    Xlsx,
    /// CSV of one sheet (formula-injection protected).
    Csv,
}

/// `sheet_export` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportReq {
    workbook_id: String,
    format: WorkbookFormat,
    #[serde(default)]
    sheet_id: Option<String>,
    grant_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `sheet_export({ workbookId, format, sheetId?, grantId, onEvent })` (job) ⇒ `{ bytes }`.
#[tauri::command]
pub async fn sheet_export(
    webview: Webview,
    state: State<'_, AppState>,
    req: ExportReq,
) -> ApiResult<JobRef> {
    validate::id("workbookId", &req.workbook_id)?;
    validate::opt_id("sheetId", req.sheet_id.as_deref())?;
    validate::grant_id("grantId", &req.grant_id)?;
    let store = state.session()?;
    let target = super::import::take_export_target(&state, &req.grant_id)?;
    let sink = job_sink(&webview, &req.on_event);
    Ok(state
        .jobs
        .spawn("sheet_export", true, store.now(), sink, move |ctx| {
            ctx.report(0, 2, Some("Exporting"));
            let format = match req.format {
                WorkbookFormat::Xlsx => "xlsx",
                WorkbookFormat::Csv => "csv",
            };
            let bytes = guarded(|| store.sheet_export(&req.workbook_id, format, req.sheet_id.as_deref()))?;
            ctx.check_cancelled()?;
            ctx.report(1, 2, Some("Writing"));
            super::import::write_atomic(&target, &bytes)?;
            ctx.report(2, 2, Some("Done"));
            Ok(json!({ "bytes": bytes.len() }))
        }))
}

/// `sheet_to_database` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToDatabaseReq {
    sheet_id: String,
    rect: Rect,
    has_header: bool,
    workspace_id: String,
    parent_id: Option<String>,
}

/// `sheet_to_database({ sheetId, rect, hasHeader, workspaceId, parentId }) → { page }`.
#[tauri::command]
pub async fn sheet_to_database(app: AppHandle, req: ToDatabaseReq) -> ApiResult<PageDto> {
    validate::id("sheetId", &req.sheet_id)?;
    rect("rect", &req.rect)?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    let rows = u64::from(req.rect.r1 - req.rect.r0) + 1;
    let cols = u64::from(req.rect.c1 - req.rect.c0) + 1;
    if cols > 500 || rows * cols > 5_000_000 {
        return Err(ApiError::invalid("rect", "the range is too large for a database"));
    }
    blocking(move || {
        let store = session(&app)?;
        let page = guarded(|| {
            store.sheet_to_database(
                &req.sheet_id,
                req.rect,
                req.has_header,
                &req.workspace_id,
                req.parent_id.as_deref(),
            )
        })?;
        Ok(PageDto { page })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rectangles_are_bounded() {
        assert!(rect("r", &Rect { r0: 0, c0: 0, r1: 10, c1: 3 }).is_ok());
        assert!(rect("r", &Rect { r0: 5, c0: 0, r1: 4, c1: 3 }).is_err());
        assert!(rect("r", &Rect { r0: 0, c0: 0, r1: MAX_ROWS, c1: 0 }).is_err());
        assert!(rects("r", &[]).is_err());
    }

    #[test]
    fn spans_stay_in_the_grid() {
        assert!(span(Axis::Rows, 0, 10).is_ok());
        assert!(span(Axis::Cols, MAX_COLS - 1, 2).is_err());
        assert!(span(Axis::Rows, 3, 0).is_err());
    }

    #[test]
    fn sheet_names_follow_excel_rules() {
        assert!(sheet_name("n", "Budget 2026").is_ok());
        assert!(sheet_name("n", "a/b").is_err());
        assert!(sheet_name("n", &"x".repeat(32)).is_err());
        assert!(sheet_name("n", " ").is_err());
    }

    #[test]
    fn resize_accepts_numbers_and_auto() {
        let a: ResizeReq = serde_json::from_value(json!({ "sheetId": "s", "axis": "cols", "indices": [1], "size": 80 })).unwrap();
        assert!(matches!(a.size, ResizeSize::Px(x) if (x - 80.0).abs() < f64::EPSILON));
        let b: ResizeReq = serde_json::from_value(json!({ "sheetId": "s", "axis": "rows", "indices": [1], "size": "auto" })).unwrap();
        assert!(matches!(b.size, ResizeSize::Auto(_)));
        assert!(serde_json::from_value::<ResizeReq>(json!({ "sheetId": "s", "axis": "rows", "indices": [1], "size": "big" })).is_err());
    }

    #[test]
    fn html_tables_become_tsv() {
        let html = "<meta charset=utf-8><table><tr><th>Name</th><th>Qty</th></tr>\
                    <tr><td><b>Apples</b></td><td>3</td></tr><tr><td>A &amp; B</td><td>4</td></tr></table>";
        assert_eq!(html_table_to_tsv(html).unwrap(), "Name\tQty\nApples\t3\nA & B\t4");
        assert!(html_table_to_tsv("<p>no table</p>").is_none());
    }

    #[test]
    fn colours_are_restricted() {
        assert!(color("c", "#ff00aa").is_ok());
        assert!(color("c", "red").is_ok());
        assert!(color("c", "url(javascript:x)").is_err());
    }
}
