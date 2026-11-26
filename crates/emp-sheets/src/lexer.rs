//! Formula lexer with byte spans (SPEC §14.1). One lexer serves all dialects.

use crate::address::{letters_to_col, parse_a1_parts};
use crate::ast::{CellRef, RefTarget, Reference, SheetRef};
use crate::limits::{MAX_COLS, MAX_ROWS};
use crate::parser::{Dialect, ParseError};
use crate::value::ErrorKind;

/// Punctuation and operators.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    /// `+`
    Plus,
    /// `-`
    Minus,
    /// `*`
    Star,
    /// `/`
    Slash,
    /// `^`
    Caret,
    /// `&`
    Amp,
    /// `%`
    Percent,
    /// `=`
    Eq,
    /// `==`
    EqEq,
    /// `<>` or `!=`
    Ne,
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
    /// `(`
    LParen,
    /// `)`
    RParen,
    /// `{`
    LBrace,
    /// `}`
    RBrace,
    /// `[`
    LBracket,
    /// `]`
    RBracket,
    /// `,`
    Comma,
    /// `;`
    Semi,
    /// `:`
    Colon,
    /// `#` (spill)
    Hash,
    /// `@`
    At,
    /// `!` (Row: not)
    Bang,
    /// `&&`
    AndAnd,
    /// `||`
    OrOr,
    /// `?`
    Question,
    /// `.`
    Dot,
}

/// Token kinds.
#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    /// Number literal.
    Num(f64),
    /// String literal (unescaped).
    Str(String),
    /// `TRUE` / `FALSE` (or `true`/`false`).
    Bool(bool),
    /// Error literal.
    Err(ErrorKind),
    /// Identifier (name).
    Ident(String),
    /// Identifier immediately followed by `(`.
    Func(String),
    /// Complete reference, including its sheet prefix (Excel dialect).
    Ref(Reference),
    /// Operator or punctuation.
    Op(Op),
    /// Run of whitespace (significant for the intersection operator).
    Ws,
    /// End of input.
    Eof,
}

/// A token and its byte span `[start, end)`.
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    /// Kind.
    pub tok: Tok,
    /// Start byte.
    pub start: usize,
    /// End byte (exclusive).
    pub end: usize,
}

struct Lexer<'a> {
    src: &'a str,
    b: &'a [u8],
    pos: usize,
    dialect: Dialect,
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '\\'
}
fn is_ident_char(c: char, dialect: Dialect) -> bool {
    match dialect {
        Dialect::Excel => c.is_alphanumeric() || matches!(c, '_' | '.' | '$' | '\\' | '?'),
        _ => c.is_alphanumeric() || c == '_',
    }
}

/// Tokenise `src` (no leading `=`).
pub fn tokenize(src: &str, dialect: Dialect) -> Result<Vec<Token>, ParseError> {
    let mut lx = Lexer {
        src,
        b: src.as_bytes(),
        pos: 0,
        dialect,
    };
    let mut out = Vec::new();
    loop {
        let t = lx.next()?;
        let eof = t.tok == Tok::Eof;
        out.push(t);
        if eof {
            break;
        }
    }
    Ok(out)
}

impl<'a> Lexer<'a> {
    fn peek_char(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }
    fn char_at(&self, p: usize) -> Option<char> {
        self.src.get(p..).and_then(|s| s.chars().next())
    }
    fn err(&self, msg: impl Into<String>, start: usize, end: usize) -> ParseError {
        ParseError {
            message: msg.into(),
            start,
            end: end.max(start),
        }
    }

