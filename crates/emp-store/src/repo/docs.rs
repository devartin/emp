//! Documents (SPEC §10.2 `page_docs`, D-08: one TipTap JSON document per page or row page, stored as one record).
//!
//! `page_save_doc` uses optimistic concurrency: `baseRev` must equal the stored rev (0 when no doc exists yet),
//! otherwise `CONFLICT {currentRev}`. Saved documents are normalised (§7.1 invariants), re-indexed for search and
//! backlinks, and automatically versioned per §7.8 (≥ 64 changed characters and the last version ≥ 10 minutes old).

use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{Connection, OptionalExtension, params};

use crate::codec::{Codec, RecordLoc};
use crate::doc::index::{changed_chars, extract};
use crate::doc::migrate::migrate;
use crate::doc::schema::normalize;
use crate::model::{DocOwnerKind, DocPayload, TipTapDoc, VersionReason, VersionTargetKind};
use crate::repo::pages::{load_meta, load_page};
use crate::repo::versions::{insert_version, last_version_at};
use crate::vault::StoreEvent;
use crate::{Result, Store, StoreError};

/// Documents larger than this (serialised) are rejected.
pub const MAX_DOC_BYTES: usize = 32 * 1024 * 1024;
/// Above this size the UI suggests splitting the page (§7.11).
pub const LARGE_DOC_BYTES: usize = 2 * 1024 * 1024;
/// Characters changed before an automatic version is considered.
pub const AUTO_VERSION_CHARS: usize = 64;
/// Minimum age of the previous version before an automatic one is taken.
pub const AUTO_VERSION_INTERVAL_MS: i64 = 10 * 60 * 1000;
/// `page_docs.payload.format`.
pub const DOC_FORMAT: &str = "tiptap-json@1";

fn doc_loc(owner: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::PageDocs, owner, u64::try_from(rev).unwrap_or(0))
}

