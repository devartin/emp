//! Filters (SPEC §8.4): an `and`/`or` tree at most 3 levels deep, with operators by property type. Text
//! comparisons are case- and diacritic-insensitive; dates compare by local day; formula and rollup columns use
//! the operators of their result type.

use chrono::NaiveDate;
use serde_json::Value;

use super::cells;
use super::compute::Evaluator;
use super::model::{CellValue, ComputedKind, Filter, FilterOp, PropType, Property};
use super::sort::fold;
use crate::{Result, StoreError};

/// Maximum depth of `and`/`or` groups.
pub const MAX_FILTER_DEPTH: usize = 3;
/// Maximum number of conditions in one filter.
pub const MAX_CONDITIONS: usize = 100;

/// The comparison class of a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Text-like.
    Text,
    /// Numbers, money, ratings, progress.
    Number,
    /// Select / status.
    Select,
    /// Multi-select (and list results).
    Multi,
    /// Dates and timestamps.
    Date,
    /// Checkbox.
    Check,
    /// Relation.
    Relation,
    /// Files.
    Files,
    /// Formula / rollup / computed (decided by the value).
    Dynamic,
}

/// Class of a property type.
#[must_use]
pub fn class_of(t: PropType) -> Class {
    match t {
        PropType::Title
        | PropType::Text
        | PropType::Url
        | PropType::Email
        | PropType::Phone
        | PropType::UniqueId
        | PropType::Ticker
        | PropType::Recurrence
        | PropType::Secret => Class::Text,
        PropType::Number | PropType::Money | PropType::Rating | PropType::Progress => Class::Number,
        PropType::Select | PropType::Status => Class::Select,
        PropType::MultiSelect => Class::Multi,
        PropType::Date | PropType::CreatedTime | PropType::UpdatedTime => Class::Date,
        PropType::Checkbox => Class::Check,
        PropType::Relation => Class::Relation,
        PropType::Files => Class::Files,
        PropType::Formula | PropType::Rollup | PropType::Computed => Class::Dynamic,
    }
}

/// Operators allowed for a class.
#[must_use]
pub fn ops_for(c: Class) -> &'static [FilterOp] {
    use FilterOp as O;
    match c {
        Class::Text => &[
            O::Eq,
            O::Neq,
            O::Contains,
            O::NotContains,
            O::StartsWith,
            O::EndsWith,
            O::Empty,
            O::NotEmpty,
        ],
        Class::Number => &[O::Eq, O::Neq, O::Gt, O::Gte, O::Lt, O::Lte, O::Empty, O::NotEmpty],
        Class::Select => &[
            O::Eq,
            O::Neq,
            O::AnyOf,
            O::NoneOf,
            O::Empty,
            O::NotEmpty,
            O::GroupEq,
        ],
        Class::Multi => &[O::AnyOf, O::AllOf, O::NoneOf, O::Empty, O::NotEmpty, O::Contains],
        Class::Date => &[
            O::Eq,
            O::Before,
            O::After,
            O::OnOrBefore,
            O::OnOrAfter,
            O::Between,
            O::Within,
            O::Empty,
            O::NotEmpty,
        ],
        Class::Check => &[O::Checked, O::Unchecked, O::Eq],
        Class::Relation => &[O::Contains, O::NotContains, O::Empty, O::NotEmpty],
        Class::Files => &[O::Empty, O::NotEmpty],
        Class::Dynamic => &[
            O::Eq,
            O::Neq,
            O::Contains,
            O::NotContains,
            O::StartsWith,
            O::EndsWith,
            O::Empty,
            O::NotEmpty,
            O::Gt,
            O::Gte,
            O::Lt,
            O::Lte,
            O::Between,
            O::AnyOf,
            O::NoneOf,
            O::AllOf,
            O::Before,
            O::After,
            O::OnOrBefore,
            O::OnOrAfter,
            O::Within,
            O::Checked,
            O::Unchecked,
        ],
    }
}

fn meta_class(prop: &str) -> Option<Class> {
    matches!(prop, "$created" | "$updated").then_some(Class::Date)
}

/// Validates a filter against the schema: depth, size, known properties, allowed operators.
pub fn validate(f: &Filter, props: &[Property]) -> Result<()> {
    let mut count = 0usize;
    validate_inner(f, props, 0, &mut count)
}

