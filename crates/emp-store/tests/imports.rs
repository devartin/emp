//! Importers: Markdown folders, CSV / XLSX into databases, exports, Notion zips and `import_undo`.

mod common;

use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use common::env;
use emp_store::NoProgress;
use emp_store::import::files::ImportFile;
use emp_store::import::table::TableTarget;
use emp_store::import::zipfs::ZipLimits;
use emp_store::query::model::*;

const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (n, d) in files {
            z.start_file(*n, o).unwrap();
            z.write_all(d).unwrap();
        }
        z.finish().unwrap();
    }
    buf.into_inner()
}

fn titles(e: &common::Env) -> Vec<String> {
    e.store
        .page_tree(&e.workspace())
        .unwrap()
        .into_iter()
        .map(|m| m.title)
        .collect()
}

fn doc_json(e: &common::Env, id: &str) -> String {
    serde_json::to_string(&e.store.page_get(id).unwrap().doc).unwrap()
}

#[test]
fn markdown_folder_import_and_undo() {
    let e = env(false);
    let ws = e.workspace();
    let files = vec![
        ImportFile {
            path: "Projects.md".into(),
            bytes: b"# Projects\nSee [[Ideas]] and [the journal](Journal/2026.md).\n#work".to_vec(),
        },
        ImportFile {
            path: "Projects/Ideas.md".into(),
            bytes: b"---\nstatus: draft\n---\n- [ ] one\n\n![[img.png]]\n\n[[Nowhere]]".to_vec(),
        },
        ImportFile {
            path: "Projects/img.png".into(),
            bytes: PNG.to_vec(),
        },
        ImportFile {
            path: "Journal/2026.md".into(),
            bytes: b"> [!tip] Be kind\n".to_vec(),
        },
    ];
    let before = titles(&e).len();
    let r = e
        .store
        .import_markdown(&ws, None, files, &NoProgress)
        .unwrap();
    assert_eq!(r.pages, 4); // Projects, Ideas, Journal (folder), 2026
    assert_eq!(r.root_ids.len(), 2);
    assert!(
        r.warnings.iter().any(|w| w.contains("Nowhere")),
        "{:?}",
        r.warnings
    );
    let tree = e.store.page_tree(&ws).unwrap();
    let by = |t: &str| tree.iter().find(|m| m.title == t).unwrap().clone();
    let (projects, ideas, y2026) = (by("Projects"), by("Ideas"), by("2026"));
    assert_eq!(ideas.parent_id.as_deref(), Some(projects.id.as_str()));
    assert_eq!(y2026.parent_id.as_deref(), Some(by("Journal").id.as_str()));
    let pj = doc_json(&e, &projects.id);
    assert!(pj.contains(&ideas.id), "{pj}");
    assert!(pj.contains(&y2026.id));
    assert!(pj.contains("Tags: #work"));
    let ij = doc_json(&e, &ideas.id);
    assert!(ij.contains("todoItem"));
    assert!(ij.contains("\"assetId\""));
    assert!(ij.contains("status: draft"));
    assert!(doc_json(&e, &y2026.id).contains("callout"));
    // Undo removes everything.
    let removed = e.store.import_undo(&r.import_id).unwrap();
    assert!(removed >= 3);
    assert_eq!(titles(&e).len(), before);
    assert!(e.store.import_undo(&r.import_id).is_err());
}

