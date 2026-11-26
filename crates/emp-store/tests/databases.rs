//! Databases: schema CRUD, rows, two-way relations, rollups, formulas, views and `db_query`.

mod common;

use std::collections::BTreeMap;

use common::{PASSWORD, T0, contains, env, pw, raw_payload};
use emp_store::NoProgress;
use emp_store::query::model::*;
use serde_json::json;

fn tasks(e: &common::Env) -> DbCreated {
    let ws = e.workspace();
    e.store
        .db_create(DbCreate::new(&ws, None, "Tasks").with_properties(vec![
                PropertySpec::new("Task", PropType::Title),
                PropertySpec::new("Points", PropType::Number),
                PropertySpec::new("Status", PropType::Status),
                PropertySpec::new("Tags", PropType::MultiSelect)
                    .with_config(json!({"options":[{"name":"Home"},{"name":"Work"}]})),
                PropertySpec::new("Due", PropType::Date),
                PropertySpec::new("Done", PropType::Checkbox),
                PropertySpec::new("Cost", PropType::Money).with_config(json!({"currency":"USD"})),
                PropertySpec::new("Key", PropType::UniqueId).with_config(json!({"prefix":"T"})),
            ]))
        .unwrap()
}

fn pid(s: &DbSchema, name: &str) -> String {
    s.property_named(name).unwrap().id.clone()
}

fn date(d: &str) -> CellValue {
    CellValue::Date {
        v: Some(DateValue {
            start: d.into(),
            end: None,
            time: false,
            tz: None,
        }),
    }
}

fn rows_of(r: QueryResponse) -> QueryResult {
    match r {
        QueryResponse::Rows(r) => r,
        QueryResponse::NotModified { .. } => panic!("unexpected notModified"),
    }
}

