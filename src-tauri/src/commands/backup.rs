//! Backup and snapshot commands (SPEC §11.3 "Backup, import, export", §9.21). Import and export commands are the
//! domain team's (`commands::import`, `commands::export`).

use emp_crypto::{ExposeSecret, KdfParams, SecretString};
use emp_store::backup::restore::{RestoreCredentials, restore_backup};
use emp_store::backup::snapshot::SnapshotInfo;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::vault::JobOnlyReq;
use super::{Empty, job_sink};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::events::MAIN_WINDOW;
use crate::grants::{GrantMode, GrantPurpose};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Argon2id parameters of backup password containers (Standard profile, §9.21).
pub const BACKUP_KDF: KdfParams = KdfParams::STANDARD;

/// `backup_create` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupCreateReq {
    grant_id: String,
    #[serde(default)]
    password: Option<SecretString>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `backup_create({ grantId, password?, onEvent })` (job) ⇒ `{ bytes }`: a `.empbackup` at a save grant
/// (`file_save_grant({ purpose: 'backup' })`). Unencrypted vaults require a backup password.
#[tauri::command]
pub async fn backup_create(
    webview: Webview,
    state: State<'_, AppState>,
    req: BackupCreateReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    let password = req.password.filter(|p| !p.expose_secret().is_empty());
    if let Some(p) = &password {
        validate::password("password", p.expose_secret())?;
    }
    let store = state.session()?;
    if password.is_none() && !store.is_encrypted()? {
        return Err(ApiError::invalid(
            "password",
            "Backups of an unencrypted workspace need a backup password",
        ));
    }
    let target = state
        .grants
        .take(&req.grant_id, GrantPurpose::Backup, GrantMode::Write)?;
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    Ok(state
        .jobs
        .spawn("backup_create", true, now, sink, move |ctx| {
            let bytes = store.backup_create(&target.path, password, BACKUP_KDF, ctx)?;
            Ok(serde_json::json!({ "bytes": bytes }))
        }))
}

/// `backup_restore` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupRestoreReq {
    grant_id: String,
    #[serde(default)]
    password: Option<SecretString>,
    #[serde(default)]
    recovery_words: Option<Vec<String>>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `backup_restore` job result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredDto {
    vault_id: String,
    pages: u64,
}

/// Directory name for a restored vault: never the name of an existing vault (restore never overwrites, §9.21).
#[must_use]
pub fn restored_dir_name(now_ms: i64) -> String {
    format!("restored-{now_ms}")
}

/// `backup_restore({ grantId, password?, recoveryWords?, onEvent })` (job) ⇒ `{ vaultId, pages }`.
///
/// Restores into a **new** vault directory, makes it the current vault and restarts the app into it. `password`
/// is tried both as the vault password current when the backup was taken and as the backup password. Works while
/// locked and before onboarding.
#[tauri::command]
pub async fn backup_restore(
    webview: Webview,
    state: State<'_, AppState>,
    req: BackupRestoreReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    let password = req.password.filter(|p| !p.expose_secret().is_empty());
    if let Some(p) = &password {
        validate::password("password", p.expose_secret())?;
    }
    if let Some(w) = &req.recovery_words {
        if w.len() != emp_crypto::recovery::WORD_COUNT {
            return Err(ApiError::invalid(
                "recoveryWords",
                "the recovery key has 24 words",
            ));
        }
        for word in w {
            validate::bounded("recoveryWords", word, 32)?;
        }
    }
    if password.is_none() && req.recovery_words.is_none() {
        return Err(ApiError::invalid(
            "password",
            "Enter the password or recovery key for this backup",
        ));
    }
    let source = state
        .grants
        .take(&req.grant_id, GrantPurpose::Restore, GrantMode::Read)?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    let now = chrono::Utc::now().timestamp_millis();
    let creds = RestoreCredentials {
        backup_password: password
            .as_ref()
            .map(|p| SecretString::from(p.expose_secret().to_owned())),
        password,
        recovery_words: req.recovery_words,
    };
    Ok(state
        .jobs
        .spawn("backup_restore", true, now, sink, move |ctx| {
            let state = app.state::<AppState>();
            let name = restored_dir_name(now);
            let target = state.paths.vaults_dir().join(&name);
            let restored = restore_backup(
                &source.path,
                &target,
                &creds,
                state.device_keys.as_ref(),
                now,
                ctx,
            )?;
            drop(creds);
            state.set_current_vault(&name)?;
            tracing::info!(pages = restored.pages, "backup restored into a new vault");
            // Restart into the restored vault once the result has reached the UI.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(super::app::RESTART_DELAY).await;
                let st = handle.state::<AppState>();
                if let Some(store) = st.store_opt() {
                    st.persist_net_log(&store);
                    let _ = store.close();
                }
                handle.restart();
            });
            Ok(RestoredDto {
                vault_id: restored.vault_id,
                pages: restored.pages,
            })
        }))
}

