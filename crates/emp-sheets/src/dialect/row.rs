//! Database formula dialect (`Dialect::Row`, SPEC §14.6).

use super::eval::{DialectEval, Resolver};
use super::typecheck::{Ty, TypeEnv};
use super::value::RowValue;
use crate::ast::Expr;
use crate::parser::{Dialect, ParseError, parse};
use crate::printer::{NoSheets, PrintOptions, print};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// What a Row formula can read.
pub trait RowContext {
    /// A property of the current row, by name or by `#<propId>`.
    fn prop(&self, key: &str) -> Option<RowValue>;
    /// A property of a related row (`current.prop("Amount")` inside relation maps).
    fn related_prop(&self, row_id: &str, key: &str) -> Option<RowValue> {
        let _ = (row_id, key);
        None
    }
    /// The clock.
    fn now(&self) -> NaiveDateTime;
    /// Cached FX rate and staleness.
    fn fx(&self, from: &str, to: &str) -> Option<(f64, bool)> {
        let _ = (from, to);
        None
    }
}

struct Adapter<'a>(&'a dyn RowContext);

impl Resolver for Adapter<'_> {
    fn prop(&self, row: Option<&str>, key: &str) -> Option<RowValue> {
        match row {
            None => self.0.prop(key),
            Some(id) => self.0.related_prop(id, key),
        }
    }
    fn now(&self) -> NaiveDateTime {
        self.0.now()
    }
    fn fx(&self, from: &str, to: &str) -> Option<(f64, bool)> {
        self.0.fx(from, to)
    }
}

/// A simple map-backed context (tests, previews).
#[derive(Clone, Debug, Default)]
pub struct MapRowContext {
    /// Current row properties.
    pub props: HashMap<String, RowValue>,
    /// Related rows: id → properties.
    pub rows: HashMap<String, HashMap<String, RowValue>>,
    /// Clock.
    pub now: NaiveDateTime,
    /// FX rates `(from, to) → (rate, stale)`.
    pub fx: HashMap<(String, String), (f64, bool)>,
}

impl RowContext for MapRowContext {
    fn prop(&self, key: &str) -> Option<RowValue> {
        self.props.get(key).cloned()
    }
    fn related_prop(&self, row_id: &str, key: &str) -> Option<RowValue> {
        self.rows.get(row_id).and_then(|r| r.get(key)).cloned()
    }
    fn now(&self) -> NaiveDateTime {
        self.now
    }
    fn fx(&self, from: &str, to: &str) -> Option<(f64, bool)> {
        self.fx.get(&(from.to_string(), to.to_string())).copied()
    }
}

/// A parsed Row formula with its dependencies.
#[derive(Clone, Debug, PartialEq)]
pub struct RowFormula {
    /// AST.
    pub expr: Expr,
    /// Property keys referenced with `prop("…")` (as written: names or `#ids`).
    pub props: Vec<String>,
    /// Uses `now()` / `today()` (re-evaluate on the 1-minute tick).
    pub uses_now: bool,
}

/// Result of evaluating a Row formula.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowResult {
    /// Value.
    pub value: RowValue,
    /// Display string.
    pub display: String,
    /// An `fx()` rate was stale or missing.
    pub stale: bool,
}

/// `db_formula_check` result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCheck {
    /// Valid?
    pub ok: bool,
    /// Result type name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    /// Error with byte span.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RowCheckError>,
}

/// Error part of [`RowCheck`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowCheckError {
    /// Message.
    pub message: String,
    /// Start byte.
    pub from: usize,
    /// End byte.
    pub to: usize,
}

/// Parse a Row formula.
pub fn compile(src: &str) -> Result<RowFormula, ParseError> {
    let expr = parse(src, Dialect::Row)?;
    let mut props = Vec::new();
    let mut uses_now = false;
    expr.walk(&mut |e| match e {
        Expr::Call { name, args } | Expr::Method { name, args, .. } => {
            let l = name.to_ascii_lowercase();
            if l == "prop"
                && matches!(e, Expr::Call { .. })
                && let Some(Expr::Text(k)) = args.first()
                && !props.contains(k)
            {
                props.push(k.clone());
            }
            if l == "now" || l == "today" {
                uses_now = true;
            }
        }
        _ => {}
    });
    Ok(RowFormula {
        expr,
        props,
        uses_now,
    })
}

/// Evaluate a compiled Row formula (panic-safe). Runtime errors are returned as messages.
pub fn eval(f: &RowFormula, ctx: &dyn RowContext) -> Result<RowResult, String> {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let adapter = Adapter(ctx);
        let mut ev = DialectEval::new(&adapter, Dialect::Row);
        let v = ev.eval(&f.expr);
        (v, ev.stale)
    }));
    match r {
        Ok((Ok(value), stale)) => Ok(RowResult {
            display: value.display(),
            value,
            stale,
        }),
        Ok((Err(e), _)) => Err(e.message),
        Err(_) => Err("Internal error".into()),
    }
}

