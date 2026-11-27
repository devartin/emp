//! Tax commands (SPEC §11.3 "Portfolio and tax", §15.6).
//!
//! Pure calls into `emp-finance`'s tax engine over the built-in packs. Every estimate carries the pack's disclaimer
//! and staleness; results are estimates, never "you owe".

use std::collections::BTreeMap;

use chrono::Datelike;
use emp_finance::Decimal;
use emp_finance::calendar::HolidayCalendar;
use emp_finance::tax::engine::{TaxEstimate, TaxInput, estimate, validate_input};
use emp_finance::tax::estimated::{QuarterlyPlan, QuarterlyRequest, plan};
use emp_finance::tax::pack::{PackInfo, TaxPack, builtin, builtin_packs};
use emp_store::Store;
use emp_store::dbmodel::{CellValue, RowDto, RowUpdate};
use emp_store::query::config::HasConfig;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::finance::{
    OptionKeys, amount, date, dec, fin_err, load_instance, local_today, norm, option_cell,
    option_for_key, option_key, text,
};
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

// ───────────────────────────────────────────────────────────────────────────── records (ULTRANOTE-1.0 §5)
//
// The Taxes hub reads its Document checklist, Deductions and Estimated payments as one compact view with option keys
// and exact sums, plus the figures pulled from Portfolio, and writes statuses, payments and deductions by key.

/// `taxdoc.status`.
pub const DOC_STATUSES: OptionKeys = &[
    ("expected", &[]),
    ("received", &[]),
    ("reviewed", &[]),
    ("sent_to_preparer", &["Sent", "Sent to preparer"]),
    ("n_a", &["N/A", "NA", "Not applicable"]),
];
/// `taxpay.method`.
pub const PAY_METHODS: OptionKeys = &[
    ("online", &["Direct pay", "Online"]),
    ("check", &["Cheque"]),
    ("withholding", &["Extra withholding"]),
];
/// `taxded.category`: key, names, the engine's itemised kind.
pub const DEDUCTION_CATEGORIES: &[(&str, &[&str], Option<&str>)] = &[
    ("charity", &["Charitable gifts", "Charity"], Some("charity")),
    ("medical", &["Medical & dental", "Medical"], Some("medical")),
    ("salt", &["State & local taxes", "SALT"], Some("salt")),
    ("mortgage", &["Mortgage interest"], Some("mortgage")),
    ("home_office", &["Home office"], None),
    ("business", &["Business expense"], None),
    ("education", &["Education"], None),
    ("childcare", &["Childcare"], None),
    ("hsa", &["HSA contribution"], None),
    ("ira", &["Traditional IRA contribution"], None),
    ("other", &["Other"], None),
];

/// The key of a `taxded.category` option: its id when that is a key, else by name.
fn deduction_key(id: &str, name: &str) -> &'static str {
    if let Some((k, _, _)) = DEDUCTION_CATEGORIES.iter().find(|(k, _, _)| *k == id) {
        return k;
    }
    let n = norm(name);
    DEDUCTION_CATEGORIES
        .iter()
        .find(|(k, names, _)| *k == n || names.iter().any(|a| norm(a) == n))
        .map_or("other", |(k, _, _)| k)
}

/// `TaxRecords.dbs`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxDbsDto {
    documents: Option<String>,
    deductions: Option<String>,
    payments: Option<String>,
}

/// A checklist document.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxDocDto {
    id: String,
    name: String,
    issuer: String,
    purpose: String,
    expected: Option<String>,
    status: String,
    notes: String,
}

/// A deduction row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxDeductionDto {
    id: String,
    desc: String,
    date: Option<String>,
    /// Category key.
    key: String,
    category_name: String,
    /// The engine's itemised kind, `None` when not itemisable.
    kind: Option<String>,
    amount: String,
    /// Deductible share (1 = 100%).
    pct: f64,
    /// `amount × pct`.
    deductible: String,
    payee: String,
    receipt: bool,
    year: Option<i32>,
}

/// An estimated payment row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxPaymentDto {
    id: String,
    period: String,
    due: Option<String>,
    amount: String,
    paid_on: Option<String>,
    method: String,
}

