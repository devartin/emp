//! Workbook model (SPEC §14.2): sheets with sparse cells, styles, defined names, calculation settings,
//! the dependency graph, incremental recalculation and an undo-friendly edit API.
//!
//! Every public entry point that parses or evaluates runs inside `catch_unwind`, so a bug in a function
//! implementation can never take the host process down (D-15).

pub mod deps;
pub mod ops;
pub mod packed;
pub mod persist;
pub mod recalc;
pub mod sheet;
pub mod structural;
pub mod style;
pub mod tools;

use crate::address::{CellKey, Rect, SheetId, format_rect, is_valid_sheet_name, quote_sheet_name};
use crate::ast::{Expr, RefTarget, SheetRef};
use crate::eval::{Area, Budget, Ev, EvalCtx, Grid};
use crate::functions::{Category, lookup_function};
use crate::host::{CacheHost, Host};
use crate::limits::{MAX_COLS, MAX_OPS_PER_RECALC, MAX_ROWS};
use crate::numfmt::{NumLocale, format_value};
use crate::parser::{Dialect, ParseError, parse};
use crate::printer::{SheetNames, print_excel};
use crate::value::{ErrorKind, Value, parse_number_text};
use deps::{DepGraph, Precedents, RangeRef};
use ops::UndoStack;
use rustc_hash::FxHashSet;
use serde::{Deserialize, Serialize};
use sheet::{Cell, CellInput, Formula, Sheet};
use std::cell::Cell as StdCell;
use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use style::StyleTable;
use thiserror::Error;

pub use recalc::RecalcReport;

/// Errors returned by workbook operations.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
pub enum SheetError {
    /// Unknown sheet, name or cell.
    #[error("not found: {0}")]
    NotFound(String),
    /// Invalid argument (bad name, out-of-grid coordinate, …).
    #[error("invalid: {0}")]
    Invalid(String),
    /// A formula did not parse.
    #[error("formula error: {0}")]
    Parse(ParseError),
    /// Too large (limits of §9.17 / §9.16).
    #[error("too large: {0}")]
    TooLarge(String),
    /// IO / format error in import or export.
    #[error("io: {0}")]
    Io(String),
    /// Internal error (a caught panic).
    #[error("internal error: {0}")]
    Internal(String),
}

/// Calculation settings (IPC `calc`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcSettings {
    /// Iterative calculation (100 iterations or a 0.001 change).
    pub iterative: bool,
    /// 1904 date system.
    pub date1904: bool,
}

/// A defined name.
#[derive(Clone, Debug, PartialEq)]
pub struct DefinedName {
    /// Name as written.
    pub name: String,
    /// Bound expression (usually a reference).
    pub expr: Arc<Expr>,
}

/// Interpreted cell input.
#[derive(Clone, Debug, PartialEq)]
pub enum ParsedInput {
    /// Clear the content.
    Clear,
    /// A literal, plus a number format suggested by how it was typed (`50%` → `0%`).
    Value(Value, Option<&'static str>),
    /// A formula (source without `=`).
    Formula(String),
}

/// Interpret typed text the way a spreadsheet does.
pub fn parse_input(text: &str, date1904: bool) -> ParsedInput {
    if text.is_empty() {
        return ParsedInput::Clear;
    }
    if let Some(rest) = text.strip_prefix('\'') {
        return ParsedInput::Value(Value::text(rest), None);
    }
    if let Some(rest) = text.strip_prefix('=')
        && !rest.trim().is_empty()
    {
        return ParsedInput::Formula(rest.to_string());
    }
    let t = text.trim();
    if t.eq_ignore_ascii_case("TRUE") {
        return ParsedInput::Value(Value::Bool(true), None);
    }
    if t.eq_ignore_ascii_case("FALSE") {
        return ParsedInput::Value(Value::Bool(false), None);
    }
    if let Some(e) = ErrorKind::parse(t)
        && !matches!(e, ErrorKind::Circ | ErrorKind::Fetch)
    {
        return ParsedInput::Value(Value::Error(e), None);
    }
    if let Some(n) = parse_number_text(t) {
        let hint = if t.ends_with('%') {
            Some(if t.contains('.') { "0.00%" } else { "0%" })
        } else if t.contains('$') {
            Some("\"$\"#,##0.00")
        } else if t.contains(',') {
            Some(if t.contains('.') { "#,##0.00" } else { "#,##0" })
        } else {
            None
        };
        return ParsedInput::Value(Value::number(n), hint);
    }
    if let Some(serial) = crate::datetime::parse_datetime_text(t, date1904) {
        let hint = if serial < 1.0 && t.contains(':') {
            if t.matches(':').count() >= 2 {
                "h:mm:ss"
            } else {
                "h:mm"
            }
        } else if serial.fract() != 0.0 || t.contains(':') {
            "yyyy-mm-dd h:mm"
        } else {
            "yyyy-mm-dd"
        };
        return ParsedInput::Value(Value::number(serial), Some(hint));
    }
    ParsedInput::Value(Value::text(text), None)
}

/// Is `name` a valid defined name?
pub fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_alphabetic() || first == '_' || first == '\\') {
        return false;
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.')
        || name.len() > 255
    {
        return false;
    }
    if crate::address::parse_a1(name).is_some()
        || name.eq_ignore_ascii_case("TRUE")
        || name.eq_ignore_ascii_case("FALSE")
    {
        return false;
    }
    // R1C1-looking names are not allowed either.
    let up = name.to_ascii_uppercase();
    !(up == "R" || up == "C")
}

