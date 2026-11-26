//! Repositories: `impl Store` blocks grouped by table family. Every write goes through the single writer with
//! optimistic concurrency on `rev` where the IPC contract exposes one.

pub mod assets;
pub mod docs;
pub mod kv;
pub mod pages;
pub mod secrets;
pub mod security_log;
pub mod settings;
pub mod tour;
pub mod versions;
pub mod workspaces;

// Data layer (databases, sheets, life apps, reminders, sync).
pub mod databases;
pub mod lifeapps;
pub mod outbox;
pub mod reminders;
pub mod rows;
pub mod sheets;
pub mod sync_links;
pub mod views;
pub mod workbooks;
