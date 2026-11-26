//! Cash-flow forecast (§15.5 `forecast::cashflow`).
//!
//! * Recurring items are expanded over the horizon (default 90 days). Schedules here cover the Money HQ
//!   cadences; the app may instead pass pre-expanded dates (from `rrule` in `emp-store::life`) via
//!   [`Schedule::Dates`].
//! * Discretionary daily spend is the median of daily non-recurring spend in variable categories over the
//!   trailing 90 days.
//! * The optional p10/p90 band comes from bootstrap resamples (default 1,000) of those 90 daily spends,
//!   seeded by the caller (`rng::seed_from(&[vault_id, month])`).
//! * A breach is reported when an account's projected balance falls below its low-balance threshold, with
//!   the top three outflows leading up to it.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Datelike, Duration, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};
use crate::ledger::{Category, Txn};
use crate::money::{median, to_f64};
use crate::period::add_months_anchored;
use crate::rng::SplitMix64;

/// Default horizon.
pub const DEFAULT_HORIZON_DAYS: u32 = 90;
/// Maximum horizon.
pub const MAX_HORIZON_DAYS: u32 = 730;
/// Default bootstrap resamples.
pub const DEFAULT_SIMULATIONS: usize = 1000;
/// Cap on expanded occurrences per item.
pub const MAX_OCCURRENCES: usize = 5000;

/// Schedule frequency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Frequency {
    /// Every `interval` days.
    Daily,
    /// Every `interval` weeks.
    Weekly,
    /// Every `interval` months (anchored on the anchor's day of month).
    Monthly,
    /// Every `interval` years.
    Yearly,
}

/// A recurring schedule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    /// A single date.
    Once {
        /// Date.
        date: NaiveDate,
    },
    /// A regular cadence starting at `anchor`.
    Every {
        /// Frequency.
        freq: Frequency,
        /// Interval (≥ 1).
        interval: u32,
        /// First occurrence.
        anchor: NaiveDate,
        /// Last allowed date.
        #[serde(default)]
        until: Option<NaiveDate>,
    },
    /// Twice a month on two days (e.g. 1st and 15th), from `anchor` on.
    SemiMonthly {
        /// First day of month.
        day1: u32,
        /// Second day of month.
        day2: u32,
        /// Start.
        anchor: NaiveDate,
    },
    /// Pre-expanded dates.
    Dates {
        /// Dates.
        dates: Vec<NaiveDate>,
    },
}

impl Schedule {
    /// Occurrences within `[from, to]`, capped at [`MAX_OCCURRENCES`].
    pub fn occurrences(&self, from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
        let mut out = Vec::new();
        match self {
            Schedule::Once { date } => {
                if *date >= from && *date <= to {
                    out.push(*date);
                }
            }
            Schedule::Dates { dates } => out.extend(
                dates
                    .iter()
                    .copied()
                    .filter(|d| *d >= from && *d <= to)
                    .take(MAX_OCCURRENCES),
            ),
            Schedule::Every {
                freq,
                interval,
                anchor,
                until,
            } => {
                let step = (*interval).max(1);
                let end = until.map_or(to, |u| u.min(to));
                let mut k: u32 = 0;
                loop {
                    let d = match freq {
                        Frequency::Daily => {
                            anchor.checked_add_signed(Duration::days(i64::from(k * step)))
                        }
                        Frequency::Weekly => {
                            anchor.checked_add_signed(Duration::weeks(i64::from(k * step)))
                        }
                        Frequency::Monthly => Some(add_months_anchored(
                            *anchor,
                            (k * step) as i32,
                            anchor.day(),
                        )),
                        Frequency::Yearly => Some(add_months_anchored(
                            *anchor,
                            (k * step * 12) as i32,
                            anchor.day(),
                        )),
                    };
                    let Some(d) = d else { break };
                    if d > end || out.len() >= MAX_OCCURRENCES || k > 200_000 {
                        break;
                    }
                    if d >= from {
                        out.push(d);
                    }
                    k += 1;
                }
            }
            Schedule::SemiMonthly { day1, day2, anchor } => {
                let mut m = crate::period::YearMonth::of((*anchor).max(from));
                while m.first_day() <= to && out.len() < MAX_OCCURRENCES {
                    let mut ds = [m.day_clamped(*day1), m.day_clamped(*day2)];
                    ds.sort();
                    for d in ds {
                        if d >= from && d <= to && d >= *anchor && !out.contains(&d) {
                            out.push(d);
                        }
                    }
                    m = m.next();
                }
            }
        }
        out
    }
}

/// A recurring item to project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringItem {
    /// Display name.
    pub name: String,
    /// Signed amount per occurrence.
    pub amount: Decimal,
    /// Account id.
    pub account_id: String,
    /// Schedule.
    pub schedule: Schedule,
}

