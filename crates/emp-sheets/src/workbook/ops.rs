//! Primitive, invertible edit operations, the undo stack (200 groups per workbook, §14.2), and the
//! high-level edit API used by the IPC layer.

use super::recalc::{RecalcReport, Seeds};
use super::sheet::{Cell, CellInput, CondFormatRule, Sheet};
use super::structural::StructOp;
use super::style::StylePatch;
use super::{
    CalcSettings, DefinedName, ParsedInput, SheetError, Workbook, is_valid_name, parse_input,
};
use crate::address::{CellKey, Rect, SheetId, is_valid_sheet_name};
use crate::limits::UNDO_GROUPS;
use crate::value::Value;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

/// The full content of a cell, used for undo snapshots.
#[derive(Clone, Debug, PartialEq)]
pub struct CellData {
    /// Entered content.
    pub input: CellInput,
    /// Style id.
    pub style: u32,
    /// Cached value.
    pub value: Value,
}

impl From<Cell> for CellData {
    fn from(c: Cell) -> Self {
        CellData {
            input: c.input,
            style: c.style,
            value: c.value,
        }
    }
}

/// A primitive operation. Applying one returns its inverse.
#[derive(Clone, Debug)]
pub enum Op {
    /// Replace a cell (or remove it with `None`).
    Cell {
        /// Sheet.
        sheet: SheetId,
        /// Row.
        row: u32,
        /// Column.
        col: u32,
        /// New content.
        data: Option<CellData>,
    },
    /// Insert/delete rows or columns.
    Structural(Box<StructOp>),
    /// Insert a sheet at a tab position.
    AddSheet {
        /// Tab position.
        index: usize,
        /// The sheet.
        sheet: Box<Sheet>,
    },
    /// Remove a sheet.
    RemoveSheet {
        /// Sheet id.
        id: SheetId,
    },
    /// Set sheet metadata.
    SheetMeta {
        /// Sheet id.
        id: SheetId,
        /// Name.
        name: String,
        /// Tab colour.
        color: Option<String>,
        /// Hidden.
        hidden: bool,
        /// Frozen `(rows, cols)`.
        frozen: (u32, u32),
    },
    /// Move a sheet to a tab position.
    MoveSheet {
        /// Sheet id.
        id: SheetId,
        /// New tab position.
        index: usize,
    },
    /// Set or remove a defined name.
    Name {
        /// Upper-case key.
        key: String,
        /// New value.
        value: Option<DefinedName>,
    },
    /// Replace the merges of a sheet.
    Merges {
        /// Sheet.
        sheet: SheetId,
        /// Merges.
        merges: Vec<Rect>,
    },
    /// Replace custom row heights (`rows = true`) or column widths.
    Sizes {
        /// Sheet.
        sheet: SheetId,
        /// Rows or columns.
        rows: bool,
        /// Sizes.
        map: BTreeMap<u32, f64>,
    },
    /// Replace conditional formats.
    CondFormats {
        /// Sheet.
        sheet: SheetId,
        /// Rules.
        rules: Vec<CondFormatRule>,
    },
    /// Replace charts.
    Charts {
        /// Sheet.
        sheet: SheetId,
        /// Charts.
        charts: Vec<serde_json::Value>,
    },
    /// Replace calculation settings.
    Calc(CalcSettings),
}

/// Side effects of applied operations, turned into a recalculation.
#[derive(Debug, Default)]
pub(crate) struct Effects {
    pub seeds: Seeds,
    pub rebuild: bool,
    pub sheets: Vec<SheetId>,
}

impl Effects {
    fn sheet(&mut self, id: SheetId) {
        if !self.sheets.contains(&id) {
            self.sheets.push(id);
        }
    }
}

/// One undo step.
#[derive(Clone, Debug)]
pub struct UndoGroup {
    /// Label ("Typing", "Paste", …).
    pub label: String,
    key: Option<String>,
    ops: Vec<Op>,
}

/// Undo and redo stacks.
#[derive(Clone, Debug, Default)]
pub struct UndoStack {
    undo: VecDeque<UndoGroup>,
    redo: Vec<UndoGroup>,
}

