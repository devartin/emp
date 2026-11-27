//! Portfolio commands (SPEC §11.3 "Portfolio and tax", §15.7, §16.3).
//!
//! Loads a Portfolio instance's databases by role (§15.0) — investment transactions (`inv.*`), securities (`sec.*`),
//! target allocation (`alloc.*`) and the investment accounts — rebuilds tax lots with `emp-finance`, values them with
//! quotes from the market router (cache first, NetGuard + offline mode for misses) and derives performance,
//! rebalancing, dividends and realised gains. `portfolio_rebuild` writes the lots back into the *Lots* database.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock};

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
    InstanceDb, MoneyDto, OptionKeys, amount, date, dec, fin_err, instance_layout, load_instance,
    local_today, norm, option_cell, option_for_key, option_key, rel, text,
};
use super::job_sink;
use crate::error::{ApiError, ApiResult};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;
use parking_lot::Mutex;

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
    /// Investment accounts in database order.
    pub accounts: Vec<PfAccount>,
    /// Database ids by key (`inv_accounts`, `securities`, `investments`, `allocation`, `lots`).
    pub db_ids: BTreeMap<String, String>,
}

/// An investment account.
#[derive(Clone, Debug)]
pub struct PfAccount {
    /// Row id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Account type key (`taxable`, `roth_ira`, `401k`, …).
    pub kind: String,
    /// Tax treatment.
    pub treatment: TaxTreatment,
}

/// Investment account types.
pub const IACCT_TYPES: OptionKeys = &[
    ("401k", &["401(k)"]),
    ("403b", &["403(b)"]),
    ("ira", &["Traditional IRA", "IRA"]),
    ("roth_ira", &["Roth IRA"]),
    ("hsa", &["HSA"]),
    ("taxable", &["Taxable brokerage", "Brokerage"]),
    ("529", &["529 plan"]),
    ("crypto", &[]),
    ("pension", &[]),
    ("other", &[]),
];
/// Tax treatments.
pub const TREATMENTS: OptionKeys = &[
    ("taxable", &[]),
    ("deferred", &["Tax-deferred", "Tax deferred"]),
    ("free", &["Tax-free", "Tax free"]),
];
/// Asset classes.
pub const ASSET_CLASSES: OptionKeys = &[
    ("us_equity", &["US stocks"]),
    ("intl_developed", &["International"]),
    ("emerging", &["Emerging markets"]),
    ("bonds", &[]),
    ("inflation_linked", &[]),
    ("reit", &[]),
    ("cash", &[]),
    ("crypto", &[]),
    ("other", &[]),
];
/// Investment transaction types.
pub const INV_TYPES: OptionKeys = &[
    ("buy", &[]),
    ("sell", &[]),
    ("dividend", &[]),
    ("reinvest", &["Reinvested dividend"]),
    ("fee", &[]),
    ("split", &[]),
    ("transfer_in", &[]),
    ("transfer_out", &[]),
    ("return_of_capital", &[]),
    ("interest", &[]),
];

/// Revision fingerprint of a Portfolio instance (see `Ledger::load`).
type PfKey = (Vec<(String, String, i64, i64)>, String);

/// Cached Portfolio data by instance id.
type PfCache = HashMap<String, (PfKey, Arc<PortfolioData>)>;

/// Portfolio data built this session, by instance id; valid while the instance's databases are unchanged.
static PORTFOLIOS: LazyLock<Mutex<PfCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Drops every cached Portfolio (vault lock).
pub fn clear_portfolio_cache() {
    PORTFOLIOS.lock().clear();
}

fn treatment_of_key(k: &str) -> TaxTreatment {
    match k {
        "deferred" => TaxTreatment::Deferred,
        "free" => TaxTreatment::Free,
        _ => TaxTreatment::Taxable,
    }
}

