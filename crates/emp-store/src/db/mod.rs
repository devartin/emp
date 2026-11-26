//! SQLite layer: connection settings (§10.1), migrations (§10.2–§10.3), the single writer thread and the reader
//! pool.
//!
//! * [`conn`] opens hardened read-write / read-only connections.
//! * [`pragmas`] applies the §10.1 pragmas, `DEFENSIVE` and limits.
//! * [`migrate`] runs ordered structural migrations (migration 0001 holds the complete §10.2 DDL).
//! * [`payload_migrate`] runs deferred payload migrations after unlock (batches of 500, resumable).
//! * [`tables`] describes every payload-carrying table (keys, kind, rev, AAD binding).
//! * [`writer`] owns the one write connection on a dedicated thread; every write runs in an
//!   `IMMEDIATE` transaction that also maintains the integrity manifest.
//! * [`readers`] is a pool of 4 read-only connections.

pub mod conn;
pub mod migrate;
pub mod payload_migrate;
pub mod pragmas;
pub mod readers;
pub mod tables;
pub mod writer;

/// Current unix time in milliseconds from the system clock.
#[must_use]
pub fn system_now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
