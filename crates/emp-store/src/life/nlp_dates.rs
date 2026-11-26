//! Natural-language date parsing (SPEC §15.8). The frontend parses with chrono-node for live chips; this parser
//! validates the result and is authoritative.
//!
//! Supported forms: `today`, `tonight`, `tomorrow`, `yesterday`, weekday names (`fri`, `next fri`, `on friday`),
//! `in 3 days|weeks|months|hours|minutes`, `Dec 3`, `3 Dec`, `December 3 2027`, `12/3`, ISO dates, times
//! (`3pm`, `3:30 pm`, `15:00`, `at 9`, `noon`), `eom` / `eow`, recurrence (`every day|weekday|week|month|year`,
//! `every 2 weeks`, `every monday`, `daily`, `weekly`, …), durations (`for 45m`, `for 1h30m`, `for 2 hours`),
//! `#tags` and priorities `!high|!med|!low`. Everything not recognised stays in [`Parsed::text`].

use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use serde::Serialize;

/// Priority token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Priority {
    High,
    Med,
    Low,
}

/// The parse result.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    /// Remaining text (title) with recognised tokens removed.
    pub text: String,
    /// Date (local).
    pub date: Option<NaiveDate>,
    /// Time of day, when given.
    pub time: Option<NaiveTime>,
    /// RFC 5545 rule (`FREQ=WEEKLY;BYDAY=MO`) for `every …`.
    pub rrule: Option<String>,
    /// Duration in minutes (`for 45m`).
    pub duration_minutes: Option<u32>,
    /// `#tags` (without `#`).
    pub tags: Vec<String>,
    /// `!high|!med|!low`.
    pub priority: Option<Priority>,
}

impl Parsed {
    /// Local date-time (midnight when no time was given).
    #[must_use]
    pub fn datetime(&self) -> Option<NaiveDateTime> {
        Some(self.date?.and_time(self.time.unwrap_or(NaiveTime::MIN)))
    }
}

fn weekday(s: &str) -> Option<Weekday> {
    Some(match s.trim_end_matches(['.', ',']) {
        "mon" | "monday" => Weekday::Mon,
        "tue" | "tues" | "tuesday" => Weekday::Tue,
        "wed" | "weds" | "wednesday" => Weekday::Wed,
        "thu" | "thur" | "thurs" | "thursday" => Weekday::Thu,
        "fri" | "friday" => Weekday::Fri,
        "sat" | "saturday" => Weekday::Sat,
        "sun" | "sunday" => Weekday::Sun,
        _ => return None,
    })
}

fn rr_day(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "MO",
        Weekday::Tue => "TU",
        Weekday::Wed => "WE",
        Weekday::Thu => "TH",
        Weekday::Fri => "FR",
        Weekday::Sat => "SA",
        Weekday::Sun => "SU",
    }
}

fn month(s: &str) -> Option<u32> {
    let s = s.trim_end_matches(['.', ',']);
    const NAMES: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    NAMES
        .iter()
        .position(|n| {
            s.len() >= 3 && n.starts_with(s) || *n == s || (s == "sept" && *n == "september")
        })
        .and_then(|i| u32::try_from(i + 1).ok())
}

fn parse_time(tok: &str, next: Option<&str>) -> Option<(NaiveTime, usize)> {
    let t = tok.trim_end_matches([',', '.']);
    match t {
        "noon" | "midday" => return Some((NaiveTime::from_hms_opt(12, 0, 0)?, 1)),
        "midnight" => return Some((NaiveTime::MIN, 1)),
        _ => {}
    }
    let (body, mut suffix, mut used) = if let Some(b) = t.strip_suffix("am") {
        (b, Some("am"), 1)
    } else if let Some(b) = t.strip_suffix("pm") {
        (b, Some("pm"), 1)
    } else {
        (t, None, 1)
    };
    if suffix.is_none()
        && let Some(n) = next.map(|n| n.trim_end_matches([',', '.']))
        && matches!(n, "am" | "pm" | "a.m" | "p.m")
    {
        suffix = Some(if n.starts_with('a') { "am" } else { "pm" });
        used = 2;
    }
    let (h, m) = match body.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => {
            suffix?;
            (body.parse::<u32>().ok()?, 0)
        }
    };
    let h = match suffix {
        Some("am") if (1..=12).contains(&h) => h % 12,
        Some("pm") if (1..=12).contains(&h) => h % 12 + 12,
        Some(_) => return None,
        None => h,
    };
    Some((NaiveTime::from_hms_opt(h, m, 0)?, used))
}

