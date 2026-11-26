//! # emp-store
//!
//! The EMP vault: SQLite storage with optional envelope encryption, an integrity manifest, typed repositories,
//! document indexing (text, outline, links, backlinks), page versions, encrypted assets, an in-memory search
//! index, Markdown/HTML export and `.empsnap` / `.empbackup` snapshots (SPEC §7.1, §7.8–§7.10, §9, §10).
//!
//! ## Using it from the app
//!
//! ```no_run
//! # fn main() -> emp_store::Result<()> {
//! use emp_store::{CreateOptions, Store, StoreOptions};
//! use emp_store::model::{AutoLock, PageCreate, PageKind};
//! let data = std::path::Path::new("/tmp/emp-data");
//! let opts = StoreOptions::new(data.join("device.key"));
//! let created = Store::create(data, CreateOptions {
//!     password: Some("correct horse battery staple".to_owned().into()),
//!     kdf: emp_crypto::KdfParams::STANDARD,
//!     auto_lock: AutoLock::default(),
//!     workspace_name: Some("Personal".into()),
//! }, opts)?;
//! let store = created.store;
//! let ws = store.workspace_list()?.remove(0);
//! let page = store.page_create(PageCreate::new(&ws.id, None, PageKind::Doc, "Hello"))?;
//! store.lock()?;
//! # let _ = page; Ok(()) }
//! ```
//!
//! * **Lifecycle** ([`vault`]): [`Store::create`], [`Store::open`], [`Store::unlock`], [`Store::unlock_device`],
//!   [`Store::unlock_recovery`], [`Store::lock`], [`Store::reauth`], password / recovery / encryption toggles,
//!   [`Store::status`], [`Store::integrity_check`].
//! * **Repositories** (`impl Store` blocks in [`repo`]): workspaces, pages and trash, docs, versions, assets,
//!   settings, kv, secrets, security log. Method names follow the IPC commands of SPEC §11.3.
//! * **Search** ([`search`]): [`Store::search_query`], [`Store::search_status`], [`Store::search_reindex`].
//! * **Backups** ([`backup`]): snapshots and `.empbackup` create / verify / restore, Markdown / HTML export.
//!
//! Every method is blocking and thread-safe; call it from `spawn_blocking`. Errors are [`StoreError`]; map them to
//! IPC with [`StoreError::code`].
//!
//! ## Threading model
//! One writer thread owns the read-write connection (bounded queue of 256 jobs); a pool of 4 read-only
//! connections serves reads. Every write runs in an `IMMEDIATE` transaction that also maintains the integrity
//! manifest (see [`manifest`]).

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod backup;
pub mod codec;
pub mod db;
pub mod doc;
pub mod error;
pub mod icons;
pub mod manifest;
pub mod model;
pub mod repo;
pub mod search;
pub mod vault;

/// Database query engine (filter, sort, group, aggregate, rollups) — owned by the databases workstream.
pub mod query;

/// Importers (Markdown, Notion, CSV) — owned by the import workstream.
pub mod import;

/// Life-app framework — owned by the life-apps workstream.
pub mod lifeapps;

/// Habits, recurrence, natural-language dates and the reminder scheduler — owned by the life-apps workstream.
pub mod life;

pub use error::{Result, StoreError};
pub use vault::{
    Clock, CreateOptions, Created, DeviceKeyStore, EventSink, FileDeviceKeyStore, NoEvents,
    NoProgress, Store, StoreEvent, StoreOptions, SystemClock, VaultPaths,
};

/// Progress reporting and cancellation for long-running (job) operations.
pub trait Progress: Send + Sync {
    /// Reports `done` of `total` units.
    fn progress(&self, done: u64, total: u64, label: &str);
    /// Whether the job should stop (checked between batches).
    fn cancelled(&self) -> bool {
        false
    }
}

// ── Data layer (databases, sheets, imports, reminders): convenience re-exports. The commands themselves are
//    `Store` methods in `repo::{databases, rows, views, workbooks, sheets, reminders, outbox, sync_links}`, the
//    importers' in `import::*`.
pub use import::zipfs::ZipLimits;
pub use life::scheduler::Scheduler;
pub use query::model as dbmodel;

// ── Life apps (SPEC §16): the `lifeapp_*` commands are `Store` methods in `repo::lifeapps`; manifests, plans,
//    metrics and insights live in `lifeapps::*`.
pub use lifeapps::advisor::Insight;
pub use lifeapps::answers::Mode as LifeAppMode;
pub use lifeapps::metrics::{MetricProvider, MetricValue};
pub use lifeapps::plan::{GenerationPlan, PlanDiff};
pub use lifeapps::{LifeAppManifest, LifeAppSummary};
pub use repo::lifeapps::{
    InstallResult, LifeAppInstance, LifeappInstall, LifeappPreview, SampleResult, TuneupResult,
};
