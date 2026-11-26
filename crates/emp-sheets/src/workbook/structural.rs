//! Structural edits (insert/delete rows and columns): cells move, and every reference across the workbook
//! (formulas, defined names, merges, conditional formats) is rewritten. References to deleted cells become
//! `#REF!` (SPEC §14.2).

use super::ops::{Axis, CellData, Effects, Op};
use super::sheet::{Cell, CellInput, CondFormatRule};
use super::{DefinedName, SheetError, Workbook};
use crate::address::{CellKey, Rect, SheetId};
use crate::ast::{CellRef, Expr, RefTarget, Reference, SheetRef};
use crate::limits::{MAX_COLS, MAX_ROWS};
use std::collections::BTreeMap;
use std::sync::Arc;

/// An insert or delete of rows/columns, with the state to restore afterwards (used by undo).
#[derive(Clone, Debug)]
pub struct StructOp {
    sheet: SheetId,
    axis: Axis,
    at: u32,
    count: u32,
    insert: bool,
    restore_cells: Vec<(u32, u32, CellData)>,
    restore_formulas: Vec<(CellKey, CellInput)>,
    names: Option<BTreeMap<String, DefinedName>>,
    merges: Option<Vec<Rect>>,
    sizes: Option<BTreeMap<u32, f64>>,
    cond_formats: Option<Vec<CondFormatRule>>,
}

impl StructOp {
    /// A plain insert (`insert = true`) or delete.
    pub fn new(
        sheet: SheetId,
        axis: Axis,
        at: u32,
        count: u32,
        insert: bool,
    ) -> Result<StructOp, SheetError> {
        let max = if axis == Axis::Rows {
            MAX_ROWS
        } else {
            MAX_COLS
        };
        if count == 0 || at >= max || at as u64 + count as u64 > max as u64 {
            return Err(SheetError::Invalid("span is outside the grid".into()));
        }
        Ok(StructOp {
            sheet,
            axis,
            at,
            count,
            insert,
            restore_cells: Vec::new(),
            restore_formulas: Vec::new(),
            names: None,
            merges: None,
            sizes: None,
            cond_formats: None,
        })
    }
}

/// Shift an inclusive span `[v0, v1]` for an insert/delete of `n` at `at`. `None` = deleted.
fn shift_span(v0: u32, v1: u32, at: u32, n: u32, insert: bool, max: u32) -> Option<(u32, u32)> {
    if insert {
        let a = if v0 >= at {
            v0 as u64 + n as u64
        } else {
            v0 as u64
        };
        let b = if v1 >= at {
            v1 as u64 + n as u64
        } else {
            v1 as u64
        };
        if a >= max as u64 {
            return None;
        }
        Some((a as u32, b.min(max as u64 - 1) as u32))
    } else {
        let end = at + n; // exclusive
        if v0 >= at && v1 < end {
            return None;
        }
        let a = if v0 < at {
            v0
        } else if v0 >= end {
            v0 - n
        } else {
            at
        };
        let b = if v1 < at {
            v1
        } else if v1 >= end {
            v1 - n
        } else {
            at.saturating_sub(1)
        };
        if b < a {
            return None;
        }
        Some((a, b))
    }
}

fn shift_one(v: u32, at: u32, n: u32, insert: bool, max: u32) -> Option<u32> {
    shift_span(v, v, at, n, insert, max).map(|x| x.0)
}

impl StructOp {
    fn max(&self) -> u32 {
        if self.axis == Axis::Rows {
            MAX_ROWS
        } else {
            MAX_COLS
        }
    }

