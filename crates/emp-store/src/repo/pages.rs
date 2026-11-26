//! Pages, the page tree and the trash (SPEC §10.2 `pages`, §11.3 Pages and docs, D-24 trash).
//!
//! Structure (`parent_id`, `sort_key`, `kind`, timestamps, `deleted_at`, `trash_root`) is plaintext; titles, icons,
//! covers and flags live in the payload (D-01). `rev` counts payload changes: moves and trash operations do not
//! change it. Sort keys are base-62 fractional indexes ([`crate::model::sort_key`]).
//!
//! Trash: deleting a page stamps `deleted_at` on its live subtree and `trash_root = 1` on the page itself.
//! Restoring brings back the pages trashed together with it (same `deleted_at`), under the original parent if it is
//! still live, otherwise at the root. Trash entries older than `trashRetentionDays` (default 30) are purged by
//! maintenance.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};

use crate::codec::{Codec, RecordLoc};
use crate::doc::index::extract;
use crate::doc::schema::{container, normalize, regenerate_ids};
use crate::doc::walk::{find_block, remove_blocks};
use crate::model::sort_key::key_between;
use crate::model::{
    Backlink, Breadcrumb, OutlineItem, PageCreate, PageCreated, PageGet, PageKind, PageMeta,
    PageMetaPatch, PagePayload, TemplateInfo, TipTapDoc, TipTapNode, ids::new_id, validate_title,
};
use crate::repo::docs::{insert_or_replace_doc, load_doc};
use crate::vault::{Session, StoreEvent};
use crate::{Progress, Result, Store, StoreError};

/// Maximum ids per bulk call (SPEC §11.1 list bound).
pub const MAX_IDS: usize = 1000;
/// Maximum tree depth accepted by moves and breadcrumbs.
pub const MAX_TREE_DEPTH: usize = 256;

/// Columns selected for a page row (`p` alias).
pub(crate) const PAGE_COLS: &str = "p.id, p.workspace_id, p.parent_id, p.kind, p.sort_key, p.created_at, p.updated_at, \
     p.deleted_at, p.trash_root, p.rev, p.enc, p.payload, \
     EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL)";

/// A raw page row.
#[derive(Debug, Clone)]
pub(crate) struct PageRow {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub sort_key: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[allow(dead_code)]
    pub trash_root: bool,
    pub rev: i64,
    pub enc: i64,
    pub payload: Vec<u8>,
    pub has_children: bool,
}

pub(crate) fn page_row(r: &Row<'_>) -> rusqlite::Result<PageRow> {
    Ok(PageRow {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        parent_id: r.get(2)?,
        kind: r.get(3)?,
        sort_key: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        deleted_at: r.get(7)?,
        trash_root: r.get::<_, i64>(8)? == 1,
        rev: r.get(9)?,
        enc: r.get(10)?,
        payload: r.get(11)?,
        has_children: r.get(12)?,
    })
}

pub(crate) fn load_page(conn: &Connection, id: &str) -> Result<Option<PageRow>> {
    Ok(conn
        .prepare_cached(&format!("SELECT {PAGE_COLS} FROM pages p WHERE p.id = ?1"))?
        .query_row([id], page_row)
        .optional()?)
}

pub(crate) fn page_loc(id: &str, kind: &str, rev: i64) -> RecordLoc {
    RecordLoc::new(TableTag::Pages, id, kind, u64::try_from(rev).unwrap_or(0))
}

pub(crate) fn decode_page(codec: &Codec, row: &PageRow) -> Result<PagePayload> {
    codec.decode(
        &page_loc(&row.id, &row.kind, row.rev),
        row.enc,
        &row.payload,
    )
}

pub(crate) fn to_meta(row: &PageRow, p: PagePayload) -> Result<PageMeta> {
    Ok(PageMeta {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        parent_id: row.parent_id.clone(),
        kind: PageKind::parse(&row.kind)
            .ok_or_else(|| StoreError::Integrity("unknown page kind".into()))?,
        sort_key: row.sort_key.clone(),
        title: p.title,
        icon: p.icon,
        cover: p.cover,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
        rev: row.rev,
        flags: p.flags,
        app_instance_id: p.app_instance_id,
        has_children: row.has_children,
    })
}

pub(crate) fn meta_of(codec: &Codec, row: &PageRow) -> Result<PageMeta> {
    to_meta(row, decode_page(codec, row)?)
}

/// Loads one page's meta.
pub(crate) fn load_meta(conn: &Connection, codec: &Codec, id: &str) -> Result<Option<PageMeta>> {
    load_page(conn, id)?.map(|r| meta_of(codec, &r)).transpose()
}

/// Rewrites a page payload with a new rev.
pub(crate) fn write_payload(
    tx: &Connection,
    codec: &Codec,
    row: &PageRow,
    payload: &PagePayload,
    new_rev: i64,
    now: i64,
) -> Result<()> {
    let e = codec.encode(&page_loc(&row.id, &row.kind, new_rev), payload)?;
    tx.prepare_cached(
        "UPDATE pages SET rev = ?2, updated_at = ?3, enc = ?4, payload = ?5 WHERE id = ?1",
    )?
    .execute(params![row.id, new_rev, now, e.enc, e.payload])?;
    Ok(())
}