/// A figure pulled from another app.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledDto {
    label: String,
    kind: String,
    amount: String,
    source: String,
}

/// An itemised total by kind.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemizedDto {
    kind: String,
    amount: String,
}

/// `tax_records` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxRecordsDto {
    currency: String,
    dbs: TaxDbsDto,
    /// `taxded.receipt`'s type: `checkbox`, `files` or `null`.
    receipt_field: Option<String>,
    docs: Vec<TaxDocDto>,
    deductions: Vec<TaxDeductionDto>,
    payments: Vec<TaxPaymentDto>,
    /// Itemisable deductions of `year` summed by engine kind (`amount × pct`, exact).
    itemized: Vec<ItemizedDto>,
    /// Estimated payments made (rows with a paid date).
    paid_estimated: String,
    /// Portfolio's realised gains and taxable-account dividends of `year`.
    pulled: Vec<PulledDto>,
}

fn m2(d: Decimal) -> String {
    let mut d = d.round_dp(2);
    d.rescale(2);
    d.to_string()
}

/// The deductible share of a `taxded.pct` cell: a fraction; a value above 1 is a whole percentage.
fn share(v: Option<Decimal>) -> Decimal {
    match v {
        Some(x) if x < Decimal::ZERO => Decimal::ONE,
        Some(x) if x > Decimal::ONE => (x / Decimal::ONE_HUNDRED).min(Decimal::ONE),
        Some(x) => x,
        None => Decimal::ONE,
    }
}

/// Portfolio's figures for `year` (realised gains, dividends paid into taxable accounts) for the tax estimate.
fn pulled_from_portfolio(
    store: &Store,
    workspace_id: &str,
    year: i32,
) -> ApiResult<Vec<PulledDto>> {
    let Some(pf) = store
        .lifeapp_instances(workspace_id)?
        .into_iter()
        .find(|i| i.app_id == "portfolio" && !i.detached)
    else {
        return Ok(Vec::new());
    };
    let data = super::portfolio::PortfolioData::load(store, &pf.id)?;
    let book = data.book();
    let (mut short, mut long) = (Decimal::ZERO, Decimal::ZERO);
    let taxable = |account: &str| {
        data.treatment.get(account).copied().unwrap_or_default()
            == emp_finance::portfolio::TaxTreatment::Taxable
    };
    // Only taxable accounts: gains and dividends inside an IRA, 401(k) or HSA are not taxed this year.
    for r in book
        .realized
        .iter()
        .filter(|r| r.sold.year() == year && taxable(&r.account_id))
    {
        match r.term {
            emp_finance::portfolio::lots::Term::Short => short += r.gain,
            emp_finance::portfolio::lots::Term::Long => long += r.gain,
        }
    }
    let divs: Decimal = book
        .income
        .iter()
        .filter(|i| {
            i.kind == emp_finance::portfolio::InvTxnType::Dividend
                && i.date.year() == year
                && taxable(&i.account_id)
        })
        .map(|i| i.amount.abs())
        .sum();
    let mut out = Vec::new();
    let realised = "Investments · realised this year";
    if !short.is_zero() {
        out.push(PulledDto {
            label: "Short-term gains".into(),
            kind: "stcg".into(),
            amount: m2(short),
            source: realised.into(),
        });
    }
    if !long.is_zero() {
        out.push(PulledDto {
            label: "Long-term gains".into(),
            kind: "ltcg".into(),
            amount: m2(long),
            source: realised.into(),
        });
    }
    if !divs.is_zero() {
        out.push(PulledDto {
            label: "Ordinary dividends".into(),
            kind: "ordinary_dividends".into(),
            amount: m2(divs),
            source: "Investments · taxable accounts, paid so far".into(),
        });
        out.push(PulledDto {
            label: "of which qualified".into(),
            kind: "qualified_dividends".into(),
            amount: m2(divs * Decimal::new(9, 1)),
            source: "Investments · common for broad funds (≈90%)".into(),
        });
    }
    Ok(out)
}

