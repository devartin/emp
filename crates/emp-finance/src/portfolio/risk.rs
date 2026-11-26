//! Simple risk metrics over daily value or price series: volatility, maximum drawdown, Sharpe ratio and beta.
//! (SPEC lists risk as P1; these are the straightforward definitions.)

use serde::{Deserialize, Serialize};

/// Trading days per year for annualisation.
pub const TRADING_DAYS: f64 = 252.0;

/// Simple returns `v[i]/v[i-1] − 1` (skipping non-positive denominators).
pub fn returns(values: &[f64]) -> Vec<f64> {
    values
        .windows(2)
        .filter(|w| w[0] > 0.0 && w[0].is_finite() && w[1].is_finite())
        .map(|w| w[1] / w[0] - 1.0)
        .collect()
}

fn mean(x: &[f64]) -> f64 {
    x.iter().sum::<f64>() / x.len() as f64
}

/// Sample standard deviation.
pub fn stdev(x: &[f64]) -> Option<f64> {
    if x.len() < 2 {
        return None;
    }
    let m = mean(x);
    Some((x.iter().map(|v| (v - m).powi(2)).sum::<f64>() / (x.len() - 1) as f64).sqrt())
}

/// Annualised volatility of daily returns.
pub fn volatility(daily_returns: &[f64]) -> Option<f64> {
    stdev(daily_returns).map(|s| s * TRADING_DAYS.sqrt())
}

/// Maximum drawdown as a positive fraction, with peak and trough indexes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drawdown {
    /// Drawdown (0.25 = −25%).
    pub max: f64,
    /// Index of the peak.
    pub peak: usize,
    /// Index of the trough.
    pub trough: usize,
}

/// Maximum peak-to-trough decline.
pub fn max_drawdown(values: &[f64]) -> Option<Drawdown> {
    let mut best = Drawdown {
        max: 0.0,
        peak: 0,
        trough: 0,
    };
    let mut peak_i = None::<usize>;
    for (i, &v) in values.iter().enumerate() {
        if !v.is_finite() {
            continue;
        }
        match peak_i {
            Some(p) if values[p] >= v => {
                let dd = if values[p] > 0.0 {
                    1.0 - v / values[p]
                } else {
                    0.0
                };
                if dd > best.max {
                    best = Drawdown {
                        max: dd,
                        peak: p,
                        trough: i,
                    };
                }
            }
            _ => peak_i = Some(i),
        }
    }
    peak_i.map(|_| best)
}

/// Annualised Sharpe ratio from daily returns and an annual risk-free rate.
pub fn sharpe(daily_returns: &[f64], risk_free_annual: f64) -> Option<f64> {
    let sd = stdev(daily_returns)?;
    if sd == 0.0 {
        return None;
    }
    let rf = risk_free_annual / TRADING_DAYS;
    Some((mean(daily_returns) - rf) / sd * TRADING_DAYS.sqrt())
}

/// Beta of `asset` vs `benchmark` returns (aligned, same length).
pub fn beta(asset: &[f64], benchmark: &[f64]) -> Option<f64> {
    let n = asset.len().min(benchmark.len());
    if n < 2 {
        return None;
    }
    let (a, b) = (&asset[..n], &benchmark[..n]);
    let (ma, mb) = (mean(a), mean(b));
    let cov: f64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - ma) * (y - mb))
        .sum::<f64>()
        / (n - 1) as f64;
    let var: f64 = b.iter().map(|y| (y - mb).powi(2)).sum::<f64>() / (n - 1) as f64;
    (var > 0.0).then(|| cov / var)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics() {
        let v = [100.0, 110.0, 99.0, 120.0, 90.0, 95.0];
        let dd = max_drawdown(&v).unwrap();
        assert!((dd.max - 0.25).abs() < 1e-12);
        assert_eq!((dd.peak, dd.trough), (3, 4));
        let r = returns(&v);
        assert_eq!(r.len(), 5);
        assert!((r[0] - 0.1).abs() < 1e-12);
        assert!(volatility(&r).unwrap() > 0.0);
        let bench: Vec<f64> = r.iter().map(|x| x / 2.0).collect();
        assert!((beta(&r, &bench).unwrap() - 2.0).abs() < 1e-9);
        assert!(sharpe(&[0.01, 0.01], 0.0).is_none());
        assert!(sharpe(&r, 0.02).is_some());
        assert_eq!(max_drawdown(&[]), None);
        assert_eq!(max_drawdown(&[1.0, 2.0, 3.0]).unwrap().max, 0.0);
    }
}
