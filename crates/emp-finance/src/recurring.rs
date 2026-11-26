//! Recurring-transaction and subscription detection (§15.4).

use std::collections::BTreeMap;

use chrono::{Duration, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::calendar::HolidayCalendar;
use crate::money::{median, to_f64};
use crate::payee::payee_key;
use crate::period::add_months_anchored;

/// A detected cadence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cadence {
    /// Every 7 days (±1).
    Weekly,
    /// Every 14 days (±2).
    Biweekly,
    /// Every 30.44 days (±3).
    Monthly,
    /// Every 91.31 days (±7).
    Quarterly,
    /// Every 365.25 days (±10).
    Yearly,
}

impl Cadence {
    /// All cadences in table order.
    pub const ALL: [Cadence; 5] = [
        Cadence::Weekly,
        Cadence::Biweekly,
        Cadence::Monthly,
        Cadence::Quarterly,
        Cadence::Yearly,
    ];

    /// Nominal interval in days.
    pub fn days(self) -> f64 {
        match self {
            Cadence::Weekly => 7.0,
            Cadence::Biweekly => 14.0,
            Cadence::Monthly => 30.44,
            Cadence::Quarterly => 91.31,
            Cadence::Yearly => 365.25,
        }
    }

    /// Tolerance in days.
    pub fn tolerance(self) -> f64 {
        match self {
            Cadence::Weekly => 1.0,
            Cadence::Biweekly => 2.0,
            Cadence::Monthly => 3.0,
            Cadence::Quarterly => 7.0,
            Cadence::Yearly => 10.0,
        }
    }

    /// Occurrences per year.
    pub fn per_year(self) -> Decimal {
        Decimal::from(match self {
            Cadence::Weekly => 52,
            Cadence::Biweekly => 26,
            Cadence::Monthly => 12,
            Cadence::Quarterly => 4,
            Cadence::Yearly => 1,
        })
    }

    /// Advances `d` by one period: days for weekly cadences, calendar months (anchored on `anchor_day`) otherwise.
    pub fn advance(self, d: NaiveDate, anchor_day: u32) -> NaiveDate {
        match self {
            Cadence::Weekly => d + Duration::days(7),
            Cadence::Biweekly => d + Duration::days(14),
            Cadence::Monthly => add_months_anchored(d, 1, anchor_day),
            Cadence::Quarterly => add_months_anchored(d, 3, anchor_day),
            Cadence::Yearly => add_months_anchored(d, 12, anchor_day),
        }
    }

    /// Minimum occurrences needed (2 for yearly, otherwise 3).
    pub fn min_occurrences(self) -> usize {
        if self == Cadence::Yearly { 2 } else { 3 }
    }
}

/// Annual cost of a recurring amount.
pub fn annual_cost(amount: Decimal, cadence: Cadence) -> Decimal {
    amount * cadence.per_year()
}

/// A transaction considered for detection.
#[derive(Debug, Clone, PartialEq)]
pub struct RecurringTxn {
    /// Row id.
    pub id: String,
    /// Date.
    pub date: NaiveDate,
    /// Signed amount.
    pub amount: Decimal,
    /// Normalised payee.
    pub payee: String,
}

/// Kind suggestion for `finance_recurring_accept`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecurringKind {
    /// A bill (rent, utilities, insurance, loans).
    Bill,
    /// A subscription service.
    Subscription,
    /// Recurring income.
    Income,
}

/// A price change between the previous typical amount and the latest charge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceChange {
    /// Median of the previous 3 amounts.
    pub from: Decimal,
    /// Latest amount.
    pub to: Decimal,
}

/// A detected recurring series (IPC `finance_recurring_detect` row plus diagnostics).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringCandidate {
    /// Display payee (first spelling seen).
    pub payee: String,
    /// Cadence.
    pub cadence: Cadence,
    /// Typical (median) signed amount.
    pub amount: Decimal,
    /// Most recent amount.
    pub latest_amount: Decimal,
    /// Amount coefficient of variation ≥ 0.10.
    pub variable: bool,
    /// Last occurrence.
    pub last_date: NaiveDate,
    /// Next due date, shifted to a business day.
    pub next_due: NaiveDate,
    /// `0.5·interval_fit + 0.3·amount_fit + 0.2·min(n/6, 1)`.
    pub confidence: f64,
    /// Member rows, oldest first.
    pub row_ids: Vec<String>,
    /// Price change, if flagged.
    pub price_change: Option<PriceChange>,
    /// Suggested kind.
    pub kind: RecurringKind,
    /// Annual cost (absolute).
    pub annual_cost: Decimal,
}