/// `tax_records` (testable body).
pub fn records(store: &Store, instance_id: &str, year: i32) -> ApiResult<TaxRecordsDto> {
    let (ws, dbs) = load_instance(store, instance_id)?;
    let currency = store
        .vault_settings()
        .map(|v| v.base_currency)
        .unwrap_or_else(|_| "USD".into());
    let get = |r: &RowDto, c: &Option<String>| c.as_ref().and_then(|c| r.values.get(c)).cloned();
    let mut docs = Vec::new();
    if let Some(d) = dbs.get("documents") {
        let st = d.col("taxdoc.status", &["Status"]);
        let (issuer, purpose, expected, notes) = (
            d.col_id("taxdoc.issuer", &["Issuer"]),
            d.col_id("taxdoc.for", &["For"]),
            d.col_id("taxdoc.expected", &["Expected by"]),
            d.col_id("taxdoc.notes", &["Notes"]),
        );
        for r in &d.rows {
            docs.push(TaxDocDto {
                id: r.id.clone(),
                name: d.title(r),
                issuer: text(get(r, &issuer).as_ref()),
                purpose: text(get(r, &purpose).as_ref()),
                expected: date(get(r, &expected).as_ref()).map(|x| x.to_string()),
                status: option_key(r, st, DOC_STATUSES).unwrap_or_else(|| "expected".into()),
                notes: text(get(r, &notes).as_ref()),
            });
        }
    }
    let mut deductions = Vec::new();
    let mut itemized: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut receipt_field = None;
    if let Some(d) = dbs.get("deductions") {
        let cat = d.col("taxded.category", &["Category"]);
        let (dt, am, pct, payee, receipt, yr) = (
            d.col_id("taxded.date", &["Date"]),
            d.col_id("taxded.amount", &["Amount"]),
            d.col_id("taxded.pct", &["Deductible %"]),
            d.col_id("taxded.payee", &["Payee"]),
            d.col("taxded.receipt", &["Receipt"]),
            d.col_id("taxded.year", &["Tax year"]),
        );
        receipt_field = receipt.map(|p| match p.kind {
            emp_store::dbmodel::PropType::Checkbox => "checkbox".to_owned(),
            _ => "files".to_owned(),
        });
        for r in &d.rows {
            let (key, name) = match (cat, cat.and_then(|p| r.values.get(&p.id))) {
                (Some(p), Some(CellValue::Select { v: Some(id) })) => {
                    let name = p
                        .select_options()
                        .into_iter()
                        .find(|o| &o.id == id)
                        .map(|o| o.name)
                        .unwrap_or_default();
                    (deduction_key(id, &name), name)
                }
                _ => ("other", "Other".to_owned()),
            };
            let kind = DEDUCTION_CATEGORIES
                .iter()
                .find(|(k, _, _)| *k == key)
                .and_then(|(_, _, kind)| *kind);
            let a = amount(get(r, &am).as_ref()).unwrap_or_default();
            let p = share(amount(get(r, &pct).as_ref()));
            let day = date(get(r, &dt).as_ref());
            let row_year = amount(get(r, &yr).as_ref())
                .map(emp_finance::money::to_f64)
                .filter(|y| (1990.0..=2100.0).contains(y))
                .map(|y| y.round() as i32);
            let in_year = row_year.or(day.map(|x| x.year())).is_none_or(|y| y == year);
            if let (Some(k), true) = (kind, in_year) {
                *itemized.entry(k.to_owned()).or_default() += a * p;
            }
            let has_receipt = match receipt.and_then(|rp| r.values.get(&rp.id)) {
                Some(CellValue::Check { v }) => *v,
                Some(CellValue::Files { v }) => !v.is_empty(),
                _ => false,
            };
            deductions.push(TaxDeductionDto {
                id: r.id.clone(),
                desc: d.title(r),
                date: day.map(|x| x.to_string()),
                key: key.to_owned(),
                category_name: name,
                kind: kind.map(str::to_owned),
                amount: m2(a),
                pct: emp_finance::money::to_f64(p),
                deductible: m2(a * p),
                payee: text(get(r, &payee).as_ref()),
                receipt: has_receipt,
                year: row_year,
            });
        }
        deductions.sort_by(|a, b| b.date.cmp(&a.date));
    }
    let mut payments = Vec::new();
    let mut paid = Decimal::ZERO;
    if let Some(d) = dbs.get("estimates") {
        let method = d.col("taxpay.method", &["Method"]);
        let (due, am, on) = (
            d.col_id("taxpay.due", &["Due date"]),
            d.col_id("taxpay.amount", &["Paid amount"]),
            d.col_id("taxpay.date", &["Paid date"]),
        );
        for r in &d.rows {
            let a = amount(get(r, &am).as_ref()).unwrap_or_default();
            let paid_on = date(get(r, &on).as_ref());
            if paid_on.is_some() {
                paid += a;
            }
            payments.push(TaxPaymentDto {
                id: r.id.clone(),
                period: d.title(r),
                due: date(get(r, &due).as_ref()).map(|x| x.to_string()),
                amount: m2(a),
                paid_on: paid_on.map(|x| x.to_string()),
                method: option_key(r, method, PAY_METHODS).unwrap_or_default(),
            });
        }
        payments.sort_by(|a, b| a.period.cmp(&b.period));
    }
    Ok(TaxRecordsDto {
        currency,
        dbs: TaxDbsDto {
            documents: dbs.get("documents").map(|d| d.id().to_owned()),
            deductions: dbs.get("deductions").map(|d| d.id().to_owned()),
            payments: dbs.get("estimates").map(|d| d.id().to_owned()),
        },
        receipt_field,
        docs,
        deductions,
        payments,
        itemized: itemized
            .into_iter()
            .filter(|(_, a)| !a.is_zero())
            .map(|(kind, a)| ItemizedDto {
                kind,
                amount: m2(a),
            })
            .collect(),
        paid_estimated: m2(paid),
        pulled: pulled_from_portfolio(store, &ws, year)?,
    })
}

