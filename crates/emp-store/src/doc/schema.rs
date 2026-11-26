//! The D-07 schema manifest (`emp_store::doc::SCHEMA`) and document normalisation (SPEC §7.1).
//!
//! [`Schema::manifest_json`] produces exactly the JSON of `schemaManifest()` in
//! `src/features/editor/schema.ts`; a CI test compares the two.
//!
//! [`normalize`] enforces the invariants on documents received over IPC:
//! unique, well-formed block ids (duplicates regenerated, first occurrence kept); every `blockContainer` holds one
//! known `blockContent` and at most one child `blockGroup`; children only under child-capable types (others are
//! hoisted to siblings); no `columnList` inside a column; a single-column `columnList` is unwrapped; 2–5 columns with
//! widths summing to 1.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::model::ids::{is_block_id, new_block_id};
use crate::model::{TipTapDoc, TipTapNode};
use crate::{Result, StoreError};

/// Current document schema version (`doc.attrs.schemaVersion`).
pub const SCHEMA_VERSION: u32 = 1;
/// Maximum nesting depth of blockContainers.
pub const MAX_DEPTH: usize = 48;
/// Maximum number of columns in a `columnList`.
pub const MAX_COLUMNS: usize = 5;

/// One node type.
#[derive(Debug, Clone, Copy)]
pub struct NodeSpec {
    /// Type name.
    pub name: &'static str,
    /// ProseMirror content expression.
    pub content: Option<&'static str>,
    /// Group.
    pub group: Option<&'static str>,
    /// Attribute names.
    pub attrs: &'static [&'static str],
}

/// One mark type.
#[derive(Debug, Clone, Copy)]
pub struct MarkSpec {
    /// Mark name.
    pub name: &'static str,
    /// Attribute names.
    pub attrs: &'static [&'static str],
}

/// The schema.
#[derive(Debug)]
pub struct Schema {
    /// Version.
    pub version: u32,
    /// Nodes in manifest order.
    pub nodes: &'static [NodeSpec],
    /// Marks.
    pub marks: &'static [MarkSpec],
}

const fn n(
    name: &'static str,
    content: Option<&'static str>,
    group: Option<&'static str>,
    attrs: &'static [&'static str],
) -> NodeSpec {
    NodeSpec {
        name,
        content,
        group,
        attrs,
    }
}

const BC: Option<&str> = Some("blockContent");
const INL: Option<&str> = Some("inline*");

/// `emp_store::doc::SCHEMA`.
pub static SCHEMA: Schema = Schema {
    version: SCHEMA_VERSION,
    nodes: &[
        n("doc", Some("blockGroup"), None, &["schemaVersion"]),
        n("blockGroup", Some("blockContainer+"), None, &[]),
        n(
            "blockContainer",
            Some("blockContent blockGroup?"),
            None,
            &["id", "color", "bg", "dir"],
        ),
        n("paragraph", INL, BC, &[]),
        n("heading", INL, BC, &["level", "toggle", "collapsed"]),
        n("bulletItem", INL, BC, &[]),
        n("numberedItem", INL, BC, &["start"]),
        n("todoItem", INL, BC, &["checked"]),
        n("toggle", INL, BC, &["collapsed"]),
        n("quote", INL, BC, &[]),
        n("callout", INL, BC, &["icon", "color"]),
        n(
            "codeBlock",
            Some("text*"),
            BC,
            &["language", "wrap", "caption"],
        ),
        n("divider", None, BC, &[]),
        n("mathBlock", None, BC, &["latex"]),
        n(
            "table",
            Some("tableRow+"),
            BC,
            &["headerRow", "headerCol", "colWidths", "cellColors"],
        ),
        n("tableRow", Some("tableCell+"), None, &[]),
        n("tableCell", INL, None, &[]),
        n("columnList", Some("column{2,5}"), BC, &["widths"]),
        n("column", Some("blockGroup"), None, &[]),
        n("pageRef", None, BC, &["pageId"]),
        n("pageLink", None, BC, &["pageId"]),
        n(
            "image",
            None,
            BC,
            &["assetId", "width", "align", "caption", "pendingUrl"],
        ),
        n("file", None, BC, &["assetId"]),
        n("toc", None, BC, &[]),
        n(
            "databaseView",
            None,
            BC,
            &["databaseId", "viewId", "linked", "height"],
        ),
        n("chart", None, BC, &["source", "spec"]),
        n("kpi", None, BC, &["source", "agg", "label", "format"]),
        n("sheetEmbed", None, BC, &["workbookId", "sheetId", "range"]),
        n("watchlist", None, BC, &["watchlistId"]),
        n("text", None, Some("inline"), &[]),
        n("hardBreak", None, Some("inline"), &[]),
        n(
            "mention",
            None,
            Some("inline"),
            &["kind", "pageId", "date", "reminderId"],
        ),
        n("emoji", None, Some("inline"), &["native", "shortcode"]),
        n("mathInline", None, Some("inline"), &["latex"]),
    ],
    marks: &[
        MarkSpec {
            name: "bold",
            attrs: &[],
        },
        MarkSpec {
            name: "italic",
            attrs: &[],
        },
        MarkSpec {
            name: "underline",
            attrs: &[],
        },
        MarkSpec {
            name: "strike",
            attrs: &[],
        },
        MarkSpec {
            name: "code",
            attrs: &[],
        },
        MarkSpec {
            name: "link",
            attrs: &["href"],
        },
        MarkSpec {
            name: "textColor",
            attrs: &["color"],
        },
        MarkSpec {
            name: "highlight",
            attrs: &["color"],
        },
    ],
};

