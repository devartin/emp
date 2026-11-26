//! Statement import (§15.2) with the §9.16 hardening limits.
//!
//! The importer is pure: it takes the file bytes (read by the app through a grant) and returns parsed rows.
//! The app wraps calls in `catch_unwind` on a blocking thread and passes a cancellation flag.
//!
//! Flow used by `finance_import_start` / `_preview` / `_commit`:
//! 1. [`start`] decodes, sniffs the format and either parses the statement (OFX/QFX/QIF) or inspects the
//!    CSV (columns, sample, mapping guess, header fingerprint for profile matching).
//! 2. [`parse`] produces [`StatementTxn`]s, using the user-confirmed [`ImportMapping`] for CSV (and its
//!    `dateFormat` for QIF when the dates were ambiguous).
//! 3. The app normalises payees ([`crate::payee`]), computes import ids and dedupes ([`crate::dedupe`]),
//!    runs rules ([`crate::rules`]) and detects transfers ([`crate::transfers`]).

pub mod amount;
pub mod csv;
pub mod dates;
pub mod decode;
pub mod ofx;
pub mod preview;
pub mod qif;
pub mod sniff;

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

pub use self::dates::DateFormat;
use crate::error::{FinanceError, Result};

/// Detected statement format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportFormat {
    /// Comma/semicolon/tab separated values.
    Csv,
    /// Open Financial Exchange 1.x (SGML) or 2.x (XML).
    Ofx,
    /// Quicken's OFX variant.
    Qfx,
    /// Quicken Interchange Format.
    Qif,
}

/// Hard and soft limits (§9.16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportLimits {
    /// Hard size cap (1 GiB).
    pub max_bytes: u64,
    /// Above this size the user must confirm (100 MiB).
    pub confirm_bytes: u64,
    /// Maximum data rows / transactions.
    pub max_rows: usize,
    /// Maximum columns per CSV row.
    pub max_columns: usize,
    /// Maximum bytes per field / text node.
    pub max_field_bytes: usize,
    /// Maximum OFX element nesting depth.
    pub max_depth: usize,
}

impl Default for ImportLimits {
    fn default() -> Self {
        Self {
            max_bytes: 1 << 30,
            confirm_bytes: 100 << 20,
            max_rows: 5_000_000,
            max_columns: 512,
            max_field_bytes: 64 * 1024,
            max_depth: 64,
        }
    }
}

/// Options for one import call.
#[derive(Debug, Clone, Copy, Default)]
pub struct ImportOptions<'a> {
    /// Limits to enforce.
    pub limits: ImportLimits,
    /// The user confirmed a file above `confirm_bytes`.
    pub confirmed_large: bool,
    /// Cooperative cancellation flag, polled periodically.
    pub cancel: Option<&'a AtomicBool>,
}

impl ImportOptions<'_> {
    /// Checks the input size against the limits.
    pub fn check_size(&self, len: usize) -> Result<()> {
        let len = len as u64;
        if len > self.limits.max_bytes {
            return Err(FinanceError::TooLarge(format!(
                "file is {len} bytes; the limit is {} bytes",
                self.limits.max_bytes
            )));
        }
        if len > self.limits.confirm_bytes && !self.confirmed_large {
            return Err(FinanceError::NeedsConfirmation(format!(
                "file is {len} bytes; confirm to import"
            )));
        }
        Ok(())
    }

    /// Returns `Err(Cancelled)` when the flag is set.
    pub fn check_cancel(&self) -> Result<()> {
        if self.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(FinanceError::Cancelled);
        }
        Ok(())
    }
}

/// One split line (QIF `S`/`E`/`$`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementSplit {
    /// Category text from the file.
    pub category: Option<String>,
    /// Memo.
    pub memo: Option<String>,
    /// Signed amount.
    pub amount: Decimal,
}

/// A parsed statement row. Text fields are kept verbatim (never evaluated as formulas, §9.16).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementTxn {
    /// 0-based source row index (CSV data row / QIF record / OFX transaction), used for `skip` and `overrides`.
    pub idx: usize,
    /// Posting date.
    pub date: NaiveDate,
    /// Signed amount (after `invert`).
    pub amount: Decimal,
    /// Raw payee/description text.
    pub payee: String,
    /// Memo.
    pub memo: Option<String>,
    /// OFX FITID.
    pub fitid: Option<String>,
    /// Check number.
    pub check_number: Option<String>,
    /// OFX TRNTYPE.
    pub trn_type: Option<String>,
    /// Running balance from the file.
    pub balance: Option<Decimal>,
    /// Category text from the file (QIF `L`).
    pub category: Option<String>,
    /// Cleared flag text from the file (QIF `C`).
    pub cleared: Option<String>,
    /// Split lines.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub splits: Vec<StatementSplit>,
}

