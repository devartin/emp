//! Sync links between local records and remote objects (SPEC §10.2 `sync_links`). The plaintext `remote_key` is a
//! blind index of the remote id (`HMAC(k_blind, "sync:<provider>" ‖ remoteId)`), so the file never shows remote
//! ids; the remote id, etag, account and last synced rev live in the payload.

use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::codec::{Codec, RecordLoc};
use crate::model::ids::new_id;
use crate::model::{Id, Rev, Ts};
use crate::vault::Session;
use crate::{Result, Store, StoreError};

/// A link.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLink {
    /// Link id.
    #[serde(default)]
    pub id: Id,
    /// Provider (`gcal`, …).
    #[serde(default)]
    pub provider: String,
    /// Local record id (page, row, …).
    #[serde(default)]
    pub local_id: Id,
    /// Remote object id.
    pub remote_id: String,
    /// Remote etag / version.
    #[serde(default)]
    pub etag: Option<String>,
    /// Remote account.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Local rev last pushed or pulled.
    #[serde(default)]
    pub last_synced_rev: Rev,
    /// Last change of the link.
    #[serde(default)]
    pub updated_at: Ts,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkPayload {
    v: u32,
    remote_id: String,
    #[serde(default)]
    etag: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    last_synced_rev: Rev,
}

/// `(id, provider, local_id, updated_at, rev, enc, payload)`.
type LinkRow = (String, String, String, i64, i64, i64, Vec<u8>);

fn loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::SyncLinks, id, u64::try_from(rev).unwrap_or(0))
}

fn remote_key(s: &Session, provider: &str, remote_id: &str) -> Result<String> {
    let k = s
        .keys()
        .blind_index(&format!("sync:{provider}"), remote_id.as_bytes())?;
    Ok(k.chars().take(32).collect())
}

const COLS: &str = "id, provider, local_id, updated_at, rev, enc, payload";

fn read_links(
    conn: &Connection,
    codec: &Codec,
    sql: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<SyncLink>> {
    let mut st = conn.prepare_cached(sql)?;
    let rows: Vec<LinkRow> = st
        .query_map(args, |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|(id, provider, local_id, updated_at, rev, enc, payload)| {
            let p: LinkPayload = codec.decode(&loc(&id, rev), enc, &payload)?;
            Ok(SyncLink {
                id,
                provider,
                local_id,
                remote_id: p.remote_id,
                etag: p.etag,
                account_id: p.account_id,
                last_synced_rev: p.last_synced_rev,
                updated_at,
            })
        })
        .collect()
}

impl Store {
    /// Creates or updates the link of `(provider, remote_id)`.
    pub fn sync_link_upsert(
        &self,
        provider: &str,
        local_id: &str,
        link: SyncLink,
    ) -> Result<SyncLink> {
        if provider.is_empty() || provider.len() > 64 || local_id.is_empty() || local_id.len() > 64
        {
            return Err(StoreError::invalid("invalid provider or local id"));
        }
        if link.remote_id.is_empty() || link.remote_id.len() > 1_024 {
            return Err(StoreError::invalid_field("remoteId", "invalid remote id"));
        }
        let s = self.session()?;
        let now = self.now();
        let key = remote_key(&s, provider, &link.remote_id)?;
        let sess = Arc::clone(&s);
        let (provider, local_id) = (provider.to_owned(), local_id.to_owned());
        self.write(move |tx| {
            let existing: Option<(String, i64)> = tx
                .prepare_cached("SELECT id, rev FROM sync_links WHERE provider = ?1 AND remote_key = ?2")?
                .query_row(params![provider, key], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            let (id, rev) = match existing {
                Some((id, rev)) => (id, rev + 1),
                None => (new_id(), 1),
            };
            let p = LinkPayload {
                v: 1,
                remote_id: link.remote_id.clone(),
                etag: link.etag.clone(),
                account_id: link.account_id.clone(),
                last_synced_rev: link.last_synced_rev,
            };
            let e = sess.codec.encode(&loc(&id, rev), &p)?;
            tx.prepare_cached(
                "INSERT INTO sync_links (id, provider, local_id, remote_key, updated_at, rev, enc, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET local_id = excluded.local_id, updated_at = excluded.updated_at, rev = excluded.rev,
                 enc = excluded.enc, payload = excluded.payload",
            )?
            .execute(params![id, provider, local_id, key, now, rev, e.enc, e.payload])?;
            Ok(SyncLink {
                id,
                provider,
                local_id,
                updated_at: now,
                ..link
            })
        })
    }

    /// The link of a remote object.
    pub fn sync_link_by_remote(&self, provider: &str, remote_id: &str) -> Result<Option<SyncLink>> {
        let s = self.session()?;
        let key = remote_key(&s, provider, remote_id)?;
        Ok(self
            .read(|c| {
                read_links(
                    c,
                    &s.codec,
                    &format!(
                        "SELECT {COLS} FROM sync_links WHERE provider = ?1 AND remote_key = ?2"
                    ),
                    params![provider, key],
                )
            })?
            .pop())
    }

    /// Links of a local record.
    pub fn sync_links_for_local(&self, local_id: &str) -> Result<Vec<SyncLink>> {
        let s = self.session()?;
        self.read(|c| {
            read_links(
                c,
                &s.codec,
                &format!("SELECT {COLS} FROM sync_links WHERE local_id = ?1 ORDER BY provider"),
                [local_id],
            )
        })
    }

    /// Every link of a provider.
    pub fn sync_links_list(&self, provider: &str) -> Result<Vec<SyncLink>> {
        let s = self.session()?;
        self.read(|c| {
            read_links(
                c,
                &s.codec,
                &format!("SELECT {COLS} FROM sync_links WHERE provider = ?1 ORDER BY updated_at"),
                [provider],
            )
        })
    }

    /// Deletes a link.
    pub fn sync_link_delete(&self, id: &str) -> Result<()> {
        self.session()?;
        let id = id.to_owned();
        self.write(move |tx| {
            tx.execute("DELETE FROM sync_links WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /// Deletes every link of a provider (disconnect).
    pub fn sync_links_clear(&self, provider: &str) -> Result<usize> {
        self.session()?;
        let provider = provider.to_owned();
        self.write(move |tx| {
            Ok(tx.execute("DELETE FROM sync_links WHERE provider = ?1", [provider])?)
        })
    }
}
