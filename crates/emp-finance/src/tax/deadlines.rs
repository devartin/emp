//! Tax deadlines with weekend/holiday shifting (§15.6: dates shift past weekends and federal holidays).

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::pack::TaxPack;
use crate::calendar::HolidayCalendar;

/// A resolved deadline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadlineItem {
    /// Name.
    pub name: String,
    /// Effective date (after shifting).
    pub date: NaiveDate,
    /// Statutory date.
    pub statutory: NaiveDate,
    /// `deadline` or `estimated`.
    pub kind: String,
}

/// The IRS business-day calendar for a pack year (federal holidays + DC Emancipation Day).
pub fn irs_calendar(year: i32) -> HolidayCalendar {
    HolidayCalendar::us_irs(year..=year + 2)
}

/// All deadlines of the pack (plus estimated-payment due dates), shifted with `calendar`, sorted by date.
pub fn deadlines(pack: &TaxPack, calendar: &HolidayCalendar) -> Vec<DeadlineItem> {
    let mut v: Vec<DeadlineItem> = pack
        .deadlines
        .iter()
        .map(|d| DeadlineItem {
            name: d.name.clone(),
            date: if d.shift_weekend_holiday {
                calendar.next_business_day_on_or_after(d.date)
            } else {
                d.date
            },
            statutory: d.date,
            kind: "deadline".into(),
        })
        .collect();
    if let Some(est) = &pack.estimated {
        for p in &est.periods {
            v.push(DeadlineItem {
                name: format!("{} estimated payment", p.id),
                date: calendar.next_business_day_on_or_after(p.due),
                statutory: p.due,
                kind: "estimated".into(),
            });
        }
    }
    v.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.name.cmp(&b.name)));
    v
}

/// The next deadline on or after `today`.
pub fn next_deadline(items: &[DeadlineItem], today: NaiveDate) -> Option<&DeadlineItem> {
    items.iter().find(|d| d.date >= today)
}

/// Deadlines due within `days` of `today` (inclusive), for the `deadline-14` / `deadline-3` rules.
pub fn due_within(items: &[DeadlineItem], today: NaiveDate, days: i64) -> Vec<&DeadlineItem> {
    items
        .iter()
        .filter(|d| d.date >= today && (d.date - today).num_days() <= days)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tax::pack::builtin;

    #[test]
    fn us_2026_dates() {
        let us = builtin("us-federal-2026").unwrap();
        let items = deadlines(&us, &irs_calendar(2026));
        let find = |n: &str| items.iter().find(|d| d.name == n).unwrap().date.to_string();
        // 2027-01-31 is a Sunday → Monday Feb 1; 2027-02-15 is Presidents Day → Feb 16.
        assert_eq!(find("Employers furnish Form W-2"), "2027-02-01");
        assert_eq!(find("Brokers furnish Form 1099-B"), "2027-02-16");
        assert_eq!(find("Federal return due"), "2027-04-15");
        assert_eq!(find("Q1 estimated payment"), "2026-04-15");
        assert_eq!(find("Q4 estimated payment"), "2027-01-15");
        let today = "2026-11-26".parse().unwrap();
        assert_eq!(
            next_deadline(&items, today).unwrap().name,
            "Q4 estimated payment"
        );
        assert!(due_within(&items, today, 14).is_empty());
        assert_eq!(
            due_within(&items, "2027-01-02".parse().unwrap(), 14).len(),
            1
        );
    }
}
