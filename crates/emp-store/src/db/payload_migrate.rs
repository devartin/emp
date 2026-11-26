//! Deferred payload migrations (SPEC §10.3).
//!
//! A change that needs decrypted payloads cannot run as a structural migration (the vault may be locked when it is
//! opened). Instead the structural migration appends the change's id to `vault_meta.pending_payload_migrations`
//! (a JSON array), and after unlock [`Store::payload_migrations_run`] rewrites the affected table in batches of
//! [`BATCH`] rows, one transaction per batch. Each batch also stores its cursor in the pending entry, so the job is
//! resumable after a crash or lock, and a migration function must be idempotent (it may see a row twice if a batch
//! is retried). Until a migration finishes, readers keep upcasting old payloads lazily ([`crate::codec::upcast`]).
//!
//! v1 registers no payload migrations ([`PAYLOAD_MIGRATIONS`] is empty); the runner is the mechanism later schema
//! versions use. `versions` snapshots are never rewritten (they are historical and upcast on read).

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

/// Every payload migration this build knows (none in v1).
pub const PAYLOAD_MIGRATIONS: &[PayloadMigration] = &[];

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
}
