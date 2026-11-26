//! Metric dialect (`Dialect::Metric`, SPEC §14.7) for life-app metrics and advisor rules.
//!
//! Identifiers: `metrics.<name>`, `answers.<id>`, `today`, `pack.<path>`. Functions: `if and or not min max
//! abs round coalesce days_between months_between fmt_money fmt_pct fmt_months`. Messages interpolate
//! with `{{expr}}`. The dialect has no IO and no row access.

use super::eval::{DialectEval, Resolver};
use super::value::{DateVal, RowValue};
use crate::ast::Expr;
use crate::parser::{Dialect, ParseError, parse};
use chrono::{NaiveDate, NaiveDateTime};
use std::collections::HashMap;

/// What a metric expression can read.
pub trait MetricContext {
    /// `metrics.<name>`.
    fn metric(&self, name: &str) -> Option<RowValue>;
    /// `answers.<id>`.
    fn answer(&self, id: &str) -> Option<RowValue>;
    /// `pack.<path…>` (jurisdiction / tax packs).
    fn pack(&self, path: &[String]) -> Option<RowValue> {
        let _ = path;
        None
    }
    /// `today`.
    fn today(&self) -> NaiveDate;
}

/// A map-backed context.
#[derive(Clone, Debug, Default)]
pub struct MapMetricContext {
    /// Metrics.
    pub metrics: HashMap<String, RowValue>,
    /// Answers.
    pub answers: HashMap<String, RowValue>,
    /// Pack values keyed by dotted path.
    pub pack: HashMap<String, RowValue>,
    /// Today.
    pub today: NaiveDate,
}

impl MetricContext for MapMetricContext {
    fn metric(&self, name: &str) -> Option<RowValue> {
        self.metrics.get(name).cloned()
    }
    fn answer(&self, id: &str) -> Option<RowValue> {
        self.answers.get(id).cloned()
    }
    fn pack(&self, path: &[String]) -> Option<RowValue> {
        self.pack.get(&path.join(".")).cloned()
    }
    fn today(&self) -> NaiveDate {
        self.today
    }
}

struct Adapter<'a>(&'a dyn MetricContext);

impl Resolver for Adapter<'_> {
    fn path(&self, parts: &[String]) -> Option<RowValue> {
        match parts.first().map(|s| s.as_str()) {
            Some("metrics") if parts.len() == 2 => self.0.metric(&parts[1]),
            Some("answers") if parts.len() == 2 => self.0.answer(&parts[1]),
            Some("pack") if parts.len() >= 2 => self.0.pack(&parts[1..]),
            _ => None,
        }
    }
    fn ident(&self, name: &str) -> Option<RowValue> {
        (name == "today").then(|| RowValue::Date(DateVal::day(self.0.today())))
    }
    fn now(&self) -> NaiveDateTime {
        self.0.today().and_hms_opt(0, 0, 0).unwrap_or_default()
    }
}

/// Validate a metric expression: it must parse and only use the allowed roots.
pub fn validate(src: &str) -> Result<Expr, ParseError> {
    let e = parse(src, Dialect::Metric)?;
    let mut bad: Option<String> = None;
    e.walk(&mut |x| match x {
        Expr::Path(p) if !matches!(p[0].as_str(), "metrics" | "answers" | "pack") => {
            bad.get_or_insert(format!("Unknown identifier: {}", p.join(".")));
        }
        Expr::Name(n) if n != "today" => {
            bad.get_or_insert(format!("Unknown identifier: {n}"));
        }
        Expr::Call { name, .. } if !ALLOWED.contains(&name.as_str()) => {
            bad.get_or_insert(format!("Unknown function: {name}"));
        }
        Expr::Method { .. } | Expr::List(_) => {
            bad.get_or_insert("Lists and methods are not available in metric expressions".into());
        }
        _ => {}
    });
    match bad {
        Some(m) => Err(ParseError {
            message: m,
            start: 0,
            end: src.len(),
        }),
        None => Ok(e),
    }
}

const ALLOWED: &[&str] = &[
    "if",
    "and",
    "or",
    "not",
    "min",
    "max",
    "abs",
    "round",
    "coalesce",
    "days_between",
    "months_between",
    "fmt_money",
    "fmt_pct",
    "fmt_months",
];

/// Metric names referenced (`metrics.<name>`), for dependency tracking.
pub fn metric_deps(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(e) = parse(src, Dialect::Metric) {
        e.walk(&mut |x| {
            if let Expr::Path(p) = x
                && p.len() == 2
                && p[0] == "metrics"
                && !out.contains(&p[1])
            {
                out.push(p[1].clone());
            }
        });
    }
    out
}

/// Evaluate an expression to a value (panic-safe).
pub fn eval(src: &str, ctx: &dyn MetricContext) -> Result<RowValue, String> {
    let e = validate(src).map_err(|e| e.message)?;
    eval_expr(&e, ctx)
}

