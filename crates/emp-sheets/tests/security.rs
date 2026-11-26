//! Regression tests for hostile inputs: formula resource exhaustion, xlsx bombs and CSV injection.
//!
//! Every case here used to abort the process (allocation failure), hang, or produce output the
//! limits are meant to prevent.
#![cfg(feature = "io")]

use emp_sheets::host::CacheHost;
use emp_sheets::io::ImportOptions;
use emp_sheets::io::csv::export_csv;
use emp_sheets::io::xlsx_export::export_xlsx;
use emp_sheets::io::xlsx_import::import_xlsx;
use emp_sheets::{CellEdit, StylePatch, Value, Workbook};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn eval_on_second_sheet(setup: &[(u32, u32, &str)], formula: &str) -> String {
    let mut w = Workbook::new();
    let data = w.sheets()[0].id;
    let edits: Vec<CellEdit> = setup
        .iter()
        .map(|(r, c, t)| CellEdit {
            row: *r,
            col: *c,
            input: Some((*t).to_string()),
        })
        .collect();
    w.set_cells(data, &edits, None).expect("setup");
    let s = w.add_sheet(Some("Calc"), None).expect("sheet");
    let started = Instant::now();
    w.set_input(s, 0, 0, formula).expect("formula");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{formula} took {:?}",
        started.elapsed()
    );
    w.display(s, 0, 0)
}

#[test]
fn broadcasting_is_bounded_before_allocation() {
    // A column against a row used to allocate rows × cols values (24 TB here) and abort.
    assert_eq!(
        eval_on_second_sheet(&[], "=SUM(SEQUENCE(1000000)*TRANSPOSE(SEQUENCE(1000000)))"),
        "#CALC!"
    );
    assert_eq!(
        eval_on_second_sheet(
            &[],
            "=SUM(IF(SEQUENCE(1000000)>0,TRANSPOSE(SEQUENCE(1000000))))"
        ),
        "#CALC!"
    );
    // Whole column × whole row of a sheet whose used area is the full grid.
    let corners = [(0, 0, "5"), (1_048_575, 16_383, "7")];
    assert_eq!(
        eval_on_second_sheet(&corners, "=SUM(Sheet1!A:A*Sheet1!1:1)"),
        "#CALC!"
    );
    assert_eq!(
        eval_on_second_sheet(&corners, "=SUM(Sheet1!A:A&Sheet1!1:1)"),
        "#CALC!"
    );
    // Ordinary broadcasting still works.
    assert_eq!(
        eval_on_second_sheet(&[], "=SUM(SEQUENCE(3)*TRANSPOSE(SEQUENCE(3)))"),
        "36"
    );
    assert_eq!(
        eval_on_second_sheet(&[], "=SUM(IF(SEQUENCE(2)>1,TRANSPOSE(SEQUENCE(3)),0))"),
        "6"
    );
}

#[test]
fn combinatorics_do_not_loop_for_huge_arguments() {
    // PERMUT used to loop k times (k ≈ 1e300, i.e. forever); COMBIN took seconds.
    assert_eq!(eval_on_second_sheet(&[], "=PERMUT(1E+300,1E+300)"), "#NUM!");
    assert_eq!(
        eval_on_second_sheet(&[], "=PERMUT(1000000000,1000000000)"),
        "#NUM!"
    );
    assert_eq!(eval_on_second_sheet(&[], "=COMBIN(1E+15,1E+14)"), "#NUM!");
    assert_eq!(
        eval_on_second_sheet(&[], "=COMBIN(1000000000,500000000)"),
        "#NUM!"
    );
    assert_eq!(eval_on_second_sheet(&[], "=PERMUT(5,2)"), "20");
    assert_eq!(eval_on_second_sheet(&[], "=PERMUT(3,3)"), "6");
    assert_eq!(eval_on_second_sheet(&[], "=COMBIN(10,3)"), "120");
    assert!(eval_on_second_sheet(&[], "=PERMUT(170,170)").starts_with("7.2574156"));
}

#[test]
fn substitute_rejects_oversized_results_before_building_them() {
    // 32,767 × 32,767 four-byte characters would be a 4 GiB string.
    let f = "=LEN(SUBSTITUTE(REPT(\"\u{1F600}\",32767),\"\u{1F600}\",REPT(\"\u{1F600}\",32767)))";
    assert_eq!(eval_on_second_sheet(&[], f), "#VALUE!");
    assert_eq!(
        eval_on_second_sheet(&[], "=SUBSTITUTE(\"a-b-c\",\"-\",\"+\")"),
        "a+b+c"
    );
}

