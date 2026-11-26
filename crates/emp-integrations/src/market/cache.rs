//! In-memory market caches and the injectable clock.
//!
//! - Quotes: 60 s TTL; expired entries are still returned (as stale) when a refresh fails.
//! - Daily bars: closed bars (dated before today, UTC) are immutable and kept forever, with
//!   the covered date ranges tracked so repeat requests are served without network.
//! - FX: rates for past dates are immutable; "latest" has a 1 h TTL.
//! - Search: 10 min TTL.
//!
//! Persisting caches (`kv ns=market.*`) is the caller's job: [`BarCache::export`] /
//! [`BarCache::import`] move closed bars in and out.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use chrono::{DateTime, NaiveDate, Utc};
use parking_lot::Mutex;

use super::{Bar, FxRates, Quote, SearchResult};

/// Time source (injectable for tests).
pub trait Clock: Send + Sync {
    /// Current time.
    fn now(&self) -> DateTime<Utc>;

    /// Today's date (UTC).
    fn today(&self) -> NaiveDate {
        self.now().date_naive()
    }
}

/// The system clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A manually advanced clock for tests and simulations.
#[derive(Debug)]
pub struct ManualClock(Mutex<DateTime<Utc>>);

impl ManualClock {
    /// Start at `t`.
    pub fn new(t: DateTime<Utc>) -> Self {
        ManualClock(Mutex::new(t))
    }

    /// Advance by `d`.
    pub fn advance(&self, d: Duration) {
        let mut t = self.0.lock();
        *t += chrono::Duration::from_std(d).unwrap_or(chrono::Duration::zero());
    }

    /// Jump to `t`.
    pub fn set(&self, t: DateTime<Utc>) {
        *self.0.lock() = t;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock()
    }
}

/// Quote TTL (SPEC §17.2).
pub const QUOTE_TTL: Duration = Duration::from_secs(60);
/// Latest FX TTL.
pub const FX_LATEST_TTL: Duration = Duration::from_secs(3600);
/// Search TTL.
pub const SEARCH_TTL: Duration = Duration::from_secs(600);

fn age(now: DateTime<Utc>, at: DateTime<Utc>) -> Duration {
    (now - at).to_std().unwrap_or(Duration::ZERO)
}

/// Quote cache.
#[derive(Debug, Default)]
pub struct QuoteCache {
    map: Mutex<HashMap<String, (Quote, DateTime<Utc>)>>,
}

impl QuoteCache {
    /// Insert a fetched quote.
    pub fn put(&self, quote: Quote, now: DateTime<Utc>) {
        self.map.lock().insert(quote.symbol.clone(), (quote, now));
    }

    /// The cached quote and whether it is still fresh.
    pub fn get(&self, key: &str, now: DateTime<Utc>, ttl: Duration) -> Option<(Quote, bool)> {
        self.map
            .lock()
            .get(key)
            .map(|(q, at)| (q.clone(), age(now, *at) < ttl))
    }
}

/// One cached daily series (serializable for persistence in `kv ns=market.bars`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSeries {
    /// Closed bars by date.
    pub bars: BTreeMap<NaiveDate, Bar>,
    /// Inclusive date ranges known to be complete (merged, sorted).
    pub covered: Vec<(NaiveDate, NaiveDate)>,
    /// Currency.
    pub currency: String,
    /// Provider that supplied the data.
    pub source: String,
}

impl CachedSeries {
    /// Whether `[from, to]` is fully covered.
    pub fn covers(&self, from: NaiveDate, to: NaiveDate) -> bool {
        from > to || self.covered.iter().any(|(a, b)| *a <= from && to <= *b)
    }

