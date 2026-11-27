//! Backup and snapshot commands (SPEC §11.3 "Backup, import, export", §9.21). Import and export commands are the
//! domain team's (`commands::import`, `commands::export`).

use emp_crypto::{ExposeSecret, KdfParams, SecretString};
use emp_store::backup::restore::{RestoreCredentials, restore_backup};
use emp_store::backup::snapshot::SnapshotInfo;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Webview};

use super::vault::JobOnlyReq;
use super::{Empty, job_sink};
use crate::error::{ApiError, ApiResult};
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

/// `snapshot_now({ onEvent })` (job) ⇒ `{ id }`. Unencrypted vaults need a backup password set in Security Center.
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

/// `snapshot_set_folder({ grantId | null })`: `null` keeps snapshots in the vault directory. Custom folders need a
/// folder grant and store support for a second snapshot location, neither of which exists yet: `UNSUPPORTED`.
#[tauri::command]
pub async fn snapshot_set_folder(app: AppHandle, req: SnapshotFolderReq) -> ApiResult<()> {
    if let Some(g) = &req.grant_id {
        validate::grant_id("grantId", g)?;
        return Err(ApiError::unsupported(
            "Snapshots can only be kept in the Ultranote data folder in this version",
        ));
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        store.settings_set_vault(
            &serde_json::json!({ "snapshots": { "folderGrantLabel": null } }),
        )?;
        Ok(())
    })
    .await
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
    fn restored_dirs_are_valid_vault_dir_names() {
        let n = restored_dir_name(1_764_000_000_000);
        assert!(crate::state::is_vault_dir_name(&n));
        assert_eq!(n, "restored-1764000000000");
    }
}
