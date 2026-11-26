//! Dynamic-array functions (D-14): FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, RANDARRAY, TAKE, DROP,
//! CHOOSECOLS, CHOOSEROWS, VSTACK, HSTACK, TEXTSPLIT.

use super::FnSpec;
use crate::eval::{Ev, EvalCtx, R, ok};
use crate::fspec;
use crate::limits::MAX_SPILL_CELLS;
use crate::value::{Array, ErrorKind, Value, lookup_eq, sort_cmp};
use std::cmp::Ordering;

/// Dynamic-array function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "FILTER",
        Dynamic,
        2,
        3,
        [Range],
        filter,
        "FILTER(array, include, [if_empty])",
        "Rows (or columns) where include is TRUE.",
        "=FILTER(A2:C10,B2:B10>5)"
    ),
    fspec!(
        "SORT",
        Dynamic,
        1,
        4,
        [Range],
        sort,
        "SORT(array, [sort_index], [sort_order], [by_col])",
        "Sorts the rows of an array.",
        "=SORT(A2:B10,2,-1)"
    ),
    fspec!(
        "SORTBY",
        Dynamic,
        2,
        255,
        [Range],
        sortby,
        "SORTBY(array, by_array1, [sort_order1], …)",
        "Sorts an array by other arrays.",
        "=SORTBY(A2:A10,B2:B10,-1)"
    ),
    fspec!(
        "UNIQUE",
        Dynamic,
        1,
        3,
        [Range],
        unique,
        "UNIQUE(array, [by_col], [exactly_once])",
        "Distinct rows of an array.",
        "=UNIQUE(A2:A10)"
    ),
    fspec!(
        "SEQUENCE",
        Dynamic,
        1,
        4,
        [Range],
        sequence,
        "SEQUENCE(rows, [columns], [start], [step])",
        "A sequence of numbers.",
        "=SEQUENCE(5)"
    ),
    FnSpec {
        volatile: true,
        ..fspec!(
            "RANDARRAY",
            Dynamic,
            0,
            5,
            [Range],
            randarray,
            "RANDARRAY([rows], [columns], [min], [max], [whole_number])",
            "An array of random numbers.",
            "=RANDARRAY(3,2)"
        )
    },
    fspec!(
        "TAKE",
        Dynamic,
        2,
        3,
        [Range],
        take,
        "TAKE(array, rows, [columns])",
        "First (or last, if negative) rows/columns.",
        "=TAKE(A1:C10,3)"
    ),
    fspec!(
        "DROP",
        Dynamic,
        2,
        3,
        [Range],
        drop,
        "DROP(array, rows, [columns])",
        "Removes rows/columns from the start (or end).",
        "=DROP(A1:C10,1)"
    ),
    fspec!(
        "CHOOSECOLS",
        Dynamic,
        2,
        255,
        [Range],
        choosecols,
        "CHOOSECOLS(array, col_num1, [col_num2], …)",
        "Selected columns.",
        "=CHOOSECOLS(A1:D10,1,3)"
    ),
    fspec!(
        "CHOOSEROWS",
        Dynamic,
        2,
        255,
        [Range],
        chooserows,
        "CHOOSEROWS(array, row_num1, [row_num2], …)",
        "Selected rows.",
        "=CHOOSEROWS(A1:D10,1,-1)"
    ),
    fspec!(
        "VSTACK",
        Dynamic,
        1,
        255,
        [Range],
        vstack,
        "VSTACK(array1, [array2], …)",
        "Stacks arrays vertically.",
        "=VSTACK(A1:B2,D1:E3)"
    ),
    fspec!(
        "HSTACK",
        Dynamic,
        1,
        255,
        [Range],
        hstack,
        "HSTACK(array1, [array2], …)",
        "Stacks arrays horizontally.",
        "=HSTACK(A1:A3,C1:C3)"
    ),
    fspec!(
        "TEXTSPLIT",
        Dynamic,
        2,
        6,
        [Range],
        textsplit,
        "TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with])",
        "Splits text into rows and columns.",
        "=TEXTSPLIT(\"a,b;c,d\",\",\",\";\")"
    ),
];

