//! Vault lifecycle and the [`Store`] facade (SPEC §9.2–§9.10, §9.20, §10.1).
//!
//! A [`Store`] is one open vault directory (`vaults/<vault_id_hex>/`). It is created locked by [`Store::open`] (or
//! unlocked by [`Store::create`]); [`Store::unlock`] / [`Store::unlock_device`] / [`Store::unlock_recovery`]
//! derive the session keys, after which every repository method works. [`Store::lock`] drops the session, which
//! zeroizes the DEK-derived keys (the last `Arc<VaultKeys>` is dropped) and discards caches and the search index.
//!
//! Every repository method is an inherent method of [`Store`] implemented in `crate::repo::*`; all methods are
//! blocking and thread-safe (`Store: Clone + Send + Sync`). Call them from `spawn_blocking` in async code.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use emp_crypto::password::{lockout_until, retry_after_ms};
use emp_crypto::recovery::RecoveryWords;
use emp_crypto::{
    Dek, DeviceKey, KdfParams, Keyslot, KeyslotKind, RecoveryKey, SecretString, VaultId, VaultKeys,
};
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::codec::Codec;
use crate::db::readers::ReaderPool;
use crate::db::writer::{Durability, Writer};
use crate::db::{conn, migrate};
use crate::doc::index::LinkIndex;
use crate::manifest::{self, ManifestTracker};
use crate::model::{
    AutoLock, IntegrityReport, IntegrityState, KdfInfo, PageMeta, SecurityEvent, VaultState,
    VaultStatus,
};
use crate::search::SearchIndex;
use crate::{Progress, Result, StoreError};

/// Re-auth ("sudo mode") validity: 5 minutes.
pub const REAUTH_MS: i64 = 5 * 60 * 1000;
/// Rows re-encrypted per transaction when toggling encryption.
pub const REENCRYPT_BATCH: usize = 1000;
/// `vault_meta.format_version`.
pub const FORMAT_VERSION: &str = "1";
/// `vault_meta` key (covered by the header MAC) naming the target mode (`on` / `off`) of an encryption toggle whose
/// row and asset rewrite has not finished yet. Unlock resumes the rewrite only when this authenticated marker says
/// so; rows in the "wrong" mode without it are never converted (they did not come from EMP).
pub const ENCRYPTION_JOB_KEY: &str = "encryption_job";

// ───────────────────────────────────────────────────────────────────────────── injectable environment

/// Source of the current time (unix ms). Inject a manual clock in tests.
pub trait Clock: Send + Sync {
    /// Now, in unix milliseconds.
    fn now_ms(&self) -> i64;
}

/// The system clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        crate::db::system_now_ms()
    }
}

/// Where the device key of plaintext vaults lives (OS keychain in the app; [`FileDeviceKeyStore`] otherwise).
pub trait DeviceKeyStore: Send + Sync {
    /// Loads the device key for `vault_id`.
    fn load(&self, vault_id: &VaultId) -> Result<Option<DeviceKey>>;
    /// Stores the device key for `vault_id`.
    fn save(&self, vault_id: &VaultId, key: &DeviceKey) -> Result<()>;
    /// Deletes the device key (after encryption is turned on).
    fn delete(&self, vault_id: &VaultId) -> Result<()>;
}

/// `<data>/device.key` (mode 0600; SPEC §9.2 fallback without a keychain). Holds one 48-byte record
/// `vault_id[16] || key[32]` per plaintext vault.
#[derive(Debug, Clone)]
pub struct FileDeviceKeyStore {
    path: PathBuf,
}

impl FileDeviceKeyStore {
    /// A store at `path` (normally `<app_data_dir>/device.key`).
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn records(&self) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        match std::fs::read(&self.path) {
            Ok(b) if b.len() % 48 == 0 => Ok(zeroize::Zeroizing::new(b)),
            Ok(_) => Err(StoreError::Integrity("device.key is malformed".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(zeroize::Zeroizing::new(Vec::new()))
            }
            Err(e) => Err(e.into()),
        }
    }

    fn write_records(&self, keep: &[u8]) -> Result<()> {
        if keep.is_empty() {
            return match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.into()),
            };
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_private(&self.path, keep)
    }

    fn without(&self, vault_id: &VaultId) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        let all = self.records()?;
        let mut keep = zeroize::Zeroizing::new(Vec::with_capacity(all.len()));
        for rec in all.chunks_exact(48) {
            if rec.get(..16) != Some(&vault_id.as_bytes()[..]) {
                keep.extend_from_slice(rec);
            }
        }
        Ok(keep)
    }
}

impl DeviceKeyStore for FileDeviceKeyStore {
    fn load(&self, vault_id: &VaultId) -> Result<Option<DeviceKey>> {
        let all = self.records()?;
        for rec in all.chunks_exact(48) {
            if rec.get(..16) == Some(&vault_id.as_bytes()[..]) {
                return Ok(Some(DeviceKey::from_bytes(&rec[16..])?));
            }
        }
        Ok(None)
    }

    fn save(&self, vault_id: &VaultId, key: &DeviceKey) -> Result<()> {
        let mut keep = self.without(vault_id)?;
        keep.extend_from_slice(vault_id.as_bytes());
        keep.extend_from_slice(key.expose_secret());
        self.write_records(&keep)
    }

    fn delete(&self, vault_id: &VaultId) -> Result<()> {
        let keep = self.without(vault_id)?;
        self.write_records(&keep)
    }
}

/// Atomically replaces `path` with `bytes`, readable only by the owner (0600 on Unix).
///
/// The bytes go to a fresh temporary file beside `path` (created 0600, fsynced) which is then renamed over it, and
/// the directory is fsynced. A crash or a full disk therefore leaves either the old or the new contents, never a
/// truncated file — important for `device.key`, which holds the device key of every plaintext vault.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| StoreError::invalid("write_private needs a file path"))?;
    let mut nonce = [0u8; 8];
    getrandom::getrandom(&mut nonce)
        .map_err(|_| StoreError::Internal("the OS random number generator failed".into()))?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.tmp", hex::encode(nonce)));
    let tmp = dir.join(tmp_name);
    let result = (|| -> Result<()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Creates (or truncates) a file readable only by the owner (0600 on Unix, also when it already existed).
pub fn create_private_file(path: &Path) -> Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let f = opts.open(path)?;
    restrict_file(path)?;
    Ok(f)
}

/// Sets an existing file to owner-only access (0600 on Unix; a no-op elsewhere and for missing files).
pub fn restrict_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// `vault.db` and its `-wal` / `-shm` companions, created owner-only (SQLite gives its companion files the
/// database file's mode, so creating `vault.db` with 0600 before SQLite opens it covers all three).
fn prepare_db_file(db: &Path) -> Result<()> {
    if !db.exists() {
        drop(create_private_file(db)?);
    }
    restrict_file(db)?;
    let name = db
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("vault.db");
    for suffix in ["-wal", "-shm", "-journal"] {
        restrict_file(&db.with_file_name(format!("{name}{suffix}")))?;
    }
    Ok(())
}