/// The key of a tax treatment.
#[must_use]
pub fn treatment_key(t: TaxTreatment) -> &'static str {
    match t {
        TaxTreatment::Taxable => "taxable",
        TaxTreatment::Deferred => "deferred",
        TaxTreatment::Free => "free",
    }
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
    /// The Portfolio instance `instance_id`, from the session cache while its databases are unchanged.
    pub fn load(store: &Store, instance_id: &str) -> ApiResult<Arc<Self>> {
        let lay = instance_layout(store, instance_id)?;
        let currency = store
            .vault_settings()
            .map(|v| v.base_currency)
            .unwrap_or_else(|_| "USD".into());
        let key: PfKey = (
            lay.dbs
                .iter()
                .map(|(k, s, _)| {
                    (
                        k.clone(),
                        s.database.id.clone(),
                        s.database.data_rev,
                        s.database.schema_rev,
                    )
                })
                .collect(),
            currency.clone(),
        );
        if let Some((k, d)) = PORTFOLIOS.lock().get(instance_id)
            && *k == key
        {
            return Ok(Arc::clone(d));
        }
        let (_, dbs) = load_instance(store, instance_id)?;
        let d = Arc::new(Self::build(dbs, currency));
        let mut cache = PORTFOLIOS.lock();
        if cache.len() >= 8 && !cache.contains_key(instance_id) {
            cache.clear();
        }
        cache.insert(instance_id.to_owned(), (key, Arc::clone(&d)));
        Ok(d)
    }

    /// Builds the Portfolio inputs from loaded databases.
    #[must_use]
    pub fn build(mut dbs: BTreeMap<String, InstanceDb>, currency: String) -> Self {
        let mut p = PortfolioData {
            currency,
            db_ids: dbs
                .iter()
                .map(|(k, d)| (k.clone(), d.id().to_owned()))
                .collect(),
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
                let t = option_key(r, tt, TREATMENTS)
                    .map(|k| treatment_of_key(&k))
                    .or_else(|| d.option_name(r, tt).map(|n| treatment(Some(&n))))
                    .or_else(|| treatment_of_type(d.option_name(r, ty).as_deref()))
                    .unwrap_or_default();
                p.treatment.insert(r.id.clone(), t);
                p.accounts.push(PfAccount {
                    id: r.id.clone(),
                    name: Some(d.title(r))
                        .filter(|n| !n.trim().is_empty())
                        .unwrap_or_else(|| "Account".into()),
                    kind: option_key(r, ty, IACCT_TYPES).unwrap_or_else(|| "taxable".into()),
                    treatment: t,
                });
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
        p
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
    Arc<PortfolioData>,
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
    /// The investment account that receives the new cash (default: the first taxable account, else the first).
    #[serde(default)]
    cash_account_id: Option<String>,
}

/// `portfolio_rebalance_plan({ instanceId, newCash, allowTaxableSells, minTrade, fractional }) → { trades, after,
/// estRealizedGain }` (proposals only; EMP never trades).
#[tauri::command]
pub async fn portfolio_rebalance_plan(app: AppHandle, req: RebalanceReq) -> ApiResult<Value> {
    validate::id("instanceId", &req.instance_id)?;
    let new_cash = dec("newCash", &req.new_cash)?;
    let min_trade = dec("minTrade", &req.min_trade)?;
    validate::opt_id("cashAccountId", req.cash_account_id.as_deref())?;
    let (data, book, prices, _, _) = load_with_quotes(&app, &req.instance_id).await?;
    let cash_account = match &req.cash_account_id {
        Some(id) if data.accounts.iter().any(|a| &a.id == id) => Some(id.clone()),
        Some(_) => {
            return Err(ApiError::invalid(
                "cashAccountId",
                "unknown investment account",
            ));
        }
        None => data
            .accounts
            .iter()
            .find(|a| a.treatment == TaxTreatment::Taxable)
            .or(data.accounts.first())
            .map(|a| a.id.clone()),
    };
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
            // Without a quote (offline), a position is valued at its average cost, as `portfolio_summary` does.
            let qty: Decimal = lots.iter().map(|l| l.qty).sum();
            let basis: Decimal = lots.iter().map(|l| l.basis).sum();
            let price = prices
                .get(&symbol)
                .map(|p| p.price)
                .or_else(|| (qty > Decimal::ZERO).then(|| basis / qty))?;
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
        cash_account,
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

// ───────────────────────────────────────────────────────────────────────────── book view and trades (ULTRANOTE-1.0 §5)

/// Investment transactions listed by [`portfolio_book`] (newest first).
pub const MAX_BOOK_TXNS: usize = 500;

/// `PortfolioBook.dbs`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDbsDto {
    accounts: Option<String>,
    securities: Option<String>,
    transactions: Option<String>,
    targets: Option<String>,
}

/// An investment account of the book.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookAccountDto {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    tax: &'static str,
}

