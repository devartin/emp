//! Serde persistence format. `emp-store` stores the JSON of [`WorkbookFile`] as an (optionally
//! encrypted) payload. Cached values are kept, so opening a workbook only evaluates volatile cells and
//! cells that read external data (SPEC §14.2 "On open").

use super::packed::Frozen;
use super::recalc::Seeds;
use super::sheet::{Cell, CellInput, CondFormatRule, Sheet};
use super::style::{CellStyle, StyleTable};
use super::{CalcSettings, DefinedName, SheetError, Workbook};
use crate::address::{CellKey, Rect, SheetId};
use crate::host::Host;
use crate::printer::print_excel;
use crate::value::Value;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Current format version.
pub const WORKBOOK_FORMAT_VERSION: u32 = 1;

/// One stored cell.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CellFile {
    /// Row.
    pub r: u32,
    /// Column.
    pub c: u32,
    /// Formula text (with `=`), absent for literals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,
    /// Literal value, or the cached result of the formula.
    #[serde(default)]
    pub v: Value,
    /// Style id.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub s: u32,
}

fn is_zero(x: &u32) -> bool {
    *x == 0
}

/// One stored sheet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFile {
    /// Engine id.
    pub id: SheetId,
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
    /// Cells.
    #[serde(default)]
    pub cells: Vec<CellFile>,
    /// Custom row heights.
    #[serde(default)]
    pub row_heights: Vec<(u32, f64)>,
    /// Custom column widths.
    #[serde(default)]
    pub col_widths: Vec<(u32, f64)>,
    /// Merges.
    #[serde(default)]
    pub merges: Vec<Rect>,
    /// Conditional formats.
    #[serde(default)]
    pub cond_formats: Vec<CondFormatRule>,
    /// Charts.
    #[serde(default)]
    pub charts: Vec<serde_json::Value>,
}

/// A defined name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameFile {
    /// Name.
    pub name: String,
    /// Reference text (`Inputs!$B$2`).
    #[serde(rename = "ref")]
    pub reference: String,
}

/// The whole workbook.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookFile {
    /// Format version.
    pub v: u32,
    /// Sheets in tab order.
    pub sheets: Vec<SheetFile>,
    /// Styles by id.
    #[serde(default)]
    pub styles: Vec<CellStyle>,
    /// Defined names.
    #[serde(default)]
    pub names: Vec<NameFile>,
    /// Calculation settings.
    #[serde(default)]
    pub calc: CalcSettings,
    /// Next sheet id to allocate.
    #[serde(default)]
    pub next_sheet_id: SheetId,
}

impl Workbook {
    /// Snapshot the workbook into its persistence format.
    pub fn to_file(&self) -> WorkbookFile {
        let sheets = self
            .sheets
            .iter()
            .map(|s| {
                let mut cells = Vec::with_capacity(s.cell_count());
                for (&c, col) in &s.cols {
                    for (&r, cell) in col {
                        let f = match &cell.input {
                            CellInput::Formula(f) => Some(self.formula_text(f)),
                            CellInput::Value(_) => None,
                        };
                        let v = match &cell.input {
                            CellInput::Value(v) => v.clone(),
                            CellInput::Formula(_) => cell.value.clone(),
                        };
                        cells.push(CellFile {
                            r,
                            c,
                            f,
                            v,
                            s: cell.style,
                        });
                    }
                }
                cells.sort_by_key(|x| (x.r, x.c));
                SheetFile {
                    id: s.id,
                    name: s.name.clone(),
                    color: s.color.clone(),
                    hidden: s.hidden,
                    frozen: Frozen {
                        rows: s.frozen_rows,
                        cols: s.frozen_cols,
                    },
                    cells,
                    row_heights: s.row_heights.iter().map(|(k, v)| (*k, *v)).collect(),
                    col_widths: s.col_widths.iter().map(|(k, v)| (*k, *v)).collect(),
                    merges: s.merges.clone(),
                    cond_formats: s.cond_formats.clone(),
                    charts: s.charts.clone(),
                }
            })
            .collect();
        WorkbookFile {
            v: WORKBOOK_FORMAT_VERSION,
            sheets,
            styles: self.styles.all().to_vec(),
            names: self
                .names
                .values()
                .map(|n| NameFile {
                    name: n.name.clone(),
                    reference: print_excel(&n.expr, self),
                })
                .collect(),
            calc: self.calc,
            next_sheet_id: self.next_sheet_id,
        }
    }

    /// Serialise to JSON bytes.
    pub fn to_json(&self) -> Result<Vec<u8>, SheetError> {
        serde_json::to_vec(&self.to_file()).map_err(|e| SheetError::Io(e.to_string()))
    }

