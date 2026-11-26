//! Market data (SPEC §17.2): keyless and user-key providers behind [`MarketProvider`], and a
//! [`MarketRouter`] with user-reorderable fallback chains, caching (60 s quote TTL, immutable
//! closed daily bars) and data hygiene. Per-provider rate limits and circuit breakers live in
//! [`crate::netguard`].
//!
//! Providers see which symbols are looked up and the user's IP address; nothing else (no
//! quantities, cost basis, account names or balances) is ever sent.

pub mod cache;
pub mod coingecko;
pub mod finnhub;
pub mod frankfurter;
pub mod provider;
pub mod router;
pub mod stooq;
pub mod symbols;
pub mod tiingo;
#[cfg(feature = "yahoo")]
pub mod yahoo;

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

pub use cache::{Clock, ManualClock, SystemClock};
pub use provider::{MarketProvider, ProviderMeta};
pub use router::{Chains, KeyUpdate, LocalSymbolSearch, MarketRouter, RouterConfig};
pub use symbols::{ProviderSymbols, Symbol};

/// Capability flags (`ProviderInfo.caps`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    /// Latest price.
    Quote,
    /// Daily bars.
    Daily,
    /// Intraday bars (P1).
    Intraday,
    /// Symbol search.
    Search,
    /// FX rates.
    Fx,
    /// Crypto.
    Crypto,
    /// Dividends.
    Dividends,
}

/// Quote freshness badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    /// Real time.
    Live,
    /// Delayed by `delayedMin`.
    Delayed,
    /// End of day.
    Eod,
}

/// Market session state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketState {
    /// Pre-market.
    Pre,
    /// Regular session.
    Open,
    /// After hours.
    Post,
    /// Closed.
    Closed,
}

/// IPC `Quote` (SPEC §11.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// `TICKER:MIC`.
    pub symbol: String,
    /// Last price.
    pub price: f64,
    /// Absolute change vs previous close.
    pub change: f64,
    /// Percent change vs previous close.
    pub change_pct: f64,
    /// Session open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<f64>,
    /// Session high.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high: Option<f64>,
    /// Session low.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low: Option<f64>,
    /// Previous close.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_close: Option<f64>,
    /// Volume.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    /// Currency (ISO 4217, `GBX` for pence-quoted London listings).
    pub currency: String,
    /// Session state.
    pub market_state: MarketState,
    /// Unix epoch milliseconds of the price.
    pub as_of: i64,
    /// Provider id.
    pub source: String,
    /// Freshness badge.
    pub freshness: Freshness,
    /// Minutes of delay (0 for live/EOD).
    pub delayed_min: u32,
}

impl Quote {
    /// Whether every number is finite and the price positive.
    pub fn is_sane(&self) -> bool {
        self.price.is_finite()
            && self.price > 0.0
            && self.change.is_finite()
            && self.change_pct.is_finite()
            && [self.open, self.high, self.low, self.prev_close, self.volume]
                .iter()
                .flatten()
                .all(|v| v.is_finite())
    }
}

/// One daily bar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bar {
    /// Trading date.
    pub date: NaiveDate,
    /// Open.
    pub open: f64,
    /// High.
    pub high: f64,
    /// Low.
    pub low: f64,
    /// Close (raw).
    pub close: f64,
    /// Volume.
    pub volume: f64,
    /// Adjusted close, when the provider supplies one.
    pub adj_close: Option<f64>,
    /// Cash dividend with ex-date on this bar.
    pub dividend: Option<f64>,
    /// Split factor on this bar (≠ 1 means a split).
    pub split: Option<f64>,
}

impl Bar {
    /// Whether all prices are finite and non-negative.
    pub fn is_finite(&self) -> bool {
        [self.open, self.high, self.low, self.close, self.volume]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0)
            && self.adj_close.is_none_or(f64::is_finite)
    }

    /// A bar with only a close (crypto/FX series).
    pub fn close_only(date: NaiveDate, close: f64, volume: f64) -> Self {
        Bar {
            date,
            open: close,
            high: close,
            low: close,
            close,
            volume,
            adj_close: None,
            dividend: None,
            split: None,
        }
    }
}