/// A security of the book.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSecurityDto {
    id: String,
    symbol: String,
    name: String,
    asset_class: String,
}

/// An open tax lot.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookLotDto {
    symbol: String,
    account_id: String,
    account_name: String,
    tax_treatment: &'static str,
    acquired: String,
    qty: String,
    cost_per_unit: String,
    basis: String,
}

/// A dividend or interest payment.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookIncomeDto {
    id: String,
    date: String,
    symbol: String,
    account_id: String,
    amount: String,
    kind: String,
    reinvested: bool,
    tax_treatment: &'static str,
}

/// An investment transaction.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTxnDto {
    id: String,
    date: String,
    #[serde(rename = "type")]
    kind: String,
    symbol: String,
    name: String,
    account_id: String,
    qty: Option<String>,
    price: Option<String>,
    amount: Option<String>,
    fees: String,
}

/// `portfolio_book` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDto {
    currency: String,
    dbs: BookDbsDto,
    accounts: Vec<BookAccountDto>,
    securities: Vec<BookSecurityDto>,
    lots: Vec<BookLotDto>,
    income: Vec<BookIncomeDto>,
    txns: Vec<BookTxnDto>,
    warnings: Vec<String>,
}

fn kind_key(k: InvTxnType) -> String {
    serde_json::to_value(k)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn dp(d: Decimal, places: u32) -> String {
    d.round_dp(places).normalize().to_string()
}

/// Money with exactly two decimals ("2000.00"), as the browser mock's `centsToStr`.
fn m2(d: Decimal) -> String {
    let mut d = d.round_dp(2);
    d.rescale(2);
    d.to_string()
}

/// `portfolio_book` over loaded data (pure): accounts, securities, open FIFO lots, income and the latest
/// transactions — what the Holdings, holding page, rebalance and Taxes views read instead of whole databases.
#[must_use]
pub fn book_view(data: &PortfolioData) -> BookDto {
    let book = data.book();
    let acct: HashMap<&str, &PfAccount> =
        data.accounts.iter().map(|a| (a.id.as_str(), a)).collect();
    let tax = |id: &str| treatment_key(data.treatment.get(id).copied().unwrap_or_default());
    let sec_name = |k: &str| {
        data.securities
            .get(k)
            .map(|s| s.name.clone())
            .unwrap_or_default()
    };
    let mut securities: Vec<BookSecurityDto> = data
        .symbol_of
        .iter()
        .filter_map(|(id, key)| {
            let s = data.securities.get(key)?;
            Some(BookSecurityDto {
                id: id.clone(),
                symbol: key.clone(),
                name: s.name.clone(),
                asset_class: s.asset_class.clone(),
            })
        })
        .collect();
    securities.sort_by(|a, b| a.symbol.cmp(&b.symbol));
    BookDto {
        currency: data.currency.clone(),
        dbs: BookDbsDto {
            accounts: data.db_ids.get("inv_accounts").cloned(),
            securities: data.db_ids.get("securities").cloned(),
            transactions: data.db_ids.get("investments").cloned(),
            targets: data.db_ids.get("allocation").cloned(),
        },
        accounts: data
            .accounts
            .iter()
            .map(|a| BookAccountDto {
                id: a.id.clone(),
                name: a.name.clone(),
                kind: a.kind.clone(),
                tax: treatment_key(a.treatment),
            })
            .collect(),
        securities,
        lots: book
            .lots
            .iter()
            .filter(|l| l.qty > Decimal::ZERO)
            .map(|l| BookLotDto {
                symbol: l.security.clone(),
                account_id: l.account_id.clone(),
                account_name: acct
                    .get(l.account_id.as_str())
                    .map(|a| a.name.clone())
                    .unwrap_or_default(),
                tax_treatment: tax(&l.account_id),
                acquired: l.acquired.to_string(),
                qty: dp(l.qty, 8),
                cost_per_unit: dp(l.unit_basis(), 4),
                basis: m2(l.basis),
            })
            .collect(),
        income: book
            .income
            .iter()
            .map(|i| BookIncomeDto {
                id: i.txn_id.clone(),
                date: i.date.to_string(),
                symbol: i.security.clone(),
                account_id: i.account_id.clone(),
                amount: m2(i.amount),
                kind: kind_key(i.kind),
                reinvested: i.reinvested,
                tax_treatment: tax(&i.account_id),
            })
            .collect(),
        txns: data
            .txns
            .iter()
            .rev()
            .take(MAX_BOOK_TXNS)
            .map(|t| BookTxnDto {
                id: t.id.clone(),
                date: t.date.to_string(),
                kind: kind_key(t.kind),
                symbol: t.security.clone(),
                name: sec_name(&t.security),
                account_id: t.account_id.clone(),
                qty: t.qty.or(t.ratio).map(|q| dp(q, 8)),
                price: t.price.map(|p| dp(p, 4)),
                amount: t.amount.map(m2),
                fees: m2(t.fees),
            })
            .collect(),
        warnings: book.warnings,
    }
}

/// `portfolio_book({ instanceId }) → PortfolioBook`.
#[tauri::command]
pub async fn portfolio_book(app: AppHandle, req: InstanceReq) -> ApiResult<BookDto> {
    validate::id("instanceId", &req.instance_id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let data = PortfolioData::load(&store, &req.instance_id)?;
        Ok(book_view(&data))
    })
    .await
}

