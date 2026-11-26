//! Excel-dialect evaluator: references, lazy ranges, operators with array broadcasting, function dispatch
//! with implicit lifting, the operation budget and call-depth limits (SPEC §9.17, §14.1).

use crate::address::{Rect, SheetId};
use crate::ast::{BinaryOp, Expr, PostfixOp, RefTarget, Reference, SheetRef, UnaryOp};
use crate::functions::{ArgKind, FnImpl, FnSpec, lookup_function};
use crate::host::{ExternalKey, Host};
use crate::limits::{MAX_CALL_DEPTH, MAX_COLS, MAX_LET_DEPTH, MAX_ROWS, MAX_SPILL_CELLS};
use crate::value::{Array, ErrorKind, Value, coerce_number_with, compare_values, round_sig15};
use std::cmp::Ordering;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

/// Largest area materialised into a dense array (anything bigger is `#CALC!`).
pub const MAX_MATERIALIZE_CELLS: u64 = 4 * MAX_SPILL_CELLS as u64;

/// A rectangular block of cells on one sheet (inclusive bounds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Area {
    /// Sheet.
    pub sheet: SheetId,
    /// First row.
    pub r0: u32,
    /// First column.
    pub c0: u32,
    /// Last row.
    pub r1: u32,
    /// Last column.
    pub c1: u32,
}

impl Area {
    /// A single cell.
    pub fn cell(sheet: SheetId, r: u32, c: u32) -> Area {
        Area {
            sheet,
            r0: r,
            c0: c,
            r1: r,
            c1: c,
        }
    }
    /// Rows.
    pub fn rows(&self) -> u32 {
        self.r1 - self.r0 + 1
    }
    /// Columns.
    pub fn cols(&self) -> u32 {
        self.c1 - self.c0 + 1
    }
    /// Cell count.
    pub fn size(&self) -> u64 {
        self.rows() as u64 * self.cols() as u64
    }
    /// Is this a single cell?
    pub fn is_cell(&self) -> bool {
        self.r0 == self.r1 && self.c0 == self.c1
    }
    /// As a sheet-less rectangle.
    pub fn rect(&self) -> Rect {
        Rect {
            r0: self.r0,
            c0: self.c0,
            r1: self.r1,
            c1: self.c1,
        }
    }
    /// Does it contain the cell?
    pub fn contains(&self, r: u32, c: u32) -> bool {
        r >= self.r0 && r <= self.r1 && c >= self.c0 && c <= self.c1
    }
}

/// An evaluation result: a value, an unevaluated reference, a union of references, or an omitted argument.
#[derive(Clone, Debug)]
pub enum Ev {
    /// Omitted argument.
    Missing,
    /// A value (possibly an array).
    V(Value),
    /// A reference (lazy range view).
    R(Area),
    /// A union of references.
    U(Vec<Area>),
}

impl From<Value> for Ev {
    fn from(v: Value) -> Ev {
        Ev::V(v)
    }
}
impl From<ErrorKind> for Ev {
    fn from(e: ErrorKind) -> Ev {
        Ev::V(Value::Error(e))
    }
}

impl Ev {
    /// Is this a multi-cell reference or an array?
    pub fn is_multi(&self) -> bool {
        match self {
            Ev::V(Value::Array(_)) => true,
            Ev::R(a) => !a.is_cell(),
            Ev::U(_) => true,
            _ => false,
        }
    }
    /// The error, if this is an error value.
    pub fn error(&self) -> Option<ErrorKind> {
        match self {
            Ev::V(Value::Error(e)) => Some(*e),
            _ => None,
        }
    }
}

/// Read access to cell data, implemented by the workbook.
pub trait Grid {
    /// Value at a cell (including spill children). Empty when nothing is there.
    fn value(&self, sheet: SheetId, row: u32, col: u32) -> Value;
    /// Visit non-empty cells inside `area` in row-major order.
    fn for_each_nonempty(&self, area: &Area, f: &mut dyn FnMut(u32, u32, &Value));
    /// `(rows, cols)` covering every used cell of the sheet (max index + 1).
    fn extent(&self, sheet: SheetId) -> (u32, u32);
    /// Resolve a sheet name (case-insensitive).
    fn sheet_by_name(&self, name: &str) -> Option<SheetId>;
    /// Name of a sheet.
    fn sheet_name(&self, id: SheetId) -> Option<String>;
    /// Bound expression of a defined name visible from `sheet`.
    fn defined_name(&self, name: &str, sheet: SheetId) -> Option<Arc<Expr>>;
    /// Does the cell hold a formula?
    fn is_formula(&self, sheet: SheetId, row: u32, col: u32) -> bool;
    /// Spill area of an anchor cell (for `A1#`).
    fn spill_range(&self, sheet: SheetId, row: u32, col: u32) -> Option<Area>;
    /// 1904 date system?
    fn date1904(&self) -> bool;
}

