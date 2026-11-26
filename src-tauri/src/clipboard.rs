//! Secret-aware clipboard (SPEC §9.23 "Clipboard").
//!
//! Secrets, recovery words and passphrases are copied from Rust. EMP remembers only the SHA-256 of what it copied and
//! clears the clipboard after the configured delay (default 30 s) — and on lock — if it still holds that value.
//! Concealed-type pasteboard hints (`org.nspasteboard.ConcealedType`, Windows history/cloud exclusion) need native
//! clipboard APIs the clipboard plugin does not expose; see the crate report.

use std::time::Duration;

use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use zeroize::Zeroizing;

use crate::error::{ApiError, ApiResult};

/// Default delay before an EMP secret is cleared from the clipboard.
pub const DEFAULT_CLEAR_AFTER: Duration = Duration::from_secs(30);

fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

/// Tracks the secret EMP last placed on the clipboard (by hash only).
#[derive(Default)]
pub struct ClipboardGuard {
    current: Mutex<Option<[u8; 32]>>,
}

impl ClipboardGuard {
    /// Remembers `text` as the EMP secret on the clipboard.
    pub fn remember(&self, text: &str) {
        *self.current.lock() = Some(digest(text));
    }

    /// `true` if `clipboard_text` is the secret EMP copied.
    #[must_use]
    pub fn holds(&self, clipboard_text: &str) -> bool {
        self.current
            .lock()
            .is_some_and(|h| h == digest(clipboard_text))
    }

    /// Forgets the remembered secret.
    pub fn forget(&self) {
        *self.current.lock() = None;
    }

    /// Copies a secret and schedules its removal after `clear_after`.
    pub fn copy_secret(
        &self,
        app: &AppHandle,
        text: Zeroizing<String>,
        clear_after: Duration,
    ) -> ApiResult<()> {
        app.clipboard()
            .write_text(text.as_str())
            .map_err(|_| ApiError::internal("clipboard write"))?;
        self.remember(&text);
        drop(text);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(clear_after).await;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let state = tauri::Manager::state::<crate::state::AppState>(&app);
                state.clipboard.clear_if_ours(&app);
            })
            .await;
        });
        Ok(())
    }

    /// Clears the clipboard if it still holds the EMP secret (compared by hash). Returns whether it was cleared.
    pub fn clear_if_ours(&self, app: &AppHandle) -> bool {
        if self.current.lock().is_none() {
            return false;
        }
        let Ok(text) = app.clipboard().read_text() else {
            self.forget();
            return false;
        };
        let text = Zeroizing::new(text);
        if !self.holds(&text) {
            self.forget();
            return false;
        }
        let cleared = app.clipboard().clear().is_ok();
        self.forget();
        if cleared {
            crate::events::Events::new(app.clone()).clipboard_cleared();
        }
        cleared
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_by_hash() {
        let g = ClipboardGuard::default();
        assert!(!g.holds("abc"));
        g.remember("correct horse");
        assert!(g.holds("correct horse"));
        assert!(!g.holds("something else"));
        g.forget();
        assert!(!g.holds("correct horse"));
    }
}
