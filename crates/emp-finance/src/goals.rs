//! Goals (§15.5 `goals::monthly_needed`) and the emergency-fund recommendation (§16.2 Q8).

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};
use crate::money::{cents, parse_decimal, powi};
use crate::period::{YearMonth, parse_iso_date};

/// Whole months from `today`'s month to `by`'s month (0 when due or past).
pub fn months_left(today: NaiveDate, by: NaiveDate) -> u32 {
    if by <= today {
        return 0;
    }
    YearMonth::of(today).months_until(YearMonth::of(by)).max(0) as u32
}

/// Monthly amount needed to reach `target` by `by`.
///
/// * Due or past: `target − saved`.
/// * Otherwise `(target − saved) / months_left`.
/// * With an expected annual yield `r` (fraction, e.g. 0.04): the annuity form
///   `(target − saved·(1+r/12)^n) · (r/12) / ((1+r/12)^n − 1)`.
///
/// Never negative; rounded to cents (half-up).
pub fn monthly_needed(
    target: Decimal,
    saved: Decimal,
    by: NaiveDate,
    today: NaiveDate,
    annual_yield: Option<Decimal>,
) -> Result<Decimal> {
    let bound = crate::money::amount_bound();
    if target < Decimal::ZERO || saved < Decimal::ZERO || target >= bound || saved >= bound {
        return Err(FinanceError::invalid("target and saved must be ≥ 0"));
    }
    let n = months_left(today, by);
    let gap = target - saved;
    if n == 0 {
        return Ok(cents(gap.max(Decimal::ZERO)));
    }
    let r = annual_yield.unwrap_or_default();
    if r < Decimal::ZERO || r > Decimal::ONE {
        return Err(FinanceError::invalid("yield must be 0–100%"));
    }
    let v = if r.is_zero() {
        gap / Decimal::from(n)
    } else {
        let i = r / Decimal::from(12);
        let g = powi(Decimal::ONE + i, n)
            .ok_or_else(|| FinanceError::invalid("yield/term overflow"))?;
        let overflow = || FinanceError::invalid("yield/term overflow");
        let grown = saved.checked_mul(g).ok_or_else(overflow)?;
        (target - grown)
            .checked_mul(i)
            .and_then(|x| x.checked_div(g - Decimal::ONE))
            .ok_or_else(overflow)?
    };
    Ok(cents(v.max(Decimal::ZERO)))
}

/// `finance_goal_plan` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalPlanRequest {
    /// Target amount.
    pub target: String,
    /// Target date (`YYYY-MM-DD`).
    pub by: String,
    /// Current amount saved.
    pub current: String,
    /// Expected annual yield in percent.
    pub annual_yield_pct: String,
    /// Planned monthly contribution (extension; used for `onTrack`).
    #[serde(default)]
    pub monthly_contribution: Option<String>,
}

/// `finance_goal_plan` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalPlan {
    /// Monthly amount required.
    pub monthly_required: Decimal,
    /// Already funded, or the planned contribution covers the requirement.
    pub on_track: bool,
    /// Months left.
    pub months_left: u32,
}

/// Evaluates a goal plan for `today`.
pub fn plan(req: &GoalPlanRequest, today: NaiveDate) -> Result<GoalPlan> {
    let target = parse_decimal(&req.target)?;
    let current = parse_decimal(&req.current)?;
    let by = parse_iso_date(&req.by)?;
    let y = parse_decimal(&req.annual_yield_pct)? / Decimal::ONE_HUNDRED;
    let required = monthly_needed(target, current, by, today, Some(y))?;
    let contribution = req
        .monthly_contribution
        .as_deref()
        .map(parse_decimal)
        .transpose()?;
    let on_track =
        current >= target || required.is_zero() || contribution.is_some_and(|c| c >= required);
    Ok(GoalPlan {
        monthly_required: required,
        on_track,
        months_left: months_left(today, by),
    })
}

/// Inputs for [`recommend_ef_months`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EfAnswers {
    /// Two stable incomes in the household.
    pub dual_stable_income: bool,
    /// Number of dependents.
    pub dependents: u32,
    /// Income is irregular.
    pub irregular_income: bool,
    /// Self-employed.
    pub self_employed: bool,
}

/// `recommend_ef_months`: irregular or self-employed → 9; dual stable income with no dependents → 3;
/// otherwise (single income or dependents) → 6.
pub fn recommend_ef_months(a: &EfAnswers) -> u32 {
    if a.irregular_income || a.self_employed {
        9
    } else if a.dual_stable_income && a.dependents == 0 {
        3
    } else {
        6
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::dec;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn linear_and_due() {
        assert_eq!(
            monthly_needed(
                dec("1200"),
                dec("0"),
                d("2027-01-15"),
                d("2026-01-10"),
                None
            )
            .unwrap(),
            dec("100.00")
        );
        assert_eq!(
            monthly_needed(
                dec("1200"),
                dec("200"),
                d("2026-01-01"),
                d("2026-02-01"),
                None
            )
            .unwrap(),
            dec("1000.00")
        );
        assert_eq!(
            monthly_needed(
                dec("100"),
                dec("500"),
                d("2027-01-01"),
                d("2026-01-01"),
                None
            )
            .unwrap(),
            dec("0.00")
        );
        assert!(
            monthly_needed(dec("-1"), dec("0"), d("2027-01-01"), d("2026-01-01"), None).is_err()
        );
    }

    #[test]
    fn annuity_form() {
        // FV of 12 payments of x at 6%/12: x·((1.005^12 − 1)/0.005) = 10000 → x ≈ 810.66
        let m = monthly_needed(
            dec("10000"),
            dec("0"),
            d("2027-01-01"),
            d("2026-01-01"),
            Some(dec("0.06")),
        )
        .unwrap();
        assert_eq!(m, dec("810.66"));
        let lower = monthly_needed(
            dec("10000"),
            dec("5000"),
            d("2027-01-01"),
            d("2026-01-01"),
            Some(dec("0.06")),
        )
        .unwrap();
        assert!(lower < dec("410"));
    }

    #[test]
    fn plan_and_ef() {
        let p = plan(
            &GoalPlanRequest {
                target: "6000".into(),
                by: "2026-12-31".into(),
                current: "1000".into(),
                annual_yield_pct: "0".into(),
                monthly_contribution: Some("500".into()),
            },
            d("2026-02-15"),
        )
        .unwrap();
        assert_eq!(p.months_left, 10);
        assert_eq!(p.monthly_required, dec("500.00"));
        assert!(p.on_track);
        assert_eq!(
            recommend_ef_months(&EfAnswers {
                dual_stable_income: true,
                dependents: 0,
                irregular_income: false,
                self_employed: false
            }),
            3
        );
        assert_eq!(
            recommend_ef_months(&EfAnswers {
                dual_stable_income: true,
                dependents: 1,
                irregular_income: false,
                self_employed: false
            }),
            6
        );
        assert_eq!(
            recommend_ef_months(&EfAnswers {
                dual_stable_income: false,
                dependents: 0,
                irregular_income: false,
                self_employed: true
            }),
            9
        );
    }
}
