//! Workbook integration tests: recalculation, spills, cycles, undo, structural edits, persistence.

use emp_sheets::host::{CacheHost, ExternalKey, ExternalValue, test_now};
use emp_sheets::workbook::ops::Axis;
use emp_sheets::workbook::sheet::CondFormatRule;
use emp_sheets::{
    CalcSettings, CellEdit, ClearWhat, FillMode, PasteMode, Rect, SortKey, StylePatch, Value,
    Workbook, parse_a1,
};
use std::sync::Arc;

fn wb() -> (Workbook, u16, Arc<CacheHost>) {
    let host = Arc::new(CacheHost::fixed(test_now(), 1));
    let mut w = Workbook::empty(host.clone());
    let id = w.add_sheet(Some("Sheet1"), None).unwrap_or(0);
    (w, id, host)
}

fn set(w: &mut Workbook, s: u16, a1: &str, input: &str) {
    let (r, c) = parse_a1(a1).unwrap_or((0, 0));
    if let Err(e) = w.set_input(s, r, c, input) {
        panic!("{a1} = {input}: {e}");
    }
}

fn get(w: &Workbook, s: u16, a1: &str) -> Value {
    let (r, c) = parse_a1(a1).unwrap_or((0, 0));
    w.value(s, r, c)
}

fn num(w: &Workbook, s: u16, a1: &str) -> f64 {
    match get(w, s, a1) {
        Value::Number(n) => n,
        other => panic!("{a1} is {other:?}"),
    }
}

#[test]
fn chain_recalculates_incrementally() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "1");
    for i in 2..=200 {
        set(&mut w, s, &format!("A{i}"), &format!("=A{}+1", i - 1));
    }
    assert_eq!(num(&w, s, "A200"), 200.0);
    let out = w.set_input(s, 0, 0, "10").unwrap_or_default();
    assert_eq!(num(&w, s, "A200"), 209.0);
    assert_eq!(out.report.changed.len(), 200);
    // Same value again → change cut-off: nothing downstream changes.
    let out = w.set_input(s, 0, 0, "10").unwrap_or_default();
    assert_eq!(out.report.changed.len(), 1);
}

#[test]
fn deep_chain_no_stack_overflow() {
    let (mut w, s, _) = wb();
    let mut edits = vec![CellEdit {
        row: 0,
        col: 0,
        input: Some("1".into()),
    }];
    for r in 1..20_000u32 {
        edits.push(CellEdit {
            row: r,
            col: 0,
            input: Some(format!("=A{}+1", r)),
        });
    }
    w.set_cells(s, &edits, None).unwrap_or_default();
    assert_eq!(num(&w, s, "A20000"), 20_000.0);
}

#[test]
fn ranges_and_whole_columns() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "C1", "=SUM(A:A)");
    set(&mut w, s, "C2", "=SUM(A1:A3)");
    set(&mut w, s, "A1", "5");
    set(&mut w, s, "A100000", "7");
    assert_eq!(num(&w, s, "C1"), 12.0);
    assert_eq!(num(&w, s, "C2"), 5.0);
    set(&mut w, s, "A2", "1");
    assert_eq!(num(&w, s, "C2"), 6.0);
    assert_eq!(num(&w, s, "C1"), 13.0);
}

#[test]
fn cycles_get_circ_and_iterative_converges() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "=B1+1");
    set(&mut w, s, "B1", "=A1");
    assert_eq!(get(&w, s, "A1").display(), "#CIRC!");
    assert_eq!(get(&w, s, "B1").display(), "#CIRC!");
    set(&mut w, s, "C1", "=SUM(C1:C2)");
    assert_eq!(get(&w, s, "C1").display(), "#CIRC!");
    // break the cycle
    set(&mut w, s, "B1", "3");
    assert_eq!(num(&w, s, "A1"), 4.0);
    // iterative: x = 0.5*x + 1 converges to 2
    w.set_calc_settings(CalcSettings {
        iterative: true,
        date1904: false,
    })
    .unwrap_or_default();
    set(&mut w, s, "D1", "=D1*0.5+1");
    let d = num(&w, s, "D1");
    assert!((d - 2.0).abs() < 0.01, "{d}");
}

