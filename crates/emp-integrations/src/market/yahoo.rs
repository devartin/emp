//! Yahoo Finance chart API — unofficial "Community source" (P1, cargo feature `yahoo`, off by
//! default and disabled until the user opts in).

use async_trait::async_trait;
use chrono::NaiveDate;
use serde::Deserialize;
use url::Url;

use super::provider::{MarketProvider, ProviderMeta};
use super::symbols::yahoo_symbol;
use super::{Bar, Capability, Freshness, MarketState, Quote, Symbol, from_unix, pct};
use crate::error::{IntegrationError, Result};
use crate::netguard::{BodyCap, ConnectorId, NetGuard, NetRequest};

/// `/v8/finance/chart/{sym}` over `[from, to]` (or the last 5 days for quotes).
pub fn chart_request(
    provider_symbol: &str,
    range: Option<(NaiveDate, NaiveDate)>,
) -> Result<NetRequest> {
    if provider_symbol.is_empty()
        || provider_symbol.len() > 30
        || !provider_symbol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-=^".contains(c))
    {
        return Err(IntegrationError::Invalid("invalid yahoo symbol".into()));
    }
    let mut url = Url::parse(&format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{provider_symbol}"
    ))
    .map_err(|e| IntegrationError::Internal(e.to_string()))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("interval", "1d")
            .append_pair("events", "div,split");
        match range {
            Some((from, to)) => {
                q.append_pair(
                    "period1",
                    &super::date_to_millis(from).div_euclid(1000).to_string(),
                )
                .append_pair(
                    "period2",
                    &(super::date_to_millis(to).div_euclid(1000) + 86_400).to_string(),
                );
            }
            None => {
                q.append_pair("range", "5d");
            }
        }
    }
    Ok(
        NetRequest::get(ConnectorId::Yahoo, url, "/v8/finance/chart/{symbol}")
            .cap(BodyCap::MarketHistory),
    )
}

#[derive(Deserialize)]
struct Envelope {
    chart: Chart,
}

