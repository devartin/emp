//! Read-side views for the IPC layer: `PackedCells`, range windows, cell details, sheet metadata and
//! conditional-format evaluation.

use super::sheet::{CellInput, CondFormatRule};
use super::{WbGrid, Workbook, finalize};
use crate::address::{CellKey, Rect, SheetId, format_a1};
use crate::ast::Expr;
use crate::eval::{Budget, EvalCtx};
use crate::parser::{Dialect, parse};
use crate::value::{ErrorKind, Value, parse_number_text};
use serde::{Deserialize, Serialize};

/// Columnar cell batch (IPC `PackedCells`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PackedCells {
    /// Rows.
    pub r: Vec<u32>,
    /// Columns.
    pub c: Vec<u32>,
    /// Display strings.
    pub d: Vec<String>,
    /// Kinds: 0 empty, 1 number, 2 text, 3 bool, 4 error, 5 pending.
    pub k: Vec<u8>,
    /// Flags: 1 formula, 2 spill child.
    pub f: Vec<u8>,
    /// Style ids.
    pub s: Vec<u32>,
}

impl PackedCells {
    /// Number of cells.
    pub fn len(&self) -> usize {
        self.r.len()
    }
    /// Is the batch empty?
    pub fn is_empty(&self) -> bool {
        self.r.is_empty()
    }
    fn push(&mut self, r: u32, c: u32, d: String, k: u8, f: u8, s: u32) {
        self.r.push(r);
        self.c.push(c);
        self.d.push(d);
        self.k.push(k);
        self.f.push(f);
        self.s.push(s);
    }
}

/// Kind code of a value.
pub fn kind_code(v: &Value) -> u8 {
    match v {
        Value::Empty => 0,
        Value::Number(_) => 1,
        Value::Text(_) => 2,
        Value::Bool(_) => 3,
        Value::Error(ErrorKind::Fetch) => 5,
        Value::Error(_) => 4,
        Value::Array(a) => kind_code(a.get(0, 0)),
    }
}

/// Frozen panes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frozen {
    /// Rows.
    pub rows: u32,
    /// Columns.
    pub cols: u32,
}

/// Sheet metadata (IPC `SheetMeta` minus the app-level string id and sort key).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    /// Engine sheet id.
    pub id: SheetId,
    /// Name.
    pub name: String,
    /// Tab colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Hidden.
    pub hidden: bool,
    /// Frozen panes.
    pub frozen: Frozen,
    /// Last used row (0-based; 0 when empty).
    pub max_row: u32,
    /// Last used column.
    pub max_col: u32,
}

/// Conditional-format hit (IPC `cf` item).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfHit {
    /// Row.
    pub r: u32,
    /// Column.
    pub c: u32,
    /// Style to overlay.
    pub style_id: u32,
    /// Data-bar fraction 0..1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bar: Option<f64>,
}

/// A window of a sheet (IPC `sheet_get_range` result minus `rev`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeData {
    /// Cells.
    pub cells: PackedCells,
    /// Custom row heights inside the window.
    pub row_heights: Vec<(u32, f64)>,
    /// Custom column widths inside the window.
    pub col_widths: Vec<(u32, f64)>,
    /// Merges intersecting the window.
    pub merges: Vec<Rect>,
    /// Conditional-format hits.
    pub cf: Vec<CfHit>,
}

/// Details of one cell (IPC `sheet_get_cell`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellInfo {
    /// Formula-bar text.
    pub input: String,
    /// Display string.
    pub display: String,
    /// Kind code.
    pub kind: u8,
    /// Explanation when the value is an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Style id.
    pub style_id: u32,
    /// Precedent references as text.
    pub precedents: Vec<String>,
    /// Anchor of the spill this cell belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spill_of: Option<String>,
}

impl Workbook {
    /// Sheet metadata in tab order.
    pub fn sheet_infos(&self) -> Vec<SheetInfo> {
        self.sheets
            .iter()
            .map(|s| {
                let (rows, cols) = s.extent();
                SheetInfo {
                    id: s.id,
                    name: s.name.clone(),
                    color: s.color.clone(),
                    hidden: s.hidden,
                    frozen: Frozen {
                        rows: s.frozen_rows,
                        cols: s.frozen_cols,
                    },
                    max_row: rows.saturating_sub(1),
                    max_col: cols.saturating_sub(1),
                }
            })
            .collect()
    }

