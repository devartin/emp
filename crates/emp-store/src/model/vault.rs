//! Vault status and security DTOs (SPEC §11.3 Vault and security).

use serde::{Deserialize, Serialize};

use super::{AutoLock, Ts};

/// `VaultStatus.state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked,
}

/// `VaultStatus.integrity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum IntegrityState {
    Ok,
    Warning,
    Unchecked,
}

/// `VaultStatus.kdf`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfInfo {
    /// Memory in KiB.
    #[serde(rename = "mKiB")]
    pub m_kib: u32,
    /// Passes.
    pub t: u32,
    /// Lanes.
    pub p: u32,
    /// Estimated unlock time.
    pub est_ms: u64,
    /// Below the Standard profile ("Strengthen key derivation").
    pub below_standard: bool,
}

/// `VaultStatus`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// State.
    pub state: VaultState,
    /// Encryption on?
    pub encrypted: bool,
    /// Vault id (hex).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    /// Password keyslot parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf: Option<KdfInfo>,
    /// Recovery key confirmed by the 3-word challenge.
    pub recovery_confirmed: bool,
    /// Auto-lock settings.
    pub auto_lock: AutoLock,
    /// Consecutive failed unlocks.
    pub failed_attempts: u32,
    /// Remaining backoff.
    pub retry_after_ms: u64,
    /// `PRAGMA user_version`.
    pub schema_version: i64,
    /// Deferred payload migrations still pending.
    pub pending_migrations: u32,
    /// Filled in by the app (OS keychain availability); the store reports `false`.
    pub keychain_available: bool,
    /// Integrity status of the current session.
    pub integrity: IntegrityState,
    /// Sudo-mode expiry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reauth_valid_until: Option<Ts>,
}

/// A damaged record found by an integrity check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DamagedItem {
    /// Table name.
    pub table: String,
    /// Row id or composite key.
    pub id: String,
}

/// `vault_integrity_check` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    /// Everything verified.
    pub ok: bool,
    /// Records that failed their AEAD check.
    pub damaged: Vec<DamagedItem>,
    /// The multiset root / state MAC did not match.
    pub mset_mismatch: bool,
}

/// Security log event types (the `security_log.event` CHECK list).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum SecurityEvent {
    UnlockOk,
    UnlockFail,
    Lock,
    PwChange,
    RecoveryRegen,
    RecoveryUnlock,
    EncOn,
    EncOff,
    ExportPlain,
    BackupCreate,
    BackupRestore,
    IntegrityFail,
    Reseal,
    SecretReveal,
    IntegrationConnect,
}

impl SecurityEvent {
    /// Column value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnlockOk => "unlock_ok",
            Self::UnlockFail => "unlock_fail",
            Self::Lock => "lock",
            Self::PwChange => "pw_change",
            Self::RecoveryRegen => "recovery_regen",
            Self::RecoveryUnlock => "recovery_unlock",
            Self::EncOn => "enc_on",
            Self::EncOff => "enc_off",
            Self::ExportPlain => "export_plain",
            Self::BackupCreate => "backup_create",
            Self::BackupRestore => "backup_restore",
            Self::IntegrityFail => "integrity_fail",
            Self::Reseal => "reseal",
            Self::SecretReveal => "secret_reveal",
            Self::IntegrationConnect => "integration_connect",
        }
    }
}

/// `security_log` entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityLogEntry {
    /// When.
    pub at: Ts,
    /// Event column value.
    pub event: String,
}

/// KDF profile choice at vault creation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VaultProfile {
    /// Standard (calibrated, 256 MiB default).
    #[default]
    Standard,
    /// High / "Paranoid" (1 GiB, t = 4).
    High,
}
