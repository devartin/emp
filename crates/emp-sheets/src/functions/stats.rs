//! Statistical functions.

use super::math::{aligned_values, criteria_mask, pairs};
use super::{FnSpec, nums, nums_a};
use crate::eval::{Ev, EvalCtx, R, num, ok};
use crate::fspec;
use crate::value::{Array, ErrorKind, Value};
use std::cmp::Ordering;

/// Statistical function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "AVERAGE",
        Statistical,
        1,
        255,
        [Range],
        average,
        "AVERAGE(number1, [number2], …)",
        "Arithmetic mean.",
        "=AVERAGE(A1:A10)"
    ),
    fspec!(
        "AVERAGEA",
        Statistical,
        1,
        255,
        [Range],
        averagea,
        "AVERAGEA(value1, [value2], …)",
        "Mean counting text as 0 and TRUE as 1.",
        "=AVERAGEA(A1:A10)"
    ),
    fspec!(
        "AVERAGEIF",
        Statistical,
        2,
        3,
        [Range, Value, Range],
        averageif,
        "AVERAGEIF(range, criteria, [average_range])",
        "Mean of the cells that meet a criterion.",
        "=AVERAGEIF(A:A,\">0\")"
    ),
    FnSpec {
        repeat_from: 1,
        ..fspec!(
            "AVERAGEIFS",
            Statistical,
            3,
            255,
            [Range, Range, Value],
            averageifs,
            "AVERAGEIFS(average_range, criteria_range1, criteria1, …)",
            "Mean of the cells that meet several criteria.",
            "=AVERAGEIFS(C:C,A:A,\"x\")"
        )
    },
    fspec!(
        "COUNT",
        Statistical,
        1,
        255,
        [Range],
        count,
        "COUNT(value1, [value2], …)",
        "Counts numbers.",
        "=COUNT(A1:A10)"
    ),
    fspec!(
        "COUNTA",
        Statistical,
        1,
        255,
        [Range],
        counta,
        "COUNTA(value1, [value2], …)",
        "Counts non-empty values.",
        "=COUNTA(A1:A10)"
    ),
    fspec!(
        "COUNTBLANK",
        Statistical,
        1,
        1,
        [Range],
        countblank,
        "COUNTBLANK(range)",
        "Counts empty cells.",
        "=COUNTBLANK(A1:A10)"
    ),
    fspec!(
        "COUNTIF",
        Statistical,
        2,
        2,
        [Range, Value],
        countif,
        "COUNTIF(range, criteria)",
        "Counts cells that meet a criterion.",
        "=COUNTIF(A:A,\"apple\")"
    ),
    FnSpec {
        repeat_from: 0,
        ..fspec!(
            "COUNTIFS",
            Statistical,
            2,
            254,
            [Range, Value],
            countifs,
            "COUNTIFS(criteria_range1, criteria1, …)",
            "Counts cells that meet several criteria.",
            "=COUNTIFS(A:A,\"x\",B:B,\">0\")"
        )
    },
    fspec!(
        "MIN",
        Statistical,
        1,
        255,
        [Range],
        min,
        "MIN(number1, [number2], …)",
        "Smallest number.",
        "=MIN(A1:A10)"
    ),
    fspec!(
        "MAX",
        Statistical,
        1,
        255,
        [Range],
        max,
        "MAX(number1, [number2], …)",
        "Largest number.",
        "=MAX(A1:A10)"
    ),
    fspec!(
        "MINA",
        Statistical,
        1,
        255,
        [Range],
        mina,
        "MINA(value1, [value2], …)",
        "Smallest value counting text as 0.",
        "=MINA(A1:A10)"
    ),
    fspec!(
        "MAXA",
        Statistical,
        1,
        255,
        [Range],
        maxa,
        "MAXA(value1, [value2], …)",
        "Largest value counting text as 0.",
        "=MAXA(A1:A10)"
    ),
    FnSpec {
        repeat_from: 1,
        ..fspec!(
            "MINIFS",
            Statistical,
            3,
            255,
            [Range, Range, Value],
            minifs,
            "MINIFS(min_range, criteria_range1, criteria1, …)",
            "Smallest value meeting criteria.",
            "=MINIFS(C:C,A:A,\"x\")"
        )
    },
    FnSpec {
        repeat_from: 1,
        ..fspec!(
            "MAXIFS",
            Statistical,
            3,
            255,
            [Range, Range, Value],
            maxifs,
            "MAXIFS(max_range, criteria_range1, criteria1, …)",
            "Largest value meeting criteria.",
            "=MAXIFS(C:C,A:A,\"x\")"
        )
    },
    fspec!(
        "MEDIAN",
        Statistical,
        1,
        255,
        [Range],
        median_fn,
        "MEDIAN(number1, [number2], …)",
        "Median.",
        "=MEDIAN(1,2,3,4)"
    ),
    fspec!(
        "MODE.SNGL",
        Statistical,
        1,
        255,
        [Range],
        mode_fn,
        "MODE.SNGL(number1, [number2], …)",
        "Most frequent number.",
        "=MODE.SNGL(1,2,2,3)"
    ),
    fspec!(
        "MODE",
        Statistical,
        1,
        255,
        [Range],
        mode_fn,
        "MODE(number1, [number2], …)",
        "Most frequent number (legacy).",
        "=MODE(1,2,2,3)"
    ),
    fspec!(
        "STDEV.S",
        Statistical,
        1,
        255,
        [Range],
        stdev_s,
        "STDEV.S(number1, [number2], …)",
        "Sample standard deviation.",
        "=STDEV.S(A1:A10)"
    ),
    fspec!(
        "STDEV.P",
        Statistical,
        1,
        255,
        [Range],
        stdev_p,
        "STDEV.P(number1, [number2], …)",
        "Population standard deviation.",
        "=STDEV.P(A1:A10)"
    ),
    fspec!(
        "STDEV",
        Statistical,
        1,
        255,
        [Range],
        stdev_s,
        "STDEV(number1, [number2], …)",
        "Sample standard deviation (legacy).",
        "=STDEV(A1:A10)"
    ),
    fspec!(
        "VAR.S",
        Statistical,
        1,
        255,
        [Range],
        var_s,
        "VAR.S(number1, [number2], …)",
        "Sample variance.",
        "=VAR.S(A1:A10)"
    ),
    fspec!(
        "VAR.P",
        Statistical,
        1,
        255,
        [Range],
        var_p,
        "VAR.P(number1, [number2], …)",
        "Population variance.",
        "=VAR.P(A1:A10)"
    ),
    fspec!(
        "VAR",
        Statistical,
        1,
        255,
        [Range],
        var_s,
        "VAR(number1, [number2], …)",
        "Sample variance (legacy).",
        "=VAR(A1:A10)"
    ),
    fspec!(
        "LARGE",
        Statistical,
        2,
        2,
        [Range, Value],
        large,
        "LARGE(array, k)",
        "k-th largest value.",
        "=LARGE(A1:A10,2)"
    ),
    fspec!(
        "SMALL",
        Statistical,
        2,
        2,
        [Range, Value],
        small,
        "SMALL(array, k)",
        "k-th smallest value.",
        "=SMALL(A1:A10,2)"
    ),
    fspec!(
        "RANK.EQ",
        Statistical,
        2,
        3,
        [Value, Range, Value],
        rank_eq,
        "RANK.EQ(number, ref, [order])",
        "Rank of a number (ties share the top rank).",
        "=RANK.EQ(A1,A:A)"
    ),
    fspec!(
        "RANK",
        Statistical,
        2,
        3,
        [Value, Range, Value],
        rank_eq,
        "RANK(number, ref, [order])",
        "Rank of a number (legacy).",
        "=RANK(A1,A:A)"
    ),
    fspec!(
        "RANK.AVG",
        Statistical,
        2,
        3,
        [Value, Range, Value],
        rank_avg,
        "RANK.AVG(number, ref, [order])",
        "Rank of a number (ties averaged).",
        "=RANK.AVG(A1,A:A)"
    ),
    fspec!(
        "PERCENTILE.INC",
        Statistical,
        2,
        2,
        [Range, Value],
        percentile_inc_fn,
        "PERCENTILE.INC(array, k)",
        "k-th percentile, 0 ≤ k ≤ 1.",
        "=PERCENTILE.INC(A1:A10,0.9)"
    ),
    fspec!(
        "PERCENTILE",
        Statistical,
        2,
        2,
        [Range, Value],
        percentile_inc_fn,
        "PERCENTILE(array, k)",
        "k-th percentile (legacy).",
        "=PERCENTILE(A1:A10,0.9)"
    ),
    fspec!(
        "PERCENTILE.EXC",
        Statistical,
        2,
        2,
        [Range, Value],
        percentile_exc_fn,
        "PERCENTILE.EXC(array, k)",
        "k-th percentile, 0 < k < 1 exclusive.",
        "=PERCENTILE.EXC(A1:A10,0.9)"
    ),
    fspec!(
        "QUARTILE.INC",
        Statistical,
        2,
        2,
        [Range, Value],
        quartile_inc,
        "QUARTILE.INC(array, quart)",
        "Quartile (0–4).",
        "=QUARTILE.INC(A1:A10,1)"
    ),
    fspec!(
        "QUARTILE",
        Statistical,
        2,
        2,
        [Range, Value],
        quartile_inc,
        "QUARTILE(array, quart)",
        "Quartile (legacy).",
        "=QUARTILE(A1:A10,1)"
    ),
    fspec!(
        "PERCENTRANK.INC",
        Statistical,
        2,
        3,
        [Range, Value],
        percentrank_inc,
        "PERCENTRANK.INC(array, x, [significance])",
        "Rank of x as a percentage of the data.",
        "=PERCENTRANK.INC(A1:A10,5)"
    ),
    fspec!(
        "CORREL",
        Statistical,
        2,
        2,
        [Range],
        correl,
        "CORREL(array1, array2)",
        "Correlation coefficient.",
        "=CORREL(A1:A10,B1:B10)"
    ),
    fspec!(
        "COVARIANCE.S",
        Statistical,
        2,
        2,
        [Range],
        covariance_s,
        "COVARIANCE.S(array1, array2)",
        "Sample covariance.",
        "=COVARIANCE.S(A1:A10,B1:B10)"
    ),
    fspec!(
        "COVARIANCE.P",
        Statistical,
        2,
        2,
        [Range],
        covariance_p,
        "COVARIANCE.P(array1, array2)",
        "Population covariance.",
        "=COVARIANCE.P(A1:A10,B1:B10)"
    ),
    fspec!(
        "SLOPE",
        Statistical,
        2,
        2,
        [Range],
        slope,
        "SLOPE(known_ys, known_xs)",
        "Slope of the linear regression line.",
        "=SLOPE(B1:B10,A1:A10)"
    ),
    fspec!(
        "INTERCEPT",
        Statistical,
        2,
        2,
        [Range],
        intercept,
        "INTERCEPT(known_ys, known_xs)",
        "Intercept of the linear regression line.",
        "=INTERCEPT(B1:B10,A1:A10)"
    ),
    fspec!(
        "RSQ",
        Statistical,
        2,
        2,
        [Range],
        rsq,
        "RSQ(known_ys, known_xs)",
        "Square of the correlation coefficient.",
        "=RSQ(B1:B10,A1:A10)"
    ),
    fspec!(
        "FORECAST.LINEAR",
        Statistical,
        3,
        3,
        [Value, Range, Range],
        forecast,
        "FORECAST.LINEAR(x, known_ys, known_xs)",
        "Linear forecast at x.",
        "=FORECAST.LINEAR(11,B1:B10,A1:A10)"
    ),
    fspec!(
        "FORECAST",
        Statistical,
        3,
        3,
        [Value, Range, Range],
        forecast,
        "FORECAST(x, known_ys, known_xs)",
        "Linear forecast at x (legacy).",
        "=FORECAST(11,B1:B10,A1:A10)"
    ),
    fspec!(
        "TREND",
        Statistical,
        1,
        4,
        [Range],
        trend,
        "TREND(known_ys, [known_xs], [new_xs], [const])",
        "Values along a linear trend.",
        "=TREND(B1:B10,A1:A10,A11:A12)"
    ),
    fspec!(
        "GROWTH",
        Statistical,
        1,
        4,
        [Range],
        growth,
        "GROWTH(known_ys, [known_xs], [new_xs], [const])",
        "Values along an exponential trend.",
        "=GROWTH(B1:B10,A1:A10,A11:A12)"
    ),
    fspec!(
        "GEOMEAN",
        Statistical,
        1,
        255,
        [Range],
        geomean,
        "GEOMEAN(number1, [number2], …)",
        "Geometric mean.",
        "=GEOMEAN(2,8)"
    ),
    fspec!(
        "NORM.DIST",
        Statistical,
        4,
        4,
        [Value],
        norm_dist,
        "NORM.DIST(x, mean, standard_dev, cumulative)",
        "Normal distribution.",
        "=NORM.DIST(1,0,1,TRUE)"
    ),
    fspec!(
        "NORMDIST",
        Statistical,
        4,
        4,
        [Value],
        norm_dist,
        "NORMDIST(x, mean, standard_dev, cumulative)",
        "Normal distribution (legacy).",
        "=NORMDIST(1,0,1,TRUE)"
    ),
    fspec!(
        "NORM.INV",
        Statistical,
        3,
        3,
        [Value],
        norm_inv,
        "NORM.INV(probability, mean, standard_dev)",
        "Inverse of the normal distribution.",
        "=NORM.INV(0.95,0,1)"
    ),
    fspec!(
        "NORMINV",
        Statistical,
        3,
        3,
        [Value],
        norm_inv,
        "NORMINV(probability, mean, standard_dev)",
        "Inverse normal (legacy).",
        "=NORMINV(0.95,0,1)"
    ),
    fspec!(
        "NORM.S.DIST",
        Statistical,
        2,
        2,
        [Value],
        norm_s_dist,
        "NORM.S.DIST(z, cumulative)",
        "Standard normal distribution.",
        "=NORM.S.DIST(1.96,TRUE)"
    ),
    fspec!(
        "NORM.S.INV",
        Statistical,
        1,
        1,
        [Value],
        norm_s_inv,
        "NORM.S.INV(probability)",
        "Inverse standard normal distribution.",
        "=NORM.S.INV(0.975)"
    ),
];

