//! Structural migrations (SPEC §10.3 "Structural migrations").
//!
//! Each [`Migration`] runs inside its own transaction and bumps `PRAGMA user_version`. Before the first migration
//! of an existing database runs, a copy is taken with `VACUUM INTO backups/pre-v{N}-{ts}.sqlite` (the last 3 are
//! kept). Opening a database whose `user_version` is newer than [`LATEST_VERSION`] fails with `SCHEMA_TOO_NEW`.

use std::path::Path;

use rusqlite::{Connection, Transaction};

use super::pragmas;
use crate::{Result, StoreError};

/// What a migration does.
pub enum MigrationKind {
    /// A SQL batch.
    Sql(&'static str),
    /// Rust code (for changes SQL cannot express). Must not need decrypted data: those go through
    /// `vault_meta.pending_payload_migrations` after unlock.
    Rust(fn(&Transaction<'_>) -> Result<()>),
}

/// One ordered migration.
pub struct Migration {
    /// The `user_version` after this migration.
    pub version: i64,
    /// Body.
    pub kind: MigrationKind,
}

/// Migration 0001: the complete §10.2 DDL (every table of v1, including those other repos own).
pub const MIGRATION_0001: &str = include_str!("migrations/0001_init.sql");

/// Every migration, in order.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    kind: MigrationKind::Sql(MIGRATION_0001),
}];

/// The newest schema version this build knows.
pub const LATEST_VERSION: i64 = 1;

/// Number of pre-migration backups kept.
pub const KEEP_PRE_MIGRATION_BACKUPS: usize = 3;

/// `PRAGMA user_version`.
pub fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// What [`migrate`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrateOutcome {
    /// Version before.
    pub from: i64,
    /// Version after.
    pub to: i64,
    /// Path of the pre-migration backup, if one was taken.
    pub backup: Option<std::path::PathBuf>,
}

fn table_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
        [],
        |r| r.get(0),
    )?)
}

/// Brings the database up to [`LATEST_VERSION`]. `backup_dir` receives pre-migration copies of existing databases.
pub fn migrate(
    conn: &mut Connection,
    backup_dir: Option<&Path>,
    now_ms: i64,
) -> Result<MigrateOutcome> {
    let from = user_version(conn)?;
    if from > LATEST_VERSION {
        return Err(StoreError::SchemaTooNew {
            found: from,
            known: LATEST_VERSION,
        });
    }
    if from == LATEST_VERSION {
        return Ok(MigrateOutcome {
            from,
            to: from,
            backup: None,
        });
    }
    let mut backup = None;
    if from == 0 && table_count(conn)? == 0 {
        pragmas::apply_creation(conn)?;
    } else if let Some(dir) = backup_dir {
        backup = Some(pre_migration_backup(conn, dir, from, now_ms)?);
    }
    for m in MIGRATIONS.iter().filter(|m| m.version > from) {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        match &m.kind {
            MigrationKind::Sql(sql) => tx.execute_batch(sql)?,
            MigrationKind::Rust(f) => f(&tx)?,
        }
        tx.pragma_update(None, "user_version", m.version)?;
        tx.commit()?;
    }
    Ok(MigrateOutcome {
        from,
        to: LATEST_VERSION,
        backup,
    })
}

fn pre_migration_backup(
    conn: &Connection,
    dir: &Path,
    from: i64,
    now_ms: i64,
) -> Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("pre-v{from}-{now_ms}.sqlite"));
    let p = path
        .to_str()
        .ok_or_else(|| StoreError::Internal("non UTF-8 backup path".into()))?;
    conn.execute("VACUUM INTO ?1", [p])?;
    // Keep the newest KEEP_PRE_MIGRATION_BACKUPS.
    let mut existing: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("pre-v") && n.ends_with(".sqlite"))
        })
        .collect();
    existing.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    while existing.len() > KEEP_PRE_MIGRATION_BACKUPS {
        let old = existing.remove(0);
        let _ = std::fs::remove_file(old);
    }
    Ok(path)
}

/// One schema object: `(type, name, tbl_name)`.
pub type SchemaObject = (String, String, String);

/// The schema objects of `conn` (excluding SQLite internals), sorted.
pub fn schema_objects(conn: &Connection) -> Result<Vec<SchemaObject>> {
    let mut st = conn.prepare(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The exact set of objects a database at [`LATEST_VERSION`] contains (built by migrating an in-memory database).
pub fn expected_schema_objects() -> Result<Vec<SchemaObject>> {
    let mut c = Connection::open_in_memory()?;
    migrate(&mut c, None, 0)?;
    schema_objects(&c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_gets_every_table() {
        let mut c = Connection::open_in_memory().unwrap();
        let out = migrate(&mut c, None, 0).unwrap();
        assert_eq!(out.to, LATEST_VERSION);
        let tables: Vec<String> = schema_objects(&c)
            .unwrap()
            .into_iter()
            .filter(|o| o.0 == "table")
            .map(|o| o.1)
            .collect();
        for t in [
            "vault_meta",
            "keyslots",
            "vault_state",
            "workspaces",
            "pages",
            "page_docs",
            "databases",
            "db_properties",
            "db_rows",
            "db_views",
            "workbooks",
            "sheets",
            "sheet_bands",
            "assets",
            "versions",
            "settings",
            "secrets",
            "kv",
            "watchlists",
            "lifeapp_instances",
            "sync_links",
            "outbox",
            "reminders",
            "security_log",
        ] {
            assert!(tables.iter().any(|x| x == t), "missing {t}");
        }
        let triggers = schema_objects(&c)
            .unwrap()
            .into_iter()
            .filter(|o| o.0 == "trigger")
            .count();
        assert_eq!(triggers, 2);
        // Idempotent.
        assert_eq!(migrate(&mut c, None, 0).unwrap().from, LATEST_VERSION);
    }

    #[test]
    fn too_new_is_refused() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "user_version", 99).unwrap();
        assert!(matches!(
            migrate(&mut c, None, 0),
            Err(StoreError::SchemaTooNew { found: 99, .. })
        ));
    }
}
