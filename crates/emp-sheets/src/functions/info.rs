//! Information functions.

use super::FnSpec;
use crate::eval::{Ev, EvalCtx, R, num, ok};
use crate::fspec;
use crate::value::{ErrorKind, Value};

/// Information function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "ISBLANK",
        Information,
        1,
        1,
        [Value],
        isblank,
        "ISBLANK(value)",
        "TRUE if the cell is empty.",
        "=ISBLANK(A1)"
    ),
    fspec!(
        "ISNUMBER",
        Information,
        1,
        1,
        [Value],
        isnumber,
        "ISNUMBER(value)",
        "TRUE for numbers.",
        "=ISNUMBER(A1)"
    ),
    fspec!(
        "ISTEXT",
        Information,
        1,
        1,
        [Value],
        istext,
        "ISTEXT(value)",
        "TRUE for text.",
        "=ISTEXT(A1)"
    ),
    fspec!(
        "ISNONTEXT",
        Information,
        1,
        1,
        [Value],
        isnontext,
        "ISNONTEXT(value)",
        "TRUE for anything that is not text.",
        "=ISNONTEXT(A1)"
    ),
    fspec!(
        "ISLOGICAL",
        Information,
        1,
        1,
        [Value],
        islogical,
        "ISLOGICAL(value)",
        "TRUE for logical values.",
        "=ISLOGICAL(A1)"
    ),
    fspec!(
        "ISERROR",
        Information,
        1,
        1,
        [Value],
        iserror,
        "ISERROR(value)",
        "TRUE for any error.",
        "=ISERROR(1/0)"
    ),
    fspec!(
        "ISERR",
        Information,
        1,
        1,
        [Value],
        iserr,
        "ISERR(value)",
        "TRUE for any error except #N/A.",
        "=ISERR(NA())"
    ),
    fspec!(
        "ISNA",
        Information,
        1,
        1,
        [Value],
        isna,
        "ISNA(value)",
        "TRUE for #N/A.",
        "=ISNA(NA())"
    ),
    fspec!(
        "ISREF",
        Information,
        1,
        1,
        [Range],
        isref,
        "ISREF(value)",
        "TRUE for references.",
        "=ISREF(A1)"
    ),
    fspec!(
        "ISEVEN",
        Information,
        1,
        1,
        [Value],
        iseven,
        "ISEVEN(number)",
        "TRUE for even numbers.",
        "=ISEVEN(4)"
    ),
    fspec!(
        "ISODD",
        Information,
        1,
        1,
        [Value],
        isodd,
        "ISODD(number)",
        "TRUE for odd numbers.",
        "=ISODD(3)"
    ),
    fspec!(
        "ISFORMULA",
        Information,
        1,
        1,
        [Range],
        isformula,
        "ISFORMULA(reference)",
        "TRUE if the cell contains a formula.",
        "=ISFORMULA(A1)"
    ),
    fspec!(
        "NA",
        Information,
        0,
        0,
        [],
        na,
        "NA()",
        "The #N/A error.",
        "=NA()"
    ),
    fspec!(
        "N",
        Information,
        1,
        1,
        [Value],
        n,
        "N(value)",
        "Converts a value to a number.",
        "=N(TRUE)"
    ),
    fspec!(
        "TYPE",
        Information,
        1,
        1,
        [Range],
        type_fn,
        "TYPE(value)",
        "Type code: 1 number, 2 text, 4 logical, 16 error, 64 array.",
        "=TYPE(\"a\")"
    ),
    fspec!(
        "ERROR.TYPE",
        Information,
        1,
        1,
        [Value],
        error_type,
        "ERROR.TYPE(error_val)",
        "Number for an error type.",
        "=ERROR.TYPE(1/0)"
    ),
];

fn v(ctx: &mut EvalCtx, a: &[Ev]) -> Value {
    ctx.scalar(&a[0])
}
fn isblank(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(v(ctx, a), Value::Empty))
}
fn isnumber(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(v(ctx, a), Value::Number(_)))
}
fn istext(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(v(ctx, a), Value::Text(_)))
}
fn isnontext(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(!matches!(v(ctx, a), Value::Text(_)))
}
fn islogical(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(v(ctx, a), Value::Bool(_)))
}
fn iserror(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(v(ctx, a), Value::Error(_)))
}
fn iserr(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(v(ctx, a), Value::Error(e) if e != ErrorKind::NA))
}
fn isna(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(v(ctx, a), Value::Error(ErrorKind::NA)))
}
fn isref(_: &mut EvalCtx, a: &[Ev]) -> R {
    ok(matches!(a[0], Ev::R(_) | Ev::U(_)))
}
fn parity(ctx: &mut EvalCtx, a: &[Ev]) -> Result<bool, ErrorKind> {
    let x = match v(ctx, a) {
        Value::Bool(_) => return Err(ErrorKind::Value),
        other => crate::value::coerce_number_with(&other, ctx.date1904())?,
    };
    Ok((x.trunc() as i64) % 2 == 0)
}
fn iseven(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(parity(ctx, a)?)
}
fn isodd(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(!parity(ctx, a)?)
}
fn isformula(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match &a[0] {
        Ev::R(ar) => ok(ctx.grid.is_formula(ar.sheet, ar.r0, ar.c0)),
        Ev::V(Value::Error(e)) => Err(*e),
        _ => Err(ErrorKind::Value),
    }
}
fn na(_: &mut EvalCtx, _: &[Ev]) -> R {
    Err(ErrorKind::NA)
}
fn n(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match v(ctx, a) {
        Value::Number(x) => num(x),
        Value::Bool(b) => num(if b { 1.0 } else { 0.0 }),
        Value::Error(e) => Err(e),
        _ => num(0.0),
    }
}
fn type_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match &a[0] {
        Ev::R(ar) if !ar.is_cell() => num(64.0),
        Ev::U(_) => num(16.0),
        other => {
            let val = ctx.scalar(other);
            match other {
                Ev::V(Value::Array(_)) => num(64.0),
                _ => num(val.type_code()),
            }
        }
    }
}
fn error_type(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match v(ctx, a) {
        Value::Error(e) => num(e.type_code()),
        _ => Err(ErrorKind::NA),
    }
}
