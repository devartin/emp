//! `TZID` resolution and local-time conversion.

use std::collections::HashMap;

use chrono::{DateTime, Duration, FixedOffset, NaiveDateTime, TimeZone, Utc};

/// A resolved `TZID`.
#[derive(Debug, Clone, PartialEq)]
pub enum ZoneRef {
    /// An IANA zone.
    Iana(chrono_tz::Tz),
    /// A fixed offset derived from the file's `VTIMEZONE` (no DST rules).
    Fixed(FixedOffset),
    /// Could not be resolved; treated like floating time.
    Unknown,
}

/// What a `VTIMEZONE` told us.
#[derive(Debug, Clone, Default)]
pub(crate) struct VTimezoneInfo {
    pub(crate) lic_location: Option<String>,
    /// `TZOFFSETTO` of the latest `STANDARD` observance (seconds east).
    pub(crate) standard_offset: Option<i32>,
}

/// Common Windows zone names (CLDR windowsZones, territory 001).
const WINDOWS: &[(&str, &str)] = &[
    ("Dateline Standard Time", "Etc/GMT+12"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("Pacific Standard Time (Mexico)", "America/Tijuana"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time", "America/Denver"),
    ("Central America Standard Time", "America/Guatemala"),
    ("Central Standard Time", "America/Chicago"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("Canada Central Standard Time", "America/Regina"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Eastern Standard Time", "America/New_York"),
    ("US Eastern Standard Time", "America/Indiana/Indianapolis"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Venezuela Standard Time", "America/Caracas"),
    ("SA Western Standard Time", "America/La_Paz"),
    ("Pacific SA Standard Time", "America/Santiago"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("Argentina Standard Time", "America/Buenos_Aires"),
    ("SA Eastern Standard Time", "America/Cayenne"),
    ("Greenland Standard Time", "America/Godthab"),
    ("UTC", "Etc/UTC"),
    ("Coordinated Universal Time", "Etc/UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("Middle East Standard Time", "Asia/Beirut"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Arabic Standard Time", "Asia/Baghdad"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("E. Africa Standard Time", "Africa/Nairobi"),
    ("Iran Standard Time", "Asia/Tehran"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Afghanistan Standard Time", "Asia/Kabul"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("West Asia Standard Time", "Asia/Tashkent"),
    ("India Standard Time", "Asia/Calcutta"),
    ("Sri Lanka Standard Time", "Asia/Colombo"),
    ("Nepal Standard Time", "Asia/Katmandu"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("Myanmar Standard Time", "Asia/Rangoon"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("W. Australia Standard Time", "Australia/Perth"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("Cen. Australia Standard Time", "Australia/Adelaide"),
    ("AUS Central Standard Time", "Australia/Darwin"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("West Pacific Standard Time", "Pacific/Port_Moresby"),
    ("Tasmania Standard Time", "Australia/Hobart"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("Tonga Standard Time", "Pacific/Tongatapu"),
];

fn parse_iana(s: &str) -> Option<chrono_tz::Tz> {
    match s {
        "UTC" | "GMT" | "Z" | "Etc/UTC" | "Etc/GMT" | "Universal" | "Zulu" => Some(chrono_tz::UTC),
        _ => s.parse::<chrono_tz::Tz>().ok(),
    }
}

/// Resolve a `TZID` (SPEC §17.3): IANA name, Windows name, vendor-prefixed path
/// (`/mozilla.org/20050126_1/America/New_York`), the `VTIMEZONE`'s `X-LIC-LOCATION`, or its
/// standard offset as a fixed zone.
pub fn resolve_tzid(tzid: &str) -> ZoneRef {
    resolve_with(tzid, &HashMap::new())
}

pub(crate) fn resolve_with(tzid: &str, vtimezones: &HashMap<String, VTimezoneInfo>) -> ZoneRef {
    let t = tzid.trim().trim_matches('"');
    if let Some(tz) = parse_iana(t) {
        return ZoneRef::Iana(tz);
    }
    if let Some((_, iana)) = WINDOWS.iter().find(|(w, _)| w.eq_ignore_ascii_case(t))
        && let Some(tz) = parse_iana(iana)
    {
        return ZoneRef::Iana(tz);
    }
    // Vendor prefixes: try the last 3, 2, then 1 path segments.
    let segs: Vec<&str> = t.split('/').filter(|s| !s.is_empty()).collect();
    for n in (1..=3usize).rev() {
        if segs.len() >= n
            && let Some(tz) = parse_iana(&segs[segs.len() - n..].join("/"))
        {
            return ZoneRef::Iana(tz);
        }
    }
    if let Some(info) = vtimezones.get(tzid) {
        if let Some(tz) = info.lic_location.as_deref().and_then(parse_iana) {
            return ZoneRef::Iana(tz);
        }
        if let Some(off) = info.standard_offset.and_then(FixedOffset::east_opt) {
            return ZoneRef::Fixed(off);
        }
    }
    ZoneRef::Unknown
}

/// Wall-clock time in `tz` → UTC. Ambiguous times take the earlier instant; times in a DST
/// gap are shifted forward by the gap (RFC 5545 §3.3.5).
pub(crate) fn local_to_utc(tz: &chrono_tz::Tz, local: &NaiveDateTime) -> DateTime<Utc> {
    match tz.from_local_datetime(local) {
        chrono::LocalResult::Single(d) => d.with_timezone(&Utc),
        chrono::LocalResult::Ambiguous(a, _) => a.with_timezone(&Utc),
        chrono::LocalResult::None => {
            for minutes in [60i64, 30, 120] {
                if let Some(shifted) = local.checked_add_signed(Duration::minutes(minutes))
                    && let Some(d) = tz.from_local_datetime(&shifted).earliest()
                {
                    return d.with_timezone(&Utc);
                }
            }
            Utc.from_utc_datetime(local)
        }
    }
}

/// Parse `±HHMM[SS]` (`TZOFFSETTO`) into seconds east.
pub(crate) fn parse_utc_offset(s: &str) -> Option<i32> {
    let s = s.trim();
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    if !(rest.len() == 4 || rest.len() == 6) || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let h: i32 = rest[0..2].parse().ok()?;
    let m: i32 = rest[2..4].parse().ok()?;
    let sec: i32 = if rest.len() == 6 {
        rest[4..6].parse().ok()?
    } else {
        0
    };
    if h > 23 || m > 59 || sec > 59 {
        return None;
    }
    Some(sign * (h * 3600 + m * 60 + sec))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn resolves_many_spellings() {
        assert_eq!(
            resolve_tzid("America/New_York"),
            ZoneRef::Iana(chrono_tz::America::New_York)
        );
        assert_eq!(
            resolve_tzid("Eastern Standard Time"),
            ZoneRef::Iana(chrono_tz::America::New_York)
        );
        assert_eq!(
            resolve_tzid("/mozilla.org/20050126_1/America/Argentina/Buenos_Aires"),
            ZoneRef::Iana(chrono_tz::America::Argentina::Buenos_Aires)
        );
        assert_eq!(
            resolve_tzid("/softwarestudio.org/Olson_20011030_5/Europe/Berlin"),
            ZoneRef::Iana(chrono_tz::Europe::Berlin)
        );
        assert_eq!(
            resolve_tzid("\"Europe/Paris\""),
            ZoneRef::Iana(chrono_tz::Europe::Paris)
        );
        assert_eq!(resolve_tzid("GMT"), ZoneRef::Iana(chrono_tz::UTC));
        assert_eq!(resolve_tzid("Custom Zone"), ZoneRef::Unknown);
        let mut vt = HashMap::new();
        vt.insert(
            "Custom Zone".to_string(),
            VTimezoneInfo {
                lic_location: None,
                standard_offset: Some(5 * 3600 + 1800),
            },
        );
        assert_eq!(
            resolve_with("Custom Zone", &vt),
            ZoneRef::Fixed(FixedOffset::east_opt(19800).unwrap())
        );
        vt.insert(
            "X".to_string(),
            VTimezoneInfo {
                lic_location: Some("Asia/Tokyo".into()),
                standard_offset: Some(0),
            },
        );
        assert_eq!(
            resolve_with("X", &vt),
            ZoneRef::Iana(chrono_tz::Asia::Tokyo)
        );
    }

    #[test]
    fn dst_gap_and_overlap() {
        let ny = chrono_tz::America::New_York;
        // 2026-03-08 02:30 does not exist in New York → 03:30 EDT = 07:30Z.
        let gap = NaiveDate::from_ymd_opt(2026, 3, 8)
            .unwrap()
            .and_hms_opt(2, 30, 0)
            .unwrap();
        assert_eq!(
            local_to_utc(&ny, &gap).to_rfc3339(),
            "2026-03-08T07:30:00+00:00"
        );
        // 2026-11-01 01:30 is ambiguous → earlier (EDT) = 05:30Z.
        let amb = NaiveDate::from_ymd_opt(2026, 11, 1)
            .unwrap()
            .and_hms_opt(1, 30, 0)
            .unwrap();
        assert_eq!(
            local_to_utc(&ny, &amb).to_rfc3339(),
            "2026-11-01T05:30:00+00:00"
        );
    }

    #[test]
    fn offsets() {
        assert_eq!(parse_utc_offset("-0500"), Some(-18000));
        assert_eq!(parse_utc_offset("+053000"), Some(19800));
        assert_eq!(parse_utc_offset("0500"), None);
        assert_eq!(parse_utc_offset("+2500"), None);
        assert_eq!(parse_utc_offset("+ab00"), None);
    }
}
