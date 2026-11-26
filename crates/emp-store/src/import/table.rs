//! Tabular data ⇄ databases (SPEC §11.3 `db_import_preview` / `db_import_csv` / `db_export` / `sheet_import_file`
//! / `sheet_to_database`, §9.16 CSV / XLSX hardening).
//!
//! * CSV is decoded (UTF-8, UTF-16 with BOM, Windows-1252) and delimiter-sniffed by emp-sheets; XLSX goes through
//!   the hardened emp-sheets importer (zip pre-scan, cell cap, macros dropped). Values are always data: nothing is
//!   evaluated, so cells starting with `= + - @` stay text.
//! * Column types are inferred ([`infer_type`]); the first column becomes the title. Select options are created
//!   from distinct values (palette colours in order).
//! * Exports apply the view's filter and sorts, use display values, skip secrets, and protect against formula
//!   injection (a leading `'` on text starting with `= + - @ \t \r`).

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use emp_sheets::{CacheHost, CellEdit, Rect, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::guard::{Guard, contain};
use super::{UndoLog, clean_title};
use crate::model::{Id, PageMeta, ids::new_id};
use crate::query::cells::{self, parse_bool, parse_date_text, parse_number, split_list};
use crate::query::compute::Evaluator;
use crate::query::engine::{self, QuerySpec};
use crate::query::model::{CellValue, DbCreate, PropType, Property, PropertySpec, SelectOption};
use crate::repo::databases::{OPTION_PALETTE, load_world};
use crate::repo::views::load_view;
use crate::{Progress, Result, Store, StoreError};

/// Rows sampled for type inference and previews.
pub const SAMPLE_ROWS: usize = 1_000;
/// Distinct values above which a column is not a select.
pub const MAX_SELECT_DISTINCT: usize = 50;
/// Maximum columns imported.
pub const MAX_COLUMNS: usize = 200;
/// Rows written per transaction.
pub const CHUNK: usize = 1_000;

/// One previewed column.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ColumnPreview {
    /// Header.
    pub name: String,
    /// Inferred type.
    pub inferred: PropType,
    /// First values.
    pub sample: Vec<String>,
}

/// `db_import_preview` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImportPreview {
    /// Columns.
    pub columns: Vec<ColumnPreview>,
    /// Data rows.
    pub rows: usize,
    /// Delimiter (CSV).
    pub delimiter: String,
    /// Encoding (CSV) or `xlsx`.
    pub encoding: String,
    /// Sheet names (XLSX).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<String>>,
}

/// `db_import_csv.target`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum TableTarget {
    /// Append to an existing database: column name → property id, `"new"` or `"skip"`.
    #[serde(rename_all = "camelCase")]
    Existing {
        /// Database.
        database_id: Id,
        /// Mapping.
        mapping: BTreeMap<String, String>,
    },
    /// Create a database.
    #[serde(rename_all = "camelCase")]
    New {
        /// Workspace.
        workspace_id: Id,
        /// Parent page.
        parent_id: Option<Id>,
        /// Title.
        title: String,
    },
}

/// Result of a table import.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportResult {
    /// Database.
    pub database_id: Id,
    /// Rows inserted.
    pub inserted: usize,
    /// Import id (for `import_undo`).
    pub import_id: Id,
    /// Warnings.
    pub warnings: Vec<String>,
}

/// A parsed table: header and rows of strings.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Table {
    /// Header.
    pub header: Vec<String>,
    /// Rows.
    pub rows: Vec<Vec<String>>,
    /// Delimiter.
    pub delimiter: String,
    /// Encoding.
    pub encoding: String,
    /// Sheets (XLSX).
    pub sheets: Option<Vec<String>>,
}

fn is_xlsx(name: &str, bytes: &[u8]) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".xlsx")
        || l.ends_with(".xlsm")
        || (bytes.starts_with(b"PK\x03\x04") && !l.ends_with(".csv"))
}

fn sheet_err(e: emp_sheets::SheetError) -> StoreError {
    crate::repo::workbooks::sheet_err(e)
}

