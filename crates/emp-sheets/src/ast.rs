//! Formula AST shared by all dialects (SPEC §14.1, §14.6, §14.7).
//!
//! The Excel dialect uses references, ranges and Excel operators; the Row and Metric dialects add lists,
//! the ternary operator, method calls and dotted paths. A single parser produces this tree for every
//! dialect (decision D-12).

use crate::address::SheetId;
use crate::limits::{MAX_COLS, MAX_ROWS};
use crate::value::ErrorKind;

/// Sheet part of a reference.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SheetRef {
    /// As written in the formula (unbound).
    Named(String),
    /// Bound to a sheet of the workbook; printed with the sheet's current name.
    Id(SheetId),
}

/// One corner of a reference. Coordinates are 0-based.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CellRef {
    /// Row.
    pub row: u32,
    /// Column.
    pub col: u32,
    /// `$` before the row.
    pub row_abs: bool,
    /// `$` before the column.
    pub col_abs: bool,
}

impl CellRef {
    /// A relative reference.
    pub fn rel(row: u32, col: u32) -> CellRef {
        CellRef {
            row,
            col,
            row_abs: false,
            col_abs: false,
        }
    }
}

/// What a reference points at.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RefTarget {
    /// `A1`
    Cell(CellRef),
    /// `A1:B2`
    Area(CellRef, CellRef),
    /// `A:C`
    Cols {
        /// First column.
        c0: u32,
        /// Last column.
        c1: u32,
        /// `$` on the first column.
        abs0: bool,
        /// `$` on the last column.
        abs1: bool,
    },
    /// `1:3`
    Rows {
        /// First row.
        r0: u32,
        /// Last row.
        r1: u32,
        /// `$` on the first row.
        abs0: bool,
        /// `$` on the last row.
        abs1: bool,
    },
    /// A reference whose target was deleted (`#REF!`).
    Invalid,
}

/// A cell, area, column or row reference, optionally qualified by a sheet.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Reference {
    /// Sheet qualifier; `None` means the formula's own sheet.
    pub sheet: Option<SheetRef>,
    /// Target.
    pub target: RefTarget,
}

impl Reference {
    /// Inclusive bounds `(r0, c0, r1, c1)`, or `None` for `#REF!`.
    pub fn bounds(&self) -> Option<(u32, u32, u32, u32)> {
        match &self.target {
            RefTarget::Cell(c) => Some((c.row, c.col, c.row, c.col)),
            RefTarget::Area(a, b) => Some((
                a.row.min(b.row),
                a.col.min(b.col),
                a.row.max(b.row),
                a.col.max(b.col),
            )),
            RefTarget::Cols { c0, c1, .. } => Some((0, *c0.min(c1), MAX_ROWS - 1, *c0.max(c1))),
            RefTarget::Rows { r0, r1, .. } => Some((*r0.min(r1), 0, *r0.max(r1), MAX_COLS - 1)),
            RefTarget::Invalid => None,
        }
    }
}

/// Prefix operators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UnaryOp {
    /// `-x`
    Neg,
    /// `+x`
    Plus,
    /// `not x` / `!x` (Row and Metric dialects)
    Not,
    /// `@x` implicit intersection (Excel)
    At,
}

/// Postfix operators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PostfixOp {
    /// `x%`
    Percent,
    /// `A1#` spill reference
    Spill,
}

/// Infix operators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BinaryOp {
    /// `+`
    Add,
    /// `-`
    Sub,
    /// `*`
    Mul,
    /// `/`
    Div,
    /// `^`
    Pow,
    /// `&`
    Concat,
    /// `=` (Excel) / `==` (Row)
    Eq,
    /// `<>` / `!=`
    Ne,
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
    /// `:` range operator
    Range,
    /// ` ` intersection
    Intersect,
    /// `,` union (inside parentheses)
    Union,
    /// `and` / `&&` (Row and Metric)
    And,
    /// `or` / `||` (Row and Metric)
    Or,
    /// `%` modulo (Row and Metric)
    Mod,
}

/// A formula expression.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// Number literal (never negative; negation is a unary operator).
    Number(f64),
    /// Text literal.
    Text(String),
    /// Boolean literal.
    Bool(bool),
    /// Error literal.
    Error(ErrorKind),
    /// An omitted argument (`IF(A1,,2)`).
    Missing,
    /// Cell or range reference.
    Ref(Reference),
    /// Named range, `LET` variable, or (Row/Metric) identifier.
    Name(String),
    /// Prefix operator.
    Unary(UnaryOp, Box<Expr>),
    /// Postfix operator.
    Postfix(PostfixOp, Box<Expr>),
    /// Infix operator.
    Binary(BinaryOp, Box<Expr>, Box<Expr>),
    /// Function call. Excel names are upper-case with `_xlfn.` prefixes removed.
    Call {
        /// Function name.
        name: String,
        /// Arguments.
        args: Vec<Expr>,
    },
    /// Array constant `{1,2;3,4}` (rows of literals).
    Array(Vec<Vec<Expr>>),
    /// Parenthesised expression (kept so that printing preserves the author's grouping).
    Paren(Box<Expr>),
    /// List literal `[1, 2]` (Row and Metric).
    List(Vec<Expr>),
    /// `cond ? a : b` (Row and Metric).
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    /// `recv.name(args)` method sugar (Row and Metric).
    Method {
        /// Receiver.
        recv: Box<Expr>,
        /// Method (function) name.
        name: String,
        /// Extra arguments after the receiver.
        args: Vec<Expr>,
    },
    /// Dotted identifier `metrics.savings_rate` (Metric).
    Path(Vec<String>),
}

