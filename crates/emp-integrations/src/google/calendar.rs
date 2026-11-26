//! Google Calendar read with incremental sync (SPEC §17.1).
//!
//! - `calendarList.list` returns calendars with their Google colour mapped to a block colour.
//! - The first sync calls `events.list` with `singleEvents=true` over −90…+365 days; later
//!   syncs pass the stored `syncToken`. On `410 Gone` the token is dropped and a full resync
//!   runs silently ([`EventSync::full_resync`] tells the caller to replace its cache).
//! - All-day events keep `date` semantics (no timezone shift).

use chrono::{DateTime, Duration, FixedOffset, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use url::Url;

use super::convert::{BlockColor, event_color_hex, nearest_block_color};
use super::{GoogleSession, path_segment};
use crate::error::{IntegrationError, Result};
use crate::netguard::{BodyCap, ConnectorId, Credential, NetRequest, NetResponse};
use crate::secret::SecretString;

/// Days before today included in a full sync.
pub const WINDOW_PAST_DAYS: i64 = 90;
/// Days after today included in a full sync.
pub const WINDOW_FUTURE_DAYS: i64 = 365;
/// Safety cap on pages per sync.
pub const MAX_PAGES: usize = 200;

/// A calendar from `calendarList.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcalCalendar {
    /// Calendar id.
    pub id: String,
    /// Display name (the user's override if set).
    pub summary: String,
    /// Google hex colour.
    pub background_color: String,
    /// Nearest block colour (what the UI shows).
    pub color: BlockColor,
    /// Whether this is the account's primary calendar.
    pub primary: bool,
    /// Whether the user shows it in Google Calendar.
    pub selected: bool,
    /// `owner`, `writer`, `reader` or `freeBusyReader`.
    pub access_role: String,
    /// Calendar time zone.
    pub time_zone: Option<String>,
}

/// Start or end of an event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum EventTime {
    /// All-day date.
    Date(NaiveDate),
    /// A timed instant with its original offset.
    DateTime(DateTime<FixedOffset>),
}

impl EventTime {
    /// `YYYY-MM-DD` for dates, RFC 3339 for times (the IPC `CalendarEvent` format).
    pub fn to_ipc_string(&self) -> String {
        match self {
            EventTime::Date(d) => d.format("%Y-%m-%d").to_string(),
            EventTime::DateTime(dt) => dt.to_rfc3339(),
        }
    }
}

/// Event status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventStatus {
    /// Confirmed.
    Confirmed,
    /// Tentative.
    Tentative,
    /// Deleted / cancelled.
    Cancelled,
}

/// A normalised event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcalEvent {
    /// Event (instance) id.
    pub id: String,
    /// Owning calendar.
    pub calendar_id: String,
    /// Status.
    pub status: EventStatus,
    /// Title (`summary`), "(No title)" when absent.
    pub title: String,
    /// Description (may contain HTML from Google; sanitise before rendering).
    pub description: Option<String>,
    /// Location.
    pub location: Option<String>,
    /// Start.
    pub start: EventTime,
    /// End (exclusive).
    pub end: EventTime,
    /// All-day event.
    pub all_day: bool,
    /// IANA time zone of the start, if Google gave one.
    pub tz: Option<String>,
    /// Instance of a recurring series.
    pub recurring: bool,
    /// Series id for recurring instances.
    pub recurring_event_id: Option<String>,
    /// Event colour (hex) when overridden via `colorId`.
    pub color_hex: Option<String>,
    /// Google Calendar link.
    pub html_link: Option<String>,
    /// Last modification (RFC 3339).
    pub updated: Option<String>,
}

/// IPC `CalendarEvent` (SPEC §11.3) for `source: 'google'`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    /// Event id.
    pub id: String,
    /// Always `"google"` here.
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
    /// Time zone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
    /// Location.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Block colour name.
    pub color: String,
    /// Part of a recurring series.
    pub recurring: bool,
}

