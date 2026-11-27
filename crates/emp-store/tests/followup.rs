//! Store follow-ups: `db:changed` events (with dependents and row ids), owner-only file modes, workbook and schema
//! versions, row-body edits touching the row, and the life-app listings used by `workspace_open` and finance.

mod common;

use std::sync::Arc;
use std::sync::atomic::AtomicI64;

use common::{ManualClock, PASSWORD, T0, doc_of, options, pw};
use emp_crypto::KdfParams;
use emp_sheets::{CellEdit, Rect};
use emp_store::lifeapps::answers::Mode;
use emp_store::model::{AutoLock, DocOwnerKind, VersionTargetKind};
use emp_store::query::model::*;
use emp_store::repo::lifeapps::LifeappInstall;
use emp_store::{CreateOptions, EventSink, NoProgress, Store, StoreEvent};
use parking_lot::Mutex;
use serde_json::json;

#[derive(Default)]
struct Recorder(Mutex<Vec<StoreEvent>>);

impl EventSink for Recorder {
    fn emit(&self, event: StoreEvent) {
        self.0.lock().push(event);
    }
}

impl Recorder {
    fn take(&self) -> Vec<StoreEvent> {
        std::mem::take(&mut *self.0.lock())
    }

    /// `(databaseId, rowIds)` of every `DbChanged` since the last take.
    fn db_changes(&self) -> Vec<(String, Option<Vec<String>>)> {
        self.take()
            .into_iter()
            .filter_map(|e| match e {
                StoreEvent::DbChanged {
                    database_id,
                    row_ids,
                    ..
                } => Some((database_id, row_ids)),
                _ => None,
            })
            .collect()
    }
}

struct Env {
    _dir: tempfile::TempDir,
    data: std::path::PathBuf,
    store: Store,
    events: Arc<Recorder>,
}

fn env(encrypted: bool) -> Env {
    env_with(encrypted, false)
}

fn env_with(encrypted: bool, tour: bool) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock(AtomicI64::new(T0)));
    let events = Arc::new(Recorder::default());
    let mut opts = options(dir.path(), &clock);
    opts.events = events.clone();
    opts.starter_tour = tour;
    let created = Store::create(
        dir.path(),
        CreateOptions {
            password: encrypted.then(|| pw(PASSWORD)),
            kdf: KdfParams::INSECURE_TEST,
            auto_lock: AutoLock::default(),
            workspace_name: Some("Personal".into()),
        },
        opts,
    )
    .unwrap();
    Env {
        data: dir.path().to_owned(),
        _dir: dir,
        store: created.store,
        events,
    }
}

fn ws(e: &Env) -> String {
    e.store.workspace_list().unwrap().remove(0).id
}

