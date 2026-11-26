//! Keyslots: the DEK wrapped by `KEK_pw`, `KEK_rec` or `KEK_dev` (SPEC §9.6).
//!
//! ```text
//! aad         = "EMP-KEYSLOT-v1" || vault_id || u32be(slot_id) || u8(kind: 1 pw, 2 recovery, 3 device)
//!               || lp(kdf) || lp(kdf_params_cbor) || u32be(key_epoch)
//! wrapped_dek = XChaCha20Poly1305(KEK, nonce[24], DEK, aad)   // 48 bytes
//! ```
//!
//! | kind       | `kdf`          | `kdf_params`             | `salt`             |
//! |------------|----------------|--------------------------|--------------------|
//! | `password` | `argon2id-v13` | canonical CBOR `{m,p,t}` | 16 random bytes    |
//! | `recovery` | `hkdf-sha256`  | `0xa0` (empty CBOR map)  | empty (`vault_id`) |
//! | `device`   | `none`         | `0xa0` (empty CBOR map)  | empty              |
//!
//! A password is verified only by the AEAD tag; no verifier or hash is stored. A tag failure on a password or
//! recovery slot is [`CryptoError::BadPassword`].
//!
//! [`Keyslot::from_columns`] / [`Keyslot::to_columns`] map onto the `keyslots` table (SPEC §10.2).
//! [`Keyslot::encode`] / [`Keyslot::decode`] are a self-contained canonical binary form, also used for
//! [`canonical_keyslots_digest`] (the `SHA-256(canonical keyslots)` input of the state MAC, §9.8).

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{Tag, XChaCha20Poly1305, XNonce};
use secrecy::SecretString;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::codec::{Reader, put_lp};
use crate::error::{CryptoError, Result};
use crate::kdf::{KdfParams, SALT_LEN, derive_password_kek};
use crate::keys::{Dek, DeviceKey, KEY_LEN, Kek, RecoveryKey, SubKey, VaultId};
use crate::rng;

/// Length of the wrapped DEK (32-byte key + 16-byte tag).
pub const WRAPPED_DEK_LEN: usize = 48;
/// Keyslot nonce length.
pub const KEYSLOT_NONCE_LEN: usize = 24;
/// Canonical CBOR for an empty map (kdf_params of non-password slots).
pub const EMPTY_CBOR_MAP: [u8; 1] = [0xa0];

const AAD_DOMAIN: &[u8] = b"EMP-KEYSLOT-v1";
const ENCODING_VERSION: u8 = 1;

/// What unlocks a keyslot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum KeyslotKind {
    /// Argon2id(password).
    Password,
    /// HKDF(recovery key).
    Recovery,
    /// The device key from the OS keychain (used when the vault is not encrypted).
    Device,
}

impl KeyslotKind {
    /// The AAD byte (1, 2, 3).
    #[must_use]
    pub const fn as_u8(self) -> u8 {
        match self {
            Self::Password => 1,
            Self::Recovery => 2,
            Self::Device => 3,
        }
    }

    /// Parses the AAD byte.
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            1 => Ok(Self::Password),
            2 => Ok(Self::Recovery),
            3 => Ok(Self::Device),
            _ => Err(CryptoError::Malformed("keyslot kind")),
        }
    }

    /// The `keyslots.kind` column value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Recovery => "recovery",
            Self::Device => "device",
        }
    }

    /// Parses the `keyslots.kind` column value.
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "password" => Ok(Self::Password),
            "recovery" => Ok(Self::Recovery),
            "device" => Ok(Self::Device),
            _ => Err(CryptoError::Malformed("keyslot kind")),
        }
    }

    /// The `kdf` column value this kind always uses.
    #[must_use]
    pub const fn kdf_name(self) -> &'static str {
        match self {
            Self::Password => "argon2id-v13",
            Self::Recovery => "hkdf-sha256",
            Self::Device => "none",
        }
    }
}

