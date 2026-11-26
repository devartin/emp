//! Math and trigonometry functions.

use super::{FnSpec, nums};
use crate::criteria::Criterion;
use crate::eval::{Ev, EvalCtx, R, num};
use crate::fspec;
use crate::value::{Array, ErrorKind, Value, round_sig15};

/// Math function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "SUM",
        Math,
        1,
        255,
        [Range],
        sum,
        "SUM(number1, [number2], …)",
        "Adds all the numbers.",
        "=SUM(A1:A10)"
    ),
    fspec!(
        "SUMIF",
        Math,
        2,
        3,
        [Range, Value, Range],
        sumif,
        "SUMIF(range, criteria, [sum_range])",
        "Adds the cells that meet a criterion.",
        "=SUMIF(A:A,\">10\")"
    ),
    FnSpec {
        repeat_from: 1,
        ..fspec!(
            "SUMIFS",
            Math,
            3,
            255,
            [Range, Range, Value],
            sumifs,
            "SUMIFS(sum_range, criteria_range1, criteria1, …)",
            "Adds the cells that meet several criteria.",
            "=SUMIFS(C:C,A:A,\"x\",B:B,\">0\")"
        )
    },
    fspec!(
        "SUMPRODUCT",
        Math,
        1,
        255,
        [Range],
        sumproduct,
        "SUMPRODUCT(array1, [array2], …)",
        "Multiplies corresponding entries and sums the products.",
        "=SUMPRODUCT(A1:A3,B1:B3)"
    ),
    fspec!(
        "SUMSQ",
        Math,
        1,
        255,
        [Range],
        sumsq,
        "SUMSQ(number1, [number2], …)",
        "Sum of the squares.",
        "=SUMSQ(3,4)"
    ),
    fspec!(
        "PRODUCT",
        Math,
        1,
        255,
        [Range],
        product,
        "PRODUCT(number1, [number2], …)",
        "Multiplies all the numbers.",
        "=PRODUCT(2,3,4)"
    ),
    fspec!(
        "QUOTIENT",
        Math,
        2,
        2,
        [Value],
        quotient,
        "QUOTIENT(numerator, denominator)",
        "Integer part of a division.",
        "=QUOTIENT(7,2)"
    ),
    fspec!(
        "MOD",
        Math,
        2,
        2,
        [Value],
        modf,
        "MOD(number, divisor)",
        "Remainder after division (sign of the divisor).",
        "=MOD(-3,2)"
    ),
    fspec!(
        "ABS",
        Math,
        1,
        1,
        [Value],
        abs,
        "ABS(number)",
        "Absolute value.",
        "=ABS(-2)"
    ),
    fspec!(
        "SIGN",
        Math,
        1,
        1,
        [Value],
        sign,
        "SIGN(number)",
        "1, 0 or -1 depending on the sign.",
        "=SIGN(-5)"
    ),
    fspec!(
        "INT",
        Math,
        1,
        1,
        [Value],
        int,
        "INT(number)",
        "Rounds down to the nearest integer.",
        "=INT(-2.5)"
    ),
    fspec!(
        "TRUNC",
        Math,
        1,
        2,
        [Value],
        trunc,
        "TRUNC(number, [num_digits])",
        "Truncates to a number of digits.",
        "=TRUNC(2.789,1)"
    ),
    fspec!(
        "ROUND",
        Math,
        2,
        2,
        [Value],
        round,
        "ROUND(number, num_digits)",
        "Rounds half away from zero.",
        "=ROUND(2.675,2)"
    ),
    fspec!(
        "ROUNDUP",
        Math,
        2,
        2,
        [Value],
        roundup,
        "ROUNDUP(number, num_digits)",
        "Rounds away from zero.",
        "=ROUNDUP(2.11,1)"
    ),
    fspec!(
        "ROUNDDOWN",
        Math,
        2,
        2,
        [Value],
        rounddown,
        "ROUNDDOWN(number, num_digits)",
        "Rounds toward zero.",
        "=ROUNDDOWN(2.19,1)"
    ),
    fspec!(
        "MROUND",
        Math,
        2,
        2,
        [Value],
        mround,
        "MROUND(number, multiple)",
        "Rounds to the nearest multiple.",
        "=MROUND(10,3)"
    ),
    fspec!(
        "CEILING",
        Math,
        2,
        2,
        [Value],
        ceiling,
        "CEILING(number, significance)",
        "Rounds up to a multiple of significance.",
        "=CEILING(2.5,1)"
    ),
    fspec!(
        "CEILING.MATH",
        Math,
        1,
        3,
        [Value],
        ceiling_math,
        "CEILING.MATH(number, [significance], [mode])",
        "Rounds up to a multiple; mode controls negatives.",
        "=CEILING.MATH(-2.5)"
    ),
    fspec!(
        "FLOOR",
        Math,
        2,
        2,
        [Value],
        floor,
        "FLOOR(number, significance)",
        "Rounds down to a multiple of significance.",
        "=FLOOR(2.5,1)"
    ),
    fspec!(
        "FLOOR.MATH",
        Math,
        1,
        3,
        [Value],
        floor_math,
        "FLOOR.MATH(number, [significance], [mode])",
        "Rounds down to a multiple; mode controls negatives.",
        "=FLOOR.MATH(-2.5)"
    ),
    fspec!(
        "EVEN",
        Math,
        1,
        1,
        [Value],
        even,
        "EVEN(number)",
        "Rounds away from zero to an even integer.",
        "=EVEN(3)"
    ),
    fspec!(
        "ODD",
        Math,
        1,
        1,
        [Value],
        odd,
        "ODD(number)",
        "Rounds away from zero to an odd integer.",
        "=ODD(2)"
    ),
    fspec!(
        "SQRT",
        Math,
        1,
        1,
        [Value],
        sqrt,
        "SQRT(number)",
        "Square root.",
        "=SQRT(16)"
    ),
    fspec!(
        "POWER",
        Math,
        2,
        2,
        [Value],
        power,
        "POWER(number, power)",
        "Raises a number to a power.",
        "=POWER(2,10)"
    ),
    fspec!(
        "EXP",
        Math,
        1,
        1,
        [Value],
        exp,
        "EXP(number)",
        "e raised to a power.",
        "=EXP(1)"
    ),
    fspec!(
        "LN",
        Math,
        1,
        1,
        [Value],
        ln,
        "LN(number)",
        "Natural logarithm.",
        "=LN(10)"
    ),
    fspec!(
        "LOG",
        Math,
        1,
        2,
        [Value],
        log,
        "LOG(number, [base])",
        "Logarithm to a base (default 10).",
        "=LOG(8,2)"
    ),
    fspec!(
        "LOG10",
        Math,
        1,
        1,
        [Value],
        log10,
        "LOG10(number)",
        "Base-10 logarithm.",
        "=LOG10(1000)"
    ),
    fspec!("PI", Math, 0, 0, [], pi, "PI()", "The number π.", "=PI()"),
    FnSpec {
        volatile: true,
        ..fspec!(
            "RAND",
            Math,
            0,
            0,
            [],
            rand,
            "RAND()",
            "Random number between 0 and 1.",
            "=RAND()"
        )
    },
    FnSpec {
        volatile: true,
        ..fspec!(
            "RANDBETWEEN",
            Math,
            2,
            2,
            [Value],
            randbetween,
            "RANDBETWEEN(bottom, top)",
            "Random integer between two numbers.",
            "=RANDBETWEEN(1,6)"
        )
    },
    fspec!(
        "GCD",
        Math,
        1,
        255,
        [Range],
        gcd,
        "GCD(number1, [number2], …)",
        "Greatest common divisor.",
        "=GCD(24,36)"
    ),
    fspec!(
        "LCM",
        Math,
        1,
        255,
        [Range],
        lcm,
        "LCM(number1, [number2], …)",
        "Least common multiple.",
        "=LCM(4,6)"
    ),
    fspec!(
        "FACT",
        Math,
        1,
        1,
        [Value],
        fact,
        "FACT(number)",
        "Factorial.",
        "=FACT(5)"
    ),
    fspec!(
        "COMBIN",
        Math,
        2,
        2,
        [Value],
        combin,
        "COMBIN(number, number_chosen)",
        "Number of combinations.",
        "=COMBIN(5,2)"
    ),
    fspec!(
        "PERMUT",
        Math,
        2,
        2,
        [Value],
        permut,
        "PERMUT(number, number_chosen)",
        "Number of permutations.",
        "=PERMUT(5,2)"
    ),
    fspec!(
        "SUBTOTAL",
        Math,
        2,
        255,
        [Value, Range],
        subtotal,
        "SUBTOTAL(function_num, ref1, [ref2], …)",
        "Aggregate (1–11 / 101–111) of references.",
        "=SUBTOTAL(9,A1:A10)"
    ),
    fspec!(
        "AGGREGATE",
        Math,
        3,
        255,
        [Value, Value, Range],
        aggregate,
        "AGGREGATE(function_num, options, ref1, [ref2], …)",
        "Aggregate that can ignore errors.",
        "=AGGREGATE(9,6,A1:A10)"
    ),
    fspec!(
        "DEGREES",
        Math,
        1,
        1,
        [Value],
        degrees,
        "DEGREES(angle)",
        "Radians to degrees.",
        "=DEGREES(PI())"
    ),
    fspec!(
        "RADIANS",
        Math,
        1,
        1,
        [Value],
        radians,
        "RADIANS(angle)",
        "Degrees to radians.",
        "=RADIANS(180)"
    ),
    fspec!(
        "SIN",
        Math,
        1,
        1,
        [Value],
        sin,
        "SIN(number)",
        "Sine.",
        "=SIN(PI()/2)"
    ),
    fspec!(
        "COS",
        Math,
        1,
        1,
        [Value],
        cos,
        "COS(number)",
        "Cosine.",
        "=COS(0)"
    ),
    fspec!(
        "TAN",
        Math,
        1,
        1,
        [Value],
        tan,
        "TAN(number)",
        "Tangent.",
        "=TAN(PI()/4)"
    ),
    fspec!(
        "ASIN",
        Math,
        1,
        1,
        [Value],
        asin,
        "ASIN(number)",
        "Arcsine.",
        "=ASIN(1)"
    ),
    fspec!(
        "ACOS",
        Math,
        1,
        1,
        [Value],
        acos,
        "ACOS(number)",
        "Arccosine.",
        "=ACOS(1)"
    ),
    fspec!(
        "ATAN",
        Math,
        1,
        1,
        [Value],
        atan,
        "ATAN(number)",
        "Arctangent.",
        "=ATAN(1)"
    ),
    fspec!(
        "ATAN2",
        Math,
        2,
        2,
        [Value],
        atan2,
        "ATAN2(x_num, y_num)",
        "Arctangent of x and y coordinates.",
        "=ATAN2(1,1)"
    ),
];

