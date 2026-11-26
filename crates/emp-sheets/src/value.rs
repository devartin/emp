//! The value model (SPEC §14.1): numbers, text, booleans, errors and arrays, plus Excel coercion and ordering.

use crate::limits::MAX_TEXT_LEN;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fmt;
use std::sync::Arc;

/// Spreadsheet error values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ErrorKind {
    /// `#NULL!` — empty intersection.
    #[serde(rename = "#NULL!")]
    Null,
    /// `#DIV/0!`
    #[serde(rename = "#DIV/0!")]
    Div0,
    /// `#VALUE!`
    #[serde(rename = "#VALUE!")]
    Value,
    /// `#REF!`
    #[serde(rename = "#REF!")]
    Ref,
    /// `#NAME?`
    #[serde(rename = "#NAME?")]
    Name,
    /// `#NUM!`
    #[serde(rename = "#NUM!")]
    Num,
    /// `#N/A`
    #[serde(rename = "#N/A")]
    NA,
    /// `#SPILL!`
    #[serde(rename = "#SPILL!")]
    Spill,
    /// `#CALC!`
    #[serde(rename = "#CALC!")]
    Calc,
    /// `#CIRC!` — EMP: member of a circular reference.
    #[serde(rename = "#CIRC!")]
    Circ,
    /// `#FETCH!` — EMP: external data (STOCK/FX/CRYPTO) still loading.
    #[serde(rename = "#FETCH!")]
    Fetch,
}

impl ErrorKind {
    /// All error kinds.
    pub const ALL: [ErrorKind; 11] = [
        ErrorKind::Null,
        ErrorKind::Div0,
        ErrorKind::Value,
        ErrorKind::Ref,
        ErrorKind::Name,
        ErrorKind::Num,
        ErrorKind::NA,
        ErrorKind::Spill,
        ErrorKind::Calc,
        ErrorKind::Circ,
        ErrorKind::Fetch,
    ];

    /// Display text (`#DIV/0!`).
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Null => "#NULL!",
            ErrorKind::Div0 => "#DIV/0!",
            ErrorKind::Value => "#VALUE!",
            ErrorKind::Ref => "#REF!",
            ErrorKind::Name => "#NAME?",
            ErrorKind::Num => "#NUM!",
            ErrorKind::NA => "#N/A",
            ErrorKind::Spill => "#SPILL!",
            ErrorKind::Calc => "#CALC!",
            ErrorKind::Circ => "#CIRC!",
            ErrorKind::Fetch => "#FETCH!",
        }
    }

    /// Parse an error literal (case-insensitive). Accepts `#FETCH` and `#CIRC` without the bang.
    pub fn parse(s: &str) -> Option<ErrorKind> {
        let up = s.trim().to_ascii_uppercase();
        let e = match up.as_str() {
            "#NULL!" => ErrorKind::Null,
            "#DIV/0!" => ErrorKind::Div0,
            "#VALUE!" => ErrorKind::Value,
            "#REF!" => ErrorKind::Ref,
            "#NAME?" => ErrorKind::Name,
            "#NUM!" => ErrorKind::Num,
            "#N/A" => ErrorKind::NA,
            "#SPILL!" => ErrorKind::Spill,
            "#CALC!" => ErrorKind::Calc,
            "#CIRC!" | "#CIRC" => ErrorKind::Circ,
            "#FETCH!" | "#FETCH" | "#GETTING_DATA" | "#BUSY!" => ErrorKind::Fetch,
            _ => return None,
        };
        Some(e)
    }

    /// `ERROR.TYPE` code.
    pub fn type_code(self) -> f64 {
        match self {
            ErrorKind::Null => 1.0,
            ErrorKind::Div0 => 2.0,
            ErrorKind::Value => 3.0,
            ErrorKind::Ref => 4.0,
            ErrorKind::Name => 5.0,
            ErrorKind::Num => 6.0,
            ErrorKind::NA => 7.0,
            ErrorKind::Fetch => 8.0,
            ErrorKind::Spill => 9.0,
            ErrorKind::Calc => 14.0,
            ErrorKind::Circ => 15.0,
        }
    }

    /// Human-readable explanation, used by `sheet_get_cell.error`.
    pub fn describe(self) -> &'static str {
        match self {
            ErrorKind::Null => "The ranges do not intersect.",
            ErrorKind::Div0 => "Division by zero.",
            ErrorKind::Value => "A value has the wrong type.",
            ErrorKind::Ref => "The reference is not valid.",
            ErrorKind::Name => "Unknown function or name.",
            ErrorKind::Num => "The number is not valid for this calculation.",
            ErrorKind::NA => "No value is available.",
            ErrorKind::Spill => "The spill range is not empty.",
            ErrorKind::Calc => "The calculation could not be completed.",
            ErrorKind::Circ => "Circular reference.",
            ErrorKind::Fetch => "Loading data…",
        }
    }
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A two-dimensional array value, stored row-major. Elements are never arrays themselves.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Array {
    rows: usize,
    cols: usize,
    data: Vec<Value>,
}

