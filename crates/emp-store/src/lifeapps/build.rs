//! Materialisation (pure): a [`Selection`] → concrete records with deterministic ids ([`Build`]).
//!
//! The install transaction writes these records as they are; previews run the same build with a throw-away
//! instance id to count rows and reminders; tune-ups rebuild with the instance's id and diff record fingerprints.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::life::recurrence::{Rule, next_after};
use crate::lifeapps::answers::{self, AnswerContext, Scope, subst, subst_str};
use crate::lifeapps::content::{self, ContentCtx};
use crate::lifeapps::ids::IdGen;
use crate::lifeapps::manifest::{
    DatabaseSpec, LifeAppManifest, PropSpec, ReminderSpec, RowSeed, TemplateKind, TemplateSpec,
    ViewSpec,
};
use crate::lifeapps::plan::Selection;
use crate::lifeapps::workbook::{self, WorkbookRows};
use crate::model::sort_key::n_keys_between;
use crate::model::{BlockColor, Icon, PageKind, PagePayload, TipTapDoc};
use crate::query::config;
use crate::query::engine::fnv64;
use crate::query::model::{
    CalendarSettings, CellValue, ComputedKind, ComputedValue, DatabasePayload, DateValue, Filter,
    GroupBy, Layout, PropType, Property, PropertyPayload, RecurrenceMode, RecurrenceValue,
    RowPayload, RowTemplate, SelectOption, Sort, StatusGroup, TemplateValue, ViewPayload, rich,
};
use crate::repo::reminders::{ReminderPayload, ReminderTarget};
use crate::{Result, StoreError};

/// Inputs of a build besides the selection.
#[derive(Clone, Debug)]
pub struct BuildCtx {
    /// Instance id (UUID; the id namespace).
    pub instance_id: String,
    /// Now (unix ms).
    pub now_ms: i64,
    /// Vault time zone.
    pub tz: Tz,
    /// Base currency (default for money properties).
    pub currency: String,
    /// Pack values (`pack.*`), e.g. the tax pack of the chosen jurisdiction.
    pub pack: Option<Value>,
}

impl BuildCtx {
    /// Today in the vault time zone.
    #[must_use]
    pub fn today(&self) -> NaiveDate {
        self.local_now().date()
    }

    /// Now as local wall-clock time.
    #[must_use]
    pub fn local_now(&self) -> NaiveDateTime {
        DateTime::<Utc>::from_timestamp_millis(self.now_ms)
            .unwrap_or_default()
            .with_timezone(&self.tz)
            .naive_local()
    }

    fn to_ms(&self, local: NaiveDateTime) -> Option<i64> {
        self.tz
            .from_local_datetime(&local)
            .earliest()
            .map(|d| d.timestamp_millis())
    }
}

/// A generated doc / dashboard page.
#[derive(Clone, Debug, PartialEq)]
pub struct PageRec {
    /// Template key.
    pub key: String,
    /// Id.
    pub id: String,
    /// Parent page id (`None` for the hub).
    pub parent_id: Option<String>,
    /// Page kind.
    pub kind: PageKind,
    /// Payload.
    pub payload: PagePayload,
    /// Document.
    pub doc: TipTapDoc,
}

/// A generated property.
#[derive(Clone, Debug, PartialEq)]
pub struct PropRec {
    /// Key (`<db>.prop:<key>`).
    pub key: String,
    /// Id.
    pub id: String,
    /// Column order.
    pub sort_key: String,
    /// Payload.
    pub payload: PropertyPayload,
}

/// A generated view.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewRec {
    /// Key (`<db>.view:<key>`).
    pub key: String,
    /// Id.
    pub id: String,
    /// Tab order.
    pub sort_key: String,
    /// Payload.
    pub payload: ViewPayload,
}

/// A generated row.
#[derive(Clone, Debug, PartialEq)]
pub struct RowRec {
    /// Key (`<db>.row:<rowKey>`).
    pub key: String,
    /// Id.
    pub id: String,
    /// Manual order.
    pub sort_key: String,
    /// Payload.
    pub payload: RowPayload,
    /// Template that produced the row.
    pub source: String,
}

/// A generated database.
#[derive(Clone, Debug, PartialEq)]
pub struct DbRec {
    /// Template key.
    pub key: String,
    /// Id (page id = database id).
    pub id: String,
    /// Parent page id.
    pub parent_id: Option<String>,
    /// Page payload.
    pub page: PagePayload,
    /// Database payload.
    pub db: DatabasePayload,
    /// Properties (including duals of relations from other generated databases).
    pub props: Vec<PropRec>,
    /// Views.
    pub views: Vec<ViewRec>,
    /// Rows.
    pub rows: Vec<RowRec>,
}

/// A generated workbook.
#[derive(Clone, Debug, PartialEq)]
pub struct WbRec {
    /// Template key.
    pub key: String,
    /// Id.
    pub id: String,
    /// Parent page id.
    pub parent_id: Option<String>,
    /// Page payload.
    pub page: PagePayload,
    /// Stored rows.
    pub rows: WorkbookRows,
}

/// Re-arming schedule of a recurring reminder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderSchedule {
    /// RFC 5545 rule.
    pub rrule: String,
    /// First occurrence (local `YYYY-MM-DDTHH:MM`).
    pub dtstart: String,
    /// Lead time in days.
    pub days_before: i64,
}

/// A generated reminder.
#[derive(Clone, Debug, PartialEq)]
pub struct RemRec {
    /// Key (`<template>` or `<template>:<n>`).
    pub key: String,
    /// Template key.
    pub source: String,
    /// Id.
    pub id: String,
    /// Fire time (unix ms).
    pub fire_at: i64,
    /// Payload.
    pub payload: ReminderPayload,
    /// Schedule of recurring reminders.
    pub schedule: Option<ReminderSchedule>,
}

/// Everything an install writes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Build {
    /// Hub template key.
    pub root_key: String,
    /// Doc and dashboard pages, parents before children.
    pub pages: Vec<PageRec>,
    /// Databases.
    pub dbs: Vec<DbRec>,
    /// Workbooks.
    pub workbooks: Vec<WbRec>,
    /// Reminders.
    pub reminders: Vec<RemRec>,
    /// Record key → id.
    pub key_map: BTreeMap<String, String>,
    /// Order of top-level records under each parent (record ids).
    pub children: BTreeMap<String, Vec<String>>,
    /// Non-fatal problems (skipped rows, past dates).
    pub warnings: Vec<String>,
}

/// Record fingerprints: record id → field → hash.
pub type Fingerprints = BTreeMap<String, BTreeMap<String, String>>;

fn hash<T: Serialize>(v: &T) -> String {
    let b = serde_json::to_vec(v).unwrap_or_default();
    format!("{:016x}", fnv64(&[&b]))
}

