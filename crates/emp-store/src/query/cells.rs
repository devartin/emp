//! Cell value helpers: projections (plain text, number, date, ids), validation of user writes against the
//! property type (SPEC §8.1), text parsing (imports, conversions) and the Row-dialect value bridge (§14.6).

use std::str::FromStr;

use chrono::{NaiveDate, NaiveDateTime};
use emp_sheets::dialect::{DateVal, RowValue};
use rust_decimal::Decimal;
use serde_json::{Value, json};

use super::config::{HasConfig, RatingConfig, read};
use super::dates::DateCtx;
use super::model::{
    CellValue, ComputedKind, ComputedValue, DateValue, PropType, Property, rich, rich_plain,
};
use crate::{Result, StoreError};

/// Maximum money scale (SPEC §11.1).
pub const MONEY_MAX_SCALE: u32 = 8;
/// Maximum characters of a text cell.
pub const MAX_TEXT_CHARS: usize = 200_000;
/// Maximum ids in a relation / multi-select / files cell.
pub const MAX_LIST: usize = 10_000;

/// Plain text without property context (select values show their ids).
#[must_use]
pub fn plain_text(c: &CellValue) -> String {
    match c {
        CellValue::Text { v } => rich_plain(v),
        CellValue::Number { v } | CellValue::Rating { v } | CellValue::Progress { v } => {
            v.map(fmt_num).unwrap_or_default()
        }
        CellValue::Money { v, .. } => v.clone().unwrap_or_default(),
        CellValue::Select { v } | CellValue::Status { v } => v.clone().unwrap_or_default(),
        CellValue::Multi { v } | CellValue::Relation { v } => v.join(", "),
        CellValue::Date { v } => v.as_ref().map(date_display).unwrap_or_default(),
        CellValue::Check { v } => if *v { "Yes" } else { "No" }.to_owned(),
        CellValue::Url { v } | CellValue::Email { v } | CellValue::Phone { v } => {
            v.clone().unwrap_or_default()
        }
        CellValue::Ticker { v } => v.clone().unwrap_or_default(),
        CellValue::Files { v } => v
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        CellValue::Uid { v } => v.clone(),
        CellValue::Recurrence { v } => v.as_ref().map(|r| r.rrule.clone()).unwrap_or_default(),
        CellValue::Secret { v } => v.as_ref().map(|m| m.masked.clone()).unwrap_or_default(),
        CellValue::Computed { v } => v.display.clone(),
        CellValue::Ts { v } => chrono::DateTime::<chrono::Utc>::from_timestamp_millis(*v)
            .map(|d| d.to_rfc3339())
            .unwrap_or_default(),
    }
}

/// Display text with property context (select options by name).
#[must_use]
pub fn display(c: &CellValue, p: &Property) -> String {
    match c {
        CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) } => {
            super::config::option_name(&p.config, id).unwrap_or_default()
        }
        CellValue::Multi { v } => {
            let opts = p.select_options();
            v.iter()
                .filter_map(|id| opts.iter().find(|o| &o.id == id).map(|o| o.name.clone()))
                .collect::<Vec<_>>()
                .join(", ")
        }
        other => plain_text(other),
    }
}

/// Shortest round-trip formatting of a number (integers without a fraction).
#[must_use]
pub fn fmt_num(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{n:.0}")
    } else {
        let s = format!("{n}");
        if s == "-0" { "0".into() } else { s }
    }
}

fn date_display(d: &DateValue) -> String {
    match &d.end {
        Some(e) => format!("{} → {}", d.start, e),
        None => d.start.clone(),
    }
}

