//! Statement date parsing and format detection (§15.2 Dates).
//!
//! Formats are tried in order: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, `DD.MM.YYYY`, `D MMM YYYY`,
//! `MM/DD'YY` (QIF) and Excel serial numbers. The chosen format is the first under which every value parses
//! and the dates are monotonic (up to 5% of rows out of order). When both `MM/DD/YYYY` and `DD/MM/YYYY`
//! fit (every day value ≤ 12) the caller must ask the user once.

use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};

/// A supported date format. Serialised with the SPEC tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DateFormat {
    /// ISO; also `YYYY/MM/DD` and `YYYYMMDD`.
    #[serde(rename = "YYYY-MM-DD")]
    Ymd,
    /// US; also 2-digit years and `-` separators.
    #[serde(rename = "MM/DD/YYYY")]
    Mdy,
    /// Day first; also 2-digit years and `-` separators.
    #[serde(rename = "DD/MM/YYYY")]
    Dmy,
    /// Dotted day first (German style).
    #[serde(rename = "DD.MM.YYYY")]
    DmyDot,
    /// Day, month name, year (`3 Mar 2026`, `03-Mar-2026`, `3 March 2026`).
    #[serde(rename = "D MMM YYYY")]
    DMonY,
    /// Quicken: `MM/DD'YY` (apostrophe means 20YY); `MM/DD/YY` also accepted.
    #[serde(rename = "MM/DD'YY")]
    QifMdy,
    /// Excel 1900-system serial day number.
    #[serde(rename = "excel")]
    ExcelSerial,
}

/// The SPEC detection order.
pub const DETECTION_ORDER: [DateFormat; 7] = [
    DateFormat::Ymd,
    DateFormat::Mdy,
    DateFormat::Dmy,
    DateFormat::DmyDot,
    DateFormat::DMonY,
    DateFormat::QifMdy,
    DateFormat::ExcelSerial,
];

fn year4(y: &str) -> Option<i32> {
    let v: i32 = y.parse().ok()?;
    match y.len() {
        4 => Some(v),
        2 => Some(if v < 70 { 2000 + v } else { 1900 + v }),
        _ => None,
    }
}

