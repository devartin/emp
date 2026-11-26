//! Life-app metrics (§16.1 "Metrics and the advisor").
//!
//! * `kind: rust` metrics are built-in functions over the instance's databases, read by **semantic role**
//!   (§15.0) or property key ([`MetricData`]). They are deliberately simple, transparent estimates; the app
//!   registers a [`MetricProvider`] that replaces any of them with the `emp-finance` engines. The desktop app's
//!   provider (`src-tauri/src/commands/finance.rs`, `FinanceMetrics`) replaces Money HQ's headline metrics —
//!   `money.net_worth`, `money.net_worth_delta_30d`, `money.to_be_assigned`, `money.left_to_spend`,
//!   `money.savings_rate_3m`, `money.essential_monthly_spend`, `money.ef_balance`, `money.debt_free_date` — with
//!   the values of `finance_overview`, so KPI tiles, insights and their "Show math" use the one definition each
//!   figure has there. The built-ins below are only the fallback without a provider (e.g. this crate's tests).
//! * `kind: expr` metrics are Metric-dialect expressions (§14.7) over other metrics, answers and the pack.
//!
//! Every value carries "Show math" lines.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{Datelike, Duration, NaiveDate};
use emp_sheets::dialect::RowValue;
use emp_sheets::dialect::metric;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::life::habits::{self, Grace, Schedule};
use crate::life::recurrence::{Rule, next_after};
use crate::lifeapps::answers::{AnswerContext, flatten, to_row_value};
use crate::lifeapps::manifest::{LifeAppManifest, MetricKind};
use crate::query::config::HasConfig;
use crate::query::model::{CellValue, ComputedKind, Property, RecurrenceMode, rich_plain};

/// One "Show math" line.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct MathLine {
    /// Label.
    pub label: String,
    /// Value.
    pub value: String,
    /// Source chip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// A computed metric (`lifeapp_metrics` value).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricValue {
    /// Raw value (number, date string, boolean or `null` when there is not enough data).
    pub value: Value,
    /// Display string.
    pub display: String,
    /// "Show math".
    pub math: Vec<MathLine>,
    /// Computed at (unix ms).
    pub as_of: i64,
}

impl MetricValue {
    fn empty(as_of: i64) -> Self {
        Self {
            value: Value::Null,
            display: "—".into(),
            math: Vec::new(),
            as_of,
        }
    }
}

/// One loaded row.
#[derive(Clone, Debug, PartialEq)]
pub struct RowData {
    /// Id.
    pub id: String,
    /// Values by property id.
    pub values: BTreeMap<String, CellValue>,
    /// Created (unix ms).
    pub created_at: i64,
}

/// One loaded database.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DbData {
    /// Database id.
    pub id: String,
    /// Live properties.
    pub props: Vec<Property>,
    /// Property key (from the manifest) → id.
    pub by_key: BTreeMap<String, String>,
    /// Role → id.
    pub roles: BTreeMap<String, String>,
    /// Live rows.
    pub rows: Vec<RowData>,
}

/// Everything metric functions can read.
#[derive(Clone, Debug, Default)]
pub struct MetricData {
    /// App id.
    pub app_id: String,
    /// Instance id.
    pub instance_id: String,
    /// Resolved answers.
    pub answers: Map<String, Value>,
    /// Local today.
    pub today: NaiveDate,
    /// Now (unix ms).
    pub now_ms: i64,
    /// Install time (unix ms).
    pub installed_at: i64,
    /// Base currency.
    pub currency: String,
    /// Pack (`pack.*`).
    pub pack: Option<Value>,
    /// Databases by template key.
    pub dbs: BTreeMap<String, DbData>,
    /// Databases of other installed apps: app id → template key → data.
    pub others: BTreeMap<String, BTreeMap<String, DbData>>,
    /// Spreadsheet lint counts by rule (Spreadsheet Studio).
    pub lint: BTreeMap<String, u32>,
}

/// Replaces built-in metric functions (registered by the app, e.g. with `emp-finance` implementations).
pub trait MetricProvider: Send + Sync {
    /// The values that replace built-in functions for one computation pass, keyed by function id (e.g.
    /// `money.net_worth`). Called once per pass with the store `data` was read from; an empty map keeps every
    /// built-in. A value with a `null` `value` deliberately reports "no value" (it still wins over the built-in).
    fn overrides(&self, store: &crate::Store, data: &MetricData) -> BTreeMap<String, MetricValue>;
}

// ───────────────────────────────────────────────────────────────────────────── cell access

fn cell_num(v: &CellValue) -> Option<f64> {
    match v {
        CellValue::Number { v } | CellValue::Rating { v } | CellValue::Progress { v } => *v,
        CellValue::Money { v, .. } => v.as_deref().and_then(|s| s.parse().ok()),
        CellValue::Computed { v } => match v.kind {
            ComputedKind::Number | ComputedKind::Money => v
                .value
                .as_f64()
                .or_else(|| v.value.as_str().and_then(|s| s.parse().ok())),
            _ => None,
        },
        CellValue::Text { v } => rich_plain(v).trim().parse().ok(),
        CellValue::Check { v } => Some(if *v { 1.0 } else { 0.0 }),
        _ => None,
    }
    .filter(|x: &f64| x.is_finite())
}

impl DbData {
    /// Property id by role or key.
    #[must_use]
    pub fn col(&self, name: &str) -> Option<&str> {
        self.roles
            .get(name)
            .or_else(|| self.by_key.get(name))
            .map(String::as_str)
    }

    fn prop(&self, name: &str) -> Option<&Property> {
        let id = self.col(name)?;
        self.props.iter().find(|p| p.id == id)
    }

    fn val<'a>(&self, r: &'a RowData, name: &str) -> Option<&'a CellValue> {
        r.values.get(self.col(name)?)
    }

    /// Number (money, number, rating, progress, numeric computed).
    #[must_use]
    pub fn num(&self, r: &RowData, name: &str) -> Option<f64> {
        self.val(r, name).and_then(cell_num)
    }

    /// Plain text.
    #[must_use]
    pub fn text(&self, r: &RowData, name: &str) -> String {
        match self.val(r, name) {
            Some(CellValue::Text { v }) => rich_plain(v),
            Some(
                CellValue::Url { v }
                | CellValue::Email { v }
                | CellValue::Phone { v }
                | CellValue::Ticker { v },
            ) => v.clone().unwrap_or_default(),
            Some(CellValue::Computed { v }) => v.display.clone(),
            _ => String::new(),
        }
    }

    /// Date (start).
    #[must_use]
    pub fn date(&self, r: &RowData, name: &str) -> Option<NaiveDate> {
        match self.val(r, name)? {
            CellValue::Date { v: Some(d) } => {
                NaiveDate::parse_from_str(d.start.get(..10)?, "%Y-%m-%d").ok()
            }
            CellValue::Computed { v } => v
                .value
                .as_str()
                .and_then(|s| NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()),
            _ => None,
        }
    }

    /// Checkbox.
    #[must_use]
    pub fn check(&self, r: &RowData, name: &str) -> bool {
        matches!(self.val(r, name), Some(CellValue::Check { v: true }))
    }

    /// Option key-ish name (lowercased, `_` for spaces) of a select / status value.
    #[must_use]
    pub fn opt(&self, r: &RowData, name: &str) -> String {
        let Some(p) = self.prop(name) else {
            return String::new();
        };
        let id = match self.val(r, name) {
            Some(CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) }) => id,
            _ => return String::new(),
        };
        p.select_options()
            .into_iter()
            .find(|o| &o.id == id)
            .map(|o| norm(&o.name))
            .unwrap_or_default()
    }

    /// Related row ids.
    #[must_use]
    pub fn rel(&self, r: &RowData, name: &str) -> Vec<String> {
        match self.val(r, name) {
            Some(CellValue::Relation { v }) => v.clone(),
            _ => Vec::new(),
        }
    }

    /// Recurrence of a row.
    fn recurrence(&self, r: &RowData, name: &str) -> Option<Rule> {
        match self.val(r, name)? {
            CellValue::Recurrence { v: Some(rv) } => {
                Rule::parse(&rv.rrule, &rv.dtstart, rv.tz.as_deref()).ok()
            }
            _ => None,
        }
    }
}

/// Normalises an option name for comparisons (`Credit card` → `credit_card`, `Savings & Debt` → `savings_debt`).
#[must_use]
pub fn norm(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    out.trim_end_matches('_').to_owned()
}

// ───────────────────────────────────────────────────────────────────────────── formatting

fn fmt_with(func: &str, x: f64, cur: Option<&str>) -> String {
    let mut ctx = AnswerContext::default();
    ctx.metrics.insert("x".into(), RowValue::Number(x));
    let src = match cur {
        Some(c) => format!("{func}(metrics.x, \"{}\")", c.replace('"', "")),
        None => format!("{func}(metrics.x)"),
    };
    metric::eval(&src, &ctx)
        .map(|v| v.display())
        .unwrap_or_else(|_| emp_sheets::value::number_to_text(x))
}

fn money(x: f64, cur: &str) -> String {
    fmt_with("fmt_money", x, Some(cur))
}

fn pct(x: f64) -> String {
    fmt_with("fmt_pct", x, None)
}

/// Formats an amount the way built-in money metrics display it (`fmt_money`), for [`MetricProvider`]s.
#[must_use]
pub fn format_money(x: f64, cur: &str) -> String {
    money(x, cur)
}

/// Formats a fraction the way built-in percentage metrics display it (`fmt_pct`), for [`MetricProvider`]s.
#[must_use]
pub fn format_pct(x: f64) -> String {
    pct(x)
}

