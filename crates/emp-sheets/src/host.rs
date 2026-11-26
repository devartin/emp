//! Injected inputs (SPEC §9.17 purity): the clock, randomness, and the market/FX cache used by
//! `STOCK`, `FX` and `CRYPTO`. The engine never performs IO; the host answers from a local cache and
//! the engine reports which keys were requested so the app can fetch them outside the engine.

use crate::value::Value;
use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};

/// Identifies one piece of external data.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExternalKey {
    /// `STOCK(symbol, field)`.
    Stock {
        /// Upper-case symbol key, e.g. `AAPL` or `AAPL:XNAS`.
        symbol: String,
        /// Lower-case field (`price`, `change`, …).
        field: String,
    },
    /// `FX(from, to, [date])`.
    Fx {
        /// ISO-4217 code.
        from: String,
        /// ISO-4217 code.
        to: String,
        /// `YYYY-MM-DD`, or `None` for the latest rate.
        date: Option<String>,
    },
    /// `CRYPTO(id, field)`.
    Crypto {
        /// Lower-case coin id or symbol.
        id: String,
        /// Lower-case field.
        field: String,
    },
}

/// Answer for an external lookup.
#[derive(Clone, Debug, PartialEq)]
pub enum ExternalValue {
    /// Cached value.
    Ready(Value),
    /// Not cached yet: the formula shows `#FETCH!` and the key is reported for fetching.
    Pending,
    /// The provider does not know this symbol/field (`#N/A`).
    Unavailable,
}

/// Everything the engine may read from the outside world.
pub trait Host: Send + Sync {
    /// Current local date and time (for `NOW`, `TODAY`).
    fn now(&self) -> NaiveDateTime;
    /// A uniformly distributed number in `[0, 1)`.
    fn random(&self) -> f64;
    /// Look up cached external data. Must not block or perform IO.
    fn external(&self, key: &ExternalKey) -> ExternalValue;
}

/// A ready-to-use host: system clock (or a fixed one), seeded xorshift RNG, and an in-memory cache.
pub struct CacheHost {
    fixed_now: RwLock<Option<NaiveDateTime>>,
    rng: AtomicU64,
    cache: RwLock<HashMap<ExternalKey, ExternalValue>>,
}

impl Default for CacheHost {
    fn default() -> Self {
        let seed = chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or(0x1E37_79B9_7F4A_7C15) as u64
            | 1;
        CacheHost {
            fixed_now: RwLock::new(None),
            rng: AtomicU64::new(seed),
            cache: RwLock::new(HashMap::new()),
        }
    }
}

impl CacheHost {
    /// A host using the system clock.
    pub fn new() -> Self {
        Self::default()
    }
    /// A deterministic host (fixed clock and seed), handy for tests and previews.
    pub fn fixed(now: NaiveDateTime, seed: u64) -> Self {
        CacheHost {
            fixed_now: RwLock::new(Some(now)),
            rng: AtomicU64::new(seed | 1),
            cache: RwLock::new(HashMap::new()),
        }
    }
    /// Pin (or unpin with `None`) the clock.
    pub fn set_now(&self, now: Option<NaiveDateTime>) {
        if let Ok(mut g) = self.fixed_now.write() {
            *g = now;
        }
    }
    /// Store a cached value.
    pub fn set(&self, key: ExternalKey, value: ExternalValue) {
        if let Ok(mut g) = self.cache.write() {
            g.insert(key, value);
        }
    }
    /// Remove a cached value (it becomes pending again).
    pub fn remove(&self, key: &ExternalKey) {
        if let Ok(mut g) = self.cache.write() {
            g.remove(key);
        }
    }
}

impl Host for CacheHost {
    fn now(&self) -> NaiveDateTime {
        if let Ok(g) = self.fixed_now.read()
            && let Some(n) = *g
        {
            return n;
        }
        chrono::Local::now().naive_local()
    }
    fn random(&self) -> f64 {
        // xorshift64*
        let mut x = self.rng.load(Ordering::Relaxed);
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng.store(x, Ordering::Relaxed);
        let r = x.wrapping_mul(0x2545_F491_4F6C_DD1D);
        (r >> 11) as f64 / (1u64 << 53) as f64
    }
    fn external(&self, key: &ExternalKey) -> ExternalValue {
        match self.cache.read() {
            Ok(g) => g.get(key).cloned().unwrap_or(ExternalValue::Pending),
            Err(_) => ExternalValue::Pending,
        }
    }
}

/// Default date used by deterministic hosts in tests: 2026-11-26 12:00.
pub fn test_now() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 11, 26)
        .and_then(|d| d.and_hms_opt(12, 0, 0))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_in_range_and_cache() {
        let h = CacheHost::fixed(test_now(), 42);
        for _ in 0..1000 {
            let r = h.random();
            assert!((0.0..1.0).contains(&r));
        }
        let k = ExternalKey::Stock {
            symbol: "AAPL".into(),
            field: "price".into(),
        };
        assert_eq!(h.external(&k), ExternalValue::Pending);
        h.set(k.clone(), ExternalValue::Ready(Value::Number(190.5)));
        assert_eq!(h.external(&k), ExternalValue::Ready(Value::Number(190.5)));
        assert_eq!(h.now(), test_now());
    }
}
