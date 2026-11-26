//! Portfolio commands (SPEC §11.3 "Portfolio and tax", §15.7, §16.3).
//!
//! Loads a Portfolio instance's databases by role (§15.0) — investment transactions (`inv.*`), securities (`sec.*`),
//! target allocation (`alloc.*`) and the investment accounts — rebuilds tax lots with `emp-finance`, values them with
//! quotes from the market router (cache first, NetGuard + offline mode for misses) and derives performance,
//! rebalancing, dividends and realised gains. `portfolio_rebuild` writes the lots back into the *Lots* database.

use std::collections::{BTreeMap, HashMap};

use chrono::{Datelike, NaiveDate};
use emp_finance::Decimal;
use emp_finance::money::{from_f64, to_f64};
use emp_finance::portfolio::alloc::Target;
use emp_finance::portfolio::holdings::{PriceQuote, SecurityInfo, Valuation};
use emp_finance::portfolio::lots::{LotBook, RebuildOptions};
use emp_finance::portfolio::{InvTxn, InvTxnType, TaxTreatment};
use emp_integrations::market::{BarInterval, Quote};
use emp_store::Store;
use emp_store::dbmodel::{CellValue, ComputedKind, ComputedValue, DateValue, RowDto};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, Webview};

use super::finance::{
    InstanceDb, MoneyDto, amount, date, dec, fin_err, load_instance, local_today, norm, rel, text,
};
use super::job_sink;
use crate::error::{ApiError, ApiResult};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Symbols valued per request.
pub const MAX_SYMBOLS: usize = 200;
/// Symbols with fetched history for `portfolio_performance`.
pub const MAX_HISTORY_SYMBOLS: usize = 50;

// ───────────────────────────────────────────────────────────────────────────── loading

/// A Portfolio instance as `emp-finance` inputs.
#[derive(Clone, Debug, Default)]
pub struct PortfolioData {
    /// Base currency.
    pub currency: String,
    /// Investment transactions.
    pub txns: Vec<InvTxn>,
    /// Securities by symbol key.
    pub securities: HashMap<String, SecurityInfo>,
    /// Tax treatment by account id.
    pub treatment: HashMap<String, TaxTreatment>,
    /// Target allocation.
    pub targets: Vec<Target>,
    /// Lots database (for `portfolio_rebuild`).
    pub lots_db: Option<InstanceDb>,
    /// Security row id → symbol key.
    pub symbol_of: HashMap<String, String>,
}

fn inv_type(name: &str) -> Option<InvTxnType> {
    serde_json::from_value(json!(norm(name))).ok()
}

fn treatment(name: Option<&str>) -> TaxTreatment {
    match name.map(norm).as_deref() {
        Some("tax_deferred") => TaxTreatment::Deferred,
        Some("tax_free") => TaxTreatment::Free,
        _ => TaxTreatment::Taxable,
    }
}

fn treatment_of_type(name: Option<&str>) -> Option<TaxTreatment> {
    match name.map(norm).as_deref()? {
        "401_k" | "403_b" | "traditional_ira" | "pension" => Some(TaxTreatment::Deferred),
        "roth_ira" | "hsa" | "529_plan" => Some(TaxTreatment::Free),
        "taxable_brokerage" | "crypto" => Some(TaxTreatment::Taxable),
        _ => None,
    }
}

/// Normalises a ticker cell to a `SymbolKey` (bare tickers default to `XNAS`).
#[must_use]
pub fn symbol_key(raw: &str) -> Option<String> {
    super::market::stock_key(raw)
}