#[test]
fn row_dialect_replace_is_bounded() {
    use emp_sheets::dialect::row::{MapRowContext, eval_str};
    let ctx = MapRowContext::default();
    let long = "x".repeat(30_000);
    let src = format!("replaceAll(\"{long}\", \".\", \"{long}\")");
    let r = eval_str(&src, &ctx);
    assert!(r.is_err(), "oversized replace must fail, got {r:?}");
    let ok = eval_str("replaceAll(\"a-b-c\", \"-\", \"+\")", &ctx);
    assert_eq!(ok.map(|v| v.display).ok().as_deref(), Some("a+b+c"));
    let first = eval_str("replace(\"a-b-c\", \"-\", \"$0$0\")", &ctx);
    assert_eq!(first.map(|v| v.display).ok().as_deref(), Some("a--b-c"));
}

/// Rebuild an exported xlsx with some parts replaced (or added).
fn patch_xlsx(base: &[u8], parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut src = zip::ZipArchive::new(std::io::Cursor::new(base)).expect("zip");
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut out = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for i in 0..src.len() {
            let mut f = src.by_index(i).expect("entry");
            let name = f.name().to_string();
            if parts.iter().any(|(n, _)| *n == name) {
                continue;
            }
            let mut data = Vec::new();
            f.read_to_end(&mut data).expect("read");
            out.start_file(name, opts).expect("start");
            out.write_all(&data).expect("write");
        }
        for (name, data) in parts {
            out.start_file(*name, opts).expect("start");
            out.write_all(data).expect("write");
        }
        out.finish().expect("finish");
    }
    buf.into_inner()
}

fn one_sheet_xlsx() -> Vec<u8> {
    let mut w = Workbook::empty(Arc::new(CacheHost::new()));
    let s = w.add_sheet(Some("Data"), None).expect("sheet");
    w.set_input(s, 0, 0, "1").expect("input");
    export_xlsx(&w).expect("export")
}

fn sheet_xml(body: &str) -> Vec<u8> {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{body}</worksheet>"#
    )
    .into_bytes()
}

#[test]
fn sparse_corner_cells_do_not_allocate_the_whole_grid() {
    // Two cells at opposite corners: calamine's dense range would need 17 billion entries.
    let xml = sheet_xml(
        r#"<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>2</v></c></row></sheetData>"#,
    );
    let bytes = patch_xlsx(&one_sheet_xlsx(), &[("xl/worksheets/sheet1.xml", &xml)]);
    let r = import_xlsx(
        &bytes,
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    )
    .expect("import");
    let s = r.workbook.sheets()[0].id;
    assert_eq!(r.workbook.value(s, 0, 0), Value::Number(1.0));
    assert_eq!(r.workbook.value(s, 1_048_575, 16_383), Value::Number(2.0));
}

#[test]
fn cells_outside_the_grid_are_dropped_with_a_warning() {
    let xml = sheet_xml(
        r#"<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="XFE1"><v>2</v></c></row><row r="2000000"><c r="A2000000"><v>3</v></c></row></sheetData>"#,
    );
    let bytes = patch_xlsx(&one_sheet_xlsx(), &[("xl/worksheets/sheet1.xml", &xml)]);
    let r = import_xlsx(
        &bytes,
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    )
    .expect("import");
    let s = r.workbook.sheets()[0].id;
    assert_eq!(r.workbook.value(s, 0, 0), Value::Number(1.0));
    assert!(
        r.warnings.iter().any(|w| w.contains("outside")),
        "{:?}",
        r.warnings
    );
}

#[test]
fn repeated_column_spans_do_not_multiply() {
    // 20,000 full-width `<col>` elements used to expand to 327 million width entries.
    // Vary the attributes so the part stays under the 100:1 compression-ratio limit.
    let mut x: u64 = 0x2545_f491_4f6c_dd1d;
    let cols: String = (0..20_000)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            format!(
                r#"<col min="{}" max="16384" width="{}.{}" customWidth="1"/>"#,
                x % 97 + 1,
                x % 89 + 1,
                x % 9973
            )
        })
        .collect();
    let xml = sheet_xml(&format!(
        r#"<cols>{cols}<col min="4294967295" max="4294967295" width="3" customWidth="1"/></cols><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>"#
    ));
    let bytes = patch_xlsx(&one_sheet_xlsx(), &[("xl/worksheets/sheet1.xml", &xml)]);
    let started = Instant::now();
    let r = import_xlsx(
        &bytes,
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    )
    .expect("import");
    assert!(started.elapsed() < Duration::from_secs(20));
    let s = r.workbook.sheets()[0].id;
    assert_eq!(r.workbook.value(s, 0, 0), Value::Number(1.0));
}