/// Parse and evaluate in one step.
pub fn eval_str(src: &str, ctx: &dyn RowContext) -> Result<RowResult, String> {
    let f = compile(src).map_err(|e| e.message)?;
    eval(&f, ctx)
}

/// Static type check (`db_formula_check`). `props` gives the type of a property by name or `#id`.
pub fn check(src: &str, props: &dyn Fn(&str) -> Option<Ty>) -> RowCheck {
    let expr = match parse(src, Dialect::Row) {
        Ok(e) => e,
        Err(e) => {
            return RowCheck {
                ok: false,
                r#type: None,
                error: Some(RowCheckError {
                    message: e.message,
                    from: e.start,
                    to: e.end,
                }),
            };
        }
    };
    let mut env = TypeEnv::new(props);
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| env.infer(&expr))) {
        Ok(Ok(t)) => RowCheck {
            ok: true,
            r#type: Some(t.name().to_string()),
            error: None,
        },
        Ok(Err(m)) => RowCheck {
            ok: false,
            r#type: None,
            error: Some(RowCheckError {
                message: m,
                from: 0,
                to: src.len(),
            }),
        },
        Err(_) => RowCheck {
            ok: false,
            r#type: None,
            error: Some(RowCheckError {
                message: "Internal error".into(),
                from: 0,
                to: src.len(),
            }),
        },
    }
}

fn rewrite_props(src: &str, map: &dyn Fn(&str) -> Option<String>) -> Result<String, ParseError> {
    let mut expr = parse(src, Dialect::Row)?;
    expr.walk_mut(&mut |e| {
        if let Expr::Call { name, args } = e
            && name.eq_ignore_ascii_case("prop")
            && args.len() == 1
            && let Expr::Text(k) = &mut args[0]
            && let Some(n) = map(k)
        {
            *k = n;
        }
    });
    Ok(print(
        &expr,
        &NoSheets,
        PrintOptions {
            dialect: Dialect::Row,
            xlfn: false,
        },
    ))
}

/// Convert a formula written with property names to storage form (`prop("#<id>")`).
pub fn to_storage(
    src: &str,
    name_to_id: &dyn Fn(&str) -> Option<String>,
) -> Result<String, ParseError> {
    rewrite_props(src, &|k: &str| {
        if k.starts_with('#') {
            None
        } else {
            name_to_id(k).map(|id| format!("#{id}"))
        }
    })
}

