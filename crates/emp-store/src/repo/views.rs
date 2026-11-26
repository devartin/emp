//! Database views (SPEC §8.3, §10.2 `db_views`, §11.3 `db_view_*`): create (blank or from another view), patch,
//! soft delete, reorder. Filters are validated against the schema (depth ≤ 3, operators by type).

use std::collections::BTreeMap;
use std::sync::Arc;

use emp_crypto::TableTag;
use rusqlite::{Connection, params};

use crate::codec::{Codec, RecordLoc};
use crate::model::ids::new_id;
use crate::model::validate_title;
use crate::query::filter;
use crate::query::model::{CalendarSettings, Layout, PropType, View, ViewPatch, ViewPayload};
use crate::repo::databases::{bump, key_among, live_properties, load_db};
use crate::{Result, Store, StoreError};

/// Maximum views per database.
pub const MAX_VIEWS: usize = 100;

fn view_loc(id: &str, rev: i64) -> RecordLoc {
    RecordLoc::row(TableTag::DbViews, id, u64::try_from(rev).unwrap_or(0))
}

struct ViewRow {
    id: String,
    database_id: String,
    sort_key: String,
    rev: i64,
    payload: ViewPayload,
}

fn load_view_row(conn: &Connection, codec: &Codec, id: &str) -> Result<ViewRow> {
    let raw: Option<(String, String, i64, i64, Vec<u8>)> = rusqlite::OptionalExtension::optional(
        conn.prepare_cached(
            "SELECT database_id, sort_key, rev, enc, payload FROM db_views WHERE id = ?1 AND deleted_at IS NULL",
        )?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))),
    )?;
    let (database_id, sort_key, rev, enc, payload) = raw.ok_or(StoreError::NotFound("view"))?;
    Ok(ViewRow {
        payload: codec.decode(&view_loc(id, rev), enc, &payload)?,
        id: id.to_owned(),
        database_id,
        sort_key,
        rev,
    })
}

