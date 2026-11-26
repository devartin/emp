//! CSV import (delimiter + encoding sniffing, streaming parse) and export with formula-injection
//! protection (§9.16, §9.17).

use super::ImportOptions;
use super::xlsx_import::ImportResult;
use crate::address::SheetId;
use crate::host::Host;
use crate::value::Value;
use crate::workbook::sheet::{Cell, CellInput};
use crate::workbook::{ParsedInput, SheetError, Workbook, parse_input};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Hard size cap (1 GiB). Files above 100 MiB should be confirmed by the user before import.
pub const CSV_MAX_BYTES: usize = 1 << 30;
/// Size above which the UI asks for confirmation.
pub const CSV_CONFIRM_BYTES: usize = 100 << 20;

/// Result of sniffing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvSniff {
    /// Delimiter.
    pub delimiter: char,
    /// `utf-8`, `utf-16le`, `utf-16be` or `windows-1252`.
    pub encoding: String,
}

/// Decode bytes per BOM / UTF-8 validity, falling back to Windows-1252.
pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).into_owned(), "utf-8");
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let le = bytes[0] == 0xFF;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        return (
            String::from_utf16_lossy(&units),
            if le { "utf-16le" } else { "utf-16be" },
        );
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), "utf-8"),
        Err(_) => (
            bytes
                .iter()
                .map(|b| crate::functions::text::cp1252_char(*b))
                .collect(),
            "windows-1252",
        ),
    }
}

/// Pick the delimiter among `, ; \t |` with the most consistent column count over the first 20 lines.
pub fn sniff_delimiter(text: &str) -> char {
    let sample: String = text.lines().take(20).collect::<Vec<_>>().join("\n");
    let mut best = (',', 0usize, 0usize); // (delim, consistent lines, columns)
    for d in [',', ';', '\t', '|'] {
        let mut rdr = ::csv::ReaderBuilder::new()
            .delimiter(d as u8)
            .has_headers(false)
            .flexible(true)
            .from_reader(sample.as_bytes());
        let mut counts: Vec<usize> = Vec::new();
        for rec in rdr.records().take(20) {
            match rec {
                Ok(r) => counts.push(r.len()),
                Err(_) => break,
            }
        }
        if counts.is_empty() {
            continue;
        }
        let mut freq: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
        for c in &counts {
            *freq.entry(*c).or_default() += 1;
        }
        let (cols, n) = freq
            .into_iter()
            .max_by_key(|(c, n)| (*n, *c))
            .unwrap_or((1, 0));
        if cols < 2 {
            continue;
        }
        if n > best.1 || (n == best.1 && cols > best.2) {
            best = (d, n, cols);
        }
    }
    best.0
}

/// Sniff delimiter and encoding.
pub fn sniff(bytes: &[u8]) -> CsvSniff {
    let head = &bytes[..bytes.len().min(64 * 1024)];
    let (text, enc) = decode(head);
    CsvSniff {
        delimiter: sniff_delimiter(&text),
        encoding: enc.to_string(),
    }
}

/// Read CSV into rows of strings (for previews and database import).
pub fn read_rows(
    bytes: &[u8],
    max_rows: usize,
) -> Result<(CsvSniff, Vec<Vec<String>>), SheetError> {
    if bytes.len() > CSV_MAX_BYTES {
        return Err(SheetError::TooLarge(
            "CSV files are limited to 1 GiB".into(),
        ));
    }
    let (text, enc) = decode(bytes);
    let delim = sniff_delimiter(&text);
    let mut rdr = ::csv::ReaderBuilder::new()
        .delimiter(delim as u8)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for rec in rdr.records() {
        let r = rec.map_err(|e| SheetError::Io(e.to_string()))?;
        rows.push(r.iter().map(|s| s.to_string()).collect());
        if rows.len() >= max_rows {
            break;
        }
    }
    Ok((
        CsvSniff {
            delimiter: delim,
            encoding: enc.to_string(),
        },
        rows,
    ))
}

fn dangerous(s: &str) -> bool {
    matches!(s.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r'))
}

/// Import CSV into a one-sheet workbook. Cells starting with `= + - @ \t \r` import as text unless
/// `opts.csv_formulas` is set (numbers such as `-5` stay numbers).
pub fn import_csv(
    bytes: &[u8],
    sheet_name: &str,
    host: Arc<dyn Host>,
    opts: &ImportOptions,
) -> Result<ImportResult, SheetError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        import_inner(bytes, sheet_name, host, opts)
    }))
    .unwrap_or_else(|_| Err(SheetError::Internal("csv import panicked".into())))
}

