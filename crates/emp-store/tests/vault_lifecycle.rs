mod common;

use common::*;
use emp_crypto::KdfParams;
use emp_store::model::{IntegrityState, SecretKind, SecretSet, VaultState};
use emp_store::{NoProgress, Store, StoreError};

#[test]
fn plaintext_vault_roundtrip() {
    let mut e = env(false);
    let st = e.store.status().unwrap();
    assert_eq!(st.state, VaultState::Unlocked);
    assert!(!st.encrypted);
    assert!(st.kdf.is_none());
    let page = e.page(None, "Plain title");
    e.save_text(&page, &["hello plain world"]);
    // Plaintext JSON on disk.
    let (enc, payload) = raw_payload(&e.db(), "pages", "id", &page);
    assert_eq!(enc, 0);
    assert!(contains(&payload, b"Plain title"));
    // Secrets are always encrypted.
    let info = e
        .store
        .secret_set(SecretSet {
            id: None,
            provider: "finnhub".into(),
            label: "Key".into(),
            kind: SecretKind::ApiKey,
            value: pw("sk-very-secret-1234"),
            show_last4: true,
            allowed_hosts: vec!["finnhub.io".into()],
        })
        .unwrap();
    assert_eq!(info.last4.as_deref(), Some("1234"));
    let (enc, payload) = raw_payload(&e.db(), "secrets", "id", &info.id);
    assert_eq!(enc, 1);
    assert!(!contains(&payload, b"very-secret"));
    // Lock: data commands refuse.
    e.store.lock().unwrap();
    assert!(matches!(e.store.page_get(&page), Err(StoreError::Locked)));
    assert_eq!(e.store.status().unwrap().state, VaultState::Locked);
    // Reopen + device unlock.
    e.reopen();
    e.store.unlock_device().unwrap();
    assert_eq!(e.store.page_get(&page).unwrap().meta.title, "Plain title");
    use emp_crypto::ExposeSecret;
    assert_eq!(
        e.store.secret_value(&info.id).unwrap().expose_secret(),
        "sk-very-secret-1234"
    );
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Ok);
}

#[test]
fn encrypted_vault_roundtrip_and_wrong_password() {
    let mut e = env(true);
    let st = e.store.status().unwrap();
    assert!(st.encrypted);
    assert!(st.kdf.as_ref().unwrap().below_standard);
    let page = e.page(None, "Secret plans");
    e.save_text(&page, &["the treasure is buried under the oak"]);
    let conn = e.db();
    let (enc, payload) = raw_payload(&conn, "pages", "id", &page);
    assert_eq!(enc, 1);
    assert!(!contains(&payload, b"Secret plans"));
    let (enc, payload) = raw_payload(&conn, "page_docs", "owner_id", &page);
    assert_eq!(enc, 1);
    assert!(!contains(&payload, b"treasure"));
    drop(conn);

    e.reopen();
    assert!(matches!(e.store.page_get(&page), Err(StoreError::Locked)));
    assert!(matches!(
        e.store.unlock_device(),
        Err(StoreError::Unsupported(_))
    ));
    let err = e.store.unlock(&pw("wrong password!!")).unwrap_err();
    assert_eq!(err.code(), "BAD_PASSWORD");
    assert_eq!(e.store.status().unwrap().failed_attempts, 1);
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(e.store.status().unwrap().failed_attempts, 0);
    let got = e.store.page_get(&page).unwrap();
    assert_eq!(got.meta.title, "Secret plans");
    assert_eq!(got.doc_rev, 1);
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Ok);
    let log = e.store.security_log(10).unwrap();
    assert!(log.iter().any(|l| l.event == "unlock_fail"));
    assert!(log.iter().any(|l| l.event == "unlock_ok"));
}

#[test]
fn unlock_backoff_is_enforced() {
    let mut e = env(true);
    e.reopen();
    for _ in 0..4 {
        assert_eq!(
            e.store.unlock(&pw("nope nope nope")).unwrap_err().code(),
            "BAD_PASSWORD"
        );
    }
    // Fifth failure starts the 1 s backoff.
    let err = e.store.unlock(&pw("nope nope nope")).unwrap_err();
    assert_eq!(err.retry_after_ms(), Some(1000));
    let err = e.store.unlock(&pw(PASSWORD)).unwrap_err();
    assert_eq!(err.code(), "RATE_LIMITED");
    assert!(e.store.status().unwrap().retry_after_ms > 0);
    e.advance(1001);
    e.store.unlock(&pw(PASSWORD)).unwrap();
}

