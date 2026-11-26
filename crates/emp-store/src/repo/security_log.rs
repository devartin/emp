//! Security log (SPEC §10.2 `security_log`, §11.3 `security_log`). Only event types and times are stored.

use crate::model::{SecurityEvent, SecurityLogEntry};
use crate::vault::log_event;
use crate::{Result, Store};

/// Entries kept (older ones are pruned when logging).
pub const KEEP_ENTRIES: i64 = 10_000;

impl Store {
    /// `security_log`: newest first, at most `limit` (≤ 1,000).
    pub fn security_log(&self, limit: usize) -> Result<Vec<SecurityLogEntry>> {
        self.session()?;
        let limit = i64::try_from(limit.clamp(1, 1000)).unwrap_or(1000);
        self.read(|c| {
            let mut st =
                c.prepare_cached("SELECT at, event FROM security_log ORDER BY id DESC LIMIT ?1")?;
            let rows = st.query_map([limit], |r| {
                Ok(SecurityLogEntry {
                    at: r.get(0)?,
                    event: r.get(1)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// Records an event raised by the app layer (`export_plain`, `secret_reveal`, `integration_connect`, ...).
    pub fn log_security_event(&self, event: SecurityEvent) -> Result<()> {
        let now = self.now();
        self.write(move |tx| {
            log_event(tx, now, event)?;
            tx.execute(
                "DELETE FROM security_log WHERE id <= (SELECT max(id) FROM security_log) - ?1",
                [KEEP_ENTRIES],
            )?;
            Ok(())
        })
    }
}