/// `portfolio_trade` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TradeReq {
    instance_id: String,
    date: String,
    /// `buy`, `sell`, `dividend`, `interest`, `reinvest` or `fee`.
    #[serde(rename = "type")]
    kind: String,
    /// Ticker (`VTI`, `VTI:ARCX`); optional for interest and fees.
    #[serde(default)]
    symbol: Option<String>,
    /// Name for a new security.
    #[serde(default)]
    name: Option<String>,
    /// Asset-class key for a new security (default `us_equity`).
    #[serde(default)]
    asset_class: Option<String>,
    /// Investment account (default: the first one, created as "Brokerage" when there is none).
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    qty: Option<String>,
    #[serde(default)]
    price: Option<String>,
    /// Cash amount (dividends, interest, fees; trades default to quantity × price).
    #[serde(default)]
    amount: Option<String>,
    #[serde(default)]
    fees: Option<String>,
}

/// `portfolio_trade` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeDto {
    /// The transaction row.
    pub id: String,
    /// The account it went into.
    pub account_id: String,
    /// The security row (none for interest and fees without a ticker).
    pub security_id: Option<String>,
}

fn money_cell(d: Decimal, cur: &str) -> CellValue {
    CellValue::Money {
        v: Some(d.round_dp(4).normalize().to_string()),
        cur: cur.to_owned(),
    }
}