impl StatementTxn {
    /// A bare row (used by the parsers).
    pub fn new(idx: usize, date: NaiveDate, amount: Decimal, payee: String) -> Self {
        Self {
            idx,
            date,
            amount,
            payee,
            memo: None,
            fitid: None,
            check_number: None,
            trn_type: None,
            balance: None,
            category: None,
            cleared: None,
            splits: Vec::new(),
        }
    }
}

/// Account information carried by the statement.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementAccount {
    /// Bank routing id.
    pub bank_id: Option<String>,
    /// Account number as in the file. The app should store it as a `secret` (last 4) only.
    pub account_id: Option<String>,
    /// Account type text (`CHECKING`, `CREDITLINE`, QIF `Bank`, ...).
    pub account_type: Option<String>,
    /// Currency code.
    pub currency: Option<String>,
    /// Account name (QIF `!Account` blocks).
    pub name: Option<String>,
}

impl StatementAccount {
    /// Last four characters of the account number, for display and account guessing.
    pub fn last4(&self) -> Option<String> {
        let a = self.account_id.as_deref()?.trim();
        let n = a.chars().count();
        Some(a.chars().skip(n.saturating_sub(4)).collect())
    }
}

/// A balance reported by the statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementBalance {
    /// Amount.
    pub amount: Decimal,
    /// As-of date.
    pub date: Option<NaiveDate>,
}

/// One account's rows within a file.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementSection {
    /// Account info, when the format carries it.
    pub account: Option<StatementAccount>,
    /// Transactions in file order.
    pub transactions: Vec<StatementTxn>,
    /// Ledger balance, when present.
    pub ledger_balance: Option<StatementBalance>,
}

/// A fully parsed statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedStatement {
    /// Format.
    pub format: ImportFormat,
    /// Text encoding used for decoding.
    pub encoding: String,
    /// Sections (one per account).
    pub sections: Vec<StatementSection>,
    /// Row-level problems and skipped content, as user-facing text.
    pub warnings: Vec<String>,
    /// Date formats that fit equally well (non-empty means "ask the user once").
    pub date_ambiguity: Vec<DateFormat>,
}

impl ParsedStatement {
    /// All transactions across sections.
    pub fn transactions(&self) -> impl Iterator<Item = &StatementTxn> {
        self.sections.iter().flat_map(|s| s.transactions.iter())
    }

    /// Total number of transactions.
    pub fn row_count(&self) -> usize {
        self.sections.iter().map(|s| s.transactions.len()).sum()
    }
}

/// Column mapping for CSV imports (IPC `ImportMapping`). Column indexes are 0-based.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMapping {
    /// Date column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<usize>,
    /// Signed amount column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<usize>,
    /// Debit (outflow) column, used with `credit` instead of `amount`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debit: Option<usize>,
    /// Credit (inflow) column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<usize>,
    /// Payee/description column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payee: Option<usize>,
    /// Memo column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memo: Option<usize>,
    /// Running balance column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance: Option<usize>,
    /// Date format token (see [`DateFormat`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_format: Option<DateFormat>,
    /// Flip signs (card exports that show purchases as positive).
    #[serde(default)]
    pub invert: bool,
    /// Amounts use a decimal comma.
    #[serde(default)]
    pub decimal_comma: bool,
    /// Whether the first row is a header. Extension to the SPEC shape; inferred when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_header: Option<bool>,
}

/// Result of [`start`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStart {
    /// Format.
    pub format: ImportFormat,
    /// Encoding.
    pub encoding: String,
    /// CSV column headers (or `Column 1..n` when there is no header row).
    pub columns: Option<Vec<String>>,
    /// First rows as text (CSV raw cells; for other formats `[date, amount, payee, memo]`).
    pub sample: Vec<Vec<String>>,
    /// Best mapping guess (CSV) or the detected date format/decimal settings (QIF).
    pub mapping_guess: ImportMapping,
    /// CSV header fingerprint for profile lookup in `kv ns=fin.profiles`.
    pub header_fingerprint: Option<String>,
    /// Number of data rows / transactions.
    pub row_count: usize,
    /// Date formats to ask the user to choose between (empty when unambiguous).
    pub date_ambiguity: Vec<DateFormat>,
    /// Account info from the file (OFX/QIF), for `accountGuess`.
    pub account: Option<StatementAccount>,
    /// Warnings.
    pub warnings: Vec<String>,
}