impl Array {
    /// Build an array; `data.len()` must equal `rows * cols` (otherwise it is padded/truncated with `#N/A`).
    pub fn new(rows: usize, cols: usize, mut data: Vec<Value>) -> Array {
        let rows = rows.max(1);
        let cols = cols.max(1);
        data.resize(rows * cols, Value::Error(ErrorKind::NA));
        for v in data.iter_mut() {
            if let Value::Array(a) = v {
                *v = a.get(0, 0).clone();
            }
        }
        Array { rows, cols, data }
    }
    /// Build from rows of values (ragged rows are padded with `#N/A`).
    pub fn from_rows(rows: Vec<Vec<Value>>) -> Array {
        let r = rows.len();
        let c = rows.iter().map(|x| x.len()).max().unwrap_or(1);
        let mut data = Vec::with_capacity(r * c);
        for mut row in rows {
            row.resize(c, Value::Error(ErrorKind::NA));
            data.extend(row);
        }
        Array::new(r, c, data)
    }
    /// A filled array.
    pub fn filled(rows: usize, cols: usize, v: Value) -> Array {
        Array::new(rows, cols, vec![v; rows.max(1) * cols.max(1)])
    }
    /// Number of rows.
    pub fn rows(&self) -> usize {
        self.rows
    }
    /// Number of columns.
    pub fn cols(&self) -> usize {
        self.cols
    }
    /// Element at `(r, c)`; out of range gives `#N/A`.
    pub fn get(&self, r: usize, c: usize) -> &Value {
        static NA: Value = Value::Error(ErrorKind::NA);
        if r < self.rows && c < self.cols {
            &self.data[r * self.cols + c]
        } else {
            &NA
        }
    }
    /// Element with Excel broadcasting: a single row/column is repeated.
    pub fn get_broadcast(&self, r: usize, c: usize) -> &Value {
        let rr = if self.rows == 1 { 0 } else { r };
        let cc = if self.cols == 1 { 0 } else { c };
        self.get(rr, cc)
    }
    /// Row-major data.
    pub fn data(&self) -> &[Value] {
        &self.data
    }
    /// Consume into row-major data.
    pub fn into_data(self) -> Vec<Value> {
        self.data
    }
    /// One row as a vector.
    pub fn row(&self, r: usize) -> Vec<Value> {
        (0..self.cols).map(|c| self.get(r, c).clone()).collect()
    }
    /// One column as a vector.
    pub fn col(&self, c: usize) -> Vec<Value> {
        (0..self.rows).map(|r| self.get(r, c).clone()).collect()
    }
    /// Transposed copy.
    pub fn transpose(&self) -> Array {
        let mut data = Vec::with_capacity(self.data.len());
        for c in 0..self.cols {
            for r in 0..self.rows {
                data.push(self.get(r, c).clone());
            }
        }
        Array::new(self.cols, self.rows, data)
    }
    /// Map every element.
    pub fn map(&self, mut f: impl FnMut(&Value) -> Value) -> Array {
        Array::new(self.rows, self.cols, self.data.iter().map(&mut f).collect())
    }
    /// Total number of elements.
    pub fn len(&self) -> usize {
        self.data.len()
    }
    /// Arrays are never empty (minimum 1×1), provided for API symmetry.
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

/// A cell or intermediate value.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum Value {
    /// Blank.
    #[default]
    #[serde(rename = "0")]
    Empty,
    /// Finite IEEE double.
    #[serde(rename = "n")]
    Number(f64),
    /// Text (≤ 32,767 characters).
    #[serde(rename = "s")]
    Text(Arc<str>),
    /// Logical.
    #[serde(rename = "b")]
    Bool(bool),
    /// Error.
    #[serde(rename = "e")]
    Error(ErrorKind),
    /// Dynamic array.
    #[serde(rename = "a")]
    Array(Arc<Array>),
}

