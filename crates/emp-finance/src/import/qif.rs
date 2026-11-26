//! QIF (Quicken Interchange Format) statements.
//!
//! Supported: `!Type:Bank|Cash|CCard|Oth A|Oth L` records (`D`, `T`/`U`, `P`, `M`, `N`, `L`, `C`, splits
//! `S`/`E`/`$`), `!Account` blocks (multi-account files) and `!Option` lines. Investment (`!Type:Invst`) and
//! list sections (`Cat`, `Class`, `Memorized`) are skipped with a warning.

use super::amount::parse_amount;
use super::dates::{DateFormat, detect, parse_date};
use super::{
    ImportFormat, ImportOptions, ParsedStatement, StatementAccount, StatementSection,
    StatementSplit, StatementTxn,
};
use crate::error::{FinanceError, Result};

const QIF_DATE_ORDER: [DateFormat; 5] = [
    DateFormat::QifMdy,
    DateFormat::Mdy,
    DateFormat::Dmy,
    DateFormat::DmyDot,
    DateFormat::Ymd,
];

#[derive(Debug, Default, Clone)]
struct RawRecord {
    line: usize,
    date: Option<String>,
    amount: Option<String>,
    payee: Option<String>,
    memo: Option<String>,
    num: Option<String>,
    category: Option<String>,
    cleared: Option<String>,
    splits: Vec<(Option<String>, Option<String>, Option<String>)>,
}

impl RawRecord {
    fn is_empty(&self) -> bool {
        self.date.is_none() && self.amount.is_none() && self.payee.is_none()
    }
}