    fn rewrite_ref(&self, r: &mut Reference, formula_sheet: SheetId) -> bool {
        let target = match &r.sheet {
            None => formula_sheet,
            Some(SheetRef::Id(id)) => *id,
            Some(SheetRef::Named(_)) => return false,
        };
        if target != self.sheet {
            return false;
        }
        let rows = self.axis == Axis::Rows;
        let (at, n, ins, max) = (self.at, self.count, self.insert, self.max());
        let before = r.target.clone();
        let new = match &r.target {
            RefTarget::Cell(c) => {
                let mut c2 = *c;
                let ok = if rows {
                    shift_one(c.row, at, n, ins, max).map(|v| c2.row = v)
                } else {
                    shift_one(c.col, at, n, ins, max).map(|v| c2.col = v)
                };
                ok.map(|_| RefTarget::Cell(c2))
            }
            RefTarget::Area(a, b) => {
                let (lo, hi) = if rows {
                    (a.row.min(b.row), a.row.max(b.row))
                } else {
                    (a.col.min(b.col), a.col.max(b.col))
                };
                shift_span(lo, hi, at, n, ins, max).map(|(x, y)| {
                    let (mut a2, mut b2): (CellRef, CellRef) = (*a, *b);
                    if rows {
                        if a.row <= b.row {
                            a2.row = x;
                            b2.row = y;
                        } else {
                            a2.row = y;
                            b2.row = x;
                        }
                    } else if a.col <= b.col {
                        a2.col = x;
                        b2.col = y;
                    } else {
                        a2.col = y;
                        b2.col = x;
                    }
                    RefTarget::Area(a2, b2)
                })
            }
            RefTarget::Rows { r0, r1, abs0, abs1 } => {
                if rows {
                    shift_span(*r0.min(r1), *r0.max(r1), at, n, ins, max).map(|(x, y)| {
                        RefTarget::Rows {
                            r0: x,
                            r1: y,
                            abs0: *abs0,
                            abs1: *abs1,
                        }
                    })
                } else {
                    Some(r.target.clone())
                }
            }
            RefTarget::Cols { c0, c1, abs0, abs1 } => {
                if !rows {
                    shift_span(*c0.min(c1), *c0.max(c1), at, n, ins, max).map(|(x, y)| {
                        RefTarget::Cols {
                            c0: x,
                            c1: y,
                            abs0: *abs0,
                            abs1: *abs1,
                        }
                    })
                } else {
                    Some(r.target.clone())
                }
            }
            RefTarget::Invalid => Some(RefTarget::Invalid),
        };
        r.target = new.unwrap_or(RefTarget::Invalid);
        r.target != before
    }

    fn rewrite_expr(&self, e: &mut Expr, formula_sheet: SheetId) -> bool {
        let mut changed = false;
        e.for_each_ref_mut(&mut |r| {
            if self.rewrite_ref(r, formula_sheet) {
                changed = true;
            }
        });
        changed
    }

    fn rewrite_rect(&self, rect: &Rect) -> Option<Rect> {
        let (at, n, ins, max) = (self.at, self.count, self.insert, self.max());
        if self.axis == Axis::Rows {
            shift_span(rect.r0, rect.r1, at, n, ins, max).map(|(a, b)| Rect {
                r0: a,
                r1: b,
                c0: rect.c0,
                c1: rect.c1,
            })
        } else {
            shift_span(rect.c0, rect.c1, at, n, ins, max).map(|(a, b)| Rect {
                c0: a,
                c1: b,
                r0: rect.r0,
                r1: rect.r1,
            })
        }
    }

    fn in_span(&self, r: u32, c: u32) -> bool {
        let v = if self.axis == Axis::Rows { r } else { c };
        v >= self.at && v < self.at + self.count
    }

    fn moved(&self, r: u32, c: u32) -> Option<(u32, u32)> {
        let max = self.max();
        if self.axis == Axis::Rows {
            shift_one(r, self.at, self.count, self.insert, max).map(|v| (v, c))
        } else {
            shift_one(c, self.at, self.count, self.insert, max).map(|v| (r, v))
        }
    }
}