/// `true` for empty values (empty text, null, empty lists, unchecked checkboxes are **not** empty).
#[must_use]
pub fn is_empty(c: Option<&CellValue>) -> bool {
    let Some(c) = c else { return true };
    match c {
        CellValue::Text { v } => rich_plain(v).trim().is_empty(),
        CellValue::Number { v } | CellValue::Rating { v } | CellValue::Progress { v } => v.is_none(),
        CellValue::Money { v, .. } => v.is_none(),
        CellValue::Select { v } | CellValue::Status { v } => v.is_none(),
        CellValue::Multi { v } | CellValue::Relation { v } => v.is_empty(),
        CellValue::Date { v } => v.is_none(),
        CellValue::Check { .. } | CellValue::Ts { .. } => false,
        CellValue::Url { v } | CellValue::Email { v } | CellValue::Phone { v } => {
            v.as_deref().is_none_or(|s| s.trim().is_empty())
        }
        CellValue::Ticker { v } => v.is_none(),
        CellValue::Files { v } => v.is_empty(),
        CellValue::Uid { v } => v.is_empty(),
        CellValue::Recurrence { v } => v.is_none(),
        CellValue::Secret { v } => v.is_none(),
        CellValue::Computed { v } => match &v.value {
            Value::Null => true,
            Value::String(s) => s.is_empty(),
            Value::Array(a) => a.is_empty(),
            _ => false,
        },
    }
}

/// Numeric projection (numbers, money, ratings, progress, numeric computed values).
#[must_use]
pub fn number(c: Option<&CellValue>) -> Option<f64> {
    match c? {
        CellValue::Number { v } | CellValue::Rating { v } | CellValue::Progress { v } => *v,
        CellValue::Money { v, .. } => v.as_deref().and_then(|s| s.parse::<f64>().ok()),
        CellValue::Computed { v } if matches!(v.kind, ComputedKind::Number | ComputedKind::Money) => {
            match &v.value {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.parse().ok(),
                _ => None,
            }
        }
        CellValue::Computed { v } if v.kind == ComputedKind::Bool => {
            v.value.as_bool().map(|b| f64::from(u8::from(b)))
        }
        CellValue::Ts { v } => Some(*v as f64),
        _ => None,
    }
}

/// Exact decimal projection of money cells (numbers convert through their shortest representation).
#[must_use]
pub fn decimal(c: Option<&CellValue>) -> Option<Decimal> {
    match c? {
        CellValue::Money { v: Some(s), .. } => Decimal::from_str(s).ok(),
        other => number(Some(other)).and_then(|n| Decimal::from_str(&fmt_num(n)).ok()),
    }
}

/// Local date-time range projection (date cells, timestamps, date computed values).
#[must_use]
pub fn date_range(
    c: Option<&CellValue>,
    ctx: &DateCtx,
) -> Option<(NaiveDateTime, Option<NaiveDateTime>)> {
    match c? {
        CellValue::Date { v: Some(d) } => ctx.range_of(d),
        CellValue::Ts { v } => Some((ctx.local(*v), None)),
        CellValue::Computed { v } if v.kind == ComputedKind::Date => {
            let s = v.value.as_str()?;
            let (a, b) = match s.split_once(" → ") {
                Some((a, b)) => (a, Some(b)),
                None => (s, None),
            };
            Some((ctx.parse(a)?, b.and_then(|b| ctx.parse(b))))
        }
        _ => None,
    }
}

/// Local start date.
#[must_use]
pub fn date(c: Option<&CellValue>, ctx: &DateCtx) -> Option<NaiveDate> {
    date_range(c, ctx).map(|(s, _)| s.date())
}

