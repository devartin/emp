//! xlsx/csv round trips.
#![cfg(feature = "io")]

use emp_sheets::host::CacheHost;
use emp_sheets::io::ImportOptions;
use emp_sheets::io::xlsx_export::export_xlsx;
use emp_sheets::io::xlsx_import::import_xlsx;
use emp_sheets::{Rect, StylePatch, Value, Workbook};
use std::sync::Arc;

fn sample() -> Workbook {
    let mut w = Workbook::empty(Arc::new(CacheHost::new()));
    let s = w.add_sheet(Some("Inputs"), None).unwrap_or(0);
    let d = w.add_sheet(Some("Data Sheet"), None).unwrap_or(0);
    let set = |w: &mut Workbook, sh: u16, r: u32, c: u32, t: &str| {
        if let Err(e) = w.set_input(sh, r, c, t) {
            panic!("{t}: {e}");
        }
    };
    set(&mut w, s, 0, 0, "Rate");
    set(&mut w, s, 0, 1, "0.05");
    set(&mut w, s, 1, 0, "Total");
    set(&mut w, s, 1, 1, "=SUM('Data Sheet'!A1:A3)*(1+Rate)");
    set(
        &mut w,
        s,
        2,
        1,
        "=XLOOKUP(\"b\",'Data Sheet'!B1:B3,'Data Sheet'!A1:A3)",
    );
    set(&mut w, s, 3, 1, "=SEQUENCE(3)");
    set(&mut w, s, 4, 3, "TRUE");
    set(&mut w, s, 5, 3, "#N/A");
    set(&mut w, s, 6, 3, "'=not a formula");
    for (i, (n, t)) in [(1, "a"), (2, "b"), (3, "c")].iter().enumerate() {
        set(&mut w, d, i as u32, 0, &n.to_string());
        set(&mut w, d, i as u32, 1, t);
    }
    w.set_named_range("Rate", Some("Inputs!$B$1"))
        .unwrap_or_default();
    let p: StylePatch =
        serde_json::from_str(r##"{"numFmt":"0.00%","font":{"b":true},"fill":"#FFEE00"}"##)
            .unwrap_or_default();
    w.set_style(s, &[Rect::cell(0, 1)], &p).unwrap_or_default();
    w.merge(s, Rect::new(8, 0, 8, 2), true).unwrap_or_default();
    w.freeze(s, 1, 1).unwrap_or_default();
    w.resize(s, emp_sheets::Axis::Cols, &[0], Some(120.0))
        .unwrap_or_default();
    w.update_sheet(d, None, None, Some(true))
        .unwrap_or_default();
    w
}

#[test]
fn xlsx_roundtrip() {
    let w = sample();
    let s = w.sheets()[0].id;
    assert!(
        (match w.value(s, 1, 1) {
            Value::Number(n) => n,
            _ => 0.0,
        } - 6.3)
            .abs()
            < 1e-12
    );
    let bytes = match export_xlsx(&w) {
        Ok(b) => b,
        Err(e) => panic!("export: {e}"),
    };
    assert!(bytes.starts_with(b"PK"));
    let res = match import_xlsx(
        &bytes,
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    ) {
        Ok(r) => r,
        Err(e) => panic!("import: {e}"),
    };
    let w2 = res.workbook;
    assert_eq!(w2.sheets().len(), 2, "{:?}", res.warnings);
    let s2 = w2.sheets()[0].id;
    let d2 = w2.sheets()[1].id;
    assert_eq!(w2.sheets()[1].name, "Data Sheet");
    assert!(w2.sheets()[1].hidden);
    assert_eq!(
        w2.cell_info(s2, 1, 1).input,
        "=SUM('Data Sheet'!A1:A3)*(1+Rate)"
    );
    assert!(
        (match w2.value(s2, 1, 1) {
            Value::Number(n) => n,
            _ => 0.0,
        } - 6.3)
            .abs()
            < 1e-12
    );
    assert_eq!(w2.value(s2, 2, 1), Value::Number(2.0));
    assert_eq!(
        w2.cell_info(s2, 2, 1).input,
        "=XLOOKUP(\"b\",'Data Sheet'!B1:B3,'Data Sheet'!A1:A3)"
    );
    assert_eq!(
        w2.value(s2, 5, 1),
        Value::Number(3.0),
        "spill children re-adopted: {:?}",
        res.warnings
    );
    assert_eq!(w2.cell_info(s2, 5, 1).spill_of.as_deref(), Some("B4"));
    assert_eq!(w2.value(s2, 4, 3), Value::Bool(true));
    assert_eq!(w2.value(s2, 5, 3).display(), "#N/A");
    assert_eq!(w2.value(s2, 6, 3), Value::text("=not a formula"));
    assert_eq!(w2.display(s2, 0, 1), "5.00%");
    let st = w2.styles().get(w2.cell_info(s2, 0, 1).style_id).clone();
    assert_eq!(st.font.and_then(|f| f.b), Some(true));
    assert_eq!(st.fill.as_deref(), Some("#FFEE00"));
    let sheet = &w2.sheets()[0];
    assert_eq!(sheet.merges, vec![Rect::new(8, 0, 8, 2)]);
    assert_eq!((sheet.frozen_rows, sheet.frozen_cols), (1, 1));
    assert!(
        sheet
            .col_widths
            .get(&0)
            .is_some_and(|w| (*w - 120.0).abs() <= 2.0),
        "{:?}",
        sheet.col_widths
    );
    assert_eq!(
        w2.named_ranges(),
        vec![("Rate".to_string(), "Inputs!$B$1".to_string())]
    );
    assert_eq!(w2.value(d2, 1, 1), Value::text("b"));
}

#[test]
fn rejects_garbage_and_bombs() {
    assert!(
        import_xlsx(
            b"not a zip",
            Arc::new(CacheHost::new()),
            &ImportOptions::default()
        )
        .is_err()
    );
    // A highly compressible entry above the ratio limit.
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if z.start_file("xl/workbook.xml", opts).is_ok() {
            let zeros = vec![b' '; 8 * 1024 * 1024];
            let _ = std::io::Write::write_all(&mut z, &zeros);
        }
        let _ = z.finish();
    }
    let r = import_xlsx(
        buf.get_ref(),
        Arc::new(CacheHost::new()),
        &ImportOptions::default(),
    );
    assert!(
        matches!(r, Err(emp_sheets::SheetError::TooLarge(_))),
        "{r:?}"
    );
    let small = ImportOptions {
        max_cells: 3,
        ..Default::default()
    };
    let bytes = export_xlsx(&sample()).unwrap_or_default();
    assert!(import_xlsx(&bytes, Arc::new(CacheHost::new()), &small).is_err());
}
