//! Fuzzy title matching with `nucleo-matcher` (quick find: "mtg nts" finds "Meeting notes").

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

/// A compiled fuzzy pattern plus a reusable matcher.
pub struct TitleMatcher {
    pattern: Pattern,
    matcher: Matcher,
    buf: Vec<char>,
    empty: bool,
}

impl std::fmt::Debug for TitleMatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TitleMatcher")
    }
}

impl TitleMatcher {
    /// Compiles `query` (case-insensitive, diacritic-insensitive).
    #[must_use]
    pub fn new(query: &str) -> Self {
        Self {
            pattern: Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart),
            matcher: Matcher::new(Config::DEFAULT),
            buf: Vec::new(),
            empty: query.trim().is_empty(),
        }
    }

    /// Score of `title`, if it matches.
    pub fn score(&mut self, title: &str) -> Option<u32> {
        if self.empty {
            return None;
        }
        self.pattern
            .score(Utf32Str::new(title, &mut self.buf), &mut self.matcher)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_matches_abbreviations() {
        let mut m = TitleMatcher::new("mtg nts");
        assert!(m.score("Meeting notes").is_some());
        assert!(m.score("Budget").is_none());
        let mut m = TitleMatcher::new("cafe");
        assert!(m.score("Café plans").is_some());
        let mut e = TitleMatcher::new("  ");
        assert!(e.score("anything").is_none());
    }

    #[test]
    fn closer_matches_score_higher() {
        let mut m = TitleMatcher::new("budget");
        let exact = m.score("Budget").unwrap();
        let loose = m
            .score("Big unusual dog gets everything today")
            .unwrap_or(0);
        assert!(exact > loose);
    }
}
