//! Habit streaks and completion rates (SPEC §15.8 "Habits").
//!
//! * [`streak`] walks due days (or weeks for `x_per_week`) backwards from today. Grace modes: `strict` (any miss
//!   breaks), `never_miss_twice` (a single miss is forgiven, two consecutive misses break) and `skip_days`
//!   (frozen days are neutral). Today never breaks a streak while it is still in progress.
//! * [`completion_rate`] is done ÷ expected over a window, where expected comes from the schedule.

use std::collections::BTreeSet;

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

/// When a habit is due.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    /// Every day.
    Daily,
    /// Monday to Friday.
    Weekdays,
    /// `times` completions per (Monday-based) week.
    XPerWeek {
        /// Target per week.
        times: u32,
    },
    /// Every `n` days from `anchor`.
    EveryNDays {
        /// Interval.
        n: u32,
        /// First due day.
        anchor: NaiveDate,
    },
}

/// Grace mode.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Grace {
    /// Any miss breaks the streak.
    Strict,
    /// One miss is forgiven; two consecutive misses break.
    NeverMissTwice,
    /// Frozen days are neutral.
    SkipDays {
        /// Frozen days.
        frozen: BTreeSet<NaiveDate>,
    },
}

/// Streak lengths (in due days, or weeks for `x_per_week`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Streak {
    /// Current streak.
    pub current: u32,
    /// Longest streak in the log.
    pub best: u32,
}

/// Whether `d` is a due day.
#[must_use]
pub fn is_due(schedule: &Schedule, d: NaiveDate) -> bool {
    match schedule {
        Schedule::Daily | Schedule::XPerWeek { .. } => true,
        Schedule::Weekdays => !matches!(d.weekday(), Weekday::Sat | Weekday::Sun),
        Schedule::EveryNDays { n, anchor } => {
            let n = i64::from((*n).max(1));
            let diff = (d - *anchor).num_days();
            diff >= 0 && diff % n == 0
        }
    }
}

fn week_start(d: NaiveDate) -> NaiveDate {
    d - Duration::days(i64::from(d.weekday().num_days_from_monday()))
}

fn frozen_of(g: &Grace) -> Option<&BTreeSet<NaiveDate>> {
    match g {
        Grace::SkipDays { frozen } => Some(frozen),
        _ => None,
    }
}

/// Streaks of a habit. `log` holds the days it was done; `today` is the local date.
#[must_use]
pub fn streak(
    log: &BTreeSet<NaiveDate>,
    schedule: &Schedule,
    grace: &Grace,
    today: NaiveDate,
) -> Streak {
    let Some(first) = log.first().copied() else {
        return Streak::default();
    };
    // Periods (day or week) from the first log entry to today, oldest first: (done, neutral, in_progress).
    let mut periods: Vec<(bool, bool, bool)> = Vec::new();
    match schedule {
        Schedule::XPerWeek { times } => {
            let mut w = week_start(first);
            let cur = week_start(today);
            while w <= cur {
                let n = (0..7)
                    .map(|i| w + Duration::days(i))
                    .filter(|d| log.contains(d))
                    .count();
                let met = u32::try_from(n).unwrap_or(u32::MAX) >= (*times).max(1);
                let frozen = frozen_of(grace)
                    .is_some_and(|f| (0..7).all(|i| f.contains(&(w + Duration::days(i)))));
                periods.push((met, frozen, w == cur));
                w += Duration::days(7);
            }
        }
        _ => {
            let mut d = first;
            while d <= today {
                if is_due(schedule, d) {
                    let frozen = frozen_of(grace).is_some_and(|f| f.contains(&d));
                    periods.push((log.contains(&d), frozen, d == today));
                }
                d += Duration::days(1);
            }
        }
    }
    let forgive = matches!(grace, Grace::NeverMissTwice);
    let mut best = 0u32;
    let mut run = 0u32;
    let mut misses = 0u32;
    for &(done, neutral, in_progress) in &periods {
        if done {
            run += 1;
            misses = 0;
        } else if neutral || in_progress {
            // Neutral: frozen, or today / this week still open.
        } else {
            misses += 1;
            if !forgive || misses >= 2 {
                run = 0;
            }
        }
        best = best.max(run);
    }
    Streak { current: run, best }
}