impl GcalEvent {
    /// Convert to the IPC shape, using the event colour or else the calendar colour.
    pub fn to_dto(&self, calendar_color: BlockColor) -> CalendarEventDto {
        let color = self
            .color_hex
            .as_deref()
            .map(nearest_block_color)
            .unwrap_or(calendar_color);
        CalendarEventDto {
            id: self.id.clone(),
            source: "google".into(),
            calendar_id: self.calendar_id.clone(),
            title: self.title.clone(),
            start: self.start.to_ipc_string(),
            end: self.end.to_ipc_string(),
            all_day: self.all_day,
            tz: self.tz.clone(),
            location: self.location.clone(),
            description: self.description.clone(),
            color: color.as_str().to_string(),
            recurring: self.recurring,
        }
    }
}

/// Result of one sync of one calendar.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EventSync {
    /// New or changed events.
    pub upserts: Vec<GcalEvent>,
    /// Ids of deleted events.
    pub deleted: Vec<String>,
    /// Token to store for the next incremental sync.
    pub next_sync_token: Option<String>,
    /// `true` when this was a full sync (first sync, or after `410 Gone`): the caller should
    /// replace its cached events for the calendar.
    pub full_resync: bool,
}

/// How to fetch events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncMode {
    /// Full window fetch.
    Full {
        /// Window start.
        time_min: DateTime<Utc>,
        /// Window end.
        time_max: DateTime<Utc>,
    },
    /// Incremental with a stored token.
    Incremental(String),
}

impl SyncMode {
    /// The default full-sync window around `now` (−90…+365 days).
    pub fn full_window(now: DateTime<Utc>) -> Self {
        SyncMode::Full {
            time_min: now - Duration::days(WINDOW_PAST_DAYS),
            time_max: now + Duration::days(WINDOW_FUTURE_DAYS),
        }
    }
}

fn api_url(path: &str) -> Result<Url> {
    Url::parse(&format!("https://www.googleapis.com{path}"))
        .map_err(|e| IntegrationError::Internal(e.to_string()))
}

/// `GET /calendar/v3/users/me/calendarList`.
pub fn calendar_list_request(token: &SecretString, page_token: Option<&str>) -> Result<NetRequest> {
    let mut url = api_url("/calendar/v3/users/me/calendarList")?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("maxResults", "250");
        if let Some(p) = page_token {
            q.append_pair("pageToken", p);
        }
    }
    Ok(NetRequest::get(
        ConnectorId::Google,
        url,
        "/calendar/v3/users/me/calendarList",
    )
    .credential(Credential::bearer(token)))
}

