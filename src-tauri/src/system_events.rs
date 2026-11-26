//! Native sleep and screen-lock signals (SPEC §9.9 "System sleep", "Screen lock / user switch").
//!
//! * **Linux** (implemented): systemd-logind on the system bus — `Manager.PrepareForSleep(true)` while EMP holds a
//!   `delay` sleep inhibitor, released only after the lock sequence has zeroized the keys; the session's `Lock`
//!   signal and its `LockedHint` property; and `ActiveChanged(true)` from the desktop screen saver on the session bus
//!   (`org.freedesktop.ScreenSaver`, `org.gnome.ScreenSaver`, …). Without a bus (containers, minimal sessions) the
//!   watchers log once and stop.
//! * **macOS / Windows**: not wired natively yet (`NSWorkspaceWillSleepNotification` /
//!   `com.apple.screenIsLocked` and `WM_POWERBROADCAST` / `WTS_SESSION_LOCK` need an AppKit observer or a hidden
//!   message window). There, and everywhere as a backstop, the ticker's monotonic-gap detection
//!   ([`crate::autolock::SLEEP_GAP`]) locks after a resume from sleep.
//!
//! Every signal ends in [`handle`], which applies the vault's auto-lock settings (`onSleep`, `onScreenLock`).

use tauri::{AppHandle, Manager};

use crate::autolock::LockReason;
use crate::state::AppState;

/// A native power or session signal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemEvent {
    /// The system is about to sleep.
    Sleep,
    /// The screen was locked or the user session switched away.
    ScreenLocked,
}

/// The lock this signal calls for under `auto_lock`, if any. Screen locks keep the UI's flush window; sleep does not
/// (the sleep inhibitor only delays suspend by a few seconds).
#[must_use]
pub fn lock_for(
    event: SystemEvent,
    auto_lock: &emp_store::model::AutoLock,
) -> Option<(LockReason, bool)> {
    match event {
        SystemEvent::Sleep if auto_lock.on_sleep => Some((LockReason::Sleep, false)),
        SystemEvent::ScreenLocked if auto_lock.on_screen_lock => Some((LockReason::Screen, true)),
        _ => None,
    }
}

/// Applies a system signal: locks an unlocked, encrypted vault when its settings ask for it. Blocking (runs the
/// lock sequence on the calling thread); returns once the keys are gone.
pub fn handle(app: &AppHandle, event: SystemEvent) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(store) = state.store_opt() else {
        return;
    };
    if !store.is_unlocked() || !store.is_encrypted().unwrap_or(false) {
        return;
    }
    if let Some((reason, grace)) = lock_for(event, &state.auto_lock())
        && let Err(e) = state.lock_now(reason, grace)
    {
        tracing::error!(code = e.code.as_str(), "lock on system signal failed");
    }
}

