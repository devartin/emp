//! Holdings valuation: market value, unrealised gain, weights, day change and price staleness.

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::lots::LotBook;
use crate::money::to_f64;

/// Prices older than this many days are stale (`stale-prices` advisor rule).
pub const STALE_PRICE_DAYS: i64 = 3;

/// A cached quote.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceQuote {
    /// Last price.
    pub price: Decimal,
    /// Previous close, for day change.
    #[serde(default)]
    pub prev_close: Option<Decimal>,
    /// Quote date.
    pub as_of: NaiveDate,
}

/// Security reference data (`sec.*` roles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityInfo {
    /// Symbol key.
    pub symbol: String,
    /// Name.
    pub name: String,
    /// Asset class (`sec.class`).
    pub asset_class: String,
    /// Expense ratio as a fraction (0.0003 = 0.03%).
    #[serde(default)]
    pub expense_ratio: Option<Decimal>,
}

/// A holding aggregated across accounts (IPC `portfolio_summary.holdings[]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    /// Symbol.
    pub symbol: String,
    /// Name.
    pub name: String,
    /// Quantity.
    pub qty: Decimal,
    /// Last price (`None` when unpriced).
    pub price: Option<Decimal>,
    /// Market value (cost basis when unpriced).
    pub value: Decimal,
    /// Cost basis.
    pub cost_basis: Decimal,
    /// Unrealised gain.
    pub gain: Decimal,
    /// Gain / basis.
    pub gain_pct: f64,
    /// Share of portfolio value.
    pub weight: f64,
    /// Day change (fraction).
    pub day_pct: Option<f64>,
    /// Price missing or older than [`STALE_PRICE_DAYS`].
    pub stale: bool,
    /// Asset class (`"Other"` when unknown).
    pub asset_class: String,
    /// Value per account.
    pub by_account: BTreeMap<String, Decimal>,
}

/// Portfolio totals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Valuation {
    /// Holdings, largest value first.
    pub holdings: Vec<Holding>,
    /// Total value.
    pub total_value: Decimal,
    /// Total basis.
    pub total_basis: Decimal,
    /// Unrealised gain.
    pub unrealized: Decimal,
    /// Day change in money.
    pub day_change: Decimal,
    /// Day change as a fraction of the previous value.
    pub day_change_pct: f64,
    /// Estimated annual fund fees (Σ value × expense ratio).
    pub fees_per_year: Decimal,
}

