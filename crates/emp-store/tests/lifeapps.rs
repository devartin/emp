//! Life apps end to end: every manifest plans and installs into a temp vault in both encryption modes, advisor
//! rules fire on sample data, tune-ups diff and apply, sample data toggles, uninstall keeps or trashes content.

mod common;

use std::sync::atomic::Ordering;

use common::{contains, env, raw_payload};
use emp_store::NoProgress;
use emp_store::lifeapps::answers::Mode;
use emp_store::lifeapps::{self, catalog};
use emp_store::model::PageKind;
use emp_store::repo::lifeapps::{LifeappInstall, LifeappPreview};
use serde_json::{Map, Value, json};

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// Representative answers per app (guided mode answers more steps).
fn answers(app: &str) -> Map<String, Value> {
    obj(match app {
        "money-hq" => json!({
            "currency": {"code": "USD", "numberFormat": "en-US", "monthStartDay": 1},
            "household": {"mode": "partner_joint", "dependents": 1},
            "income": {"items": [{"name": "Salary", "amount": 2600, "frequency": "biweekly", "net": true, "nextPayDate": "2026-10-02"}], "stability": "stable"},
            "bills": [{"name": "Rent / Mortgage", "amount": 1500, "schedule": "FREQ=MONTHLY;BYMONTHDAY=1", "autopay": true}, {"name": "Phone", "amount": 60, "schedule": "FREQ=MONTHLY;BYMONTHDAY=12"}],
            "accounts": [{"name": "Checking", "type": "checking", "balance": 2500, "onBudget": true}, {"name": "Visa", "type": "credit_card", "balance": 1800, "apr": 22.9, "minPayment": 50, "limit": 5000, "onBudget": true}],
            "goals": [{"name": "Vacation", "target": 3000, "date": "2027-06-01", "priority": "medium"}],
            "emergency": {"current": 400, "months": 6, "starter": 1500}
        }),
        "portfolio" => json!({
            "experience": "intermediate",
            "accounts": [{"name": "Brokerage", "broker": "Sample", "currency": "USD", "type": "taxable", "taxTreatment": "taxable"}, {"name": "Roth", "broker": "Sample", "currency": "USD", "type": "roth_ira", "taxTreatment": "free"}],
            "risk": {"horizon": "gt10", "drop": "hold", "income": "stable", "goal": "retirement"},
            "watchlist": [{"ticker": "AAPL", "alertAbove": 250}]
        }),
        "tax-organizer" => json!({
            "jurisdiction": {"country": "US", "year": 2026, "residency": "resident"},
            "household": {"filingStatus": "single", "dependents": 0, "seniorOrBlind": 0},
            "income": ["employment", "interest", "self_employment"],
            "events": ["bought_home"],
            "payments": {"withholdingYtd": 6000, "withholdingRemaining": 1500, "estimatesPaid": 0, "priorTax": 11000, "priorAgi": 90000}
        }),
        "spreadsheet-studio" => json!({"intent": "loan"}),
        "life-os" => json!({"style": "gtd", "areas": ["work", "health", "home"]}),
        "habits" => {
            json!({"pick": [{"name": "Meditate", "type": "duration", "schedule": "daily", "target": 10, "unit": "min"}], "grace": "never_miss_twice"})
        }
        _ => json!({}),
    })
}

fn register_tax_pack(store: &emp_store::Store) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../emp-finance/packs/tax/us-federal-2026.json"
    );
    if let Ok(src) = std::fs::read_to_string(path) {
        let v: Value = serde_json::from_str(&src).unwrap();
        store.lifeapps_register_pack("us-federal-2026", v);
    }
}

#[test]
fn every_manifest_is_embedded_and_valid() {
    assert_eq!(catalog().len(), lifeapps::MANIFEST_SOURCES.len());
    for (id, src) in lifeapps::MANIFEST_SOURCES {
        lifeapps::LifeAppManifest::parse(src).unwrap_or_else(|e| panic!("{id}: {e}"));
    }
}