#[test]
fn db_changed_events_name_rows_and_dependents() {
    let e = env(false);
    let w = ws(&e);
    let projects = e
        .store
        .db_create(DbCreate::new(&w, None, "Projects"))
        .unwrap();
    let tasks = e
        .store
        .db_create(
            DbCreate::new(&w, None, "Tasks")
                .with_properties(vec![PropertySpec::new("Hours", PropType::Number)]),
        )
        .unwrap();
    let (pdb, tdb) = (projects.page.id.clone(), tasks.page.id.clone());
    // Projects → Tasks relation (two-way) and a rollup of the tasks' hours.
    let rel = e
        .store
        .db_property_create(
            &pdb,
            "Tasks",
            PropType::Relation,
            Some(
                json!({"targetDatabaseId": tdb, "dual": null, "limit": "many"})
                    .as_object()
                    .cloned()
                    .unwrap(),
            ),
            None,
        )
        .unwrap();
    let hours = tasks.schema.property_named("Hours").unwrap().id.clone();
    e.store
        .db_property_create(
            &pdb,
            "Total",
            PropType::Rollup,
            Some(
                json!({"relationPropId": rel.id, "targetPropId": hours, "fn": "sum"})
                    .as_object()
                    .cloned()
                    .unwrap(),
            ),
            None,
        )
        .unwrap();
    let task = e.store.db_row_create(RowCreate::new(&tdb)).unwrap();
    e.store
        .db_row_create(RowCreate::new(&pdb).with(
            &rel.id,
            CellValue::Relation {
                v: vec![task.id.clone()],
            },
        ))
        .unwrap();
    e.events.take();

    // A value edit names the row; the database relating to it is invalidated too (its rollup changed).
    e.store
        .db_rows_update(vec![RowUpdate::one(
            &task.id,
            &hours,
            Some(CellValue::number(4.0)),
        )])
        .unwrap();
    let changes = e.events.db_changes();
    assert!(changes.contains(&(tdb.clone(), Some(vec![task.id.clone()]))));
    assert!(changes.contains(&(pdb.clone(), None)));
    assert_eq!(changes.len(), 2);

    // Revisions in the event are the committed ones.
    e.store.db_row_create(RowCreate::new(&tdb)).unwrap();
    let schema = e.store.db_get_schema(&tdb).unwrap();
    let ev = e.events.take();
    assert!(ev.iter().any(|x| matches!(x,
        StoreEvent::DbChanged { database_id, data_rev, schema_rev, row_ids: None }
            if *database_id == tdb && *data_rev == schema.database.data_rev && *schema_rev == schema.database.schema_rev)));
    // `page:changed` is still emitted for the database page.
    assert!(
        ev.iter()
            .any(|x| matches!(x, StoreEvent::PageChanged { id, .. } if *id == tdb))
    );

    // A row body edit touches the row (`updated_time`) and its database.
    let before = e.store.db_row_get(&task.id).unwrap();
    let rev0 = before.doc_rev;
    e.store
        .page_save_doc(&task.id, DocOwnerKind::Row, doc_of(&["Notes"]), rev0)
        .unwrap();
    let after = e.store.db_row_get(&task.id).unwrap();
    assert!(after.row.has_body);
    assert!(after.row.updated_at >= before.row.updated_at);
    let changes = e.events.db_changes();
    assert!(changes.contains(&(tdb.clone(), Some(vec![task.id.clone()]))));
    assert_eq!(
        e.store.db_get_schema(&tdb).unwrap().database.data_rev,
        schema.database.data_rev + 1
    );
    // Row bodies are searchable, right away and after the index is rebuilt.
    e.store
        .page_save_doc(
            &task.id,
            DocOwnerKind::Row,
            doc_of(&["Quarterly zebra review"]),
            rev0 + 1,
        )
        .unwrap();
    let hits = |e: &Env| {
        e.store
            .search_query("zebra", None, 10, 1)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(hits(&e), vec![task.id.clone()]);
    e.store.search_reindex(&NoProgress).unwrap();
    assert!(
        e.store
            .wait_index_ready(std::time::Duration::from_secs(10))
            .unwrap()
    );
    assert_eq!(hits(&e), vec![task.id.clone()]);
}

#[cfg(unix)]
#[test]
fn vault_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let e = env(false);
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let root = e.store.paths().root().to_owned();
    assert_eq!(mode(&e.data.join("vaults")), 0o700);
    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&root.join("vault.db")), 0o600);
    assert_eq!(mode(&root.join("assets")), 0o700);
    let w = ws(&e);
    let asset = e
        .store
        .asset_import_bytes(&w, "note.txt", "text/plain", b"hello there")
        .unwrap();
    let _ = asset;
    for entry in std::fs::read_dir(root.join("assets")).unwrap() {
        let p = entry.unwrap().path();
        assert_eq!(mode(&p), 0o700, "{}", p.display());
        for f in std::fs::read_dir(&p).unwrap() {
            assert_eq!(mode(&f.unwrap().path()), 0o600);
        }
    }
    let wal = root.join("vault.db-wal");
    if wal.exists() {
        assert_eq!(mode(&wal), 0o600);
    }
}

fn edit(row: u32, col: u32, input: &str) -> CellEdit {
    CellEdit {
        row,
        col,
        input: Some(input.into()),
    }
}

fn a1(e: &Env, sheet: &str) -> String {
    e.store.sheet_get_cell(sheet, 0, 0).unwrap().display
}