/// Arithmetic mean (caller ensures non-empty).
pub fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}

/// Variance; `sample` selects n-1.
pub fn variance(v: &[f64], sample: bool) -> Result<f64, ErrorKind> {
    let n = v.len();
    if n == 0 || (sample && n < 2) {
        return Err(ErrorKind::Div0);
    }
    let m = mean(v);
    let ss: f64 = v.iter().map(|x| (x - m) * (x - m)).sum();
    Ok(ss / if sample { (n - 1) as f64 } else { n as f64 })
}

/// Standard deviation.
pub fn stdev(v: &[f64], sample: bool) -> Result<f64, ErrorKind> {
    variance(v, sample).map(f64::sqrt)
}

fn sorted(v: &[f64]) -> Vec<f64> {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    s
}

/// Median.
pub fn median(v: &[f64]) -> Result<f64, ErrorKind> {
    if v.is_empty() {
        return Err(ErrorKind::Num);
    }
    let s = sorted(v);
    let n = s.len();
    Ok(if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    })
}

/// MODE.SNGL: most frequent value, earliest on ties; `#N/A` when nothing repeats.
pub fn mode_sngl(v: &[f64]) -> Result<f64, ErrorKind> {
    let mut best: Option<(f64, usize)> = None;
    for (i, x) in v.iter().enumerate() {
        let c = v[i..].iter().filter(|y| *y == x).count();
        if v[..i].contains(x) {
            continue;
        }
        if c > 1 && best.is_none_or(|(_, bc)| c > bc) {
            best = Some((*x, c));
        }
    }
    best.map(|b| b.0).ok_or(ErrorKind::NA)
}