fn line(label: &str, value: String, source: Option<&str>) -> MathLine {
    MathLine {
        label: label.to_owned(),
        value,
        source: source.map(str::to_owned),
    }
}

struct Out {
    value: Value,
    display: String,
    math: Vec<MathLine>,
}

fn num_out(x: f64, display: String, math: Vec<MathLine>) -> Option<Out> {
    // `+ 0.0` turns the `-0.0` of empty float sums into `0.0`.
    let x = x + 0.0;
    let display = if x == 0.0 {
        display.trim_start_matches('-').to_owned()
    } else {
        display
    };
    x.is_finite().then(|| Out {
        value: json!(x),
        display,
        math,
    })
}

fn count_out(n: usize, what: &str) -> Option<Out> {
    Some(Out {
        value: json!(n),
        display: n.to_string(),
        math: vec![line(what, n.to_string(), None)],
    })
}

fn bool_out(b: bool, why: String) -> Option<Out> {
    Some(Out {
        value: json!(b),
        display: if b { "Yes".into() } else { "No".into() },
        math: vec![line("Condition", why, None)],
    })
}

fn date_out(d: NaiveDate, math: Vec<MathLine>) -> Option<Out> {
    let s = d.format("%Y-%m-%d").to_string();
    Some(Out {
        value: json!(s),
        display: d.format("%b %-d, %Y").to_string(),
        math,
    })
}

// ───────────────────────────────────────────────────────────────────────────── function registry

/// Built-in metric function ids.
pub const FUNCTIONS: &[&str] = &[
    // Money HQ
    "money.net_worth",
    "money.net_worth_delta_30d",
    "money.to_be_assigned",
    "money.left_to_spend",
    "money.savings_rate_3m",
    "money.savings_rate_down_3m",
    "money.essential_monthly_spend",
    "money.ef_balance",
    "money.debt_free_date",
    "money.upcoming_bills_7d",
    "money.uncategorized_count",
    "money.utilization_max",
    "money.forecast_min_balance_30d",
    "money.low_balance_threshold",
    "money.cat_90pct_count",
    "money.cat_over_count",
    "money.sub_price_up_count",
    "money.sub_renewal_14d_count",
    "money.days_since_reconcile",
    "money.max_debt_apr",
    "money.savings_grew_3m",
    "money.possible_dupes",
    "money.txn_count",
    "money.budget_assigned_count",
    // Portfolio
    "port.total_value",
    "port.day_change",
    "port.unrealized",
    "port.xirr_ytd",
    "port.xirr_all",
    "port.div_ttm",
    "port.div_fwd_12m",
    "port.max_drift",
    "port.out_of_band_count",
    "port.fees_per_year",
    "port.max_position_pct",
    "port.cash_pct",
    "port.max_er",
    "port.price_age_days",
    "port.taxable_losses",
    "port.days_since_install",
    "port.position_count",
    "port.targets_sum",
    "port.month",
    // Tax
    "tax.docs_received_pct",
    "tax.docs_expected_count",
    "tax.doc_late_count",
    "tax.next_deadline",
    "tax.days_to_next_deadline",
    "tax.est_balance",
    "tax.est_effective_rate",
    "tax.deductions_total",
    "tax.standard_deduction",
    "tax.quarterly_next",
    "tax.estimates_paid_count",
    "tax.receipt_missing_count",
    "tax.pack_stale",
    "tax.taxes_fund",
    // Spreadsheet Studio
    "sheets.lint",
    // Life OS
    "life.inbox_count",
    "life.overdue_count",
    "life.today_scheduled_min",
    "life.working_min_today",
    "life.projects_without_next",
    "life.last_review_date",
    "life.days_since_review",
    "life.task_count",
    "life.done_count",
    // Habits
    "habits.active_count",
    "habits.today_done_pct",
    "habits.best_streak",
    "habits.rate_30d_avg",
    "habits.missed_yesterday_count",
    "habits.low_rate_3w_count",
    "habits.high_rate_21d_count",
    "habits.new_active_14d_count",
    "habits.log_days",
    "habits.max_current_streak",
];

/// Whether `id` is a built-in metric function (`sheets.lint:<rule>` included).
#[must_use]
pub fn known_fn(id: &str) -> bool {
    FUNCTIONS.contains(&id)
        || id
            .strip_prefix("sheets.lint:")
            .is_some_and(|r| !r.is_empty())
}

fn db<'a>(d: &'a MetricData, key: &str) -> Option<&'a DbData> {
    d.dbs.get(key)
}

fn ans_num(d: &MetricData, path: &[&str]) -> Option<f64> {
    let mut cur = d.answers.get(*path.first()?)?;
    for p in &path[1..] {
        cur = cur.get(*p)?;
    }
    match cur {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn ans_str<'a>(d: &'a MetricData, path: &[&str]) -> &'a str {
    let mut cur = d.answers.get(path[0]);
    for p in &path[1..] {
        cur = cur.and_then(|c| c.get(*p));
    }
    cur.and_then(Value::as_str).unwrap_or_default()
}

fn month_key(d: NaiveDate) -> String {
    d.format("%Y-%m").to_string()
}

fn month_start(d: NaiveDate) -> NaiveDate {
    d.with_day(1).unwrap_or(d)
}

fn prev_month(d: NaiveDate) -> NaiveDate {
    month_start(month_start(d) - Duration::days(1))
}

fn days_in_month(d: NaiveDate) -> i64 {
    let start = month_start(d);
    let next = month_start(start + Duration::days(32));
    (next - start).num_days()
}

/// Runs one built-in function.
#[must_use]
pub fn builtin(fn_id: &str, d: &MetricData) -> Option<MetricValue> {
    let out = match fn_id.split_once('.').map_or("", |x| x.0) {
        "money" => money_fn(fn_id, d),
        "port" => port_fn(fn_id, d),
        "tax" => tax_fn(fn_id, d),
        "sheets" => sheets_fn(fn_id, d),
        "life" => life_fn(fn_id, d),
        "habits" => habits_fn(fn_id, d),
        _ => None,
    };
    Some(match out {
        Some(o) => MetricValue {
            value: o.value,
            display: o.display,
            math: o.math,
            as_of: d.now_ms,
        },
        None => MetricValue::empty(d.now_ms),
    })
}

// ───────────────────────────────────────────────────────────────────────────── Money HQ

const DEBT_TYPES: &[&str] = &[
    "credit_card",
    "student_loan",
    "auto_loan",
    "mortgage",
    "personal_loan",
    "other_liability",
];
const CASH_TYPES: &[&str] = &["checking", "savings", "cash"];

struct Acct {
    id: String,
    name: String,
    kind: String,
    balance: f64,
    apr: f64,
    min_payment: f64,
    limit: f64,
    on_budget: bool,
    low: f64,
    reconciled: Option<NaiveDate>,
}

/// A transaction: (date, amount, account ids, category ids, is transfer, raw description, row).
type Txn<'a> = (
    NaiveDate,
    f64,
    Vec<String>,
    Vec<String>,
    bool,
    String,
    &'a RowData,
);

fn txn_rows(d: &MetricData) -> Vec<Txn<'_>> {
    let Some(t) = db(d, "transactions") else {
        return Vec::new();
    };
    t.rows
        .iter()
        .filter_map(|r| {
            let date = t.date(r, "txn.date")?;
            let amt = t.num(r, "txn.amount")?;
            Some((
                date,
                amt,
                t.rel(r, "txn.account"),
                t.rel(r, "txn.category"),
                !t.rel(r, "txn.transfer").is_empty(),
                t.text(r, "txn.raw"),
                r,
            ))
        })
        .collect()
}

fn accounts(d: &MetricData) -> Vec<Acct> {
    let Some(a) = db(d, "accounts") else {
        return Vec::new();
    };
    let txns = txn_rows(d);
    a.rows
        .iter()
        .filter(|r| !a.check(r, "closed"))
        .map(|r| {
            let kind = a.opt(r, "acct.type");
            let computed = a.num(r, "balance");
            // Card and loan openings are amounts owed, either sign (`emp_finance::ledger::opening_as_counted`).
            let opening = a.num(r, "acct.opening").unwrap_or(0.0);
            let opening = if is_debt(&kind) {
                -opening.abs()
            } else {
                opening
            };
            let balance = computed.unwrap_or_else(|| {
                opening
                    + txns
                        .iter()
                        .filter(|t| t.2.contains(&r.id))
                        .map(|t| t.1)
                        .sum::<f64>()
            });
            Acct {
                id: r.id.clone(),
                name: a.text(r, "name"),
                balance,
                apr: a.num(r, "acct.apr").unwrap_or(0.0),
                min_payment: a.num(r, "acct.min_payment").unwrap_or(0.0),
                limit: a.num(r, "acct.limit").unwrap_or(0.0),
                on_budget: a.check(r, "acct.on_budget"),
                low: a.num(r, "acct.low_threshold").unwrap_or(0.0),
                reconciled: a.date(r, "last_reconciled"),
                kind,
            }
        })
        .collect()
}

fn is_debt(k: &str) -> bool {
    DEBT_TYPES.contains(&k)
}

/// Debts are stored as amounts owed (positive) or as negative balances; both count as liabilities.
fn owed(a: &Acct) -> f64 {
    a.balance.abs()
}

/// Fallback net worth (the app's provider replaces it with `emp_finance::networth::point`), with the same side
/// rule: open accounts, a positive balance is an asset and a negative one a liability whatever the account type.
fn net_worth(d: &MetricData) -> (f64, f64, f64) {
    let accts = accounts(d);
    let assets: f64 = accts.iter().map(|a| a.balance.max(0.0)).sum();
    let liab: f64 = accts.iter().map(|a| (-a.balance).max(0.0)).sum();
    (assets - liab, assets, liab)
}

