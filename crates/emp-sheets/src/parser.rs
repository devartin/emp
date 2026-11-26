//! Pratt parser for every formula dialect (SPEC §14.1, §14.6, §14.7).
//!
//! Excel precedence, lowest to highest: comparison, `&`, `+ -`, `* /`, `^`, postfix `%`, unary `±`
//! (so `-2^2 = 4`), then the reference operators `:`, space (intersection) and `,` (union, inside
//! parentheses only).

use crate::ast::{BinaryOp, Expr, PostfixOp, UnaryOp};
use crate::lexer::{Op, Tok, Token, tokenize};
use crate::limits::{MAX_ARGS, MAX_FORMULA_LEN, MAX_PARSE_DEPTH, REJECTED_FUNCTIONS};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Formula dialect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Dialect {
    /// Spreadsheet formulas.
    #[default]
    Excel,
    /// Database property formulas (§14.6).
    Row,
    /// Life-app metric and advisor expressions (§14.7).
    Metric,
}

/// A parse error with the byte span it refers to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseError {
    /// Message for the user.
    pub message: String,
    /// Start byte (inclusive).
    pub start: usize,
    /// End byte (exclusive).
    pub end: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (at {}..{})", self.message, self.start, self.end)
    }
}

impl std::error::Error for ParseError {}

/// Parse a formula. A leading `=` is accepted (and skipped) in the Excel dialect; spans refer to `src`.
pub fn parse(src: &str, dialect: Dialect) -> Result<Expr, ParseError> {
    match std::panic::catch_unwind(|| parse_inner(src, dialect)) {
        Ok(r) => r,
        Err(_) => Err(ParseError {
            message: "Internal parser error".into(),
            start: 0,
            end: src.len(),
        }),
    }
}

fn parse_inner(src: &str, dialect: Dialect) -> Result<Expr, ParseError> {
    if src.chars().count() > MAX_FORMULA_LEN {
        return Err(ParseError {
            message: format!("Formula is longer than {MAX_FORMULA_LEN} characters"),
            start: 0,
            end: src.len(),
        });
    }
    let offset = if dialect == Dialect::Excel && src.starts_with('=') {
        1
    } else {
        0
    };
    let mut toks = tokenize(&src[offset..], dialect).map_err(|mut e| {
        e.start += offset;
        e.end += offset;
        e
    })?;
    for t in toks.iter_mut() {
        t.start += offset;
        t.end += offset;
    }
    let mut p = Parser {
        toks,
        pos: 0,
        dialect,
        depth: 0,
        src_len: src.len(),
    };
    p.skip_ws();
    if p.at_eof() {
        return Err(ParseError {
            message: "Empty formula".into(),
            start: offset,
            end: src.len(),
        });
    }
    let e = p.expr(0, false)?;
    p.skip_ws();
    if !p.at_eof() {
        let t = p.cur();
        return Err(ParseError {
            message: "Unexpected token".into(),
            start: t.start,
            end: t.end,
        });
    }
    Ok(e)
}

struct Parser {
    toks: Vec<Token>,
    pos: usize,
    dialect: Dialect,
    depth: usize,
    src_len: usize,
}

impl Parser {
    fn cur(&self) -> &Token {
        &self.toks[self.pos.min(self.toks.len() - 1)]
    }
    fn at_eof(&self) -> bool {
        self.cur().tok == Tok::Eof
    }
    fn skip_ws(&mut self) {
        while self.cur().tok == Tok::Ws {
            self.pos += 1;
        }
    }
    fn bump(&mut self) -> Token {
        let t = self.cur().clone();
        if self.pos < self.toks.len() - 1 {
            self.pos += 1;
        }
        t
    }
    fn err_here(&self, msg: &str) -> ParseError {
        let t = self.cur();
        let (s, e) = if t.tok == Tok::Eof {
            (self.src_len, self.src_len)
        } else {
            (t.start, t.end)
        };
        ParseError {
            message: msg.into(),
            start: s,
            end: e,
        }
    }
    fn expect(&mut self, op: Op, msg: &str) -> Result<(), ParseError> {
        self.skip_ws();
        if self.cur().tok == Tok::Op(op) {
            self.bump();
            Ok(())
        } else {
            Err(self.err_here(msg))
        }
    }
    fn is_op(&self, op: Op) -> bool {
        self.cur().tok == Tok::Op(op)
    }

