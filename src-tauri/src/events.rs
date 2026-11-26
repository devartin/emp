//! Events from Rust to the webview (SPEC §11.4).
//!
//! Every event goes to the `main` window only. [`Events`] is the emitter used by commands and background tasks;
//! [`StoreEventSink`] forwards [`emp_store::StoreEvent`]s.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::autolock::LockReason;
use crate::grants::FileGrant;

/// `vault:will-lock`.
pub const VAULT_WILL_LOCK: &str = "vault:will-lock";
/// `vault:locked`.
pub const VAULT_LOCKED: &str = "vault:locked";
/// `vault:status`.
pub const VAULT_STATUS: &str = "vault:status";
/// `vault:autolock-soon`.
pub const VAULT_AUTOLOCK_SOON: &str = "vault:autolock-soon";
/// `tree:changed`.
pub const TREE_CHANGED: &str = "tree:changed";
/// `page:changed`.
pub const PAGE_CHANGED: &str = "page:changed";
/// `db:changed`.
pub const DB_CHANGED: &str = "db:changed";
/// `sheet:changed`.
pub const SHEET_CHANGED: &str = "sheet:changed";
/// `search:ready`.
pub const SEARCH_READY: &str = "search:ready";
/// `file:dropped`.
pub const FILE_DROPPED: &str = "file:dropped";
/// `open-external:confirm`.
pub const OPEN_EXTERNAL_CONFIRM: &str = "open-external:confirm";
/// `reminder:due`.
pub const REMINDER_DUE: &str = "reminder:due";
/// `insight:new`.
pub const INSIGHT_NEW: &str = "insight:new";
/// `sync:status`.
pub const SYNC_STATUS: &str = "sync:status";
/// `net:activity`.
pub const NET_ACTIVITY: &str = "net:activity";
/// `market:alert`.
pub const MARKET_ALERT: &str = "market:alert";
/// `update:available`.
pub const UPDATE_AVAILABLE: &str = "update:available";
/// `integrity:warning`.
pub const INTEGRITY_WARNING: &str = "integrity:warning";
/// `clipboard:cleared`.
pub const CLIPBOARD_CLEARED: &str = "clipboard:cleared";

/// The label of the only window in v1.
pub const MAIN_WINDOW: &str = "main";

/// `vault:will-lock` / `vault:locked` payload.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct LockPayload {
    /// Why.
    pub reason: LockReason,
}

/// `vault:autolock-soon` payload.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutolockSoon {
    /// Seconds until the idle lock.
    pub seconds_left: u64,
}

/// `tree:changed` payload.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeChanged {
    /// Workspace.
    pub workspace_id: String,
    /// Created or changed pages.
    pub upserted: Vec<emp_store::model::PageMeta>,
    /// Removed page ids.
    pub removed: Vec<String>,
}

/// `page:changed` payload.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageChanged {
    /// Page id.
    pub id: String,
    /// New meta revision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta_rev: Option<i64>,
    /// New document revision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_rev: Option<i64>,
}

/// `search:ready` payload.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct SearchReady {
    /// Indexed documents.
    pub docs: usize,
}

/// `integrity:warning` payload.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityWarning {
    /// Damaged records.
    pub damaged: usize,
    /// Manifest root / MAC mismatch.
    pub mset_mismatch: bool,
}

/// `file:dropped` payload.
#[derive(Clone, Debug, Serialize)]
pub struct FileDropped {
    /// One read grant per dropped file.
    pub grants: Vec<FileGrant>,
    /// Drop position (logical px).
    pub x: f64,
    /// Drop position (logical px).
    pub y: f64,
}

/// `open-external:confirm` payload.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenExternalConfirm {
    /// Answer with `open_external_confirm({ requestId, … })`.
    pub request_id: String,
    /// The URL.
    pub url: String,
    /// Host in Unicode.
    pub host: String,
    /// Host in punycode.
    pub punycode: String,
}