#[test]
fn change_password_and_recovery() {
    let mut e = env(true);
    // The words are retrievable until confirmed (after re-auth).
    assert!(matches!(
        e.store.recovery_view(),
        Err(StoreError::ReauthRequired)
    ));
    e.store.reauth(&pw(PASSWORD)).unwrap();
    let words: Vec<String> = e.store.recovery_view().unwrap().to_vec();
    assert_eq!(words.len(), 24);
    assert!(
        !e.store
            .recovery_confirm(&[0, 1, 2], &["x".into(), "y".into(), "z".into()])
            .unwrap()
    );
    assert!(
        e.store
            .recovery_confirm(
                &[0, 5, 23],
                &[words[0].clone(), words[5].clone(), words[23].clone()]
            )
            .unwrap()
    );
    assert!(e.store.status().unwrap().recovery_confirmed);
    assert!(e.store.recovery_view().is_err());

    e.store
        .change_password(
            &pw(PASSWORD),
            &pw("a new long password"),
            KdfParams::INSECURE_TEST,
        )
        .unwrap();
    let page = e.page(None, "after change");
    e.reopen();
    assert_eq!(
        e.store.unlock(&pw(PASSWORD)).unwrap_err().code(),
        "BAD_PASSWORD"
    );
    e.store.unlock(&pw("a new long password")).unwrap();
    assert_eq!(e.store.page_get(&page).unwrap().meta.title, "after change");

    // Recovery unlock sets a new password.
    e.reopen();
    e.store
        .unlock_recovery(&words, &pw("recovered password"), KdfParams::INSECURE_TEST)
        .unwrap();
    assert!(e.store.is_unlocked());
    e.reopen();
    e.store.unlock(&pw("recovered password")).unwrap();
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Ok);

    // Regenerating the recovery key invalidates the old words.
    e.store.reauth(&pw("recovered password")).unwrap();
    let new_words = e.store.recovery_regenerate().unwrap().to_vec();
    assert_ne!(new_words, words);
    e.reopen();
    assert!(
        e.store
            .unlock_recovery(&words, &pw("x password 123"), KdfParams::INSECURE_TEST)
            .is_err()
    );
}

#[test]
fn enable_and_disable_encryption() {
    let mut e = env(false);
    let ws = e.workspace();
    let page = e.page(None, "Toggle me");
    e.save_text(&page, &["body text survives toggles"]);
    let asset = e
        .store
        .asset_import_bytes(
            &ws,
            "notes.txt",
            "text/plain",
            b"attachment plaintext content",
        )
        .unwrap();
    e.store
        .kv_set("ui.sidebar", "width", serde_json::json!(280))
        .unwrap();
    e.store
        .settings_set_vault(&serde_json::json!({"profileName": "Ada"}))
        .unwrap();

    let words = e
        .store
        .enable_encryption(&pw(PASSWORD), KdfParams::INSECURE_TEST, &NoProgress)
        .unwrap();
    assert_eq!(words.len(), 24);
    assert!(e.store.status().unwrap().encrypted);
    let conn = e.db();
    let plain_rows: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM pages WHERE enc = 0) + (SELECT count(*) FROM page_docs WHERE enc = 0)
             + (SELECT count(*) FROM workspaces WHERE enc = 0) + (SELECT count(*) FROM kv WHERE enc = 0)
             + (SELECT count(*) FROM settings WHERE scope = 'vault' AND enc = 0)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(plain_rows, 0);
    drop(conn);
    // The blob is encrypted on disk now.
    let blob: String = e
        .db()
        .query_row(
            "SELECT blob_name FROM assets WHERE id = ?1",
            [&asset.id],
            |r| r.get(0),
        )
        .unwrap();
    let bytes = std::fs::read(e.vault_dir().join("assets").join(&blob[..2]).join(&blob)).unwrap();
    assert!(!contains(&bytes, b"attachment plaintext"));
    // The device key is gone.
    assert!(!e.dir.path().join("device.key").exists());

    e.reopen();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Ok);
    assert_eq!(e.store.page_get(&page).unwrap().meta.title, "Toggle me");
    let mut s = e.store.asset_open(&asset.id).unwrap();
    let mut content = Vec::new();
    std::io::Read::read_to_end(&mut s.reader, &mut content).unwrap();
    assert_eq!(content, b"attachment plaintext content");
    assert_eq!(
        e.store.kv_get("ui.sidebar", "width").unwrap(),
        Some(serde_json::json!(280))
    );
    assert_eq!(e.store.vault_settings().unwrap().profile_name, "Ada");

    // Disable needs re-auth.
    assert!(matches!(
        e.store.disable_encryption(&pw(PASSWORD), &NoProgress),
        Err(StoreError::ReauthRequired)
    ));
    e.store.reauth(&pw(PASSWORD)).unwrap();
    e.store
        .disable_encryption(&pw(PASSWORD), &NoProgress)
        .unwrap();
    let (enc, payload) = raw_payload(&e.db(), "pages", "id", &page);
    assert_eq!(enc, 0);
    assert!(contains(&payload, b"Toggle me"));
    e.reopen();
    e.store.unlock_device().unwrap();
    assert_eq!(e.store.page_get(&page).unwrap().meta.title, "Toggle me");
    assert_eq!(
        e.store.asset_read_range(&asset.id, 0, 10).unwrap(),
        b"attachment"
    );
    let report = e.store.integrity_check(&NoProgress).unwrap();
    assert!(report.ok, "{report:?}");
}