#[test]
fn spill_and_blocking() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "=SEQUENCE(3)");
    assert_eq!(num(&w, s, "A3"), 3.0);
    set(&mut w, s, "B1", "=SUM(A1#)");
    set(&mut w, s, "C1", "=A2*10");
    assert_eq!(num(&w, s, "B1"), 6.0);
    assert_eq!(num(&w, s, "C1"), 20.0);
    // Block the spill.
    set(&mut w, s, "A2", "x");
    assert_eq!(get(&w, s, "A1").display(), "#SPILL!");
    assert_eq!(get(&w, s, "A3"), Value::Empty);
    assert_eq!(get(&w, s, "B1").display(), "#SPILL!");
    // Unblock.
    w.set_cells(
        s,
        &[CellEdit {
            row: 1,
            col: 0,
            input: None,
        }],
        None,
    )
    .unwrap_or_default();
    assert_eq!(num(&w, s, "A2"), 2.0);
    assert_eq!(num(&w, s, "B1"), 6.0);
    assert_eq!(num(&w, s, "C1"), 20.0);
    // Resize the spill: dependents of newly covered cells update.
    set(&mut w, s, "D1", "=A5");
    assert_eq!(num(&w, s, "D1"), 0.0);
    set(&mut w, s, "A1", "=SEQUENCE(5)");
    assert_eq!(num(&w, s, "D1"), 5.0);
    let info = w.cell_info(s, 3, 0);
    assert_eq!(info.spill_of.as_deref(), Some("A1"));
    // Two spills colliding.
    set(&mut w, s, "F1", "=SEQUENCE(3)");
    set(&mut w, s, "F2", "=1");
    assert_eq!(get(&w, s, "F1").display(), "#SPILL!");
}

#[test]
fn undo_redo() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "1");
    set(&mut w, s, "A2", "=A1*2");
    set(&mut w, s, "A1", "5");
    assert_eq!(num(&w, s, "A2"), 10.0);
    w.undo();
    assert_eq!(num(&w, s, "A2"), 2.0);
    w.undo();
    assert_eq!(get(&w, s, "A2"), Value::Empty);
    w.redo();
    assert_eq!(num(&w, s, "A2"), 2.0);
    w.redo();
    assert_eq!(num(&w, s, "A2"), 10.0);
    assert!(w.redo().is_none());
    // grouped typing
    w.set_cells(
        s,
        &[CellEdit {
            row: 5,
            col: 0,
            input: Some("a".into()),
        }],
        Some("g1"),
    )
    .unwrap_or_default();
    w.set_cells(
        s,
        &[CellEdit {
            row: 6,
            col: 0,
            input: Some("b".into()),
        }],
        Some("g1"),
    )
    .unwrap_or_default();
    w.undo();
    assert_eq!(get(&w, s, "A6"), Value::Empty);
    assert_eq!(get(&w, s, "A7"), Value::Empty);
}

#[test]
fn bad_formula_reported_not_applied() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "1");
    let out = w
        .set_cells(
            s,
            &[CellEdit {
                row: 0,
                col: 0,
                input: Some("=1+".into()),
            }],
            None,
        )
        .unwrap_or_default();
    assert_eq!(out.errors.len(), 1);
    assert_eq!(num(&w, s, "A1"), 1.0);
    let out = w
        .set_cells(
            s,
            &[CellEdit {
                row: 0,
                col: 1,
                input: Some("=ROUND(1)".into()),
            }],
            None,
        )
        .unwrap_or_default();
    assert!(out.errors[0].message.contains("ROUND"));
}