/// A workbook.
pub struct Workbook {
    pub(crate) sheets: Vec<Sheet>,
    pub(crate) next_sheet_id: SheetId,
    pub(crate) names: BTreeMap<String, DefinedName>,
    pub(crate) styles: StyleTable,
    pub(crate) calc: CalcSettings,
    pub(crate) deps: DepGraph,
    pub(crate) host: Arc<dyn Host>,
    pub(crate) undo: UndoStack,
    pub(crate) pending_dirty: FxHashSet<CellKey>,
    pub(crate) rev: u64,
    /// Number formatting locale.
    pub locale: NumLocale,
    /// Operation budget per recalculation.
    pub ops_budget: u64,
}

impl std::fmt::Debug for Workbook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workbook")
            .field("sheets", &self.sheets.len())
            .field("rev", &self.rev)
            .finish()
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Workbook::new()
    }
}

impl SheetNames for Workbook {
    fn sheet_name(&self, id: SheetId) -> Option<String> {
        self.sheet(id).map(|s| s.name.clone())
    }
}

impl Workbook {
    /// An empty workbook with one sheet named `Sheet1` and the system-clock host.
    pub fn new() -> Workbook {
        let mut wb = Workbook::empty(Arc::new(CacheHost::new()));
        wb.push_sheet("Sheet1");
        wb
    }

    /// An empty workbook without sheets, using `host` for the clock and market data.
    pub fn empty(host: Arc<dyn Host>) -> Workbook {
        Workbook {
            sheets: Vec::new(),
            next_sheet_id: 0,
            names: BTreeMap::new(),
            styles: StyleTable::default(),
            calc: CalcSettings::default(),
            deps: DepGraph::new(),
            host,
            undo: UndoStack::default(),
            pending_dirty: FxHashSet::default(),
            rev: 0,
            locale: NumLocale::default(),
            ops_budget: MAX_OPS_PER_RECALC,
        }
    }

    /// Replace the host (clock / RNG / market cache).
    pub fn set_host(&mut self, host: Arc<dyn Host>) {
        self.host = host;
    }

    /// The host.
    pub fn host(&self) -> &Arc<dyn Host> {
        &self.host
    }

    /// Revision counter, bumped on every change.
    pub fn rev(&self) -> u64 {
        self.rev
    }

    /// Calculation settings.
    pub fn calc_settings(&self) -> CalcSettings {
        self.calc
    }

    /// Style table.
    pub fn styles(&self) -> &StyleTable {
        &self.styles
    }

    /// Sheets in tab order.
    pub fn sheets(&self) -> &[Sheet] {
        &self.sheets
    }

    /// Sheet by id.
    pub fn sheet(&self, id: SheetId) -> Option<&Sheet> {
        self.sheets.iter().find(|s| s.id == id)
    }

