//! Stooq daily (EOD) CSV, keyless. `https://stooq.com/q/d/l/?s=<sym>.<mkt>&i=d`.

use async_trait::async_trait;
use chrono::NaiveDate;
use url::Url;

use super::provider::{MarketProvider, ProviderMeta};
use super::symbols::stooq_symbol;
use super::{Bar, Capability, Freshness, MarketState, Quote, Symbol, date_to_millis, pct};
use crate::error::{IntegrationError, Result};
use crate::netguard::{BodyCap, ConnectorId, Expect, NetGuard, NetRequest};

/// Daily CSV request; `from`/`to` bound the range when given.
pub fn daily_request(
    provider_symbol: &str,
    range: Option<(NaiveDate, NaiveDate)>,
) -> Result<NetRequest> {
    if provider_symbol.is_empty()
        || provider_symbol.len() > 40
        || !provider_symbol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-^_".contains(c))
    {
        return Err(IntegrationError::Invalid("invalid stooq symbol".into()));
    }
    let mut url = Url::parse("https://stooq.com/q/d/l/")
        .map_err(|e| IntegrationError::Internal(e.to_string()))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("s", provider_symbol).append_pair("i", "d");
        if let Some((from, to)) = range {
            q.append_pair("d1", &from.format("%Y%m%d").to_string())
                .append_pair("d2", &to.format("%Y%m%d").to_string());
        }
    }
    Ok(NetRequest::get(ConnectorId::Stooq, url, "/q/d/l/")
        .expect(Expect::Csv)
        .cap(BodyCap::MarketHistory))
}

/// Parse Stooq CSV (`Date,Open,High,Low,Close,Volume`). Rows with bad numbers are skipped.
/// `No data` → `NOT_FOUND`; the daily-hits message → `QUOTA`.
pub fn parse_csv(body: &[u8]) -> Result<Vec<Bar>> {
    let text = String::from_utf8_lossy(body);
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("no data") {
        return Err(IntegrationError::NotFound("no data for symbol".into()));
    }
    if trimmed
        .to_ascii_lowercase()
        .contains("exceeded the daily hits limit")
    {
        return Err(IntegrationError::Quota("stooq daily limit reached".into()));
    }
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(trimmed.as_bytes());
    let headers = rdr
        .headers()
        .map_err(|e| IntegrationError::Decode(e.to_string()))?
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    let col = |name: &str| headers.iter().position(|h| h == name);
    let (Some(di), Some(oi), Some(hi), Some(li), Some(ci)) = (
        col("date"),
        col("open"),
        col("high"),
        col("low"),
        col("close"),
    ) else {
        return Err(IntegrationError::Decode(
            "unexpected stooq CSV header".into(),
        ));
    };
    let vi = col("volume");
    let mut bars = Vec::new();
    for rec in rdr.records() {
        let Ok(rec) = rec else { continue };
        let num = |i: usize| rec.get(i).and_then(|s| s.trim().parse::<f64>().ok());
        let Some(date) = rec
            .get(di)
            .and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok())
        else {
            continue;
        };
        let (Some(open), Some(high), Some(low), Some(close)) = (num(oi), num(hi), num(li), num(ci))
        else {
            continue;
        };
        let bar = Bar {
            date,
            open,
            high,
            low,
            close,
            volume: vi.and_then(num).unwrap_or(0.0),
            adj_close: None,
            dividend: None,
            split: None,
        };
        if bar.is_finite() {
            bars.push(bar);
        }
    }
    bars.sort_by_key(|b| b.date);
    bars.dedup_by_key(|b| b.date);
    Ok(bars)
}

/// Build an EOD quote from the last two bars.
pub fn quote_from_bars(symbol: &Symbol, bars: &[Bar], currency: &str) -> Result<Quote> {
    let last = bars
        .last()
        .ok_or_else(|| IntegrationError::NotFound(symbol.key()))?;
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
        open: Some(last.open),
        high: Some(last.high),
        low: Some(last.low),
        prev_close: prev,
        volume: Some(last.volume),
        currency: currency.to_string(),
        market_state: MarketState::Closed,
        as_of: date_to_millis(last.date),
        source: "stooq".into(),
        freshness: Freshness::Eod,
        delayed_min: 0,
    })
}