/// `snapshot_list({}) → { id, at, bytes, schemaVersion, location }[]`.
#[tauri::command]
pub async fn snapshot_list(app: AppHandle, req: Empty) -> ApiResult<Vec<SnapshotInfo>> {
    let _ = req;
    blocking(move || Ok(app.state::<AppState>().session()?.snapshot_list()?)).await
}

/// `snapshot_now({ onEvent })` (job) ⇒ `{ id }`. Unencrypted vaults need a backup password
/// (`snapshot_set_backup_password`); without one this fails with `UNSUPPORTED`.
#[tauri::command]
pub async fn snapshot_now(
    webview: Webview,
    state: State<'_, AppState>,
    req: JobOnlyReq,
) -> ApiResult<JobRef> {
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    Ok(state
        .jobs
        .spawn("snapshot_now", true, now, sink, move |ctx| {
            let id = store.snapshot_now(BACKUP_KDF, ctx)?;
            Ok(serde_json::json!({ "id": id }))
        }))
}

/// `snapshot_set_folder` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotFolderReq {
    grant_id: Option<String>,
}

/// `snapshot_set_folder({ grantId: null })`: snapshots go back to the vault directory. A folder is chosen with
/// `snapshot_choose_folder` (the native folder dialog); file grants cannot name folders, so a non-null grant is
/// refused.
#[tauri::command]
pub async fn snapshot_set_folder(app: AppHandle, req: SnapshotFolderReq) -> ApiResult<()> {
    if let Some(g) = &req.grant_id {
        validate::grant_id("grantId", g)?;
        return Err(ApiError::invalid(
            "grantId",
            "Choose the folder with the folder picker",
        ));
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        store.set_snapshot_folder(None)?;
        store.settings_set_vault(
            &serde_json::json!({ "snapshots": { "folderGrantLabel": null } }),
        )?;
        Ok(())
    })
    .await
}

/// `snapshot_status` result: what the Backups section needs beyond the settings.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus {
    /// The workspace is encrypted (snapshots use the vault key).
    encrypted: bool,
    /// An unencrypted workspace has a backup password, so automatic snapshots can run.
    backup_password_set: bool,
    /// Automatic snapshots will run: enabled, and encrypted or with a backup password.
    automatic: bool,
    /// Where new snapshots are written (absolute path, for display and "Show folder").
    folder_path: String,
    /// New snapshots go to a folder the user chose (`false`: the Ultranote data folder).
    custom_folder: bool,
    /// A chosen folder cannot be reached right now; snapshots fall back to the data folder until it is back.
    folder_unavailable: bool,
}

fn snapshot_status_of(store: &emp_store::Store) -> ApiResult<SnapshotStatus> {
    let encrypted = store.is_encrypted()?;
    let backup_password_set = !encrypted && store.has_backup_password()?;
    let enabled = store.vault_settings()?.snapshots.enabled;
    let chosen = store.snapshot_folder()?;
    let (target, in_folder) = store.snapshot_target()?;
    Ok(SnapshotStatus {
        encrypted,
        backup_password_set,
        automatic: enabled && (encrypted || backup_password_set),
        folder_path: target.to_string_lossy().into_owned(),
        custom_folder: chosen.is_some(),
        folder_unavailable: chosen.is_some() && !in_folder,
    })
}

/// `snapshot_status({}) → SnapshotStatus`.
#[tauri::command]
pub async fn snapshot_status(app: AppHandle, req: Empty) -> ApiResult<SnapshotStatus> {
    let _ = req;
    blocking(move || snapshot_status_of(&app.state::<AppState>().session()?)).await
}

/// `snapshot_set_backup_password` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupPasswordReq {
    password: Option<SecretString>,
}