/// Ids of select-like and relation cells (computed lists give their display items).
#[must_use]
pub fn ids(c: Option<&CellValue>) -> Vec<String> {
    match c {
        Some(CellValue::Select { v: Some(i) } | CellValue::Status { v: Some(i) }) => vec![i.clone()],
        Some(CellValue::Multi { v } | CellValue::Relation { v }) => v.clone(),
        Some(CellValue::Computed { v }) => match &v.value {
            Value::Array(a) => a
                .iter()
                .map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_owned))
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Boolean projection.
#[must_use]
pub fn boolean(c: Option<&CellValue>) -> bool {
    match c {
        Some(CellValue::Check { v }) => *v,
        Some(CellValue::Computed { v }) => v.value.as_bool().unwrap_or(false),
        _ => false,
    }
}

// ───────────────────────────────────────────────────────────────────────────── validation

fn bad(msg: impl Into<String>) -> StoreError {
    StoreError::invalid_field("values", msg)
}

/// Validates a money decimal string (finite, scale ≤ 8, |x| < 10^15) and returns it normalised.
pub fn check_money(s: &str) -> Result<String> {
    let d = Decimal::from_str(s.trim()).map_err(|_| bad("money values are decimal strings"))?;
    if d.scale() > MONEY_MAX_SCALE {
        return Err(bad("money values have at most 8 decimals"));
    }
    if d.abs() >= Decimal::from(1_000_000_000_000_000_i64) {
        return Err(bad("money value out of range"));
    }
    Ok(d.to_string())
}

fn check_date_str(s: &str, time: bool) -> Result<()> {
    let ok = if time {
        chrono::DateTime::parse_from_rfc3339(s).is_ok()
    } else {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
    };
    if ok {
        Ok(())
    } else {
        Err(bad(if time {
            "timed dates are RFC 3339 with an offset"
        } else {
            "all-day dates are YYYY-MM-DD"
        }))
    }
}

/// `true` for allowed URL schemes (http, https, mailto).
#[must_use]
pub fn url_allowed(s: &str) -> bool {
    let l = s.trim().to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://") || l.starts_with("mailto:")
}

/// Validates (and normalises) a user-written value for a property. `None` means "clear".
pub fn validate(p: &Property, v: CellValue) -> Result<Option<CellValue>> {
    use CellValue as C;
    use PropType as T;
    let ok = match (p.kind, v) {
        (T::Title | T::Text, C::Text { v }) => {
            if rich_plain(&v).chars().count() > MAX_TEXT_CHARS {
                return Err(StoreError::TooLarge("text value"));
            }
            C::Text { v }
        }
        (T::Number, C::Number { v }) => {
            if v.is_some_and(|n| !n.is_finite()) {
                return Err(bad("numbers must be finite"));
            }
            C::Number { v }
        }
        (T::Money, C::Money { v, cur }) => {
            let cfg = p.money();
            let cur = if cur.trim().is_empty() || !cfg.per_row_currency {
                cfg.currency.clone().unwrap_or(cur)
            } else {
                cur
            };
            if !(cur.len() >= 3 && cur.len() <= 10 && cur.chars().all(|c| c.is_ascii_alphanumeric())) {
                return Err(bad("invalid currency code"));
            }
            let v = v.map(|s| check_money(&s)).transpose()?;
            C::Money {
                v,
                cur: cur.to_ascii_uppercase(),
            }
        }
        (T::Select, C::Select { v }) => {
            check_options(p, v.iter())?;
            C::Select { v }
        }
        (T::Status, C::Status { v }) => {
            check_options(p, v.iter())?;
            C::Status { v }
        }
        (T::MultiSelect, C::Multi { mut v }) => {
            check_options(p, v.iter())?;
            dedup(&mut v);
            C::Multi { v }
        }
        (T::Date, C::Date { v }) => {
            if let Some(d) = &v {
                check_date_str(&d.start, d.time)?;
                if let Some(e) = &d.end {
                    check_date_str(e, d.time)?;
                }
                if let Some(tz) = &d.tz
                    && tz.parse::<chrono_tz::Tz>().is_err()
                {
                    return Err(bad("unknown time zone"));
                }
            }
            C::Date { v }
        }
        (T::Checkbox, C::Check { v }) => C::Check { v },
        (T::Url, C::Url { v }) => {
            if let Some(u) = &v {
                if u.len() > 4096 {
                    return Err(StoreError::TooLarge("url"));
                }
                if !u.is_empty() && !url_allowed(u) {
                    return Err(bad("only http, https and mailto links are allowed"));
                }
            }
            C::Url { v }
        }
        (T::Email, C::Email { v }) => {
            if v.as_deref().is_some_and(|e| e.len() > 320) {
                return Err(StoreError::TooLarge("email"));
            }
            C::Email { v }
        }
        (T::Phone, C::Phone { v }) => {
            if v.as_deref().is_some_and(|e| e.len() > 64) {
                return Err(StoreError::TooLarge("phone"));
            }
            C::Phone { v }
        }
        (T::Files, C::Files { v }) => {
            if v.len() > MAX_LIST {
                return Err(StoreError::TooLarge("files"));
            }
            if v.iter().any(|f| !crate::model::ids::is_asset_id(&f.asset_id)) {
                return Err(bad("invalid asset id"));
            }
            C::Files { v }
        }
        (T::Relation, C::Relation { mut v }) => {
            if v.len() > MAX_LIST {
                return Err(StoreError::TooLarge("relation"));
            }
            if v.iter().any(|i| !crate::model::ids::is_record_id(i)) {
                return Err(bad("invalid row id"));
            }
            dedup(&mut v);
            if p.relation().single() {
                v.truncate(1);
            }
            C::Relation { v }
        }
        (T::Rating, C::Rating { v }) => {
            let max = f64::from(read::<RatingConfig>(&p.config).max.unwrap_or(5).clamp(1, 10));
            if let Some(n) = v
                && (!n.is_finite() || n.fract() != 0.0 || n < 1.0 || n > max)
            {
                return Err(bad("rating out of range"));
            }
            C::Rating { v }
        }
        (T::Progress, C::Progress { v }) => {
            if let Some(n) = v
                && (!n.is_finite() || !(0.0..=1.0).contains(&n))
            {
                return Err(bad("progress is between 0 and 1"));
            }
            C::Progress { v }
        }
        (T::Ticker, C::Ticker { v }) => {
            if v.as_deref().is_some_and(|s| {
                s.len() > 32
                    || !s
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '-' | '^' | '='))
            }) {
                return Err(bad("invalid symbol"));
            }
            C::Ticker {
                v: v.map(|s| s.to_ascii_uppercase()),
            }
        }
        (T::Recurrence, C::Recurrence { v }) => {
            if let Some(r) = &v {
                crate::life::recurrence::Rule::parse(&r.rrule, &r.dtstart, r.tz.as_deref())
                    .map_err(|e| bad(format!("invalid recurrence: {e}")))?;
            }
            C::Recurrence { v }
        }
        (T::Computed, c @ C::Computed { .. }) => c,
        (kind, other) => {
            return Err(bad(format!(
                "a {} value cannot be stored in a {} property",
                other.tag(),
                kind.as_str()
            )));
        }
    };
    Ok(if is_empty(Some(&ok)) && !matches!(ok, C::Check { .. }) {
        None
    } else {
        Some(ok)
    })
}

