//! Payload codec: plain canonical JSON (enc = 0) or a sealed record envelope (enc = 1), per vault mode
//! (SPEC §0.1 item 2, §9.5, §10.3).
//!
//! * The **body** of a payload is its JSON (serde struct order). For `versions` the body is additionally
//!   zstd-compressed ("zstd always").
//! * With encryption on, the body is sealed with [`VaultKeys::seal_record`] under the row's [`RecordLoc`]
//!   (table tag, id, kind, rev, composite-key `extra`). `secrets` rows are sealed in every mode.
//! * Readers run an upcast chain on the JSON before deserializing ([`upcast`]); writers always write the latest
//!   version.
//!
//! A row that fails to open is reported as [`StoreError::Damaged`]; it is never treated as plaintext.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use emp_crypto::envelope::{Compression, SealOptions};
use emp_crypto::{Extra, RecordAad, TableTag, VaultKeys, Zeroizing};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{Result, StoreError};

/// zstd level for version snapshots.
pub const VERSION_ZSTD_LEVEL: i32 = 3;
/// Decompression bound (matches `SQLITE_LIMIT_LENGTH`).
pub const MAX_BODY: usize = 64 * 1024 * 1024;

/// Where a record lives: everything bound into its AAD (and integrity hash) besides the vault id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordLoc {
    /// Table.
    pub table: TableTag,
    /// Row id (empty for composite-key tables, whose key is bound through `extra`).
    pub id: String,
    /// The `kind` column (`pages` only) or empty.
    pub kind: String,
    /// The row's `rev` after the write (0 for tables without one).
    pub rev: u64,
    /// Composite-key binding.
    pub extra: Extra,
}

impl RecordLoc {
    /// A row of an id-keyed table.
    #[must_use]
    pub fn new(table: TableTag, id: &str, kind: &str, rev: u64) -> Self {
        Self {
            table,
            id: id.to_owned(),
            kind: kind.to_owned(),
            rev,
            extra: Extra::none(),
        }
    }

    /// A row without `kind`.
    #[must_use]
    pub fn row(table: TableTag, id: &str, rev: u64) -> Self {
        Self::new(table, id, "", rev)
    }

    /// A `sheet_bands` row.
    pub fn sheet_band(sheet_id: &str, band: u32, rev: u64) -> Result<Self> {
        Ok(Self {
            table: TableTag::SheetBands,
            id: String::new(),
            kind: String::new(),
            rev,
            extra: Extra::sheet_band(sheet_id, band)?,
        })
    }

    /// A `settings` row.
    pub fn setting(scope: &str, key: &str) -> Result<Self> {
        Ok(Self {
            table: TableTag::Settings,
            id: String::new(),
            kind: String::new(),
            rev: 0,
            extra: Extra::setting(scope, key)?,
        })
    }

    /// A `kv` row (`key` is the stored key, i.e. already blinded for sensitive namespaces).
    pub fn kv(ns: &str, key: &str) -> Result<Self> {
        Ok(Self {
            table: TableTag::Kv,
            id: String::new(),
            kind: String::new(),
            rev: 0,
            extra: Extra::kv(ns, key)?,
        })
    }

    /// The emp-crypto AAD view.
    #[must_use]
    pub fn aad(&self) -> RecordAad<'_> {
        RecordAad::new(self.table, &self.id, &self.kind, self.rev).with_extra(self.extra.clone())
    }

    fn damaged(&self) -> StoreError {
        StoreError::Damaged {
            table: self.table.table_name(),
            id: if self.id.is_empty() {
                hex::encode(self.extra.as_bytes())
            } else {
                self.id.clone()
            },
        }
    }
}

/// An encoded payload ready for `INSERT`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Encoded {
    /// The `enc` column.
    pub enc: i64,
    /// The `payload` column.
    pub payload: Vec<u8>,
}

/// Encodes and decodes payloads for one unlocked session.
pub struct Codec {
    keys: Arc<VaultKeys>,
    encrypt: AtomicBool,
}

impl std::fmt::Debug for Codec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Codec")
            .field("encrypt", &self.encrypting())
            .finish_non_exhaustive()
    }
}

impl Codec {
    /// A codec over `keys`; new writes are sealed when `encrypt` is set.
    #[must_use]
    pub fn new(keys: Arc<VaultKeys>, encrypt: bool) -> Self {
        Self {
            keys,
            encrypt: AtomicBool::new(encrypt),
        }
    }