fn import_inner(
    bytes: &[u8],
    sheet_name: &str,
    host: Arc<dyn Host>,
    opts: &ImportOptions,
) -> Result<ImportResult, SheetError> {
    if bytes.len() > CSV_MAX_BYTES {
        return Err(SheetError::TooLarge(
            "CSV files are limited to 1 GiB".into(),
        ));
    }
    let (text, _enc) = decode(bytes);
    let delim = sniff_delimiter(&text);
    let mut wb = Workbook::empty(host);
    let name = crate::address::sanitize_sheet_name(sheet_name);
    let sid = wb.push_sheet(&name);
    let mut warnings = Vec::new();
    let mut rdr = ::csv::ReaderBuilder::new()
        .delimiter(delim as u8)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut cells = 0usize;
    let mut formula_cells = 0usize;
    let mut out: Vec<(u32, u32, Cell)> = Vec::new();
    for (r, rec) in rdr.records().enumerate() {
        if r % 10_000 == 0 {
            opts.check_cancel()?;
        }
        let rec = rec.map_err(|e| SheetError::Io(e.to_string()))?;
        if r as u32 >= crate::limits::MAX_ROWS {
            warnings.push("Rows beyond 1,048,576 were dropped.".into());
            break;
        }
        for (c, field) in rec.iter().enumerate() {
            if c as u32 >= crate::limits::MAX_COLS || field.is_empty() {
                continue;
            }
            cells += 1;
            if cells > opts.max_cells {
                return Err(SheetError::TooLarge(format!(
                    "the file has more than {} cells",
                    opts.max_cells
                )));
            }
            let parsed = parse_input(field, false);
            let cell = match parsed {
                ParsedInput::Formula(src) if opts.csv_formulas => match wb.compile(&src) {
                    Ok(f) => {
                        formula_cells += 1;
                        Cell {
                            input: CellInput::Formula(Arc::new(f)),
                            value: Value::Empty,
                            style: 0,
                        }
                    }
                    Err(_) => Cell::literal(Value::text(field), 0),
                },
                ParsedInput::Value(Value::Number(n), hint) => {
                    let style = match hint {
                        Some(h) => wb.styles.intern(crate::workbook::style::CellStyle {
                            num_fmt: Some(h.to_string()),
                            ..Default::default()
                        }),
                        None => 0,
                    };
                    Cell::literal(Value::Number(n), style)
                }
                ParsedInput::Value(v, _) if !dangerous(field) => Cell::literal(v, 0),
                _ => Cell::literal(Value::text(field), 0),
            };
            out.push((r as u32, c as u32, cell));
        }
    }
    if let Some(s) = wb.sheet_mut(sid) {
        for (r, c, cell) in out {
            s.put(r, c, cell);
        }
    }
    if formula_cells > 0 {
        wb.rebuild_deps();
        let _ = wb.recalc_all();
    }
    Ok(ImportResult {
        workbook: wb,
        warnings,
    })
}

/// Export one sheet as CSV (displayed values, comma-delimited, UTF-8). With `protect`, text cells starting
/// with `= + - @ \t \r` get a leading `'`.
pub fn export_csv(wb: &Workbook, sheet: SheetId, protect: bool) -> Result<Vec<u8>, SheetError> {
    let s = wb
        .sheet(sheet)
        .ok_or_else(|| SheetError::NotFound(format!("sheet {sheet}")))?;
    let (rows, cols) = s.extent();
    let mut w = ::csv::WriterBuilder::new().from_writer(Vec::new());
    for r in 0..rows {
        let mut rec: Vec<String> = Vec::with_capacity(cols as usize);
        for c in 0..cols {
            let v = s.value_at(r, c);
            let mut text = wb.display(sheet, r, c);
            if protect && matches!(v, Value::Text(_)) && dangerous(&text) {
                text.insert(0, '\'');
            }
            rec.push(text);
        }
        w.write_record(&rec)
            .map_err(|e| SheetError::Io(e.to_string()))?;
    }
    w.into_inner().map_err(|e| SheetError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::CacheHost;

    #[test]
    fn sniffing() {
        assert_eq!(sniff_delimiter("a;b;c\n1;2;3\n"), ';');
        assert_eq!(sniff_delimiter("a,b\n1,2\n3,4"), ',');
        assert_eq!(sniff_delimiter("a\tb\tc\n1\t2\t3"), '\t');
        assert_eq!(sniff_delimiter("a|b\n1|2"), '|');
        assert_eq!(sniff_delimiter("\"x,y\";z\n\"1,2\";3"), ';');
        let (t, e) = decode(&[0xEF, 0xBB, 0xBF, b'h', b'i']);
        assert_eq!((t.as_str(), e), ("hi", "utf-8"));
        let (t, e) = decode(&[0xFF, 0xFE, b'h', 0, b'i', 0]);
        assert_eq!((t.as_str(), e), ("hi", "utf-16le"));
        let (t, e) = decode(&[b'c', b'a', b'f', 0xE9]);
        assert_eq!((t.as_str(), e), ("café", "windows-1252"));
    }

    #[test]
    fn import_and_export() {
        let data =
            "name;amount;when;note\nAnn;1.234,5;2024-01-15;=HYPERLINK(\"x\")\nBob;-5;;@cmd\n"
                .replace("1.234,5", "12.5");
        let res = import_csv(
            data.as_bytes(),
            "Data",
            Arc::new(CacheHost::new()),
            &ImportOptions::default(),
        );
        let Ok(res) = res else {
            panic!("import failed")
        };
        let wb = res.workbook;
        let s = wb.sheets()[0].id;
        assert_eq!(wb.value(s, 1, 1), Value::Number(12.5));
        assert_eq!(wb.value(s, 2, 1), Value::Number(-5.0));
        assert_eq!(wb.value(s, 1, 2), Value::Number(45306.0));
        assert_eq!(wb.display(s, 1, 2), "2024-01-15");
        assert_eq!(wb.value(s, 1, 3), Value::text("=HYPERLINK(\"x\")"));
        assert_eq!(wb.value(s, 2, 3), Value::text("@cmd"));
        let out = export_csv(&wb, s, true).unwrap_or_default();
        let text = String::from_utf8(out).unwrap_or_default();
        assert!(text.contains("'=HYPERLINK"));
        assert!(text.contains("'@cmd"));
        assert!(text.contains(",-5,"));
        let opts = ImportOptions {
            csv_formulas: true,
            ..Default::default()
        };
        let res =
            import_csv(b"1,=A1*2", "S", Arc::new(CacheHost::new()), &opts).map(|r| r.workbook);
        assert_eq!(
            res.map(|w| w.value(w.sheets()[0].id, 0, 1)).ok(),
            Some(Value::Number(2.0))
        );
        let small = ImportOptions {
            max_cells: 2,
            ..Default::default()
        };
        assert!(import_csv(b"1,2,3", "S", Arc::new(CacheHost::new()), &small).is_err());
    }
}
