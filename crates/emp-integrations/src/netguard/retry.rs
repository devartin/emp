//! Exponential backoff with jitter and `Retry-After` parsing.

use std::time::Duration;

use chrono::{DateTime, Utc};
use rand_core::{OsRng, RngCore};

/// Backoff configuration.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    /// Delay before the first retry (before jitter).
    pub base: Duration,
    /// Upper bound for any computed delay.
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            base: Duration::from_millis(500),
            max: Duration::from_secs(8),
        }
    }
}

impl Backoff {
    /// Delay before retry number `attempt` (0-based): "equal jitter", i.e. half of
    /// `base·2^attempt` plus a uniformly random share of the other half, capped at `max`.
    pub fn delay(&self, attempt: u32) -> Duration {
        let exp = self
            .base
            .saturating_mul(1u32.checked_shl(attempt.min(16)).unwrap_or(u32::MAX))
            .min(self.max);
        let half = exp / 2;
        let half_ms = u64::try_from(half.as_millis()).unwrap_or(u64::MAX);
        let jitter = if half_ms == 0 {
            0
        } else {
            OsRng.next_u64() % (half_ms + 1)
        };
        half + Duration::from_millis(jitter)
    }
}

/// Parse a `Retry-After` header: delta-seconds or an HTTP-date.
pub fn parse_retry_after(value: &str, now: DateTime<Utc>) -> Option<Duration> {
    let v = value.trim();
    if let Ok(secs) = v.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let when = DateTime::parse_from_rfc2822(v).ok()?.with_timezone(&Utc);
    let delta = when.signed_duration_since(now);
    Some(delta.to_std().unwrap_or(Duration::ZERO))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn backoff_grows_and_is_capped() {
        let b = Backoff {
            base: Duration::from_millis(100),
            max: Duration::from_millis(1000),
        };
        for attempt in 0..10 {
            let d = b.delay(attempt);
            let exp = (100u64 << attempt.min(16)).min(1000);
            assert!(d >= Duration::from_millis(exp / 2), "{attempt}: {d:?}");
            assert!(d <= Duration::from_millis(exp), "{attempt}: {d:?}");
        }
        assert!(b.delay(u32::MAX) <= Duration::from_millis(1000));
    }

    #[test]
    fn retry_after_seconds_and_dates() {
        let now = Utc.with_ymd_and_hms(2015, 10, 21, 7, 27, 0).unwrap();
        assert_eq!(parse_retry_after("120", now), Some(Duration::from_secs(120)));
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now),
            Some(Duration::from_secs(60))
        );
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:00:00 GMT", now),
            Some(Duration::ZERO)
        );
        assert_eq!(parse_retry_after("soon", now), None);
    }
}