    fn expr(&mut self, min_bp: u8, allow_union: bool) -> Result<Expr, ParseError> {
        self.depth += 1;
        if self.depth > MAX_PARSE_DEPTH {
            return Err(self.err_here("Formula is nested too deeply"));
        }
        let r = match self.dialect {
            Dialect::Excel => self.excel_expr(min_bp, allow_union),
            _ => self.row_expr(min_bp),
        };
        self.depth -= 1;
        r
    }

    // ---------------------------------------------------------------- Excel dialect

    fn excel_expr(&mut self, min_bp: u8, allow_union: bool) -> Result<Expr, ParseError> {
        self.skip_ws();
        let mut lhs = self.excel_prefix(allow_union)?;
        loop {
            // Intersection: whitespace between two reference-like operands.
            if self.cur().tok == Tok::Ws {
                let save = self.pos;
                self.skip_ws();
                let starts_operand = matches!(
                    self.cur().tok,
                    Tok::Ref(_) | Tok::Ident(_) | Tok::Func(_) | Tok::Op(Op::LParen)
                );
                if starts_operand && is_ref_like(&lhs) {
                    let (l, r) = (85, 86);
                    if l < min_bp {
                        self.pos = save;
                        break;
                    }
                    let rhs = self.expr(r, allow_union)?;
                    lhs = Expr::Binary(BinaryOp::Intersect, Box::new(lhs), Box::new(rhs));
                    continue;
                }
                if !starts_operand {
                    // plain whitespace before an operator
                } else {
                    return Err(self.err_here("Missing operator"));
                }
            }
            let tok = self.cur().tok.clone();
            let Tok::Op(op) = tok else {
                if matches!(tok, Tok::Eof) {
                    break;
                }
                return Err(self.err_here("Missing operator"));
            };
            // postfix
            match op {
                Op::Percent => {
                    if 60 < min_bp {
                        break;
                    }
                    self.bump();
                    lhs = Expr::Postfix(PostfixOp::Percent, Box::new(lhs));
                    continue;
                }
                Op::Hash => {
                    if 95 < min_bp {
                        break;
                    }
                    self.bump();
                    lhs = Expr::Postfix(PostfixOp::Spill, Box::new(lhs));
                    continue;
                }
                _ => {}
            }
            let (bop, l, r) = match op {
                Op::Eq => (BinaryOp::Eq, 10, 11),
                Op::Ne => (BinaryOp::Ne, 10, 11),
                Op::Lt => (BinaryOp::Lt, 10, 11),
                Op::Le => (BinaryOp::Le, 10, 11),
                Op::Gt => (BinaryOp::Gt, 10, 11),
                Op::Ge => (BinaryOp::Ge, 10, 11),
                Op::Amp => (BinaryOp::Concat, 20, 21),
                Op::Plus => (BinaryOp::Add, 30, 31),
                Op::Minus => (BinaryOp::Sub, 30, 31),
                Op::Star => (BinaryOp::Mul, 40, 41),
                Op::Slash => (BinaryOp::Div, 40, 41),
                Op::Caret => (BinaryOp::Pow, 50, 51),
                Op::Comma if allow_union => (BinaryOp::Union, 80, 81),
                Op::Colon => (BinaryOp::Range, 90, 91),
                _ => break,
            };
            if l < min_bp {
                break;
            }
            self.bump();
            let rhs = self.expr(r, allow_union)?;
            lhs = Expr::Binary(bop, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn excel_prefix(&mut self, _allow_union: bool) -> Result<Expr, ParseError> {
        self.skip_ws();
        let t = self.bump();
        match t.tok {
            Tok::Num(x) => Ok(Expr::Number(x)),
            Tok::Str(s) => Ok(Expr::Text(s)),
            Tok::Bool(b) => Ok(Expr::Bool(b)),
            Tok::Err(e) => Ok(Expr::Error(e)),
            Tok::Ref(r) => Ok(Expr::Ref(r)),
            Tok::Ident(n) => Ok(Expr::Name(n)),
            Tok::Func(name) => self.call(name, t.start, t.end),
            Tok::Op(Op::LParen) => {
                let inner = self.expr(0, true)?;
                self.expect(Op::RParen, "Missing closing parenthesis")?;
                Ok(Expr::Paren(Box::new(inner)))
            }
            Tok::Op(Op::LBrace) => self.array_literal(),
            Tok::Op(Op::Minus) => Ok(Expr::Unary(UnaryOp::Neg, Box::new(self.expr(70, false)?))),
            Tok::Op(Op::Plus) => Ok(Expr::Unary(UnaryOp::Plus, Box::new(self.expr(70, false)?))),
            Tok::Op(Op::At) => Ok(Expr::Unary(UnaryOp::At, Box::new(self.expr(70, false)?))),
            Tok::Eof => Err(ParseError {
                message: "Unexpected end of formula".into(),
                start: self.src_len,
                end: self.src_len,
            }),
            _ => Err(ParseError {
                message: "Unexpected token".into(),
                start: t.start,
                end: t.end,
            }),
        }
    }

    fn call(&mut self, name: String, start: usize, end: usize) -> Result<Expr, ParseError> {
        if self.dialect == Dialect::Excel && REJECTED_FUNCTIONS.contains(&name.as_str()) {
            return Err(ParseError {
                message: format!("{name} is not allowed"),
                start,
                end,
            });
        }
        self.expect(Op::LParen, "Expected (")?;
        let mut args = Vec::new();
        self.skip_ws();
        if self.is_op(Op::RParen) {
            self.bump();
            return Ok(Expr::Call { name, args });
        }
        loop {
            self.skip_ws();
            if self.is_op(Op::Comma) || self.is_op(Op::RParen) {
                args.push(Expr::Missing);
            } else {
                args.push(self.expr(0, false)?);
            }
            if args.len() > MAX_ARGS {
                return Err(ParseError {
                    message: format!("More than {MAX_ARGS} arguments"),
                    start,
                    end,
                });
            }
            self.skip_ws();
            if self.is_op(Op::Comma) {
                self.bump();
                continue;
            }
            if self.is_op(Op::RParen) {
                self.bump();
                break;
            }
            return Err(self.err_here("Expected , or )"));
        }
        Ok(Expr::Call { name, args })
    }

    fn array_literal(&mut self) -> Result<Expr, ParseError> {
        let mut rows = vec![Vec::new()];
        loop {
            self.skip_ws();
            let neg = if self.is_op(Op::Minus) {
                self.bump();
                true
            } else {
                if self.is_op(Op::Plus) {
                    self.bump();
                }
                false
            };
            self.skip_ws();
            let t = self.bump();
            let item = match t.tok {
                Tok::Num(x) => {
                    if neg {
                        Expr::Unary(UnaryOp::Neg, Box::new(Expr::Number(x)))
                    } else {
                        Expr::Number(x)
                    }
                }
                Tok::Str(s) if !neg => Expr::Text(s),
                Tok::Bool(b) if !neg => Expr::Bool(b),
                Tok::Err(e) if !neg => Expr::Error(e),
                _ => {
                    return Err(ParseError {
                        message: "Array constants may only contain literals".into(),
                        start: t.start,
                        end: t.end,
                    });
                }
            };
            if let Some(last) = rows.last_mut() {
                last.push(item);
            }
            self.skip_ws();
            let t = self.bump();
            match t.tok {
                Tok::Op(Op::Comma) => {}
                Tok::Op(Op::Semi) => rows.push(Vec::new()),
                Tok::Op(Op::RBrace) => break,
                _ => {
                    return Err(ParseError {
                        message: "Expected , ; or }".into(),
                        start: t.start,
                        end: t.end,
                    });
                }
            }
        }
        let w = rows[0].len();
        if rows.iter().any(|r| r.len() != w) {
            return Err(self.err_here("Array rows must have the same length"));
        }
        Ok(Expr::Array(rows))
    }

    // ---------------------------------------------------------------- Row / Metric dialects

    fn row_expr(&mut self, min_bp: u8) -> Result<Expr, ParseError> {
        let mut lhs = self.row_prefix()?;
        loop {
            let tok = self.cur().tok.clone();
            let op = match tok {
                Tok::Op(op) => op,
                Tok::Ident(ref w) if w == "and" || w == "or" => {
                    if w == "and" {
                        Op::AndAnd
                    } else {
                        Op::OrOr
                    }
                }
                Tok::Eof => break,
                _ => return Err(self.err_here("Missing operator")),
            };
            match op {
                Op::Dot => {
                    if 20 < min_bp {
                        break;
                    }
                    self.bump();
                    let t = self.bump();
                    lhs = match t.tok {
                        Tok::Func(name) => {
                            let args = self.row_args()?;
                            Expr::Method {
                                recv: Box::new(lhs),
                                name,
                                args,
                            }
                        }
                        Tok::Ident(name) => match lhs {
                            Expr::Name(a) => Expr::Path(vec![a, name]),
                            Expr::Path(mut v) => {
                                v.push(name);
                                Expr::Path(v)
                            }
                            other => Expr::Method {
                                recv: Box::new(other),
                                name,
                                args: vec![],
                            },
                        },
                        _ => {
                            return Err(ParseError {
                                message: "Expected a name after .".into(),
                                start: t.start,
                                end: t.end,
                            });
                        }
                    };
                    continue;
                }
                Op::Question => {
                    if 2 < min_bp {
                        break;
                    }
                    self.bump();
                    let a = self.expr(0, false)?;
                    self.expect(Op::Colon, "Expected : in conditional")?;
                    let b = self.expr(2, false)?;
                    lhs = Expr::Ternary(Box::new(lhs), Box::new(a), Box::new(b));
                    continue;
                }
                _ => {}
            }
            let (bop, l, r) = match op {
                Op::OrOr => (BinaryOp::Or, 4, 5),
                Op::AndAnd => (BinaryOp::And, 6, 7),
                Op::EqEq | Op::Eq => (BinaryOp::Eq, 8, 9),
                Op::Ne => (BinaryOp::Ne, 8, 9),
                Op::Lt => (BinaryOp::Lt, 9, 10),
                Op::Le => (BinaryOp::Le, 9, 10),
                Op::Gt => (BinaryOp::Gt, 9, 10),
                Op::Ge => (BinaryOp::Ge, 9, 10),
                Op::Plus => (BinaryOp::Add, 10, 11),
                Op::Minus => (BinaryOp::Sub, 10, 11),
                Op::Star => (BinaryOp::Mul, 12, 13),
                Op::Slash => (BinaryOp::Div, 12, 13),
                Op::Percent => (BinaryOp::Mod, 12, 13),
                Op::Caret => (BinaryOp::Pow, 15, 14),
                _ => break,
            };
            if l < min_bp {
                break;
            }
            self.bump();
            let rhs = self.expr(r, false)?;
            lhs = Expr::Binary(bop, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn row_args(&mut self) -> Result<Vec<Expr>, ParseError> {
        self.expect(Op::LParen, "Expected (")?;
        let mut args = Vec::new();
        if self.is_op(Op::RParen) {
            self.bump();
            return Ok(args);
        }
        loop {
            args.push(self.expr(0, false)?);
            if args.len() > MAX_ARGS {
                return Err(self.err_here("Too many arguments"));
            }
            if self.is_op(Op::Comma) {
                self.bump();
                continue;
            }
            self.expect(Op::RParen, "Expected , or )")?;
            break;
        }
        Ok(args)
    }

    fn row_prefix(&mut self) -> Result<Expr, ParseError> {
        let t = self.bump();
        match t.tok {
            Tok::Num(x) => Ok(Expr::Number(x)),
            Tok::Str(s) => Ok(Expr::Text(s)),
            Tok::Bool(b) => Ok(Expr::Bool(b)),
            Tok::Ident(n) if n == "not" => {
                Ok(Expr::Unary(UnaryOp::Not, Box::new(self.expr(16, false)?)))
            }
            Tok::Ident(n) => Ok(Expr::Name(n)),
            Tok::Func(name) => {
                let args = self.row_args()?;
                Ok(Expr::Call { name, args })
            }
            Tok::Op(Op::LParen) => {
                let inner = self.expr(0, false)?;
                self.expect(Op::RParen, "Missing closing parenthesis")?;
                Ok(Expr::Paren(Box::new(inner)))
            }
            Tok::Op(Op::LBracket) => {
                let mut items = Vec::new();
                if self.is_op(Op::RBracket) {
                    self.bump();
                    return Ok(Expr::List(items));
                }
                loop {
                    items.push(self.expr(0, false)?);
                    if self.is_op(Op::Comma) {
                        self.bump();
                        continue;
                    }
                    self.expect(Op::RBracket, "Expected , or ]")?;
                    break;
                }
                Ok(Expr::List(items))
            }
            Tok::Op(Op::Minus) => Ok(Expr::Unary(UnaryOp::Neg, Box::new(self.expr(16, false)?))),
            Tok::Op(Op::Plus) => Ok(Expr::Unary(UnaryOp::Plus, Box::new(self.expr(16, false)?))),
            Tok::Op(Op::Bang) => Ok(Expr::Unary(UnaryOp::Not, Box::new(self.expr(16, false)?))),
            Tok::Eof => Err(ParseError {
                message: "Unexpected end of formula".into(),
                start: self.src_len,
                end: self.src_len,
            }),
            _ => Err(ParseError {
                message: "Unexpected token".into(),
                start: t.start,
                end: t.end,
            }),
        }
    }
}

fn is_ref_like(e: &Expr) -> bool {
    match e {
        Expr::Ref(_) | Expr::Name(_) | Expr::Call { .. } => true,
        Expr::Paren(inner) => is_ref_like(inner),
        Expr::Binary(BinaryOp::Range | BinaryOp::Intersect | BinaryOp::Union, _, _) => true,
        Expr::Postfix(PostfixOp::Spill, _) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{RefTarget, Reference};

    fn p(s: &str) -> Expr {
        match parse(s, Dialect::Excel) {
            Ok(e) => e,
            Err(e) => panic!("parse {s}: {e}"),
        }
    }

    #[test]
    fn precedence() {
        // -2^2 = (-2)^2
        assert!(
            matches!(p("=-2^2"), Expr::Binary(BinaryOp::Pow, a, _) if matches!(*a, Expr::Unary(UnaryOp::Neg, _)))
        );
        // 1+2*3
        assert!(
            matches!(p("1+2*3"), Expr::Binary(BinaryOp::Add, _, b) if matches!(*b, Expr::Binary(BinaryOp::Mul, _, _)))
        );
        // 1&2=3 → (1&2)=3
        assert!(
            matches!(p("1&2=3"), Expr::Binary(BinaryOp::Eq, a, _) if matches!(*a, Expr::Binary(BinaryOp::Concat, _, _)))
        );
        // 2^3^2 left-assoc
        assert!(
            matches!(p("2^3^2"), Expr::Binary(BinaryOp::Pow, a, _) if matches!(*a, Expr::Binary(BinaryOp::Pow, _, _)))
        );
        // 50%*2
        assert!(
            matches!(p("50%*2"), Expr::Binary(BinaryOp::Mul, a, _) if matches!(*a, Expr::Postfix(PostfixOp::Percent, _)))
        );
    }

    #[test]
    fn calls_and_refs() {
        let e = p("=SUM(A1:B2, Sheet2!C3, 5)");
        let Expr::Call { name, args } = e else {
            panic!("not a call")
        };
        assert_eq!(name, "SUM");
        assert_eq!(args.len(), 3);
        assert!(matches!(
            &args[0],
            Expr::Ref(Reference {
                target: RefTarget::Area(..),
                ..
            })
        ));
        let e = p("IF(A1,,2)");
        assert!(matches!(e, Expr::Call { ref args, .. } if args[1] == Expr::Missing));
        assert!(matches!(p("NOW()"), Expr::Call { ref args, .. } if args.is_empty()));
        assert!(matches!(
            p("A1:INDEX(B:B,3)"),
            Expr::Binary(BinaryOp::Range, _, _)
        ));
        assert!(
            matches!(p("SUM(A1:B5 B2:C3)"), Expr::Call { ref args, .. } if matches!(args[0], Expr::Binary(BinaryOp::Intersect, _, _)))
        );
        assert!(
            matches!(p("SUM((A1,B2))"), Expr::Call { ref args, .. } if matches!(&args[0], Expr::Paren(i) if matches!(**i, Expr::Binary(BinaryOp::Union, _, _))))
        );
        assert!(matches!(p("{1,2;3,-4}"), Expr::Array(ref r) if r.len() == 2 && r[0].len() == 2));
        assert!(matches!(p("A1#"), Expr::Postfix(PostfixOp::Spill, _)));
        assert!(matches!(p(" 1 + 2 "), Expr::Binary(BinaryOp::Add, _, _)));
    }

    #[test]
    fn errors_with_spans() {
        let e = parse("=1+", Dialect::Excel).err().unwrap_or(ParseError {
            message: String::new(),
            start: 0,
            end: 0,
        });
        assert_eq!(e.start, 3);
        assert!(parse("=SUM(1,2", Dialect::Excel).is_err());
        assert!(parse("=WEBSERVICE(\"http://x\")", Dialect::Excel).is_err());
        assert!(parse("=(1+2", Dialect::Excel).is_err());
        assert!(parse("=1 2", Dialect::Excel).is_err());
        assert!(parse("=", Dialect::Excel).is_err());
        let deep = format!("={}1{}", "(".repeat(300), ")".repeat(300));
        assert!(parse(&deep, Dialect::Excel).is_err());
        let long = format!("={}", "1+".repeat(5000));
        assert!(parse(&long, Dialect::Excel).is_err());
        let many = format!("=SUM({})", vec!["1"; 256].join(","));
        assert!(parse(&many, Dialect::Excel).is_err());
        let ok = format!("=SUM({})", vec!["1"; 255].join(","));
        assert!(parse(&ok, Dialect::Excel).is_ok());
    }

    #[test]
    fn row_dialect() {
        let e = parse(
            "prop(\"Price\") * 2 > 10 ? \"big\" : \"small\"",
            Dialect::Row,
        );
        assert!(matches!(e, Ok(Expr::Ternary(..))));
        let e = parse("prop(\"Tags\").length()", Dialect::Row);
        assert!(matches!(e, Ok(Expr::Method { ref name, .. }) if name == "length"));
        let e = parse("a and b or not c", Dialect::Row);
        assert!(matches!(e, Ok(Expr::Binary(BinaryOp::Or, _, _))));
        let e = parse("[1, 2, 3]", Dialect::Row);
        assert!(matches!(e, Ok(Expr::List(ref v)) if v.len() == 3));
        let e = parse("2 ^ 3 ^ 2", Dialect::Row);
        assert!(
            matches!(e, Ok(Expr::Binary(BinaryOp::Pow, _, b)) if matches!(*b, Expr::Binary(BinaryOp::Pow, _, _)))
        );
        let e = parse("metrics.savings_rate >= 0.2", Dialect::Metric);
        assert!(
            matches!(e, Ok(Expr::Binary(BinaryOp::Ge, a, _)) if matches!(*a, Expr::Path(ref v) if v.len() == 2))
        );
    }
}
