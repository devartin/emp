//! Life-app commands (SPEC §6.5, §11.3 "Life apps", §16).
//!
//! Validated wrappers over `emp-store`'s life-app framework (`repo::lifeapps`): catalog, manifests, wizard
//! recommendations, plan previews, install / tune-up jobs, metrics and the advisor. Newly seen insights are announced
//! with `insight:new` (§11.4).
//!
//! Ultranote 1.0 additions: `lifeapp_install` takes an optional `parentId` (the hub is created inside that document
//! or project) and refuses a second instance of an app (`CONFLICT`, "… is already set up"); `lifeapp_event`
//! reports UI-only checklist events; `lifeapp_add_workbook` makes a new spreadsheet from a Spreadsheet Studio
//! template. [`start_upkeep`] runs the vault-open upgrade of older installs and keeps calculated columns current
//! (Tasks `Done` / recurring tasks, Habits streaks, Money account balances) after every database write.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::LazyLock;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use emp_store::Store;
use emp_store::dbmodel::{CellValue, ComputedKind, ComputedValue};
use emp_store::lifeapps::recommend::Recommendation;
use emp_store::model::PageMeta;
use emp_store::{
    GenerationPlan, Insight, InstallResult, LifeAppInstance, LifeAppManifest, LifeAppSummary,
    LifeappInstall, LifeappPreview, MetricValue, PlanDiff, SampleResult, TuneupResult,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Listener, Manager, State, Webview};

use super::import::cancelled_or;
use super::job_sink;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Serialised size limit of wizard answers.
pub const MAX_ANSWERS_BYTES: usize = 256 * 1024;
/// Insights remembered as already announced.
pub const SEEN_INSIGHTS_MAX: usize = 10_000;

static PACKS_REGISTERED: std::sync::Once = std::sync::Once::new();

/// Registers the built-in `emp-finance` tax packs for `pack.*` (Tax Organizer), once per process.
pub fn ensure_packs(store: &emp_store::Store) {
    PACKS_REGISTERED.call_once(|| match emp_finance::tax::pack::builtin_packs() {
        Ok(packs) => {
            for p in packs {
                if let Ok(v) = serde_json::to_value(&p) {
                    store.lifeapps_register_pack(&p.id, v);
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, "tax packs not registered"),
    });
}

fn session(app: &AppHandle) -> ApiResult<emp_store::Store> {
    let store = app.state::<AppState>().session()?;
    ensure_packs(&store);
    // Money HQ's headline metrics come from `finance_overview` (one definition per figure).
    super::finance::ensure_metric_provider(app, &store);
    upgrade(&store);
    Ok(store)
}

/// The once-per-session vault-open upgrade of apps installed by an older version (roles, option ids; see
/// `emp_store::lifeapps::upkeep`). A failure is logged and the app keeps working with what it has.
pub fn upgrade(store: &Store) {
    if let Err(e) = store.lifeapp_upgrade_all() {
        tracing::warn!(code = e.code(), "app upgrade failed");
    }
}

/// Validates a life-app or step id (`[a-z0-9_.-]`, ≤ 64).
pub fn app_id(field: &str, s: &str) -> ApiResult<()> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        });
    if ok {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "invalid id"))
    }
}

/// Bounds wizard answers.
pub fn answers(field: &str, a: &Map<String, Value>) -> ApiResult<()> {
    validate::list_len(field, a.len(), 500)?;
    let size = serde_json::to_vec(a).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > MAX_ANSWERS_BYTES {
        return Err(ApiError::invalid(field, "answers are too large"));
    }
    fn finite(v: &Value) -> bool {
        match v {
            Value::Number(n) => n.as_f64().is_none_or(f64::is_finite),
            Value::Array(a) => a.iter().all(finite),
            Value::Object(o) => o.values().all(finite),
            _ => true,
        }
    }
    if !a.values().all(finite) {
        return Err(ApiError::invalid(field, "numbers must be finite"));
    }
    Ok(())
}

