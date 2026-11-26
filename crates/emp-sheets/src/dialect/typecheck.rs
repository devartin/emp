//! Static typing for Row-dialect formulas (`db_formula_check`).

use crate::ast::{BinaryOp, Expr, UnaryOp};
use serde::{Deserialize, Serialize};

/// A static type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ty {
    /// Number.
    Number,
    /// Text.
    Text,
    /// Boolean.
    Bool,
    /// Date.
    Date,
    /// List of a type.
    List(Box<Ty>),
    /// A related row.
    Row,
    /// Empty.
    Empty,
    /// Unknown / mixed.
    Any,
}

impl Ty {
    /// Name used by `db_formula_check` (`number`, `text`, `boolean`, `date`, `list`, `row`, `any`).
    pub fn name(&self) -> &'static str {
        match self {
            Ty::Number => "number",
            Ty::Text => "text",
            Ty::Bool => "boolean",
            Ty::Date => "date",
            Ty::List(_) => "list",
            Ty::Row => "row",
            Ty::Empty => "empty",
            Ty::Any => "any",
        }
    }
    fn numeric(&self) -> bool {
        matches!(self, Ty::Number | Ty::Bool | Ty::Empty | Ty::Any)
    }
    fn elem(&self) -> Ty {
        match self {
            Ty::List(t) => (**t).clone(),
            Ty::Any => Ty::Any,
            other => other.clone(),
        }
    }
}

fn unify(a: Ty, b: Ty) -> Ty {
    if a == b {
        a
    } else if a == Ty::Empty {
        b
    } else if b == Ty::Empty {
        a
    } else {
        Ty::Any
    }
}

/// Type environment: property types and bound variables.
pub struct TypeEnv<'a> {
    props: &'a dyn Fn(&str) -> Option<Ty>,
    vars: Vec<(String, Ty)>,
}

fn e<T>(m: impl Into<String>) -> Result<T, String> {
    Err(m.into())
}

const SIGS: &[(&str, usize, usize)] = &[
    ("if", 3, 3),
    ("ifs", 2, 255),
    ("empty", 1, 1),
    ("and", 1, 255),
    ("or", 1, 255),
    ("not", 1, 1),
    ("equal", 2, 2),
    ("unequal", 2, 2),
    ("let", 3, 3),
    ("lets", 3, 255),
    ("prop", 1, 2),
    ("length", 1, 1),
    ("contains", 2, 2),
    ("lower", 1, 1),
    ("upper", 1, 1),
    ("format", 1, 1),
    ("concat", 1, 255),
    ("join", 1, 2),
    ("replace", 3, 3),
    ("replaceall", 3, 3),
    ("substring", 2, 3),
    ("test", 2, 2),
    ("split", 1, 2),
    ("trim", 1, 1),
    ("min", 1, 255),
    ("max", 1, 255),
    ("sum", 1, 255),
    ("mean", 1, 255),
    ("median", 1, 255),
    ("abs", 1, 1),
    ("round", 1, 2),
    ("ceil", 1, 1),
    ("floor", 1, 1),
    ("sqrt", 1, 1),
    ("pow", 2, 2),
    ("mod", 2, 2),
    ("tonumber", 1, 1),
    ("now", 0, 0),
    ("today", 0, 0),
    ("year", 1, 1),
    ("month", 1, 1),
    ("day", 1, 1),
    ("date", 1, 1),
    ("week", 1, 1),
    ("hour", 1, 1),
    ("minute", 1, 1),
    ("dateadd", 3, 3),
    ("datesubtract", 3, 3),
    ("datebetween", 3, 3),
    ("datestart", 1, 1),
    ("dateend", 1, 1),
    ("formatdate", 2, 2),
    ("parsedate", 1, 1),
    ("timestamp", 1, 1),
    ("fromtimestamp", 1, 1),
    ("at", 2, 2),
    ("first", 1, 1),
    ("last", 1, 1),
    ("slice", 2, 3),
    ("sort", 1, 2),
    ("reverse", 1, 1),
    ("unique", 1, 1),
    ("includes", 2, 2),
    ("filter", 2, 2),
    ("map", 2, 2),
    ("find", 2, 2),
    ("findindex", 2, 2),
    ("some", 2, 2),
    ("every", 2, 2),
    ("count", 1, 2),
    ("flat", 1, 1),
    ("pmt", 3, 5),
    ("fv", 3, 5),
    ("pv", 3, 5),
    ("npv", 2, 255),
    ("irr", 1, 2),
    ("fx", 2, 2),
];