fn sum(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(nums(ctx, a)?.iter().sum())
}

fn sumsq(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(nums(ctx, a)?.iter().map(|x| x * x).sum())
}

fn product(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = nums(ctx, a)?;
    if v.is_empty() {
        return num(0.0);
    }
    num(v.iter().product())
}

/// Evaluate the `(range, criterion)` pairs into a mask over the shape of the first range.
pub(crate) fn criteria_mask(
    ctx: &mut EvalCtx,
    pairs: &[(Ev, Value)],
) -> Result<(usize, usize, Vec<bool>), ErrorKind> {
    let d1904 = ctx.date1904();
    let mut shape: Option<(usize, usize)> = None;
    let mut mask: Vec<bool> = Vec::new();
    for (range, crit) in pairs {
        let arr = ctx.to_array(range)?;
        let (r, c) = (arr.rows(), arr.cols());
        match shape {
            None => {
                shape = Some((r, c));
                mask = vec![true; r * c];
            }
            Some((sr, sc)) if sr != r || sc != c => return Err(ErrorKind::Value),
            _ => {}
        }
        let cr = Criterion::new(crit, d1904);
        ctx.tick(arr.len() as u64)?;
        for (m, v) in mask.iter_mut().zip(arr.data()) {
            if *m && !cr.matches(v) {
                *m = false;
            }
        }
    }
    let (r, c) = shape.unwrap_or((1, 1));
    Ok((r, c, mask))
}