/// `reminder:due` payload.
#[derive(Clone, Debug, Serialize)]
pub struct ReminderDue {
    /// Reminder id.
    pub id: String,
    /// Reminder text.
    pub text: String,
}

/// `net:activity` payload.
#[derive(Clone, Debug, Serialize)]
pub struct NetActivity {
    /// Connector id.
    pub connector: String,
    /// Host.
    pub host: String,
}

/// Emits events to the main window.
#[derive(Clone)]
pub struct Events {
    app: AppHandle,
}

impl Events {
    /// An emitter for `app`.
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// The app handle.
    #[must_use]
    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// Emits `event` with `payload` to the main window. Failures (window gone) are logged and ignored.
    pub fn emit<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if self.app.get_webview_window(MAIN_WINDOW).is_none() {
            return;
        }
        if let Err(e) = self.app.emit_to(MAIN_WINDOW, event, payload) {
            tracing::debug!(event, error = %e, "emit failed");
        }
    }

    /// `clipboard:cleared {}`.
    pub fn clipboard_cleared(&self) {
        self.emit(CLIPBOARD_CLEARED, serde_json::json!({}));
    }
}

/// Forwards store events to the webview.
pub struct StoreEventSink {
    events: Events,
}

impl StoreEventSink {
    /// A sink emitting through `events`.
    #[must_use]
    pub fn new(events: Events) -> Self {
        Self { events }
    }
}

impl emp_store::EventSink for StoreEventSink {
    fn emit(&self, event: emp_store::StoreEvent) {
        use emp_store::StoreEvent as E;
        match event {
            E::SearchReady { docs } => self.events.emit(SEARCH_READY, SearchReady { docs }),
            E::IntegrityWarning {
                damaged,
                mset_mismatch,
            } => self.events.emit(
                INTEGRITY_WARNING,
                IntegrityWarning {
                    damaged,
                    mset_mismatch,
                },
            ),
            E::TreeChanged {
                workspace_id,
                upserted,
                removed,
            } => self.events.emit(
                TREE_CHANGED,
                TreeChanged {
                    workspace_id,
                    upserted,
                    removed,
                },
            ),
            E::PageChanged {
                id,
                meta_rev,
                doc_rev,
            } => self.events.emit(
                PAGE_CHANGED,
                PageChanged {
                    id,
                    meta_rev,
                    doc_rev,
                },
            ),
            E::DbChanged {
                database_id,
                data_rev,
                schema_rev,
                row_ids,
            } => self.events.emit(
                DB_CHANGED,
                crate::commands::db::DbChanged {
                    database_id,
                    data_rev,
                    schema_rev,
                    row_ids,
                },
            ),
            E::StatusChanged => {
                // The sink must not call back into the store synchronously: re-read the status on the pool.
                let app = self.events.app().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app.state::<crate::state::AppState>();
                    state.emit_status();
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_shapes() {
        assert_eq!(
            serde_json::to_value(LockPayload {
                reason: LockReason::Idle
            })
            .unwrap(),
            serde_json::json!({ "reason": "idle" })
        );
        assert_eq!(
            serde_json::to_value(AutolockSoon { seconds_left: 42 }).unwrap(),
            serde_json::json!({ "secondsLeft": 42 })
        );
        assert_eq!(
            serde_json::to_value(PageChanged {
                id: "p".into(),
                meta_rev: None,
                doc_rev: Some(3)
            })
            .unwrap(),
            serde_json::json!({ "id": "p", "docRev": 3 })
        );
        assert_eq!(
            serde_json::to_value(IntegrityWarning {
                damaged: 1,
                mset_mismatch: true
            })
            .unwrap(),
            serde_json::json!({ "damaged": 1, "msetMismatch": true })
        );
        let v = serde_json::to_value(OpenExternalConfirm {
            request_id: "r".into(),
            url: "https://a.b/".into(),
            host: "a.b".into(),
            punycode: "a.b".into(),
        })
        .unwrap();
        assert_eq!(v["requestId"], "r");
    }
}
