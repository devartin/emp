//! Lookup and reference functions.

use super::FnSpec;
use crate::address::{col_to_letters, quote_sheet_name};
use crate::ast::{Expr, RefTarget};
use crate::criteria::{has_wildcards, wildcard_match};
use crate::eval::{Area, Ev, EvalCtx, R, num, ok};
use crate::limits::{MAX_COLS, MAX_ROWS};
use crate::parser::{Dialect, parse};
use crate::value::{Array, ErrorKind, Value, compare_values, lookup_eq};
use crate::{fspec, lspec};
use std::cmp::Ordering;

/// Lookup function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "VLOOKUP",
        Lookup,
        3,
        4,
        [Value, Range, Value, Value],
        vlookup,
        "VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])",
        "Looks down the first column and returns a value from another column.",
        "=VLOOKUP(\"b\",A1:C10,3,FALSE)"
    ),
    fspec!(
        "HLOOKUP",
        Lookup,
        3,
        4,
        [Value, Range, Value, Value],
        hlookup,
        "HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])",
        "Looks along the first row and returns a value from another row.",
        "=HLOOKUP(\"b\",A1:J3,2,FALSE)"
    ),
    FnSpec {
        returns_ref: true,
        ..fspec!(
            "XLOOKUP",
            Lookup,
            3,
            6,
            [Value, Range, Range, Range, Value, Value],
            xlookup,
            "XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])",
            "Searches a range and returns the matching item from another range.",
            "=XLOOKUP(\"b\",A:A,C:C,\"none\")"
        )
    },
    fspec!(
        "LOOKUP",
        Lookup,
        2,
        3,
        [Value, Range, Range],
        lookup_fn,
        "LOOKUP(lookup_value, lookup_vector, [result_vector])",
        "Approximate lookup in a sorted vector.",
        "=LOOKUP(5,A1:A10,B1:B10)"
    ),
    FnSpec {
        returns_ref: true,
        ..fspec!(
            "INDEX",
            Lookup,
            2,
            4,
            [Range, Value],
            index,
            "INDEX(array, row_num, [column_num], [area_num])",
            "Value or reference at a row and column.",
            "=INDEX(A1:C10,2,3)"
        )
    },
    fspec!(
        "MATCH",
        Lookup,
        2,
        3,
        [Value, Range, Value],
        match_fn,
        "MATCH(lookup_value, lookup_array, [match_type])",
        "Relative position of an item.",
        "=MATCH(\"b\",A1:A10,0)"
    ),
    fspec!(
        "XMATCH",
        Lookup,
        2,
        4,
        [Value, Range, Value, Value],
        xmatch,
        "XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])",
        "Relative position of an item (modern).",
        "=XMATCH(\"b\",A1:A10)"
    ),
    FnSpec {
        returns_ref: true,
        ..lspec!(
            "CHOOSE",
            Lookup,
            2,
            255,
            choose,
            "CHOOSE(index_num, value1, [value2], …)",
            "Chooses a value from a list by position.",
            "=CHOOSE(2,\"a\",\"b\",\"c\")"
        )
    },
    FnSpec {
        volatile: true,
        returns_ref: true,
        ..fspec!(
            "OFFSET",
            Lookup,
            3,
            5,
            [Range, Value],
            offset,
            "OFFSET(reference, rows, cols, [height], [width])",
            "Reference offset from a starting reference.",
            "=SUM(OFFSET(A1,1,0,3,1))"
        )
    },
    FnSpec {
        volatile: true,
        returns_ref: true,
        ..fspec!(
            "INDIRECT",
            Lookup,
            1,
            2,
            [Value],
            indirect,
            "INDIRECT(ref_text, [a1])",
            "Reference given by text.",
            "=INDIRECT(\"B\"&A1)"
        )
    },
    fspec!(
        "ROW",
        Lookup,
        0,
        1,
        [Range],
        row,
        "ROW([reference])",
        "Row number of a reference.",
        "=ROW(B5)"
    ),
    fspec!(
        "ROWS",
        Lookup,
        1,
        1,
        [Range],
        rows,
        "ROWS(array)",
        "Number of rows.",
        "=ROWS(A1:C10)"
    ),
    fspec!(
        "COLUMN",
        Lookup,
        0,
        1,
        [Range],
        column,
        "COLUMN([reference])",
        "Column number of a reference.",
        "=COLUMN(C1)"
    ),
    fspec!(
        "COLUMNS",
        Lookup,
        1,
        1,
        [Range],
        columns,
        "COLUMNS(array)",
        "Number of columns.",
        "=COLUMNS(A1:C10)"
    ),
    fspec!(
        "ADDRESS",
        Lookup,
        2,
        5,
        [Value],
        address,
        "ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])",
        "Cell address as text.",
        "=ADDRESS(2,3)"
    ),
    fspec!(
        "TRANSPOSE",
        Lookup,
        1,
        1,
        [Range],
        transpose,
        "TRANSPOSE(array)",
        "Swaps rows and columns.",
        "=TRANSPOSE(A1:C2)"
    ),
    fspec!(
        "HYPERLINK",
        Lookup,
        1,
        2,
        [Value],
        hyperlink,
        "HYPERLINK(link_location, [friendly_name])",
        "A clickable link; displays the friendly name.",
        "=HYPERLINK(\"https://example.com\",\"Site\")"
    ),
];