    /// Load from JSON bytes.
    pub fn from_json(bytes: &[u8], host: Arc<dyn Host>) -> Result<Workbook, SheetError> {
        let file: WorkbookFile =
            serde_json::from_slice(bytes).map_err(|e| SheetError::Io(e.to_string()))?;
        Workbook::from_file(file, host)
    }

    /// Rebuild a workbook from its persistence format. Formulas that no longer parse are kept as text.
    pub fn from_file(file: WorkbookFile, host: Arc<dyn Host>) -> Result<Workbook, SheetError> {
        if file.v > WORKBOOK_FORMAT_VERSION {
            return Err(SheetError::Invalid(format!(
                "workbook format v{} is newer than this app",
                file.v
            )));
        }
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Self::from_file_inner(file, host)
        }))
        .unwrap_or_else(|_| Err(SheetError::Internal("load panicked".into())))
    }

    fn from_file_inner(file: WorkbookFile, host: Arc<dyn Host>) -> Result<Workbook, SheetError> {
        let mut wb = Workbook::empty(host);
        wb.calc = file.calc;
        let mut styles = StyleTable::default();
        {
            // Rebuild by interning in order so ids stay stable.
            let mut ids = Vec::new();
            for (i, s) in file.styles.iter().enumerate() {
                if i == 0 {
                    ids.push(0);
                    continue;
                }
                ids.push(styles.intern_raw(s.clone()));
            }
            let _ = ids;
        }
        styles.reindex();
        wb.styles = styles;
        let mut max_id = 0;
        for sf in &file.sheets {
            let mut s = Sheet::new(sf.id, sf.name.clone());
            s.color = sf.color.clone();
            s.hidden = sf.hidden;
            s.frozen_rows = sf.frozen.rows;
            s.frozen_cols = sf.frozen.cols;
            s.row_heights = sf.row_heights.iter().copied().collect();
            s.col_widths = sf.col_widths.iter().copied().collect();
            s.merges = sf.merges.clone();
            s.cond_formats = sf.cond_formats.clone();
            s.charts = sf.charts.clone();
            max_id = max_id.max(sf.id);
            if wb.sheet(sf.id).is_some() {
                return Err(SheetError::Invalid(format!("duplicate sheet id {}", sf.id)));
            }
            wb.sheets.push(s);
        }
        wb.next_sheet_id = file.next_sheet_id.max(max_id.wrapping_add(1));
        for n in &file.names {
            if let Ok(e) = wb.name_expr(&n.reference) {
                wb.names.insert(
                    n.name.to_uppercase(),
                    DefinedName {
                        name: n.name.clone(),
                        expr: Arc::new(e),
                    },
                );
            }
        }
        let mut externals = Vec::new();
        for sf in &file.sheets {
            let mut cells = Vec::with_capacity(sf.cells.len());
            for cf in &sf.cells {
                Self::check_coord(cf.r, cf.c)?;
                let cell = match &cf.f {
                    Some(src) => match wb.compile(src.strip_prefix('=').unwrap_or(src)) {
                        Ok(f) => {
                            if f.external {
                                externals.push(CellKey::new(sf.id, cf.r, cf.c));
                            }
                            Cell {
                                input: CellInput::Formula(Arc::new(f)),
                                value: cf.v.clone(),
                                style: cf.s,
                            }
                        }
                        Err(_) => Cell::literal(Value::text(src), cf.s),
                    },
                    None => Cell::literal(cf.v.clone(), cf.s),
                };
                cells.push((cf.r, cf.c, cell));
            }
            if let Some(s) = wb.sheet_mut(sf.id) {
                for (r, c, cell) in cells {
                    s.put(r, c, cell);
                }
            }
        }
        // Re-register spills from cached arrays.
        for s in wb.sheets.iter_mut() {
            let mut anchors = Vec::new();
            for (&c, col) in &s.cols {
                for (&r, cell) in col {
                    if let (CellInput::Formula(_), Value::Array(a)) = (&cell.input, &cell.value) {
                        anchors.push((r, c, a.rows() as u32, a.cols() as u32));
                    }
                }
            }
            for (r, c, rows, cols) in anchors {
                let rect = Rect {
                    r0: r,
                    c0: c,
                    r1: r.saturating_add(rows - 1),
                    c1: c.saturating_add(cols - 1),
                };
                s.set_spill((r, c), rect);
            }
        }
        wb.rebuild_deps();
        let _ = wb.guarded_recalc(
            Seeds {
                formulas: externals,
                volatile: true,
                ..Default::default()
            },
            None,
        );
        Ok(wb)
    }
}

impl StyleTable {
    /// Append a style without de-duplication (keeps ids stable when loading).
    pub(crate) fn intern_raw(&mut self, s: CellStyle) -> u32 {
        self.push_raw(s)
    }
}