struct Cat {
    id: String,
    name: String,
    group: String,
    essential: bool,
}

fn categories(d: &MetricData) -> Vec<Cat> {
    let Some(c) = db(d, "categories") else {
        return Vec::new();
    };
    c.rows
        .iter()
        .map(|r| Cat {
            id: r.id.clone(),
            name: c.text(r, "name"),
            group: c.opt(r, "cat.group"),
            essential: c.check(r, "cat.essential"),
        })
        .collect()
}

/// (income, spending) over `[from, to]` excluding transfers; uncategorised inflows count as income.
fn income_spending(d: &MetricData, from: NaiveDate, to: NaiveDate) -> (f64, f64) {
    let cats = categories(d);
    let income_cat = |ids: &[String]| {
        ids.iter()
            .any(|i| cats.iter().any(|c| &c.id == i && c.group == "income"))
    };
    let mut inc = 0.0;
    let mut sp = 0.0;
    for (date, amt, _, cat, transfer, _, _) in txn_rows(d) {
        if transfer || date < from || date > to {
            continue;
        }
        if amt > 0.0 && (cat.is_empty() || income_cat(&cat)) {
            inc += amt;
        } else if amt < 0.0 {
            sp += -amt;
        } else {
            // Refunds into spending categories reduce spending.
            sp -= amt;
        }
    }
    (inc, sp)
}

fn savings_rate(d: &MetricData, from: NaiveDate, to: NaiveDate) -> Option<f64> {
    let (i, s) = income_spending(d, from, to);
    (i > 0.0).then(|| (i - s) / i)
}

fn month_bounds(m: NaiveDate) -> (NaiveDate, NaiveDate) {
    let s = month_start(m);
    (s, s + Duration::days(days_in_month(s) - 1))
}

/// Budget lines of a month: (category id, assigned, spent).
fn budget_lines(d: &MetricData, month: NaiveDate) -> Vec<(String, f64, f64)> {
    let Some(b) = db(d, "budgets") else {
        return Vec::new();
    };
    let key = month_key(month);
    let (from, to) = month_bounds(month);
    let txns = txn_rows(d);
    b.rows
        .iter()
        .filter(|r| b.text(r, "month") == key)
        .filter_map(|r| {
            let cat = b.rel(r, "category").into_iter().next()?;
            let assigned = b.num(r, "assigned").unwrap_or(0.0);
            let spent: f64 = txns
                .iter()
                .filter(|t| !t.4 && t.0 >= from && t.0 <= to && t.3.contains(&cat))
                .map(|t| -t.1)
                .sum();
            Some((cat, assigned, spent))
        })
        .collect()
}

fn essential_monthly(d: &MetricData) -> Option<f64> {
    let cats = categories(d);
    let ess: BTreeSet<&str> = cats
        .iter()
        .filter(|c| c.essential)
        .map(|c| c.id.as_str())
        .collect();
    let txns = txn_rows(d);
    let mut months = Vec::new();
    let mut m = prev_month(d.today);
    for _ in 0..3 {
        let (from, to) = month_bounds(m);
        let s: f64 = txns
            .iter()
            .filter(|t| {
                !t.4 && t.1 < 0.0
                    && t.0 >= from
                    && t.0 <= to
                    && t.3.iter().any(|c| ess.contains(c.as_str()))
            })
            .map(|t| -t.1)
            .sum();
        months.push(s);
        m = prev_month(m);
    }
    months.retain(|x| *x > 0.0);
    if months.is_empty() {
        // No history yet: essential bills from the answers.
        let bills: f64 = d
            .answers
            .get("bills")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|b| b.get("amount").and_then(Value::as_f64))
                    .sum()
            })
            .unwrap_or(0.0);
        return (bills > 0.0).then_some(bills);
    }
    months.sort_by(f64::total_cmp);
    Some(months[months.len() / 2])
}

fn ef_balance(d: &MetricData) -> Option<(f64, &'static str)> {
    if let Some(g) = db(d, "goals") {
        let s: Vec<f64> = g
            .rows
            .iter()
            .filter(|r| g.opt(r, "goal.kind") == "emergency")
            .filter_map(|r| g.num(r, "goal.saved"))
            .collect();
        if !s.is_empty() {
            return Some((s.iter().sum(), "Emergency fund goal"));
        }
    }
    let sav: Vec<f64> = accounts(d)
        .iter()
        .filter(|a| a.kind == "savings")
        .map(|a| a.balance)
        .collect();
    (!sav.is_empty()).then(|| (sav.iter().sum(), "Savings accounts"))
}

/// Monthly avalanche / snowball simulation (§15.5, simplified): `debts` are `(balance, apr %, minimum)`.
/// Interest accrues monthly at APR/12 before payments; minimums are paid first, then the extra amount plus the
/// minimums freed by paid-off debts go to the target debt. Returns months to debt-free and total interest, or
/// `None` when the debts are not paid off within 600 months.
#[must_use]
pub fn simulate_debts(debts: &[(f64, f64, f64)], extra: f64, strategy: &str) -> Option<(u32, f64)> {
    let mut bal: Vec<(f64, f64, f64)> = debts.iter().copied().filter(|d| d.0 > 0.005).collect();
    if bal.is_empty() {
        return Some((0, 0.0));
    }
    let budget: f64 = bal.iter().map(|b| b.2).sum::<f64>() + extra.max(0.0);
    let mut interest = 0.0;
    for month in 1..=600u32 {
        for b in &mut bal {
            let i = b.0 * b.1 / 100.0 / 12.0;
            b.0 += i;
            interest += i;
        }
        let mut pool = budget;
        for b in bal.iter_mut().filter(|b| b.0 > 0.005) {
            let pay = b.2.min(b.0).min(pool);
            b.0 -= pay;
            pool -= pay;
        }
        let mut order: Vec<usize> = (0..bal.len()).filter(|&i| bal[i].0 > 0.005).collect();
        match strategy {
            "snowball" => order.sort_by(|&a, &b| bal[a].0.total_cmp(&bal[b].0)),
            _ => order.sort_by(|&a, &b| {
                bal[b]
                    .1
                    .total_cmp(&bal[a].1)
                    .then(bal[a].0.total_cmp(&bal[b].0))
            }),
        }
        for i in order {
            if pool <= 0.0 {
                break;
            }
            let pay = pool.min(bal[i].0);
            bal[i].0 -= pay;
            pool -= pay;
        }
        if bal.iter().all(|b| b.0 <= 0.005) {
            return Some((month, interest));
        }
    }
    None
}

fn add_months(d: NaiveDate, n: u32) -> NaiveDate {
    let mut out = d;
    for _ in 0..n {
        out = month_start(out + Duration::days(32))
            .with_day(d.day().min(28))
            .unwrap_or(out);
    }
    out
}

/// Recurring rows (Money HQ): (name, signed amount, rule, row).
fn recurring(d: &MetricData) -> Vec<(String, f64, Rule)> {
    let Some(r) = db(d, "recurring") else {
        return Vec::new();
    };
    r.rows
        .iter()
        .filter_map(|row| {
            let rule = r.recurrence(row, "rec.schedule")?;
            let amt = r.num(row, "rec.amount")?.abs();
            let kind = r.opt(row, "rec.kind");
            let signed = if kind == "income" { amt } else { -amt };
            Some((r.text(row, "name"), signed, rule))
        })
        .collect()
}

fn occurrences(rule: &Rule, from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    let mut cur = from.and_hms_opt(0, 0, 0).unwrap_or_default() - Duration::seconds(1);
    for _ in 0..400 {
        match next_after(rule, cur, RecurrenceMode::Schedule) {
            Some(n) if n.date() <= to => {
                out.push(n.date());
                cur = n;
            }
            _ => break,
        }
    }
    out
}

