//! RFC 5545 parser: unfolding, content lines, components, values.

use std::collections::HashMap;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};

use super::tz::{VTimezoneInfo, parse_utc_offset, resolve_with};
use super::{IcsCalendar, IcsDateTime, IcsEvent, IcsLimits, IcsTodo, ZoneRef};
use crate::error::{IntegrationError, Result};

/// One content line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Property {
    pub(crate) name: String,
    pub(crate) params: Vec<(String, Vec<String>)>,
    pub(crate) value: String,
}

impl Property {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .and_then(|(_, v)| v.first())
            .map(String::as_str)
    }
}

/// A component tree node.
#[derive(Debug, Clone, Default)]
pub(crate) struct Component {
    pub(crate) name: String,
    pub(crate) props: Vec<Property>,
    pub(crate) children: Vec<Component>,
}

impl Component {
    fn prop(&self, name: &str) -> Option<&Property> {
        self.props.iter().find(|p| p.name == name)
    }

    fn props_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Property> + 'a {
        self.props.iter().filter(move |p| p.name == name)
    }
}

/// Unfold physical lines into logical lines (CRLF or LF; continuation = leading space/tab).
fn unfold(text: &str, max_line: usize) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix([' ', '\t'])
            && let Some(last) = out.last_mut()
        {
            if last.len() + rest.len() > max_line {
                return Err(IntegrationError::LimitExceeded("ICS line too long".into()));
            }
            last.push_str(rest);
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if line.len() > max_line {
            return Err(IntegrationError::LimitExceeded("ICS line too long".into()));
        }
        out.push(line.to_string());
    }
    Ok(out)
}

/// Parse `NAME *(;PARAM=VAL[,VAL]) : VALUE`. Returns `None` for malformed lines.
pub(crate) fn parse_content_line(line: &str) -> Option<Property> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    if i == 0 || i >= bytes.len() {
        return None;
    }
    let name = line[..i].to_ascii_uppercase();
    let mut params = Vec::new();
    while i < bytes.len() && bytes[i] == b';' {
        i += 1;
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' || i == start {
            return None;
        }
        let pname = line[start..i].to_ascii_uppercase();
        i += 1;
        let mut values = Vec::new();
        loop {
            if i < bytes.len() && bytes[i] == b'"' {
                let vstart = i + 1;
                let close = line[vstart..].find('"')? + vstart;
                values.push(line[vstart..close].to_string());
                i = close + 1;
            } else {
                let vstart = i;
                while i < bytes.len() && !matches!(bytes[i], b',' | b';' | b':') {
                    if bytes[i] == b'"' {
                        return None;
                    }
                    i += 1;
                }
                values.push(line[vstart..i].to_string());
            }
            if i < bytes.len() && bytes[i] == b',' {
                i += 1;
                continue;
            }
            break;
        }
        params.push((pname, values));
    }
    if i >= bytes.len() || bytes[i] != b':' {
        return None;
    }
    Some(Property {
        name,
        params,
        value: line[i + 1..].to_string(),
    })
}

