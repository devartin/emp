//! Property tests (deterministic RNG): `parse(print(ast)) == ast`, printer idempotence, and robustness of
//! the lexer, parser and evaluator on random input.

use emp_sheets::ast::{
    BinaryOp, CellRef, Expr, PostfixOp, RefTarget, Reference, SheetRef, UnaryOp,
};
use emp_sheets::printer::{NoSheets, PrintOptions, print};
use emp_sheets::{Dialect, Workbook, parse, print_excel};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a>(&mut self, xs: &'a [&'a str]) -> &'a str {
        xs[self.below(xs.len() as u64) as usize]
    }
}

const FUNCS: &[&str] = &[
    "SUM", "IF", "ROUND", "XLOOKUP", "INDEX", "TEXT", "AND", "LEN", "MAX", "FOO.BAR",
];

fn gen_ref(r: &mut Rng) -> Expr {
    let cell = |r: &mut Rng| CellRef {
        row: r.below(50) as u32,
        col: r.below(30) as u32,
        row_abs: r.below(2) == 0,
        col_abs: r.below(2) == 0,
    };
    let target = match r.below(5) {
        0 | 1 => RefTarget::Cell(cell(r)),
        2 => RefTarget::Area(cell(r), cell(r)),
        3 => {
            let c = r.below(30) as u32;
            RefTarget::Cols {
                c0: c,
                c1: c + r.below(3) as u32,
                abs0: r.below(2) == 0,
                abs1: false,
            }
        }
        _ => {
            let rr = r.below(100) as u32;
            RefTarget::Rows {
                r0: rr,
                r1: rr + r.below(3) as u32,
                abs0: false,
                abs1: r.below(2) == 0,
            }
        }
    };
    let sheet = match r.below(4) {
        0 => Some(SheetRef::Named(
            r.pick(&["Data", "My Sheet", "O'Brien", "2024"]).to_string(),
        )),
        _ => None,
    };
    Expr::Ref(Reference { sheet, target })
}

fn gen_expr(r: &mut Rng, depth: u32) -> Expr {
    if depth == 0 {
        return match r.below(6) {
            0 => Expr::Number((r.below(100_000) as f64) / [1.0, 10.0, 1000.0][r.below(3) as usize]),
            1 => Expr::Text(r.pick(&["", "a", "say \"hi\"", "x,y", "1"]).to_string()),
            2 => Expr::Bool(r.below(2) == 0),
            3 => Expr::Name(r.pick(&["Rate", "total_2", "x"]).to_string()),
            _ => gen_ref(r),
        };
    }
    match r.below(9) {
        0 => Expr::Unary(
            [UnaryOp::Neg, UnaryOp::Plus][r.below(2) as usize],
            Box::new(gen_expr(r, depth - 1)),
        ),
        1 => Expr::Postfix(PostfixOp::Percent, Box::new(gen_expr(r, depth - 1))),
        2 | 3 => {
            let ops = [
                BinaryOp::Add,
                BinaryOp::Sub,
                BinaryOp::Mul,
                BinaryOp::Div,
                BinaryOp::Pow,
                BinaryOp::Concat,
                BinaryOp::Eq,
                BinaryOp::Ne,
                BinaryOp::Lt,
                BinaryOp::Ge,
            ];
            Expr::Binary(
                ops[r.below(ops.len() as u64) as usize],
                Box::new(gen_expr(r, depth - 1)),
                Box::new(gen_expr(r, depth - 1)),
            )
        }
        4 => Expr::Paren(Box::new(gen_expr(r, depth - 1))),
        5 | 6 => {
            let n = r.below(4);
            let args = (0..n)
                .map(|_| {
                    if r.below(8) == 0 {
                        Expr::Missing
                    } else {
                        gen_expr(r, depth - 1)
                    }
                })
                .collect();
            Expr::Call {
                name: r.pick(FUNCS).to_string(),
                args,
            }
        }
        7 => {
            let cols = 1 + r.below(3) as usize;
            let rows = 1 + r.below(2) as usize;
            Expr::Array(
                (0..rows)
                    .map(|_| {
                        (0..cols)
                            .map(|_| Expr::Number(r.below(10) as f64))
                            .collect()
                    })
                    .collect(),
            )
        }
        _ => gen_ref(r),
    }
}

