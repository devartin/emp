mod common;

use common::*;
use emp_store::doc::schema::container;
use emp_store::model::{
    DocOwnerKind, PageCreate, PageKind, PageMetaPatch, TipTapDoc, TipTapNode, VersionTargetKind,
};
use emp_store::{NoProgress, StoreError};

#[test]
fn tree_ordering_moves_and_cycles() {
    for encrypted in [false, true] {
        let e = env(encrypted);
        let ws = e.workspace();
        let a = e.page(None, "A");
        let b = e.page(None, "B");
        let c = e.page(None, "C");
        let tree: Vec<String> = e
            .store
            .page_tree(&ws)
            .unwrap()
            .into_iter()
            .map(|m| m.title)
            .collect();
        assert_eq!(tree, vec!["A", "B", "C"]);
        // Insert after A.
        let mut req = PageCreate::new(&ws, None, PageKind::Doc, "A2");
        req.after_id = Some(a.clone());
        e.store.page_create(req).unwrap();
        let tree: Vec<String> = e
            .store
            .page_tree(&ws)
            .unwrap()
            .into_iter()
            .map(|m| m.title)
            .collect();
        assert_eq!(tree, vec!["A", "A2", "B", "C"]);
        // Move C before A, then B under C.
        e.store.page_move(&c, None, Some(&a), None).unwrap();
        e.store.page_move(&b, Some(&c), None, None).unwrap();
        let tree = e.store.page_tree(&ws).unwrap();
        let titles: Vec<&str> = tree.iter().map(|m| m.title.as_str()).collect();
        assert_eq!(titles, vec!["C", "B", "A", "A2"]);
        assert!(tree[0].has_children);
        assert_eq!(tree[1].parent_id.as_deref(), Some(c.as_str()));
        // Cycle.
        let err = e.store.page_move(&c, Some(&b), None, None).unwrap_err();
        assert_eq!(err.code(), "INVALID");
        assert!(e.store.page_move(&c, Some(&c), None, None).is_err());
        // Breadcrumbs.
        let got = e.store.page_get(&b).unwrap();
        assert_eq!(got.breadcrumbs.len(), 1);
        assert_eq!(got.breadcrumbs[0].title, "C");
        // Meta update bumps rev.
        let m = e
            .store
            .page_update_meta(
                &b,
                PageMetaPatch {
                    title: Some("Bee".into()),
                    icon: Some(Some(emp_store::model::Icon::Emoji { v: "🐝".into() })),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(m.rev, 2);
        assert_eq!(m.title, "Bee");
        let raw: emp_store::model::PageMetaPatch =
            serde_json::from_value(serde_json::json!({"icon": null})).unwrap();
        let m = e.store.page_update_meta(&b, raw).unwrap();
        assert!(m.icon.is_none());
    }
}

#[test]
fn doc_save_conflicts_and_normalization() {
    let e = env(true);
    let p = e.page(None, "Doc");
    assert_eq!(e.store.page_get(&p).unwrap().doc_rev, 0);
    let r1 = e
        .store
        .page_save_doc(&p, DocOwnerKind::Page, doc_of(&["one"]), 0)
        .unwrap();
    assert_eq!(r1, 1);
    let err = e
        .store
        .page_save_doc(&p, DocOwnerKind::Page, doc_of(&["two"]), 0)
        .unwrap_err();
    assert!(matches!(err, StoreError::Conflict { current_rev: 1 }));
    assert_eq!(err.code(), "CONFLICT");
    // Duplicate block ids are repaired on save.
    let blk = container(para("x"), None).unwrap();
    let doc = TipTapDoc::from_blocks(vec![blk.clone(), blk]);
    e.store
        .page_save_doc(&p, DocOwnerKind::Page, doc, 1)
        .unwrap();
    let saved = e.store.page_get(&p).unwrap().doc.unwrap();
    let a = saved.blocks()[0].attr_str("id").unwrap();
    let b = saved.blocks()[1].attr_str("id").unwrap();
    assert_ne!(a, b);
    // Rows that do not exist cannot own docs.
    assert_eq!(
        e.store
            .page_save_doc("0190-none", DocOwnerKind::Row, doc_of(&["r"]), 0)
            .unwrap_err()
            .code(),
        "NOT_FOUND"
    );
}

#[test]
fn trash_restore_purge_and_expiry() {
    let e = env(false);
    let ws = e.workspace();
    let parent = e.page(None, "Parent");
    let child = e.page(Some(&parent), "Child");
    e.save_text(&child, &["child text"]);
    e.store.page_delete(std::slice::from_ref(&parent)).unwrap();
    assert!(e.store.page_tree(&ws).unwrap().is_empty());
    let trash = e.store.trash_list(&ws, None).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].id, parent);
    assert_eq!(e.store.trash_list(&ws, Some("par")).unwrap().len(), 1);
    assert!(e.store.trash_list(&ws, Some("zzz")).unwrap().is_empty());
    // Restore brings the child back.
    e.store.page_restore(std::slice::from_ref(&parent)).unwrap();
    assert_eq!(e.store.page_tree(&ws).unwrap().len(), 2);
    // Restore to root when the parent is gone.
    e.store.page_delete(std::slice::from_ref(&child)).unwrap();
    e.store.page_delete(std::slice::from_ref(&parent)).unwrap();
    e.store.page_restore(std::slice::from_ref(&child)).unwrap();
    let tree = e.store.page_tree(&ws).unwrap();
    assert_eq!(tree.len(), 1);
    assert_eq!(tree[0].parent_id, None);
    // Purge removes docs and versions too.
    e.store
        .version_create(&child, VersionTargetKind::PageDoc, "keep")
        .unwrap();
    e.store.page_purge(std::slice::from_ref(&child)).unwrap();
    let n: i64 = e
        .db()
        .query_row(
            "SELECT (SELECT count(*) FROM page_docs) + (SELECT count(*) FROM versions)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    // Expiry after 30 days.
    assert_eq!(e.store.trash_purge_expired().unwrap(), 0);
    e.advance(31 * 86_400_000);
    assert_eq!(e.store.trash_purge_expired().unwrap(), 1);
    assert!(e.store.trash_list(&ws, None).unwrap().is_empty());
    let report = e.store.integrity_check(&NoProgress).unwrap();
    assert!(report.ok);
}

#[test]
fn duplicate_turn_into_page_outline_and_blocks() {
    let e = env(true);
    let ws = e.workspace();
    let src = e.page(None, "Source");
    let kid = e.page(Some(&src), "Kid");
    e.save_text(&kid, &["kid body"]);
    let h = container(
        TipTapNode::new("heading")
            .with_attr("level", serde_json::json!(2))
            .with_content(vec![TipTapNode::text("Section")]),
        None,
    )
    .unwrap();
    let p1 = container(para("move me"), None).unwrap();
    let p2 = container(para("and me"), None).unwrap();
    let keep = container(para("stay"), None).unwrap();
    let ids: Vec<String> = [&p1, &p2]
        .iter()
        .map(|n| n.attr_str("id").unwrap().to_owned())
        .collect();
    let hid = h.attr_str("id").unwrap().to_owned();
    e.store
        .page_save_doc(
            &src,
            DocOwnerKind::Page,
            TipTapDoc::from_blocks(vec![h, p1, p2, keep]),
            0,
        )
        .unwrap();
    let outline = e.store.page_outline(&src).unwrap();
    assert_eq!(outline.len(), 1);
    assert_eq!(outline[0].text, "Section");
    assert!(e.store.page_get_block(&src, &hid).unwrap().is_some());

    let (child, rev) = e.store.page_turn_into_page(&src, &ids, "Moved").unwrap();
    assert_eq!(rev, 2);
    let src_doc = e.store.page_get(&src).unwrap().doc.unwrap();
    let kinds: Vec<&str> = src_doc
        .blocks()
        .iter()
        .map(|b| b.children()[0].kind.as_str())
        .collect();
    assert_eq!(kinds, vec!["heading", "pageRef", "paragraph"]);
    let child_doc = e.store.page_get(&child.id).unwrap().doc.unwrap();
    assert_eq!(child_doc.blocks().len(), 2);
    assert_eq!(child.parent_id.as_deref(), Some(src.as_str()));
    // A pre_bulk version was taken.
    let versions = e
        .store
        .version_list(&src, VersionTargetKind::PageDoc)
        .unwrap();
    assert!(versions.iter().any(|v| v.reason == "pre_bulk"));

    // Deep duplicate copies descendants with fresh block ids.
    let dup = e.store.page_duplicate(&src, true).unwrap();
    assert_eq!(dup.title, "Source (copy)");
    let tree: Vec<String> = e
        .store
        .page_tree(&ws)
        .unwrap()
        .into_iter()
        .map(|m| m.title)
        .collect();
    assert_eq!(
        tree,
        vec!["Source", "Kid", "Moved", "Source (copy)", "Kid", "Moved"]
    );
    let dup_doc = e.store.page_get(&dup.id).unwrap().doc.unwrap();
    assert_ne!(
        dup_doc.blocks()[0].attr_str("id"),
        src_doc.blocks()[0].attr_str("id")
    );

    // Templates.
    e.store.page_set_template(&kid, true).unwrap();
    let tpls = e.store.template_list(&ws).unwrap();
    assert_eq!(tpls.len(), 1);
    let applied = e.store.template_apply(&kid, &ws, None).unwrap();
    assert_eq!(applied.flags.template, None);
    assert!(e.store.page_get(&applied.id).unwrap().doc.is_some());

    // Daily notes are created once.
    let d1 = e.store.daily_note_open("2026-11-26").unwrap();
    let d2 = e.store.daily_note_open("2026-11-26").unwrap();
    assert_eq!(d1.id, d2.id);
    assert_eq!(d1.title, "Thursday, Nov 26, 2026");
    // The mock's daily template: Focus (three to-dos), Notes, End of day.
    let body = serde_json::to_string(&e.store.page_get(&d1.id).unwrap().doc).unwrap();
    for part in [
        "\"Focus\"",
        "\"Notes\"",
        "\"End of day\"",
        "\"What went well?\"",
    ] {
        assert!(body.contains(part), "daily note body lacks {part}");
    }
    assert_eq!(body.matches("\"todoItem\"").count(), 3);
    assert!(matches!(
        d1.icon,
        Some(emp_store::model::Icon::Lucide { .. })
    ));
    // Under "Journal", newest first (the browser mock's order and titles).
    let d0 = e.store.daily_note_open("2026-11-25").unwrap();
    let d3 = e.store.daily_note_open("2026-11-27").unwrap();
    assert_eq!(d3.title, "Friday, Nov 27, 2026");
    let folder = e.store.page_get(d1.parent_id.as_deref().unwrap()).unwrap();
    assert_eq!(folder.meta.title, "Journal");
    let kids: Vec<String> = e
        .store
        .page_children(&folder.meta.workspace_id, Some(&folder.meta.id))
        .unwrap()
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(kids, [d3.id.clone(), d1.id.clone(), d0.id.clone()]);
    assert!(e.store.daily_note_open("26/11/2026").is_err());
}

#[test]
fn search_and_backlinks() {
    for encrypted in [false, true] {
        let mut e = env(encrypted);
        let ws = e.workspace();
        let target = e.page(None, "Grocery budget");
        let src = e.page(None, "Weekly plan");
        let doc = TipTapDoc::from_blocks(vec![
            container(
                TipTapNode::new("paragraph").with_content(vec![
                    TipTapNode::text("Remember to check the "),
                    mention(&target),
                    TipTapNode::text(" before shopping on Friday."),
                ]),
                None,
            )
            .unwrap(),
            container(para("Lisbon trip needs a budget too"), None).unwrap(),
        ]);
        e.store
            .page_save_doc(&src, DocOwnerKind::Page, doc, 0)
            .unwrap();
        let back = e.store.page_backlinks(&target).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].source_id, src);
        assert_eq!(back[0].source_title, "Weekly plan");
        assert!(back[0].snippet.contains("before shopping"));

        let res = e.store.search_query("budget ", None, 10, 7).unwrap();
        assert_eq!(res.req_id, 7);
        assert!(res.index_ready);
        assert_eq!(res.hits[0].id, target);
        let body_hit = res.hits.iter().find(|h| h.id == src).unwrap();
        assert!(body_hit.snippet.as_ref().unwrap().text.contains("Lisbon"));
        assert!(body_hit.block_id.is_some());
        // Prefix and fuzzy.
        assert!(
            e.store
                .search_query("lisb", None, 10, 0)
                .unwrap()
                .hits
                .iter()
                .any(|h| h.id == src)
        );
        assert_eq!(
            e.store.search_query("wkly pln", None, 10, 0).unwrap().hits[0].id,
            src
        );
        // Renames re-index; trashed pages are hidden.
        e.store
            .page_update_meta(
                &target,
                PageMetaPatch {
                    title: Some("Food money".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            e.store
                .search_query("food", None, 10, 0)
                .unwrap()
                .hits
                .iter()
                .any(|h| h.id == target)
        );
        e.store.page_delete(std::slice::from_ref(&src)).unwrap();
        assert!(
            e.store
                .search_query("lisbon", None, 10, 0)
                .unwrap()
                .hits
                .is_empty()
        );
        assert!(e.store.page_backlinks(&target).unwrap().is_empty());
        e.store.page_restore(std::slice::from_ref(&src)).unwrap();
        assert_eq!(e.store.page_backlinks(&target).unwrap().len(), 1);
        // Status and rebuild after unlock.
        let st = e.store.search_status().unwrap();
        assert!(st.ready);
        assert_eq!(st.docs, 2);
        e.reopen();
        if encrypted {
            e.store.unlock(&pw(PASSWORD)).unwrap();
        } else {
            e.store.unlock_device().unwrap();
        }
        assert!(
            e.store
                .search_query("lisbon", None, 10, 0)
                .unwrap()
                .hits
                .iter()
                .any(|h| h.id == src)
        );
        assert_eq!(e.store.page_backlinks(&target).unwrap().len(), 1);
        assert_eq!(e.store.search_reindex(&NoProgress).unwrap(), 2);
        let _ = ws;
    }
}

#[test]
fn background_index_build_after_unlock() {
    let mut e = env(true);
    let p = e.page(None, "Background indexed");
    e.save_text(&p, &["searchable words here"]);
    let dir = e.vault_dir();
    e.store.close().unwrap();
    let mut opts = e.opts();
    opts.background_indexing = true;
    e.store = emp_store::Store::open(&dir, opts).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert!(
        e.store
            .wait_index_ready(std::time::Duration::from_secs(10))
            .unwrap()
    );
    e.store.wait_background();
    assert_eq!(
        e.store.search_query("searchable", None, 5, 0).unwrap().hits[0].id,
        p
    );
    assert_eq!(
        e.store.status().unwrap().integrity,
        emp_store::model::IntegrityState::Ok
    );
}

#[test]
fn versions_auto_manual_restore_and_thinning() {
    let e = env(true);
    let p = e.page(None, "Versioned");
    e.save_text(&p, &["short"]);
    // < 64 changed characters: no version.
    assert!(
        e.store
            .version_list(&p, VersionTargetKind::PageDoc)
            .unwrap()
            .is_empty()
    );
    let long = "x".repeat(80);
    e.save_text(&p, &["short", &long]);
    let v = e
        .store
        .version_list(&p, VersionTargetKind::PageDoc)
        .unwrap();
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].reason, "auto");
    // Within 10 minutes: no new auto version.
    e.advance(60_000);
    e.save_text(&p, &["short", &long, &"y".repeat(80)]);
    assert_eq!(
        e.store
            .version_list(&p, VersionTargetKind::PageDoc)
            .unwrap()
            .len(),
        1
    );
    // After 10 minutes the pending edits produce one.
    e.advance(10 * 60_000);
    e.save_text(&p, &["short", &long, &"y".repeat(80), "z"]);
    assert_eq!(
        e.store
            .version_list(&p, VersionTargetKind::PageDoc)
            .unwrap()
            .len(),
        2
    );
    // Checkpoint on page close.
    e.save_text(&p, &["edited once more"]);
    assert!(e.store.version_checkpoint(&p).unwrap());
    assert!(!e.store.version_checkpoint(&p).unwrap());
    // Manual version with a label, then restore it.
    let manual = e
        .store
        .version_create(&p, VersionTargetKind::PageDoc, "Before rewrite")
        .unwrap();
    e.save_text(&p, &["completely rewritten"]);
    let snap = e.store.version_get(&manual.id).unwrap();
    assert!(snap.to_string().contains("edited once more"));
    let rev = e.store.version_restore(&manual.id).unwrap();
    let got = e.store.page_get(&p).unwrap();
    assert_eq!(got.doc_rev, rev);
    assert!(
        serde_json::to_string(&got.doc)
            .unwrap()
            .contains("edited once more")
    );
    let list = e
        .store
        .version_list(&p, VersionTargetKind::PageDoc)
        .unwrap();
    assert!(list.iter().any(|v| v.reason == "pre_restore"));
    assert_eq!(
        list.iter()
            .find(|v| v.id == manual.id)
            .unwrap()
            .label
            .as_deref(),
        Some("Before rewrite")
    );
    // Version payloads are encrypted and compressed.
    let (enc, payload) = raw_payload(&e.db(), "versions", "id", &manual.id);
    assert_eq!(enc, 1);
    assert!(!contains(&payload, b"edited once more"));

    // Thinning: many automatic versions within one 10-minute bucket collapse to one.
    for i in 0..20 {
        e.store
            .version_insert(
                &p,
                VersionTargetKind::PageDoc,
                emp_store::model::VersionReason::Auto,
                None,
                serde_json::json!({"i": i}),
            )
            .unwrap();
    }
    let before = e
        .store
        .version_list(&p, VersionTargetKind::PageDoc)
        .unwrap()
        .len();
    let removed = e.store.versions_thin(&p).unwrap();
    assert!(removed >= 19, "removed {removed} of {before}");
    assert!(
        e.store
            .version_list(&p, VersionTargetKind::PageDoc)
            .unwrap()
            .iter()
            .any(|v| v.id == manual.id)
    );
    e.store.version_delete(&manual.id).unwrap();
    assert_eq!(
        e.store.version_delete(&manual.id).unwrap_err().code(),
        "NOT_FOUND"
    );
}

