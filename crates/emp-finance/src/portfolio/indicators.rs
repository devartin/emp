//! Technical indicators over closing prices (§15.7): SMA, EMA (α = 2/(n+1)), Bollinger (20, 2σ),
//! RSI (14, Wilder) and MACD (12, 26, 9). Outputs align with the input; warm-up positions are `None`.

use serde::{Deserialize, Serialize};

/// Simple moving average.
pub fn sma(x: &[f64], n: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; x.len()];
    if n == 0 || x.len() < n {
        return out;
    }
    let mut sum: f64 = x[..n].iter().sum();
    out[n - 1] = Some(sum / n as f64);
    for i in n..x.len() {
        sum += x[i] - x[i - n];
        out[i] = Some(sum / n as f64);
    }
    out
}

/// Exponential moving average seeded with the SMA of the first `n` values.
pub fn ema(x: &[f64], n: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; x.len()];
    if n == 0 || x.len() < n {
        return out;
    }
    let alpha = 2.0 / (n as f64 + 1.0);
    let mut e = x[..n].iter().sum::<f64>() / n as f64;
    out[n - 1] = Some(e);
    for i in n..x.len() {
        e = alpha * x[i] + (1.0 - alpha) * e;
        out[i] = Some(e);
    }
    out
}

/// Bollinger bands (middle SMA, upper/lower at `k` population standard deviations).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bollinger {
    /// Middle band.
    pub middle: Vec<Option<f64>>,
    /// Upper band.
    pub upper: Vec<Option<f64>>,
    /// Lower band.
    pub lower: Vec<Option<f64>>,
}

/// Bollinger bands; the SPEC defaults are `n = 20`, `k = 2`.
pub fn bollinger(x: &[f64], n: usize, k: f64) -> Bollinger {
    let middle = sma(x, n);
    let mut upper = vec![None; x.len()];
    let mut lower = vec![None; x.len()];
    for i in 0..x.len() {
        if let Some(m) = middle[i] {
            let w = &x[i + 1 - n..=i];
            let sd = (w.iter().map(|v| (v - m).powi(2)).sum::<f64>() / n as f64).sqrt();
            upper[i] = Some(m + k * sd);
            lower[i] = Some(m - k * sd);
        }
    }
    Bollinger {
        middle,
        upper,
        lower,
    }
}

/// RSI with Wilder smoothing (SPEC default `n = 14`).
pub fn rsi(x: &[f64], n: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; x.len()];
    if n == 0 || x.len() <= n {
        return out;
    }
    let (mut gain, mut loss) = (0.0, 0.0);
    for i in 1..=n {
        let d = x[i] - x[i - 1];
        if d > 0.0 { gain += d } else { loss -= d }
    }
    let (mut ag, mut al) = (gain / n as f64, loss / n as f64);
    let val = |ag: f64, al: f64| {
        if al == 0.0 {
            if ag == 0.0 { 50.0 } else { 100.0 }
        } else {
            100.0 - 100.0 / (1.0 + ag / al)
        }
    };
    out[n] = Some(val(ag, al));
    for i in n + 1..x.len() {
        let d = x[i] - x[i - 1];
        let (g, l) = if d > 0.0 { (d, 0.0) } else { (0.0, -d) };
        ag = (ag * (n as f64 - 1.0) + g) / n as f64;
        al = (al * (n as f64 - 1.0) + l) / n as f64;
        out[i] = Some(val(ag, al));
    }
    out
}

/// MACD line, signal and histogram.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Macd {
    /// EMA(fast) − EMA(slow).
    pub macd: Vec<Option<f64>>,
    /// EMA(signal) of the MACD line.
    pub signal: Vec<Option<f64>>,
    /// MACD − signal.
    pub histogram: Vec<Option<f64>>,
}

/// MACD; the SPEC defaults are 12, 26, 9.
pub fn macd(x: &[f64], fast: usize, slow: usize, signal: usize) -> Macd {
    let f = ema(x, fast);
    let s = ema(x, slow);
    let line: Vec<Option<f64>> = f.iter().zip(&s).map(|(a, b)| Some((*a)? - (*b)?)).collect();
    let start = line.iter().position(Option::is_some).unwrap_or(line.len());
    let compact: Vec<f64> = line[start..].iter().flatten().copied().collect();
    let sig_c = ema(&compact, signal);
    let mut sig = vec![None; x.len()];
    for (i, v) in sig_c.into_iter().enumerate() {
        sig[start + i] = v;
    }
    let histogram = line
        .iter()
        .zip(&sig)
        .map(|(a, b)| Some((*a)? - (*b)?))
        .collect();
    Macd {
        macd: line,
        signal: sig,
        histogram,
    }
}

