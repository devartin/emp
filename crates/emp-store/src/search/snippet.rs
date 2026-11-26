//! Snippets with highlight ranges. Ranges are returned in UTF-16 code units (JavaScript string indices).

use super::tokenize::tokenize;
use crate::model::Snippet;

/// Characters shown before the first match.
pub const LEAD_CHARS: usize = 60;
/// Maximum snippet length in characters.
pub const MAX_CHARS: usize = 180;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Builds a snippet of `text` around the first token matching `terms` (exactly, or by prefix when `prefix_last`
/// is set for the last term).
#[must_use]
pub fn make_snippet(text: &str, terms: &[String], prefix_last: bool) -> Option<Snippet> {
    let matches = |term: &str| {
        terms.iter().enumerate().any(|(i, q)| {
            term == q || (prefix_last && i + 1 == terms.len() && term.starts_with(q.as_str()))
        })
    };
    let hits: Vec<(usize, usize)> = tokenize(text)
        .into_iter()
        .filter(|t| matches(&t.term))
        .map(|t| (t.start, t.end))
        .collect();
    let &(first, _) = hits.first()?;
    // Window start: LEAD_CHARS before the first hit, on a char boundary.
    let before: Vec<(usize, char)> = text[..first].char_indices().collect();
    let start = if before.len() > LEAD_CHARS {
        before[before.len() - LEAD_CHARS].0
    } else {
        0
    };
    let end = text[start..]
        .char_indices()
        .nth(MAX_CHARS)
        .map_or(text.len(), |(i, _)| start + i);
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.len() { "…" } else { "" };
    let body = &text[start..end];
    let mut out = String::with_capacity(body.len() + 6);
    out.push_str(prefix);
    out.push_str(body);
    out.push_str(suffix);
    let base = utf16_len(prefix);
    let ranges = hits
        .into_iter()
        .filter(|(s, e)| *s >= start && *e <= end)
        .map(|(s, e)| {
            let a = base + utf16_len(&text[start..s]);
            [a, a + utf16_len(&text[s..e])]
        })
        .collect();
    Some(Snippet {
        text: out.replace('\n', " "),
        ranges,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_in_utf16_units() {
        let s = make_snippet("😀 grocery budget for june", &["budget".into()], false).unwrap();
        assert_eq!(s.ranges, vec![[11, 17]]);
        let as_utf16: Vec<u16> = s.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&as_utf16[11..17]).unwrap(), "budget");
    }

    #[test]
    fn long_text_is_windowed() {
        let text = format!("{} needle {}", "word ".repeat(100), "tail ".repeat(100));
        let s = make_snippet(&text, &["needle".into()], false).unwrap();
        assert!(s.text.starts_with('…') && s.text.ends_with('…'));
        let r = s.ranges[0];
        let u: Vec<u16> = s.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&u[r[0]..r[1]]).unwrap(), "needle");
    }

    #[test]
    fn prefix_matching() {
        assert!(make_snippet("budgeting tips", &["budg".into()], true).is_some());
        assert!(make_snippet("budgeting tips", &["budg".into()], false).is_none());
    }
}
