mod common;

use common::*;
use emp_crypto::KdfParams;
use emp_store::backup::restore::{RestoreCredentials, restore_backup};
use emp_store::model::IntegrityState;
use emp_store::{FileDeviceKeyStore, NoProgress, Store};

fn unlock(e: &Env, encrypted: bool) {
    if encrypted {
        e.store.unlock(&pw(PASSWORD)).unwrap();
    } else {
        e.store.unlock_device().unwrap();
    }
}

#[test]
fn tampered_record_is_reported_damaged() {
    let mut e = env(true);
    let a = e.page(None, "Alpha");
    let b = e.page(None, "Beta");
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        let (_, mut payload) = raw_payload(&c, "pages", "id", &a);
        let last = payload.len() - 1;
        payload[last] ^= 0x01;
        c.execute(
            "UPDATE pages SET payload = ?2 WHERE id = ?1",
            rusqlite::params![a, payload],
        )
        .unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Warning);
    let err = e.store.page_get(&a).unwrap_err();
    assert_eq!(err.code(), "CRYPTO");
    assert!(matches!(
        err,
        emp_store::StoreError::Damaged { table: "pages", .. }
    ));
    // Other records still work.
    assert_eq!(e.store.page_get(&b).unwrap().meta.title, "Beta");
    let report = e.store.integrity_check(&NoProgress).unwrap();
    assert!(!report.ok);
    assert!(report.mset_mismatch);
    assert_eq!(report.damaged.len(), 1);
    assert_eq!(report.damaged[0].id, a);
    assert!(
        e.store
            .security_log(50)
            .unwrap()
            .iter()
            .any(|l| l.event == "integrity_fail")
    );
}

#[test]
fn swapped_payloads_and_deleted_rows_are_detected() {
    let mut e = env(true);
    let a = e.page(None, "Alpha");
    let b = e.page(None, "Beta");
    let c_ = e.page(None, "Gamma");
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        let (_, pa) = raw_payload(&c, "pages", "id", &a);
        let (_, pb) = raw_payload(&c, "pages", "id", &b);
        c.execute(
            "UPDATE pages SET payload = ?2 WHERE id = ?1",
            rusqlite::params![a, pb],
        )
        .unwrap();
        c.execute(
            "UPDATE pages SET payload = ?2 WHERE id = ?1",
            rusqlite::params![b, pa],
        )
        .unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    let report = e.store.integrity_check(&NoProgress).unwrap();
    assert_eq!(report.damaged.len(), 2, "AAD binds the id");
    // Accept and re-seal (needs re-auth), then delete a row behind EMP's back.
    e.store.page_purge(&[a.clone(), b.clone()]).unwrap();
    e.store.reauth(&pw(PASSWORD)).unwrap();
    e.store.integrity_reseal().unwrap();
    assert!(e.store.integrity_check(&NoProgress).unwrap().ok);
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        c.execute("DELETE FROM pages WHERE id = ?1", [&c_]).unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Warning);
    let report = e.store.integrity_check(&NoProgress).unwrap();
    assert!(report.mset_mismatch);
    assert!(report.damaged.is_empty());
}

#[test]
fn rolled_back_keyslot_tampering_breaks_state_mac() {
    let mut e = env(true);
    e.page(None, "x");
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        c.execute(
            "UPDATE keyslots SET created_at = created_at + 1 WHERE kind = 'recovery'",
            [],
        )
        .unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert!(e.store.integrity_check(&NoProgress).unwrap().mset_mismatch);
}

#[test]
fn encrypted_backup_restores_into_new_vault() {
    let e = env(true);
    let ws = e.workspace();
    let p = e.page(None, "Backed up");
    e.save_text(&p, &["important words"]);
    let asset = e
        .store
        .asset_import_bytes(&ws, "f.bin", "application/octet-stream", &[42u8; 70_000])
        .unwrap();
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("vault.empbackup");
    let bytes = e
        .store
        .backup_create(&file, None, KdfParams::INSECURE_TEST, &NoProgress)
        .unwrap();
    assert_eq!(bytes, std::fs::metadata(&file).unwrap().len());
    let raw = std::fs::read(&file).unwrap();
    assert!(raw.starts_with(b"EMPSNAP\0"));
    assert!(!contains(&raw, b"important words"));

    // Wrong password.
    let target = out.path().join("restored");
    let dk = FileDeviceKeyStore::new(out.path().join("device.key"));
    let bad = restore_backup(
        &file,
        &target,
        &RestoreCredentials {
            password: Some(pw("not the password")),
            ..Default::default()
        },
        &dk,
        T0,
        &NoProgress,
    );
    assert_eq!(bad.unwrap_err().code(), "BAD_PASSWORD");
    assert!(!target.join("vault.db").exists());

    let restored = restore_backup(
        &file,
        &target,
        &RestoreCredentials {
            password: Some(pw(PASSWORD)),
            ..Default::default()
        },
        &dk,
        T0,
        &NoProgress,
    )
    .unwrap();
    assert!(restored.encrypted);
    assert_eq!(restored.pages, 1);
    assert_eq!(restored.vault_id, e.store.vault_id().to_hex());
    let s2 = Store::open(&target, e.opts()).unwrap();
    s2.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(s2.status().unwrap().integrity, IntegrityState::Ok);
    assert_eq!(s2.page_get(&p).unwrap().doc.unwrap().blocks().len(), 1);
    assert_eq!(
        s2.asset_read_range(&asset.id, 69_998, 10).unwrap(),
        vec![42, 42]
    );
    assert!(
        s2.security_log(10)
            .unwrap()
            .iter()
            .any(|l| l.event == "backup_restore")
    );
    // Never overwrites.
    assert!(
        restore_backup(
            &file,
            &target,
            &RestoreCredentials::default(),
            &dk,
            T0,
            &NoProgress
        )
        .is_err()
    );
    s2.close().unwrap();

    // Tampering with any byte is detected.
    let mut tampered = raw.clone();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 0x80;
    let tfile = out.path().join("tampered.empbackup");
    std::fs::write(&tfile, &tampered).unwrap();
    let err = restore_backup(
        &tfile,
        &out.path().join("restored2"),
        &RestoreCredentials {
            password: Some(pw(PASSWORD)),
            ..Default::default()
        },
        &dk,
        T0,
        &NoProgress,
    )
    .unwrap_err();
    assert!(matches!(err.code(), "INTEGRITY" | "CRYPTO"), "{err:?}");
    // Truncation too.
    std::fs::write(&tfile, &raw[..raw.len() - 10]).unwrap();
    assert!(
        restore_backup(
            &tfile,
            &out.path().join("restored3"),
            &RestoreCredentials::default(),
            &dk,
            T0,
            &NoProgress
        )
        .is_err()
    );
}

