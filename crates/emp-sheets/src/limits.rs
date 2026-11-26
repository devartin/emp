//! Engine limits from SPEC §9.17 and grid limits from §14.1.
//!
//! Every limit is enforced by the engine itself; callers never need to
//! pre-validate input against these values (though they may, to give earlier
//! feedback).

/// Number of rows in a sheet (Excel limit).
pub const MAX_ROWS: u32 = 1_048_576;
/// Number of columns in a sheet (Excel limit).
pub const MAX_COLS: u32 = 16_384;
/// Maximum formula length in characters.
pub const MAX_FORMULA_LEN: usize = 8_192;
/// Maximum parser nesting depth.
pub const MAX_PARSE_DEPTH: usize = 256;
/// Maximum function-call nesting during evaluation.
pub const MAX_CALL_DEPTH: usize = 64;
/// Maximum number of arguments to one function call.
pub const MAX_ARGS: usize = 255;
/// Operation budget for one recalculation.
pub const MAX_OPS_PER_RECALC: u64 = 50_000_000;
/// Maximum number of cells a single dynamic array may spill into.
pub const MAX_SPILL_CELLS: usize = 1_000_000;
/// Maximum length (in characters) of a text result.
pub const MAX_TEXT_LEN: usize = 32_767;
/// Iterative calculation: maximum number of iterations.
pub const ITERATIVE_MAX_ITERATIONS: u32 = 100;
/// Iterative calculation: convergence threshold.
pub const ITERATIVE_MAX_CHANGE: f64 = 0.001;
/// Maximum nesting of `LET` scopes.
pub const MAX_LET_DEPTH: usize = 1_024;
/// Regex compiled-program size limit (bytes).
pub const REGEX_SIZE_LIMIT: usize = 1 << 20;
/// Regex lazy DFA size limit (bytes).
pub const REGEX_DFA_SIZE_LIMIT: usize = 2 << 20;
/// Maximum sheet-name length (Excel).
pub const MAX_SHEET_NAME_LEN: usize = 31;
/// Undo groups kept per workbook (§14.2).
pub const UNDO_GROUPS: usize = 200;
/// Default cap on imported cells (§9.16).
pub const IMPORT_CELL_CAP: usize = 5_000_000;
/// Message shown when a recalculation exceeds its operation budget.
pub const CALC_PAUSED_MESSAGE: &str = "Calculation paused — formula too expensive";

/// Functions that are rejected at parse time (§9.17).
pub const REJECTED_FUNCTIONS: &[&str] = &[
    "WEBSERVICE",
    "FILTERXML",
    "RTD",
    "CALL",
    "REGISTER.ID",
    "DDE",
    "EXEC",
];

/// Build a size-limited regex per §9.17.
pub fn build_regex(pattern: &str, case_insensitive: bool) -> Result<regex::Regex, regex::Error> {
    regex::RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
        .build()
}