fn money_fn(id: &str, d: &MetricData) -> Option<Out> {
    let cur = d.currency.as_str();
    let today = d.today;
    match id {
        "money.net_worth" => {
            let (nw, a, l) = net_worth(d);
            if accounts(d).is_empty() {
                return None;
            }
            num_out(
                nw,
                money(nw, cur),
                vec![
                    line("Assets", money(a, cur), Some("Accounts")),
                    line("Liabilities", money(-l, cur), Some("Accounts")),
                ],
            )
        }
        "money.net_worth_delta_30d" => {
            if accounts(d).is_empty() {
                return None;
            }
            let accts = accounts(d);
            let from = today - Duration::days(30);
            let mut delta = 0.0;
            for (date, amt, acc, _, _, _, _) in txn_rows(d) {
                if date <= from {
                    continue;
                }
                if accts.iter().any(|a| acc.contains(&a.id)) {
                    // A purchase on a card (negative amount) raises the debt: net worth falls by the same amount.
                    delta += amt;
                }
            }
            num_out(
                delta,
                money(delta, cur),
                vec![line(
                    "Net change of transactions, last 30 days",
                    money(delta, cur),
                    Some("Transactions"),
                )],
            )
        }
        "money.to_be_assigned" | "money.left_to_spend" => {
            let lines = budget_lines(d, today);
            let assigned: f64 = lines.iter().map(|l| l.1).sum();
            let spent: f64 = lines.iter().map(|l| l.2.max(0.0)).sum();
            if id == "money.to_be_assigned" {
                let (from, to) = month_bounds(today);
                let (inc, _) = income_spending(d, from, to);
                let v = inc - assigned;
                num_out(
                    v,
                    money(v, cur),
                    vec![
                        line("Income this month", money(inc, cur), Some("Transactions")),
                        line("Assigned", money(assigned, cur), Some("Budgets")),
                    ],
                )
            } else {
                if lines.is_empty() {
                    return None;
                }
                let v = assigned - spent;
                num_out(
                    v,
                    money(v, cur),
                    vec![
                        line("Assigned this month", money(assigned, cur), Some("Budgets")),
                        line("Spent", money(spent, cur), Some("Transactions")),
                    ],
                )
            }
        }
        "money.savings_rate_3m" => {
            let from = month_start(prev_month(prev_month(prev_month(today))));
            let to = month_start(today) - Duration::days(1);
            let (i, s) = income_spending(d, from, to);
            if i <= 0.0 {
                return None;
            }
            let r = (i - s) / i;
            num_out(
                r,
                pct(r),
                vec![
                    line(
                        "Income (3 full months)",
                        money(i, cur),
                        Some("Transactions"),
                    ),
                    line("Spending", money(s, cur), Some("Transactions")),
                    line("Savings rate", "(income − spending) ÷ income".into(), None),
                ],
            )
        }
        "money.savings_rate_down_3m" => {
            let mut rates = Vec::new();
            let mut m = prev_month(today);
            for _ in 0..4 {
                let (f, t) = month_bounds(m);
                rates.push(savings_rate(d, f, t)?);
                m = prev_month(m);
            }
            rates.reverse();
            let down = rates.windows(2).all(|w| w[1] < w[0]);
            bool_out(
                down,
                rates
                    .iter()
                    .map(|r| pct(*r))
                    .collect::<Vec<_>>()
                    .join(" → "),
            )
        }
        "money.essential_monthly_spend" => {
            let e = essential_monthly(d)?;
            num_out(
                e,
                money(e, cur),
                vec![line(
                    "Median of the last 3 months in essential categories",
                    money(e, cur),
                    Some("Transactions"),
                )],
            )
        }
        "money.ef_balance" => {
            let (b, src) = ef_balance(d)?;
            num_out(
                b,
                money(b, cur),
                vec![line("Emergency savings", money(b, cur), Some(src))],
            )
        }
        "money.debt_free_date" => {
            let debts: Vec<(f64, f64, f64)> = accounts(d)
                .iter()
                .filter(|a| is_debt(&a.kind))
                .map(|a| {
                    (
                        owed(a),
                        a.apr,
                        a.min_payment.max(owed(a) * 0.01).max(25.0_f64.min(owed(a))),
                    )
                })
                .collect();
            if debts.is_empty() {
                return None;
            }
            let extra = ans_num(d, &["debt", "extra"]).unwrap_or(0.0);
            let strategy = ans_str(d, &["debt", "strategy"]);
            let (months, interest) = simulate_debts(&debts, extra, strategy)?;
            let date = add_months(today, months);
            date_out(
                date,
                vec![
                    line("Debts", debts.len().to_string(), Some("Accounts")),
                    line("Extra per month", money(extra, cur), Some("Your answers")),
                    line("Months to debt-free", months.to_string(), None),
                    line("Estimated interest", money(interest, cur), None),
                ],
            )
        }
        "money.upcoming_bills_7d" => {
            let to = today + Duration::days(7);
            let mut total = 0.0;
            let mut math = Vec::new();
            for (name, amt, rule) in recurring(d) {
                if amt >= 0.0 {
                    continue;
                }
                for o in occurrences(&rule, today, to) {
                    total += -amt;
                    math.push(line(
                        &name,
                        format!("{} on {}", money(-amt, cur), o.format("%b %-d")),
                        Some("Recurring"),
                    ));
                }
            }
            num_out(total, money(total, cur), math)
        }
        "money.uncategorized_count" => count_out(
            txn_rows(d)
                .iter()
                .filter(|t| t.3.is_empty() && !t.4)
                .count(),
            "Transactions without a category",
        ),
        "money.txn_count" => count_out(txn_rows(d).len(), "Transactions"),
        "money.budget_assigned_count" => count_out(
            budget_lines(d, today).iter().filter(|l| l.1 > 0.0).count(),
            "Categories with money assigned this month",
        ),
        "money.utilization_max" => {
            let cards: Vec<(String, f64)> = accounts(d)
                .iter()
                .filter(|a| a.kind == "credit_card" && a.limit > 0.0)
                .map(|a| (a.name.clone(), owed(a) / a.limit))
                .collect();
            let (name, u) = cards.iter().max_by(|a, b| a.1.total_cmp(&b.1))?.clone();
            num_out(
                u,
                pct(u),
                vec![line(&name, pct(u), Some("balance ÷ credit limit"))],
            )
        }
        "money.forecast_min_balance_30d" | "money.low_balance_threshold" => {
            let accts = accounts(d);
            let cash: Vec<&Acct> = accts
                .iter()
                .filter(|a| {
                    CASH_TYPES.contains(&a.kind.as_str()) && (a.on_budget || a.kind == "checking")
                })
                .collect();
            if cash.is_empty() {
                return None;
            }
            if id == "money.low_balance_threshold" {
                let t: f64 = cash.iter().map(|a| a.low).sum();
                return num_out(
                    t,
                    money(t, cur),
                    vec![line(
                        "Low-balance thresholds",
                        money(t, cur),
                        Some("Accounts"),
                    )],
                );
            }
            let start: f64 = cash.iter().map(|a| a.balance).sum();
            let mut by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
            for (_, amt, rule) in recurring(d) {
                for o in occurrences(&rule, today, today + Duration::days(30)) {
                    *by_day.entry(o).or_default() += amt;
                }
            }
            let mut bal = start;
            let mut min = start;
            let mut min_day = today;
            for (day, delta) in by_day {
                bal += delta;
                if bal < min {
                    min = bal;
                    min_day = day;
                }
            }
            num_out(
                min,
                money(min, cur),
                vec![
                    line("Cash today", money(start, cur), Some("Accounts")),
                    line(
                        "Lowest projected balance",
                        format!("{} on {}", money(min, cur), min_day.format("%b %-d")),
                        Some("Recurring items"),
                    ),
                ],
            )
        }
        "money.cat_90pct_count" | "money.cat_over_count" => {
            let days_left = days_in_month(today) - i64::from(today.day0());
            let lines = budget_lines(d, today);
            let cats = categories(d);
            let hit: Vec<&(String, f64, f64)> = if id == "money.cat_over_count" {
                lines
                    .iter()
                    .filter(|l| l.2 > l.1 + 0.005 && l.2 > 0.0)
                    .collect()
            } else {
                if days_left < 10 {
                    return count_out(0, "Days left this month < 10");
                }
                lines
                    .iter()
                    .filter(|l| l.1 > 0.0 && l.2 >= 0.9 * l.1 && l.2 <= l.1)
                    .collect()
            };
            let math = hit
                .iter()
                .map(|l| {
                    let name = cats
                        .iter()
                        .find(|c| c.id == l.0)
                        .map(|c| c.name.clone())
                        .unwrap_or_default();
                    line(
                        &name,
                        format!("{} of {}", money(l.2, cur), money(l.1, cur)),
                        Some("Budget"),
                    )
                })
                .collect();
            Some(Out {
                value: json!(hit.len()),
                display: hit.len().to_string(),
                math,
            })
        }
        "money.sub_price_up_count" | "money.sub_renewal_14d_count" => {
            let s = db(d, "subscriptions")?;
            let active = |r: &RowData| {
                let st = s.opt(r, "status");
                st.is_empty() || st == "active"
            };
            let n = if id == "money.sub_price_up_count" {
                s.rows
                    .iter()
                    .filter(|r| {
                        active(r)
                            && s.date(r, "last_price_change")
                                .is_some_and(|x| (today - x).num_days() <= 30 && x <= today)
                    })
                    .count()
            } else {
                s.rows
                    .iter()
                    .filter(|r| {
                        active(r)
                            && s.date(r, "next_charge")
                                .is_some_and(|x| x >= today && (x - today).num_days() <= 14)
                    })
                    .count()
            };
            count_out(
                n,
                if id == "money.sub_price_up_count" {
                    "Price changes in the last 30 days"
                } else {
                    "Renewals in the next 14 days"
                },
            )
        }
        "money.days_since_reconcile" => {
            let accts = accounts(d);
            let on: Vec<&Acct> = accts.iter().filter(|a| a.on_budget).collect();
            if on.is_empty() {
                return None;
            }
            let oldest_txn = txn_rows(d).iter().map(|t| t.0).min();
            let days = on
                .iter()
                .filter_map(|a| a.reconciled.or(oldest_txn).map(|r| (today - r).num_days()))
                .max()?;
            num_out(
                days as f64,
                format!("{days} days"),
                vec![line(
                    "Longest time since an on-budget account was reconciled",
                    format!("{days} days"),
                    Some("Accounts"),
                )],
            )
        }
        "money.max_debt_apr" => {
            let a = accounts(d)
                .into_iter()
                .filter(|a| is_debt(&a.kind) && owed(a) > 0.0)
                .max_by(|a, b| a.apr.total_cmp(&b.apr))?;
            num_out(
                a.apr,
                format!("{}%", emp_sheets::value::number_to_text(a.apr)),
                vec![line(&a.name, format!("{}% APR", a.apr), Some("Accounts"))],
            )
        }
        "money.savings_grew_3m" => {
            let accts = accounts(d);
            let sav: Vec<&Acct> = accts.iter().filter(|a| a.kind == "savings").collect();
            if sav.is_empty() {
                return bool_out(false, "No savings accounts".into());
            }
            let txns = txn_rows(d);
            let mut m = prev_month(today);
            let mut grew = true;
            let mut parts = Vec::new();
            for _ in 0..3 {
                let (f, t) = month_bounds(m);
                let net: f64 = txns
                    .iter()
                    .filter(|x| {
                        x.0 >= f && x.0 <= t && x.2.iter().any(|a| sav.iter().any(|s| &s.id == a))
                    })
                    .map(|x| x.1)
                    .sum();
                parts.push(money(net, cur));
                grew &= net > 0.0;
                m = prev_month(m);
            }
            bool_out(grew, parts.join(", "))
        }
        "money.possible_dupes" => {
            let mut seen: HashMap<(NaiveDate, i64, Vec<String>, String), usize> = HashMap::new();
            for t in txn_rows(d) {
                *seen
                    .entry((
                        t.0,
                        (t.1 * 100.0).round() as i64,
                        t.2.clone(),
                        t.5.to_lowercase(),
                    ))
                    .or_default() += 1;
            }
            count_out(
                seen.values().filter(|n| **n > 1).count(),
                "Groups of same-day, same-amount transactions",
            )
        }
        _ => None,
    }
}