fn duration_minutes(s: &str) -> Option<u32> {
    // 45m, 2h, 1h30m, 90min
    let s = s.trim_end_matches([',', '.']);
    let mut total = 0u32;
    let mut num = String::new();
    let mut any = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: u32 = num.parse().ok()?;
        num.clear();
        let mut unit = String::from(c);
        while let Some(&c2) = chars.peek() {
            if c2.is_ascii_alphabetic() {
                unit.push(c2);
                chars.next();
            } else {
                break;
            }
        }
        total += match unit.as_str() {
            "h" | "hr" | "hrs" | "hour" | "hours" => n.checked_mul(60)?,
            "m" | "min" | "mins" | "minute" | "minutes" => n,
            _ => return None,
        };
        any = true;
    }
    if !num.is_empty() {
        return None;
    }
    (any && total > 0 && total <= 7 * 24 * 60).then_some(total)
}

fn next_weekday(from: NaiveDate, w: Weekday, strictly_next_week: bool) -> NaiveDate {
    let mut d = from + Duration::days(1);
    while d.weekday() != w {
        d += Duration::days(1);
    }
    if strictly_next_week
        && (d - from).num_days() < 7
        && from.weekday().num_days_from_monday() < w.num_days_from_monday()
    {
        // "next fri" said on a Tuesday means the Friday of next week.
        d += Duration::days(7);
    }
    d
}