#[test]
fn schema_crud_and_rows() {
    let e = env(false);
    let c = tasks(&e);
    let s = &c.schema;
    assert_eq!(s.properties.len(), 8);
    assert_eq!(s.properties[0].kind, PropType::Title);
    assert_eq!(s.properties[0].name, "Task");
    assert_eq!(s.views.len(), 1);
    assert_eq!(s.views[0].visible_props.len(), 8);
    // Status gets default options with groups.
    let status = s.property_named("Status").unwrap();
    let opts = status.config["options"].as_array().unwrap();
    assert_eq!(opts.len(), 3);
    assert_eq!(opts[2]["group"], "complete");

    let db = &c.page.id;
    let title = pid(s, "Task");
    let row = e
        .store
        .db_row_create(
            RowCreate::new(db)
                .with(&title, CellValue::text("Write spec"))
                .with(&pid(s, "Points"), CellValue::number(3.0)),
        )
        .unwrap();
    assert_eq!(
        row.values[&pid(s, "Key")],
        CellValue::Uid { v: "T-1".into() }
    );
    let row2 = e
        .store
        .db_row_create(RowCreate::new(db).with(&title, CellValue::text("Ship")))
        .unwrap();
    assert_eq!(
        row2.values[&pid(s, "Key")],
        CellValue::Uid { v: "T-2".into() }
    );

    // Invalid values are rejected.
    assert!(
        e.store
            .db_row_create(RowCreate::new(db).with(&pid(s, "Points"), CellValue::text("x")))
            .is_err()
    );
    // Update with baseRev; stale revs conflict.
    let up = e
        .store
        .db_rows_update(vec![RowUpdate {
            id: row.id.clone(),
            values: BTreeMap::from([(pid(s, "Points"), Some(CellValue::number(5.0)))]),
            base_rev: Some(row.rev),
        }])
        .unwrap();
    assert_eq!(up[0].values[&pid(s, "Points")], CellValue::number(5.0));
    let err = e
        .store
        .db_rows_update(vec![RowUpdate {
            id: row.id.clone(),
            values: BTreeMap::new(),
            base_rev: Some(row.rev),
        }])
        .unwrap_err();
    assert_eq!(err.code(), "CONFLICT");
    // Read-only columns cannot be written.
    assert!(
        e.store
            .db_rows_update(vec![RowUpdate::one(
                &row.id,
                &pid(s, "Key"),
                Some(CellValue::Uid { v: "X".into() })
            )])
            .is_err()
    );
    // Get with neighbours.
    let g = e.store.db_row_get(&row.id).unwrap();
    assert_eq!(g.next_id.as_deref(), Some(row2.id.as_str()));
    assert!(g.prev_id.is_none());
    // Delete / restore / move / duplicate.
    e.store
        .db_rows_delete(std::slice::from_ref(&row.id))
        .unwrap();
    let q = rows_of(e.store.db_query(QueryRequest::new(db, None, 50)).unwrap());
    assert_eq!(q.total, 1);
    assert_eq!(e.store.db_rows_trash(db).unwrap().len(), 1);
    e.store
        .db_rows_restore(std::slice::from_ref(&row.id))
        .unwrap();
    e.store
        .db_rows_move(std::slice::from_ref(&row.id), None, Some(&row2.id), None)
        .unwrap();
    let q = rows_of(e.store.db_query(QueryRequest::new(db, None, 50)).unwrap());
    assert_eq!(q.rows[0].id, row2.id);
    let dup = e
        .store
        .db_rows_duplicate(std::slice::from_ref(&row.id))
        .unwrap();
    assert_eq!(dup[0].values[&title], CellValue::text("Write spec"));
    assert_eq!(
        dup[0].values[&pid(s, "Key")],
        CellValue::Uid { v: "T-3".into() }
    );
    // Property update / reorder / delete.
    let pts = pid(s, "Points");
    let p = e
        .store
        .db_property_update(
            &pts,
            PropertyPatch {
                name: Some("Estimate".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(p.name, "Estimate");
    assert!(
        e.store
            .db_property_update(
                &pts,
                PropertyPatch {
                    name: Some("task".into()),
                    ..Default::default()
                }
            )
            .is_err()
    );
    e.store
        .db_property_reorder(&pts, Some(&title), None)
        .unwrap();
    let s2 = e.store.db_get_schema(db).unwrap();
    assert_eq!(s2.properties[0].id, pts);
    e.store.db_property_delete(&pts, false).unwrap();
    let s3 = e.store.db_get_schema(db).unwrap();
    assert!(s3.property(&pts).is_none());
    assert!(!s3.views[0].visible_props.contains(&pts));
    assert!(e.store.db_property_delete(&title, false).is_err());
    e.store.db_property_restore(&pts).unwrap();
    assert!(e.store.db_get_schema(db).unwrap().property(&pts).is_some());
}

#[test]
fn query_filters_sorts_groups_and_rev() {
    let e = env(false);
    let c = tasks(&e);
    let s = &c.schema;
    let db = &c.page.id;
    let (t, pts, st, due, done, cost) = (
        pid(s, "Task"),
        pid(s, "Points"),
        pid(s, "Status"),
        pid(s, "Due"),
        pid(s, "Done"),
        pid(s, "Cost"),
    );
    let opts = s.property(&st).unwrap().config["options"]
        .as_array()
        .unwrap()
        .clone();
    let (todo, doing) = (
        opts[0]["id"].as_str().unwrap().to_owned(),
        opts[1]["id"].as_str().unwrap().to_owned(),
    );
    let money = |v: &str| CellValue::Money {
        v: Some(v.into()),
        cur: "USD".into(),
    };
    for (name, n, status, d, chk, m) in [
        ("Item 10", 3.0, &todo, "2026-09-10", false, "0.10"),
        ("item 2", 1.0, &doing, "2026-09-20", true, "0.20"),
        ("Éclair", 8.0, &todo, "2026-10-01", false, "0.30"),
    ] {
        e.store
            .db_row_create(
                RowCreate::new(db)
                    .with(&t, CellValue::text(name))
                    .with(&pts, CellValue::number(n))
                    .with(
                        &st,
                        CellValue::Status {
                            v: Some(status.clone()),
                        },
                    )
                    .with(&due, date(d))
                    .with(&done, CellValue::Check { v: chk })
                    .with(&cost, money(m)),
            )
            .unwrap();
    }
    let view = &s.views[0];
    let mut aggs = BTreeMap::new();
    aggs.insert(cost.clone(), AggFn::Sum);
    aggs.insert(pts.clone(), AggFn::Avg);
    e.store
        .db_view_update(
            &view.id,
            ViewPatch {
                sorts: Some(vec![Sort {
                    prop: t.clone(),
                    dir: SortDir::Asc,
                }]),
                footer_aggs: Some(aggs),
                ..Default::default()
            },
        )
        .unwrap();
    let mut req = QueryRequest::new(db, Some(&view.id), 2);
    let r = rows_of(e.store.db_query(req.clone()).unwrap());
    assert_eq!(r.total, 3);
    assert_eq!(r.rows.len(), 2);
    let names: Vec<String> = r.rows.iter().map(|x| x.text_of(&t)).collect();
    assert_eq!(names, vec!["Éclair", "item 2"]);
    assert_eq!(r.aggs[&cost], "0.6");
    assert_eq!(r.aggs[&pts], "4");
    // Same inputs → notModified.
    req.known_query_rev = Some(r.query_rev.clone());
    assert!(matches!(
        e.store.db_query(req.clone()).unwrap(),
        QueryResponse::NotModified { .. }
    ));
    // A write changes the rev.
    e.store
        .db_row_create(RowCreate::new(db).with(&t, CellValue::text("New")))
        .unwrap();
    let r2 = rows_of(e.store.db_query(req.clone()).unwrap());
    assert_ne!(r2.query_rev, r.query_rev);
    assert_eq!(r2.total, 4);
    // Override: filter + group by status group + window into one group.
    let mut req = QueryRequest::new(db, Some(&view.id), 10);
    req.override_ = Some(QueryOverride {
        filter: Some(Filter::And {
            and: vec![
                Filter::cond(&pts, FilterOp::Gte, Some(json!(2))),
                Filter::Or {
                    or: vec![
                        Filter::cond(&due, FilterOp::Before, Some(json!("2026-09-15"))),
                        Filter::cond(&t, FilterOp::Contains, Some(json!("ecl"))),
                    ],
                },
            ],
        }),
        group_by: Some(Some(GroupBy {
            prop: st.clone(),
            date_bucket: None,
            by_status_group: Some(true),
            hide_empty: Some(true),
            order: None,
        })),
        ..Default::default()
    });
    req.group = Some("todo".into());
    let r = rows_of(e.store.db_query(req).unwrap());
    assert_eq!(r.total, 2);
    let groups = r.groups.unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].count, 2);
    // Filters deeper than 3 levels are rejected.
    let deep = Filter::And {
        and: vec![Filter::Or {
            or: vec![Filter::And {
                and: vec![Filter::Or {
                    or: vec![Filter::cond(&pts, FilterOp::Empty, None)],
                }],
            }],
        }],
    };
    let mut req = QueryRequest::new(db, None, 10);
    req.override_ = Some(QueryOverride {
        filter: Some(deep),
        ..Default::default()
    });
    assert_eq!(e.store.db_query(req).unwrap_err().code(), "INVALID");
    // Search.
    let mut req = QueryRequest::new(db, None, 10);
    req.override_ = Some(QueryOverride {
        search: Some("ITEM".into()),
        ..Default::default()
    });
    assert_eq!(rows_of(e.store.db_query(req).unwrap()).total, 2);
    // Calendar range.
    let in_sept = e
        .store
        .db_query_range(db, &view.id, &due, "2026-09-01", "2026-09-30")
        .unwrap();
    assert_eq!(in_sept.len(), 2);
    // Chart.
    let chart = e
        .store
        .db_chart_data(
            db,
            None,
            None,
            &ChartSpec {
                kind: "bar".into(),
                x: ChartX {
                    prop: due.clone(),
                    bucket: Some(DateBucket::Month),
                },
                y: vec![ChartY {
                    agg: AggFn::Sum,
                    prop: Some(cost.clone()),
                    as_: None,
                }],
                series: None,
                stacked: None,
                cumulative: None,
                labels: None,
                smooth: None,
                omit_zero: None,
                colors: None,
            },
            None,
        )
        .unwrap();
    assert_eq!(chart.x.len(), 2);
    assert_eq!(chart.series[0].values, vec![Some(0.3), Some(0.3)]);
}

#[test]
fn two_way_relations_rollups_and_formulas() {
    let e = env(true);
    let ws = e.workspace();
    let projects = e
        .store
        .db_create(DbCreate::new(&ws, None, "Projects"))
        .unwrap();
    let tasks = e
        .store
        .db_create(
            DbCreate::new(&ws, None, "Tasks")
                .with_properties(vec![PropertySpec::new("Hours", PropType::Number)]),
        )
        .unwrap();
    let (pdb, tdb) = (projects.page.id.clone(), tasks.page.id.clone());
    let rel = e
        .store
        .db_property_create(
            &tdb,
            "Project",
            PropType::Relation,
            json!({"targetDatabaseId": pdb, "dual": {}})
                .as_object()
                .cloned(),
            None,
        )
        .unwrap();
    let dual = rel.config["dual"]["propertyId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ps = e.store.db_get_schema(&pdb).unwrap();
    let back = ps.property(&dual).unwrap();
    assert_eq!(back.name, "Tasks");
    assert_eq!(back.config["dual"]["propertyId"], rel.id);
    let hours = pid(&tasks.schema, "Hours");
    // Rollup on projects: sum of task hours; formula on top of it.
    let sum = e
        .store
        .db_property_create(
            &pdb,
            "Total hours",
            PropType::Rollup,
            json!({"relationPropId": dual, "targetPropId": hours, "fn": "sum"})
                .as_object()
                .cloned(),
            None,
        )
        .unwrap();
    let f = e
        .store
        .db_property_create(
            &pdb,
            "Days",
            PropType::Formula,
            json!({"expression": "prop(\"Total hours\") / 8"})
                .as_object()
                .cloned(),
            None,
        )
        .unwrap();
    assert_eq!(f.config["expression"], "prop(\"Total hours\") / 8");
    let check = e
        .store
        .db_formula_check(&pdb, "prop(\"Total hours\") * 2")
        .unwrap();
    assert!(check.ok);
    let bad = e
        .store
        .db_formula_check(&pdb, "prop(\"Total hours\" * ")
        .unwrap();
    assert!(!bad.ok && bad.error.is_some());

    let ptitle = ps.database.primary_prop_id.clone();
    let p1 = e
        .store
        .db_row_create(RowCreate::new(&pdb).with(&ptitle, CellValue::text("Apollo")))
        .unwrap();
    let ttitle = tasks.schema.database.primary_prop_id.clone();
    let t1 = e
        .store
        .db_row_create(
            RowCreate::new(&tdb)
                .with(&ttitle, CellValue::text("Design"))
                .with(&hours, CellValue::number(12.0))
                .with(
                    &rel.id,
                    CellValue::Relation {
                        v: vec![p1.id.clone()],
                    },
                ),
        )
        .unwrap();
    let t2 = e
        .store
        .db_row_create(
            RowCreate::new(&tdb)
                .with(&ttitle, CellValue::text("Build"))
                .with(&hours, CellValue::number(4.0)),
        )
        .unwrap();
    // The dual side was written.
    let p = e.store.db_row_get(&p1.id).unwrap().row;
    assert_eq!(
        p.values[&dual],
        CellValue::Relation {
            v: vec![t1.id.clone()]
        }
    );
    // Link from the other side.
    e.store
        .db_rows_update(vec![RowUpdate::one(
            &p1.id,
            &dual,
            Some(CellValue::Relation {
                v: vec![t1.id.clone(), t2.id.clone()],
            }),
        )])
        .unwrap();
    let t2r = e.store.db_row_get(&t2.id).unwrap().row;
    assert_eq!(
        t2r.values[&rel.id],
        CellValue::Relation {
            v: vec![p1.id.clone()]
        }
    );
    let p = e.store.db_row_get(&p1.id).unwrap().row;
    assert_eq!(
        emp_store::query::cells::number(p.values.get(&sum.id)),
        Some(16.0)
    );
    assert_eq!(
        emp_store::query::cells::number(p.values.get(&f.id)),
        Some(2.0)
    );
    // Unlink: both sides update.
    e.store
        .db_rows_update(vec![RowUpdate::one(&t1.id, &rel.id, None)])
        .unwrap();
    let p = e.store.db_row_get(&p1.id).unwrap().row;
    assert_eq!(
        p.values[&dual],
        CellValue::Relation {
            v: vec![t2.id.clone()]
        }
    );
    assert_eq!(
        emp_store::query::cells::number(p.values.get(&sum.id)),
        Some(4.0)
    );
    // Renaming the rolled-up chain keeps formulas working (stored by id).
    e.store
        .db_property_update(
            &sum.id,
            PropertyPatch {
                name: Some("Hours sum".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let s = e.store.db_get_schema(&pdb).unwrap();
    assert_eq!(
        s.property(&f.id).unwrap().config["expression"],
        "prop(\"Hours sum\") / 8"
    );
    // Relation picker.
    let opts = e.store.db_relation_options(&rel.id, "apo", 10).unwrap();
    assert_eq!(opts.len(), 1);
    assert_eq!(opts[0].title, "Apollo");
    // Encrypted: no plaintext on disk.
    let conn = e.db();
    let (enc, raw) = raw_payload(&conn, "db_rows", "id", &t1.id);
    assert_eq!(enc, 1);
    assert!(!contains(&raw, b"Design"));
    let (enc, raw) = raw_payload(&conn, "db_properties", "id", &f.id);
    assert_eq!(enc, 1);
    assert!(!contains(&raw, b"Days"));
    let _ = (PASSWORD, T0);
}

#[test]
fn conversions_templates_options_and_secrets() {
    let e = env(true);
    let ws = e.workspace();
    let c = e
        .store
        .db_create(DbCreate::new(&ws, None, "Inbox").with_properties(vec![
            PropertySpec::new("Kind", PropType::Text),
            PropertySpec::new("Amount", PropType::Text),
            PropertySpec::new("When", PropType::Date),
            PropertySpec::new("Seq", PropType::Number),
            PropertySpec::new("Pin", PropType::Secret),
        ]))
        .unwrap();
    let db = c.page.id.clone();
    let s = &c.schema;
    let (kind, amount, when, seq, pin) = (
        pid(s, "Kind"),
        pid(s, "Amount"),
        pid(s, "When"),
        pid(s, "Seq"),
        pid(s, "Pin"),
    );
    for (k, a) in [("Bill", "12.5"), ("bill", "x"), ("Receipt", "3")] {
        e.store
            .db_row_create(
                RowCreate::new(&db)
                    .with(&kind, CellValue::text(k))
                    .with(&amount, CellValue::text(a)),
            )
            .unwrap();
    }
    // text → select creates options from distinct values (case-insensitive).
    let p = e
        .store
        .db_property_convert(&kind, PropType::Select, None, &NoProgress)
        .unwrap();
    let options = p.config["options"].as_array().unwrap();
    assert_eq!(options.len(), 2);
    // text → number: unparseable values become empty.
    e.store
        .db_property_convert(&amount, PropType::Number, None, &NoProgress)
        .unwrap();
    let r = rows_of(e.store.db_query(QueryRequest::new(&db, None, 10)).unwrap());
    let nums: Vec<Option<f64>> = r
        .rows
        .iter()
        .map(|x| emp_store::query::cells::number(x.values.get(&amount)))
        .collect();
    assert_eq!(nums, vec![Some(12.5), None, Some(3.0)]);
    assert!(
        r.rows
            .iter()
            .all(|x| matches!(x.values.get(&kind), Some(CellValue::Select { v: Some(_) })))
    );
    // A pre_bulk version was recorded.
    let conn = e.db();
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM versions WHERE target_id = ?1 AND reason = 'pre_bulk'",
            [&db],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2);
    // Unsupported conversion.
    assert_eq!(
        e.store
            .db_property_convert(&when, PropType::Checkbox, None, &NoProgress)
            .unwrap_err()
            .code(),
        "UNSUPPORTED"
    );
    // Option delete clears values.
    let opt_id = options[0]["id"].as_str().unwrap().to_owned();
    e.store.db_select_option_delete(&kind, &opt_id).unwrap();
    let r = rows_of(e.store.db_query(QueryRequest::new(&db, None, 10)).unwrap());
    assert!(!r.rows[0].values.contains_key(&kind));
    let p = e
        .store
        .db_select_option_upsert(
            &kind,
            SelectOptionInput {
                id: None,
                name: "Tax".into(),
                color: emp_store::model::BlockColor::Red,
                group: None,
            },
        )
        .unwrap();
    assert_eq!(p.config["options"].as_array().unwrap().len(), 2);
    // Templates with variables.
    let tpl = RowTemplate {
        id: "tpl1".into(),
        name: "Bill".into(),
        icon: None,
        values: BTreeMap::from([
            (when.clone(), TemplateValue::Token("@today+1w".into())),
            (seq.clone(), TemplateValue::Token("@seq".into())),
        ]),
        doc: Some(common::doc_of(&["Pay before due date"])),
    };
    e.store
        .db_update(
            &db,
            DbPatch {
                templates: Some(vec![tpl]),
                default_template_id: Some(Some("tpl1".into())),
                ..Default::default()
            },
        )
        .unwrap();
    let row = e.store.db_row_create(RowCreate::new(&db)).unwrap();
    // T0 = 2026-09-21 (UTC); +1 week.
    let today = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(T0)
        .unwrap()
        .date_naive();
    let want = (today + chrono::Duration::weeks(1))
        .format("%Y-%m-%d")
        .to_string();
    assert_eq!(row.values[&when], date(&want));
    assert!(row.has_body);
    let g = e.store.db_row_get(&row.id).unwrap();
    assert!(g.doc.is_some());
    // Secrets: masked in rows, reveal requires reauth.
    let r = e
        .store
        .db_row_secret_set(&row.id, &pin, &pw("1234-5678"))
        .unwrap();
    assert_eq!(
        r.values[&pin],
        CellValue::Secret {
            v: Some(SecretMask {
                masked: "••••5678".into()
            })
        }
    );
    assert_eq!(
        e.store.row_secret_reveal(&row.id, &pin).unwrap_err().code(),
        "REAUTH_REQUIRED"
    );
    e.store.reauth(&pw(PASSWORD)).unwrap();
    use emp_crypto::ExposeSecret;
    assert_eq!(
        e.store
            .row_secret_reveal(&row.id, &pin)
            .unwrap()
            .expose_secret(),
        "1234-5678"
    );
    assert!(e.store.secret_list().unwrap().is_empty());
    assert!(
        e.store
            .db_rows_update(vec![RowUpdate::one(
                &row.id,
                &pin,
                Some(CellValue::Secret { v: None })
            )])
            .is_err()
    );
}

#[test]
fn views_crud_and_duplicate() {
    let e = env(false);
    let c = tasks(&e);
    let db = c.page.id.clone();
    let st = pid(&c.schema, "Status");
    let board = e
        .store
        .db_view_create(&db, "Board", Layout::Board, None)
        .unwrap();
    assert_eq!(board.group_by.as_ref().unwrap().prop, st);
    let cal = e
        .store
        .db_view_create(&db, "Calendar", Layout::Calendar, Some(&board.id))
        .unwrap();
    assert_eq!(
        cal.calendar.as_ref().unwrap().date_prop,
        pid(&c.schema, "Due")
    );
    let views = e.store.db_get_schema(&db).unwrap().views;
    assert_eq!(
        views.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(),
        vec!["Table", "Board", "Calendar"]
    );
    e.store
        .db_view_reorder(&cal.id, Some(&views[0].id), None)
        .unwrap();
    let views = e.store.db_get_schema(&db).unwrap().views;
    assert_eq!(views[0].id, cal.id);
    // Invalid filter op for type is rejected.
    assert!(
        e.store
            .db_view_update(
                &cal.id,
                ViewPatch {
                    filter: Some(Some(Filter::cond(&st, FilterOp::Gt, Some(json!(1))))),
                    ..Default::default()
                }
            )
            .is_err()
    );
    e.store.db_view_delete(&cal.id).unwrap();
    e.store.db_view_delete(&board.id).unwrap();
    assert!(e.store.db_view_delete(&views[1].id).is_err());
    // Duplicate with rows.
    let t = c.schema.database.primary_prop_id.clone();
    e.store
        .db_row_create(RowCreate::new(&db).with(&t, CellValue::text("A")))
        .unwrap();
    let copy = e.store.db_duplicate(&db, true, &NoProgress).unwrap();
    assert_eq!(copy.title, "Tasks (copy)");
    let r = rows_of(
        e.store
            .db_query(QueryRequest::new(&copy.id, None, 10))
            .unwrap(),
    );
    assert_eq!(r.total, 1);
    let cs = e.store.db_get_schema(&copy.id).unwrap();
    assert_eq!(r.rows[0].text_of(&cs.database.primary_prop_id), "A");
    assert_eq!(cs.views.len(), 1);
}