// ───────────────────────────────────────────────────────────────────────────── Portfolio

struct Holding {
    name: String,
    class: String,
    qty: f64,
    cost: f64,
    price: f64,
    day_pct: f64,
    er: f64,
    price_as_of: Option<NaiveDate>,
    taxable: bool,
}

impl Holding {
    fn value(&self) -> f64 {
        self.qty * self.price
    }
}

fn holdings(d: &MetricData) -> Vec<Holding> {
    let (Some(sec), Some(tx)) = (db(d, "securities"), db(d, "inv_txns")) else {
        return Vec::new();
    };
    let accts = db(d, "inv_accounts");
    let mut out = Vec::new();
    for s in &sec.rows {
        let mut qty = 0.0;
        let mut cost = 0.0;
        let mut taxable = false;
        let mut rows: Vec<&RowData> = tx
            .rows
            .iter()
            .filter(|r| tx.rel(r, "inv.security").contains(&s.id))
            .collect();
        rows.sort_by_key(|r| tx.date(r, "inv.date"));
        for r in rows {
            let q = tx.num(r, "inv.qty").unwrap_or(0.0);
            let price = tx.num(r, "inv.price").unwrap_or(0.0);
            let amount = tx.num(r, "inv.amount").unwrap_or(q * price);
            match tx.opt(r, "inv.type").as_str() {
                "buy" | "reinvest" | "transfer_in" => {
                    qty += q;
                    cost += amount.abs() + tx.num(r, "inv.fees").unwrap_or(0.0);
                }
                "sell" | "transfer_out" => {
                    if qty > 0.0 {
                        let avg = cost / qty;
                        cost -= avg * q.min(qty);
                    }
                    qty -= q;
                }
                _ => {}
            }
            if let Some(a) = accts
                && let Some(acc) = tx.rel(r, "inv.account").first()
                && let Some(ar) = a.rows.iter().find(|x| &x.id == acc)
            {
                taxable |= a.opt(ar, "tax_treatment") == "taxable";
            }
        }
        if qty.abs() < 1e-9 {
            continue;
        }
        out.push(Holding {
            name: sec.text(s, "sec.ticker"),
            class: sec.opt(s, "sec.class"),
            qty,
            cost,
            price: sec.num(s, "last_price").unwrap_or(0.0),
            day_pct: sec.num(s, "day_pct").unwrap_or(0.0),
            er: sec.num(s, "sec.expense_ratio").unwrap_or(0.0),
            price_as_of: sec.date(s, "price_as_of"),
            taxable,
        });
    }
    out
}