/// blockContent types that may own a child blockGroup (`heading` only when `toggle: true`).
pub const CHILD_CAPABLE: &[&str] = &[
    "paragraph",
    "heading",
    "bulletItem",
    "numberedItem",
    "todoItem",
    "toggle",
    "quote",
    "callout",
];

impl Schema {
    /// Looks a node up.
    #[must_use]
    pub fn node(&self, name: &str) -> Option<&NodeSpec> {
        self.nodes.iter().find(|n| n.name == name)
    }

    /// `true` for blockContent types.
    #[must_use]
    pub fn is_block_content(&self, name: &str) -> bool {
        self.node(name)
            .is_some_and(|n| n.group == Some("blockContent"))
    }

    /// The manifest compared against `schemaManifest()` in CI.
    #[must_use]
    pub fn manifest_json(&self) -> Value {
        let mut nodes = Map::new();
        for n in self.nodes {
            let mut o = Map::new();
            if let Some(c) = n.content {
                o.insert("content".into(), json!(c));
            }
            if let Some(g) = n.group {
                o.insert("group".into(), json!(g));
            }
            o.insert("attrs".into(), json!(n.attrs));
            nodes.insert(n.name.into(), Value::Object(o));
        }
        let mut marks = Map::new();
        for m in self.marks {
            marks.insert(m.name.into(), json!({ "attrs": m.attrs }));
        }
        json!({ "version": self.version, "nodes": nodes, "marks": marks })
    }
}

/// `true` if a container whose content is `content` may have children.
#[must_use]
pub fn can_have_children(content: &TipTapNode) -> bool {
    match content.kind.as_str() {
        "heading" => content.attr("toggle").and_then(Value::as_bool) == Some(true),
        k => CHILD_CAPABLE.contains(&k),
    }
}

/// A new `blockContainer` with a fresh id around `content` and optional child containers.
pub fn container(content: TipTapNode, children: Option<Vec<TipTapNode>>) -> Result<TipTapNode> {
    let mut nodes = vec![content];
    if let Some(ch) = children.filter(|c| !c.is_empty()) {
        nodes.push(TipTapNode::new("blockGroup").with_content(ch));
    }
    Ok(TipTapNode::new("blockContainer")
        .with_attr("id", json!(new_block_id()?))
        .with_attr("color", Value::Null)
        .with_attr("bg", Value::Null)
        .with_attr("dir", json!("auto"))
        .with_content(nodes))
}

/// What [`normalize`] changed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NormalizeReport {
    /// Block ids that were missing, malformed or duplicated and were regenerated.
    pub regenerated_ids: usize,
    /// Structural repairs (hoisted children, unwrapped column lists, ...).
    pub repairs: usize,
}

struct Ctx {
    seen: HashSet<String>,
    report: NormalizeReport,
}

