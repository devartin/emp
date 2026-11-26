//! Record envelope, `enc = 1` (SPEC §9.5, D-03, D-04, D-05).
//!
//! ```text
//! envelope = header[4] || nonce[24] || ciphertext || tag[16]
//! header   = u8 version(0x01) || u8 flags(bit0 zstd, bit1 padded) || u16le key_epoch
//! aad      = "EMP-REC-v1" || vault_id[16] || u8 table_tag || lp(id) || lp(kind) || u64be(rev) || header[0..4] || lp(extra)
//! inner    = u8 inner_flags || u32be unpadded_len || body || zero padding (PADMÉ to total length)
//! ```
//!
//! * `inner_flags` mirrors `flags` (bits 0–1) inside the ciphertext; any mismatch is rejected.
//! * `unpadded_len` is the length of `body` as stored (i.e. after compression).
//! * With the padded flag, `len(inner) = padme(5 + unpadded_len)` and the padding must be all zero.
//! * A fresh 24-byte random nonce is drawn for every seal, including re-saves.
//! * Compression: zstd level 3 when the body is over 1 KiB and the table is not `secrets`; the compressed form is
//!   kept only when it is actually smaller (the flag records which form was stored).
//! * Decrypt order: structural length → key epoch → **tag** → version and flags → `unpadded_len ≤ padded_len` →
//!   padding → decompression (bounded). Every failure is a typed [`CryptoError`].

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{Tag, XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::codec::{lp, put_lp};
use crate::error::{CryptoError, Result};
use crate::keys::{KEY_LEN, VaultId, VaultKeys};
use crate::pad::padme_usize;
use crate::rng;

/// Envelope format version written by this build.
pub const ENVELOPE_VERSION: u8 = 0x01;
/// Header length.
pub const HEADER_LEN: usize = 4;
/// XChaCha20 nonce length.
pub const NONCE_LEN: usize = 24;
/// Poly1305 tag length.
pub const TAG_LEN: usize = 16;
/// Fixed envelope overhead before padding: header + nonce + inner prefix (5) + tag.
pub const ENVELOPE_OVERHEAD: usize = HEADER_LEN + NONCE_LEN + INNER_PREFIX_LEN + TAG_LEN;
/// Header flag: body is zstd-compressed.
pub const FLAG_ZSTD: u8 = 0b01;
/// Header flag: inner is PADMÉ-padded.
pub const FLAG_PADDED: u8 = 0b10;
/// Bodies larger than this are compressed (unless the table is `secrets`).
pub const COMPRESS_THRESHOLD: usize = 1024;
/// zstd level.
pub const ZSTD_LEVEL: i32 = 3;
/// Maximum plaintext body size (before compression on seal, after decompression on open): 64 MiB.
pub const MAX_RECORD_BODY: usize = 64 * 1024 * 1024;

const AAD_DOMAIN: &[u8] = b"EMP-REC-v1";
const INNER_PREFIX_LEN: usize = 5;
const KNOWN_FLAGS: u8 = FLAG_ZSTD | FLAG_PADDED;

/// The `table_tag` of every encrypted table (SPEC §9.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
#[allow(missing_docs)]
pub enum TableTag {
    Workspaces = 1,
    Pages = 2,
    PageDocs = 3,
    /// P1.
    SyncedBlocks = 4,
    /// P1.
    Comments = 5,
    Databases = 6,
    DbProperties = 7,
    DbRows = 8,
    DbViews = 9,
    Workbooks = 10,
    Sheets = 11,
    SheetBands = 12,
    Assets = 13,
    Versions = 14,
    Settings = 15,
    Secrets = 16,
    Kv = 17,
    SyncLinks = 18,
    Outbox = 19,
    Reminders = 20,
    LifeappInstances = 21,
    SecurityLog = 22,
    Watchlists = 23,
}

impl TableTag {
    /// Every tag, in numeric order.
    pub const ALL: [TableTag; 23] = [
        Self::Workspaces,
        Self::Pages,
        Self::PageDocs,
        Self::SyncedBlocks,
        Self::Comments,
        Self::Databases,
        Self::DbProperties,
        Self::DbRows,
        Self::DbViews,
        Self::Workbooks,
        Self::Sheets,
        Self::SheetBands,
        Self::Assets,
        Self::Versions,
        Self::Settings,
        Self::Secrets,
        Self::Kv,
        Self::SyncLinks,
        Self::Outbox,
        Self::Reminders,
        Self::LifeappInstances,
        Self::SecurityLog,
        Self::Watchlists,
    ];

    /// The numeric tag.
    #[must_use]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    /// Parses a numeric tag.
    pub fn from_u8(v: u8) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|t| t.as_u8() == v)
            .ok_or(CryptoError::Malformed("table tag"))
    }

    /// The SQLite table name.
    #[must_use]
    pub const fn table_name(self) -> &'static str {
        match self {
            Self::Workspaces => "workspaces",
            Self::Pages => "pages",
            Self::PageDocs => "page_docs",
            Self::SyncedBlocks => "synced_blocks",
            Self::Comments => "comments",
            Self::Databases => "databases",
            Self::DbProperties => "db_properties",
            Self::DbRows => "db_rows",
            Self::DbViews => "db_views",
            Self::Workbooks => "workbooks",
            Self::Sheets => "sheets",
            Self::SheetBands => "sheet_bands",
            Self::Assets => "assets",
            Self::Versions => "versions",
            Self::Settings => "settings",
            Self::Secrets => "secrets",
            Self::Kv => "kv",
            Self::SyncLinks => "sync_links",
            Self::Outbox => "outbox",
            Self::Reminders => "reminders",
            Self::LifeappInstances => "lifeapp_instances",
            Self::SecurityLog => "security_log",
            Self::Watchlists => "watchlists",
        }
    }

    /// Looks a tag up by SQLite table name.
    pub fn from_table_name(name: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|t| t.table_name() == name)
            .ok_or(CryptoError::Malformed("table name"))
    }

    /// Whether rows of this table must bind a composite key through `extra`.
    #[must_use]
    pub const fn requires_extra(self) -> bool {
        matches!(self, Self::SheetBands | Self::Settings | Self::Kv)
    }
}

