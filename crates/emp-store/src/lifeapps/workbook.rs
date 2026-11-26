//! Spreadsheet Studio workbooks: [`WorkbookSpec`] → an `emp-sheets` workbook → the stored rows
//! (`workbooks` / `sheets` / `sheet_bands` payloads, §10.2), ready to be written inside the install transaction.
//!
//! Conventions (§16.5): input cells carry `role:'input'`, outputs are bold, constants are named ranges on Inputs,
//! header rows are frozen, dates are ISO, check results colour the tab.

use std::collections::BTreeMap;
use std::sync::Arc;

use emp_sheets::workbook::persist::WorkbookFile;
use emp_sheets::workbook::sheet::CondFormatRule;
use emp_sheets::workbook::style::{CellRole, FontStyle};
use emp_sheets::{
    CacheHost, CellEdit, CellStyle, Rect, StylePatch, Value, Workbook, letters_to_col, parse_a1,
};

use crate::lifeapps::answers::{AnswerContext, Scope, render};
use crate::lifeapps::ids::IdGen;
use crate::lifeapps::manifest::{SheetSpec, WorkbookSpec};
use crate::lifeapps::settle::minimal_transfers;
use crate::model::sort_key::n_keys_between;
use crate::repo::workbooks::BAND_SHIFT;
use crate::repo::workbooks::{BandPayload, SheetPayload, WorkbookPayload};
use crate::{Result, StoreError};

/// The rows of one generated workbook.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkbookRows {
    /// `workbooks.payload`.
    pub workbook: WorkbookPayload,
    /// `(sheet id, sort key, payload)` in tab order.
    pub sheets: Vec<(String, String, SheetPayload)>,
    /// `(sheet id, band, payload)`.
    pub bands: Vec<(String, u32, BandPayload)>,
}

fn rect(a1: &str) -> Result<Rect> {
    emp_sheets::address::parse_rect(a1)
        .or_else(|| parse_a1(a1).map(|(r, c)| Rect::cell(r, c)))
        .ok_or_else(|| StoreError::invalid(format!("bad range {a1}")))
}

fn sheet_err(e: emp_sheets::SheetError) -> StoreError {
    crate::repo::workbooks::sheet_err(e)
}

fn fill_sheet(
    wb: &mut Workbook,
    sid: emp_sheets::SheetId,
    s: &SheetSpec,
    scope: &Scope<'_>,
    actx: &AnswerContext,
) -> Result<()> {
    let mut edits = Vec::new();
    for g in &s.grid {
        let (r0, c0) =
            parse_a1(&g.at).ok_or_else(|| StoreError::invalid(format!("bad cell {}", g.at)))?;
        for (i, row) in g.rows.iter().enumerate() {
            for (j, input) in row.iter().enumerate() {
                if input.is_empty() {
                    continue;
                }
                edits.push(CellEdit {
                    row: r0 + u32::try_from(i).unwrap_or(0),
                    col: c0 + u32::try_from(j).unwrap_or(0),
                    input: Some(render(input, scope, actx)),
                });
            }
        }
    }
    let out = wb.set_cells(sid, &edits, None).map_err(sheet_err)?;
    if let Some(e) = out.errors.first() {
        return Err(StoreError::invalid(format!(
            "sheet {}: cell error: {}",
            s.name, e.message
        )));
    }
    for st in &s.styles {
        let patch = StylePatch {
            font: (st.bold || st.italic || st.color.is_some()).then(|| {
                Some(FontStyle {
                    b: st.bold.then_some(true),
                    i: st.italic.then_some(true),
                    color: st.color.clone(),
                    ..FontStyle::default()
                })
            }),
            fill: st.fill.clone().map(Some),
            num_fmt: st.num_fmt.clone().map(Some),
            role: match st.role.as_deref() {
                Some("input") => Some(Some(CellRole::Input)),
                Some("output") => Some(Some(CellRole::Output)),
                Some("check") => Some(Some(CellRole::Check)),
                _ => None,
            },
            ..StylePatch::default()
        };
        wb.set_style(sid, &[rect(&st.range)?], &patch)
            .map_err(sheet_err)?;
    }
    if let Some([r, c]) = s.freeze {
        wb.freeze(sid, r, c).map_err(sheet_err)?;
    }
    for (col, w) in &s.col_widths {
        let c =
            letters_to_col(col).ok_or_else(|| StoreError::invalid(format!("bad column {col}")))?;
        wb.resize(sid, emp_sheets::Axis::Cols, &[c], Some(*w))
            .map_err(sheet_err)?;
    }
    if !s.charts.is_empty() {
        wb.set_charts(sid, s.charts.clone()).map_err(sheet_err)?;
    }
    if s.color.is_some() {
        wb.update_sheet(sid, None, Some(s.color.clone()), None)
            .map_err(sheet_err)?;
    }
    Ok(())
}

