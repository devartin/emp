//! App framework 1.0: semantic roles and key option ids on fresh installs, the vault-open upgrade of older
//! installs, the one-instance rule, hubs inside a project, Tasks and Habits upkeep (recurring tasks, `Done`,
//! streak columns) and Spreadsheet Studio's "new spreadsheet from a template".

mod common;

use std::collections::BTreeMap;

use common::env;
use emp_store::NoProgress;
use emp_store::dbmodel::{
    CellValue, DateValue, RecurrenceMode, RecurrenceValue, RowCreate, RowUpdate,
};
use emp_store::lifeapps::answers::Mode;
use emp_store::lifeapps::ids::IdGen;
use emp_store::model::{PageCreate, PageKind};
use emp_store::repo::lifeapps::LifeappInstall;
use serde_json::{Map, Value, json};

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn install(
    e: &common::Env,
    app: &str,
    answers: Value,
    parent: Option<&str>,
) -> emp_store::InstallResult {
    e.store
        .lifeapp_install_in(
            &LifeappInstall {
                app_id: app.into(),
                answers: obj(answers),
                mode: Mode::Quick,
                disabled_keys: vec![],
                workspace_id: e.workspace(),
                sample_data: false,
            },
            parent,
            &NoProgress,
        )
        .unwrap_or_else(|err| panic!("{app}: {err}"))
}

fn day(s: &str) -> CellValue {
    CellValue::Date {
        v: Some(DateValue {
            start: s.into(),
            end: None,
            time: false,
            tz: None,
        }),
    }
}

fn rows(e: &common::Env, db: &str) -> Vec<emp_store::dbmodel::RowDto> {
    match e
        .store
        .db_query(emp_store::dbmodel::QueryRequest::new(db, None, 500))
        .unwrap()
    {
        emp_store::dbmodel::QueryResponse::Rows(r) => r.rows,
        emp_store::dbmodel::QueryResponse::NotModified { .. } => panic!("not modified"),
    }
}

