//! Finance commands (SPEC §11.3 "Finance", §15, §16.2).
//!
//! `emp-finance` is pure; this module is the glue of §15: it loads the databases of a life-app instance from
//! `emp-store` through the instance's record key map (`lifeapp_key_map`: the generated databases and their
//! properties by manifest key), reads columns **by semantic role** (§15.0) or manifest property key, falling back to
//! roles and manifest titles / property names for databases the key map does not name, converts rows into finance
//! inputs, runs the engines and writes results back as rows. The budget method and month start come from the
//! stored configuration, else from the wizard answers (`lifeapp_answers`).
//!
//! App-side state that has no database of its own lives in the encrypted kv store:
//! * `fin.rules` — categorisation rules per instance (the IPC `Rule` shape, richer than the *Rules* database);
//! * `fin.profiles` — CSV import profiles by header fingerprint (§15.2);
//! * `fin.budget` — the budget configuration per instance (method, month start day);
//! * `fin.networth` — the last month the automatic net-worth snapshot ran, per instance.
//!
//! Statement imports are staged in memory between `finance_import_start`, `_preview` and `_commit` (bounded, 30 min).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use chrono::{Datelike, NaiveDate};
use emp_finance::budget::{self, Assignment, BudgetConfig, BudgetInput, BudgetMethod, BudgetMonth};
use emp_finance::calendar::HolidayCalendar;
use emp_finance::import::{ImportFormat, ImportMapping, ImportOptions, StatementTxn};
use emp_finance::ledger::{Account, AccountType, Category, Txn, balance_as_of};
use emp_finance::money::Currency;
use emp_finance::period::{YearMonth, budget_period};
use emp_finance::rules::{CategoryLearner, Rule, RuleSet, RuleTxn};
use emp_finance::{Decimal, FinanceError};
use emp_store::dbmodel::{
    CellValue, DbSchema, Property, RecurrenceMode, RecurrenceValue, RowDto, RowUpdate, rich,
    rich_plain,
};
use emp_store::model::{PageKind, PageMeta};
use emp_store::query::config::HasConfig;
use emp_store::{MetricValue, Store};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, Webview};

use super::import::{caps, peek_file};
use super::job_sink;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::grants::GrantPurpose;
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// kv namespace of categorisation rules.
pub const RULES_NS: &str = "fin.rules";
/// kv namespace of CSV import profiles.
pub const PROFILES_NS: &str = "fin.profiles";
/// kv namespace of budget configuration.
pub const BUDGET_NS: &str = "fin.budget";
/// kv namespace recording, per Money HQ instance, the month whose automatic net-worth snapshot check ran.
pub const NETWORTH_NS: &str = "fin.networth";
/// Most months one automatic net-worth catch-up writes.
pub const MAX_AUTO_SNAPSHOT_MONTHS: usize = 120;
/// Staged statement imports.
pub const MAX_IMPORTS: usize = 8;
/// Lifetime of a staged statement import.
pub const IMPORT_TTL: Duration = Duration::from_secs(30 * 60);
/// Rules per instance.
pub const MAX_RULES: usize = 500;

// ───────────────────────────────────────────────────────────────────────────── shared helpers

/// Maps an `emp-finance` error to the IPC error.
#[must_use]
pub fn fin_err(e: FinanceError) -> ApiError {
    match e {
        FinanceError::Invalid(m) => ApiError::new(ErrorCode::Invalid, m),
        FinanceError::Parse { message, .. } => ApiError::new(ErrorCode::Invalid, message),
        FinanceError::TooLarge(m) => ApiError::new(ErrorCode::TooLarge, m),
        FinanceError::NeedsConfirmation(m) => ApiError::new(ErrorCode::TooLarge, m),
        FinanceError::Cancelled => ApiError::new(ErrorCode::Cancelled, "Cancelled"),
        FinanceError::Unsupported(m) => ApiError::unsupported(m),
        e @ FinanceError::MissingRate { .. } => ApiError::new(ErrorCode::Invalid, e.to_string()),
    }
}

/// Local "today" (the vault's clock, local time zone of the device).
#[must_use]
pub fn local_today(store: &Store) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(store.now())
        .map(|t| t.with_timezone(&chrono::Local).date_naive())
        .unwrap_or_else(|| chrono::Local::now().date_naive())
}

/// A decimal / money string field.
pub fn dec(field: &str, s: &str) -> ApiResult<Decimal> {
    validate::money(field, s.trim())?;
    s.trim()
        .parse()
        .map_err(|_| ApiError::invalid(field, "invalid amount"))
}

/// A `YYYY-MM` field.
pub fn month(field: &str, s: &str) -> ApiResult<YearMonth> {
    if s.len() != 7 {
        return Err(ApiError::invalid(field, "must be a month (YYYY-MM)"));
    }
    s.parse()
        .map_err(|_| ApiError::invalid(field, "must be a month (YYYY-MM)"))
}

/// IPC `Money`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MoneyDto {
    /// Decimal string.
    pub amount: String,
    /// Currency code.
    pub currency: String,
}

impl MoneyDto {
    /// From a decimal (rounded to cents for display stability).
    #[must_use]
    pub fn of(d: Decimal, currency: &str) -> Self {
        Self {
            amount: d.round_dp(2).normalize().to_string(),
            currency: currency.to_owned(),
        }
    }
}

fn s(d: Decimal) -> String {
    d.round_dp(2).normalize().to_string()
}

// ───────────────────────────────────────────────────────────────────────────── instance databases

/// One database of an instance with its rows.
#[derive(Clone, Debug)]
pub struct InstanceDb {
    /// Schema (properties, roles, views).
    pub schema: DbSchema,
    /// Live rows in manual order.
    pub rows: Vec<RowDto>,
    /// Manifest property key → property id, from the instance's record key map (empty for databases the app did
    /// not generate).
    pub prop_keys: BTreeMap<String, String>,
}

impl InstanceDb {
    /// Database id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.schema.database.id
    }

    /// The property for `role`, else the property named one of `names` (case-insensitive).
    #[must_use]
    pub fn col(&self, role: &str, names: &[&str]) -> Option<&Property> {
        if let Some(id) = self.schema.database.roles.get(role)
            && let Some(p) = self.schema.property(id)
        {
            return Some(p);
        }
        if let Some(p) = self
            .schema
            .properties
            .iter()
            .find(|p| p.role.as_deref() == Some(role))
        {
            return Some(p);
        }
        names.iter().find_map(|n| self.schema.property_named(n))
    }

    /// The id of [`InstanceDb::col`].
    #[must_use]
    pub fn col_id(&self, role: &str, names: &[&str]) -> Option<String> {
        self.col(role, names).map(|p| p.id.clone())
    }

    /// The property generated from the manifest property `key` (found even after the user renamed it), else the
    /// property named one of `names` — for columns without a semantic role.
    #[must_use]
    pub fn keyed(&self, key: &str, names: &[&str]) -> Option<&Property> {
        self.prop_keys
            .get(key)
            .and_then(|id| self.schema.property(id))
            .or_else(|| names.iter().find_map(|n| self.schema.property_named(n)))
    }

    /// The id of [`InstanceDb::keyed`].
    #[must_use]
    pub fn keyed_id(&self, key: &str, names: &[&str]) -> Option<String> {
        self.keyed(key, names).map(|p| p.id.clone())
    }

    /// The title property id.
    #[must_use]
    pub fn title_id(&self) -> &str {
        &self.schema.database.primary_prop_id
    }

    /// Title of a row.
    #[must_use]
    pub fn title(&self, r: &RowDto) -> String {
        text(r.values.get(self.title_id()))
    }

    /// The option name of a select / status cell.
    #[must_use]
    pub fn option_name(&self, r: &RowDto, p: Option<&Property>) -> Option<String> {
        let p = p?;
        let id = match r.values.get(&p.id)? {
            CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) } => id,
            _ => return None,
        };
        p.select_options()
            .into_iter()
            .find(|o| &o.id == id)
            .map(|o| o.name)
    }

    /// The colour of a select cell.
    #[must_use]
    pub fn option_color(&self, r: &RowDto, p: Option<&Property>) -> Option<String> {
        let p = p?;
        let id = match r.values.get(&p.id)? {
            CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) } => id,
            _ => return None,
        };
        p.select_options()
            .into_iter()
            .find(|o| &o.id == id)
            .and_then(|o| serde_json::to_value(o.color).ok())
            .and_then(|v| v.as_str().map(str::to_owned))
    }

    /// The option id of `p` whose normalised name equals `name`.
    #[must_use]
    pub fn option_id(p: &Property, name: &str) -> Option<String> {
        let want = norm(name);
        p.select_options()
            .into_iter()
            .find(|o| norm(&o.name) == want)
            .map(|o| o.id)
    }
}

/// Normalises an option name (`Credit card` → `credit_card`).
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

