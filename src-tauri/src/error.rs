//! The IPC error type (SPEC §11.2).
//!
//! Every command returns `Result<T, ApiError>`. Tauri serialises the error as the promise rejection value, which the
//! frontend reads as `{ code, message, details? }` (`src/backend/errors.ts`). Messages never contain secrets,
//! decrypted content, titles or file paths.

use serde::Serialize;

/// The `ErrorCode` union of SPEC §11.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[allow(missing_docs)]
pub enum ErrorCode {
    Locked,
    BadPassword,
    RateLimited,
    ReauthRequired,
    NotFound,
    Conflict,
    Invalid,
    Crypto,
    Integrity,
    Io,
    Network,
    Offline,
    AuthRequired,
    Provider,
    Quota,
    Cancelled,
    Unsupported,
    SchemaTooNew,
    TooLarge,
    Internal,
}

impl ErrorCode {
    /// The wire string, e.g. `"RATE_LIMITED"`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Locked => "LOCKED",
            Self::BadPassword => "BAD_PASSWORD",
            Self::RateLimited => "RATE_LIMITED",
            Self::ReauthRequired => "REAUTH_REQUIRED",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::Invalid => "INVALID",
            Self::Crypto => "CRYPTO",
            Self::Integrity => "INTEGRITY",
            Self::Io => "IO",
            Self::Network => "NETWORK",
            Self::Offline => "OFFLINE",
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::Provider => "PROVIDER",
            Self::Quota => "QUOTA",
            Self::Cancelled => "CANCELLED",
            Self::Unsupported => "UNSUPPORTED",
            Self::SchemaTooNew => "SCHEMA_TOO_NEW",
            Self::TooLarge => "TOO_LARGE",
            Self::Internal => "INTERNAL",
        }
    }

    /// Parses a wire string (used to map error codes coming from the workspace crates).
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "LOCKED" => Self::Locked,
            "BAD_PASSWORD" => Self::BadPassword,
            "RATE_LIMITED" => Self::RateLimited,
            "REAUTH_REQUIRED" => Self::ReauthRequired,
            "NOT_FOUND" => Self::NotFound,
            "CONFLICT" => Self::Conflict,
            "INVALID" => Self::Invalid,
            "CRYPTO" => Self::Crypto,
            "INTEGRITY" => Self::Integrity,
            "IO" => Self::Io,
            "NETWORK" => Self::Network,
            "OFFLINE" => Self::Offline,
            "AUTH_REQUIRED" => Self::AuthRequired,
            "PROVIDER" => Self::Provider,
            "QUOTA" => Self::Quota,
            "CANCELLED" => Self::Cancelled,
            "UNSUPPORTED" => Self::Unsupported,
            "SCHEMA_TOO_NEW" => Self::SchemaTooNew,
            "TOO_LARGE" => Self::TooLarge,
            "INTERNAL" => Self::Internal,
            _ => return None,
        })
    }
}

/// `ApiError.details`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetails {
    /// The offending request field (camelCase).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// When to retry (`RATE_LIMITED`, `BAD_PASSWORD` with an active backoff).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// The current revision (`CONFLICT`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_rev: Option<i64>,
    /// Correlates the error with a log line (`INTERNAL`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

impl ErrorDetails {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// The IPC error: serialised as `{ code, message, details? }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct ApiError {
    /// Machine-readable code.
    pub code: ErrorCode,
    /// Human-readable, non-sensitive message.
    pub message: String,
    /// Optional structured details.
    #[serde(skip_serializing_if = "details_empty")]
    pub details: Option<ErrorDetails>,
}

fn details_empty(d: &Option<ErrorDetails>) -> bool {
    d.as_ref().is_none_or(ErrorDetails::is_empty)
}

/// Result alias for commands.
pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    /// An error with a code and message.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    /// `INVALID` naming a request field.
    pub fn invalid(field: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message).with_field(field)
    }

    /// `LOCKED`.
    #[must_use]
    pub fn locked() -> Self {
        Self::new(ErrorCode::Locked, "EMP is locked")
    }

    /// `UNSUPPORTED`.
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }

    /// `NOT_FOUND`.
    pub fn not_found(what: &str) -> Self {
        Self::new(ErrorCode::NotFound, format!("{what} not found"))
    }

    /// `INTERNAL` with a correlation id; the cause is logged (without secrets) under that id.
    pub fn internal(context: &str) -> Self {
        let id = correlation_id();
        tracing::error!(correlation_id = %id, context, "internal error");
        let mut e = Self::new(ErrorCode::Internal, "Something went wrong");
        e.details_mut().correlation_id = Some(id);
        e
    }

    /// Sets `details.field`.
    #[must_use]
    pub fn with_field(mut self, field: &str) -> Self {
        self.details_mut().field = Some(field.to_owned());
        self
    }

    /// Sets `details.retryAfterMs`.
    #[must_use]
    pub fn with_retry_after(mut self, ms: u64) -> Self {
        self.details_mut().retry_after_ms = Some(ms);
        self
    }

    fn details_mut(&mut self) -> &mut ErrorDetails {
        self.details.get_or_insert_with(ErrorDetails::default)
    }
}

