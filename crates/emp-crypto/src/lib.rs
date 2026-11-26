//! # emp-crypto
//!
//! Vault cryptography for EMP (SPEC §9.1–§9.8, §9.10, §9.11, §9.21). Pure Rust, no I/O beyond the
//! `Read`/`Write` streams you hand it, no logging, no `unsafe`, no panics on attacker-controlled input:
//! every failure is a [`CryptoError`] (map it to IPC with [`CryptoError::code`]).
//!
//! ## Key hierarchy (§9.2)
//!
//! ```text
//! password ──NFKC ≤1024 B──▶ Argon2id(m,t,p, salt16) ──▶ KEK_pw ─┐
//! recovery (24 words → 32 B) ─HKDF(salt=vault_id, "emp/v1/kek/recovery")─▶ KEK_rec ─┼─ wrap ─▶ DEK (epoch 1)
//! device key (OS keychain) ────────────────────────────────────▶ KEK_dev ─┘
//! DEK ──HKDF-SHA256(salt = vault_id, §9.4 labels)──▶ VaultKeys { k_records, k_assets, k_secrets, … }
//! ```
//!
//! ## Using it from `emp-store` / `emp-app`
//!
//! | Task | API |
//! |---|---|
//! | New vault | [`VaultId::generate`], [`Dek::generate`]`(1)`, [`RecoveryKey::generate`] + [`RecoveryKey::words`] |
//! | Keyslots (`keyslots` table) | [`Keyslot::wrap_password`] / [`wrap_recovery`](Keyslot::wrap_recovery) / [`wrap_device`](Keyslot::wrap_device); [`Keyslot::to_columns`] / [`Keyslot::from_columns`] |
//! | Unlock | [`Keyslot::unwrap_password`] (→ `BAD_PASSWORD` on a wrong password), [`Keyslot::unwrap_recovery`], [`Keyslot::unwrap_device`]; then [`VaultKeys::derive`] |
//! | Records (`payload`, enc = 1) | [`VaultKeys::seal_record`] / [`VaultKeys::open_record`] with a [`RecordAad`] (`table`, `id`, `kind`, `rev`, [`Extra`]) |
//! | Integrity manifest | [`VaultKeys::row_hash`], [`MsetRoot`] (`insert`/`replace`/`remove`), [`canonical_keyslots_digest`], [`VaultKeys::state_mac`] / [`verify_state_mac`](VaultKeys::verify_state_mac), [`VaultKeys::header_mac`] over [`mac::canonical_vault_meta`] |
//! | Assets | [`mac::sha256`] → [`VaultKeys::blob_name`] → [`FileKey::generate`] → [`blob::BlobWriter`] → [`VaultKeys::wrap_file_key`]; read with [`blob::open_blob`], [`blob::blob_reader`] or [`blob::blob_range_reader`] (HTTP `Range`) |
//! | Snapshots / backups | [`backup::SnapshotPrefix`], [`VaultKeys::backup_mac`], [`VaultKeys::verify_snapshot_bytes`]; password containers via [`backup::PasswordContainerWriter`] / [`backup::open_password_container`] |
//! | KDF | [`KdfParams`] presets (`FLOOR`, `STANDARD`, `HIGH`), [`KdfParams::validate`], [`kdf::calibrate`] (`vault_benchmark_kdf`), [`KdfParams::is_weaker_than`] ("Strengthen") |
//! | Password policy | [`password::password_strength`] (`password_strength` IPC shape), [`password::check_new_password`], [`password::generate_passphrase`], [`password::unlock_backoff`] |
//! | Recovery ceremony | [`recovery::challenge_positions`], [`RecoveryKey::verify_challenge`], [`recovery::suggest_words`] |
//! | Memory hygiene | [`VaultKeys::memory_regions`] / [`Dek::memory_region`] for best-effort `mlock` in the platform layer |
//!
//! ### Threading
//! Everything is synchronous. Argon2 entry points (`wrap_password`, `unwrap_password`, `calibrate`,
//! password containers) take ~0.5–1.5 s and 64 MiB–1 GiB: call them from `spawn_blocking`.
//! [`VaultKeys`] is `Send + Sync`; share it behind an `Arc` in the unlocked session.
//!
//! ### Key epochs
//! Every envelope header carries the DEK epoch. [`VaultKeys::open_record`] returns
//! [`CryptoError::KeyEpochMismatch`] for other epochs so a future rotation can try the matching key set;
//! [`envelope::EnvelopeHeader::peek`] reads the epoch without decrypting.
//!
//! ### Damaged records
//! `open_record` failing means the item is damaged or was moved (`AuthFailed`), never "plaintext". Quarantine it
//! (SPEC §9.8).
//!
//! ### Tests downstream
//! Real Argon2 parameters are slow. Enable the `insecure-test-kdf` feature **from `[dev-dependencies]` only**
//! to use [`KdfParams`]`::INSECURE_TEST` (8 KiB, t = 1, p = 1) in test suites.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]
#![warn(missing_docs)]

pub mod backup;
pub mod blob;
pub mod codec;
pub mod envelope;
pub mod error;
#[cfg(test)]
mod fuzz_props;
pub mod hkdf_labels;
#[cfg(test)]
mod kat;
pub mod kdf;
pub mod keys;
pub mod keyslot;
pub mod mac;
pub mod pad;
pub mod password;
pub mod recovery;
pub(crate) mod rng;
pub mod stream;

pub use envelope::{Extra, RecordAad, SealOptions, TableTag};
pub use error::{CryptoError, RecoveryKeyError, Result};
pub use kdf::{KdfParams, KdfProfile};
pub use keys::{Dek, DeviceKey, FileKey, MemoryRegion, RecoveryKey, VaultId, VaultKeys};
pub use keyslot::{Keyslot, KeyslotColumns, KeyslotKind, canonical_keyslots_digest};
pub use mac::{BlobName, MsetRoot, RowHash};
pub use secrecy::{ExposeSecret, SecretString};
pub use zeroize::Zeroizing;

#[cfg(test)]
mod send_sync {
    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn key_types_are_send_sync() {
        assert_send_sync::<super::VaultKeys>();
        assert_send_sync::<super::Dek>();
        assert_send_sync::<super::DeviceKey>();
        assert_send_sync::<super::Keyslot>();
    }
}