    pub(crate) fn sheet_mut(&mut self, id: SheetId) -> Option<&mut Sheet> {
        self.sheets.iter_mut().find(|s| s.id == id)
    }

    /// Sheet index (tab position).
    pub fn sheet_index(&self, id: SheetId) -> Option<usize> {
        self.sheets.iter().position(|s| s.id == id)
    }

    /// Sheet by name (case-insensitive).
    pub fn sheet_by_name(&self, name: &str) -> Option<&Sheet> {
        self.sheets
            .iter()
            .find(|s| s.name.to_lowercase() == name.to_lowercase())
    }

    /// Defined names `(name, ref text)`.
    pub fn named_ranges(&self) -> Vec<(String, String)> {
        self.names
            .values()
            .map(|n| (n.name.clone(), print_excel(&n.expr, self)))
            .collect()
    }

    pub(crate) fn push_sheet(&mut self, name: &str) -> SheetId {
        let id = self.next_sheet_id;
        self.next_sheet_id = self.next_sheet_id.wrapping_add(1);
        self.sheets.push(Sheet::new(id, name));
        id
    }

    /// A unique default sheet name (`Sheet2`, `Sheet3`, …).
    pub fn unique_sheet_name(&self, base: &str) -> String {
        if self.sheet_by_name(base).is_none() && is_valid_sheet_name(base) {
            return base.to_string();
        }
        let stem = base.trim_end_matches(|c: char| c.is_ascii_digit());
        let stem = if stem.is_empty() { "Sheet" } else { stem };
        for i in 1.. {
            let cand = format!("{stem}{i}");
            if self.sheet_by_name(&cand).is_none() {
                return cand;
            }
        }
        base.to_string()
    }

    // ------------------------------------------------------------------ formulas

    /// Parse and bind a formula for a cell on `sheet` (source without `=`).
    pub fn compile(&self, src: &str) -> Result<Formula, SheetError> {
        let mut expr = parse(src, Dialect::Excel).map_err(SheetError::Parse)?;
        self.bind(&mut expr);
        let mut volatile = false;
        let mut dynamic = false;
        let mut external = false;
        let mut err: Option<String> = None;
        expr.walk(&mut |e| {
            if let Expr::Call { name, args } = e
                && let Some(spec) = lookup_function(name)
            {
                if spec.volatile {
                    volatile = true;
                }
                if spec.category == Category::Dynamic {
                    dynamic = true;
                }
                if spec.category == Category::Emp {
                    external = true;
                }
                if (args.len() < spec.min_args || args.len() > spec.max_args) && err.is_none() {
                    err = Some(if spec.min_args == spec.max_args {
                        format!(
                            "{} takes {} argument{}",
                            spec.name,
                            spec.min_args,
                            if spec.min_args == 1 { "" } else { "s" }
                        )
                    } else {
                        format!(
                            "{} takes {} to {} arguments",
                            spec.name, spec.min_args, spec.max_args
                        )
                    });
                }
            }
        });
        if let Some(m) = err {
            return Err(SheetError::Parse(ParseError {
                message: m,
                start: 0,
                end: src.len(),
            }));
        }
        Ok(Formula {
            expr,
            volatile,
            dynamic,
            external,
        })
    }

    /// Bind sheet names to ids.
    pub(crate) fn bind(&self, expr: &mut Expr) {
        expr.for_each_ref_mut(&mut |r| {
            if let Some(SheetRef::Named(n)) = &r.sheet
                && let Some(s) = self.sheet_by_name(n)
            {
                r.sheet = Some(SheetRef::Id(s.id));
            }
        });
    }

    /// Static precedents of a formula placed on `sheet`.
    pub(crate) fn precedents(&self, expr: &Expr, sheet: SheetId) -> Precedents {
        let mut p = Precedents::default();
        let mut seen_names: FxHashSet<String> = FxHashSet::default();
        self.collect_precedents(expr, sheet, &mut p, &mut seen_names, 0);
        p
    }