/// A grid with no cells (scalar evaluation without a workbook).
pub struct EmptyGrid;

impl Grid for EmptyGrid {
    fn value(&self, _: SheetId, _: u32, _: u32) -> Value {
        Value::Empty
    }
    fn for_each_nonempty(&self, _: &Area, _: &mut dyn FnMut(u32, u32, &Value)) {}
    fn extent(&self, _: SheetId) -> (u32, u32) {
        (0, 0)
    }
    fn sheet_by_name(&self, _: &str) -> Option<SheetId> {
        None
    }
    fn sheet_name(&self, _: SheetId) -> Option<String> {
        None
    }
    fn defined_name(&self, _: &str, _: SheetId) -> Option<Arc<Expr>> {
        None
    }
    fn is_formula(&self, _: SheetId, _: u32, _: u32) -> bool {
        false
    }
    fn spill_range(&self, _: SheetId, _: u32, _: u32) -> Option<Area> {
        None
    }
    fn date1904(&self) -> bool {
        false
    }
}

/// Operation budget shared across one recalculation.
#[derive(Debug)]
pub struct Budget {
    /// Operations left.
    pub remaining: u64,
    /// Set once the budget ran out or the job was cancelled.
    pub exhausted: bool,
    /// Optional cancellation flag.
    pub cancel: Option<Arc<AtomicBool>>,
    counter: u32,
    /// Results of large single-range aggregates (`SUM(A:A)`) shared by formulas in one pass.
    memo: rustc_hash::FxHashMap<(&'static str, Area), Value>,
}

/// Aggregates whose result over one large range is memoised within a recalculation pass.
const MEMO_FNS: &[&str] = &[
    "SUM", "COUNT", "COUNTA", "AVERAGE", "MIN", "MAX", "PRODUCT", "SUMSQ", "MEDIAN",
];
const MEMO_MIN_CELLS: u64 = 1024;
const MEMO_CAP: usize = 1024;

impl Budget {
    /// A budget of `ops` operations.
    pub fn new(ops: u64, cancel: Option<Arc<AtomicBool>>) -> Budget {
        Budget {
            remaining: ops,
            exhausted: false,
            cancel,
            counter: 0,
            memo: rustc_hash::FxHashMap::default(),
        }
    }
    /// Forget memoised aggregates (new pass, iteration).
    pub fn memo_clear(&mut self) {
        self.memo.clear();
    }
    /// Forget memoised aggregates over areas containing a changed cell.
    pub fn memo_invalidate(&mut self, sheet: SheetId, r0: u32, c0: u32, r1: u32, c1: u32) {
        if self.memo.is_empty() {
            return;
        }
        let changed = Rect { r0, c0, r1, c1 };
        self.memo
            .retain(|(_, a), _| a.sheet != sheet || !a.rect().intersects(&changed));
    }
    /// Consume `n` operations.
    #[inline]
    pub fn tick(&mut self, n: u64) -> Result<(), ErrorKind> {
        if self.exhausted {
            return Err(ErrorKind::Calc);
        }
        if self.remaining < n {
            self.remaining = 0;
            self.exhausted = true;
            return Err(ErrorKind::Calc);
        }
        self.remaining -= n;
        self.counter = self.counter.wrapping_add(1);
        if self.counter.is_multiple_of(4096)
            && let Some(c) = &self.cancel
            && c.load(AtomicOrdering::Relaxed)
        {
            self.exhausted = true;
            return Err(ErrorKind::Calc);
        }
        Ok(())
    }
}

/// Evaluation context for one formula.
pub struct EvalCtx<'a> {
    /// Cell data.
    pub grid: &'a dyn Grid,
    /// Clock, RNG and market cache.
    pub host: &'a dyn Host,
    /// Sheet of the formula.
    pub sheet: SheetId,
    /// Row of the formula.
    pub row: u32,
    /// Column of the formula.
    pub col: u32,
    budget: &'a mut Budget,
    depth: usize,
    name_depth: usize,
    scopes: Vec<(String, Ev)>,
    /// External keys read by this formula.
    pub externals: Vec<ExternalKey>,
    /// Set when a volatile function was evaluated.
    pub volatile: bool,
}

