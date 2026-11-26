//! Platform-specific process hardening (SPEC §9.11). The only module allowed to use `unsafe` (FFI calls).
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