/// Loads a document and its rev.
pub(crate) fn load_doc(
    conn: &Connection,
    codec: &Codec,
    owner: &str,
) -> Result<Option<(TipTapDoc, i64)>> {
    let raw: Option<(i64, i64, Vec<u8>)> = conn
        .prepare_cached("SELECT rev, enc, payload FROM page_docs WHERE owner_id = ?1")?
        .query_row([owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    raw.map(|(rev, enc, payload)| {
        let v = codec.decode_value(&doc_loc(owner, rev), enc, &payload)?;
        let doc = v
            .get("doc")
            .cloned()
            .ok_or_else(|| StoreError::Integrity("document payload without doc".into()))?;
        Ok((migrate(doc)?, rev))
    })
    .transpose()
}

/// Writes a document at `rev`.
pub(crate) fn insert_or_replace_doc(
    tx: &Connection,
    codec: &Codec,
    owner: &str,
    owner_kind: &str,
    doc: &TipTapDoc,
    rev: i64,
    now: i64,
) -> Result<()> {
    let payload = DocPayload {
        v: 1,
        format: DOC_FORMAT.into(),
        doc: doc.clone(),
    };
    let e = codec.encode(&doc_loc(owner, rev), &payload)?;
    tx.prepare_cached(
        "INSERT INTO page_docs (owner_id, owner_kind, rev, updated_at, enc, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(owner_id) DO UPDATE SET owner_kind = excluded.owner_kind, rev = excluded.rev,
         updated_at = excluded.updated_at, enc = excluded.enc, payload = excluded.payload",
    )?
    .execute(params![owner, owner_kind, rev, now, e.enc, e.payload])?;
    if owner_kind == "page" {
        tx.prepare_cached("UPDATE pages SET updated_at = ?2 WHERE id = ?1")?
            .execute(params![owner, now])?;
    }
    Ok(())
}

impl Store {
    /// `page_save_doc`. Returns the new rev, or `CONFLICT {currentRev}` when `base_rev` is stale.
    pub fn page_save_doc(
        &self,
        owner_id: &str,
        owner_kind: DocOwnerKind,
        mut doc: TipTapDoc,
        base_rev: i64,
    ) -> Result<i64> {
        let size = serde_json::to_vec(&doc)?.len();
        if size > MAX_DOC_BYTES {
            return Err(StoreError::TooLarge("document"));
        }
        normalize(&mut doc)?;
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let owner = owner_id.to_owned();
        let new_text = extract(&doc).full_text();
        let doc_for_tx = doc.clone();
        let (rev, versioned, row_db) = self.write(move |tx| {
            let codec = &sess.codec;
            match owner_kind {
                DocOwnerKind::Page => {
                    let row = load_page(tx, &owner)?.ok_or(StoreError::NotFound("page"))?;
                    if row.deleted_at.is_some() {
                        return Err(StoreError::invalid("the page is in the trash"));
                    }
                }
                DocOwnerKind::Row => {
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM db_rows WHERE id = ?1)",
                        [&owner],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        return Err(StoreError::NotFound("row"));
                    }
                }
            }
            let current = load_doc(tx, codec, &owner)?;
            let current_rev = current.as_ref().map_or(0, |c| c.1);
            if current_rev != base_rev {
                return Err(StoreError::Conflict { current_rev });
            }
            let new_rev = current_rev + 1;
            insert_or_replace_doc(
                tx,
                codec,
                &owner,
                owner_kind.as_str(),
                &doc_for_tx,
                new_rev,
                now,
            )?;
            // A row body edit is a row edit (§8.1 `updated_time`): touch the row and its database's data rev.
            let row_db = if owner_kind == DocOwnerKind::Row {
                tx.prepare_cached("UPDATE db_rows SET updated_at = ?2 WHERE id = ?1")?
                    .execute(rusqlite::params![owner, now])?;
                let db: String = tx.query_row(
                    "SELECT database_id FROM db_rows WHERE id = ?1",
                    [&owner],
                    |r| r.get(0),
                )?;
                crate::repo::databases::bump(tx, &db, false, true)?;
                Some(db)
            } else {
                None
            };
            // Automatic versions (§7.8).
            let old_text = current
                .as_ref()
                .map(|(d, _)| extract(d).full_text())
                .unwrap_or_default();
            let delta = changed_chars(&old_text, &new_text);
            let mut versioned = false;
            if owner_kind == DocOwnerKind::Page {
                let mut edits = sess.edits.lock();
                let stats = edits.entry(owner.clone()).or_default();
                stats.changed_chars += delta;
                if stats.changed_chars >= AUTO_VERSION_CHARS {
                    let last = last_version_at(tx, &owner)?;
                    if last.is_none_or(|t| now - t >= AUTO_VERSION_INTERVAL_MS) {
                        insert_version(
                            tx,
                            codec,
                            &owner,
                            VersionTargetKind::PageDoc,
                            VersionReason::Auto,
                            None,
                            &serde_json::to_value(&doc_for_tx)?,
                            now,
                        )?;
                        stats.changed_chars = 0;
                        versioned = true;
                    }
                }
            }
            Ok((new_rev, versioned, row_db))
        })?;
        let _ = versioned;
        if let Some(db) = row_db {
            // Re-index the row (its body is searchable) before telling views about it.
            let _ = self.rows_dto(&s, &db, &[owner_id.to_owned()]);
            self.db_changed_rows(&db, Some(vec![owner_id.to_owned()]));
        }
        if owner_kind == DocOwnerKind::Page {
            if let Ok(Some(meta)) = self.read(|c| load_meta(c, &s.codec, owner_id)) {
                self.index_page(&s, &meta, Some(&doc));
            }
        }
        self.emit(StoreEvent::PageChanged {
            id: owner_id.to_owned(),
            meta_rev: None,
            doc_rev: Some(rev),
        });
        Ok(rev)
    }

    /// Takes an automatic version if the page was edited since its last version (page close / switch, §7.8).
    /// Returns whether a version was written.
    pub fn version_checkpoint(&self, page_id: &str) -> Result<bool> {
        let s = self.session()?;
        let pending = s
            .edits
            .lock()
            .get(page_id)
            .is_some_and(|e| e.changed_chars > 0);
        if !pending {
            return Ok(false);
        }
        let now = self.now();
        let sess = Arc::clone(&s);
        let id = page_id.to_owned();
        let wrote = self.write(move |tx| {
            let Some((doc, _)) = load_doc(tx, &sess.codec, &id)? else {
                return Ok(false);
            };
            insert_version(
                tx,
                &sess.codec,
                &id,
                VersionTargetKind::PageDoc,
                VersionReason::Auto,
                None,
                &serde_json::to_value(&doc)?,
                now,
            )?;
            Ok(true)
        })?;
        s.edits.lock().remove(page_id);
        Ok(wrote)
    }

    /// The current document of a page or row page, with its rev.
    pub fn doc_get(&self, owner_id: &str) -> Result<Option<(TipTapDoc, i64)>> {
        let s = self.session()?;
        self.read(|c| load_doc(c, &s.codec, owner_id))
    }
}