impl Build {
    /// Generated items of a template (rows, reminders) for plan counts.
    #[must_use]
    pub fn count_for(&self, key: &str) -> u32 {
        let rows = self
            .dbs
            .iter()
            .map(|d| d.rows.iter().filter(|r| r.source == key).count())
            .sum::<usize>();
        let rems = self.reminders.iter().filter(|r| r.source == key).count();
        u32::try_from(rows + rems).unwrap_or(u32::MAX)
    }

    /// Fingerprints of every generated record.
    #[must_use]
    pub fn fingerprints(&self) -> Fingerprints {
        let mut out = Fingerprints::new();
        for p in &self.pages {
            out.insert(
                p.id.clone(),
                BTreeMap::from([
                    ("title".to_owned(), hash(&p.payload.title)),
                    ("content".to_owned(), hash(&p.doc)),
                ]),
            );
        }
        for d in &self.dbs {
            let props: Vec<(&str, &PropertyPayload)> = d
                .props
                .iter()
                .map(|p| (p.id.as_str(), &p.payload))
                .collect();
            let views: Vec<(&str, &ViewPayload)> = d
                .views
                .iter()
                .map(|v| (v.id.as_str(), &v.payload))
                .collect();
            out.insert(
                d.id.clone(),
                BTreeMap::from([
                    ("title".to_owned(), hash(&d.page.title)),
                    ("schema".to_owned(), hash(&props)),
                    ("views".to_owned(), hash(&views)),
                ]),
            );
            for r in &d.rows {
                out.insert(
                    r.id.clone(),
                    BTreeMap::from([("values".to_owned(), hash(&r.payload.values))]),
                );
            }
        }
        for w in &self.workbooks {
            let cells: Vec<_> = w
                .rows
                .bands
                .iter()
                .map(|(s, b, p)| (s, b, &p.cells))
                .collect();
            out.insert(
                w.id.clone(),
                BTreeMap::from([
                    ("title".to_owned(), hash(&w.page.title)),
                    ("cells".to_owned(), hash(&cells)),
                ]),
            );
        }
        for r in &self.reminders {
            out.insert(
                r.id.clone(),
                BTreeMap::from([
                    ("text".to_owned(), hash(&r.payload.text)),
                    ("fireAt".to_owned(), hash(&r.fire_at)),
                ]),
            );
        }
        out
    }

    /// Record key of an id.
    #[must_use]
    pub fn key_of(&self, id: &str) -> Option<&str> {
        self.key_map
            .iter()
            .find(|(_, v)| v.as_str() == id)
            .map(|(k, _)| k.as_str())
    }
}

/// Fingerprint helpers shared with the repository (which hashes what is on disk the same way).
pub mod fp {
    use super::*;

    /// Page fingerprint.
    #[must_use]
    pub fn page(title: &str, doc: Option<&TipTapDoc>) -> BTreeMap<String, String> {
        let mut m = BTreeMap::from([("title".to_owned(), hash(&title))]);
        if let Some(d) = doc {
            m.insert("content".into(), hash(d));
        }
        m
    }

    /// Row fingerprint.
    #[must_use]
    pub fn row(values: &BTreeMap<String, CellValue>) -> BTreeMap<String, String> {
        BTreeMap::from([("values".to_owned(), hash(values))])
    }

    /// Reminder fingerprint.
    #[must_use]
    pub fn reminder(text: &str, fire_at: i64) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("text".to_owned(), hash(&text)),
            ("fireAt".to_owned(), hash(&fire_at)),
        ])
    }

    /// Database fingerprint.
    #[must_use]
    pub fn database(
        title: &str,
        props: &[(&str, &PropertyPayload)],
        views: &[(&str, &ViewPayload)],
    ) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("title".to_owned(), hash(&title)),
            ("schema".to_owned(), hash(&props)),
            ("views".to_owned(), hash(&views)),
        ])
    }

    /// Workbook fingerprint.
    #[must_use]
    pub fn workbook(
        title: &str,
        bands: &[(String, u32, crate::repo::workbooks::BandPayload)],
    ) -> BTreeMap<String, String> {
        let cells: Vec<_> = bands.iter().map(|(s, b, p)| (s, b, &p.cells)).collect();
        BTreeMap::from([
            ("title".to_owned(), hash(&title)),
            ("cells".to_owned(), hash(&cells)),
        ])
    }
}

// ───────────────────────────────────────────────────────────────────────────── helpers

/// `lucide:<name>` → icon. A legacy emoji maps through the canonical emoji map (owner ruling: no emoji); unmapped
/// emoji give no icon.
#[must_use]
pub fn icon_of(s: Option<&str>, color: Option<&str>) -> Option<Icon> {
    let s = s?.trim();
    if s.is_empty() {
        return None;
    }
    let name = match s.strip_prefix("lucide:") {
        Some(name) => name,
        None => crate::icons::lucide_for_emoji(s)?,
    };
    Some(Icon::Lucide {
        v: name.to_owned(),
        color: color.map(str::to_owned),
    })
}

const PALETTE: [BlockColor; 9] = [
    BlockColor::Gray,
    BlockColor::Brown,
    BlockColor::Orange,
    BlockColor::Yellow,
    BlockColor::Green,
    BlockColor::Blue,
    BlockColor::Purple,
    BlockColor::Pink,
    BlockColor::Red,
];

/// Parses `@today`, `@today+3d`, `@today-2w`, `@today+1m`, `@today+1y` or `YYYY-MM-DD`.
#[must_use]
pub fn parse_day(s: &str, today: NaiveDate) -> Option<NaiveDate> {
    let s = s.trim();
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(d);
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.date_naive());
    }
    let rest = s.strip_prefix("@today")?;
    if rest.is_empty() {
        return Some(today);
    }
    let (sign, body) = match rest.as_bytes().first()? {
        b'+' => (1i64, &rest[1..]),
        b'-' => (-1i64, &rest[1..]),
        _ => return None,
    };
    let unit = body.chars().last()?;
    let n: i64 = body[..body.len() - unit.len_utf8()].parse().ok()?;
    let n = n * sign;
    match unit {
        'd' => today.checked_add_signed(Duration::days(n)),
        'w' => today.checked_add_signed(Duration::weeks(n)),
        'm' => add_months(today, n),
        'y' => add_months(today, n * 12),
        _ => None,
    }
}

fn add_months(d: NaiveDate, n: i64) -> Option<NaiveDate> {
    let total = i64::from(d.year()) * 12 + i64::from(d.month0()) + n;
    let y = i32::try_from(total.div_euclid(12)).ok()?;
    let m = u32::try_from(total.rem_euclid(12)).ok()? + 1;
    let mut day = d.day();
    loop {
        if let Some(x) = NaiveDate::from_ymd_opt(y, m, day) {
            return Some(x);
        }
        day = day.checked_sub(1)?;
    }
}

fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace([',', '$', '€', '£'], "").parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
    .filter(|x| x.is_finite())
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Number(n) => emp_sheets::value::number_to_text(n.as_f64().unwrap_or(0.0)),
        other => other.to_string(),
    }
}