impl UndoStack {
    /// Number of undo groups.
    pub fn undo_len(&self) -> usize {
        self.undo.len()
    }
    /// Number of redo groups.
    pub fn redo_len(&self) -> usize {
        self.redo.len()
    }
    /// Labels of the undo groups, most recent last.
    pub fn labels(&self) -> Vec<String> {
        self.undo.iter().map(|g| g.label.clone()).collect()
    }
    fn push(&mut self, g: UndoGroup) {
        self.redo.clear();
        if let (Some(k), Some(top)) = (&g.key, self.undo.back_mut())
            && top.key.as_ref() == Some(k)
        {
            top.ops.extend(g.ops);
            return;
        }
        self.undo.push_back(g);
        while self.undo.len() > UNDO_GROUPS {
            self.undo.pop_front();
        }
    }
}

/// One cell edit (`sheet_set_cells` item). `input: None` clears the content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    /// Row.
    pub row: u32,
    /// Column.
    pub col: u32,
    /// Typed text, or `None` to clear.
    pub input: Option<String>,
}

/// A rejected cell edit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellError {
    /// Row.
    pub row: u32,
    /// Column.
    pub col: u32,
    /// Message (formula parse errors include the span in `from..to`).
    pub message: String,
}

/// Result of an edit.
#[derive(Clone, Debug, Default)]
pub struct EditOutcome {
    /// Recalculation report.
    pub report: RecalcReport,
    /// Sheets touched by the edit.
    pub changed_sheets: Vec<SheetId>,
    /// Rejected edits.
    pub errors: Vec<CellError>,
    /// Workbook revision after the edit.
    pub rev: u64,
}

/// What `clear` removes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClearWhat {
    /// Content and formats.
    All,
    /// Content only.
    Contents,
    /// Formats only.
    Formats,
}

/// Row or column axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    /// Rows.
    Rows,
    /// Columns.
    Cols,
}

const STYLE_FILL_LIMIT: u64 = 100_000;

