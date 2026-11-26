//! App, windows and network commands (SPEC §11.3 "App, windows, network").

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::Empty;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::events::{self, MAIN_WINDOW, OpenExternalConfirm};
use crate::grants::{self, FileGrant, GrantMode, GrantPurpose};
use crate::navigation::{ExternalUrl, classify_external};
use crate::state::{AppState, blocking};
use crate::validate;

// ───────────────────────────────────────────────────────────────────────────── app_info

/// `app_info` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    commit: &'static str,
    platform: &'static str,
    arch: &'static str,
    webview: String,
    features: Vec<&'static str>,
}

/// `macos` | `windows` | `linux`.
#[must_use]
pub const fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Platform capability flags for `app_info.features`.
#[must_use]
pub fn features(keychain: bool) -> Vec<&'static str> {
    let mut f = Vec::new();
    if cfg!(target_os = "linux") {
        // WebKitGTK compositing makes blur effects expensive; Linux always runs with reduced transparency.
        f.push("reduced-transparency");
    }
    if cfg!(windows) {
        // WebView2 (Chromium) implements the EyeDropper API.
        f.push("eyedropper");
    }
    if keychain {
        f.push("keychain");
    }
    f
}

/// `app_info({}) → { version, commit, platform, arch, webview, features }`.
#[tauri::command]
pub async fn app_info(state: State<'_, AppState>, req: Empty) -> ApiResult<AppInfo> {
    let _ = req;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("EMP_COMMIT"),
        platform: platform(),
        arch: std::env::consts::ARCH,
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        features: features(state.device_keys.keychain_available()),
    })
}

/// `app_ready` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppReadyReq {
    marks: std::collections::BTreeMap<String, f64>,
}

/// `app_ready({ marks })`: the frontend painted its first frame; shows the (initially hidden) window.
#[tauri::command]
pub async fn app_ready(
    app: AppHandle,
    state: State<'_, AppState>,
    req: AppReadyReq,
) -> ApiResult<()> {
    validate::list_len("marks", req.marks.len(), 64)?;
    for (k, v) in &req.marks {
        validate::bounded("marks", k, 64)?;
        validate::finite("marks", *v)?;
    }
    tracing::info!(
        uptime_ms = u64::try_from(state.uptime().as_millis()).unwrap_or(u64::MAX),
        marks = req.marks.len(),
        "app ready"
    );
    state.set_ready_marks(serde_json::to_value(&req.marks).unwrap_or_default());
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        w.show()?;
        let _ = w.set_focus();
    }
    Ok(())
}

/// `app_reveal_data_dir({})`: opens the data directory in the file manager.
#[tauri::command]
pub async fn app_reveal_data_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    req: Empty,
) -> ApiResult<()> {
    let _ = req;
    let dir = state.paths.data_dir.clone();
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|_| ApiError::new(ErrorCode::Io, "Could not open the data folder"))
}

/// `app_quit({})`: persists state, locks and exits.
#[tauri::command]
pub async fn app_quit(app: AppHandle, req: Empty) -> ApiResult<()> {
    let _ = req;
    let handle = app.clone();
    blocking(move || {
        let state = handle.state::<AppState>();
        if let Some(store) = state.store_opt() {
            crate::background::snapshot_on_quit(&state);
            state.persist_net_log(&store);
            let _ = store.close();
        }
        Ok(())
    })
    .await?;
    app.exit(0);
    Ok(())
}

/// `app_check_update` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
}

fn updates_enabled(state: &AppState) -> bool {
    let device = match state.store_opt() {
        Some(s) => s.device_settings().ok(),
        None => Some(state.pending_device_settings_resolved()),
    };
    device.is_some_and(|d| d.updates == "check")
}

