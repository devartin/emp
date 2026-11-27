//! Estimated quarterly payments (§15.6 Quarterly payments, IPC `tax_quarterly_plan`).
//!
//! * `safe_harbor`: `max(0, priorYearPct × priorTax)` — `highIncomePct` when prior AGI is above the
//!   threshold — minus expected withholding, divided over the remaining periods.
//! * `current_90`: `(0.90 × estimate.totalTax − withholding) / remaining`.
//! * `even_split`: `max(0, estimate.balance) / remaining` (the balance already nets withholding and the
//!   estimated payments entered in the estimate).
//!
//! For `safe_harbor` and `current_90`, payments already made (`paid`) are also subtracted before dividing.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::engine::TaxEstimate;
use super::pack::{TaxPack, by_status};
use crate::calendar::HolidayCalendar;
use crate::error::{FinanceError, Result};
use crate::money::{Rounding, parse_decimal, round};

/// Days before a due date at which a period is "due soon".
pub const DUE_SOON_DAYS: i64 = 14;

/// Method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarterlyMethod {
    /// Prior-year safe harbor.
    SafeHarbor,
    /// 90% of the current-year estimate.
    Current90,
    /// Split the estimated balance evenly.
    EvenSplit,
}

/// A recorded payment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaidEntry {
    /// Date (`YYYY-MM-DD`).
    pub date: String,
    /// Amount.
    pub amount: String,
}

/// `tax_quarterly_plan` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuarterlyRequest {
    /// Pack id.
    pub pack_id: String,
    /// Year.
    pub year: i32,
    /// Method.
    pub method: QuarterlyMethod,
    /// Current estimate.
    pub estimate: TaxEstimate,
    /// Prior-year total tax.
    #[serde(default)]
    pub prior_year_tax: Option<String>,
    /// Prior-year AGI.
    #[serde(default)]
    pub prior_year_agi: Option<String>,
    /// Payments made.
    #[serde(default)]
    pub paid: Vec<PaidEntry>,
}

/// Period status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeriodStatus {
    /// Not due yet.
    Upcoming,
    /// Due within [`DUE_SOON_DAYS`].
    DueSoon,
    /// Covered.
    Paid,
    /// Past due and not covered.
    Late,
}

/// One period.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuePeriod {
    /// `Q1`..`Q4`.
    pub period: String,
    /// Due date (shifted to a business day).
    pub date: NaiveDate,
    /// Suggested payment.
    pub suggested: Decimal,
    /// Paid toward this period.
    pub paid: Decimal,
    /// Status.
    pub status: PeriodStatus,
}

/// `tax_quarterly_plan` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarterlyPlan {
    /// Periods.
    pub due: Vec<DuePeriod>,
    /// Method name.
    pub method: String,
    /// Explanation (estimate wording).
    pub note: String,
    /// Annual required amount after withholding (extension).
    pub required_annual: Decimal,
}

