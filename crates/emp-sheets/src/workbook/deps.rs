//! Dependency index (SPEC §14.2): single-cell precedents, a bucketed range index (64 columns × 1,024
//! rows per bucket for ranges covering at most 64 buckets), whole-column/row lists, a big-range list,
//! name dependencies and external-data dependencies.

use crate::address::{CellKey, Rect, SheetId};
use crate::host::ExternalKey;
use crate::limits::{MAX_COLS, MAX_ROWS};
use rustc_hash::{FxHashMap, FxHashSet};
use smallvec::SmallVec;

const BUCKET_ROWS: u32 = 1024;
const BUCKET_COLS: u32 = 64;
const MAX_BUCKETS: u64 = 64;
const LINE_KEYS: u32 = 64;

/// A precedent range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RangeRef {
    /// Sheet.
    pub sheet: SheetId,
    /// Rectangle.
    pub rect: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Placement {
    Buckets,
    Cols,
    Rows,
    Big,
}

#[derive(Clone, Debug)]
struct RangeEntry {
    range: RangeRef,
    /// Formula cells using this exact range → number of uses (ranges are interned).
    dependents: FxHashMap<CellKey, u32>,
    placement: Placement,
}

/// Static precedents of one formula.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Precedents {
    /// Single cells.
    pub cells: Vec<CellKey>,
    /// Ranges.
    pub ranges: Vec<RangeRef>,
    /// Defined names (upper-case).
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct Registered {
    cells: Vec<CellKey>,
    range_ids: Vec<usize>,
    names: Vec<String>,
    externals: Vec<ExternalKey>,
}

/// The dependency graph.
#[derive(Clone, Debug, Default)]
pub struct DepGraph {
    registered: FxHashMap<CellKey, Registered>,
    single: FxHashMap<CellKey, SmallVec<[CellKey; 4]>>,
    ranges: Vec<Option<RangeEntry>>,
    range_index: FxHashMap<RangeRef, usize>,
    free: Vec<usize>,
    buckets: FxHashMap<(SheetId, u32, u32), Vec<usize>>,
    /// Whole-column ranges (≤ 64 columns wide), keyed by each column they cover.
    col_ranges: FxHashMap<(SheetId, u32), Vec<usize>>,
    /// Whole-row ranges (≤ 64 rows tall), keyed by each row they cover.
    row_ranges: FxHashMap<(SheetId, u32), Vec<usize>>,
    big_ranges: Vec<usize>,
    names: FxHashMap<String, FxHashSet<CellKey>>,
    external: FxHashMap<ExternalKey, FxHashSet<CellKey>>,
    /// Volatile formula cells.
    pub volatile: FxHashSet<CellKey>,
}

fn bucket_span(r: &Rect) -> (u32, u32, u32, u32) {
    (
        r.r0 / BUCKET_ROWS,
        r.c0 / BUCKET_COLS,
        r.r1 / BUCKET_ROWS,
        r.c1 / BUCKET_COLS,
    )
}

impl DepGraph {
    /// Empty graph.
    pub fn new() -> Self {
        Self::default()
    }

    /// Remove everything.
    pub fn clear(&mut self) {
        *self = DepGraph::default();
    }

    /// Number of formula cells registered.
    pub fn len(&self) -> usize {
        self.registered.len()
    }

    /// Is the graph empty?
    pub fn is_empty(&self) -> bool {
        self.registered.is_empty()
    }

    /// Register (replacing any previous registration) the precedents of a formula cell.
    pub fn set(&mut self, cell: CellKey, p: &Precedents, volatile: bool) {
        let externals = self
            .registered
            .get(&cell)
            .map(|r| r.externals.clone())
            .unwrap_or_default();
        self.remove(cell);
        let mut reg = Registered::default();
        for &k in &p.cells {
            let v = self.single.entry(k).or_default();
            if !v.contains(&cell) {
                v.push(cell);
            }
            reg.cells.push(k);
        }
        for r in &p.ranges {
            let id = self.add_range(*r, cell);
            reg.range_ids.push(id);
        }
        for n in &p.names {
            self.names.entry(n.clone()).or_default().insert(cell);
            reg.names.push(n.clone());
        }
        if volatile {
            self.volatile.insert(cell);
        }
        self.registered.insert(cell, reg);
        self.set_externals(cell, externals);
    }