fn opt_ids(schema: &emp_store::dbmodel::DbSchema, prop: &str) -> Vec<String> {
    schema
        .property(prop)
        .unwrap()
        .config
        .get("options")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn every_manifest_ends_with_a_review_step() {
    for m in emp_store::lifeapps::catalog() {
        let last = m.steps.last().unwrap();
        assert_eq!(
            serde_json::to_value(last.kind).unwrap(),
            json!("review"),
            "{}",
            m.id
        );
        assert!(last.quick, "{}: review must show in quick mode", m.id);
        assert_eq!(
            m.steps
                .iter()
                .filter(|s| serde_json::to_value(s.kind).unwrap() == json!("review"))
                .count(),
            1,
            "{}",
            m.id
        );
    }
}

#[test]
fn fresh_installs_carry_roles_and_key_option_ids() {
    let e = env(false);
    let r = install(&e, "life-os", json!({}), None);
    let keys = e.store.lifeapp_key_map(&r.instance_id).unwrap();
    let tasks = e.store.db_get_schema(&keys["tasks"]).unwrap();
    for role in [
        "task.title",
        "task.status",
        "task.due",
        "task.scheduled",
        "task.completed",
        "task.recurrence",
        "task.project",
        "task.top3",
        "task.done",
    ] {
        let pid = tasks
            .database
            .roles
            .get(role)
            .unwrap_or_else(|| panic!("{role}"));
        assert_eq!(tasks.property(pid).unwrap().role.as_deref(), Some(role));
    }
    assert_eq!(
        opt_ids(&tasks, &keys["tasks.prop:status"]),
        ["inbox", "next", "scheduled", "waiting", "someday", "done"]
    );
    let lists = e.store.db_get_schema(&keys["projects"]).unwrap();
    assert_eq!(lists.database.title, "Lists");
    assert!(lists.database.roles.contains_key("project.status"));

    let h = install(&e, "habits", json!({}), None);
    let hk = e.store.lifeapp_key_map(&h.instance_id).unwrap();
    let habits = e.store.db_get_schema(&hk["habits"]).unwrap();
    for role in ["habit.name", "habit.type", "habit.schedule", "habit.streak"] {
        assert!(habits.database.roles.contains_key(role), "{role}");
    }
    assert!(opt_ids(&habits, &hk["habits.prop:type"]).contains(&"yes_no".to_owned()));
    let log = e.store.db_get_schema(&hk["log"]).unwrap();
    for role in ["log.date", "log.habit", "log.status", "log.value"] {
        assert!(log.database.roles.contains_key(role), "{role}");
    }

    let p = install(&e, "portfolio", json!({}), None);
    let pk = e.store.lifeapp_key_map(&p.instance_id).unwrap();
    let accts = e.store.db_get_schema(&pk["inv_accounts"]).unwrap();
    assert!(accts.database.roles.contains_key("iacct.type"));
    assert!(accts.database.roles.contains_key("iacct.tax"));
    assert!(opt_ids(&accts, &pk["inv_accounts.prop:type"]).contains(&"roth_ira".to_owned()));

    // The display names of the 1.0 brief.
    let titles: BTreeMap<String, String> = e
        .store
        .lifeapp_list(None)
        .unwrap()
        .into_iter()
        .map(|s| (s.id, s.title))
        .collect();
    assert_eq!(titles["life-os"], "Tasks");
    assert_eq!(titles["money-hq"], "Money");
    assert_eq!(titles["portfolio"], "Investments");
    assert_eq!(titles["tax-organizer"], "Taxes");
}

/// Rewrites a stored (unencrypted) JSON payload in place.
fn patch(conn: &rusqlite::Connection, table: &str, id: &str, f: impl FnOnce(&mut Value)) {
    let raw: Vec<u8> = conn
        .query_row(
            &format!("SELECT payload FROM {table} WHERE id = ?1"),
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let mut v: Value = serde_json::from_slice(&raw).unwrap();
    f(&mut v);
    conn.execute(
        &format!("UPDATE {table} SET payload = ?2 WHERE id = ?1"),
        rusqlite::params![id, serde_json::to_vec(&v).unwrap()],
    )
    .unwrap();
}

#[test]
fn vault_open_upgrade_brings_old_installs_to_roles_and_keys() {
    let e = env(false);
    let r = install(&e, "life-os", json!({}), None);
    let keys = e.store.lifeapp_key_map(&r.instance_id).unwrap();
    let (db, status) = (keys["tasks"].clone(), keys["tasks.prop:status"].clone());
    let row = e
        .store
        .db_row_create(RowCreate {
            database_id: db.clone(),
            values: Some(BTreeMap::from([
                (
                    keys["tasks.prop:title"].clone(),
                    CellValue::text("Pay rent"),
                ),
                (
                    status.clone(),
                    CellValue::Status {
                        v: Some("next".into()),
                    },
                ),
            ])),
            ..RowCreate::default()
        })
        .unwrap();
    // Make the install look like 0.3: UUIDv5 option ids, no roles, no upgrade level, no "Top 3" property.
    let g = IdGen::new(&r.instance_id).unwrap();
    let legacy = |k: &str| g.id(&format!("tasks.prop:status.opt:{k}"));
    let conn = e.db();
    patch(&conn, "db_properties", &status, |v| {
        for o in v["config"]["options"].as_array_mut().unwrap() {
            let k = o["id"].as_str().unwrap().to_owned();
            o["id"] = json!(legacy(&k));
        }
        v.as_object_mut().unwrap().remove("role");
    });
    patch(&conn, "db_rows", &row.id, |v| {
        v["values"][&status]["v"] = json!(legacy("next"));
    });
    patch(&conn, "databases", &db, |v| {
        v["roles"] = json!({});
    });
    patch(&conn, "lifeapp_instances", &r.instance_id, |v| {
        v.as_object_mut().unwrap().remove("upgraded");
    });
    conn.execute(
        "DELETE FROM db_properties WHERE id = ?1",
        [&keys["tasks.prop:top3"]],
    )
    .unwrap();
    drop(conn);
    let before = e.store.db_get_schema(&db).unwrap();
    assert!(before.database.roles.is_empty());
    assert!(before.property(&keys["tasks.prop:top3"]).is_none());

    assert_eq!(e.store.lifeapp_upgrade_all().unwrap(), 1);
    let after = e.store.db_get_schema(&db).unwrap();
    assert_eq!(after.database.roles.get("task.status"), Some(&status));
    assert_eq!(
        after.property(&status).unwrap().role.as_deref(),
        Some("task.status")
    );
    assert_eq!(opt_ids(&after, &status)[1], "next");
    assert!(after.property(&keys["tasks.prop:top3"]).is_some());
    let got = e.store.db_row_get(&row.id).unwrap().row;
    assert_eq!(
        got.values.get(&status),
        Some(&CellValue::Status {
            v: Some("next".into())
        })
    );
    // The "inbox" view filter follows the new id.
    let inbox = after.views.iter().find(|v| v.name == "Inbox").unwrap();
    assert!(
        serde_json::to_string(&inbox.filter)
            .unwrap()
            .contains("\"inbox\"")
    );
    // Once per session; a second call is a no-op.
    assert_eq!(e.store.lifeapp_upgrade_all().unwrap(), 0);
}

#[test]
fn one_instance_per_app_and_hubs_inside_projects() {
    let e = env(false);
    let ws = e.workspace();
    let project = e
        .store
        .page_create(PageCreate::new(&ws, None, PageKind::Doc, "Move to Lisbon"))
        .unwrap()
        .meta
        .id;
    let r = install(&e, "habits", json!({}), Some(&project));
    let root = e.store.page_get(&r.root_page_id).unwrap().meta;
    assert_eq!(root.parent_id.as_deref(), Some(project.as_str()));
    assert_eq!(
        e.store.lifeapp_installed(&ws, "habits").unwrap(),
        Some(r.instance_id.clone())
    );
    // A second Habits is refused.
    let again = e.store.lifeapp_install(
        &LifeappInstall {
            app_id: "habits".into(),
            answers: Map::new(),
            mode: Mode::Quick,
            disabled_keys: vec![],
            workspace_id: ws.clone(),
            sample_data: false,
        },
        &NoProgress,
    );
    assert_eq!(again.unwrap_err().code(), "CONFLICT");
    // The parent must be a live document of the workspace (not an app page, not a database).
    let bad = |parent: &str| {
        e.store
            .lifeapp_install_in(
                &LifeappInstall {
                    app_id: "life-os".into(),
                    answers: Map::new(),
                    mode: Mode::Quick,
                    disabled_keys: vec![],
                    workspace_id: ws.clone(),
                    sample_data: false,
                },
                Some(parent),
                &NoProgress,
            )
            .unwrap_err()
            .code()
    };
    assert_eq!(bad("missing-page"), "NOT_FOUND");
    assert_eq!(bad(&r.root_page_id), "INVALID");
    let keys = e.store.lifeapp_key_map(&r.instance_id).unwrap();
    assert_eq!(bad(&keys["habits"]), "INVALID");
    // After detaching, the app can be set up again.
    e.store.lifeapp_detach(&r.instance_id).unwrap();
    install(&e, "habits", json!({}), None);
}

#[test]
fn completing_a_recurring_task_spawns_the_next_and_keeps_done_in_step() {
    let e = env(false);
    let r = install(&e, "life-os", json!({}), None);
    let k = e.store.lifeapp_key_map(&r.instance_id).unwrap();
    let db = k["tasks"].clone();
    let status = k["tasks.prop:status"].clone();
    let t0 = chrono::DateTime::from_timestamp_millis(common::T0)
        .unwrap()
        .date_naive();
    let due = t0.format("%Y-%m-%d").to_string();
    let row = e
        .store
        .db_row_create(RowCreate {
            database_id: db.clone(),
            values: Some(BTreeMap::from([
                (
                    k["tasks.prop:title"].clone(),
                    CellValue::text("Water the plants"),
                ),
                (
                    status.clone(),
                    CellValue::Status {
                        v: Some("next".into()),
                    },
                ),
                (k["tasks.prop:due"].clone(), day(&due)),
                (
                    k["tasks.prop:recurrence"].clone(),
                    CellValue::Recurrence {
                        v: Some(RecurrenceValue {
                            rrule: "FREQ=DAILY".into(),
                            dtstart: due.clone(),
                            tz: None,
                            mode: RecurrenceMode::Schedule,
                        }),
                    },
                ),
            ])),
            ..RowCreate::default()
        })
        .unwrap();
    e.store
        .db_rows_update(vec![RowUpdate {
            id: row.id.clone(),
            values: BTreeMap::from([(
                status.clone(),
                Some(CellValue::Status {
                    v: Some("done".into()),
                }),
            )]),
            base_rev: None,
        }])
        .unwrap();
    e.store
        .lifeapp_react(&[(db.clone(), Some(vec![row.id.clone()]))])
        .unwrap();
    let done = e.store.db_row_get(&row.id).unwrap().row;
    assert_eq!(
        done.values.get(&k["tasks.prop:done_flag"]),
        Some(&CellValue::Check { v: true })
    );
    assert!(matches!(
        done.values.get(&k["tasks.prop:completed_at"]),
        Some(CellValue::Date { v: Some(_) })
    ));
    assert!(
        !done.values.contains_key(&k["tasks.prop:recurrence"]),
        "the repeat moved on"
    );
    let all = rows(&e, &db);
    let next: Vec<_> = all.iter().filter(|r| r.id != row.id).collect();
    assert_eq!(next.len(), 1, "one new occurrence");
    let n = next[0];
    assert_eq!(
        n.values.get(&status),
        Some(&CellValue::Status {
            v: Some("next".into())
        })
    );
    let tomorrow = (t0 + chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    assert_eq!(n.values.get(&k["tasks.prop:due"]), Some(&day(&tomorrow)));
    assert!(n.values.contains_key(&k["tasks.prop:recurrence"]));
    assert_eq!(n.text_of(&k["tasks.prop:title"]), "Water the plants");
    // Idempotent: another pass changes nothing.
    e.store.lifeapp_react(&[(db.clone(), None)]).unwrap();
    assert_eq!(rows(&e, &db).len(), 2);
    // Reopening clears Done and Completed at.
    e.store
        .db_rows_update(vec![RowUpdate {
            id: row.id.clone(),
            values: BTreeMap::from([(
                status.clone(),
                Some(CellValue::Status {
                    v: Some("next".into()),
                }),
            )]),
            base_rev: None,
        }])
        .unwrap();
    e.store
        .lifeapp_react(&[(db, Some(vec![row.id.clone()]))])
        .unwrap();
    let reopened = e.store.db_row_get(&row.id).unwrap().row;
    assert_eq!(
        reopened.values.get(&k["tasks.prop:done_flag"]),
        Some(&CellValue::Check { v: false })
    );
    assert!(!reopened.values.contains_key(&k["tasks.prop:completed_at"]));
}

#[test]
fn habit_check_ins_refresh_streak_columns() {
    let e = env(false);
    let r = install(
        &e,
        "habits",
        json!({"pick": [{"name": "Meditate", "type": "duration", "schedule": "daily", "target": 10, "unit": "min"}]}),
        None,
    );
    let k = e.store.lifeapp_key_map(&r.instance_id).unwrap();
    let habit = rows(&e, &k["habits"])
        .into_iter()
        .find(|h| h.text_of(&k["habits.prop:name"]) == "Meditate")
        .unwrap();
    let t0 = chrono::DateTime::from_timestamp_millis(common::T0)
        .unwrap()
        .date_naive();
    for back in [0, 1, 2] {
        let d = (t0 - chrono::Duration::days(back))
            .format("%Y-%m-%d")
            .to_string();
        e.store
            .db_row_create(RowCreate {
                database_id: k["log"].clone(),
                values: Some(BTreeMap::from([
                    (k["log.prop:date"].clone(), day(&d)),
                    (
                        k["log.prop:habit"].clone(),
                        CellValue::Relation {
                            v: vec![habit.id.clone()],
                        },
                    ),
                    (
                        k["log.prop:status"].clone(),
                        CellValue::Select {
                            v: Some("done".into()),
                        },
                    ),
                ])),
                ..RowCreate::default()
            })
            .unwrap();
    }
    e.store.lifeapp_react(&[(k["log"].clone(), None)]).unwrap();
    let h = e.store.db_row_get(&habit.id).unwrap().row;
    let num = |key: &str| match h.values.get(&k[key]) {
        Some(CellValue::Computed { v }) => v.value.as_f64(),
        _ => None,
    };
    assert_eq!(num("habits.prop:current_streak"), Some(3.0));
    assert_eq!(num("habits.prop:best_streak"), Some(3.0));
    assert!(num("habits.prop:rate_30d").unwrap() > 0.0);
}

#[test]
fn studio_templates_make_new_spreadsheets_every_time() {
    let e = env(false);
    let r = install(&e, "spreadsheet-studio", json!({"intent": "blank"}), None);
    let a = e
        .store
        .lifeapp_add_workbook(&r.instance_id, "loan")
        .unwrap();
    let b = e
        .store
        .lifeapp_add_workbook(&r.instance_id, "loan")
        .unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(a.kind, PageKind::Sheet);
    assert_eq!(a.title, "Loan calculator");
    assert_eq!(b.title, "Loan calculator 2");
    assert!(a.app_instance_id.is_none(), "an ordinary spreadsheet");
    assert!(a.parent_id.is_none());
    for intent in [
        "budget",
        "decision",
        "project",
        "timesheet",
        "inventory",
        "split",
        "compound",
        "blank",
    ] {
        let m = e
            .store
            .lifeapp_add_workbook(&r.instance_id, intent)
            .unwrap();
        let info = e.store.sheet_workbook_get(&m.id).unwrap();
        assert!(!info.sheets.is_empty(), "{intent}");
    }
    assert_eq!(
        e.store
            .lifeapp_add_workbook(&r.instance_id, "import")
            .unwrap_err()
            .code(),
        "INVALID"
    );
    assert_eq!(
        e.store
            .lifeapp_add_workbook(&r.instance_id, "project_budget")
            .unwrap_err()
            .code(),
        "INVALID"
    );
    let m = e
        .store
        .lifeapp_metrics(&r.instance_id, &["workbook_count".to_owned()])
        .unwrap();
    // The blank one from setup, two loans and eight more.
    assert_eq!(m["workbook_count"].value, json!(11));
}

#[test]
fn loan_template_pays_off_sooner_with_an_extra_payment() {
    let e = env(false);
    let r = install(&e, "spreadsheet-studio", json!({"intent": "blank"}), None);
    let wb = e
        .store
        .lifeapp_add_workbook(&r.instance_id, "loan")
        .unwrap();
    let info = e.store.sheet_workbook_get(&wb.id).unwrap();
    let sheet = |n: &str| info.sheets.iter().find(|s| s.name == n).unwrap().id.clone();
    let (inputs, calc) = (sheet("Inputs"), sheet("Calculations"));
    let shown = |row: u32, col: u32| e.store.sheet_get_cell(&calc, row, col).unwrap().display;
    let periods = |s: String| s.replace(',', "").parse::<f64>().unwrap_or(f64::NAN);
    let base = periods(shown(3, 1));
    let set_extra = |v: &str| {
        e.store
            .sheet_set_cells(
                &inputs,
                vec![emp_sheets::CellEdit {
                    row: 7,
                    col: 1,
                    input: Some(v.into()),
                }],
                emp_sheets::Rect::new(0, 0, 20, 5),
                None,
            )
            .unwrap();
    };
    set_extra("500");
    let with_extra = periods(shown(3, 1));
    set_extra("1500");
    let with_more = periods(shown(3, 1));
    assert!(base > 2.0, "periods without extra: {base}");
    assert!(
        with_extra > 2.0 && with_extra < base,
        "with 500 extra: {with_extra} (base {base})"
    );
    assert!(
        with_more < with_extra,
        "with 1500 extra: {with_more} (500: {with_extra})"
    );
}

/// Sets cells (`(row, col, input)`, zero-based) of a sheet.
fn set_cells(e: &common::Env, sheet: &str, cells: &[(u32, u32, &str)]) {
    e.store
        .sheet_set_cells(
            sheet,
            cells
                .iter()
                .map(|(row, col, v)| emp_sheets::CellEdit {
                    row: *row,
                    col: *col,
                    input: Some((*v).into()),
                })
                .collect(),
            emp_sheets::Rect::new(0, 0, 40, 10),
            None,
        )
        .unwrap();
}

#[test]
fn inventory_and_timesheet_templates_grow_with_their_data() {
    let e = env(false);
    let r = install(&e, "spreadsheet-studio", json!({"intent": "blank"}), None);
    let sheet_of = |wb: &str, n: &str| {
        e.store
            .sheet_workbook_get(wb)
            .unwrap()
            .sheets
            .iter()
            .find(|s| s.name == n)
            .unwrap()
            .id
            .clone()
    };
    let shown =
        |sheet: &str, row: u32, col: u32| e.store.sheet_get_cell(sheet, row, col).unwrap().display;

    // Inventory: a third item to reorder spills below the list header without hitting the total, and a new item
    // row counts in the value without a formula of its own.
    let inv = e
        .store
        .lifeapp_add_workbook(&r.instance_id, "inventory")
        .unwrap();
    let (items, calc) = (
        sheet_of(&inv.id, "Items"),
        sheet_of(&inv.id, "Calculations"),
    );
    set_cells(
        &e,
        &items,
        &[
            (3, 1, "10"),
            (5, 0, "Tape"),
            (5, 1, "1"),
            (5, 2, "4"),
            (5, 3, "2"),
        ],
    );
    let reorder: Vec<String> = (3..8).map(|row| shown(&calc, row, 0)).collect();
    assert!(reorder.iter().all(|v| !v.starts_with('#')), "{reorder:?}");
    assert_eq!(
        reorder.iter().filter(|v| !v.is_empty()).count(),
        4,
        "{reorder:?}"
    );
    // 4×32 + 12×18 + 10×1.2 + 2×9 + 1×4
    assert_eq!(shown(&calc, 0, 1).replace(',', ""), "378.00");

    // Timesheet: every week with entries gets its own total.
    let ts = e
        .store
        .lifeapp_add_workbook(&r.instance_id, "timesheet")
        .unwrap();
    let (log, calc) = (sheet_of(&ts.id, "Log"), sheet_of(&ts.id, "Calculations"));
    set_cells(
        &e,
        &log,
        &[
            (6, 0, "2026-12-01"),
            (6, 1, "09:00"),
            (6, 2, "13:00"),
            (6, 3, "0"),
        ],
    );
    let weeks: Vec<(String, String)> = (1..4)
        .map(|row| (shown(&calc, row, 0), shown(&calc, row, 1)))
        .collect();
    assert!(
        weeks
            .iter()
            .all(|(a, b)| !a.starts_with('#') && !b.starts_with('#')),
        "{weeks:?}"
    );
    assert_eq!(
        weeks.iter().filter(|(w, _)| !w.is_empty()).count(),
        2,
        "{weeks:?}"
    );
    assert_eq!(
        weeks[1].1.trim_end_matches(".00").trim_end_matches(".0"),
        "4",
        "{weeks:?}"
    );
}

#[test]
fn split_expenses_stay_live_for_new_people_and_payments() {
    let e = env(false);
    let r = install(&e, "spreadsheet-studio", json!({"intent": "blank"}), None);
    let wb = e
        .store
        .lifeapp_add_workbook(&r.instance_id, "split")
        .unwrap();
    let info = e.store.sheet_workbook_get(&wb.id).unwrap();
    let sheet = |n: &str| info.sheets.iter().find(|s| s.name == n).unwrap().id.clone();
    let (inputs, expenses, balances) = (sheet("Inputs"), sheet("Expenses"), sheet("Balances"));
    set_cells(&e, &inputs, &[(6, 0, "Dee")]);
    set_cells(
        &e,
        &expenses,
        &[
            (4, 0, "2026-11-23"),
            (4, 1, "Hotel"),
            (4, 2, "Cy"),
            (4, 3, "300"),
        ],
    );
    let num = |row: u32, col: u32| {
        e.store
            .sheet_get_cell(&balances, row, col)
            .unwrap()
            .display
            .replace(',', "")
            .parse::<f64>()
            .unwrap_or(f64::NAN)
    };
    // 495 spent by four people: 123.75 each. Ana paid 150, Ben 45, Cy 300, Dee 0.
    let nets: Vec<f64> = (1..5).map(|row| num(row, 1)).collect();
    assert_eq!(nets, vec![26.25, -78.75, 176.25, -123.75], "{nets:?}");
    assert!((num(2, 3) - 78.75).abs() < 0.001, "Ben pays in");
    assert!((num(3, 4) - 176.25).abs() < 0.001, "Cy gets back");
    assert_eq!(e.store.sheet_get_cell(&balances, 5, 0).unwrap().display, "");
}