    /// Packed cells inside a rectangle (including spill children and style-only cells).
    pub fn packed(&self, sheet: SheetId, rect: &Rect) -> PackedCells {
        let mut out = PackedCells::default();
        let Some(s) = self.sheet(sheet) else {
            return out;
        };
        let mut items: Vec<(u32, u32, String, u8, u8, u32)> = Vec::new();
        s.for_each_cell(rect, |r, c, cell| {
            let v = cell.shown();
            let flag = if cell.input.is_formula() { 1 } else { 0 };
            items.push((
                r,
                c,
                self.format_display(v, cell.style),
                kind_code(v),
                flag,
                cell.style,
            ));
        });
        for (&(ar, ac), sr) in s.spills.iter() {
            let Some(ix) = sr.intersection(rect) else {
                continue;
            };
            let Some(anchor) = s.cell(ar, ac) else {
                continue;
            };
            let Value::Array(a) = &anchor.value else {
                continue;
            };
            for r in ix.r0..=ix.r1 {
                for c in ix.c0..=ix.c1 {
                    if (r, c) == (ar, ac) {
                        continue;
                    }
                    let v = a.get((r - ar) as usize, (c - ac) as usize);
                    let style = s.cell(r, c).map(|x| x.style).unwrap_or(anchor.style);
                    items.retain(|it| !(it.0 == r && it.1 == c));
                    items.push((r, c, self.format_display(v, style), kind_code(v), 2, style));
                }
            }
        }
        items.sort_by_key(|i| (i.0, i.1));
        for (r, c, d, k, f, st) in items {
            out.push(r, c, d, k, f, st);
        }
        out
    }

    /// Packed cells for a list of changed keys on one sheet (plus dirty rectangles).
    pub fn packed_changes(
        &self,
        sheet: SheetId,
        keys: &[CellKey],
        rects: &[(SheetId, Rect)],
        visible: Option<&Rect>,
    ) -> PackedCells {
        let mut out = PackedCells::default();
        let Some(s) = self.sheet(sheet) else {
            return out;
        };
        let mut seen = rustc_hash::FxHashSet::default();
        let mut add = |r: u32, c: u32, out: &mut PackedCells| {
            if let Some(v) = visible
                && !v.contains(r, c)
            {
                return;
            }
            if !seen.insert((r, c)) {
                return;
            }
            let v = s.value_at(r, c);
            let style = self.effective_style(s, r, c);
            let flag = match s.cell(r, c) {
                Some(cell) if cell.input.is_formula() => 1,
                Some(cell) if cell.has_content() => 0,
                _ if s.spill_children.contains_key(&(r, c)) => 2,
                _ => 0,
            };
            out.push(
                r,
                c,
                self.format_display(&v, style),
                kind_code(&v),
                flag,
                style,
            );
        };
        for k in keys {
            if k.sheet() == sheet {
                add(k.row(), k.col(), &mut out);
            }
        }
        for (sid, rect) in rects {
            if *sid != sheet {
                continue;
            }
            let rect = match visible {
                Some(v) => match rect.intersection(v) {
                    Some(x) => x,
                    None => continue,
                },
                None => *rect,
            };
            if rect.area() > 250_000 {
                continue;
            }
            for r in rect.r0..=rect.r1 {
                for c in rect.c0..=rect.c1 {
                    add(r, c, &mut out);
                }
            }
        }
        out
    }

    /// A window of a sheet with sizes, merges and conditional formats.
    pub fn range_data(&self, sheet: SheetId, rect: &Rect) -> RangeData {
        let Some(s) = self.sheet(sheet) else {
            return RangeData::default();
        };
        RangeData {
            cells: self.packed(sheet, rect),
            row_heights: s
                .row_heights
                .range(rect.r0..=rect.r1)
                .map(|(k, v)| (*k, *v))
                .collect(),
            col_widths: s
                .col_widths
                .range(rect.c0..=rect.c1)
                .map(|(k, v)| (*k, *v))
                .collect(),
            merges: s
                .merges
                .iter()
                .filter(|m| m.intersects(rect))
                .copied()
                .collect(),
            cf: self.eval_cond_formats(sheet, rect),
        }
    }

    /// Details of one cell.
    pub fn cell_info(&self, sheet: SheetId, row: u32, col: u32) -> CellInfo {
        let Some(s) = self.sheet(sheet) else {
            return CellInfo {
                input: String::new(),
                display: String::new(),
                kind: 0,
                error: None,
                style_id: 0,
                precedents: vec![],
                spill_of: None,
            };
        };
        let v = s.value_at(row, col);
        let style = self.effective_style(s, row, col);
        let (input, precedents) = match s.cell(row, col) {
            Some(cell) => {
                let prec = match &cell.input {
                    CellInput::Formula(f) => {
                        let p = self.precedents(&f.expr, sheet);
                        let mut out: Vec<String> = p
                            .cells
                            .iter()
                            .map(|k| {
                                self.rect_text(k.sheet(), &Rect::cell(k.row(), k.col()), sheet)
                            })
                            .collect();
                        out.extend(
                            p.ranges
                                .iter()
                                .map(|r| self.rect_text(r.sheet, &r.rect, sheet)),
                        );
                        out.dedup();
                        out
                    }
                    _ => Vec::new(),
                };
                (self.input_text(cell), prec)
            }
            None => (String::new(), Vec::new()),
        };
        let spill_of = s
            .spill_children
            .get(&(row, col))
            .map(|(r, c)| format_a1(*r, *c));
        let input = if input.is_empty() && spill_of.is_some() {
            s.spill_children
                .get(&(row, col))
                .and_then(|(r, c)| s.cell(*r, *c))
                .map(|c| self.input_text(c))
                .unwrap_or_default()
        } else {
            input
        };
        CellInfo {
            input,
            display: self.format_display(&v, style),
            kind: kind_code(&v),
            error: v.as_error().map(|e| e.describe().to_string()),
            style_id: style,
            precedents,
            spill_of,
        }
    }