fn dedup(v: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|x| seen.insert(x.clone()));
}

fn check_options<'a>(p: &Property, ids: impl Iterator<Item = &'a String>) -> Result<()> {
    let opts = p.select_options();
    for id in ids {
        if !opts.iter().any(|o| &o.id == id) {
            return Err(bad(format!("unknown option for {}", p.name)));
        }
    }
    Ok(())
}

// ───────────────────────────────────────────────────────────────────────────── parsing text

/// Parses a number written by a person (`1,234.5`, `$12`, `45%`, `(3)`); `None` if unparseable.
#[must_use]
pub fn parse_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let (neg, t) = if t.starts_with('(') && t.ends_with(')') {
        (true, &t[1..t.len() - 1])
    } else {
        (false, t)
    };
    let pct = t.ends_with('%');
    let cleaned: String = t
        .chars()
        .filter(|c| !matches!(c, ',' | ' ' | '$' | '€' | '£' | '¥' | '%' | '\u{a0}'))
        .collect();
    let n: f64 = cleaned.parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    let n = if pct { n / 100.0 } else { n };
    Some(if neg { -n } else { n })
}

/// Parses a date written by a person or exported by Notion (`2026-11-26`, `11/26/2026`,
/// `November 26, 2026`, `November 26, 2026 3:00 PM`, `A → B` ranges).
#[must_use]
pub fn parse_date_text(s: &str) -> Option<DateValue> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Some((a, b)) = s.split_once('→') {
        let a = parse_date_text(a)?;
        let b = parse_date_text(b)?;
        return Some(DateValue {
            end: Some(b.start),
            time: a.time && b.time,
            ..a
        });
    }
    for f in ["%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y", "%d.%m.%Y", "%Y/%m/%d"] {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return Some(DateValue {
                start: d.format("%Y-%m-%d").to_string(),
                end: None,
                time: false,
                tz: None,
            });
        }
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(DateValue {
            start: dt.to_rfc3339(),
            end: None,
            time: true,
            tz: None,
        });
    }
    for f in [
        "%B %d, %Y %I:%M %p",
        "%b %d, %Y %I:%M %p",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y %I:%M %p",
    ] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Some(DateValue {
                start: format!("{}Z", dt.format("%Y-%m-%dT%H:%M:%S")),
                end: None,
                time: true,
                tz: None,
            });
        }
    }
    None
}