#[test]
fn workbook_versions_create_and_restore() {
    let e = env(true);
    let w = ws(&e);
    let wb = e
        .store
        .sheet_workbook_create(&w, None, "Model", None)
        .unwrap();
    let wb_id = wb.page.id.clone();
    let sheet = wb.sheets[0].id.clone();
    let visible = Rect {
        r0: 0,
        c0: 0,
        r1: 20,
        c1: 5,
    };
    e.store
        .sheet_set_cells(&sheet, vec![edit(0, 0, "10")], visible, None)
        .unwrap();
    let extra = e.store.sheet_add(&wb_id, Some("Inputs"), None).unwrap();
    e.store
        .sheet_set_cells(&extra.id, vec![edit(0, 0, "7")], visible, None)
        .unwrap();
    let v = e
        .store
        .version_create(&wb_id, VersionTargetKind::Workbook, "Before scenario")
        .unwrap();
    assert_eq!(v.reason, "manual");
    assert_eq!(v.label.as_deref(), Some("Before scenario"));

    // Change a value, remove a sheet, add another.
    e.store
        .sheet_set_cells(&sheet, vec![edit(0, 0, "99")], visible, None)
        .unwrap();
    e.store.sheet_remove(&extra.id).unwrap();
    let later = e.store.sheet_add(&wb_id, Some("Later"), None).unwrap();
    assert_eq!(a1(&e, &sheet), "99");

    e.store.version_restore(&v.id).unwrap();
    assert_eq!(a1(&e, &sheet), "10");
    let names: Vec<(String, String)> = e
        .store
        .sheet_workbook_get(&wb_id)
        .unwrap()
        .sheets
        .into_iter()
        .map(|s| (s.id, s.name))
        .collect();
    // Sheets keep (or get back) their ids; the sheet added later is gone.
    assert_eq!(
        names,
        vec![
            (sheet.clone(), "Sheet1".to_owned()),
            (extra.id.clone(), "Inputs".to_owned())
        ]
    );
    assert!(!names.iter().any(|(id, _)| *id == later.id));
    assert_eq!(a1(&e, &extra.id), "7");

    // The restore survives a lock / unlock (it was persisted, not only applied to the cached engine).
    e.store.lock().unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(a1(&e, &sheet), "10");

    let list = e
        .store
        .version_list(&wb_id, VersionTargetKind::Workbook)
        .unwrap();
    let reasons: Vec<&str> = list.iter().map(|m| m.reason.as_str()).collect();
    assert!(reasons.contains(&"manual") && reasons.contains(&"pre_restore"));
    // Undoing the restore: restore the pre_restore version.
    let pre = list.iter().find(|m| m.reason == "pre_restore").unwrap();
    e.store.version_restore(&pre.id).unwrap();
    assert_eq!(a1(&e, &sheet), "99");

    // Other kinds are still refused by version_create.
    assert_eq!(
        e.store
            .version_create(&wb_id, VersionTargetKind::Sheet, "x")
            .unwrap_err()
            .code(),
        "UNSUPPORTED"
    );
}

#[test]
fn schema_versions_undo_a_conversion() {
    let e = env(false);
    let w = ws(&e);
    let db = e
        .store
        .db_create(
            DbCreate::new(&w, None, "Items")
                .with_properties(vec![PropertySpec::new("Qty", PropType::Number)]),
        )
        .unwrap();
    let id = db.page.id.clone();
    let qty = db.schema.property_named("Qty").unwrap().id.clone();
    let row = e
        .store
        .db_row_create(RowCreate::new(&id).with(&qty, CellValue::number(3.5)))
        .unwrap();
    e.store
        .db_property_convert(&qty, PropType::Text, None, &NoProgress)
        .unwrap();
    let got = e.store.db_row_get(&row.id).unwrap().row;
    assert!(matches!(got.values.get(&qty), Some(CellValue::Text { .. })));
    let versions = e
        .store
        .version_list(&id, VersionTargetKind::DbSchema)
        .unwrap();
    let pre = versions.iter().find(|v| v.reason == "pre_bulk").unwrap();
    e.store.version_restore(&pre.id).unwrap();
    let schema = e.store.db_get_schema(&id).unwrap();
    assert_eq!(schema.property(&qty).unwrap().kind, PropType::Number);
    let got = e.store.db_row_get(&row.id).unwrap().row;
    assert_eq!(got.values.get(&qty), Some(&CellValue::number(3.5)));
}

#[test]
fn workspace_open_lists_life_apps_and_instance_details() {
    let e = env(false);
    let w = ws(&e);
    assert!(e.store.workspace_open(&w).unwrap().lifeapps.is_empty());
    let answers = json!({"pick": [{"name": "Meditate", "type": "duration", "schedule": "daily", "target": 10, "unit": "min"}], "grace": "never_miss_twice"});
    let r = e
        .store
        .lifeapp_install(
            &LifeappInstall {
                app_id: "habits".into(),
                answers: answers.as_object().cloned().unwrap(),
                mode: Mode::Quick,
                disabled_keys: vec![],
                workspace_id: w.clone(),
                sample_data: false,
            },
            &NoProgress,
        )
        .unwrap();
    let opened = e.store.workspace_open(&w).unwrap();
    assert_eq!(opened.lifeapps.len(), 1);
    assert_eq!(opened.lifeapps[0].id, r.instance_id);
    assert_eq!(opened.lifeapps[0].app_id, "habits");
    let wire = serde_json::to_value(&opened).unwrap();
    assert_eq!(wire["lifeapps"][0]["appId"], "habits");

    let keys = e.store.lifeapp_key_map(&r.instance_id).unwrap();
    assert!(keys.values().any(|id| *id == r.root_page_id));
    let resolved = e.store.lifeapp_answers(&r.instance_id).unwrap();
    assert_eq!(resolved["grace"], "never_miss_twice");
    assert_eq!(
        e.store.lifeapp_raw_answers(&r.instance_id).unwrap()["pick"][0]["name"],
        "Meditate"
    );
    assert_eq!(
        e.store.lifeapp_key_map("nope").unwrap_err().code(),
        "NOT_FOUND"
    );
}

