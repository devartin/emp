//! Editing tools: fill (copy / series), sort, copy & paste (TSV and internal clip), find & replace, and the
//! workbook linter behind `sheet_lint`.

use super::ops::{CellData, EditOutcome, Op};
use super::sheet::{CellInput, Formula};
use super::style::CellStyle;
use super::{ParsedInput, SheetError, Workbook, parse_input};
use crate::address::{Rect, SheetId, format_rect};
use crate::ast::{Expr, RefTarget};
use crate::printer::print_excel;
use crate::value::{ErrorKind, Value, parse_number_text, sort_cmp};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::Arc;

/// Fill mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FillMode {
    /// Extend numeric/date/text-number series.
    Series,
    /// Repeat the source.
    Copy,
}

/// Paste mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasteMode {
    /// Content and formats.
    All,
    /// Values only.
    Values,
    /// Formats only.
    Formats,
    /// Formulas (inputs) only.
    Formulas,
}

/// A sort key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    /// Absolute column index.
    pub col: u32,
    /// Descending?
    pub desc: bool,
}

/// Copy result (IPC `sheet_copy`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    /// Tab-separated display values.
    pub tsv: String,
    /// Minimal HTML table.
    pub html: String,
    /// Internal clip (JSON) preserving formulas and styles.
    pub clip: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ClipCell {
    r: u32,
    c: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input: Option<String>,
    #[serde(default)]
    value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    style: Option<CellStyle>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Clip {
    v: u32,
    rows: u32,
    cols: u32,
    origin: (u32, u32),
    cells: Vec<ClipCell>,
}

/// A lint finding (IPC `sheet_lint` item).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LintFinding {
    /// Stable id.
    pub id: String,
    /// Sheet.
    pub sheet_id: SheetId,
    /// Affected cells.
    pub rect: Rect,
    /// Rule id.
    pub rule: String,
    /// Message.
    pub message: String,
    /// Suggested fix.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn tsv_field(s: &str) -> String {
    if s.contains(['\t', '\n', '"', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Parse TSV (Excel clipboard flavour, with quoted fields).
pub fn parse_tsv(s: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_q = false;
    let mut chars = s.chars().peekable();
    let mut at_start = true;
    while let Some(c) = chars.next() {
        if in_q {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_q = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if at_start => in_q = true,
            '\t' => {
                row.push(std::mem::take(&mut field));
                at_start = true;
                continue;
            }
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                at_start = true;
                continue;
            }
            c => field.push(c),
        }
        at_start = false;
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn translated(f: &Formula, dr: i64, dc: i64) -> Formula {
    let mut nf = f.clone();
    nf.expr.translate(dr, dc);
    nf
}

fn text_series(s: &str) -> Option<(String, i64, usize)> {
    let digits: String = s
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if digits.is_empty() || digits.len() > 15 {
        return None;
    }
    let prefix = s[..s.len() - digits.len()].to_string();
    Some((prefix, digits.parse().ok()?, digits.len()))
}

impl Workbook {
    /// Fill `target` from `source` (the fill handle). The target normally extends the source.
    pub fn fill(
        &mut self,
        sheet: SheetId,
        source: Rect,
        target: Rect,
        mode: FillMode,
    ) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(sheet)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
        if target.area() > 1_000_000 {
            return Err(SheetError::TooLarge("fill area".into()));
        }
        let vertical = target.c0 >= source.c0
            && target.c1 <= source.c1
            && (target.r1 > source.r1 || target.r0 < source.r0);
        let (sh, sw) = (source.rows() as i64, source.cols() as i64);
        let mut ops = Vec::new();
        // Series analysis per line (column for vertical fill, row otherwise).
        let lines = if vertical {
            source.cols()
        } else {
            source.rows()
        };
        let mut steps: Vec<Option<(f64, f64, bool)>> = Vec::new(); // (last value, step, from_end)
        for i in 0..lines {
            if mode != FillMode::Series {
                steps.push(None);
                continue;
            }
            let mut vals = Vec::new();
            let len = if vertical {
                source.rows()
            } else {
                source.cols()
            };
            for j in 0..len {
                let (r, c) = if vertical {
                    (source.r0 + j, source.c0 + i)
                } else {
                    (source.r0 + i, source.c0 + j)
                };
                match s.cell(r, c).map(|x| &x.input) {
                    Some(CellInput::Value(Value::Number(n))) => vals.push(*n),
                    _ => {
                        vals.clear();
                        break;
                    }
                }
            }
            if vals.is_empty() {
                steps.push(None);
            } else {
                let step = if vals.len() == 1 {
                    1.0
                } else {
                    (vals[vals.len() - 1] - vals[0]) / (vals.len() - 1) as f64
                };
                steps.push(Some((vals[0], step, false)));
            }
        }
        for r in target.r0..=target.r1 {
            for c in target.c0..=target.c1 {
                if source.contains(r, c) {
                    continue;
                }
                let sr = source.r0 as i64 + (r as i64 - source.r0 as i64).rem_euclid(sh);
                let sc = source.c0 as i64 + (c as i64 - source.c0 as i64).rem_euclid(sw);
                let (sr, sc) = (sr as u32, sc as u32);
                let src = s.cell(sr, sc).cloned();
                let line = if vertical {
                    (c - source.c0) as usize
                } else {
                    (r - source.r0) as usize
                };
                let offset = if vertical {
                    r as i64 - source.r0 as i64
                } else {
                    c as i64 - source.c0 as i64
                };
                let data = match src {
                    None => None,
                    Some(cell) => {
                        let input = match (&cell.input, steps.get(line).copied().flatten()) {
                            (CellInput::Value(Value::Number(_)), Some((first, step, _))) => {
                                CellInput::Value(Value::number(first + step * offset as f64))
                            }
                            (CellInput::Value(Value::Text(t)), _) if mode == FillMode::Series => {
                                match text_series(t) {
                                    Some((prefix, n, width)) => {
                                        let j = if vertical {
                                            sr as i64 - source.r0 as i64
                                        } else {
                                            sc as i64 - source.c0 as i64
                                        };
                                        let len = if vertical { sh } else { sw };
                                        let k = n + (offset - j) / len.max(1);
                                        let num = if width > 1 {
                                            format!("{:0width$}", k.max(0), width = width)
                                        } else {
                                            k.to_string()
                                        };
                                        CellInput::Value(Value::text(format!("{prefix}{num}")))
                                    }
                                    None => cell.input.clone(),
                                }
                            }
                            (CellInput::Formula(f), _) => CellInput::Formula(Arc::new(translated(
                                f,
                                r as i64 - sr as i64,
                                c as i64 - sc as i64,
                            ))),
                            _ => cell.input.clone(),
                        };
                        let value = match &input {
                            CellInput::Value(v) => v.clone(),
                            _ => Value::Empty,
                        };
                        Some(CellData {
                            input,
                            style: cell.style,
                            value,
                        })
                    }
                };
                ops.push(Op::Cell {
                    sheet,
                    row: r,
                    col: c,
                    data,
                });
            }
        }
        self.transact("Fill", None, ops)
    }

    /// Sort the rows of a rectangle by key columns. Formulas move with their rows.
    pub fn sort_range(
        &mut self,
        sheet: SheetId,
        rect: Rect,
        keys: &[SortKey],
        has_header: bool,
    ) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(sheet)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
        if keys.is_empty() || keys.iter().any(|k| k.col < rect.c0 || k.col > rect.c1) {
            return Err(SheetError::Invalid(
                "sort keys must be inside the range".into(),
            ));
        }
        let r0 = if has_header { rect.r0 + 1 } else { rect.r0 };
        if r0 > rect.r1 {
            return self.transact("Sort", None, vec![]);
        }
        let mut order: Vec<u32> = (r0..=rect.r1).collect();
        order.sort_by(|a, b| {
            for k in keys {
                let va = s.value_at(*a, k.col);
                let vb = s.value_at(*b, k.col);
                let o = match (va.is_empty(), vb.is_empty()) {
                    (true, true) => Ordering::Equal,
                    (true, false) => Ordering::Greater,
                    (false, true) => Ordering::Less,
                    _ => {
                        let o = sort_cmp(&va, &vb);
                        if k.desc { o.reverse() } else { o }
                    }
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });
        let mut ops = Vec::new();
        for (i, &src_row) in order.iter().enumerate() {
            let dst = r0 + i as u32;
            if dst == src_row {
                continue;
            }
            for c in rect.c0..=rect.c1 {
                let data = s.cell(src_row, c).map(|cell| {
                    let input = match &cell.input {
                        CellInput::Formula(f) => CellInput::Formula(Arc::new(translated(
                            f,
                            dst as i64 - src_row as i64,
                            0,
                        ))),
                        other => other.clone(),
                    };
                    CellData {
                        input,
                        style: cell.style,
                        value: cell.value.clone(),
                    }
                });
                ops.push(Op::Cell {
                    sheet,
                    row: dst,
                    col: c,
                    data,
                });
            }
        }
        self.transact("Sort", None, ops)
    }

    /// Copy a rectangle.
    pub fn copy_range(&self, sheet: SheetId, rect: Rect) -> Result<CopyResult, SheetError> {
        let s = self
            .sheet(sheet)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
        if rect.area() > 2_000_000 {
            return Err(SheetError::TooLarge("copy area".into()));
        }
        let mut tsv = String::new();
        let mut html = String::from("<table>");
        for r in rect.r0..=rect.r1 {
            html.push_str("<tr>");
            for c in rect.c0..=rect.c1 {
                let d = self.display(sheet, r, c);
                if c > rect.c0 {
                    tsv.push('\t');
                }
                tsv.push_str(&tsv_field(&d));
                html.push_str("<td>");
                html.push_str(&html_escape(&d));
                html.push_str("</td>");
            }
            html.push_str("</tr>");
            if r < rect.r1 {
                tsv.push('\n');
            }
        }
        html.push_str("</table>");
        let mut cells = Vec::new();
        s.for_each_cell(&rect, |r, c, cell| {
            cells.push(ClipCell {
                r: r - rect.r0,
                c: c - rect.c0,
                input: Some(self.input_text(cell)).filter(|x| !x.is_empty()),
                value: cell.shown().clone(),
                style: Some(self.styles.get(cell.style).clone()).filter(|x| !x.is_default()),
            });
        });
        let clip = Clip {
            v: 1,
            rows: rect.rows(),
            cols: rect.cols(),
            origin: (rect.r0, rect.c0),
            cells,
        };
        Ok(CopyResult {
            tsv,
            html,
            clip: serde_json::to_string(&clip).unwrap_or_default(),
        })
    }

    /// Paste at a position from an internal clip or TSV text.
    pub fn paste(
        &mut self,
        sheet: SheetId,
        at: (u32, u32),
        clip: Option<&str>,
        tsv: Option<&str>,
        mode: PasteMode,
    ) -> Result<EditOutcome, SheetError> {
        if self.sheet(sheet).is_none() {
            return Err(SheetError::NotFound(format!("sheet {sheet}")));
        }
        let mut ops = Vec::new();
        if let Some(c) = clip.and_then(|c| serde_json::from_str::<Clip>(c).ok()) {
            let dr = at.0 as i64 - c.origin.0 as i64;
            let dc = at.1 as i64 - c.origin.1 as i64;
            let target = Rect::new(at.0, at.1, at.0 + c.rows - 1, at.1 + c.cols - 1);
            Self::check_coord(target.r1, target.c1)?;
            // Clear the target area first for "all" pastes (cells absent from the clip are blank).
            if mode == PasteMode::All {
                let s = self
                    .sheet(sheet)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
                s.for_each_cell(&target, |r, cc, _| {
                    ops.push(Op::Cell {
                        sheet,
                        row: r,
                        col: cc,
                        data: None,
                    })
                });
            }
            for cell in c.cells {
                let (r, col) = (at.0 + cell.r, at.1 + cell.c);
                let existing = self.sheet(sheet).and_then(|s| s.cell(r, col)).cloned();
                let style_id = match (&cell.style, mode) {
                    (_, PasteMode::Values | PasteMode::Formulas) => {
                        existing.as_ref().map(|e| e.style).unwrap_or(0)
                    }
                    (Some(st), _) => self.styles.intern(st.clone()),
                    (None, _) => 0,
                };
                let input = match mode {
                    PasteMode::Formats => existing
                        .as_ref()
                        .map(|e| e.input.clone())
                        .unwrap_or(CellInput::Value(Value::Empty)),
                    PasteMode::Values => CellInput::Value(cell.value.clone()),
                    PasteMode::All | PasteMode::Formulas => match cell
                        .input
                        .as_deref()
                        .map(|t| parse_input(t, self.calc.date1904))
                    {
                        Some(ParsedInput::Formula(src)) => match self.compile(&src) {
                            Ok(f) => CellInput::Formula(Arc::new(translated(&f, dr, dc))),
                            Err(_) => CellInput::Value(Value::text(
                                cell.input.clone().unwrap_or_default(),
                            )),
                        },
                        Some(ParsedInput::Value(v, _)) => CellInput::Value(v),
                        _ => CellInput::Value(Value::Empty),
                    },
                };
                let value = match &input {
                    CellInput::Value(v) => v.clone(),
                    _ => Value::Empty,
                };
                ops.push(Op::Cell {
                    sheet,
                    row: r,
                    col,
                    data: Some(CellData {
                        input,
                        style: style_id,
                        value,
                    }),
                });
            }
        } else if let Some(t) = tsv {
            let rows = parse_tsv(t);
            let total: usize = rows.iter().map(|r| r.len()).sum();
            if total > 2_000_000 {
                return Err(SheetError::TooLarge("paste".into()));
            }
            for (i, row) in rows.iter().enumerate() {
                for (j, text) in row.iter().enumerate() {
                    let (r, c) = (at.0 + i as u32, at.1 + j as u32);
                    Self::check_coord(r, c)?;
                    let input = if text.is_empty() {
                        None
                    } else {
                        Some(text.as_str())
                    };
                    // Pasted text is data: a leading '=' is treated as a formula only in formula mode.
                    let data = match self.cell_data_for_input(sheet, r, c, input) {
                        Ok(d) => d,
                        Err(_) => Some(CellData {
                            input: CellInput::Value(Value::text(text)),
                            style: 0,
                            value: Value::text(text),
                        }),
                    };
                    if mode == PasteMode::Formats {
                        continue;
                    }
                    ops.push(Op::Cell {
                        sheet,
                        row: r,
                        col: c,
                        data,
                    });
                }
            }
        }
        self.transact("Paste", None, ops)
    }

    /// Find cells across the workbook.
    pub fn find(
        &self,
        query: &str,
        match_case: bool,
        whole_cell: bool,
        in_formulas: bool,
    ) -> Vec<(SheetId, u32, u32)> {
        let mut out = Vec::new();
        if query.is_empty() {
            return out;
        }
        let q = if match_case {
            query.to_string()
        } else {
            query.to_lowercase()
        };
        for s in &self.sheets {
            let mut hits: Vec<(u32, u32)> = Vec::new();
            for (&c, col) in &s.cols {
                for (&r, cell) in col {
                    if !cell.has_content() {
                        continue;
                    }
                    let text = if in_formulas {
                        self.input_text(cell)
                    } else {
                        self.format_display(cell.shown(), cell.style)
                    };
                    let t = if match_case {
                        text
                    } else {
                        text.to_lowercase()
                    };
                    if (whole_cell && t == q) || (!whole_cell && t.contains(&q)) {
                        hits.push((r, c));
                    }
                }
            }
            hits.sort();
            out.extend(hits.into_iter().map(|(r, c)| (s.id, r, c)));
            if out.len() >= 10_000 {
                break;
            }
        }
        out
    }

    /// Replace text in cell inputs (literals and formulas). Returns the number of cells changed.
    pub fn replace(
        &mut self,
        query: &str,
        replacement: &str,
        match_case: bool,
        whole_cell: bool,
    ) -> Result<(usize, EditOutcome), SheetError> {
        if query.is_empty() {
            return Ok((0, EditOutcome::default()));
        }
        let hits = self.find(query, match_case, whole_cell, true);
        let mut edits: Vec<(SheetId, u32, u32, String)> = Vec::new();
        for (sid, r, c) in hits {
            let Some(cell) = self.sheet(sid).and_then(|s| s.cell(r, c)) else {
                continue;
            };
            let text = self.input_text(cell);
            let new = if whole_cell {
                replacement.to_string()
            } else if match_case {
                text.replace(query, replacement)
            } else {
                let lower = text.to_lowercase();
                let ql = query.to_lowercase();
                let mut out = String::new();
                let mut i = 0;
                while let Some(p) = lower[i..].find(&ql) {
                    out.push_str(&text[i..i + p]);
                    out.push_str(replacement);
                    i += p + ql.len();
                }
                out.push_str(&text[i..]);
                out
            };
            if new != text {
                edits.push((sid, r, c, new));
            }
        }
        let mut ops = Vec::new();
        for (sid, r, c, text) in &edits {
            if let Ok(data) = self.cell_data_for_input(*sid, *r, *c, Some(text)) {
                ops.push(Op::Cell {
                    sheet: *sid,
                    row: *r,
                    col: *c,
                    data,
                });
            }
        }
        let n = ops.len();
        let out = self.transact("Replace", None, ops)?;
        Ok((n, out))
    }

    /// Values of a rectangle as rows of display-independent values (for "convert to database").
    pub fn rect_values(&self, sheet: SheetId, rect: Rect) -> Vec<Vec<Value>> {
        let Some(s) = self.sheet(sheet) else {
            return Vec::new();
        };
        (rect.r0..=rect.r1)
            .map(|r| (rect.c0..=rect.c1).map(|c| s.value_at(r, c)).collect())
            .collect()
    }

    /// Run the workbook linter (Spreadsheet Studio advisor rules).
    pub fn lint(&self) -> Vec<LintFinding> {
        let mut out = Vec::new();
        let mut used_names: rustc_hash::FxHashSet<String> = rustc_hash::FxHashSet::default();
        let mut volatile = 0usize;
        for s in &self.sheets {
            let mut push = |rule: &str, rect: Rect, message: String, fix: Option<String>| {
                out.push(LintFinding {
                    id: format!("{}:{}:{}", rule, s.id, format_rect(&rect)),
                    sheet_id: s.id,
                    rect,
                    rule: rule.to_string(),
                    message,
                    fix,
                });
            };
            for (&c, col) in &s.cols {
                for (&r, cell) in col {
                    let at = Rect::cell(r, c);
                    let a1 = format_rect(&at);
                    match &cell.input {
                        CellInput::Formula(f) => {
                            f.expr.walk(&mut |e| {
                                if let Expr::Name(n) = e {
                                    used_names.insert(n.to_uppercase());
                                }
                            });
                            if f.volatile {
                                volatile += 1;
                            }
                            let mut has_invalid = false;
                            let mut has_ref = false;
                            let mut has_const = false;
                            f.expr.walk(&mut |e| match e {
                                Expr::Ref(rf) if matches!(rf.target, RefTarget::Invalid) => {
                                    has_invalid = true
                                }
                                Expr::Ref(_) | Expr::Name(_) => has_ref = true,
                                Expr::Number(n)
                                    if *n != 0.0 && *n != 1.0 && *n != 100.0 && *n != 12.0 =>
                                {
                                    has_const = true
                                }
                                _ => {}
                            });
                            match cell.value.scalar() {
                                Value::Error(ErrorKind::Ref) => push(
                                    "ref_error",
                                    at,
                                    format!("{a1} shows #REF! — a referenced cell was deleted."),
                                    None,
                                ),
                                Value::Error(ErrorKind::Div0) => push(
                                    "div0",
                                    at,
                                    format!("{a1} divides by zero."),
                                    Some(format!("=IFERROR({},0)", print_excel(&f.expr, self))),
                                ),
                                Value::Error(ErrorKind::Circ) => push(
                                    "circular",
                                    at,
                                    format!("{a1} is part of a circular reference."),
                                    None,
                                ),
                                _ => {
                                    if has_invalid {
                                        push(
                                            "ref_error",
                                            at,
                                            format!("{a1} contains a #REF! reference."),
                                            None,
                                        );
                                    }
                                }
                            }
                            if has_ref && has_const {
                                push(
                                    "hardcoded_constant",
                                    at,
                                    format!(
                                        "{a1} mixes a hard-coded number into a formula; consider a named input cell."
                                    ),
                                    None,
                                );
                            }
                            // Inconsistent with the formulas directly above and below.
                            let sig = |row: u32| -> Option<String> {
                                match s.cell(row, c).map(|x| &x.input) {
                                    Some(CellInput::Formula(g)) => {
                                        Some(r1c1_signature(&g.expr, row, c, self))
                                    }
                                    _ => None,
                                }
                            };
                            if r > 0 {
                                let me = r1c1_signature(&f.expr, r, c, self);
                                if let (Some(up), Some(down)) = (sig(r - 1), sig(r + 1))
                                    && up == down
                                    && up != me
                                {
                                    push(
                                        "inconsistent_formula",
                                        at,
                                        format!("{a1} differs from the formulas above and below."),
                                        None,
                                    );
                                }
                            }
                        }
                        CellInput::Value(Value::Text(t)) if parse_number_text(t).is_some() => {
                            push(
                                "number_as_text",
                                at,
                                format!("{a1} is a number stored as text."),
                                Some(t.trim().to_string()),
                            );
                        }
                        _ => {}
                    }
                }
            }
            for m in &s.merges {
                let mut filled = 0;
                s.for_each_cell(m, |_, _, cell| {
                    if cell.has_content() {
                        filled += 1;
                    }
                });
                let (rows, _) = s.extent();
                if m.r0 > 0 && m.r1 + 1 < rows {
                    push(
                        "merged_in_data",
                        *m,
                        format!("Merged cells {} sit inside a data range.", format_rect(m)),
                        None,
                    );
                }
                let _ = filled;
            }
        }
        for n in self.names.values() {
            if !used_names.contains(&n.name.to_uppercase())
                && let Some(s) = self.sheets.first()
            {
                out.push(LintFinding {
                    id: format!("unused_name:{}", n.name),
                    sheet_id: s.id,
                    rect: Rect::cell(0, 0),
                    rule: "unused_name".into(),
                    message: format!("The name {} is not used by any formula.", n.name),
                    fix: None,
                });
            }
        }
        if volatile > 100
            && let Some(s) = self.sheets.first()
        {
            out.push(LintFinding {
                id: "volatile_heavy".into(),
                sheet_id: s.id,
                rect: Rect::cell(0, 0),
                rule: "volatile_heavy".into(),
                message: format!("{volatile} formulas use volatile functions (NOW, RAND, OFFSET, INDIRECT…), which recalculate on every change."),
                fix: None,
            });
        }
        out
    }
}

/// R1C1-style signature of a formula placed at `(row, col)` (relative references become offsets).
pub fn r1c1_signature(expr: &Expr, row: u32, col: u32, names: &Workbook) -> String {
    let mut e = expr.clone();
    e.walk_mut(&mut |x| {
        if let Expr::Ref(r) = x {
            let part = |v: u32, abs: bool, base: u32, p: char| {
                if abs {
                    format!("{p}{}", v + 1)
                } else {
                    format!("{p}[{}]", v as i64 - base as i64)
                }
            };
            let cell = |c: &crate::ast::CellRef| {
                format!(
                    "{}{}",
                    part(c.row, c.row_abs, row, 'R'),
                    part(c.col, c.col_abs, col, 'C')
                )
            };
            let s = match &r.target {
                RefTarget::Cell(c) => cell(c),
                RefTarget::Area(a, b) => format!("{}:{}", cell(a), cell(b)),
                other => format!("{other:?}"),
            };
            let sheet = match &r.sheet {
                Some(sr) => format!("{sr:?}!"),
                None => String::new(),
            };
            *x = Expr::Name(format!("{sheet}{s}"));
        }
    });
    print_excel(&e, names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsv_parsing() {
        assert_eq!(
            parse_tsv("a\tb\nc\td"),
            vec![vec!["a", "b"], vec!["c", "d"]]
        );
        assert_eq!(parse_tsv("\"x\ty\"\tz\r\n"), vec![vec!["x\ty", "z"]]);
        assert_eq!(parse_tsv("\"say \"\"hi\"\"\""), vec![vec!["say \"hi\""]]);
    }

    #[test]
    fn text_series_parse() {
        assert_eq!(text_series("Item 9"), Some(("Item ".into(), 9, 1)));
        assert_eq!(text_series("Q007"), Some(("Q".into(), 7, 3)));
        assert_eq!(text_series("abc"), None);
    }
}
