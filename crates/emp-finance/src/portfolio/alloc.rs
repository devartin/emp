//! Allocation and drift (§15.7). Percentages are in percent units (0–100); drift is current − target in
//! percentage points. A class is outside its band when `|drift| > band_abs` (default 5 pp) or
//! `|drift| > band_rel × target` (default 25%).

use std::collections::{BTreeMap, BTreeSet};

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};
use crate::money::to_f64;

/// Default absolute band (pp).
pub const DEFAULT_BAND_ABS: f64 = 5.0;
/// Default relative band (fraction of target).
pub const DEFAULT_BAND_REL: f64 = 0.25;

/// A target allocation row (`alloc.*` roles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Asset class.
    pub asset_class: String,
    /// Target percent (0–100).
    pub target: f64,
    /// Absolute band in pp.
    #[serde(default)]
    pub band_abs: Option<f64>,
    /// Relative band as a fraction of target.
    #[serde(default)]
    pub band_rel: Option<f64>,
}

/// Band status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BandStatus {
    /// Within band.
    Ok,
    /// Outside band.
    OutsideBand,
}

/// An allocation row (IPC `portfolio_summary.allocation[]` plus value).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationRow {
    /// Asset class.
    pub asset_class: String,
    /// Current percent.
    pub current: f64,
    /// Target percent.
    pub target: f64,
    /// Drift in pp.
    pub drift: f64,
    /// Band status.
    pub status: BandStatus,
    /// Current value.
    pub value: Decimal,
}

/// Validates that targets are finite, non-negative, unique and sum to 100 (±0.01).
pub fn validate_targets(targets: &[Target]) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut sum = 0.0;
    for t in targets {
        if !t.target.is_finite() || t.target < 0.0 || t.target > 100.0 {
            return Err(FinanceError::invalid(format!(
                "{}: target must be 0–100%",
                t.asset_class
            )));
        }
        if t.band_abs.is_some_and(|b| !b.is_finite() || b < 0.0)
            || t.band_rel.is_some_and(|b| !b.is_finite() || b < 0.0)
        {
            return Err(FinanceError::invalid(format!(
                "{}: bands must be ≥ 0",
                t.asset_class
            )));
        }
        if !seen.insert(t.asset_class.as_str()) {
            return Err(FinanceError::invalid(format!(
                "duplicate class {}",
                t.asset_class
            )));
        }
        sum += t.target;
    }
    if (sum - 100.0).abs() > 0.01 {
        return Err(FinanceError::invalid(format!(
            "targets sum to {sum:.2}%, not 100%"
        )));
    }
    Ok(())
}

/// Whether `drift` is outside the band for `t`.
pub fn outside_band(drift: f64, target: f64, band_abs: Option<f64>, band_rel: Option<f64>) -> bool {
    let a = drift.abs();
    a > band_abs.unwrap_or(DEFAULT_BAND_ABS) + 1e-9
        || a > band_rel.unwrap_or(DEFAULT_BAND_REL) * target + 1e-9
}

/// Current vs target by class. Classes without a target get target 0; targets without holdings get 0%.
pub fn allocation(
    class_values: &BTreeMap<String, Decimal>,
    targets: &[Target],
) -> Vec<AllocationRow> {
    let total: Decimal = class_values
        .values()
        .copied()
        .filter(|v| *v > Decimal::ZERO)
        .sum();
    let mut classes: BTreeSet<&str> = class_values.keys().map(String::as_str).collect();
    classes.extend(targets.iter().map(|t| t.asset_class.as_str()));
    let mut rows: Vec<AllocationRow> = classes
        .into_iter()
        .map(|c| {
            let value = class_values.get(c).copied().unwrap_or_default();
            let current = if total.is_zero() {
                0.0
            } else {
                to_f64(value.max(Decimal::ZERO) / total) * 100.0
            };
            let t = targets.iter().find(|t| t.asset_class == c);
            let target = t.map_or(0.0, |t| t.target);
            let drift = current - target;
            let out = outside_band(
                drift,
                target,
                t.and_then(|t| t.band_abs),
                t.and_then(|t| t.band_rel),
            );
            AllocationRow {
                asset_class: c.to_string(),
                current,
                target,
                drift,
                status: if out {
                    BandStatus::OutsideBand
                } else {
                    BandStatus::Ok
                },
                value,
            }
        })
        .collect();
    // Target order first (as the user arranged them), then the rest alphabetically.
    rows.sort_by_key(|r| {
        targets
            .iter()
            .position(|t| t.asset_class == r.asset_class)
            .unwrap_or(usize::MAX)
    });
    rows
}

/// Largest absolute drift (pp).
pub fn max_drift(rows: &[AllocationRow]) -> f64 {
    rows.iter().map(|r| r.drift.abs()).fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::dec;

    fn t(c: &str, p: f64) -> Target {
        Target {
            asset_class: c.into(),
            target: p,
            band_abs: None,
            band_rel: None,
        }
    }

    #[test]
    fn drift_and_bands() {
        let values: BTreeMap<String, Decimal> = [
            ("US equity".to_string(), dec("6600")),
            ("Bonds".to_string(), dec("3000")),
            ("Crypto".to_string(), dec("400")),
        ]
        .into();
        let targets = vec![t("US equity", 60.0), t("Bonds", 35.0), t("Cash", 5.0)];
        validate_targets(&targets).unwrap();
        let rows = allocation(&values, &targets);
        assert_eq!(
            rows.iter()
                .map(|r| r.asset_class.as_str())
                .collect::<Vec<_>>(),
            ["US equity", "Bonds", "Cash", "Crypto"]
        );
        let us = &rows[0];
        assert!((us.current - 66.0).abs() < 1e-9 && (us.drift - 6.0).abs() < 1e-9);
        assert_eq!(us.status, BandStatus::OutsideBand);
        assert_eq!(rows[1].status, BandStatus::Ok); // −5 pp is not > 5
        // Cash: −5 pp vs 25% × 5 = 1.25 → outside by the relative band.
        assert_eq!(rows[2].status, BandStatus::OutsideBand);
        assert_eq!(rows[3].target, 0.0);
        assert!((max_drift(&rows) - 6.0).abs() < 1e-9);
    }

    #[test]
    fn validation() {
        assert!(validate_targets(&[t("A", 50.0), t("B", 49.0)]).is_err());
        assert!(validate_targets(&[t("A", 50.0), t("A", 50.0)]).is_err());
        assert!(validate_targets(&[t("A", 100.0)]).is_ok());
        assert!(validate_targets(&[t("A", f64::NAN)]).is_err());
    }
}
