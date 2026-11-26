//! Finnhub (user key, `X-Finnhub-Token`): quote, search, dividends. Candles are paid and
//! not used.

use async_trait::async_trait;
use chrono::NaiveDate;
use parking_lot::RwLock;
use serde::Deserialize;
use url::Url;

use super::provider::{MarketProvider, ProviderMeta};
use super::symbols::{finnhub_symbol, from_suffixed};
use super::{
    Capability, Dividend, Freshness, InstrumentType, MarketState, Quote, SearchResult, Symbol,
    from_unix,
};
use crate::error::{IntegrationError, Result};
use crate::netguard::{ConnectorId, Credential, NetGuard, NetRequest};
use crate::secret::SecretString;

const BASE: &str = "https://finnhub.io/api/v1";

fn url(path: &str) -> Result<Url> {
    Url::parse(&format!("{BASE}{path}")).map_err(|e| IntegrationError::Internal(e.to_string()))
}

fn auth(req: NetRequest, key: &SecretString) -> NetRequest {
    req.credential(Credential::header("x-finnhub-token", key))
}

/// `/quote?symbol=`.
pub fn quote_request(symbol: &str, key: &SecretString) -> Result<NetRequest> {
    let mut u = url("/quote")?;
    u.query_pairs_mut().append_pair("symbol", symbol);
    Ok(auth(
        NetRequest::get(ConnectorId::Finnhub, u, "/api/v1/quote"),
        key,
    ))
}

/// `/search?q=`.
pub fn search_request(query: &str, key: &SecretString) -> Result<NetRequest> {
    let mut u = url("/search")?;
    u.query_pairs_mut().append_pair("q", query);
    Ok(auth(
        NetRequest::get(ConnectorId::Finnhub, u, "/api/v1/search"),
        key,
    ))
}

/// `/stock/dividend?symbol=&from=&to=`.
pub fn dividend_request(
    symbol: &str,
    from: NaiveDate,
    to: NaiveDate,
    key: &SecretString,
) -> Result<NetRequest> {
    let mut u = url("/stock/dividend")?;
    u.query_pairs_mut()
        .append_pair("symbol", symbol)
        .append_pair("from", &from.format("%Y-%m-%d").to_string())
        .append_pair("to", &to.format("%Y-%m-%d").to_string());
    Ok(auth(
        NetRequest::get(ConnectorId::Finnhub, u, "/api/v1/stock/dividend"),
        key,
    ))
}

#[derive(Deserialize)]
struct RawQuote {
    c: Option<f64>,
    d: Option<f64>,
    dp: Option<f64>,
    h: Option<f64>,
    l: Option<f64>,
    o: Option<f64>,
    pc: Option<f64>,
    t: Option<i64>,
}

/// Parse `/quote`. All-zero payloads (unknown symbol) → `NOT_FOUND`.
/// `now_secs` decides whether the price is from the current session (≤ 20 min old → open).
pub fn parse_quote(body: &[u8], symbol: &Symbol, now_secs: i64) -> Result<Quote> {
    let r: RawQuote = crate::netguard::decode_json(body)?;
    let price =
        r.c.filter(|v| v.is_finite() && *v > 0.0)
            .ok_or_else(|| IntegrationError::NotFound(symbol.key()))?;
    let t = r.t.unwrap_or(0);
    let fin = |v: Option<f64>| v.filter(|x| x.is_finite() && *x != 0.0);
    let prev = fin(r.pc);
    let change =
        r.d.filter(|v| v.is_finite())
            .unwrap_or_else(|| prev.map(|p| price - p).unwrap_or(0.0));
    let change_pct =
        r.dp.filter(|v| v.is_finite())
            .unwrap_or_else(|| prev.map(|p| super::pct(change, p)).unwrap_or(0.0));
    let open_session = t > 0 && now_secs - t <= 20 * 60;
    Ok(Quote {
        symbol: symbol.key(),
        price,
        change,
        change_pct,
        open: fin(r.o),
        high: fin(r.h),
        low: fin(r.l),
        prev_close: prev,
        volume: None,
        currency: if symbol.is_us() {
            "USD".into()
        } else {
            symbol.default_currency().into()
        },
        market_state: if open_session {
            MarketState::Open
        } else {
            MarketState::Closed
        },
        as_of: from_unix(t).timestamp_millis(),
        source: "finnhub".into(),
        freshness: if symbol.is_us() {
            Freshness::Live
        } else {
            Freshness::Delayed
        },
        delayed_min: if symbol.is_us() { 0 } else { 15 },
    })
}

