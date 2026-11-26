//! Versions (SPEC §10.2 `versions`, §11.3 Versions, D-24).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Id, Ts};

/// What a version snapshots (`versions.target_kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum VersionTargetKind {
    PageDoc,
    DbRow,
    DbSchema,
    Sheet,
    Workbook,
}

impl VersionTargetKind {
    /// Column value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PageDoc => "page_doc",
            Self::DbRow => "db_row",
            Self::DbSchema => "db_schema",
            Self::Sheet => "sheet",
            Self::Workbook => "workbook",
        }
    }

    /// Parses the column value.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "page_doc" => Self::PageDoc,
            "db_row" => Self::DbRow,
            "db_schema" => Self::DbSchema,
            "sheet" => Self::Sheet,
            "workbook" => Self::Workbook,
            _ => return None,
        })
    }
}

/// Why a version was taken (`versions.reason`, visible on disk per §9.20).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum VersionReason {
    Auto,
    Manual,
    PreRestore,
    PreImport,
    PreBulk,
    PreMigration,
    PreLifeapp,
}

impl VersionReason {
    /// Column value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
            Self::PreRestore => "pre_restore",
            Self::PreImport => "pre_import",
            Self::PreBulk => "pre_bulk",
            Self::PreMigration => "pre_migration",
            Self::PreLifeapp => "pre_lifeapp",
        }
    }

    /// Parses the column value.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "auto" => Self::Auto,
            "manual" => Self::Manual,
            "pre_restore" => Self::PreRestore,
            "pre_import" => Self::PreImport,
            "pre_bulk" => Self::PreBulk,
            "pre_migration" => Self::PreMigration,
            "pre_lifeapp" => Self::PreLifeapp,
            _ => return None,
        })
    }
}

/// Stored payload of a `versions` row (always zstd-compressed before sealing / storing).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionPayload {
    /// Payload version.
    pub v: u32,
    /// User label (manual versions).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The snapshot (for `page_doc`: the `TipTapDoc`).
    pub snapshot: Value,
}

/// `VersionMeta` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    /// Id.
    pub id: Id,
    /// Created.
    pub created_at: Ts,
    /// Reason column value.
    pub reason: String,
    /// Label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Stored (padded / compressed) size in bytes.
    pub size: i64,
}
