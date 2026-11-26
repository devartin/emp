//! The query pipeline (SPEC §8.3–§8.5, §11.3 `db_query`): filter → search → sort → group → aggregate →
//! window. Pure over a [`World`]; the repository layer loads the world and computes the query rev.

use std::collections::BTreeMap;

use super::agg::{Func, aggregate};
use super::compute::Evaluator;
use super::filter::{matches, search_matches};
use super::group::{GroupRows, group_rows};
use super::model::{AggFn, CellValue, Filter, GroupBy, QueryGroup, Sort};
use super::sort::{fold, sort_rows};
use crate::model::Id;

/// Maximum rows per query window (SPEC §11.1).
pub const MAX_WINDOW: usize = 500;

/// What to run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuerySpec {
    /// Filter.
    pub filter: Option<Filter>,
    /// Sorts (empty = manual order).
    pub sorts: Vec<Sort>,
    /// Grouping.
    pub group_by: Option<GroupBy>,
    /// Search text.
    pub search: Option<String>,
    /// Footer aggregates.
    pub aggs: BTreeMap<Id, AggFn>,
}

/// The result before windowing.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryOutput {
    /// Matching rows in display order.
    pub rows: Vec<usize>,
    /// Groups (when grouped).
    pub groups: Option<Vec<GroupRows>>,
    /// Footer aggregates over all matching rows.
    pub aggs: BTreeMap<Id, String>,
}

/// Runs a query on database ordinal `db`.
#[must_use]
pub fn run(ev: &Evaluator<'_>, db: usize, spec: &QuerySpec) -> QueryOutput {
    let d = ev.world().at(db);
    let terms: Vec<String> = spec
        .search
        .as_deref()
        .map(|s| s.split_whitespace().map(fold).collect())
        .unwrap_or_default();
    let mut rows: Vec<usize> = (0..d.rows.len())
        .filter(|&r| spec.filter.as_ref().is_none_or(|f| matches(ev, db, r, f)))
        .filter(|&r| search_matches(ev, db, r, &terms))
        .collect();
    sort_rows(ev, db, &mut rows, &spec.sorts);
    let groups = spec
        .group_by
        .as_ref()
        .map(|gb| group_rows(ev, db, &rows, gb));
    let aggs = aggregates(ev, db, &rows, &spec.aggs);
    QueryOutput { rows, groups, aggs }
}

/// Aggregates over a row set.
#[must_use]
pub fn aggregates(
    ev: &Evaluator<'_>,
    db: usize,
    rows: &[usize],
    aggs: &BTreeMap<Id, AggFn>,
) -> BTreeMap<Id, String> {
    let d = ev.world().at(db);
    let mut out = BTreeMap::new();
    for (pid, f) in aggs {
        let Some(p) = d.prop(pid) else { continue };
        let vals: Vec<Option<CellValue>> = rows.iter().map(|&r| ev.value(db, r, p)).collect();
        let refs: Vec<Option<&CellValue>> = vals.iter().map(Option::as_ref).collect();
        out.insert(
            pid.clone(),
            aggregate(Func::from(*f), &refs, p, ev.ctx()).display(),
        );
    }
    out
}

/// Group DTOs with per-group aggregates.
#[must_use]
pub fn group_dtos(
    ev: &Evaluator<'_>,
    db: usize,
    groups: &[GroupRows],
    aggs: &BTreeMap<Id, AggFn>,
) -> Vec<QueryGroup> {
    groups
        .iter()
        .map(|g| QueryGroup {
            key: g.key.clone(),
            label: g.label.clone(),
            color: g.color,
            count: g.rows.len(),
            aggs: aggregates(ev, db, &g.rows, aggs),
        })
        .collect()
}

