//! Chart aggregation in Rust (`db_chart_data`, SPEC §8.3 chart layout): X is a property (dates bucketed by
//! day/week/month/quarter/year), Y is `count` or an aggregate of a property, optionally split by a series
//! property; options for cumulative totals and omitted zero buckets.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};

use super::agg::{AggOut, Func, aggregate};
use super::compute::Evaluator;
use super::group::{GroupRows, group_rows};
use super::model::{AggFn, CellValue, ChartData, ChartSeriesData, ChartSpec, DateBucket, GroupBy, PropType};

/// Default maximum number of X points.
pub const DEFAULT_MAX_POINTS: usize = 500;

fn groups_for(ev: &Evaluator<'_>, db: usize, rows: &[usize], prop: &str, bucket: Option<DateBucket>) -> Vec<GroupRows> {
    let d = ev.world().at(db);
    if prop == "$created" {
        // Bucket by creation day.
        let mut by: BTreeMap<String, GroupRows> = BTreeMap::new();
        for &r in rows {
            let dt = ev.ctx().local(d.rows[r].created_at).date();
            let (k, l) = ev.ctx().bucket(dt, bucket.unwrap_or(DateBucket::Month));
            by.entry(k.clone())
                .or_insert_with(|| GroupRows {
                    key: k,
                    label: l,
                    color: None,
                    rows: Vec::new(),
                })
                .rows
                .push(r);
        }
        return by.into_values().collect();
    }
    let is_date = d.prop(prop).is_some_and(|p| {
        matches!(
            p.kind,
            PropType::Date | PropType::CreatedTime | PropType::UpdatedTime
        )
    });
    group_rows(
        ev,
        db,
        rows,
        &GroupBy {
            prop: prop.to_owned(),
            date_bucket: if is_date {
                Some(bucket.unwrap_or(DateBucket::Month))
            } else {
                None
            },
            by_status_group: None,
            hide_empty: Some(true),
            order: None,
        },
    )
}

fn measure(ev: &Evaluator<'_>, db: usize, rows: &[usize], agg: AggFn, prop: Option<&str>) -> (Option<f64>, Option<String>) {
    let d = ev.world().at(db);
    let Some(p) = prop.and_then(|p| d.prop(p)) else {
        return (Some(rows.len() as f64), None);
    };
    let vals: Vec<Option<CellValue>> = rows.iter().map(|&r| ev.value(db, r, p)).collect();
    let refs: Vec<Option<&CellValue>> = vals.iter().map(Option::as_ref).collect();
    match aggregate(Func::from(agg), &refs, p, ev.ctx()) {
        AggOut::Count(n) => (Some(n as f64), None),
        AggOut::Num(n) | AggOut::Pct(n) => (Some(n), None),
        AggOut::Money(m, cur) => (m.to_string().parse().ok(), cur),
        AggOut::Days(n) => (Some(n as f64), None),
        _ => (None, None),
    }
}