/// Parses yes/no text.
#[must_use]
pub fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "yes" | "true" | "1" | "y" | "x" | "checked" | "✓" | "✔" => Some(true),
        "no" | "false" | "0" | "n" | "" | "unchecked" => Some(false),
        _ => None,
    }
}

/// Converts text to a value of `p` (imports, CSV mapping, type conversion). Select options are matched by
/// name (case-insensitive); unknown names are skipped (callers create options first). Unparseable text gives
/// `None`.
#[must_use]
pub fn from_text(p: &Property, s: &str) -> Option<CellValue> {
    let t = s.trim();
    let v = match p.kind {
        PropType::Title | PropType::Text => CellValue::Text { v: rich(s) },
        PropType::Number => CellValue::Number {
            v: Some(parse_number(t)?),
        },
        PropType::Money => {
            let cfg = p.money();
            let cleaned: String = t
                .chars()
                .filter(|c| c.is_ascii_digit() || matches!(c, '.' | '-'))
                .collect();
            CellValue::Money {
                v: Some(check_money(&cleaned).ok()?),
                cur: cfg.currency.unwrap_or_else(|| "USD".into()),
            }
        }
        PropType::Select | PropType::Status => {
            let opts = p.select_options();
            let id = opts.iter().find(|o| o.name.eq_ignore_ascii_case(t))?.id.clone();
            if p.kind == PropType::Select {
                CellValue::Select { v: Some(id) }
            } else {
                CellValue::Status { v: Some(id) }
            }
        }
        PropType::MultiSelect => {
            let opts = p.select_options();
            let v: Vec<String> = split_list(t)
                .filter_map(|n| opts.iter().find(|o| o.name.eq_ignore_ascii_case(n)))
                .map(|o| o.id.clone())
                .collect();
            CellValue::Multi { v }
        }
        PropType::Date => CellValue::Date {
            v: Some(parse_date_text(t)?),
        },
        PropType::Checkbox => CellValue::Check { v: parse_bool(t)? },
        PropType::Url => {
            if !url_allowed(t) {
                return None;
            }
            CellValue::Url {
                v: Some(t.to_owned()),
            }
        }
        PropType::Email => CellValue::Email {
            v: Some(t.to_owned()),
        },
        PropType::Phone => CellValue::Phone {
            v: Some(t.to_owned()),
        },
        PropType::Rating => {
            let n = parse_number(t)?.round();
            CellValue::Rating {
                v: Some(n.clamp(1.0, 10.0)),
            }
        }
        PropType::Progress => {
            let n = parse_number(t)?;
            CellValue::Progress {
                v: Some(if n > 1.0 { n / 100.0 } else { n }.clamp(0.0, 1.0)),
            }
        }
        PropType::Ticker => CellValue::Ticker {
            v: Some(t.to_ascii_uppercase()),
        },
        _ => return None,
    };
    if is_empty(Some(&v)) && !matches!(v, CellValue::Check { .. }) {
        None
    } else {
        Some(v)
    }
}

/// Splits a comma-separated list (Notion multi-select export), trimming items.
pub fn split_list(s: &str) -> impl Iterator<Item = &str> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty())
}

// ───────────────────────────────────────────────────────────────────────────── Row dialect bridge

fn date_val(start: NaiveDateTime, end: Option<NaiveDateTime>, time: bool) -> DateVal {
    DateVal { start, end, time }
}