/// Result type used by function implementations.
pub type R = Result<Ev, ErrorKind>;

/// Wrap a value as a successful result.
#[inline]
pub fn ok(v: impl Into<Value>) -> R {
    Ok(Ev::V(v.into()))
}

/// Wrap a number (non-finite → `#NUM!`).
#[inline]
pub fn num(x: f64) -> R {
    Ok(Ev::V(Value::number(x)))
}

impl<'a> EvalCtx<'a> {
    /// New context for a formula at `(sheet, row, col)`.
    pub fn new(
        grid: &'a dyn Grid,
        host: &'a dyn Host,
        budget: &'a mut Budget,
        sheet: SheetId,
        row: u32,
        col: u32,
    ) -> Self {
        EvalCtx {
            grid,
            host,
            sheet,
            row,
            col,
            budget,
            depth: 0,
            name_depth: 0,
            scopes: Vec::new(),
            externals: Vec::new(),
            volatile: false,
        }
    }

    /// 1904 date system?
    pub fn date1904(&self) -> bool {
        self.grid.date1904()
    }

    /// Consume operations from the budget.
    #[inline]
    pub fn tick(&mut self, n: u64) -> Result<(), ErrorKind> {
        self.budget.tick(n)
    }

    /// Evaluate an expression to a final value (references are dereferenced; multi-cell results become arrays).
    pub fn eval_value(&mut self, e: &Expr) -> Value {
        let ev = self.eval(e);
        self.to_value(ev)
    }

    /// Convert an `Ev` to a value, materialising references into arrays.
    pub fn to_value(&mut self, ev: Ev) -> Value {
        match ev {
            Ev::Missing => Value::Empty,
            Ev::V(v) => v,
            Ev::R(a) if a.is_cell() => self.grid.value(a.sheet, a.r0, a.c0),
            Ev::R(a) => match self.area_array(self.clip(a)) {
                Ok(arr) => Value::array(arr),
                Err(e) => Value::Error(e),
            },
            Ev::U(_) => Value::Error(ErrorKind::Value),
        }
    }

    /// Evaluate an expression.
    pub fn eval(&mut self, e: &Expr) -> Ev {
        if self.tick(1).is_err() {
            return ErrorKind::Calc.into();
        }
        match e {
            Expr::Number(x) => Ev::V(Value::number(*x)),
            Expr::Text(s) => Ev::V(Value::text(s)),
            Expr::Bool(b) => Ev::V(Value::Bool(*b)),
            Expr::Error(k) => Ev::V(Value::Error(*k)),
            Expr::Missing => Ev::Missing,
            Expr::Ref(r) => self.resolve_ref(r),
            Expr::Name(n) => self.resolve_name(n),
            Expr::Paren(inner) => self.eval(inner),
            Expr::Unary(op, inner) => {
                let v = self.eval(inner);
                match op {
                    UnaryOp::Plus => v,
                    UnaryOp::Neg => self.lift1(v, |x| match x.coerce_number() {
                        Ok(n) => Value::number(-n),
                        Err(e) => Value::Error(e),
                    }),
                    UnaryOp::Not => self.lift1(v, |x| match x.coerce_bool() {
                        Ok(b) => Value::Bool(!b),
                        Err(e) => Value::Error(e),
                    }),
                    UnaryOp::At => self.implicit_intersection(v),
                }
            }
            Expr::Postfix(PostfixOp::Percent, inner) => {
                let v = self.eval(inner);
                let d1904 = self.date1904();
                self.lift1(v, move |x| match coerce_number_with(x, d1904) {
                    Ok(n) => Value::number(n / 100.0),
                    Err(e) => Value::Error(e),
                })
            }
            Expr::Postfix(PostfixOp::Spill, inner) => match self.eval(inner) {
                Ev::R(a) if a.is_cell() => match self.grid.spill_range(a.sheet, a.r0, a.c0) {
                    Some(area) => Ev::R(area),
                    None => match self.grid.value(a.sheet, a.r0, a.c0) {
                        Value::Error(e) if self.grid.is_formula(a.sheet, a.r0, a.c0) => e.into(),
                        _ => ErrorKind::Ref.into(),
                    },
                },
                Ev::V(Value::Error(e)) => e.into(),
                _ => ErrorKind::Ref.into(),
            },
            Expr::Binary(op, a, b) => self.binary(*op, a, b),
            Expr::Call { name, args } => self.call(name, args),
            Expr::Array(rows) => {
                let mut data = Vec::new();
                let r = rows.len();
                let c = rows.first().map(|x| x.len()).unwrap_or(1);
                for row in rows {
                    for item in row {
                        let v = self.eval_value(item);
                        data.push(v);
                    }
                }
                Ev::V(Value::array(Array::new(r, c, data)))
            }
            Expr::List(_) | Expr::Ternary(..) | Expr::Method { .. } | Expr::Path(_) => {
                ErrorKind::Name.into()
            }
        }
    }