/// The KDF of a keyslot together with its parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotKdf {
    /// Argon2id v0x13 with these parameters and salt.
    Argon2id {
        /// Cost parameters.
        params: KdfParams,
        /// 16-byte random salt (new on every password change).
        salt: [u8; SALT_LEN],
    },
    /// HKDF-SHA256 with `salt = vault_id` (recovery slots).
    HkdfSha256,
    /// The KEK is the device key itself.
    None,
}

impl SlotKdf {
    fn kind(&self) -> KeyslotKind {
        match self {
            Self::Argon2id { .. } => KeyslotKind::Password,
            Self::HkdfSha256 => KeyslotKind::Recovery,
            Self::None => KeyslotKind::Device,
        }
    }

    fn params_cbor(&self) -> Vec<u8> {
        match self {
            Self::Argon2id { params, .. } => params.to_cbor(),
            Self::HkdfSha256 | Self::None => EMPTY_CBOR_MAP.to_vec(),
        }
    }

    fn salt(&self) -> &[u8] {
        match self {
            Self::Argon2id { salt, .. } => salt,
            Self::HkdfSha256 | Self::None => &[],
        }
    }
}

/// One row of the `keyslots` table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keyslot {
    slot_id: u32,
    kdf: SlotKdf,
    nonce: [u8; KEYSLOT_NONCE_LEN],
    wrapped_dek: [u8; WRAPPED_DEK_LEN],
    key_epoch: u16,
    created_at: i64,
}

/// The `keyslots` columns as owned values, ready for an `INSERT`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyslotColumns {
    /// `slot_id INTEGER PRIMARY KEY`.
    pub slot_id: i64,
    /// `kind TEXT` (`password` | `recovery` | `device`).
    pub kind: &'static str,
    /// `kdf TEXT` (`argon2id-v13` | `hkdf-sha256` | `none`).
    pub kdf: &'static str,
    /// `kdf_params BLOB` (canonical CBOR).
    pub kdf_params: Vec<u8>,
    /// `salt BLOB` (16 bytes for password slots, empty otherwise).
    pub salt: Vec<u8>,
    /// `nonce BLOB` (24 bytes).
    pub nonce: Vec<u8>,
    /// `wrapped_dek BLOB` (48 bytes).
    pub wrapped_dek: Vec<u8>,
    /// `key_epoch INTEGER`.
    pub key_epoch: i64,
    /// `created_at INTEGER` (unix ms).
    pub created_at: i64,
}

fn aad(vault_id: &VaultId, slot_id: u32, kdf: &SlotKdf, key_epoch: u16) -> Result<Vec<u8>> {
    let kind = kdf.kind();
    let mut a = Vec::with_capacity(64);
    a.extend_from_slice(AAD_DOMAIN);
    a.extend_from_slice(vault_id.as_bytes());
    a.extend_from_slice(&slot_id.to_be_bytes());
    a.push(kind.as_u8());
    put_lp(&mut a, kind.kdf_name().as_bytes())?;
    put_lp(&mut a, &kdf.params_cbor())?;
    a.extend_from_slice(&u32::from(key_epoch).to_be_bytes());
    Ok(a)
}

impl Keyslot {
    pub(crate) fn wrap(
        kek: &Kek,
        vault_id: &VaultId,
        slot_id: u32,
        kdf: SlotKdf,
        dek: &Dek,
        created_at: i64,
        nonce: [u8; KEYSLOT_NONCE_LEN],
    ) -> Result<Self> {
        let aad = aad(vault_id, slot_id, &kdf, dek.epoch())?;
        let mut buf = Zeroizing::new([0u8; WRAPPED_DEK_LEN]);
        let (key_part, tag_part) = buf.split_at_mut(KEY_LEN);
        key_part.copy_from_slice(dek.expose());
        let tag = XChaCha20Poly1305::new(kek.expose().into())
            .encrypt_in_place_detached(XNonce::from_slice(&nonce), &aad, key_part)
            .map_err(|_| CryptoError::Internal)?;
        tag_part.copy_from_slice(&tag);
        Ok(Self {
            slot_id,
            kdf,
            nonce,
            wrapped_dek: *buf,
            key_epoch: dek.epoch(),
            created_at,
        })
    }

