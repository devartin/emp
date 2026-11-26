//! # emp-sheets — the EMP formula engine (SPEC §14, limits §9.17)
//!
//! * [`parser`] / [`lexer`] / [`printer`]: one Pratt parser for the Excel, Row (database) and Metric
//!   dialects; ASTs print back to text so that `parse(print(ast)) == ast`.
//! * [`value`]: the value model with Excel coercion and ordering; [`datetime`]: Excel date serials.
//! * [`eval`] + [`functions`]: the evaluator with array broadcasting and the §14.3 function registry.
//! * [`workbook`]: sheets with sparse cells, styles, names, a dependency graph with incremental
//!   recalculation, spills, cycle detection, structural edits and undo; [`workbook::persist`] is the
//!   serde format stored by `emp-store`.
//! * [`numfmt`]: Excel number formats; all display strings are produced in Rust.
//! * [`dialect`]: `Dialect::Row` (database formulas, §14.6) and `Dialect::Metric` (§14.7).
//! * `io` (feature, default on): xlsx import (calamine) and xlsx/csv export (§14.5).
//!
//! The engine is pure: the clock, randomness and market data come from a [`host::Host`]. Every public
//! entry point that parses or evaluates is panic-safe (`catch_unwind`).

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod address;
pub mod ast;
pub mod criteria;
pub mod datetime;
pub mod dialect;
pub mod eval;
pub mod functions;
pub mod host;
#[cfg(feature = "io")]
pub mod io;
pub mod lexer;
pub mod limits;
pub mod numfmt;
pub mod parser;
pub mod printer;
pub mod value;
pub mod workbook;

pub use address::{CellKey, Rect, SheetId, col_to_letters, format_a1, letters_to_col, parse_a1};
pub use ast::Expr;
pub use functions::{FunctionInfo, function_infos};
pub use host::{CacheHost, ExternalKey, ExternalValue, Host};
pub use numfmt::{Formatted, NumLocale, format_value};
pub use parser::{Dialect, ParseError, parse};
pub use printer::print_excel;
pub use value::{Array, ErrorKind, Value};
pub use workbook::ops::{Axis, CellEdit, CellError, ClearWhat, EditOutcome};
pub use workbook::packed::{CellInfo, PackedCells, RangeData, SheetInfo};
pub use workbook::persist::WorkbookFile;
pub use workbook::style::{CellStyle, StylePatch};
pub use workbook::tools::{CopyResult, FillMode, LintFinding, PasteMode, SortKey};
pub use workbook::{CalcSettings, RecalcReport, SheetError, Workbook};

/// Evaluate a formula in scalar mode (no workbook): `eval_scalar("=1+2")` → `3`.
pub fn eval_scalar(formula: &str) -> Result<Value, SheetError> {
    Workbook::empty(std::sync::Arc::new(CacheHost::new())).eval_formula(None, formula)
}