/// Patch the declared uncompressed size of every entry named `name` (local header and central
/// directory) to `size`, as a hostile archive would.
fn lie_about_size(zip_bytes: &mut [u8], name: &str, size: u32) {
    let n = name.as_bytes();
    let mut i = 0;
    while i + 46 <= zip_bytes.len() {
        let sig = &zip_bytes[i..i + 4];
        if sig == b"PK\x03\x04" {
            let len = u16::from_le_bytes([zip_bytes[i + 26], zip_bytes[i + 27]]) as usize;
            if zip_bytes.get(i + 30..i + 30 + len) == Some(n) {
                zip_bytes[i + 22..i + 26].copy_from_slice(&size.to_le_bytes());
            }
        } else if sig == b"PK\x01\x02" {
            let len = u16::from_le_bytes([zip_bytes[i + 28], zip_bytes[i + 29]]) as usize;
            if zip_bytes.get(i + 46..i + 46 + len) == Some(n) {
                zip_bytes[i + 24..i + 28].copy_from_slice(&size.to_le_bytes());
            }
        }
        i += 1;
    }
}

#[test]
fn entries_larger_than_declared_are_rejected() {
    // A 4 MiB sheet that claims to be 1 KiB passes the size and ratio checks on its header
    // alone; calamine would then inflate all of it.
    let rows: String = (1..=40_000)
        .map(|r| format!(r#"<row r="{r}"><c r="A{r}"><v>{r}</v></c></row>"#))
        .collect();
    let xml = sheet_xml(&format!("<sheetData>{rows}</sheetData>"));
    let mut bytes = patch_xlsx(&one_sheet_xlsx(), &[("xl/worksheets/sheet1.xml", &xml)]);
    lie_about_size(&mut bytes, "xl/worksheets/sheet1.xml", 1024);
    let r = import_xlsx(
        &bytes,
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    );
    assert!(r.is_err(), "lying entry accepted");
}

#[test]
fn import_warnings_are_capped() {
    let cells: String = (1..=1_000)
        .map(|r| format!(r#"<row r="{r}"><c r="A{r}"><f>[1]Other!A1</f><v>0</v></c></row>"#))
        .collect();
    let xml = sheet_xml(&format!("<sheetData>{cells}</sheetData>"));
    let bytes = patch_xlsx(&one_sheet_xlsx(), &[("xl/worksheets/sheet1.xml", &xml)]);
    let r = import_xlsx(
        &bytes,
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    )
    .expect("import");
    assert!(r.warnings.len() <= 201, "{} warnings", r.warnings.len());
    assert!(
        r.warnings
            .last()
            .is_some_and(|w| w.contains("more warning"))
    );
}

#[test]
fn csv_export_protects_numbers_whose_format_renders_a_formula() {
    let mut w = Workbook::empty(Arc::new(CacheHost::new()));
    let s = w.add_sheet(Some("S"), None).expect("sheet");
    w.set_input(s, 0, 0, "5").expect("input");
    w.set_input(s, 0, 1, "-5").expect("input");
    w.set_input(s, 0, 2, "-1234.5").expect("input");
    let patch: StylePatch = serde_json::from_value(serde_json::json!({
        "numFmt": "\"=cmd|' /C calc'!A0\""
    }))
    .expect("patch");
    w.set_style(s, &[emp_sheets::Rect::cell(0, 0)], &patch)
        .expect("style");
    let money: StylePatch =
        serde_json::from_value(serde_json::json!({ "numFmt": "$#,##0.00" })).expect("patch");
    w.set_style(s, &[emp_sheets::Rect::cell(0, 2)], &money)
        .expect("style");
    assert!(
        w.display(s, 0, 0).starts_with('='),
        "{}",
        w.display(s, 0, 0)
    );
    let out = String::from_utf8(export_csv(&w, s, true).expect("csv")).expect("utf8");
    let first = out.lines().next().unwrap_or_default();
    assert!(
        first.starts_with("\"'=cmd") || first.starts_with("'=cmd"),
        "{first}"
    );
    // Plain negative numbers stay numbers.
    assert!(first.contains(",-5,"), "{first}");
    assert!(first.contains("-$1,234.50"), "{first}");
}

#[test]
fn csv_records_with_huge_field_counts_are_bounded() {
    use emp_sheets::io::csv::{import_csv, read_rows};
    // One record of 20 million empty fields (20 MB): the csv crate kept a bound per field and we
    // kept a String per field, ~650 MB for 20 MB of input (and proportionally more for 1 GiB).
    let mut wide = vec![b','; 20_000_000];
    wide.extend_from_slice(b"\nx,y\n");
    let started = Instant::now();
    let (_, rows) = read_rows(&wide, 10).expect("rows");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].len(), 16_384);
    assert_eq!(rows[1], vec!["x".to_string(), "y".to_string()]);
    let r = import_csv(
        &wide,
        "S",
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    )
    .expect("import");
    let s = r.workbook.sheets()[0].id;
    assert_eq!(r.workbook.value(s, 1, 1), Value::text("y"));
    assert!(started.elapsed() < Duration::from_secs(30));
    // Quoting, embedded separators, CRLF and blank lines behave as before.
    let (_, rows) = read_rows(b"a,\"b,\"\"c\"\"\"\r\n\r\n\n1,2\n", 10).expect("rows");
    assert_eq!(
        rows,
        vec![
            vec!["a".to_string(), "b,\"c\"".to_string()],
            vec!["1".to_string(), "2".to_string()]
        ]
    );
    let (_, rows) = read_rows(b"a,b", 10).expect("rows");
    assert_eq!(rows, vec![vec!["a".to_string(), "b".to_string()]]);
    let (_, rows) = read_rows(b"", 10).expect("rows");
    assert!(rows.is_empty());
}

#[test]
fn text_search_and_join_are_bounded() {
    // SEARCH with wildcards tried every start × every end with a glob matcher (O(n³·m)).
    let f = "=SEARCH(REPT(\"?\",16000)&\"b\",REPT(\"a\",32000))";
    assert_eq!(eval_on_second_sheet(&[], f), "#VALUE!");
    let f = "=SEARCH(REPT(\"*a\",10000)&\"b\",REPT(\"a\",32000))";
    let v = eval_on_second_sheet(&[], f);
    assert!(v.starts_with('#'), "{v}");
    // Semantics are unchanged.
    assert_eq!(eval_on_second_sheet(&[], "=SEARCH(\"B?D\",\"abcde\")"), "2");
    assert_eq!(eval_on_second_sheet(&[], "=SEARCH(\"c*e\",\"abcde\")"), "3");
    assert_eq!(eval_on_second_sheet(&[], "=SEARCH(\"~*\",\"a*b\")"), "2");
    assert_eq!(eval_on_second_sheet(&[], "=SEARCH(\"B\",\"abcb\",3)"), "4");
    assert_eq!(
        eval_on_second_sheet(&[], "=SEARCH(\"É\",\"cafétéria\")"),
        "4"
    );
    assert_eq!(
        eval_on_second_sheet(&[], "=SEARCH(\"x\",\"abc\")"),
        "#VALUE!"
    );
    // TEXTJOIN built the whole joined string (3 GB here) before checking its length.
    let f = "=TEXTJOIN(REPT(\"x\",32000),TRUE,SEQUENCE(100000))";
    assert_eq!(eval_on_second_sheet(&[], f), "#VALUE!");
    assert_eq!(
        eval_on_second_sheet(&[], "=TEXTJOIN(\"-\",TRUE,\"a\",\"\",\"b\")"),
        "a-b"
    );
}

#[test]
fn period_and_holiday_loops_are_bounded() {
    // `per += 1.0` stops advancing past 2^53: these looped forever (or for seconds).
    assert_eq!(
        eval_on_second_sheet(&[], "=DDB(1,0,1E+300,1E+300)"),
        "#CALC!"
    );
    assert_eq!(
        eval_on_second_sheet(&[], "=CUMIPMT(0.1,1E+300,1,1,1E+300,0)"),
        "#CALC!"
    );
    assert!(eval_on_second_sheet(&[], "=CUMPRINC(0.1,1E+9,1,1,1E+9,0)").starts_with('#'),);
    assert_eq!(eval_on_second_sheet(&[], "=DDB(2400,300,10,2)"), "384");
    // A million holidays used to be scanned once per day and once per holiday.
    assert_eq!(
        eval_on_second_sheet(&[], "=NETWORKDAYS(1,2958465,SEQUENCE(1000000))"),
        eval_on_second_sheet(&[], "=NETWORKDAYS(1000001,2958465)")
    );
    assert_eq!(
        eval_on_second_sheet(
            &[],
            "=NETWORKDAYS(DATE(2026,1,1),DATE(2026,1,31),{46023,46023,46030})"
        ),
        "20"
    );
}

#[test]
fn lifted_array_copies_are_charged() {
    // Each of the million INDEX calls deep-copied the million-element first argument without
    // charging the operation budget, so the recalculation never paused.
    let v = eval_on_second_sheet(&[], "=SUM(INDEX(SEQUENCE(1000000),SEQUENCE(1000000)))");
    assert_eq!(v, "#CALC!");
    assert_eq!(
        eval_on_second_sheet(&[], "=SUM(INDEX(SEQUENCE(10),SEQUENCE(3)))"),
        "6"
    );
}
