//! Integrity manifest (SPEC §9.8).
//!
//! ```text
//! h(row)    = HMAC(k_manifest, u8 table_tag || lp(id) || lp(extra) || u64be(rev) || SHA-256(payload))
//! mset_root = XOR of h(row) over every enc = 1 row of every table
//! state_mac = HMAC(k_manifest, "EMP-STATE-v1" || vault_id || u64be(write_counter) || mset_root || SHA-256(keyslots))
//! ```
//!
//! **Maintenance.** The writer connection carries `TEMP` triggers on every payload table that call the
//! application function `emp_mset(tag, k1, k2, rev, payload)` for each old/new `enc = 1` row image. The function
//! XORs `h(row)` into a per-transaction delta held by [`ManifestTracker`]; when the writer commits it folds the delta
//! into `vault_state`, bumps `write_counter` and recomputes `state_mac` — all inside the same transaction. Because
//! this happens at the SQLite level, cascades (`ON DELETE CASCADE`, the purge triggers) and tables added by other
//! repositories are covered without any per-repository code. `TEMP` triggers live in `sqlite_temp_master`, so the
//! on-disk schema stays exactly §10.2.
//!
//! **Checking.** [`verify`] recomputes the root from scratch and checks the state MAC; [`check_records`] also opens
//! every envelope to find damaged items.

use std::sync::Arc;

use emp_crypto::mac::canonical_vault_meta;
use emp_crypto::{Keyslot, MsetRoot, VaultKeys, canonical_keyslots_digest};
use parking_lot::Mutex;
use rusqlite::functions::FunctionFlags;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, params};

use crate::codec::Codec;
use crate::db::tables::{KeyShape, PAYLOAD_TABLES, TableDesc};
use crate::model::DamagedItem;
use crate::{Result, StoreError};

/// Name of the SQL function called by the manifest triggers.
pub const MSET_FN: &str = "emp_mset";

/// Accumulates the per-transaction multiset delta on the writer connection.
pub struct ManifestTracker {
    keys: Mutex<Option<Arc<VaultKeys>>>,
    delta: Mutex<[u8; 32]>,
    touched: Mutex<bool>,
}

impl std::fmt::Debug for ManifestTracker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ManifestTracker")
    }
}

impl ManifestTracker {
    /// A tracker without keys (every `enc = 1` write fails until [`set_keys`](Self::set_keys)).
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            keys: Mutex::new(None),
            delta: Mutex::new([0; 32]),
            touched: Mutex::new(false),
        })
    }

    /// Installs (or removes, on lock) the session keys.
    pub fn set_keys(&self, keys: Option<Arc<VaultKeys>>) {
        *self.keys.lock() = keys;
    }

    /// The current keys, if unlocked.
    pub fn keys(&self) -> Option<Arc<VaultKeys>> {
        self.keys.lock().clone()
    }

    /// Resets the delta at the start of a transaction.
    pub fn begin(&self) {
        *self.delta.lock() = [0; 32];
        *self.touched.lock() = false;
    }

    /// Takes the delta accumulated since [`begin`](Self::begin) (and whether any encrypted row changed).
    pub fn take(&self) -> ([u8; 32], bool) {
        let d = std::mem::take(&mut *self.delta.lock());
        let t = std::mem::replace(&mut *self.touched.lock(), false);
        (d, t)
    }

    fn toggle(&self, tag: i64, k1: &str, k2: ValueRef<'_>, rev: i64, payload: &[u8]) -> Result<()> {
        let keys = self.keys().ok_or(StoreError::Locked)?;
        let tag = u8::try_from(tag)
            .ok()
            .and_then(|t| emp_crypto::TableTag::from_u8(t).ok())
            .ok_or_else(|| StoreError::Internal("bad table tag in manifest trigger".into()))?;
        let desc = crate::db::tables::desc(tag)?;
        let loc = desc.loc(k1, k2, "", rev)?;
        let h = keys.row_hash(tag, &loc.id, &loc.extra, loc.rev, payload)?;
        let mut d = self.delta.lock();
        for (a, b) in d.iter_mut().zip(h.as_bytes()) {
            *a ^= b;
        }
        *self.touched.lock() = true;
        Ok(())
    }

    /// Registers `emp_mset` and the `TEMP` triggers on the writer connection.
    pub fn install(self: &Arc<Self>, conn: &Connection) -> Result<()> {
        let me = Arc::clone(self);
        // DIRECTONLY (plus `trusted_schema = OFF`): only EMP's own TEMP triggers may call it, never a trigger or
        // view stored in the database file — otherwise a planted trigger could XOR arbitrary row hashes into the
        // root and have EMP re-seal a tampered state.
        let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY;
        conn.create_scalar_function(MSET_FN, 5, flags, move |ctx| {
            let tag: i64 = ctx.get(0)?;
            let k1 = match ctx.get_raw(1) {
                ValueRef::Text(t) => std::str::from_utf8(t)
                    .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?
                    .to_owned(),
                _ => {
                    return Err(rusqlite::Error::UserFunctionError(
                        "manifest key is not text".into(),
                    ));
                }
            };
            let k2 = ctx.get_raw(2);
            let rev: i64 = ctx.get(3)?;
            let payload = match ctx.get_raw(4) {
                ValueRef::Blob(b) => b,
                _ => {
                    return Err(rusqlite::Error::UserFunctionError(
                        "manifest payload is not a blob".into(),
                    ));
                }
            };
            me.toggle(tag, &k1, k2, rev, payload)
                .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
            Ok(rusqlite::types::Null)
        })?;
        let mut sql = String::new();
        for d in PAYLOAD_TABLES {
            sql.push_str(&trigger_sql(d));
        }
        conn.execute_batch(&sql)?;
        Ok(())
    }
}