impl Workbook {
    pub(crate) fn apply_op(&mut self, op: Op, fx: &mut Effects) -> Result<Op, SheetError> {
        match op {
            Op::Cell {
                sheet,
                row,
                col,
                data,
            } => {
                let key = CellKey::new(sheet, row, col);
                let s = self
                    .sheet_mut(sheet)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
                let prev = s.take(row, col);
                if let Some(rect) = s.clear_spill((row, col)) {
                    fx.seeds.rects.push((sheet, rect));
                }
                s.blocked.remove(&(row, col));
                let new_formula = data.as_ref().is_some_and(|d| d.input.is_formula());
                if let Some(d) = data
                    && (d.style != 0 || !matches!(&d.input, CellInput::Value(Value::Empty)))
                {
                    let value = match &d.input {
                        CellInput::Value(v) => v.clone(),
                        CellInput::Formula(_) => d.value.clone(),
                    };
                    s.put(
                        row,
                        col,
                        Cell {
                            input: d.input.clone(),
                            value,
                            style: d.style,
                        },
                    );
                    if let CellInput::Formula(f) = &d.input {
                        let p = self.precedents(&f.expr, sheet);
                        self.deps.set(key, &p, f.volatile || f.external);
                    }
                }
                if prev.as_ref().is_some_and(|c| c.input.is_formula()) && !new_formula {
                    self.deps.remove(key);
                }
                fx.seeds.positions.push(key);
                if new_formula {
                    fx.seeds.formulas.push(key);
                }
                fx.sheet(sheet);
                Ok(Op::Cell {
                    sheet,
                    row,
                    col,
                    data: prev.map(CellData::from),
                })
            }
            Op::Structural(st) => self.apply_structural(*st, fx),
            Op::AddSheet { index, sheet } => {
                let id = sheet.id;
                if self.sheet(id).is_some() {
                    return Err(SheetError::Invalid("sheet id already exists".into()));
                }
                let idx = index.min(self.sheets.len());
                self.sheets.insert(idx, *sheet);
                if id >= self.next_sheet_id {
                    self.next_sheet_id = id.wrapping_add(1);
                }
                self.rebind_all();
                fx.rebuild = true;
                fx.seeds.all = true;
                fx.sheet(id);
                Ok(Op::RemoveSheet { id })
            }
            Op::RemoveSheet { id } => {
                let idx = self
                    .sheet_index(id)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {id}")))?;
                let sheet = self.sheets.remove(idx);
                fx.rebuild = true;
                fx.seeds.all = true;
                fx.sheet(id);
                Ok(Op::AddSheet {
                    index: idx,
                    sheet: Box::new(sheet),
                })
            }
            Op::SheetMeta {
                id,
                name,
                color,
                hidden,
                frozen,
            } => {
                let s = self
                    .sheet_mut(id)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {id}")))?;
                let inv = Op::SheetMeta {
                    id,
                    name: s.name.clone(),
                    color: s.color.clone(),
                    hidden: s.hidden,
                    frozen: (s.frozen_rows, s.frozen_cols),
                };
                let renamed = s.name != name;
                s.name = name;
                s.color = color;
                s.hidden = hidden;
                s.frozen_rows = frozen.0;
                s.frozen_cols = frozen.1;
                if renamed {
                    self.rebind_all();
                    fx.rebuild = true;
                    fx.seeds.all = true;
                }
                fx.sheet(id);
                Ok(inv)
            }
            Op::MoveSheet { id, index } => {
                let idx = self
                    .sheet_index(id)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {id}")))?;
                let s = self.sheets.remove(idx);
                let to = index.min(self.sheets.len());
                self.sheets.insert(to, s);
                fx.sheet(id);
                Ok(Op::MoveSheet { id, index: idx })
            }
            Op::Name { key, value } => {
                let prev = match value {
                    Some(v) => self.names.insert(key.clone(), v),
                    None => self.names.remove(&key),
                };
                for f in self.deps.name_dependents(&key) {
                    fx.seeds.formulas.push(f);
                }
                fx.rebuild = true;
                Ok(Op::Name { key, value: prev })
            }
            Op::Merges { sheet, merges } => {
                let s = self
                    .sheet_mut(sheet)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
                let prev = std::mem::replace(&mut s.merges, merges);
                fx.sheet(sheet);
                Ok(Op::Merges {
                    sheet,
                    merges: prev,
                })
            }
            Op::Sizes { sheet, rows, map } => {
                let s = self
                    .sheet_mut(sheet)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
                let prev = if rows {
                    std::mem::replace(&mut s.row_heights, map)
                } else {
                    std::mem::replace(&mut s.col_widths, map)
                };
                fx.sheet(sheet);
                Ok(Op::Sizes {
                    sheet,
                    rows,
                    map: prev,
                })
            }
            Op::CondFormats { sheet, rules } => {
                let s = self
                    .sheet_mut(sheet)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
                let prev = std::mem::replace(&mut s.cond_formats, rules);
                fx.sheet(sheet);
                Ok(Op::CondFormats { sheet, rules: prev })
            }
            Op::Charts { sheet, charts } => {
                let s = self
                    .sheet_mut(sheet)
                    .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
                let prev = std::mem::replace(&mut s.charts, charts);
                fx.sheet(sheet);
                Ok(Op::Charts {
                    sheet,
                    charts: prev,
                })
            }
            Op::Calc(c) => {
                let prev = std::mem::replace(&mut self.calc, c);
                fx.seeds.all = true;
                Ok(Op::Calc(prev))
            }
        }
    }

    /// Re-bind sheet names in every formula and name (after sheets are added or renamed).
    pub(crate) fn rebind_all(&mut self) {
        let lookup: Vec<(String, SheetId)> = self
            .sheets
            .iter()
            .map(|s| (s.name.to_lowercase(), s.id))
            .collect();
        let bind = |e: &mut crate::ast::Expr| {
            e.for_each_ref_mut(&mut |r| {
                if let Some(crate::ast::SheetRef::Named(n)) = &r.sheet {
                    let l = n.to_lowercase();
                    if let Some((_, id)) = lookup.iter().find(|(name, _)| *name == l) {
                        r.sheet = Some(crate::ast::SheetRef::Id(*id));
                    }
                }
            });
        };
        for s in self.sheets.iter_mut() {
            for col in s.cols.values_mut() {
                for cell in col.values_mut() {
                    if let CellInput::Formula(f) = &cell.input {
                        let needs = {
                            let mut n = false;
                            f.expr.walk(&mut |e| {
                                if let crate::ast::Expr::Ref(r) = e
                                    && matches!(r.sheet, Some(crate::ast::SheetRef::Named(_)))
                                {
                                    n = true;
                                }
                            });
                            n
                        };
                        if needs {
                            let mut nf = (**f).clone();
                            bind(&mut nf.expr);
                            cell.input = CellInput::Formula(Arc::new(nf));
                        }
                    }
                }
            }
        }
        for n in self.names.values_mut() {
            let mut e = (*n.expr).clone();
            bind(&mut e);
            n.expr = Arc::new(e);
        }
    }