impl Workbook {
    pub(crate) fn apply_structural(
        &mut self,
        st: StructOp,
        fx: &mut Effects,
    ) -> Result<Op, SheetError> {
        let sid = st.sheet;
        if self.sheet(sid).is_none() {
            return Err(SheetError::NotFound(format!("sheet {sid}")));
        }
        let names_before = self.names.clone();
        let (merges_before, sizes_before, cf_before) = {
            let s = self
                .sheet(sid)
                .ok_or_else(|| SheetError::NotFound(format!("sheet {sid}")))?;
            let sizes = if st.axis == Axis::Rows {
                s.row_heights.clone()
            } else {
                s.col_widths.clone()
            };
            (s.merges.clone(), sizes, s.cond_formats.clone())
        };
        // 1. Rewrite formulas everywhere, remembering the originals (at their original positions).
        let mut changed_formulas: Vec<(CellKey, CellInput)> = Vec::new();
        for s in self.sheets.iter_mut() {
            let fs = s.id;
            for (&c, col) in s.cols.iter_mut() {
                for (&r, cell) in col.iter_mut() {
                    if let CellInput::Formula(f) = &cell.input {
                        let mut nf = (**f).clone();
                        if st.rewrite_expr(&mut nf.expr, fs) {
                            changed_formulas.push((CellKey::new(fs, r, c), cell.input.clone()));
                            cell.input = CellInput::Formula(Arc::new(nf));
                        }
                    }
                }
            }
        }
        // 2. Names.
        for n in self.names.values_mut() {
            let mut e = (*n.expr).clone();
            // Names are workbook-scoped; unqualified references are treated as being on the edited sheet.
            if st.rewrite_expr(&mut e, sid) {
                n.expr = Arc::new(e);
            }
        }
        // 3. Move cells on the target sheet.
        let mut removed: Vec<(u32, u32, CellData)> = Vec::new();
        {
            let s = self
                .sheet_mut(sid)
                .ok_or_else(|| SheetError::NotFound(format!("sheet {sid}")))?;
            let old = std::mem::take(&mut s.cols);
            for (c, col) in old {
                for (r, cell) in col {
                    if !st.insert && st.in_span(r, c) {
                        removed.push((r, c, CellData::from(cell)));
                        continue;
                    }
                    match st.moved(r, c) {
                        Some((nr, nc)) => s.put(nr, nc, cell),
                        None => removed.push((r, c, CellData::from(cell))),
                    }
                }
            }
            s.spills.clear();
            s.spill_children.clear();
            s.blocked.clear();
            s.merges = s
                .merges
                .iter()
                .filter_map(|m| st.rewrite_rect(m))
                .filter(|m| m.area() > 1)
                .collect();
            for cf in s.cond_formats.iter_mut() {
                if let Some(r) = st.rewrite_rect(&cf.rect) {
                    cf.rect = r;
                } else {
                    cf.rect = Rect {
                        r0: u32::MAX,
                        c0: u32::MAX,
                        r1: u32::MAX,
                        c1: u32::MAX,
                    };
                }
            }
            s.cond_formats.retain(|cf| cf.rect.r0 != u32::MAX);
            let sizes = if st.axis == Axis::Rows {
                &mut s.row_heights
            } else {
                &mut s.col_widths
            };
            let old_sizes = std::mem::take(sizes);
            for (i, v) in old_sizes {
                if !st.insert && i >= st.at && i < st.at + st.count {
                    continue;
                }
                if let Some(ni) = shift_one(i, st.at, st.count, st.insert, st.max()) {
                    sizes.insert(ni, v);
                }
            }
        }
        // 4. Restore state carried by the op (undo of the opposite operation).
        {
            let s = self
                .sheet_mut(sid)
                .ok_or_else(|| SheetError::NotFound(format!("sheet {sid}")))?;
            for (r, c, d) in &st.restore_cells {
                s.put(
                    *r,
                    *c,
                    Cell {
                        input: d.input.clone(),
                        value: d.value.clone(),
                        style: d.style,
                    },
                );
            }
            if let Some(m) = &st.merges {
                s.merges = m.clone();
            }
            if let Some(sz) = &st.sizes {
                if st.axis == Axis::Rows {
                    s.row_heights = sz.clone();
                } else {
                    s.col_widths = sz.clone();
                }
            }
            if let Some(cf) = &st.cond_formats {
                s.cond_formats = cf.clone();
            }
        }
        for (k, input) in &st.restore_formulas {
            if let Some(s) = self.sheet_mut(k.sheet())
                && let Some(cell) = s.cell_mut(k.row(), k.col())
            {
                cell.input = input.clone();
            }
        }
        if let Some(n) = &st.names {
            self.names = n.clone();
        }
        fx.rebuild = true;
        fx.seeds.all = true;
        for s in &self.sheets {
            if !fx.sheets.contains(&s.id) {
                fx.sheets.push(s.id);
            }
        }
        let inverse = StructOp {
            sheet: sid,
            axis: st.axis,
            at: st.at,
            count: st.count,
            insert: !st.insert,
            restore_cells: if st.insert { Vec::new() } else { removed },
            restore_formulas: changed_formulas,
            names: Some(names_before),
            merges: Some(merges_before),
            sizes: Some(sizes_before),
            cond_formats: Some(cf_before),
        };
        Ok(Op::Structural(Box::new(inverse)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans() {
        // insert 2 rows at 5
        assert_eq!(shift_span(0, 10, 5, 2, true, 100), Some((0, 12)));
        assert_eq!(shift_span(5, 10, 5, 2, true, 100), Some((7, 12)));
        assert_eq!(shift_span(0, 4, 5, 2, true, 100), Some((0, 4)));
        assert_eq!(shift_span(99, 99, 5, 2, true, 100), None);
        // delete rows 5..7
        assert_eq!(shift_span(0, 10, 5, 2, false, 100), Some((0, 8)));
        assert_eq!(shift_span(5, 6, 5, 2, false, 100), None);
        assert_eq!(shift_span(6, 10, 5, 2, false, 100), Some((5, 8)));
        assert_eq!(shift_span(0, 5, 5, 2, false, 100), Some((0, 4)));
        assert_eq!(shift_span(8, 9, 5, 2, false, 100), Some((6, 7)));
    }
}
