//! The single writer (SPEC §10.1 "Threading").
//!
//! One thread owns the read-write connection and executes jobs received over a bounded channel (capacity 256).
//! [`Writer::txn`] runs a job inside an `IMMEDIATE` transaction and, right before `COMMIT`, folds the integrity
//! manifest delta collected by the `TEMP` triggers into `vault_state` (see [`crate::manifest`]). A failing job rolls
//! back and discards its delta. A panicking job is contained (`catch_unwind`) and reported as `INTERNAL`.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::thread::JoinHandle;

use crossbeam_channel::{Sender, bounded};
use parking_lot::Mutex;
use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::manifest::{self, ManifestTracker};
use crate::{Result, StoreError};

/// Channel capacity.
pub const QUEUE_CAPACITY: usize = 256;

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

/// Durability of one write transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Durability {
    /// `synchronous = NORMAL` (default).
    Normal,
    /// `synchronous = FULL` for this transaction, then `wal_checkpoint(TRUNCATE)` (keyslot / vault_meta writes).
    Full,
}

/// Handle on the writer thread.
pub struct Writer {
    tx: Mutex<Option<Sender<Job>>>,
    handle: Mutex<Option<JoinHandle<()>>>,
    tracker: Arc<ManifestTracker>,
}

impl std::fmt::Debug for Writer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Writer")
    }
}

impl Writer {
    /// Installs the manifest triggers on `conn` and starts the writer thread.
    pub fn spawn(conn: Connection, tracker: Arc<ManifestTracker>) -> Result<Self> {
        tracker.install(&conn)?;
        let (tx, rx) = bounded::<Job>(QUEUE_CAPACITY);
        let handle = std::thread::Builder::new()
            .name("emp-store-writer".into())
            .spawn(move || {
                let mut conn = conn;
                while let Ok(job) = rx.recv() {
                    // A panic drops the job's reply sender, which the caller sees as INTERNAL.
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| job(&mut conn)));
                    // Never leave a transaction open after a panic.
                    if !conn.is_autocommit() {
                        let _ = conn.execute_batch("ROLLBACK");
                    }
                }
            })?;
        Ok(Self {
            tx: Mutex::new(Some(tx)),
            handle: Mutex::new(Some(handle)),
            tracker,
        })
    }

    /// The manifest tracker of the write connection.
    #[must_use]
    pub fn tracker(&self) -> &Arc<ManifestTracker> {
        &self.tracker
    }

    /// Runs `f` on the writer connection outside any transaction (pragmas, `VACUUM`, checkpoints).
    pub fn run<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<R> + Send + 'static,
    {
        let (rtx, rrx) = bounded::<Result<R>>(1);
        let job: Job = Box::new(move |conn| {
            let _ = rtx.send(f(conn));
        });
        {
            let guard = self.tx.lock();
            let sender = guard
                .as_ref()
                .ok_or_else(|| StoreError::Internal("the store is closed".into()))?;
            sender
                .send(job)
                .map_err(|_| StoreError::Internal("the writer thread stopped".into()))?;
        }
        rrx.recv()
            .map_err(|_| StoreError::Internal("the write job panicked".into()))?
    }

    /// Runs `f` inside an `IMMEDIATE` transaction with manifest maintenance.
    pub fn txn<R, F>(&self, durability: Durability, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<R> + Send + 'static,
    {
        let tracker = Arc::clone(&self.tracker);
        self.run(move |conn| {
            if durability == Durability::Full {
                conn.pragma_update(None, "synchronous", "FULL")?;
            }
            let out = run_txn(conn, &tracker, f);
            if durability == Durability::Full {
                conn.pragma_update(None, "synchronous", "NORMAL")?;
                if out.is_ok() {
                    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
                }
            }
            out
        })
    }

    /// Stops the thread after the queued jobs finish.
    pub fn shutdown(&self) {
        self.tx.lock().take();
        if let Some(h) = self.handle.lock().take() {
            let _ = h.join();
        }
    }
}

fn run_txn<R>(
    conn: &mut Connection,
    tracker: &ManifestTracker,
    f: impl FnOnce(&Transaction<'_>) -> Result<R>,
) -> Result<R> {
    tracker.begin();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match f(&tx) {
        Ok(v) => {
            let (delta, touched) = tracker.take();
            if touched {
                let keys = tracker.keys().ok_or(StoreError::Locked)?;
                manifest::commit_delta(&tx, &keys, delta)?;
            }
            tx.commit()?;
            Ok(v)
        }
        Err(e) => {
            tracker.take();
            drop(tx);
            Err(e)
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.shutdown();
    }
}
