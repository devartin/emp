//! End-to-end use of the public API the way `emp-store` / `emp-app` will drive it.

use std::io::Cursor;

use emp_crypto::backup::{SnapshotPrefix, open_with_password, seal_with_password};
use emp_crypto::blob::{BlobWriter, WrappedFileKey, blob_range_reader, open_blob};
use emp_crypto::envelope::{Extra, RecordAad, TableTag};
use emp_crypto::kdf::KdfParams;
use emp_crypto::keys::{Dek, DeviceKey, FileKey, RecoveryKey, VaultId, VaultKeys};
use emp_crypto::keyslot::{Keyslot, KeyslotKind, canonical_keyslots_digest};
use emp_crypto::mac::{MsetRoot, sha256};
use emp_crypto::{CryptoError, SecretString};

const P: KdfParams = KdfParams::INSECURE_TEST;

fn pw(s: &str) -> SecretString {
    SecretString::from(s.to_owned())
}

#[test]
fn create_unlock_recover_change_password() {
    // vault_create (encrypted)
    let vault_id = VaultId::generate().unwrap();
    let dek = Dek::generate(1).unwrap();
    let recovery = RecoveryKey::generate().unwrap();
    let words = recovery.words().unwrap();
    let pw_slot =
        Keyslot::wrap_password(&vault_id, 1, &dek, &pw("first password!"), &P, 1).unwrap();
    let rec_slot = Keyslot::wrap_recovery(&vault_id, 2, &dek, &recovery, 1).unwrap();
    drop(recovery);

    // Persist as columns and read back.
    let stored: Vec<_> = [&pw_slot, &rec_slot]
        .iter()
        .map(|s| s.to_columns())
        .collect();
    let loaded: Vec<Keyslot> = stored
        .iter()
        .map(|c| {
            Keyslot::from_columns(
                c.slot_id,
                c.kind,
                c.kdf,
                &c.kdf_params,
                &c.salt,
                &c.nonce,
                &c.wrapped_dek,
                c.key_epoch,
                c.created_at,
            )
            .unwrap()
        })
        .collect();

    // Seal some records with the session keys.
    let keys = VaultKeys::derive(&dek, &vault_id).unwrap();
    let page = RecordAad::new(TableTag::Pages, "page-1", "doc", 1);
    let env = keys
        .seal_record(&page, br#"{"v":1,"title":"Plans"}"#)
        .unwrap();
    let setting = RecordAad::new(TableTag::Settings, "", "", 0)
        .with_extra(Extra::setting("vault", "autoLock").unwrap());
    let env2 = keys.seal_record(&setting, br#"{"v":1,"idle":15}"#).unwrap();

    // Manifest.
    let mut root = MsetRoot::EMPTY;
    root.insert(
        &keys
            .row_hash(TableTag::Pages, "page-1", &Extra::none(), 1, &env)
            .unwrap(),
    );
    root.insert(
        &keys
            .row_hash(
                TableTag::Settings,
                "",
                &Extra::setting("vault", "autoLock").unwrap(),
                0,
                &env2,
            )
            .unwrap(),
    );
    let digest = canonical_keyslots_digest(&loaded).unwrap();
    let state_mac = keys.state_mac(2, &root, &digest).unwrap();
    drop(keys);
    drop(dek);

    // vault_unlock: wrong password, then right password.
    let pslot = loaded
        .iter()
        .find(|s| s.kind() == KeyslotKind::Password)
        .unwrap();
    let err = pslot
        .unwrap_password(&vault_id, &pw("first password?"))
        .unwrap_err();
    assert_eq!(err, CryptoError::BadPassword);
    assert_eq!(err.code(), "BAD_PASSWORD");
    let dek = pslot
        .unwrap_password(&vault_id, &pw("first password!"))
        .unwrap();
    let keys = VaultKeys::derive(&dek, &vault_id).unwrap();
    assert!(
        keys.verify_state_mac(2, &root, &digest, &state_mac)
            .unwrap()
    );
    assert_eq!(
        keys.open_record(&page, &env).unwrap().as_slice(),
        br#"{"v":1,"title":"Plans"}"#
    );
    assert!(keys.open_record(&page, &env2).is_err());

    // vault_unlock_recovery: words → DEK → new password slot.
    let rslot = loaded
        .iter()
        .find(|s| s.kind() == KeyslotKind::Recovery)
        .unwrap();
    let typed: Vec<String> = words.iter().map(|w| w.to_uppercase()).collect();
    let rk = RecoveryKey::from_words(&typed).unwrap();
    let dek2 = rslot.unwrap_recovery(&vault_id, &rk).unwrap();
    let new_slot =
        Keyslot::wrap_password(&vault_id, 3, &dek2, &pw("second password"), &P, 2).unwrap();
    let dek3 = new_slot
        .unwrap_password(&vault_id, &pw("second password"))
        .unwrap();
    let keys3 = VaultKeys::derive(&dek3, &vault_id).unwrap();
    assert_eq!(
        keys3.open_record(&setting, &env2).unwrap().as_slice(),
        br#"{"v":1,"idle":15}"#
    );
    // Keyslot change ⇒ state MAC changes.
    let digest2 = canonical_keyslots_digest(&[new_slot, rslot.clone()]).unwrap();
    assert!(
        !keys3
            .verify_state_mac(2, &root, &digest2, &state_mac)
            .unwrap()
    );
}

#[test]
fn plaintext_vault_device_slot() {
    let vault_id = VaultId::generate().unwrap();
    let dek = Dek::generate(1).unwrap();
    let device = DeviceKey::generate().unwrap();
    let slot = Keyslot::wrap_device(&vault_id, 1, &dek, &device, 0).unwrap();
    // The app stores the device key in the keychain and reloads it later.
    let reloaded = DeviceKey::from_bytes(device.expose_secret()).unwrap();
    let dek2 = slot.unwrap_device(&vault_id, &reloaded).unwrap();
    let keys = VaultKeys::derive(&dek2, &vault_id).unwrap();
    // Secrets are always enc = 1.
    let loc = RecordAad::new(
        TableTag::Secrets,
        "secret:00112233445566778899aabbccddeeff",
        "",
        0,
    );
    let env = keys.seal_record(&loc, b"{\"v\":1}").unwrap();
    assert!(keys.open_record(&loc, &env).is_ok());
}

#[test]
fn asset_pipeline() {
    let vault_id = VaultId::generate().unwrap();
    let keys = VaultKeys::derive(&Dek::generate(1).unwrap(), &vault_id).unwrap();
    let content: Vec<u8> = (0..300_000u32).map(|i| (i % 241) as u8).collect();
    let name = keys.blob_name(&sha256(&content)).unwrap();
    let fk = FileKey::generate().unwrap();
    let mut w = BlobWriter::new(&fk, content.len() as u64, Vec::new()).unwrap();
    for part in content.chunks(10_000) {
        w.write_content(part).unwrap();
    }
    let file = w.finish().unwrap();
    let wrapped = keys.wrap_file_key(&name, &fk).unwrap().to_bytes();
    drop(fk);

    let fk2 = keys
        .unwrap_file_key(&name, &WrappedFileKey::from_bytes(&wrapped).unwrap())
        .unwrap();
    assert_eq!(
        open_blob(&fk2, &file).unwrap().as_slice(),
        content.as_slice()
    );
    let mut rr = blob_range_reader(&fk2, Cursor::new(file)).unwrap();
    assert_eq!(
        rr.read_range(100_000, 50).unwrap().as_slice(),
        &content[100_000..100_050]
    );
    assert!(name.relative_path().starts_with("assets/"));
}

#[test]
fn snapshot_and_password_container() {
    let vault_id = VaultId::generate().unwrap();
    let keys = VaultKeys::derive(&Dek::generate(1).unwrap(), &vault_id).unwrap();
    let manifest = b"\xa0";
    let mut snap = SnapshotPrefix {
        manifest_len: manifest.len() as u32,
    }
    .encode()
    .unwrap()
    .to_vec();
    snap.extend_from_slice(manifest);
    snap.extend_from_slice(b"SQLite format 3\0...");
    let mut mac = keys.backup_mac().unwrap();
    mac.update(&snap);
    snap.extend_from_slice(&mac.finalize());
    let body = keys.verify_snapshot_bytes(&snap).unwrap();
    assert_eq!(SnapshotPrefix::parse(body).unwrap().manifest_len, 1);

    // Plaintext-vault snapshot: wrap the whole container with a backup password.
    let sealed = seal_with_password(&pw("backup password"), &P, &snap).unwrap();
    assert_eq!(
        open_with_password(&pw("backup password"), &sealed)
            .unwrap()
            .as_slice(),
        snap.as_slice()
    );
    assert_eq!(
        open_with_password(&pw("nope"), &sealed).unwrap_err(),
        CryptoError::BadPassword
    );
}