/// `tax_records` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordsReq {
    instance_id: String,
    year: i32,
}

/// `tax_records({ instanceId, year }) → TaxRecords`.
#[tauri::command]
pub async fn tax_records(app: AppHandle, req: RecordsReq) -> ApiResult<TaxRecordsDto> {
    validate::id("instanceId", &req.instance_id)?;
    year("year", req.year)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        records(&store, &req.instance_id, req.year)
    })
    .await
}

/// `tax_doc_status` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocStatusReq {
    instance_id: String,
    id: String,
    /// `expected`, `received`, `reviewed`, `sent_to_preparer` or `n_a`.
    status: String,
}

/// `tax_doc_status` (testable body).
pub fn doc_status(store: &Store, req: &DocStatusReq) -> ApiResult<()> {
    if !DOC_STATUSES.iter().any(|(k, _)| *k == req.status) {
        return Err(ApiError::invalid("status", "unknown document status"));
    }
    let (_, dbs) = load_instance(store, &req.instance_id)?;
    let d = dbs
        .get("documents")
        .ok_or_else(|| ApiError::not_found("document checklist"))?;
    if !d.rows.iter().any(|r| r.id == req.id) {
        return Err(ApiError::not_found("document"));
    }
    let p = d
        .col("taxdoc.status", &["Status"])
        .ok_or_else(|| ApiError::invalid("status", "the checklist has no Status column"))?;
    let o = option_for_key(p, &req.status, DOC_STATUSES)
        .ok_or_else(|| ApiError::invalid("status", "the Status column has no option for this"))?;
    store.db_rows_update(vec![RowUpdate::one(
        &req.id,
        &p.id,
        Some(option_cell(p, o)),
    )])?;
    Ok(())
}

/// `tax_doc_status({ instanceId, id, status })`: sets a checklist document's status by key.
#[tauri::command]
pub async fn tax_doc_status(app: AppHandle, req: DocStatusReq) -> ApiResult<()> {
    validate::id("instanceId", &req.instance_id)?;
    validate::id("id", &req.id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        doc_status(&store, &req)
    })
    .await
}

/// `tax_payment_record` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentReq {
    instance_id: String,
    /// Period title (`Q1 2026`).
    period: String,
    amount: String,
    date: String,
    /// `online` (default), `check` or `withholding`.
    #[serde(default)]
    method: Option<String>,
}

/// An `{ id }` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdDto {
    id: String,
}

fn money_cell(d: Decimal, cur: &str) -> CellValue {
    CellValue::Money {
        v: Some(m2(d)),
        cur: cur.to_owned(),
    }
}

