//! RFC 5545 writer: CRLF line endings, 75-octet folding, TEXT escaping, and generated
//! `VTIMEZONE`s (explicit observances) for every IANA zone referenced.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::{OffsetComponents, OffsetName};

use super::{IcsDateTime, IcsEvent, IcsTodo, ZoneRef};
use crate::error::{IntegrationError, Result};

/// Product identifier written to every file.
pub const PRODID: &str = "-//devartin//Ultranote//EN";
/// Longest span of years a generated `VTIMEZONE` covers.
const MAX_TZ_YEARS: i32 = 30;

/// A calendar to export.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExportCalendar {
    /// `X-WR-CALNAME`.
    pub name: Option<String>,
    /// Events.
    pub events: Vec<IcsEvent>,
    /// To-dos.
    pub todos: Vec<IcsTodo>,
    /// `DTSTAMP` for components without one.
    pub dtstamp: DateTime<Utc>,
}

/// Escape a TEXT value.
pub(crate) fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c if c.is_control() && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// Quote a parameter value when needed; `"` and controls are removed.
fn param_value(s: &str) -> String {
    let clean: String = s.chars().filter(|c| *c != '"' && !c.is_control()).collect();
    if clean.contains([':', ';', ',']) {
        format!("\"{clean}\"")
    } else {
        clean
    }
}

/// Append a content line, folded at 75 octets on UTF-8 boundaries.
fn push_line(out: &mut String, line: &str) {
    let mut budget = 75;
    let mut used = 0;
    for c in line.chars() {
        let len = c.len_utf8();
        if used + len > budget {
            out.push_str("\r\n ");
            used = 0;
            budget = 74;
        }
        out.push(c);
        used += len;
    }
    out.push_str("\r\n");
}

fn fmt_naive(n: &NaiveDateTime) -> String {
    n.format("%Y%m%dT%H%M%S").to_string()
}

fn fmt_utc(d: &DateTime<Utc>) -> String {
    d.format("%Y%m%dT%H%M%SZ").to_string()
}

/// `NAME[;params]:value` for a date-time property.
fn dt_line(name: &str, dt: &IcsDateTime) -> String {
    match dt {
        IcsDateTime::Date(d) => format!("{name};VALUE=DATE:{}", d.format("%Y%m%d")),
        IcsDateTime::Utc(u) => format!("{name}:{}", fmt_utc(u)),
        IcsDateTime::Floating(n) => format!("{name}:{}", fmt_naive(n)),
        IcsDateTime::Zoned {
            local,
            zone: ZoneRef::Iana(tz),
            ..
        } => format!(
            "{name};TZID={}:{}",
            param_value(tz.name()),
            fmt_naive(local)
        ),
        other => format!("{name}:{}", fmt_utc(&other.to_utc(None))),
    }
}

fn dt_list_line(name: &str, list: &[IcsDateTime]) -> Vec<String> {
    // One line per value keeps per-value parameters exact.
    list.iter().map(|d| dt_line(name, d)).collect()
}

fn validate_rrule(rule: &str) -> Result<String> {
    let r = rule.trim();
    let r = r.strip_prefix("RRULE:").unwrap_or(r).to_ascii_uppercase();
    if r.is_empty() || r.len() > 1000 || !r.starts_with("FREQ=") && !r.contains(";FREQ=") {
        return Err(IntegrationError::Invalid("RRULE must contain FREQ".into()));
    }
    if !r
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "=;,:+-".contains(c))
    {
        return Err(IntegrationError::Invalid(
            "RRULE contains invalid characters".into(),
        ));
    }
    Ok(r)
}

fn fmt_offset(secs: i32) -> String {
    let sign = if secs < 0 { '-' } else { '+' };
    let a = secs.unsigned_abs();
    let (h, m, s) = (a / 3600, (a % 3600) / 60, a % 60);
    if s == 0 {
        format!("{sign}{h:02}{m:02}")
    } else {
        format!("{sign}{h:02}{m:02}{s:02}")
    }
}

struct ZoneSpan {
    tz: chrono_tz::Tz,
    from_year: i32,
    to_year: i32,
}