/// PERCENTILE.INC.
pub fn percentile_inc(v: &[f64], k: f64) -> Result<f64, ErrorKind> {
    if v.is_empty() || !(0.0..=1.0).contains(&k) {
        return Err(ErrorKind::Num);
    }
    let s = sorted(v);
    let h = k * (s.len() - 1) as f64;
    let lo = h.floor() as usize;
    let hi = (lo + 1).min(s.len() - 1);
    Ok(s[lo] + (h - lo as f64) * (s[hi] - s[lo]))
}

/// PERCENTILE.EXC.
pub fn percentile_exc(v: &[f64], k: f64) -> Result<f64, ErrorKind> {
    let n = v.len() as f64;
    if v.is_empty() || k <= 0.0 || k >= 1.0 {
        return Err(ErrorKind::Num);
    }
    let h = k * (n + 1.0);
    if h < 1.0 || h > n {
        return Err(ErrorKind::Num);
    }
    let s = sorted(v);
    let lo = h.floor() as usize - 1;
    let hi = (lo + 1).min(s.len() - 1);
    Ok(s[lo] + (h - h.floor()) * (s[hi] - s[lo]))
}

fn average(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, a)?;
    if v.is_empty() {
        return Err(ErrorKind::Div0);
    }
    num(mean(&v))
}
fn averagea(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums_a(ctx, a)?;
    if v.is_empty() {
        return Err(ErrorKind::Div0);
    }
    num(mean(&v))
}

