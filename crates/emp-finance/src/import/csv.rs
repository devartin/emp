//! CSV statements: delimiter and header detection, column-mapping guesses, header fingerprints for saved
//! profiles, and row mapping (§15.2 CSV profiles, Dates, Amounts).

use rust_decimal::Decimal;
use sha2::{Digest, Sha256};

use super::amount::{detect_decimal_comma, parse_amount};
use super::dates::{DETECTION_ORDER, DateFormat, detect, parse_date};
use super::{ImportMapping, ImportOptions, StatementTxn};
use crate::dedupe::hex;
use crate::error::{FinanceError, Result};

/// A decoded CSV table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvTable {
    /// Field delimiter.
    pub delimiter: u8,
    /// Header row, when detected (or forced).
    pub header: Option<Vec<String>>,
    /// Data rows (header excluded, blank rows and preamble removed).
    pub rows: Vec<Vec<String>>,
    /// Non-fatal notes.
    pub warnings: Vec<String>,
}

impl CsvTable {
    /// Number of columns (widest row).
    pub fn width(&self) -> usize {
        self.header
            .as_ref()
            .map_or(0, Vec::len)
            .max(self.rows.iter().map(Vec::len).max().unwrap_or(0))
    }

    /// Header names, or `Column 1..n`.
    pub fn column_names(&self) -> Vec<String> {
        let w = self.width();
        (0..w)
            .map(|i| {
                self.header
                    .as_ref()
                    .and_then(|h| h.get(i))
                    .filter(|s| !s.trim().is_empty())
                    .cloned()
                    .unwrap_or_else(|| format!("Column {}", i + 1))
            })
            .collect()
    }

    fn cell(&self, row: usize, col: usize) -> &str {
        self.rows
            .get(row)
            .and_then(|r| r.get(col))
            .map_or("", String::as_str)
    }

    fn column(&self, col: usize) -> impl Iterator<Item = &str> {
        self.rows
            .iter()
            .map(move |r| r.get(col).map_or("", String::as_str))
    }
}

/// `sha256(lowercased, trimmed headers joined by U+001F)`, hex.
pub fn header_fingerprint(headers: &[String]) -> String {
    let joined = headers
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect::<Vec<_>>()
        .join("\u{1f}");
    hex(&Sha256::digest(joined.as_bytes()))
}

const DELIMS: [u8; 4] = *b",;\t|";

fn parse_with(
    text: &str,
    delim: u8,
    opts: &ImportOptions<'_>,
    max_records: Option<usize>,
) -> Result<Vec<Vec<String>>> {
    let mut rdr = ::csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .quoting(true)
        .double_quote(true)
        .from_reader(text.as_bytes());
    let lim = &opts.limits;
    let mut out = Vec::new();
    let mut rec = ::csv::StringRecord::new();
    let mut n = 0usize;
    loop {
        match rdr.read_record(&mut rec) {
            Ok(false) => break,
            Ok(true) => {}
            Err(e) => {
                let line = e.position().map(|p| p.line() as usize).unwrap_or(0);
                return Err(FinanceError::parse_at(line, format!("malformed CSV: {e}")));
            }
        }
        n += 1;
        if n.is_multiple_of(4096) {
            opts.check_cancel()?;
        }
        if rec.len() > lim.max_columns {
            return Err(FinanceError::TooLarge(format!(
                "row {n} has {} columns (limit {})",
                rec.len(),
                lim.max_columns
            )));
        }
        if rec.iter().any(|f| f.len() > lim.max_field_bytes) {
            return Err(FinanceError::TooLarge(format!(
                "row {n} has a field over {} bytes",
                lim.max_field_bytes
            )));
        }
        if rec.iter().all(|f| f.trim().is_empty()) {
            continue;
        }
        out.push(rec.iter().map(|f| f.trim().to_string()).collect());
        if out.len() > lim.max_rows {
            return Err(FinanceError::TooLarge(format!(
                "more than {} rows",
                lim.max_rows
            )));
        }
        if max_records.is_some_and(|m| out.len() >= m) {
            break;
        }
    }
    Ok(out)
}

