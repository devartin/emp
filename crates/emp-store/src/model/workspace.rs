//! Workspaces (SPEC §10.3 `WorkspacePayload`, §11.3 Workspaces).

use serde::{Deserialize, Serialize};

use super::{Icon, Id, PageFont, PageMeta, double_option};

/// Default page settings of a workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDefaults {
    /// Font.
    pub font: PageFont,
    /// Full width.
    pub full_width: bool,
    /// Small text.
    pub small_text: bool,
}

/// Stored payload of a `workspaces` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePayload {
    /// Payload version.
    pub v: u32,
    /// Name.
    pub name: String,
    /// Icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Favourite page ids.
    #[serde(default)]
    pub favorites: Vec<Id>,
    /// Recently opened page ids, most recent first (≤ 50).
    #[serde(default)]
    pub recents: Vec<Id>,
    /// Page defaults.
    #[serde(default)]
    pub defaults: WorkspaceDefaults,
}

/// `Workspace` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    /// Id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Favourites.
    pub favorites: Vec<Id>,
    /// Defaults.
    pub defaults: WorkspaceDefaults,
}

/// `workspace_update.patch`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePatch {
    /// New name.
    #[serde(default)]
    pub name: Option<String>,
    /// New icon (`null` clears).
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<Icon>>,
    /// Replaces the favourites list.
    #[serde(default)]
    pub favorites: Option<Vec<Id>>,
    /// Replaces the defaults.
    #[serde(default)]
    pub defaults: Option<WorkspaceDefaults>,
}

/// `workspace_open` result (without `lastRoute`, which the app layer adds from kv).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpen {
    /// The workspace.
    pub workspace: Workspace,
    /// Every live (non-trashed) page of the workspace, in tree order.
    pub pages: Vec<PageMeta>,
    /// Recent page ids.
    pub recents: Vec<Id>,
    /// Life apps installed in the workspace (`lifeapp_instances`).
    pub lifeapps: Vec<crate::repo::lifeapps::LifeAppInstance>,
}
