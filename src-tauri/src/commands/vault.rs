//! Vault and security commands (SPEC §11.3 "Vault and security", §9.9–§9.10).

use emp_crypto::password::PolicyViolation;
use emp_crypto::{ExposeSecret, KdfParams, SecretString};
use emp_store::model::{AutoLock, VaultProfile, VaultStatus};
use emp_store::{CreateOptions, Store};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Webview};

use super::{Empty, job_sink};
use crate::autolock::LockReason;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Name of the workspace created with a new vault.
pub const FIRST_WORKSPACE: &str = "Personal";

fn check_password_len(field: &str, pw: &SecretString) -> ApiResult<()> {
    validate::password(field, pw.expose_secret())
}

/// Human message for the first violated password rule.
#[must_use]
pub fn violation_message(v: &PolicyViolation) -> String {
    match v {
        PolicyViolation::TooShort { min } => format!("Use at least {min} characters"),
        PolicyViolation::TooLong { max_bytes } => {
            format!("Passwords are limited to {max_bytes} bytes")
        }
        PolicyViolation::TooWeak { .. } => {
            "This password is too easy to guess. Add more words or characters".into()
        }
        PolicyViolation::Common => "This password is too common".into(),
    }
}

/// Enforces the §9.10 password policy on a new password.
pub fn check_new_password(field: &str, pw: &SecretString) -> ApiResult<()> {
    check_password_len(field, pw)?;
    let report = emp_crypto::password::check_new_password(pw, &[], None);
    match report.violations.first() {
        None => Ok(()),
        Some(v) => Err(ApiError::invalid(field, violation_message(v))),
    }
}

/// Standard-profile parameters for this device: the calibration when available, else the fixed preset.
fn standard_kdf(state: &AppState) -> KdfParams {
    state
        .calibration()
        .map(|c| c.params)
        .filter(|p| p.validate().is_ok())
        .unwrap_or(KdfParams::STANDARD)
}

/// The parameters of the current password keyslot (kept on password changes), or the Standard profile.
fn current_kdf(state: &AppState, store: &Store) -> KdfParams {
    store
        .status()
        .ok()
        .and_then(|s| s.kdf)
        .map(|k| KdfParams {
            m_kib: k.m_kib,
            t: k.t,
            p: k.p,
        })
        .filter(|p| p.validate().is_ok())
        .unwrap_or_else(|| standard_kdf(state))
}

fn with_keychain(state: &AppState, mut s: VaultStatus) -> VaultStatus {
    s.keychain_available = state.device_keys.keychain_available();
    s
}

/// `vault_status({}) → VaultStatus`.
#[tauri::command]
pub async fn vault_status(app: AppHandle, req: Empty) -> ApiResult<VaultStatus> {
    let _ = req;
    blocking(move || app.state::<AppState>().status()).await
}

/// `vault_create` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultCreateReq {
    #[serde(default)]
    password: Option<SecretString>,
    profile: VaultProfile,
    auto_lock: AutoLock,
}

/// `vault_create` result.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCreated {
    status: VaultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_words: Option<Vec<String>>,
}

/// `vault_create({ password?, profile, autoLock })`: password omitted = unencrypted vault.
#[tauri::command]
pub async fn vault_create(app: AppHandle, req: VaultCreateReq) -> ApiResult<VaultCreated> {
    req.auto_lock.validate()?;
    let password = req.password.filter(|p| !p.expose_secret().is_empty());
    if let Some(pw) = &password {
        check_new_password("password", pw)?;
    }
    blocking(move || {
        let state = app.state::<AppState>();
        if state.store_opt().is_some() {
            return Err(ApiError::invalid("password", "EMP is already set up"));
        }
        let _guard = state.begin_unlock()?;
        let kdf = match req.profile {
            VaultProfile::Standard => standard_kdf(&state),
            VaultProfile::High => KdfParams::HIGH,
        };
        let created = Store::create(
            &state.paths.data_dir,
            CreateOptions {
                password,
                kdf,
                auto_lock: req.auto_lock,
                workspace_name: Some(FIRST_WORKSPACE.to_owned()),
            },
            state.store_options(),
        )?;
        let store = created.store;
        state.install_store(store.clone())?;
        state.migrate_pending_device_settings(&store);
        state.after_unlock(&store);
        tracing::info!(
            encrypted = created.recovery_words.is_some(),
            "vault created"
        );
        Ok(VaultCreated {
            status: state.status()?,
            recovery_words: created.recovery_words.map(|w| w.to_vec()),
        })
    })
    .await
}

/// `vault_unlock` / `vault_reauth` / `vault_strengthen_kdf` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordReq {
    password: SecretString,
}

