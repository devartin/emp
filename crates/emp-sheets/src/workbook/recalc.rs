//! Incremental recalculation (SPEC §14.2): dirty marking by BFS, iterative Tarjan ordering with cycle
//! detection (`#CIRC!` or iterative calculation), change-propagation cut-off, spill registration and the
//! operation budget.

use super::sheet::CellInput;
use super::{WbGrid, Workbook, finalize};
use crate::address::{CellKey, Rect, SheetId};
use crate::eval::{Budget, EvalCtx};
use crate::host::ExternalKey;
use crate::limits::{
    ITERATIVE_MAX_CHANGE, ITERATIVE_MAX_ITERATIONS, MAX_COLS, MAX_ROWS, MAX_SPILL_CELLS,
};
use crate::value::{ErrorKind, Value};
use rustc_hash::{FxHashMap, FxHashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// What a recalculation changed.
#[derive(Clone, Debug, Default)]
pub struct RecalcReport {
    /// Cells whose value changed (including spill children areas, reported via `dirty_rects`).
    pub changed: Vec<CellKey>,
    /// Rectangles whose spilled values changed.
    pub dirty_rects: Vec<(SheetId, Rect)>,
    /// The operation budget ran out (or the job was cancelled); remaining cells stay dirty.
    pub paused: bool,
    /// External keys requested but not cached (the app should fetch them).
    pub fetch: Vec<ExternalKey>,
    /// Members of circular references found.
    pub circular: Vec<CellKey>,
    /// Number of formula evaluations.
    pub evaluated: usize,
}

/// Seeds of a recalculation.
#[derive(Clone, Debug, Default)]
pub(crate) struct Seeds {
    /// Cell positions whose content changed.
    pub positions: Vec<CellKey>,
    /// Rectangles whose content changed.
    pub rects: Vec<(SheetId, Rect)>,
    /// Formula cells that must be evaluated.
    pub formulas: Vec<CellKey>,
    /// Include every volatile cell.
    pub volatile: bool,
    /// Evaluate every formula.
    pub all: bool,
}

struct Outcome {
    value: Value,
    externals: Vec<ExternalKey>,
    stale: bool,
}

/// Iterative Tarjan SCC. Returns components in topological order (precedents first).
pub(crate) fn tarjan(
    nodes: &[CellKey],
    adj: &FxHashMap<CellKey, Vec<CellKey>>,
) -> Vec<Vec<CellKey>> {
    let mut index: FxHashMap<CellKey, usize> = FxHashMap::default();
    let mut low: FxHashMap<CellKey, usize> = FxHashMap::default();
    let mut on_stack: FxHashSet<CellKey> = FxHashSet::default();
    let mut stack: Vec<CellKey> = Vec::new();
    let mut out: Vec<Vec<CellKey>> = Vec::new();
    let mut counter = 0usize;
    let empty: Vec<CellKey> = Vec::new();
    for &start in nodes {
        if index.contains_key(&start) {
            continue;
        }
        let mut call: Vec<(CellKey, usize)> = vec![(start, 0)];
        index.insert(start, counter);
        low.insert(start, counter);
        counter += 1;
        stack.push(start);
        on_stack.insert(start);
        while let Some(&mut (v, ref mut i)) = call.last_mut() {
            let succ = adj.get(&v).unwrap_or(&empty);
            if *i < succ.len() {
                let w = succ[*i];
                *i += 1;
                if !adj.contains_key(&w) {
                    continue;
                }
                if let std::collections::hash_map::Entry::Vacant(e) = index.entry(w) {
                    e.insert(counter);
                    low.insert(w, counter);
                    counter += 1;
                    stack.push(w);
                    on_stack.insert(w);
                    call.push((w, 0));
                } else if on_stack.contains(&w) {
                    let iw = index[&w];
                    let lv = low.get_mut(&v).map(|x| {
                        *x = (*x).min(iw);
                        *x
                    });
                    let _ = lv;
                }
            } else {
                call.pop();
                let lv = low[&v];
                if let Some(&(parent, _)) = call.last()
                    && let Some(lp) = low.get_mut(&parent)
                {
                    *lp = (*lp).min(lv);
                }
                if lv == index[&v] {
                    let mut comp = Vec::new();
                    while let Some(w) = stack.pop() {
                        on_stack.remove(&w);
                        comp.push(w);
                        if w == v {
                            break;
                        }
                    }
                    out.push(comp);
                }
            }
        }
    }
    out.reverse();
    out
}

impl Workbook {
    fn is_formula_key(&self, k: CellKey) -> bool {
        self.sheet(k.sheet())
            .and_then(|s| s.cell(k.row(), k.col()))
            .is_some_and(|c| c.input.is_formula())
    }

    fn successors(&self, k: CellKey) -> Vec<CellKey> {
        let mut out = Vec::new();
        self.deps.dependents_of(k, &mut out);
        if let Some(s) = self.sheet(k.sheet())
            && let Some(rect) = s.spills.get(&(k.row(), k.col()))
        {
            self.deps.dependents_of_rect(k.sheet(), rect, &mut out);
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Anchors whose spill depends on the cells of a rectangle (they spill into it, or are blocked by it).
    fn anchors_touching(&self, sheet: SheetId, rect: &Rect, out: &mut Vec<CellKey>) {
        if let Some(s) = self.sheet(sheet) {
            for (&(ar, ac), br) in s.blocked.iter() {
                if br.intersects(rect) {
                    out.push(CellKey::new(sheet, ar, ac));
                }
            }
            for (&(ar, ac), sr) in s.spills.iter() {
                if sr.intersects(rect)
                    && !(rect.r0 == ar && rect.c0 == ac && rect.r1 == ar && rect.c1 == ac)
                {
                    out.push(CellKey::new(sheet, ar, ac));
                }
            }
        }
    }

    fn eval_one(
        &self,
        key: CellKey,
        budget: &mut Budget,
        pending: Option<&FxHashSet<CellKey>>,
    ) -> Outcome {
        let Some(sheet) = self.sheet(key.sheet()) else {
            return Outcome {
                value: Value::Error(ErrorKind::Ref),
                externals: vec![],
                stale: false,
            };
        };
        let Some(cell) = sheet.cell(key.row(), key.col()) else {
            return Outcome {
                value: Value::Empty,
                externals: vec![],
                stale: false,
            };
        };
        let CellInput::Formula(f) = &cell.input else {
            return Outcome {
                value: cell.value.clone(),
                externals: vec![],
                stale: false,
            };
        };
        let f = f.clone();
        // Static references are already ordered topologically; only dynamic ones (INDIRECT, OFFSET, …)
        // need stale-read detection.
        let grid = WbGrid::new(self, if f.volatile { pending } else { None });
        let host = self.host.clone();
        let r = catch_unwind(AssertUnwindSafe(|| {
            let mut ctx = EvalCtx::new(&grid, &*host, budget, key.sheet(), key.row(), key.col());
            let ev = ctx.eval(&f.expr);
            let v = finalize(&mut ctx, ev);
            (v, std::mem::take(&mut ctx.externals))
        }));
        let (value, externals) = r.unwrap_or((Value::Error(ErrorKind::Calc), Vec::new()));
        Outcome {
            value,
            externals,
            stale: grid.stale.get(),
        }
    }

    /// Store a formula result, handling spills. Returns `(value changed, changed spill rects)`.
    fn store_result(&mut self, key: CellKey, value: Value) -> (bool, Vec<Rect>) {
        let (r, c) = (key.row(), key.col());
        let Some(sheet) = self.sheet_mut(key.sheet()) else {
            return (false, vec![]);
        };
        let old_spill = sheet.spills.get(&(r, c)).copied();
        let was_blocked = sheet.blocked.remove(&(r, c));
        let mut value = value;
        let mut new_spill: Option<Rect> = None;
        if let Value::Array(arr) = &value {
            let (rows, cols) = (arr.rows() as u64, arr.cols() as u64);
            let r1 = r as u64 + rows - 1;
            let c1 = c as u64 + cols - 1;
            let fits = r1 < MAX_ROWS as u64
                && c1 < MAX_COLS as u64
                && rows * cols <= MAX_SPILL_CELLS as u64;
            let rect = Rect {
                r0: r,
                c0: c,
                r1: r1.min(MAX_ROWS as u64 - 1) as u32,
                c1: c1.min(MAX_COLS as u64 - 1) as u32,
            };
            let mut blocked = !fits;
            if !blocked {
                // Content in the target area (other than the anchor) blocks the spill.
                sheet.for_each_cell(&rect, |rr, cc, cell| {
                    if (rr, cc) != (r, c) && cell.has_content() {
                        blocked = true;
                    }
                });
                if !blocked {
                    for (&(ar, ac), other) in sheet.spills.iter() {
                        if (ar, ac) != (r, c) && other.intersects(&rect) {
                            blocked = true;
                            break;
                        }
                    }
                }
            }
            if blocked {
                sheet.blocked.insert((r, c), rect);
                value = Value::Error(ErrorKind::Spill);
            } else {
                new_spill = Some(rect);
            }
        }
        let mut changed_rects = Vec::new();
        if old_spill != new_spill {
            if old_spill.is_some() {
                sheet.clear_spill((r, c));
            }
            if let Some(rect) = new_spill {
                sheet.set_spill((r, c), rect);
            }
            changed_rects.extend(old_spill);
            changed_rects.extend(new_spill);
        }
        let _ = was_blocked;
        let Some(cell) = sheet.cell_mut(r, c) else {
            return (false, changed_rects);
        };
        let changed = cell.value != value;
        if changed {
            if let Some(rect) = new_spill
                && !changed_rects.contains(&rect)
            {
                changed_rects.push(rect);
            }
            cell.value = value;
        }
        (changed || !changed_rects.is_empty(), changed_rects)
    }

    /// Run a recalculation from seeds.
    pub(crate) fn recalc_seeds(
        &mut self,
        seeds: Seeds,
        cancel: Option<Arc<AtomicBool>>,
    ) -> RecalcReport {
        let mut report = RecalcReport::default();
        let mut budget = Budget::new(self.ops_budget, cancel);
        let mut must: FxHashSet<CellKey> = FxHashSet::default();
        must.extend(seeds.formulas.iter().copied());
        must.extend(self.pending_dirty.drain());
        if seeds.volatile {
            must.extend(self.deps.volatile.iter().copied());
        }
        if seeds.all {
            for s in &self.sheets {
                for (r, c) in s.positions() {
                    if s.cell(r, c).is_some_and(|x| x.input.is_formula()) {
                        must.insert(CellKey::new(s.id, r, c));
                    }
                }
            }
        }
        let mut tmp = Vec::new();
        if seeds.positions.len() > 256 {
            // Many edits (paste, import, fill): query the bounding rectangle per sheet once. This is a
            // superset of the exact dependents; the change cut-off keeps it cheap.
            let mut boxes: FxHashMap<SheetId, Rect> = FxHashMap::default();
            for p in &seeds.positions {
                let r = Rect::cell(p.row(), p.col());
                boxes
                    .entry(p.sheet())
                    .and_modify(|b| *b = b.union(&r))
                    .or_insert(r);
            }
            for (s, rect) in boxes {
                self.deps.dependents_of_rect(s, &rect, &mut tmp);
                self.anchors_touching(s, &rect, &mut tmp);
            }
        } else {
            for &p in &seeds.positions {
                self.deps.dependents_of(p, &mut tmp);
                self.anchors_touching(p.sheet(), &Rect::cell(p.row(), p.col()), &mut tmp);
            }
        }
        for (s, rect) in &seeds.rects {
            self.deps.dependents_of_rect(*s, rect, &mut tmp);
            self.anchors_touching(*s, rect, &mut tmp);
        }
        must.extend(tmp);
        let mut changed: FxHashSet<CellKey> = FxHashSet::default();
        let mut fetch: FxHashSet<ExternalKey> = FxHashSet::default();
        let mut circular: FxHashSet<CellKey> = FxHashSet::default();
        let mut dirty_rects: Vec<(SheetId, Rect)> = Vec::new();

        for _pass in 0..8 {
            if must.is_empty() {
                break;
            }
            budget.memo_clear();
            // 1. dirty set by BFS
            let mut adj: FxHashMap<CellKey, Vec<CellKey>> = FxHashMap::default();
            let mut queue: Vec<CellKey> = must.iter().copied().collect();
            queue.sort_unstable();
            let mut nodes: Vec<CellKey> = Vec::new();
            while let Some(x) = queue.pop() {
                if adj.contains_key(&x) || !self.is_formula_key(x) {
                    continue;
                }
                let succ = self.successors(x);
                for &y in &succ {
                    if !adj.contains_key(&y) {
                        queue.push(y);
                    }
                }
                adj.insert(x, succ);
                nodes.push(x);
            }
            // 2. order
            let order = tarjan(&nodes, &adj);
            let mut needs = must.clone();
            let mut pending: FxHashSet<CellKey> = nodes.iter().copied().collect();
            let mut late: FxHashSet<CellKey> = FxHashSet::default();
            let mut aborted = false;
            for comp in order {
                let is_cycle =
                    comp.len() > 1 || adj.get(&comp[0]).is_some_and(|s| s.contains(&comp[0]));
                if !is_cycle {
                    let x = comp[0];
                    if !needs.contains(&x) {
                        pending.remove(&x);
                        continue;
                    }
                    let out = self.eval_one(x, &mut budget, Some(&pending));
                    report.evaluated += 1;
                    if budget.exhausted {
                        aborted = true;
                        self.pending_dirty.extend(pending.iter().copied());
                        if let Some(sheet) = self.sheet_mut(x.sheet())
                            && let Some(cell) = sheet.cell_mut(x.row(), x.col())
                        {
                            cell.value = Value::Error(ErrorKind::Calc);
                        }
                        changed.insert(x);
                        break;
                    }
                    pending.remove(&x);
                    self.note_externals(x, &out.externals, &mut fetch);
                    if out.stale {
                        late.insert(x);
                    }
                    let (ch, rects) = self.store_result(x, out.value);
                    if ch {
                        budget.memo_invalidate(x.sheet(), x.row(), x.col(), x.row(), x.col());
                        for r in &rects {
                            budget.memo_invalidate(x.sheet(), r.r0, r.c0, r.r1, r.c1);
                        }
                        changed.insert(x);
                        if let Some(s) = adj.get(&x) {
                            needs.extend(s.iter().copied());
                        }
                    }
                    for rect in rects {
                        dirty_rects.push((x.sheet(), rect));
                        let mut extra = Vec::new();
                        self.deps.dependents_of_rect(x.sheet(), &rect, &mut extra);
                        self.anchors_touching(x.sheet(), &rect, &mut extra);
                        for y in extra {
                            if y == x {
                                continue;
                            }
                            if pending.contains(&y) {
                                needs.insert(y);
                            } else {
                                late.insert(y);
                            }
                        }
                    }
                } else {
                    let members: FxHashSet<CellKey> = comp.iter().copied().collect();
                    if self.calc.iterative {
                        let mut iter_changed = false;
                        for _ in 0..ITERATIVE_MAX_ITERATIONS {
                            budget.memo_clear();
                            let mut max_delta: f64 = 0.0;
                            for &x in comp.iter().rev() {
                                let before = self.value(x.sheet(), x.row(), x.col());
                                let out = self.eval_one(x, &mut budget, None);
                                report.evaluated += 1;
                                self.note_externals(x, &out.externals, &mut fetch);
                                let delta = match (&before, &out.value) {
                                    (Value::Number(a), Value::Number(b)) => (a - b).abs(),
                                    (a, b) if a == b => 0.0,
                                    _ => f64::INFINITY,
                                };
                                max_delta = max_delta.max(delta);
                                let (ch, _) = self.store_result(x, out.value);
                                budget.memo_invalidate(
                                    x.sheet(),
                                    x.row(),
                                    x.col(),
                                    x.row(),
                                    x.col(),
                                );
                                iter_changed |= ch;
                                if ch {
                                    changed.insert(x);
                                }
                            }
                            if max_delta < ITERATIVE_MAX_CHANGE || budget.exhausted {
                                break;
                            }
                        }
                        if iter_changed {
                            for &x in &comp {
                                if let Some(s) = adj.get(&x) {
                                    needs
                                        .extend(s.iter().filter(|y| !members.contains(y)).copied());
                                }
                            }
                        }
                    } else {
                        for &x in &comp {
                            circular.insert(x);
                            let (ch, rects) = self.store_result(x, Value::Error(ErrorKind::Circ));
                            budget.memo_invalidate(x.sheet(), x.row(), x.col(), x.row(), x.col());
                            if ch {
                                changed.insert(x);
                            }
                            for rect in rects {
                                dirty_rects.push((x.sheet(), rect));
                            }
                            if let Some(s) = adj.get(&x) {
                                needs.extend(s.iter().filter(|y| !members.contains(y)).copied());
                            }
                        }
                    }
                    for x in &comp {
                        pending.remove(x);
                    }
                    if budget.exhausted {
                        aborted = true;
                        self.pending_dirty.extend(pending.iter().copied());
                        break;
                    }
                }
            }
            if aborted {
                report.paused = true;
                break;
            }
            must = late;
        }
        if !must.is_empty() && !report.paused {
            // Could not settle in 8 passes (dynamic references oscillating); leave values as they are.
        }
        let mut changed: Vec<CellKey> = changed.into_iter().collect();
        changed.sort_unstable();
        report.changed = changed;
        report.dirty_rects = dirty_rects;
        let mut fetch: Vec<ExternalKey> = fetch.into_iter().collect();
        fetch.sort();
        report.fetch = fetch;
        let mut circ: Vec<CellKey> = circular.into_iter().collect();
        circ.sort_unstable();
        report.circular = circ;
        report
    }

    fn note_externals(
        &mut self,
        x: CellKey,
        keys: &[ExternalKey],
        fetch: &mut FxHashSet<ExternalKey>,
    ) {
        for k in keys {
            if matches!(self.host.external(k), crate::host::ExternalValue::Pending) {
                fetch.insert(k.clone());
            }
        }
        self.deps.set_externals(x, keys.to_vec());
    }

    /// Recalculate everything (all formulas).
    pub fn recalc_all(&mut self) -> RecalcReport {
        self.guarded_recalc(
            Seeds {
                all: true,
                volatile: true,
                ..Default::default()
            },
            None,
        )
    }

    /// Recalculate volatile cells and anything left dirty by a paused recalculation (e.g. on open or on a
    /// timer tick).
    pub fn recalc_volatile(&mut self) -> RecalcReport {
        self.guarded_recalc(
            Seeds {
                volatile: true,
                ..Default::default()
            },
            None,
        )
    }

    /// Continue a paused recalculation, optionally with a cancellation flag.
    pub fn resume_recalc(&mut self, cancel: Option<Arc<AtomicBool>>) -> RecalcReport {
        self.guarded_recalc(Seeds::default(), cancel)
    }

    /// External data arrived (or changed) for these keys: recompute the formulas that read them.
    pub fn external_data_changed(&mut self, keys: &[ExternalKey]) -> RecalcReport {
        let mut formulas = Vec::new();
        for k in keys {
            formulas.extend(self.deps.external_dependents(k));
        }
        self.guarded_recalc(
            Seeds {
                formulas,
                ..Default::default()
            },
            None,
        )
    }

    /// External keys used by any formula in the workbook.
    pub fn external_keys(&self) -> Vec<ExternalKey> {
        let mut v = self.deps.external_keys();
        v.sort();
        v
    }

    /// Cells still dirty after a paused recalculation.
    pub fn is_calc_paused(&self) -> bool {
        !self.pending_dirty.is_empty()
    }

    pub(crate) fn guarded_recalc(
        &mut self,
        seeds: Seeds,
        cancel: Option<Arc<AtomicBool>>,
    ) -> RecalcReport {
        let r = catch_unwind(AssertUnwindSafe(|| self.recalc_seeds(seeds, cancel)));
        match r {
            Ok(rep) => rep,
            Err(_) => RecalcReport {
                paused: true,
                ..Default::default()
            },
        }
    }

    /// Rebuild the dependency graph from scratch (after load or structural edits).
    pub(crate) fn rebuild_deps(&mut self) {
        let mut g = super::deps::DepGraph::new();
        for s in &self.sheets {
            for (&c, col) in &s.cols {
                for (&r, cell) in col {
                    if let CellInput::Formula(f) = &cell.input {
                        let key = CellKey::new(s.id, r, c);
                        let p = self.precedents(&f.expr, s.id);
                        g.set(key, &p, f.volatile);
                    }
                }
            }
        }
        // keep external registrations by re-evaluating lazily: they are refreshed on the next evaluation
        self.deps = g;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tarjan_orders_and_finds_cycles() {
        let a = CellKey::new(0, 0, 0);
        let b = CellKey::new(0, 1, 0);
        let c = CellKey::new(0, 2, 0);
        let d = CellKey::new(0, 3, 0);
        let mut adj = FxHashMap::default();
        adj.insert(a, vec![b]);
        adj.insert(b, vec![c]);
        adj.insert(c, vec![b, d]);
        adj.insert(d, vec![]);
        let comps = tarjan(&[d, c, b, a], &adj);
        assert_eq!(comps[0], vec![a]);
        assert_eq!(comps[1].len(), 2);
        assert_eq!(comps[2], vec![d]);
    }
}
