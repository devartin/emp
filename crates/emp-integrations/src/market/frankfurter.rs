//! Frankfurter (ECB reference rates, daily, keyless). Host `api.frankfurter.app`.

use std::collections::BTreeMap;

use async_trait::async_trait;
use chrono::NaiveDate;
use serde::Deserialize;
use url::Url;

use super::provider::{MarketProvider, ProviderMeta};
use super::{Bar, Capability, Freshness, FxRates, MarketState, Quote, Symbol, date_to_millis, pct};
use crate::error::{IntegrationError, Result};
use crate::netguard::{ConnectorId, NetGuard, NetRequest};

const BASE: &str = "https://api.frankfurter.app";

fn valid_ccy(c: &str) -> bool {
    c.len() == 3 && c.chars().all(|ch| ch.is_ascii_alphabetic())
}

/// Request for latest (`date = None`) or historical rates.
pub fn rates_request(
    base: &str,
    symbols: &[String],
    date: Option<NaiveDate>,
) -> Result<NetRequest> {
    if !valid_ccy(base) || !symbols.iter().all(|s| valid_ccy(s)) {
        return Err(IntegrationError::Invalid(
            "currency codes are 3 letters".into(),
        ));
    }
    let (path, template) = match date {
        Some(d) => (format!("/{}", d.format("%Y-%m-%d")), "/{date}"),
        None => ("/latest".to_string(), "/latest"),
    };
    let mut url = Url::parse(&format!("{BASE}{path}"))
        .map_err(|e| IntegrationError::Internal(e.to_string()))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("from", &base.to_ascii_uppercase());
        if !symbols.is_empty() {
            let list: Vec<String> = symbols.iter().map(|s| s.to_ascii_uppercase()).collect();
            q.append_pair("to", &list.join(","));
        }
    }
    Ok(NetRequest::get(ConnectorId::Frankfurter, url, template))
}