fn truthy(v: &Value) -> Result<bool, ErrorKind> {
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Number(n) => Ok(*n != 0.0),
        Value::Empty => Ok(false),
        Value::Error(e) => Err(*e),
        Value::Text(_) => Err(ErrorKind::Value),
        Value::Array(a) => truthy(a.get(0, 0)),
    }
}

fn check_size(r: usize, c: usize) -> Result<(), ErrorKind> {
    if r.saturating_mul(c) > MAX_SPILL_CELLS {
        return Err(ErrorKind::Num);
    }
    Ok(())
}

fn rows_of(arr: &Array) -> Vec<Vec<Value>> {
    (0..arr.rows()).map(|r| arr.row(r)).collect()
}

fn from_rows(rows: Vec<Vec<Value>>, cols: usize) -> Value {
    if rows.is_empty() {
        return Value::Error(ErrorKind::Calc);
    }
    let n = rows.len();
    Value::array(Array::new(n, cols, rows.into_iter().flatten().collect()))
}

fn filter(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arr = ctx.to_array(&a[0])?;
    let inc = ctx.to_array(&a[1])?;
    let empty = |ctx: &mut EvalCtx| -> R {
        match a.get(2) {
            None | Some(Ev::Missing) => Err(ErrorKind::Calc),
            Some(ev) => Ok(Ev::V(ctx.to_value(ev.clone()))),
        }
    };
    if inc.cols() == 1 && inc.rows() == arr.rows() {
        let mut keep = Vec::new();
        for r in 0..arr.rows() {
            if truthy(inc.get(r, 0))? {
                keep.push(arr.row(r));
            }
        }
        if keep.is_empty() {
            return empty(ctx);
        }
        return ok(from_rows(keep, arr.cols()));
    }
    if inc.rows() == 1 && inc.cols() == arr.cols() {
        let mut cols = Vec::new();
        for c in 0..arr.cols() {
            if truthy(inc.get(0, c))? {
                cols.push(c);
            }
        }
        if cols.is_empty() {
            return empty(ctx);
        }
        let mut data = Vec::new();
        for r in 0..arr.rows() {
            for &c in &cols {
                data.push(arr.get(r, c).clone());
            }
        }
        return ok(Value::array(Array::new(arr.rows(), cols.len(), data)));
    }
    Err(ErrorKind::Value)
}

fn idx_list(ctx: &mut EvalCtx, ev: Option<&Ev>, default: f64) -> Result<Vec<f64>, ErrorKind> {
    match ev {
        None | Some(Ev::Missing) => Ok(vec![default]),
        Some(e) => {
            let arr = ctx.to_array(e)?;
            arr.data().iter().map(|v| v.coerce_number()).collect()
        }
    }
}

