//! `*IF(S)` criteria and wildcard matching (`*`, `?`, `~`) per Excel (SPEC §14.1).

use crate::value::{ErrorKind, Value, cmp_text_ci, coerce_number_with, parse_number_text};
use std::cmp::Ordering;

/// Comparison operator of a criterion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Operand of a criterion.
#[derive(Clone, Debug, PartialEq)]
enum Operand {
    Number(f64),
    Text(String),
    Bool(bool),
    Error(ErrorKind),
    Blank,
}

/// A compiled criterion such as `">=10"`, `"ap*"` or `TRUE`.
#[derive(Clone, Debug)]
pub struct Criterion {
    op: CmpOp,
    operand: Operand,
    wildcard: bool,
}

/// Does the pattern contain unescaped wildcards?
pub fn has_wildcards(p: &str) -> bool {
    let mut esc = false;
    for c in p.chars() {
        if esc {
            esc = false;
            continue;
        }
        match c {
            '~' => esc = true,
            '*' | '?' => return true,
            _ => {}
        }
    }
    false
}

/// Case-insensitive wildcard match of the whole text.
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    #[derive(Clone, Copy, PartialEq)]
    enum P {
        Lit(char),
        Any,
        Star,
    }
    let mut pat = Vec::new();
    let mut it = pattern.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '~' => match it.peek() {
                Some(&n) if n == '*' || n == '?' || n == '~' => {
                    pat.push(P::Lit(n));
                    it.next();
                }
                _ => pat.push(P::Lit('~')),
            },
            '*' => pat.push(P::Star),
            '?' => pat.push(P::Any),
            c => pat.push(P::Lit(c)),
        }
    }
    let lower = |c: char| c.to_lowercase().next().unwrap_or(c);
    let t: Vec<char> = text.chars().map(lower).collect();
    let pat: Vec<P> = pat
        .into_iter()
        .map(|p| match p {
            P::Lit(c) => P::Lit(lower(c)),
            o => o,
        })
        .collect();
    // Iterative matcher with single backtrack point (classic glob algorithm).
    let (mut ti, mut pi) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < pat.len() {
            match pat[pi] {
                P::Lit(c) if c == t[ti] => {
                    ti += 1;
                    pi += 1;
                    continue;
                }
                P::Any => {
                    ti += 1;
                    pi += 1;
                    continue;
                }
                P::Star => {
                    star = Some((pi, ti));
                    pi += 1;
                    continue;
                }
                _ => {}
            }
        }
        match star {
            Some((sp, st)) => {
                pi = sp + 1;
                ti = st + 1;
                star = Some((sp, st + 1));
            }
            None => return false,
        }
    }
    while pi < pat.len() && pat[pi] == P::Star {
        pi += 1;
    }
    pi == pat.len()
}

fn unescape(p: &str) -> String {
    let mut out = String::new();
    let mut it = p.chars().peekable();
    while let Some(c) = it.next() {
        if c == '~'
            && let Some(&n) = it.peek()
            && matches!(n, '*' | '?' | '~')
        {
            out.push(n);
            it.next();
            continue;
        }
        out.push(c);
    }
    out
}

impl Criterion {
    /// Compile a criterion value.
    pub fn new(crit: &Value, date1904: bool) -> Criterion {
        match crit {
            Value::Number(n) => Criterion {
                op: CmpOp::Eq,
                operand: Operand::Number(*n),
                wildcard: false,
            },
            Value::Bool(b) => Criterion {
                op: CmpOp::Eq,
                operand: Operand::Bool(*b),
                wildcard: false,
            },
            Value::Error(e) => Criterion {
                op: CmpOp::Eq,
                operand: Operand::Error(*e),
                wildcard: false,
            },
            Value::Empty => Criterion {
                op: CmpOp::Eq,
                operand: Operand::Number(0.0),
                wildcard: false,
            },
            Value::Array(a) => Criterion::new(a.get(0, 0), date1904),
            Value::Text(s) => {
                let s: &str = s;
                let (op, rest) = if let Some(r) = s.strip_prefix(">=") {
                    (CmpOp::Ge, r)
                } else if let Some(r) = s.strip_prefix("<=") {
                    (CmpOp::Le, r)
                } else if let Some(r) = s.strip_prefix("<>") {
                    (CmpOp::Ne, r)
                } else if let Some(r) = s.strip_prefix('>') {
                    (CmpOp::Gt, r)
                } else if let Some(r) = s.strip_prefix('<') {
                    (CmpOp::Lt, r)
                } else if let Some(r) = s.strip_prefix('=') {
                    (CmpOp::Eq, r)
                } else {
                    (CmpOp::Eq, s)
                };
                let explicit_op = rest.len() != s.len();
                if rest.is_empty() {
                    // "" matches blanks; "=" matches blanks; "<>" matches non-blanks.
                    return Criterion {
                        op,
                        operand: Operand::Blank,
                        wildcard: false,
                    };
                }
                if let Some(n) = parse_number_text(rest).or_else(|| {
                    crate::datetime::parse_datetime_text(rest, date1904).filter(|_| rest.len() >= 6)
                }) {
                    return Criterion {
                        op,
                        operand: Operand::Number(n),
                        wildcard: false,
                    };
                }
                let up = rest.to_ascii_uppercase();
                if up == "TRUE" || up == "FALSE" {
                    return Criterion {
                        op,
                        operand: Operand::Bool(up == "TRUE"),
                        wildcard: false,
                    };
                }
                if let Some(e) = ErrorKind::parse(rest) {
                    return Criterion {
                        op,
                        operand: Operand::Error(e),
                        wildcard: false,
                    };
                }
                let _ = explicit_op;
                let wildcard = matches!(op, CmpOp::Eq | CmpOp::Ne) && has_wildcards(rest);
                let text = if wildcard {
                    rest.to_string()
                } else {
                    unescape(rest)
                };
                Criterion {
                    op,
                    operand: Operand::Text(text),
                    wildcard,
                }
            }
        }
    }

