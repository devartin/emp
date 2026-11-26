//! Traversal of D-07 documents.

use serde_json::Value;

use crate::model::{TipTapDoc, TipTapNode};

/// A visited block.
#[derive(Debug, Clone, Copy)]
pub struct BlockRef<'a> {
    /// The container's block id (empty if missing).
    pub id: &'a str,
    /// The blockContent node.
    pub content: &'a TipTapNode,
    /// The blockContainer.
    pub container: &'a TipTapNode,
    /// Nesting depth (0 at the root group).
    pub depth: usize,
}

/// Visits every block in document order (pre-order, including blocks inside columns).
pub fn for_each_block<'a>(doc: &'a TipTapDoc, f: &mut dyn FnMut(BlockRef<'a>)) {
    for g in &doc.content {
        walk_group(g, 0, f);
    }
}

fn walk_group<'a>(group: &'a TipTapNode, depth: usize, f: &mut dyn FnMut(BlockRef<'a>)) {
    for c in group.children() {
        if c.kind != "blockContainer" {
            continue;
        }
        let mut kids = c.children().iter();
        let Some(content) = kids.next() else { continue };
        f(BlockRef {
            id: c.attr_str("id").unwrap_or(""),
            content,
            container: c,
            depth,
        });
        if content.kind == "columnList" {
            for col in content.children() {
                for g in col.children() {
                    walk_group(g, depth + 1, f);
                }
            }
        }
        for g in kids {
            if g.kind == "blockGroup" {
                walk_group(g, depth + 1, f);
            }
        }
    }
}

/// Appends the plain text of inline content (`text`, `hardBreak` → newline, mentions, emoji, inline math).
pub fn push_inline_text(node: &TipTapNode, out: &mut String) {
    match node.kind.as_str() {
        "text" => out.push_str(node.text.as_deref().unwrap_or("")),
        "hardBreak" => out.push('\n'),
        "mention" => {
            if let Some(label) = node.attr_str("label") {
                out.push('@');
                out.push_str(label);
            } else if node.attr_str("kind") == Some("date")
                && let Some(start) = node
                    .attr("date")
                    .and_then(|d| d.get("start"))
                    .and_then(Value::as_str)
            {
                out.push('@');
                out.push_str(start);
            }
        }
        "emoji" => out.push_str(node.attr_str("native").unwrap_or("")),
        "mathInline" => out.push_str(node.attr_str("latex").unwrap_or("")),
        _ => {
            for c in node.children() {
                push_inline_text(c, out);
            }
        }
    }
}

/// Plain text of a node's inline content.
#[must_use]
pub fn inline_text(node: &TipTapNode) -> String {
    let mut s = String::new();
    for c in node.children() {
        push_inline_text(c, &mut s);
    }
    s
}

/// Searchable text of one blockContent (excluding children).
#[must_use]
pub fn block_text(content: &TipTapNode) -> String {
    match content.kind.as_str() {
        "table" => {
            let mut rows = Vec::new();
            for row in content.children() {
                let cells: Vec<String> = row.children().iter().map(inline_text).collect();
                rows.push(cells.join("\t"));
            }
            rows.join("\n")
        }
        "mathBlock" => content.attr_str("latex").unwrap_or("").to_owned(),
        "image" => content.attr_str("caption").unwrap_or("").to_owned(),
        "codeBlock" => {
            let mut s = inline_text(content);
            if let Some(c) = content.attr_str("caption").filter(|c| !c.is_empty()) {
                s.push('\n');
                s.push_str(c);
            }
            s
        }
        "kpi" => content.attr_str("label").unwrap_or("").to_owned(),
        _ => inline_text(content),
    }
}

/// Finds a block container by id.
#[must_use]
pub fn find_block<'a>(doc: &'a TipTapDoc, id: &str) -> Option<&'a TipTapNode> {
    let mut found = None;
    for_each_block(doc, &mut |b| {
        if found.is_none() && b.id == id {
            found = Some(b.container);
        }
    });
    found
}

/// Removes the containers with the given ids (wherever they are, children included) and returns them in document
/// order. A group left empty gets nothing special; the caller normalises afterwards.
pub fn remove_blocks(doc: &mut TipTapDoc, ids: &[String]) -> Vec<TipTapNode> {
    let mut removed = Vec::new();
    for g in &mut doc.content {
        remove_in_group(g, ids, &mut removed);
    }
    removed
}

