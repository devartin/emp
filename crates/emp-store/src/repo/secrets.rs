//! Secrets (SPEC §10.2 `secrets`, §11.3 Secrets): always encrypted (`k_secrets`, enc = 1 in every vault mode),
//! write-only over IPC. Ids are random (`secret:<32 hex>`); the provider name lives inside the payload.
//! Providers starting with `emp:` are internal and hidden from [`Store::secret_list`].

use emp_crypto::{ExposeSecret, SecretString, TableTag};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use crate::codec::RecordLoc;
use crate::model::ids::new_secret_id;
use crate::model::{SecretInfo, SecretKind, SecretPayload, SecretSet};
use crate::{Result, Store, StoreError};

/// Maximum secret value size.
pub const MAX_SECRET_BYTES: usize = 64 * 1024;

struct Row {
    id: String,
    created_at: i64,
    rev: i64,
    payload: SecretPayload,
}

impl Store {
    fn secret_rows(&self) -> Result<Vec<Row>> {
        let s = self.session()?;
        let raw: Vec<(String, i64, i64, i64, Vec<u8>)> = self.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, created_at, rev, enc, payload FROM secrets ORDER BY created_at",
            )?;
            let rows = st.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        raw.into_iter()
            .map(|(id, created_at, rev, enc, payload)| {
                let loc = RecordLoc::row(TableTag::Secrets, &id, u64::try_from(rev).unwrap_or(0));
                Ok(Row {
                    payload: s.codec.decode(&loc, enc, &payload)?,
                    id,
                    created_at,
                    rev,
                })
            })
            .collect()
    }

    fn secret_row(&self, id: &str) -> Result<Row> {
        let s = self.session()?;
        let raw: Option<(i64, i64, i64, Vec<u8>)> =
            self.read(|c| {
                Ok(c.prepare_cached(
                    "SELECT created_at, rev, enc, payload FROM secrets WHERE id = ?1",
                )?
                .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .optional()?)
            })?;
        let (created_at, rev, enc, payload) = raw.ok_or(StoreError::NotFound("secret"))?;
        let loc = RecordLoc::row(TableTag::Secrets, id, u64::try_from(rev).unwrap_or(0));
        Ok(Row {
            id: id.to_owned(),
            created_at,
            rev,
            payload: s.codec.decode(&loc, enc, &payload)?,
        })
    }

    fn info(row: &Row) -> SecretInfo {
        SecretInfo {
            id: row.id.clone(),
            provider: row.payload.provider.clone(),
            label: row.payload.label.clone(),
            kind: row.payload.kind,
            last4: row.payload.last4.clone(),
            created_at: row.created_at,
            last_used_at: row.payload.last_used_at,
        }
    }

    fn put_secret(
        &self,
        id: String,
        created_at: i64,
        rev: i64,
        payload: &SecretPayload,
    ) -> Result<()> {
        let s = self.session()?;
        let loc = RecordLoc::row(TableTag::Secrets, &id, u64::try_from(rev).unwrap_or(0));
        let e = s.codec.encode(&loc, payload)?;
        let now = self.now();
        self.write(move |tx| {
            tx.prepare_cached(
                "INSERT INTO secrets (id, created_at, updated_at, rev, enc, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, rev = excluded.rev,
                 enc = excluded.enc, payload = excluded.payload",
            )?
            .execute(params![id, created_at, now, rev, e.enc, e.payload])?;
            Ok(())
        })
    }

    /// `secret_list` (never includes values).
    pub fn secret_list(&self) -> Result<Vec<SecretInfo>> {
        Ok(self
            .secret_rows()?
            .iter()
            .filter(|r| !r.payload.provider.starts_with("emp:"))
            .map(Self::info)
            .collect())
    }

    /// `secret_set`: creates or overwrites a secret (write-only).
    pub fn secret_set(&self, req: SecretSet) -> Result<SecretInfo> {
        let value = req.value.expose_secret();
        if value.is_empty() || value.len() > MAX_SECRET_BYTES {
            return Err(StoreError::invalid_field("value", "invalid secret length"));
        }
        if req.provider.is_empty() || req.provider.len() > 64 || req.label.chars().count() > 1024 {
            return Err(StoreError::invalid("invalid provider or label"));
        }
        let last4 = req.show_last4.then(|| {
            let chars: Vec<char> = value.chars().collect();
            chars[chars.len().saturating_sub(4)..]
                .iter()
                .collect::<String>()
        });
        self.secret_put_json(
            req.id.as_deref(),
            &req.provider,
            &req.label,
            req.kind,
            Value::String(value.to_owned()),
            req.allowed_hosts,
            last4,
        )
    }

    /// Stores a structured secret (OAuth token sets, client configs). Overwrites `id` if given.
    #[allow(clippy::too_many_arguments)]
    pub fn secret_put_json(
        &self,
        id: Option<&str>,
        provider: &str,
        label: &str,
        kind: SecretKind,
        data: Value,
        allowed_hosts: Vec<String>,
        last4: Option<String>,
    ) -> Result<SecretInfo> {
        let now = self.now();
        let (id, created_at, rev, last_used_at) = match id {
            Some(id) => {
                let old = self.secret_row(id)?;
                (
                    old.id.clone(),
                    old.created_at,
                    old.rev + 1,
                    old.payload.last_used_at,
                )
            }
            None => (new_secret_id()?, now, 1, None),
        };
        let payload = SecretPayload {
            v: 1,
            provider: provider.to_owned(),
            label: label.to_owned(),
            kind,
            allowed_hosts,
            data,
            last4,
            last_used_at,
        };
        self.put_secret(id.clone(), created_at, rev, &payload)?;
        Ok(Self::info(&Row {
            id,
            created_at,
            rev,
            payload,
        }))
    }

    /// `secret_delete`.
    pub fn secret_delete(&self, id: &str) -> Result<()> {
        self.session()?;
        let id = id.to_owned();
        let n = self.write(move |tx| Ok(tx.execute("DELETE FROM secrets WHERE id = ?1", [id])?))?;
        if n == 0 {
            return Err(StoreError::NotFound("secret"));
        }
        Ok(())
    }

    /// The secret value for Rust-side use (integrations, NetGuard). Never send it over IPC.
    /// Non-string data (OAuth token sets) is returned as JSON text.
    pub fn secret_value(&self, id: &str) -> Result<SecretString> {
        let row = self.secret_row(id)?;
        Ok(match &row.payload.data {
            Value::String(s) => SecretString::from(s.clone()),
            other => SecretString::from(other.to_string()),
        })
    }

    /// The structured data and allowed hosts of a secret (Rust-side use only).
    pub fn secret_data(&self, id: &str) -> Result<(Value, Vec<String>)> {
        let row = self.secret_row(id)?;
        Ok((row.payload.data.clone(), row.payload.allowed_hosts.clone()))
    }

    /// Records a use (`lastUsedAt`).
    pub fn secret_touch(&self, id: &str) -> Result<()> {
        let row = self.secret_row(id)?;
        let mut payload = row.payload.clone();
        payload.last_used_at = Some(self.now());
        self.put_secret(row.id.clone(), row.created_at, row.rev + 1, &payload)
    }

    /// Secrets of a provider (including internal `emp:` providers).
    pub fn secret_find(&self, provider: &str) -> Result<Vec<SecretInfo>> {
        Ok(self
            .secret_rows()?
            .iter()
            .filter(|r| r.payload.provider == provider)
            .map(Self::info)
            .collect())
    }
}