/// Values of `target` aligned to a mask shape starting at its top-left (Excel resizes the sum range).
pub(crate) fn aligned_values(
    ctx: &mut EvalCtx,
    target: &Ev,
    rows: usize,
    cols: usize,
) -> Result<Vec<Value>, ErrorKind> {
    let arr = match target {
        Ev::R(a) => {
            let a2 = crate::eval::Area {
                sheet: a.sheet,
                r0: a.r0,
                c0: a.c0,
                r1: (a.r0 as usize + rows - 1).min(crate::limits::MAX_ROWS as usize - 1) as u32,
                c1: (a.c0 as usize + cols - 1).min(crate::limits::MAX_COLS as usize - 1) as u32,
            };
            ctx.area_array(a2)?
        }
        other => {
            let a = ctx.to_array(other)?;
            if a.rows() != rows || a.cols() != cols {
                return Err(ErrorKind::Value);
            }
            a
        }
    };
    let mut out = Vec::with_capacity(rows * cols);
    for r in 0..rows {
        for c in 0..cols {
            out.push(arr.get(r, c).clone());
        }
    }
    Ok(out)
}

fn sumif(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let crit = ctx.scalar(&a[1]);
    let (rows, cols, mask) = criteria_mask(ctx, &[(a[0].clone(), crit)])?;
    let target = match a.get(2) {
        Some(Ev::Missing) | None => a[0].clone(),
        Some(t) => t.clone(),
    };
    let vals = aligned_values(ctx, &target, rows, cols)?;
    let mut s = 0.0;
    for (m, v) in mask.iter().zip(vals.iter()) {
        if *m {
            match v {
                Value::Number(n) => s += n,
                Value::Error(e) => return Err(*e),
                _ => {}
            }
        }
    }
    num(s)
}

