//! Performance (§15.7): XIRR (Newton-Raphson from 0.1, ≤ 50 iterations, tolerance 1e-7, bisection fallback
//! on [−0.9999, 10]) and time-weighted return (daily chaining, Modified Dietz per month when daily values are
//! missing).
//!
//! Cash-flow convention for the securities-only portfolio: buys are contributions, sells and cash dividends
//! are distributions, reinvested dividends are internal, fees are costs (no flow).

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

use super::{InvTxn, InvTxnType};
use crate::money::to_f64;

/// Newton start.
pub const XIRR_GUESS: f64 = 0.1;
/// Newton iterations.
pub const XIRR_MAX_ITER: usize = 50;
/// Convergence tolerance.
pub const XIRR_TOL: f64 = 1e-7;

fn npv(flows: &[(NaiveDate, f64)], r: f64) -> f64 {
    let t0 = flows[0].0;
    flows
        .iter()
        .map(|(d, cf)| cf / (1.0 + r).powf((*d - t0).num_days() as f64 / 365.0))
        .sum()
}

fn dnpv(flows: &[(NaiveDate, f64)], r: f64) -> f64 {
    let t0 = flows[0].0;
    flows
        .iter()
        .map(|(d, cf)| {
            let t = (*d - t0).num_days() as f64 / 365.0;
            -t * cf / (1.0 + r).powf(t + 1.0)
        })
        .sum()
}

/// Annualised internal rate of return for dated cash flows (investor view: contributions negative,
/// withdrawals and the terminal value positive). `None` without both signs or without a root.
pub fn xirr(flows: &[(NaiveDate, f64)]) -> Option<f64> {
    let mut f: Vec<(NaiveDate, f64)> = flows
        .iter()
        .copied()
        .filter(|(_, v)| v.is_finite() && *v != 0.0)
        .collect();
    f.sort_by_key(|x| x.0);
    if !(f.iter().any(|x| x.1 > 0.0) && f.iter().any(|x| x.1 < 0.0)) {
        return None;
    }
    let mut r = XIRR_GUESS;
    for _ in 0..XIRR_MAX_ITER {
        let v = npv(&f, r);
        let d = dnpv(&f, r);
        if !v.is_finite() || !d.is_finite() || d == 0.0 {
            break;
        }
        let next = r - v / d;
        if !next.is_finite() || next <= -0.9999 {
            break;
        }
        if (next - r).abs() < XIRR_TOL {
            return (npv(&f, next).abs() < 1e-4 * f.iter().map(|x| x.1.abs()).fold(1.0, f64::max))
                .then_some(next);
        }
        r = next;
    }
    // Bisection fallback.
    let (mut lo, mut hi) = (-0.9999, 10.0);
    let (mut flo, fhi) = (npv(&f, lo), npv(&f, hi));
    if !flo.is_finite() || !fhi.is_finite() || flo.signum() == fhi.signum() {
        return None;
    }
    for _ in 0..200 {
        let mid = (lo + hi) / 2.0;
        let fm = npv(&f, mid);
        if fm.abs() < XIRR_TOL || (hi - lo) / 2.0 < XIRR_TOL {
            return Some(mid);
        }
        if fm.signum() == flo.signum() {
            lo = mid;
            flo = fm;
        } else {
            hi = mid;
        }
    }
    Some((lo + hi) / 2.0)
}

/// Investor contributions (positive = money in) implied by investment transactions, by date.
pub fn contributions(txns: &[InvTxn]) -> Vec<(NaiveDate, f64)> {
    let mut v = Vec::new();
    for t in txns {
        let gross = t
            .amount
            .map(|a| a.abs())
            .unwrap_or(t.qty.unwrap_or_default().abs() * t.price.unwrap_or_default());
        let fees = t.fees.abs();
        let x = match t.kind {
            InvTxnType::Buy => to_f64(gross + fees),
            InvTxnType::Sell => -to_f64(gross - fees),
            InvTxnType::Dividend | InvTxnType::Interest | InvTxnType::ReturnOfCapital => {
                -to_f64(gross)
            }
            InvTxnType::TransferIn => to_f64(t.basis.unwrap_or(gross)),
            InvTxnType::TransferOut => -to_f64(gross),
            InvTxnType::Reinvest | InvTxnType::Fee | InvTxnType::Split => 0.0,
        };
        if x != 0.0 {
            v.push((t.date, x));
        }
    }
    v.sort_by_key(|x| x.0);
    v
}