/// Find the index of `key` in `vals` with exact matching (wildcards optional).
pub fn find_exact(vals: &[Value], key: &Value, wildcards: bool, reverse: bool) -> Option<usize> {
    let wild = match key {
        Value::Text(t) if wildcards && has_wildcards(t) => Some(t.clone()),
        _ => None,
    };
    let test = |v: &Value| -> bool {
        match (&wild, v) {
            (Some(p), Value::Text(t)) => wildcard_match(p, t),
            (Some(_), _) => false,
            (None, v) => lookup_eq(v, key),
        }
    };
    if reverse {
        vals.iter().rposition(test)
    } else {
        vals.iter().position(test)
    }
}

fn same_class(a: &Value, b: &Value) -> bool {
    matches!(
        (a, b),
        (Value::Number(_), Value::Number(_))
            | (Value::Text(_), Value::Text(_))
            | (Value::Bool(_), Value::Bool(_))
    )
}

/// Approximate match on ascending data: last position whose value ≤ key (same type class).
pub fn find_approx_asc(vals: &[Value], key: &Value) -> Option<usize> {
    let mut cand = None;
    for (i, v) in vals.iter().enumerate() {
        if !same_class(v, key) {
            continue;
        }
        match compare_values(v, key) {
            Ordering::Greater => break,
            _ => cand = Some(i),
        }
    }
    cand
}

/// Approximate match on descending data: last position whose value ≥ key.
pub fn find_approx_desc(vals: &[Value], key: &Value) -> Option<usize> {
    let mut cand = None;
    for (i, v) in vals.iter().enumerate() {
        if !same_class(v, key) {
            continue;
        }
        match compare_values(v, key) {
            Ordering::Less => break,
            _ => cand = Some(i),
        }
    }
    cand
}

