//! Recalculation smoke benchmark: `cargo run --release -p emp-sheets --example perf`.
use emp_sheets::*;

fn main() -> Result<(), SheetError> {
    let mut w = Workbook::new();
    let s = w.sheets()[0].id;
    let t = std::time::Instant::now();
    let mut edits = Vec::new();
    for r in 0..50_000u32 {
        edits.push(CellEdit {
            row: r,
            col: 0,
            input: Some(format!("{r}")),
        });
    }
    for r in 0..10_000u32 {
        edits.push(CellEdit {
            row: r,
            col: 1,
            input: Some(format!("=A{}*2+SUM(A:A)/1000", r + 1)),
        });
    }
    for r in 1..10_000u32 {
        edits.push(CellEdit {
            row: r,
            col: 2,
            input: Some(format!("=B{}+C{}", r + 1, r)),
        });
    }
    let o = w.set_cells(s, &edits, None)?;
    println!(
        "initial {:?} evaluated {} paused {}",
        t.elapsed(),
        o.report.evaluated,
        o.report.paused
    );
    let t = std::time::Instant::now();
    let o = w.set_input(s, 5, 0, "123")?;
    println!(
        "edit {:?} evaluated {} changed {} paused {}",
        t.elapsed(),
        o.report.evaluated,
        o.report.changed.len(),
        o.report.paused
    );
    let t = std::time::Instant::now();
    let bytes = w.to_json()?;
    let w2 = Workbook::from_json(&bytes, w.host().clone())?;
    println!(
        "save+load {:?} {} bytes, C10000={}",
        t.elapsed(),
        bytes.len(),
        w2.value(s, 9999, 2).display()
    );
    Ok(())
}