/// Stooq provider.
#[derive(Debug, Clone)]
pub struct Stooq {
    guard: NetGuard,
}

impl Stooq {
    /// New provider.
    pub fn new(guard: NetGuard) -> Self {
        Stooq { guard }
    }
}

#[async_trait]
impl MarketProvider for Stooq {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "stooq",
            name: "Stooq",
            connector: ConnectorId::Stooq,
            needs_key: false,
            terms_url: "https://stooq.com/",
            community: false,
            caps: &[Capability::Daily, Capability::Quote],
            default_enabled: true,
        }
    }

    fn map_symbol(&self, symbol: &Symbol, override_symbol: Option<&str>) -> Option<String> {
        override_symbol
            .map(str::to_string)
            .or_else(|| stooq_symbol(symbol))
    }

    async fn quote(&self, symbol: &Symbol, provider_symbol: &str) -> Result<Quote> {
        let today = chrono::Utc::now().date_naive();
        let bars = self
            .daily(
                symbol,
                provider_symbol,
                today - chrono::Duration::days(14),
                today,
                false,
            )
            .await?;
        let currency = if symbol.is_fx() {
            symbol.fx_pair().map(|(_, q)| q).unwrap_or("USD")
        } else {
            symbol.default_currency()
        };
        quote_from_bars(symbol, &bars, currency)
    }

    async fn daily(
        &self,
        _symbol: &Symbol,
        provider_symbol: &str,
        from: NaiveDate,
        to: NaiveDate,
        _adjusted: bool,
    ) -> Result<Vec<Bar>> {
        let resp = self
            .guard
            .send(daily_request(provider_symbol, Some((from, to)))?)
            .await?
            .error_for_status()?;
        let bars = parse_csv(&resp.body)?;
        Ok(bars
            .into_iter()
            .filter(|b| b.date >= from && b.date <= to)
            .collect())
    }

    async fn ping(&self) -> Result<()> {
        let today = chrono::Utc::now().date_naive();
        let resp = self
            .guard
            .send(daily_request(
                "spy.us",
                Some((today - chrono::Duration::days(7), today)),
            )?)
            .await?
            .error_for_status()?;
        parse_csv(&resp.body).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSV: &str = "Date,Open,High,Low,Close,Volume\n2026-11-20,227.1,229.0,226.5,228.0,51234567\n2026-11-23,228.2,231.4,227.9,230.9,48000000\nbad,row\n2026-11-24,x,1,1,1,1\n";

    #[test]
    fn parses_csv_fixture() {
        let bars = parse_csv(CSV.as_bytes()).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[1].close, 230.9);
        assert_eq!(bars[0].volume, 51_234_567.0);
        let q = quote_from_bars(&Symbol::parse("AAPL:XNAS").unwrap(), &bars, "USD").unwrap();
        assert_eq!(q.price, 230.9);
        assert!((q.change - 2.9).abs() < 1e-9);
        assert_eq!(q.freshness, Freshness::Eod);
        assert_eq!(q.prev_close, Some(228.0));
    }

    #[test]
    fn no_data_and_quota() {
        assert!(matches!(
            parse_csv(b"No data").unwrap_err(),
            IntegrationError::NotFound(_)
        ));
        assert!(matches!(
            parse_csv(b"Exceeded the daily hits limit").unwrap_err(),
            IntegrationError::Quota(_)
        ));
        assert!(matches!(
            parse_csv(b"Foo,Bar\n1,2").unwrap_err(),
            IntegrationError::Decode(_)
        ));
        // Indices/FX CSVs have no volume column.
        let bars = parse_csv(b"Date,Open,High,Low,Close\n2026-01-02,1.1,1.2,1.0,1.15\n").unwrap();
        assert_eq!(bars[0].volume, 0.0);
    }

    #[test]
    fn request_shape() {
        let r = daily_request(
            "aapl.us",
            Some((
                NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
            )),
        )
        .unwrap();
        assert_eq!(
            r.url.as_str(),
            "https://stooq.com/q/d/l/?s=aapl.us&i=d&d1=20260101&d2=20260201"
        );
        assert_eq!(r.expect, Expect::Csv);
        assert!(daily_request("a&b", None).is_err());
    }
}
