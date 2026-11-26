//! Snapshots, backups and exports (SPEC §9.21, D-22, §17.5).
//!
//! * [`snapshot`]: `.empsnap` automatic snapshots (blobs in a sibling `.blobs/` directory) and `.empbackup` manual
//!   backups (blobs packed into the single file), with D-22 retention.
//! * [`restore`]: verification and restore into a **new** vault directory (never in place).
//! * [`export`]: Markdown / HTML / JSON page export.
//!
//! ## Container format
//! ```text
//! inner = "EMPSNAP\0" || u16be(1) || u32be(manifest_len) || manifest(CBOR) || sqlite_bytes
//!         || [packed only: for each manifest blob: u64be(len) || stored blob bytes]
//!         || mac[32]                                   mac = HMAC(k_backup_mac, everything before it)
//! ```
//! The manifest is [`SnapManifest`] (byte fields are lowercase hex strings). `sqlite_bytes` is a `VACUUM INTO`
//! copy. Blobs are copied as stored (already encrypted in encrypted vaults).
//!
//! In a plaintext vault the whole `inner` file is wrapped in an Argon2id password container
//! (`emp_crypto::backup::PasswordContainerWriter`) under the backup password, and the manifest carries the device
//! key so the backup can be restored on another machine. Encrypted vaults may add the same wrapper with an optional
//! separate backup password.

pub mod export;
pub mod restore;
pub mod snapshot;

use serde::{Deserialize, Serialize};

/// The CBOR manifest of a snapshot or backup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapManifest {
    /// Vault id (hex).
    pub vault_id: String,
    /// Creation time (unix ms).
    pub created_at: i64,
    /// App version.
    pub app_version: String,
    /// `PRAGMA user_version` of the copy.
    pub schema_version: i64,
    /// `vault_state.write_counter` of the copy.
    pub write_counter: u64,
    /// `vault_state.mset_root` of the copy (hex).
    pub mset_root: String,
    /// `(blob_name, stored_size, sha256 of the stored bytes as hex)`.
    pub blobs: Vec<(String, u64, String)>,
    /// Length of `sqlite_bytes`.
    pub sqlite_len: u64,
    /// Blobs are packed into the file (`.empbackup`) rather than stored beside it (`.empsnap`).
    pub packed: bool,
    /// Whether the vault was encrypted.
    pub encrypted: bool,
    /// Plaintext vaults only: the device key (hex), protected by the backup-password container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_key: Option<String>,
}

/// Internal secrets provider holding the backup password used for automatic snapshots of plaintext vaults.
pub const BACKUP_PASSWORD_PROVIDER: &str = "emp:backup-password";
