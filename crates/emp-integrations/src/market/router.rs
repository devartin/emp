//! The market router: fallback chains, caching and data hygiene (SPEC §17.2).
//!
//! Default chains (all user-reorderable):
//!
//! | Data | Order |
//! |---|---|
//! | Quote | finnhub → coingecko (crypto) → stooq (EOD) → frankfurter (FX) → yahoo |
//! | Daily | tiingo → stooq → coingecko (crypto) → frankfurter (FX) → yahoo |
//! | Search | finnhub → tiingo → built-in list ([`LocalSymbolSearch`]) |
//! | FX | frankfurter |
//! | Dividends | tiingo → finnhub |
//!
//! A provider is tried only if it is enabled, configured (key present when needed), declares
//! the capability, and can map the symbol. Yahoo is compiled only with the `yahoo` feature and
//! is disabled by default.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Datelike, NaiveDate};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use super::cache::{BarCache, Clock, Fetched, FxCache, QUOTE_TTL, QuoteCache, SearchCache};
use super::provider::MarketProvider;
use super::{
    Bar, BarInterval, Bars, Capability, Dividend, FxRates, ProviderInfo, ProviderSymbols, Quote,
    SearchResult, Symbol, date_to_millis,
};
use crate::error::{IntegrationError, Result};
use crate::netguard::NetGuard;
use crate::secret::SecretString;

/// The built-in symbol list (`resources/symbols-top.json`), searched last.
pub trait LocalSymbolSearch: Send + Sync {
    /// Up to `limit` matches for `query`.
    fn search(&self, query: &str, limit: usize) -> Vec<SearchResult>;
}

/// User-reorderable provider chains (provider ids).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chains {
    /// Quote chain.
    pub quote: Vec<String>,
    /// Daily bars chain.
    pub daily: Vec<String>,
    /// Search chain.
    pub search: Vec<String>,
    /// FX chain.
    pub fx: Vec<String>,
    /// Dividends chain.
    pub dividends: Vec<String>,
}

impl Default for Chains {
    fn default() -> Self {
        let v = |ids: &[&str]| ids.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        Chains {
            quote: v(&["finnhub", "coingecko", "stooq", "frankfurter", "yahoo"]),
            daily: v(&["tiingo", "stooq", "coingecko", "frankfurter", "yahoo"]),
            search: v(&["finnhub", "tiingo"]),
            fx: v(&["frankfurter"]),
            dividends: v(&["tiingo", "finnhub"]),
        }
    }
}

/// API key change for [`MarketRouter::configure`] (`apiKey` absent / `null` / string).
#[derive(Debug, Clone)]
pub enum KeyUpdate {
    /// Leave unchanged.
    Keep,
    /// Remove the key.
    Clear,
    /// Install a key.
    Set(SecretString),
}

/// Router tuning.
#[derive(Debug, Clone)]
pub struct RouterConfig {
    /// Quote TTL (default 60 s).
    pub quote_ttl: Duration,
    /// Daily moves above this fraction without a split flag are "unverified" (default 0.5).
    pub max_daily_move: f64,
    /// Longest accepted bar range.
    pub max_range_days: i64,
}

impl Default for RouterConfig {
    fn default() -> Self {
        RouterConfig {
            quote_ttl: QUOTE_TTL,
            max_daily_move: 0.5,
            max_range_days: 366 * 60,
        }
    }
}

/// `market_provider_test` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTest {
    /// Succeeded.
    pub ok: bool,
    /// Round trip.
    pub latency_ms: u64,
    /// Error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A daily/weekly/monthly series with hygiene results.
#[derive(Debug, Clone, PartialEq)]
pub struct BarSeries {
    /// Bars (verified only), ascending.
    pub bars: Vec<Bar>,
    /// Currency.
    pub currency: String,
    /// Provider id.
    pub source: String,
    /// Served from cache after a failed refresh.
    pub stale: bool,
    /// Dates of daily bars dropped as "unverified" (> 50 % move, no split flag).
    pub unverified: Vec<NaiveDate>,
}

impl BarSeries {
    /// The IPC `Bars` shape.
    pub fn to_ipc(&self) -> Bars {
        Bars {
            t: self.bars.iter().map(|b| date_to_millis(b.date)).collect(),
            o: self.bars.iter().map(|b| b.open).collect(),
            h: self.bars.iter().map(|b| b.high).collect(),
            l: self.bars.iter().map(|b| b.low).collect(),
            c: self.bars.iter().map(|b| b.close).collect(),
            v: self.bars.iter().map(|b| b.volume).collect(),
            currency: self.currency.clone(),
            source: self.source.clone(),
            stale: self.stale,
        }
    }
}

/// Routes market requests across providers.
pub struct MarketRouter {
    guard: NetGuard,
    providers: Vec<Arc<dyn MarketProvider>>,
    enabled: RwLock<HashMap<String, bool>>,
    chains: RwLock<Chains>,
    quotes: QuoteCache,
    bars: BarCache,
    fx: FxCache,
    search_cache: SearchCache,
    clock: Arc<dyn Clock>,
    local: Option<Arc<dyn LocalSymbolSearch>>,
    config: RouterConfig,
}