impl PortfolioData {
    /// Loads the Portfolio instance `instance_id`.
    pub fn load(store: &Store, instance_id: &str) -> ApiResult<Self> {
        let (_, mut dbs) = load_instance(store, instance_id)?;
        let mut p = PortfolioData {
            currency: store
                .vault_settings()
                .map(|v| v.base_currency)
                .unwrap_or_else(|_| "USD".into()),
            ..PortfolioData::default()
        };
        if let Some(d) = dbs.get("securities") {
            let tk = d.col_id("sec.ticker", &["Ticker"]);
            let class = d.col("sec.class", &["Asset class"]);
            let er = d.col_id("sec.expense_ratio", &["Expense ratio"]);
            for r in &d.rows {
                let raw = text(tk.as_ref().and_then(|c| r.values.get(c)));
                let Some(key) = symbol_key(&raw) else {
                    continue;
                };
                p.symbol_of.insert(r.id.clone(), key.clone());
                p.securities.insert(
                    key.clone(),
                    SecurityInfo {
                        symbol: key,
                        name: d.title(r),
                        asset_class: d.option_name(r, class).unwrap_or_else(|| "Other".into()),
                        expense_ratio: amount(er.as_ref().and_then(|c| r.values.get(c)))
                            .map(|x| x / Decimal::ONE_HUNDRED),
                    },
                );
            }
        }
        if let Some(d) = dbs.get("inv_accounts") {
            let tt = d.keyed("tax_treatment", &["Tax treatment"]);
            let ty = d.keyed("type", &["Type"]);
            for r in &d.rows {
                let t = d
                    .option_name(r, tt)
                    .map(|n| treatment(Some(&n)))
                    .or_else(|| treatment_of_type(d.option_name(r, ty).as_deref()))
                    .unwrap_or_default();
                p.treatment.insert(r.id.clone(), t);
            }
        }
        if let Some(d) = dbs.get("investments") {
            let c = |role: &str, n: &str| d.col_id(role, &[n]);
            let (dt, sec, acct, qty, price, am, fees) = (
                c("inv.date", "Date"),
                c("inv.security", "Security"),
                c("inv.account", "Account"),
                c("inv.qty", "Quantity"),
                c("inv.price", "Price"),
                c("inv.amount", "Amount"),
                c("inv.fees", "Fees"),
            );
            let ty = d.col("inv.type", &["Type"]);
            let get = |r: &RowDto, c: &Option<String>| -> Option<CellValue> {
                c.as_ref().and_then(|c| r.values.get(c)).cloned()
            };
            for r in &d.rows {
                let (Some(date), Some(kind)) = (
                    date(get(r, &dt).as_ref()),
                    d.option_name(r, ty).and_then(|n| inv_type(&n)),
                ) else {
                    continue;
                };
                let security = rel(get(r, &sec).as_ref())
                    .and_then(|id| p.symbol_of.get(&id).cloned())
                    .unwrap_or_default();
                let quantity = amount(get(r, &qty).as_ref());
                p.txns.push(InvTxn {
                    id: r.id.clone(),
                    date,
                    kind,
                    account_id: rel(get(r, &acct).as_ref()).unwrap_or_default(),
                    security,
                    ratio: if kind == InvTxnType::Split {
                        quantity
                    } else {
                        None
                    },
                    qty: if kind == InvTxnType::Split {
                        None
                    } else {
                        quantity.map(|q| q.abs())
                    },
                    price: amount(get(r, &price).as_ref()),
                    amount: amount(get(r, &am).as_ref()),
                    fees: amount(get(r, &fees).as_ref()).unwrap_or_default().abs(),
                    acquired: None,
                    basis: None,
                });
            }
            p.txns
                .sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.id.cmp(&b.id)));
        }
        if let Some(d) = dbs.get("allocation") {
            let class = d.col("alloc.class", &["Class"]);
            let tg = d.col_id("alloc.target", &["Target %"]);
            let ba = d.col_id("alloc.band_abs", &["Band abs (pp)"]);
            let br = d.col_id("alloc.band_rel", &["Band rel (%)"]);
            let num = |r: &RowDto, c: &Option<String>| {
                amount(c.as_ref().and_then(|c| r.values.get(c))).map(to_f64)
            };
            for r in &d.rows {
                let Some(t) = num(r, &tg) else { continue };
                p.targets.push(Target {
                    asset_class: d.option_name(r, class).unwrap_or_else(|| d.title(r)),
                    target: t,
                    band_abs: num(r, &ba),
                    band_rel: num(r, &br).map(|x| x / 100.0),
                });
            }
        }
        p.lots_db = dbs.remove("lots");
        Ok(p)
    }

    /// Rebuilds the lot book (FIFO, US long-term threshold).
    #[must_use]
    pub fn book(&self) -> LotBook {
        emp_finance::portfolio::lots::rebuild(
            &self.txns,
            &RebuildOptions {
                long_term_days: emp_finance::portfolio::US_LONG_TERM_DAYS,
                ..RebuildOptions::default()
            },
        )
    }

    /// Symbols currently held.
    #[must_use]
    pub fn held(book: &LotBook) -> HashMap<String, Decimal> {
        let mut m: HashMap<String, Decimal> = HashMap::new();
        for l in &book.lots {
            *m.entry(l.security.clone()).or_default() += l.qty;
        }
        m.retain(|_, q| *q > Decimal::ZERO);
        m
    }
}

