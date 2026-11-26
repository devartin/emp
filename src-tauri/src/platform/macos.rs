//! macOS sleep / screen-lock signals.
//!
//! * **Sleep** comes from IOKit (`IORegisterForSystemPower`) on a dedicated thread that runs its own `CFRunLoop`.
//!   The system waits (up to 30 s) for every registered client to answer `kIOMessageSystemWillSleep` with
//!   `IOAllowPowerChange`, so that thread holds the answer until the handler returns, i.e. until the lock sequence
//!   has finished, while the AppKit main thread keeps running. That matters: when a screen lock's flush window is
//!   still open as sleep begins, the `vault:will-lock` event and the UI's final saves both need the main thread.
//!   Only if IOKit registration fails is `NSWorkspaceWillSleepNotification` observed instead, and then it is not
//!   waited for (blocking the main thread would cancel the flush window it is meant to protect).
//! * **Screen lock / user switch**: `NSWorkspaceScreensDidSleepNotification`,
//!   `NSWorkspaceSessionDidResignActiveNotification` (fast user switching) on the shared workspace's notification
//!   center, and the distributed `com.apple.screenIsLocked`. Block-based observers registered with a `nil` queue
//!   run synchronously on the posting thread: AppKit posts the workspace notifications on the main thread, and the
//!   distributed notification is delivered through the run loop of the registering thread, hence registration on
//!   the main thread. These handlers never wait.

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use core_foundation_sys::base::{CFRelease, CFRetain};
use core_foundation_sys::runloop::{
    CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRef, CFRunLoopRemoveSource,
    CFRunLoopRunInMode, CFRunLoopStop, kCFRunLoopDefaultMode, kCFRunLoopRunFinished,
};
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2_app_kit::{
    NSWorkspace, NSWorkspaceScreensDidSleepNotification,
    NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
};
use objc2_foundation::{
    NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSNotificationName,
    NSString,
};

use super::{Delivery, SignalHandler, deliver};
use crate::system_events::SystemEvent;

/// Posted by `loginwindow` when the screen locks (screen saver with password, ⌃⌘Q, lid close with lock).
const SCREEN_IS_LOCKED: &str = "com.apple.screenIsLocked";

type Token = Retained<ProtocolObject<dyn NSObjectProtocol>>;

/// The registered observers and the power thread; everything is unregistered on drop.
pub(super) struct Watcher {
    observers: Vec<(Retained<NSNotificationCenter>, Token)>,
    _power: Option<PowerWatcher>,
}

// SAFETY: `NSNotificationCenter` is `Send + Sync` (Apple documents it as thread-safe), and the observer tokens are
// opaque objects that are only ever handed back to `-[NSNotificationCenter removeObserver:]`, which may be called
// from any thread. Nothing else touches them. `PowerWatcher` is `Send` on its own.
unsafe impl Send for Watcher {}

impl Drop for Watcher {
    fn drop(&mut self) {
        for (center, token) in self.observers.drain(..) {
            let observer: &objc2::runtime::AnyObject = (*token).as_ref();
            // SAFETY: `token` was returned by `addObserverForName:object:queue:usingBlock:` on this same center.
            unsafe { center.removeObserver(observer) };
        }
    }
}

fn observe(
    center: &Retained<NSNotificationCenter>,
    name: &NSNotificationName,
    event: SystemEvent,
    handler: &SignalHandler,
) -> Token {
    let handler = handler.clone();
    // Observers run on the main thread: never hold it (see the module docs).
    let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
        deliver(&handler, event, Delivery::MustNotBlock);
    });
    // SAFETY: `obj` is nil (any sender); `queue` is nil, so the block runs synchronously on the posting thread; the
    // block only captures a `Send + Sync` handler, so it is sendable. AppKit copies the block, so dropping our
    // reference afterwards is fine.
    unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) }
}

pub(super) fn watch(handler: SignalHandler) -> Result<Watcher, String> {
    if MainThreadMarker::new().is_none() {
        return Err("system signal observers must be registered on the main thread".into());
    }
    let power = match watch_power(handler.clone()) {
        Ok(power) => Some(power),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "IOKit sleep notifications unavailable; using NSWorkspaceWillSleepNotification (sleep is not delayed for the lock)"
            );
            None
        }
    };

    let workspace_center = NSWorkspace::sharedWorkspace().notificationCenter();
    let distributed_center = NSDistributedNotificationCenter::defaultCenter().into_super();
    // SAFETY: these are immutable `NSString` constants exported by AppKit, valid for the life of the process.
    let (will_sleep, screens_sleep, resign_active) = unsafe {
        (
            NSWorkspaceWillSleepNotification,
            NSWorkspaceScreensDidSleepNotification,
            NSWorkspaceSessionDidResignActiveNotification,
        )
    };
    let screen_locked = NSString::from_str(SCREEN_IS_LOCKED);

    let mut observers = vec![
        (
            workspace_center.clone(),
            observe(
                &workspace_center,
                screens_sleep,
                SystemEvent::ScreenLocked,
                &handler,
            ),
        ),
        (
            workspace_center.clone(),
            observe(
                &workspace_center,
                resign_active,
                SystemEvent::ScreenLocked,
                &handler,
            ),
        ),
        (
            distributed_center.clone(),
            observe(
                &distributed_center,
                &screen_locked,
                SystemEvent::ScreenLocked,
                &handler,
            ),
        ),
    ];
    if power.is_none() {
        observers.push((
            workspace_center.clone(),
            observe(&workspace_center, will_sleep, SystemEvent::Sleep, &handler),
        ));
    }
    Ok(Watcher {
        observers,
        _power: power,
    })
}