fn trigger_sql(d: &TableDesc) -> String {
    let t = d.name();
    let tag = d.tag.as_u8();
    let (k1, k2) = d.key.columns();
    let args = |row: &str| {
        let k2 = match d.key {
            KeyShape::Id(_) => "NULL".to_owned(),
            _ => format!("{row}.{k2}"),
        };
        let rev = if d.has_rev {
            format!("{row}.rev")
        } else {
            "0".to_owned()
        };
        format!("{tag}, {row}.{k1}, {k2}, {rev}, {row}.payload")
    };
    format!(
        "CREATE TEMP TRIGGER IF NOT EXISTS emp_mset_{t}_ins AFTER INSERT ON {t} WHEN NEW.enc = 1 BEGIN SELECT {f}({new}); END;\n\
         CREATE TEMP TRIGGER IF NOT EXISTS emp_mset_{t}_del AFTER DELETE ON {t} WHEN OLD.enc = 1 BEGIN SELECT {f}({old}); END;\n\
         CREATE TEMP TRIGGER IF NOT EXISTS emp_mset_{t}_updo AFTER UPDATE ON {t} WHEN OLD.enc = 1 BEGIN SELECT {f}({old}); END;\n\
         CREATE TEMP TRIGGER IF NOT EXISTS emp_mset_{t}_updn AFTER UPDATE ON {t} WHEN NEW.enc = 1 BEGIN SELECT {f}({new}); END;\n",
        f = MSET_FN,
        new = args("NEW"),
        old = args("OLD"),
    )
}

/// The `vault_state` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateRow {
    /// Committed write transactions while unlocked.
    pub write_counter: u64,
    /// Multiset root.
    pub mset_root: [u8; 32],
    /// State MAC.
    pub state_mac: [u8; 32],
}

/// Reads `vault_state`.
pub fn read_state(conn: &Connection) -> Result<Option<StateRow>> {
    let row = conn
        .prepare_cached("SELECT write_counter, mset_root, state_mac FROM vault_state WHERE id = 1")?
        .query_row([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, Vec<u8>>(2)?,
            ))
        })
        .optional()?;
    row.map(|(c, root, mac)| {
        Ok(StateRow {
            write_counter: u64::try_from(c)
                .map_err(|_| StoreError::Integrity("write counter".into()))?,
            mset_root: root
                .try_into()
                .map_err(|_| StoreError::Integrity("mset root length".into()))?,
            state_mac: mac
                .try_into()
                .map_err(|_| StoreError::Integrity("state mac length".into()))?,
        })
    })
    .transpose()
}

/// Every keyslot row, parsed and validated.
pub fn read_keyslots(conn: &Connection) -> Result<Vec<Keyslot>> {
    let mut st = conn.prepare_cached(
        "SELECT slot_id, kind, kdf, kdf_params, salt, nonce, wrapped_dek, key_epoch, created_at FROM keyslots ORDER BY slot_id",
    )?;
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Vec<u8>>(3)?,
            r.get::<_, Vec<u8>>(4)?,
            r.get::<_, Vec<u8>>(5)?,
            r.get::<_, Vec<u8>>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, i64>(8)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, kdf, params, salt, nonce, wrapped, epoch, created) = row?;
        out.push(Keyslot::from_columns(
            id, &kind, &kdf, &params, &salt, &nonce, &wrapped, epoch, created,
        )?);
    }
    Ok(out)
}

