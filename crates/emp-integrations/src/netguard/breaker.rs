//! Per-connector circuit breaker and health (SPEC §9.18: 5 failures → open for 5 minutes).

use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

/// Connector health for `ProviderInfo.health` (the amber dot).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    /// Last request succeeded.
    Ok,
    /// Recent failures, breaker still closed.
    Degraded,
    /// Breaker open.
    Down,
    /// Never used.
    Unknown,
}

/// A consecutive-failure circuit breaker. Time is passed in explicitly for testability.
#[derive(Debug, Clone)]
pub struct CircuitBreaker {
    threshold: u32,
    open_for: Duration,
    consecutive_failures: u32,
    open_until: Option<Instant>,
    used: bool,
}

impl CircuitBreaker {
    /// A breaker opening after `threshold` consecutive failures for `open_for`.
    pub fn new(threshold: u32, open_for: Duration) -> Self {
        CircuitBreaker {
            threshold: threshold.max(1),
            open_for,
            consecutive_failures: 0,
            open_until: None,
            used: false,
        }
    }

    /// `Err(remaining)` while open. Once the open period elapses the breaker is half-open:
    /// one request is let through; a failure re-opens it immediately.
    pub fn check(&mut self, now: Instant) -> Result<(), Duration> {
        match self.open_until {
            Some(until) if now < until => Err(until - now),
            Some(_) => {
                self.open_until = None;
                // Half-open: one more failure re-opens.
                self.consecutive_failures = self.threshold.saturating_sub(1);
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Record a successful request.
    pub fn record_success(&mut self) {
        self.used = true;
        self.consecutive_failures = 0;
        self.open_until = None;
    }

    /// Record a failed request; opens the breaker at the threshold.
    pub fn record_failure(&mut self, now: Instant) {
        self.used = true;
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= self.threshold {
            self.open_until = Some(now + self.open_for);
        }
    }

    /// Current health.
    pub fn health(&self, now: Instant) -> Health {
        match self.open_until {
            Some(until) if now < until => Health::Down,
            _ if !self.used => Health::Unknown,
            _ if self.consecutive_failures > 0 => Health::Degraded,
            _ => Health::Ok,
        }
    }

    /// Reset to the initial state (e.g. after the user re-configures a provider).
    pub fn reset(&mut self) {
        *self = CircuitBreaker::new(self.threshold, self.open_for);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_after_threshold_and_recovers() {
        let t0 = Instant::now();
        let mut b = CircuitBreaker::new(5, Duration::from_secs(300));
        assert_eq!(b.health(t0), Health::Unknown);
        for _ in 0..4 {
            b.record_failure(t0);
            assert!(b.check(t0).is_ok());
        }
        assert_eq!(b.health(t0), Health::Degraded);
        b.record_failure(t0);
        let remaining = b.check(t0 + Duration::from_secs(10)).unwrap_err();
        assert_eq!(remaining, Duration::from_secs(290));
        assert_eq!(b.health(t0), Health::Down);

        // After 5 minutes: half-open, one failure re-opens.
        let t1 = t0 + Duration::from_secs(301);
        assert!(b.check(t1).is_ok());
        b.record_failure(t1);
        assert!(b.check(t1).is_err());

        // A success closes it.
        let t2 = t1 + Duration::from_secs(301);
        assert!(b.check(t2).is_ok());
        b.record_success();
        assert_eq!(b.health(t2), Health::Ok);
        b.record_failure(t2);
        assert!(b.check(t2).is_ok());
    }
}