fn validate_inner(f: &Filter, props: &[Property], depth: usize, count: &mut usize) -> Result<()> {
    match f {
        Filter::And { and: kids } | Filter::Or { or: kids } => {
            if depth >= MAX_FILTER_DEPTH {
                return Err(StoreError::invalid_field(
                    "filter",
                    "filters nest at most 3 levels deep",
                ));
            }
            for k in kids {
                validate_inner(k, props, depth + 1, count)?;
            }
            Ok(())
        }
        Filter::Cond { prop, op, .. } => {
            *count += 1;
            if *count > MAX_CONDITIONS {
                return Err(StoreError::TooLarge("filter"));
            }
            let class = match meta_class(prop) {
                Some(c) => c,
                None => class_of(
                    props
                        .iter()
                        .find(|p| &p.id == prop)
                        .ok_or_else(|| StoreError::invalid_field("filter", "unknown property"))?
                        .kind,
                ),
            };
            if !ops_for(class).contains(op) {
                return Err(StoreError::invalid_field(
                    "filter",
                    format!("operator {op:?} does not apply to this property"),
                ));
            }
            Ok(())
        }
    }
}

/// Whether row `row` of database `db` (ordinals in the evaluator's world) matches.
#[must_use]
pub fn matches(ev: &Evaluator<'_>, db: usize, row: usize, f: &Filter) -> bool {
    match f {
        Filter::And { and } => and.iter().all(|k| matches(ev, db, row, k)),
        Filter::Or { or } => or.is_empty() || or.iter().any(|k| matches(ev, db, row, k)),
        Filter::Cond { prop, op, value } => {
            let d = ev.world().at(db);
            let Some(r) = d.rows.get(row) else {
                return false;
            };
            let (cell, p) = match prop.as_str() {
                "$created" => (Some(CellValue::Ts { v: r.created_at }), None),
                "$updated" => (Some(CellValue::Ts { v: r.updated_at }), None),
                id => match d.prop(id) {
                    Some(p) => (ev.value(db, row, p), Some(p)),
                    // Conditions on deleted properties are ignored.
                    None => return true,
                },
            };
            let class = match p {
                None => Class::Date,
                Some(p) => match class_of(p.kind) {
                    Class::Dynamic => dynamic_class(cell.as_ref()),
                    c => c,
                },
            };
            test(ev, class, cell.as_ref(), p, *op, value.as_ref())
        }
    }
}

fn dynamic_class(c: Option<&CellValue>) -> Class {
    match c {
        Some(CellValue::Computed { v }) => match v.kind {
            ComputedKind::Number | ComputedKind::Money => Class::Number,
            ComputedKind::Bool => Class::Check,
            ComputedKind::Date => Class::Date,
            ComputedKind::List => Class::Multi,
            ComputedKind::Text | ComputedKind::Error => Class::Text,
        },
        Some(CellValue::Ts { .. }) => Class::Date,
        _ => Class::Text,
    }
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_owned))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn num_operand(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => cells::parse_number(s),
        _ => None,
    }
}

/// A date operand as an inclusive day range (dates, `{start,end}` objects, or relative tokens).
fn date_operand(ev: &Evaluator<'_>, v: Option<&Value>) -> Option<(NaiveDate, NaiveDate)> {
    let ctx = ev.ctx();
    match v? {
        Value::String(s) => match ctx.parse(s) {
            Some(d) => Some((d.date(), d.date())),
            None => ctx.within(&Value::String(s.clone())),
        },
        Value::Object(o) if o.contains_key("start") => {
            let a = ctx.parse(o.get("start")?.as_str()?)?.date();
            let b = o
                .get("end")
                .and_then(Value::as_str)
                .and_then(|e| ctx.parse(e))
                .map_or(a, |d| d.date());
            Some((a, b))
        }
        other @ Value::Object(_) => ctx.within(other),
        _ => None,
    }
}