fn masked_numbers(
    ctx: &mut EvalCtx,
    target: &Ev,
    pairs_: &[(Ev, Value)],
) -> Result<Vec<f64>, ErrorKind> {
    let (rows, cols, mask) = criteria_mask(ctx, pairs_)?;
    let vals = aligned_values(ctx, target, rows, cols)?;
    let mut out = Vec::new();
    for (m, v) in mask.iter().zip(vals.iter()) {
        if *m {
            match v {
                Value::Number(n) => out.push(*n),
                Value::Error(e) => return Err(*e),
                _ => {}
            }
        }
    }
    Ok(out)
}

fn averageif(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let crit = ctx.scalar(&a[1]);
    let target = match a.get(2) {
        None | Some(Ev::Missing) => a[0].clone(),
        Some(t) => t.clone(),
    };
    let v = masked_numbers(ctx, &target, &[(a[0].clone(), crit)])?;
    if v.is_empty() {
        return Err(ErrorKind::Div0);
    }
    num(mean(&v))
}
fn averageifs(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let p = pairs(ctx, &a[1..])?;
    let v = masked_numbers(ctx, &a[0], &p)?;
    if v.is_empty() {
        return Err(ErrorKind::Div0);
    }
    num(mean(&v))
}
fn minifs(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let p = pairs(ctx, &a[1..])?;
    let v = masked_numbers(ctx, &a[0], &p)?;
    num(v
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min)
        .min(if v.is_empty() { 0.0 } else { f64::INFINITY }))
}
fn maxifs(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let p = pairs(ctx, &a[1..])?;
    let v = masked_numbers(ctx, &a[0], &p)?;
    if v.is_empty() {
        return num(0.0);
    }
    num(v.iter().copied().fold(f64::NEG_INFINITY, f64::max))
}

