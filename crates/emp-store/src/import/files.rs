//! Markdown file and folder import (SPEC §17.5): the folder hierarchy becomes the page tree (`a/b.md` and a folder
//! `a/b/` are the same page), wikilinks and relative links are resolved in a second pass once every page exists,
//! and referenced images become assets. The whole import is one `import_undo` unit.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use super::guard::{Guard, contain};
use super::markdown::{MdOptions, Resolve, convert};
use super::zipfs::normalize_path;
use super::{UndoLog, clean_title};
use crate::model::{AssetImport, DocOwnerKind, Id, PageCreate, PageKind, ids::new_id};
use crate::{Progress, Result, Store, StoreError};

/// Maximum files per import.
pub const MAX_FILES: usize = 10_000;
/// Maximum total bytes per import.
pub const MAX_TOTAL: u64 = 512 * 1024 * 1024;

/// One input file (the app reads granted files; paths are relative to the chosen folder).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportFile {
    /// Relative path with `/` separators.
    pub path: String,
    /// Content.
    pub bytes: Vec<u8>,
}

/// `import_markdown` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownReport {
    /// Import id (for `import_undo`).
    pub import_id: Id,
    /// Pages created.
    pub pages: usize,
    /// Root pages created.
    pub root_ids: Vec<Id>,
    /// Warnings (unresolved links, skipped files).
    pub warnings: Vec<String>,
}

/// MIME type from a file extension (assets re-sniff images from their bytes).
#[must_use]
pub fn mime_of(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("txt" | "md") => "text/plain",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("mp4") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

pub(crate) fn is_markdown(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    l.ends_with(".md") || l.ends_with(".markdown") || l.ends_with(".mdown")
}

fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    super::zipfs::strip_ext(name)
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Joins a relative reference to a directory (`..` allowed while staying inside the import).
pub(crate) fn join_rel(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        dir.split('/').filter(|p| !p.is_empty()).collect()
    };
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

/// Imports assets on demand and caches them by path.
pub(crate) struct AssetCache<'a> {
    pub store: &'a Store,
    pub workspace_id: String,
    pub files: &'a BTreeMap<String, Vec<u8>>,
    pub by_name: HashMap<String, Vec<String>>,
    pub done: HashMap<String, Option<String>>,
    pub created: Vec<String>,
    pub warnings: Vec<String>,
}

impl<'a> AssetCache<'a> {
    pub(crate) fn new(
        store: &'a Store,
        workspace_id: &str,
        files: &'a BTreeMap<String, Vec<u8>>,
    ) -> Self {
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        for p in files.keys() {
            let name = p.rsplit('/').next().unwrap_or(p).to_lowercase();
            by_name.entry(name).or_default().push(p.clone());
        }
        Self {
            store,
            workspace_id: workspace_id.to_owned(),
            files,
            by_name,
            done: HashMap::new(),
            created: Vec::new(),
            warnings: Vec::new(),
        }
    }

    /// Finds a file by relative path from `dir`, then by bare file name anywhere.
    pub(crate) fn locate(&self, dir: &str, src: &str) -> Option<String> {
        let src = src.split(['?', '#']).next().unwrap_or(src);
        if let Some(p) = join_rel(dir, src)
            && self.files.contains_key(&p)
        {
            return Some(p);
        }
        let name = src.rsplit('/').next().unwrap_or(src).to_lowercase();
        self.by_name.get(&name).and_then(|v| v.first().cloned())
    }

    pub(crate) fn import(&mut self, path: &str) -> Option<String> {
        if let Some(r) = self.done.get(path) {
            return r.clone();
        }
        let bytes = self.files.get(path)?;
        let name = path.rsplit('/').next().unwrap_or(path).to_owned();
        let res = self.store.asset_import(
            AssetImport {
                workspace_id: self.workspace_id.clone(),
                name: name.clone(),
                mime: mime_of(path).into(),
                len: bytes.len() as u64,
                source: "import".into(),
                origin_url: None,
            },
            bytes.as_slice(),
        );
        let id = match res {
            Ok(a) => {
                self.created.push(a.id.clone());
                Some(a.id)
            }
            Err(e) => {
                self.warnings
                    .push(format!("Attachment {name} was skipped: {e}"));
                None
            }
        };
        self.done.insert(path.to_owned(), id.clone());
        id
    }
}

struct FolderResolver<'a, 'b> {
    dir: String,
    pages_by_path: &'a HashMap<String, String>,
    pages_by_stem: &'a HashMap<String, Vec<(String, String)>>,
    assets: &'a mut AssetCache<'b>,
}

impl Resolve for FolderResolver<'_, '_> {
    fn page(&mut self, target: &str) -> Option<String> {
        let t = target.trim();
        // Relative path (with or without extension).
        let rel = join_rel(&self.dir, t)?;
        let key = if is_markdown(&rel) {
            super::zipfs::strip_ext(&rel).to_owned()
        } else {
            rel.clone()
        };
        if let Some(id) = self.pages_by_path.get(&key) {
            return Some(id.clone());
        }
        // Wikilink by title: prefer the same folder.
        let s = super::zipfs::strip_ext(t.rsplit('/').next().unwrap_or(t)).to_lowercase();
        let cands = self.pages_by_stem.get(&s)?;
        cands
            .iter()
            .find(|(path, _)| dir_of(path) == self.dir)
            .or_else(|| cands.first())
            .map(|(_, id)| id.clone())
    }

