//! Windows suspend / session-lock notifications through a message-only window.
//!
//! A dedicated thread registers a window class, creates a message-only window (`HWND_MESSAGE`) and runs its own
//! message loop. The window is registered with:
//! * `RegisterSuspendResumeNotification(DEVICE_NOTIFY_WINDOW_HANDLE)` — message-only windows do not receive the
//!   broadcast `WM_POWERBROADCAST`, so suspend notifications are requested for this window explicitly;
//!   `PBT_APMSUSPEND` → `Sleep` (Windows waits for the window procedure to return, about two seconds at most).
//! * `WTSRegisterSessionNotification(NOTIFY_FOR_THIS_SESSION)` — `WM_WTSSESSION_CHANGE` with `WTS_SESSION_LOCK`,
//!   `WTS_CONSOLE_DISCONNECT` (fast user switching) or `WTS_REMOTE_DISCONNECT` → `ScreenLocked`.
//!
//! Dropping the [`Watcher`] posts `WM_CLOSE`; the window procedure unregisters both notifications, destroys the
//! window and ends the loop, and the thread unregisters the class.

use std::cell::{Cell, RefCell};
use std::sync::mpsc;
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{
    HPOWERNOTIFY, RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification,
};
use windows_sys::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DEVICE_NOTIFY_WINDOW_HANDLE, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetMessageW, HWND_MESSAGE, MSG, PBT_APMSUSPEND, PostMessageW, PostQuitMessage,
    RegisterClassExW, TranslateMessage, UnregisterClassW, WM_CLOSE, WM_DESTROY, WM_POWERBROADCAST,
    WM_WTSSESSION_CHANGE, WNDCLASSEXW, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT,
    WTS_SESSION_LOCK,
};

use super::{Delivery, SignalHandler, deliver};
use crate::system_events::SystemEvent;

const CLASS_NAME: &str = "EmpSystemSignalWindow";

thread_local! {
    /// The handler for the window owned by this thread (only the signal thread sets it).
    static HANDLER: RefCell<Option<SignalHandler>> = const { RefCell::new(None) };
    /// The suspend/resume registration of this thread's window (0 = none).
    static POWER_NOTIFY: Cell<HPOWERNOTIFY> = const { Cell::new(0) };
    /// Whether this thread's window is registered for session notifications.
    static WTS_REGISTERED: Cell<bool> = const { Cell::new(false) };
}