/// Plain text of a cell.
#[must_use]
pub fn text(v: Option<&CellValue>) -> String {
    match v {
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

/// A decimal from a money / number / computed cell.
#[must_use]
pub fn amount(v: Option<&CellValue>) -> Option<Decimal> {
    match v? {
        CellValue::Money { v: Some(s), .. } => s.parse().ok(),
        CellValue::Number { v: Some(x) }
        | CellValue::Rating { v: Some(x) }
        | CellValue::Progress { v: Some(x) } => {
            x.is_finite().then(|| emp_finance::money::from_f64(*x))
        }
        CellValue::Computed { v } => v.value.as_str().and_then(|s| s.parse().ok()).or_else(|| {
            v.value
                .as_f64()
                .filter(|x| x.is_finite())
                .map(emp_finance::money::from_f64)
        }),
        CellValue::Text { v } => rich_plain(v).trim().parse().ok(),
        _ => None,
    }
}

/// The start date of a date cell.
#[must_use]
pub fn date(v: Option<&CellValue>) -> Option<NaiveDate> {
    match v? {
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

/// The first related id.
#[must_use]
pub fn rel(v: Option<&CellValue>) -> Option<String> {
    match v? {
        CellValue::Relation { v } => v.first().cloned(),
        _ => None,
    }
}

/// A checkbox.
#[must_use]
pub fn check(v: Option<&CellValue>) -> bool {
    matches!(v, Some(CellValue::Check { v: true }))
}

/// Finds the workspace and app id of an instance.
pub fn find_instance(store: &Store, instance_id: &str) -> ApiResult<(String, String)> {
    for ws in store.workspace_list()? {
        if let Some(i) = store
            .lifeapp_instances(&ws.id)?
            .into_iter()
            .find(|i| i.id == instance_id)
        {
            if i.detached {
                return Err(ApiError::invalid("instanceId", "this app was detached"));
            }
            return Ok((ws.id, i.app_id));
        }
    }
    Err(ApiError::not_found("life app instance"))
}

/// The live databases of an instance.
pub fn instance_databases(
    store: &Store,
    workspace_id: &str,
    instance_id: &str,
) -> ApiResult<Vec<PageMeta>> {
    Ok(store
        .page_tree(workspace_id)?
        .into_iter()
        .filter(|m| {
            m.kind == PageKind::Database
                && m.deleted_at.is_none()
                && m.app_instance_id.as_deref() == Some(instance_id)
        })
        .collect())
}

/// Classifies a database of a finance app by its roles, then by its title (the fallback for databases the instance's
/// key map does not name, e.g. ones added by hand or by an older manifest).
#[must_use]
pub fn classify(schema: &DbSchema, titles: &BTreeMap<String, String>) -> Option<String> {
    let roles = &schema.database.roles;
    let has = |r: &str| {
        roles.contains_key(r)
            || schema
                .properties
                .iter()
                .any(|p| p.role.as_deref() == Some(r))
    };
    for (role, key) in [
        ("txn.amount", "transactions"),
        ("acct.type", "accounts"),
        ("cat.group", "categories"),
        ("rec.amount", "recurring"),
        ("goal.target", "goals"),
        ("inv.type", "investments"),
        ("sec.ticker", "securities"),
        ("alloc.target", "allocation"),
    ] {
        if has(role) {
            return Some(key.to_owned());
        }
    }
    let t = schema.database.title.trim().to_lowercase();
    titles
        .iter()
        .find(|(_, title)| title.to_lowercase() == t)
        .map(|(k, _)| canonical_key(k).to_owned())
}

/// The key this module files a manifest database template under (the Portfolio manifest's `inv_txns` and `targets`
/// are read as `investments` and `allocation`, the names their roles classify to).
#[must_use]
pub fn canonical_key(template_key: &str) -> &str {
    match template_key {
        "inv_txns" => "investments",
        "targets" => "allocation",
        k => k,
    }
}

/// Template key → title of the database templates of `app_id`'s manifest.
pub fn manifest_titles(store: &Store, app_id: &str) -> BTreeMap<String, String> {
    let Ok(m) = store.lifeapp_manifest(app_id) else {
        return BTreeMap::new();
    };
    let Ok(v) = serde_json::to_value(&m) else {
        return BTreeMap::new();
    };
    v.get("templates")
        .and_then(Value::as_array)
        .map(|ts| {
            ts.iter()
                .filter(|t| t.get("kind").and_then(Value::as_str) == Some("database"))
                .filter_map(|t| {
                    Some((
                        t.get("key")?.as_str()?.to_owned(),
                        t.pointer("/spec/title")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The databases of an instance without their rows: `(key, schema, manifest property key → property id)`, keyed the
/// way [`load_instance`] files them. Cheap (schemas only), so it also fingerprints the instance for [`Ledger::load`].
pub struct InstanceLayout {
    /// Workspace of the instance.
    pub workspace_id: String,
    /// The databases.
    pub dbs: Vec<(String, DbSchema, BTreeMap<String, String>)>,
}

/// Finds the databases of an instance (see [`load_instance`]) without loading their rows.
pub fn instance_layout(store: &Store, instance_id: &str) -> ApiResult<InstanceLayout> {
    let (ws, app_id) = find_instance(store, instance_id)?;
    let titles = manifest_titles(store, &app_id);
    let key_map = store.lifeapp_key_map(instance_id).unwrap_or_else(|e| {
        tracing::debug!(
            code = e.code(),
            "life-app key map unavailable; classifying by role"
        );
        BTreeMap::new()
    });
    let metas = instance_databases(store, &ws, instance_id)?;
    let live: HashSet<&str> = metas.iter().map(|m| m.id.as_str()).collect();
    let mut out: Vec<(String, DbSchema, BTreeMap<String, String>)> = Vec::new();
    let mut keys: HashSet<String> = HashSet::new();
    let mut claimed: HashSet<String> = HashSet::new();
    for tkey in titles.keys() {
        let Some(id) = key_map.get(tkey).filter(|id| live.contains(id.as_str())) else {
            continue;
        };
        let key = canonical_key(tkey);
        if keys.contains(key) {
            continue;
        }
        let prefix = format!("{tkey}.prop:");
        let prop_keys = key_map
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .map(|(k, v)| (k[prefix.len()..].to_owned(), v.clone()))
            .collect();
        out.push((key.to_owned(), store.db_get_schema(id)?, prop_keys));
        keys.insert(key.to_owned());
        claimed.insert(id.clone());
    }
    for meta in &metas {
        if claimed.contains(&meta.id) {
            continue;
        }
        let schema = store.db_get_schema(&meta.id)?;
        let Some(key) = classify(&schema, &titles) else {
            continue;
        };
        if keys.contains(&key) {
            continue;
        }
        keys.insert(key.clone());
        out.push((key, schema, BTreeMap::new()));
    }
    Ok(InstanceLayout {
        workspace_id: ws,
        dbs: out,
    })
}

/// Loads every database of an instance, keyed by template key.
///
/// The databases the app generated are found exactly through the instance's record key map
/// (`Store::lifeapp_key_map`: template key → database id, `<key>.prop:<prop>` → property id), so renaming a database
/// or a column does not lose it. Live databases of the instance that the key map does not name are classified by
/// role, then by manifest title.
pub fn load_instance(
    store: &Store,
    instance_id: &str,
) -> ApiResult<(String, BTreeMap<String, InstanceDb>)> {
    let lay = instance_layout(store, instance_id)?;
    Ok((lay.workspace_id, load_rows(store, lay.dbs)?))
}

fn load_rows(
    store: &Store,
    dbs: Vec<(String, DbSchema, BTreeMap<String, String>)>,
) -> ApiResult<BTreeMap<String, InstanceDb>> {
    let mut out = BTreeMap::new();
    for (key, schema, prop_keys) in dbs {
        let rows = super::db::all_rows(store, &schema.database.id, None)?;
        out.insert(
            key,
            InstanceDb {
                schema,
                rows,
                prop_keys,
            },
        );
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────────────── ledger

/// The finance data of a Money HQ instance as `emp-finance` inputs.
#[derive(Clone, Debug, Default)]
pub struct Ledger {
    /// Base currency.
    pub currency: String,
    /// Accounts.
    pub accounts: Vec<Account>,
    /// Transactions.
    pub txns: Vec<Txn>,
    /// Categories.
    pub categories: Vec<Category>,
    /// Category colours.
    pub colors: HashMap<String, String>,
    /// Budget assignments.
    pub assignments: Vec<Assignment>,
    /// Payee names by row id.
    pub payees: HashMap<String, String>,
    /// Per-transaction fields `emp-finance` does not model (cleared state, review flag, source, tags).
    pub txn_meta: HashMap<String, TxnMeta>,
    /// Per-account fields `emp-finance` does not model.
    pub acct_meta: HashMap<String, AcctMeta>,
    /// Per-category fields `emp-finance` does not model.
    pub cat_meta: HashMap<String, CatMeta>,
    /// Revision fingerprint of the databases this ledger was built from (see [`Ledger::load`]).
    pub rev: String,
    /// The raw databases.
    pub dbs: BTreeMap<String, InstanceDb>,
}

/// Transaction fields kept beside [`Txn`].
#[derive(Clone, Debug, Default)]
pub struct TxnMeta {
    /// `txn.cleared` option key: `uncleared`, `cleared` or `reconciled`.
    pub cleared: String,
    /// `txn.reviewed`, `None` when the database has no Reviewed property.
    pub reviewed: Option<bool>,
    /// `txn.source` option key (`manual`, `import`, `rule`), empty when unset.
    pub source: String,
    /// Tag option names.
    pub tags: Vec<String>,
    /// Row revision.
    pub rev: i64,
}

/// Account fields kept beside [`Account`].
#[derive(Clone, Debug, Default)]
pub struct AcctMeta {
    /// `acct.type` option key.
    pub kind: String,
    /// Institution text.
    pub institution: String,
    /// Last reconciled date.
    pub reconciled: Option<NaiveDate>,
    /// The currency as entered (empty = base).
    pub currency: String,
}

/// Category fields kept beside [`Category`].
#[derive(Clone, Debug, Default)]
pub struct CatMeta {
    /// Colour key.
    pub color: String,
    /// Icon name.
    pub icon: String,
    /// Monthly target.
    pub target: Decimal,
}

/// Known option keys of a select/status property, each with the option names the generated databases (and older
/// installs) use for it. See [`option_key`].
pub type OptionKeys = &'static [(&'static str, &'static [&'static str])];

/// `acct.type`.
pub const ACCT_TYPES: OptionKeys = &[
    ("checking", &[]),
    ("savings", &[]),
    ("credit_card", &["Card"]),
    ("student_loan", &[]),
    ("auto_loan", &["Car loan"]),
    ("mortgage", &[]),
    ("personal_loan", &[]),
    ("investment", &[]),
    ("cash", &[]),
    ("other_asset", &[]),
    ("other_liability", &[]),
];
/// `txn.cleared`.
pub const CLEARED: OptionKeys = &[("uncleared", &[]), ("cleared", &[]), ("reconciled", &[])];
/// `txn.source`.
pub const TXN_SOURCES: OptionKeys = &[("manual", &[]), ("import", &[]), ("rule", &[])];
/// `rec.kind`.
pub const REC_KINDS: OptionKeys = &[
    ("bill", &[]),
    ("income", &[]),
    ("subscription", &[]),
    ("transfer", &[]),
    ("savings", &[]),
];
/// `goal.kind`.
pub const GOAL_KINDS: OptionKeys = &[
    ("emergency", &["Emergency fund"]),
    ("sinking", &["Sinking fund"]),
    ("savings", &["Savings goal"]),
];
/// Goal priority.
pub const PRIORITIES: OptionKeys = &[("high", &[]), ("medium", &[]), ("low", &[])];

/// The semantic key of an option: its id when that is one of `known` (ids equal manifest keys on new installs and in
/// the browser mock), else the known key whose name (or alias) matches the option's name, else the option's
/// normalised name. Comparing keys, never raw option ids, is what keeps older installs (generated ids) working.
#[must_use]
pub fn key_of_option(id: &str, name: &str, known: OptionKeys) -> String {
    if let Some((k, _)) = known.iter().find(|(k, _)| *k == id) {
        return (*k).to_owned();
    }
    let n = norm(name);
    known
        .iter()
        .find(|(k, aliases)| *k == n || aliases.iter().any(|a| norm(a) == n))
        .map_or(n, |(k, _)| (*k).to_owned())
}

/// The key of a select/status cell (see [`key_of_option`]).
#[must_use]
pub fn option_key(r: &RowDto, p: Option<&Property>, known: OptionKeys) -> Option<String> {
    let p = p?;
    let id = match r.values.get(&p.id)? {
        CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) } => id,
        _ => return None,
    };
    let o = p.select_options().into_iter().find(|o| &o.id == id)?;
    Some(key_of_option(&o.id, &o.name, known))
}

/// The option id of `p` whose key is `key` (see [`key_of_option`]).
#[must_use]
pub fn option_for_key(p: &Property, key: &str, known: OptionKeys) -> Option<String> {
    p.select_options()
        .into_iter()
        .find(|o| key_of_option(&o.id, &o.name, known) == key)
        .map(|o| o.id)
}

/// A select or status cell holding option `id` of `p`.
#[must_use]
pub fn option_cell(p: &Property, id: String) -> CellValue {
    if p.kind == emp_store::dbmodel::PropType::Status {
        CellValue::Status { v: Some(id) }
    } else {
        CellValue::Select { v: Some(id) }
    }
}

fn account_type(name: Option<&str>) -> AccountType {
    serde_json::from_value(json!(norm(name.unwrap_or("checking"))))
        .unwrap_or(AccountType::OtherAsset)
}

/// Revision fingerprint of a ledger: every instance database's `(key, id, data_rev, schema_rev)` and the base currency.
type LedgerKey = (Vec<(String, String, i64, i64)>, String);

/// Ledgers built this session, by instance id (the ledger cache of ULTRANOTE-1.0 §5). Each entry is valid while its
/// databases' revisions are unchanged, so a write anywhere in the instance invalidates it; dropped on lock.
static LEDGERS: LazyLock<Mutex<HashMap<String, (LedgerKey, Arc<Ledger>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Instances whose ledger is cached at once.
const MAX_CACHED_LEDGERS: usize = 8;

/// Drops every cached ledger (vault lock, tests).
pub fn clear_ledger_cache() {
    LEDGERS.lock().clear();
}

/// The vault's base currency (USD when unset or invalid).
fn base_currency(store: &Store) -> String {
    store
        .vault_settings()
        .map(|v| v.base_currency)
        .ok()
        .filter(|c| Currency::new(c).is_ok())
        .unwrap_or_else(|| "USD".into())
}

impl Ledger {
    /// The ledger of `instance_id`, from the session cache while none of the instance's databases changed (one
    /// schema read per database to check), else freshly loaded.
    pub fn load(store: &Store, instance_id: &str) -> ApiResult<Arc<Self>> {
        let lay = instance_layout(store, instance_id)?;
        let currency = base_currency(store);
        let key: LedgerKey = (
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
        if let Some((k, l)) = LEDGERS.lock().get(instance_id)
            && *k == key
        {
            return Ok(Arc::clone(l));
        }
        let dbs = load_rows(store, lay.dbs)?;
        let mut l = Self::build(dbs, currency)?;
        l.rev = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            key.hash(&mut h);
            format!("{:016x}", h.finish())
        };
        let l = Arc::new(l);
        let mut cache = LEDGERS.lock();
        if cache.len() >= MAX_CACHED_LEDGERS && !cache.contains_key(instance_id) {
            cache.clear();
        }
        cache.insert(instance_id.to_owned(), (key, Arc::clone(&l)));
        Ok(l)
    }

    /// Builds a ledger from loaded databases.
    fn build(dbs: BTreeMap<String, InstanceDb>, currency: String) -> ApiResult<Self> {
        let mut l = Ledger {
            currency: currency.clone(),
            ..Ledger::default()
        };
        let base = Currency::new(&currency).map_err(fin_err)?;
        fn get<'a>(r: &'a RowDto, c: &Option<String>) -> Option<&'a CellValue> {
            c.as_ref().and_then(|c| r.values.get(c))
        }
        if let Some(d) = dbs.get("payees") {
            for r in &d.rows {
                l.payees.insert(r.id.clone(), d.title(r));
            }
        }
        if let Some(d) = dbs.get("accounts") {
            let ty = d.col("acct.type", &["Type"]);
            let cur = d.col_id("acct.currency", &["Currency"]);
            let opening = d.col_id("acct.opening", &["Opening balance"]);
            let apr = d.col_id("acct.apr", &["APR"]);
            let minp = d.col_id("acct.min_payment", &["Min payment"]);
            let limit = d.col_id("acct.limit", &["Credit limit"]);
            let onb = d.col_id("acct.on_budget", &["On budget"]);
            let low = d.col_id("acct.low_threshold", &["Low-balance threshold"]);
            let closed = d.keyed_id("closed", &["Closed"]);
            let inst = d.keyed_id("institution", &["Institution"]);
            let reconciled = d
                .col_id("acct.reconciled", &[])
                .or_else(|| d.keyed_id("last_reconciled", &["Last reconciled"]));
            for r in &d.rows {
                let c = text(get(r, &cur));
                let kind = account_type(option_key(r, ty, ACCT_TYPES).as_deref());
                l.acct_meta.insert(
                    r.id.clone(),
                    AcctMeta {
                        kind: serde_json::to_value(kind)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_owned))
                            .unwrap_or_else(|| "other_asset".into()),
                        institution: text(get(r, &inst)),
                        reconciled: date(get(r, &reconciled)),
                        currency: c.trim().to_uppercase(),
                    },
                );
                l.accounts.push(Account {
                    id: r.id.clone(),
                    name: d.title(r),
                    kind,
                    currency: Currency::new(c.trim()).unwrap_or_else(|_| base.clone()),
                    // Card and loan openings are amounts owed, whichever sign they were entered with.
                    opening_balance: emp_finance::ledger::opening_as_counted(
                        kind,
                        amount(get(r, &opening)).unwrap_or_default(),
                    ),
                    opening_date: None,
                    apr_pct: amount(get(r, &apr)),
                    min_payment: amount(get(r, &minp)),
                    credit_limit: amount(get(r, &limit)),
                    on_budget: onb.as_ref().is_none_or(|_| check(get(r, &onb))),
                    low_threshold: amount(get(r, &low)),
                    closed: check(get(r, &closed)),
                });
            }
        }
        if let Some(d) = dbs.get("categories") {
            let group = d.col("cat.group", &["Group"]);
            let ess = d.col_id("cat.essential", &["Essential"]);
            let roll = d.col_id("cat.rollover", &["Rollover"]);
            let color = d.keyed("color", &["Color"]);
            let icon = d.col_id("cat.icon", &[]).or_else(|| d.keyed_id("icon", &["Icon"]));
            let target = d.col_id("cat.target", &["Target"]);
            for r in &d.rows {
                l.cat_meta.insert(
                    r.id.clone(),
                    CatMeta {
                        color: d
                            .option_color(r, color)
                            .or_else(|| d.option_color(r, group))
                            .unwrap_or_else(|| "gray".into()),
                        icon: text(get(r, &icon)),
                        target: amount(get(r, &target)).unwrap_or_default(),
                    },
                );
                let g = d.option_name(r, group).unwrap_or_default();
                let gn = norm(&g);
                if let Some(c) = d
                    .option_color(r, color)
                    .or_else(|| d.option_color(r, group))
                {
                    l.colors.insert(r.id.clone(), c);
                }
                l.categories.push(Category {
                    id: r.id.clone(),
                    name: d.title(r),
                    is_income: gn.contains("income"),
                    is_saving: gn.contains("saving"),
                    group: g,
                    essential: ess.as_ref().is_some_and(|c| check(r.values.get(c))),
                    rollover: roll.as_ref().is_some_and(|c| check(r.values.get(c))),
                    variable: true,
                });
            }
        }
        if let Some(d) = dbs.get("transactions") {
            let c = |role: &str, n: &str| d.col_id(role, &[n]);
            let (dt, am, acct, cat, payee, memo, tr, imp, sp) = (
                c("txn.date", "Date"),
                c("txn.amount", "Amount"),
                c("txn.account", "Account"),
                c("txn.category", "Category"),
                c("txn.payee", "Payee"),
                c("txn.memo", "Memo"),
                c("txn.transfer", "Transfer"),
                c("txn.import_id", "Import ID"),
                c("txn.split_parent", "Split parent"),
            );
            let raw = d
                .col_id("txn.raw", &[])
                .unwrap_or_else(|| d.title_id().to_owned());
            let cleared = d.col("txn.cleared", &["Cleared"]);
            let source = d.col("txn.source", &["Source"]);
            let reviewed = d.col_id("txn.reviewed", &["Reviewed"]);
            let tags = d.col("txn.tags", &[]).or_else(|| d.keyed("tags", &["Tags"]));
            let mut parents = HashSet::new();
            for r in &d.rows {
                if let Some(p) = rel(get(r, &sp)) {
                    parents.insert(p);
                }
            }
            for r in &d.rows {
                let (Some(date), Some(amount)) = (date(get(r, &dt)), amount(get(r, &am))) else {
                    continue;
                };
                let raw_s = text(r.values.get(&raw));
                l.txn_meta.insert(
                    r.id.clone(),
                    TxnMeta {
                        cleared: option_key(r, cleared, CLEARED)
                            .unwrap_or_else(|| "uncleared".into()),
                        reviewed: reviewed.as_ref().map(|c| check(r.values.get(c))),
                        source: option_key(r, source, TXN_SOURCES).unwrap_or_default(),
                        tags: match (tags, tags.and_then(|p| r.values.get(&p.id))) {
                            (Some(p), Some(CellValue::Multi { v })) => {
                                let opts = p.select_options();
                                v.iter()
                                    .filter_map(|id| opts.iter().find(|o| &o.id == id))
                                    .map(|o| o.name.clone())
                                    .collect()
                            }
                            _ => Vec::new(),
                        },
                        rev: r.rev,
                    },
                );
                let payee_s = rel(get(r, &payee))
                    .and_then(|p| l.payees.get(&p).cloned())
                    .unwrap_or_else(|| emp_finance::payee::normalize(&raw_s));
                l.txns.push(Txn {
                    id: r.id.clone(),
                    account_id: rel(get(r, &acct)).unwrap_or_default(),
                    date,
                    amount,
                    payee: payee_s,
                    raw: raw_s,
                    memo: text(get(r, &memo)),
                    category_id: rel(get(r, &cat)),
                    transfer_id: rel(get(r, &tr)),
                    import_id: Some(text(get(r, &imp))).filter(|s| !s.is_empty()),
                    split_parent: rel(get(r, &sp)),
                    has_splits: parents.contains(&r.id),
                });
            }
        }
        if let Some(d) = dbs.get("budgets") {
            let m = d.keyed_id("month", &["Month"]);
            let cat = d.keyed_id("category", &["Category"]);
            let asg = d.keyed_id("assigned", &["Assigned"]);
            for r in &d.rows {
                let get = |c: &Option<String>| c.as_ref().and_then(|c| r.values.get(c));
                let (Ok(month), Some(category_id)) =
                    (text(get(&m)).trim().parse::<YearMonth>(), rel(get(&cat)))
                else {
                    continue;
                };
                l.assignments.push(Assignment {
                    month,
                    category_id,
                    amount: amount(get(&asg)).unwrap_or_default(),
                });
            }
        }
        l.dbs = dbs;
        Ok(l)
    }

    /// Current balance of an account (opening balance plus transactions up to `as_of`).
    #[must_use]
    pub fn balance(&self, a: &Account, as_of: NaiveDate) -> Decimal {
        balance_as_of(a, &self.txns, as_of)
    }

    /// Net worth as of `as_of` — the one definition, [`emp_finance::networth::point`] (open accounts, sign decides
    /// asset or liability, base currency only without FX rates, investment accounts replaced by Portfolio's market
    /// value `investments` when given). The browser mock's `netWorthAt` implements the same rules.
    pub fn net_worth_point(
        &self,
        as_of: NaiveDate,
        investments: Option<Decimal>,
    ) -> ApiResult<emp_finance::networth::Snapshot> {
        let base = Currency::new(&self.currency).map_err(fin_err)?;
        Ok(emp_finance::networth::point(
            &self.accounts,
            &self.txns,
            as_of,
            &base,
            &emp_finance::fx::FxRates::new(),
            investments,
        ))
    }

    /// Emergency-fund balance (`ef_balance`, §15.5), the same definition as the mock's `emergencyBalance`: the
    /// balance as of `today` of the account linked to the emergency-fund goal; else that goal's saved amount; else
    /// the total of the open savings accounts.
    #[must_use]
    pub fn ef_balance(&self, today: NaiveDate) -> Decimal {
        if let Some(d) = self.dbs.get("goals") {
            let kind = d.col("goal.kind", &["Kind", "Type"]);
            let acct = d.col_id("goal.account", &["Account"]);
            let saved = d.col_id("goal.saved", &["Saved"]);
            if let Some(r) = d.rows.iter().find(|r| {
                d.option_name(r, kind)
                    .is_some_and(|k| norm(&k).contains("emergency"))
            }) {
                let linked = acct
                    .as_ref()
                    .and_then(|c| rel(r.values.get(c)))
                    .and_then(|id| self.accounts.iter().find(|a| a.id == id));
                if let Some(a) = linked {
                    return self.balance(a, today);
                }
                return amount(saved.as_ref().and_then(|c| r.values.get(c))).unwrap_or_default();
            }
        }
        self.accounts
            .iter()
            .filter(|a| a.kind == AccountType::Savings && !a.closed)
            .map(|a| self.balance(a, today))
            .sum()
    }

    fn db(&self, key: &str) -> ApiResult<&InstanceDb> {
        self.dbs.get(key).ok_or_else(|| {
            ApiError::new(
                ErrorCode::NotFound,
                format!("This app has no {key} database"),
            )
        })
    }
}

/// The budget configuration of an instance: the stored one (`fin.budget`), else the one the wizard chose
/// ([`budget_config_from_answers`] over `Store::lifeapp_answers`, so Quick-mode installs get the recommended method).
pub fn budget_config(store: &Store, instance_id: &str) -> BudgetConfig {
    if let Some(cfg) = store
        .kv_get_any(BUDGET_NS, instance_id)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
    {
        return cfg;
    }
    let answers = store.lifeapp_answers(instance_id).unwrap_or_else(|e| {
        tracing::debug!(
            code = e.code(),
            "life-app answers unavailable; default budget"
        );
        serde_json::Map::new()
    });
    budget_config_from_answers(&answers)
}

/// The budget configuration of Money HQ's wizard answers (§16.2): `method` (default zero-based),
/// `currency.monthStartDay` (1–28, default 1), and the income buffer for irregular income
/// (`income.stability == "irregular"`) under a method that assigns income.
#[must_use]
pub fn budget_config_from_answers(answers: &serde_json::Map<String, Value>) -> BudgetConfig {
    let method = answers
        .get("method")
        .and_then(|m| serde_json::from_value::<BudgetMethod>(m.clone()).ok())
        .unwrap_or(BudgetMethod::ZeroBased);
    let month_start_day = answers
        .get("currency")
        .and_then(|c| c.get("monthStartDay"))
        .and_then(Value::as_u64)
        .and_then(|d| u8::try_from(d.clamp(1, 28)).ok())
        .unwrap_or(1);
    let irregular = answers
        .get("income")
        .and_then(|i| i.get("stability"))
        .and_then(Value::as_str)
        == Some("irregular");
    BudgetConfig {
        method,
        month_start_day,
        income_buffer: irregular && method.uses_tba(),
        savings_target_pct: None,
    }
}

fn budget_month(
    store: &Store,
    instance_id: &str,
    l: &Ledger,
    m: YearMonth,
) -> ApiResult<BudgetMonth> {
    let cfg = budget_config(store, instance_id);
    let input = BudgetInput {
        config: &cfg,
        categories: &l.categories,
        txns: &l.txns,
        assignments: &l.assignments,
    };
    let first = l
        .txns
        .iter()
        .map(|t| YearMonth::of(t.date))
        .min()
        .unwrap_or(m)
        .min(m);
    let from = if first.months_until(m) > 120 {
        m.plus_months(-120)
    } else {
        first
    };
    budget::compute(&input, from, m)
        .map_err(fin_err)?
        .pop()
        .ok_or_else(|| ApiError::internal("budget"))
}

// ───────────────────────────────────────────────────────────────────────────── overview and charts

/// An `{ instanceId, month }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonthReq {
    instance_id: String,
    month: String,
}

/// One budget row of the overview.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewBudgetRow {
    category_id: String,
    name: String,
    group: String,
    color: String,
    assigned: MoneyDto,
    activity: MoneyDto,
    available: MoneyDto,
    pace: f64,
}

/// One upcoming bill.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingRow {
    row_id: String,
    name: String,
    due: String,
    amount: MoneyDto,
    autopay: bool,
}

/// `finance_overview` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// `assets − liabilities` as of today ([`Ledger::net_worth_point`]).
    net_worth: MoneyDto,
    net_worth_delta30d: MoneyDto,
    assets: MoneyDto,
    liabilities: MoneyDto,
    /// Portfolio's market value counted in `assets` in place of the investment accounts.
    #[serde(skip_serializing_if = "Option::is_none")]
    investments: Option<MoneyDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ef_balance: Option<MoneyDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    essential_monthly: Option<MoneyDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to_be_assigned: Option<MoneyDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    left_to_spend: Option<MoneyDto>,
    savings_rate3m: f64,
    ef_months: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    debt_free_date: Option<String>,
    budget: Vec<OverviewBudgetRow>,
    upcoming: Vec<UpcomingRow>,
    uncategorized: usize,
    as_of: i64,
}

/// The next due date of a recurring row (its computed "Next date", else its schedule start).
fn recurring_next(d: &InstanceDb, r: &RowDto) -> Option<NaiveDate> {
    let next = d.keyed_id("next", &["Next date"]);
    if let Some(n) = date(next.as_ref().and_then(|c| r.values.get(c))) {
        return Some(n);
    }
    let sched = d.col_id("rec.schedule", &["Schedule"])?;
    match r.values.get(&sched)? {
        CellValue::Recurrence { v: Some(rv) } => {
            NaiveDate::parse_from_str(rv.dtstart.get(..10)?, "%Y-%m-%d").ok()
        }
        _ => None,
    }
}

/// The debts Money HQ plans with (the Debt tab's `debtInputs` and the browser mock's `debtsOf` build the same
/// list): open liability accounts owing money today, at their minimum payment, or `max($25, 2% of the balance)`
/// when they have none.
pub fn ledger_debts(l: &Ledger, today: NaiveDate) -> Vec<emp_finance::debt::Debt> {
    l.accounts
        .iter()
        .filter(|a| a.kind.is_liability() && !a.closed)
        .filter_map(|a| {
            let owed = -l.balance(a, today);
            (owed > Decimal::ZERO).then(|| emp_finance::debt::Debt {
                name: a.id.clone(),
                balance: owed,
                apr_pct: a.apr_pct.unwrap_or_default(),
                min_payment: a
                    .min_payment
                    .filter(|m| *m > Decimal::ZERO)
                    .unwrap_or_else(|| {
                        (owed / Decimal::from(50))
                            .round_dp(2)
                            .max(Decimal::from(25))
                    }),
            })
        })
        .collect()
}

/// `debtFreeDate` — the one definition behind Money HQ's "Debt-free" tile, the `debt_free_date` life-app metric
/// and its KPI tile: the month the last of [`ledger_debts`] is paid off **paying the minimums only** (no extra, no
/// rollover; the Debt tab's planner shows strategies with extra payments separately), starting next month — this
/// month's payments are already in the ledger. `None` without debts or when the minimums never clear them within
/// 600 months. The browser mock's `finance_overview` computes the same.
fn debt_free_date(l: &Ledger, today: NaiveDate) -> Option<String> {
    let debts = ledger_debts(l, today);
    if debts.is_empty() {
        return None;
    }
    emp_finance::debt::simulate(
        &debts,
        emp_finance::debt::Strategy::MinimumsOnly,
        Decimal::ZERO,
        None,
        YearMonth::of(today).next(),
    )
    .ok()?
    .debt_free()
    .map(|m| m.to_string())
}

// ───────────────────────────────────────────────────────────────────────────── Portfolio valuation (§16.8)

/// Portfolio's market value over time — what Money HQ counts in place of its investment accounts (§16.8 "Investment
/// account values become Net worth assets"). Today's value is `portfolio_summary.totalValue` computed from the
/// cached quotes (same lots and [`emp_finance::portfolio::holdings::value`]); an earlier date values the positions
/// held at the end of that day at that day's cached close, falling back to today's price, then to average cost.
/// Without any market data (offline, no provider, cold cache) every date is valued at cost, like
/// `portfolio_summary` offline. Built by [`portfolio_marks_cached`] — never from the network.
#[derive(Debug, Clone, Default)]
pub struct PortfolioMarks {
    today: NaiveDate,
    now_value: Decimal,
    txns: Vec<emp_finance::portfolio::InvTxn>,
    closes: HashMap<String, BTreeMap<NaiveDate, Decimal>>,
    fallback: HashMap<String, Decimal>,
}

impl PortfolioMarks {
    /// Builds the marks from loaded Portfolio data and whatever market data is at hand.
    fn build(
        data: &super::portfolio::PortfolioData,
        prices: &HashMap<String, emp_finance::portfolio::holdings::PriceQuote>,
        closes: HashMap<String, BTreeMap<NaiveDate, Decimal>>,
        today: NaiveDate,
    ) -> Self {
        let book = data.book();
        let now_value =
            emp_finance::portfolio::holdings::value(&book, prices, &data.securities, today)
                .total_value;
        let mut cost: HashMap<String, (Decimal, Decimal)> = HashMap::new();
        for l in &book.lots {
            let e = cost.entry(l.security.clone()).or_default();
            e.0 += l.qty;
            e.1 += l.basis;
        }
        let mut fallback: HashMap<String, Decimal> = HashMap::new();
        for t in &data.txns {
            if let Some(p) = t.price.filter(|p| *p > Decimal::ZERO) {
                fallback.insert(t.security.clone(), p);
            }
        }
        for (sym, (q, b)) in cost {
            if q > Decimal::ZERO {
                fallback.insert(sym, b / q);
            }
        }
        for (sym, q) in prices {
            fallback.insert(sym.clone(), q.price);
        }
        PortfolioMarks {
            today,
            now_value,
            txns: data.txns.clone(),
            closes,
            fallback,
        }
    }

    /// Date of Portfolio's first transaction.
    #[must_use]
    pub fn first_date(&self) -> Option<NaiveDate> {
        self.txns.iter().map(|t| t.date).min()
    }

    /// Portfolio's value at the end of `d` (today and later: the live valuation).
    #[must_use]
    pub fn value_at(&self, d: NaiveDate) -> Decimal {
        if d >= self.today {
            return self.now_value;
        }
        let pos = super::portfolio::positions_by_day(&self.txns, &[d]);
        pos.first().map_or(Decimal::ZERO, |p| {
            p.iter()
                .map(|(sym, q)| {
                    let close = self
                        .closes
                        .get(sym)
                        .and_then(|m| m.range(..=d).next_back().map(|(_, c)| *c));
                    *q * close
                        .or_else(|| self.fallback.get(sym).copied())
                        .unwrap_or_default()
                })
                .sum()
        })
    }
}

/// The Portfolio instance installed next to Money HQ instance `money_id` (same workspace), if any.
fn portfolio_instance_for(store: &Store, money_id: &str) -> ApiResult<Option<String>> {
    let (ws, _) = find_instance(store, money_id)?;
    Ok(store
        .lifeapp_instances(&ws)?
        .into_iter()
        .find(|i| i.app_id == "portfolio" && !i.detached)
        .map(|i| i.id))
}

/// What a cache-only valuation could not price from the market caches; [`refresh_marks`] fetches it in the
/// background so the next valuation has it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarksRefresh {
    /// Held symbols without a fresh cached quote.
    pub quotes: Vec<String>,
    /// Held symbols with no cached quote at all (valued at cost today).
    pub unpriced: Vec<String>,
    /// Symbols whose cached daily closes do not cover the history the valuation needs.
    pub bars: Vec<String>,
    /// Start of that history.
    pub from: Option<NaiveDate>,
    /// Its end (the valuation's today).
    pub until: Option<NaiveDate>,
}