    fn collect_precedents(
        &self,
        expr: &Expr,
        sheet: SheetId,
        p: &mut Precedents,
        seen: &mut FxHashSet<String>,
        depth: usize,
    ) {
        expr.walk(&mut |e| match e {
            Expr::Ref(r) => {
                let sid = match &r.sheet {
                    None => sheet,
                    Some(SheetRef::Id(id)) => *id,
                    Some(SheetRef::Named(_)) => return,
                };
                if let Some((r0, c0, r1, c1)) = r.bounds() {
                    if r0 == r1 && c0 == c1 {
                        p.cells.push(CellKey::new(sid, r0, c0));
                    } else {
                        p.ranges.push(RangeRef {
                            sheet: sid,
                            rect: Rect { r0, c0, r1, c1 },
                        });
                    }
                }
            }
            Expr::Name(n) => {
                let up = n.to_uppercase();
                if seen.insert(up.clone()) {
                    p.names.push(up.clone());
                    if depth < 16
                        && let Some(dn) = self.names.get(&up)
                    {
                        let inner = dn.expr.clone();
                        let mut sub = Precedents::default();
                        self.collect_precedents(
                            &inner,
                            sheet,
                            &mut sub,
                            &mut FxHashSet::default(),
                            depth + 1,
                        );
                        p.cells.extend(sub.cells);
                        p.ranges.extend(sub.ranges);
                    }
                }
            }
            _ => {}
        });
    }

    /// Display text of a formula (with `=`), using current sheet names.
    pub fn formula_text(&self, f: &Formula) -> String {
        format!("={}", print_excel(&f.expr, self))
    }

    /// The input text of a cell as the formula bar shows it.
    pub fn input_text(&self, cell: &Cell) -> String {
        match &cell.input {
            CellInput::Formula(f) => self.formula_text(f),
            CellInput::Value(v) => match v {
                Value::Empty => String::new(),
                Value::Text(s) => {
                    // Text that would be re-interpreted gets the apostrophe prefix.
                    match parse_input(s, self.calc.date1904) {
                        ParsedInput::Value(Value::Text(_), _) | ParsedInput::Clear => s.to_string(),
                        _ => format!("'{s}"),
                    }
                }
                Value::Number(n) => {
                    let fmt = self.styles.num_fmt(cell.style).unwrap_or("");
                    if crate::numfmt::is_date_format(fmt) {
                        crate::datetime::serial_to_iso(*n, self.calc.date1904)
                            .unwrap_or_else(|| crate::value::number_to_text(*n))
                    } else {
                        crate::value::number_to_text(*n)
                    }
                }
                other => other.display(),
            },
        }
    }

    // ------------------------------------------------------------------ evaluation helpers

    /// Value at a cell (including spill children).
    pub fn value(&self, sheet: SheetId, row: u32, col: u32) -> Value {
        self.sheet(sheet)
            .map(|s| s.value_at(row, col))
            .unwrap_or(Value::Empty)
    }

    /// Display string of a cell (number format applied).
    pub fn display(&self, sheet: SheetId, row: u32, col: u32) -> String {
        let Some(s) = self.sheet(sheet) else {
            return String::new();
        };
        let v = s.value_at(row, col);
        let style = self.effective_style(s, row, col);
        self.format_display(&v, style)
    }

    pub(crate) fn effective_style(&self, s: &Sheet, row: u32, col: u32) -> u32 {
        if let Some(c) = s.cell(row, col) {
            return c.style;
        }
        if let Some(&(ar, ac)) = s.spill_children.get(&(row, col)) {
            return s.cell(ar, ac).map(|c| c.style).unwrap_or(0);
        }
        0
    }

    pub(crate) fn format_display(&self, v: &Value, style: u32) -> String {
        let fmt = self.styles.num_fmt(style).unwrap_or("");
        format_value(v, fmt, &self.locale, self.calc.date1904).text
    }

    /// Evaluate a formula against the workbook without storing it (`sheet_eval`). `sheet` gives the
    /// context for unqualified references; `None` evaluates in scalar mode against an empty grid.
    pub fn eval_formula(&self, sheet: Option<SheetId>, src: &str) -> Result<Value, SheetError> {
        let src = src.strip_prefix('=').unwrap_or(src);
        let f = self.compile(src)?;
        let r = catch_unwind(AssertUnwindSafe(|| {
            let mut budget = Budget::new(self.ops_budget, None);
            match sheet {
                Some(sid) => {
                    let grid = WbGrid::new(self, None);
                    let mut ctx = EvalCtx::new(&grid, &*self.host, &mut budget, sid, 0, 0);
                    let ev = ctx.eval(&f.expr);
                    finalize(&mut ctx, ev)
                }
                None => {
                    let grid = crate::eval::EmptyGrid;
                    let mut ctx = EvalCtx::new(&grid, &*self.host, &mut budget, 0, 0, 0);
                    let ev = ctx.eval(&f.expr);
                    finalize(&mut ctx, ev)
                }
            }
        }));
        r.map_err(|_| SheetError::Internal("evaluation panicked".into()))
    }