/// Evaluate a validated expression.
pub fn eval_expr(e: &Expr, ctx: &dyn MetricContext) -> Result<RowValue, String> {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let a = Adapter(ctx);
        let mut ev = DialectEval::new(&a, Dialect::Metric);
        ev.eval(e)
    }));
    match r {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e.message),
        Err(_) => Err("Internal error".into()),
    }
}

/// Evaluate an advisor `when` condition. Missing metrics make the condition false.
pub fn test(src: &str, ctx: &dyn MetricContext) -> Result<bool, String> {
    eval(src, ctx).map(|v| v.truthy())
}

/// Replace every `{{expr}}` in a message with its displayed value (`—` when it fails).
pub fn interpolate(template: &str, ctx: &dyn MetricContext) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let expr = after[..end].trim();
                match eval(expr, ctx) {
                    Ok(v) if !v.is_empty() => out.push_str(&v.display()),
                    _ => out.push('—'),
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> MapMetricContext {
        let mut c = MapMetricContext {
            today: NaiveDate::from_ymd_opt(2026, 11, 26).unwrap_or_default(),
            ..Default::default()
        };
        c.metrics
            .insert("savings_rate".into(), RowValue::Number(0.083));
        c.metrics.insert("buffer".into(), RowValue::Number(12500.0));
        c.metrics.insert("burn".into(), RowValue::Number(3000.0));
        c.answers.insert("has_budget".into(), RowValue::Bool(true));
        c.answers
            .insert("goal_date".into(), RowValue::Text("2027-02-26".into()));
        c.pack
            .insert("us.ira_limit".into(), RowValue::Number(7000.0));
        c
    }

    #[test]
    fn conditions() {
        let c = ctx();
        assert_eq!(
            test("metrics.savings_rate < 0.1 and answers.has_budget", &c),
            Ok(true)
        );
        assert_eq!(test("metrics.missing > 1", &c), Ok(false));
        assert_eq!(
            test("not answers.has_budget or metrics.buffer >= 10000", &c),
            Ok(true)
        );
        assert_eq!(
            eval("max(metrics.buffer / metrics.burn, 0)", &c)
                .ok()
                .and_then(|v| v.as_number())
                .map(|x| (x * 100.0).round()),
            Some(417.0)
        );
        assert_eq!(
            eval("coalesce(metrics.nothing, 5)", &c),
            Ok(RowValue::Number(5.0))
        );
        assert_eq!(
            eval("days_between(today, answers.goal_date)", &c),
            Ok(RowValue::Number(92.0))
        );
        assert_eq!(
            eval("months_between(today, answers.goal_date)", &c),
            Ok(RowValue::Number(3.0))
        );
        assert_eq!(
            eval("pack.us.ira_limit * 2", &c),
            Ok(RowValue::Number(14000.0))
        );
        assert_eq!(
            eval("if(metrics.buffer > 1, \"ok\", \"low\")", &c),
            Ok(RowValue::Text("ok".into()))
        );
        // Advisor titles pick singular / plural this way (lifeapps/*.json).
        assert_eq!(
            interpolate("{{if(metrics.buffer == 12500, \"one\", \"many\")}}", &c),
            "one"
        );
        assert_eq!(
            interpolate("{{if(metrics.buffer == 1, \"one\", \"many\")}}", &c),
            "many"
        );
        assert!(eval("prop(\"x\")", &c).is_err());
        assert!(validate("rows.x").is_err());
        assert!(validate("foo").is_err());
        assert_eq!(
            metric_deps("metrics.a + metrics.b * metrics.a"),
            vec!["a", "b"]
        );
    }

    #[test]
    fn formatting_and_templates() {
        let c = ctx();
        assert_eq!(
            eval("fmt_money(metrics.buffer)", &c),
            Ok(RowValue::Text("$12,500".into()))
        );
        assert_eq!(
            eval("fmt_money(-12.5, \"EUR\")", &c),
            Ok(RowValue::Text("-€12.50".into()))
        );
        assert_eq!(
            eval("fmt_pct(metrics.savings_rate)", &c),
            Ok(RowValue::Text("8.3%".into()))
        );
        assert_eq!(
            eval("fmt_months(metrics.buffer / metrics.burn)", &c),
            Ok(RowValue::Text("4.2 months".into()))
        );
        assert_eq!(
            eval("fmt_months(1)", &c),
            Ok(RowValue::Text("1 month".into()))
        );
        let s = interpolate(
            "You save {{fmt_pct(metrics.savings_rate)}} — buffer {{fmt_money(metrics.buffer)}} ({{metrics.nope}})",
            &c,
        );
        assert_eq!(s, "You save 8.3% — buffer $12,500 (—)");
        assert_eq!(interpolate("no braces", &c), "no braces");
        assert_eq!(interpolate("open {{ only", &c), "open {{ only");
    }
}
