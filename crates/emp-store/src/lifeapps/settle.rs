//! `settle::minimal_transfers` (SPEC §16.5 "Split expenses"): who pays whom so that every balance reaches zero.
//!
//! Greedy: the largest debtor pays the largest creditor, repeatedly. Amounts are settled in cents so rounding
//! never leaves a residue; the result has at most `n − 1` transfers.

use serde::Serialize;

/// One transfer.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Transfer {
    /// Payer.
    pub from: String,
    /// Payee.
    pub to: String,
    /// Amount (2 decimals).
    pub amount: f64,
}

/// Minimal transfers for net balances (`positive` = is owed money, `negative` = owes money).
#[must_use]
pub fn minimal_transfers(balances: &[(String, f64)]) -> Vec<Transfer> {
    let cents = |x: f64| (x * 100.0).round() as i64;
    let mut debtors: Vec<(String, i64)> = Vec::new();
    let mut creditors: Vec<(String, i64)> = Vec::new();
    for (name, b) in balances {
        if !b.is_finite() {
            continue;
        }
        let c = cents(*b);
        if c < 0 {
            debtors.push((name.clone(), -c));
        } else if c > 0 {
            creditors.push((name.clone(), c));
        }
    }
    let mut out = Vec::new();
    loop {
        debtors.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        creditors.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let (Some(d), Some(c)) = (debtors.first_mut(), creditors.first_mut()) else {
            break;
        };
        let amt = d.1.min(c.1);
        if amt == 0 {
            break;
        }
        out.push(Transfer {
            from: d.0.clone(),
            to: c.0.clone(),
            amount: amt as f64 / 100.0,
        });
        d.1 -= amt;
        c.1 -= amt;
        debtors.retain(|x| x.1 > 0);
        creditors.retain(|x| x.1 > 0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settles_everyone() {
        let b = vec![
            ("Ana".to_owned(), 60.0),
            ("Ben".to_owned(), -20.0),
            ("Cy".to_owned(), -40.0),
            ("Di".to_owned(), 0.0),
        ];
        let t = minimal_transfers(&b);
        assert_eq!(t.len(), 2);
        assert_eq!(
            t[0],
            Transfer {
                from: "Cy".into(),
                to: "Ana".into(),
                amount: 40.0
            }
        );
        assert_eq!(
            t[1],
            Transfer {
                from: "Ben".into(),
                to: "Ana".into(),
                amount: 20.0
            }
        );
        let uneven = minimal_transfers(&[
            ("a".into(), 33.34),
            ("b".into(), -16.67),
            ("c".into(), -16.67),
        ]);
        let paid: f64 = uneven.iter().map(|x| x.amount).sum();
        assert!((paid - 33.34).abs() < 1e-9);
        assert!(minimal_transfers(&[]).is_empty());
    }
}
