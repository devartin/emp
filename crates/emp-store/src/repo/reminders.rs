//! Reminders (SPEC §10.2 `reminders`, §11.3 "Reminders and jobs"). `fire_at` / `fired_at` are plaintext (for the
//! due index); the target and text live in the payload. The scheduler ([`crate::life::scheduler`]) fires due
//! reminders; the app turns them into `reminder:due` events and OS notifications.

use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::codec::{Codec, RecordLoc};
use crate::model::ids::{is_block_id, is_record_id, new_id};
use crate::model::{Id, Ts};
use crate::{Result, Store, StoreError};

/// Allowed snooze durations in minutes.
pub const SNOOZE_MINUTES: [u32; 4] = [5, 15, 60, 1440];
/// Maximum reminders returned by one list call.
pub const MAX_LIST: usize = 1_000;

/// Reminder target kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum ReminderTarget {
    Page,
    Row,
    Block,
}

/// Stored payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderPayload {
    /// Payload version.
    pub v: u32,
    /// Target kind.
    pub target_kind: ReminderTarget,
    /// Target page / row id.
    pub target_id: Id,
    /// Block inside the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// Text.
    pub text: String,
}

/// `Reminder` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    /// Id.
    pub id: Id,
    /// When it fires.
    pub fire_at: Ts,
    /// Target kind.
    pub target_kind: ReminderTarget,
    /// Target id.
    pub target_id: Id,
    /// Block (for block reminders).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// Text.
    pub text: String,
    /// Already fired.
    pub fired: bool,
}

/// `reminder_upsert` request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderUpsert {
    /// Existing id (update).
    #[serde(default)]
    pub id: Option<Id>,
    /// When it fires.
    pub fire_at: Ts,
    /// Target kind.
    pub target_kind: ReminderTarget,
    /// Target id.
    pub target_id: Id,
    /// Block.
    #[serde(default)]
    pub block_id: Option<String>,
    /// Text.
    pub text: String,
}

/// `(id, fire_at, fired_at, rev, enc, payload)`.
type RemRow = (String, i64, Option<i64>, i64, i64, Vec<u8>);

fn loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::Reminders, id, u64::try_from(rev).unwrap_or(0))
}

fn decode(
    codec: &Codec,
    id: String,
    fire_at: i64,
    fired_at: Option<i64>,
    rev: i64,
    enc: i64,
    payload: &[u8],
) -> Result<Reminder> {
    let p: ReminderPayload = codec.decode(&loc(&id, rev), enc, payload)?;
    Ok(Reminder {
        id,
        fire_at,
        target_kind: p.target_kind,
        target_id: p.target_id,
        block_id: p.block_id,
        text: p.text,
        fired: fired_at.is_some(),
    })
}

