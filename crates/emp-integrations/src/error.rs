//! Error type shared by every integration, mapped onto the IPC `ErrorCode` set (SPEC §11.2).

use std::time::Duration;

use serde::Serialize;

/// Result alias used throughout the crate.
pub type Result<T, E = IntegrationError> = std::result::Result<T, E>;

/// The subset of IPC error codes (SPEC §11.2) that integrations can produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// Offline mode is on; nothing was sent.
    Offline,
    /// Transport failure, timeout, blocked host or address.
    Network,
    /// The remote provider returned an error or an unparseable payload.
    Provider,
    /// A provider quota was exhausted.
    Quota,
    /// A local or remote rate limit applies; see `retry_after`.
    RateLimited,
    /// The access token is missing or was rejected; refresh and retry.
    AuthRequired,
    /// The grant was revoked or expired; the user must reconnect.
    ReauthRequired,
    /// A size cap was exceeded.
    TooLarge,
    /// The input was invalid.
    Invalid,
    /// The operation was cancelled or timed out waiting for the user.
    Cancelled,
    /// The provider or feature does not support this operation.
    Unsupported,
    /// The remote object does not exist.
    NotFound,
    /// Local I/O failure (e.g. the loopback listener could not bind).
    Io,
    /// A bug or an unexpected state.
    Internal,
}

impl ErrorCode {
    /// The wire string used by the IPC layer, e.g. `"RATE_LIMITED"`.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Offline => "OFFLINE",
            ErrorCode::Network => "NETWORK",
            ErrorCode::Provider => "PROVIDER",
            ErrorCode::Quota => "QUOTA",
            ErrorCode::RateLimited => "RATE_LIMITED",
            ErrorCode::AuthRequired => "AUTH_REQUIRED",
            ErrorCode::ReauthRequired => "REAUTH_REQUIRED",
            ErrorCode::TooLarge => "TOO_LARGE",
            ErrorCode::Invalid => "INVALID",
            ErrorCode::Cancelled => "CANCELLED",
            ErrorCode::Unsupported => "UNSUPPORTED",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::Io => "IO",
            ErrorCode::Internal => "INTERNAL",
        }
    }
}

/// Every failure an integration can report. Messages never contain secrets.
#[derive(Debug, thiserror::Error)]
pub enum IntegrationError {
    /// Offline mode refuses every request.
    #[error("offline mode is on")]
    Offline,
    /// The URL's host is not in the connector's allowlist (SPEC §9.18).
    #[error("host `{host}` is not allowed for connector `{connector}`")]
    HostNotAllowed {
        /// Connector id.
        connector: &'static str,
        /// Offending host.
        host: String,
    },
    /// The destination resolves to a private, loopback or otherwise blocked address.
    #[error("destination `{host}` resolves to a blocked address")]
    BlockedAddress {
        /// Offending host.
        host: String,
    },
    /// Only `https` URLs are allowed (and no user-info or non-default ports).
    #[error("insecure or unsupported URL: {0}")]
    InsecureUrl(String),
    /// More than the allowed number of redirects.
    #[error("too many redirects")]
    TooManyRedirects,
    /// The response body exceeded its cap.
    #[error("response exceeds the {cap}-byte cap")]
    TooLarge {
        /// The cap in bytes.
        cap: u64,
    },
    /// The response content type does not match what was expected.
    #[error("unexpected content type `{got}` (expected {expected})")]
    UnexpectedContentType {
        /// Received `Content-Type`.
        got: String,
        /// Human description of what was expected.
        expected: &'static str,
    },
    /// Transport-level failure.
    #[error("network error: {0}")]
    Network(String),
    /// The request timed out.
    #[error("request timed out")]
    Timeout,
    /// Rate limited (locally by the governor, or remotely via 429).
    #[error("rate limited")]
    RateLimited {
        /// When the caller may retry.
        retry_after: Option<Duration>,
    },
    /// The connector's circuit breaker is open after repeated failures.
    #[error("connector `{connector}` is temporarily disabled after repeated failures")]
    CircuitOpen {
        /// Connector id.
        connector: &'static str,
        /// Remaining open time.
        retry_after: Duration,
    },
    /// Non-success HTTP status not covered by a more specific variant.
    #[error("HTTP {status}: {message}")]
    Http {
        /// HTTP status code.
        status: u16,
        /// Short, secret-free message.
        message: String,
    },
    /// Provider-specific failure (bad payload semantics, "no data", …).
    #[error("provider error: {0}")]
    Provider(String),
    /// Provider quota exhausted.
    #[error("quota exceeded: {0}")]
    Quota(String),
    /// The payload could not be decoded.
    #[error("could not decode response: {0}")]
    Decode(String),
    /// The access token was rejected (HTTP 401); refresh and retry.
    #[error("authorization required")]
    AuthRequired,
    /// The refresh token is no longer valid (`invalid_grant`).
    #[error("re-authorization required")]
    ReauthRequired,
    /// OAuth protocol failure (denied consent, malformed callback, …).
    #[error("OAuth error: {0}")]
    OAuth(String),
    /// The user did not finish authorizing in time.
    #[error("timed out waiting for authorization")]
    AuthTimeout,
    /// Cancelled by the caller.
    #[error("cancelled")]
    Cancelled,
    /// Not supported by this provider.
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// Remote object not found.
    #[error("not found: {0}")]
    NotFound(String),
    /// Invalid caller input.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// Google Calendar sync token expired (HTTP 410); a full resync is needed.
    #[error("sync token expired")]
    SyncTokenExpired,
    /// An import limit (SPEC §9.16) was exceeded.
    #[error("limit exceeded: {0}")]
    LimitExceeded(String),
    /// Local I/O failure.
    #[error("I/O error: {0}")]
    Io(String),
    /// Internal error.
    #[error("internal error: {0}")]
    Internal(String),
}