    /// Add a covered range, merging overlaps and adjacent ranges.
    pub fn add_covered(&mut self, from: NaiveDate, to: NaiveDate) {
        if from > to {
            return;
        }
        self.covered.push((from, to));
        self.covered.sort();
        let mut merged: Vec<(NaiveDate, NaiveDate)> = Vec::with_capacity(self.covered.len());
        for (a, b) in self.covered.drain(..) {
            match merged.last_mut() {
                Some((_, mb)) if a <= mb.succ_opt().unwrap_or(*mb) => {
                    if b > *mb {
                        *mb = b;
                    }
                }
                _ => merged.push((a, b)),
            }
        }
        self.covered = merged;
    }

    /// Bars in `[from, to]`.
    pub fn range(&self, from: NaiveDate, to: NaiveDate) -> Vec<Bar> {
        if from > to {
            return Vec::new();
        }
        self.bars.range(from..=to).map(|(_, b)| b.clone()).collect()
    }
}

/// A fetch result to merge into the [`BarCache`].
#[derive(Debug, Clone, Copy)]
pub struct Fetched<'a> {
    /// Bars returned by the provider.
    pub bars: &'a [Bar],
    /// Requested start.
    pub from: NaiveDate,
    /// Requested end.
    pub to: NaiveDate,
    /// Series currency.
    pub currency: &'a str,
    /// Provider id.
    pub source: &'a str,
}

/// Daily bar cache keyed by `(symbol, adjusted)`.
#[derive(Debug, Default)]
pub struct BarCache {
    map: Mutex<HashMap<(String, bool), CachedSeries>>,
}

impl BarCache {
    /// A copy of a cached series.
    pub fn get(&self, key: &str, adjusted: bool) -> Option<CachedSeries> {
        self.map.lock().get(&(key.to_string(), adjusted)).cloned()
    }

    /// Store closed bars (dated before `today`) and mark `[from, min(to, today-1)]` covered.
    pub fn store(&self, key: &str, adjusted: bool, fetched: Fetched<'_>, today: NaiveDate) {
        let mut map = self.map.lock();
        let series = map.entry((key.to_string(), adjusted)).or_default();
        for b in fetched.bars.iter().filter(|b| b.date < today) {
            series.bars.insert(b.date, b.clone());
        }
        if let Some(last_closed) = today.pred_opt() {
            series.add_covered(fetched.from, fetched.to.min(last_closed));
        }
        series.currency = fetched.currency.to_string();
        series.source = fetched.source.to_string();
    }

    /// Export everything for persistence.
    pub fn export(&self) -> Vec<(String, bool, CachedSeries)> {
        self.map
            .lock()
            .iter()
            .map(|((k, a), s)| (k.clone(), *a, s.clone()))
            .collect()
    }

    /// Import previously persisted series.
    pub fn import(&self, items: Vec<(String, bool, CachedSeries)>) {
        let mut map = self.map.lock();
        for (k, a, s) in items {
            map.insert((k, a), s);
        }
    }
}

type FxMap = HashMap<(String, String), (FxRates, DateTime<Utc>)>;
type SearchMap = HashMap<String, (Vec<SearchResult>, DateTime<Utc>)>;

/// FX cache keyed by `(base, date-or-"latest")`.
#[derive(Debug, Default)]
pub struct FxCache {
    map: Mutex<FxMap>,
}

impl FxCache {
    /// Insert.
    pub fn put(&self, base: &str, date_key: &str, rates: FxRates, now: DateTime<Utc>) {
        self.map
            .lock()
            .insert((base.to_string(), date_key.to_string()), (rates, now));
    }

    /// Lookup with freshness: historical entries never expire; `latest` uses its TTL.
    pub fn get(&self, base: &str, date_key: &str, now: DateTime<Utc>) -> Option<(FxRates, bool)> {
        self.map
            .lock()
            .get(&(base.to_string(), date_key.to_string()))
            .map(|(r, at)| {
                (
                    r.clone(),
                    date_key != "latest" || age(now, *at) < FX_LATEST_TTL,
                )
            })
    }
}

/// Search cache.
#[derive(Debug, Default)]
pub struct SearchCache {
    map: Mutex<SearchMap>,
}

