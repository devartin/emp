//! Backup and snapshot format primitives (SPEC §9.21).
//!
//! **`.empsnap` / `.empbackup` framing** — `emp-store` assembles the container; this module provides the
//! fixed prefix and the MAC:
//!
//! ```text
//! file = magic "EMPSNAP\0" || u16be(1) || u32be(manifest_len) || manifest(CBOR) || sqlite_bytes || mac[32]
//! mac  = HMAC-SHA256(k_backup_mac, everything before it)
//! ```
//!
//! **Password container** — wraps a whole snapshot/backup file for plaintext vaults (or an optional backup
//! password), using Argon2id + the STREAM engine of [`crate::stream`]. The layout is EMP-defined (SPEC only says
//! "its header stores the KDF parameters"):
//!
//! ```text
//! header = "EMPPWC\0\x01" || u8 kdf(1 = argon2id-v13) || u32be m_kib || u32be t || u32be p || salt[16]
//!          || prefix[19] || u64be(padded_total_len)                                     // 64 bytes, = chunk AAD
//! key    = Argon2id(NFKC(password), salt, {m,t,p})
//! ```
//!
//! KDF parameters are bounds-checked before the KDF runs. A wrong password surfaces as
//! [`CryptoError::BadPassword`] on the first chunk.

use std::io::{Read, Write};

use hmac::{Hmac, Mac};
use secrecy::SecretString;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::codec::Reader;
use crate::error::{CryptoError, Result};
use crate::kdf::{KdfParams, SALT_LEN, derive_password_kek};
use crate::keys::{Kek, VaultKeys};
use crate::mac::MAC_LEN;
use crate::rng;
use crate::stream::{STREAM_PREFIX_LEN, StreamEncryptor, StreamLayout, StreamReader};

/// Snapshot / backup magic.
pub const SNAPSHOT_MAGIC: &[u8; 8] = b"EMPSNAP\0";
/// Snapshot format version.
pub const SNAPSHOT_VERSION: u16 = 1;
/// Length of [`SnapshotPrefix`] on disk.
pub const SNAPSHOT_PREFIX_LEN: usize = 8 + 2 + 4;
/// Upper bound accepted for the CBOR manifest (restore hardening).
pub const MAX_MANIFEST_LEN: u32 = 16 * 1024 * 1024;

/// Password-container magic.
pub const PASSWORD_CONTAINER_MAGIC: &[u8; 8] = b"EMPPWC\0\x01";
/// Password-container header length.
pub const PASSWORD_CONTAINER_HEADER_LEN: usize = 8 + 1 + 12 + SALT_LEN + STREAM_PREFIX_LEN + 8;
const KDF_ARGON2ID_V13: u8 = 1;

/// The fixed prefix `magic || u16be(version) || u32be(manifest_len)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotPrefix {
    /// Length of the CBOR manifest that follows.
    pub manifest_len: u32,
}

impl SnapshotPrefix {
    /// Encodes the 14 prefix bytes (version 1).
    pub fn encode(&self) -> Result<[u8; SNAPSHOT_PREFIX_LEN]> {
        if self.manifest_len > MAX_MANIFEST_LEN {
            return Err(CryptoError::TooLarge("snapshot manifest"));
        }
        let mut out = [0u8; SNAPSHOT_PREFIX_LEN];
        let (m, rest) = out.split_at_mut(8);
        m.copy_from_slice(SNAPSHOT_MAGIC);
        let (v, l) = rest.split_at_mut(2);
        v.copy_from_slice(&SNAPSHOT_VERSION.to_be_bytes());
        l.copy_from_slice(&self.manifest_len.to_be_bytes());
        Ok(out)
    }

