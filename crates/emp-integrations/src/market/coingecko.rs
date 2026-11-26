//! CoinGecko public API (keyless, optional Demo key in `x-cg-demo-api-key`).

use std::collections::{BTreeMap, HashMap};

use async_trait::async_trait;
use chrono::{NaiveDate, Utc};
use parking_lot::RwLock;
use serde::Deserialize;
use url::Url;

use super::provider::{MarketProvider, ProviderMeta};
use super::symbols::coingecko_id;
use super::{
    Bar, Capability, Freshness, InstrumentType, MarketState, Quote, SearchResult, Symbol, from_unix,
};
use crate::error::{IntegrationError, Result};
use crate::netguard::{BodyCap, ConnectorId, Credential, NetGuard, NetRequest};
use crate::secret::SecretString;

const BASE: &str = "https://api.coingecko.com/api/v3";
/// Quote currency for crypto prices.
pub const VS_CURRENCY: &str = "usd";
/// Public/Demo plans only serve the last 365 days of history.
pub const MAX_HISTORY_DAYS: i64 = 365;

fn url(path: &str) -> Result<Url> {
    Url::parse(&format!("{BASE}{path}")).map_err(|e| IntegrationError::Internal(e.to_string()))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn with_key(req: NetRequest, key: Option<&SecretString>) -> NetRequest {
    match key {
        Some(k) => req.credential(Credential::header("x-cg-demo-api-key", k)),
        None => req,
    }
}

/// `/simple/price` for several ids.
pub fn price_request(ids: &[&str], key: Option<&SecretString>) -> Result<NetRequest> {
    if ids.is_empty() || !ids.iter().all(|i| valid_id(i)) {
        return Err(IntegrationError::Invalid("invalid coin id".into()));
    }
    let mut u = url("/simple/price")?;
    u.query_pairs_mut()
        .append_pair("ids", &ids.join(","))
        .append_pair("vs_currencies", VS_CURRENCY)
        .append_pair("include_24hr_change", "true")
        .append_pair("include_24hr_vol", "true")
        .append_pair("include_last_updated_at", "true");
    Ok(with_key(
        NetRequest::get(ConnectorId::Coingecko, u, "/api/v3/simple/price"),
        key,
    ))
}

/// `/coins/{id}/market_chart?days=N&interval=daily`.
pub fn chart_request(id: &str, days: i64, key: Option<&SecretString>) -> Result<NetRequest> {
    if !valid_id(id) {
        return Err(IntegrationError::Invalid("invalid coin id".into()));
    }
    let mut u = url(&format!("/coins/{id}/market_chart"))?;
    u.query_pairs_mut()
        .append_pair("vs_currency", VS_CURRENCY)
        .append_pair("days", &days.clamp(1, MAX_HISTORY_DAYS).to_string())
        .append_pair("interval", "daily");
    Ok(with_key(
        NetRequest::get(ConnectorId::Coingecko, u, "/api/v3/coins/{id}/market_chart")
            .cap(BodyCap::MarketHistory),
        key,
    ))
}

/// `/search?query=`.
pub fn search_request(query: &str, key: Option<&SecretString>) -> Result<NetRequest> {
    let mut u = url("/search")?;
    u.query_pairs_mut().append_pair("query", query);
    Ok(with_key(
        NetRequest::get(ConnectorId::Coingecko, u, "/api/v3/search"),
        key,
    ))
}

#[derive(Deserialize)]
struct RawPrice {
    usd: Option<f64>,
    usd_24h_change: Option<f64>,
    usd_24h_vol: Option<f64>,
    last_updated_at: Option<i64>,
}

/// One coin's price from `/simple/price`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CoinPrice {
    /// Price in USD.
    pub price: f64,
    /// 24 h change in percent.
    pub change_pct_24h: f64,
    /// 24 h volume.
    pub volume_24h: Option<f64>,
    /// Last update (epoch seconds).
    pub updated_at: i64,
}

/// Parse `/simple/price` keyed by coin id.
pub fn parse_prices(body: &[u8]) -> Result<HashMap<String, CoinPrice>> {
    let raw: BTreeMap<String, RawPrice> = crate::netguard::decode_json(body)?;
    Ok(raw
        .into_iter()
        .filter_map(|(id, p)| {
            let price = p.usd.filter(|v| v.is_finite() && *v > 0.0)?;
            Some((
                id,
                CoinPrice {
                    price,
                    change_pct_24h: p.usd_24h_change.filter(|v| v.is_finite()).unwrap_or(0.0),
                    volume_24h: p.usd_24h_vol.filter(|v| v.is_finite()),
                    updated_at: p.last_updated_at.unwrap_or_else(|| Utc::now().timestamp()),
                },
            ))
        })
        .collect())
}

