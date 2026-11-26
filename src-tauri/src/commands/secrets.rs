//! Secrets commands (SPEC §11.3 "Secrets"). Secrets are always encrypted and write-only over IPC.

use emp_crypto::{ExposeSecret, SecretString};
use emp_integrations::ConnectorId;
use emp_integrations::netguard::HostPolicy;
use emp_store::model::{SecretInfo, SecretKind, SecretSet};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::Empty;
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, blocking};
use crate::validate;

/// The hosts a provider's credential may be attached to (SPEC §9.18 "Credentials"). Unknown providers get none,
/// so their secret can never be sent anywhere by NetGuard.
#[must_use]
pub fn allowed_hosts_for(provider: &str) -> Vec<String> {
    let Ok(id) =
        serde_json::from_value::<ConnectorId>(serde_json::Value::String(provider.to_owned()))
    else {
        return Vec::new();
    };
    match id.host_policy() {
        HostPolicy::Exact(hosts) => hosts.iter().map(|h| (*h).to_owned()).collect(),
        HostPolicy::AnyPublic => Vec::new(),
    }
}

/// `true` for a provider id: lowercase ASCII letters, digits, `-` and `_`, ≤ 64 bytes, not `emp:`-internal.
#[must_use]
pub fn is_provider_id(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 64
        && p.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Providers whose secrets only dedicated commands may write: the Google OAuth client and account token sets
/// (`google_set_client` / `google_connect`, both re-auth gated, SPEC §9.19).
pub const APP_MANAGED_PROVIDERS: &[&str] = &[
    super::google::CLIENT_PROVIDER,
    super::google::ACCOUNT_PROVIDER,
];

/// `true` when `secret_set` may write secrets of `provider`.
#[must_use]
pub fn is_user_settable_provider(provider: &str) -> bool {
    is_provider_id(provider) && !APP_MANAGED_PROVIDERS.contains(&provider)
}

/// Checks that `id` names a secret the UI may overwrite (`secret_set`) or delete (`secret_delete`): a listed (not
/// `emp:`-internal) secret, and for overwrites one of the same provider and not app-managed. Internal secrets (row
/// secret fields, the backup password) and OAuth token sets are reachable only through their own commands.
pub fn check_user_secret(listed: &[SecretInfo], id: &str, provider: Option<&str>) -> ApiResult<()> {
    let info = listed
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| ApiError::not_found("secret"))?;
    if let Some(p) = provider {
        if info.provider != p || APP_MANAGED_PROVIDERS.contains(&info.provider.as_str()) {
            return Err(ApiError::invalid(
                "id",
                "this secret belongs to another provider",
            ));
        }
    }
    Ok(())
}

/// `secret_list({}) → SecretInfo[]` (never values).
#[tauri::command]
pub async fn secret_list(app: AppHandle, req: Empty) -> ApiResult<Vec<SecretInfo>> {
    let _ = req;
    blocking(move || Ok(app.state::<AppState>().session()?.secret_list()?)).await
}

/// `secret_set` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretSetReq {
    #[serde(default)]
    id: Option<String>,
    provider: String,
    label: String,
    kind: SetKind,
    value: SecretString,
    show_last4: bool,
}

/// The kinds the UI may write.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetKind {
    /// An API key.
    ApiKey,
    /// An OAuth client configuration.
    Client,
}

