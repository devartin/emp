//! Versions (SPEC §10.2 `versions`, §11.3 Versions, D-24 retention).
//!
//! Payloads are `{v, label?, snapshot}`, zstd-compressed in both vault modes and sealed when encrypted. The
//! reason and timestamps are plaintext (§9.20).
//!
//! **Retention (D-24)** — [`thin_plan`]: everything newer than 24 h is kept at 10-minute granularity, then hourly up
//! to 7 days, daily up to 90 days, weekly after that; at most 500 versions per target. The newest version in each
//! bucket survives. Manual (named) versions are never thinned, only dropped by the cap after every automatic one.

use std::collections::HashSet;
use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::codec::{Codec, RecordLoc};
use crate::model::{
    TipTapDoc, VersionMeta, VersionPayload, VersionReason, VersionTargetKind, ids::new_id,
};
use crate::repo::docs::{insert_or_replace_doc, load_doc};
use crate::vault::StoreEvent;
use crate::{Result, Store, StoreError};

/// Maximum versions per target.
pub const MAX_VERSIONS_PER_TARGET: usize = 500;
const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;
const DAY: i64 = 24 * HOUR;

fn version_loc(id: &str) -> RecordLoc {
    RecordLoc::row(TableTag::Versions, id, 0)
}

/// Inserts a version row and returns its meta.
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_version(
    tx: &Connection,
    codec: &Codec,
    target_id: &str,
    kind: VersionTargetKind,
    reason: VersionReason,
    label: Option<String>,
    snapshot: &Value,
    now: i64,
) -> Result<VersionMeta> {
    let id = new_id();
    let payload = VersionPayload {
        v: 1,
        label: label.clone(),
        snapshot: snapshot.clone(),
    };
    let e = codec.encode(&version_loc(&id), &payload)?;
    let size = i64::try_from(e.payload.len()).unwrap_or(i64::MAX);
    tx.prepare_cached(
        "INSERT INTO versions (id, target_id, target_kind, created_at, reason, stored_size, enc, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![id, target_id, kind.as_str(), now, reason.as_str(), size, e.enc, e.payload])?;
    Ok(VersionMeta {
        id,
        created_at: now,
        reason: reason.as_str().into(),
        label,
        size,
    })
}

/// Time of the newest version of a target.
pub(crate) fn last_version_at(conn: &Connection, target_id: &str) -> Result<Option<i64>> {
    Ok(conn
        .prepare_cached("SELECT max(created_at) FROM versions WHERE target_id = ?1")?
        .query_row([target_id], |r| r.get::<_, Option<i64>>(0))?)
}

/// One version as seen by the retention planner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionItem {
    /// Version id.
    pub id: String,
    /// Creation time.
    pub created_at: i64,
    /// Manual versions are exempt from thinning.
    pub manual: bool,
}

/// Which versions to delete under D-24 at time `now`.
#[must_use]
pub fn thin_plan(items: &[RetentionItem], now: i64) -> Vec<String> {
    let mut sorted: Vec<&RetentionItem> = items.iter().collect();
    sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    let mut seen: HashSet<(u8, i64)> = HashSet::new();
    let mut delete: Vec<String> = Vec::new();
    let mut kept: Vec<&RetentionItem> = Vec::new();
    for it in sorted {
        if it.manual {
            kept.push(it);
            continue;
        }
        let age = (now - it.created_at).max(0);
        let bucket = if age < DAY {
            (0, it.created_at.div_euclid(10 * MIN))
        } else if age < 7 * DAY {
            (1, it.created_at.div_euclid(HOUR))
        } else if age < 90 * DAY {
            (2, it.created_at.div_euclid(DAY))
        } else {
            (3, it.created_at.div_euclid(7 * DAY))
        };
        if seen.insert(bucket) {
            kept.push(it);
        } else {
            delete.push(it.id.clone());
        }
    }
    if kept.len() > MAX_VERSIONS_PER_TARGET {
        // Drop the oldest automatic versions first, then the oldest manual ones.
        kept.sort_by(|a, b| {
            a.manual
                .cmp(&b.manual)
                .then(a.created_at.cmp(&b.created_at))
        });
        let excess = kept.len() - MAX_VERSIONS_PER_TARGET;
        delete.extend(kept.iter().take(excess).map(|i| i.id.clone()));
    }
    delete
}