/// Time-series request (`/{from}..{to}`).
pub fn series_request(
    base: &str,
    quote: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<NetRequest> {
    if !valid_ccy(base) || !valid_ccy(quote) {
        return Err(IntegrationError::Invalid(
            "currency codes are 3 letters".into(),
        ));
    }
    let mut url = Url::parse(&format!(
        "{BASE}/{}..{}",
        from.format("%Y-%m-%d"),
        to.format("%Y-%m-%d")
    ))
    .map_err(|e| IntegrationError::Internal(e.to_string()))?;
    url.query_pairs_mut()
        .append_pair("from", base)
        .append_pair("to", quote);
    Ok(NetRequest::get(
        ConnectorId::Frankfurter,
        url,
        "/{from}..{to}",
    ))
}

#[derive(Deserialize)]
struct RawRates {
    base: String,
    date: String,
    rates: BTreeMap<String, f64>,
}

#[derive(Deserialize)]
struct RawSeries {
    rates: BTreeMap<String, BTreeMap<String, f64>>,
}

/// Parse latest/historical rates.
pub fn parse_rates(body: &[u8]) -> Result<FxRates> {
    let raw: RawRates = crate::netguard::decode_json(body)?;
    let rates: BTreeMap<String, f64> = raw
        .rates
        .into_iter()
        .filter(|(_, v)| v.is_finite() && *v > 0.0)
        .collect();
    Ok(FxRates {
        base: raw.base,
        date: raw.date,
        rates,
        source: "frankfurter".into(),
        stale: false,
    })
}

/// Parse a time series into close-only bars for `quote`.
pub fn parse_series(body: &[u8], quote: &str) -> Result<Vec<Bar>> {
    let raw: RawSeries = crate::netguard::decode_json(body)?;
    let mut bars: Vec<Bar> = raw
        .rates
        .iter()
        .filter_map(|(d, m)| {
            let date = NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
            let v = *m.get(quote)?;
            (v.is_finite() && v > 0.0).then(|| Bar::close_only(date, v, 0.0))
        })
        .collect();
    bars.sort_by_key(|b| b.date);
    Ok(bars)
}

/// Frankfurter provider.
#[derive(Debug, Clone)]
pub struct Frankfurter {
    guard: NetGuard,
}

impl Frankfurter {
    /// New provider.
    pub fn new(guard: NetGuard) -> Self {
        Frankfurter { guard }
    }
}

#[async_trait]
impl MarketProvider for Frankfurter {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "frankfurter",
            name: "Frankfurter (ECB)",
            connector: ConnectorId::Frankfurter,
            needs_key: false,
            terms_url: "https://www.frankfurter.app/docs/",
            community: false,
            caps: &[Capability::Fx, Capability::Daily, Capability::Quote],
            default_enabled: true,
        }
    }

    fn map_symbol(&self, symbol: &Symbol, override_symbol: Option<&str>) -> Option<String> {
        if let Some(o) = override_symbol {
            return Some(o.to_string());
        }
        symbol.is_fx().then(|| symbol.ticker.clone())
    }

    async fn quote(&self, symbol: &Symbol, provider_symbol: &str) -> Result<Quote> {
        if provider_symbol.len() != 6 {
            return Err(IntegrationError::Invalid("FX pair expected".into()));
        }
        let (base, quote) = provider_symbol.split_at(3);
        let today = chrono::Utc::now().date_naive();
        let bars = self
            .daily(
                symbol,
                provider_symbol,
                today - chrono::Duration::days(10),
                today,
                false,
            )
            .await?;
        let last = bars
            .last()
            .ok_or_else(|| IntegrationError::NotFound(format!("{base}/{quote}")))?;
        let prev = bars
            .len()
            .checked_sub(2)
            .and_then(|i| bars.get(i))
            .map(|b| b.close);
        let change = prev.map(|p| last.close - p).unwrap_or(0.0);
        Ok(Quote {
            symbol: symbol.key(),
            price: last.close,
            change,
            change_pct: prev.map(|p| pct(change, p)).unwrap_or(0.0),
            open: None,
            high: None,
            low: None,
            prev_close: prev,
            volume: None,
            currency: quote.to_string(),
            market_state: MarketState::Closed,
            as_of: date_to_millis(last.date),
            source: "frankfurter".into(),
            freshness: Freshness::Eod,
            delayed_min: 0,
        })
    }

    async fn daily(
        &self,
        _symbol: &Symbol,
        provider_symbol: &str,
        from: NaiveDate,
        to: NaiveDate,
        _adjusted: bool,
    ) -> Result<Vec<Bar>> {
        if provider_symbol.len() != 6 {
            return Err(IntegrationError::Unsupported(
                "frankfurter serves FX pairs only".into(),
            ));
        }
        let (base, quote) = provider_symbol.split_at(3);
        let resp = self
            .guard
            .send(series_request(base, quote, from, to)?)
            .await?;
        let resp = resp.error_for_status()?;
        parse_series(&resp.body, quote)
    }

    async fn fx(&self, base: &str, symbols: &[String], date: Option<NaiveDate>) -> Result<FxRates> {
        let resp = self
            .guard
            .send(rates_request(base, symbols, date)?)
            .await?
            .error_for_status()?;
        parse_rates(&resp.body)
    }

    async fn ping(&self) -> Result<()> {
        self.fx("EUR", &["USD".to_string()], None).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_shapes() {
        let r = rates_request("usd", &["EUR".into(), "gbp".into()], None).unwrap();
        assert_eq!(
            r.url.as_str(),
            "https://api.frankfurter.app/latest?from=USD&to=EUR%2CGBP"
        );
        let r = rates_request("USD", &[], NaiveDate::from_ymd_opt(2024, 1, 15)).unwrap();
        assert_eq!(
            r.url.as_str(),
            "https://api.frankfurter.app/2024-01-15?from=USD"
        );
        assert_eq!(r.path_template, "/{date}");
        assert!(rates_request("US", &[], None).is_err());
        assert!(rates_request("USD", &["E;R".into()], None).is_err());
        let r = series_request(
            "EUR",
            "USD",
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2024, 1, 31).unwrap(),
        )
        .unwrap();
        assert_eq!(r.url.path(), "/2024-01-01..2024-01-31");
    }

    #[test]
    fn parses_fixtures() {
        let r = parse_rates(br#"{"amount":1.0,"base":"USD","date":"2024-01-15","rates":{"EUR":0.91343,"GBP":0.78612,"BAD":-1}}"#).unwrap();
        assert_eq!(r.date, "2024-01-15");
        assert_eq!(r.rates.len(), 2);
        assert!((r.rates["EUR"] - 0.91343).abs() < 1e-12);
        let bars = parse_series(
            br#"{"amount":1.0,"base":"EUR","start_date":"2024-01-01","end_date":"2024-01-05","rates":{"2024-01-03":{"USD":1.0919},"2024-01-02":{"USD":1.0956}}}"#,
            "USD",
        )
        .unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].date, NaiveDate::from_ymd_opt(2024, 1, 2).unwrap());
        assert!(parse_rates(b"not json").is_err());
    }
}