#[derive(Deserialize)]
struct RawSearch {
    #[serde(default)]
    result: Vec<RawHit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHit {
    description: String,
    display_symbol: Option<String>,
    symbol: String,
    #[serde(rename = "type", default)]
    kind: String,
}

/// Parse `/search`.
pub fn parse_search(body: &[u8], limit: usize) -> Result<Vec<SearchResult>> {
    let raw: RawSearch = crate::netguard::decode_json(body)?;
    let mut out = Vec::new();
    for h in raw.result {
        let sym = h.display_symbol.as_deref().unwrap_or(&h.symbol);
        if sym.contains(':') {
            continue; // e.g. crypto exchange pairs "BINANCE:BTCUSDT"
        }
        let (ticker, mic) = from_suffixed(sym);
        let Ok(symbol) = Symbol::parse(&format!("{ticker}:{mic}")) else {
            continue;
        };
        let kind = match h.kind.as_str() {
            "ETP" | "ETF" => InstrumentType::Etf,
            "Open-End Fund" | "Closed-End Fund" | "Mutual Fund" => InstrumentType::Fund,
            "Index" => InstrumentType::Index,
            _ => InstrumentType::Equity,
        };
        out.push(SearchResult {
            exchange: if symbol.is_us() {
                "US".into()
            } else {
                symbol.mic.clone()
            },
            currency: if symbol.is_us() {
                "USD".into()
            } else {
                symbol.default_currency().into()
            },
            symbol: symbol.key(),
            name: h.description,
            kind,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDividend {
    date: String,
    amount: f64,
    pay_date: Option<String>,
    currency: Option<String>,
}

/// Parse `/stock/dividend`.
pub fn parse_dividends(body: &[u8]) -> Result<Vec<Dividend>> {
    let raw: Vec<RawDividend> = crate::netguard::decode_json(body)?;
    Ok(raw
        .into_iter()
        .filter_map(|d| {
            Some(Dividend {
                ex_date: NaiveDate::parse_from_str(&d.date, "%Y-%m-%d").ok()?,
                amount: Some(d.amount).filter(|a| a.is_finite() && *a >= 0.0)?,
                currency: d.currency.unwrap_or_else(|| "USD".into()),
                pay_date: d
                    .pay_date
                    .and_then(|p| NaiveDate::parse_from_str(&p, "%Y-%m-%d").ok()),
            })
        })
        .collect())
}

/// Finnhub provider.
#[derive(Debug)]
pub struct Finnhub {
    guard: NetGuard,
    key: RwLock<Option<SecretString>>,
}

impl Finnhub {
    /// New provider without a key.
    pub fn new(guard: NetGuard) -> Self {
        Finnhub {
            guard,
            key: RwLock::new(None),
        }
    }

    fn key(&self) -> Result<SecretString> {
        self.key
            .read()
            .clone()
            .ok_or_else(|| IntegrationError::Unsupported("finnhub needs an API key".into()))
    }
}

#[async_trait]
impl MarketProvider for Finnhub {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "finnhub",
            name: "Finnhub",
            connector: ConnectorId::Finnhub,
            needs_key: true,
            terms_url: "https://finnhub.io/terms-of-service",
            community: false,
            caps: &[Capability::Quote, Capability::Search, Capability::Dividends],
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
        if symbol.is_crypto() || symbol.is_fx() {
            return None;
        }
        override_symbol
            .map(str::to_string)
            .or_else(|| finnhub_symbol(symbol))
    }

    async fn quote(&self, symbol: &Symbol, provider_symbol: &str) -> Result<Quote> {
        let resp = self
            .guard
            .send(quote_request(provider_symbol, &self.key()?)?)
            .await?
            .error_for_status()?;
        parse_quote(&resp.body, symbol, chrono::Utc::now().timestamp())
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let resp = self
            .guard
            .send(search_request(query, &self.key()?)?)
            .await?
            .error_for_status()?;
        parse_search(&resp.body, limit)
    }

    async fn dividends(
        &self,
        _symbol: &Symbol,
        provider_symbol: &str,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<Dividend>> {
        let resp = self
            .guard
            .send(dividend_request(provider_symbol, from, to, &self.key()?)?)
            .await?;
        if resp.status == 403 {
            return Err(IntegrationError::Unsupported(
                "dividends need a paid Finnhub plan".into(),
            ));
        }
        parse_dividends(&resp.error_for_status()?.body)
    }

    async fn ping(&self) -> Result<()> {
        let s = Symbol::parse("AAPL:XNAS")?;
        self.quote(&s, "AAPL").await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quote_fixture() {
        let s = Symbol::parse("AAPL:XNAS").unwrap();
        let body = br#"{"c":189.84,"d":1.24,"dp":0.6575,"h":190.32,"l":188.19,"o":188.5,"pc":188.6,"t":1764100000}"#;
        let q = parse_quote(body, &s, 1_764_100_300).unwrap();
        assert_eq!(q.price, 189.84);
        assert_eq!(q.market_state, MarketState::Open);
        assert_eq!(q.prev_close, Some(188.6));
        let q = parse_quote(body, &s, 1_764_200_000).unwrap();
        assert_eq!(q.market_state, MarketState::Closed);
        let zero = br#"{"c":0,"d":null,"dp":null,"h":0,"l":0,"o":0,"pc":0,"t":0}"#;
        assert!(matches!(
            parse_quote(zero, &s, 0).unwrap_err(),
            IntegrationError::NotFound(_)
        ));
    }

    #[test]
    fn parses_search_fixture() {
        let body = br#"{"count":4,"result":[
          {"description":"APPLE INC","displaySymbol":"AAPL","symbol":"AAPL","type":"Common Stock"},
          {"description":"VODAFONE GROUP PLC","displaySymbol":"VOD.L","symbol":"VOD.L","type":"Common Stock"},
          {"description":"SPDR S&P 500","displaySymbol":"SPY","symbol":"SPY","type":"ETP"},
          {"description":"BTC","displaySymbol":"BINANCE:BTCUSDT","symbol":"BINANCE:BTCUSDT","type":"Crypto"}]}"#;
        let r = parse_search(body, 10).unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].symbol, "AAPL:XNAS");
        assert_eq!(r[1].symbol, "VOD:XLON");
        assert_eq!(r[1].currency, "GBX");
        assert_eq!(r[2].kind, InstrumentType::Etf);
        assert_eq!(parse_search(body, 1).unwrap().len(), 1);
    }

    #[test]
    fn key_goes_in_header_not_url() {
        let r = quote_request("AAPL", &SecretString::new("KEY123")).unwrap();
        assert!(!r.url.as_str().contains("KEY123"));
        assert_eq!(r.credential.as_ref().unwrap().value.expose(), "KEY123");
        let d = parse_dividends(br#"[{"symbol":"AAPL","date":"2026-11-07","amount":0.26,"payDate":"2026-11-14","currency":"USD"}]"#).unwrap();
        assert_eq!(d[0].amount, 0.26);
    }
}