fn keys(field: &str, v: &[String]) -> ApiResult<()> {
    validate::list_len(field, v.len(), 1_000)?;
    v.iter()
        .try_for_each(|k| validate::non_empty(field, k, 256))
}

/// `lifeapp_list({}) → LifeAppSummary[]`.
#[tauri::command]
pub async fn lifeapp_list(app: AppHandle, req: super::Empty) -> ApiResult<Vec<LifeAppSummary>> {
    let _ = req;
    blocking(move || Ok(session(&app)?.lifeapp_list(None)?)).await
}

/// A `{ id }` request with an app id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppIdReq {
    id: String,
}

/// `lifeapp_manifest({ id }) → LifeAppManifest`.
#[tauri::command]
pub async fn lifeapp_manifest(app: AppHandle, req: AppIdReq) -> ApiResult<LifeAppManifest> {
    app_id("id", &req.id)?;
    blocking(move || Ok(session(&app)?.lifeapp_manifest(&req.id)?)).await
}

/// `lifeapp_recommend` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecommendReq {
    app_id: String,
    step_id: String,
    #[serde(default)]
    answers: Map<String, Value>,
}

/// `lifeapp_recommend({ appId, stepId, answers }) → { value, why, source }`.
#[tauri::command]
pub async fn lifeapp_recommend(app: AppHandle, req: RecommendReq) -> ApiResult<Recommendation> {
    app_id("appId", &req.app_id)?;
    app_id("stepId", &req.step_id)?;
    answers("answers", &req.answers)?;
    blocking(move || {
        Ok(session(&app)?.lifeapp_recommend(&req.app_id, &req.step_id, &req.answers)?)
    })
    .await
}

/// `lifeapp_preview({ appId, answers, mode, disabledKeys }) → GenerationPlan` (pure).
#[tauri::command]
pub async fn lifeapp_preview(app: AppHandle, req: LifeappPreview) -> ApiResult<GenerationPlan> {
    app_id("appId", &req.app_id)?;
    answers("answers", &req.answers)?;
    keys("disabledKeys", &req.disabled_keys)?;
    blocking(move || Ok(session(&app)?.lifeapp_preview(&req)?)).await
}

/// `lifeapp_install` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallReq {
    app_id: String,
    #[serde(default)]
    answers: Map<String, Value>,
    mode: emp_store::LifeAppMode,
    #[serde(default)]
    disabled_keys: Vec<String>,
    workspace_id: String,
    #[serde(default)]
    sample_data: bool,
    /// Document or project the hub is created in (top level when absent).
    #[serde(default)]
    parent_id: Option<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `lifeapp_install({ appId, answers, mode, disabledKeys, workspaceId, sampleData, parentId?, onEvent })` (job)
/// ⇒ `{ instanceId, rootPageId, created }` (one transaction). One instance per app and workspace: a second one is
/// refused with `CONFLICT` before the job starts.
#[tauri::command]
pub async fn lifeapp_install(
    webview: Webview,
    state: State<'_, AppState>,
    req: InstallReq,
) -> ApiResult<JobRef> {
    app_id("appId", &req.app_id)?;
    answers("answers", &req.answers)?;
    keys("disabledKeys", &req.disabled_keys)?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    let store = state.session()?;
    ensure_packs(&store);
    if store
        .lifeapp_installed(&req.workspace_id, &req.app_id)?
        .is_some()
    {
        let name = store
            .lifeapp_manifest(&req.app_id)
            .map(|m| m.title)
            .unwrap_or_else(|_| "This app".into());
        return Err(ApiError::new(
            ErrorCode::Conflict,
            format!("{name} is already set up. Use Tune up to change it."),
        )
        .with_field("appId"));
    }
    let sink = job_sink(&webview, &req.on_event);
    let parent_id = req.parent_id;
    let install = LifeappInstall {
        app_id: req.app_id,
        answers: req.answers,
        mode: req.mode,
        disabled_keys: req.disabled_keys,
        workspace_id: req.workspace_id,
        sample_data: req.sample_data,
    };
    Ok(state.jobs.spawn(
        "lifeapp_install",
        true,
        store.now(),
        sink,
        move |ctx| -> ApiResult<InstallResult> {
            store
                .lifeapp_install_in(&install, parent_id.as_deref(), ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))
        },
    ))
}