fn num(s: &str, max_len: usize) -> Option<u32> {
    if s.is_empty() || s.len() > max_len || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn month_name(s: &str) -> Option<u32> {
    const M: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let l = s.trim_end_matches('.').to_ascii_lowercase();
    if l.len() < 3 {
        return None;
    }
    let p = M.iter().position(|m| l.starts_with(m))? as u32 + 1;
    // Accept "sept" and full names; reject random words starting with a month prefix beyond the full name.
    const FULL: [&str; 12] = [
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
    (l.len() == 3 || FULL[p as usize - 1].starts_with(&l) || l == "sept").then_some(p)
}

/// Strips a trailing time component (`2026-01-05 13:45`, `2026-01-05T13:45:00Z`, `1/5/2026 1:45 PM`).
fn strip_time(s: &str) -> &str {
    let s = s.trim();
    if s.len() > 10
        && s.as_bytes().get(10) == Some(&b'T')
        && s.as_bytes()[..4].iter().all(u8::is_ascii_digit)
    {
        return &s[..10];
    }
    if let Some(i) = s.find(':') {
        // Cut at the last whitespace before the first colon.
        if let Some(sp) = s[..i].rfind(char::is_whitespace) {
            return s[..sp].trim_end();
        }
    }
    s
}

/// Parses `s` under `fmt`. Returns `None` when it does not fit.
pub fn parse_date(s: &str, fmt: DateFormat) -> Option<NaiveDate> {
    let s = strip_time(s).trim_matches('"');
    if s.is_empty() || s.len() > 40 {
        return None;
    }
    match fmt {
        DateFormat::Ymd => {
            if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
                return NaiveDate::from_ymd_opt(
                    s[..4].parse().ok()?,
                    num(&s[4..6], 2)?,
                    num(&s[6..8], 2)?,
                );
            }
            let parts: Vec<&str> = s.split(['-', '/']).collect();
            if parts.len() != 3 || parts[0].len() != 4 {
                return None;
            }
            NaiveDate::from_ymd_opt(parts[0].parse().ok()?, num(parts[1], 2)?, num(parts[2], 2)?)
        }
        DateFormat::Mdy | DateFormat::Dmy => {
            let parts: Vec<&str> = s.split(['/', '-']).collect();
            if parts.len() != 3 || parts[2].len() == 3 || parts[0].len() > 2 {
                return None;
            }
            let (a, b) = (num(parts[0], 2)?, num(parts[1], 2)?);
            let y = year4(parts[2])?;
            let (m, d) = if fmt == DateFormat::Mdy {
                (a, b)
            } else {
                (b, a)
            };
            NaiveDate::from_ymd_opt(y, m, d)
        }
        DateFormat::DmyDot => {
            let parts: Vec<&str> = s.trim_end_matches('.').split('.').collect();
            if parts.len() != 3 {
                return None;
            }
            NaiveDate::from_ymd_opt(year4(parts[2])?, num(parts[1], 2)?, num(parts[0], 2)?)
        }
        DateFormat::DMonY => {
            let parts: Vec<&str> = s.split([' ', '-', ',']).filter(|p| !p.is_empty()).collect();
            if parts.len() != 3 {
                return None;
            }
            NaiveDate::from_ymd_opt(year4(parts[2])?, month_name(parts[1])?, num(parts[0], 2)?)
        }
        DateFormat::QifMdy => {
            let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
            let (md, y) = if let Some((md, y)) = compact.split_once('\'') {
                let yy: i32 = num(y, 2)? as i32;
                (md.to_string(), 2000 + yy)
            } else {
                let (md, y) = compact.rsplit_once(['/', '-'])?;
                (md.to_string(), year4(y)?)
            };
            let (m, d) = md.split_once(['/', '-'])?;
            NaiveDate::from_ymd_opt(y, num(m, 2)?, num(d, 2)?)
        }
        DateFormat::ExcelSerial => {
            let v: f64 = s.parse().ok()?;
            if !v.is_finite() || !(1.0..2_958_466.0).contains(&v) || s.contains(['e', 'E']) {
                return None;
            }
            let days = v.floor() as i64;
            // 1900 system with the Lotus leap-year bug: serial 60 is the fictitious 1900-02-29.
            if days == 60 {
                return None;
            }
            let base = NaiveDate::from_ymd_opt(1899, 12, 31)?;
            base.checked_add_signed(Duration::days(if days > 60 { days - 1 } else { days }))
        }
    }
}

/// Outcome of [`detect`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateDetection {
    /// Best format (first fitting in SPEC order), if any fits.
    pub format: Option<DateFormat>,
    /// When non-empty, the user must choose among these (MM/DD vs DD/MM).
    pub ambiguous: Vec<DateFormat>,
}

fn monotonic_enough(dates: &[NaiveDate]) -> bool {
    if dates.len() < 3 {
        return true;
    }
    let pairs = dates.len() - 1;
    let down = dates.windows(2).filter(|w| w[1] < w[0]).count();
    let up = dates.windows(2).filter(|w| w[1] > w[0]).count();
    // Allowed disorder: 5% of rows, at least one row once there are 20+ rows.
    let allowed = pairs * 5 / 100;
    down.min(up) <= allowed
}