/// Converts a cell to a Row-dialect value (selects by option name; secrets are never exposed).
#[must_use]
pub fn to_row_value(c: Option<&CellValue>, p: &Property, ctx: &DateCtx) -> RowValue {
    let Some(c) = c else {
        return match p.kind {
            PropType::Checkbox => RowValue::Bool(false),
            PropType::MultiSelect | PropType::Relation | PropType::Files => RowValue::List(Vec::new()),
            _ => RowValue::Empty,
        };
    };
    match c {
        CellValue::Text { v } => RowValue::Text(rich_plain(v)),
        CellValue::Number { v } | CellValue::Rating { v } | CellValue::Progress { v } => {
            v.map_or(RowValue::Empty, RowValue::Number)
        }
        CellValue::Money { v, .. } => v
            .as_deref()
            .and_then(|s| s.parse().ok())
            .map_or(RowValue::Empty, RowValue::Number),
        CellValue::Select { .. } | CellValue::Status { .. } => {
            let d = display(c, p);
            if d.is_empty() { RowValue::Empty } else { RowValue::Text(d) }
        }
        CellValue::Multi { v } => {
            let opts = p.select_options();
            RowValue::List(
                v.iter()
                    .filter_map(|id| opts.iter().find(|o| &o.id == id))
                    .map(|o| RowValue::Text(o.name.clone()))
                    .collect(),
            )
        }
        CellValue::Date { v: Some(d) } => match ctx.range_of(d) {
            Some((s, e)) => RowValue::Date(date_val(s, e, d.time)),
            None => RowValue::Empty,
        },
        CellValue::Date { v: None } => RowValue::Empty,
        CellValue::Check { v } => RowValue::Bool(*v),
        CellValue::Url { v } | CellValue::Email { v } | CellValue::Phone { v } | CellValue::Ticker { v } => {
            v.clone().map_or(RowValue::Empty, RowValue::Text)
        }
        CellValue::Files { v } => RowValue::List(v.iter().map(|f| RowValue::Text(f.name.clone())).collect()),
        CellValue::Relation { v } => RowValue::List(v.iter().map(|i| RowValue::Row(i.clone())).collect()),
        CellValue::Uid { v } => RowValue::Text(v.clone()),
        CellValue::Recurrence { v } => v
            .as_ref()
            .map_or(RowValue::Empty, |r| RowValue::Text(r.rrule.clone())),
        CellValue::Secret { .. } => RowValue::Empty,
        CellValue::Ts { v } => RowValue::Date(date_val(ctx.local(*v), None, true)),
        CellValue::Computed { v } => computed_to_row(v, ctx),
    }
}

fn json_to_row(v: &Value) -> RowValue {
    match v {
        Value::Null => RowValue::Empty,
        Value::Bool(b) => RowValue::Bool(*b),
        Value::Number(n) => n.as_f64().map_or(RowValue::Empty, RowValue::Number),
        Value::String(s) => RowValue::Text(s.clone()),
        Value::Array(a) => RowValue::List(a.iter().map(json_to_row).collect()),
        Value::Object(_) => RowValue::Text(v.to_string()),
    }
}

fn computed_to_row(v: &ComputedValue, ctx: &DateCtx) -> RowValue {
    match v.kind {
        ComputedKind::Date => {
            let c = CellValue::Computed { v: v.clone() };
            match date_range(Some(&c), ctx) {
                Some((s, e)) => RowValue::Date(date_val(s, e, true)),
                None => RowValue::Empty,
            }
        }
        ComputedKind::Money => v
            .value
            .as_str()
            .and_then(|s| s.parse().ok())
            .or_else(|| v.value.as_f64())
            .map_or(RowValue::Empty, RowValue::Number),
        ComputedKind::Error => RowValue::Empty,
        _ => json_to_row(&v.value),
    }
}

fn row_to_json(v: &RowValue) -> Value {
    match v {
        RowValue::Empty => Value::Null,
        RowValue::Number(n) => json!(n),
        RowValue::Text(s) | RowValue::Row(s) => json!(s),
        RowValue::Bool(b) => json!(b),
        RowValue::Date(d) => json!(RowValue::Date(d.clone()).display()),
        RowValue::List(l) => Value::Array(l.iter().map(row_to_json).collect()),
    }
}

