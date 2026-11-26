//! Net worth (§15.5): snapshots in the base currency and backfill from transactions.
//!
//! Positive balances are assets; negative balances (debts carry negative balances) are liabilities.
//! Foreign-currency balances are converted with [`crate::fx`]; accounts without a rate are reported in
//! `missing_rates` and excluded rather than guessed.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::fx::{FxRates, convert};
use crate::ledger::{Account, Txn, balance_as_of};
use crate::money::{Currency, Money, to_f64};
use crate::period::YearMonth;

/// A net-worth snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Month.
    pub month: YearMonth,
    /// As-of date (month end, or today for the current month).
    pub as_of: NaiveDate,
    /// Total assets (≥ 0).
    pub assets: Decimal,
    /// Total liabilities (≥ 0).
    pub liabilities: Decimal,
    /// `assets − liabilities`.
    pub net_worth: Decimal,
    /// Base currency.
    pub currency: Currency,
    /// Accounts excluded for lack of an FX rate.
    pub missing_rates: Vec<String>,
    /// `"computed"` or `"backfill"`.
    pub source: String,
}

/// An account balance to include in a snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountBalance {
    /// Account id.
    pub account_id: String,
    /// Balance in the account currency (debts negative).
    pub balance: Money,
}

/// Builds a snapshot from balances.
pub fn snapshot(
    month: YearMonth,
    as_of: NaiveDate,
    balances: &[AccountBalance],
    base: &Currency,
    rates: &FxRates,
) -> Snapshot {
    let mut assets = Decimal::ZERO;
    let mut liabilities = Decimal::ZERO;
    let mut missing = Vec::new();
    for b in balances {
        let v = if &b.balance.currency == base {
            b.balance.amount
        } else {
            match convert(&b.balance, base, as_of, rates) {
                Ok(c) => c.converted.amount,
                Err(_) => {
                    missing.push(b.account_id.clone());
                    continue;
                }
            }
        };
        if v >= Decimal::ZERO {
            assets += v;
        } else {
            liabilities -= v;
        }
    }
    Snapshot {
        month,
        as_of,
        assets,
        liabilities,
        net_worth: assets - liabilities,
        currency: base.clone(),
        missing_rates: missing,
        source: "computed".into(),
    }
}

/// Reconstructs month-end snapshots for `from..=to` from opening balances and transactions. The current
/// month (containing `today`) is valued as of `today`. Closed accounts are included (their history counts).
pub fn backfill_from_transactions(
    accounts: &[Account],
    txns: &[Txn],
    from: YearMonth,
    to: YearMonth,
    today: NaiveDate,
    base: &Currency,
    rates: &FxRates,
) -> Vec<Snapshot> {
    let mut out = Vec::new();
    let mut m = from;
    let mut guard = 0;
    while m <= to && guard < 1200 {
        guard += 1;
        let as_of = if YearMonth::of(today) == m {
            today
        } else {
            m.last_day()
        };
        if as_of > today {
            break;
        }
        let balances: Vec<AccountBalance> = accounts
            .iter()
            .filter(|a| a.opening_date.is_none_or(|od| od <= as_of))
            .map(|a| AccountBalance {
                account_id: a.id.clone(),
                balance: Money::new(balance_as_of(a, txns, as_of), a.currency.clone()),
            })
            .collect();
        let mut s = snapshot(m, as_of, &balances, base, rates);
        s.source = "backfill".into();
        out.push(s);
        m = m.next();
    }
    out
}

/// Months that need an automatic snapshot: every month from the latest existing snapshot (exclusive) to the
/// current month (inclusive). Used on first unlock of each month.
pub fn missing_months(existing: &[YearMonth], today: NaiveDate) -> Vec<YearMonth> {
    let current = YearMonth::of(today);
    match existing.iter().max() {
        None => vec![current],
        Some(&last) if last >= current => Vec::new(),
        Some(&last) => {
            let mut v = Vec::new();
            let mut m = last.next();
            while m <= current {
                v.push(m);
                m = m.next();
            }
            v
        }
    }
}

/// Chart series for `finance_networth_series`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthSeries {
    /// Month labels (`YYYY-MM`).
    pub t: Vec<String>,
    /// Assets.
    pub assets: Vec<f64>,
    /// Liabilities.
    pub liabilities: Vec<f64>,
    /// Net.
    pub net: Vec<f64>,
    /// Currency.
    pub currency: String,
}

