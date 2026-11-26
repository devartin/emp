//! Workbooks: engine persistence in sheets / bands, tile reads, edits, undo and structural commands.

mod common;

use common::{PASSWORD, contains, env, pw};
use emp_sheets::{Axis, CellEdit, ClearWhat, Rect};

fn edit(row: u32, col: u32, input: &str) -> CellEdit {
    CellEdit {
        row,
        col,
        input: Some(input.into()),
    }
}

fn rect(r0: u32, c0: u32, r1: u32, c1: u32) -> Rect {
    Rect { r0, c0, r1, c1 }
}

fn display_at(cells: &emp_sheets::PackedCells, r: u32, c: u32) -> Option<String> {
    (0..cells.len())
        .find(|&i| cells.r[i] == r && cells.c[i] == c)
        .map(|i| cells.d[i].clone())
}

#[test]
fn edits_persist_across_lock_and_tiles_read_bands() {
    let e = env(true);
    let ws = e.workspace();
    let wb = e
        .store
        .sheet_workbook_create(&ws, None, "Budget", None)
        .unwrap();
    assert_eq!(wb.sheets.len(), 1);
    let sheet = wb.sheets[0].id.clone();
    let r = e
        .store
        .sheet_set_cells(
            &sheet,
            vec![
                edit(0, 0, "10"),
                edit(1, 0, "32"),
                edit(2, 0, "=SUM(A1:A2)"),
                edit(300, 1, "far away"),
                edit(3, 0, "=SUM("),
            ],
            rect(0, 0, 50, 10),
            None,
        )
        .unwrap();
    assert_eq!(display_at(&r.changed, 2, 0).as_deref(), Some("42"));
    assert_eq!(r.errors.as_ref().map(Vec::len), Some(1));
    let rev1 = r.rev;
    let r = e
        .store
        .sheet_set_cells(&sheet, vec![edit(0, 0, "20")], rect(0, 0, 50, 10), None)
        .unwrap();
    assert!(r.rev > rev1);
    assert_eq!(display_at(&r.changed, 2, 0).as_deref(), Some("52"));
    // Two bands on disk, encrypted.
    let conn = e.db();
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sheet_bands WHERE sheet_id = ?1",
            [&sheet],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2);
    let raw: Vec<u8> = conn
        .query_row(
            "SELECT payload FROM sheet_bands WHERE sheet_id = ?1 AND band = 1",
            [&sheet],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!contains(&raw, b"far away"));
    // Lock + unlock: a fresh engine loads from disk.
    e.store.lock().unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    let t = e.store.sheet_get_range(&sheet, rect(0, 0, 400, 5)).unwrap();
    assert_eq!(display_at(&t.data.cells, 2, 0).as_deref(), Some("52"));
    assert_eq!(
        display_at(&t.data.cells, 300, 1).as_deref(),
        Some("far away")
    );
    let cell = e.store.sheet_get_cell(&sheet, 2, 0).unwrap();
    assert_eq!(cell.input, "=SUM(A1:A2)");
    // Undo after reload works within the new session's engine; undo the next edit.
    e.store
        .sheet_set_cells(&sheet, vec![edit(1, 0, "0")], rect(0, 0, 10, 10), None)
        .unwrap();
    assert_eq!(e.store.sheet_get_cell(&sheet, 2, 0).unwrap().display, "20");
    let changed = e.store.sheet_undo(&wb.page.id).unwrap();
    assert_eq!(changed, vec![sheet.clone()]);
    assert_eq!(e.store.sheet_get_cell(&sheet, 2, 0).unwrap().display, "52");
    e.store.sheet_redo(&wb.page.id).unwrap();
    assert_eq!(e.store.sheet_get_cell(&sheet, 2, 0).unwrap().display, "20");
    // Clearing the far band deletes its row.
    e.store
        .sheet_clear(&sheet, vec![rect(300, 1, 300, 1)], ClearWhat::All)
        .unwrap();
    let conn = e.db();
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sheet_bands WHERE sheet_id = ?1",
            [&sheet],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn sheets_structure_and_exports() {
    let e = env(false);
    let ws = e.workspace();
    let wb = e
        .store
        .sheet_workbook_create(&ws, None, "Model", None)
        .unwrap();
    let id = wb.page.id.clone();
    let s1 = wb.sheets[0].id.clone();
    let s2 = e.store.sheet_add(&id, Some("Inputs"), None).unwrap();
    e.store
        .sheet_set_cells(&s2.id, vec![edit(0, 0, "5")], rect(0, 0, 5, 5), None)
        .unwrap();
    e.store
        .sheet_set_cells(
            &s1,
            vec![edit(0, 0, "=Inputs!A1*2")],
            rect(0, 0, 5, 5),
            None,
        )
        .unwrap();
    assert_eq!(e.store.sheet_get_cell(&s1, 0, 0).unwrap().display, "10");
    // A change on another sheet shows up as a dirty rect.
    let r = e
        .store
        .sheet_set_cells(&s2.id, vec![edit(0, 0, "7")], rect(0, 0, 5, 5), None)
        .unwrap();
    assert!(r.dirty_rects.iter().any(|d| d.sheet_id == s1));
    // Reorder, rename, named ranges.
    let m = e.store.sheet_reorder(&s2.id, Some(&s1), None).unwrap();
    let info = e.store.sheet_workbook_get(&id).unwrap();
    assert_eq!(info.sheets[0].id, s2.id);
    assert_eq!(info.sheets[0].sort_key, m.sort_key);
    e.store
        .sheet_update(
            &s2.id,
            emp_store::repo::sheets::SheetPatch {
                name: Some("Assumptions".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        e.store.sheet_get_cell(&s1, 0, 0).unwrap().input,
        "=Assumptions!A1*2"
    );
    e.store
        .sheet_named_range_set(&id, "Rate", Some("Assumptions!$A$1"))
        .unwrap();
    assert_eq!(
        e.store.sheet_workbook_get(&id).unwrap().named_ranges.len(),
        1
    );
    // Insert a row above: references move.
    e.store.sheet_insert(&s2.id, Axis::Rows, 0, 1).unwrap();
    assert_eq!(
        e.store.sheet_get_cell(&s1, 0, 0).unwrap().input,
        "=Assumptions!A2*2"
    );
    // Find, eval, lint, export.
    let hits = e.store.sheet_find(&id, "7", false, true, false).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(
        e.store
            .sheet_eval(Some(&id), Some(&s1), "=A1+1")
            .unwrap()
            .display,
        "15"
    );
    assert_eq!(e.store.sheet_eval(None, None, "=1+2").unwrap().display, "3");
    let _ = e.store.sheet_lint(&id).unwrap();
    let xlsx = e.store.sheet_export(&id, "xlsx", None).unwrap();
    assert!(xlsx.starts_with(b"PK"));
    let csv = e.store.sheet_export(&id, "csv", Some(&s1)).unwrap();
    assert!(String::from_utf8(csv).unwrap().starts_with("14"));
    // Remove a sheet: rows go away.
    e.store.sheet_remove(&s2.id).unwrap();
    let conn = e.db();
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sheets WHERE workbook_id = ?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
    assert!(e.store.sheet_remove(&s1).is_err());
    // Reopen the vault from disk: still consistent.
    let mut e = e;
    e.reopen();
    e.store.unlock_device().unwrap();
    let info = e.store.sheet_workbook_get(&id).unwrap();
    assert_eq!(info.sheets.len(), 1);
    assert_eq!(e.store.sheet_get_cell(&s1, 0, 0).unwrap().display, "#REF!");
}
