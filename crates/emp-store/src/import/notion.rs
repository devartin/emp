//! Notion export import (SPEC §17.4): pages, nested pages, databases from CSV (preferring `*_all.csv`), row bodies
//! from the sibling folder, attachments, and links resolved in a second pass by Notion id, then by title.
//!
//! The archive is opened in memory with the §9.16 limits (nested `Part-N.zip` archives included). 32-hex id
//! suffixes are stripped from names and kept in an id map. HTML pages are preferred over Markdown when both exist.
//! The whole import is one `import_undo` unit.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use super::files::{AssetCache, is_markdown};
use super::guard::{Guard, contain};
use super::markdown::{MdOptions, Resolve, percent_decode};
use super::table::{TableTarget, read_table};
use super::zipfs::{ZipFs, ZipLimits, split_notion_id, strip_ext};
use super::{UndoLog, clean_title};
use crate::model::{DocOwnerKind, Id, PageCreate, PageKind, TipTapDoc, ids::new_id};
use crate::query::cells;
use crate::query::model::{CellValue, PropType, RowUpdate};
use crate::{Progress, Result, Store, StoreError};

/// An unresolved link of the report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Unresolved {
    /// Page where the link appears.
    pub title: String,
    /// Link target as written.
    #[serde(rename = "ref")]
    pub reference: String,
}

/// `import_notion` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionReport {
    /// Import id (for `import_undo`).
    pub import_id: Id,
    /// Pages created (databases not included).
    pub pages: usize,
    /// Databases created.
    pub databases: usize,
    /// Rows created.
    pub rows: usize,
    /// Attachments imported.
    pub assets: usize,
    /// Links that could not be resolved.
    pub unresolved: Vec<Unresolved>,
    /// Warnings (unsupported blocks, columns kept as text, skipped files).
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum NodeKind {
    /// A page with an `.md` / `.html` source (or a folder without one).
    Page { source: Option<String> },
    /// A database with its CSV.
    Db { csv: String },
}

