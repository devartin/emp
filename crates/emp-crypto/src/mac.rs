//! Keyed MACs: the integrity manifest (multiset hash + state MAC), the header MAC, keyed blob names and blind
//! indexes (SPEC §9.7, §9.8).
//!
//! ```text
//! h(row)    = HMAC-SHA256(k_manifest, u8 table_tag || lp(id) || lp(extra) || u64be(rev) || SHA-256(payload))
//! mset_root = XOR of h(row) over every row of every enc=1 table
//! state_mac = HMAC-SHA256(k_manifest, "EMP-STATE-v1" || vault_id || u64be(write_counter) || mset_root
//!                                     || SHA-256(canonical keyslots))
//! ```
//!
//! Incremental maintenance: insert `root ^= h(new)`; update `root ^= h(old) ^ h(new)`; delete `root ^= h(old)`.

use std::fmt;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::codec::{hex_decode_array, hex_encode, put_lp};
use crate::envelope::{Extra, TableTag};
use crate::error::{CryptoError, Result};
use crate::keys::{KEY_LEN, VaultKeys};

type HmacSha256 = Hmac<Sha256>;

/// Length of every MAC / hash in this module.
pub const MAC_LEN: usize = 32;
/// Length of a blob name in bytes (32 hex characters).
pub const BLOB_NAME_BYTES: usize = 16;

pub(crate) fn hmac(key: &[u8; KEY_LEN], parts: &[&[u8]]) -> Result<[u8; MAC_LEN]> {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).map_err(|_| CryptoError::Internal)?;
    for p in parts {
        m.update(p);
    }
    Ok(m.finalize().into_bytes().into())
}

/// SHA-256 of `data` (e.g. the content digest fed to [`VaultKeys::blob_name`]).
#[must_use]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Incremental SHA-256 for streaming content (assets, snapshot parts).
#[derive(Clone, Default)]
pub struct ContentHasher(Sha256);

impl ContentHasher {
    /// New hasher.
    #[must_use]
    pub fn new() -> Self {
        Self(Sha256::new())
    }

    /// Absorbs bytes.
    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    /// Final digest.
    #[must_use]
    pub fn finalize(self) -> [u8; 32] {
        self.0.finalize().into()
    }
}

impl fmt::Debug for ContentHasher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ContentHasher")
    }
}

/// `h(row)` of one encrypted row.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct RowHash([u8; MAC_LEN]);

impl RowHash {
    /// Raw bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; MAC_LEN] {
        &self.0
    }
}

impl fmt::Debug for RowHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RowHash({})", hex_encode(&self.0))
    }
}

/// The multiset-hash root: XOR of every [`RowHash`]. Order-independent and self-inverse.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct MsetRoot([u8; MAC_LEN]);

impl MsetRoot {
    /// Root of the empty set (all zeros).
    pub const EMPTY: Self = Self([0u8; MAC_LEN]);

    /// Parses `vault_state.mset_root`.
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        bytes
            .try_into()
            .map(Self)
            .map_err(|_| CryptoError::Malformed("mset root"))
    }

    /// Raw bytes for `vault_state.mset_root`.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; MAC_LEN] {
        &self.0
    }

    /// XORs `h` in (used for both insert and delete).
    pub fn toggle(&mut self, h: &RowHash) {
        for (a, b) in self.0.iter_mut().zip(h.0) {
            *a ^= b;
        }
    }

    /// Row inserted.
    pub fn insert(&mut self, new: &RowHash) {
        self.toggle(new);
    }

    /// Row deleted.
    pub fn remove(&mut self, old: &RowHash) {
        self.toggle(old);
    }

    /// Row updated.
    pub fn replace(&mut self, old: &RowHash, new: &RowHash) {
        self.toggle(old);
        self.toggle(new);
    }

    /// Full recomputation (at unlock).
    pub fn from_hashes<'a>(hashes: impl IntoIterator<Item = &'a RowHash>) -> Self {
        let mut r = Self::EMPTY;
        for h in hashes {
            r.toggle(h);
        }
        r
    }

    /// Constant-time equality.
    #[must_use]
    pub fn ct_eq(&self, other: &MsetRoot) -> bool {
        bool::from(self.0.ct_eq(&other.0))
    }
}