/// `app_check_update({})`: `OFFLINE` when update checks are off or offline mode is on (D-17). The updater is P1 and
/// not part of this build, so an enabled check reports `UNSUPPORTED`.
#[tauri::command]
pub async fn app_check_update(state: State<'_, AppState>, req: Empty) -> ApiResult<UpdateCheck> {
    let _ = req;
    if state.net.is_offline() {
        return Err(ApiError::new(ErrorCode::Offline, "Offline mode is on"));
    }
    if !updates_enabled(&state) {
        return Err(ApiError::new(ErrorCode::Offline, "Update checks are off"));
    }
    Err(ApiError::unsupported(
        "Automatic updates are not available in this build",
    ))
}

/// `app_install_update` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallUpdateReq {
    #[allow(dead_code)]
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `app_install_update({ onEvent })` (job): the updater is P1 and not part of this build.
#[tauri::command]
pub async fn app_install_update(
    state: State<'_, AppState>,
    req: InstallUpdateReq,
) -> ApiResult<crate::jobs::JobRef> {
    let _ = req;
    if state.net.is_offline() {
        return Err(ApiError::new(ErrorCode::Offline, "Offline mode is on"));
    }
    Err(ApiError::unsupported(
        "Automatic updates are not available in this build",
    ))
}

// ───────────────────────────────────────────────────────────────────────────── external links

/// `open_external` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenExternalReq {
    url: String,
}

fn launch(app: &AppHandle, target: &ExternalUrl) -> ApiResult<()> {
    tracing::info!(host_hash = %crate::logging::hash_for_log(&target.punycode), "opening external link");
    app.opener()
        .open_url(target.url.clone(), None::<&str>)
        .map_err(|_| ApiError::new(ErrorCode::Io, "Could not open the link"))
}

/// Starts the `open_external` flow for an already validated URL: opens remembered https hosts directly, otherwise
/// asks the UI with `open-external:confirm`.
pub fn request_open(app: &AppHandle, state: &AppState, target: ExternalUrl) -> ApiResult<()> {
    if !target.insecure && state.links.is_remembered(&target.punycode) {
        return launch(app, &target);
    }
    let payload = OpenExternalConfirm {
        request_id: String::new(),
        url: target.url.clone(),
        host: target.host.clone(),
        punycode: target.punycode.clone(),
    };
    let request_id = state.links.begin(target)?;
    state.events.emit(
        events::OPEN_EXTERNAL_CONFIRM,
        OpenExternalConfirm {
            request_id,
            ..payload
        },
    );
    Ok(())
}

/// `open_external({ url })`: https | http (warned) | mailto, confirmed by the UI unless the host was remembered.
#[tauri::command]
pub async fn open_external(
    app: AppHandle,
    state: State<'_, AppState>,
    req: OpenExternalReq,
) -> ApiResult<()> {
    let target = classify_external(&req.url)?;
    request_open(&app, &state, target)
}

/// `open_external_confirm` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenExternalConfirmReq {
    request_id: String,
    allow: bool,
    remember_host: bool,
}

/// `open_external_confirm({ requestId, allow, rememberHost })`.
#[tauri::command]
pub async fn open_external_confirm(
    app: AppHandle,
    state: State<'_, AppState>,
    req: OpenExternalConfirmReq,
) -> ApiResult<()> {
    validate::bounded("requestId", &req.request_id, 64)?;
    let remember = req.remember_host && state.store_opt().is_some_and(|s| s.is_unlocked());
    let Some(target) = state
        .links
        .answer(&req.request_id, req.allow, remember && req.allow)?
    else {
        return Ok(());
    };
    if remember && let Some(store) = state.store_opt() {
        let st = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            st.state::<AppState>().persist_remembered_hosts(&store);
        });
    }
    launch(&app, &target)
}

// ───────────────────────────────────────────────────────────────────────────── files

/// A dialog filter.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