    /// Whether new writes are sealed.
    #[must_use]
    pub fn encrypting(&self) -> bool {
        self.encrypt.load(Ordering::SeqCst)
    }

    /// Switches the mode for new writes (encryption on/off jobs).
    pub fn set_encrypting(&self, on: bool) {
        self.encrypt.store(on, Ordering::SeqCst);
    }

    /// The session key set.
    #[must_use]
    pub fn keys(&self) -> &VaultKeys {
        &self.keys
    }

    /// Shared handle on the key set.
    #[must_use]
    pub fn keys_arc(&self) -> Arc<VaultKeys> {
        Arc::clone(&self.keys)
    }

    /// Serializes `value` to its body and stores it in the current mode.
    pub fn encode<T: Serialize>(&self, loc: &RecordLoc, value: &T) -> Result<Encoded> {
        let json = Zeroizing::new(serde_json::to_vec(value)?);
        let body = to_body(loc.table, &json)?;
        let enc = self.encrypting() || loc.table == TableTag::Secrets;
        self.store_body(loc, &body, enc)
    }

    /// Stores an already-built body with an explicit `enc`.
    pub fn store_body(&self, loc: &RecordLoc, body: &[u8], enc: bool) -> Result<Encoded> {
        if body.len() > MAX_BODY {
            return Err(StoreError::TooLarge("record"));
        }
        if enc {
            let opts = SealOptions {
                compression: if loc.table == TableTag::Versions {
                    Compression::Never
                } else {
                    Compression::Auto
                },
                pad: true,
            };
            Ok(Encoded {
                enc: 1,
                payload: self.keys.seal_record_with(&loc.aad(), body, opts)?,
            })
        } else {
            Ok(Encoded {
                enc: 0,
                payload: body.to_vec(),
            })
        }
    }