#[test]
fn structural_edits_rewrite_references() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "1");
    set(&mut w, s, "A2", "2");
    set(&mut w, s, "A3", "3");
    set(&mut w, s, "B1", "=SUM(A1:A3)");
    set(&mut w, s, "B2", "=A3*10");
    w.insert_span(s, Axis::Rows, 1, 2).unwrap_or_default();
    // A2→A4, A3→A5; B2→B4
    assert_eq!(w.cell_info(s, 0, 1).input, "=SUM(A1:A5)");
    assert_eq!(w.cell_info(s, 3, 1).input, "=A5*10");
    assert_eq!(num(&w, s, "B1"), 6.0);
    set(&mut w, s, "A2", "100");
    assert_eq!(num(&w, s, "B1"), 106.0);
    w.delete_span(s, Axis::Rows, 4, 1).unwrap_or_default(); // delete row 5 (old A3)
    assert_eq!(w.cell_info(s, 3, 1).input, "=#REF!*10");
    assert_eq!(get(&w, s, "B4").display(), "#REF!");
    assert_eq!(w.cell_info(s, 0, 1).input, "=SUM(A1:A4)");
    // undo the delete restores everything
    w.undo();
    assert_eq!(w.cell_info(s, 3, 1).input, "=A5*10");
    assert_eq!(num(&w, s, "B4"), 30.0);
    w.undo(); // the A2 edit
    w.undo(); // the insert
    assert_eq!(w.cell_info(s, 0, 1).input, "=SUM(A1:A3)");
    assert_eq!(w.cell_info(s, 1, 1).input, "=A3*10");
    // columns
    w.insert_span(s, Axis::Cols, 0, 1).unwrap_or_default();
    assert_eq!(w.cell_info(s, 0, 2).input, "=SUM(B1:B3)");
    assert_eq!(num(&w, s, "C1"), 6.0);
}

#[test]
fn sheets_rename_and_cross_sheet() {
    let (mut w, s, _) = wb();
    let d = w.add_sheet(Some("Data"), None).unwrap_or(0);
    set(&mut w, d, "A1", "42");
    set(&mut w, s, "A1", "=Data!A1+1");
    assert_eq!(num(&w, s, "A1"), 43.0);
    w.update_sheet(d, Some("My Data"), None, None)
        .unwrap_or_default();
    assert_eq!(w.cell_info(s, 0, 0).input, "='My Data'!A1+1");
    set(&mut w, d, "A1", "1");
    assert_eq!(num(&w, s, "A1"), 2.0);
    w.remove_sheet(d).unwrap_or_default();
    assert_eq!(get(&w, s, "A1").display(), "#REF!");
    w.undo();
    assert_eq!(num(&w, s, "A1"), 2.0);
    assert!(w.add_sheet(Some("Sheet1"), None).is_err());
    assert!(w.add_sheet(Some("a:b"), None).is_err());
}

#[test]
fn named_ranges() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "B2", "0.05");
    w.set_named_range("Rate", Some("Sheet1!$B$2"))
        .unwrap_or_default();
    set(&mut w, s, "A1", "=Rate*100");
    assert!((num(&w, s, "A1") - 5.0).abs() < 1e-12);
    set(&mut w, s, "B2", "0.1");
    assert!((num(&w, s, "A1") - 10.0).abs() < 1e-12);
    w.set_named_range("Rate", Some("Sheet1!$B$3"))
        .unwrap_or_default();
    set(&mut w, s, "B3", "0.2");
    assert!((num(&w, s, "A1") - 20.0).abs() < 1e-12);
    w.set_named_range("Rate", None).unwrap_or_default();
    assert_eq!(get(&w, s, "A1").display(), "#NAME?");
    assert!(w.set_named_range("A1", Some("Sheet1!B2")).is_err());
}

#[test]
fn volatile_and_external_data() {
    let (mut w, s, host) = wb();
    set(&mut w, s, "A1", "=STOCK(\"AAPL\")");
    assert_eq!(get(&w, s, "A1").display(), "#FETCH!");
    let out = w.set_input(s, 0, 1, "=A1*2").unwrap_or_default();
    assert_eq!(get(&w, s, "B1").display(), "#FETCH!");
    let _ = out;
    let key = ExternalKey::Stock {
        symbol: "AAPL".into(),
        field: "price".into(),
    };
    assert_eq!(w.external_keys(), vec![key.clone()]);
    host.set(key.clone(), ExternalValue::Ready(Value::Number(100.0)));
    let rep = w.external_data_changed(&[key]);
    assert!(rep.changed.len() >= 2);
    assert_eq!(num(&w, s, "B1"), 200.0);
    set(&mut w, s, "C1", "=TODAY()");
    assert_eq!(num(&w, s, "C1"), 46352.0);
    let rep = w.recalc_volatile();
    assert!(rep.evaluated >= 1);
}