    fn unwrap_with(&self, kek: &Kek, vault_id: &VaultId, on_fail: CryptoError) -> Result<Dek> {
        let aad = aad(vault_id, self.slot_id, &self.kdf, self.key_epoch)?;
        let (ct, tag) = self.wrapped_dek.split_at(KEY_LEN);
        let key = SubKey::fill_with(|out| {
            out.copy_from_slice(ct);
            XChaCha20Poly1305::new(kek.expose().into())
                .decrypt_in_place_detached(
                    XNonce::from_slice(&self.nonce),
                    &aad,
                    out,
                    Tag::from_slice(tag),
                )
                .map_err(|_| on_fail)
        })?;
        Ok(Dek::from_parts(key, self.key_epoch))
    }

    /// Wraps `dek` under Argon2id(password) with a fresh random salt and nonce. Runs the KDF (slow).
    pub fn wrap_password(
        vault_id: &VaultId,
        slot_id: u32,
        dek: &Dek,
        password: &SecretString,
        params: &KdfParams,
        created_at: i64,
    ) -> Result<Self> {
        let salt = rng::array::<SALT_LEN>()?;
        let kek = derive_password_kek(password, &salt, params)?;
        Self::wrap(
            &kek,
            vault_id,
            slot_id,
            SlotKdf::Argon2id {
                params: *params,
                salt,
            },
            dek,
            created_at,
            rng::array()?,
        )
    }

    /// Wraps `dek` under `KEK_rec`.
    pub fn wrap_recovery(
        vault_id: &VaultId,
        slot_id: u32,
        dek: &Dek,
        recovery: &RecoveryKey,
        created_at: i64,
    ) -> Result<Self> {
        let kek = recovery.derive_kek(vault_id)?;
        Self::wrap(
            &kek,
            vault_id,
            slot_id,
            SlotKdf::HkdfSha256,
            dek,
            created_at,
            rng::array()?,
        )
    }

    /// Wraps `dek` under the device key (plaintext vaults).
    pub fn wrap_device(
        vault_id: &VaultId,
        slot_id: u32,
        dek: &Dek,
        device: &DeviceKey,
        created_at: i64,
    ) -> Result<Self> {
        let kek = Kek::copy_from(device.expose())?;
        Self::wrap(
            &kek,
            vault_id,
            slot_id,
            SlotKdf::None,
            dek,
            created_at,
            rng::array()?,
        )
    }

    /// Unwraps the DEK with a password. Parameter bounds are checked **before** the KDF runs.
    ///
    /// Errors: [`CryptoError::BadPassword`] on a wrong password; `InvalidKdfParams` / `PasswordTooLong` before
    /// the KDF; `InvalidArgument` if this is not a password slot. Slow: call from `spawn_blocking`.
    pub fn unwrap_password(&self, vault_id: &VaultId, password: &SecretString) -> Result<Dek> {
        let SlotKdf::Argon2id { params, salt } = &self.kdf else {
            return Err(CryptoError::InvalidArgument("not a password keyslot"));
        };
        let kek = derive_password_kek(password, salt, params)?;
        self.unwrap_with(&kek, vault_id, CryptoError::BadPassword)
    }

    /// Unwraps the DEK with the recovery key ([`CryptoError::BadPassword`] if it is the wrong key).
    pub fn unwrap_recovery(&self, vault_id: &VaultId, recovery: &RecoveryKey) -> Result<Dek> {
        if self.kdf != SlotKdf::HkdfSha256 {
            return Err(CryptoError::InvalidArgument("not a recovery keyslot"));
        }
        let kek = recovery.derive_kek(vault_id)?;
        self.unwrap_with(&kek, vault_id, CryptoError::BadPassword)
    }

