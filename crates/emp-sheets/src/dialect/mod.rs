//! Non-spreadsheet dialects sharing the engine's parser (decision D-12):
//!
//! * [`row`]: database property formulas (`Dialect::Row`, SPEC §14.6) — `prop("Price") * 2`,
//!   `prop("Tags").length()`, `prop("Rel").map(current.prop("Amount")).sum()`, static type checking,
//!   storage by property id (`prop("#<id>")`).
//! * [`metric`]: life-app metric and advisor expressions (`Dialect::Metric`, SPEC §14.7) —
//!   `metrics.savings_rate < 0.1 and answers.has_budget`, `{{fmt_money(metrics.buffer)}}` templates.

pub mod eval;
pub mod metric;
pub mod row;
pub mod typecheck;
pub mod value;

pub use value::{DateVal, RowValue};