fn correlation_id() -> String {
    let mut b = [0u8; 6];
    if getrandom::getrandom(&mut b).is_err() {
        return "000000000000".into();
    }
    hex::encode(b)
}

impl From<emp_store::StoreError> for ApiError {
    fn from(e: emp_store::StoreError) -> Self {
        use emp_store::StoreError as S;
        let code = ErrorCode::parse(e.code()).unwrap_or(ErrorCode::Internal);
        // Low-level errors carry paths or SQL; replace their text with a neutral message and log the kind only.
        let message = match &e {
            S::Io(io) => {
                tracing::warn!(kind = ?io.kind(), "store I/O error");
                "A file operation failed".to_owned()
            }
            S::Sqlite(_) => {
                tracing::warn!("store database error");
                "The database could not complete the operation".to_owned()
            }
            S::Internal(_) => return ApiError::internal("store"),
            other => other.to_string(),
        };
        let mut out = ApiError::new(code, message);
        if let Some(f) = e.field() {
            out = out.with_field(f);
        }
        if let Some(ms) = e.retry_after_ms() {
            out = out.with_retry_after(ms);
        }
        if let Some(rev) = e.current_rev() {
            out.details_mut().current_rev = Some(rev);
        }
        out
    }
}

impl From<emp_integrations::IntegrationError> for ApiError {
    fn from(e: emp_integrations::IntegrationError) -> Self {
        let code = ErrorCode::parse(e.code().as_str()).unwrap_or(ErrorCode::Internal);
        let mut out = ApiError::new(code, e.to_string());
        if let Some(ms) = e.retry_after_ms() {
            out = out.with_retry_after(ms);
        }
        out
    }
}

impl From<emp_crypto::CryptoError> for ApiError {
    fn from(e: emp_crypto::CryptoError) -> Self {
        ApiError::from(emp_store::StoreError::from(e))
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        tracing::warn!(kind = ?e.kind(), "I/O error");
        ApiError::new(ErrorCode::Io, "A file operation failed")
    }
}

impl From<tauri::Error> for ApiError {
    fn from(e: tauri::Error) -> Self {
        tracing::warn!(error = %e, "tauri error");
        ApiError::internal("tauri")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_as_code_message_details() {
        let e = ApiError::invalid("title", "too long");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "code": "INVALID", "message": "too long", "details": { "field": "title" } })
        );
    }

    #[test]
    fn omits_empty_details() {
        let v = serde_json::to_value(ApiError::locked()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "code": "LOCKED", "message": "EMP is locked" })
        );
    }

    #[test]
    fn codes_round_trip() {
        for c in [
            ErrorCode::Locked,
            ErrorCode::BadPassword,
            ErrorCode::RateLimited,
            ErrorCode::ReauthRequired,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Invalid,
            ErrorCode::Crypto,
            ErrorCode::Integrity,
            ErrorCode::Io,
            ErrorCode::Network,
            ErrorCode::Offline,
            ErrorCode::AuthRequired,
            ErrorCode::Provider,
            ErrorCode::Quota,
            ErrorCode::Cancelled,
            ErrorCode::Unsupported,
            ErrorCode::SchemaTooNew,
            ErrorCode::TooLarge,
            ErrorCode::Internal,
        ] {
            assert_eq!(ErrorCode::parse(c.as_str()), Some(c));
            assert_eq!(
                serde_json::to_value(c).unwrap(),
                serde_json::Value::String(c.as_str().into())
            );
        }
    }

    #[test]
    fn maps_store_errors_with_details() {
        let e: ApiError = emp_store::StoreError::Conflict { current_rev: 7 }.into();
        assert_eq!(e.code, ErrorCode::Conflict);
        assert_eq!(e.details.unwrap().current_rev, Some(7));
        let e: ApiError = emp_store::StoreError::RateLimited {
            retry_after_ms: 1000,
        }
        .into();
        assert_eq!(e.code, ErrorCode::RateLimited);
        assert_eq!(e.details.unwrap().retry_after_ms, Some(1000));
        let e: ApiError = emp_store::StoreError::invalid_field("title", "bad").into();
        assert_eq!(e.details.unwrap().field.as_deref(), Some("title"));
    }

    #[test]
    fn io_errors_do_not_leak_paths() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "/home/alice/secret.txt");
        let e: ApiError = emp_store::StoreError::Io(io).into();
        assert_eq!(e.code, ErrorCode::Io);
        assert!(!e.message.contains("alice"));
    }

    #[test]
    fn internal_has_correlation_id() {
        let e = ApiError::internal("test");
        assert_eq!(e.code, ErrorCode::Internal);
        assert_eq!(e.details.unwrap().correlation_id.unwrap().len(), 12);
    }
}