/// The signal window and its thread; closing the window ends the thread.
pub(super) struct Watcher {
    /// The window handle as an integer (`HWND` is a raw pointer and not `Send`); only used with `PostMessageW`,
    /// which accepts any handle and fails harmlessly for a destroyed window.
    hwnd: isize,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // SAFETY: posting a message takes no pointers; a stale handle makes the call fail, which we ignore.
        let posted = unsafe { PostMessageW(self.hwnd as HWND, WM_CLOSE, 0, 0) } != 0;
        if let Some(thread) = self.thread.take()
            && posted
            && thread.join().is_err()
        {
            tracing::warn!("system signal thread panicked");
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn dispatch(event: SystemEvent) {
    let handler = HANDLER.with(|h| h.borrow().clone());
    if let Some(handler) = handler {
        // This thread is ours (not the UI thread), so a sleep handler may hold it until the lock is done.
        deliver(&handler, event, Delivery::MayBlock);
    }
}

/// Unregisters the notifications of `hwnd` (idempotent).
fn unregister(hwnd: HWND) {
    let power = POWER_NOTIFY.with(|p| p.replace(0));
    if power != 0 {
        // SAFETY: `power` was returned by `RegisterSuspendResumeNotification` and is unregistered once.
        unsafe { UnregisterSuspendResumeNotification(power) };
    }
    if WTS_REGISTERED.with(|w| w.replace(false)) {
        // SAFETY: `hwnd` is this thread's live window, registered with `WTSRegisterSessionNotification`.
        unsafe { WTSUnRegisterSessionNotification(hwnd) };
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_POWERBROADCAST => {
            if wparam == PBT_APMSUSPEND as WPARAM {
                dispatch(SystemEvent::Sleep);
            }
            1
        }
        WM_WTSSESSION_CHANGE => {
            let code = u32::try_from(wparam).unwrap_or(u32::MAX);
            if matches!(
                code,
                WTS_SESSION_LOCK | WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT
            ) {
                dispatch(SystemEvent::ScreenLocked);
            }
            0
        }
        WM_CLOSE => {
            // SAFETY: `hwnd` is the window this procedure serves, destroyed on its own thread.
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_DESTROY => {
            unregister(hwnd);
            // SAFETY: ends this thread's message loop; no pointers involved.
            unsafe { PostQuitMessage(0) };
            0
        }
        // SAFETY: default processing with the arguments we were given.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Creates the window and registers its notifications; returns the window handle.
fn create_window(hinstance: HINSTANCE, class_name: &[u16]) -> Result<HWND, String> {
    let class = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        style: 0,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: std::ptr::null_mut(),
    };
    // SAFETY: `class` is fully initialised and `class_name` (NUL-terminated) outlives the registration, which is
    // removed by `UnregisterClassW` before `class_name` is dropped.
    if unsafe { RegisterClassExW(&class) } == 0 {
        // SAFETY: reads this thread's last-error value.
        let err = unsafe { GetLastError() };
        if err != ERROR_CLASS_ALREADY_EXISTS {
            return Err(format!("RegisterClassExW failed ({err})"));
        }
    }
    // SAFETY: the class is registered; `HWND_MESSAGE` makes a message-only window; all pointers are valid or null.
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        )
    };
    if hwnd.is_null() {
        // SAFETY: reads this thread's last-error value.
        let err = unsafe { GetLastError() };
        return Err(format!("CreateWindowExW failed ({err})"));
    }

    // SAFETY: `hwnd` is a live window owned by this thread.
    let wts = unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } != 0;
    WTS_REGISTERED.with(|w| w.set(wts));
    if !wts {
        tracing::info!("session lock notifications unavailable; relying on idle lock");
    }
    // SAFETY: with `DEVICE_NOTIFY_WINDOW_HANDLE` the recipient is a window handle; `hwnd` is live.
    let power = unsafe { RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE) };
    POWER_NOTIFY.with(|p| p.set(power));
    if power == 0 {
        tracing::info!("suspend notifications unavailable; relying on resume detection");
    }
    if !wts && power == 0 {
        // SAFETY: destroys our own window on its thread (WM_DESTROY posts a quit message that is never read).
        unsafe { DestroyWindow(hwnd) };
        return Err("neither session nor suspend notifications could be registered".into());
    }
    Ok(hwnd)
}

fn run(handler: SignalHandler, ready: &mpsc::SyncSender<Result<isize, String>>) {
    // SAFETY: a null module name returns the handle of the current executable; nothing is retained.
    let hinstance: HINSTANCE = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(CLASS_NAME);
    HANDLER.with(|h| *h.borrow_mut() = Some(handler));
    match create_window(hinstance, &class_name) {
        Ok(hwnd) => {
            let _ = ready.send(Ok(hwnd as isize));
            // SAFETY: `MSG` is plain data (integers and pointers) for which all-zero is a valid value.
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            loop {
                // SAFETY: `msg` is a valid out-parameter; a null window reads every message of this thread.
                let rc = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
                if rc == 0 || rc == -1 {
                    break;
                }
                // SAFETY: `msg` was filled by `GetMessageW`.
                unsafe {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }
    HANDLER.with(|h| h.borrow_mut().take());
    // SAFETY: no window of this class is alive any more on this thread; failure (e.g. another live window of the
    // class) is harmless.
    unsafe { UnregisterClassW(class_name.as_ptr(), hinstance) };
}

pub(super) fn watch(handler: SignalHandler) -> Result<Watcher, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name("emp-system-signals-win".into())
        .spawn(move || run(handler, &tx))
        .map_err(|e| format!("could not start the signal thread: {e}"))?;
    match rx.recv() {
        Ok(Ok(hwnd)) => Ok(Watcher {
            hwnd,
            thread: Some(thread),
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = thread.join();
            Err("the signal thread exited during start-up".into())
        }
    }
}