impl fmt::Debug for MsetRoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MsetRoot({})", hex_encode(&self.0))
    }
}

/// A keyed blob name: `hex(HMAC-SHA256(k_blob_id, SHA-256(content))[..16])`, 32 lowercase hex characters.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BlobName(String);

impl BlobName {
    /// Validates `^[0-9a-f]{32}$` (the `emp-asset` protocol id check).
    pub fn parse(s: &str) -> Result<Self> {
        hex_decode_array::<BLOB_NAME_BYTES>(s)
            .map(|_| Self(s.to_owned()))
            .ok_or(CryptoError::Malformed("blob name"))
    }

    /// The 32-character name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Relative storage path `assets/<first 2 hex>/<blob_name>`.
    #[must_use]
    pub fn relative_path(&self) -> String {
        let prefix = self.0.get(..2).unwrap_or("00");
        format!("assets/{prefix}/{}", self.0)
    }
}

impl fmt::Debug for BlobName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BlobName({})", self.0)
    }
}

impl fmt::Display for BlobName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Canonical encoding of `vault_meta` entries for the header MAC: entries sorted by key, each
/// `lp(key) || lp(value)`, prefixed by `"EMP-META-v1" || u32be(count)`.
///
/// The caller chooses which keys are covered; volatile keys (`failed_unlocks`, `lockout_until`, `header_mac`
/// itself) should be left out. Duplicate keys are rejected.
pub fn canonical_vault_meta(entries: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    let mut sorted: Vec<&(&str, &[u8])> = entries.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    if sorted.windows(2).any(|w| matches!(w, [a, b] if a.0 == b.0)) {
        return Err(CryptoError::InvalidArgument("duplicate vault_meta key"));
    }
    let mut out = b"EMP-META-v1".to_vec();
    out.extend_from_slice(
        &u32::try_from(sorted.len())
            .map_err(|_| CryptoError::TooLarge("vault_meta"))?
            .to_be_bytes(),
    );
    for (k, v) in sorted {
        put_lp(&mut out, k.as_bytes())?;
        put_lp(&mut out, v)?;
    }
    Ok(out)
}

fn ct_verify(expected: &[u8; MAC_LEN], got: &[u8]) -> bool {
    got.len() == MAC_LEN && bool::from(expected.as_slice().ct_eq(got))
}

impl VaultKeys {
    /// `h(row)` for one encrypted row. `payload` is the stored envelope bytes (`payload` column).
    pub fn row_hash(
        &self,
        table: TableTag,
        id: &str,
        extra: &Extra,
        rev: u64,
        payload: &[u8],
    ) -> Result<RowHash> {
        let mut msg = Vec::with_capacity(64 + id.len() + extra.as_bytes().len());
        msg.push(table.as_u8());
        put_lp(&mut msg, id.as_bytes())?;
        put_lp(&mut msg, extra.as_bytes())?;
        msg.extend_from_slice(&rev.to_be_bytes());
        msg.extend_from_slice(&sha256(payload));
        Ok(RowHash(hmac(self.manifest.expose(), &[&msg])?))
    }

    /// `state_mac` over the write counter, the multiset root and `SHA-256(canonical keyslots)`
    /// (see [`crate::keyslot::canonical_keyslots_digest`]).
    pub fn state_mac(
        &self,
        write_counter: u64,
        root: &MsetRoot,
        keyslots_digest: &[u8; 32],
    ) -> Result<[u8; MAC_LEN]> {
        hmac(
            self.manifest.expose(),
            &[
                b"EMP-STATE-v1",
                self.vault_id.as_bytes(),
                &write_counter.to_be_bytes(),
                &root.0,
                keyslots_digest,
            ],
        )
    }

    /// Constant-time check of a stored `vault_state.state_mac`.
    pub fn verify_state_mac(
        &self,
        write_counter: u64,
        root: &MsetRoot,
        keyslots_digest: &[u8; 32],
        stored: &[u8],
    ) -> Result<bool> {
        Ok(ct_verify(
            &self.state_mac(write_counter, root, keyslots_digest)?,
            stored,
        ))
    }