pub(crate) fn pairs(ctx: &mut EvalCtx, a: &[Ev]) -> Result<Vec<(Ev, Value)>, ErrorKind> {
    if !a.len().is_multiple_of(2) {
        return Err(ErrorKind::Value);
    }
    let mut out = Vec::new();
    for ch in a.chunks(2) {
        let crit = ctx.scalar(&ch[1]);
        out.push((ch[0].clone(), crit));
    }
    Ok(out)
}

fn sumifs(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let p = pairs(ctx, &a[1..])?;
    let (rows, cols, mask) = criteria_mask(ctx, &p)?;
    let vals = aligned_values(ctx, &a[0], rows, cols)?;
    let mut s = 0.0;
    for (m, v) in mask.iter().zip(vals.iter()) {
        if *m {
            match v {
                Value::Number(n) => s += n,
                Value::Error(e) => return Err(*e),
                _ => {}
            }
        }
    }
    num(s)
}

fn sumproduct(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let mut arrays: Vec<Array> = Vec::new();
    for ev in a {
        arrays.push(ctx.to_array(ev)?);
    }
    let (r, c) = (arrays[0].rows(), arrays[0].cols());
    if arrays.iter().any(|x| x.rows() != r || x.cols() != c) {
        return Err(ErrorKind::Value);
    }
    let mut total = 0.0;
    ctx.tick((r * c * arrays.len()) as u64)?;
    for i in 0..r * c {
        let mut p = 1.0;
        for arr in &arrays {
            match &arr.data()[i] {
                Value::Number(n) => p *= n,
                Value::Error(e) => return Err(*e),
                _ => p = 0.0,
            }
        }
        total += p;
    }
    num(total)
}

fn n1(ctx: &mut EvalCtx, a: &[Ev], f: fn(f64) -> f64) -> R {
    let x = ctx.num(&a[0])?;
    num(f(x))
}

fn quotient(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (x, y) = (ctx.num(&a[0])?, ctx.num(&a[1])?);
    if y == 0.0 {
        return Err(ErrorKind::Div0);
    }
    num((x / y).trunc())
}

