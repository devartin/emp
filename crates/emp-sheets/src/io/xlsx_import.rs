//! xlsx import (calamine for values and formulas, `xlsx_styles` for formats and layout).

use super::xlsx_styles::{SheetExtras, parse_sheet, parse_styles, parse_workbook};
use super::{ImportOptions, prescan_zip, read_entry};
use crate::address::{CellKey, Rect, sanitize_sheet_name};
use crate::functions::is_supported;
use crate::host::Host;
use crate::value::{ErrorKind, Value};
use crate::workbook::sheet::{Cell, CellInput};
use crate::workbook::{DefinedName, SheetError, Workbook, is_valid_name};
use calamine::{Data, Reader, Xlsx};
use std::collections::BTreeSet;
use std::io::Cursor;
use std::sync::Arc;

/// Result of an import.
#[derive(Debug)]
pub struct ImportResult {
    /// The workbook.
    pub workbook: Workbook,
    /// Human-readable warnings (unsupported functions, dropped macros, …).
    pub warnings: Vec<String>,
}

fn data_value(d: &Data) -> Value {
    match d {
        Data::Int(i) => Value::number(*i as f64),
        Data::Float(f) => Value::number(*f),
        Data::String(s) => Value::text(s),
        Data::Bool(b) => Value::Bool(*b),
        Data::DateTime(dt) => Value::number(dt.as_f64()),
        Data::DateTimeIso(s) => crate::datetime::parse_datetime_text(s, false)
            .map(Value::Number)
            .unwrap_or_else(|| Value::text(s)),
        Data::DurationIso(s) => Value::text(s),
        Data::Error(e) => Value::Error(match e {
            calamine::CellErrorType::Div0 => ErrorKind::Div0,
            calamine::CellErrorType::NA => ErrorKind::NA,
            calamine::CellErrorType::Name => ErrorKind::Name,
            calamine::CellErrorType::Null => ErrorKind::Null,
            calamine::CellErrorType::Num => ErrorKind::Num,
            calamine::CellErrorType::Ref => ErrorKind::Ref,
            calamine::CellErrorType::Value => ErrorKind::Value,
            calamine::CellErrorType::GettingData => ErrorKind::Fetch,
        }),
        Data::Empty => Value::Empty,
    }
}

/// Import an xlsx file from memory. Runs inside `catch_unwind`.
pub fn import_xlsx(
    bytes: &[u8],
    host: Arc<dyn Host>,
    opts: &ImportOptions,
) -> Result<ImportResult, SheetError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        import_inner(bytes, host, opts)
    }))
    .unwrap_or_else(|_| Err(SheetError::Internal("xlsx import panicked".into())))
}