fn sort(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arr = ctx.to_array(&a[0])?;
    let by_col = ctx.opt_bool(a, 3, false)?;
    let arr = if by_col { arr.transpose() } else { arr };
    let idx = idx_list(ctx, a.get(1), 1.0)?;
    let ord = idx_list(ctx, a.get(2), 1.0)?;
    let mut keys = Vec::new();
    for (k, i) in idx.iter().enumerate() {
        let i = i.trunc();
        if i < 1.0 || i as usize > arr.cols() {
            return Err(ErrorKind::Value);
        }
        let o = *ord.get(k).or(ord.first()).unwrap_or(&1.0);
        if o != 1.0 && o != -1.0 {
            return Err(ErrorKind::Value);
        }
        keys.push((i as usize - 1, o < 0.0));
    }
    let mut rows = rows_of(&arr);
    ctx.tick(rows.len() as u64 * 4)?;
    rows.sort_by(|x, y| {
        for (k, desc) in &keys {
            let o = sort_cmp(&x[*k], &y[*k]);
            let o = if *desc { o.reverse() } else { o };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    });
    let cols = arr.cols();
    let out = Array::new(rows.len(), cols, rows.into_iter().flatten().collect());
    ok(Value::array(if by_col { out.transpose() } else { out }))
}

fn sortby(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arr = ctx.to_array(&a[0])?;
    let mut keys: Vec<(Array, bool, bool)> = Vec::new(); // (key, desc, by_col)
    let mut i = 1;
    while i < a.len() {
        let k = ctx.to_array(&a[i])?;
        let order = ctx.opt_num(a, i + 1, 1.0)?;
        if order != 1.0 && order != -1.0 {
            return Err(ErrorKind::Value);
        }
        let by_col = if k.cols() == 1 && k.rows() == arr.rows() {
            false
        } else if k.rows() == 1 && k.cols() == arr.cols() {
            true
        } else {
            return Err(ErrorKind::Value);
        };
        keys.push((k, order < 0.0, by_col));
        i += 2;
    }
    let by_col = keys.first().map(|k| k.2).unwrap_or(false);
    if keys.iter().any(|k| k.2 != by_col) {
        return Err(ErrorKind::Value);
    }
    let n = if by_col { arr.cols() } else { arr.rows() };
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&x, &y| {
        for (k, desc, bc) in &keys {
            let (vx, vy) = if *bc {
                (k.get(0, x), k.get(0, y))
            } else {
                (k.get(x, 0), k.get(y, 0))
            };
            let o = sort_cmp(vx, vy);
            let o = if *desc { o.reverse() } else { o };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    });
    let mut data = Vec::with_capacity(arr.len());
    if by_col {
        for r in 0..arr.rows() {
            for &c in &order {
                data.push(arr.get(r, c).clone());
            }
        }
    } else {
        for &r in &order {
            data.extend(arr.row(r));
        }
    }
    ok(Value::array(Array::new(arr.rows(), arr.cols(), data)))
}

fn rows_equal(a: &[Value], b: &[Value]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| lookup_eq(x, y))
}

fn unique(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arr = ctx.to_array(&a[0])?;
    let by_col = ctx.opt_bool(a, 1, false)?;
    let once = ctx.opt_bool(a, 2, false)?;
    let arr = if by_col { arr.transpose() } else { arr };
    let rows = rows_of(&arr);
    ctx.tick((rows.len() as u64).saturating_mul(rows.len() as u64 / 16 + 1))?;
    let mut groups: Vec<(Vec<Value>, usize)> = Vec::new();
    for r in rows {
        match groups.iter_mut().find(|(g, _)| rows_equal(g, &r)) {
            Some(g) => g.1 += 1,
            None => groups.push((r, 1)),
        }
    }
    let kept: Vec<Vec<Value>> = groups
        .into_iter()
        .filter(|(_, n)| !once || *n == 1)
        .map(|(r, _)| r)
        .collect();
    if kept.is_empty() {
        return Err(ErrorKind::Calc);
    }
    let cols = arr.cols();
    let out = Array::new(kept.len(), cols, kept.into_iter().flatten().collect());
    ok(Value::array(if by_col { out.transpose() } else { out }))
}

fn sequence(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let r = ctx.num(&a[0])?.trunc();
    let c = ctx.opt_num(a, 1, 1.0)?.trunc();
    let start = ctx.opt_num(a, 2, 1.0)?;
    let step = ctx.opt_num(a, 3, 1.0)?;
    if r < 1.0 || c < 1.0 {
        return Err(ErrorKind::Calc);
    }
    let (r, c) = (r as usize, c as usize);
    check_size(r, c)?;
    ctx.tick((r * c) as u64)?;
    let data = (0..r * c)
        .map(|i| Value::number(start + step * i as f64))
        .collect();
    ok(Value::array(Array::new(r, c, data)))
}

