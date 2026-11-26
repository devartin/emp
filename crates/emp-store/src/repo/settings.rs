//! Settings (SPEC §10.2 `settings`, §11.3 `settings_*`).
//!
//! * Device scope (`scope = 'device'`): plaintext JSON (`enc = 0` is enforced by a CHECK), readable while locked —
//!   theme and other boot preferences, auto-lock.
//! * Vault scope (`scope = 'vault'`): encrypted with the vault; requires an unlocked session.
//!
//! Patches are JSON objects with the IPC field names; nested objects are merged, unknown fields are rejected.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::codec::RecordLoc;
use crate::model::{DeviceSettings, SettingsBundle, VaultSettings};
use crate::{Result, Store, StoreError};

const DEVICE_KEY: &str = "device";
const VAULT_KEY: &str = "vault";

/// Reads a raw device-scope value.
pub(crate) fn get_device_raw(conn: &Connection, key: &str) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .prepare_cached(
            "SELECT payload FROM settings WHERE scope = 'device' AND key = ?1 AND enc = 0",
        )?
        .query_row([key], |r| r.get(0))
        .optional()?)
}

/// Writes a raw device-scope value.
pub(crate) fn put_device_raw(conn: &Connection, key: &str, bytes: &[u8], now: i64) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO settings (scope, key, updated_at, enc, payload) VALUES ('device', ?1, ?2, 0, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET updated_at = excluded.updated_at, enc = 0, payload = excluded.payload",
    )?
    .execute(params![key, now, bytes])?;
    Ok(())
}

/// Deep-merges `patch` into `base` (objects merge recursively, everything else replaces).
pub fn json_merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                match b.get_mut(k) {
                    Some(existing) if existing.is_object() && v.is_object() => {
                        json_merge(existing, v)
                    }
                    _ => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, p) => *b = p.clone(),
    }
}

fn check_keys(patch: &Value, template: &Value) -> Result<()> {
    let (Some(p), Some(t)) = (patch.as_object(), template.as_object()) else {
        return Err(StoreError::invalid("patch must be an object"));
    };
    for (k, v) in p {
        let Some(tv) = t.get(k) else {
            // Optional fields absent from the default serialization.
            if k == "folderGrantLabel" {
                continue;
            }
            return Err(StoreError::invalid(format!("unknown setting `{k}`")));
        };
        if v.is_object() && tv.is_object() {
            check_keys(v, tv)?;
        }
    }
    Ok(())
}

fn apply_patch<T>(current: &T, patch: &Value) -> Result<T>
where
    T: serde::Serialize + serde::de::DeserializeOwned + Default,
{
    let template = serde_json::to_value(T::default())?;
    check_keys(patch, &template)?;
    let mut v = serde_json::to_value(current)?;
    json_merge(&mut v, patch);
    serde_json::from_value(v).map_err(|e| StoreError::invalid(format!("invalid settings: {e}")))
}

impl Store {
    /// Device settings (works while locked).
    pub fn device_settings(&self) -> Result<DeviceSettings> {
        Ok(self
            .read(|c| get_device_raw(c, DEVICE_KEY))?
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default())
    }

    /// Vault settings (requires unlock).
    pub fn vault_settings(&self) -> Result<VaultSettings> {
        let s = self.session()?;
        let row: Option<(i64, Vec<u8>)> = self.read(|c| {
            Ok(c.prepare_cached(
                "SELECT enc, payload FROM settings WHERE scope = 'vault' AND key = ?1",
            )?
            .query_row([VAULT_KEY], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?)
        })?;
        match row {
            Some((enc, payload)) => {
                let mut v = s.codec.decode_value(
                    &RecordLoc::setting("vault", VAULT_KEY)?,
                    enc,
                    &payload,
                )?;
                if let Some(o) = v.as_object_mut() {
                    o.remove("v");
                }
                serde_json::from_value(v)
                    .map_err(|e| StoreError::Integrity(format!("vault settings: {e}")))
            }
            None => Ok(VaultSettings::default()),
        }
    }

    /// `settings_get`: device settings always, vault settings while unlocked.
    pub fn settings_get(&self) -> Result<SettingsBundle> {
        Ok(SettingsBundle {
            device: self.device_settings()?,
            vault: if self.is_unlocked() {
                Some(self.vault_settings()?)
            } else {
                None
            },
        })
    }

    /// `settings_set_device`.
    pub fn settings_set_device(&self, patch: &Value) -> Result<DeviceSettings> {
        let next = apply_patch(&self.device_settings()?, patch)?;
        next.validate()?;
        let bytes = serde_json::to_vec(&next)?;
        let now = self.now();
        self.write(move |tx| put_device_raw(tx, DEVICE_KEY, &bytes, now))?;
        Ok(next)
    }

    /// `settings_set_vault`.
    pub fn settings_set_vault(&self, patch: &Value) -> Result<VaultSettings> {
        let s = self.session()?;
        let next = apply_patch(&self.vault_settings()?, patch)?;
        next.validate()?;
        let mut v = serde_json::to_value(&next)?;
        if let Some(o) = v.as_object_mut() {
            let mut with_v = Map::new();
            with_v.insert("v".into(), Value::from(1));
            with_v.extend(std::mem::take(o));
            *o = with_v;
        }
        let e = s
            .codec
            .encode(&RecordLoc::setting("vault", VAULT_KEY)?, &v)?;
        let now = self.now();
        self.write(move |tx| {
            tx.prepare_cached(
                "INSERT INTO settings (scope, key, updated_at, enc, payload) VALUES ('vault', ?1, ?2, ?3, ?4)
                 ON CONFLICT(scope, key) DO UPDATE SET updated_at = excluded.updated_at, enc = excluded.enc, payload = excluded.payload",
            )?
            .execute(params![VAULT_KEY, now, e.enc, e.payload])?;
            Ok(())
        })?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_is_deep() {
        let mut a = json!({"a": 1, "n": {"x": 1, "y": 2}});
        json_merge(&mut a, &json!({"n": {"y": 3}, "b": true}));
        assert_eq!(a, json!({"a": 1, "n": {"x": 1, "y": 3}, "b": true}));
    }

    #[test]
    fn patch_rejects_unknown_and_invalid() {
        let cur = VaultSettings::default();
        assert!(apply_patch(&cur, &json!({"nope": 1})).is_err());
        let next = apply_patch(&cur, &json!({"snapshots": {"keepDaily": 3}})).unwrap();
        assert_eq!(next.snapshots.keep_daily, 3);
        assert_eq!(next.snapshots.keep_weekly, 4);
        let bad = apply_patch(&cur, &json!({"weekStart": 3})).unwrap();
        assert!(bad.validate().is_err());
        let d = apply_patch(&DeviceSettings::default(), &json!({"theme": "dark"})).unwrap();
        assert_eq!(d.theme, "dark");
        assert!(
            apply_patch(&DeviceSettings::default(), &json!({"theme": "neon"}))
                .unwrap()
                .validate()
                .is_err()
        );
    }
}
