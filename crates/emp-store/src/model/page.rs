//! Pages and docs (SPEC §10.3 `PagePayload`, §11.2 `PageMeta`, §11.3 Pages and docs).

use serde::{Deserialize, Serialize};

use super::{Cover, Icon, Id, PageFont, PageKind, Rev, TipTapDoc, Ts, double_option};

/// Page flags.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct PageFlags {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_width: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub small_text: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<PageFont>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
    /// A project: a doc page whose children are its contents (Ultranote 1.0 brief §2.2, §3). Absent means `false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<bool>,
}

impl PageFlags {
    /// Applies a partial update (fields present in `patch` win).
    pub fn apply(&mut self, patch: &PageFlags) {
        macro_rules! merge {
            ($($f:ident),*) => { $( if patch.$f.is_some() { self.$f = patch.$f; } )* };
        }
        merge!(full_width, small_text, font, locked, template, inline, project);
    }
}

/// Stored payload of a `pages` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePayload {
    /// Payload version.
    pub v: u32,
    /// Title.
    pub title: String,
    /// Icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Cover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    /// Flags.
    #[serde(default)]
    pub flags: PageFlags,
    /// Owning life-app instance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_instance_id: Option<Id>,
    /// Template key (life apps; `daily:YYYY-MM-DD` for daily notes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_key: Option<String>,
}

impl PagePayload {
    /// A new v1 payload with a title.
    #[must_use]
    pub fn new(title: &str) -> Self {
        Self {
            v: 1,
            title: title.to_owned(),
            icon: None,
            cover: None,
            flags: PageFlags::default(),
            app_instance_id: None,
            template_key: None,
        }
    }
}

/// `PageMeta` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    /// Id.
    pub id: Id,
    /// Workspace.
    pub workspace_id: Id,
    /// Parent page (`null` at the root).
    pub parent_id: Option<Id>,
    /// Kind.
    pub kind: PageKind,
    /// Fractional sort key among siblings.
    pub sort_key: String,
    /// Title.
    pub title: String,
    /// Icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Cover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    /// Created.
    pub created_at: Ts,
    /// Updated.
    pub updated_at: Ts,
    /// Trashed at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<Ts>,
    /// Meta revision.
    pub rev: Rev,
    /// Flags.
    pub flags: PageFlags,
    /// Owning life-app instance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_instance_id: Option<Id>,
    /// Whether the page has live children.
    pub has_children: bool,
}

/// `page_update_meta.patch`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageMetaPatch {
    /// New title.
    #[serde(default)]
    pub title: Option<String>,
    /// New icon (`null` clears).
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<Icon>>,
    /// New cover (`null` clears).
    #[serde(default, deserialize_with = "double_option")]
    pub cover: Option<Option<Cover>>,
    /// Partial flags.
    #[serde(default)]
    pub flags: Option<PageFlags>,
}

/// Parameters of `page_create` (and the generic page creation used by databases, sheets and life apps).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageCreate {
    /// Workspace.
    pub workspace_id: Id,
    /// Parent page, or `None` for the root.
    pub parent_id: Option<Id>,
    /// Kind (`page_create` IPC only allows `doc` and `dashboard`).
    pub kind: PageKind,
    /// Title.
    #[serde(default)]
    pub title: Option<String>,
    /// Icon.
    #[serde(default)]
    pub icon: Option<Icon>,
    /// Insert after this sibling (default: append at the end).
    #[serde(default)]
    pub after_id: Option<Id>,
    /// Copy this template page's doc and children.
    #[serde(default)]
    pub template_page_id: Option<Id>,
    /// Initial document.
    #[serde(default)]
    pub doc: Option<TipTapDoc>,
    /// Initial flags (merged over the defaults, e.g. `{ project: true }`).
    #[serde(default)]
    pub flags: Option<PageFlags>,
}

impl PageCreate {
    /// A minimal request.
    #[must_use]
    pub fn new(workspace_id: &str, parent_id: Option<&str>, kind: PageKind, title: &str) -> Self {
        Self {
            workspace_id: workspace_id.to_owned(),
            parent_id: parent_id.map(str::to_owned),
            kind,
            title: Some(title.to_owned()),
            icon: None,
            after_id: None,
            template_page_id: None,
            doc: None,
            flags: None,
        }
    }
}

/// `page_create` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCreated {
    /// The new page.
    pub meta: PageMeta,
    /// Doc revision (0 if no doc was written).
    pub doc_rev: Rev,
}

/// Breadcrumb entry.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Breadcrumb {
    /// Page id.
    pub id: Id,
    /// Title.
    pub title: String,
    /// Icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
}

/// `page_get` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageGet {
    /// Meta.
    pub meta: PageMeta,
    /// Document (`null` for pages without one).
    pub doc: Option<TipTapDoc>,
    /// Doc revision (0 if none yet).
    pub doc_rev: Rev,
    /// Ancestors, root first (excluding the page itself).
    pub breadcrumbs: Vec<Breadcrumb>,
}

/// One backlink (`page_backlinks`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    /// Linking page.
    pub source_id: Id,
    /// Its title.
    pub source_title: String,
    /// Its icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_icon: Option<Icon>,
    /// Block holding the link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// ±60 characters around the link.
    pub snippet: String,
}

/// One heading of `page_outline`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    /// Block id.
    pub block_id: String,
    /// 1..=3.
    pub level: u8,
    /// Heading text.
    pub text: String,
}

/// Owner of a `page_docs` row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocOwnerKind {
    /// A page.
    Page,
    /// A database row (row page).
    Row,
}

impl DocOwnerKind {
    /// Column value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Row => "row",
        }
    }
}

/// Stored payload of a `page_docs` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPayload {
    /// Payload version.
    pub v: u32,
    /// Always `tiptap-json@1`.
    pub format: String,
    /// The document.
    pub doc: TipTapDoc,
}

/// Template listing entry (`template_list`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    /// Template id (page id for user templates).
    pub id: String,
    /// Title.
    pub title: String,
    /// Icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Built-in template?
    pub builtin: bool,
    /// Category.
    pub category: String,
    /// Kind.
    pub kind: PageKind,
}