/// Excel MOD: result has the sign of the divisor.
pub fn excel_mod(x: f64, y: f64) -> Result<f64, ErrorKind> {
    if y == 0.0 {
        return Err(ErrorKind::Div0);
    }
    let r = x - y * (x / y).floor();
    // Clean tiny representation noise (e.g. MOD(1.1,0.1)).
    let r = if (r - y).abs() < 1e-12 * y.abs().max(1.0) {
        0.0
    } else {
        r
    };
    Ok(r)
}

fn modf(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (x, y) = (ctx.num(&a[0])?, ctx.num(&a[1])?);
    num(excel_mod(x, y)?)
}
fn abs(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::abs)
}
fn sign(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, |x| {
        if x > 0.0 {
            1.0
        } else if x < 0.0 {
            -1.0
        } else {
            0.0
        }
    })
}
fn int(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::floor)
}

fn scale_of(d: f64) -> f64 {
    10f64.powi(d.trunc().clamp(-308.0, 308.0) as i32)
}

/// Excel ROUND (half away from zero, tolerant of binary representation error).
pub fn round_half_away(x: f64, digits: f64) -> f64 {
    let s = scale_of(digits);
    let y = round_sig15(x * s);
    let r = y.abs().round() * y.signum();
    let out = r / s;
    if out.is_finite() { out } else { x }
}

fn trunc_to(x: f64, digits: f64) -> f64 {
    let s = scale_of(digits);
    let y = round_sig15(x * s);
    y.trunc() / s
}

fn trunc(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let d = ctx.opt_num(a, 1, 0.0)?;
    num(trunc_to(x, d))
}
fn round(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let d = ctx.num(&a[1])?;
    num(round_half_away(x, d))
}
fn roundup(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let d = ctx.num(&a[1])?;
    let s = scale_of(d);
    let y = round_sig15(x * s);
    num(y.abs().ceil() * y.signum() / s)
}
fn rounddown(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let d = ctx.num(&a[1])?;
    num(trunc_to(x, d))
}
fn mround(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let m = ctx.num(&a[1])?;
    if m == 0.0 {
        return num(0.0);
    }
    if x * m < 0.0 {
        return Err(ErrorKind::Num);
    }
    let q = round_sig15(x / m);
    num((q.abs().round() * q.signum()) * m)
}

fn ceiling(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let s = ctx.num(&a[1])?;
    if s == 0.0 {
        return num(0.0);
    }
    if x > 0.0 && s < 0.0 {
        return Err(ErrorKind::Num);
    }
    let q = round_sig15(x / s);
    if x < 0.0 && s < 0.0 {
        // away from zero
        return num(q.ceil() * s);
    }
    num(q.ceil() * s)
}

fn floor(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let s = ctx.num(&a[1])?;
    if s == 0.0 {
        return if x == 0.0 {
            num(0.0)
        } else {
            Err(ErrorKind::Div0)
        };
    }
    if x > 0.0 && s < 0.0 {
        return Err(ErrorKind::Num);
    }
    let q = round_sig15(x / s);
    num(q.floor() * s)
}

fn ceiling_math(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let s = ctx.opt_num(a, 1, 1.0)?.abs();
    let mode = ctx.opt_num(a, 2, 0.0)?;
    if s == 0.0 {
        return num(0.0);
    }
    let q = round_sig15(x / s);
    if x < 0.0 && mode != 0.0 {
        return num(q.floor() * s);
    }
    num(q.ceil() * s)
}

fn floor_math(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let s = ctx.opt_num(a, 1, 1.0)?.abs();
    let mode = ctx.opt_num(a, 2, 0.0)?;
    if s == 0.0 {
        return num(0.0);
    }
    let q = round_sig15(x / s);
    if x < 0.0 && mode != 0.0 {
        return num(q.ceil() * s);
    }
    num(q.floor() * s)
}