#[test]
fn csv_into_databases_and_exports() {
    let e = env(true);
    let ws = e.workspace();
    let csv = "Name,Amount,Status,Due,Done,Tags,Note\n\
               Rent,1200,Paid,2026-11-01,Yes,\"home, bills\",=HYPERLINK(\"x\")\n\
               Phone,45.5,Open,2026-11-15,No,bills,\n\
               Gym,30,Paid,2026-11-20,No,health,@cmd\n\
               Cloud,9.99,Paid,,No,bills,\n";
    let p = e
        .store
        .db_import_preview("bills.csv", csv.as_bytes())
        .unwrap();
    let kinds: Vec<PropType> = p.columns.iter().map(|c| c.inferred).collect();
    assert_eq!(
        kinds,
        vec![
            PropType::Title,
            PropType::Number,
            PropType::Select,
            PropType::Date,
            PropType::Checkbox,
            PropType::MultiSelect,
            PropType::Text
        ]
    );
    let r = e
        .store
        .db_import_table(
            "bills.csv",
            csv.as_bytes(),
            TableTarget::New {
                workspace_id: ws.clone(),
                parent_id: None,
                title: "Bills".into(),
            },
            None,
            &NoProgress,
        )
        .unwrap();
    assert_eq!(r.inserted, 4);
    let s = e.store.db_get_schema(&r.database_id).unwrap();
    let status = s.property_named("Status").unwrap();
    assert_eq!(status.config["options"].as_array().unwrap().len(), 2);
    let q = match e
        .store
        .db_query(QueryRequest::new(&r.database_id, None, 10))
        .unwrap()
    {
        QueryResponse::Rows(q) => q,
        _ => panic!(),
    };
    let note = &s.property_named("Note").unwrap().id;
    assert_eq!(q.rows[0].text_of(note), "=HYPERLINK(\"x\")");
    // Export CSV: formula-looking text is protected.
    let (bytes, n) = e
        .store
        .db_export(&r.database_id, None, "csv", &NoProgress)
        .unwrap();
    assert_eq!(n, 4);
    let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
    assert!(text.starts_with("Name,Amount,Status,Due,Done,Tags,Note"));
    assert!(text.contains("'=HYPERLINK"), "{text}");
    assert!(
        text.contains("Rent,1200,Paid,2026-11-01,Yes,\"home, bills\""),
        "{text}"
    );
    let (xlsx, _) = e
        .store
        .db_export(&r.database_id, None, "xlsx", &NoProgress)
        .unwrap();
    assert!(xlsx.starts_with(b"PK"));
    // Append to the existing database with a mapping.
    let more = "Item,Cost,Extra\nTV,15,x\n";
    let mut mapping = BTreeMap::new();
    mapping.insert("Item".to_owned(), s.database.primary_prop_id.clone());
    mapping.insert(
        "Cost".to_owned(),
        s.property_named("Amount").unwrap().id.clone(),
    );
    mapping.insert("Extra".to_owned(), "new".to_owned());
    let r2 = e
        .store
        .db_import_table(
            "more.csv",
            more.as_bytes(),
            TableTarget::Existing {
                database_id: r.database_id.clone(),
                mapping,
            },
            None,
            &NoProgress,
        )
        .unwrap();
    assert_eq!(r2.inserted, 1);
    assert!(
        e.store
            .db_get_schema(&r.database_id)
            .unwrap()
            .property_named("Extra")
            .is_some()
    );
    e.store.import_undo(&r2.import_id).unwrap();
    let q = match e
        .store
        .db_query(QueryRequest::new(&r.database_id, None, 10))
        .unwrap()
    {
        QueryResponse::Rows(q) => q,
        _ => panic!(),
    };
    assert_eq!(q.total, 4);
    // XLSX round trip as a workbook and as a database.
    let (page, warnings) = e
        .store
        .sheet_import_file("Bills.xlsx", &xlsx, &ws, None, false, &NoProgress)
        .unwrap();
    assert!(warnings.is_empty());
    let info = e.store.sheet_workbook_get(&page.id).unwrap();
    let cell = e.store.sheet_get_cell(&info.sheets[0].id, 1, 0).unwrap();
    assert_eq!(cell.display, "Rent");
    let (dbp, _) = e
        .store
        .sheet_import_file("Bills.xlsx", &xlsx, &ws, None, true, &NoProgress)
        .unwrap();
    assert_eq!(dbp.kind, emp_store::model::PageKind::Database);
    // Sheet range → database.
    let m = e
        .store
        .sheet_to_database(
            &info.sheets[0].id,
            emp_sheets::Rect {
                r0: 0,
                c0: 0,
                r1: 2,
                c1: 1,
            },
            true,
            &ws,
            None,
        )
        .unwrap();
    let q = match e
        .store
        .db_query(QueryRequest::new(&m.id, None, 10))
        .unwrap()
    {
        QueryResponse::Rows(q) => q,
        _ => panic!(),
    };
    assert_eq!(q.total, 2);
}