/// XLOOKUP/XMATCH core: returns the 0-based position.
pub fn xfind(
    vals: &[Value],
    key: &Value,
    match_mode: i32,
    search_mode: i32,
) -> Result<Option<usize>, ErrorKind> {
    let reverse = search_mode == -1;
    match search_mode {
        1 | -1 | 2 | -2 => {}
        _ => return Err(ErrorKind::Value),
    }
    match match_mode {
        0 => Ok(find_exact(vals, key, false, reverse)),
        2 => Ok(find_exact(vals, key, true, reverse)),
        -1 | 1 => {
            if let Some(i) = find_exact(vals, key, false, reverse) {
                return Ok(Some(i));
            }
            let mut best: Option<usize> = None;
            let order: Box<dyn Iterator<Item = usize>> = if reverse {
                Box::new((0..vals.len()).rev())
            } else {
                Box::new(0..vals.len())
            };
            for i in order {
                let v = &vals[i];
                if !same_class(v, key) {
                    continue;
                }
                let o = compare_values(v, key);
                let ok_side = if match_mode == -1 {
                    o == Ordering::Less
                } else {
                    o == Ordering::Greater
                };
                if !ok_side {
                    continue;
                }
                match best {
                    None => best = Some(i),
                    Some(b) => {
                        let better = if match_mode == -1 {
                            compare_values(v, &vals[b]) == Ordering::Greater
                        } else {
                            compare_values(v, &vals[b]) == Ordering::Less
                        };
                        if better {
                            best = Some(i);
                        }
                    }
                }
            }
            Ok(best)
        }
        _ => Err(ErrorKind::Value),
    }
}

fn vector(arr: &Array) -> Result<(Vec<Value>, bool), ErrorKind> {
    // returns (values, is_column)
    if arr.cols() == 1 {
        Ok((arr.col(0), true))
    } else if arr.rows() == 1 {
        Ok((arr.row(0), false))
    } else {
        Err(ErrorKind::NA)
    }
}

fn vlookup_impl(ctx: &mut EvalCtx, a: &[Ev], horizontal: bool) -> R {
    let key = ctx.scalar(&a[0]);
    if let Value::Error(e) = key {
        return Err(e);
    }
    let table = ctx.to_array(&a[1])?;
    let idx = ctx.num(&a[2])?.trunc();
    let approx = ctx.opt_bool(a, 3, true)?;
    if idx < 1.0 {
        return Err(ErrorKind::Value);
    }
    let limit = if horizontal {
        table.rows()
    } else {
        table.cols()
    };
    if idx as usize > limit {
        return Err(ErrorKind::Ref);
    }
    let keys = if horizontal {
        table.row(0)
    } else {
        table.col(0)
    };
    ctx.tick(keys.len() as u64)?;
    let pos = if approx {
        find_approx_asc(&keys, &key)
    } else {
        find_exact(&keys, &key, true, false)
    };
    let pos = pos.ok_or(ErrorKind::NA)?;
    let v = if horizontal {
        table.get(idx as usize - 1, pos)
    } else {
        table.get(pos, idx as usize - 1)
    };
    ok(v.clone())
}

fn vlookup(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    vlookup_impl(ctx, a, false)
}
fn hlookup(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    vlookup_impl(ctx, a, true)
}

fn xlookup(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let key = ctx.scalar(&a[0]);
    if let Value::Error(e) = key {
        return Err(e);
    }
    let look = ctx.to_array(&a[1])?;
    let (vals, is_col) = vector(&look).map_err(|_| ErrorKind::Value)?;
    let mm = ctx.opt_num(a, 4, 0.0)? as i32;
    let sm = ctx.opt_num(a, 5, 1.0)? as i32;
    ctx.tick(vals.len() as u64)?;
    let found = xfind(&vals, &key, mm, sm)?;
    let Some(i) = found else {
        return match a.get(3) {
            None | Some(Ev::Missing) => Err(ErrorKind::NA),
            Some(ev) => Ok(ev.clone()),
        };
    };
    // Return a reference when the return array is one.
    if let Ev::R(ra) = &a[2] {
        let ra = ctx.clip(*ra);
        if is_col {
            if ra.rows() as usize != vals.len() && !(ra.r0 == 0 && vals.len() <= ra.rows() as usize)
            {
                return Err(ErrorKind::Value);
            }
            let r = ra.r0 + i as u32;
            return Ok(Ev::R(Area {
                sheet: ra.sheet,
                r0: r,
                r1: r,
                c0: ra.c0,
                c1: ra.c1,
            }));
        } else {
            let c = ra.c0 + i as u32;
            return Ok(Ev::R(Area {
                sheet: ra.sheet,
                r0: ra.r0,
                r1: ra.r1,
                c0: c,
                c1: c,
            }));
        }
    }
    let ret = ctx.to_array(&a[2])?;
    if is_col {
        if ret.rows() != vals.len() {
            return Err(ErrorKind::Value);
        }
        ok(Value::array(Array::new(1, ret.cols(), ret.row(i))))
    } else {
        if ret.cols() != vals.len() {
            return Err(ErrorKind::Value);
        }
        ok(Value::array(Array::new(ret.rows(), 1, ret.col(i))))
    }
}

