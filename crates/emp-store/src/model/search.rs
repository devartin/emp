//! Search DTOs (SPEC §11.3 Search).

use serde::{Deserialize, Serialize};

use super::{Icon, Id, Ts};

/// `SearchHit.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum SearchHitKind {
    Page,
    Row,
    Database,
    Sheet,
    Block,
    Asset,
}

impl SearchHitKind {
    /// Parses a `type:` operator value.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "page" | "doc" => Self::Page,
            "row" => Self::Row,
            "database" | "db" => Self::Database,
            "sheet" => Self::Sheet,
            "block" => Self::Block,
            "asset" | "file" => Self::Asset,
            _ => return None,
        })
    }
}

/// Highlighted snippet. `ranges` are `[start, end)` offsets in **UTF-16 code units** (JavaScript string indices).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Snippet {
    /// Snippet text.
    pub text: String,
    /// Highlight ranges.
    pub ranges: Vec<[usize; 2]>,
}

/// `SearchHit`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Page / row / asset id.
    pub id: Id,
    /// Kind.
    pub kind: SearchHitKind,
    /// Title.
    pub title: String,
    /// Icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Ancestor titles, root first.
    pub path: Vec<String>,
    /// Snippet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<Snippet>,
    /// Matching block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// Relevance (higher is better).
    pub score: f64,
    /// Last edit.
    pub updated_at: Ts,
}

/// Edited-time window.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditedRange {
    /// From (inclusive).
    #[serde(default)]
    pub from: Option<Ts>,
    /// To (inclusive).
    #[serde(default)]
    pub to: Option<Ts>,
}

/// `search_query.filters`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchFilters {
    /// Restrict to this page's subtree.
    #[serde(default, rename = "in")]
    pub within: Option<Id>,
    /// Restrict kinds.
    #[serde(default, rename = "type")]
    pub kinds: Option<Vec<SearchHitKind>>,
    /// Restrict to one database's rows.
    #[serde(default)]
    pub db: Option<Id>,
    /// Edited window.
    #[serde(default)]
    pub edited: Option<EditedRange>,
}

/// `search_query` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryResult {
    /// Echoed request id.
    pub req_id: u64,
    /// Hits, best first.
    pub hits: Vec<SearchHit>,
    /// Whether the index finished building.
    pub index_ready: bool,
    /// Time taken.
    pub took_ms: u64,
}

/// `search_status` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    /// Built.
    pub ready: bool,
    /// Indexed documents.
    pub docs: usize,
    /// Currently building.
    pub building: bool,
    /// 0..1 while building.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}