/// Names of all Row-dialect functions.
pub fn row_function_names() -> Vec<&'static str> {
    SIGS.iter().map(|s| s.0).collect()
}

impl<'a> TypeEnv<'a> {
    /// New environment with a property-type lookup (by name or `#id`).
    pub fn new(props: &'a dyn Fn(&str) -> Option<Ty>) -> Self {
        TypeEnv {
            props,
            vars: Vec::new(),
        }
    }

    /// Infer the type of an expression.
    pub fn infer(&mut self, x: &Expr) -> Result<Ty, String> {
        match x {
            Expr::Number(_) => Ok(Ty::Number),
            Expr::Text(_) => Ok(Ty::Text),
            Expr::Bool(_) => Ok(Ty::Bool),
            Expr::Missing => Ok(Ty::Empty),
            Expr::Paren(i) => self.infer(i),
            Expr::List(items) => {
                let mut t = Ty::Empty;
                for i in items {
                    let it = self.infer(i)?;
                    t = unify(t, it);
                }
                Ok(Ty::List(Box::new(t)))
            }
            Expr::Name(n) => match self.vars.iter().rev().find(|(k, _)| k == n) {
                Some((_, t)) => Ok(t.clone()),
                None => e(format!("Unknown name: {n}")),
            },
            Expr::Path(p) => {
                let mut t = self.infer(&Expr::Name(p[0].clone()))?;
                for part in &p[1..] {
                    t = self.call_ty(part, vec![t], &[])?;
                }
                Ok(t)
            }
            Expr::Unary(op, i) => {
                let t = self.infer(i)?;
                match op {
                    UnaryOp::Not => Ok(Ty::Bool),
                    _ if t.numeric() => Ok(Ty::Number),
                    _ => e(format!("Cannot negate {}", t.name())),
                }
            }
            Expr::Ternary(c, a, b) => {
                self.infer(c)?;
                let (ta, tb) = (self.infer(a)?, self.infer(b)?);
                Ok(unify(ta, tb))
            }
            Expr::Binary(op, a, b) => {
                let (ta, tb) = (self.infer(a)?, self.infer(b)?);
                match op {
                    BinaryOp::Eq
                    | BinaryOp::Ne
                    | BinaryOp::Lt
                    | BinaryOp::Le
                    | BinaryOp::Gt
                    | BinaryOp::Ge
                    | BinaryOp::And
                    | BinaryOp::Or => Ok(Ty::Bool),
                    BinaryOp::Add | BinaryOp::Concat => {
                        if ta == Ty::Text || tb == Ty::Text {
                            Ok(Ty::Text)
                        } else if matches!(ta, Ty::List(_)) && matches!(tb, Ty::List(_)) {
                            Ok(unify(ta, tb))
                        } else if ta.numeric() && tb.numeric() {
                            Ok(if ta == Ty::Any || tb == Ty::Any {
                                Ty::Any
                            } else {
                                Ty::Number
                            })
                        } else {
                            e(format!("Cannot add {} and {}", ta.name(), tb.name()))
                        }
                    }
                    _ => {
                        if ta.numeric() && tb.numeric() {
                            Ok(Ty::Number)
                        } else {
                            e(format!(
                                "Arithmetic needs numbers, got {} and {}",
                                ta.name(),
                                tb.name()
                            ))
                        }
                    }
                }
            }
            Expr::Call { name, args } => {
                let lname = name.to_ascii_lowercase();
                self.call_expr(&lname, args)
            }
            Expr::Method { recv, name, args } => {
                let mut all = vec![(**recv).clone()];
                all.extend(args.iter().cloned());
                self.call_expr(&name.to_ascii_lowercase(), &all)
            }
            _ => e("Not supported in database formulas"),
        }
    }

