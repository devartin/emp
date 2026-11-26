//! Error type shared by every engine module.

use thiserror::Error;

/// Errors produced by the finance engine.
///
/// The app maps these onto IPC `ErrorCode` values (SPEC §11.2):
/// `Invalid`/`Parse` → `INVALID`, `TooLarge`/`NeedsConfirmation` → `TOO_LARGE`,
/// `Cancelled` → `CANCELLED`, `Unsupported` → `UNSUPPORTED`, `MissingRate` → `NOT_FOUND`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FinanceError {
    /// An input value is out of range or malformed.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// A file or value could not be parsed.
    #[error("parse error{}: {message}", line.map(|l| format!(" at line {l}")).unwrap_or_default())]
    Parse {
        /// 1-based line (or row) number when known.
        line: Option<usize>,
        /// Human-readable description.
        message: String,
    },
    /// An input exceeds a hard limit (§9.16).
    #[error("too large: {0}")]
    TooLarge(String),
    /// An input exceeds the soft limit and needs explicit user confirmation.
    #[error("needs confirmation: {0}")]
    NeedsConfirmation(String),
    /// The operation was cancelled through its cancellation flag.
    #[error("cancelled")]
    Cancelled,
    /// The input format or feature is not supported.
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// No FX rate is available for the requested conversion.
    #[error("no FX rate for {from}->{to} on or before {date}")]
    MissingRate {
        /// Source currency code.
        from: String,
        /// Target currency code.
        to: String,
        /// Requested date (ISO).
        date: String,
    },
}

impl FinanceError {
    /// Shorthand for [`FinanceError::Invalid`].
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::Invalid(msg.into())
    }

    /// Shorthand for a [`FinanceError::Parse`] without a line number.
    pub fn parse(msg: impl Into<String>) -> Self {
        Self::Parse {
            line: None,
            message: msg.into(),
        }
    }

    /// Shorthand for a [`FinanceError::Parse`] at `line`.
    pub fn parse_at(line: usize, msg: impl Into<String>) -> Self {
        Self::Parse {
            line: Some(line),
            message: msg.into(),
        }
    }
}

/// Result alias used across the crate.
pub type Result<T> = std::result::Result<T, FinanceError>;