#[test]
fn schema_too_new_is_refused() {
    let e = env(false);
    let dir = e.vault_dir();
    e.store.close().unwrap();
    rusqlite::Connection::open(dir.join("vault.db"))
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    let err = Store::open(&dir, e.opts()).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_TOO_NEW");
}

#[test]
fn settings_kv_and_auto_lock() {
    let mut e = env(true);
    let d = e
        .store
        .settings_set_device(&serde_json::json!({"theme": "midnight", "accent": "jade"}))
        .unwrap();
    assert_eq!(d.theme, "midnight");
    assert!(
        e.store
            .settings_set_device(&serde_json::json!({"theme": "neon"}))
            .is_err()
    );
    assert!(
        e.store
            .settings_set_device(&serde_json::json!({"bogus": 1}))
            .is_err()
    );
    let v = e
        .store
        .settings_set_vault(
            &serde_json::json!({"baseCurrency": "EUR", "snapshots": {"keepDaily": 3}}),
        )
        .unwrap();
    assert_eq!(v.base_currency, "EUR");
    assert_eq!(v.snapshots.keep_weekly, 4);
    assert!(
        e.store
            .kv_set("market.quote", "AAPL", serde_json::json!(1))
            .is_err()
    );
    e.store
        .kv_set_any(
            "market.quote",
            "AAPL:XNAS",
            serde_json::json!({"p": 1}),
            Some(T0 + 1000),
        )
        .unwrap();
    // Sensitive keys are blinded on disk.
    let keys: Vec<String> = {
        let c = e.db();
        let mut st = c
            .prepare("SELECT key FROM kv WHERE ns = 'market.quote'")
            .unwrap();
        st.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(keys.len(), 1);
    assert_ne!(keys[0], "AAPL:XNAS");
    assert!(
        e.store
            .kv_get_any("market.quote", "AAPL:XNAS")
            .unwrap()
            .is_some()
    );
    e.advance(2000);
    assert!(
        e.store
            .kv_get_any("market.quote", "AAPL:XNAS")
            .unwrap()
            .is_none()
    );
    assert_eq!(e.store.kv_purge_expired().unwrap(), 1);

    // Auto-lock "Never" needs re-auth.
    let mut al = e.store.auto_lock().unwrap();
    al.idle_minutes = None;
    assert!(matches!(
        e.store.set_auto_lock(al.clone()),
        Err(StoreError::ReauthRequired)
    ));
    e.store.reauth(&pw(PASSWORD)).unwrap();
    e.store.set_auto_lock(al).unwrap();
    e.advance(6 * 60 * 1000);
    assert!(e.store.require_reauth().is_err());

    // Device settings are readable while locked.
    e.reopen();
    assert_eq!(e.store.settings_get().unwrap().device.theme, "midnight");
    assert!(e.store.settings_get().unwrap().vault.is_none());
    assert_eq!(e.store.status().unwrap().auto_lock.idle_minutes, None);
}