fn lookup_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let key = ctx.scalar(&a[0]);
    if let Value::Error(e) = key {
        return Err(e);
    }
    let look = ctx.to_array(&a[1])?;
    let (keys, result): (Vec<Value>, Vec<Value>) = match a.get(2) {
        Some(ev) if !matches!(ev, Ev::Missing) => {
            let (k, _) = vector(&look)?;
            let res = ctx.to_array(ev)?;
            let (r, _) = vector(&res)?;
            (k, r)
        }
        _ => {
            if look.cols() > look.rows() {
                (look.row(0), look.row(look.rows() - 1))
            } else {
                (look.col(0), look.col(look.cols() - 1))
            }
        }
    };
    let pos = find_approx_asc(&keys, &key).ok_or(ErrorKind::NA)?;
    ok(result
        .get(pos)
        .cloned()
        .unwrap_or(Value::Error(ErrorKind::NA)))
}

fn index(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let row = ctx.opt_num(a, 1, 0.0)?.trunc();
    let has_col = !matches!(a.get(2), None | Some(Ev::Missing));
    let col = ctx.opt_num(a, 2, 0.0)?.trunc();
    let area_n = ctx.opt_num(a, 3, 1.0)?.trunc();
    if row < 0.0 || col < 0.0 || area_n < 1.0 {
        return Err(ErrorKind::Value);
    }
    let area = match &a[0] {
        Ev::R(x) => Some(*x),
        Ev::U(list) => Some(*list.get(area_n as usize - 1).ok_or(ErrorKind::Ref)?),
        _ => None,
    };
    if let Some(ar) = area {
        let (rows, cols) = (ar.rows() as f64, ar.cols() as f64);
        // A single row/column with one index selects along it.
        let (r, c) = if !has_col && rows == 1.0 && cols > 1.0 {
            (1.0, row)
        } else {
            (row, col)
        };
        if r > rows || c > cols {
            return Err(ErrorKind::Ref);
        }
        let (r0, r1) = if r == 0.0 {
            (ar.r0, ar.r1)
        } else {
            (ar.r0 + r as u32 - 1, ar.r0 + r as u32 - 1)
        };
        let (c0, c1) = if c == 0.0 {
            (ar.c0, ar.c1)
        } else {
            (ar.c0 + c as u32 - 1, ar.c0 + c as u32 - 1)
        };
        return Ok(Ev::R(Area {
            sheet: ar.sheet,
            r0,
            c0,
            r1,
            c1,
        }));
    }
    let arr = ctx.to_array(&a[0])?;
    let (rows, cols) = (arr.rows() as f64, arr.cols() as f64);
    let (r, c) = if !has_col && rows == 1.0 {
        (1.0, row)
    } else {
        (row, col)
    };
    if r > rows || c > cols {
        return Err(ErrorKind::Ref);
    }
    match (r as usize, c as usize) {
        (0, 0) => ok(Value::array(arr)),
        (0, c) => ok(Value::array(Array::new(arr.rows(), 1, arr.col(c - 1)))),
        (r, 0) => ok(Value::array(Array::new(1, arr.cols(), arr.row(r - 1)))),
        (r, c) => ok(arr.get(r - 1, c - 1).clone()),
    }
}

