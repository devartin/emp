//! Dividends (§15.7): trailing twelve months, forward twelve months (last regular dividend × its frequency,
//! scaled to the shares held now) and a monthly calendar of paid and projected income.

use std::collections::{BTreeMap, HashMap};

use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::InvTxnType;
use super::lots::IncomeEvent;
use crate::period::{YearMonth, add_months};

/// Per-security forward estimate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardDividend {
    /// Security.
    pub security: String,
    /// Payments per year inferred from history (1, 2, 4 or 12).
    pub frequency: u32,
    /// Last regular payment per share.
    pub last_per_share: Decimal,
    /// Forward 12-month estimate.
    pub forward_12m: Decimal,
    /// Last payment date.
    pub last_date: NaiveDate,
}

/// Dividend summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividendSummary {
    /// Paid in the trailing 365 days.
    pub ttm: Decimal,
    /// Forward 12 months.
    pub forward_12m: Decimal,
    /// Per-security estimates.
    pub by_security: Vec<ForwardDividend>,
}

fn frequency(dates: &[NaiveDate]) -> u32 {
    if dates.len() < 2 {
        return 1;
    }
    let mut gaps: Vec<i64> = dates.windows(2).map(|w| (w[1] - w[0]).num_days()).collect();
    gaps.sort_unstable();
    let med = gaps[gaps.len() / 2];
    match med {
        0..=45 => 12,
        46..=135 => 4,
        136..=270 => 2,
        _ => 1,
    }
}

/// Dividend events only (cash and reinvested), oldest first.
fn dividends(events: &[IncomeEvent]) -> Vec<&IncomeEvent> {
    let mut v: Vec<&IncomeEvent> = events
        .iter()
        .filter(|e| e.kind == InvTxnType::Dividend)
        .collect();
    v.sort_by_key(|e| e.date);
    v
}

/// Summarises dividends as of `today`, with `held_now` = current shares per security.
///
/// "Regular" means not a special dividend: a payment more than 3× the median of that security's payments
/// per share is treated as special and skipped for the forward estimate.
pub fn summary(
    events: &[IncomeEvent],
    held_now: &HashMap<String, Decimal>,
    today: NaiveDate,
) -> DividendSummary {
    let divs = dividends(events);
    let ttm = divs
        .iter()
        .filter(|e| e.date <= today && (today - e.date).num_days() < 365)
        .map(|e| e.amount)
        .sum();
    let mut by_sec: BTreeMap<&str, Vec<&IncomeEvent>> = BTreeMap::new();
    for e in &divs {
        by_sec.entry(e.security.as_str()).or_default().push(e);
    }
    let mut out = Vec::new();
    let mut fwd = Decimal::ZERO;
    for (sec, evs) in by_sec {
        let per_share: Vec<Decimal> = evs
            .iter()
            .map(|e| {
                if e.qty_held.is_zero() {
                    e.amount
                } else {
                    e.amount / e.qty_held
                }
            })
            .collect();
        let med = crate::money::median(&per_share).unwrap_or_default();
        let regular: Vec<(usize, &IncomeEvent)> = evs
            .iter()
            .copied()
            .enumerate()
            .filter(|(i, _)| med.is_zero() || per_share[*i] <= med * Decimal::from(3))
            .collect();
        let Some(&(li, last)) = regular.last() else {
            continue;
        };
        // Use the trailing two years of regular payments to infer frequency.
        let recent: Vec<NaiveDate> = regular
            .iter()
            .map(|(_, e)| e.date)
            .filter(|d| (last.date - *d).num_days() <= 730)
            .collect();
        let freq = frequency(&recent);
        // Stale payers (no regular payment for 1.5 periods) are assumed to have stopped.
        let period_days = 365 / i64::from(freq);
        if (today - last.date).num_days() > period_days * 3 / 2 + 15 {
            continue;
        }
        let held = held_now.get(sec).copied().unwrap_or_default();
        let lps = per_share[li];
        let f12 = if last.qty_held.is_zero() {
            last.amount * Decimal::from(freq)
        } else {
            lps * Decimal::from(freq) * held
        };
        fwd += f12;
        out.push(ForwardDividend {
            security: sec.to_string(),
            frequency: freq,
            last_per_share: lps,
            forward_12m: f12,
            last_date: last.date,
        });
    }
    DividendSummary {
        ttm,
        forward_12m: fwd,
        by_security: out,
    }
}

