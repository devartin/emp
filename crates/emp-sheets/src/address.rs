//! A1 addressing: column letters, cell keys, rectangles and sheet-name quoting (SPEC §14.1).

use crate::limits::{MAX_COLS, MAX_ROWS, MAX_SHEET_NAME_LEN};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable identifier of a sheet inside a workbook (never reused while the workbook lives).
pub type SheetId = u16;

/// Packs `(sheet u16, row u32, col u16)` into one `u64` (§14.1).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct CellKey(pub u64);

impl CellKey {
    /// Build a key from its parts. `row` and `col` are 0-based.
    #[inline]
    pub fn new(sheet: SheetId, row: u32, col: u32) -> Self {
        CellKey(((sheet as u64) << 48) | ((row as u64) << 16) | (col as u64 & 0xFFFF))
    }
    /// Sheet part.
    #[inline]
    pub fn sheet(self) -> SheetId {
        (self.0 >> 48) as u16
    }
    /// 0-based row.
    #[inline]
    pub fn row(self) -> u32 {
        ((self.0 >> 16) & 0xFFFF_FFFF) as u32
    }
    /// 0-based column.
    #[inline]
    pub fn col(self) -> u32 {
        (self.0 & 0xFFFF) as u32
    }
}

impl fmt::Debug for CellKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "#{}!{}", self.sheet(), format_a1(self.row(), self.col()))
    }
}

/// Inclusive, 0-based rectangle (IPC `Rect`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Rect {
    /// First row.
    pub r0: u32,
    /// First column.
    pub c0: u32,
    /// Last row (inclusive).
    pub r1: u32,
    /// Last column (inclusive).
    pub c1: u32,
}

impl Rect {
    /// Normalising constructor (swaps corners if needed).
    pub fn new(r0: u32, c0: u32, r1: u32, c1: u32) -> Self {
        Rect {
            r0: r0.min(r1),
            c0: c0.min(c1),
            r1: r0.max(r1),
            c1: c0.max(c1),
        }
    }
    /// A 1×1 rectangle.
    pub fn cell(r: u32, c: u32) -> Self {
        Rect {
            r0: r,
            c0: c,
            r1: r,
            c1: c,
        }
    }
    /// Whole grid.
    pub fn all() -> Self {
        Rect {
            r0: 0,
            c0: 0,
            r1: MAX_ROWS - 1,
            c1: MAX_COLS - 1,
        }
    }
    /// Number of rows.
    pub fn rows(&self) -> u32 {
        self.r1 - self.r0 + 1
    }
    /// Number of columns.
    pub fn cols(&self) -> u32 {
        self.c1 - self.c0 + 1
    }
    /// Number of cells.
    pub fn area(&self) -> u64 {
        self.rows() as u64 * self.cols() as u64
    }
    /// Does the rectangle contain the cell?
    pub fn contains(&self, r: u32, c: u32) -> bool {
        r >= self.r0 && r <= self.r1 && c >= self.c0 && c <= self.c1
    }
    /// Do the rectangles overlap?
    pub fn intersects(&self, o: &Rect) -> bool {
        self.r0 <= o.r1 && o.r0 <= self.r1 && self.c0 <= o.c1 && o.c0 <= self.c1
    }
    /// Overlap of two rectangles.
    pub fn intersection(&self, o: &Rect) -> Option<Rect> {
        if !self.intersects(o) {
            return None;
        }
        Some(Rect {
            r0: self.r0.max(o.r0),
            c0: self.c0.max(o.c0),
            r1: self.r1.min(o.r1),
            c1: self.c1.min(o.c1),
        })
    }
    /// Smallest rectangle covering both.
    pub fn union(&self, o: &Rect) -> Rect {
        Rect {
            r0: self.r0.min(o.r0),
            c0: self.c0.min(o.c0),
            r1: self.r1.max(o.r1),
            c1: self.c1.max(o.c1),
        }
    }
}