/// XIRR of a portfolio from contributions and a terminal value at `as_of`, optionally only from `since`
/// (the value at `since` is then treated as the opening contribution).
pub fn portfolio_xirr(
    contribs: &[(NaiveDate, f64)],
    start_value: Option<(NaiveDate, f64)>,
    end_value: f64,
    as_of: NaiveDate,
) -> Option<f64> {
    let mut flows: Vec<(NaiveDate, f64)> = Vec::new();
    let since = start_value.map(|s| s.0);
    if let Some((d, v)) = start_value {
        flows.push((d, -v));
    }
    flows.extend(
        contribs
            .iter()
            .filter(|(d, _)| since.is_none_or(|s| *d > s) && *d <= as_of)
            .map(|(d, c)| (*d, -c)),
    );
    flows.push((as_of, end_value));
    xirr(&flows)
}

/// Method used by [`twr`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TwrMethod {
    /// Daily chaining.
    Daily,
    /// Modified Dietz per month, chained.
    ModifiedDietz,
}

/// TWR result: cumulative return at each date (first = 0).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwrSeries {
    /// Method.
    pub method: TwrMethod,
    /// Dates.
    pub t: Vec<NaiveDate>,
    /// Cumulative return (fraction).
    pub twr: Vec<f64>,
}

/// Modified Dietz return over `(start, end]` with flows (positive = contribution) inside the period.
pub fn modified_dietz(
    start: NaiveDate,
    v0: f64,
    end: NaiveDate,
    v1: f64,
    flows: &[(NaiveDate, f64)],
) -> Option<f64> {
    let total = (end - start).num_days() as f64;
    if total <= 0.0 {
        return None;
    }
    let inside: Vec<&(NaiveDate, f64)> = flows
        .iter()
        .filter(|(d, _)| *d > start && *d <= end)
        .collect();
    let f: f64 = inside.iter().map(|x| x.1).sum();
    let weighted: f64 = inside
        .iter()
        .map(|(d, cf)| cf * (end - *d).num_days() as f64 / total)
        .sum();
    let denom = v0 + weighted;
    (denom.abs() > 1e-12).then(|| (v1 - v0 - f) / denom)
}

