//! The common importer wrapper (SPEC §9.16): panics are contained (`catch_unwind`), cancellation and a wall-time
//! budget (60 s by default, extendable by the user) are checked between units of work, and progress is reported
//! through the job's [`Progress`].

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use crate::{Progress, Result, StoreError};

/// Default wall-time budget.
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(60);

/// Budget, cancellation and progress of one import.
pub struct Guard<'a> {
    progress: &'a dyn Progress,
    deadline: Instant,
}

impl<'a> Guard<'a> {
    /// A guard with `budget` of wall time.
    #[must_use]
    pub fn new(progress: &'a dyn Progress, budget: Duration) -> Self {
        Self {
            progress,
            deadline: Instant::now() + budget,
        }
    }

    /// Fails with `CANCELLED` when the job was cancelled and `TOO_LARGE` when the budget is spent.
    pub fn check(&self) -> Result<()> {
        if self.progress.cancelled() {
            return Err(StoreError::Cancelled);
        }
        if Instant::now() > self.deadline {
            return Err(StoreError::TooLarge(
                "the import took longer than its time budget",
            ));
        }
        Ok(())
    }

    /// Reports progress and checks the budget.
    pub fn step(&self, done: u64, total: u64, label: &str) -> Result<()> {
        self.progress.progress(done, total, label);
        self.check()
    }
}

/// Runs an importer body, turning a panic into `INTERNAL`.
pub fn contain<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| {
        Err(StoreError::Internal(
            "the importer stopped unexpectedly".into(),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Cancel(AtomicBool);
    impl Progress for Cancel {
        fn progress(&self, _: u64, _: u64, _: &str) {}
        fn cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn cancellation_budget_and_panics() {
        let c = Cancel(AtomicBool::new(false));
        let g = Guard::new(&c, DEFAULT_BUDGET);
        assert!(g.step(1, 2, "x").is_ok());
        c.0.store(true, Ordering::SeqCst);
        assert!(matches!(g.check(), Err(StoreError::Cancelled)));
        let c = Cancel(AtomicBool::new(false));
        let g = Guard::new(&c, Duration::ZERO);
        std::thread::sleep(Duration::from_millis(2));
        assert!(matches!(g.check(), Err(StoreError::TooLarge(_))));
        let r: Result<()> = contain(|| panic!("boom"));
        assert!(matches!(r, Err(StoreError::Internal(_))));
    }
}