/// A `{ workspaceId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReq {
    workspace_id: String,
}

/// `lifeapp_instances({ workspaceId }) → LifeAppInstance[]`.
#[tauri::command]
pub async fn lifeapp_instances(
    app: AppHandle,
    req: WorkspaceReq,
) -> ApiResult<Vec<LifeAppInstance>> {
    validate::id("workspaceId", &req.workspace_id)?;
    blocking(move || Ok(session(&app)?.lifeapp_instances(&req.workspace_id)?)).await
}

/// `lifeapp_tuneup_preview` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TuneupPreviewReq {
    instance_id: String,
    #[serde(default)]
    answers: Map<String, Value>,
}

/// `lifeapp_tuneup_preview({ instanceId, answers }) → { add, update, keep }`.
#[tauri::command]
pub async fn lifeapp_tuneup_preview(app: AppHandle, req: TuneupPreviewReq) -> ApiResult<PlanDiff> {
    validate::id("instanceId", &req.instance_id)?;
    answers("answers", &req.answers)?;
    blocking(move || Ok(session(&app)?.lifeapp_tuneup_preview(&req.instance_id, &req.answers)?))
        .await
}

/// `lifeapp_tuneup_apply` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TuneupApplyReq {
    instance_id: String,
    #[serde(default)]
    answers: Map<String, Value>,
    #[serde(default)]
    accept_conflicts: Vec<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `lifeapp_tuneup_apply({ instanceId, answers, acceptConflicts, onEvent })` (job) ⇒ `{ changed }`.
#[tauri::command]
pub async fn lifeapp_tuneup_apply(
    webview: Webview,
    state: State<'_, AppState>,
    req: TuneupApplyReq,
) -> ApiResult<JobRef> {
    validate::id("instanceId", &req.instance_id)?;
    answers("answers", &req.answers)?;
    keys("acceptConflicts", &req.accept_conflicts)?;
    let store = state.session()?;
    ensure_packs(&store);
    let sink = job_sink(&webview, &req.on_event);
    Ok(state.jobs.spawn(
        "lifeapp_tuneup_apply",
        true,
        store.now(),
        sink,
        move |ctx| -> ApiResult<TuneupResult> {
            store
                .lifeapp_tuneup_apply(&req.instance_id, &req.answers, &req.accept_conflicts, ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))
        },
    ))
}

/// An `{ instanceId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceReq {
    instance_id: String,
}

/// `lifeapp_detach({ instanceId }) → void` (content stays; the app stops managing it).
#[tauri::command]
pub async fn lifeapp_detach(app: AppHandle, req: InstanceReq) -> ApiResult<()> {
    validate::id("instanceId", &req.instance_id)?;
    blocking(move || Ok(session(&app)?.lifeapp_detach(&req.instance_id)?)).await
}

/// `lifeapp_uninstall` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallReq {
    instance_id: String,
    keep_content: bool,
}

/// `lifeapp_uninstall({ instanceId, keepContent }) → void`.
#[tauri::command]
pub async fn lifeapp_uninstall(app: AppHandle, req: UninstallReq) -> ApiResult<()> {
    validate::id("instanceId", &req.instance_id)?;
    blocking(move || Ok(session(&app)?.lifeapp_uninstall(&req.instance_id, req.keep_content)?))
        .await
}

/// `lifeapp_metrics` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricsReq {
    instance_id: String,
    #[serde(default)]
    names: Vec<String>,
}

/// `lifeapp_metrics({ instanceId, names }) → Record<string, { value, display, math, asOf }>` (all when `names` is
/// empty).
#[tauri::command]
pub async fn lifeapp_metrics(
    app: AppHandle,
    req: MetricsReq,
) -> ApiResult<BTreeMap<String, MetricValue>> {
    validate::id("instanceId", &req.instance_id)?;
    validate::list_len("names", req.names.len(), 200)?;
    for n in &req.names {
        app_id("names", n)?;
    }
    blocking(move || {
        let store = session(&app)?;
        crate::jobs::catch_panics(|| store.lifeapp_metrics(&req.instance_id, &req.names))
            .map_err(|_| ApiError::internal("metrics panicked"))?
            .map_err(Into::into)
    })
    .await
}

