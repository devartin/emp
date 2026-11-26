mod common;
use emp_store::query::model::*;
#[test]
fn perf() {
    let e = common::env(true);
    let ws = e.workspace();
    let mut csv = String::from("Name,Amount,Status,Due\n");
    for i in 0..10_000 {
        csv.push_str(&format!(
            "Item {i},{},{},2026-{:02}-{:02}\n",
            i % 97,
            ["a", "b", "c"][i % 3],
            i % 12 + 1,
            i % 28 + 1
        ));
    }
    let t = std::time::Instant::now();
    let r = e
        .store
        .db_import_table(
            "x.csv",
            csv.as_bytes(),
            emp_store::import::table::TableTarget::New {
                workspace_id: ws,
                parent_id: None,
                title: "P".into(),
            },
            None,
            &emp_store::NoProgress,
        )
        .unwrap();
    eprintln!("import {:?}", t.elapsed());
    let s = e.store.db_get_schema(&r.database_id).unwrap();
    let amt = s.property_named("Amount").unwrap().id.clone();
    let mut q = QueryRequest::new(&r.database_id, None, 100);
    q.override_ = Some(QueryOverride {
        sorts: Some(vec![Sort {
            prop: s.database.primary_prop_id.clone(),
            dir: SortDir::Desc,
        }]),
        filter: Some(Filter::cond(
            &amt,
            FilterOp::Gt,
            Some(serde_json::json!(10)),
        )),
        ..Default::default()
    });
    let t = std::time::Instant::now();
    let _ = e.store.db_query(q).unwrap();
    eprintln!("query {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let row = e
        .store
        .db_row_create(RowCreate::new(&r.database_id))
        .unwrap();
    e.store
        .db_rows_update(vec![RowUpdate::one(
            &row.id,
            &amt,
            Some(CellValue::number(3.0)),
        )])
        .unwrap();
    eprintln!("create+update {:?}", t.elapsed());
}