fn count(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let mut n = 0.0;
    let d1904 = ctx.date1904();
    for ev in a {
        ctx.for_each_value(ev, &mut |v, from_ref| {
            match v {
                Value::Number(_) => n += 1.0,
                Value::Bool(_) if !from_ref => n += 1.0,
                Value::Text(_)
                    if !from_ref && crate::value::coerce_number_with(v, d1904).is_ok() =>
                {
                    n += 1.0
                }
                _ => {}
            }
            Ok(())
        })?;
    }
    num(n)
}
fn counta(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let mut n = 0.0;
    for ev in a {
        if matches!(ev, Ev::Missing) {
            n += 1.0;
            continue;
        }
        ctx.for_each_value(ev, &mut |v, from_ref| {
            if !v.is_empty() || !from_ref {
                n += 1.0;
            }
            Ok(())
        })?;
    }
    num(n)
}
fn countblank(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match &a[0] {
        Ev::R(area) => {
            let mut filled = 0u64;
            ctx.for_each_value(&a[0], &mut |v, _| {
                if !(v.is_empty() || matches!(v, Value::Text(s) if s.is_empty())) {
                    filled += 1;
                }
                Ok(())
            })?;
            num((area.size() - filled) as f64)
        }
        other => {
            let arr = ctx.to_array(other)?;
            num(arr
                .data()
                .iter()
                .filter(|v| v.is_empty() || matches!(v, Value::Text(s) if s.is_empty()))
                .count() as f64)
        }
    }
}
fn countif(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let crit = ctx.scalar(&a[1]);
    let (_, _, mask) = criteria_mask(ctx, &[(a[0].clone(), crit)])?;
    num(mask.iter().filter(|m| **m).count() as f64)
}
fn countifs(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let p = pairs(ctx, a)?;
    let (_, _, mask) = criteria_mask(ctx, &p)?;
    num(mask.iter().filter(|m| **m).count() as f64)
}
fn min(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, a)?;
    if v.is_empty() {
        return num(0.0);
    }
    num(v.iter().copied().fold(f64::INFINITY, f64::min))
}
fn max(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, a)?;
    if v.is_empty() {
        return num(0.0);
    }
    num(v.iter().copied().fold(f64::NEG_INFINITY, f64::max))
}
fn mina(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums_a(ctx, a)?;
    if v.is_empty() {
        return num(0.0);
    }
    num(v.iter().copied().fold(f64::INFINITY, f64::min))
}
fn maxa(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums_a(ctx, a)?;
    if v.is_empty() {
        return num(0.0);
    }
    num(v.iter().copied().fold(f64::NEG_INFINITY, f64::max))
}
fn median_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(median(&nums(ctx, a)?)?)
}
fn mode_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(mode_sngl(&nums(ctx, a)?)?)
}
fn stdev_s(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(stdev(&nums(ctx, a)?, true)?)
}
fn stdev_p(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(stdev(&nums(ctx, a)?, false)?)
}
fn var_s(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(variance(&nums(ctx, a)?, true)?)
}
fn var_p(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(variance(&nums(ctx, a)?, false)?)
}
fn kth(ctx: &mut EvalCtx, a: &[Ev], largest: bool) -> R {
    let v = sorted(&nums(ctx, &a[..1])?);
    let k = ctx.num(&a[1])?.ceil();
    if k < 1.0 || k as usize > v.len() {
        return Err(ErrorKind::Num);
    }
    let k = k as usize;
    num(if largest { v[v.len() - k] } else { v[k - 1] })
}
fn large(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    kth(ctx, a, true)
}
fn small(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    kth(ctx, a, false)
}
fn rank_common(ctx: &mut EvalCtx, a: &[Ev]) -> Result<(f64, f64, f64), ErrorKind> {
    let x = ctx.num(&a[0])?;
    let v = nums(ctx, &a[1..2])?;
    let asc = ctx.opt_num(a, 2, 0.0)? != 0.0;
    let better = v
        .iter()
        .filter(|y| if asc { **y < x } else { **y > x })
        .count() as f64;
    let equal = v.iter().filter(|y| **y == x).count() as f64;
    if equal == 0.0 {
        return Err(ErrorKind::NA);
    }
    Ok((x, better, equal))
}
fn rank_eq(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (_, better, _) = rank_common(ctx, a)?;
    num(better + 1.0)
}
fn rank_avg(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (_, better, equal) = rank_common(ctx, a)?;
    num(better + (equal + 1.0) / 2.0)
}
fn percentile_inc_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, &a[..1])?;
    let k = ctx.num(&a[1])?;
    num(percentile_inc(&v, k)?)
}
fn percentile_exc_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, &a[..1])?;
    let k = ctx.num(&a[1])?;
    num(percentile_exc(&v, k)?)
}
fn quartile_inc(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, &a[..1])?;
    let q = ctx.num(&a[1])?.trunc();
    if !(0.0..=4.0).contains(&q) {
        return Err(ErrorKind::Num);
    }
    num(percentile_inc(&v, q / 4.0)?)
}
fn percentrank_inc(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = sorted(&nums(ctx, &a[..1])?);
    let x = ctx.num(&a[1])?;
    let sig = ctx.opt_num(a, 2, 3.0)?.trunc();
    if v.is_empty() || sig < 1.0 {
        return Err(ErrorKind::Num);
    }
    let n = v.len();
    if x < v[0] || x > v[n - 1] {
        return Err(ErrorKind::NA);
    }
    if n == 1 {
        return num(1.0);
    }
    let rank = match v.iter().position(|y| *y == x) {
        Some(i) => i as f64 / (n - 1) as f64,
        None => {
            let i = v.iter().position(|y| *y > x).unwrap_or(n - 1);
            let (lo, hi) = (v[i - 1], v[i]);
            ((i - 1) as f64 + (x - lo) / (hi - lo)) / (n - 1) as f64
        }
    };
    let s = 10f64.powi(sig as i32);
    num((crate::value::round_sig15(rank * s)).floor() / s)
}

