//! Tax commands (SPEC §11.3 "Portfolio and tax", §15.6).
//!
//! Pure calls into `emp-finance`'s tax engine over the built-in packs. Every estimate carries the pack's disclaimer
//! and staleness; results are estimates, never "you owe".

use emp_finance::calendar::HolidayCalendar;
use emp_finance::tax::engine::{TaxEstimate, TaxInput, estimate, validate_input};
use emp_finance::tax::estimated::{QuarterlyPlan, QuarterlyRequest, plan};
use emp_finance::tax::pack::{PackInfo, TaxPack, builtin, builtin_packs};
use tauri::{AppHandle, Manager};

use super::finance::{fin_err, local_today};
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, blocking};
use crate::validate;

/// The tax year a pack listing is evaluated against (the current local year).
fn selected_year(today: chrono::NaiveDate) -> i32 {
    chrono::Datelike::year(&today)
}

/// Every built-in pack as a `tax_packs` row.
pub fn pack_infos(today: chrono::NaiveDate) -> ApiResult<Vec<PackInfo>> {
    let year = selected_year(today);
    Ok(builtin_packs()
        .map_err(fin_err)?
        .iter()
        .map(|p| p.info(year.max(p.year), today))
        .collect())
}

fn pack(field: &str, id: &str) -> ApiResult<TaxPack> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err(ApiError::invalid(field, "invalid pack id"));
    }
    builtin(id).map_err(|_| ApiError::not_found("tax pack"))
}

fn year(field: &str, y: i32) -> ApiResult<()> {
    if (1990..=2100).contains(&y) {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "invalid year"))
    }
}

/// `tax_packs({}) → { id, name, year, tier, version, verifiedOn, stale }[]`.
#[tauri::command]
pub async fn tax_packs(app: AppHandle, req: super::Empty) -> ApiResult<Vec<PackInfo>> {
    let _ = req;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        pack_infos(local_today(&store))
    })
    .await
}

/// Runs the estimator for `input` (validated against its pack).
pub fn run_estimate(input: &TaxInput, today: chrono::NaiveDate) -> ApiResult<TaxEstimate> {
    year("year", input.year)?;
    validate::bounded("filingStatus", &input.filing_status, 64)?;
    validate::list_len("incomes", input.incomes.len(), 500)?;
    validate::list_len("adjustments", input.adjustments.len(), 500)?;
    validate::list_len("credits", input.credits.len(), 100)?;
    if input.dependents > 50 {
        return Err(ApiError::invalid("dependents", "must be 0–50"));
    }
    let p = pack("packId", &input.pack_id)?;
    validate_input(&p, input).map_err(fin_err)?;
    estimate(&p, input, today).map_err(fin_err)
}

/// `tax_estimate(TaxInput) → TaxEstimate` (§15.6).
#[tauri::command]
pub async fn tax_estimate(app: AppHandle, req: TaxInput) -> ApiResult<TaxEstimate> {
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let today = local_today(&store);
        crate::jobs::catch_panics(|| run_estimate(&req, today))
            .map_err(|_| ApiError::internal("tax engine panicked"))?
    })
    .await
}

/// Builds the quarterly plan for `req` with the IRS holiday calendar.
pub fn run_quarterly(req: &QuarterlyRequest, today: chrono::NaiveDate) -> ApiResult<QuarterlyPlan> {
    year("year", req.year)?;
    let p = pack("packId", &req.pack_id)?;
    for (f, v) in [
        ("priorYearTax", &req.prior_year_tax),
        ("priorYearAgi", &req.prior_year_agi),
    ] {
        if let Some(x) = v {
            validate::money(f, x)?;
        }
    }
    validate::list_len("paid", req.paid.len(), 100)?;
    for e in &req.paid {
        validate::ymd("paid.date", &e.date)?;
        validate::money("paid.amount", &e.amount)?;
    }
    let cal = HolidayCalendar::us_irs(req.year..=req.year + 1);
    plan(&p, req, today, &cal).map_err(fin_err)
}

/// `tax_quarterly_plan({ packId, year, method, estimate, priorYearTax?, priorYearAgi?, paid })`
/// → `{ due: { period, date, suggested, paid, status }[], method, note }`.
#[tauri::command]
pub async fn tax_quarterly_plan(app: AppHandle, req: QuarterlyRequest) -> ApiResult<QuarterlyPlan> {
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let today = local_today(&store);
        run_quarterly(&req, today)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn today() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2026, 11, 26).unwrap()
    }

    #[test]
    fn lists_builtin_packs() {
        let packs = pack_infos(today()).unwrap();
        assert!(packs.iter().any(|p| p.id == "us-federal-2026"));
    }

    #[test]
    fn rejects_bad_pack_ids() {
        assert_eq!(
            pack("packId", "../x").unwrap_err().code,
            crate::error::ErrorCode::Invalid
        );
        assert_eq!(
            pack("packId", "nope-1900").unwrap_err().code,
            crate::error::ErrorCode::NotFound
        );
    }

    #[test]
    fn estimates_and_plans_a_simple_return() {
        let input: TaxInput = serde_json::from_value(json!({
            "packId": "us-federal-2026", "year": 2026, "filingStatus": "single", "dependents": 0,
            "incomes": [{ "kind": "wages", "amount": "85000" }],
            "deductions": "standard",
            "withheld": "9000", "estimatedPaid": "0"
        }))
        .unwrap();
        let est = run_estimate(&input, today()).unwrap();
        assert!(est.total_tax > emp_finance::Decimal::ZERO);
        assert!(!est.disclaimer.is_empty());
        let req: QuarterlyRequest = serde_json::from_value(json!({
            "packId": "us-federal-2026", "year": 2026, "method": "even_split",
            "estimate": serde_json::to_value(&est).unwrap(), "paid": []
        }))
        .unwrap();
        let p = run_quarterly(&req, today()).unwrap();
        assert_eq!(p.due.len(), 4);
    }
}
