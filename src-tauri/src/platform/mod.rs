//! Platform-specific process hardening (SPEC §9.11) and native sleep / screen-lock signals (SPEC §9.9, see
//! [`crate::system_events`]). The only module allowed to use `unsafe` (FFI calls).
#![allow(unsafe_code)]

/// Applies best-effort process hardening. Failures are logged, never fatal.
///
/// * Linux: `prctl(PR_SET_DUMPABLE, 0)` (no ptrace attach by same-user processes, no core dumps) and
///   `setrlimit(RLIMIT_CORE, 0)`.
/// * macOS: `setrlimit(RLIMIT_CORE, 0)`; the hardened runtime is applied at signing time.
/// * Windows: `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)`.
pub fn harden_process() {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: prctl with PR_SET_DUMPABLE takes plain integer arguments and has no memory side effects.
        let rc = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
        if rc != 0 {
            tracing::warn!("prctl(PR_SET_DUMPABLE) failed");
        }
    }
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: `limit` is a valid, initialised rlimit that outlives the call.
        let rc = unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) };
        if rc != 0 {
            tracing::warn!("setrlimit(RLIMIT_CORE) failed");
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SetErrorMode,
        };
        // SAFETY: SetErrorMode only changes the process error mode flags.
        unsafe {
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
        }
    }
}

/// Whether core dumps are disabled for this process (unix only; used by tests and diagnostics).
#[cfg(unix)]
#[must_use]
pub fn core_dumps_disabled() -> bool {
    let mut limit = libc::rlimit {
        rlim_cur: 1,
        rlim_max: 1,
    };
    // SAFETY: `limit` is a valid out-parameter.
    let rc = unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut limit) };
    rc == 0 && limit.rlim_cur == 0
}

// ── Native sleep / screen-lock signals (SPEC §9.9) ──────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// How the OS thread that delivers a signal may be treated by the [`SignalHandler`].
#[cfg(any(target_os = "macos", windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// A dedicated signal thread (the IOKit power thread on macOS, the signal window's thread on Windows). The OS
    /// waits for the call to return before it suspends, so a
    /// [`SystemEvent::Sleep`](crate::system_events::SystemEvent::Sleep) handler should return only once the vault
    /// is locked (or a bounded wait elapsed).
    MayBlock,
    /// The UI main thread (AppKit observers). The handler must return at once: the lock's flush window (the
    /// `vault:will-lock` event and the UI's final saves) needs that thread to keep running.
    MustNotBlock,
}

/// Receives native power / session signals on an OS-owned thread, described by the [`Delivery`].
#[cfg(any(target_os = "macos", windows))]
pub type SignalHandler =
    std::sync::Arc<dyn Fn(crate::system_events::SystemEvent, Delivery) + Send + Sync + 'static>;

/// A live registration for native sleep / screen-lock signals. Dropping it unregisters every observer.
#[cfg(any(target_os = "macos", windows))]
pub struct SignalWatcher {
    #[cfg(target_os = "macos")]
    _inner: macos::Watcher,
    #[cfg(windows)]
    _inner: windows::Watcher,
}

/// Registers for the platform's sleep and screen-lock signals and forwards them to `handler`.
///
/// * macOS: IOKit `IORegisterForSystemPower` on a dedicated thread with its own run loop
///   (`kIOMessageSystemWillSleep` → `Sleep`, acknowledged with `IOAllowPowerChange` once the handler returns);
///   `NSWorkspaceScreensDidSleepNotification` and `NSWorkspaceSessionDidResignActiveNotification` (fast user
///   switching) on the shared workspace's notification center, and the distributed `com.apple.screenIsLocked`
///   (→ `ScreenLocked`). `NSWorkspaceWillSleepNotification` (→ `Sleep`, not waited for) is observed only when
///   IOKit registration fails. Must be called on the main thread (the distributed notification is delivered
///   through the registering thread's run loop).
/// * Windows: a message-only window on a dedicated thread with its own message loop, registered with
///   `RegisterSuspendResumeNotification` (`WM_POWERBROADCAST` / `PBT_APMSUSPEND` → `Sleep`) and
///   `WTSRegisterSessionNotification` (`WTS_SESSION_LOCK`, `WTS_CONSOLE_DISCONNECT`, `WTS_REMOTE_DISCONNECT` →
///   `ScreenLocked`).
///
/// # Errors
/// A human-readable reason when nothing could be registered (the caller logs it; idle lock still works).
#[cfg(any(target_os = "macos", windows))]
pub fn watch_system_signals(handler: SignalHandler) -> Result<SignalWatcher, String> {
    #[cfg(target_os = "macos")]
    let inner = macos::watch(handler)?;
    #[cfg(windows)]
    let inner = windows::watch(handler)?;
    Ok(SignalWatcher { _inner: inner })
}

/// Runs a signal handler without letting a panic unwind into OS code (which would abort the process).
#[cfg(any(target_os = "macos", windows))]
fn deliver(handler: &SignalHandler, event: crate::system_events::SystemEvent, delivery: Delivery) {
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(event, delivery)));
    if result.is_err() {
        tracing::error!(?event, "system signal handler panicked");
    }
}
