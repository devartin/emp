//! Deferred payload migrations (SPEC §10.3).
//!
//! A change that needs decrypted payloads cannot run as a structural migration (the vault may be locked when it is
//! opened). Instead the structural migration appends the change's id to `vault_meta.pending_payload_migrations`
//! (a JSON array), and after unlock [`Store::payload_migrations_run`] rewrites the affected table in batches of
//! [`BATCH`] rows, one transaction per batch. Each batch also stores its cursor in the pending entry, so the job is
//! resumable after a crash or lock, and a migration function must be idempotent (it may see a row twice if a batch
//! is retried). Until a migration finishes, readers keep upcasting old payloads lazily ([`crate::codec::upcast`]).
//!
//! Schema v2 registers the emoji → Lucide icon rewrite ([`ICON_MIGRATIONS`]: workspace icons, page icons,
//! database row-template icons, database row icons and the icons inside page documents, callouts included). `versions` snapshots are never rewritten (they are historical and upcast on read).

use emp_crypto::TableTag;
use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::tables::{KeyShape, PAYLOAD_TABLES, TableDesc};
use crate::vault::{meta_get_str, meta_set};
use crate::{Progress, Result, Store, StoreError};

/// Rows rewritten per transaction.
pub const BATCH: usize = 500;

/// `vault_meta` key of the pending list.
pub const PENDING_KEY: &str = "pending_payload_migrations";

/// One registered payload migration.
#[derive(Clone, Copy)]
pub struct PayloadMigration {
    /// Stable id recorded in the pending list.
    pub id: &'static str,
    /// The table whose payloads it rewrites.
    pub table: TableTag,
    /// Rewrites one decoded payload; `None` leaves the row untouched. Must be idempotent.
    pub apply: fn(Value) -> Result<Option<Value>>,
}

impl std::fmt::Debug for PayloadMigration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PayloadMigration")
            .field("id", &self.id)
            .field("table", &self.table)
            .finish_non_exhaustive()
    }
}

/// Workspace payloads: `icon`.
fn icons_workspace(mut v: Value) -> Result<Option<Value>> {
    let changed = v
        .as_object_mut()
        .is_some_and(|o| crate::icons::migrate_icon_field(o, "icon"));
    Ok(changed.then_some(v))
}

/// Page payloads (pages, databases, dashboards, ...): `icon`.
fn icons_page(v: Value) -> Result<Option<Value>> {
    icons_workspace(v)
}

/// Database payloads: `rowTemplates[].icon`.
fn icons_database(mut v: Value) -> Result<Option<Value>> {
    let mut changed = false;
    if let Some(list) = v.get_mut("rowTemplates").and_then(Value::as_array_mut) {
        for t in list.iter_mut().filter_map(Value::as_object_mut) {
            changed |= crate::icons::migrate_icon_field(t, "icon");
        }
    }
    Ok(changed.then_some(v))
}

/// Database row payloads: `icon` (rows created from an emoji row template copied it).
fn icons_row(v: Value) -> Result<Option<Value>> {
    icons_workspace(v)
}

/// Page documents (`{v, format, doc}`): callout icons and other nodes' icon attributes ([`crate::icons::migrate_doc_icons`]).
fn icons_doc(mut v: Value) -> Result<Option<Value>> {
    let changed = v
        .get_mut("doc")
        .is_some_and(crate::icons::migrate_doc_icons);
    Ok(changed.then_some(v))
}

