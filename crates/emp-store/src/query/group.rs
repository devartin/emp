//! Grouping (SPEC §8.5): select, status (by option or by group), multi-select (a row joins each of its groups),
//! checkbox, date buckets, relation and exact text. The "No value" group has key `""` and sorts last; groups
//! listed in `GroupBy.order` come first in that order.

use std::collections::HashMap;

use super::cells;
use super::compute::Evaluator;
use super::config::HasConfig;
use super::model::{CellValue, DateBucket, GroupBy, PropType, StatusGroup};
use super::sort::{fold, natural_cmp};
use crate::model::BlockColor;

/// One group with its row indexes (in input order).
#[derive(Clone, Debug, PartialEq)]
pub struct GroupRows {
    /// Key (`""` = no value).
    pub key: String,
    /// Label.
    pub label: String,
    /// Colour.
    pub color: Option<BlockColor>,
    /// Rows.
    pub rows: Vec<usize>,
}

fn status_group_label(g: StatusGroup) -> &'static str {
    match g {
        StatusGroup::Todo => "To-do",
        StatusGroup::InProgress => "In progress",
        StatusGroup::Complete => "Complete",
    }
}

/// The group memberships `(key, label, color)` of one row.
#[must_use]
pub fn keys_of(
    ev: &Evaluator<'_>,
    db: usize,
    row: usize,
    gb: &GroupBy,
) -> Vec<(String, String, Option<BlockColor>)> {
    let d = ev.world().at(db);
    let Some(p) = d.prop(&gb.prop) else {
        return vec![(String::new(), "No value".into(), None)];
    };
    let v = ev.value(db, row, p);
    let none = || vec![(String::new(), format!("No {}", p.name), None)];
    if cells::is_empty(v.as_ref()) && p.kind != PropType::Checkbox {
        return none();
    }
    let opts = p.select_options();
    match (p.kind, v.as_ref()) {
        (PropType::Status, Some(CellValue::Status { v: Some(id) }))
            if gb.by_status_group == Some(true) =>
        {
            match opts.iter().find(|o| &o.id == id).and_then(|o| o.group) {
                Some(g) => vec![(
                    g.as_str().to_owned(),
                    status_group_label(g).to_owned(),
                    None,
                )],
                None => none(),
            }
        }
        (_, Some(CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) })) => {
            match opts.iter().find(|o| &o.id == id) {
                Some(o) => vec![(o.id.clone(), o.name.clone(), Some(o.color))],
                None => none(),
            }
        }
        (_, Some(CellValue::Multi { v })) => {
            let out: Vec<_> = v
                .iter()
                .filter_map(|id| opts.iter().find(|o| &o.id == id))
                .map(|o| (o.id.clone(), o.name.clone(), Some(o.color)))
                .collect();
            if out.is_empty() { none() } else { out }
        }
        (PropType::Checkbox, v) => {
            let b = cells::boolean(v);
            vec![(
                b.to_string(),
                if b { "Checked" } else { "Unchecked" }.to_owned(),
                None,
            )]
        }
        (_, Some(CellValue::Relation { v })) => {
            let target = p.relation().target_database_id;
            let world = ev.world();
            v.iter()
                .map(|id| {
                    let label = world
                        .db(&target)
                        .and_then(|t| t.row_index(id).map(|i| t.row_title(i)))
                        .filter(|t| !t.is_empty())
                        .unwrap_or_else(|| "Untitled".into());
                    (id.clone(), label, None)
                })
                .collect()
        }
        (_, v) => {
            if let Some(date) = cells::date(v, ev.ctx())
                && matches!(
                    p.kind,
                    PropType::Date | PropType::CreatedTime | PropType::UpdatedTime
                ) | matches!(v, Some(CellValue::Computed { v: c }) if c.kind == super::model::ComputedKind::Date)
            {
                let (k, l) = ev
                    .ctx()
                    .bucket(date, gb.date_bucket.unwrap_or(DateBucket::Relative));
                return vec![(k, l, None)];
            }
            let text = v.map(|c| cells::display(c, p)).unwrap_or_default();
            if text.trim().is_empty() {
                none()
            } else {
                vec![(text.clone(), text, None)]
            }
        }
    }
}

/// Groups `rows` (already sorted; order within groups is kept).
#[must_use]
pub fn group_rows(ev: &Evaluator<'_>, db: usize, rows: &[usize], gb: &GroupBy) -> Vec<GroupRows> {
    let d = ev.world().at(db);
    let p = d.prop(&gb.prop);
    let mut groups: Vec<GroupRows> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut push =
        |groups: &mut Vec<GroupRows>, key: String, label: String, color, row: Option<usize>| {
            let i = *at.entry(key.clone()).or_insert_with(|| {
                groups.push(GroupRows {
                    key,
                    label,
                    color,
                    rows: Vec::new(),
                });
                groups.len() - 1
            });
            if let Some(r) = row {
                groups[i].rows.push(r);
            }
        };
    // Option-based groups exist even when empty (unless hidden).
    let mut option_order: Vec<String> = Vec::new();
    if let Some(p) = p {
        let by_group = p.kind == PropType::Status && gb.by_status_group == Some(true);
        if by_group {
            for g in [
                StatusGroup::Todo,
                StatusGroup::InProgress,
                StatusGroup::Complete,
            ] {
                option_order.push(g.as_str().to_owned());
                push(
                    &mut groups,
                    g.as_str().into(),
                    status_group_label(g).into(),
                    None,
                    None,
                );
            }
        } else if matches!(
            p.kind,
            PropType::Select | PropType::Status | PropType::MultiSelect
        ) {
            for o in p.select_options() {
                option_order.push(o.id.clone());
                push(
                    &mut groups,
                    o.id.clone(),
                    o.name.clone(),
                    Some(o.color),
                    None,
                );
            }
        } else if p.kind == PropType::Checkbox {
            for (k, l) in [("false", "Unchecked"), ("true", "Checked")] {
                option_order.push(k.to_owned());
                push(&mut groups, k.into(), l.into(), None, None);
            }
        }
    }
    for &r in rows {
        for (k, l, c) in keys_of(ev, db, r, gb) {
            push(&mut groups, k, l, c, Some(r));
        }
    }
    let ordered_by_options = !option_order.is_empty();
    let is_date = p.is_some_and(|p| {
        matches!(
            p.kind,
            PropType::Date | PropType::CreatedTime | PropType::UpdatedTime
        )
    });
    groups.sort_by(|a, b| {
        let rank = |g: &GroupRows| {
            if g.key.is_empty() {
                return (2usize, usize::MAX);
            }
            if let Some(i) = gb
                .order
                .as_ref()
                .and_then(|o| o.iter().position(|k| k == &g.key))
            {
                return (0, i);
            }
            if ordered_by_options {
                return (
                    1,
                    option_order
                        .iter()
                        .position(|k| k == &g.key)
                        .unwrap_or(usize::MAX - 1),
                );
            }
            (1, 0)
        };
        rank(a).cmp(&rank(b)).then_with(|| {
            if ordered_by_options {
                std::cmp::Ordering::Equal
            } else if is_date {
                a.key.cmp(&b.key)
            } else {
                natural_cmp(&fold(&a.label), &fold(&b.label))
            }
        })
    });
    if gb.hide_empty == Some(true) {
        groups.retain(|g| !g.rows.is_empty());
    }
    groups
}