/// Convert a stored formula back to display form with current property names.
pub fn to_display(
    src: &str,
    id_to_name: &dyn Fn(&str) -> Option<String>,
) -> Result<String, ParseError> {
    rewrite_props(src, &|k: &str| k.strip_prefix('#').and_then(id_to_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dialect::value::DateVal;
    use chrono::NaiveDate;

    fn ctx() -> MapRowContext {
        let mut c = MapRowContext {
            now: crate::host::test_now(),
            ..Default::default()
        };
        c.props.insert("Price".into(), RowValue::Number(12.5));
        c.props.insert("Qty".into(), RowValue::Number(4.0));
        c.props
            .insert("Name".into(), RowValue::Text("Widget".into()));
        c.props.insert(
            "Tags".into(),
            RowValue::List(vec![RowValue::Text("a".into()), RowValue::Text("b".into())]),
        );
        c.props.insert(
            "Due".into(),
            RowValue::Date(DateVal::day(
                NaiveDate::from_ymd_opt(2026, 12, 1).unwrap_or_default(),
            )),
        );
        c.props.insert("Done".into(), RowValue::Bool(false));
        c.props.insert(
            "Rel".into(),
            RowValue::List(vec![RowValue::Row("r1".into()), RowValue::Row("r2".into())]),
        );
        for (id, amt) in [("r1", 10.0), ("r2", 32.0)] {
            let mut m = HashMap::new();
            m.insert("Amount".to_string(), RowValue::Number(amt));
            c.rows.insert(id.into(), m);
        }
        c.fx.insert(("USD".into(), "EUR".into()), (0.9, true));
        c
    }

    fn v(src: &str) -> RowValue {
        match eval_str(src, &ctx()) {
            Ok(r) => r.value,
            Err(e) => panic!("{src}: {e}"),
        }
    }

    #[test]
    fn basics() {
        assert_eq!(v("prop(\"Price\") * prop(\"Qty\")"), RowValue::Number(50.0));
        assert_eq!(v("prop(\"Price\") / 0"), RowValue::Empty);
        assert_eq!(
            v("prop(\"Name\") + \" x\" + 2"),
            RowValue::Text("Widget x2".into())
        );
        assert_eq!(v("prop(\"Tags\").length()"), RowValue::Number(2.0));
        assert_eq!(
            v("prop(\"Done\") ? \"yes\" : \"no\""),
            RowValue::Text("no".into())
        );
        assert_eq!(
            v("if(prop(\"Qty\") > 3, \"many\", \"few\")"),
            RowValue::Text("many".into())
        );
        assert_eq!(v("not prop(\"Done\") and true"), RowValue::Bool(true));
        assert_eq!(v("!prop(\"Done\") || false"), RowValue::Bool(true));
        assert_eq!(v("10 % 3"), RowValue::Number(1.0));
        assert_eq!(v("2 ^ 3 ^ 2"), RowValue::Number(512.0));
        assert_eq!(v("/* note */ 1 + 1"), RowValue::Number(2.0));
        assert_eq!(v("let(x, 3, x * x)"), RowValue::Number(9.0));
        assert_eq!(v("lets(a, 1, b, 2, a + b)"), RowValue::Number(3.0));
        assert_eq!(v("[1, 2, 3].sum()"), RowValue::Number(6.0));
        assert_eq!(
            v("prop(\"Rel\").map(current.prop(\"Amount\")).sum()"),
            RowValue::Number(42.0)
        );
        assert_eq!(
            v("[3, 1, 2].sort()"),
            RowValue::List(vec![
                RowValue::Number(1.0),
                RowValue::Number(2.0),
                RowValue::Number(3.0)
            ])
        );
        assert_eq!(
            v("[1, 2, 3, 4].filter(current > 2).length()"),
            RowValue::Number(2.0)
        );
        assert_eq!(
            v("[1, 2, 3].map(current * index)"),
            RowValue::List(vec![
                RowValue::Number(0.0),
                RowValue::Number(2.0),
                RowValue::Number(6.0)
            ])
        );
        assert_eq!(v("[1, 2, 2].unique().length()"), RowValue::Number(2.0));
        assert_eq!(v("[[1], [2, 3]].flat().length()"), RowValue::Number(3.0));
        assert_eq!(v("[5, 6].some(current > 5)"), RowValue::Bool(true));
        assert_eq!(v("[5, 6].every(current > 5)"), RowValue::Bool(false));
        assert_eq!(v("[5, 6].find(current > 5)"), RowValue::Number(6.0));
        assert_eq!(v("count([1, 2, 3], current >= 2)"), RowValue::Number(2.0));
        assert_eq!(v("at([1, 2, 3], -1)"), RowValue::Number(3.0));
        assert_eq!(
            v("slice([1, 2, 3, 4], 1, 3).length()"),
            RowValue::Number(2.0)
        );
        assert_eq!(v("includes(prop(\"Tags\"), \"b\")"), RowValue::Bool(true));
    }

    #[test]
    fn text_and_numbers() {
        assert_eq!(v("lower(\"ABC\")"), RowValue::Text("abc".into()));
        assert_eq!(
            v("\"a-b-c\".split(\"-\").join(\"+\")"),
            RowValue::Text("a+b+c".into())
        );
        assert_eq!(
            v("replaceAll(\"a1b2\", \"[0-9]\", \"#\")"),
            RowValue::Text("a#b#".into())
        );
        assert_eq!(
            v("replace(\"a1b2\", \"[0-9]\", \"#\")"),
            RowValue::Text("a#b2".into())
        );
        assert_eq!(v("test(\"hello\", \"^h\")"), RowValue::Bool(true));
        assert_eq!(v("substring(\"hello\", 1, 3)"), RowValue::Text("el".into()));
        assert_eq!(v("contains(\"hello\", \"ell\")"), RowValue::Bool(true));
        assert_eq!(v("trim(\"  x \")"), RowValue::Text("x".into()));
        assert_eq!(v("format(12.5)"), RowValue::Text("12.5".into()));
        assert_eq!(v("toNumber(\"42\")"), RowValue::Number(42.0));
        assert_eq!(v("round(2.675, 2)"), RowValue::Number(2.68));
        assert_eq!(v("median(1, 5, 2)"), RowValue::Number(2.0));
        assert_eq!(v("mean([1, 2, 3])"), RowValue::Number(2.0));
        assert_eq!(v("min(3, [1, 5])"), RowValue::Number(1.0));
        assert_eq!(v("max(3, [1, 5])"), RowValue::Number(5.0));
        assert_eq!(
            v("sqrt(16) + pow(2, 3) + mod(7, 3) + abs(-1) + ceil(1.2) + floor(1.8)"),
            RowValue::Number(4.0 + 8.0 + 1.0 + 1.0 + 2.0 + 1.0)
        );
        assert_eq!(
            v("equal(1, 1) and unequal(1, 2) and empty(\"\")"),
            RowValue::Bool(true)
        );
        assert_eq!(v("concat([1], [2]).length()"), RowValue::Number(2.0));
        assert!(eval_str("replace(\"x\", \"(\", \"y\")", &ctx()).is_err());
    }

    #[test]
    fn dates_and_finance() {
        assert_eq!(v("year(prop(\"Due\"))"), RowValue::Number(2026.0));
        assert_eq!(v("month(prop(\"Due\"))"), RowValue::Number(12.0));
        assert_eq!(v("date(prop(\"Due\"))"), RowValue::Number(1.0));
        assert_eq!(v("day(prop(\"Due\"))"), RowValue::Number(2.0)); // Tuesday
        assert_eq!(
            v("dateBetween(prop(\"Due\"), today(), \"days\")"),
            RowValue::Number(5.0)
        );
        assert_eq!(
            v("formatDate(dateAdd(prop(\"Due\"), 1, \"months\"), \"YYYY-MM-DD\")"),
            RowValue::Text("2027-01-01".into())
        );
        assert_eq!(
            v("formatDate(dateSubtract(prop(\"Due\"), 2, \"weeks\"), \"MMM D, YYYY\")"),
            RowValue::Text("Nov 17, 2026".into())
        );
        assert_eq!(
            v("formatDate(parseDate(\"2026-01-05T14:30\"), \"dddd h:mm A\")"),
            RowValue::Text("Monday 2:30 PM".into())
        );
        assert_eq!(
            v("formatDate(fromTimestamp(timestamp(prop(\"Due\"))), \"YYYY\")"),
            RowValue::Text("2026".into())
        );
        assert_eq!(v("week(prop(\"Due\"))"), RowValue::Number(49.0));
        let r = eval_str("round(pmt(0.05 / 12, 360, -300000), 2)", &ctx())
            .ok()
            .map(|r| r.value);
        assert_eq!(r, Some(RowValue::Number(1610.46)));
        let r = eval_str("fx(\"USD\", \"EUR\") * 10", &ctx()).ok();
        assert_eq!(
            r.as_ref().map(|r| r.value.clone()),
            Some(RowValue::Number(9.0))
        );
        assert_eq!(r.map(|r| r.stale), Some(true));
        assert!(compile("now()").map(|f| f.uses_now).unwrap_or(false));
    }

    #[test]
    fn typing_and_storage() {
        let props = |k: &str| -> Option<Ty> {
            match k {
                "Price" | "#p1" => Some(Ty::Number),
                "Name" => Some(Ty::Text),
                "Tags" => Some(Ty::List(Box::new(Ty::Text))),
                "Due" => Some(Ty::Date),
                _ => None,
            }
        };
        assert_eq!(
            check("prop(\"Price\") * 2", &props).r#type.as_deref(),
            Some("number")
        );
        assert_eq!(
            check("prop(\"Name\") + 1", &props).r#type.as_deref(),
            Some("text")
        );
        assert_eq!(
            check("prop(\"Tags\").length() > 1", &props)
                .r#type
                .as_deref(),
            Some("boolean")
        );
        assert_eq!(
            check("dateAdd(prop(\"Due\"), 1, \"days\")", &props)
                .r#type
                .as_deref(),
            Some("date")
        );
        assert_eq!(
            check("prop(\"Tags\").map(upper(current))", &props)
                .r#type
                .as_deref(),
            Some("list")
        );
        assert!(!check("prop(\"Nope\")", &props).ok);
        assert!(!check("prop(\"Name\") * 2", &props).ok);
        assert!(!check("nosuch(1)", &props).ok);
        assert!(!check("round()", &props).ok);
        let c = check("1 +", &props);
        assert_eq!(c.error.map(|e| e.from), Some(3));
        let stored = to_storage("prop(\"Price\") * 2", &|n: &str| {
            (n == "Price").then(|| "p1".to_string())
        })
        .unwrap_or_default();
        assert_eq!(stored, "prop(\"#p1\") * 2");
        let shown = to_display(&stored, &|id: &str| {
            (id == "p1").then(|| "Unit price".to_string())
        })
        .unwrap_or_default();
        assert_eq!(shown, "prop(\"Unit price\") * 2");
        assert_eq!(
            compile("prop(\"A\") + prop(\"B\") + prop(\"A\")")
                .map(|f| f.props)
                .unwrap_or_default(),
            vec!["A", "B"]
        );
    }
}
