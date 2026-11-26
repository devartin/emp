//! iCalendar (RFC 5545) import and export (SPEC §17.3, hardening per §9.16).
//!
//! - [`parse_ics`] reads `VCALENDAR` → `VEVENT`/`VTODO` with line unfolding, parameter
//!   quoting, text unescaping, `DATE`/`DATE-TIME` (UTC, floating, `TZID`) values, `DURATION`,
//!   and passes `RRULE`/`RDATE`/`EXDATE`/`RECURRENCE-ID` through. `TZID`s resolve to IANA zones
//!   (directly, via Windows names, vendor prefixes such as `/mozilla.org/…`, `X-LIC-LOCATION`,
//!   or a fixed offset from the `VTIMEZONE` as a last resort). Input size, line length,
//!   component count and nesting depth are capped.
//! - [`expand_event`] expands recurrences with the `rrule` crate, capped at 5,000 instances
//!   and a 10-year horizon.
//! - [`generate_ics`] writes RFC 5545 text (CRLF, 75-octet folding, escaping) with generated
//!   `VTIMEZONE`s for IANA zones.
//!
//! The parser is pure and panic-free on arbitrary input; run it on a blocking thread inside
//! the app's import wrapper (`catch_unwind`, cancellation, time budget).

mod expand;
mod generate;
mod parse;
mod tz;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::Serialize;

pub use expand::{Expansion, Occurrence, expand_event};
pub use generate::{ExportCalendar, generate_ics};
pub use parse::parse_ics;
pub use tz::{ZoneRef, resolve_tzid};

/// Import limits (SPEC §9.16 plus parser caps).
#[derive(Debug, Clone)]
pub struct IcsLimits {
    /// Maximum input size in bytes.
    pub max_bytes: usize,
    /// Maximum unfolded line length in bytes.
    pub max_line: usize,
    /// Maximum number of components.
    pub max_components: usize,
    /// Maximum component nesting depth.
    pub max_depth: usize,
    /// Maximum properties per component.
    pub max_properties: usize,
    /// Maximum recurrence instances per event (SPEC: 5,000).
    pub max_instances: u16,
    /// Recurrence horizon in years from DTSTART (SPEC: 10).
    pub horizon_years: i32,
}

impl Default for IcsLimits {
    fn default() -> Self {
        IcsLimits {
            max_bytes: 64 * 1024 * 1024,
            max_line: 1024 * 1024,
            max_components: 200_000,
            max_depth: 12,
            max_properties: 4_000,
            max_instances: 5_000,
            horizon_years: 10,
        }
    }
}

/// A `DATE` or `DATE-TIME` value.
#[derive(Debug, Clone, PartialEq)]
pub enum IcsDateTime {
    /// All-day date.
    Date(NaiveDate),
    /// UTC instant (`…Z`).
    Utc(DateTime<Utc>),
    /// Local time in a named zone (`TZID=`).
    Zoned {
        /// Wall-clock time.
        local: NaiveDateTime,
        /// The `TZID` as written.
        tzid: String,
        /// The resolved zone.
        zone: ZoneRef,
    },
    /// Floating local time (no zone).
    Floating(NaiveDateTime),
}

impl IcsDateTime {
    /// Whether this is an all-day date.
    pub fn is_date(&self) -> bool {
        matches!(self, IcsDateTime::Date(_))
    }

    /// The `TZID`, if zoned.
    pub fn tzid(&self) -> Option<&str> {
        match self {
            IcsDateTime::Zoned { tzid, .. } => Some(tzid),
            _ => None,
        }
    }

    /// Resolve to an instant. Dates are midnight and floating times are wall-clock times in
    /// `default_zone` (UTC when `None`); unknown zones fall back the same way.
    pub fn to_utc(&self, default_zone: Option<chrono_tz::Tz>) -> DateTime<Utc> {
        let local_in = |naive: &NaiveDateTime| match default_zone {
            Some(tz) => tz::local_to_utc(&tz, naive),
            None => Utc.from_utc_datetime(naive),
        };
        match self {
            IcsDateTime::Date(d) => local_in(&d.and_hms_opt(0, 0, 0).unwrap_or_default()),
            IcsDateTime::Utc(dt) => *dt,
            IcsDateTime::Floating(n) => local_in(n),
            IcsDateTime::Zoned { local, zone, .. } => match zone {
                ZoneRef::Iana(tz) => tz::local_to_utc(tz, local),
                ZoneRef::Fixed(off) => off
                    .from_local_datetime(local)
                    .single()
                    .map(|d| d.with_timezone(&Utc))
                    .unwrap_or_else(|| Utc.from_utc_datetime(local)),
                ZoneRef::Unknown => local_in(local),
            },
        }
    }