fn query(
    conn: &Connection,
    codec: &Codec,
    sql: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<Reminder>> {
    let mut st = conn.prepare_cached(sql)?;
    let rows: Vec<RemRow> = st
        .query_map(args, |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, at, fired, rev, enc, payload) in rows {
        match decode(codec, id, at, fired, rev, enc, &payload) {
            Ok(r) => out.push(r),
            Err(StoreError::Damaged { .. }) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

const COLS: &str = "id, fire_at, fired_at, rev, enc, payload";

impl Store {
    /// `reminder_list`: reminders firing in `[from, to]`, by time.
    pub fn reminder_list(&self, from: Ts, to: Ts) -> Result<Vec<Reminder>> {
        let s = self.session()?;
        self.read(|c| {
            query(
                c,
                &s.codec,
                &format!("SELECT {COLS} FROM reminders WHERE fire_at BETWEEN ?1 AND ?2 ORDER BY fire_at, id LIMIT {MAX_LIST}"),
                params![from, to],
            )
        })
    }

    /// Reminders of a target (page / row), for chips in the editor.
    pub fn reminder_for_target(&self, target_id: &str) -> Result<Vec<Reminder>> {
        let s = self.session()?;
        let all = self.read(|c| {
            query(
                c,
                &s.codec,
                &format!("SELECT {COLS} FROM reminders WHERE fired_at IS NULL ORDER BY fire_at"),
                [],
            )
        })?;
        Ok(all
            .into_iter()
            .filter(|r| r.target_id == target_id)
            .collect())
    }

    /// `reminder_upsert`.
    pub fn reminder_upsert(&self, req: ReminderUpsert) -> Result<Id> {
        if req.text.chars().count() > 1_024 {
            return Err(StoreError::invalid_field(
                "text",
                "reminder text is limited to 1,024 characters",
            ));
        }
        if !is_record_id(&req.target_id) {
            return Err(StoreError::invalid_field("targetId", "invalid id"));
        }
        if let Some(b) = &req.block_id
            && !is_block_id(b)
        {
            return Err(StoreError::invalid_field("blockId", "invalid block id"));
        }
        if req.target_kind == ReminderTarget::Block && req.block_id.is_none() {
            return Err(StoreError::invalid_field(
                "blockId",
                "block reminders need a block id",
            ));
        }
        let s = self.session()?;
        let sess = Arc::clone(&s);
        self.write(move |tx| {
            let payload = ReminderPayload {
                v: 1,
                target_kind: req.target_kind,
                target_id: req.target_id,
                block_id: req.block_id,
                text: req.text,
            };
            match req.id {
                Some(id) => {
                    let rev: i64 = tx
                        .prepare_cached("SELECT rev FROM reminders WHERE id = ?1")?
                        .query_row([&id], |r| r.get(0))
                        .optional()?
                        .ok_or(StoreError::NotFound("reminder"))?;
                    let e = sess.codec.encode(&loc(&id, rev + 1), &payload)?;
                    tx.prepare_cached("UPDATE reminders SET fire_at = ?2, fired_at = NULL, rev = ?3, enc = ?4, payload = ?5 WHERE id = ?1")?
                        .execute(params![id, req.fire_at, rev + 1, e.enc, e.payload])?;
                    Ok(id)
                }
                None => {
                    let id = new_id();
                    let e = sess.codec.encode(&loc(&id, 1), &payload)?;
                    tx.prepare_cached("INSERT INTO reminders (id, fire_at, fired_at, rev, enc, payload) VALUES (?1, ?2, NULL, 1, ?3, ?4)")?
                        .execute(params![id, req.fire_at, e.enc, e.payload])?;
                    Ok(id)
                }
            }
        })
    }

    /// `reminder_delete`.
    pub fn reminder_delete(&self, id: &str) -> Result<()> {
        self.session()?;
        let id = id.to_owned();
        let n =
            self.write(move |tx| Ok(tx.execute("DELETE FROM reminders WHERE id = ?1", [id])?))?;
        if n == 0 {
            return Err(StoreError::NotFound("reminder"));
        }
        Ok(())
    }

    /// `reminder_snooze`: fires again `minutes` (5, 15, 60 or 1440) from now.
    pub fn reminder_snooze(&self, id: &str, minutes: u32) -> Result<()> {
        if !SNOOZE_MINUTES.contains(&minutes) {
            return Err(StoreError::invalid_field(
                "minutes",
                "snooze for 5, 15, 60 or 1440 minutes",
            ));
        }
        self.session()?;
        let at = self.now() + i64::from(minutes) * 60_000;
        let id = id.to_owned();
        let n = self.write(move |tx| {
            Ok(tx
                .prepare_cached("UPDATE reminders SET fire_at = ?2, fired_at = NULL WHERE id = ?1")?
                .execute(params![id, at])?)
        })?;
        if n == 0 {
            return Err(StoreError::NotFound("reminder"));
        }
        Ok(())
    }

    /// Unfired reminders with `fire_at <= now`.
    pub fn reminders_due(&self, now: Ts) -> Result<Vec<Reminder>> {
        let s = self.session()?;
        self.read(|c| {
            query(
                c,
                &s.codec,
                &format!("SELECT {COLS} FROM reminders WHERE fired_at IS NULL AND fire_at <= ?1 ORDER BY fire_at LIMIT {MAX_LIST}"),
                [now],
            )
        })
    }

    /// Marks reminders as fired.
    pub fn reminders_mark_fired(&self, ids: &[String], at: Ts) -> Result<()> {
        self.session()?;
        let ids = ids.to_vec();
        self.write(move |tx| {
            for id in ids {
                tx.prepare_cached(
                    "UPDATE reminders SET fired_at = ?2 WHERE id = ?1 AND fired_at IS NULL",
                )?
                .execute(params![id, at])?;
            }
            Ok(())
        })
    }

    /// The next unfired reminder time (the scheduler sleeps until then). Readable while locked: it is plaintext.
    pub fn reminder_next_at(&self) -> Result<Option<Ts>> {
        self.read(|c| {
            Ok(
                c.prepare_cached("SELECT min(fire_at) FROM reminders WHERE fired_at IS NULL")?
                    .query_row([], |r| r.get::<_, Option<i64>>(0))?,
            )
        })
    }

    /// Deletes fired reminders older than `before` (maintenance).
    pub fn reminders_purge_fired(&self, before: Ts) -> Result<usize> {
        self.session()?;
        self.write(move |tx| {
            Ok(tx
                .prepare_cached(
                    "DELETE FROM reminders WHERE fired_at IS NOT NULL AND fired_at < ?1",
                )?
                .execute([before])?)
        })
    }
}
