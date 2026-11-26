//! A small, tolerant HTML → TipTap converter for Notion HTML exports (SPEC §17.4 "Prefer HTML when present").
//!
//! The tokenizer understands tags, attributes, comments, the basic character references and raw-text elements;
//! `<script>`, `<style>`, `<head>`, forms and frames are dropped, and nothing is ever executed or fetched. Mapping:
//! `<details>` → toggle, `<aside>` / `figure.callout` → callout with its emoji, `.column-list` → columns,
//! `block-color-*` / `highlight-*` classes → block / text colours, `figure.equation` → math, to-do lists, code
//! blocks with language, tables, images (through the resolver) and links (relative `.html` / `.md` links become
//! page mentions).

use serde_json::{Map, Value, json};

use super::markdown::{Resolve, percent_decode};
use crate::doc::schema::{container, normalize};
use crate::model::{TipTapDoc, TipTapMark, TipTapNode};
use crate::{Result, StoreError};

/// Maximum HTML input (bytes).
pub const MAX_HTML_BYTES: usize = 32 * 1024 * 1024;
const MAX_DEPTH: usize = 48;

#[derive(Debug, Clone, PartialEq)]
enum Node {
    El {
        name: String,
        attrs: Vec<(String, String)>,
        kids: Vec<Node>,
    },
    Text(String),
}

impl Node {
    fn attr(&self, k: &str) -> Option<&str> {
        match self {
            Node::El { attrs, .. } => attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str()),
            Node::Text(_) => None,
        }
    }
    fn has_class(&self, c: &str) -> bool {
        self.attr("class")
            .is_some_and(|cl| cl.split_whitespace().any(|x| x == c))
    }
    fn classes(&self) -> Vec<&str> {
        self.attr("class")
            .map(|c| c.split_whitespace().collect())
            .unwrap_or_default()
    }
    fn name(&self) -> &str {
        match self {
            Node::El { name, .. } => name,
            Node::Text(_) => "#text",
        }
    }
    fn kids(&self) -> &[Node] {
        match self {
            Node::El { kids, .. } => kids,
            Node::Text(_) => &[],
        }
    }
    fn text(&self) -> String {
        match self {
            Node::Text(t) => t.clone(),
            Node::El { kids, .. } => kids.iter().map(Node::text).collect(),
        }
    }
    fn find(&self, pred: &dyn Fn(&Node) -> bool) -> Option<&Node> {
        if pred(self) {
            return Some(self);
        }
        self.kids().iter().find_map(|k| k.find(pred))
    }
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];
const DROP: &[&str] = &[
    "script", "style", "head", "noscript", "template", "iframe", "object", "form", "button",
    "select", "textarea", "svg",
];

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest
            .char_indices()
            .take(12)
            .find(|(_, c)| *c == ';')
            .map(|(j, _)| j);
        let Some(end) = end else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            e if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16)
                .ok()
                .and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        if start == i {
            break;
        }
        let name = s[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut val = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                val = decode_entities(&s[vs..i.min(b.len())]);
                i += 1;
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                val = decode_entities(&s[vs..i]);
            }
        }
        if out.len() < 64 {
            out.push((name, val));
        }
    }
    out
}

/// Parses HTML into a forgiving tree.
/// Byte offset of the first ASCII-case-insensitive occurrence of `needle` (ASCII) in `hay`.
fn find_ascii_ci(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    let first = *n.first()?;
    let mut from = 0;
    while let Some(off) = h
        .get(from..)?
        .iter()
        .position(|b| b.eq_ignore_ascii_case(&first))
    {
        let at = from + off;
        if h.get(at..at + n.len())
            .is_some_and(|w| w.eq_ignore_ascii_case(n))
        {
            return Some(at);
        }
        from = at + 1;
    }
    None
}