fn paired(ctx: &mut EvalCtx, ys: &Ev, xs: &Ev) -> Result<(Vec<f64>, Vec<f64>), ErrorKind> {
    let y = super::num_or_none(ctx, ys)?;
    let x = super::num_or_none(ctx, xs)?;
    if y.len() != x.len() {
        return Err(ErrorKind::NA);
    }
    let mut py = Vec::new();
    let mut px = Vec::new();
    for (a, b) in y.into_iter().zip(x) {
        if let (Some(a), Some(b)) = (a, b) {
            py.push(a);
            px.push(b);
        }
    }
    Ok((py, px))
}

fn regress(y: &[f64], x: &[f64]) -> Result<(f64, f64), ErrorKind> {
    if y.is_empty() {
        return Err(ErrorKind::Div0);
    }
    let (my, mx) = (mean(y), mean(x));
    let sxy: f64 = x.iter().zip(y).map(|(a, b)| (a - mx) * (b - my)).sum();
    let sxx: f64 = x.iter().map(|a| (a - mx) * (a - mx)).sum();
    if sxx == 0.0 {
        return Err(ErrorKind::Div0);
    }
    let slope = sxy / sxx;
    Ok((slope, my - slope * mx))
}

fn correl(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (y, x) = paired(ctx, &a[0], &a[1])?;
    if y.len() < 2 {
        return Err(ErrorKind::Div0);
    }
    let (my, mx) = (mean(&y), mean(&x));
    let sxy: f64 = x.iter().zip(&y).map(|(a, b)| (a - mx) * (b - my)).sum();
    let sxx: f64 = x.iter().map(|a| (a - mx).powi(2)).sum();
    let syy: f64 = y.iter().map(|b| (b - my).powi(2)).sum();
    if sxx == 0.0 || syy == 0.0 {
        return Err(ErrorKind::Div0);
    }
    num(sxy / (sxx * syy).sqrt())
}
fn covariance(ctx: &mut EvalCtx, a: &[Ev], sample: bool) -> R {
    let (y, x) = paired(ctx, &a[0], &a[1])?;
    let n = y.len();
    if n == 0 || (sample && n < 2) {
        return Err(ErrorKind::Div0);
    }
    let (my, mx) = (mean(&y), mean(&x));
    let s: f64 = x.iter().zip(&y).map(|(a, b)| (a - mx) * (b - my)).sum();
    num(s / if sample { (n - 1) as f64 } else { n as f64 })
}
fn covariance_s(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    covariance(ctx, a, true)
}
fn covariance_p(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    covariance(ctx, a, false)
}
fn slope(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (y, x) = paired(ctx, &a[0], &a[1])?;
    num(regress(&y, &x)?.0)
}
fn intercept(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (y, x) = paired(ctx, &a[0], &a[1])?;
    num(regress(&y, &x)?.1)
}
fn rsq(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match correl(ctx, a)? {
        Ev::V(Value::Number(r)) => num(r * r),
        other => Ok(other),
    }
}
fn forecast(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x0 = ctx.num(&a[0])?;
    let (y, x) = paired(ctx, &a[1], &a[2])?;
    let (m, b) = regress(&y, &x)?;
    num(m * x0 + b)
}