/// Creates a directory readable only by the owner (0700 on Unix).
pub fn create_private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Events the store emits; the app forwards them to the webview (SPEC §11.4).
#[derive(Clone, Debug)]
pub enum StoreEvent {
    /// `search:ready`.
    SearchReady {
        /// Indexed documents.
        docs: usize,
    },
    /// `integrity:warning`.
    IntegrityWarning {
        /// Damaged records.
        damaged: usize,
        /// Root / MAC mismatch.
        mset_mismatch: bool,
    },
    /// `tree:changed`.
    TreeChanged {
        /// Workspace.
        workspace_id: String,
        /// Created / changed pages.
        upserted: Vec<PageMeta>,
        /// Removed (trashed or purged) page ids.
        removed: Vec<String>,
    },
    /// `page:changed`.
    PageChanged {
        /// Page id.
        id: String,
        /// New meta rev.
        meta_rev: Option<i64>,
        /// New doc rev.
        doc_rev: Option<i64>,
    },
    /// `vault:status` should be re-sent (after toggles and migrations).
    StatusChanged,
    /// `db:changed`: a database's rows (`data_rev`) or schema / views (`schema_rev`) changed. Emitted after every
    /// committed database write, in addition to the `PageChanged` for the database page.
    DbChanged {
        /// Database (page) id.
        database_id: String,
        /// Data revision after the change.
        data_rev: i64,
        /// Schema revision after the change.
        schema_rev: i64,
        /// The rows whose values changed, when the change was limited to them (`None`: re-query everything).
        row_ids: Option<Vec<String>>,
    },
}

/// Receives [`StoreEvent`]s. Implementations must be cheap and must not call back into the store synchronously.
pub trait EventSink: Send + Sync {
    /// Called for every event.
    fn emit(&self, event: StoreEvent);
}

/// Discards events.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoEvents;

impl EventSink for NoEvents {
    fn emit(&self, _event: StoreEvent) {}
}

/// Options shared by every open vault.
#[derive(Clone)]
pub struct StoreOptions {
    /// Time source.
    pub clock: Arc<dyn Clock>,
    /// Device-key storage for plaintext vaults.
    pub device_keys: Arc<dyn DeviceKeyStore>,
    /// Event sink.
    pub events: Arc<dyn EventSink>,
    /// Prefix of asset URLs (`emp-asset://localhost/` on macOS/Linux, `http://emp-asset.localhost/` on Windows).
    pub asset_url_base: String,
    /// Reader connections (default 4).
    pub readers: usize,
    /// App version recorded in snapshots.
    pub app_version: String,
    /// Build the search index and run the integrity check on a background thread after unlock (default `true`).
    /// When `false` they run synchronously inside the unlock call.
    pub background_indexing: bool,
    /// [`Store::create`] also writes the starter tour (SPEC §6.2 "Getting Started" and its guide pages, pinned to
    /// favorites) into the first workspace (default `false`; the app turns it on for `vault_create`).
    pub starter_tour: bool,
}

impl StoreOptions {
    /// Defaults with a file device-key store at `device_key_path`.
    #[must_use]
    pub fn new(device_key_path: impl Into<PathBuf>) -> Self {
        Self {
            clock: Arc::new(SystemClock),
            device_keys: Arc::new(FileDeviceKeyStore::new(device_key_path)),
            events: Arc::new(NoEvents),
            asset_url_base: "emp-asset://localhost/".into(),
            readers: crate::db::readers::READERS,
            app_version: env!("CARGO_PKG_VERSION").into(),
            background_indexing: true,
            starter_tour: false,
        }
    }
}

impl std::fmt::Debug for StoreOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreOptions")
            .field("asset_url_base", &self.asset_url_base)
            .field("readers", &self.readers)
            .finish_non_exhaustive()
    }
}

/// Paths inside one vault directory (SPEC §10.1).
#[derive(Clone, Debug)]
pub struct VaultPaths {
    root: PathBuf,
}

impl VaultPaths {
    /// Wraps a vault directory.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `vaults/<hex>` under an app data directory.
    #[must_use]
    pub fn in_data_dir(data_dir: &Path, vault_id: &VaultId) -> Self {
        Self::new(data_dir.join("vaults").join(vault_id.to_hex()))
    }

    /// The vault directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// `vault.db`.
    #[must_use]
    pub fn db(&self) -> PathBuf {
        self.root.join("vault.db")
    }
    /// `assets/`.
    #[must_use]
    pub fn assets(&self) -> PathBuf {
        self.root.join("assets")
    }
    /// `snapshots/`.
    #[must_use]
    pub fn snapshots(&self) -> PathBuf {
        self.root.join("snapshots")
    }
    /// `backups/` (pre-migration copies).
    #[must_use]
    pub fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }
    /// `tmp/` (wiped on lock, quit and start).
    #[must_use]
    pub fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// Deletes everything in `tmp/`.
    pub fn wipe_tmp(&self) -> Result<()> {
        let tmp = self.tmp();
        if tmp.exists() {
            for e in std::fs::read_dir(&tmp)? {
                let p = e?.path();
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(&p);
                } else {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
        Ok(())
    }
}

/// Options for [`Store::create`].
pub struct CreateOptions {
    /// Vault password; `None` creates an unencrypted vault (DEK wrapped by the device key).
    pub password: Option<SecretString>,
    /// Argon2id parameters for the password keyslot (calibrate with `emp_crypto::kdf::calibrate`).
    pub kdf: KdfParams,
    /// Auto-lock settings.
    pub auto_lock: AutoLock,
    /// Name of the first workspace (`None`: create none).
    pub workspace_name: Option<String>,
}

/// Result of [`Store::create`].
pub struct Created {
    /// The open, unlocked store.
    pub store: Store,
    /// Recovery words (encrypted vaults only). Show once; also retrievable via `recovery_view` until confirmed.
    pub recovery_words: Option<RecoveryWords>,
}

/// Progress reporter that ignores everything.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoProgress;

impl Progress for NoProgress {
    fn progress(&self, _done: u64, _total: u64, _label: &str) {}
}

// ───────────────────────────────────────────────────────────────────────────── session

/// Index readiness bookkeeping.
#[derive(Debug, Default)]
pub(crate) struct IndexState {
    pub ready: bool,
    pub building: bool,
    pub progress: f64,
    /// Pages saved while the index was building (re-indexed when the build finishes).
    pub dirty: HashSet<String>,
}

/// Per-page edit accounting for automatic versions (§7.8).
#[derive(Debug, Default, Clone)]
pub(crate) struct EditStats {
    pub changed_chars: usize,
}

/// The unlocked state. Dropping the last reference zeroizes the session keys.
pub(crate) struct Session {
    /// The DEK itself (needed to write new keyslots without re-entering credentials). Zeroized on drop.
    pub dek: Dek,
    pub codec: Codec,
    pub search: RwLock<SearchIndex>,
    pub links: RwLock<LinkIndex>,
    pub index_state: Mutex<IndexState>,
    pub integrity: Mutex<IntegrityState>,
    pub reauth_until: Mutex<Option<i64>>,
    pub cancel: Arc<AtomicBool>,
    pub edits: Mutex<std::collections::HashMap<String, EditStats>>,
    /// Cached reverse relation graph (target database → databases relating to it), keyed by
    /// `(sum(schema_rev), count(databases))`; see `Store::db_changes`.
    pub db_dependents: Mutex<Option<DbDependents>>,
}

/// Cache key and reverse relation graph of [`Session::db_dependents`].
pub(crate) type DbDependents = (
    (i64, i64),
    Arc<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>>,
);

impl Session {
    fn new(dek: Dek, keys: Arc<VaultKeys>, encrypted: bool) -> Self {
        Self {
            dek,
            codec: Codec::new(keys, encrypted),
            search: RwLock::new(SearchIndex::default()),
            links: RwLock::new(LinkIndex::default()),
            index_state: Mutex::new(IndexState::default()),
            integrity: Mutex::new(IntegrityState::Unchecked),
            reauth_until: Mutex::new(None),
            cancel: Arc::new(AtomicBool::new(false)),
            edits: Mutex::new(std::collections::HashMap::new()),
            db_dependents: Mutex::new(None),
        }
    }

    pub fn keys(&self) -> &VaultKeys {
        self.codec.keys()
    }
}

pub(crate) struct Inner {
    pub paths: VaultPaths,
    pub opts: StoreOptions,
    pub writer: Writer,
    pub readers: ReaderPool,
    pub session: RwLock<Option<Arc<Session>>>,
    pub vault_id: VaultId,
    /// Serialises unlock / lock / key-management operations.
    pub keyops: Mutex<()>,
    pub background: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

/// One open vault. Cheap to clone; all methods are thread-safe.
#[derive(Clone)]
pub struct Store {
    pub(crate) inner: Arc<Inner>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("vault", &self.inner.vault_id)
            .field("unlocked", &self.inner.session.read().is_some())
            .finish()
    }
}

// ───────────────────────────────────────────────────────────────────────────── vault_meta helpers

pub(crate) fn meta_get(conn: &Connection, key: &str) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .prepare_cached("SELECT value FROM vault_meta WHERE key = ?1")?
        .query_row([key], |r| r.get(0))
        .optional()?)
}