    fn call_expr(&mut self, name: &str, args: &[Expr]) -> Result<Ty, String> {
        let Some(&(_, min, max)) = SIGS.iter().find(|s| s.0 == name) else {
            return e(format!("Unknown function: {name}"));
        };
        if args.len() < min || args.len() > max {
            return e(format!(
                "{name}() takes {} argument{}",
                if min == max {
                    min.to_string()
                } else {
                    format!("{min} to {max}")
                },
                if max == 1 { "" } else { "s" }
            ));
        }
        match name {
            "let" => {
                let Expr::Name(v) = &args[0] else {
                    return e("let() needs a variable name");
                };
                let t = self.infer(&args[1])?;
                self.vars.push((v.clone(), t));
                let r = self.infer(&args[2]);
                self.vars.pop();
                return r;
            }
            "lets" => {
                if args.len().is_multiple_of(2) {
                    return e("lets() takes name, value pairs and an expression");
                }
                let base = self.vars.len();
                let mut i = 0;
                while i + 1 < args.len() {
                    let Expr::Name(v) = &args[i] else {
                        self.vars.truncate(base);
                        return e("lets() needs variable names");
                    };
                    let t = self.infer(&args[i + 1]);
                    match t {
                        Ok(t) => self.vars.push((v.clone(), t)),
                        Err(m) => {
                            self.vars.truncate(base);
                            return Err(m);
                        }
                    }
                    i += 2;
                }
                let r = self.infer(&args[args.len() - 1]);
                self.vars.truncate(base);
                return r;
            }
            "prop" if args.len() == 1 => {
                return match &args[0] {
                    Expr::Text(k) => {
                        (self.props)(k).ok_or_else(|| format!("Unknown property: {k}"))
                    }
                    _ => Ok(Ty::Any),
                };
            }
            "filter" | "map" | "find" | "findindex" | "some" | "every" | "count" | "sort"
                if args.len() == 2 =>
            {
                let lt = self.infer(&args[0])?;
                self.vars.push(("current".into(), lt.elem()));
                self.vars.push(("index".into(), Ty::Number));
                let cb = self.infer(&args[1]);
                self.vars.pop();
                self.vars.pop();
                let cb = cb?;
                return Ok(match name {
                    "map" => Ty::List(Box::new(cb)),
                    "filter" | "sort" => lt,
                    "find" => lt.elem(),
                    "some" | "every" => Ty::Bool,
                    _ => Ty::Number,
                });
            }
            _ => {}
        }
        let mut tys = Vec::with_capacity(args.len());
        for a in args {
            tys.push(self.infer(a)?);
        }
        self.call_ty(name, tys, args)
    }

    fn call_ty(&mut self, name: &str, tys: Vec<Ty>, _args: &[Expr]) -> Result<Ty, String> {
        let first = tys.first().cloned().unwrap_or(Ty::Any);
        Ok(match name {
            "if" => unify(tys[1].clone(), tys[2].clone()),
            "ifs" => {
                let mut t = Ty::Empty;
                let mut i = 1;
                while i < tys.len() {
                    t = unify(t, tys[i].clone());
                    i += 2;
                }
                if tys.len() % 2 == 1 {
                    t = unify(t, tys[tys.len() - 1].clone());
                }
                t
            }
            "empty" | "and" | "or" | "not" | "equal" | "unequal" | "contains" | "test"
            | "includes" | "some" | "every" => Ty::Bool,
            "length" | "abs" | "round" | "ceil" | "floor" | "sqrt" | "pow" | "mod" | "tonumber"
            | "year" | "month" | "day" | "date" | "week" | "hour" | "minute" | "datebetween"
            | "timestamp" | "count" | "findindex" | "pmt" | "fv" | "pv" | "npv" | "irr" | "fx"
            | "min" | "max" | "sum" | "mean" | "median" => {
                if matches!(
                    name,
                    "abs" | "round" | "ceil" | "floor" | "sqrt" | "pow" | "mod"
                ) && !tys.iter().all(|t| t.numeric())
                {
                    return e(format!("{name}() needs numbers"));
                }
                if matches!(
                    name,
                    "year" | "month" | "day" | "date" | "week" | "hour" | "minute" | "timestamp"
                ) && !matches!(first, Ty::Date | Ty::Any | Ty::Empty | Ty::Text)
                {
                    return e(format!("{name}() needs a date"));
                }
                Ty::Number
            }
            "lower" | "upper" | "format" | "join" | "replace" | "replaceall" | "substring"
            | "trim" | "formatdate" => Ty::Text,
            "concat" => {
                if tys.iter().all(|t| matches!(t, Ty::List(_))) {
                    Ty::List(Box::new(Ty::Any))
                } else {
                    Ty::Text
                }
            }
            "split" => Ty::List(Box::new(Ty::Text)),
            "now" | "today" | "dateadd" | "datesubtract" | "datestart" | "dateend"
            | "parsedate" | "fromtimestamp" => Ty::Date,
            "at" | "first" | "last" => first.elem(),
            "slice" | "sort" | "reverse" | "unique" | "filter" => first,
            "flat" => Ty::List(Box::new(Ty::Any)),
            "prop" => Ty::Any,
            _ => Ty::Any,
        })
    }
}