fn parse(html: &str) -> Node {
    let mut stack: Vec<Node> = vec![Node::El {
        name: "#root".into(),
        attrs: Vec::new(),
        kids: Vec::new(),
    }];
    let mut rest = html;
    let push = |stack: &mut Vec<Node>, n: Node| {
        if let Some(Node::El { kids, .. }) = stack.last_mut() {
            kids.push(n);
        }
    };
    let close = |stack: &mut Vec<Node>, name: &str| {
        if let Some(pos) = stack.iter().rposition(|n| n.name() == name) {
            if pos == 0 {
                return;
            }
            while stack.len() > pos {
                let n = stack.pop().unwrap_or(Node::Text(String::new()));
                push(stack, n);
            }
        }
    };
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            push(&mut stack, Node::Text(decode_entities(rest)));
            break;
        };
        if lt > 0 {
            push(&mut stack, Node::Text(decode_entities(&rest[..lt])));
        }
        rest = &rest[lt..];
        if let Some(r) = rest.strip_prefix("<!--") {
            rest = r.find("-->").map_or("", |e| &r[e + 3..]);
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            rest = rest.find('>').map_or("", |e| &rest[e + 1..]);
            continue;
        }
        let Some(gt) = rest.find('>') else {
            push(&mut stack, Node::Text(decode_entities(rest)));
            break;
        };
        let inner = &rest[1..gt];
        rest = &rest[gt + 1..];
        if let Some(name) = inner.strip_prefix('/') {
            let name = name.trim().to_ascii_lowercase();
            close(&mut stack, &name);
            continue;
        }
        let (name, attrs) = match inner.find(|c: char| c.is_ascii_whitespace() || c == '/') {
            Some(i) => (inner[..i].to_ascii_lowercase(), &inner[i..]),
            None => (inner.to_ascii_lowercase(), ""),
        };
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            push(&mut stack, Node::Text(format!("<{inner}>")));
            continue;
        }
        if DROP.contains(&name.as_str()) {
            // Skip to the matching close tag. The search is case-insensitive without copying the
            // rest of the document, which made many dropped elements quadratic.
            let end = format!("</{name}");
            rest = find_ascii_ci(rest, &end).map_or("", |e| {
                let after = &rest[e..];
                after.find('>').map_or("", |g| &after[g + 1..])
            });
            continue;
        }
        let node = Node::El {
            name: name.clone(),
            attrs: parse_attrs(attrs),
            kids: Vec::new(),
        };
        if VOID.contains(&name.as_str()) || inner.ends_with('/') {
            push(&mut stack, node);
        } else if stack.len() < MAX_DEPTH {
            // `<p>` and `<li>` close an open element of the same kind.
            if matches!(name.as_str(), "p" | "li") && stack.last().is_some_and(|n| n.name() == name)
            {
                close(&mut stack, &name);
            }
            stack.push(node);
        }
    }
    while stack.len() > 1 {
        let n = stack.pop().unwrap_or(Node::Text(String::new()));
        push(&mut stack, n);
    }
    stack.pop().unwrap_or(Node::Text(String::new()))
}

/// Placeholder for an inline image inside a text run (dropped again by `lift_images`; never stored).
const IMAGE_MARKER: &str = "\u{FFFC}";

/// Conversion result.
#[derive(Clone, Debug, PartialEq)]
pub struct HtmlResult {
    /// The document.
    pub doc: TipTapDoc,
    /// `h1.page-title`.
    pub title: Option<String>,
    /// The page icon (`.page-header-icon`), mapped from Notion's emoji to a Lucide icon; `None` when absent or
    /// unmapped.
    pub icon: Option<crate::model::Icon>,
    /// Rows of `table.properties` (`name → value text`).
    pub properties: Vec<(String, String)>,
    /// Unresolved links.
    pub unresolved: Vec<String>,
    /// Elements converted approximately (embeds, synced blocks, …).
    pub unsupported: Vec<String>,
}

struct Conv<'r> {
    r: &'r mut dyn Resolve,
    unresolved: Vec<String>,
    unsupported: Vec<String>,
}

const BLOCKS: &[&str] = &[
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "details",
    "blockquote",
    "figure",
    "aside",
    "pre",
    "hr",
    "table",
    "div",
    "article",
    "section",
    "header",
    "body",
    "html",
    "#root",
    "main",
    "nav",
    "footer",
    "img",
];