fn match_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let key = ctx.scalar(&a[0]);
    if let Value::Error(e) = key {
        return Err(e);
    }
    let arr = ctx.to_array(&a[1])?;
    let (vals, _) = vector(&arr)?;
    let t = ctx.opt_num(a, 2, 1.0)?;
    ctx.tick(vals.len() as u64)?;
    let pos = if t == 0.0 {
        find_exact(&vals, &key, true, false)
    } else if t > 0.0 {
        find_approx_asc(&vals, &key)
    } else {
        find_approx_desc(&vals, &key)
    };
    num(pos.ok_or(ErrorKind::NA)? as f64 + 1.0)
}

fn xmatch(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let key = ctx.scalar(&a[0]);
    if let Value::Error(e) = key {
        return Err(e);
    }
    let arr = ctx.to_array(&a[1])?;
    let (vals, _) = vector(&arr).map_err(|_| ErrorKind::Value)?;
    let mm = ctx.opt_num(a, 2, 0.0)? as i32;
    let sm = ctx.opt_num(a, 3, 1.0)? as i32;
    ctx.tick(vals.len() as u64)?;
    num(xfind(&vals, &key, mm, sm)?.ok_or(ErrorKind::NA)? as f64 + 1.0)
}

fn choose(ctx: &mut EvalCtx, args: &[Expr]) -> R {
    let idx = ctx.eval(&args[0]);
    let idx = ctx.to_value(idx);
    let n = args.len() - 1;
    if let Value::Array(arr) = &idx {
        let mut data = Vec::with_capacity(arr.len());
        let mut cache: Vec<Option<Value>> = vec![None; n];
        for v in arr.data() {
            let r = match v.coerce_number() {
                Ok(i) if i >= 1.0 && (i.trunc() as usize) <= n => {
                    let k = i.trunc() as usize - 1;
                    if cache[k].is_none() {
                        let val = ctx.eval_value(&args[k + 1]);
                        cache[k] = Some(val);
                    }
                    cache[k]
                        .clone()
                        .map(|x| x.scalar().clone())
                        .unwrap_or(Value::Empty)
                }
                Ok(_) => Value::Error(ErrorKind::Value),
                Err(e) => Value::Error(e),
            };
            data.push(r);
        }
        return ok(Value::array(Array::new(arr.rows(), arr.cols(), data)));
    }
    let i = idx.coerce_number()?.trunc();
    if i < 1.0 || i as usize > n {
        return Err(ErrorKind::Value);
    }
    Ok(match ctx.eval(&args[i as usize]) {
        Ev::Missing => Ev::V(Value::Number(0.0)),
        other => other,
    })
}

fn offset(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let base = match &a[0] {
        Ev::R(x) => *x,
        Ev::V(Value::Error(e)) => return Err(*e),
        _ => return Err(ErrorKind::Value),
    };
    let dr = ctx.num(&a[1])?.trunc() as i64;
    let dc = ctx.num(&a[2])?.trunc() as i64;
    let h = ctx.opt_num(a, 3, base.rows() as f64)?.trunc() as i64;
    let w = ctx.opt_num(a, 4, base.cols() as f64)?.trunc() as i64;
    if h == 0 || w == 0 {
        return Err(ErrorKind::Ref);
    }
    let r0 = base.r0 as i64 + dr;
    let c0 = base.c0 as i64 + dc;
    let (r0, r1) = if h > 0 {
        (r0, r0 + h - 1)
    } else {
        (r0 + h + 1, r0)
    };
    let (c0, c1) = if w > 0 {
        (c0, c0 + w - 1)
    } else {
        (c0 + w + 1, c0)
    };
    if r0 < 0 || c0 < 0 || r1 >= MAX_ROWS as i64 || c1 >= MAX_COLS as i64 {
        return Err(ErrorKind::Ref);
    }
    Ok(Ev::R(Area {
        sheet: base.sheet,
        r0: r0 as u32,
        c0: c0 as u32,
        r1: r1 as u32,
        c1: c1 as u32,
    }))
}

