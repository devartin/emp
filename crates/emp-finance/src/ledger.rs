//! Engine-side ledger types. `emp-app` maps database rows to these by semantic role (§15.0).
//!
//! Sign convention: amounts are signed from the account holder's point of view — inflows positive,
//! outflows negative. Debt accounts therefore carry **negative** balances while money is owed.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::money::{Currency, sum};

/// Account type (`acct.type`), matching the Money HQ `accounts` question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountType {
    /// Checking / current account.
    Checking,
    /// Savings account.
    Savings,
    /// Credit card.
    CreditCard,
    /// Student loan.
    StudentLoan,
    /// Auto loan.
    AutoLoan,
    /// Mortgage.
    Mortgage,
    /// Personal loan.
    PersonalLoan,
    /// Brokerage / retirement account.
    Investment,
    /// Physical cash.
    Cash,
    /// Any other asset.
    OtherAsset,
    /// Any other liability.
    OtherLiability,
}

impl AccountType {
    /// Whether this is a debt account (balances are liabilities).
    pub fn is_liability(self) -> bool {
        matches!(
            self,
            Self::CreditCard
                | Self::StudentLoan
                | Self::AutoLoan
                | Self::Mortgage
                | Self::PersonalLoan
                | Self::OtherLiability
        )
    }

    /// Whether money in this account is spendable cash (used by forecasts).
    pub fn is_liquid(self) -> bool {
        matches!(self, Self::Checking | Self::Savings | Self::Cash)
    }
}

/// An account (`acct.*` roles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Row id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Account type.
    #[serde(rename = "type")]
    pub kind: AccountType,
    /// Account currency.
    pub currency: Currency,
    /// Opening balance (signed; debts negative).
    #[serde(default)]
    pub opening_balance: Decimal,
    /// Date of the opening balance (transactions before it are ignored for balances).
    #[serde(default)]
    pub opening_date: Option<NaiveDate>,
    /// APR in percent (e.g. `"22.99"`).
    #[serde(default)]
    pub apr_pct: Option<Decimal>,
    /// Minimum monthly payment.
    #[serde(default)]
    pub min_payment: Option<Decimal>,
    /// Credit limit.
    #[serde(default)]
    pub credit_limit: Option<Decimal>,
    /// Whether the account is on budget.
    #[serde(default = "yes")]
    pub on_budget: bool,
    /// Low-balance alert threshold.
    #[serde(default)]
    pub low_threshold: Option<Decimal>,
    /// Closed accounts are excluded from snapshots.
    #[serde(default)]
    pub closed: bool,
}

fn yes() -> bool {
    true
}

/// A transaction (`txn.*` roles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Txn {
    /// Row id.
    pub id: String,
    /// Account row id.
    pub account_id: String,
    /// Transaction date.
    pub date: NaiveDate,
    /// Signed amount in the account currency.
    pub amount: Decimal,
    /// Normalised payee name.
    #[serde(default)]
    pub payee: String,
    /// Raw bank description.
    #[serde(default)]
    pub raw: String,
    /// Memo.
    #[serde(default)]
    pub memo: String,
    /// Category row id.
    #[serde(default)]
    pub category_id: Option<String>,
    /// Linked transfer counterpart row id.
    #[serde(default)]
    pub transfer_id: Option<String>,
    /// Import identifier (FITID or hash).
    #[serde(default)]
    pub import_id: Option<String>,
    /// Parent row when this is a split line. Parents with splits are excluded from sums.
    #[serde(default)]
    pub split_parent: Option<String>,
    /// Whether this row is a split parent (its children carry the amounts).
    #[serde(default)]
    pub has_splits: bool,
}

impl Txn {
    /// Whether the row is linked as a transfer (excluded from income and spending).
    pub fn is_transfer(&self) -> bool {
        self.transfer_id.is_some()
    }

    /// Whether the row contributes to sums (split parents do not; their children do).
    pub fn counts(&self) -> bool {
        !self.has_splits
    }
}

/// A category (`cat.*` roles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    /// Row id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Group name (`Needs`, `Wants`, `Savings & Debt`, `Income`, ...).
    #[serde(default)]
    pub group: String,
    /// Whether this is an income category.
    #[serde(default)]
    pub is_income: bool,
    /// Essential flag.
    #[serde(default)]
    pub essential: bool,
    /// Rollover flag.
    #[serde(default)]
    pub rollover: bool,
    /// Whether spending is discretionary/variable (used by the forecast).
    #[serde(default = "yes")]
    pub variable: bool,
    /// Whether outflows here are savings or investment contributions (count as saving, not spending).
    #[serde(default)]
    pub is_saving: bool,
}

/// The opening balance as the ledger counts it. A card or loan's opening balance is the amount owed, entered
/// either way round — the setup wizard and sample data store it as a positive "what you owe", hand-built ledgers
/// often as a negative balance — and either way it is a debt: `−|opening|`, because debts carry negative balances
/// (§15.5; card purchases are negative amounts that deepen it). Other accounts keep their sign. The browser mock's
/// `readLedger` and the frontend ledger apply the same rule.
#[must_use]
pub fn opening_as_counted(kind: AccountType, opening: Decimal) -> Decimal {
    if kind.is_liability() {
        -opening.abs()
    } else {
        opening
    }
}

/// Balance of `account` as of `date` (inclusive): opening balance plus every counted transaction
/// on or after the opening date.
pub fn balance_as_of(account: &Account, txns: &[Txn], date: NaiveDate) -> Decimal {
    account.opening_balance
        + sum(txns
            .iter()
            .filter(|t| t.account_id == account.id && t.counts() && t.date <= date)
            .filter(|t| account.opening_date.is_none_or(|od| t.date >= od))
            .map(|t| t.amount))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::txn;

    #[test]
    fn liability_openings_are_amounts_owed_either_sign() {
        use rust_decimal::Decimal;
        let d = |s: &str| s.parse::<Decimal>().unwrap();
        assert_eq!(
            opening_as_counted(AccountType::CreditCard, d("1800")),
            d("-1800")
        );
        assert_eq!(
            opening_as_counted(AccountType::StudentLoan, d("-950")),
            d("-950")
        );
        assert_eq!(
            opening_as_counted(AccountType::Checking, d("-50")),
            d("-50")
        );
        assert_eq!(opening_as_counted(AccountType::Savings, d("400")), d("400"));
    }

    #[test]
    fn balance() {
        let a = Account {
            id: "a".into(),
            name: "Checking".into(),
            kind: AccountType::Checking,
            currency: Currency::new("USD").unwrap(),
            opening_balance: "100".parse().unwrap(),
            opening_date: Some("2026-01-01".parse().unwrap()),
            apr_pct: None,
            min_payment: None,
            credit_limit: None,
            on_budget: true,
            low_threshold: None,
            closed: false,
        };
        let mut split_parent = txn("p", "a", "2026-01-05", "-50");
        split_parent.has_splits = true;
        let txns = vec![
            txn("0", "a", "2025-12-31", "-999"),
            txn("1", "a", "2026-01-02", "-30"),
            split_parent,
            txn("3", "a", "2026-02-01", "10"),
            txn("4", "b", "2026-01-02", "-1"),
        ];
        assert_eq!(
            balance_as_of(&a, &txns, "2026-01-31".parse().unwrap()),
            "70".parse().unwrap()
        );
        assert!(AccountType::Mortgage.is_liability());
        assert!(!AccountType::Savings.is_liability());
    }
}