fn color_attr(n: &Node) -> Option<(bool, String)> {
    n.classes().into_iter().find_map(|c| {
        let c = c.strip_prefix("block-color-")?;
        Some(match c.strip_suffix("_background") {
            Some(base) => (true, base.to_owned()),
            None => (false, c.to_owned()),
        })
    })
}

fn color_mark(c: &str) -> Option<TipTapMark> {
    let c = c.strip_prefix("highlight-")?;
    let (kind, color) = match c.strip_suffix("_background") {
        Some(b) => ("highlight", b),
        None => ("textColor", c),
    };
    Some(TipTapMark {
        kind: kind.into(),
        attrs: Some(Map::from_iter([("color".to_owned(), json!(color))])),
    })
}

impl Conv<'_> {
    fn inline(&mut self, n: &Node, marks: &[TipTapMark], out: &mut Vec<TipTapNode>) {
        match n {
            Node::Text(t) => {
                let t = t.replace(['\n', '\r', '\t'], " ");
                if !t.is_empty() {
                    let mut tn = TipTapNode::text(&t);
                    if !marks.is_empty() {
                        tn.marks = Some(marks.to_vec());
                    }
                    out.push(tn);
                }
            }
            Node::El { name, .. } => {
                let mut m = marks.to_vec();
                let add = |m: &mut Vec<TipTapMark>, k: &str| {
                    m.push(TipTapMark {
                        kind: k.into(),
                        attrs: None,
                    })
                };
                match name.as_str() {
                    "br" => {
                        out.push(TipTapNode::new("hardBreak"));
                        return;
                    }
                    "strong" | "b" => add(&mut m, "bold"),
                    "em" | "i" => add(&mut m, "italic"),
                    "u" => add(&mut m, "underline"),
                    "s" | "del" | "strike" => add(&mut m, "strike"),
                    "code" => add(&mut m, "code"),
                    "mark" => add(&mut m, "highlight"),
                    "img" => {
                        if let Some(src) = n.attr("src") {
                            let src = percent_decode(src);
                            if let Some(a) = self.r.asset(&src) {
                                // Inline images become their own block later; keep a marker text.
                                out.push(
                                    TipTapNode::new("emoji")
                                        .with_attr("native", json!(IMAGE_MARKER))
                                        .with_attr("shortcode", json!(a)),
                                );
                            }
                        }
                        return;
                    }
                    "a" => {
                        let href = n.attr("href").unwrap_or_default().to_owned();
                        let dec = percent_decode(&href);
                        let local = !href.contains("://")
                            && !href.starts_with("mailto:")
                            && !href.starts_with('#')
                            && !href.is_empty();
                        if local {
                            let target = dec.split('#').next().unwrap_or_default().to_owned();
                            match self.r.page(&target) {
                                Some(id) => {
                                    out.push(
                                        TipTapNode::new("mention")
                                            .with_attr("kind", json!("page"))
                                            .with_attr("pageId", json!(id)),
                                    );
                                    return;
                                }
                                None => self.unresolved.push(target),
                            }
                        } else if crate::query::cells::url_allowed(&href) {
                            m.push(TipTapMark {
                                kind: "link".into(),
                                attrs: Some(Map::from_iter([("href".to_owned(), json!(href))])),
                            });
                        }
                    }
                    "span" => {
                        if n.has_class("notion-text-equation-token") || n.has_class("katex") {
                            if let Some(tex) = n.find(&|x| x.name() == "annotation") {
                                out.push(
                                    TipTapNode::new("mathInline")
                                        .with_attr("latex", json!(tex.text().trim())),
                                );
                            }
                            return;
                        }
                        for c in n.classes() {
                            if let Some(cm) = color_mark(c) {
                                m.push(cm);
                            }
                        }
                    }
                    _ => {}
                }
                for k in n.kids() {
                    self.inline(k, &m, out);
                }
            }
        }
    }

    fn inline_of(&mut self, n: &Node) -> Vec<TipTapNode> {
        let mut out = Vec::new();
        for k in n.kids() {
            self.inline(k, &[], &mut out);
        }
        trim_inline(&mut out);
        lift_images(out)
    }

    fn colored(&self, mut c: TipTapNode, n: &Node) -> TipTapNode {
        if let Some((bg, color)) = color_attr(n)
            && let Some(a) = c.attrs.as_mut()
        {
            a.insert(if bg { "bg" } else { "color" }.into(), json!(color));
        }
        c
    }

    /// Converts the children of `n` to block containers (inline runs become paragraphs).
    fn blocks_of(&mut self, n: &Node, depth: usize) -> Result<Vec<TipTapNode>> {
        let mut out = Vec::new();
        let mut run: Vec<TipTapNode> = Vec::new();
        for k in n.kids() {
            let is_block = matches!(k, Node::El { name, .. } if BLOCKS.contains(&name.as_str()));
            if is_block {
                flush_run(&mut run, &mut out)?;
                out.extend(self.block(k, depth + 1)?);
            } else {
                self.inline(k, &[], &mut run);
            }
        }
        flush_run(&mut run, &mut out)?;
        Ok(out)
    }

    fn block(&mut self, n: &Node, depth: usize) -> Result<Vec<TipTapNode>> {
        if depth > MAX_DEPTH {
            let t = n.text();
            return Ok(vec![container(
                TipTapNode::new("paragraph").with_content(vec![TipTapNode::text(&t)]),
                None,
            )?]);
        }
        let name = n.name();
        let one = |c: TipTapNode| Ok(vec![c]);
        match name {
            "header" => {
                // Title and properties are read separately; keep the description.
                let mut out = Vec::new();
                for k in n.kids() {
                    if k.has_class("page-title") || k.has_class("properties") || k.name() == "table"
                    {
                        continue;
                    }
                    if k.has_class("page-description") && k.text().trim().is_empty() {
                        continue;
                    }
                    out.extend(self.block(k, depth + 1)?);
                }
                Ok(out)
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = match name {
                    "h1" => 1,
                    "h2" => 2,
                    _ => 3,
                };
                let inl = self.inline_of(n);
                let c = container(
                    TipTapNode::new("heading")
                        .with_attr("level", json!(level))
                        .with_content(inl),
                    None,
                )?;
                one(self.colored(c, n))
            }
            "p" => {
                let inl = self.inline_of(n);
                if inl.is_empty() {
                    return Ok(Vec::new());
                }
                let c = container(TipTapNode::new("paragraph").with_content(inl), None)?;
                one(self.colored(c, n))
            }
            "hr" => one(container(TipTapNode::new("divider"), None)?),
            "pre" => {
                let code = n.find(&|x| x.name() == "code");
                let lang = code
                    .and_then(|c| {
                        c.classes()
                            .into_iter()
                            .find_map(|x| x.strip_prefix("language-").map(str::to_owned))
                    })
                    .map(|l| l.to_ascii_lowercase().replace(' ', "-"));
                let body = n.text();
                let mut cb = TipTapNode::new("codeBlock")
                    .with_attr("language", lang.map_or(Value::Null, |l| json!(l)));
                if !body.is_empty() {
                    cb = cb.with_content(vec![TipTapNode::text(&body)]);
                }
                one(container(cb, None)?)
            }
            "ul" | "ol" => {
                let todo = n.has_class("to-do-list");
                let mut out = Vec::new();
                for (i, li) in n.kids().iter().filter(|k| k.name() == "li").enumerate() {
                    let mut inline_parent = Node::El {
                        name: "x".into(),
                        attrs: Vec::new(),
                        kids: Vec::new(),
                    };
                    let mut nested = Vec::new();
                    let mut checked = false;
                    if let Node::El { kids, .. } = &mut inline_parent {
                        for k in li.kids() {
                            if matches!(
                                k.name(),
                                "ul" | "ol"
                                    | "details"
                                    | "figure"
                                    | "pre"
                                    | "blockquote"
                                    | "p"
                                    | "div"
                            ) && !k.has_class("checkbox")
                                && !(todo && k.name() == "div")
                            {
                                if k.name() == "p" && kids.is_empty() {
                                    kids.extend(k.kids().iter().cloned());
                                } else {
                                    nested.extend(self.block(k, depth + 1)?);
                                }
                            } else if k.has_class("checkbox") {
                                checked = k.has_class("checkbox-on");
                            } else {
                                kids.push(k.clone());
                            }
                        }
                    }
                    let inl = self.inline_of(&inline_parent);
                    let content = if todo {
                        TipTapNode::new("todoItem").with_attr("checked", json!(checked))
                    } else if name == "ol" {
                        let start = n
                            .attr("start")
                            .and_then(|s| s.parse::<u64>().ok())
                            .unwrap_or(1)
                            + i as u64;
                        TipTapNode::new("numberedItem").with_attr("start", json!(start))
                    } else {
                        TipTapNode::new("bulletItem")
                    };
                    let c = container(content.with_content(inl), Some(nested))?;
                    out.push(self.colored(c, li));
                }
                Ok(out)
            }
            "details" => {
                let summary = n.kids().iter().find(|k| k.name() == "summary");
                let inl = summary.map(|s| self.inline_of(s)).unwrap_or_default();
                let rest = Node::El {
                    name: "div".into(),
                    attrs: Vec::new(),
                    kids: n
                        .kids()
                        .iter()
                        .filter(|k| k.name() != "summary")
                        .cloned()
                        .collect(),
                };
                let kids = self.blocks_of(&rest, depth)?;
                one(container(
                    TipTapNode::new("toggle")
                        .with_attr("collapsed", json!(true))
                        .with_content(inl),
                    Some(kids),
                )?)
            }
            "blockquote" => {
                let kids = self.blocks_of(n, depth)?;
                let (first, rest) = split_first_paragraph(kids);
                one(container(
                    TipTapNode::new("quote").with_content(first),
                    Some(rest),
                )?)
            }
            "aside" => self.callout(n, depth),
            "figure" => {
                if n.has_class("callout") {
                    return self.callout(n, depth);
                }
                if n.has_class("equation") {
                    let tex = n
                        .find(&|x| x.name() == "annotation")
                        .map(Node::text)
                        .unwrap_or_else(|| n.text());
                    return one(container(
                        TipTapNode::new("mathBlock").with_attr("latex", json!(tex.trim())),
                        None,
                    )?);
                }
                if let Some(img) = n.find(&|x| x.name() == "img") {
                    return self.block(img, depth + 1);
                }
                if (n.has_class("bookmark") || n.has_class("embed") || n.has_class("link-to-page"))
                    && let Some(a) = n.find(&|x| x.name() == "a")
                {
                    let mut inl = Vec::new();
                    self.inline(a, &[], &mut inl);
                    if inl.is_empty() {
                        inl.push(TipTapNode::text(a.attr("href").unwrap_or_default()));
                    }
                    if n.has_class("embed") {
                        self.unsupported.push("embed".into());
                    }
                    return one(container(
                        TipTapNode::new("paragraph").with_content(inl),
                        None,
                    )?);
                }
                self.blocks_of(n, depth)
            }
            "img" => {
                let src = percent_decode(n.attr("src").unwrap_or_default());
                if src.starts_with("http://") || src.starts_with("https://") {
                    return one(container(
                        TipTapNode::new("image").with_attr("pendingUrl", json!(src)),
                        None,
                    )?);
                }
                match self.r.asset(&src) {
                    Some(a) => one(container(
                        TipTapNode::new("image").with_attr("assetId", json!(a)),
                        None,
                    )?),
                    None => {
                        self.unresolved.push(src);
                        Ok(Vec::new())
                    }
                }
            }
            "table" => {
                let mut rows = Vec::new();
                let collect = |row: &Node, rows: &mut Vec<TipTapNode>, me: &mut Self| {
                    let cells: Vec<TipTapNode> = row
                        .kids()
                        .iter()
                        .filter(|c| matches!(c.name(), "td" | "th"))
                        .map(|c| TipTapNode::new("tableCell").with_content(me.inline_of(c)))
                        .collect();
                    if !cells.is_empty() {
                        rows.push(TipTapNode::new("tableRow").with_content(cells));
                    }
                };
                for k in n.kids() {
                    match k.name() {
                        "tr" => collect(k, &mut rows, self),
                        "thead" | "tbody" | "tfoot" => {
                            for r in k.kids().iter().filter(|r| r.name() == "tr") {
                                collect(r, &mut rows, self);
                            }
                        }
                        _ => {}
                    }
                }
                if rows.is_empty() {
                    return Ok(Vec::new());
                }
                let width = rows.iter().map(|r| r.children().len()).max().unwrap_or(1);
                for r in &mut rows {
                    if let Some(c) = r.content.as_mut() {
                        while c.len() < width {
                            c.push(TipTapNode::new("tableCell"));
                        }
                    }
                }
                one(container(
                    TipTapNode::new("table")
                        .with_attr("headerRow", json!(n.find(&|x| x.name() == "th").is_some()))
                        .with_content(rows),
                    None,
                )?)
            }
            "div" if n.has_class("column-list") => {
                let cols: Vec<&Node> = n.kids().iter().filter(|k| k.has_class("column")).collect();
                if cols.len() < 2 {
                    return self.blocks_of(n, depth);
                }
                let cols = &cols[..cols.len().min(5)];
                let w = 1.0 / cols.len() as f64;
                let mut columns = Vec::new();
                for c in cols {
                    let mut b = self.blocks_of(c, depth)?;
                    if b.is_empty() {
                        b.push(container(TipTapNode::new("paragraph"), None)?);
                    }
                    columns.push(
                        TipTapNode::new("column")
                            .with_content(vec![TipTapNode::new("blockGroup").with_content(b)]),
                    );
                }
                one(container(
                    TipTapNode::new("columnList")
                        .with_attr("widths", json!(vec![w; cols.len()]))
                        .with_content(columns),
                    None,
                )?)
            }
            _ => {
                if n.has_class("synced-block") || n.has_class("synced_block") {
                    self.unsupported.push("synced block (copied)".into());
                }
                self.blocks_of(n, depth)
            }
        }
    }

    fn callout(&mut self, n: &Node, depth: usize) -> Result<Vec<TipTapNode>> {
        // Notion's callout emoji maps to its Lucide icon; unmapped or absent → `lightbulb`, so a generated callout
        // always carries a Lucide icon (as in the mock's importer and `lifeapps/content.rs`).
        let icon = n
            .find(&|x| x.has_class("icon"))
            .map(|x| x.text().trim().to_owned())
            .and_then(|t| crate::icons::callout_attr_for_emoji(&t))
            .unwrap_or_else(|| crate::icons::lucide_attr(crate::icons::CALLOUT_FALLBACK));
        let body = Node::El {
            name: "div".into(),
            attrs: Vec::new(),
            kids: n
                .kids()
                .iter()
                .filter(|k| k.find(&|x| x.has_class("icon")).is_none())
                .cloned()
                .collect(),
        };
        let kids = self.blocks_of(&body, depth)?;
        let (first, rest) = split_first_paragraph(kids);
        let color = color_attr(n).map_or_else(|| "gray".to_owned(), |c| c.1);
        let node = TipTapNode::new("callout")
            .with_attr("color", json!(color))
            .with_attr("icon", icon);
        Ok(vec![container(node.with_content(first), Some(rest))?])
    }
}