impl Expr {
    /// Visit every node (pre-order).
    pub fn walk(&self, f: &mut dyn FnMut(&Expr)) {
        f(self);
        match self {
            Expr::Unary(_, e) | Expr::Postfix(_, e) | Expr::Paren(e) => e.walk(f),
            Expr::Binary(_, a, b) => {
                a.walk(f);
                b.walk(f);
            }
            Expr::Call { args, .. } | Expr::List(args) => args.iter().for_each(|a| a.walk(f)),
            Expr::Method { recv, args, .. } => {
                recv.walk(f);
                args.iter().for_each(|a| a.walk(f));
            }
            Expr::Array(rows) => rows.iter().flatten().for_each(|a| a.walk(f)),
            Expr::Ternary(a, b, c) => {
                a.walk(f);
                b.walk(f);
                c.walk(f);
            }
            _ => {}
        }
    }

    /// Visit every node mutably (post-order on children first is not guaranteed; pre-order).
    pub fn walk_mut(&mut self, f: &mut dyn FnMut(&mut Expr)) {
        f(self);
        match self {
            Expr::Unary(_, e) | Expr::Postfix(_, e) | Expr::Paren(e) => e.walk_mut(f),
            Expr::Binary(_, a, b) => {
                a.walk_mut(f);
                b.walk_mut(f);
            }
            Expr::Call { args, .. } | Expr::List(args) => {
                args.iter_mut().for_each(|a| a.walk_mut(f))
            }
            Expr::Method { recv, args, .. } => {
                recv.walk_mut(f);
                args.iter_mut().for_each(|a| a.walk_mut(f));
            }
            Expr::Array(rows) => rows.iter_mut().flatten().for_each(|a| a.walk_mut(f)),
            Expr::Ternary(a, b, c) => {
                a.walk_mut(f);
                b.walk_mut(f);
                c.walk_mut(f);
            }
            _ => {}
        }
    }

    /// Apply `f` to every reference.
    pub fn for_each_ref_mut(&mut self, f: &mut dyn FnMut(&mut Reference)) {
        self.walk_mut(&mut |e| {
            if let Expr::Ref(r) = e {
                f(r)
            }
        });
    }

    /// Names of all functions called (upper-case for Excel).
    pub fn functions(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.walk(&mut |e| {
            if let Expr::Call { name, .. } = e {
                out.push(name.clone());
            }
        });
        out
    }

    /// Shift relative references by `(dr, dc)` (copy / fill). References pushed off the grid become `#REF!`.
    pub fn translate(&mut self, dr: i64, dc: i64) {
        self.for_each_ref_mut(&mut |r| translate_ref(r, dr, dc));
    }
}

fn shift(v: u32, d: i64, abs: bool, max: u32) -> Option<u32> {
    if abs {
        return Some(v);
    }
    let n = v as i64 + d;
    (0..max as i64).contains(&n).then_some(n as u32)
}

/// Shift one reference's relative parts.
pub fn translate_ref(r: &mut Reference, dr: i64, dc: i64) {
    let new = match &r.target {
        RefTarget::Cell(c) => shift_cell(c, dr, dc).map(RefTarget::Cell),
        RefTarget::Area(a, b) => match (shift_cell(a, dr, dc), shift_cell(b, dr, dc)) {
            (Some(a), Some(b)) => Some(RefTarget::Area(a, b)),
            _ => None,
        },
        RefTarget::Cols { c0, c1, abs0, abs1 } => {
            match (
                shift(*c0, dc, *abs0, MAX_COLS),
                shift(*c1, dc, *abs1, MAX_COLS),
            ) {
                (Some(a), Some(b)) => Some(RefTarget::Cols {
                    c0: a,
                    c1: b,
                    abs0: *abs0,
                    abs1: *abs1,
                }),
                _ => None,
            }
        }
        RefTarget::Rows { r0, r1, abs0, abs1 } => {
            match (
                shift(*r0, dr, *abs0, MAX_ROWS),
                shift(*r1, dr, *abs1, MAX_ROWS),
            ) {
                (Some(a), Some(b)) => Some(RefTarget::Rows {
                    r0: a,
                    r1: b,
                    abs0: *abs0,
                    abs1: *abs1,
                }),
                _ => None,
            }
        }
        RefTarget::Invalid => None,
    };
    r.target = new.unwrap_or(RefTarget::Invalid);
}

fn shift_cell(c: &CellRef, dr: i64, dc: i64) -> Option<CellRef> {
    Some(CellRef {
        row: shift(c.row, dr, c.row_abs, MAX_ROWS)?,
        col: shift(c.col, dc, c.col_abs, MAX_COLS)?,
        row_abs: c.row_abs,
        col_abs: c.col_abs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translate_relative_only() {
        let mut e = Expr::Ref(Reference {
            sheet: None,
            target: RefTarget::Area(
                CellRef::rel(0, 0),
                CellRef {
                    row: 5,
                    col: 1,
                    row_abs: true,
                    col_abs: false,
                },
            ),
        });
        e.translate(2, 1);
        assert_eq!(
            e,
            Expr::Ref(Reference {
                sheet: None,
                target: RefTarget::Area(
                    CellRef::rel(2, 1),
                    CellRef {
                        row: 5,
                        col: 2,
                        row_abs: true,
                        col_abs: false
                    }
                ),
            })
        );
        e.translate(-10, 0);
        assert_eq!(
            e,
            Expr::Ref(Reference {
                sheet: None,
                target: RefTarget::Invalid
            })
        );
    }
}