fn detect_delimiter(text: &str, opts: &ImportOptions<'_>) -> u8 {
    let mut best = (b',', 0usize, 0usize);
    for d in DELIMS {
        let Ok(rows) = parse_with(text, d, opts, Some(30)) else {
            continue;
        };
        if rows.is_empty() {
            continue;
        }
        let modal = modal_width(&rows);
        if modal < 2 {
            continue;
        }
        let consistent = rows.iter().filter(|r| r.len() == modal).count();
        if consistent > best.1 || (consistent == best.1 && modal > best.2) {
            best = (d, consistent, modal);
        }
    }
    best.0
}

fn modal_width(rows: &[Vec<String>]) -> usize {
    let mut counts = std::collections::HashMap::<usize, usize>::new();
    for r in rows {
        *counts.entry(r.len()).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)))
        .map_or(0, |(w, _)| w)
}

fn looks_like_data(cell: &str) -> bool {
    let c = cell.trim();
    !c.is_empty()
        && (parse_amount(c, false).is_ok()
            || DETECTION_ORDER
                .iter()
                .filter(|f| **f != DateFormat::ExcelSerial)
                .any(|f| parse_date(c, *f).is_some()))
}

/// Reads a CSV table: detects the delimiter, drops preamble lines (rows narrower than the modal width
/// before the first full-width row) and detects a header row unless `has_header` forces it.
pub fn read_table(
    text: &str,
    has_header: Option<bool>,
    opts: &ImportOptions<'_>,
) -> Result<CsvTable> {
    let delimiter = detect_delimiter(text, opts);
    let mut rows = parse_with(text, delimiter, opts, None)?;
    let mut warnings = Vec::new();
    let modal = modal_width(&rows);
    if modal >= 2 {
        let first_full = rows.iter().position(|r| r.len() >= modal).unwrap_or(0);
        if first_full > 0 {
            warnings.push(format!(
                "Skipped {first_full} line(s) before the column header"
            ));
            rows.drain(..first_full);
        }
    }
    let header_present = has_header.unwrap_or_else(|| {
        rows.first().is_some_and(|first| {
            let any_text = first.iter().any(|c| c.chars().any(char::is_alphabetic));
            let no_data = !first.iter().any(|c| looks_like_data(c));
            let next_has_data = rows
                .get(1)
                .is_none_or(|r| r.iter().any(|c| looks_like_data(c)));
            any_text && no_data && next_has_data
        })
    });
    let header = if header_present && !rows.is_empty() {
        Some(rows.remove(0))
    } else {
        None
    };
    Ok(CsvTable {
        delimiter,
        header,
        rows,
        warnings,
    })
}

fn find_header(headers: &[String], keys: &[&str], exclude: &[usize]) -> Option<usize> {
    let lower: Vec<String> = headers.iter().map(|h| h.trim().to_lowercase()).collect();
    // Exact names first, then substring matches, both in priority order.
    for k in keys {
        if let Some(i) = lower
            .iter()
            .enumerate()
            .position(|(i, h)| h == k && !exclude.contains(&i))
        {
            return Some(i);
        }
    }
    for k in keys {
        if let Some(i) = lower
            .iter()
            .enumerate()
            .position(|(i, h)| h.contains(k) && !exclude.contains(&i))
        {
            return Some(i);
        }
    }
    None
}

fn numeric_share(table: &CsvTable, col: usize) -> f64 {
    let vals: Vec<&str> = table.column(col).filter(|v| !v.is_empty()).collect();
    if vals.is_empty() {
        return 0.0;
    }
    vals.iter()
        .filter(|v| parse_amount(v, false).is_ok() || parse_amount(v, true).is_ok())
        .count() as f64
        / vals.len() as f64
}

fn date_share(table: &CsvTable, col: usize) -> f64 {
    let vals: Vec<&str> = table.column(col).filter(|v| !v.is_empty()).collect();
    if vals.is_empty() {
        return 0.0;
    }
    let ok = vals
        .iter()
        .filter(|v| {
            DETECTION_ORDER[..6]
                .iter()
                .any(|f| parse_date(v, *f).is_some())
        })
        .count();
    ok as f64 / vals.len() as f64
}