impl PartialEq for Value {
    fn eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Empty, Value::Empty) => true,
            (Value::Number(a), Value::Number(b)) => a == b || (a.is_nan() && b.is_nan()),
            (Value::Text(a), Value::Text(b)) => a == b,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Error(a), Value::Error(b)) => a == b,
            (Value::Array(a), Value::Array(b)) => a == b,
            _ => false,
        }
    }
}

impl From<f64> for Value {
    fn from(x: f64) -> Value {
        Value::number(x)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}
impl From<&str> for Value {
    fn from(s: &str) -> Value {
        Value::text(s)
    }
}
impl From<String> for Value {
    fn from(s: String) -> Value {
        Value::text(s)
    }
}
impl From<ErrorKind> for Value {
    fn from(e: ErrorKind) -> Value {
        Value::Error(e)
    }
}
impl From<Array> for Value {
    fn from(a: Array) -> Value {
        Value::array(a)
    }
}

impl Value {
    /// A number; NaN and infinities become `#NUM!`. `-0` is normalised to `0`.
    pub fn number(x: f64) -> Value {
        if x.is_finite() {
            Value::Number(if x == 0.0 { 0.0 } else { x })
        } else {
            Value::Error(ErrorKind::Num)
        }
    }
    /// Text; results longer than 32,767 characters become `#VALUE!` (§9.17).
    pub fn text(s: impl AsRef<str>) -> Value {
        let s = s.as_ref();
        if s.len() > MAX_TEXT_LEN && s.chars().count() > MAX_TEXT_LEN {
            Value::Error(ErrorKind::Value)
        } else {
            Value::Text(Arc::from(s))
        }
    }
    /// Wrap an array; a 1×1 array collapses to its element.
    pub fn array(a: Array) -> Value {
        if a.rows() == 1 && a.cols() == 1 {
            a.get(0, 0).clone()
        } else {
            Value::Array(Arc::new(a))
        }
    }
    /// Is this the blank value?
    pub fn is_empty(&self) -> bool {
        matches!(self, Value::Empty)
    }
    /// Is this an error?
    pub fn is_error(&self) -> bool {
        matches!(self, Value::Error(_))
    }
    /// The error kind, when this is an error.
    pub fn as_error(&self) -> Option<ErrorKind> {
        match self {
            Value::Error(e) => Some(*e),
            _ => None,
        }
    }
    /// Top-left element for arrays, the value itself otherwise.
    pub fn scalar(&self) -> &Value {
        match self {
            Value::Array(a) => a.get(0, 0),
            v => v,
        }
    }

    /// Excel number coercion (1900 date system for date-like text).
    pub fn coerce_number(&self) -> Result<f64, ErrorKind> {
        coerce_number_with(self, false)
    }

    /// Excel text coercion.
    pub fn coerce_text(&self) -> Result<String, ErrorKind> {
        match self {
            Value::Empty => Ok(String::new()),
            Value::Number(n) => Ok(number_to_text(*n)),
            Value::Text(s) => Ok(s.to_string()),
            Value::Bool(b) => Ok(if *b { "TRUE" } else { "FALSE" }.to_string()),
            Value::Error(e) => Err(*e),
            Value::Array(a) => a.get(0, 0).coerce_text(),
        }
    }