fn remove_in_group(group: &mut TipTapNode, ids: &[String], removed: &mut Vec<TipTapNode>) {
    let Some(children) = group.content.as_mut() else {
        return;
    };
    let mut kept = Vec::with_capacity(children.len());
    for mut c in std::mem::take(children) {
        if c.attr_str("id")
            .is_some_and(|id| ids.iter().any(|x| x == id))
        {
            removed.push(c);
            continue;
        }
        if let Some(parts) = c.content.as_mut() {
            for part in parts.iter_mut() {
                if part.kind == "blockGroup" {
                    remove_in_group(part, ids, removed);
                } else if part.kind == "columnList"
                    && let Some(cols) = part.content.as_mut()
                {
                    for col in cols {
                        if let Some(gs) = col.content.as_mut() {
                            for g in gs {
                                remove_in_group(g, ids, removed);
                            }
                        }
                    }
                }
            }
            parts.retain(|p| p.kind != "blockGroup" || !p.children().is_empty());
        }
        kept.push(c);
    }
    *children = kept;
}

/// Replaces the first container with id `at` by `replacement` (used by turn-into-page).
pub fn replace_block(doc: &mut TipTapDoc, at: &str, replacement: TipTapNode) -> bool {
    let mut slot = Some(replacement);
    for g in &mut doc.content {
        if replace_in(g, at, &mut slot) {
            return true;
        }
    }
    false
}

fn replace_in(node: &mut TipTapNode, at: &str, slot: &mut Option<TipTapNode>) -> bool {
    let Some(children) = node.content.as_mut() else {
        return false;
    };
    for c in children.iter_mut() {
        if c.kind == "blockContainer"
            && c.attr_str("id") == Some(at)
            && let Some(r) = slot.take()
        {
            *c = r;
            return true;
        }
        if replace_in(c, at, slot) {
            return true;
        }
    }
    false
}

/// Inserts `node` immediately before the container with id `before` (anywhere in the tree).
pub fn insert_before(doc: &mut TipTapDoc, before: &str, node: TipTapNode) -> bool {
    let mut slot = Some(node);
    for g in &mut doc.content {
        if insert_in(g, before, &mut slot) {
            return true;
        }
    }
    false
}

fn insert_in(node: &mut TipTapNode, before: &str, slot: &mut Option<TipTapNode>) -> bool {
    let Some(children) = node.content.as_mut() else {
        return false;
    };
    if let Some(pos) = children
        .iter()
        .position(|c| c.kind == "blockContainer" && c.attr_str("id") == Some(before))
        && let Some(n) = slot.take()
    {
        children.insert(pos, n);
        return true;
    }
    children.iter_mut().any(|c| insert_in(c, before, slot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::schema::container;

    #[test]
    fn walks_nested_and_columns() {
        let child = container(
            TipTapNode::new("paragraph").with_content(vec![TipTapNode::text("child")]),
            None,
        )
        .unwrap();
        let parent = container(
            TipTapNode::new("bulletItem").with_content(vec![TipTapNode::text("parent")]),
            Some(vec![child]),
        )
        .unwrap();
        let doc = TipTapDoc::from_blocks(vec![parent]);
        let mut seen = Vec::new();
        for_each_block(&doc, &mut |b| seen.push((block_text(b.content), b.depth)));
        assert_eq!(seen, vec![("parent".into(), 0), ("child".into(), 1)]);
    }

    #[test]
    fn remove_and_replace() {
        let a = container(TipTapNode::new("paragraph"), None).unwrap();
        let b = container(TipTapNode::new("paragraph"), None).unwrap();
        let bid = b.attr_str("id").unwrap().to_owned();
        let aid = a.attr_str("id").unwrap().to_owned();
        let mut doc = TipTapDoc::from_blocks(vec![a, b]);
        let removed = remove_blocks(&mut doc, &[bid]);
        assert_eq!(removed.len(), 1);
        assert_eq!(doc.blocks().len(), 1);
        let r = container(TipTapNode::new("divider"), None).unwrap();
        assert!(replace_block(&mut doc, &aid, r));
        assert_eq!(doc.blocks()[0].children()[0].kind, "divider");
    }
}
