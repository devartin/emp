//! TipTap / ProseMirror JSON (SPEC §11.2 `TipTapNode`, `TipTapDoc`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A mark on a text node.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TipTapMark {
    /// Mark type (`bold`, `link`, ...).
    #[serde(rename = "type")]
    pub kind: String,
    /// Attributes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Map<String, Value>>,
}

/// Any node of a document.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TipTapNode {
    /// Node type (`blockContainer`, `paragraph`, `text`, ...).
    #[serde(rename = "type")]
    pub kind: String,
    /// Attributes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Map<String, Value>>,
    /// Children.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<TipTapNode>>,
    /// Marks (text nodes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marks: Option<Vec<TipTapMark>>,
    /// Text (text nodes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl TipTapNode {
    /// A node with a type and no attrs/children.
    #[must_use]
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            ..Self::default()
        }
    }

    /// A text node.
    #[must_use]
    pub fn text(text: &str) -> Self {
        Self {
            kind: "text".into(),
            text: Some(text.to_owned()),
            ..Self::default()
        }
    }

    /// Builder: sets an attribute.
    #[must_use]
    pub fn with_attr(mut self, key: &str, value: Value) -> Self {
        self.attrs
            .get_or_insert_with(Map::new)
            .insert(key.to_owned(), value);
        self
    }

    /// Builder: sets the children.
    #[must_use]
    pub fn with_content(mut self, content: Vec<TipTapNode>) -> Self {
        self.content = Some(content);
        self
    }

    /// A string attribute.
    #[must_use]
    pub fn attr_str(&self, key: &str) -> Option<&str> {
        self.attrs.as_ref()?.get(key)?.as_str()
    }

    /// Any attribute.
    #[must_use]
    pub fn attr(&self, key: &str) -> Option<&Value> {
        self.attrs.as_ref()?.get(key)
    }

    /// Children as a slice (empty if none).
    #[must_use]
    pub fn children(&self) -> &[TipTapNode] {
        self.content.as_deref().unwrap_or(&[])
    }
}

/// Root attributes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocAttrs {
    /// Schema version (1 in v1).
    pub schema_version: u32,
}

/// A page document.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TipTapDoc {
    /// Always `"doc"`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Root attributes.
    pub attrs: DocAttrs,
    /// One `blockGroup` (`doc := blockGroup`).
    #[serde(default)]
    pub content: Vec<TipTapNode>,
}

impl TipTapDoc {
    /// An empty document: one blockGroup holding one empty paragraph container.
    pub fn empty() -> crate::Result<Self> {
        Ok(Self::from_blocks(vec![crate::doc::schema::container(
            TipTapNode::new("paragraph"),
            None,
        )?]))
    }

    /// A document whose root blockGroup holds `containers`.
    #[must_use]
    pub fn from_blocks(containers: Vec<TipTapNode>) -> Self {
        Self {
            kind: "doc".into(),
            attrs: DocAttrs {
                schema_version: crate::doc::schema::SCHEMA_VERSION,
            },
            content: vec![TipTapNode::new("blockGroup").with_content(containers)],
        }
    }

    /// The root blockGroup's containers.
    #[must_use]
    pub fn blocks(&self) -> &[TipTapNode] {
        self.content
            .first()
            .map(TipTapNode::children)
            .unwrap_or(&[])
    }
}
