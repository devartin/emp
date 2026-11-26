//! Tax engine (§15.6): packs, estimator, estimated quarterly payments, deadlines, record retention and the
//! document checklist. All figures surfaced to users are estimates and must be shown with
//! [`pack::TaxPack::disclaimer`]; never present results as "you owe".

pub mod deadlines;
pub mod documents;
pub mod engine;
pub mod estimated;
pub mod pack;
pub mod retention;

pub use engine::{TaxEstimate, TaxInput, estimate};
pub use pack::{TaxPack, builtin, builtin_packs};
