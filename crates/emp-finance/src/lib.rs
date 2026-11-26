//! # emp-finance
//!
//! The EMP finance engine (SPEC §15). It is **pure**: no IO, no clock reads, no store dependency.
//! `emp-app` loads rows from `emp-store` by semantic role (§15.0), converts them into the input types
//! here, and writes results back. Every "today" is passed in by the caller.
//!
//! Money is [`rust_decimal::Decimal`] (D-21) serialised as decimal strings with scale ≤ 8. Ratios and
//! chart series use `f64`.
//!
//! Module map:
//! - Core: [`money`], [`fx`], [`period`], [`calendar`], [`ledger`]
//! - Import: [`import`] (sniff, CSV, OFX/QFX, QIF), [`payee`], [`dedupe`], [`transfers`], [`rules`]
//! - Planning: [`budget`], [`recurring`], [`debt`], [`amortize`], [`forecast`], [`networth`], [`goals`],
//!   [`metrics`], [`insights`]
//! - Investing: [`portfolio`] (lots, performance, allocation, rebalance, dividends, risk, indicators), [`decimate`]
//! - Tax: [`tax`] (packs, engine, estimated payments, deadlines, retention, documents)

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod amortize;
pub mod budget;
pub mod calendar;
pub mod debt;
pub mod decimate;
pub mod dedupe;
pub mod error;
pub mod forecast;
pub mod fx;
pub mod goals;
pub mod import;
pub mod insights;
pub mod ledger;
pub mod metrics;
pub mod money;
pub mod networth;
pub mod payee;
pub mod period;
pub mod portfolio;
pub mod recurring;
pub mod rng;
pub mod rules;
pub mod tax;
pub mod transfers;

pub use error::{FinanceError, Result};
pub use money::{Currency, Money};
pub use rust_decimal::Decimal;

#[cfg(test)]
pub(crate) mod testutil {
    use crate::ledger::Txn;

    pub(crate) fn txn(id: &str, acct: &str, date: &str, amount: &str) -> Txn {
        Txn {
            id: id.into(),
            account_id: acct.into(),
            date: date.parse().expect("date"),
            amount: amount.parse().expect("amount"),
            payee: String::new(),
            raw: String::new(),
            memo: String::new(),
            category_id: None,
            transfer_id: None,
            import_id: None,
            split_parent: None,
            has_splits: false,
        }
    }

    pub(crate) fn dec(s: &str) -> rust_decimal::Decimal {
        s.parse().expect("decimal")
    }
}