fn price_map(quotes: &[Quote]) -> HashMap<String, PriceQuote> {
    quotes
        .iter()
        .filter(|q| q.is_sane())
        .filter_map(|q| {
            Some((
                q.symbol.clone(),
                PriceQuote {
                    price: from_f64(q.price),
                    prev_close: q
                        .prev_close
                        .filter(|x| x.is_finite() && *x > 0.0)
                        .map(from_f64),
                    as_of: chrono::DateTime::from_timestamp_millis(q.as_of)?.date_naive(),
                },
            ))
        })
        .collect()
}

async fn load_with_quotes(
    app: &AppHandle,
    instance_id: &str,
) -> ApiResult<(
    PortfolioData,
    LotBook,
    HashMap<String, PriceQuote>,
    NaiveDate,
    Store,
)> {
    let (app2, id) = (app.clone(), instance_id.to_owned());
    let (data, book, today, store, router) = blocking(move || {
        let state = app2.state::<AppState>();
        let store = state.session()?;
        let data = PortfolioData::load(&store, &id)?;
        let book = data.book();
        let today = local_today(&store);
        // Valuation works offline from cost basis when no router is available.
        let router = super::market::router(&state).ok();
        Ok((data, book, today, store, router))
    })
    .await?;
    let symbols: Vec<String> = PortfolioData::held(&book)
        .into_keys()
        .take(MAX_SYMBOLS)
        .collect();
    let quotes = match router {
        Some(r) if !symbols.is_empty() => super::market::quotes_for(&r, &symbols).await,
        _ => Vec::new(),
    };
    Ok((data, book, price_map(&quotes), today, store))
}

// ───────────────────────────────────────────────────────────────────────────── rebuild

/// An `{ instanceId, onEvent }` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebuildReq {
    instance_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

fn computed(kind: ComputedKind, value: Value, display: String) -> CellValue {
    CellValue::Computed {
        v: ComputedValue {
            kind,
            value,
            display,
        },
    }
}

fn write_lots(
    store: &Store,
    db: &InstanceDb,
    data: &PortfolioData,
    book: &LotBook,
    today: NaiveDate,
) -> ApiResult<()> {
    let old: Vec<String> = db.rows.iter().map(|r| r.id.clone()).collect();
    for c in old.chunks(1_000) {
        store.db_rows_purge(c)?;
    }
    let sec = db.keyed_id("security", &["Security"]);
    let acct = db.keyed_id("account", &["Account"]);
    let acq = db.keyed_id("acquired", &["Acquired"]);
    let qty = db.keyed_id("qty", &["Quantity"]);
    let basis = db.keyed_id("basis", &["Cost basis"]);
    let term = db.keyed_id("term", &["Term"]);
    let row_of: HashMap<&str, &str> = data
        .symbol_of
        .iter()
        .map(|(row, sym)| (sym.as_str(), row.as_str()))
        .collect();
    let mut rows = Vec::new();
    for l in &book.lots {
        let mut v = BTreeMap::new();
        v.insert(
            db.title_id().to_owned(),
            CellValue::text(&format!("{} · {}", l.security, l.acquired)),
        );
        if let (Some(p), Some(r)) = (&sec, row_of.get(l.security.as_str())) {
            v.insert(
                p.clone(),
                CellValue::Relation {
                    v: vec![(*r).to_owned()],
                },
            );
        }
        if let (Some(p), false) = (&acct, l.account_id.is_empty()) {
            v.insert(
                p.clone(),
                CellValue::Relation {
                    v: vec![l.account_id.clone()],
                },
            );
        }
        if let Some(p) = &acq {
            v.insert(
                p.clone(),
                CellValue::Date {
                    v: Some(DateValue {
                        start: l.acquired.to_string(),
                        end: None,
                        time: false,
                        tz: None,
                    }),
                },
            );
        }
        rows.push(v);
    }
    let mut ids = Vec::new();
    for c in rows.chunks(1_000) {
        ids.extend(store.db_rows_insert_bulk(db.id(), c.to_vec(), None)?);
    }
    for (id, l) in ids.iter().zip(&book.lots) {
        if let Some(p) = &qty {
            store.db_row_set_computed(
                id,
                p,
                computed(
                    ComputedKind::Number,
                    json!(to_f64(l.qty)),
                    l.qty.normalize().to_string(),
                ),
            )?;
        }
        if let Some(p) = &basis {
            store.db_row_set_computed(
                id,
                p,
                computed(
                    ComputedKind::Money,
                    json!(l.basis.round_dp(2).to_string()),
                    l.basis.round_dp(2).to_string(),
                ),
            )?;
        }
        if let Some(p) = &term {
            let long = (today - l.acquired).num_days() > emp_finance::portfolio::US_LONG_TERM_DAYS;
            let t = if long { "Long" } else { "Short" };
            store.db_row_set_computed(id, p, computed(ComputedKind::Text, json!(t), t.into()))?;
        }
    }
    Ok(())
}