/// `snapshot_set_backup_password({ password | null }) → SnapshotStatus`: the password that protects automatic
/// snapshots of an **unencrypted** workspace (at least 10 characters). Snapshots are never written unencrypted: they
/// are often kept in synced folders, and the password container also packs attachments inside the file. `null`
/// removes it, which stops automatic snapshots. Encrypted workspaces use the vault key and refuse this.
#[tauri::command]
pub async fn snapshot_set_backup_password(
    app: AppHandle,
    req: BackupPasswordReq,
) -> ApiResult<SnapshotStatus> {
    let password = req.password.filter(|p| !p.expose_secret().is_empty());
    if let Some(p) = &password {
        validate::password("password", p.expose_secret())?;
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        if store.is_encrypted()? {
            return Err(ApiError::invalid(
                "password",
                "Snapshots of an encrypted workspace use its password and recovery key",
            ));
        }
        let turning_on = password.is_some();
        store.set_backup_password(password)?;
        if turning_on {
            store.settings_set_vault(&serde_json::json!({ "snapshots": { "enabled": true } }))?;
        }
        snapshot_status_of(&store)
    })
    .await
}

/// `snapshot_choose_folder({}) → SnapshotStatus | null`: the native folder dialog, run from Rust (the webview never
/// names a path). New snapshots go to `<folder>/Ultranote snapshots <id>/`; `null` when cancelled.
#[tauri::command]
pub async fn snapshot_choose_folder(
    app: AppHandle,
    req: Empty,
) -> ApiResult<Option<SnapshotStatus>> {
    let _ = req;
    app.state::<AppState>().session()?;
    let handle = app.clone();
    blocking(move || {
        let mut b = handle
            .dialog()
            .file()
            .set_title("Choose a folder for automatic backups");
        if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
            b = b.set_parent(&w);
        }
        let Some(picked) = b.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|_| ApiError::invalid("folder", "unsupported location"))?;
        let path = std::fs::canonicalize(&path)?;
        if !path.is_dir() {
            return Err(ApiError::invalid("folder", "choose a folder"));
        }
        let store = handle.state::<AppState>().session()?;
        store.set_snapshot_folder(Some(&path))?;
        let label: String = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned())
            .chars()
            .take(120)
            .collect();
        store.settings_set_vault(
            &serde_json::json!({ "snapshots": { "folderGrantLabel": label } }),
        )?;
        tracing::info!("snapshot folder chosen");
        Ok(Some(snapshot_status_of(&store)?))
    })
    .await
}

/// `snapshot_reveal({})`: opens the folder new snapshots are written to in the file manager.
#[tauri::command]
pub async fn snapshot_reveal(app: AppHandle, req: Empty) -> ApiResult<()> {
    let _ = req;
    let handle = app.clone();
    let dir = blocking(move || {
        let store = handle.state::<AppState>().session()?;
        let (dir, _) = store.snapshot_target()?;
        emp_store::vault::create_private_dir(&dir)?;
        Ok(dir)
    })
    .await?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|_| ApiError::new(ErrorCode::Io, "Could not open the backups folder"))
}

/// `snapshot_verify` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotVerifyReq {
    id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `snapshot_verify({ id, onEvent })` (job) ⇒ `{ ok }`.
#[tauri::command]
pub async fn snapshot_verify(
    webview: Webview,
    state: State<'_, AppState>,
    req: SnapshotVerifyReq,
) -> ApiResult<JobRef> {
    validate::non_empty("id", &req.id, 64)?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    Ok(state
        .jobs
        .spawn("snapshot_verify", true, now, sink, move |ctx| {
            let ok = store.snapshot_verify(&req.id, ctx)?;
            Ok(serde_json::json!({ "ok": ok }))
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_password_request_shape() {
        let r: BackupPasswordReq =
            serde_json::from_value(serde_json::json!({ "password": "a long password" })).unwrap();
        assert!(r.password.is_some());
        let none: BackupPasswordReq =
            serde_json::from_value(serde_json::json!({ "password": null })).unwrap();
        assert!(none.password.is_none());
        assert!(
            serde_json::from_value::<BackupPasswordReq>(serde_json::json!({ "pw": "x" })).is_err()
        );
    }

    #[test]
    fn restored_dirs_are_valid_vault_dir_names() {
        let n = restored_dir_name(1_764_000_000_000);
        assert!(crate::state::is_vault_dir_name(&n));
        assert_eq!(n, "restored-1764000000000");
    }
}
