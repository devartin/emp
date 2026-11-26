//! Logical functions (IF, IFS, IFERROR, IFNA, AND, OR, NOT, XOR, SWITCH, TRUE, FALSE, LET).

use super::FnSpec;
use crate::ast::Expr;
use crate::eval::{Ev, EvalCtx, R, ok};
use crate::value::{Array, ErrorKind, Value, lookup_eq};
use crate::{fspec, lspec};

/// Logical function table.
pub static SPECS: &[FnSpec] = &[
    lspec!(
        "IF",
        Logical,
        1,
        3,
        if_fn,
        "IF(logical_test, [value_if_true], [value_if_false])",
        "Returns one value if a condition is TRUE and another if it is FALSE.",
        "=IF(A1>10,\"big\",\"small\")"
    ),
    lspec!(
        "IFS",
        Logical,
        2,
        254,
        ifs,
        "IFS(logical_test1, value_if_true1, …)",
        "Returns the value of the first TRUE condition.",
        "=IFS(A1>90,\"A\",A1>80,\"B\",TRUE,\"C\")"
    ),
    lspec!(
        "IFERROR",
        Logical,
        2,
        2,
        iferror,
        "IFERROR(value, value_if_error)",
        "Returns value_if_error when value is an error.",
        "=IFERROR(1/0,0)"
    ),
    lspec!(
        "IFNA",
        Logical,
        2,
        2,
        ifna,
        "IFNA(value, value_if_na)",
        "Returns value_if_na when value is #N/A.",
        "=IFNA(VLOOKUP(1,A:B,2,0),\"none\")"
    ),
    fspec!(
        "AND",
        Logical,
        1,
        255,
        [Range],
        and,
        "AND(logical1, [logical2], …)",
        "TRUE when every argument is TRUE.",
        "=AND(A1>0,B1>0)"
    ),
    fspec!(
        "OR",
        Logical,
        1,
        255,
        [Range],
        or,
        "OR(logical1, [logical2], …)",
        "TRUE when any argument is TRUE.",
        "=OR(A1>0,B1>0)"
    ),
    fspec!(
        "XOR",
        Logical,
        1,
        255,
        [Range],
        xor,
        "XOR(logical1, [logical2], …)",
        "TRUE when an odd number of arguments are TRUE.",
        "=XOR(TRUE,FALSE)"
    ),
    fspec!(
        "NOT",
        Logical,
        1,
        1,
        [Value],
        not,
        "NOT(logical)",
        "Reverses a logical value.",
        "=NOT(TRUE)"
    ),
    lspec!(
        "SWITCH",
        Logical,
        3,
        254,
        switch,
        "SWITCH(expression, value1, result1, …, [default])",
        "Matches an expression against values.",
        "=SWITCH(A1,1,\"one\",2,\"two\",\"other\")"
    ),
    fspec!(
        "TRUE",
        Logical,
        0,
        0,
        [],
        true_fn,
        "TRUE()",
        "The logical value TRUE.",
        "=TRUE()"
    ),
    fspec!(
        "FALSE",
        Logical,
        0,
        0,
        [],
        false_fn,
        "FALSE()",
        "The logical value FALSE.",
        "=FALSE()"
    ),
    lspec!(
        "LET",
        Logical,
        3,
        255,
        let_fn,
        "LET(name1, value1, …, calculation)",
        "Names intermediate results.",
        "=LET(x,2,y,3,x*y)"
    ),
];

fn branch(ctx: &mut EvalCtx, args: &[Expr], i: usize, absent: Value) -> Ev {
    match args.get(i) {
        None => Ev::V(absent),
        Some(Expr::Missing) => Ev::V(Value::Number(0.0)),
        Some(e) => ctx.eval(e),
    }
}

fn truthy(v: &Value) -> Result<bool, ErrorKind> {
    match v {
        Value::Text(_) => v.coerce_bool(),
        other => other.coerce_bool(),
    }
}

fn if_fn(ctx: &mut EvalCtx, args: &[Expr]) -> R {
    let c = ctx.eval(&args[0]);
    let cv = ctx.to_value(c);
    if let Value::Array(cond) = &cv {
        let t = branch(ctx, args, 1, Value::Bool(true));
        let t = ctx.to_value(t);
        let f = branch(ctx, args, 2, Value::Bool(false));
        let f = ctx.to_value(f);
        let pick = |v: &Value, r: usize, c: usize| -> Value {
            match v {
                Value::Array(a) => a.get_broadcast(r, c).clone(),
                other => other.clone(),
            }
        };
        let dims = |v: &Value| match v {
            Value::Array(a) => (a.rows(), a.cols()),
            _ => (1, 1),
        };
        let (tr, tc) = dims(&t);
        let (fr, fc) = dims(&f);
        let rows = crate::eval::bdim(crate::eval::bdim(cond.rows(), tr), fr);
        let cols = crate::eval::bdim(crate::eval::bdim(cond.cols(), tc), fc);
        let mut data = Vec::with_capacity(rows * cols);
        for r in 0..rows {
            for c in 0..cols {
                let v = match truthy(cond.get_broadcast(r, c)) {
                    Ok(true) => pick(&t, r, c),
                    Ok(false) => pick(&f, r, c),
                    Err(e) => Value::Error(e),
                };
                data.push(v);
            }
        }
        return ok(Value::array(Array::new(rows, cols, data)));
    }
    if truthy(&cv)? {
        Ok(branch(ctx, args, 1, Value::Bool(true)))
    } else {
        Ok(branch(ctx, args, 2, Value::Bool(false)))
    }
}