/// The `extra` AAD component binding composite keys (SPEC §9.5). Empty for most tables.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Extra(Vec<u8>);

impl Extra {
    /// No composite key (every table except `sheet_bands`, `settings`, `kv`).
    #[must_use]
    pub fn none() -> Self {
        Self(Vec::new())
    }

    /// `sheet_bands`: `lp(sheet_id) ‖ u32be(band)`.
    pub fn sheet_band(sheet_id: &str, band: u32) -> Result<Self> {
        let mut v = lp(sheet_id.as_bytes())?;
        v.extend_from_slice(&band.to_be_bytes());
        Ok(Self(v))
    }

    /// `settings`: `lp(scope) ‖ lp(key)`.
    pub fn setting(scope: &str, key: &str) -> Result<Self> {
        let mut v = lp(scope.as_bytes())?;
        put_lp(&mut v, key.as_bytes())?;
        Ok(Self(v))
    }

    /// `kv`: `lp(ns) ‖ lp(key)`.
    pub fn kv(ns: &str, key: &str) -> Result<Self> {
        Self::setting(ns, key)
    }

    /// The encoded bytes (the value inside the outer `lp(extra)`).
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// `true` if empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Where a record lives: everything bound into its AAD besides the vault id and header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordAad<'a> {
    /// Table of the row.
    pub table: TableTag,
    /// Row id (`TEXT` primary key; for composite-key tables, the logical id or empty string).
    pub id: &'a str,
    /// The row's `kind` column, or `""` when the table has none.
    pub kind: &'a str,
    /// The row's `rev`, or 0 when the table has no `rev` column.
    pub rev: u64,
    /// Composite-key binding.
    pub extra: Extra,
}

impl<'a> RecordAad<'a> {
    /// A locator with no `extra`.
    #[must_use]
    pub fn new(table: TableTag, id: &'a str, kind: &'a str, rev: u64) -> Self {
        Self {
            table,
            id,
            kind,
            rev,
            extra: Extra::none(),
        }
    }

    /// Sets the composite-key binding.
    #[must_use]
    pub fn with_extra(mut self, extra: Extra) -> Self {
        self.extra = extra;
        self
    }

    fn check(&self) -> Result<()> {
        if self.table.requires_extra() && self.extra.is_empty() {
            return Err(CryptoError::InvalidArgument(
                "this table requires a composite-key `extra`",
            ));
        }
        Ok(())
    }

