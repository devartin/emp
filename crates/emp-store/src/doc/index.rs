//! Document indexing (SPEC §7.10): per-block text, outline, outgoing links with snippets, referenced assets, and the
//! in-memory backlink index `outgoing: Map<pageId, Set<{targetPageId, blockId}>>` kept up to date on save.

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use super::parse_internal_href;
use super::walk::{BlockRef, block_text, for_each_block};
use crate::model::{OutlineItem, TipTapDoc, TipTapNode};

/// Characters of context on each side of a link in a backlink snippet.
pub const SNIPPET_CONTEXT: usize = 60;

/// Text of one block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockInfo {
    /// Block id.
    pub id: String,
    /// blockContent type.
    pub kind: String,
    /// Plain text.
    pub text: String,
}

/// One outgoing link.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct OutLink {
    /// Target page.
    pub target: String,
    /// Block holding the link.
    pub block_id: Option<String>,
    /// ±60 characters of the block text around the link.
    pub snippet: String,
}

/// Everything extracted from one document.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocExtract {
    /// Blocks with text, in document order.
    pub blocks: Vec<BlockInfo>,
    /// Outgoing page links (mentions, `pageLink`, `pageRef`, internal links).
    pub links: Vec<OutLink>,
    /// Headings.
    pub outline: Vec<OutlineItem>,
    /// Referenced asset ids (images, files, asset icons are not included).
    pub assets: Vec<String>,
    /// Total characters of text.
    pub text_chars: usize,
}

impl DocExtract {
    /// All block text joined by newlines.
    #[must_use]
    pub fn full_text(&self) -> String {
        let mut s = String::new();
        for b in &self.blocks {
            if !s.is_empty() {
                s.push('\n');
            }
            s.push_str(&b.text);
        }
        s
    }
}

