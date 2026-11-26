//! Background ticker: auto-lock (SPEC §9.9), reminders (§11.3, fired only while the app runs in v1), the persisted
//! network log (§9.18) and daily snapshots (§9.21).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::autolock::TICK;
use crate::events::{self, ReminderDue};
use crate::state::AppState;

/// How often due reminders are checked.
pub const REMINDER_EVERY: Duration = Duration::from_secs(10);
/// How often the network log is persisted (when it changed).
pub const NET_LOG_EVERY: Duration = Duration::from_secs(60);
/// How often the daily-snapshot condition is checked.
pub const SNAPSHOT_CHECK_EVERY: Duration = Duration::from_secs(15 * 60);
/// Minimum age of the newest snapshot before a scheduled one is taken.
pub const SNAPSHOT_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

static SNAPSHOT_RUNNING: AtomicBool = AtomicBool::new(false);

/// `true` when a scheduled snapshot is due: none exists, or the newest is older than a day.
#[must_use]
pub fn snapshot_due(newest_at: Option<i64>, now_ms: i64) -> bool {
    newest_at.is_none_or(|t| now_ms - t >= SNAPSHOT_INTERVAL_MS)
}

/// Starts the ticker on the async runtime.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_reminders = Instant::now();
        let mut last_net = Instant::now();
        let mut last_snapshot = Instant::now();
        let mut net_generation = 0u64;
        loop {
            tokio::time::sleep(TICK).await;
            let handle = app.clone();
            let do_reminders = last_reminders.elapsed() >= REMINDER_EVERY;
            let do_net = last_net.elapsed() >= NET_LOG_EVERY;
            let do_snapshot = last_snapshot.elapsed() >= SNAPSHOT_CHECK_EVERY;
            if do_reminders {
                last_reminders = Instant::now();
            }
            if do_net {
                last_net = Instant::now();
            }
            if do_snapshot {
                last_snapshot = Instant::now();
            }
            let generation = net_generation;
            let res = tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                state.check_auto_lock(true);
                if do_reminders {
                    fire_reminders(&handle, &state);
                }
                let mut g = generation;
                if do_net {
                    g = persist_net_log(&state, generation);
                }
                if do_snapshot {
                    maybe_snapshot(&state);
                }
                g
            })
            .await;
            match res {
                Ok(g) => net_generation = g,
                Err(_) => crate::state::PANICKED.store(true, Ordering::SeqCst),
            }
        }
    });
}

fn fire_reminders(app: &AppHandle, state: &AppState) {
    let Some(store) = state.store_opt().filter(emp_store::Store::is_unlocked) else {
        return;
    };
    let fired = match emp_store::Scheduler::new(store).tick() {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(code = e.code(), "reminder tick failed");
            return;
        }
    };
    for f in fired {
        state.events.emit(
            events::REMINDER_DUE,
            ReminderDue {
                id: f.reminder.id.clone(),
                text: f.reminder.text.clone(),
            },
        );
        let title = if f.missed {
            "Missed reminder"
        } else {
            "Reminder"
        };
        if let Err(e) = app
            .notification()
            .builder()
            .title(title)
            .body(f.reminder.text)
            .show()
        {
            tracing::debug!(error = %e, "notification failed");
        }
    }
}

fn persist_net_log(state: &AppState, last_generation: u64) -> u64 {
    let generation = state.net.log().generation();
    if generation == last_generation {
        return generation;
    }
    if let Some(store) = state.store_opt().filter(emp_store::Store::is_unlocked) {
        state.persist_net_log(&store);
    }
    generation
}

fn maybe_snapshot(state: &AppState) {
    let Some(store) = state.store_opt().filter(emp_store::Store::is_unlocked) else {
        return;
    };
    let Ok(settings) = store.vault_settings() else {
        return;
    };
    if !settings.snapshots.enabled {
        return;
    }
    let newest = store
        .snapshot_list()
        .ok()
        .and_then(|l| l.first().map(|s| s.at));
    if !snapshot_due(newest, store.now()) {
        return;
    }
    if SNAPSHOT_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = store.snapshot_now(crate::commands::backup::BACKUP_KDF, &emp_store::NoProgress);
    SNAPSHOT_RUNNING.store(false, Ordering::SeqCst);
    match result {
        Ok(_) => tracing::info!("scheduled snapshot written"),
        Err(e) => tracing::info!(code = e.code(), "scheduled snapshot skipped"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_schedule() {
        assert!(snapshot_due(None, 0));
        assert!(!snapshot_due(Some(1_000), 1_000 + SNAPSHOT_INTERVAL_MS - 1));
        assert!(snapshot_due(Some(1_000), 1_000 + SNAPSHOT_INTERVAL_MS));
    }
}