impl std::fmt::Debug for MarketRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MarketRouter")
            .field(
                "providers",
                &self.providers.iter().map(|p| p.id()).collect::<Vec<_>>(),
            )
            .field("chains", &*self.chains.read())
            .finish_non_exhaustive()
    }
}

impl MarketRouter {
    /// A router with every built-in provider (Yahoo only with the `yahoo` feature).
    pub fn new(guard: NetGuard, clock: Arc<dyn Clock>) -> Self {
        #[cfg_attr(not(feature = "yahoo"), allow(unused_mut))]
        let mut providers: Vec<Arc<dyn MarketProvider>> = vec![
            Arc::new(super::frankfurter::Frankfurter::new(guard.clone())),
            Arc::new(super::stooq::Stooq::new(guard.clone())),
            Arc::new(super::coingecko::CoinGecko::new(guard.clone())),
            Arc::new(super::finnhub::Finnhub::new(guard.clone())),
            Arc::new(super::tiingo::Tiingo::new(guard.clone())),
        ];
        #[cfg(feature = "yahoo")]
        providers.push(Arc::new(super::yahoo::Yahoo::new(guard.clone())));
        MarketRouter::with_providers(guard, providers, clock, RouterConfig::default())
    }

    /// A router over an explicit provider set.
    pub fn with_providers(
        guard: NetGuard,
        providers: Vec<Arc<dyn MarketProvider>>,
        clock: Arc<dyn Clock>,
        config: RouterConfig,
    ) -> Self {
        let enabled = providers
            .iter()
            .map(|p| (p.id().to_string(), p.meta().default_enabled))
            .collect();
        MarketRouter {
            guard,
            providers,
            enabled: RwLock::new(enabled),
            chains: RwLock::new(Chains::default()),
            quotes: QuoteCache::default(),
            bars: BarCache::default(),
            fx: FxCache::default(),
            search_cache: SearchCache::default(),
            clock,
            local: None,
            config,
        }
    }

    /// Install the built-in symbol list.
    pub fn set_local_search(&mut self, local: Arc<dyn LocalSymbolSearch>) {
        self.local = Some(local);
    }

    /// The bar cache (to persist/restore closed bars).
    pub fn bar_cache(&self) -> &BarCache {
        &self.bars
    }

    /// Current chains.
    pub fn chains(&self) -> Chains {
        self.chains.read().clone()
    }

    /// Replace the chains (unknown ids are ignored at lookup time).
    pub fn set_chains(&self, chains: Chains) {
        *self.chains.write() = chains;
    }

    fn provider(&self, id: &str) -> Option<&Arc<dyn MarketProvider>> {
        self.providers.iter().find(|p| p.id() == id)
    }

    fn info(&self, p: &Arc<dyn MarketProvider>) -> ProviderInfo {
        let meta = p.meta();
        ProviderInfo {
            id: meta.id.into(),
            name: meta.name.into(),
            needs_key: meta.needs_key,
            configured: p.configured(),
            enabled: self.is_enabled(meta.id),
            terms_url: meta.terms_url.into(),
            community: meta.community,
            caps: meta.caps.to_vec(),
            rate_limit: meta.connector.rate_limit_label().into(),
            health: self.guard.health(meta.connector),
        }
    }

    fn is_enabled(&self, id: &str) -> bool {
        self.enabled.read().get(id).copied().unwrap_or(false)
    }

    /// `market_providers`.
    pub fn providers_info(&self) -> Vec<ProviderInfo> {
        self.providers.iter().map(|p| self.info(p)).collect()
    }

    /// `market_provider_configure`. `priority` moves the provider to that position in every
    /// chain it belongs to.
    pub fn configure(
        &self,
        id: &str,
        enabled: bool,
        key: KeyUpdate,
        priority: Option<usize>,
    ) -> Result<ProviderInfo> {
        let p = self
            .provider(id)
            .ok_or_else(|| IntegrationError::NotFound(format!("provider `{id}`")))?
            .clone();
        match key {
            KeyUpdate::Keep => {}
            KeyUpdate::Clear => p.set_api_key(None),
            KeyUpdate::Set(k) => p.set_api_key(Some(k)),
        }
        self.enabled.write().insert(id.to_string(), enabled);
        if let Some(pos) = priority {
            let mut guard = self.chains.write();
            let chains: &mut Chains = &mut guard;
            for chain in [
                &mut chains.quote,
                &mut chains.daily,
                &mut chains.search,
                &mut chains.fx,
                &mut chains.dividends,
            ] {
                if let Some(i) = chain.iter().position(|x| x == id) {
                    let item = chain.remove(i);
                    let at = pos.min(chain.len());
                    chain.insert(at, item);
                }
            }
        }
        self.guard.reset_breaker(p.meta().connector);
        Ok(self.info(&p))
    }

    /// `market_provider_test`.
    pub async fn test(&self, id: &str) -> Result<ProviderTest> {
        let p = self
            .provider(id)
            .ok_or_else(|| IntegrationError::NotFound(format!("provider `{id}`")))?;
        let started = Instant::now();
        let r = p.ping().await;
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok(ProviderTest {
            ok: r.is_ok(),
            latency_ms,
            error: r.err().map(|e| e.to_string()),
        })
    }

