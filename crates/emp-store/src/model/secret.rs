//! Secrets (SPEC §10.2 `secrets`, §11.3 Secrets). Always encrypted, write-only over IPC.

use serde::{Deserialize, Serialize};

use super::{Id, Ts};

/// Secret kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum SecretKind {
    ApiKey,
    Oauth,
    Client,
    Field,
}

/// Stored payload of a `secrets` row. `data` is the secret value; it never leaves Rust over IPC.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretPayload {
    /// Payload version.
    pub v: u32,
    /// Provider (`finnhub`, `google`, ...).
    pub provider: String,
    /// User label.
    pub label: String,
    /// Kind.
    pub kind: SecretKind,
    /// Hosts this secret may be sent to (NetGuard).
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    /// The secret value (JSON so OAuth token sets fit).
    pub data: serde_json::Value,
    /// Last four characters, if the user opted in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last4: Option<String>,
    /// Last use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<Ts>,
}

impl std::fmt::Debug for SecretPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretPayload")
            .field("provider", &self.provider)
            .field("kind", &self.kind)
            .field("data", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl Drop for SecretPayload {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        if let serde_json::Value::String(s) = &mut self.data {
            s.zeroize();
        }
    }
}

/// `SecretInfo` IPC DTO (never includes the value).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    /// Id.
    pub id: Id,
    /// Provider.
    pub provider: String,
    /// Label.
    pub label: String,
    /// Kind.
    pub kind: SecretKind,
    /// Last four characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last4: Option<String>,
    /// Created.
    pub created_at: Ts,
    /// Last use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<Ts>,
}

/// `secret_set` parameters.
pub struct SecretSet {
    /// Existing id to overwrite.
    pub id: Option<Id>,
    /// Provider.
    pub provider: String,
    /// Label.
    pub label: String,
    /// Kind.
    pub kind: SecretKind,
    /// Value.
    pub value: emp_crypto::SecretString,
    /// Store the last four characters for display.
    pub show_last4: bool,
    /// Hosts this secret may be sent to.
    pub allowed_hosts: Vec<String>,
}