    /// Forget a formula cell.
    pub fn remove(&mut self, cell: CellKey) {
        let Some(reg) = self.registered.remove(&cell) else {
            self.volatile.remove(&cell);
            return;
        };
        for k in reg.cells {
            if let Some(v) = self.single.get_mut(&k) {
                v.retain(|x| *x != cell);
                if v.is_empty() {
                    self.single.remove(&k);
                }
            }
        }
        for id in reg.range_ids {
            self.remove_range(id, cell);
        }
        for n in reg.names {
            if let Some(s) = self.names.get_mut(&n) {
                s.remove(&cell);
                if s.is_empty() {
                    self.names.remove(&n);
                }
            }
        }
        for e in reg.externals {
            if let Some(s) = self.external.get_mut(&e) {
                s.remove(&cell);
                if s.is_empty() {
                    self.external.remove(&e);
                }
            }
        }
        self.volatile.remove(&cell);
    }

    /// Replace the external keys a formula cell read during its last evaluation.
    pub fn set_externals(&mut self, cell: CellKey, keys: Vec<ExternalKey>) {
        let Some(reg) = self.registered.get_mut(&cell) else {
            return;
        };
        for e in reg.externals.drain(..) {
            if let Some(s) = self.external.get_mut(&e) {
                s.remove(&cell);
                if s.is_empty() {
                    self.external.remove(&e);
                }
            }
        }
        for k in &keys {
            self.external.entry(k.clone()).or_default().insert(cell);
        }
        reg.externals = keys;
    }