    /// Builds the exact D-04 AAD for `header`.
    pub fn to_bytes(&self, vault_id: &VaultId, header: &[u8; HEADER_LEN]) -> Result<Vec<u8>> {
        let mut aad = Vec::with_capacity(
            AAD_DOMAIN.len()
                + 16
                + 1
                + 4
                + self.id.len()
                + 4
                + self.kind.len()
                + 8
                + 4
                + 4
                + self.extra.0.len(),
        );
        aad.extend_from_slice(AAD_DOMAIN);
        aad.extend_from_slice(vault_id.as_bytes());
        aad.push(self.table.as_u8());
        put_lp(&mut aad, self.id.as_bytes())?;
        put_lp(&mut aad, self.kind.as_bytes())?;
        aad.extend_from_slice(&self.rev.to_be_bytes());
        aad.extend_from_slice(header);
        put_lp(&mut aad, &self.extra.0)?;
        Ok(aad)
    }
}

/// Compression policy for [`VaultKeys::seal_record_with`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Compression {
    /// zstd level 3 when the body is over 1 KiB and the table is not `secrets` (SPEC default).
    #[default]
    Auto,
    /// Never compress.
    Never,
}

/// Options for [`VaultKeys::seal_record_with`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SealOptions {
    /// Compression policy.
    pub compression: Compression,
    /// PADMÉ-pad the inner plaintext (SPEC default: on).
    pub pad: bool,
}

impl Default for SealOptions {
    fn default() -> Self {
        Self {
            compression: Compression::Auto,
            pad: true,
        }
    }
}

/// Parsed envelope header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvelopeHeader {
    /// Format version.
    pub version: u8,
    /// Flags (`FLAG_ZSTD`, `FLAG_PADDED`).
    pub flags: u8,
    /// DEK epoch the record was sealed under.
    pub key_epoch: u16,
}

impl EnvelopeHeader {
    /// Encodes the 4 header bytes.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let e = self.key_epoch.to_le_bytes();
        [self.version, self.flags, e[0], e[1]]
    }

    /// Reads the (unauthenticated) header of an envelope, e.g. to pick the key epoch before opening.
    pub fn peek(envelope: &[u8]) -> Result<Self> {
        if envelope.len() < HEADER_LEN + NONCE_LEN + INNER_PREFIX_LEN + TAG_LEN {
            return Err(CryptoError::Malformed("envelope"));
        }
        let h: [u8; HEADER_LEN] = envelope
            .get(..HEADER_LEN)
            .and_then(|s| s.try_into().ok())
            .ok_or(CryptoError::Malformed("envelope"))?;
        let [version, flags, e0, e1] = h;
        Ok(Self {
            version,
            flags,
            key_epoch: u16::from_le_bytes([e0, e1]),
        })
    }
}