/// Indicator kinds for `market_indicators`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndicatorKind {
    /// Simple moving average.
    Sma,
    /// Exponential moving average.
    Ema,
    /// Bollinger bands (k = 2).
    Bollinger,
    /// Wilder RSI.
    Rsi,
    /// MACD (12, 26, 9; `period` is ignored).
    Macd,
}

/// Computes several indicators keyed for the IPC `market_indicators` response:
/// `sma20`, `ema50`, `rsi14`, `bollinger20.upper|middle|lower`, `macd.macd|signal|histogram`.
/// Periods are clamped to 1–500; NaN closes poison only the windows that contain them.
pub fn series(
    closes: &[f64],
    specs: &[(IndicatorKind, usize)],
) -> std::collections::BTreeMap<String, Vec<Option<f64>>> {
    let mut out = std::collections::BTreeMap::new();
    let clean = |v: Vec<Option<f64>>| {
        v.into_iter()
            .map(|x| x.filter(|y| y.is_finite()))
            .collect::<Vec<_>>()
    };
    for &(kind, period) in specs {
        let n = period.clamp(1, 500);
        match kind {
            IndicatorKind::Sma => {
                out.insert(format!("sma{n}"), clean(sma(closes, n)));
            }
            IndicatorKind::Ema => {
                out.insert(format!("ema{n}"), clean(ema(closes, n)));
            }
            IndicatorKind::Rsi => {
                out.insert(format!("rsi{n}"), clean(rsi(closes, n)));
            }
            IndicatorKind::Bollinger => {
                let b = bollinger(closes, n, 2.0);
                out.insert(format!("bollinger{n}.upper"), clean(b.upper));
                out.insert(format!("bollinger{n}.middle"), clean(b.middle));
                out.insert(format!("bollinger{n}.lower"), clean(b.lower));
            }
            IndicatorKind::Macd => {
                let m = macd(closes, 12, 26, 9);
                out.insert("macd.macd".into(), clean(m.macd));
                out.insert("macd.signal".into(), clean(m.signal));
                out.insert("macd.histogram".into(), clean(m.histogram));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn series_keys() {
        let x: Vec<f64> = (0..40).map(f64::from).collect();
        let s = super::series(
            &x,
            &[
                (super::IndicatorKind::Sma, 20),
                (super::IndicatorKind::Bollinger, 20),
                (super::IndicatorKind::Macd, 0),
            ],
        );
        assert_eq!(s.len(), 7);
        assert_eq!(s["sma20"][19], Some(9.5));
        assert!(s.values().all(|v| v.len() == 40));
    }

    use super::*;

    #[test]
    fn sma_ema() {
        let x = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(
            sma(&x, 3),
            vec![None, None, Some(2.0), Some(3.0), Some(4.0)]
        );
        let e = ema(&x, 3);
        assert_eq!(e[2], Some(2.0));
        assert!((e[3].unwrap() - 3.0).abs() < 1e-12);
        assert!(sma(&x, 0).iter().all(Option::is_none));
        assert!(sma(&x, 9).iter().all(Option::is_none));
    }

    #[test]
    fn rsi_wilder_reference() {
        // Classic Wilder example closes (StockCharts RSI table: 70.53 and 66.32 with rounded intermediates;
        // exact arithmetic gives 70.46 and 66.25).
        let c = [
            44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03,
            45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
        ];
        let r = rsi(&c, 14);
        assert!(r[13].is_none());
        assert!((r[14].unwrap() - 70.46).abs() < 0.01, "{:?}", r[14]);
        assert!((r[15].unwrap() - 66.25).abs() < 0.01, "{:?}", r[15]);
        assert_eq!(rsi(&[1.0, 2.0, 3.0], 2)[2], Some(100.0));
    }

    #[test]
    fn bollinger_and_macd() {
        let x: Vec<f64> = (0..60)
            .map(|i| 100.0 + (i as f64 * 0.3).sin() * 5.0)
            .collect();
        let b = bollinger(&x, 20, 2.0);
        assert!(b.upper[18].is_none());
        for i in 19..60 {
            assert!(
                b.lower[i].unwrap() <= b.middle[i].unwrap()
                    && b.middle[i].unwrap() <= b.upper[i].unwrap()
            );
        }
        let m = macd(&x, 12, 26, 9);
        assert!(m.macd[24].is_none() && m.macd[25].is_some());
        assert!(m.signal[32].is_none() && m.signal[33].is_some());
        assert!(
            (m.histogram[40].unwrap() - (m.macd[40].unwrap() - m.signal[40].unwrap())).abs()
                < 1e-12
        );
    }
}