/// Guesses a mapping from header names (falling back to column contents) and detects the date format and
/// decimal comma. Returns the guess and the ambiguous date formats (if the user must choose).
pub fn guess_mapping(table: &CsvTable) -> (ImportMapping, Vec<DateFormat>) {
    let width = table.width();
    let mut m = ImportMapping {
        has_header: Some(table.header.is_some()),
        ..ImportMapping::default()
    };
    if let Some(h) = &table.header {
        m.date = find_header(
            h,
            &[
                "transaction date",
                "posting date",
                "posted date",
                "trans. date",
                "date",
                "booking date",
                "buchungstag",
                "datum",
                "fecha",
            ],
            &[],
        );
        let ex: Vec<usize> = m.date.into_iter().collect();
        m.balance = find_header(h, &["running balance", "balance", "saldo"], &ex);
        let mut ex2 = ex.clone();
        ex2.extend(m.balance);
        m.amount = find_header(
            h,
            &[
                "amount",
                "transaction amount",
                "amt",
                "betrag",
                "montant",
                "importe",
            ],
            &ex2,
        );
        if m.amount.is_none() {
            m.debit = find_header(
                h,
                &[
                    "debit",
                    "withdrawal",
                    "withdrawals",
                    "paid out",
                    "money out",
                    "outflow",
                    "charge",
                ],
                &ex2,
            );
            m.credit = find_header(
                h,
                &[
                    "credit", "deposit", "deposits", "paid in", "money in", "inflow",
                ],
                &ex2,
            );
            if m.debit.is_none() || m.credit.is_none() {
                m.debit = None;
                m.credit = None;
            }
        }
        let mut used: Vec<usize> = [m.date, m.amount, m.debit, m.credit, m.balance]
            .into_iter()
            .flatten()
            .collect();
        m.payee = find_header(
            h,
            &[
                "payee",
                "merchant",
                "description",
                "name",
                "narrative",
                "details",
                "transaction",
                "beschreibung",
            ],
            &used,
        );
        used.extend(m.payee);
        m.memo = find_header(
            h,
            &[
                "memo",
                "notes",
                "note",
                "reference",
                "extended description",
                "additional info",
                "verwendungszweck",
            ],
            &used,
        );
    }
    // Content-based fallback for missing columns.
    if m.date.is_none() {
        m.date = (0..width).find(|&c| date_share(table, c) >= 0.7);
    }
    if m.amount.is_none() && m.debit.is_none() {
        m.amount = (0..width)
            .filter(|c| Some(*c) != m.date && Some(*c) != m.balance)
            .find(|&c| numeric_share(table, c) >= 0.7);
    }
    if m.payee.is_none() {
        let used: Vec<usize> = [m.date, m.amount, m.debit, m.credit, m.balance, m.memo]
            .into_iter()
            .flatten()
            .collect();
        m.payee = (0..width)
            .filter(|c| !used.contains(c) && numeric_share(table, *c) < 0.5)
            .max_by_key(|&c| table.column(c).map(str::len).sum::<usize>());
    }
    let mut ambiguity = Vec::new();
    if let Some(dc) = m.date {
        let det = detect(table.column(dc), &DETECTION_ORDER);
        m.date_format = det.format;
        ambiguity = det.ambiguous;
    }
    let amount_cols: Vec<usize> = [m.amount, m.debit, m.credit]
        .into_iter()
        .flatten()
        .collect();
    m.decimal_comma = detect_decimal_comma(amount_cols.iter().flat_map(|&c| table.column(c)));
    (m, ambiguity)
}

/// A row that could not be mapped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowError {
    /// 0-based data row.
    pub row: usize,
    /// Description.
    pub message: String,
}

/// Mapped rows plus per-row errors (bad rows are skipped, never fatal).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MappedRows {
    /// Successfully mapped transactions.
    pub txns: Vec<StatementTxn>,
    /// Rows that failed.
    pub errors: Vec<RowError>,
}

fn opt_amount(cell: &str, dc: bool) -> std::result::Result<Option<Decimal>, String> {
    if cell.trim().is_empty() {
        return Ok(None);
    }
    parse_amount(cell, dc).map(Some).map_err(|e| e.to_string())
}