/// Rows of a workbook sheet as display strings.
pub(crate) fn sheet_table(
    wb: &Workbook,
    sheet: emp_sheets::SheetId,
    rect: Option<Rect>,
) -> Vec<Vec<String>> {
    let Some(s) = wb.sheet(sheet) else {
        return Vec::new();
    };
    let (rows, cols) = s.extent();
    if rows == 0 || cols == 0 {
        return Vec::new();
    }
    let rect = rect.unwrap_or(Rect {
        r0: 0,
        c0: 0,
        r1: rows - 1,
        c1: cols - 1,
    });
    let r1 = rect.r1.min(rows.saturating_sub(1));
    let c1 = rect
        .c1
        .min(cols.saturating_sub(1))
        .min(rect.c0 + MAX_COLUMNS as u32);
    (rect.r0..=r1)
        .map(|r| (rect.c0..=c1).map(|c| wb.display(sheet, r, c)).collect())
        .collect()
}

/// Parses CSV or XLSX bytes into a table (first row = header). `sheet` picks an XLSX sheet by name.
pub fn read_table(name: &str, bytes: &[u8], sheet: Option<&str>, max_rows: usize) -> Result<Table> {
    contain(|| {
        if is_xlsx(name, bytes) {
            let res = emp_sheets::io::xlsx_import::import_xlsx(
                bytes,
                Arc::new(CacheHost::new()),
                &emp_sheets::io::ImportOptions::default(),
            )
            .map_err(sheet_err)?;
            let wb = res.workbook;
            let names: Vec<String> = wb.sheets().iter().map(|s| s.name.clone()).collect();
            let sid = match sheet {
                Some(n) => wb
                    .sheet_by_name(n)
                    .map(|s| s.id)
                    .ok_or(StoreError::NotFound("sheet"))?,
                None => wb
                    .sheets()
                    .first()
                    .map(|s| s.id)
                    .ok_or(StoreError::NotFound("sheet"))?,
            };
            let mut rows = sheet_table(&wb, sid, None);
            rows.truncate(max_rows.saturating_add(1));
            let header = if rows.is_empty() {
                Vec::new()
            } else {
                rows.remove(0)
            };
            return Ok(Table {
                header,
                rows,
                delimiter: String::new(),
                encoding: "xlsx".into(),
                sheets: Some(names),
            });
        }
        let (sniff, mut rows) =
            emp_sheets::io::csv::read_rows(bytes, max_rows.saturating_add(1)).map_err(sheet_err)?;
        let header = if rows.is_empty() {
            Vec::new()
        } else {
            rows.remove(0)
        };
        Ok(Table {
            header,
            rows,
            delimiter: sniff.delimiter.to_string(),
            encoding: sniff.encoding,
            sheets: None,
        })
    })
}

fn looks_money(s: &str) -> bool {
    let t = s.trim();
    t.starts_with(['$', '€', '£', '¥']) || t.ends_with(['€', '£']) || t.starts_with("-$")
}

/// Infers a property type from sample values (Notion-compatible rules, SPEC §17.4).
#[must_use]
pub fn infer_type(values: &[&str]) -> PropType {
    let vals: Vec<&str> = values
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect();
    if vals.is_empty() {
        return PropType::Text;
    }
    let all = |f: &dyn Fn(&str) -> bool| vals.iter().all(|v| f(v));
    if all(&|v| {
        matches!(
            v.to_ascii_lowercase().as_str(),
            "yes" | "no" | "true" | "false"
        )
    }) {
        return PropType::Checkbox;
    }
    if all(&|v| parse_number(v).is_some()) {
        return if vals.iter().any(|v| looks_money(v)) {
            PropType::Money
        } else {
            PropType::Number
        };
    }
    if all(&|v| parse_date_text(v).is_some()) {
        return PropType::Date;
    }
    if all(&|v| cells::url_allowed(v) && !v.contains(' ')) {
        return PropType::Url;
    }
    if all(&|v| {
        v.contains('@') && v.split('@').nth(1).is_some_and(|d| d.contains('.')) && !v.contains(' ')
    }) {
        return PropType::Email;
    }
    let distinct: HashSet<String> = vals.iter().map(|v| v.to_lowercase()).collect();
    let items: HashSet<String> = vals
        .iter()
        .flat_map(|v| split_list(v))
        .map(str::to_lowercase)
        .collect();
    let long = vals.iter().any(|v| v.chars().count() > 80);
    if !long && vals.len() >= 2 {
        if vals.iter().any(|v| v.contains(','))
            && items.len() <= MAX_SELECT_DISTINCT
            && items.len() < vals.len() * 2
        {
            return PropType::MultiSelect;
        }
        if distinct.len() <= MAX_SELECT_DISTINCT
            && distinct.len() < vals.len()
            && vals.iter().all(|v| v.chars().count() <= 40)
        {
            return PropType::Select;
        }
    }
    PropType::Text
}