/// Generated property of a database template (shared by builds and metric lookups).
#[derive(Clone, Debug)]
struct PropPlan {
    spec: PropSpec,
    id: String,
    db: String,
    options: Vec<SelectOption>,
    /// Option key → id.
    opt_keys: BTreeMap<String, String>,
    currency: Option<String>,
}

/// **Option-id rule (1.0):** the id of a select / multi-select / status option an app generates is its manifest
/// option key (`credit_card`, `done`, `p1`), unique within its property. Frontends compare and write option ids as
/// keys on both backends (the browser mock uses the same ids). Options a person adds later get ordinary random ids.
/// Installs made before 1.0 had `UUIDv5(instance, "<db>.prop:<p>.opt:<key>")` ids; the vault-open upgrade
/// ([`crate::repo::lifeapps`] `upgrade_instance`) rewrites them to keys (options, cells, views and row templates).
#[must_use]
pub fn option_key_id(key: &str) -> String {
    key.to_owned()
}

/// The pre-1.0 id of a generated option (what [`option_key_id`] replaced), for the vault-open upgrade.
#[must_use]
pub fn legacy_option_id(ids: &IdGen, db_key: &str, prop_key: &str, opt_key: &str) -> String {
    ids.id(&format!("{db_key}.prop:{prop_key}.opt:{opt_key}"))
}

/// Option keys of the default status options (a status property without options).
pub const DEFAULT_STATUS_KEYS: [&str; 3] = ["not_started", "in_progress", "done"];

fn default_status() -> (Vec<SelectOption>, BTreeMap<String, String>) {
    let defs = [
        (
            "not_started",
            "Not started",
            BlockColor::Gray,
            StatusGroup::Todo,
        ),
        (
            "in_progress",
            "In progress",
            BlockColor::Blue,
            StatusGroup::InProgress,
        ),
        ("done", "Done", BlockColor::Green, StatusGroup::Complete),
    ];
    let mut keys = BTreeMap::new();
    let opts = defs
        .iter()
        .map(|(k, n, c, g)| {
            let id = option_key_id(k);
            keys.insert((*k).to_owned(), id.clone());
            SelectOption {
                id,
                name: (*n).to_owned(),
                color: *c,
                group: Some(*g),
            }
        })
        .collect();
    (opts, keys)
}

fn plan_props(
    db_key: &str,
    spec: &DatabaseSpec,
    ids: &IdGen,
    scope: &Scope<'_>,
    cx: &BuildCtx,
) -> Vec<PropPlan> {
    spec.properties
        .iter()
        .map(|p| {
            let base = format!("{db_key}.prop:{}", p.key);
            let (options, opt_keys) = match (&p.options, p.kind) {
                (Some(opts), _) if !opts.is_empty() => {
                    let mut keys = BTreeMap::new();
                    let list = opts
                        .iter()
                        .enumerate()
                        .map(|(i, o)| {
                            let id = option_key_id(&o.key);
                            keys.insert(o.key.clone(), id.clone());
                            SelectOption {
                                id,
                                name: subst_str(&o.name, scope),
                                color: o.color.unwrap_or(PALETTE[i % PALETTE.len()]),
                                group: o
                                    .group
                                    .or((p.kind == PropType::Status).then_some(StatusGroup::Todo)),
                            }
                        })
                        .collect();
                    (list, keys)
                }
                (_, PropType::Status) => default_status(),
                _ => (Vec::new(), BTreeMap::new()),
            };
            let currency = (p.kind == PropType::Money).then(|| {
                p.currency
                    .as_deref()
                    .map(|c| subst_str(c, scope))
                    .filter(|c| !c.trim().is_empty())
                    .unwrap_or_else(|| cx.currency.clone())
            });
            PropPlan {
                spec: p.clone(),
                id: ids.id(&base),
                db: db_key.to_owned(),
                options,
                opt_keys,
                currency,
            }
        })
        .collect()
}

fn option_id(p: &PropPlan, v: &str) -> Option<String> {
    let v = v.trim();
    let v = v.strip_prefix("opt:").unwrap_or(v);
    p.opt_keys.get(v).cloned().or_else(|| {
        p.options
            .iter()
            .find(|o| o.name.eq_ignore_ascii_case(v))
            .map(|o| o.id.clone())
    })
}

/// Row lookup of a database: row key → (id, title).
type RowIndex = BTreeMap<String, Vec<(String, String, String)>>;

fn related_ids(index: &RowIndex, db: &str, v: &Value) -> Vec<String> {
    let wanted: Vec<String> = match v {
        Value::Array(a) => a.iter().map(text_of).collect(),
        Value::String(s) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    };
    let rows = index.get(db).map(Vec::as_slice).unwrap_or(&[]);
    wanted
        .iter()
        .filter_map(|w| {
            rows.iter()
                .find(|(k, _, _)| k == w)
                .or_else(|| rows.iter().find(|(_, _, t)| t.eq_ignore_ascii_case(w)))
                .map(|(_, id, _)| id.clone())
        })
        .collect()
}

