//! Evaluator shared by the Row (§14.6) and Metric (§14.7) dialects.

use super::value::{DateVal, RowValue, cmp_row};
use crate::ast::{BinaryOp, Expr, UnaryOp};
use crate::limits::{MAX_CALL_DEPTH, MAX_LET_DEPTH, MAX_TEXT_LEN, build_regex};
use crate::parser::Dialect;
use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime, Timelike};
use std::cmp::Ordering;

/// Data the evaluator may read.
pub trait Resolver {
    /// A property of the current row (`row = None`) or of a related row.
    fn prop(&self, row: Option<&str>, key: &str) -> Option<RowValue> {
        let _ = (row, key);
        None
    }
    /// A dotted path (`metrics.x`, `answers.y`, `pack.a.b`).
    fn path(&self, parts: &[String]) -> Option<RowValue> {
        let _ = parts;
        None
    }
    /// A bare identifier (`today` in the Metric dialect).
    fn ident(&self, name: &str) -> Option<RowValue> {
        let _ = name;
        None
    }
    /// The clock.
    fn now(&self) -> NaiveDateTime;
    /// Cached FX rate `(rate, stale)`.
    fn fx(&self, from: &str, to: &str) -> Option<(f64, bool)> {
        let _ = (from, to);
        None
    }
}

/// A runtime error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvalError {
    /// Message.
    pub message: String,
}

fn err<T>(m: impl Into<String>) -> Result<T, EvalError> {
    Err(EvalError { message: m.into() })
}

/// Evaluation state.
pub struct DialectEval<'a> {
    r: &'a dyn Resolver,
    dialect: Dialect,
    scopes: Vec<(String, RowValue)>,
    depth: usize,
    ops: u64,
    /// An `fx()` rate was stale.
    pub stale: bool,
    /// `now()` / `today()` was used.
    pub uses_now: bool,
}

const OPS_LIMIT: u64 = 5_000_000;

type Res = Result<RowValue, EvalError>;

fn num(x: f64) -> Res {
    if x.is_finite() {
        Ok(RowValue::Number(if x == 0.0 { 0.0 } else { x }))
    } else {
        Ok(RowValue::Empty)
    }
}

fn text(s: String) -> Res {
    if s.chars().count() > MAX_TEXT_LEN {
        return err("Text is too long");
    }
    Ok(RowValue::Text(s))
}

impl<'a> DialectEval<'a> {
    /// New evaluator.
    pub fn new(r: &'a dyn Resolver, dialect: Dialect) -> Self {
        DialectEval {
            r,
            dialect,
            scopes: Vec::new(),
            depth: 0,
            ops: 0,
            stale: false,
            uses_now: false,
        }
    }

    fn tick(&mut self) -> Result<(), EvalError> {
        self.ops += 1;
        if self.ops > OPS_LIMIT {
            return err("Formula is too expensive");
        }
        Ok(())
    }

    /// Evaluate an expression.
    pub fn eval(&mut self, e: &Expr) -> Res {
        self.tick()?;
        match e {
            Expr::Number(n) => num(*n),
            Expr::Text(s) => Ok(RowValue::Text(s.clone())),
            Expr::Bool(b) => Ok(RowValue::Bool(*b)),
            Expr::Missing => Ok(RowValue::Empty),
            Expr::Paren(x) => self.eval(x),
            Expr::List(items) => {
                let mut out = Vec::with_capacity(items.len());
                for i in items {
                    out.push(self.eval(i)?);
                }
                Ok(RowValue::List(out))
            }
            Expr::Name(n) => {
                if let Some((_, v)) = self.scopes.iter().rev().find(|(k, _)| k == n) {
                    return Ok(v.clone());
                }
                if self.dialect == Dialect::Metric && n == "today" {
                    self.uses_now = true;
                }
                match self.r.ident(n) {
                    Some(v) => Ok(v),
                    None => err(format!("Unknown name: {n}")),
                }
            }
            Expr::Path(parts) => {
                if self.dialect == Dialect::Metric {
                    match self.r.path(parts) {
                        Some(v) => Ok(v),
                        None => Ok(RowValue::Empty),
                    }
                } else {
                    // `current.x` without parentheses: treat as a method with no args
                    let recv = Expr::Name(parts[0].clone());
                    let mut v = self.eval(&recv)?;
                    for p in &parts[1..] {
                        v = self.call_with(p, vec![v])?;
                    }
                    Ok(v)
                }
            }
            Expr::Unary(op, x) => {
                let v = self.eval(x)?;
                match op {
                    UnaryOp::Neg => match v {
                        RowValue::Number(n) => num(-n),
                        RowValue::Empty => Ok(RowValue::Empty),
                        _ => err("Cannot negate a non-number"),
                    },
                    UnaryOp::Plus => Ok(v),
                    UnaryOp::Not => Ok(RowValue::Bool(!v.truthy())),
                    UnaryOp::At => err("Unexpected @"),
                }
            }
            Expr::Ternary(c, a, b) => {
                if self.eval(c)?.truthy() {
                    self.eval(a)
                } else {
                    self.eval(b)
                }
            }
            Expr::Binary(op, a, b) => self.binary(*op, a, b),
            Expr::Call { name, args } => self.call(name, args),
            Expr::Method { recv, name, args } => {
                let mut all = Vec::with_capacity(args.len() + 1);
                all.push((**recv).clone());
                all.extend(args.iter().cloned());
                self.call(name, &all)
            }
            Expr::Ref(_) | Expr::Array(_) | Expr::Error(_) | Expr::Postfix(..) => {
                err("Not supported in this formula type")
            }
        }
    }

