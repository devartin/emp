//! Excel date serials (SPEC §14.1): the 1900 system with the serial-60 leap-year bug, and the 1904 system.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike};

/// Largest valid serial (9999-12-31) in the 1900 system.
pub const MAX_SERIAL_1900: f64 = 2_958_465.0;
/// Days between the 1900 and 1904 epochs.
pub const EPOCH_1904_OFFSET: f64 = 1_462.0;

fn base_1900() -> NaiveDate {
    NaiveDate::from_ymd_opt(1899, 12, 30).unwrap_or_default()
}
fn base_1904() -> NaiveDate {
    NaiveDate::from_ymd_opt(1904, 1, 1).unwrap_or_default()
}

/// Serial of a real calendar date (no normalisation).
pub fn date_to_serial(d: NaiveDate, date1904: bool) -> f64 {
    if date1904 {
        return (d - base_1904()).num_days() as f64;
    }
    let days = (d - base_1900()).num_days();
    // Before 1900-03-01 Excel is off by one because of the fictitious 1900-02-29.
    if days < 61 {
        (days - 1) as f64
    } else {
        days as f64
    }
}

/// Largest valid serial for the date system.
pub fn max_serial(date1904: bool) -> f64 {
    if date1904 {
        MAX_SERIAL_1900 - EPOCH_1904_OFFSET
    } else {
        MAX_SERIAL_1900
    }
}

/// `(year, month, day)` of a serial. Serial 0 is `1900-01-00` and 60 is `1900-02-29` in the 1900 system.
pub fn serial_to_ymd(serial: f64, date1904: bool) -> Option<(i32, u32, u32)> {
    if !serial.is_finite() || serial < 0.0 || serial >= max_serial(date1904) + 1.0 {
        return None;
    }
    let s = serial.floor() as i64;
    if date1904 {
        let d = base_1904() + Duration::days(s);
        return Some((d.year(), d.month(), d.day()));
    }
    match s {
        0 => Some((1900, 1, 0)),
        60 => Some((1900, 2, 29)),
        s if s < 60 => {
            let d = base_1900() + Duration::days(s + 1);
            Some((d.year(), d.month(), d.day()))
        }
        s => {
            let d = base_1900() + Duration::days(s);
            Some((d.year(), d.month(), d.day()))
        }
    }
}

/// Real calendar date of a serial (`None` for serial 0 and the fictitious 1900-02-29 is mapped to 1900-03-01).
pub fn serial_to_date(serial: f64, date1904: bool) -> Option<NaiveDate> {
    let (y, m, d) = serial_to_ymd(serial, date1904)?;
    if d == 0 {
        return NaiveDate::from_ymd_opt(1899, 12, 31);
    }
    NaiveDate::from_ymd_opt(y, m, d).or_else(|| NaiveDate::from_ymd_opt(1900, 3, 1))
}

/// Date and time of a serial.
pub fn serial_to_datetime(serial: f64, date1904: bool) -> Option<NaiveDateTime> {
    let date = serial_to_date(serial, date1904)?;
    let secs = time_fraction_to_seconds(serial);
    let t = NaiveTime::from_num_seconds_from_midnight_opt(secs.min(86_399), 0)?;
    Some(NaiveDateTime::new(date, t))
}

/// Serial of a date and time.
pub fn datetime_to_serial(dt: NaiveDateTime, date1904: bool) -> f64 {
    date_to_serial(dt.date(), date1904) + dt.time().num_seconds_from_midnight() as f64 / 86_400.0
}

/// Seconds after midnight of the fractional part of a serial, rounded to the nearest second.
pub fn time_fraction_to_seconds(serial: f64) -> u32 {
    let frac = serial - serial.floor();
    let secs = (frac * 86_400.0).round() as i64;
    secs.clamp(0, 86_400) as u32
}

/// `(hour, minute, second)` of a serial's fractional part.
pub fn serial_to_hms(serial: f64) -> (u32, u32, u32) {
    let s = time_fraction_to_seconds(serial) % 86_400;
    (s / 3600, (s / 60) % 60, s % 60)
}