/// Convert a 0-based column index to letters (`0 → A`, `26 → AA`).
pub fn col_to_letters(col: u32) -> String {
    let mut n = col + 1;
    let mut out = Vec::with_capacity(3);
    while n > 0 {
        let rem = (n - 1) % 26;
        out.push(b'A' + rem as u8);
        n = (n - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Convert column letters to a 0-based index. Returns `None` when out of the grid.
pub fn letters_to_col(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 3 {
        return None;
    }
    let mut n: u32 = 0;
    for b in s.bytes() {
        let up = b.to_ascii_uppercase();
        if !up.is_ascii_uppercase() {
            return None;
        }
        n = n * 26 + (up - b'A' + 1) as u32;
    }
    if n == 0 || n > MAX_COLS {
        return None;
    }
    Some(n - 1)
}

/// Format a 0-based cell as A1 (`(0,0) → "A1"`).
pub fn format_a1(row: u32, col: u32) -> String {
    format!("{}{}", col_to_letters(col), row + 1)
}

/// Format a rectangle as `A1` or `A1:B2`.
pub fn format_rect(r: &Rect) -> String {
    if r.r0 == r.r1 && r.c0 == r.c1 {
        format_a1(r.r0, r.c0)
    } else {
        format!("{}:{}", format_a1(r.r0, r.c0), format_a1(r.r1, r.c1))
    }
}

/// Parse a plain or `$`-anchored A1 cell reference. Returns `(row, col, row_abs, col_abs)`.
pub fn parse_a1_parts(s: &str) -> Option<(u32, u32, bool, bool)> {
    let b = s.as_bytes();
    let mut i = 0;
    let col_abs = b.first() == Some(&b'$');
    if col_abs {
        i += 1;
    }
    let cs = i;
    while i < b.len() && b[i].is_ascii_alphabetic() {
        i += 1;
    }
    let letters = &s[cs..i];
    let row_abs = b.get(i) == Some(&b'$');
    if row_abs {
        i += 1;
    }
    let rs = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i != b.len() || rs == i || letters.is_empty() {
        return None;
    }
    let col = letters_to_col(letters)?;
    let row: u32 = s[rs..i].parse().ok()?;
    if row == 0 || row > MAX_ROWS {
        return None;
    }
    Some((row - 1, col, row_abs, col_abs))
}

/// Parse `A1` (ignoring `$`) into `(row, col)`.
pub fn parse_a1(s: &str) -> Option<(u32, u32)> {
    parse_a1_parts(s).map(|(r, c, _, _)| (r, c))
}

/// Parse `A1` or `A1:B2` into a rectangle (no sheet prefix).
pub fn parse_rect(s: &str) -> Option<Rect> {
    match s.split_once(':') {
        Some((a, b)) => {
            let (r0, c0) = parse_a1(a)?;
            let (r1, c1) = parse_a1(b)?;
            Some(Rect::new(r0, c0, r1, c1))
        }
        None => parse_a1(s).map(|(r, c)| Rect::cell(r, c)),
    }
}

/// Does the sheet name need quoting in a reference (`'My Sheet'!A1`)?
pub fn sheet_name_needs_quotes(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    let first = name.chars().next().unwrap_or(' ');
    if first.is_ascii_digit() {
        return true;
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.')
    {
        return true;
    }
    // Names that look like cell references or R1C1 references must be quoted.
    if parse_a1(name).is_some() {
        return true;
    }
    let up = name.to_ascii_uppercase();
    up == "TRUE"
        || up == "FALSE"
        || up.starts_with('R') && up[1..].chars().all(|c| c.is_ascii_digit() || c == 'C')
}

/// Format a sheet name for use in a reference, quoting when needed.
pub fn quote_sheet_name(name: &str) -> String {
    if sheet_name_needs_quotes(name) {
        format!("'{}'", name.replace('\'', "''"))
    } else {
        name.to_string()
    }
}

/// Sanitise a sheet name for xlsx: removes `[]:*?/\`, trims quotes at the ends, at most 31 chars (§9.17).
pub fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\') && !c.is_control())
        .collect();
    let trimmed = cleaned.trim().trim_matches('\'').trim();
    let mut out: String = trimmed.chars().take(MAX_SHEET_NAME_LEN).collect();
    if out.is_empty() {
        out = "Sheet".to_string();
    }
    out
}

/// Is this a valid sheet name inside EMP (non-empty, ≤31 chars, no forbidden characters)?
pub fn is_valid_sheet_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= MAX_SHEET_NAME_LEN
        && !name
            .chars()
            .any(|c| matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\') || c.is_control())
        && !name.starts_with('\'')
        && !name.ends_with('\'')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_roundtrip() {
        for (c, s) in [
            (0, "A"),
            (25, "Z"),
            (26, "AA"),
            (51, "AZ"),
            (52, "BA"),
            (701, "ZZ"),
            (702, "AAA"),
            (16383, "XFD"),
        ] {
            assert_eq!(col_to_letters(c), s);
            assert_eq!(letters_to_col(s), Some(c));
        }
        assert_eq!(letters_to_col("XFE"), None);
        assert_eq!(letters_to_col(""), None);
        assert_eq!(letters_to_col("a"), Some(0));
    }

    #[test]
    fn cell_key_packing() {
        let k = CellKey::new(7, 1_048_575, 16_383);
        assert_eq!((k.sheet(), k.row(), k.col()), (7, 1_048_575, 16_383));
        let k = CellKey::new(0, 0, 0);
        assert_eq!(k.0, 0);
        assert!(CellKey::new(0, 1, 0) > CellKey::new(0, 0, 5));
    }

    #[test]
    fn a1_parsing() {
        assert_eq!(parse_a1_parts("$B$3"), Some((2, 1, true, true)));
        assert_eq!(parse_a1_parts("b3"), Some((2, 1, false, false)));
        assert_eq!(parse_a1("A0"), None);
        assert_eq!(parse_a1("A1048577"), None);
        assert_eq!(parse_a1("XFD1048576"), Some((1_048_575, 16_383)));
        assert_eq!(parse_rect("B2:A1"), Some(Rect::new(0, 0, 1, 1)));
        assert_eq!(format_rect(&Rect::new(0, 0, 9, 1)), "A1:B10");
    }

    #[test]
    fn quoting() {
        assert_eq!(quote_sheet_name("Sheet1"), "Sheet1");
        assert_eq!(quote_sheet_name("My Sheet"), "'My Sheet'");
        assert_eq!(quote_sheet_name("O'Brien"), "'O''Brien'");
        assert_eq!(quote_sheet_name("A1"), "'A1'");
        assert_eq!(quote_sheet_name("2024"), "'2024'");
        assert_eq!(sanitize_sheet_name("a/b:c*d?[e]"), "abcde");
        assert_eq!(sanitize_sheet_name(&"x".repeat(40)).len(), 31);
        assert!(is_valid_sheet_name("Budget 2026"));
        assert!(!is_valid_sheet_name("a:b"));
    }

    #[test]
    fn rect_ops() {
        let a = Rect::new(0, 0, 4, 4);
        let b = Rect::new(3, 3, 6, 6);
        assert_eq!(a.intersection(&b), Some(Rect::new(3, 3, 4, 4)));
        assert_eq!(a.union(&b), Rect::new(0, 0, 6, 6));
        assert!(!a.intersects(&Rect::cell(5, 0)));
        assert_eq!(a.area(), 25);
    }
}
