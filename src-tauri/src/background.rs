//! Background ticker: auto-lock (SPEC §9.9), reminders (§11.3, fired only while the app runs in v1), the persisted
//! network log (§9.18), daily snapshots and the snapshot on quit (§9.21), the scheduled Google Calendar sync
//! (§17.1) and the automatic monthly net-worth snapshot (§15.5).

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
/// The snapshot on quit is taken only when the newest snapshot is at least this old (§9.21 "at most every 6 h").
pub const QUIT_SNAPSHOT_MIN_AGE_MS: i64 = 6 * 60 * 60 * 1000;
/// How often the Google Calendar schedule is checked (each account syncs every `intervalMin`).
pub const GCAL_CHECK_EVERY: Duration = Duration::from_secs(30);
/// How often the automatic net-worth snapshot condition is checked (it writes at most once per month).
pub const NETWORTH_CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// Delay between an unlock and its follow-up work (net-worth snapshot, calendar sync), so unlocking stays fast.
pub const AFTER_UNLOCK_DELAY: Duration = Duration::from_secs(3);

static SNAPSHOT_RUNNING: AtomicBool = AtomicBool::new(false);

/// `true` when a scheduled snapshot is due: none exists, or the newest is older than a day.
#[must_use]
pub fn snapshot_due(newest_at: Option<i64>, now_ms: i64) -> bool {
    newest_at.is_none_or(|t| now_ms - t >= SNAPSHOT_INTERVAL_MS)
}

/// `true` when the snapshot on quit is due: none exists, or the newest is at least 6 h old.
#[must_use]
pub fn quit_snapshot_due(newest_at: Option<i64>, now_ms: i64) -> bool {
    newest_at.is_none_or(|t| now_ms - t >= QUIT_SNAPSHOT_MIN_AGE_MS)
}

/// Starts the ticker on the async runtime.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_reminders = Instant::now();
        let mut last_net = Instant::now();
        let mut last_snapshot = Instant::now();
        let mut last_gcal = Instant::now();
        let mut last_networth = Instant::now();
        let mut net_generation = 0u64;
        loop {
            tokio::time::sleep(TICK).await;
            let handle = app.clone();
            let do_reminders = last_reminders.elapsed() >= REMINDER_EVERY;
            let do_net = last_net.elapsed() >= NET_LOG_EVERY;
            let do_snapshot = last_snapshot.elapsed() >= SNAPSHOT_CHECK_EVERY;
            let do_networth = last_networth.elapsed() >= NETWORTH_CHECK_EVERY;
            if do_reminders {
                last_reminders = Instant::now();
            }
            if do_net {
                last_net = Instant::now();
            }
            if do_snapshot {
                last_snapshot = Instant::now();
            }
            if do_networth {
                last_networth = Instant::now();
            }
            if last_gcal.elapsed() >= GCAL_CHECK_EVERY {
                last_gcal = Instant::now();
                crate::commands::google::scheduled_sync(&app, false);
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
                if do_networth {
                    networth_snapshots(&state);
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

/// Takes the snapshot on quit (§9.21): only for an unlocked vault with snapshots enabled, and only when the newest
/// snapshot is at least 6 h old. Blocking; called from `app_quit` and the exit handler before the vault closes.
pub fn snapshot_on_quit(state: &AppState) {
    let Some(store) = state.store_opt().filter(emp_store::Store::is_unlocked) else {
        return;
    };
    if !store.vault_settings().is_ok_and(|s| s.snapshots.enabled) {
        return;
    }
    let newest = store
        .snapshot_list()
        .ok()
        .and_then(|l| l.first().map(|s| s.at));
    if !quit_snapshot_due(newest, store.now()) {
        return;
    }
    if SNAPSHOT_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = store.snapshot_now(crate::commands::backup::BACKUP_KDF, &emp_store::NoProgress);
    SNAPSHOT_RUNNING.store(false, Ordering::SeqCst);
    match result {
        Ok(_) => tracing::info!("snapshot on quit written"),
        Err(e) => tracing::info!(code = e.code(), "snapshot on quit skipped"),
    }
}

/// Writes the automatic monthly net-worth snapshot rows (once per month per Money HQ instance).
fn networth_snapshots(state: &AppState) {
    let Ok(store) = state.session_quiet() else {
        return;
    };
    // The store raises `db:changed` for every database the snapshot rows land in.
    match crate::commands::finance::auto_networth_snapshots(&store) {
        Ok(dbs) if !dbs.is_empty() => {
            tracing::info!(databases = dbs.len(), "net-worth snapshots written")
        }
        Ok(_) => {}
        Err(e) => tracing::info!(code = e.code.as_str(), "net-worth snapshot check failed"),
    }
}

/// Follow-up work after an unlock, run shortly afterwards in the background: the first-unlock-of-the-month
/// net-worth snapshot and a calendar sync nudge ("after waking from sleep", §17.1).
pub fn on_unlock(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AFTER_UNLOCK_DELAY).await;
        let handle = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Some(state) = handle.try_state::<AppState>() {
                networth_snapshots(&state);
            }
        })
        .await;
        if app.try_state::<AppState>().is_some() {
            crate::commands::google::scheduled_sync(&app, true);
        }
    });
}

/// The main window regained focus: nudge the calendar sync (§17.1 "when the window regains focus").
pub fn on_focus_regained(app: &AppHandle) {
    let unlocked = app
        .try_state::<AppState>()
        .is_some_and(|s| s.session_quiet().is_ok());
    if unlocked {
        crate::commands::google::scheduled_sync(app, true);
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

    #[test]
    fn quit_snapshot_at_most_every_six_hours() {
        assert!(quit_snapshot_due(None, 0));
        let six_h = 6 * 60 * 60 * 1000;
        assert!(!quit_snapshot_due(Some(1_000), 1_000 + six_h - 1));
        assert!(quit_snapshot_due(Some(1_000), 1_000 + six_h));
    }
}