    fn next(&mut self) -> Result<Token, ParseError> {
        // Row/Metric comments.
        loop {
            let start = self.pos;
            let Some(c) = self.peek_char() else {
                return Ok(Token {
                    tok: Tok::Eof,
                    start,
                    end: start,
                });
            };
            if c.is_whitespace() {
                while self.peek_char().is_some_and(|c| c.is_whitespace()) {
                    self.pos += self.peek_char().map(|c| c.len_utf8()).unwrap_or(1);
                }
                if self.dialect != Dialect::Excel {
                    continue;
                }
                return Ok(Token {
                    tok: Tok::Ws,
                    start,
                    end: self.pos,
                });
            }
            if self.dialect != Dialect::Excel && self.src[self.pos..].starts_with("/*") {
                match self.src[self.pos + 2..].find("*/") {
                    Some(i) => {
                        self.pos += 2 + i + 2;
                        continue;
                    }
                    None => return Err(self.err("Unterminated comment", start, self.src.len())),
                }
            }
            break;
        }
        let start = self.pos;
        let c = self.peek_char().unwrap_or('\0');
        let tok = if c == '"' {
            self.lex_string()?
        } else if c.is_ascii_digit()
            || (c == '.'
                && self
                    .char_at(self.pos + 1)
                    .is_some_and(|d| d.is_ascii_digit()))
        {
            if self.dialect == Dialect::Excel
                && let Some(t) = self.try_row_range(None)
            {
                t
            } else {
                self.lex_number()?
            }
        } else if self.dialect == Dialect::Excel && c == '#' {
            self.lex_error_or_hash()
        } else if self.dialect == Dialect::Excel && c == '\'' {
            self.lex_quoted_sheet()?
        } else if self.dialect == Dialect::Excel && c == '$' {
            if self
                .char_at(self.pos + 1)
                .is_some_and(|d| d.is_ascii_digit())
            {
                match self.try_row_range(None) {
                    Some(t) => t,
                    None => return Err(self.err("Invalid reference", start, start + 1)),
                }
            } else {
                self.lex_word()?
            }
        } else if c == '\'' && self.dialect != Dialect::Excel {
            self.lex_string()?
        } else if is_ident_start(c) {
            self.lex_word()?
        } else {
            self.lex_op()?
        };
        Ok(Token {
            tok,
            start,
            end: self.pos,
        })
    }

    fn lex_string(&mut self) -> Result<Tok, ParseError> {
        let start = self.pos;
        let quote = self.peek_char().unwrap_or('"');
        self.pos += 1;
        let mut s = String::new();
        loop {
            let Some(c) = self.peek_char() else {
                return Err(self.err("Unterminated string", start, self.src.len()));
            };
            self.pos += c.len_utf8();
            if c == quote {
                if self.dialect == Dialect::Excel && self.peek_char() == Some(quote) {
                    self.pos += 1;
                    s.push(quote);
                    continue;
                }
                return Ok(Tok::Str(s));
            }
            if c == '\\' && self.dialect != Dialect::Excel {
                let Some(n) = self.peek_char() else {
                    return Err(self.err("Unterminated string", start, self.src.len()));
                };
                self.pos += n.len_utf8();
                s.push(match n {
                    'n' => '\n',
                    't' => '\t',
                    other => other,
                });
                continue;
            }
            s.push(c);
        }
    }