    fn eligible(&self, chain: &[String], cap: Capability) -> Vec<Arc<dyn MarketProvider>> {
        chain
            .iter()
            .filter_map(|id| self.provider(id))
            .filter(|p| self.is_enabled(p.id()) && p.configured() && p.meta().caps.contains(&cap))
            .cloned()
            .collect()
    }

    /// A cached quote and whether it is within the TTL (for "served from cache").
    pub fn cached_quote(&self, key: &str) -> Option<(Quote, bool)> {
        self.quotes
            .get(key, self.clock.now(), self.config.quote_ttl)
    }

    /// Fetch quotes for `keys` (fresh cache entries are reused). `overrides` maps a symbol
    /// key to its `providerSymbols`. Results are in input order. When every provider fails,
    /// an expired cached quote is returned if one exists.
    pub async fn quotes(
        &self,
        keys: &[String],
        overrides: &HashMap<String, ProviderSymbols>,
    ) -> Vec<Result<Quote>> {
        let now = self.clock.now();
        let mut results: Vec<Option<Result<Quote>>> = (0..keys.len()).map(|_| None).collect();
        let mut pending: Vec<(usize, Symbol)> = Vec::new();
        for (i, k) in keys.iter().enumerate() {
            match Symbol::parse(k) {
                Err(e) => results[i] = Some(Err(e)),
                Ok(s) => match self.quotes.get(&s.key(), now, self.config.quote_ttl) {
                    Some((q, true)) => results[i] = Some(Ok(q)),
                    _ => pending.push((i, s)),
                },
            }
        }
        let chain = self.chains.read().quote.clone();
        let mut last_err: HashMap<usize, IntegrationError> = HashMap::new();
        for p in self.eligible(&chain, Capability::Quote) {
            if pending.is_empty() {
                break;
            }
            let mut batch: Vec<(usize, Symbol, String)> = Vec::new();
            for (i, s) in &pending {
                let o = overrides
                    .get(&s.key())
                    .and_then(|m| m.get(p.id()))
                    .map(String::as_str);
                if let Some(ps) = p.map_symbol(s, o) {
                    batch.push((*i, s.clone(), ps));
                }
            }
            if batch.is_empty() {
                continue;
            }
            let items: Vec<(Symbol, String)> = batch
                .iter()
                .map(|(_, s, ps)| (s.clone(), ps.clone()))
                .collect();
            let fetched = p.quotes(&items).await;
            for ((i, _, _), r) in batch.iter().zip(fetched) {
                match r {
                    Ok(q) if q.is_sane() => {
                        self.quotes.put(q.clone(), now);
                        results[*i] = Some(Ok(q));
                    }
                    Ok(_) => {
                        last_err.insert(
                            *i,
                            IntegrationError::Provider(format!(
                                "{} returned a non-finite quote",
                                p.id()
                            )),
                        );
                    }
                    Err(e) => {
                        last_err.insert(*i, e);
                    }
                }
            }
            pending.retain(|(i, _)| results[*i].is_none());
        }
        for (i, s) in pending {
            results[i] = Some(
                match self.quotes.get(&s.key(), now, self.config.quote_ttl) {
                    Some((q, _)) => Ok(q),
                    None => Err(last_err.remove(&i).unwrap_or_else(|| {
                        IntegrationError::Unsupported(format!(
                            "no enabled provider serves {}",
                            s.key()
                        ))
                    })),
                },
            );
        }
        results
            .into_iter()
            .map(|r| r.unwrap_or_else(|| Err(IntegrationError::Internal("quote slot".into()))))
            .collect()
    }

