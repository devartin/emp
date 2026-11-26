//! Typed errors for every fallible operation in this crate.
//!
//! No operation in `emp-crypto` panics on attacker-controlled input; every failure is a [`CryptoError`].
//! [`CryptoError::code`] maps each variant onto the IPC `ErrorCode` strings of SPEC §11.2.

use std::fmt;

/// Why a recovery phrase was rejected (before any key is derived from it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RecoveryKeyError {
    /// The phrase does not have exactly 24 words.
    WrongWordCount {
        /// Number of words that were supplied.
        got: usize,
    },
    /// The word at this 0-based position is not in the BIP39 English list.
    UnknownWord {
        /// 0-based index of the offending word.
        index: usize,
    },
    /// All words are valid but the BIP39 checksum does not match (a typo or swapped words).
    BadChecksum,
}

impl fmt::Display for RecoveryKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongWordCount { got } => write!(f, "expected 24 words, got {got}"),
            Self::UnknownWord { index } => {
                write!(f, "word {} is not a recovery-key word", index + 1)
            }
            Self::BadChecksum => {
                f.write_str("the words do not form a valid recovery key (checksum mismatch)")
            }
        }
    }
}

/// Every error `emp-crypto` can return.
///
/// Messages never contain key material, plaintext or passwords.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum CryptoError {
    /// A password or recovery key did not open the keyslot / container (AEAD tag mismatch on a KEK-wrapped key).
    #[error("wrong password or recovery key")]
    BadPassword,
    /// An AEAD tag did not verify: the data was modified, moved (AAD mismatch) or the wrong key was used.
    #[error("authentication failed: the data was modified or does not belong here")]
    AuthFailed,
    /// A structure could not be parsed (too short, bad magic, inconsistent lengths, non-canonical encoding, ...).
    #[error("malformed {0}")]
    Malformed(&'static str),
    /// A known structure carried a version this build does not understand.
    #[error("unsupported {what} version {version}")]
    UnsupportedVersion {
        /// Which structure (e.g. "envelope").
        what: &'static str,
        /// The version found.
        version: u16,
    },
    /// Argon2id parameters or salt are out of the §9.3 bounds. The KDF was **not** run.
    #[error("invalid key-derivation parameters: {0}")]
    InvalidKdfParams(&'static str),
    /// The password is longer than 1024 bytes after NFKC normalisation.
    #[error("password is longer than 1024 bytes after normalisation")]
    PasswordTooLong,
    /// A record was sealed under a different key epoch than the key set used to open it.
    #[error("record was sealed under key epoch {found}, this key set is epoch {expected}")]
    KeyEpochMismatch {
        /// Epoch stored in the envelope header.
        found: u16,
        /// Epoch of the key set that was used.
        expected: u16,
    },
    /// A recovery phrase was rejected before any key derivation.
    #[error("invalid recovery key: {0}")]
    InvalidRecoveryKey(RecoveryKeyError),
    /// An input exceeds a hard size limit.
    #[error("input too large: {0}")]
    TooLarge(&'static str),
    /// A chunked stream ended before its final chunk.
    #[error("encrypted stream is truncated")]
    Truncated,
    /// The OS random number generator failed.
    #[error("the operating-system random number generator failed")]
    Rng,
    /// zstd compression or decompression failed (including decompression-bomb limits).
    #[error("compression failed")]
    Compression,
    /// An I/O error while reading or writing a stream.
    #[error("I/O error: {0:?}")]
    Io(std::io::ErrorKind),
    /// A caller passed arguments that violate this API's contract (e.g. wrote more bytes than declared).
    #[error("invalid argument: {0}")]
    InvalidArgument(&'static str),
    /// An internal primitive failed in a way that should be impossible.
    #[error("internal cryptographic error")]
    Internal,
}

impl CryptoError {
    /// The IPC `ErrorCode` (SPEC §11.2) this error maps to.
    ///
    /// A wrong password is `BAD_PASSWORD`, never `CRYPTO` (SPEC §19.1).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadPassword => "BAD_PASSWORD",
            Self::InvalidRecoveryKey(_) | Self::PasswordTooLong | Self::InvalidArgument(_) => {
                "INVALID"
            }
            Self::TooLarge(_) => "TOO_LARGE",
            Self::Io(_) => "IO",
            Self::Rng | Self::Internal => "INTERNAL",
            Self::AuthFailed
            | Self::Malformed(_)
            | Self::UnsupportedVersion { .. }
            | Self::InvalidKdfParams(_)
            | Self::KeyEpochMismatch { .. }
            | Self::Truncated
            | Self::Compression => "CRYPTO",
        }
    }
}

impl From<std::io::Error> for CryptoError {
    fn from(e: std::io::Error) -> Self {
        // A stream decryptor wraps its own CryptoError into io::Error for the `Read` impl; unwrap it again.
        if e.get_ref().is_some_and(|inner| inner.is::<CryptoError>()) {
            if let Some(inner) = e.into_inner() {
                if let Ok(ce) = inner.downcast::<CryptoError>() {
                    return *ce;
                }
            }
            return Self::Internal;
        }
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            return Self::Truncated;
        }
        Self::Io(e.kind())
    }
}

impl From<CryptoError> for std::io::Error {
    fn from(e: CryptoError) -> Self {
        match e {
            CryptoError::Io(kind) => std::io::Error::from(kind),
            other => std::io::Error::other(other),
        }
    }
}

/// Convenience alias.
pub type Result<T, E = CryptoError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        assert_eq!(CryptoError::BadPassword.code(), "BAD_PASSWORD");
        assert_eq!(CryptoError::AuthFailed.code(), "CRYPTO");
        assert_eq!(CryptoError::TooLarge("x").code(), "TOO_LARGE");
        assert_eq!(
            CryptoError::InvalidRecoveryKey(RecoveryKeyError::BadChecksum).code(),
            "INVALID"
        );
    }

    #[test]
    fn io_roundtrip_preserves_crypto_error() {
        let io: std::io::Error = CryptoError::AuthFailed.into();
        assert_eq!(CryptoError::from(io), CryptoError::AuthFailed);
        let eof = std::io::Error::from(std::io::ErrorKind::UnexpectedEof);
        assert_eq!(CryptoError::from(eof), CryptoError::Truncated);
    }
}