/// Parse an R1C1 reference relative to `(row, col)`: `R1C1`, `R[-1]C[2]`, `RC`, with optional sheet.
fn parse_r1c1(s: &str, row: u32, col: u32) -> Option<(Option<String>, u32, u32)> {
    let (sheet, body) = match s.rfind('!') {
        Some(i) => (
            Some(s[..i].trim_matches('\'').replace("''", "'")),
            &s[i + 1..],
        ),
        None => (None, s),
    };
    let up = body.trim().to_ascii_uppercase();
    let rest = up.strip_prefix('R')?;
    let ci = rest.find('C')?;
    let (rpart, cpart) = (&rest[..ci], &rest[ci + 1..]);
    let comp = |p: &str, base: u32, max: u32| -> Option<u32> {
        if p.is_empty() {
            return Some(base);
        }
        if let Some(inner) = p.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            let d: i64 = inner.parse().ok()?;
            let v = base as i64 + d;
            return (0..max as i64).contains(&v).then_some(v as u32);
        }
        let n: u32 = p.parse().ok()?;
        (n >= 1 && n <= max).then(|| n - 1)
    };
    Some((
        sheet,
        comp(rpart, row, MAX_ROWS)?,
        comp(cpart, col, MAX_COLS)?,
    ))
}

fn indirect(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let text = ctx.text(&a[0])?;
    let a1 = ctx.opt_bool(a, 1, true)?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(ErrorKind::Ref);
    }
    if !a1 {
        let parts: Vec<&str> = text.split(':').collect();
        let mut cells = Vec::new();
        let mut sheet_name = None;
        for p in &parts {
            let (s, r, c) = parse_r1c1(p, ctx.row, ctx.col).ok_or(ErrorKind::Ref)?;
            if s.is_some() {
                sheet_name = s;
            }
            cells.push((r, c));
        }
        let sheet = match sheet_name {
            Some(n) => ctx.grid.sheet_by_name(&n).ok_or(ErrorKind::Ref)?,
            None => ctx.sheet,
        };
        let (r0, c0) = cells[0];
        let (r1, c1) = *cells.last().unwrap_or(&cells[0]);
        return Ok(Ev::R(Area {
            sheet,
            r0: r0.min(r1),
            c0: c0.min(c1),
            r1: r0.max(r1),
            c1: c0.max(c1),
        }));
    }
    let expr = parse(&text, Dialect::Excel).map_err(|_| ErrorKind::Ref)?;
    match &expr {
        Expr::Ref(r) if !matches!(r.target, RefTarget::Invalid) => Ok(ctx.eval(&expr)),
        Expr::Name(_) => match ctx.eval(&expr) {
            Ev::R(x) => Ok(Ev::R(x)),
            _ => Err(ErrorKind::Ref),
        },
        Expr::Binary(crate::ast::BinaryOp::Range, _, _) => match ctx.eval(&expr) {
            Ev::R(x) => Ok(Ev::R(x)),
            _ => Err(ErrorKind::Ref),
        },
        _ => Err(ErrorKind::Ref),
    }
}

fn row(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match a.first() {
        None | Some(Ev::Missing) => num(ctx.row as f64 + 1.0),
        Some(Ev::R(ar)) => {
            if ar.rows() == 1 {
                num(ar.r0 as f64 + 1.0)
            } else {
                let ar = ctx.clip(*ar);
                ok(Value::array(Array::new(
                    ar.rows() as usize,
                    1,
                    (ar.r0..=ar.r1)
                        .map(|r| Value::Number(r as f64 + 1.0))
                        .collect(),
                )))
            }
        }
        Some(Ev::V(Value::Error(e))) => Err(*e),
        _ => Err(ErrorKind::Value),
    }
}
fn column(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match a.first() {
        None | Some(Ev::Missing) => num(ctx.col as f64 + 1.0),
        Some(Ev::R(ar)) => {
            if ar.cols() == 1 {
                num(ar.c0 as f64 + 1.0)
            } else {
                let ar = ctx.clip(*ar);
                ok(Value::array(Array::new(
                    1,
                    ar.cols() as usize,
                    (ar.c0..=ar.c1)
                        .map(|c| Value::Number(c as f64 + 1.0))
                        .collect(),
                )))
            }
        }
        Some(Ev::V(Value::Error(e))) => Err(*e),
        _ => Err(ErrorKind::Value),
    }
}
fn rows(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match &a[0] {
        Ev::R(ar) => num(ar.rows() as f64),
        Ev::V(Value::Error(e)) => Err(*e),
        other => num(ctx.to_array(other)?.rows() as f64),
    }
}
fn columns(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match &a[0] {
        Ev::R(ar) => num(ar.cols() as f64),
        Ev::V(Value::Error(e)) => Err(*e),
        other => num(ctx.to_array(other)?.cols() as f64),
    }
}

