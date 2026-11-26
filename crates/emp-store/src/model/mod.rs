//! Pure DTOs and payload structs (SPEC §10.3, §11.2, §11.3).
//!
//! IPC-facing types use `#[serde(rename_all = "camelCase")]` and match `src/backend/types.ts`. Payload structs
//! (`*Payload`) are what is stored in the `payload` column; every payload carries `"v": n`.

pub mod asset;
pub mod common;
pub mod ids;
pub mod page;
pub mod search;
pub mod secret;
pub mod settings;
pub mod sort_key;
pub mod tiptap;
pub mod vault;
pub mod version;
pub mod workspace;

pub use asset::*;
pub use common::*;
pub use page::*;
pub use search::*;
pub use secret::*;
pub use settings::*;
pub use tiptap::*;
pub use vault::*;
pub use version::*;
pub use workspace::*;

/// Serde helper for `field?: T | null` patch semantics: absent → `None`, `null` → `Some(None)`,
/// value → `Some(Some(v))`. Use with `#[serde(default, deserialize_with = "double_option")]`.
pub fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}
