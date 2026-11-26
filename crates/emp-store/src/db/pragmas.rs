//! Per-connection settings (SPEC §10.1).

use rusqlite::Connection;
use rusqlite::config::DbConfig;
use rusqlite::limits::Limit;

use crate::Result;

/// `SQLITE_LIMIT_LENGTH`: 64 MiB.
pub const LIMIT_LENGTH: i32 = 64 * 1024 * 1024;
/// `SQLITE_LIMIT_SQL_LENGTH`: 1 MiB.
pub const LIMIT_SQL_LENGTH: i32 = 1024 * 1024;
/// `SQLITE_LIMIT_ATTACHED`: 1.
pub const LIMIT_ATTACHED: i32 = 1;

/// Pragmas run on every connection. `journal_mode` is set separately because it returns a row.
const PRAGMAS: &[(&str, &str)] = &[
    ("synchronous", "NORMAL"),
    ("foreign_keys", "ON"),
    ("secure_delete", "ON"),
    ("temp_store", "MEMORY"),
    ("trusted_schema", "OFF"),
    ("cell_size_check", "ON"),
    ("mmap_size", "268435456"),
    ("cache_size", "-32768"),
    ("busy_timeout", "5000"),
    ("wal_autocheckpoint", "1000"),
];

/// Connection-level hardening: `DEFENSIVE`, limits, no extension loading (never enabled in this build).
pub fn harden(conn: &Connection) -> Result<()> {
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, LIMIT_LENGTH)?;
    conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, LIMIT_SQL_LENGTH)?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, LIMIT_ATTACHED)?;
    Ok(())
}

/// Applies the §10.1 pragmas (and WAL mode when `wal` is set; read-only connections skip it).
pub fn apply(conn: &Connection, wal: bool) -> Result<()> {
    if wal {
        let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(crate::StoreError::Internal(format!(
                "could not enable WAL (got {mode})"
            )));
        }
    }
    for (name, value) in PRAGMAS {
        conn.pragma_update(None, name, value)?;
    }
    Ok(())
}

/// Pragmas applied once, before the first table is created.
pub fn apply_creation(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "page_size", 4096)?;
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pragmas_apply_on_memory_db() {
        let c = Connection::open_in_memory().unwrap();
        harden(&c).unwrap();
        apply(&c, false).unwrap();
        let fk: i64 = c
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        let sd: i64 = c
            .query_row("PRAGMA secure_delete", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sd, 1);
        assert_eq!(c.limit(Limit::SQLITE_LIMIT_ATTACHED).unwrap(), 1);
    }
}
