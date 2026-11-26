//! Sorting (SPEC §8.5): multiple levels; select/status by option order; empty values last in both directions;
//! text with case- and diacritic-insensitive collation and natural numeric order ("Item 2" < "Item 10");
//! the manual `sort_key` when no sort is active (and as the final tie-breaker).

use std::cmp::Ordering;

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use super::cells;
use super::compute::Evaluator;
use super::model::{CellValue, ComputedKind, PropType, Sort, SortDir};

/// Case- and diacritic-insensitive folding (NFD, combining marks removed, lowercase).
#[must_use]
pub fn fold(s: &str) -> String {
    s.nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect()
}

/// Natural comparison of two folded strings: digit runs compare numerically.
#[must_use]
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let ta = na.trim_start_matches('0');
                let tb = nb.trim_start_matches('0');
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// A precomputed sort value.
#[derive(Clone, Debug, PartialEq)]
pub enum SortVal {
    /// No value (always last).
    Empty,
    /// Number.
    Num(f64),
    /// Folded text.
    Text(String),
    /// Option position (select / status).
    Pos(usize),
    /// Boolean.
    Bool(bool),
}

impl SortVal {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Num(a), Self::Num(b)) => a.total_cmp(b),
            (Self::Text(a), Self::Text(b)) => natural_cmp(a, b),
            (Self::Pos(a), Self::Pos(b)) => a.cmp(b),
            (Self::Bool(a), Self::Bool(b)) => a.cmp(b),
            (a, b) => rank(a).cmp(&rank(b)),
        }
    }
}

fn rank(v: &SortVal) -> u8 {
    match v {
        SortVal::Num(_) => 0,
        SortVal::Pos(_) => 1,
        SortVal::Text(_) => 2,
        SortVal::Bool(_) => 3,
        SortVal::Empty => 4,
    }
}

/// The sort value of a row for one sort level.
#[must_use]
pub fn sort_val(ev: &Evaluator<'_>, db: usize, row: usize, prop: &str) -> SortVal {
    let d = ev.world().at(db);
    let Some(r) = d.rows.get(row) else {
        return SortVal::Empty;
    };
    match prop {
        "$created" => return SortVal::Num(r.created_at as f64),
        "$updated" => return SortVal::Num(r.updated_at as f64),
        "$manual" => return SortVal::Text(r.sort_key.clone()),
        _ => {}
    }
    let Some(p) = d.prop(prop) else {
        return SortVal::Empty;
    };
    let v = ev.value(db, row, p);
    if cells::is_empty(v.as_ref()) {
        return match (p.kind, &v) {
            (PropType::Checkbox, _) => SortVal::Bool(false),
            _ => SortVal::Empty,
        };
    }
    let Some(v) = v else {
        return SortVal::Empty;
    };
    match (&v, p.kind) {
        (CellValue::Select { v: Some(id) } | CellValue::Status { v: Some(id) }, _) => {
            let opts = super::config::HasConfig::select_options(p);
            let alpha = super::config::read::<super::config::SelectConfig>(&p.config)
                .sort
                .as_deref()
                == Some("alpha");
            if alpha {
                SortVal::Text(fold(&cells::display(&v, p)))
            } else {
                opts.iter()
                    .position(|o| &o.id == id)
                    .map_or(SortVal::Empty, SortVal::Pos)
            }
        }
        (CellValue::Check { v }, _) => SortVal::Bool(*v),
        (CellValue::Date { .. } | CellValue::Ts { .. }, _) => cells::date_range(Some(&v), ev.ctx())
            .map_or(SortVal::Empty, |(s, _)| {
                SortVal::Num(s.and_utc().timestamp_millis() as f64)
            }),
        (CellValue::Computed { v: c }, _) => match c.kind {
            ComputedKind::Number | ComputedKind::Money | ComputedKind::Bool => {
                cells::number(Some(&v)).map_or(SortVal::Empty, SortVal::Num)
            }
            ComputedKind::Date => cells::date_range(Some(&v), ev.ctx()).map_or(SortVal::Empty, |(s, _)| {
                SortVal::Num(s.and_utc().timestamp_millis() as f64)
            }),
            _ => SortVal::Text(fold(&c.display)),
        },
        _ => match cells::number(Some(&v)) {
            Some(n) => SortVal::Num(n),
            None => SortVal::Text(fold(&cells::display(&v, p))),
        },
    }
}

/// Sorts row indexes of database `db` in place.
pub fn sort_rows(ev: &Evaluator<'_>, db: usize, rows: &mut [usize], sorts: &[Sort]) {
    let d = ev.world().at(db);
    let keys: Vec<(usize, Vec<SortVal>)> = rows
        .iter()
        .map(|&r| {
            (
                r,
                sorts
                    .iter()
                    .map(|s| sort_val(ev, db, r, &s.prop))
                    .collect(),
            )
        })
        .collect();
    let mut keyed = keys;
    keyed.sort_by(|(ra, ka), (rb, kb)| {
        for (i, s) in sorts.iter().enumerate() {
            let (a, b) = (&ka[i], &kb[i]);
            let o = match (a, b) {
                (SortVal::Empty, SortVal::Empty) => Ordering::Equal,
                (SortVal::Empty, _) => Ordering::Greater,
                (_, SortVal::Empty) => Ordering::Less,
                _ => match s.dir {
                    SortDir::Asc => a.cmp(b),
                    SortDir::Desc => b.cmp(a),
                },
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        let (x, y) = (&d.rows[*ra], &d.rows[*rb]);
        x.sort_key.cmp(&y.sort_key).then_with(|| x.id.cmp(&y.id))
    });
    for (slot, (r, _)) in rows.iter_mut().zip(keyed) {
        *slot = r;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_and_natural_order() {
        assert_eq!(fold("Éclair"), "eclair");
        assert_eq!(natural_cmp("item 2", "item 10"), Ordering::Less);
        assert_eq!(natural_cmp("item 010", "item 10"), Ordering::Equal);
        assert_eq!(natural_cmp("a", "b"), Ordering::Less);
        let mut v = vec!["item 10", "Item 2", "item 1"];
        v.sort_by(|a, b| natural_cmp(&fold(a), &fold(b)));
        assert_eq!(v, vec!["item 1", "Item 2", "item 10"]);
    }
}
