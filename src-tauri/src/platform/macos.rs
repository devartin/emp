//! macOS sleep / screen-lock observers (AppKit `NSWorkspace` + `NSDistributedNotificationCenter`).
//!
//! Block-based observers registered with a `nil` queue run synchronously on the posting thread. AppKit posts the
//! workspace notifications on the main thread, and the distributed notification is delivered through the run loop
//! of the registering thread — hence registration on the main thread. AppKit acknowledges the system sleep only
//! after `NSWorkspaceWillSleepNotification` observers return, so a handler that waits for the lock delays sleep.

use std::ptr::NonNull;

use block2::RcBlock;
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

use super::{SignalHandler, deliver};
use crate::system_events::SystemEvent;

/// Posted by `loginwindow` when the screen locks (screen saver with password, ⌃⌘Q, lid close with lock).
const SCREEN_IS_LOCKED: &str = "com.apple.screenIsLocked";

type Token = Retained<ProtocolObject<dyn NSObjectProtocol>>;

/// The registered observers; removed on drop.
pub(super) struct Watcher {
    observers: Vec<(Retained<NSNotificationCenter>, Token)>,
}

// SAFETY: `NSNotificationCenter` is `Send + Sync` (Apple documents it as thread-safe), and the observer tokens are
// opaque objects that are only ever handed back to `-[NSNotificationCenter removeObserver:]`, which may be called
// from any thread. Nothing else touches them.
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
    let block = RcBlock::new(move |_note: NonNull<NSNotification>| deliver(&handler, event));
    // SAFETY: `obj` is nil (any sender); `queue` is nil, so the block runs synchronously on the posting thread; the
    // block only captures a `Send + Sync` handler, so it is sendable. AppKit copies the block, so dropping our
    // reference afterwards is fine.
    unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) }
}

pub(super) fn watch(handler: SignalHandler) -> Result<Watcher, String> {
    if MainThreadMarker::new().is_none() {
        return Err("system signal observers must be registered on the main thread".into());
    }
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

    let observers = vec![
        (
            workspace_center.clone(),
            observe(&workspace_center, will_sleep, SystemEvent::Sleep, &handler),
        ),
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
    Ok(Watcher { observers })
}