/// Excel `DATE(y, m, d)` with month/day overflow normalisation. Years 0–1899 add 1900.
pub fn excel_date(year: f64, month: f64, day: f64, date1904: bool) -> Option<f64> {
    let mut y = year.trunc() as i64;
    if !(0..10_000).contains(&y) {
        return None;
    }
    if y < 1900 {
        y += 1900;
    }
    let total = y * 12 + (month.trunc() as i64 - 1);
    let ny = total.div_euclid(12);
    let nm = total.rem_euclid(12) + 1;
    if !(1..=9999).contains(&ny) {
        return None;
    }
    let first = NaiveDate::from_ymd_opt(ny as i32, nm as u32, 1)?;
    let serial = date_to_serial(first, date1904) + day.trunc() - 1.0;
    if serial < 0.0 || serial > max_serial(date1904) {
        return None;
    }
    Some(serial)
}

/// Excel `TIME(h, m, s)` as a fraction of a day (wrapping past 24 h).
pub fn excel_time(h: f64, m: f64, s: f64) -> Option<f64> {
    let total = h.trunc() * 3600.0 + m.trunc() * 60.0 + s.trunc();
    if total < 0.0 {
        return None;
    }
    Some((total % 86_400.0) / 86_400.0)
}

const MONTHS: [&str; 12] = [
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

/// Month number for a full or 3-letter English month name.
pub fn month_from_name(s: &str) -> Option<u32> {
    let l = s.trim().trim_end_matches('.').to_lowercase();
    if l == "sept" {
        return Some(9);
    }
    MONTHS
        .iter()
        .position(|m| *m == l || (l.len() == 3 && m.starts_with(&l)))
        .map(|i| i as u32 + 1)
}

/// Parse a time-of-day text: `13:45`, `13:45:30`, `1:45 PM`, `1:45:30.5 am`, `3 PM`.
pub fn parse_time_text(s: &str) -> Option<f64> {
    let t = s.trim().to_ascii_lowercase();
    let (body, ampm) = if let Some(b) = t.strip_suffix("am") {
        (b.trim(), Some(false))
    } else if let Some(b) = t.strip_suffix("pm") {
        (b.trim(), Some(true))
    } else if let Some(b) = t.strip_suffix('a') {
        (b.trim(), Some(false))
    } else if let Some(b) = t.strip_suffix('p') {
        (b.trim(), Some(true))
    } else {
        (t.as_str(), None)
    };
    let parts: Vec<&str> = body.split(':').collect();
    if parts.is_empty() || parts.len() > 3 || (parts.len() == 1 && ampm.is_none()) {
        return None;
    }
    let num = |p: &str| -> Option<f64> {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            return None;
        }
        p.parse::<f64>().ok()
    };
    let mut h = num(parts[0])?;
    let m = if parts.len() > 1 { num(parts[1])? } else { 0.0 };
    let sec = if parts.len() > 2 { num(parts[2])? } else { 0.0 };
    if h.fract() != 0.0 || m.fract() != 0.0 || m >= 60.0 || sec >= 60.0 {
        return None;
    }
    if let Some(pm) = ampm {
        if !(1.0..=12.0).contains(&h) {
            return None;
        }
        if h == 12.0 {
            h = 0.0;
        }
        if pm {
            h += 12.0;
        }
    }
    if h >= 10_000.0 {
        return None;
    }
    Some((h * 3600.0 + m * 60.0 + sec) / 86_400.0)
}