    /// Parses and checks magic, version and manifest bound (restore step 1).
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader::new(
            bytes
                .get(..SNAPSHOT_PREFIX_LEN)
                .ok_or(CryptoError::Malformed("snapshot"))?,
            "snapshot",
        );
        if r.array::<8>()? != *SNAPSHOT_MAGIC {
            return Err(CryptoError::Malformed("snapshot magic"));
        }
        let version = r.u16be()?;
        if version != SNAPSHOT_VERSION {
            return Err(CryptoError::UnsupportedVersion {
                what: "snapshot",
                version,
            });
        }
        let manifest_len = r.u32be()?;
        if manifest_len > MAX_MANIFEST_LEN {
            return Err(CryptoError::TooLarge("snapshot manifest"));
        }
        Ok(Self { manifest_len })
    }
}

/// Incremental `HMAC(k_backup_mac, …)` over a snapshot as it is written or read.
#[derive(Clone)]
pub struct BackupMac(Hmac<Sha256>);

impl std::fmt::Debug for BackupMac {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BackupMac([REDACTED])")
    }
}

impl BackupMac {
    /// Absorbs bytes.
    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    /// The 32-byte MAC to append.
    #[must_use]
    pub fn finalize(self) -> [u8; MAC_LEN] {
        self.0.finalize().into_bytes().into()
    }

    /// Constant-time comparison against the stored trailing MAC.
    #[must_use]
    pub fn verify(self, stored: &[u8]) -> bool {
        let mac = self.finalize();
        stored.len() == MAC_LEN && bool::from(mac.as_slice().ct_eq(stored))
    }
}

impl VaultKeys {
    /// Starts a snapshot MAC under `k_backup_mac`.
    pub fn backup_mac(&self) -> Result<BackupMac> {
        <Hmac<Sha256> as Mac>::new_from_slice(self.backup_mac.expose())
            .map(BackupMac)
            .map_err(|_| CryptoError::Internal)
    }

    /// Verifies an in-memory snapshot/backup file (`… || mac[32]`) and returns the body before the MAC.
    pub fn verify_snapshot_bytes<'a>(&self, file: &'a [u8]) -> Result<&'a [u8]> {
        let split = file
            .len()
            .checked_sub(MAC_LEN)
            .ok_or(CryptoError::Malformed("snapshot"))?;
        let (body, mac) = file
            .split_at_checked(split)
            .ok_or(CryptoError::Malformed("snapshot"))?;
        let mut m = self.backup_mac()?;
        m.update(body);
        if m.verify(mac) {
            Ok(body)
        } else {
            Err(CryptoError::AuthFailed)
        }
    }
}

/// Parsed (unauthenticated) password-container header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasswordContainerHeader {
    /// Argon2id parameters (validated against §9.3 bounds before use).
    pub params: KdfParams,
    /// Argon2id salt.
    pub salt: [u8; SALT_LEN],
    /// STREAM nonce prefix.
    pub prefix: [u8; STREAM_PREFIX_LEN],
    /// Size layout.
    pub layout: StreamLayout,
}

impl PasswordContainerHeader {
    /// Encodes the 64 header bytes.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut h = Vec::with_capacity(PASSWORD_CONTAINER_HEADER_LEN);
        h.extend_from_slice(PASSWORD_CONTAINER_MAGIC);
        h.push(KDF_ARGON2ID_V13);
        h.extend_from_slice(&self.params.m_kib.to_be_bytes());
        h.extend_from_slice(&self.params.t.to_be_bytes());
        h.extend_from_slice(&self.params.p.to_be_bytes());
        h.extend_from_slice(&self.salt);
        h.extend_from_slice(&self.prefix);
        h.extend_from_slice(&self.layout.padded_len().to_be_bytes());
        h
    }

    /// Parses a header; KDF parameters are checked against the §9.3 bounds here.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader::new(bytes, "password container header");
        if r.array::<8>()? != *PASSWORD_CONTAINER_MAGIC {
            return Err(CryptoError::Malformed("password container magic"));
        }
        if r.u8()? != KDF_ARGON2ID_V13 {
            return Err(CryptoError::InvalidKdfParams("unknown kdf"));
        }
        let params = KdfParams {
            m_kib: r.u32be()?,
            t: r.u32be()?,
            p: r.u32be()?,
        };
        params.validate()?;
        let salt = r.array()?;
        let prefix = r.array()?;
        let layout = StreamLayout::from_padded_len(r.u64be()?)?;
        r.finish()?;
        Ok(Self {
            params,
            salt,
            prefix,
            layout,
        })
    }

    /// `true` if `bytes` starts with the password-container magic.
    #[must_use]
    pub fn sniff(bytes: &[u8]) -> bool {
        bytes.starts_with(PASSWORD_CONTAINER_MAGIC)
    }
}