fn install_all(encrypted: bool) {
    let e = env(encrypted);
    register_tax_pack(&e.store);
    let ws = e.workspace();
    // One instance per app and workspace: guided installs go to a second workspace.
    let ws2 = e.store.workspace_create("Second", None).unwrap().id;
    for m in catalog() {
        for mode in [Mode::Quick, Mode::Guided] {
            let target = if mode == Mode::Quick {
                ws.clone()
            } else {
                ws2.clone()
            };
            let a = answers(&m.id);
            let plan = e
                .store
                .lifeapp_preview(&LifeappPreview {
                    app_id: m.id.clone(),
                    answers: a.clone(),
                    mode,
                    disabled_keys: vec![],
                })
                .unwrap_or_else(|err| panic!("{} preview: {err}", m.id));
            assert!(plan.items.iter().any(|i| i.enabled), "{}: empty plan", m.id);
            assert!(plan.counts.values().sum::<u32>() > 0);
            let r = e
                .store
                .lifeapp_install(
                    &LifeappInstall {
                        app_id: m.id.clone(),
                        answers: a,
                        mode,
                        disabled_keys: vec![],
                        workspace_id: target.clone(),
                        sample_data: true,
                    },
                    &NoProgress,
                )
                .unwrap_or_else(|err| {
                    panic!("{} install ({mode:?}, enc={encrypted}): {err}", m.id)
                });
            let root = e.store.page_get(&r.root_page_id).unwrap();
            assert_eq!(
                root.meta.app_instance_id.as_deref(),
                Some(r.instance_id.as_str())
            );
            assert!(r.created.len() >= 2, "{}: {:?}", m.id, r.created);
            // Every generated database has its schema and views.
            for id in &r.created {
                let meta = e.store.page_get(id).unwrap().meta;
                if meta.kind == PageKind::Database {
                    let s = e.store.db_get_schema(id).unwrap();
                    assert!(!s.views.is_empty(), "{}: {} has no view", m.id, meta.title);
                }
            }
            let metrics = e.store.lifeapp_metrics(&r.instance_id, &[]).unwrap();
            assert_eq!(metrics.len(), m.metrics.len());
            let insights = e.store.lifeapp_insights(Some(&r.instance_id)).unwrap();
            if m.id != "spreadsheet-studio" {
                assert!(
                    !insights.is_empty(),
                    "{}: no insight fired on sample data; metrics: {metrics:#?}",
                    m.id
                );
            }
        }
    }
    for w in [&ws, &ws2] {
        let inst = e.store.lifeapp_instances(w).unwrap();
        assert_eq!(inst.len(), catalog().len());
        let list = e.store.lifeapp_list(Some(w)).unwrap();
        assert!(list.iter().all(|s| s.installed == 1));
    }
    // A second instance of an installed app is refused.
    let again = e.store.lifeapp_install(
        &LifeappInstall {
            app_id: "habits".into(),
            answers: answers("habits"),
            mode: Mode::Quick,
            disabled_keys: vec![],
            workspace_id: ws.clone(),
            sample_data: false,
        },
        &NoProgress,
    );
    assert_eq!(again.unwrap_err().code(), "CONFLICT");
}

#[test]
fn every_app_installs_encrypted() {
    install_all(true);
}

#[test]
fn every_app_installs_plain() {
    install_all(false);
}