    /// Apply operations as one undo group and recalculate.
    pub(crate) fn transact(
        &mut self,
        label: &str,
        key: Option<String>,
        ops: Vec<Op>,
    ) -> Result<EditOutcome, SheetError> {
        let r = catch_unwind(AssertUnwindSafe(|| -> Result<EditOutcome, SheetError> {
            let mut fx = Effects::default();
            let mut inverses = Vec::with_capacity(ops.len());
            for op in ops {
                match self.apply_op(op, &mut fx) {
                    Ok(inv) => inverses.push(inv),
                    Err(e) => {
                        // roll back what was applied
                        let mut rb = Effects::default();
                        for inv in inverses.into_iter().rev() {
                            let _ = self.apply_op(inv, &mut rb);
                        }
                        self.finish(rb);
                        return Err(e);
                    }
                }
            }
            if !inverses.is_empty() {
                inverses.reverse();
                self.undo.push(UndoGroup {
                    label: label.to_string(),
                    key,
                    ops: inverses,
                });
            }
            Ok(self.finish(fx))
        }));
        r.unwrap_or_else(|_| Err(SheetError::Internal("edit panicked".into())))
    }

    pub(crate) fn finish(&mut self, fx: Effects) -> EditOutcome {
        if fx.rebuild {
            self.rebuild_deps();
        }
        let edited = fx.seeds.positions.clone();
        let mut report = self.guarded_recalc(fx.seeds, None);
        // Edited cells are always reported as changed so the grid repaints them.
        report.changed.extend(edited);
        report.changed.sort_unstable();
        report.changed.dedup();
        self.touch();
        EditOutcome {
            report,
            changed_sheets: fx.sheets,
            errors: Vec::new(),
            rev: self.rev,
        }
    }

    fn replay(&mut self, from_undo: bool) -> Option<EditOutcome> {
        let group = if from_undo {
            self.undo.undo.pop_back()?
        } else {
            self.undo.redo.pop()?
        };
        let mut fx = Effects::default();
        let mut inverses = Vec::with_capacity(group.ops.len());
        for op in group.ops {
            if let Ok(inv) = self.apply_op(op, &mut fx) {
                inverses.push(inv);
            }
        }
        inverses.reverse();
        let g = UndoGroup {
            label: group.label,
            key: None,
            ops: inverses,
        };
        if from_undo {
            self.undo.redo.push(g);
        } else {
            self.undo.undo.push_back(g);
        }
        Some(self.finish(fx))
    }

    /// Undo the last group. Returns `None` when there is nothing to undo.
    pub fn undo(&mut self) -> Option<EditOutcome> {
        catch_unwind(AssertUnwindSafe(|| self.replay(true)))
            .ok()
            .flatten()
    }

    /// Redo the last undone group.
    pub fn redo(&mut self) -> Option<EditOutcome> {
        catch_unwind(AssertUnwindSafe(|| self.replay(false)))
            .ok()
            .flatten()
    }

    /// The undo stack (labels and sizes).
    pub fn undo_stack(&self) -> &UndoStack {
        &self.undo
    }

