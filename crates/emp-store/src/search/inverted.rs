//! The inverted index: term → postings `(doc, field, tf)`. A `BTreeMap` keeps terms sorted so prefix expansion of
//! the last query word is a range scan.

use std::collections::BTreeMap;

/// Field number of a document's title; block `n` is field `n + 1`.
pub const TITLE_FIELD: u32 = 0;

/// One posting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Posting {
    /// Internal document number.
    pub doc: u32,
    /// Field (title or block).
    pub field: u32,
    /// Term frequency in the field.
    pub tf: u32,
}

/// Term dictionary with postings lists.
#[derive(Debug, Default, Clone)]
pub struct Inverted {
    terms: BTreeMap<String, Vec<Posting>>,
}

impl Inverted {
    /// Adds a posting.
    pub fn add(&mut self, term: &str, posting: Posting) {
        match self.terms.get_mut(term) {
            Some(v) => v.push(posting),
            None => {
                self.terms.insert(term.to_owned(), vec![posting]);
            }
        }
    }

    /// Removes every posting of `doc` under the given terms.
    pub fn remove_doc(&mut self, doc: u32, terms: &[String]) {
        for t in terms {
            if let Some(v) = self.terms.get_mut(t) {
                v.retain(|p| p.doc != doc);
                if v.is_empty() {
                    self.terms.remove(t);
                }
            }
        }
    }

    /// Exact postings.
    #[must_use]
    pub fn get(&self, term: &str) -> &[Posting] {
        self.terms.get(term).map_or(&[], Vec::as_slice)
    }

    /// Terms starting with `prefix` (excluding the exact term), at most `limit`.
    pub fn prefixed<'a>(
        &'a self,
        prefix: &'a str,
        limit: usize,
    ) -> impl Iterator<Item = (&'a str, &'a [Posting])> + 'a {
        self.terms
            .range::<str, _>((
                std::ops::Bound::Excluded(prefix),
                std::ops::Bound::Unbounded,
            ))
            .take_while(move |(t, _)| t.starts_with(prefix))
            .take(limit)
            .map(|(t, v)| (t.as_str(), v.as_slice()))
    }

    /// Number of distinct terms.
    #[must_use]
    pub fn len(&self) -> usize {
        self.terms.len()
    }

    /// `true` if empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_prefix_remove() {
        let mut i = Inverted::default();
        i.add(
            "budget",
            Posting {
                doc: 1,
                field: 0,
                tf: 1,
            },
        );
        i.add(
            "budgeting",
            Posting {
                doc: 2,
                field: 1,
                tf: 2,
            },
        );
        i.add(
            "bud",
            Posting {
                doc: 3,
                field: 1,
                tf: 1,
            },
        );
        assert_eq!(i.get("budget").len(), 1);
        let p: Vec<&str> = i.prefixed("bud", 10).map(|(t, _)| t).collect();
        assert_eq!(p, vec!["budget", "budgeting"]);
        i.remove_doc(1, &["budget".into()]);
        assert!(i.get("budget").is_empty());
        assert_eq!(i.len(), 2);
    }
}