pub(crate) fn meta_get_str(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(meta_get(conn, key)?.map(|b| String::from_utf8_lossy(&b).into_owned()))
}

pub(crate) fn meta_get_i64(conn: &Connection, key: &str) -> Result<i64> {
    Ok(meta_get_str(conn, key)?
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0))
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &[u8]) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO vault_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )?
    .execute(params![key, value])?;
    Ok(())
}

fn insert_keyslot(tx: &Connection, slot: &Keyslot) -> Result<()> {
    let c = slot.to_columns();
    tx.prepare_cached(
        "INSERT INTO keyslots (slot_id, kind, kdf, kdf_params, salt, nonce, wrapped_dek, key_epoch, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute(params![
        c.slot_id,
        c.kind,
        c.kdf,
        c.kdf_params,
        c.salt,
        c.nonce,
        c.wrapped_dek,
        c.key_epoch,
        c.created_at
    ])?;
    Ok(())
}

fn next_slot_id(slots: &[Keyslot]) -> u32 {
    slots.iter().map(Keyslot::slot_id).max().unwrap_or(0) + 1
}

fn find_slot(slots: &[Keyslot], kind: KeyslotKind) -> Option<&Keyslot> {
    slots.iter().find(|s| s.kind() == kind)
}

pub(crate) fn log_event(conn: &Connection, at: i64, event: SecurityEvent) -> Result<()> {
    conn.prepare_cached("INSERT INTO security_log (at, event) VALUES (?1, ?2)")?
        .execute(params![at, event.as_str()])?;
    Ok(())
}

