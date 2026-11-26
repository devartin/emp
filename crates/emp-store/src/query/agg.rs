//! Aggregation shared by footer/group aggregates (`AggFn`, SPEC §8.5) and rollups (`RollupFn`, §8.1).
//! Money sums are exact (`Decimal`).

use std::collections::BTreeSet;

use chrono::NaiveDateTime;
use rust_decimal::Decimal;
use serde_json::{Value, json};

use super::cells::{self, fmt_num};
use super::dates::DateCtx;
use super::model::{AggFn, CellValue, ComputedKind, ComputedValue, PropType, Property, RollupFn};

/// The common function set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(missing_docs)]
pub enum Func {
    ShowOriginal,
    ShowUnique,
    CountAll,
    CountValues,
    CountUnique,
    CountEmpty,
    CountNotEmpty,
    PctEmpty,
    PctNotEmpty,
    Sum,
    Avg,
    Median,
    Min,
    Max,
    Range,
    Earliest,
    Latest,
    DateRange,
    Checked,
    Unchecked,
    PctChecked,
    PctUnchecked,
}

impl From<AggFn> for Func {
    fn from(a: AggFn) -> Self {
        match a {
            AggFn::Count => Self::CountAll,
            AggFn::CountValues => Self::CountValues,
            AggFn::CountUnique => Self::CountUnique,
            AggFn::Empty => Self::CountEmpty,
            AggFn::NotEmpty => Self::CountNotEmpty,
            AggFn::PctEmpty => Self::PctEmpty,
            AggFn::PctNotEmpty => Self::PctNotEmpty,
            AggFn::Sum => Self::Sum,
            AggFn::Avg => Self::Avg,
            AggFn::Median => Self::Median,
            AggFn::Min => Self::Min,
            AggFn::Max => Self::Max,
            AggFn::Range => Self::Range,
            AggFn::Earliest => Self::Earliest,
            AggFn::Latest => Self::Latest,
            AggFn::Checked => Self::Checked,
            AggFn::Unchecked => Self::Unchecked,
            AggFn::PctChecked => Self::PctChecked,
        }
    }
}

impl From<RollupFn> for Func {
    fn from(r: RollupFn) -> Self {
        match r {
            RollupFn::ShowOriginal => Self::ShowOriginal,
            RollupFn::ShowUnique => Self::ShowUnique,
            RollupFn::CountAll => Self::CountAll,
            RollupFn::CountValues => Self::CountValues,
            RollupFn::CountUnique => Self::CountUnique,
            RollupFn::CountEmpty => Self::CountEmpty,
            RollupFn::CountNotEmpty => Self::CountNotEmpty,
            RollupFn::PctEmpty => Self::PctEmpty,
            RollupFn::PctNotEmpty => Self::PctNotEmpty,
            RollupFn::Sum => Self::Sum,
            RollupFn::Average => Self::Avg,
            RollupFn::Median => Self::Median,
            RollupFn::Min => Self::Min,
            RollupFn::Max => Self::Max,
            RollupFn::Range => Self::Range,
            RollupFn::Earliest => Self::Earliest,
            RollupFn::Latest => Self::Latest,
            RollupFn::DateRange => Self::DateRange,
            RollupFn::Checked => Self::Checked,
            RollupFn::Unchecked => Self::Unchecked,
            RollupFn::PctChecked => Self::PctChecked,
            RollupFn::PctUnchecked => Self::PctUnchecked,
        }
    }
}

/// An aggregate result.
#[derive(Clone, Debug, PartialEq)]
pub enum AggOut {
    /// No value (e.g. the sum of an empty set of dates).
    None,
    /// A count.
    Count(usize),
    /// A number.
    Num(f64),
    /// An exact money amount.
    Money(Decimal, Option<String>),
    /// A ratio 0..1 shown as a percentage.
    Pct(f64),
    /// A local date-time.
    Date(NaiveDateTime, bool),
    /// A duration in days.
    Days(i64),
    /// A list of display strings.
    List(Vec<String>),
}

impl AggOut {
    /// Display string (footer `aggs`).
    #[must_use]
    pub fn display(&self) -> String {
        match self {
            Self::None => String::new(),
            Self::Count(n) => n.to_string(),
            Self::Num(n) => fmt_num(round_display(*n)),
            Self::Money(d, _) => d.normalize().to_string(),
            Self::Pct(p) => format!("{}%", fmt_num((p * 1000.0).round() / 10.0)),
            Self::Date(d, time) => {
                if *time {
                    d.format("%Y-%m-%dT%H:%M").to_string()
                } else {
                    d.format("%Y-%m-%d").to_string()
                }
            }
            Self::Days(n) => format!("{n} days"),
            Self::List(l) => l.join(", "),
        }
    }