/// Converts a simple JSON value into the cell value of a property.
fn cell(p: &PropPlan, v: &Value, today: NaiveDate, index: &RowIndex) -> Option<CellValue> {
    if v.is_null() {
        return None;
    }
    Some(match p.spec.kind {
        PropType::Title | PropType::Text => {
            let t = text_of(v);
            if t.is_empty() {
                return None;
            }
            CellValue::Text { v: rich(&t) }
        }
        PropType::Number => CellValue::Number {
            v: Some(num_of(v)?),
        },
        PropType::Rating => CellValue::Rating {
            v: Some(num_of(v)?),
        },
        PropType::Progress => CellValue::Progress {
            v: Some(num_of(v)?),
        },
        PropType::Money => {
            let n = num_of(v)?;
            let s = crate::query::cells::check_money(&format!("{:.2}", n)).ok()?;
            CellValue::Money {
                v: Some(s),
                cur: p.currency.clone().unwrap_or_else(|| "USD".into()),
            }
        }
        PropType::Select => CellValue::Select {
            v: Some(option_id(p, &text_of(v))?),
        },
        PropType::Status => CellValue::Status {
            v: Some(option_id(p, &text_of(v))?),
        },
        PropType::MultiSelect => {
            let items: Vec<String> = match v {
                Value::Array(a) => a.iter().map(text_of).collect(),
                other => text_of(other)
                    .split(',')
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect(),
            };
            CellValue::Multi {
                v: items.iter().filter_map(|i| option_id(p, i)).collect(),
            }
        }
        PropType::Date => {
            let (start, end) = match v {
                Value::Object(o) => (
                    o.get("start").map(text_of).unwrap_or_default(),
                    o.get("end").map(text_of),
                ),
                other => (text_of(other), None),
            };
            let s = parse_day(&start, today)?;
            let e = end.and_then(|e| parse_day(&e, today));
            CellValue::Date {
                v: Some(DateValue {
                    start: s.format("%Y-%m-%d").to_string(),
                    end: e.map(|e| e.format("%Y-%m-%d").to_string()),
                    time: false,
                    tz: None,
                }),
            }
        }
        PropType::Checkbox => CellValue::Check {
            v: matches!(v, Value::Bool(true)) || num_of(v).is_some_and(|x| x != 0.0),
        },
        PropType::Url => CellValue::Url {
            v: Some(text_of(v)),
        },
        PropType::Email => CellValue::Email {
            v: Some(text_of(v)),
        },
        PropType::Phone => CellValue::Phone {
            v: Some(text_of(v)),
        },
        PropType::Ticker => CellValue::Ticker {
            v: Some(text_of(v).trim().to_uppercase()).filter(|s| !s.is_empty()),
        },
        PropType::Relation => {
            let target = p.spec.relation.as_ref()?.db.clone();
            let ids = related_ids(index, &target, v);
            if ids.is_empty() {
                return None;
            }
            CellValue::Relation { v: ids }
        }
        PropType::Recurrence => {
            let (rrule, dtstart) = match v {
                Value::Object(o) => (
                    o.get("rrule").map(text_of).unwrap_or_default(),
                    o.get("dtstart").map(text_of).unwrap_or_default(),
                ),
                other => (text_of(other), String::new()),
            };
            if rrule.is_empty() {
                return None;
            }
            let start = parse_day(&dtstart, today)
                .unwrap_or(today)
                .format("%Y-%m-%d")
                .to_string();
            Rule::parse(&rrule, &start, None).ok()?;
            CellValue::Recurrence {
                v: Some(RecurrenceValue {
                    rrule,
                    dtstart: start,
                    tz: None,
                    mode: RecurrenceMode::Schedule,
                }),
            }
        }
        PropType::Computed => match v {
            Value::Number(n) => {
                let x = n.as_f64()?;
                CellValue::Computed {
                    v: ComputedValue {
                        kind: ComputedKind::Number,
                        value: json!(x),
                        display: emp_sheets::value::number_to_text(x),
                    },
                }
            }
            other => {
                let t = text_of(other);
                CellValue::Computed {
                    v: ComputedValue {
                        kind: ComputedKind::Text,
                        value: json!(t),
                        display: t,
                    },
                }
            }
        },
        _ => return None,
    })
}