    fn binary(&mut self, op: BinaryOp, a: &Expr, b: &Expr) -> Res {
        match op {
            BinaryOp::And => {
                let x = self.eval(a)?;
                if !x.truthy() {
                    return Ok(RowValue::Bool(false));
                }
                return Ok(RowValue::Bool(self.eval(b)?.truthy()));
            }
            BinaryOp::Or => {
                let x = self.eval(a)?;
                if x.truthy() {
                    return Ok(RowValue::Bool(true));
                }
                return Ok(RowValue::Bool(self.eval(b)?.truthy()));
            }
            _ => {}
        }
        let x = self.eval(a)?;
        let y = self.eval(b)?;
        binop(op, &x, &y)
    }

    fn call(&mut self, name: &str, args: &[Expr]) -> Res {
        if self.depth >= MAX_CALL_DEPTH {
            return err("Formula is nested too deeply");
        }
        self.depth += 1;
        let r = self.call_inner(name, args);
        self.depth -= 1;
        r
    }

    fn call_with(&mut self, name: &str, vals: Vec<RowValue>) -> Res {
        // Evaluate a function with already-evaluated arguments (bind them as temporaries).
        let mut exprs = Vec::with_capacity(vals.len());
        let base = self.scopes.len();
        for (i, v) in vals.into_iter().enumerate() {
            let k = format!("\u{0}arg{}_{}", base, i);
            self.scopes.push((k.clone(), v));
            exprs.push(Expr::Name(k));
        }
        let r = self.call(name, &exprs);
        self.scopes.truncate(base);
        r
    }

    fn with_scope<T>(
        &mut self,
        vars: &[(&str, RowValue)],
        f: impl FnOnce(&mut Self) -> Result<T, EvalError>,
    ) -> Result<T, EvalError> {
        if self.scopes.len() + vars.len() > MAX_LET_DEPTH {
            return err("Too many nested bindings");
        }
        let base = self.scopes.len();
        for (k, v) in vars {
            self.scopes.push((k.to_string(), v.clone()));
        }
        let r = f(self);
        self.scopes.truncate(base);
        r
    }

    fn list_arg(&mut self, e: &Expr) -> Result<Vec<RowValue>, EvalError> {
        match self.eval(e)? {
            RowValue::List(l) => Ok(l),
            RowValue::Empty => Ok(Vec::new()),
            other => Ok(vec![other]),
        }
    }

    fn numbers(&mut self, args: &[Expr]) -> Result<Vec<f64>, EvalError> {
        let mut out = Vec::new();
        for a in args {
            match self.eval(a)? {
                RowValue::List(l) => out.extend(l.iter().filter_map(|v| v.as_number())),
                RowValue::Empty => {}
                v => match v.as_number() {
                    Some(n) => out.push(n),
                    None => return err(format!("Expected a number, got {}", v.type_name())),
                },
            }
        }
        Ok(out)
    }

    fn n(&mut self, e: &Expr) -> Result<f64, EvalError> {
        match self.eval(e)? {
            RowValue::Number(n) => Ok(n),
            RowValue::Bool(b) => Ok(if b { 1.0 } else { 0.0 }),
            RowValue::Empty => Ok(0.0),
            v => err(format!("Expected a number, got {}", v.type_name())),
        }
    }

    fn t(&mut self, e: &Expr) -> Result<String, EvalError> {
        Ok(self.eval(e)?.display())
    }

    fn d(&mut self, e: &Expr) -> Result<Option<DateVal>, EvalError> {
        match self.eval(e)? {
            RowValue::Date(d) => Ok(Some(d)),
            RowValue::Empty => Ok(None),
            RowValue::Text(s) => Ok(parse_date(&s)),
            v => err(format!("Expected a date, got {}", v.type_name())),
        }
    }

    fn arity(name: &str, args: &[Expr], min: usize, max: usize) -> Result<(), EvalError> {
        if args.len() < min || args.len() > max {
            return err(format!(
                "{name}() takes {} argument{}",
                if min == max {
                    min.to_string()
                } else {
                    format!("{min} to {max}")
                },
                if max == 1 { "" } else { "s" }
            ));
        }
        Ok(())
    }

