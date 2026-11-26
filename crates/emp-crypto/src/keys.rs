//! Key types (SPEC §9.2, §9.11).
//!
//! Every secret key is a 32-byte array boxed **once** at creation and never moved afterwards, so its address is
//! stable (it can be `mlock`ed by the platform layer, see [`MemoryRegion`]). Key types:
//! - do not implement `Clone`, `Copy`, `Serialize` or a revealing `Debug` (their `Debug` prints `[REDACTED]`);
//! - zeroize their bytes on drop ([`zeroize::ZeroizeOnDrop`]).
//!
//! Only [`DeviceKey`] can be exported (it has to be written to the OS keychain). The DEK and all subkeys never
//! leave this crate; callers use them through methods on [`VaultKeys`] and [`crate::keyslot::Keyslot`].

use std::fmt;

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::codec::{hex_decode_array, hex_encode};
use crate::error::{CryptoError, Result};
use crate::hkdf_labels as labels;
use crate::rng;

/// Length of every symmetric key in EMP.
pub const KEY_LEN: usize = 32;
/// Length of a vault id.
pub const VAULT_ID_LEN: usize = 16;

/// Address range of a secret key, for best-effort `mlock`/`VirtualLock` by the platform layer (SPEC §9.11).
///
/// The address is stable for the lifetime of the owning key object because keys are boxed once and never moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryRegion {
    /// Start address.
    pub addr: usize,
    /// Length in bytes.
    pub len: usize,
}

macro_rules! secret_key {
    ($(#[$meta:meta])* $vis:vis $name:ident) => {
        $(#[$meta])*
        $vis struct $name {
            bytes: Box<[u8; KEY_LEN]>,
        }

        #[allow(dead_code)]
        impl $name {
            /// Allocates a zeroed boxed key, lets `fill` write it in place, and wraps it.
            pub(crate) fn fill_with(fill: impl FnOnce(&mut [u8; KEY_LEN]) -> Result<()>) -> Result<Self> {
                let mut key = Self { bytes: Box::new([0u8; KEY_LEN]) };
                fill(&mut key.bytes)?;
                Ok(key)
            }

            /// A fresh random key from the OS CSPRNG.
            pub(crate) fn random() -> Result<Self> {
                Self::fill_with(|b| rng::fill(b))
            }

            /// Copies `src` into a new boxed key. The caller remains responsible for zeroizing `src`.
            pub(crate) fn copy_from(src: &[u8]) -> Result<Self> {
                if src.len() != KEY_LEN {
                    return Err(CryptoError::Malformed("key length"));
                }
                Self::fill_with(|b| {
                    b.copy_from_slice(src);
                    Ok(())
                })
            }

            pub(crate) fn expose(&self) -> &[u8; KEY_LEN] {
                &self.bytes
            }

            /// Address range of the key bytes (for `mlock`).
            #[must_use]
            pub fn memory_region(&self) -> MemoryRegion {
                MemoryRegion { addr: self.bytes.as_ptr() as usize, len: KEY_LEN }
            }
        }

        impl Zeroize for $name {
            fn zeroize(&mut self) {
                self.bytes.zeroize();
            }
        }

        impl Drop for $name {
            fn drop(&mut self) {
                self.bytes.zeroize();
            }
        }

        impl ZeroizeOnDrop for $name {}

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([REDACTED])"))
            }
        }
    };
}

secret_key!(
    /// A key-encryption key (Argon2id, HKDF or device derived). Never leaves this crate.
    pub(crate) Kek
);
secret_key!(
    /// The per-blob random file key `FK` (SPEC §9.7). Only used through [`VaultKeys`] and the blob functions.
    pub FileKey
);
secret_key!(
    /// The 32-byte device key kept in the OS keychain (service `com.devartin.emp`,
    /// account `device-key/<vault_id hex>`) or in `<data>/device.key` (0600). Used directly as `KEK_dev`.
    pub DeviceKey
);
secret_key!(
    /// A 32-byte HKDF subkey of the DEK (SPEC §9.4). Only reachable through [`VaultKeys`].
    pub(crate) SubKey
);
secret_key!(
    /// A 256-bit recovery key: the entropy behind the 24 BIP39 English words (SPEC §9.2, D-06).
    /// `KEK_rec = HKDF-SHA256(ikm = RK, salt = vault_id, info = "emp/v1/kek/recovery")`.
    /// See the [`crate::recovery`] module for word conversion and verification.
    pub RecoveryKey
);

impl FileKey {
    /// Generates a new random file key for one blob.
    pub fn generate() -> Result<Self> {
        Self::random()
    }
}

impl DeviceKey {
    /// Generates a new random device key.
    pub fn generate() -> Result<Self> {
        Self::random()
    }