fn even(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, |x| {
        let c = (x.abs() / 2.0).ceil() * 2.0;
        c * if x < 0.0 { -1.0 } else { 1.0 }
    })
}
fn odd(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, |x| {
        let ax = x.abs();
        let mut c = ax.ceil();
        if c % 2.0 == 0.0 {
            c += 1.0;
        }
        c * if x < 0.0 { -1.0 } else { 1.0 }
    })
}
fn sqrt(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    if x < 0.0 {
        return Err(ErrorKind::Num);
    }
    num(x.sqrt())
}
fn power(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (x, y) = (ctx.num(&a[0])?, ctx.num(&a[1])?);
    Ok(Ev::V(crate::eval::excel_pow(x, y)))
}
fn exp(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::exp)
}
fn ln(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    if x <= 0.0 {
        return Err(ErrorKind::Num);
    }
    num(x.ln())
}
fn log(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let b = ctx.opt_num(a, 1, 10.0)?;
    if x <= 0.0 || b <= 0.0 {
        return Err(ErrorKind::Num);
    }
    if b == 1.0 {
        return Err(ErrorKind::Div0);
    }
    let r = if b == 10.0 {
        x.log10()
    } else {
        x.ln() / b.ln()
    };
    num(round_sig15(r))
}
fn log10(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    if x <= 0.0 {
        return Err(ErrorKind::Num);
    }
    num(x.log10())
}
fn pi(_: &mut EvalCtx, _: &[Ev]) -> R {
    num(std::f64::consts::PI)
}
fn rand(ctx: &mut EvalCtx, _: &[Ev]) -> R {
    num(ctx.host.random())
}
fn randbetween(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let lo = ctx.num(&a[0])?.ceil();
    let hi = ctx.num(&a[1])?.floor();
    if lo > hi {
        return Err(ErrorKind::Num);
    }
    num(lo + (ctx.host.random() * (hi - lo + 1.0)).floor())
}

fn int_args(ctx: &mut EvalCtx, a: &[Ev]) -> Result<Vec<f64>, ErrorKind> {
    let v = nums(ctx, a)?;
    if v.iter().any(|x| *x < 0.0 || *x >= 2f64.powi(53)) {
        return Err(ErrorKind::Num);
    }
    Ok(v.into_iter().map(f64::trunc).collect())
}
fn gcd2(mut a: f64, mut b: f64) -> f64 {
    while b != 0.0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}
fn gcd(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = int_args(ctx, a)?;
    num(v.into_iter().fold(0.0, gcd2))
}
fn lcm(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = int_args(ctx, a)?;
    let mut acc = 1.0;
    for x in v {
        if x == 0.0 {
            return num(0.0);
        }
        acc = acc / gcd2(acc, x) * x;
    }
    num(acc)
}

/// Factorial of an integer (`#NUM!` below zero).
pub fn factorial(n: f64) -> Result<f64, ErrorKind> {
    if n < 0.0 {
        return Err(ErrorKind::Num);
    }
    let n = n.trunc();
    if n > 170.0 {
        return Err(ErrorKind::Num);
    }
    Ok((1..=n as u64).fold(1.0, |acc, k| acc * k as f64))
}
fn fact(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(factorial(ctx.num(&a[0])?)?)
}

/// Binomial coefficient.
pub fn combinations(n: f64, k: f64) -> Result<f64, ErrorKind> {
    let (n, k) = (n.trunc(), k.trunc());
    if n < 0.0 || k < 0.0 || k > n {
        return Err(ErrorKind::Num);
    }
    let k = k.min(n - k);
    let mut r = 1.0;
    for i in 0..k as u64 {
        r = r * (n - i as f64) / (i as f64 + 1.0);
    }
    Ok(r.round())
}
fn combin(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (n, k) = (ctx.num(&a[0])?, ctx.num(&a[1])?);
    num(combinations(n, k)?)
}
fn permut(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (n, k) = (ctx.num(&a[0])?.trunc(), ctx.num(&a[1])?.trunc());
    if n < 0.0 || k < 0.0 || k > n {
        return Err(ErrorKind::Num);
    }
    let mut r = 1.0;
    for i in 0..k as u64 {
        r *= n - i as f64;
    }
    num(r)
}