    /// As a computed cell (rollups).
    #[must_use]
    pub fn to_cell(&self) -> CellValue {
        let (kind, value) = match self {
            Self::None => (ComputedKind::Text, Value::Null),
            Self::Count(n) => (ComputedKind::Number, json!(n)),
            Self::Num(n) => (ComputedKind::Number, json!(n)),
            Self::Money(d, _) => (ComputedKind::Money, json!(d.normalize().to_string())),
            Self::Pct(p) => (ComputedKind::Number, json!(p)),
            Self::Date(..) => (ComputedKind::Date, json!(self.display())),
            Self::Days(n) => (ComputedKind::Number, json!(n)),
            Self::List(l) => (ComputedKind::List, json!(l)),
        };
        CellValue::Computed {
            v: ComputedValue {
                kind,
                value,
                display: self.display(),
            },
        }
    }
}

fn round_display(n: f64) -> f64 {
    // 10 significant decimals hide float noise in averages without losing money-like precision.
    (n * 1e10).round() / 1e10
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let m = v.len() / 2;
    Some(if v.len() % 2 == 0 {
        (v[m - 1] + v[m]) / 2.0
    } else {
        v[m]
    })
}

fn pct(n: usize, total: usize) -> AggOut {
    if total == 0 {
        AggOut::Pct(0.0)
    } else {
        AggOut::Pct(n as f64 / total as f64)
    }
}

/// Aggregates `values` (one per row; `None` = no value) of property `p`.
#[must_use]
pub fn aggregate(func: Func, values: &[Option<&CellValue>], p: &Property, ctx: &DateCtx) -> AggOut {
    let total = values.len();
    let non_empty: Vec<&CellValue> = values
        .iter()
        .filter_map(|v| v.filter(|c| !cells::is_empty(Some(c))))
        .collect();
    let displays = || non_empty.iter().map(|c| cells::display(c, p));
    match func {
        Func::ShowOriginal => AggOut::List(displays().filter(|s| !s.is_empty()).collect()),
        Func::ShowUnique => {
            let set: BTreeSet<String> = displays().filter(|s| !s.is_empty()).collect();
            AggOut::List(set.into_iter().collect())
        }
        Func::CountAll => AggOut::Count(total),
        Func::CountValues => AggOut::Count(
            non_empty
                .iter()
                .map(|c| match c {
                    CellValue::Multi { v } | CellValue::Relation { v } => v.len(),
                    CellValue::Files { v } => v.len(),
                    _ => 1,
                })
                .sum(),
        ),
        Func::CountUnique => {
            let set: BTreeSet<String> = non_empty
                .iter()
                .flat_map(|c| match c {
                    CellValue::Multi { v } | CellValue::Relation { v } => v.clone(),
                    other => vec![cells::display(other, p)],
                })
                .collect();
            AggOut::Count(set.len())
        }
        Func::CountEmpty => AggOut::Count(total - non_empty.len()),
        Func::CountNotEmpty => AggOut::Count(non_empty.len()),
        Func::PctEmpty => pct(total - non_empty.len(), total),
        Func::PctNotEmpty => pct(non_empty.len(), total),
        Func::Sum | Func::Avg | Func::Median | Func::Min | Func::Max | Func::Range => {
            numeric(func, &non_empty, p)
        }
        Func::Earliest | Func::Latest | Func::DateRange => {
            let mut dates: Vec<(NaiveDateTime, bool)> = Vec::new();
            for c in &non_empty {
                if let Some((s, e)) = cells::date_range(Some(c), ctx) {
                    let time = matches!(c, CellValue::Date { v: Some(d) } if d.time)
                        || matches!(c, CellValue::Ts { .. });
                    dates.push((s, time));
                    if let Some(e) = e {
                        dates.push((e, time));
                    }
                }
            }
            let min = dates.iter().min_by_key(|d| d.0).copied();
            let max = dates.iter().max_by_key(|d| d.0).copied();
            match (func, min, max) {
                (Func::Earliest, Some((d, t)), _) => AggOut::Date(d, t),
                (Func::Latest, _, Some((d, t))) => AggOut::Date(d, t),
                (Func::DateRange, Some((a, _)), Some((b, _))) => AggOut::Days((b - a).num_days()),
                _ => AggOut::None,
            }
        }
        Func::Checked | Func::Unchecked | Func::PctChecked | Func::PctUnchecked => {
            let checked = values
                .iter()
                .filter(|v| cells::boolean(v.as_deref()))
                .count();
            match func {
                Func::Checked => AggOut::Count(checked),
                Func::Unchecked => AggOut::Count(total - checked),
                Func::PctChecked => pct(checked, total),
                _ => pct(total - checked, total),
            }
        }
    }
}