fn write_state(conn: &Connection, keys: &VaultKeys, counter: u64, root: [u8; 32]) -> Result<()> {
    let slots = read_keyslots(conn)?;
    let digest = canonical_keyslots_digest(&slots)?;
    let root_m = MsetRoot::from_slice(&root)?;
    let mac = keys.state_mac(counter, &root_m, &digest)?;
    let counter_i =
        i64::try_from(counter).map_err(|_| StoreError::Internal("counter overflow".into()))?;
    conn.prepare_cached(
        "INSERT INTO vault_state (id, write_counter, mset_root, state_mac) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET write_counter = excluded.write_counter, mset_root = excluded.mset_root, state_mac = excluded.state_mac",
    )?
    .execute(params![counter_i, &root[..], &mac[..]])?;
    Ok(())
}

/// Folds a transaction delta into `vault_state` (called by the writer right before `COMMIT`).
pub fn commit_delta(conn: &Connection, keys: &VaultKeys, delta: [u8; 32]) -> Result<()> {
    let cur =
        read_state(conn)?.ok_or_else(|| StoreError::Integrity("vault_state is missing".into()))?;
    let mut root = cur.mset_root;
    for (a, b) in root.iter_mut().zip(delta) {
        *a ^= b;
    }
    write_state(conn, keys, cur.write_counter + 1, root)
}

/// Recomputes the root from every encrypted row and re-seals the state (vault creation, "Accept and re-seal").
pub fn reseal(conn: &Connection, keys: &VaultKeys) -> Result<()> {
    let root = compute_root(conn, keys)?;
    let counter = read_state(conn)?.map_or(0, |s| s.write_counter + 1);
    write_state(conn, keys, counter, root)
}

/// XOR of `h(row)` over every `enc = 1` row.
pub fn compute_root(conn: &Connection, keys: &VaultKeys) -> Result<[u8; 32]> {
    let mut root = [0u8; 32];
    for d in PAYLOAD_TABLES {
        let sql = format!("{} WHERE enc = 1", d.select_sql());
        let mut st = conn.prepare(&sql)?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let k1: String = r.get(0)?;
            let rev: i64 = r.get(3)?;
            let payload = r.get_ref(5)?.as_blob().map_err(rusqlite::Error::from)?;
            let loc = d.loc(&k1, r.get_ref(1)?, "", rev)?;
            let h = keys.row_hash(d.tag, &loc.id, &loc.extra, loc.rev, payload)?;
            for (a, b) in root.iter_mut().zip(h.as_bytes()) {
                *a ^= b;
            }
        }
    }
    Ok(root)
}

/// Result of [`verify`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ManifestCheck {
    /// The recomputed root equals the stored root.
    pub root_ok: bool,
    /// The state MAC verifies.
    pub mac_ok: bool,
}

impl ManifestCheck {
    /// Both checks passed.
    #[must_use]
    pub fn ok(&self) -> bool {
        self.root_ok && self.mac_ok
    }
}

/// Full recomputation (at unlock). Run on a connection inside one read transaction for a consistent view.
pub fn verify(conn: &Connection, keys: &VaultKeys) -> Result<ManifestCheck> {
    let Some(state) = read_state(conn)? else {
        return Ok(ManifestCheck {
            root_ok: false,
            mac_ok: false,
        });
    };
    let root = compute_root(conn, keys)?;
    let root_ok = subtle_eq(&root, &state.mset_root);
    let digest = canonical_keyslots_digest(&read_keyslots(conn)?)?;
    let mac_ok = keys.verify_state_mac(
        state.write_counter,
        &MsetRoot::from_slice(&state.mset_root)?,
        &digest,
        &state.state_mac,
    )?;
    Ok(ManifestCheck { root_ok, mac_ok })
}

fn subtle_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Opens every encrypted record and returns the ones that fail their AEAD check (SPEC §9.8 per-record failure).
///
/// Once the vault is encrypted (the codec no longer accepts plaintext), every `enc = 0` row except device-scope
/// settings is also reported: such a row was not written by EMP.
pub fn check_records(conn: &Connection, codec: &Codec) -> Result<Vec<DamagedItem>> {
    let mut damaged = Vec::new();
    for d in PAYLOAD_TABLES {
        let cond = if codec.accepts_plaintext() {
            "enc != 0"
        } else if d.tag == emp_crypto::TableTag::Settings {
            "scope = 'vault'"
        } else {
            "1"
        };
        let sql = format!("{} WHERE {cond}", d.select_sql());
        let mut st = conn.prepare(&sql)?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let k1: String = r.get(0)?;
            let kind: String = r.get(2)?;
            let rev: i64 = r.get(3)?;
            let enc: i64 = r.get(4)?;
            let payload = r.get_ref(5)?.as_blob().map_err(rusqlite::Error::from)?;
            let ok = d
                .loc(&k1, r.get_ref(1)?, &kind, rev)
                .and_then(|loc| codec.open_body(&loc, enc, payload).map(|_| ()))
                .is_ok();
            if !ok {
                damaged.push(DamagedItem {
                    table: d.name().to_owned(),
                    id: d.display_key(&k1, r.get_ref(1)?),
                });
            }
        }
    }
    Ok(damaged)
}