fn trend_impl(ctx: &mut EvalCtx, a: &[Ev], log: bool) -> R {
    let ys_arr = ctx.to_array(&a[0])?;
    let mut ys = Vec::new();
    for v in ys_arr.data() {
        match v {
            Value::Number(n) => ys.push(if log {
                if *n <= 0.0 {
                    return Err(ErrorKind::Num);
                }
                n.ln()
            } else {
                *n
            }),
            Value::Error(e) => return Err(*e),
            _ => return Err(ErrorKind::Value),
        }
    }
    let xs: Vec<f64> = match a.get(1) {
        None | Some(Ev::Missing) => (1..=ys.len()).map(|i| i as f64).collect(),
        Some(ev) => super::nums(ctx, std::slice::from_ref(ev))?,
    };
    if xs.len() != ys.len() {
        return Err(ErrorKind::Ref);
    }
    let constant = ctx.opt_bool(a, 3, true)?;
    let (m, b) = if constant {
        regress(&ys, &xs)?
    } else {
        let sxy: f64 = xs.iter().zip(&ys).map(|(x, y)| x * y).sum();
        let sxx: f64 = xs.iter().map(|x| x * x).sum();
        if sxx == 0.0 {
            return Err(ErrorKind::Div0);
        }
        (sxy / sxx, 0.0)
    };
    let new_arr = match a.get(2) {
        None | Some(Ev::Missing) => match a.get(1) {
            None | Some(Ev::Missing) => {
                Array::new(xs.len(), 1, xs.iter().map(|x| Value::Number(*x)).collect())
            }
            Some(ev) => ctx.to_array(ev)?,
        },
        Some(ev) => ctx.to_array(ev)?,
    };
    let out = new_arr.map(|v| match v.coerce_number() {
        Ok(x) => {
            let y = m * x + b;
            Value::number(if log { y.exp() } else { y })
        }
        Err(e) => Value::Error(e),
    });
    ok(Value::array(out))
}
fn trend(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    trend_impl(ctx, a, false)
}
fn growth(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    trend_impl(ctx, a, true)
}
fn geomean(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, a)?;
    if v.is_empty() || v.iter().any(|x| *x <= 0.0) {
        return Err(ErrorKind::Num);
    }
    num((v.iter().map(|x| x.ln()).sum::<f64>() / v.len() as f64).exp())
}

/// Complementary error function (double precision).
pub fn erfc(x: f64) -> f64 {
    if x < 0.0 {
        return 2.0 - erfc(-x);
    }
    if x < 3.0 {
        // erf(x) = 2/sqrt(pi) * exp(-x²) * Σ 2ⁿ x^(2n+1) / (1·3·…·(2n+1))
        let mut term = x;
        let mut sum = x;
        let x2 = x * x;
        let mut n = 0.0;
        while term > 1e-17 * sum {
            n += 1.0;
            term *= 2.0 * x2 / (2.0 * n + 1.0);
            sum += term;
            if n > 200.0 {
                break;
            }
        }
        let erf = 2.0 / std::f64::consts::PI.sqrt() * (-x2).exp() * sum;
        return 1.0 - erf;
    }
    // Continued fraction (Lentz).
    let tiny = 1e-300;
    let mut f = x;
    let mut c = x;
    let mut d = 0.0;
    for i in 1..300 {
        let an = i as f64 / 2.0;
        d = x + an * d;
        if d.abs() < tiny {
            d = tiny;
        }
        d = 1.0 / d;
        c = x + an / c;
        if c.abs() < tiny {
            c = tiny;
        }
        let delta = c * d;
        f *= delta;
        if (delta - 1.0).abs() < 1e-16 {
            break;
        }
    }
    (-x * x).exp() / (f * std::f64::consts::PI.sqrt())
}

