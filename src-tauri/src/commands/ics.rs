//! ICS commands and the local-calendar store (SPEC §11.3 `ics_export`, `import_ics`, §17.3).
//!
//! * **Local calendars.** `import_ics({ target: 'calendar' })` keeps a calendar file as a read-only calendar. Its
//!   events are stored, normalised, in the encrypted kv store (`ns = cal.ics`, chunked below the 1 MiB value cap)
//!   and expanded on demand by `calendar_events` (source `ics`), so recurring series work for any range offline.
//! * **Database import.** `import_ics({ target: { databaseId } })` appends one row per event (non-recurring events and
//!   the first instance of a series) and records an app-level undo log for `import_undo`.
//! * **Export.** `ics_export` writes the dated rows of a database (or individual rows) as RFC 5545.

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use emp_integrations::ics::{
    ExportCalendar, IcsCalendar, IcsDateTime, IcsEvent, IcsLimits, expand_event, generate_ics,
    resolve_tzid,
};
use emp_store::Store;
use emp_store::dbmodel::{CellValue, DateValue, DbSchema, PropType, RowDto, rich, rich_plain};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, blocking};
use crate::validate;

/// kv namespace of local calendars.
pub const CAL_NS: &str = "cal.ics";
/// kv key of the calendar index.
pub const INDEX_KEY: &str = "index";
/// kv namespace of app-level import undo logs (rows appended by app-side importers).
pub const UNDO_NS: &str = "app.import-undo";
/// Serialised bytes per stored chunk (below the 1 MiB kv value cap).
pub const CHUNK_BYTES: usize = 768 * 1024;
/// Maximum local calendars.
pub const MAX_CALENDARS: usize = 64;
/// Maximum events exported or imported in one call.
pub const MAX_EVENTS: usize = 50_000;

// ───────────────────────────────────────────────────────────────────────────── stored forms

/// A serialisable [`IcsDateTime`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredDt {
    /// `d` date, `u` UTC, `z` zoned, `f` floating.
    pub k: char,
    /// `YYYY-MM-DD`, RFC 3339 (UTC) or `YYYY-MM-DDTHH:MM:SS` (zoned / floating wall time).
    pub v: String,
    /// TZID of zoned values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
}

const WALL: &str = "%Y-%m-%dT%H:%M:%S";

impl StoredDt {
    /// From a parsed value.
    #[must_use]
    pub fn from_ics(d: &IcsDateTime) -> Self {
        match d {
            IcsDateTime::Date(x) => Self {
                k: 'd',
                v: x.format("%Y-%m-%d").to_string(),
                tz: None,
            },
            IcsDateTime::Utc(x) => Self {
                k: 'u',
                v: x.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                tz: None,
            },
            IcsDateTime::Zoned { local, tzid, .. } => Self {
                k: 'z',
                v: local.format(WALL).to_string(),
                tz: Some(tzid.clone()),
            },
            IcsDateTime::Floating(x) => Self {
                k: 'f',
                v: x.format(WALL).to_string(),
                tz: None,
            },
        }
    }

    /// Back to an [`IcsDateTime`] (`None` for corrupt values).
    #[must_use]
    pub fn to_ics(&self) -> Option<IcsDateTime> {
        Some(match self.k {
            'd' => IcsDateTime::Date(NaiveDate::parse_from_str(&self.v, "%Y-%m-%d").ok()?),
            'u' => IcsDateTime::Utc(
                DateTime::parse_from_rfc3339(&self.v)
                    .ok()?
                    .with_timezone(&Utc),
            ),
            'z' => {
                let tzid = self.tz.clone()?;
                IcsDateTime::Zoned {
                    local: NaiveDateTime::parse_from_str(&self.v, WALL).ok()?,
                    zone: resolve_tzid(&tzid),
                    tzid,
                }
            }
            'f' => IcsDateTime::Floating(NaiveDateTime::parse_from_str(&self.v, WALL).ok()?),
            _ => return None,
        })
    }
}

/// A normalised stored event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    start: StoredDt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    end: Option<StoredDt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_secs: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rrule: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    rdates: Vec<StoredDt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    exdates: Vec<StoredDt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recurrence_id: Option<StoredDt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