/// Detects the date format of a column. Empty values are ignored.
pub fn detect<'a, I: IntoIterator<Item = &'a str>>(
    values: I,
    candidates: &[DateFormat],
) -> DateDetection {
    let vals: Vec<&str> = values
        .into_iter()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect();
    if vals.is_empty() {
        return DateDetection {
            format: None,
            ambiguous: Vec::new(),
        };
    }
    let fits: Vec<DateFormat> = candidates
        .iter()
        .copied()
        .filter(|f| {
            let parsed: Option<Vec<NaiveDate>> = vals.iter().map(|v| parse_date(v, *f)).collect();
            parsed.is_some_and(|p| monotonic_enough(&p))
        })
        .collect();
    let ambiguous = if fits.contains(&DateFormat::Mdy) && fits.contains(&DateFormat::Dmy) {
        // Identical results (day == month everywhere) are not really ambiguous.
        let same = vals
            .iter()
            .all(|v| parse_date(v, DateFormat::Mdy) == parse_date(v, DateFormat::Dmy));
        if same {
            Vec::new()
        } else {
            vec![DateFormat::Mdy, DateFormat::Dmy]
        }
    } else {
        Vec::new()
    };
    DateDetection {
        format: fits.first().copied(),
        ambiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i32, m: u32, d: u32) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(y, m, d)
    }

    #[test]
    fn parse_each() {
        assert_eq!(parse_date("2026-03-05", DateFormat::Ymd), ymd(2026, 3, 5));
        assert_eq!(parse_date("20260305", DateFormat::Ymd), ymd(2026, 3, 5));
        assert_eq!(
            parse_date("2026-03-05T10:00:00Z", DateFormat::Ymd),
            ymd(2026, 3, 5)
        );
        assert_eq!(parse_date("03/05/2026", DateFormat::Mdy), ymd(2026, 3, 5));
        assert_eq!(
            parse_date("3/5/26 1:45 PM", DateFormat::Mdy),
            ymd(2026, 3, 5)
        );
        assert_eq!(parse_date("03/05/2026", DateFormat::Dmy), ymd(2026, 5, 3));
        assert_eq!(
            parse_date("05.03.2026", DateFormat::DmyDot),
            ymd(2026, 3, 5)
        );
        assert_eq!(parse_date("5 Mar 2026", DateFormat::DMonY), ymd(2026, 3, 5));
        assert_eq!(
            parse_date("05-March-2026", DateFormat::DMonY),
            ymd(2026, 3, 5)
        );
        assert_eq!(parse_date("3/ 5'26", DateFormat::QifMdy), ymd(2026, 3, 5));
        assert_eq!(
            parse_date("03/05/1999", DateFormat::QifMdy),
            ymd(1999, 3, 5)
        );
        assert_eq!(
            parse_date("46086", DateFormat::ExcelSerial),
            ymd(2026, 3, 5)
        );
        assert_eq!(parse_date("1", DateFormat::ExcelSerial), ymd(1900, 1, 1));
        assert_eq!(parse_date("61", DateFormat::ExcelSerial), ymd(1900, 3, 1));
        assert_eq!(parse_date("13/13/2026", DateFormat::Mdy), None);
        assert_eq!(parse_date("2026-02-30", DateFormat::Ymd), None);
        assert_eq!(parse_date("5 Marchy 2026", DateFormat::DMonY), None);
    }

    #[test]
    fn detection() {
        let us = ["01/05/2026", "01/13/2026", "01/20/2026"];
        assert_eq!(
            detect(us, &DETECTION_ORDER),
            DateDetection {
                format: Some(DateFormat::Mdy),
                ambiguous: vec![]
            }
        );
        let eu = ["05/01/2026", "13/01/2026", "20/01/2026"];
        assert_eq!(detect(eu, &DETECTION_ORDER).format, Some(DateFormat::Dmy));
        let amb = ["01/02/2026", "02/03/2026", "03/04/2026"];
        let d = detect(amb, &DETECTION_ORDER);
        assert_eq!(d.format, Some(DateFormat::Mdy));
        assert_eq!(d.ambiguous, vec![DateFormat::Mdy, DateFormat::Dmy]);
        assert_eq!(detect(["2026-01-01", "x"], &DETECTION_ORDER).format, None);
        assert_eq!(
            detect(["46086", "46087"], &DETECTION_ORDER).format,
            Some(DateFormat::ExcelSerial)
        );
    }

    #[test]
    fn monotonic_rule_breaks_ties() {
        // Under MM/DD these go 01-02, 01-03, 01-04, ... (monotonic); under DD/MM they jump between months.
        let v: Vec<String> = (1..=3)
            .flat_map(|a| (1..=12).map(move |b| format!("{a:02}/{b:02}/2026")))
            .collect();
        let refs: Vec<&str> = v.iter().map(String::as_str).collect();
        let d = detect(refs, &DETECTION_ORDER);
        assert_eq!(d.format, Some(DateFormat::Mdy));
        assert!(d.ambiguous.is_empty(), "DD/MM is not monotonic here");
        // Descending order is fine too.
        assert_eq!(
            detect(["2026-03-01", "2026-02-01", "2026-01-01"], &DETECTION_ORDER).format,
            Some(DateFormat::Ymd)
        );
    }
}