/// Normalises a document in place (see the module docs). Fails only on unrecoverable input (wrong root type,
/// nesting deeper than [`MAX_DEPTH`]).
pub fn normalize(doc: &mut TipTapDoc) -> Result<NormalizeReport> {
    if doc.kind != "doc" {
        return Err(StoreError::invalid("document root must be of type 'doc'"));
    }
    if doc.attrs.schema_version != SCHEMA_VERSION {
        return Err(StoreError::invalid("unsupported document schemaVersion"));
    }
    let mut ctx = Ctx {
        seen: HashSet::new(),
        report: NormalizeReport::default(),
    };
    // doc := blockGroup. Accept a bare list of containers and wrap it.
    let mut containers = Vec::new();
    for node in std::mem::take(&mut doc.content) {
        match node.kind.as_str() {
            "blockGroup" => containers.extend(node.content.unwrap_or_default()),
            _ => {
                ctx.report.repairs += 1;
                containers.push(node);
            }
        }
    }
    let mut out = norm_group(containers, &mut ctx, 0, false)?;
    if out.is_empty() {
        out.push(container(TipTapNode::new("paragraph"), None)?);
    }
    doc.content = vec![TipTapNode::new("blockGroup").with_content(out)];
    Ok(ctx.report)
}

fn fresh_id(ctx: &mut Ctx) -> Result<String> {
    loop {
        let id = new_block_id()?;
        if ctx.seen.insert(id.clone()) {
            return Ok(id);
        }
    }
}

fn norm_group(
    nodes: Vec<TipTapNode>,
    ctx: &mut Ctx,
    depth: usize,
    in_column: bool,
) -> Result<Vec<TipTapNode>> {
    if depth > MAX_DEPTH {
        return Err(StoreError::invalid("document nesting is too deep"));
    }
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        norm_container(node, ctx, depth, in_column, &mut out)?;
    }
    Ok(out)
}

/// Normalises one container, pushing the result (possibly several containers, or none) to `out`.
fn norm_container(
    mut node: TipTapNode,
    ctx: &mut Ctx,
    depth: usize,
    in_column: bool,
    out: &mut Vec<TipTapNode>,
) -> Result<()> {
    if node.kind != "blockContainer" {
        // A bare blockContent where a container was expected: wrap it.
        if SCHEMA.is_block_content(&node.kind) {
            ctx.report.repairs += 1;
            node = container(node, None)?;
        } else if node.kind == "blockGroup" {
            ctx.report.repairs += 1;
            for c in node.content.unwrap_or_default() {
                norm_container(c, ctx, depth, in_column, out)?;
            }
            return Ok(());
        } else {
            ctx.report.repairs += 1;
            return Ok(());
        }
    }
    // Id.
    let id_ok = node
        .attr_str("id")
        .is_some_and(|id| is_block_id(id) && !ctx.seen.contains(id));
    if id_ok {
        if let Some(id) = node.attr_str("id") {
            ctx.seen.insert(id.to_owned());
        }
    } else {
        let id = fresh_id(ctx)?;
        node = node.with_attr("id", json!(id));
        ctx.report.regenerated_ids += 1;
    }
    let attrs = node.attrs.get_or_insert_with(Map::new);
    attrs.entry("color").or_insert(Value::Null);
    attrs.entry("bg").or_insert(Value::Null);
    attrs.entry("dir").or_insert(json!("auto"));

    let mut children = node.content.take().unwrap_or_default().into_iter();
    let Some(content) = children.next() else {
        ctx.report.repairs += 1;
        return Ok(()); // empty container: drop it
    };
    if !SCHEMA.is_block_content(&content.kind) {
        ctx.report.repairs += 1;
        return Ok(());
    }
    let mut child_containers = Vec::new();
    for extra in children {
        if extra.kind == "blockGroup" {
            child_containers.extend(extra.content.unwrap_or_default());
        } else {
            ctx.report.repairs += 1;
            child_containers.push(extra);
        }
    }
    let kids = norm_group(child_containers, ctx, depth + 1, in_column)?;

    if content.kind == "columnList" {
        let (columns, widths) = norm_columns(content, ctx, depth)?;
        if in_column || columns.len() <= 1 {
            // Forbidden nesting or a single column: unwrap into plain containers.
            ctx.report.repairs += 1;
            for col in columns {
                out.extend(col);
            }
            out.extend(kids);
            return Ok(());
        }
        let n_cols = columns.len();
        let mut list = TipTapNode::new("columnList").with_content(
            columns
                .into_iter()
                .map(|c| {
                    TipTapNode::new("column")
                        .with_content(vec![TipTapNode::new("blockGroup").with_content(c)])
                })
                .collect(),
        );
        let widths = widths.unwrap_or_else(|| vec![1.0 / n_cols as f64; n_cols]);
        list = list.with_attr("widths", json!(widths));
        node.content = Some(vec![list]);
        out.push(node);
        out.extend(kids);
        return Ok(());
    }

    let leaf = !can_have_children(&content);
    node.content = Some(vec![content]);
    if kids.is_empty() {
        out.push(node);
    } else if leaf {
        ctx.report.repairs += 1;
        out.push(node);
        out.extend(kids);
    } else {
        if let Some(c) = node.content.as_mut() {
            c.push(TipTapNode::new("blockGroup").with_content(kids));
        }
        out.push(node);
    }
    Ok(())
}