fn date_cell(d: chrono::NaiveDate) -> CellValue {
    CellValue::Date {
        v: Some(emp_store::dbmodel::DateValue {
            start: d.to_string(),
            end: None,
            time: false,
            tz: None,
        }),
    }
}

/// `tax_payment_record` (testable body).
pub fn payment_record(store: &Store, req: &PaymentReq) -> ApiResult<String> {
    let value = dec("amount", &req.amount)?;
    if value <= Decimal::ZERO {
        return Err(ApiError::invalid("amount", "must be more than zero"));
    }
    let day = validate::ymd("date", &req.date)?;
    let method = req.method.as_deref().unwrap_or("online");
    if !PAY_METHODS.iter().any(|(k, _)| *k == method) {
        return Err(ApiError::invalid(
            "method",
            "must be online, check or withholding",
        ));
    }
    let (_, dbs) = load_instance(store, &req.instance_id)?;
    let d = dbs
        .get("estimates")
        .ok_or_else(|| ApiError::not_found("estimated payments database"))?;
    let cur = store
        .vault_settings()
        .map(|v| v.base_currency)
        .unwrap_or_else(|_| "USD".into());
    let mut v: BTreeMap<String, CellValue> = BTreeMap::new();
    if let Some(p) = d.col_id("taxpay.amount", &["Paid amount"]) {
        v.insert(p, money_cell(value, &cur));
    }
    if let Some(p) = d.col_id("taxpay.date", &["Paid date"]) {
        v.insert(p, date_cell(day));
    }
    if let Some(p) = d.col("taxpay.method", &["Method"])
        && let Some(o) = option_for_key(p, method, PAY_METHODS)
    {
        v.insert(p.id.clone(), option_cell(p, o));
    }
    let period = req.period.trim();
    match d.rows.iter().find(|r| d.title(r).trim() == period) {
        Some(r) => {
            store.db_rows_update(vec![RowUpdate {
                id: r.id.clone(),
                values: v.into_iter().map(|(k, c)| (k, Some(c))).collect(),
                base_rev: None,
            }])?;
            Ok(r.id.clone())
        }
        None => {
            v.insert(d.title_id().to_owned(), CellValue::text(period));
            store
                .db_rows_insert_bulk(d.id(), vec![v], None)?
                .into_iter()
                .next()
                .ok_or_else(|| ApiError::internal("payment not recorded"))
        }
    }
}

/// `tax_payment_record({ instanceId, period, amount, date, method? }) → { id }`: records an estimated payment on
/// its period's row (created when missing).
#[tauri::command]
pub async fn tax_payment_record(app: AppHandle, req: PaymentReq) -> ApiResult<IdDto> {
    validate::id("instanceId", &req.instance_id)?;
    validate::non_empty("period", &req.period, 200)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(IdDto {
            id: payment_record(&store, &req)?,
        })
    })
    .await
}

/// `tax_deduction_add` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeductionReq {
    instance_id: String,
    desc: String,
    date: String,
    /// Category key (`charity`, `medical`, …).
    category: String,
    amount: String,
    #[serde(default)]
    payee: Option<String>,
    /// Ticks a checkbox receipt column (a files column is attached in the database itself).
    #[serde(default)]
    receipt: Option<bool>,
    year: i32,
}