/// done ÷ expected over `[from, to]` (0 when nothing was expected; capped at 1).
#[must_use]
pub fn completion_rate(
    log: &BTreeSet<NaiveDate>,
    schedule: &Schedule,
    from: NaiveDate,
    to: NaiveDate,
) -> f64 {
    if to < from {
        return 0.0;
    }
    let days = (to - from).num_days() + 1;
    let (expected, done) = match schedule {
        Schedule::XPerWeek { times } => {
            let expected = f64::from(*times) * days as f64 / 7.0;
            let done = log.range(from..=to).count() as f64;
            (expected, done)
        }
        _ => {
            let mut e = 0usize;
            let mut dn = 0usize;
            let mut d = from;
            while d <= to {
                if is_due(schedule, d) {
                    e += 1;
                    if log.contains(&d) {
                        dn += 1;
                    }
                }
                d += Duration::days(1);
            }
            (e as f64, dn as f64)
        }
    };
    if expected <= 0.0 {
        0.0
    } else {
        (done / expected).min(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn log(days: &[&str]) -> BTreeSet<NaiveDate> {
        days.iter().map(|s| d(s)).collect()
    }

    #[test]
    fn grace_modes() {
        // Done 20, 21, (miss 22), 23, 24; today 25 not yet done.
        let l = log(&["2026-11-20", "2026-11-21", "2026-11-23", "2026-11-24"]);
        let today = d("2026-11-25");
        let s = streak(&l, &Schedule::Daily, &Grace::Strict, today);
        assert_eq!(
            s,
            Streak {
                current: 2,
                best: 2
            }
        );
        let s = streak(&l, &Schedule::Daily, &Grace::NeverMissTwice, today);
        assert_eq!(s.current, 4);
        let frozen = log(&["2026-11-22"]);
        let s = streak(&l, &Schedule::Daily, &Grace::SkipDays { frozen }, today);
        assert_eq!(s.current, 4);
        // Two consecutive misses break even with never-miss-twice.
        let l2 = log(&["2026-11-20", "2026-11-23"]);
        assert_eq!(
            streak(
                &l2,
                &Schedule::Daily,
                &Grace::NeverMissTwice,
                d("2026-11-23")
            )
            .current,
            1
        );
    }

    #[test]
    fn schedules_and_rates() {
        // Weekdays: weekend gaps don't break.
        let l = log(&["2026-11-20", "2026-11-23"]); // Fri, Mon
        assert_eq!(
            streak(&l, &Schedule::Weekdays, &Grace::Strict, d("2026-11-23")).current,
            2
        );
        // 3x per week.
        let l = log(&[
            "2026-11-09",
            "2026-11-10",
            "2026-11-12",
            "2026-11-16",
            "2026-11-18",
            "2026-11-19",
            "2026-11-23",
        ]);
        let s = streak(
            &l,
            &Schedule::XPerWeek { times: 3 },
            &Grace::Strict,
            d("2026-11-24"),
        );
        assert_eq!(s.current, 2);
        let every = Schedule::EveryNDays {
            n: 2,
            anchor: d("2026-11-01"),
        };
        assert!(is_due(&every, d("2026-11-03")));
        assert!(!is_due(&every, d("2026-11-04")));
        let l = log(&["2026-11-01", "2026-11-03"]);
        assert!(
            (completion_rate(&l, &every, d("2026-11-01"), d("2026-11-06")) - 2.0 / 3.0).abs()
                < 1e-9
        );
        assert_eq!(
            completion_rate(&l, &Schedule::Daily, d("2026-11-02"), d("2026-11-01")),
            0.0
        );
    }
}
