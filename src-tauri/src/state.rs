//! Application state: the open vault, its session, jobs, grants, auto-lock and the lock sequence (SPEC §9.9, §11.1).
//!
//! One [`AppState`] is managed by Tauri. Commands call [`AppState::session`] first, which returns `LOCKED` while the
//! vault is locked and stamps user activity; *(reauth)* commands additionally call [`AppState::require_reauth`]
//! (the 5-minute sudo window lives in the store session and is zeroized with it).

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use emp_store::model::{AutoLock, DeviceSettings, VaultStatus};
use emp_store::{FileDeviceKeyStore, Store, StoreOptions};
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::autolock::{ActivityTracker, Decision, LockReason};
use crate::clipboard::ClipboardGuard;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::events::{self, Events, LockPayload};
use crate::grants::GrantRegistry;
use crate::jobs::JobRegistry;
use crate::keychain::KeychainDeviceKeyStore;
use crate::navigation::ExternalLinks;

/// Set by the panic hook; the ticker locks the vault (reason `panic`) when it sees it (D-15).
pub static PANICKED: AtomicBool = AtomicBool::new(false);

/// How long the UI gets to flush pending saves after `vault:will-lock` (automatic locks only).
pub const WILL_LOCK_GRACE: Duration = Duration::from_millis(1_500);
/// How long in-flight commands get to finish once the vault is marked locked (SPEC §9.9 step 2).
pub const IN_FLIGHT_GRACE: Duration = Duration::from_secs(2);

/// Command bodies currently running through [`blocking`].
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    /// Set while this thread runs a command body counted in [`IN_FLIGHT`].
    static IN_COMMAND: Cell<bool> = const { Cell::new(false) };
}

/// Counts one command body as in flight for its lifetime.
struct InFlight {
    outer: bool,
}