fn cipher(key: &[u8; KEY_LEN]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

pub(crate) fn seal_inner(
    key: &[u8; KEY_LEN],
    vault_id: &VaultId,
    epoch: u16,
    loc: &RecordAad<'_>,
    body: &[u8],
    opts: SealOptions,
    nonce: [u8; NONCE_LEN],
) -> Result<Vec<u8>> {
    loc.check()?;
    if body.len() > MAX_RECORD_BODY {
        return Err(CryptoError::TooLarge("record body"));
    }
    let compressed: Option<Zeroizing<Vec<u8>>> = if opts.compression == Compression::Auto
        && loc.table != TableTag::Secrets
        && body.len() > COMPRESS_THRESHOLD
    {
        let c = Zeroizing::new(
            zstd::bulk::compress(body, ZSTD_LEVEL).map_err(|_| CryptoError::Compression)?,
        );
        (c.len() < body.len()).then_some(c)
    } else {
        None
    };
    let stored: &[u8] = compressed.as_deref().map_or(body, |c| c.as_slice());
    let mut flags = 0u8;
    if compressed.is_some() {
        flags |= FLAG_ZSTD;
    }
    if opts.pad {
        flags |= FLAG_PADDED;
    }
    let unpadded = INNER_PREFIX_LEN + stored.len();
    let inner_len = if opts.pad {
        padme_usize(unpadded).ok_or(CryptoError::TooLarge("record body"))?
    } else {
        unpadded
    };
    let stored_len =
        u32::try_from(stored.len()).map_err(|_| CryptoError::TooLarge("record body"))?;

    let header = EnvelopeHeader {
        version: ENVELOPE_VERSION,
        flags,
        key_epoch: epoch,
    }
    .to_bytes();
    let aad = loc.to_bytes(vault_id, &header)?;

    // Build header || nonce || inner in one buffer, encrypt the inner part in place, then append the tag.
    // The buffer holds plaintext until encryption, so it is zeroizing; the final ciphertext is moved out.
    let mut out = Zeroizing::new(Vec::with_capacity(
        HEADER_LEN + NONCE_LEN + inner_len + TAG_LEN,
    ));
    out.extend_from_slice(&header);
    out.extend_from_slice(&nonce);
    out.push(flags);
    out.extend_from_slice(&stored_len.to_be_bytes());
    out.extend_from_slice(stored);
    out.resize(HEADER_LEN + NONCE_LEN + inner_len, 0);
    let inner = out
        .get_mut(HEADER_LEN + NONCE_LEN..)
        .ok_or(CryptoError::Internal)?;
    let tag = cipher(key)
        .encrypt_in_place_detached(XNonce::from_slice(&nonce), &aad, inner)
        .map_err(|_| CryptoError::Internal)?;
    out.extend_from_slice(&tag);
    Ok(std::mem::take(&mut *out))
}

pub(crate) fn open_inner(
    key: &[u8; KEY_LEN],
    vault_id: &VaultId,
    epoch: u16,
    loc: &RecordAad<'_>,
    envelope: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    loc.check()?;
    let hdr = EnvelopeHeader::peek(envelope)?;
    if hdr.key_epoch != epoch {
        return Err(CryptoError::KeyEpochMismatch {
            found: hdr.key_epoch,
            expected: epoch,
        });
    }
    let header = hdr.to_bytes();
    let (head, tag) = envelope
        .split_at_checked(envelope.len() - TAG_LEN)
        .ok_or(CryptoError::Malformed("envelope"))?;
    let nonce = head
        .get(HEADER_LEN..HEADER_LEN + NONCE_LEN)
        .ok_or(CryptoError::Malformed("envelope"))?;
    let ct = head
        .get(HEADER_LEN + NONCE_LEN..)
        .ok_or(CryptoError::Malformed("envelope"))?;
    let aad = loc.to_bytes(vault_id, &header)?;

    // 1. Tag.
    let mut inner = Zeroizing::new(ct.to_vec());
    cipher(key)
        .decrypt_in_place_detached(
            XNonce::from_slice(nonce),
            &aad,
            inner.as_mut_slice(),
            Tag::from_slice(tag),
        )
        .map_err(|_| CryptoError::AuthFailed)?;

    // 2. Version and flags.
    if hdr.version != ENVELOPE_VERSION {
        return Err(CryptoError::UnsupportedVersion {
            what: "envelope",
            version: u16::from(hdr.version),
        });
    }
    if hdr.flags & !KNOWN_FLAGS != 0 {
        return Err(CryptoError::Malformed("envelope flags"));
    }
    let mut r = crate::codec::Reader::new(&inner, "envelope inner");
    let inner_flags = r.u8()?;
    if inner_flags != hdr.flags {
        return Err(CryptoError::Malformed("envelope inner flags"));
    }
    let compressed = hdr.flags & FLAG_ZSTD != 0;
    if compressed && loc.table == TableTag::Secrets {
        return Err(CryptoError::Malformed("compressed secret"));
    }

    // 3. Lengths.
    let unpadded_len =
        usize::try_from(r.u32be()?).map_err(|_| CryptoError::Malformed("envelope inner"))?;
    let padded_len = r.remaining();
    if unpadded_len > padded_len {
        return Err(CryptoError::Malformed("envelope length"));
    }
    let body = r.take(unpadded_len)?;
    let padding = r.take(padded_len - unpadded_len)?;
    if hdr.flags & FLAG_PADDED != 0 {
        if padme_usize(INNER_PREFIX_LEN + unpadded_len) != Some(inner.len()) {
            return Err(CryptoError::Malformed("envelope padding"));
        }
        if padding.iter().any(|&b| b != 0) {
            return Err(CryptoError::Malformed("envelope padding"));
        }
    } else if !padding.is_empty() {
        return Err(CryptoError::Malformed("envelope padding"));
    }

    // 4. Body.
    if compressed {
        let out =
            zstd::bulk::decompress(body, MAX_RECORD_BODY).map_err(|_| CryptoError::Compression)?;
        Ok(Zeroizing::new(out))
    } else {
        Ok(Zeroizing::new(body.to_vec()))
    }
}

impl VaultKeys {
    fn record_key(&self, table: TableTag) -> &[u8; KEY_LEN] {
        if table == TableTag::Secrets {
            self.secrets.expose()
        } else {
            self.records.expose()
        }
    }

    /// Seals a record payload with the SPEC defaults (auto compression, PADMÉ padding).
    ///
    /// Uses `k_secrets` for [`TableTag::Secrets`] and `k_records` for everything else.
    pub fn seal_record(&self, loc: &RecordAad<'_>, body: &[u8]) -> Result<Vec<u8>> {
        self.seal_record_with(loc, body, SealOptions::default())
    }

    /// Seals a record payload with explicit options.
    pub fn seal_record_with(
        &self,
        loc: &RecordAad<'_>,
        body: &[u8],
        opts: SealOptions,
    ) -> Result<Vec<u8>> {
        let nonce = rng::array::<NONCE_LEN>()?;
        seal_inner(
            self.record_key(loc.table),
            &self.vault_id,
            self.epoch,
            loc,
            body,
            opts,
            nonce,
        )
    }

    /// Opens a record envelope, verifying it belongs at `loc`. Returns the plaintext body in a zeroizing buffer.
    ///
    /// A failure here is a damaged item (SPEC §9.8); never fall back to treating the payload as plaintext.
    pub fn open_record(&self, loc: &RecordAad<'_>, envelope: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        open_inner(
            self.record_key(loc.table),
            &self.vault_id,
            self.epoch,
            loc,
            envelope,
        )
    }

    #[cfg(test)]
    pub(crate) fn seal_record_with_nonce(
        &self,
        loc: &RecordAad<'_>,
        body: &[u8],
        opts: SealOptions,
        nonce: [u8; NONCE_LEN],
    ) -> Result<Vec<u8>> {
        seal_inner(
            self.record_key(loc.table),
            &self.vault_id,
            self.epoch,
            loc,
            body,
            opts,
            nonce,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::test_support::{fixed_dek, fixed_keys};
    use proptest::prelude::*;

    fn loc() -> RecordAad<'static> {
        RecordAad::new(
            TableTag::Pages,
            "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
            "doc",
            7,
        )
    }

    #[test]
    fn roundtrip_small_and_large() {
        let k = fixed_keys(1);
        for body in [
            b"".to_vec(),
            b"{\"v\":1}".to_vec(),
            vec![b'a'; 5000],
            (0..=255u8).cycle().take(3000).collect(),
        ] {
            let env = k.seal_record(&loc(), &body).unwrap();
            assert_eq!(
                k.open_record(&loc(), &env).unwrap().as_slice(),
                body.as_slice()
            );
        }
    }

    #[test]
    fn compression_and_padding_flags() {
        let k = fixed_keys(1);
        let compressible = vec![b'x'; 10_000];
        let env = k.seal_record(&loc(), &compressible).unwrap();
        let h = EnvelopeHeader::peek(&env).unwrap();
        assert_eq!(h.flags, FLAG_ZSTD | FLAG_PADDED);
        assert!(env.len() < 1000);

        // ≤ 1 KiB: never compressed.
        let env = k.seal_record(&loc(), &[b'x'; 1024]).unwrap();
        assert_eq!(EnvelopeHeader::peek(&env).unwrap().flags, FLAG_PADDED);

        // Secrets: never compressed.
        let sl = RecordAad::new(TableTag::Secrets, "secret:abc", "", 0);
        let env = k.seal_record(&sl, &compressible).unwrap();
        assert_eq!(EnvelopeHeader::peek(&env).unwrap().flags, FLAG_PADDED);
        assert_eq!(
            k.open_record(&sl, &env).unwrap().as_slice(),
            compressible.as_slice()
        );

        // No padding, no compression.
        let opts = SealOptions {
            compression: Compression::Never,
            pad: false,
        };
        let env = k.seal_record_with(&loc(), &compressible, opts).unwrap();
        assert_eq!(EnvelopeHeader::peek(&env).unwrap().flags, 0);
        assert_eq!(env.len(), compressible.len() + ENVELOPE_OVERHEAD);
        assert_eq!(
            k.open_record(&loc(), &env).unwrap().as_slice(),
            compressible.as_slice()
        );
    }

    #[test]
    fn padded_size_is_padme() {
        let k = fixed_keys(1);
        let opts = SealOptions {
            compression: Compression::Never,
            pad: true,
        };
        for n in [0usize, 1, 100, 1000, 4097, 70_000] {
            let env = k.seal_record_with(&loc(), &vec![7u8; n], opts).unwrap();
            assert_eq!(
                env.len(),
                HEADER_LEN + NONCE_LEN + padme_usize(5 + n).unwrap() + TAG_LEN
            );
        }
    }

    #[test]
    fn fresh_nonce_every_seal() {
        let k = fixed_keys(1);
        let a = k.seal_record(&loc(), b"same").unwrap();
        let b = k.seal_record(&loc(), b"same").unwrap();
        assert_ne!(
            a[HEADER_LEN..HEADER_LEN + NONCE_LEN],
            b[HEADER_LEN..HEADER_LEN + NONCE_LEN]
        );
        assert_ne!(a, b);
    }

    #[test]
    fn every_bit_flip_detected() {
        let k = fixed_keys(1);
        let env = k.seal_record(&loc(), b"{\"title\":\"hello\"}").unwrap();
        for i in 0..env.len() {
            for bit in 0..8 {
                let mut t = env.clone();
                t[i] ^= 1 << bit;
                let r = k.open_record(&loc(), &t);
                assert!(r.is_err(), "flip at byte {i} bit {bit} not detected");
                if (2..4).contains(&i) {
                    assert!(matches!(r, Err(CryptoError::KeyEpochMismatch { .. })));
                } else {
                    assert_eq!(r, Err(CryptoError::AuthFailed), "byte {i}");
                }
            }
        }
        // Truncation / extension.
        for n in 0..env.len() {
            assert!(k.open_record(&loc(), &env[..n]).is_err());
        }
        let mut longer = env.clone();
        longer.push(0);
        assert!(k.open_record(&loc(), &longer).is_err());
    }

    #[test]
    fn every_aad_component_is_bound() {
        let k = fixed_keys(1);
        let base = RecordAad::new(TableTag::DbRows, "row-1", "row", 3);
        let env = k.seal_record(&base, b"payload").unwrap();
        assert!(k.open_record(&base, &env).is_ok());
        let variants = [
            RecordAad {
                table: TableTag::Pages,
                ..base.clone()
            },
            RecordAad {
                id: "row-2",
                ..base.clone()
            },
            RecordAad {
                id: "row-1 ",
                ..base.clone()
            },
            RecordAad {
                kind: "",
                ..base.clone()
            },
            RecordAad {
                kind: "rowx",
                ..base.clone()
            },
            RecordAad {
                rev: 4,
                ..base.clone()
            },
            RecordAad {
                rev: 2,
                ..base.clone()
            },
            base.clone().with_extra(Extra::kv("a", "b").unwrap()),
        ];
        for v in variants {
            assert_eq!(
                k.open_record(&v, &env),
                Err(CryptoError::AuthFailed),
                "{v:?}"
            );
        }
        // Length-prefixing: moving bytes between id and kind must not collide.
        let a = RecordAad::new(TableTag::DbRows, "ab", "c", 0);
        let b = RecordAad::new(TableTag::DbRows, "a", "bc", 0);
        let env = k.seal_record(&a, b"x").unwrap();
        assert_eq!(k.open_record(&b, &env), Err(CryptoError::AuthFailed));
    }

    #[test]
    fn extra_bound_for_composite_tables() {
        let k = fixed_keys(1);
        let s1 = RecordAad::new(TableTag::Settings, "", "", 0)
            .with_extra(Extra::setting("device", "theme").unwrap());
        let s2 = RecordAad::new(TableTag::Settings, "", "", 0)
            .with_extra(Extra::setting("vault", "theme").unwrap());
        let s3 = RecordAad::new(TableTag::Settings, "", "", 0)
            .with_extra(Extra::setting("devic", "etheme").unwrap());
        let env = k.seal_record(&s1, b"dark").unwrap();
        assert!(k.open_record(&s1, &env).is_ok());
        assert_eq!(k.open_record(&s2, &env), Err(CryptoError::AuthFailed));
        assert_eq!(k.open_record(&s3, &env), Err(CryptoError::AuthFailed));

        let b1 = RecordAad::new(TableTag::SheetBands, "", "", 1)
            .with_extra(Extra::sheet_band("sheet", 0).unwrap());
        let b2 = RecordAad::new(TableTag::SheetBands, "", "", 1)
            .with_extra(Extra::sheet_band("sheet", 1).unwrap());
        let env = k.seal_record(&b1, b"cells").unwrap();
        assert_eq!(k.open_record(&b2, &env), Err(CryptoError::AuthFailed));

        // Composite tables refuse a missing extra.
        let missing = RecordAad::new(TableTag::Kv, "", "", 0);
        assert!(matches!(
            k.seal_record(&missing, b"x"),
            Err(CryptoError::InvalidArgument(_))
        ));
    }

    #[test]
    fn swap_vault_and_key() {
        let k = fixed_keys(1);
        let env = k.seal_record(&loc(), b"x").unwrap();
        // Same DEK, other vault id.
        let other_vault =
            VaultKeys::derive(&fixed_dek(1, 1), &VaultId::from_bytes([0x99; 16])).unwrap();
        assert_eq!(
            other_vault.open_record(&loc(), &env),
            Err(CryptoError::AuthFailed)
        );
        // Other DEK.
        assert_eq!(
            fixed_keys(2).open_record(&loc(), &env),
            Err(CryptoError::AuthFailed)
        );
        // Secrets use a different subkey: a records envelope does not open as a secret even with matching AAD bits.
        let sl = RecordAad::new(TableTag::Secrets, "x", "", 0);
        let env = k.seal_record(&sl, b"x").unwrap();
        let as_records = open_inner(k.records.expose(), &k.vault_id, 1, &sl, &env);
        assert_eq!(as_records, Err(CryptoError::AuthFailed));
    }

    #[test]
    fn epoch_mismatch_is_typed() {
        let k = fixed_keys(1);
        let env = k.seal_record(&loc(), b"x").unwrap();
        let k2 = VaultKeys::derive(&fixed_dek(1, 2), &VaultId::from_bytes([0x11; 16])).unwrap();
        assert_eq!(
            k2.open_record(&loc(), &env),
            Err(CryptoError::KeyEpochMismatch {
                found: 1,
                expected: 2
            })
        );
    }

    /// Crafts envelopes whose tag verifies but whose inner structure is invalid, to check post-tag validation.
    fn craft(k: &VaultKeys, header: [u8; 4], inner: &[u8]) -> Vec<u8> {
        let nonce = [5u8; NONCE_LEN];
        let aad = loc().to_bytes(&k.vault_id, &header).unwrap();
        let mut buf = inner.to_vec();
        let tag = cipher(k.records.expose())
            .encrypt_in_place_detached(XNonce::from_slice(&nonce), &aad, &mut buf)
            .unwrap();
        let mut out = header.to_vec();
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&buf);
        out.extend_from_slice(&tag);
        out
    }

    #[test]
    fn post_tag_validation() {
        let k = fixed_keys(1);
        let ok_inner = [0u8, 0, 0, 0, 1, b'x'];
        assert_eq!(
            k.open_record(&loc(), &craft(&k, [1, 0, 1, 0], &ok_inner))
                .unwrap()
                .as_slice(),
            b"x"
        );
        // Unknown version.
        assert!(matches!(
            k.open_record(&loc(), &craft(&k, [2, 0, 1, 0], &ok_inner)),
            Err(CryptoError::UnsupportedVersion { .. })
        ));
        // Unknown flag bit.
        let bad_flag_inner = [4u8, 0, 0, 0, 1, b'x'];
        assert!(
            k.open_record(&loc(), &craft(&k, [1, 4, 1, 0], &bad_flag_inner))
                .is_err()
        );
        // Inner flags disagree with header.
        assert!(
            k.open_record(&loc(), &craft(&k, [1, 0, 1, 0], &[2u8, 0, 0, 0, 1, b'x']))
                .is_err()
        );
        // unpadded_len > padded_len.
        assert_eq!(
            k.open_record(&loc(), &craft(&k, [1, 0, 1, 0], &[0u8, 0, 0, 0, 9, b'x'])),
            Err(CryptoError::Malformed("envelope length"))
        );
        // Unpadded record with trailing bytes.
        assert!(
            k.open_record(
                &loc(),
                &craft(&k, [1, 0, 1, 0], &[0u8, 0, 0, 0, 1, b'x', 0])
            )
            .is_err()
        );
        // Padded with wrong padded length (9 bytes; padme(6)=6) or non-zero padding.
        let mut padded = vec![2u8, 0, 0, 0, 1, b'x'];
        padded.resize(9, 0);
        assert!(
            k.open_record(&loc(), &craft(&k, [1, 2, 1, 0], &padded))
                .is_err()
        );
        let mut p = vec![2u8, 0, 0, 0, 9];
        p.extend_from_slice(b"abc");
        p.resize(10, 0); // only 5 bytes follow the prefix
        assert_eq!(
            k.open_record(&loc(), &craft(&k, [1, 2, 1, 0], &p)),
            Err(CryptoError::Malformed("envelope length"))
        );
        let mut p = vec![2u8, 0, 0, 0, 4];
        p.extend_from_slice(b"abcd");
        p.push(1); // non-zero padding
        assert_eq!(
            k.open_record(&loc(), &craft(&k, [1, 2, 1, 0], &p)),
            Err(CryptoError::Malformed("envelope padding"))
        );
        // Compression flag with garbage body.
        assert_eq!(
            k.open_record(
                &loc(),
                &craft(&k, [1, 1, 1, 0], &[1u8, 0, 0, 0, 3, 1, 2, 3])
            ),
            Err(CryptoError::Compression)
        );
        // Empty inner.
        assert!(
            k.open_record(&loc(), &craft(&k, [1, 0, 1, 0], &[]))
                .is_err()
        );
    }

    #[test]
    fn decompression_bomb_rejected() {
        let k = fixed_keys(1);
        let huge = vec![0u8; MAX_RECORD_BODY + 1];
        let z = zstd::bulk::compress(&huge, 3).unwrap();
        let mut inner = vec![1u8];
        inner.extend_from_slice(&(z.len() as u32).to_be_bytes());
        inner.extend_from_slice(&z);
        assert_eq!(
            k.open_record(&loc(), &craft(&k, [1, 1, 1, 0], &inner)),
            Err(CryptoError::Compression)
        );
        // Oversized body on seal.
        assert_eq!(
            k.seal_record(&loc(), &huge),
            Err(CryptoError::TooLarge("record body"))
        );
    }

    #[test]
    fn aad_layout_exact() {
        let vid = VaultId::from_bytes([0xaa; 16]);
        let a = RecordAad::new(TableTag::Kv, "id", "k", 0x0102)
            .with_extra(Extra::kv("n", "key").unwrap());
        let got = a.to_bytes(&vid, &[1, 2, 3, 0]).unwrap();
        let mut want = b"EMP-REC-v1".to_vec();
        want.extend_from_slice(&[0xaa; 16]);
        want.push(17);
        want.extend_from_slice(&[0, 0, 0, 2, b'i', b'd']);
        want.extend_from_slice(&[0, 0, 0, 1, b'k']);
        want.extend_from_slice(&[0, 0, 0, 0, 0, 0, 1, 2]);
        want.extend_from_slice(&[1, 2, 3, 0]);
        want.extend_from_slice(&[0, 0, 0, 12, 0, 0, 0, 1, b'n', 0, 0, 0, 3, b'k', b'e', b'y']);
        assert_eq!(got, want);
        assert_eq!(
            Extra::sheet_band("s", 5).unwrap().as_bytes(),
            &[0, 0, 0, 1, b's', 0, 0, 0, 5]
        );
    }

    #[test]
    fn table_tags() {
        for (i, t) in TableTag::ALL.iter().enumerate() {
            assert_eq!(usize::from(t.as_u8()), i + 1);
            assert_eq!(TableTag::from_u8(t.as_u8()).unwrap(), *t);
            assert_eq!(TableTag::from_table_name(t.table_name()).unwrap(), *t);
        }
        assert!(TableTag::from_u8(0).is_err());
        assert!(TableTag::from_u8(24).is_err());
        assert_eq!(TableTag::Secrets.as_u8(), 16);
        assert_eq!(TableTag::Watchlists.as_u8(), 23);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]
        #[test]
        fn prop_roundtrip(body in proptest::collection::vec(any::<u8>(), 0..4096), id in "[a-z0-9-]{0,40}",
                          kind in "[a-z]{0,8}", rev in any::<u64>(), pad in any::<bool>()) {
            let k = fixed_keys(9);
            let l = RecordAad::new(TableTag::DbRows, &id, &kind, rev);
            let opts = SealOptions { compression: Compression::Auto, pad };
            let env = k.seal_record_with(&l, &body, opts).unwrap();
            let opened = k.open_record(&l, &env).unwrap();
            prop_assert_eq!(opened.as_slice(), body.as_slice());
        }

        #[test]
        fn prop_garbage_never_panics(data in proptest::collection::vec(any::<u8>(), 0..200)) {
            let k = fixed_keys(9);
            prop_assert!(k.open_record(&loc(), &data).is_err());
        }
    }
}