impl MarksRefresh {
    /// Whether every held symbol is valued at a cached market price today.
    #[must_use]
    pub fn priced_today(&self) -> bool {
        self.unpriced.is_empty()
    }
}

/// Portfolio's value for Money HQ **from the market caches only** — never the network, so `finance_overview`, the
/// net-worth series and the life-app metrics stay local computations. Today: cached quotes (fresh or stale, the
/// same quotes `portfolio_summary` shows once it has fetched them), cost basis for symbols with none. Earlier
/// dates (back to `history_from`, clamped to Portfolio's first transaction): cached daily closes. Returns `None`
/// without a Portfolio instance, plus what was missing (hand it to [`refresh_marks`]). `router: None` (no market
/// access, tests) values everything at cost, like `portfolio_summary` offline.
pub fn portfolio_marks_cached(
    store: &Store,
    router: Option<&emp_integrations::market::MarketRouter>,
    money_id: &str,
    today: NaiveDate,
    history_from: Option<NaiveDate>,
) -> ApiResult<Option<(PortfolioMarks, MarksRefresh)>> {
    let Some(pf) = portfolio_instance_for(store, money_id)? else {
        return Ok(None);
    };
    let data = super::portfolio::PortfolioData::load(store, &pf)?;
    let mut need = MarksRefresh::default();
    let mut prices = HashMap::new();
    let mut closes: HashMap<String, BTreeMap<NaiveDate, Decimal>> = HashMap::new();
    let first = data.txns.iter().map(|t| t.date).min();
    let from = history_from
        .zip(first)
        .map(|(h, f)| h.max(f))
        .filter(|f| *f < today);
    if let Some(r) = router {
        let book = data.book();
        let held: Vec<String> = super::portfolio::PortfolioData::held(&book)
            .into_keys()
            .take(super::portfolio::MAX_SYMBOLS)
            .collect();
        for k in held {
            match r.cached_quote(&k) {
                Some((q, fresh)) if q.is_sane() => {
                    if !fresh {
                        need.quotes.push(k.clone());
                    }
                    if let Some(as_of) =
                        chrono::DateTime::from_timestamp_millis(q.as_of).map(|t| t.date_naive())
                    {
                        prices.insert(
                            q.symbol.clone(),
                            emp_finance::portfolio::holdings::PriceQuote {
                                price: emp_finance::money::from_f64(q.price),
                                prev_close: q
                                    .prev_close
                                    .filter(|x| x.is_finite() && *x > 0.0)
                                    .map(emp_finance::money::from_f64),
                                as_of,
                            },
                        );
                    }
                }
                _ => {
                    need.quotes.push(k.clone());
                    need.unpriced.push(k);
                }
            }
        }
        if let Some(from) = from {
            let mut symbols: Vec<String> = data
                .txns
                .iter()
                .filter(|t| t.date <= today)
                .map(|t| t.security.clone())
                .filter(|s| !s.is_empty())
                .collect();
            symbols.sort();
            symbols.dedup();
            symbols.truncate(super::portfolio::MAX_HISTORY_SYMBOLS);
            let yesterday = today.pred_opt().unwrap_or(today);
            for sym in symbols {
                let key = emp_integrations::market::Symbol::parse(&sym)
                    .map(|s| s.key())
                    .unwrap_or_else(|_| sym.clone());
                let cached = r.bar_cache().get(&key, true);
                if !cached.as_ref().is_some_and(|c| c.covers(from, yesterday)) {
                    need.bars.push(sym.clone());
                }
                if let Some(c) = cached {
                    closes.insert(
                        sym,
                        c.bars
                            .values()
                            .filter(|b| b.close.is_finite() && b.close > 0.0)
                            .map(|b| (b.date, emp_finance::money::from_f64(b.close)))
                            .collect(),
                    );
                }
            }
            if !need.bars.is_empty() {
                need.from = Some(from);
                need.until = Some(today);
            }
        }
    }
    Ok(Some((
        PortfolioMarks::build(&data, &prices, closes, today),
        need,
    )))
}

/// Symbols fetched recently by [`refresh_marks`] (symbol → when): a symbol a provider cannot serve is not asked
/// for again on every overview.
static REFRESHED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// How long [`refresh_marks`] waits before asking for the same symbol again.
pub const MARKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(10 * 60);
/// Per-symbol deadline of a background bars fetch.
pub const MARKS_BARS_DEADLINE: Duration = Duration::from_secs(15);

/// Fetches what [`portfolio_marks_cached`] was missing, in the background (quotes through
/// [`super::market::quotes_for`], daily bars one symbol at a time, each with a deadline). Each symbol is asked for
/// at most once per [`MARKS_REFRESH_COOLDOWN`]. Returns at once.
pub fn refresh_marks(router: Arc<emp_integrations::market::MarketRouter>, need: MarksRefresh) {
    let now = Instant::now();
    let take = |kind: &str, list: Vec<String>| -> Vec<String> {
        let mut seen = REFRESHED.lock();
        seen.retain(|_, at| now.duration_since(*at) < MARKS_REFRESH_COOLDOWN);
        list.into_iter()
            .filter(|s| {
                let k = format!("{kind}:{s}");
                if seen.contains_key(&k) {
                    return false;
                }
                seen.insert(k, now);
                true
            })
            .collect()
    };
    let quotes = take("q", need.quotes);
    let bars = take("b", need.bars);
    if quotes.is_empty() && bars.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if !quotes.is_empty() {
            super::market::quotes_for(&router, &quotes).await;
        }
        let (Some(from), Some(today)) = (need.from, need.until) else {
            return;
        };
        for sym in bars {
            let _ = tokio::time::timeout(
                MARKS_BARS_DEADLINE,
                router.bars(
                    &sym,
                    emp_integrations::market::BarInterval::Day,
                    from - chrono::Duration::days(7),
                    today,
                    true,
                    &BTreeMap::new(),
                ),
            )
            .await;
        }
    });
}

/// The app handle, for the market router of work that has only a [`Store`] (the life-app metric provider, the
/// background net-worth snapshot). Set by [`ensure_metric_provider`].
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// The market router of the unlocked vault, when the app has one (none in unit tests).
fn market_router(state: Option<&AppState>) -> Option<Arc<emp_integrations::market::MarketRouter>> {
    match state {
        Some(s) => super::market::router(s).ok(),
        None => APP
            .get()
            .and_then(|a| a.try_state::<AppState>())
            .and_then(|s| super::market::router(&s).ok()),
    }
}

/// Portfolio marks for a Money HQ computation: [`portfolio_marks_cached`] with the app's router, kicking off
/// [`refresh_marks`] for whatever the caches lacked. `None` without a Portfolio instance.
pub fn marks_now(
    store: &Store,
    state: Option<&AppState>,
    money_id: &str,
    history_from: Option<NaiveDate>,
) -> ApiResult<Option<PortfolioMarks>> {
    let router = market_router(state);
    let today = local_today(store);
    let Some((marks, need)) =
        portfolio_marks_cached(store, router.as_deref(), money_id, today, history_from)?
    else {
        return Ok(None);
    };
    if let Some(r) = router {
        refresh_marks(r, need);
    }
    Ok(Some(marks))
}

/// Computes `finance_overview`.
pub fn overview(
    store: &Store,
    instance_id: &str,
    m: YearMonth,
    marks: Option<&PortfolioMarks>,
) -> ApiResult<Overview> {
    let l = Ledger::load(store, instance_id)?;
    overview_of(store, instance_id, &l, m, marks)
}

/// [`overview`] over an already loaded ledger.
fn overview_of(
    store: &Store,
    instance_id: &str,
    l: &Ledger,
    m: YearMonth,
    marks: Option<&PortfolioMarks>,
) -> ApiResult<Overview> {
    let today = local_today(store);
    let cur = l.currency.clone();
    let day30 = today - chrono::Duration::days(30);
    let nw = l.net_worth_point(today, marks.map(|k| k.value_at(today)))?;
    let nw30 = l.net_worth_point(day30, marks.map(|k| k.value_at(day30)))?;
    let bm = budget_month(store, instance_id, l, m)?;
    let period = budget_period(m, budget_config(store, instance_id).month_start_day);
    let pace = budget::pace(&period, today);
    let names: HashMap<&str, &Category> = l.categories.iter().map(|c| (c.id.as_str(), c)).collect();
    let budget_rows = bm
        .categories
        .iter()
        .filter_map(|c| {
            let cat = names.get(c.category_id.as_str())?;
            (!cat.is_income).then(|| OverviewBudgetRow {
                category_id: c.category_id.clone(),
                name: cat.name.clone(),
                group: cat.group.clone(),
                color: l
                    .colors
                    .get(&c.category_id)
                    .cloned()
                    .unwrap_or_else(|| "gray".into()),
                assigned: MoneyDto::of(c.assigned, &cur),
                activity: MoneyDto::of(c.activity, &cur),
                available: MoneyDto::of(c.available, &cur),
                pace,
            })
        })
        .collect();
    let mut upcoming = Vec::new();
    if let Some(d) = l.dbs.get("recurring") {
        let am = d.col_id("rec.amount", &["Amount"]);
        let ap = d.col_id("rec.autopay", &["Autopay"]);
        for r in &d.rows {
            let Some(due) = recurring_next(d, r) else {
                continue;
            };
            if due < today || due > today + chrono::Duration::days(30) {
                continue;
            }
            upcoming.push(UpcomingRow {
                row_id: r.id.clone(),
                name: d.title(r),
                due: due.to_string(),
                amount: MoneyDto::of(
                    amount(am.as_ref().and_then(|c| r.values.get(c))).unwrap_or_default(),
                    &cur,
                ),
                autopay: ap.as_ref().is_some_and(|c| check(r.values.get(c))),
            });
        }
        upcoming.sort_by(|a, b| a.due.cmp(&b.due));
    }
    let ef_balance = l.ef_balance(today);
    let essential = emp_finance::metrics::essential_monthly_spend(&l.txns, &l.categories, today);
    Ok(Overview {
        net_worth: MoneyDto::of(nw.net_worth, &cur),
        net_worth_delta30d: MoneyDto::of(nw.net_worth - nw30.net_worth, &cur),
        assets: MoneyDto::of(nw.assets, &cur),
        liabilities: MoneyDto::of(nw.liabilities, &cur),
        investments: marks.map(|k| MoneyDto::of(k.value_at(today), &cur)),
        ef_balance: Some(MoneyDto::of(ef_balance, &cur)),
        essential_monthly: Some(MoneyDto::of(essential, &cur)),
        to_be_assigned: bm.to_be_assigned.map(|x| MoneyDto::of(x, &cur)),
        left_to_spend: bm.left_to_spend.map(|x| MoneyDto::of(x, &cur)),
        savings_rate3m: emp_finance::metrics::savings_rate_3m(&l.txns, &l.categories, today)
            .unwrap_or(0.0),
        ef_months: emp_finance::metrics::ef_months(ef_balance, essential).unwrap_or(0.0),
        debt_free_date: debt_free_date(l, today),
        budget: budget_rows,
        upcoming,
        uncategorized: l
            .txns
            .iter()
            .filter(|t| t.category_id.is_none() && !t.is_transfer() && t.counts())
            .count(),
        as_of: store.now(),
    })
}

// ───────────────────────────────────────────────────────────────────────────── life-app metrics (§16.1)

/// Money HQ's headline life-app metrics exactly as [`overview`] computes them, keyed by metric function id: the one
/// source for the Money HQ KPI tiles (`money-hq.json`), Home insights and their "Show math", and editor KPI blocks.
/// `ef_months` is a manifest expression (`ef_balance ÷ essential_monthly_spend`), so it equals the overview's
/// `efMonths`. A figure the overview does not have (left to spend in a zero-based budget, no debts) is a `null`
/// value — never a different formula. The browser mock's `moneyHook` emits the same values and math.
pub fn money_metric_overrides(
    store: &Store,
    instance_id: &str,
    marks: Option<&PortfolioMarks>,
) -> ApiResult<BTreeMap<String, MetricValue>> {
    use emp_store::lifeapps::metrics::{MathLine, format_money, format_pct};
    let l = Ledger::load(store, instance_id)?;
    let today = local_today(store);
    let o = overview_of(store, instance_id, &l, YearMonth::of(today), marks)?;
    let cur = o.net_worth.currency.clone();
    let as_of = store.now();
    let f = |m: &MoneyDto| m.amount.parse::<f64>().unwrap_or(0.0);
    let fm = |x: f64| format_money(x, &cur);
    let line = |label: &str, value: String, source: Option<&str>| MathLine {
        label: label.to_owned(),
        value,
        source: source.map(str::to_owned),
    };
    let num = |x: f64, display: String, math: Vec<MathLine>| MetricValue {
        value: json!(x + 0.0),
        display,
        math,
        as_of,
    };
    let none = |math: Vec<MathLine>| MetricValue {
        value: Value::Null,
        display: "—".into(),
        math,
        as_of,
    };
    let mut out = BTreeMap::new();
    let (nw, assets, liab) = (f(&o.net_worth), f(&o.assets), f(&o.liabilities));
    let mut nw_math = vec![
        line("Assets", fm(assets), Some("Accounts")),
        line("Liabilities", fm(-liab), Some("Accounts")),
    ];
    if let Some(inv) = &o.investments {
        nw_math.push(line("of which Portfolio", fm(f(inv)), Some("Portfolio")));
    }
    out.insert("money.net_worth".into(), num(nw, fm(nw), nw_math));
    let d30 = f(&o.net_worth_delta30d);
    out.insert(
        "money.net_worth_delta_30d".into(),
        num(
            d30,
            fm(d30),
            vec![
                line("Net worth today", fm(nw), Some("Accounts")),
                line("30 days ago", fm(nw - d30), Some("Accounts")),
            ],
        ),
    );
    let budget_src = Some("Budget");
    out.insert(
        "money.to_be_assigned".into(),
        match &o.to_be_assigned {
            Some(t) => num(
                f(t),
                fm(f(t)),
                vec![line("To be assigned", fm(f(t)), budget_src)],
            ),
            None => none(Vec::new()),
        },
    );
    out.insert(
        "money.left_to_spend".into(),
        match &o.left_to_spend {
            Some(t) => num(
                f(t),
                fm(f(t)),
                vec![line("Left to spend", fm(f(t)), budget_src)],
            ),
            None => none(Vec::new()),
        },
    );
    let (from, to) = emp_finance::metrics::savings_window(today);
    let flows = emp_finance::metrics::income_spending(&l.txns, &l.categories, from, to);
    let (inc, spend) = (
        emp_finance::money::to_f64(flows.income),
        emp_finance::money::to_f64(flows.spending),
    );
    let rate_math = vec![
        line("Income (3 months)", fm(inc), Some("Transactions")),
        line("Spending (3 months)", fm(spend), Some("Transactions")),
        line("Savings rate", "(income − spending) ÷ income".into(), None),
    ];
    out.insert(
        "money.savings_rate_3m".into(),
        if inc > 0.0 {
            num(o.savings_rate3m, format_pct(o.savings_rate3m), rate_math)
        } else {
            none(rate_math)
        },
    );
    let ess = o.essential_monthly.as_ref().map_or(0.0, f);
    out.insert(
        "money.essential_monthly_spend".into(),
        num(
            ess,
            fm(ess),
            vec![line(
                "Essentials / month (median of the last three 30-day periods)",
                fm(ess),
                Some("Transactions"),
            )],
        ),
    );
    let ef = o.ef_balance.as_ref().map_or(0.0, f);
    out.insert(
        "money.ef_balance".into(),
        num(
            ef,
            fm(ef),
            vec![line("Emergency fund", fm(ef), Some("Goals"))],
        ),
    );
    let debts = ledger_debts(&l, today);
    let debt_math = vec![
        line("Debts", debts.len().to_string(), Some("Accounts")),
        line("Paying", "minimums only".into(), None),
    ];
    out.insert(
        "money.debt_free_date".into(),
        match o
            .debt_free_date
            .as_deref()
            .and_then(|m| m.parse::<YearMonth>().ok())
        {
            Some(m) => MetricValue {
                value: json!(m.to_string()),
                display: m.first_day().format("%b %Y").to_string(),
                math: debt_math,
                as_of,
            },
            None => none(debt_math),
        },
    );
    Ok(out)
}

