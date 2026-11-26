//! Long-running jobs (SPEC §11.1 "Long-running jobs").
//!
//! A *(job)* command returns a [`JobRef`] immediately and streams [`JobEvent`]s over the `onEvent` channel in its
//! request: throttled `progress` events, then exactly one `done` or `error`. Jobs run on the blocking pool inside
//! `catch_unwind` (D-15) and are cancellable with `job_cancel`; locking the vault cancels every job.

use std::cell::Cell;
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use crate::error::{ApiError, ApiResult, ErrorCode};

/// Minimum interval between two `progress` events (the final one is always sent).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Most jobs running at once. Each occupies a blocking-pool thread; beyond this a new job ends at once with
/// `RATE_LIMITED` instead of starving the pool that every command body runs on.
pub const MAX_RUNNING_JOBS: usize = 64;

thread_local! {
    static IN_BOUNDARY: Cell<bool> = const { Cell::new(false) };
}

/// Runs `f` inside a `catch_unwind` boundary (D-15). A panic inside it is returned as `Err` and does **not** lock the
/// vault; parsers, importers and evaluators should run through this.
pub fn catch_panics<R>(f: impl FnOnce() -> R) -> std::thread::Result<R> {
    let prev = IN_BOUNDARY.with(|b| b.replace(true));
    let r = std::panic::catch_unwind(AssertUnwindSafe(f));
    IN_BOUNDARY.with(|b| b.set(prev));
    r
}

/// Whether the current thread is inside [`catch_panics`] (read by the panic hook).
#[must_use]
pub fn in_panic_boundary() -> bool {
    IN_BOUNDARY.with(Cell::get)
}

/// `JobEvent` (SPEC §11.2).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobEvent {
    /// Progress update.
    Progress {
        /// Units done.
        done: u64,
        /// Total units (0 when unknown).
        total: u64,
        /// Optional stage label (never user content).
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Finished successfully.
    Done {
        /// The command's result value.
        result: serde_json::Value,
    },
    /// Failed or was cancelled.
    Error {
        /// The error.
        error: ApiError,
    },
}

/// `JobRef` (SPEC §11.2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRef {
    /// The job id (pass to `job_cancel`).
    pub job_id: String,
}

/// One `job_list` entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    /// Job id.
    pub job_id: String,
    /// Command name, e.g. `backup_create`.
    pub kind: String,
    /// Units done.
    pub done: u64,
    /// Total units.
    pub total: u64,
    /// Start time (unix ms).
    pub started_at: i64,
    /// Whether `job_cancel` has an effect.
    pub cancellable: bool,
}

/// Where job events go: a webview `Channel` in the app, a collector in tests.
pub trait JobSink: Send + Sync + 'static {
    /// Delivers one event. Delivery failures (closed webview) are ignored.
    fn send(&self, event: JobEvent);
}

impl JobSink for tauri::ipc::Channel<JobEvent> {
    fn send(&self, event: JobEvent) {
        let _ = tauri::ipc::Channel::send(self, event);
    }
}

struct Entry {
    kind: &'static str,
    done: Arc<AtomicU64>,
    total: Arc<AtomicU64>,
    started_at: i64,
    cancellable: bool,
    cancel: Arc<AtomicBool>,
}

/// All running jobs.
#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Entry>>,
}

/// Handed to the job body: reports progress and exposes cancellation. Implements [`emp_store::Progress`].
pub struct JobCtx {
    sink: Arc<dyn JobSink>,
    done: Arc<AtomicU64>,
    total: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
    last_sent: Mutex<Option<Instant>>,
}

impl JobCtx {
    /// Whether the job was cancelled.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Fails with `CANCELLED` if the job was cancelled.
    pub fn check_cancelled(&self) -> ApiResult<()> {
        if self.is_cancelled() {
            Err(ApiError::new(ErrorCode::Cancelled, "Cancelled"))
        } else {
            Ok(())
        }
    }

