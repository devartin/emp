//! Outbox of pending remote writes (SPEC §10.2 `outbox`): integrations enqueue operations (e.g. Google Calendar
//! event updates) that a sync worker delivers with exponential backoff. Provider and timing columns are
//! plaintext; the operation lives in the (encrypted) payload.

use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codec::RecordLoc;
use crate::model::ids::new_id;
use crate::model::{Id, Ts};
use crate::{Result, Store, StoreError};

/// First retry delay.
pub const BASE_BACKOFF_MS: i64 = 30_000;
/// Longest retry delay.
pub const MAX_BACKOFF_MS: i64 = 6 * 60 * 60 * 1000;
/// Attempts after which an item is parked (`next_attempt_at = i64::MAX`) until retried manually.
pub const MAX_ATTEMPTS: i64 = 12;
/// Maximum payload size.
pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Stored payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct OutboxPayload {
    v: u32,
    op: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

/// One queued operation.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    /// Id.
    pub id: Id,
    /// Provider (`google`, …).
    pub provider: String,
    /// Enqueued at.
    pub created_at: Ts,
    /// Next attempt.
    pub next_attempt_at: Ts,
    /// Failed attempts so far.
    pub attempts: i64,
    /// The operation.
    pub op: Value,
    /// Last error message.
    pub last_error: Option<String>,
}

/// `(id, provider, created_at, next_attempt_at, attempts, rev, enc, payload)`.
type OutRow = (String, String, i64, i64, i64, i64, i64, Vec<u8>);

fn loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::Outbox, id, u64::try_from(rev).unwrap_or(0))
}

/// Backoff after `attempts` failures: 30 s · 2^(attempts-1), capped at 6 h.
#[must_use]
pub fn backoff_ms(attempts: i64) -> i64 {
    let shift = u32::try_from((attempts - 1).clamp(0, 20)).unwrap_or(20);
    BASE_BACKOFF_MS
        .saturating_mul(1_i64 << shift)
        .min(MAX_BACKOFF_MS)
}

fn valid_provider(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 64
        && p.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

impl Store {
    /// Enqueues an operation; it is due immediately.
    pub fn outbox_enqueue(&self, provider: &str, op: Value) -> Result<Id> {
        if !valid_provider(provider) {
            return Err(StoreError::invalid_field("provider", "invalid provider"));
        }
        let payload = OutboxPayload {
            v: 1,
            op,
            last_error: None,
        };
        if serde_json::to_vec(&payload)?.len() > MAX_PAYLOAD_BYTES {
            return Err(StoreError::TooLarge("outbox item"));
        }
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let provider = provider.to_owned();
        self.write(move |tx| {
            let id = new_id();
            let e = sess.codec.encode(&loc(&id, 1), &payload)?;
            tx.prepare_cached(
                "INSERT INTO outbox (id, provider, created_at, next_attempt_at, attempts, rev, enc, payload) VALUES (?1, ?2, ?3, ?3, 0, 1, ?4, ?5)",
            )?
            .execute(params![id, provider, now, e.enc, e.payload])?;
            Ok(id)
        })
    }

    /// Due items (oldest first), optionally of one provider.
    pub fn outbox_due(&self, provider: Option<&str>, limit: usize) -> Result<Vec<OutboxItem>> {
        let s = self.session()?;
        let now = self.now();
        let limit = i64::try_from(limit.clamp(1, 1_000)).unwrap_or(1_000);
        self.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, provider, created_at, next_attempt_at, attempts, rev, enc, payload FROM outbox
                 WHERE next_attempt_at <= ?1 AND (?2 IS NULL OR provider = ?2) ORDER BY next_attempt_at, created_at LIMIT ?3",
            )?;
            let rows: Vec<OutRow> = st
                .query_map(params![now, provider, limit], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            rows.into_iter()
                .map(|(id, provider, created_at, next, attempts, rev, enc, payload)| {
                    let p: OutboxPayload = s.codec.decode(&loc(&id, rev), enc, &payload)?;
                    Ok(OutboxItem { id, provider, created_at, next_attempt_at: next, attempts, op: p.op, last_error: p.last_error })
                })
                .collect()
        })
    }

    /// Removes a delivered item.
    pub fn outbox_complete(&self, id: &str) -> Result<()> {
        self.session()?;
        let id = id.to_owned();
        self.write(move |tx| {
            tx.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /// Records a failed attempt. `retry_after_ms` (from the provider) overrides the backoff. Returns the next
    /// attempt time (`i64::MAX` once parked after 12 attempts).
    pub fn outbox_fail(&self, id: &str, error: &str, retry_after_ms: Option<i64>) -> Result<Ts> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (id, error) = (id.to_owned(), error.chars().take(500).collect::<String>());
        self.write(move |tx| {
            let row: Option<(i64, i64, i64, Vec<u8>)> = tx
                .prepare_cached("SELECT attempts, rev, enc, payload FROM outbox WHERE id = ?1")?
                .query_row([&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .optional()?;
            let (attempts, rev, enc, payload) = row.ok_or(StoreError::NotFound("outbox item"))?;
            let mut p: OutboxPayload = sess.codec.decode(&loc(&id, rev), enc, &payload)?;
            p.last_error = Some(error);
            let attempts = attempts + 1;
            let next = if attempts >= MAX_ATTEMPTS {
                i64::MAX
            } else {
                now + retry_after_ms.filter(|r| *r > 0).unwrap_or_else(|| backoff_ms(attempts)).min(MAX_BACKOFF_MS)
            };
            let e = sess.codec.encode(&loc(&id, rev + 1), &p)?;
            tx.prepare_cached("UPDATE outbox SET attempts = ?2, next_attempt_at = ?3, rev = ?4, enc = ?5, payload = ?6 WHERE id = ?1")?
                .execute(params![id, attempts, next, rev + 1, e.enc, e.payload])?;
            Ok(next)
        })
    }

    /// Makes parked / waiting items of a provider due now (manual "Retry").
    pub fn outbox_retry_all(&self, provider: &str) -> Result<usize> {
        self.session()?;
        let now = self.now();
        let provider = provider.to_owned();
        self.write(move |tx| {
            Ok(tx
                .prepare_cached(
                    "UPDATE outbox SET next_attempt_at = ?2, attempts = 0 WHERE provider = ?1",
                )?
                .execute(params![provider, now])?)
        })
    }

    /// Pending items of a provider.
    pub fn outbox_count(&self, provider: &str) -> Result<usize> {
        self.read(|c| {
            let n: i64 = c
                .prepare_cached("SELECT count(*) FROM outbox WHERE provider = ?1")?
                .query_row([provider], |r| r.get(0))?;
            Ok(usize::try_from(n).unwrap_or(0))
        })
    }

    /// Drops every item of a provider (disconnect).
    pub fn outbox_clear(&self, provider: &str) -> Result<usize> {
        self.session()?;
        let provider = provider.to_owned();
        self.write(move |tx| Ok(tx.execute("DELETE FROM outbox WHERE provider = ?1", [provider])?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff_ms(1), 30_000);
        assert_eq!(backoff_ms(2), 60_000);
        assert_eq!(backoff_ms(30), MAX_BACKOFF_MS);
        assert!(valid_provider("google"));
        assert!(!valid_provider("Google Cal"));
    }
}