    /// Build the cell data for typed text, keeping the existing style (and adding a format hint).
    pub(crate) fn cell_data_for_input(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        input: Option<&str>,
    ) -> Result<Option<CellData>, String> {
        let existing_style = self
            .sheet(sheet)
            .and_then(|s| s.cell(row, col))
            .map(|c| c.style)
            .unwrap_or(0);
        let text = input.unwrap_or("");
        match parse_input(text, self.calc.date1904) {
            ParsedInput::Clear => {
                if existing_style == 0 {
                    Ok(None)
                } else {
                    Ok(Some(CellData {
                        input: CellInput::Value(Value::Empty),
                        style: existing_style,
                        value: Value::Empty,
                    }))
                }
            }
            ParsedInput::Value(v, hint) => {
                let mut style = existing_style;
                if let Some(h) = hint
                    && self.styles.num_fmt(style).is_none()
                {
                    let patch = StylePatch {
                        num_fmt: Some(Some(h.to_string())),
                        ..Default::default()
                    };
                    style = self.styles.patched(style, &patch);
                }
                Ok(Some(CellData {
                    input: CellInput::Value(v.clone()),
                    style,
                    value: v,
                }))
            }
            ParsedInput::Formula(src) => match self.compile(&src) {
                Ok(f) => Ok(Some(CellData {
                    input: CellInput::Formula(Arc::new(f)),
                    style: existing_style,
                    value: Value::Empty,
                })),
                Err(SheetError::Parse(p)) => {
                    Err(format!("{} ({}..{})", p.message, p.start + 1, p.end + 1))
                }
                Err(e) => Err(e.to_string()),
            },
        }
    }

    /// Set cell inputs (typing, paste of text). Invalid formulas are reported in `errors` and skipped.
    pub fn set_cells(
        &mut self,
        sheet: SheetId,
        edits: &[CellEdit],
        undo_group: Option<&str>,
    ) -> Result<EditOutcome, SheetError> {
        if self.sheet(sheet).is_none() {
            return Err(SheetError::NotFound(format!("sheet {sheet}")));
        }
        let mut ops = Vec::with_capacity(edits.len());
        let mut errors = Vec::new();
        for e in edits {
            Self::check_coord(e.row, e.col)?;
            if e.input
                .as_ref()
                .is_some_and(|s| s.chars().count() > crate::limits::MAX_FORMULA_LEN * 4)
            {
                errors.push(CellError {
                    row: e.row,
                    col: e.col,
                    message: "Input is too long".into(),
                });
                continue;
            }
            match self.cell_data_for_input(sheet, e.row, e.col, e.input.as_deref()) {
                Ok(data) => ops.push(Op::Cell {
                    sheet,
                    row: e.row,
                    col: e.col,
                    data,
                }),
                Err(message) => errors.push(CellError {
                    row: e.row,
                    col: e.col,
                    message,
                }),
            }
        }
        let mut out = self.transact("Edit cells", undo_group.map(|s| s.to_string()), ops)?;
        out.errors = errors;
        Ok(out)
    }

    /// Set one cell from typed text (convenience).
    pub fn set_input(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        input: &str,
    ) -> Result<EditOutcome, SheetError> {
        let edit = CellEdit {
            row,
            col,
            input: if input.is_empty() {
                None
            } else {
                Some(input.to_string())
            },
        };
        let out = self.set_cells(sheet, &[edit], None)?;
        if let Some(e) = out.errors.first() {
            return Err(SheetError::Invalid(e.message.clone()));
        }
        Ok(out)
    }