/// The life-app metric provider of the desktop app: Money HQ's headline metrics from [`money_metric_overrides`]
/// (Portfolio from the market caches, as `finance_overview`); every other app keeps the built-in functions.
struct FinanceMetrics;

impl emp_store::MetricProvider for FinanceMetrics {
    fn overrides(
        &self,
        store: &Store,
        data: &emp_store::lifeapps::metrics::MetricData,
    ) -> BTreeMap<String, MetricValue> {
        if data.app_id != "money-hq" {
            return BTreeMap::new();
        }
        let from = data.today - chrono::Duration::days(31);
        let result = marks_now(store, None, &data.instance_id, Some(from))
            .and_then(|marks| money_metric_overrides(store, &data.instance_id, marks.as_ref()));
        match result {
            Ok(v) => v,
            Err(e) => {
                tracing::info!(
                    code = e.code.as_str(),
                    "finance metrics fell back to built-ins"
                );
                BTreeMap::new()
            }
        }
    }
}

static METRIC_PROVIDER: std::sync::Once = std::sync::Once::new();

/// Registers [`FinanceMetrics`] with the life-app engine (once per process) and remembers the app handle for the
/// market router. Called by the life-app commands before they compute metrics, and by `finance_overview`.
pub fn ensure_metric_provider(app: &AppHandle, store: &Store) {
    let _ = APP.set(app.clone());
    register_metric_provider(store);
}

/// Registers [`FinanceMetrics`] (once per process) without an app handle (no market router: Portfolio at cost).
pub fn register_metric_provider(store: &Store) {
    METRIC_PROVIDER.call_once(|| {
        store.lifeapps_set_metric_provider(Some(Arc::new(FinanceMetrics)));
    });
}

/// `finance_overview({ instanceId, month }) → { netWorth, netWorthDelta30d, toBeAssigned?, leftToSpend?, savingsRate3m,
/// efMonths, debtFreeDate?, budget, upcoming, uncategorized, asOf }`.
///
/// Local only: Portfolio is valued from the market caches ([`marks_now`]); missing prices are fetched in the
/// background for the next call.
#[tauri::command]
pub async fn finance_overview(app: AppHandle, req: MonthReq) -> ApiResult<Overview> {
    validate::id("instanceId", &req.instance_id)?;
    let m = month("month", &req.month)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        ensure_metric_provider(&app, &store);
        // 30 days of history for the 30-day delta.
        let from = local_today(&store) - chrono::Duration::days(31);
        let marks = marks_now(&store, Some(&state), &req.instance_id, Some(from))?;
        overview(&store, &req.instance_id, m, marks.as_ref())
    })
    .await
}

/// `finance_networth_series` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeriesReq {
    instance_id: String,
    range: String,
}

/// `finance_networth_series({ instanceId, range: '6m'|'1y'|'3y'|'5y'|'all' }) → { t, assets, liabilities, net,
/// currency }`: stored monthly snapshots, back-filled from transactions where missing.
#[tauri::command]
pub async fn finance_networth_series(
    app: AppHandle,
    req: SeriesReq,
) -> ApiResult<emp_finance::networth::NetWorthSeries> {
    validate::id("instanceId", &req.instance_id)?;
    let months: Option<i32> = match req.range.as_str() {
        "6m" => Some(6),
        "1y" => Some(12),
        "3y" => Some(36),
        "5y" => Some(60),
        "all" => None,
        _ => return Err(ApiError::invalid("range", "must be 6m, 1y, 3y, 5y or all")),
    };
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let today = local_today(&store);
        // `all` reaches back to Portfolio's first transaction (`portfolio_marks_cached` clamps to it).
        let from = match months {
            Some(n) => YearMonth::of(today).plus_months(-n).first_day(),
            None => NaiveDate::MIN,
        };
        let marks = marks_now(&store, Some(&state), &req.instance_id, Some(from))?;
        networth_series(&store, &req.instance_id, months, marks.as_ref())
    })
    .await
}

/// The month a Net worth snapshot row records: its title (`YYYY-MM`), else its Date column.
fn snapshot_month(d: &InstanceDb, r: &RowDto, date_col: &Option<String>) -> Option<YearMonth> {
    d.title(r)
        .trim()
        .parse::<YearMonth>()
        .ok()
        .or_else(|| date(date_col.as_ref().and_then(|c| r.values.get(c))).map(YearMonth::of))
}

/// Computes `finance_networth_series` (pure over the store): one [`emp_finance::networth::point`] per month — month
/// ends, the current month as of today, so the last point is exactly the overview's net worth — from the first
/// ledger or Portfolio transaction (before the ledger's first transaction accounts sit at their opening balance).
/// Snapshot rows the user entered (any source but *Automatic*; month from the title `YYYY-MM`, else the Date column)
/// override past months; automatic rows are a record of the same computation and never override it, and the
/// current month is always live. The browser mock's `finance_networth_series` follows the same rules.
pub fn networth_series(
    store: &Store,
    instance_id: &str,
    months: Option<i32>,
    marks: Option<&PortfolioMarks>,
) -> ApiResult<emp_finance::networth::NetWorthSeries> {
    let l = Ledger::load(store, instance_id)?;
    let today = local_today(store);
    let base = Currency::new(&l.currency).map_err(fin_err)?;
    let to = YearMonth::of(today);
    let earliest = l
        .txns
        .iter()
        .map(|t| t.date)
        .chain(marks.and_then(PortfolioMarks::first_date))
        .min()
        .map_or(to, YearMonth::of);
    let from = match months {
        Some(n) => to.plus_months(-(n - 1)),
        None => earliest,
    };
    let mut snaps: BTreeMap<YearMonth, emp_finance::networth::Snapshot> = BTreeMap::new();
    for s in emp_finance::networth::backfill_from_transactions(
        &l.accounts,
        &l.txns,
        from.max(earliest).min(to),
        to,
        today,
        &base,
        &emp_finance::fx::FxRates::new(),
        &|d| marks.map(|k| k.value_at(d)),
    ) {
        snaps.insert(s.month, s);
    }
    if let Some(d) = l.dbs.get("networth") {
        let a = d.keyed_id("assets", &["Assets"]);
        let li = d.keyed_id("liabilities", &["Liabilities"]);
        let source = d.keyed("source", &["Source"]);
        let dcol = d.keyed_id("date", &["Date"]);
        for r in &d.rows {
            let Some(m) = snapshot_month(d, r, &dcol) else {
                continue;
            };
            if m < from || m >= to {
                continue;
            }
            let automatic = d
                .option_name(r, source)
                .is_some_and(|n| matches!(norm(&n).as_str(), "automatic" | "auto"));
            if automatic {
                continue;
            }
            let assets = amount(a.as_ref().and_then(|c| r.values.get(c))).unwrap_or_default();
            let liabilities = amount(li.as_ref().and_then(|c| r.values.get(c)))
                .unwrap_or_default()
                .abs();
            snaps.insert(
                m,
                emp_finance::networth::Snapshot {
                    month: m,
                    as_of: m.last_day(),
                    assets,
                    liabilities,
                    net_worth: assets - liabilities,
                    currency: base.clone(),
                    missing_rates: Vec::new(),
                    source: "snapshot".into(),
                },
            );
        }
    }
    let list: Vec<_> = snaps.into_values().collect();
    Ok(emp_finance::networth::series(&list, &base))
}

// ───────────────────────────────────────────────────────────────────────────── automatic net-worth snapshots

/// The automatic monthly net-worth snapshot (§15.5, §16.2 "Net worth snapshots"): for every Money HQ instance, the
/// first time this runs in a month it adds a row (source *Automatic*) for each month from the latest snapshot row
/// (exclusive) to the current month, valued with [`emp_finance::networth::point`] like the live series (the current
/// month as of today, Portfolio from the market caches). While Portfolio's holdings have no cached price yet the
/// run is deferred (prices are fetched meanwhile) for the first [`SNAPSHOT_PRICE_WAIT_DAYS`] days of the month, so
/// the row records market values; after that, or without market access, holdings without a price are recorded at
/// cost. Returns the ids of the databases that got rows. Runs at unlock and from the background ticker.
pub fn auto_networth_snapshots(store: &Store) -> ApiResult<Vec<String>> {
    let today = local_today(store);
    let this_month = YearMonth::of(today).to_string();
    let mut written = Vec::new();
    for ws in store.workspace_list()? {
        for inst in store.lifeapp_instances(&ws.id)? {
            if inst.detached || inst.app_id != "money-hq" {
                continue;
            }
            let done = store
                .kv_get_any(NETWORTH_NS, &inst.id)?
                .is_some_and(|v| v.as_str() == Some(this_month.as_str()));
            if done {
                continue;
            }
            match networth_snapshot_rows(store, &inst.id, today) {
                Ok(SnapshotRun::Wrote(db)) => written.push(db),
                Ok(SnapshotRun::Nothing) => {}
                Ok(SnapshotRun::Deferred) => continue,
                Err(e) => {
                    tracing::info!(code = e.code.as_str(), "net-worth snapshot skipped");
                    continue;
                }
            }
            store.kv_set_any(NETWORTH_NS, &inst.id, json!(this_month), None)?;
        }
    }
    Ok(written)
}

/// Days into a month the automatic snapshot waits for Portfolio prices before recording holdings at cost.
pub const SNAPSHOT_PRICE_WAIT_DAYS: u32 = 7;

/// Outcome of [`networth_snapshot_rows`].
#[derive(Debug, PartialEq, Eq)]
enum SnapshotRun {
    /// Rows were added to this database.
    Wrote(String),
    /// Nothing to write this month.
    Nothing,
    /// Waiting for market prices; try again on the next run.
    Deferred,
}

/// Writes the missing snapshot rows of one instance.
fn networth_snapshot_rows(
    store: &Store,
    instance_id: &str,
    today: NaiveDate,
) -> ApiResult<SnapshotRun> {
    let l = Ledger::load(store, instance_id)?;
    let Some(d) = l.dbs.get("networth") else {
        return Ok(SnapshotRun::Nothing);
    };
    if l.accounts.is_empty() {
        return Ok(SnapshotRun::Nothing);
    }
    let dcol = d.keyed_id("date", &["Date"]);
    let existing: Vec<YearMonth> = d
        .rows
        .iter()
        .filter_map(|r| snapshot_month(d, r, &dcol))
        .collect();
    let mut months = emp_finance::networth::missing_months(&existing, today);
    if months.len() > MAX_AUTO_SNAPSHOT_MONTHS {
        months.drain(..months.len() - MAX_AUTO_SNAPSHOT_MONTHS);
    }
    let (Some(&first), Some(&last)) = (months.first(), months.last()) else {
        return Ok(SnapshotRun::Nothing);
    };
    let (Some(acol), Some(lcol)) = (
        d.keyed_id("assets", &["Assets"]),
        d.keyed_id("liabilities", &["Liabilities"]),
    ) else {
        return Err(ApiError::invalid(
            "instanceId",
            "the Net worth database is missing columns",
        ));
    };
    let source = d.keyed("source", &["Source"]).and_then(|p| {
        p.select_options()
            .into_iter()
            .find(|o| matches!(norm(&o.name).as_str(), "automatic" | "auto"))
            .map(|o| (p.id.clone(), o.id))
    });
    let base = Currency::new(&l.currency).map_err(fin_err)?;
    let money = |v: Decimal| CellValue::Money {
        v: Some(v.round_dp(2).normalize().to_string()),
        cur: l.currency.clone(),
    };
    // Portfolio from the market caches, like the live series (which recomputes and never reads these rows back).
    let router = market_router(None);
    let cached = portfolio_marks_cached(
        store,
        router.as_deref(),
        instance_id,
        today,
        Some(first.first_day()),
    )?;
    let marks = match cached {
        Some((marks, need)) => {
            let priced = need.priced_today();
            if let Some(r) = router {
                refresh_marks(r, need);
                if !priced && today.day() <= SNAPSHOT_PRICE_WAIT_DAYS {
                    return Ok(SnapshotRun::Deferred);
                }
            }
            Some(marks)
        }
        None => None,
    };
    let rows: Vec<BTreeMap<String, CellValue>> = emp_finance::networth::backfill_from_transactions(
        &l.accounts,
        &l.txns,
        first,
        last,
        today,
        &base,
        &emp_finance::fx::FxRates::new(),
        &|d| marks.as_ref().map(|k| k.value_at(d)),
    )
    .into_iter()
    .filter(|s| months.contains(&s.month))
    .map(|s| {
        let mut values = BTreeMap::new();
        values.insert(
            d.title_id().to_owned(),
            CellValue::text(&s.month.to_string()),
        );
        values.insert(acol.clone(), money(s.assets));
        values.insert(lcol.clone(), money(s.liabilities));
        if let Some((col, opt)) = &source {
            values.insert(
                col.clone(),
                CellValue::Select {
                    v: Some(opt.clone()),
                },
            );
        }
        values
    })
    .collect();
    if rows.is_empty() {
        return Ok(SnapshotRun::Nothing);
    }
    store.db_rows_insert_bulk(d.id(), rows, None)?;
    Ok(SnapshotRun::Wrote(d.id().to_owned()))
}

/// `finance_spending_breakdown` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BreakdownReq {
    instance_id: String,
    from: String,
    to: String,
    by: emp_finance::metrics::BreakdownBy,
}

/// One breakdown row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownDto {
    key: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    amount: String,
    pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta_pct: Option<f64>,
}

/// `finance_spending_breakdown({ instanceId, from, to, by }) → { key, label, color?, amount, pct, deltaPct? }[]`.
#[tauri::command]
pub async fn finance_spending_breakdown(
    app: AppHandle,
    req: BreakdownReq,
) -> ApiResult<Vec<BreakdownDto>> {
    validate::id("instanceId", &req.instance_id)?;
    let from = validate::ymd("from", &req.from)?;
    let to = validate::ymd("to", &req.to)?;
    if to < from || (to - from).num_days() > 3_700 {
        return Err(ApiError::invalid("to", "invalid date range"));
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        let accounts: HashMap<&str, &str> = l
            .accounts
            .iter()
            .map(|a| (a.id.as_str(), a.name.as_str()))
            .collect();
        Ok(
            emp_finance::metrics::spending_breakdown(&l.txns, &l.categories, req.by, from, to)
                .into_iter()
                .map(|r| BreakdownDto {
                    color: l.colors.get(&r.key).cloned(),
                    label: match req.by {
                        emp_finance::metrics::BreakdownBy::Account => accounts
                            .get(r.key.as_str())
                            .map_or(r.label.clone(), |n| (*n).to_owned()),
                        _ => r.label,
                    },
                    key: r.key,
                    amount: s(r.amount),
                    pct: r.pct,
                    delta_pct: r.delta_pct,
                })
                .collect(),
        )
    })
    .await
}

/// `finance_cashflow_sankey({ instanceId, month }) → { nodes, links }` (income → groups → categories).
#[tauri::command]
pub async fn finance_cashflow_sankey(
    app: AppHandle,
    req: MonthReq,
) -> ApiResult<emp_finance::metrics::Sankey> {
    validate::id("instanceId", &req.instance_id)?;
    let m = month("month", &req.month)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        let p = budget_period(m, budget_config(&store, &req.instance_id).month_start_day);
        Ok(emp_finance::metrics::cashflow_sankey(
            &l.txns,
            &l.categories,
            p.start,
            p.end,
        ))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── budget

/// One `finance_budget_month` category.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetCategoryDto {
    category_id: String,
    assigned: String,
    activity: String,
    available: String,
    rollover: String,
}

/// `finance_budget_month` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetMonthDto {
    categories: Vec<BudgetCategoryDto>,
    to_be_assigned: String,
    currency: String,
}

fn budget_dto(bm: &BudgetMonth, currency: &str) -> BudgetMonthDto {
    BudgetMonthDto {
        categories: bm
            .categories
            .iter()
            .map(|c| BudgetCategoryDto {
                category_id: c.category_id.clone(),
                assigned: s(c.assigned),
                activity: s(c.activity),
                available: s(c.available),
                rollover: s(c.rollover),
            })
            .collect(),
        to_be_assigned: s(bm.to_be_assigned.unwrap_or_default()),
        currency: currency.to_owned(),
    }
}

/// `finance_budget_month({ instanceId, month }) → { categories, toBeAssigned, currency }`.
#[tauri::command]
pub async fn finance_budget_month(app: AppHandle, req: MonthReq) -> ApiResult<BudgetMonthDto> {
    validate::id("instanceId", &req.instance_id)?;
    let m = month("month", &req.month)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        Ok(budget_dto(
            &budget_month(&store, &req.instance_id, &l, m)?,
            &l.currency,
        ))
    })
    .await
}

/// `finance_budget_assign` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignReq {
    instance_id: String,
    month: String,
    category_id: String,
    amount: String,
}

/// `finance_budget_assign` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignDto {
    available: String,
    to_be_assigned: String,
}

