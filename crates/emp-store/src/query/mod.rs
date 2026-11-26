//! The database query engine (SPEC §8, §14.6): typed cell values, filters (`and`/`or` up to 3 levels), multi-level
//! sorts with natural, diacritic-insensitive collation, grouping, footer and group aggregates, rollups, Row-dialect
//! formulas (emp-sheets), chart aggregation and windowed results.
//!
//! * [`model`]: DTOs and payloads (`DbSchema`, `Property`, `CellValue`, `View`, `Filter`, …).
//! * [`config`]: typed views of property configuration.
//! * [`cells`]: projections, validation of user writes and text parsing.
//! * [`compute`]: [`compute::World`] (decoded rows of a database and its related databases) and the memoised
//!   [`compute::Evaluator`] of formula / rollup / timestamp columns.
//! * [`filter`], [`sort`], [`group`], [`agg`], [`chart`]: the pipeline stages; [`engine::run`] composes them.
//! * [`dates`]: the vault's local calendar (time zone, week start, relative ranges, buckets).
//!
//! The store-facing commands (`db_query`, `db_chart_data`, …) are `Store` methods in `crate::repo::rows`.

pub mod agg;
pub mod cells;
pub mod chart;
pub mod compute;
pub mod config;
pub mod dates;
pub mod engine;
pub mod filter;
pub mod group;
pub mod model;
pub mod sort;

pub use model::*;