#[test]
fn plaintext_backup_needs_password_and_restores_elsewhere() {
    let e = env(false);
    let p = e.page(None, "Plain backed up");
    e.save_text(&p, &["plain words"]);
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("plain.empbackup");
    assert!(
        e.store
            .backup_create(&file, None, KdfParams::INSECURE_TEST, &NoProgress)
            .is_err()
    );
    e.store
        .backup_create(
            &file,
            Some(pw("backup password 1")),
            KdfParams::INSECURE_TEST,
            &NoProgress,
        )
        .unwrap();
    let raw = std::fs::read(&file).unwrap();
    assert!(!contains(&raw, b"plain words"));
    // Restore on "another machine": a fresh device-key store.
    let dk = FileDeviceKeyStore::new(out.path().join("other-device.key"));
    let target = out.path().join("restored");
    assert!(
        restore_backup(
            &file,
            &target,
            &RestoreCredentials::default(),
            &dk,
            T0,
            &NoProgress
        )
        .is_err()
    );
    let restored = restore_backup(
        &file,
        &target,
        &RestoreCredentials {
            backup_password: Some(pw("backup password 1")),
            ..Default::default()
        },
        &dk,
        T0,
        &NoProgress,
    )
    .unwrap();
    assert!(!restored.encrypted);
    let mut opts = e.opts();
    opts.device_keys = std::sync::Arc::new(dk);
    let s2 = Store::open(&target, opts).unwrap();
    s2.unlock_device().unwrap();
    assert_eq!(s2.page_get(&p).unwrap().meta.title, "Plain backed up");
}

#[test]
fn snapshots_list_verify_and_prune() {
    for encrypted in [true, false] {
        let e = env(encrypted);
        let ws = e.workspace();
        e.page(None, "Snap");
        e.store
            .asset_import_bytes(&ws, "f.bin", "application/octet-stream", b"blob bytes")
            .unwrap();
        if !encrypted {
            let err = e
                .store
                .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
                .unwrap_err();
            assert_eq!(err.code(), "UNSUPPORTED");
            e.store
                .set_backup_password(Some(pw("snapshot password")))
                .unwrap();
            assert!(e.store.has_backup_password().unwrap());
            // Internal secrets are hidden from the list.
            assert!(e.store.secret_list().unwrap().is_empty());
        }
        let id = e
            .store
            .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
            .unwrap();
        let list = e.store.snapshot_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert!(e.store.snapshot_verify(&id, &NoProgress).unwrap());
        let path = e.store.snapshot_path(&id).unwrap();
        let blobs = emp_store::backup::snapshot::blobs_dir(&path);
        if encrypted {
            // Snapshots of encrypted vaults keep the (already encrypted) blobs beside the file.
            assert_eq!(std::fs::read_dir(&blobs).unwrap().count(), 1);
            // A corrupted blob fails verification.
            let blob = std::fs::read_dir(&blobs)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            std::fs::write(&blob, b"garbage").unwrap();
        } else {
            // Regression: a plaintext vault's blobs are raw, so they are packed inside the backup-password
            // container instead of being copied beside it in the clear.
            assert!(!blobs.exists());
            let file = std::fs::read(&path).unwrap();
            assert!(!file.windows(10).any(|w| w == b"blob bytes"));
            // A corrupted container fails verification.
            let mut bad = file.clone();
            let mid = bad.len() / 2;
            bad[mid] ^= 0x01;
            std::fs::write(&path, bad).unwrap();
        }
        assert!(!e.store.snapshot_verify(&id, &NoProgress).unwrap());
        // Retention: 10 daily snapshots → 7 kept.
        for _ in 0..9 {
            e.advance(86_400_000);
            e.store
                .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
                .unwrap();
        }
        let n = e.store.snapshot_list().unwrap().len();
        assert!((7..=8).contains(&n), "{n}");
        assert!(e.store.snapshot_path("../../x").is_err());
    }
}

#[test]
fn quick_check_in_plaintext_mode() {
    let mut e = env(false);
    e.page(None, "p");
    e.reopen();
    unlock(&e, false);
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Ok);
    assert!(e.store.integrity_check(&NoProgress).unwrap().ok);
}