/// Schema v2: emoji icons become Lucide icons through the canonical map (`src/ui/icons/emoji-map.json`); unmapped
/// emoji lose their icon, except callouts, which fall back to `lightbulb` (legacy bare-string callout icons from the
/// old importers included). Idempotent (a migrated payload has no emoji icon left). Mirrors the mock's
/// `migrateIcons` (`src/backend/mock/persist.ts`).
pub const ICON_MIGRATIONS: &[PayloadMigration] = &[
    PayloadMigration {
        id: "v2-icons-lucide-workspaces",
        table: TableTag::Workspaces,
        apply: icons_workspace,
    },
    PayloadMigration {
        id: "v2-icons-lucide-pages",
        table: TableTag::Pages,
        apply: icons_page,
    },
    PayloadMigration {
        id: "v2-icons-lucide-databases",
        table: TableTag::Databases,
        apply: icons_database,
    },
    PayloadMigration {
        id: "v2-icons-lucide-rows",
        table: TableTag::DbRows,
        apply: icons_row,
    },
    PayloadMigration {
        id: "v2-icons-lucide-docs",
        table: TableTag::PageDocs,
        apply: icons_doc,
    },
];

/// Every payload migration this build knows.
pub const PAYLOAD_MIGRATIONS: &[PayloadMigration] = ICON_MIGRATIONS;

/// An entry of the pending list: a bare id, or an id with the key of the last rewritten row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PendingMigration {
    /// Not started.
    Id(String),
    /// Started; resume after `after`.
    Resume {
        /// Migration id.
        id: String,
        /// Key columns of the last rewritten row (`[k1]` or `[k1, k2]`).
        #[serde(default)]
        after: Option<Vec<Value>>,
    },
}

impl PendingMigration {
    /// The migration id.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Id(id) | Self::Resume { id, .. } => id,
        }
    }

    fn after(&self) -> Option<&[Value]> {
        match self {
            Self::Id(_) => None,
            Self::Resume { after, .. } => after.as_deref(),
        }
    }
}