impl SearchCache {
    /// Insert.
    pub fn put(&self, q: &str, results: Vec<SearchResult>, now: DateTime<Utc>) {
        let mut map = self.map.lock();
        if map.len() > 500 {
            map.clear();
        }
        map.insert(q.to_string(), (results, now));
    }

    /// Fresh results only.
    pub fn get(&self, q: &str, now: DateTime<Utc>) -> Option<Vec<SearchResult>> {
        self.map
            .lock()
            .get(q)
            .filter(|(_, at)| age(now, *at) < SEARCH_TTL)
            .map(|(r, _)| r.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn covered_ranges_merge() {
        let mut s = CachedSeries::default();
        s.add_covered(d(2026, 1, 1), d(2026, 1, 10));
        s.add_covered(d(2026, 1, 11), d(2026, 1, 20));
        s.add_covered(d(2026, 2, 1), d(2026, 2, 5));
        s.add_covered(d(2026, 1, 5), d(2026, 1, 15));
        assert_eq!(
            s.covered,
            vec![
                (d(2026, 1, 1), d(2026, 1, 20)),
                (d(2026, 2, 1), d(2026, 2, 5))
            ]
        );
        assert!(s.covers(d(2026, 1, 3), d(2026, 1, 19)));
        assert!(!s.covers(d(2026, 1, 3), d(2026, 2, 2)));
    }

    #[test]
    fn bar_cache_keeps_only_closed_bars() {
        let c = BarCache::default();
        let today = d(2026, 11, 26);
        let bars = vec![
            Bar::close_only(d(2026, 11, 25), 1.0, 0.0),
            Bar::close_only(today, 2.0, 0.0),
        ];
        c.store(
            "A:XNAS",
            false,
            Fetched {
                bars: &bars,
                from: d(2026, 11, 1),
                to: today,
                currency: "USD",
                source: "stooq",
            },
            today,
        );
        let s = c.get("A:XNAS", false).unwrap();
        assert_eq!(s.bars.len(), 1);
        assert!(s.covers(d(2026, 11, 1), d(2026, 11, 25)));
        assert!(!s.covers(d(2026, 11, 1), today));
        assert!(c.get("A:XNAS", true).is_none());
        let exported = c.export();
        let c2 = BarCache::default();
        c2.import(exported);
        assert_eq!(c2.get("A:XNAS", false).unwrap(), s);
    }

    #[test]
    fn ttl_semantics() {
        let t0 = Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0).unwrap();
        let clock = ManualClock::new(t0);
        let qc = QuoteCache::default();
        let q = Quote {
            symbol: "A:XNAS".into(),
            price: 1.0,
            change: 0.0,
            change_pct: 0.0,
            open: None,
            high: None,
            low: None,
            prev_close: None,
            volume: None,
            currency: "USD".into(),
            market_state: super::super::MarketState::Open,
            as_of: 0,
            source: "x".into(),
            freshness: super::super::Freshness::Live,
            delayed_min: 0,
        };
        qc.put(q, clock.now());
        assert!(qc.get("A:XNAS", clock.now(), QUOTE_TTL).unwrap().1);
        clock.advance(Duration::from_secs(61));
        assert!(!qc.get("A:XNAS", clock.now(), QUOTE_TTL).unwrap().1);

        let fx = FxCache::default();
        let r = FxRates {
            base: "USD".into(),
            date: "2026-11-25".into(),
            rates: BTreeMap::new(),
            source: "frankfurter".into(),
            stale: false,
        };
        fx.put("USD", "latest", r.clone(), t0);
        fx.put("USD", "2026-01-02", r, t0);
        clock.set(t0 + chrono::Duration::hours(2));
        assert!(!fx.get("USD", "latest", clock.now()).unwrap().1);
        assert!(fx.get("USD", "2026-01-02", clock.now()).unwrap().1);
        assert_eq!(clock.today(), d(2026, 11, 26));
    }
}
