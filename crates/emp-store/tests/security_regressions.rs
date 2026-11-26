//! Regression tests for the security review of the vault, keyslot, manifest and backup code. Each test tampers with
//! the vault the way an attacker with write access to the vault directory (but no password) could.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};

use common::*;
use emp_crypto::KdfParams;
use emp_store::backup::restore::{RestoreCredentials, restore_backup};
use emp_store::model::IntegrityState;
use emp_store::{FileDeviceKeyStore, NoProgress, Progress, Store, StoreError};

fn count(c: &rusqlite::Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

const PLAIN_ROWS: &str = "SELECT (SELECT count(*) FROM pages WHERE enc = 0) + (SELECT count(*) FROM page_docs WHERE enc = 0)
     + (SELECT count(*) FROM workspaces WHERE enc = 0) + (SELECT count(*) FROM kv WHERE enc = 0)
     + (SELECT count(*) FROM settings WHERE scope = 'vault' AND enc = 0)";

/// Flipping `vault_meta.encryption` to `off` used to make the next password unlock "resume" a decryption job and
/// write every record to disk in plaintext.
#[test]
fn edited_encryption_flag_does_not_decrypt_the_vault() {
    let mut e = env(true);
    let page = e.page(None, "Top secret title");
    e.save_text(&page, &["the body must stay encrypted"]);
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        c.execute(
            "UPDATE vault_meta SET value = CAST('off' AS BLOB) WHERE key = 'encryption'",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('encryption_job', CAST('off' AS BLOB))",
            [],
        )
        .unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    let st = e.store.status().unwrap();
    assert!(
        st.encrypted,
        "the password slot proves the vault is encrypted"
    );
    assert_eq!(st.integrity, IntegrityState::Warning);
    // Nothing was decrypted on disk, and new writes are still sealed.
    e.save_text(&page, &["a new paragraph after the tampering"]);
    let c = e.db();
    assert_eq!(count(&c, PLAIN_ROWS), 0);
    drop(c);
    assert_eq!(
        e.store.page_get(&page).unwrap().meta.title,
        "Top secret title"
    );
}

/// A plaintext (`enc = 0`) row planted in an encrypted vault used to be read like any other row, and the unlock-time
/// "resume" re-encrypted it into an authenticated record.
#[test]
fn planted_plaintext_row_is_damaged_not_laundered() {
    let mut e = env(true);
    let page = e.page(None, "Real page");
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        // Replace the real page's payload with attacker-chosen plaintext JSON.
        c.execute(
            "UPDATE pages SET enc = 0, payload = CAST('{\"v\":1,\"title\":\"Injected\"}' AS BLOB) WHERE id = ?1",
            [&page],
        )
        .unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Warning);
    let err = e.store.page_get(&page).unwrap_err();
    assert!(
        matches!(err, StoreError::Damaged { table: "pages", .. }),
        "{err:?}"
    );
    // It was not converted into a sealed row.
    let (enc, _) = raw_payload(&e.db(), "pages", "id", &page);
    assert_eq!(enc, 0);
    let report = e.store.integrity_check(&NoProgress).unwrap();
    assert!(!report.ok);
    assert!(report.damaged.iter().any(|d| d.id == page));
}

struct CancelAfter(AtomicUsize);

impl Progress for CancelAfter {
    fn progress(&self, _done: u64, _total: u64, _label: &str) {}
    fn cancelled(&self) -> bool {
        self.0.fetch_sub(1, Ordering::SeqCst) == 0
    }
}

/// The legitimate case still works: an interrupted "turn encryption on" job resumes at the next unlock, because its
/// authenticated `encryption_job` marker says so.
#[test]
fn interrupted_encryption_job_resumes_at_unlock() {
    let mut e = env(false);
    let page = e.page(None, "Convert me");
    e.save_text(&page, &["body"]);
    let err = e
        .store
        .enable_encryption(
            &pw(PASSWORD),
            KdfParams::INSECURE_TEST,
            &CancelAfter(AtomicUsize::new(1)),
        )
        .unwrap_err();
    assert!(matches!(err, StoreError::Cancelled), "{err:?}");
    // Some rows are still plaintext and stay readable during the job.
    assert!(count(&e.db(), PLAIN_ROWS) > 0);
    assert_eq!(e.store.page_get(&page).unwrap().meta.title, "Convert me");
    e.reopen();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(count(&e.db(), PLAIN_ROWS), 0);
    let marker: i64 = count(
        &e.db(),
        "SELECT count(*) FROM vault_meta WHERE key = 'encryption_job'",
    );
    assert_eq!(marker, 0);
    assert!(!e.dir.path().join("device.key").exists());
    assert_eq!(e.store.page_get(&page).unwrap().meta.title, "Convert me");
    let report = e.store.integrity_check(&NoProgress).unwrap();
    assert!(report.ok, "{report:?}");
    // The recovery words of the interrupted job were kept (sealed) and can still be confirmed.
    e.store.reauth(&pw(PASSWORD)).unwrap();
    assert_eq!(e.store.recovery_view().unwrap().len(), 24);
}