#[test]
fn money_hq_end_to_end() {
    let e = env(true);
    let ws = e.workspace();
    let a = answers("money-hq");
    let plan = e
        .store
        .lifeapp_preview(&LifeappPreview {
            app_id: "money-hq".into(),
            answers: a.clone(),
            mode: Mode::Guided,
            disabled_keys: vec!["subscriptions".into(), "hq".into()],
        })
        .unwrap();
    assert!(
        plan.items
            .iter()
            .any(|i| i.key == "subscriptions" && !i.enabled)
    );
    assert!(
        plan.items.iter().any(|i| i.key == "hq" && i.enabled),
        "required items stay on"
    );
    assert!(!plan.warnings.is_empty());
    assert!(plan.recommendations.iter().any(|r| r.step_id == "method"));
    assert_eq!(plan.counts.get("dashboard"), Some(&1));
    let r = e
        .store
        .lifeapp_install(
            &LifeappInstall {
                app_id: "money-hq".into(),
                answers: a.clone(),
                mode: Mode::Guided,
                disabled_keys: vec![],
                workspace_id: ws.clone(),
                sample_data: false,
            },
            &NoProgress,
        )
        .unwrap();
    // Content is encrypted on disk.
    let conn = e.db();
    let (enc, raw) = raw_payload(&conn, "pages", "id", &r.root_page_id);
    assert_eq!(enc, 1);
    assert!(!contains(&raw, b"Money HQ"));
    // Accounts were created from the answers, with ids derived from the instance.
    let tree = e.store.page_tree(&ws).unwrap();
    let accounts = tree.iter().find(|p| p.title == "Accounts").unwrap();
    let rows = e.store.db_row_titles(&accounts.id).unwrap();
    assert_eq!(rows.len(), 2);
    // Metrics from answers alone.
    let m = e
        .store
        .lifeapp_metrics(
            &r.instance_id,
            &["net_worth".into(), "utilization_max".into()],
        )
        .unwrap();
    assert_eq!(m["net_worth"].value, json!(700.0));
    assert!((m["utilization_max"].value.as_f64().unwrap() - 0.36).abs() < 1e-9);
    assert!(
        e.store
            .lifeapp_metrics(&r.instance_id, &["nope".into()])
            .is_err()
    );
    // Insights: utilization 36% and emergency fund below starter.
    let ins = e.store.lifeapp_insights(Some(&r.instance_id)).unwrap();
    let ids: Vec<&str> = ins.iter().map(|i| i.rule_id.as_str()).collect();
    assert!(ids.contains(&"util-30"), "{ids:?}");
    assert!(ids.contains(&"ef-below-starter"), "{ids:?}");
    assert_eq!(
        ins[0].severity,
        emp_store::lifeapps::manifest::Severity::Warn
    );
    // Mute.
    e.store
        .lifeapp_insight_mute(&r.instance_id, "util-30", Some(common::T0 + 86_400_000))
        .unwrap();
    let ins = e.store.lifeapp_insights(None).unwrap();
    let util = ins.iter().find(|i| i.rule_id == "util-30").unwrap();
    assert!(util.muted_until.is_some());
    assert_eq!(ins.last().unwrap().rule_id, "util-30");
    // Sample data on / off.
    let on = e.store.lifeapp_sample_data(&r.instance_id, true).unwrap();
    assert!(on.rows > 40);
    let ins = e.store.lifeapp_insights(Some(&r.instance_id)).unwrap();
    let ids: Vec<&str> = ins.iter().map(|i| i.rule_id.as_str()).collect();
    for rule in [
        "uncategorized",
        "cat-over",
        "possible-dupes",
        "sub-price-up",
        "sub-renewal-14d",
        "reconcile-30d",
    ] {
        assert!(ids.contains(&rule), "{rule} missing from {ids:?}");
    }
    let off = e.store.lifeapp_sample_data(&r.instance_id, false).unwrap();
    assert_eq!(off.rows, on.rows);
    assert_eq!(e.store.db_row_titles(&accounts.id).unwrap().len(), 2);
    // Checklist.
    e.store
        .lifeapp_checklist_tick(&r.instance_id, "budget")
        .unwrap();
    assert!(
        e.store
            .lifeapp_checklist_tick(&r.instance_id, "nope")
            .is_err()
    );
    let ticked = e
        .store
        .lifeapp_event("finance.import_committed", &Map::new())
        .unwrap();
    assert_eq!(ticked, vec![(r.instance_id.clone(), "import".to_owned())]);
    let inst = e.store.lifeapp_instances(&ws).unwrap().remove(0);
    assert!(inst.checklist.iter().any(|c| c.id == "budget" && c.done));
    assert!(!inst.upgrade_available);
    // Reminders: bills and rituals.
    let rems = e
        .store
        .reminder_list(common::T0, common::T0 + 40 * 86_400_000)
        .unwrap();
    assert!(rems.len() >= 3, "{rems:?}");

    // Tune-up: nothing changes with the same answers.
    let diff = e.store.lifeapp_tuneup_preview(&r.instance_id, &a).unwrap();
    assert!(diff.add.is_empty(), "{:?}", diff.add);
    assert!(diff.update.is_empty(), "{:?}", diff.update);
    // A new account and a renamed method page; the user edited the order-of-operations page meanwhile.
    let order = tree
        .iter()
        .find(|p| p.title == "Financial order of operations")
        .unwrap();
    e.store
        .page_update_meta(
            &order.id,
            emp_store::model::PageMetaPatch {
                title: Some("My money plan".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let mut a2 = a.clone();
    a2["accounts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name": "Savings", "type": "savings", "balance": 900, "onBudget": true}));
    a2.insert(
        "emergency".into(),
        json!({"current": 400, "months": 9, "starter": 1500}),
    );
    let diff = e.store.lifeapp_tuneup_preview(&r.instance_id, &a2).unwrap();
    assert!(
        diff.add.iter().any(|i| i.key.contains("Savings")),
        "{:?}",
        diff.add
    );
    let upd: Vec<&str> = diff.update.iter().map(|u| u.key.as_str()).collect();
    assert!(
        upd.contains(&"ef_guide") || upd.contains(&"order"),
        "{upd:?}"
    );
    let order_upd = diff.update.iter().find(|u| u.key == "order");
    if let Some(u) = order_upd {
        assert!(!u.conflict || u.fields.contains(&"content".to_owned()));
    }
    let res = e
        .store
        .lifeapp_tuneup_apply(&r.instance_id, &a2, &[], &NoProgress)
        .unwrap();
    assert!(!res.changed.is_empty());
    assert_eq!(e.store.db_row_titles(&accounts.id).unwrap().len(), 3);
    assert_eq!(
        e.store.page_get(&order.id).unwrap().meta.title,
        "My money plan",
        "user edits survive"
    );
    let again = e.store.lifeapp_tuneup_preview(&r.instance_id, &a2).unwrap();
    assert!(
        again.add.is_empty() && again.update.iter().all(|u| u.conflict),
        "{again:?}"
    );

    // Uninstall keeping content: pages stay, unlinked.
    e.store.lifeapp_uninstall(&r.instance_id, true).unwrap();
    assert!(e.store.lifeapp_instances(&ws).unwrap().is_empty());
    let root = e.store.page_get(&r.root_page_id).unwrap();
    assert!(root.meta.app_instance_id.is_none());
    assert!(root.meta.deleted_at.is_none());
}

#[test]
fn uninstall_without_content_trashes_and_detach_unlinks() {
    let e = env(false);
    let ws = e.workspace();
    let r = e
        .store
        .lifeapp_install(
            &LifeappInstall {
                app_id: "habits".into(),
                answers: answers("habits"),
                mode: Mode::Quick,
                disabled_keys: vec![],
                workspace_id: ws.clone(),
                sample_data: false,
            },
            &NoProgress,
        )
        .unwrap();
    e.store.lifeapp_uninstall(&r.instance_id, false).unwrap();
    assert!(
        e.store
            .page_get(&r.root_page_id)
            .unwrap()
            .meta
            .deleted_at
            .is_some()
    );
    assert!(
        e.store
            .trash_list(&ws, None)
            .unwrap()
            .iter()
            .any(|p| p.id == r.root_page_id)
    );
    let r2 = e
        .store
        .lifeapp_install(
            &LifeappInstall {
                app_id: "life-os".into(),
                answers: answers("life-os"),
                mode: Mode::Quick,
                disabled_keys: vec![],
                workspace_id: ws.clone(),
                sample_data: true,
            },
            &NoProgress,
        )
        .unwrap();
    e.store.lifeapp_detach(&r2.instance_id).unwrap();
    let inst = e.store.lifeapp_instances(&ws).unwrap();
    assert!(inst[0].detached);
    assert!(
        e.store
            .lifeapp_metrics(&r2.instance_id, &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        e.store
            .lifeapp_tuneup_preview(&r2.instance_id, &answers("life-os"))
            .is_err()
    );
    assert!(
        e.store
            .page_get(&r2.root_page_id)
            .unwrap()
            .meta
            .app_instance_id
            .is_none()
    );
}

#[test]
fn ids_are_deterministic_per_instance_and_locked_vault_refuses() {
    let e = env(true);
    let ws = e.workspace();
    let ws2 = e.store.workspace_create("Second", None).unwrap().id;
    let mk = |w: &String| {
        e.store
            .lifeapp_install(
                &LifeappInstall {
                    app_id: "spreadsheet-studio".into(),
                    answers: answers("spreadsheet-studio"),
                    mode: Mode::Quick,
                    disabled_keys: vec![],
                    workspace_id: w.clone(),
                    sample_data: false,
                },
                &NoProgress,
            )
            .unwrap()
    };
    let a = mk(&ws);
    let b = mk(&ws2);
    assert_ne!(a.root_page_id, b.root_page_id);
    let g = emp_store::lifeapps::ids::IdGen::new(&a.instance_id).unwrap();
    assert_eq!(g.id("studio"), a.root_page_id);
    // The loan workbook computed its payment.
    let wb = a
        .created
        .iter()
        .find(|id| e.store.page_get(id).unwrap().meta.kind == PageKind::Sheet)
        .unwrap();
    let info = e.store.sheet_workbook_get(wb).unwrap();
    assert!(info.sheets.len() >= 3);
    assert!(
        info.named_ranges
            .iter()
            .any(|n| n.name.eq_ignore_ascii_case("Principal"))
    );
    let calc = info
        .sheets
        .iter()
        .find(|s| s.name == "Calculations")
        .unwrap();
    let cell = e.store.sheet_get_cell(&calc.id, 1, 1).unwrap();
    let shown = serde_json::to_value(&cell).unwrap().to_string();
    assert!(!shown.contains("#"), "payment cell: {shown}");
    // Lint insight on a broken formula.
    e.store
        .sheet_set_cells(
            &calc.id,
            vec![emp_sheets::CellEdit {
                row: 30,
                col: 1,
                input: Some("=1/0".into()),
            }],
            emp_sheets::Rect::new(0, 0, 40, 10),
            None,
        )
        .unwrap();
    let ins = e.store.lifeapp_insights(Some(&a.instance_id)).unwrap();
    assert!(ins.iter().any(|i| i.rule_id == "lint-div0"), "{ins:?}");
    e.store.lock().unwrap();
    assert!(e.store.lifeapp_instances(&ws).is_err());
    let _ = e.clock.0.load(Ordering::SeqCst);
}
