//! Google Docs API (`documents.get`) → HTML conversion (SPEC §17.1 block mapping).
//!
//! | Docs element | HTML |
//! |---|---|
//! | `TITLE` | returned as the page title (not emitted) |
//! | `HEADING_1`–`HEADING_6` | `<h1>`–`<h6>` |
//! | bullets | `<ul>` / `<ol>` by the level's `glyphType`, nested by `nestingLevel` |
//! | tables | `<table><tr><td>` |
//! | bold / italic / underline / strike / links | `<strong>` `<em>` `<u>` `<s>` `<a href>` |
//! | text colour | `<span data-color="<block colour>">` |
//! | horizontal rule | `<hr>` |
//! | footnotes | `<sup>[n]</sup>` + an ordered list at the end |
//! | inline images, comments, suggestions, headers/footers | dropped, with a warning |
//!
//! The output is plain, attribute-minimal HTML for the app's sanitising HTML import path.

use std::collections::HashMap;
use std::fmt::Write as _;

use serde::Deserialize;

use super::convert::nearest_block_color;
use crate::error::Result;

/// Maximum structural nesting (tables inside tables …) followed.
const MAX_DEPTH: usize = 16;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Document {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: BodyContent,
    #[serde(default)]
    lists: HashMap<String, List>,
    #[serde(default)]
    footnotes: HashMap<String, Footnote>,
    #[serde(default)]
    headers: HashMap<String, serde_json::Value>,
    #[serde(default)]
    footers: HashMap<String, serde_json::Value>,
    #[serde(default)]
    inline_objects: HashMap<String, serde_json::Value>,
    #[serde(default)]
    positioned_objects: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct BodyContent {
    #[serde(default)]
    content: Vec<Element>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct List {
    #[serde(default)]
    list_properties: ListProperties,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListProperties {
    #[serde(default)]
    nesting_levels: Vec<NestingLevel>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NestingLevel {
    glyph_type: Option<String>,
}

#[derive(Deserialize, Default)]
struct Footnote {
    #[serde(default)]
    content: Vec<Element>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Element {
    paragraph: Option<Paragraph>,
    table: Option<Table>,
    table_of_contents: Option<BodyContent>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Paragraph {
    #[serde(default)]
    elements: Vec<ParagraphElement>,
    paragraph_style: Option<ParagraphStyle>,
    bullet: Option<Bullet>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ParagraphStyle {
    named_style_type: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Bullet {
    list_id: Option<String>,
    nesting_level: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ParagraphElement {
    text_run: Option<TextRun>,
    horizontal_rule: Option<serde_json::Value>,
    footnote_reference: Option<FootnoteRef>,
    inline_object_element: Option<serde_json::Value>,
    #[serde(default)]
    suggested_insertion_ids: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TextRun {
    #[serde(default)]
    content: String,
    text_style: Option<TextStyle>,
    #[serde(default)]
    suggested_insertion_ids: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TextStyle {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    strikethrough: Option<bool>,
    link: Option<Link>,
    foreground_color: Option<OptionalColor>,
}

#[derive(Deserialize, Default)]
struct Link {
    url: Option<String>,
}

#[derive(Deserialize, Default)]
struct OptionalColor {
    color: Option<Color>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Color {
    rgb_color: Option<Rgb>,
}

#[derive(Deserialize, Default)]
struct Rgb {
    #[serde(default)]
    red: f64,
    #[serde(default)]
    green: f64,
    #[serde(default)]
    blue: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FootnoteRef {
    footnote_id: Option<String>,
    footnote_number: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Table {
    #[serde(default)]
    table_rows: Vec<TableRow>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TableRow {
    #[serde(default)]
    table_cells: Vec<TableCell>,
}

#[derive(Deserialize, Default)]
struct TableCell {
    #[serde(default)]
    content: Vec<Element>,
}

/// Result of converting a Docs API document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedDoc {
    /// Page title (the `TITLE` paragraph, else the document title).
    pub title: String,
    /// HTML body.
    pub html: String,
    /// Import warnings.
    pub warnings: Vec<String>,
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '\u{000b}' => out.push_str("<br>"),
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

fn safe_link(url: &str) -> Option<&str> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        .then_some(u)
}

struct Ctx<'a> {
    doc: &'a Document,
    footnote_order: Vec<String>,
    images: usize,
    suggestions: usize,
    title: Option<String>,
}

impl Ctx<'_> {
    fn ordered(&self, list_id: &str, level: usize) -> bool {
        self.doc
            .lists
            .get(list_id)
            .and_then(|l| l.list_properties.nesting_levels.get(level))
            .and_then(|n| n.glyph_type.as_deref())
            .is_some_and(|g| {
                matches!(
                    g,
                    "DECIMAL" | "ZERO_DECIMAL" | "ALPHA" | "UPPER_ALPHA" | "ROMAN" | "UPPER_ROMAN"
                )
            })
    }

    fn inline(&mut self, p: &Paragraph) -> String {
        let mut out = String::new();
        for el in &p.elements {
            if !el.suggested_insertion_ids.is_empty() {
                self.suggestions += 1;
                continue;
            }
            if el.inline_object_element.is_some() {
                self.images += 1;
            }
            if el.horizontal_rule.is_some() {
                out.push_str("\u{0}HR\u{0}");
            }
            if let Some(f) = &el.footnote_reference {
                let id = f.footnote_id.clone().unwrap_or_default();
                if !self.footnote_order.contains(&id) {
                    self.footnote_order.push(id);
                }
                let n = f
                    .footnote_number
                    .clone()
                    .unwrap_or_else(|| self.footnote_order.len().to_string());
                let _ = write!(out, "<sup>[{}]</sup>", escape(&n));
            }
            let Some(run) = &el.text_run else { continue };
            if !run.suggested_insertion_ids.is_empty() {
                self.suggestions += 1;
                continue;
            }
            let text = run.content.trim_end_matches('\n');
            if text.is_empty() {
                continue;
            }
            let mut html = escape(text);
            if let Some(st) = &run.text_style {
                if let Some(rgb) = st
                    .foreground_color
                    .as_ref()
                    .and_then(|c| c.color.as_ref())
                    .and_then(|c| c.rgb_color.as_ref())
                {
                    let to = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                    let hex = format!(
                        "#{:02x}{:02x}{:02x}",
                        to(rgb.red),
                        to(rgb.green),
                        to(rgb.blue)
                    );
                    // Near-black text is the default colour; don't tag it.
                    if rgb.red.max(rgb.green).max(rgb.blue) > 0.2 {
                        html = format!(
                            "<span data-color=\"{}\">{html}</span>",
                            nearest_block_color(&hex).as_str()
                        );
                    }
                }
                if st.strikethrough == Some(true) {
                    html = format!("<s>{html}</s>");
                }
                if st.underline == Some(true) && st.link.is_none() {
                    html = format!("<u>{html}</u>");
                }
                if st.italic == Some(true) {
                    html = format!("<em>{html}</em>");
                }
                if st.bold == Some(true) {
                    html = format!("<strong>{html}</strong>");
                }
                if let Some(url) = st
                    .link
                    .as_ref()
                    .and_then(|l| l.url.as_deref())
                    .and_then(safe_link)
                {
                    html = format!("<a href=\"{}\">{html}</a>", escape(url));
                }
            }
            out.push_str(&html);
        }
        out
    }

    fn blocks(&mut self, elements: &[Element], depth: usize, out: &mut String) {
        if depth > MAX_DEPTH {
            return;
        }
        // Stack of open lists: (list id, level, ordered).
        let mut open: Vec<(String, usize, bool)> = Vec::new();
        let close_to = |out: &mut String, open: &mut Vec<(String, usize, bool)>, keep: usize| {
            while open.len() > keep {
                if let Some((_, _, ordered)) = open.pop() {
                    out.push_str(if ordered { "</li></ol>" } else { "</li></ul>" });
                }
            }
        };
        for el in elements {
            if let Some(p) = &el.paragraph {
                let style = p
                    .paragraph_style
                    .as_ref()
                    .and_then(|s| s.named_style_type.as_deref())
                    .unwrap_or("NORMAL_TEXT");
                let inner = self.inline(p);
                if let Some(b) = &p.bullet {
                    let list_id = b.list_id.clone().unwrap_or_default();
                    let level = b.nesting_level.unwrap_or(0).min(8) as usize;
                    // Close deeper levels or other lists.
                    while let Some((id, lvl, _)) = open.last() {
                        if *id != list_id || *lvl > level {
                            let keep = open.len() - 1;
                            close_to(out, &mut open, keep);
                        } else {
                            break;
                        }
                    }
                    match open.last() {
                        Some((_, lvl, _)) if *lvl == level => out.push_str("</li><li>"),
                        _ => {
                            let ordered = self.ordered(&list_id, level);
                            out.push_str(if ordered { "<ol><li>" } else { "<ul><li>" });
                            open.push((list_id, level, ordered));
                        }
                    }
                    out.push_str(&inner);
                    continue;
                }
                close_to(out, &mut open, 0);
                for (i, part) in inner.split("\u{0}HR\u{0}").enumerate() {
                    if i > 0 {
                        out.push_str("<hr>");
                    }
                    if part.trim().is_empty() {
                        continue;
                    }
                    match style {
                        "TITLE" if self.title.is_none() => {
                            self.title = Some(html_to_text(part));
                        }
                        "HEADING_1" | "HEADING_2" | "HEADING_3" | "HEADING_4" | "HEADING_5"
                        | "HEADING_6" => {
                            let n = &style[8..];
                            let _ = write!(out, "<h{n}>{part}</h{n}>");
                        }
                        "TITLE" => {
                            let _ = write!(out, "<h1>{part}</h1>");
                        }
                        _ => {
                            let _ = write!(out, "<p>{part}</p>");
                        }
                    }
                }
            } else if let Some(t) = &el.table {
                close_to(out, &mut open, 0);
                out.push_str("<table>");
                for row in &t.table_rows {
                    out.push_str("<tr>");
                    for cell in &row.table_cells {
                        out.push_str("<td>");
                        let mut inner = String::new();
                        self.blocks(&cell.content, depth + 1, &mut inner);
                        out.push_str(&inner);
                        out.push_str("</td>");
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</table>");
            } else if let Some(toc) = &el.table_of_contents {
                close_to(out, &mut open, 0);
                self.blocks(&toc.content, depth + 1, out);
            }
        }
        close_to(out, &mut open, 0);
    }
}

fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

/// Convert a `documents.get` JSON body to HTML.
pub fn convert_document(body: &[u8]) -> Result<ConvertedDoc> {
    let doc: Document = crate::netguard::decode_json(body)?;
    let mut ctx = Ctx {
        doc: &doc,
        footnote_order: Vec::new(),
        images: 0,
        suggestions: 0,
        title: None,
    };
    let mut html = String::new();
    ctx.blocks(&doc.body.content, 0, &mut html);
    if !ctx.footnote_order.is_empty() {
        html.push_str("<hr><ol>");
        let ids = ctx.footnote_order.clone();
        for id in ids {
            let mut inner = String::new();
            if let Some(f) = doc.footnotes.get(&id) {
                ctx.blocks(&f.content, 1, &mut inner);
            }
            let _ = write!(html, "<li>{inner}</li>");
        }
        html.push_str("</ol>");
    }
    let mut warnings = Vec::new();
    let images = ctx.images + doc.positioned_objects.len();
    if images > 0 || !doc.inline_objects.is_empty() {
        warnings.push(format!(
            "{} image(s) were not imported.",
            images.max(doc.inline_objects.len())
        ));
    }
    if ctx.suggestions > 0 {
        warnings.push("Suggested edits were dropped.".to_string());
    }
    if !doc.headers.is_empty() || !doc.footers.is_empty() {
        warnings.push("Headers and footers were dropped.".to_string());
    }
    warnings.push("Comments are not imported.".to_string());
    let title = ctx
        .title
        .take()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| doc.title.trim().to_string());
    Ok(ConvertedDoc {
        title,
        html,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r##"{
      "documentId": "d1", "title": "File name",
      "body": {"content": [
        {"sectionBreak": {}},
        {"paragraph": {"paragraphStyle": {"namedStyleType": "TITLE"}, "elements": [{"textRun": {"content": "Trip <plan>\n"}}]}},
        {"paragraph": {"paragraphStyle": {"namedStyleType": "HEADING_1"}, "elements": [{"textRun": {"content": "Day 1\n"}}]}},
        {"paragraph": {"paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}, "elements": [
          {"textRun": {"content": "Bold", "textStyle": {"bold": true}}},
          {"textRun": {"content": " and ", "textStyle": {}}},
          {"textRun": {"content": "link", "textStyle": {"link": {"url": "https://example.com/?a=1&b=2"}, "underline": true}}},
          {"textRun": {"content": " bad", "textStyle": {"link": {"url": "javascript:alert(1)"}}}},
          {"textRun": {"content": " red", "textStyle": {"foregroundColor": {"color": {"rgbColor": {"red": 0.86, "green": 0.13, "blue": 0.15}}}}}},
          {"footnoteReference": {"footnoteId": "fn1", "footnoteNumber": "1"}},
          {"textRun": {"content": "\n"}}]}},
        {"paragraph": {"bullet": {"listId": "L1"}, "elements": [{"textRun": {"content": "one\n"}}]}},
        {"paragraph": {"bullet": {"listId": "L1", "nestingLevel": 1}, "elements": [{"textRun": {"content": "one.a\n"}}]}},
        {"paragraph": {"bullet": {"listId": "L1"}, "elements": [{"textRun": {"content": "two\n"}}]}},
        {"paragraph": {"bullet": {"listId": "L2"}, "elements": [{"textRun": {"content": "dot\n"}}]}},
        {"paragraph": {"elements": [{"horizontalRule": {}}, {"textRun": {"content": "\n"}}]}},
        {"table": {"rows": 1, "columns": 2, "tableRows": [{"tableCells": [
          {"content": [{"paragraph": {"elements": [{"textRun": {"content": "A\n"}}]}}]},
          {"content": [{"paragraph": {"elements": [{"textRun": {"content": "B\n", "textStyle": {"italic": true, "strikethrough": true}}}]}}]}
        ]}]}},
        {"paragraph": {"elements": [{"inlineObjectElement": {"inlineObjectId": "img1"}}, {"textRun": {"content": "x\n", "suggestedInsertionIds": ["s1"]}}]}}
      ]},
      "lists": {
        "L1": {"listProperties": {"nestingLevels": [{"glyphType": "DECIMAL"}, {"glyphType": "ALPHA"}]}},
        "L2": {"listProperties": {"nestingLevels": [{"glyphSymbol": "●"}]}}
      },
      "footnotes": {"fn1": {"footnoteId": "fn1", "content": [{"paragraph": {"elements": [{"textRun": {"content": "Source.\n"}}]}}]}},
      "headers": {"h1": {}},
      "inlineObjects": {"img1": {}}
    }"##;

    #[test]
    fn converts_fixture() {
        let c = convert_document(DOC.as_bytes()).unwrap();
        assert_eq!(c.title, "Trip <plan>");
        let h = &c.html;
        assert!(h.starts_with("<h1>Day 1</h1>"), "{h}");
        assert!(h.contains(
            "<strong>Bold</strong> and <a href=\"https://example.com/?a=1&amp;b=2\">link</a> bad"
        ));
        assert!(!h.contains("javascript"));
        assert!(h.contains("<span data-color=\"red\"> red</span><sup>[1]</sup>"));
        assert!(
            h.contains(
                "<ol><li>one<ol><li>one.a</li></ol></li><li>two</li></ol><ul><li>dot</li></ul>"
            ),
            "{h}"
        );
        assert!(h.contains("<hr>"));
        assert!(h.contains(
            "<table><tr><td><p>A</p></td><td><p><em><s>B</s></em></p></td></tr></table>"
        ));
        assert!(h.ends_with("<hr><ol><li><p>Source.</p></li></ol>"));
        assert!(!h.contains(">x<"));
        assert!(c.warnings.iter().any(|w| w.contains("image")));
        assert!(c.warnings.iter().any(|w| w.contains("Suggested")));
        assert!(c.warnings.iter().any(|w| w.contains("Headers")));
    }

    #[test]
    fn empty_and_invalid() {
        let c = convert_document(br#"{"title":"Empty"}"#).unwrap();
        assert_eq!(c.title, "Empty");
        assert_eq!(c.html, "");
        assert!(convert_document(b"42").is_err());
    }
}