impl StoredEvent {
    /// From a parsed event (`None` without `DTSTART` or when cancelled).
    #[must_use]
    pub fn from_ics(e: &IcsEvent) -> Option<Self> {
        if e.status
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED"))
        {
            return None;
        }
        Some(Self {
            uid: e.uid.clone(),
            title: e.summary.clone(),
            start: StoredDt::from_ics(e.start.as_ref()?),
            end: e.end.as_ref().map(StoredDt::from_ics),
            duration_secs: e.duration.map(|d| d.num_seconds()),
            rrule: e.rrule.clone(),
            rdates: e.rdates.iter().map(StoredDt::from_ics).collect(),
            exdates: e.exdates.iter().map(StoredDt::from_ics).collect(),
            recurrence_id: e.recurrence_id.as_ref().map(StoredDt::from_ics),
            location: e.location.clone(),
            description: e.description.clone(),
        })
    }

    /// Back to an [`IcsEvent`].
    #[must_use]
    pub fn to_ics(&self) -> Option<IcsEvent> {
        Some(IcsEvent {
            uid: self.uid.clone(),
            summary: self.title.clone(),
            description: self.description.clone(),
            location: self.location.clone(),
            start: Some(self.start.to_ics()?),
            end: self.end.as_ref().and_then(StoredDt::to_ics),
            duration: self.duration_secs.map(chrono::Duration::seconds),
            rrule: self.rrule.clone(),
            rdates: self.rdates.iter().filter_map(StoredDt::to_ics).collect(),
            exdates: self.exdates.iter().filter_map(StoredDt::to_ics).collect(),
            recurrence_id: self.recurrence_id.as_ref().and_then(StoredDt::to_ics),
            ..IcsEvent::default()
        })
    }
}

/// One local calendar of the index.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCalendar {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Block colour.
    pub color: String,
    /// Default zone (`X-WR-TIMEZONE`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tz: Option<String>,
    /// Stored chunks.
    pub chunks: usize,
    /// Event count.
    pub events: usize,
    /// Imported at.
    pub imported_at: i64,
}

const COLORS: &[&str] = &[
    "blue", "green", "purple", "orange", "pink", "yellow", "red", "brown", "gray",
];

/// The local calendar index.
pub fn calendars(store: &Store) -> ApiResult<Vec<LocalCalendar>> {
    Ok(store
        .kv_get_any(CAL_NS, INDEX_KEY)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

fn chunk_key(id: &str, n: usize) -> String {
    format!("events:{id}:{n}")
}

/// Splits serialised events into chunks of at most [`CHUNK_BYTES`].
pub fn chunk_events(events: &[StoredEvent]) -> ApiResult<Vec<Value>> {
    let mut chunks = Vec::new();
    let mut cur: Vec<Value> = Vec::new();
    let mut size = 0usize;
    for e in events {
        let v = serde_json::to_value(e).map_err(|_| ApiError::internal("event json"))?;
        let n = v.to_string().len();
        if n > CHUNK_BYTES {
            continue;
        }
        if size + n > CHUNK_BYTES && !cur.is_empty() {
            chunks.push(Value::Array(std::mem::take(&mut cur)));
            size = 0;
        }
        size += n + 1;
        cur.push(v);
    }
    if !cur.is_empty() {
        chunks.push(Value::Array(cur));
    }
    Ok(chunks)
}

/// Stores `cal` as a local calendar named after `file_name`; returns the number of events kept.
pub fn store_local_calendar(store: &Store, file_name: &str, cal: &IcsCalendar) -> ApiResult<usize> {
    let events: Vec<StoredEvent> = cal
        .events
        .iter()
        .filter_map(StoredEvent::from_ics)
        .take(MAX_EVENTS)
        .collect();
    let mut index = calendars(store)?;
    if index.len() >= MAX_CALENDARS {
        return Err(ApiError::invalid(
            "target",
            format!("At most {MAX_CALENDARS} calendar files can be imported"),
        ));
    }
    let id = emp_store::model::ids::new_id();
    let chunks = chunk_events(&events)?;
    for (i, c) in chunks.iter().enumerate() {
        store.kv_set_any(CAL_NS, &chunk_key(&id, i), c.clone(), None)?;
    }
    let stem = file_name
        .rsplit_once('.')
        .map_or(file_name, |(s, _)| s)
        .trim();
    let name = cal
        .name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            if stem.is_empty() {
                "Calendar".into()
            } else {
                stem.to_owned()
            }
        });
    index.push(LocalCalendar {
        id,
        name: name.chars().take(validate::MAX_TITLE).collect(),
        color: COLORS[index.len() % COLORS.len()].into(),
        default_tz: cal.default_tz.clone(),
        chunks: chunks.len(),
        events: events.len(),
        imported_at: store.now(),
    });
    store.kv_set_any(CAL_NS, INDEX_KEY, json!(index), None)?;
    Ok(events.len())
}