    /// The cancellation flag (for code that polls an `AtomicBool`).
    #[must_use]
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    /// Reports progress; throttled to one event per [`PROGRESS_INTERVAL`] except when `done == total`.
    pub fn report(&self, done: u64, total: u64, label: Option<&str>) {
        self.done.store(done, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
        let now = Instant::now();
        let mut last = self.last_sent.lock();
        let finished = total > 0 && done >= total;
        if !finished && last.is_some_and(|t| now.duration_since(t) < PROGRESS_INTERVAL) {
            return;
        }
        *last = Some(now);
        drop(last);
        self.sink.send(JobEvent::Progress {
            done,
            total,
            label: label.filter(|l| !l.is_empty()).map(str::to_owned),
        });
    }
}

#[cfg(test)]
struct NullSink;

#[cfg(test)]
impl JobSink for NullSink {
    fn send(&self, _event: JobEvent) {}
}

#[cfg(test)]
impl JobCtx {
    /// A context outside the registry whose events go nowhere (for calling job bodies directly in tests).
    pub(crate) fn detached() -> Self {
        Self {
            sink: Arc::new(NullSink),
            done: Arc::default(),
            total: Arc::default(),
            cancel: Arc::default(),
            last_sent: Mutex::new(None),
        }
    }
}

impl emp_store::Progress for JobCtx {
    fn progress(&self, done: u64, total: u64, label: &str) {
        self.report(done, total, Some(label));
    }