    /// Daily/weekly/monthly bars for `[from, to]`. Closed daily bars are cached forever;
    /// a covered range is served without network.
    pub async fn bars(
        &self,
        key: &str,
        interval: BarInterval,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
        overrides: &ProviderSymbols,
    ) -> Result<BarSeries> {
        let symbol = Symbol::parse(key)?;
        if from > to {
            return Err(IntegrationError::Invalid("`from` is after `to`".into()));
        }
        if (to - from).num_days() > self.config.max_range_days {
            return Err(IntegrationError::Invalid("date range too long".into()));
        }
        let today = self.clock.today();
        let key = symbol.key();
        let closed_to = to.min(today.pred_opt().unwrap_or(today));
        let cached = self.bars.get(&key, adjusted);
        if let Some(series) = &cached
            && series.covers(from, closed_to)
            && !series.source.is_empty()
        {
            let bars = series.range(from, to);
            return Ok(self.finish(
                bars,
                series.currency.clone(),
                series.source.clone(),
                false,
                interval,
            ));
        }
        let fetch_from = cached
            .as_ref()
            .and_then(|s| {
                s.covered
                    .iter()
                    .find(|(a, b)| *a <= from && from <= *b)
                    .map(|(_, b)| *b)
            })
            .and_then(|b| b.succ_opt())
            .unwrap_or(from)
            .min(to);

        let chain = self.chains.read().daily.clone();
        let mut last_err: Option<IntegrationError> = None;
        for p in self.eligible(&chain, Capability::Daily) {
            let Some(ps) = p.map_symbol(&symbol, overrides.get(p.id()).map(String::as_str)) else {
                continue;
            };
            match p.daily(&symbol, &ps, fetch_from, to, adjusted).await {
                Ok(bars) if bars.is_empty() && (to - fetch_from).num_days() > 5 => {
                    last_err = Some(IntegrationError::NotFound(format!(
                        "{} has no data for {key}",
                        p.id()
                    )));
                }
                Ok(bars) => {
                    let currency = series_currency(&symbol, p.id());
                    self.bars.store(
                        &key,
                        adjusted,
                        Fetched {
                            bars: &bars,
                            from: fetch_from,
                            to,
                            currency: &currency,
                            source: p.id(),
                        },
                        today,
                    );
                    let merged = self
                        .bars
                        .get(&key, adjusted)
                        .map(|s| s.range(from, to))
                        .unwrap_or_default();
                    // Include today's (unclosed) bar from this fetch, if any.
                    let mut out = merged;
                    out.extend(bars.into_iter().filter(|b| b.date >= today && b.date <= to));
                    return Ok(self.finish(out, currency, p.id().to_string(), false, interval));
                }
                Err(e) => last_err = Some(e),
            }
        }
        if let Some(series) = cached {
            let bars = series.range(from, to);
            if !bars.is_empty() {
                return Ok(self.finish(bars, series.currency, series.source, true, interval));
            }
        }
        Err(last_err.unwrap_or_else(|| {
            IntegrationError::Unsupported(format!(
                "no enabled provider serves daily bars for {key}"
            ))
        }))
    }

    fn finish(
        &self,
        bars: Vec<Bar>,
        currency: String,
        source: String,
        stale: bool,
        interval: BarInterval,
    ) -> BarSeries {
        let (verified, unverified) = verify(bars, self.config.max_daily_move);
        BarSeries {
            bars: resample(&verified, interval),
            currency,
            source,
            stale,
            unverified,
        }
    }

    /// `market_search`: remote chain, then the built-in list; deduplicated, at most `limit`.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        if q.chars().count() > 512 {
            return Err(IntegrationError::Invalid("query too long".into()));
        }
        let limit = limit.clamp(1, 100);
        let cache_key = format!("{}|{limit}", q.to_lowercase());
        let now = self.clock.now();
        if let Some(hit) = self.search_cache.get(&cache_key, now) {
            return Ok(hit);
        }
        let chain = self.chains.read().search.clone();
        let providers = self.eligible(&chain, Capability::Search);
        let mut out: Vec<SearchResult> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut failures = 0usize;
        let mut last_err = None;
        for p in &providers {
            if out.len() >= limit {
                break;
            }
            match p.search(q, limit).await {
                Ok(hits) => {
                    for h in hits {
                        if seen.insert(h.symbol.clone()) {
                            out.push(h);
                        }
                    }
                }
                Err(e) => {
                    failures += 1;
                    last_err = Some(e);
                }
            }
        }
        if out.len() < limit
            && let Some(local) = &self.local
        {
            for h in local.search(q, limit) {
                if out.len() >= limit {
                    break;
                }
                if seen.insert(h.symbol.clone()) {
                    out.push(h);
                }
            }
        }
        out.truncate(limit);
        if out.is_empty()
            && !providers.is_empty()
            && failures == providers.len()
            && let Some(e) = last_err
        {
            return Err(e);
        }
        if failures == 0 {
            self.search_cache.put(&cache_key, out.clone(), now);
        }
        Ok(out)
    }

    /// `fx_rates`: latest (1 h TTL) or historical (immutable) rates; stale cache on failure.
    pub async fn fx(
        &self,
        base: &str,
        symbols: &[String],
        date: Option<NaiveDate>,
    ) -> Result<FxRates> {
        let base = base.trim().to_ascii_uppercase();
        if base.len() != 3 || !base.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(IntegrationError::Invalid(
                "base must be a 3-letter currency".into(),
            ));
        }
        let today = self.clock.today();
        if date.is_some_and(|d| d > today) {
            return Err(IntegrationError::Invalid("date is in the future".into()));
        }
        let date_key = match date {
            Some(d) if d < today => d.format("%Y-%m-%d").to_string(),
            _ => "latest".to_string(),
        };
        let wanted: Vec<String> = symbols
            .iter()
            .map(|s| s.trim().to_ascii_uppercase())
            .collect();
        let now = self.clock.now();
        let cached = self.fx.get(&base, &date_key, now);
        if let Some((r, true)) = &cached {
            return Ok(filter_rates(r.clone(), &wanted, false));
        }
        let chain = self.chains.read().fx.clone();
        let mut last_err = None;
        let fetch_date = (date_key != "latest").then_some(date).flatten();
        for p in self.eligible(&chain, Capability::Fx) {
            match p.fx(&base, &[], fetch_date).await {
                Ok(r) => {
                    self.fx.put(&base, &date_key, r.clone(), now);
                    return Ok(filter_rates(r, &wanted, false));
                }
                Err(e) => last_err = Some(e),
            }
        }
        if let Some((r, _)) = cached {
            return Ok(filter_rates(r, &wanted, true));
        }
        Err(last_err
            .unwrap_or_else(|| IntegrationError::Unsupported("no FX provider enabled".into())))
    }

    /// Dividends with ex-date in `[from, to]`.
    pub async fn dividends(
        &self,
        key: &str,
        from: NaiveDate,
        to: NaiveDate,
        overrides: &ProviderSymbols,
    ) -> Result<Vec<Dividend>> {
        let symbol = Symbol::parse(key)?;
        let chain = self.chains.read().dividends.clone();
        let mut last_err = None;
        for p in self.eligible(&chain, Capability::Dividends) {
            let Some(ps) = p.map_symbol(&symbol, overrides.get(p.id()).map(String::as_str)) else {
                continue;
            };
            match p.dividends(&symbol, &ps, from, to).await {
                Ok(d) => return Ok(d),
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| {
            IntegrationError::Unsupported(format!("no enabled provider serves dividends for {key}"))
        }))
    }
}

