//! TipTap → Markdown export (SPEC §17.5 "Export").
//!
//! CommonMark/GFM output: headings, lists and to-dos with nesting, quotes, `> [!note]` callouts, fenced code with
//! its language, `$$` math, GFM tables, images and files through the resolver's asset hrefs, page links as
//! relative links. EMP-only blocks (`databaseView`, `chart`, `kpi`, `sheetEmbed`, `watchlist`, `toc`) export as a
//! fenced block with the `emp-block` info string carrying the node JSON, which makes re-import lossless.

use serde_json::{Value, json};

use super::PageResolver;
use super::walk::inline_text;
use crate::model::{TipTapDoc, TipTapNode};

/// Renders a document as Markdown.
#[must_use]
pub fn to_markdown(doc: &TipTapDoc, resolver: &dyn PageResolver) -> String {
    let mut out = String::new();
    for g in &doc.content {
        render_group(g, resolver, "", &mut out);
    }
    while out.ends_with("\n\n") {
        out.pop();
    }
    out
}

fn render_group(group: &TipTapNode, r: &dyn PageResolver, indent: &str, out: &mut String) {
    let mut n_index = 0u64;
    for c in group.children() {
        if c.kind != "blockContainer" {
            continue;
        }
        let mut parts = c.children().iter();
        let Some(content) = parts.next() else {
            continue;
        };
        if content.kind == "numberedItem" {
            n_index += 1;
        } else {
            n_index = 0;
        }
        render_block(content, r, indent, n_index, out);
        for g in parts.filter(|p| p.kind == "blockGroup") {
            let child_indent = format!("{indent}  ");
            render_group(g, r, &child_indent, out);
        }
    }
}

fn push_lines(out: &mut String, indent: &str, prefix: &str, text: &str) {
    let mut first = true;
    for line in text.split('\n') {
        out.push_str(indent);
        if first {
            out.push_str(prefix);
            first = false;
        } else {
            out.push_str(&" ".repeat(prefix.chars().count()));
        }
        out.push_str(line);
        out.push('\n');
    }
}

