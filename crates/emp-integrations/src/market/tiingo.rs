//! Tiingo (user key, `Authorization: Token …`): adjusted daily history (preferred source),
//! dividends, search.

use async_trait::async_trait;
use chrono::NaiveDate;
use parking_lot::RwLock;
use serde::Deserialize;
use url::Url;

use super::provider::{MarketProvider, ProviderMeta};
use super::symbols::tiingo_symbol;
use super::{Bar, Capability, Dividend, InstrumentType, SearchResult, Symbol};
use crate::error::{IntegrationError, Result};
use crate::netguard::{BodyCap, ConnectorId, Credential, NetGuard, NetRequest};
use crate::secret::SecretString;

const BASE: &str = "https://api.tiingo.com";

fn url(path: &str) -> Result<Url> {
    Url::parse(&format!("{BASE}{path}")).map_err(|e| IntegrationError::Internal(e.to_string()))
}

fn valid_ticker(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 20
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// `/tiingo/daily/{ticker}/prices?startDate&endDate`.
pub fn prices_request(
    ticker: &str,
    from: NaiveDate,
    to: NaiveDate,
    key: &SecretString,
) -> Result<NetRequest> {
    if !valid_ticker(ticker) {
        return Err(IntegrationError::Invalid("invalid tiingo ticker".into()));
    }
    let mut u = url(&format!(
        "/tiingo/daily/{}/prices",
        ticker.to_ascii_lowercase()
    ))?;
    u.query_pairs_mut()
        .append_pair("startDate", &from.format("%Y-%m-%d").to_string())
        .append_pair("endDate", &to.format("%Y-%m-%d").to_string())
        .append_pair("resampleFreq", "daily")
        .append_pair("format", "json");
    Ok(
        NetRequest::get(ConnectorId::Tiingo, u, "/tiingo/daily/{ticker}/prices")
            .credential(Credential::token(key))
            .cap(BodyCap::MarketHistory),
    )
}

/// `/tiingo/utilities/search?query=`.
pub fn search_request(query: &str, key: &SecretString) -> Result<NetRequest> {
    let mut u = url("/tiingo/utilities/search")?;
    u.query_pairs_mut().append_pair("query", query);
    Ok(
        NetRequest::get(ConnectorId::Tiingo, u, "/tiingo/utilities/search")
            .credential(Credential::token(key)),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrice {
    date: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    #[serde(default)]
    volume: f64,
    adj_open: Option<f64>,
    adj_high: Option<f64>,
    adj_low: Option<f64>,
    adj_close: Option<f64>,
    adj_volume: Option<f64>,
    div_cash: Option<f64>,
    split_factor: Option<f64>,
}

#[derive(Deserialize)]
struct RawDetail {
    detail: String,
}

fn detail_error(body: &[u8]) -> Option<IntegrationError> {
    let d: RawDetail = serde_json::from_slice(body).ok()?;
    let lower = d.detail.to_ascii_lowercase();
    Some(if lower.contains("not found") {
        IntegrationError::NotFound(crate::error::short_message(&d.detail))
    } else if lower.contains("limit") {
        IntegrationError::Quota(crate::error::short_message(&d.detail))
    } else {
        IntegrationError::Provider(crate::error::short_message(&d.detail))
    })
}

/// Parse daily prices. With `adjusted`, OHLCV are the adjusted series.
pub fn parse_prices(body: &[u8], adjusted: bool) -> Result<Vec<Bar>> {
    if let Some(e) = detail_error(body) {
        return Err(e);
    }
    let raw: Vec<RawPrice> = crate::netguard::decode_json(body)?;
    let mut bars: Vec<Bar> = raw
        .into_iter()
        .filter_map(|p| {
            let date = NaiveDate::parse_from_str(p.date.get(..10)?, "%Y-%m-%d").ok()?;
            let pick = |adj: Option<f64>, raw: f64| if adjusted { adj.unwrap_or(raw) } else { raw };
            let bar = Bar {
                date,
                open: pick(p.adj_open, p.open),
                high: pick(p.adj_high, p.high),
                low: pick(p.adj_low, p.low),
                close: pick(p.adj_close, p.close),
                volume: pick(p.adj_volume, p.volume),
                adj_close: p.adj_close,
                dividend: p.div_cash.filter(|d| *d > 0.0 && d.is_finite()),
                split: p
                    .split_factor
                    .filter(|s| (*s - 1.0).abs() > 1e-12 && s.is_finite()),
            };
            bar.is_finite().then_some(bar)
        })
        .collect();
    bars.sort_by_key(|b| b.date);
    Ok(bars)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHit {
    ticker: String,
    name: Option<String>,
    asset_type: Option<String>,
    country_code: Option<String>,
    #[serde(default = "yes")]
    is_active: bool,
}

fn yes() -> bool {
    true
}

/// Parse search hits (active US listings only).
pub fn parse_search(body: &[u8], limit: usize) -> Result<Vec<SearchResult>> {
    if let Some(e) = detail_error(body) {
        return Err(e);
    }
    let raw: Vec<RawHit> = crate::netguard::decode_json(body)?;
    Ok(raw
        .into_iter()
        .filter(|h| {
            h.is_active
                && h.country_code
                    .as_deref()
                    .is_none_or(|c| c.eq_ignore_ascii_case("US"))
        })
        .filter_map(|h| {
            let symbol = Symbol::parse(&format!("{}:XNAS", h.ticker.replace('-', "."))).ok()?;
            let kind = match h.asset_type.as_deref() {
                Some("ETF") => InstrumentType::Etf,
                Some("Mutual Fund") => InstrumentType::Fund,
                _ => InstrumentType::Equity,
            };
            Some(SearchResult {
                symbol: symbol.key(),
                name: h.name.unwrap_or_else(|| h.ticker.clone()),
                exchange: "US".into(),
                kind,
                currency: "USD".into(),
            })
        })
        .take(limit)
        .collect())
}

/// Tiingo provider.
#[derive(Debug)]
pub struct Tiingo {
    guard: NetGuard,
    key: RwLock<Option<SecretString>>,
}

impl Tiingo {
    /// New provider without a key.
    pub fn new(guard: NetGuard) -> Self {
        Tiingo {
            guard,
            key: RwLock::new(None),
        }
    }

    fn key(&self) -> Result<SecretString> {
        self.key
            .read()
            .clone()
            .ok_or_else(|| IntegrationError::Unsupported("tiingo needs an API key".into()))
    }
}

#[async_trait]
impl MarketProvider for Tiingo {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "tiingo",
            name: "Tiingo",
            connector: ConnectorId::Tiingo,
            needs_key: true,
            terms_url: "https://www.tiingo.com/about/terms",
            community: false,
            caps: &[Capability::Daily, Capability::Dividends, Capability::Search],
            default_enabled: true,
        }
    }

    fn configured(&self) -> bool {
        self.key.read().as_ref().is_some_and(|k| !k.is_empty())
    }

    fn set_api_key(&self, key: Option<SecretString>) {
        *self.key.write() = key.filter(|k| !k.is_empty());
    }

    fn map_symbol(&self, symbol: &Symbol, override_symbol: Option<&str>) -> Option<String> {
        override_symbol
            .map(str::to_string)
            .or_else(|| tiingo_symbol(symbol))
    }

    async fn daily(
        &self,
        _symbol: &Symbol,
        provider_symbol: &str,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Bar>> {
        let resp = self
            .guard
            .send(prices_request(provider_symbol, from, to, &self.key()?)?)
            .await?;
        if resp.status == 404 {
            return Err(detail_error(&resp.body)
                .unwrap_or_else(|| IntegrationError::NotFound(provider_symbol.to_string())));
        }
        parse_prices(&resp.error_for_status()?.body, adjusted)
    }

    async fn dividends(
        &self,
        symbol: &Symbol,
        provider_symbol: &str,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<Dividend>> {
        let bars = self.daily(symbol, provider_symbol, from, to, false).await?;
        Ok(bars
            .into_iter()
            .filter_map(|b| {
                b.dividend.map(|amount| Dividend {
                    ex_date: b.date,
                    amount,
                    currency: "USD".into(),
                    pay_date: None,
                })
            })
            .collect())
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let resp = self
            .guard
            .send(search_request(query, &self.key()?)?)
            .await?
            .error_for_status()?;
        parse_search(&resp.body, limit)
    }

    async fn ping(&self) -> Result<()> {
        self.search("spy", 1).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRICES: &str = r#"[
      {"date":"2026-11-20T00:00:00.000Z","close":228.0,"high":229.0,"low":226.5,"open":227.1,"volume":51234567,
       "adjClose":227.5,"adjHigh":228.5,"adjLow":226.0,"adjOpen":226.6,"adjVolume":51234567,"divCash":0.0,"splitFactor":1.0},
      {"date":"2026-11-21T00:00:00.000Z","close":230.0,"high":231.0,"low":228.0,"open":228.5,"volume":40000000,
       "adjClose":230.0,"adjHigh":231.0,"adjLow":228.0,"adjOpen":228.5,"adjVolume":40000000,"divCash":0.26,"splitFactor":1.0}
    ]"#;

    #[test]
    fn parses_prices_raw_and_adjusted() {
        let raw = parse_prices(PRICES.as_bytes(), false).unwrap();
        assert_eq!(raw[0].close, 228.0);
        assert_eq!(raw[0].adj_close, Some(227.5));
        assert_eq!(raw[0].dividend, None);
        assert_eq!(raw[1].dividend, Some(0.26));
        assert_eq!(raw[1].split, None);
        let adj = parse_prices(PRICES.as_bytes(), true).unwrap();
        assert_eq!(adj[0].close, 227.5);
        assert_eq!(adj[0].open, 226.6);
    }

    #[test]
    fn detail_errors() {
        assert!(matches!(
            parse_prices(br#"{"detail":"Error: Ticker 'XYZQ' not found"}"#, false).unwrap_err(),
            IntegrationError::NotFound(_)
        ));
        assert!(matches!(
            parse_prices(
                br#"{"detail":"Error: You have run over your hourly request allocation limit"}"#,
                false
            )
            .unwrap_err(),
            IntegrationError::Quota(_)
        ));
    }

    #[test]
    fn parses_search() {
        let r = parse_search(
            br#"[{"ticker":"AAPL","name":"Apple Inc","assetType":"Stock","isActive":true,"countryCode":"US"},
                {"ticker":"BRK-B","name":"Berkshire","assetType":"Stock","isActive":true,"countryCode":"US"},
                {"ticker":"OLD","name":"Gone","assetType":"Stock","isActive":false,"countryCode":"US"},
                {"ticker":"SPY","name":"SPDR","assetType":"ETF","isActive":true,"countryCode":"US"}]"#,
            10,
        )
        .unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[1].symbol, "BRK.B:XNAS");
        assert_eq!(r[2].kind, InstrumentType::Etf);
    }

    #[test]
    fn request_uses_token_header() {
        let r = prices_request(
            "BRK-B",
            NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
            &SecretString::new("k"),
        )
        .unwrap();
        assert_eq!(r.url.path(), "/tiingo/daily/brk-b/prices");
        assert_eq!(r.credential.as_ref().unwrap().value.expose(), "Token k");
        assert!(
            prices_request(
                "../x",
                NaiveDate::MIN,
                NaiveDate::MIN,
                &SecretString::new("k")
            )
            .is_err()
        );
    }
}