    /// Returns the body of a stored payload (opening the envelope when `enc = 1`).
    pub fn open_body(
        &self,
        loc: &RecordLoc,
        enc: i64,
        payload: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>> {
        match enc {
            0 => {
                if loc.table == TableTag::Secrets {
                    return Err(loc.damaged());
                }
                Ok(Zeroizing::new(payload.to_vec()))
            }
            1 => self
                .keys
                .open_record(&loc.aad(), payload)
                .map_err(|_| loc.damaged()),
            _ => Err(loc.damaged()),
        }
    }

    /// Decodes a stored payload into `T` (through [`upcast`]).
    pub fn decode<T: DeserializeOwned>(
        &self,
        loc: &RecordLoc,
        enc: i64,
        payload: &[u8],
    ) -> Result<T> {
        let value = self.decode_value(loc, enc, payload)?;
        serde_json::from_value(value).map_err(|e| {
            StoreError::Integrity(format!(
                "{} payload does not match its schema: {e}",
                loc.table.table_name()
            ))
        })
    }

    /// Decodes a stored payload into JSON (through [`upcast`]).
    pub fn decode_value(&self, loc: &RecordLoc, enc: i64, payload: &[u8]) -> Result<Value> {
        let body = self.open_body(loc, enc, payload)?;
        let json = from_body(loc.table, &body)?;
        let value: Value = serde_json::from_slice(&json).map_err(|_| loc.damaged())?;
        upcast(loc.table, value)
    }
}

/// JSON → stored body (zstd for `versions`).
pub fn to_body(table: TableTag, json: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if table == TableTag::Versions {
        Ok(Zeroizing::new(
            zstd::bulk::compress(json, VERSION_ZSTD_LEVEL)
                .map_err(|_| StoreError::Internal("zstd compression failed".into()))?,
        ))
    } else {
        Ok(Zeroizing::new(json.to_vec()))
    }
}

/// Stored body → JSON.
pub fn from_body(table: TableTag, body: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if table == TableTag::Versions {
        Ok(Zeroizing::new(
            zstd::bulk::decompress(body, MAX_BODY)
                .map_err(|_| StoreError::Integrity("version payload does not decompress".into()))?,
        ))
    } else {
        Ok(Zeroizing::new(body.to_vec()))
    }
}

/// The newest payload version per table.
#[must_use]
pub fn latest_payload_version(_table: TableTag) -> u64 {
    1
}

/// The upcast chain `upcast_<table>(v, Value) -> Value` (SPEC §10.3). Every v1 payload is current, so this
/// validates the `v` field and returns the value unchanged; later versions add steps here.
pub fn upcast(table: TableTag, value: Value) -> Result<Value> {
    let v = value.get("v").and_then(Value::as_u64).unwrap_or(1);
    let latest = latest_payload_version(table);
    if v == 0 || v > latest {
        return Err(StoreError::Unsupported(
            "payload written by a newer version of EMP",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use emp_crypto::{Dek, VaultId};

    fn codec(encrypt: bool) -> Codec {
        let keys =
            VaultKeys::derive(&Dek::generate(1).unwrap(), &VaultId::generate().unwrap()).unwrap();
        Codec::new(Arc::new(keys), encrypt)
    }

    #[derive(Serialize, serde::Deserialize, PartialEq, Debug)]
    struct P {
        v: u32,
        title: String,
    }

    #[test]
    fn plain_mode_stores_canonical_json() {
        let c = codec(false);
        let loc = RecordLoc::new(TableTag::Pages, "id1", "doc", 1);
        let e = c
            .encode(
                &loc,
                &P {
                    v: 1,
                    title: "Hi".into(),
                },
            )
            .unwrap();
        assert_eq!(e.enc, 0);
        assert_eq!(e.payload, br#"{"v":1,"title":"Hi"}"#);
        let back: P = c.decode(&loc, e.enc, &e.payload).unwrap();
        assert_eq!(back.title, "Hi");
    }

    #[test]
    fn encrypted_mode_binds_location() {
        let c = codec(true);
        let loc = RecordLoc::new(TableTag::Pages, "id1", "doc", 1);
        let e = c
            .encode(
                &loc,
                &P {
                    v: 1,
                    title: "Secret title".into(),
                },
            )
            .unwrap();
        assert_eq!(e.enc, 1);
        assert!(!e.payload.windows(6).any(|w| w == b"Secret"));
        let back: P = c.decode(&loc, 1, &e.payload).unwrap();
        assert_eq!(back.title, "Secret title");
        // Moved to another id / rev / kind → damaged.
        for other in [
            RecordLoc::new(TableTag::Pages, "id2", "doc", 1),
            RecordLoc::new(TableTag::Pages, "id1", "doc", 2),
            RecordLoc::new(TableTag::Pages, "id1", "sheet", 1),
            RecordLoc::new(TableTag::Workspaces, "id1", "doc", 1),
        ] {
            assert!(matches!(
                c.decode::<P>(&other, 1, &e.payload),
                Err(StoreError::Damaged { .. })
            ));
        }
        // Never falls back to plaintext.
        assert!(c.decode::<P>(&loc, 0, &e.payload).is_err());
    }

    #[test]
    fn secrets_are_always_sealed() {
        let c = codec(false);
        let loc = RecordLoc::row(TableTag::Secrets, "secret:1", 0);
        let e = c
            .encode(
                &loc,
                &P {
                    v: 1,
                    title: "k".into(),
                },
            )
            .unwrap();
        assert_eq!(e.enc, 1);
        assert!(c.decode::<P>(&loc, 0, br#"{"v":1,"title":"k"}"#).is_err());
    }

    #[test]
    fn versions_are_compressed_in_both_modes() {
        for mode in [false, true] {
            let c = codec(mode);
            let loc = RecordLoc::row(TableTag::Versions, "v1", 0);
            let big = P {
                v: 1,
                title: "x".repeat(10_000),
            };
            let e = c.encode(&loc, &big).unwrap();
            assert!(e.payload.len() < 2_000, "mode {mode}: {}", e.payload.len());
            assert_eq!(c.decode::<P>(&loc, e.enc, &e.payload).unwrap(), big);
        }
    }

    #[test]
    fn composite_locations_differ() {
        let c = codec(true);
        let a = RecordLoc::setting("vault", "a").unwrap();
        let b = RecordLoc::setting("vault", "b").unwrap();
        let e = c
            .encode(
                &a,
                &P {
                    v: 1,
                    title: "t".into(),
                },
            )
            .unwrap();
        assert!(c.decode::<P>(&b, 1, &e.payload).is_err());
        assert!(c.decode::<P>(&a, 1, &e.payload).is_ok());
    }

    #[test]
    fn newer_payload_versions_are_rejected() {
        let c = codec(false);
        let loc = RecordLoc::row(TableTag::Workspaces, "w", 0);
        assert!(matches!(
            c.decode_value(&loc, 0, br#"{"v":7}"#),
            Err(StoreError::Unsupported(_))
        ));
    }
}