fn check_filters(filters: &[DialogFilter]) -> ApiResult<()> {
    validate::list_len("filters", filters.len(), 16)?;
    for f in filters {
        validate::title("filters", &f.name)?;
        validate::bounded("filters", &f.name, 64)?;
        validate::list_len("filters", f.extensions.len(), 32)?;
        for e in &f.extensions {
            let ok = e == "*"
                || (!e.is_empty()
                    && e.len() <= 16
                    && e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
            if !ok {
                return Err(ApiError::invalid("filters", "invalid file extension"));
            }
        }
    }
    Ok(())
}

fn with_filters<R: tauri::Runtime>(
    mut b: tauri_plugin_dialog::FileDialogBuilder<R>,
    filters: &[DialogFilter],
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    for f in filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(f.name.clone(), &exts);
    }
    b
}

/// `file_pick` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilePickReq {
    purpose: PickPurpose,
    filters: Vec<DialogFilter>,
    multiple: bool,
}

/// `file_pick` purposes.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PickPurpose {
    /// Import.
    Import,
    /// Attach.
    Attach,
    /// Restore.
    Restore,
    /// Image.
    Image,
}

impl From<PickPurpose> for GrantPurpose {
    fn from(p: PickPurpose) -> Self {
        match p {
            PickPurpose::Import => GrantPurpose::Import,
            PickPurpose::Attach => GrantPurpose::Attach,
            PickPurpose::Restore => GrantPurpose::Restore,
            PickPurpose::Image => GrantPurpose::Image,
        }
    }
}

/// `file_pick({ purpose, filters, multiple }) → FileGrant[]`: the native open dialog, run from Rust (§9.14).
#[tauri::command]
pub async fn file_pick(app: AppHandle, req: FilePickReq) -> ApiResult<Vec<FileGrant>> {
    check_filters(&req.filters)?;
    let purpose = GrantPurpose::from(req.purpose);
    // Restoring a backup is possible while locked (it opens a new vault); everything else needs a session.
    if !matches!(purpose, GrantPurpose::Restore) {
        app.state::<AppState>().session()?;
    }
    let handle = app.clone();
    blocking(move || {
        let mut b = with_filters(handle.dialog().file(), &req.filters);
        if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
            b = b.set_parent(&w);
        }
        let picked = if req.multiple {
            b.blocking_pick_files().unwrap_or_default()
        } else {
            b.blocking_pick_file().into_iter().collect()
        };
        let state = handle.state::<AppState>();
        let mut out = Vec::with_capacity(picked.len());
        for fp in picked.into_iter().take(validate::MAX_LIST) {
            let Ok(path) = fp.into_path() else { continue };
            let path = grants::canonicalize_for(&path, GrantMode::Read)?;
            if !path.is_file() {
                continue;
            }
            out.push(state.grants.issue(path, purpose, GrantMode::Read)?);
        }
        Ok(out)
    })
    .await
}

/// `file_save_grant` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSaveReq {
    purpose: SavePurpose,
    suggested_name: String,
    filters: Vec<DialogFilter>,
}

/// `file_save_grant` purposes.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavePurpose {
    /// Export.
    Export,
    /// Backup.
    Backup,
}

/// A file-system-safe suggested name (no directories, no control or reserved characters).
#[must_use]
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut out: String = trimmed.chars().take(200).collect();
    if out.is_empty() {
        out = "EMP export".into();
    }
    out
}