fn series_currency(symbol: &Symbol, provider: &str) -> String {
    if symbol.is_crypto() {
        return "USD".into();
    }
    if let Some((_, quote)) = symbol.fx_pair() {
        return quote.to_string();
    }
    if provider == "tiingo" {
        return "USD".into();
    }
    symbol.default_currency().to_string()
}

fn filter_rates(mut r: FxRates, wanted: &[String], stale: bool) -> FxRates {
    if !wanted.is_empty() {
        let keep: BTreeMap<String, f64> = r
            .rates
            .into_iter()
            .filter(|(k, _)| wanted.contains(k))
            .collect();
        r.rates = keep;
    }
    r.stale = stale;
    r
}

/// Drop non-finite bars and flag moves above `max_move` (fraction) with no split flag.
pub fn verify(bars: Vec<Bar>, max_move: f64) -> (Vec<Bar>, Vec<NaiveDate>) {
    let mut out = Vec::with_capacity(bars.len());
    let mut unverified = Vec::new();
    let mut prev_close: Option<f64> = None;
    for b in bars {
        if !b.is_finite() || b.close <= 0.0 {
            continue;
        }
        if let Some(p) = prev_close {
            let mv = (b.close / p - 1.0).abs();
            if mv > max_move && b.split.is_none() {
                unverified.push(b.date);
                continue;
            }
        }
        prev_close = Some(b.close);
        out.push(b);
    }
    (out, unverified)
}