/// Removes a local calendar.
pub fn remove_local_calendar(store: &Store, id: &str) -> ApiResult<bool> {
    let mut index = calendars(store)?;
    let Some(pos) = index.iter().position(|c| c.id == id) else {
        return Ok(false);
    };
    let c = index.remove(pos);
    for i in 0..c.chunks {
        store.kv_delete(CAL_NS, &chunk_key(&c.id, i))?;
    }
    store.kv_set_any(CAL_NS, INDEX_KEY, json!(index), None)?;
    Ok(true)
}

fn load_events(store: &Store, c: &LocalCalendar) -> ApiResult<Vec<StoredEvent>> {
    let mut out = Vec::new();
    for i in 0..c.chunks {
        if let Some(Value::Array(items)) = store.kv_get_any(CAL_NS, &chunk_key(&c.id, i))? {
            out.extend(
                items
                    .into_iter()
                    .filter_map(|v| serde_json::from_value::<StoredEvent>(v).ok()),
            );
        }
    }
    Ok(out)
}

/// The IPC `CalendarEvent` (SPEC §11.3).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    /// Id.
    pub id: String,
    /// `google` | `ics` | `db`.
    pub source: String,
    /// Calendar id.
    pub calendar_id: String,
    /// Title.
    pub title: String,
    /// Start (`YYYY-MM-DD` or RFC 3339).
    pub start: String,
    /// End.
    pub end: String,
    /// All-day.
    pub all_day: bool,
    /// Zone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
    /// Location.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Colour.
    pub color: String,
    /// Part of a series.
    pub recurring: bool,
    /// App route (rows).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<Value>,
}