/// Time-weighted return from a value series and contributions. Uses daily chaining when consecutive values
/// are at most 4 days apart (weekends/holidays), otherwise Modified Dietz on month-end values.
/// Flows are assumed to occur at the end of their day.
pub fn twr(values: &[(NaiveDate, f64)], flows: &[(NaiveDate, f64)]) -> TwrSeries {
    let mut v: Vec<(NaiveDate, f64)> = values.iter().copied().filter(|x| x.1.is_finite()).collect();
    v.sort_by_key(|x| x.0);
    v.dedup_by_key(|x| x.0);
    if v.len() < 2 {
        return TwrSeries {
            method: TwrMethod::Daily,
            t: v.iter().map(|x| x.0).collect(),
            twr: v.iter().map(|_| 0.0).collect(),
        };
    }
    let daily = v.windows(2).all(|w| (w[1].0 - w[0].0).num_days() <= 4);
    let flow_between = |a: NaiveDate, b: NaiveDate| {
        flows
            .iter()
            .filter(|(d, _)| *d > a && *d <= b)
            .map(|x| x.1)
            .sum::<f64>()
    };
    if daily {
        let mut cum = 1.0;
        let mut out = vec![0.0];
        for w in v.windows(2) {
            let (p, c) = (w[0], w[1]);
            if p.1.abs() > 1e-12 {
                cum *= (c.1 - flow_between(p.0, c.0)) / p.1;
            }
            out.push(cum - 1.0);
        }
        return TwrSeries {
            method: TwrMethod::Daily,
            t: v.iter().map(|x| x.0).collect(),
            twr: out,
        };
    }
    // Month-end sampling.
    let mut me: Vec<(NaiveDate, f64)> = Vec::new();
    for x in &v {
        match me.last_mut() {
            Some(last) if last.0.year() == x.0.year() && last.0.month() == x.0.month() => {
                *last = *x
            }
            _ => me.push(*x),
        }
    }
    let mut cum = 1.0;
    let mut out = vec![0.0];
    for w in me.windows(2) {
        if let Some(r) = modified_dietz(w[0].0, w[0].1, w[1].0, w[1].1, flows) {
            cum *= 1.0 + r;
        }
        out.push(cum - 1.0);
    }
    TwrSeries {
        method: TwrMethod::ModifiedDietz,
        t: me.iter().map(|x| x.0).collect(),
        twr: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn xirr_known_values() {
        // Excel's XIRR documentation example: ≈ 0.373362535.
        let flows = vec![
            (d("2008-01-01"), -10000.0),
            (d("2008-03-01"), 2750.0),
            (d("2008-10-30"), 4250.0),
            (d("2009-02-15"), 3250.0),
            (d("2009-04-01"), 2750.0),
        ];
        let r = xirr(&flows).unwrap();
        assert!((r - 0.373362535).abs() < 1e-6, "{r}");
        // Exactly 10% over one 365-day year.
        let r = xirr(&[(d("2025-01-01"), -100.0), (d("2026-01-01"), 110.0)]).unwrap();
        assert!((r - 0.10).abs() < 1e-7);
        // Losing money.
        let r = xirr(&[(d("2025-01-01"), -100.0), (d("2026-01-01"), 50.0)]).unwrap();
        assert!((r + 0.5).abs() < 1e-6);
        assert_eq!(xirr(&[(d("2025-01-01"), -100.0)]), None);
        assert_eq!(
            xirr(&[(d("2025-01-01"), 100.0), (d("2025-02-01"), 5.0)]),
            None
        );
    }

    #[test]
    fn xirr_large_and_out_of_range() {
        let r = xirr(&[(d("2025-01-01"), -100.0), (d("2025-12-01"), 500.0)]).unwrap();
        let expected = 5.0f64.powf(365.0 / 334.0) - 1.0;
        assert!((r - expected).abs() < 1e-5, "{r} vs {expected}");
        // A near-total loss stays above the −0.9999 floor.
        let r = xirr(&[(d("2025-01-01"), -100.0), (d("2026-01-01"), 0.5)]).unwrap();
        assert!((r + 0.995).abs() < 1e-5, "{r}");
    }

    #[test]
    fn twr_daily_ignores_flows() {
        // 100 → 110 (+10%), then +100 contribution, then 210 → 231 (+10%).
        let values = vec![
            (d("2026-01-01"), 100.0),
            (d("2026-01-02"), 110.0),
            (d("2026-01-03"), 210.0),
            (d("2026-01-05"), 231.0),
        ];
        let flows = vec![(d("2026-01-03"), 100.0)];
        let s = twr(&values, &flows);
        assert_eq!(s.method, TwrMethod::Daily);
        assert!((s.twr[3] - 0.21).abs() < 1e-12, "{:?}", s.twr);
    }

    #[test]
    fn twr_monthly_modified_dietz() {
        let values = vec![
            (d("2026-01-31"), 1000.0),
            (d("2026-02-28"), 1150.0),
            (d("2026-03-31"), 1150.0),
        ];
        let flows = vec![(d("2026-02-14"), 100.0)];
        let s = twr(&values, &flows);
        assert_eq!(s.method, TwrMethod::ModifiedDietz);
        // MD Feb: (1150 − 1000 − 100) / (1000 + 100·14/28) = 50/1050.
        assert!((s.twr[1] - 50.0 / 1050.0).abs() < 1e-12);
        assert!((s.twr[2] - s.twr[1]).abs() < 1e-12);
    }

    #[test]
    fn contributions_and_portfolio_xirr() {
        let mk = |date: &str, kind, qty: &str, price: &str| InvTxn {
            id: date.into(),
            date: d(date),
            kind,
            account_id: "a".into(),
            security: "X".into(),
            qty: Some(qty.parse().unwrap()),
            price: Some(price.parse().unwrap()),
            amount: None,
            fees: Default::default(),
            ratio: None,
            acquired: None,
            basis: None,
        };
        let c = contributions(&[
            mk("2025-01-01", InvTxnType::Buy, "10", "10"),
            mk("2025-06-01", InvTxnType::Sell, "5", "12"),
        ]);
        assert_eq!(c, vec![(d("2025-01-01"), 100.0), (d("2025-06-01"), -60.0)]);
        let r = portfolio_xirr(&c, None, 60.0, d("2026-01-01")).unwrap();
        assert!(r > 0.0);
    }
}