/// `finance_budget_assign({ instanceId, month, categoryId, amount }) → { available, toBeAssigned }`: writes the
/// assignment row of the *Budgets* database (creating it when missing).
#[tauri::command]
pub async fn finance_budget_assign(app: AppHandle, req: AssignReq) -> ApiResult<AssignDto> {
    validate::id("instanceId", &req.instance_id)?;
    validate::id("categoryId", &req.category_id)?;
    let m = month("month", &req.month)?;
    let value = dec("amount", &req.amount)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        if !l.categories.iter().any(|c| c.id == req.category_id) {
            return Err(ApiError::not_found("category"));
        }
        let d = l.db("budgets")?;
        let (Some(mcol), Some(ccol), Some(acol)) = (
            d.keyed_id("month", &["Month"]),
            d.keyed_id("category", &["Category"]),
            d.keyed_id("assigned", &["Assigned"]),
        ) else {
            return Err(ApiError::invalid(
                "instanceId",
                "the Budgets database is missing columns",
            ));
        };
        let money = CellValue::Money {
            v: Some(value.normalize().to_string()),
            cur: l.currency.clone(),
        };
        let existing = d.rows.iter().find(|r| {
            text(r.values.get(&mcol)).trim() == m.to_string()
                && rel(r.values.get(&ccol)).as_deref() == Some(&req.category_id)
        });
        match existing {
            Some(r) => {
                store.db_rows_update(vec![RowUpdate::one(&r.id, &acol, Some(money))])?;
            }
            None => {
                let name = l
                    .categories
                    .iter()
                    .find(|c| c.id == req.category_id)
                    .map_or_else(String::new, |c| c.name.clone());
                let mut values = BTreeMap::new();
                values.insert(
                    d.title_id().to_owned(),
                    CellValue::text(&format!("{name} · {m}")),
                );
                values.insert(mcol.clone(), CellValue::text(&m.to_string()));
                values.insert(
                    ccol.clone(),
                    CellValue::Relation {
                        v: vec![req.category_id.clone()],
                    },
                );
                values.insert(acol.clone(), money);
                store.db_rows_insert_bulk(d.id(), vec![values], None)?;
            }
        }
        let l = Ledger::load(&store, &req.instance_id)?;
        let bm = budget_month(&store, &req.instance_id, &l, m)?;
        Ok(AssignDto {
            available: s(bm
                .category(&req.category_id)
                .map(|c| c.available)
                .unwrap_or_default()),
            to_be_assigned: s(bm.to_be_assigned.unwrap_or_default()),
        })
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── statement import

struct StagedImport {
    instance_id: String,
    name: String,
    bytes: Arc<Vec<u8>>,
    format: ImportFormat,
    fingerprint: Option<String>,
    expires: Instant,
}

static IMPORTS: LazyLock<Mutex<HashMap<String, StagedImport>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Drops every staged statement import (lock hygiene: the bytes are decrypted user data).
pub fn clear_staged_imports() {
    clear_ledger_cache();
    IMPORTS.lock().clear();
}

/// A staged import: instance, file name, bytes, format and CSV header fingerprint.
type Staged = (String, String, Arc<Vec<u8>>, ImportFormat, Option<String>);

fn staged_import(id: &str) -> ApiResult<Staged> {
    let now = Instant::now();
    let mut m = IMPORTS.lock();
    m.retain(|_, s| s.expires > now);
    let s = m.get(id).ok_or_else(|| {
        ApiError::invalid("importId", "this import expired; choose the file again")
    })?;
    Ok((
        s.instance_id.clone(),
        s.name.clone(),
        Arc::clone(&s.bytes),
        s.format,
        s.fingerprint.clone(),
    ))
}

/// A saved CSV import profile.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProfile {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Mapping.
    pub mapping: ImportMapping,
}

/// `finance_import_start` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportStartReq {
    instance_id: String,
    grant_id: String,
}

/// `finance_import_start` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStartDto {
    import_id: String,
    format: ImportFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    columns: Option<Vec<String>>,
    sample: Vec<Vec<String>>,
    mapping_guess: ImportMapping,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_match: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_guess: Option<String>,
    row_count: usize,
    encoding: String,
    warnings: Vec<String>,
}

/// `finance_import_start({ instanceId, grantId }) → { importId, format, columns?, sample, mappingGuess, profileMatch?,
/// accountGuess?, rowCount, encoding }` (CSV, OFX, QFX, QIF; saved CSV profiles apply automatically).
#[tauri::command]
pub async fn finance_import_start(
    app: AppHandle,
    req: ImportStartReq,
) -> ApiResult<ImportStartDto> {
    validate::id("instanceId", &req.instance_id)?;
    validate::grant_id("grantId", &req.grant_id)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        // Peeked, not redeemed: the statement is staged below by import id, and the same grant stays usable by a
        // generic importer afterwards (e.g. "import as a table instead").
        let file = peek_file(
            &state,
            &req.grant_id,
            &[GrantPurpose::Import],
            caps::STATEMENT,
        )?;
        let opts = ImportOptions {
            confirmed_large: true,
            ..ImportOptions::default()
        };
        let st = crate::jobs::catch_panics(|| {
            emp_finance::import::start(&file.bytes, Some(&file.name), &opts)
        })
        .map_err(|_| ApiError::invalid("grantId", "This statement could not be read"))?
        .map_err(fin_err)?;
        let mut mapping = st.mapping_guess.clone();
        let mut profile_match = None;
        if let Some(fp) = &st.header_fingerprint
            && let Some(p) = store
                .kv_get_any(PROFILES_NS, fp)?
                .and_then(|v| serde_json::from_value::<ImportProfile>(v).ok())
        {
            mapping = p.mapping.clone();
            profile_match = Some(json!({ "id": p.id, "name": p.name }));
        }
        let last4 = st
            .account
            .as_ref()
            .and_then(emp_finance::import::StatementAccount::last4);
        let open: Vec<&Account> = l.accounts.iter().filter(|a| !a.closed).collect();
        let account_guess = last4
            .and_then(|l4| {
                open.iter()
                    .find(|a| a.name.contains(&l4))
                    .map(|a| a.id.clone())
            })
            .or_else(|| (open.len() == 1).then(|| open[0].id.clone()));
        let import_id = emp_store::model::ids::new_id();
        {
            let now = Instant::now();
            let mut m = IMPORTS.lock();
            m.retain(|_, s| s.expires > now);
            while m.len() >= MAX_IMPORTS {
                let Some(k) = m
                    .iter()
                    .min_by_key(|(_, s)| s.expires)
                    .map(|(k, _)| k.clone())
                else {
                    break;
                };
                m.remove(&k);
            }
            m.insert(
                import_id.clone(),
                StagedImport {
                    instance_id: req.instance_id.clone(),
                    name: file.name.clone(),
                    bytes: Arc::clone(&file.bytes),
                    format: st.format,
                    fingerprint: st.header_fingerprint.clone(),
                    expires: now + IMPORT_TTL,
                },
            );
        }
        Ok(ImportStartDto {
            import_id,
            format: st.format,
            columns: st.columns,
            sample: st.sample,
            mapping_guess: mapping,
            profile_match,
            account_guess,
            row_count: st.row_count,
            encoding: st.encoding,
            warnings: st.warnings,
        })
    })
    .await
}

/// One preview row (IPC shape).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRowDto {
    idx: usize,
    date: String,
    payee: String,
    raw_payee: String,
    amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category_id: Option<String>,
    confidence: emp_finance::import::preview::Confidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    rule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duplicate_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    possible_duplicate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transfer_pair: Option<String>,
    #[serde(skip)]
    import_key: String,
    #[serde(skip)]
    memo: String,
    /// The bank has cleared this row: every OFX/QFX row (posted), QIF rows whose `C` field says so; never CSV.
    #[serde(skip)]
    cleared: bool,
}

/// `finance_import_preview` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDto {
    rows: Vec<PreviewRowDto>,
    new_count: usize,
    duplicates: usize,
    categorized: usize,
    /// The closing balance the file reports (OFX `<LEDGERBAL>`, CSV balance column); absent for QIF.
    #[serde(skip_serializing_if = "Option::is_none")]
    statement: Option<StatementDto>,
}

/// `FinanceImportPreview.statement` (PROGRAMME-v3 K5 contract delta; see `src/backend/types.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementDto {
    balance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    as_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    currency: Option<String>,
    source: emp_finance::import::BalanceSource,
}

impl From<emp_finance::import::ClosingBalance> for StatementDto {
    fn from(c: emp_finance::import::ClosingBalance) -> Self {
        // Two decimals, like the mock's `centsToStr` ("3495.50"), so both sides send the same string.
        let mut balance = c.balance.round_dp(2);
        balance.rescale(2);
        Self {
            balance: balance.to_string(),
            as_of: c.as_of.map(|d| d.to_string()),
            currency: c.currency,
            source: c.source,
        }
    }
}

fn rules_of(store: &Store, instance_id: &str) -> ApiResult<Vec<Rule>> {
    Ok(store
        .kv_get_any(RULES_NS, instance_id)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

fn aliases_of(l: &Ledger) -> emp_finance::payee::PayeeAliases {
    let mut a = emp_finance::payee::PayeeAliases::new();
    if let Some(d) = l.dbs.get("payees") {
        let al = d.keyed_id("aliases", &["Aliases"]);
        let dc = d.keyed_id("default_category", &["Default category"]);
        for r in &d.rows {
            let p = emp_finance::payee::PayeeRef {
                payee_id: r.id.clone(),
                name: d.title(r),
                default_category_id: rel(dc.as_ref().and_then(|c| r.values.get(c))),
            };
            a.insert(&p.name, p.clone());
            for alias in text(al.as_ref().and_then(|c| r.values.get(c))).split([',', ';', '\n']) {
                let alias = alias.trim();
                if !alias.is_empty() {
                    a.insert(alias, p.clone());
                }
            }
        }
    }
    a
}

fn run_preview(
    store: &Store,
    import_id: &str,
    mapping: &ImportMapping,
    account_id: &str,
) -> ApiResult<(String, PreviewDto, Ledger, Option<String>)> {
    let (instance_id, name, bytes, format, fingerprint) = staged_import(import_id)?;
    let l = Ledger::load(store, &instance_id)?;
    let Some(account_name) = l
        .accounts
        .iter()
        .find(|a| a.id == account_id)
        .map(|a| a.name.clone())
    else {
        return Err(ApiError::invalid("accountId", "unknown account"));
    };
    let opts = ImportOptions {
        confirmed_large: true,
        ..ImportOptions::default()
    };
    let parsed = crate::jobs::catch_panics(|| {
        emp_finance::import::parse(&bytes, Some(&name), Some(mapping), &opts)
    })
    .map_err(|_| ApiError::invalid("mapping", "This statement could not be read"))?
    .map_err(fin_err)?;
    let rows: Vec<StatementTxn> = parsed.transactions().cloned().collect();
    let statement = parsed
        .closing_balance(&account_name)
        .map(StatementDto::from);
    let existing: Vec<emp_finance::dedupe::Existing> = l
        .txns
        .iter()
        .filter(|t| t.account_id == account_id)
        .map(|t| emp_finance::dedupe::Existing {
            id: t.id.clone(),
            import_id: t.import_id.clone(),
            date: t.date,
            amount: t.amount,
            payee: t.payee.clone(),
        })
        .collect();
    let others: Vec<emp_finance::transfers::TransferCandidate> = l
        .txns
        .iter()
        .filter(|t| t.account_id != account_id)
        .map(|t| emp_finance::transfers::TransferCandidate {
            id: t.id.clone(),
            account_id: t.account_id.clone(),
            date: t.date,
            amount: t.amount,
            linked: t.transfer_id.is_some(),
        })
        .collect();
    let owned: HashSet<String> = l.accounts.iter().map(|a| a.id.clone()).collect();
    let rules = RuleSet::compile(&rules_of(store, &instance_id)?).map_err(fin_err)?;
    let mut learner = CategoryLearner::new();
    for t in &l.txns {
        if let Some(c) = &t.category_id {
            learner.observe(&t.payee, c);
        }
    }
    let aliases = aliases_of(&l);
    let cx = emp_finance::import::preview::PreviewContext {
        account_id,
        format,
        existing: &existing,
        aliases: &aliases,
        rules: &rules,
        learner: &learner,
        other_accounts: &others,
        owned_accounts: &owned,
    };
    let p = emp_finance::import::preview::preview(&rows, &cx);
    let memos: HashMap<usize, String> = rows
        .iter()
        .map(|r| (r.idx, r.memo.clone().unwrap_or_default()))
        .collect();
    let cleared: HashMap<usize, bool> = rows
        .iter()
        .map(|r| {
            let c = match format {
                ImportFormat::Ofx | ImportFormat::Qfx => true,
                ImportFormat::Qif => emp_finance::import::qif_cleared(r.cleared.as_deref()),
                ImportFormat::Csv => false,
            };
            (r.idx, c)
        })
        .collect();
    let dto = PreviewDto {
        rows: p
            .rows
            .into_iter()
            .map(|r| PreviewRowDto {
                memo: memos.get(&r.idx).cloned().unwrap_or_default(),
                cleared: cleared.get(&r.idx).copied().unwrap_or(false),
                idx: r.idx,
                date: r.date.to_string(),
                payee: r.payee,
                raw_payee: r.raw_payee,
                amount: r.amount.normalize().to_string(),
                category_id: r.category_id,
                confidence: r.confidence,
                rule_id: r.rule_id,
                duplicate_of: r.duplicate_of,
                possible_duplicate: r.possible_duplicate,
                transfer_pair: r.transfer_pair,
                import_key: r.import_id,
            })
            .collect(),
        new_count: p.new_count,
        duplicates: p.duplicates,
        categorized: p.categorized,
        statement,
    };
    Ok((instance_id, dto, l, fingerprint))
}

/// `finance_import_preview` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportPreviewReq {
    import_id: String,
    mapping: ImportMapping,
    account_id: String,
}

fn check_mapping(m: &ImportMapping) -> ApiResult<()> {
    for c in [
        m.date, m.amount, m.debit, m.credit, m.payee, m.memo, m.balance,
    ]
    .into_iter()
    .flatten()
    {
        if c >= 512 {
            return Err(ApiError::invalid("mapping", "column out of range"));
        }
    }
    Ok(())
}

/// `finance_import_preview({ importId, mapping, accountId }) → { rows, newCount, duplicates, categorized }` (dedupe,
/// transfer pairing, rules and learned categories; nothing is written).
#[tauri::command]
pub async fn finance_import_preview(
    app: AppHandle,
    req: ImportPreviewReq,
) -> ApiResult<PreviewDto> {
    validate::id("importId", &req.import_id)?;
    validate::id("accountId", &req.account_id)?;
    check_mapping(&req.mapping)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(run_preview(&store, &req.import_id, &req.mapping, &req.account_id)?.1)
    })
    .await
}

/// A per-row override.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowOverride {
    #[serde(default)]
    category_id: Option<String>,
    #[serde(default)]
    payee: Option<String>,
}

/// `finance_import_commit` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportCommitReq {
    import_id: String,
    mapping: ImportMapping,
    account_id: String,
    #[serde(default)]
    skip: Vec<usize>,
    #[serde(default)]
    overrides: BTreeMap<String, RowOverride>,
    #[serde(default)]
    save_profile_as: Option<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `finance_import_commit({ importId, mapping, accountId, skip, overrides, saveProfileAs?, onEvent })` (job)
/// ⇒ `{ inserted, skipped, transfersLinked, importId }`. Exact duplicates are always skipped.
#[tauri::command]
pub async fn finance_import_commit(
    webview: Webview,
    state: State<'_, AppState>,
    req: ImportCommitReq,
) -> ApiResult<JobRef> {
    validate::id("importId", &req.import_id)?;
    validate::id("accountId", &req.account_id)?;
    check_mapping(&req.mapping)?;
    validate::list_len("skip", req.skip.len(), 5_000_000)?;
    validate::list_len("overrides", req.overrides.len(), 100_000)?;
    let mut overrides: HashMap<usize, RowOverride> = HashMap::new();
    for (k, v) in req.overrides {
        let idx: usize = k
            .parse()
            .map_err(|_| ApiError::invalid("overrides", "keys are row indexes"))?;
        validate::opt_id("overrides.categoryId", v.category_id.as_deref())?;
        if let Some(p) = &v.payee {
            validate::title("overrides.payee", p)?;
        }
        overrides.insert(idx, v);
    }
    if let Some(n) = &req.save_profile_as {
        validate::non_empty("saveProfileAs", n, 128)?;
    }
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let cell = super::import::import_cell();
    let out = Arc::clone(&cell);
    let job = state.jobs.spawn(
        "finance_import_commit",
        true,
        store.now(),
        sink,
        move |ctx| {
            let (undo_id, result) = commit_import(
                &store,
                ctx,
                &req.import_id,
                &req.mapping,
                &req.account_id,
                &req.skip,
                &overrides,
                req.save_profile_as.as_deref(),
            )?;
            *out.lock() = Some(undo_id);
            Ok(result)
        },
    );
    super::import::remember_job(&job, cell);
    Ok(job)
}

/// The body of `finance_import_commit` (also called directly by tests): writes the previewed rows, links transfers,
/// saves the CSV profile and records undo. Returns `(undo import id, result json)`.
///
/// Every inserted row carries `txn.cleared` (OFX/QFX rows are bank-posted, so cleared; QIF follows its `C`
/// field; CSV has no status, so uncleared), `txn.source = import` and `txn.reviewed = false` — the same as the
/// mock (`src/backend/mock/commands/finance.ts`). Dedupe is unchanged: exact duplicates are always skipped.
#[allow(clippy::too_many_arguments)]
fn commit_import(
    store: &Store,
    ctx: &crate::jobs::JobCtx,
    import_id: &str,
    mapping: &ImportMapping,
    account_id: &str,
    skip: &[usize],
    overrides: &HashMap<usize, RowOverride>,
    save_profile_as: Option<&str>,
) -> ApiResult<(String, Value)> {
    ctx.report(0, 3, Some("Checking"));
    let (_, preview, l, fingerprint) = run_preview(store, import_id, mapping, account_id)?;
    ctx.check_cancelled()?;
    let d = l.db("transactions")?;
    let c = |role: &str, n: &str| d.col_id(role, &[n]);
    let (dt, am, acct, cat, memo, imp, tr) = (
        c("txn.date", "Date"),
        c("txn.amount", "Amount"),
        c("txn.account", "Account"),
        c("txn.category", "Category"),
        c("txn.memo", "Memo"),
        c("txn.import_id", "Import ID"),
        c("txn.transfer", "Transfer"),
    );
    let raw = d
        .col_id("txn.raw", &[])
        .unwrap_or_else(|| d.title_id().to_owned());
    // Status/select cells hold option ids; resolve them once by option name.
    let cleared_col = d.col("txn.cleared", &["Cleared"]);
    let cleared_opt = |want: &str| cleared_col.and_then(|p| InstanceDb::option_id(p, want));
    let (opt_cleared, opt_uncleared) = (cleared_opt("cleared"), cleared_opt("uncleared"));
    let source = d
        .col("txn.source", &["Source"])
        .and_then(|p| InstanceDb::option_id(p, "import").map(|o| (p.id.clone(), o)));
    let reviewed = d.col_id("txn.reviewed", &["Reviewed"]);
    let cur = l
        .accounts
        .iter()
        .find(|a| a.id == account_id)
        .map_or_else(|| l.currency.clone(), |a| a.currency.code().to_owned());
    let skip: HashSet<usize> = skip.iter().copied().collect();
    let mut rows = Vec::new();
    let mut pairs = Vec::new();
    let mut skipped = 0usize;
    for r in &preview.rows {
        if skip.contains(&r.idx) || r.duplicate_of.is_some() {
            skipped += 1;
            continue;
        }
        let o = overrides.get(&r.idx);
        let mut v = BTreeMap::new();
        let title = o
            .and_then(|o| o.payee.clone())
            .unwrap_or_else(|| r.raw_payee.clone());
        v.insert(raw.clone(), CellValue::text(&title));
        if let Some(p) = &dt {
            v.insert(
                p.clone(),
                CellValue::Date {
                    v: Some(emp_store::dbmodel::DateValue {
                        start: r.date.clone(),
                        end: None,
                        time: false,
                        tz: None,
                    }),
                },
            );
        }
        if let Some(p) = &am {
            v.insert(
                p.clone(),
                CellValue::Money {
                    v: Some(r.amount.clone()),
                    cur: cur.clone(),
                },
            );
        }
        if let Some(p) = &acct {
            v.insert(
                p.clone(),
                CellValue::Relation {
                    v: vec![account_id.to_owned()],
                },
            );
        }
        let category = o
            .and_then(|o| o.category_id.clone())
            .or_else(|| r.category_id.clone());
        if let (Some(p), Some(cid)) = (&cat, category) {
            v.insert(p.clone(), CellValue::Relation { v: vec![cid] });
        }
        if let (Some(p), false) = (&memo, r.memo.is_empty()) {
            v.insert(p.clone(), CellValue::text(&r.memo));
        }
        if let Some(p) = &imp {
            v.insert(p.clone(), CellValue::text(&r.import_key));
        }
        let status = if r.cleared {
            &opt_cleared
        } else {
            &opt_uncleared
        };
        if let (Some(p), Some(opt)) = (cleared_col, status) {
            v.insert(
                p.id.clone(),
                CellValue::Status {
                    v: Some(opt.clone()),
                },
            );
        }
        if let Some((p, opt)) = &source {
            v.insert(
                p.clone(),
                CellValue::Select {
                    v: Some(opt.clone()),
                },
            );
        }
        if let Some(p) = &reviewed {
            v.insert(p.clone(), CellValue::Check { v: false });
        }
        pairs.push(r.transfer_pair.clone());
        rows.push(v);
    }
    ctx.report(1, 3, Some("Saving"));
    let mut ids = Vec::new();
    for chunk in rows.chunks(1_000) {
        ctx.check_cancelled()?;
        ids.extend(store.db_rows_insert_bulk(d.id(), chunk.to_vec(), None)?);
    }
    ctx.report(2, 3, Some("Linking transfers"));
    let mut linked = 0usize;
    if let Some(tp) = &tr {
        let mut updates = Vec::new();
        for (id, pair) in ids.iter().zip(&pairs) {
            if let Some(other) = pair {
                updates.push(RowUpdate::one(
                    id,
                    tp,
                    Some(CellValue::Relation {
                        v: vec![other.clone()],
                    }),
                ));
                updates.push(RowUpdate::one(
                    other,
                    tp,
                    Some(CellValue::Relation {
                        v: vec![id.clone()],
                    }),
                ));
                linked += 1;
            }
        }
        for chunk in updates.chunks(1_000) {
            store.db_rows_update(chunk.to_vec())?;
        }
    }
    if let (Some(name), Some(fp)) = (save_profile_as, &fingerprint) {
        let profile = ImportProfile {
            id: emp_store::model::ids::new_id(),
            name: name.trim().to_owned(),
            mapping: mapping.clone(),
        };
        store.kv_set_any(PROFILES_NS, fp, json!(profile), None)?;
    }
    let undo_id = emp_store::model::ids::new_id();
    super::ics::save_row_undo(store, &undo_id, &ids)?;
    ctx.report(3, 3, Some("Done"));
    let out = json!({ "inserted": ids.len(), "skipped": skipped, "transfersLinked": linked, "importId": undo_id });
    Ok((undo_id, out))
}