fn build_tree(
    lines: &[String],
    limits: &IcsLimits,
    warnings: &mut Vec<String>,
) -> Result<Vec<Component>> {
    let mut roots: Vec<Component> = Vec::new();
    let mut stack: Vec<Component> = Vec::new();
    let mut components = 0usize;
    let mut malformed = 0usize;
    for line in lines {
        let Some(p) = parse_content_line(line) else {
            malformed += 1;
            continue;
        };
        match p.name.as_str() {
            "BEGIN" => {
                components += 1;
                if components > limits.max_components {
                    return Err(IntegrationError::LimitExceeded(
                        "too many calendar components".into(),
                    ));
                }
                if stack.len() >= limits.max_depth {
                    return Err(IntegrationError::LimitExceeded(
                        "calendar nesting too deep".into(),
                    ));
                }
                stack.push(Component {
                    name: p.value.trim().to_ascii_uppercase(),
                    ..Default::default()
                });
            }
            "END" => {
                let name = p.value.trim().to_ascii_uppercase();
                if !stack.iter().any(|c| c.name == name) {
                    warnings.push(format!("Ignored unmatched END:{name}."));
                    continue;
                }
                // Close any unterminated inner components first.
                while let Some(c) = stack.pop() {
                    let done = c.name == name;
                    if !done {
                        warnings.push(format!("Component {} was not terminated.", c.name));
                    }
                    match stack.last_mut() {
                        Some(parent) => parent.children.push(c),
                        None => roots.push(c),
                    }
                    if done {
                        break;
                    }
                }
            }
            _ => match stack.last_mut() {
                Some(c) => {
                    if c.props.len() >= limits.max_properties {
                        return Err(IntegrationError::LimitExceeded(
                            "too many properties in a component".into(),
                        ));
                    }
                    c.props.push(p);
                }
                None => malformed += 1,
            },
        }
    }
    while let Some(c) = stack.pop() {
        warnings.push(format!("Component {} was not terminated.", c.name));
        match stack.last_mut() {
            Some(parent) => parent.children.push(c),
            None => roots.push(c),
        }
    }
    if malformed > 0 {
        warnings.push(format!("Skipped {malformed} malformed line(s)."));
    }
    Ok(roots)
}

/// Unescape a TEXT value (`\\ \; \, \n \N`).
pub(crate) fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n' | 'N') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Split a TEXT list on unescaped commas, then unescape each item.
fn split_text_list(s: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            cur.push('\\');
            cur.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == ',' {
            items.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    items.push(cur);
    items
        .into_iter()
        .map(|i| unescape_text(i.trim()))
        .filter(|i| !i.is_empty())
        .collect()
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    if s.len() != 8 || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y%m%d").ok()
}

fn parse_naive_datetime(s: &str) -> Option<NaiveDateTime> {
    let (d, t) = s.split_once('T')?;
    let date = parse_date(d)?;
    if t.len() != 6 || !t.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let h: u32 = t[0..2].parse().ok()?;
    let m: u32 = t[2..4].parse().ok()?;
    let mut sec: u32 = t[4..6].parse().ok()?;
    if sec == 60 {
        sec = 59; // leap second
    }
    Some(date.and_time(NaiveTime::from_hms_opt(h, m, sec)?))
}

/// Parse one DATE / DATE-TIME token in the context of `tzid`.
fn parse_dt_token(
    token: &str,
    value_type: Option<&str>,
    tzid: Option<&str>,
    vtz: &HashMap<String, VTimezoneInfo>,
) -> Option<IcsDateTime> {
    let token = token.trim();
    let is_date = value_type.is_some_and(|v| v.eq_ignore_ascii_case("DATE"))
        || (token.len() == 8 && !token.contains('T'));
    if is_date {
        return parse_date(token.get(..8)?).map(IcsDateTime::Date);
    }
    if let Some(utc) = token.strip_suffix('Z').or_else(|| token.strip_suffix('z')) {
        return parse_naive_datetime(utc).map(|n| IcsDateTime::Utc(Utc.from_utc_datetime(&n)));
    }
    let local = parse_naive_datetime(token)?;
    Some(match tzid {
        Some(t) => IcsDateTime::Zoned {
            local,
            tzid: t.to_string(),
            zone: resolve_with(t, vtz),
        },
        None => IcsDateTime::Floating(local),
    })
}

fn parse_dt_prop(p: &Property, vtz: &HashMap<String, VTimezoneInfo>) -> Option<IcsDateTime> {
    parse_dt_token(&p.value, p.param("VALUE"), p.param("TZID"), vtz)
}

fn parse_dt_list(
    p: &Property,
    vtz: &HashMap<String, VTimezoneInfo>,
    out: &mut Vec<IcsDateTime>,
    cap: usize,
) {
    for token in p.value.split(',') {
        if out.len() >= cap {
            break;
        }
        // RDATE;VALUE=PERIOD: take the start.
        let start = token.split('/').next().unwrap_or(token);
        let vt = p
            .param("VALUE")
            .filter(|v| !v.eq_ignore_ascii_case("PERIOD"));
        if let Some(dt) = parse_dt_token(start, vt, p.param("TZID"), vtz) {
            out.push(dt);
        }
    }
}

fn parse_utc_stamp(p: &Property) -> Option<DateTime<Utc>> {
    match parse_dt_token(&p.value, None, None, &HashMap::new())? {
        IcsDateTime::Utc(d) => Some(d),
        IcsDateTime::Floating(n) => Some(Utc.from_utc_datetime(&n)),
        IcsDateTime::Date(d) => d.and_hms_opt(0, 0, 0).map(|n| Utc.from_utc_datetime(&n)),
        IcsDateTime::Zoned { .. } => None,
    }
}

/// Parse an RFC 5545 DURATION (`[+-]P[nW] | P[nD][T[nH][nM][nS]]`).
pub(crate) fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (neg, rest) = match s.as_bytes().first()? {
        b'-' => (true, &s[1..]),
        b'+' => (false, &s[1..]),
        _ => (false, s),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total: i64 = 0;
    let mut num: Option<i64> = None;
    let mut in_time = false;
    let mut any = false;
    for c in rest.chars() {
        match c {
            '0'..='9' => {
                let d = i64::from(c.to_digit(10)?);
                num = Some(num.unwrap_or(0).checked_mul(10)?.checked_add(d)?);
                if num? > 100_000_000 {
                    return None;
                }
            }
            'T' => {
                if in_time || num.is_some() {
                    return None;
                }
                in_time = true;
            }
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n = num.take()?;
                let unit = match (c, in_time) {
                    ('W', false) => 7 * 86_400,
                    ('D', false) => 86_400,
                    ('H', true) => 3_600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
                total = total.checked_add(n.checked_mul(unit)?)?;
                any = true;
            }
            _ => return None,
        }
    }
    if num.is_some() || !any {
        return None;
    }
    Some(Duration::seconds(if neg { -total } else { total }))
}

fn text(c: &Component, name: &str) -> Option<String> {
    c.prop(name)
        .map(|p| unescape_text(&p.value))
        .filter(|s| !s.trim().is_empty())
}

fn rrule_value(c: &Component, warnings: &mut Vec<String>, what: &str) -> Option<String> {
    let mut rules = c.props_named("RRULE");
    let first = rules.next()?;
    if rules.next().is_some() {
        warnings.push(format!("{what}: only the first RRULE is kept."));
    }
    let v = first.value.trim();
    let v = v.strip_prefix("RRULE:").unwrap_or(v).to_ascii_uppercase();
    if v.is_empty()
        || v.len() > 1000
        || !v
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "=;,:+-".contains(ch))
    {
        warnings.push(format!("{what}: invalid RRULE ignored."));
        return None;
    }
    Some(v)
}