/// Live siblings `(id, sort_key)` under `parent` in order.
fn siblings(tx: &Connection, ws: &str, parent: Option<&str>) -> Result<Vec<(String, String)>> {
    let mut st = tx.prepare_cached(
        "SELECT id, sort_key FROM pages WHERE workspace_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL ORDER BY sort_key, id",
    )?;
    let rows = st.query_map(params![ws, parent], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A sort key placing a page after `after` / before `before` (or at the end) among `parent`'s children.
pub(crate) fn position_key(
    tx: &Connection,
    ws: &str,
    parent: Option<&str>,
    after: Option<&str>,
    before: Option<&str>,
    exclude: Option<&str>,
) -> Result<String> {
    let sibs: Vec<(String, String)> = siblings(tx, ws, parent)?
        .into_iter()
        .filter(|(id, _)| Some(id.as_str()) != exclude)
        .collect();
    let (lo, hi) = if let Some(a) = after {
        let i = sibs
            .iter()
            .position(|(id, _)| id == a)
            .ok_or_else(|| StoreError::invalid_field("afterId", "not a sibling"))?;
        (
            Some(sibs[i].1.clone()),
            sibs.get(i + 1).map(|s| s.1.clone()),
        )
    } else if let Some(b) = before {
        let i = sibs
            .iter()
            .position(|(id, _)| id == b)
            .ok_or_else(|| StoreError::invalid_field("beforeId", "not a sibling"))?;
        (
            i.checked_sub(1).map(|j| sibs[j].1.clone()),
            Some(sibs[i].1.clone()),
        )
    } else {
        (sibs.last().map(|s| s.1.clone()), None)
    };
    match key_between(lo.as_deref(), hi.as_deref()) {
        Ok(k) => Ok(k),
        // Equal neighbour keys (concurrent inserts): fall back to the end.
        Err(_) => key_between(sibs.last().map(|s| s.1.as_str()), None),
    }
}

/// Inserts a page row.
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_page(
    tx: &Connection,
    codec: &Codec,
    id: &str,
    ws: &str,
    parent: Option<&str>,
    kind: PageKind,
    sort_key: &str,
    payload: &PagePayload,
    now: i64,
) -> Result<()> {
    let e = codec.encode(&page_loc(id, kind.as_str(), 1), payload)?;
    tx.prepare_cached(
        "INSERT INTO pages (id, workspace_id, parent_id, kind, sort_key, created_at, updated_at, deleted_at, trash_root, rev, enc, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL, 0, 1, ?7, ?8)",
    )?
    .execute(params![id, ws, parent, kind.as_str(), sort_key, now, e.enc, e.payload])?;
    Ok(())
}

fn check_parent(tx: &Connection, ws: &str, parent: Option<&str>) -> Result<()> {
    if let Some(p) = parent {
        let row = load_page(tx, p)?.ok_or(StoreError::NotFound("parent page"))?;
        if row.workspace_id != ws {
            return Err(StoreError::invalid_field(
                "parentId",
                "parent is in another workspace",
            ));
        }
        if row.deleted_at.is_some() {
            return Err(StoreError::invalid_field(
                "parentId",
                "parent is in the trash",
            ));
        }
    } else {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
            [ws],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound("workspace"));
        }
    }
    Ok(())
}