/// IPC bars (`market_bars`). `t` is Unix epoch **milliseconds** at 00:00 UTC of each bar's
/// first trading date.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bars {
    /// Times.
    pub t: Vec<i64>,
    /// Opens.
    pub o: Vec<f64>,
    /// Highs.
    pub h: Vec<f64>,
    /// Lows.
    pub l: Vec<f64>,
    /// Closes.
    pub c: Vec<f64>,
    /// Volumes.
    pub v: Vec<f64>,
    /// Currency.
    pub currency: String,
    /// Provider id.
    pub source: String,
    /// Served from cache after a failed refresh.
    pub stale: bool,
}

/// Bar interval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BarInterval {
    /// Daily.
    #[serde(rename = "1d")]
    Day,
    /// Weekly (ISO weeks).
    #[serde(rename = "1wk")]
    Week,
    /// Monthly.
    #[serde(rename = "1mo")]
    Month,
}

/// Instrument type (`market_search`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstrumentType {
    /// Stock.
    Equity,
    /// ETF.
    Etf,
    /// Mutual fund.
    Fund,
    /// Crypto asset.
    Crypto,
    /// Currency pair.
    Fx,
    /// Index.
    Index,
}

/// One search hit (IPC `market_search` result item).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// `TICKER:MIC`.
    pub symbol: String,
    /// Display name.
    pub name: String,
    /// Exchange label.
    pub exchange: String,
    /// Instrument type.
    #[serde(rename = "type")]
    pub kind: InstrumentType,
    /// Trading currency.
    pub currency: String,
}

/// IPC `fx_rates` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxRates {
    /// Base currency.
    pub base: String,
    /// Rate date (`YYYY-MM-DD`).
    pub date: String,
    /// Units of each currency per 1 base.
    pub rates: BTreeMap<String, f64>,
    /// Provider id.
    pub source: String,
    /// Served from cache after a failed refresh.
    pub stale: bool,
}

/// A cash dividend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dividend {
    /// Ex-dividend date.
    pub ex_date: NaiveDate,
    /// Amount per share.
    pub amount: f64,
    /// Currency.
    pub currency: String,
    /// Pay date, if known.
    pub pay_date: Option<NaiveDate>,
}

/// IPC `ProviderInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// Provider id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Requires a user API key.
    pub needs_key: bool,
    /// Ready to use (key present when needed).
    pub configured: bool,
    /// Enabled by the user.
    pub enabled: bool,
    /// Terms of use.
    pub terms_url: String,
    /// "Community source" label (unofficial).
    pub community: bool,
    /// Capabilities.
    pub caps: Vec<Capability>,
    /// Human rate limit.
    pub rate_limit: String,
    /// `ok`/`degraded`/`down`/`unknown`.
    pub health: crate::netguard::Health,
}

/// Midnight UTC of `date` in epoch milliseconds.
pub fn date_to_millis(date: NaiveDate) -> i64 {
    date.and_hms_opt(0, 0, 0)
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0)
}

/// Epoch seconds → UTC datetime (clamped to the epoch on overflow).
pub(crate) fn from_unix(secs: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(secs, 0).unwrap_or_default()
}

/// Percent change helper returning 0 when `prev` is not positive.
pub(crate) fn pct(change: f64, prev: f64) -> f64 {
    if prev > 0.0 && prev.is_finite() {
        change / prev * 100.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_shapes() {
        let q = Quote {
            symbol: "AAPL:XNAS".into(),
            price: 1.0,
            change: 0.0,
            change_pct: 0.0,
            open: None,
            high: None,
            low: None,
            prev_close: Some(1.0),
            volume: None,
            currency: "USD".into(),
            market_state: MarketState::Closed,
            as_of: 0,
            source: "stooq".into(),
            freshness: Freshness::Eod,
            delayed_min: 0,
        };
        let v = serde_json::to_value(&q).unwrap();
        assert_eq!(v["changePct"], 0.0);
        assert_eq!(v["prevClose"], 1.0);
        assert_eq!(v["marketState"], "closed");
        assert!(v.get("open").is_none());
        assert!(q.is_sane());
        let s = SearchResult {
            symbol: "BTC:CRYPTO".into(),
            name: "Bitcoin".into(),
            exchange: "CRYPTO".into(),
            kind: InstrumentType::Crypto,
            currency: "USD".into(),
        };
        assert_eq!(serde_json::to_value(&s).unwrap()["type"], "crypto");
        assert_eq!(
            serde_json::to_string(&BarInterval::Week).unwrap(),
            "\"1wk\""
        );
        assert_eq!(
            date_to_millis(NaiveDate::from_ymd_opt(1970, 1, 2).unwrap()),
            86_400_000
        );
    }
}
