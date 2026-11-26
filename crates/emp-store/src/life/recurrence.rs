//! Recurrence rules (SPEC §15.8): RFC 5545 `RRULE`s through the `rrule` crate with `chrono-tz` zones.
//!
//! * [`Rule::parse`] validates a rule (`FREQ=WEEKLY;BYDAY=MO` with or without the `RRULE:` prefix) with its
//!   `dtstart` (`YYYY-MM-DD` for all-day rules, RFC 3339 / naive local date-times otherwise) and IANA zone.
//! * [`next_after`] gives the next occurrence. In [`RecurrenceMode::Completion`] the rule is re-anchored at the
//!   completion time ("every 2 weeks after I finish").
//! * [`Rule::between`] expands occurrences in a window (capped at 5,000 and a 10-year horizon, §9.16).
//! * Business-day helpers move dates off weekends and holidays (`BYSETPOS=-1` "last business day").

use std::collections::BTreeSet;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday};
use chrono_tz::Tz;
use rrule::RRuleSet;

use crate::query::model::RecurrenceMode;

/// Maximum occurrences returned by one expansion.
pub const MAX_INSTANCES: usize = 5_000;
/// Expansion horizon in days (10 years).
pub const MAX_HORIZON_DAYS: i64 = 3_660;

/// A parsed recurrence rule.
#[derive(Clone, Debug)]
pub struct Rule {
    rule: String,
    start: NaiveDateTime,
    all_day: bool,
    tz: Tz,
}

fn parse_start(s: &str, tz: Tz) -> Result<(NaiveDateTime, bool), String> {
    let s = s.trim();
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok((d.and_hms_opt(0, 0, 0).unwrap_or_default(), true));
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok((dt.with_timezone(&tz).naive_local(), false));
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Ok((dt, false));
        }
    }
    Err("dtstart must be YYYY-MM-DD or an RFC 3339 date-time".into())
}

impl Rule {
    /// Parses and validates a rule.
    pub fn parse(rrule: &str, dtstart: &str, tz: Option<&str>) -> Result<Self, String> {
        let body = rrule.trim();
        let body = body
            .strip_prefix("RRULE:")
            .or_else(|| body.strip_prefix("rrule:"))
            .unwrap_or(body)
            .trim();
        if body.is_empty()
            || body.len() > 512
            || body.contains(['\n', '\r'])
            || body.to_ascii_uppercase().contains("DTSTART")
        {
            return Err("invalid rule".into());
        }
        let tz: Tz = match tz {
            Some(z) if !z.is_empty() => z.parse().map_err(|_| "unknown time zone".to_owned())?,
            _ => Tz::UTC,
        };
        let (start, all_day) = parse_start(dtstart, tz)?;
        let r = Self {
            rule: body.to_owned(),
            start,
            all_day,
            tz,
        };
        r.set(start)?;
        Ok(r)
    }

    /// Whether the rule is all-day.
    #[must_use]
    pub fn all_day(&self) -> bool {
        self.all_day
    }

    /// The rule text (without `RRULE:`).
    #[must_use]
    pub fn text(&self) -> &str {
        &self.rule
    }

    fn set(&self, start: NaiveDateTime) -> Result<RRuleSet, String> {
        let stamp = start.format("%Y%m%dT%H%M%S");
        let src = if self.tz == Tz::UTC {
            format!("DTSTART:{stamp}Z\nRRULE:{}", self.rule)
        } else {
            format!(
                "DTSTART;TZID={}:{stamp}\nRRULE:{}",
                self.tz.name(),
                self.rule
            )
        };
        src.parse::<RRuleSet>().map_err(|e| e.to_string())
    }

    fn to_rr(&self, local: NaiveDateTime) -> Option<DateTime<rrule::Tz>> {
        let rtz: rrule::Tz = self.tz.into();
        rtz.from_local_datetime(&local).earliest()
    }

    /// Occurrences (local wall-clock times) in `[from, to]`, capped at 5,000 and 10 years.
    #[must_use]
    pub fn between(&self, from: NaiveDateTime, to: NaiveDateTime) -> Vec<NaiveDateTime> {
        let to = to.min(from + Duration::days(MAX_HORIZON_DAYS));
        let (Some(a), Some(b), Ok(set)) = (self.to_rr(from), self.to_rr(to), self.set(self.start))
        else {
            return Vec::new();
        };
        set.after(a)
            .before(b)
            .all(u16::try_from(MAX_INSTANCES).unwrap_or(u16::MAX))
            .dates
            .into_iter()
            .map(|d| d.naive_local())
            .filter(|d| *d >= from && *d <= to)
            .collect()
    }

    /// The first occurrence strictly after `after` (local time), anchored at `anchor` (the rule's own start
    /// unless re-anchored).
    fn first_after(&self, anchor: NaiveDateTime, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let set = self.set(anchor).ok()?;
        let a = self.to_rr(after)?;
        let b = self.to_rr(after + Duration::days(MAX_HORIZON_DAYS))?;
        set.after(a)
            .before(b)
            .all(8)
            .dates
            .into_iter()
            .map(|d| d.naive_local())
            .find(|d| *d > after)
    }
}