fn ifs(ctx: &mut EvalCtx, args: &[Expr]) -> R {
    if !args.len().is_multiple_of(2) {
        return Err(ErrorKind::Value);
    }
    for pair in args.chunks(2) {
        let c = ctx.eval_value(&pair[0]);
        if truthy(c.scalar())? {
            return Ok(ctx.eval(&pair[1]));
        }
    }
    Err(ErrorKind::NA)
}

fn replace_errors(ctx: &mut EvalCtx, args: &[Expr], only_na: bool) -> R {
    let v = ctx.eval(&args[0]);
    let v = ctx.to_value(v);
    let is_hit = |x: &Value| match x {
        Value::Error(e) => !only_na || *e == ErrorKind::NA,
        _ => false,
    };
    match &v {
        Value::Array(a) => {
            if !a.data().iter().any(is_hit) {
                return ok(v);
            }
            let alt = ctx.eval_value(&args[1]);
            let mut data = Vec::with_capacity(a.len());
            for r in 0..a.rows() {
                for c in 0..a.cols() {
                    let x = a.get(r, c);
                    data.push(if is_hit(x) {
                        match &alt {
                            Value::Array(b) => b.get_broadcast(r, c).clone(),
                            other => other.clone(),
                        }
                    } else {
                        x.clone()
                    });
                }
            }
            ok(Value::array(Array::new(a.rows(), a.cols(), data)))
        }
        x if is_hit(x) => {
            let alt = ctx.eval(&args[1]);
            Ok(match alt {
                Ev::Missing => Ev::V(Value::Number(0.0)),
                other => other,
            })
        }
        Value::Empty => ok(Value::Number(0.0)),
        _ => ok(v),
    }
}

fn iferror(ctx: &mut EvalCtx, args: &[Expr]) -> R {
    replace_errors(ctx, args, false)
}
fn ifna(ctx: &mut EvalCtx, args: &[Expr]) -> R {
    replace_errors(ctx, args, true)
}

fn logicals(ctx: &mut EvalCtx, a: &[Ev]) -> Result<Vec<bool>, ErrorKind> {
    let mut out = Vec::new();
    for ev in a {
        ctx.for_each_value(ev, &mut |v, from_ref| {
            match v {
                Value::Bool(b) => out.push(*b),
                Value::Number(n) => out.push(*n != 0.0),
                Value::Error(e) => return Err(*e),
                Value::Text(_) if !from_ref => out.push(v.coerce_bool()?),
                _ => {}
            }
            Ok(())
        })?;
    }
    if out.is_empty() {
        return Err(ErrorKind::Value);
    }
    Ok(out)
}

fn and(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(logicals(ctx, a)?.iter().all(|b| *b))
}
fn or(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(logicals(ctx, a)?.iter().any(|b| *b))
}
fn xor(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(logicals(ctx, a)?.iter().filter(|b| **b).count() % 2 == 1)
}
fn not(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = ctx.scalar(&a[0]);
    ok(!truthy(&v)?)
}
fn true_fn(_: &mut EvalCtx, _: &[Ev]) -> R {
    ok(true)
}
fn false_fn(_: &mut EvalCtx, _: &[Ev]) -> R {
    ok(false)
}

fn switch(ctx: &mut EvalCtx, args: &[Expr]) -> R {
    let target = ctx.eval_value(&args[0]);
    if let Value::Error(e) = target {
        return Err(e);
    }
    let rest = &args[1..];
    let pairs = rest.len() / 2;
    for i in 0..pairs {
        let v = ctx.eval_value(&rest[2 * i]);
        if let Value::Error(e) = v {
            return Err(e);
        }
        if lookup_eq(target.scalar(), v.scalar()) {
            return Ok(ctx.eval(&rest[2 * i + 1]));
        }
    }
    if rest.len() % 2 == 1 {
        return Ok(ctx.eval(&rest[rest.len() - 1]));
    }
    Err(ErrorKind::NA)
}

fn let_fn(ctx: &mut EvalCtx, args: &[Expr]) -> R {
    if args.len().is_multiple_of(2) {
        return Err(ErrorKind::Value);
    }
    let mut pushed = 0;
    let n = args.len() / 2;
    for i in 0..n {
        let name = match &args[2 * i] {
            Expr::Name(n) => n.clone(),
            _ => {
                ctx.pop_scopes(pushed);
                return Err(ErrorKind::Value);
            }
        };
        let v = ctx.eval(&args[2 * i + 1]);
        if let Err(e) = ctx.push_scope(&name, v) {
            ctx.pop_scopes(pushed);
            return Err(e);
        }
        pushed += 1;
    }
    let r = ctx.eval(&args[args.len() - 1]);
    ctx.pop_scopes(pushed);
    Ok(r)
}
