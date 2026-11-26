//! In-memory search index (SPEC §0.1: built after unlock, never persisted).
//!
//! * [`tokenize`]: UAX #29 words, case and diacritic folding.
//! * [`inverted`]: term → postings with prefix expansion.
//! * [`titles`]: nucleo fuzzy title matching.
//! * [`rank`]: BM25 with title boost, fuzzy bonus, recency.
//! * [`snippet`]: highlighted snippets (UTF-16 ranges).
//!
//! The index holds [`SearchDoc`]s (pages now; rows, databases, sheets and assets can be added by other
//! repositories through [`crate::Store::search_upsert_doc`]). Queries understand `in:<pageId>`,
//! `type:<kind>[,<kind>]`, `db:<databaseId>` and `edited:<today|yesterday|week|month|Nd|YYYY-MM-DD>` operators.

pub mod inverted;
pub mod rank;
pub mod service;
pub mod snippet;
pub mod titles;
pub mod tokenize;

use std::collections::HashMap;

use crate::model::{Icon, SearchFilters, SearchHit, SearchHitKind};

/// The backlink index type (re-exported for the service).
pub(crate) type LinkIndexAlias = crate::doc::index::LinkIndex;
use inverted::{Inverted, Posting, TITLE_FIELD};

/// Maximum prefix expansions of the last query word.
pub const MAX_PREFIX_EXPANSIONS: usize = 64;
/// Maximum ancestor depth used for paths.
pub const MAX_PATH_DEPTH: usize = 32;

/// A document in the index.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchDoc {
    /// Page / row / asset id.
    pub id: String,
    /// Kind.
    pub kind: SearchHitKind,
    /// Title.
    pub title: String,
    /// Icon.
    pub icon: Option<Icon>,
    /// Parent page (pages) or database page (rows), for paths and `in:`.
    pub parent_id: Option<String>,
    /// Database id (rows).
    pub db_id: Option<String>,
    /// Last edit.
    pub updated_at: i64,
    /// `(blockId, text)` of the body.
    pub blocks: Vec<(String, String)>,
    /// Hidden from results (trashed).
    pub hidden: bool,
}

#[derive(Debug, Clone)]
struct Entry {
    doc: SearchDoc,
    terms: Vec<String>,
    field_lens: Vec<u32>,
}

/// The index.
#[derive(Debug, Default, Clone)]
pub struct SearchIndex {
    entries: Vec<Option<Entry>>,
    by_id: HashMap<String, u32>,
    free: Vec<u32>,
    inv: Inverted,
    total_field_len: u64,
    total_fields: u64,
}

/// A parsed query.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedQuery {
    /// Free text without operators.
    pub text: String,
    /// Normalised terms.
    pub terms: Vec<String>,
    /// Whether the last term is still being typed (prefix match).
    pub prefix_last: bool,
    /// Subtree restriction.
    pub within: Option<String>,
    /// Kind restriction.
    pub kinds: Option<Vec<SearchHitKind>>,
    /// Database restriction.
    pub db: Option<String>,
    /// Edited from (inclusive).
    pub edited_from: Option<i64>,
    /// Edited to (inclusive).
    pub edited_to: Option<i64>,
}

const DAY_MS: i64 = 86_400_000;

fn parse_edited(v: &str, now: i64) -> Option<i64> {
    let start_of_day = now - now.rem_euclid(DAY_MS);
    match v {
        "today" => Some(start_of_day),
        "yesterday" => Some(start_of_day - DAY_MS),
        "week" => Some(now - 7 * DAY_MS),
        "month" => Some(now - 30 * DAY_MS),
        _ => {
            if let Some(n) = v.strip_suffix('d').and_then(|n| n.parse::<i64>().ok()) {
                return Some(now - n.clamp(0, 36_500) * DAY_MS);
            }
            chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc().timestamp_millis())
        }
    }
}

