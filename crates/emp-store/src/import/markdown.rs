//! Markdown → TipTap document (SPEC §17.5 import rules), built on `pulldown-cmark` (CommonMark + GFM tables,
//! task lists, strikethrough, alerts, math, wikilinks, YAML front matter).
//!
//! * `[[Page]]` / `[[Page|alias]]` and relative links to `.md` files become page mentions when the resolver knows
//!   the target (pass 2 of a folder / Notion import); unknown targets stay as text and are reported.
//! * `![[img]]` and relative images become image blocks backed by imported assets; remote images keep their URL as
//!   `pendingUrl` (never fetched automatically).
//! * `- [ ]` → to-do, fenced code keeps its language, `> [!note]` → callout, `$$…$$` → math block, `#tags` are
//!   collected, YAML front matter is returned as key/value pairs (and optionally rendered as a callout).
//! * Fenced code with the `emp-block` info string carries a JSON block container and re-imports losslessly.
//! * Raw HTML is never interpreted: it is kept as literal text.

use pulldown_cmark::{
    BlockQuoteKind, CodeBlockKind, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd,
};
use serde_json::{Value, json};

use crate::doc::schema::{container, normalize};
use crate::model::{TipTapDoc, TipTapMark, TipTapNode};
use crate::{Result, StoreError};

/// Maximum Markdown input (bytes).
pub const MAX_MARKDOWN_BYTES: usize = 32 * 1024 * 1024;
/// Nesting beyond this depth is flattened.
pub const MAX_NESTING: usize = 40;

/// Resolves links and images during conversion.
pub trait Resolve {
    /// Page id for a wikilink target or a relative link (already percent-decoded).
    fn page(&mut self, target: &str) -> Option<String> {
        let _ = target;
        None
    }
    /// Asset id for an image source (relative path or embed name).
    fn asset(&mut self, src: &str) -> Option<String> {
        let _ = src;
        None
    }
}

/// A resolver that resolves nothing.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoResolve;
impl Resolve for NoResolve {}

/// Conversion options.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MdOptions {
    /// Render YAML front matter as a callout at the top.
    pub front_matter_callout: bool,
    /// Drop the first `# Heading` (used as the page title).
    pub drop_first_h1: bool,
    /// Append a "Tags" line with the collected `#tags`.
    pub tags_line: bool,
}

/// Conversion result.
#[derive(Clone, Debug, PartialEq)]
pub struct MdResult {
    /// The document (normalised).
    pub doc: TipTapDoc,
    /// Text of the first level-1 heading.
    pub title: Option<String>,
    /// Front matter `key: value` pairs.
    pub front_matter: Vec<(String, String)>,
    /// `#tags` found in text.
    pub tags: Vec<String>,
    /// Links that could not be resolved.
    pub unresolved: Vec<String>,
}

