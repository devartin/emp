//! Financial functions.

use super::FnSpec;
use crate::eval::{Ev, EvalCtx, R, num};
use crate::fspec;
use crate::value::{ErrorKind, Value};

/// Financial function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "PMT",
        Financial,
        3,
        5,
        [Value],
        pmt_fn,
        "PMT(rate, nper, pv, [fv], [type])",
        "Payment for a loan with constant payments and rate.",
        "=PMT(5%/12,360,-300000)"
    ),
    fspec!(
        "IPMT",
        Financial,
        4,
        6,
        [Value],
        ipmt_fn,
        "IPMT(rate, per, nper, pv, [fv], [type])",
        "Interest part of a payment.",
        "=IPMT(5%/12,1,360,-300000)"
    ),
    fspec!(
        "PPMT",
        Financial,
        4,
        6,
        [Value],
        ppmt_fn,
        "PPMT(rate, per, nper, pv, [fv], [type])",
        "Principal part of a payment.",
        "=PPMT(5%/12,1,360,-300000)"
    ),
    fspec!(
        "PV",
        Financial,
        3,
        5,
        [Value],
        pv_fn,
        "PV(rate, nper, pmt, [fv], [type])",
        "Present value of an investment.",
        "=PV(5%/12,120,-500)"
    ),
    fspec!(
        "FV",
        Financial,
        3,
        5,
        [Value],
        fv_fn,
        "FV(rate, nper, pmt, [pv], [type])",
        "Future value of an investment.",
        "=FV(5%/12,120,-500)"
    ),
    fspec!(
        "NPER",
        Financial,
        3,
        5,
        [Value],
        nper_fn,
        "NPER(rate, pmt, pv, [fv], [type])",
        "Number of periods for an investment.",
        "=NPER(5%/12,-500,20000)"
    ),
    fspec!(
        "RATE",
        Financial,
        3,
        6,
        [Value],
        rate_fn,
        "RATE(nper, pmt, pv, [fv], [type], [guess])",
        "Interest rate per period.",
        "=RATE(360,-1610.46,300000)"
    ),
    fspec!(
        "NPV",
        Financial,
        2,
        255,
        [Value, Range],
        npv_fn,
        "NPV(rate, value1, [value2], …)",
        "Net present value of periodic cash flows.",
        "=NPV(10%,-1000,300,400,500)"
    ),
    fspec!(
        "XNPV",
        Financial,
        3,
        3,
        [Value, Range, Range],
        xnpv_fn,
        "XNPV(rate, values, dates)",
        "Net present value of dated cash flows.",
        "=XNPV(9%,B1:B5,A1:A5)"
    ),
    fspec!(
        "IRR",
        Financial,
        1,
        2,
        [Range, Value],
        irr_fn,
        "IRR(values, [guess])",
        "Internal rate of return.",
        "=IRR(A1:A6)"
    ),
    fspec!(
        "XIRR",
        Financial,
        2,
        3,
        [Range, Range, Value],
        xirr_fn,
        "XIRR(values, dates, [guess])",
        "Internal rate of return of dated cash flows.",
        "=XIRR(B1:B5,A1:A5)"
    ),
    fspec!(
        "MIRR",
        Financial,
        3,
        3,
        [Range, Value, Value],
        mirr_fn,
        "MIRR(values, finance_rate, reinvest_rate)",
        "Modified internal rate of return.",
        "=MIRR(A1:A6,10%,12%)"
    ),
    fspec!(
        "CUMIPMT",
        Financial,
        6,
        6,
        [Value],
        cumipmt_fn,
        "CUMIPMT(rate, nper, pv, start_period, end_period, type)",
        "Cumulative interest between two periods.",
        "=CUMIPMT(5%/12,360,300000,1,12,0)"
    ),
    fspec!(
        "CUMPRINC",
        Financial,
        6,
        6,
        [Value],
        cumprinc_fn,
        "CUMPRINC(rate, nper, pv, start_period, end_period, type)",
        "Cumulative principal between two periods.",
        "=CUMPRINC(5%/12,360,300000,1,12,0)"
    ),
    fspec!(
        "EFFECT",
        Financial,
        2,
        2,
        [Value],
        effect_fn,
        "EFFECT(nominal_rate, npery)",
        "Effective annual rate.",
        "=EFFECT(5%,12)"
    ),
    fspec!(
        "NOMINAL",
        Financial,
        2,
        2,
        [Value],
        nominal_fn,
        "NOMINAL(effect_rate, npery)",
        "Nominal annual rate.",
        "=NOMINAL(5.116%,12)"
    ),
    fspec!(
        "SLN",
        Financial,
        3,
        3,
        [Value],
        sln_fn,
        "SLN(cost, salvage, life)",
        "Straight-line depreciation.",
        "=SLN(10000,1000,5)"
    ),
    fspec!(
        "DB",
        Financial,
        4,
        5,
        [Value],
        db_fn,
        "DB(cost, salvage, life, period, [month])",
        "Fixed-declining-balance depreciation.",
        "=DB(10000,1000,5,1)"
    ),
    fspec!(
        "DDB",
        Financial,
        4,
        5,
        [Value],
        ddb_fn,
        "DDB(cost, salvage, life, period, [factor])",
        "Double-declining-balance depreciation.",
        "=DDB(10000,1000,5,1)"
    ),
    fspec!(
        "SYD",
        Financial,
        4,
        4,
        [Value],
        syd_fn,
        "SYD(cost, salvage, life, per)",
        "Sum-of-years'-digits depreciation.",
        "=SYD(10000,1000,5,1)"
    ),
    fspec!(
        "FVSCHEDULE",
        Financial,
        2,
        2,
        [Value, Range],
        fvschedule_fn,
        "FVSCHEDULE(principal, schedule)",
        "Future value with a schedule of rates.",
        "=FVSCHEDULE(1000,{0.05,0.06})"
    ),
    fspec!(
        "PDURATION",
        Financial,
        3,
        3,
        [Value],
        pduration_fn,
        "PDURATION(rate, pv, fv)",
        "Periods needed to reach a value.",
        "=PDURATION(5%,1000,2000)"
    ),
    fspec!(
        "RRI",
        Financial,
        3,
        3,
        [Value],
        rri_fn,
        "RRI(nper, pv, fv)",
        "Equivalent growth rate.",
        "=RRI(10,1000,2000)"
    ),
];

