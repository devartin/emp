//! AST printer. `parse(print(ast)) == ast` holds for every parsed AST (SPEC §14.1).

use crate::address::{SheetId, col_to_letters, quote_sheet_name};
use crate::ast::{BinaryOp, CellRef, Expr, PostfixOp, RefTarget, Reference, SheetRef, UnaryOp};
use crate::parser::Dialect;

/// Functions that need the `_xlfn.` prefix when written to xlsx.
pub const XLFN_FUNCTIONS: &[&str] = &[
    "XLOOKUP",
    "XMATCH",
    "FILTER",
    "SORT",
    "SORTBY",
    "UNIQUE",
    "SEQUENCE",
    "RANDARRAY",
    "TAKE",
    "DROP",
    "CHOOSECOLS",
    "CHOOSEROWS",
    "VSTACK",
    "HSTACK",
    "TEXTSPLIT",
    "TEXTBEFORE",
    "TEXTAFTER",
    "LET",
    "IFS",
    "SWITCH",
    "XOR",
    "CONCAT",
    "TEXTJOIN",
    "MAXIFS",
    "MINIFS",
    "STDEV.S",
    "STDEV.P",
    "VAR.S",
    "VAR.P",
    "MODE.SNGL",
    "RANK.EQ",
    "RANK.AVG",
    "PERCENTILE.INC",
    "PERCENTILE.EXC",
    "QUARTILE.INC",
    "PERCENTRANK.INC",
    "COVARIANCE.S",
    "FORECAST.LINEAR",
    "NORM.DIST",
    "NORM.INV",
    "NORM.S.DIST",
    "CEILING.MATH",
    "FLOOR.MATH",
    "AGGREGATE",
    "IFNA",
    "DAYS",
    "ISOWEEKNUM",
    "NETWORKDAYS.INTL",
    "WORKDAY.INTL",
    "PDURATION",
    "RRI",
    "NUMBERVALUE",
    "UNICHAR",
    "UNICODE",
    "ISFORMULA",
];

/// Printing options.
#[derive(Clone, Copy, Debug, Default)]
pub struct PrintOptions {
    /// Dialect to print in.
    pub dialect: Dialect,
    /// Prefix newer functions with `_xlfn.` (xlsx files).
    pub xlfn: bool,
}

/// Resolve sheet ids to names while printing.
pub trait SheetNames {
    /// Current name of a sheet id.
    fn sheet_name(&self, id: SheetId) -> Option<String>;
}

/// No bound sheets.
pub struct NoSheets;
impl SheetNames for NoSheets {
    fn sheet_name(&self, _: SheetId) -> Option<String> {
        None
    }
}

impl<F: Fn(SheetId) -> Option<String>> SheetNames for F {
    fn sheet_name(&self, id: SheetId) -> Option<String> {
        self(id)
    }
}

/// Print an expression in the Excel dialect without a leading `=`.
pub fn print_excel(e: &Expr, names: &dyn SheetNames) -> String {
    print(e, names, PrintOptions::default())
}

/// Print an expression with options.
pub fn print(e: &Expr, names: &dyn SheetNames, opts: PrintOptions) -> String {
    let mut p = Printer {
        names,
        opts,
        out: String::new(),
        no_union_paren: false,
    };
    p.expr(e, 0);
    p.out
}

/// Format a number literal so that it re-parses to the same `f64`.
pub fn format_number_literal(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        return format!("{}", x as i64);
    }
    let plain = format!("{x}");
    if plain.len() <= 20 {
        return plain;
    }
    format!("{x:e}").to_uppercase()
}

struct Printer<'a> {
    names: &'a dyn SheetNames,
    opts: PrintOptions,
    out: String,
    no_union_paren: bool,
}

const ATOM: u8 = 100;

fn excel_prec(op: BinaryOp) -> u8 {
    match op {
        BinaryOp::Eq | BinaryOp::Ne | BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
            1
        }
        BinaryOp::Concat => 2,
        BinaryOp::Add | BinaryOp::Sub => 3,
        BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => 4,
        BinaryOp::Pow => 5,
        BinaryOp::Union => 8,
        BinaryOp::Intersect => 9,
        BinaryOp::Range => 10,
        BinaryOp::And | BinaryOp::Or => 0,
    }
}