/// `(checked, text)` of the Getting Started to-dos.
fn checklist(e: &Env, page: &str) -> Vec<(bool, String)> {
    let doc = e.store.page_get(page).unwrap().doc.unwrap();
    let mut out = Vec::new();
    emp_store::doc::walk::for_each_block(&doc, &mut |b| {
        if b.content.kind == "todoItem" {
            out.push((
                b.content.attr("checked") == Some(&json!(true)),
                emp_store::doc::walk::inline_text(b.content),
            ));
        }
    });
    out
}

#[test]
fn starter_tour_is_created_and_ticks_itself() {
    let e = env_with(true, true);
    let w = ws(&e);
    let st = e.store.getting_started_state().unwrap().unwrap();
    let gs = st.page_id.clone();
    let meta = e.store.page_get(&gs).unwrap().meta;
    assert_eq!(meta.title, "Getting Started");
    let kids: Vec<String> = e
        .store
        .page_children(&w, Some(&gs))
        .unwrap()
        .into_iter()
        .map(|p| p.title)
        .collect();
    assert_eq!(
        kids,
        vec![
            "Writing in Ultranote",
            "Keyboard shortcuts",
            "Privacy & encryption",
            "Apps in Ultranote"
        ]
    );
    // Not pinned: Getting Started lists once, under Documents (1.0 brief §2.1).
    assert!(e.store.workspace_get(&w).unwrap().favorites.is_empty());
    // Only items a new workspace can do; this one is encrypted, so "Lock" is listed last.
    let items = checklist(&e, &gs);
    assert_eq!(items.len(), 5);
    assert!(items.iter().all(|(c, _)| !c));
    assert!(items[0].1.starts_with("Write a document"));
    // One checklist: the same items Home lists (no "Hide numbers" in a workspace that may have no money).
    assert!(items[2].1.starts_with("Add a task or a note"));
    assert!(!items.iter().any(|(_, t)| t.starts_with("Hide numbers")));
    assert!(items[4].1.starts_with("Lock Ultranote"));
    // Home reads the page's to-dos (ticked by hand too) through the published item → block map.
    let tour = e
        .store
        .kv_get("ui.gettingStarted", "tour")
        .unwrap()
        .expect("the tour map is published for Home");
    assert_eq!(tour["pageId"], json!(gs));
    for key in [
        "create_page",
        "try_slash",
        "capture",
        "open_palette",
        "lock",
    ] {
        assert_eq!(
            tour["items"][key],
            json!(st.items[key]),
            "{key} maps to its to-do block"
        );
    }
    // Guide pages are linked from Getting Started (wikilinks resolved to mentions of the real pages).
    assert!(!e.store.backlinks_of(&e, &gs).is_empty());
    // Creating the tour again returns the same one.
    let again = e.store.starter_tour_create(&w).unwrap();
    assert_eq!(again.page_id, gs);
    assert_eq!(again.pages.len(), 5);

    // Store-visible actions tick their items.
    e.store
        .page_create(emp_store::model::PageCreate::new(
            &w,
            None,
            emp_store::model::PageKind::Doc,
            "Mine",
        ))
        .unwrap();
    e.store
        .kv_set("ui.gettingStarted", "try_slash", json!(1))
        .unwrap();
    let db = e
        .store
        .db_create(
            DbCreate::new(&w, None, "Transactions")
                .with_properties(vec![PropertySpec::new("Amount", PropType::Number)]),
        )
        .unwrap();
    let amount = db.schema.property_named("Amount").unwrap().id.clone();
    let mut roles = std::collections::BTreeMap::new();
    roles.insert("txn.amount".to_owned(), amount);
    e.store.db_set_roles(&db.page.id, roles).unwrap();
    e.store.db_row_create(RowCreate::new(&db.page.id)).unwrap();
    let done: Vec<bool> = checklist(&e, &gs).into_iter().map(|(c, _)| c).collect();
    assert_eq!(done, vec![true, true, false, false, false]);
    // Every tick (listed on the page or not) is recorded where Home's checklist reads it.
    for item in ["create_page", "try_slash", "add_transaction"] {
        assert!(
            e.store.kv_get("ui.gettingStarted", item).unwrap().is_some(),
            "{item}"
        );
    }
    assert!(
        e.store
            .kv_get("ui.gettingStarted", "open_palette")
            .unwrap()
            .is_none()
    );
    // The editor's slash menu recording a block ticks "Add a heading, list or table".
    e.store
        .kv_set("ui.editor", "slashRecent", json!(["heading"]))
        .unwrap();
    // Ticking again is a no-op; unknown items are ignored.
    assert!(!e.store.getting_started_tick("try_slash").unwrap());
    assert!(!e.store.getting_started_tick("nonsense").unwrap());
    assert!(
        e.store
            .kv_get("ui.gettingStarted", "nonsense")
            .unwrap()
            .is_none()
    );
    // Locking ticks "lock" before the keys go.
    e.store.lock().unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert!(checklist(&e, &gs)[4].0);
    assert!(
        e.store
            .kv_get("ui.gettingStarted", "lock")
            .unwrap()
            .is_some()
    );
}