    /// Unwraps the DEK with the device key ([`CryptoError::AuthFailed`] on mismatch).
    pub fn unwrap_device(&self, vault_id: &VaultId, device: &DeviceKey) -> Result<Dek> {
        if self.kdf != SlotKdf::None {
            return Err(CryptoError::InvalidArgument("not a device keyslot"));
        }
        let kek = Kek::copy_from(device.expose())?;
        self.unwrap_with(&kek, vault_id, CryptoError::AuthFailed)
    }

    /// Slot id.
    #[must_use]
    pub fn slot_id(&self) -> u32 {
        self.slot_id
    }

    /// Kind.
    #[must_use]
    pub fn kind(&self) -> KeyslotKind {
        self.kdf.kind()
    }

    /// KDF and parameters.
    #[must_use]
    pub fn kdf(&self) -> &SlotKdf {
        &self.kdf
    }

    /// Argon2id parameters for password slots (for `VaultStatus.kdf` and the "Strengthen" prompt).
    #[must_use]
    pub fn kdf_params(&self) -> Option<KdfParams> {
        match self.kdf {
            SlotKdf::Argon2id { params, .. } => Some(params),
            _ => None,
        }
    }

    /// DEK epoch of the wrapped key.
    #[must_use]
    pub fn key_epoch(&self) -> u16 {
        self.key_epoch
    }

    /// Creation time (unix ms).
    #[must_use]
    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    /// Converts to `keyslots` column values.
    #[must_use]
    pub fn to_columns(&self) -> KeyslotColumns {
        let kind = self.kind();
        KeyslotColumns {
            slot_id: i64::from(self.slot_id),
            kind: kind.as_str(),
            kdf: kind.kdf_name(),
            kdf_params: self.kdf.params_cbor(),
            salt: self.kdf.salt().to_vec(),
            nonce: self.nonce.to_vec(),
            wrapped_dek: self.wrapped_dek.to_vec(),
            key_epoch: i64::from(self.key_epoch),
            created_at: self.created_at,
        }
    }

    /// Parses and validates a `keyslots` row. Rejects inconsistent kind/kdf pairs, non-canonical CBOR,
    /// out-of-bounds Argon2 parameters (so the KDF never runs on them), bad salt/nonce/wrapped lengths and
    /// out-of-range ids/epochs.
    #[allow(clippy::too_many_arguments)]
    pub fn from_columns(
        slot_id: i64,
        kind: &str,
        kdf: &str,
        kdf_params: &[u8],
        salt: &[u8],
        nonce: &[u8],
        wrapped_dek: &[u8],
        key_epoch: i64,
        created_at: i64,
    ) -> Result<Self> {
        let kind = KeyslotKind::parse(kind)?;
        if kdf != kind.kdf_name() {
            return Err(CryptoError::Malformed("keyslot kdf"));
        }
        let kdf = match kind {
            KeyslotKind::Password => {
                let params = KdfParams::from_cbor(kdf_params)?;
                params.validate()?;
                let salt: [u8; SALT_LEN] = salt
                    .try_into()
                    .map_err(|_| CryptoError::InvalidKdfParams("salt must be 16 bytes"))?;
                SlotKdf::Argon2id { params, salt }
            }
            KeyslotKind::Recovery | KeyslotKind::Device => {
                if kdf_params != EMPTY_CBOR_MAP || !salt.is_empty() {
                    return Err(CryptoError::Malformed("keyslot kdf params"));
                }
                if kind == KeyslotKind::Recovery {
                    SlotKdf::HkdfSha256
                } else {
                    SlotKdf::None
                }
            }
        };
        Ok(Self {
            slot_id: u32::try_from(slot_id).map_err(|_| CryptoError::Malformed("keyslot id"))?,
            kdf,
            nonce: nonce
                .try_into()
                .map_err(|_| CryptoError::Malformed("keyslot nonce"))?,
            wrapped_dek: wrapped_dek
                .try_into()
                .map_err(|_| CryptoError::Malformed("keyslot wrapped dek"))?,
            key_epoch: u16::try_from(key_epoch)
                .map_err(|_| CryptoError::Malformed("keyslot epoch"))?,
            created_at,
        })
    }