/// `tax_deduction_add` (testable body).
pub fn deduction_add(store: &Store, req: &DeductionReq) -> ApiResult<String> {
    let value = dec("amount", &req.amount)?;
    if value <= Decimal::ZERO {
        return Err(ApiError::invalid("amount", "must be more than zero"));
    }
    let day = validate::ymd("date", &req.date)?;
    if !DEDUCTION_CATEGORIES
        .iter()
        .any(|(k, _, _)| *k == req.category)
    {
        return Err(ApiError::invalid("category", "unknown category"));
    }
    let (_, dbs) = load_instance(store, &req.instance_id)?;
    let d = dbs
        .get("deductions")
        .ok_or_else(|| ApiError::not_found("deductions database"))?;
    let cur = store
        .vault_settings()
        .map(|v| v.base_currency)
        .unwrap_or_else(|_| "USD".into());
    let mut v: BTreeMap<String, CellValue> = BTreeMap::new();
    v.insert(d.title_id().to_owned(), CellValue::text(req.desc.trim()));
    if let Some(p) = d.col_id("taxded.date", &["Date"]) {
        v.insert(p, date_cell(day));
    }
    if let Some(p) = d.col("taxded.category", &["Category"])
        && let Some(o) = p
            .select_options()
            .into_iter()
            .find(|o| deduction_key(&o.id, &o.name) == req.category)
    {
        v.insert(p.id.clone(), option_cell(p, o.id));
    }
    if let Some(p) = d.col_id("taxded.amount", &["Amount"]) {
        v.insert(p, money_cell(value, &cur));
    }
    if let Some(p) = d.col_id("taxded.pct", &["Deductible %"]) {
        v.insert(p, CellValue::number(1.0));
    }
    if let (Some(p), Some(payee)) = (
        d.col_id("taxded.payee", &["Payee"]),
        req.payee
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    ) {
        v.insert(p, CellValue::text(payee));
    }
    if let (Some(p), Some(r)) = (d.col("taxded.receipt", &["Receipt"]), req.receipt)
        && p.kind == emp_store::dbmodel::PropType::Checkbox
    {
        v.insert(p.id.clone(), CellValue::Check { v: r });
    }
    if let Some(p) = d.col_id("taxded.year", &["Tax year"]) {
        v.insert(p, CellValue::number(f64::from(req.year)));
    }
    store
        .db_rows_insert_bulk(d.id(), vec![v], None)?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("deduction not added"))
}