    fn call_inner(&mut self, name: &str, a: &[Expr]) -> Res {
        let metric = self.dialect == Dialect::Metric;
        let lname = name.to_ascii_lowercase();
        // Metric-only functions
        if metric {
            match lname.as_str() {
                "coalesce" => {
                    for x in a {
                        let v = self.eval(x)?;
                        if !v.is_empty() {
                            return Ok(v);
                        }
                    }
                    return Ok(RowValue::Empty);
                }
                "days_between" => {
                    Self::arity(name, a, 2, 2)?;
                    let (x, y) = (self.d(&a[0])?, self.d(&a[1])?);
                    return match (x, y) {
                        (Some(x), Some(y)) => {
                            num((y.start - x.start).num_seconds() as f64 / 86_400.0)
                        }
                        _ => Ok(RowValue::Empty),
                    };
                }
                "months_between" => {
                    Self::arity(name, a, 2, 2)?;
                    let (x, y) = (self.d(&a[0])?, self.d(&a[1])?);
                    return match (x, y) {
                        (Some(x), Some(y)) => {
                            let (s, e) = (x.start, y.start);
                            let whole =
                                (e.year() - s.year()) * 12 + e.month() as i32 - s.month() as i32;
                            let frac = (e.day() as f64 - s.day() as f64) / 30.4375;
                            num(whole as f64 + frac)
                        }
                        _ => Ok(RowValue::Empty),
                    };
                }
                "fmt_money" => {
                    Self::arity(name, a, 1, 2)?;
                    let x = self.n(&a[0])?;
                    let cur = if a.len() > 1 {
                        self.t(&a[1])?.to_ascii_uppercase()
                    } else {
                        "USD".into()
                    };
                    return text(fmt_money(x, &cur));
                }
                "fmt_pct" => {
                    Self::arity(name, a, 1, 2)?;
                    let x = self.n(&a[0])?;
                    let digits = if a.len() > 1 {
                        self.n(&a[1])?.clamp(0.0, 6.0) as usize
                    } else {
                        1
                    };
                    return text(fmt_pct(x, digits));
                }
                "fmt_months" => {
                    Self::arity(name, a, 1, 1)?;
                    let x = self.n(&a[0])?;
                    return text(fmt_months(x));
                }
                "prop" | "filter" | "map" | "find" | "some" | "every" => {
                    return err(format!("{name}() is not available in metric expressions"));
                }
                _ => {}
            }
        }
        match lname.as_str() {
            // ---------------------------------------------------------- logic
            "if" => {
                Self::arity(name, a, 3, 3)?;
                if self.eval(&a[0])?.truthy() {
                    self.eval(&a[1])
                } else {
                    self.eval(&a[2])
                }
            }
            "ifs" => {
                let mut i = 0;
                while i + 1 < a.len() {
                    if self.eval(&a[i])?.truthy() {
                        return self.eval(&a[i + 1]);
                    }
                    i += 2;
                }
                if a.len() % 2 == 1 {
                    self.eval(&a[a.len() - 1])
                } else {
                    Ok(RowValue::Empty)
                }
            }
            "empty" => {
                Self::arity(name, a, 1, 1)?;
                Ok(RowValue::Bool(self.eval(&a[0])?.is_empty()))
            }
            "and" => {
                for x in a {
                    if !self.eval(x)?.truthy() {
                        return Ok(RowValue::Bool(false));
                    }
                }
                Ok(RowValue::Bool(true))
            }
            "or" => {
                for x in a {
                    if self.eval(x)?.truthy() {
                        return Ok(RowValue::Bool(true));
                    }
                }
                Ok(RowValue::Bool(false))
            }
            "not" => {
                Self::arity(name, a, 1, 1)?;
                Ok(RowValue::Bool(!self.eval(&a[0])?.truthy()))
            }
            "equal" | "unequal" => {
                Self::arity(name, a, 2, 2)?;
                let eq = values_equal(&self.eval(&a[0])?, &self.eval(&a[1])?);
                Ok(RowValue::Bool(if lname == "equal" { eq } else { !eq }))
            }
            "let" => {
                Self::arity(name, a, 3, 3)?;
                let Expr::Name(var) = &a[0] else {
                    return err("let() needs a variable name");
                };
                let v = self.eval(&a[1])?;
                let var = var.clone();
                self.with_scope(&[(&var, v)], |s| s.eval(&a[2]))
            }
            "lets" => {
                if a.len() < 3 || a.len().is_multiple_of(2) {
                    return err("lets() takes name, value pairs and an expression");
                }
                let base = self.scopes.len();
                let mut i = 0;
                while i + 1 < a.len() {
                    let Expr::Name(var) = &a[i] else {
                        self.scopes.truncate(base);
                        return err("lets() needs variable names");
                    };
                    let v = self.eval(&a[i + 1]);
                    let v = match v {
                        Ok(v) => v,
                        Err(e) => {
                            self.scopes.truncate(base);
                            return Err(e);
                        }
                    };
                    if self.scopes.len() >= MAX_LET_DEPTH {
                        self.scopes.truncate(base);
                        return err("Too many nested bindings");
                    }
                    self.scopes.push((var.clone(), v));
                    i += 2;
                }
                let r = self.eval(&a[a.len() - 1]);
                self.scopes.truncate(base);
                r
            }
            // ---------------------------------------------------------- properties
            "prop" => {
                Self::arity(name, a, 1, 2)?;
                if a.len() == 2 {
                    // method form: current.prop("x") → prop(current, "x")
                    let row = self.eval(&a[0])?;
                    let key = self.t(&a[1])?;
                    return match row {
                        RowValue::Row(id) => {
                            Ok(self.r.prop(Some(&id), &key).unwrap_or(RowValue::Empty))
                        }
                        RowValue::List(items) => {
                            let mut out = Vec::new();
                            for it in items {
                                if let RowValue::Row(id) = it {
                                    out.push(
                                        self.r.prop(Some(&id), &key).unwrap_or(RowValue::Empty),
                                    );
                                }
                            }
                            Ok(RowValue::List(out))
                        }
                        RowValue::Empty => Ok(RowValue::Empty),
                        _ => err("prop() expects a row"),
                    };
                }
                let key = self.t(&a[0])?;
                match self.r.prop(None, &key) {
                    Some(v) => Ok(v),
                    None => err(format!("Unknown property: {key}")),
                }
            }
            // ---------------------------------------------------------- text
            "length" => {
                Self::arity(name, a, 1, 1)?;
                match self.eval(&a[0])? {
                    RowValue::List(l) => num(l.len() as f64),
                    RowValue::Empty => num(0.0),
                    v => num(v.display().chars().count() as f64),
                }
            }
            "contains" => {
                Self::arity(name, a, 2, 2)?;
                let hay = self.eval(&a[0])?;
                let needle = self.eval(&a[1])?;
                Ok(RowValue::Bool(match hay {
                    RowValue::List(l) => l.iter().any(|x| values_equal(x, &needle)),
                    v => v.display().contains(&needle.display()),
                }))
            }
            "lower" => {
                Self::arity(name, a, 1, 1)?;
                text(self.t(&a[0])?.to_lowercase())
            }
            "upper" => {
                Self::arity(name, a, 1, 1)?;
                text(self.t(&a[0])?.to_uppercase())
            }
            "format" => {
                Self::arity(name, a, 1, 1)?;
                text(self.t(&a[0])?)
            }
            "concat" => {
                let mut vals = Vec::new();
                for x in a {
                    vals.push(self.eval(x)?);
                }
                if vals
                    .iter()
                    .all(|v| matches!(v, RowValue::List(_) | RowValue::Empty))
                    && vals.iter().any(|v| matches!(v, RowValue::List(_)))
                {
                    let mut out = Vec::new();
                    for v in vals {
                        if let RowValue::List(l) = v {
                            out.extend(l);
                        }
                    }
                    return Ok(RowValue::List(out));
                }
                text(vals.iter().map(|v| v.display()).collect())
            }
            "join" => {
                Self::arity(name, a, 1, 2)?;
                let l = self.list_arg(&a[0])?;
                let sep = if a.len() > 1 {
                    self.t(&a[1])?
                } else {
                    ", ".into()
                };
                text(l.iter().map(|v| v.display()).collect::<Vec<_>>().join(&sep))
            }
            "replace" | "replaceall" => {
                Self::arity(name, a, 3, 3)?;
                let s = self.t(&a[0])?;
                let pat = self.t(&a[1])?;
                let rep = self.t(&a[2])?;
                let re = build_regex(&pat, false).map_err(|e| EvalError {
                    message: format!("Invalid pattern: {e}"),
                })?;
                text(if lname == "replace" {
                    re.replace(&s, rep.as_str()).into_owned()
                } else {
                    re.replace_all(&s, rep.as_str()).into_owned()
                })
            }
            "test" => {
                Self::arity(name, a, 2, 2)?;
                let s = self.t(&a[0])?;
                let pat = self.t(&a[1])?;
                let re = build_regex(&pat, false).map_err(|e| EvalError {
                    message: format!("Invalid pattern: {e}"),
                })?;
                Ok(RowValue::Bool(re.is_match(&s)))
            }
            "substring" => {
                Self::arity(name, a, 2, 3)?;
                let s: Vec<char> = self.t(&a[0])?.chars().collect();
                let start = (self.n(&a[1])?.max(0.0) as usize).min(s.len());
                let end = if a.len() > 2 {
                    (self.n(&a[2])?.max(0.0) as usize).min(s.len())
                } else {
                    s.len()
                };
                text(if end > start {
                    s[start..end].iter().collect()
                } else {
                    String::new()
                })
            }
            "split" => {
                Self::arity(name, a, 1, 2)?;
                let s = self.t(&a[0])?;
                let sep = if a.len() > 1 {
                    self.t(&a[1])?
                } else {
                    " ".into()
                };
                let parts: Vec<RowValue> = if sep.is_empty() {
                    s.chars().map(|c| RowValue::Text(c.to_string())).collect()
                } else {
                    s.split(sep.as_str())
                        .map(|p| RowValue::Text(p.to_string()))
                        .collect()
                };
                Ok(RowValue::List(parts))
            }
            "trim" => {
                Self::arity(name, a, 1, 1)?;
                text(self.t(&a[0])?.trim().to_string())
            }
            // ---------------------------------------------------------- numbers
            "min" | "max" | "sum" | "mean" | "median" => {
                let v = self.numbers(a)?;
                if v.is_empty() {
                    return Ok(if lname == "sum" {
                        RowValue::Number(0.0)
                    } else {
                        RowValue::Empty
                    });
                }
                match lname.as_str() {
                    "min" => num(v.iter().copied().fold(f64::INFINITY, f64::min)),
                    "max" => num(v.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
                    "sum" => num(v.iter().sum()),
                    "mean" => num(v.iter().sum::<f64>() / v.len() as f64),
                    _ => {
                        let mut s = v.clone();
                        s.sort_by(|x, y| x.partial_cmp(y).unwrap_or(Ordering::Equal));
                        let n = s.len();
                        num(if n % 2 == 1 {
                            s[n / 2]
                        } else {
                            (s[n / 2 - 1] + s[n / 2]) / 2.0
                        })
                    }
                }
            }
            "abs" => {
                Self::arity(name, a, 1, 1)?;
                num(self.n(&a[0])?.abs())
            }
            "round" => {
                Self::arity(name, a, 1, 2)?;
                let x = self.n(&a[0])?;
                let d = if a.len() > 1 { self.n(&a[1])? } else { 0.0 };
                num(crate::functions::math::round_half_away(x, d))
            }
            "ceil" => {
                Self::arity(name, a, 1, 1)?;
                num(self.n(&a[0])?.ceil())
            }
            "floor" => {
                Self::arity(name, a, 1, 1)?;
                num(self.n(&a[0])?.floor())
            }
            "sqrt" => {
                Self::arity(name, a, 1, 1)?;
                let x = self.n(&a[0])?;
                if x < 0.0 {
                    Ok(RowValue::Empty)
                } else {
                    num(x.sqrt())
                }
            }
            "pow" => {
                Self::arity(name, a, 2, 2)?;
                let (x, y) = (self.n(&a[0])?, self.n(&a[1])?);
                num(x.powf(y))
            }
            "mod" => {
                Self::arity(name, a, 2, 2)?;
                let (x, y) = (self.n(&a[0])?, self.n(&a[1])?);
                if y == 0.0 {
                    Ok(RowValue::Empty)
                } else {
                    num(x % y)
                }
            }
            "tonumber" => {
                Self::arity(name, a, 1, 1)?;
                Ok(match self.eval(&a[0])? {
                    RowValue::Number(n) => RowValue::Number(n),
                    RowValue::Bool(b) => RowValue::Number(if b { 1.0 } else { 0.0 }),
                    RowValue::Text(s) => crate::value::parse_number_text(&s)
                        .map(RowValue::Number)
                        .unwrap_or(RowValue::Empty),
                    RowValue::Date(d) => {
                        RowValue::Number(d.start.and_utc().timestamp_millis() as f64)
                    }
                    _ => RowValue::Empty,
                })
            }
            // ---------------------------------------------------------- dates
            "now" => {
                Self::arity(name, a, 0, 0)?;
                self.uses_now = true;
                Ok(RowValue::Date(DateVal::at(self.r.now())))
            }
            "today" => {
                Self::arity(name, a, 0, 0)?;
                self.uses_now = true;
                Ok(RowValue::Date(DateVal::day(self.r.now().date())))
            }
            "year" | "month" | "day" | "date" | "week" | "hour" | "minute" => {
                Self::arity(name, a, 1, 1)?;
                let Some(d) = self.d(&a[0])? else {
                    return Ok(RowValue::Empty);
                };
                let s = d.start;
                num(match lname.as_str() {
                    "year" => s.year() as f64,
                    "month" => s.month() as f64,
                    "day" => s.weekday().number_from_monday() as f64,
                    "date" => s.day() as f64,
                    "week" => s.iso_week().week() as f64,
                    "hour" => s.hour() as f64,
                    _ => s.minute() as f64,
                })
            }
            "dateadd" | "datesubtract" => {
                Self::arity(name, a, 3, 3)?;
                let Some(d) = self.d(&a[0])? else {
                    return Ok(RowValue::Empty);
                };
                let mut amount = self.n(&a[1])?;
                if lname == "datesubtract" {
                    amount = -amount;
                }
                let unit = self.t(&a[2])?;
                Ok(RowValue::Date(DateVal {
                    start: add_unit(d.start, amount, &unit)?,
                    end: None,
                    time: d.time,
                }))
            }
            "datebetween" => {
                Self::arity(name, a, 3, 3)?;
                let (Some(x), Some(y)) = (self.d(&a[0])?, self.d(&a[1])?) else {
                    return Ok(RowValue::Empty);
                };
                let unit = self.t(&a[2])?;
                num(between(x.start, y.start, &unit)?)
            }
            "datestart" | "dateend" => {
                Self::arity(name, a, 1, 1)?;
                let Some(d) = self.d(&a[0])? else {
                    return Ok(RowValue::Empty);
                };
                let v = if lname == "datestart" {
                    d.start
                } else {
                    d.end.unwrap_or(d.start)
                };
                Ok(RowValue::Date(DateVal {
                    start: v,
                    end: None,
                    time: d.time,
                }))
            }
            "formatdate" => {
                Self::arity(name, a, 2, 2)?;
                let Some(d) = self.d(&a[0])? else {
                    return Ok(RowValue::Empty);
                };
                let f = self.t(&a[1])?;
                text(format_date(&d.start, &f))
            }
            "parsedate" => {
                Self::arity(name, a, 1, 1)?;
                let s = self.t(&a[0])?;
                Ok(parse_date(&s)
                    .map(RowValue::Date)
                    .unwrap_or(RowValue::Empty))
            }
            "timestamp" => {
                Self::arity(name, a, 1, 1)?;
                let Some(d) = self.d(&a[0])? else {
                    return Ok(RowValue::Empty);
                };
                num(d.start.and_utc().timestamp_millis() as f64)
            }
            "fromtimestamp" => {
                Self::arity(name, a, 1, 1)?;
                let ms = self.n(&a[0])?;
                match chrono::DateTime::from_timestamp_millis(ms as i64) {
                    Some(dt) => Ok(RowValue::Date(DateVal::at(dt.naive_utc()))),
                    None => Ok(RowValue::Empty),
                }
            }
            // ---------------------------------------------------------- lists
            "at" => {
                Self::arity(name, a, 2, 2)?;
                let l = self.list_arg(&a[0])?;
                let i = self.n(&a[1])? as i64;
                let idx = if i < 0 { l.len() as i64 + i } else { i };
                Ok(l.get(idx.max(0) as usize)
                    .filter(|_| idx >= 0)
                    .cloned()
                    .unwrap_or(RowValue::Empty))
            }
            "first" | "last" => {
                Self::arity(name, a, 1, 1)?;
                let l = self.list_arg(&a[0])?;
                Ok(if lname == "first" {
                    l.first()
                } else {
                    l.last()
                }
                .cloned()
                .unwrap_or(RowValue::Empty))
            }
            "slice" => {
                Self::arity(name, a, 2, 3)?;
                let l = self.list_arg(&a[0])?;
                let n = l.len() as i64;
                let norm =
                    |i: i64| -> usize { (if i < 0 { n + i } else { i }).clamp(0, n) as usize };
                let s = norm(self.n(&a[1])? as i64);
                let e = if a.len() > 2 {
                    norm(self.n(&a[2])? as i64)
                } else {
                    n as usize
                };
                Ok(RowValue::List(if e > s {
                    l[s..e].to_vec()
                } else {
                    Vec::new()
                }))
            }
            "sort" => {
                Self::arity(name, a, 1, 2)?;
                let l = self.list_arg(&a[0])?;
                let mut keyed = Vec::with_capacity(l.len());
                for (i, v) in l.into_iter().enumerate() {
                    let k = if a.len() > 1 {
                        self.with_scope(
                            &[
                                ("current", v.clone()),
                                ("index", RowValue::Number(i as f64)),
                            ],
                            |s| s.eval(&a[1]),
                        )?
                    } else {
                        v.clone()
                    };
                    keyed.push((k, v));
                }
                keyed.sort_by(|x, y| cmp_row(&x.0, &y.0).unwrap_or(Ordering::Equal));
                Ok(RowValue::List(keyed.into_iter().map(|x| x.1).collect()))
            }
            "reverse" => {
                Self::arity(name, a, 1, 1)?;
                let mut l = self.list_arg(&a[0])?;
                l.reverse();
                Ok(RowValue::List(l))
            }
            "unique" => {
                Self::arity(name, a, 1, 1)?;
                let l = self.list_arg(&a[0])?;
                let mut out: Vec<RowValue> = Vec::new();
                for v in l {
                    if !out.iter().any(|x| values_equal(x, &v)) {
                        out.push(v);
                    }
                }
                Ok(RowValue::List(out))
            }
            "includes" => {
                Self::arity(name, a, 2, 2)?;
                let l = self.list_arg(&a[0])?;
                let v = self.eval(&a[1])?;
                Ok(RowValue::Bool(l.iter().any(|x| values_equal(x, &v))))
            }
            "filter" | "map" | "find" | "findindex" | "some" | "every" | "count" => {
                let l = self.list_arg(&a[0])?;
                if lname == "count" && a.len() == 1 {
                    return num(l.iter().filter(|v| !v.is_empty()).count() as f64);
                }
                Self::arity(name, a, 2, 2)?;
                let mut out = Vec::new();
                let mut count = 0usize;
                for (i, v) in l.into_iter().enumerate() {
                    let r = self.with_scope(
                        &[
                            ("current", v.clone()),
                            ("index", RowValue::Number(i as f64)),
                        ],
                        |s| s.eval(&a[1]),
                    )?;
                    match lname.as_str() {
                        "map" => out.push(r),
                        "filter" => {
                            if r.truthy() {
                                out.push(v);
                            }
                        }
                        "find" => {
                            if r.truthy() {
                                return Ok(v);
                            }
                        }
                        "findindex" => {
                            if r.truthy() {
                                return num(i as f64);
                            }
                        }
                        "some" => {
                            if r.truthy() {
                                return Ok(RowValue::Bool(true));
                            }
                        }
                        "every" => {
                            if !r.truthy() {
                                return Ok(RowValue::Bool(false));
                            }
                        }
                        _ => {
                            if r.truthy() {
                                count += 1;
                            }
                        }
                    }
                }
                match lname.as_str() {
                    "map" | "filter" => Ok(RowValue::List(out)),
                    "find" => Ok(RowValue::Empty),
                    "findindex" => num(-1.0),
                    "some" => Ok(RowValue::Bool(false)),
                    "every" => Ok(RowValue::Bool(true)),
                    _ => num(count as f64),
                }
            }
            "flat" => {
                Self::arity(name, a, 1, 1)?;
                let l = self.list_arg(&a[0])?;
                let mut out = Vec::new();
                for v in l {
                    match v {
                        RowValue::List(inner) => out.extend(inner),
                        other => out.push(other),
                    }
                }
                Ok(RowValue::List(out))
            }
            // ---------------------------------------------------------- finance
            "pmt" | "fv" | "pv" => {
                Self::arity(name, a, 3, 5)?;
                let (r, n, x) = (self.n(&a[0])?, self.n(&a[1])?, self.n(&a[2])?);
                let y = if a.len() > 3 { self.n(&a[3])? } else { 0.0 };
                let t = if a.len() > 4 { self.n(&a[4])? } else { 0.0 };
                let t = if t != 0.0 { 1.0 } else { 0.0 };
                use crate::functions::finance as f;
                match lname.as_str() {
                    "pmt" => match f::pmt(r, n, x, y, t) {
                        Ok(v) => num(v),
                        Err(_) => Ok(RowValue::Empty),
                    },
                    "fv" => num(f::fv(r, n, x, y, t)),
                    _ => num(f::pv(r, n, x, y, t)),
                }
            }
            "npv" => {
                Self::arity(name, a, 2, 255)?;
                let r = self.n(&a[0])?;
                let v = self.numbers(&a[1..])?;
                num(crate::functions::finance::npv(r, &v))
            }
            "irr" => {
                Self::arity(name, a, 1, 2)?;
                let v = self.numbers(&a[..1])?;
                let g = if a.len() > 1 { self.n(&a[1])? } else { 0.1 };
                match crate::functions::finance::irr(&v, g) {
                    Ok(x) => num(x),
                    Err(_) => Ok(RowValue::Empty),
                }
            }
            "fx" => {
                Self::arity(name, a, 2, 2)?;
                let from = self.t(&a[0])?.to_ascii_uppercase();
                let to = self.t(&a[1])?.to_ascii_uppercase();
                if from == to {
                    return num(1.0);
                }
                match self.r.fx(&from, &to) {
                    Some((rate, stale)) => {
                        self.stale |= stale;
                        num(rate)
                    }
                    None => {
                        self.stale = true;
                        Ok(RowValue::Empty)
                    }
                }
            }
            _ => err(format!("Unknown function: {name}")),
        }
    }
}

/// Deep equality (text is case-sensitive, numbers exact).
pub fn values_equal(a: &RowValue, b: &RowValue) -> bool {
    match (a, b) {
        (RowValue::Date(x), RowValue::Date(y)) => x.start == y.start,
        _ => a == b,
    }
}

/// Binary operator semantics. Division by zero gives empty (Notion).
pub fn binop(op: BinaryOp, x: &RowValue, y: &RowValue) -> Res {
    use RowValue as V;
    match op {
        BinaryOp::Eq => return Ok(V::Bool(values_equal(x, y))),
        BinaryOp::Ne => return Ok(V::Bool(!values_equal(x, y))),
        BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
            if x.is_empty() || y.is_empty() {
                return Ok(V::Bool(false));
            }
            let Some(o) = cmp_row(x, y) else {
                return err(format!(
                    "Cannot compare {} and {}",
                    x.type_name(),
                    y.type_name()
                ));
            };
            return Ok(V::Bool(match op {
                BinaryOp::Lt => o == Ordering::Less,
                BinaryOp::Le => o != Ordering::Greater,
                BinaryOp::Gt => o == Ordering::Greater,
                _ => o != Ordering::Less,
            }));
        }
        BinaryOp::And => return Ok(V::Bool(x.truthy() && y.truthy())),
        BinaryOp::Or => return Ok(V::Bool(x.truthy() || y.truthy())),
        _ => {}
    }
    if matches!(op, BinaryOp::Add | BinaryOp::Concat) {
        match (x, y) {
            (V::Text(_), _) | (_, V::Text(_)) => {
                return text(format!("{}{}", x.display(), y.display()));
            }
            (V::List(a), V::List(b)) => return Ok(V::List(a.iter().chain(b).cloned().collect())),
            _ => {}
        }
    }
    let a = match x {
        V::Empty => 0.0,
        v => match v.as_number() {
            Some(n) => n,
            None => return err(format!("Cannot use {} in arithmetic", v.type_name())),
        },
    };
    let b = match y {
        V::Empty => 0.0,
        v => match v.as_number() {
            Some(n) => n,
            None => return err(format!("Cannot use {} in arithmetic", v.type_name())),
        },
    };
    match op {
        BinaryOp::Add | BinaryOp::Concat => num(a + b),
        BinaryOp::Sub => num(a - b),
        BinaryOp::Mul => num(a * b),
        BinaryOp::Div => {
            if b == 0.0 {
                Ok(V::Empty)
            } else {
                num(a / b)
            }
        }
        BinaryOp::Mod => {
            if b == 0.0 {
                Ok(V::Empty)
            } else {
                num(a % b)
            }
        }
        BinaryOp::Pow => num(a.powf(b)),
        _ => err("Unsupported operator"),
    }
}