#[derive(Deserialize)]
struct Chart {
    result: Option<Vec<ChartResult>>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartResult {
    meta: Meta,
    #[serde(default)]
    timestamp: Vec<i64>,
    indicators: Option<Indicators>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    currency: Option<String>,
    regular_market_price: Option<f64>,
    chart_previous_close: Option<f64>,
    previous_close: Option<f64>,
    regular_market_time: Option<i64>,
}

#[derive(Deserialize)]
struct Indicators {
    #[serde(default)]
    quote: Vec<QuoteSeries>,
    #[serde(default)]
    adjclose: Vec<AdjSeries>,
}

#[derive(Deserialize, Default)]
struct QuoteSeries {
    #[serde(default)]
    open: Vec<Option<f64>>,
    #[serde(default)]
    high: Vec<Option<f64>>,
    #[serde(default)]
    low: Vec<Option<f64>>,
    #[serde(default)]
    close: Vec<Option<f64>>,
    #[serde(default)]
    volume: Vec<Option<f64>>,
}

#[derive(Deserialize)]
struct AdjSeries {
    #[serde(default)]
    adjclose: Vec<Option<f64>>,
}

fn result(body: &[u8]) -> Result<ChartResult> {
    let env: Envelope = crate::netguard::decode_json(body)?;
    if let Some(err) = env.chart.error.filter(|e| !e.is_null()) {
        let desc = err
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("error");
        return Err(IntegrationError::NotFound(crate::error::short_message(
            desc,
        )));
    }
    env.chart
        .result
        .and_then(|mut r| (!r.is_empty()).then(|| r.remove(0)))
        .ok_or_else(|| IntegrationError::NotFound("no chart result".into()))
}

/// Parse chart bars; nulls are skipped.
pub fn parse_bars(body: &[u8], adjusted: bool) -> Result<(Vec<Bar>, Option<String>)> {
    let r = result(body)?;
    let ind = r.indicators.unwrap_or(Indicators {
        quote: vec![],
        adjclose: vec![],
    });
    let q = ind.quote.into_iter().next().unwrap_or_default();
    let adj = ind
        .adjclose
        .into_iter()
        .next()
        .map(|a| a.adjclose)
        .unwrap_or_default();
    let mut bars = Vec::new();
    for (i, ts) in r.timestamp.iter().enumerate() {
        let get = |v: &Vec<Option<f64>>| v.get(i).copied().flatten();
        let (Some(o), Some(h), Some(l), Some(c)) =
            (get(&q.open), get(&q.high), get(&q.low), get(&q.close))
        else {
            continue;
        };
        let adj_close = get(&adj);
        let factor = match (adjusted, adj_close) {
            (true, Some(a)) if c > 0.0 => a / c,
            _ => 1.0,
        };
        let bar = Bar {
            date: from_unix(*ts).date_naive(),
            open: o * factor,
            high: h * factor,
            low: l * factor,
            close: c * factor,
            volume: get(&q.volume).unwrap_or(0.0),
            adj_close,
            dividend: None,
            split: None,
        };
        if bar.is_finite() {
            bars.push(bar);
        }
    }
    bars.sort_by_key(|b| b.date);
    bars.dedup_by_key(|b| b.date);
    Ok((bars, r.meta.currency))
}

/// Parse a quote from chart metadata.
pub fn parse_quote(body: &[u8], symbol: &Symbol) -> Result<Quote> {
    let r = result(body)?;
    let price = r
        .meta
        .regular_market_price
        .filter(|p| p.is_finite() && *p > 0.0)
        .ok_or_else(|| IntegrationError::NotFound(symbol.key()))?;
    let prev = r
        .meta
        .previous_close
        .or(r.meta.chart_previous_close)
        .filter(|p| p.is_finite() && *p > 0.0);
    let change = prev.map(|p| price - p).unwrap_or(0.0);
    Ok(Quote {
        symbol: symbol.key(),
        price,
        change,
        change_pct: prev.map(|p| pct(change, p)).unwrap_or(0.0),
        open: None,
        high: None,
        low: None,
        prev_close: prev,
        volume: None,
        currency: r
            .meta
            .currency
            .unwrap_or_else(|| symbol.default_currency().into()),
        market_state: MarketState::Closed,
        as_of: from_unix(r.meta.regular_market_time.unwrap_or(0)).timestamp_millis(),
        source: "yahoo".into(),
        freshness: Freshness::Delayed,
        delayed_min: 15,
    })
}

/// Yahoo provider (community source).
#[derive(Debug, Clone)]
pub struct Yahoo {
    guard: NetGuard,
}

impl Yahoo {
    /// New provider.
    pub fn new(guard: NetGuard) -> Self {
        Yahoo { guard }
    }
}

#[async_trait]
impl MarketProvider for Yahoo {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "yahoo",
            name: "Yahoo Finance (Community source)",
            connector: ConnectorId::Yahoo,
            needs_key: false,
            terms_url: "https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html",
            community: true,
            caps: &[Capability::Quote, Capability::Daily],
            default_enabled: false,
        }
    }

    fn map_symbol(&self, symbol: &Symbol, override_symbol: Option<&str>) -> Option<String> {
        override_symbol
            .map(str::to_string)
            .or_else(|| yahoo_symbol(symbol))
    }

    async fn quote(&self, symbol: &Symbol, provider_symbol: &str) -> Result<Quote> {
        let resp = self
            .guard
            .send(chart_request(provider_symbol, None)?)
            .await?
            .error_for_status()?;
        parse_quote(&resp.body, symbol)
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
            .send(chart_request(provider_symbol, Some((from, to)))?)
            .await?
            .error_for_status()?;
        Ok(parse_bars(&resp.body, adjusted)?
            .0
            .into_iter()
            .filter(|b| b.date >= from && b.date <= to)
            .collect())
    }

    async fn ping(&self) -> Result<()> {
        let s = Symbol::parse("SPY:ARCX")?;
        self.quote(&s, "SPY").await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHART: &str = r#"{"chart":{"result":[{"meta":{"currency":"USD","symbol":"AAPL","regularMarketPrice":230.9,"chartPreviousClose":228.0,"regularMarketTime":1764100000},
      "timestamp":[1763616600,1763703000,1763789400],
      "indicators":{"quote":[{"open":[227.1,null,229.0],"high":[229.0,null,231.0],"low":[226.5,null,228.0],"close":[228.0,null,230.9],"volume":[100,null,200]}],
      "adjclose":[{"adjclose":[114.0,null,230.9]}]}}],"error":null}}"#;

    #[test]
    fn parses_chart() {
        let (bars, ccy) = parse_bars(CHART.as_bytes(), false).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(ccy.as_deref(), Some("USD"));
        let (adj, _) = parse_bars(CHART.as_bytes(), true).unwrap();
        assert!((adj[0].close - 114.0).abs() < 1e-9);
        let q = parse_quote(CHART.as_bytes(), &Symbol::parse("AAPL:XNAS").unwrap()).unwrap();
        assert!((q.change - 2.9).abs() < 1e-9);
        let err = parse_bars(br#"{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}"#, false)
            .unwrap_err();
        assert!(matches!(err, IntegrationError::NotFound(_)));
    }
}
