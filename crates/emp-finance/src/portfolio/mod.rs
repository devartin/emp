//! Portfolio engine (§15.7): lots, holdings, performance, allocation, rebalancing, dividends, risk and
//! indicators. EMP never places trades; the rebalance planner only proposes them.

pub mod alloc;
pub mod dividends;
pub mod holdings;
pub mod indicators;
pub mod lots;
pub mod perf;
pub mod rebalance;
pub mod risk;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Investment transaction type (`inv.type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvTxnType {
    /// Purchase.
    Buy,
    /// Sale.
    Sell,
    /// Cash dividend.
    Dividend,
    /// Dividend reinvested into shares.
    Reinvest,
    /// Account or transaction fee.
    Fee,
    /// Stock split (`ratio` new shares per old share).
    Split,
    /// Shares arriving from another account (basis kept).
    TransferIn,
    /// Shares leaving to another account (basis kept).
    TransferOut,
    /// Return of capital (reduces basis).
    ReturnOfCapital,
    /// Interest income.
    Interest,
}

/// An investment transaction (`inv.*` roles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvTxn {
    /// Row id.
    pub id: String,
    /// Trade date.
    pub date: NaiveDate,
    /// Type.
    #[serde(rename = "type")]
    pub kind: InvTxnType,
    /// Investment account id.
    pub account_id: String,
    /// Security key (`AAPL:XNAS`); may be empty for account-level fees and interest.
    #[serde(default)]
    pub security: String,
    /// Quantity (positive).
    #[serde(default)]
    pub qty: Option<Decimal>,
    /// Price per share.
    #[serde(default)]
    pub price: Option<Decimal>,
    /// Cash amount (positive), e.g. the dividend or the gross trade value.
    #[serde(default)]
    pub amount: Option<Decimal>,
    /// Fees and commissions (positive).
    #[serde(default)]
    pub fees: Decimal,
    /// Split ratio (new shares per old share: `2` for 2-for-1, `0.1` for 1-for-10).
    #[serde(default)]
    pub ratio: Option<Decimal>,
    /// Original acquisition date for `transfer_in`.
    #[serde(default)]
    pub acquired: Option<NaiveDate>,
    /// Cost basis for `transfer_in` (total).
    #[serde(default)]
    pub basis: Option<Decimal>,
}

/// Cost-basis method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostMethod {
    /// First in, first out.
    #[default]
    Fifo,
    /// Average cost (pooled per account and security).
    AverageCost,
}

/// Account tax treatment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaxTreatment {
    /// Taxable brokerage.
    #[default]
    Taxable,
    /// Tax-deferred (401k, traditional IRA).
    Deferred,
    /// Tax-free (Roth, HSA).
    Free,
}

impl TaxTreatment {
    /// Whether sells here have no current tax consequence.
    pub fn is_advantaged(self) -> bool {
        !matches!(self, TaxTreatment::Taxable)
    }
}

/// Long-term holding threshold in days from `packs/accounts/us.json` (more than 365 days).
pub const US_LONG_TERM_DAYS: i64 = 365;
