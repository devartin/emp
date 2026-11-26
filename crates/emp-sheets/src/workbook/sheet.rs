//! Sheet storage: sparse cells per column, spill bookkeeping, sizes, merges, conditional formats.

use crate::address::{Rect, SheetId};
use crate::ast::Expr;
use crate::value::Value;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A compiled formula (bound to sheet ids).
#[derive(Clone, Debug, PartialEq)]
pub struct Formula {
    /// Bound AST.
    pub expr: Expr,
    /// Contains a volatile function.
    pub volatile: bool,
    /// Uses a dynamic-array function (may spill).
    pub dynamic: bool,
    /// Reads external data (STOCK / FX / CRYPTO).
    pub external: bool,
}

/// What the user entered in a cell.
#[derive(Clone, Debug, PartialEq)]
pub enum CellInput {
    /// A literal value (number, text, boolean or error). `Empty` means "style only".
    Value(Value),
    /// A formula.
    Formula(Arc<Formula>),
}

impl CellInput {
    /// Is this a formula?
    pub fn is_formula(&self) -> bool {
        matches!(self, CellInput::Formula(_))
    }
}

/// One stored cell.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    /// Entered content.
    pub input: CellInput,
    /// Cached value (for spilling anchors: the whole array).
    pub value: Value,
    /// Style id.
    pub style: u32,
}

impl Cell {
    /// A literal cell.
    pub fn literal(v: Value, style: u32) -> Cell {
        Cell {
            input: CellInput::Value(v.clone()),
            value: v,
            style,
        }
    }
    /// Does the cell carry content (not just a style)?
    pub fn has_content(&self) -> bool {
        match &self.input {
            CellInput::Value(v) => !v.is_empty(),
            CellInput::Formula(_) => true,
        }
    }
    /// Top-left value (anchors of a spill show the first element).
    pub fn shown(&self) -> &Value {
        self.value.scalar()
    }
}

/// Conditional format rule (IPC `CondFormatRule`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CondFormatRule {
    /// Optional id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Target rectangle.
    pub rect: Rect,
    /// `cell` | `formula` | `data_bar` | `color_scale`.
    pub kind: String,
    /// `gt` | `lt` | `between` | `eq` | `text_contains`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    /// Operand values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    /// Formula (relative to the top-left cell of `rect`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    /// Style applied when the rule matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_id: Option<u32>,
    /// Colours for data bars / colour scales.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<Vec<String>>,
}

/// A worksheet.
#[derive(Clone, Debug)]
pub struct Sheet {
    /// Stable id.
    pub id: SheetId,
    /// Name.
    pub name: String,
    /// Tab colour.
    pub color: Option<String>,
    /// Hidden flag.
    pub hidden: bool,
    /// Frozen rows.
    pub frozen_rows: u32,
    /// Frozen columns.
    pub frozen_cols: u32,
    /// col → row → cell.
    pub(crate) cols: BTreeMap<u32, BTreeMap<u32, Cell>>,
    /// spill child → anchor.
    pub(crate) spill_children: FxHashMap<(u32, u32), (u32, u32)>,
    /// anchor → spill rectangle (including the anchor).
    pub(crate) spills: FxHashMap<(u32, u32), Rect>,
    /// anchors whose spill is blocked → wanted rectangle.
    pub(crate) blocked: FxHashMap<(u32, u32), Rect>,
    /// Custom row heights.
    pub row_heights: BTreeMap<u32, f64>,
    /// Custom column widths.
    pub col_widths: BTreeMap<u32, f64>,
    /// Merged ranges.
    pub merges: Vec<Rect>,
    /// Conditional formats.
    pub cond_formats: Vec<CondFormatRule>,
    /// Charts (opaque to the engine; stored for the UI and xlsx export).
    pub charts: Vec<serde_json::Value>,
}

impl Sheet {
    /// A new empty sheet.
    pub fn new(id: SheetId, name: impl Into<String>) -> Sheet {
        Sheet {
            id,
            name: name.into(),
            color: None,
            hidden: false,
            frozen_rows: 0,
            frozen_cols: 0,
            cols: BTreeMap::new(),
            spill_children: FxHashMap::default(),
            spills: FxHashMap::default(),
            blocked: FxHashMap::default(),
            row_heights: BTreeMap::new(),
            col_widths: BTreeMap::new(),
            merges: Vec::new(),
            cond_formats: Vec::new(),
            charts: Vec::new(),
        }
    }

    /// Stored cell.
    pub fn cell(&self, r: u32, c: u32) -> Option<&Cell> {
        self.cols.get(&c).and_then(|m| m.get(&r))
    }
    /// Stored cell, mutable.
    pub fn cell_mut(&mut self, r: u32, c: u32) -> Option<&mut Cell> {
        self.cols.get_mut(&c).and_then(|m| m.get_mut(&r))
    }
    /// Insert or replace a cell.
    pub fn put(&mut self, r: u32, c: u32, cell: Cell) {
        self.cols.entry(c).or_default().insert(r, cell);
    }
    /// Remove a cell.
    pub fn take(&mut self, r: u32, c: u32) -> Option<Cell> {
        let col = self.cols.get_mut(&c)?;
        let out = col.remove(&r);
        if col.is_empty() {
            self.cols.remove(&c);
        }
        out
    }

