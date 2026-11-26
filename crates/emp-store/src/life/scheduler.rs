//! The reminder scheduler: decides when to wake up and fires due reminders (SPEC §11.3 "Reminders and jobs",
//! §11.4 `reminder:due`). It holds no thread of its own; the app calls [`Scheduler::tick`] from its timer and
//! sleeps until [`Scheduler::next_wake`].

use crate::model::Ts;
use crate::repo::reminders::Reminder;
use crate::{Result, Store};

/// Longest sleep between ticks (catches clock changes and reminders created by other windows).
pub const MAX_SLEEP_MS: i64 = 60_000;
/// Reminders older than this when the app wakes are still delivered, but grouped as "missed".
pub const MISSED_AFTER_MS: i64 = 15 * 60_000;

/// One fired reminder.
#[derive(Clone, Debug, PartialEq)]
pub struct Fired {
    /// The reminder.
    pub reminder: Reminder,
    /// Fired late (the app was closed or asleep).
    pub missed: bool,
}

/// Reminder scheduling over a store.
#[derive(Debug, Clone)]
pub struct Scheduler {
    store: Store,
}

impl Scheduler {
    /// A scheduler for `store`.
    #[must_use]
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    /// Fires every due reminder: marks it fired and returns it (the caller emits `reminder:due` and an OS
    /// notification). Returns nothing while the vault is locked.
    pub fn tick(&self) -> Result<Vec<Fired>> {
        if !self.store.is_unlocked() {
            return Ok(Vec::new());
        }
        let now = self.store.now();
        let due = self.store.reminders_due(now)?;
        if due.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = due.iter().map(|r| r.id.clone()).collect();
        self.store.reminders_mark_fired(&ids, now)?;
        Ok(due
            .into_iter()
            .map(|r| Fired {
                missed: now - r.fire_at > MISSED_AFTER_MS,
                reminder: r,
            })
            .collect())
    }

    /// When to tick next (unix ms): the next reminder, but at most [`MAX_SLEEP_MS`] from now.
    pub fn next_wake(&self) -> Result<Ts> {
        let now = self.store.now();
        let cap = now + MAX_SLEEP_MS;
        Ok(match self.store.reminder_next_at()? {
            Some(t) => t.clamp(now, cap),
            None => cap,
        })
    }
}