    /// Canonical binary encoding:
    /// `u8 version(1) || u32be slot_id || u8 kind || lp(kdf) || lp(kdf_params) || lp(salt) || nonce[24]
    ///  || wrapped_dek[48] || u16be key_epoch || i64be created_at`.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let kind = self.kind();
        let mut out = Vec::with_capacity(128);
        out.push(ENCODING_VERSION);
        out.extend_from_slice(&self.slot_id.to_be_bytes());
        out.push(kind.as_u8());
        put_lp(&mut out, kind.kdf_name().as_bytes())?;
        put_lp(&mut out, &self.kdf.params_cbor())?;
        put_lp(&mut out, self.kdf.salt())?;
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.wrapped_dek);
        out.extend_from_slice(&self.key_epoch.to_be_bytes());
        out.extend_from_slice(&self.created_at.to_be_bytes());
        Ok(out)
    }

    /// Parses [`encode`](Self::encode) output with the same validation as [`from_columns`](Self::from_columns).
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader::new(bytes, "keyslot");
        let version = r.u8()?;
        if version != ENCODING_VERSION {
            return Err(CryptoError::UnsupportedVersion {
                what: "keyslot",
                version: u16::from(version),
            });
        }
        let slot_id = r.u32be()?;
        let kind = KeyslotKind::from_u8(r.u8()?)?;
        let kdf = std::str::from_utf8(r.lp(32)?).map_err(|_| CryptoError::Malformed("keyslot"))?;
        let params = r.lp(64)?;
        let salt = r.lp(64)?;
        let nonce = r.take(KEYSLOT_NONCE_LEN)?;
        let wrapped = r.take(WRAPPED_DEK_LEN)?;
        let epoch = r.u16be()?;
        let created_at = r.i64be()?;
        r.finish()?;
        Self::from_columns(
            i64::from(slot_id),
            kind.as_str(),
            kdf,
            params,
            salt,
            nonce,
            wrapped,
            i64::from(epoch),
            created_at,
        )
    }
}

/// `SHA-256(canonical keyslots)`: keyslots sorted by `slot_id`, each as `lp(encode())`.
pub fn canonical_keyslots_digest(slots: &[Keyslot]) -> Result<[u8; 32]> {
    let mut sorted: Vec<&Keyslot> = slots.iter().collect();
    sorted.sort_by_key(|s| s.slot_id);
    if sorted
        .windows(2)
        .any(|w| matches!(w, [a, b] if a.slot_id == b.slot_id))
    {
        return Err(CryptoError::InvalidArgument("duplicate keyslot id"));
    }
    let mut h = Sha256::new();
    h.update(b"EMP-KEYSLOTS-v1");
    h.update(
        u32::try_from(sorted.len())
            .map_err(|_| CryptoError::TooLarge("keyslots"))?
            .to_be_bytes(),
    );
    for s in sorted {
        let enc = s.encode()?;
        h.update(
            u32::try_from(enc.len())
                .map_err(|_| CryptoError::TooLarge("keyslot"))?
                .to_be_bytes(),
        );
        h.update(&enc);
    }
    Ok(h.finalize().into())
}