/// Preview (`db_import_preview`).
pub fn preview(name: &str, bytes: &[u8]) -> Result<ImportPreview> {
    let full = read_table(name, bytes, None, crate::repo::rows::MAX_ROWS)?;
    let columns = full
        .header
        .iter()
        .take(MAX_COLUMNS)
        .enumerate()
        .map(|(i, h)| {
            let vals: Vec<&str> = full
                .rows
                .iter()
                .take(SAMPLE_ROWS)
                .map(|r| r.get(i).map_or("", String::as_str))
                .collect();
            ColumnPreview {
                name: h.clone(),
                inferred: if i == 0 {
                    PropType::Title
                } else {
                    infer_type(&vals)
                },
                sample: vals
                    .iter()
                    .filter(|v| !v.is_empty())
                    .take(5)
                    .map(|v| (*v).to_owned())
                    .collect(),
            }
        })
        .collect();
    Ok(ImportPreview {
        columns,
        rows: full.rows.len(),
        delimiter: full.delimiter,
        encoding: full.encoding,
        sheets: full.sheets,
    })
}

/// Property specs (with options) for a table's columns.
pub(crate) fn specs_for(
    header: &[String],
    rows: &[Vec<String>],
    types: &[PropType],
) -> Vec<PropertySpec> {
    let mut seen: Vec<String> = Vec::new();
    header
        .iter()
        .enumerate()
        .take(MAX_COLUMNS)
        .map(|(i, h)| {
            let mut name = clean_title(h);
            if name == "Untitled" && i > 0 {
                name = format!("Column {}", i + 1);
            }
            let base = name.clone();
            let mut n = 2;
            while seen.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                name = format!("{base} {n}");
                n += 1;
            }
            seen.push(name.clone());
            let kind = types.get(i).copied().unwrap_or(PropType::Text);
            let spec = PropertySpec::new(&name, kind);
            match kind {
                PropType::Select | PropType::MultiSelect => {
                    let mut opts: Vec<String> = Vec::new();
                    for r in rows {
                        let v = r.get(i).map_or("", String::as_str);
                        let items: Vec<&str> = if kind == PropType::MultiSelect { split_list(v).collect() } else { vec![v.trim()] };
                        for it in items {
                            if !it.is_empty() && !opts.iter().any(|o| o.eq_ignore_ascii_case(it)) && opts.len() < 200 {
                                opts.push(it.to_owned());
                            }
                        }
                    }
                    let options: Vec<serde_json::Value> = opts
                        .iter()
                        .enumerate()
                        .map(|(j, o)| json!({"name": o, "color": OPTION_PALETTE[j % OPTION_PALETTE.len()]}))
                        .collect();
                    spec.with_config(json!({ "options": options }))
                }
                PropType::Money => spec.with_config(json!({"currency": "USD"})),
                _ => spec,
            }
        })
        .collect()
}