// ───────────────────────────────────────────────────────────────────────────── rules

/// An `{ instanceId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceReq {
    instance_id: String,
}

/// `finance_rules_list({ instanceId }) → Rule[]` (priority order).
#[tauri::command]
pub async fn finance_rules_list(app: AppHandle, req: InstanceReq) -> ApiResult<Vec<Rule>> {
    validate::id("instanceId", &req.instance_id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let mut rules = rules_of(&store, &req.instance_id)?;
        rules.sort_by_key(|r| r.priority);
        Ok(rules)
    })
    .await
}

/// A rule as sent by `finance_rule_upsert` (`id` optional, no `timesApplied`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleInput {
    #[serde(default)]
    id: Option<String>,
    name: String,
    priority: i64,
    when: emp_finance::rules::When,
    then: emp_finance::rules::Then,
    #[serde(rename = "continue")]
    continue_: bool,
}

/// `finance_rule_upsert` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleUpsertReq {
    instance_id: String,
    rule: RuleInput,
}

/// `finance_rule_upsert({ instanceId, rule }) → Rule` (regexes are size-limited; invalid rules are rejected).
#[tauri::command]
pub async fn finance_rule_upsert(app: AppHandle, req: RuleUpsertReq) -> ApiResult<Rule> {
    validate::id("instanceId", &req.instance_id)?;
    validate::opt_id("rule.id", req.rule.id.as_deref())?;
    validate::title("rule.name", &req.rule.name)?;
    validate::list_len("rule.when.all", req.rule.when.all.len(), 32)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let mut rules = rules_of(&store, &req.instance_id)?;
        let id = req
            .rule
            .id
            .clone()
            .unwrap_or_else(emp_store::model::ids::new_id);
        let times = rules
            .iter()
            .find(|r| r.id == id)
            .map_or(0, |r| r.times_applied);
        let rule = Rule {
            id: id.clone(),
            name: req.rule.name,
            priority: req.rule.priority,
            when: req.rule.when,
            then: req.rule.then,
            continue_: req.rule.continue_,
            times_applied: times,
        };
        emp_finance::rules::validate_rule(&rule).map_err(fin_err)?;
        match rules.iter_mut().find(|r| r.id == id) {
            Some(r) => *r = rule.clone(),
            None => {
                if rules.len() >= MAX_RULES {
                    return Err(ApiError::invalid("rule", "too many rules"));
                }
                rules.push(rule.clone());
            }
        }
        store.kv_set_any(RULES_NS, &req.instance_id, json!(rules), None)?;
        Ok(rule)
    })
    .await
}

/// `finance_rule_delete` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleDeleteReq {
    instance_id: String,
    id: String,
}

/// `finance_rule_delete({ instanceId, id }) → void`.
#[tauri::command]
pub async fn finance_rule_delete(app: AppHandle, req: RuleDeleteReq) -> ApiResult<()> {
    validate::id("instanceId", &req.instance_id)?;
    validate::id("id", &req.id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let mut rules = rules_of(&store, &req.instance_id)?;
        let n = rules.len();
        rules.retain(|r| r.id != req.id);
        if rules.len() == n {
            return Err(ApiError::not_found("rule"));
        }
        store.kv_set_any(RULES_NS, &req.instance_id, json!(rules), None)?;
        Ok(())
    })
    .await
}

/// `finance_rules_apply` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RulesApplyReq {
    instance_id: String,
    scope: RulesScope,
    dry_run: bool,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// Which transactions `finance_rules_apply` touches.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RulesScope {
    /// Only uncategorised transactions.
    Uncategorized,
    /// Every transaction.
    All,
}

/// `finance_rules_apply({ instanceId, scope, dryRun, onEvent })` (job) ⇒ `{ changed, sample }`.
#[tauri::command]
pub async fn finance_rules_apply(
    webview: Webview,
    state: State<'_, AppState>,
    req: RulesApplyReq,
) -> ApiResult<JobRef> {
    validate::id("instanceId", &req.instance_id)?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    Ok(state
        .jobs
        .spawn("finance_rules_apply", true, store.now(), sink, move |ctx| {
            let l = Ledger::load(&store, &req.instance_id)?;
            let mut rules = rules_of(&store, &req.instance_id)?;
            let set = RuleSet::compile(&rules).map_err(fin_err)?;
            let d = l.db("transactions")?;
            let cat = d.col_id("txn.category", &["Category"]).ok_or_else(|| {
                ApiError::invalid("instanceId", "transactions have no category column")
            })?;
            let names: HashMap<&str, &str> = l
                .categories
                .iter()
                .map(|c| (c.id.as_str(), c.name.as_str()))
                .collect();
            let mut updates = Vec::new();
            let mut sample = Vec::new();
            let mut applied: HashMap<String, u64> = HashMap::new();
            let total = l.txns.len() as u64;
            for (i, t) in l.txns.iter().enumerate() {
                if i % 500 == 0 {
                    ctx.check_cancelled()?;
                    ctx.report(i as u64, total, Some("Matching"));
                }
                if t.is_transfer()
                    || (req.scope == RulesScope::Uncategorized && t.category_id.is_some())
                {
                    continue;
                }
                let o = set.apply(&RuleTxn {
                    payee: &t.payee,
                    raw: &t.raw,
                    memo: &t.memo,
                    amount: t.amount,
                    account_id: &t.account_id,
                    date: t.date,
                });
                let Some(to) = o.category_id.clone() else {
                    continue;
                };
                if t.category_id.as_deref() == Some(to.as_str()) {
                    continue;
                }
                for r in &o.matched {
                    *applied.entry(r.clone()).or_default() += 1;
                }
                if sample.len() < 20 {
                    sample.push(json!({
                        "rowId": t.id,
                        "from": t.category_id.as_deref().and_then(|c| names.get(c)).copied(),
                        "to": names.get(to.as_str()).copied().unwrap_or(to.as_str()),
                    }));
                }
                updates.push(RowUpdate::one(
                    &t.id,
                    &cat,
                    Some(CellValue::Relation { v: vec![to] }),
                ));
            }
            let changed = updates.len();
            if !req.dry_run && changed > 0 {
                for chunk in updates.chunks(1_000) {
                    ctx.check_cancelled()?;
                    store.db_rows_update(chunk.to_vec())?;
                }
                for r in &mut rules {
                    r.times_applied += applied.get(&r.id).copied().unwrap_or(0);
                }
                store.kv_set_any(RULES_NS, &req.instance_id, json!(rules), None)?;
            }
            ctx.report(total, total, Some("Done"));
            Ok(json!({ "changed": changed, "sample": sample }))
        }))
}

// ───────────────────────────────────────────────────────────────────────────── recurring

/// One detected recurring series (IPC shape).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringDto {
    payee: String,
    cadence: emp_finance::recurring::Cadence,
    amount: MoneyDto,
    next_due: String,
    confidence: f64,
    row_ids: Vec<String>,
    kind: emp_finance::recurring::RecurringKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    price_change: Option<Value>,
}

/// `finance_recurring_detect({ instanceId }) → { payee, cadence, amount, nextDue, confidence, rowIds, priceChange? }[]`
/// (series already in *Recurring* are omitted).
#[tauri::command]
pub async fn finance_recurring_detect(
    app: AppHandle,
    req: InstanceReq,
) -> ApiResult<Vec<RecurringDto>> {
    validate::id("instanceId", &req.instance_id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        let today = local_today(&store);
        let known: HashSet<String> = l
            .dbs
            .get("recurring")
            .map(|d| {
                d.rows
                    .iter()
                    .map(|r| emp_finance::payee::payee_key(&d.title(r)))
                    .collect()
            })
            .unwrap_or_default();
        let txns: Vec<emp_finance::recurring::RecurringTxn> = l
            .txns
            .iter()
            .filter(|t| !t.is_transfer() && t.counts())
            .map(|t| emp_finance::recurring::RecurringTxn {
                id: t.id.clone(),
                date: t.date,
                amount: t.amount,
                payee: if t.payee.is_empty() {
                    t.raw.clone()
                } else {
                    t.payee.clone()
                },
            })
            .collect();
        let cal = HolidayCalendar::us_federal(today.year() - 1..=today.year() + 1);
        Ok(emp_finance::recurring::detect(&txns, &cal, Some(today))
            .into_iter()
            .filter(|c| !known.contains(&emp_finance::payee::payee_key(&c.payee)))
            .map(|c| RecurringDto {
                amount: MoneyDto::of(c.amount, &l.currency),
                next_due: c.next_due.to_string(),
                confidence: c.confidence,
                cadence: c.cadence,
                kind: c.kind,
                price_change: c
                    .price_change
                    .map(|p| json!({ "from": s(p.from), "to": s(p.to) })),
                payee: c.payee,
                row_ids: c.row_ids,
            })
            .collect())
    })
    .await
}

/// One accepted recurring item.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptItem {
    payee: String,
    cadence: String,
    amount: AcceptMoney,
    next_due: String,
    kind: String,
}

/// IPC `Money` on input.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptMoney {
    amount: String,
    currency: String,
}

/// `finance_recurring_accept` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptReq {
    instance_id: String,
    items: Vec<AcceptItem>,
}

/// The RRULE of a cadence.
pub fn cadence_rrule(cadence: &str) -> ApiResult<&'static str> {
    Ok(match cadence {
        "weekly" => "FREQ=WEEKLY",
        "biweekly" => "FREQ=WEEKLY;INTERVAL=2",
        "monthly" => "FREQ=MONTHLY",
        "quarterly" => "FREQ=MONTHLY;INTERVAL=3",
        "yearly" => "FREQ=YEARLY",
        _ => return Err(ApiError::invalid("items.cadence", "unknown cadence")),
    })
}

/// `finance_recurring_accept({ instanceId, items }) → { created }`: one *Recurring* row per item.
#[tauri::command]
pub async fn finance_recurring_accept(app: AppHandle, req: AcceptReq) -> ApiResult<Value> {
    validate::id("instanceId", &req.instance_id)?;
    if req.items.is_empty() {
        return Err(ApiError::invalid("items", "must not be empty"));
    }
    validate::list_len("items", req.items.len(), 500)?;
    for i in &req.items {
        validate::title("items.payee", &i.payee)?;
        cadence_rrule(&i.cadence)?;
        dec("items.amount.amount", &i.amount.amount)?;
        Currency::new(&i.amount.currency)
            .map_err(|_| ApiError::invalid("items.amount.currency", "invalid currency"))?;
        validate::ymd("items.nextDue", &i.next_due)?;
        if !matches!(i.kind.as_str(), "bill" | "subscription" | "income") {
            return Err(ApiError::invalid(
                "items.kind",
                "must be bill, subscription or income",
            ));
        }
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        let d = l.db("recurring")?;
        let am = d.col_id("rec.amount", &["Amount"]);
        let sc = d.col_id("rec.schedule", &["Schedule"]);
        let kind = d.col("rec.kind", &["Kind"]).cloned();
        let mut rows = Vec::new();
        for i in &req.items {
            let mut v = BTreeMap::new();
            v.insert(
                d.title_id().to_owned(),
                CellValue::Text {
                    v: rich(i.payee.trim()),
                },
            );
            if let Some(p) = &am {
                v.insert(
                    p.clone(),
                    CellValue::Money {
                        v: Some(i.amount.amount.clone()),
                        cur: i.amount.currency.clone(),
                    },
                );
            }
            if let Some(p) = &sc {
                v.insert(
                    p.clone(),
                    CellValue::Recurrence {
                        v: Some(RecurrenceValue {
                            rrule: cadence_rrule(&i.cadence)?.to_owned(),
                            dtstart: i.next_due.clone(),
                            tz: None,
                            mode: RecurrenceMode::Schedule,
                        }),
                    },
                );
            }
            if let Some(p) = &kind
                && let Some(opt) = InstanceDb::option_id(p, &i.kind)
            {
                v.insert(p.id.clone(), CellValue::Select { v: Some(opt) });
            }
            rows.push(v);
        }
        let created = store.db_rows_insert_bulk(d.id(), rows, None)?;
        Ok(json!({ "created": created }))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── planning (pure)

/// `finance_debt_plan({ debts, strategy, extraMonthly, order?, startMonth }) → { strategies, schedule }`.
#[tauri::command]
pub async fn finance_debt_plan(
    app: AppHandle,
    req: emp_finance::debt::DebtPlanRequest,
) -> ApiResult<emp_finance::debt::DebtPlanResponse> {
    if req.debts.is_empty() {
        return Err(ApiError::invalid("debts", "must not be empty"));
    }
    validate::list_len("debts", req.debts.len(), 100)?;
    for d in &req.debts {
        validate::title("debts.name", &d.name)?;
        dec("debts.balance", &d.balance)?;
        dec("debts.aprPct", &d.apr_pct)?;
        dec("debts.minPayment", &d.min_payment)?;
    }
    dec("extraMonthly", &req.extra_monthly)?;
    blocking(move || {
        app.state::<AppState>().session()?;
        emp_finance::debt::plan(&req).map_err(fin_err)
    })
    .await
}

/// `finance_amortization({ principal, annualRatePct, termMonths, extraMonthly?, startDate }) → { payment,
/// totalInterest, payoffDate, rows }`.
#[tauri::command]
pub async fn finance_amortization(
    app: AppHandle,
    req: emp_finance::amortize::AmortizationRequest,
) -> ApiResult<emp_finance::amortize::Amortization> {
    dec("principal", &req.principal)?;
    dec("annualRatePct", &req.annual_rate_pct)?;
    if req.term_months == 0 || req.term_months > 1_200 {
        return Err(ApiError::invalid("termMonths", "must be 1–1200"));
    }
    if let Some(x) = &req.extra_monthly {
        dec("extraMonthly", x)?;
    }
    validate::ymd("startDate", &req.start_date)?;
    blocking(move || {
        app.state::<AppState>().session()?;
        emp_finance::amortize::schedule(&req).map_err(fin_err)
    })
    .await
}

/// `finance_goal_plan({ target, by, current, annualYieldPct }) → { monthlyRequired, onTrack }`.
#[tauri::command]
pub async fn finance_goal_plan(
    app: AppHandle,
    req: emp_finance::goals::GoalPlanRequest,
) -> ApiResult<emp_finance::goals::GoalPlan> {
    dec("target", &req.target)?;
    dec("current", &req.current)?;
    dec("annualYieldPct", &req.annual_yield_pct)?;
    validate::ymd("by", &req.by)?;
    if let Some(c) = &req.monthly_contribution {
        dec("monthlyContribution", c)?;
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        emp_finance::goals::plan(&req, local_today(&store)).map_err(fin_err)
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── forecast

/// Converts a recurrence value to a forecast schedule (FREQ / INTERVAL / UNTIL of the RRULE).
#[must_use]
pub fn schedule_of(rv: &RecurrenceValue) -> Option<emp_finance::forecast::Schedule> {
    use emp_finance::forecast::{Frequency, Schedule};
    let anchor = NaiveDate::parse_from_str(rv.dtstart.get(..10)?, "%Y-%m-%d").ok()?;
    let rule = rv.rrule.trim().trim_start_matches("RRULE:");
    let mut freq = None;
    let mut interval = 1u32;
    let mut until = None;
    for part in rule.split(';') {
        let (k, v) = part.split_once('=')?;
        match k.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.trim().to_ascii_uppercase().as_str() {
                    "DAILY" => Frequency::Daily,
                    "WEEKLY" => Frequency::Weekly,
                    "MONTHLY" => Frequency::Monthly,
                    "YEARLY" => Frequency::Yearly,
                    _ => return None,
                });
            }
            "INTERVAL" => {
                interval = v
                    .trim()
                    .parse()
                    .ok()
                    .filter(|n: &u32| (1..=1000).contains(n))?
            }
            "UNTIL" => until = NaiveDate::parse_from_str(v.get(..8)?, "%Y%m%d").ok(),
            _ => {}
        }
    }
    Some(Schedule::Every {
        freq: freq?,
        interval,
        anchor,
        until,
    })
}

/// `finance_forecast` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForecastReq {
    instance_id: String,
    horizon_days: u32,
    band: bool,
}

/// `finance_forecast` result.
#[derive(Debug, Serialize)]
pub struct ForecastDto {
    t: Vec<String>,
    balance: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p10: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p90: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    threshold: Option<f64>,
    breaches: Vec<Value>,
}