#[cfg(test)]
impl Keyslot {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn wrap_password_fixed(
        vault_id: &VaultId,
        slot_id: u32,
        dek: &Dek,
        password: &SecretString,
        params: &KdfParams,
        salt: [u8; SALT_LEN],
        nonce: [u8; KEYSLOT_NONCE_LEN],
        created_at: i64,
    ) -> Result<Self> {
        let kek = derive_password_kek(password, &salt, params)?;
        Self::wrap(
            &kek,
            vault_id,
            slot_id,
            SlotKdf::Argon2id {
                params: *params,
                salt,
            },
            dek,
            created_at,
            nonce,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::test_support::fixed_dek;

    const P: KdfParams = KdfParams::INSECURE_TEST;

    fn vid() -> VaultId {
        VaultId::from_bytes([0x42; 16])
    }

    fn pw(s: &str) -> SecretString {
        SecretString::from(s.to_owned())
    }

    #[test]
    fn password_roundtrip_and_wrong_password() {
        let dek = Dek::generate(1).unwrap();
        let slot =
            Keyslot::wrap_password(&vid(), 1, &dek, &pw("hunter2 hunter2"), &P, 1000).unwrap();
        assert_eq!(slot.kind(), KeyslotKind::Password);
        let out = slot
            .unwrap_password(&vid(), &pw("hunter2 hunter2"))
            .unwrap();
        assert_eq!(out.expose(), dek.expose());
        assert_eq!(out.epoch(), 1);
        assert_eq!(
            slot.unwrap_password(&vid(), &pw("hunter2 hunter3")).err(),
            Some(CryptoError::BadPassword)
        );
        // Wrong vault id is also a failed unlock (AAD mismatch).
        assert_eq!(
            slot.unwrap_password(&VaultId::from_bytes([0; 16]), &pw("hunter2 hunter2"))
                .err(),
            Some(CryptoError::BadPassword)
        );
        // Wrong slot type.
        assert!(matches!(
            slot.unwrap_device(&vid(), &DeviceKey::generate().unwrap()),
            Err(CryptoError::InvalidArgument(_))
        ));
    }

    #[test]
    fn fresh_salt_and_nonce() {
        let dek = Dek::generate(1).unwrap();
        let a = Keyslot::wrap_password(&vid(), 1, &dek, &pw("x"), &P, 0).unwrap();
        let b = Keyslot::wrap_password(&vid(), 1, &dek, &pw("x"), &P, 0).unwrap();
        assert_ne!(a.kdf, b.kdf); // salts differ
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.wrapped_dek, b.wrapped_dek);
    }

    #[test]
    fn recovery_and_device() {
        let dek = Dek::generate(3).unwrap();
        let rk = RecoveryKey::generate().unwrap();
        let slot = Keyslot::wrap_recovery(&vid(), 2, &dek, &rk, 5).unwrap();
        assert_eq!(
            slot.unwrap_recovery(&vid(), &rk).unwrap().expose(),
            dek.expose()
        );
        let other = RecoveryKey::generate().unwrap();
        assert_eq!(
            slot.unwrap_recovery(&vid(), &other).err(),
            Some(CryptoError::BadPassword)
        );
        // A recovery key typed back in from its words works.
        let rk2 = RecoveryKey::from_words(&rk.words().unwrap()).unwrap();
        assert_eq!(slot.unwrap_recovery(&vid(), &rk2).unwrap().epoch(), 3);

        let dk = DeviceKey::generate().unwrap();
        let slot = Keyslot::wrap_device(&vid(), 3, &dek, &dk, 5).unwrap();
        assert_eq!(
            slot.unwrap_device(&vid(), &dk).unwrap().expose(),
            dek.expose()
        );
        assert_eq!(
            slot.unwrap_device(&vid(), &DeviceKey::generate().unwrap())
                .err(),
            Some(CryptoError::AuthFailed)
        );
    }

    #[test]
    fn columns_roundtrip() {
        let dek = Dek::generate(1).unwrap();
        let slots = [
            Keyslot::wrap_password(&vid(), 1, &dek, &pw("pw"), &P, 7).unwrap(),
            Keyslot::wrap_recovery(&vid(), 2, &dek, &RecoveryKey::generate().unwrap(), 7).unwrap(),
            Keyslot::wrap_device(&vid(), 3, &dek, &DeviceKey::generate().unwrap(), 7).unwrap(),
        ];
        for s in &slots {
            let c = s.to_columns();
            let back = Keyslot::from_columns(
                c.slot_id,
                c.kind,
                c.kdf,
                &c.kdf_params,
                &c.salt,
                &c.nonce,
                &c.wrapped_dek,
                c.key_epoch,
                c.created_at,
            )
            .unwrap();
            assert_eq!(&back, s);
            assert_eq!(&Keyslot::decode(&s.encode().unwrap()).unwrap(), s);
        }
        assert_eq!(slots[1].to_columns().kdf, "hkdf-sha256");
        assert_eq!(slots[2].to_columns().kdf, "none");
        assert_eq!(slots[0].to_columns().salt.len(), 16);
    }

    fn cols(s: &Keyslot) -> KeyslotColumns {
        s.to_columns()
    }

    fn parse(c: &KeyslotColumns) -> Result<Keyslot> {
        Keyslot::from_columns(
            c.slot_id,
            c.kind,
            c.kdf,
            &c.kdf_params,
            &c.salt,
            &c.nonce,
            &c.wrapped_dek,
            c.key_epoch,
            c.created_at,
        )
    }

    #[test]
    fn from_columns_validation() {
        let dek = Dek::generate(1).unwrap();
        let s = Keyslot::wrap_password(&vid(), 1, &dek, &pw("pw"), &KdfParams::INSECURE_TEST, 0)
            .unwrap();
        let good = cols(&s);
        parse(&good).unwrap();

        let mut c = good.clone();
        c.kdf = "hkdf-sha256";
        assert!(parse(&c).is_err());
        let mut c = good.clone();
        c.kind = "admin";
        assert!(parse(&c).is_err());
        let mut c = good.clone();
        c.salt.pop();
        assert!(matches!(parse(&c), Err(CryptoError::InvalidKdfParams(_))));
        let mut c = good.clone();
        c.nonce.pop();
        assert!(parse(&c).is_err());
        let mut c = good.clone();
        c.wrapped_dek.push(0);
        assert!(parse(&c).is_err());
        let mut c = good.clone();
        c.key_epoch = 70_000;
        assert!(parse(&c).is_err());
        let mut c = good.clone();
        c.slot_id = -1;
        assert!(parse(&c).is_err());
        // Out-of-bounds Argon2 parameters are rejected at parse time.
        let mut c = good.clone();
        c.kdf_params = KdfParams {
            m_kib: 1 << 30,
            t: 3,
            p: 4,
        }
        .to_cbor();
        assert!(matches!(parse(&c), Err(CryptoError::InvalidKdfParams(_))));
        let mut c = good.clone();
        c.kdf_params = KdfParams {
            m_kib: 65_536,
            t: 2,
            p: 4,
        }
        .to_cbor();
        assert!(matches!(parse(&c), Err(CryptoError::InvalidKdfParams(_))));
        // Recovery slot with a salt or params.
        let r =
            Keyslot::wrap_recovery(&vid(), 2, &dek, &RecoveryKey::generate().unwrap(), 0).unwrap();
        let mut c = cols(&r);
        c.salt = vec![1];
        assert!(parse(&c).is_err());
        let mut c = cols(&r);
        c.kdf_params = KdfParams::STANDARD.to_cbor();
        assert!(parse(&c).is_err());
    }

    #[test]
    fn tamper_every_aad_field() {
        let dek = fixed_dek(5, 1);
        let s = Keyslot::wrap_password(&vid(), 1, &dek, &pw("pw"), &P, 0).unwrap();
        let ok = |k: &Keyslot| k.unwrap_password(&vid(), &pw("pw"));
        assert!(ok(&s).is_ok());

        // slot_id
        let mut t = s.clone();
        t.slot_id = 2;
        assert_eq!(ok(&t).err(), Some(CryptoError::BadPassword));
        // key_epoch
        let mut t = s.clone();
        t.key_epoch = 2;
        assert_eq!(ok(&t).err(), Some(CryptoError::BadPassword));
        // nonce / wrapped bytes: every bit
        for i in 0..KEYSLOT_NONCE_LEN {
            let mut t = s.clone();
            t.nonce[i] ^= 1;
            assert!(ok(&t).is_err());
        }
        for i in 0..WRAPPED_DEK_LEN {
            for bit in 0..8 {
                let mut t = s.clone();
                t.wrapped_dek[i] ^= 1 << bit;
                assert_eq!(ok(&t).err(), Some(CryptoError::BadPassword));
            }
        }
        // salt (changes the KEK)
        let mut t = s.clone();
        if let SlotKdf::Argon2id { salt, .. } = &mut t.kdf {
            salt[0] ^= 1;
        }
        assert_eq!(ok(&t).err(), Some(CryptoError::BadPassword));
        // kind: the same wrapped bytes presented as a recovery slot do not open.
        let as_recovery = Keyslot {
            kdf: SlotKdf::HkdfSha256,
            ..s.clone()
        };
        assert!(
            as_recovery
                .unwrap_recovery(&vid(), &RecoveryKey::generate().unwrap())
                .is_err()
        );
    }

    #[test]
    fn kdf_params_bound_in_aad() {
        // Same KEK bytes (forced) but different recorded params ⇒ AAD mismatch. Simulated by wrapping with one
        // set of params and re-labelling the slot: the KEK differs anyway, so also check the AAD bytes differ.
        let a = aad(
            &vid(),
            1,
            &SlotKdf::Argon2id {
                params: KdfParams::FLOOR,
                salt: [0; 16],
            },
            1,
        )
        .unwrap();
        let b = aad(
            &vid(),
            1,
            &SlotKdf::Argon2id {
                params: KdfParams::STANDARD,
                salt: [0; 16],
            },
            1,
        )
        .unwrap();
        assert_ne!(a, b);
        let mut want = b"EMP-KEYSLOT-v1".to_vec();
        want.extend_from_slice(&[0x42; 16]);
        want.extend_from_slice(&[0, 0, 0, 1, 1]);
        want.extend_from_slice(&[0, 0, 0, 12]);
        want.extend_from_slice(b"argon2id-v13");
        want.extend_from_slice(&[0, 0, 0, 14]);
        want.extend_from_slice(&KdfParams::STANDARD.to_cbor());
        want.extend_from_slice(&[0, 0, 0, 1]);
        assert_eq!(b, want);
    }

    #[test]
    fn digest_is_order_independent_and_sensitive() {
        let dek = Dek::generate(1).unwrap();
        let a = Keyslot::wrap_password(&vid(), 1, &dek, &pw("pw"), &P, 0).unwrap();
        let b =
            Keyslot::wrap_recovery(&vid(), 2, &dek, &RecoveryKey::generate().unwrap(), 0).unwrap();
        let d1 = canonical_keyslots_digest(&[a.clone(), b.clone()]).unwrap();
        let d2 = canonical_keyslots_digest(&[b.clone(), a.clone()]).unwrap();
        assert_eq!(d1, d2);
        let mut a2 = a.clone();
        a2.created_at = 1;
        assert_ne!(canonical_keyslots_digest(&[a2, b.clone()]).unwrap(), d1);
        assert_ne!(
            canonical_keyslots_digest(std::slice::from_ref(&a)).unwrap(),
            d1
        );
        assert!(canonical_keyslots_digest(&[a.clone(), a]).is_err());
    }

    #[test]
    fn decode_garbage() {
        assert!(Keyslot::decode(&[]).is_err());
        assert!(Keyslot::decode(&[2, 0, 0]).is_err());
        let dek = Dek::generate(1).unwrap();
        let enc = Keyslot::wrap_device(&vid(), 3, &dek, &DeviceKey::generate().unwrap(), 0)
            .unwrap()
            .encode()
            .unwrap();
        for n in 0..enc.len() {
            assert!(Keyslot::decode(&enc[..n]).is_err());
        }
        let mut longer = enc.clone();
        longer.push(0);
        assert!(Keyslot::decode(&longer).is_err());
    }
}