fn parse_date_only(s: &str, date1904: bool) -> Option<f64> {
    let t = s.trim();
    let num = |p: &str| -> Option<i64> {
        if p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        p.parse().ok()
    };
    let mk = |y: i64, m: i64, d: i64| -> Option<f64> {
        let y = if (0..100).contains(&y) {
            if y < 30 { 2000 + y } else { 1900 + y }
        } else {
            y
        };
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(1900..=9999).contains(&y) {
            return None;
        }
        if y == 1900 && m == 2 && d == 29 && !date1904 {
            return Some(60.0);
        }
        NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32).map(|nd| date_to_serial(nd, date1904))
    };
    for sep in ['-', '/', '.'] {
        let parts: Vec<&str> = t.split(sep).map(|p| p.trim()).collect();
        if parts.len() == 3 {
            if let (Some(a), Some(b), Some(c)) = (num(parts[0]), num(parts[1]), num(parts[2])) {
                if parts[0].len() == 4 {
                    return mk(a, b, c); // ISO y-m-d
                }
                if sep == '.' {
                    return mk(c, b, a); // d.m.y
                }
                return mk(c, a, b); // US m/d/y
            }
            // 15-Jan-2024 / Jan-15-2024
            if let (Some(d), Some(m), Some(y)) =
                (num(parts[0]), month_from_name(parts[1]), num(parts[2]))
            {
                return mk(y, m as i64, d);
            }
            if let (Some(m), Some(d), Some(y)) =
                (month_from_name(parts[0]), num(parts[1]), num(parts[2]))
            {
                return mk(y, m as i64, d);
            }
        }
    }
    // "Jan 15, 2024", "January 15 2024", "15 Jan 2024"
    let words: Vec<&str> = t.split([' ', ',']).filter(|w| !w.is_empty()).collect();
    if words.len() == 3 {
        if let (Some(m), Some(d), Some(y)) =
            (month_from_name(words[0]), num(words[1]), num(words[2]))
        {
            return mk(y, m as i64, d);
        }
        if let (Some(d), Some(m), Some(y)) =
            (num(words[0]), month_from_name(words[1]), num(words[2]))
        {
            return mk(y, m as i64, d);
        }
    }
    None
}

/// Parse date, time or date-time text into a serial (`"2024-01-15"`, `"1/15/2024 13:45"`, `"2024-01-15T08:00:00"`, `"9:30 AM"`).
pub fn parse_datetime_text(s: &str, date1904: bool) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t.len() > 64 {
        return None;
    }
    if let Some(d) = parse_date_only(t, date1904) {
        return Some(d);
    }
    if let Some(tm) = parse_time_text(t) {
        return Some(tm);
    }
    // date + time separated by 'T' or space
    let t2 = t.trim_end_matches('Z');
    if let Some(idx) = t2.find('T').filter(|i| *i >= 8) {
        let (d, tm) = (&t2[..idx], &t2[idx + 1..]);
        let tm = tm.split(['+']).next().unwrap_or(tm);
        return Some(parse_date_only(d, date1904)? + parse_time_text(tm)?);
    }
    // try splitting at each space from the right
    let bytes: Vec<usize> = t.match_indices(' ').map(|(i, _)| i).collect();
    for &i in bytes.iter().rev() {
        let (d, tm) = (&t[..i], &t[i + 1..]);
        if let (Some(dv), Some(tv)) = (parse_date_only(d, date1904), parse_time_text(tm)) {
            return Some(dv + tv);
        }
    }
    None
}