    /// IPC string: `YYYY-MM-DD` for dates, otherwise RFC 3339 with the zone's offset (UTC for
    /// UTC/floating/unknown).
    pub fn to_ipc_string(&self, default_zone: Option<chrono_tz::Tz>) -> String {
        match self {
            IcsDateTime::Date(d) => d.format("%Y-%m-%d").to_string(),
            IcsDateTime::Zoned {
                zone: ZoneRef::Iana(tz),
                ..
            } => self
                .to_utc(None)
                .with_timezone(tz)
                .fixed_offset()
                .to_rfc3339(),
            IcsDateTime::Zoned {
                zone: ZoneRef::Fixed(off),
                ..
            } => self.to_utc(None).with_timezone(off).to_rfc3339(),
            other => other
                .to_utc(default_zone)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }
    }

    /// Add a duration, keeping the variant (dates move by whole days).
    pub fn add(&self, d: Duration) -> IcsDateTime {
        match self {
            IcsDateTime::Date(date) => {
                let days = d.num_days();
                IcsDateTime::Date(
                    date.checked_add_signed(Duration::days(days))
                        .unwrap_or(*date),
                )
            }
            IcsDateTime::Utc(dt) => IcsDateTime::Utc(dt.checked_add_signed(d).unwrap_or(*dt)),
            IcsDateTime::Floating(n) => {
                IcsDateTime::Floating(n.checked_add_signed(d).unwrap_or(*n))
            }
            IcsDateTime::Zoned { local, tzid, zone } => IcsDateTime::Zoned {
                local: local.checked_add_signed(d).unwrap_or(*local),
                tzid: tzid.clone(),
                zone: zone.clone(),
            },
        }
    }
}

/// A `VEVENT`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IcsEvent {
    /// `UID` (generated when missing, with a warning).
    pub uid: String,
    /// `SUMMARY`.
    pub summary: Option<String>,
    /// `DESCRIPTION`.
    pub description: Option<String>,
    /// `LOCATION`.
    pub location: Option<String>,
    /// `URL`.
    pub url: Option<String>,
    /// `STATUS` (`CONFIRMED`, `TENTATIVE`, `CANCELLED`).
    pub status: Option<String>,
    /// `TRANSP`.
    pub transp: Option<String>,
    /// `CATEGORIES`.
    pub categories: Vec<String>,
    /// `COLOR` (RFC 7986).
    pub color: Option<String>,
    /// `DTSTART`.
    pub start: Option<IcsDateTime>,
    /// `DTEND` (or `DUE`-like end).
    pub end: Option<IcsDateTime>,
    /// `DURATION`.
    pub duration: Option<Duration>,
    /// `RRULE` value, passed through verbatim (without the `RRULE:` name).
    pub rrule: Option<String>,
    /// `RDATE`s.
    pub rdates: Vec<IcsDateTime>,
    /// `EXDATE`s.
    pub exdates: Vec<IcsDateTime>,
    /// `RECURRENCE-ID` (this event overrides one instance).
    pub recurrence_id: Option<IcsDateTime>,
    /// `SEQUENCE`.
    pub sequence: Option<i64>,
    /// `DTSTAMP`.
    pub dtstamp: Option<DateTime<Utc>>,
    /// `LAST-MODIFIED`.
    pub last_modified: Option<DateTime<Utc>>,
}

impl IcsEvent {
    /// All-day event.
    pub fn all_day(&self) -> bool {
        self.start.as_ref().is_some_and(IcsDateTime::is_date)
    }

    /// Has recurrence.
    pub fn is_recurring(&self) -> bool {
        self.rrule.is_some() || !self.rdates.is_empty()
    }

