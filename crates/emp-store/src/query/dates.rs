//! Date handling for filters, grouping and charts: relative ranges (`within`), buckets and the vault's local
//! time zone and week start (SPEC §8.4 "Relative dates are evaluated at query time using the vault locale,
//! timezone and week start").

use chrono::{DateTime, Datelike, Duration, Months, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::Value;

use super::model::{DateBucket, DateValue};

/// Clock and calendar settings of one query.
#[derive(Clone, Copy, Debug)]
pub struct DateCtx {
    /// Now (unix ms).
    pub now_ms: i64,
    /// Vault time zone.
    pub tz: Tz,
    /// First day of the week: 0 Sunday, 1 Monday, 6 Saturday.
    pub week_start: u8,
}

impl DateCtx {
    /// A context in UTC with Monday weeks.
    #[must_use]
    pub fn utc(now_ms: i64) -> Self {
        Self {
            now_ms,
            tz: Tz::UTC,
            week_start: 1,
        }
    }

    /// A context from vault settings (unknown zones fall back to UTC).
    #[must_use]
    pub fn new(now_ms: i64, tz: &str, week_start: u8) -> Self {
        Self {
            now_ms,
            tz: tz.parse().unwrap_or(Tz::UTC),
            week_start,
        }
    }

    /// Local wall-clock time of a unix-ms timestamp.
    #[must_use]
    pub fn local(&self, ms: i64) -> NaiveDateTime {
        DateTime::<Utc>::from_timestamp_millis(ms)
            .unwrap_or_default()
            .with_timezone(&self.tz)
            .naive_local()
    }

    /// Local now.
    #[must_use]
    pub fn now(&self) -> NaiveDateTime {
        self.local(self.now_ms)
    }

    /// Local today.
    #[must_use]
    pub fn today(&self) -> NaiveDate {
        self.now().date()
    }

    /// Unix ms of a local wall-clock time (earliest mapping across DST changes).
    #[must_use]
    pub fn to_ms(&self, local: NaiveDateTime) -> i64 {
        self.tz
            .from_local_datetime(&local)
            .earliest()
            .map_or_else(|| local.and_utc().timestamp_millis(), |d| d.timestamp_millis())
    }

    /// Parses `YYYY-MM-DD` or RFC 3339 (converted to local time).
    #[must_use]
    pub fn parse(&self, s: &str) -> Option<NaiveDateTime> {
        let s = s.trim();
        if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            return d.and_hms_opt(0, 0, 0);
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&self.tz).naive_local());
        }
        for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
            if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
                return Some(dt);
            }
        }
        None
    }

    /// Local start (and end) of a date cell.
    #[must_use]
    pub fn range_of(&self, d: &DateValue) -> Option<(NaiveDateTime, Option<NaiveDateTime>)> {
        let start = self.parse(&d.start)?;
        let end = d.end.as_deref().and_then(|e| self.parse(e));
        Some((start, end))
    }

    /// Start of the week containing `d`.
    #[must_use]
    pub fn week_start_of(&self, d: NaiveDate) -> NaiveDate {
        let ws = u32::from(self.week_start % 7);
        let dow = d.weekday().num_days_from_sunday();
        let back = (dow + 7 - ws) % 7;
        d - Duration::days(i64::from(back))
    }

    /// Resolves a `within` operand to an inclusive local date range.
    #[must_use]
    pub fn within(&self, v: &Value) -> Option<(NaiveDate, NaiveDate)> {
        let t = self.today();
        if let Some(o) = v.as_object() {
            if let Some(n) = o.get("past_days").and_then(Value::as_i64) {
                return Some((t - Duration::days(n.clamp(0, 36_600)), t));
            }
            if let Some(n) = o.get("next_days").and_then(Value::as_i64) {
                return Some((t, t + Duration::days(n.clamp(0, 36_600))));
            }
            return None;
        }
        let ws = self.week_start_of(t);
        let month_start = t.with_day(1)?;
        let next_month = month_start.checked_add_months(Months::new(1))?;
        let year_start = NaiveDate::from_ymd_opt(t.year(), 1, 1)?;
        Some(match v.as_str()? {
            "today" => (t, t),
            "tomorrow" => (t + Duration::days(1), t + Duration::days(1)),
            "yesterday" => (t - Duration::days(1), t - Duration::days(1)),
            "this_week" => (ws, ws + Duration::days(6)),
            "past_week" => (t - Duration::days(7), t),
            "next_week" => (t, t + Duration::days(7)),
            "this_month" => (month_start, next_month - Duration::days(1)),
            "past_month" => (t.checked_sub_months(Months::new(1))?, t),
            "next_month" => (t, t.checked_add_months(Months::new(1))?),
            "this_quarter" => {
                let q0 = (t.month0() / 3) * 3 + 1;
                let qs = NaiveDate::from_ymd_opt(t.year(), q0, 1)?;
                (qs, qs.checked_add_months(Months::new(3))? - Duration::days(1))
            }
            "this_year" => (
                year_start,
                NaiveDate::from_ymd_opt(t.year(), 12, 31)?,
            ),
            "past_year" => (t.checked_sub_months(Months::new(12))?, t),
            "next_year" => (t, t.checked_add_months(Months::new(12))?),
            _ => return None,
        })
    }

    /// Bucket key and label of a local date. Keys sort chronologically as strings (except `relative`, whose
    /// keys carry a numeric prefix).
    #[must_use]
    pub fn bucket(&self, d: NaiveDate, bucket: DateBucket) -> (String, String) {
        match bucket {
            DateBucket::Day => (d.format("%Y-%m-%d").to_string(), d.format("%b %-d, %Y").to_string()),
            DateBucket::Week => {
                let s = self.week_start_of(d);
                (
                    s.format("%Y-%m-%d").to_string(),
                    format!("Week of {}", s.format("%b %-d, %Y")),
                )
            }
            DateBucket::Month => (d.format("%Y-%m").to_string(), d.format("%B %Y").to_string()),
            DateBucket::Quarter => {
                let q = d.month0() / 3 + 1;
                (format!("{}-Q{q}", d.year()), format!("Q{q} {}", d.year()))
            }
            DateBucket::Year => (d.year().to_string(), d.year().to_string()),
            DateBucket::Relative => {
                let t = self.today();
                let diff = (d - t).num_days();
                let (k, l) = match diff {
                    0 => ("3_today", "Today"),
                    1 => ("4_tomorrow", "Tomorrow"),
                    -1 => ("2_yesterday", "Yesterday"),
                    2..=7 => ("5_next_7", "Next 7 days"),
                    -7..=-2 => ("1_past_7", "Last 7 days"),
                    8..=30 => ("6_next_30", "Next 30 days"),
                    -30..=-8 => ("0_past_30", "Last 30 days"),
                    d if d > 30 => ("7_later", "Later"),
                    _ => ("00_earlier", "Earlier"),
                };
                (k.to_owned(), l.to_owned())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> DateCtx {
        // 2026-11-26 (Thursday) 12:00 UTC.
        DateCtx::new(1_795_694_400_000, "UTC", 1)
    }

    #[test]
    fn relative_ranges() {
        let c = ctx();
        assert_eq!(c.today().to_string(), "2026-11-26");
        let (a, b) = c.within(&json!("this_week")).unwrap();
        assert_eq!((a.to_string(), b.to_string()), ("2026-11-23".into(), "2026-11-29".into()));
        let (a, b) = c.within(&json!("this_month")).unwrap();
        assert_eq!((a.to_string(), b.to_string()), ("2026-11-01".into(), "2026-11-30".into()));
        let (a, b) = c.within(&json!({"past_days": 3})).unwrap();
        assert_eq!((a.to_string(), b.to_string()), ("2026-11-23".into(), "2026-11-26".into()));
        let (a, _) = c.within(&json!("this_quarter")).unwrap();
        assert_eq!(a.to_string(), "2026-10-01");
        assert!(c.within(&json!("bogus")).is_none());
        let sunday = DateCtx::new(c.now_ms, "UTC", 0);
        assert_eq!(sunday.within(&json!("this_week")).unwrap().0.to_string(), "2026-11-22");
    }

    #[test]
    fn timezones_shift_local_dates() {
        let tokyo = DateCtx::new(1_795_730_400_000, "Asia/Tokyo", 1); // 22:00 UTC → next day in Tokyo
        assert_eq!(tokyo.today().to_string(), "2026-11-27");
        let dt = tokyo.parse("2026-11-26T23:30:00Z").unwrap();
        assert_eq!(dt.date().to_string(), "2026-11-27");
    }

    #[test]
    fn buckets() {
        let c = ctx();
        let d = NaiveDate::from_ymd_opt(2026, 11, 25).unwrap();
        assert_eq!(c.bucket(d, DateBucket::Month).0, "2026-11");
        assert_eq!(c.bucket(d, DateBucket::Week).0, "2026-11-23");
        assert_eq!(c.bucket(d, DateBucket::Quarter).0, "2026-Q4");
        assert_eq!(c.bucket(d, DateBucket::Relative).1, "Yesterday");
    }
}