/// Format a serial as ISO `YYYY-MM-DD` (used by CSV/JSON export of date cells).
pub fn serial_to_iso(serial: f64, date1904: bool) -> Option<String> {
    let (y, m, d) = serial_to_ymd(serial, date1904)?;
    let (h, mi, s) = serial_to_hms(serial);
    if h == 0 && mi == 0 && s == 0 {
        Some(format!("{y:04}-{m:02}-{d:02}"))
    } else {
        Some(format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, dd).unwrap_or_default()
    }

    #[test]
    fn serials_1900() {
        assert_eq!(date_to_serial(d(1900, 1, 1), false), 1.0);
        assert_eq!(date_to_serial(d(1900, 2, 28), false), 59.0);
        assert_eq!(date_to_serial(d(1900, 3, 1), false), 61.0);
        assert_eq!(date_to_serial(d(2024, 1, 15), false), 45306.0);
        assert_eq!(date_to_serial(d(9999, 12, 31), false), MAX_SERIAL_1900);
        assert_eq!(serial_to_ymd(60.0, false), Some((1900, 2, 29)));
        assert_eq!(serial_to_ymd(61.0, false), Some((1900, 3, 1)));
        assert_eq!(serial_to_ymd(59.0, false), Some((1900, 2, 28)));
        assert_eq!(serial_to_ymd(1.0, false), Some((1900, 1, 1)));
        assert_eq!(serial_to_ymd(0.0, false), Some((1900, 1, 0)));
        assert_eq!(serial_to_ymd(45306.75, false), Some((2024, 1, 15)));
        assert_eq!(serial_to_ymd(-1.0, false), None);
    }

    #[test]
    fn serials_1904() {
        assert_eq!(date_to_serial(d(1904, 1, 1), true), 0.0);
        assert_eq!(
            date_to_serial(d(2024, 1, 15), true),
            45306.0 - EPOCH_1904_OFFSET
        );
        assert_eq!(serial_to_ymd(0.0, true), Some((1904, 1, 1)));
    }

    #[test]
    fn excel_date_normalisation() {
        assert_eq!(excel_date(2024.0, 1.0, 15.0, false), Some(45306.0));
        assert_eq!(excel_date(1900.0, 2.0, 29.0, false), Some(60.0));
        assert_eq!(excel_date(1900.0, 3.0, 0.0, false), Some(60.0));
        assert_eq!(
            excel_date(2024.0, 13.0, 1.0, false),
            excel_date(2025.0, 1.0, 1.0, false)
        );
        assert_eq!(
            excel_date(2024.0, 0.0, 1.0, false),
            excel_date(2023.0, 12.0, 1.0, false)
        );
        assert_eq!(
            excel_date(2024.0, 3.0, 0.0, false),
            excel_date(2024.0, 2.0, 29.0, false)
        );
        assert_eq!(excel_date(124.0, 1.0, 15.0, false), Some(45306.0));
        assert_eq!(excel_date(10000.0, 1.0, 1.0, false), None);
        assert_eq!(excel_date(-1.0, 1.0, 1.0, false), None);
    }

    #[test]
    fn text_parsing() {
        assert_eq!(parse_datetime_text("2024-01-15", false), Some(45306.0));
        assert_eq!(parse_datetime_text("1/15/2024", false), Some(45306.0));
        assert_eq!(parse_datetime_text("15-Jan-2024", false), Some(45306.0));
        assert_eq!(parse_datetime_text("Jan 15, 2024", false), Some(45306.0));
        assert_eq!(parse_datetime_text("January 15 2024", false), Some(45306.0));
        assert_eq!(parse_datetime_text("12:00", false), Some(0.5));
        assert_eq!(parse_datetime_text("6:00 PM", false), Some(0.75));
        assert_eq!(parse_datetime_text("12:00 AM", false), Some(0.0));
        assert_eq!(
            parse_datetime_text("2024-01-15 12:00", false),
            Some(45306.5)
        );
        assert_eq!(
            parse_datetime_text("2024-01-15T18:00:00", false),
            Some(45306.75)
        );
        assert_eq!(parse_datetime_text("2024-02-30", false), None);
        assert_eq!(parse_datetime_text("hello", false), None);
        assert_eq!(parse_datetime_text("12", false), None);
    }

    #[test]
    fn time_fns() {
        assert_eq!(excel_time(12.0, 0.0, 0.0), Some(0.5));
        assert_eq!(excel_time(25.0, 0.0, 0.0), Some(1.0 / 24.0));
        assert_eq!(serial_to_hms(0.75), (18, 0, 0));
        assert_eq!(serial_to_iso(45306.0, false).as_deref(), Some("2024-01-15"));
        assert_eq!(month_from_name("Sept"), Some(9));
        assert_eq!(month_from_name("feb"), Some(2));
        assert_eq!(month_from_name("ju"), None);
    }
}