    /// Apply a style patch to rectangles.
    pub fn set_style(
        &mut self,
        sheet: SheetId,
        rects: &[Rect],
        patch: &StylePatch,
    ) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(sheet)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
        let mut targets: Vec<(u32, u32, Option<Cell>)> = Vec::new();
        for rect in rects {
            if rect.area() <= STYLE_FILL_LIMIT {
                for r in rect.r0..=rect.r1 {
                    for c in rect.c0..=rect.c1 {
                        targets.push((r, c, s.cell(r, c).cloned()));
                    }
                }
            } else {
                s.for_each_cell(rect, |r, c, cell| targets.push((r, c, Some(cell.clone()))));
            }
        }
        let mut ops = Vec::with_capacity(targets.len());
        for (r, c, cell) in targets {
            let (input, value, style) = match cell {
                Some(cell) => (cell.input, cell.value, cell.style),
                None => (CellInput::Value(Value::Empty), Value::Empty, 0),
            };
            let ns = self.styles.patched(style, patch);
            if ns == style {
                continue;
            }
            ops.push(Op::Cell {
                sheet,
                row: r,
                col: c,
                data: Some(CellData {
                    input,
                    style: ns,
                    value,
                }),
            });
        }
        self.transact("Format cells", None, ops)
    }

    /// Clear contents and/or formats.
    pub fn clear(
        &mut self,
        sheet: SheetId,
        rects: &[Rect],
        what: ClearWhat,
    ) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(sheet)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
        let mut ops = Vec::new();
        for rect in rects {
            s.for_each_cell(rect, |r, c, cell| {
                let data = match what {
                    ClearWhat::All => None,
                    ClearWhat::Contents => {
                        if cell.style == 0 {
                            None
                        } else {
                            Some(CellData {
                                input: CellInput::Value(Value::Empty),
                                style: cell.style,
                                value: Value::Empty,
                            })
                        }
                    }
                    ClearWhat::Formats => {
                        if !cell.has_content() {
                            None
                        } else {
                            Some(CellData {
                                input: cell.input.clone(),
                                style: 0,
                                value: cell.value.clone(),
                            })
                        }
                    }
                };
                ops.push(Op::Cell {
                    sheet,
                    row: r,
                    col: c,
                    data,
                });
            });
        }
        self.transact("Clear", None, ops)
    }

    /// Add a sheet after `after` (or at the end). Returns its id.
    pub fn add_sheet(
        &mut self,
        name: Option<&str>,
        after: Option<SheetId>,
    ) -> Result<SheetId, SheetError> {
        let name = match name {
            Some(n) => {
                if !is_valid_sheet_name(n) {
                    return Err(SheetError::Invalid(format!("invalid sheet name: {n}")));
                }
                if self.sheet_by_name(n).is_some() {
                    return Err(SheetError::Invalid(format!(
                        "a sheet named {n} already exists"
                    )));
                }
                n.to_string()
            }
            None => self.unique_sheet_name(&format!("Sheet{}", self.sheets.len() + 1)),
        };
        let index = match after {
            Some(a) => self
                .sheet_index(a)
                .map(|i| i + 1)
                .unwrap_or(self.sheets.len()),
            None => self.sheets.len(),
        };
        let id = self.next_sheet_id;
        let sheet = Sheet::new(id, name);
        self.transact(
            "Add sheet",
            None,
            vec![Op::AddSheet {
                index,
                sheet: Box::new(sheet),
            }],
        )?;
        Ok(id)
    }

    /// Update sheet name / colour / hidden.
    pub fn update_sheet(
        &mut self,
        id: SheetId,
        name: Option<&str>,
        color: Option<Option<String>>,
        hidden: Option<bool>,
    ) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(id)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {id}")))?;
        let mut new_name = s.name.clone();
        if let Some(n) = name {
            if !is_valid_sheet_name(n) {
                return Err(SheetError::Invalid(format!("invalid sheet name: {n}")));
            }
            if let Some(other) = self.sheet_by_name(n)
                && other.id != id
            {
                return Err(SheetError::Invalid(format!(
                    "a sheet named {n} already exists"
                )));
            }
            new_name = n.to_string();
        }
        if hidden == Some(true)
            && self
                .sheets
                .iter()
                .filter(|x| !x.hidden && x.id != id)
                .count()
                == 0
        {
            return Err(SheetError::Invalid(
                "at least one sheet must stay visible".into(),
            ));
        }
        let op = Op::SheetMeta {
            id,
            name: new_name,
            color: color.unwrap_or_else(|| s.color.clone()),
            hidden: hidden.unwrap_or(s.hidden),
            frozen: (s.frozen_rows, s.frozen_cols),
        };
        self.transact("Update sheet", None, vec![op])
    }

    /// Freeze panes.
    pub fn freeze(&mut self, id: SheetId, rows: u32, cols: u32) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(id)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {id}")))?;
        let op = Op::SheetMeta {
            id,
            name: s.name.clone(),
            color: s.color.clone(),
            hidden: s.hidden,
            frozen: (rows, cols),
        };
        self.transact("Freeze panes", None, vec![op])
    }

    /// Remove a sheet (the last visible sheet cannot be removed).
    pub fn remove_sheet(&mut self, id: SheetId) -> Result<EditOutcome, SheetError> {
        if self.sheet(id).is_none() {
            return Err(SheetError::NotFound(format!("sheet {id}")));
        }
        if self.sheets.len() <= 1 {
            return Err(SheetError::Invalid(
                "a workbook needs at least one sheet".into(),
            ));
        }
        self.transact("Delete sheet", None, vec![Op::RemoveSheet { id }])
    }

    /// Move a sheet to a tab position.
    pub fn move_sheet(&mut self, id: SheetId, index: usize) -> Result<EditOutcome, SheetError> {
        if self.sheet(id).is_none() {
            return Err(SheetError::NotFound(format!("sheet {id}")));
        }
        self.transact("Move sheet", None, vec![Op::MoveSheet { id, index }])
    }

    /// Define (or remove with `None`) a workbook-level name, e.g. `Rate` → `Inputs!$B$2`.
    pub fn set_named_range(
        &mut self,
        name: &str,
        reference: Option<&str>,
    ) -> Result<EditOutcome, SheetError> {
        if !is_valid_name(name) {
            return Err(SheetError::Invalid(format!("invalid name: {name}")));
        }
        let key = name.to_uppercase();
        let value = match reference {
            Some(r) => Some(DefinedName {
                name: name.to_string(),
                expr: Arc::new(self.name_expr(r)?),
            }),
            None => None,
        };
        self.transact("Define name", None, vec![Op::Name { key, value }])
    }

    /// Set custom sizes (`None` resets to automatic).
    pub fn resize(
        &mut self,
        sheet: SheetId,
        axis: Axis,
        indices: &[u32],
        size: Option<f64>,
    ) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(sheet)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
        let rows = axis == Axis::Rows;
        let mut map = if rows {
            s.row_heights.clone()
        } else {
            s.col_widths.clone()
        };
        for &i in indices {
            match size {
                Some(x) if x.is_finite() && x >= 0.0 => {
                    map.insert(i, x.min(4096.0));
                }
                _ => {
                    map.remove(&i);
                }
            }
        }
        self.transact("Resize", None, vec![Op::Sizes { sheet, rows, map }])
    }

    /// Merge or unmerge a rectangle.
    pub fn merge(
        &mut self,
        sheet: SheetId,
        rect: Rect,
        merge: bool,
    ) -> Result<EditOutcome, SheetError> {
        let s = self
            .sheet(sheet)
            .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
        let mut merges: Vec<Rect> = s
            .merges
            .iter()
            .filter(|m| !m.intersects(&rect))
            .copied()
            .collect();
        if merge && rect.area() > 1 {
            merges.push(rect);
        }
        self.transact(
            if merge { "Merge" } else { "Unmerge" },
            None,
            vec![Op::Merges { sheet, merges }],
        )
    }

    /// Replace the conditional formats of a sheet.
    pub fn set_cond_formats(
        &mut self,
        sheet: SheetId,
        rules: Vec<CondFormatRule>,
    ) -> Result<EditOutcome, SheetError> {
        self.transact(
            "Conditional formatting",
            None,
            vec![Op::CondFormats { sheet, rules }],
        )
    }

    /// Replace the charts of a sheet (opaque JSON specs).
    pub fn set_charts(
        &mut self,
        sheet: SheetId,
        charts: Vec<serde_json::Value>,
    ) -> Result<EditOutcome, SheetError> {
        self.transact("Charts", None, vec![Op::Charts { sheet, charts }])
    }

    /// Change calculation settings.
    pub fn set_calc_settings(&mut self, calc: CalcSettings) -> Result<EditOutcome, SheetError> {
        self.transact("Calculation settings", None, vec![Op::Calc(calc)])
    }

    /// Insert rows or columns.
    pub fn insert_span(
        &mut self,
        sheet: SheetId,
        axis: Axis,
        at: u32,
        count: u32,
    ) -> Result<EditOutcome, SheetError> {
        let op = StructOp::new(sheet, axis, at, count, true)?;
        self.transact("Insert", None, vec![Op::Structural(Box::new(op))])
    }

    /// Delete rows or columns. References to deleted cells become `#REF!`.
    pub fn delete_span(
        &mut self,
        sheet: SheetId,
        axis: Axis,
        at: u32,
        count: u32,
    ) -> Result<EditOutcome, SheetError> {
        let op = StructOp::new(sheet, axis, at, count, false)?;
        self.transact("Delete", None, vec![Op::Structural(Box::new(op))])
    }
}