/// `finance_forecast({ instanceId, horizonDays, band }) → { t, balance, p10?, p90?, threshold?, breaches }` (on-budget
/// cash accounts; recurring items expanded; discretionary spend bootstrapped for the band).
#[tauri::command]
pub async fn finance_forecast(app: AppHandle, req: ForecastReq) -> ApiResult<ForecastDto> {
    validate::id("instanceId", &req.instance_id)?;
    if req.horizon_days == 0 || req.horizon_days > emp_finance::forecast::MAX_HORIZON_DAYS {
        return Err(ApiError::invalid("horizonDays", "must be 1–730"));
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let l = Ledger::load(&store, &req.instance_id)?;
        let today = local_today(&store);
        let cash: Vec<&Account> = l
            .accounts
            .iter()
            .filter(|a| a.kind.is_liquid() && a.on_budget && !a.closed && a.currency.code() == l.currency)
            .collect();
        let accounts: Vec<emp_finance::forecast::ForecastAccount> = cash
            .iter()
            .map(|a| emp_finance::forecast::ForecastAccount {
                id: a.id.clone(),
                balance: l.balance(a, today),
                low_threshold: a.low_threshold,
            })
            .collect();
        let spending = cash.iter().find(|a| a.kind == AccountType::Checking).or(cash.first()).map(|a| a.id.clone());
        let mut recurring = Vec::new();
        if let Some(d) = l.dbs.get("recurring") {
            let am = d.col_id("rec.amount", &["Amount"]);
            let sc = d.col_id("rec.schedule", &["Schedule"]);
            let ac = d.col_id("rec.account", &["Account"]);
            let kind = d.col("rec.kind", &["Kind"]);
            for r in &d.rows {
                let Some(CellValue::Recurrence { v: Some(rv) }) = sc.as_ref().and_then(|c| r.values.get(c)) else {
                    continue;
                };
                let (Some(schedule), Some(mut amt)) = (schedule_of(rv), amount(am.as_ref().and_then(|c| r.values.get(c))))
                else {
                    continue;
                };
                let income = d.option_name(r, kind).is_some_and(|k| norm(&k) == "income");
                if !income && amt > Decimal::ZERO {
                    amt = -amt;
                }
                let account_id = rel(ac.as_ref().and_then(|c| r.values.get(c)))
                    .or_else(|| spending.clone())
                    .unwrap_or_default();
                recurring.push(emp_finance::forecast::RecurringItem { name: d.title(r), amount: amt, account_id, schedule });
            }
        }
        let seed = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            store.vault_id().to_string().hash(&mut h);
            YearMonth::of(today).to_string().hash(&mut h);
            h.finish()
        };
        let ids = HashSet::new();
        let fc = emp_finance::forecast::cashflow(&emp_finance::forecast::ForecastInput {
            today,
            horizon_days: req.horizon_days,
            accounts: &accounts,
            spending_account: spending.as_deref(),
            recurring: &recurring,
            history: &l.txns,
            categories: &l.categories,
            recurring_txn_ids: &ids,
            band: req.band,
            seed,
            simulations: emp_finance::forecast::DEFAULT_SIMULATIONS,
        })
        .map_err(fin_err)?;
        Ok(ForecastDto {
            t: fc.t.iter().map(ToString::to_string).collect(),
            balance: fc.balance,
            p10: fc.p10,
            p90: fc.p90,
            threshold: fc.threshold,
            breaches: fc
                .breaches
                .into_iter()
                .map(|b| {
                    json!({ "date": b.date.to_string(), "accountId": b.account_id, "amount": s(b.amount),
                            "topOutflows": b.top_outflows })
                })
                .collect(),
        })
    })
    .await
}

/// Test helpers shared by the domain command modules.
#[cfg(test)]
pub(crate) mod test_support {
    /// An unencrypted temporary vault with one workspace.
    pub(crate) fn temp_store() -> (tempfile::TempDir, emp_store::Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = emp_store::StoreOptions::new(dir.path().join("device.key"));
        opts.background_indexing = false;
        let created = emp_store::Store::create(
            dir.path(),
            emp_store::CreateOptions {
                password: None,
                kdf: emp_crypto::KdfParams::INSECURE_TEST,
                auto_lock: emp_store::model::AutoLock::default(),
                workspace_name: Some("Test".into()),
            },
            opts,
        )
        .unwrap();
        (dir, created.store)
    }

    /// Installs `app_id` with sample data; returns (workspace id, instance id).
    pub(crate) fn install(store: &emp_store::Store, app_id: &str) -> (String, String) {
        let ws = store.workspace_list().unwrap().remove(0).id;
        let req: emp_store::LifeappInstall = serde_json::from_value(serde_json::json!({
            "appId": app_id, "answers": {}, "mode": "quick", "disabledKeys": [], "workspaceId": ws, "sampleData": true
        }))
        .unwrap();
        let r = store.lifeapp_install(&req, &emp_store::NoProgress).unwrap();
        (ws, r.instance_id)
    }
}

#[cfg(test)]
mod parity {
    //! Mock ↔ desktop parity (PROGRAMME-v3 K5): the fixture `crates/emp-finance/tests/fixtures/parity/fixture.json`
    //! runs through the app's own command path here and through the browser mock in
    //! `src/backend/mock/parity.test.ts`; both must produce exactly its `expect`.

    use super::*;
    use emp_store::Clock;

