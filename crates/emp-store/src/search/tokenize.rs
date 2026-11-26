//! Tokenizer: Unicode word boundaries (UAX #29), diacritic folding (NFKD minus combining marks) and lowercasing.
//! Tokens keep byte offsets into the original text so snippets can highlight the exact source characters.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;
use unicode_segmentation::UnicodeSegmentation;

/// Longest indexed term (in chars); longer words are truncated.
pub const MAX_TERM_CHARS: usize = 48;

/// One token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    /// Normalised term.
    pub term: String,
    /// Byte offset of the word in the source text.
    pub start: usize,
    /// Byte end offset.
    pub end: usize,
}

/// Normalises a word: NFKD, combining marks removed, lowercased, truncated.
#[must_use]
pub fn normalize_term(word: &str) -> String {
    word.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .take(MAX_TERM_CHARS)
        .collect()
}

/// Splits text into tokens (words containing at least one alphanumeric character).
#[must_use]
pub fn tokenize(text: &str) -> Vec<Token> {
    text.split_word_bound_indices()
        .filter(|(_, w)| w.chars().any(char::is_alphanumeric))
        .map(|(start, w)| Token {
            term: normalize_term(w),
            start,
            end: start + w.len(),
        })
        .filter(|t| !t.term.is_empty())
        .collect()
}

/// Terms of a free-text query, in order (duplicates kept out).
#[must_use]
pub fn query_terms(q: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tokenize(q) {
        if !out.contains(&t.term) {
            out.push(t.term);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_case_and_diacritics() {
        let t = tokenize("Café CRÈME, naïve-test 42!");
        let terms: Vec<&str> = t.iter().map(|t| t.term.as_str()).collect();
        assert_eq!(terms, vec!["cafe", "creme", "naive", "test", "42"]);
        assert_eq!(&"Café CRÈME"[t[0].start..t[0].end], "Café");
    }

    #[test]
    fn cjk_and_punctuation() {
        let t = tokenize("東京 — hello");
        assert!(t.iter().any(|x| x.term == "hello"));
        assert!(t.len() >= 2);
        assert!(tokenize("--- ... !!!").is_empty());
    }
}