fn categories(c: &Component) -> Vec<String> {
    c.props_named("CATEGORIES")
        .flat_map(|p| split_text_list(&p.value))
        .take(100)
        .collect()
}

fn vtimezone_info(c: &Component) -> (Option<String>, VTimezoneInfo) {
    let tzid = c.prop("TZID").map(|p| p.value.trim().to_string());
    let lic_location = c.prop("X-LIC-LOCATION").map(|p| p.value.trim().to_string());
    // Latest STANDARD observance (by DTSTART string, which sorts chronologically).
    let standard_offset = c
        .children
        .iter()
        .filter(|o| o.name == "STANDARD")
        .filter_map(|o| {
            let start = o
                .prop("DTSTART")
                .map(|p| p.value.clone())
                .unwrap_or_default();
            let off = o
                .prop("TZOFFSETTO")
                .and_then(|p| parse_utc_offset(&p.value))?;
            Some((start, off))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, off)| off)
        .or_else(|| {
            c.children.iter().find_map(|o| {
                o.prop("TZOFFSETTO")
                    .and_then(|p| parse_utc_offset(&p.value))
            })
        });
    (
        tzid,
        VTimezoneInfo {
            lic_location,
            standard_offset,
        },
    )
}

fn event_from(
    c: &Component,
    vtz: &HashMap<String, VTimezoneInfo>,
    idx: usize,
    warnings: &mut Vec<String>,
) -> IcsEvent {
    const LIST_CAP: usize = 10_000;
    let mut uid = text(c, "UID").unwrap_or_default();
    if uid.is_empty() {
        uid = format!("emp-missing-uid-{idx}");
        warnings.push(format!("Event {} has no UID; one was generated.", idx + 1));
    }
    let what = format!("Event {uid}");
    let mut rdates = Vec::new();
    for p in c.props_named("RDATE") {
        parse_dt_list(p, vtz, &mut rdates, LIST_CAP);
    }
    let mut exdates = Vec::new();
    for p in c.props_named("EXDATE") {
        parse_dt_list(p, vtz, &mut exdates, LIST_CAP);
    }
    let start = c.prop("DTSTART").and_then(|p| parse_dt_prop(p, vtz));
    if start.is_none() {
        warnings.push(format!("{what} has no valid DTSTART."));
    }
    let duration = c.prop("DURATION").and_then(|p| parse_duration(&p.value));
    let mut end = c.prop("DTEND").and_then(|p| parse_dt_prop(p, vtz));
    if let (Some(s), Some(e)) = (&start, &end)
        && e.to_utc(None) < s.to_utc(None)
    {
        warnings.push(format!("{what} ends before it starts; end ignored."));
        end = None;
    }
    for p in c.props_named("DTSTART").chain(c.props_named("DTEND")) {
        if let Some(IcsDateTime::Zoned {
            zone: ZoneRef::Unknown,
            tzid,
            ..
        }) = parse_dt_prop(p, vtz)
        {
            warnings.push(format!(
                "{what}: unknown time zone \"{tzid}\" treated as floating time."
            ));
            break;
        }
    }
    IcsEvent {
        summary: text(c, "SUMMARY"),
        description: text(c, "DESCRIPTION"),
        location: text(c, "LOCATION"),
        url: text(c, "URL"),
        status: text(c, "STATUS").map(|s| s.to_ascii_uppercase()),
        transp: text(c, "TRANSP").map(|s| s.to_ascii_uppercase()),
        categories: categories(c),
        color: text(c, "COLOR"),
        start,
        end,
        duration,
        rrule: rrule_value(c, warnings, &what),
        rdates,
        exdates,
        recurrence_id: c.prop("RECURRENCE-ID").and_then(|p| parse_dt_prop(p, vtz)),
        sequence: c.prop("SEQUENCE").and_then(|p| p.value.trim().parse().ok()),
        dtstamp: c.prop("DTSTAMP").and_then(parse_utc_stamp),
        last_modified: c.prop("LAST-MODIFIED").and_then(parse_utc_stamp),
        uid,
    }
}

