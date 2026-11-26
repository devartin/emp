//! Workspaces (SPEC §10.2 `workspaces`, §11.3 Workspaces).

use emp_crypto::TableTag;
use rusqlite::{Connection, OptionalExtension, params};

use crate::codec::{Codec, RecordLoc};
use crate::model::sort_key::key_between;
use crate::model::{
    Icon, Workspace, WorkspaceDefaults, WorkspaceOpen, WorkspacePatch, WorkspacePayload,
    ids::new_id, validate_title,
};
use crate::{Result, Store, StoreError};

/// Recents kept per workspace.
pub const MAX_RECENTS: usize = 50;
/// Favourites kept per workspace.
pub const MAX_FAVORITES: usize = 500;

/// A decoded workspace row.
#[derive(Debug, Clone)]
pub(crate) struct WsRow {
    pub id: String,
    pub rev: i64,
    pub payload: WorkspacePayload,
}

pub(crate) fn load_ws(conn: &Connection, codec: &Codec, id: &str) -> Result<Option<WsRow>> {
    let raw: Option<(i64, i64, Vec<u8>)> = conn
        .prepare_cached("SELECT rev, enc, payload FROM workspaces WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    raw.map(|(rev, enc, payload)| {
        let loc = RecordLoc::row(TableTag::Workspaces, id, u64::try_from(rev).unwrap_or(0));
        Ok(WsRow {
            id: id.to_owned(),
            rev,
            payload: codec.decode(&loc, enc, &payload)?,
        })
    })
    .transpose()
}

pub(crate) fn save_ws(conn: &Connection, codec: &Codec, row: &WsRow, now: i64) -> Result<()> {
    let loc = RecordLoc::row(
        TableTag::Workspaces,
        &row.id,
        u64::try_from(row.rev).unwrap_or(0),
    );
    let e = codec.encode(&loc, &row.payload)?;
    conn.prepare_cached(
        "UPDATE workspaces SET rev = ?2, updated_at = ?3, enc = ?4, payload = ?5 WHERE id = ?1",
    )?
    .execute(params![row.id, row.rev, now, e.enc, e.payload])?;
    Ok(())
}

fn to_dto(row: &WsRow) -> Workspace {
    Workspace {
        id: row.id.clone(),
        name: row.payload.name.clone(),
        icon: row.payload.icon.clone(),
        favorites: row.payload.favorites.clone(),
        defaults: row.payload.defaults.clone(),
    }
}

impl Store {
    /// `workspace_list`, in sidebar order.
    pub fn workspace_list(&self) -> Result<Vec<Workspace>> {
        let s = self.session()?;
        self.read(|c| {
            let ids: Vec<String> = {
                let mut st = c.prepare_cached("SELECT id FROM workspaces ORDER BY sort_key, id")?;
                let rows = st.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(row) = load_ws(c, &s.codec, &id)? {
                    out.push(to_dto(&row));
                }
            }
            Ok(out)
        })
    }

    /// One workspace.
    pub fn workspace_get(&self, id: &str) -> Result<Workspace> {
        let s = self.session()?;
        self.read(|c| load_ws(c, &s.codec, id))?
            .map(|r| to_dto(&r))
            .ok_or(StoreError::NotFound("workspace"))
    }

    /// `workspace_create`.
    pub fn workspace_create(&self, name: &str, icon: Option<Icon>) -> Result<Workspace> {
        validate_title(name)?;
        let s = self.session()?;
        let id = new_id();
        let now = self.now();
        let payload = WorkspacePayload {
            v: 1,
            name: name.to_owned(),
            icon,
            favorites: Vec::new(),
            recents: Vec::new(),
            defaults: WorkspaceDefaults::default(),
        };
        let row = WsRow {
            id: id.clone(),
            rev: 1,
            payload,
        };
        let e = s
            .codec
            .encode(&RecordLoc::row(TableTag::Workspaces, &id, 1), &row.payload)?;
        let dto = to_dto(&row);
        self.write(move |tx| {
            let last: Option<String> = tx
                .query_row("SELECT max(sort_key) FROM workspaces", [], |r| r.get(0))
                .optional()?
                .flatten();
            let key = key_between(last.as_deref(), None)?;
            tx.prepare_cached(
                "INSERT INTO workspaces (id, sort_key, created_at, updated_at, rev, enc, payload) VALUES (?1, ?2, ?3, ?3, 1, ?4, ?5)",
            )?
            .execute(params![id, key, now, e.enc, e.payload])?;
            Ok(())
        })?;
        Ok(dto)
    }

    /// `workspace_update`.
    pub fn workspace_update(&self, id: &str, patch: WorkspacePatch) -> Result<Workspace> {
        if let Some(n) = &patch.name {
            validate_title(n)?;
        }
        if patch
            .favorites
            .as_ref()
            .is_some_and(|f| f.len() > MAX_FAVORITES)
        {
            return Err(StoreError::TooLarge("favorites"));
        }
        let s = self.session()?;
        let now = self.now();
        let id = id.to_owned();
        self.write(move |tx| {
            let mut row = load_ws(tx, &s.codec, &id)?.ok_or(StoreError::NotFound("workspace"))?;
            if let Some(n) = patch.name {
                row.payload.name = n;
            }
            if let Some(i) = patch.icon {
                row.payload.icon = i;
            }
            if let Some(f) = patch.favorites {
                row.payload.favorites = f;
            }
            if let Some(d) = patch.defaults {
                row.payload.defaults = d;
            }
            row.rev += 1;
            save_ws(tx, &s.codec, &row, now)?;
            Ok(to_dto(&row))
        })
    }

    /// Records a page visit in the workspace's recents (most recent first).
    pub fn workspace_touch_recent(&self, workspace_id: &str, page_id: &str) -> Result<()> {
        let s = self.session()?;
        let now = self.now();
        let (ws, page) = (workspace_id.to_owned(), page_id.to_owned());
        self.write(move |tx| {
            let mut row = load_ws(tx, &s.codec, &ws)?.ok_or(StoreError::NotFound("workspace"))?;
            if row.payload.recents.first() == Some(&page) {
                return Ok(());
            }
            row.payload.recents.retain(|p| *p != page);
            row.payload.recents.insert(0, page);
            row.payload.recents.truncate(MAX_RECENTS);
            row.rev += 1;
            save_ws(tx, &s.codec, &row, now)
        })
    }

    /// `workspace_open`: the workspace, its live page tree and recents (the app adds `lifeapps` / `lastRoute`).
    pub fn workspace_open(&self, id: &str) -> Result<WorkspaceOpen> {
        let s = self.session()?;
        let row = self
            .read(|c| load_ws(c, &s.codec, id))?
            .ok_or(StoreError::NotFound("workspace"))?;
        let pages = self.page_tree(id)?;
        let live: std::collections::HashSet<&str> = pages.iter().map(|p| p.id.as_str()).collect();
        let recents = row
            .payload
            .recents
            .iter()
            .filter(|r| live.contains(r.as_str()))
            .cloned()
            .collect();
        let lifeapps = self.lifeapp_instances(id)?;
        Ok(WorkspaceOpen {
            workspace: to_dto(&row),
            pages,
            recents,
            lifeapps,
        })
    }
}