/// Parses `input` relative to local `now`.
#[must_use]
pub fn parse(input: &str, now: NaiveDateTime) -> Parsed {
    let today = now.date();
    let raw: Vec<&str> = input.split_whitespace().collect();
    let low: Vec<String> = raw.iter().map(|t| t.to_lowercase()).collect();
    let mut used = vec![false; raw.len()];
    let mut out = Parsed::default();
    let mut i = 0;
    let set_date = |out: &mut Parsed, d: NaiveDate| {
        if out.date.is_none() {
            out.date = Some(d);
        }
    };
    while i < raw.len() {
        let t = low[i].as_str();
        let next = low.get(i + 1).map(String::as_str);
        let next2 = low.get(i + 2).map(String::as_str);
        let take = |n: usize, used: &mut Vec<bool>| {
            for u in used.iter_mut().skip(i).take(n) {
                *u = true;
            }
            n
        };
        // Tags and priorities.
        if let Some(tag) = raw[i].strip_prefix('#').filter(|x| {
            !x.is_empty()
                && x.chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
        }) {
            out.tags.push(tag.to_owned());
            i += take(1, &mut used);
            continue;
        }
        if let Some(p) = t.strip_prefix('!') {
            let pr = match p {
                "high" | "h" | "1" => Some(Priority::High),
                "med" | "medium" | "m" | "2" => Some(Priority::Med),
                "low" | "l" | "3" => Some(Priority::Low),
                _ => None,
            };
            if let Some(pr) = pr {
                out.priority = Some(pr);
                i += take(1, &mut used);
                continue;
            }
        }
        // Durations.
        if t == "for"
            && let Some(n) = next
        {
            if let Some(m) = duration_minutes(n) {
                out.duration_minutes = Some(m);
                i += take(2, &mut used);
                continue;
            }
            if let (Ok(k), Some(u)) = (n.parse::<u32>(), next2)
                && let Some(m) = duration_minutes(&format!("{k}{u}"))
            {
                out.duration_minutes = Some(m);
                i += take(3, &mut used);
                continue;
            }
        }
        // Recurrence.
        if t == "every" || t == "each" {
            let (rule, n) = match (next, next2) {
                (Some("day"), _) => (Some("FREQ=DAILY".to_owned()), 2),
                (Some("weekday" | "weekdays"), _) => {
                    (Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR".to_owned()), 2)
                }
                (Some("weekend" | "weekends"), _) => {
                    (Some("FREQ=WEEKLY;BYDAY=SA,SU".to_owned()), 2)
                }
                (Some("week"), _) => (Some("FREQ=WEEKLY".to_owned()), 2),
                (Some("month"), _) => (Some("FREQ=MONTHLY".to_owned()), 2),
                (Some("year"), _) => (Some("FREQ=YEARLY".to_owned()), 2),
                (Some(w), _) if weekday(w).is_some() => (
                    weekday(w).map(|d| format!("FREQ=WEEKLY;BYDAY={}", rr_day(d))),
                    2,
                ),
                (Some(k), Some(u)) if k.parse::<u32>().is_ok_and(|k| (1..=999).contains(&k)) => {
                    let f = match u.trim_end_matches('s') {
                        "day" => Some("DAILY"),
                        "week" => Some("WEEKLY"),
                        "month" => Some("MONTHLY"),
                        "year" => Some("YEARLY"),
                        _ => None,
                    };
                    (f.map(|f| format!("FREQ={f};INTERVAL={k}")), 3)
                }
                _ => (None, 1),
            };
            if let Some(r) = rule {
                out.rrule = Some(r);
                i += take(n, &mut used);
                continue;
            }
        }
        let freq = match t {
            "daily" => Some("FREQ=DAILY"),
            "weekly" => Some("FREQ=WEEKLY"),
            "monthly" => Some("FREQ=MONTHLY"),
            "yearly" | "annually" => Some("FREQ=YEARLY"),
            _ => None,
        };
        if let Some(f) = freq {
            out.rrule = Some(f.to_owned());
            i += take(1, &mut used);
            continue;
        }
        // Relative days.
        let rel = match t.trim_end_matches([',', '.']) {
            "today" | "tod" => Some(today),
            "tonight" => {
                out.time
                    .get_or_insert(NaiveTime::from_hms_opt(20, 0, 0).unwrap_or(NaiveTime::MIN));
                Some(today)
            }
            "tomorrow" | "tmrw" | "tmr" | "tom" => Some(today + Duration::days(1)),
            "yesterday" => Some(today - Duration::days(1)),
            "eom" => today
                .with_day(1)
                .and_then(|d| d.checked_add_months(Months::new(1)))
                .map(|d| d - Duration::days(1)),
            "eow" => Some(next_weekday(today - Duration::days(1), Weekday::Fri, false)),
            _ => None,
        };
        if let Some(d) = rel {
            set_date(&mut out, d);
            i += take(1, &mut used);
            continue;
        }
        // "in 3 weeks".
        if t == "in"
            && let (Some(n), Some(u)) = (next.and_then(|n| n.parse::<i64>().ok()), next2)
            && (1..=3650).contains(&n)
        {
            let u = u.trim_end_matches([',', '.']).trim_end_matches('s');
            let handled = match u {
                "day" | "d" => Some(today + Duration::days(n)),
                "week" | "wk" | "w" => Some(today + Duration::weeks(n)),
                "month" | "mo" => u32::try_from(n)
                    .ok()
                    .and_then(|n| today.checked_add_months(Months::new(n))),
                "year" | "yr" => u32::try_from(n * 12)
                    .ok()
                    .and_then(|n| today.checked_add_months(Months::new(n))),
                "hour" | "hr" | "h" => {
                    let dt = now + Duration::hours(n);
                    out.time = Some(dt.time());
                    Some(dt.date())
                }
                "minute" | "min" | "m" => {
                    let dt = now + Duration::minutes(n);
                    out.time = Some(dt.time());
                    Some(dt.date())
                }
                _ => None,
            };
            if let Some(d) = handled {
                set_date(&mut out, d);
                i += take(3, &mut used);
                continue;
            }
        }
        // Weekdays: "next fri", "on fri", "fri".
        let (is_next, wtok, n) = match (t, next) {
            ("next", Some(w)) if weekday(w).is_some() => (true, w, 2),
            ("on", Some(w)) if weekday(w).is_some() => (false, w, 2),
            (w, _) if weekday(w).is_some() => (false, w, 1),
            _ => (false, "", 0),
        };
        if n > 0
            && let Some(w) = weekday(wtok)
        {
            set_date(&mut out, next_weekday(today, w, is_next));
            i += take(n, &mut used);
            continue;
        }
        if t == "next" {
            let d = match next {
                Some("week") => Some(next_weekday(today, Weekday::Mon, false)),
                Some("month") => today
                    .with_day(1)
                    .and_then(|d| d.checked_add_months(Months::new(1))),
                Some("year") => NaiveDate::from_ymd_opt(today.year() + 1, 1, 1),
                _ => None,
            };
            if let Some(d) = d {
                set_date(&mut out, d);
                i += take(2, &mut used);
                continue;
            }
        }
        // Month-name dates: "Dec 3", "December 3, 2027", "3 Dec".
        let year_of = |s: Option<&str>| {
            s.and_then(|y| y.trim_end_matches(',').parse::<i32>().ok())
                .filter(|y| (1900..=2200).contains(y))
        };
        if let Some(m) = month(t)
            && let Some(day) = next.and_then(|d| {
                d.trim_end_matches([',', '.'])
                    .trim_end_matches("st")
                    .trim_end_matches("nd")
                    .trim_end_matches("rd")
                    .trim_end_matches("th")
                    .parse::<u32>()
                    .ok()
            })
        {
            let y = year_of(next2);
            if let Some(d) = resolve_md(today, y, m, day) {
                set_date(&mut out, d);
                i += take(if y.is_some() { 3 } else { 2 }, &mut used);
                continue;
            }
        }
        if let Ok(day) = t
            .trim_end_matches("st")
            .trim_end_matches("nd")
            .trim_end_matches("rd")
            .trim_end_matches("th")
            .parse::<u32>()
            && let Some(m) = next.and_then(month)
        {
            let y = year_of(next2);
            if let Some(d) = resolve_md(today, y, m, day) {
                set_date(&mut out, d);
                i += take(if y.is_some() { 3 } else { 2 }, &mut used);
                continue;
            }
        }
        // Numeric dates: ISO, m/d, m/d/yyyy.
        if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d") {
            set_date(&mut out, d);
            i += take(1, &mut used);
            continue;
        }
        if let Some((a, b)) = t.split_once('/') {
            let parts: Vec<&str> = std::iter::once(a).chain(b.split('/')).collect();
            let nums: Vec<u32> = parts.iter().filter_map(|p| p.parse().ok()).collect();
            if nums.len() == parts.len() && (2..=3).contains(&nums.len()) {
                let y = nums.get(2).map(|y| {
                    if *y < 100 {
                        2000 + *y as i32
                    } else {
                        *y as i32
                    }
                });
                if let Some(d) = resolve_md(today, y, nums[0], nums[1]) {
                    set_date(&mut out, d);
                    i += take(1, &mut used);
                    continue;
                }
            }
        }
        // Times: "at 9", "3pm", "15:00".
        if t == "at"
            && let Some(n) = next
        {
            let parsed = parse_time(n, next2).or_else(|| {
                n.parse::<u32>()
                    .ok()
                    .filter(|h| *h <= 23)
                    .and_then(|h| NaiveTime::from_hms_opt(if h < 7 { h + 12 } else { h }, 0, 0))
                    .map(|t| (t, 1))
            });
            if let Some((tm, n)) = parsed {
                out.time = Some(tm);
                i += take(1 + n, &mut used);
                continue;
            }
        }
        if let Some((tm, n)) = parse_time(t, next) {
            out.time = Some(tm);
            i += take(n, &mut used);
            continue;
        }
        i += 1;
    }
    if out.time.is_some() && out.date.is_none() {
        // A bare time means the next occurrence of that time.
        let tm = out.time.unwrap_or(NaiveTime::MIN);
        out.date = Some(if today.and_time(tm) > now {
            today
        } else {
            today + Duration::days(1)
        });
    }
    if out.rrule.is_some() && out.date.is_none() {
        out.date = Some(today);
    }
    out.text = raw
        .iter()
        .zip(&used)
        .filter(|(_, u)| !**u)
        .map(|(t, _)| *t)
        .collect::<Vec<_>>()
        .join(" ");
    out
}