/// Run one of the SUBTOTAL/AGGREGATE functions over a list of numbers.
pub(crate) fn aggregate_numbers(f: u32, v: &mut [f64], k: Option<f64>) -> Result<f64, ErrorKind> {
    use super::stats::{mean, median, percentile_exc, percentile_inc, stdev, variance};
    let n = v.len() as f64;
    Ok(match f {
        1 => {
            if v.is_empty() {
                return Err(ErrorKind::Div0);
            }
            mean(v)
        }
        2 | 3 => n,
        4 => v
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max)
            .max(if v.is_empty() { 0.0 } else { f64::NEG_INFINITY }),
        5 => {
            if v.is_empty() {
                0.0
            } else {
                v.iter().copied().fold(f64::INFINITY, f64::min)
            }
        }
        6 => v.iter().product(),
        7 => stdev(v, true)?,
        8 => stdev(v, false)?,
        9 => v.iter().sum(),
        10 => variance(v, true)?,
        11 => variance(v, false)?,
        12 => median(v)?,
        13 => super::stats::mode_sngl(v)?,
        14 | 15 => {
            let k = k.ok_or(ErrorKind::Value)?;
            if k < 1.0 || k as usize > v.len() {
                return Err(ErrorKind::Num);
            }
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            if f == 14 {
                v[v.len() - k as usize]
            } else {
                v[k as usize - 1]
            }
        }
        16 => percentile_inc(v, k.ok_or(ErrorKind::Value)?)?,
        17 => percentile_inc(v, k.ok_or(ErrorKind::Value)? / 4.0)?,
        18 => percentile_exc(v, k.ok_or(ErrorKind::Value)?)?,
        19 => percentile_exc(v, k.ok_or(ErrorKind::Value)? / 4.0)?,
        _ => return Err(ErrorKind::Value),
    })
}

fn subtotal(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let f = ctx.num(&a[0])? as u32;
    let base = if f > 100 { f - 100 } else { f };
    if !(1..=11).contains(&base) {
        return Err(ErrorKind::Value);
    }
    let mut v = if base == 3 {
        super::nums_a(ctx, &a[1..])?
    } else {
        nums(ctx, &a[1..])?
    };
    if base == 3 {
        // COUNTA counts every non-empty value, including text.
        let mut count = 0.0;
        for ev in &a[1..] {
            ctx.for_each_value(ev, &mut |v, _| {
                if !v.is_empty() {
                    count += 1.0;
                }
                Ok(())
            })?;
        }
        return num(count);
    }
    num(aggregate_numbers(base, &mut v, None)?)
}

fn aggregate(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let f = ctx.num(&a[0])? as u32;
    let opt = ctx.num(&a[1])? as u32;
    if !(1..=19).contains(&f) || opt > 7 {
        return Err(ErrorKind::Value);
    }
    let ignore_errors = matches!(opt, 2 | 3 | 6 | 7);
    let (refs, k) = if f >= 14 {
        if a.len() < 4 {
            return Err(ErrorKind::Value);
        }
        (&a[2..3], Some(ctx.num(&a[3])?))
    } else {
        (&a[2..], None)
    };
    let mut v = Vec::new();
    let mut count_a = 0.0;
    for ev in refs {
        ctx.for_each_value(ev, &mut |x, _| {
            match x {
                Value::Number(n) => {
                    v.push(*n);
                    count_a += 1.0;
                }
                Value::Error(e) if !ignore_errors => return Err(*e),
                Value::Empty => {}
                _ => count_a += 1.0,
            }
            Ok(())
        })?;
    }
    if f == 3 {
        return num(count_a);
    }
    num(aggregate_numbers(f, &mut v, k)?)
}

fn degrees(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::to_degrees)
}
fn radians(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::to_radians)
}
fn sin(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::sin)
}
fn cos(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::cos)
}
fn tan(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::tan)
}
fn asin(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    if !(-1.0..=1.0).contains(&x) {
        return Err(ErrorKind::Num);
    }
    num(x.asin())
}
fn acos(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    if !(-1.0..=1.0).contains(&x) {
        return Err(ErrorKind::Num);
    }
    num(x.acos())
}
fn atan(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    n1(ctx, a, f64::atan)
}
fn atan2(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (x, y) = (ctx.num(&a[0])?, ctx.num(&a[1])?);
    if x == 0.0 && y == 0.0 {
        return Err(ErrorKind::Div0);
    }
    num(y.atan2(x))
}