#[test]
fn op_budget_pauses() {
    let (mut w, s, _) = wb();
    w.ops_budget = 500;
    let mut edits = Vec::new();
    for r in 0..500u32 {
        edits.push(CellEdit {
            row: r,
            col: 0,
            input: Some(format!("=SUM(B1:B10)+{r}")),
        });
    }
    let out = w.set_cells(s, &edits, None).unwrap_or_default();
    assert!(out.report.paused);
    assert!(w.is_calc_paused());
    w.ops_budget = 50_000_000;
    let rep = w.resume_recalc(None);
    assert!(!rep.paused);
    assert_eq!(num(&w, s, "A500"), 499.0);
}

#[test]
fn styles_clear_and_display() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "1234.5");
    let p: StylePatch =
        serde_json::from_str(r##"{"numFmt":"#,##0.00","font":{"b":true}}"##).unwrap_or_default();
    w.set_style(s, &[Rect::cell(0, 0)], &p).unwrap_or_default();
    assert_eq!(w.display(s, 0, 0), "1,234.50");
    set(&mut w, s, "A2", "50%");
    assert_eq!(w.display(s, 1, 0), "50%");
    set(&mut w, s, "A3", "2024-01-15");
    assert_eq!(w.display(s, 2, 0), "2024-01-15");
    assert_eq!(w.cell_info(s, 2, 0).input, "2024-01-15");
    w.clear(s, &[Rect::cell(0, 0)], ClearWhat::Contents)
        .unwrap_or_default();
    assert_eq!(get(&w, s, "A1"), Value::Empty);
    set(&mut w, s, "A1", "2");
    assert_eq!(w.display(s, 0, 0), "2.00");
    w.clear(s, &[Rect::cell(0, 0)], ClearWhat::Formats)
        .unwrap_or_default();
    assert_eq!(w.display(s, 0, 0), "2");
    let packed = w.packed(s, &Rect::new(0, 0, 10, 10));
    assert_eq!(packed.len(), 3);
    assert_eq!(packed.k[0], 1);
}