/// `vault_unlock({ password }) → VaultStatus`: `BAD_PASSWORD` | `RATE_LIMITED { retryAfterMs }`.
#[tauri::command]
pub async fn vault_unlock(app: AppHandle, req: PasswordReq) -> ApiResult<VaultStatus> {
    check_password_len("password", &req.password)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.store()?;
        let _guard = state.begin_unlock()?;
        if store.is_unlocked() {
            return state.status();
        }
        let status = if store.is_encrypted()? {
            store.unlock(&req.password)?
        } else {
            store.unlock_device()?
        };
        drop(req);
        state.after_unlock(&store);
        Ok(with_keychain(&state, status))
    })
    .await
}

/// `vault_unlock_recovery` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlockRecoveryReq {
    words: Vec<String>,
    new_password: SecretString,
}

/// `vault_unlock_recovery({ words, newPassword }) → VaultStatus`.
#[tauri::command]
pub async fn vault_unlock_recovery(
    app: AppHandle,
    req: UnlockRecoveryReq,
) -> ApiResult<VaultStatus> {
    let words = zeroize::Zeroizing::new(req.words);
    if words.len() != emp_crypto::recovery::WORD_COUNT {
        return Err(ApiError::invalid("words", "the recovery key has 24 words"));
    }
    for w in words.iter() {
        validate::bounded("words", w, 32)?;
    }
    check_new_password("newPassword", &req.new_password)?;
    let new_password = req.new_password;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.store()?;
        let _guard = state.begin_unlock()?;
        let was_unlocked = store.is_unlocked();
        let kdf = current_kdf(&state, &store);
        let status = store.unlock_recovery(&words, &new_password, kdf)?;
        if !was_unlocked {
            state.after_unlock(&store);
        }
        Ok(with_keychain(&state, status))
    })
    .await
}

/// `vault_lock` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockReq {
    #[serde(default)]
    reason: Option<ManualReason>,
}

/// The only reason the UI may give.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManualReason {
    /// Manual lock.
    Manual,
}

/// `vault_lock({ reason?: 'manual' })`.
#[tauri::command]
pub async fn vault_lock(app: AppHandle, req: LockReq) -> ApiResult<()> {
    let _ = req.reason;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.store()?;
        if !store.is_encrypted()? {
            return Err(ApiError::unsupported("Turn on encryption to lock EMP"));
        }
        state.lock_now(LockReason::Manual, false)
    })
    .await
}

/// `vault_activity_ping({})`: the UI saw input (sent at most every 30 s).
#[tauri::command]
pub async fn vault_activity_ping(state: State<'_, AppState>, req: Empty) -> ApiResult<()> {
    let _ = req;
    if state.store_opt().is_some_and(|s| s.is_unlocked()) {
        state.activity.touch(std::time::Instant::now());
    }
    Ok(())
}

/// `vault_reauth` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reauth {
    valid_until: i64,
}

/// `vault_reauth({ password }) → { validUntil }`: opens the 5-minute re-auth window.
#[tauri::command]
pub async fn vault_reauth(app: AppHandle, req: PasswordReq) -> ApiResult<Reauth> {
    check_password_len("password", &req.password)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let valid_until = store.reauth(&req.password)?;
        Ok(Reauth { valid_until })
    })
    .await
}

/// `vault_set_auto_lock(AutoLock) → VaultStatus`: (reauth) when `idleMinutes` is `null`.
#[tauri::command]
pub async fn vault_set_auto_lock(app: AppHandle, req: AutoLock) -> ApiResult<VaultStatus> {
    req.validate()?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let status = store.set_auto_lock(req.clone())?;
        state.set_auto_lock_cache(req);
        Ok(with_keychain(&state, status))
    })
    .await
}

/// `vault_benchmark_kdf` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfBenchmark {
    #[serde(rename = "mKiB")]
    m_kib: u32,
    t: u32,
    p: u32,
    ms: u64,
}

/// `vault_benchmark_kdf({}) → { mKiB, t, p, ms }`: calibrates the Standard profile on this device (§9.3).
#[tauri::command]
pub async fn vault_benchmark_kdf(app: AppHandle, req: Empty) -> ApiResult<KdfBenchmark> {
    let _ = req;
    blocking(move || {
        let c = emp_crypto::kdf::calibrate(None)?;
        app.state::<AppState>().set_calibration(c);
        Ok(KdfBenchmark {
            m_kib: c.params.m_kib,
            t: c.params.t,
            p: c.params.p,
            ms: c.estimated_ms,
        })
    })
    .await
}

/// `vault_strengthen_kdf({ password }) → VaultStatus`: re-wraps the DEK with the Standard profile for this device.
#[tauri::command]
pub async fn vault_strengthen_kdf(app: AppHandle, req: PasswordReq) -> ApiResult<VaultStatus> {
    check_password_len("password", &req.password)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let target = standard_kdf(&state);
        let current = current_kdf(&state, &store);
        let kdf = if current.is_weaker_than(&target) {
            target
        } else {
            current
        };
        let status = store.strengthen_kdf(&req.password, kdf)?;
        Ok(with_keychain(&state, status))
    })
    .await
}