/// `file_save_grant({ purpose, suggestedName, filters }) → FileGrant | null`: the native save dialog.
#[tauri::command]
pub async fn file_save_grant(app: AppHandle, req: FileSaveReq) -> ApiResult<Option<FileGrant>> {
    check_filters(&req.filters)?;
    validate::title("suggestedName", &req.suggested_name)?;
    app.state::<AppState>().session()?;
    let purpose = match req.purpose {
        SavePurpose::Export => GrantPurpose::Export,
        SavePurpose::Backup => GrantPurpose::Backup,
    };
    let name = sanitize_file_name(&req.suggested_name);
    let handle = app.clone();
    blocking(move || {
        let mut b = with_filters(handle.dialog().file(), &req.filters).set_file_name(name);
        if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
            b = b.set_parent(&w);
        }
        let Some(fp) = b.blocking_save_file() else {
            return Ok(None);
        };
        let path = fp
            .into_path()
            .map_err(|_| ApiError::invalid("grantId", "unsupported location"))?;
        let path = grants::canonicalize_for(&path, GrantMode::Write)?;
        let state = handle.state::<AppState>();
        Ok(Some(state.grants.issue(path, purpose, GrantMode::Write)?))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── network

/// `network_activity` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkActivityReq {
    limit: u32,
}

/// `network_activity({ limit })`: newest first.
#[tauri::command]
pub async fn network_activity(
    state: State<'_, AppState>,
    req: NetworkActivityReq,
) -> ApiResult<Vec<emp_integrations::NetLogEntry>> {
    let limit = validate::limit("limit", req.limit, validate::MAX_LIST)?;
    state.session()?;
    Ok(state.net.log().recent(limit))
}

/// `network_set_offline` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetOfflineReq {
    offline: bool,
}

/// `network_set_offline` result.
#[derive(Debug, Serialize)]
pub struct OfflineState {
    offline: bool,
}

/// `network_set_offline({ offline })`: refuses every request (updater included) while on; persisted in the vault
/// settings when unlocked.
#[tauri::command]
pub async fn network_set_offline(app: AppHandle, req: SetOfflineReq) -> ApiResult<OfflineState> {
    let state = app.state::<AppState>();
    let offline = state.net.set_offline(req.offline);
    if let Some(store) = state.store_opt().filter(emp_store::Store::is_unlocked) {
        blocking(move || {
            store.settings_set_vault(&serde_json::json!({ "offline": offline }))?;
            Ok(())
        })
        .await?;
    }
    Ok(OfflineState { offline })
}

/// Delay before a restart once a restore finished (lets the job's `done` event reach the UI).
pub const RESTART_DELAY: Duration = Duration::from_millis(800);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitises_suggested_names() {
        assert_eq!(
            sanitize_file_name("Notes/2026: Q1?.md"),
            "Notes-2026- Q1-.md"
        );
        assert_eq!(sanitize_file_name("..."), "EMP export");
        assert_eq!(sanitize_file_name("  "), "EMP export");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "-..-etc-passwd");
        assert!(sanitize_file_name(&"a".repeat(500)).chars().count() <= 200);
    }

    #[test]
    fn validates_dialog_filters() {
        let ok = vec![DialogFilter {
            name: "Markdown".into(),
            extensions: vec!["md".into(), "markdown".into()],
        }];
        assert!(check_filters(&ok).is_ok());
        let bad = vec![DialogFilter {
            name: "x".into(),
            extensions: vec!["../x".into()],
        }];
        assert!(check_filters(&bad).is_err());
        let any = vec![DialogFilter {
            name: "All".into(),
            extensions: vec!["*".into()],
        }];
        assert!(check_filters(&any).is_ok());
    }

    #[test]
    fn platform_flags() {
        assert!(["macos", "windows", "linux"].contains(&platform()));
        assert!(features(true).contains(&"keychain"));
        assert!(!features(false).contains(&"keychain"));
    }

    #[test]
    fn pick_purposes_map_to_grants() {
        assert_eq!(
            GrantPurpose::from(PickPurpose::Restore),
            GrantPurpose::Restore
        );
        let r: FilePickReq = serde_json::from_value(serde_json::json!({
            "purpose": "image", "filters": [], "multiple": false
        }))
        .unwrap();
        assert!(matches!(r.purpose, PickPurpose::Image));
        assert!(
            serde_json::from_value::<FilePickReq>(serde_json::json!({
                "purpose": "image", "filters": [], "multiple": false, "path": "/etc"
            }))
            .is_err()
        );
    }
}