const SAMPLE_ROWS: usize = 20;

/// Decodes, sniffs and inspects a statement file.
pub fn start(
    bytes: &[u8],
    filename: Option<&str>,
    opts: &ImportOptions<'_>,
) -> Result<ImportStart> {
    opts.check_size(bytes.len())?;
    let (text, encoding) = decode::decode(bytes);
    let format = sniff::sniff(&text, filename);
    match format {
        ImportFormat::Csv => {
            let table = csv::read_table(&text, None, opts)?;
            let (mapping, ambiguity) = csv::guess_mapping(&table);
            let columns = table.column_names();
            let sample = table.rows.iter().take(SAMPLE_ROWS).cloned().collect();
            Ok(ImportStart {
                format,
                encoding: encoding.to_string(),
                header_fingerprint: table.header.as_ref().map(|h| csv::header_fingerprint(h)),
                columns: Some(columns),
                sample,
                mapping_guess: mapping,
                row_count: table.rows.len(),
                date_ambiguity: ambiguity,
                account: None,
                warnings: table.warnings.clone(),
            })
        }
        _ => {
            let st = parse_text(&text, encoding, format, None, opts)?;
            let sample = st
                .transactions()
                .take(SAMPLE_ROWS)
                .map(|t| {
                    vec![
                        t.date.to_string(),
                        t.amount.to_string(),
                        t.payee.clone(),
                        t.memo.clone().unwrap_or_default(),
                    ]
                })
                .collect();
            let mapping_guess = ImportMapping {
                date_format: st.date_ambiguity.first().copied(),
                ..ImportMapping::default()
            };
            Ok(ImportStart {
                format,
                encoding: st.encoding.clone(),
                columns: None,
                sample,
                mapping_guess,
                header_fingerprint: None,
                row_count: st.row_count(),
                date_ambiguity: st.date_ambiguity.clone(),
                account: st.sections.iter().find_map(|s| s.account.clone()),
                warnings: st.warnings,
            })
        }
    }
}

/// Parses a statement file. `mapping` is required for CSV (use the [`start`] guess or a saved profile);
/// for QIF only its `date_format` is used.
pub fn parse(
    bytes: &[u8],
    filename: Option<&str>,
    mapping: Option<&ImportMapping>,
    opts: &ImportOptions<'_>,
) -> Result<ParsedStatement> {
    opts.check_size(bytes.len())?;
    let (text, encoding) = decode::decode(bytes);
    let format = sniff::sniff(&text, filename);
    parse_text(&text, encoding, format, mapping, opts)
}

fn parse_text(
    text: &str,
    encoding: &str,
    format: ImportFormat,
    mapping: Option<&ImportMapping>,
    opts: &ImportOptions<'_>,
) -> Result<ParsedStatement> {
    match format {
        ImportFormat::Csv => {
            let table = csv::read_table(text, mapping.and_then(|m| m.has_header), opts)?;
            let guessed;
            let m = match mapping {
                Some(m) => m,
                None => {
                    guessed = csv::guess_mapping(&table).0;
                    &guessed
                }
            };
            let mapped = csv::apply_mapping(&table, m, opts)?;
            let mut warnings = table.warnings.clone();
            warnings.extend(
                mapped
                    .errors
                    .iter()
                    .map(|e| format!("Row {}: {}", e.row + 1, e.message)),
            );
            Ok(ParsedStatement {
                format,
                encoding: encoding.to_string(),
                sections: vec![StatementSection {
                    account: None,
                    transactions: mapped.txns,
                    ledger_balance: None,
                }],
                warnings,
                date_ambiguity: Vec::new(),
            })
        }
        ImportFormat::Ofx | ImportFormat::Qfx => {
            let mut st = ofx::parse(text, opts)?;
            st.format = format;
            st.encoding = encoding.to_string();
            Ok(st)
        }
        ImportFormat::Qif => {
            let mut st = qif::parse(text, mapping.and_then(|m| m.date_format), opts)?;
            st.encoding = encoding.to_string();
            Ok(st)
        }
    }
}