/// Payment per period.
pub fn pmt(r: f64, n: f64, pv: f64, fv: f64, t: f64) -> Result<f64, ErrorKind> {
    if n == 0.0 {
        return Err(ErrorKind::Num);
    }
    if r == 0.0 {
        return Ok(-(pv + fv) / n);
    }
    let f = (1.0 + r).powf(n);
    let denom = (1.0 + r * t) * (f - 1.0);
    if denom == 0.0 {
        return Err(ErrorKind::Num);
    }
    Ok(-(r * (fv + pv * f)) / denom)
}

/// Future value.
pub fn fv(r: f64, n: f64, p: f64, pv: f64, t: f64) -> f64 {
    if r == 0.0 {
        return -(pv + p * n);
    }
    let f = (1.0 + r).powf(n);
    -(pv * f + p * (1.0 + r * t) * (f - 1.0) / r)
}

/// Present value.
pub fn pv(r: f64, n: f64, p: f64, fv: f64, t: f64) -> f64 {
    if r == 0.0 {
        return -(fv + p * n);
    }
    let f = (1.0 + r).powf(n);
    -(fv + p * (1.0 + r * t) * (f - 1.0) / r) / f
}

/// Interest part of payment `per`.
pub fn ipmt(r: f64, per: f64, n: f64, pv_: f64, fv_: f64, t: f64) -> Result<f64, ErrorKind> {
    if per < 1.0 || per > n {
        return Err(ErrorKind::Num);
    }
    if per == 1.0 && t != 0.0 {
        return Ok(0.0);
    }
    let p = pmt(r, n, pv_, fv_, t)?;
    let mut i = fv(r, per - 1.0, p, pv_, t) * r;
    if t != 0.0 {
        i /= 1.0 + r;
    }
    Ok(i)
}

fn type_arg(ctx: &mut EvalCtx, a: &[Ev], i: usize) -> Result<f64, ErrorKind> {
    let t = ctx.opt_num(a, i, 0.0)?;
    Ok(if t != 0.0 { 1.0 } else { 0.0 })
}