/// XIRR by Newton-Raphson with a bisection fallback (§15.7).
#[must_use]
pub fn xirr(flows: &[(NaiveDate, f64)]) -> Option<f64> {
    let first = flows.iter().map(|f| f.0).min()?;
    if !flows.iter().any(|f| f.1 > 0.0) || !flows.iter().any(|f| f.1 < 0.0) {
        return None;
    }
    let npv = |r: f64| -> f64 {
        flows
            .iter()
            .map(|(d, a)| a / (1.0 + r).powf((*d - first).num_days() as f64 / 365.0))
            .sum()
    };
    let dnpv = |r: f64| -> f64 {
        flows
            .iter()
            .map(|(d, a)| {
                let t = (*d - first).num_days() as f64 / 365.0;
                -t * a / (1.0 + r).powf(t + 1.0)
            })
            .sum()
    };
    let mut r = 0.1;
    for _ in 0..50 {
        let f = npv(r);
        let df = dnpv(r);
        if df.abs() < 1e-12 {
            break;
        }
        let next = r - f / df;
        if !next.is_finite() || next <= -0.9999 {
            break;
        }
        if (next - r).abs() < 1e-7 {
            return Some(next);
        }
        r = next;
    }
    let (mut lo, mut hi) = (-0.9999, 10.0);
    if npv(lo).signum() == npv(hi).signum() {
        return None;
    }
    for _ in 0..200 {
        let mid = (lo + hi) / 2.0;
        if npv(mid).signum() == npv(lo).signum() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some((lo + hi) / 2.0)
}

fn dividends(d: &MetricData) -> Vec<(NaiveDate, f64, String)> {
    let mut out = Vec::new();
    if let Some(dv) = db(d, "dividends") {
        for r in &dv.rows {
            if let (Some(date), Some(a)) = (dv.date(r, "date"), dv.num(r, "amount")) {
                out.push((
                    date,
                    a,
                    dv.rel(r, "security").first().cloned().unwrap_or_default(),
                ));
            }
        }
    }
    out
}

fn port_fn(id: &str, d: &MetricData) -> Option<Out> {
    let cur = d.currency.as_str();
    let today = d.today;
    let hs = holdings(d);
    let total: f64 = hs.iter().map(Holding::value).sum();
    match id {
        "port.total_value" => {
            if hs.is_empty() {
                return None;
            }
            num_out(
                total,
                money(total, cur),
                hs.iter()
                    .map(|h| line(&h.name, money(h.value(), cur), Some("qty × last price")))
                    .collect(),
            )
        }
        "port.position_count" => count_out(hs.len(), "Positions"),
        "port.day_change" => {
            if hs.is_empty() {
                return None;
            }
            let ch: f64 = hs
                .iter()
                .map(|h| h.value() * h.day_pct / (1.0 + h.day_pct))
                .sum();
            num_out(
                ch,
                money(ch, cur),
                vec![line(
                    "Σ value × day % ÷ (1 + day %)",
                    money(ch, cur),
                    Some("Securities"),
                )],
            )
        }
        "port.unrealized" | "port.taxable_losses" => {
            if hs.is_empty() {
                return None;
            }
            if id == "port.taxable_losses" {
                let l: f64 = hs
                    .iter()
                    .filter(|h| h.taxable)
                    .map(|h| (h.value() - h.cost).min(0.0))
                    .sum();
                return num_out(
                    l,
                    money(l, cur),
                    vec![line(
                        "Unrealised losses in taxable accounts",
                        money(l, cur),
                        Some("Lots"),
                    )],
                );
            }
            let cost: f64 = hs.iter().map(|h| h.cost).sum();
            let u = total - cost;
            num_out(
                u,
                money(u, cur),
                vec![
                    line("Market value", money(total, cur), None),
                    line(
                        "Cost basis (average cost)",
                        money(cost, cur),
                        Some("Investment transactions"),
                    ),
                ],
            )
        }
        "port.xirr_ytd" | "port.xirr_all" => {
            let tx = db(d, "inv_txns")?;
            let from = if id == "port.xirr_ytd" {
                NaiveDate::from_ymd_opt(today.year(), 1, 1)?
            } else {
                NaiveDate::MIN
            };
            let mut flows = Vec::new();
            for r in &tx.rows {
                let Some(date) = tx.date(r, "inv.date") else {
                    continue;
                };
                if date < from {
                    continue;
                }
                let amt = tx
                    .num(r, "inv.amount")
                    .unwrap_or_else(|| {
                        tx.num(r, "inv.qty").unwrap_or(0.0) * tx.num(r, "inv.price").unwrap_or(0.0)
                    })
                    .abs();
                match tx.opt(r, "inv.type").as_str() {
                    "buy" => flows.push((date, -amt)),
                    "sell" | "dividend" | "interest" => flows.push((date, amt)),
                    _ => {}
                }
            }
            if id == "port.xirr_ytd" {
                // Value at the start of the year is unknown here; treat holdings bought earlier as invested on Jan 1.
                let earlier: f64 = hs.iter().map(|h| h.cost).sum::<f64>()
                    + flows.iter().filter(|f| f.1 < 0.0).map(|f| f.1).sum::<f64>();
                if earlier > 0.0 {
                    flows.push((from, -earlier));
                }
            }
            flows.push((today, total));
            let r = xirr(&flows)?;
            num_out(
                r,
                pct(r),
                vec![
                    line(
                        "Cash flows",
                        flows.len().to_string(),
                        Some("Investment transactions"),
                    ),
                    line("Ending value", money(total, cur), None),
                ],
            )
        }
        "port.div_ttm" | "port.div_fwd_12m" => {
            let divs = dividends(d);
            let from = today - Duration::days(365);
            let ttm: Vec<&(NaiveDate, f64, String)> =
                divs.iter().filter(|x| x.0 > from && x.0 <= today).collect();
            if id == "port.div_ttm" {
                let s: f64 = ttm.iter().map(|x| x.1).sum();
                return num_out(
                    s,
                    money(s, cur),
                    vec![line(
                        "Dividends, trailing 12 months",
                        money(s, cur),
                        Some("Dividends"),
                    )],
                );
            }
            let mut by_sec: BTreeMap<&str, Vec<&(NaiveDate, f64, String)>> = BTreeMap::new();
            for x in &ttm {
                by_sec.entry(x.2.as_str()).or_default().push(x);
            }
            let fwd: f64 = by_sec
                .values()
                .map(|v| {
                    let last = v.iter().max_by_key(|x| x.0).map_or(0.0, |x| x.1);
                    last * v.len() as f64
                })
                .sum();
            num_out(
                fwd,
                money(fwd, cur),
                vec![line(
                    "Last regular dividend × payments per year (estimate)",
                    money(fwd, cur),
                    Some("Dividends"),
                )],
            )
        }
        "port.max_drift" | "port.out_of_band_count" | "port.cash_pct" | "port.targets_sum" => {
            let t = db(d, "targets")?;
            let mut by_class: BTreeMap<String, f64> = BTreeMap::new();
            for h in &hs {
                *by_class.entry(h.class.clone()).or_default() += h.value();
            }
            if id == "port.targets_sum" {
                let s: f64 = t.rows.iter().filter_map(|r| t.num(r, "alloc.target")).sum();
                return num_out(
                    s,
                    format!("{}%", emp_sheets::value::number_to_text(s)),
                    vec![line(
                        "Σ targets",
                        format!("{s}%"),
                        Some("Target allocation"),
                    )],
                );
            }
            if id == "port.cash_pct" {
                if total <= 0.0 {
                    return None;
                }
                let c = by_class.get("cash").copied().unwrap_or(0.0) / total;
                return num_out(
                    c,
                    pct(c),
                    vec![line("Cash ÷ total", pct(c), Some("Holdings"))],
                );
            }
            if total <= 0.0 {
                return None;
            }
            let mut max = 0.0f64;
            let mut out_n = 0usize;
            let mut math = Vec::new();
            for r in &t.rows {
                let class = t.opt(r, "alloc.class");
                let target = t.num(r, "alloc.target").unwrap_or(0.0);
                let current = by_class.get(&class).copied().unwrap_or(0.0) / total * 100.0;
                let drift = current - target;
                let band_abs = t.num(r, "alloc.band_abs").unwrap_or(5.0);
                let band_rel = t.num(r, "alloc.band_rel").unwrap_or(25.0) / 100.0 * target;
                if drift.abs() > band_abs || (target > 0.0 && drift.abs() > band_rel) {
                    out_n += 1;
                }
                max = max.max(drift.abs());
                math.push(line(
                    &t.text(r, "name"),
                    format!("{current:.1}% vs {target:.1}% target ({drift:+.1} pp)"),
                    Some("Target allocation"),
                ));
            }
            if id == "port.out_of_band_count" {
                return Some(Out {
                    value: json!(out_n),
                    display: out_n.to_string(),
                    math,
                });
            }
            num_out(max, format!("{max:.1} pp"), math)
        }
        "port.fees_per_year" => {
            if hs.is_empty() {
                return None;
            }
            let f: f64 = hs.iter().map(|h| h.value() * h.er / 100.0).sum();
            num_out(
                f,
                money(f, cur),
                vec![line(
                    "Σ value × expense ratio",
                    money(f, cur),
                    Some("Securities"),
                )],
            )
        }
        "port.max_position_pct" => {
            if total <= 0.0 {
                return None;
            }
            let h = hs.iter().max_by(|a, b| a.value().total_cmp(&b.value()))?;
            let p = h.value() / total;
            num_out(p, pct(p), vec![line(&h.name, pct(p), Some("Holdings"))])
        }
        "port.max_er" => {
            let h = hs.iter().max_by(|a, b| a.er.total_cmp(&b.er))?;
            num_out(
                h.er,
                format!("{}%", emp_sheets::value::number_to_text(h.er)),
                vec![line(&h.name, format!("{}%", h.er), Some("Securities"))],
            )
        }
        "port.price_age_days" => {
            let oldest = hs.iter().filter_map(|h| h.price_as_of).min()?;
            let days = (today - oldest).num_days();
            num_out(
                days as f64,
                format!("{days} days"),
                vec![line(
                    "Oldest price",
                    oldest.format("%Y-%m-%d").to_string(),
                    Some("Securities"),
                )],
            )
        }
        "port.month" => {
            let mth = f64::from(today.month());
            num_out(
                mth,
                today.format("%B").to_string(),
                vec![line("Current month", today.format("%B").to_string(), None)],
            )
        }
        "port.days_since_install" => {
            let days = (d.now_ms - d.installed_at).max(0) / 86_400_000;
            num_out(
                days as f64,
                format!("{days} days"),
                vec![line("IPS written", format!("{days} days ago"), None)],
            )
        }
        _ => None,
    }
}

// ───────────────────────────────────────────────────────────────────────────── Tax

fn tax_fn(id: &str, d: &MetricData) -> Option<Out> {
    let cur = d.currency.as_str();
    let today = d.today;
    match id {
        "tax.docs_received_pct" | "tax.docs_expected_count" | "tax.doc_late_count" => {
            let docs = db(d, "documents")?;
            let live: Vec<&RowData> = docs
                .rows
                .iter()
                .filter(|r| docs.opt(r, "status") != "n_a")
                .collect();
            if id == "tax.docs_expected_count" {
                return count_out(live.len(), "Documents expected");
            }
            if id == "tax.doc_late_count" {
                let late: Vec<String> = live
                    .iter()
                    .filter(|r| {
                        docs.opt(r, "status") == "expected"
                            && docs
                                .date(r, "expected_by")
                                .is_some_and(|x| x + Duration::days(14) < today)
                    })
                    .map(|r| docs.text(r, "name"))
                    .collect();
                return Some(Out {
                    value: json!(late.len()),
                    display: late.len().to_string(),
                    math: late
                        .iter()
                        .map(|n| line(n, "not received".into(), Some("Document checklist")))
                        .collect(),
                });
            }
            if live.is_empty() {
                return None;
            }
            let got = live
                .iter()
                .filter(|r| {
                    matches!(
                        docs.opt(r, "status").as_str(),
                        "received" | "reviewed" | "sent_to_preparer"
                    )
                })
                .count();
            let p = got as f64 / live.len() as f64;
            num_out(
                p,
                pct(p),
                vec![line(
                    "Received",
                    format!("{got} of {}", live.len()),
                    Some("Document checklist"),
                )],
            )
        }
        "tax.next_deadline" | "tax.days_to_next_deadline" => {
            let mut dates: Vec<(NaiveDate, String)> = Vec::new();
            if let Some(dl) = db(d, "deadlines") {
                for r in &dl.rows {
                    if let Some(x) = dl.date(r, "date")
                        && x >= today
                        && !dl.check(r, "done")
                    {
                        dates.push((x, dl.text(r, "name")));
                    }
                }
            }
            if let Some(e) = db(d, "estimates") {
                for r in &e.rows {
                    if let Some(x) = e.date(r, "due")
                        && x >= today
                        && e.num(r, "paid").unwrap_or(0.0) <= 0.0
                    {
                        dates.push((x, format!("Estimated payment {}", e.text(r, "name"))));
                    }
                }
            }
            let (date, name) = dates.into_iter().min()?;
            let days = (date - today).num_days();
            if id == "tax.days_to_next_deadline" {
                return num_out(
                    days as f64,
                    format!("{days} days"),
                    vec![line(
                        &name,
                        date.format("%b %-d, %Y").to_string(),
                        Some("Deadlines"),
                    )],
                );
            }
            date_out(
                date,
                vec![line(&name, format!("in {days} days"), Some("Deadlines"))],
            )
        }
        "tax.est_balance" | "tax.est_effective_rate" => {
            let prior = ans_num(d, &["payments", "priorTax"])?;
            if id == "tax.est_effective_rate" {
                let agi = ans_num(d, &["payments", "priorAgi"]).filter(|a| *a > 0.0)?;
                let r = prior / agi;
                return num_out(
                    r,
                    pct(r),
                    vec![line(
                        "Prior-year tax ÷ AGI (baseline estimate)",
                        pct(r),
                        Some("Your answers"),
                    )],
                );
            }
            let ytd = ans_num(d, &["payments", "withholdingYtd"]).unwrap_or(0.0);
            let rest = ans_num(d, &["payments", "withholdingRemaining"]).unwrap_or(0.0);
            let paid_rows: f64 = db(d, "estimates")
                .map(|e| e.rows.iter().filter_map(|r| e.num(r, "paid")).sum())
                .unwrap_or(0.0);
            let est_paid = ans_num(d, &["payments", "estimatesPaid"])
                .unwrap_or(0.0)
                .max(paid_rows);
            let bal = prior - ytd - rest - est_paid;
            num_out(
                bal,
                money(bal, cur),
                vec![
                    line(
                        "Estimated total tax (prior-year baseline)",
                        money(prior, cur),
                        Some("Your answers"),
                    ),
                    line("Withholding so far", money(-ytd, cur), Some("Your answers")),
                    line(
                        "Expected remaining withholding",
                        money(-rest, cur),
                        Some("Your answers"),
                    ),
                    line(
                        "Estimated payments",
                        money(-est_paid, cur),
                        Some("Estimated payments"),
                    ),
                ],
            )
        }
        "tax.deductions_total" | "tax.receipt_missing_count" => {
            let ded = db(d, "deductions")?;
            if id == "tax.receipt_missing_count" {
                let n = ded
                    .rows
                    .iter()
                    .filter(|r| ded.num(r, "amount").unwrap_or(0.0) > 250.0 && !matches!(ded.val(r, "receipt"), Some(CellValue::Files { v }) if !v.is_empty()))
                    .count();
                return count_out(n, "Deductions over $250 without a receipt");
            }
            let total: f64 = ded
                .rows
                .iter()
                .map(|r| {
                    // `pct` is a fraction (1 = 100%), as in the mock's Deductions database.
                    ded.num(r, "amount").unwrap_or(0.0) * ded.num(r, "pct").unwrap_or(1.0)
                })
                .sum();
            num_out(
                total,
                money(total, cur),
                vec![line(
                    "Σ amount × deductible share",
                    money(total, cur),
                    Some("Deductions & credits"),
                )],
            )
        }
        "tax.standard_deduction" => {
            let pack = d.pack.as_ref()?;
            let status = d
                .answers
                .get("household")
                .and_then(|h| h.get("filingStatus"))
                .and_then(Value::as_str)
                .unwrap_or("single");
            let v = pack.get("standardDeduction")?.get(status)?;
            let x = v
                .as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))?;
            num_out(
                x,
                money(x, cur),
                vec![line(
                    &format!("Standard deduction ({status})"),
                    money(x, cur),
                    pack.get("name").and_then(Value::as_str),
                )],
            )
        }
        "tax.quarterly_next" | "tax.estimates_paid_count" => {
            let e = db(d, "estimates")?;
            if id == "tax.estimates_paid_count" {
                return count_out(
                    e.rows
                        .iter()
                        .filter(|r| e.num(r, "paid").unwrap_or(0.0) > 0.0)
                        .count(),
                    "Estimated payments recorded",
                );
            }
            let next = e
                .rows
                .iter()
                .filter(|r| {
                    e.date(r, "due").is_some_and(|x| x >= today)
                        && e.num(r, "paid").unwrap_or(0.0) <= 0.0
                })
                .min_by_key(|r| e.date(r, "due"))?;
            let s = e.num(next, "suggested").unwrap_or(0.0);
            num_out(
                s,
                money(s, cur),
                vec![line(
                    &e.text(next, "name"),
                    format!(
                        "{} due {}",
                        money(s, cur),
                        e.date(next, "due")
                            .map(|x| x.format("%b %-d").to_string())
                            .unwrap_or_default()
                    ),
                    Some("Estimated payments"),
                )],
            )
        }
        "tax.pack_stale" => {
            let pack = d.pack.as_ref()?;
            let verified = pack
                .get("verifiedOn")
                .and_then(Value::as_str)
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())?;
            let pack_year = pack.get("year").and_then(Value::as_i64).unwrap_or(0);
            let tax_year = ans_num(d, &["jurisdiction", "year"]).map_or(pack_year, |y| y as i64);
            let stale = (today - verified).num_days() > 400 || pack_year < tax_year;
            bool_out(
                stale,
                format!("verified {verified}, pack year {pack_year}, tax year {tax_year}"),
            )
        }
        "tax.taxes_fund" => {
            let goals = d.others.get("money-hq").and_then(|o| o.get("goals"))?;
            let s: f64 = goals
                .rows
                .iter()
                .filter(|r| norm(&goals.text(r, "name")).contains("tax"))
                .filter_map(|r| goals.num(r, "goal.saved"))
                .sum();
            num_out(
                s,
                money(s, cur),
                vec![line(
                    "Money HQ \"Taxes\" sinking fund",
                    money(s, cur),
                    Some("from Money HQ"),
                )],
            )
        }
        _ => None,
    }
}

