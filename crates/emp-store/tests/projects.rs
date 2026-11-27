//! Projects (Ultranote 1.0 brief §2.2, §3): a project is a `doc` page with `flags.project`. The flag round-trips
//! through `page_create`, `page_update_meta` and the page tree, merges with the other flags, and is refused on
//! pages that are not documents.

mod common;

use common::*;
use emp_store::model::{PageCreate, PageFlags, PageKind, PageMetaPatch};

fn project_flags(on: bool) -> PageFlags {
    PageFlags {
        project: Some(on),
        ..Default::default()
    }
}

#[test]
fn project_flag_round_trips_through_create_update_and_tree() {
    for encrypted in [false, true] {
        let e = env(encrypted);
        let ws = e.workspace();
        let mut req = PageCreate::new(&ws, None, PageKind::Doc, "Website relaunch");
        req.flags = Some(project_flags(true));
        let created = e.store.page_create(req).unwrap();
        assert_eq!(created.meta.flags.project, Some(true));
        let json = serde_json::to_value(&created.meta).unwrap();
        assert_eq!(json["flags"]["project"], serde_json::json!(true));

        // A child is an ordinary page; the project itself keeps the flag in the tree.
        let child = e.page(Some(&created.meta.id), "Launch checklist");
        let tree = e.store.page_tree(&ws).unwrap();
        let proj = tree.iter().find(|m| m.id == created.meta.id).unwrap();
        assert_eq!(proj.flags.project, Some(true));
        assert!(proj.has_children);
        let kid = tree.iter().find(|m| m.id == child).unwrap();
        assert_eq!(kid.flags.project, None);

        // Other flag patches leave `project` alone.
        let m = e
            .store
            .page_update_meta(
                &created.meta.id,
                PageMetaPatch {
                    flags: Some(PageFlags {
                        full_width: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(m.flags.project, Some(true));
        assert_eq!(m.flags.full_width, Some(true));

        // Turn it back into a document.
        let m = e
            .store
            .page_update_meta(
                &created.meta.id,
                PageMetaPatch {
                    flags: Some(project_flags(false)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(m.flags.project, Some(false));
        assert_eq!(m.flags.full_width, Some(true));

        // And into a project again through an update.
        let doc = e.page(None, "Lisbon in March");
        let m = e
            .store
            .page_update_meta(
                &doc,
                PageMetaPatch {
                    flags: Some(project_flags(true)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(m.flags.project, Some(true));
    }
}

#[test]
fn only_documents_can_be_projects() {
    let e = env(false);
    let ws = e.workspace();
    let mut req = PageCreate::new(&ws, None, PageKind::Dashboard, "Board");
    req.flags = Some(project_flags(true));
    let err = e.store.page_create(req).unwrap_err();
    assert_eq!(err.code(), "INVALID");

    let dash = e
        .store
        .page_create(PageCreate::new(&ws, None, PageKind::Dashboard, "Board"))
        .unwrap();
    let err = e
        .store
        .page_update_meta(
            &dash.meta.id,
            PageMetaPatch {
                flags: Some(project_flags(true)),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(err.code(), "INVALID");
    // Clearing the flag on a non-document is harmless.
    e.store
        .page_update_meta(
            &dash.meta.id,
            PageMetaPatch {
                flags: Some(project_flags(false)),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn ipc_shapes_accept_the_project_flag() {
    // `page_create` and `page_update_meta` deny unknown fields: the new keys must be part of the DTOs.
    let req: PageCreate = serde_json::from_value(serde_json::json!({
        "workspaceId": "w",
        "parentId": null,
        "kind": "doc",
        "title": "P",
        "flags": { "project": true }
    }))
    .unwrap();
    assert_eq!(req.flags.and_then(|f| f.project), Some(true));
    let patch: PageMetaPatch = serde_json::from_value(serde_json::json!({ "flags": { "project": false } })).unwrap();
    assert_eq!(patch.flags.and_then(|f| f.project), Some(false));
    // Absent means not a project, and a plain page serialises without the key.
    let flags: PageFlags = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(flags.project, None);
    assert_eq!(serde_json::to_value(&flags).unwrap(), serde_json::json!({}));
}

#[test]
fn template_copies_take_create_flags() {
    let e = env(false);
    let ws = e.workspace();
    let tpl = e.page(None, "Project brief");
    e.store.page_set_template(&tpl, true).unwrap();
    let mut req = PageCreate::new(&ws, None, PageKind::Doc, "From the brief");
    req.template_page_id = Some(tpl);
    req.flags = Some(project_flags(true));
    let made = e.store.page_create(req).unwrap();
    assert_eq!(made.meta.flags.project, Some(true));
    assert_ne!(made.meta.flags.template, Some(true));
}