// ── IOKit system power notifications ───────────────────────────────────────────────────────────────────────────

/// The subset of `IOKit/pwr_mgt/IOPMLib.h`, `IOKit/IOKitLib.h` and `IOKit/IOMessage.h` used here.
mod iokit {
    use std::ffi::c_void;

    use core_foundation_sys::runloop::CFRunLoopSourceRef;

    /// `io_object_t` / `io_connect_t` / `io_service_t` (all `mach_port_t`, a `u32`); `0` is `MACH_PORT_NULL`.
    pub type IoObject = u32;
    /// `IOReturn` (`kern_return_t`).
    pub type IoReturn = i32;
    /// `IONotificationPortRef` (opaque).
    pub type NotificationPortRef = *mut c_void;
    /// `IOServiceInterestCallback`.
    pub type InterestCallback = extern "C" fn(
        refcon: *mut c_void,
        service: IoObject,
        message_type: u32,
        message_argument: *mut c_void,
    );

    /// `kIOMessageCanSystemSleep` = `iokit_common_msg(0x270)` (`sys_iokit` = `0xE0000000`, `sub_iokit_common` = 0).
    pub const MSG_CAN_SYSTEM_SLEEP: u32 = 0xE000_0270;
    /// `kIOMessageSystemWillSleep` = `iokit_common_msg(0x280)`.
    pub const MSG_SYSTEM_WILL_SLEEP: u32 = 0xE000_0280;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        pub fn IORegisterForSystemPower(
            refcon: *mut c_void,
            the_port_ref: *mut NotificationPortRef,
            callback: InterestCallback,
            notifier: *mut IoObject,
        ) -> IoObject;
        pub fn IODeregisterForSystemPower(notifier: *mut IoObject) -> IoReturn;
        pub fn IOAllowPowerChange(kernel_port: IoObject, notification_id: isize) -> IoReturn;
        pub fn IONotificationPortGetRunLoopSource(notify: NotificationPortRef)
        -> CFRunLoopSourceRef;
        pub fn IONotificationPortDestroy(notify: NotificationPortRef);
        pub fn IOServiceClose(connect: IoObject) -> IoReturn;
    }
}

/// How long `watch` waits for the power thread to register.
const POWER_START_TIMEOUT: Duration = Duration::from_secs(5);
/// Each run of the power thread's loop; the stop flag is checked in between (stop also interrupts a run).
const POWER_RUN_SLICE_SECS: f64 = 60.0;

/// What the IOKit callback needs; owned by the power thread, which frees it only after deregistering.
struct PowerContext {
    handler: SignalHandler,
    /// The root power domain connection (`IORegisterForSystemPower`'s result), for `IOAllowPowerChange`.
    root_port: Cell<iokit::IoObject>,
}

/// A retained reference to the power thread's run loop.
struct RunLoop(CFRunLoopRef);

// SAFETY: the reference is retained (valid until `Drop`), and from other threads it is only passed to
// `CFRunLoopStop` and `CFRelease`, which CoreFoundation documents as thread-safe.
unsafe impl Send for RunLoop {}

impl Drop for RunLoop {
    fn drop(&mut self) {
        // SAFETY: balances the `CFRetain` taken when this value was created.
        unsafe { CFRelease(self.0.cast_const().cast()) };
    }
}

/// The power thread; dropping it stops the thread's run loop, after which the thread deregisters and exits
/// (detached: a sleep acknowledgement in progress is allowed to finish).
struct PowerWatcher {
    run_loop: RunLoop,
    stop: Arc<AtomicBool>,
}

impl Drop for PowerWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // SAFETY: `run_loop` is a retained, valid run loop; stopping one that is not running is a no-op (the flag
        // above then ends the thread's loop before its next run).
        unsafe { CFRunLoopStop(self.run_loop.0) };
    }
}

