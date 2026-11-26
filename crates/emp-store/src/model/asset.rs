//! Assets (SPEC §10.2 `assets`, §11.3 Assets).

use serde::{Deserialize, Serialize};

use super::Id;

/// Stored payload of an `assets` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPayload {
    /// Payload version.
    pub v: u32,
    /// Original file name.
    pub name: String,
    /// MIME type (sniffed for images).
    pub mime: String,
    /// Content size in bytes.
    pub size: u64,
    /// Image width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Image height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Where it came from (`upload`, `paste`, `import`, `url`, ...).
    pub source: String,
    /// Remote origin for `url` imports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<String>,
}

/// `AssetDTO` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDto {
    /// Id (32 hex).
    pub id: Id,
    /// Name.
    pub name: String,
    /// MIME type.
    pub mime: String,
    /// Size in bytes.
    pub size: u64,
    /// Width.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Height.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// `emp-asset` URL (base configured in `StoreOptions::asset_url_base`).
    pub url: String,
}

/// Parameters for importing an asset.
#[derive(Clone, Debug)]
pub struct AssetImport {
    /// Workspace.
    pub workspace_id: Id,
    /// File name.
    pub name: String,
    /// Caller-declared MIME type (images are re-sniffed from magic bytes).
    pub mime: String,
    /// Exact content length in bytes (the stream must deliver exactly this many).
    pub len: u64,
    /// `upload`, `paste`, `import`, `url`.
    pub source: String,
    /// Remote origin for `url` imports.
    pub origin_url: Option<String>,
}