/// Applies a mapping to every data row.
pub fn apply_mapping(
    table: &CsvTable,
    m: &ImportMapping,
    opts: &ImportOptions<'_>,
) -> Result<MappedRows> {
    let date_col = m
        .date
        .ok_or_else(|| FinanceError::invalid("mapping needs a date column"))?;
    if m.amount.is_none()
        && (m.debit.is_none() || m.credit.is_none())
        && m.debit.or(m.credit).is_none()
    {
        return Err(FinanceError::invalid(
            "mapping needs an amount column or debit/credit columns",
        ));
    }
    let fmt = match m.date_format {
        Some(f) => f,
        None => detect(table.column(date_col), &DETECTION_ORDER)
            .format
            .ok_or_else(|| FinanceError::invalid("could not detect the date format; choose one"))?,
    };
    let mut out = MappedRows::default();
    for row in 0..table.rows.len() {
        if row % 4096 == 0 {
            opts.check_cancel()?;
        }
        let fail =
            |out: &mut MappedRows, msg: String| out.errors.push(RowError { row, message: msg });
        let date_cell = table.cell(row, date_col);
        let Some(date) = parse_date(date_cell, fmt) else {
            fail(&mut out, format!("invalid date {date_cell:?}"));
            continue;
        };
        let amount = if let Some(ac) = m.amount {
            match opt_amount(table.cell(row, ac), m.decimal_comma) {
                Ok(Some(a)) => a,
                Ok(None) => {
                    fail(&mut out, "missing amount".into());
                    continue;
                }
                Err(e) => {
                    fail(&mut out, e);
                    continue;
                }
            }
        } else {
            let debit = m
                .debit
                .map(|c| opt_amount(table.cell(row, c), m.decimal_comma))
                .transpose();
            let credit = m
                .credit
                .map(|c| opt_amount(table.cell(row, c), m.decimal_comma))
                .transpose();
            match (debit, credit) {
                (Ok(d), Ok(c)) => {
                    let (d, c) = (d.flatten(), c.flatten());
                    if d.is_none() && c.is_none() {
                        fail(&mut out, "missing amount".into());
                        continue;
                    }
                    c.unwrap_or_default().abs() - d.unwrap_or_default().abs()
                }
                (Err(e), _) | (_, Err(e)) => {
                    fail(&mut out, e);
                    continue;
                }
            }
        };
        let amount = if m.invert { -amount } else { amount };
        let payee = m
            .payee
            .map(|c| table.cell(row, c).to_string())
            .unwrap_or_default();
        let memo = m
            .memo
            .map(|c| table.cell(row, c).to_string())
            .filter(|s| !s.is_empty());
        let mut t = StatementTxn::new(
            row,
            date,
            amount,
            if payee.is_empty() {
                memo.clone().unwrap_or_default()
            } else {
                payee
            },
        );
        t.memo = memo;
        t.balance = m.balance.and_then(|c| {
            opt_amount(table.cell(row, c), m.decimal_comma)
                .ok()
                .flatten()
        });
        out.txns.push(t);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> ImportOptions<'static> {
        ImportOptions::default()
    }

    #[test]
    fn chase_style() {
        let text = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n\
                    01/05/2026,01/06/2026,STARBUCKS STORE 123,Food & Drink,Sale,-4.50,\n\
                    01/13/2026,01/14/2026,\"AMAZON, INC\",Shopping,Sale,\"-1,204.99\",gift\n\
                    01/20/2026,01/20/2026,PAYMENT THANK YOU,,Payment,500.00,\n";
        let t = read_table(text, None, &opts()).unwrap();
        assert_eq!(t.delimiter, b',');
        assert!(t.header.is_some());
        let (m, amb) = guess_mapping(&t);
        assert_eq!(
            (m.date, m.payee, m.amount, m.memo),
            (Some(0), Some(2), Some(5), Some(6))
        );
        assert_eq!(m.date_format, Some(DateFormat::Mdy));
        assert!(amb.is_empty());
        let rows = apply_mapping(&t, &m, &opts()).unwrap();
        assert!(rows.errors.is_empty());
        assert_eq!(rows.txns[1].amount, "-1204.99".parse().unwrap());
        assert_eq!(rows.txns[1].payee, "AMAZON, INC");
        assert_eq!(rows.txns[1].memo.as_deref(), Some("gift"));
    }

    #[test]
    fn european_semicolon_debit_credit_with_preamble() {
        let text = "Kontoauszug Girokonto\nIBAN;DE00 1234\n\
                    Datum;Beschreibung;Debit;Credit;Saldo\n\
                    05.01.2026;REWE Markt;12,50;;1.000,00\n\
                    06.01.2026;Gehalt;;2.500,00;3.487,50\n\
                    07.01.2026;Miete;800,00;;2.687,50\n";
        let t = read_table(text, None, &opts()).unwrap();
        assert_eq!(t.delimiter, b';');
        assert_eq!(t.warnings.len(), 1);
        let (m, _) = guess_mapping(&t);
        assert_eq!(
            (m.date, m.payee, m.debit, m.credit, m.balance),
            (Some(0), Some(1), Some(2), Some(3), Some(4))
        );
        assert!(m.decimal_comma);
        assert_eq!(m.date_format, Some(DateFormat::DmyDot));
        let rows = apply_mapping(&t, &m, &opts()).unwrap();
        let amts: Vec<String> = rows.txns.iter().map(|t| t.amount.to_string()).collect();
        assert_eq!(amts, vec!["-12.50", "2500.00", "-800.00"]);
        assert_eq!(rows.txns[1].balance, Some("3487.50".parse().unwrap()));
    }

    #[test]
    fn headerless_and_invert_and_bad_rows() {
        let text = "2026-02-01\tNetflix\t15.99\n2026-02-03\tShell\t40.00\n2026-02-04\tBroken\tabc\nnot-a-date\tX\t1\n";
        let t = read_table(text, None, &opts()).unwrap();
        assert_eq!(t.delimiter, b'\t');
        assert!(t.header.is_none());
        let (mut m, _) = guess_mapping(&t);
        assert_eq!((m.date, m.payee, m.amount), (Some(0), Some(1), Some(2)));
        assert_eq!(m.date_format, None, "one row has an invalid date");
        m.date_format = Some(DateFormat::Ymd);
        m.invert = true;
        let rows = apply_mapping(&t, &m, &opts()).unwrap();
        assert_eq!(rows.txns.len(), 2);
        assert_eq!(rows.txns[0].amount, "-15.99".parse().unwrap());
        assert_eq!(
            rows.errors.iter().map(|e| e.row).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(t.column_names(), vec!["Column 1", "Column 2", "Column 3"]);
    }

    #[test]
    fn fingerprint_is_normalised() {
        let a = header_fingerprint(&["Date ".into(), "AMOUNT".into()]);
        let b = header_fingerprint(&["date".into(), " amount".into()]);
        assert_eq!(a, b);
        assert_ne!(a, header_fingerprint(&["amount".into(), "date".into()]));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn formula_cells_stay_text() {
        let text =
            "Date,Payee,Amount\n2026-01-01,=HYPERLINK(\"x\"),-1.00\n2026-01-02,@SUM(A1),-2.00\n";
        let t = read_table(text, None, &opts()).unwrap();
        let (m, _) = guess_mapping(&t);
        let rows = apply_mapping(&t, &m, &opts()).unwrap();
        assert_eq!(rows.txns[0].payee, "=HYPERLINK(\"x\")");
        assert_eq!(rows.txns[1].payee, "@SUM(A1)");
    }

    #[test]
    fn limits_and_cancel() {
        let mut o = opts();
        o.limits.max_rows = 2;
        let text = "a,b\n1,2\n3,4\n5,6\n";
        assert!(matches!(
            read_table(text, Some(false), &o),
            Err(FinanceError::TooLarge(_))
        ));
        let flag = std::sync::atomic::AtomicBool::new(true);
        let o = ImportOptions {
            cancel: Some(&flag),
            ..ImportOptions::default()
        };
        let big: String = (0..5000).map(|i| format!("2026-01-01,P{i},1\n")).collect();
        assert_eq!(read_table(&big, None, &o), Err(FinanceError::Cancelled));
    }
}
