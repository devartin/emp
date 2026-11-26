//! Plain-text rendering (clipboard `text/plain`, search previews).

use super::walk::{block_text, for_each_block};
use crate::model::TipTapDoc;

/// Renders a document as plain text: one line per block, nested blocks indented by two spaces, list markers kept.
#[must_use]
pub fn to_plain_text(doc: &TipTapDoc) -> String {
    let mut out = String::new();
    for_each_block(doc, &mut |b| {
        let text = block_text(b.content);
        let marker = match b.content.kind.as_str() {
            "bulletItem" | "toggle" => "• ",
            "todoItem" => {
                if b.content
                    .attr("checked")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                {
                    "[x] "
                } else {
                    "[ ] "
                }
            }
            "divider" => {
                out.push_str(&"  ".repeat(b.depth));
                out.push_str("---\n");
                return;
            }
            _ => "",
        };
        if text.is_empty() && marker.is_empty() {
            return;
        }
        for (i, line) in text.split('\n').enumerate() {
            out.push_str(&"  ".repeat(b.depth));
            if i == 0 {
                out.push_str(marker);
            }
            out.push_str(line);
            out.push('\n');
        }
    });
    if out.ends_with('\n') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::schema::container;
    use crate::model::TipTapNode;

    #[test]
    fn plain_text_with_markers() {
        let doc = TipTapDoc::from_blocks(vec![
            container(
                TipTapNode::new("paragraph").with_content(vec![TipTapNode::text("Hello")]),
                None,
            )
            .unwrap(),
            container(
                TipTapNode::new("bulletItem").with_content(vec![TipTapNode::text("item")]),
                None,
            )
            .unwrap(),
        ]);
        assert_eq!(to_plain_text(&doc), "Hello\n• item");
    }
}