    /// Resolve a reference to an area.
    pub fn resolve_ref(&mut self, r: &Reference) -> Ev {
        let sheet = match &r.sheet {
            None => self.sheet,
            Some(SheetRef::Id(id)) => {
                if self.grid.sheet_name(*id).is_none() {
                    return ErrorKind::Ref.into();
                }
                *id
            }
            Some(SheetRef::Named(n)) => match self.grid.sheet_by_name(n) {
                Some(id) => id,
                None => return ErrorKind::Ref.into(),
            },
        };
        if matches!(r.target, RefTarget::Invalid) {
            return ErrorKind::Ref.into();
        }
        match r.bounds() {
            Some((r0, c0, r1, c1)) => Ev::R(Area {
                sheet,
                r0,
                c0,
                r1,
                c1,
            }),
            None => ErrorKind::Ref.into(),
        }
    }

    fn resolve_name(&mut self, n: &str) -> Ev {
        if let Some((_, v)) = self
            .scopes
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(n))
        {
            return v.clone();
        }
        if self.name_depth > 32 {
            return ErrorKind::Ref.into();
        }
        match self.grid.defined_name(n, self.sheet) {
            Some(expr) => {
                self.name_depth += 1;
                let r = self.eval(&expr);
                self.name_depth -= 1;
                r
            }
            None => ErrorKind::Name.into(),
        }
    }

    /// Clip whole-column / whole-row areas to the used extent of the sheet (keeps the start corner).
    pub fn clip(&self, a: Area) -> Area {
        let mut a = a;
        let full_cols = a.r0 == 0 && a.r1 == MAX_ROWS - 1;
        let full_rows = a.c0 == 0 && a.c1 == MAX_COLS - 1;
        if full_cols || full_rows {
            let (rows, cols) = self.grid.extent(a.sheet);
            if full_cols {
                a.r1 = rows.saturating_sub(1).max(a.r0);
            }
            if full_rows {
                a.c1 = cols.saturating_sub(1).max(a.c0);
            }
        }
        a
    }

    /// Materialise an area into a dense array.
    pub fn area_array(&mut self, a: Area) -> Result<Array, ErrorKind> {
        let size = a.size();
        if size > MAX_MATERIALIZE_CELLS {
            return Err(ErrorKind::Calc);
        }
        self.tick(size / 8 + 1)?;
        let rows = a.rows() as usize;
        let cols = a.cols() as usize;
        let mut data = vec![Value::Empty; rows * cols];
        let (r0, c0) = (a.r0, a.c0);
        self.grid.for_each_nonempty(&a, &mut |r, c, v| {
            let idx = (r - r0) as usize * cols + (c - c0) as usize;
            if let Some(slot) = data.get_mut(idx) {
                *slot = v.clone();
            }
        });
        Ok(Array::new(rows, cols, data))
    }

    /// Any `Ev` as a dense array (scalars become 1×1). Whole columns/rows are clipped.
    pub fn to_array(&mut self, ev: &Ev) -> Result<Array, ErrorKind> {
        match ev {
            Ev::Missing => Ok(Array::filled(1, 1, Value::Empty)),
            Ev::V(Value::Array(a)) => Ok((**a).clone()),
            Ev::V(v) => Ok(Array::filled(1, 1, v.clone())),
            Ev::R(a) => {
                let a = self.clip(*a);
                self.area_array(a)
            }
            Ev::U(_) => Err(ErrorKind::Value),
        }
    }

    /// Scalar value of an `Ev` (single-cell refs dereferenced; multi-cell refs use implicit intersection).
    pub fn scalar(&mut self, ev: &Ev) -> Value {
        match ev {
            Ev::Missing => Value::Empty,
            Ev::V(Value::Array(a)) => a.get(0, 0).clone(),
            Ev::V(v) => v.clone(),
            Ev::R(a) if a.is_cell() => self.grid.value(a.sheet, a.r0, a.c0),
            Ev::R(a) => match self.intersect_cell(a) {
                Some((r, c)) => self.grid.value(a.sheet, r, c),
                None => Value::Error(ErrorKind::Value),
            },
            Ev::U(_) => Value::Error(ErrorKind::Value),
        }
    }

    fn intersect_cell(&self, a: &Area) -> Option<(u32, u32)> {
        if a.c0 == a.c1 && a.sheet == self.sheet && self.row >= a.r0 && self.row <= a.r1 {
            Some((self.row, a.c0))
        } else if a.r0 == a.r1 && a.sheet == self.sheet && self.col >= a.c0 && self.col <= a.c1 {
            Some((a.r0, self.col))
        } else {
            None
        }
    }

    fn implicit_intersection(&mut self, v: Ev) -> Ev {
        match v {
            Ev::R(a) if !a.is_cell() => match self.intersect_cell(&a) {
                Some((r, c)) => Ev::R(Area::cell(a.sheet, r, c)),
                None => ErrorKind::Value.into(),
            },
            Ev::V(Value::Array(a)) => Ev::V(a.get(0, 0).clone()),
            other => other,
        }
    }

    // ------------------------------------------------------------------ typed scalar accessors

    /// Number coercion of a scalar argument.
    pub fn num(&mut self, ev: &Ev) -> Result<f64, ErrorKind> {
        let v = self.scalar(ev);
        coerce_number_with(&v, self.date1904())
    }
    /// Text coercion of a scalar argument.
    pub fn text(&mut self, ev: &Ev) -> Result<String, ErrorKind> {
        self.scalar(ev).coerce_text()
    }
    /// Boolean coercion of a scalar argument.
    pub fn boolean(&mut self, ev: &Ev) -> Result<bool, ErrorKind> {
        let v = self.scalar(ev);
        match v {
            Value::Text(_) => v.coerce_bool(),
            other => other.coerce_bool(),
        }
    }
    /// Optional number argument with a default for absent/omitted args.
    pub fn opt_num(&mut self, args: &[Ev], i: usize, default: f64) -> Result<f64, ErrorKind> {
        match args.get(i) {
            None | Some(Ev::Missing) => Ok(default),
            Some(ev) => self.num(ev),
        }
    }
    /// Optional boolean argument.
    pub fn opt_bool(&mut self, args: &[Ev], i: usize, default: bool) -> Result<bool, ErrorKind> {
        match args.get(i) {
            None | Some(Ev::Missing) => Ok(default),
            Some(ev) => self.boolean(ev),
        }
    }
    /// Optional text argument.
    pub fn opt_text(&mut self, args: &[Ev], i: usize, default: &str) -> Result<String, ErrorKind> {
        match args.get(i) {
            None | Some(Ev::Missing) => Ok(default.to_string()),
            Some(ev) => self.text(ev),
        }
    }

    /// Visit every value of an argument for aggregation. `from_ref` is true for values that came from
    /// a reference or array (where Excel ignores text and booleans), false for direct scalar arguments.
    pub fn for_each_value(
        &mut self,
        ev: &Ev,
        f: &mut dyn FnMut(&Value, bool) -> Result<(), ErrorKind>,
    ) -> Result<(), ErrorKind> {
        match ev {
            Ev::Missing => Ok(()),
            Ev::V(Value::Array(a)) => {
                self.tick(a.len() as u64 / 8 + 1)?;
                for v in a.data() {
                    f(v, true)?;
                }
                Ok(())
            }
            Ev::V(v) => f(v, false),
            Ev::R(a) => self.for_each_in_area(a, f),
            Ev::U(list) => {
                for a in list.clone() {
                    self.for_each_in_area(&a, f)?;
                }
                Ok(())
            }
        }
    }

    fn for_each_in_area(
        &mut self,
        a: &Area,
        f: &mut dyn FnMut(&Value, bool) -> Result<(), ErrorKind>,
    ) -> Result<(), ErrorKind> {
        let mut err: Option<ErrorKind> = None;
        let budget = &mut *self.budget;
        self.grid.for_each_nonempty(a, &mut |_, _, v| {
            if err.is_some() {
                return;
            }
            if let Err(e) = budget.tick(1) {
                err = Some(e);
                return;
            }
            if let Err(e) = f(v, true) {
                err = Some(e);
            }
        });
        match err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Collect numbers Excel-style: direct args are coerced (text → number or `#VALUE!`), values from
    /// references/arrays keep only numbers. Errors propagate.
    pub fn collect_numbers(&mut self, args: &[Ev]) -> Result<Vec<f64>, ErrorKind> {
        let mut out = Vec::new();
        let d1904 = self.date1904();
        for a in args {
            self.for_each_value(a, &mut |v, from_ref| {
                match v {
                    Value::Number(n) => out.push(*n),
                    Value::Error(e) => return Err(*e),
                    Value::Empty => {}
                    Value::Bool(b) if !from_ref => out.push(if *b { 1.0 } else { 0.0 }),
                    Value::Text(_) if !from_ref => out.push(coerce_number_with(v, d1904)?),
                    _ => {}
                }
                Ok(())
            })?;
        }
        Ok(out)
    }

    // ------------------------------------------------------------------ lifting & operators

    /// Bound the size of an array built by broadcasting operands of different shapes, and charge
    /// the operation budget for it. Fails with `#CALC!` above [`MAX_MATERIALIZE_CELLS`].
    pub fn check_broadcast(&mut self, rows: usize, cols: usize) -> Result<(), ErrorKind> {
        let size = (rows as u64).saturating_mul(cols as u64);
        if size > MAX_MATERIALIZE_CELLS {
            return Err(ErrorKind::Calc);
        }
        self.tick(size / 8 + 1)
    }

    /// Apply a scalar function element-wise.
    pub fn lift1(&mut self, v: Ev, f: impl Fn(&Value) -> Value) -> Ev {
        let v = self.to_value(v);
        match v {
            Value::Array(a) => Ev::V(Value::array(a.map(&f))),
            other => Ev::V(f(&other)),
        }
    }

    /// Apply a binary scalar function with Excel broadcasting.
    pub fn lift2(&mut self, a: Ev, b: Ev, f: impl Fn(&Value, &Value) -> Value) -> Ev {
        let a = self.to_value(a);
        let b = self.to_value(b);
        match (&a, &b) {
            (Value::Array(x), Value::Array(y)) => {
                let rows = bdim(x.rows(), y.rows());
                let cols = bdim(x.cols(), y.cols());
                // Broadcasting a column against a row multiplies their sizes: bound the result
                // before allocating it (e.g. `A:A*1:1` would be 17 billion cells).
                if let Err(e) = self.check_broadcast(rows, cols) {
                    return e.into();
                }
                let mut data = Vec::with_capacity(rows * cols);
                for r in 0..rows {
                    for c in 0..cols {
                        data.push(f(x.get_broadcast(r, c), y.get_broadcast(r, c)));
                    }
                }
                Ev::V(Value::array(Array::new(rows, cols, data)))
            }
            (Value::Array(x), _) => Ev::V(Value::array(x.map(|v| f(v, &b)))),
            (_, Value::Array(y)) => Ev::V(Value::array(y.map(|v| f(&a, v)))),
            _ => Ev::V(f(&a, &b)),
        }
    }

    fn binary(&mut self, op: BinaryOp, a: &Expr, b: &Expr) -> Ev {
        match op {
            BinaryOp::Range => {
                let x = self.eval(a);
                let y = self.eval(b);
                match (x, y) {
                    (Ev::R(p), Ev::R(q)) if p.sheet == q.sheet => Ev::R(Area {
                        sheet: p.sheet,
                        r0: p.r0.min(q.r0),
                        c0: p.c0.min(q.c0),
                        r1: p.r1.max(q.r1),
                        c1: p.c1.max(q.c1),
                    }),
                    (Ev::V(Value::Error(e)), _) | (_, Ev::V(Value::Error(e))) => e.into(),
                    _ => ErrorKind::Value.into(),
                }
            }
            BinaryOp::Intersect => {
                let x = self.eval(a);
                let y = self.eval(b);
                match (x, y) {
                    (Ev::R(p), Ev::R(q)) if p.sheet == q.sheet => {
                        match p.rect().intersection(&q.rect()) {
                            Some(r) => Ev::R(Area {
                                sheet: p.sheet,
                                r0: r.r0,
                                c0: r.c0,
                                r1: r.r1,
                                c1: r.c1,
                            }),
                            None => ErrorKind::Null.into(),
                        }
                    }
                    (Ev::V(Value::Error(e)), _) | (_, Ev::V(Value::Error(e))) => e.into(),
                    _ => ErrorKind::Value.into(),
                }
            }
            BinaryOp::Union => {
                let x = self.eval(a);
                let y = self.eval(b);
                let mut out = Vec::new();
                for ev in [x, y] {
                    match ev {
                        Ev::R(p) => out.push(p),
                        Ev::U(list) => out.extend(list),
                        Ev::V(Value::Error(e)) => return e.into(),
                        _ => return ErrorKind::Value.into(),
                    }
                }
                Ev::U(out)
            }
            _ => {
                let x = self.eval(a);
                let y = self.eval(b);
                let d1904 = self.date1904();
                self.lift2(x, y, move |p, q| scalar_binop(op, p, q, d1904))
            }
        }
    }

    // ------------------------------------------------------------------ functions

    fn call(&mut self, name: &str, args: &[Expr]) -> Ev {
        let Some(spec) = lookup_function(name) else {
            return ErrorKind::Name.into();
        };
        if args.len() < spec.min_args || args.len() > spec.max_args {
            return ErrorKind::Value.into();
        }
        if self.depth >= MAX_CALL_DEPTH {
            return ErrorKind::Calc.into();
        }
        if spec.volatile {
            self.volatile = true;
        }
        self.depth += 1;
        let r = match spec.imp {
            FnImpl::Lazy(f) => f(self, args),
            FnImpl::Eager(f) => {
                let mut evs = Vec::with_capacity(args.len());
                for a in args {
                    evs.push(self.eval(a));
                }
                let memo_key = match evs.as_slice() {
                    [Ev::R(a)] if a.size() >= MEMO_MIN_CELLS && MEMO_FNS.contains(&spec.name) => {
                        Some((spec.name, *a))
                    }
                    _ => None,
                };
                if let Some(k) = memo_key
                    && let Some(v) = self.budget.memo.get(&k)
                {
                    Ok(Ev::V(v.clone()))
                } else {
                    let r = self.dispatch(spec, f, evs);
                    if let (Some(k), Ok(Ev::V(v))) = (memo_key, &r)
                        && !self.budget.exhausted
                        && self.budget.memo.len() < MEMO_CAP
                    {
                        self.budget.memo.insert(k, v.clone());
                    }
                    r
                }
            }
        };
        self.depth -= 1;
        match r {
            Ok(ev) => ev,
            Err(e) => e.into(),
        }
    }

    fn dispatch(&mut self, spec: &FnSpec, f: fn(&mut EvalCtx, &[Ev]) -> R, mut evs: Vec<Ev>) -> R {
        let mut lifted: Vec<usize> = Vec::new();
        for (i, ev) in evs.iter_mut().enumerate() {
            if spec.kind(i) != ArgKind::Value {
                continue;
            }
            match ev {
                Ev::R(a) if a.is_cell() => {
                    *ev = Ev::V(self.grid.value(a.sheet, a.r0, a.c0));
                }
                Ev::R(_) => {
                    let v = self.to_value(ev.clone());
                    *ev = Ev::V(v);
                    if matches!(ev, Ev::V(Value::Array(_))) {
                        lifted.push(i);
                    }
                }
                Ev::V(Value::Array(_)) => lifted.push(i),
                Ev::U(_) => *ev = ErrorKind::Value.into(),
                _ => {}
            }
        }
        if lifted.is_empty() {
            return f(self, &evs);
        }
        let mut rows = 1usize;
        let mut cols = 1usize;
        for &i in &lifted {
            if let Ev::V(Value::Array(a)) = &evs[i] {
                rows = bdim(rows, a.rows());
                cols = bdim(cols, a.cols());
            }
        }
        if rows * cols > MAX_SPILL_CELLS {
            return Err(ErrorKind::Spill);
        }
        let arrays: Vec<(usize, Arc<Array>)> = lifted
            .iter()
            .filter_map(|&i| match &evs[i] {
                Ev::V(Value::Array(a)) => Some((i, a.clone())),
                _ => None,
            })
            .collect();
        let mut data = Vec::with_capacity(rows * cols);
        let mut call_args = evs.clone();
        for r in 0..rows {
            for c in 0..cols {
                for (i, a) in &arrays {
                    call_args[*i] = Ev::V(a.get_broadcast(r, c).clone());
                }
                let v = match f(self, &call_args) {
                    Ok(ev) => {
                        let v = self.to_value(ev);
                        v.scalar().clone()
                    }
                    Err(e) => Value::Error(e),
                };
                data.push(v);
                if self.budget.exhausted {
                    return Err(ErrorKind::Calc);
                }
            }
        }
        Ok(Ev::V(Value::array(Array::new(rows, cols, data))))
    }

    /// Push a `LET` binding.
    pub fn push_scope(&mut self, name: &str, v: Ev) -> Result<(), ErrorKind> {
        if self.scopes.len() >= MAX_LET_DEPTH {
            return Err(ErrorKind::Calc);
        }
        self.scopes.push((name.to_string(), v));
        Ok(())
    }
    /// Pop `n` `LET` bindings.
    pub fn pop_scopes(&mut self, n: usize) {
        let len = self.scopes.len().saturating_sub(n);
        self.scopes.truncate(len);
    }
    /// Record an external key read by this formula.
    pub fn note_external(&mut self, k: ExternalKey) {
        if !self.externals.contains(&k) {
            self.externals.push(k);
        }
    }
}

