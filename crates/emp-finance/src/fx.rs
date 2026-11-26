//! FX conversion (§15.1). Rates are injected (from the market cache); this module never fetches.

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};
use crate::money::{Currency, Money, normalize};

/// One day's rates: `1 base = rates[code] code`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateTable {
    /// Base currency.
    pub base: Currency,
    /// Rate date.
    pub date: NaiveDate,
    /// Quote currency → units per 1 base.
    pub rates: HashMap<String, Decimal>,
    /// Provider id (e.g. `frankfurter`).
    pub source: String,
}

/// A collection of dated rate tables; lookups use the latest table on or before the requested date.
#[derive(Debug, Clone, Default)]
pub struct FxRates {
    tables: BTreeMap<NaiveDate, Vec<RateTable>>,
}

/// Provenance of a conversion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateInfo {
    /// Units of target per unit of source.
    pub rate: Decimal,
    /// Date of the rate table used.
    pub rate_date: NaiveDate,
    /// Provider id, or `"identity"` for same-currency conversions.
    pub source: String,
}

/// A converted figure that always keeps the original alongside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    /// The input amount.
    pub original: Money,
    /// The converted amount (scale ≤ 8, unrounded beyond that).
    pub converted: Money,
    /// Rate provenance.
    #[serde(flatten)]
    pub info: RateInfo,
}

impl FxRates {
    /// Empty rate set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a rate table.
    pub fn insert(&mut self, table: RateTable) {
        self.tables.entry(table.date).or_default().push(table);
    }

    /// Finds `1 from = x to` using the latest table on or before `date` that can price both
    /// currencies (directly or through its base).
    pub fn rate(&self, from: &Currency, to: &Currency, date: NaiveDate) -> Result<RateInfo> {
        if from == to {
            return Ok(RateInfo {
                rate: Decimal::ONE,
                rate_date: date,
                source: "identity".into(),
            });
        }
        for (d, tables) in self.tables.range(..=date).rev() {
            for t in tables {
                if let Some(r) = cross(t, from, to) {
                    return Ok(RateInfo {
                        rate: normalize(r),
                        rate_date: *d,
                        source: t.source.clone(),
                    });
                }
            }
        }
        Err(FinanceError::MissingRate {
            from: from.to_string(),
            to: to.to_string(),
            date: date.to_string(),
        })
    }
}

fn units_per_base(t: &RateTable, c: &Currency) -> Option<Decimal> {
    if &t.base == c {
        return Some(Decimal::ONE);
    }
    t.rates
        .get(c.code())
        .copied()
        .filter(|r| *r > Decimal::ZERO)
}

fn cross(t: &RateTable, from: &Currency, to: &Currency) -> Option<Decimal> {
    let f = units_per_base(t, from)?;
    let to_u = units_per_base(t, to)?;
    to_u.checked_div(f)
}

/// Converts `m` into `to` using rates on or before `date`.
pub fn convert(m: &Money, to: &Currency, date: NaiveDate, rates: &FxRates) -> Result<Converted> {
    let info = rates.rate(&m.currency, to, date)?;
    let amount = m
        .amount
        .checked_mul(info.rate)
        .ok_or_else(|| FinanceError::invalid("FX conversion overflow"))?;
    Ok(Converted {
        original: m.clone(),
        converted: Money::new(amount, to.clone()),
        info,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::parse_decimal;

    fn table(date: &str, rates: &[(&str, &str)]) -> RateTable {
        RateTable {
            base: Currency::new("EUR").unwrap(),
            date: date.parse().unwrap(),
            rates: rates
                .iter()
                .map(|(k, v)| (k.to_string(), parse_decimal(v).unwrap()))
                .collect(),
            source: "frankfurter".into(),
        }
    }

    #[test]
    fn direct_cross_and_latest() {
        let mut fx = FxRates::new();
        fx.insert(table("2026-01-02", &[("USD", "1.10"), ("GBP", "0.85")]));
        fx.insert(table("2026-01-05", &[("USD", "1.20")]));
        let usd = Currency::new("USD").unwrap();
        let eur = Currency::new("EUR").unwrap();

        let c = convert(
            &Money::parse("100", "EUR").unwrap(),
            &usd,
            "2026-01-04".parse().unwrap(),
            &fx,
        )
        .unwrap();
        assert_eq!(c.converted.amount, parse_decimal("110.00").unwrap());
        assert_eq!(c.info.rate_date.to_string(), "2026-01-02");
        assert_eq!(c.original.amount, parse_decimal("100").unwrap());

        let c = convert(
            &Money::parse("120", "USD").unwrap(),
            &eur,
            "2026-02-01".parse().unwrap(),
            &fx,
        )
        .unwrap();
        assert_eq!(
            c.converted.amount.round_dp(2),
            parse_decimal("100").unwrap()
        );

        // GBP only exists in the older table: falls back to it.
        let c = convert(
            &Money::parse("85", "GBP").unwrap(),
            &usd,
            "2026-02-01".parse().unwrap(),
            &fx,
        )
        .unwrap();
        assert_eq!(
            c.converted.amount.round_dp(2),
            parse_decimal("110").unwrap()
        );
        assert!(
            convert(
                &Money::parse("1", "USD").unwrap(),
                &eur,
                "2025-01-01".parse().unwrap(),
                &fx
            )
            .is_err()
        );
        let id = convert(
            &Money::parse("5", "USD").unwrap(),
            &usd,
            "2020-01-01".parse().unwrap(),
            &fx,
        )
        .unwrap();
        assert_eq!(id.info.source, "identity");
    }
}