fn import_inner(
    bytes: &[u8],
    host: Arc<dyn Host>,
    opts: &ImportOptions,
) -> Result<ImportResult, SheetError> {
    prescan_zip(Cursor::new(bytes))?;
    let mut warnings = Vec::new();
    let mut z =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| SheetError::Io(e.to_string()))?;
    let wb_xml = read_entry(&mut z, "xl/workbook.xml")
        .ok_or_else(|| SheetError::Io("missing xl/workbook.xml".into()))?;
    let rels = read_entry(&mut z, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let info = parse_workbook(&wb_xml, &rels);
    let xfs = read_entry(&mut z, "xl/styles.xml")
        .map(|x| parse_styles(&x))
        .unwrap_or_default();
    if z.by_name("xl/vbaProject.bin").is_ok() {
        warnings.push("Macros were removed; EMP never runs macros.".to_string());
    }
    let mut xl: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
        .map_err(|e| SheetError::Io(format!("could not read xlsx: {e}")))?;
    let mut wb = Workbook::empty(host);
    wb.calc.date1904 = info.date1904;
    let style_ids: Vec<u32> = xfs.into_iter().map(|s| wb.styles.intern(s)).collect();

    // Create sheets first so cross-sheet references bind.
    let metas: Vec<(String, bool)> = xl
        .sheets_metadata()
        .iter()
        .filter(|s| s.typ == calamine::SheetType::WorkSheet)
        .map(|s| (s.name.clone(), s.visible != calamine::SheetVisible::Visible))
        .collect();
    if metas.is_empty() {
        return Err(SheetError::Io("the workbook has no worksheets".into()));
    }
    let mut ids = Vec::new();
    for (name, hidden) in &metas {
        let clean = sanitize_sheet_name(name);
        let unique = if wb.sheet_by_name(&clean).is_some() {
            wb.unique_sheet_name(&clean)
        } else {
            clean
        };
        if &unique != name {
            warnings.push(format!("Sheet \"{name}\" was renamed to \"{unique}\"."));
        }
        let id = wb.push_sheet(&unique);
        if let Some(s) = wb.sheet_mut(id) {
            s.hidden = *hidden;
        }
        ids.push(id);
    }
    // Names before formulas (so precedents include them).
    for (name, reference) in xl.defined_names().to_vec() {
        if name.starts_with("_xlnm.") || !is_valid_name(&name) {
            continue;
        }
        match wb.name_expr(&reference) {
            Ok(e) => {
                wb.names.insert(
                    name.to_uppercase(),
                    DefinedName {
                        name: name.clone(),
                        expr: Arc::new(e),
                    },
                );
            }
            Err(_) => warnings.push(format!(
                "The name {name} ({reference}) could not be imported."
            )),
        }
    }

    let mut total_cells = 0usize;
    let mut unsupported: BTreeSet<String> = BTreeSet::new();
    for (idx, (orig_name, _)) in metas.iter().enumerate() {
        opts.check_cancel()?;
        let sid = ids[idx];
        let range = xl
            .worksheet_range(orig_name)
            .map_err(|e| SheetError::Io(format!("{orig_name}: {e}")))?;
        let formulas = xl.worksheet_formula(orig_name).ok();
        let mut cells: Vec<(u32, u32, Cell)> = Vec::new();
        if let Some((r0, c0)) = range.start() {
            for (r, c, d) in range.used_cells() {
                total_cells += 1;
                if total_cells > opts.max_cells {
                    return Err(SheetError::TooLarge(format!(
                        "the file has more than {} cells",
                        opts.max_cells
                    )));
                }
                cells.push((
                    r0 + r as u32,
                    c0 + c as u32,
                    Cell::literal(data_value(d), 0),
                ));
            }
        }
        let mut by_pos: std::collections::HashMap<(u32, u32), usize> = cells
            .iter()
            .enumerate()
            .map(|(i, (r, c, _))| ((*r, *c), i))
            .collect();
        if let Some(fr) = formulas
            && let Some((r0, c0)) = fr.start()
        {
            for (r, c, f) in fr.used_cells() {
                if f.trim().is_empty() {
                    continue;
                }
                let (row, col) = (r0 + r as u32, c0 + c as u32);
                let cached = by_pos
                    .get(&(row, col))
                    .map(|i| cells[*i].2.value.clone())
                    .unwrap_or(Value::Empty);
                let at = crate::address::format_a1(row, col);
                let cell = if f.contains('|') {
                    warnings.push(format!(
                        "{orig_name}!{at}: DDE formula imported as text: ={f}"
                    ));
                    Cell::literal(Value::text(format!("={f}")), 0)
                } else if f.contains('[') && !f.contains("[#") {
                    warnings.push(format!(
                        "{orig_name}!{at}: external or structured reference imported as #REF!: ={f}"
                    ));
                    Cell::literal(Value::Error(ErrorKind::Ref), 0)
                } else {
                    match wb.compile(f) {
                        Ok(formula) => {
                            for name in formula.expr.functions() {
                                if !is_supported(&name) {
                                    unsupported.insert(name);
                                }
                            }
                            Cell {
                                input: CellInput::Formula(Arc::new(formula)),
                                value: cached,
                                style: 0,
                            }
                        }
                        Err(e) => {
                            warnings.push(format!(
                                "{orig_name}!{at}: formula kept as its cached value ({e}): ={f}"
                            ));
                            Cell::literal(cached, 0)
                        }
                    }
                };
                match by_pos.get(&(row, col)) {
                    Some(i) => cells[*i].2 = cell,
                    None => {
                        by_pos.insert((row, col), cells.len());
                        cells.push((row, col, cell));
                    }
                }
            }
        }
        // Layout and styles from the sheet XML.
        let extras = info
            .sheets
            .iter()
            .find(|(n, _, _)| n == orig_name)
            .and_then(|(_, path, _)| read_entry(&mut z, path))
            .map(|xml| parse_sheet(&xml, opts.max_cells))
            .unwrap_or_else(SheetExtras::default);
        let Some(sheet) = wb.sheet_mut(sid) else {
            continue;
        };
        for (r, c, cell) in cells {
            sheet.put(r, c, cell);
        }
        for (r, c, xf) in extras.cell_styles {
            let st = style_ids.get(xf as usize).copied().unwrap_or(0);
            if st == 0 {
                continue;
            }
            match sheet.cell_mut(r, c) {
                Some(cell) => cell.style = st,
                None => sheet.put(
                    r,
                    c,
                    Cell {
                        input: CellInput::Value(Value::Empty),
                        value: Value::Empty,
                        style: st,
                    },
                ),
            }
        }
        sheet.col_widths = extras.col_widths.into_iter().collect();
        sheet.row_heights = extras.row_heights.into_iter().collect();
        sheet.frozen_rows = extras.frozen.0;
        sheet.frozen_cols = extras.frozen.1;
        sheet.merges = extras.merges;
        sheet.color = extras.tab_color;
    }
    if !unsupported.is_empty() {
        warnings.push(format!(
            "Unsupported functions show #NAME? (the original formulas are kept): {}",
            unsupported.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    if wb.sheets.iter().all(|s| s.hidden)
        && let Some(s) = wb.sheets.first_mut()
    {
        s.hidden = false;
    }
    // Keep cached values for comparison, then recalculate.
    let cached: Vec<(CellKey, Value)> = if cfg!(debug_assertions) {
        wb.sheets
            .iter()
            .flat_map(|s| {
                s.positions()
                    .into_iter()
                    .filter_map(|(r, c)| {
                        s.cell(r, c)
                            .filter(|x| x.input.is_formula())
                            .map(|x| (CellKey::new(s.id, r, c), x.value.clone()))
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    } else {
        Vec::new()
    };
    wb.rebuild_deps();
    let _ = wb.recalc_all();
    adopt_spill_children(&mut wb);
    if cfg!(debug_assertions) {
        let mismatches = cached
            .iter()
            .filter(|(k, v)| {
                let now = wb.value(k.sheet(), k.row(), k.col());
                !values_close(v, &now)
            })
            .count();
        if mismatches > 0 {
            warnings.push(format!(
                "debug: {mismatches} formula results differ from the cached values in the file"
            ));
        }
    }
    Ok(ImportResult {
        workbook: wb,
        warnings,
    })
}

fn values_close(a: &Value, b: &Value) -> bool {
    match (a.scalar(), b.scalar()) {
        (Value::Number(x), Value::Number(y)) => (x - y).abs() <= 1e-9 * y.abs().max(1.0),
        (x, y) => x == y || (x.is_empty() && matches!(y, Value::Number(n) if *n == 0.0)),
    }
}

/// Excel stores spilled values as plain cells; when a dynamic-array anchor is blocked only by such
/// literal cells, drop them and let the anchor spill.
fn adopt_spill_children(wb: &mut Workbook) {
    let mut anchors: Vec<(u16, u32, u32, Rect)> = Vec::new();
    for s in &wb.sheets {
        for (&(r, c), rect) in &s.blocked {
            let mut only_literals = true;
            s.for_each_cell(rect, |rr, cc, cell| {
                if (rr, cc) != (r, c) && cell.input.is_formula() {
                    only_literals = false;
                }
            });
            if only_literals {
                anchors.push((s.id, r, c, *rect));
            }
        }
    }
    if anchors.is_empty() {
        return;
    }
    let mut formulas = Vec::new();
    for (sid, r, c, rect) in anchors {
        if let Some(s) = wb.sheet_mut(sid) {
            for rr in rect.r0..=rect.r1 {
                for cc in rect.c0..=rect.c1 {
                    if (rr, cc) == (r, c) {
                        continue;
                    }
                    if let Some(cell) = s.cell(rr, cc) {
                        let style = cell.style;
                        s.take(rr, cc);
                        if style != 0 {
                            s.put(
                                rr,
                                cc,
                                Cell {
                                    input: CellInput::Value(Value::Empty),
                                    value: Value::Empty,
                                    style,
                                },
                            );
                        }
                    }
                }
            }
        }
        formulas.push(CellKey::new(sid, r, c));
    }
    let _ = wb.guarded_recalc(
        crate::workbook::recalc::Seeds {
            formulas,
            ..Default::default()
        },
        None,
    );
}