    /// Bump the revision.
    pub(crate) fn touch(&mut self) {
        self.rev += 1;
    }

    /// Text of a reference rectangle (`Sheet2!A1:B3`), qualified when on another sheet.
    pub fn rect_text(&self, sheet: SheetId, rect: &Rect, from_sheet: SheetId) -> String {
        if sheet == from_sheet {
            format_rect(rect)
        } else {
            let name = self
                .sheet(sheet)
                .map(|s| quote_sheet_name(&s.name))
                .unwrap_or_else(|| "#REF!".into());
            format!("{}!{}", name, format_rect(rect))
        }
    }

    /// Validate a cell coordinate.
    pub(crate) fn check_coord(row: u32, col: u32) -> Result<(), SheetError> {
        if row >= MAX_ROWS || col >= MAX_COLS {
            return Err(SheetError::Invalid(format!(
                "cell ({row},{col}) is outside the grid"
            )));
        }
        Ok(())
    }

    /// Does the expression (a named-range definition) reference only valid targets?
    pub(crate) fn name_expr(&self, text: &str) -> Result<Expr, SheetError> {
        let src = text.strip_prefix('=').unwrap_or(text);
        let mut e = parse(src, Dialect::Excel).map_err(SheetError::Parse)?;
        self.bind(&mut e);
        let mut ok = true;
        e.walk(&mut |x| {
            if let Expr::Ref(r) = x
                && matches!(r.target, RefTarget::Invalid)
            {
                ok = false;
            }
        });
        if !ok {
            return Err(SheetError::Invalid("the reference is not valid".into()));
        }
        Ok(e)
    }
}

/// Convert an evaluation result into a storable cell value. References are dereferenced; blank results
/// become `0` as in Excel.
pub(crate) fn finalize(ctx: &mut EvalCtx, ev: Ev) -> Value {
    let v = match ev {
        Ev::Missing => Value::Number(0.0),
        Ev::R(a) if a.is_cell() => ctx.grid.value(a.sheet, a.r0, a.c0),
        Ev::R(a) => {
            if a.size() > crate::limits::MAX_SPILL_CELLS as u64 {
                return Value::Error(ErrorKind::Spill);
            }
            match ctx.area_array(a) {
                Ok(arr) => Value::array(arr),
                Err(e) => Value::Error(e),
            }
        }
        Ev::U(_) => Value::Error(ErrorKind::Value),
        Ev::V(v) => v,
    };
    match v {
        Value::Empty => Value::Number(0.0),
        Value::Array(a) => {
            if a.data().iter().any(|x| x.is_empty()) {
                Value::array(a.map(|x| {
                    if x.is_empty() {
                        Value::Number(0.0)
                    } else {
                        x.clone()
                    }
                }))
            } else {
                Value::Array(a)
            }
        }
        other => other,
    }
}

/// Workbook view used during evaluation.
pub(crate) struct WbGrid<'a> {
    wb: &'a Workbook,
    pending: Option<&'a FxHashSet<CellKey>>,
    pub(crate) stale: StdCell<bool>,
}

impl<'a> WbGrid<'a> {
    pub(crate) fn new(wb: &'a Workbook, pending: Option<&'a FxHashSet<CellKey>>) -> Self {
        WbGrid {
            wb,
            pending,
            stale: StdCell::new(false),
        }
    }
    fn note(&self, sheet: SheetId, r: u32, c: u32) {
        if let Some(p) = self.pending
            && !p.is_empty()
            && p.contains(&CellKey::new(sheet, r, c))
        {
            self.stale.set(true);
        }
    }
}