fn trim_inline(v: &mut Vec<TipTapNode>) {
    while v
        .first()
        .is_some_and(|n| n.kind == "text" && n.text.as_deref().is_some_and(|t| t.trim().is_empty()))
    {
        v.remove(0);
    }
    while v
        .last()
        .is_some_and(|n| n.kind == "text" && n.text.as_deref().is_some_and(|t| t.trim().is_empty()))
    {
        v.pop();
    }
}

/// Inline image markers are dropped from text (images are converted as blocks where they stand alone).
fn lift_images(v: Vec<TipTapNode>) -> Vec<TipTapNode> {
    v.into_iter()
        .filter(|n| !(n.kind == "emoji" && n.attr_str("native") == Some(IMAGE_MARKER)))
        .collect()
}

fn flush_run(run: &mut Vec<TipTapNode>, out: &mut Vec<TipTapNode>) -> Result<()> {
    let mut r = lift_images(std::mem::take(run));
    trim_inline(&mut r);
    if !r.is_empty() {
        out.push(container(
            TipTapNode::new("paragraph").with_content(r),
            None,
        )?);
    }
    Ok(())
}

fn split_first_paragraph(kids: Vec<TipTapNode>) -> (Vec<TipTapNode>, Vec<TipTapNode>) {
    let mut it = kids.into_iter();
    match it.next() {
        Some(c)
            if c.children().first().is_some_and(|x| x.kind == "paragraph")
                && c.children().len() == 1 =>
        {
            (c.children()[0].children().to_vec(), it.collect())
        }
        Some(c) => (Vec::new(), std::iter::once(c).chain(it).collect()),
        None => (Vec::new(), Vec::new()),
    }
}

