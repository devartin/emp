//! Temporary security probe (deleted before handoff).
use emp_sheets::*;
fn main() {
    let f = std::env::var("F").unwrap();
    let mut w = Workbook::new();
    let s = w.sheets()[0].id;
    let _ = w.set_cells(s, &[CellEdit{row:0,col:0,input:Some("5".into())},CellEdit{row:1048575,col:16383,input:Some("7".into())}], None);
    let s = w.add_sheet(Some("Two"), None).unwrap();
    let t = std::time::Instant::now();
    let o = w.set_cells(s, &[CellEdit{row:2,col:2,input:Some(f.clone())}], None);
    let v = w.display(s, 2, 2);
    let shown: String = v.chars().take(60).collect();
    println!("{:>8.2?} len={} paused={:?} {:?}", t.elapsed(), v.len(), o.as_ref().map(|o| o.report.paused).ok(), shown);
}