    const FIXTURE: &str =
        include_str!("../../../crates/emp-finance/tests/fixtures/parity/fixture.json");
    const DIR: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../crates/emp-finance/tests/fixtures/parity/"
    );

    struct Fixed(i64);
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    fn m2(s: &str) -> String {
        let mut d: Decimal = s.trim().parse().unwrap();
        d = d.round_dp(2);
        d.rescale(2);
        d.to_string()
    }

    fn rate(x: f64) -> f64 {
        (x * 1e10).round() / 1e10
    }

    fn store_at(today: &str) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = emp_store::StoreOptions::new(dir.path().join("device.key"));
        opts.background_indexing = false;
        let ms = chrono::DateTime::parse_from_rfc3339(&format!("{today}T15:30:00Z"))
            .unwrap()
            .timestamp_millis();
        opts.clock = Arc::new(Fixed(ms));
        let created = emp_store::Store::create(
            dir.path(),
            emp_store::CreateOptions {
                password: None,
                kdf: emp_crypto::KdfParams::INSECURE_TEST,
                auto_lock: emp_store::model::AutoLock::default(),
                workspace_name: Some("Parity".into()),
            },
            opts,
        )
        .unwrap();
        (dir, created.store)
    }

    fn stage(instance: &str, name: &str, bytes: Vec<u8>) -> (String, ImportMapping) {
        let opts = ImportOptions {
            confirmed_large: true,
            ..ImportOptions::default()
        };
        let st = emp_finance::import::start(&bytes, Some(name), &opts).unwrap();
        let id = emp_store::model::ids::new_id();
        IMPORTS.lock().insert(
            id.clone(),
            StagedImport {
                instance_id: instance.to_owned(),
                name: name.to_owned(),
                bytes: Arc::new(bytes),
                format: st.format,
                fingerprint: st.header_fingerprint,
                expires: Instant::now() + IMPORT_TTL,
            },
        );
        (id, st.mapping_guess)
    }

    #[test]
    fn parity_fixture_matches_the_mock() {
        let fx: Value = serde_json::from_str(FIXTURE).unwrap();
        let today_s = fx["today"].as_str().unwrap();
        let (_dir, store) = store_at(today_s);
        let today = local_today(&store);
        assert_eq!(today.to_string(), today_s);
        let ws = store.workspace_list().unwrap().remove(0).id;
        let req: emp_store::LifeappInstall = serde_json::from_value(json!({
            "appId": "money-hq", "answers": {}, "mode": "quick", "disabledKeys": [], "workspaceId": ws, "sampleData": false
        }))
        .unwrap();
        let inst = store
            .lifeapp_install(&req, &emp_store::NoProgress)
            .unwrap()
            .instance_id;
        let l = Ledger::load(&store, &inst).unwrap();
        let cur = l.currency.clone();
        let money = |v: &str| CellValue::Money {
            v: Some(v.to_owned()),
            cur: cur.clone(),
        };

        // Accounts.
        let a = l.db("accounts").unwrap();
        let a_type = a.col("acct.type", &["Type"]).unwrap();
        let a_open = a.col_id("acct.opening", &["Opening balance"]).unwrap();
        let a_budget = a.col_id("acct.on_budget", &["On budget"]).unwrap();
        let mut acct: HashMap<String, String> = HashMap::new();
        for x in fx["accounts"].as_array().unwrap() {
            let name = x["name"].as_str().unwrap();
            let mut v = BTreeMap::new();
            v.insert(a.title_id().to_owned(), CellValue::text(name));
            v.insert(
                a_type.id.clone(),
                CellValue::Select {
                    v: InstanceDb::option_id(a_type, x["type"].as_str().unwrap()),
                },
            );
            v.insert(a_open.clone(), money(x["opening"].as_str().unwrap()));
            v.insert(a_budget.clone(), CellValue::Check { v: true });
            let id = store
                .db_rows_insert_bulk(a.id(), vec![v], None)
                .unwrap()
                .remove(0);
            acct.insert(name.to_owned(), id);
        }

        // Transactions (entered by hand: cleared, reviewed, source manual).
        let d = l.db("transactions").unwrap();
        let col = |role: &str, n: &str| d.col_id(role, &[n]).unwrap();
        let cleared = d.col("txn.cleared", &["Cleared"]).unwrap();
        let source = d.col("txn.source", &["Source"]).unwrap();
        let mut rows = Vec::new();
        for t in fx["transactions"].as_array().unwrap() {
            let cat = t["category"].as_str().unwrap();
            let cid = l
                .categories
                .iter()
                .find(|c| c.name == cat)
                .unwrap_or_else(|| panic!("desktop has no category {cat}"))
                .id
                .clone();
            let mut v = BTreeMap::new();
            v.insert(
                d.col_id("txn.raw", &[])
                    .unwrap_or_else(|| d.title_id().to_owned()),
                CellValue::text(t["payee"].as_str().unwrap()),
            );
            v.insert(
                col("txn.date", "Date"),
                CellValue::Date {
                    v: Some(emp_store::dbmodel::DateValue {
                        start: t["date"].as_str().unwrap().to_owned(),
                        end: None,
                        time: false,
                        tz: None,
                    }),
                },
            );
            v.insert(
                col("txn.amount", "Amount"),
                money(t["amount"].as_str().unwrap()),
            );
            v.insert(
                col("txn.account", "Account"),
                CellValue::Relation {
                    v: vec![acct[t["account"].as_str().unwrap()].clone()],
                },
            );
            v.insert(
                col("txn.category", "Category"),
                CellValue::Relation { v: vec![cid] },
            );
            v.insert(
                cleared.id.clone(),
                CellValue::Status {
                    v: InstanceDb::option_id(cleared, "cleared"),
                },
            );
            v.insert(
                source.id.clone(),
                CellValue::Select {
                    v: InstanceDb::option_id(source, "manual"),
                },
            );
            v.insert(
                col("txn.reviewed", "Reviewed"),
                CellValue::Check { v: true },
            );
            rows.push(v);
        }
        store.db_rows_insert_bulk(d.id(), rows, None).unwrap();
        let before: HashSet<String> = Ledger::load(&store, &inst)
            .unwrap()
            .db("transactions")
            .unwrap()
            .rows
            .iter()
            .map(|r| r.id.clone())
            .collect();

        // Statement imports through the command path (`run_preview` + the `finance_import_commit` job body).
        let mut imports = Vec::new();
        for imp in fx["imports"].as_array().unwrap() {
            let file = imp["file"].as_str().unwrap();
            let bytes = std::fs::read(format!("{DIR}{file}")).unwrap();
            let (id, guess) = stage(&inst, file, bytes);
            let mapping: ImportMapping = match imp.get("mapping") {
                Some(m) => serde_json::from_value(m.clone()).unwrap(),
                None => guess,
            };
            let account = acct[imp["account"].as_str().unwrap()].clone();
            let (_, pv, _, _) = run_preview(&store, &id, &mapping, &account).unwrap();
            let (_, r) = commit_import(
                &store,
                &crate::jobs::JobCtx::detached(),
                &id,
                &mapping,
                &account,
                &[],
                &HashMap::new(),
                None,
            )
            .unwrap();
            imports.push(json!({
                "file": file,
                "inserted": r["inserted"],
                "skipped": r["skipped"],
                "newCount": pv.new_count,
                "duplicates": pv.duplicates,
                "statement": pv.statement.as_ref().map(|s| serde_json::to_value(s).unwrap()),
            }));
        }
        let l = Ledger::load(&store, &inst).unwrap();
        let d = l.db("transactions").unwrap();
        let reviewed = d.col_id("txn.reviewed", &["Reviewed"]).unwrap();
        let opt = |p: &Property, r: &RowDto| d.option_name(r, Some(p)).map(|n| norm(&n));
        let date_col = d.col_id("txn.date", &["Date"]).unwrap();
        let amt_col = d.col_id("txn.amount", &["Amount"]).unwrap();
        let mut imported: Vec<Value> = d
            .rows
            .iter()
            .filter(|r| !before.contains(&r.id))
            .map(|r| {
                let date = match r.values.get(&date_col) {
                    Some(CellValue::Date { v: Some(dv) }) => dv.start.clone(),
                    _ => String::new(),
                };
                let amount = match r.values.get(&amt_col) {
                    Some(CellValue::Money { v: Some(a), .. }) => m2(a),
                    _ => String::new(),
                };
                let rv = match r.values.get(&reviewed) {
                    Some(CellValue::Check { v }) => json!(v),
                    _ => Value::Null,
                };
                json!({ "date": date, "amount": amount, "cleared": opt(d.col("txn.cleared", &[]).unwrap(), r),
                        "source": opt(d.col("txn.source", &[]).unwrap(), r), "reviewed": rv })
            })
            .collect();
        imported.sort_by_key(|v| {
            format!(
                "{}{}",
                v["date"].as_str().unwrap_or(""),
                v["amount"].as_str().unwrap_or("")
            )
        });

        let month: YearMonth = fx["month"].as_str().unwrap().parse().unwrap();
        let ov = serde_json::to_value(overview(&store, &inst, month, None).unwrap()).unwrap();
        let from = month.first_day();
        let spent: Decimal = emp_finance::metrics::spending_breakdown(
            &l.txns,
            &l.categories,
            emp_finance::metrics::BreakdownBy::Category,
            from,
            today,
        )
        .iter()
        .map(|r| r.amount)
        .sum();
        let mut tax = Vec::new();
        for t in fx["tax"].as_array().unwrap() {
            let input: emp_finance::tax::engine::TaxInput =
                serde_json::from_value(t["input"].clone()).unwrap();
            let e = super::super::tax::run_estimate(&input, today).unwrap();
            tax.push(json!({
                "name": t["name"],
                "agi": m2(&e.agi.to_string()),
                "taxable": m2(&e.taxable.to_string()),
                "deduction": {
                    "kind": e.deduction.kind,
                    "amount": m2(&e.deduction.amount.to_string()),
                    "standardWouldBe": m2(&e.deduction.standard_would_be.to_string()),
                    "itemizedWouldBe": e.deduction.itemized_would_be.map(|x| m2(&x.to_string())),
                },
                "totalTax": m2(&e.total_tax.to_string()),
                "balance": m2(&e.balance.to_string()),
                "effectiveRate": rate(e.effective_rate),
            }));
        }
        // Tax Organizer Deductions rows → TaxInput (the Tax hub's path): category option (by name; desktop option
        // ids are generated) → engine kind, amount × pct (a fraction).
        let req: emp_store::LifeappInstall = serde_json::from_value(json!({
            "appId": "tax-organizer", "answers": {}, "mode": "quick", "disabledKeys": [], "workspaceId": ws, "sampleData": false
        }))
        .unwrap();
        let tax_inst = store
            .lifeapp_install(&req, &emp_store::NoProgress)
            .unwrap()
            .instance_id;
        let (_, dbs) = load_instance(&store, &tax_inst).unwrap();
        let ded = &dbs["deductions"];
        let cat = ded.col("taxded.category", &[]).unwrap();
        let pct_col = ded.col_id("taxded.pct", &[]).unwrap();
        let amt = ded.col_id("taxded.amount", &[]).unwrap();
        let categories: Vec<String> = cat.select_options().into_iter().map(|o| o.name).collect();
        let mut rows = Vec::new();
        for r in fx["deductionRows"]["rows"].as_array().unwrap() {
            let name = r["category"].as_str().unwrap();
            let mut v = BTreeMap::new();
            v.insert(
                ded.title_id().to_owned(),
                CellValue::text(r["desc"].as_str().unwrap()),
            );
            v.insert(
                cat.id.clone(),
                CellValue::Select {
                    v: Some(
                        InstanceDb::option_id(cat, name)
                            .unwrap_or_else(|| panic!("desktop has no deduction category {name}")),
                    ),
                },
            );
            v.insert(amt.clone(), money(r["amount"].as_str().unwrap()));
            v.insert(
                pct_col.clone(),
                CellValue::Number {
                    v: r["pct"].as_f64(),
                },
            );
            rows.push(v);
        }
        store.db_rows_insert_bulk(ded.id(), rows, None).unwrap();
        let (_, dbs) = load_instance(&store, &tax_inst).unwrap();
        let ded = &dbs["deductions"];
        let kinds: HashMap<String, String> = fx["deductionCategories"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| {
                Some((
                    c["name"].as_str()?.to_owned(),
                    c["kind"].as_str()?.to_owned(),
                ))
            })
            .collect();
        let itemized: Vec<Value> = ded
            .rows
            .iter()
            .filter_map(|r| {
                let kind = kinds.get(&ded.option_name(r, ded.col("taxded.category", &[]))?)?;
                let a: Decimal = match r.values.get(&amt) {
                    Some(CellValue::Money { v: Some(a), .. }) => a.parse().ok()?,
                    _ => return None,
                };
                let p = match r.values.get(&pct_col) {
                    Some(CellValue::Number { v: Some(p) }) => Decimal::try_from(*p).ok()?,
                    _ => Decimal::ONE,
                };
                Some(json!({ "kind": kind, "amount": m2(&(a * p).to_string()) }))
            })
            .collect();
        let mut d_input = fx["deductionRows"]["input"].clone();
        d_input["deductions"]["itemized"] = Value::Array(itemized.clone());
        let d_input: emp_finance::tax::engine::TaxInput = serde_json::from_value(d_input).unwrap();
        let de = super::super::tax::run_estimate(&d_input, today).unwrap();
        let deduction_rows = json!({
            "categories": categories,
            "itemized": itemized,
            "deduction": {
                "kind": de.deduction.kind,
                "amount": m2(&de.deduction.amount.to_string()),
                "standardWouldBe": m2(&de.deduction.standard_would_be.to_string()),
                "itemizedWouldBe": de.deduction.itemized_would_be.map(|x| m2(&x.to_string())),
            },
            "totalTax": m2(&de.total_tax.to_string()),
        });
        let names: Vec<&str> = fx["deductionCategories"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["name"].as_str())
            .collect();
        assert_eq!(
            categories, names,
            "Deductions categories differ from the fixture"
        );

        let amount = |k: &str| m2(ov[k]["amount"].as_str().unwrap_or("0"));
        let to_review = imported
            .iter()
            .filter(|r| r["reviewed"] == json!(false))
            .count();
        let got = json!({
            "netWorth": amount("netWorth"),
            "assets": amount("assets"),
            "liabilities": amount("liabilities"),
            "savingsRate3m": rate(ov["savingsRate3m"].as_f64().unwrap()),
            "spent": m2(&spent.to_string()),
            "toReview": to_review,
            "imports": imports,
            "imported": imported,
            "tax": tax,
            "deductionRows": deduction_rows,
        });
        if std::env::var("PARITY_PRINT").is_ok() {
            println!("{}", serde_json::to_string_pretty(&got).unwrap());
        }
        assert_eq!(
            got, fx["expect"],
            "desktop figures differ from the parity fixture"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_names_normalise() {
        assert_eq!(norm("Credit card"), "credit_card");
        assert_eq!(norm("Savings & Debt"), "savings_debt");
        assert_eq!(account_type(Some("Credit card")), AccountType::CreditCard);
        assert_eq!(account_type(Some("Mystery")), AccountType::OtherAsset);
        assert_eq!(account_type(None), AccountType::Checking);
    }

    #[test]
    fn months_and_amounts_validate() {
        assert_eq!(month("m", "2026-11").unwrap().to_string(), "2026-11");
        assert!(month("m", "2026-13").is_err());
        assert!(month("m", "2026-1").is_err());
        assert_eq!(
            dec("a", "12.50").unwrap(),
            "12.50".parse::<Decimal>().unwrap()
        );
        assert!(dec("a", "1e5").is_err());
    }

    #[test]
    fn money_dto_rounds_to_cents() {
        let m = MoneyDto::of("12.345".parse().unwrap(), "USD");
        assert_eq!(m.amount, "12.34");
        assert_eq!(MoneyDto::of(Decimal::from(5), "EUR").amount, "5");
    }

    #[test]
    fn rrules_become_schedules() {
        let rv = RecurrenceValue {
            rrule: "RRULE:FREQ=MONTHLY;INTERVAL=3;UNTIL=20271231".into(),
            dtstart: "2026-01-15".into(),
            tz: None,
            mode: RecurrenceMode::Schedule,
        };
        match schedule_of(&rv).unwrap() {
            emp_finance::forecast::Schedule::Every {
                interval, until, ..
            } => {
                assert_eq!(interval, 3);
                assert_eq!(until, NaiveDate::from_ymd_opt(2027, 12, 31));
            }
            other => panic!("unexpected {other:?}"),
        }
        let bad = RecurrenceValue {
            rrule: "FREQ=HOURLY".into(),
            ..rv
        };
        assert!(schedule_of(&bad).is_none());
        assert_eq!(cadence_rrule("biweekly").unwrap(), "FREQ=WEEKLY;INTERVAL=2");
        assert!(cadence_rrule("daily").is_err());
    }

    #[test]
    fn finance_errors_map_to_codes() {
        assert_eq!(fin_err(FinanceError::invalid("x")).code, ErrorCode::Invalid);
        assert_eq!(fin_err(FinanceError::Cancelled).code, ErrorCode::Cancelled);
        assert_eq!(
            fin_err(FinanceError::TooLarge("x".into())).code,
            ErrorCode::TooLarge
        );
    }

    #[test]
    fn cells_are_read_by_kind() {
        assert_eq!(
            amount(Some(&CellValue::Money {
                v: Some("-4.20".into()),
                cur: "USD".into()
            })),
            Some("-4.20".parse().unwrap())
        );
        assert_eq!(amount(Some(&CellValue::Number { v: Some(f64::NAN) })), None);
        assert_eq!(
            rel(Some(&CellValue::Relation {
                v: vec!["a".into(), "b".into()]
            }))
            .as_deref(),
            Some("a")
        );
        assert!(check(Some(&CellValue::Check { v: true })));
        assert_eq!(
            date(Some(&CellValue::Date {
                v: Some(emp_store::dbmodel::DateValue {
                    start: "2026-03-04T10:00:00Z".into(),
                    end: None,
                    time: true,
                    tz: None
                })
            })),
            NaiveDate::from_ymd_opt(2026, 3, 4)
        );
    }

    #[test]
    fn pure_planners_run() {
        let req: emp_finance::debt::DebtPlanRequest = serde_json::from_value(json!({
            "debts": [{ "name": "Card", "balance": "2000", "aprPct": "24", "minPayment": "60" }],
            "strategy": "avalanche", "extraMonthly": "100", "startMonth": "2026-11"
        }))
        .unwrap();
        let p = emp_finance::debt::plan(&req).unwrap();
        assert!(!p.strategies.is_empty());
        let a: emp_finance::amortize::AmortizationRequest = serde_json::from_value(json!({
            "principal": "10000", "annualRatePct": "6", "termMonths": 12, "startDate": "2026-01-01"
        }))
        .unwrap();
        assert_eq!(emp_finance::amortize::schedule(&a).unwrap().rows.len(), 12);
    }

    #[test]
    fn loads_a_money_hq_ledger_and_computes_the_overview() {
        let (_dir, store) = test_support::temp_store();
        let (_, inst) = test_support::install(&store, "money-hq");
        let l = Ledger::load(&store, &inst).unwrap();
        assert!(!l.accounts.is_empty(), "accounts");
        assert!(!l.categories.is_empty(), "categories");
        assert!(!l.txns.is_empty(), "transactions");
        assert!(l.dbs.contains_key("budgets"));
        let today = local_today(&store);
        let o = overview(&store, &inst, YearMonth::of(today), None).unwrap();
        let v = serde_json::to_value(&o).unwrap();
        assert!(v["netWorth"]["amount"].is_string());
        assert!(v["budget"].is_array());
        let bm = budget_month(&store, &inst, &l, YearMonth::of(today)).unwrap();
        assert!(!bm.categories.is_empty());
        let sankey = emp_finance::metrics::cashflow_sankey(
            &l.txns,
            &l.categories,
            today - chrono::Duration::days(90),
            today,
        );
        assert!(!sankey.nodes.is_empty());
    }

    fn money_of(v: &serde_json::Value) -> Decimal {
        v["amount"].as_str().unwrap().parse().unwrap()
    }

    #[test]
    fn net_worth_is_one_figure_on_every_screen() {
        let (_dir, store) = test_support::temp_store();
        let (_, money) = test_support::install(&store, "money-hq");
        let today = local_today(&store);
        let month = YearMonth::of(today);
        assert!(
            portfolio_marks_cached(&store, None, &money, today, None)
                .unwrap()
                .is_none()
        );
        let check = |marks: Option<&PortfolioMarks>| {
            let o = serde_json::to_value(overview(&store, &money, month, marks).unwrap()).unwrap();
            let (nw, a, li) = (
                money_of(&o["netWorth"]),
                money_of(&o["assets"]),
                money_of(&o["liabilities"]),
            );
            assert_eq!(nw, a - li);
            // The hero (series' last point) and the overview (Accounts tiles, Home) are the same number.
            for months in [Some(6), Some(12), None] {
                let s = networth_series(&store, &money, months, marks).unwrap();
                let last = s.net.last().copied().unwrap();
                assert!(
                    (last - emp_finance::money::to_f64(nw)).abs() < 0.005,
                    "{last} vs {nw}"
                );
            }
            o
        };
        let without = check(None);
        assert!(without.get("investments").is_none());

        // With Portfolio installed its value replaces the investment accounts, once.
        test_support::install(&store, "portfolio");
        let (marks, need) = portfolio_marks_cached(&store, None, &money, today, None)
            .unwrap()
            .expect("portfolio");
        assert_eq!(
            need,
            MarksRefresh::default(),
            "no router: nothing to refetch"
        );
        let with = check(Some(&marks));
        let inv = money_of(&with["investments"]);
        assert_eq!(inv, marks.value_at(today));
        let l = Ledger::load(&store, &money).unwrap();
        let ledger_inv: Decimal = l
            .accounts
            .iter()
            .filter(|a| a.kind == AccountType::Investment && !a.closed)
            .map(|a| l.balance(a, today))
            .sum();
        assert_eq!(
            money_of(&with["netWorth"]) - money_of(&without["netWorth"]),
            inv - ledger_inv
        );
        // efMonths is exactly efBalance / essentialMonthly.
        let ef = emp_finance::money::to_f64(money_of(&with["efBalance"]));
        let ess = emp_finance::money::to_f64(money_of(&with["essentialMonthly"]));
        if ess > 0.0 {
            assert!((with["efMonths"].as_f64().unwrap() - ef / ess).abs() < 1e-9);
        }
    }

    #[test]
    fn life_app_metrics_are_the_overview_figures() {
        let (_dir, store) = test_support::temp_store();
        let (_, money) = test_support::install(&store, "money-hq");
        test_support::install(&store, "portfolio");
        register_metric_provider(&store);
        let today = local_today(&store);
        let from = today - chrono::Duration::days(31);
        let marks = portfolio_marks_cached(&store, None, &money, today, Some(from))
            .unwrap()
            .map(|(m, _)| m);
        let o = serde_json::to_value(
            overview(&store, &money, YearMonth::of(today), marks.as_ref()).unwrap(),
        )
        .unwrap();
        let m = store.lifeapp_metrics(&money, &[]).unwrap();
        let val = |k: &str| m.get(k).map(|v| v.value.clone()).unwrap_or(Value::Null);
        let num = |k: &str| val(k).as_f64().unwrap_or(f64::NAN);
        let dec = |k: &str| emp_finance::money::to_f64(money_of(&o[k]));
        assert!((num("net_worth") - dec("netWorth")).abs() < 0.005);
        assert!((num("net_worth_delta_30d") - dec("netWorthDelta30d")).abs() < 0.005);
        assert!((num("savings_rate_3m") - o["savingsRate3m"].as_f64().unwrap()).abs() < 1e-9);
        assert!((num("essential_monthly_spend") - dec("essentialMonthly")).abs() < 0.005);
        assert!((num("ef_balance") - dec("efBalance")).abs() < 0.005);
        assert!(
            (num("ef_months") - o["efMonths"].as_f64().unwrap()).abs() < 1e-6,
            "{} vs {}",
            num("ef_months"),
            o["efMonths"]
        );
        assert_eq!(
            val("debt_free_date").as_str(),
            o["debtFreeDate"].as_str(),
            "one debt-free date"
        );
        for (metric, field) in [
            ("to_be_assigned", "toBeAssigned"),
            ("left_to_spend", "leftToSpend"),
        ] {
            match o.get(field) {
                Some(v) => {
                    assert!((num(metric) - emp_finance::money::to_f64(money_of(v))).abs() < 0.005)
                }
                None => assert!(val(metric).is_null(), "{metric}: no figure, no fallback"),
            }
        }
        // "Show math" reproduces the result.
        let math = &m["net_worth"].math;
        assert_eq!(math[0].label, "Assets");
        assert_eq!(math[1].label, "Liabilities");
        assert!(marks.is_some());
        assert_eq!(
            math.get(2).map(|l| l.label.as_str()),
            Some("of which Portfolio"),
            "the provider, not the built-in, computed it"
        );
    }

    #[test]
    fn debt_free_date_is_the_minimum_payments_plan() {
        let (_dir, store) = test_support::temp_store();
        let (_, money) = test_support::install(&store, "money-hq");
        let today = local_today(&store);
        let l = Ledger::load(&store, &money).unwrap();
        let debts = ledger_debts(&l, today);
        let o = serde_json::to_value(overview(&store, &money, YearMonth::of(today), None).unwrap())
            .unwrap();
        // The sample's card and loan are entered as amounts owed (positive openings): they are debts, and
        // liabilities in net worth — never assets.
        assert_eq!(debts.len(), 2, "card and student loan");
        let owed: Decimal = debts.iter().map(|d| d.balance).sum();
        assert!(money_of(&o["liabilities"]) >= owed);
        // The Debt tab's planner, same debts, minimums only, starting next month.
        let req = emp_finance::debt::DebtPlanRequest {
            debts: debts
                .iter()
                .map(|d| emp_finance::debt::DebtInput {
                    name: d.name.clone(),
                    balance: d.balance.to_string(),
                    apr_pct: d.apr_pct.to_string(),
                    min_payment: d.min_payment.to_string(),
                })
                .collect(),
            strategy: emp_finance::debt::Strategy::Avalanche,
            extra_monthly: "0".into(),
            order: None,
            start_month: YearMonth::of(today).next(),
        };
        let plan = emp_finance::debt::plan(&req).unwrap();
        let min = plan
            .strategies
            .iter()
            .find(|s| s.strategy == "minimum")
            .unwrap();
        assert_eq!(
            o.get("debtFreeDate").and_then(Value::as_str),
            min.payoff_date.map(|m| m.to_string()).as_deref()
        );
        assert!(debts.iter().all(|d| d.min_payment > Decimal::ZERO));
    }

    #[test]
    fn the_series_reaches_back_to_portfolio_history() {
        let (_dir, store) = test_support::temp_store();
        let (_, money) = test_support::install(&store, "money-hq");
        test_support::install(&store, "portfolio");
        let today = local_today(&store);
        let (marks, _) = portfolio_marks_cached(&store, None, &money, today, Some(NaiveDate::MIN))
            .unwrap()
            .unwrap();
        let l = Ledger::load(&store, &money).unwrap();
        let ledger_first = l.txns.iter().map(|t| t.date).min().unwrap();
        let first = marks.first_date().unwrap().min(ledger_first);
        let s = networth_series(&store, &money, None, Some(&marks)).unwrap();
        assert_eq!(s.t.first().cloned(), Some(YearMonth::of(first).to_string()));
        assert!(
            (s.net.last().copied().unwrap()
                - emp_finance::money::to_f64(
                    l.net_worth_point(today, Some(marks.value_at(today)))
                        .unwrap()
                        .net_worth
                ))
            .abs()
                < 0.005
        );
    }

    #[test]
    fn manual_snapshots_override_past_months_but_automatic_ones_do_not() {
        let (_dir, store) = test_support::temp_store();
        let (_, inst) = test_support::install(&store, "money-hq");
        let today = local_today(&store);
        let l = Ledger::load(&store, &inst).unwrap();
        let d = l.dbs.get("networth").unwrap();
        let ids: Vec<String> = d.rows.iter().map(|r| r.id.clone()).collect();
        store.db_rows_delete(&ids).unwrap();
        let (acol, lcol) = (
            d.keyed_id("assets", &["Assets"]).unwrap(),
            d.keyed_id("liabilities", &["Liabilities"]).unwrap(),
        );
        let auto = d.keyed("source", &["Source"]).and_then(|p| {
            p.select_options()
                .into_iter()
                .find(|o| norm(&o.name) == "automatic")
                .map(|o| (p.id.clone(), o.id))
        });
        let cur = YearMonth::of(today);
        let row = |m: YearMonth, assets: &str, automatic: bool| {
            let mut v = BTreeMap::new();
            v.insert(d.title_id().to_owned(), CellValue::text(&m.to_string()));
            v.insert(
                acol.clone(),
                CellValue::Money {
                    v: Some(assets.into()),
                    cur: "USD".into(),
                },
            );
            v.insert(
                lcol.clone(),
                CellValue::Money {
                    v: Some("0".into()),
                    cur: "USD".into(),
                },
            );
            if let (true, Some((col, opt))) = (automatic, &auto) {
                v.insert(
                    col.clone(),
                    CellValue::Select {
                        v: Some(opt.clone()),
                    },
                );
            }
            v
        };
        store
            .db_rows_insert_bulk(
                d.id(),
                vec![
                    row(cur.plus_months(-1), "1", false),
                    row(cur.plus_months(-2), "2", true),
                    row(cur, "3", false),
                ],
                None,
            )
            .unwrap();
        let s = networth_series(&store, &inst, Some(6), None).unwrap();
        let at = |m: YearMonth| {
            s.t.iter()
                .position(|t| *t == m.to_string())
                .map(|i| s.net[i])
        };
        assert_eq!(
            at(cur.plus_months(-1)),
            Some(1.0),
            "a manual snapshot is the user's record"
        );
        assert_ne!(
            at(cur.plus_months(-2)),
            Some(2.0),
            "automatic rows never override the computation"
        );
        assert_ne!(at(cur), Some(3.0), "the current month is always live");
    }

    #[test]
    fn automatic_networth_snapshot_fills_the_current_month_once() {
        let (_dir, store) = test_support::temp_store();
        let (_, inst) = test_support::install(&store, "money-hq");
        let l = Ledger::load(&store, &inst).unwrap();
        let d = l.dbs.get("networth").expect("net worth database");
        let ids: Vec<String> = d.rows.iter().map(|r| r.id.clone()).collect();
        store.db_rows_delete(&ids).unwrap();

        let written = auto_networth_snapshots(&store).unwrap();
        assert_eq!(written, vec![d.id().to_owned()]);
        let l = Ledger::load(&store, &inst).unwrap();
        let d = l.dbs.get("networth").unwrap();
        assert_eq!(d.rows.len(), 1);
        let today = local_today(&store);
        assert_eq!(d.title(&d.rows[0]), YearMonth::of(today).to_string());
        let src = d.keyed("source", &["Source"]);
        assert_eq!(d.option_name(&d.rows[0], src).as_deref(), Some("Automatic"));
        let assets = d.keyed_id("assets", &["Assets"]).unwrap();
        assert!(matches!(
            d.rows[0].values.get(&assets),
            Some(CellValue::Money { v: Some(_), .. })
        ));

        // Once per month: a second run writes nothing.
        assert!(auto_networth_snapshots(&store).unwrap().is_empty());
    }

    #[test]
    fn budget_config_follows_the_wizard_answers() {
        let a = |v: Value| v.as_object().cloned().unwrap();
        let c = budget_config_from_answers(&a(json!({
            "method": "fifty_thirty_twenty",
            "currency": { "code": "USD", "monthStartDay": 15 },
            "income": { "stability": "irregular" }
        })));
        assert_eq!(c.method, BudgetMethod::FiftyThirtyTwenty);
        assert_eq!(c.month_start_day, 15);
        assert!(!c.income_buffer, "50/30/20 assigns no income");
        let c = budget_config_from_answers(&a(json!({
            "method": "zero_based",
            "currency": { "monthStartDay": 31 },
            "income": { "stability": "irregular" }
        })));
        assert_eq!(c.method, BudgetMethod::ZeroBased);
        assert_eq!(c.month_start_day, 28);
        assert!(c.income_buffer);
        let c = budget_config_from_answers(&a(json!({ "method": "made_up" })));
        assert_eq!(c.method, BudgetMethod::ZeroBased);
        assert_eq!(c.month_start_day, 1);
    }

    #[test]
    fn budget_config_prefers_stored_then_answers() {
        let (_dir, store) = test_support::temp_store();
        let (_, inst) = test_support::install(&store, "money-hq");
        let answers = store.lifeapp_answers(&inst).unwrap();
        let expected: BudgetMethod = serde_json::from_value(answers["method"].clone()).unwrap();
        assert_eq!(budget_config(&store, &inst).method, expected);
        let stored = BudgetConfig {
            method: BudgetMethod::Envelopes,
            month_start_day: 5,
            income_buffer: false,
            savings_target_pct: None,
        };
        store
            .kv_set_any(BUDGET_NS, &inst, json!(stored), None)
            .unwrap();
        assert_eq!(budget_config(&store, &inst), stored);
    }

    #[test]
    fn generated_databases_are_found_after_renames() {
        let (_dir, store) = test_support::temp_store();
        let (_, inst) = test_support::install(&store, "money-hq");
        let l = Ledger::load(&store, &inst).unwrap();
        let budgets = l.dbs.get("budgets").expect("budgets").clone();
        let assigned = budgets.keyed_id("assigned", &["Assigned"]).unwrap();
        let before = l.assignments.len();
        assert!(before > 0, "sample budget assignments");
        // Rename the database and its roleless column: title and name heuristics would both miss it now.
        store
            .page_update_meta(
                budgets.id(),
                emp_store::model::PageMetaPatch {
                    title: Some("Spending plan".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .db_property_update(
                &assigned,
                emp_store::dbmodel::PropertyPatch {
                    name: Some("Planned".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let l = Ledger::load(&store, &inst).unwrap();
        let d = l.dbs.get("budgets").expect("budgets after rename");
        assert_eq!(d.id(), budgets.id());
        assert_eq!(
            d.keyed_id("assigned", &["Assigned"]).as_deref(),
            Some(assigned.as_str())
        );
        assert_eq!(l.assignments.len(), before);
        assert!(l.dbs.contains_key("transactions"));
    }

    #[test]
    fn unknown_instances_are_not_found() {
        let (_dir, store) = test_support::temp_store();
        let e = Ledger::load(&store, "00000000-0000-0000-0000-000000000000").unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
    }
}