/// `vault_change_password` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangePasswordReq {
    old_password: SecretString,
    new_password: SecretString,
}

/// `vault_change_password({ oldPassword, newPassword }) → VaultStatus`.
#[tauri::command]
pub async fn vault_change_password(
    app: AppHandle,
    req: ChangePasswordReq,
) -> ApiResult<VaultStatus> {
    check_password_len("oldPassword", &req.old_password)?;
    check_new_password("newPassword", &req.new_password)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let kdf = current_kdf(&state, &store);
        let status = store.change_password(&req.old_password, &req.new_password, kdf)?;
        Ok(with_keychain(&state, status))
    })
    .await
}

/// `vault_enable_encryption` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnableEncryptionReq {
    password: SecretString,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `vault_enable_encryption` job result.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryWordsDto {
    words: Vec<String>,
}

/// `vault_enable_encryption({ password, onEvent })` (job) ⇒ `{ recoveryWords }`.
#[tauri::command]
pub async fn vault_enable_encryption(
    webview: Webview,
    state: State<'_, AppState>,
    req: EnableEncryptionReq,
) -> ApiResult<JobRef> {
    check_new_password("password", &req.password)?;
    let store = state.session()?;
    if store.is_encrypted()? {
        return Err(ApiError::invalid("password", "Encryption is already on"));
    }
    let kdf = standard_kdf(&state);
    let sink = job_sink(&webview, &req.on_event);
    let password = req.password;
    let now = store.now();
    Ok(state
        .jobs
        .spawn("vault_enable_encryption", false, now, sink, move |ctx| {
            let words = store.enable_encryption(&password, kdf, ctx)?;
            Ok(serde_json::json!({ "recoveryWords": words.to_vec() }))
        }))
}

/// `vault_disable_encryption` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisableEncryptionReq {
    password: SecretString,
    confirm: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `vault_disable_encryption({ password, confirm: 'DECRYPT', onEvent })` (reauth)(job) ⇒ `void`.
#[tauri::command]
pub async fn vault_disable_encryption(
    webview: Webview,
    state: State<'_, AppState>,
    req: DisableEncryptionReq,
) -> ApiResult<JobRef> {
    check_password_len("password", &req.password)?;
    if req.confirm != "DECRYPT" {
        return Err(ApiError::invalid("confirm", "type DECRYPT to confirm"));
    }
    let store = state.require_reauth()?;
    if !store.is_encrypted()? {
        return Err(ApiError::invalid("password", "Encryption is already off"));
    }
    let sink = job_sink(&webview, &req.on_event);
    let password = req.password;
    let now = store.now();
    Ok(state
        .jobs
        .spawn("vault_disable_encryption", false, now, sink, move |ctx| {
            store.disable_encryption(&password, ctx)?;
            Ok(())
        }))
}

/// `vault_recovery_view({})` (reauth) → `{ words }`: only while the key is unconfirmed.
#[tauri::command]
pub async fn vault_recovery_view(app: AppHandle, req: Empty) -> ApiResult<RecoveryWordsDto> {
    let _ = req;
    blocking(move || {
        let store = app.state::<AppState>().require_reauth()?;
        let words = store.recovery_view()?;
        Ok(RecoveryWordsDto {
            words: words.to_vec(),
        })
    })
    .await
}

/// `vault_recovery_regenerate({})` (reauth) → `{ words }`.
#[tauri::command]
pub async fn vault_recovery_regenerate(app: AppHandle, req: Empty) -> ApiResult<RecoveryWordsDto> {
    let _ = req;
    blocking(move || {
        let store = app.state::<AppState>().require_reauth()?;
        let words = store.recovery_regenerate()?;
        Ok(RecoveryWordsDto {
            words: words.to_vec(),
        })
    })
    .await
}

/// `vault_recovery_confirm` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryConfirmReq {
    positions: Vec<u32>,
    words: Vec<String>,
}

/// `vault_recovery_confirm` result.
#[derive(Debug, Serialize)]
pub struct Confirmed {
    confirmed: bool,
}

/// `vault_recovery_confirm({ positions, words }) → { confirmed }` (3 words at 0-based positions).
#[tauri::command]
pub async fn vault_recovery_confirm(
    app: AppHandle,
    req: RecoveryConfirmReq,
) -> ApiResult<Confirmed> {
    let n = emp_crypto::recovery::CHALLENGE_WORDS;
    if req.positions.len() != n || req.words.len() != n {
        return Err(ApiError::invalid("words", format!("enter {n} words")));
    }
    if req
        .positions
        .iter()
        .any(|p| *p as usize >= emp_crypto::recovery::WORD_COUNT)
    {
        return Err(ApiError::invalid("positions", "position out of range"));
    }
    for w in &req.words {
        validate::bounded("words", w, 32)?;
    }
    let positions: Vec<usize> = req.positions.iter().map(|p| *p as usize).collect();
    let words = zeroize::Zeroizing::new(req.words);
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let confirmed = store.recovery_confirm(&positions, &words)?;
        if confirmed {
            state.emit_status();
        }
        Ok(Confirmed { confirmed })
    })
    .await
}

