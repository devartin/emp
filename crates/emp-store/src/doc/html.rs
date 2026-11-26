//! TipTap → HTML export (clipboard `text/html`, Docs export). Every piece of user text is escaped; only
//! `https:`, `http:`, `mailto:` and internal links are emitted as `href`s (SPEC §9.15).

use serde_json::Value;

use super::PageResolver;
use super::walk::inline_text;
use crate::model::{TipTapDoc, TipTapNode};

/// Escapes text for HTML element content and attribute values.
#[must_use]
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

fn safe_href(href: &str) -> Option<&str> {
    let lower = href.trim_start().to_ascii_lowercase();
    (lower.starts_with("https:")
        || lower.starts_with("http:")
        || lower.starts_with("mailto:")
        || lower.starts_with("emp://page/"))
    .then_some(href)
}

/// Renders a document as an HTML fragment.
#[must_use]
pub fn to_html(doc: &TipTapDoc, r: &dyn PageResolver) -> String {
    let mut out = String::new();
    for g in &doc.content {
        group(g, r, &mut out);
    }
    out
}

fn list_tag(kind: &str) -> Option<&'static str> {
    match kind {
        "bulletItem" | "todoItem" | "toggle" => Some("ul"),
        "numberedItem" => Some("ol"),
        _ => None,
    }
}

fn group(g: &TipTapNode, r: &dyn PageResolver, out: &mut String) {
    let mut open: Option<&'static str> = None;
    for c in g.children() {
        let mut parts = c.children().iter();
        let Some(content) = parts.next() else {
            continue;
        };
        let tag = list_tag(&content.kind);
        if open != tag {
            if let Some(t) = open {
                out.push_str(&format!("</{t}>"));
            }
            if let Some(t) = tag {
                out.push_str(&format!("<{t}>"));
            }
            open = tag;
        }
        let children: Vec<&TipTapNode> = parts.filter(|p| p.kind == "blockGroup").collect();
        block(content, r, out, &children);
    }
    if let Some(t) = open {
        out.push_str(&format!("</{t}>"));
    }
}