/// Standard normal CDF.
pub fn norm_cdf(z: f64) -> f64 {
    0.5 * erfc(-z / std::f64::consts::SQRT_2)
}

/// Standard normal PDF.
pub fn norm_pdf(z: f64) -> f64 {
    (-0.5 * z * z).exp() / (2.0 * std::f64::consts::PI).sqrt()
}

/// Inverse standard normal CDF (Acklam + Newton refinement).
pub fn norm_inv_std(p: f64) -> Result<f64, ErrorKind> {
    if p <= 0.0 || p >= 1.0 {
        return Err(ErrorKind::Num);
    }
    const A: [f64; 6] = [
        -3.969683028665376e+01,
        2.209460984245205e+02,
        -2.759285104469687e+02,
        1.383_577_518_672_69e2,
        -3.066479806614716e+01,
        2.506628277459239e+00,
    ];
    const B: [f64; 5] = [
        -5.447609879822406e+01,
        1.615858368580409e+02,
        -1.556989798598866e+02,
        6.680131188771972e+01,
        -1.328068155288572e+01,
    ];
    const C: [f64; 6] = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e+00,
        -2.549732539343734e+00,
        4.374664141464968e+00,
        2.938163982698783e+00,
    ];
    const D: [f64; 4] = [
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e+00,
        3.754408661907416e+00,
    ];
    let plow = 0.02425;
    let mut x = if p < plow {
        let q = (-2.0 * p.ln()).sqrt();
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    } else if p <= 1.0 - plow {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    };
    for _ in 0..3 {
        let e = norm_cdf(x) - p;
        let d = norm_pdf(x);
        if d == 0.0 {
            break;
        }
        x -= e / d;
    }
    Ok(x)
}

fn norm_dist(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let m = ctx.num(&a[1])?;
    let s = ctx.num(&a[2])?;
    let cum = ctx.boolean(&a[3])?;
    if s <= 0.0 {
        return Err(ErrorKind::Num);
    }
    let z = (x - m) / s;
    num(if cum { norm_cdf(z) } else { norm_pdf(z) / s })
}
fn norm_inv(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let p = ctx.num(&a[0])?;
    let m = ctx.num(&a[1])?;
    let s = ctx.num(&a[2])?;
    if s <= 0.0 {
        return Err(ErrorKind::Num);
    }
    num(m + s * norm_inv_std(p)?)
}
fn norm_s_dist(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let z = ctx.num(&a[0])?;
    let cum = ctx.boolean(&a[1])?;
    num(if cum { norm_cdf(z) } else { norm_pdf(z) })
}
fn norm_s_inv(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(norm_inv_std(ctx.num(&a[0])?)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal() {
        assert!((norm_cdf(1.96) - 0.9750021048517795).abs() < 1e-14);
        assert!((norm_cdf(0.0) - 0.5).abs() < 1e-15);
        assert!((norm_cdf(-5.0) - 2.866515718791939e-7).abs() < 1e-18);
        assert!((norm_cdf(4.0) - 0.9999683287581669).abs() < 1e-14);
        let x = norm_inv_std(0.975).unwrap_or(0.0);
        assert!((x - 1.959963984540054).abs() < 1e-12);
        assert!((erfc(0.5) - 0.4795001221869535).abs() < 1e-15);
        assert!((erfc(3.5) - 7.430983723414128e-07).abs() < 1e-20);
    }

    #[test]
    fn percentiles() {
        let v = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(percentile_inc(&v, 0.5), Ok(2.5));
        assert_eq!(percentile_inc(&v, 0.25), Ok(1.75));
        assert_eq!(percentile_exc(&v, 0.25), Ok(1.25));
        assert_eq!(percentile_exc(&v, 0.1), Err(ErrorKind::Num));
        assert_eq!(mode_sngl(&[1.0, 2.0, 2.0, 3.0, 3.0]), Ok(2.0));
        assert_eq!(mode_sngl(&[1.0, 2.0]), Err(ErrorKind::NA));
        assert_eq!(median(&[3.0, 1.0, 2.0]), Ok(2.0));
    }
}