    /// Does a cell value satisfy the criterion?
    pub fn matches(&self, v: &Value) -> bool {
        let res = match (&self.operand, v) {
            (Operand::Blank, _) => {
                let blank =
                    matches!(v, Value::Empty) || matches!(v, Value::Text(s) if s.is_empty());
                return match self.op {
                    CmpOp::Eq => blank,
                    CmpOp::Ne => !matches!(v, Value::Empty),
                    _ => false,
                };
            }
            (Operand::Number(n), Value::Number(x)) => {
                Some(x.partial_cmp(n).unwrap_or(Ordering::Equal))
            }
            (Operand::Number(n), Value::Text(t))
                if self.op == CmpOp::Eq || self.op == CmpOp::Ne =>
            {
                parse_number_text(t).map(|x| x.partial_cmp(n).unwrap_or(Ordering::Equal))
            }
            (Operand::Text(p), Value::Text(t)) => {
                if self.wildcard {
                    Some(if wildcard_match(p, t) {
                        Ordering::Equal
                    } else {
                        Ordering::Less
                    })
                } else {
                    Some(cmp_text_ci(t, p))
                }
            }
            (Operand::Text(p), Value::Empty) if self.wildcard => Some(if wildcard_match(p, "") {
                Ordering::Equal
            } else {
                Ordering::Less
            }),
            (Operand::Bool(b), Value::Bool(x)) => Some(x.cmp(b)),
            (Operand::Error(e), Value::Error(x)) => Some(if e == x {
                Ordering::Equal
            } else {
                Ordering::Less
            }),
            _ => None,
        };
        match res {
            Some(o) => match self.op {
                CmpOp::Eq => o == Ordering::Equal,
                CmpOp::Ne => o != Ordering::Equal,
                CmpOp::Lt => o == Ordering::Less,
                CmpOp::Le => o != Ordering::Greater,
                CmpOp::Gt => o == Ordering::Greater,
                CmpOp::Ge => o != Ordering::Less,
            },
            // Type mismatch: only "<>" matches.
            None => self.op == CmpOp::Ne,
        }
    }
}

/// Coerce a criterion argument used as a number (date text allowed).
pub fn criterion_number(v: &Value, date1904: bool) -> Option<f64> {
    coerce_number_with(v, date1904).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(c: &str, v: Value) -> bool {
        Criterion::new(&Value::text(c), false).matches(&v)
    }

    #[test]
    fn wildcards() {
        assert!(wildcard_match("ap*", "Apple"));
        assert!(wildcard_match("*le", "apple"));
        assert!(wildcard_match("a?ple", "apple"));
        assert!(!wildcard_match("a?ple", "aple"));
        assert!(wildcard_match("*", ""));
        assert!(wildcard_match("a~*b", "a*b"));
        assert!(!wildcard_match("a~*b", "axb"));
        assert!(wildcard_match("*a*b*c*", "xxaxxbxxcxx"));
        assert!(!wildcard_match("*a*b*c", "xxaxxbxxcxx"));
    }

    #[test]
    fn criteria() {
        assert!(m(">=10", Value::Number(10.0)));
        assert!(!m(">10", Value::Number(10.0)));
        assert!(m("<>5", Value::Number(4.0)));
        assert!(m("<>5", Value::text("x")));
        assert!(m("apple", Value::text("APPLE")));
        assert!(m("a*", Value::text("abc")));
        assert!(!m("a*", Value::Number(1.0)));
        assert!(m("", Value::Empty));
        assert!(m("", Value::text("")));
        assert!(!m("", Value::Number(0.0)));
        assert!(m("<>", Value::Number(0.0)));
        assert!(!m("<>", Value::Empty));
        assert!(m("=", Value::Empty));
        assert!(m("TRUE", Value::Bool(true)));
        assert!(m("#N/A", Value::Error(ErrorKind::NA)));
        assert!(m("<b", Value::text("a")));
        assert!(Criterion::new(&Value::Number(1.0), false).matches(&Value::text("1")));
        assert!(m(">2024-01-01", Value::Number(45300.0)));
    }
}
