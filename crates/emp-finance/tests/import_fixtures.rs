//! End-to-end import tests over fixture statements in `tests/fixtures/`.

use std::collections::HashSet;

use emp_finance::Decimal;
use emp_finance::dedupe::Existing;
use emp_finance::import::preview::{PreviewContext, preview};
use emp_finance::import::{DateFormat, ImportFormat, ImportMapping, ImportOptions, parse, start};
use emp_finance::payee::PayeeAliases;
use emp_finance::rules::{CategoryLearner, RuleSet};
use emp_finance::transfers::TransferCandidate;

fn fixture(name: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read(p).expect("fixture")
}

fn d(s: &str) -> Decimal {
    s.parse().expect("decimal")
}

#[test]
fn card_csv_with_invert() {
    let bytes = fixture("card_export.csv");
    let s = start(&bytes, Some("card_export.csv"), &ImportOptions::default()).unwrap();
    assert_eq!(s.format, ImportFormat::Csv);
    assert_eq!(s.row_count, 8);
    assert_eq!(s.columns.as_ref().unwrap()[2], "Description");
    assert!(s.header_fingerprint.is_some());
    let mut m = s.mapping_guess.clone();
    assert_eq!((m.date, m.payee, m.amount), (Some(0), Some(2), Some(5)));
    assert_eq!(m.date_format, Some(DateFormat::Mdy));
    m.invert = true;
    let st = parse(
        &bytes,
        Some("card_export.csv"),
        Some(&m),
        &ImportOptions::default(),
    )
    .unwrap();
    let t: Vec<_> = st.transactions().collect();
    assert_eq!(t[1].amount, d("-1204.99"));
    assert_eq!(t[4].amount, d("500.00"));
    assert!(st.warnings.is_empty(), "{:?}", st.warnings);
}

#[test]
fn european_windows_1252_csv() {
    let bytes = fixture("bank_eu_1252.csv");
    let s = start(&bytes, None, &ImportOptions::default()).unwrap();
    assert!(
        s.encoding.starts_with("windows-125") || s.encoding.starts_with("ISO-8859"),
        "{}",
        s.encoding
    );
    let m = &s.mapping_guess;
    assert!(m.decimal_comma);
    assert_eq!(m.date_format, Some(DateFormat::DmyDot));
    assert_eq!(
        (m.date, m.payee, m.memo, m.amount, m.balance),
        (Some(0), Some(1), Some(2), Some(3), Some(4))
    );
    assert_eq!(s.warnings.len(), 1, "preamble lines reported");
    let st = parse(&bytes, None, Some(m), &ImportOptions::default()).unwrap();
    let t: Vec<_> = st.transactions().collect();
    assert_eq!(t[0].payee, "Café Müller");
    assert_eq!(t[0].amount, d("-12.50"));
    assert_eq!(t[2].amount, d("-1200.00"));
    assert_eq!(t[3].balance, Some(d("3203.20")));
}

#[test]
fn utf16_csv() {
    let bytes = fixture("utf16_bank.csv");
    let s = start(&bytes, None, &ImportOptions::default()).unwrap();
    assert_eq!(s.encoding, "UTF-16LE");
    let st = parse(
        &bytes,
        None,
        Some(&s.mapping_guess),
        &ImportOptions::default(),
    )
    .unwrap();
    assert_eq!(st.row_count(), 3);
    assert_eq!(
        st.transactions().map(|t| t.amount).sum::<Decimal>(),
        d("1517.83")
    );
}

#[test]
fn ambiguous_dates_ask_once() {
    let bytes = fixture("ambiguous.csv");
    let s = start(&bytes, None, &ImportOptions::default()).unwrap();
    assert_eq!(s.date_ambiguity, vec![DateFormat::Mdy, DateFormat::Dmy]);
    let mut m: ImportMapping = s.mapping_guess.clone();
    m.date_format = Some(DateFormat::Dmy);
    let st = parse(&bytes, None, Some(&m), &ImportOptions::default()).unwrap();
    assert_eq!(
        st.transactions().next().unwrap().date.to_string(),
        "2026-02-01"
    );
}

#[test]
fn ofx_v1_checking() {
    let bytes = fixture("checking.ofx");
    let s = start(&bytes, Some("checking.ofx"), &ImportOptions::default()).unwrap();
    assert_eq!(s.format, ImportFormat::Ofx);
    assert_eq!(s.row_count, 7);
    assert_eq!(s.account.as_ref().unwrap().last4().as_deref(), Some("7788"));
    let st = parse(
        &bytes,
        Some("checking.ofx"),
        None,
        &ImportOptions::default(),
    )
    .unwrap();
    let sec = &st.sections[0];
    assert_eq!(sec.ledger_balance.as_ref().unwrap().amount, d("5553.63"));
    assert_eq!(sec.transactions[4].payee, "CITY POWER & LIGHT");
    assert_eq!(sec.transactions[1].check_number.as_deref(), Some("1042"));
    let opening = d("5553.63") - sec.transactions.iter().map(|t| t.amount).sum::<Decimal>();
    assert_eq!(opening, d("2000.00"));
}

