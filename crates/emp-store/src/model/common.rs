//! Shared types from SPEC §11.2.

use serde::{Deserialize, Serialize};

/// Record id (lowercase UUIDv7 text; asset ids are 32 hex characters; secrets are `secret:<hex>`).
pub type Id = String;
/// Unix milliseconds.
pub type Ts = i64;
/// Revision counter.
pub type Rev = i64;

/// Block / tag colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum BlockColor {
    Gray,
    Brown,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Pink,
    Red,
}

/// Page / workspace icon.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Icon {
    /// A native emoji.
    Emoji {
        /// The emoji.
        v: String,
    },
    /// A lucide icon name.
    Lucide {
        /// Icon name.
        v: String,
        /// `BlockColor` or `"accent"`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
    /// An uploaded asset.
    Asset {
        /// Asset id.
        #[serde(rename = "assetId")]
        asset_id: Id,
    },
}

/// Page cover.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Cover {
    /// One of the built-in gradients (`aurora|dusk|mint|sand|slate|rose`).
    Gradient {
        /// Gradient name.
        v: String,
    },
    /// An uploaded image.
    Asset {
        /// Asset id.
        #[serde(rename = "assetId")]
        asset_id: Id,
        /// Vertical focus 0..1.
        #[serde(rename = "posY")]
        pos_y: f64,
    },
}

/// Page kind (plaintext column, SPEC §9.20).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum PageKind {
    Doc,
    Database,
    Sheet,
    App,
    Dashboard,
}

impl PageKind {
    /// The `pages.kind` column value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Doc => "doc",
            Self::Database => "database",
            Self::Sheet => "sheet",
            Self::App => "app",
            Self::Dashboard => "dashboard",
        }
    }

    /// Parses the column value.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "doc" => Self::Doc,
            "database" => Self::Database,
            "sheet" => Self::Sheet,
            "app" => Self::App,
            "dashboard" => Self::Dashboard,
            _ => return None,
        })
    }
}

/// Font choice for pages and workspace defaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum PageFont {
    #[default]
    Sans,
    Serif,
    Mono,
}

/// Validates a user-supplied title (≤ 1,024 characters, SPEC §11.1).
pub fn validate_title(title: &str) -> crate::Result<()> {
    if title.chars().count() > 1024 {
        return Err(crate::StoreError::invalid_field(
            "title",
            "titles are limited to 1,024 characters",
        ));
    }
    Ok(())
}
