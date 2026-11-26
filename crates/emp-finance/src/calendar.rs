//! Business-day calendars used for recurring due dates and tax deadlines.
//!
//! The authoritative holiday list lives in `emp-store/packs/holidays/us.json`; the app can load it
//! and build a calendar with [`HolidayCalendar::from_dates`]. For standalone use (and tests) this module
//! can also generate the US federal holiday schedule from its statutory rules (5 U.S.C. 6103), including
//! weekend observance shifts, plus DC Emancipation Day for IRS deadlines.

use std::collections::BTreeSet;

use chrono::{Datelike, Duration, NaiveDate, Weekday};

/// A set of non-business dates (weekends are always non-business days).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HolidayCalendar {
    holidays: BTreeSet<NaiveDate>,
}

impl HolidayCalendar {
    /// A calendar with weekends only.
    pub fn weekends_only() -> Self {
        Self::default()
    }

    /// A calendar from an explicit holiday list (e.g. loaded from a holiday pack).
    pub fn from_dates<I: IntoIterator<Item = NaiveDate>>(dates: I) -> Self {
        Self {
            holidays: dates.into_iter().collect(),
        }
    }

    /// US federal holidays (observed dates) for every year in `years`.
    pub fn us_federal(years: std::ops::RangeInclusive<i32>) -> Self {
        let mut set = BTreeSet::new();
        for y in years {
            set.extend(us_federal_holidays(y));
        }
        Self { holidays: set }
    }

    /// US federal holidays plus DC Emancipation Day (April 16, observed), which moves IRS deadlines.
    pub fn us_irs(years: std::ops::RangeInclusive<i32>) -> Self {
        let mut cal = Self::us_federal(years.clone());
        for y in years {
            if let Some(d) = NaiveDate::from_ymd_opt(y, 4, 16) {
                cal.holidays.insert(observed(d));
            }
        }
        cal
    }

    /// Adds a holiday.
    pub fn insert(&mut self, d: NaiveDate) {
        self.holidays.insert(d);
    }

    /// Whether `d` is a holiday in this calendar.
    pub fn is_holiday(&self, d: NaiveDate) -> bool {
        self.holidays.contains(&d)
    }

    /// Whether `d` is a business day (not a weekend, not a holiday).
    pub fn is_business_day(&self, d: NaiveDate) -> bool {
        !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) && !self.is_holiday(d)
    }

    /// `d` if it is a business day, otherwise the next business day.
    pub fn next_business_day_on_or_after(&self, d: NaiveDate) -> NaiveDate {
        let mut x = d;
        // At most a couple of weeks of consecutive non-business days are possible.
        for _ in 0..366 {
            if self.is_business_day(x) {
                return x;
            }
            x += Duration::days(1);
        }
        d
    }
}

fn nth_weekday(year: i32, month: u32, wd: Weekday, n: u32) -> Option<NaiveDate> {
    NaiveDate::from_weekday_of_month_opt(year, month, wd, n as u8)
}

fn last_weekday(year: i32, month: u32, wd: Weekday) -> Option<NaiveDate> {
    nth_weekday(year, month, wd, 5).or_else(|| nth_weekday(year, month, wd, 4))
}

/// Saturday holidays are observed on Friday; Sunday holidays on Monday.
fn observed(d: NaiveDate) -> NaiveDate {
    match d.weekday() {
        Weekday::Sat => d - Duration::days(1),
        Weekday::Sun => d + Duration::days(1),
        _ => d,
    }
}

/// Observed US federal holidays for `year`.
pub fn us_federal_holidays(year: i32) -> Vec<NaiveDate> {
    let fixed = |m: u32, d: u32| NaiveDate::from_ymd_opt(year, m, d).map(observed);
    let mut v: Vec<NaiveDate> = [
        fixed(1, 1),
        nth_weekday(year, 1, Weekday::Mon, 3),
        nth_weekday(year, 2, Weekday::Mon, 3),
        last_weekday(year, 5, Weekday::Mon),
        if year >= 2021 { fixed(6, 19) } else { None },
        fixed(7, 4),
        nth_weekday(year, 9, Weekday::Mon, 1),
        nth_weekday(year, 10, Weekday::Mon, 2),
        fixed(11, 11),
        nth_weekday(year, 11, Weekday::Thu, 4),
        fixed(12, 25),
    ]
    .into_iter()
    .flatten()
    .collect();
    v.sort();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn federal_2026() {
        let h = us_federal_holidays(2026);
        assert!(h.contains(&ymd(2026, 1, 19))); // MLK
        assert!(h.contains(&ymd(2026, 5, 25))); // Memorial Day
        assert!(h.contains(&ymd(2026, 7, 3))); // July 4 is a Saturday → observed Friday
        assert!(h.contains(&ymd(2026, 11, 26))); // Thanksgiving
        assert_eq!(h.len(), 11);
    }

    #[test]
    fn business_day_shift() {
        let cal = HolidayCalendar::us_federal(2026..=2027);
        // Saturday 2026-07-04 → Friday 07-03 is a holiday too → Monday 07-06.
        assert_eq!(
            cal.next_business_day_on_or_after(ymd(2026, 7, 4)),
            ymd(2026, 7, 6)
        );
        assert_eq!(
            cal.next_business_day_on_or_after(ymd(2026, 7, 7)),
            ymd(2026, 7, 7)
        );
        let irs = HolidayCalendar::us_irs(2028..=2028);
        // 2028-04-15 is a Saturday; Monday 17th is a business day (Emancipation Day observed on Monday 17th? 16th is Sunday → 17th)
        assert_eq!(
            irs.next_business_day_on_or_after(ymd(2028, 4, 15)),
            ymd(2028, 4, 18)
        );
    }
}