/// `portfolio_trade` (testable body).
pub fn trade(store: &Store, req: &TradeReq) -> ApiResult<TradeDto> {
    let kind = req.kind.as_str();
    if !["buy", "sell", "dividend", "interest", "reinvest", "fee"].contains(&kind) {
        return Err(ApiError::invalid(
            "type",
            "must be buy, sell, dividend, interest, reinvest or fee",
        ));
    }
    let day = validate::ymd("date", &req.date)?;
    let opt_dec = |field: &str, v: &Option<String>| -> ApiResult<Option<Decimal>> {
        v.as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| dec(field, s))
            .transpose()
    };
    let qty = opt_dec("qty", &req.qty)?;
    let price = opt_dec("price", &req.price)?;
    let cash = opt_dec("amount", &req.amount)?;
    let fees = opt_dec("fees", &req.fees)?.unwrap_or_default();
    if fees < Decimal::ZERO {
        return Err(ApiError::invalid("fees", "must not be negative"));
    }
    let trades = matches!(kind, "buy" | "sell" | "reinvest");
    if trades && !qty.is_some_and(|q| q > Decimal::ZERO) {
        return Err(ApiError::invalid("qty", "enter how many shares"));
    }
    if trades && !price.is_some_and(|p| p >= Decimal::ZERO) {
        return Err(ApiError::invalid("price", "enter the price per share"));
    }
    if !trades && !cash.is_some_and(|a| a > Decimal::ZERO) {
        return Err(ApiError::invalid("amount", "enter the amount"));
    }
    let symbol = req
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let key = match symbol {
        Some(s) => {
            Some(symbol_key(s).ok_or_else(|| ApiError::invalid("symbol", "not a ticker symbol"))?)
        }
        None if matches!(kind, "interest" | "fee") => None,
        None => return Err(ApiError::invalid("symbol", "enter a ticker symbol")),
    };
    let data = PortfolioData::load(store, &req.instance_id)?;
    let (_, dbs) = load_instance(store, &req.instance_id)?;
    let cur = data.currency.clone();
    let inv = dbs
        .get("investments")
        .ok_or_else(|| ApiError::not_found("investment transactions database"))?;
    // The account.
    let account_id = match &req.account_id {
        Some(id) => {
            if !data.accounts.iter().any(|a| &a.id == id) {
                return Err(ApiError::invalid("accountId", "unknown investment account"));
            }
            id.clone()
        }
        None => match data.accounts.first() {
            Some(a) => a.id.clone(),
            None => {
                let d = dbs
                    .get("inv_accounts")
                    .ok_or_else(|| ApiError::not_found("investment accounts database"))?;
                let mut v = BTreeMap::new();
                v.insert(d.title_id().to_owned(), CellValue::text("Brokerage"));
                if let Some(p) = d.keyed("type", &["Type"])
                    && let Some(o) = option_for_key(p, "taxable", IACCT_TYPES)
                {
                    v.insert(p.id.clone(), option_cell(p, o));
                }
                if let Some(p) = d.keyed("tax_treatment", &["Tax treatment"])
                    && let Some(o) = option_for_key(p, "taxable", TREATMENTS)
                {
                    v.insert(p.id.clone(), option_cell(p, o));
                }
                store
                    .db_rows_insert_bulk(d.id(), vec![v], None)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| ApiError::internal("account not created"))?
            }
        },
    };
    // Selling more than is held would leave the lots inconsistent.
    if kind == "sell"
        && let (Some(k), Some(q)) = (&key, qty)
    {
        let held = data
            .book()
            .positions()
            .get(&(account_id.clone(), k.clone()))
            .copied()
            .unwrap_or_default();
        if q > held {
            return Err(ApiError::invalid(
                "qty",
                format!("this account holds {} shares", held.normalize()),
            ));
        }
    }
    // The security.
    let security_id = match &key {
        None => None,
        Some(k) => match data.symbol_of.iter().find(|(_, v)| *v == k) {
            Some((id, _)) => Some(id.clone()),
            None => {
                let d = dbs
                    .get("securities")
                    .ok_or_else(|| ApiError::not_found("securities database"))?;
                let raw = symbol.unwrap_or_default().to_uppercase();
                let mut v = BTreeMap::new();
                let name = req
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .unwrap_or(&raw)
                    .to_owned();
                validate::title("name", &name)?;
                v.insert(d.title_id().to_owned(), CellValue::text(&name));
                if let Some(p) = d.col_id("sec.ticker", &["Ticker"]) {
                    v.insert(
                        p,
                        CellValue::Ticker {
                            v: Some(raw.clone()),
                        },
                    );
                }
                let class = req.asset_class.as_deref().unwrap_or("us_equity");
                if let Some(p) = d.col("sec.class", &["Asset class"])
                    && let Some(o) = option_for_key(p, class, ASSET_CLASSES)
                {
                    v.insert(p.id.clone(), option_cell(p, o));
                }
                store
                    .db_rows_insert_bulk(d.id(), vec![v], None)?
                    .into_iter()
                    .next()
            }
        },
    };
    let c = |role: &str, n: &str| inv.col_id(role, &[n]);
    let mut v = BTreeMap::new();
    let label = key
        .as_deref()
        .map(|k| k.split(':').next().unwrap_or(k).to_owned())
        .unwrap_or_else(|| "cash".into());
    let verb = match kind {
        "buy" => "Buy",
        "sell" => "Sell",
        "dividend" => "Dividend",
        "interest" => "Interest",
        "reinvest" => "Reinvest",
        _ => "Fee",
    };
    v.insert(
        inv.title_id().to_owned(),
        CellValue::text(&format!("{verb} {label}")),
    );
    if let Some(p) = c("inv.date", "Date") {
        v.insert(
            p,
            CellValue::Date {
                v: Some(emp_store::dbmodel::DateValue {
                    start: day.to_string(),
                    end: None,
                    time: false,
                    tz: None,
                }),
            },
        );
    }
    if let Some(p) = inv.col("inv.type", &["Type"]) {
        let o = option_for_key(p, kind, INV_TYPES)
            .ok_or_else(|| ApiError::invalid("type", "the Type column has no option for this"))?;
        v.insert(p.id.clone(), option_cell(p, o));
    }
    if let (Some(p), Some(sid)) = (c("inv.security", "Security"), &security_id) {
        v.insert(
            p,
            CellValue::Relation {
                v: vec![sid.clone()],
            },
        );
    }
    if let Some(p) = c("inv.account", "Account") {
        v.insert(
            p,
            CellValue::Relation {
                v: vec![account_id.clone()],
            },
        );
    }
    if let (Some(p), Some(q)) = (c("inv.qty", "Quantity"), qty) {
        v.insert(p, CellValue::Number { v: Some(to_f64(q)) });
    }
    if let (Some(p), Some(x)) = (c("inv.price", "Price"), price) {
        v.insert(p, money_cell(x, &cur));
    }
    let gross = if trades {
        cash.unwrap_or_else(|| qty.unwrap_or_default() * price.unwrap_or_default())
    } else {
        cash.unwrap_or_default()
    };
    if let Some(p) = c("inv.amount", "Amount") {
        v.insert(p, money_cell(gross, &cur));
    }
    if let Some(p) = c("inv.fees", "Fees") {
        v.insert(p, money_cell(fees, &cur));
    }
    let id = store
        .db_rows_insert_bulk(inv.id(), vec![v], None)?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("transaction not created"))?;
    // Keep the Lots database in step with the transactions.
    let data = PortfolioData::load(store, &req.instance_id)?;
    if let Some(db) = &data.lots_db {
        let book = data.book();
        write_lots(store, db, &data, &book, local_today(store))?;
    }
    Ok(TradeDto {
        id,
        account_id,
        security_id,
    })
}