impl InFlight {
    fn enter() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self {
            outer: IN_COMMAND.with(|c| c.replace(true)),
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_COMMAND.with(|c| c.set(self.outer));
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Number of command bodies running right now, not counting the calling thread's own.
#[must_use]
pub fn in_flight_others() -> usize {
    let own = usize::from(IN_COMMAND.with(Cell::get));
    IN_FLIGHT.load(Ordering::SeqCst).saturating_sub(own)
}

/// Waits until no other command body is in flight, at most `limit`. Returns `true` when they all finished.
pub fn wait_in_flight(limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        if in_flight_others() == 0 {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Internal kv namespace of the persisted network log (SPEC §9.18).
pub const NET_LOG_NS: &str = "net.log";
/// Internal kv namespace of app preferences that live in the vault.
pub const APP_NS: &str = "app.prefs";
/// Key of the remembered external-link hosts in [`APP_NS`].
pub const REMEMBERED_HOSTS_KEY: &str = "openExternalHosts";

/// Files and directories under the app data directory (SPEC §10.1).
#[derive(Clone, Debug)]
pub struct AppPaths {
    /// `<app data>`.
    pub data_dir: PathBuf,
}

impl AppPaths {
    /// `<data>/logs`.
    #[must_use]
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }
    /// `<data>/vaults`.
    #[must_use]
    pub fn vaults_dir(&self) -> PathBuf {
        self.data_dir.join("vaults")
    }
    /// `<data>/device.key` (fallback without a keychain).
    #[must_use]
    pub fn device_key_file(&self) -> PathBuf {
        self.data_dir.join("device.key")
    }
    /// `<data>/current-vault`: the directory name (under `vaults/`) of the vault to open.
    #[must_use]
    pub fn current_vault_file(&self) -> PathBuf {
        self.data_dir.join("current-vault")
    }
    /// `<data>/device-settings.json`: device settings chosen before a vault exists (moved into it on create).
    #[must_use]
    pub fn pending_device_settings_file(&self) -> PathBuf {
        self.data_dir.join("device-settings.json")
    }
}

/// Picks the vault directory to open: the recorded one if it still exists, else the first vault found.
#[must_use]
pub fn choose_vault(available: &[String], recorded: Option<&str>) -> Option<String> {
    let recorded = recorded.map(str::trim).filter(|r| !r.is_empty());
    if let Some(r) = recorded
        && available.iter().any(|a| a == r)
    {
        return Some(r.to_owned());
    }
    available.first().cloned()
}

/// `true` for a safe vault directory name (no separators, no dot segments).
#[must_use]
pub fn is_vault_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-' || b.is_ascii_lowercase())
}

/// Re-asserts 0700 on directories and 0600 on files directly inside `dir`, warning when the directory was readable
/// by group or others (SPEC §9.23 "Permissions").
pub fn assert_private_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(dir) {
            if meta.permissions().mode() & 0o077 != 0 {
                tracing::warn!("data directory was group/world accessible; tightening permissions");
            }
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        // Walk the tree (vaults/<id>/assets/<xx>/… is four levels deep), bounded so a huge tree cannot stall start-up.
        let mut stack = vec![(dir.to_path_buf(), 0usize)];
        let mut budget = PERMISSION_WALK_BUDGET;
        while let Some((d, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else {
                continue;
            };
            for e in entries.flatten() {
                if budget == 0 {
                    return;
                }
                budget -= 1;
                // `symlink_metadata`: never follow links out of the data directory.
                let Ok(meta) = e.path().symlink_metadata() else {
                    continue;
                };
                if meta.file_type().is_symlink() {
                    continue;
                }
                let mode = if meta.is_dir() { 0o700 } else { 0o600 };
                if meta.permissions().mode() & 0o777 != mode {
                    let _ =
                        std::fs::set_permissions(e.path(), std::fs::Permissions::from_mode(mode));
                }
                if meta.is_dir() && depth < PERMISSION_WALK_DEPTH {
                    stack.push((e.path(), depth + 1));
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Maximum directory depth re-asserted by [`assert_private_dir`].
pub const PERMISSION_WALK_DEPTH: usize = 5;
/// Maximum entries visited by [`assert_private_dir`].
pub const PERMISSION_WALK_BUDGET: usize = 200_000;

/// The managed application state.
pub struct AppState {
    /// Paths.
    pub paths: AppPaths,
    /// Event emitter.
    pub events: Events,
    /// Running jobs.
    pub jobs: Arc<JobRegistry>,
    /// File grants.
    pub grants: GrantRegistry,
    /// Auto-lock bookkeeping.
    pub activity: ActivityTracker,
    /// External-link confirmations.
    pub links: ExternalLinks,
    /// The egress guard.
    pub net: emp_integrations::NetGuard,
    /// Clipboard secret tracking.
    pub clipboard: ClipboardGuard,
    /// Device-key storage.
    pub device_keys: Arc<KeychainDeviceKeyStore>,
    store: RwLock<Option<Store>>,
    auto_lock: Mutex<AutoLock>,
    calibration: Mutex<Option<emp_crypto::kdf::Calibration>>,
    unlock_busy: AtomicBool,
    /// A lock sequence is running (re-entrancy guard).
    lock_running: AtomicBool,
    /// The vault is being locked: data commands already get `LOCKED` (SPEC §9.9 step 2).
    locking: AtomicBool,
    started: Instant,
    ready_marks: Mutex<Option<Value>>,
}

/// Clears [`AppState::unlock_busy`] on drop.
pub struct UnlockGuard<'a>(&'a AtomicBool);

impl Drop for UnlockGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl AppState {
    /// Builds the state for `app` with its data directory at `data_dir`, and opens the current vault if any.
    pub fn new(app: &AppHandle, data_dir: PathBuf) -> anyhow::Result<Self> {
        emp_store::vault::create_private_dir(&data_dir)
            .map_err(|e| anyhow::anyhow!("data directory: {e}"))?;
        assert_private_dir(&data_dir);
        let paths = AppPaths { data_dir };
        let device_keys =
            KeychainDeviceKeyStore::new(FileDeviceKeyStore::new(paths.device_key_file()));
        let net = emp_integrations::NetGuard::new(emp_integrations::NetGuardConfig::default())
            .map_err(|e| anyhow::anyhow!("network client: {e}"))?;
        let state = Self {
            events: Events::new(app.clone()),
            jobs: Arc::new(JobRegistry::default()),
            grants: GrantRegistry::default(),
            activity: ActivityTracker::default(),
            links: ExternalLinks::default(),
            net,
            clipboard: ClipboardGuard::default(),
            device_keys,
            store: RwLock::new(None),
            auto_lock: Mutex::new(AutoLock::default()),
            calibration: Mutex::new(None),
            unlock_busy: AtomicBool::new(false),
            lock_running: AtomicBool::new(false),
            locking: AtomicBool::new(false),
            started: Instant::now(),
            ready_marks: Mutex::new(None),
            paths,
        };
        state.open_current_vault();
        Ok(state)
    }

    /// Store options for vaults opened by this app.
    #[must_use]
    pub fn store_options(&self) -> StoreOptions {
        let mut o = StoreOptions::new(self.paths.device_key_file());
        o.device_keys = self.device_keys.clone();
        o.events = Arc::new(events::StoreEventSink::new(self.events.clone()));
        o.asset_url_base = crate::protocol::asset_url_base().to_owned();
        o.app_version = env!("CARGO_PKG_VERSION").to_owned();
        o
    }

    fn open_current_vault(&self) {
        let available = match std::fs::read_dir(self.paths.vaults_dir()) {
            Ok(rd) => {
                let mut v: Vec<String> = rd
                    .flatten()
                    .filter(|e| Store::exists(&e.path()))
                    .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                    .filter(|n| is_vault_dir_name(n))
                    .collect();
                v.sort();
                v
            }
            Err(_) => Vec::new(),
        };
        let recorded = std::fs::read_to_string(self.paths.current_vault_file()).ok();
        let Some(name) = choose_vault(&available, recorded.as_deref()) else {
            return;
        };
        let dir = self.paths.vaults_dir().join(&name);
        match Store::open(&dir, self.store_options()) {
            Ok(store) => {
                if let Ok(al) = store.auto_lock() {
                    *self.auto_lock.lock() = al;
                }
                let encrypted = store.is_encrypted().unwrap_or(true);
                *self.store.write() = Some(store.clone());
                if !encrypted {
                    // Unencrypted vaults open with the device key; there is no lock screen for them.
                    match store.unlock_device() {
                        Ok(_) => self.after_unlock(&store),
                        Err(e) => {
                            tracing::error!(code = e.code(), "device unlock failed");
                        }
                    }
                }
            }
            Err(e) => tracing::error!(code = e.code(), "opening the vault failed"),
        }
    }

    /// Records `dir_name` as the vault to open at the next start.
    pub fn set_current_vault(&self, dir_name: &str) -> ApiResult<()> {
        emp_store::vault::write_private(&self.paths.current_vault_file(), dir_name.as_bytes())?;
        Ok(())
    }

    /// Installs a newly created store (after `vault_create`).
    pub fn install_store(&self, store: Store) -> ApiResult<()> {
        let name = store
            .paths()
            .root()
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
            .ok_or_else(|| ApiError::internal("vault dir name"))?;
        self.set_current_vault(&name)?;
        if let Ok(al) = store.auto_lock() {
            *self.auto_lock.lock() = al;
        }
        *self.store.write() = Some(store);
        Ok(())
    }

    /// The open vault (locked or unlocked), if one exists.
    #[must_use]
    pub fn store_opt(&self) -> Option<Store> {
        self.store.read().clone()
    }

    /// The open vault, or `LOCKED` when there is none yet.
    pub fn store(&self) -> ApiResult<Store> {
        self.store_opt()
            .ok_or_else(|| ApiError::new(ErrorCode::Locked, "Ultranote is not set up yet"))
    }

    /// The unlocked vault (`state.session()?` of SPEC §11.1): `LOCKED` while locked; stamps activity.
    pub fn session(&self) -> ApiResult<Store> {
        let store = self.store()?;
        if !store.is_unlocked() || self.locking.load(Ordering::SeqCst) {
            return Err(ApiError::locked());
        }
        self.activity.touch(Instant::now());
        Ok(store)
    }

    /// The unlocked vault for background work (ticker, sync, quote pushes): like [`AppState::session`] but it does
    /// **not** count as user activity, so background work never defers the idle lock.
    pub fn session_quiet(&self) -> ApiResult<Store> {
        let store = self.store()?;
        if !store.is_unlocked() || self.locking.load(Ordering::SeqCst) {
            return Err(ApiError::locked());
        }
        Ok(store)
    }

    /// `REAUTH_REQUIRED` unless `vault_reauth` succeeded in the last 5 minutes.
    pub fn require_reauth(&self) -> ApiResult<Store> {
        let store = self.session()?;
        store.require_reauth()?;
        Ok(store)
    }

    /// Serialises unlock attempts: a second concurrent `vault_unlock` gets `RATE_LIMITED`.
    pub fn begin_unlock(&self) -> ApiResult<UnlockGuard<'_>> {
        if self.unlock_busy.swap(true, Ordering::SeqCst) {
            return Err(ApiError::new(
                ErrorCode::RateLimited,
                "An unlock attempt is already in progress",
            )
            .with_retry_after(1_000));
        }
        Ok(UnlockGuard(&self.unlock_busy))
    }

    /// `vault_status`, with the app-level `keychainAvailable` flag.
    pub fn status(&self) -> ApiResult<VaultStatus> {
        let mut s = match self.store_opt() {
            Some(store) => store.status()?,
            None => Store::uninitialized_status(),
        };
        s.keychain_available = self.device_keys.keychain_available();
        Ok(s)
    }

    /// Emits `vault:status` (best effort).
    pub fn emit_status(&self) {
        if let Ok(s) = self.status() {
            self.events.emit(events::VAULT_STATUS, s);
        }
    }

    /// The cached auto-lock settings.
    #[must_use]
    pub fn auto_lock(&self) -> AutoLock {
        self.auto_lock.lock().clone()
    }

    /// Updates the cached auto-lock settings.
    pub fn set_auto_lock_cache(&self, al: AutoLock) {
        *self.auto_lock.lock() = al;
    }

    /// The device KDF calibration, if `vault_benchmark_kdf` ran.
    #[must_use]
    pub fn calibration(&self) -> Option<emp_crypto::kdf::Calibration> {
        *self.calibration.lock()
    }

    /// Stores the device KDF calibration.
    pub fn set_calibration(&self, c: emp_crypto::kdf::Calibration) {
        *self.calibration.lock() = Some(c);
    }

    /// Process uptime.
    #[must_use]
    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    /// Records `app_ready` marks (kept for diagnostics only).
    pub fn set_ready_marks(&self, marks: Value) {
        *self.ready_marks.lock() = Some(marks);
    }

    /// Post-unlock work: starts the session clock, restores the network log and preferences, applies offline mode
    /// and announces the new status.
    pub fn after_unlock(&self, store: &Store) {
        self.activity.session_started(Instant::now());
        if let Ok(al) = store.auto_lock() {
            self.set_auto_lock_cache(al);
        }
        if let Ok(Some(v)) = store.kv_get_any(NET_LOG_NS, "entries")
            && let Ok(entries) = serde_json::from_value(v)
        {
            self.net.log().restore(entries);
        }
        if let Ok(Some(Value::Array(hosts))) = store.kv_get_any(APP_NS, REMEMBERED_HOSTS_KEY) {
            self.links.set_remembered(
                hosts
                    .into_iter()
                    .filter_map(|h| h.as_str().map(str::to_owned)),
            );
        }
        if let Ok(vs) = store.vault_settings() {
            self.net.set_offline(vs.offline);
        }
        self.emit_status();
        crate::background::on_unlock(self.events.app());
    }

    /// Persists the network log ring buffer into the (encrypted) kv store.
    pub fn persist_net_log(&self, store: &Store) {
        if !store.is_unlocked() {
            return;
        }
        let entries = self.net.log().snapshot();
        if let Ok(v) = serde_json::to_value(entries) {
            let _ = store.kv_set_any(NET_LOG_NS, "entries", v, None);
        }
    }

    /// Persists the remembered external-link hosts.
    pub fn persist_remembered_hosts(&self, store: &Store) {
        let hosts = self.links.remembered();
        let _ = store.kv_set_any(APP_NS, REMEMBERED_HOSTS_KEY, serde_json::json!(hosts), None);
    }

    /// Device settings stored before a vault exists.
    #[must_use]
    pub fn pending_device_settings(&self) -> Value {
        std::fs::read(self.paths.pending_device_settings_file())
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}))
    }

    /// Applies a device-settings patch while no vault exists, validating it against [`DeviceSettings`].
    pub fn patch_pending_device_settings(&self, patch: &Value) -> ApiResult<DeviceSettings> {
        let Some(patch_obj) = patch.as_object() else {
            return Err(ApiError::invalid("patch", "must be an object"));
        };
        let template = serde_json::to_value(DeviceSettings::default())
            .map_err(|_| ApiError::internal("settings template"))?;
        for k in patch_obj.keys() {
            if template.get(k).is_none() {
                return Err(ApiError::invalid("patch", format!("unknown setting: {k}")));
            }
        }
        let mut merged = self.pending_device_settings();
        emp_store::repo::settings::json_merge(&mut merged, patch);
        let mut full = template;
        emp_store::repo::settings::json_merge(&mut full, &merged);
        let settings: DeviceSettings = serde_json::from_value(full)
            .map_err(|e| ApiError::invalid("patch", format!("invalid settings: {e}")))?;
        let bytes = serde_json::to_vec(&merged).map_err(|_| ApiError::internal("settings"))?;
        emp_store::vault::write_private(&self.paths.pending_device_settings_file(), &bytes)?;
        Ok(settings)
    }

    /// Effective device settings while no vault exists.
    #[must_use]
    pub fn pending_device_settings_resolved(&self) -> DeviceSettings {
        let mut full = serde_json::to_value(DeviceSettings::default()).unwrap_or(Value::Null);
        emp_store::repo::settings::json_merge(&mut full, &self.pending_device_settings());
        serde_json::from_value(full).unwrap_or_default()
    }

    /// Moves pre-vault device settings into `store` and deletes the file.
    pub fn migrate_pending_device_settings(&self, store: &Store) {
        let pending = self.pending_device_settings();
        if pending.as_object().is_some_and(|o| !o.is_empty())
            && let Err(e) = store.settings_set_device(&pending)
        {
            tracing::warn!(code = e.code(), "pending device settings were not applied");
        }
        let _ = std::fs::remove_file(self.paths.pending_device_settings_file());
    }

    /// The lock sequence (SPEC §9.9). Blocking: call from the blocking pool.
    ///
    /// 1. With `grace` (automatic locks) the UI receives `vault:will-lock` and gets [`WILL_LOCK_GRACE`] to flush
    ///    pending saves; data commands still work during that window.
    /// 2. The vault is marked locked: every data command now gets `LOCKED`, live quote subscriptions stop at once and
    ///    commands already running get [`IN_FLIGHT_GRACE`] to finish. Stragglers see the store session cancelled
    ///    and its keys gone when it is dropped in step 3.
    /// 3. Jobs are cancelled; in-memory secrets and caches outside the store (market API keys, Google access tokens,
    ///    staged statement imports, workbook engines, file grants, link confirmations) are dropped; the clipboard is
    ///    cleared if it still holds an EMP secret; the store session is dropped (zeroizing the keys, wiping `tmp/`).
    /// 4. `vault:locked {reason}` is emitted and the webview reloads at the lock route.
    pub fn lock_now(&self, reason: LockReason, grace: bool) -> ApiResult<()> {
        let Some(store) = self.store_opt() else {
            return Ok(());
        };
        if !store.is_unlocked() {
            return Ok(());
        }
        if self.lock_running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if grace {
            self.events
                .emit(events::VAULT_WILL_LOCK, LockPayload { reason });
            std::thread::sleep(WILL_LOCK_GRACE);
        }
        self.locking.store(true, Ordering::SeqCst);
        crate::commands::market::stop_subscriptions();
        if !wait_in_flight(IN_FLIGHT_GRACE) {
            tracing::warn!(
                commands = in_flight_others(),
                "commands still running at lock; their session is cancelled"
            );
        }
        let result = (|| {
            self.persist_net_log(&store);
            self.persist_remembered_hosts(&store);
            let cancelled = self.jobs.cancel_all();
            if cancelled > 0 {
                tracing::info!(jobs = cancelled, "jobs cancelled by lock");
            }
            self.drop_volatile_state(&store);
            self.clipboard.clear_if_ours(self.events.app());
            store.lock()?;
            self.activity.session_ended();
            Ok::<(), ApiError>(())
        })();
        self.locking.store(false, Ordering::SeqCst);
        self.lock_running.store(false, Ordering::SeqCst);
        result?;
        tracing::info!(reason = reason.as_str(), "vault locked");
        self.events
            .emit(events::VAULT_LOCKED, LockPayload { reason });
        self.emit_status();
        self.reload_webview();
        Ok(())
    }

    /// Drops every piece of decrypted or secret state held outside the store session (lock hygiene, §9.9 step 3).
    pub fn drop_volatile_state(&self, store: &Store) {
        crate::commands::market::stop_subscriptions();
        crate::commands::market::drop_router();
        crate::commands::google::drop_sessions();
        crate::commands::finance::clear_staged_imports();
        crate::commands::sheet::clear_pending_refresh();
        store.sheets_drop_cache();
        self.grants.clear();
        self.links.clear();
    }

    /// Reloads the main webview at the lock route so no decrypted data survives in the JS heap.
    pub fn reload_webview(&self) {
        let app = self.events.app().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Some(w) = app.get_webview_window(events::MAIN_WINDOW) {
                let _ = w.eval("window.location.replace('/#/lock');window.location.reload();");
            }
        });
    }