/// Parses a raw query and merges explicit filters (explicit filters win).
#[must_use]
pub fn parse_query(q: &str, filters: Option<&SearchFilters>, now: i64) -> ParsedQuery {
    let mut out = ParsedQuery::default();
    let mut text = Vec::new();
    for word in q.split_whitespace() {
        if let Some((op, val)) = word.split_once(':')
            && !val.is_empty()
        {
            match op {
                "in" => {
                    out.within = Some(val.to_owned());
                    continue;
                }
                "type" => {
                    let kinds: Vec<SearchHitKind> =
                        val.split(',').filter_map(SearchHitKind::parse).collect();
                    if !kinds.is_empty() {
                        out.kinds = Some(kinds);
                        continue;
                    }
                }
                "db" => {
                    out.db = Some(val.to_owned());
                    continue;
                }
                "edited" => {
                    if let Some(t) = parse_edited(val, now) {
                        out.edited_from = Some(t);
                        continue;
                    }
                }
                _ => {}
            }
        }
        text.push(word);
    }
    out.text = text.join(" ");
    out.terms = tokenize::query_terms(&out.text);
    out.prefix_last = !q.ends_with(char::is_whitespace) && !out.terms.is_empty();
    if let Some(f) = filters {
        if f.within.is_some() {
            out.within.clone_from(&f.within);
        }
        if f.kinds.is_some() {
            out.kinds.clone_from(&f.kinds);
        }
        if f.db.is_some() {
            out.db.clone_from(&f.db);
        }
        if let Some(e) = &f.edited {
            if e.from.is_some() {
                out.edited_from = e.from;
            }
            if e.to.is_some() {
                out.edited_to = e.to;
            }
        }
    }
    out
}