#[derive(Debug, Default)]
struct RawSection {
    account: Option<StatementAccount>,
    records: Vec<RawRecord>,
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Mode {
    Cash,
    Skip,
    AccountList,
}

fn mode_for(type_line: &str) -> Mode {
    let t = type_line.trim().to_ascii_lowercase();
    match t.as_str() {
        "bank" | "cash" | "ccard" | "oth a" | "oth l" | "invoice" => Mode::Cash,
        _ => Mode::Skip,
    }
}

/// Parses a QIF document. `date_format` overrides detection (use it after asking the user).
pub fn parse(
    text: &str,
    date_format: Option<DateFormat>,
    opts: &ImportOptions<'_>,
) -> Result<ParsedStatement> {
    let mut warnings = Vec::new();
    let mut sections: Vec<RawSection> = Vec::new();
    let mut mode = Mode::Skip;
    let mut pending_account: Option<StatementAccount> = None;
    let mut cur = RawRecord::default();
    let mut skipped_types: Vec<String> = Vec::new();
    let mut total = 0usize;
    for (i, raw_line) in text.lines().enumerate() {
        if i % 4096 == 0 {
            opts.check_cancel()?;
        }
        let line = raw_line.trim_end_matches('\r');
        if line.len() > opts.limits.max_field_bytes {
            return Err(FinanceError::TooLarge(format!(
                "line {} is too long",
                i + 1
            )));
        }
        if line.trim().is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix('!') {
            let h = header.trim();
            let lower = h.to_ascii_lowercase();
            if let Some(t) = lower.strip_prefix("type:") {
                mode = mode_for(t);
                if mode == Mode::Cash {
                    let mut acct = pending_account.take().unwrap_or_default();
                    acct.account_type
                        .get_or_insert_with(|| h[5..].trim().to_string());
                    sections.push(RawSection {
                        account: Some(acct),
                        records: Vec::new(),
                    });
                } else if !skipped_types.contains(&t.to_string()) {
                    skipped_types.push(t.to_string());
                }
            } else if lower.starts_with("account") {
                mode = Mode::AccountList;
                pending_account = Some(StatementAccount::default());
            }
            // !Option:AutoSwitch and !Clear:AutoSwitch only toggle list modes.
            cur = RawRecord::default();
            continue;
        }
        let (code, value) =
            line.split_at(line.char_indices().nth(1).map_or(line.len(), |(i, _)| i));
        let value = value.trim().to_string();
        match mode {
            Mode::AccountList => {
                let acct = pending_account.get_or_insert_with(StatementAccount::default);
                match code {
                    "N" => acct.name = Some(value),
                    "T" => acct.account_type = Some(value),
                    "^" => {}
                    _ => {}
                }
            }
            Mode::Skip => {}
            Mode::Cash => {
                if code == "^" {
                    if !cur.is_empty() {
                        total += 1;
                        if total > opts.limits.max_rows {
                            return Err(FinanceError::TooLarge(format!(
                                "more than {} transactions",
                                opts.limits.max_rows
                            )));
                        }
                        if let Some(s) = sections.last_mut() {
                            s.records.push(std::mem::take(&mut cur));
                        }
                    }
                    cur = RawRecord::default();
                    continue;
                }
                if cur.is_empty() && cur.line == 0 {
                    cur.line = i + 1;
                }
                match code {
                    "D" => cur.date = Some(value),
                    "T" => cur.amount = Some(value),
                    "U" => {
                        cur.amount.get_or_insert(value);
                    }
                    "P" => cur.payee = Some(value),
                    "M" => cur.memo = Some(value),
                    "N" => cur.num = Some(value),
                    "L" => cur.category = Some(value),
                    "C" => cur.cleared = Some(value),
                    "S" => cur.splits.push((Some(value), None, None)),
                    "E" => {
                        if let Some(s) = cur.splits.last_mut() {
                            s.1 = Some(value);
                        }
                    }
                    "$" => {
                        if let Some(s) = cur.splits.last_mut() {
                            s.2 = Some(value);
                        } else {
                            cur.splits.push((None, None, Some(value)));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if mode == Mode::Cash
        && !cur.is_empty()
        && let Some(s) = sections.last_mut()
    {
        s.records.push(cur);
    }
    for t in skipped_types {
        warnings.push(format!(
            "Skipped the !Type:{t} section (not a bank or card register)"
        ));
    }
    if sections.is_empty() {
        return Err(FinanceError::parse(
            "no bank, cash or card register found in the QIF file",
        ));
    }

    let all_dates: Vec<&str> = sections
        .iter()
        .flat_map(|s| s.records.iter())
        .filter_map(|r| r.date.as_deref())
        .collect();
    let mut ambiguity = Vec::new();
    let fmt = match date_format {
        Some(f) => f,
        None => {
            let det = detect(all_dates.iter().copied(), &QIF_DATE_ORDER);
            ambiguity = det.ambiguous;
            det.format.unwrap_or(DateFormat::QifMdy)
        }
    };
    let dc = super::amount::detect_decimal_comma(
        sections
            .iter()
            .flat_map(|s| s.records.iter())
            .filter_map(|r| r.amount.as_deref()),
    );

    let mut idx = 0usize;
    let mut out_sections = Vec::with_capacity(sections.len());
    for s in sections {
        let mut txns = Vec::with_capacity(s.records.len());
        for r in s.records {
            let this = idx;
            idx += 1;
            let Some(date) = r.date.as_deref().and_then(|d| parse_date(d, fmt)) else {
                warnings.push(format!(
                    "Line {}: invalid or missing date {:?}",
                    r.line,
                    r.date.unwrap_or_default()
                ));
                continue;
            };
            let amount = match r.amount.as_deref().map(|a| parse_amount(a, dc)) {
                Some(Ok(a)) => a,
                Some(Err(e)) => {
                    warnings.push(format!("Line {}: {e}", r.line));
                    continue;
                }
                None => {
                    warnings.push(format!("Line {}: missing amount", r.line));
                    continue;
                }
            };
            let mut t = StatementTxn::new(
                this,
                date,
                amount,
                r.payee
                    .clone()
                    .or_else(|| r.memo.clone())
                    .unwrap_or_default(),
            );
            t.memo = r.memo;
            t.check_number = r.num;
            t.category = r.category;
            t.cleared = r.cleared;
            for (cat, memo, amt) in r.splits {
                match amt.as_deref().map(|a| parse_amount(a, dc)) {
                    Some(Ok(a)) => t.splits.push(StatementSplit {
                        category: cat,
                        memo,
                        amount: a,
                    }),
                    _ => warnings.push(format!(
                        "Line {}: split without a valid amount ignored",
                        r.line
                    )),
                }
            }
            txns.push(t);
        }
        out_sections.push(StatementSection {
            account: s.account,
            transactions: txns,
            ledger_balance: None,
        });
    }
    Ok(ParsedStatement {
        format: ImportFormat::Qif,
        encoding: String::new(),
        sections: out_sections,
        warnings,
        date_ambiguity: ambiguity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bank_register_with_splits() {
        let q = "!Type:Bank\nD1/ 5'26\nT-1,234.56\nPLANDLORD LLC\nMJanuary rent\nN1001\nLHousing:Rent\nCX\n^\n\
                 D1/15'26\nT2,500.00\nPACME PAYROLL\nLIncome:Salary\n^\n\
                 D1/20'26\nT-100.00\nPCOSTCO\nSGroceries\n$-60.00\nSHousehold\nEpaper\n$-40.00\n^\n";
        let st = parse(q, None, &ImportOptions::default()).unwrap();
        let t: Vec<_> = st.transactions().collect();
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].date.to_string(), "2026-01-05");
        assert_eq!(t[0].amount, "-1234.56".parse().unwrap());
        assert_eq!(t[0].check_number.as_deref(), Some("1001"));
        assert_eq!(t[0].category.as_deref(), Some("Housing:Rent"));
        assert_eq!(t[2].splits.len(), 2);
        assert_eq!(t[2].splits[1].memo.as_deref(), Some("paper"));
        assert_eq!(
            st.sections[0]
                .account
                .as_ref()
                .unwrap()
                .account_type
                .as_deref(),
            Some("Bank")
        );
        assert!(st.date_ambiguity.is_empty());
    }

    #[test]
    fn multi_account_skip_invst_and_ambiguity() {
        let q = "!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/02/2026\nT-5\nPA\n^\nD02/03/2026\nT-6\nPB\n^\n\
                 !Type:Invst\nD1/1'26\nNBuy\nYAAPL\n^\n\
                 !Account\nNVisa\nTCCard\n^\n!Type:CCard\nD03/04/2026\nU-7\nPC\n^\n";
        let st = parse(q, None, &ImportOptions::default()).unwrap();
        assert_eq!(st.sections.len(), 2);
        assert_eq!(
            st.sections[0].account.as_ref().unwrap().name.as_deref(),
            Some("Checking")
        );
        assert_eq!(
            st.sections[1].account.as_ref().unwrap().name.as_deref(),
            Some("Visa")
        );
        assert_eq!(st.sections[1].transactions[0].amount, "-7".parse().unwrap());
        assert!(st.warnings.iter().any(|w| w.contains("invst")));
        assert_eq!(st.date_ambiguity, vec![DateFormat::Mdy, DateFormat::Dmy]);
        let st = parse(q, Some(DateFormat::Dmy), &ImportOptions::default()).unwrap();
        assert_eq!(
            st.sections[0].transactions[0].date.to_string(),
            "2026-02-01"
        );
    }

    #[test]
    fn bad_records_become_warnings() {
        let q = "!Type:Cash\nDgarbage\nT-1\n^\nD1/1'26\nTabc\n^\nD1/2'26\nT-2\n";
        let st = parse(q, Some(DateFormat::QifMdy), &ImportOptions::default()).unwrap();
        assert_eq!(st.row_count(), 1, "trailing record without ^ is kept");
        assert_eq!(st.warnings.len(), 2);
        assert!(parse("!Type:Cat\nNFood\n^\n", None, &ImportOptions::default()).is_err());
    }
}
