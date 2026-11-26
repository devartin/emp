//! Key-value store (SPEC §10.2 `kv`): UI state (`ui.*`) and caches (`market.*`, `fx.rates`, `net.log`, ...).
//!
//! Keys of every namespace other than `ui.*` are stored as `hex(HMAC(k_blind, key))[..32]`, so cache keys such as
//! tickers or remote ids are not visible on disk. Values are `{v:1, value}` payloads through the codec. Entries may
//! carry `expires_at`; expired entries read as absent and are purged by maintenance.

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codec::RecordLoc;
use crate::vault::Session;
use crate::{Result, Store, StoreError};

/// Maximum serialized value size.
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;
/// Maximum key length.
pub const MAX_KEY_LEN: usize = 512;

#[derive(Serialize, Deserialize)]
struct KvPayload {
    v: u32,
    value: Value,
}

/// `true` for namespaces the webview may use through `kv_*` IPC commands.
#[must_use]
pub fn is_ui_namespace(ns: &str) -> bool {
    ns.strip_prefix("ui.").is_some_and(|r| !r.is_empty()) && valid_ns(ns)
}

fn valid_ns(ns: &str) -> bool {
    !ns.is_empty()
        && ns.len() <= 64
        && ns
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn stored_key(session: &Session, ns: &str, key: &str) -> Result<String> {
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return Err(StoreError::invalid_field("key", "invalid key length"));
    }
    if !valid_ns(ns) {
        return Err(StoreError::invalid_field("ns", "invalid namespace"));
    }
    if ns.starts_with("ui.") {
        Ok(key.to_owned())
    } else {
        let full = session
            .keys()
            .blind_index(&format!("kv:{ns}"), key.as_bytes())?;
        Ok(full.chars().take(32).collect())
    }
}

fn get_value(store: &Store, session: &Session, ns: &str, key: &str) -> Result<Option<Value>> {
    let sk = stored_key(session, ns, key)?;
    let now = store.now();
    let row: Option<(i64, Vec<u8>, Option<i64>)> = store.read(|c| {
        Ok(
            c.prepare_cached("SELECT enc, payload, expires_at FROM kv WHERE ns = ?1 AND key = ?2")?
                .query_row(params![ns, sk], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?,
        )
    })?;
    match row {
        Some((_, _, Some(exp))) if exp <= now => Ok(None),
        Some((enc, payload, _)) => {
            let p: KvPayload = session
                .codec
                .decode(&RecordLoc::kv(ns, &sk)?, enc, &payload)?;
            Ok(Some(p.value))
        }
        None => Ok(None),
    }
}

fn set_value(
    store: &Store,
    session: &Session,
    ns: &str,
    key: &str,
    value: Value,
    expires_at: Option<i64>,
) -> Result<()> {
    let sk = stored_key(session, ns, key)?;
    let payload = KvPayload { v: 1, value };
    if serde_json::to_vec(&payload)?.len() > MAX_VALUE_BYTES {
        return Err(StoreError::TooLarge("kv value"));
    }
    let e = session.codec.encode(&RecordLoc::kv(ns, &sk)?, &payload)?;
    let now = store.now();
    let ns = ns.to_owned();
    store.write(move |tx| {
        tx.prepare_cached(
            "INSERT INTO kv (ns, key, updated_at, expires_at, enc, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(ns, key) DO UPDATE SET updated_at = excluded.updated_at, expires_at = excluded.expires_at,
             enc = excluded.enc, payload = excluded.payload",
        )?
        .execute(params![ns, sk, now, expires_at, e.enc, e.payload])?;
        Ok(())
    })
}

/// Internal: stores a typed value under an internal namespace.
pub(crate) fn put_internal<T: Serialize>(
    store: &Store,
    session: &Arc<Session>,
    ns: &str,
    key: &str,
    value: &T,
) -> Result<()> {
    set_value(store, session, ns, key, serde_json::to_value(value)?, None)
}

/// Internal: reads a typed value from an internal namespace.
pub(crate) fn get_internal<T: serde::de::DeserializeOwned>(
    store: &Store,
    session: &Arc<Session>,
    ns: &str,
    key: &str,
) -> Result<Option<T>> {
    get_value(store, session, ns, key)?
        .map(|v| {
            serde_json::from_value(v).map_err(|e| StoreError::Integrity(format!("kv value: {e}")))
        })
        .transpose()
}

/// Internal: deletes a value.
pub(crate) fn delete_internal(store: &Store, ns: &str, key: &str) -> Result<()> {
    let s = store.session()?;
    let sk = stored_key(&s, ns, key)?;
    let ns = ns.to_owned();
    store.write(move |tx| {
        tx.execute("DELETE FROM kv WHERE ns = ?1 AND key = ?2", params![ns, sk])?;
        Ok(())
    })
}

impl Store {
    /// `kv_get` (IPC: `ui.*` namespaces only).
    pub fn kv_get(&self, ns: &str, key: &str) -> Result<Option<Value>> {
        if !is_ui_namespace(ns) {
            return Err(StoreError::invalid_field(
                "ns",
                "only ui.* namespaces are accessible",
            ));
        }
        self.kv_get_any(ns, key)
    }

    /// `kv_set` (IPC: `ui.*` namespaces only). A report under `ui.gettingStarted` also ticks that Getting
    /// Started checklist item.
    pub fn kv_set(&self, ns: &str, key: &str, value: Value) -> Result<()> {
        if !is_ui_namespace(ns) {
            return Err(StoreError::invalid_field(
                "ns",
                "only ui.* namespaces are accessible",
            ));
        }
        let item = crate::repo::tour::ui_item(ns, key, &value).map(str::to_owned);
        self.kv_set_any(ns, key, value, None)?;
        if let Some(item) = item {
            self.tour_tick_quiet(&item);
        }
        Ok(())
    }

    /// `kv_get_many` (IPC: `ui.*` namespaces only). Missing keys are omitted.
    pub fn kv_get_many(&self, ns: &str, keys: &[String]) -> Result<BTreeMap<String, Value>> {
        if keys.len() > 1000 {
            return Err(StoreError::TooLarge("too many keys"));
        }
        let mut out = BTreeMap::new();
        for k in keys {
            if let Some(v) = self.kv_get(ns, k)? {
                out.insert(k.clone(), v);
            }
        }
        Ok(out)
    }

    /// Reads any namespace (app-internal callers: market caches, sync tokens, network log).
    pub fn kv_get_any(&self, ns: &str, key: &str) -> Result<Option<Value>> {
        let s = self.session()?;
        get_value(self, &s, ns, key)
    }

    /// Writes any namespace with an optional expiry (unix ms).
    pub fn kv_set_any(
        &self,
        ns: &str,
        key: &str,
        value: Value,
        expires_at: Option<i64>,
    ) -> Result<()> {
        let s = self.session()?;
        set_value(self, &s, ns, key, value, expires_at)
    }

    /// Deletes a key in any namespace.
    pub fn kv_delete(&self, ns: &str, key: &str) -> Result<()> {
        delete_internal(self, ns, key)
    }

    /// Removes expired entries.
    pub fn kv_purge_expired(&self) -> Result<usize> {
        self.session()?;
        let now = self.now();
        self.write(move |tx| {
            Ok(tx.execute(
                "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?1",
                [now],
            )?)
        })
    }
}