/// Display text of a cell for exports (relations by title, secrets excluded).
fn export_text(ev: &Evaluator<'_>, p: &Property, v: Option<&CellValue>) -> String {
    let Some(v) = v else { return String::new() };
    match v {
        CellValue::Secret { .. } => String::new(),
        CellValue::Relation { v: ids } => ids
            .iter()
            .filter_map(|id| {
                ev.world()
                    .locate(id)
                    .map(|(d, r)| ev.world().at(d).row_title(r))
            })
            .collect::<Vec<_>>()
            .join(", "),
        CellValue::Check { v } => if *v { "Yes" } else { "No" }.into(),
        other => cells::display(other, p),
    }
}

fn dangerous(s: &str) -> bool {
    matches!(s.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r'))
}

impl Store {
    /// `db_import_preview`.
    pub fn db_import_preview(&self, name: &str, bytes: &[u8]) -> Result<ImportPreview> {
        self.session()?;
        preview(name, bytes)
    }

    /// `db_import_csv` (job): CSV / XLSX into a new or an existing database.
    pub fn db_import_table(
        &self,
        name: &str,
        bytes: &[u8],
        target: TableTarget,
        sheet: Option<&str>,
        progress: &dyn Progress,
    ) -> Result<TableImportResult> {
        contain(|| {
            let guard = Guard::new(progress, super::guard::DEFAULT_BUDGET);
            let t = read_table(name, bytes, sheet, crate::repo::rows::MAX_ROWS)?;
            guard.step(0, t.rows.len() as u64, "parse")?;
            if t.header.is_empty() {
                return Err(StoreError::invalid("the file has no header row"));
            }
            self.import_rows(&t.header, &t.rows, target, &guard)
        })
    }

    /// Inserts parsed rows into a new / existing database (shared by CSV, XLSX, sheets and Notion).
    pub(crate) fn import_rows(
        &self,
        header: &[String],
        rows: &[Vec<String>],
        target: TableTarget,
        guard: &Guard<'_>,
    ) -> Result<TableImportResult> {
        let import_id = new_id();
        let mut log = UndoLog::default();
        let mut warnings = Vec::new();
        let (db_id, col_props): (String, Vec<Option<String>>) = match target {
            TableTarget::New {
                workspace_id,
                parent_id,
                title,
            } => {
                let types: Vec<PropType> = (0..header.len())
                    .map(|i| {
                        if i == 0 {
                            PropType::Title
                        } else {
                            let vals: Vec<&str> = rows
                                .iter()
                                .take(SAMPLE_ROWS)
                                .map(|r| r.get(i).map_or("", String::as_str))
                                .collect();
                            infer_type(&vals)
                        }
                    })
                    .collect();
                let specs = specs_for(header, rows, &types);
                let created = self.db_create(
                    DbCreate::new(&workspace_id, parent_id.as_deref(), &clean_title(&title))
                        .with_properties(specs.clone()),
                )?;
                log.pages.push(created.page.id.clone());
                self.import_log_save(&import_id, &log)?;
                let props: Vec<Option<String>> = specs
                    .iter()
                    .map(|s| created.schema.property_named(&s.name).map(|p| p.id.clone()))
                    .collect();
                if header.len() > MAX_COLUMNS {
                    warnings.push(format!(
                        "Only the first {MAX_COLUMNS} columns were imported."
                    ));
                }
                (created.page.id, props)
            }
            TableTarget::Existing {
                database_id,
                mapping,
            } => {
                let schema = self.db_get_schema(&database_id)?;
                let mut props = Vec::new();
                for h in header {
                    let m = mapping.get(h).map(String::as_str).unwrap_or("skip");
                    props.push(match m {
                        "skip" => None,
                        "new" => {
                            let vals: Vec<&str> = rows
                                .iter()
                                .take(SAMPLE_ROWS)
                                .map(|r| r.get(props.len()).map_or("", String::as_str))
                                .collect();
                            let ty = infer_type(&vals);
                            let col = props.len();
                            let specs = specs_for(
                                std::slice::from_ref(h),
                                &rows
                                    .iter()
                                    .map(|r| vec![r.get(col).cloned().unwrap_or_default()])
                                    .collect::<Vec<_>>(),
                                &[ty],
                            );
                            let p = self.db_property_create(
                                &database_id,
                                &specs[0].name,
                                ty,
                                specs[0].config.clone(),
                                None,
                            )?;
                            Some(p.id)
                        }
                        id => {
                            if schema.property(id).is_none() {
                                return Err(StoreError::invalid_field(
                                    "mapping",
                                    "unknown property",
                                ));
                            }
                            Some(id.to_owned())
                        }
                    });
                }
                (database_id, props)
            }
        };
        let schema = self.db_get_schema(&db_id)?;
        let mut inserted = 0usize;
        let mut skipped_values = 0usize;
        for (ci, chunk) in rows.chunks(CHUNK).enumerate() {
            guard.step((ci * CHUNK) as u64, rows.len() as u64, "rows")?;
            let mut batch = Vec::with_capacity(chunk.len());
            for r in chunk {
                let mut values = BTreeMap::new();
                for (i, pid) in col_props.iter().enumerate() {
                    let (Some(pid), Some(text)) = (pid, r.get(i)) else {
                        continue;
                    };
                    let Some(p) = schema.property(pid) else {
                        continue;
                    };
                    if p.kind.is_read_only() || p.kind == PropType::Secret || text.trim().is_empty()
                    {
                        continue;
                    }
                    match cells::from_text(p, text).map(|v| cells::validate(p, v)) {
                        Some(Ok(Some(v))) => {
                            values.insert(pid.clone(), v);
                        }
                        Some(Ok(None)) => {}
                        _ => skipped_values += 1,
                    }
                }
                batch.push(values);
            }
            let ids = self.db_rows_insert_bulk(&db_id, batch, None)?;
            inserted += ids.len();
            if log.pages.is_empty() {
                log.rows.extend(ids);
                self.import_log_save(&import_id, &log)?;
            }
        }
        if skipped_values > 0 {
            warnings.push(format!(
                "{skipped_values} values could not be converted and were left empty."
            ));
        }
        self.import_log_save(&import_id, &log)?;
        guard.step(rows.len() as u64, rows.len() as u64, "done")?;
        Ok(TableImportResult {
            database_id: db_id,
            inserted,
            import_id,
            warnings,
        })
    }

    /// Rows of a view as a table of display strings (header first): the view's filter and sorts, its visible
    /// properties (all when none are set), secrets left out.
    pub fn db_export_table(
        &self,
        database_id: &str,
        view_id: Option<&str>,
    ) -> Result<Vec<Vec<String>>> {
        let s = self.session()?;
        let ctx = self.date_ctx()?;
        let world = self.read(|c| load_world(c, &s.codec, database_id))?;
        let view = match view_id {
            Some(v) => Some(self.read(|c| load_view(c, &s.codec, database_id, v))?),
            None => None,
        };
        let ord = world
            .ord(database_id)
            .ok_or(StoreError::NotFound("database"))?;
        let d = world.at(ord);
        let props: Vec<Property> = match view
            .as_ref()
            .map(|v| &v.visible_props)
            .filter(|v| !v.is_empty())
        {
            Some(vp) => {
                let mut ps: Vec<Property> =
                    vp.iter().filter_map(|id| d.prop(id).cloned()).collect();
                if let Some(t) = d.title_prop()
                    && !ps.iter().any(|p| p.id == t.id)
                {
                    ps.insert(0, t.clone());
                }
                ps
            }
            None => d.props.clone(),
        };
        let props: Vec<Property> = props
            .into_iter()
            .filter(|p| p.kind != PropType::Secret)
            .collect();
        let spec = QuerySpec {
            filter: view.as_ref().and_then(|v| v.filter.clone()),
            sorts: view.as_ref().map(|v| v.sorts.clone()).unwrap_or_default(),
            ..Default::default()
        };
        let ev = Evaluator::new(&world, ctx);
        let out = engine::run(&ev, ord, &spec);
        let mut table = vec![props.iter().map(|p| p.name.clone()).collect::<Vec<_>>()];
        for r in out.rows {
            table.push(
                props
                    .iter()
                    .map(|p| export_text(&ev, p, ev.value(ord, r, p).as_ref()))
                    .collect(),
            );
        }
        Ok(table)
    }

    /// `db_export` (job): CSV or XLSX bytes and the number of rows.
    pub fn db_export(
        &self,
        database_id: &str,
        view_id: Option<&str>,
        format: &str,
        progress: &dyn Progress,
    ) -> Result<(Vec<u8>, usize)> {
        progress.progress(0, 1, "export");
        let table = self.db_export_table(database_id, view_id)?;
        let rows = table.len().saturating_sub(1);
        let bytes = match format {
            "csv" => {
                let mut w = csv::WriterBuilder::new().from_writer(Vec::new());
                for r in &table {
                    let rec: Vec<String> = r
                        .iter()
                        .map(|t| {
                            if dangerous(t) {
                                format!("'{t}")
                            } else {
                                t.clone()
                            }
                        })
                        .collect();
                    w.write_record(&rec)
                        .map_err(|e| StoreError::invalid(e.to_string()))?;
                }
                let mut out = vec![0xEF, 0xBB, 0xBF];
                out.extend(
                    w.into_inner()
                        .map_err(|e| StoreError::invalid(e.to_string()))?,
                );
                out
            }
            "xlsx" => {
                let mut wb = Workbook::empty(Arc::new(CacheHost::new()));
                let page = self.page_payload(database_id)?;
                let name: String = page
                    .title
                    .chars()
                    .filter(|c| !matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']'))
                    .take(31)
                    .collect();
                let sid = wb
                    .add_sheet(
                        Some(if name.trim().is_empty() {
                            "Database"
                        } else {
                            name.trim()
                        }),
                        None,
                    )
                    .or_else(|_| wb.add_sheet(Some("Database"), None))
                    .map_err(sheet_err)?;
                let mut edits = Vec::new();
                for (r, row) in table.iter().enumerate() {
                    for (c, t) in row.iter().enumerate() {
                        if t.is_empty() {
                            continue;
                        }
                        let input = if r > 0
                            && parse_number(t).is_some()
                            && !t.contains(',')
                            && !dangerous(t)
                            || r > 0 && t.starts_with('-') && t[1..].parse::<f64>().is_ok()
                        {
                            t.clone()
                        } else {
                            format!("'{t}")
                        };
                        edits.push(CellEdit {
                            row: u32::try_from(r).unwrap_or(u32::MAX),
                            col: u32::try_from(c).unwrap_or(u32::MAX),
                            input: Some(input),
                        });
                    }
                }
                wb.set_cells(sid, &edits, None).map_err(sheet_err)?;
                emp_sheets::io::xlsx_export::export_xlsx(&wb).map_err(sheet_err)?
            }
            _ => return Err(StoreError::invalid_field("format", "csv or xlsx")),
        };
        progress.progress(1, 1, "export");
        Ok((bytes, rows))
    }

    /// `sheet_to_database`: a sheet range (first row as header when `has_header`) into a new database.
    pub fn sheet_to_database(
        &self,
        sheet_id: &str,
        rect: Rect,
        has_header: bool,
        workspace_id: &str,
        parent_id: Option<&str>,
    ) -> Result<PageMeta> {
        let wb = self.workbook_of(sheet_id)?;
        let mut rows = self.sheet_read(&wb, |e| {
            Ok(sheet_table(&e.wb, e.engine_id(sheet_id)?, Some(rect)))
        })?;
        let meta = self.sheet_meta(sheet_id)?;
        let header: Vec<String> = if has_header && !rows.is_empty() {
            rows.remove(0)
        } else {
            (0..rows.first().map_or(1, Vec::len))
                .map(|i| format!("Column {}", i + 1))
                .collect()
        };
        let guard = Guard::new(&crate::NoProgress, super::guard::DEFAULT_BUDGET);
        let res = self.import_rows(
            &header,
            &rows,
            TableTarget::New {
                workspace_id: workspace_id.to_owned(),
                parent_id: parent_id.map(str::to_owned),
                title: meta.name,
            },
            &guard,
        )?;
        self.page_get(&res.database_id).map(|g| g.meta)
    }

    /// `sheet_import_file` (job): an xlsx / csv file as a workbook (or, with `as_database`, a database).
    pub fn sheet_import_file(
        &self,
        name: &str,
        bytes: &[u8],
        workspace_id: &str,
        parent_id: Option<&str>,
        as_database: bool,
        progress: &dyn Progress,
    ) -> Result<(PageMeta, Vec<String>)> {
        let title = clean_title(super::zipfs::strip_ext(
            name.rsplit(['/', '\\']).next().unwrap_or(name),
        ));
        if as_database {
            let r = self.db_import_table(
                name,
                bytes,
                TableTarget::New {
                    workspace_id: workspace_id.to_owned(),
                    parent_id: parent_id.map(str::to_owned),
                    title,
                },
                None,
                progress,
            )?;
            return Ok((self.page_get(&r.database_id)?.meta, r.warnings));
        }
        let (wb, warnings) = contain(|| {
            progress.progress(0, 1, "parse");
            let opts = emp_sheets::io::ImportOptions::default();
            let host: Arc<dyn emp_sheets::Host> = Arc::new(CacheHost::new());
            let r = if is_xlsx(name, bytes) {
                emp_sheets::io::xlsx_import::import_xlsx(bytes, host, &opts)
            } else {
                emp_sheets::io::csv::import_csv(bytes, "Sheet1", host, &opts)
            }
            .map_err(sheet_err)?;
            Ok((r.workbook, r.warnings))
        })?;
        let created = self.sheet_workbook_create_from(workspace_id, parent_id, &title, wb)?;
        let import_id = new_id();
        self.import_log_save(
            &import_id,
            &UndoLog {
                pages: vec![created.page.id.clone()],
                ..Default::default()
            },
        )?;
        progress.progress(1, 1, "done");
        Ok((created.page, warnings))
    }
}