/// `vault_meta` keys covered by the header MAC (volatile keys are excluded).
///
/// `encryption_job` (present only while an encryption toggle is rewriting rows) is covered so that a resumed
/// rewrite at unlock is always one EMP started. Absent keys are left out of the canonical form, so adding a key here
/// does not change the MAC of vaults that never had it.
pub const HEADER_KEYS: &[&str] = &[
    "format_version",
    "vault_id",
    "encryption",
    "created_day",
    crate::vault::ENCRYPTION_JOB_KEY,
];

/// Canonical bytes of the covered `vault_meta` entries.
pub fn canonical_meta(conn: &Connection) -> Result<Vec<u8>> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for k in HEADER_KEYS {
        let v: Option<Vec<u8>> = conn
            .prepare_cached("SELECT value FROM vault_meta WHERE key = ?1")?
            .query_row([k], |r| r.get(0))
            .optional()?;
        if let Some(v) = v {
            entries.push(((*k).to_owned(), v));
        }
    }
    let refs: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_slice()))
        .collect();
    Ok(canonical_vault_meta(&refs)?)
}

/// Recomputes and stores `vault_meta.header_mac`.
pub fn write_header_mac(conn: &Connection, keys: &VaultKeys) -> Result<()> {
    let mac = keys.header_mac(&canonical_meta(conn)?)?;
    conn.prepare_cached(
        "INSERT INTO vault_meta (key, value) VALUES ('header_mac', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )?
    .execute([&mac[..]])?;
    Ok(())
}

/// Checks `vault_meta.header_mac`.
pub fn verify_header_mac(conn: &Connection, keys: &VaultKeys) -> Result<bool> {
    let stored: Option<Vec<u8>> = conn
        .prepare_cached("SELECT value FROM vault_meta WHERE key = 'header_mac'")?
        .query_row([], |r| r.get(0))
        .optional()?;
    match stored {
        Some(s) => Ok(keys.verify_header_mac(&canonical_meta(conn)?, &s)?),
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use emp_crypto::{Dek, VaultId};

    fn conn_with_tracker() -> (Connection, Arc<ManifestTracker>) {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::pragmas::harden(&c).unwrap();
        crate::db::migrate::migrate(&mut c, None, 0).unwrap();
        let t = ManifestTracker::new();
        let keys =
            VaultKeys::derive(&Dek::generate(1).unwrap(), &VaultId::generate().unwrap()).unwrap();
        t.set_keys(Some(Arc::new(keys)));
        t.install(&c).unwrap();
        (c, t)
    }

    #[test]
    fn temp_triggers_feed_the_tracker() {
        let (c, t) = conn_with_tracker();
        t.begin();
        c.execute(
            "INSERT INTO workspaces (id, sort_key, created_at, updated_at, rev, enc, payload) VALUES ('w', 'a', 0, 0, 1, 1, X'00')",
            [],
        )
        .unwrap();
        let (delta, touched) = t.take();
        assert!(touched);
        assert_ne!(delta, [0u8; 32]);
    }

    #[test]
    fn mset_function_is_not_callable_from_stored_schema() {
        // Regression (defence in depth next to the open-time schema check): a trigger stored in the database file
        // must not be able to XOR chosen row hashes into the manifest delta.
        let (c, t) = conn_with_tracker();
        c.execute_batch(
            "CREATE TRIGGER planted AFTER INSERT ON outbox BEGIN SELECT emp_mset(2, 'victim', NULL, 1, X'00'); END;",
        )
        .unwrap();
        t.begin();
        let r = c.execute(
            "INSERT INTO outbox (id, provider, created_at, next_attempt_at, attempts, rev, enc, payload) VALUES ('o', 'p', 0, 0, 0, 0, 0, X'00')",
            [],
        );
        assert!(r.is_err(), "a stored trigger called emp_mset");
        let (_, touched) = t.take();
        assert!(!touched);
        // Neither may a view.
        c.execute_batch(
            "CREATE VIEW planted_view AS SELECT emp_mset(2, 'v', NULL, 1, X'00') AS x;",
        )
        .unwrap();
        assert!(
            c.query_row("SELECT x FROM planted_view", [], |_| Ok(()))
                .is_err()
        );
    }
}