fn address(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let r = ctx.num(&a[0])?.trunc();
    let c = ctx.num(&a[1])?.trunc();
    let abs = ctx.opt_num(a, 2, 1.0)?.trunc() as i32;
    let a1 = ctx.opt_bool(a, 3, true)?;
    let sheet = match a.get(4) {
        None | Some(Ev::Missing) => None,
        Some(ev) => Some(ctx.text(ev)?),
    };
    if r < 1.0 || c < 1.0 || r > MAX_ROWS as f64 || c > MAX_COLS as f64 || !(1..=4).contains(&abs) {
        return Err(ErrorKind::Value);
    }
    let (ra, ca) = match abs {
        1 => (true, true),
        2 => (true, false),
        3 => (false, true),
        _ => (false, false),
    };
    let body = if a1 {
        format!(
            "{}{}{}{}",
            if ca { "$" } else { "" },
            col_to_letters(c as u32 - 1),
            if ra { "$" } else { "" },
            r as u32
        )
    } else {
        let rp = if ra {
            format!("R{}", r as u32)
        } else {
            format!("R[{}]", r as u32)
        };
        let cp = if ca {
            format!("C{}", c as u32)
        } else {
            format!("C[{}]", c as u32)
        };
        rp + &cp
    };
    ok(match sheet {
        Some(s) if !s.is_empty() => format!("{}!{}", quote_sheet_name(&s), body),
        _ => body,
    })
}

fn transpose(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let arr = ctx.to_array(&a[0])?;
    ok(Value::array(arr.transpose()))
}

fn hyperlink(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match a.get(1) {
        Some(ev) if !matches!(ev, Ev::Missing) => ok(ctx.scalar(ev)),
        _ => ok(ctx.scalar(&a[0])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r1c1() {
        assert_eq!(parse_r1c1("R1C1", 5, 5), Some((None, 0, 0)));
        assert_eq!(parse_r1c1("R[-1]C[2]", 5, 5), Some((None, 4, 7)));
        assert_eq!(parse_r1c1("RC", 5, 5), Some((None, 5, 5)));
        assert_eq!(
            parse_r1c1("'My S'!R2C3", 0, 0),
            Some((Some("My S".into()), 1, 2))
        );
        assert_eq!(parse_r1c1("R[-10]C", 5, 5), None);
    }

    #[test]
    fn finders() {
        let v: Vec<Value> = [1.0, 3.0, 5.0, 7.0]
            .iter()
            .map(|x| Value::Number(*x))
            .collect();
        assert_eq!(find_approx_asc(&v, &Value::Number(6.0)), Some(2));
        assert_eq!(find_approx_asc(&v, &Value::Number(0.0)), None);
        assert_eq!(xfind(&v, &Value::Number(6.0), 1, 1), Ok(Some(3)));
        assert_eq!(xfind(&v, &Value::Number(6.0), -1, 1), Ok(Some(2)));
        let t: Vec<Value> = ["apple", "banana", "cherry"]
            .iter()
            .map(|s| Value::text(*s))
            .collect();
        assert_eq!(find_exact(&t, &Value::text("b*"), true, false), Some(1));
        assert_eq!(
            find_exact(&t, &Value::text("BANANA"), false, false),
            Some(1)
        );
    }
}