/// Reads the pending list (an unreadable list counts as empty: reads upcast lazily either way).
pub(crate) fn pending(conn: &rusqlite::Connection) -> Result<Vec<PendingMigration>> {
    Ok(meta_get_str(conn, PENDING_KEY)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn write_pending(conn: &rusqlite::Connection, list: &[PendingMigration]) -> Result<()> {
    meta_set(conn, PENDING_KEY, &serde_json::to_vec(list)?)
}

/// Appends `id` to the pending list (called by structural migrations; a no-op when already listed).
pub fn schedule(conn: &rusqlite::Connection, id: &str) -> Result<()> {
    let mut list = pending(conn)?;
    if !list.iter().any(|p| p.id() == id) {
        list.push(PendingMigration::Id(id.to_owned()));
        write_pending(conn, &list)?;
    }
    Ok(())
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Number(n) => n.as_i64().map_or(SqlValue::Null, SqlValue::Integer),
        Value::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Null,
    }
}

fn from_sql(v: rusqlite::types::ValueRef<'_>) -> Value {
    match v {
        rusqlite::types::ValueRef::Integer(i) => Value::from(i),
        rusqlite::types::ValueRef::Text(t) => {
            Value::String(String::from_utf8_lossy(t).into_owned())
        }
        _ => Value::Null,
    }
}

/// Rewrites one batch after `after`. Returns the key of the last row seen, or `None` when the table is done.
fn run_batch(
    tx: &rusqlite::Transaction<'_>,
    d: &TableDesc,
    codec: &crate::codec::Codec,
    m: &PayloadMigration,
    after: Option<&[Value]>,
) -> Result<(usize, Option<Vec<Value>>)> {
    let (k1, k2) = d.key.columns();
    let single = matches!(d.key, KeyShape::Id(_));
    let (cond, order) = if single {
        (format!("{k1} > ?1"), k1.to_owned())
    } else {
        (
            format!("({k1} > ?1 OR ({k1} = ?1 AND {k2} > ?2))"),
            format!("{k1}, {k2}"),
        )
    };
    let mut args: Vec<SqlValue> = Vec::new();
    let sql = match after {
        Some(a) => {
            args.push(a.first().map_or(SqlValue::Null, to_sql));
            if !single {
                args.push(a.get(1).map_or(SqlValue::Null, to_sql));
            }
            format!(
                "{} WHERE {cond} ORDER BY {order} LIMIT {BATCH}",
                d.select_sql()
            )
        }
        None => format!("{} ORDER BY {order} LIMIT {BATCH}", d.select_sql()),
    };
    type RawRow = (String, SqlValue, String, i64, i64, Vec<u8>);
    let rows: Vec<RawRow> = {
        let mut st = tx.prepare(&sql)?;
        let mut q = st.query(params_from_iter(args.iter()))?;
        let mut out = Vec::new();
        while let Some(r) = q.next()? {
            out.push((
                r.get(0)?,
                r.get::<_, SqlValue>(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ));
        }
        out
    };
    let update = format!(
        "UPDATE {} SET enc = ?1, payload = ?2 WHERE {}",
        d.name(),
        d.key_where().replace("?2", "?4").replace("?1", "?3")
    );
    let mut changed = 0;
    let mut last = None;
    for (key1, key2, kind, rev, enc, payload) in &rows {
        let k2_ref = rusqlite::types::ValueRef::from(key2);
        last = Some(if single {
            vec![Value::String(key1.clone())]
        } else {
            vec![Value::String(key1.clone()), from_sql(k2_ref)]
        });
        let loc = d.loc(key1, k2_ref, kind, *rev)?;
        let body = match codec.open_body(&loc, *enc, payload) {
            Ok(b) => b,
            // Damaged records stay as they are; the integrity check reports them.
            Err(StoreError::Damaged { .. }) => continue,
            Err(e) => return Err(e),
        };
        let value: Value = serde_json::from_slice(&body)?;
        let Some(next) = (m.apply)(value)? else {
            continue;
        };
        let bytes = serde_json::to_vec(&next)?;
        let e = codec.store_body(&loc, &bytes, *enc == 1)?;
        let mut st = tx.prepare_cached(&update)?;
        if single {
            st.execute(rusqlite::params![e.enc, e.payload, key1])?;
        } else {
            st.execute(rusqlite::params![e.enc, e.payload, key1, key2])?;
        }
        changed += 1;
    }
    let done = rows.len() < BATCH;
    Ok((changed, if done { None } else { last }))
}

impl Store {
    /// Runs the pending deferred payload migrations of this build ([`PAYLOAD_MIGRATIONS`]). Called after unlock;
    /// resumable and idempotent. Returns the number of rewritten rows. Ids this build does not know stay pending.
    pub fn payload_migrations_run(&self, progress: &dyn Progress) -> Result<usize> {
        self.payload_migrations_run_with(PAYLOAD_MIGRATIONS, progress)
    }

    /// [`Self::payload_migrations_run`] with an explicit registry (tests and tooling).
    pub fn payload_migrations_run_with(
        &self,
        registry: &[PayloadMigration],
        progress: &dyn Progress,
    ) -> Result<usize> {
        let session = self.session()?;
        let mut total = 0usize;
        let ids: Vec<String> = self
            .read(pending)?
            .iter()
            .map(|p| p.id().to_owned())
            .collect();
        for id in ids {
            let Some(m) = registry.iter().find(|m| m.id == id).copied() else {
                continue;
            };
            let d = *PAYLOAD_TABLES
                .iter()
                .find(|d| d.tag == m.table)
                .ok_or_else(|| StoreError::Internal(format!("no payload table for {id}")))?;
            if d.tag == TableTag::Versions {
                return Err(StoreError::Internal(
                    "version snapshots are never migrated".into(),
                ));
            }
            loop {
                if progress.cancelled() {
                    return Err(StoreError::Cancelled);
                }
                let s = std::sync::Arc::clone(&session);
                let mid = id.clone();
                let (n, finished) = self.write(move |tx| {
                    let mut list = pending(tx)?;
                    let Some(pos) = list.iter().position(|p| p.id() == mid) else {
                        return Ok((0, true));
                    };
                    let after = list[pos].after().map(<[Value]>::to_vec);
                    let (n, next) = run_batch(tx, &d, &s.codec, &m, after.as_deref())?;
                    let finished = next.is_none();
                    match next {
                        Some(after) => {
                            list[pos] = PendingMigration::Resume {
                                id: mid,
                                after: Some(after),
                            };
                        }
                        None => {
                            list.remove(pos);
                        }
                    }
                    write_pending(tx, &list)?;
                    Ok((n, finished))
                })?;
                total += n;
                progress.progress(total as u64, 0, &id);
                if finished {
                    break;
                }
            }
        }
        Ok(total)
    }

    /// Pending payload migrations (ids, including ones this build does not know).
    pub fn payload_migrations_pending(&self) -> Result<Vec<String>> {
        Ok(self
            .read(pending)?
            .iter()
            .map(|p| p.id().to_owned())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AutoLock, PageCreate, PageKind};
    use crate::{CreateOptions, NoProgress, StoreOptions};

    fn retitle(mut v: Value) -> Result<Option<Value>> {
        let Some(t) = v.get("title").and_then(Value::as_str) else {
            return Ok(None);
        };
        if t.ends_with(" (migrated)") {
            return Ok(None);
        }
        let nt = format!("{t} (migrated)");
        v["title"] = Value::String(nt);
        Ok(Some(v))
    }

    #[test]
    fn runs_in_batches_resumes_and_finishes() {
        for encrypted in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut opts = StoreOptions::new(dir.path().join("device.key"));
            opts.background_indexing = false;
            let store = Store::create(
                dir.path(),
                CreateOptions {
                    password: encrypted.then(|| "correct horse battery".to_owned().into()),
                    kdf: emp_crypto::KdfParams::INSECURE_TEST,
                    auto_lock: AutoLock::default(),
                    workspace_name: Some("W".into()),
                },
                opts,
            )
            .unwrap()
            .store;
            let ws = store.workspace_list().unwrap().remove(0).id;
            let n = BATCH + 20;
            for i in 0..n {
                store
                    .page_create(PageCreate::new(&ws, None, PageKind::Doc, &format!("P{i}")))
                    .unwrap();
            }
            let reg = [PayloadMigration {
                id: "test-retitle",
                table: TableTag::Pages,
                apply: retitle,
            }];
            store.write(|tx| schedule(tx, "test-retitle")).unwrap();
            store.write(|tx| schedule(tx, "unknown-later")).unwrap();
            assert_eq!(
                store.payload_migrations_pending().unwrap(),
                vec!["test-retitle", "unknown-later"]
            );
            assert_eq!(
                store
                    .payload_migrations_run_with(&reg, &NoProgress)
                    .unwrap(),
                n
            );
            // Unknown ids stay; the finished one is gone; a second run is a no-op.
            assert_eq!(
                store.payload_migrations_pending().unwrap(),
                vec!["unknown-later"]
            );
            assert_eq!(
                store
                    .payload_migrations_run_with(&reg, &NoProgress)
                    .unwrap(),
                0
            );
            let tree = store.page_tree(&ws).unwrap();
            assert!(tree.iter().all(|p| p.title.ends_with(" (migrated)")));
            // The manifest still verifies after the rewrite.
            assert!(store.integrity_check(&NoProgress).unwrap().ok);
            // A resumed entry continues after its cursor (rows before it are left alone).
            let last_two: Vec<String> = {
                let mut ids: Vec<String> = tree.iter().map(|p| p.id.clone()).collect();
                ids.sort();
                ids
            };
            let cursor = last_two[last_two.len() - 3].clone();
            store
                .write(move |tx| {
                    write_pending(
                        tx,
                        &[PendingMigration::Resume {
                            id: "test-retitle-2".into(),
                            after: Some(vec![Value::String(cursor)]),
                        }],
                    )
                })
                .unwrap();
            let reg2 = [PayloadMigration {
                id: "test-retitle-2",
                table: TableTag::Pages,
                apply: |mut v| {
                    v["title"] = Value::String("second".into());
                    Ok(Some(v))
                },
            }];
            assert_eq!(
                store
                    .payload_migrations_run_with(&reg2, &NoProgress)
                    .unwrap(),
                2
            );
            assert!(store.payload_migrations_pending().unwrap().is_empty());
        }
    }

    #[test]
    fn v2_rewrites_emoji_icons_to_lucide() {
        use crate::model::Icon;
        let dir = tempfile::tempdir().unwrap();
        let mut opts = StoreOptions::new(dir.path().join("device.key"));
        opts.background_indexing = false;
        let store = Store::create(
            dir.path(),
            CreateOptions {
                password: Some("correct horse battery".to_owned().into()),
                kdf: emp_crypto::KdfParams::INSECURE_TEST,
                auto_lock: AutoLock::default(),
                workspace_name: Some("W".into()),
            },
            opts,
        )
        .unwrap()
        .store;
        let emoji = |s: &str| Some(Icon::Emoji { v: s.into() });
        let ws = store
            .workspace_create("Rockets", emoji("\u{1F680}"))
            .unwrap()
            .id;
        let mut mapped = PageCreate::new(&ws, None, PageKind::Doc, "Trip");
        mapped.icon = emoji("\u{2708}\u{FE0F}");
        let mapped = store.page_create(mapped).unwrap().meta.id;
        let mut unmapped = PageCreate::new(&ws, None, PageKind::Doc, "Odd");
        unmapped.icon = emoji("\u{1FAE0}\u{1FAE0}");
        let unmapped = store.page_create(unmapped).unwrap().meta.id;
        let mut keep = PageCreate::new(&ws, None, PageKind::Doc, "Lucide");
        keep.icon = Some(Icon::Lucide {
            v: "star".into(),
            color: Some("blue".into()),
        });
        let keep = store.page_create(keep).unwrap().meta.id;
        // A fresh vault starts with nothing pending; an upgraded v1 vault has these scheduled by migration 0002.
        store
            .write(|tx| {
                for m in ICON_MIGRATIONS {
                    schedule(tx, m.id)?;
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(store.payload_migrations_run(&NoProgress).unwrap(), 3);
        assert_eq!(
            store.page_get(&mapped).unwrap().meta.icon,
            Some(Icon::Lucide {
                v: "plane".into(),
                color: None
            })
        );
        assert_eq!(store.page_get(&unmapped).unwrap().meta.icon, None);
        assert_eq!(
            store.page_get(&keep).unwrap().meta.icon,
            Some(Icon::Lucide {
                v: "star".into(),
                color: Some("blue".into())
            })
        );
        let w = store
            .workspace_list()
            .unwrap()
            .into_iter()
            .find(|w| w.id == ws)
            .unwrap();
        assert_eq!(
            w.icon,
            Some(Icon::Lucide {
                v: "rocket".into(),
                color: None
            })
        );
        assert!(store.payload_migrations_pending().unwrap().is_empty());
        assert!(store.integrity_check(&NoProgress).unwrap().ok);
        // Idempotent.
        store
            .write(|tx| schedule(tx, "v2-icons-lucide-pages"))
            .unwrap();
        assert_eq!(store.payload_migrations_run(&NoProgress).unwrap(), 0);
    }

    #[test]
    fn v2_rewrites_row_icons_and_document_callouts() {
        use crate::codec::RecordLoc;
        use crate::model::TipTapDoc;
        // Row payloads: `icon` as on pages.
        let row = serde_json::json!({"values": {}, "icon": {"t": "emoji", "v": "\u{1F680}"}});
        assert_eq!(
            icons_row(row).unwrap().unwrap()["icon"],
            serde_json::json!({"t": "lucide", "v": "rocket"})
        );
        assert!(
            icons_row(serde_json::json!({"values": {}}))
                .unwrap()
                .is_none()
        );

        // A stored document with the old importers' bare-emoji callout icon.
        let dir = tempfile::tempdir().unwrap();
        let mut opts = StoreOptions::new(dir.path().join("device.key"));
        opts.background_indexing = false;
        let store = Store::create(
            dir.path(),
            CreateOptions {
                password: Some("correct horse battery".to_owned().into()),
                kdf: emp_crypto::KdfParams::INSECURE_TEST,
                auto_lock: AutoLock::default(),
                workspace_name: Some("W".into()),
            },
            opts,
        )
        .unwrap()
        .store;
        let ws = store.workspace_list().unwrap().remove(0).id;
        let page = store
            .page_create(PageCreate::new(&ws, None, PageKind::Doc, "Imported"))
            .unwrap()
            .meta
            .id;
        let legacy: TipTapDoc = serde_json::from_value(serde_json::json!({
            "type": "doc", "attrs": {"schemaVersion": 1},
            "content": [{"type": "blockGroup", "content": [{"type": "blockContainer", "attrs": {"id": "b1"},
                "content": [{"type": "callout", "attrs": {"icon": "\u{1F4CB}", "color": "blue"},
                    "content": [{"type": "text", "text": "Typed \u{1F600} stays"}]}]}]}]
        }))
        .unwrap();
        let s = store.session().unwrap();
        let rev = store.doc_get(&page).unwrap().map_or(0, |d| d.1) + 1;
        let (pid, sess) = (page.clone(), std::sync::Arc::clone(&s));
        store
            .write(move |tx| {
                crate::repo::docs::insert_or_replace_doc(
                    tx,
                    &sess.codec,
                    &pid,
                    "page",
                    &legacy,
                    rev,
                    0,
                )
            })
            .unwrap();
        let raw = |store: &Store| -> Value {
            let (pid, sess) = (page.clone(), std::sync::Arc::clone(&s));
            store
                .read(move |c| {
                    let (rev, enc, payload): (i64, i64, Vec<u8>) = c.query_row(
                        "SELECT rev, enc, payload FROM page_docs WHERE owner_id = ?1",
                        [&pid],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )?;
                    let loc =
                        RecordLoc::row(TableTag::PageDocs, &pid, u64::try_from(rev).unwrap_or(0));
                    sess.codec.decode_value(&loc, enc, &payload)
                })
                .unwrap()
        };
        let callout = |v: &Value| v["doc"]["content"][0]["content"][0]["content"][0].clone();
        assert_eq!(
            callout(&raw(&store))["attrs"]["icon"],
            serde_json::json!("\u{1F4CB}")
        );
        // Reads upcast before the payload migration has run.
        let (doc, _) = store.doc_get(&page).unwrap().unwrap();
        let read = serde_json::to_value(doc).unwrap();
        assert_eq!(
            read["content"][0]["content"][0]["content"][0]["attrs"]["icon"],
            serde_json::json!({"t": "lucide", "v": "clipboard-list"})
        );
        store
            .write(|tx| schedule(tx, "v2-icons-lucide-docs"))
            .unwrap();
        assert_eq!(store.payload_migrations_run(&NoProgress).unwrap(), 1);
        let after = callout(&raw(&store));
        assert_eq!(
            after["attrs"]["icon"],
            serde_json::json!({"t": "lucide", "v": "clipboard-list"})
        );
        assert_eq!(after["attrs"]["color"], "blue");
        assert_eq!(after["content"][0]["text"], "Typed \u{1F600} stays");
        assert!(store.integrity_check(&NoProgress).unwrap().ok);
    }

    #[test]
    fn migration_0002_schedules_the_icon_rewrite() {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate::migrate(&mut c, None, 0).unwrap();
        let ids: Vec<String> = pending(&c)
            .unwrap()
            .iter()
            .map(|p| p.id().to_owned())
            .collect();
        assert_eq!(
            ids,
            ICON_MIGRATIONS.iter().map(|m| m.id).collect::<Vec<_>>()
        );
    }
}