/// Converts snapshots (any order) into a chart series sorted by month.
pub fn series(snaps: &[Snapshot], base: &Currency) -> NetWorthSeries {
    let mut s: Vec<&Snapshot> = snaps.iter().collect();
    s.sort_by_key(|x| x.month);
    NetWorthSeries {
        t: s.iter().map(|x| x.month.to_string()).collect(),
        assets: s.iter().map(|x| to_f64(x.assets)).collect(),
        liabilities: s.iter().map(|x| to_f64(x.liabilities)).collect(),
        net: s.iter().map(|x| to_f64(x.net_worth)).collect(),
        currency: base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::RateTable;
    use crate::ledger::AccountType;
    use crate::testutil::{dec, txn};

    fn acct(id: &str, kind: AccountType, cur: &str, opening: &str) -> Account {
        Account {
            id: id.into(),
            name: id.into(),
            kind,
            currency: Currency::new(cur).unwrap(),
            opening_balance: dec(opening),
            opening_date: Some("2026-01-01".parse().unwrap()),
            apr_pct: None,
            min_payment: None,
            credit_limit: None,
            on_budget: true,
            low_threshold: None,
            closed: false,
        }
    }

    #[test]
    fn snapshot_with_fx_and_missing() {
        let usd = Currency::new("USD").unwrap();
        let mut fx = FxRates::new();
        fx.insert(RateTable {
            base: usd.clone(),
            date: "2026-01-01".parse().unwrap(),
            rates: [("EUR".to_string(), dec("0.5"))].into(),
            source: "test".into(),
        });
        let b = vec![
            AccountBalance {
                account_id: "chk".into(),
                balance: Money::parse("1000", "USD").unwrap(),
            },
            AccountBalance {
                account_id: "eur".into(),
                balance: Money::parse("100", "EUR").unwrap(),
            },
            AccountBalance {
                account_id: "card".into(),
                balance: Money::parse("-300", "USD").unwrap(),
            },
            AccountBalance {
                account_id: "gbp".into(),
                balance: Money::parse("50", "GBP").unwrap(),
            },
        ];
        let s = snapshot(
            "2026-01".parse().unwrap(),
            "2026-01-31".parse().unwrap(),
            &b,
            &usd,
            &fx,
        );
        assert_eq!(s.assets, dec("1200"));
        assert_eq!(s.liabilities, dec("300"));
        assert_eq!(s.net_worth, dec("900"));
        assert_eq!(s.missing_rates, vec!["gbp"]);
    }

    #[test]
    fn backfill_and_missing_months() {
        let usd = Currency::new("USD").unwrap();
        let accounts = vec![
            acct("chk", AccountType::Checking, "USD", "500"),
            acct("card", AccountType::CreditCard, "USD", "-100"),
        ];
        let txns = vec![
            txn("1", "chk", "2026-01-15", "1000"),
            txn("2", "card", "2026-02-10", "-200"),
            txn("3", "chk", "2026-03-02", "-50"),
        ];
        let snaps = backfill_from_transactions(
            &accounts,
            &txns,
            "2026-01".parse().unwrap(),
            "2026-06".parse().unwrap(),
            "2026-03-05".parse().unwrap(),
            &usd,
            &FxRates::new(),
        );
        assert_eq!(snaps.len(), 3);
        assert_eq!(snaps[0].net_worth, dec("1400"));
        assert_eq!(snaps[1].liabilities, dec("300"));
        assert_eq!(snaps[2].as_of.to_string(), "2026-03-05");
        assert_eq!(snaps[2].net_worth, dec("1150"));
        let ser = series(&snaps, &usd);
        assert_eq!(ser.t, vec!["2026-01", "2026-02", "2026-03"]);
        assert_eq!(
            missing_months(&["2026-01".parse().unwrap()], "2026-03-05".parse().unwrap()).len(),
            2
        );
        assert!(
            missing_months(&["2026-03".parse().unwrap()], "2026-03-05".parse().unwrap()).is_empty()
        );
        assert_eq!(
            missing_months(&[], "2026-03-05".parse().unwrap()),
            vec!["2026-03".parse().unwrap()]
        );
    }
}