fn sheets_fn(id: &str, d: &MetricData) -> Option<Out> {
    match id.strip_prefix("sheets.lint") {
        Some("") => {
            let n: u32 = d.lint.values().sum();
            Some(Out {
                value: json!(n),
                display: n.to_string(),
                math: d
                    .lint
                    .iter()
                    .map(|(r, c)| line(r, c.to_string(), Some("Sheet checks")))
                    .collect(),
            })
        }
        Some(rule) => {
            let n = d
                .lint
                .get(rule.trim_start_matches(':'))
                .copied()
                .unwrap_or(0);
            Some(Out {
                value: json!(n),
                display: n.to_string(),
                math: vec![line(
                    rule.trim_start_matches(':'),
                    n.to_string(),
                    Some("Sheet checks"),
                )],
            })
        }
        None => None,
    }
}

// ───────────────────────────────────────────────────────────────────────────── Life OS

fn hm(s: &str) -> Option<i64> {
    let (h, m) = s.split_once(':')?;
    Some(h.trim().parse::<i64>().ok()? * 60 + m.trim().parse::<i64>().ok()?)
}

fn life_fn(id: &str, d: &MetricData) -> Option<Out> {
    let today = d.today;
    let t = db(d, "tasks");
    let done = |db: &DbData, r: &RowData| db.opt(r, "status") == "done";
    match id {
        "life.task_count" => count_out(t?.rows.len(), "Tasks"),
        "life.done_count" => {
            let t = t?;
            count_out(
                t.rows.iter().filter(|r| done(t, r)).count(),
                "Completed tasks",
            )
        }
        "life.inbox_count" => {
            let t = t?;
            count_out(
                t.rows
                    .iter()
                    .filter(|r| t.opt(r, "status") == "inbox")
                    .count(),
                "Tasks in Inbox",
            )
        }
        "life.overdue_count" => {
            let t = t?;
            count_out(
                t.rows
                    .iter()
                    .filter(|r| !done(t, r) && t.date(r, "due").is_some_and(|x| x < today))
                    .count(),
                "Open tasks past their due date",
            )
        }
        "life.today_scheduled_min" => {
            let t = t?;
            let m: f64 = t
                .rows
                .iter()
                .filter(|r| !done(t, r) && t.date(r, "scheduled") == Some(today))
                .map(|r| t.num(r, "estimate").unwrap_or(30.0))
                .sum();
            num_out(
                m,
                format!("{} min", m.round()),
                vec![line(
                    "Σ estimates of tasks scheduled today",
                    format!("{} min", m.round()),
                    Some("Tasks"),
                )],
            )
        }
        "life.working_min_today" => {
            let h = d.answers.get("hours")?;
            let days: Vec<String> = h
                .get("days")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_lowercase)
                        .collect()
                })
                .unwrap_or_default();
            let wd = today.format("%a").to_string().to_lowercase();
            if !days.is_empty() && !days.iter().any(|x| x.starts_with(&wd[..2])) {
                return num_out(
                    0.0,
                    "0 min".into(),
                    vec![line("Not a working day", "0".into(), Some("Your answers"))],
                );
            }
            let s = hm(h.get("start").and_then(Value::as_str).unwrap_or("09:00"))?;
            let e = hm(h.get("end").and_then(Value::as_str).unwrap_or("17:00"))?;
            let m = (e - s).max(0) as f64;
            num_out(
                m,
                format!("{m} min"),
                vec![line(
                    "Working hours",
                    format!("{m} min"),
                    Some("Your answers"),
                )],
            )
        }
        "life.projects_without_next" => {
            let (t, p) = (t?, db(d, "projects")?);
            let names: Vec<String> = p
                .rows
                .iter()
                .filter(|r| {
                    !matches!(
                        p.opt(r, "status").as_str(),
                        "done" | "completed" | "archived"
                    )
                })
                .filter(|pr| {
                    !t.rows.iter().any(|tr| {
                        t.opt(tr, "status") == "next" && t.rel(tr, "project").contains(&pr.id)
                    })
                })
                .map(|r| p.text(r, "name"))
                .collect();
            Some(Out {
                value: json!(names.len()),
                display: names.len().to_string(),
                math: names
                    .iter()
                    .map(|n| line(n, "no Next task".into(), Some("Projects")))
                    .collect(),
            })
        }
        "life.last_review_date" | "life.days_since_review" => {
            let dn = db(d, "daily");
            let last = dn.and_then(|dn| {
                dn.rows
                    .iter()
                    .filter(|r| dn.check(r, "weekly_review"))
                    .filter_map(|r| dn.date(r, "date"))
                    .max()
            });
            let last = match last {
                Some(l) => l,
                None if id == "life.days_since_review" => {
                    // Never reviewed: count from installation.
                    let inst =
                        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(d.installed_at)?
                            .date_naive();
                    let days = (today - inst).num_days();
                    return num_out(
                        days as f64,
                        format!("{days} days"),
                        vec![line(
                            "No weekly review yet; installed",
                            format!("{days} days ago"),
                            None,
                        )],
                    );
                }
                None => return None,
            };
            if id == "life.days_since_review" {
                let days = (today - last).num_days();
                return num_out(
                    days as f64,
                    format!("{days} days"),
                    vec![line(
                        "Last weekly review",
                        last.to_string(),
                        Some("Daily notes"),
                    )],
                );
            }
            date_out(
                last,
                vec![line(
                    "Last weekly review",
                    last.to_string(),
                    Some("Daily notes"),
                )],
            )
        }
        _ => None,
    }
}

// ───────────────────────────────────────────────────────────────────────────── Habits

struct HabitData {
    name: String,
    schedule: Schedule,
    log: BTreeSet<NaiveDate>,
    frozen: BTreeSet<NaiveDate>,
    started: Option<NaiveDate>,
}

fn schedule_of(h: &DbData, r: &RowData, today: NaiveDate) -> Schedule {
    let target = h.num(r, "per_week").unwrap_or(3.0).max(1.0) as u32;
    match h.opt(r, "schedule").as_str() {
        "weekdays" => Schedule::Weekdays,
        "x_per_week" => Schedule::XPerWeek { times: target },
        "every_n_days" => Schedule::EveryNDays {
            n: h.num(r, "every_n").unwrap_or(2.0).max(1.0) as u32,
            anchor: h.date(r, "started").unwrap_or(today),
        },
        _ => Schedule::Daily,
    }
}

