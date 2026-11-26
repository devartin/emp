//! Life-app commands (SPEC §6.5, §11.3 "Life apps", §16).
//!
//! Validated wrappers over `emp-store`'s life-app framework (`repo::lifeapps`): catalog, manifests, wizard
//! recommendations, plan previews, install / tune-up jobs, metrics and the advisor. Newly seen insights are announced
//! with `insight:new` (§11.4).

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use emp_store::lifeapps::recommend::Recommendation;
use emp_store::{
    GenerationPlan, Insight, InstallResult, LifeAppInstance, LifeAppManifest, LifeAppSummary, LifeappInstall,
    LifeappPreview, MetricValue, PlanDiff, SampleResult, TuneupResult,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State, Webview};

use super::import::cancelled_or;
use super::job_sink;
use crate::error::{ApiError, ApiResult};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Serialised size limit of wizard answers.
pub const MAX_ANSWERS_BYTES: usize = 256 * 1024;
/// Insights remembered as already announced.
pub const SEEN_INSIGHTS_MAX: usize = 10_000;

/// Validates a life-app or step id (`[a-z0-9_.-]`, ≤ 64).
pub fn app_id(field: &str, s: &str) -> ApiResult<()> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.'));
    if ok { Ok(()) } else { Err(ApiError::invalid(field, "invalid id")) }
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
    v.iter().try_for_each(|k| validate::non_empty(field, k, 256))
}

/// `lifeapp_list({}) → LifeAppSummary[]`.
#[tauri::command]
pub async fn lifeapp_list(app: AppHandle, req: super::Empty) -> ApiResult<Vec<LifeAppSummary>> {
    let _ = req;
    blocking(move || Ok(app.state::<AppState>().session()?.lifeapp_list(None)?)).await
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
    blocking(move || Ok(app.state::<AppState>().session()?.lifeapp_manifest(&req.id)?)).await
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
        Ok(app
            .state::<AppState>()
            .session()?
            .lifeapp_recommend(&req.app_id, &req.step_id, &req.answers)?)
    })
    .await
}

/// `lifeapp_preview({ appId, answers, mode, disabledKeys }) → GenerationPlan` (pure).
#[tauri::command]
pub async fn lifeapp_preview(app: AppHandle, req: LifeappPreview) -> ApiResult<GenerationPlan> {
    app_id("appId", &req.app_id)?;
    answers("answers", &req.answers)?;
    keys("disabledKeys", &req.disabled_keys)?;
    blocking(move || Ok(app.state::<AppState>().session()?.lifeapp_preview(&req)?)).await
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
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `lifeapp_install({ appId, answers, mode, disabledKeys, workspaceId, sampleData, onEvent })` (job)
/// ⇒ `{ instanceId, rootPageId, created }` (one transaction).
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
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let install = LifeappInstall {
        app_id: req.app_id,
        answers: req.answers,
        mode: req.mode,
        disabled_keys: req.disabled_keys,
        workspace_id: req.workspace_id,
        sample_data: req.sample_data,
    };
    Ok(state
        .jobs
        .spawn("lifeapp_install", true, store.now(), sink, move |ctx| -> ApiResult<InstallResult> {
            store
                .lifeapp_install(&install, ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))
        }))
}

/// A `{ workspaceId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReq {
    workspace_id: String,
}

/// `lifeapp_instances({ workspaceId }) → LifeAppInstance[]`.
#[tauri::command]
pub async fn lifeapp_instances(app: AppHandle, req: WorkspaceReq) -> ApiResult<Vec<LifeAppInstance>> {
    validate::id("workspaceId", &req.workspace_id)?;
    blocking(move || Ok(app.state::<AppState>().session()?.lifeapp_instances(&req.workspace_id)?)).await
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
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .lifeapp_tuneup_preview(&req.instance_id, &req.answers)?)
    })
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
    let sink = job_sink(&webview, &req.on_event);
    Ok(state
        .jobs
        .spawn("lifeapp_tuneup_apply", true, store.now(), sink, move |ctx| -> ApiResult<TuneupResult> {
            store
                .lifeapp_tuneup_apply(&req.instance_id, &req.answers, &req.accept_conflicts, ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))
        }))
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
    blocking(move || Ok(app.state::<AppState>().session()?.lifeapp_detach(&req.instance_id)?)).await
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
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .lifeapp_uninstall(&req.instance_id, req.keep_content)?)
    })
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
pub async fn lifeapp_metrics(app: AppHandle, req: MetricsReq) -> ApiResult<BTreeMap<String, MetricValue>> {
    validate::id("instanceId", &req.instance_id)?;
    validate::list_len("names", req.names.len(), 200)?;
    for n in &req.names {
        app_id("names", n)?;
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
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
        .filter(|i| i.muted_until.is_none() && seen.insert(format!("{}|{}", i.app_instance_id, i.id)))
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
        Ok(app
            .state::<AppState>()
            .session()?
            .lifeapp_insight_mute(&req.instance_id, &req.rule_id, req.until)?)
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
    blocking(move || Ok(app.state::<AppState>().session()?.lifeapp_sample_data(&req.instance_id, req.on)?)).await
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
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .lifeapp_checklist_tick(&req.instance_id, &req.item_id)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    }
}