    /// Re-creates a device key read from the keychain or `device.key`. Zeroize `bytes` afterwards.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Self::copy_from(bytes)
    }

    /// The raw bytes, so the app can store them in the OS keychain. Do not log or persist them anywhere else.
    #[must_use]
    pub fn expose_secret(&self) -> &[u8; KEY_LEN] {
        self.expose()
    }
}

/// The vault's random 256-bit data-encryption key plus its key epoch (SPEC §9.2).
///
/// Never written to disk unwrapped and never sent over IPC. Wrap it with [`crate::keyslot::Keyslot`].
pub struct Dek {
    key: SubKey,
    epoch: u16,
}

impl Dek {
    /// Generates a new random DEK for `epoch` (the first DEK of a vault is epoch 1).
    pub fn generate(epoch: u16) -> Result<Self> {
        Ok(Self {
            key: SubKey::random()?,
            epoch,
        })
    }

    pub(crate) fn from_parts(key: SubKey, epoch: u16) -> Self {
        Self { key, epoch }
    }

    pub(crate) fn expose(&self) -> &[u8; KEY_LEN] {
        self.key.expose()
    }

    /// Key epoch (stored in every envelope header and keyslot AAD).
    #[must_use]
    pub fn epoch(&self) -> u16 {
        self.epoch
    }

    /// Address range of the DEK bytes (for `mlock`).
    #[must_use]
    pub fn memory_region(&self) -> MemoryRegion {
        self.key.memory_region()
    }
}

impl fmt::Debug for Dek {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Dek([REDACTED], epoch {})", self.epoch)
    }
}

impl ZeroizeOnDrop for Dek {}

/// A vault's public 16-byte random id (visible on disk, SPEC §9.20). Used as HKDF salt and bound into every AAD.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VaultId([u8; VAULT_ID_LEN]);

impl VaultId {
    /// Generates a new random vault id.
    pub fn generate() -> Result<Self> {
        Ok(Self(rng::array()?))
    }

    /// Wraps raw bytes.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; VAULT_ID_LEN]) -> Self {
        Self(bytes)
    }

    /// Parses the 16-byte `vault_meta.vault_id` blob.
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        bytes
            .try_into()
            .map(Self)
            .map_err(|_| CryptoError::Malformed("vault id"))
    }

    /// Parses 32 lowercase hex characters.
    pub fn from_hex(s: &str) -> Result<Self> {
        hex_decode_array(s)
            .map(Self)
            .ok_or(CryptoError::Malformed("vault id"))
    }

    /// Raw bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; VAULT_ID_LEN] {
        &self.0
    }

    /// 32 lowercase hex characters (keychain account `device-key/<hex>`, `vaults/<hex>/` directory).
    #[must_use]
    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

impl fmt::Debug for VaultId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VaultId({})", self.to_hex())
    }
}

impl fmt::Display for VaultId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// HKDF-SHA256(ikm, salt, info) → 32 bytes, written straight into a boxed key.
pub(crate) fn hkdf_into(
    ikm: &[u8],
    salt: &[u8],
    info: &str,
    out: &mut [u8; KEY_LEN],
) -> Result<()> {
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info.as_bytes(), out)
        .map_err(|_| CryptoError::Internal)
}

fn subkey(dek: &Dek, vault_id: &VaultId, info: &str) -> Result<SubKey> {
    SubKey::fill_with(|b| hkdf_into(dek.expose(), vault_id.as_bytes(), info, b))
}

/// The unlocked key set of a vault: every §9.4 subkey of one DEK epoch.
///
/// This is what an unlocked `Session` holds. Dropping it zeroizes every subkey. All record, blob, manifest and
/// MAC operations are methods on this type (see the `envelope`, `blob`, `mac` and `backup` modules).
pub struct VaultKeys {
    pub(crate) vault_id: VaultId,
    pub(crate) epoch: u16,
    pub(crate) records: SubKey,
    pub(crate) assets: SubKey,
    pub(crate) secrets: SubKey,
    pub(crate) manifest: SubKey,
    pub(crate) blob_id: SubKey,
    pub(crate) backup_mac: SubKey,
    pub(crate) header_mac: SubKey,
    pub(crate) search: SubKey,
    pub(crate) blind: SubKey,
}

impl VaultKeys {
    /// Derives every subkey from `dek` with `salt = vault_id` (SPEC §9.4).
    pub fn derive(dek: &Dek, vault_id: &VaultId) -> Result<Self> {
        Ok(Self {
            vault_id: *vault_id,
            epoch: dek.epoch(),
            records: subkey(dek, vault_id, labels::RECORDS)?,
            assets: subkey(dek, vault_id, labels::ASSETS)?,
            secrets: subkey(dek, vault_id, labels::SECRETS)?,
            manifest: subkey(dek, vault_id, labels::MANIFEST)?,
            blob_id: subkey(dek, vault_id, labels::BLOB_ID)?,
            backup_mac: subkey(dek, vault_id, labels::BACKUP_MAC)?,
            header_mac: subkey(dek, vault_id, labels::HEADER_MAC)?,
            search: subkey(dek, vault_id, labels::SEARCH)?,
            blind: subkey(dek, vault_id, labels::BLIND_INDEX)?,
        })
    }