    /// `HMAC(k_header_mac, canonical vault_meta)`; build the input with [`canonical_vault_meta`].
    pub fn header_mac(&self, canonical_meta: &[u8]) -> Result<[u8; MAC_LEN]> {
        hmac(self.header_mac.expose(), &[canonical_meta])
    }

    /// Constant-time check of `vault_meta.header_mac`.
    pub fn verify_header_mac(&self, canonical_meta: &[u8], stored: &[u8]) -> Result<bool> {
        Ok(ct_verify(&self.header_mac(canonical_meta)?, stored))
    }

    /// Keyed blob name from the SHA-256 of the plaintext content.
    pub fn blob_name(&self, content_sha256: &[u8; 32]) -> Result<BlobName> {
        let mac = hmac(self.blob_id.expose(), &[content_sha256])?;
        let head = mac.get(..BLOB_NAME_BYTES).ok_or(CryptoError::Internal)?;
        Ok(BlobName(hex_encode(head)))
    }

    /// Blind index: `HMAC(k_blind, lp(domain) || data)`, hex. Use for remote ids and cache keys that must be
    /// looked up without being stored in the clear. `domain` separates uses (e.g. `"gcal-event"`).
    pub fn blind_index(&self, domain: &str, data: &[u8]) -> Result<String> {
        let mut d = Vec::with_capacity(4 + domain.len());
        put_lp(&mut d, domain.as_bytes())?;
        Ok(hex_encode(&hmac(self.blind.expose(), &[&d, data])?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::test_support::fixed_keys;

    #[test]
    fn row_hash_binds_every_field() {
        let k = fixed_keys(1);
        let base = k
            .row_hash(TableTag::Pages, "id", &Extra::none(), 1, b"payload")
            .unwrap();
        assert_eq!(
            base,
            k.row_hash(TableTag::Pages, "id", &Extra::none(), 1, b"payload")
                .unwrap()
        );
        let variants = [
            k.row_hash(TableTag::DbRows, "id", &Extra::none(), 1, b"payload")
                .unwrap(),
            k.row_hash(TableTag::Pages, "id2", &Extra::none(), 1, b"payload")
                .unwrap(),
            k.row_hash(
                TableTag::Pages,
                "id",
                &Extra::kv("a", "b").unwrap(),
                1,
                b"payload",
            )
            .unwrap(),
            k.row_hash(TableTag::Pages, "id", &Extra::none(), 2, b"payload")
                .unwrap(),
            k.row_hash(TableTag::Pages, "id", &Extra::none(), 1, b"payloae")
                .unwrap(),
            fixed_keys(2)
                .row_hash(TableTag::Pages, "id", &Extra::none(), 1, b"payload")
                .unwrap(),
        ];
        for v in variants {
            assert_ne!(v, base);
        }
    }

    #[test]
    fn row_hash_matches_spec_layout() {
        let k = fixed_keys(1);
        let mut msg = vec![2u8];
        msg.extend_from_slice(&[0, 0, 0, 2, b'i', b'd', 0, 0, 0, 0]);
        msg.extend_from_slice(&5u64.to_be_bytes());
        msg.extend_from_slice(&sha256(b"p"));
        let mut m =
            <HmacSha256 as Mac>::new_from_slice(&k.subkey_bytes("emp/v1/manifest").unwrap())
                .unwrap();
        m.update(&msg);
        let want: [u8; 32] = m.finalize().into_bytes().into();
        assert_eq!(
            k.row_hash(TableTag::Pages, "id", &Extra::none(), 5, b"p")
                .unwrap()
                .0,
            want
        );
    }

    #[test]
    fn mset_incremental_equals_full() {
        let k = fixed_keys(1);
        let h: Vec<RowHash> = (0..10)
            .map(|i| {
                k.row_hash(TableTag::DbRows, &format!("r{i}"), &Extra::none(), 0, b"x")
                    .unwrap()
            })
            .collect();
        let mut inc = MsetRoot::EMPTY;
        for x in &h {
            inc.insert(x);
        }
        assert_eq!(inc, MsetRoot::from_hashes(h.iter().rev()));
        // Update r3, delete r7.
        let new3 = k
            .row_hash(TableTag::DbRows, "r3", &Extra::none(), 1, b"y")
            .unwrap();
        inc.replace(&h[3], &new3);
        inc.remove(&h[7]);
        let mut expected: Vec<RowHash> = h.clone();
        expected[3] = new3;
        expected.remove(7);
        assert!(inc.ct_eq(&MsetRoot::from_hashes(&expected)));
        // Deleting a row is detected.
        expected.remove(0);
        assert_ne!(inc, MsetRoot::from_hashes(&expected));
        assert_eq!(MsetRoot::from_slice(inc.as_bytes()).unwrap(), inc);
        assert!(MsetRoot::from_slice(&[0; 31]).is_err());
    }

    #[test]
    fn state_mac_sensitivity() {
        let k = fixed_keys(1);
        let root = MsetRoot::from_hashes(&[k
            .row_hash(TableTag::Pages, "a", &Extra::none(), 0, b"x")
            .unwrap()]);
        let mac = k.state_mac(10, &root, &[7; 32]).unwrap();
        assert!(k.verify_state_mac(10, &root, &[7; 32], &mac).unwrap());
        // Rollback (older counter), other root, other keyslots, other vault/key.
        assert!(!k.verify_state_mac(9, &root, &[7; 32], &mac).unwrap());
        assert!(
            !k.verify_state_mac(10, &MsetRoot::EMPTY, &[7; 32], &mac)
                .unwrap()
        );
        assert!(!k.verify_state_mac(10, &root, &[8; 32], &mac).unwrap());
        assert!(
            !fixed_keys(2)
                .verify_state_mac(10, &root, &[7; 32], &mac)
                .unwrap()
        );
        assert!(!k.verify_state_mac(10, &root, &[7; 32], &mac[..31]).unwrap());
    }

    #[test]
    fn header_mac() {
        let k = fixed_keys(1);
        let a = canonical_vault_meta(&[("vault_id", &[1u8; 16]), ("encryption", b"on")]).unwrap();
        let b = canonical_vault_meta(&[("encryption", b"on"), ("vault_id", &[1u8; 16])]).unwrap();
        assert_eq!(a, b);
        let mac = k.header_mac(&a).unwrap();
        assert!(k.verify_header_mac(&b, &mac).unwrap());
        let c = canonical_vault_meta(&[("encryption", b"off"), ("vault_id", &[1u8; 16])]).unwrap();
        assert!(!k.verify_header_mac(&c, &mac).unwrap());
        assert!(canonical_vault_meta(&[("a", b"1"), ("a", b"2")]).is_err());
        // The header MAC key differs from the manifest key.
        assert_ne!(
            k.header_mac(b"x").unwrap(),
            hmac(k.manifest.expose(), &[b"x"]).unwrap()
        );
    }

    #[test]
    fn blob_names() {
        let k = fixed_keys(1);
        let n = k.blob_name(&sha256(b"image bytes")).unwrap();
        assert_eq!(n.as_str().len(), 32);
        assert_eq!(BlobName::parse(n.as_str()).unwrap(), n);
        assert_eq!(n, k.blob_name(&sha256(b"image bytes")).unwrap());
        assert_ne!(n, k.blob_name(&sha256(b"other")).unwrap());
        // Keyed: another vault names the same content differently.
        assert_ne!(n, fixed_keys(2).blob_name(&sha256(b"image bytes")).unwrap());
        assert!(
            n.relative_path()
                .starts_with(&format!("assets/{}/", &n.as_str()[..2]))
        );
        for bad in [
            "",
            "abc",
            &"A".repeat(32),
            &"g".repeat(32),
            &"a".repeat(33),
            "../../etc/passwd000000000000000",
        ] {
            assert!(BlobName::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn blind_index_domains() {
        let k = fixed_keys(1);
        let a = k.blind_index("gcal-event", b"abc").unwrap();
        assert_eq!(a.len(), 64);
        assert_eq!(a, k.blind_index("gcal-event", b"abc").unwrap());
        assert_ne!(a, k.blind_index("gcal-cal", b"abc").unwrap());
        assert_ne!(
            k.blind_index("ab", b"c").unwrap(),
            k.blind_index("a", b"bc").unwrap()
        );
    }

    #[test]
    fn content_hasher() {
        let mut h = ContentHasher::new();
        h.update(b"hello ");
        h.update(b"world");
        assert_eq!(h.finalize(), sha256(b"hello world"));
    }
}