    /// Excel boolean coercion: numbers are `≠ 0`, text must be `TRUE`/`FALSE`.
    pub fn coerce_bool(&self) -> Result<bool, ErrorKind> {
        match self {
            Value::Empty => Ok(false),
            Value::Number(n) => Ok(*n != 0.0),
            Value::Bool(b) => Ok(*b),
            Value::Text(s) => match s.trim().to_ascii_uppercase().as_str() {
                "TRUE" => Ok(true),
                "FALSE" => Ok(false),
                _ => Err(ErrorKind::Value),
            },
            Value::Error(e) => Err(*e),
            Value::Array(a) => a.get(0, 0).coerce_bool(),
        }
    }

    /// `TYPE()` code: 1 number, 2 text, 4 logical, 16 error, 64 array.
    pub fn type_code(&self) -> f64 {
        match self {
            Value::Empty | Value::Number(_) => 1.0,
            Value::Text(_) => 2.0,
            Value::Bool(_) => 4.0,
            Value::Error(_) => 16.0,
            Value::Array(_) => 64.0,
        }
    }

    /// Text shown when the value is rendered without a number format (General).
    pub fn display(&self) -> String {
        match self {
            Value::Empty => String::new(),
            Value::Number(n) => number_to_text(*n),
            Value::Text(s) => s.to_string(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Value::Error(e) => e.as_str().to_string(),
            Value::Array(a) => a.get(0, 0).display(),
        }
    }

    /// Ordering rank used for mixed-type comparison: number < text < bool (errors last).
    fn rank(&self) -> u8 {
        match self {
            Value::Empty | Value::Number(_) => 0,
            Value::Text(_) => 1,
            Value::Bool(_) => 2,
            Value::Error(_) => 3,
            Value::Array(_) => 4,
        }
    }
}

/// Number coercion with an explicit date system for date-like text.
pub fn coerce_number_with(v: &Value, date1904: bool) -> Result<f64, ErrorKind> {
    match v {
        Value::Empty => Ok(0.0),
        Value::Number(n) => Ok(*n),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Text(s) => parse_number_text(s)
            .or_else(|| crate::datetime::parse_datetime_text(s, date1904))
            .ok_or(ErrorKind::Value),
        Value::Error(e) => Err(*e),
        Value::Array(a) => coerce_number_with(a.get(0, 0), date1904),
    }
}

/// Parse numeric text the way Excel's implicit conversion does:
/// `"1"`, `" 1,234.5 "`, `"1e3"`, `"50%"`, `"$12"`, `"(5)"`, `"-$1,000.25"`.
pub fn parse_number_text(s: &str) -> Option<f64> {
    let mut t = s.trim();
    if t.is_empty() {
        return None;
    }
    let mut neg = false;
    if t.starts_with('(') && t.ends_with(')') {
        neg = true;
        t = t[1..t.len() - 1].trim();
    }
    if let Some(rest) = t.strip_prefix('-') {
        neg = !neg;
        t = rest.trim_start();
    } else if let Some(rest) = t.strip_prefix('+') {
        t = rest.trim_start();
    }
    for cur in ["$", "€", "£", "¥"] {
        if let Some(rest) = t.strip_prefix(cur) {
            t = rest.trim_start();
            break;
        }
        if let Some(rest) = t.strip_suffix(cur) {
            t = rest.trim_end();
            break;
        }
    }
    if !neg && let Some(rest) = t.strip_prefix('-') {
        neg = true;
        t = rest.trim_start();
    }
    let mut pct = 0;
    while let Some(rest) = t.strip_suffix('%') {
        pct += 1;
        t = rest.trim_end();
    }
    if t.is_empty() {
        return None;
    }
    // Validate thousands separators: groups of exactly 3 digits after the first comma.
    let (int_part, rest) = match t.find(['.', 'e', 'E']) {
        Some(i) => (&t[..i], &t[i..]),
        None => (t, ""),
    };
    let int_clean: String = if int_part.contains(',') {
        let mut groups = int_part.split(',');
        let first = groups.next()?;
        if first.is_empty() || first.len() > 3 || !first.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let mut s = first.to_string();
        for g in groups {
            if g.len() != 3 || !g.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            s.push_str(g);
        }
        s
    } else {
        int_part.to_string()
    };
    let candidate = format!("{int_clean}{rest}");
    if !candidate
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return None;
    }
    if !candidate.bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    // Rust's parser accepts "inf"/"nan"; the byte filter above rules those out.
    let mut x: f64 = candidate.parse().ok()?;
    for _ in 0..pct {
        x /= 100.0;
    }
    if neg {
        x = -x;
    }
    x.is_finite().then_some(x)
}

/// Round to 15 significant digits (Excel display precision).
pub fn round_sig15(x: f64) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x;
    }
    let s = format!("{:.14e}", x);
    s.parse().unwrap_or(x)
}