#[test]
fn persistence_roundtrip() {
    let (mut w, s, host) = wb();
    let d = w.add_sheet(Some("Data"), None).unwrap_or(0);
    set(&mut w, s, "A1", "10");
    set(&mut w, s, "A2", "=A1*2");
    set(&mut w, s, "A3", "=SEQUENCE(2,2)");
    set(&mut w, d, "B1", "=Sheet1!A2+1");
    set(&mut w, s, "C1", "hello");
    w.set_named_range("Base", Some("Sheet1!$A$1"))
        .unwrap_or_default();
    set(&mut w, s, "C2", "=Base+1");
    let p: StylePatch = serde_json::from_str(r##"{"fill":"#ff0000"}"##).unwrap_or_default();
    w.set_style(s, &[Rect::cell(0, 0)], &p).unwrap_or_default();
    w.merge(s, Rect::new(10, 0, 10, 3), true)
        .unwrap_or_default();
    w.freeze(s, 1, 0).unwrap_or_default();
    let bytes = w.to_json().unwrap_or_default();
    let w2 = Workbook::from_json(&bytes, host).unwrap_or_default();
    assert_eq!(w2.sheets().len(), 2);
    assert_eq!(num(&w2, s, "A2"), 20.0);
    assert_eq!(num(&w2, s, "B4"), 4.0);
    assert_eq!(num(&w2, d, "B1"), 21.0);
    assert_eq!(num(&w2, s, "C2"), 11.0);
    assert_eq!(w2.cell_info(d, 0, 1).input, "=Sheet1!A2+1");
    assert_eq!(
        w2.styles()
            .get(
                w2.sheet(s)
                    .and_then(|x| x.cell(0, 0))
                    .map(|c| c.style)
                    .unwrap_or(0)
            )
            .fill
            .as_deref(),
        Some("#ff0000")
    );
    assert_eq!(w2.sheet(s).map(|x| x.merges.len()), Some(1));
    assert_eq!(w2.sheet(s).map(|x| x.frozen_rows), Some(1));
    // the loaded workbook keeps recalculating
    let mut w2 = w2;
    set(&mut w2, s, "A1", "1");
    assert_eq!(num(&w2, d, "B1"), 3.0);
    assert_eq!(w2.to_file(), {
        let mut w3 = w2;
        let f = w3.to_file();
        let _ = w3.recalc_all();
        f
    });
}

#[test]
fn fill_sort_copy_paste_find() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "1");
    set(&mut w, s, "A2", "3");
    w.fill(
        s,
        Rect::new(0, 0, 1, 0),
        Rect::new(0, 0, 4, 0),
        FillMode::Series,
    )
    .unwrap_or_default();
    assert_eq!(num(&w, s, "A5"), 9.0);
    set(&mut w, s, "B1", "=A1*2");
    w.fill(s, Rect::cell(0, 1), Rect::new(0, 1, 4, 1), FillMode::Copy)
        .unwrap_or_default();
    assert_eq!(w.cell_info(s, 4, 1).input, "=A5*2");
    assert_eq!(num(&w, s, "B5"), 18.0);
    set(&mut w, s, "C1", "Item 1");
    w.fill(s, Rect::cell(0, 2), Rect::new(0, 2, 2, 2), FillMode::Series)
        .unwrap_or_default();
    assert_eq!(get(&w, s, "C3"), Value::text("Item 3"));
    // sort A1:B5 descending by A
    w.sort_range(
        s,
        Rect::new(0, 0, 4, 1),
        &[SortKey { col: 0, desc: true }],
        false,
    )
    .unwrap_or_default();
    assert_eq!(num(&w, s, "A1"), 9.0);
    assert_eq!(num(&w, s, "B1"), 18.0);
    assert_eq!(w.cell_info(s, 0, 1).input, "=A1*2");
    // copy / paste
    let clip = w
        .copy_range(s, Rect::new(0, 0, 1, 1))
        .unwrap_or_else(|_| panic!("copy"));
    assert!(clip.tsv.starts_with("9\t18\n7\t14"));
    w.paste(s, (10, 3), Some(&clip.clip), None, PasteMode::All)
        .unwrap_or_default();
    assert_eq!(w.cell_info(s, 10, 4).input, "=D11*2");
    assert_eq!(num(&w, s, "E11"), 18.0);
    w.paste(s, (20, 0), None, Some("x\t1\ny\t=B21*3"), PasteMode::All)
        .unwrap_or_default();
    assert_eq!(num(&w, s, "B22"), 3.0);
    let hits = w.find("item", false, false, false);
    assert_eq!(hits.len(), 3);
    let (n, _) = w.replace("Item", "Row", true, false).unwrap_or_default();
    assert_eq!(n, 3);
    assert_eq!(get(&w, s, "C2"), Value::text("Row 2"));
}