fn block(content: &TipTapNode, r: &dyn PageResolver, out: &mut String, children: &[&TipTapNode]) {
    let inner = inline(content, r);
    let kids = |out: &mut String| {
        for g in children {
            group(g, r, out);
        }
    };
    match content.kind.as_str() {
        "paragraph" => {
            out.push_str(&format!("<p>{inner}</p>"));
            kids(out);
        }
        "heading" => {
            let l = content
                .attr("level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 3);
            out.push_str(&format!("<h{l}>{inner}</h{l}>"));
            kids(out);
        }
        "bulletItem" | "numberedItem" | "toggle" => {
            out.push_str(&format!("<li>{inner}"));
            kids(out);
            out.push_str("</li>");
        }
        "todoItem" => {
            let checked = content.attr("checked").and_then(Value::as_bool) == Some(true);
            out.push_str(&format!(
                "<li><input type=\"checkbox\" disabled{}> {inner}",
                if checked { " checked" } else { "" }
            ));
            kids(out);
            out.push_str("</li>");
        }
        "quote" => {
            out.push_str(&format!("<blockquote>{inner}"));
            kids(out);
            out.push_str("</blockquote>");
        }
        "callout" => {
            out.push_str(&format!("<aside class=\"callout\">{inner}"));
            kids(out);
            out.push_str("</aside>");
        }
        "codeBlock" => {
            let lang = esc(content.attr_str("language").unwrap_or("plain"));
            out.push_str(&format!(
                "<pre><code class=\"language-{lang}\">{}</code></pre>",
                esc(&inline_text(content))
            ));
        }
        "divider" => out.push_str("<hr>"),
        "mathBlock" => out.push_str(&format!(
            "<div class=\"math\">{}</div>",
            esc(content.attr_str("latex").unwrap_or(""))
        )),
        "image" => {
            let id = content.attr_str("assetId").unwrap_or("");
            let src = r.asset_href(id).unwrap_or_default();
            out.push_str(&format!(
                "<figure><img src=\"{}\" alt=\"{}\"><figcaption>{}</figcaption></figure>",
                esc(&src),
                esc(content.attr_str("caption").unwrap_or("")),
                esc(content.attr_str("caption").unwrap_or(""))
            ));
        }
        "file" => {
            let id = content.attr_str("assetId").unwrap_or("");
            let href = r.asset_href(id).unwrap_or_default();
            out.push_str(&format!(
                "<p><a href=\"{}\">{}</a></p>",
                esc(&href),
                esc(&href)
            ));
        }
        "pageRef" | "pageLink" => {
            let id = content.attr_str("pageId").unwrap_or("");
            out.push_str(&format!("<p>{}</p>", page_anchor(id, r)));
        }
        "table" => {
            out.push_str("<table>");
            for row in content.children() {
                out.push_str("<tr>");
                for cell in row.children() {
                    out.push_str(&format!("<td>{}</td>", inline(cell, r)));
                }
                out.push_str("</tr>");
            }
            out.push_str("</table>");
        }
        "columnList" => {
            out.push_str("<div class=\"columns\">");
            for col in content.children() {
                out.push_str("<div class=\"column\">");
                for g in col.children() {
                    group(g, r, out);
                }
                out.push_str("</div>");
            }
            out.push_str("</div>");
        }
        other => out.push_str(&format!("<div data-emp-block=\"{}\"></div>", esc(other))),
    }
}

fn page_anchor(id: &str, r: &dyn PageResolver) -> String {
    let title = esc(&r.title(id).unwrap_or_else(|| "Untitled".into()));
    let href = r.href(id).unwrap_or_else(|| format!("emp://page/{id}"));
    format!("<a href=\"{}\">{title}</a>", esc(&href))
}

fn inline(node: &TipTapNode, r: &dyn PageResolver) -> String {
    let mut s = String::new();
    for c in node.children() {
        match c.kind.as_str() {
            "text" => {
                let mut t = esc(c.text.as_deref().unwrap_or(""));
                for m in c.marks.iter().flatten() {
                    t = match m.kind.as_str() {
                        "bold" => format!("<strong>{t}</strong>"),
                        "italic" => format!("<em>{t}</em>"),
                        "underline" => format!("<u>{t}</u>"),
                        "strike" => format!("<s>{t}</s>"),
                        "code" => format!("<code>{t}</code>"),
                        "link" => {
                            let href = m
                                .attrs
                                .as_ref()
                                .and_then(|a| a.get("href"))
                                .and_then(Value::as_str)
                                .and_then(safe_href);
                            match href {
                                Some(h) => format!("<a href=\"{}\">{t}</a>", esc(h)),
                                None => t,
                            }
                        }
                        _ => t,
                    };
                }
                s.push_str(&t);
            }
            "hardBreak" => s.push_str("<br>"),
            "mention" => match c.attr_str("kind") {
                Some("date") => {
                    let d = c
                        .attr("date")
                        .and_then(|d| d.get("start"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    s.push_str(&format!("<time>{}</time>", esc(d)));
                }
                _ => s.push_str(&page_anchor(c.attr_str("pageId").unwrap_or(""), r)),
            },
            "emoji" => s.push_str(&esc(c.attr_str("native").unwrap_or(""))),
            "mathInline" => s.push_str(&format!(
                "<span class=\"math\">{}</span>",
                esc(c.attr_str("latex").unwrap_or(""))
            )),
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
    use serde_json::json;

    #[test]
    fn escapes_and_filters_links() {
        let mut evil = TipTapNode::text("<script>x</script>");
        evil.marks = Some(vec![TipTapMark {
            kind: "link".into(),
            attrs: Some(serde_json::from_value(json!({"href": "javascript:alert(1)"})).unwrap()),
        }]);
        let doc = TipTapDoc::from_blocks(vec![
            container(TipTapNode::new("paragraph").with_content(vec![evil]), None).unwrap(),
            container(
                TipTapNode::new("bulletItem").with_content(vec![TipTapNode::text("a")]),
                None,
            )
            .unwrap(),
            container(
                TipTapNode::new("bulletItem").with_content(vec![TipTapNode::text("b")]),
                None,
            )
            .unwrap(),
        ]);
        let h = to_html(&doc, &NoResolver);
        assert!(h.contains("&lt;script&gt;"));
        assert!(!h.contains("javascript:"));
        assert!(h.contains("<ul><li>a</li><li>b</li></ul>"));
    }
}