/// `GET /calendar/v3/calendars/{id}/events` for the given mode and page.
pub fn events_request(
    token: &SecretString,
    calendar_id: &str,
    mode: &SyncMode,
    page_token: Option<&str>,
) -> Result<NetRequest> {
    let mut url = api_url(&format!(
        "/calendar/v3/calendars/{}/events",
        path_segment(calendar_id)
    ))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("singleEvents", "true")
            .append_pair("maxResults", "2500");
        match mode {
            SyncMode::Full { time_min, time_max } => {
                q.append_pair(
                    "timeMin",
                    &time_min.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                )
                .append_pair(
                    "timeMax",
                    &time_max.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                );
            }
            SyncMode::Incremental(token) => {
                q.append_pair("syncToken", token);
            }
        }
        if let Some(p) = page_token {
            q.append_pair("pageToken", p);
        }
    }
    Ok(NetRequest::get(
        ConnectorId::Google,
        url,
        "/calendar/v3/calendars/{id}/events",
    )
    .credential(Credential::bearer(token))
    .cap(BodyCap::MarketHistory))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCalendarList {
    #[serde(default)]
    items: Vec<RawCalendar>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCalendar {
    id: String,
    summary: Option<String>,
    summary_override: Option<String>,
    background_color: Option<String>,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    selected: bool,
    access_role: Option<String>,
    time_zone: Option<String>,
}

/// One page of `calendarList.list`.
pub fn parse_calendar_list(body: &[u8]) -> Result<(Vec<GcalCalendar>, Option<String>)> {
    let raw: RawCalendarList = crate::netguard::decode_json(body)?;
    let items = raw
        .items
        .into_iter()
        .map(|c| {
            let bg = c.background_color.unwrap_or_else(|| "#039be5".into());
            GcalCalendar {
                color: nearest_block_color(&bg),
                background_color: bg,
                summary: c
                    .summary_override
                    .or(c.summary)
                    .unwrap_or_else(|| c.id.clone()),
                id: c.id,
                primary: c.primary,
                selected: c.selected,
                access_role: c.access_role.unwrap_or_else(|| "reader".into()),
                time_zone: c.time_zone,
            }
        })
        .collect();
    Ok((items, raw.next_page_token))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEvents {
    #[serde(default)]
    items: Vec<RawEvent>,
    next_page_token: Option<String>,
    next_sync_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEvent {
    id: String,
    status: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    start: Option<RawTime>,
    end: Option<RawTime>,
    recurring_event_id: Option<String>,
    recurrence: Option<Vec<String>>,
    color_id: Option<String>,
    html_link: Option<String>,
    updated: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTime {
    date: Option<String>,
    date_time: Option<String>,
    time_zone: Option<String>,
}

fn parse_time(t: &RawTime) -> Option<EventTime> {
    if let Some(d) = &t.date {
        return NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .ok()
            .map(EventTime::Date);
    }
    let dt = t.date_time.as_deref()?;
    DateTime::parse_from_rfc3339(dt)
        .ok()
        .map(EventTime::DateTime)
}

/// A parsed page of `events.list`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EventsPage {
    /// Live events.
    pub events: Vec<GcalEvent>,
    /// Cancelled (deleted) event ids.
    pub cancelled: Vec<String>,
    /// Next page.
    pub next_page_token: Option<String>,
    /// Sync token (last page only).
    pub next_sync_token: Option<String>,
    /// Events skipped because their times were unparseable.
    pub skipped: usize,
}

/// Parse one page of `events.list`.
pub fn parse_events_page(body: &[u8], calendar_id: &str) -> Result<EventsPage> {
    let raw: RawEvents = crate::netguard::decode_json(body)?;
    let mut page = EventsPage {
        next_page_token: raw.next_page_token,
        next_sync_token: raw.next_sync_token,
        ..Default::default()
    };
    for e in raw.items {
        let status = match e.status.as_deref() {
            Some("cancelled") => EventStatus::Cancelled,
            Some("tentative") => EventStatus::Tentative,
            _ => EventStatus::Confirmed,
        };
        if status == EventStatus::Cancelled {
            page.cancelled.push(e.id);
            continue;
        }
        let (Some(start), Some(end)) = (
            e.start.as_ref().and_then(parse_time),
            e.end.as_ref().and_then(parse_time),
        ) else {
            page.skipped += 1;
            continue;
        };
        let all_day = matches!(start, EventTime::Date(_));
        page.events.push(GcalEvent {
            calendar_id: calendar_id.to_string(),
            status,
            title: e
                .summary
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "(No title)".into()),
            description: e.description,
            location: e.location,
            tz: e.start.as_ref().and_then(|s| s.time_zone.clone()),
            start,
            end,
            all_day,
            recurring: e.recurring_event_id.is_some()
                || e.recurrence.is_some_and(|r| !r.is_empty()),
            recurring_event_id: e.recurring_event_id,
            color_hex: e
                .color_id
                .as_deref()
                .and_then(event_color_hex)
                .map(str::to_string),
            html_link: e.html_link,
            updated: e.updated,
            id: e.id,
        });
    }
    Ok(page)
}

/// List all calendars of the account.
pub async fn list_calendars(session: &GoogleSession) -> Result<Vec<GcalCalendar>> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let resp = session
            .send(|tok| calendar_list_request(tok, page.as_deref()))
            .await?
            .error_for_status()?;
        let (items, next) = parse_calendar_list(&resp.body)?;
        out.extend(items);
        match next {
            Some(n) => page = Some(n),
            None => return Ok(out),
        }
    }
    Err(IntegrationError::Provider(
        "too many calendar list pages".into(),
    ))
}

fn check_events_status(resp: NetResponse, incremental: bool) -> Result<NetResponse> {
    if resp.status == 410 && incremental {
        return Err(IntegrationError::SyncTokenExpired);
    }
    resp.error_for_status()
}