/// Converts an HTML page (Notion export or generic) to a document.
pub fn convert(html: &str, r: &mut dyn Resolve) -> Result<HtmlResult> {
    if html.len() > MAX_HTML_BYTES {
        return Err(StoreError::TooLarge("html file"));
    }
    let root = parse(html);
    let title = root
        .find(&|n| n.has_class("page-title"))
        .map(|n| n.text().trim().to_owned())
        .or_else(|| {
            root.find(&|n| n.name() == "title")
                .map(|n| n.text().trim().to_owned())
        });
    let mut properties = Vec::new();
    if let Some(t) = root.find(&|n| n.name() == "table" && n.has_class("properties")) {
        let mut rows = Vec::new();
        collect_rows(t, &mut rows);
        for row in rows {
            let th = row
                .kids()
                .iter()
                .find(|c| c.name() == "th")
                .map(|c| c.text().trim().to_owned());
            let td = row
                .kids()
                .iter()
                .find(|c| c.name() == "td")
                .map(|c| c.text().trim().to_owned());
            if let (Some(k), Some(v)) = (th, td) {
                properties.push((k, v));
            }
        }
    }
    let body = root
        .find(&|n| n.has_class("page-body"))
        .or_else(|| root.find(&|n| n.name() == "article"))
        .or_else(|| root.find(&|n| n.name() == "body"))
        .unwrap_or(&root)
        .clone();
    let mut c = Conv {
        r,
        unresolved: Vec::new(),
        unsupported: Vec::new(),
    };
    let blocks = if body.has_class("page-body") {
        c.blocks_of(&body, 0)?
    } else {
        c.block(&body, 0)?
    };
    let mut doc = if blocks.is_empty() {
        TipTapDoc::empty()?
    } else {
        TipTapDoc::from_blocks(blocks)
    };
    normalize(&mut doc)?;
    let icon = root
        .find(&|n| n.has_class("page-header-icon"))
        .and_then(|h| h.find(&|x| x.has_class("icon")).or(Some(h)))
        .map(|x| x.text().trim().to_owned())
        .and_then(|t| crate::icons::lucide_for_emoji(&t))
        .map(|name| crate::model::Icon::Lucide {
            v: name.to_owned(),
            color: None,
        });
    Ok(HtmlResult {
        doc,
        title,
        icon,
        properties,
        unresolved: c.unresolved,
        unsupported: c.unsupported,
    })
}