/// Streaming password-container writer. Runs Argon2id in [`new`](Self::new) (slow: use `spawn_blocking`).
pub struct PasswordContainerWriter<W: Write> {
    inner: StreamEncryptor<W>,
    _kek: Kek,
}

impl<W: Write> PasswordContainerWriter<W> {
    /// Derives the key (fresh salt), writes the header and prepares chunk encryption.
    pub fn new(
        password: &SecretString,
        params: &KdfParams,
        content_len: u64,
        out: W,
    ) -> Result<Self> {
        let header = PasswordContainerHeader {
            params: *params,
            salt: rng::array()?,
            prefix: rng::array()?,
            layout: StreamLayout::for_content(content_len)?,
        };
        let kek = derive_password_kek(password, &header.salt, params)?;
        let inner = StreamEncryptor::new(
            kek.expose(),
            header.to_bytes(),
            &header.prefix,
            content_len,
            out,
        )?;
        Ok(Self { inner, _kek: kek })
    }

    /// Appends content.
    pub fn write_content(&mut self, data: &[u8]) -> Result<()> {
        self.inner.write_content(data)
    }

    /// Pads, writes the final chunk and returns the writer.
    pub fn finish(self) -> Result<W> {
        self.inner.finish()
    }
}

impl<W: Write> Write for PasswordContainerWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.write_content(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Encrypts `content` into a password container in memory.
pub fn seal_with_password(
    password: &SecretString,
    params: &KdfParams,
    content: &[u8],
) -> Result<Vec<u8>> {
    let mut w = PasswordContainerWriter::new(password, params, content.len() as u64, Vec::new())?;
    w.write_content(content)?;
    w.finish()
}

/// Opens a password container for streaming decryption (`r` at the start of the file). Runs Argon2id after the
/// header bounds checks pass. Wrong password ⇒ the first read returns [`CryptoError::BadPassword`].
pub fn open_password_container<R: Read>(
    password: &SecretString,
    mut r: R,
) -> Result<StreamReader<R>> {
    let mut h = [0u8; PASSWORD_CONTAINER_HEADER_LEN];
    r.read_exact(&mut h).map_err(CryptoError::from)?;
    let header = PasswordContainerHeader::parse(&h)?;
    let kek = derive_password_kek(password, &header.salt, &header.params)?;
    Ok(StreamReader::new(
        kek.expose(),
        h.to_vec(),
        &header.prefix,
        header.layout,
        r,
        CryptoError::BadPassword,
    ))
}

/// Decrypts a password container in memory.
pub fn open_with_password(password: &SecretString, file: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    open_password_container(password, file)?.read_to_end_checked()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::test_support::fixed_keys;

    fn pw(s: &str) -> SecretString {
        SecretString::from(s.to_owned())
    }

    const P: KdfParams = KdfParams::INSECURE_TEST;

    #[test]
    fn prefix_roundtrip_and_rejection() {
        let p = SnapshotPrefix { manifest_len: 1234 };
        let b = p.encode().unwrap();
        assert_eq!(&b[..8], b"EMPSNAP\0");
        assert_eq!(&b[8..10], &[0, 1]);
        assert_eq!(SnapshotPrefix::parse(&b).unwrap(), p);
        let mut v2 = b;
        v2[9] = 2;
        assert!(matches!(
            SnapshotPrefix::parse(&v2),
            Err(CryptoError::UnsupportedVersion { .. })
        ));
        let mut magic = b;
        magic[0] = b'X';
        assert!(SnapshotPrefix::parse(&magic).is_err());
        let huge = SnapshotPrefix {
            manifest_len: MAX_MANIFEST_LEN + 1,
        };
        assert!(huge.encode().is_err());
        let mut hb = b;
        hb[10..14].copy_from_slice(&(MAX_MANIFEST_LEN + 1).to_be_bytes());
        assert!(matches!(
            SnapshotPrefix::parse(&hb),
            Err(CryptoError::TooLarge(_))
        ));
        assert!(SnapshotPrefix::parse(&b[..13]).is_err());
    }

    #[test]
    fn snapshot_mac() {
        let k = fixed_keys(1);
        let mut file = SnapshotPrefix { manifest_len: 3 }
            .encode()
            .unwrap()
            .to_vec();
        file.extend_from_slice(b"abc sqlite bytes");
        let mut m = k.backup_mac().unwrap();
        m.update(&file[..5]);
        m.update(&file[5..]);
        let mac = m.finalize();
        file.extend_from_slice(&mac);
        let body = k.verify_snapshot_bytes(&file).unwrap();
        assert_eq!(body.len(), file.len() - 32);
        for i in 0..file.len() {
            let mut t = file.clone();
            t[i] ^= 1;
            assert_eq!(k.verify_snapshot_bytes(&t), Err(CryptoError::AuthFailed));
        }
        assert_eq!(
            fixed_keys(2).verify_snapshot_bytes(&file),
            Err(CryptoError::AuthFailed)
        );
        assert!(k.verify_snapshot_bytes(&[0; 10]).is_err());
    }

    #[test]
    fn password_container_roundtrip() {
        let content: Vec<u8> = (0..200_000u32).map(|i| (i % 253) as u8).collect();
        let file = seal_with_password(&pw("backup pass"), &P, &content).unwrap();
        assert!(PasswordContainerHeader::sniff(&file));
        let h = PasswordContainerHeader::parse(&file[..PASSWORD_CONTAINER_HEADER_LEN]).unwrap();
        assert_eq!(h.params, P);
        assert_eq!(
            open_with_password(&pw("backup pass"), &file)
                .unwrap()
                .as_slice(),
            content.as_slice()
        );
        assert_eq!(
            open_with_password(&pw("backup pasS"), &file),
            Err(CryptoError::BadPassword)
        );
        // Normalisation applies to backup passwords too.
        let f2 = seal_with_password(&pw("\u{FB01}x"), &P, b"z").unwrap();
        assert_eq!(
            open_with_password(&pw("fix"), &f2).unwrap().as_slice(),
            b"z"
        );
    }

    #[test]
    fn password_container_tamper_and_bounds() {
        let file = seal_with_password(&pw("pw"), &P, b"secret snapshot").unwrap();
        // Salt / prefix flips ⇒ wrong key or nonce ⇒ BadPassword on chunk 0.
        for i in 21..PASSWORD_CONTAINER_HEADER_LEN - 8 {
            let mut t = file.clone();
            t[i] ^= 1;
            assert_eq!(
                open_with_password(&pw("pw"), &t),
                Err(CryptoError::BadPassword),
                "byte {i}"
            );
        }
        // Out-of-bounds params are rejected before the KDF.
        let mut t = file.clone();
        t[9..13].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(matches!(
            open_with_password(&pw("pw"), &t),
            Err(CryptoError::InvalidKdfParams(_))
        ));
        let mut t = file.clone();
        t[8] = 2;
        assert!(matches!(
            open_with_password(&pw("pw"), &t),
            Err(CryptoError::InvalidKdfParams(_))
        ));
        // Truncated ciphertext.
        assert_eq!(
            open_with_password(&pw("pw"), &file[..file.len() - 3]),
            Err(CryptoError::Truncated)
        );
        assert!(open_with_password(&pw("pw"), &file[..10]).is_err());
    }
}