async fn run_sync(
    session: &GoogleSession,
    calendar_id: &str,
    mode: &SyncMode,
) -> Result<EventSync> {
    let incremental = matches!(mode, SyncMode::Incremental(_));
    let mut out = EventSync {
        full_resync: !incremental,
        ..Default::default()
    };
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let resp = session
            .send(|tok| events_request(tok, calendar_id, mode, page.as_deref()))
            .await?;
        let resp = check_events_status(resp, incremental)?;
        let parsed = parse_events_page(&resp.body, calendar_id)?;
        out.upserts.extend(parsed.events);
        out.deleted.extend(parsed.cancelled);
        if parsed.next_sync_token.is_some() {
            out.next_sync_token = parsed.next_sync_token;
        }
        match parsed.next_page_token {
            Some(n) => page = Some(n),
            None => return Ok(out),
        }
    }
    Err(IntegrationError::Provider("too many event pages".into()))
}

/// Sync one calendar: incremental with `sync_token` if given, else a full window sync around
/// `now`. An expired token (`410 Gone`) triggers a silent full resync.
pub async fn sync_events(
    session: &GoogleSession,
    calendar_id: &str,
    sync_token: Option<&str>,
    now: DateTime<Utc>,
) -> Result<EventSync> {
    if let Some(token) = sync_token {
        match run_sync(
            session,
            calendar_id,
            &SyncMode::Incremental(token.to_string()),
        )
        .await
        {
            Err(IntegrationError::SyncTokenExpired) => {}
            other => return other,
        }
    }
    run_sync(session, calendar_id, &SyncMode::full_window(now)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netguard::testing::guard_for;
    use crate::oauth::{ClientCredentials, GoogleOAuth, TokenSet};
    use crate::testutil::{Reply, TestServer};
    use chrono::TimeZone;

    const LIST: &str = r##"{
      "kind": "calendar#calendarList",
      "items": [
        {"id": "me@example.com", "summary": "me@example.com", "summaryOverride": "Personal", "backgroundColor": "#9fe1e7", "primary": true, "selected": true, "accessRole": "owner", "timeZone": "Europe/Berlin"},
        {"id": "en.usa#holiday@group.v.calendar.google.com", "summary": "Holidays", "backgroundColor": "#16a765", "accessRole": "reader"}
      ],
      "nextPageToken": "p2"
    }"##;

    const EVENTS: &str = r##"{
      "items": [
        {"id": "a1", "status": "confirmed", "summary": "Dentist", "location": "Main St",
         "start": {"dateTime": "2026-12-01T09:00:00-05:00", "timeZone": "America/New_York"},
         "end": {"dateTime": "2026-12-01T10:00:00-05:00", "timeZone": "America/New_York"},
         "colorId": "11", "htmlLink": "https://www.google.com/calendar/event?eid=x", "updated": "2026-11-20T10:00:00.000Z"},
        {"id": "b2", "summary": "Holiday", "start": {"date": "2026-12-25"}, "end": {"date": "2026-12-26"}},
        {"id": "c3_20261202", "summary": "Standup", "recurringEventId": "c3",
         "start": {"dateTime": "2026-12-02T15:00:00Z"}, "end": {"dateTime": "2026-12-02T15:15:00Z"}},
        {"id": "d4", "status": "cancelled"},
        {"id": "e5", "summary": "", "start": {"dateTime": "bad"}, "end": {"dateTime": "bad"}}
      ],
      "nextSyncToken": "SYNC-1"
    }"##;

    #[test]
    fn parses_calendar_list() {
        let (items, next) = parse_calendar_list(LIST.as_bytes()).unwrap();
        assert_eq!(next.as_deref(), Some("p2"));
        assert_eq!(items[0].summary, "Personal");
        assert_eq!(items[0].color, BlockColor::Blue);
        assert!(items[0].primary && items[0].selected);
        assert_eq!(items[1].color, BlockColor::Green);
        assert!(!items[1].selected);
    }

    #[test]
    fn parses_events_page() {
        let p = parse_events_page(EVENTS.as_bytes(), "cal").unwrap();
        assert_eq!(p.events.len(), 3);
        assert_eq!(p.cancelled, vec!["d4"]);
        assert_eq!(p.skipped, 1);
        assert_eq!(p.next_sync_token.as_deref(), Some("SYNC-1"));
        let a = &p.events[0];
        assert!(!a.all_day);
        assert_eq!(a.tz.as_deref(), Some("America/New_York"));
        let dto = a.to_dto(BlockColor::Blue);
        assert_eq!(dto.color, "red");
        assert_eq!(dto.start, "2026-12-01T09:00:00-05:00");
        let b = &p.events[1];
        assert!(b.all_day);
        let dto = b.to_dto(BlockColor::Green);
        assert_eq!(
            (dto.start.as_str(), dto.end.as_str()),
            ("2026-12-25", "2026-12-26")
        );
        assert_eq!(dto.color, "green");
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["allDay"], true);
        assert!(json.get("tz").is_none());
        assert!(p.events[2].recurring);
    }

    #[test]
    fn events_request_modes() {
        let tok = SecretString::new("t");
        let now = Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0).unwrap();
        let r = events_request(&tok, "me@example.com", &SyncMode::full_window(now), None).unwrap();
        assert_eq!(
            r.url.path(),
            "/calendar/v3/calendars/me%40example.com/events"
        );
        let q: std::collections::HashMap<_, _> = r.url.query_pairs().into_owned().collect();
        assert_eq!(q["singleEvents"], "true");
        assert_eq!(q["timeMin"], "2026-08-28T12:00:00Z");
        assert_eq!(q["timeMax"], "2027-11-26T12:00:00Z");
        assert!(!q.contains_key("syncToken"));
        let r =
            events_request(&tok, "c", &SyncMode::Incremental("TOK".into()), Some("pg")).unwrap();
        let q: std::collections::HashMap<_, _> = r.url.query_pairs().into_owned().collect();
        assert_eq!(q["syncToken"], "TOK");
        assert_eq!(q["pageToken"], "pg");
        assert!(!q.contains_key("timeMin"));
        assert_eq!(r.path_template, "/calendar/v3/calendars/{id}/events");
    }

    fn session(guard: crate::NetGuard) -> GoogleSession {
        let oauth = GoogleOAuth::new(
            guard.clone(),
            ClientCredentials {
                client_id: "c".into(),
                client_secret: None,
            },
        );
        let tokens = TokenSet {
            access_token: SecretString::new("at"),
            expires_at: Utc::now() + Duration::hours(1),
            refresh_token: Some(SecretString::new("rt")),
            scopes: vec![],
            identity: None,
        };
        GoogleSession::from_tokens(guard, oauth, &tokens).unwrap()
    }

    #[tokio::test]
    async fn gone_sync_token_triggers_silent_full_resync() {
        let server = TestServer::start(vec![
            Reply::json(410, r#"{"error":{"code":410,"message":"Sync token is no longer valid, a full sync is required."}}"#),
            Reply::json(200, r#"{"items":[{"id":"x","summary":"A","start":{"date":"2026-12-01"},"end":{"date":"2026-12-02"}}],"nextPageToken":"p2"}"#),
            Reply::json(200, r#"{"items":[{"id":"y","status":"cancelled"}],"nextSyncToken":"NEW"}"#),
        ])
        .await;
        let s = session(guard_for(&["www.googleapis.com"], server.addr()));
        let out = sync_events(&s, "primary", Some("OLD"), Utc::now())
            .await
            .unwrap();
        assert!(out.full_resync);
        assert_eq!(out.next_sync_token.as_deref(), Some("NEW"));
        assert_eq!(out.upserts.len(), 1);
        assert_eq!(out.deleted, vec!["y"]);
        let reqs = server.requests();
        assert!(reqs[0].path.contains("syncToken=OLD"));
        assert!(reqs[1].path.contains("timeMin="));
        assert!(reqs[2].path.contains("pageToken=p2"));
    }

    #[tokio::test]
    async fn incremental_sync_and_calendar_pagination() {
        let server = TestServer::start(vec![
            Reply::json(200, r#"{"items":[],"nextSyncToken":"S2"}"#),
            Reply::json(200, LIST),
            Reply::json(200, r#"{"items":[{"id":"third","summary":"T"}]}"#),
        ])
        .await;
        let s = session(guard_for(&["www.googleapis.com"], server.addr()));
        let out = sync_events(&s, "primary", Some("S1"), Utc::now())
            .await
            .unwrap();
        assert!(!out.full_resync);
        assert_eq!(out.next_sync_token.as_deref(), Some("S2"));
        let cals = list_calendars(&s).await.unwrap();
        assert_eq!(cals.len(), 3);
        assert!(server.requests()[2].path.contains("pageToken=p2"));
    }
}