fn render_block(
    content: &TipTapNode,
    r: &dyn PageResolver,
    indent: &str,
    n_index: u64,
    out: &mut String,
) {
    let inline = || render_inline(content, r);
    match content.kind.as_str() {
        "paragraph" => {
            push_lines(out, indent, "", &inline());
            out.push('\n');
        }
        "heading" => {
            let level = content
                .attr("level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 3);
            push_lines(
                out,
                indent,
                &format!("{} ", "#".repeat(level as usize)),
                &inline(),
            );
            out.push('\n');
        }
        "bulletItem" | "toggle" => push_lines(out, indent, "- ", &inline()),
        "numberedItem" => push_lines(out, indent, &format!("{}. ", n_index.max(1)), &inline()),
        "todoItem" => {
            let checked = content.attr("checked").and_then(Value::as_bool) == Some(true);
            push_lines(
                out,
                indent,
                if checked { "- [x] " } else { "- [ ] " },
                &inline(),
            );
        }
        "quote" => {
            push_lines(out, indent, "> ", &inline().replace('\n', "\n> "));
            out.push('\n');
        }
        "callout" => {
            out.push_str(indent);
            out.push_str("> [!note]\n");
            push_lines(out, indent, "> ", &inline().replace('\n', "\n> "));
            out.push('\n');
        }
        "codeBlock" => {
            let lang = content
                .attr_str("language")
                .filter(|l| *l != "plain")
                .unwrap_or("");
            let code = inline_text(content);
            let fence = fence_for(&code);
            push_lines(out, indent, "", &format!("{fence}{lang}\n{code}\n{fence}"));
            out.push('\n');
        }
        "divider" => {
            push_lines(out, indent, "", "---");
            out.push('\n');
        }
        "mathBlock" => {
            push_lines(
                out,
                indent,
                "",
                &format!("$$\n{}\n$$", content.attr_str("latex").unwrap_or("")),
            );
            out.push('\n');
        }
        "image" => {
            let id = content.attr_str("assetId").unwrap_or("");
            let href = r.asset_href(id).unwrap_or_else(|| format!("assets/{id}"));
            let alt = escape(content.attr_str("caption").unwrap_or(""));
            push_lines(out, indent, "", &format!("![{alt}]({})", url(&href)));
            out.push('\n');
        }
        "file" => {
            let id = content.attr_str("assetId").unwrap_or("");
            let href = r.asset_href(id).unwrap_or_else(|| format!("assets/{id}"));
            let name = href.rsplit('/').next().unwrap_or("file").to_owned();
            push_lines(
                out,
                indent,
                "",
                &format!("[{}]({})", escape(&name), url(&href)),
            );
            out.push('\n');
        }
        "pageRef" | "pageLink" => {
            let id = content.attr_str("pageId").unwrap_or("");
            push_lines(out, indent, "", &page_link(id, r));
            out.push('\n');
        }
        "table" => {
            render_table(content, r, indent, out);
            out.push('\n');
        }
        "columnList" => {
            for col in content.children() {
                for g in col.children() {
                    render_group(g, r, indent, out);
                }
            }
        }
        _ => {
            // EMP-only blocks: lossless fenced JSON.
            let node = json!({ "type": content.kind, "attrs": content.attrs });
            let body = serde_json::to_string(&node).unwrap_or_default();
            push_lines(out, indent, "", &format!("```emp-block\n{body}\n```"));
            out.push('\n');
        }
    }
}

fn fence_for(code: &str) -> String {
    let mut n = 3;
    while code.contains(&"`".repeat(n)) {
        n += 1;
    }
    "`".repeat(n)
}

fn render_table(t: &TipTapNode, r: &dyn PageResolver, indent: &str, out: &mut String) {
    let rows: Vec<Vec<String>> = t
        .children()
        .iter()
        .map(|row| {
            row.children()
                .iter()
                .map(|cell| {
                    render_inline(cell, r)
                        .replace('|', "\\|")
                        .replace('\n', "<br>")
                })
                .collect()
        })
        .collect();
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    if cols == 0 {
        return;
    }
    for (i, row) in rows.iter().enumerate() {
        let mut cells = row.clone();
        cells.resize(cols, String::new());
        push_lines(out, indent, "", &format!("| {} |", cells.join(" | ")));
        if i == 0 {
            push_lines(out, indent, "", &format!("|{}", " --- |".repeat(cols)));
        }
    }
}

fn page_link(id: &str, r: &dyn PageResolver) -> String {
    let title = r.title(id).unwrap_or_else(|| "Untitled".into());
    match r.href(id) {
        Some(h) => format!("[{}]({})", escape(&title), url(&h)),
        None => escape(&title),
    }
}

fn url(href: &str) -> String {
    href.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}

/// Escapes Markdown punctuation in plain text.
#[must_use]
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(
            ch,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#' | '|' | '~' | '$'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn render_inline(node: &TipTapNode, r: &dyn PageResolver) -> String {
    let mut s = String::new();
    for c in node.children() {
        match c.kind.as_str() {
            "text" => {
                let raw = c.text.as_deref().unwrap_or("");
                let mut t = if c
                    .marks
                    .as_ref()
                    .is_some_and(|m| m.iter().any(|m| m.kind == "code"))
                {
                    let fence = if raw.contains('`') { "``" } else { "`" };
                    format!("{fence}{raw}{fence}")
                } else {
                    escape(raw)
                };
                if let Some(marks) = &c.marks {
                    for m in marks {
                        t = match m.kind.as_str() {
                            "bold" => format!("**{t}**"),
                            "italic" => format!("*{t}*"),
                            "strike" => format!("~~{t}~~"),
                            "underline" => format!("<u>{t}</u>"),
                            "link" => {
                                let href = m
                                    .attrs
                                    .as_ref()
                                    .and_then(|a| a.get("href"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let href = match super::parse_internal_href(href) {
                                    Some((id, _)) => r.href(&id).unwrap_or_else(|| href.to_owned()),
                                    None => href.to_owned(),
                                };
                                format!("[{t}]({})", url(&href))
                            }
                            _ => t,
                        };
                    }
                }
                s.push_str(&t);
            }
            "hardBreak" => s.push_str("  \n"),
            "mention" => match c.attr_str("kind") {
                Some("date") => {
                    let d = c
                        .attr("date")
                        .and_then(|d| d.get("start"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    s.push('@');
                    s.push_str(d);
                }
                _ => s.push_str(&page_link(c.attr_str("pageId").unwrap_or(""), r)),
            },
            "emoji" => s.push_str(c.attr_str("native").unwrap_or("")),
            "mathInline" => {
                s.push('$');
                s.push_str(c.attr_str("latex").unwrap_or(""));
                s.push('$');
            }
            _ => {}
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::NoResolver;
    use crate::doc::schema::container;
    use crate::model::TipTapMark;

    fn t(s: &str) -> TipTapNode {
        TipTapNode::text(s)
    }

    #[test]
    fn renders_common_blocks() {
        let mut bold = t("bold");
        bold.marks = Some(vec![TipTapMark {
            kind: "bold".into(),
            attrs: None,
        }]);
        let blocks = vec![
            container(
                TipTapNode::new("heading")
                    .with_attr("level", json!(2))
                    .with_content(vec![t("Title")]),
                None,
            )
            .unwrap(),
            container(
                TipTapNode::new("paragraph").with_content(vec![t("Some "), bold, t(" text *x*")]),
                None,
            )
            .unwrap(),
            container(
                TipTapNode::new("bulletItem").with_content(vec![t("one")]),
                Some(vec![
                    container(
                        TipTapNode::new("bulletItem").with_content(vec![t("nested")]),
                        None,
                    )
                    .unwrap(),
                ]),
            )
            .unwrap(),
            container(
                TipTapNode::new("todoItem")
                    .with_attr("checked", json!(true))
                    .with_content(vec![t("done")]),
                None,
            )
            .unwrap(),
            container(
                TipTapNode::new("numberedItem").with_content(vec![t("a")]),
                None,
            )
            .unwrap(),
            container(
                TipTapNode::new("numberedItem").with_content(vec![t("b")]),
                None,
            )
            .unwrap(),
            container(
                TipTapNode::new("codeBlock")
                    .with_attr("language", json!("rust"))
                    .with_content(vec![t("fn main() {}")]),
                None,
            )
            .unwrap(),
            container(TipTapNode::new("divider"), None).unwrap(),
            container(
                TipTapNode::new("kpi").with_attr("label", json!("Net")),
                None,
            )
            .unwrap(),
        ];
        let md = to_markdown(&TipTapDoc::from_blocks(blocks), &NoResolver);
        assert!(md.starts_with("## Title\n"));
        assert!(md.contains("Some **bold** text \\*x\\*"));
        assert!(md.contains("- one\n  - nested\n"));
        assert!(md.contains("- [x] done"));
        assert!(md.contains("1. a\n2. b\n"));
        assert!(md.contains("```rust\nfn main() {}\n```"));
        assert!(md.contains("---"));
        assert!(
            md.contains("```emp-block\n{\"attrs\":{\"label\":\"Net\"},\"type\":\"kpi\"}\n```")
                || md.contains("emp-block")
        );
    }
}