fn row_prec(op: BinaryOp) -> u8 {
    match op {
        BinaryOp::Or => 2,
        BinaryOp::And => 3,
        BinaryOp::Eq | BinaryOp::Ne => 4,
        BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => 5,
        BinaryOp::Add | BinaryOp::Sub | BinaryOp::Concat => 6,
        BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => 7,
        BinaryOp::Pow => 8,
        BinaryOp::Range | BinaryOp::Intersect | BinaryOp::Union => 6,
    }
}

impl Printer<'_> {
    fn excel(&self) -> bool {
        self.opts.dialect == Dialect::Excel
    }

    fn prec(&self, e: &Expr) -> u8 {
        let excel = self.excel();
        match e {
            Expr::Binary(op, ..) => {
                if excel {
                    excel_prec(*op)
                } else {
                    row_prec(*op)
                }
            }
            Expr::Unary(..) => {
                if excel {
                    7
                } else {
                    9
                }
            }
            Expr::Postfix(PostfixOp::Percent, _) => 6,
            Expr::Postfix(PostfixOp::Spill, _) => 11,
            Expr::Ternary(..) => 1,
            Expr::Method { .. } | Expr::Path(_) => 10,
            _ => ATOM,
        }
    }

    fn wrapped(&mut self, e: &Expr, min: u8) {
        if self.prec(e) < min {
            self.out.push('(');
            self.expr(e, 0);
            self.out.push(')');
        } else {
            self.expr(e, min);
        }
    }

    fn expr(&mut self, e: &Expr, _ctx: u8) {
        let suppress_union_paren = std::mem::replace(&mut self.no_union_paren, false);
        match e {
            Expr::Number(x) => {
                let s = format_number_literal(*x);
                self.out.push_str(&s);
            }
            Expr::Text(s) => {
                if self.excel() {
                    self.out.push('"');
                    self.out.push_str(&s.replace('"', "\"\""));
                    self.out.push('"');
                } else {
                    self.out.push('"');
                    for c in s.chars() {
                        match c {
                            '"' => self.out.push_str("\\\""),
                            '\\' => self.out.push_str("\\\\"),
                            '\n' => self.out.push_str("\\n"),
                            '\t' => self.out.push_str("\\t"),
                            c => self.out.push(c),
                        }
                    }
                    self.out.push('"');
                }
            }
            Expr::Bool(b) => {
                let s = match (self.excel(), b) {
                    (true, true) => "TRUE",
                    (true, false) => "FALSE",
                    (false, true) => "true",
                    (false, false) => "false",
                };
                self.out.push_str(s);
            }
            Expr::Error(err) => self.out.push_str(err.as_str()),
            Expr::Missing => {}
            Expr::Ref(r) => {
                let s = self.reference(r);
                self.out.push_str(&s);
            }
            Expr::Name(n) => self.out.push_str(n),
            Expr::Unary(op, inner) => {
                let excel = self.excel();
                let s = match op {
                    UnaryOp::Neg => "-",
                    UnaryOp::Plus => "+",
                    UnaryOp::At => "@",
                    UnaryOp::Not => {
                        if excel {
                            "NOT"
                        } else {
                            "not "
                        }
                    }
                };
                self.out.push_str(s);
                let min = if excel { 7 } else { 9 };
                self.wrapped(inner, min);
            }
            Expr::Postfix(op, inner) => {
                let min = match op {
                    PostfixOp::Percent => 6,
                    PostfixOp::Spill => 11,
                };
                self.wrapped(inner, min);
                self.out.push(match op {
                    PostfixOp::Percent => '%',
                    PostfixOp::Spill => '#',
                });
            }
            Expr::Binary(op, a, b) => {
                let excel = self.excel();
                let p = if excel {
                    excel_prec(*op)
                } else {
                    row_prec(*op)
                };
                let right_assoc = !excel && *op == BinaryOp::Pow;
                let union_needs_paren = excel && *op == BinaryOp::Union && !suppress_union_paren;
                if union_needs_paren {
                    self.out.push('(');
                }
                if excel
                    && *op == BinaryOp::Union
                    && matches!(**a, Expr::Binary(BinaryOp::Union, ..))
                {
                    self.no_union_paren = true;
                }
                if right_assoc {
                    self.wrapped(a, p + 1);
                } else {
                    self.wrapped(a, p);
                }
                let sym = if excel {
                    match op {
                        BinaryOp::Add => "+",
                        BinaryOp::Sub => "-",
                        BinaryOp::Mul => "*",
                        BinaryOp::Div => "/",
                        BinaryOp::Pow => "^",
                        BinaryOp::Concat => "&",
                        BinaryOp::Eq => "=",
                        BinaryOp::Ne => "<>",
                        BinaryOp::Lt => "<",
                        BinaryOp::Le => "<=",
                        BinaryOp::Gt => ">",
                        BinaryOp::Ge => ">=",
                        BinaryOp::Range => ":",
                        BinaryOp::Intersect => " ",
                        BinaryOp::Union => ",",
                        BinaryOp::And => " and ",
                        BinaryOp::Or => " or ",
                        BinaryOp::Mod => " % ",
                    }
                } else {
                    match op {
                        BinaryOp::Add => " + ",
                        BinaryOp::Sub => " - ",
                        BinaryOp::Mul => " * ",
                        BinaryOp::Div => " / ",
                        BinaryOp::Pow => " ^ ",
                        BinaryOp::Concat => " + ",
                        BinaryOp::Eq => " == ",
                        BinaryOp::Ne => " != ",
                        BinaryOp::Lt => " < ",
                        BinaryOp::Le => " <= ",
                        BinaryOp::Gt => " > ",
                        BinaryOp::Ge => " >= ",
                        BinaryOp::Range => ":",
                        BinaryOp::Intersect => " ",
                        BinaryOp::Union => ", ",
                        BinaryOp::And => " and ",
                        BinaryOp::Or => " or ",
                        BinaryOp::Mod => " % ",
                    }
                };
                self.out.push_str(sym);
                if right_assoc {
                    self.wrapped(b, p);
                } else {
                    self.wrapped(b, p + 1);
                }
                if union_needs_paren {
                    self.out.push(')');
                }
            }
            Expr::Call { name, args } => {
                if self.opts.xlfn && XLFN_FUNCTIONS.contains(&name.as_str()) {
                    self.out.push_str("_xlfn.");
                }
                self.out.push_str(name);
                self.args(args);
            }
            Expr::Array(rows) => {
                self.out.push('{');
                for (i, row) in rows.iter().enumerate() {
                    if i > 0 {
                        self.out.push(';');
                    }
                    for (j, item) in row.iter().enumerate() {
                        if j > 0 {
                            self.out.push(',');
                        }
                        self.expr(item, 0);
                    }
                }
                self.out.push('}');
            }
            Expr::Paren(inner) => {
                self.out.push('(');
                self.no_union_paren = true;
                self.expr(inner, 0);
                self.no_union_paren = false;
                self.out.push(')');
            }
            Expr::List(items) => {
                self.out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    self.expr(item, 0);
                }
                self.out.push(']');
            }
            Expr::Ternary(c, a, b) => {
                self.wrapped(c, 2);
                self.out.push_str(" ? ");
                self.wrapped(a, 0);
                self.out.push_str(" : ");
                self.wrapped(b, 1);
            }
            Expr::Method { recv, name, args } => {
                self.wrapped(recv, 10);
                self.out.push('.');
                self.out.push_str(name);
                self.args(args);
            }
            Expr::Path(parts) => self.out.push_str(&parts.join(".")),
        }
    }

    fn args(&mut self, args: &[Expr]) {
        self.out.push('(');
        let sep = if self.excel() { "," } else { ", " };
        for (i, a) in args.iter().enumerate() {
            if i > 0 {
                self.out.push_str(sep);
            }
            self.expr(a, 0);
        }
        self.out.push(')');
    }

    fn reference(&self, r: &Reference) -> String {
        let mut s = String::new();
        match &r.sheet {
            None => {}
            Some(SheetRef::Named(n)) => {
                s.push_str(&quote_sheet_name(n));
                s.push('!');
            }
            Some(SheetRef::Id(id)) => match self.names.sheet_name(*id) {
                Some(n) => {
                    s.push_str(&quote_sheet_name(&n));
                    s.push('!');
                }
                None => return "#REF!".to_string(),
            },
        }
        match &r.target {
            RefTarget::Cell(c) => s.push_str(&cell(c)),
            RefTarget::Area(a, b) => {
                s.push_str(&cell(a));
                s.push(':');
                s.push_str(&cell(b));
            }
            RefTarget::Cols { c0, c1, abs0, abs1 } => {
                s.push_str(&format!(
                    "{}{}:{}{}",
                    if *abs0 { "$" } else { "" },
                    col_to_letters(*c0),
                    if *abs1 { "$" } else { "" },
                    col_to_letters(*c1)
                ));
            }
            RefTarget::Rows { r0, r1, abs0, abs1 } => {
                s.push_str(&format!(
                    "{}{}:{}{}",
                    if *abs0 { "$" } else { "" },
                    r0 + 1,
                    if *abs1 { "$" } else { "" },
                    r1 + 1
                ));
            }
            RefTarget::Invalid => s.push_str("#REF!"),
        }
        s
    }
}

