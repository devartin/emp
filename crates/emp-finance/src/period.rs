//! Date helpers: year-months, month arithmetic and budget periods (§15.3 month boundaries).

use std::fmt;
use std::str::FromStr;

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{FinanceError, Result};

/// A calendar month, serialised as `"YYYY-MM"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct YearMonth {
    /// Year (1000..=9999).
    pub year: i32,
    /// Month 1..=12.
    pub month: u32,
}

impl YearMonth {
    /// Creates a validated year-month.
    pub fn new(year: i32, month: u32) -> Result<Self> {
        if !(1000..=9999).contains(&year) || !(1..=12).contains(&month) {
            return Err(FinanceError::invalid(format!(
                "invalid month {year}-{month}"
            )));
        }
        Ok(Self { year, month })
    }

    /// The month containing `d`.
    pub fn of(d: NaiveDate) -> Self {
        Self {
            year: d.year(),
            month: d.month(),
        }
    }

    /// Adds `n` months (may be negative).
    pub fn plus_months(self, n: i32) -> Self {
        let idx = self.year * 12 + self.month as i32 - 1 + n;
        Self {
            year: idx.div_euclid(12),
            month: (idx.rem_euclid(12) + 1) as u32,
        }
    }

    /// The following month.
    pub fn next(self) -> Self {
        self.plus_months(1)
    }

    /// The previous month.
    pub fn prev(self) -> Self {
        self.plus_months(-1)
    }

    /// Whole months from `self` to `other` (`other − self`).
    pub fn months_until(self, other: YearMonth) -> i32 {
        (other.year * 12 + other.month as i32) - (self.year * 12 + self.month as i32)
    }

    /// First calendar day of the month.
    pub fn first_day(self) -> NaiveDate {
        NaiveDate::from_ymd_opt(self.year, self.month, 1).unwrap_or(NaiveDate::MIN)
    }

    /// Last calendar day of the month.
    pub fn last_day(self) -> NaiveDate {
        self.next().first_day() - Duration::days(1)
    }

    /// Day `day` of the month, clamped to the month length.
    pub fn day_clamped(self, day: u32) -> NaiveDate {
        let last = self.last_day().day();
        NaiveDate::from_ymd_opt(self.year, self.month, day.clamp(1, last))
            .unwrap_or(self.first_day())
    }
}

impl fmt::Display for YearMonth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}

impl FromStr for YearMonth {
    type Err = FinanceError;
    fn from_str(s: &str) -> Result<Self> {
        let t = s.trim();
        let (y, m) = t
            .split_once('-')
            .ok_or_else(|| FinanceError::invalid(format!("invalid month {s:?}")))?;
        let year = y
            .parse()
            .map_err(|_| FinanceError::invalid(format!("invalid month {s:?}")))?;
        let month = m
            .parse()
            .map_err(|_| FinanceError::invalid(format!("invalid month {s:?}")))?;
        if y.len() != 4 || m.len() != 2 {
            return Err(FinanceError::invalid(format!("invalid month {s:?}")));
        }
        YearMonth::new(year, month)
    }
}

impl Serialize for YearMonth {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for YearMonth {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// Parses an ISO `YYYY-MM-DD` date (IPC format).
pub fn parse_iso_date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|_| FinanceError::invalid(format!("invalid date {s:?}")))
}

/// Adds `n` months to `d`, clamping the day to the target month's length (Jan 31 + 1 month = Feb 28/29).
pub fn add_months(d: NaiveDate, n: i32) -> NaiveDate {
    YearMonth::of(d).plus_months(n).day_clamped(d.day())
}

/// Adds `n` months to a schedule anchored on `anchor_day` (keeps the 31st sticky across short months).
pub fn add_months_anchored(d: NaiveDate, n: i32, anchor_day: u32) -> NaiveDate {
    YearMonth::of(d).plus_months(n).day_clamped(anchor_day)
}

/// An inclusive date range for a budget month.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    /// First day (inclusive).
    pub start: NaiveDate,
    /// Last day (inclusive).
    pub end: NaiveDate,
}

impl Period {
    /// Whether `d` falls inside the period.
    pub fn contains(&self, d: NaiveDate) -> bool {
        d >= self.start && d <= self.end
    }

    /// Number of days in the period.
    pub fn days(&self) -> i64 {
        (self.end - self.start).num_days() + 1
    }

    /// 1-based day index of `d` within the period, clamped to `[0, days]`.
    pub fn day_of(&self, d: NaiveDate) -> i64 {
        ((d - self.start).num_days() + 1).clamp(0, self.days())
    }
}

/// The budget period for `month` when months start on `start_day` (1–28): from day `start_day` of
/// `month` to the day before day `start_day` of the next month.
pub fn budget_period(month: YearMonth, start_day: u8) -> Period {
    let sd = u32::from(start_day.clamp(1, 28));
    let start = month.day_clamped(sd);
    let end = month.next().day_clamped(sd) - Duration::days(1);
    Period { start, end }
}

/// The budget month whose period contains `d`.
pub fn budget_month_of(d: NaiveDate, start_day: u8) -> YearMonth {
    let sd = u32::from(start_day.clamp(1, 28));
    let ym = YearMonth::of(d);
    if d.day() >= sd { ym } else { ym.prev() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn year_month_arith() {
        let m: YearMonth = "2026-01".parse().unwrap();
        assert_eq!(m.plus_months(-1).to_string(), "2025-12");
        assert_eq!(m.plus_months(13).to_string(), "2027-02");
        assert_eq!(m.months_until("2026-12".parse().unwrap()), 11);
        assert_eq!(
            YearMonth::new(2024, 2).unwrap().last_day(),
            ymd(2024, 2, 29)
        );
        assert!("2026-13".parse::<YearMonth>().is_err());
        assert!("26-01".parse::<YearMonth>().is_err());
    }

    #[test]
    fn month_add_clamps() {
        assert_eq!(add_months(ymd(2026, 1, 31), 1), ymd(2026, 2, 28));
        assert_eq!(
            add_months_anchored(ymd(2026, 2, 28), 1, 31),
            ymd(2026, 3, 31)
        );
    }

    #[test]
    fn budget_periods() {
        let m = YearMonth::new(2026, 3).unwrap();
        let p = budget_period(m, 1);
        assert_eq!((p.start, p.end), (ymd(2026, 3, 1), ymd(2026, 3, 31)));
        let p = budget_period(m, 15);
        assert_eq!((p.start, p.end), (ymd(2026, 3, 15), ymd(2026, 4, 14)));
        assert_eq!(p.days(), 31);
        assert_eq!(budget_month_of(ymd(2026, 4, 14), 15), m);
        assert_eq!(budget_month_of(ymd(2026, 4, 15), 15), m.next());
        assert_eq!(p.day_of(ymd(2026, 3, 15)), 1);
    }
}