/// Converts a Row-dialect result into a computed cell.
#[must_use]
pub fn computed_from_row(v: &RowValue, display: &str) -> CellValue {
    let kind = match v {
        RowValue::Number(_) => ComputedKind::Number,
        RowValue::Bool(_) => ComputedKind::Bool,
        RowValue::Date(_) => ComputedKind::Date,
        RowValue::List(_) => ComputedKind::List,
        RowValue::Empty | RowValue::Text(_) | RowValue::Row(_) => ComputedKind::Text,
    };
    let display = match v {
        RowValue::Number(n) => fmt_num(*n),
        _ => display.to_owned(),
    };
    CellValue::Computed {
        v: ComputedValue {
            kind,
            value: row_to_json(v),
            display,
        },
    }
}

/// A computed error cell.
#[must_use]
pub fn computed_error(msg: &str) -> CellValue {
    CellValue::Computed {
        v: ComputedValue {
            kind: ComputedKind::Error,
            value: Value::Null,
            display: msg.to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::model::SelectOption;
    use serde_json::Map;

    fn prop(kind: PropType, config: Value) -> Property {
        Property {
            id: "p".into(),
            name: "P".into(),
            kind,
            config: config.as_object().cloned().unwrap_or_else(Map::new),
            role: None,
            hidden: false,
            sort_key: "a0".into(),
            description: None,
        }
    }

    #[test]
    fn validation_by_type() {
        let num = prop(PropType::Number, json!({}));
        assert!(validate(&num, CellValue::number(f64::NAN)).is_err());
        assert!(validate(&num, CellValue::text("x")).is_err());
        assert_eq!(validate(&num, CellValue::Number { v: None }).unwrap(), None);
        let money = prop(PropType::Money, json!({"currency":"EUR"}));
        let m = validate(
            &money,
            CellValue::Money {
                v: Some("12.500".into()),
                cur: String::new(),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            m,
            CellValue::Money {
                v: Some("12.500".into()),
                cur: "EUR".into()
            }
        );
        assert!(check_money("1.123456789").is_err());
        let url = prop(PropType::Url, json!({}));
        assert!(
            validate(
                &url,
                CellValue::Url {
                    v: Some("javascript:alert(1)".into())
                }
            )
            .is_err()
        );
        let sel = prop(
            PropType::Select,
            json!({"options":[SelectOption{id:"o1".into(),name:"Red".into(),color:crate::model::BlockColor::Red,group:None}]}),
        );
        assert!(validate(&sel, CellValue::Select { v: Some("o1".into()) }).is_ok());
        assert!(validate(&sel, CellValue::Select { v: Some("zz".into()) }).is_err());
        assert_eq!(
            from_text(&sel, " red "),
            Some(CellValue::Select { v: Some("o1".into()) })
        );
        let rating = prop(PropType::Rating, json!({}));
        assert!(validate(&rating, CellValue::Rating { v: Some(6.0) }).is_err());
        let rel = prop(PropType::Relation, json!({"limit":"one","targetDatabaseId":"x"}));
        assert_eq!(
            validate(&rel, CellValue::Relation { v: vec!["a".into(), "b".into()] }).unwrap(),
            Some(CellValue::Relation { v: vec!["a".into()] })
        );
    }

    #[test]
    fn parsing_text() {
        assert_eq!(parse_number("1,234.5"), Some(1234.5));
        assert_eq!(parse_number("(12)"), Some(-12.0));
        assert_eq!(parse_number("45%"), Some(0.45));
        assert_eq!(parse_number("abc"), None);
        let d = parse_date_text("November 26, 2026 3:00 PM").unwrap();
        assert!(d.time);
        assert_eq!(d.start, "2026-11-26T15:00:00Z");
        let r = parse_date_text("November 1, 2026 → November 3, 2026").unwrap();
        assert_eq!(r.end.as_deref(), Some("2026-11-03"));
        assert_eq!(parse_date_text("11/26/2026").unwrap().start, "2026-11-26");
        assert_eq!(parse_bool("Yes"), Some(true));
    }

    #[test]
    fn row_bridge() {
        let ctx = DateCtx::utc(0);
        let p = prop(PropType::Number, json!({}));
        assert_eq!(to_row_value(Some(&CellValue::number(2.0)), &p, &ctx), RowValue::Number(2.0));
        let c = computed_from_row(&RowValue::Number(4.0), "4");
        assert_eq!(number(Some(&c)), Some(4.0));
        assert_eq!(plain_text(&c), "4");
    }
}