/// `portfolio_trade({ instanceId, date, type, symbol?, name?, assetClass?, accountId?, qty?, price?, amount?, fees? })
/// → { id, accountId, securityId }`: records a buy, sell, dividend, interest, reinvestment or fee (adding the
/// security, and a "Brokerage" account when there is none) and refreshes the Lots database.
#[tauri::command]
pub async fn portfolio_trade(app: AppHandle, req: TradeReq) -> ApiResult<TradeDto> {
    validate::id("instanceId", &req.instance_id)?;
    validate::opt_id("accountId", req.account_id.as_deref())?;
    if let Some(s) = &req.symbol {
        validate::bounded("symbol", s, 40)?;
    }
    if let Some(c) = &req.asset_class
        && !ASSET_CLASSES.iter().any(|(k, _)| k == c)
    {
        return Err(ApiError::invalid("assetClass", "unknown asset class"));
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        trade(&store, &req)
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

    fn empty_portfolio(store: &Store) -> String {
        let ws = store.workspace_list().unwrap().remove(0).id;
        let req: emp_store::LifeappInstall = serde_json::from_value(json!({
            "appId": "portfolio", "answers": {}, "mode": "quick", "disabledKeys": [], "workspaceId": ws, "sampleData": false
        }))
        .unwrap();
        store
            .lifeapp_install(&req, &emp_store::NoProgress)
            .unwrap()
            .instance_id
    }

    fn trade_req(v: Value) -> TradeReq {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn trades_build_lots_income_and_realised_gains() {
        let (_dir, store) = super::super::finance::test_support::temp_store();
        let inst = empty_portfolio(&store);
        let buy = trade(
            &store,
            &trade_req(json!({ "instanceId": inst, "date": "2026-01-15", "type": "buy", "symbol": "VTI", "name": "Total market", "qty": "10", "price": "200" })),
        )
        .unwrap();
        assert!(buy.security_id.is_some());
        let b = book_view(&PortfolioData::load(&store, &inst).unwrap());
        assert_eq!(b.lots.len(), 1);
        assert_eq!(
            (
                b.lots[0].qty.as_str(),
                b.lots[0].basis.as_str(),
                b.lots[0].cost_per_unit.as_str()
            ),
            ("10", "2000.00", "200")
        );
        assert_eq!(b.securities[0].asset_class, "US equity");
        assert!(b.accounts.iter().any(|a| a.id == buy.account_id));

        trade(&store, &trade_req(json!({ "instanceId": inst, "date": "2026-03-20", "type": "dividend", "symbol": "VTI", "amount": "30", "accountId": buy.account_id }))).unwrap();
        trade(&store, &trade_req(json!({ "instanceId": inst, "date": "2026-06-15", "type": "sell", "symbol": "VTI", "qty": "4", "price": "250", "accountId": buy.account_id }))).unwrap();
        let err = trade(&store, &trade_req(json!({ "instanceId": inst, "date": "2026-07-01", "type": "sell", "symbol": "VTI", "qty": "7", "price": "250", "accountId": buy.account_id }))).unwrap_err();
        assert!(err.message.contains("holds 6"), "{}", err.message);
        assert!(trade(&store, &trade_req(json!({ "instanceId": inst, "date": "2026-07-01", "type": "buy", "symbol": "VTI", "price": "250" }))).is_err(), "a buy needs shares");

        let data = PortfolioData::load(&store, &inst).unwrap();
        let b = book_view(&data);
        assert_eq!(
            (b.lots[0].qty.as_str(), b.lots[0].basis.as_str()),
            ("6", "1200.00")
        );
        assert_eq!(b.income.len(), 1);
        assert_eq!(
            (b.income[0].amount.as_str(), b.income[0].tax_treatment),
            ("30.00", "taxable")
        );
        assert_eq!(b.txns.len(), 3);
        assert_eq!(b.txns[0].kind, "sell", "newest first");
        let book = data.book();
        assert_eq!(book.realized.len(), 1);
        assert_eq!(book.realized[0].gain, Decimal::from(200), "4 × (250 − 200)");
        assert_eq!(
            book.realized[0].term,
            emp_finance::portfolio::lots::Term::Short
        );
        // The Lots database follows the trades.
        let lots_db = data.lots_db.as_ref().unwrap();
        assert_eq!(
            super::super::db::all_rows(&store, lots_db.id(), None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn xirr_and_twr_match_hand_calculations() {
        // 10 shares at 100 on 2025-01-01; 10 more at 110 on 2025-07-02 (value had risen 10%); 121 a share on
        // 2026-01-01. Each half-period gains 10%, so TWR = 1.1 × 1.1 − 1 = 21%.
        let txns = vec![
            txn("1", "2025-01-01", InvTxnType::Buy, "10", "100"),
            txn("2", "2025-07-02", InvTxnType::Buy, "10", "110"),
        ];
        let flows = emp_finance::portfolio::perf::contributions(&txns);
        assert_eq!(
            flows,
            vec![(d("2025-01-01"), 1000.0), (d("2025-07-02"), 1100.0)]
        );
        let values = vec![
            (d("2025-01-01"), 1000.0),
            (d("2025-07-02"), 2200.0),
            (d("2026-01-01"), 2420.0),
        ];
        let twr = emp_finance::portfolio::perf::twr(&values, &flows);
        assert!(
            (twr.twr.last().unwrap() - 0.21).abs() < 1e-9,
            "{:?}",
            twr.twr
        );
        // XIRR: the rate r with −1000 − 1100/(1+r)^(182/365) + 2420/(1+r)^(365/365) = 0.
        let r = emp_finance::portfolio::perf::portfolio_xirr(&flows, None, 2420.0, d("2026-01-01"))
            .unwrap();
        let npv = -1000.0 - 1100.0 / (1.0 + r).powf(182.0 / 365.0) + 2420.0 / (1.0 + r);
        assert!(npv.abs() < 1e-6, "r = {r}, npv = {npv}");
        assert!((r - 0.2098).abs() < 0.0005, "r = {r}");
        // One buy held a year at +10%: XIRR = TWR = 10%.
        let one = emp_finance::portfolio::perf::portfolio_xirr(
            &[(d("2025-01-01"), 1000.0)],
            None,
            1100.0,
            d("2026-01-01"),
        )
        .unwrap();
        assert!((one - 0.10).abs() < 1e-6, "{one}");
    }
}