impl IntegrationError {
    /// The IPC error code for this error.
    pub fn code(&self) -> ErrorCode {
        use IntegrationError as E;
        match self {
            E::Offline => ErrorCode::Offline,
            E::HostNotAllowed { .. }
            | E::BlockedAddress { .. }
            | E::InsecureUrl(_)
            | E::TooManyRedirects
            | E::Network(_)
            | E::Timeout => ErrorCode::Network,
            E::TooLarge { .. } | E::LimitExceeded(_) => ErrorCode::TooLarge,
            E::UnexpectedContentType { .. } | E::Decode(_) | E::Provider(_) | E::Http { .. } => {
                ErrorCode::Provider
            }
            E::CircuitOpen { .. } => ErrorCode::Provider,
            E::RateLimited { .. } => ErrorCode::RateLimited,
            E::Quota(_) => ErrorCode::Quota,
            E::AuthRequired => ErrorCode::AuthRequired,
            E::ReauthRequired => ErrorCode::ReauthRequired,
            E::OAuth(_) => ErrorCode::AuthRequired,
            E::AuthTimeout | E::Cancelled => ErrorCode::Cancelled,
            E::Unsupported(_) => ErrorCode::Unsupported,
            E::NotFound(_) => ErrorCode::NotFound,
            E::Invalid(_) => ErrorCode::Invalid,
            E::SyncTokenExpired => ErrorCode::Provider,
            E::Io(_) => ErrorCode::Io,
            E::Internal(_) => ErrorCode::Internal,
        }
    }

    /// Retry hint in milliseconds, for `ApiError.details.retryAfterMs`.
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            IntegrationError::RateLimited {
                retry_after: Some(d),
            }
            | IntegrationError::CircuitOpen { retry_after: d, .. } => {
                Some(u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
            }
            _ => None,
        }
    }

    /// A copy of this error for fanning one failure out to several callers. Variants that
    /// carry no data are reproduced exactly; others keep their code and message.
    pub fn replicate(&self) -> IntegrationError {
        use IntegrationError as E;
        match self {
            E::Offline => E::Offline,
            E::Timeout => E::Timeout,
            E::TooManyRedirects => E::TooManyRedirects,
            E::AuthRequired => E::AuthRequired,
            E::ReauthRequired => E::ReauthRequired,
            E::AuthTimeout => E::AuthTimeout,
            E::Cancelled => E::Cancelled,
            E::SyncTokenExpired => E::SyncTokenExpired,
            E::RateLimited { retry_after } => E::RateLimited {
                retry_after: *retry_after,
            },
            E::CircuitOpen {
                connector,
                retry_after,
            } => E::CircuitOpen {
                connector,
                retry_after: *retry_after,
            },
            E::TooLarge { cap } => E::TooLarge { cap: *cap },
            E::HostNotAllowed { connector, host } => E::HostNotAllowed {
                connector,
                host: host.clone(),
            },
            E::BlockedAddress { host } => E::BlockedAddress { host: host.clone() },
            E::Http { status, message } => E::Http {
                status: *status,
                message: message.clone(),
            },
            E::UnexpectedContentType { got, expected } => E::UnexpectedContentType {
                got: got.clone(),
                expected,
            },
            E::InsecureUrl(m) => E::InsecureUrl(m.clone()),
            E::Network(m) => E::Network(m.clone()),
            E::Provider(m) => E::Provider(m.clone()),
            E::Quota(m) => E::Quota(m.clone()),
            E::Decode(m) => E::Decode(m.clone()),
            E::OAuth(m) => E::OAuth(m.clone()),
            E::Unsupported(m) => E::Unsupported(m.clone()),
            E::NotFound(m) => E::NotFound(m.clone()),
            E::Invalid(m) => E::Invalid(m.clone()),
            E::LimitExceeded(m) => E::LimitExceeded(m.clone()),
            E::Io(m) => E::Io(m.clone()),
            E::Internal(m) => E::Internal(m.clone()),
        }
    }

    /// Whether this failure should count against a connector's circuit breaker
    /// and is worth retrying.
    pub(crate) fn is_transient(&self) -> bool {
        matches!(
            self,
            IntegrationError::Network(_) | IntegrationError::Timeout
        )
    }
}

/// Truncate a remote message so it stays short in errors and logs.
pub(crate) fn short_message(s: &str) -> String {
    const MAX: usize = 300;
    let trimmed = s.trim();
    if trimmed.chars().count() <= MAX {
        trimmed.to_string()
    } else {
        let mut out: String = trimmed.chars().take(MAX).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_map_to_ipc_strings() {
        assert_eq!(IntegrationError::Offline.code().as_str(), "OFFLINE");
        assert_eq!(
            IntegrationError::ReauthRequired.code().as_str(),
            "REAUTH_REQUIRED"
        );
        assert_eq!(
            IntegrationError::TooLarge { cap: 1 }.code(),
            ErrorCode::TooLarge
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::RateLimited).unwrap(),
            "\"RATE_LIMITED\""
        );
    }

    #[test]
    fn retry_after_is_exposed() {
        let e = IntegrationError::RateLimited {
            retry_after: Some(Duration::from_millis(1500)),
        };
        assert_eq!(e.retry_after_ms(), Some(1500));
        assert_eq!(IntegrationError::Timeout.retry_after_ms(), None);
    }

    #[test]
    fn short_message_truncates() {
        let long = "x".repeat(1000);
        assert_eq!(short_message(&long).chars().count(), 301);
        assert_eq!(short_message("  hi "), "hi");
    }
}