/// `secret_set({ id?, provider, label, kind, value, showLast4 }) → SecretInfo` (write-only).
#[tauri::command]
pub async fn secret_set(app: AppHandle, req: SecretSetReq) -> ApiResult<SecretInfo> {
    if let Some(id) = &req.id {
        validate::id("id", id)?;
    }
    if !is_provider_id(&req.provider) {
        return Err(ApiError::invalid("provider", "invalid provider"));
    }
    if !is_user_settable_provider(&req.provider) {
        return Err(ApiError::invalid(
            "provider",
            "this provider's credentials are set from its own settings",
        ));
    }
    validate::title("label", &req.label)?;
    let v = req.value.expose_secret();
    if v.trim().is_empty() {
        return Err(ApiError::invalid("value", "must not be empty"));
    }
    validate::bounded("value", v, validate::MAX_SECRET_CHARS)?;
    let kind = match req.kind {
        SetKind::ApiKey => SecretKind::ApiKey,
        SetKind::Client => SecretKind::Client,
    };
    let allowed_hosts = allowed_hosts_for(&req.provider);
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        if let Some(id) = &req.id {
            check_user_secret(&store.secret_list()?, id, Some(&req.provider))?;
        }
        Ok(store.secret_set(SecretSet {
            id: req.id,
            provider: req.provider,
            label: req.label,
            kind,
            value: req.value,
            show_last4: req.show_last4,
            allowed_hosts,
        })?)
    })
    .await
}

/// `secret_delete` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretDeleteReq {
    id: String,
}

/// `secret_delete({ id })`.
#[tauri::command]
pub async fn secret_delete(app: AppHandle, req: SecretDeleteReq) -> ApiResult<()> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        check_user_secret(&store.secret_list()?, &req.id, None)?;
        Ok(store.secret_delete(&req.id)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_bind_to_provider_hosts() {
        assert_eq!(allowed_hosts_for("finnhub"), vec!["finnhub.io".to_owned()]);
        assert_eq!(
            allowed_hosts_for("tiingo"),
            vec!["api.tiingo.com".to_owned()]
        );
        assert!(allowed_hosts_for("google").contains(&"oauth2.googleapis.com".to_owned()));
        assert!(allowed_hosts_for("remote-image").is_empty());
        assert!(allowed_hosts_for("unknown").is_empty());
    }

    #[test]
    fn provider_ids() {
        assert!(is_provider_id("finnhub"));
        assert!(is_provider_id("my_provider-2"));
        assert!(!is_provider_id("emp:backup"));
        assert!(!is_provider_id(""));
        assert!(!is_provider_id("Upper"));
    }

    fn info(id: &str, provider: &str) -> SecretInfo {
        SecretInfo {
            id: id.into(),
            provider: provider.into(),
            label: "x".into(),
            kind: SecretKind::ApiKey,
            last4: None,
            created_at: 0,
            last_used_at: None,
        }
    }

    #[test]
    fn app_managed_and_internal_secrets_are_not_writable() {
        assert!(is_user_settable_provider("finnhub"));
        assert!(!is_user_settable_provider("google"));
        assert!(!is_user_settable_provider("google-client"));
        assert!(!is_user_settable_provider("emp:backup-password"));
        // `secret_list` never returns `emp:` secrets, so their ids are unknown here.
        let listed = vec![info("s1", "finnhub"), info("s2", "google")];
        assert!(check_user_secret(&listed, "s1", Some("finnhub")).is_ok());
        assert_eq!(
            check_user_secret(&listed, "internal", Some("finnhub"))
                .unwrap_err()
                .code,
            crate::error::ErrorCode::NotFound
        );
        assert!(check_user_secret(&listed, "internal", None).is_err());
        // Overwrites keep the provider, and never touch OAuth token sets.
        assert!(check_user_secret(&listed, "s1", Some("tiingo")).is_err());
        assert!(check_user_secret(&listed, "s2", Some("google")).is_err());
        // Listed secrets (including a Google account) can be deleted.
        assert!(check_user_secret(&listed, "s2", None).is_ok());
    }

    #[test]
    fn request_rejects_oauth_kind_and_unknown_fields() {
        let ok = serde_json::json!({
            "provider": "finnhub", "label": "Key", "kind": "api_key", "value": "abc", "showLast4": true
        });
        assert!(serde_json::from_value::<SecretSetReq>(ok).is_ok());
        let oauth = serde_json::json!({
            "provider": "google", "label": "x", "kind": "oauth", "value": "abc", "showLast4": false
        });
        assert!(serde_json::from_value::<SecretSetReq>(oauth).is_err());
    }
}