#[test]
fn qfx_card_tolerates_garbage() {
    let bytes = fixture("card.qfx");
    let st = parse(&bytes, Some("card.qfx"), None, &ImportOptions::default()).unwrap();
    assert_eq!(st.format, ImportFormat::Qfx);
    assert_eq!(st.row_count(), 3);
    assert_eq!(
        st.sections[0]
            .account
            .as_ref()
            .unwrap()
            .account_type
            .as_deref(),
        Some("CREDITCARD")
    );
}

#[test]
fn qif_register() {
    let bytes = fixture("register.qif");
    let s = start(&bytes, Some("register.qif"), &ImportOptions::default()).unwrap();
    assert_eq!(s.format, ImportFormat::Qif);
    assert_eq!(
        s.account.as_ref().unwrap().name.as_deref(),
        Some("Everyday Checking")
    );
    let st = parse(&bytes, None, None, &ImportOptions::default()).unwrap();
    let t: Vec<_> = st.transactions().collect();
    assert_eq!(t.len(), 4);
    assert_eq!(t[2].splits.len(), 2);
    assert_eq!(
        t[2].splits.iter().map(|s| s.amount).sum::<Decimal>(),
        t[2].amount
    );
    assert_eq!(t[3].payee, "City Power & Light");
}

#[test]
fn reimport_dedupes_and_pairs_transfers() {
    let chk = parse(
        &fixture("checking.ofx"),
        Some("checking.ofx"),
        None,
        &ImportOptions::default(),
    )
    .unwrap();
    let sav = parse(
        &fixture("savings_v2.ofx"),
        Some("savings_v2.ofx"),
        None,
        &ImportOptions::default(),
    )
    .unwrap();
    let owned: HashSet<String> = ["chk", "sav"].iter().map(|s| s.to_string()).collect();
    let aliases = PayeeAliases::new();
    let rules = RuleSet::default();
    let learner = CategoryLearner::new();
    // Savings rows already in the ledger.
    let others: Vec<TransferCandidate> = sav
        .transactions()
        .enumerate()
        .map(|(i, t)| TransferCandidate {
            id: format!("sav{i}"),
            account_id: "sav".into(),
            date: t.date,
            amount: t.amount,
            linked: false,
        })
        .collect();
    let rows: Vec<_> = chk.transactions().cloned().collect();
    let cx = PreviewContext {
        account_id: "chk",
        format: chk.format,
        existing: &[],
        aliases: &aliases,
        rules: &rules,
        learner: &learner,
        other_accounts: &others,
        owned_accounts: &owned,
    };
    let first = preview(&rows, &cx);
    assert_eq!(first.duplicates, 0);
    assert_eq!(first.rows[2].transfer_pair.as_deref(), Some("sav0"));
    assert_eq!(first.rows[3].payee, "Wholefds Mkt");
    // Commit, then import the same file again: every row is an exact duplicate.
    let existing: Vec<Existing> = first
        .rows
        .iter()
        .enumerate()
        .map(|(i, r)| Existing {
            id: format!("c{i}"),
            import_id: Some(r.import_id.clone()),
            date: r.date,
            amount: r.amount,
            payee: r.payee.clone(),
        })
        .collect();
    let again = preview(
        &rows,
        &PreviewContext {
            existing: &existing,
            ..cx
        },
    );
    assert_eq!(again.duplicates, rows.len());
    assert_eq!(again.new_count, 0);
}

#[test]
fn hardening_limits() {
    let bytes = fixture("card_export.csv");
    let mut o = ImportOptions::default();
    o.limits.confirm_bytes = 100;
    assert!(matches!(
        start(&bytes, None, &o),
        Err(emp_finance::FinanceError::NeedsConfirmation(_))
    ));
    o.confirmed_large = true;
    assert!(start(&bytes, None, &o).is_ok());
    o.limits.max_bytes = 100;
    assert!(matches!(
        start(&bytes, None, &o),
        Err(emp_finance::FinanceError::TooLarge(_))
    ));
    // Garbage never panics.
    for junk in [
        &b"\xff\xfe\x00"[..],
        b"OFXHEADER:100\n<OFX><<<>>>",
        b"!Type:Bank\n^\n^\n",
        b"\"unterminated,1,2\n",
        b"",
    ] {
        let _ = start(junk, None, &ImportOptions::default());
        let _ = parse(junk, None, None, &ImportOptions::default());
    }
}

#[test]
fn random_bytes_never_panic() {
    let mut rng = emp_finance::rng::SplitMix64::new(1234);
    let seeds: [&[u8]; 4] = [
        b"OFXHEADER:100\n\n<OFX><STMTRS><BANKTRANLIST><STMTTRN><TRNAMT>",
        b"!Type:Bank\nD1/1'26\nT",
        b"Date,Amount\n2026-01-01,",
        b"<?xml version=\"1.0\"?><?OFX?><OFX><STMTRS>",
    ];
    for i in 0..400 {
        let mut buf = seeds[i % seeds.len()].to_vec();
        for _ in 0..rng.below(200) {
            let alphabet = b"<>/!^DTPM0123456789.,;-()\"\n\r\t &#xCRDR'";
            buf.push(if rng.below(4) == 0 {
                rng.next_u64() as u8
            } else {
                alphabet[rng.below(alphabet.len())]
            });
        }
        let _ = start(&buf, None, &ImportOptions::default());
        let _ = parse(&buf, None, None, &ImportOptions::default());
    }
}