fn pmt_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (r, n, p) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    let f = ctx.opt_num(a, 3, 0.0)?;
    let t = type_arg(ctx, a, 4)?;
    num(pmt(r, n, p, f, t)?)
}
fn ipmt_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (r, per, n, p) = (
        ctx.num(&a[0])?,
        ctx.num(&a[1])?,
        ctx.num(&a[2])?,
        ctx.num(&a[3])?,
    );
    let f = ctx.opt_num(a, 4, 0.0)?;
    let t = type_arg(ctx, a, 5)?;
    num(ipmt(r, per, n, p, f, t)?)
}
fn ppmt_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (r, per, n, p) = (
        ctx.num(&a[0])?,
        ctx.num(&a[1])?,
        ctx.num(&a[2])?,
        ctx.num(&a[3])?,
    );
    let f = ctx.opt_num(a, 4, 0.0)?;
    let t = type_arg(ctx, a, 5)?;
    num(pmt(r, n, p, f, t)? - ipmt(r, per, n, p, f, t)?)
}
fn pv_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (r, n, p) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    let f = ctx.opt_num(a, 3, 0.0)?;
    let t = type_arg(ctx, a, 4)?;
    num(pv(r, n, p, f, t))
}
fn fv_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (r, n, p) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    let pv_ = ctx.opt_num(a, 3, 0.0)?;
    let t = type_arg(ctx, a, 4)?;
    num(fv(r, n, p, pv_, t))
}
fn nper_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (r, p, pv_) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    let f = ctx.opt_num(a, 3, 0.0)?;
    let t = type_arg(ctx, a, 4)?;
    if r == 0.0 {
        if p == 0.0 {
            return Err(ErrorKind::Num);
        }
        return num(-(pv_ + f) / p);
    }
    let z = p * (1.0 + r * t) / r;
    let x = (z - f) / (pv_ + z);
    if x <= 0.0 || r <= -1.0 {
        return Err(ErrorKind::Num);
    }
    num(x.ln() / (1.0 + r).ln())
}

/// Solve the annuity equation for the rate (Newton with secant fallback).
pub fn rate(n: f64, p: f64, pv_: f64, fv_: f64, t: f64, guess: f64) -> Result<f64, ErrorKind> {
    let f = |r: f64| -> f64 {
        if r.abs() < 1e-12 {
            pv_ + p * n + fv_
        } else {
            let g = (1.0 + r).powf(n);
            pv_ * g + p * (1.0 + r * t) * (g - 1.0) / r + fv_
        }
    };
    let mut r = guess;
    for _ in 0..200 {
        let y = f(r);
        if y.abs() < 1e-10 {
            return Ok(r);
        }
        let h = 1e-7 * r.abs().max(1e-4);
        let d = (f(r + h) - f(r - h)) / (2.0 * h);
        if d == 0.0 || !d.is_finite() {
            break;
        }
        let next = r - y / d;
        if !next.is_finite() || next <= -1.0 {
            break;
        }
        if (next - r).abs() < 1e-12 {
            return Ok(next);
        }
        r = next;
    }
    if f(r).abs() < 1e-6 {
        Ok(r)
    } else {
        Err(ErrorKind::Num)
    }
}

fn rate_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (n, p, pv_) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    let f = ctx.opt_num(a, 3, 0.0)?;
    let t = type_arg(ctx, a, 4)?;
    let g = ctx.opt_num(a, 5, 0.1)?;
    if n <= 0.0 {
        return Err(ErrorKind::Num);
    }
    num(rate(n, p, pv_, f, t, g)?)
}

fn npv_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let r = ctx.num(&a[0])?;
    if r == -1.0 {
        return Err(ErrorKind::Div0);
    }
    let vals = super::nums(ctx, &a[1..])?;
    num(npv(r, &vals))
}

/// NPV of periodic cash flows starting one period out.
pub fn npv(r: f64, vals: &[f64]) -> f64 {
    vals.iter()
        .enumerate()
        .map(|(i, v)| v / (1.0 + r).powi(i as i32 + 1))
        .sum()
}