/// A calendar month row (IPC `portfolio_dividends`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividendMonth {
    /// Month (`YYYY-MM`).
    pub month: YearMonth,
    /// Paid.
    pub paid: Decimal,
    /// Projected (future months only).
    pub projected: Decimal,
}

/// Paid and projected dividends per month of `year`. Projections step each payer's last regular date by its
/// frequency, for dates after `today`.
pub fn calendar(
    events: &[IncomeEvent],
    held_now: &HashMap<String, Decimal>,
    year: i32,
    today: NaiveDate,
) -> Vec<DividendMonth> {
    let mut months: Vec<DividendMonth> = (1..=12)
        .filter_map(|m| YearMonth::new(year, m).ok())
        .map(|m| DividendMonth {
            month: m,
            paid: Decimal::ZERO,
            projected: Decimal::ZERO,
        })
        .collect();
    for e in dividends(events)
        .into_iter()
        .filter(|e| e.date.year() == year && e.date <= today)
    {
        months[e.date.month0() as usize].paid += e.amount;
    }
    let s = summary(events, held_now, today);
    for f in s.by_security {
        let step = 12 / f.frequency.max(1) as i32;
        let per_payment = f.forward_12m / Decimal::from(f.frequency.max(1));
        let mut d = f.last_date;
        for _ in 0..24 {
            d = add_months(d, step);
            if d.year() > year {
                break;
            }
            if d > today && d.year() == year {
                months[d.month0() as usize].projected += per_payment;
            }
        }
    }
    months
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::dec;

    fn ev(date: &str, sec: &str, amount: &str, held: &str) -> IncomeEvent {
        IncomeEvent {
            txn_id: date.into(),
            date: date.parse().unwrap(),
            account_id: "a".into(),
            security: sec.into(),
            kind: InvTxnType::Dividend,
            amount: dec(amount),
            reinvested: false,
            qty_held: dec(held),
        }
    }

    #[test]
    fn quarterly_payer_with_special() {
        let events = vec![
            ev("2025-03-15", "KO", "48.5", "100"),
            ev("2025-06-15", "KO", "48.5", "100"),
            ev("2025-09-15", "KO", "48.5", "100"),
            ev("2025-11-01", "KO", "500", "100"), // special
            ev("2025-12-15", "KO", "51", "100"),
        ];
        let held: HashMap<String, Decimal> = [("KO".to_string(), dec("120"))].into();
        let today = "2026-01-10".parse().unwrap();
        let s = summary(&events, &held, today);
        assert_eq!(s.ttm, dec("696.5"));
        assert_eq!(s.by_security[0].frequency, 4);
        // 0.51 × 4 × 120
        assert_eq!(s.forward_12m, dec("244.80"));
        let cal = calendar(&events, &held, 2026, today);
        assert_eq!(cal.len(), 12);
        assert_eq!(cal[2].projected, dec("61.20"));
        assert_eq!(cal[0].projected, Decimal::ZERO);
        let cal25 = calendar(&events, &held, 2025, today);
        assert_eq!(cal25[10].paid, dec("500"));
    }

    #[test]
    fn stopped_payer_is_dropped() {
        let events = vec![
            ev("2024-01-15", "X", "10", "10"),
            ev("2024-04-15", "X", "10", "10"),
        ];
        let s = summary(&events, &HashMap::new(), "2026-01-01".parse().unwrap());
        assert!(s.by_security.is_empty());
        assert_eq!(s.ttm, Decimal::ZERO);
    }
}