/// Month/day (with optional year): without a year, the next such date on or after today.
fn resolve_md(today: NaiveDate, year: Option<i32>, m: u32, d: u32) -> Option<NaiveDate> {
    match year {
        Some(y) => NaiveDate::from_ymd_opt(y, m, d),
        None => {
            let this = NaiveDate::from_ymd_opt(today.year(), m, d)?;
            if this >= today {
                Some(this)
            } else {
                NaiveDate::from_ymd_opt(today.year() + 1, m, d)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> NaiveDateTime {
        // Thursday 2026-11-26 10:00.
        NaiveDate::from_ymd_opt(2026, 11, 26)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap()
    }

    fn d(s: &str) -> Option<NaiveDate> {
        Some(NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap())
    }

    #[test]
    fn relative_and_absolute_dates() {
        assert_eq!(parse("Pay rent today", now()).date, d("2026-11-26"));
        let p = parse("Call mom tomorrow 3pm", now());
        assert_eq!(p.date, d("2026-11-27"));
        assert_eq!(p.time, NaiveTime::from_hms_opt(15, 0, 0));
        assert_eq!(p.text, "Call mom");
        assert_eq!(parse("fri", now()).date, d("2026-11-27"));
        assert_eq!(parse("next fri", now()).date, d("2026-12-04"));
        assert_eq!(parse("next mon", now()).date, d("2026-11-30"));
        assert_eq!(parse("in 3 weeks", now()).date, d("2026-12-17"));
        let p = parse("Dentist Dec 3 3:30 pm", now());
        assert_eq!(p.date, d("2026-12-03"));
        assert_eq!(p.time, NaiveTime::from_hms_opt(15, 30, 0));
        assert_eq!(p.text, "Dentist");
        assert_eq!(parse("3 March", now()).date, d("2027-03-03"));
        assert_eq!(parse("report eom", now()).date, d("2026-11-30"));
        assert_eq!(parse("12/31", now()).date, d("2026-12-31"));
        assert_eq!(parse("at 9", now()).time, NaiveTime::from_hms_opt(9, 0, 0));
        assert_eq!(parse("9am", now()).date, d("2026-11-27"));
    }

    #[test]
    fn recurrence_duration_tags_priority() {
        let p = parse("Standup every weekday 9:30am for 15m #work !high", now());
        assert_eq!(p.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));
        assert_eq!(p.time, NaiveTime::from_hms_opt(9, 30, 0));
        assert_eq!(p.duration_minutes, Some(15));
        assert_eq!(p.tags, vec!["work"]);
        assert_eq!(p.priority, Some(Priority::High));
        assert_eq!(p.text, "Standup");
        assert_eq!(
            parse("water plants every 2 weeks", now()).rrule.as_deref(),
            Some("FREQ=WEEKLY;INTERVAL=2")
        );
        assert_eq!(
            parse("gym every monday", now()).rrule.as_deref(),
            Some("FREQ=WEEKLY;BYDAY=MO")
        );
        assert_eq!(parse("focus for 1h30m", now()).duration_minutes, Some(90));
        assert_eq!(
            parse("focus for 2 hours", now()).duration_minutes,
            Some(120)
        );
        assert_eq!(
            parse("plain text", now()),
            Parsed {
                text: "plain text".into(),
                ..Default::default()
            }
        );
    }
}