fn snippet_around(text: &str, char_pos: usize, char_len: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = char_pos.saturating_sub(SNIPPET_CONTEXT);
    let end = (char_pos + char_len + SNIPPET_CONTEXT).min(chars.len());
    let mut s: String = chars
        .get(start..end)
        .map(|c| c.iter().collect())
        .unwrap_or_default();
    s = s.replace('\n', " ");
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(s.trim());
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Inline walk that also records internal-link positions (in chars).
fn inline_with_links(
    node: &TipTapNode,
    text: &mut String,
    links: &mut Vec<(String, usize, usize)>,
) {
    for c in node.children() {
        let pos = text.chars().count();
        match c.kind.as_str() {
            "mention" if c.attr_str("kind") == Some("page") || c.attr_str("pageId").is_some() => {
                let before = text.chars().count();
                super::walk::push_inline_text(c, text);
                if let Some(id) = c.attr_str("pageId") {
                    links.push((id.to_owned(), before, text.chars().count() - before));
                }
            }
            "text" => {
                let t = c.text.as_deref().unwrap_or("");
                text.push_str(t);
                if let Some(marks) = &c.marks {
                    for m in marks {
                        if m.kind == "link" {
                            let href = m
                                .attrs
                                .as_ref()
                                .and_then(|a| a.get("href"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if let Some((id, _)) = parse_internal_href(href) {
                                links.push((id, pos, t.chars().count()));
                            }
                        }
                    }
                }
            }
            _ => super::walk::push_inline_text(c, text),
        }
    }
}

/// Extracts text, outline, links and assets from a document.
#[must_use]
pub fn extract(doc: &TipTapDoc) -> DocExtract {
    let mut out = DocExtract::default();
    let mut raw_links: Vec<OutLink> = Vec::new();
    for_each_block(doc, &mut |b: BlockRef<'_>| {
        let content = b.content;
        let block_id = Some(b.id.to_owned()).filter(|s| !s.is_empty());
        let text;
        match content.kind.as_str() {
            "table" => {
                text = block_text(content);
                for row in content.children() {
                    for cell in row.children() {
                        let mut t = String::new();
                        let mut l = Vec::new();
                        inline_with_links(cell, &mut t, &mut l);
                        for (target, pos, len) in l {
                            raw_links.push(OutLink {
                                target,
                                block_id: block_id.clone(),
                                snippet: snippet_around(&t, pos, len),
                            });
                        }
                    }
                }
            }
            "pageLink" | "pageRef" => {
                text = String::new();
                if let Some(id) = content.attr_str("pageId") {
                    raw_links.push(OutLink {
                        target: id.to_owned(),
                        block_id: block_id.clone(),
                        snippet: String::new(),
                    });
                }
            }
            "image" | "file" => {
                text = block_text(content);
                if let Some(a) = content.attr_str("assetId") {
                    out.assets.push(a.to_owned());
                }
            }
            "mathBlock" | "codeBlock" | "kpi" | "columnList" | "column" => {
                text = block_text(content);
            }
            _ => {
                let mut t = String::new();
                let mut l = Vec::new();
                inline_with_links(content, &mut t, &mut l);
                for (target, pos, len) in l {
                    raw_links.push(OutLink {
                        target,
                        block_id: block_id.clone(),
                        snippet: snippet_around(&t, pos, len),
                    });
                }
                text = t;
            }
        }
        if content.kind == "heading" {
            let level = content
                .attr("level")
                .and_then(Value::as_u64)
                .and_then(|l| u8::try_from(l).ok())
                .filter(|l| (1..=3).contains(l))
                .unwrap_or(1);
            if let Some(id) = &block_id {
                out.outline.push(OutlineItem {
                    block_id: id.clone(),
                    level,
                    text: text.clone(),
                });
            }
        }
        out.text_chars += text.chars().count();
        if !text.is_empty() {
            out.blocks.push(BlockInfo {
                id: b.id.to_owned(),
                kind: content.kind.clone(),
                text,
            });
        }
    });
    // Unique by (target, block).
    raw_links.sort();
    raw_links.dedup_by(|a, b| a.target == b.target && a.block_id == b.block_id);
    out.links = raw_links;
    out.assets.sort();
    out.assets.dedup();
    out
}

/// Approximate number of characters changed between two texts (common prefix/suffix trimmed).
#[must_use]
pub fn changed_chars(old: &str, new: &str) -> usize {
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let a_rest = &a[prefix..];
    let b_rest = &b[prefix..];
    let suffix = a_rest
        .iter()
        .rev()
        .zip(b_rest.iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    (a_rest.len() - suffix).max(b_rest.len() - suffix)
}

/// The backlink index.
#[derive(Debug, Default, Clone)]
pub struct LinkIndex {
    outgoing: HashMap<String, Vec<OutLink>>,
    incoming: HashMap<String, BTreeSet<String>>,
}

impl LinkIndex {
    /// Replaces the outgoing links of `source`.
    pub fn set(&mut self, source: &str, links: Vec<OutLink>) {
        self.remove(source);
        for l in &links {
            if l.target != source {
                self.incoming
                    .entry(l.target.clone())
                    .or_default()
                    .insert(source.to_owned());
            }
        }
        let links: Vec<OutLink> = links.into_iter().filter(|l| l.target != source).collect();
        if !links.is_empty() {
            self.outgoing.insert(source.to_owned(), links);
        }
    }

    /// Forgets `source`'s outgoing links.
    pub fn remove(&mut self, source: &str) {
        if let Some(old) = self.outgoing.remove(source) {
            for l in old {
                if let Some(set) = self.incoming.get_mut(&l.target) {
                    set.remove(source);
                    if set.is_empty() {
                        self.incoming.remove(&l.target);
                    }
                }
            }
        }
    }

    /// Links pointing at `target`: `(source, link)` pairs, sources in id order.
    #[must_use]
    pub fn backlinks(&self, target: &str) -> Vec<(String, OutLink)> {
        let mut out = Vec::new();
        if let Some(sources) = self.incoming.get(target) {
            for s in sources {
                if let Some(links) = self.outgoing.get(s) {
                    for l in links.iter().filter(|l| l.target == target) {
                        out.push((s.clone(), l.clone()));
                    }
                }
            }
        }
        out
    }

    /// Outgoing links of `source`.
    #[must_use]
    pub fn outgoing(&self, source: &str) -> &[OutLink] {
        self.outgoing.get(source).map_or(&[], Vec::as_slice)
    }

    /// Number of sources indexed.
    #[must_use]
    pub fn len(&self) -> usize {
        self.outgoing.len()
    }

    /// `true` if empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.outgoing.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::schema::container;
    use crate::model::TipTapMark;
    use serde_json::json;

    fn mention(id: &str) -> TipTapNode {
        TipTapNode::new("mention")
            .with_attr("kind", json!("page"))
            .with_attr("pageId", json!(id))
    }

    fn doc_with_links() -> TipTapDoc {
        let p = TipTapNode::new("paragraph").with_content(vec![
            TipTapNode::text("See the notes in "),
            mention("target-1"),
            TipTapNode::text(" for details."),
        ]);
        let mut link = TipTapNode::text("other page");
        link.marks = Some(vec![TipTapMark {
            kind: "link".into(),
            attrs: Some(
                serde_json::from_value(json!({"href": "emp://page/target-2#blk"})).unwrap(),
            ),
        }]);
        let p2 = TipTapNode::new("paragraph").with_content(vec![TipTapNode::text("Go to "), link]);
        let h = TipTapNode::new("heading")
            .with_attr("level", json!(2))
            .with_content(vec![TipTapNode::text("Intro")]);
        let pl = TipTapNode::new("pageLink").with_attr("pageId", json!("target-3"));
        let img = TipTapNode::new("image").with_attr("assetId", json!("a".repeat(32)));
        TipTapDoc::from_blocks(
            [h, p, p2, pl, img]
                .into_iter()
                .map(|n| container(n, None).unwrap())
                .collect(),
        )
    }

    #[test]
    fn column_blocks_are_indexed_separately_not_glued() {
        let para = |t: &str| {
            container(
                TipTapNode::new("paragraph").with_content(vec![TipTapNode::text(t)]),
                None,
            )
            .unwrap()
        };
        let col = |b: TipTapNode| {
            TipTapNode::new("column")
                .with_content(vec![TipTapNode::new("blockGroup").with_content(vec![b])])
        };
        let list = TipTapNode::new("columnList").with_content(vec![
            col(para("Money HQ — budget and net worth.")),
            col(para("Portfolio — holdings.")),
        ]);
        let doc = TipTapDoc::from_blocks(vec![container(list, None).unwrap()]);
        let x = extract(&doc);
        let texts: Vec<&str> = x.blocks.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(
            texts,
            vec!["Money HQ — budget and net worth.", "Portfolio — holdings."]
        );
        assert!(!x.full_text().contains("worth.Portfolio"));
        let mut cell = TipTapNode::new("tableCell");
        cell.content = Some(vec![
            TipTapNode::new("paragraph").with_content(vec![TipTapNode::text("one.")]),
            TipTapNode::new("paragraph").with_content(vec![TipTapNode::text("Two")]),
        ]);
        assert_eq!(super::super::walk::cell_text(&cell), "one. Two");
    }

    #[test]
    fn extracts_text_links_outline_assets() {
        let x = extract(&doc_with_links());
        assert_eq!(x.outline.len(), 1);
        assert_eq!(x.outline[0].level, 2);
        assert_eq!(x.outline[0].text, "Intro");
        let targets: Vec<&str> = x.links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, vec!["target-1", "target-2", "target-3"]);
        assert!(x.links[0].snippet.contains("See the notes in"));
        assert!(x.links[0].snippet.contains("for details."));
        assert_eq!(x.assets.len(), 1);
        assert!(x.full_text().contains("Go to other page"));
    }

    #[test]
    fn link_index_tracks_incoming() {
        let mut idx = LinkIndex::default();
        idx.set("src", extract(&doc_with_links()).links);
        assert_eq!(idx.backlinks("target-1").len(), 1);
        assert_eq!(idx.backlinks("target-1")[0].0, "src");
        idx.set("src", vec![]);
        assert!(idx.backlinks("target-1").is_empty());
        assert!(idx.is_empty());
    }

    #[test]
    fn snippet_is_bounded() {
        let long = "x".repeat(500);
        let s = snippet_around(&long, 250, 3);
        assert!(s.chars().count() <= 2 * SNIPPET_CONTEXT + 3 + 2);
        assert!(s.starts_with('…') && s.ends_with('…'));
    }

    #[test]
    fn changed_chars_counts_edits() {
        assert_eq!(changed_chars("hello world", "hello world"), 0);
        assert_eq!(changed_chars("hello world", "hello brave world"), 6);
        assert_eq!(changed_chars("abc", ""), 3);
    }
}