    /// The vault id these keys are bound to.
    #[must_use]
    pub fn vault_id(&self) -> &VaultId {
        &self.vault_id
    }

    /// The DEK epoch these keys were derived from.
    #[must_use]
    pub fn epoch(&self) -> u16 {
        self.epoch
    }

    /// Address ranges of every subkey, for best-effort `mlock` by the platform layer.
    #[must_use]
    pub fn memory_regions(&self) -> Vec<MemoryRegion> {
        [
            &self.records,
            &self.assets,
            &self.secrets,
            &self.manifest,
            &self.blob_id,
            &self.backup_mac,
            &self.header_mac,
            &self.search,
            &self.blind,
        ]
        .iter()
        .map(|k| k.memory_region())
        .collect()
    }

    #[cfg(test)]
    pub(crate) fn subkey_bytes(&self, label: &str) -> Option<[u8; KEY_LEN]> {
        let k = match label {
            labels::RECORDS => &self.records,
            labels::ASSETS => &self.assets,
            labels::SECRETS => &self.secrets,
            labels::MANIFEST => &self.manifest,
            labels::BLOB_ID => &self.blob_id,
            labels::BACKUP_MAC => &self.backup_mac,
            labels::HEADER_MAC => &self.header_mac,
            labels::SEARCH => &self.search,
            labels::BLIND_INDEX => &self.blind,
            _ => return None,
        };
        Some(*k.expose())
    }
}

impl fmt::Debug for VaultKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "VaultKeys([REDACTED], vault {}, epoch {})",
            self.vault_id, self.epoch
        )
    }
}

impl ZeroizeOnDrop for VaultKeys {}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// A DEK with fixed bytes, for deterministic vectors.
    pub(crate) fn fixed_dek(byte: u8, epoch: u16) -> Dek {
        Dek::from_parts(SubKey::copy_from(&[byte; KEY_LEN]).unwrap(), epoch)
    }

    pub(crate) fn fixed_keys(byte: u8) -> VaultKeys {
        VaultKeys::derive(&fixed_dek(byte, 1), &VaultId::from_bytes([0x11; 16])).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let k = FileKey::generate().unwrap();
        assert_eq!(format!("{k:?}"), "FileKey([REDACTED])");
        let d = Dek::generate(1).unwrap();
        assert!(format!("{d:?}").contains("[REDACTED]"));
        let vk = fixed_keys(1);
        let s = format!("{vk:?}");
        assert!(s.contains("[REDACTED]") && !s.contains(&hex_encode(vk.records.expose())));
    }

    #[test]
    fn subkeys_distinct_and_deterministic() {
        let a = fixed_keys(7);
        let b = fixed_keys(7);
        let mut seen = Vec::new();
        for l in labels::ALL_SUBKEYS {
            let ka = a.subkey_bytes(l).unwrap();
            assert_eq!(Some(ka), b.subkey_bytes(l));
            assert!(!seen.contains(&ka));
            seen.push(ka);
        }
        // Different vault id ⇒ different subkeys.
        let c = VaultKeys::derive(&fixed_dek(7, 1), &VaultId::from_bytes([0x22; 16])).unwrap();
        assert_ne!(
            a.subkey_bytes(labels::RECORDS),
            c.subkey_bytes(labels::RECORDS)
        );
    }

    #[test]
    fn records_subkey_matches_manual_hkdf() {
        let vk = fixed_keys(3);
        let hk = Hkdf::<Sha256>::new(Some(&[0x11; 16]), &[3u8; 32]);
        let mut out = [0u8; 32];
        hk.expand(b"emp/v1/records", &mut out).unwrap();
        assert_eq!(vk.subkey_bytes(labels::RECORDS), Some(out));
    }

    #[test]
    fn vault_id_hex() {
        let id = VaultId::from_bytes([0xab; 16]);
        assert_eq!(id.to_hex(), "ab".repeat(16));
        assert_eq!(VaultId::from_hex(&id.to_hex()).unwrap(), id);
        assert!(VaultId::from_hex("ab").is_err());
        assert!(VaultId::from_slice(&[0; 15]).is_err());
    }

    #[test]
    fn memory_regions_are_stable() {
        let vk = fixed_keys(1);
        let r1 = vk.memory_regions();
        let moved = vk;
        assert_eq!(r1, moved.memory_regions());
        assert_eq!(r1.len(), 9);
    }

    #[test]
    fn device_key_roundtrip() {
        let k = DeviceKey::generate().unwrap();
        let bytes = *k.expose_secret();
        let k2 = DeviceKey::from_bytes(&bytes).unwrap();
        assert_eq!(k.expose_secret(), k2.expose_secret());
        assert!(DeviceKey::from_bytes(&[0; 31]).is_err());
    }
}