/// Broadcast dimension of two array extents.
pub fn bdim(a: usize, b: usize) -> usize {
    if a == 1 {
        b
    } else if b == 1 {
        a
    } else {
        a.max(b)
    }
}

/// Excel comparison of two scalars with 15-significant-digit number equality.
pub fn excel_compare(p: &Value, q: &Value) -> Ordering {
    match (p, q) {
        (Value::Number(x), Value::Number(y)) => round_sig15(*x)
            .partial_cmp(&round_sig15(*y))
            .unwrap_or(Ordering::Equal),
        _ => compare_values(p, q),
    }
}

/// Scalar binary operator semantics.
pub fn scalar_binop(op: BinaryOp, p: &Value, q: &Value, d1904: bool) -> Value {
    if let Value::Error(e) = p {
        return Value::Error(*e);
    }
    if let Value::Error(e) = q {
        return Value::Error(*e);
    }
    match op {
        BinaryOp::Concat => match (p.coerce_text(), q.coerce_text()) {
            (Ok(a), Ok(b)) => Value::text(a + &b),
            (Err(e), _) | (_, Err(e)) => Value::Error(e),
        },
        BinaryOp::Eq => Value::Bool(excel_compare(p, q) == Ordering::Equal),
        BinaryOp::Ne => Value::Bool(excel_compare(p, q) != Ordering::Equal),
        BinaryOp::Lt => Value::Bool(excel_compare(p, q) == Ordering::Less),
        BinaryOp::Le => Value::Bool(excel_compare(p, q) != Ordering::Greater),
        BinaryOp::Gt => Value::Bool(excel_compare(p, q) == Ordering::Greater),
        BinaryOp::Ge => Value::Bool(excel_compare(p, q) != Ordering::Less),
        _ => {
            let a = match coerce_number_with(p, d1904) {
                Ok(a) => a,
                Err(e) => return Value::Error(e),
            };
            let b = match coerce_number_with(q, d1904) {
                Ok(b) => b,
                Err(e) => return Value::Error(e),
            };
            match op {
                BinaryOp::Add => Value::number(a + b),
                BinaryOp::Sub => Value::number(a - b),
                BinaryOp::Mul => Value::number(a * b),
                BinaryOp::Div => {
                    if b == 0.0 {
                        Value::Error(ErrorKind::Div0)
                    } else {
                        Value::number(a / b)
                    }
                }
                BinaryOp::Mod => {
                    if b == 0.0 {
                        Value::Error(ErrorKind::Div0)
                    } else {
                        Value::number(a - b * (a / b).floor())
                    }
                }
                BinaryOp::Pow => excel_pow(a, b),
                BinaryOp::And => Value::Bool(a != 0.0 && b != 0.0),
                BinaryOp::Or => Value::Bool(a != 0.0 || b != 0.0),
                _ => Value::Error(ErrorKind::Value),
            }
        }
    }
}

/// Excel `^`: `0^0` is `#NUM!`, `0^-n` is `#DIV/0!`, negative base with fractional exponent is `#NUM!`.
pub fn excel_pow(a: f64, b: f64) -> Value {
    if a == 0.0 && b == 0.0 {
        return Value::Error(ErrorKind::Num);
    }
    if a == 0.0 && b < 0.0 {
        return Value::Error(ErrorKind::Div0);
    }
    if a < 0.0 && b.fract() != 0.0 {
        // Odd roots of negative numbers (e.g. (-8)^(1/3)) are allowed by Excel.
        let inv = 1.0 / b;
        if (inv.round() - inv).abs() < 1e-10 && (inv.round() as i64) % 2 != 0 {
            return Value::number(-(-a).powf(b));
        }
        return Value::Error(ErrorKind::Num);
    }
    Value::number(a.powf(b))
}