fn collect_rows<'a>(n: &'a Node, out: &mut Vec<&'a Node>) {
    for k in n.kids() {
        if k.name() == "tr" {
            out.push(k);
        } else {
            collect_rows(k, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::markdown::NoResolve;

    #[test]
    fn notion_page() {
        let html = r#"<!DOCTYPE html><html><head><title>T</title><style>p{}</style><script>alert(1)</script></head><body>
<article class="page sans"><header><div class="page-header-icon undefined"><span class="icon">&#x1F680;</span></div><h1 class="page-title">My Page</h1><table class="properties"><tbody><tr><th>Status</th><td>Done</td></tr></tbody></table></header>
<div class="page-body"><p class="block-color-red">Hello <strong>bold</strong> &amp; <a href="https://x.io">link</a> <a href="javascript:x()">bad</a></p>
<details><summary>Toggle</summary><p>inside</p></details>
<figure class="block-color-gray_background callout"><div><span class="icon">&#x1F4A1;</span></div><div><p>Tip text</p></div></figure>
<aside>Aside text</aside>
<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div><span class="to-do-children-checked">Done</span></li></ul>
<ol><li>one</li><li>two<ul><li>nested</li></ul></li></ol>
<pre><code class="language-Rust">fn main() {}</code></pre><hr>
<figure class="equation"><annotation encoding="application/x-tex">x^2</annotation></figure>
<div class="column-list"><div class="column"><p>A</p></div><div class="column"><p>B</p></div></div>
<table class="simple-table"><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
<!-- comment --></div></article></body></html>"#;
        let r = convert(html, &mut NoResolve).unwrap();
        assert_eq!(r.title.as_deref(), Some("My Page"));
        assert_eq!(r.properties, vec![("Status".into(), "Done".into())]);
        let kinds: Vec<&str> = r
            .doc
            .blocks()
            .iter()
            .map(|c| c.children()[0].kind.as_str())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "paragraph",
                "toggle",
                "callout",
                "callout",
                "todoItem",
                "numberedItem",
                "numberedItem",
                "codeBlock",
                "divider",
                "mathBlock",
                "columnList",
                "table"
            ],
            "{kinds:?}"
        );
        let json = serde_json::to_string(&r.doc).unwrap();
        assert!(!json.contains("alert"));
        assert!(!json.contains("javascript"));
        assert!(json.contains("\"color\":\"red\""));
        assert!(json.contains("\"language\":\"rust\""));
        assert!(json.contains("\"checked\":true"));
        assert!(json.contains("Hello "));
        assert!(json.contains(" & "));
        // No emoji survive into generated structure: Notion's callout and page emoji map to Lucide icons.
        let callout = &r.doc.blocks()[2].children()[0];
        assert_eq!(
            callout.attrs.as_ref().and_then(|a| a.get("icon")),
            Some(&serde_json::json!({"t": "lucide", "v": "lightbulb"}))
        );
        assert_eq!(
            r.icon,
            Some(crate::model::Icon::Lucide {
                v: "rocket".into(),
                color: None
            })
        );
    }

    #[test]
    fn callouts_without_a_mapped_icon_get_lightbulb() {
        for html in [
            r#"<figure class="callout"><div>No icon here</div></figure>"#,
            r#"<figure class="callout"><div class="icon">&#x1FAE0;</div><div>Unmapped</div></figure>"#,
        ] {
            let r = convert(html, &mut NoResolve).unwrap();
            let json = serde_json::to_value(&r.doc).unwrap().to_string();
            assert!(
                json.contains(r#""icon":{"t":"lucide","v":"lightbulb"}"#),
                "{json}"
            );
        }
    }

    #[test]
    fn hostile_html() {
        let deep = "<div>".repeat(5_000) + "x";
        assert!(convert(&deep, &mut NoResolve).is_ok());
        assert!(convert("<p unclosed attr=\"x", &mut NoResolve).is_ok());
        assert!(convert("</p></div><<<>>>&#xFFFFFFFF;&#0;", &mut NoResolve).is_ok());
        assert_eq!(
            decode_entities("&lt;a&gt; &#65;&#x42; &bogus;"),
            "<a> AB &bogus;"
        );
    }

    #[test]
    fn many_dropped_elements_are_linear() {
        // Each dropped element used to lowercase a copy of the rest of the document: 200,000
        // of them (2 MiB) took minutes and could not be cancelled.
        let html = "<SVG><path/></sVg>".repeat(200_000) + "<p>after</p>";
        let started = std::time::Instant::now();
        let r = convert(&html, &mut NoResolve).unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        assert!(serde_json::to_string(&r.doc).unwrap().contains("after"));
        assert_eq!(find_ascii_ci("abc</ScRiPt>", "</script"), Some(3));
        assert_eq!(find_ascii_ci("é</x", "</x"), Some(2));
        assert_eq!(find_ascii_ci("abc", "</x"), None);
        assert_eq!(find_ascii_ci("abc", ""), None);
        // Unterminated dropped elements swallow the rest, as before.
        let r = convert("<p>a</p><script>alert(1)<p>b</p>", &mut NoResolve).unwrap();
        assert!(!serde_json::to_string(&r.doc).unwrap().contains("alert"));
    }
}