fn add_unit(d: NaiveDateTime, amount: f64, unit: &str) -> Result<NaiveDateTime, EvalError> {
    let u = unit.trim().to_ascii_lowercase();
    let u = u.trim_end_matches('s');
    let n = amount.trunc() as i64;
    let out = match u {
        "year" => shift_months(d, n * 12),
        "quarter" => shift_months(d, n * 3),
        "month" => shift_months(d, n),
        "week" => d.checked_add_signed(Duration::days(n * 7)),
        "day" => d.checked_add_signed(Duration::days(n)),
        "hour" => d.checked_add_signed(Duration::hours(n)),
        "minute" => d.checked_add_signed(Duration::minutes(n)),
        "second" => d.checked_add_signed(Duration::seconds(n)),
        "millisecond" => d.checked_add_signed(Duration::milliseconds(n)),
        _ => return err(format!("Unknown date unit: {unit}")),
    };
    out.ok_or(EvalError {
        message: "Date out of range".into(),
    })
}

fn shift_months(d: NaiveDateTime, n: i64) -> Option<NaiveDateTime> {
    if n >= 0 {
        d.checked_add_months(Months::new(n as u32))
    } else {
        d.checked_sub_months(Months::new((-n) as u32))
    }
}

fn between(a: NaiveDateTime, b: NaiveDateTime, unit: &str) -> Result<f64, EvalError> {
    let u = unit.trim().to_ascii_lowercase();
    let u = u.trim_end_matches('s');
    let secs = (a - b).num_seconds() as f64;
    let months = || -> f64 {
        let mut m = (a.year() - b.year()) as i64 * 12 + a.month() as i64 - b.month() as i64;
        let cmp_rest = (a.day(), a.time()).cmp(&(b.day(), b.time()));
        if m > 0 && cmp_rest == Ordering::Less {
            m -= 1;
        } else if m < 0 && cmp_rest == Ordering::Greater {
            m += 1;
        }
        m as f64
    };
    Ok(match u {
        "year" => (months() / 12.0).trunc(),
        "quarter" => (months() / 3.0).trunc(),
        "month" => months(),
        "week" => (secs / (7.0 * 86_400.0)).trunc(),
        "day" => (secs / 86_400.0).trunc(),
        "hour" => (secs / 3600.0).trunc(),
        "minute" => (secs / 60.0).trunc(),
        "second" => secs,
        "millisecond" => (a - b).num_milliseconds() as f64,
        _ => return err(format!("Unknown date unit: {unit}")),
    })
}