impl Store {
    /// `version_list`, newest first.
    pub fn version_list(
        &self,
        target_id: &str,
        kind: VersionTargetKind,
    ) -> Result<Vec<VersionMeta>> {
        let s = self.session()?;
        let rows: Vec<(String, i64, String, i64, i64, Vec<u8>)> = self.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, created_at, reason, stored_size, enc, payload FROM versions
                 WHERE target_id = ?1 AND target_kind = ?2 ORDER BY created_at DESC, id DESC",
            )?;
            let rows = st.query_map(params![target_id, kind.as_str()], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        rows.into_iter()
            .map(|(id, created_at, reason, size, enc, payload)| {
                let label = if reason == "manual" {
                    let p: VersionPayload = s.codec.decode(&version_loc(&id), enc, &payload)?;
                    p.label
                } else {
                    None
                };
                Ok(VersionMeta {
                    id,
                    created_at,
                    reason,
                    label,
                    size,
                })
            })
            .collect()
    }

    fn version_row(&self, id: &str) -> Result<(String, VersionTargetKind, VersionPayload)> {
        let s = self.session()?;
        let raw: Option<(String, String, i64, Vec<u8>)> = self.read(|c| {
            Ok(c.prepare_cached(
                "SELECT target_id, target_kind, enc, payload FROM versions WHERE id = ?1",
            )?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?)
        })?;
        let (target, kind, enc, payload) = raw.ok_or(StoreError::NotFound("version"))?;
        let kind = VersionTargetKind::parse(&kind)
            .ok_or_else(|| StoreError::Integrity("version kind".into()))?;
        Ok((
            target,
            kind,
            s.codec.decode(&version_loc(id), enc, &payload)?,
        ))
    }

    /// `version_get`.
    pub fn version_get(&self, id: &str) -> Result<Value> {
        Ok(self.version_row(id)?.2.snapshot)
    }

    /// Stores a version with an explicit snapshot (for workbooks, rows and schemas owned by other repositories).
    pub fn version_insert(
        &self,
        target_id: &str,
        kind: VersionTargetKind,
        reason: VersionReason,
        label: Option<String>,
        snapshot: Value,
    ) -> Result<VersionMeta> {
        let s = self.session()?;
        let now = self.now();
        let target = target_id.to_owned();
        self.write(move |tx| {
            insert_version(tx, &s.codec, &target, kind, reason, label, &snapshot, now)
        })
    }

    /// `version_create`: a manual, labelled version of the current page document or workbook (SPEC §11.3:
    /// `targetKind: 'page_doc'|'workbook'`).
    pub fn version_create(
        &self,
        target_id: &str,
        kind: VersionTargetKind,
        label: &str,
    ) -> Result<VersionMeta> {
        crate::model::validate_title(label)?;
        if kind == VersionTargetKind::Workbook {
            return self.workbook_version_create(target_id, label);
        }
        if kind != VersionTargetKind::PageDoc {
            return Err(StoreError::Unsupported(
                "only page documents and workbooks are versioned by this call",
            ));
        }
        let s = self.session()?;
        let now = self.now();
        let (target, label) = (target_id.to_owned(), label.to_owned());
        self.write(move |tx| {
            let (doc, _) =
                load_doc(tx, &s.codec, &target)?.ok_or(StoreError::NotFound("document"))?;
            insert_version(
                tx,
                &s.codec,
                &target,
                kind,
                VersionReason::Manual,
                Some(label).filter(|l| !l.is_empty()),
                &serde_json::to_value(&doc)?,
                now,
            )
        })
    }

    /// `version_restore`: saves the current state as a `pre_restore` version, then writes the snapshot as a new
    /// revision. Page documents return the new doc rev, workbooks the new workbook rev and database schemas
    /// (`pre_bulk` versions taken before a type conversion) the new schema rev.
    pub fn version_restore(&self, id: &str) -> Result<i64> {
        let (target, kind, payload) = self.version_row(id)?;
        match kind {
            VersionTargetKind::PageDoc => {}
            VersionTargetKind::Workbook => {
                return self.workbook_version_restore(&target, payload.snapshot);
            }
            VersionTargetKind::DbSchema => {
                return self.db_schema_version_restore(&target, payload.snapshot);
            }
            _ => {
                return Err(StoreError::Unsupported(
                    "versions of this kind cannot be restored",
                ));
            }
        }
        let mut doc: TipTapDoc = crate::doc::migrate::migrate(payload.snapshot)?;
        crate::doc::schema::normalize(&mut doc)?;
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let t = target.clone();
        let doc_tx = doc.clone();
        let rev = self.write(move |tx| {
            let cur = load_doc(tx, &sess.codec, &t)?;
            let rev = cur.as_ref().map_or(0, |c| c.1);
            if let Some((cur_doc, _)) = cur {
                insert_version(
                    tx,
                    &sess.codec,
                    &t,
                    VersionTargetKind::PageDoc,
                    VersionReason::PreRestore,
                    None,
                    &serde_json::to_value(&cur_doc)?,
                    now,
                )?;
            }
            insert_or_replace_doc(tx, &sess.codec, &t, "page", &doc_tx, rev + 1, now)?;
            Ok(rev + 1)
        })?;
        if let Ok(Some(meta)) = crate::repo::pages::session_meta(self, &s, &target) {
            self.index_page(&s, &meta, Some(&doc));
        }
        self.emit(StoreEvent::PageChanged {
            id: target,
            meta_rev: None,
            doc_rev: Some(rev),
        });
        Ok(rev)
    }