/// A trigger stored in `vault.db` would run on EMP's write connection, and EMP's manifest triggers would then
/// re-seal whatever it changed. Opening such a vault is refused.
#[test]
fn planted_trigger_blocks_open() {
    let e = env(true);
    e.page(None, "x");
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        c.execute_batch(
            "CREATE TRIGGER sqliteXrollback AFTER UPDATE ON pages BEGIN UPDATE pages SET rev = OLD.rev WHERE id = NEW.id; END;",
        )
        .unwrap();
    }
    let err = Store::open(&dir, e.opts()).unwrap_err();
    assert_eq!(err.code(), "INTEGRITY", "{err:?}");
}

/// `vault_meta` header keys are not in the state MAC; restore now also checks the header MAC.
#[test]
fn restore_checks_the_header_mac() {
    let mut e = env(true);
    e.page(None, "x");
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        c.execute(
            "UPDATE vault_meta SET value = CAST('1999-01-01' AS BLOB) WHERE key = 'created_day'",
            [],
        )
        .unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    e.store.unlock(&pw(PASSWORD)).unwrap();
    assert_eq!(e.store.status().unwrap().integrity, IntegrityState::Warning);
    let file = e.dir.path().join("out.empbackup");
    e.store
        .backup_create(&file, None, KdfParams::INSECURE_TEST, &NoProgress)
        .unwrap();
    let target = e.dir.path().join("restored");
    let err = restore_backup(
        &file,
        &target,
        &RestoreCredentials {
            password: Some(pw(PASSWORD)),
            ..Default::default()
        },
        &FileDeviceKeyStore::new(e.dir.path().join("device2.key")),
        T0,
        &NoProgress,
    )
    .unwrap_err();
    assert_eq!(err.code(), "INTEGRITY", "{err:?}");
    assert!(!target.join("vault.db").exists());
}

/// `device.key` is replaced atomically and always ends up owner-only.
#[test]
fn device_key_file_is_written_atomically_and_private() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("device.key");
    std::fs::write(&path, [0u8; 48]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    emp_store::vault::write_private(&path, &[1u8; 96]).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), vec![1u8; 96]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // No temporary files are left behind.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

/// A lockout that lies far in the future (clock moved back, or `vault_meta` edited) never blocks for longer than
/// the 300 s policy maximum.
#[test]
fn lockout_is_capped_at_the_policy_maximum() {
    let mut e = env(true);
    let dir = e.vault_dir();
    e.store.close().unwrap();
    {
        let c = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
        c.execute(
            "UPDATE vault_meta SET value = CAST(?1 AS BLOB) WHERE key = 'lockout_until'",
            [(T0 + 30 * 86_400_000).to_string()],
        )
        .unwrap();
    }
    e.store = Store::open(&dir, e.opts()).unwrap();
    match e.store.unlock(&pw(PASSWORD)).unwrap_err() {
        StoreError::RateLimited { retry_after_ms } => assert_eq!(retry_after_ms, 300_000),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(e.store.status().unwrap().retry_after_ms, 300_000);
    // The lockout was re-anchored: five minutes later the right password works again.
    e.advance(300_001);
    e.store.unlock(&pw(PASSWORD)).unwrap();
}

/// Restoring a plaintext backup on the machine that still has the original vault used to overwrite the original's
/// device key (both share the vault id), locking the original out once its key had changed since the backup.
#[test]
fn plaintext_restore_keeps_the_original_vault_openable() {
    let mut e = env(false);
    let p = e.page(None, "Original");
    let file = e.dir.path().join("plain.empbackup");
    e.store
        .backup_create(
            &file,
            Some(pw("backup password 1")),
            KdfParams::INSECURE_TEST,
            &NoProgress,
        )
        .unwrap();
    // Encryption on and off again: the original vault now has a new device key.
    e.store
        .enable_encryption(&pw(PASSWORD), KdfParams::INSECURE_TEST, &NoProgress)
        .unwrap();
    e.store.reauth(&pw(PASSWORD)).unwrap();
    e.store
        .disable_encryption(&pw(PASSWORD), &NoProgress)
        .unwrap();
    let target = e.dir.path().join("restored");
    let dks = FileDeviceKeyStore::new(e.dir.path().join("device.key"));
    restore_backup(
        &file,
        &target,
        &RestoreCredentials {
            backup_password: Some(pw("backup password 1")),
            ..Default::default()
        },
        &dks,
        T0,
        &NoProgress,
    )
    .unwrap();
    // The original still opens.
    e.reopen();
    e.store.unlock_device().unwrap();
    assert_eq!(e.store.page_get(&p).unwrap().meta.title, "Original");
    // And so does the restored copy, with an intact manifest.
    let s2 = Store::open(&target, e.opts()).unwrap();
    s2.unlock_device().unwrap();
    assert_eq!(s2.page_get(&p).unwrap().meta.title, "Original");
    assert!(s2.integrity_check(&NoProgress).unwrap().ok);
    s2.close().unwrap();
}