fn dated_flows(
    ctx: &mut EvalCtx,
    values: &Ev,
    dates: &Ev,
) -> Result<(Vec<f64>, Vec<f64>), ErrorKind> {
    let v = ctx.to_array(values)?;
    let d = ctx.to_array(dates)?;
    if v.len() != d.len() {
        return Err(ErrorKind::Num);
    }
    let mut vs = Vec::new();
    let mut ds = Vec::new();
    for (x, y) in v.data().iter().zip(d.data()) {
        let xv = match x {
            Value::Number(n) => *n,
            Value::Error(e) => return Err(*e),
            _ => return Err(ErrorKind::Value),
        };
        let dv = match y {
            Value::Number(n) => n.floor(),
            Value::Error(e) => return Err(*e),
            _ => return Err(ErrorKind::Value),
        };
        vs.push(xv);
        ds.push(dv);
    }
    if vs.is_empty() {
        return Err(ErrorKind::Num);
    }
    if ds.iter().any(|x| *x < ds[0]) {
        return Err(ErrorKind::Num);
    }
    Ok((vs, ds))
}

/// XNPV.
pub fn xnpv(r: f64, v: &[f64], d: &[f64]) -> f64 {
    let d0 = d[0];
    v.iter()
        .zip(d)
        .map(|(x, di)| x / (1.0 + r).powf((di - d0) / 365.0))
        .sum()
}

fn xnpv_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let r = ctx.num(&a[0])?;
    if r <= -1.0 {
        return Err(ErrorKind::Num);
    }
    let (v, d) = dated_flows(ctx, &a[1], &a[2])?;
    num(xnpv(r, &v, &d))
}

/// Root finder for IRR-type functions: Newton from `guess`, then bracketing bisection.
fn solve_rate(
    f: &dyn Fn(f64) -> f64,
    df: &dyn Fn(f64) -> f64,
    guess: f64,
) -> Result<f64, ErrorKind> {
    let mut r = guess;
    for _ in 0..100 {
        let y = f(r);
        if !y.is_finite() {
            break;
        }
        if y.abs() < 1e-12 {
            return Ok(r);
        }
        let d = df(r);
        if d == 0.0 || !d.is_finite() {
            break;
        }
        let next = r - y / d;
        if !next.is_finite() || next <= -1.0 {
            break;
        }
        if (next - r).abs() < 1e-14 * next.abs().max(1.0) {
            return Ok(next);
        }
        r = next;
    }
    if f(r).abs() < 1e-7 && r > -1.0 {
        return Ok(r);
    }
    // Bracket search.
    let mut lo = -0.999_999;
    let mut hi = 1.0;
    let mut flo = f(lo);
    let mut fhi = f(hi);
    let mut expand = 0;
    while flo * fhi > 0.0 && expand < 60 {
        hi *= 2.0;
        fhi = f(hi);
        expand += 1;
    }
    if flo * fhi > 0.0 || !flo.is_finite() || !fhi.is_finite() {
        return Err(ErrorKind::Num);
    }
    for _ in 0..300 {
        let mid = 0.5 * (lo + hi);
        let fm = f(mid);
        if fm.abs() < 1e-12 || (hi - lo) < 1e-15 {
            return Ok(mid);
        }
        if flo * fm < 0.0 {
            hi = mid;
        } else {
            lo = mid;
            flo = fm;
        }
    }
    Ok(0.5 * (lo + hi))
}

/// IRR of periodic flows.
pub fn irr(v: &[f64], guess: f64) -> Result<f64, ErrorKind> {
    if !(v.iter().any(|x| *x > 0.0) && v.iter().any(|x| *x < 0.0)) {
        return Err(ErrorKind::Num);
    }
    let f = |r: f64| {
        v.iter()
            .enumerate()
            .map(|(i, x)| x / (1.0 + r).powi(i as i32))
            .sum::<f64>()
    };
    let df = |r: f64| {
        v.iter()
            .enumerate()
            .map(|(i, x)| -(i as f64) * x / (1.0 + r).powi(i as i32 + 1))
            .sum::<f64>()
    };
    solve_rate(&f, &df, guess)
}

/// XIRR of dated flows.
pub fn xirr(v: &[f64], d: &[f64], guess: f64) -> Result<f64, ErrorKind> {
    if !(v.iter().any(|x| *x > 0.0) && v.iter().any(|x| *x < 0.0)) {
        return Err(ErrorKind::Num);
    }
    let d0 = d[0];
    let f = |r: f64| {
        v.iter()
            .zip(d)
            .map(|(x, di)| x / (1.0 + r).powf((di - d0) / 365.0))
            .sum::<f64>()
    };
    let df = |r: f64| {
        v.iter()
            .zip(d)
            .map(|(x, di)| {
                let e = (di - d0) / 365.0;
                -e * x / (1.0 + r).powf(e + 1.0)
            })
            .sum::<f64>()
    };
    solve_rate(&f, &df, guess)
}