/// Percent-decodes a link destination (`%20` → space). Invalid sequences are kept.
#[must_use]
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len() + 1
            && let (Some(h), Some(l)) = (
                b.get(i + 1).and_then(|c| (*c as char).to_digit(16)),
                b.get(i + 2).and_then(|c| (*c as char).to_digit(16)),
            )
        {
            out.push(u8::try_from(h * 16 + l).unwrap_or(b'?'));
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses simple YAML front matter (`key: value`, `key: [a, b]`, `key:` followed by `- item` lines).
#[must_use]
pub fn parse_front_matter(src: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in src.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() || t.trim_start().starts_with('#') {
            continue;
        }
        if let Some(item) = t.trim_start().strip_prefix("- ")
            && (line.starts_with(' ') || line.starts_with('-'))
            && let Some(last) = out.last_mut()
        {
            if !last.1.is_empty() {
                last.1.push_str(", ");
            }
            last.1.push_str(unquote(item.trim()));
            continue;
        }
        if let Some((k, v)) = t.split_once(':') {
            let k = k.trim();
            if k.is_empty() || k.contains(' ') && k.len() > 64 {
                continue;
            }
            let v = v.trim();
            let v = if v.starts_with('[') && v.ends_with(']') {
                v[1..v.len() - 1]
                    .split(',')
                    .map(|x| unquote(x.trim()))
                    .filter(|x| !x.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                unquote(v).to_owned()
            };
            out.push((k.to_owned(), v));
        }
    }
    out
}

fn unquote(s: &str) -> &str {
    s.strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
        .unwrap_or(s)
}

fn allowed_href(u: &str) -> bool {
    crate::query::cells::url_allowed(u)
}

fn is_remote(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

#[derive(Debug)]
enum Kind {
    Root,
    List {
        ordered: Option<u64>,
    },
    Item {
        ordered: Option<u64>,
        checked: Option<bool>,
    },
    Quote {
        callout: Option<(String, String)>,
    },
    Flat,
}

#[derive(Debug)]
struct Frame {
    kind: Kind,
    content: Option<TipTapNode>,
    children: Vec<TipTapNode>,
}

enum LinkState {
    Href,
    Page {
        id: Option<String>,
        target: String,
        start: usize,
    },
    Image {
        src: String,
    },
}

struct Builder<'r> {
    r: &'r mut dyn Resolve,
    frames: Vec<Frame>,
    inline: Vec<TipTapNode>,
    marks: Vec<TipTapMark>,
    links: Vec<LinkState>,
    code: Option<(String, String)>,
    heading: Option<u8>,
    table: Option<Vec<Vec<Vec<TipTapNode>>>>,
    display_math: Vec<String>,
    pending: Vec<TipTapNode>,
    front: Option<String>,
    front_done: Option<String>,
    title: Option<String>,
    first_block: bool,
    opts: MdOptions,
    tags: Vec<String>,
    unresolved: Vec<String>,
}

/// GitHub alert → callout icon (Lucide, as the emoji map names them) and colour.
fn alert_icon(k: BlockQuoteKind) -> (String, String) {
    let (i, c) = match k {
        BlockQuoteKind::Note => ("info", "blue"),
        BlockQuoteKind::Tip => ("lightbulb", "green"),
        BlockQuoteKind::Important => ("circle-alert", "purple"),
        BlockQuoteKind::Warning => ("triangle-alert", "yellow"),
        BlockQuoteKind::Caution => ("octagon-x", "red"),
    };
    (i.to_owned(), c.to_owned())
}

/// Removes the first `n` characters of leading text nodes.
fn strip_chars(nodes: &mut Vec<TipTapNode>, mut n: usize) {
    while n > 0 {
        let Some(first) = nodes.first_mut() else {
            return;
        };
        if first.kind != "text" {
            return;
        }
        let t = first.text.clone().unwrap_or_default();
        let len = t.chars().count();
        if len <= n {
            nodes.remove(0);
            n -= len;
        } else {
            first.text = Some(t.chars().skip(n).collect());
            n = 0;
        }
    }
}

fn plain(nodes: &[TipTapNode]) -> String {
    nodes
        .iter()
        .map(|n| match n.kind.as_str() {
            "text" => n.text.clone().unwrap_or_default(),
            "hardBreak" => "\n".into(),
            _ => String::new(),
        })
        .collect()
}

impl Builder<'_> {
    fn list_or_top(&mut self) -> &mut Frame {
        let i = self
            .frames
            .iter()
            .rposition(|f| !matches!(f.kind, Kind::Flat))
            .unwrap_or(0);
        &mut self.frames[i]
    }

    fn push_container(&mut self, c: TipTapNode) {
        self.list_or_top().children.push(c);
    }

    /// Places a block content node: the first paragraph of an item / quote becomes its content.
    fn place(&mut self, block: TipTapNode) -> Result<()> {
        self.first_block = false;
        let top = self.list_or_top();
        if top.content.is_none() && block.kind == "paragraph" {
            match &top.kind {
                Kind::Item { ordered, checked } => {
                    let mut n = match (checked, ordered) {
                        (Some(c), _) => TipTapNode::new("todoItem").with_attr("checked", json!(c)),
                        (None, Some(s)) => {
                            TipTapNode::new("numberedItem").with_attr("start", json!(s))
                        }
                        (None, None) => TipTapNode::new("bulletItem"),
                    };
                    n.content = block.content;
                    top.content = Some(n);
                    return Ok(());
                }
                Kind::Quote { callout } => {
                    let mut content = block.content.unwrap_or_default();
                    let mut callout = callout.clone();
                    // Obsidian `> [!note] Title` (the marker may span several text nodes).
                    let head = plain(&content);
                    if callout.is_none()
                        && let Some(rest) = head.strip_prefix("[!")
                        && let Some((kind, after)) = rest.split_once(']')
                        && kind.len() <= 20
                    {
                        let k = match kind.to_ascii_lowercase().as_str() {
                            "tip" | "hint" | "success" => BlockQuoteKind::Tip,
                            "important" => BlockQuoteKind::Important,
                            "warning" | "attention" => BlockQuoteKind::Warning,
                            "caution" | "danger" | "error" | "failure" => BlockQuoteKind::Caution,
                            _ => BlockQuoteKind::Note,
                        };
                        callout = Some(alert_icon(k));
                        let after_trim = after.trim_start_matches(['-', '+']).trim_start();
                        let drop = head.chars().count() - after_trim.chars().count();
                        strip_chars(&mut content, drop);
                        if content.first().is_some_and(|n| n.kind == "hardBreak") {
                            content.remove(0);
                        }
                    }
                    let mut n = match callout {
                        Some((icon, color)) => TipTapNode::new("callout")
                            .with_attr("icon", crate::icons::lucide_attr(&icon))
                            .with_attr("color", json!(color)),
                        None => TipTapNode::new("quote"),
                    };
                    n.content = Some(content);
                    top.content = Some(n);
                    return Ok(());
                }
                _ => {}
            }
        }
        let c = container(block, None)?;
        self.push_container(c);
        Ok(())
    }

    fn flush_inline(&mut self) -> Result<()> {
        if self
            .inline
            .iter()
            .all(|n| n.kind == "text" && n.text.as_deref().is_none_or(|t| t.trim().is_empty()))
        {
            self.inline.clear();
            return self.flush_pending();
        }
        let nodes = std::mem::take(&mut self.inline);
        self.place(TipTapNode::new("paragraph").with_content(nodes))?;
        self.flush_pending()
    }

    fn flush_pending(&mut self) -> Result<()> {
        for b in std::mem::take(&mut self.pending) {
            let c = container(b, None)?;
            self.push_container(c);
        }
        Ok(())
    }

    fn text(&mut self, t: &str) {
        if t.is_empty() {
            return;
        }
        if matches!(self.links.last(), Some(LinkState::Image { .. })) {
            return;
        }
        for w in t.split_whitespace() {
            if let Some(tag) = w.strip_prefix('#')
                && tag.chars().next().is_some_and(char::is_alphanumeric)
                && tag
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
                && !self.tags.iter().any(|x| x == tag)
                && self.tags.len() < 200
            {
                self.tags.push(tag.to_owned());
            }
        }
        let mut n = TipTapNode::text(t);
        if !self.marks.is_empty() {
            n.marks = Some(self.marks.clone());
        }
        self.inline.push(n);
    }

    fn push_frame(&mut self, kind: Kind) {
        let kind = if self.frames.len() >= MAX_NESTING && !matches!(kind, Kind::List { .. }) {
            Kind::Flat
        } else {
            kind
        };
        self.frames.push(Frame {
            kind,
            content: None,
            children: Vec::new(),
        });
    }

    fn pop_frame(&mut self) -> Result<()> {
        let Some(f) = self.frames.pop() else {
            return Ok(());
        };
        match f.kind {
            Kind::Root => {}
            Kind::Flat => {
                if let Some(c) = f.content {
                    let c = container(c, None)?;
                    self.push_container(c);
                }
                for c in f.children {
                    self.push_container(c);
                }
            }
            Kind::List { .. } => {
                for c in f.children {
                    self.push_container(c);
                }
            }
            Kind::Item { ordered, checked } => {
                let content = f.content.unwrap_or_else(|| match (checked, ordered) {
                    (Some(c), _) => TipTapNode::new("todoItem").with_attr("checked", json!(c)),
                    (None, Some(_)) => TipTapNode::new("numberedItem"),
                    (None, None) => TipTapNode::new("bulletItem"),
                });
                let c = container(content, Some(f.children))?;
                self.push_container(c);
            }
            Kind::Quote { callout } => {
                let content = f.content.unwrap_or_else(|| match callout {
                    Some((i, c)) => TipTapNode::new("callout")
                        .with_attr("icon", crate::icons::lucide_attr(&i))
                        .with_attr("color", json!(c)),
                    None => TipTapNode::new("quote"),
                });
                let c = container(content, Some(f.children))?;
                self.push_container(c);
            }
        }
        Ok(())
    }

    fn event(&mut self, ev: Event<'_>) -> Result<()> {
        if let Some((_, buf)) = &mut self.code {
            match ev {
                Event::Text(t) => {
                    buf.push_str(&t);
                    return Ok(());
                }
                Event::End(TagEnd::CodeBlock) => {}
                _ => return Ok(()),
            }
        }
        if let Some(buf) = &mut self.front {
            match ev {
                Event::Text(t) => {
                    buf.push_str(&t);
                    return Ok(());
                }
                Event::End(TagEnd::MetadataBlock(_)) => {
                    self.front_done = self.front.take();
                    return Ok(());
                }
                _ => return Ok(()),
            }
        }
        match ev {
            Event::Start(tag) => self.start(tag)?,
            Event::End(tag) => self.end(tag)?,
            Event::Text(t) => self.text(&t),
            Event::Code(t) => {
                let mut n = TipTapNode::text(&t);
                let mut m = self.marks.clone();
                m.push(TipTapMark {
                    kind: "code".into(),
                    attrs: None,
                });
                n.marks = Some(m);
                self.inline.push(n);
            }
            Event::InlineMath(t) => self
                .inline
                .push(TipTapNode::new("mathInline").with_attr("latex", json!(t.to_string()))),
            Event::DisplayMath(t) => {
                if self.heading.is_none() && self.table.is_none() {
                    self.display_math.push(t.to_string());
                } else {
                    self.inline.push(
                        TipTapNode::new("mathInline").with_attr("latex", json!(t.to_string())),
                    );
                }
            }
            Event::Html(t) | Event::InlineHtml(t) => {
                let s = t.to_string();
                if s.trim_start().starts_with("<!--") {
                    return Ok(());
                }
                self.text(&s);
            }
            Event::FootnoteReference(t) => self.text(&format!("[^{t}]")),
            Event::SoftBreak => self.text(" "),
            Event::HardBreak => self.inline.push(TipTapNode::new("hardBreak")),
            Event::Rule => {
                self.flush_inline()?;
                self.place(TipTapNode::new("divider"))?;
            }
            Event::TaskListMarker(c) => {
                if let Some(Frame {
                    kind: Kind::Item { checked, .. },
                    ..
                }) = self.frames.last_mut()
                {
                    *checked = Some(c);
                }
            }
        }
        Ok(())
    }

    fn start(&mut self, tag: Tag<'_>) -> Result<()> {
        match tag {
            Tag::Paragraph => {
                self.flush_inline()?;
            }
            Tag::Heading { level, .. } => {
                self.flush_inline()?;
                self.heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    _ => 3,
                });
            }
            Tag::BlockQuote(kind) => {
                self.flush_inline()?;
                self.push_frame(Kind::Quote {
                    callout: kind.map(alert_icon),
                });
            }
            Tag::CodeBlock(kind) => {
                self.flush_inline()?;
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("").to_owned()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                self.code = Some((lang, String::new()));
            }
            Tag::HtmlBlock => self.flush_inline()?,
            Tag::List(start) => {
                self.flush_inline()?;
                self.push_frame(Kind::List { ordered: start });
            }
            Tag::Item => {
                self.flush_inline()?;
                let ordered = match self.frames.last() {
                    Some(Frame {
                        kind: Kind::List { ordered },
                        ..
                    }) => *ordered,
                    _ => None,
                };
                self.push_frame(Kind::Item {
                    ordered,
                    checked: None,
                });
            }
            Tag::FootnoteDefinition(_)
            | Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition => {
                self.flush_inline()?;
            }
            Tag::Table(_) => {
                self.flush_inline()?;
                self.table = Some(Vec::new());
            }
            Tag::TableHead | Tag::TableRow => {
                if let Some(t) = &mut self.table {
                    t.push(Vec::new());
                }
            }
            Tag::TableCell => self.inline.clear(),
            Tag::Emphasis => self.marks.push(TipTapMark {
                kind: "italic".into(),
                attrs: None,
            }),
            Tag::Strong => self.marks.push(TipTapMark {
                kind: "bold".into(),
                attrs: None,
            }),
            Tag::Strikethrough => self.marks.push(TipTapMark {
                kind: "strike".into(),
                attrs: None,
            }),
            Tag::Superscript | Tag::Subscript => {}
            Tag::Link {
                link_type,
                dest_url,
                ..
            } => {
                let dest = dest_url.to_string();
                let wiki = matches!(link_type, LinkType::WikiLink { .. });
                let decoded = percent_decode(&dest);
                let local = !wiki
                    && !allowed_href(&dest)
                    && !dest.contains("://")
                    && !dest.starts_with('#');
                if wiki || local {
                    let target = decoded.split('#').next().unwrap_or("").to_owned();
                    let id = if target.is_empty() {
                        None
                    } else {
                        self.r.page(&target)
                    };
                    self.links.push(LinkState::Page {
                        id,
                        target,
                        start: self.inline.len(),
                    });
                } else if allowed_href(&dest) {
                    self.marks.push(TipTapMark {
                        kind: "link".into(),
                        attrs: Some(serde_json::Map::from_iter([(
                            "href".to_owned(),
                            json!(dest),
                        )])),
                    });
                    self.links.push(LinkState::Href);
                } else {
                    // Disallowed schemes (javascript:, data:, …) and in-page anchors become plain text.
                    self.links.push(LinkState::Page {
                        id: None,
                        target: String::new(),
                        start: self.inline.len(),
                    });
                }
            }
            Tag::Image { dest_url, .. } => {
                self.links.push(LinkState::Image {
                    src: percent_decode(&dest_url),
                });
            }
            Tag::MetadataBlock(_) => self.front = Some(String::new()),
        }
        Ok(())
    }

    fn end(&mut self, tag: TagEnd) -> Result<()> {
        match tag {
            TagEnd::Paragraph => {
                if !self.display_math.is_empty() && plain(&self.inline).trim().is_empty() {
                    self.inline.clear();
                    for m in std::mem::take(&mut self.display_math) {
                        self.place(TipTapNode::new("mathBlock").with_attr("latex", json!(m)))?;
                    }
                    return self.flush_pending();
                }
                for m in std::mem::take(&mut self.display_math) {
                    self.inline
                        .push(TipTapNode::new("mathInline").with_attr("latex", json!(m)));
                }
                self.flush_inline()?;
            }
            TagEnd::Heading(_) => {
                let level = self.heading.take().unwrap_or(1);
                let nodes = std::mem::take(&mut self.inline);
                let text = plain(&nodes).trim().to_owned();
                if level == 1 && self.title.is_none() {
                    self.title = Some(text.clone());
                    if self.opts.drop_first_h1 && self.first_block && self.frames.len() == 1 {
                        self.first_block = false;
                        return self.flush_pending();
                    }
                }
                self.place(
                    TipTapNode::new("heading")
                        .with_attr("level", json!(level))
                        .with_content(nodes),
                )?;
                self.flush_pending()?;
            }
            TagEnd::BlockQuote(_) => {
                self.flush_inline()?;
                self.pop_frame()?;
            }
            TagEnd::CodeBlock => {
                let (lang, mut body) = self.code.take().unwrap_or_default();
                if body.ends_with('\n') {
                    body.pop();
                }
                if lang == "emp-block"
                    && let Ok(node) = serde_json::from_str::<TipTapNode>(&body)
                    && node.kind == "blockContainer"
                {
                    self.first_block = false;
                    self.push_container(node);
                    return Ok(());
                }
                let mut n = TipTapNode::new("codeBlock").with_attr(
                    "language",
                    if lang.is_empty() {
                        Value::Null
                    } else {
                        json!(lang)
                    },
                );
                if !body.is_empty() {
                    n = n.with_content(vec![TipTapNode::text(&body)]);
                }
                self.place(n)?;
            }
            TagEnd::HtmlBlock => self.flush_inline()?,
            TagEnd::List(_) => {
                self.flush_inline()?;
                self.pop_frame()?;
            }
            TagEnd::Item => {
                self.flush_inline()?;
                self.pop_frame()?;
            }
            TagEnd::FootnoteDefinition
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition => {
                self.flush_inline()?;
            }
            TagEnd::TableCell => {
                let cell = std::mem::take(&mut self.inline);
                if let Some(t) = &mut self.table
                    && let Some(row) = t.last_mut()
                {
                    row.push(cell);
                }
            }
            TagEnd::TableHead | TagEnd::TableRow => {}
            TagEnd::Table => {
                let rows = self.table.take().unwrap_or_default();
                let width = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
                let rows: Vec<TipTapNode> = rows
                    .into_iter()
                    .filter(|r| !r.is_empty())
                    .map(|mut r| {
                        r.resize_with(width, Vec::new);
                        TipTapNode::new("tableRow").with_content(
                            r.into_iter()
                                .map(|c| TipTapNode::new("tableCell").with_content(c))
                                .collect(),
                        )
                    })
                    .collect();
                if !rows.is_empty() {
                    self.place(
                        TipTapNode::new("table")
                            .with_attr("headerRow", json!(true))
                            .with_content(rows),
                    )?;
                }
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.marks.pop();
            }
            TagEnd::Superscript | TagEnd::Subscript => {}
            TagEnd::Link => match self.links.pop() {
                Some(LinkState::Href) => {
                    if let Some(i) = self.marks.iter().rposition(|m| m.kind == "link") {
                        self.marks.remove(i);
                    }
                }
                Some(LinkState::Page { id, target, start }) => {
                    let label_nodes: Vec<TipTapNode> =
                        self.inline.drain(start.min(self.inline.len())..).collect();
                    let label = plain(&label_nodes);
                    match id {
                        Some(id) => self.inline.push(
                            TipTapNode::new("mention")
                                .with_attr("kind", json!("page"))
                                .with_attr("pageId", json!(id)),
                        ),
                        None => {
                            if !target.is_empty() {
                                self.unresolved.push(target.clone());
                            }
                            let t = if label.is_empty() { target } else { label };
                            self.text(&t);
                        }
                    }
                }
                _ => {}
            },
            TagEnd::Image => {
                if let Some(LinkState::Image { src }) = self.links.pop() {
                    let block = if is_remote(&src) {
                        Some(TipTapNode::new("image").with_attr("pendingUrl", json!(src)))
                    } else {
                        self.r
                            .asset(&src)
                            .map(|a| TipTapNode::new("image").with_attr("assetId", json!(a)))
                    };
                    match block {
                        Some(b) => self.pending.push(b),
                        None => {
                            if let Some(id) = self.r.page(&src) {
                                self.pending.push(
                                    TipTapNode::new("pageLink").with_attr("pageId", json!(id)),
                                );
                            } else {
                                self.unresolved.push(src.clone());
                                self.text(&format!("[{src}]"));
                            }
                        }
                    }
                }
            }
            TagEnd::MetadataBlock(_) => {}
        }
        Ok(())
    }
}