fn test(
    ev: &Evaluator<'_>,
    class: Class,
    cell: Option<&CellValue>,
    p: Option<&Property>,
    op: FilterOp,
    value: Option<&Value>,
) -> bool {
    use FilterOp as O;
    let empty = cells::is_empty(cell);
    match op {
        O::Empty => return empty,
        O::NotEmpty => return !empty,
        _ => {}
    }
    match class {
        Class::Text => {
            let text = fold(&match (cell, p) {
                (Some(c), Some(p)) => cells::display(c, p),
                (Some(c), None) => cells::plain_text(c),
                _ => String::new(),
            });
            let needle = fold(value.and_then(Value::as_str).unwrap_or_default());
            match op {
                O::Eq => text == needle,
                O::Neq => text != needle,
                O::Contains => text.contains(&needle),
                O::NotContains => !text.contains(&needle),
                O::StartsWith => text.starts_with(&needle),
                O::EndsWith => text.ends_with(&needle),
                O::AnyOf => str_list(value).iter().any(|s| fold(s) == text),
                O::NoneOf => !str_list(value).iter().any(|s| fold(s) == text),
                _ => false,
            }
        }
        Class::Number => {
            if matches!(op, O::Between) {
                let (Some(n), Some(Value::Array(a))) = (cells::number(cell), value) else {
                    return false;
                };
                let lo = a.first().and_then(|x| num_operand(Some(x)));
                let hi = a.get(1).and_then(|x| num_operand(Some(x)));
                return lo.is_none_or(|l| n >= l) && hi.is_none_or(|h| n <= h);
            }
            let (Some(n), Some(x)) = (cells::number(cell), num_operand(value)) else {
                return op == O::Neq && !empty;
            };
            match op {
                O::Eq => (n - x).abs() < 1e-9,
                O::Neq => (n - x).abs() >= 1e-9,
                O::Gt => n > x,
                O::Gte => n >= x,
                O::Lt => n < x,
                O::Lte => n <= x,
                _ => false,
            }
        }
        Class::Select => {
            let id = cells::ids(cell).into_iter().next();
            let name = |id: &str| {
                p.and_then(|p| super::config::option_name(&p.config, id))
                    .map(|n| fold(&n))
            };
            let is = |want: &str| {
                id.as_deref().is_some_and(|i| {
                    i == want || name(i).is_some_and(|n| n == fold(want))
                })
            };
            match op {
                O::Eq => value.and_then(Value::as_str).is_some_and(is),
                O::Neq => !value.and_then(Value::as_str).is_some_and(is),
                O::AnyOf => str_list(value).iter().any(|w| is(w)),
                O::NoneOf => !str_list(value).iter().any(|w| is(w)),
                O::GroupEq => {
                    let want = value.and_then(Value::as_str).unwrap_or_default();
                    let opts = p.map(super::config::HasConfig::select_options).unwrap_or_default();
                    id.as_deref()
                        .and_then(|i| opts.iter().find(|o| o.id == i))
                        .and_then(|o| o.group)
                        .is_some_and(|g| g.as_str() == want)
                }
                _ => false,
            }
        }
        Class::Multi | Class::Relation => {
            let have = cells::ids(cell);
            let names: Vec<String> = match (cell, p) {
                (Some(c @ CellValue::Multi { .. }), Some(p)) => cells::split_list(&cells::display(c, p))
                    .map(fold)
                    .collect(),
                _ => have.iter().map(|s| fold(s)).collect(),
            };
            let has = |w: &str| have.iter().any(|h| h == w) || names.contains(&fold(w));
            let wanted = str_list(value);
            match op {
                O::AnyOf | O::Contains => wanted.iter().any(|w| has(w)),
                O::AllOf => wanted.iter().all(|w| has(w)),
                O::NoneOf | O::NotContains => !wanted.iter().any(|w| has(w)),
                O::Eq => wanted.len() == have.len() && wanted.iter().all(|w| has(w)),
                O::Neq => !(wanted.len() == have.len() && wanted.iter().all(|w| has(w))),
                _ => false,
            }
        }
        Class::Date => {
            let Some((s, e)) = cells::date_range(cell, ev.ctx()) else {
                return false;
            };
            let (start, end) = (s.date(), e.map_or(s.date(), |d| d.date()));
            let range = match op {
                O::Within => value.and_then(|v| ev.ctx().within(v)),
                O::Between => match value {
                    Some(Value::Array(a)) if a.len() == 2 => {
                        let lo = date_operand(ev, a.first());
                        let hi = date_operand(ev, a.get(1));
                        match (lo, hi) {
                            (Some(l), Some(h)) => Some((l.0, h.1)),
                            _ => None,
                        }
                    }
                    other => date_operand(ev, other),
                },
                _ => date_operand(ev, value),
            };
            let Some((lo, hi)) = range else { return false };
            match op {
                O::Eq | O::Within | O::Between => start <= hi && end >= lo,
                O::Before => start < lo,
                O::After => start > hi,
                O::OnOrBefore => start <= hi,
                O::OnOrAfter => start >= lo,
                _ => false,
            }
        }
        Class::Check => {
            let b = cells::boolean(cell);
            match op {
                O::Checked => b,
                O::Unchecked => !b,
                O::Eq => value.and_then(Value::as_bool) == Some(b),
                _ => false,
            }
        }
        Class::Files | Class::Dynamic => false,
    }
}

/// Database search: every whitespace-separated term must occur in the title or a text-like property.
#[must_use]
pub fn search_matches(ev: &Evaluator<'_>, db: usize, row: usize, terms: &[String]) -> bool {
    if terms.is_empty() {
        return true;
    }
    let d = ev.world().at(db);
    let Some(r) = d.rows.get(row) else {
        return false;
    };
    let mut hay = String::new();
    for p in &d.props {
        if matches!(
            p.kind,
            PropType::Title
                | PropType::Text
                | PropType::Url
                | PropType::Email
                | PropType::Phone
                | PropType::UniqueId
                | PropType::Select
                | PropType::MultiSelect
                | PropType::Status
        ) && let Some(v) = r.payload.values.get(&p.id)
        {
            hay.push_str(&fold(&cells::display(v, p)));
            hay.push(' ');
        }
    }
    terms.iter().all(|t| hay.contains(t.as_str()))
}
