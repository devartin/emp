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
    blocking(move || Ok(app.state::<AppState>().session()?.secret_delete(&req.id)?)).await
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
