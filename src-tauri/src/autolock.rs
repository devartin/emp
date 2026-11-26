//! Auto-lock decisions (SPEC §9.9).
//!
//! [`ActivityTracker`] is a pure state machine fed by the UI's `vault_activity_ping`, window focus events and a
//! periodic ticker. [`ActivityTracker::evaluate`] says whether to lock (and why) or to warn that a lock is coming.
//! The ticker also detects system sleep from gaps between ticks: a suspended process misses ticks, so a tick that
//! arrives much later than scheduled means the machine slept (the "monotonic gap" row of §9.9).

use std::time::{Duration, Instant};

use emp_store::model::AutoLock;
use parking_lot::Mutex;
use serde::Serialize;

/// How often the ticker runs. Shorter than the spec's 10 s upper bound so a resume from sleep locks quickly.
pub const TICK: Duration = Duration::from_secs(2);
/// A tick later than this after the previous one means the process was suspended (sleep).
pub const SLEEP_GAP: Duration = Duration::from_secs(30);
/// `vault:autolock-soon` starts this long before an idle lock.
pub const WARN_WINDOW: Duration = Duration::from_secs(60);
/// `vault:autolock-soon` is re-sent at most this often.
pub const WARN_EVERY: Duration = Duration::from_secs(10);

/// `vault:locked.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockReason {
    /// `vault_lock`, the shortcut, the palette or the top-bar icon.
    Manual,
    /// Idle timeout.
    Idle,
    /// System sleep.
    Sleep,
    /// Screen lock / user switch.
    Screen,
    /// Window unfocused for too long.
    Blur,
    /// Maximum session length reached.
    SessionMax,
    /// A panic outside a `catch_unwind` boundary (D-15).
    Panic,
}

impl LockReason {
    /// Wire string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Idle => "idle",
            Self::Sleep => "sleep",
            Self::Screen => "screen",
            Self::Blur => "blur",
            Self::SessionMax => "session_max",
            Self::Panic => "panic",
        }
    }
}

/// What the ticker should do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing.
    Stay,
    /// Emit `vault:autolock-soon { secondsLeft }`.
    Warn(u64),
    /// Lock now.
    Lock(LockReason),
}

#[derive(Debug)]
struct Inner {
    last_activity: Instant,
    session_started: Option<Instant>,
    unfocused_since: Option<Instant>,
    last_tick: Option<Instant>,
    last_warn: Option<Instant>,
}

/// Activity, focus and session bookkeeping.
#[derive(Debug)]
pub struct ActivityTracker {
    inner: Mutex<Inner>,
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self::new(Instant::now())
    }
}

impl ActivityTracker {
    /// A tracker whose clock starts at `now`.
    #[must_use]
    pub fn new(now: Instant) -> Self {
        Self {
            inner: Mutex::new(Inner {
                last_activity: now,
                session_started: None,
                unfocused_since: None,
                last_tick: None,
                last_warn: None,
            }),
        }
    }

    /// Records user activity (`vault_activity_ping`, and every data command).
    pub fn touch(&self, now: Instant) {
        let mut i = self.inner.lock();
        i.last_activity = now;
        i.last_warn = None;
    }

    /// Records a successful unlock: starts the session clock.
    pub fn session_started(&self, now: Instant) {
        let mut i = self.inner.lock();
        i.session_started = Some(now);
        i.last_activity = now;
        i.last_tick = Some(now);
        i.last_warn = None;
    }

    /// Records a lock.
    pub fn session_ended(&self) {
        let mut i = self.inner.lock();
        i.session_started = None;
        i.last_warn = None;
    }

    /// Records a window focus change.
    pub fn focus_changed(&self, focused: bool, now: Instant) {
        let mut i = self.inner.lock();
        if focused {
            i.unfocused_since = None;
            i.last_activity = now;
        } else if i.unfocused_since.is_none() {
            i.unfocused_since = Some(now);
        }
    }