/// `portfolio_rebuild({ instanceId, onEvent })` (job) ⇒ `{ lots, realizedEvents }`: replays every investment
/// transaction into tax lots and rewrites the *Lots* database.
#[tauri::command]
pub async fn portfolio_rebuild(
    webview: Webview,
    state: State<'_, AppState>,
    req: RebuildReq,
) -> ApiResult<JobRef> {
    validate::id("instanceId", &req.instance_id)?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    Ok(state.jobs.spawn("portfolio_rebuild", true, store.now(), sink, move |ctx| {
        ctx.report(0, 3, Some("Loading"));
        let data = PortfolioData::load(&store, &req.instance_id)?;
        ctx.check_cancelled()?;
        ctx.report(1, 3, Some("Rebuilding lots"));
        let book = data.book();
        ctx.check_cancelled()?;
        ctx.report(2, 3, Some("Saving"));
        if let Some(db) = &data.lots_db {
            write_lots(&store, db, &data, &book, local_today(&store))?;
        }
        ctx.report(3, 3, Some("Done"));
        Ok(json!({ "lots": book.lots.len(), "realizedEvents": book.realized.len(), "warnings": book.warnings }))
    }))
}

// ───────────────────────────────────────────────────────────────────────────── summary

/// An `{ instanceId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceReq {
    instance_id: String,
}

/// One holding (IPC shape).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingDto {
    symbol: String,
    name: String,
    qty: String,
    price: Option<f64>,
    value: MoneyDto,
    cost_basis: MoneyDto,
    gain: MoneyDto,
    gain_pct: f64,
    weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    day_pct: Option<f64>,
    stale: bool,
    asset_class: String,
}

/// `portfolio_summary` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryDto {
    total_value: MoneyDto,
    day_change: MoneyDto,
    day_change_pct: f64,
    unrealized: MoneyDto,
    unrealized_pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    xirr_ytd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xirr_all: Option<f64>,
    div_ttm: MoneyDto,
    div_fwd12m: MoneyDto,
    max_drift: f64,
    fees_per_year: MoneyDto,
    holdings: Vec<HoldingDto>,
    allocation: Vec<Value>,
    as_of: i64,
}

/// Computes `portfolio_summary` from loaded data (pure).
#[must_use]
pub fn summarize(
    data: &PortfolioData,
    book: &LotBook,
    prices: &HashMap<String, PriceQuote>,
    today: NaiveDate,
    now_ms: i64,
) -> SummaryDto {
    let cur = data.currency.as_str();
    let v: Valuation =
        emp_finance::portfolio::holdings::value(book, prices, &data.securities, today);
    let mut by_class: BTreeMap<String, Decimal> = BTreeMap::new();
    for h in &v.holdings {
        *by_class.entry(h.asset_class.clone()).or_default() += h.value;
    }
    let alloc = emp_finance::portfolio::alloc::allocation(&by_class, &data.targets);
    let held = PortfolioData::held(book);
    let div = emp_finance::portfolio::dividends::summary(&book.income, &held, today);
    let contribs = emp_finance::portfolio::perf::contributions(&data.txns);
    let total = to_f64(v.total_value);
    let xirr_all = emp_finance::portfolio::perf::portfolio_xirr(&contribs, None, total, today);
    let ytd_start = NaiveDate::from_ymd_opt(today.year(), 1, 1);
    let start_value = ytd_start.map(|d| {
        // Value at the start of the year approximated by cost basis of lots acquired before it.
        let b: Decimal = book
            .lots
            .iter()
            .filter(|l| l.acquired < d)
            .map(|l| l.basis)
            .sum();
        (d, to_f64(b))
    });
    let xirr_ytd = start_value.filter(|(_, v0)| *v0 > 0.0).and_then(|s| {
        emp_finance::portfolio::perf::portfolio_xirr(&contribs, Some(s), total, today)
    });
    SummaryDto {
        total_value: MoneyDto::of(v.total_value, cur),
        day_change: MoneyDto::of(v.day_change, cur),
        day_change_pct: v.day_change_pct,
        unrealized: MoneyDto::of(v.unrealized, cur),
        unrealized_pct: if v.total_basis.is_zero() { 0.0 } else { to_f64(v.unrealized / v.total_basis) },
        xirr_ytd: xirr_ytd.filter(|x| x.is_finite()),
        xirr_all: xirr_all.filter(|x| x.is_finite()),
        div_ttm: MoneyDto::of(div.ttm, cur),
        div_fwd12m: MoneyDto::of(div.forward_12m, cur),
        max_drift: emp_finance::portfolio::alloc::max_drift(&alloc),
        fees_per_year: MoneyDto::of(v.fees_per_year, cur),
        holdings: v
            .holdings
            .iter()
            .map(|h| HoldingDto {
                symbol: h.symbol.clone(),
                name: h.name.clone(),
                qty: h.qty.normalize().to_string(),
                price: h.price.map(to_f64),
                value: MoneyDto::of(h.value, cur),
                cost_basis: MoneyDto::of(h.cost_basis, cur),
                gain: MoneyDto::of(h.gain, cur),
                gain_pct: h.gain_pct,
                weight: h.weight,
                day_pct: h.day_pct,
                stale: h.stale,
                asset_class: h.asset_class.clone(),
            })
            .collect(),
        allocation: alloc
            .iter()
            .map(|a| json!({ "assetClass": a.asset_class, "current": a.current, "target": a.target, "drift": a.drift, "status": a.status }))
            .collect(),
        as_of: now_ms,
    }
}