    /// Cells that read an external key.
    pub fn external_dependents(&self, key: &ExternalKey) -> Vec<CellKey> {
        self.external
            .get(key)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Every external key in use.
    pub fn external_keys(&self) -> Vec<ExternalKey> {
        self.external.keys().cloned().collect()
    }

    /// Cells that reference a defined name.
    pub fn name_dependents(&self, name: &str) -> Vec<CellKey> {
        self.names
            .get(&name.to_uppercase())
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// All registered formula cells.
    pub fn formula_cells(&self) -> Vec<CellKey> {
        self.registered.keys().copied().collect()
    }

    fn add_range(&mut self, range: RangeRef, dependent: CellKey) -> usize {
        if let Some(&id) = self.range_index.get(&range)
            && let Some(Some(e)) = self.ranges.get_mut(id)
        {
            *e.dependents.entry(dependent).or_insert(0) += 1;
            return id;
        }
        let r = range.rect;
        let placement = if r.r0 == 0 && r.r1 == MAX_ROWS - 1 && r.cols() <= LINE_KEYS {
            Placement::Cols
        } else if r.c0 == 0 && r.c1 == MAX_COLS - 1 && r.rows() <= LINE_KEYS {
            Placement::Rows
        } else if r.r0 == 0 && r.r1 == MAX_ROWS - 1 || r.c0 == 0 && r.c1 == MAX_COLS - 1 {
            Placement::Big
        } else {
            let (br0, bc0, br1, bc1) = bucket_span(&r);
            let n = (br1 - br0 + 1) as u64 * (bc1 - bc0 + 1) as u64;
            if n <= MAX_BUCKETS {
                Placement::Buckets
            } else {
                Placement::Big
            }
        };
        let mut dependents = FxHashMap::default();
        dependents.insert(dependent, 1);
        let entry = RangeEntry {
            range,
            dependents,
            placement,
        };
        let id = match self.free.pop() {
            Some(id) => {
                self.ranges[id] = Some(entry);
                id
            }
            None => {
                self.ranges.push(Some(entry));
                self.ranges.len() - 1
            }
        };
        self.range_index.insert(range, id);
        match placement {
            Placement::Cols => {
                for c in r.c0..=r.c1 {
                    self.col_ranges
                        .entry((range.sheet, c))
                        .or_default()
                        .push(id);
                }
            }
            Placement::Rows => {
                for rr in r.r0..=r.r1 {
                    self.row_ranges
                        .entry((range.sheet, rr))
                        .or_default()
                        .push(id);
                }
            }
            Placement::Big => self.big_ranges.push(id),
            Placement::Buckets => {
                let (br0, bc0, br1, bc1) = bucket_span(&r);
                for br in br0..=br1 {
                    for bc in bc0..=bc1 {
                        self.buckets
                            .entry((range.sheet, br, bc))
                            .or_default()
                            .push(id);
                    }
                }
            }
        }
        id
    }

    fn remove_range(&mut self, id: usize, cell: CellKey) {
        let Some(Some(e)) = self.ranges.get_mut(id) else {
            return;
        };
        if let Some(n) = e.dependents.get_mut(&cell) {
            *n -= 1;
            if *n == 0 {
                e.dependents.remove(&cell);
            }
        }
        if !e.dependents.is_empty() {
            return;
        }
        let Some(Some(entry)) = self.ranges.get(id).cloned() else {
            return;
        };
        self.range_index.remove(&entry.range);
        match entry.placement {
            Placement::Cols => {
                let r = entry.range.rect;
                for c in r.c0..=r.c1 {
                    let key = (entry.range.sheet, c);
                    if let Some(v) = self.col_ranges.get_mut(&key) {
                        v.retain(|x| *x != id);
                        if v.is_empty() {
                            self.col_ranges.remove(&key);
                        }
                    }
                }
            }
            Placement::Rows => {
                let r = entry.range.rect;
                for rr in r.r0..=r.r1 {
                    let key = (entry.range.sheet, rr);
                    if let Some(v) = self.row_ranges.get_mut(&key) {
                        v.retain(|x| *x != id);
                        if v.is_empty() {
                            self.row_ranges.remove(&key);
                        }
                    }
                }
            }
            Placement::Big => self.big_ranges.retain(|x| *x != id),
            Placement::Buckets => {
                let (br0, bc0, br1, bc1) = bucket_span(&entry.range.rect);
                for br in br0..=br1 {
                    for bc in bc0..=bc1 {
                        let key = (entry.range.sheet, br, bc);
                        if let Some(v) = self.buckets.get_mut(&key) {
                            v.retain(|x| *x != id);
                            if v.is_empty() {
                                self.buckets.remove(&key);
                            }
                        }
                    }
                }
            }
        }
        self.ranges[id] = None;
        self.free.push(id);
    }

    /// Formula cells that depend on one cell position.
    pub fn dependents_of(&self, k: CellKey, out: &mut Vec<CellKey>) {
        if let Some(v) = self.single.get(&k) {
            out.extend(v.iter().copied());
        }
        let (s, r, c) = (k.sheet(), k.row(), k.col());
        let check = |id: &usize, out: &mut Vec<CellKey>| {
            if let Some(Some(e)) = self.ranges.get(*id)
                && e.range.sheet == s
                && e.range.rect.contains(r, c)
            {
                out.extend(e.dependents.keys().copied());
            }
        };
        if let Some(v) = self.buckets.get(&(s, r / BUCKET_ROWS, c / BUCKET_COLS)) {
            for id in v {
                check(id, out);
            }
        }
        for id in self
            .col_ranges
            .get(&(s, c))
            .into_iter()
            .flatten()
            .chain(self.row_ranges.get(&(s, r)).into_iter().flatten())
            .chain(&self.big_ranges)
        {
            check(id, out);
        }
    }

    /// Formula cells that depend on any cell inside a rectangle.
    pub fn dependents_of_rect(&self, sheet: SheetId, rect: &Rect, out: &mut Vec<CellKey>) {
        if rect.area() <= 4096 {
            for r in rect.r0..=rect.r1 {
                for c in rect.c0..=rect.c1 {
                    if let Some(v) = self.single.get(&CellKey::new(sheet, r, c)) {
                        out.extend(v.iter().copied());
                    }
                }
            }
        } else {
            for (k, v) in &self.single {
                if k.sheet() == sheet && rect.contains(k.row(), k.col()) {
                    out.extend(v.iter().copied());
                }
            }
        }
        let mut seen = FxHashSet::default();
        let mut check = |id: usize, out: &mut Vec<CellKey>| {
            if !seen.insert(id) {
                return;
            }
            if let Some(Some(e)) = self.ranges.get(id)
                && e.range.sheet == sheet
                && e.range.rect.intersects(rect)
            {
                out.extend(e.dependents.keys().copied());
            }
        };
        let (br0, bc0, br1, bc1) = bucket_span(rect);
        let nb = (br1 - br0 + 1) as u64 * (bc1 - bc0 + 1) as u64;
        if nb <= 4096 {
            for br in br0..=br1 {
                for bc in bc0..=bc1 {
                    if let Some(v) = self.buckets.get(&(sheet, br, bc)) {
                        for id in v {
                            check(*id, out);
                        }
                    }
                }
            }
        } else {
            for v in self.buckets.values() {
                for id in v {
                    check(*id, out);
                }
            }
        }
        if rect.cols() <= 4096 {
            for c in rect.c0..=rect.c1 {
                for id in self.col_ranges.get(&(sheet, c)).into_iter().flatten() {
                    check(*id, out);
                }
            }
        } else {
            for id in self.col_ranges.values().flatten() {
                check(*id, out);
            }
        }
        if rect.rows() <= 4096 {
            for r in rect.r0..=rect.r1 {
                for id in self.row_ranges.get(&(sheet, r)).into_iter().flatten() {
                    check(*id, out);
                }
            }
        } else {
            for id in self.row_ranges.values().flatten() {
                check(*id, out);
            }
        }
        for id in &self.big_ranges {
            check(*id, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(r: u32, c: u32) -> CellKey {
        CellKey::new(0, r, c)
    }

    #[test]
    fn index_lookup() {
        let mut g = DepGraph::new();
        let f = k(10, 10);
        g.set(
            f,
            &Precedents {
                cells: vec![k(0, 0)],
                ranges: vec![
                    RangeRef {
                        sheet: 0,
                        rect: Rect::new(0, 1, 99, 1),
                    },
                    RangeRef {
                        sheet: 0,
                        rect: Rect::new(0, 5, MAX_ROWS - 1, 5),
                    },
                    RangeRef {
                        sheet: 0,
                        rect: Rect::new(0, 100, 900_000, 2000),
                    },
                ],
                names: vec!["RATE".into()],
            },
            false,
        );
        let mut out = Vec::new();
        g.dependents_of(k(0, 0), &mut out);
        assert_eq!(out, vec![f]);
        out.clear();
        g.dependents_of(k(50, 1), &mut out);
        assert_eq!(out, vec![f]);
        out.clear();
        g.dependents_of(k(1_000_000, 5), &mut out);
        assert_eq!(out, vec![f]);
        out.clear();
        g.dependents_of(k(800_000, 1500), &mut out);
        assert_eq!(out, vec![f]);
        out.clear();
        g.dependents_of(k(100, 1), &mut out);
        assert!(out.is_empty());
        g.dependents_of_rect(0, &Rect::new(90, 0, 200, 2), &mut out);
        assert_eq!(out, vec![f]);
        assert_eq!(g.name_dependents("rate"), vec![f]);
        g.remove(f);
        out.clear();
        g.dependents_of(k(50, 1), &mut out);
        assert!(out.is_empty());
        assert!(g.is_empty());
    }
}
