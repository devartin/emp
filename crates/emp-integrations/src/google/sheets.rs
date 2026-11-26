//! Google Sheets import by URL and export (SPEC §17.1).
//!
//! **Import:** `spreadsheets.get` for metadata (sheets, grid sizes, frozen rows/cols,
//! merges), then `values.batchGet` twice — `FORMULA` and `UNFORMATTED_VALUE` — merged per
//! cell. Formulas are translated to the EMP dialect ([`map_google_formula`]); cells using
//! unsupported functions keep their cached value and carry the unsupported list.
//!
//! **Export:** `spreadsheets.create`, `values.batchUpdate` (`USER_ENTERED`, chunked), then one
//! formatting `batchUpdate` (bold header, frozen rows, number formats, column widths).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use url::Url;

use super::convert::{MappedFormula, map_google_formula, quote_sheet_title};
use super::drive::DriveFileRef;
use super::{GoogleSession, extract_file_id, path_segment};
use crate::error::{IntegrationError, Result};
use crate::netguard::{Body, BodyCap, ConnectorId, Credential, Method, NetRequest, NetResponse};
use crate::secret::SecretString;

/// Default cell cap for imports (SPEC §9.16: 5,000,000 cells; above that ask the user).
pub const DEFAULT_MAX_CELLS: u64 = 5_000_000;
/// Maximum serialized size of one `values.batchUpdate` request.
const MAX_UPDATE_BYTES: usize = 4 * 1024 * 1024;

/// A rectangular range: 0-based, end-exclusive (Google `GridRange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRange {
    /// First row.
    pub start_row: u32,
    /// One past the last row.
    pub end_row: u32,
    /// First column.
    pub start_col: u32,
    /// One past the last column.
    pub end_col: u32,
}

/// One sheet's metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetMeta {
    /// Google sheet id (`gid`).
    pub sheet_id: i64,
    /// Title.
    pub title: String,
    /// Position.
    pub index: u32,
    /// `GRID`, `OBJECT` or `DATA_SOURCE`.
    pub sheet_type: String,
    /// Grid rows.
    pub row_count: u32,
    /// Grid columns.
    pub column_count: u32,
    /// Frozen rows.
    pub frozen_row_count: u32,
    /// Frozen columns.
    pub frozen_column_count: u32,
    /// Merged ranges.
    pub merges: Vec<GridRange>,
}

/// Spreadsheet metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetMeta {
    /// Spreadsheet id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Locale, e.g. `en_US`.
    pub locale: Option<String>,
    /// Spreadsheet time zone (IANA).
    pub time_zone: Option<String>,
    /// Sheets in order.
    pub sheets: Vec<SheetMeta>,
}

/// A cell value as returned by `UNFORMATTED_VALUE` (dates are serial numbers).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "lowercase")]
pub enum CellValue {
    /// Blank.
    Empty,
    /// Boolean.
    Bool(bool),
    /// Number (finite).
    Number(f64),
    /// Text (including error strings such as `#N/A`).
    Text(String),
}

/// One imported cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCell {
    /// Cached value.
    pub value: CellValue,
    /// Translated formula, if the cell had one.
    pub formula: Option<MappedFormula>,
    /// The original Google formula text.
    pub google_formula: Option<String>,
}

/// One imported sheet (row-major, ragged rows trimmed by Google).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSheet {
    /// Metadata.
    pub meta: SheetMeta,
    /// Cells.
    pub rows: Vec<Vec<ImportedCell>>,
}

/// A whole imported spreadsheet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSpreadsheet {
    /// Metadata.
    pub meta: SpreadsheetMeta,
    /// Grid sheets with values.
    pub sheets: Vec<ImportedSheet>,
    /// Warnings for the import report.
    pub warnings: Vec<String>,
}

/// `valueRenderOption`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueRender {
    /// Formulas as text.
    Formula,
    /// Raw values.
    Unformatted,
}

impl ValueRender {
    fn as_str(self) -> &'static str {
        match self {
            ValueRender::Formula => "FORMULA",
            ValueRender::Unformatted => "UNFORMATTED_VALUE",
        }
    }
}

/// Extract the spreadsheet id from a `https://docs.google.com/spreadsheets/d/<id>/…` URL.
pub fn extract_spreadsheet_id(url: &str) -> Result<String> {
    extract_file_id(url, "spreadsheets", "docs.google.com")
}

fn sheets_url(path: &str) -> Result<Url> {
    Url::parse(&format!("https://sheets.googleapis.com{path}"))
        .map_err(|e| IntegrationError::Internal(e.to_string()))
}