    /// Idle time so far.
    #[must_use]
    pub fn idle_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.inner.lock().last_activity)
    }

    /// Decides what to do at `now`. `is_tick` marks calls from the periodic ticker (only those detect sleep gaps).
    pub fn evaluate(&self, cfg: &AutoLock, now: Instant, is_tick: bool) -> Decision {
        let mut i = self.inner.lock();
        if i.session_started.is_none() {
            if is_tick {
                i.last_tick = Some(now);
            }
            return Decision::Stay;
        }
        let idle_limit = cfg
            .idle_minutes
            .map(|m| Duration::from_secs(u64::from(m) * 60));
        if is_tick {
            let gap = i
                .last_tick
                .map_or(Duration::ZERO, |t| now.saturating_duration_since(t));
            i.last_tick = Some(now);
            // A gap longer than the idle timeout always locks; a sleep-sized gap locks when on_sleep is set.
            if idle_limit.is_some_and(|l| gap >= l) {
                return Decision::Lock(LockReason::Idle);
            }
            if cfg.on_sleep && gap >= SLEEP_GAP {
                return Decision::Lock(LockReason::Sleep);
            }
        }
        if let (Some(h), Some(start)) = (cfg.max_session_hours, i.session_started) {
            if now.saturating_duration_since(start) >= Duration::from_secs(u64::from(h) * 3600) {
                return Decision::Lock(LockReason::SessionMax);
            }
        }
        if let (Some(m), Some(since)) = (cfg.on_blur_minutes, i.unfocused_since) {
            if now.saturating_duration_since(since) >= Duration::from_secs(u64::from(m) * 60) {
                return Decision::Lock(LockReason::Blur);
            }
        }
        if let Some(limit) = idle_limit {
            let idle = now.saturating_duration_since(i.last_activity);
            if idle >= limit {
                return Decision::Lock(LockReason::Idle);
            }
            let left = limit - idle;
            if left <= WARN_WINDOW
                && i.last_warn
                    .is_none_or(|t| now.saturating_duration_since(t) >= WARN_EVERY)
            {
                i.last_warn = Some(now);
                return Decision::Warn(left.as_secs().max(1));
            }
        }
        Decision::Stay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(idle: Option<u32>) -> AutoLock {
        AutoLock {
            idle_minutes: idle,
            on_sleep: true,
            on_screen_lock: true,
            on_blur_minutes: None,
            max_session_hours: None,
        }
    }

    fn mins(m: u64) -> Duration {
        Duration::from_secs(m * 60)
    }

    /// Ticks every TICK from `from` up to `to`, returning the first non-Stay decision.
    fn tick_until(t: &ActivityTracker, c: &AutoLock, from: Instant, to: Instant) -> Decision {
        let mut now = from;
        while now <= to {
            match t.evaluate(c, now, true) {
                Decision::Stay | Decision::Warn(_) => {}
                d => return d,
            }
            now += TICK;
        }
        Decision::Stay
    }

    #[test]
    fn locked_vault_never_locks() {
        let t0 = Instant::now();
        let t = ActivityTracker::new(t0);
        assert_eq!(
            t.evaluate(&cfg(Some(1)), t0 + mins(10), true),
            Decision::Stay
        );
    }

    #[test]
    fn idle_timeout_locks_and_activity_defers_it() {
        let t0 = Instant::now();
        let t = ActivityTracker::new(t0);
        t.session_started(t0);
        let c = cfg(Some(5));
        assert_eq!(tick_until(&t, &c, t0, t0 + mins(4)), Decision::Stay);
        t.touch(t0 + mins(4));
        assert_eq!(
            tick_until(&t, &c, t0 + mins(4), t0 + mins(8)),
            Decision::Stay
        );
        assert_eq!(
            tick_until(&t, &c, t0 + mins(8), t0 + mins(10)),
            Decision::Lock(LockReason::Idle)
        );
    }

    #[test]
    fn warns_during_the_last_minute() {
        let t0 = Instant::now();
        let t = ActivityTracker::new(t0);
        t.session_started(t0);
        let c = cfg(Some(1));
        assert_eq!(
            t.evaluate(&c, t0 + Duration::from_secs(1), false),
            Decision::Warn(59)
        );
        // Throttled.
        assert_eq!(
            t.evaluate(&c, t0 + Duration::from_secs(3), false),
            Decision::Stay
        );
        assert_eq!(
            t.evaluate(&c, t0 + Duration::from_secs(12), false),
            Decision::Warn(48)
        );
    }

    #[test]
    fn never_means_no_idle_lock() {
        let t0 = Instant::now();
        let t = ActivityTracker::new(t0);
        t.session_started(t0);
        let mut c = cfg(None);
        c.on_sleep = false;
        assert_eq!(tick_until(&t, &c, t0, t0 + mins(90)), Decision::Stay);
    }

    #[test]
    fn sleep_gap_locks() {
        let t0 = Instant::now();
        let t = ActivityTracker::new(t0);
        t.session_started(t0);
        let c = cfg(Some(60));
        assert_eq!(t.evaluate(&c, t0 + TICK, true), Decision::Stay);
        assert_eq!(
            t.evaluate(&c, t0 + TICK + Duration::from_secs(45), true),
            Decision::Lock(LockReason::Sleep)
        );
    }

    #[test]
    fn gap_longer_than_timeout_locks_even_without_on_sleep() {
        let t0 = Instant::now();
        let t = ActivityTracker::new(t0);
        t.session_started(t0);
        let mut c = cfg(Some(1));
        c.on_sleep = false;
        assert_eq!(
            t.evaluate(&c, t0 + mins(2), true),
            Decision::Lock(LockReason::Idle)
        );
    }

    #[test]
    fn blur_and_session_limits() {
        let t0 = Instant::now();
        let t = ActivityTracker::new(t0);
        t.session_started(t0);
        let mut c = cfg(None);
        c.on_sleep = false;
        c.on_blur_minutes = Some(1);
        t.focus_changed(false, t0);
        assert_eq!(
            t.evaluate(&c, t0 + Duration::from_secs(30), false),
            Decision::Stay
        );
        assert_eq!(
            t.evaluate(&c, t0 + mins(1), false),
            Decision::Lock(LockReason::Blur)
        );
        t.focus_changed(true, t0 + mins(1));
        assert_eq!(t.evaluate(&c, t0 + mins(3), false), Decision::Stay);

        c.on_blur_minutes = Some(0);
        t.focus_changed(false, t0 + mins(3));
        assert_eq!(
            t.evaluate(&c, t0 + mins(3), false),
            Decision::Lock(LockReason::Blur)
        );

        let t = ActivityTracker::new(t0);
        t.session_started(t0);
        let mut c = cfg(None);
        c.on_sleep = false;
        c.max_session_hours = Some(1);
        assert_eq!(
            t.evaluate(&c, t0 + mins(61), false),
            Decision::Lock(LockReason::SessionMax)
        );
    }

    #[test]
    fn reasons_serialise_snake_case() {
        assert_eq!(
            serde_json::to_value(LockReason::SessionMax).unwrap(),
            "session_max"
        );
        assert_eq!(LockReason::Panic.as_str(), "panic");
    }
}
