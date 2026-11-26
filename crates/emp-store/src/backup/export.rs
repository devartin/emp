//! Page export (SPEC §11.3 `export_pages`, §17.5 Markdown export).
//!
//! Each page becomes `<Title>.md` (or `.html` / `.json`) with front matter; duplicate names get ` (2)`; children go
//! into a `<Title>/` folder; page mentions become relative links; assets are copied to `assets/` when requested.
//! In encrypted vaults this requires re-auth and is logged as `export_plain`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::doc::{PageResolver, html::to_html, markdown::to_markdown};
use crate::model::{PageKind, PageMeta, SecurityEvent, TipTapDoc};
use crate::{Progress, Result, Store, StoreError};

/// Export format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// Markdown.
    Markdown,
    /// HTML.
    Html,
    /// Lossless JSON (`{meta, doc}`).
    Json,
}

impl ExportFormat {
    fn ext(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Html => "html",
            Self::Json => "json",
        }
    }
}

/// Options of [`Store::export_pages`].
#[derive(Debug, Clone, Copy)]
pub struct ExportOptions {
    /// Format.
    pub format: ExportFormat,
    /// Include descendant pages.
    pub include_children: bool,
    /// Copy referenced assets into `assets/`.
    pub include_assets: bool,
}

/// A file-system-safe name.
#[must_use]
pub fn safe_file_name(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let s = s.trim().trim_matches('.').to_owned();
    if s.is_empty() { "Untitled".into() } else { s }
}

struct Resolver<'a> {
    titles: &'a HashMap<String, String>,
    paths: &'a HashMap<String, PathBuf>,
    assets: &'a HashMap<String, String>,
    depth: usize,
}

impl PageResolver for Resolver<'_> {
    fn title(&self, page_id: &str) -> Option<String> {
        self.titles.get(page_id).cloned()
    }
    fn href(&self, page_id: &str) -> Option<String> {
        let p = self.paths.get(page_id)?;
        let rel = p.to_string_lossy().replace('\\', "/");
        Some(format!("{}{rel}", "../".repeat(self.depth)))
    }
    fn asset_href(&self, asset_id: &str) -> Option<String> {
        self.assets
            .get(asset_id)
            .map(|a| format!("{}{a}", "../".repeat(self.depth)))
    }
}

fn front_matter(meta: &PageMeta) -> String {
    let created = chrono::DateTime::from_timestamp_millis(meta.created_at)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();
    let updated = chrono::DateTime::from_timestamp_millis(meta.updated_at)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();
    format!(
        "---\ntitle: {}\nid: {}\ncreated: {created}\nupdated: {updated}\n---\n\n",
        serde_json::to_string(&meta.title).unwrap_or_default(),
        meta.id
    )
}