impl SearchIndex {
    /// Number of indexed documents.
    #[must_use]
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    /// `true` if empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// The stored document.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&SearchDoc> {
        let n = *self.by_id.get(id)?;
        self.entries.get(n as usize)?.as_ref().map(|e| &e.doc)
    }

    /// Adds or replaces a document.
    pub fn upsert(&mut self, doc: SearchDoc) {
        self.remove(&doc.id);
        let n = match self.free.pop() {
            Some(n) => n,
            None => {
                self.entries.push(None);
                u32::try_from(self.entries.len() - 1).unwrap_or(u32::MAX)
            }
        };
        let mut fields: Vec<&str> = vec![doc.title.as_str()];
        fields.extend(doc.blocks.iter().map(|(_, t)| t.as_str()));
        let mut all_terms: Vec<String> = Vec::new();
        let mut field_lens = Vec::with_capacity(fields.len());
        for (fi, text) in fields.iter().enumerate() {
            let toks = tokenize::tokenize(text);
            field_lens.push(u32::try_from(toks.len()).unwrap_or(u32::MAX));
            let mut tf: HashMap<&str, u32> = HashMap::new();
            for t in &toks {
                *tf.entry(t.term.as_str()).or_default() += 1;
            }
            for (term, count) in tf {
                self.inv.add(
                    term,
                    Posting {
                        doc: n,
                        field: u32::try_from(fi).unwrap_or(u32::MAX),
                        tf: count,
                    },
                );
                all_terms.push(term.to_owned());
            }
        }
        all_terms.sort();
        all_terms.dedup();
        self.total_field_len += field_lens.iter().map(|l| u64::from(*l)).sum::<u64>();
        self.total_fields += field_lens.len() as u64;
        self.by_id.insert(doc.id.clone(), n);
        if let Some(slot) = self.entries.get_mut(n as usize) {
            *slot = Some(Entry {
                doc,
                terms: all_terms,
                field_lens,
            });
        }
    }

    /// Removes a document.
    pub fn remove(&mut self, id: &str) {
        let Some(n) = self.by_id.remove(id) else {
            return;
        };
        if let Some(e) = self.entries.get_mut(n as usize).and_then(Option::take) {
            self.inv.remove_doc(n, &e.terms);
            self.total_field_len -= e.field_lens.iter().map(|l| u64::from(*l)).sum::<u64>();
            self.total_fields -= e.field_lens.len() as u64;
            self.free.push(n);
        }
    }

    /// Updates title / icon / parent / visibility without re-tokenising the body.
    pub fn update_meta(
        &mut self,
        id: &str,
        title: &str,
        icon: Option<Icon>,
        parent_id: Option<String>,
        updated_at: i64,
        hidden: bool,
    ) {
        let Some(doc) = self.get(id).cloned() else {
            return;
        };
        if doc.title != title {
            self.upsert(SearchDoc {
                title: title.to_owned(),
                icon,
                parent_id,
                updated_at,
                hidden,
                ..doc
            });
        } else if let Some(Some(e)) = self
            .by_id
            .get(id)
            .copied()
            .and_then(|n| self.entries.get_mut(n as usize))
        {
            e.doc.icon = icon;
            e.doc.parent_id = parent_id;
            e.doc.updated_at = updated_at;
            e.doc.hidden = hidden;
        }
    }

    /// Hides / shows a document (trash / restore).
    pub fn set_hidden(&mut self, id: &str, hidden: bool) {
        if let Some(Some(e)) = self
            .by_id
            .get(id)
            .copied()
            .and_then(|n| self.entries.get_mut(n as usize))
        {
            e.doc.hidden = hidden;
        }
    }

    /// Ancestor titles of a document, root first.
    #[must_use]
    pub fn path(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = self.get(id).and_then(|d| d.parent_id.clone());
        while let Some(p) = cur {
            if out.len() >= MAX_PATH_DEPTH {
                break;
            }
            match self.get(&p) {
                Some(d) => {
                    out.push(if d.title.is_empty() {
                        "Untitled".to_owned()
                    } else {
                        d.title.clone()
                    });
                    cur = d.parent_id.clone();
                }
                None => break,
            }
        }
        out.reverse();
        out
    }

    fn is_within(&self, id: &str, root: &str) -> bool {
        let mut cur = Some(id.to_owned());
        let mut depth = 0;
        while let Some(c) = cur {
            if c == root {
                return true;
            }
            depth += 1;
            if depth > MAX_PATH_DEPTH {
                return false;
            }
            cur = self.get(&c).and_then(|d| d.parent_id.clone());
        }
        false
    }

    fn passes(&self, d: &SearchDoc, q: &ParsedQuery) -> bool {
        if d.hidden {
            return false;
        }
        if let Some(k) = &q.kinds {
            let kind_ok = k.contains(&d.kind)
                || (k.contains(&SearchHitKind::Block) && d.kind == SearchHitKind::Page);
            if !kind_ok {
                return false;
            }
        }
        if let Some(db) = &q.db
            && d.db_id.as_deref() != Some(db.as_str())
        {
            return false;
        }
        if q.edited_from.is_some_and(|f| d.updated_at < f)
            || q.edited_to.is_some_and(|t| d.updated_at > t)
        {
            return false;
        }
        if let Some(root) = &q.within
            && (!self.is_within(&d.id, root) || d.id == *root)
        {
            return false;
        }
        true
    }

    /// Runs a query.
    #[must_use]
    pub fn query(&self, q: &ParsedQuery, limit: usize, now: i64) -> Vec<SearchHit> {
        let limit = limit.clamp(1, 200);
        let n_docs = self.len().max(1);
        let avg = if self.total_fields == 0 {
            1.0
        } else {
            self.total_field_len as f64 / self.total_fields as f64
        };
        // Per doc: score, matched-term bitmap, best body field (score, field).
        struct Acc {
            score: f64,
            matched: u64,
            best_field: Option<(f64, u32)>,
        }
        let mut acc: HashMap<u32, Acc> = HashMap::new();
        let n_terms = q.terms.len().min(64);
        for (ti, term) in q.terms.iter().take(64).enumerate() {
            let mut lists: Vec<(&[Posting], f64)> = vec![(self.inv.get(term), 1.0)];
            if q.prefix_last && ti + 1 == n_terms {
                lists.extend(
                    self.inv
                        .prefixed(term, MAX_PREFIX_EXPANSIONS)
                        .map(|(_, p)| (p, rank::PREFIX_WEIGHT)),
                );
            }
            for (postings, weight) in lists {
                if postings.is_empty() {
                    continue;
                }
                let idf = rank::idf(n_docs, postings.len());
                for p in postings {
                    let Some(Some(e)) = self.entries.get(p.doc as usize) else {
                        continue;
                    };
                    let len = e.field_lens.get(p.field as usize).copied().unwrap_or(1);
                    let mut s = rank::bm25(p.tf, len, avg, idf) * weight;
                    if p.field == TITLE_FIELD {
                        s *= rank::TITLE_BOOST;
                    }
                    let a = acc.entry(p.doc).or_insert(Acc {
                        score: 0.0,
                        matched: 0,
                        best_field: None,
                    });
                    a.score += s;
                    a.matched |= 1 << ti;
                    if p.field != TITLE_FIELD && a.best_field.is_none_or(|(bs, _)| s > bs) {
                        a.best_field = Some((s, p.field));
                    }
                }
            }
        }
        let all_mask: u64 = if n_terms == 0 {
            0
        } else if n_terms >= 64 {
            u64::MAX
        } else {
            (1u64 << n_terms) - 1
        };
        let mut fuzzy = titles::TitleMatcher::new(&q.text);
        let mut scored: Vec<(f64, u32, Option<u32>)> = Vec::new();
        for (n, slot) in self.entries.iter().enumerate() {
            let Some(e) = slot else { continue };
            if !self.passes(&e.doc, q) {
                continue;
            }
            let n = u32::try_from(n).unwrap_or(u32::MAX);
            let full = acc.get(&n).filter(|a| a.matched == all_mask && n_terms > 0);
            let fz = fuzzy.score(&e.doc.title);
            if n_terms > 0 && full.is_none() && fz.is_none() {
                continue;
            }
            let mut score = full.map_or(0.0, |a| a.score);
            if let Some(f) = fz {
                score += f64::from(f) / rank::FUZZY_DIVISOR;
            }
            score += rank::recency(now, e.doc.updated_at);
            scored.push((score, n, full.and_then(|a| a.best_field.map(|(_, f)| f))));
        }
        scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        scored
            .into_iter()
            .take(limit)
            .filter_map(|(score, n, field)| {
                let e = self.entries.get(n as usize)?.as_ref()?;
                let block = field
                    .and_then(|f| f.checked_sub(1))
                    .and_then(|i| e.doc.blocks.get(i as usize));
                let snippet = block
                    .and_then(|(_, text)| snippet::make_snippet(text, &q.terms, q.prefix_last));
                Some(SearchHit {
                    id: e.doc.id.clone(),
                    kind: e.doc.kind,
                    title: e.doc.title.clone(),
                    icon: e.doc.icon.clone(),
                    path: self.path(&e.doc.id),
                    snippet,
                    block_id: block.map(|(id, _)| id.clone()).filter(|s| !s.is_empty()),
                    score: (score * 1000.0).round() / 1000.0,
                    updated_at: e.doc.updated_at,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(
        id: &str,
        title: &str,
        parent: Option<&str>,
        blocks: &[(&str, &str)],
        at: i64,
    ) -> SearchDoc {
        SearchDoc {
            id: id.into(),
            kind: SearchHitKind::Page,
            title: title.into(),
            icon: None,
            parent_id: parent.map(Into::into),
            db_id: None,
            updated_at: at,
            blocks: blocks
                .iter()
                .map(|(a, b)| ((*a).into(), (*b).into()))
                .collect(),
            hidden: false,
        }
    }

    fn index() -> SearchIndex {
        let mut i = SearchIndex::default();
        i.upsert(doc("root", "Projects", None, &[], 0));
        i.upsert(doc(
            "p1",
            "Grocery budget",
            Some("root"),
            &[("b1", "Milk, eggs and bread for the week")],
            10,
        ));
        i.upsert(doc(
            "p2",
            "Travel",
            Some("root"),
            &[
                ("b2", "Book flights"),
                ("b3", "The budget for Lisbon is tight"),
            ],
            20,
        ));
        i.upsert(doc(
            "p3",
            "Meeting notes",
            None,
            &[("b4", "Quarterly planning")],
            30,
        ));
        i
    }

    fn q(s: &str) -> ParsedQuery {
        parse_query(s, None, 100)
    }

    #[test]
    fn title_matches_rank_above_body_matches() {
        let i = index();
        let hits = i.query(&q("budget "), 10, 100);
        assert_eq!(hits[0].id, "p1");
        assert_eq!(hits[1].id, "p2");
        assert_eq!(hits[1].block_id.as_deref(), Some("b3"));
        let snip = hits[1].snippet.as_ref().unwrap();
        assert!(snip.text.contains("budget"));
        assert_eq!(hits[1].path, vec!["Projects".to_string()]);
    }

    #[test]
    fn all_terms_must_match_and_prefix_last() {
        let i = index();
        assert!(
            i.query(&q("budget lisbon "), 10, 100)
                .iter()
                .all(|h| h.id == "p2")
        );
        let hits = i.query(&q("quart"), 10, 100);
        assert_eq!(hits[0].id, "p3");
        assert!(i.query(&q("quart "), 10, 100).is_empty());
    }

    #[test]
    fn fuzzy_title() {
        let i = index();
        let hits = i.query(&q("mtg nts"), 10, 100);
        assert_eq!(hits[0].id, "p3");
    }

    #[test]
    fn operators_and_hidden() {
        let mut i = index();
        let hits = i.query(&q("budget in:root"), 10, 100);
        assert_eq!(hits.len(), 2);
        let hits = i.query(&q("in:root"), 10, 100);
        assert_eq!(hits.len(), 2);
        i.set_hidden("p1", true);
        assert!(i.query(&q("grocery"), 10, 100).is_empty());
        i.remove("p2");
        assert!(i.query(&q("lisbon"), 10, 100).is_empty());
        assert_eq!(i.len(), 3);
        let parsed = parse_query("x type:row,db edited:2026-01-02", None, 0);
        assert_eq!(
            parsed.kinds,
            Some(vec![SearchHitKind::Row, SearchHitKind::Database])
        );
        assert_eq!(parsed.edited_from, Some(1_767_312_000_000));
        assert_eq!(parsed.text, "x");
    }

    #[test]
    fn title_change_reindexes() {
        let mut i = index();
        i.update_meta("p3", "Standup log", None, None, 40, false);
        assert!(
            i.query(&q("standup "), 10, 100)
                .iter()
                .any(|h| h.id == "p3")
        );
        assert!(i.query(&q("meeting "), 10, 100).is_empty());
        // Body still indexed.
        assert!(!i.query(&q("quarterly "), 10, 100).is_empty());
    }
}