#[test]
fn conditional_formats_and_lint() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "5");
    set(&mut w, s, "A2", "15");
    set(&mut w, s, "A3", "=1/0");
    set(&mut w, s, "A4", "'42");
    set(&mut w, s, "B1", "=A1*1.08");
    let rules = vec![
        CondFormatRule {
            id: None,
            rect: Rect::new(0, 0, 1, 0),
            kind: "cell".into(),
            op: Some("gt".into()),
            values: Some(vec!["10".into()]),
            formula: None,
            style_id: Some(3),
            colors: None,
        },
        CondFormatRule {
            id: None,
            rect: Rect::new(0, 0, 1, 0),
            kind: "formula".into(),
            op: None,
            values: None,
            formula: Some("=A1<10".into()),
            style_id: Some(4),
            colors: None,
        },
        CondFormatRule {
            id: None,
            rect: Rect::new(0, 0, 1, 0),
            kind: "data_bar".into(),
            op: None,
            values: None,
            formula: None,
            style_id: None,
            colors: None,
        },
    ];
    w.set_cond_formats(s, rules).unwrap_or_default();
    let rd = w.range_data(s, &Rect::new(0, 0, 5, 5));
    assert!(rd.cf.iter().any(|h| h.r == 1 && h.style_id == 3));
    assert!(rd.cf.iter().any(|h| h.r == 0 && h.style_id == 4));
    assert!(rd.cf.iter().any(|h| h.r == 1 && h.bar == Some(1.0)));
    let lint = w.lint();
    let rules: Vec<&str> = lint.iter().map(|l| l.rule.as_str()).collect();
    assert!(rules.contains(&"div0"));
    assert!(rules.contains(&"number_as_text"));
    assert!(rules.contains(&"hardcoded_constant"));
}

#[test]
fn eval_scalar_mode() {
    assert_eq!(
        emp_sheets::eval_scalar("=1+2").ok(),
        Some(Value::Number(3.0))
    );
    assert_eq!(
        emp_sheets::eval_scalar("=PMT(0,10,100)").ok(),
        Some(Value::Number(-10.0))
    );
    assert!(emp_sheets::eval_scalar("=1+").is_err());
    let infos = emp_sheets::function_infos();
    assert!(
        infos
            .iter()
            .any(|f| f.name == "XLOOKUP" && f.args.len() == 6)
    );
}

#[test]
fn loan_template_formulas() {
    // Spreadsheet Studio loan template (SPEC §16.5).
    let (mut w, s, _) = wb();
    set(&mut w, s, "B1", "300000"); // Principal
    set(&mut w, s, "B2", "0.06"); // Rate
    set(&mut w, s, "B3", "30"); // Years
    set(&mut w, s, "B4", "12"); // PPY
    for (n, a) in [
        ("Principal", "$B$1"),
        ("Rate", "$B$2"),
        ("Years", "$B$3"),
        ("PPY", "$B$4"),
    ] {
        w.set_named_range(n, Some(&format!("Sheet1!{a}")))
            .unwrap_or_default();
    }
    set(&mut w, s, "B5", "=PMT(Rate/PPY, Years*PPY, -Principal)");
    assert!((num(&w, s, "B5") - 1798.6515754582708).abs() < 1e-8);
    set(&mut w, s, "D1", "=SEQUENCE(Years*PPY)");
    set(
        &mut w,
        s,
        "E1",
        "=Principal+CUMPRINC(Rate/PPY,Years*PPY,Principal,1,D1#,0)",
    );
    assert!((num(&w, s, "E360")).abs() < 1e-6);
    set(&mut w, s, "F1", "=MATCH(TRUE,E1#<=0.000001,0)");
    assert_eq!(num(&w, s, "F1"), 360.0);
}

#[test]
fn memoised_whole_column_aggregates_stay_correct() {
    let (mut w, s, _) = wb();
    set(&mut w, s, "A1", "1");
    set(&mut w, s, "A2", "2");
    set(&mut w, s, "A3", "=A1*10");
    let mut edits = Vec::new();
    for r in 0..50u32 {
        edits.push(CellEdit {
            row: r,
            col: 2,
            input: Some("=SUM(A:A)+ROW()*0".into()),
        });
    }
    w.set_cells(s, &edits, None).unwrap_or_default();
    assert_eq!(num(&w, s, "C50"), 13.0);
    set(&mut w, s, "A1", "5");
    for r in 1..=50 {
        assert_eq!(num(&w, s, &format!("C{r}")), 57.0);
    }
    // A formula inside the summed column that depends on the aggregate is a cycle.
    set(&mut w, s, "A4", "=C1");
    assert_eq!(get(&w, s, "C1").display(), "#CIRC!");
    w.set_cells(
        s,
        &[CellEdit {
            row: 3,
            col: 0,
            input: None,
        }],
        None,
    )
    .unwrap_or_default();
    assert_eq!(num(&w, s, "C7"), 57.0);
}
