//! Recurrence expansion with the `rrule` crate, capped per SPEC §9.16 (5,000 instances per
//! event, 10-year horizon).

use std::str::FromStr;

use chrono::{DateTime, Duration, NaiveDateTime, TimeZone, Utc};
use rrule::{RRule, RRuleSet, Tz as RTz, Unvalidated};

use super::tz::local_to_utc;
use super::{IcsDateTime, IcsEvent, IcsLimits, ZoneRef};

/// One occurrence of an event.
#[derive(Debug, Clone, PartialEq)]
pub struct Occurrence {
    /// Start (same kind as the event's `DTSTART`).
    pub start: IcsDateTime,
    /// End.
    pub end: IcsDateTime,
}

/// Expansion result.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Expansion {
    /// Occurrences overlapping the window, ascending.
    pub occurrences: Vec<Occurrence>,
    /// The instance cap or horizon cut the series short.
    pub truncated: bool,
    /// Why the RRULE could not be expanded (the series start is returned instead).
    pub warning: Option<String>,
}

/// How an event's times map onto the rrule crate's zone model.
enum Frame {
    /// Expand in an IANA zone; results are converted back to `Zoned`.
    Iana(chrono_tz::Tz, String, ZoneRef),
    /// Expand wall-clock time as if it were UTC (dates, floating, fixed/unknown zones).
    Wall(Kind),
    /// True UTC instants.
    Utc,
}

#[derive(Clone)]
enum Kind {
    Date,
    Floating,
    Zoned(String, ZoneRef),
}

fn frame(start: &IcsDateTime) -> Frame {
    match start {
        IcsDateTime::Date(_) => Frame::Wall(Kind::Date),
        IcsDateTime::Utc(_) => Frame::Utc,
        IcsDateTime::Floating(_) => Frame::Wall(Kind::Floating),
        IcsDateTime::Zoned { tzid, zone, .. } => match zone {
            ZoneRef::Iana(tz) => Frame::Iana(*tz, tzid.clone(), zone.clone()),
            other => Frame::Wall(Kind::Zoned(tzid.clone(), other.clone())),
        },
    }
}

fn wall(dt: &IcsDateTime) -> NaiveDateTime {
    match dt {
        IcsDateTime::Date(d) => d.and_hms_opt(0, 0, 0).unwrap_or_default(),
        IcsDateTime::Utc(u) => u.naive_utc(),
        IcsDateTime::Floating(n) => *n,
        IcsDateTime::Zoned { local, .. } => *local,
    }
}

impl Frame {
    fn to_rrule(&self, dt: &IcsDateTime) -> DateTime<RTz> {
        match self {
            Frame::Iana(tz, _, _) => match dt {
                IcsDateTime::Zoned {
                    local,
                    zone: ZoneRef::Iana(z),
                    ..
                } => local_to_utc(z, local).with_timezone(&RTz::Tz(*tz)),
                other => other.to_utc(Some(*tz)).with_timezone(&RTz::Tz(*tz)),
            },
            Frame::Utc => dt.to_utc(None).with_timezone(&RTz::UTC),
            Frame::Wall(_) => RTz::UTC.from_utc_datetime(&wall(dt)),
        }
    }

    fn to_ics(&self, dt: &DateTime<RTz>) -> IcsDateTime {
        match self {
            Frame::Iana(tz, tzid, zone) => IcsDateTime::Zoned {
                local: dt.with_timezone(tz).naive_local(),
                tzid: tzid.clone(),
                zone: zone.clone(),
            },
            Frame::Utc => IcsDateTime::Utc(dt.with_timezone(&Utc)),
            Frame::Wall(kind) => {
                let n = dt.naive_utc();
                match kind {
                    Kind::Date => IcsDateTime::Date(n.date()),
                    Kind::Floating => IcsDateTime::Floating(n),
                    Kind::Zoned(tzid, zone) => IcsDateTime::Zoned {
                        local: n,
                        tzid: tzid.clone(),
                        zone: zone.clone(),
                    },
                }
            }
        }
    }

    /// Window bound in this frame (wall frames compare wall-clock times).
    fn bound(&self, t: DateTime<Utc>) -> DateTime<RTz> {
        match self {
            Frame::Iana(tz, _, _) => t.with_timezone(&RTz::Tz(*tz)),
            _ => t.with_timezone(&RTz::UTC),
        }
    }
}