fn numeric(func: Func, vals: &[&CellValue], p: &Property) -> AggOut {
    let is_money = p.kind == PropType::Money
        || vals.iter().any(|c| matches!(c, CellValue::Money { .. }))
        || vals
            .iter()
            .any(|c| matches!(c, CellValue::Computed { v } if v.kind == ComputedKind::Money));
    if is_money {
        let ds: Vec<Decimal> = vals.iter().filter_map(|c| money_decimal(c)).collect();
        let cur = vals.iter().find_map(|c| match c {
            CellValue::Money { cur, .. } => Some(cur.clone()),
            _ => None,
        });
        if ds.is_empty() {
            return if func == Func::Sum {
                AggOut::Money(Decimal::ZERO, cur)
            } else {
                AggOut::None
            };
        }
        let sum: Decimal = ds.iter().copied().sum();
        let out = match func {
            Func::Sum => sum,
            Func::Avg => {
                let n = Decimal::from(ds.len());
                (sum / n).round_dp(8)
            }
            Func::Median => {
                let mut s = ds.clone();
                s.sort();
                let m = s.len() / 2;
                if s.len() % 2 == 0 {
                    ((s[m - 1] + s[m]) / Decimal::TWO).round_dp(8)
                } else {
                    s[m]
                }
            }
            Func::Min => ds.iter().copied().min().unwrap_or_default(),
            Func::Max => ds.iter().copied().max().unwrap_or_default(),
            _ => {
                ds.iter().copied().max().unwrap_or_default()
                    - ds.iter().copied().min().unwrap_or_default()
            }
        };
        return AggOut::Money(out, cur);
    }
    let ns: Vec<f64> = vals.iter().filter_map(|c| cells::number(Some(c))).collect();
    if ns.is_empty() {
        return if func == Func::Sum {
            AggOut::Num(0.0)
        } else {
            AggOut::None
        };
    }
    let sum: f64 = ns.iter().sum();
    let min = ns.iter().copied().fold(f64::INFINITY, f64::min);
    let max = ns.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    AggOut::Num(match func {
        Func::Sum => sum,
        Func::Avg => sum / ns.len() as f64,
        Func::Median => median(ns).unwrap_or(0.0),
        Func::Min => min,
        Func::Max => max,
        _ => max - min,
    })
}

fn money_decimal(c: &CellValue) -> Option<Decimal> {
    match c {
        CellValue::Computed { v } if v.kind == ComputedKind::Money => match &v.value {
            Value::String(s) => s.parse().ok(),
            other => other.as_f64().and_then(|f| Decimal::try_from(f).ok()),
        },
        other => cells::decimal(Some(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn p(kind: PropType) -> Property {
        Property {
            id: "p".into(),
            name: "P".into(),
            kind,
            config: Map::new(),
            role: None,
            hidden: false,
            sort_key: "a0".into(),
            description: None,
        }
    }

    #[test]
    fn money_sums_are_exact() {
        let vals: Vec<CellValue> = ["0.1", "0.2", "0.3"]
            .iter()
            .map(|s| CellValue::Money {
                v: Some((*s).into()),
                cur: "USD".into(),
            })
            .collect();
        let refs: Vec<Option<&CellValue>> = vals.iter().map(Some).collect();
        let ctx = DateCtx::utc(0);
        let out = aggregate(Func::Sum, &refs, &p(PropType::Money), &ctx);
        assert_eq!(out.display(), "0.6");
    }

    #[test]
    fn counts_and_numbers() {
        let vals = [
            CellValue::number(1.0),
            CellValue::number(4.0),
            CellValue::Number { v: None },
        ];
        let refs: Vec<Option<&CellValue>> = vals.iter().map(Some).chain([None]).collect();
        let ctx = DateCtx::utc(0);
        let np = p(PropType::Number);
        assert_eq!(
            aggregate(Func::CountAll, &refs, &np, &ctx),
            AggOut::Count(4)
        );
        assert_eq!(
            aggregate(Func::CountEmpty, &refs, &np, &ctx),
            AggOut::Count(2)
        );
        assert_eq!(aggregate(Func::Avg, &refs, &np, &ctx), AggOut::Num(2.5));
        assert_eq!(aggregate(Func::Median, &refs, &np, &ctx), AggOut::Num(2.5));
        assert_eq!(aggregate(Func::Range, &refs, &np, &ctx), AggOut::Num(3.0));
        assert_eq!(aggregate(Func::PctEmpty, &refs, &np, &ctx).display(), "50%");
        let checks = [CellValue::Check { v: true }, CellValue::Check { v: false }];
        let refs: Vec<Option<&CellValue>> = checks.iter().map(Some).chain([None]).collect();
        assert_eq!(
            aggregate(Func::PctChecked, &refs, &p(PropType::Checkbox), &ctx).display(),
            "33.3%"
        );
    }
}