/// `GET /v4/spreadsheets/{id}?fields=…` (no grid data).
pub fn metadata_request(token: &SecretString, id: &str) -> Result<NetRequest> {
    let mut url = sheets_url(&format!("/v4/spreadsheets/{}", path_segment(id)))?;
    url.query_pairs_mut().append_pair(
        "fields",
        "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties),merges)",
    );
    Ok(
        NetRequest::get(ConnectorId::Google, url, "/v4/spreadsheets/{id}")
            .credential(Credential::bearer(token)),
    )
}

/// `GET /v4/spreadsheets/{id}/values:batchGet?ranges=…&valueRenderOption=…`.
pub fn batch_get_request(
    token: &SecretString,
    id: &str,
    ranges: &[String],
    render: ValueRender,
) -> Result<NetRequest> {
    let mut url = sheets_url(&format!(
        "/v4/spreadsheets/{}/values:batchGet",
        path_segment(id)
    ))?;
    {
        let mut q = url.query_pairs_mut();
        for r in ranges {
            q.append_pair("ranges", r);
        }
        q.append_pair("valueRenderOption", render.as_str())
            .append_pair("dateTimeRenderOption", "SERIAL_NUMBER")
            .append_pair("majorDimension", "ROWS");
    }
    Ok(NetRequest::get(
        ConnectorId::Google,
        url,
        "/v4/spreadsheets/{id}/values:batchGet",
    )
    .credential(Credential::bearer(token))
    .cap(BodyCap::DriveExport))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSpreadsheet {
    spreadsheet_id: String,
    #[serde(default)]
    properties: RawProps,
    #[serde(default)]
    sheets: Vec<RawSheet>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawProps {
    #[serde(default)]
    title: String,
    locale: Option<String>,
    time_zone: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSheet {
    properties: RawSheetProps,
    #[serde(default)]
    merges: Vec<RawGridRange>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSheetProps {
    #[serde(default)]
    sheet_id: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    index: u32,
    #[serde(default = "grid")]
    sheet_type: String,
    #[serde(default)]
    grid_properties: RawGridProps,
}

fn grid() -> String {
    "GRID".into()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawGridProps {
    #[serde(default)]
    row_count: u32,
    #[serde(default)]
    column_count: u32,
    #[serde(default)]
    frozen_row_count: u32,
    #[serde(default)]
    frozen_column_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGridRange {
    #[serde(default)]
    start_row_index: u32,
    #[serde(default)]
    end_row_index: u32,
    #[serde(default)]
    start_column_index: u32,
    #[serde(default)]
    end_column_index: u32,
}

/// Parse `spreadsheets.get`.
pub fn parse_metadata(body: &[u8]) -> Result<SpreadsheetMeta> {
    let raw: RawSpreadsheet = crate::netguard::decode_json(body)?;
    Ok(SpreadsheetMeta {
        id: raw.spreadsheet_id,
        title: raw.properties.title,
        locale: raw.properties.locale,
        time_zone: raw.properties.time_zone,
        sheets: raw
            .sheets
            .into_iter()
            .map(|s| SheetMeta {
                sheet_id: s.properties.sheet_id,
                title: s.properties.title,
                index: s.properties.index,
                sheet_type: s.properties.sheet_type,
                row_count: s.properties.grid_properties.row_count,
                column_count: s.properties.grid_properties.column_count,
                frozen_row_count: s.properties.grid_properties.frozen_row_count,
                frozen_column_count: s.properties.grid_properties.frozen_column_count,
                merges: s
                    .merges
                    .into_iter()
                    .map(|m| GridRange {
                        start_row: m.start_row_index,
                        end_row: m.end_row_index,
                        start_col: m.start_column_index,
                        end_col: m.end_column_index,
                    })
                    .collect(),
            })
            .collect(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBatchGet {
    #[serde(default)]
    value_ranges: Vec<RawValueRange>,
}

#[derive(Deserialize)]
struct RawValueRange {
    #[serde(default)]
    values: Vec<Vec<serde_json::Value>>,
}

/// Parse `values.batchGet` into one row-major grid per requested range.
pub fn parse_batch_get(body: &[u8]) -> Result<Vec<Vec<Vec<serde_json::Value>>>> {
    let raw: RawBatchGet = crate::netguard::decode_json(body)?;
    Ok(raw.value_ranges.into_iter().map(|r| r.values).collect())
}

fn to_cell_value(v: &serde_json::Value) -> CellValue {
    match v {
        serde_json::Value::Null => CellValue::Empty,
        serde_json::Value::Bool(b) => CellValue::Bool(*b),
        serde_json::Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() => CellValue::Number(f),
            _ => CellValue::Text(n.to_string()),
        },
        serde_json::Value::String(s) if s.is_empty() => CellValue::Empty,
        serde_json::Value::String(s) => CellValue::Text(s.clone()),
        other => CellValue::Text(other.to_string()),
    }
}

/// Merge a `FORMULA` grid with an `UNFORMATTED_VALUE` grid into imported cells.
pub fn merge_grids(
    formulas: &[Vec<serde_json::Value>],
    values: &[Vec<serde_json::Value>],
) -> Vec<Vec<ImportedCell>> {
    let rows = formulas.len().max(values.len());
    (0..rows)
        .map(|r| {
            let f_row = formulas.get(r).map(Vec::as_slice).unwrap_or(&[]);
            let v_row = values.get(r).map(Vec::as_slice).unwrap_or(&[]);
            let cols = f_row.len().max(v_row.len());
            (0..cols)
                .map(|c| {
                    let value = v_row.get(c).map(to_cell_value).unwrap_or(CellValue::Empty);
                    let google_formula = f_row
                        .get(c)
                        .and_then(|f| f.as_str())
                        .filter(|s| s.starts_with('=') && s.len() > 1)
                        .map(str::to_string);
                    let formula = google_formula.as_deref().map(map_google_formula);
                    ImportedCell {
                        value,
                        formula,
                        google_formula,
                    }
                })
                .collect()
        })
        .collect()
}

/// Import a spreadsheet by URL. Fails with `TOO_LARGE` above `max_cells` (grid size).
pub async fn import_spreadsheet(
    session: &GoogleSession,
    url: &str,
    max_cells: u64,
) -> Result<ImportedSpreadsheet> {
    let id = extract_spreadsheet_id(url)?;
    let meta_resp = session
        .send(|tok| metadata_request(tok, &id))
        .await?
        .error_for_status()?;
    let meta = parse_metadata(&meta_resp.body)?;
    let mut warnings = Vec::new();
    let grid_sheets: Vec<&SheetMeta> = meta
        .sheets
        .iter()
        .filter(|s| {
            let keep = s.sheet_type == "GRID";
            if !keep {
                warnings.push(format!(
                    "Sheet \"{}\" is not a grid ({}) and was skipped.",
                    s.title, s.sheet_type
                ));
            }
            keep
        })
        .collect();
    let total: u64 = grid_sheets
        .iter()
        .map(|s| u64::from(s.row_count) * u64::from(s.column_count))
        .sum();
    if total > max_cells {
        return Err(IntegrationError::LimitExceeded(format!(
            "spreadsheet has {total} cells (limit {max_cells})"
        )));
    }
    let ranges: Vec<String> = grid_sheets
        .iter()
        .map(|s| quote_sheet_title(&s.title))
        .collect();
    let mut sheets = Vec::with_capacity(grid_sheets.len());
    if !ranges.is_empty() {
        let f = session
            .send(|tok| batch_get_request(tok, &id, &ranges, ValueRender::Formula))
            .await?
            .error_for_status()?;
        let v = session
            .send(|tok| batch_get_request(tok, &id, &ranges, ValueRender::Unformatted))
            .await?
            .error_for_status()?;
        let f = parse_batch_get(&f.body)?;
        let v = parse_batch_get(&v.body)?;
        for (i, s) in grid_sheets.iter().enumerate() {
            let empty = Vec::new();
            let rows = merge_grids(f.get(i).unwrap_or(&empty), v.get(i).unwrap_or(&empty));
            let mut unsupported: HashSet<String> = HashSet::new();
            for cell in rows.iter().flatten() {
                if let Some(m) = &cell.formula {
                    unsupported.extend(m.unsupported.iter().cloned());
                }
            }
            if !unsupported.is_empty() {
                let mut names: Vec<_> = unsupported.into_iter().collect();
                names.sort();
                warnings.push(format!(
                    "Sheet \"{}\": unsupported functions ({}) — values frozen at import.",
                    s.title,
                    names.join(", ")
                ));
            }
            sheets.push(ImportedSheet {
                meta: (*s).clone(),
                rows,
            });
        }
    }
    Ok(ImportedSpreadsheet {
        meta,
        sheets,
        warnings,
    })
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/// A cell to export.
#[derive(Debug, Clone, PartialEq)]
pub enum ExportCell {
    /// Blank.
    Empty,
    /// Text (never interpreted as a formula or number).
    Text(String),
    /// Number (non-finite values export blank).
    Number(f64),
    /// Boolean.
    Bool(bool),
    /// A formula, e.g. `=SUM(A1:A3)`.
    Formula(String),
}

impl ExportCell {
    /// JSON for `USER_ENTERED`. Text that Sheets would parse (formulas, numbers, dates,
    /// booleans) is prefixed with `'` so it stays text.
    pub fn to_user_entered(&self) -> serde_json::Value {
        match self {
            ExportCell::Empty => serde_json::Value::String(String::new()),
            ExportCell::Text(t) => {
                let needs_quote = t.starts_with(['=', '+', '-', '@', '\''])
                    || t.trim().parse::<f64>().is_ok()
                    || t.trim().eq_ignore_ascii_case("true")
                    || t.trim().eq_ignore_ascii_case("false")
                    || looks_like_date(t);
                if needs_quote {
                    serde_json::Value::String(format!("'{t}"))
                } else {
                    serde_json::Value::String(t.clone())
                }
            }
            ExportCell::Number(n) if n.is_finite() => serde_json::json!(n),
            ExportCell::Number(_) => serde_json::Value::String(String::new()),
            ExportCell::Bool(b) => serde_json::Value::Bool(*b),
            ExportCell::Formula(f) => {
                let f = f.trim();
                serde_json::Value::String(if f.starts_with('=') {
                    f.to_string()
                } else {
                    format!("={f}")
                })
            }
        }
    }
}

fn looks_like_date(t: &str) -> bool {
    let t = t.trim();
    let digits = t.chars().filter(char::is_ascii_digit).count();
    digits >= 3
        && t.len() <= 20
        && t.chars().all(|c| c.is_ascii_digit() || "/-.: ".contains(c))
        && t.chars().any(|c| "/-.:".contains(c))
}

/// Sheets number format type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NumberFormatType {
    /// Plain number.
    Number,
    /// Currency.
    Currency,
    /// Percent.
    Percent,
    /// Date.
    Date,
    /// Date-time.
    DateTime,
    /// Time.
    Time,
    /// Text.
    Text,
}

/// A column number format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnFormat {
    /// 0-based column.
    pub column: u32,
    /// Format type.
    pub kind: NumberFormatType,
    /// Sheets pattern, e.g. `"$#,##0.00"` or `"yyyy-mm-dd"`.
    pub pattern: String,
}

/// A sheet to export.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExportSheet {
    /// Sheet title.
    pub title: String,
    /// Row-major cells.
    pub rows: Vec<Vec<ExportCell>>,
    /// Bold the first row.
    pub bold_header: bool,
    /// Frozen rows.
    pub frozen_rows: u32,
    /// Column number formats (applied below the header when `bold_header`).
    pub number_formats: Vec<ColumnFormat>,
    /// Column widths in pixels: `(column, px)`.
    pub column_widths: Vec<(u32, u32)>,
}

/// Make sheet titles non-empty, at most 100 chars, without control characters, and unique.
pub fn normalize_sheet_titles(sheets: &mut [ExportSheet]) {
    let mut seen: HashSet<String> = HashSet::new();
    for (i, s) in sheets.iter_mut().enumerate() {
        let base: String = s
            .title
            .chars()
            .filter(|c| !c.is_control())
            .take(100)
            .collect();
        let base = base.trim().to_string();
        let base = if base.is_empty() {
            format!("Sheet{}", i + 1)
        } else {
            base
        };
        let mut title = base.clone();
        let mut n = 2;
        while !seen.insert(title.to_lowercase()) {
            let suffix = format!(" ({n})");
            let keep = 100usize.saturating_sub(suffix.chars().count());
            title = format!("{}{suffix}", base.chars().take(keep).collect::<String>());
            n += 1;
        }
        s.title = title;
    }
}

/// `POST /v4/spreadsheets` creating the file with sheets sized for the data.
pub fn create_request(
    token: &SecretString,
    title: &str,
    sheets: &[ExportSheet],
) -> Result<NetRequest> {
    let sheet_props: Vec<serde_json::Value> = sheets
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let rows = s.rows.len().max(1) as u64;
            let cols = s.rows.iter().map(Vec::len).max().unwrap_or(1).max(1) as u64;
            serde_json::json!({
                "properties": {
                    "title": s.title,
                    "index": i,
                    "gridProperties": {
                        "rowCount": rows.max(100),
                        "columnCount": cols.max(26),
                        "frozenRowCount": s.frozen_rows,
                    }
                }
            })
        })
        .collect();
    let body = serde_json::json!({ "properties": { "title": title }, "sheets": sheet_props });
    Ok(NetRequest::with_body(
        ConnectorId::Google,
        Method::Post,
        sheets_url("/v4/spreadsheets")?,
        "/v4/spreadsheets",
        Body::json(&body),
    )
    .credential(Credential::bearer(token)))
}

/// Created spreadsheet: id, URL and sheet ids in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedSpreadsheet {
    /// Spreadsheet id.
    pub id: String,
    /// Browser URL.
    pub url: String,
    /// `(title, sheetId)` in order.
    pub sheet_ids: Vec<(String, i64)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCreated {
    spreadsheet_id: String,
    spreadsheet_url: Option<String>,
    #[serde(default)]
    sheets: Vec<RawSheet>,
}

/// Parse the `spreadsheets.create` response.
pub fn parse_create_response(body: &[u8]) -> Result<CreatedSpreadsheet> {
    let raw: RawCreated = crate::netguard::decode_json(body)?;
    let url = raw.spreadsheet_url.unwrap_or_else(|| {
        format!(
            "https://docs.google.com/spreadsheets/d/{}/edit",
            raw.spreadsheet_id
        )
    });
    Ok(CreatedSpreadsheet {
        id: raw.spreadsheet_id,
        url,
        sheet_ids: raw
            .sheets
            .into_iter()
            .map(|s| (s.properties.title, s.properties.sheet_id))
            .collect(),
    })
}

/// `values.batchUpdate` bodies (`USER_ENTERED`), chunked so each stays under 4 MiB.
pub fn values_update_bodies(sheets: &[ExportSheet]) -> Vec<serde_json::Value> {
    let mut bodies = Vec::new();
    let mut data: Vec<serde_json::Value> = Vec::new();
    let mut size = 0usize;
    let flush = |data: &mut Vec<serde_json::Value>, bodies: &mut Vec<serde_json::Value>| {
        if !data.is_empty() {
            bodies.push(serde_json::json!({ "valueInputOption": "USER_ENTERED", "data": std::mem::take(data) }));
        }
    };
    for s in sheets {
        let mut start = 0usize;
        while start < s.rows.len() {
            let mut rows: Vec<serde_json::Value> = Vec::new();
            let mut end = start;
            while end < s.rows.len() {
                let row = serde_json::Value::Array(
                    s.rows[end]
                        .iter()
                        .map(ExportCell::to_user_entered)
                        .collect(),
                );
                let row_len = row.to_string().len() + 1;
                if !rows.is_empty() && size + row_len > MAX_UPDATE_BYTES {
                    break;
                }
                size += row_len;
                rows.push(row);
                end += 1;
            }
            data.push(serde_json::json!({
                "range": format!("{}!A{}", quote_sheet_title(&s.title), start + 1),
                "majorDimension": "ROWS",
                "values": rows,
            }));
            start = end;
            if size >= MAX_UPDATE_BYTES || start < s.rows.len() {
                flush(&mut data, &mut bodies);
                size = 0;
            }
        }
    }
    flush(&mut data, &mut bodies);
    bodies
}

/// `POST /v4/spreadsheets/{id}/values:batchUpdate` with one body from [`values_update_bodies`].
pub fn values_update_request(
    token: &SecretString,
    id: &str,
    body: &serde_json::Value,
) -> Result<NetRequest> {
    let url = sheets_url(&format!(
        "/v4/spreadsheets/{}/values:batchUpdate",
        path_segment(id)
    ))?;
    Ok(NetRequest::with_body(
        ConnectorId::Google,
        Method::Post,
        url,
        "/v4/spreadsheets/{id}/values:batchUpdate",
        Body::json(body),
    )
    .credential(Credential::bearer(token)))
}

/// The formatting `batchUpdate` body (bold header, frozen rows, number formats, widths), or
/// `None` if there is nothing to format.
pub fn format_body(
    sheets: &[ExportSheet],
    sheet_ids: &[(String, i64)],
) -> Option<serde_json::Value> {
    let mut requests: Vec<serde_json::Value> = Vec::new();
    for s in sheets {
        let Some(sheet_id) = sheet_ids
            .iter()
            .find(|(t, _)| *t == s.title)
            .map(|(_, id)| *id)
        else {
            continue;
        };
        if s.bold_header && !s.rows.is_empty() {
            requests.push(serde_json::json!({
                "repeatCell": {
                    "range": { "sheetId": sheet_id, "startRowIndex": 0, "endRowIndex": 1 },
                    "cell": { "userEnteredFormat": { "textFormat": { "bold": true } } },
                    "fields": "userEnteredFormat.textFormat.bold"
                }
            }));
        }
        if s.frozen_rows > 0 {
            requests.push(serde_json::json!({
                "updateSheetProperties": {
                    "properties": { "sheetId": sheet_id, "gridProperties": { "frozenRowCount": s.frozen_rows } },
                    "fields": "gridProperties.frozenRowCount"
                }
            }));
        }
        let first_data_row = u32::from(s.bold_header);
        for f in &s.number_formats {
            requests.push(serde_json::json!({
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": first_data_row,
                        "startColumnIndex": f.column,
                        "endColumnIndex": f.column + 1
                    },
                    "cell": { "userEnteredFormat": { "numberFormat": { "type": f.kind, "pattern": f.pattern } } },
                    "fields": "userEnteredFormat.numberFormat"
                }
            }));
        }
        for (col, px) in &s.column_widths {
            requests.push(serde_json::json!({
                "updateDimensionProperties": {
                    "range": { "sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": col, "endIndex": col + 1 },
                    "properties": { "pixelSize": (*px).clamp(20, 2000) },
                    "fields": "pixelSize"
                }
            }));
        }
    }
    if requests.is_empty() {
        None
    } else {
        Some(serde_json::json!({ "requests": requests }))
    }
}

/// `POST /v4/spreadsheets/{id}:batchUpdate` with a body from [`format_body`].
pub fn format_request(
    token: &SecretString,
    id: &str,
    body: &serde_json::Value,
) -> Result<NetRequest> {
    let url = sheets_url(&format!(
        "/v4/spreadsheets/{}:batchUpdate",
        path_segment(id)
    ))?;
    Ok(NetRequest::with_body(
        ConnectorId::Google,
        Method::Post,
        url,
        "/v4/spreadsheets/{id}:batchUpdate",
        Body::json(body),
    )
    .credential(Credential::bearer(token)))
}

/// Export sheets to a new spreadsheet (scope `drive.file`).
pub async fn export_spreadsheet(
    session: &GoogleSession,
    title: &str,
    mut sheets: Vec<ExportSheet>,
) -> Result<DriveFileRef> {
    if sheets.is_empty() {
        sheets.push(ExportSheet::default());
    }
    normalize_sheet_titles(&mut sheets);
    let title = super::docs::clean_title(title);
    let created: NetResponse = session
        .send(|tok| create_request(tok, &title, &sheets))
        .await?
        .error_for_status()?;
    let created = parse_create_response(&created.body)?;
    for body in values_update_bodies(&sheets) {
        session
            .send(|tok| values_update_request(tok, &created.id, &body))
            .await?
            .error_for_status()?;
    }
    if let Some(body) = format_body(&sheets, &created.sheet_ids) {
        session
            .send(|tok| format_request(tok, &created.id, &body))
            .await?
            .error_for_status()?;
    }
    Ok(DriveFileRef {
        file_id: created.id,
        web_view_link: created.url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netguard::testing::guard_for;
    use crate::oauth::{ClientCredentials, GoogleOAuth, TokenSet};
    use crate::testutil::{Reply, TestServer};

    const META: &str = r#"{
      "spreadsheetId": "SHEET1234567890",
      "properties": {"title": "Budget", "locale": "en_US", "timeZone": "America/New_York"},
      "sheets": [
        {"properties": {"sheetId": 0, "title": "Q1 Data", "index": 0, "sheetType": "GRID",
          "gridProperties": {"rowCount": 1000, "columnCount": 26, "frozenRowCount": 1}},
         "merges": [{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 2}]},
        {"properties": {"sheetId": 7, "title": "Chart", "index": 1, "sheetType": "OBJECT"}}
      ]
    }"#;

    #[test]
    fn parses_metadata_fixture() {
        let m = parse_metadata(META.as_bytes()).unwrap();
        assert_eq!(m.title, "Budget");
        assert_eq!(m.sheets.len(), 2);
        assert_eq!(m.sheets[0].frozen_row_count, 1);
        assert_eq!(m.sheets[0].merges[0].end_col, 2);
        assert_eq!(m.sheets[1].sheet_type, "OBJECT");
        assert_eq!(m.time_zone.as_deref(), Some("America/New_York"));
    }

    #[test]
    fn merges_formula_and_value_grids() {
        let f: Vec<Vec<serde_json::Value>> = serde_json::from_str(
            r#"[["Item","Price"],["Apple",1.5],["Total","=SUM(B2:B2)"],["","=GOOGLEFINANCE(\"NASDAQ:AAPL\")"],["","=IMPORTRANGE(\"x\",\"A1\")"]]"#,
        )
        .unwrap();
        let v: Vec<Vec<serde_json::Value>> = serde_json::from_str(
            r##"[["Item","Price"],["Apple",1.5],["Total",1.5],["",190.1],["","#REF!"]]"##,
        )
        .unwrap();
        let rows = merge_grids(&f, &v);
        assert_eq!(rows[1][1].value, CellValue::Number(1.5));
        assert!(rows[1][1].formula.is_none());
        assert_eq!(rows[2][1].formula.as_ref().unwrap().text, "=SUM(B2:B2)");
        assert_eq!(
            rows[3][1].formula.as_ref().unwrap().text,
            "=STOCK(\"AAPL:XNAS\")"
        );
        assert_eq!(rows[3][0].value, CellValue::Empty);
        let m = rows[4][1].formula.as_ref().unwrap();
        assert_eq!(m.unsupported, vec!["IMPORTRANGE"]);
        assert_eq!(rows[4][1].value, CellValue::Text("#REF!".into()));
    }

    #[test]
    fn batch_get_request_shape() {
        let r = batch_get_request(
            &SecretString::new("t"),
            "S1",
            &["'Q1 Data'".to_string(), "'B'".to_string()],
            ValueRender::Formula,
        )
        .unwrap();
        let q: Vec<(String, String)> = r.url.query_pairs().into_owned().collect();
        assert_eq!(q.iter().filter(|(k, _)| k == "ranges").count(), 2);
        assert!(q.contains(&("valueRenderOption".into(), "FORMULA".into())));
        assert_eq!(r.url.path(), "/v4/spreadsheets/S1/values:batchGet");
        assert_eq!(r.url.host_str(), Some("sheets.googleapis.com"));
    }

    #[test]
    fn export_cells_never_inject_formulas_from_text() {
        assert_eq!(
            ExportCell::Text("=HYPERLINK(\"x\")".into()).to_user_entered(),
            "'=HYPERLINK(\"x\")"
        );
        assert_eq!(ExportCell::Text("00123".into()).to_user_entered(), "'00123");
        assert_eq!(
            ExportCell::Text("2026-01-02".into()).to_user_entered(),
            "'2026-01-02"
        );
        assert_eq!(ExportCell::Text("TRUE".into()).to_user_entered(), "'TRUE");
        assert_eq!(ExportCell::Text("hello".into()).to_user_entered(), "hello");
        assert_eq!(
            ExportCell::Formula("SUM(A1:A2)".into()).to_user_entered(),
            "=SUM(A1:A2)"
        );
        assert_eq!(ExportCell::Number(f64::NAN).to_user_entered(), "");
        assert_eq!(
            ExportCell::Number(2.5).to_user_entered(),
            serde_json::json!(2.5)
        );
    }

    #[test]
    fn sheet_titles_normalized() {
        let mut s = vec![
            ExportSheet {
                title: "Data".into(),
                ..Default::default()
            },
            ExportSheet {
                title: "data".into(),
                ..Default::default()
            },
            ExportSheet {
                title: " \u{1} ".into(),
                ..Default::default()
            },
        ];
        normalize_sheet_titles(&mut s);
        assert_eq!(s[0].title, "Data");
        assert_eq!(s[1].title, "data (2)");
        assert_eq!(s[2].title, "Sheet3");
    }

    #[test]
    fn values_updates_are_chunked() {
        let big_row = vec![ExportCell::Text("x".repeat(1000))];
        let sheet = ExportSheet {
            title: "Big".into(),
            rows: vec![big_row; 9000],
            ..Default::default()
        };
        let bodies = values_update_bodies(&[sheet]);
        assert!(bodies.len() >= 2);
        for b in &bodies {
            assert!(b.to_string().len() < MAX_UPDATE_BYTES + 64 * 1024);
        }
        assert_eq!(bodies[0]["data"][0]["range"], "'Big'!A1");
        let second_start = bodies[1]["data"][0]["range"].as_str().unwrap().to_string();
        let first_rows = bodies[0]["data"][0]["values"].as_array().unwrap().len();
        assert_eq!(second_start, format!("'Big'!A{}", first_rows + 1));
        let total: usize = bodies
            .iter()
            .map(|b| b["data"][0]["values"].as_array().unwrap().len())
            .sum();
        assert_eq!(total, 9000);
        let req = values_update_request(&SecretString::new("t"), "S", &bodies[0]).unwrap();
        assert_eq!(req.url.path(), "/v4/spreadsheets/S/values:batchUpdate");
    }

    fn session(guard: crate::NetGuard) -> GoogleSession {
        let oauth = GoogleOAuth::new(
            guard.clone(),
            ClientCredentials {
                client_id: "c".into(),
                client_secret: None,
            },
        );
        let tokens = TokenSet {
            access_token: SecretString::new("at"),
            expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
            refresh_token: Some(SecretString::new("rt")),
            scopes: vec![],
            identity: None,
        };
        GoogleSession::from_tokens(guard, oauth, &tokens).unwrap()
    }

    #[tokio::test]
    async fn import_end_to_end_with_fixtures() {
        let server = TestServer::start(vec![
            Reply::json(200, META),
            Reply::json(200, r#"{"spreadsheetId":"S","valueRanges":[{"range":"'Q1 Data'!A1:Z1000","values":[["a","=1+1"]]}]}"#),
            Reply::json(200, r#"{"spreadsheetId":"S","valueRanges":[{"range":"'Q1 Data'!A1:Z1000","values":[["a",2]]}]}"#),
        ])
        .await;
        let s = session(guard_for(&["sheets.googleapis.com"], server.addr()));
        let out = import_spreadsheet(
            &s,
            "https://docs.google.com/spreadsheets/d/SHEET1234567890/edit#gid=0",
            DEFAULT_MAX_CELLS,
        )
        .await
        .unwrap();
        assert_eq!(out.sheets.len(), 1);
        assert_eq!(out.sheets[0].rows[0][1].value, CellValue::Number(2.0));
        assert_eq!(
            out.sheets[0].rows[0][1].formula.as_ref().unwrap().text,
            "=1+1"
        );
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        let reqs = server.requests();
        assert!(reqs[1].path.contains("valueRenderOption=FORMULA"));
        assert!(reqs[2].path.contains("valueRenderOption=UNFORMATTED_VALUE"));
    }

    #[tokio::test]
    async fn import_respects_cell_cap() {
        let server = TestServer::start(vec![Reply::json(200, META)]).await;
        let s = session(guard_for(&["sheets.googleapis.com"], server.addr()));
        let err = import_spreadsheet(&s, "SHEET1234567890", 1000)
            .await
            .unwrap_err();
        assert_eq!(err.code().as_str(), "TOO_LARGE");
    }

    #[tokio::test]
    async fn export_end_to_end() {
        let server = TestServer::start(vec![
            Reply::json(
                200,
                r#"{"spreadsheetId":"NEW","spreadsheetUrl":"https://docs.google.com/spreadsheets/d/NEW/edit","sheets":[{"properties":{"sheetId":42,"title":"Data"}}]}"#,
            ),
            Reply::json(200, r#"{"spreadsheetId":"NEW","totalUpdatedCells":4}"#),
            Reply::json(200, r#"{"spreadsheetId":"NEW","replies":[]}"#),
        ])
        .await;
        let s = session(guard_for(&["sheets.googleapis.com"], server.addr()));
        let sheet = ExportSheet {
            title: "Data".into(),
            rows: vec![
                vec![
                    ExportCell::Text("Name".into()),
                    ExportCell::Text("Amount".into()),
                ],
                vec![ExportCell::Text("Rent".into()), ExportCell::Number(1200.0)],
            ],
            bold_header: true,
            frozen_rows: 1,
            number_formats: vec![ColumnFormat {
                column: 1,
                kind: NumberFormatType::Currency,
                pattern: "$#,##0.00".into(),
            }],
            column_widths: vec![(0, 180)],
        };
        let r = export_spreadsheet(&s, "Budget export", vec![sheet])
            .await
            .unwrap();
        assert_eq!(r.file_id, "NEW");
        let reqs = server.requests();
        assert_eq!(reqs.len(), 3);
        assert_eq!(reqs[0].path, "/v4/spreadsheets");
        assert!(reqs[1].body_str().contains("USER_ENTERED"));
        let fmt: serde_json::Value = serde_json::from_str(&reqs[2].body_str()).unwrap();
        let kinds: Vec<String> = fmt["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_object().unwrap().keys().next().unwrap().clone())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "repeatCell",
                "updateSheetProperties",
                "repeatCell",
                "updateDimensionProperties"
            ]
        );
        assert_eq!(fmt["requests"][0]["repeatCell"]["range"]["sheetId"], 42);
        assert_eq!(
            fmt["requests"][2]["repeatCell"]["cell"]["userEnteredFormat"]["numberFormat"]["type"],
            "CURRENCY"
        );
    }
}
