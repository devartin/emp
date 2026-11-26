//! Network activity log (SPEC §9.18): a ring buffer of the last 1,000 requests.
//!
//! Entries carry `{at, connector, method, host, path, status, bytes}` where `path` is the
//! request's *path template* (e.g. `/calendar/v3/calendars/{id}/events`). Query strings, headers
//! and bodies are never recorded, so the log holds no secrets. Persisting it (encrypted, in
//! `kv ns=net.log`) is the caller's job: read [`NetLog::snapshot`] and restore with
//! [`NetLog::restore`].

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Default ring buffer capacity (SPEC §9.18).
pub const NET_LOG_CAPACITY: usize = 1_000;

/// One logged HTTP exchange. Shape matches `network_activity` in SPEC §11.3.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetLogEntry {
    /// Unix epoch milliseconds when the response headers arrived.
    pub at: i64,
    /// Connector id (`google`, `stooq`, …).
    pub connector: String,
    /// HTTP method.
    pub method: String,
    /// Destination host.
    pub host: String,
    /// Path template; never contains a query string.
    pub path: String,
    /// HTTP status (0 when the transport failed before a status arrived).
    pub status: u16,
    /// Response body bytes read.
    pub bytes: u64,
}

/// Thread-safe ring buffer of [`NetLogEntry`].
#[derive(Debug)]
pub struct NetLog {
    entries: Mutex<VecDeque<NetLogEntry>>,
    capacity: usize,
    generation: AtomicU64,
}

impl Default for NetLog {
    fn default() -> Self {
        NetLog::new(NET_LOG_CAPACITY)
    }
}

impl NetLog {
    /// A log keeping at most `capacity` entries (minimum 1).
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        NetLog {
            entries: Mutex::new(VecDeque::with_capacity(capacity.min(NET_LOG_CAPACITY))),
            capacity,
            generation: AtomicU64::new(0),
        }
    }

    /// Append an entry, evicting the oldest when full. Any `?query` or `#fragment` in `path`
    /// is stripped defensively.
    pub fn push(&self, mut entry: NetLogEntry) {
        if let Some(i) = entry.path.find(['?', '#']) {
            entry.path.truncate(i);
        }
        let mut q = self.entries.lock();
        while q.len() >= self.capacity {
            q.pop_front();
        }
        q.push_back(entry);
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    /// The most recent `limit` entries, newest first.
    pub fn recent(&self, limit: usize) -> Vec<NetLogEntry> {
        let q = self.entries.lock();
        q.iter().rev().take(limit).cloned().collect()
    }

    /// All entries, oldest first (for persistence).
    pub fn snapshot(&self) -> Vec<NetLogEntry> {
        self.entries.lock().iter().cloned().collect()
    }

    /// Replace the contents with previously persisted entries (oldest first). Entries beyond
    /// the capacity are dropped from the old end.
    pub fn restore(&self, entries: Vec<NetLogEntry>) {
        let mut q = self.entries.lock();
        q.clear();
        let skip = entries.len().saturating_sub(self.capacity);
        q.extend(entries.into_iter().skip(skip));
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    /// Number of entries currently held.
    pub fn len(&self) -> usize {
        self.entries.lock().len()
    }

    /// Whether the log is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Monotonic change counter; persist when it differs from the last persisted value.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// Remove every entry.
    pub fn clear(&self) {
        self.entries.lock().clear();
        self.generation.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(i: u16) -> NetLogEntry {
        NetLogEntry {
            at: i64::from(i),
            connector: "stooq".into(),
            method: "GET".into(),
            host: "stooq.com".into(),
            path: "/q/d/l/".into(),
            status: 200,
            bytes: u64::from(i),
        }
    }

    #[test]
    fn ring_buffer_evicts_oldest() {
        let log = NetLog::new(3);
        for i in 0..5 {
            log.push(entry(i));
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].status, 200);
        assert_eq!(snap.iter().map(|e| e.at).collect::<Vec<_>>(), vec![2, 3, 4]);
        assert_eq!(log.recent(2).iter().map(|e| e.at).collect::<Vec<_>>(), vec![4, 3]);
    }

    #[test]
    fn query_strings_are_stripped() {
        let log = NetLog::default();
        let mut e = entry(1);
        e.path = "/api/v1/quote?symbol=AAPL&token=secret".into();
        log.push(e);
        assert_eq!(log.recent(1)[0].path, "/api/v1/quote");
    }

    #[test]
    fn restore_respects_capacity_and_serializes_camel_case() {
        let log = NetLog::new(2);
        log.restore((0..4).map(entry).collect());
        assert_eq!(log.snapshot().iter().map(|e| e.at).collect::<Vec<_>>(), vec![2, 3]);
        let g = log.generation();
        log.clear();
        assert!(log.is_empty());
        assert!(log.generation() > g);
        let json = serde_json::to_value(entry(7)).unwrap();
        assert!(json.get("connector").is_some() && json.get("path").is_some());
    }
}