/// The next occurrence after `after` (local wall-clock time). In completion mode the rule restarts at `after`
/// (the completion time, keeping the rule's time of day for timed rules).
#[must_use]
pub fn next_after(
    rule: &Rule,
    after: NaiveDateTime,
    mode: RecurrenceMode,
) -> Option<NaiveDateTime> {
    match mode {
        RecurrenceMode::Schedule => rule.first_after(rule.start, after),
        RecurrenceMode::Completion => {
            let anchor = if rule.all_day {
                after.date().and_hms_opt(0, 0, 0)?
            } else {
                after.date().and_time(rule.start.time())
            };
            let after = if rule.all_day {
                anchor
            } else {
                after.max(anchor)
            };
            rule.first_after(anchor, after)
        }
    }
}

/// Convenience: the next occurrence after a unix-ms instant, as unix ms.
#[must_use]
pub fn next_after_ms(rule: &Rule, after_ms: i64, mode: RecurrenceMode) -> Option<i64> {
    let after = DateTime::<Utc>::from_timestamp_millis(after_ms)?
        .with_timezone(&rule.tz)
        .naive_local();
    let next = next_after(rule, after, mode)?;
    rule.tz
        .from_local_datetime(&next)
        .earliest()
        .map(|d| d.timestamp_millis())
}

/// `true` for Saturday / Sunday or a listed holiday.
#[must_use]
pub fn is_non_business(d: NaiveDate, holidays: &BTreeSet<NaiveDate>) -> bool {
    matches!(d.weekday(), Weekday::Sat | Weekday::Sun) || holidays.contains(&d)
}

/// Moves a date to the nearest business day (backward or forward).
#[must_use]
pub fn adjust_business_day(
    mut d: NaiveDate,
    holidays: &BTreeSet<NaiveDate>,
    backward: bool,
) -> NaiveDate {
    for _ in 0..30 {
        if !is_non_business(d, holidays) {
            break;
        }
        d = if backward {
            d - Duration::days(1)
        } else {
            d + Duration::days(1)
        };
    }
    d
}

/// The last business day of a month (`FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1` minus holidays).
#[must_use]
pub fn last_business_day(
    year: i32,
    month: u32,
    holidays: &BTreeSet<NaiveDate>,
) -> Option<NaiveDate> {
    let first_next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)?
    };
    Some(adjust_business_day(
        first_next - Duration::days(1),
        holidays,
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").unwrap()
    }

    #[test]
    fn schedule_and_completion_modes() {
        let r = Rule::parse("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-11-02", None).unwrap();
        assert!(r.all_day());
        let n = next_after(&r, dt("2026-11-03T10:00"), RecurrenceMode::Schedule).unwrap();
        assert_eq!(n.date().to_string(), "2026-11-16");
        let r = Rule::parse("FREQ=DAILY;INTERVAL=3", "2026-11-01", None).unwrap();
        // Completed late on the 10th → next is the 13th (from completion), not the 13th of the schedule by chance.
        let c = next_after(&r, dt("2026-11-11T18:00"), RecurrenceMode::Completion).unwrap();
        assert_eq!(c.date().to_string(), "2026-11-14");
        let s = next_after(&r, dt("2026-11-11T18:00"), RecurrenceMode::Schedule).unwrap();
        assert_eq!(s.date().to_string(), "2026-11-13");
    }

    #[test]
    fn timezones_and_expansion() {
        let r = Rule::parse("FREQ=DAILY", "2026-03-28T09:00:00", Some("Europe/Berlin")).unwrap();
        let v = r.between(dt("2026-03-28T00:00"), dt("2026-03-31T00:00"));
        assert_eq!(v.len(), 3);
        // 09:00 local on both sides of the DST change.
        assert!(v.iter().all(|d| d.format("%H:%M").to_string() == "09:00"));
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis();
        // 07:00Z = 08:00 CET → next is 09:00 CET = 08:00Z; after that 09:00 CEST = 07:00Z on the 29th.
        assert_eq!(
            next_after_ms(&r, at("2026-03-28T07:00:00Z"), RecurrenceMode::Schedule),
            Some(at("2026-03-28T08:00:00Z"))
        );
        assert_eq!(
            next_after_ms(&r, at("2026-03-28T08:00:00Z"), RecurrenceMode::Schedule),
            Some(at("2026-03-29T07:00:00Z"))
        );
        let big = Rule::parse("FREQ=MINUTELY", "2026-01-01T00:00:00", None).unwrap();
        assert_eq!(
            big.between(dt("2026-01-01T00:00"), dt("2027-01-01T00:00"))
                .len(),
            MAX_INSTANCES
        );
        assert!(Rule::parse("FREQ=SOMETIMES", "2026-01-01", None).is_err());
        assert!(Rule::parse("FREQ=DAILY\nDTSTART:2020", "2026-01-01", None).is_err());
        assert!(Rule::parse("FREQ=DAILY", "2026-01-01", Some("Mars/Base")).is_err());
    }

    #[test]
    fn business_days() {
        let mut h = BTreeSet::new();
        h.insert(NaiveDate::from_ymd_opt(2026, 7, 31).unwrap());
        // July 31 2026 is a Friday and a holiday → Thursday 30.
        assert_eq!(
            last_business_day(2026, 7, &h).unwrap().to_string(),
            "2026-07-30"
        );
        // Feb 2026 ends on a Saturday → Friday 27.
        assert_eq!(
            last_business_day(2026, 2, &BTreeSet::new())
                .unwrap()
                .to_string(),
            "2026-02-27"
        );
    }
}