/// `portfolio_summary({ instanceId }) → { totalValue, dayChange, …, holdings, allocation, asOf }`.
#[tauri::command]
pub async fn portfolio_summary(app: AppHandle, req: InstanceReq) -> ApiResult<SummaryDto> {
    validate::id("instanceId", &req.instance_id)?;
    let (data, book, prices, today, store) = load_with_quotes(&app, &req.instance_id).await?;
    Ok(summarize(&data, &book, &prices, today, store.now()))
}

// ───────────────────────────────────────────────────────────────────────────── performance

/// `portfolio_performance` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceReq {
    instance_id: String,
    range: String,
    #[serde(default)]
    benchmark: Option<String>,
}

/// `portfolio_performance` result.
#[derive(Debug, Default, Serialize)]
pub struct PerformanceDto {
    t: Vec<i64>,
    value: Vec<f64>,
    contributions: Vec<f64>,
    twr: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    benchmark: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xirr: Option<f64>,
}

/// The first day of a performance range.
pub fn range_start(
    range: &str,
    today: NaiveDate,
    first: Option<NaiveDate>,
) -> ApiResult<NaiveDate> {
    let months = |n: i32| emp_finance::period::add_months(today, -n);
    Ok(match range {
        "1m" => months(1),
        "3m" => months(3),
        "ytd" => NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today),
        "1y" => months(12),
        "5y" => months(60),
        "all" => first.unwrap_or(today),
        _ => {
            return Err(ApiError::invalid(
                "range",
                "must be 1m, 3m, ytd, 1y, 5y or all",
            ));
        }
    })
}