impl Store {
    /// Exports pages into `dir`. Returns the number of files written.
    pub fn export_pages(
        &self,
        ids: &[String],
        dir: &Path,
        opts: ExportOptions,
        progress: &dyn Progress,
    ) -> Result<usize> {
        let s = self.session()?;
        if s.codec.encrypting() {
            self.require_reauth()?;
        }
        if ids.is_empty() || ids.len() > 1000 {
            return Err(StoreError::invalid_field(
                "pageIds",
                "invalid number of pages",
            ));
        }
        // Collect pages (roots + optional descendants), keeping parent links inside the export.
        let mut metas: Vec<PageMeta> = Vec::new();
        let mut seen = HashSet::new();
        let roots = self.page_get_meta(ids)?;
        let mut stack: Vec<PageMeta> = roots.into_iter().rev().collect();
        while let Some(m) = stack.pop() {
            if !seen.insert(m.id.clone()) || m.deleted_at.is_some() {
                continue;
            }
            if opts.include_children {
                let kids = self.page_children(&m.workspace_id, Some(&m.id))?;
                stack.extend(kids.into_iter().rev());
            }
            metas.push(m);
        }
        // Assign paths.
        let exported: HashSet<String> = metas.iter().map(|m| m.id.clone()).collect();
        let mut paths: HashMap<String, PathBuf> = HashMap::new();
        let mut used: HashMap<PathBuf, HashSet<String>> = HashMap::new();
        for m in &metas {
            let parent_dir = match m
                .parent_id
                .as_ref()
                .filter(|p| exported.contains(*p))
                .and_then(|p| paths.get(p))
            {
                Some(pp) => pp.with_extension(""),
                None => PathBuf::new(),
            };
            let base = safe_file_name(&m.title);
            let names = used.entry(parent_dir.clone()).or_default();
            let mut name = base.clone();
            let mut n = 2;
            while names.contains(&name.to_lowercase()) {
                name = format!("{base} ({n})");
                n += 1;
            }
            names.insert(name.to_lowercase());
            paths.insert(
                m.id.clone(),
                parent_dir.join(format!("{name}.{}", opts.format.ext())),
            );
        }
        let titles: HashMap<String, String> = metas
            .iter()
            .map(|m| (m.id.clone(), m.title.clone()))
            .collect();
        // Docs and assets.
        let mut docs: HashMap<String, TipTapDoc> = HashMap::new();
        let mut asset_ids: HashSet<String> = HashSet::new();
        for m in &metas {
            if let Some((d, _)) = self.doc_get(&m.id)? {
                asset_ids.extend(crate::doc::index::extract(&d).assets);
                docs.insert(m.id.clone(), d);
            }
        }
        let mut assets: HashMap<String, String> = HashMap::new();
        let mut files = 0usize;
        std::fs::create_dir_all(dir)?;
        if opts.include_assets {
            let adir = dir.join("assets");
            for a in self.asset_get(&asset_ids.iter().cloned().collect::<Vec<_>>())? {
                std::fs::create_dir_all(&adir)?;
                let name = format!("{}-{}", a.id, safe_file_name(&a.name));
                self.asset_save_to(&a.id, &adir.join(&name))?;
                assets.insert(a.id, format!("assets/{name}"));
                files += 1;
            }
        }
        let total = metas.len() as u64;
        for (i, m) in metas.iter().enumerate() {
            if progress.cancelled() {
                return Err(StoreError::Cancelled);
            }
            let rel = paths.get(&m.id).cloned().unwrap_or_default();
            let depth = rel.components().count().saturating_sub(1);
            let r = Resolver {
                titles: &titles,
                paths: &paths,
                assets: &assets,
                depth,
            };
            let doc = docs.get(&m.id);
            let body = match opts.format {
                ExportFormat::Markdown => {
                    let mut out = front_matter(m);
                    out.push_str(&format!("# {}\n\n", crate::doc::markdown::escape(&m.title)));
                    if let Some(d) = doc {
                        out.push_str(&to_markdown(d, &r));
                        out.push('\n');
                    } else if m.kind != PageKind::Doc {
                        out.push_str(&format!(
                            "*This {} page is exported separately.*\n",
                            m.kind.as_str()
                        ));
                    }
                    out
                }
                ExportFormat::Html => format!(
                    "<!doctype html><html><head><meta charset=\"utf-8\"><title>{t}</title></head><body><h1>{t}</h1>{b}</body></html>\n",
                    t = crate::doc::html::esc(&m.title),
                    b = doc.map(|d| to_html(d, &r)).unwrap_or_default()
                ),
                ExportFormat::Json => {
                    serde_json::to_string_pretty(&serde_json::json!({ "meta": m, "doc": doc }))?
                }
            };
            let path = dir.join(&rel);
            if let Some(p) = path.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::write(&path, body)?;
            files += 1;
            progress.progress(i as u64 + 1, total, "pages");
        }
        if s.codec.encrypting() {
            self.log_security_event(SecurityEvent::ExportPlain)?;
        }
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_names() {
        assert_eq!(safe_file_name("a/b: c?"), "a-b- c-");
        assert_eq!(safe_file_name("  "), "Untitled");
        assert_eq!(safe_file_name("..hidden"), "hidden");
    }
}