/// An account in the forecast.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastAccount {
    /// Account id.
    pub id: String,
    /// Current balance.
    pub balance: Decimal,
    /// Low-balance threshold.
    #[serde(default)]
    pub low_threshold: Option<Decimal>,
}

/// Forecast inputs.
#[derive(Debug, Clone)]
pub struct ForecastInput<'a> {
    /// Today (day 0; projections start tomorrow).
    pub today: NaiveDate,
    /// Horizon in days.
    pub horizon_days: u32,
    /// Liquid on-budget accounts.
    pub accounts: &'a [ForecastAccount],
    /// The account discretionary spending comes out of (defaults to the first account).
    pub spending_account: Option<&'a str>,
    /// Recurring items.
    pub recurring: &'a [RecurringItem],
    /// History used for discretionary spend (trailing 90 days are used).
    pub history: &'a [Txn],
    /// Categories (the `variable` flag selects discretionary categories).
    pub categories: &'a [Category],
    /// Row ids that belong to recurring series (excluded from discretionary spend).
    pub recurring_txn_ids: &'a HashSet<String>,
    /// Compute the p10/p90 band.
    pub band: bool,
    /// Bootstrap seed.
    pub seed: u64,
    /// Bootstrap resamples.
    pub simulations: usize,
}

/// A threshold breach.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breach {
    /// First date below the threshold.
    pub date: NaiveDate,
    /// Account id.
    pub account_id: String,
    /// Projected balance on that date.
    pub amount: Decimal,
    /// Threshold.
    pub threshold: Decimal,
    /// Names of the three largest outflows between today and the breach.
    pub top_outflows: Vec<String>,
}

/// Forecast output (`finance_forecast`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    /// Dates (`today+1 ..= today+horizon`).
    pub t: Vec<NaiveDate>,
    /// Projected total balance.
    pub balance: Vec<f64>,
    /// 10th percentile band.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p10: Option<Vec<f64>>,
    /// 90th percentile band.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p90: Option<Vec<f64>>,
    /// Threshold of the spending account.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    /// Breaches (first per account).
    pub breaches: Vec<Breach>,
    /// Discretionary daily spend used (positive).
    pub daily_discretionary: Decimal,
    /// Minimum projected total balance.
    pub min_balance: f64,
}

/// The 90 trailing daily discretionary spends (positive = spending), oldest first.
pub fn daily_discretionary_history(
    history: &[Txn],
    categories: &[Category],
    recurring_ids: &HashSet<String>,
    today: NaiveDate,
) -> Vec<Decimal> {
    let variable: HashMap<&str, bool> = categories
        .iter()
        .map(|c| (c.id.as_str(), c.variable && !c.is_income && !c.is_saving))
        .collect();
    let mut days = vec![Decimal::ZERO; 90];
    for t in history
        .iter()
        .filter(|t| t.counts() && !t.is_transfer() && !recurring_ids.contains(&t.id))
    {
        let age = (today - t.date).num_days();
        if !(0..90).contains(&age) {
            continue;
        }
        let is_var = t
            .category_id
            .as_deref()
            .is_none_or(|c| variable.get(c).copied().unwrap_or(false));
        if is_var && t.amount < Decimal::ZERO {
            days[89 - age as usize] -= t.amount;
        }
    }
    days
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = p * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
}

