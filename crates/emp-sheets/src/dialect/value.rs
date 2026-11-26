//! Values of the Row and Metric dialects (Notion-style: numbers, text, booleans, dates, lists, rows).

use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// A date (optionally with time, optionally a range).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateVal {
    /// Start.
    pub start: NaiveDateTime,
    /// End of a range.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<NaiveDateTime>,
    /// Whether the time part is meaningful.
    pub time: bool,
}

impl DateVal {
    /// A whole-day date.
    pub fn day(d: NaiveDate) -> DateVal {
        DateVal {
            start: d.and_hms_opt(0, 0, 0).unwrap_or_default(),
            end: None,
            time: false,
        }
    }
    /// A date-time.
    pub fn at(dt: NaiveDateTime) -> DateVal {
        DateVal {
            start: dt,
            end: None,
            time: true,
        }
    }
    /// ISO text (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`).
    pub fn iso(&self) -> String {
        let s = &self.start;
        if self.time {
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}",
                s.year(),
                s.month(),
                s.day(),
                s.hour(),
                s.minute()
            )
        } else {
            format!("{:04}-{:02}-{:02}", s.year(), s.month(), s.day())
        }
    }
}

/// A Row/Metric dialect value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum RowValue {
    /// Empty.
    #[default]
    Empty,
    /// Number.
    Number(f64),
    /// Text.
    Text(String),
    /// Boolean.
    Bool(bool),
    /// Date.
    Date(DateVal),
    /// List.
    List(Vec<RowValue>),
    /// A related row (by id).
    Row(String),
}

impl RowValue {
    /// Is the value empty (empty text, empty list or `Empty`)?
    pub fn is_empty(&self) -> bool {
        match self {
            RowValue::Empty => true,
            RowValue::Text(s) => s.is_empty(),
            RowValue::List(l) => l.is_empty(),
            _ => false,
        }
    }
    /// Truthiness (non-empty, non-zero, true).
    pub fn truthy(&self) -> bool {
        match self {
            RowValue::Bool(b) => *b,
            RowValue::Number(n) => *n != 0.0,
            other => !other.is_empty(),
        }
    }
    /// Type name (`number`, `text`, `boolean`, `date`, `list`, `row`, `empty`).
    pub fn type_name(&self) -> &'static str {
        match self {
            RowValue::Empty => "empty",
            RowValue::Number(_) => "number",
            RowValue::Text(_) => "text",
            RowValue::Bool(_) => "boolean",
            RowValue::Date(_) => "date",
            RowValue::List(_) => "list",
            RowValue::Row(_) => "row",
        }
    }
    /// Display text.
    pub fn display(&self) -> String {
        match self {
            RowValue::Empty => String::new(),
            RowValue::Number(n) => crate::value::number_to_text(*n),
            RowValue::Text(s) => s.clone(),
            RowValue::Bool(b) => b.to_string(),
            RowValue::Date(d) => match d.end {
                Some(e) => format!(
                    "{} → {}",
                    d.iso(),
                    DateVal {
                        start: e,
                        end: None,
                        time: d.time
                    }
                    .iso()
                ),
                None => d.iso(),
            },
            RowValue::List(l) => l.iter().map(|v| v.display()).collect::<Vec<_>>().join(", "),
            RowValue::Row(id) => id.clone(),
        }
    }
    /// Number view.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            RowValue::Number(n) => Some(*n),
            RowValue::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }
}

/// Ordering used by comparisons and `sort()`: numbers, text (case-sensitive like Notion), dates, booleans.
pub fn cmp_row(a: &RowValue, b: &RowValue) -> Option<Ordering> {
    match (a, b) {
        (RowValue::Number(x), RowValue::Number(y)) => x.partial_cmp(y),
        (RowValue::Text(x), RowValue::Text(y)) => Some(x.cmp(y)),
        (RowValue::Bool(x), RowValue::Bool(y)) => Some(x.cmp(y)),
        (RowValue::Date(x), RowValue::Date(y)) => Some(x.start.cmp(&y.start)),
        (RowValue::Empty, RowValue::Empty) => Some(Ordering::Equal),
        (RowValue::Empty, _) => Some(Ordering::Greater),
        (_, RowValue::Empty) => Some(Ordering::Less),
        _ => None,
    }
}