/// Events of every local calendar overlapping `[from, to]`.
pub fn local_events(
    store: &Store,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: usize,
) -> ApiResult<Vec<CalendarEventDto>> {
    let limits = IcsLimits::default();
    let mut out = Vec::new();
    for c in calendars(store)? {
        let zone = c.default_tz.as_deref().and_then(|t| t.parse().ok());
        let stored = load_events(store, &c)?;
        // Overrides (RECURRENCE-ID) replace their instance of the series.
        let overrides: Vec<(String, DateTime<Utc>)> = stored
            .iter()
            .filter_map(|e| {
                Some((
                    e.uid.clone(),
                    e.recurrence_id.as_ref()?.to_ics()?.to_utc(zone),
                ))
            })
            .collect();
        for se in &stored {
            let Some(ev) = se.to_ics() else { continue };
            let exp = expand_event(&ev, from, to, &limits);
            for o in exp.occurrences {
                if ev.recurrence_id.is_none()
                    && ev.is_recurring()
                    && overrides
                        .iter()
                        .any(|(u, t)| u == &ev.uid && *t == o.start.to_utc(zone))
                {
                    continue;
                }
                let d = o.to_dto(&ev, &c.id, &c.color, zone);
                out.push(CalendarEventDto {
                    id: d.id,
                    source: d.source,
                    calendar_id: d.calendar_id,
                    title: d.title,
                    start: d.start,
                    end: d.end,
                    all_day: d.all_day,
                    tz: d.tz,
                    location: d.location,
                    description: d.description,
                    color: d.color,
                    recurring: d.recurring,
                    link: None,
                });
                if out.len() >= limit {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────────────── rows ↔ events

/// The first date property of a schema (or `prefer` when it is a date property).
#[must_use]
pub fn date_prop(schema: &DbSchema, prefer: Option<&str>) -> Option<String> {
    if let Some(p) = prefer.and_then(|id| schema.property(id)) {
        if p.kind == PropType::Date {
            return Some(p.id.clone());
        }
    }
    schema
        .properties
        .iter()
        .find(|p| p.kind == PropType::Date)
        .map(|p| p.id.clone())
}

fn text_prop(schema: &DbSchema, names: &[&str]) -> Option<String> {
    schema
        .properties
        .iter()
        .find(|p| p.kind == PropType::Text && names.iter().any(|n| p.name.eq_ignore_ascii_case(n)))
        .map(|p| p.id.clone())
}

/// `DateValue` of an occurrence of `ev`.
#[must_use]
pub fn date_value(start: &IcsDateTime, end: Option<&IcsDateTime>, cal: &IcsCalendar) -> DateValue {
    let zone = cal.default_zone();
    if let IcsDateTime::Date(s) = start {
        // ICS all-day ends are exclusive; database date ranges are inclusive.
        let end = match end {
            Some(IcsDateTime::Date(e)) if *e > *s + chrono::Duration::days(1) => Some(
                (*e - chrono::Duration::days(1))
                    .format("%Y-%m-%d")
                    .to_string(),
            ),
            _ => None,
        };
        return DateValue {
            start: s.format("%Y-%m-%d").to_string(),
            end,
            time: false,
            tz: None,
        };
    }
    DateValue {
        start: start.to_ipc_string(zone),
        end: end
            .filter(|e| e.to_utc(zone) > start.to_utc(zone))
            .map(|e| e.to_ipc_string(zone)),
        time: true,
        tz: start.tzid().filter(|t| t.contains('/')).map(str::to_owned),
    }
}

/// Appends one row per event of `cal` to `database_id`; returns `(rows, importId)` (app-level undo log).
pub fn import_into_database(
    store: &Store,
    database_id: &str,
    cal: &IcsCalendar,
) -> ApiResult<(usize, String)> {
    let schema = store.db_get_schema(database_id)?;
    let date = date_prop(&schema, None).ok_or_else(|| {
        ApiError::invalid("target.databaseId", "This database has no date property")
    })?;
    let title = schema.database.primary_prop_id.clone();
    let desc = text_prop(&schema, &["description", "notes", "details"]);
    let loc = text_prop(&schema, &["location", "where", "place"]);
    let mut rows = Vec::new();
    for e in cal.events.iter().take(MAX_EVENTS) {
        if e.recurrence_id.is_some()
            || e.status
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED"))
        {
            continue;
        }
        let Some(start) = &e.start else { continue };
        let end = e.effective_end();
        let mut values = BTreeMap::new();
        values.insert(
            title.clone(),
            CellValue::Text {
                v: rich(e.summary.as_deref().unwrap_or("(No title)")),
            },
        );
        values.insert(
            date.clone(),
            CellValue::Date {
                v: Some(date_value(start, end.as_ref(), cal)),
            },
        );
        if let (Some(p), Some(d)) = (&desc, &e.description) {
            values.insert(p.clone(), CellValue::Text { v: rich(d) });
        }
        if let (Some(p), Some(l)) = (&loc, &e.location) {
            values.insert(p.clone(), CellValue::Text { v: rich(l) });
        }
        rows.push(values);
    }
    let mut ids = Vec::new();
    for chunk in rows.chunks(1_000) {
        ids.extend(store.db_rows_insert_bulk(database_id, chunk.to_vec(), None)?);
    }
    let import_id = emp_store::model::ids::new_id();
    save_row_undo(store, &import_id, &ids)?;
    Ok((ids.len(), import_id))
}

/// Records rows appended by an app-side importer for `import_undo`.
pub fn save_row_undo(store: &Store, import_id: &str, row_ids: &[String]) -> ApiResult<()> {
    // Chunk large logs: each value stays below the kv cap (36-byte ids).
    for (i, c) in row_ids.chunks(20_000).enumerate() {
        store.kv_set_any(UNDO_NS, &format!("{import_id}:{i}"), json!(c), None)?;
    }
    store.kv_set_any(
        UNDO_NS,
        import_id,
        json!({ "chunks": row_ids.len().div_ceil(20_000) }),
        None,
    )?;
    Ok(())
}

/// Undoes an app-side import; `None` when `import_id` has no app-level log.
pub fn undo_rows(store: &Store, import_id: &str) -> ApiResult<Option<usize>> {
    let Some(head) = store.kv_get_any(UNDO_NS, import_id)? else {
        return Ok(None);
    };
    let chunks = head.get("chunks").and_then(Value::as_u64).unwrap_or(0) as usize;
    let mut n = 0;
    for i in 0..chunks {
        let key = format!("{import_id}:{i}");
        if let Some(v) = store.kv_get_any(UNDO_NS, &key)? {
            let ids: Vec<String> = serde_json::from_value(v).unwrap_or_default();
            for c in ids.chunks(1_000) {
                match store.db_rows_purge(c) {
                    Ok(()) => n += c.len(),
                    Err(emp_store::StoreError::NotFound(_)) => {}
                    Err(e) => return Err(e.into()),
                }
            }
        }
        store.kv_delete(UNDO_NS, &key)?;
    }
    store.kv_delete(UNDO_NS, import_id)?;
    Ok(Some(n))
}

fn parse_ipc_dt(s: &str) -> Option<IcsDateTime> {
    if s.len() == 10 {
        return NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .ok()
            .map(IcsDateTime::Date);
    }
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| IcsDateTime::Utc(d.with_timezone(&Utc)))
}

/// An [`IcsEvent`] for a row with a date value (`None` without a date).
#[must_use]
pub fn row_event(row: &RowDto, title_prop: &str, date: &str, vault: &str) -> Option<IcsEvent> {
    let CellValue::Date { v: Some(d) } = row.values.get(date)? else {
        return None;
    };
    let start = parse_ipc_dt(&d.start)?;
    let end = match (&start, d.end.as_deref().and_then(parse_ipc_dt)) {
        (IcsDateTime::Date(_), Some(IcsDateTime::Date(e))) => {
            Some(IcsDateTime::Date(e + chrono::Duration::days(1)))
        }
        (IcsDateTime::Date(s), _) => Some(IcsDateTime::Date(*s + chrono::Duration::days(1))),
        (_, Some(e)) => Some(e),
        (s, None) => Some(s.add(chrono::Duration::hours(1))),
    };
    let title = match row.values.get(title_prop) {
        Some(CellValue::Text { v }) => rich_plain(v),
        _ => String::new(),
    };
    Some(IcsEvent {
        uid: format!("{}@{vault}.emp", row.id),
        summary: Some(if title.trim().is_empty() {
            "Untitled".into()
        } else {
            title
        }),
        start: Some(start),
        end,
        last_modified: DateTime::from_timestamp_millis(row.updated_at),
        ..IcsEvent::default()
    })
}

/// `ics_export.source`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum IcsSource {
    /// Every dated row of a database.
    #[serde(rename_all = "camelCase")]
    Database {
        /// Database.
        database_id: String,
        /// Date property.
        date_prop: String,
    },
    /// Individual rows (row pages).
    #[serde(rename_all = "camelCase")]
    Pages {
        /// Row ids.
        page_ids: Vec<String>,
    },
}

/// `ics_export` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IcsExportReq {
    source: IcsSource,
    grant_id: String,
}

/// `ics_export` result.
#[derive(Debug, Serialize)]
pub struct IcsExportDto {
    events: usize,
}

fn export_calendar(store: &Store, source: &IcsSource) -> ApiResult<ExportCalendar> {
    let vault = store.vault_id().to_string();
    let vault: String = vault
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(16)
        .collect();
    let mut cal = ExportCalendar {
        dtstamp: Utc::now(),
        ..ExportCalendar::default()
    };
    match source {
        IcsSource::Database {
            database_id,
            date_prop: dp,
        } => {
            let schema = store.db_get_schema(database_id)?;
            let date = date_prop(&schema, Some(dp))
                .filter(|d| d == dp)
                .ok_or_else(|| ApiError::invalid("source.dateProp", "not a date property"))?;
            cal.name = Some(schema.database.title.clone());
            for row in super::db::all_rows(store, database_id, None)? {
                if let Some(e) = row_event(&row, &schema.database.primary_prop_id, &date, &vault) {
                    cal.events.push(e);
                }
                if cal.events.len() >= MAX_EVENTS {
                    break;
                }
            }
        }
        IcsSource::Pages { page_ids } => {
            let mut schemas: BTreeMap<String, DbSchema> = BTreeMap::new();
            for id in page_ids {
                let got = store.db_row_get(id)?;
                if !schemas.contains_key(&got.database_id) {
                    schemas.insert(
                        got.database_id.clone(),
                        store.db_get_schema(&got.database_id)?,
                    );
                }
                let Some(schema) = schemas.get(&got.database_id) else {
                    continue;
                };
                if let Some(date) = date_prop(schema, None) {
                    if let Some(e) =
                        row_event(&got.row, &schema.database.primary_prop_id, &date, &vault)
                    {
                        cal.events.push(e);
                    }
                }
            }
        }
    }
    Ok(cal)
}

/// `ics_export({ source: { databaseId, dateProp } | { pageIds }, grantId }) → { events }`: writes an `.ics` file to
/// an export grant. Rows without a date are skipped.
#[tauri::command]
pub async fn ics_export(app: AppHandle, req: IcsExportReq) -> ApiResult<IcsExportDto> {
    validate::grant_id("grantId", &req.grant_id)?;
    match &req.source {
        IcsSource::Database {
            database_id,
            date_prop,
        } => {
            validate::id("source.databaseId", database_id)?;
            validate::id("source.dateProp", date_prop)?;
        }
        IcsSource::Pages { page_ids } => validate::ids("source.pageIds", page_ids, false)?,
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let cal = export_calendar(&store, &req.source)?;
        let text = generate_ics(&cal)?;
        let target = super::import::take_export_target(&state, &req.grant_id)?;
        super::import::write_atomic(&target, text.as_bytes())?;
        Ok(IcsExportDto {
            events: cal.events.len(),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use emp_integrations::ics::parse_ics;

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nX-WR-CALNAME:Team\r\n\
BEGIN:VEVENT\r\nUID:a@x\r\nSUMMARY:Standup\r\nDTSTART:20260105T090000Z\r\nDTEND:20260105T091500Z\r\n\
RRULE:FREQ=DAILY;COUNT=5\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:b@x\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260110\r\nDTEND;VALUE=DATE:20260112\r\nEND:VEVENT\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn stored_events_round_trip() {
        let cal = parse_ics(SAMPLE.as_bytes(), &IcsLimits::default()).unwrap();
        for e in &cal.events {
            let s = StoredEvent::from_ics(e).unwrap();
            let v = serde_json::to_value(&s).unwrap();
            let back: StoredEvent = serde_json::from_value(v).unwrap();
            let ev = back.to_ics().unwrap();
            assert_eq!(ev.uid, e.uid);
            assert_eq!(ev.start, e.start);
            assert_eq!(ev.end, e.end);
            assert_eq!(ev.rrule, e.rrule);
        }
    }

    #[test]
    fn zoned_values_round_trip() {
        let d = IcsDateTime::Zoned {
            local: NaiveDateTime::parse_from_str("2026-03-01T10:00:00", WALL).unwrap(),
            tzid: "Europe/Berlin".into(),
            zone: resolve_tzid("Europe/Berlin"),
        };
        assert_eq!(StoredDt::from_ics(&d).to_ics(), Some(d));
        assert!(
            StoredDt {
                k: 'x',
                v: String::new(),
                tz: None
            }
            .to_ics()
            .is_none()
        );
    }

    #[test]
    fn chunks_stay_below_the_cap() {
        let e = StoredEvent {
            uid: "u".into(),
            title: Some("x".repeat(10_000)),
            start: StoredDt {
                k: 'd',
                v: "2026-01-01".into(),
                tz: None,
            },
            end: None,
            duration_secs: None,
            rrule: None,
            rdates: vec![],
            exdates: vec![],
            recurrence_id: None,
            location: None,
            description: None,
        };
        let events = vec![e; 200];
        let chunks = chunk_events(&events).unwrap();
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(c.to_string().len() <= CHUNK_BYTES + 16);
        }
        let total: usize = chunks.iter().map(|c| c.as_array().unwrap().len()).sum();
        assert_eq!(total, 200);
    }

    #[test]
    fn all_day_ranges_become_inclusive() {
        let s = IcsDateTime::Date(NaiveDate::from_ymd_opt(2026, 1, 10).unwrap());
        let e = IcsDateTime::Date(NaiveDate::from_ymd_opt(2026, 1, 12).unwrap());
        let cal = IcsCalendar::default();
        let v = date_value(&s, Some(&e), &cal);
        assert_eq!(v.start, "2026-01-10");
        assert_eq!(v.end.as_deref(), Some("2026-01-11"));
        assert!(!v.time);
        let one = IcsDateTime::Date(NaiveDate::from_ymd_opt(2026, 1, 11).unwrap());
        assert_eq!(date_value(&s, Some(&one), &cal).end, None);
    }

    #[test]
    fn rows_become_events() {
        let mut values = BTreeMap::new();
        values.insert("t".to_owned(), CellValue::Text { v: rich("Dentist") });
        values.insert(
            "d".to_owned(),
            CellValue::Date {
                v: Some(DateValue {
                    start: "2026-02-03".into(),
                    end: None,
                    time: false,
                    tz: None,
                }),
            },
        );
        let row = RowDto {
            id: "r1".into(),
            rev: 1,
            sort_key: "a".into(),
            created_at: 0,
            updated_at: 0,
            values,
            has_body: false,
            icon: None,
            sample: None,
        };
        let e = row_event(&row, "t", "d", "v").unwrap();
        assert_eq!(e.summary.as_deref(), Some("Dentist"));
        assert_eq!(e.uid, "r1@v.emp");
        assert_eq!(
            e.end,
            Some(IcsDateTime::Date(
                NaiveDate::from_ymd_opt(2026, 2, 4).unwrap()
            ))
        );
        let ics = generate_ics(&ExportCalendar {
            events: vec![e],
            dtstamp: Utc::now(),
            ..ExportCalendar::default()
        })
        .unwrap();
        assert!(ics.contains("SUMMARY:Dentist"));
        assert!(row_event(&row, "t", "missing", "v").is_none());
    }

    #[test]
    fn local_calendars_expand_and_database_imports_undo() {
        let (_dir, store) = super::super::finance::test_support::temp_store();
        let cal = parse_ics(SAMPLE.as_bytes(), &IcsLimits::default()).unwrap();
        assert_eq!(store_local_calendar(&store, "team.ics", &cal).unwrap(), 2);
        let from = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let to = DateTime::parse_from_rfc3339("2026-01-31T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let ev = local_events(&store, from, to, 100).unwrap();
        assert_eq!(ev.iter().filter(|e| e.title == "Standup").count(), 5);
        assert_eq!(calendars(&store).unwrap()[0].name, "Team");

        let ws = store.workspace_list().unwrap().remove(0).id;
        let db = store
            .db_create(
                emp_store::dbmodel::DbCreate::new(&ws, None, "Events").with_properties(vec![
                    emp_store::dbmodel::PropertySpec::new("When", PropType::Date),
                ]),
            )
            .unwrap();
        let (n, import_id) = import_into_database(&store, &db.page.id, &cal).unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            super::super::db::all_rows(&store, &db.page.id, None)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(undo_rows(&store, &import_id).unwrap(), Some(2));
        assert!(
            super::super::db::all_rows(&store, &db.page.id, None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(undo_rows(&store, "nope").unwrap(), None);
        assert!(remove_local_calendar(&store, &calendars(&store).unwrap()[0].id).unwrap());
    }
}