#[test]
fn assets_streamed_encrypted_and_deduplicated() {
    for encrypted in [false, true] {
        let e = env(encrypted);
        let ws = e.workspace();
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&3u32.to_be_bytes());
        png.extend_from_slice(&2u32.to_be_bytes());
        png.extend(std::iter::repeat_n(7u8, 200_000));
        let a = e
            .store
            .asset_import_bytes(&ws, "pic.png", "application/x-whatever", &png)
            .unwrap();
        assert_eq!(a.mime, "image/png");
        assert_eq!((a.width, a.height), (Some(3), Some(2)));
        assert_eq!(a.size, png.len() as u64);
        assert!(a.url.ends_with(&a.id));
        let b = e
            .store
            .asset_import_bytes(&ws, "same.png", "image/png", &png)
            .unwrap();
        let blobs: i64 = e
            .db()
            .query_row("SELECT count(DISTINCT blob_name) FROM assets", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(blobs, 1);
        let mut s = e.store.asset_open(&a.id).unwrap();
        let mut got = Vec::new();
        std::io::Read::read_to_end(&mut s.reader, &mut got).unwrap();
        assert_eq!(got, png);
        assert_eq!(
            e.store.asset_read_range(&b.id, 100_000, 5).unwrap(),
            vec![7u8; 5]
        );
        // Declared length is enforced.
        let bad = e.store.asset_import(
            emp_store::model::AssetImport {
                workspace_id: ws.clone(),
                name: "x.bin".into(),
                mime: "application/octet-stream".into(),
                len: 10,
                source: "upload".into(),
                origin_url: None,
            },
            &b"too short"[..],
        );
        assert!(bad.is_err());
        // Images that claim to be images but are not are served as octet-stream.
        let fake = e
            .store
            .asset_import_bytes(&ws, "x.png", "image/png", b"not an image")
            .unwrap();
        assert_eq!(fake.mime, "application/octet-stream");
        let ext = e.store.asset_open_external(&a.id).unwrap();
        assert_eq!(std::fs::read(&ext).unwrap(), png);
        e.store.asset_delete(&a.id).unwrap();
        assert!(
            e.store
                .asset_get(std::slice::from_ref(&a.id))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            e.store
                .asset_get(std::slice::from_ref(&b.id))
                .unwrap()
                .len(),
            1
        );
        assert!(
            e.store
                .asset_get(&["../etc".to_owned()])
                .unwrap()
                .is_empty()
        );
        e.store.lock().unwrap();
        assert!(!ext.exists(), "tmp is wiped on lock");
    }
}