/// Normalised columns and their (still valid) widths.
type Columns = (Vec<Vec<TipTapNode>>, Option<Vec<f64>>);

/// Normalises the columns of a columnList into lists of containers (empty columns dropped, > 5 merged into the
/// last). Keeps valid widths when they still fit.
fn norm_columns(list: TipTapNode, ctx: &mut Ctx, depth: usize) -> Result<Columns> {
    let widths: Option<Vec<f64>> = list
        .attr("widths")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_f64).collect());
    let mut cols: Vec<Vec<TipTapNode>> = Vec::new();
    for col in list.content.unwrap_or_default() {
        if col.kind != "column" {
            ctx.report.repairs += 1;
            continue;
        }
        let mut items = Vec::new();
        for g in col.content.unwrap_or_default() {
            if g.kind == "blockGroup" {
                items.extend(g.content.unwrap_or_default());
            }
        }
        let normalized = norm_group(items, ctx, depth + 1, true)?;
        if normalized.is_empty() {
            ctx.report.repairs += 1;
            continue;
        }
        cols.push(normalized);
    }
    if cols.len() > MAX_COLUMNS {
        ctx.report.repairs += 1;
        let extra: Vec<TipTapNode> = cols.drain(MAX_COLUMNS..).flatten().collect();
        if let Some(last) = cols.last_mut() {
            last.extend(extra);
        }
    }
    let widths = widths.filter(|w| {
        w.len() == cols.len()
            && w.iter().all(|x| x.is_finite() && *x > 0.0)
            && (w.iter().sum::<f64>() - 1.0).abs() < 1e-6
    });
    Ok((cols, widths))
}