/// Starts the platform watchers (no-op where none exist).
pub fn start(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    linux::start(app);
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;

    use tauri::AppHandle;
    use zbus::blocking::{Connection, MessageIterator, Proxy};
    use zbus::zvariant::{OwnedFd, OwnedObjectPath, OwnedValue};

    use super::{SystemEvent, handle};

    const LOGIND: &str = "org.freedesktop.login1";
    const LOGIND_PATH: &str = "/org/freedesktop/login1";
    const MANAGER: &str = "org.freedesktop.login1.Manager";
    const SESSION: &str = "org.freedesktop.login1.Session";
    const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

    fn spawn(name: &str, f: impl FnOnce() -> zbus::Result<()> + Send + 'static) {
        let thread_name = format!("emp-{name}");
        let label = name.to_owned();
        let spawned = std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                if let Err(e) = f() {
                    tracing::info!(watcher = %label, error = %e, "system signal watcher stopped");
                }
            });
        if spawned.is_err() {
            tracing::warn!(watcher = name, "could not start a system signal watcher");
        }
    }

    pub(super) fn start(app: &AppHandle) {
        let a = app.clone();
        spawn("logind-sleep", move || watch_sleep(&a));
        let a = app.clone();
        spawn("logind-lock", move || watch_session_lock(&a));
        let a = app.clone();
        spawn("logind-lockedhint", move || watch_locked_hint(&a));
        let a = app.clone();
        spawn("screensaver", move || watch_screensaver(&a));
    }

    /// A `delay` sleep inhibitor: suspend waits (up to logind's `InhibitDelayMaxSec`) until the fd is closed.
    fn inhibit(manager: &Proxy<'_>) -> Option<OwnedFd> {
        match manager.call::<_, _, OwnedFd>(
            "Inhibit",
            &("sleep", "EMP", "Locking the vault before sleep", "delay"),
        ) {
            Ok(fd) => Some(fd),
            Err(e) => {
                tracing::info!(error = %e, "no sleep inhibitor; relying on resume detection");
                None
            }
        }
    }

    fn watch_sleep(app: &AppHandle) -> zbus::Result<()> {
        let conn = Connection::system()?;
        let manager = Proxy::new(&conn, LOGIND, LOGIND_PATH, MANAGER)?;
        let signals = manager.receive_signal("PrepareForSleep")?;
        let mut inhibitor = inhibit(&manager);
        for msg in signals {
            let body = msg.body();
            let Ok(starting) = body.deserialize::<bool>() else {
                continue;
            };
            if starting {
                handle(app, SystemEvent::Sleep);
                // The keys are zeroized (or there was nothing to lock): let the system sleep.
                drop(inhibitor.take());
            } else if inhibitor.is_none() {
                inhibitor = inhibit(&manager);
            }
        }
        Ok(())
    }

    /// The logind session object of this process (`GetSessionByPID`, else the caller's `auto` session).
    fn session_path(conn: &Connection) -> zbus::Result<OwnedObjectPath> {
        let manager = Proxy::new(conn, LOGIND, LOGIND_PATH, MANAGER)?;
        match manager.call::<_, _, OwnedObjectPath>("GetSessionByPID", &(std::process::id(),)) {
            Ok(p) => Ok(p),
            Err(_) => OwnedObjectPath::try_from("/org/freedesktop/login1/session/auto")
                .map_err(zbus::Error::from),
        }
    }

    fn watch_session_lock(app: &AppHandle) -> zbus::Result<()> {
        let conn = Connection::system()?;
        let path = session_path(&conn)?;
        let session = Proxy::new(&conn, LOGIND, path, SESSION)?;
        for _ in session.receive_signal("Lock")? {
            handle(app, SystemEvent::ScreenLocked);
        }
        Ok(())
    }

    fn watch_locked_hint(app: &AppHandle) -> zbus::Result<()> {
        let conn = Connection::system()?;
        let path = session_path(&conn)?;
        let props = Proxy::new(&conn, LOGIND, path, PROPERTIES)?;
        for msg in props.receive_signal("PropertiesChanged")? {
            let body = msg.body();
            let Ok((iface, changed, _invalidated)) =
                body.deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
            else {
                continue;
            };
            if iface != SESSION {
                continue;
            }
            let locked = changed
                .get("LockedHint")
                .and_then(|v| bool::try_from(v).ok())
                .unwrap_or(false);
            if locked {
                handle(app, SystemEvent::ScreenLocked);
            }
        }
        Ok(())
    }

    fn watch_screensaver(app: &AppHandle) -> zbus::Result<()> {
        let conn = Connection::session()?;
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .member("ActiveChanged")?
            .build();
        for msg in MessageIterator::for_match_rule(rule, &conn, Some(16))? {
            let Ok(msg) = msg else {
                continue;
            };
            let is_screensaver = msg
                .header()
                .interface()
                .is_some_and(|i| i.as_str().ends_with(".ScreenSaver"));
            if !is_screensaver {
                continue;
            }
            let body = msg.body();
            if body.deserialize::<bool>().unwrap_or(false) {
                handle(app, SystemEvent::ScreenLocked);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use emp_store::model::AutoLock;

    #[test]
    fn signals_follow_the_auto_lock_settings() {
        let mut al = AutoLock {
            idle_minutes: Some(15),
            on_sleep: true,
            on_screen_lock: true,
            on_blur_minutes: None,
            max_session_hours: None,
        };
        assert_eq!(
            lock_for(SystemEvent::Sleep, &al),
            Some((LockReason::Sleep, false))
        );
        assert_eq!(
            lock_for(SystemEvent::ScreenLocked, &al),
            Some((LockReason::Screen, true))
        );
        al.on_sleep = false;
        al.on_screen_lock = false;
        assert_eq!(lock_for(SystemEvent::Sleep, &al), None);
        assert_eq!(lock_for(SystemEvent::ScreenLocked, &al), None);
    }
}