fn todo_from(
    c: &Component,
    vtz: &HashMap<String, VTimezoneInfo>,
    idx: usize,
    warnings: &mut Vec<String>,
) -> IcsTodo {
    let mut uid = text(c, "UID").unwrap_or_default();
    if uid.is_empty() {
        uid = format!("emp-missing-uid-todo-{idx}");
    }
    let what = format!("To-do {uid}");
    IcsTodo {
        summary: text(c, "SUMMARY"),
        description: text(c, "DESCRIPTION"),
        status: text(c, "STATUS").map(|s| s.to_ascii_uppercase()),
        priority: c
            .prop("PRIORITY")
            .and_then(|p| p.value.trim().parse::<u8>().ok())
            .filter(|p| *p <= 9),
        percent_complete: c
            .prop("PERCENT-COMPLETE")
            .and_then(|p| p.value.trim().parse::<u8>().ok())
            .filter(|p| *p <= 100),
        start: c.prop("DTSTART").and_then(|p| parse_dt_prop(p, vtz)),
        due: c.prop("DUE").and_then(|p| parse_dt_prop(p, vtz)),
        completed: c.prop("COMPLETED").and_then(parse_utc_stamp),
        rrule: rrule_value(c, warnings, &what),
        categories: categories(c),
        url: text(c, "URL"),
        uid,
    }
}