fn randarray(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let r = ctx.opt_num(a, 0, 1.0)?.trunc();
    let c = ctx.opt_num(a, 1, 1.0)?.trunc();
    let lo = ctx.opt_num(a, 2, 0.0)?;
    let hi = ctx.opt_num(a, 3, 1.0)?;
    let int = ctx.opt_bool(a, 4, false)?;
    if r < 1.0 || c < 1.0 {
        return Err(ErrorKind::Calc);
    }
    if lo > hi {
        return Err(ErrorKind::Value);
    }
    let (r, c) = (r as usize, c as usize);
    check_size(r, c)?;
    ctx.tick((r * c) as u64)?;
    let mut data = Vec::with_capacity(r * c);
    for _ in 0..r * c {
        let x = ctx.host.random();
        data.push(Value::number(if int {
            lo.ceil() + (x * (hi.floor() - lo.ceil() + 1.0)).floor()
        } else {
            lo + x * (hi - lo)
        }));
    }
    ok(Value::array(Array::new(r, c, data)))
}

fn span(n: f64, len: usize, take: bool) -> Result<(usize, usize), ErrorKind> {
    let k = n.trunc();
    let kk = (k.abs() as usize).min(len);
    let (s, e) = if take {
        if k >= 0.0 { (0, kk) } else { (len - kk, len) }
    } else if k >= 0.0 {
        (kk, len)
    } else {
        (0, len - kk)
    };
    if s >= e {
        return Err(ErrorKind::Calc);
    }
    Ok((s, e))
}

fn take_drop(ctx: &mut EvalCtx, a: &[Ev], take: bool) -> R {
    let arr = ctx.to_array(&a[0])?;
    let (r0, r1) = match a.get(1) {
        None | Some(Ev::Missing) => (0, arr.rows()),
        Some(ev) => {
            let n = ctx.num(ev)?;
            if take && n == 0.0 {
                return Err(ErrorKind::Calc);
            }
            span(n, arr.rows(), take)?
        }
    };
    let (c0, c1) = match a.get(2) {
        None | Some(Ev::Missing) => (0, arr.cols()),
        Some(ev) => {
            let n = ctx.num(ev)?;
            if take && n == 0.0 {
                return Err(ErrorKind::Calc);
            }
            span(n, arr.cols(), take)?
        }
    };
    let mut data = Vec::new();
    for r in r0..r1 {
        for c in c0..c1 {
            data.push(arr.get(r, c).clone());
        }
    }
    ok(Value::array(Array::new(r1 - r0, c1 - c0, data)))
}
fn take(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    take_drop(ctx, a, true)
}
fn drop(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    take_drop(ctx, a, false)
}

fn pick_indices(ctx: &mut EvalCtx, a: &[Ev], len: usize) -> Result<Vec<usize>, ErrorKind> {
    let mut out = Vec::new();
    for ev in &a[1..] {
        let arr = ctx.to_array(ev)?;
        for v in arr.data() {
            let n = v.coerce_number()?.trunc();
            let idx = if n > 0.0 && n as usize <= len {
                n as usize - 1
            } else if n < 0.0 && (-n) as usize <= len {
                len - (-n) as usize
            } else {
                return Err(ErrorKind::Value);
            };
            out.push(idx);
        }
    }
    Ok(out)
}
fn choosecols(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arr = ctx.to_array(&a[0])?;
    let cols = pick_indices(ctx, a, arr.cols())?;
    let mut data = Vec::new();
    for r in 0..arr.rows() {
        for &c in &cols {
            data.push(arr.get(r, c).clone());
        }
    }
    ok(Value::array(Array::new(arr.rows(), cols.len(), data)))
}
fn chooserows(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arr = ctx.to_array(&a[0])?;
    let rows = pick_indices(ctx, a, arr.rows())?;
    let mut data = Vec::new();
    for &r in &rows {
        data.extend(arr.row(r));
    }
    ok(Value::array(Array::new(rows.len(), arr.cols(), data)))
}