/// Quantity of each symbol held at the end of each day in `days` (replaying buys, sells, transfers and splits).
#[must_use]
pub fn positions_by_day(txns: &[InvTxn], days: &[NaiveDate]) -> Vec<HashMap<String, Decimal>> {
    let mut out = Vec::with_capacity(days.len());
    let mut pos: HashMap<String, Decimal> = HashMap::new();
    let mut i = 0;
    for d in days {
        while i < txns.len() && txns[i].date <= *d {
            let t = &txns[i];
            let q = t.qty.unwrap_or_default();
            let e = pos.entry(t.security.clone()).or_default();
            match t.kind {
                InvTxnType::Buy | InvTxnType::Reinvest | InvTxnType::TransferIn => *e += q,
                InvTxnType::Sell | InvTxnType::TransferOut => *e = (*e - q).max(Decimal::ZERO),
                InvTxnType::Split => {
                    if let Some(r) = t.ratio.filter(|r| *r > Decimal::ZERO) {
                        *e *= r;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        out.push(pos.clone());
    }
    out
}

/// `portfolio_performance({ instanceId, range, benchmark? }) → { t, value, contributions, twr, benchmark?, xirr? }`
/// from daily closes (cached closed bars; NetGuard for the rest).
#[tauri::command]
pub async fn portfolio_performance(
    app: AppHandle,
    req: PerformanceReq,
) -> ApiResult<PerformanceDto> {
    validate::id("instanceId", &req.instance_id)?;
    let bench = req
        .benchmark
        .as_deref()
        .map(|b| super::market::symbol_key("benchmark", b))
        .transpose()?;
    let app2 = app.clone();
    let id = req.instance_id.clone();
    let (data, today, router) = blocking(move || {
        let state = app2.state::<AppState>();
        let store = state.session()?;
        let data = PortfolioData::load(&store, &id)?;
        Ok((data, local_today(&store), super::market::router(&state)?))
    })
    .await?;
    let first = data.txns.first().map(|t| t.date);
    let from = range_start(&req.range, today, first)?;
    if from >= today {
        return Ok(PerformanceDto::default());
    }
    let mut symbols: Vec<String> = data
        .txns
        .iter()
        .map(|t| t.security.clone())
        .filter(|s| !s.is_empty())
        .collect();
    symbols.sort();
    symbols.dedup();
    symbols.truncate(MAX_HISTORY_SYMBOLS);
    let mut closes: HashMap<String, BTreeMap<NaiveDate, f64>> = HashMap::new();
    for s in &symbols {
        if let Ok(series) = router
            .bars(s, BarInterval::Day, from, today, true, &BTreeMap::new())
            .await
        {
            closes.insert(
                s.clone(),
                series.bars.iter().map(|b| (b.date, b.close)).collect(),
            );
        }
    }
    let mut days: Vec<NaiveDate> = closes.values().flat_map(|m| m.keys().copied()).collect();
    days.sort();
    days.dedup();
    if days.is_empty() {
        return Ok(PerformanceDto::default());
    }
    let positions = positions_by_day(&data.txns, &days);
    let mut last: HashMap<&str, f64> = HashMap::new();
    let mut values = Vec::with_capacity(days.len());
    for (d, pos) in days.iter().zip(&positions) {
        let mut v = 0.0;
        for (sym, q) in pos {
            if let Some(c) = closes.get(sym).and_then(|m| m.get(d)) {
                last.insert(sym.as_str(), *c);
            }
            if let Some(p) = last.get(sym.as_str()) {
                v += to_f64(*q) * p;
            }
        }
        values.push((*d, v));
    }
    let flows: Vec<(NaiveDate, f64)> = emp_finance::portfolio::perf::contributions(&data.txns)
        .into_iter()
        .filter(|(d, _)| *d >= from && *d <= today)
        .collect();
    let twr = emp_finance::portfolio::perf::twr(&values, &flows);
    let mut cum = 0.0;
    let mut fi = 0;
    let contributions: Vec<f64> = days
        .iter()
        .map(|d| {
            while fi < flows.len() && flows[fi].0 <= *d {
                cum += flows[fi].1;
                fi += 1;
            }
            cum
        })
        .collect();
    let twr_by_day: HashMap<NaiveDate, f64> =
        twr.t.iter().copied().zip(twr.twr.iter().copied()).collect();
    let benchmark = match &bench {
        Some(b) => router
            .bars(b, BarInterval::Day, from, today, true, &BTreeMap::new())
            .await
            .ok()
            .map(|s| {
                let m: BTreeMap<NaiveDate, f64> =
                    s.bars.iter().map(|x| (x.date, x.close)).collect();
                let base = m.values().next().copied().filter(|x| *x > 0.0);
                let mut lastb = None;
                days.iter()
                    .map(|d| {
                        if let Some(c) = m.get(d) {
                            lastb = Some(*c);
                        }
                        match (lastb, base) {
                            (Some(c), Some(b)) => c / b - 1.0,
                            _ => 0.0,
                        }
                    })
                    .collect()
            }),
        None => None,
    };
    let start_value = values.first().filter(|(_, v)| *v > 0.0).copied();
    let end = values.last().map_or(0.0, |x| x.1);
    let xirr = emp_finance::portfolio::perf::portfolio_xirr(&flows, start_value, end, today)
        .filter(|x| x.is_finite());
    Ok(PerformanceDto {
        t: days
            .iter()
            .map(|d| emp_integrations::market::date_to_millis(*d))
            .collect(),
        value: values.iter().map(|x| x.1).collect(),
        contributions,
        twr: days
            .iter()
            .map(|d| twr_by_day.get(d).copied().unwrap_or(0.0))
            .collect(),
        benchmark,
        xirr,
    })
}

// ───────────────────────────────────────────────────────────────────────────── rebalance

/// `portfolio_rebalance_plan` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebalanceReq {
    instance_id: String,
    new_cash: String,
    allow_taxable_sells: bool,
    min_trade: String,
    fractional: bool,
}

/// `portfolio_rebalance_plan({ instanceId, newCash, allowTaxableSells, minTrade, fractional }) → { trades, after,
/// estRealizedGain }` (proposals only; EMP never trades).
#[tauri::command]
pub async fn portfolio_rebalance_plan(app: AppHandle, req: RebalanceReq) -> ApiResult<Value> {
    validate::id("instanceId", &req.instance_id)?;
    let new_cash = dec("newCash", &req.new_cash)?;
    let min_trade = dec("minTrade", &req.min_trade)?;
    let (data, book, prices, _, _) = load_with_quotes(&app, &req.instance_id).await?;
    let mut by: BTreeMap<(String, String), Vec<emp_finance::portfolio::lots::Lot>> =
        BTreeMap::new();
    for l in &book.lots {
        by.entry((l.account_id.clone(), l.security.clone()))
            .or_default()
            .push(l.clone());
    }
    let positions: Vec<_> = by
        .into_iter()
        .filter_map(|((account_id, symbol), lots)| {
            let price = prices.get(&symbol).map(|p| p.price)?;
            Some(emp_finance::portfolio::rebalance::RebalancePosition {
                asset_class: data
                    .securities
                    .get(&symbol)
                    .map_or_else(|| "Other".into(), |s| s.asset_class.clone()),
                qty: lots.iter().map(|l| l.qty).sum(),
                account_id,
                symbol,
                price,
                lots,
            })
        })
        .collect();
    let opts = emp_finance::portfolio::rebalance::RebalanceOptions {
        new_cash,
        cash_account: None,
        allow_taxable_sells: req.allow_taxable_sells,
        min_trade,
        fractional: req.fractional,
        class_proxies: BTreeMap::new(),
        proxy_prices: BTreeMap::new(),
    };
    let plan =
        emp_finance::portfolio::rebalance::plan(&positions, &data.treatment, &data.targets, &opts)
            .map_err(fin_err)?;
    Ok(json!({
        "trades": plan.trades.iter().map(|t| json!({
            "accountId": t.account_id, "symbol": t.symbol, "side": t.side, "qty": t.qty.normalize().to_string(),
            "amount": t.amount.round_dp(2).to_string(),
            "estRealizedGain": t.est_realized_gain.map(|g| g.round_dp(2).to_string()),
        })).collect::<Vec<_>>(),
        "after": plan.after,
        "estRealizedGain": plan.est_realized_gain.round_dp(2).to_string(),
        "stillOutside": plan.still_outside,
    }))
}

// ───────────────────────────────────────────────────────────────────────────── dividends, realised

/// An `{ instanceId, year }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct YearReq {
    instance_id: String,
    year: i32,
}

fn year(y: i32) -> ApiResult<()> {
    if (1900..=2200).contains(&y) {
        Ok(())
    } else {
        Err(ApiError::invalid("year", "invalid year"))
    }
}

/// `portfolio_dividends({ instanceId, year }) → { month, paid, projected }[]`.
#[tauri::command]
pub async fn portfolio_dividends(app: AppHandle, req: YearReq) -> ApiResult<Vec<Value>> {
    validate::id("instanceId", &req.instance_id)?;
    year(req.year)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let data = PortfolioData::load(&store, &req.instance_id)?;
        let book = data.book();
        let held = PortfolioData::held(&book);
        Ok(emp_finance::portfolio::dividends::calendar(&book.income, &held, req.year, local_today(&store))
            .into_iter()
            .map(|m| json!({ "month": m.month.to_string(), "paid": m.paid.round_dp(2).to_string(), "projected": m.projected.round_dp(2).to_string() }))
            .collect())
    })
    .await
}