#[test]
fn export_markdown_with_links_and_assets() {
    let e = env(false);
    let ws = e.workspace();
    let target = e.page(None, "Target page");
    let src = e.page(None, "Source page");
    let child = e.page(Some(&src), "Child");
    e.save_text(&child, &["child content"]);
    let asset = e
        .store
        .asset_import_bytes(&ws, "a.txt", "text/plain", b"hello")
        .unwrap();
    let doc = TipTapDoc::from_blocks(vec![
        container(
            TipTapNode::new("paragraph")
                .with_content(vec![TipTapNode::text("see "), mention(&target)]),
            None,
        )
        .unwrap(),
        container(
            TipTapNode::new("file").with_attr("assetId", serde_json::json!(asset.id)),
            None,
        )
        .unwrap(),
    ]);
    e.store
        .page_save_doc(&src, DocOwnerKind::Page, doc, 0)
        .unwrap();
    let out = tempfile::tempdir().unwrap();
    let n = e
        .store
        .export_pages(
            &[src.clone(), target.clone()],
            out.path(),
            emp_store::backup::export::ExportOptions {
                format: emp_store::backup::export::ExportFormat::Markdown,
                include_children: true,
                include_assets: true,
            },
            &NoProgress,
        )
        .unwrap();
    assert_eq!(n, 4);
    let md = std::fs::read_to_string(out.path().join("Source page.md")).unwrap();
    assert!(md.starts_with("---\ntitle: \"Source page\""));
    assert!(md.contains("[Target page](Target%20page.md)"), "{md}");
    assert!(md.contains("assets/"));
    assert!(out.path().join("Source page").join("Child.md").exists());
}
