//! Transfer detection (§15.2 Transfers): opposite amounts of equal magnitude, in two different accounts the
//! user owns, within ±3 days, neither already linked. Transfers are excluded from income and spending.

use std::collections::HashSet;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Matching window in days.
pub const TRANSFER_DAYS: i64 = 3;

/// A transaction considered for transfer matching.
#[derive(Debug, Clone, PartialEq)]
pub struct TransferCandidate {
    /// Row id.
    pub id: String,
    /// Account id.
    pub account_id: String,
    /// Date.
    pub date: NaiveDate,
    /// Signed amount (in a common currency; cross-currency transfers are not auto-linked).
    pub amount: Decimal,
    /// Already linked to a counterpart.
    pub linked: bool,
}

/// A detected pair: `outflow` (negative) and `inflow` (positive).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPair {
    /// Negative side.
    pub outflow: String,
    /// Positive side.
    pub inflow: String,
}

/// Greedy matching: for each outflow (by date, then id), pick the closest-dated eligible inflow
/// (ties by id). Deterministic and one-to-one.
pub fn detect(
    candidates: &[TransferCandidate],
    owned_accounts: &HashSet<String>,
) -> Vec<TransferPair> {
    let eligible = |c: &&TransferCandidate| {
        !c.linked && !c.amount.is_zero() && owned_accounts.contains(&c.account_id)
    };
    let mut outs: Vec<&TransferCandidate> = candidates
        .iter()
        .filter(eligible)
        .filter(|c| c.amount < Decimal::ZERO)
        .collect();
    let ins: Vec<&TransferCandidate> = candidates
        .iter()
        .filter(eligible)
        .filter(|c| c.amount > Decimal::ZERO)
        .collect();
    outs.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.id.cmp(&b.id)));
    let mut used: HashSet<&str> = HashSet::new();
    let mut pairs = Vec::new();
    for o in outs {
        let best = ins
            .iter()
            .filter(|i| {
                !used.contains(i.id.as_str())
                    && i.account_id != o.account_id
                    && i.amount == -o.amount
                    && (i.date - o.date).num_days().abs() <= TRANSFER_DAYS
            })
            .min_by(|a, b| {
                (a.date - o.date)
                    .num_days()
                    .abs()
                    .cmp(&(b.date - o.date).num_days().abs())
                    .then_with(|| a.id.cmp(&b.id))
            });
        if let Some(i) = best {
            used.insert(i.id.as_str());
            pairs.push(TransferPair {
                outflow: o.id.clone(),
                inflow: i.id.clone(),
            });
        }
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: &str, acct: &str, date: &str, amount: &str, linked: bool) -> TransferCandidate {
        TransferCandidate {
            id: id.into(),
            account_id: acct.into(),
            date: date.parse().unwrap(),
            amount: amount.parse().unwrap(),
            linked,
        }
    }

    #[test]
    fn pairs_rules() {
        let owned: HashSet<String> = ["chk", "sav", "card"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let cands = vec![
            c("o1", "chk", "2026-01-10", "-500", false),
            c("i1", "sav", "2026-01-12", "500", false),
            c("i2", "sav", "2026-01-10", "500", false), // closer → preferred
            c("o2", "chk", "2026-01-20", "-200", false),
            c("i3", "chk", "2026-01-20", "200", false), // same account → no
            c("o3", "chk", "2026-02-01", "-75", false),
            c("i4", "ext", "2026-02-01", "75", false), // not owned → no
            c("o4", "card", "2026-03-01", "-30", false),
            c("i5", "sav", "2026-03-05", "30", false), // 4 days → no
            c("o5", "chk", "2026-04-01", "-10", true),
            c("i6", "sav", "2026-04-01", "10", false), // other side linked → no
        ];
        let p = detect(&cands, &owned);
        assert_eq!(
            p,
            vec![TransferPair {
                outflow: "o1".into(),
                inflow: "i2".into()
            }]
        );
    }
}