/// Gives every block a fresh id (duplicate, paste, template instantiation) and normalises the document.
pub fn regenerate_ids(doc: &mut TipTapDoc) -> Result<()> {
    fn clear(node: &mut TipTapNode) {
        if node.kind == "blockContainer" {
            if let Some(a) = node.attrs.as_mut() {
                a.remove("id");
            }
        }
        if let Some(c) = node.content.as_mut() {
            for n in c {
                clear(n);
            }
        }
    }
    for n in &mut doc.content {
        clear(n);
    }
    normalize(doc)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(text: &str) -> TipTapNode {
        TipTapNode::new("paragraph").with_content(vec![TipTapNode::text(text)])
    }

    fn c(id: &str, content: TipTapNode, kids: Vec<TipTapNode>) -> TipTapNode {
        let mut n = TipTapNode::new("blockContainer").with_attr("id", json!(id));
        let mut v = vec![content];
        if !kids.is_empty() {
            v.push(TipTapNode::new("blockGroup").with_content(kids));
        }
        n.content = Some(v);
        n
    }

    fn ids(doc: &TipTapDoc) -> Vec<String> {
        let mut v = Vec::new();
        crate::doc::walk::for_each_block(doc, &mut |b| v.push(b.id.to_owned()));
        v
    }

    #[test]
    fn manifest_has_every_node() {
        let m = SCHEMA.manifest_json();
        assert_eq!(m["version"], 1);
        assert_eq!(m["nodes"].as_object().unwrap().len(), 34);
        assert_eq!(m["nodes"]["image"]["attrs"][4], "pendingUrl");
        assert!(m["nodes"]["divider"].get("content").is_none());
        assert_eq!(m["marks"]["link"]["attrs"][0], "href");
    }

    #[test]
    fn duplicate_ids_are_regenerated_keeping_first() {
        let mut d = TipTapDoc::from_blocks(vec![
            c("AAAAAAAAAAAA", para("a"), vec![]),
            c("AAAAAAAAAAAA", para("b"), vec![]),
            c("bad", para("c"), vec![]),
        ]);
        let r = normalize(&mut d).unwrap();
        assert_eq!(r.regenerated_ids, 2);
        let ids = ids(&d);
        assert_eq!(ids[0], "AAAAAAAAAAAA");
        assert_ne!(ids[1], ids[0]);
        assert!(ids.iter().all(|i| is_block_id(i)));
    }

    #[test]
    fn leaf_children_are_hoisted() {
        let mut d = TipTapDoc::from_blocks(vec![c(
            "AAAAAAAAAAAA",
            TipTapNode::new("divider"),
            vec![c("BBBBBBBBBBBB", para("child"), vec![])],
        )]);
        normalize(&mut d).unwrap();
        assert_eq!(d.blocks().len(), 2);
        // Non-toggle heading is a leaf too.
        let mut d = TipTapDoc::from_blocks(vec![c(
            "AAAAAAAAAAAA",
            TipTapNode::new("heading").with_attr("level", json!(1)),
            vec![c("BBBBBBBBBBBB", para("child"), vec![])],
        )]);
        normalize(&mut d).unwrap();
        assert_eq!(d.blocks().len(), 2);
        // Toggle heading keeps children.
        let mut d = TipTapDoc::from_blocks(vec![c(
            "AAAAAAAAAAAA",
            TipTapNode::new("heading").with_attr("toggle", json!(true)),
            vec![c("BBBBBBBBBBBB", para("child"), vec![])],
        )]);
        normalize(&mut d).unwrap();
        assert_eq!(d.blocks().len(), 1);
    }

    fn columns(cols: Vec<Vec<TipTapNode>>) -> TipTapNode {
        TipTapNode::new("columnList").with_content(
            cols.into_iter()
                .map(|c| {
                    TipTapNode::new("column")
                        .with_content(vec![TipTapNode::new("blockGroup").with_content(c)])
                })
                .collect(),
        )
    }

    #[test]
    fn single_column_is_unwrapped_and_nested_columns_forbidden() {
        let mut d = TipTapDoc::from_blocks(vec![c(
            "AAAAAAAAAAAA",
            columns(vec![vec![c("BBBBBBBBBBBB", para("x"), vec![])]]),
            vec![],
        )]);
        normalize(&mut d).unwrap();
        assert_eq!(d.blocks().len(), 1);
        assert_eq!(d.blocks()[0].children()[0].kind, "paragraph");

        let inner = c(
            "CCCCCCCCCCCC",
            columns(vec![
                vec![c("DDDDDDDDDDDD", para("1"), vec![])],
                vec![c("EEEEEEEEEEEE", para("2"), vec![])],
            ]),
            vec![],
        );
        let mut d = TipTapDoc::from_blocks(vec![c(
            "AAAAAAAAAAAA",
            columns(vec![
                vec![inner],
                vec![c("FFFFFFFFFFFF", para("3"), vec![])],
            ]),
            vec![],
        )]);
        normalize(&mut d).unwrap();
        let list = &d.blocks()[0].children()[0];
        assert_eq!(list.kind, "columnList");
        let first_col = &list.children()[0].children()[0];
        assert_eq!(
            first_col.children().len(),
            2,
            "nested columns are unwrapped into the column"
        );
        assert!(
            first_col
                .children()
                .iter()
                .all(|b| b.children()[0].kind == "paragraph")
        );
        let w = list.attr("widths").unwrap().as_array().unwrap();
        assert_eq!(w.len(), 2);
    }

    #[test]
    fn empty_doc_gets_a_paragraph() {
        let mut d = TipTapDoc {
            kind: "doc".into(),
            attrs: crate::model::DocAttrs { schema_version: 1 },
            content: vec![],
        };
        normalize(&mut d).unwrap();
        assert_eq!(d.blocks().len(), 1);
    }
}
