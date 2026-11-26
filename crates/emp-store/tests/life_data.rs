//! Reminders + scheduler, outbox and sync links.

mod common;

use common::{T0, contains, env};
use emp_store::life::scheduler::Scheduler;
use emp_store::repo::reminders::{ReminderTarget, ReminderUpsert};
use emp_store::repo::sync_links::SyncLink;
use serde_json::json;

#[test]
fn reminders_fire_snooze_and_list() {
    let e = env(true);
    let page = e.page(None, "Taxes");
    let id = e
        .store
        .reminder_upsert(ReminderUpsert {
            id: None,
            fire_at: T0 + 60_000,
            target_kind: ReminderTarget::Page,
            target_id: page.clone(),
            block_id: None,
            text: "File the return".into(),
        })
        .unwrap();
    let sched = Scheduler::new(e.store.clone());
    assert_eq!(sched.next_wake().unwrap(), T0 + 60_000);
    assert!(sched.tick().unwrap().is_empty());
    e.advance(61_000);
    let fired = sched.tick().unwrap();
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0].reminder.text, "File the return");
    assert!(!fired[0].missed);
    assert!(sched.tick().unwrap().is_empty());
    let list = e.store.reminder_list(T0, T0 + 120_000).unwrap();
    assert!(list[0].fired);
    // Snooze re-arms it.
    e.store.reminder_snooze(&id, 15).unwrap();
    assert!(e.store.reminder_snooze(&id, 7).is_err());
    assert_eq!(e.store.reminder_for_target(&page).unwrap().len(), 1);
    e.advance(16 * 60_000);
    assert_eq!(sched.tick().unwrap().len(), 1);
    // Text is encrypted on disk; timing is plaintext.
    let conn = e.db();
    let raw: Vec<u8> = conn
        .query_row("SELECT payload FROM reminders WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!contains(&raw, b"File the return"));
    e.store.reminder_delete(&id).unwrap();
    assert!(e.store.reminder_delete(&id).is_err());
    // Validation.
    assert!(
        e.store
            .reminder_upsert(ReminderUpsert {
                id: None,
                fire_at: T0,
                target_kind: ReminderTarget::Block,
                target_id: page,
                block_id: None,
                text: "x".into(),
            })
            .is_err()
    );
    // Locked: the scheduler does nothing.
    e.store.lock().unwrap();
    assert!(sched.tick().unwrap().is_empty());
}

#[test]
fn outbox_backoff_and_sync_links() {
    let e = env(true);
    let id = e
        .store
        .outbox_enqueue("gcal", json!({"op":"insert","event":{"summary":"Dentist"}}))
        .unwrap();
    let due = e.store.outbox_due(Some("gcal"), 10).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].op["event"]["summary"], "Dentist");
    let next = e.store.outbox_fail(&id, "503", None).unwrap();
    assert_eq!(next, T0 + 30_000);
    assert!(e.store.outbox_due(None, 10).unwrap().is_empty());
    e.advance(30_000);
    let due = e.store.outbox_due(None, 10).unwrap();
    assert_eq!(due[0].attempts, 1);
    assert_eq!(due[0].last_error.as_deref(), Some("503"));
    assert_eq!(
        e.store.outbox_fail(&id, "429", Some(5_000)).unwrap(),
        T0 + 35_000
    );
    assert_eq!(e.store.outbox_count("gcal").unwrap(), 1);
    e.store.outbox_complete(&id).unwrap();
    assert_eq!(e.store.outbox_count("gcal").unwrap(), 0);
    assert!(e.store.outbox_enqueue("Bad Provider", json!({})).is_err());

    let page = e.page(None, "Event");
    let link = SyncLink {
        id: String::new(),
        provider: String::new(),
        local_id: String::new(),
        remote_id: "evt_123@google.com".into(),
        etag: Some("e1".into()),
        account_id: Some("me".into()),
        last_synced_rev: 3,
        updated_at: 0,
    };
    let l = e
        .store
        .sync_link_upsert("gcal", &page, link.clone())
        .unwrap();
    let again = e
        .store
        .sync_link_upsert(
            "gcal",
            &page,
            SyncLink {
                etag: Some("e2".into()),
                ..link
            },
        )
        .unwrap();
    assert_eq!(l.id, again.id);
    let found = e
        .store
        .sync_link_by_remote("gcal", "evt_123@google.com")
        .unwrap()
        .unwrap();
    assert_eq!(found.etag.as_deref(), Some("e2"));
    assert_eq!(found.local_id, page);
    assert_eq!(e.store.sync_links_for_local(&page).unwrap().len(), 1);
    assert!(
        e.store
            .sync_link_by_remote("gcal", "other")
            .unwrap()
            .is_none()
    );
    // The remote id never appears on disk.
    let conn = e.db();
    let (key, raw): (String, Vec<u8>) = conn
        .query_row(
            "SELECT remote_key, payload FROM sync_links WHERE id = ?1",
            [&l.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(!key.contains("evt_123"));
    assert!(!contains(&raw, b"evt_123"));
    assert_eq!(e.store.sync_links_clear("gcal").unwrap(), 1);
}