/// Excel's number → text conversion (General format, 15 significant digits).
pub fn number_to_text(x: f64) -> String {
    if !x.is_finite() {
        return ErrorKind::Num.as_str().to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let s = format!("{:.14e}", x);
    let (mant, exp) = match s.split_once('e') {
        Some(p) => p,
        None => return s,
    };
    let exp: i32 = exp.parse().unwrap_or(0);
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let nd = digits.len() as i32;
    let sign = if neg { "-" } else { "" };
    let sci = !(-9..15).contains(&exp) || (exp < 0 && (-exp - 1 + nd) > 15 + 4);
    if sci {
        let mut m = digits[..1].to_string();
        if nd > 1 {
            m.push('.');
            m.push_str(&digits[1..]);
        }
        let es = if exp < 0 { '-' } else { '+' };
        return format!("{sign}{m}E{es}{:02}", exp.abs());
    }
    if exp >= 0 {
        let int_len = (exp + 1) as usize;
        if digits.len() <= int_len {
            format!("{sign}{}{}", digits, "0".repeat(int_len - digits.len()))
        } else {
            format!("{sign}{}.{}", &digits[..int_len], &digits[int_len..])
        }
    } else {
        format!("{sign}0.{}{}", "0".repeat((-exp - 1) as usize), digits)
    }
}

/// Case-insensitive text comparison (Unicode lowercase).
pub fn cmp_text_ci(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        let mut ai = a.bytes().map(|c| c.to_ascii_lowercase());
        let mut bi = b.bytes().map(|c| c.to_ascii_lowercase());
        loop {
            match (ai.next(), bi.next()) {
                (None, None) => return Ordering::Equal,
                (None, Some(_)) => return Ordering::Less,
                (Some(_), None) => return Ordering::Greater,
                (Some(x), Some(y)) => match x.cmp(&y) {
                    Ordering::Equal => continue,
                    o => return o,
                },
            }
        }
    }
    a.to_lowercase().cmp(&b.to_lowercase())
}

/// Case-insensitive text equality.
pub fn eq_text_ci(a: &str, b: &str) -> bool {
    cmp_text_ci(a, b) == Ordering::Equal
}

/// Excel comparison for the `= <> < > <= >=` operators. Blanks compare as `0`, `""` or `FALSE`
/// depending on the other side. Errors must be handled by the caller.
pub fn compare_values(a: &Value, b: &Value) -> Ordering {
    let a = a.scalar();
    let b = b.scalar();
    match (a, b) {
        (Value::Empty, Value::Empty) => Ordering::Equal,
        (Value::Empty, Value::Number(y)) => 0.0f64.partial_cmp(y).unwrap_or(Ordering::Equal),
        (Value::Number(x), Value::Empty) => x.partial_cmp(&0.0).unwrap_or(Ordering::Equal),
        (Value::Empty, Value::Text(t)) => cmp_text_ci("", t),
        (Value::Text(t), Value::Empty) => cmp_text_ci(t, ""),
        (Value::Empty, Value::Bool(y)) => false.cmp(y),
        (Value::Bool(x), Value::Empty) => x.cmp(&false),
        (Value::Number(x), Value::Number(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (Value::Text(x), Value::Text(y)) => cmp_text_ci(x, y),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Error(x), Value::Error(y)) => x
            .type_code()
            .partial_cmp(&y.type_code())
            .unwrap_or(Ordering::Equal),
        _ => a.rank().cmp(&b.rank()),
    }
}

/// Sort ordering used by `SORT`, `SORTBY` and sorting ranges: numbers < text < bool < errors < blanks.
pub fn sort_cmp(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Empty, Value::Empty) => Ordering::Equal,
        (Value::Empty, _) => Ordering::Greater,
        (_, Value::Empty) => Ordering::Less,
        _ => compare_values(a, b),
    }
}