/// Parse ISO-ish date text (`2024-01-15`, `2024-01-15T09:30`, `2024-01-15 09:30:00`).
pub fn parse_date(s: &str) -> Option<DateVal> {
    let t = s.trim();
    if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        return Some(DateVal::day(d));
    }
    for f in [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S%.f",
    ] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(t.trim_end_matches('Z'), f) {
            return Some(DateVal::at(dt));
        }
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(t) {
        return Some(DateVal::at(dt.naive_utc()));
    }
    let serial = crate::datetime::parse_datetime_text(t, false)?;
    let dt = crate::datetime::serial_to_datetime(serial, false)?;
    Some(if serial.fract() == 0.0 {
        DateVal::day(dt.date())
    } else {
        DateVal::at(dt)
    })
}

/// Moment-style date formatting (`YYYY-MM-DD`, `MMMM D, YYYY`, `ddd`, `HH:mm`, `h:mm A`).
pub fn format_date(d: &NaiveDateTime, f: &str) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const DAYS: [&str; 7] = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ];
    let chars: Vec<char> = f.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '['
            && let Some(end) = chars[i..].iter().position(|x| *x == ']')
        {
            out.extend(&chars[i + 1..i + end]);
            i += end + 1;
            continue;
        }
        let mut n = 1;
        while i + n < chars.len() && chars[i + n] == c {
            n += 1;
        }
        let m = d.month() as usize;
        let wd = d.weekday().num_days_from_monday() as usize;
        let h12 = if d.hour().is_multiple_of(12) {
            12
        } else {
            d.hour() % 12
        };
        let piece = match (c, n) {
            ('Y', 4) => format!("{:04}", d.year()),
            ('Y', 2) => format!("{:02}", d.year().rem_euclid(100)),
            ('M', 4) => MONTHS[m - 1].to_string(),
            ('M', 3) => MONTHS[m - 1][..3].to_string(),
            ('M', 2) => format!("{m:02}"),
            ('M', 1) => m.to_string(),
            ('D', 2) => format!("{:02}", d.day()),
            ('D', 1) => d.day().to_string(),
            ('d', 4) => DAYS[wd].to_string(),
            ('d', 3) => DAYS[wd][..3].to_string(),
            ('d', 1) => (wd + 1).to_string(),
            ('H', 2) => format!("{:02}", d.hour()),
            ('H', 1) => d.hour().to_string(),
            ('h', 2) => format!("{h12:02}"),
            ('h', 1) => h12.to_string(),
            ('m', 2) => format!("{:02}", d.minute()),
            ('m', 1) => d.minute().to_string(),
            ('s', 2) => format!("{:02}", d.second()),
            ('s', 1) => d.second().to_string(),
            ('A', 1) => if d.hour() >= 12 { "PM" } else { "AM" }.to_string(),
            ('a', 1) => if d.hour() >= 12 { "pm" } else { "am" }.to_string(),
            _ => std::iter::repeat_n(c, n).collect(),
        };
        out.push_str(&piece);
        i += n;
    }
    out
}