impl Grid for WbGrid<'_> {
    fn value(&self, sheet: SheetId, row: u32, col: u32) -> Value {
        self.note(sheet, row, col);
        self.wb.value(sheet, row, col)
    }
    fn for_each_nonempty(&self, area: &Area, f: &mut dyn FnMut(u32, u32, &Value)) {
        let Some(s) = self.wb.sheet(area.sheet) else {
            return;
        };
        let rect = area.rect();
        if let Some(p) = self.pending
            && !p.is_empty()
        {
            if rect.area() as usize <= p.len() * 4 {
                s.for_each_cell(&rect, |r, c, _| self.note(area.sheet, r, c));
            } else {
                for k in p.iter() {
                    if k.sheet() == area.sheet && rect.contains(k.row(), k.col()) {
                        self.stale.set(true);
                        break;
                    }
                }
            }
        }
        s.visit_values(&rect, f);
    }
    fn extent(&self, sheet: SheetId) -> (u32, u32) {
        self.wb.sheet(sheet).map(|s| s.extent()).unwrap_or((0, 0))
    }
    fn sheet_by_name(&self, name: &str) -> Option<SheetId> {
        self.wb.sheet_by_name(name).map(|s| s.id)
    }
    fn sheet_name(&self, id: SheetId) -> Option<String> {
        self.wb.sheet(id).map(|s| s.name.clone())
    }
    fn defined_name(&self, name: &str, _sheet: SheetId) -> Option<Arc<Expr>> {
        self.wb
            .names
            .get(&name.to_uppercase())
            .map(|n| n.expr.clone())
    }
    fn is_formula(&self, sheet: SheetId, row: u32, col: u32) -> bool {
        self.wb
            .sheet(sheet)
            .and_then(|s| s.cell(row, col))
            .is_some_and(|c| c.input.is_formula())
    }
    fn spill_range(&self, sheet: SheetId, row: u32, col: u32) -> Option<Area> {
        let s = self.wb.sheet(sheet)?;
        if let Some(r) = s.spills.get(&(row, col)) {
            return Some(Area {
                sheet,
                r0: r.r0,
                c0: r.c0,
                r1: r.r1,
                c1: r.c1,
            });
        }
        // A non-spilling formula cell is a 1×1 spill range.
        s.cell(row, col)
            .filter(|c| c.input.is_formula() && !c.value.is_error())
            .map(|_| Area::cell(sheet, row, col))
    }
    fn date1904(&self) -> bool {
        self.wb.calc.date1904
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_parsing() {
        assert_eq!(parse_input("", false), ParsedInput::Clear);
        assert_eq!(
            parse_input("12", false),
            ParsedInput::Value(Value::Number(12.0), None)
        );
        assert_eq!(
            parse_input("50%", false),
            ParsedInput::Value(Value::Number(0.5), Some("0%"))
        );
        assert_eq!(
            parse_input("$1,200", false),
            ParsedInput::Value(Value::Number(1200.0), Some("\"$\"#,##0.00"))
        );
        assert_eq!(
            parse_input("2024-01-15", false),
            ParsedInput::Value(Value::Number(45306.0), Some("yyyy-mm-dd"))
        );
        assert_eq!(
            parse_input("'=1", false),
            ParsedInput::Value(Value::text("=1"), None)
        );
        assert_eq!(
            parse_input("=A1+1", false),
            ParsedInput::Formula("A1+1".into())
        );
        assert_eq!(
            parse_input("true", false),
            ParsedInput::Value(Value::Bool(true), None)
        );
        assert_eq!(
            parse_input("#N/A", false),
            ParsedInput::Value(Value::Error(ErrorKind::NA), None)
        );
        assert_eq!(
            parse_input("hello", false),
            ParsedInput::Value(Value::text("hello"), None)
        );
        assert_eq!(
            parse_input("=", false),
            ParsedInput::Value(Value::text("="), None)
        );
    }

    #[test]
    fn names() {
        assert!(is_valid_name("Rate"));
        assert!(is_valid_name("_tax.rate"));
        assert!(!is_valid_name("A1"));
        assert!(!is_valid_name("1abc"));
        assert!(!is_valid_name("my name"));
        assert!(!is_valid_name("TRUE"));
    }
}