fn offset_at(tz: &chrono_tz::Tz, t: DateTime<Utc>) -> (i32, bool, String) {
    let off = tz.offset_from_utc_datetime(&t.naive_utc());
    let secs = off.fix().local_minus_utc();
    let dst = off.dst_offset() != Duration::zero();
    let name = off
        .abbreviation()
        .map(str::to_string)
        .unwrap_or_else(|| fmt_offset(secs));
    (secs, dst, name)
}

/// Write a `VTIMEZONE` with one explicit observance per transition in the span.
fn write_vtimezone(out: &mut String, span: &ZoneSpan) {
    let tz = span.tz;
    let start = Utc
        .with_ymd_and_hms(span.from_year, 1, 1, 0, 0, 0)
        .single()
        .unwrap_or(DateTime::<Utc>::MIN_UTC);
    let end = Utc
        .with_ymd_and_hms(span.to_year.saturating_add(1), 1, 1, 0, 0, 0)
        .single()
        .unwrap_or(start);
    push_line(out, "BEGIN:VTIMEZONE");
    push_line(out, &format!("TZID:{}", tz.name()));
    push_line(out, &format!("X-LIC-LOCATION:{}", tz.name()));

    let (mut cur_off, mut cur_dst, mut cur_name) = offset_at(&tz, start);
    let observance =
        |out: &mut String, kind: &str, local: NaiveDateTime, from: i32, to: i32, name: &str| {
            push_line(out, &format!("BEGIN:{kind}"));
            push_line(out, &format!("DTSTART:{}", fmt_naive(&local)));
            push_line(out, &format!("TZOFFSETFROM:{}", fmt_offset(from)));
            push_line(out, &format!("TZOFFSETTO:{}", fmt_offset(to)));
            push_line(out, &format!("TZNAME:{}", escape_text(name)));
            push_line(out, &format!("END:{kind}"));
        };
    // Initial observance covering everything before the first transition.
    let initial_local = start.naive_utc() + Duration::seconds(i64::from(cur_off));
    observance(
        out,
        if cur_dst { "DAYLIGHT" } else { "STANDARD" },
        initial_local,
        cur_off,
        cur_off,
        &cur_name,
    );
    let mut t = start;
    while t < end {
        let next = t + Duration::days(1);
        let (off, _, _) = offset_at(&tz, next);
        if off != cur_off {
            // Binary search the first minute with the new offset.
            let (mut lo, mut hi) = (t, next);
            while hi - lo > Duration::minutes(1) {
                let mid = lo + (hi - lo) / 2;
                if offset_at(&tz, mid).0 == cur_off {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let (new_off, new_dst, new_name) = offset_at(&tz, hi);
            let local_before = hi.naive_utc() + Duration::seconds(i64::from(cur_off));
            observance(
                out,
                if new_dst { "DAYLIGHT" } else { "STANDARD" },
                local_before,
                cur_off,
                new_off,
                &new_name,
            );
            cur_off = new_off;
            cur_dst = new_dst;
            cur_name = new_name;
        }
        t = next;
    }
    let _ = (cur_dst, cur_name);
    push_line(out, "END:VTIMEZONE");
}

fn collect_zones(cal: &ExportCalendar) -> BTreeMap<String, ZoneSpan> {
    let mut zones: BTreeMap<String, ZoneSpan> = BTreeMap::new();
    let mut note = |dt: &IcsDateTime, recurring: bool| {
        if let IcsDateTime::Zoned {
            local,
            zone: ZoneRef::Iana(tz),
            ..
        } = dt
        {
            let y = local.year();
            let last = if recurring { y + 10 } else { y };
            let e = zones.entry(tz.name().to_string()).or_insert(ZoneSpan {
                tz: *tz,
                from_year: y,
                to_year: last,
            });
            e.from_year = e.from_year.min(y);
            e.to_year = e.to_year.max(last).min(e.from_year + MAX_TZ_YEARS);
        }
    };
    for e in &cal.events {
        let rec = e.rrule.is_some();
        for dt in e
            .start
            .iter()
            .chain(e.end.iter())
            .chain(e.recurrence_id.iter())
        {
            note(dt, rec);
        }
        for dt in e.rdates.iter().chain(e.exdates.iter()) {
            note(dt, false);
        }
    }
    for t in &cal.todos {
        let rec = t.rrule.is_some();
        for dt in t.start.iter().chain(t.due.iter()) {
            note(dt, rec);
        }
    }
    zones
}

fn opt_text(out: &mut String, name: &str, v: &Option<String>) {
    if let Some(v) = v.as_deref().filter(|s| !s.is_empty()) {
        push_line(out, &format!("{name}:{}", escape_text(v)));
    }
}

fn uid_or_new(uid: &str) -> String {
    let u: String = uid.chars().filter(|c| !c.is_control()).collect();
    if u.trim().is_empty() {
        format!("{}@emp", uuid::Uuid::new_v4())
    } else {
        u
    }
}

fn categories_line(out: &mut String, cats: &[String]) {
    if !cats.is_empty() {
        let joined: Vec<String> = cats.iter().map(|c| escape_text(c)).collect();
        push_line(out, &format!("CATEGORIES:{}", joined.join(",")));
    }
}

/// Generate an iCalendar document. Fails only on an invalid `RRULE`.
pub fn generate_ics(cal: &ExportCalendar) -> Result<String> {
    let mut out = String::new();
    push_line(&mut out, "BEGIN:VCALENDAR");
    push_line(&mut out, "VERSION:2.0");
    push_line(&mut out, &format!("PRODID:{PRODID}"));
    push_line(&mut out, "CALSCALE:GREGORIAN");
    opt_text(&mut out, "X-WR-CALNAME", &cal.name);
    for span in collect_zones(cal).values() {
        write_vtimezone(&mut out, span);
    }
    let stamp = fmt_utc(&cal.dtstamp);
    for e in &cal.events {
        let Some(start) = &e.start else {
            continue;
        };
        push_line(&mut out, "BEGIN:VEVENT");
        push_line(&mut out, &format!("UID:{}", uid_or_new(&e.uid)));
        push_line(
            &mut out,
            &format!(
                "DTSTAMP:{}",
                e.dtstamp
                    .as_ref()
                    .map(fmt_utc)
                    .unwrap_or_else(|| stamp.clone())
            ),
        );
        push_line(&mut out, &dt_line("DTSTART", start));
        if let Some(end) = &e.end {
            push_line(&mut out, &dt_line("DTEND", end));
        } else if let Some(d) = e.duration {
            push_line(&mut out, &format!("DURATION:{}", fmt_duration(d)));
        }
        if let Some(r) = &e.rrule {
            push_line(&mut out, &format!("RRULE:{}", validate_rrule(r)?));
        }
        for l in dt_list_line("RDATE", &e.rdates) {
            push_line(&mut out, &l);
        }
        for l in dt_list_line("EXDATE", &e.exdates) {
            push_line(&mut out, &l);
        }
        if let Some(r) = &e.recurrence_id {
            push_line(&mut out, &dt_line("RECURRENCE-ID", r));
        }
        opt_text(&mut out, "SUMMARY", &e.summary);
        opt_text(&mut out, "DESCRIPTION", &e.description);
        opt_text(&mut out, "LOCATION", &e.location);
        if let Some(u) = e
            .url
            .as_deref()
            .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        {
            push_line(
                &mut out,
                &format!(
                    "URL:{}",
                    u.chars().filter(|c| !c.is_control()).collect::<String>()
                ),
            );
        }
        opt_text(&mut out, "STATUS", &e.status);
        opt_text(&mut out, "TRANSP", &e.transp);
        opt_text(&mut out, "COLOR", &e.color);
        categories_line(&mut out, &e.categories);
        if let Some(s) = e.sequence {
            push_line(&mut out, &format!("SEQUENCE:{s}"));
        }
        if let Some(m) = &e.last_modified {
            push_line(&mut out, &format!("LAST-MODIFIED:{}", fmt_utc(m)));
        }
        push_line(&mut out, "END:VEVENT");
    }
    for t in &cal.todos {
        push_line(&mut out, "BEGIN:VTODO");
        push_line(&mut out, &format!("UID:{}", uid_or_new(&t.uid)));
        push_line(&mut out, &format!("DTSTAMP:{stamp}"));
        if let Some(s) = &t.start {
            push_line(&mut out, &dt_line("DTSTART", s));
        }
        if let Some(d) = &t.due {
            push_line(&mut out, &dt_line("DUE", d));
        }
        if let Some(r) = &t.rrule {
            push_line(&mut out, &format!("RRULE:{}", validate_rrule(r)?));
        }
        opt_text(&mut out, "SUMMARY", &t.summary);
        opt_text(&mut out, "DESCRIPTION", &t.description);
        opt_text(&mut out, "STATUS", &t.status);
        if let Some(p) = t.priority.filter(|p| *p <= 9) {
            push_line(&mut out, &format!("PRIORITY:{p}"));
        }
        if let Some(p) = t.percent_complete.filter(|p| *p <= 100) {
            push_line(&mut out, &format!("PERCENT-COMPLETE:{p}"));
        }
        if let Some(c) = &t.completed {
            push_line(&mut out, &format!("COMPLETED:{}", fmt_utc(c)));
        }
        categories_line(&mut out, &t.categories);
        push_line(&mut out, "END:VTODO");
    }
    push_line(&mut out, "END:VCALENDAR");
    Ok(out)
}

fn fmt_duration(d: Duration) -> String {
    let mut secs = d.num_seconds();
    let mut s = String::new();
    if secs < 0 {
        s.push('-');
        secs = -secs;
    }
    s.push('P');
    let days = secs / 86_400;
    let rem = secs % 86_400;
    if days > 0 {
        let _ = write!(s, "{days}D");
    }
    if rem > 0 || days == 0 {
        s.push('T');
        let (h, m, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
        if h > 0 {
            let _ = write!(s, "{h}H");
        }
        if m > 0 {
            let _ = write!(s, "{m}M");
        }
        if sec > 0 || (h == 0 && m == 0) {
            let _ = write!(s, "{sec}S");
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ics::{IcsLimits, expand_event, parse_ics};
    use chrono::NaiveDate;

    fn stamp() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0).unwrap()
    }

    #[test]
    fn folding_respects_octets_and_utf8() {
        let mut out = String::new();
        let line = format!("DESCRIPTION:{}", "é".repeat(100));
        push_line(&mut out, &line);
        for l in out.split("\r\n").filter(|l| !l.is_empty()) {
            assert!(l.len() <= 75, "{} octets", l.len());
        }
        let unfolded = out.replace("\r\n ", "");
        assert_eq!(unfolded.trim_end(), line);
    }

    #[test]
    fn escaping() {
        assert_eq!(escape_text("a,b;c\\d\ne\r\u{7}"), "a\\,b\\;c\\\\d\\ne");
        assert_eq!(param_value("A:B"), "\"A:B\"");
        assert_eq!(param_value("a\"b"), "ab");
        assert_eq!(fmt_offset(-18000), "-0500");
        assert_eq!(fmt_offset(19800), "+0530");
        assert_eq!(fmt_duration(Duration::minutes(90)), "PT1H30M");
        assert_eq!(fmt_duration(Duration::days(2)), "P2D");
        assert_eq!(fmt_duration(Duration::zero()), "PT0S");
    }

    #[test]
    fn round_trips_through_parser() {
        let ny = chrono_tz::America::New_York;
        let cal = ExportCalendar {
            name: Some("Work, mostly".into()),
            events: vec![
                IcsEvent {
                    uid: "e1@emp".into(),
                    summary: Some("Standup; daily, team".into()),
                    description: Some("Line 1\nLine 2 ".repeat(20)),
                    start: Some(IcsDateTime::Zoned {
                        local: NaiveDate::from_ymd_opt(2026, 10, 26)
                            .unwrap()
                            .and_hms_opt(9, 0, 0)
                            .unwrap(),
                        tzid: "America/New_York".into(),
                        zone: ZoneRef::Iana(ny),
                    }),
                    end: Some(IcsDateTime::Zoned {
                        local: NaiveDate::from_ymd_opt(2026, 10, 26)
                            .unwrap()
                            .and_hms_opt(9, 15, 0)
                            .unwrap(),
                        tzid: "America/New_York".into(),
                        zone: ZoneRef::Iana(ny),
                    }),
                    rrule: Some("FREQ=WEEKLY;BYDAY=MO;COUNT=3".into()),
                    categories: vec!["Work".into(), "A,B".into()],
                    ..Default::default()
                },
                IcsEvent {
                    uid: String::new(),
                    summary: Some("Holiday".into()),
                    start: Some(IcsDateTime::Date(
                        NaiveDate::from_ymd_opt(2026, 12, 25).unwrap(),
                    )),
                    end: Some(IcsDateTime::Date(
                        NaiveDate::from_ymd_opt(2026, 12, 26).unwrap(),
                    )),
                    ..Default::default()
                },
            ],
            todos: vec![IcsTodo {
                uid: "t1".into(),
                summary: Some("Pay rent".into()),
                due: Some(IcsDateTime::Utc(stamp())),
                priority: Some(2),
                ..Default::default()
            }],
            dtstamp: stamp(),
        };
        let text = generate_ics(&cal).unwrap();
        assert!(text.ends_with("END:VCALENDAR\r\n"));
        assert!(text.contains("BEGIN:VTIMEZONE\r\nTZID:America/New_York"));
        assert!(text.contains("TZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500"));
        assert!(text.lines().all(|l| l.len() <= 75));
        assert!(!text.replace("\r\n", "").contains('\n'));

        let parsed = parse_ics(text.as_bytes(), &IcsLimits::default()).unwrap();
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(parsed.name.as_deref(), Some("Work, mostly"));
        assert_eq!(parsed.events.len(), 2);
        let e = &parsed.events[0];
        assert_eq!(e.summary, cal.events[0].summary);
        assert_eq!(e.description, cal.events[0].description);
        assert_eq!(e.categories, vec!["Work", "A,B"]);
        assert_eq!(e.start, cal.events[0].start);
        assert!(parsed.events[1].uid.ends_with("@emp"));
        assert_eq!(parsed.todos[0].priority, Some(2));
        // Expansion across the DST change still lands at 09:00 local.
        let x = expand_event(
            e,
            stamp() - Duration::days(60),
            stamp(),
            &IcsLimits::default(),
        );
        let hours: Vec<u32> = x
            .occurrences
            .iter()
            .map(|o| o.start.to_utc(None).with_timezone(&ny).hour())
            .collect();
        assert_eq!(hours, vec![9, 9, 9]);
    }

    use chrono::Timelike;

    #[test]
    fn non_iana_zones_export_as_utc_and_bad_rrule_errors() {
        let off = chrono::FixedOffset::east_opt(3600).unwrap();
        let cal = ExportCalendar {
            events: vec![IcsEvent {
                uid: "x".into(),
                start: Some(IcsDateTime::Zoned {
                    local: NaiveDate::from_ymd_opt(2026, 1, 1)
                        .unwrap()
                        .and_hms_opt(10, 0, 0)
                        .unwrap(),
                    tzid: "Custom".into(),
                    zone: ZoneRef::Fixed(off),
                }),
                ..Default::default()
            }],
            dtstamp: stamp(),
            ..Default::default()
        };
        let text = generate_ics(&cal).unwrap();
        assert!(text.contains("DTSTART:20260101T090000Z"));
        assert!(!text.contains("VTIMEZONE"));
        let mut bad = cal.clone();
        bad.events[0].rrule = Some("FREQ=DAILY\r\nX-INJECT:1".into());
        assert!(generate_ics(&bad).is_err());
        let mut nofreq = cal;
        nofreq.events[0].rrule = Some("COUNT=3".into());
        assert!(generate_ics(&nofreq).is_err());
    }

    #[test]
    fn vtimezone_for_zone_without_dst() {
        let tokyo = chrono_tz::Asia::Tokyo;
        let mut out = String::new();
        write_vtimezone(
            &mut out,
            &ZoneSpan {
                tz: tokyo,
                from_year: 2026,
                to_year: 2027,
            },
        );
        assert_eq!(out.matches("BEGIN:STANDARD").count(), 1);
        assert!(!out.contains("DAYLIGHT"));
        assert!(out.contains("TZOFFSETTO:+0900"));
    }
}