#[test]
fn plain_workspaces_list_no_lock_item_and_slash_ticks_try_slash() {
    let e = env_with(false, true);
    let st = e.store.getting_started_state().unwrap().unwrap();
    let items = checklist(&e, &st.page_id);
    assert_eq!(items.len(), 4);
    assert!(!items.iter().any(|(_, t)| t.starts_with("Lock")));
    e.store
        .kv_set("ui.editor", "slashRecent", json!(["todo"]))
        .unwrap();
    assert!(checklist(&e, &st.page_id)[1].0);
}

#[test]
fn vaults_without_the_option_have_no_tour() {
    let e = env(false);
    assert!(e.store.getting_started_state().unwrap().is_none());
    assert!(!e.store.getting_started_tick("lock").unwrap());
    let w = ws(&e);
    assert_eq!(e.store.page_tree(&w).unwrap().len(), 0);
}

trait Backlinks {
    fn backlinks_of(&self, e: &Env, page: &str) -> Vec<String>;
}

impl Backlinks for Store {
    /// Pages Getting Started links to (by looking at the guide pages' backlinks).
    fn backlinks_of(&self, e: &Env, page: &str) -> Vec<String> {
        let w = ws(e);
        self.page_children(&w, Some(page))
            .unwrap()
            .into_iter()
            .filter(|c| {
                self.page_backlinks(&c.id)
                    .is_ok_and(|b| b.iter().any(|x| x.source_id == page))
            })
            .map(|c| c.id)
            .collect()
    }
}

#[test]
fn markdown_export_writes_databases_as_csv_and_row_files() {
    let e = env(false);
    let w = ws(&e);
    let db = e
        .store
        .db_create(
            DbCreate::new(&w, None, "Reading list")
                .with_properties(vec![PropertySpec::new("Pages", PropType::Number)]),
        )
        .unwrap();
    let title = db.schema.database.primary_prop_id.clone();
    let pages = db.schema.property_named("Pages").unwrap().id.clone();
    let row = e
        .store
        .db_row_create(
            RowCreate::new(&db.page.id)
                .with(&title, CellValue::text("Dune"))
                .with(&pages, CellValue::number(412.0)),
        )
        .unwrap();
    e.store
        .db_row_create(RowCreate::new(&db.page.id).with(&title, CellValue::text("Dune")))
        .unwrap();
    e.store
        .page_save_doc(&row.id, DocOwnerKind::Row, doc_of(&["Spice must flow"]), 0)
        .unwrap();
    let out = tempfile::tempdir().unwrap();
    let n = e
        .store
        .export_pages(
            std::slice::from_ref(&db.page.id),
            out.path(),
            emp_store::backup::export::ExportOptions {
                format: emp_store::backup::export::ExportFormat::Markdown,
                include_children: true,
                include_assets: false,
            },
            &NoProgress,
        )
        .unwrap();
    // The page, the CSV and two row files (duplicate titles get " (2)").
    assert_eq!(n, 4);
    let md = std::fs::read_to_string(out.path().join("Reading list.md")).unwrap();
    assert!(md.contains("Reading list.csv"), "{md}");
    let csv = std::fs::read_to_string(out.path().join("Reading list.csv")).unwrap();
    assert!(csv.contains("Dune") && csv.contains("412"), "{csv}");
    let first = std::fs::read_to_string(out.path().join("Reading list").join("Dune.md")).unwrap();
    assert!(first.starts_with("---\n"), "{first}");
    assert!(first.contains("\"Pages\": \"412\""), "{first}");
    assert!(first.contains(&format!("id: {}", row.id)));
    assert!(first.contains("Spice must flow"));
    assert!(out.path().join("Reading list").join("Dune (2).md").exists());
}