fn habit_data(d: &MetricData) -> Option<Vec<HabitData>> {
    let h = db(d, "habits")?;
    let log = db(d, "log");
    Some(
        h.rows
            .iter()
            .filter(|r| h.check(r, "active"))
            .map(|r| {
                let mut done = BTreeSet::new();
                let mut frozen = BTreeSet::new();
                if let Some(l) = log {
                    for e in l.rows.iter().filter(|e| l.rel(e, "habit").contains(&r.id)) {
                        let Some(date) = l.date(e, "date") else {
                            continue;
                        };
                        match l.opt(e, "status").as_str() {
                            "done" | "partial" => {
                                done.insert(date);
                            }
                            "frozen" | "skipped" => {
                                frozen.insert(date);
                            }
                            _ => {}
                        }
                    }
                }
                HabitData {
                    name: h.text(r, "name"),
                    schedule: schedule_of(h, r, d.today),
                    log: done,
                    frozen,
                    started: h.date(r, "started"),
                }
            })
            .collect(),
    )
}

fn grace_of(d: &MetricData, frozen: &BTreeSet<NaiveDate>) -> Grace {
    match d
        .answers
        .get("grace")
        .and_then(Value::as_str)
        .unwrap_or("never_miss_twice")
    {
        "strict" => Grace::Strict,
        "skip_days" => Grace::SkipDays {
            frozen: frozen.clone(),
        },
        _ => Grace::NeverMissTwice,
    }
}

fn habits_fn(id: &str, d: &MetricData) -> Option<Out> {
    let today = d.today;
    let hs = habit_data(d)?;
    let rate = |h: &HabitData, days: i64| {
        habits::completion_rate(&h.log, &h.schedule, today - Duration::days(days - 1), today)
    };
    match id {
        "habits.active_count" => count_out(hs.len(), "Active habits"),
        "habits.log_days" => count_out(
            hs.iter()
                .flat_map(|h| h.log.iter())
                .collect::<BTreeSet<_>>()
                .len(),
            "Days with a check-in",
        ),
        "habits.today_done_pct" => {
            let due: Vec<&HabitData> = hs
                .iter()
                .filter(|h| habits::is_due(&h.schedule, today))
                .collect();
            if due.is_empty() {
                return None;
            }
            let n = due.iter().filter(|h| h.log.contains(&today)).count();
            let p = n as f64 / due.len() as f64;
            num_out(
                p,
                pct(p),
                vec![line(
                    "Done today",
                    format!("{n} of {}", due.len()),
                    Some("Habit log"),
                )],
            )
        }
        "habits.best_streak" | "habits.max_current_streak" => {
            let best = hs
                .iter()
                .map(|h| {
                    let s = habits::streak(&h.log, &h.schedule, &grace_of(d, &h.frozen), today);
                    (
                        if id == "habits.best_streak" {
                            s.best
                        } else {
                            s.current
                        },
                        h.name.clone(),
                    )
                })
                .max()?;
            num_out(
                f64::from(best.0),
                best.0.to_string(),
                vec![line(&best.1, best.0.to_string(), Some("Habit log"))],
            )
        }
        "habits.rate_30d_avg" => {
            if hs.is_empty() {
                return None;
            }
            let avg = hs.iter().map(|h| rate(h, 30)).sum::<f64>() / hs.len() as f64;
            num_out(
                avg,
                pct(avg),
                hs.iter()
                    .map(|h| line(&h.name, pct(rate(h, 30)), Some("30-day rate")))
                    .collect(),
            )
        }
        "habits.missed_yesterday_count" => {
            let y = today - Duration::days(1);
            let missed: Vec<&HabitData> = hs
                .iter()
                .filter(|h| h.started.is_none_or(|s| s <= y) && !h.log.is_empty())
                .filter(|h| {
                    !matches!(h.schedule, Schedule::XPerWeek { .. })
                        && habits::is_due(&h.schedule, y)
                        && !h.log.contains(&y)
                        && !h.frozen.contains(&y)
                })
                .collect();
            Some(Out {
                value: json!(missed.len()),
                display: missed.len().to_string(),
                math: missed
                    .iter()
                    .map(|h| line(&h.name, "missed yesterday".into(), Some("Habit log")))
                    .collect(),
            })
        }
        "habits.low_rate_3w_count" | "habits.high_rate_21d_count" => {
            let low = id == "habits.low_rate_3w_count";
            let hit: Vec<&HabitData> = hs
                .iter()
                .filter(|h| h.started.is_none_or(|s| (today - s).num_days() >= 21))
                .filter(|h| {
                    if low {
                        rate(h, 21) < 0.4
                    } else {
                        rate(h, 21) >= 0.9
                    }
                })
                .collect();
            Some(Out {
                value: json!(hit.len()),
                display: hit.len().to_string(),
                math: hit
                    .iter()
                    .map(|h| line(&h.name, pct(rate(h, 21)), Some("21-day rate")))
                    .collect(),
            })
        }
        "habits.new_active_14d_count" => count_out(
            hs.iter()
                .filter(|h| h.started.is_some_and(|s| (today - s).num_days() <= 14))
                .count(),
            "Habits started in the last 14 days",
        ),
        _ => None,
    }
}

// ───────────────────────────────────────────────────────────────────────────── evaluation

/// The Metric-dialect context of an instance (answers + metrics + pack).
#[must_use]
pub fn context(d: &MetricData, values: &BTreeMap<String, MetricValue>) -> AnswerContext {
    let mut answers = d.answers.clone();
    let installed = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(d.installed_at)
        .map(|t| t.date_naive().format("%Y-%m-%d").to_string());
    if let Some(i) = installed {
        answers
            .entry("installed_on".to_owned())
            .or_insert(Value::String(i));
    }
    AnswerContext {
        answers: flatten(&answers),
        metrics: values
            .iter()
            .map(|(k, v)| (k.clone(), to_row_value(&v.value)))
            .collect(),
        pack: d.pack.clone(),
        today: d.today,
    }
}

fn expr_value(v: &RowValue) -> (Value, String) {
    match v {
        RowValue::Empty => (Value::Null, "—".into()),
        RowValue::Number(n) => (json!(n), emp_sheets::value::number_to_text(*n)),
        RowValue::Bool(b) => (json!(b), if *b { "Yes".into() } else { "No".into() }),
        RowValue::Date(dv) => (json!(dv.iso()), dv.iso()),
        other => (json!(other.display()), other.display()),
    }
}

/// Computes every metric of a manifest (rust metrics first, then expression metrics in dependency order).
/// `overrides` (function id → value, from the app's [`MetricProvider`]) win over the built-in functions.
pub fn compute_all(
    m: &LifeAppManifest,
    d: &MetricData,
    overrides: &BTreeMap<String, MetricValue>,
) -> BTreeMap<String, MetricValue> {
    let mut out = BTreeMap::new();
    for def in m.metrics.iter().filter(|x| x.kind == MetricKind::Rust) {
        let f = def.func.as_deref().unwrap_or_default();
        let v = overrides
            .get(f)
            .cloned()
            .or_else(|| builtin(f, d))
            .unwrap_or_else(|| MetricValue::empty(d.now_ms));
        out.insert(def.name.clone(), v);
    }
    let exprs: Vec<_> = m
        .metrics
        .iter()
        .filter(|x| x.kind == MetricKind::Expr)
        .collect();
    let mut pending: Vec<_> = exprs.clone();
    for _ in 0..=exprs.len() {
        let mut next = Vec::new();
        for def in pending {
            let src = def.expr.as_deref().unwrap_or_default();
            let deps = metric::metric_deps(src);
            if deps
                .iter()
                .any(|x| !out.contains_key(x) && exprs.iter().any(|e| &e.name == x))
            {
                next.push(def);
                continue;
            }
            let ctx = context(d, &out);
            let v = match metric::eval(src, &ctx) {
                Ok(rv) => {
                    let (value, display) = expr_value(&rv);
                    let math = deps
                        .iter()
                        .filter_map(|x| {
                            out.get(x)
                                .map(|mv| line(x, mv.display.clone(), Some("metric")))
                        })
                        .collect();
                    MetricValue {
                        value,
                        display,
                        math,
                        as_of: d.now_ms,
                    }
                }
                Err(_) => MetricValue::empty(d.now_ms),
            };
            out.insert(def.name.clone(), v);
        }
        if next.is_empty() {
            break;
        }
        pending = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debt_simulation() {
        // $1,000 at 0% paying $100/month → 10 months, no interest.
        assert_eq!(
            simulate_debts(&[(1000.0, 0.0, 100.0)], 0.0, "avalanche"),
            Some((10, 0.0))
        );
        let (m1, i1) = simulate_debts(
            &[(5000.0, 24.0, 150.0), (2000.0, 6.0, 50.0)],
            200.0,
            "avalanche",
        )
        .unwrap();
        let (m2, i2) = simulate_debts(
            &[(5000.0, 24.0, 150.0), (2000.0, 6.0, 50.0)],
            200.0,
            "snowball",
        )
        .unwrap();
        assert!(i1 <= i2 + 1e-6, "avalanche pays the least interest");
        assert!(m1 > 0 && m2 > 0);
        // Payment below interest never ends.
        assert_eq!(
            simulate_debts(&[(10000.0, 30.0, 10.0)], 0.0, "avalanche"),
            None
        );
    }

    #[test]
    fn xirr_basic() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        let r = xirr(&[(d(2025, 1, 1), -1000.0), (d(2026, 1, 1), 1100.0)]).unwrap();
        assert!((r - 0.1).abs() < 1e-4, "{r}");
        assert!(xirr(&[(d(2025, 1, 1), 100.0)]).is_none());
    }

    #[test]
    fn names_and_registry() {
        assert_eq!(norm("Credit card"), "credit_card");
        assert_eq!(norm("Savings & Debt"), "savings_debt");
        assert_eq!(norm(" N/A "), "n_a");
        assert!(known_fn("money.net_worth"));
        assert!(known_fn("sheets.lint:div0"));
        assert!(!known_fn("sheets.lint:"));
        assert!(!known_fn("nope"));
    }
}