/// Aggregate daily bars into ISO weeks or calendar months.
pub fn resample(bars: &[Bar], interval: BarInterval) -> Vec<Bar> {
    let bucket = |d: NaiveDate| -> (i32, u32) {
        match interval {
            BarInterval::Day => (d.year(), d.ordinal()),
            BarInterval::Week => {
                let w = d.iso_week();
                (w.year(), w.week())
            }
            BarInterval::Month => (d.year(), d.month()),
        }
    };
    if interval == BarInterval::Day {
        return bars.to_vec();
    }
    let mut out: Vec<Bar> = Vec::new();
    let mut current: Option<((i32, u32), Bar)> = None;
    for b in bars {
        let k = bucket(b.date);
        match &mut current {
            Some((ck, agg)) if *ck == k => {
                agg.high = agg.high.max(b.high);
                agg.low = agg.low.min(b.low);
                agg.close = b.close;
                agg.volume += b.volume;
                agg.adj_close = b.adj_close;
                agg.dividend = match (agg.dividend, b.dividend) {
                    (Some(a), Some(c)) => Some(a + c),
                    (a, c) => a.or(c),
                };
                agg.split = match (agg.split, b.split) {
                    (Some(a), Some(c)) => Some(a * c),
                    (a, c) => a.or(c),
                };
            }
            _ => {
                if let Some((_, agg)) = current.take() {
                    out.push(agg);
                }
                current = Some((k, b.clone()));
            }
        }
    }
    if let Some((_, agg)) = current {
        out.push(agg);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::cache::ManualClock;
    use crate::market::provider::ProviderMeta;
    use crate::market::{Freshness, InstrumentType, MarketState};
    use crate::netguard::{ConnectorId, NetGuardConfig};
    use async_trait::async_trait;
    use chrono::{TimeZone, Utc};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    struct Fake {
        id: &'static str,
        caps: &'static [Capability],
        needs_key: bool,
        key: RwLock<Option<SecretString>>,
        fail: bool,
        crypto_only: bool,
        calls: AtomicUsize,
        bars: Vec<Bar>,
    }

    impl Fake {
        fn new(id: &'static str, caps: &'static [Capability]) -> Self {
            Fake {
                id,
                caps,
                needs_key: false,
                key: RwLock::new(None),
                fail: false,
                crypto_only: false,
                calls: AtomicUsize::new(0),
                bars: Vec::new(),
            }
        }
    }

    #[async_trait]
    impl MarketProvider for Fake {
        fn meta(&self) -> ProviderMeta {
            ProviderMeta {
                id: self.id,
                name: self.id,
                connector: ConnectorId::Stooq,
                needs_key: self.needs_key,
                terms_url: "https://example.com",
                community: false,
                caps: self.caps,
                default_enabled: true,
            }
        }
        fn configured(&self) -> bool {
            !self.needs_key || self.key.read().is_some()
        }
        fn set_api_key(&self, key: Option<SecretString>) {
            *self.key.write() = key;
        }
        fn map_symbol(&self, s: &Symbol, o: Option<&str>) -> Option<String> {
            if self.crypto_only && !s.is_crypto() {
                return None;
            }
            Some(
                o.map(str::to_string)
                    .unwrap_or_else(|| s.ticker.to_lowercase()),
            )
        }
        async fn quote(&self, s: &Symbol, _ps: &str) -> Result<Quote> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(IntegrationError::Network("down".into()));
            }
            Ok(Quote {
                symbol: s.key(),
                price: 10.0,
                change: 1.0,
                change_pct: 10.0,
                open: None,
                high: None,
                low: None,
                prev_close: Some(9.0),
                volume: None,
                currency: "USD".into(),
                market_state: MarketState::Open,
                as_of: 0,
                source: self.id.into(),
                freshness: Freshness::Live,
                delayed_min: 0,
            })
        }
        async fn daily(
            &self,
            _s: &Symbol,
            _ps: &str,
            from: NaiveDate,
            to: NaiveDate,
            _a: bool,
        ) -> Result<Vec<Bar>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(IntegrationError::Network("down".into()));
            }
            Ok(self
                .bars
                .iter()
                .filter(|b| b.date >= from && b.date <= to)
                .cloned()
                .collect())
        }
        async fn search(&self, q: &str, _limit: usize) -> Result<Vec<SearchResult>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(IntegrationError::Network("down".into()));
            }
            Ok(vec![SearchResult {
                symbol: format!("{}:XNAS", q.to_uppercase()),
                name: "Remote".into(),
                exchange: "US".into(),
                kind: InstrumentType::Equity,
                currency: "USD".into(),
            }])
        }
        async fn fx(&self, base: &str, _s: &[String], date: Option<NaiveDate>) -> Result<FxRates> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(IntegrationError::Network("down".into()));
            }
            Ok(FxRates {
                base: base.into(),
                date: date
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| "2026-11-25".into()),
                rates: [("EUR".to_string(), 0.9), ("GBP".to_string(), 0.8)]
                    .into_iter()
                    .collect(),
                source: self.id.into(),
                stale: false,
            })
        }
        async fn ping(&self) -> Result<()> {
            if self.fail {
                Err(IntegrationError::Network("down".into()))
            } else {
                Ok(())
            }
        }
    }

    fn guard() -> NetGuard {
        NetGuard::new(NetGuardConfig::default()).unwrap()
    }

    fn clock() -> Arc<ManualClock> {
        Arc::new(ManualClock::new(
            Utc.with_ymd_and_hms(2026, 11, 26, 15, 0, 0).unwrap(),
        ))
    }

    fn router(providers: Vec<Arc<dyn MarketProvider>>, clock: Arc<ManualClock>) -> MarketRouter {
        MarketRouter::with_providers(guard(), providers, clock, RouterConfig::default())
    }

    fn daily_bars(from: NaiveDate, n: i64) -> Vec<Bar> {
        (0..n)
            .map(|i| Bar::close_only(from + chrono::Duration::days(i), 100.0 + i as f64, 1.0))
            .collect()
    }

    #[tokio::test]
    async fn quote_chain_falls_back_and_caches_with_ttl() {
        let clock = clock();
        let mut finnhub = Fake::new("finnhub", &[Capability::Quote]);
        finnhub.needs_key = true;
        let finnhub = Arc::new(finnhub);
        let mut cg = Fake::new("coingecko", &[Capability::Quote]);
        cg.crypto_only = true;
        let cg = Arc::new(cg);
        let mut stooq = Fake::new("stooq", &[Capability::Quote]);
        stooq.fail = false;
        let stooq = Arc::new(stooq);
        let r = router(
            vec![finnhub.clone(), cg.clone(), stooq.clone()],
            clock.clone(),
        );

        let keys = vec![
            "AAPL:XNAS".to_string(),
            "BTC:CRYPTO".to_string(),
            "bad".to_string(),
        ];
        let out = r.quotes(&keys, &HashMap::new()).await;
        assert_eq!(
            out[0].as_ref().unwrap().source,
            "stooq",
            "finnhub unconfigured → skipped"
        );
        assert_eq!(out[1].as_ref().unwrap().source, "coingecko");
        assert!(out[2].is_err());
        assert_eq!(finnhub.calls.load(Ordering::SeqCst), 0);

        // Within TTL: served from cache.
        let _ = r.quotes(&keys[..2], &HashMap::new()).await;
        assert_eq!(stooq.calls.load(Ordering::SeqCst), 1);
        assert_eq!(cg.calls.load(Ordering::SeqCst), 1);
        clock.advance(Duration::from_secs(61));
        let _ = r.quotes(&keys[..1], &HashMap::new()).await;
        assert_eq!(stooq.calls.load(Ordering::SeqCst), 2);

        // Configure finnhub with a key and move it first: now preferred.
        let info = r
            .configure(
                "finnhub",
                true,
                KeyUpdate::Set(SecretString::new("k")),
                Some(0),
            )
            .unwrap();
        assert!(info.configured && info.enabled);
        clock.advance(Duration::from_secs(61));
        let out = r.quotes(&keys[..1], &HashMap::new()).await;
        assert_eq!(out[0].as_ref().unwrap().source, "finnhub");
    }

    #[tokio::test]
    async fn stale_quote_served_when_all_fail() {
        let clock = clock();
        let p = Arc::new(Fake::new("stooq", &[Capability::Quote]));
        let r = router(vec![p.clone()], clock.clone());
        let k = vec!["AAPL:XNAS".to_string()];
        r.quotes(&k, &HashMap::new()).await[0].as_ref().unwrap();
        r.configure("stooq", false, KeyUpdate::Keep, None).unwrap();
        clock.advance(Duration::from_secs(120));
        let out = r.quotes(&k, &HashMap::new()).await;
        assert_eq!(out[0].as_ref().unwrap().price, 10.0);
        assert!(!r.cached_quote("AAPL:XNAS").unwrap().1);
        let out = r.quotes(&["MSFT:XNAS".to_string()], &HashMap::new()).await;
        assert_eq!(out[0].as_ref().unwrap_err().code().as_str(), "UNSUPPORTED");
    }

    #[tokio::test]
    async fn closed_bars_are_cached_forever_and_resampled() {
        let clock = clock();
        let mut tiingo = Fake::new("tiingo", &[Capability::Daily]);
        tiingo.bars = daily_bars(d(2026, 10, 1), 57); // through 2026-11-26 (today)
        let tiingo = Arc::new(tiingo);
        let r = router(vec![tiingo.clone()], clock.clone());
        let s = r
            .bars(
                "AAPL:XNAS",
                BarInterval::Day,
                d(2026, 10, 1),
                d(2026, 11, 26),
                false,
                &ProviderSymbols::new(),
            )
            .await
            .unwrap();
        assert_eq!(s.bars.len(), 57, "includes today's unclosed bar");
        assert_eq!(tiingo.calls.load(Ordering::SeqCst), 1);
        // Closed range again: no network.
        let s = r
            .bars(
                "AAPL:XNAS",
                BarInterval::Day,
                d(2026, 10, 5),
                d(2026, 11, 20),
                false,
                &ProviderSymbols::new(),
            )
            .await
            .unwrap();
        assert_eq!(s.bars.len(), 47);
        assert_eq!(tiingo.calls.load(Ordering::SeqCst), 1);
        // Weekly resample.
        let w = r
            .bars(
                "AAPL:XNAS",
                BarInterval::Month,
                d(2026, 10, 1),
                d(2026, 11, 20),
                false,
                &ProviderSymbols::new(),
            )
            .await
            .unwrap();
        assert_eq!(w.bars.len(), 2);
        assert_eq!(w.bars[0].open, 100.0);
        assert_eq!(w.bars[0].close, 130.0);
        assert_eq!(w.bars[0].volume, 31.0);
        let ipc = w.to_ipc();
        assert_eq!(ipc.t[0], date_to_millis(d(2026, 10, 1)));
        assert_eq!(ipc.source, "tiingo");
        // Adjusted series are cached separately.
        r.bars(
            "AAPL:XNAS",
            BarInterval::Day,
            d(2026, 10, 1),
            d(2026, 10, 9),
            true,
            &ProviderSymbols::new(),
        )
        .await
        .unwrap();
        assert_eq!(tiingo.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn daily_chain_fallback_and_stale_cache() {
        let clock = clock();
        let mut tiingo = Fake::new("tiingo", &[Capability::Daily]);
        tiingo.fail = true;
        let tiingo = Arc::new(tiingo);
        let mut stooq = Fake::new("stooq", &[Capability::Daily]);
        stooq.bars = daily_bars(d(2026, 11, 1), 20);
        let stooq = Arc::new(stooq);
        let r = router(vec![tiingo.clone(), stooq.clone()], clock.clone());
        let s = r
            .bars(
                "AAPL:XNAS",
                BarInterval::Day,
                d(2026, 11, 1),
                d(2026, 11, 10),
                false,
                &ProviderSymbols::new(),
            )
            .await
            .unwrap();
        assert_eq!(s.source, "stooq");
        assert_eq!(tiingo.calls.load(Ordering::SeqCst), 1);
        // Extend beyond cached range while all providers fail → stale partial.
        r.configure("stooq", false, KeyUpdate::Keep, None).unwrap();
        let s = r
            .bars(
                "AAPL:XNAS",
                BarInterval::Day,
                d(2026, 11, 1),
                d(2026, 11, 20),
                false,
                &ProviderSymbols::new(),
            )
            .await
            .unwrap();
        assert!(s.stale);
        assert_eq!(s.bars.len(), 10);
        let err = r
            .bars(
                "MSFT:XNAS",
                BarInterval::Day,
                d(2026, 11, 1),
                d(2026, 11, 20),
                false,
                &ProviderSymbols::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::Network(_)));
    }

    #[test]
    fn verify_flags_big_moves_without_split() {
        let mut bars = daily_bars(d(2026, 1, 1), 3);
        bars[1].close = 300.0; // +197 %
        let mut split = Bar::close_only(d(2026, 1, 4), 25.0, 1.0);
        split.split = Some(4.0);
        bars.push(split);
        let (ok, bad) = verify(bars, 0.5);
        assert_eq!(bad, vec![d(2026, 1, 2)]);
        assert_eq!(ok.len(), 3);
        let mut nan = Bar::close_only(d(2026, 1, 5), f64::NAN, 1.0);
        nan.open = f64::INFINITY;
        let (ok, _) = verify(vec![nan], 0.5);
        assert!(ok.is_empty());
    }

    #[test]
    fn weekly_resample_uses_iso_weeks() {
        // 2026-11-23 is a Monday.
        let bars = daily_bars(d(2026, 11, 19), 8);
        let w = resample(&bars, BarInterval::Week);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].date, d(2026, 11, 19));
        assert_eq!(w[1].date, d(2026, 11, 23));
        assert_eq!(w[1].close, 107.0);
        assert_eq!(w[1].high, 107.0);
        assert_eq!(w[1].low, 104.0);
    }

    struct Local;
    impl LocalSymbolSearch for Local {
        fn search(&self, q: &str, _limit: usize) -> Vec<SearchResult> {
            vec![
                SearchResult {
                    symbol: format!("{}:XNAS", q.to_uppercase()),
                    name: "Local dup".into(),
                    exchange: "NASDAQ".into(),
                    kind: InstrumentType::Equity,
                    currency: "USD".into(),
                },
                SearchResult {
                    symbol: "BTC:CRYPTO".into(),
                    name: "Bitcoin".into(),
                    exchange: "CRYPTO".into(),
                    kind: InstrumentType::Crypto,
                    currency: "USD".into(),
                },
            ]
        }
    }

    #[tokio::test]
    async fn search_merges_remote_and_local_with_cache() {
        let clock = clock();
        let finnhub = Arc::new(Fake::new("finnhub", &[Capability::Search]));
        let mut r = router(vec![finnhub.clone()], clock.clone());
        r.set_local_search(Arc::new(Local));
        let out = r.search(" aapl ", 10).await.unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "Remote");
        assert_eq!(out[1].symbol, "BTC:CRYPTO");
        r.search("aapl", 10).await.unwrap();
        assert_eq!(finnhub.calls.load(Ordering::SeqCst), 1, "cached");
        assert!(r.search("", 10).await.unwrap().is_empty());
        assert!(r.search(&"x".repeat(600), 10).await.is_err());
        assert_eq!(r.search("zzz", 1).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn fx_cache_semantics() {
        let clock = clock();
        let fr = Arc::new(Fake::new("frankfurter", &[Capability::Fx]));
        let r = router(vec![fr.clone()], clock.clone());
        let a = r.fx("usd", &["EUR".into()], None).await.unwrap();
        assert_eq!(a.rates.len(), 1);
        assert!(!a.stale);
        r.fx("USD", &[], None).await.unwrap();
        assert_eq!(fr.calls.load(Ordering::SeqCst), 1);
        r.fx("USD", &[], Some(d(2026, 1, 2))).await.unwrap();
        clock.advance(Duration::from_secs(7200));
        r.fx("USD", &[], Some(d(2026, 1, 2))).await.unwrap();
        assert_eq!(
            fr.calls.load(Ordering::SeqCst),
            2,
            "historical rates immutable"
        );
        r.configure("frankfurter", false, KeyUpdate::Keep, None)
            .unwrap();
        let stale = r.fx("USD", &[], None).await.unwrap();
        assert!(stale.stale);
        assert!(r.fx("USD", &[], Some(d(2027, 1, 1))).await.is_err());
        assert!(r.fx("US", &[], None).await.is_err());
    }

    #[tokio::test]
    async fn provider_info_and_test() {
        let clock = clock();
        let mut f = Fake::new("tiingo", &[Capability::Daily]);
        f.needs_key = true;
        let r = router(vec![Arc::new(f)], clock);
        let info = r.providers_info();
        assert_eq!(info[0].id, "tiingo");
        assert!(!info[0].configured);
        let json = serde_json::to_value(&info[0]).unwrap();
        assert_eq!(json["needsKey"], true);
        assert_eq!(json["health"], "unknown");
        let t = r.test("tiingo").await.unwrap();
        assert!(t.ok);
        assert!(r.test("nope").await.is_err());
        assert!(r.configure("nope", true, KeyUpdate::Keep, None).is_err());
    }

    #[test]
    fn default_router_has_builtin_providers() {
        let r = MarketRouter::new(guard(), Arc::new(crate::market::SystemClock));
        let ids: Vec<String> = r.providers_info().into_iter().map(|p| p.id).collect();
        assert_eq!(
            &ids[..5],
            &["frankfurter", "stooq", "coingecko", "finnhub", "tiingo"]
        );
        let finnhub = r
            .providers_info()
            .into_iter()
            .find(|p| p.id == "finnhub")
            .unwrap();
        assert!(finnhub.needs_key && !finnhub.configured);
        assert_eq!(r.chains().search, vec!["finnhub", "tiingo"]);
    }
}