/// Parses a Notion / CSV checkbox cell.
#[must_use]
pub fn checkbox_text(s: &str) -> Option<bool> {
    parse_bool(s)
}

/// Marks unused option colours as used (helper for callers building options by hand).
#[must_use]
pub fn palette_option(i: usize, name: &str) -> SelectOption {
    SelectOption {
        id: new_id(),
        name: name.to_owned(),
        color: OPTION_PALETTE[i % OPTION_PALETTE.len()],
        group: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inference() {
        assert_eq!(infer_type(&["1", "2.5", ""]), PropType::Number);
        assert_eq!(infer_type(&["$1", "$2.5"]), PropType::Money);
        assert_eq!(infer_type(&["Yes", "No"]), PropType::Checkbox);
        assert_eq!(
            infer_type(&["2026-01-01", "November 26, 2026"]),
            PropType::Date
        );
        assert_eq!(infer_type(&["a, b", "b", "c, a"]), PropType::MultiSelect);
        assert_eq!(infer_type(&["red", "blue", "red", "red"]), PropType::Select);
        assert_eq!(infer_type(&["x@y.io", "z@w.com"]), PropType::Email);
        assert_eq!(infer_type(&["https://a.io", "http://b.io"]), PropType::Url);
        assert_eq!(
            infer_type(&["hello world", "something else"]),
            PropType::Text
        );
        assert_eq!(infer_type(&[]), PropType::Text);
    }

    #[test]
    fn csv_tables() {
        let t = read_table("x.csv", b"Name;Amount\nA;1\nB;=cmd()\n", None, 10).unwrap();
        assert_eq!(t.header, vec!["Name", "Amount"]);
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.delimiter, ";");
        let p = preview("x.csv", b"Name,Count,Tag\nA,1,x\nB,2,x\nC,3,y\nD,4,x\n").unwrap();
        assert_eq!(p.rows, 4);
        assert_eq!(p.columns[0].inferred, PropType::Title);
        assert_eq!(p.columns[1].inferred, PropType::Number);
        assert_eq!(p.columns[2].inferred, PropType::Select);
    }
}
