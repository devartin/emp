//! Typed store errors. Every variant maps onto an IPC `ErrorCode` (SPEC §11.2) through [`StoreError::code`].
//!
//! Messages never contain decrypted content, passwords or keys.

use emp_crypto::CryptoError;

/// Every error the store can return.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StoreError {
    /// The vault is locked; data commands are refused (SPEC §9.9 step 6).
    #[error("the vault is locked")]
    Locked,
    /// Wrong password or recovery key.
    #[error("wrong password or recovery key")]
    BadPassword {
        /// When the next attempt is allowed, if a backoff is now active.
        retry_after_ms: Option<u64>,
    },
    /// Unlock backoff is active (SPEC §9.10).
    #[error("too many failed attempts; try again later")]
    RateLimited {
        /// Milliseconds until the next attempt is allowed.
        retry_after_ms: u64,
    },
    /// The operation needs a fresh `vault_reauth` (SPEC §9.10).
    #[error("re-authentication required")]
    ReauthRequired,
    /// A record does not exist (or is in the trash where that matters).
    #[error("{0} not found")]
    NotFound(&'static str),
    /// Optimistic-concurrency failure: `baseRev` is stale.
    #[error("conflict: the record was changed elsewhere")]
    Conflict {
        /// The current revision.
        current_rev: i64,
    },
    /// The request is invalid.
    #[error("invalid request: {message}")]
    Invalid {
        /// Human-readable reason.
        message: String,
        /// The offending field, if known.
        field: Option<&'static str>,
    },
    /// A cryptographic failure (other than a wrong password).
    #[error("cryptographic failure: {0}")]
    Crypto(CryptoError),
    /// A single record failed its AEAD check and is quarantined (SPEC §9.8).
    #[error("damaged item in {table}: {id}")]
    Damaged {
        /// Table name.
        table: &'static str,
        /// Row id (or composite key).
        id: String,
    },
    /// The integrity manifest or a structural check failed.
    #[error("integrity check failed: {0}")]
    Integrity(String),
    /// Filesystem error.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// SQLite error.
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The database was written by a newer app version.
    #[error(
        "the vault was created by a newer version of Ultranote (schema {found}, this build knows {known})"
    )]
    SchemaTooNew {
        /// `user_version` on disk.
        found: i64,
        /// Newest version this build knows.
        known: i64,
    },
    /// An input exceeds a hard limit.
    #[error("too large: {0}")]
    TooLarge(&'static str),
    /// Not supported in this version or state.
    #[error("unsupported: {0}")]
    Unsupported(&'static str),
    /// A job was cancelled.
    #[error("cancelled")]
    Cancelled,
    /// Something that should not happen.
    #[error("internal error: {0}")]
    Internal(String),
}

impl StoreError {
    /// Convenience constructor for [`StoreError::Invalid`].
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
            field: None,
        }
    }

    /// [`StoreError::Invalid`] naming a field.
    pub fn invalid_field(field: &'static str, message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
            field: Some(field),
        }
    }

    /// The IPC `ErrorCode` string (SPEC §11.2).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Locked => "LOCKED",
            Self::BadPassword { .. } => "BAD_PASSWORD",
            Self::RateLimited { .. } => "RATE_LIMITED",
            Self::ReauthRequired => "REAUTH_REQUIRED",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict { .. } => "CONFLICT",
            Self::Invalid { .. } => "INVALID",
            Self::Crypto(e) => e.code(),
            Self::Damaged { .. } => "CRYPTO",
            Self::Integrity(_) => "INTEGRITY",
            Self::Io(_) => "IO",
            Self::Sqlite(e) => match e.sqlite_error_code() {
                Some(rusqlite::ErrorCode::DiskFull) => "QUOTA",
                Some(rusqlite::ErrorCode::TooBig) => "TOO_LARGE",
                Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
                    "INTEGRITY"
                }
                _ => "IO",
            },
            Self::SchemaTooNew { .. } => "SCHEMA_TOO_NEW",
            Self::TooLarge(_) => "TOO_LARGE",
            Self::Unsupported(_) => "UNSUPPORTED",
            Self::Cancelled => "CANCELLED",
            Self::Internal(_) => "INTERNAL",
        }
    }

    /// `details.retryAfterMs` for the IPC error, if any.
    #[must_use]
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::RateLimited { retry_after_ms } => Some(*retry_after_ms),
            Self::BadPassword { retry_after_ms } => *retry_after_ms,
            _ => None,
        }
    }

    /// `details.currentRev` for the IPC error, if any.
    #[must_use]
    pub fn current_rev(&self) -> Option<i64> {
        match self {
            Self::Conflict { current_rev } => Some(*current_rev),
            _ => None,
        }
    }

    /// `details.field` for the IPC error, if any.
    #[must_use]
    pub fn field(&self) -> Option<&'static str> {
        match self {
            Self::Invalid { field, .. } => *field,
            _ => None,
        }
    }
}

impl From<CryptoError> for StoreError {
    fn from(e: CryptoError) -> Self {
        match e {
            CryptoError::BadPassword => Self::BadPassword {
                retry_after_ms: None,
            },
            CryptoError::TooLarge(what) => Self::TooLarge(what),
            other => Self::Crypto(other),
        }
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::invalid(format!("JSON: {e}"))
    }
}

/// Convenience alias.
pub type Result<T, E = StoreError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_map_to_ipc() {
        assert_eq!(StoreError::Locked.code(), "LOCKED");
        assert_eq!(
            StoreError::from(CryptoError::BadPassword).code(),
            "BAD_PASSWORD"
        );
        assert_eq!(StoreError::from(CryptoError::AuthFailed).code(), "CRYPTO");
        assert_eq!(
            StoreError::Conflict { current_rev: 3 }.current_rev(),
            Some(3)
        );
        assert_eq!(
            StoreError::RateLimited { retry_after_ms: 9 }.retry_after_ms(),
            Some(9)
        );
        assert_eq!(
            StoreError::invalid_field("title", "x").field(),
            Some("title")
        );
    }
}