/// Writes "who pays whom" next to the balances of a `Balances` sheet (names in A, net balance in B from row 2).
fn settle(wb: &mut Workbook) -> Result<()> {
    let Some(sheet) = wb.sheet_by_name("Balances").map(|s| s.id) else {
        return Ok(());
    };
    let mut balances = Vec::new();
    for r in 1..200 {
        let name = wb.display(sheet, r, 0);
        if name.trim().is_empty() {
            break;
        }
        let net = match wb.value(sheet, r, 1) {
            Value::Number(n) => n,
            _ => 0.0,
        };
        balances.push((name, net));
    }
    let transfers = minimal_transfers(&balances);
    let mut edits = vec![
        CellEdit {
            row: 0,
            col: 3,
            input: Some("Who pays".into()),
        },
        CellEdit {
            row: 0,
            col: 4,
            input: Some("Pays whom".into()),
        },
        CellEdit {
            row: 0,
            col: 5,
            input: Some("Amount".into()),
        },
    ];
    for (i, t) in transfers.iter().enumerate() {
        let r = u32::try_from(i + 1).unwrap_or(1);
        edits.push(CellEdit {
            row: r,
            col: 3,
            input: Some(t.from.clone()),
        });
        edits.push(CellEdit {
            row: r,
            col: 4,
            input: Some(t.to.clone()),
        });
        edits.push(CellEdit {
            row: r,
            col: 5,
            input: Some(format!("{:.2}", t.amount)),
        });
    }
    wb.set_cells(sheet, &edits, None).map_err(sheet_err)?;
    Ok(())
}

/// Builds the workbook of `spec` and converts it into stored rows with ids `UUIDv5(instance, "<key>.sheet:<name>")`.
pub fn build(
    spec: &WorkbookSpec,
    key: &str,
    ids: &IdGen,
    scope: &Scope<'_>,
    actx: &AnswerContext,
) -> Result<WorkbookRows> {
    let mut wb = Workbook::empty(Arc::new(CacheHost::new()));
    let mut sheet_ids = Vec::new();
    let sheets: Vec<&SheetSpec> = spec
        .sheets
        .iter()
        .filter(|s| crate::lifeapps::answers::test(s.when.as_deref(), actx))
        .collect();
    if sheets.is_empty() {
        return Err(StoreError::invalid("a workbook needs at least one sheet"));
    }
    for s in &sheets {
        let sid = wb.add_sheet(Some(&s.name), None).map_err(sheet_err)?;
        sheet_ids.push(sid);
    }
    for (name, reference) in &spec.names {
        wb.set_named_range(name, Some(reference))
            .map_err(sheet_err)?;
    }
    for (s, sid) in sheets.iter().zip(&sheet_ids) {
        fill_sheet(&mut wb, *sid, s, scope, actx)?;
    }
    if spec.post.as_deref() == Some("settle") {
        settle(&mut wb)?;
    }
    let infos: BTreeMap<emp_sheets::SheetId, (u32, u32)> = wb
        .sheet_infos()
        .into_iter()
        .map(|i| (i.id, (i.max_row, i.max_col)))
        .collect();
    let mut file: WorkbookFile = wb.to_file();
    // Conditional formats: their match styles are appended to the style table (ids stay stable on load).
    for (s, sid) in sheets.iter().zip(&sheet_ids) {
        let mut rules = Vec::new();
        for (i, cf) in s.cond_formats.iter().enumerate() {
            let style_id = if cf.fill.is_some() || cf.color.is_some() {
                file.styles.push(CellStyle {
                    fill: cf.fill.clone(),
                    font: cf.color.clone().map(|c| FontStyle {
                        color: Some(c),
                        ..FontStyle::default()
                    }),
                    ..CellStyle::default()
                });
                u32::try_from(file.styles.len() - 1).ok()
            } else {
                None
            };
            rules.push(CondFormatRule {
                id: Some(format!("cf{i}")),
                rect: rect(&cf.range)?,
                kind: cf.kind.clone(),
                op: cf.op.clone(),
                values: cf.values.clone(),
                formula: cf.formula.clone(),
                style_id,
                colors: cf.colors.clone(),
            });
        }
        if let Some(sf) = file.sheets.iter_mut().find(|f| f.id == *sid) {
            sf.cond_formats = rules;
        }
    }
    let keys = n_keys_between(None, None, file.sheets.len())?;
    let mut sheets = Vec::new();
    let mut bands = Vec::new();
    for (sf, sort_key) in file.sheets.iter().zip(keys) {
        let uuid = ids.id(&format!("{key}.sheet:{}", sf.name));
        let (mr, mc) = infos.get(&sf.id).copied().unwrap_or((0, 0));
        sheets.push((
            uuid.clone(),
            sort_key,
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
                max_row: mr,
                max_col: mc,
            },
        ));
        let mut by_band: BTreeMap<u32, BandPayload> = BTreeMap::new();
        for c in &sf.cells {
            let band = c.r >> BAND_SHIFT;
            by_band
                .entry(band)
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
        for (band, bp) in by_band {
            bands.push((uuid.clone(), band, bp));
        }
    }
    Ok(WorkbookRows {
        workbook: WorkbookPayload {
            v: 1,
            styles: file.styles,
            names: file.names,
            calc: file.calc,
            next_sheet_id: file.next_sheet_id,
        },
        sheets,
        bands,
    })
}