fn overlaps(
    start: &IcsDateTime,
    end: &IcsDateTime,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> bool {
    let s = start.to_utc(None);
    let e = end.to_utc(None);
    s <= to && (e > from || (e == s && s >= from))
}

/// Expand `event` into occurrences overlapping `[window_start, window_end]`.
///
/// Without `RRULE`/`RDATE` the event itself is returned if it overlaps. Expansion stops at
/// `limits.max_instances` and `DTSTART + limits.horizon_years`. An RRULE the `rrule` crate
/// rejects yields only the first instance plus a warning.
pub fn expand_event(
    event: &IcsEvent,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
    limits: &IcsLimits,
) -> Expansion {
    let Some(start) = event.start.clone() else {
        return Expansion {
            warning: Some("event has no DTSTART".into()),
            ..Default::default()
        };
    };
    let length = event.length();
    let single = |warning: Option<String>| {
        let end = event.effective_end().unwrap_or_else(|| start.clone());
        Expansion {
            occurrences: if overlaps(&start, &end, window_start, window_end) {
                vec![Occurrence {
                    start: start.clone(),
                    end,
                }]
            } else {
                Vec::new()
            },
            truncated: false,
            warning,
        }
    };
    if !event.is_recurring() {
        return single(None);
    }

    let f = frame(&start);
    let dt_start = f.to_rrule(&start);
    let mut set = RRuleSet::new(dt_start);
    if let Some(rule) = &event.rrule {
        let parsed = RRule::<Unvalidated>::from_str(rule).and_then(|r| r.validate(dt_start));
        match parsed {
            Ok(r) => set = set.rrule(r),
            Err(e) => return single(Some(format!("RRULE not expanded: {e}"))),
        }
    }
    if event.rrule.is_none() {
        // DTSTART is always the first instance (RFC 5545 §3.8.5.2).
        set = set.rdate(dt_start);
    }
    for r in &event.rdates {
        set = set.rdate(f.to_rrule(r));
    }
    for x in &event.exdates {
        set = set.exdate(f.to_rrule(x));
    }

    let horizon = start
        .to_utc(None)
        .checked_add_signed(Duration::days(
            365 * i64::from(limits.horizon_years) + i64::from(limits.horizon_years / 4),
        ))
        .unwrap_or(DateTime::<Utc>::MAX_UTC);
    let end_bound = window_end.min(horizon);
    let start_bound = window_start
        .checked_sub_signed(length)
        .unwrap_or(window_start);
    if start_bound > end_bound {
        return Expansion {
            truncated: window_end > horizon,
            ..Default::default()
        };
    }
    let result = set
        .after(f.bound(start_bound))
        .before(f.bound(end_bound))
        .all(limits.max_instances.max(1));
    let truncated = (result.limited && result.dates.len() >= usize::from(limits.max_instances))
        || window_end > horizon;
    let occurrences = result
        .dates
        .iter()
        .map(|d| {
            let s = f.to_ics(d);
            let e = s.add(length);
            Occurrence { start: s, end: e }
        })
        .filter(|o| overlaps(&o.start, &o.end, window_start, window_end))
        .collect();
    Expansion {
        occurrences,
        truncated,
        warning: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ics::{IcsLimits, parse_ics};
    use chrono::NaiveDate;

    fn utc(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap()
    }

    fn cal(body: &str) -> crate::ics::IcsCalendar {
        let s = format!("BEGIN:VCALENDAR\nVERSION:2.0\n{body}\nEND:VCALENDAR\n");
        parse_ics(s.as_bytes(), &IcsLimits::default()).unwrap()
    }

    #[test]
    fn weekly_in_zone_keeps_wall_time_across_dst() {
        let c = cal(
            "BEGIN:VEVENT\nUID:w\nDTSTART;TZID=America/New_York:20261020T090000\nDTEND;TZID=America/New_York:20261020T100000\nRRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;TZID=America/New_York:20261027T090000\nEND:VEVENT",
        );
        let x = expand_event(
            &c.events[0],
            utc(2026, 1, 1),
            utc(2027, 1, 1),
            &IcsLimits::default(),
        );
        assert_eq!(x.occurrences.len(), 3);
        let utcs: Vec<String> = x
            .occurrences
            .iter()
            .map(|o| o.start.to_utc(None).to_rfc3339())
            .collect();
        // 09:00 EDT = 13:00Z before Nov 1, 09:00 EST = 14:00Z after.
        assert_eq!(
            utcs,
            vec![
                "2026-10-20T13:00:00+00:00",
                "2026-11-03T14:00:00+00:00",
                "2026-11-10T14:00:00+00:00"
            ]
        );
        assert_eq!(
            x.occurrences[0].end.to_utc(None) - x.occurrences[0].start.to_utc(None),
            Duration::hours(1)
        );
        assert!(!x.truncated);
        assert!(x.occurrences[0].start.tzid().is_some());
    }

    #[test]
    fn all_day_yearly_and_window() {
        let c =
            cal("BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:20000229\nRRULE:FREQ=YEARLY\nEND:VEVENT");
        let x = expand_event(
            &c.events[0],
            utc(2026, 1, 1),
            utc(2034, 1, 1),
            &IcsLimits::default(),
        );
        // Only 2028 and 2032 have Feb 29; horizon (2010) is long past, so nothing.
        assert!(x.occurrences.is_empty());
        assert!(x.truncated);
        let c =
            cal("BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:20261225\nRRULE:FREQ=YEARLY\nEND:VEVENT");
        let x = expand_event(
            &c.events[0],
            utc(2026, 1, 1),
            utc(2030, 1, 1),
            &IcsLimits::default(),
        );
        assert_eq!(x.occurrences.len(), 4);
        assert_eq!(
            x.occurrences[1].start,
            IcsDateTime::Date(NaiveDate::from_ymd_opt(2027, 12, 25).unwrap())
        );
        assert_eq!(
            x.occurrences[1].end,
            IcsDateTime::Date(NaiveDate::from_ymd_opt(2027, 12, 26).unwrap())
        );
    }

    #[test]
    fn caps_instances_and_horizon() {
        let c =
            cal("BEGIN:VEVENT\nUID:m\nDTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY\nEND:VEVENT");
        let x = expand_event(
            &c.events[0],
            utc(2026, 1, 1),
            utc(2040, 1, 1),
            &IcsLimits::default(),
        );
        assert_eq!(x.occurrences.len(), 5000);
        assert!(x.truncated);
        let c =
            cal("BEGIN:VEVENT\nUID:d\nDTSTART:20260101T000000Z\nRRULE:FREQ=MONTHLY\nEND:VEVENT");
        let x = expand_event(
            &c.events[0],
            utc(2020, 1, 1),
            utc(2050, 1, 1),
            &IcsLimits::default(),
        );
        assert!(
            x.occurrences.len() <= 121 && x.occurrences.len() >= 120,
            "{}",
            x.occurrences.len()
        );
        assert!(x.truncated);
    }

    #[test]
    fn bad_rrule_falls_back_to_single() {
        let c =
            cal("BEGIN:VEVENT\nUID:x\nDTSTART:20260105T100000Z\nRRULE:FREQ=SOMETIMES\nEND:VEVENT");
        assert!(c.events[0].rrule.is_some());
        let x = expand_event(
            &c.events[0],
            utc(2026, 1, 1),
            utc(2026, 2, 1),
            &IcsLimits::default(),
        );
        assert_eq!(x.occurrences.len(), 1);
        assert!(x.warning.is_some());
    }

    #[test]
    fn rdates_and_non_recurring() {
        let c = cal(
            "BEGIN:VEVENT\nUID:r\nDTSTART:20260105T100000Z\nDURATION:PT30M\nRDATE:20260110T100000Z,20260301T100000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:s\nDTSTART:20250105T100000Z\nEND:VEVENT",
        );
        let x = expand_event(
            &c.events[0],
            utc(2026, 1, 1),
            utc(2026, 2, 1),
            &IcsLimits::default(),
        );
        assert_eq!(x.occurrences.len(), 2);
        let y = expand_event(
            &c.events[1],
            utc(2026, 1, 1),
            utc(2026, 2, 1),
            &IcsLimits::default(),
        );
        assert!(y.occurrences.is_empty());
        let dto = x.occurrences[1].to_dto(&c.events[0], "cal", "blue", None);
        assert!(dto.recurring);
        assert!(dto.id.starts_with("r#"));
        assert_eq!(dto.start, "2026-01-10T10:00:00Z");
        assert_eq!(dto.end, "2026-01-10T10:30:00Z");
    }

    #[test]
    fn floating_series_stay_floating() {
        let c = cal(
            "BEGIN:VEVENT\nUID:f\nDTSTART:20260105T080000\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT",
        );
        let x = expand_event(
            &c.events[0],
            utc(2026, 1, 1),
            utc(2026, 2, 1),
            &IcsLimits::default(),
        );
        assert_eq!(x.occurrences.len(), 3);
        assert!(matches!(x.occurrences[2].start, IcsDateTime::Floating(_)));
    }
}