    /// Displayed value at a position (resolving spill children).
    pub fn value_at(&self, r: u32, c: u32) -> Value {
        if let Some(cell) = self.cell(r, c)
            && cell.has_content()
        {
            return cell.shown().clone();
        }
        if let Some(&(ar, ac)) = self.spill_children.get(&(r, c))
            && let Some(anchor) = self.cell(ar, ac)
            && let Value::Array(a) = &anchor.value
        {
            return a.get((r - ar) as usize, (c - ac) as usize).clone();
        }
        Value::Empty
    }

    /// Visit stored cells inside a rectangle (column-major).
    pub fn for_each_cell(&self, rect: &Rect, mut f: impl FnMut(u32, u32, &Cell)) {
        for (&c, col) in self.cols.range(rect.c0..=rect.c1) {
            for (&r, cell) in col.range(rect.r0..=rect.r1) {
                f(r, c, cell);
            }
        }
    }

    /// Non-empty values inside a rectangle, including spill children, in row-major order.
    pub fn values_in(&self, rect: &Rect) -> Vec<(u32, u32, Value)> {
        let mut out = Vec::new();
        self.for_each_cell(rect, |r, c, cell| {
            if cell.has_content() {
                let v = cell.shown();
                if !v.is_empty() {
                    out.push((r, c, v.clone()));
                }
            }
        });
        for (&(ar, ac), sr) in self.spills.iter() {
            let Some(ix) = sr.intersection(rect) else {
                continue;
            };
            let Some(anchor) = self.cell(ar, ac) else {
                continue;
            };
            let Value::Array(a) = &anchor.value else {
                continue;
            };
            for r in ix.r0..=ix.r1 {
                for c in ix.c0..=ix.c1 {
                    if r == ar && c == ac {
                        continue;
                    }
                    let v = a.get((r - ar) as usize, (c - ac) as usize);
                    if !v.is_empty() {
                        out.push((r, c, v.clone()));
                    }
                }
            }
        }
        out.sort_by_key(|(r, c, _)| (*r, *c));
        out
    }

    /// Visit non-empty values inside a rectangle in row-major order without allocating when possible
    /// (single-column rectangles that no spill intersects).
    pub fn visit_values(&self, rect: &Rect, f: &mut dyn FnMut(u32, u32, &Value)) {
        let spills = self.spills.values().any(|sr| sr.intersects(rect));
        if rect.c0 == rect.c1 && !spills {
            if let Some(col) = self.cols.get(&rect.c0) {
                for (&r, cell) in col.range(rect.r0..=rect.r1) {
                    if cell.has_content() {
                        let v = cell.shown();
                        if !v.is_empty() {
                            f(r, rect.c0, v);
                        }
                    }
                }
            }
            return;
        }
        for (r, c, v) in self.values_in(rect) {
            f(r, c, &v);
        }
    }

    /// `(rows, cols)` covering every used cell (max index + 1), including spills.
    pub fn extent(&self) -> (u32, u32) {
        let mut rows = 0;
        let mut cols = 0;
        for (&c, col) in self.cols.iter() {
            if let Some((&r, _)) = col.iter().next_back() {
                rows = rows.max(r + 1);
                cols = cols.max(c + 1);
            }
        }
        for sr in self.spills.values() {
            rows = rows.max(sr.r1 + 1);
            cols = cols.max(sr.c1 + 1);
        }
        (rows, cols)
    }

    /// Number of stored cells.
    pub fn cell_count(&self) -> usize {
        self.cols.values().map(|c| c.len()).sum()
    }

    /// Every stored cell position.
    pub fn positions(&self) -> Vec<(u32, u32)> {
        let mut v = Vec::with_capacity(self.cell_count());
        for (&c, col) in &self.cols {
            for &r in col.keys() {
                v.push((r, c));
            }
        }
        v
    }

    /// Remove a spill registration (anchor → rect).
    pub(crate) fn clear_spill(&mut self, anchor: (u32, u32)) -> Option<Rect> {
        let rect = self.spills.remove(&anchor)?;
        for r in rect.r0..=rect.r1 {
            for c in rect.c0..=rect.c1 {
                if self.spill_children.get(&(r, c)) == Some(&anchor) {
                    self.spill_children.remove(&(r, c));
                }
            }
        }
        Some(rect)
    }

    /// Register a spill.
    pub(crate) fn set_spill(&mut self, anchor: (u32, u32), rect: Rect) {
        for r in rect.r0..=rect.r1 {
            for c in rect.c0..=rect.c1 {
                if (r, c) != anchor {
                    self.spill_children.insert((r, c), anchor);
                }
            }
        }
        self.spills.insert(anchor, rect);
    }
}