fn ext(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn last(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent_key(key: &str) -> &str {
    key.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Title and Notion id of a path component.
fn title_id(component: &str) -> (String, Option<String>) {
    let (t, id) = split_notion_id(strip_ext(component));
    (clean_title(t), id.map(str::to_ascii_lowercase))
}

/// Removes the leading `# Title` and Notion's `Key: value` property lines from a row page.
fn strip_row_header(md: &str, columns: &[String]) -> String {
    let mut lines = md.lines().peekable();
    let mut out = Vec::new();
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    if lines.peek().is_some_and(|l| l.starts_with("# ")) {
        lines.next();
    }
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    while let Some(l) = lines.peek() {
        let is_prop = l
            .split_once(':')
            .is_some_and(|(k, _)| columns.iter().any(|c| c.eq_ignore_ascii_case(k.trim())));
        if !is_prop {
            break;
        }
        lines.next();
    }
    out.extend(lines);
    out.join("\n")
}

/// Splits a Notion relation cell: `Title (Title%20id.md), Other (…)` or plain titles.
fn relation_refs(cell: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut rest = cell;
    while !rest.trim().is_empty() {
        if let Some(open) = rest.find(" (")
            && let Some(close) = rest[open..].find(')')
        {
            let title = rest[..open]
                .trim()
                .trim_start_matches(',')
                .trim()
                .to_owned();
            let target = percent_decode(&rest[open + 2..open + close]);
            let id = split_notion_id(strip_ext(last(&target)))
                .1
                .map(str::to_ascii_lowercase);
            out.push((title, id));
            rest = &rest[open + close + 1..];
            continue;
        }
        for t in cells::split_list(rest) {
            out.push((t.to_owned(), None));
        }
        break;
    }
    out
}

fn looks_relation(values: &[&str]) -> bool {
    let non: Vec<&&str> = values.iter().filter(|v| !v.trim().is_empty()).collect();
    !non.is_empty()
        && non
            .iter()
            .filter(|v| v.contains(".md)") || v.contains(".html)"))
            .count()
            * 2
            >= non.len()
}

struct NotionResolver<'a, 'b> {
    dir: String,
    ids: &'a HashMap<String, String>,
    titles: &'a HashMap<String, String>,
    assets: &'a mut AssetCache<'b>,
}

impl Resolve for NotionResolver<'_, '_> {
    fn page(&mut self, target: &str) -> Option<String> {
        let comp = last(target);
        if let (_, Some(id)) = split_notion_id(strip_ext(comp))
            && let Some(x) = self.ids.get(&id.to_ascii_lowercase())
        {
            return Some(x.clone());
        }
        let (t, _) = title_id(comp);
        self.titles.get(&t.to_lowercase()).cloned()
    }

    fn asset(&mut self, src: &str) -> Option<String> {
        let p = self.assets.locate(&self.dir, src)?;
        if is_markdown(&p) || matches!(ext(&p).as_str(), "html" | "csv") {
            return None;
        }
        self.assets.import(&p)
    }
}

/// Removes a single top-level folder that holds everything and has no page of its own (`Export-…/`).
fn strip_common_root(fs: &mut ZipFs) {
    for _ in 0..2 {
        let roots: BTreeSet<&str> = fs
            .files
            .keys()
            .map(|k| k.split('/').next().unwrap_or(""))
            .collect();
        if roots.len() != 1 {
            return;
        }
        let root = roots.into_iter().next().unwrap_or_default().to_owned();
        if fs.files.keys().any(|k| !k.contains('/')) {
            return;
        }
        let has_page = fs.files.keys().any(|k| {
            let s = strip_ext(k);
            s == root && matches!(ext(k).as_str(), "md" | "html" | "csv")
        });
        if has_page {
            return;
        }
        let prefix = format!("{root}/");
        fs.files = std::mem::take(&mut fs.files)
            .into_iter()
            .map(|(k, v)| (k.strip_prefix(&prefix).unwrap_or(&k).to_owned(), v))
            .collect();
    }
}

impl Store {
    /// `import_notion` (job): a Notion "Markdown & CSV" or "HTML" export zip under `parent_id`. Use
    /// [`ZipLimits::NOTION_CONFIRMED`] after the user confirmed an export above 512 MiB.
    pub fn import_notion(
        &self,
        workspace_id: &str,
        parent_id: Option<&str>,
        zip: &[u8],
        limits: ZipLimits,
        progress: &dyn Progress,
    ) -> Result<NotionReport> {
        contain(|| self.import_notion_inner(workspace_id, parent_id, zip, limits, progress))
    }

    #[allow(clippy::too_many_lines)]
    fn import_notion_inner(
        &self,
        workspace_id: &str,
        parent_id: Option<&str>,
        zip: &[u8],
        limits: ZipLimits,
        progress: &dyn Progress,
    ) -> Result<NotionReport> {
        self.session()?;
        let guard = Guard::new(progress, super::guard::DEFAULT_BUDGET * 5);
        let mut fs = ZipFs::open(zip, &limits)?;
        strip_common_root(&mut fs);
        guard.step(0, 1, "scan")?;
        // Classify entries into nodes.
        let mut nodes: BTreeMap<String, NodeKind> = BTreeMap::new();
        for path in fs.files.keys() {
            match ext(path).as_str() {
                "md" | "html" => {
                    let key = strip_ext(path).to_owned();
                    let e = nodes.entry(key).or_insert(NodeKind::Page { source: None });
                    if let NodeKind::Page { source } = e {
                        // Prefer HTML when present.
                        let prefer = match source {
                            None => true,
                            Some(s) => ext(s) == "md" && ext(path) == "html",
                        };
                        if prefer {
                            *source = Some(path.clone());
                        }
                    }
                }
                "csv" => {
                    let s = strip_ext(path);
                    let (key, all) = match s.strip_suffix("_all") {
                        Some(k) => (k.to_owned(), true),
                        None => (s.to_owned(), false),
                    };
                    match nodes.get(&key) {
                        Some(NodeKind::Db { csv }) if csv.ends_with("_all.csv") && !all => {}
                        _ => {
                            nodes.insert(key, NodeKind::Db { csv: path.clone() });
                        }
                    }
                }
                _ => {}
            }
        }
        let db_keys: BTreeSet<String> = nodes
            .iter()
            .filter(|(_, k)| matches!(k, NodeKind::Db { .. }))
            .map(|(k, _)| k.clone())
            .collect();
        // Row bodies: pages directly inside a database folder.
        let mut row_pages: BTreeMap<String, Vec<String>> = BTreeMap::new();
        nodes.retain(|key, kind| {
            if let NodeKind::Page { source: Some(src) } = kind
                && db_keys.contains(parent_key(key))
            {
                row_pages
                    .entry(parent_key(key).to_owned())
                    .or_default()
                    .push(src.clone());
                return false;
            }
            true
        });
        // Implicit folder pages for directories without their own page.
        let keys: Vec<String> = nodes.keys().cloned().collect();
        for k in keys {
            let mut d = parent_key(&k).to_owned();
            while !d.is_empty() {
                let is_row = db_keys.contains(parent_key(&d));
                if !nodes.contains_key(&d) && !is_row {
                    nodes.insert(d.clone(), NodeKind::Page { source: None });
                }
                d = parent_key(&d).to_owned();
            }
        }
        let import_id = new_id();
        let mut log = UndoLog::default();
        let mut ids: HashMap<String, String> = HashMap::new();
        let mut titles: HashMap<String, String> = HashMap::new();
        let mut emp_of: HashMap<String, String> = HashMap::new();
        let mut report = NotionReport {
            import_id: import_id.clone(),
            pages: 0,
            databases: 0,
            rows: 0,
            assets: 0,
            unresolved: Vec::new(),
            warnings: Vec::new(),
        };
        // Database rows waiting for pass 2: (db key, row ids in CSV order, header, rows, relation columns).
        struct DbPending {
            key: String,
            db_id: String,
            header: Vec<String>,
            rows: Vec<Vec<String>>,
            row_ids: Vec<String>,
            relations: Vec<usize>,
        }
        let mut pending_dbs: Vec<DbPending> = Vec::new();
        let total = (nodes.len() * 2) as u64;
        // Pass 1: pages and databases, parents first.
        for (i, (key, kind)) in nodes.iter().enumerate() {
            guard.step(i as u64, total, "pages")?;
            let mut pk = parent_key(key).to_owned();
            let parent = loop {
                if pk.is_empty() {
                    break parent_id.map(str::to_owned);
                }
                if let Some(p) = emp_of.get(&pk) {
                    break Some(p.clone());
                }
                pk = parent_key(&pk).to_owned();
            };
            let (title, nid) = title_id(last(key));
            let id = match kind {
                NodeKind::Page { .. } => {
                    let m = self
                        .page_create(PageCreate::new(
                            workspace_id,
                            parent.as_deref(),
                            PageKind::Doc,
                            &title,
                        ))?
                        .meta;
                    report.pages += 1;
                    m.id
                }
                NodeKind::Db { csv } => {
                    let bytes = fs.files.get(csv).map(Vec::as_slice).unwrap_or_default();
                    let t = read_table(csv, bytes, None, crate::repo::rows::MAX_ROWS)?;
                    let header = if t.header.is_empty() {
                        vec!["Name".to_owned()]
                    } else {
                        t.header.clone()
                    };
                    let relations: Vec<usize> = (1..header.len())
                        .filter(|&c| {
                            let vals: Vec<&str> = t
                                .rows
                                .iter()
                                .take(200)
                                .map(|r| r.get(c).map_or("", String::as_str))
                                .collect();
                            looks_relation(&vals)
                        })
                        .collect();
                    // Relation columns are created in pass 2 once every target row exists.
                    let keep: Vec<usize> = (0..header.len())
                        .filter(|c| !relations.contains(c))
                        .collect();
                    let h2: Vec<String> = keep.iter().map(|&c| header[c].clone()).collect();
                    let r2: Vec<Vec<String>> = t
                        .rows
                        .iter()
                        .map(|r| {
                            keep.iter()
                                .map(|&c| r.get(c).cloned().unwrap_or_default())
                                .collect()
                        })
                        .collect();
                    let res = self.import_rows(
                        &h2,
                        &r2,
                        TableTarget::New {
                            workspace_id: workspace_id.to_owned(),
                            parent_id: parent.clone(),
                            title: title.clone(),
                        },
                        &guard,
                    )?;
                    report.warnings.extend(res.warnings);
                    let db_id = res.database_id.clone();
                    let row_titles = self.db_row_titles(&db_id)?;
                    for (rid, rt) in &row_titles {
                        titles
                            .entry(clean_title(rt).to_lowercase())
                            .or_insert_with(|| rid.clone());
                    }
                    let row_ids: Vec<String> = row_titles.into_iter().map(|(id, _)| id).collect();
                    report.databases += 1;
                    report.rows += res.inserted;
                    pending_dbs.push(DbPending {
                        key: key.clone(),
                        db_id: db_id.clone(),
                        header,
                        rows: t.rows,
                        row_ids,
                        relations,
                    });
                    db_id
                }
            };
            if parent_key(key).is_empty() {
                log.pages.push(id.clone());
                self.import_log_save(&import_id, &log)?;
            }
            if let Some(n) = nid {
                ids.insert(n, id.clone());
            }
            titles
                .entry(title.to_lowercase())
                .or_insert_with(|| id.clone());
            emp_of.insert(key.clone(), id);
        }
        // Row bodies: match `Row Title <id>.md` files to rows by title (in order).
        let mut row_docs: Vec<(String, String, Vec<String>)> = Vec::new();
        for p in &pending_dbs {
            let titles_of: Vec<(String, String)> = self.db_row_titles(&p.db_id)?;
            let mut used = vec![false; titles_of.len()];
            for src in row_pages.get(&p.key).map(Vec::as_slice).unwrap_or_default() {
                let (t, nid) = title_id(last(src));
                let hit = titles_of
                    .iter()
                    .enumerate()
                    .find(|(i, (_, rt))| !used[*i] && clean_title(rt) == t)
                    .map(|(i, (id, _))| (i, id.clone()));
                match hit {
                    Some((i, rid)) => {
                        used[i] = true;
                        if let Some(n) = nid {
                            ids.insert(n, rid.clone());
                        }
                        row_docs.push((src.clone(), rid, p.header.clone()));
                    }
                    None => report
                        .warnings
                        .push(format!("Row page {t} has no matching row and was skipped.")),
                }
            }
        }
        // Pass 2a: relation columns, resolved by Notion id and then by row title.
        for p in &pending_dbs {
            for &c in &p.relations {
                let name = p.header[c].clone();
                let mut resolved: Vec<Vec<String>> = Vec::with_capacity(p.rows.len());
                let mut target_votes: HashMap<String, usize> = HashMap::new();
                let mut misses = 0usize;
                for r in &p.rows {
                    let mut v = Vec::new();
                    for (title, nid) in relation_refs(r.get(c).map_or("", String::as_str)) {
                        let hit = nid
                            .and_then(|n| ids.get(&n).cloned())
                            .or_else(|| titles.get(&title.to_lowercase()).cloned());
                        match hit {
                            Some(h) => v.push(h),
                            None => misses += 1,
                        }
                    }
                    resolved.push(v);
                }
                // The target is the database owning most referenced rows.
                for v in &resolved {
                    for id in v {
                        if let Ok(g) = self.db_row_get(id) {
                            *target_votes.entry(g.database_id).or_default() += 1;
                        }
                    }
                }
                let target = target_votes
                    .into_iter()
                    .max_by_key(|(_, n)| *n)
                    .map(|(d, _)| d);
                match target {
                    Some(t) => {
                        let prop = self.db_property_create(
                            &p.db_id,
                            &name,
                            PropType::Relation,
                            serde_json::json!({"targetDatabaseId": t})
                                .as_object()
                                .cloned(),
                            None,
                        )?;
                        let updates: Vec<RowUpdate> = resolved
                            .into_iter()
                            .zip(&p.row_ids)
                            .filter(|(v, _)| !v.is_empty())
                            .map(|(v, rid)| {
                                RowUpdate::one(rid, &prop.id, Some(CellValue::Relation { v }))
                            })
                            .collect();
                        for chunk in updates.chunks(crate::repo::rows::MAX_BATCH) {
                            // Targets outside the chosen database are dropped by validation of ids only; keep going.
                            self.db_rows_update(chunk.to_vec())?;
                        }
                        if misses > 0 {
                            report
                                .warnings
                                .push(format!("{misses} links in {name} could not be resolved."));
                        }
                    }
                    None => {
                        let prop =
                            self.db_property_create(&p.db_id, &name, PropType::Text, None, None)?;
                        let updates: Vec<RowUpdate> = p
                            .rows
                            .iter()
                            .zip(&p.row_ids)
                            .filter_map(|(r, rid)| {
                                let text: Vec<String> =
                                    relation_refs(r.get(c).map_or("", String::as_str))
                                        .into_iter()
                                        .map(|x| x.0)
                                        .collect();
                                (!text.is_empty()).then(|| {
                                    RowUpdate::one(
                                        rid,
                                        &prop.id,
                                        Some(CellValue::text(&text.join(", "))),
                                    )
                                })
                            })
                            .collect();
                        for chunk in updates.chunks(crate::repo::rows::MAX_BATCH) {
                            self.db_rows_update(chunk.to_vec())?;
                        }
                        report.warnings.push(format!(
                            "The links in {name} could not be matched and were kept as text."
                        ));
                    }
                }
            }
        }
        // Pass 2b: documents.
        let mut assets = AssetCache::new(self, workspace_id, &fs.files);
        let mut docs: Vec<(String, String, Option<Vec<String>>, String)> = Vec::new();
        for (key, kind) in &nodes {
            if let NodeKind::Page { source: Some(src) } = kind
                && let Some(id) = emp_of.get(key)
            {
                docs.push((src.clone(), id.clone(), None, title_id(last(key)).0));
            }
        }
        for (src, rid, header) in row_docs {
            let t = title_id(last(&src)).0;
            docs.push((src, rid, Some(header), t));
        }
        let n_docs = docs.len();
        for (i, (src, id, row_header, title)) in docs.into_iter().enumerate() {
            guard.step(
                (nodes.len() + i * nodes.len() / n_docs.max(1)) as u64,
                total,
                "documents",
            )?;
            let text =
                String::from_utf8_lossy(fs.files.get(&src).map(Vec::as_slice).unwrap_or_default())
                    .into_owned();
            let mut r = NotionResolver {
                dir: parent_key(&src).to_owned(),
                ids: &ids,
                titles: &titles,
                assets: &mut assets,
            };
            let (doc, unresolved): (TipTapDoc, Vec<String>) = if ext(&src) == "html" {
                let h = super::html::convert(&text, &mut r)?;
                for u in h.unsupported {
                    report.warnings.push(format!("{title}: {u}"));
                }
                (h.doc, h.unresolved)
            } else {
                let md = match &row_header {
                    Some(cols) => strip_row_header(&text, cols),
                    None => text,
                };
                let m = super::markdown::convert(
                    &md,
                    MdOptions {
                        front_matter_callout: true,
                        drop_first_h1: row_header.is_none(),
                        tags_line: false,
                    },
                    &mut r,
                )?;
                (m.doc, m.unresolved)
            };
            for u in unresolved {
                report.unresolved.push(Unresolved {
                    title: title.clone(),
                    reference: u,
                });
            }
            let owner = if row_header.is_some() {
                DocOwnerKind::Row
            } else {
                DocOwnerKind::Page
            };
            self.page_save_doc(&id, owner, doc, 0)?;
        }
        report.assets = assets.created.len();
        report.warnings.append(&mut assets.warnings);
        log.assets = assets.created.clone();
        self.import_log_save(&import_id, &log)?;
        if nodes.is_empty() {
            return Err(StoreError::invalid("the archive contains no Notion pages"));
        }
        guard.step(total, total, "done")?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            title_id(&format!("Road map {id}.md")),
            ("Road map".into(), Some(id.into()))
        );
        let refs = relation_refs(&format!("Alpha (Alpha%20{id}.md), Beta (x/Beta%20{id}.md)"));
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].0, "Alpha");
        assert_eq!(refs[1].1.as_deref(), Some(id));
        assert_eq!(
            relation_refs("a, b"),
            vec![("a".into(), None), ("b".into(), None)]
        );
        let md = "# Task\n\nStatus: Done\nTags: x\n\nBody text\n";
        assert_eq!(
            strip_row_header(md, &["Status".into(), "Tags".into()]),
            "\nBody text"
        );
    }
}