    /// `version_delete`.
    pub fn version_delete(&self, id: &str) -> Result<()> {
        self.session()?;
        let id = id.to_owned();
        let n =
            self.write(move |tx| Ok(tx.execute("DELETE FROM versions WHERE id = ?1", [id])?))?;
        if n == 0 {
            return Err(StoreError::NotFound("version"));
        }
        Ok(())
    }

    /// Applies D-24 thinning to one target. Returns the number of deleted versions.
    pub fn versions_thin(&self, target_id: &str) -> Result<usize> {
        self.session()?;
        let now = self.now();
        let target = target_id.to_owned();
        self.write(move |tx| {
            let items: Vec<RetentionItem> = {
                let mut st = tx.prepare_cached(
                    "SELECT id, created_at, reason FROM versions WHERE target_id = ?1",
                )?;
                let rows = st.query_map([&target], |r| {
                    Ok(RetentionItem {
                        id: r.get(0)?,
                        created_at: r.get(1)?,
                        manual: r.get::<_, String>(2)? == "manual",
                    })
                })?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let del = thin_plan(&items, now);
            for id in &del {
                tx.prepare_cached("DELETE FROM versions WHERE id = ?1")?
                    .execute([id])?;
            }
            Ok(del.len())
        })
    }

    /// Thins every target (idle job after unlock).
    pub fn versions_thin_all(&self) -> Result<usize> {
        self.session()?;
        let targets: Vec<String> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT DISTINCT target_id FROM versions")?;
            let rows = st.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        let mut n = 0;
        for t in targets {
            n += self.versions_thin(&t)?;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: usize, at: i64, manual: bool) -> RetentionItem {
        RetentionItem {
            id: format!("v{id:05}"),
            created_at: at,
            manual,
        }
    }

    #[test]
    fn recent_versions_keep_ten_minute_granularity() {
        let now = 100 * DAY;
        // One version per minute for the last 2 hours.
        let items: Vec<_> = (0..120)
            .map(|i| item(i, now - i as i64 * MIN, false))
            .collect();
        let del = thin_plan(&items, now);
        let kept = items.len() - del.len();
        assert!((12..=13).contains(&kept), "kept {kept}");
    }

    #[test]
    fn older_versions_thin_to_hourly_daily_weekly() {
        let now = 1000 * DAY;
        let mut items = Vec::new();
        // Every 10 minutes for 200 days.
        for i in 0..(200 * 144) {
            items.push(item(i, now - i as i64 * 10 * MIN, false));
        }
        let del: HashSet<String> = thin_plan(&items, now).into_iter().collect();
        let kept: Vec<&RetentionItem> = items.iter().filter(|i| !del.contains(&i.id)).collect();
        let in_range = |lo: i64, hi: i64| {
            kept.iter()
                .filter(|i| now - i.created_at >= lo && now - i.created_at < hi)
                .count()
        };
        assert!((144..=145).contains(&in_range(0, DAY)));
        assert!(
            (143..=146).contains(&in_range(DAY, 7 * DAY)),
            "{}",
            in_range(DAY, 7 * DAY)
        );
        assert!((82..=84).contains(&in_range(7 * DAY, 90 * DAY)));
        assert!(in_range(90 * DAY, 200 * DAY) <= 17);
        assert!(kept.len() <= MAX_VERSIONS_PER_TARGET);
    }

    #[test]
    fn manual_versions_survive_thinning_and_cap_prefers_auto() {
        let now = 10 * DAY;
        let items = vec![
            item(1, now - 5 * MIN, true),
            item(2, now - 6 * MIN, true),
            item(3, now - 7 * MIN, false),
        ];
        assert!(thin_plan(&items, now).is_empty());
        let mut many: Vec<_> = (0..600)
            .map(|i| item(i, now - i as i64 * 7 * DAY, false))
            .collect();
        many.push(item(9999, 0, true));
        let del = thin_plan(&many, now * 1000);
        assert!(!del.contains(&"v09999".to_string()));
        assert_eq!(many.len() - del.len(), MAX_VERSIONS_PER_TARGET);
    }
}