fn cell(c: &CellRef) -> String {
    format!(
        "{}{}{}{}",
        if c.col_abs { "$" } else { "" },
        col_to_letters(c.col),
        if c.row_abs { "$" } else { "" },
        c.row + 1
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    fn rt(s: &str) -> String {
        let e = parse(s, Dialect::Excel).unwrap_or(Expr::Missing);
        print_excel(&e, &NoSheets)
    }

    #[test]
    fn prints() {
        assert_eq!(
            rt("=sum(a1:b2,  'My Sheet'!$C$3)"),
            "SUM(A1:B2,'My Sheet'!$C$3)"
        );
        assert_eq!(rt("-2^2"), "-2^2");
        assert_eq!(rt("(1+2)*3"), "(1+2)*3");
        assert_eq!(rt("\"a\"\"b\"&TRUE"), "\"a\"\"b\"&TRUE");
        assert_eq!(rt("{1,2;3,-4}"), "{1,2;3,-4}");
        assert_eq!(rt("A:A"), "A:A");
        assert_eq!(rt("$1:$3"), "$1:$3");
        assert_eq!(rt("A1 B2"), "A1 B2");
        assert_eq!(rt("SUM((A1,B2))"), "SUM((A1,B2))");
        assert_eq!(rt("0.1+1E+20"), "0.1+1E20");
        assert_eq!(rt("1.5E-300"), "1.5E-300");
        assert_eq!(rt("50%"), "50%");
        assert_eq!(rt("A1#"), "A1#");
        assert_eq!(rt("IF(A1,,2)"), "IF(A1,,2)");
    }

    #[test]
    fn synthesised_parens() {
        let e = Expr::Unary(
            UnaryOp::Neg,
            Box::new(Expr::Binary(
                BinaryOp::Pow,
                Box::new(Expr::Number(2.0)),
                Box::new(Expr::Number(2.0)),
            )),
        );
        assert_eq!(print_excel(&e, &NoSheets), "-(2^2)");
        let e = Expr::Binary(
            BinaryOp::Sub,
            Box::new(Expr::Number(1.0)),
            Box::new(Expr::Binary(
                BinaryOp::Sub,
                Box::new(Expr::Number(2.0)),
                Box::new(Expr::Number(3.0)),
            )),
        );
        assert_eq!(print_excel(&e, &NoSheets), "1-(2-3)");
    }

    #[test]
    fn xlfn() {
        let e = parse("=XLOOKUP(1,A:A,B:B)", Dialect::Excel).unwrap_or(Expr::Missing);
        let s = print(
            &e,
            &NoSheets,
            PrintOptions {
                dialect: Dialect::Excel,
                xlfn: true,
            },
        );
        assert_eq!(s, "_xlfn.XLOOKUP(1,A:A,B:B)");
        let back = parse(&s, Dialect::Excel).unwrap_or(Expr::Missing);
        assert_eq!(back, e);
    }

    #[test]
    fn row_print() {
        let src = "prop(\"Price\") * 2 > 10 ? \"big\" : \"sm\\\"all\"";
        let e = parse(src, Dialect::Row).unwrap_or(Expr::Missing);
        let s = print(
            &e,
            &NoSheets,
            PrintOptions {
                dialect: Dialect::Row,
                xlfn: false,
            },
        );
        assert_eq!(s, src);
        assert_eq!(parse(&s, Dialect::Row).ok(), Some(e));
    }
}