fn irr_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = super::nums(ctx, &a[..1])?;
    let g = ctx.opt_num(a, 1, 0.1)?;
    num(irr(&v, g)?)
}
fn xirr_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (v, d) = dated_flows(ctx, &a[0], &a[1])?;
    let g = ctx.opt_num(a, 2, 0.1)?;
    num(xirr(&v, &d, g)?)
}
fn mirr_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = super::nums(ctx, &a[..1])?;
    let fr = ctx.num(&a[1])?;
    let rr = ctx.num(&a[2])?;
    let n = v.len() as f64;
    let pos: Vec<f64> = v.iter().map(|x| if *x > 0.0 { *x } else { 0.0 }).collect();
    let neg: Vec<f64> = v.iter().map(|x| if *x < 0.0 { *x } else { 0.0 }).collect();
    let npv_neg = npv(fr, &neg) * (1.0 + fr);
    let fv_pos = npv(rr, &pos) * (1.0 + rr).powf(n);
    if npv_neg == 0.0 || n < 2.0 {
        return Err(ErrorKind::Div0);
    }
    num((-fv_pos / npv_neg).powf(1.0 / (n - 1.0)) - 1.0)
}

fn cum(ctx: &mut EvalCtx, a: &[Ev], interest: bool) -> R {
    let (r, n, pv_) = (ctx.num(&a[0])?, ctx.num(&a[1])?.trunc(), ctx.num(&a[2])?);
    let (s, e) = (ctx.num(&a[3])?.trunc(), ctx.num(&a[4])?.trunc());
    let t = ctx.num(&a[5])?;
    if r <= 0.0 || n <= 0.0 || pv_ <= 0.0 || s < 1.0 || e < s || e > n || (t != 0.0 && t != 1.0) {
        return Err(ErrorKind::Num);
    }
    let p = pmt(r, n, pv_, 0.0, t)?;
    // One step per period: charge them up front. Past 2^53 `per += 1.0` stops advancing, so
    // without this an `end_period` of 1e300 looped forever.
    ctx.tick((e - s + 1.0) as u64)?;
    let mut total = 0.0;
    let mut per = s;
    while per <= e {
        let i = ipmt(r, per, n, pv_, 0.0, t)?;
        total += if interest { i } else { p - i };
        per += 1.0;
    }
    num(total)
}
fn cumipmt_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    cum(ctx, a, true)
}
fn cumprinc_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    cum(ctx, a, false)
}
fn effect_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let r = ctx.num(&a[0])?;
    let n = ctx.num(&a[1])?.trunc();
    if r <= 0.0 || n < 1.0 {
        return Err(ErrorKind::Num);
    }
    num((1.0 + r / n).powf(n) - 1.0)
}
fn nominal_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let e = ctx.num(&a[0])?;
    let n = ctx.num(&a[1])?.trunc();
    if e <= 0.0 || n < 1.0 {
        return Err(ErrorKind::Num);
    }
    num(n * ((1.0 + e).powf(1.0 / n) - 1.0))
}
fn sln_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (c, s, l) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    if l == 0.0 {
        return Err(ErrorKind::Div0);
    }
    num((c - s) / l)
}
fn db_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (c, s, l, per) = (
        ctx.num(&a[0])?,
        ctx.num(&a[1])?,
        ctx.num(&a[2])?,
        ctx.num(&a[3])?.trunc(),
    );
    let month = ctx.opt_num(a, 4, 12.0)?.trunc();
    if c < 0.0
        || s < 0.0
        || l <= 0.0
        || per < 1.0
        || !(1.0..=12.0).contains(&month)
        || per > l + if month < 12.0 { 1.0 } else { 0.0 }
    {
        return Err(ErrorKind::Num);
    }
    if c == 0.0 {
        return num(0.0);
    }
    let rate = crate::functions::math::round_half_away(1.0 - (s / c).powf(1.0 / l), 3.0);
    let mut total = 0.0;
    let mut dep = 0.0;
    let mut p = 1.0;
    while p <= per {
        dep = if p == 1.0 {
            c * rate * month / 12.0
        } else if p == l + 1.0 {
            (c - total) * rate * (12.0 - month) / 12.0
        } else {
            (c - total) * rate
        };
        total += dep;
        p += 1.0;
    }
    num(dep)
}
fn ddb_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (c, s, l, per) = (
        ctx.num(&a[0])?,
        ctx.num(&a[1])?,
        ctx.num(&a[2])?,
        ctx.num(&a[3])?,
    );
    let factor = ctx.opt_num(a, 4, 2.0)?;
    if c < 0.0 || s < 0.0 || l <= 0.0 || per < 1.0 || per > l || factor <= 0.0 {
        return Err(ErrorKind::Num);
    }
    // One step per period (see `cum`): a period of 1e300 used to loop forever.
    ctx.tick(per.ceil() as u64)?;
    let mut book = c;
    let mut dep = 0.0;
    let mut p = 1.0;
    while p <= per.ceil() {
        dep = (book * factor / l).min((book - s).max(0.0));
        book -= dep;
        p += 1.0;
    }
    num(dep)
}
fn syd_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (c, s, l, p) = (
        ctx.num(&a[0])?,
        ctx.num(&a[1])?,
        ctx.num(&a[2])?,
        ctx.num(&a[3])?,
    );
    if l <= 0.0 || p < 1.0 || p > l {
        return Err(ErrorKind::Num);
    }
    num((c - s) * (l - p + 1.0) * 2.0 / (l * (l + 1.0)))
}
fn fvschedule_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let p = ctx.num(&a[0])?;
    let arr = ctx.to_array(&a[1])?;
    let mut acc = p;
    for v in arr.data() {
        match v {
            Value::Number(r) => acc *= 1.0 + r,
            Value::Empty => {}
            Value::Error(e) => return Err(*e),
            _ => return Err(ErrorKind::Value),
        }
    }
    num(acc)
}
fn pduration_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (r, p, f) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    if r <= 0.0 || p <= 0.0 || f <= 0.0 {
        return Err(ErrorKind::Num);
    }
    num((f.ln() - p.ln()) / (1.0 + r).ln())
}
fn rri_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (n, p, f) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    if n <= 0.0 || p == 0.0 {
        return Err(ErrorKind::Num);
    }
    num((f / p).powf(1.0 / n) - 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-9 * b.abs().max(1.0)
    }

    #[test]
    fn annuities() {
        assert!(close(
            pmt(0.05 / 12.0, 360.0, 300_000.0, 0.0, 0.0).unwrap_or(0.0),
            -1610.4648690364193
        ));
        assert!(close(
            fv(0.06 / 12.0, 10.0, -200.0, -500.0, 1.0),
            2581.4033740601
        ));
        assert!(close(
            pv(0.08 / 12.0, 240.0, 500.0, 0.0, 0.0),
            -59777.14585118638
        ));
        let r = rate(48.0, -200.0, 8000.0, 0.0, 0.0, 0.1).unwrap_or(0.0);
        assert!((r - 0.007701472488201).abs() < 1e-12);
        assert!(close(
            ipmt(0.1 / 12.0, 1.0, 36.0, 8000.0, 0.0, 0.0).unwrap_or(0.0),
            -66.66666666666667
        ));
    }

    #[test]
    fn irr_npv() {
        let v = [-70000.0, 12000.0, 15000.0, 18000.0, 21000.0, 26000.0];
        assert!((irr(&v, 0.1).unwrap_or(0.0) - 0.08663094803653162).abs() < 1e-12);
        assert!(close(
            npv(0.1, &[-10000.0, 3000.0, 4200.0, 6800.0]),
            1188.4434123352207
        ));
        let d = [39448.0, 39508.0, 39751.0, 39859.0, 39904.0];
        let x = [-10000.0, 2750.0, 4250.0, 3250.0, 2750.0];
        assert!((xirr(&x, &d, 0.1).unwrap_or(0.0) - 0.373362535).abs() < 1e-8);
        assert!(close(xnpv(0.09, &x, &d), 2086.647602));
        assert_eq!(irr(&[1.0, 2.0], 0.1), Err(ErrorKind::Num));
    }
}