/// Build a quote from a parsed price.
pub fn quote_from_price(symbol: &Symbol, p: &CoinPrice) -> Quote {
    let CoinPrice {
        price,
        change_pct_24h,
        volume_24h: volume,
        updated_at: at,
    } = *p;
    // prev = price / (1 + pct/100)
    let prev = if change_pct_24h > -100.0 {
        price / (1.0 + change_pct_24h / 100.0)
    } else {
        price
    };
    Quote {
        symbol: symbol.key(),
        price,
        change: price - prev,
        change_pct: change_pct_24h,
        open: None,
        high: None,
        low: None,
        prev_close: Some(prev),
        volume,
        currency: "USD".into(),
        market_state: MarketState::Open,
        as_of: from_unix(at).timestamp_millis(),
        source: "coingecko".into(),
        freshness: Freshness::Live,
        delayed_min: 0,
    }
}

#[derive(Deserialize)]
struct RawChart {
    #[serde(default)]
    prices: Vec<(f64, f64)>,
    #[serde(default)]
    total_volumes: Vec<(f64, f64)>,
}

/// Parse `market_chart` into one close-only bar per UTC date (last point of each day wins).
pub fn parse_chart(body: &[u8]) -> Result<Vec<Bar>> {
    let raw: RawChart = crate::netguard::decode_json(body)?;
    let to_date = |ms: f64| -> Option<NaiveDate> {
        if !ms.is_finite() {
            return None;
        }
        chrono::DateTime::from_timestamp_millis(ms as i64).map(|d| d.date_naive())
    };
    let volumes: HashMap<NaiveDate, f64> = raw
        .total_volumes
        .iter()
        .filter_map(|(t, v)| Some((to_date(*t)?, *v)))
        .collect();
    let mut by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    for (t, p) in raw.prices {
        if let Some(d) = to_date(t)
            && p.is_finite()
            && p > 0.0
        {
            by_day.insert(d, p);
        }
    }
    Ok(by_day
        .into_iter()
        .map(|(d, p)| {
            Bar::close_only(
                d,
                p,
                volumes
                    .get(&d)
                    .copied()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .unwrap_or(0.0),
            )
        })
        .collect())
}

#[derive(Deserialize)]
struct RawSearch {
    #[serde(default)]
    coins: Vec<RawCoin>,
}

#[derive(Deserialize)]
struct RawCoin {
    id: String,
    name: String,
    symbol: String,
    market_cap_rank: Option<u32>,
}

/// Parsed `/search` hits plus `(TICKER, coin id)` pairs for the id map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoinSearch {
    /// Search results.
    pub results: Vec<SearchResult>,
    /// Ticker → CoinGecko id, best market-cap rank first.
    pub ids: Vec<(String, String)>,
}

/// Parse `/search`.
pub fn parse_search(body: &[u8], limit: usize) -> Result<CoinSearch> {
    let mut raw: RawSearch = crate::netguard::decode_json(body)?;
    raw.coins
        .sort_by_key(|c| c.market_cap_rank.unwrap_or(u32::MAX));
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();
    for c in raw.coins {
        let ticker = c.symbol.to_ascii_uppercase();
        if Symbol::parse(&format!("{ticker}:CRYPTO")).is_err() || !seen.insert(ticker.clone()) {
            continue;
        }
        ids.push((ticker.clone(), c.id));
        results.push(SearchResult {
            symbol: format!("{ticker}:CRYPTO"),
            name: c.name,
            exchange: "CRYPTO".into(),
            kind: InstrumentType::Crypto,
            currency: "USD".into(),
        });
        if results.len() >= limit {
            break;
        }
    }
    Ok(CoinSearch { results, ids })
}

/// CoinGecko provider.
#[derive(Debug)]
pub struct CoinGecko {
    guard: NetGuard,
    key: RwLock<Option<SecretString>>,
    learned_ids: RwLock<HashMap<String, String>>,
}