/// `portfolio_realized({ instanceId, year }) → { lots, totals: { short, long } }`.
#[tauri::command]
pub async fn portfolio_realized(app: AppHandle, req: YearReq) -> ApiResult<Value> {
    validate::id("instanceId", &req.instance_id)?;
    year(req.year)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let data = PortfolioData::load(&store, &req.instance_id)?;
        let book = data.book();
        let (mut short, mut long) = (Decimal::ZERO, Decimal::ZERO);
        let lots: Vec<Value> = book
            .realized
            .iter()
            .filter(|r| r.sold.year() == req.year)
            .map(|r| {
                match r.term {
                    emp_finance::portfolio::lots::Term::Short => short += r.gain,
                    emp_finance::portfolio::lots::Term::Long => long += r.gain,
                }
                json!({
                    "symbol": r.symbol, "acquired": r.acquired.to_string(), "sold": r.sold.to_string(),
                    "qty": r.qty.normalize().to_string(), "proceeds": r.proceeds.round_dp(2).to_string(),
                    "basis": r.basis.round_dp(2).to_string(), "gain": r.gain.round_dp(2).to_string(), "term": r.term,
                })
            })
            .collect();
        Ok(json!({ "lots": lots, "totals": { "short": short.round_dp(2).to_string(), "long": long.round_dp(2).to_string() } }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn txn(id: &str, date: &str, kind: InvTxnType, qty: &str, price: &str) -> InvTxn {
        InvTxn {
            id: id.into(),
            date: d(date),
            kind,
            account_id: "acct".into(),
            security: "VTI:ARCX".into(),
            qty: Some(qty.parse().unwrap()),
            price: Some(price.parse().unwrap()),
            amount: None,
            fees: Decimal::ZERO,
            ratio: None,
            acquired: None,
            basis: None,
        }
    }

    #[test]
    fn option_names_map_to_types() {
        assert_eq!(inv_type("Transfer in"), Some(InvTxnType::TransferIn));
        assert_eq!(
            inv_type("Return of capital"),
            Some(InvTxnType::ReturnOfCapital)
        );
        assert_eq!(inv_type("Nonsense"), None);
        assert_eq!(treatment(Some("Tax-deferred")), TaxTreatment::Deferred);
        assert_eq!(
            treatment_of_type(Some("Roth IRA")),
            Some(TaxTreatment::Free)
        );
        assert_eq!(
            treatment_of_type(Some("401(k)")),
            Some(TaxTreatment::Deferred)
        );
    }

    #[test]
    fn positions_replay_by_day() {
        let txns = vec![
            txn("1", "2026-01-02", InvTxnType::Buy, "10", "100"),
            txn("2", "2026-01-05", InvTxnType::Sell, "4", "110"),
        ];
        let days = [d("2026-01-01"), d("2026-01-02"), d("2026-01-06")];
        let p = positions_by_day(&txns, &days);
        assert!(p[0].is_empty());
        assert_eq!(p[1]["VTI:ARCX"], Decimal::from(10));
        assert_eq!(p[2]["VTI:ARCX"], Decimal::from(6));
    }

    #[test]
    fn summary_values_lots_at_quotes() {
        let mut data = PortfolioData {
            currency: "USD".into(),
            ..PortfolioData::default()
        };
        data.txns = vec![txn("1", "2025-01-02", InvTxnType::Buy, "10", "100")];
        data.securities.insert(
            "VTI:ARCX".into(),
            SecurityInfo {
                symbol: "VTI:ARCX".into(),
                name: "Total market".into(),
                asset_class: "US equity".into(),
                expense_ratio: None,
            },
        );
        data.targets = vec![Target {
            asset_class: "US equity".into(),
            target: 100.0,
            band_abs: None,
            band_rel: None,
        }];
        let book = data.book();
        let mut prices = HashMap::new();
        prices.insert(
            "VTI:ARCX".to_owned(),
            PriceQuote {
                price: Decimal::from(120),
                prev_close: Some(Decimal::from(118)),
                as_of: d("2026-11-26"),
            },
        );
        let s = summarize(&data, &book, &prices, d("2026-11-26"), 0);
        assert_eq!(s.total_value.amount, "1200");
        assert_eq!(s.unrealized.amount, "200");
        assert_eq!(s.holdings.len(), 1);
        assert!(s.max_drift.abs() < 1e-9);
    }

    #[test]
    fn ranges_are_validated() {
        let today = d("2026-11-26");
        assert_eq!(range_start("ytd", today, None).unwrap(), d("2026-01-01"));
        assert_eq!(range_start("1y", today, None).unwrap(), d("2025-11-26"));
        assert_eq!(
            range_start("all", today, Some(d("2020-01-01"))).unwrap(),
            d("2020-01-01")
        );
        assert!(range_start("2w", today, None).is_err());
    }

    #[test]
    fn loads_a_portfolio_instance() {
        let (_dir, store) = super::super::finance::test_support::temp_store();
        let (_, inst) = super::super::finance::test_support::install(&store, "portfolio");
        let data = PortfolioData::load(&store, &inst).unwrap();
        assert!(!data.securities.is_empty(), "securities");
        assert!(!data.txns.is_empty(), "investment transactions");
        let book = data.book();
        assert!(!book.lots.is_empty(), "lots");
        let s = summarize(&data, &book, &HashMap::new(), local_today(&store), 0);
        assert!(!s.holdings.is_empty());
        if let Some(db) = &data.lots_db {
            write_lots(&store, db, &data, &book, local_today(&store)).unwrap();
            assert_eq!(
                super::super::db::all_rows(&store, db.id(), None)
                    .unwrap()
                    .len(),
                book.lots.len()
            );
        }
    }
}