    /// End: `DTEND`, else `DTSTART + DURATION`, else one day (dates) or zero length.
    pub fn effective_end(&self) -> Option<IcsDateTime> {
        let start = self.start.as_ref()?;
        if let Some(e) = &self.end {
            return Some(e.clone());
        }
        Some(match (self.duration, start) {
            (Some(d), s) => s.add(d),
            (None, IcsDateTime::Date(_)) => start.add(Duration::days(1)),
            (None, s) => s.clone(),
        })
    }

    /// Duration between start and effective end.
    pub fn length(&self) -> Duration {
        match (self.start.as_ref(), self.effective_end()) {
            (Some(s), Some(e)) => (e.to_utc(None) - s.to_utc(None)).max(Duration::zero()),
            _ => Duration::zero(),
        }
    }
}

/// A `VTODO`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IcsTodo {
    /// `UID`.
    pub uid: String,
    /// `SUMMARY`.
    pub summary: Option<String>,
    /// `DESCRIPTION`.
    pub description: Option<String>,
    /// `STATUS` (`NEEDS-ACTION`, `COMPLETED`, `IN-PROCESS`, `CANCELLED`).
    pub status: Option<String>,
    /// `PRIORITY` 0–9.
    pub priority: Option<u8>,
    /// `PERCENT-COMPLETE`.
    pub percent_complete: Option<u8>,
    /// `DTSTART`.
    pub start: Option<IcsDateTime>,
    /// `DUE`.
    pub due: Option<IcsDateTime>,
    /// `COMPLETED`.
    pub completed: Option<DateTime<Utc>>,
    /// `RRULE` passthrough.
    pub rrule: Option<String>,
    /// `CATEGORIES`.
    pub categories: Vec<String>,
    /// `URL`.
    pub url: Option<String>,
}

/// A parsed calendar file (all `VCALENDAR`s merged).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IcsCalendar {
    /// `PRODID`.
    pub prodid: Option<String>,
    /// `X-WR-CALNAME` / `NAME`.
    pub name: Option<String>,
    /// `X-WR-TIMEZONE` (default zone for floating times).
    pub default_tz: Option<String>,
    /// `METHOD`.
    pub method: Option<String>,
    /// Events.
    pub events: Vec<IcsEvent>,
    /// To-dos.
    pub todos: Vec<IcsTodo>,
    /// `TZID`s defined by `VTIMEZONE`s.
    pub timezones: Vec<String>,
    /// Non-fatal problems for the import report.
    pub warnings: Vec<String>,
}

impl IcsCalendar {
    /// The resolved default zone (`X-WR-TIMEZONE`), if valid.
    pub fn default_zone(&self) -> Option<chrono_tz::Tz> {
        self.default_tz.as_deref().and_then(|t| t.parse().ok())
    }
}

/// IPC-shaped calendar event (`CalendarEvent`, SPEC §11.3) for `source: 'ics'`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsEventDto {
    /// Event id (UID, plus the occurrence start for expanded instances).
    pub id: String,
    /// `"ics"`.
    pub source: String,
    /// Calendar id chosen by the caller.
    pub calendar_id: String,
    /// Title.
    pub title: String,
    /// Start.
    pub start: String,
    /// End.
    pub end: String,
    /// All-day.
    pub all_day: bool,
    /// TZID.
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
    /// Recurring series member.
    pub recurring: bool,
}

impl Occurrence {
    /// IPC DTO for this occurrence of `event`.
    pub fn to_dto(
        &self,
        event: &IcsEvent,
        calendar_id: &str,
        color: &str,
        default_zone: Option<chrono_tz::Tz>,
    ) -> IcsEventDto {
        let recurring = event.is_recurring();
        IcsEventDto {
            id: if recurring {
                format!(
                    "{}#{}",
                    event.uid,
                    self.start.to_utc(default_zone).timestamp()
                )
            } else {
                event.uid.clone()
            },
            source: "ics".into(),
            calendar_id: calendar_id.to_string(),
            title: event.summary.clone().unwrap_or_else(|| "(No title)".into()),
            start: self.start.to_ipc_string(default_zone),
            end: self.end.to_ipc_string(default_zone),
            all_day: self.start.is_date(),
            tz: self.start.tzid().map(str::to_string),
            location: event.location.clone(),
            description: event.description.clone(),
            color: color.to_string(),
            recurring,
        }
    }
}