    fn lex_number(&mut self) -> Result<Tok, ParseError> {
        let start = self.pos;
        while self.pos < self.b.len() && self.b[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
        if self.pos < self.b.len() && self.b[self.pos] == b'.' {
            self.pos += 1;
            while self.pos < self.b.len() && self.b[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
        }
        if self.pos < self.b.len() && (self.b[self.pos] == b'e' || self.b[self.pos] == b'E') {
            let save = self.pos;
            self.pos += 1;
            if self.pos < self.b.len() && (self.b[self.pos] == b'+' || self.b[self.pos] == b'-') {
                self.pos += 1;
            }
            let ds = self.pos;
            while self.pos < self.b.len() && self.b[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
            if ds == self.pos {
                self.pos = save;
            }
        }
        let text = &self.src[start..self.pos];
        match text.parse::<f64>() {
            Ok(x) if x.is_finite() => Ok(Tok::Num(x)),
            _ => Err(self.err("Invalid number", start, self.pos)),
        }
    }

    /// `1:3`, `$1:$3` → row range. Returns `None` (without consuming) if it is not one.
    fn try_row_range(&mut self, sheet: Option<SheetRef>) -> Option<Tok> {
        let save = self.pos;
        let read = |lx: &mut Lexer| -> Option<(u32, bool)> {
            let abs = lx.b.get(lx.pos) == Some(&b'$');
            if abs {
                lx.pos += 1;
            }
            let s = lx.pos;
            while lx.pos < lx.b.len() && lx.b[lx.pos].is_ascii_digit() {
                lx.pos += 1;
            }
            if s == lx.pos {
                return None;
            }
            let n: u32 = lx.src[s..lx.pos].parse().ok()?;
            (1..=MAX_ROWS).contains(&n).then(|| (n - 1, abs))
        };
        let r = (|| {
            let (r0, a0) = read(self)?;
            if self.b.get(self.pos) != Some(&b':') {
                return None;
            }
            self.pos += 1;
            let (r1, a1) = read(self)?;
            if self
                .peek_char()
                .is_some_and(|c| is_ident_char(c, Dialect::Excel) || c == '(')
            {
                return None;
            }
            Some(Tok::Ref(Reference {
                sheet: sheet.clone(),
                target: RefTarget::Rows {
                    r0,
                    r1,
                    abs0: a0,
                    abs1: a1,
                },
            }))
        })();
        if r.is_none() {
            self.pos = save;
        }
        r
    }

    fn lex_error_or_hash(&mut self) -> Tok {
        let rest = &self.src[self.pos..];
        let mut best: Option<(ErrorKind, usize)> = None;
        for e in ErrorKind::ALL {
            let s = e.as_str();
            if rest.len() >= s.len()
                && rest.is_char_boundary(s.len())
                && rest[..s.len()].eq_ignore_ascii_case(s)
                && best.is_none_or(|(_, l)| s.len() > l)
            {
                best = Some((e, s.len()));
            }
        }
        if let Some((e, l)) = best {
            self.pos += l;
            return Tok::Err(e);
        }
        self.pos += 1;
        Tok::Op(Op::Hash)
    }

    fn lex_quoted_sheet(&mut self) -> Result<Tok, ParseError> {
        let start = self.pos;
        self.pos += 1;
        let mut name = String::new();
        loop {
            let Some(c) = self.peek_char() else {
                return Err(self.err("Unterminated sheet name", start, self.src.len()));
            };
            self.pos += c.len_utf8();
            if c == '\'' {
                if self.peek_char() == Some('\'') {
                    self.pos += 1;
                    name.push('\'');
                    continue;
                }
                break;
            }
            name.push(c);
        }
        if name.starts_with('[') {
            return Err(self.err(
                "External workbook references are not supported",
                start,
                self.pos,
            ));
        }
        if self.peek_char() != Some('!') {
            return Err(self.err("Expected ! after sheet name", start, self.pos));
        }
        if name.contains(':') {
            return Err(self.err("3-D references are not supported yet", start, self.pos));
        }
        self.pos += 1;
        self.lex_ref_after_sheet(SheetRef::Named(name), start)
    }

    fn scan_run(&mut self) -> &'a str {
        let s = self.pos;
        while let Some(c) = self.peek_char() {
            if is_ident_char(c, self.dialect) {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
        &self.src[s..self.pos]
    }

    fn lex_ref_after_sheet(&mut self, sheet: SheetRef, start: usize) -> Result<Tok, ParseError> {
        if self.src[self.pos..].len() >= 5
            && self.src[self.pos..self.pos + 5].eq_ignore_ascii_case("#REF!")
        {
            self.pos += 5;
            return Ok(Tok::Ref(Reference {
                sheet: Some(sheet),
                target: RefTarget::Invalid,
            }));
        }
        if self
            .peek_char()
            .is_some_and(|c| c.is_ascii_digit() || c == '$')
            && let Some(t) = self.try_row_range(Some(sheet.clone()))
        {
            return Ok(t);
        }
        let run_start = self.pos;
        let run = self.scan_run();
        if let Some(t) = self.classify_ref_run(run, run_start, Some(sheet))? {
            return Ok(t);
        }
        Err(self.err(
            "Expected a cell reference after the sheet name",
            start,
            self.pos,
        ))
    }

    /// Try to read `:B2` / `:C` after a reference start.
    fn classify_ref_run(
        &mut self,
        run: &str,
        run_start: usize,
        sheet: Option<SheetRef>,
    ) -> Result<Option<Tok>, ParseError> {
        if let Some((r, c, ra, ca)) = parse_a1_parts(run) {
            let a = CellRef {
                row: r,
                col: c,
                row_abs: ra,
                col_abs: ca,
            };
            // Area?
            if self.peek_char() == Some(':') {
                let save = self.pos;
                self.pos += 1;
                let r2 = self.scan_run();
                if let Some((r1, c1, ra1, ca1)) = parse_a1_parts(r2) {
                    if self.peek_char() == Some('(') {
                        self.pos = save;
                    } else {
                        let b = CellRef {
                            row: r1,
                            col: c1,
                            row_abs: ra1,
                            col_abs: ca1,
                        };
                        return Ok(Some(Tok::Ref(Reference {
                            sheet,
                            target: RefTarget::Area(a, b),
                        })));
                    }
                } else {
                    self.pos = save;
                }
            }
            return Ok(Some(Tok::Ref(Reference {
                sheet,
                target: RefTarget::Cell(a),
            })));
        }
        // Column range A:C
        let col_part = |s: &str| -> Option<(u32, bool)> {
            let (abs, letters) = match s.strip_prefix('$') {
                Some(l) => (true, l),
                None => (false, s),
            };
            if letters.is_empty() || !letters.bytes().all(|b| b.is_ascii_alphabetic()) {
                return None;
            }
            letters_to_col(letters)
                .filter(|c| *c < MAX_COLS)
                .map(|c| (c, abs))
        };
        if let Some((c0, a0)) = col_part(run)
            && self.peek_char() == Some(':')
        {
            let save = self.pos;
            self.pos += 1;
            let r2 = self.scan_run();
            if let Some((c1, a1)) = col_part(r2)
                && self.peek_char() != Some('(')
            {
                if self.peek_char() == Some('!') {
                    return Err(self.err(
                        "3-D references are not supported yet",
                        run_start,
                        self.pos,
                    ));
                }
                return Ok(Some(Tok::Ref(Reference {
                    sheet,
                    target: RefTarget::Cols {
                        c0,
                        c1,
                        abs0: a0,
                        abs1: a1,
                    },
                })));
            }
            self.pos = save;
        }
        Ok(None)
    }

    fn lex_word(&mut self) -> Result<Tok, ParseError> {
        let start = self.pos;
        let run = self.scan_run();
        if run.is_empty() {
            let c = self.peek_char().unwrap_or('?');
            return Err(self.err(
                format!("Unexpected character '{c}'"),
                start,
                start + c.len_utf8(),
            ));
        }
        if self.dialect != Dialect::Excel {
            if self.peek_char() == Some('(') {
                return Ok(Tok::Func(run.to_string()));
            }
            return Ok(match run {
                "true" | "TRUE" | "True" => Tok::Bool(true),
                "false" | "FALSE" | "False" => Tok::Bool(false),
                _ => Tok::Ident(run.to_string()),
            });
        }
        // Excel dialect.
        if self.peek_char() == Some('!') {
            self.pos += 1;
            return self.lex_ref_after_sheet(SheetRef::Named(run.to_string()), start);
        }
        if self.peek_char() == Some('[') {
            return Err(self.err(
                "External and structured references are not supported",
                start,
                self.pos + 1,
            ));
        }
        if self.peek_char() == Some('(') {
            return Ok(Tok::Func(normalize_function_name(run)));
        }
        if let Some(t) = self.classify_ref_run(run, start, None)? {
            return Ok(t);
        }
        if run.eq_ignore_ascii_case("TRUE") {
            return Ok(Tok::Bool(true));
        }
        if run.eq_ignore_ascii_case("FALSE") {
            return Ok(Tok::Bool(false));
        }
        if run.contains('$') {
            return Err(self.err("Invalid reference", start, self.pos));
        }
        Ok(Tok::Ident(run.to_string()))
    }

    fn lex_op(&mut self) -> Result<Tok, ParseError> {
        let start = self.pos;
        let two = self.src.get(self.pos..self.pos + 2).unwrap_or("");
        let excel = self.dialect == Dialect::Excel;
        let (op, len) = match two {
            "<>" if excel => (Op::Ne, 2),
            "<=" => (Op::Le, 2),
            ">=" => (Op::Ge, 2),
            "==" if !excel => (Op::EqEq, 2),
            "!=" if !excel => (Op::Ne, 2),
            "&&" if !excel => (Op::AndAnd, 2),
            "||" if !excel => (Op::OrOr, 2),
            _ => {
                let c = self.peek_char().unwrap_or('\0');
                let op = match c {
                    '+' => Op::Plus,
                    '-' => Op::Minus,
                    '*' => Op::Star,
                    '/' => Op::Slash,
                    '^' => Op::Caret,
                    '&' if excel => Op::Amp,
                    '%' => Op::Percent,
                    '=' => Op::Eq,
                    '<' => Op::Lt,
                    '>' => Op::Gt,
                    '(' => Op::LParen,
                    ')' => Op::RParen,
                    '{' if excel => Op::LBrace,
                    '}' if excel => Op::RBrace,
                    '[' if !excel => Op::LBracket,
                    ']' if !excel => Op::RBracket,
                    '[' => {
                        return Err(self.err(
                            "External and structured references are not supported",
                            start,
                            start + 1,
                        ));
                    }
                    ',' => Op::Comma,
                    ';' => Op::Semi,
                    ':' => Op::Colon,
                    '@' if excel => Op::At,
                    '!' if !excel => Op::Bang,
                    '?' if !excel => Op::Question,
                    '.' if !excel => Op::Dot,
                    other => {
                        return Err(self.err(
                            format!("Unexpected character '{other}'"),
                            start,
                            start + other.len_utf8(),
                        ));
                    }
                };
                (op, c.len_utf8())
            }
        };
        self.pos += len;
        Ok(Tok::Op(op))
    }
}

/// Upper-case a function name and strip `_xlfn.`, `_xlws.` and `_xludf.` prefixes.
pub fn normalize_function_name(name: &str) -> String {
    let mut up = name.to_uppercase();
    loop {
        let before = up.len();
        for p in ["_XLFN.", "_XLWS.", "_XLUDF.", "_XLPM."] {
            if let Some(rest) = up.strip_prefix(p) {
                up = rest.to_string();
            }
        }
        if up.len() == before {
            break;
        }
    }
    up
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(s: &str) -> Vec<Tok> {
        tokenize(s, Dialect::Excel)
            .map(|v| v.into_iter().map(|t| t.tok).collect())
            .unwrap_or_default()
    }

    #[test]
    fn references() {
        let t = kinds("Sheet2!$A$1:B3");
        assert!(
            matches!(&t[0], Tok::Ref(Reference { sheet: Some(SheetRef::Named(n)), target: RefTarget::Area(..) }) if n == "Sheet2")
        );
        let t = kinds("'My Sheet'!A1");
        assert!(
            matches!(&t[0], Tok::Ref(Reference { sheet: Some(SheetRef::Named(n)), target: RefTarget::Cell(_) }) if n == "My Sheet")
        );
        assert!(matches!(
            &kinds("A:A")[0],
            Tok::Ref(Reference {
                target: RefTarget::Cols { c0: 0, c1: 0, .. },
                ..
            })
        ));
        assert!(matches!(
            &kinds("1:1")[0],
            Tok::Ref(Reference {
                target: RefTarget::Rows { r0: 0, r1: 0, .. },
                ..
            })
        ));
        assert!(matches!(
            &kinds("$2:$5")[0],
            Tok::Ref(Reference {
                target: RefTarget::Rows {
                    r0: 1,
                    r1: 4,
                    abs0: true,
                    abs1: true
                },
                ..
            })
        ));
        assert!(matches!(&kinds("SUM(")[0], Tok::Func(n) if n == "SUM"));
        assert!(matches!(&kinds("_xlfn.XLOOKUP(")[0], Tok::Func(n) if n == "XLOOKUP"));
        assert!(matches!(&kinds("Revenue")[0], Tok::Ident(n) if n == "Revenue"));
        assert!(matches!(&kinds("#DIV/0!")[0], Tok::Err(ErrorKind::Div0)));
        assert!(matches!(&kinds("#N/A")[0], Tok::Err(ErrorKind::NA)));
        assert!(matches!(&kinds("A1#")[1], Tok::Op(Op::Hash)));
    }

    #[test]
    fn rejects() {
        assert!(tokenize("[Book1]Sheet1!A1", Dialect::Excel).is_err());
        assert!(tokenize("'[Book1]Sheet1'!A1", Dialect::Excel).is_err());
        assert!(tokenize("Jan:Mar!A1", Dialect::Excel).is_err());
        assert!(tokenize("\"abc", Dialect::Excel).is_err());
    }

    #[test]
    fn row_dialect() {
        let t: Vec<Tok> = tokenize("prop(\"A\") == 1 /* c */ && !x", Dialect::Row)
            .map(|v| v.into_iter().map(|t| t.tok).collect())
            .unwrap_or_default();
        assert_eq!(t[0], Tok::Func("prop".into()));
        assert!(t.contains(&Tok::Op(Op::EqEq)));
        assert!(t.contains(&Tok::Op(Op::AndAnd)));
        assert!(!t.contains(&Tok::Ws));
    }
}