fn created_day(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// Rough unlock-time estimate for `VaultStatus.kdf.estMs` (Standard ≈ 800 ms on reference hardware).
fn estimate_ms(p: &KdfParams) -> u64 {
    let work = u64::from(p.m_kib) * u64::from(p.t);
    work * 800 / (262_144 * 3)
}

// ───────────────────────────────────────────────────────────────────────────── lifecycle

impl Store {
    /// `true` if `vault_dir` holds a vault database.
    #[must_use]
    pub fn exists(vault_dir: &Path) -> bool {
        VaultPaths::new(vault_dir).db().is_file()
    }

    /// The vault ids (hex) under `<data_dir>/vaults/`.
    pub fn list_vaults(data_dir: &Path) -> Result<Vec<String>> {
        let dir = data_dir.join("vaults");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir)? {
            let p = e?.path();
            if Self::exists(&p) {
                if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
                    out.push(n.to_owned());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// The status reported before any vault exists.
    #[must_use]
    pub fn uninitialized_status() -> VaultStatus {
        VaultStatus {
            state: VaultState::Uninitialized,
            encrypted: false,
            vault_id: None,
            kdf: None,
            recovery_confirmed: false,
            auto_lock: AutoLock::default(),
            failed_attempts: 0,
            retry_after_ms: 0,
            schema_version: migrate::LATEST_VERSION,
            pending_migrations: 0,
            keychain_available: false,
            integrity: IntegrityState::Unchecked,
            reauth_valid_until: None,
        }
    }

    /// Creates a new vault in `<data_dir>/vaults/<new id>/` and returns it unlocked.
    pub fn create(data_dir: &Path, create: CreateOptions, opts: StoreOptions) -> Result<Created> {
        let vault_id = VaultId::generate()?;
        create_private_dir(&data_dir.join("vaults"))?;
        let paths = VaultPaths::in_data_dir(data_dir, &vault_id);
        Self::create_with_id(paths, vault_id, create, opts)
    }

    /// Creates a new vault in an explicit directory (which must not hold a vault yet).
    pub fn create_at(
        vault_dir: &Path,
        create: CreateOptions,
        opts: StoreOptions,
    ) -> Result<Created> {
        Self::create_with_id(
            VaultPaths::new(vault_dir),
            VaultId::generate()?,
            create,
            opts,
        )
    }

    fn create_with_id(
        paths: VaultPaths,
        vault_id: VaultId,
        create: CreateOptions,
        opts: StoreOptions,
    ) -> Result<Created> {
        if paths.db().exists() {
            return Err(StoreError::invalid(
                "a vault already exists in this directory",
            ));
        }
        create.auto_lock.validate()?;
        create_private_dir(paths.root())?;
        let now = opts.clock.now_ms();
        let dek = Dek::generate(1)?;
        let mut slots = Vec::new();
        let mut words = None;
        let mut recovery_key = None;
        let encrypted = create.password.is_some();
        if let Some(pw) = &create.password {
            slots.push(Keyslot::wrap_password(
                &vault_id,
                1,
                &dek,
                pw,
                &create.kdf,
                now,
            )?);
            let rk = RecoveryKey::generate()?;
            slots.push(Keyslot::wrap_recovery(&vault_id, 2, &dek, &rk, now)?);
            words = Some(rk.words()?);
            recovery_key = Some(rk);
        } else {
            let dk = DeviceKey::generate()?;
            opts.device_keys.save(&vault_id, &dk)?;
            slots.push(Keyslot::wrap_device(&vault_id, 1, &dek, &dk, now)?);
        }
        drop(recovery_key);
        let keys = Arc::new(VaultKeys::derive(&dek, &vault_id)?);

        let store = Self::open_paths(paths, opts, Some(vault_id))?;
        {
            let keys = Arc::clone(&keys);
            let auto_lock = serde_json::to_vec(&create.auto_lock)?;
            store
                .inner
                .writer
                .tracker()
                .set_keys(Some(Arc::clone(&keys)));
            store.inner.writer.txn(Durability::Full, move |tx| {
                meta_set(tx, "format_version", FORMAT_VERSION.as_bytes())?;
                meta_set(tx, "vault_id", vault_id.as_bytes())?;
                meta_set(tx, "encryption", if encrypted { b"on" } else { b"off" })?;
                meta_set(tx, "created_day", created_day(now).as_bytes())?;
                meta_set(tx, "failed_unlocks", b"0")?;
                meta_set(tx, "lockout_until", b"0")?;
                meta_set(tx, "app_min_version", env!("CARGO_PKG_VERSION").as_bytes())?;
                meta_set(tx, "pending_payload_migrations", b"[]")?;
                meta_set(tx, "recovery_confirmed", b"0")?;
                for s in &slots {
                    insert_keyslot(tx, s)?;
                }
                manifest::reseal(tx, &keys)?;
                manifest::write_header_mac(tx, &keys)?;
                crate::repo::settings::put_device_raw(tx, "autolock", &auto_lock, now)?;
                Ok(())
            })?;
        }
        let session = store.start_session(dek, keys, encrypted)?;
        if let Some(w) = &words {
            crate::repo::kv::put_internal(&store, &session, RECOVERY_NS, RECOVERY_KEY, &**w)?;
        }
        if let Some(name) = create.workspace_name {
            let ws = store.workspace_create(&name, None)?;
            if store.inner.opts.starter_tour {
                store.starter_tour_create(&ws.id)?;
            }
        }
        store.finish_unlock(&session)?;
        Ok(Created {
            store,
            recovery_words: words,
        })
    }

    /// Opens an existing vault directory (locked). Runs structural migrations (with a pre-migration copy).
    pub fn open(vault_dir: &Path, opts: StoreOptions) -> Result<Self> {
        let paths = VaultPaths::new(vault_dir);
        if !paths.db().is_file() {
            return Err(StoreError::NotFound("vault"));
        }
        Self::open_paths(paths, opts, None)
    }

    fn open_paths(paths: VaultPaths, opts: StoreOptions, new_id: Option<VaultId>) -> Result<Self> {
        create_private_dir(paths.root())?;
        create_private_dir(&paths.tmp())?;
        create_private_dir(&paths.assets())?;
        paths.wipe_tmp()?;
        prepare_db_file(&paths.db())?;
        let mut rw = conn::open_rw(&paths.db())?;
        migrate::migrate(&mut rw, Some(&paths.backups()), opts.clock.now_ms())?;
        // Before anything writes: a trigger or view planted in the file would run on this connection, and EMP's
        // manifest triggers would then re-seal whatever it changed.
        migrate::verify_schema(&rw)?;
        conn::configure_rw(&rw)?;
        let vault_id = match new_id {
            Some(id) => id,
            None => {
                let raw = meta_get(&rw, "vault_id")?.ok_or(StoreError::NotFound("vault id"))?;
                VaultId::from_slice(&raw)?
            }
        };
        let tracker = ManifestTracker::new();
        let writer = Writer::spawn(rw, tracker)?;
        let readers = ReaderPool::open(&paths.db(), opts.readers)?;
        Ok(Self {
            inner: Arc::new(Inner {
                paths,
                opts,
                writer,
                readers,
                session: RwLock::new(None),
                vault_id,
                keyops: Mutex::new(()),
                background: Mutex::new(Vec::new()),
            }),
        })
    }

    /// The vault id.
    #[must_use]
    pub fn vault_id(&self) -> VaultId {
        self.inner.vault_id
    }

    /// The vault's paths.
    #[must_use]
    pub fn paths(&self) -> &VaultPaths {
        &self.inner.paths
    }

    /// Current time from the injected clock.
    #[must_use]
    pub fn now(&self) -> i64 {
        self.inner.opts.clock.now_ms()
    }

    pub(crate) fn emit(&self, e: StoreEvent) {
        self.inner.opts.events.emit(e);
    }

    /// The unlocked session or `LOCKED`.
    pub(crate) fn session(&self) -> Result<Arc<Session>> {
        self.inner.session.read().clone().ok_or(StoreError::Locked)
    }

    /// `true` while unlocked.
    #[must_use]
    pub fn is_unlocked(&self) -> bool {
        self.inner.session.read().is_some()
    }

    /// Runs `f` on a reader connection.
    pub(crate) fn read<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        self.inner.readers.with(f)
    }

    /// Runs `f` in a write transaction (requires an unlocked session for encrypted rows).
    pub(crate) fn write<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<R> + Send + 'static,
    {
        self.inner.writer.txn(Durability::Normal, f)
    }

    pub(crate) fn write_full<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<R> + Send + 'static,
    {
        self.inner.writer.txn(Durability::Full, f)
    }

    /// Whether vault encryption is on (from `vault_meta`).
    pub fn is_encrypted(&self) -> Result<bool> {
        self.read(|c| Ok(meta_get_str(c, "encryption")?.as_deref() == Some("on")))
    }

    // ── status

    /// `vault_status`.
    pub fn status(&self) -> Result<VaultStatus> {
        let now = self.now();
        let session = self.inner.session.read().clone();
        let (encrypted, failed, lockout, confirmed, pending, slots, schema) = self.read(|c| {
            Ok((
                meta_get_str(c, "encryption")?.as_deref() == Some("on"),
                meta_get_i64(c, "failed_unlocks")?,
                meta_get_i64(c, "lockout_until")?,
                meta_get_i64(c, "recovery_confirmed")? == 1,
                meta_get_str(c, "pending_payload_migrations")?
                    .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
                    .map_or(0, |v| v.len()),
                manifest::read_keyslots(c)?,
                migrate::user_version(c)?,
            ))
        })?;
        let kdf = find_slot(&slots, KeyslotKind::Password)
            .and_then(Keyslot::kdf_params)
            .map(|p| KdfInfo {
                m_kib: p.m_kib,
                t: p.t,
                p: p.p,
                est_ms: estimate_ms(&p),
                below_standard: p.is_weaker_than(&KdfParams::STANDARD),
            });
        let auto_lock = self.auto_lock()?;
        Ok(VaultStatus {
            state: if session.is_some() {
                VaultState::Unlocked
            } else {
                VaultState::Locked
            },
            // While unlocked, the mode proven by the keyslot (the `vault_meta` flag is only a hint before that).
            encrypted: session.as_ref().map_or(encrypted, |s| s.codec.encrypting()),
            vault_id: Some(self.inner.vault_id.to_hex()),
            kdf,
            recovery_confirmed: confirmed,
            auto_lock,
            failed_attempts: u32::try_from(failed.max(0)).unwrap_or(u32::MAX),
            retry_after_ms: retry_after_ms(now, lockout),
            schema_version: schema,
            pending_migrations: u32::try_from(pending).unwrap_or(u32::MAX),
            keychain_available: false,
            integrity: session
                .as_ref()
                .map_or(IntegrityState::Unchecked, |s| *s.integrity.lock()),
            reauth_valid_until: session
                .as_ref()
                .and_then(|s| *s.reauth_until.lock())
                .filter(|t| *t > now),
        })
    }

    /// The stored auto-lock settings.
    pub fn auto_lock(&self) -> Result<AutoLock> {
        Ok(self
            .read(|c| crate::repo::settings::get_device_raw(c, "autolock"))?
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default())
    }

    /// `vault_set_auto_lock`. Setting `idleMinutes: null` ("Never") requires re-auth.
    pub fn set_auto_lock(&self, auto_lock: AutoLock) -> Result<VaultStatus> {
        auto_lock.validate()?;
        if auto_lock.idle_minutes.is_none() {
            self.require_reauth()?;
        } else {
            self.session()?;
        }
        let bytes = serde_json::to_vec(&auto_lock)?;
        let now = self.now();
        self.write(move |tx| crate::repo::settings::put_device_raw(tx, "autolock", &bytes, now))?;
        self.status()
    }

    // ── unlock

    fn check_backoff(&self) -> Result<()> {
        let now = self.now();
        let lockout = self.read(|c| meta_get_i64(c, "lockout_until"))?;
        let max = i64::try_from(emp_crypto::password::BACKOFF_MAX.as_millis()).unwrap_or(i64::MAX);
        if lockout.saturating_sub(now) > max {
            // Never set this far ahead by EMP: the wall clock moved back or `vault_meta` was edited. Re-anchor the
            // lockout to the policy maximum from now, so the vault does not stay locked for days (and the
            // remaining wait reported by `retry_after_ms` is honest).
            let until = now.saturating_add(max);
            self.inner.writer.txn(Durability::Full, move |tx| {
                meta_set(tx, "lockout_until", until.to_string().as_bytes())
            })?;
        }
        let lockout = lockout.min(now.saturating_add(max));
        let wait = retry_after_ms(now, lockout);
        if wait > 0 {
            return Err(StoreError::RateLimited {
                retry_after_ms: wait,
            });
        }
        Ok(())
    }

    fn record_failure(&self) -> Result<StoreError> {
        let now = self.now();
        let retry = self.inner.writer.txn(Durability::Full, move |tx| {
            let failures = meta_get_i64(tx, "failed_unlocks")?.saturating_add(1);
            let until = lockout_until(now, u32::try_from(failures).unwrap_or(u32::MAX));
            meta_set(tx, "failed_unlocks", failures.to_string().as_bytes())?;
            meta_set(tx, "lockout_until", until.to_string().as_bytes())?;
            log_event(tx, now, SecurityEvent::UnlockFail)?;
            Ok(retry_after_ms(now, until))
        })?;
        Ok(StoreError::BadPassword {
            retry_after_ms: (retry > 0).then_some(retry),
        })
    }

    fn slots(&self) -> Result<Vec<Keyslot>> {
        self.read(manifest::read_keyslots)
    }

    /// `vault_unlock`: unlocks an encrypted vault with its password. Enforces the §9.10 backoff
    /// (`RATE_LIMITED {retryAfterMs}` while it is active). Slow (Argon2id).
    pub fn unlock(&self, password: &SecretString) -> Result<VaultStatus> {
        let _g = self.inner.keyops.lock();
        if self.is_unlocked() {
            return self.status();
        }
        self.check_backoff()?;
        let slots = self.slots()?;
        let slot = find_slot(&slots, KeyslotKind::Password)
            .ok_or(StoreError::Unsupported("this vault has no password"))?;
        let dek = match slot.unwrap_password(&self.inner.vault_id, password) {
            Ok(d) => d,
            Err(emp_crypto::CryptoError::BadPassword) => return Err(self.record_failure()?),
            Err(e) => return Err(e.into()),
        };
        // A password slot only exists in encrypted vaults (it is added and the device slot removed in the same
        // transaction), so the slot that just authenticated decides the mode — never the unauthenticated
        // `vault_meta.encryption` flag.
        self.complete_unlock(dek, SecurityEvent::UnlockOk, true)
    }

    /// Unlocks an unencrypted vault with the device key.
    pub fn unlock_device(&self) -> Result<VaultStatus> {
        let _g = self.inner.keyops.lock();
        if self.is_unlocked() {
            return self.status();
        }
        let slots = self.slots()?;
        let slot = find_slot(&slots, KeyslotKind::Device).ok_or(StoreError::Unsupported(
            "this vault is encrypted; use the password",
        ))?;
        let dk = self
            .inner
            .opts
            .device_keys
            .load(&self.inner.vault_id)?
            .ok_or(StoreError::NotFound("device key"))?;
        let dek = slot.unwrap_device(&self.inner.vault_id, &dk)?;
        self.complete_unlock(dek, SecurityEvent::UnlockOk, false)
    }

    /// `vault_unlock_recovery`: unlocks with the 24 recovery words and sets a new password.
    pub fn unlock_recovery(
        &self,
        words: &[String],
        new_password: &SecretString,
        kdf: KdfParams,
    ) -> Result<VaultStatus> {
        let _g = self.inner.keyops.lock();
        self.check_backoff()?;
        let rk = RecoveryKey::from_words(words)?;
        let slots = self.slots()?;
        let slot = find_slot(&slots, KeyslotKind::Recovery)
            .ok_or(StoreError::Unsupported("this vault has no recovery key"))?;
        let dek = match slot.unwrap_recovery(&self.inner.vault_id, &rk) {
            Ok(d) => d,
            Err(emp_crypto::CryptoError::BadPassword) => return Err(self.record_failure()?),
            Err(e) => return Err(e.into()),
        };
        let now = self.now();
        let vid = self.inner.vault_id;
        let new_slot =
            Keyslot::wrap_password(&vid, next_slot_id(&slots), &dek, new_password, &kdf, now)?;
        if self.is_unlocked() {
            drop(dek);
        } else {
            self.complete_unlock(dek, SecurityEvent::RecoveryUnlock, true)?;
        }
        self.write_full(move |tx| {
            tx.execute("DELETE FROM keyslots WHERE kind = 'password'", [])?;
            insert_keyslot(tx, &new_slot)?;
            log_event(tx, now, SecurityEvent::PwChange)?;
            Ok(())
        })?;
        self.reseal_state()?;
        self.status()
    }

    /// `encrypted` is the mode proven by the keyslot that unlocked (password / recovery ⇒ encrypted, device ⇒ not).
    fn complete_unlock(
        &self,
        dek: Dek,
        event: SecurityEvent,
        encrypted: bool,
    ) -> Result<VaultStatus> {
        let keys = Arc::new(VaultKeys::derive(&dek, &self.inner.vault_id)?);
        self.inner
            .writer
            .tracker()
            .set_keys(Some(Arc::clone(&keys)));
        let now = self.now();
        self.inner.writer.txn(Durability::Full, move |tx| {
            meta_set(tx, "failed_unlocks", b"0")?;
            meta_set(tx, "lockout_until", b"0")?;
            log_event(tx, now, event)?;
            Ok(())
        })?;
        let session = self.start_session(dek, keys, encrypted)?;
        self.finish_unlock(&session)?;
        self.status()
    }

    fn start_session(
        &self,
        dek: Dek,
        keys: Arc<VaultKeys>,
        encrypted: bool,
    ) -> Result<Arc<Session>> {
        let session = Arc::new(Session::new(dek, keys, encrypted));
        *self.inner.session.write() = Some(Arc::clone(&session));
        Ok(session)
    }

    /// Post-unlock work: header MAC, resuming an interrupted encryption toggle, integrity check and index build.
    fn finish_unlock(&self, session: &Arc<Session>) -> Result<()> {
        let mode = session.codec.encrypting();
        let (header_ok, meta_on, job) = self.read(|c| {
            Ok((
                manifest::verify_header_mac(c, session.keys())?,
                meta_get_str(c, "encryption")?.as_deref() == Some("on"),
                meta_get_str(c, ENCRYPTION_JOB_KEY)?,
            ))
        })?;
        // The header MAC covers `encryption` and `encryption_job`; the mode itself is proven by the keyslot. A
        // mismatch means `vault_meta` was edited outside EMP: warn, and never act on the edited values.
        let trusted = header_ok && meta_on == mode;
        if !trusted {
            *session.integrity.lock() = IntegrityState::Warning;
        }
        // Resume an interrupted encryption toggle — only when the authenticated job marker asks for exactly this
        // mode. Rows in the other mode without it were planted (or rolled back) outside EMP: they are not converted
        // (that would launder them into authenticated records) and, in an encrypted vault, read as damaged.
        let job_target = match job.as_deref() {
            Some("on") => Some(true),
            Some("off") => Some(false),
            _ => None,
        };
        if trusted && job_target == Some(mode) {
            self.resume_encryption_job(session, mode, &NoProgress)?;
        }
        // Deferred payload migrations (§10.3). A failure leaves them pending (reads keep upcasting lazily) rather
        // than making the vault impossible to unlock; the next unlock retries.
        if !self.read(crate::db::payload_migrate::pending)?.is_empty() {
            let _ = self.payload_migrations_run(&NoProgress);
        }
        if self.inner.opts.background_indexing {
            let me = self.clone();
            let s = Arc::clone(session);
            let h = std::thread::Builder::new()
                .name("emp-store-unlock".into())
                .spawn(move || me.post_unlock_jobs(&s))?;
            let mut bg = self.inner.background.lock();
            bg.retain(|h| !h.is_finished());
            bg.push(h);
        } else {
            self.post_unlock_jobs(session);
        }
        Ok(())
    }

    /// Converts every row and asset to `target` and then clears the job marker (encryption toggles and their
    /// resumption at unlock).
    fn resume_encryption_job(
        &self,
        session: &Arc<Session>,
        target: bool,
        progress: &dyn Progress,
    ) -> Result<()> {
        // Rows that are still plaintext are EMP's own (the job marker is authenticated) until the rewrite finishes.
        session.codec.set_accept_plaintext(true);
        self.reencrypt_all(target, progress)?;
        if target {
            self.inner.opts.device_keys.delete(&self.inner.vault_id)?;
        }
        let keys = session.codec.keys_arc();
        self.write_full(move |tx| {
            tx.execute(
                "DELETE FROM vault_meta WHERE key = ?1",
                [ENCRYPTION_JOB_KEY],
            )?;
            manifest::write_header_mac(tx, &keys)
        })?;
        session.codec.set_accept_plaintext(!target);
        Ok(())
    }

    fn post_unlock_jobs(&self, session: &Arc<Session>) {
        let me = self.clone();
        let s = Arc::clone(session);
        let integrity = std::thread::Builder::new()
            .name("emp-store-integrity".into())
            .spawn(move || me.background_integrity(&s));
        let _ = self.build_indexes(session);
        if let Ok(h) = integrity {
            let _ = h.join();
        }
        if !session.cancel.load(Ordering::SeqCst) {
            let _ = self.run_maintenance();
        }
    }

    fn background_integrity(&self, session: &Arc<Session>) {
        let encrypted = session.codec.encrypting();
        let result = if encrypted {
            let manifest_ok = self
                .inner
                .readers
                .snapshot(|c| manifest::verify(c, session.keys()))
                .map(|m| m.ok());
            // Plaintext rows in an encrypted vault (outside an authenticated encryption-on job) were not written by
            // EMP; the manifest only covers sealed rows, so count them separately.
            let planted = if session.codec.accepts_plaintext() {
                Ok(0)
            } else {
                self.rows_pending_reencryption(true)
            };
            match (manifest_ok, planted) {
                (Ok(ok), Ok(n)) => Ok(ok && n == 0),
                (Err(e), _) | (_, Err(e)) => Err(e),
            }
        } else {
            self.read(conn::quick_check)
        };
        let ok = matches!(result, Ok(true));
        let mut st = session.integrity.lock();
        if *st == IntegrityState::Unchecked {
            *st = if ok {
                IntegrityState::Ok
            } else {
                IntegrityState::Warning
            };
        }
        let warn = *st == IntegrityState::Warning;
        drop(st);
        if warn && !session.cancel.load(Ordering::SeqCst) {
            let now = self.now();
            let _ = self.write(move |tx| log_event(tx, now, SecurityEvent::IntegrityFail));
            self.emit(StoreEvent::IntegrityWarning {
                damaged: 0,
                mset_mismatch: true,
            });
        }
    }

    /// Waits for the background unlock jobs (integrity check, index build, maintenance) to finish.
    pub fn wait_background(&self) {
        let handles: Vec<_> = std::mem::take(&mut *self.inner.background.lock());
        for h in handles {
            let _ = h.join();
        }
    }

    /// Idle maintenance: purges expired trash and kv entries and thins versions (D-24). Safe to call any time while
    /// unlocked; also run automatically after unlock.
    pub fn run_maintenance(&self) -> Result<()> {
        self.session()?;
        self.trash_purge_expired()?;
        self.kv_purge_expired()?;
        self.versions_thin_all()?;
        self.inner.writer.run(|c| {
            c.execute_batch("PRAGMA incremental_vacuum(2000)")?;
            Ok(())
        })?;
        Ok(())
    }

    /// `vault_lock`: drops the session (zeroizing keys), wipes `tmp/` and logs the event.
    pub fn lock(&self) -> Result<()> {
        if self.is_unlocked() {
            // Getting Started "Lock with ⌘⇧L": the last write before the keys go.
            self.tour_tick_quiet("lock");
        }
        let _g = self.inner.keyops.lock();
        let session = self.inner.session.write().take();
        let Some(session) = session else {
            return Ok(());
        };
        session.cancel.store(true, Ordering::SeqCst);
        let now = self.now();
        let _ = self.write(move |tx| log_event(tx, now, SecurityEvent::Lock));
        self.inner.writer.tracker().set_keys(None);
        drop(session);
        self.inner.paths.wipe_tmp()?;
        Ok(())
    }

    /// Locks and stops the writer. Further calls fail.
    pub fn close(&self) -> Result<()> {
        self.lock()?;
        self.wait_background();
        self.inner.writer.shutdown();
        Ok(())
    }

    // ── re-auth

    /// `vault_reauth`: verifies the password and opens a 5-minute sudo window. Unencrypted vaults have no password,
    /// so the window opens immediately.
    pub fn reauth(&self, password: &SecretString) -> Result<i64> {
        // Serialised with unlock and key changes: concurrent attempts would each pass the backoff check before any
        // failure is recorded (and run several 256 MiB Argon2 instances at once).
        let _g = self.inner.keyops.lock();
        let session = self.session()?;
        if session.codec.encrypting() {
            self.check_backoff()?;
            let slots = self.slots()?;
            let slot = find_slot(&slots, KeyslotKind::Password)
                .ok_or(StoreError::Unsupported("this vault has no password"))?;
            match slot.unwrap_password(&self.inner.vault_id, password) {
                Ok(_) => {}
                Err(emp_crypto::CryptoError::BadPassword) => return Err(self.record_failure()?),
                Err(e) => return Err(e.into()),
            }
        }
        let until = self.now() + REAUTH_MS;
        *session.reauth_until.lock() = Some(until);
        Ok(until)
    }

    /// Fails with `REAUTH_REQUIRED` unless `vault_reauth` succeeded in the last 5 minutes.
    pub fn require_reauth(&self) -> Result<()> {
        let s = self.session()?;
        let ok = s.reauth_until.lock().is_some_and(|t| t > self.now());
        if ok {
            Ok(())
        } else {
            Err(StoreError::ReauthRequired)
        }
    }

    fn verify_password(&self, password: &SecretString) -> Result<Dek> {
        self.check_backoff()?;
        let slots = self.slots()?;
        let slot = find_slot(&slots, KeyslotKind::Password)
            .ok_or(StoreError::Unsupported("this vault has no password"))?;
        match slot.unwrap_password(&self.inner.vault_id, password) {
            Ok(d) => Ok(d),
            Err(emp_crypto::CryptoError::BadPassword) => Err(self.record_failure()?),
            Err(e) => Err(e.into()),
        }
    }

    fn reseal_state(&self) -> Result<()> {
        let keys = self.session()?.codec.keys_arc();
        self.write_full(move |tx| {
            manifest::reseal(tx, &keys)?;
            manifest::write_header_mac(tx, &keys)
        })
    }

    // ── password and KDF

    /// `vault_change_password`. Writes the new slot and deletes the old one in one `synchronous=FULL` transaction.
    pub fn change_password(
        &self,
        old: &SecretString,
        new: &SecretString,
        kdf: KdfParams,
    ) -> Result<VaultStatus> {
        let _g = self.inner.keyops.lock();
        self.session()?;
        let dek = self.verify_password(old)?;
        let slots = self.slots()?;
        let now = self.now();
        let slot = Keyslot::wrap_password(
            &self.inner.vault_id,
            next_slot_id(&slots),
            &dek,
            new,
            &kdf,
            now,
        )?;
        drop(dek);
        self.write_full(move |tx| {
            tx.execute("DELETE FROM keyslots WHERE kind = 'password'", [])?;
            insert_keyslot(tx, &slot)?;
            log_event(tx, now, SecurityEvent::PwChange)?;
            Ok(())
        })?;
        self.reseal_state()?;
        self.status()
    }

    /// `vault_strengthen_kdf`: re-wraps the DEK with stronger parameters.
    pub fn strengthen_kdf(&self, password: &SecretString, kdf: KdfParams) -> Result<VaultStatus> {
        self.change_password(password, password, kdf)
    }

    // ── recovery key

    /// `vault_recovery_view` (reauth): the recovery words, only while not yet confirmed.
    pub fn recovery_view(&self) -> Result<RecoveryWords> {
        self.require_reauth()?;
        let session = self.session()?;
        let words: Option<Vec<String>> =
            crate::repo::kv::get_internal(self, &session, RECOVERY_NS, RECOVERY_KEY)?;
        words
            .map(zeroize::Zeroizing::new)
            .ok_or(StoreError::Unsupported(
                "the recovery key was confirmed; regenerate it instead",
            ))
    }

    /// `vault_recovery_regenerate` (reauth): a new recovery key replaces the old slot.
    pub fn recovery_regenerate(&self) -> Result<RecoveryWords> {
        let _g = self.inner.keyops.lock();
        self.require_reauth()?;
        let session = self.session()?;
        if !session.codec.encrypting() {
            return Err(StoreError::Unsupported(
                "recovery keys exist only for encrypted vaults",
            ));
        }
        let slots = self.slots()?;
        let rk = RecoveryKey::generate()?;
        let now = self.now();
        let slot = Keyslot::wrap_recovery(
            &self.inner.vault_id,
            next_slot_id(&slots),
            &session.dek,
            &rk,
            now,
        )?;
        let words = rk.words()?;
        self.write_full(move |tx| {
            tx.execute("DELETE FROM keyslots WHERE kind = 'recovery'", [])?;
            insert_keyslot(tx, &slot)?;
            meta_set(tx, "recovery_confirmed", b"0")?;
            log_event(tx, now, SecurityEvent::RecoveryRegen)?;
            Ok(())
        })?;
        self.reseal_state()?;
        crate::repo::kv::put_internal(self, &session, RECOVERY_NS, RECOVERY_KEY, &*words)?;
        Ok(words)
    }

    /// `vault_recovery_confirm`: checks 3 words at the given 0-based positions; on success the stored copy of the
    /// words is deleted and the key is marked confirmed.
    pub fn recovery_confirm(&self, positions: &[usize], words: &[String]) -> Result<bool> {
        let session = self.session()?;
        let stored: Option<Vec<String>> =
            crate::repo::kv::get_internal(self, &session, RECOVERY_NS, RECOVERY_KEY)?;
        let Some(stored) = stored.map(zeroize::Zeroizing::new) else {
            return Err(StoreError::Unsupported(
                "there is no unconfirmed recovery key",
            ));
        };
        let rk = RecoveryKey::from_words(&stored)?;
        if positions.len() != emp_crypto::recovery::CHALLENGE_WORDS
            || !rk.verify_challenge(positions, words)
        {
            return Ok(false);
        }
        crate::repo::kv::delete_internal(self, RECOVERY_NS, RECOVERY_KEY)?;
        self.write_full(|tx| meta_set(tx, "recovery_confirmed", b"1"))?;
        Ok(true)
    }

    // ── encryption on / off

    /// `vault_enable_encryption` (job): adds password + recovery slots, removes the device slot, re-encrypts every
    /// row (batches of 1,000, resumable) and asset, then checkpoints and vacuums. Returns the recovery words.
    pub fn enable_encryption(
        &self,
        password: &SecretString,
        kdf: KdfParams,
        progress: &dyn Progress,
    ) -> Result<RecoveryWords> {
        let _g = self.inner.keyops.lock();
        let session = self.session()?;
        if session.codec.encrypting() {
            return Err(StoreError::invalid("encryption is already on"));
        }
        let slots = self.slots()?;
        let dek = &session.dek;
        let now = self.now();
        let base = next_slot_id(&slots);
        let pw_slot = Keyslot::wrap_password(&self.inner.vault_id, base, dek, password, &kdf, now)?;
        let rk = RecoveryKey::generate()?;
        let rec_slot = Keyslot::wrap_recovery(&self.inner.vault_id, base + 1, dek, &rk, now)?;
        let words = rk.words()?;
        let keys = session.codec.keys_arc();
        self.write_full(move |tx| {
            tx.execute("DELETE FROM keyslots WHERE kind = 'device'", [])?;
            insert_keyslot(tx, &pw_slot)?;
            insert_keyslot(tx, &rec_slot)?;
            meta_set(tx, "encryption", b"on")?;
            meta_set(tx, ENCRYPTION_JOB_KEY, b"on")?;
            meta_set(tx, "recovery_confirmed", b"0")?;
            log_event(tx, now, SecurityEvent::EncOn)?;
            manifest::reseal(tx, &keys)?;
            manifest::write_header_mac(tx, &keys)
        })?;
        session.codec.set_encrypting(true);
        // Stored (sealed) before the long rewrite, so an interrupted job does not lose the only copy of the words.
        crate::repo::kv::put_internal(self, &session, RECOVERY_NS, RECOVERY_KEY, &*words)?;
        self.resume_encryption_job(&session, true, progress)?;
        self.compact()?;
        self.emit(StoreEvent::StatusChanged);
        Ok(words)
    }

    /// `vault_disable_encryption` (reauth, job): wraps the DEK with a new device key, removes the password and
    /// recovery slots and decrypts every row and asset. `secrets` stay encrypted.
    pub fn disable_encryption(
        &self,
        password: &SecretString,
        progress: &dyn Progress,
    ) -> Result<()> {
        let _g = self.inner.keyops.lock();
        self.require_reauth()?;
        let session = self.session()?;
        if !session.codec.encrypting() {
            return Err(StoreError::invalid("encryption is already off"));
        }
        let dek = self.verify_password(password)?;
        let slots = self.slots()?;
        let now = self.now();
        let dk = DeviceKey::generate()?;
        self.inner
            .opts
            .device_keys
            .save(&self.inner.vault_id, &dk)?;
        let slot =
            Keyslot::wrap_device(&self.inner.vault_id, next_slot_id(&slots), &dek, &dk, now)?;
        drop(dek);
        let keys = session.codec.keys_arc();
        self.write_full(move |tx| {
            tx.execute(
                "DELETE FROM keyslots WHERE kind IN ('password', 'recovery')",
                [],
            )?;
            insert_keyslot(tx, &slot)?;
            meta_set(tx, "encryption", b"off")?;
            meta_set(tx, ENCRYPTION_JOB_KEY, b"off")?;
            log_event(tx, now, SecurityEvent::EncOff)?;
            manifest::reseal(tx, &keys)?;
            manifest::write_header_mac(tx, &keys)
        })?;
        crate::repo::kv::delete_internal(self, RECOVERY_NS, RECOVERY_KEY)?;
        session.codec.set_encrypting(false);
        self.resume_encryption_job(&session, false, progress)?;
        self.compact()?;
        self.emit(StoreEvent::StatusChanged);
        Ok(())
    }

    fn rows_pending_reencryption(&self, target: bool) -> Result<u64> {
        let from = i64::from(!target);
        self.read(|c| {
            let mut n = 0u64;
            for d in crate::db::tables::PAYLOAD_TABLES {
                if d.always_encrypted() {
                    continue;
                }
                // Device-scope settings are always plaintext.
                let extra = if d.tag == emp_crypto::TableTag::Settings {
                    " AND scope = 'vault'"
                } else {
                    ""
                };
                let sql = format!("SELECT count(*) FROM {} WHERE enc = ?1{extra}", d.name());
                let c1: i64 = c.query_row(&sql, [from], |r| r.get(0))?;
                n += u64::try_from(c1).unwrap_or(0);
            }
            Ok(n)
        })
    }

    /// Re-encrypts (or decrypts) every row whose `enc` differs from `target`, in batches of [`REENCRYPT_BATCH`],
    /// then rewrites assets. Idempotent and resumable.
    pub(crate) fn reencrypt_all(&self, target: bool, progress: &dyn Progress) -> Result<()> {
        let session = self.session()?;
        let total = self.rows_pending_reencryption(target)?;
        let mut done = 0u64;
        progress.progress(0, total, "records");
        for d in crate::db::tables::PAYLOAD_TABLES {
            if d.always_encrypted() {
                continue;
            }
            loop {
                if progress.cancelled() {
                    return Err(StoreError::Cancelled);
                }
                let s = Arc::clone(&session);
                let desc = *d;
                let n = self.write(move |tx| reencrypt_batch(tx, &desc, &s.codec, target))?;
                if n == 0 {
                    break;
                }
                done += n as u64;
                progress.progress(done, total, "records");
            }
        }
        self.reencrypt_assets(target, progress)?;
        Ok(())
    }

    /// `wal_checkpoint(TRUNCATE)` + `VACUUM` (after encryption toggles, so old plaintext pages are not left behind).
    pub fn compact(&self) -> Result<()> {
        self.inner.writer.run(|c| {
            c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            c.execute_batch("VACUUM")?;
            c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            Ok(())
        })
    }

    // ── integrity

    /// `vault_integrity_check` (job): recomputes the manifest and opens every encrypted record.
    pub fn integrity_check(&self, progress: &dyn Progress) -> Result<IntegrityReport> {
        let session = self.session()?;
        progress.progress(0, 2, "manifest");
        let encrypted = session.codec.encrypting();
        let (check, damaged) = self.inner.readers.snapshot(|c| {
            let m = manifest::verify(c, session.keys())?;
            let d = manifest::check_records(c, &session.codec)?;
            Ok((m, d))
        })?;
        progress.progress(2, 2, "records");
        let header_ok = self.read(|c| manifest::verify_header_mac(c, session.keys()))?;
        let quick_ok = if encrypted {
            true
        } else {
            self.read(conn::quick_check)?
        };
        let mset_mismatch = !check.ok() || !header_ok;
        let ok = !mset_mismatch && damaged.is_empty() && quick_ok;
        *session.integrity.lock() = if ok {
            IntegrityState::Ok
        } else {
            IntegrityState::Warning
        };
        if !ok {
            let now = self.now();
            self.write(move |tx| log_event(tx, now, SecurityEvent::IntegrityFail))?;
            self.emit(StoreEvent::IntegrityWarning {
                damaged: damaged.len(),
                mset_mismatch,
            });
        }
        Ok(IntegrityReport {
            ok,
            damaged,
            mset_mismatch,
        })
    }

    /// `vault_integrity_reseal` (reauth): accepts the current contents and re-seals the manifest.
    pub fn integrity_reseal(&self) -> Result<()> {
        self.require_reauth()?;
        let session = self.session()?;
        self.reseal_state()?;
        let now = self.now();
        self.write(move |tx| log_event(tx, now, SecurityEvent::Reseal))?;
        *session.integrity.lock() = IntegrityState::Ok;
        Ok(())
    }
}

/// Internal kv namespace holding unconfirmed recovery words (sealed with the vault).
pub(crate) const RECOVERY_NS: &str = "emp.recovery";
pub(crate) const RECOVERY_KEY: &str = "pending";

fn reencrypt_batch(
    tx: &Transaction<'_>,
    d: &crate::db::tables::TableDesc,
    codec: &Codec,
    target: bool,
) -> Result<usize> {
    let from = i64::from(!target);
    let extra = if d.tag == emp_crypto::TableTag::Settings {
        " AND scope = 'vault'"
    } else {
        ""
    };
    let sql = format!(
        "{} WHERE enc = ?1{extra} LIMIT {REENCRYPT_BATCH}",
        d.select_sql()
    );
    let mut rows: Vec<(String, rusqlite::types::Value, String, i64, i64, Vec<u8>)> = Vec::new();
    {
        let mut st = tx.prepare(&sql)?;
        let mut q = st.query([from])?;
        while let Some(r) = q.next()? {
            rows.push((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ));
        }
    }
    let (k1, k2) = d.key.columns();
    let update = match d.key {
        crate::db::tables::KeyShape::Id(_) => {
            format!(
                "UPDATE {} SET enc = ?1, payload = ?2 WHERE {k1} = ?3",
                d.name()
            )
        }
        _ => format!(
            "UPDATE {} SET enc = ?1, payload = ?2 WHERE {k1} = ?3 AND {k2} = ?4",
            d.name()
        ),
    };
    let n = rows.len();
    for (key1, key2, kind, rev, enc, payload) in rows {
        let loc = d.loc(&key1, rusqlite::types::ValueRef::from(&key2), &kind, rev)?;
        let body = codec.open_body(&loc, enc, &payload)?;
        let e = codec.store_body(&loc, &body, target)?;
        let mut st = tx.prepare_cached(&update)?;
        match d.key {
            crate::db::tables::KeyShape::Id(_) => st.execute(params![e.enc, e.payload, key1])?,
            _ => st.execute(params![e.enc, e.payload, key1, key2])?,
        };
    }
    Ok(n)
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(s) = self.session.get_mut().take() {
            s.cancel.store(true, Ordering::SeqCst);
        }
        self.writer.tracker().set_keys(None);
        let _ = self.paths.wipe_tmp();
    }
}
