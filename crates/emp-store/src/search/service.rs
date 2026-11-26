//! Store-level search and indexing: builds the search and backlink indexes after unlock, keeps them current on
//! every save, and answers `search_query` / `search_status`.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use crate::doc::index::extract;
use crate::model::{
    PageMeta, SearchFilters, SearchHitKind, SearchQueryResult, SearchStatus, TipTapDoc,
};
use crate::repo::docs::load_doc;
use crate::repo::pages::{PAGE_COLS, decode_page, page_row, to_meta};
use crate::search::{LinkIndexAlias, SearchDoc, SearchIndex, parse_query};
use crate::vault::{Session, StoreEvent};
use crate::{Progress, Result, Store, StoreError};

/// Maximum query length (SPEC §11.1).
pub const MAX_QUERY_CHARS: usize = 512;

fn search_doc(meta: &PageMeta, blocks: Vec<(String, String)>) -> SearchDoc {
    SearchDoc {
        id: meta.id.clone(),
        kind: match meta.kind {
            crate::model::PageKind::Database => SearchHitKind::Database,
            crate::model::PageKind::Sheet => SearchHitKind::Sheet,
            _ => SearchHitKind::Page,
        },
        title: meta.title.clone(),
        icon: meta.icon.clone(),
        parent_id: meta.parent_id.clone(),
        db_id: None,
        updated_at: meta.updated_at,
        blocks,
        hidden: meta.deleted_at.is_some(),
    }
}

fn apply(
    search: &mut SearchIndex,
    links: &mut LinkIndexAlias,
    meta: &PageMeta,
    doc: Option<&TipTapDoc>,
) {
    match doc {
        Some(d) => {
            let x = extract(d);
            links.set(&meta.id, x.links);
            search.upsert(search_doc(
                meta,
                x.blocks.into_iter().map(|b| (b.id, b.text)).collect(),
            ));
        }
        None => {
            if search.get(&meta.id).is_some() {
                search.update_meta(
                    &meta.id,
                    &meta.title,
                    meta.icon.clone(),
                    meta.parent_id.clone(),
                    meta.updated_at,
                    meta.deleted_at.is_some(),
                );
            } else {
                search.upsert(search_doc(meta, Vec::new()));
            }
        }
    }
}

impl Store {
    /// Updates the indexes for one page (or marks it dirty while the initial build runs).
    pub(crate) fn index_page(
        &self,
        session: &Arc<Session>,
        meta: &PageMeta,
        doc: Option<&TipTapDoc>,
    ) {
        {
            let mut st = session.index_state.lock();
            if !st.ready {
                st.dirty.insert(meta.id.clone());
                return;
            }
        }
        let mut search = session.search.write();
        let mut links = session.links.write();
        apply(&mut search, &mut links, meta, doc);
    }

    fn reindex_from_db(&self, session: &Arc<Session>, id: &str) -> Result<()> {
        let loaded = self.read(|c| {
            let Some(row) = crate::repo::pages::load_page(c, id)? else {
                return Ok(None);
            };
            let meta = to_meta(&row, decode_page(&session.codec, &row)?)?;
            let doc = load_doc(c, &session.codec, id)?.map(|d| d.0);
            Ok(Some((meta, doc)))
        })?;
        let mut search = session.search.write();
        let mut links = session.links.write();
        match loaded {
            Some((meta, doc)) => apply(&mut search, &mut links, &meta, doc.as_ref()),
            None => {
                search.remove(id);
                links.remove(id);
            }
        }
        Ok(())
    }

    /// Builds both indexes from the database (after unlock and for `search_reindex`).
    pub(crate) fn build_indexes(&self, session: &Arc<Session>) -> Result<usize> {
        {
            let mut st = session.index_state.lock();
            st.building = true;
            st.progress = 0.0;
        }
        let result = self.build_indexes_inner(session);
        let mut st = session.index_state.lock();
        st.building = false;
        result
    }