fn subtree_ids(conn: &Connection, root: &str, live_only: bool) -> Result<Vec<String>> {
    let sql = if live_only {
        "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL) SELECT id FROM sub"
    } else {
        "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id) SELECT id FROM sub"
    };
    let mut st = conn.prepare_cached(sql)?;
    let rows = st.query_map([root], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Copies a page (and optionally its doc-page descendants) under `parent`; returns the new metas, root first.
#[allow(clippy::too_many_arguments)]
fn copy_tree(
    tx: &Transaction<'_>,
    codec: &Codec,
    src: &PageRow,
    parent: Option<&str>,
    sort_key: &str,
    deep: bool,
    title_suffix: &str,
    clear_template: bool,
    now: i64,
    out: &mut Vec<(PageMeta, Option<TipTapDoc>)>,
    depth: usize,
) -> Result<()> {
    if depth > MAX_TREE_DEPTH {
        return Err(StoreError::invalid("page tree is too deep"));
    }
    let kind = PageKind::parse(&src.kind)
        .ok_or_else(|| StoreError::Integrity("unknown page kind".into()))?;
    if !matches!(kind, PageKind::Doc | PageKind::Dashboard) {
        return Err(StoreError::Unsupported(
            "only doc and dashboard pages can be duplicated here",
        ));
    }
    let mut payload = decode_page(codec, src)?;
    payload.title.push_str(title_suffix);
    payload.template_key = None;
    if clear_template {
        payload.flags.template = None;
    }
    let id = new_id();
    insert_page(
        tx,
        codec,
        &id,
        &src.workspace_id,
        parent,
        kind,
        sort_key,
        &payload,
        now,
    )?;
    let doc = match load_doc(tx, codec, &src.id)? {
        Some((mut doc, _)) => {
            regenerate_ids(&mut doc)?;
            insert_or_replace_doc(tx, codec, &id, "page", &doc, 1, now)?;
            Some(doc)
        }
        None => None,
    };
    let row = load_page(tx, &id)?.ok_or(StoreError::NotFound("page"))?;
    out.push((to_meta(&row, payload)?, doc));
    if deep {
        let mut st = tx.prepare_cached(&format!(
            "SELECT {PAGE_COLS} FROM pages p WHERE p.parent_id = ?1 AND p.deleted_at IS NULL AND p.kind IN ('doc','dashboard') ORDER BY p.sort_key"
        ))?;
        let kids: Vec<PageRow> = st
            .query_map([&src.id], page_row)?
            .collect::<rusqlite::Result<_>>()?;
        drop(st);
        let mut last: Option<String> = None;
        for k in kids {
            let key = key_between(last.as_deref(), None)?;
            copy_tree(
                tx,
                codec,
                &k,
                Some(&id),
                &key,
                true,
                "",
                clear_template,
                now,
                out,
                depth + 1,
            )?;
            last = Some(key);
        }
    }
    Ok(())
}

impl Store {
    fn tree_changed(&self, workspace_id: &str, upserted: Vec<PageMeta>, removed: Vec<String>) {
        self.emit(StoreEvent::TreeChanged {
            workspace_id: workspace_id.to_owned(),
            upserted,
            removed,
        });
    }

    /// Every live page of a workspace in depth-first tree order.
    pub fn page_tree(&self, workspace_id: &str) -> Result<Vec<PageMeta>> {
        let s = self.session()?;
        let rows: Vec<PageRow> = self.read(|c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT {PAGE_COLS} FROM pages p WHERE p.workspace_id = ?1 AND p.deleted_at IS NULL ORDER BY p.sort_key, p.id"
            ))?;
            let rows = st.query_map([workspace_id], page_row)?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        let mut by_parent: HashMap<Option<String>, Vec<PageRow>> = HashMap::new();
        let ids: HashSet<String> = rows.iter().map(|r| r.id.clone()).collect();
        for r in rows {
            // Orphans (parent missing) are shown at the root.
            let key = r.parent_id.clone().filter(|p| ids.contains(p));
            by_parent.entry(key).or_default().push(r);
        }
        let mut out = Vec::with_capacity(ids.len());
        let mut stack: Vec<PageRow> = by_parent.remove(&None).unwrap_or_default();
        stack.reverse();
        while let Some(r) = stack.pop() {
            if let Some(mut kids) = by_parent.remove(&Some(r.id.clone())) {
                kids.reverse();
                stack.extend(kids);
            }
            out.push(meta_of(&s.codec, &r)?);
        }
        Ok(out)
    }

    /// Live children of a page (or of the workspace root) in order.
    pub fn page_children(
        &self,
        workspace_id: &str,
        parent_id: Option<&str>,
    ) -> Result<Vec<PageMeta>> {
        let s = self.session()?;
        self.read(|c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT {PAGE_COLS} FROM pages p WHERE p.workspace_id = ?1 AND p.parent_id IS ?2 AND p.deleted_at IS NULL ORDER BY p.sort_key, p.id"
            ))?;
            let rows: Vec<PageRow> = st
                .query_map(params![workspace_id, parent_id], page_row)?
                .collect::<rusqlite::Result<_>>()?;
            rows.iter().map(|r| meta_of(&s.codec, r)).collect()
        })
    }

    /// Ancestors of a page, root first.
    pub fn page_breadcrumbs(&self, id: &str) -> Result<Vec<Breadcrumb>> {
        let s = self.session()?;
        self.read(|c| {
            let mut out = Vec::new();
            let mut cur = load_page(c, id)?
                .ok_or(StoreError::NotFound("page"))?
                .parent_id;
            while let Some(p) = cur {
                if out.len() > MAX_TREE_DEPTH {
                    break;
                }
                let Some(row) = load_page(c, &p)? else { break };
                let payload = decode_page(&s.codec, &row)?;
                out.push(Breadcrumb {
                    id: row.id.clone(),
                    title: payload.title,
                    icon: payload.icon,
                });
                cur = row.parent_id;
            }
            out.reverse();
            Ok(out)
        })
    }

    /// `page_get`.
    pub fn page_get(&self, id: &str) -> Result<PageGet> {
        let s = self.session()?;
        let (meta, doc) = self.read(|c| {
            let meta = load_meta(c, &s.codec, id)?.ok_or(StoreError::NotFound("page"))?;
            let doc = load_doc(c, &s.codec, id)?;
            Ok((meta, doc))
        })?;
        let (doc, doc_rev) = match doc {
            Some((d, r)) => (Some(d), r),
            None => (None, 0),
        };
        Ok(PageGet {
            breadcrumbs: self.page_breadcrumbs(id)?,
            meta,
            doc,
            doc_rev,
        })
    }

    /// `page_get_meta` (missing ids are skipped).
    pub fn page_get_meta(&self, ids: &[String]) -> Result<Vec<PageMeta>> {
        if ids.len() > MAX_IDS {
            return Err(StoreError::TooLarge("too many ids"));
        }
        let s = self.session()?;
        self.read(|c| {
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(m) = load_meta(c, &s.codec, id)? {
                    out.push(m);
                }
            }
            Ok(out)
        })
    }

    /// `page_create` (any kind; the IPC handler restricts `kind` to `doc` / `dashboard`).
    pub fn page_create(&self, req: PageCreate) -> Result<PageCreated> {
        let title = req.title.clone().unwrap_or_default();
        validate_title(&title)?;
        let s = self.session()?;
        let mut doc = req.doc.clone();
        if let Some(d) = doc.as_mut() {
            normalize(d)?;
        }
        let now = self.now();
        let sess = Arc::clone(&s);
        let (meta, doc_rev, extra) = self.write(move |tx| {
            let codec = &sess.codec;
            check_parent(tx, &req.workspace_id, req.parent_id.as_deref())?;
            let key = position_key(
                tx,
                &req.workspace_id,
                req.parent_id.as_deref(),
                req.after_id.as_deref(),
                None,
                None,
            )?;
            if let Some(tpl) = &req.template_page_id {
                let src = load_page(tx, tpl)?.ok_or(StoreError::NotFound("template page"))?;
                let mut out = Vec::new();
                copy_tree(
                    tx,
                    codec,
                    &src,
                    req.parent_id.as_deref(),
                    &key,
                    true,
                    "",
                    true,
                    now,
                    &mut out,
                    0,
                )?;
                let mut out = out.into_iter();
                let (mut root, root_doc) = out
                    .next()
                    .ok_or(StoreError::Internal("template copy".into()))?;
                let row = load_page(tx, &root.id)?.ok_or(StoreError::NotFound("page"))?;
                let mut payload = decode_page(codec, &row)?;
                if req.title.is_some() {
                    payload.title.clone_from(&title);
                }
                if req.icon.is_some() {
                    payload.icon.clone_from(&req.icon);
                }
                write_payload(tx, codec, &row, &payload, row.rev + 1, now)?;
                root = load_meta(tx, codec, &root.id)?.ok_or(StoreError::NotFound("page"))?;
                let rev = i64::from(root_doc.is_some());
                let mut extra = vec![(root.clone(), root_doc)];
                extra.extend(out);
                return Ok((root, rev, extra));
            }
            let id = new_id();
            let mut payload = PagePayload::new(&title);
            payload.icon.clone_from(&req.icon);
            insert_page(
                tx,
                codec,
                &id,
                &req.workspace_id,
                req.parent_id.as_deref(),
                req.kind,
                &key,
                &payload,
                now,
            )?;
            let mut rev = 0;
            if let Some(d) = &doc {
                insert_or_replace_doc(tx, codec, &id, "page", d, 1, now)?;
                rev = 1;
            }
            let meta = load_meta(tx, codec, &id)?.ok_or(StoreError::NotFound("page"))?;
            Ok((meta.clone(), rev, vec![(meta, doc)]))
        })?;
        for (m, d) in &extra {
            self.index_page(&s, m, d.as_ref());
        }
        let mut upserted: Vec<PageMeta> = extra.into_iter().map(|(m, _)| m).collect();
        if let Some(p) = &meta.parent_id
            && let Ok(Some(pm)) = self.read(|c| load_meta(c, &s.codec, p))
        {
            upserted.push(pm);
        }
        self.tree_changed(&meta.workspace_id, upserted, Vec::new());
        self.tour_tick_quiet("create_page");
        Ok(PageCreated { meta, doc_rev })
    }

    /// `page_update_meta`.
    pub fn page_update_meta(&self, id: &str, patch: PageMetaPatch) -> Result<PageMeta> {
        if let Some(t) = &patch.title {
            validate_title(t)?;
        }
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let id = id.to_owned();
        let meta = self.write(move |tx| {
            let row = load_page(tx, &id)?.ok_or(StoreError::NotFound("page"))?;
            let mut p = decode_page(&sess.codec, &row)?;
            if let Some(t) = patch.title {
                p.title = t;
            }
            if let Some(i) = patch.icon {
                p.icon = i;
            }
            if let Some(c) = patch.cover {
                p.cover = c;
            }
            if let Some(f) = &patch.flags {
                p.flags.apply(f);
            }
            write_payload(tx, &sess.codec, &row, &p, row.rev + 1, now)?;
            load_meta(tx, &sess.codec, &row.id)?.ok_or(StoreError::NotFound("page"))
        })?;
        self.index_page(&s, &meta, None);
        self.emit(StoreEvent::PageChanged {
            id: meta.id.clone(),
            meta_rev: Some(meta.rev),
            doc_rev: None,
        });
        self.tree_changed(&meta.workspace_id, vec![meta.clone()], Vec::new());
        Ok(meta)
    }

    /// `page_move`: re-parents and/or reorders a page (cycle-checked).
    pub fn page_move(
        &self,
        id: &str,
        parent_id: Option<&str>,
        before_id: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<PageMeta> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (id, parent, before, after) = (
            id.to_owned(),
            parent_id.map(str::to_owned),
            before_id.map(str::to_owned),
            after_id.map(str::to_owned),
        );
        let (meta, old_parent) = self.write(move |tx| {
            let row = load_page(tx, &id)?.ok_or(StoreError::NotFound("page"))?;
            if row.deleted_at.is_some() {
                return Err(StoreError::invalid("the page is in the trash"));
            }
            check_parent(tx, &row.workspace_id, parent.as_deref())?;
            // Cycle check: walk up from the new parent.
            let mut cur = parent.clone();
            let mut depth = 0;
            while let Some(p) = cur {
                if p == id {
                    return Err(StoreError::invalid_field(
                        "parentId",
                        "a page cannot be moved into itself",
                    ));
                }
                depth += 1;
                if depth > MAX_TREE_DEPTH {
                    return Err(StoreError::invalid("page tree is too deep"));
                }
                cur = load_page(tx, &p)?.and_then(|r| r.parent_id);
            }
            let key = position_key(
                tx,
                &row.workspace_id,
                parent.as_deref(),
                after.as_deref(),
                before.as_deref(),
                Some(&id),
            )?;
            tx.prepare_cached(
                "UPDATE pages SET parent_id = ?2, sort_key = ?3, updated_at = ?4 WHERE id = ?1",
            )?
            .execute(params![id, parent, key, now])?;
            let meta = load_meta(tx, &sess.codec, &id)?.ok_or(StoreError::NotFound("page"))?;
            Ok((meta, row.parent_id))
        })?;
        self.index_page(&s, &meta, None);
        let mut up = vec![meta.clone()];
        for p in [old_parent, meta.parent_id.clone()].into_iter().flatten() {
            if let Ok(Some(m)) = self.read(|c| load_meta(c, &s.codec, &p)) {
                up.push(m);
            }
        }
        self.tree_changed(&meta.workspace_id, up, Vec::new());
        Ok(meta)
    }

    /// `page_delete`: moves pages (with their live subtrees) to the trash.
    pub fn page_delete(&self, ids: &[String]) -> Result<()> {
        if ids.len() > MAX_IDS {
            return Err(StoreError::TooLarge("too many ids"));
        }
        let s = self.session()?;
        let now = self.now();
        let ids = ids.to_vec();
        let removed: Vec<(String, Vec<String>)> = self.write(move |tx| {
            let mut out = Vec::new();
            for id in ids {
                let Some(row) = load_page(tx, &id)? else {
                    continue;
                };
                if row.deleted_at.is_some() {
                    continue;
                }
                let sub = subtree_ids(tx, &id, true)?;
                for sid in &sub {
                    tx.prepare_cached(
                        "UPDATE pages SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                    )?
                    .execute(params![sid, now])?;
                }
                tx.prepare_cached("UPDATE pages SET trash_root = 1 WHERE id = ?1")?
                    .execute([&id])?;
                out.push((row.workspace_id, sub));
            }
            Ok(out)
        })?;
        for (ws, sub) in removed {
            {
                let mut idx = s.search.write();
                for id in &sub {
                    idx.set_hidden(id, true);
                }
            }
            self.tree_changed(&ws, Vec::new(), sub);
        }
        Ok(())
    }

    /// `page_restore`: restores trashed pages (to the root if the parent is gone).
    pub fn page_restore(&self, ids: &[String]) -> Result<Vec<PageMeta>> {
        if ids.len() > MAX_IDS {
            return Err(StoreError::TooLarge("too many ids"));
        }
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let ids = ids.to_vec();
        let restored: Vec<(PageMeta, Vec<String>)> = self.write(move |tx| {
            let mut out = Vec::new();
            for id in ids {
                let Some(row) = load_page(tx, &id)? else { continue };
                let Some(at) = row.deleted_at else { continue };
                let sql = "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at = ?2 AND p.trash_root = 0) SELECT id FROM sub";
                let sub: Vec<String> = {
                    let mut st = tx.prepare_cached(sql)?;
                    let rows = st.query_map(params![id, at], |r| r.get(0))?;
                    rows.collect::<rusqlite::Result<_>>()?
                };
                for sid in &sub {
                    tx.prepare_cached("UPDATE pages SET deleted_at = NULL, trash_root = 0 WHERE id = ?1")?
                        .execute([sid])?;
                }
                let parent_live = match &row.parent_id {
                    Some(p) => load_page(tx, p)?.is_some_and(|r| r.deleted_at.is_none()),
                    None => true,
                };
                if !parent_live {
                    let key = position_key(tx, &row.workspace_id, None, None, None, Some(&id))?;
                    tx.prepare_cached("UPDATE pages SET parent_id = NULL, sort_key = ?2 WHERE id = ?1")?
                        .execute(params![id, key])?;
                }
                let meta = load_meta(tx, &sess.codec, &id)?.ok_or(StoreError::NotFound("page"))?;
                out.push((meta, sub));
            }
            Ok(out)
        })?;
        let mut metas = Vec::new();
        for (meta, sub) in restored {
            {
                let mut idx = s.search.write();
                for id in &sub {
                    idx.set_hidden(id, false);
                }
            }
            let upserted = self.page_get_meta(&sub)?;
            self.tree_changed(&meta.workspace_id, upserted, Vec::new());
            metas.push(meta);
        }
        Ok(metas)
    }

    /// `page_purge`: permanently deletes pages and their subtrees (docs and versions go with them).
    pub fn page_purge(&self, ids: &[String]) -> Result<()> {
        if ids.len() > MAX_IDS {
            return Err(StoreError::TooLarge("too many ids"));
        }
        let s = self.session()?;
        let ids = ids.to_vec();
        let removed: Vec<(String, Vec<String>)> = self.write(move |tx| {
            let mut out = Vec::new();
            for id in ids {
                let Some(row) = load_page(tx, &id)? else {
                    continue;
                };
                let sub = subtree_ids(tx, &id, false)?;
                tx.prepare_cached("DELETE FROM pages WHERE id = ?1")?
                    .execute([&id])?;
                out.push((row.workspace_id, sub));
            }
            Ok(out)
        })?;
        for (ws, sub) in removed {
            {
                let mut idx = s.search.write();
                let mut links = s.links.write();
                for id in &sub {
                    idx.remove(id);
                    links.remove(id);
                }
            }
            self.tree_changed(&ws, Vec::new(), sub);
        }
        Ok(())
    }

    /// `trash_list`: trash roots of a workspace, newest first, optionally filtered by title.
    pub fn trash_list(&self, workspace_id: &str, q: Option<&str>) -> Result<Vec<PageMeta>> {
        let s = self.session()?;
        let needle = q
            .map(crate::search::tokenize::normalize_term)
            .filter(|n| !n.is_empty());
        self.read(|c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT {PAGE_COLS} FROM pages p WHERE p.workspace_id = ?1 AND p.deleted_at IS NOT NULL AND p.trash_root = 1 ORDER BY p.deleted_at DESC"
            ))?;
            let rows: Vec<PageRow> = st.query_map([workspace_id], page_row)?.collect::<rusqlite::Result<_>>()?;
            let mut out = Vec::new();
            for r in rows {
                let m = meta_of(&s.codec, &r)?;
                if needle
                    .as_ref()
                    .is_none_or(|n| crate::search::tokenize::normalize_term(&m.title).contains(n.as_str()))
                {
                    out.push(m);
                }
            }
            Ok(out)
        })
    }

    /// `trash_empty` (job): purges every trash root of a workspace.
    pub fn trash_empty(&self, workspace_id: &str, progress: &dyn Progress) -> Result<usize> {
        let roots: Vec<String> = self
            .trash_list(workspace_id, None)?
            .into_iter()
            .map(|m| m.id)
            .collect();
        let total = roots.len() as u64;
        for (i, chunk) in roots.chunks(100).enumerate() {
            if progress.cancelled() {
                return Err(StoreError::Cancelled);
            }
            self.page_purge(chunk)?;
            progress.progress(((i + 1) * 100).min(roots.len()) as u64, total, "trash");
        }
        Ok(roots.len())
    }

    /// Purges trash older than `trashRetentionDays` (maintenance).
    pub fn trash_purge_expired(&self) -> Result<usize> {
        let days = i64::from(self.vault_settings()?.trash_retention_days);
        let cutoff = self.now() - days * 86_400_000;
        let ids: Vec<String> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT id FROM pages WHERE trash_root = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1")?;
            let rows = st.query_map([cutoff], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        for chunk in ids.chunks(100) {
            self.page_purge(chunk)?;
        }
        Ok(ids.len())
    }

    /// `page_duplicate` (job): copies a doc/dashboard page (deep: with its doc-page descendants) right after it.
    pub fn page_duplicate(&self, id: &str, deep: bool) -> Result<PageMeta> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let id = id.to_owned();
        let copies = self.write(move |tx| {
            let src = load_page(tx, &id)?.ok_or(StoreError::NotFound("page"))?;
            let key = position_key(
                tx,
                &src.workspace_id,
                src.parent_id.as_deref(),
                Some(&src.id),
                None,
                None,
            )?;
            let mut out = Vec::new();
            copy_tree(
                tx,
                &sess.codec,
                &src,
                src.parent_id.as_deref(),
                &key,
                deep,
                " (copy)",
                false,
                now,
                &mut out,
                0,
            )?;
            Ok(out)
        })?;
        for (m, d) in &copies {
            self.index_page(&s, m, d.as_ref());
        }
        let root = copies
            .first()
            .map(|c| c.0.clone())
            .ok_or(StoreError::Internal("duplicate".into()))?;
        self.tree_changed(
            &root.workspace_id,
            copies.into_iter().map(|c| c.0).collect(),
            Vec::new(),
        );
        Ok(root)
    }

    /// `page_turn_into_page`: moves blocks into a new child page and leaves a `pageRef` in their place.
    /// A `pre_bulk` version of the source doc is saved first.
    pub fn page_turn_into_page(
        &self,
        source_id: &str,
        block_ids: &[String],
        title: &str,
    ) -> Result<(PageMeta, i64)> {
        validate_title(title)?;
        if block_ids.is_empty() || block_ids.len() > 10_000 {
            return Err(StoreError::invalid_field(
                "blockIds",
                "invalid number of blocks",
            ));
        }
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let (source, blocks, title) = (source_id.to_owned(), block_ids.to_vec(), title.to_owned());
        let (meta, new_doc, child_doc, new_rev) = self.write(move |tx| {
            let codec = &sess.codec;
            let src = load_page(tx, &source)?.ok_or(StoreError::NotFound("page"))?;
            let (mut doc, rev) =
                load_doc(tx, codec, &source)?.ok_or(StoreError::NotFound("document"))?;
            crate::repo::versions::insert_version(
                tx,
                codec,
                &source,
                crate::model::VersionTargetKind::PageDoc,
                crate::model::VersionReason::PreBulk,
                None,
                &serde_json::to_value(&doc)?,
                now,
            )?;
            // The first selected block (in document order) is replaced by the page reference.
            let first = {
                let mut first = None;
                crate::doc::walk::for_each_block(&doc, &mut |b| {
                    if first.is_none() && blocks.iter().any(|x| x == b.id) {
                        first = Some(b.id.to_owned());
                    }
                });
                first.ok_or_else(|| StoreError::invalid_field("blockIds", "no such block"))?
            };
            let id = new_id();
            let placeholder = container(
                TipTapNode::new("pageRef").with_attr("pageId", serde_json::json!(id)),
                None,
            )?;
            let ph_id = placeholder.attr_str("id").unwrap_or_default().to_owned();
            crate::doc::walk::insert_before(&mut doc, &first, placeholder);
            let moved = remove_blocks(&mut doc, &blocks);
            normalize(&mut doc)?;
            if find_block(&doc, &ph_id).is_none() {
                return Err(StoreError::Internal(
                    "turn-into-page lost its placeholder".into(),
                ));
            }
            let mut child = TipTapDoc::from_blocks(moved);
            normalize(&mut child)?;
            let key = position_key(tx, &src.workspace_id, Some(&source), None, None, None)?;
            insert_page(
                tx,
                codec,
                &id,
                &src.workspace_id,
                Some(&source),
                PageKind::Doc,
                &key,
                &PagePayload::new(&title),
                now,
            )?;
            insert_or_replace_doc(tx, codec, &id, "page", &child, 1, now)?;
            insert_or_replace_doc(tx, codec, &source, "page", &doc, rev + 1, now)?;
            let meta = load_meta(tx, codec, &id)?.ok_or(StoreError::NotFound("page"))?;
            Ok((meta, doc, child, rev + 1))
        })?;
        self.index_page(&s, &meta, Some(&child_doc));
        if let Ok(Some(src_meta)) = self.read(|c| load_meta(c, &s.codec, source_id)) {
            self.index_page(&s, &src_meta, Some(&new_doc));
            self.tree_changed(&meta.workspace_id, vec![meta.clone(), src_meta], Vec::new());
        }
        self.emit(StoreEvent::PageChanged {
            id: source_id.to_owned(),
            meta_rev: None,
            doc_rev: Some(new_rev),
        });
        Ok((meta, new_rev))
    }

    /// `page_backlinks`: pages linking here, with snippets (trashed sources excluded).
    pub fn page_backlinks(&self, id: &str) -> Result<Vec<Backlink>> {
        let s = self.session()?;
        let links = s.links.read().backlinks(id);
        let mut out = Vec::new();
        let mut cache: HashMap<String, Option<PageMeta>> = HashMap::new();
        for (source, link) in links {
            let meta = match cache.get(&source) {
                Some(m) => m.clone(),
                None => {
                    let m = self.read(|c| load_meta(c, &s.codec, &source))?;
                    cache.insert(source.clone(), m.clone());
                    m
                }
            };
            let Some(meta) = meta.filter(|m| m.deleted_at.is_none()) else {
                continue;
            };
            out.push(Backlink {
                source_id: source,
                source_title: meta.title,
                source_icon: meta.icon,
                block_id: link.block_id,
                snippet: link.snippet,
            });
        }
        Ok(out)
    }

    /// `page_outline`: headings of a page's doc.
    pub fn page_outline(&self, id: &str) -> Result<Vec<OutlineItem>> {
        let s = self.session()?;
        let doc = self.read(|c| load_doc(c, &s.codec, id))?;
        Ok(doc.map(|(d, _)| extract(&d).outline).unwrap_or_default())
    }

    /// `page_get_block`.
    pub fn page_get_block(&self, page_id: &str, block_id: &str) -> Result<Option<TipTapNode>> {
        let s = self.session()?;
        let doc = self.read(|c| load_doc(c, &s.codec, page_id))?;
        Ok(doc.and_then(|(d, _)| find_block(&d, block_id).cloned()))
    }

    /// `page_set_template`.
    pub fn page_set_template(&self, id: &str, template: bool) -> Result<PageMeta> {
        self.page_update_meta(
            id,
            PageMetaPatch {
                flags: Some(crate::model::PageFlags {
                    template: Some(template),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
    }

    /// `template_list`: user templates (pages flagged as templates). Built-in templates are added by the app.
    pub fn template_list(&self, workspace_id: &str) -> Result<Vec<TemplateInfo>> {
        Ok(self
            .page_tree(workspace_id)?
            .into_iter()
            .filter(|m| m.flags.template == Some(true))
            .map(|m| TemplateInfo {
                id: m.id,
                title: m.title,
                icon: m.icon,
                builtin: false,
                category: "My templates".into(),
                kind: m.kind,
            })
            .collect())
    }

    /// `template_apply` for user templates: a deep copy of the template page (template flag cleared).
    pub fn template_apply(
        &self,
        template_id: &str,
        workspace_id: &str,
        parent_id: Option<&str>,
    ) -> Result<PageMeta> {
        let tpl = self.page_get(template_id)?.meta;
        let mut req = PageCreate::new(workspace_id, parent_id, tpl.kind, &tpl.title);
        req.icon = tpl.icon;
        req.template_page_id = Some(template_id.to_owned());
        let meta = self.page_create(req)?.meta;
        self.tour_tick_quiet("templates");
        Ok(meta)
    }

    /// `daily_note_open`: the daily note for `date` (`YYYY-MM-DD`) in the first workspace, created if missing
    /// under a root "Daily notes" page.
    pub fn daily_note_open(&self, date: &str) -> Result<PageMeta> {
        let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| StoreError::invalid_field("date", "expected YYYY-MM-DD"))?;
        let s = self.session()?;
        let ws = self
            .workspace_list()?
            .into_iter()
            .next()
            .ok_or(StoreError::NotFound("workspace"))?;
        let key = format!("daily:{date}");
        let (existing, folder) = self.read(|c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT {PAGE_COLS} FROM pages p WHERE p.workspace_id = ?1 AND p.deleted_at IS NULL AND p.kind = 'doc'"
            ))?;
            let rows: Vec<PageRow> = st.query_map([&ws.id], page_row)?.collect::<rusqlite::Result<_>>()?;
            let mut found = None;
            let mut folder = None;
            for r in rows {
                let p = decode_page(&s.codec, &r)?;
                match p.template_key.as_deref() {
                    Some(k) if k == key => found = Some(to_meta(&r, p)?),
                    Some("daily:folder") => folder = Some(r.id.clone()),
                    _ => {}
                }
            }
            Ok((found, folder))
        })?;
        if let Some(m) = existing {
            return Ok(m);
        }
        let folder = match folder {
            Some(f) => f,
            None => {
                let f = self
                    .page_create(PageCreate::new(&ws.id, None, PageKind::Doc, "Daily notes"))?
                    .meta;
                self.set_template_key(&f.id, Some("daily:folder"))?;
                f.id
            }
        };
        let title = day.format("%B %-d, %Y").to_string();
        let mut req = PageCreate::new(&ws.id, Some(&folder), PageKind::Doc, &title);
        req.doc = Some(TipTapDoc::empty()?);
        let created = self.page_create(req)?.meta;
        self.set_template_key(&created.id, Some(&key))
    }

    /// Sets `PagePayload.templateKey` (life apps, daily notes).
    pub fn set_template_key(&self, id: &str, key: Option<&str>) -> Result<PageMeta> {
        let s = self.session()?;
        let now = self.now();
        let (id, key) = (id.to_owned(), key.map(str::to_owned));
        let sess = Arc::clone(&s);
        self.write(move |tx| {
            let row = load_page(tx, &id)?.ok_or(StoreError::NotFound("page"))?;
            let mut p = decode_page(&sess.codec, &row)?;
            p.template_key = key;
            write_payload(tx, &sess.codec, &row, &p, row.rev + 1, now)?;
            load_meta(tx, &sess.codec, &id)?.ok_or(StoreError::NotFound("page"))
        })
    }

    /// The decoded payload of a page (for other repositories: life apps, databases).
    pub fn page_payload(&self, id: &str) -> Result<PagePayload> {
        let s = self.session()?;
        self.read(|c| {
            let row = load_page(c, id)?.ok_or(StoreError::NotFound("page"))?;
            decode_page(&s.codec, &row)
        })
    }
}

/// Used by `Session`-holding helpers in other modules.
pub(crate) fn session_meta(store: &Store, s: &Session, id: &str) -> Result<Option<PageMeta>> {
    store.read(|c| load_meta(c, &s.codec, id))
}
