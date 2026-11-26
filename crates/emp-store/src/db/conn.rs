//! Opening hardened connections.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use super::pragmas;
use crate::Result;

/// Opens (creating if needed) the read-write connection used by the writer thread.
pub fn open_rw(path: &Path) -> Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_EXRESCODE;
    let conn = Connection::open_with_flags(path, flags)?;
    pragmas::harden(&conn)?;
    Ok(conn)
}

/// Finishes read-write setup after migrations decided on creation pragmas.
pub fn configure_rw(conn: &Connection) -> Result<()> {
    pragmas::apply(conn, true)
}

/// Opens a read-only reader connection (WAL readers see committed state).
pub fn open_ro(path: &Path) -> Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_EXRESCODE;
    let conn = Connection::open_with_flags(path, flags)?;
    pragmas::harden(&conn)?;
    pragmas::apply(&conn, false)?;
    Ok(conn)
}

/// Opens an untrusted database file (backup restore, §9.21 step 2): read-only, `DEFENSIVE`,
/// `trusted_schema=OFF`, then `PRAGMA integrity_check`.
pub fn open_untrusted(path: &Path) -> Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_EXRESCODE;
    let conn = Connection::open_with_flags(path, flags)?;
    pragmas::harden(&conn)?;
    conn.pragma_update(None, "trusted_schema", "OFF")?;
    conn.pragma_update(None, "cell_size_check", "ON")?;
    let res: Vec<String> = {
        let mut st = conn.prepare("PRAGMA integrity_check")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if res.len() != 1 || res.first().map(String::as_str) != Some("ok") {
        return Err(crate::StoreError::Integrity(
            "the database failed PRAGMA integrity_check".into(),
        ));
    }
    Ok(conn)
}

/// `PRAGMA quick_check` (plaintext-mode integrity, §9.8).
pub fn quick_check(conn: &Connection) -> Result<bool> {
    let r: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    Ok(r == "ok")
}