    fn asset(&mut self, src: &str) -> Option<String> {
        let p = self.assets.locate(&self.dir, src)?;
        if is_markdown(&p) {
            return None;
        }
        self.assets.import(&p)
    }
}

impl Store {
    /// `import_markdown` (job): Markdown files or a folder of them into the page tree under `parent_id`.
    pub fn import_markdown(
        &self,
        workspace_id: &str,
        parent_id: Option<&str>,
        files: Vec<ImportFile>,
        progress: &dyn Progress,
    ) -> Result<MarkdownReport> {
        contain(|| self.import_markdown_inner(workspace_id, parent_id, files, progress))
    }

    fn import_markdown_inner(
        &self,
        workspace_id: &str,
        parent_id: Option<&str>,
        files: Vec<ImportFile>,
        progress: &dyn Progress,
    ) -> Result<MarkdownReport> {
        self.session()?;
        let guard = Guard::new(progress, super::guard::DEFAULT_BUDGET);
        if files.len() > MAX_FILES {
            return Err(StoreError::TooLarge("too many files"));
        }
        let total: u64 = files.iter().map(|f| f.bytes.len() as u64).sum();
        if total > MAX_TOTAL {
            return Err(StoreError::TooLarge("the import is larger than 512 MiB"));
        }
        let mut map: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for f in files {
            map.insert(normalize_path(&f.path)?, f.bytes);
        }
        let md_paths: Vec<String> = map.keys().filter(|p| is_markdown(p)).cloned().collect();
        if md_paths.is_empty() {
            return Err(StoreError::invalid("no Markdown files to import"));
        }
        // Page keys: every Markdown file (without extension) and every folder above one.
        let mut keys: BTreeMap<String, Option<String>> = BTreeMap::new();
        for p in &md_paths {
            let key = super::zipfs::strip_ext(p).to_owned();
            let mut d = dir_of(&key).to_owned();
            while !d.is_empty() {
                keys.entry(d.clone()).or_insert(None);
                d = dir_of(&d).to_owned();
            }
            keys.insert(key, Some(p.clone()));
        }
        let import_id = new_id();
        let mut log = UndoLog::default();
        let mut pages_by_path: HashMap<String, String> = HashMap::new();
        let mut pages_by_stem: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let total_steps = (keys.len() * 2) as u64;
        // Pass 1: pages (BTreeMap order puts parents before children).
        for (i, (key, file)) in keys.iter().enumerate() {
            guard.step(i as u64, total_steps, "pages")?;
            let parent_key = dir_of(key);
            let parent = if parent_key.is_empty() {
                parent_id.map(str::to_owned)
            } else {
                pages_by_path.get(parent_key).cloned()
            };
            let title = clean_title(stem(key));
            let meta = self
                .page_create(PageCreate::new(
                    workspace_id,
                    parent.as_deref(),
                    PageKind::Doc,
                    &title,
                ))?
                .meta;
            if parent_key.is_empty() {
                log.pages.push(meta.id.clone());
                self.import_log_save(&import_id, &log)?;
            }
            if let Some(f) = file {
                pages_by_stem
                    .entry(stem(f).to_lowercase())
                    .or_default()
                    .push((f.clone(), meta.id.clone()));
            }
            pages_by_path.insert(key.clone(), meta.id);
        }
        // Pass 2: documents with links resolved.
        let mut assets = AssetCache::new(self, workspace_id, &map);
        let mut warnings = Vec::new();
        let mut pages = 0usize;
        for (i, (key, file)) in keys.iter().enumerate() {
            guard.step((keys.len() + i) as u64, total_steps, "documents")?;
            let Some(f) = file else { continue };
            let page = pages_by_path
                .get(key)
                .cloned()
                .ok_or(StoreError::Internal("page map".into()))?;
            let text = String::from_utf8_lossy(map.get(f).map(Vec::as_slice).unwrap_or_default())
                .into_owned();
            let mut r = FolderResolver {
                dir: dir_of(f).to_owned(),
                pages_by_path: &pages_by_path,
                pages_by_stem: &pages_by_stem,
                assets: &mut assets,
            };
            let res = convert(
                &text,
                MdOptions {
                    front_matter_callout: true,
                    drop_first_h1: false,
                    tags_line: true,
                },
                &mut r,
            )?;
            for u in &res.unresolved {
                warnings.push(format!("{}: unresolved link {u}", stem(f)));
            }
            self.page_save_doc(&page, DocOwnerKind::Page, res.doc, 0)?;
            pages += 1;
        }
        pages += keys.values().filter(|f| f.is_none()).count();
        warnings.append(&mut assets.warnings);
        log.assets = assets.created.clone();
        self.import_log_save(&import_id, &log)?;
        guard.step(total_steps, total_steps, "done")?;
        Ok(MarkdownReport {
            import_id,
            pages,
            root_ids: log.pages,
            warnings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        assert_eq!(join_rel("a/b", "../c.md").as_deref(), Some("a/c.md"));
        assert_eq!(join_rel("", "../x"), None);
        assert_eq!(join_rel("a", "./img/p.png").as_deref(), Some("a/img/p.png"));
        assert_eq!(mime_of("x.PNG"), "image/png");
        assert_eq!(stem("dir/My Note.md"), "My Note");
    }
}