    /// One auto-lock evaluation (ticker or focus change).
    pub fn check_auto_lock(&self, is_tick: bool) {
        if PANICKED.swap(false, Ordering::SeqCst) {
            if let Err(e) = self.lock_now(LockReason::Panic, false) {
                tracing::error!(code = e.code.as_str(), "lock after panic failed");
            }
            return;
        }
        let Some(store) = self.store_opt() else {
            return;
        };
        if !store.is_unlocked() || !store.is_encrypted().unwrap_or(false) {
            return;
        }
        match self
            .activity
            .evaluate(&self.auto_lock(), Instant::now(), is_tick)
        {
            Decision::Stay => {}
            Decision::Warn(seconds_left) => self.events.emit(
                events::VAULT_AUTOLOCK_SOON,
                events::AutolockSoon { seconds_left },
            ),
            Decision::Lock(reason) => {
                if let Err(e) = self.lock_now(reason, true) {
                    tracing::error!(code = e.code.as_str(), "auto-lock failed");
                }
            }
        }
    }
}

/// Runs a blocking closure on the blocking pool, counted as an in-flight command for the lock sequence. A panic is reported as `INTERNAL` and, being outside a
/// `catch_unwind` boundary, makes the ticker lock the vault (D-15).
pub async fn blocking<T, F>(f: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> ApiResult<T> + Send + 'static,
{
    let body = move || {
        let _in_flight = InFlight::enter();
        f()
    };
    match tauri::async_runtime::spawn_blocking(body).await {
        Ok(r) => r,
        Err(_) => {
            PANICKED.store(true, Ordering::SeqCst);
            Err(ApiError::internal("command panicked"))
        }
    }
}

/// The managed state of `app`.
#[must_use]
pub fn app_state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_recorded_vault_when_present() {
        let avail = vec!["aa".to_owned(), "bb".to_owned()];
        assert_eq!(choose_vault(&avail, Some("bb")), Some("bb".into()));
        assert_eq!(choose_vault(&avail, Some("bb\n")), Some("bb".into()));
        assert_eq!(choose_vault(&avail, Some("zz")), Some("aa".into()));
        assert_eq!(choose_vault(&avail, None), Some("aa".into()));
        assert_eq!(choose_vault(&[], Some("aa")), None);
    }

    #[test]
    fn lock_waits_for_other_in_flight_commands_only() {
        // Inside a command body, the caller itself is not waited for.
        let own = InFlight::enter();
        let other = std::thread::spawn(|| {
            let _g = InFlight::enter();
            std::thread::sleep(Duration::from_millis(150));
        });
        std::thread::sleep(Duration::from_millis(20));
        let t0 = Instant::now();
        assert!(wait_in_flight(Duration::from_secs(10)));
        assert!(t0.elapsed() >= Duration::from_millis(50));
        other.join().unwrap();
        drop(own);
        assert!(!IN_COMMAND.with(Cell::get));
    }

    #[test]
    fn in_flight_wait_is_bounded() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _g = InFlight::enter();
            let _ = rx.recv();
        });
        std::thread::sleep(Duration::from_millis(20));
        let t0 = Instant::now();
        assert!(!wait_in_flight(Duration::from_millis(100)));
        assert!(t0.elapsed() >= Duration::from_millis(100));
        tx.send(()).unwrap();
        holder.join().unwrap();
    }

    #[test]
    fn vault_dir_names_are_safe() {
        assert!(is_vault_dir_name("0123abcd"));
        assert!(is_vault_dir_name("0123abcd-r1700000000000"));
        assert!(!is_vault_dir_name("../x"));
        assert!(!is_vault_dir_name("a/b"));
        assert!(!is_vault_dir_name(""));
        assert!(!is_vault_dir_name(".hidden"));
    }

    #[cfg(unix)]
    #[test]
    fn tightens_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let f = dir.path().join("device.key");
        std::fs::write(&f, b"x").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        let nested = dir.path().join("vaults/abc/assets/0a");
        std::fs::create_dir_all(&nested).unwrap();
        let blob = nested.join("blob");
        std::fs::write(&blob, b"x").unwrap();
        std::fs::set_permissions(&blob, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_private_dir(dir.path());
        assert_eq!(
            std::fs::metadata(&blob).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(dir.path().join("vaults/abc"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