/// Converts Markdown to a normalised TipTap document.
pub fn convert(md: &str, opts: MdOptions, r: &mut dyn Resolve) -> Result<MdResult> {
    if md.len() > MAX_MARKDOWN_BYTES {
        return Err(StoreError::TooLarge("markdown file"));
    }
    let md = md.strip_prefix('\u{feff}').unwrap_or(md);
    let mut o = Options::empty();
    o.insert(Options::ENABLE_TABLES);
    o.insert(Options::ENABLE_STRIKETHROUGH);
    o.insert(Options::ENABLE_TASKLISTS);
    o.insert(Options::ENABLE_FOOTNOTES);
    o.insert(Options::ENABLE_MATH);
    o.insert(Options::ENABLE_GFM);
    o.insert(Options::ENABLE_WIKILINKS);
    o.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    let mut b = Builder {
        r,
        frames: vec![Frame {
            kind: Kind::Root,
            content: None,
            children: Vec::new(),
        }],
        inline: Vec::new(),
        marks: Vec::new(),
        links: Vec::new(),
        code: None,
        heading: None,
        table: None,
        display_math: Vec::new(),
        pending: Vec::new(),
        front: None,
        front_done: None,
        title: None,
        first_block: true,
        opts,
        tags: Vec::new(),
        unresolved: Vec::new(),
    };
    for ev in Parser::new_ext(md, o) {
        b.event(ev)?;
    }
    let front_src = b.front_done.take().or_else(|| b.front.take());
    b.flush_inline()?;
    while b.frames.len() > 1 {
        b.pop_frame()?;
    }
    let front_matter = front_src
        .as_deref()
        .map(parse_front_matter)
        .unwrap_or_default();
    let mut blocks = b.frames.pop().map(|f| f.children).unwrap_or_default();
    if opts.front_matter_callout && !front_matter.is_empty() {
        let mut inl = Vec::new();
        for (i, (k, v)) in front_matter.iter().enumerate() {
            if i > 0 {
                inl.push(TipTapNode::new("hardBreak"));
            }
            inl.push(TipTapNode::text(&format!("{k}: {v}")));
        }
        blocks.insert(
            0,
            container(
                TipTapNode::new("callout")
                    .with_attr("icon", crate::icons::lucide_attr("clipboard-list"))
                    .with_attr("color", json!("gray"))
                    .with_content(inl),
                None,
            )?,
        );
    }
    if opts.tags_line && !b.tags.is_empty() {
        let line = format!(
            "Tags: {}",
            b.tags
                .iter()
                .map(|t| format!("#{t}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        blocks.push(container(
            TipTapNode::new("paragraph").with_content(vec![TipTapNode::text(&line)]),
            None,
        )?);
    }
    let mut doc = if blocks.is_empty() {
        TipTapDoc::empty()?
    } else {
        TipTapDoc::from_blocks(blocks)
    };
    normalize(&mut doc)?;
    Ok(MdResult {
        doc,
        title: b.title,
        front_matter,
        tags: b.tags,
        unresolved: b.unresolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct R;
    impl Resolve for R {
        fn page(&mut self, t: &str) -> Option<String> {
            (t == "Other" || t == "Other Page 0123456789abcdef0123456789abcdef.md")
                .then(|| "pg1".to_owned())
        }
        fn asset(&mut self, s: &str) -> Option<String> {
            (s == "img.png").then(|| "a".repeat(32))
        }
    }

    fn kinds(doc: &TipTapDoc) -> Vec<String> {
        doc.blocks()
            .iter()
            .map(|c| c.children()[0].kind.clone())
            .collect()
    }

    #[test]
    fn blocks_and_marks() {
        let md = "---\ntitle: Hello\ntags: [a, b]\n---\n# Title\n\nSome **bold** and [link](https://x.io) and [[Other]] and [[Missing|alias]].\n\n- [ ] todo\n- [x] done\n  - nested\n1. one\n\n> [!note] Heads up\n> body\n\n```rust\nfn main() {}\n```\n\n$$\nx^2\n$$\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![pic](img.png)\n\n#work #home\n\n<script>alert(1)</script>\n";
        let r = convert(
            md,
            MdOptions {
                front_matter_callout: true,
                drop_first_h1: true,
                tags_line: true,
            },
            &mut R,
        )
        .unwrap();
        assert_eq!(r.title.as_deref(), Some("Title"));
        assert_eq!(
            r.front_matter,
            vec![
                ("title".into(), "Hello".into()),
                ("tags".into(), "a, b".into())
            ]
        );
        let k = kinds(&r.doc);
        assert_eq!(
            k,
            vec![
                "callout",
                "paragraph",
                "todoItem",
                "todoItem",
                "numberedItem",
                "callout",
                "codeBlock",
                "mathBlock",
                "divider",
                "table",
                "image",
                "paragraph",
                "paragraph",
                "paragraph"
            ],
            "{k:?}"
        );
        assert_eq!(r.unresolved, vec!["Missing"]);
        assert_eq!(r.tags, vec!["work", "home"]);
        let json = serde_json::to_string(&r.doc).unwrap();
        assert!(json.contains("\"pageId\":\"pg1\""));
        assert!(json.contains("\"href\":\"https://x.io\""));
        assert!(json.contains("\"language\":\"rust\""));
        assert!(json.contains("alias"));
        assert!(json.contains("<script>"), "html is kept as literal text");
        // The nested bullet is a child of the done item.
        let done = &r.doc.blocks()[3];
        assert_eq!(done.children().len(), 2);
    }

    #[test]
    fn notion_links_and_hostile_input() {
        let r = convert("See [Other Page](Other%20Page%200123456789abcdef0123456789abcdef.md) and [x](javascript:alert(1))", MdOptions::default(), &mut R).unwrap();
        let json = serde_json::to_string(&r.doc).unwrap();
        assert!(json.contains("\"pageId\":\"pg1\""));
        assert!(!json.contains("javascript"));
        let deep = ">".repeat(500) + " deep";
        assert!(convert(&deep, MdOptions::default(), &mut NoResolve).is_ok());
        let lists: String = (0..200)
            .map(|i| format!("{}- x\n", "  ".repeat(i)))
            .collect();
        assert!(convert(&lists, MdOptions::default(), &mut NoResolve).is_ok());
        assert_eq!(percent_decode("a%20b%zz"), "a b%zz");
    }

    #[test]
    fn emp_block_round_trip() {
        let c = container(
            TipTapNode::new("kpi").with_attr("label", json!("Net")),
            None,
        )
        .unwrap();
        let md = format!(
            "```emp-block\n{}\n```\n",
            serde_json::to_string(&c).unwrap()
        );
        let r = convert(&md, MdOptions::default(), &mut NoResolve).unwrap();
        assert_eq!(kinds(&r.doc), vec!["kpi"]);
    }
}