/// Translates a view filter written with property keys (and `opt:` operands) into ids.
fn translate_filter(v: &Value, props: &[PropPlan]) -> Option<Value> {
    match v {
        Value::Object(o) if o.contains_key("and") || o.contains_key("or") => {
            let (k, list) = if let Some(a) = o.get("and") {
                ("and", a)
            } else {
                ("or", o.get("or")?)
            };
            let items: Vec<Value> = list
                .as_array()?
                .iter()
                .filter_map(|x| translate_filter(x, props))
                .collect();
            Some(json!({ k: items }))
        }
        Value::Object(o) => {
            let key = o.get("prop")?.as_str()?;
            let (prop_id, plan) = if key.starts_with('$') {
                (key.to_owned(), None)
            } else {
                let p = props.iter().find(|p| p.spec.key == key)?;
                (p.id.clone(), Some(p))
            };
            let mut out = o.clone();
            out.insert("prop".into(), json!(prop_id));
            if let (Some(p), Some(val)) = (plan, o.get("value")) {
                let tr = |x: &Value| match x.as_str() {
                    Some(s) if s.starts_with("opt:") => {
                        option_id(p, s).map_or(x.clone(), Value::String)
                    }
                    _ => x.clone(),
                };
                let nv = match val {
                    Value::Array(a) => Value::Array(a.iter().map(tr).collect()),
                    other => tr(other),
                };
                out.insert("value".into(), nv);
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}

fn translate_props(v: &Value, props: &[PropPlan]) -> Value {
    match v {
        Value::Object(o) => {
            let mut out = Map::new();
            for (k, x) in o {
                if k == "prop"
                    && let Some(s) = x.as_str()
                    && let Some(p) = props.iter().find(|p| p.spec.key == s)
                {
                    out.insert(k.clone(), json!(p.id));
                    continue;
                }
                out.insert(k.clone(), translate_props(x, props));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| translate_props(x, props)).collect()),
        other => other.clone(),
    }
}

fn prop_id_of(props: &[PropPlan], key: &str) -> Option<String> {
    if key.starts_with('$') {
        return Some(key.to_owned());
    }
    props
        .iter()
        .find(|p| p.spec.key == key)
        .map(|p| p.id.clone())
}

fn view_payload(v: &ViewSpec, props: &[PropPlan]) -> Result<ViewPayload> {
    let bad =
        |what: &str| StoreError::invalid(format!("view {}: unknown property in {what}", v.key));
    let visible: Vec<String> = match &v.visible {
        Some(keys) => keys
            .iter()
            .map(|k| prop_id_of(props, k).ok_or_else(|| bad("visible")))
            .collect::<Result<_>>()?,
        None => props
            .iter()
            .filter(|p| !p.spec.hidden)
            .map(|p| p.id.clone())
            .collect(),
    };
    let mut p = ViewPayload::new(&v.name, v.layout, visible);
    p.icon.clone_from(&v.icon);
    if let Some(f) = &v.filter {
        let t = translate_filter(f, props).ok_or_else(|| bad("filter"))?;
        p.filter = Some(
            serde_json::from_value::<Filter>(t)
                .map_err(|e| StoreError::invalid(format!("view {}: {e}", v.key)))?,
        );
    }
    p.sorts = v
        .sorts
        .iter()
        .map(|s| {
            Ok(Sort {
                prop: prop_id_of(props, &s.prop).ok_or_else(|| bad("sorts"))?,
                dir: s.dir,
            })
        })
        .collect::<Result<_>>()?;
    if let Some(g) = &v.group_by {
        p.group_by = Some(GroupBy {
            prop: prop_id_of(props, &g.prop).ok_or_else(|| bad("groupBy"))?,
            date_bucket: g.date_bucket,
            by_status_group: g.by_status_group,
            hide_empty: g.hide_empty,
            order: None,
        });
    }
    if let Some(c) = &v.calendar {
        p.calendar = Some(CalendarSettings {
            date_prop: prop_id_of(props, &c.date_prop).ok_or_else(|| bad("calendar"))?,
            show_weekends: c.show_weekends,
        });
    } else if v.layout == Layout::Calendar {
        return Err(StoreError::invalid(format!(
            "view {}: calendar views need calendar settings",
            v.key
        )));
    }
    if let Some(c) = &v.chart {
        p.chart = Some(
            serde_json::from_value(translate_props(c, props))
                .map_err(|e| StoreError::invalid(format!("view {}: {e}", v.key)))?,
        );
    }
    for (k, agg) in &v.footer {
        p.footer_aggs
            .insert(prop_id_of(props, k).ok_or_else(|| bad("footer"))?, *agg);
    }
    p.card.clone_from(&v.card);
    if let Some(o) = v.open_in {
        p.open_in = o;
    }
    Ok(p)
}

fn prop_payload(
    p: &PropPlan,
    all: &BTreeMap<String, Vec<PropPlan>>,
    ids: &IdGen,
) -> Result<PropertyPayload> {
    let mut config = Map::new();
    match p.spec.kind {
        PropType::Select | PropType::MultiSelect | PropType::Status => {
            config::set(&mut config, "options", &p.options);
        }
        PropType::Money => {
            config::set(&mut config, "currency", p.currency.clone());
            if let Some(d) = p.spec.decimals {
                config::set(&mut config, "decimals", d);
            }
        }
        PropType::Number => {
            if let Some(f) = &p.spec.format {
                config::set(&mut config, "format", f);
            }
            if let Some(d) = p.spec.decimals {
                config::set(&mut config, "decimals", d);
            }
        }
        PropType::Relation => {
            let r = p
                .spec
                .relation
                .as_ref()
                .ok_or_else(|| StoreError::invalid("relation without target"))?;
            config::set(&mut config, "targetDatabaseId", ids.id(&r.db));
            let dual = r
                .dual
                .as_ref()
                .map(|d| json!({"propertyId": ids.id(&format!("{}.prop:{}", r.db, d.key))}));
            config.insert("dual".into(), dual.unwrap_or(Value::Null));
            config::set(
                &mut config,
                "limit",
                r.limit.clone().unwrap_or_else(|| "many".into()),
            );
        }
        PropType::Rollup => {
            let r = p
                .spec
                .rollup
                .as_ref()
                .ok_or_else(|| StoreError::invalid("rollup without config"))?;
            let rel = all
                .get(&p.db)
                .and_then(|ps| ps.iter().find(|x| x.spec.key == r.relation))
                .ok_or_else(|| StoreError::invalid("rollup relation"))?;
            let target_db = rel
                .spec
                .relation
                .as_ref()
                .map(|x| x.db.clone())
                .unwrap_or_default();
            let target = all
                .get(&target_db)
                .and_then(|ps| ps.iter().find(|x| x.spec.key == r.target))
                .map(|x| x.id.clone())
                .ok_or_else(|| {
                    StoreError::invalid(format!(
                        "rollup {}: unknown target {}",
                        p.spec.key, r.target
                    ))
                })?;
            config::set(&mut config, "relationPropId", &rel.id);
            config::set(&mut config, "targetPropId", target);
            config::set(&mut config, "fn", r.func);
        }
        PropType::Formula => {
            let props: Vec<Property> = all
                .get(&p.db)
                .map(|ps| {
                    ps.iter()
                        .map(|x| Property {
                            id: x.id.clone(),
                            name: x.spec.name.clone(),
                            kind: x.spec.kind,
                            config: Map::new(),
                            role: None,
                            hidden: false,
                            sort_key: String::new(),
                            description: None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            let expr = p.spec.formula.clone().unwrap_or_default();
            let stored = crate::repo::databases::to_storage(&expr, &props)
                .map_err(|e| StoreError::invalid(format!("formula {}: {e}", p.spec.key)))?;
            config::set(&mut config, "expression", stored);
        }
        PropType::UniqueId => {
            if let Some(px) = &p.spec.prefix {
                config::set(&mut config, "prefix", px);
            }
        }
        PropType::Rating => {
            config::set(&mut config, "max", p.spec.max.unwrap_or(5));
        }
        _ => {}
    }
    Ok(PropertyPayload {
        v: 1,
        name: p.spec.name.clone(),
        kind: p.spec.kind,
        config,
        role: p.spec.role.clone(),
        hidden: p.spec.hidden,
        description: p.spec.description.clone(),
    })
}

// ───────────────────────────────────────────────────────────────────────────── build

/// Renders `{{expr}}` in every string of a JSON value.
fn render_json(v: Value, sc: &Scope<'_>, actx: &AnswerContext) -> Value {
    match v {
        Value::String(s) if s.contains("{{") => Value::String(answers::render(&s, sc, actx)),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| render_json(x, sc, actx)).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, x)| (k, render_json(x, sc, actx)))
                .collect(),
        ),
        other => other,
    }
}

struct SeedOut {
    db: String,
    key: String,
    values: Map<String, Value>,
    icon: Option<String>,
    source: String,
    tags: Option<Vec<String>>,
}

fn expand_seed(
    seed: &RowSeed,
    db: &str,
    source: &str,
    scope: &Scope<'_>,
    actx: &AnswerContext,
    out: &mut Vec<SeedOut>,
) {
    let items: Vec<Option<Value>> = match &seed.for_each {
        Some(path) => scope.list(path).into_iter().map(Some).collect(),
        None => vec![None],
    };
    for (i, item) in items.iter().enumerate() {
        let sc = match item {
            Some(v) => scope.with_item(v, i),
            None => scope.clone(),
        };
        if let Some(w) = &seed.when {
            let w = subst_str(w, &sc);
            if !answers::test(Some(&w), actx) {
                continue;
            }
        }
        let key = subst_str(&seed.key, &sc);
        let values = match subst(&Value::Object(seed.values.clone()), &sc) {
            Value::Object(o) => o
                .into_iter()
                .map(|(k, v)| (k, render_json(v, &sc, actx)))
                .collect(),
            _ => Map::new(),
        };
        out.push(SeedOut {
            db: db.to_owned(),
            key,
            values,
            icon: seed.icon.clone(),
            source: source.to_owned(),
            tags: None,
        });
    }
}

/// Extra rows (sample data) converted with the same rules as seeds.
#[derive(Clone, Debug)]
pub struct ExtraRow {
    /// Database template key.
    pub db: String,
    /// Row key (unique per database).
    pub key: String,
    /// Values by property key.
    pub values: Map<String, Value>,
}

/// Builds every record of a selection.
pub fn build(m: &LifeAppManifest, sel: &Selection, cx: &BuildCtx) -> Result<Build> {
    build_with(m, sel, cx, &[])
}

/// [`build`] plus extra rows tagged `sample`.
pub fn build_with(
    m: &LifeAppManifest,
    sel: &Selection,
    cx: &BuildCtx,
    extra: &[ExtraRow],
) -> Result<Build> {
    let ids = IdGen::new(&cx.instance_id)?;
    let today = cx.today();
    let answers_map = &sel.resolved.answers;
    let mut actx = AnswerContext::new(answers_map, today);
    actx.pack = cx.pack.clone();
    let scope = Scope::new(answers_map, cx.pack.as_ref());
    let enabled = &sel.enabled;
    let root_key = m
        .templates
        .first()
        .map(|t| t.key.clone())
        .unwrap_or_default();
    let mut b = Build {
        root_key: root_key.clone(),
        ..Build::default()
    };
    for k in enabled {
        b.key_map.insert(k.clone(), ids.id(k));
    }
    let parent_of = |key: &str, parent: Option<&String>| -> Option<String> {
        if key == root_key {
            None
        } else {
            Some(ids.id(parent.map_or(root_key.as_str(), String::as_str)))
        }
    };
    let typed: Vec<(usize, TemplateSpec)> = m
        .templates
        .iter()
        .enumerate()
        .filter(|(_, t)| enabled.contains(&t.key))
        .map(|(i, t)| t.typed().map(|s| (i, s)))
        .collect::<Result<_>>()?;

    // Databases: property plans first (relations and duals need every id).
    let mut props: BTreeMap<String, Vec<PropPlan>> = BTreeMap::new();
    for (i, spec) in &typed {
        if let TemplateSpec::Database(d) = spec {
            let key = &m.templates[*i].key;
            props.insert(key.clone(), plan_props(key, d, &ids, &scope, cx));
        }
    }
    // Duals: a relation with `dual` adds a relation property to its target.
    let mut duals: BTreeMap<String, Vec<PropPlan>> = BTreeMap::new();
    for (db, ps) in &props {
        for p in ps {
            if let Some(r) = &p.spec.relation
                && let Some(d) = &r.dual
                && props.contains_key(&r.db)
            {
                let spec = PropSpec {
                    key: d.key.clone(),
                    name: d.name.clone(),
                    kind: PropType::Relation,
                    role: None,
                    hidden: false,
                    description: None,
                    options: None,
                    currency: None,
                    format: None,
                    decimals: None,
                    relation: Some(crate::lifeapps::manifest::RelationSpec {
                        db: db.clone(),
                        dual: Some(crate::lifeapps::manifest::DualSpec {
                            key: p.spec.key.clone(),
                            name: p.spec.name.clone(),
                        }),
                        limit: Some("many".into()),
                    }),
                    rollup: None,
                    formula: None,
                    prefix: None,
                    max: None,
                };
                duals.entry(r.db.clone()).or_default().push(PropPlan {
                    id: ids.id(&format!("{}.prop:{}", r.db, d.key)),
                    db: r.db.clone(),
                    spec,
                    options: Vec::new(),
                    opt_keys: BTreeMap::new(),
                    currency: None,
                });
            }
        }
    }
    for (db, ds) in duals {
        if let Some(ps) = props.get_mut(&db) {
            ps.extend(ds);
        }
    }

    // Seeds and the row index (row key → id, title) used by relation values.
    let mut seeds: Vec<SeedOut> = Vec::new();
    for (i, spec) in &typed {
        let t = &m.templates[*i];
        match spec {
            TemplateSpec::Database(d) => {
                for s in &d.rows {
                    expand_seed(s, &t.key, &t.key, &scope, &actx, &mut seeds);
                }
            }
            TemplateSpec::Rows(r) => {
                for s in &r.rows {
                    expand_seed(s, &r.db, &t.key, &scope, &actx, &mut seeds);
                }
            }
            _ => {}
        }
    }
    for e in extra {
        if props.contains_key(&e.db) {
            seeds.push(SeedOut {
                db: e.db.clone(),
                key: e.key.clone(),
                values: e.values.clone(),
                icon: None,
                source: "sample".into(),
                tags: Some(vec!["sample".into()]),
            });
        }
    }
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    seeds.retain(|s| seen.insert((s.db.clone(), s.key.clone())));
    let mut index: RowIndex = BTreeMap::new();
    for s in &seeds {
        let title_key = props
            .get(&s.db)
            .and_then(|ps| ps.iter().find(|p| p.spec.kind == PropType::Title))
            .map(|p| p.spec.key.clone())
            .unwrap_or_default();
        let title = s.values.get(&title_key).map(text_of).unwrap_or_default();
        index.entry(s.db.clone()).or_default().push((
            s.key.clone(),
            ids.id(&format!("{}.row:{}", s.db, s.key)),
            title,
        ));
    }

    // Database records.
    let mut view_charts: BTreeMap<String, Value> = BTreeMap::new();
    for (i, spec) in &typed {
        let t = &m.templates[*i];
        let TemplateSpec::Database(d) = spec else {
            continue;
        };
        let ps = props.get(&t.key).cloned().unwrap_or_default();
        let keys = n_keys_between(None, None, ps.len())?;
        let mut prop_recs = Vec::new();
        let mut roles = BTreeMap::new();
        for (p, sk) in ps.iter().zip(keys) {
            let payload = prop_payload(p, &props, &ids)?;
            if let Some(r) = &p.spec.role {
                roles.insert(r.clone(), p.id.clone());
            }
            prop_recs.push(PropRec {
                key: format!("{}.prop:{}", t.key, p.spec.key),
                id: p.id.clone(),
                sort_key: sk,
                payload,
            });
        }
        let primary = ps
            .iter()
            .find(|p| p.spec.kind == PropType::Title)
            .map(|p| p.id.clone())
            .ok_or_else(|| StoreError::invalid(format!("database {}: no title", t.key)))?;
        let uid_prop = ps
            .iter()
            .find(|p| p.spec.kind == PropType::UniqueId)
            .cloned();
        // Views: own views, then `view` templates targeting this database.
        let mut vspecs: Vec<ViewSpec> = d.views.clone();
        for (_, s2) in &typed {
            if let TemplateSpec::View(v) = s2
                && v.db == t.key
            {
                vspecs.push(v.view.clone());
            }
        }
        if vspecs.is_empty() {
            vspecs.push(ViewSpec {
                key: "all".into(),
                name: "All".into(),
                layout: Layout::Table,
                icon: None,
                filter: None,
                sorts: Vec::new(),
                group_by: None,
                visible: None,
                calendar: None,
                chart: None,
                footer: BTreeMap::new(),
                card: None,
                open_in: None,
            });
        }
        let vkeys = n_keys_between(None, None, vspecs.len())?;
        let mut views = Vec::new();
        for (v, sk) in vspecs.iter().zip(vkeys) {
            let payload = view_payload(v, &ps)?;
            if let Some(c) = &payload.chart {
                view_charts.insert(format!("{}.{}", t.key, v.key), serde_json::to_value(c)?);
            }
            views.push(ViewRec {
                key: format!("{}.view:{}", t.key, v.key),
                id: ids.id(&format!("{}.view:{}", t.key, v.key)),
                sort_key: sk,
                payload,
            });
        }
        // Rows.
        let mine: Vec<&SeedOut> = seeds.iter().filter(|s| s.db == t.key).collect();
        let rkeys = n_keys_between(None, None, mine.len())?;
        let mut rows = Vec::new();
        let mut uid_seq = 0i64;
        for (s, sk) in mine.into_iter().zip(rkeys) {
            let mut values = BTreeMap::new();
            for (k, v) in &s.values {
                match ps.iter().find(|p| &p.spec.key == k) {
                    Some(p) => {
                        if let Some(c) = cell(p, v, today, &index) {
                            values.insert(p.id.clone(), c);
                        }
                    }
                    None => b.warnings.push(format!("{}: unknown property {k}", t.key)),
                }
            }
            if let Some(u) = &uid_prop {
                uid_seq += 1;
                values.insert(
                    u.id.clone(),
                    crate::repo::databases::uid_value(u.spec.prefix.as_deref(), uid_seq),
                );
            }
            let id = ids.id(&format!("{}.row:{}", t.key, s.key));
            rows.push(RowRec {
                key: format!("{}.row:{}", t.key, s.key),
                id,
                sort_key: sk,
                payload: RowPayload {
                    v: 1,
                    values,
                    icon: icon_of(s.icon.as_deref(), None),
                    tags: s.tags.clone(),
                    secrets: BTreeMap::new(),
                },
                source: s.source.clone(),
            });
        }
        // Row templates.
        let mut templates = Vec::new();
        let mut default_template_id = None;
        for rt in &d.row_templates {
            let id = ids.id(&format!("{}.tpl:{}", t.key, rt.key));
            let mut values = BTreeMap::new();
            for (k, v) in &rt.values {
                let Some(p) = ps.iter().find(|p| &p.spec.key == k) else {
                    continue;
                };
                let tv = match v.as_str() {
                    Some(s) if s.starts_with('@') && p.spec.kind == PropType::Date => {
                        TemplateValue::Token(s.to_owned())
                    }
                    _ => match cell(p, v, today, &index) {
                        Some(c) => TemplateValue::Cell(c),
                        None => continue,
                    },
                };
                values.insert(p.id.clone(), tv);
            }
            let doc = if rt.body.is_empty() {
                None
            } else {
                let prop_id = |db: &str, k: &str| {
                    props
                        .get(db)
                        .and_then(|ps| ps.iter().find(|p| p.spec.key == k))
                        .map(|p| p.id.clone())
                };
                let ccx = ContentCtx {
                    scope: scope.clone(),
                    actx: &actx,
                    ids: &ids,
                    instance_id: &cx.instance_id,
                    disclaimer: m.disclaimer.as_deref(),
                    enabled,
                    view_charts: &view_charts,
                    prop_id: &prop_id,
                };
                Some(content::document(
                    content::render_blocks(&rt.body, &ccx)?,
                    &ids,
                    &id,
                )?)
            };
            if rt.default {
                default_template_id = Some(id.clone());
            }
            templates.push(RowTemplate {
                id,
                name: rt.name.clone(),
                icon: icon_of(rt.icon.as_deref(), None),
                values,
                doc,
            });
        }
        let mut page = PagePayload::new(&answers::render(&d.title, &scope, &actx));
        page.icon = icon_of(d.icon.as_deref(), None);
        page.app_instance_id = Some(cx.instance_id.clone());
        page.template_key = Some(t.key.clone());
        let db_payload = DatabasePayload {
            v: 1,
            description: d.description.as_deref().map(rich),
            primary_prop_id: primary,
            uid_prefix: uid_prop.as_ref().and_then(|u| u.spec.prefix.clone()),
            uid_seq,
            inline: false,
            templates,
            default_template_id,
            hide_empty_props: false,
            roles,
        };
        for p in &prop_recs {
            b.key_map.insert(p.key.clone(), p.id.clone());
        }
        for v in &views {
            b.key_map.insert(v.key.clone(), v.id.clone());
        }
        for r in &rows {
            b.key_map.insert(r.key.clone(), r.id.clone());
        }
        b.dbs.push(DbRec {
            key: t.key.clone(),
            id: ids.id(&t.key),
            parent_id: parent_of(&t.key, t.parent_key.as_ref()),
            page,
            db: db_payload,
            props: prop_recs,
            views,
            rows,
        });
    }

    // Pages and dashboards.
    let prop_id = |db: &str, k: &str| {
        props
            .get(db)
            .and_then(|ps| ps.iter().find(|p| p.spec.key == k))
            .map(|p| p.id.clone())
    };
    for (i, spec) in &typed {
        let t = &m.templates[*i];
        let (title, icon, blocks, kind, template, full_width) = match spec {
            TemplateSpec::Page(p) => (
                p.title.clone(),
                p.icon.clone(),
                p.blocks.clone(),
                PageKind::Doc,
                p.template,
                p.full_width,
            ),
            TemplateSpec::Dashboard(d) => {
                let mut blocks = Vec::new();
                if let Some(s) = &d.subtitle {
                    blocks.push(crate::lifeapps::manifest::BlockSpec::Md {
                        md: format!("*{s}*"),
                    });
                }
                blocks.extend(d.tiles.iter().cloned());
                blocks.extend(d.blocks.iter().cloned());
                (
                    d.title.clone(),
                    d.icon.clone(),
                    blocks,
                    PageKind::Dashboard,
                    false,
                    true,
                )
            }
            _ => continue,
        };
        let id = ids.id(&t.key);
        let ccx = ContentCtx {
            scope: scope.clone(),
            actx: &actx,
            ids: &ids,
            instance_id: &cx.instance_id,
            disclaimer: m.disclaimer.as_deref(),
            enabled,
            view_charts: &view_charts,
            prop_id: &prop_id,
        };
        let doc = content::document(content::render_blocks(&blocks, &ccx)?, &ids, &id)?;
        let mut payload = PagePayload::new(&answers::render(&title, &scope, &actx));
        payload.icon = icon_of(icon.as_deref(), (t.key == root_key).then_some("accent"));
        payload.app_instance_id = Some(cx.instance_id.clone());
        payload.template_key = Some(t.key.clone());
        if template {
            payload.flags.template = Some(true);
        }
        if full_width {
            payload.flags.full_width = Some(true);
        }
        b.pages.push(PageRec {
            key: t.key.clone(),
            id,
            parent_id: parent_of(&t.key, t.parent_key.as_ref()),
            kind,
            payload,
            doc,
        });
    }

    // Workbooks.
    for (i, spec) in &typed {
        let t = &m.templates[*i];
        let TemplateSpec::Workbook(w) = spec else {
            continue;
        };
        let rows = workbook::build(w, &t.key, &ids, &scope, &actx)?;
        for (sid, _, sp) in &rows.sheets {
            b.key_map
                .insert(format!("{}.sheet:{}", t.key, sp.name), sid.clone());
        }
        let mut page = PagePayload::new(&answers::render(&w.title, &scope, &actx));
        page.app_instance_id = Some(cx.instance_id.clone());
        page.template_key = Some(t.key.clone());
        b.workbooks.push(WbRec {
            key: t.key.clone(),
            id: ids.id(&t.key),
            parent_id: parent_of(&t.key, t.parent_key.as_ref()),
            page,
            rows,
        });
    }

    // Reminders.
    for (i, spec) in &typed {
        let t = &m.templates[*i];
        let TemplateSpec::Reminder(r) = spec else {
            continue;
        };
        reminders(
            &mut b,
            t.key.as_str(),
            r,
            &ids,
            &scope,
            &actx,
            cx,
            &root_key,
        )?;
    }

    // Children order under each parent (manifest order).
    for t in &m.templates {
        if !enabled.contains(&t.key) || t.key == root_key {
            continue;
        }
        if !matches!(
            t.kind,
            TemplateKind::Page
                | TemplateKind::Dashboard
                | TemplateKind::Database
                | TemplateKind::Workbook
        ) {
            continue;
        }
        let parent = ids.id(t.parent_key.as_deref().unwrap_or(&root_key));
        b.children.entry(parent).or_default().push(ids.id(&t.key));
    }
    // Parents before children for pages.
    let order: Vec<String> = m.templates.iter().map(|t| t.key.clone()).collect();
    b.pages.sort_by_key(|p| {
        depth_of(m, &p.key) * 10_000 + order.iter().position(|k| *k == p.key).unwrap_or(0)
    });
    Ok(b)
}

fn depth_of(m: &LifeAppManifest, key: &str) -> usize {
    let mut d = 0;
    let mut cur = m.template(key).and_then(|t| t.parent_key.clone());
    while let Some(p) = cur {
        d += 1;
        if d > 32 {
            break;
        }
        cur = m.template(&p).and_then(|t| t.parent_key.clone());
    }
    if key
        != m.templates
            .first()
            .map(|t| t.key.as_str())
            .unwrap_or_default()
    {
        d += 1;
    }
    d
}

fn parse_time(s: Option<&str>) -> NaiveTime {
    s.and_then(|t| NaiveTime::parse_from_str(t.trim(), "%H:%M").ok())
        .unwrap_or_else(|| NaiveTime::from_hms_opt(9, 0, 0).unwrap_or_default())
}

#[allow(clippy::too_many_arguments)]
fn reminders(
    b: &mut Build,
    key: &str,
    r: &ReminderSpec,
    ids: &IdGen,
    scope: &Scope<'_>,
    actx: &AnswerContext,
    cx: &BuildCtx,
    root_key: &str,
) -> Result<()> {
    let items: Vec<Option<Value>> = match &r.for_each {
        Some(p) => scope.list(p).into_iter().map(Some).collect(),
        None => vec![None],
    };
    let target_key = r.target.clone().unwrap_or_else(|| root_key.to_owned());
    let Some(target_id) = b.key_map.get(&target_key).cloned() else {
        return Ok(());
    };
    let now_local = cx.local_now();
    for (i, item) in items.iter().enumerate() {
        let sc = match item {
            Some(v) => scope.with_item(v, i),
            None => scope.clone(),
        };
        if let Some(w) = &r.when
            && !answers::test(Some(&subst_str(w, &sc)), actx)
        {
            continue;
        }
        let text = answers::render(&r.text, &sc, actx);
        let days_before = r
            .days_before
            .as_ref()
            .map(|v| subst(v, &sc))
            .and_then(|v| num_of(&v))
            .map_or(0, |d| d.round() as i64)
            .clamp(0, 365);
        let time = parse_time(r.time.as_deref().map(|t| subst_str(t, &sc)).as_deref());
        let at =
            r.at.as_ref()
                .map(|a| subst_str(a, &sc))
                .and_then(|a| parse_day(&a, cx.today()));
        let (occurrence, schedule) = match r
            .rrule
            .as_ref()
            .map(|x| subst_str(x, &sc))
            .filter(|x| !x.trim().is_empty())
        {
            Some(rule) => {
                let start = at.unwrap_or_else(|| cx.today()).and_time(time);
                let dtstart = start.format("%Y-%m-%dT%H:%M").to_string();
                let parsed = match Rule::parse(&rule, &dtstart, Some(cx.tz.name())) {
                    Ok(p) => p,
                    Err(e) => {
                        b.warnings.push(format!("{key}: {e}"));
                        continue;
                    }
                };
                let after = now_local + Duration::days(days_before);
                let next = next_after(
                    &parsed,
                    after - Duration::seconds(1),
                    RecurrenceMode::Schedule,
                );
                (
                    next,
                    Some(ReminderSchedule {
                        rrule: rule,
                        dtstart,
                        days_before,
                    }),
                )
            }
            None => (at.map(|d| d.and_time(time)), None),
        };
        let Some(occ) = occurrence else {
            continue;
        };
        let fire_local = occ - Duration::days(days_before);
        if fire_local <= now_local {
            if schedule.is_none() {
                b.warnings
                    .push(format!("{text}: the date has passed, no reminder was set."));
            }
            continue;
        }
        let Some(fire_at) = cx.to_ms(fire_local) else {
            continue;
        };
        let rkey = if r.for_each.is_some() {
            format!("{key}:{i}")
        } else {
            key.to_owned()
        };
        let id = ids.id(&format!("reminder:{rkey}"));
        b.key_map.insert(format!("reminder:{rkey}"), id.clone());
        b.reminders.push(RemRec {
            key: rkey,
            source: key.to_owned(),
            id,
            fire_at,
            payload: ReminderPayload {
                v: 1,
                target_kind: if target_key.contains(".row:") {
                    ReminderTarget::Row
                } else {
                    ReminderTarget::Page
                },
                target_id: target_id.clone(),
                block_id: None,
                text: text.chars().take(1024).collect(),
            },
            schedule,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_days() {
        let t = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        assert_eq!(parse_day("@today", t), Some(t));
        assert_eq!(
            parse_day("@today+3d", t),
            NaiveDate::from_ymd_opt(2026, 2, 3)
        );
        assert_eq!(
            parse_day("@today-1w", t),
            NaiveDate::from_ymd_opt(2026, 1, 24)
        );
        assert_eq!(
            parse_day("@today+1m", t),
            NaiveDate::from_ymd_opt(2026, 2, 28)
        );
        assert_eq!(
            parse_day("@today-1y", t),
            NaiveDate::from_ymd_opt(2025, 1, 31)
        );
        assert_eq!(
            parse_day("2026-04-15", t),
            NaiveDate::from_ymd_opt(2026, 4, 15)
        );
        assert_eq!(parse_day("@today+x", t), None);
        assert_eq!(parse_day("soon", t), None);
    }

    #[test]
    fn icons() {
        assert_eq!(
            icon_of(Some("lucide:wallet"), Some("jade")),
            Some(Icon::Lucide {
                v: "wallet".into(),
                color: Some("jade".into())
            })
        );
        assert_eq!(
            icon_of(Some("\u{1F3AF}"), None),
            Some(Icon::Lucide {
                v: "target".into(),
                color: None
            })
        );
        assert_eq!(icon_of(Some("\u{1FAE0}"), None), None);
        assert_eq!(icon_of(Some(" "), None), None);
    }
}