/// Live views of a database in tab order.
pub(crate) fn load_views(conn: &Connection, codec: &Codec, db_id: &str) -> Result<Vec<View>> {
    let mut st = conn.prepare_cached(
        "SELECT id, sort_key, rev, enc, payload FROM db_views WHERE database_id = ?1 AND deleted_at IS NULL ORDER BY sort_key, id",
    )?;
    let rows: Vec<(String, String, i64, i64, Vec<u8>)> = st
        .query_map([db_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|(id, key, rev, enc, payload)| {
            let p: ViewPayload = codec.decode(&view_loc(&id, rev), enc, &payload)?;
            Ok(p.into_view(&id, &key))
        })
        .collect()
}

/// Loads one live view payload (`NOT_FOUND` if missing or of another database).
pub(crate) fn load_view(
    conn: &Connection,
    codec: &Codec,
    db_id: &str,
    id: &str,
) -> Result<ViewPayload> {
    let r = load_view_row(conn, codec, id)?;
    if r.database_id != db_id {
        return Err(StoreError::NotFound("view"));
    }
    Ok(r.payload)
}

pub(crate) fn insert_view(
    tx: &Connection,
    codec: &Codec,
    db_id: &str,
    id: &str,
    sort_key: &str,
    p: &ViewPayload,
) -> Result<()> {
    let e = codec.encode(&view_loc(id, 1), p)?;
    tx.prepare_cached(
        "INSERT INTO db_views (id, database_id, sort_key, deleted_at, rev, enc, payload) VALUES (?1, ?2, ?3, NULL, 1, ?4, ?5)",
    )?
    .execute(params![id, db_id, sort_key, e.enc, e.payload])?;
    Ok(())
}

fn save_view(tx: &Connection, codec: &Codec, r: &ViewRow, p: &ViewPayload) -> Result<()> {
    let rev = r.rev + 1;
    let e = codec.encode(&view_loc(&r.id, rev), p)?;
    tx.prepare_cached("UPDATE db_views SET rev = ?2, enc = ?3, payload = ?4 WHERE id = ?1")?
        .execute(params![r.id, rev, e.enc, e.payload])?;
    Ok(())
}

/// The payload of an IPC view.
pub(crate) fn view_payload(v: &View) -> ViewPayload {
    ViewPayload {
        v: 1,
        name: v.name.clone(),
        icon: v.icon.clone(),
        layout: v.layout,
        filter: v.filter.clone(),
        sorts: v.sorts.clone(),
        group_by: v.group_by.clone(),
        visible_props: v.visible_props.clone(),
        prop_widths: v.prop_widths.clone(),
        wrap: v.wrap.clone(),
        card: v.card.clone(),
        calendar: v.calendar.clone(),
        chart: v.chart.clone(),
        footer_aggs: v.footer_aggs.clone(),
        collapsed_groups: v.collapsed_groups.clone(),
        open_in: v.open_in,
    }
}

fn remap_filter(f: &mut crate::query::model::Filter, map: &BTreeMap<String, String>) {
    use crate::query::model::Filter;
    match f {
        Filter::And { and: k } | Filter::Or { or: k } => {
            k.iter_mut().for_each(|x| remap_filter(x, map))
        }
        Filter::Cond { prop, .. } => {
            if let Some(n) = map.get(prop) {
                prop.clone_from(n);
            }
        }
    }
}

/// Rewrites property ids in a view (database duplication).
pub(crate) fn remap_props(v: &mut ViewPayload, map: &BTreeMap<String, String>) {
    let m = |id: &String| map.get(id).cloned().unwrap_or_else(|| id.clone());
    v.visible_props = v.visible_props.iter().map(m).collect();
    v.prop_widths = v.prop_widths.iter().map(|(k, x)| (m(k), *x)).collect();
    v.wrap = v.wrap.iter().map(|(k, x)| (m(k), *x)).collect();
    v.footer_aggs = v.footer_aggs.iter().map(|(k, x)| (m(k), *x)).collect();
    for s in &mut v.sorts {
        s.prop = m(&s.prop);
    }
    if let Some(g) = &mut v.group_by {
        g.prop = m(&g.prop);
    }
    if let Some(c) = &mut v.calendar {
        c.date_prop = m(&c.date_prop);
    }
    if let Some(f) = &mut v.filter {
        remap_filter(f, map);
    }
    if let Some(c) = &mut v.chart {
        c.x.prop = m(&c.x.prop);
        for y in &mut c.y {
            y.prop = y.prop.as_ref().map(m);
        }
        if let Some(s) = &mut c.series {
            s.prop = m(&s.prop);
        }
    }
}

fn strip_filter(f: crate::query::model::Filter, prop: &str) -> Option<crate::query::model::Filter> {
    use crate::query::model::Filter;
    match f {
        Filter::And { and } => {
            let k: Vec<Filter> = and
                .into_iter()
                .filter_map(|x| strip_filter(x, prop))
                .collect();
            (!k.is_empty()).then_some(Filter::And { and: k })
        }
        Filter::Or { or } => {
            let k: Vec<Filter> = or
                .into_iter()
                .filter_map(|x| strip_filter(x, prop))
                .collect();
            (!k.is_empty()).then_some(Filter::Or { or: k })
        }
        c @ Filter::Cond { .. } => match &c {
            Filter::Cond { prop: p, .. } if p == prop => None,
            _ => Some(c),
        },
    }
}

/// Removes every reference to a deleted property from the database's views.
pub(crate) fn forget_property(
    tx: &Connection,
    codec: &Codec,
    db_id: &str,
    prop: &str,
) -> Result<()> {
    let ids: Vec<String> = load_views(tx, codec, db_id)?
        .into_iter()
        .map(|v| v.id)
        .collect();
    for id in ids {
        let r = load_view_row(tx, codec, &id)?;
        let mut p = r.payload.clone();
        p.visible_props.retain(|x| x != prop);
        p.prop_widths.remove(prop);
        p.wrap.remove(prop);
        p.footer_aggs.remove(prop);
        p.sorts.retain(|s| s.prop != prop);
        if p.group_by.as_ref().is_some_and(|g| g.prop == prop) {
            p.group_by = None;
        }
        p.filter = p.filter.take().and_then(|f| strip_filter(f, prop));
        if p != r.payload {
            save_view(tx, codec, &r, &p)?;
        }
    }
    Ok(())
}

fn validate_view(p: &ViewPayload, props: &[crate::query::model::Property]) -> Result<()> {
    validate_title(&p.name)?;
    if p.name.trim().is_empty() {
        return Err(StoreError::invalid_field(
            "name",
            "view names cannot be empty",
        ));
    }
    if let Some(f) = &p.filter {
        filter::validate(f, props)?;
    }
    if p.sorts.len() > 20 {
        return Err(StoreError::TooLarge("sorts"));
    }
    let known = |id: &str| {
        props.iter().any(|x| x.id == id) || matches!(id, "$created" | "$updated" | "$manual")
    };
    for s in &p.sorts {
        if !known(&s.prop) {
            return Err(StoreError::invalid_field("sorts", "unknown property"));
        }
    }
    if let Some(g) = &p.group_by {
        let pr = props
            .iter()
            .find(|x| x.id == g.prop)
            .ok_or_else(|| StoreError::invalid_field("groupBy", "unknown property"))?;
        if matches!(pr.kind, PropType::Files | PropType::Secret) {
            return Err(StoreError::invalid_field(
                "groupBy",
                "this property cannot be grouped",
            ));
        }
    }
    if p.prop_widths
        .values()
        .any(|w| !w.is_finite() || *w < 0.0 || *w > 10_000.0)
    {
        return Err(StoreError::invalid_field("propWidths", "invalid width"));
    }
    Ok(())
}

impl Store {
    /// `db_view_create`: a new view (copied from `from_view_id` when given). Calendar views default to the first
    /// date property; board views group by the first select / status property.
    pub fn db_view_create(
        &self,
        database_id: &str,
        name: &str,
        layout: Layout,
        from_view_id: Option<&str>,
    ) -> Result<View> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let (db, name, from) = (
            database_id.to_owned(),
            name.to_owned(),
            from_view_id.map(str::to_owned),
        );
        let view = self.write(move |tx| {
            let codec = &sess.codec;
            load_db(tx, codec, &db)?;
            let props = live_properties(tx, codec, &db)?;
            let existing = load_views(tx, codec, &db)?;
            if existing.len() >= MAX_VIEWS {
                return Err(StoreError::TooLarge("views"));
            }
            let mut p = match &from {
                Some(f) => {
                    let mut p = load_view(tx, codec, &db, f)?;
                    p.name.clone_from(&name);
                    p.layout = layout;
                    p
                }
                None => ViewPayload::new(
                    &name,
                    layout,
                    props
                        .iter()
                        .filter(|p| !p.hidden)
                        .map(|p| p.id.clone())
                        .collect(),
                ),
            };
            if layout == Layout::Calendar && p.calendar.is_none() {
                p.calendar =
                    props
                        .iter()
                        .find(|x| x.kind == PropType::Date)
                        .map(|x| CalendarSettings {
                            date_prop: x.id.clone(),
                            show_weekends: true,
                        });
            }
            if layout == Layout::Board && p.group_by.is_none() {
                p.group_by = props
                    .iter()
                    .find(|x| matches!(x.kind, PropType::Status | PropType::Select))
                    .map(|x| crate::query::model::GroupBy {
                        prop: x.id.clone(),
                        date_bucket: None,
                        by_status_group: None,
                        hide_empty: None,
                        order: None,
                    });
            }
            validate_view(&p, &props)?;
            let sibs: Vec<(String, String)> = existing
                .iter()
                .map(|v| (v.id.clone(), v.sort_key.clone()))
                .collect();
            let key = key_among(&sibs, from.as_deref(), None, None)
                .or_else(|_| key_among(&sibs, None, None, None))?;
            let id = new_id();
            insert_view(tx, codec, &db, &id, &key, &p)?;
            bump(tx, &db, true, false)?;
            Ok(p.into_view(&id, &key))
        })?;
        self.db_changed(database_id);
        Ok(view)
    }

    /// `db_view_update`.
    pub fn db_view_update(&self, id: &str, patch: ViewPatch) -> Result<View> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        let (view, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let r = load_view_row(tx, codec, &id_owned)?;
            let mut p = r.payload.clone();
            macro_rules! set {
                ($($f:ident),*) => { $( if let Some(x) = patch.$f { p.$f = x; } )* };
            }
            set!(
                name,
                icon,
                layout,
                filter,
                sorts,
                group_by,
                visible_props,
                prop_widths,
                wrap,
                card,
                calendar,
                chart,
                footer_aggs,
                collapsed_groups,
                open_in
            );
            let props = live_properties(tx, codec, &r.database_id)?;
            validate_view(&p, &props)?;
            save_view(tx, codec, &r, &p)?;
            bump(tx, &r.database_id, true, false)?;
            Ok((p.into_view(&r.id, &r.sort_key), r.database_id))
        })?;
        self.db_changed(&db);
        Ok(view)
    }

    /// `db_view_delete` (a database keeps at least one view).
    pub fn db_view_delete(&self, id: &str) -> Result<()> {
        let s = self.session()?;
        let now = self.now();
        let sess = Arc::clone(&s);
        let id_owned = id.to_owned();
        let db = self.write(move |tx| {
            let codec = &sess.codec;
            let r = load_view_row(tx, codec, &id_owned)?;
            if load_views(tx, codec, &r.database_id)?.len() <= 1 {
                return Err(StoreError::invalid("a database needs at least one view"));
            }
            tx.prepare_cached("UPDATE db_views SET deleted_at = ?2 WHERE id = ?1")?
                .execute(params![r.id, now])?;
            bump(tx, &r.database_id, true, false)?;
            Ok(r.database_id)
        })?;
        self.db_changed(&db);
        Ok(())
    }

    /// `db_view_reorder`.
    pub fn db_view_reorder(
        &self,
        id: &str,
        before_id: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<View> {
        let s = self.session()?;
        let sess = Arc::clone(&s);
        let (id_owned, before, after) = (
            id.to_owned(),
            before_id.map(str::to_owned),
            after_id.map(str::to_owned),
        );
        let (view, db) = self.write(move |tx| {
            let codec = &sess.codec;
            let r = load_view_row(tx, codec, &id_owned)?;
            let sibs: Vec<(String, String)> = load_views(tx, codec, &r.database_id)?
                .into_iter()
                .map(|v| (v.id, v.sort_key))
                .collect();
            let key = key_among(&sibs, after.as_deref(), before.as_deref(), Some(&r.id))?;
            tx.prepare_cached("UPDATE db_views SET sort_key = ?2 WHERE id = ?1")?
                .execute(params![r.id, key])?;
            bump(tx, &r.database_id, true, false)?;
            Ok((r.payload.into_view(&r.id, &key), r.database_id))
        })?;
        self.db_changed(&db);
        Ok(view)
    }
}
