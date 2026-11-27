//! Snapshot folder choice and automatic snapshots of unencrypted workspaces (Ultranote 1.0 brief §2.4 "Backups &
//! data"): a chosen folder receives new snapshots, both locations are listed, verified and pruned together, an
//! unreachable folder falls back to the vault directory, and vault settings validation rejects bad zones.

mod common;

use common::*;
use emp_crypto::KdfParams;
use emp_store::NoProgress;

#[test]
fn chosen_folder_receives_snapshots_and_lists_with_local_ones() {
    for encrypted in [true, false] {
        let e = env(encrypted);
        e.page(None, "Folder snapshots");
        if !encrypted {
            e.store
                .set_backup_password(Some(pw("backup password 1")))
                .unwrap();
        }
        // One snapshot in the vault directory first.
        let local = e
            .store
            .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
            .unwrap();
        assert!(e.store.snapshot_folder().unwrap().is_none());

        // Choose a folder: new snapshots go to a per-vault subfolder of it.
        let chosen = tempfile::tempdir().unwrap();
        let dir = e.store.set_snapshot_folder(Some(chosen.path())).unwrap();
        assert!(dir.starts_with(chosen.path()));
        assert!(
            dir.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("Ultranote snapshots ")
        );
        assert_eq!(
            e.store.snapshot_folder().unwrap().as_deref(),
            Some(dir.as_path())
        );
        let (target, in_folder) = e.store.snapshot_target().unwrap();
        assert!(in_folder);
        assert_eq!(target, dir);

        // A day later (retention keeps one snapshot per day).
        e.advance(86_400_000);
        let remote = e
            .store
            .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
            .unwrap();
        assert!(dir.join(format!("{remote}.empsnap")).is_file());
        let list = e.store.snapshot_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, remote);
        assert_eq!(list[0].location, "folder");
        assert_eq!(list[1].id, local);
        assert_eq!(list[1].location, "local");
        // Both verify through the same lookup.
        assert!(e.store.snapshot_verify(&remote, &NoProgress).unwrap());
        assert!(e.store.snapshot_verify(&local, &NoProgress).unwrap());

        // Retention spans both locations: 9 more daily snapshots keep at most 7 daily.
        for _ in 0..9 {
            e.advance(86_400_000);
            e.store
                .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
                .unwrap();
        }
        let n = e.store.snapshot_list().unwrap().len();
        assert!((7..=8).contains(&n), "{n}");

        // Back to the default location: new snapshots land in the vault directory, older folder ones stay listed
        // only while the folder is the chosen one.
        let default_dir = e.store.set_snapshot_folder(None).unwrap();
        assert!(e.store.snapshot_folder().unwrap().is_none());
        e.advance(86_400_000);
        let back = e
            .store
            .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
            .unwrap();
        assert!(default_dir.join(format!("{back}.empsnap")).is_file());
    }
}

#[test]
fn unreachable_folder_falls_back_and_bad_folders_are_refused() {
    let e = env(true);
    e.page(None, "Fallback");
    let chosen = tempfile::tempdir().unwrap();
    let mount = chosen.path().join("nas");
    std::fs::create_dir(&mount).unwrap();
    e.store.set_snapshot_folder(Some(&mount)).unwrap();
    // The share goes away: snapshots continue in the vault directory.
    std::fs::remove_dir_all(&mount).unwrap();
    let (target, in_folder) = e.store.snapshot_target().unwrap();
    assert!(!in_folder);
    let id = e
        .store
        .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
        .unwrap();
    assert!(target.join(format!("{id}.empsnap")).is_file());
    assert_eq!(e.store.snapshot_list().unwrap().len(), 1);

    // A missing or relative folder is refused.
    assert_eq!(
        e.store
            .set_snapshot_folder(Some(&chosen.path().join("missing")))
            .unwrap_err()
            .code(),
        "INVALID"
    );
    assert!(
        e.store
            .set_snapshot_folder(Some(std::path::Path::new("relative/dir")))
            .is_err()
    );
}

#[test]
fn plaintext_snapshots_need_and_use_the_backup_password() {
    let e = env(false);
    e.page(None, "Plain");
    assert!(!e.store.has_backup_password().unwrap());
    assert_eq!(
        e.store
            .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
            .unwrap_err()
            .code(),
        "UNSUPPORTED"
    );
    // Too short.
    assert!(e.store.set_backup_password(Some(pw("short"))).is_err());
    e.store
        .set_backup_password(Some(pw("a long backup password")))
        .unwrap();
    assert!(e.store.has_backup_password().unwrap());
    let id = e
        .store
        .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
        .unwrap();
    assert!(e.store.snapshot_verify(&id, &NoProgress).unwrap());
    // Clearing it stops automatic snapshots again.
    e.store.set_backup_password(None).unwrap();
    assert!(!e.store.has_backup_password().unwrap());
    assert!(
        e.store
            .snapshot_now(KdfParams::INSECURE_TEST, &NoProgress)
            .is_err()
    );
}

#[test]
fn vault_settings_reject_unknown_time_zones() {
    let e = env(false);
    let ok = e
        .store
        .settings_set_vault(
            &serde_json::json!({ "timezone": "Europe/Lisbon", "locale": "pt-PT", "weekStart": 1 }),
        )
        .unwrap();
    assert_eq!(ok.timezone, "Europe/Lisbon");
    assert!(!ok.region_is_untouched());
    let err = e
        .store
        .settings_set_vault(&serde_json::json!({ "timezone": "Nowhere/Land" }))
        .unwrap_err();
    assert_eq!(err.code(), "INVALID");
    assert_eq!(e.store.vault_settings().unwrap().timezone, "Europe/Lisbon");
    // Device defaults: graphite.
    assert_eq!(e.store.device_settings().unwrap().accent, "graphite");
}