fn currency_symbol(code: &str) -> Option<&'static str> {
    Some(match code {
        "USD" | "CAD" | "AUD" | "NZD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" | "CNY" => "¥",
        "INR" => "₹",
        "CHF" => "CHF ",
        _ => return None,
    })
}

/// `fmt_money(x)`: `$1,234` for whole amounts, `$1,234.56` otherwise; negatives as `-$12.00`.
pub fn fmt_money(x: f64, currency: &str) -> String {
    let code = if x.fract().abs() < 0.005 {
        "#,##0"
    } else {
        "#,##0.00"
    };
    let body =
        crate::numfmt::format_number_with_code(x.abs(), code, &crate::numfmt::NumLocale::default());
    let sign = if x < 0.0 && body.chars().any(|c| c.is_ascii_digit() && c != '0') {
        "-"
    } else {
        ""
    };
    match currency_symbol(currency) {
        Some(s) => format!("{sign}{s}{body}"),
        None => format!("{sign}{body} {currency}"),
    }
}

/// `fmt_pct(x)`: a fraction as a percentage (`0.123` → `12.3%`).
pub fn fmt_pct(x: f64, digits: usize) -> String {
    let s = format!("{:.*}", digits, x * 100.0);
    let s = if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    };
    let s = if s == "-0" { "0".to_string() } else { s };
    format!("{s}%")
}

/// `fmt_months(x)`: `1 month`, `3 months`, `2.5 months`.
pub fn fmt_months(x: f64) -> String {
    let r = (x * 10.0).round() / 10.0;
    let s = if r.fract() == 0.0 {
        format!("{}", r as i64)
    } else {
        format!("{r:.1}")
    };
    if (r - 1.0).abs() < f64::EPSILON {
        format!("{s} month")
    } else {
        format!("{s} months")
    }
}