/// `tax_deduction_add({ instanceId, desc, date, category, amount, payee?, receipt?, year }) → { id }`.
#[tauri::command]
pub async fn tax_deduction_add(app: AppHandle, req: DeductionReq) -> ApiResult<IdDto> {
    validate::id("instanceId", &req.instance_id)?;
    validate::non_empty("desc", &req.desc, 500)?;
    year("year", req.year)?;
    if let Some(p) = &req.payee {
        validate::bounded("payee", p, 500)?;
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(IdDto {
            id: deduction_add(&store, &req)?,
        })
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

    fn install(store: &Store, app: &str) -> String {
        let ws = store.workspace_list().unwrap().remove(0).id;
        let req: emp_store::LifeappInstall = serde_json::from_value(json!({
            "appId": app, "answers": {}, "mode": "quick", "disabledKeys": [], "workspaceId": ws, "sampleData": false
        }))
        .unwrap();
        store
            .lifeapp_install(&req, &emp_store::NoProgress)
            .unwrap()
            .instance_id
    }

    #[test]
    fn records_statuses_payments_and_deductions_by_key() {
        let (_dir, store) = super::super::finance::test_support::temp_store();
        let inst = install(&store, "tax-organizer");
        let r = records(&store, &inst, 2026).unwrap();
        assert!(
            !r.docs.is_empty(),
            "the checklist is generated from the pack"
        );
        assert!(r.docs.iter().all(|d| d.status == "expected"));
        let doc = r.docs[0].id.clone();
        for status in ["received", "sent_to_preparer", "n_a"] {
            doc_status(
                &store,
                &serde_json::from_value(json!({ "instanceId": inst, "id": doc, "status": status }))
                    .unwrap(),
            )
            .unwrap();
            let r = records(&store, &inst, 2026).unwrap();
            assert_eq!(r.docs.iter().find(|d| d.id == doc).unwrap().status, status);
        }
        assert!(
            doc_status(
                &store,
                &serde_json::from_value(json!({ "instanceId": inst, "id": doc, "status": "lost" }))
                    .unwrap()
            )
            .is_err()
        );

        for (desc, cat, amount) in [
            ("Food bank", "charity", "300"),
            ("Dentist", "medical", "120.10"),
            ("Dentist again", "medical", "0.20"),
            ("Laptop", "business", "1240"),
        ] {
            deduction_add(
                &store,
                &serde_json::from_value(json!({ "instanceId": inst, "desc": desc, "date": "2026-05-01", "category": cat, "amount": amount, "year": 2026 })).unwrap(),
            )
            .unwrap();
        }
        let r = records(&store, &inst, 2026).unwrap();
        assert_eq!(r.deductions.len(), 4);
        let items: BTreeMap<String, String> = r
            .itemized
            .iter()
            .map(|i| (i.kind.clone(), i.amount.clone()))
            .collect();
        assert_eq!(items.get("charity").map(String::as_str), Some("300.00"));
        assert_eq!(
            items.get("medical").map(String::as_str),
            Some("120.30"),
            "exact: 120.10 + 0.20"
        );
        assert!(
            !items.contains_key("business"),
            "a business expense is not itemised"
        );
        assert!(deduction_add(&store, &serde_json::from_value(json!({ "instanceId": inst, "desc": "X", "date": "2026-05-01", "category": "yacht", "amount": "1", "year": 2026 })).unwrap()).is_err());

        let id = payment_record(&store, &serde_json::from_value(json!({ "instanceId": inst, "period": "Q1 2026", "amount": "1200", "date": "2026-04-15" })).unwrap()).unwrap();
        let again = payment_record(&store, &serde_json::from_value(json!({ "instanceId": inst, "period": "Q1 2026", "amount": "1250", "date": "2026-04-14", "method": "check" })).unwrap()).unwrap();
        assert_eq!(id, again, "the period's row is updated");
        let r = records(&store, &inst, 2026).unwrap();
        let p = r.payments.iter().find(|p| p.id == id).unwrap();
        assert_eq!(
            (p.amount.as_str(), p.paid_on.as_deref(), p.method.as_str()),
            ("1250.00", Some("2026-04-14"), "check")
        );
        assert_eq!(r.paid_estimated, "1250.00");
    }

    #[test]
    fn portfolio_figures_come_from_taxable_accounts_only() {
        let (_dir, store) = super::super::finance::test_support::temp_store();
        let tax = install(&store, "tax-organizer");
        let pf = install(&store, "portfolio");
        let trade = |v: serde_json::Value| {
            super::super::portfolio::trade(&store, &serde_json::from_value(v).unwrap()).unwrap()
        };
        let b = trade(
            json!({ "instanceId": pf, "date": "2026-01-15", "type": "buy", "symbol": "VTI", "qty": "10", "price": "200" }),
        );
        trade(
            json!({ "instanceId": pf, "date": "2026-03-20", "type": "dividend", "symbol": "VTI", "amount": "30", "accountId": b.account_id }),
        );
        trade(
            json!({ "instanceId": pf, "date": "2026-06-15", "type": "sell", "symbol": "VTI", "qty": "4", "price": "250", "accountId": b.account_id }),
        );
        let r = records(&store, &tax, 2026).unwrap();
        let pulled: BTreeMap<String, String> = r
            .pulled
            .iter()
            .map(|p| (p.kind.clone(), p.amount.clone()))
            .collect();
        assert_eq!(pulled.get("stcg").map(String::as_str), Some("200.00"));
        assert_eq!(
            pulled.get("ordinary_dividends").map(String::as_str),
            Some("30.00")
        );
        assert_eq!(
            pulled.get("qualified_dividends").map(String::as_str),
            Some("27.00")
        );
        assert!(
            records(&store, &tax, 2025).unwrap().pulled.is_empty(),
            "nothing realised in 2025"
        );
    }

    #[test]
    fn the_known_estimate_matches_the_hand_calculation() {
        // Single, $85,000 wages, $9,000 withheld: 85,000 − 16,100 = 68,900 taxable;
        // 12,400 × 10% + 38,000 × 12% + 18,500 × 22% = 1,240 + 4,560 + 4,070 = 9,870; 870 due.
        let input: TaxInput = serde_json::from_value(json!({
            "packId": "us-federal-2026", "year": 2026, "filingStatus": "single", "dependents": 0,
            "incomes": [{ "kind": "wages", "amount": "85000" }],
            "adjustments": [], "deductions": { "itemized": [] }, "credits": [],
            "withheld": "9000", "estimatedPaid": "0"
        }))
        .unwrap();
        let est = run_estimate(&input, today()).unwrap();
        assert_eq!(est.total_tax, Decimal::from(9870));
        assert_eq!(est.balance, Decimal::from(870));
    }
}