/// Minimum confidence for a candidate to be shown.
pub const MIN_CONFIDENCE: f64 = 0.6;

const SUBSCRIPTION_HINTS: &[&str] = &[
    "netflix",
    "spotify",
    "hulu",
    "disney",
    "apple.com",
    "icloud",
    "youtube",
    "prime",
    "adobe",
    "dropbox",
    "microsoft",
    "google",
    "patreon",
    "audible",
    "peloton",
    "hbo",
    "paramount",
    "max.com",
    "nytimes",
    "substack",
    "github",
    "openai",
    "notion",
    "chatgpt",
    "gym",
    "fitness",
    "xbox",
    "playstation",
    "nintendo",
    "crunchyroll",
    "duolingo",
    "1password",
];

fn stats(values: &[f64]) -> (f64, f64) {
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    (mean, var.sqrt())
}

/// Detects recurring series. Groups are formed by normalised payee and sign. When `today` is given, series
/// whose next occurrence is more than one full period overdue are treated as ended and dropped.
pub fn detect(
    txns: &[RecurringTxn],
    calendar: &HolidayCalendar,
    today: Option<NaiveDate>,
) -> Vec<RecurringCandidate> {
    let mut groups: BTreeMap<(String, bool), Vec<&RecurringTxn>> = BTreeMap::new();
    for t in txns.iter().filter(|t| !t.amount.is_zero()) {
        groups
            .entry((payee_key(&t.payee), t.amount > Decimal::ZERO))
            .or_default()
            .push(t);
    }
    let mut out = Vec::new();
    for ((_, positive), mut g) in groups {
        g.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.id.cmp(&b.id)));
        if g.len() < 2 {
            continue;
        }
        let intervals: Vec<f64> = g
            .windows(2)
            .map(|w| (w[1].date - w[0].date).num_days() as f64)
            .collect();
        let mut sorted = intervals.clone();
        sorted.sort_by(f64::total_cmp);
        let mid = sorted.len() / 2;
        let med = if sorted.len() % 2 == 1 {
            sorted[mid]
        } else {
            (sorted[mid - 1] + sorted[mid]) / 2.0
        };
        let Some(cadence) = Cadence::ALL
            .into_iter()
            .find(|c| (med - c.days()).abs() <= c.tolerance())
        else {
            continue;
        };
        if g.len() < cadence.min_occurrences() {
            continue;
        }
        let interval_fit = intervals
            .iter()
            .filter(|i| (**i - cadence.days()).abs() <= cadence.tolerance())
            .count() as f64
            / intervals.len() as f64;
        let abs: Vec<f64> = g.iter().map(|t| to_f64(t.amount.abs())).collect();
        let (mean, sd) = stats(&abs);
        let cv = if mean > 0.0 { sd / mean } else { 1.0 };
        let amount_fit = (1.0 - cv / 0.10).clamp(0.0, 1.0);
        let confidence =
            0.5 * interval_fit + 0.3 * amount_fit + 0.2 * (g.len() as f64 / 6.0).min(1.0);
        if confidence < MIN_CONFIDENCE {
            continue;
        }
        let last = g[g.len() - 1];
        let anchor = chrono::Datelike::day(&last.date);
        let raw_next = cadence.advance(last.date, anchor);
        if let Some(today) = today
            && cadence.advance(raw_next, anchor) < today
        {
            continue;
        }
        let next_due = calendar.next_business_day_on_or_after(raw_next);
        let amounts: Vec<Decimal> = g.iter().map(|t| t.amount).collect();
        let typical = median(&amounts).unwrap_or(last.amount);
        let price_change = (amounts.len() >= 4)
            .then(|| {
                let prev3 = &amounts[amounts.len() - 4..amounts.len() - 1];
                let from = median(prev3)?;
                let to = last.amount;
                let diff = (to - from).abs();
                (diff > from.abs() * Decimal::new(2, 2) && diff > Decimal::new(50, 2))
                    .then_some(PriceChange { from, to })
            })
            .flatten();
        let key = payee_key(&last.payee);
        let kind = if positive {
            RecurringKind::Income
        } else if SUBSCRIPTION_HINTS.iter().any(|h| key.contains(h))
            || (cv < 0.10
                && matches!(cadence, Cadence::Monthly | Cadence::Yearly)
                && typical.abs() <= Decimal::from(30))
        {
            RecurringKind::Subscription
        } else {
            RecurringKind::Bill
        };
        out.push(RecurringCandidate {
            payee: g[0].payee.clone(),
            cadence,
            amount: typical,
            latest_amount: last.amount,
            variable: cv >= 0.10,
            last_date: last.date,
            next_due,
            confidence: (confidence * 1000.0).round() / 1000.0,
            row_ids: g.iter().map(|t| t.id.clone()).collect(),
            price_change,
            kind,
            annual_cost: annual_cost(typical.abs(), cadence),
        });
    }
    out.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then_with(|| a.payee.cmp(&b.payee))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(id: usize, payee: &str, date: NaiveDate, amount: &str) -> RecurringTxn {
        RecurringTxn {
            id: id.to_string(),
            date,
            amount: amount.parse().unwrap(),
            payee: payee.into(),
        }
    }

    fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn monthly_subscription_with_price_change() {
        let mut t = Vec::new();
        for (i, m) in (1..=6).enumerate() {
            let amt = if m == 6 { "-17.99" } else { "-15.49" };
            t.push(rt(i, "Netflix.com", ymd(2026, m, 3), amt));
        }
        t.push(rt(99, "Random Store", ymd(2026, 2, 9), "-30"));
        let cal = HolidayCalendar::us_federal(2026..=2026);
        let found = detect(&t, &cal, Some(ymd(2026, 6, 20)));
        assert_eq!(found.len(), 1);
        let c = &found[0];
        assert_eq!(c.cadence, Cadence::Monthly);
        assert_eq!(c.kind, RecurringKind::Subscription);
        assert_eq!(c.amount, "-15.49".parse().unwrap());
        assert_eq!(
            c.price_change,
            Some(PriceChange {
                from: "-15.49".parse().unwrap(),
                to: "-17.99".parse().unwrap()
            })
        );
        // 2026-07-03 is the observed Independence Day holiday (Friday) → Monday 07-06.
        assert_eq!(c.next_due, ymd(2026, 7, 6));
        assert!(c.confidence > 0.8, "{}", c.confidence);
        assert_eq!(c.annual_cost, "185.88".parse().unwrap());
    }

    #[test]
    fn biweekly_income_and_yearly_and_variable() {
        let mut t = Vec::new();
        let start = ymd(2026, 1, 2);
        for i in 0..6 {
            t.push(rt(
                i,
                "ACME Payroll",
                start + Duration::days(14 * i as i64),
                "2100.00",
            ));
        }
        t.push(rt(10, "Insurance Co", ymd(2024, 3, 1), "-1200"));
        t.push(rt(11, "Insurance Co", ymd(2025, 3, 4), "-1250"));
        for (i, amt) in ["-80", "-120", "-95", "-140"].iter().enumerate() {
            t.push(rt(20 + i, "City Power", ymd(2026, 1 + i as u32, 15), amt));
        }
        let cal = HolidayCalendar::weekends_only();
        let found = detect(&t, &cal, None);
        let pay = found.iter().find(|c| c.payee == "ACME Payroll").unwrap();
        assert_eq!(
            (pay.cadence, pay.kind),
            (Cadence::Biweekly, RecurringKind::Income)
        );
        let ins = found.iter().find(|c| c.payee == "Insurance Co").unwrap();
        assert_eq!(ins.cadence, Cadence::Yearly);
        // Variable amounts: cv ≈ 0.21 → amount_fit 0 → 0.5 + 0 + 0.2·4/6 ≈ 0.633 ≥ 0.6, flagged variable.
        let power = found.iter().find(|c| c.payee == "City Power").unwrap();
        assert!(power.variable);
        assert_eq!(power.kind, RecurringKind::Bill);
    }

    #[test]
    fn rejects_irregular_short_and_stale() {
        let t = vec![
            rt(1, "A", ymd(2026, 1, 1), "-5"),
            rt(2, "A", ymd(2026, 1, 9), "-5"),
            rt(3, "A", ymd(2026, 2, 20), "-5"),
        ];
        assert!(detect(&t, &HolidayCalendar::default(), None).is_empty());
        let t = vec![
            rt(1, "B", ymd(2026, 1, 1), "-5"),
            rt(2, "B", ymd(2026, 2, 1), "-5"),
        ];
        assert!(
            detect(&t, &HolidayCalendar::default(), None).is_empty(),
            "monthly needs 3"
        );
        let t: Vec<_> = (0..4)
            .map(|i| rt(i, "C", ymd(2025, 1 + i as u32, 1), "-9.99"))
            .collect();
        assert!(
            detect(&t, &HolidayCalendar::default(), Some(ymd(2026, 1, 1))).is_empty(),
            "ended long ago"
        );
        assert_eq!(
            detect(&t, &HolidayCalendar::default(), Some(ymd(2025, 5, 15))).len(),
            1
        );
    }
}