#[test]
fn notion_zip_import() {
    let e = env(false);
    let ws = e.workspace();
    let (h, c, t, a, b, p, ann) = (
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
        "33333333333333333333333333333333",
        "44444444444444444444444444444444",
        "55555555555555555555555555555555",
        "66666666666666666666666666666666",
        "77777777777777777777777777777777",
    );
    let home_md = format!(
        "# Home\n\nGo to [Child](Home%20{h}/Child%20{c}.md) and [Gone](Gone%20{b}.md).\n\n![](Home%20{h}/pic.png)\n"
    );
    let child_html = format!(
        "<html><body><article><header><h1 class=\"page-title\">Child</h1></header><div class=\"page-body\"><details><summary>More</summary><p>Hidden</p></details><p><a href=\"../Home%20{h}.md\">back</a></p></div></article></body></html>"
    );
    let tasks_csv = format!(
        "Name,Status,Owner,Done\nTask A,Doing,Ann (../People%20{p}/Ann%20{ann}.md),Yes\nTask B,Done,,No\nTask C,Doing,Ann (../People%20{p}/Ann%20{ann}.md),No\n"
    );
    let task_a = "# Task A\n\nStatus: Doing\nOwner: Ann\n\nBody of A\n".to_owned();
    let people_csv = "Name,Role\nAnn,Lead\n".to_owned();
    let ann_md = "# Ann\n\nRole: Lead\n\nAnn's notes\n".to_owned();
    let inner = zip_of(&[
        (&format!("Home {h}.md"), home_md.as_bytes()),
        (
            &format!("Home {h}/Child {c}.md"),
            b"# Child\n\nmarkdown version",
        ),
        (&format!("Home {h}/Child {c}.html"), child_html.as_bytes()),
        (&format!("Home {h}/pic.png"), PNG),
        (&format!("Home {h}/Tasks {t}.csv"), b"Name\nTask A\n"),
        (&format!("Home {h}/Tasks {t}_all.csv"), tasks_csv.as_bytes()),
        (
            &format!("Home {h}/Tasks {t}/Task A {a}.md"),
            task_a.as_bytes(),
        ),
        (&format!("People {p}.csv"), people_csv.as_bytes()),
        (&format!("People {p}/Ann {ann}.md"), ann_md.as_bytes()),
    ]);
    let outer = zip_of(&[("Export-abc-Part-1.zip", &inner)]);
    let r = e
        .store
        .import_notion(&ws, None, &outer, ZipLimits::DEFAULT, &NoProgress)
        .unwrap();
    assert_eq!(r.databases, 2);
    assert_eq!(r.rows, 4);
    assert_eq!(r.assets, 1);
    assert!(
        r.unresolved.iter().any(|u| u.reference.contains("Gone")),
        "{:?}",
        r.unresolved
    );
    let tree = e.store.page_tree(&ws).unwrap();
    let by = |t: &str| tree.iter().find(|m| m.title == t).unwrap().clone();
    let (home, child, tasks) = (by("Home"), by("Child"), by("Tasks"));
    assert_eq!(child.parent_id.as_deref(), Some(home.id.as_str()));
    assert_eq!(tasks.parent_id.as_deref(), Some(home.id.as_str()));
    let hj = doc_json(&e, &home.id);
    assert!(hj.contains(&child.id), "{hj}");
    assert!(hj.contains("\"assetId\""));
    // HTML preferred over Markdown.
    let cj = doc_json(&e, &child.id);
    assert!(cj.contains("toggle"));
    assert!(!cj.contains("markdown version"));
    assert!(cj.contains(&home.id));
    // Database from *_all.csv with types, a resolved relation and a row body.
    let s = e.store.db_get_schema(&tasks.id).unwrap();
    assert_eq!(s.property_named("Status").unwrap().kind, PropType::Select);
    assert_eq!(s.property_named("Done").unwrap().kind, PropType::Checkbox);
    let owner = s.property_named("Owner").unwrap();
    assert_eq!(owner.kind, PropType::Relation);
    let q = match e
        .store
        .db_query(QueryRequest::new(&tasks.id, None, 10))
        .unwrap()
    {
        QueryResponse::Rows(q) => q,
        _ => panic!(),
    };
    assert_eq!(q.total, 3);
    let row_a = q
        .rows
        .iter()
        .find(|r| r.text_of(&s.database.primary_prop_id) == "Task A")
        .unwrap();
    assert!(matches!(row_a.values.get(&owner.id), Some(CellValue::Relation { v }) if v.len() == 1));
    let g = e.store.db_row_get(&row_a.id).unwrap();
    let body = serde_json::to_string(&g.doc).unwrap();
    assert!(body.contains("Body of A"));
    assert!(!body.contains("Status: Doing"));
    // Undo removes the whole import.
    e.store.import_undo(&r.import_id).unwrap();
    assert!(
        e.store
            .page_tree(&ws)
            .unwrap()
            .iter()
            .all(|m| m.title != "Home" && m.title != "People")
    );
    // Hostile archives are refused before extraction.
    let bad = zip_of(&[("../evil.md", b"x")]);
    assert!(
        e.store
            .import_notion(&ws, None, &bad, ZipLimits::DEFAULT, &NoProgress)
            .is_err()
    );
}