#[test]
fn parse_print_roundtrip() {
    let mut r = Rng(0x2545_F491_4F6C_DD1D);
    let mut checked = 0;
    for _ in 0..5000 {
        let ast = gen_expr(&mut r, 4);
        let text = print_excel(&ast, &NoSheets);
        let Ok(parsed) = parse(&text, Dialect::Excel) else {
            panic!("printed text does not parse: {text}");
        };
        // String-level idempotence for synthesised ASTs (which may lack grouping parentheses).
        let again = print_excel(&parsed, &NoSheets);
        assert_eq!(text, again, "printer not idempotent");
        // Exact AST round trip for parsed ASTs.
        let reparsed = parse(&again, Dialect::Excel).ok();
        assert_eq!(
            reparsed.as_ref(),
            Some(&parsed),
            "parse(print(ast)) != ast for {text}"
        );
        checked += 1;
    }
    assert_eq!(checked, 5000);
}

#[test]
fn xlfn_roundtrip() {
    let mut r = Rng(42);
    for _ in 0..500 {
        let ast = gen_expr(&mut r, 3);
        let text = print_excel(&ast, &NoSheets);
        let Ok(parsed) = parse(&text, Dialect::Excel) else {
            continue;
        };
        let xl = print(
            &parsed,
            &NoSheets,
            PrintOptions {
                dialect: Dialect::Excel,
                xlfn: true,
            },
        );
        assert_eq!(parse(&xl, Dialect::Excel).ok(), Some(parsed));
    }
}

#[test]
fn row_dialect_roundtrip() {
    let srcs = [
        "prop(\"A\") + 1",
        "if(prop(\"Done\"), \"yes\", \"no\")",
        "prop(\"Tags\").map(upper(current)).join(\", \")",
        "(1 + 2) * 3 ^ 2 ^ 1",
        "not (a and b) or !c",
        "x ? y : z ? 1 : 2",
        "[1, [2, 3], \"q\\\"uote\"]",
        "metrics.a.b >= -1 % 3",
    ];
    for s in srcs {
        let e = parse(s, Dialect::Row).unwrap_or(Expr::Missing);
        let p = print(
            &e,
            &NoSheets,
            PrintOptions {
                dialect: Dialect::Row,
                xlfn: false,
            },
        );
        assert_eq!(parse(&p, Dialect::Row).ok(), Some(e), "{s} → {p}");
    }
}

#[test]
fn random_input_never_panics() {
    let mut r = Rng(7);
    let alphabet: Vec<char> = "=+-*/^&%(){}[],;:!#@'\"$ .ABCxyz019_\\<>?é😀\t"
        .chars()
        .collect();
    let mut wb = Workbook::new();
    let s = wb.sheets()[0].id;
    for i in 0..3000 {
        let len = r.below(40) as usize;
        let src: String = (0..len)
            .map(|_| alphabet[r.below(alphabet.len() as u64) as usize])
            .collect();
        let _ = parse(&src, Dialect::Excel);
        let _ = parse(&src, Dialect::Row);
        let _ = parse(&src, Dialect::Metric);
        let _ = wb.eval_formula(Some(s), &src);
        if i % 10 == 0 {
            let _ = wb.set_input(s, (i % 50) as u32, (i % 7) as u32, &src);
        }
    }
    // Random valid formulas evaluate without panicking.
    for _ in 0..2000 {
        let ast = gen_expr(&mut r, 4);
        let text = format!("={}", print_excel(&ast, &NoSheets));
        let _ = wb.eval_formula(Some(s), &text);
    }
}
