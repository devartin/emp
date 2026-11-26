//! Loan amortisation (`finance_amortization`).
//!
//! Level payment `P·r / (1 − (1+r)^−n)` with `r = APR/12`, rounded to cents (half-up). Each row charges
//! interest on the opening balance (cents, half-up); the final row absorbs rounding so the balance ends at
//! exactly zero. Payment 1 falls on `startDate`, then monthly on the same day of month.

use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};
use crate::money::{cents, parse_decimal, powi};
use crate::period::{add_months_anchored, parse_iso_date};

/// Maximum term (50 years).
pub const MAX_TERM_MONTHS: u32 = 600;

/// `finance_amortization` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmortizationRequest {
    /// Principal (decimal string).
    pub principal: String,
    /// Annual rate in percent (decimal string).
    pub annual_rate_pct: String,
    /// Term in months.
    pub term_months: u32,
    /// Extra principal per month.
    #[serde(default)]
    pub extra_monthly: Option<String>,
    /// First payment date (`YYYY-MM-DD`).
    pub start_date: String,
}

/// One payment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmortizationRow {
    /// 1-based payment number.
    pub n: u32,
    /// Payment date.
    pub date: NaiveDate,
    /// Total paid.
    pub payment: Decimal,
    /// Principal portion.
    pub principal: Decimal,
    /// Interest portion.
    pub interest: Decimal,
    /// Balance after payment.
    pub balance: Decimal,
}

/// `finance_amortization` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Amortization {
    /// Scheduled level payment (without extra).
    pub payment: Decimal,
    /// Total interest.
    pub total_interest: Decimal,
    /// Date of the final payment.
    pub payoff_date: NaiveDate,
    /// Rows.
    pub rows: Vec<AmortizationRow>,
}

/// The level monthly payment for `principal` at `annual_rate_pct` over `n` months.
pub fn level_payment(principal: Decimal, annual_rate_pct: Decimal, n: u32) -> Result<Decimal> {
    if n == 0 {
        return Err(FinanceError::invalid("term must be at least 1 month"));
    }
    let r = annual_rate_pct / Decimal::from(1200);
    if r.is_zero() {
        return Ok(cents(principal / Decimal::from(n)));
    }
    let overflow = || FinanceError::invalid("rate/term overflow");
    let g = powi(Decimal::ONE + r, n).ok_or_else(overflow)?;
    // P·r·g / (g − 1) is the same as P·r / (1 − g^−1) without a division by a tiny number.
    let num = principal
        .checked_mul(r)
        .and_then(|x| x.checked_mul(g))
        .ok_or_else(overflow)?;
    Ok(cents(
        num.checked_div(g - Decimal::ONE).ok_or_else(overflow)?,
    ))
}

/// Builds the amortisation schedule.
pub fn schedule(req: &AmortizationRequest) -> Result<Amortization> {
    let principal = parse_decimal(&req.principal)?;
    let rate = parse_decimal(&req.annual_rate_pct)?;
    let extra = req
        .extra_monthly
        .as_deref()
        .map(parse_decimal)
        .transpose()?
        .unwrap_or_default();
    let start = parse_iso_date(&req.start_date)?;
    if principal >= crate::money::amount_bound() {
        return Err(FinanceError::invalid("principal out of range"));
    }
    if principal <= Decimal::ZERO
        || rate < Decimal::ZERO
        || rate > Decimal::from(100)
        || extra < Decimal::ZERO
    {
        return Err(FinanceError::invalid(
            "principal must be > 0, rate 0–100%, extra ≥ 0",
        ));
    }
    if req.term_months == 0 || req.term_months > MAX_TERM_MONTHS {
        return Err(FinanceError::invalid(format!(
            "term must be 1–{MAX_TERM_MONTHS} months"
        )));
    }
    let payment = level_payment(principal, rate, req.term_months)?;
    let r = rate / Decimal::from(1200);
    let mut bal = principal;
    let mut rows = Vec::new();
    let mut total_interest = Decimal::ZERO;
    let anchor = start.day();
    let mut n = 0u32;
    while bal > Decimal::ZERO && n < MAX_TERM_MONTHS {
        n += 1;
        let interest = cents(bal * r);
        let mut pay = payment + extra;
        let last = n == req.term_months || bal + interest <= pay;
        if last {
            pay = bal + interest;
        }
        let principal_part = pay - interest;
        bal -= principal_part;
        total_interest += interest;
        rows.push(AmortizationRow {
            n,
            date: add_months_anchored(start, n as i32 - 1, anchor),
            payment: pay,
            principal: principal_part,
            interest,
            balance: bal,
        });
        if last {
            break;
        }
    }
    let payoff_date = rows.last().map_or(start, |r| r.date);
    Ok(Amortization {
        payment,
        total_interest,
        payoff_date,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::dec;

    fn req(p: &str, r: &str, n: u32, extra: Option<&str>) -> AmortizationRequest {
        AmortizationRequest {
            principal: p.into(),
            annual_rate_pct: r.into(),
            term_months: n,
            extra_monthly: extra.map(str::to_string),
            start_date: "2026-01-31".into(),
        }
    }

    #[test]
    fn mortgage_textbook() {
        // $200,000 at 6% for 30 years → $1,199.10/month.
        assert_eq!(
            level_payment(dec("200000"), dec("6"), 360).unwrap(),
            dec("1199.10")
        );
        let a = schedule(&req("200000", "6", 360, None)).unwrap();
        assert_eq!(a.rows.len(), 360);
        assert_eq!(a.rows[0].interest, dec("1000.00"));
        assert_eq!(a.rows.last().unwrap().balance, Decimal::ZERO);
        let paid: Decimal = a.rows.iter().map(|r| r.principal).sum();
        assert_eq!(paid, dec("200000"));
        // Last payment is within a few dollars of the level payment.
        assert!((a.rows.last().unwrap().payment - a.payment).abs() < dec("5"));
        assert_eq!(a.rows[1].date.to_string(), "2026-02-28");
        assert_eq!(a.rows[2].date.to_string(), "2026-03-31");
        assert_eq!(a.payoff_date.to_string(), "2055-12-31");
    }

    #[test]
    fn extra_shortens_and_zero_rate() {
        let base = schedule(&req("20000", "7", 60, None)).unwrap();
        let fast = schedule(&req("20000", "7", 60, Some("200"))).unwrap();
        assert!(fast.rows.len() < base.rows.len());
        assert!(fast.total_interest < base.total_interest);
        let z = schedule(&req("1200", "0", 12, None)).unwrap();
        assert_eq!(z.payment, dec("100.00"));
        assert_eq!(z.total_interest, Decimal::ZERO);
        assert_eq!(z.rows.len(), 12);
    }

    #[test]
    fn validation() {
        assert!(schedule(&req("0", "5", 12, None)).is_err());
        assert!(schedule(&req("100", "5", 0, None)).is_err());
        assert!(schedule(&req("100", "500", 12, None)).is_err());
        let mut r = req("100", "5", 12, None);
        r.start_date = "2026-13-01".into();
        assert!(schedule(&r).is_err());
    }
}