extern "C" fn power_callback(
    refcon: *mut c_void,
    _service: iokit::IoObject,
    message_type: u32,
    message_argument: *mut c_void,
) {
    if refcon.is_null() {
        return;
    }
    // SAFETY: `refcon` is the `PowerContext` the power thread passed to `IORegisterForSystemPower`; that thread
    // keeps it alive until after `IODeregisterForSystemPower`, and callbacks only run on it (inside its run loop).
    let ctx = unsafe { &*refcon.cast::<PowerContext>() };
    match message_type {
        // An idle-sleep query: never veto it (the sleep itself is handled below).
        iokit::MSG_CAN_SYSTEM_SLEEP => allow_power_change(ctx, message_argument),
        iokit::MSG_SYSTEM_WILL_SLEEP => {
            // Holds this thread (not the UI thread) until the lock has finished or the bounded wait elapsed; the
            // system sleeps only after the acknowledgement below.
            deliver(&ctx.handler, SystemEvent::Sleep, Delivery::MayBlock);
            allow_power_change(ctx, message_argument);
        }
        _ => {}
    }
}

fn allow_power_change(ctx: &PowerContext, message_argument: *mut c_void) {
    // SAFETY: `root_port` is the live connection from `IORegisterForSystemPower`; the notification id is the
    // message argument IOKit passed to the callback, handed back unchanged as documented.
    let rc = unsafe { iokit::IOAllowPowerChange(ctx.root_port.get(), message_argument as isize) };
    if rc != 0 {
        tracing::debug!(rc, "IOAllowPowerChange failed");
    }
}

fn watch_power(handler: SignalHandler) -> Result<PowerWatcher, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<RunLoop, String>>(1);
    let thread_stop = Arc::clone(&stop);
    std::thread::Builder::new()
        .name("emp-power-signals".into())
        .spawn(move || power_thread(handler, &thread_stop, &ready_tx))
        .map_err(|e| format!("could not start the power signal thread: {e}"))?;
    match ready_rx.recv_timeout(POWER_START_TIMEOUT) {
        Ok(Ok(run_loop)) => Ok(PowerWatcher { run_loop, stop }),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // The thread cleans up on its own once it sees the flag (or fails to hand over its run loop).
            stop.store(true, Ordering::SeqCst);
            Err("the power signal thread did not start in time".into())
        }
    }
}

fn power_thread(
    handler: SignalHandler,
    stop: &AtomicBool,
    ready: &mpsc::SyncSender<Result<RunLoop, String>>,
) {
    let ctx = Box::into_raw(Box::new(PowerContext {
        handler,
        root_port: Cell::new(0),
    }));
    let mut port: iokit::NotificationPortRef = std::ptr::null_mut();
    let mut notifier: iokit::IoObject = 0;
    // SAFETY: the out-parameters are valid for writes; `ctx` stays alive until after deregistration below; the
    // callback has the `IOServiceInterestCallback` signature.
    let root = unsafe {
        iokit::IORegisterForSystemPower(ctx.cast(), &mut port, power_callback, &mut notifier)
    };
    if root == 0 || port.is_null() {
        // SAFETY: registration failed, so IOKit holds no reference to `ctx`; reclaim the box made above.
        drop(unsafe { Box::from_raw(ctx) });
        let _ = ready.send(Err("IORegisterForSystemPower failed".into()));
        return;
    }
    // SAFETY: `ctx` is valid and no callback can run before this thread's run loop does.
    unsafe { &*ctx }.root_port.set(root);

    // SAFETY: `port` is the live notification port from the registration; the current run loop belongs to this
    // thread; `kCFRunLoopDefaultMode` is an immutable CoreFoundation constant.
    let (source, current) = unsafe {
        let source = iokit::IONotificationPortGetRunLoopSource(port);
        let current = CFRunLoopGetCurrent();
        CFRunLoopAddSource(current, source, kCFRunLoopDefaultMode);
        CFRetain(current.cast_const().cast());
        (source, current)
    };
    let handed_over = ready.send(Ok(RunLoop(current))).is_ok();

    while handed_over && !stop.load(Ordering::SeqCst) {
        // SAFETY: runs this thread's own run loop; the IOKit callback above is dispatched from inside it.
        let result = unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, POWER_RUN_SLICE_SECS, 0) };
        if result == kCFRunLoopRunFinished {
            break;
        }
    }

    // SAFETY: tears down, in the documented order, exactly what was registered above, on the registering thread;
    // afterwards no callback can run, so `ctx` can be freed.
    unsafe {
        CFRunLoopRemoveSource(current, source, kCFRunLoopDefaultMode);
        iokit::IODeregisterForSystemPower(&mut notifier);
        iokit::IOServiceClose(root);
        iokit::IONotificationPortDestroy(port);
        drop(Box::from_raw(ctx));
    }
}