/// Computes chart data over `rows` (already filtered).
#[must_use]
pub fn chart_data(ev: &Evaluator<'_>, db: usize, rows: &[usize], spec: &ChartSpec, max_points: usize) -> ChartData {
    let mut xs = groups_for(ev, db, rows, &spec.x.prop, spec.x.bucket);
    xs.retain(|g| !g.key.is_empty());
    xs.truncate(max_points.clamp(1, 5_000));
    let x: Vec<Value> = xs.iter().map(|g| json!(g.label)).collect();
    let mut currency = None;
    let mut series = Vec::new();
    let series_groups: Option<Vec<GroupRows>> = spec
        .series
        .as_ref()
        .map(|s| groups_for(ev, db, rows, &s.prop, Some(DateBucket::Month)));
    for (yi, y) in spec.y.iter().enumerate() {
        let label_y = match &y.prop {
            Some(p) => ev
                .world()
                .at(db)
                .prop(p)
                .map_or_else(|| p.clone(), |pp| pp.name.clone()),
            None => "Count".into(),
        };
        let splits: Vec<(String, String, Option<HashMap<usize, ()>>)> = match &series_groups {
            Some(sg) => sg
                .iter()
                .map(|g| {
                    (
                        format!("{yi}:{}", g.key),
                        if spec.y.len() > 1 {
                            format!("{} · {}", g.label, label_y)
                        } else {
                            g.label.clone()
                        },
                        Some(g.rows.iter().map(|r| (*r, ())).collect()),
                    )
                })
                .collect(),
            None => vec![(format!("{yi}"), label_y.clone(), None)],
        };
        for (key, label, members) in splits {
            let mut values = Vec::with_capacity(xs.len());
            let mut running = 0.0;
            for g in &xs {
                let rows_in: Vec<usize> = g
                    .rows
                    .iter()
                    .copied()
                    .filter(|r| members.as_ref().is_none_or(|m| m.contains_key(r)))
                    .collect();
                let (v, cur) = if rows_in.is_empty() && y.prop.is_some() && y.agg != AggFn::Sum {
                    (None, None)
                } else {
                    measure(ev, db, &rows_in, y.agg, y.prop.as_deref())
                };
                if cur.is_some() {
                    currency = cur;
                }
                let v = if spec.cumulative == Some(true) {
                    running += v.unwrap_or(0.0);
                    Some(running)
                } else {
                    v
                };
                values.push(v);
            }
            series.push(ChartSeriesData {
                key,
                label,
                color: None,
                values,
            });
        }
    }
    let mut data = ChartData { x, series, currency };
    if spec.omit_zero == Some(true) {
        let keep: Vec<bool> = (0..data.x.len())
            .map(|i| data.series.iter().any(|s| s.values[i].is_some_and(|v| v != 0.0)))
            .collect();
        retain_mask(&mut data.x, &keep);
        for s in &mut data.series {
            retain_mask(&mut s.values, &keep);
        }
    }
    data
}

fn retain_mask<T>(v: &mut Vec<T>, keep: &[bool]) {
    let mut i = 0;
    v.retain(|_| {
        let k = keep.get(i).copied().unwrap_or(true);
        i += 1;
        k
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::compute::tests::{info, prop, row};
    use crate::query::compute::{DbData, World};
    use crate::query::dates::DateCtx;
    use crate::query::model::{ChartX, ChartY, DateValue};
    use serde_json::json;

    #[test]
    fn monthly_sums_and_counts() {
        let mk = |id: &str, d: &str, amt: &str| {
            row(
                id,
                vec![
                    (
                        "d",
                        CellValue::Date {
                            v: Some(DateValue {
                                start: d.into(),
                                end: None,
                                time: false,
                                tz: None,
                            }),
                        },
                    ),
                    (
                        "m",
                        CellValue::Money {
                            v: Some(amt.into()),
                            cur: "USD".into(),
                        },
                    ),
                ],
            )
        };
        let w = World::new(vec![DbData::new(
            "db".into(),
            "Spend".into(),
            info("t"),
            vec![
                prop("t", "Name", PropType::Title, json!({})),
                prop("d", "Date", PropType::Date, json!({})),
                prop("m", "Amount", PropType::Money, json!({"currency":"USD"})),
            ],
            vec![mk("a", "2026-10-03", "10.10"), mk("b", "2026-10-20", "0.20"), mk("c", "2026-11-01", "5")],
            1,
            1,
        )]);
        let ev = Evaluator::new(&w, DateCtx::utc(0));
        let spec = ChartSpec {
            kind: "bar".into(),
            x: ChartX {
                prop: "d".into(),
                bucket: Some(DateBucket::Month),
            },
            y: vec![
                ChartY {
                    agg: AggFn::Sum,
                    prop: Some("m".into()),
                    as_: None,
                },
                ChartY {
                    agg: AggFn::Count,
                    prop: None,
                    as_: None,
                },
            ],
            series: None,
            stacked: None,
            cumulative: Some(true),
            labels: None,
            smooth: None,
            omit_zero: None,
            colors: None,
        };
        let data = chart_data(&ev, 0, &[0, 1, 2], &spec, 100);
        assert_eq!(data.x, vec![json!("October 2026"), json!("November 2026")]);
        assert_eq!(data.series[0].values, vec![Some(10.3), Some(15.3)]);
        assert_eq!(data.series[1].values, vec![Some(2.0), Some(3.0)]);
        assert_eq!(data.currency.as_deref(), Some("USD"));
    }
}