    /// Evaluate an expression as if it were in `(sheet, row, col)`.
    pub(crate) fn eval_expr_at(&self, sheet: SheetId, row: u32, col: u32, expr: &Expr) -> Value {
        let mut budget = Budget::new(1_000_000, None);
        let grid = WbGrid::new(self, None);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut ctx = EvalCtx::new(&grid, &*self.host, &mut budget, sheet, row, col);
            let ev = ctx.eval(expr);
            finalize(&mut ctx, ev)
        }));
        r.unwrap_or(Value::Error(ErrorKind::Calc))
    }

    fn eval_cond_formats(&self, sheet: SheetId, rect: &Rect) -> Vec<CfHit> {
        let Some(s) = self.sheet(sheet) else {
            return Vec::new();
        };
        let mut hits = Vec::new();
        for rule in &s.cond_formats {
            let Some(ix) = rule.rect.intersection(rect) else {
                continue;
            };
            if ix.area() > 250_000 {
                continue;
            }
            match rule.kind.as_str() {
                "cell" => {
                    let Some(style) = rule.style_id else { continue };
                    for r in ix.r0..=ix.r1 {
                        for c in ix.c0..=ix.c1 {
                            let v = s.value_at(r, c);
                            if !v.is_empty() && cell_rule_matches(rule, &v) {
                                hits.push(CfHit {
                                    r,
                                    c,
                                    style_id: style,
                                    bar: None,
                                });
                            }
                        }
                    }
                }
                "formula" => {
                    let (Some(style), Some(src)) = (rule.style_id, rule.formula.as_ref()) else {
                        continue;
                    };
                    let src = src.strip_prefix('=').unwrap_or(src);
                    let Ok(mut base) = parse(src, Dialect::Excel) else {
                        continue;
                    };
                    self.bind(&mut base);
                    for r in ix.r0..=ix.r1 {
                        for c in ix.c0..=ix.c1 {
                            let mut e = base.clone();
                            e.translate(
                                r as i64 - rule.rect.r0 as i64,
                                c as i64 - rule.rect.c0 as i64,
                            );
                            let v = self.eval_expr_at(sheet, r, c, &e);
                            if matches!(v.scalar().coerce_bool(), Ok(true)) {
                                hits.push(CfHit {
                                    r,
                                    c,
                                    style_id: style,
                                    bar: None,
                                });
                            }
                        }
                    }
                }
                "data_bar" => {
                    let all = s.values_in(&rule.rect);
                    let nums: Vec<f64> = all
                        .iter()
                        .filter_map(|(_, _, v)| {
                            if let Value::Number(n) = v {
                                Some(*n)
                            } else {
                                None
                            }
                        })
                        .collect();
                    if nums.is_empty() {
                        continue;
                    }
                    let lo = nums.iter().copied().fold(f64::INFINITY, f64::min).min(0.0);
                    let hi = nums.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                    let span = if hi > lo { hi - lo } else { 1.0 };
                    for (r, c, v) in all {
                        if !ix.contains(r, c) {
                            continue;
                        }
                        if let Value::Number(n) = v {
                            hits.push(CfHit {
                                r,
                                c,
                                style_id: rule.style_id.unwrap_or(0),
                                bar: Some(((n - lo) / span).clamp(0.0, 1.0)),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        hits
    }
}

fn operand(s: &str) -> Value {
    match parse_number_text(s) {
        Some(n) => Value::Number(n),
        None => Value::text(s),
    }
}

fn cell_rule_matches(rule: &CondFormatRule, v: &Value) -> bool {
    use std::cmp::Ordering;
    let vals = rule.values.clone().unwrap_or_default();
    let cmp = |a: &Value, b: &Value| crate::value::compare_values(a, b);
    let same_kind = |a: &Value, b: &Value| {
        matches!(
            (a, b),
            (Value::Number(_), Value::Number(_)) | (Value::Text(_), Value::Text(_))
        )
    };
    match rule.op.as_deref().unwrap_or("") {
        "gt" => vals
            .first()
            .map(|x| operand(x))
            .is_some_and(|x| same_kind(v, &x) && cmp(v, &x) == Ordering::Greater),
        "lt" => vals
            .first()
            .map(|x| operand(x))
            .is_some_and(|x| same_kind(v, &x) && cmp(v, &x) == Ordering::Less),
        "eq" => vals
            .first()
            .map(|x| operand(x))
            .is_some_and(|x| cmp(v, &x) == Ordering::Equal && same_kind(v, &x)),
        "between" => {
            if vals.len() < 2 {
                return false;
            }
            let (a, b) = (operand(&vals[0]), operand(&vals[1]));
            same_kind(v, &a) && cmp(v, &a) != Ordering::Less && cmp(v, &b) != Ordering::Greater
        }
        "text_contains" => {
            let needle = vals.first().map(|s| s.to_lowercase()).unwrap_or_default();
            v.coerce_text()
                .map(|t| t.to_lowercase().contains(&needle))
                .unwrap_or(false)
        }
        _ => false,
    }
}