    fn cancelled(&self) -> bool {
        self.is_cancelled()
    }
}

fn new_job_id() -> String {
    uuid::Uuid::now_v7().hyphenated().to_string()
}

fn panic_error() -> ApiError {
    ApiError::internal("job panicked")
}

fn busy_error() -> ApiError {
    ApiError::new(
        ErrorCode::RateLimited,
        "Too many tasks are running; try again when some have finished",
    )
    .with_retry_after(1_000)
}

impl JobRegistry {
    /// Starts `body` on the blocking pool and returns its [`JobRef`] immediately.
    ///
    /// `body`'s `Ok` value is serialised into the `done` event; its `Err` (or a panic, mapped to `INTERNAL`)
    /// becomes the `error` event. A cancelled job always ends with `CANCELLED`.
    pub fn spawn<T, F>(
        self: &Arc<Self>,
        kind: &'static str,
        cancellable: bool,
        now_ms: i64,
        sink: Arc<dyn JobSink>,
        body: F,
    ) -> JobRef
    where
        T: Serialize,
        F: FnOnce(&JobCtx) -> ApiResult<T> + Send + 'static,
    {
        let id = new_job_id();
        let Some(ctx) = self.try_register(&id, kind, cancellable, now_ms, Arc::clone(&sink)) else {
            // The caller buffers events that arrive before the JobRef, so the error reaches the job's listener.
            sink.send(JobEvent::Error {
                error: busy_error(),
            });
            return JobRef { job_id: id };
        };
        let me = Arc::clone(self);
        let job_id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            me.run(&job_id, &ctx, body);
        });
        JobRef { job_id: id }
    }

    #[cfg(test)]
    fn register(
        &self,
        id: &str,
        kind: &'static str,
        cancellable: bool,
        now_ms: i64,
        sink: Arc<dyn JobSink>,
    ) -> JobCtx {
        self.register_inner(id, kind, cancellable, now_ms, sink, usize::MAX)
            .unwrap_or_else(|| unreachable!("no limit"))
    }

    /// Registers a job unless [`MAX_RUNNING_JOBS`] are already running.
    fn try_register(
        &self,
        id: &str,
        kind: &'static str,
        cancellable: bool,
        now_ms: i64,
        sink: Arc<dyn JobSink>,
    ) -> Option<JobCtx> {
        self.register_inner(id, kind, cancellable, now_ms, sink, MAX_RUNNING_JOBS)
    }

    fn register_inner(
        &self,
        id: &str,
        kind: &'static str,
        cancellable: bool,
        now_ms: i64,
        sink: Arc<dyn JobSink>,
        limit: usize,
    ) -> Option<JobCtx> {
        let done = Arc::new(AtomicU64::new(0));
        let total = Arc::new(AtomicU64::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        let mut jobs = self.jobs.lock();
        if jobs.len() >= limit {
            return None;
        }
        jobs.insert(
            id.to_owned(),
            Entry {
                kind,
                done: Arc::clone(&done),
                total: Arc::clone(&total),
                started_at: now_ms,
                cancellable,
                cancel: Arc::clone(&cancel),
            },
        );
        drop(jobs);
        Some(JobCtx {
            sink,
            done,
            total,
            cancel,
            last_sent: Mutex::new(None),
        })
    }

    /// Runs a registered job body to completion on the current thread.
    fn run<T, F>(&self, id: &str, ctx: &JobCtx, body: F)
    where
        T: Serialize,
        F: FnOnce(&JobCtx) -> ApiResult<T>,
    {
        let outcome = catch_panics(|| body(ctx));
        let event = match outcome {
            Ok(_) if ctx.is_cancelled() => JobEvent::Error {
                error: ApiError::new(ErrorCode::Cancelled, "Cancelled"),
            },
            Ok(Ok(v)) => match serde_json::to_value(v) {
                Ok(result) => JobEvent::Done { result },
                Err(_) => JobEvent::Error {
                    error: ApiError::internal("job result serialisation"),
                },
            },
            Ok(Err(error)) => JobEvent::Error { error },
            Err(_) => JobEvent::Error {
                error: panic_error(),
            },
        };
        self.jobs.lock().remove(id);
        ctx.sink.send(event);
    }

    /// `job_list`.
    #[must_use]
    pub fn list(&self) -> Vec<JobInfo> {
        let mut out: Vec<JobInfo> = self
            .jobs
            .lock()
            .iter()
            .map(|(id, e)| JobInfo {
                job_id: id.clone(),
                kind: e.kind.to_owned(),
                done: e.done.load(Ordering::Relaxed),
                total: e.total.load(Ordering::Relaxed),
                started_at: e.started_at,
                cancellable: e.cancellable,
            })
            .collect();
        out.sort_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then(a.job_id.cmp(&b.job_id))
        });
        out
    }

    /// `job_cancel`: flags the job; it ends with `CANCELLED` at its next checkpoint.
    pub fn cancel(&self, id: &str) -> ApiResult<()> {
        let jobs = self.jobs.lock();
        let e = jobs.get(id).ok_or_else(|| ApiError::not_found("job"))?;
        if !e.cancellable {
            return Err(ApiError::unsupported("This job cannot be cancelled"));
        }
        e.cancel.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Cancels every running job (on lock). Returns how many were flagged.
    pub fn cancel_all(&self) -> usize {
        let jobs = self.jobs.lock();
        for e in jobs.values() {
            e.cancel.store(true, Ordering::SeqCst);
        }
        jobs.len()
    }

    /// Number of running jobs.
    #[must_use]
    pub fn len(&self) -> usize {
        self.jobs.lock().len()
    }

    /// `true` when no job is running.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Collect(Mutex<Vec<JobEvent>>);

    impl JobSink for Collect {
        fn send(&self, event: JobEvent) {
            self.0.lock().push(event);
        }
    }

    fn run_sync<T: Serialize>(
        reg: &JobRegistry,
        cancellable: bool,
        body: impl FnOnce(&JobCtx) -> ApiResult<T>,
    ) -> Vec<JobEvent> {
        let sink = Arc::new(Collect::default());
        let ctx = reg.register("j1", "test", cancellable, 1, sink.clone());
        reg.run("j1", &ctx, body);
        sink.0.lock().clone()
    }

    #[test]
    fn done_event_carries_result() {
        let reg = JobRegistry::default();
        let ev = run_sync(&reg, true, |ctx| {
            ctx.report(1, 2, Some("records"));
            ctx.report(2, 2, None);
            Ok(serde_json::json!({ "bytes": 42 }))
        });
        assert_eq!(ev.len(), 3);
        assert_eq!(
            ev[0],
            JobEvent::Progress {
                done: 1,
                total: 2,
                label: Some("records".into())
            }
        );
        assert_eq!(
            ev[2],
            JobEvent::Done {
                result: serde_json::json!({ "bytes": 42 })
            }
        );
        assert!(reg.is_empty());
    }

    #[test]
    fn progress_is_throttled_but_final_is_sent() {
        let reg = JobRegistry::default();
        let ev = run_sync(&reg, true, |ctx| {
            for i in 0..1000 {
                ctx.report(i, 1000, None);
            }
            ctx.report(1000, 1000, None);
            Ok(())
        });
        let progress = ev
            .iter()
            .filter(|e| matches!(e, JobEvent::Progress { .. }))
            .count();
        assert!(progress < 10, "{progress} progress events");
        assert!(matches!(
            ev[ev.len() - 2],
            JobEvent::Progress { done: 1000, .. }
        ));
    }

    #[test]
    fn errors_and_panics_become_error_events() {
        let reg = JobRegistry::default();
        let ev = run_sync::<()>(&reg, true, |_| Err(ApiError::invalid("x", "bad")));
        assert!(matches!(&ev[0], JobEvent::Error { error } if error.code == ErrorCode::Invalid));
        let ev = run_sync::<()>(&reg, true, |_| panic!("boom"));
        assert!(matches!(&ev[0], JobEvent::Error { error } if error.code == ErrorCode::Internal));
        assert!(reg.is_empty());
    }

    #[test]
    fn cancel_flags_job_and_ends_with_cancelled() {
        let reg = JobRegistry::default();
        let sink = Arc::new(Collect::default());
        let ctx = reg.register("j2", "test", true, 5, sink.clone());
        assert_eq!(reg.list().len(), 1);
        assert_eq!(reg.list()[0].kind, "test");
        reg.cancel("j2").unwrap();
        assert!(emp_store::Progress::cancelled(&ctx));
        reg.run("j2", &ctx, |c| {
            c.check_cancelled()?;
            Ok(1)
        });
        let ev = sink.0.lock().clone();
        assert!(matches!(&ev[0], JobEvent::Error { error } if error.code == ErrorCode::Cancelled));
        assert!(reg.cancel("j2").is_err());
    }

    #[test]
    fn non_cancellable_jobs_refuse_cancel_but_lock_cancels_all() {
        let reg = JobRegistry::default();
        let sink = Arc::new(Collect::default());
        let ctx = reg.register("j3", "test", false, 5, sink);
        assert_eq!(reg.cancel("j3").unwrap_err().code, ErrorCode::Unsupported);
        assert_eq!(reg.cancel_all(), 1);
        assert!(ctx.is_cancelled());
    }

    #[test]
    fn running_jobs_are_capped() {
        let reg = JobRegistry::default();
        let sink: Arc<dyn JobSink> = Arc::new(Collect::default());
        for i in 0..MAX_RUNNING_JOBS {
            assert!(
                reg.try_register(&format!("j{i}"), "t", true, 1, Arc::clone(&sink))
                    .is_some()
            );
        }
        assert!(
            reg.try_register("over", "t", true, 1, Arc::clone(&sink))
                .is_none()
        );
        assert_eq!(reg.len(), MAX_RUNNING_JOBS);
        // A finished job frees its slot.
        let ctx = reg.try_register("x", "t", true, 1, Arc::clone(&sink));
        assert!(ctx.is_none());
        reg.jobs.lock().remove("j0");
        assert!(reg.try_register("x", "t", true, 1, sink).is_some());
    }

    #[test]
    fn spawn_over_the_cap_reports_rate_limited() {
        let reg = Arc::new(JobRegistry::default());
        let filler: Arc<dyn JobSink> = Arc::new(Collect::default());
        for i in 0..MAX_RUNNING_JOBS {
            reg.register(&format!("j{i}"), "t", true, 1, Arc::clone(&filler));
        }
        let sink = Arc::new(Collect::default());
        let job = reg.spawn("t", true, 1, sink.clone(), |_| Ok(1));
        assert!(!job.job_id.is_empty());
        let ev = sink.0.lock().clone();
        assert!(
            matches!(&ev[..], [JobEvent::Error { error }] if error.code == ErrorCode::RateLimited),
            "{ev:?}"
        );
        assert_eq!(reg.len(), MAX_RUNNING_JOBS);
    }

    #[test]
    fn panic_boundary_is_scoped() {
        assert!(!in_panic_boundary());
        let inner = catch_panics(in_panic_boundary).unwrap();
        assert!(inner);
        assert!(!in_panic_boundary());
        assert!(catch_panics(|| panic!("x")).is_err());
        assert!(!in_panic_boundary());
    }

    #[test]
    fn job_event_wire_shape() {
        let v = serde_json::to_value(JobEvent::Progress {
            done: 1,
            total: 3,
            label: None,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "kind": "progress", "done": 1, "total": 3 })
        );
        let v = serde_json::to_value(JobEvent::Error {
            error: ApiError::locked(),
        })
        .unwrap();
        assert_eq!(v["kind"], "error");
        assert_eq!(v["error"]["code"], "LOCKED");
    }
}