/// `lifeapp_insights` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InsightsReq {
    #[serde(default)]
    instance_id: Option<String>,
}

static SEEN: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Insights of `list` not announced before in this process.
pub fn unseen(list: &[Insight]) -> Vec<Insight> {
    let mut seen = SEEN.lock();
    if seen.len() > SEEN_INSIGHTS_MAX {
        seen.clear();
    }
    list.iter()
        .filter(|i| {
            i.muted_until.is_none() && seen.insert(format!("{}|{}", i.app_instance_id, i.id))
        })
        .cloned()
        .collect()
}

/// `lifeapp_insights({ instanceId? }) → Insight[]` (every attached instance when omitted, for Home).
#[tauri::command]
pub async fn lifeapp_insights(app: AppHandle, req: InsightsReq) -> ApiResult<Vec<Insight>> {
    validate::opt_id("instanceId", req.instance_id.as_deref())?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        ensure_packs(&store);
        super::finance::ensure_metric_provider(&app, &store);
        let list = crate::jobs::catch_panics(|| store.lifeapp_insights(req.instance_id.as_deref()))
            .map_err(|_| ApiError::internal("advisor panicked"))??;
        for i in unseen(&list) {
            state.events.emit(crate::events::INSIGHT_NEW, i);
        }
        Ok(list)
    })
    .await
}

/// `lifeapp_insight_mute` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MuteReq {
    instance_id: String,
    rule_id: String,
    until: Option<i64>,
}

/// `lifeapp_insight_mute({ instanceId, ruleId, until: Ts|null }) → void`.
#[tauri::command]
pub async fn lifeapp_insight_mute(app: AppHandle, req: MuteReq) -> ApiResult<()> {
    validate::id("instanceId", &req.instance_id)?;
    app_id("ruleId", &req.rule_id)?;
    if let Some(t) = req.until {
        validate::ts("until", t)?;
    }
    blocking(move || {
        Ok(session(&app)?.lifeapp_insight_mute(&req.instance_id, &req.rule_id, req.until)?)
    })
    .await
}

/// `lifeapp_sample_data` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleReq {
    instance_id: String,
    on: bool,
}

/// `lifeapp_sample_data({ instanceId, on }) → { rows }`.
#[tauri::command]
pub async fn lifeapp_sample_data(app: AppHandle, req: SampleReq) -> ApiResult<SampleResult> {
    validate::id("instanceId", &req.instance_id)?;
    blocking(move || Ok(session(&app)?.lifeapp_sample_data(&req.instance_id, req.on)?)).await
}

/// `lifeapp_checklist_tick` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TickReq {
    instance_id: String,
    item_id: String,
}

/// `lifeapp_checklist_tick({ instanceId, itemId }) → void`.
#[tauri::command]
pub async fn lifeapp_checklist_tick(app: AppHandle, req: TickReq) -> ApiResult<()> {
    validate::id("instanceId", &req.instance_id)?;
    app_id("itemId", &req.item_id)?;
    blocking(move || Ok(session(&app)?.lifeapp_checklist_tick(&req.instance_id, &req.item_id)?))
        .await
}

/// `lifeapp_event` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventReq {
    event: String,
    #[serde(default)]
    data: Map<String, Value>,
}

/// A checklist item an event ticked.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickedItem {
    instance_id: String,
    item_id: String,
}

/// `lifeapp_event({ event, data? }) → { instanceId, itemId }[]`: reports a UI-only event (`ips.signed`,
/// `rebalance.checked`, `tax.status_confirmed`, `habits.reflection_done`, `sheet.exported`, …) and returns the
/// checklist items it ticked.
#[tauri::command]
pub async fn lifeapp_event(app: AppHandle, req: EventReq) -> ApiResult<Vec<TickedItem>> {
    app_id("event", &req.event)?;
    answers("data", &req.data)?;
    blocking(move || {
        let store = session(&app)?;
        Ok(store
            .lifeapp_event(&req.event, &req.data)?
            .into_iter()
            .map(|(instance_id, item_id)| TickedItem {
                instance_id,
                item_id,
            })
            .collect())
    })
    .await
}