fn vstack(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arrays: Vec<Array> = a
        .iter()
        .map(|e| ctx.to_array(e))
        .collect::<Result<_, _>>()?;
    let cols = arrays.iter().map(|x| x.cols()).max().unwrap_or(1);
    let rows: usize = arrays.iter().map(|x| x.rows()).sum();
    check_size(rows, cols)?;
    let mut data = Vec::with_capacity(rows * cols);
    for arr in &arrays {
        for r in 0..arr.rows() {
            for c in 0..cols {
                data.push(arr.get(r, c).clone());
            }
        }
    }
    ok(Value::array(Array::new(rows, cols, data)))
}
fn hstack(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arrays: Vec<Array> = a
        .iter()
        .map(|e| ctx.to_array(e))
        .collect::<Result<_, _>>()?;
    let rows = arrays.iter().map(|x| x.rows()).max().unwrap_or(1);
    let cols: usize = arrays.iter().map(|x| x.cols()).sum();
    check_size(rows, cols)?;
    let mut data = Vec::with_capacity(rows * cols);
    for r in 0..rows {
        for arr in &arrays {
            for c in 0..arr.cols() {
                data.push(arr.get(r, c).clone());
            }
        }
    }
    ok(Value::array(Array::new(rows, cols, data)))
}

fn delims(ctx: &mut EvalCtx, ev: Option<&Ev>) -> Result<Vec<String>, ErrorKind> {
    match ev {
        None | Some(Ev::Missing) => Ok(Vec::new()),
        Some(e) => {
            let arr = ctx.to_array(e)?;
            arr.data().iter().map(|v| v.coerce_text()).collect()
        }
    }
}

fn split_multi(s: &str, ds: &[String], ci: bool) -> Vec<String> {
    let ds: Vec<&String> = ds.iter().filter(|d| !d.is_empty()).collect();
    if ds.is_empty() {
        return vec![s.to_string()];
    }
    let hay = if ci { s.to_lowercase() } else { s.to_string() };
    let needles: Vec<String> = ds
        .iter()
        .map(|d| if ci { d.to_lowercase() } else { (*d).clone() })
        .collect();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < hay.len() {
        let mut hit = None;
        for n in &needles {
            if hay[i..].starts_with(n.as_str()) {
                hit = Some(n.len());
                break;
            }
        }
        if let Some(l) = hit {
            out.push(s.get(start..i).unwrap_or("").to_string());
            i += l;
            start = i;
        } else {
            i += hay[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
    }
    out.push(s.get(start..).unwrap_or("").to_string());
    out
}

fn textsplit(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let text = ctx.text(&a[0])?;
    let cd = delims(ctx, a.get(1))?;
    let rd = delims(ctx, a.get(2))?;
    let ignore = ctx.opt_bool(a, 3, false)?;
    let ci = ctx.opt_num(a, 4, 0.0)? == 1.0;
    let pad = match a.get(5) {
        None | Some(Ev::Missing) => Value::Error(ErrorKind::NA),
        Some(ev) => ctx.scalar(ev),
    };
    if cd.iter().all(|d| d.is_empty()) && rd.iter().all(|d| d.is_empty()) {
        return Err(ErrorKind::Value);
    }
    let mut rows: Vec<Vec<String>> = Vec::new();
    for line in split_multi(&text, &rd, ci) {
        if ignore && line.is_empty() {
            continue;
        }
        let mut cells = split_multi(&line, &cd, ci);
        if ignore {
            cells.retain(|c| !c.is_empty());
        }
        rows.push(cells);
    }
    if rows.is_empty() {
        return Err(ErrorKind::Calc);
    }
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(1);
    let n = rows.len();
    check_size(n, cols)?;
    let mut data = Vec::with_capacity(n * cols);
    for r in rows {
        let len = r.len();
        data.extend(r.into_iter().map(Value::text));
        for _ in len..cols {
            data.push(pad.clone());
        }
    }
    ok(Value::array(Array::new(n, cols, data)))
}