/// Values the open lots with `prices` keyed by symbol.
pub fn value(
    book: &LotBook,
    prices: &HashMap<String, PriceQuote>,
    securities: &HashMap<String, SecurityInfo>,
    today: NaiveDate,
) -> Valuation {
    struct Acc {
        qty: Decimal,
        basis: Decimal,
        by_account: BTreeMap<String, (Decimal, Decimal)>,
    }
    let mut agg: BTreeMap<String, Acc> = BTreeMap::new();
    for l in &book.lots {
        let a = agg.entry(l.security.clone()).or_insert(Acc {
            qty: Decimal::ZERO,
            basis: Decimal::ZERO,
            by_account: BTreeMap::new(),
        });
        a.qty += l.qty;
        a.basis += l.basis;
        let e = a.by_account.entry(l.account_id.clone()).or_default();
        e.0 += l.qty;
        e.1 += l.basis;
    }
    let mut holdings = Vec::new();
    let mut total = Decimal::ZERO;
    let mut prev_total = Decimal::ZERO;
    let mut fees = Decimal::ZERO;
    for (sym, a) in agg {
        let q = prices.get(&sym);
        let info = securities.get(&sym);
        let price = q.map(|q| q.price);
        let value = price.map_or(a.basis, |p| p * a.qty);
        let stale = q.is_none_or(|q| (today - q.as_of).num_days() > STALE_PRICE_DAYS);
        let prev = q.and_then(|q| q.prev_close).map_or(value, |pc| pc * a.qty);
        let day_pct = q
            .and_then(|q| q.prev_close)
            .filter(|pc| !pc.is_zero())
            .map(|pc| to_f64((q.map_or(pc, |q| q.price) - pc) / pc));
        if let Some(er) = info.and_then(|i| i.expense_ratio) {
            fees += value * er;
        }
        total += value;
        prev_total += prev;
        let gain = value - a.basis;
        holdings.push(Holding {
            name: info.map_or_else(|| sym.clone(), |i| i.name.clone()),
            asset_class: info.map_or_else(|| "Other".to_string(), |i| i.asset_class.clone()),
            symbol: sym,
            qty: a.qty,
            price,
            value,
            cost_basis: a.basis,
            gain,
            gain_pct: if a.basis.is_zero() {
                0.0
            } else {
                to_f64(gain / a.basis)
            },
            weight: 0.0,
            day_pct,
            stale,
            by_account: a
                .by_account
                .into_iter()
                .map(|(k, (q, b))| (k, price.map_or(b, |p| p * q)))
                .collect(),
        });
    }
    for h in &mut holdings {
        h.weight = if total.is_zero() {
            0.0
        } else {
            to_f64(h.value / total)
        };
    }
    holdings.sort_by(|a, b| b.value.cmp(&a.value).then_with(|| a.symbol.cmp(&b.symbol)));
    let total_basis: Decimal = holdings.iter().map(|h| h.cost_basis).sum();
    Valuation {
        holdings,
        total_value: total,
        total_basis,
        unrealized: total - total_basis,
        day_change: total - prev_total,
        day_change_pct: if prev_total.is_zero() {
            0.0
        } else {
            to_f64((total - prev_total) / prev_total)
        },
        fees_per_year: fees,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::lots::Lot;
    use crate::testutil::dec;

    #[test]
    fn valuation() {
        let lot = |acct: &str, sec: &str, q: &str, b: &str| Lot {
            source_id: "x".into(),
            account_id: acct.into(),
            security: sec.into(),
            acquired: "2025-01-01".parse().unwrap(),
            qty: dec(q),
            basis: dec(b),
        };
        let book = LotBook {
            lots: vec![
                lot("a", "VTI", "10", "2000"),
                lot("b", "VTI", "5", "1000"),
                lot("a", "BND", "20", "1500"),
            ],
            ..LotBook::default()
        };
        let today: NaiveDate = "2026-03-10".parse().unwrap();
        let prices: HashMap<String, PriceQuote> = [
            (
                "VTI".to_string(),
                PriceQuote {
                    price: dec("300"),
                    prev_close: Some(dec("297")),
                    as_of: today,
                },
            ),
            (
                "BND".to_string(),
                PriceQuote {
                    price: dec("75"),
                    prev_close: None,
                    as_of: "2026-03-01".parse().unwrap(),
                },
            ),
        ]
        .into();
        let secs: HashMap<String, SecurityInfo> = [(
            "VTI".to_string(),
            SecurityInfo {
                symbol: "VTI".into(),
                name: "Total Market".into(),
                asset_class: "US equity".into(),
                expense_ratio: Some(dec("0.0003")),
            },
        )]
        .into();
        let v = value(&book, &prices, &secs, today);
        assert_eq!(v.total_value, dec("6000"));
        assert_eq!(v.unrealized, dec("1500"));
        assert_eq!(v.holdings[0].symbol, "VTI");
        assert!((v.holdings[0].weight - 0.75).abs() < 1e-12);
        assert_eq!(v.holdings[0].by_account["b"], dec("1500"));
        assert!(!v.holdings[0].stale);
        assert!(v.holdings[1].stale);
        assert_eq!(v.holdings[1].asset_class, "Other");
        assert_eq!(v.day_change, dec("45"));
        assert_eq!(v.fees_per_year, dec("1.3500"));
    }
}