/// `lifeapp_add_workbook` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddWorkbookReq {
    instance_id: String,
    intent: String,
}

/// `lifeapp_add_workbook({ instanceId, intent }) → PageMeta`: a new spreadsheet from a Spreadsheet Studio template,
/// next to the Studio hub (a new one on every call).
#[tauri::command]
pub async fn lifeapp_add_workbook(app: AppHandle, req: AddWorkbookReq) -> ApiResult<PageMeta> {
    validate::id("instanceId", &req.instance_id)?;
    app_id("intent", &req.intent)?;
    blocking(move || Ok(session(&app)?.lifeapp_add_workbook(&req.instance_id, &req.intent)?)).await
}

// ───────────────────────────────────────────────────────────────────────────── upkeep

/// A message to the upkeep worker.
enum Upkeep {
    /// `db:changed` of a database (changed rows, or `None` for "anything").
    Db(String, Option<Vec<String>>),
    /// `vault:status` (unlock, lock, settings changes).
    Status,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbChangedMsg {
    database_id: String,
    #[serde(default)]
    row_ids: Option<Vec<String>>,
}

/// Writes coalesce for this long before upkeep runs.
const UPKEEP_DEBOUNCE: Duration = Duration::from_millis(150);
/// Idle wake-up (a new day moves streaks and recurring dates).
const UPKEEP_IDLE: Duration = Duration::from_secs(600);
/// Money balances are refreshed on unlock at most this often (writes refresh them anyway).
const MONEY_REFRESH: Duration = Duration::from_secs(600);

/// Starts the app upkeep worker. It listens to `db:changed` and `vault:status` (the store's event sink must not call
/// back into the store, so the listeners only queue work) and, on its own thread: runs the vault-open upgrade, keeps
/// Tasks / Habits columns and recurring tasks current ([`Store::lifeapp_react`]) and refreshes Money's account
/// `Balance` / `Cleared balance` columns from the ledger.
pub fn start_upkeep(app: &AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<Upkeep>();
    let db_tx = tx.clone();
    app.listen_any(crate::events::DB_CHANGED, move |e| {
        if let Ok(m) = serde_json::from_str::<DbChangedMsg>(e.payload()) {
            let _ = db_tx.send(Upkeep::Db(m.database_id, m.row_ids));
        }
    });
    app.listen_any(crate::events::VAULT_STATUS, move |_| {
        let _ = tx.send(Upkeep::Status);
    });
    let app = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("app-upkeep".into())
        .spawn(move || run_upkeep(&app, &rx))
    {
        tracing::warn!(error = %e, "app upkeep worker did not start");
    }
}

fn run_upkeep(app: &AppHandle, rx: &Receiver<Upkeep>) {
    let mut last_day: Option<chrono::NaiveDate> = None;
    let mut money_at: Option<Instant> = None;
    loop {
        let mut changes: BTreeMap<String, Option<BTreeSet<String>>> = BTreeMap::new();
        let mut status = false;
        let mut add = |m: Upkeep| match m {
            Upkeep::Db(id, rows) => {
                let e = changes.entry(id).or_insert_with(|| Some(BTreeSet::new()));
                match (e.as_mut(), rows) {
                    (Some(set), Some(rows)) => set.extend(rows),
                    _ => *e = None,
                }
            }
            Upkeep::Status => status = true,
        };
        match rx.recv_timeout(UPKEEP_IDLE) {
            Ok(m) => {
                add(m);
                let until = Instant::now() + UPKEEP_DEBOUNCE;
                while let Some(left) = until.checked_duration_since(Instant::now()) {
                    match rx.recv_timeout(left) {
                        Ok(m) => add(m),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let state = app.state::<AppState>();
        let Some(store) = state.store_opt() else {
            continue;
        };
        if !store.is_unlocked() {
            last_day = None;
            money_at = None;
            continue;
        }
        ensure_packs(&store);
        let result = crate::jobs::catch_panics(|| {
            upkeep_pass(&store, &changes, status, &mut last_day, &mut money_at);
        });
        if result.is_err() {
            tracing::warn!("app upkeep panicked");
        }
    }
}

fn upkeep_pass(
    store: &Store,
    changes: &BTreeMap<String, Option<BTreeSet<String>>>,
    status: bool,
    last_day: &mut Option<chrono::NaiveDate>,
    money_at: &mut Option<Instant>,
) {
    let today = super::finance::local_today(store);
    let new_day = last_day.is_some_and(|d| d != today);
    if status || last_day.is_none() {
        upgrade(store);
    }
    if new_day && let Err(e) = store.lifeapp_upkeep_all() {
        tracing::warn!(code = e.code(), "app upkeep failed");
    }
    *last_day = Some(today);
    let refresh_money =
        new_day || (status && money_at.is_none_or(|t| t.elapsed() >= MONEY_REFRESH));
    let mut money: BTreeSet<String> = BTreeSet::new();
    if !changes.is_empty() {
        let list: Vec<(String, Option<Vec<String>>)> = changes
            .iter()
            .map(|(d, r)| (d.clone(), r.as_ref().map(|s| s.iter().cloned().collect())))
            .collect();
        match store.lifeapp_react(&list) {
            Ok(touched) => money.extend(
                touched
                    .into_iter()
                    .filter(|(_, app)| app == "money-hq")
                    .map(|(id, _)| id),
            ),
            Err(e) => tracing::warn!(code = e.code(), "app upkeep failed"),
        }
    }
    if refresh_money && let Ok(ws) = store.workspace_list() {
        for w in ws {
            if let Ok(Some(id)) = store.lifeapp_installed(&w.id, "money-hq") {
                money.insert(id);
            }
        }
        *money_at = Some(Instant::now());
    }
    for id in money {
        if let Err(e) = money_columns(store, &id) {
            tracing::warn!(code = e.code.as_str(), "money columns not refreshed");
        }
    }
}

fn money_cell(d: emp_finance::Decimal, currency: &str) -> CellValue {
    let d = d.round_dp(2);
    CellValue::Computed {
        v: ComputedValue {
            kind: ComputedKind::Money,
            value: json!(d.normalize().to_string()),
            display: emp_store::lifeapps::metrics::format_money(
                emp_finance::money::to_f64(d),
                currency,
            ),
        },
    }
}

/// Money's calculated columns, from the ledger (the same definitions as the Money hub's figures): account balances,
/// budget lines and the next date of recurring items.
fn money_columns(store: &Store, instance_id: &str) -> ApiResult<()> {
    let l = super::finance::Ledger::load(store, instance_id)?;
    let today = super::finance::local_today(store);
    money_balances(store, &l, today)?;
    budget_lines(store, instance_id, &l)?;
    recurring_next(store, &l, today)?;
    Ok(())
}

/// `Balance` (opening balance plus every counted transaction up to today, the ledger's one definition) and
/// `Cleared balance` (the same over cleared and reconciled transactions) of every account.
fn money_balances(
    store: &Store,
    l: &super::finance::Ledger,
    today: chrono::NaiveDate,
) -> ApiResult<()> {
    let Some(acc) = l.dbs.get("accounts") else {
        return Ok(());
    };
    let bal = acc
        .col_id("acct.balance", &[])
        .or_else(|| acc.keyed_id("balance", &["Balance"]));
    let clr = acc
        .col_id("acct.cleared", &[])
        .or_else(|| acc.keyed_id("cleared", &["Cleared balance"]));
    if bal.is_none() && clr.is_none() {
        return Ok(());
    }
    let mut cleared: HashSet<&str> = HashSet::new();
    if let Some(t) = l.dbs.get("transactions") {
        let col = t.col("txn.cleared", &["Cleared"]);
        for r in &t.rows {
            if let Some(name) = t.option_name(r, col) {
                let n = super::finance::norm(&name);
                if n == "cleared" || n == "reconciled" {
                    cleared.insert(r.id.as_str());
                }
            }
        }
    }
    let mut updates = Vec::new();
    for a in &l.accounts {
        let cur = a.currency.code();
        if let Some(p) = &bal {
            updates.push((
                a.id.clone(),
                p.clone(),
                money_cell(l.balance(a, today), cur),
            ));
        }
        if let Some(p) = &clr {
            let sum: emp_finance::Decimal = l
                .txns
                .iter()
                .filter(|t| t.account_id == a.id && t.counts() && t.date <= today)
                .filter(|t| a.opening_date.is_none_or(|od| t.date >= od))
                .filter(|t| cleared.contains(t.id.as_str()))
                .map(|t| t.amount)
                .sum();
            updates.push((
                a.id.clone(),
                p.clone(),
                money_cell(a.opening_balance + sum, cur),
            ));
        }
    }
    store.lifeapp_set_computed(acc.id(), updates)?;
    Ok(())
}

/// `Activity` (the month's net spending in the category, negative = spent) and `Available` (what is left at month
/// end, rollover included) of every budget line, from `emp-finance`'s budget engine.
fn budget_lines(store: &Store, instance_id: &str, l: &super::finance::Ledger) -> ApiResult<()> {
    use emp_finance::budget::{BudgetInput, compute};
    use emp_finance::period::YearMonth;
    let Some(b) = l.dbs.get("budgets") else {
        return Ok(());
    };
    let act = b
        .col_id("budget.activity", &[])
        .or_else(|| b.keyed_id("activity", &["Activity"]));
    let avail = b
        .col_id("budget.available", &[])
        .or_else(|| b.keyed_id("available", &["Available"]));
    if act.is_none() && avail.is_none() {
        return Ok(());
    }
    let month_col = b
        .col_id("budget.month", &[])
        .or_else(|| b.keyed_id("month", &["Month"]));
    let cat_col = b
        .col_id("budget.category", &[])
        .or_else(|| b.keyed_id("category", &["Category"]));
    fn get<'a>(r: &'a emp_store::dbmodel::RowDto, c: &Option<String>) -> Option<&'a CellValue> {
        c.as_ref().and_then(|c| r.values.get(c))
    }
    let lines: Vec<(String, YearMonth, String)> = b
        .rows
        .iter()
        .filter_map(|r| {
            let m = super::finance::text(get(r, &month_col))
                .trim()
                .parse::<YearMonth>()
                .ok()?;
            let c = super::finance::rel(get(r, &cat_col))?;
            Some((r.id.clone(), m, c))
        })
        .collect();
    let (Some(first_line), Some(last_line)) = (
        lines.iter().map(|x| x.1).min(),
        lines.iter().map(|x| x.1).max(),
    ) else {
        return Ok(());
    };
    let first_txn = l
        .txns
        .iter()
        .map(|t| YearMonth::of(t.date))
        .min()
        .unwrap_or(first_line);
    let from = first_txn.min(first_line).max(last_line.plus_months(-120));
    let cfg = super::finance::budget_config(store, instance_id);
    let input = BudgetInput {
        config: &cfg,
        categories: &l.categories,
        txns: &l.txns,
        assignments: &l.assignments,
    };
    let months = compute(&input, from, last_line).map_err(super::finance::fin_err)?;
    let mut updates = Vec::new();
    for (row, m, cat) in &lines {
        let Some(c) = months
            .iter()
            .find(|x| x.month == *m)
            .and_then(|x| x.categories.iter().find(|c| &c.category_id == cat))
        else {
            continue;
        };
        if let Some(p) = &act {
            updates.push((row.clone(), p.clone(), money_cell(c.activity, &l.currency)));
        }
        if let Some(p) = &avail {
            updates.push((row.clone(), p.clone(), money_cell(c.available, &l.currency)));
        }
    }
    store.lifeapp_set_computed(b.id(), updates)?;
    Ok(())
}

/// `Next date` of every recurring item with a schedule: its first occurrence from today on.
fn recurring_next(
    store: &Store,
    l: &super::finance::Ledger,
    today: chrono::NaiveDate,
) -> ApiResult<()> {
    use emp_store::life::recurrence::{Rule, next_after};
    let Some(r) = l.dbs.get("recurring") else {
        return Ok(());
    };
    let Some(next_col) = r
        .col_id("rec.next", &[])
        .or_else(|| r.keyed_id("next", &["Next date"]))
    else {
        return Ok(());
    };
    let Some(sched) = r.col_id("rec.schedule", &["Schedule"]) else {
        return Ok(());
    };
    let Some(before) = (today - chrono::Duration::days(1)).and_hms_opt(23, 59, 59) else {
        return Ok(());
    };
    let mut updates = Vec::new();
    for row in &r.rows {
        let Some(CellValue::Recurrence { v: Some(rv) }) = row.values.get(&sched) else {
            continue;
        };
        let Ok(rule) = Rule::parse(&rv.rrule, &rv.dtstart, rv.tz.as_deref()) else {
            continue;
        };
        let Some(next) = next_after(&rule, before, emp_store::dbmodel::RecurrenceMode::Schedule)
        else {
            continue;
        };
        let day = next.date().format("%Y-%m-%d").to_string();
        updates.push((
            row.id.clone(),
            next_col.clone(),
            CellValue::Computed {
                v: ComputedValue {
                    kind: ComputedKind::Date,
                    value: json!(day),
                    display: day,
                },
            },
        ));
    }
    store.lifeapp_set_computed(r.id(), updates)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_restricted() {
        assert!(app_id("id", "money-hq").is_ok());
        assert!(app_id("id", "tax.estimate_v2").is_ok());
        assert!(app_id("id", "Money HQ").is_err());
        assert!(app_id("id", "").is_err());
    }

    #[test]
    fn answers_are_bounded_and_finite() {
        let ok = json!({ "income": 5000, "goals": ["ef", "debt"] });
        assert!(answers("a", ok.as_object().unwrap()).is_ok());
        let big = json!({ "x": "y".repeat(MAX_ANSWERS_BYTES) });
        assert!(answers("a", big.as_object().unwrap()).is_err());
    }

    #[test]
    fn install_request_shape() {
        let r: Result<InstallReq, _> = serde_json::from_value(json!({
            "appId": "money-hq", "answers": {}, "mode": "quick", "disabledKeys": [],
            "workspaceId": "w", "sampleData": true, "onEvent": "__CHANNEL__:3"
        }));
        assert!(r.is_ok());
        let bad: Result<InstallReq, _> = serde_json::from_value(json!({
            "appId": "money-hq", "mode": "quick", "workspaceId": "w", "onEvent": "__CHANNEL__:3", "extra": 1
        }));
        assert!(bad.is_err());
        let under: InstallReq = serde_json::from_value(json!({
            "appId": "habits", "mode": "quick", "workspaceId": "w", "parentId": "p", "onEvent": "__CHANNEL__:3"
        }))
        .unwrap();
        assert_eq!(under.parent_id.as_deref(), Some("p"));
    }

    #[test]
    fn event_and_workbook_request_shapes() {
        let e: EventReq =
            serde_json::from_value(json!({ "event": "ips.signed", "data": { "n": 1 } })).unwrap();
        assert_eq!(e.event, "ips.signed");
        assert!(serde_json::from_value::<EventReq>(json!({ "event": "x", "extra": 1 })).is_err());
        let w: AddWorkbookReq =
            serde_json::from_value(json!({ "instanceId": "i", "intent": "loan" })).unwrap();
        assert_eq!(w.intent, "loan");
        let m: DbChangedMsg =
            serde_json::from_str(r#"{"databaseId":"d","dataRev":3,"schemaRev":1,"rowIds":["r"]}"#)
                .unwrap();
        assert_eq!(m.row_ids, Some(vec!["r".to_owned()]));
    }
}
