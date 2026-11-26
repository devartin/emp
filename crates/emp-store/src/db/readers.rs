//! Pool of read-only connections (SPEC §10.1: 4 readers).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
use rusqlite::Connection;

use super::conn;
use crate::Result;

/// Default pool size.
pub const READERS: usize = 4;

/// A fixed pool of WAL readers.
pub struct ReaderPool {
    conns: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl std::fmt::Debug for ReaderPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ReaderPool({})", self.conns.len())
    }
}

impl ReaderPool {
    /// Opens `n` read-only connections on `path`.
    pub fn open(path: &Path, n: usize) -> Result<Self> {
        let conns = (0..n.max(1))
            .map(|_| conn::open_ro(path).map(Mutex::new))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            conns,
            next: AtomicUsize::new(0),
        })
    }

    /// Runs `f` on a free reader (or waits for the next one in round-robin order).
    pub fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        for c in &self.conns {
            if let Some(guard) = c.try_lock() {
                return f(&guard);
            }
        }
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.conns.len();
        let guard = self.conns[i].lock();
        f(&guard)
    }

    /// Runs `f` inside one read transaction (a consistent snapshot across statements).
    pub fn snapshot<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        self.with(|c| {
            c.execute_batch("BEGIN DEFERRED")?;
            let out = f(c);
            let _ = c.execute_batch("COMMIT");
            out
        })
    }
}