/// A stable 64-bit FNV-1a hash (query revs).
#[must_use]
pub fn fnv64(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in *p {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::compute::tests::{info, prop, row};
    use crate::query::compute::{DbData, World};
    use crate::query::dates::DateCtx;
    use crate::query::model::{FilterOp, PropType, SortDir};
    use serde_json::json;

    fn world() -> World {
        let opts = json!({"options":[
            {"id":"todo","name":"Todo","color":"gray","group":"todo"},
            {"id":"doing","name":"Doing","color":"blue","group":"in_progress"},
            {"id":"done","name":"Done","color":"green","group":"complete"}]});
        let props = vec![
            prop("t", "Name", PropType::Title, json!({})),
            prop("n", "Points", PropType::Number, json!({})),
            prop("s", "Status", PropType::Status, opts),
            prop("d", "Due", PropType::Date, json!({})),
            prop("c", "Done", PropType::Checkbox, json!({})),
        ];
        let mk = |id: &str, name: &str, n: Option<f64>, s: &str, d: &str, c: bool| {
            let mut v = vec![
                ("t", CellValue::text(name)),
                ("s", CellValue::Status { v: Some(s.into()) }),
                ("c", CellValue::Check { v: c }),
            ];
            if let Some(n) = n {
                v.push(("n", CellValue::number(n)));
            }
            if !d.is_empty() {
                v.push((
                    "d",
                    CellValue::Date {
                        v: Some(crate::query::model::DateValue {
                            start: d.into(),
                            end: None,
                            time: false,
                            tz: None,
                        }),
                    },
                ));
            }
            row(id, v)
        };
        let rows = vec![
            mk("r1", "Item 10", Some(3.0), "todo", "2026-11-26", false),
            mk("r2", "item 2", Some(1.0), "done", "2026-11-20", true),
            mk("r3", "Éclair", None, "doing", "", false),
            mk("r4", "apple", Some(8.0), "todo", "2026-12-24", false),
        ];
        World::new(vec![DbData::new(
            "db".into(),
            "Tasks".into(),
            info("t"),
            props,
            rows,
            1,
            1,
        )])
    }

    fn titles(w: &World, rows: &[usize]) -> Vec<String> {
        rows.iter().map(|&r| w.at(0).row_title(r)).collect()
    }

    #[test]
    fn sorting_natural_and_empty_last() {
        let w = world();
        let ev = Evaluator::new(&w, DateCtx::utc(1_795_694_400_000));
        let mut spec = QuerySpec {
            sorts: vec![Sort {
                prop: "t".into(),
                dir: SortDir::Asc,
            }],
            ..Default::default()
        };
        let out = run(&ev, 0, &spec);
        assert_eq!(
            titles(&w, &out.rows),
            vec!["apple", "Éclair", "item 2", "Item 10"]
        );
        spec.sorts = vec![Sort {
            prop: "n".into(),
            dir: SortDir::Desc,
        }];
        let out = run(&ev, 0, &spec);
        assert_eq!(
            titles(&w, &out.rows),
            vec!["apple", "Item 10", "item 2", "Éclair"]
        );
        spec.sorts = vec![Sort {
            prop: "s".into(),
            dir: SortDir::Asc,
        }];
        let out = run(&ev, 0, &spec);
        assert_eq!(titles(&w, &out.rows)[3], "item 2");
    }

    #[test]
    fn filters_nested_and_relative() {
        let w = world();
        let ev = Evaluator::new(&w, DateCtx::utc(1_795_694_400_000));
        let spec = QuerySpec {
            filter: Some(Filter::Or {
                or: vec![
                    Filter::cond("d", FilterOp::Within, Some(json!("today"))),
                    Filter::And {
                        and: vec![
                            Filter::cond("n", FilterOp::Gt, Some(json!(5))),
                            Filter::cond("c", FilterOp::Unchecked, None),
                        ],
                    },
                ],
            }),
            ..Default::default()
        };
        let out = run(&ev, 0, &spec);
        assert_eq!(titles(&w, &out.rows), vec!["Item 10", "apple"]);
        let f = Filter::cond("s", FilterOp::GroupEq, Some(json!("complete")));
        let out = run(
            &ev,
            0,
            &QuerySpec {
                filter: Some(f),
                ..Default::default()
            },
        );
        assert_eq!(titles(&w, &out.rows), vec!["item 2"]);
        let f = Filter::cond("t", FilterOp::Contains, Some(json!("ECLA")));
        let out = run(
            &ev,
            0,
            &QuerySpec {
                filter: Some(f),
                ..Default::default()
            },
        );
        assert_eq!(out.rows.len(), 1);
        let f = Filter::cond("d", FilterOp::Before, Some(json!("2026-11-26")));
        let out = run(
            &ev,
            0,
            &QuerySpec {
                filter: Some(f),
                ..Default::default()
            },
        );
        assert_eq!(titles(&w, &out.rows), vec!["item 2"]);
        let out = run(
            &ev,
            0,
            &QuerySpec {
                search: Some("ITEM".into()),
                ..Default::default()
            },
        );
        assert_eq!(out.rows.len(), 2);
    }

    #[test]
    fn grouping_and_aggregates() {
        let w = world();
        let ev = Evaluator::new(&w, DateCtx::utc(1_795_694_400_000));
        let mut aggs = BTreeMap::new();
        aggs.insert("n".to_owned(), AggFn::Sum);
        aggs.insert("c".to_owned(), AggFn::PctChecked);
        let spec = QuerySpec {
            group_by: Some(GroupBy {
                prop: "s".into(),
                date_bucket: None,
                by_status_group: Some(true),
                hide_empty: None,
                order: None,
            }),
            aggs: aggs.clone(),
            ..Default::default()
        };
        let out = run(&ev, 0, &spec);
        assert_eq!(out.aggs["n"], "12");
        assert_eq!(out.aggs["c"], "25%");
        let groups = out.groups.unwrap();
        let keys: Vec<&str> = groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["todo", "in_progress", "complete"]);
        assert_eq!(groups[0].rows.len(), 2);
        let dtos = group_dtos(&ev, 0, &groups, &aggs);
        assert_eq!(dtos[0].aggs["n"], "11");
        // Date grouping by month with a no-value group last.
        let spec = QuerySpec {
            group_by: Some(GroupBy {
                prop: "d".into(),
                date_bucket: Some(crate::query::model::DateBucket::Month),
                by_status_group: None,
                hide_empty: None,
                order: None,
            }),
            ..Default::default()
        };
        let g = run(&ev, 0, &spec).groups.unwrap();
        let keys: Vec<&str> = g.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["2026-11", "2026-12", ""]);
    }
}