/// A request holding only `onEvent`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobOnlyReq {
    /// The job channel.
    pub on_event: tauri::ipc::JavaScriptChannelId,
}

/// `vault_integrity_check({ onEvent })` (job) ⇒ `{ ok, damaged, msetMismatch }`.
#[tauri::command]
pub async fn vault_integrity_check(
    webview: Webview,
    state: State<'_, AppState>,
    req: JobOnlyReq,
) -> ApiResult<JobRef> {
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("vault_integrity_check", true, now, sink, move |ctx| {
            let report = store.integrity_check(ctx)?;
            app.state::<AppState>().emit_status();
            Ok(report)
        }))
}

/// `vault_integrity_reseal({})` (reauth).
#[tauri::command]
pub async fn vault_integrity_reseal(app: AppHandle, req: Empty) -> ApiResult<()> {
    let _ = req;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.require_reauth()?;
        store.integrity_reseal()?;
        state.emit_status();
        Ok(())
    })
    .await
}

/// A `{ limit }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitReq {
    limit: u32,
}

/// `security_log({ limit }) → { at, event }[]`.
#[tauri::command]
pub async fn security_log(
    app: AppHandle,
    req: LimitReq,
) -> ApiResult<Vec<emp_store::model::SecurityLogEntry>> {
    let limit = validate::limit("limit", req.limit, validate::MAX_LIST)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(store.security_log(limit)?)
    })
    .await
}

/// `password_strength({ password }) → { score, crackTime, warning?, suggestions, common }`.
#[tauri::command]
pub async fn password_strength(
    req: PasswordReq,
) -> ApiResult<emp_crypto::password::PasswordStrength> {
    check_password_len("password", &req.password)?;
    blocking(move || {
        emp_crypto::password::password_strength(&req.password, &[], None).map_err(|e| {
            let mut err = ApiError::from(e);
            if err.code == ErrorCode::TooLarge {
                err = err.with_field("password");
            }
            err
        })
    })
    .await
}

/// `password_generate` result.
#[derive(Serialize)]
pub struct Generated {
    passphrase: String,
    bits: f64,
}

/// `password_generate({}) → { passphrase, bits }`: 5 EFF long-list words, random separator.
#[tauri::command]
pub async fn password_generate(req: Empty) -> ApiResult<Generated> {
    let _ = req;
    let g = emp_crypto::password::generate_passphrase()?;
    Ok(Generated {
        passphrase: g.passphrase.to_string(),
        bits: (g.bits * 10.0).round() / 10.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_weak_new_passwords() {
        let weak: SecretString = "password".to_owned().into();
        let e = check_new_password("password", &weak).unwrap_err();
        assert_eq!(e.code, ErrorCode::Invalid);
        assert_eq!(e.details.unwrap().field.as_deref(), Some("password"));
        let strong: SecretString = "plinth-ocelot-marzipan-quaver-87".to_owned().into();
        assert!(check_new_password("password", &strong).is_ok());
        let empty: SecretString = String::new().into();
        assert!(check_password_len("password", &empty).is_err());
    }

    #[test]
    fn violation_messages_are_friendly() {
        assert_eq!(
            violation_message(&PolicyViolation::TooShort { min: 10 }),
            "Use at least 10 characters"
        );
        assert!(violation_message(&PolicyViolation::Common).contains("common"));
    }

    #[test]
    fn create_request_shape() {
        let r: VaultCreateReq = serde_json::from_value(serde_json::json!({
            "profile": "standard",
            "autoLock": { "idleMinutes": 15, "onSleep": true, "onScreenLock": true, "onBlurMinutes": null, "maxSessionHours": null }
        }))
        .unwrap();
        assert!(r.password.is_none());
        assert!(
            serde_json::from_value::<VaultCreateReq>(serde_json::json!({
                "profile": "standard", "autoLock": {}, "extra": 1
            }))
            .is_err()
        );
    }

    #[test]
    fn lock_request_accepts_only_manual() {
        assert!(serde_json::from_value::<LockReq>(serde_json::json!({})).is_ok());
        assert!(
            serde_json::from_value::<LockReq>(serde_json::json!({ "reason": "manual" })).is_ok()
        );
        assert!(
            serde_json::from_value::<LockReq>(serde_json::json!({ "reason": "idle" })).is_err()
        );
    }
}