/// Runs the forecast.
pub fn cashflow(input: &ForecastInput<'_>) -> Result<Forecast> {
    if input.horizon_days == 0 || input.horizon_days > MAX_HORIZON_DAYS {
        return Err(FinanceError::invalid(format!(
            "horizon must be 1–{MAX_HORIZON_DAYS} days"
        )));
    }
    if input.accounts.is_empty() {
        return Err(FinanceError::invalid("forecast needs at least one account"));
    }
    let h = input.horizon_days as usize;
    let start = input.today + Duration::days(1);
    let end = input.today + Duration::days(i64::from(input.horizon_days));
    let spend_acct = input.spending_account.unwrap_or(&input.accounts[0].id);
    let idx: HashMap<&str, usize> = input
        .accounts
        .iter()
        .enumerate()
        .map(|(i, a)| (a.id.as_str(), i))
        .collect();

    // Daily deltas per account from recurring items.
    let mut deltas = vec![vec![Decimal::ZERO; h]; input.accounts.len()];
    let mut outflows: Vec<Vec<(usize, String, Decimal)>> = vec![Vec::new(); input.accounts.len()];
    for item in input.recurring {
        let Some(&ai) = idx.get(item.account_id.as_str()) else {
            continue;
        };
        for d in item.schedule.occurrences(start, end) {
            let di = (d - start).num_days() as usize;
            deltas[ai][di] += item.amount;
            if item.amount < Decimal::ZERO {
                outflows[ai].push((di, item.name.clone(), -item.amount));
            }
        }
    }
    let hist = daily_discretionary_history(
        input.history,
        input.categories,
        input.recurring_txn_ids,
        input.today,
    );
    let daily = median(&hist).unwrap_or_default();
    let si = idx.get(spend_acct).copied().unwrap_or(0);

    // Deterministic per-account paths.
    let mut paths: Vec<Vec<Decimal>> = Vec::with_capacity(input.accounts.len());
    for (ai, a) in input.accounts.iter().enumerate() {
        let mut bal = a.balance;
        let mut p = Vec::with_capacity(h);
        for (di, delta) in deltas[ai].iter().enumerate().take(h) {
            bal += *delta;
            if ai == si {
                bal -= daily;
            }
            let _ = di;
            p.push(bal);
        }
        paths.push(p);
    }
    let total: Vec<Decimal> = (0..h).map(|d| paths.iter().map(|p| p[d]).sum()).collect();

    let mut breaches = Vec::new();
    for (ai, a) in input.accounts.iter().enumerate() {
        let Some(th) = a.low_threshold else { continue };
        if let Some(di) = paths[ai].iter().position(|b| *b < th) {
            let mut outs: Vec<(String, Decimal)> = outflows[ai]
                .iter()
                .filter(|o| o.0 <= di)
                .map(|o| (o.1.clone(), o.2))
                .collect();
            if ai == si && daily > Decimal::ZERO {
                outs.push((
                    "Everyday spending".into(),
                    daily * Decimal::from(di as u64 + 1),
                ));
            }
            // Aggregate by name, then take the three largest.
            let mut agg: BTreeMap<String, Decimal> = BTreeMap::new();
            for (n, v) in outs {
                *agg.entry(n).or_default() += v;
            }
            let mut v: Vec<(String, Decimal)> = agg.into_iter().collect();
            v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            breaches.push(Breach {
                date: start + Duration::days(di as i64),
                account_id: a.id.clone(),
                amount: paths[ai][di],
                threshold: th,
                top_outflows: v.into_iter().take(3).map(|x| x.0).collect(),
            });
        }
    }
    breaches.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.account_id.cmp(&b.account_id))
    });

    let (p10, p90) = if input.band {
        let sims = input.simulations.clamp(1, 10_000);
        let draws: Vec<f64> = hist.iter().map(|d| to_f64(*d)).collect();
        let base: Vec<f64> = (0..h)
            .map(|d| to_f64(total[d] + daily * Decimal::from(d as u64 + 1)))
            .collect();
        let mut rng = SplitMix64::new(input.seed);
        let mut by_day: Vec<Vec<f64>> = vec![Vec::with_capacity(sims); h];
        for _ in 0..sims {
            let mut cum = 0.0;
            for (d, slot) in by_day.iter_mut().enumerate() {
                cum += draws[rng.below(draws.len())];
                slot.push(base[d] - cum);
            }
        }
        let mut lo = Vec::with_capacity(h);
        let mut hi = Vec::with_capacity(h);
        for mut v in by_day {
            v.sort_by(f64::total_cmp);
            lo.push(percentile(&v, 0.10));
            hi.push(percentile(&v, 0.90));
        }
        (Some(lo), Some(hi))
    } else {
        (None, None)
    };
    let balance: Vec<f64> = total.iter().map(|d| to_f64(*d)).collect();
    Ok(Forecast {
        t: (0..h).map(|d| start + Duration::days(d as i64)).collect(),
        min_balance: balance.iter().copied().fold(f64::INFINITY, f64::min),
        balance,
        p10,
        p90,
        threshold: input
            .accounts
            .get(si)
            .and_then(|a| a.low_threshold)
            .map(to_f64),
        breaches,
        daily_discretionary: daily,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{dec, txn};

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn schedules() {
        let m = Schedule::Every {
            freq: Frequency::Monthly,
            interval: 1,
            anchor: d("2026-01-31"),
            until: None,
        };
        assert_eq!(
            m.occurrences(d("2026-02-01"), d("2026-04-30")),
            vec![d("2026-02-28"), d("2026-03-31"), d("2026-04-30")]
        );
        let w = Schedule::Every {
            freq: Frequency::Weekly,
            interval: 2,
            anchor: d("2026-01-02"),
            until: Some(d("2026-02-01")),
        };
        assert_eq!(w.occurrences(d("2026-01-01"), d("2026-12-31")).len(), 3);
        let s = Schedule::SemiMonthly {
            day1: 15,
            day2: 1,
            anchor: d("2026-01-10"),
        };
        assert_eq!(
            s.occurrences(d("2026-01-01"), d("2026-02-20")),
            vec![d("2026-01-15"), d("2026-02-01"), d("2026-02-15")]
        );
        let y = Schedule::Every {
            freq: Frequency::Yearly,
            interval: 1,
            anchor: d("2024-02-29"),
            until: None,
        };
        assert_eq!(
            y.occurrences(d("2025-01-01"), d("2028-12-31")),
            vec![
                d("2025-02-28"),
                d("2026-02-28"),
                d("2027-02-28"),
                d("2028-02-29")
            ]
        );
        assert_eq!(
            Schedule::Once {
                date: d("2026-05-05")
            }
            .occurrences(d("2026-01-01"), d("2026-02-01")),
            vec![]
        );
    }

    #[test]
    fn projection_breach_and_band() {
        let today = d("2026-03-31");
        let accounts = vec![
            ForecastAccount {
                id: "chk".into(),
                balance: dec("2000"),
                low_threshold: Some(dec("500")),
            },
            ForecastAccount {
                id: "sav".into(),
                balance: dec("10000"),
                low_threshold: None,
            },
        ];
        let recurring = vec![
            RecurringItem {
                name: "Rent".into(),
                amount: dec("-1500"),
                account_id: "chk".into(),
                schedule: Schedule::Every {
                    freq: Frequency::Monthly,
                    interval: 1,
                    anchor: d("2026-04-01"),
                    until: None,
                },
            },
            RecurringItem {
                name: "Salary".into(),
                amount: dec("1800"),
                account_id: "chk".into(),
                schedule: Schedule::Every {
                    freq: Frequency::Monthly,
                    interval: 1,
                    anchor: d("2026-04-15"),
                    until: None,
                },
            },
            RecurringItem {
                name: "Gym".into(),
                amount: dec("-50"),
                account_id: "chk".into(),
                schedule: Schedule::Every {
                    freq: Frequency::Monthly,
                    interval: 1,
                    anchor: d("2026-04-01"),
                    until: None,
                },
            },
        ];
        // Discretionary: $20 every day for 90 days, plus a recurring row that must be ignored.
        let mut hist: Vec<Txn> = (0..90)
            .map(|i| {
                txn(
                    &format!("h{i}"),
                    "chk",
                    &(today - Duration::days(i)).to_string(),
                    "-20",
                )
            })
            .collect();
        hist.push(txn("rec", "chk", "2026-03-01", "-1500"));
        let rec_ids: HashSet<String> = ["rec".to_string()].into();
        let input = ForecastInput {
            today,
            horizon_days: 90,
            accounts: &accounts,
            spending_account: Some("chk"),
            recurring: &recurring,
            history: &hist,
            categories: &[],
            recurring_txn_ids: &rec_ids,
            band: true,
            seed: 7,
            simulations: 200,
        };
        let f = cashflow(&input).unwrap();
        assert_eq!(f.t.len(), 90);
        assert_eq!(f.daily_discretionary, dec("20"));
        // Day 1 (Apr 1): 12000 − 1500 − 50 − 20.
        assert!((f.balance[0] - 10430.0).abs() < 1e-9);
        let b = &f.breaches[0];
        assert_eq!(b.account_id, "chk");
        assert_eq!(b.date, d("2026-04-01"));
        assert_eq!(b.top_outflows[0], "Rent");
        // Constant history → the band collapses onto the projection.
        let p10 = f.p10.as_ref().unwrap();
        assert!((p10[45] - f.balance[45]).abs() < 1e-6);
        assert_eq!(f.threshold, Some(500.0));
        // Deterministic for the same seed.
        assert_eq!(cashflow(&input).unwrap(), f);
    }

    #[test]
    fn band_orders_and_validation() {
        let today = d("2026-03-31");
        let accounts = vec![ForecastAccount {
            id: "a".into(),
            balance: dec("5000"),
            low_threshold: None,
        }];
        let hist: Vec<Txn> = (0..90)
            .map(|i| {
                txn(
                    &format!("h{i}"),
                    "a",
                    &(today - Duration::days(i)).to_string(),
                    if i % 3 == 0 { "-90" } else { "-0.01" },
                )
            })
            .collect();
        let none = HashSet::new();
        let input = ForecastInput {
            today,
            horizon_days: 30,
            accounts: &accounts,
            spending_account: None,
            recurring: &[],
            history: &hist,
            categories: &[],
            recurring_txn_ids: &none,
            band: true,
            seed: 1,
            simulations: 1000,
        };
        let f = cashflow(&input).unwrap();
        let (lo, hi) = (f.p10.unwrap(), f.p90.unwrap());
        assert!(lo.iter().zip(&hi).all(|(l, h)| l <= h));
        assert!(lo[29] < hi[29]);
        assert!(
            cashflow(&ForecastInput {
                horizon_days: 0,
                ..input.clone()
            })
            .is_err()
        );
        assert!(
            cashflow(&ForecastInput {
                accounts: &[],
                ..input
            })
            .is_err()
        );
    }
}