/// Builds the plan for `today`.
pub fn plan(
    pack: &TaxPack,
    req: &QuarterlyRequest,
    today: NaiveDate,
    calendar: &HolidayCalendar,
) -> Result<QuarterlyPlan> {
    let est = pack.estimated.as_ref().ok_or_else(|| {
        FinanceError::Unsupported(format!("{} has no estimated-payment schedule", pack.id))
    })?;
    if req.pack_id != pack.id {
        return Err(FinanceError::invalid("pack mismatch"));
    }
    let e = &req.estimate;
    let withholding = e.withheld;
    let mut paid: Vec<(NaiveDate, Decimal)> = req
        .paid
        .iter()
        .map(|p| {
            Ok((
                crate::period::parse_iso_date(&p.date)?,
                parse_decimal(&p.amount)?,
            ))
        })
        .collect::<Result<_>>()?;
    paid.sort_by_key(|p| p.0);
    let paid_total: Decimal = paid.iter().map(|p| p.1).sum();
    let sh = &est.safe_harbor;
    let (required, base_note) = match req.method {
        QuarterlyMethod::SafeHarbor => {
            let prior = req
                .prior_year_tax
                .as_deref()
                .map(parse_decimal)
                .transpose()?
                .ok_or_else(|| FinanceError::invalid("safe harbor needs prior-year tax"))?;
            let prior_agi = req
                .prior_year_agi
                .as_deref()
                .map(parse_decimal)
                .transpose()?
                .unwrap_or_default();
            let threshold = by_status(&sh.high_income_agi, &e.filing_status)
                .copied()
                .unwrap_or(Decimal::MAX);
            let pct = if prior_agi > threshold {
                sh.high_income_pct
            } else {
                sh.prior_year_pct
            };
            let target = (pct * prior).max(Decimal::ZERO);
            (
                (target - withholding - paid_total).max(Decimal::ZERO),
                format!(
                    "Safe harbor: {}% of last year's tax, minus expected withholding and payments made.",
                    (pct * Decimal::ONE_HUNDRED).normalize()
                ),
            )
        }
        QuarterlyMethod::Current90 => (
            (sh.current_year_pct * e.total_tax - withholding - paid_total).max(Decimal::ZERO),
            format!(
                "{}% of this year's estimated tax, minus expected withholding and payments made.",
                (sh.current_year_pct * Decimal::ONE_HUNDRED).normalize()
            ),
        ),
        QuarterlyMethod::EvenSplit => (
            e.balance.max(Decimal::ZERO),
            "The estimated balance due, split evenly over the remaining periods.".to_string(),
        ),
    };
    let periods: Vec<(String, NaiveDate)> = est
        .periods
        .iter()
        .map(|p| (p.id.clone(), calendar.next_business_day_on_or_after(p.due)))
        .collect();
    let remaining: Vec<usize> = (0..periods.len())
        .filter(|&i| periods[i].1 >= today)
        .collect();
    let per = if remaining.is_empty() {
        Decimal::ZERO
    } else {
        round(
            required / Decimal::from(remaining.len() as u64),
            0,
            Rounding::HalfUp,
        )
    };
    // Payments count toward the first period whose due date is on or after the payment.
    let mut paid_by = vec![Decimal::ZERO; periods.len()];
    for (d, a) in &paid {
        let i = periods
            .iter()
            .position(|p| *d <= p.1)
            .unwrap_or(periods.len().saturating_sub(1));
        if let Some(slot) = paid_by.get_mut(i) {
            *slot += *a;
        }
    }
    let past_share = round(
        (required + paid_total) / Decimal::from(periods.len().max(1) as u64),
        0,
        Rounding::HalfUp,
    );
    let due = periods
        .iter()
        .enumerate()
        .map(|(i, (id, date))| {
            let suggested = if remaining.contains(&i) {
                per
            } else {
                past_share
            };
            // Nothing suggested and nothing paid is "no payment needed", never "Paid $0" or "late".
            let status = if paid_by[i] > Decimal::ZERO && paid_by[i] >= suggested {
                PeriodStatus::Paid
            } else if suggested.is_zero() && paid_by[i].is_zero() {
                PeriodStatus::Upcoming
            } else if *date < today {
                PeriodStatus::Late
            } else if (*date - today).num_days() <= DUE_SOON_DAYS {
                PeriodStatus::DueSoon
            } else {
                PeriodStatus::Upcoming
            };
            DuePeriod {
                period: id.clone(),
                date: *date,
                suggested,
                paid: paid_by[i],
                status,
            }
        })
        .collect();
    let mut note = format!("{base_note} Estimates for planning only.");
    if let Some(min) = est.minimum_balance
        && e.balance < min
    {
        note.push_str(&format!(
            " With an estimated balance under {}, quarterly payments may not be required.",
            min.normalize()
        ));
    }
    Ok(QuarterlyPlan {
        due,
        method: match req.method {
            QuarterlyMethod::SafeHarbor => "safe_harbor",
            QuarterlyMethod::Current90 => "current_90",
            QuarterlyMethod::EvenSplit => "even_split",
        }
        .into(),
        note,
        required_annual: required,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tax::deadlines::irs_calendar;
    use crate::tax::engine::estimate;
    use crate::tax::pack::builtin;
    use crate::testutil::dec;
    use serde_json::json;

    fn est() -> TaxEstimate {
        let us = builtin("us-federal-2026").unwrap();
        let input = serde_json::from_value(json!({"packId":"us-federal-2026","year":2026,"filingStatus":"single","dependents":0,
            "incomes":[{"kind":"self_employment","amount":"80000"}],"deductions":"standard","credits":[],"withheld":"0","estimatedPaid":"0"}))
        .unwrap();
        estimate(&us, &input, "2026-03-01".parse().unwrap()).unwrap()
    }

    fn req(method: QuarterlyMethod, paid: Vec<(&str, &str)>) -> QuarterlyRequest {
        QuarterlyRequest {
            pack_id: "us-federal-2026".into(),
            year: 2026,
            method,
            estimate: est(),
            prior_year_tax: Some("12000".into()),
            prior_year_agi: Some("160000".into()),
            paid: paid
                .into_iter()
                .map(|(d, a)| PaidEntry {
                    date: d.into(),
                    amount: a.into(),
                })
                .collect(),
        }
    }

    #[test]
    fn methods() {
        let us = builtin("us-federal-2026").unwrap();
        let cal = irs_calendar(2026);
        let today = "2026-03-01".parse().unwrap();
        let sh = plan(&us, &req(QuarterlyMethod::SafeHarbor, vec![]), today, &cal).unwrap();
        // Prior AGI 160k > 150k → 110% × 12,000 = 13,200 over 4 periods.
        assert_eq!(sh.required_annual, dec("13200.00"));
        assert!(sh.due.iter().all(|d| d.suggested == dec("3300")));
        assert_eq!(sh.due[0].status, PeriodStatus::Upcoming);
        let even = plan(&us, &req(QuarterlyMethod::EvenSplit, vec![]), today, &cal).unwrap();
        assert_eq!(even.required_annual, est().balance);
        let c90 = plan(&us, &req(QuarterlyMethod::Current90, vec![]), today, &cal).unwrap();
        assert!(c90.required_annual < even.required_annual);
        assert!(c90.note.contains("Estimates for planning only"));
    }

    #[test]
    fn statuses_and_remaining() {
        let us = builtin("us-federal-2026").unwrap();
        let cal = irs_calendar(2026);
        let today = "2026-09-05".parse().unwrap();
        let p = plan(
            &us,
            &req(QuarterlyMethod::SafeHarbor, vec![("2026-04-10", "3300")]),
            today,
            &cal,
        )
        .unwrap();
        assert_eq!(p.due[0].status, PeriodStatus::Paid);
        assert_eq!(p.due[1].status, PeriodStatus::Late);
        assert_eq!(p.due[2].status, PeriodStatus::DueSoon);
        // 13,200 − 3,300 paid = 9,900 over the 2 remaining periods.
        assert_eq!(p.due[2].suggested, dec("4950"));
        assert_eq!(p.due[3].status, PeriodStatus::Upcoming);
        let mut r = req(QuarterlyMethod::SafeHarbor, vec![]);
        r.prior_year_tax = None;
        assert!(plan(&us, &r, today, &cal).is_err());
        assert!(
            plan(
                &builtin("generic").unwrap(),
                &req(QuarterlyMethod::EvenSplit, vec![]),
                today,
                &cal
            )
            .is_err()
        );
    }
}