/// Exact-match equality used by lookups (`MATCH` type 0, `XLOOKUP`): same type, text case-insensitive.
pub fn lookup_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::Text(x), Value::Text(y)) => eq_text_ci(x, y),
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Empty, Value::Empty) => true,
        (Value::Error(x), Value::Error(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_text() {
        assert_eq!(number_to_text(1.0), "1");
        assert_eq!(number_to_text(-2.5), "-2.5");
        assert_eq!(number_to_text(0.1 + 0.2), "0.3");
        assert_eq!(number_to_text(1.0 / 3.0), "0.333333333333333");
        assert_eq!(number_to_text(123456789012345.0), "123456789012345");
        assert_eq!(number_to_text(1234567890123456.0), "1.23456789012346E+15");
        assert_eq!(number_to_text(1e15), "1E+15");
        assert_eq!(number_to_text(0.0001), "0.0001");
        assert_eq!(number_to_text(1e-10), "1E-10");
        assert_eq!(number_to_text(100.0), "100");
        assert_eq!(number_to_text(-0.0), "0");
    }

    #[test]
    fn parse_numbers() {
        assert_eq!(parse_number_text(" 1 "), Some(1.0));
        assert_eq!(parse_number_text("1,234.5"), Some(1234.5));
        assert_eq!(parse_number_text("1,23"), None);
        assert_eq!(parse_number_text("50%"), Some(0.5));
        assert_eq!(parse_number_text("$12"), Some(12.0));
        assert_eq!(parse_number_text("-$1,000.25"), Some(-1000.25));
        assert_eq!(parse_number_text("(5)"), Some(-5.0));
        assert_eq!(parse_number_text("1e3"), Some(1000.0));
        assert_eq!(parse_number_text(".5"), Some(0.5));
        assert_eq!(parse_number_text("abc"), None);
        assert_eq!(parse_number_text("inf"), None);
        assert_eq!(parse_number_text("nan"), None);
        assert_eq!(parse_number_text(""), None);
        assert_eq!(parse_number_text("."), None);
    }

    #[test]
    fn coercion() {
        assert_eq!(Value::text("1").coerce_number(), Ok(1.0));
        assert_eq!(Value::Bool(true).coerce_number(), Ok(1.0));
        assert_eq!(Value::text("x").coerce_number(), Err(ErrorKind::Value));
        assert_eq!(Value::text("true").coerce_bool(), Ok(true));
        assert_eq!(Value::Number(0.0).coerce_bool(), Ok(false));
        assert_eq!(Value::Number(f64::NAN), Value::Number(f64::NAN));
        assert_eq!(Value::number(f64::INFINITY), Value::Error(ErrorKind::Num));
        assert_eq!(
            Value::text("x".repeat(32_768)),
            Value::Error(ErrorKind::Value)
        );
    }

    #[test]
    fn ordering() {
        assert_eq!(
            compare_values(&Value::Number(5.0), &Value::text("a")),
            Ordering::Less
        );
        assert_eq!(
            compare_values(&Value::text("z"), &Value::Bool(false)),
            Ordering::Less
        );
        assert_eq!(
            compare_values(&Value::text("ABC"), &Value::text("abc")),
            Ordering::Equal
        );
        assert_eq!(
            compare_values(&Value::Empty, &Value::Number(0.0)),
            Ordering::Equal
        );
        assert_eq!(
            compare_values(&Value::Empty, &Value::text("")),
            Ordering::Equal
        );
        assert_eq!(
            sort_cmp(&Value::Empty, &Value::Number(1.0)),
            Ordering::Greater
        );
    }

    #[test]
    fn serde_roundtrip() {
        let v = Value::array(Array::from_rows(vec![
            vec![Value::Number(1.0), Value::text("a")],
            vec![Value::Bool(true), Value::Error(ErrorKind::NA)],
        ]));
        let s = serde_json::to_string(&v).unwrap_or_default();
        let back: Value = serde_json::from_str(&s).unwrap_or_default();
        assert_eq!(v, back);
        assert!(s.contains("#N/A"));
    }
}