/// Parse iCalendar bytes. Fails only on limit violations or when no `VCALENDAR` is present;
/// everything else becomes a warning.
pub fn parse_ics(input: &[u8], limits: &IcsLimits) -> Result<IcsCalendar> {
    if input.len() > limits.max_bytes {
        return Err(IntegrationError::LimitExceeded(format!(
            "calendar file exceeds {} bytes",
            limits.max_bytes
        )));
    }
    let input = input.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(input);
    let mut warnings = Vec::new();
    let decoded = match std::str::from_utf8(input) {
        Ok(s) => std::borrow::Cow::Borrowed(s),
        Err(_) => {
            warnings.push("The file is not valid UTF-8; invalid bytes were replaced.".to_string());
            String::from_utf8_lossy(input)
        }
    };
    let lines = unfold(&decoded, limits.max_line)?;
    let roots = build_tree(&lines, limits, &mut warnings)?;
    let calendars: Vec<&Component> = roots.iter().filter(|c| c.name == "VCALENDAR").collect();
    if calendars.is_empty() {
        return Err(IntegrationError::Invalid(
            "not an iCalendar file (no VCALENDAR)".into(),
        ));
    }
    let mut cal = IcsCalendar::default();
    let mut vtz: HashMap<String, VTimezoneInfo> = HashMap::new();
    for vc in &calendars {
        for tzc in vc.children.iter().filter(|c| c.name == "VTIMEZONE") {
            if let (Some(id), info) = vtimezone_info(tzc) {
                cal.timezones.push(id.clone());
                vtz.insert(id, info);
            }
        }
    }
    for vc in calendars {
        cal.prodid = cal.prodid.or_else(|| text(vc, "PRODID"));
        cal.name = cal
            .name
            .or_else(|| text(vc, "X-WR-CALNAME"))
            .or_else(|| text(vc, "NAME"));
        cal.default_tz = cal.default_tz.or_else(|| text(vc, "X-WR-TIMEZONE"));
        cal.method = cal.method.or_else(|| text(vc, "METHOD"));
        if let Some(v) = vc.prop("VERSION")
            && v.value.trim() != "2.0"
        {
            warnings.push(format!("Unexpected iCalendar VERSION {}.", v.value.trim()));
        }
        for c in &vc.children {
            match c.name.as_str() {
                "VEVENT" => {
                    let idx = cal.events.len();
                    cal.events.push(event_from(c, &vtz, idx, &mut warnings));
                }
                "VTODO" => {
                    let idx = cal.todos.len();
                    cal.todos.push(todo_from(c, &vtz, idx, &mut warnings));
                }
                _ => {}
            }
        }
    }
    warnings.dedup();
    cal.warnings = warnings;
    Ok(cal)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//Example//Cal//EN\r\n\
X-WR-CALNAME:Team\r\n\
X-WR-TIMEZONE:Europe/Berlin\r\n\
BEGIN:VTIMEZONE\r\n\
TZID:Custom Berlin\r\n\
X-LIC-LOCATION:Europe/Berlin\r\n\
BEGIN:STANDARD\r\n\
DTSTART:19701025T030000\r\n\
TZOFFSETFROM:+0200\r\n\
TZOFFSETTO:+0100\r\n\
END:STANDARD\r\n\
END:VTIMEZONE\r\n\
BEGIN:VEVENT\r\n\
UID:evt-1@example.com\r\n\
DTSTAMP:20261120T100000Z\r\n\
DTSTART;TZID=Custom Berlin:20261201T090000\r\n\
DTEND;TZID=Custom Berlin:20261201T100000\r\n\
SUMMARY:Weekly sync\\, team\r\n\
DESCRIPTION:Line one\\nLine two with a very long description that is folded acr\r\n oss lines\r\n\
LOCATION:Room 1\\; Floor 2\r\n\
CATEGORIES:Work,Meetings\\, misc\r\n\
RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10\r\n\
EXDATE;TZID=Custom Berlin:20261208T090000,20261215T090000\r\n\
BEGIN:VALARM\r\n\
ACTION:DISPLAY\r\n\
TRIGGER:-PT15M\r\n\
END:VALARM\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:holiday\r\n\
DTSTART;VALUE=DATE:20261225\r\n\
SUMMARY:Christmas\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:utc\r\n\
DTSTART:20261203T150000Z\r\n\
DURATION:PT1H30M\r\n\
END:VEVENT\r\n\
BEGIN:VTODO\r\n\
UID:todo-1\r\n\
SUMMARY:File taxes\r\n\
DUE;VALUE=DATE:20270415\r\n\
PRIORITY:1\r\n\
STATUS:needs-action\r\n\
END:VTODO\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn parses_sample_calendar() {
        let cal = parse_ics(SAMPLE.as_bytes(), &IcsLimits::default()).unwrap();
        assert_eq!(cal.name.as_deref(), Some("Team"));
        assert_eq!(cal.default_tz.as_deref(), Some("Europe/Berlin"));
        assert_eq!(cal.timezones, vec!["Custom Berlin"]);
        assert_eq!(cal.events.len(), 3);
        let e = &cal.events[0];
        assert_eq!(e.summary.as_deref(), Some("Weekly sync, team"));
        assert_eq!(
            e.description.as_deref(),
            Some("Line one\nLine two with a very long description that is folded across lines")
        );
        assert_eq!(e.location.as_deref(), Some("Room 1; Floor 2"));
        assert_eq!(e.categories, vec!["Work", "Meetings, misc"]);
        assert_eq!(e.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=10"));
        assert_eq!(e.exdates.len(), 2);
        match e.start.as_ref().unwrap() {
            IcsDateTime::Zoned { zone, tzid, .. } => {
                assert_eq!(zone, &ZoneRef::Iana(chrono_tz::Europe::Berlin));
                assert_eq!(tzid, "Custom Berlin");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            e.start.as_ref().unwrap().to_utc(None).to_rfc3339(),
            "2026-12-01T08:00:00+00:00"
        );
        assert_eq!(
            e.start.as_ref().unwrap().to_ipc_string(None),
            "2026-12-01T09:00:00+01:00"
        );
        assert!(e.dtstamp.is_some());

        let h = &cal.events[1];
        assert!(h.all_day());
        assert_eq!(
            h.effective_end(),
            Some(IcsDateTime::Date(
                NaiveDate::from_ymd_opt(2026, 12, 26).unwrap()
            ))
        );
        assert_eq!(h.start.as_ref().unwrap().to_ipc_string(None), "2026-12-25");

        let u = &cal.events[2];
        assert_eq!(u.length(), Duration::minutes(90));

        let t = &cal.todos[0];
        assert_eq!(t.priority, Some(1));
        assert_eq!(t.status.as_deref(), Some("NEEDS-ACTION"));
        assert!(matches!(t.due, Some(IcsDateTime::Date(_))));
        assert!(cal.warnings.is_empty(), "{:?}", cal.warnings);
    }

    #[test]
    fn content_line_params() {
        let p = parse_content_line(
            "ATTENDEE;CN=\"Doe, Jane\";ROLE=REQ-PARTICIPANT;X-A=a,b:mailto:jane@example.com",
        )
        .unwrap();
        assert_eq!(p.name, "ATTENDEE");
        assert_eq!(p.param("CN"), Some("Doe, Jane"));
        assert_eq!(p.params[2].1, vec!["a", "b"]);
        assert_eq!(p.value, "mailto:jane@example.com");
        assert!(parse_content_line("NOCOLON").is_none());
        assert!(parse_content_line(";X:1").is_none());
        assert!(parse_content_line("A;B=\"unterminated:1").is_none());
        assert!(parse_content_line("A;=x:1").is_none());
        assert_eq!(
            parse_content_line("x-custom:Value").unwrap().name,
            "X-CUSTOM"
        );
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("P1W"), Some(Duration::days(7)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
        assert_eq!(parse_duration("P1DT12H"), Some(Duration::hours(36)));
        for bad in ["P", "PT", "1H", "P1H", "PT1D", "P1", "PTH", "P99999999999D"] {
            assert_eq!(parse_duration(bad), None, "{bad}");
        }
    }

    #[test]
    fn tolerates_garbage_and_lf_endings() {
        let input = "BEGIN:VCALENDAR\nVERSION:2.0\ngarbage line\nBEGIN:VEVENT\nDTSTART:20260101\nSUMMARY:No uid\nEND:VEVENT\nEND:BOGUS\nBEGIN:VEVENT\nUID:x\nDTSTART:notadate\nDTEND:20200101T000000Z\n";
        let cal = parse_ics(input.as_bytes(), &IcsLimits::default()).unwrap();
        assert_eq!(cal.events.len(), 2);
        assert!(cal.events[0].uid.starts_with("emp-missing-uid"));
        assert!(cal.events[1].start.is_none());
        assert!(cal.warnings.iter().any(|w| w.contains("malformed")));
        assert!(cal.warnings.iter().any(|w| w.contains("not terminated")));
        assert!(cal.warnings.iter().any(|w| w.contains("unmatched END")));
    }

    #[test]
    fn rejects_non_calendars_and_enforces_limits() {
        assert!(parse_ics(b"hello", &IcsLimits::default()).is_err());
        let limits = IcsLimits {
            max_bytes: 10,
            ..IcsLimits::default()
        };
        assert!(matches!(
            parse_ics(SAMPLE.as_bytes(), &limits).unwrap_err(),
            IntegrationError::LimitExceeded(_)
        ));
        let deep = "BEGIN:VCALENDAR\n".to_string() + &"BEGIN:X\n".repeat(50);
        assert!(matches!(
            parse_ics(deep.as_bytes(), &IcsLimits::default()).unwrap_err(),
            IntegrationError::LimitExceeded(_)
        ));
        let many = format!(
            "BEGIN:VCALENDAR\n{}END:VCALENDAR\n",
            "BEGIN:VEVENT\nEND:VEVENT\n".repeat(20)
        );
        let limits = IcsLimits {
            max_components: 10,
            ..IcsLimits::default()
        };
        assert!(parse_ics(many.as_bytes(), &limits).is_err());
        let long = format!("BEGIN:VCALENDAR\nX:{}\nEND:VCALENDAR\n", "a".repeat(2000));
        let limits = IcsLimits {
            max_line: 1000,
            ..IcsLimits::default()
        };
        assert!(parse_ics(long.as_bytes(), &limits).is_err());
    }

    #[test]
    fn unknown_tz_warns_and_floats() {
        let input = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART;TZID=Mars/Olympus:20260101T100000\nEND:VEVENT\nEND:VCALENDAR\n";
        let cal = parse_ics(input.as_bytes(), &IcsLimits::default()).unwrap();
        assert!(cal.warnings.iter().any(|w| w.contains("unknown time zone")));
        let s = cal.events[0].start.as_ref().unwrap();
        assert_eq!(s.to_utc(None).to_rfc3339(), "2026-01-01T10:00:00+00:00");
    }

    #[test]
    fn hostile_inputs_do_not_panic() {
        let cases: Vec<Vec<u8>> = vec![
            b"BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:2026\nDTSTART:20261301T250000\nRRULE:FREQ=DAILY;\x01\nDURATION:P\xff\nEND:VEVENT\nEND:VCALENDAR".to_vec(),
            b"\xEF\xBB\xBFBEGIN:VCALENDAR\r\n \r\n\t\r\nEND:VCALENDAR".to_vec(),
            b"BEGIN:VCALENDAR\nSUMMARY:\\".to_vec(),
            vec![0xff; 100],
            b"BEGIN:VCALENDAR\nBEGIN:VEVENT\nRDATE;VALUE=PERIOD:19970101T180000Z/PT5H30M,bad\nEXDATE:,,,\nEND:VEVENT\nEND:VCALENDAR".to_vec(),
        ];
        for c in cases {
            let _ = parse_ics(&c, &IcsLimits::default());
        }
    }
}