    fn build_indexes_inner(&self, session: &Arc<Session>) -> Result<usize> {
        let ids: Vec<String> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT id FROM pages ORDER BY id")?;
            let rows = st.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        let total = ids.len().max(1);
        let mut search = SearchIndex::default();
        let mut links = LinkIndexAlias::default();
        for (i, chunk) in ids.chunks(200).enumerate() {
            if session.cancel.load(Ordering::SeqCst) {
                return Err(StoreError::Cancelled);
            }
            let batch: Vec<(PageMeta, Option<TipTapDoc>)> = self.read(|c| {
                let mut out = Vec::with_capacity(chunk.len());
                let mut st =
                    c.prepare_cached(&format!("SELECT {PAGE_COLS} FROM pages p WHERE p.id = ?1"))?;
                for id in chunk {
                    let Some(row) = st.query_map([id], page_row)?.next().transpose()? else {
                        continue;
                    };
                    // Damaged items are skipped here; the integrity check reports them.
                    let Ok(payload) = decode_page(&session.codec, &row) else {
                        continue;
                    };
                    let meta = to_meta(&row, payload)?;
                    let doc = load_doc(c, &session.codec, id).ok().flatten().map(|d| d.0);
                    out.push((meta, doc));
                }
                Ok(out)
            })?;
            for (meta, doc) in &batch {
                apply(&mut search, &mut links, meta, doc.as_ref());
            }
            session.index_state.lock().progress = ((i + 1) * 200).min(total) as f64 / total as f64;
        }
        let docs = search.len();
        *session.search.write() = search;
        *session.links.write() = links;
        let dirty: Vec<String> = {
            let mut st = session.index_state.lock();
            st.ready = true;
            std::mem::take(&mut st.dirty).into_iter().collect()
        };
        for id in dirty {
            self.reindex_from_db(session, &id)?;
        }
        // Database rows (titles and bodies) join the index once it is ready.
        let docs = docs + self.db_index_rows().unwrap_or(0);
        self.emit(StoreEvent::SearchReady { docs });
        Ok(docs)
    }

    /// `search_query`.
    pub fn search_query(
        &self,
        q: &str,
        filters: Option<&SearchFilters>,
        limit: usize,
        req_id: u64,
    ) -> Result<SearchQueryResult> {
        if q.chars().count() > MAX_QUERY_CHARS {
            return Err(StoreError::invalid_field(
                "q",
                "queries are limited to 512 characters",
            ));
        }
        let s = self.session()?;
        let started = Instant::now();
        let now = self.now();
        let parsed = parse_query(q, filters, now);
        let ready = s.index_state.lock().ready;
        let hits = s.search.read().query(&parsed, limit, now);
        Ok(SearchQueryResult {
            req_id,
            hits,
            index_ready: ready,
            took_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    /// `search_status`.
    pub fn search_status(&self) -> Result<SearchStatus> {
        let s = self.session()?;
        let st = s.index_state.lock();
        Ok(SearchStatus {
            ready: st.ready,
            docs: s.search.read().len(),
            building: st.building,
            progress: st.building.then_some(st.progress),
        })
    }

    /// `search_reindex` (job): rebuilds the indexes from scratch.
    pub fn search_reindex(&self, progress: &dyn Progress) -> Result<usize> {
        let s = self.session()?;
        progress.progress(0, 1, "index");
        s.index_state.lock().ready = false;
        let n = self.build_indexes(&s)?;
        progress.progress(1, 1, "index");
        Ok(n)
    }

    /// Adds or replaces a search document from another repository (rows, databases, sheets, assets).
    pub fn search_upsert_doc(&self, doc: SearchDoc) -> Result<()> {
        let s = self.session()?;
        s.search.write().upsert(doc);
        Ok(())
    }

    /// Removes a search document.
    pub fn search_remove_doc(&self, id: &str) -> Result<()> {
        let s = self.session()?;
        s.search.write().remove(id);
        Ok(())
    }

    /// Blocks until the index is ready (tests and app start-up flows). Returns `false` on timeout.
    pub fn wait_index_ready(&self, timeout: std::time::Duration) -> Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.session()?.index_state.lock().ready {
                return Ok(true);
            }
            if Instant::now() > deadline {
                return Ok(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}