impl CoinGecko {
    /// New provider (keyless).
    pub fn new(guard: NetGuard) -> Self {
        CoinGecko {
            guard,
            key: RwLock::new(None),
            learned_ids: RwLock::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl MarketProvider for CoinGecko {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "coingecko",
            name: "CoinGecko",
            connector: ConnectorId::Coingecko,
            needs_key: false,
            terms_url: "https://www.coingecko.com/en/api_terms",
            community: false,
            caps: &[
                Capability::Crypto,
                Capability::Quote,
                Capability::Daily,
                Capability::Search,
            ],
            default_enabled: true,
        }
    }

    fn set_api_key(&self, key: Option<SecretString>) {
        *self.key.write() = key;
    }

    fn map_symbol(&self, symbol: &Symbol, override_symbol: Option<&str>) -> Option<String> {
        if !symbol.is_crypto() {
            return None;
        }
        override_symbol
            .map(str::to_string)
            .or_else(|| coingecko_id(&symbol.ticker).map(str::to_string))
            .or_else(|| self.learned_ids.read().get(&symbol.ticker).cloned())
    }

    async fn quotes(&self, items: &[(Symbol, String)]) -> Vec<Result<Quote>> {
        let ids: Vec<&str> = items.iter().map(|(_, id)| id.as_str()).collect();
        let key = self.key.read().clone();
        let fetched = async {
            let req = price_request(&ids, key.as_ref())?;
            let resp = self.guard.send(req).await?.error_for_status()?;
            parse_prices(&resp.body)
        }
        .await;
        match fetched {
            Err(e) => items.iter().map(|_| Err(e.replicate())).collect(),
            Ok(prices) => items
                .iter()
                .map(|(s, id)| {
                    prices
                        .get(id)
                        .map(|p| quote_from_price(s, p))
                        .ok_or_else(|| IntegrationError::NotFound(s.key()))
                })
                .collect(),
        }
    }

    async fn quote(&self, symbol: &Symbol, provider_symbol: &str) -> Result<Quote> {
        self.quotes(&[(symbol.clone(), provider_symbol.to_string())])
            .await
            .pop()
            .unwrap_or_else(|| Err(IntegrationError::NotFound(symbol.key())))
    }

    async fn daily(
        &self,
        _symbol: &Symbol,
        provider_symbol: &str,
        from: NaiveDate,
        to: NaiveDate,
        _adjusted: bool,
    ) -> Result<Vec<Bar>> {
        let today = Utc::now().date_naive();
        let days = (today - from).num_days() + 1;
        let key = self.key.read().clone();
        let resp = self
            .guard
            .send(chart_request(provider_symbol, days, key.as_ref())?)
            .await?
            .error_for_status()?;
        Ok(parse_chart(&resp.body)?
            .into_iter()
            .filter(|b| b.date >= from && b.date <= to)
            .collect())
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let key = self.key.read().clone();
        let resp = self
            .guard
            .send(search_request(query, key.as_ref())?)
            .await?
            .error_for_status()?;
        let CoinSearch { results, ids } = parse_search(&resp.body, limit)?;
        let mut learned = self.learned_ids.write();
        for (t, id) in ids {
            if coingecko_id(&t).is_none() {
                learned.entry(t).or_insert(id);
            }
        }
        Ok(results)
    }

    async fn ping(&self) -> Result<()> {
        let key = self.key.read().clone();
        let resp = self
            .guard
            .send(price_request(&["bitcoin"], key.as_ref())?)
            .await?
            .error_for_status()?;
        parse_prices(&resp.body).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prices_and_builds_quotes() {
        let p = parse_prices(
            br#"{"bitcoin":{"usd":67000.5,"usd_24h_vol":2.5e10,"usd_24h_change":2.0,"last_updated_at":1764158400},"ghost":{}}"#,
        )
        .unwrap();
        assert_eq!(p.len(), 1);
        let q = quote_from_price(&Symbol::parse("BTC:CRYPTO").unwrap(), &p["bitcoin"]);
        assert_eq!(q.price, 67000.5);
        assert!((q.prev_close.unwrap() - 67000.5 / 1.02).abs() < 1e-6);
        assert_eq!(q.as_of, 1_764_158_400_000);
        assert_eq!(q.freshness, Freshness::Live);
    }

    #[test]
    fn parses_chart_one_bar_per_day() {
        let bars = parse_chart(
            br#"{"prices":[[1764028800000,100.0],[1764115200000,110.0],[1764158400000,111.0]],"market_caps":[],"total_volumes":[[1764028800000,5.0],[1764115200000,6.0]]}"#,
        )
        .unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[1].close, 111.0, "last point of the day wins");
        assert_eq!(bars[0].volume, 5.0);
    }

    #[test]
    fn parses_search() {
        let CoinSearch { results: r, ids } = parse_search(
            br#"{"coins":[{"id":"wrapped-bitcoin","name":"Wrapped Bitcoin","api_symbol":"wrapped-bitcoin","symbol":"WBTC","market_cap_rank":20},{"id":"bitcoin","name":"Bitcoin","symbol":"BTC","market_cap_rank":1},{"id":"fake-btc","name":"Fake","symbol":"BTC","market_cap_rank":null}],"exchanges":[]}"#,
            10,
        )
        .unwrap();
        assert_eq!(r[0].symbol, "BTC:CRYPTO");
        assert_eq!(r.len(), 2);
        assert_eq!(ids[0], ("BTC".to_string(), "bitcoin".to_string()));
    }

    #[test]
    fn request_shapes() {
        let r = price_request(&["bitcoin", "ethereum"], Some(&SecretString::new("k"))).unwrap();
        assert!(r.url.as_str().contains("ids=bitcoin%2Cethereum"));
        assert_eq!(r.credential.as_ref().unwrap().header, "x-cg-demo-api-key");
        assert!(price_request(&["bad id"], None).is_err());
        let r = chart_request("bitcoin", 10_000, None).unwrap();
        assert!(r.url.as_str().contains("days=365"));
        assert!(r.credential.is_none());
    }
}
