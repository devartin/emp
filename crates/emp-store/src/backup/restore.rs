//! Verification and restore of `.empsnap` / `.empbackup` files (SPEC §9.21 "Restore").
//!
//! Restore steps: (1) check magic, version and sizes; (2) extract the SQLite part and open it read-only with
//! `DEFENSIVE`, `trusted_schema=OFF` and `integrity_check`; (3) require exactly the §10.2 schema objects; (4) unlock
//! with the snapshot's keyslots (password or recovery key current at snapshot time; the embedded device key for
//! plaintext vaults); (5) verify the MAC, the manifest against `vault_state`, the integrity manifest and every blob
//! hash; (6) move everything into a **new** vault directory. Restore never overwrites an existing vault.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use emp_crypto::backup::SNAPSHOT_PREFIX_LEN;
use emp_crypto::backup::{PasswordContainerHeader, SnapshotPrefix, open_password_container};
use emp_crypto::mac::ContentHasher;
use emp_crypto::{DeviceKey, KeyslotKind, RecoveryKey, SecretString, VaultId, VaultKeys};

use super::SnapManifest;
use super::snapshot::blobs_dir;
use crate::db::conn::open_untrusted;
use crate::db::migrate::{LATEST_VERSION, verify_schema};
use crate::manifest::{read_keyslots, read_state, verify, verify_header_mac};
use crate::vault::{DeviceKeyStore, create_private_dir, meta_get};
use crate::{Progress, Result, StoreError};

/// Credentials for [`restore_backup`].
#[derive(Default)]
pub struct RestoreCredentials {
    /// The vault password current when the backup was taken.
    pub password: Option<SecretString>,
    /// Or the recovery words current when the backup was taken.
    pub recovery_words: Option<Vec<String>>,
    /// The backup password (password-container backups; always for plaintext vaults).
    pub backup_password: Option<SecretString>,
}

/// Result of a restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    /// Vault id (hex).
    pub vault_id: String,
    /// Live pages in the restored vault.
    pub pages: u64,
    /// The new vault directory (open it with [`crate::Store::open`]).
    pub dir: PathBuf,
    /// Whether the restored vault is encrypted.
    pub encrypted: bool,
}

const BUF: usize = 64 * 1024;

fn integrity(msg: &str) -> StoreError {
    StoreError::Integrity(msg.to_owned())
}

/// Returns the path of the inner container, decrypting a password container into `staging` if needed.
fn open_inner(path: &Path, password: Option<&SecretString>, staging: &Path) -> Result<PathBuf> {
    let mut head = [0u8; 8];
    let mut f = File::open(path)?;
    let n = f.read(&mut head)?;
    if !PasswordContainerHeader::sniff(&head[..n]) {
        return Ok(path.to_owned());
    }
    let pw = password.ok_or_else(|| {
        StoreError::invalid_field("password", "this backup is protected by a backup password")
    })?;
    f.seek(SeekFrom::Start(0))?;
    let reader = open_password_container(pw, BufReader::new(f))?;
    crate::vault::create_private_dir(staging)?;
    let out_path = staging.join("inner.bin");
    let mut out = BufWriter::new(crate::vault::create_private_file(&out_path)?);
    reader.copy_to(&mut out)?;
    out.flush()?;
    Ok(out_path)
}

struct Header {
    manifest: SnapManifest,
    /// The exact prefix and manifest bytes that were parsed (fed to the MAC, so what is checked is what was read).
    /// Zeroizing: a plaintext vault's manifest carries its device key.
    head: zeroize::Zeroizing<Vec<u8>>,
    sqlite_off: u64,
    inner_len: u64,
}

fn parse_header(inner: &Path) -> Result<Header> {
    let inner_len = std::fs::metadata(inner)?.len();
    let mut f = BufReader::new(File::open(inner)?);
    let mut prefix = [0u8; SNAPSHOT_PREFIX_LEN];
    f.read_exact(&mut prefix)
        .map_err(|_| integrity("the file is too short"))?;
    let p = SnapshotPrefix::parse(&prefix)?;
    let mut mbytes = zeroize::Zeroizing::new(vec![0u8; p.manifest_len as usize]);
    f.read_exact(&mut mbytes)
        .map_err(|_| integrity("the manifest is truncated"))?;
    let manifest: SnapManifest = ciborium::from_reader(mbytes.as_slice())
        .map_err(|_| integrity("the manifest is malformed"))?;
    let mut head = zeroize::Zeroizing::new(Vec::with_capacity(prefix.len() + mbytes.len()));
    head.extend_from_slice(&prefix);
    head.extend_from_slice(&mbytes);
    let sqlite_off = SNAPSHOT_PREFIX_LEN as u64 + u64::from(p.manifest_len);
    let packed: u64 = if manifest.packed {
        manifest
            .blobs
            .iter()
            .try_fold(0u64, |acc, b| acc.checked_add(8)?.checked_add(b.1))
            .ok_or_else(|| integrity("blob sizes overflow"))?
    } else {
        0
    };
    let expected = sqlite_off
        .checked_add(manifest.sqlite_len)
        .and_then(|x| x.checked_add(packed))
        .and_then(|x| x.checked_add(32))
        .ok_or_else(|| integrity("sizes overflow"))?;
    if expected != inner_len {
        return Err(integrity("the file size does not match its manifest"));
    }
    for (name, _, digest) in &manifest.blobs {
        if emp_crypto::BlobName::parse(name).is_err() || digest.len() != 64 {
            return Err(integrity("invalid blob entry"));
        }
    }
    Ok(Header {
        manifest,
        head,
        sqlite_off,
        inner_len,
    })
}

fn mac_exact(
    mac: &mut emp_crypto::backup::BackupMac,
    r: &mut impl Read,
    mut len: u64,
) -> Result<()> {
    let mut buf = vec![0u8; BUF];
    while len > 0 {
        let want = usize::try_from(len.min(BUF as u64)).unwrap_or(BUF);
        r.read_exact(&mut buf[..want])
            .map_err(|_| integrity("the backup is truncated"))?;
        mac.update(&buf[..want]);
        len -= want as u64;
    }
    Ok(())
}

/// Verifies the backup MAC over the bytes that are actually used: the parsed prefix and manifest (`h.head`), the
/// **extracted** database copy `sqlite_part`, then the packed blobs and the tag from `inner`.
///
/// Reading the database part from `inner` a second time would let a file that changes between reads (a backup on
/// a network or sync folder) pass the MAC with genuine bytes while a different database had been extracted.
fn verify_mac(inner: &Path, h: &Header, sqlite_part: &Path, keys: &VaultKeys) -> Result<()> {
    let mut mac = keys.backup_mac()?;
    mac.update(&h.head);
    let mut db = BufReader::new(File::open(sqlite_part)?);
    mac_exact(&mut mac, &mut db, h.manifest.sqlite_len)?;
    let mut probe = [0u8; 1];
    if db.read(&mut probe)? != 0 {
        return Err(integrity("the database part has the wrong size"));
    }
    let mut f = BufReader::new(File::open(inner)?);
    let blobs_off = h.sqlite_off + h.manifest.sqlite_len;
    f.seek(SeekFrom::Start(blobs_off))?;
    let blobs_len = h
        .inner_len
        .checked_sub(blobs_off)
        .and_then(|x| x.checked_sub(32))
        .ok_or_else(|| integrity("sizes overflow"))?;
    mac_exact(&mut mac, &mut f, blobs_len)?;
    let mut tag = [0u8; 32];
    f.read_exact(&mut tag)
        .map_err(|_| integrity("the backup is truncated"))?;
    if mac.verify(&tag) {
        Ok(())
    } else {
        Err(integrity("the backup's authentication tag does not verify"))
    }
}

/// Checks (and optionally extracts into `extract_to/<2 hex>/<name>`) every blob.
fn check_blobs(
    inner: &Path,
    h: &Header,
    snap_path: &Path,
    extract_to: Option<&Path>,
    progress: &dyn Progress,
) -> Result<()> {
    let total = h.manifest.blobs.len() as u64;
    let mut packed = if h.manifest.packed {
        let mut f = BufReader::new(File::open(inner)?);
        f.seek(SeekFrom::Start(h.sqlite_off + h.manifest.sqlite_len))?;
        Some(f)
    } else {
        None
    };
    for (i, (name, size, digest)) in h.manifest.blobs.iter().enumerate() {
        let mut reader: Box<dyn Read> = match packed.as_mut() {
            Some(f) => {
                let mut len = [0u8; 8];
                f.read_exact(&mut len)?;
                if u64::from_be_bytes(len) != *size {
                    return Err(integrity("packed blob length mismatch"));
                }
                Box::new(f.by_ref().take(*size))
            }
            None => {
                let p = blobs_dir(snap_path).join(name);
                if std::fs::metadata(&p).map(|m| m.len()).ok() != Some(*size) {
                    return Err(integrity(
                        "a snapshot attachment is missing or has the wrong size",
                    ));
                }
                Box::new(BufReader::new(File::open(p)?))
            }
        };
        let mut out = match extract_to {
            Some(dir) => {
                let d = dir.join(name.get(..2).unwrap_or("00"));
                crate::vault::create_private_dir(&d)?;
                Some(BufWriter::new(crate::vault::create_private_file(
                    &d.join(name),
                )?))
            }
            None => None,
        };
        let mut hasher = ContentHasher::new();
        let mut buf = vec![0u8; BUF];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            if let Some(o) = out.as_mut() {
                o.write_all(&buf[..n])?;
            }
        }
        if let Some(mut o) = out {
            o.flush()?;
        }
        if hex::encode(hasher.finalize()) != *digest {
            return Err(integrity("an attachment does not match its hash"));
        }
        progress.progress(i as u64 + 1, total, "attachments");
    }
    Ok(())
}

fn extract_sqlite(inner: &Path, h: &Header, dest: &Path) -> Result<()> {
    let mut f = BufReader::new(File::open(inner)?);
    f.seek(SeekFrom::Start(h.sqlite_off))?;
    let mut out = BufWriter::new(crate::vault::create_private_file(dest)?);
    let n = std::io::copy(&mut f.take(h.manifest.sqlite_len), &mut out)?;
    out.flush()?;
    if n != h.manifest.sqlite_len {
        return Err(integrity("the database part is truncated"));
    }
    Ok(())
}

fn check_against_db(conn: &rusqlite::Connection, h: &Header, keys: &VaultKeys) -> Result<()> {
    let state = read_state(conn)?.ok_or_else(|| integrity("vault_state is missing"))?;
    if state.write_counter != h.manifest.write_counter
        || hex::encode(state.mset_root) != h.manifest.mset_root
    {
        return Err(integrity("the manifest does not match the database"));
    }
    if !verify(conn, keys)?.ok() {
        return Err(integrity(
            "the database's integrity manifest does not verify",
        ));
    }
    // `vault_meta.encryption` and the other header keys are not in the state MAC; an edited flag would otherwise be
    // carried into the restored vault.
    if !verify_header_mac(conn, keys)? {
        return Err(integrity("the backup's vault header does not verify"));
    }
    Ok(())
}

/// Verifies a snapshot of the current vault with its session keys (`snapshot_verify`).
pub(crate) fn verify_with_keys(
    path: &Path,
    password: Option<&SecretString>,
    keys: &VaultKeys,
    progress: &dyn Progress,
) -> Result<()> {
    let staging = path.with_extension("verify");
    let result = (|| {
        let inner = open_inner(path, password, &staging)?;
        let h = parse_header(&inner)?;
        if h.manifest.vault_id != keys.vault_id().to_hex() {
            return Err(integrity("the snapshot belongs to another vault"));
        }
        let db = staging.join("check.sqlite");
        crate::vault::create_private_dir(&staging)?;
        extract_sqlite(&inner, &h, &db)?;
        verify_mac(&inner, &h, &db, keys)?;
        {
            let c = open_untrusted(&db)?;
            check_against_db(&c, &h, keys)?;
        }
        check_blobs(&inner, &h, path, None, progress)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Restores a backup or snapshot into `target_dir`, which must not contain a vault. For plaintext vaults the
/// embedded device key is saved to `device_keys`.
pub fn restore_backup(
    file: &Path,
    target_dir: &Path,
    creds: &RestoreCredentials,
    device_keys: &dyn DeviceKeyStore,
    now_ms: i64,
    progress: &dyn Progress,
) -> Result<Restored> {
    if target_dir.join("vault.db").exists() {
        return Err(StoreError::invalid(
            "restore never overwrites an existing vault",
        ));
    }
    create_private_dir(target_dir)?;
    let staging = target_dir.join("tmp").join("restore");
    let result = restore_inner(
        file,
        target_dir,
        &staging,
        creds,
        device_keys,
        now_ms,
        progress,
    );
    let _ = std::fs::remove_dir_all(&staging);
    if result.is_err() {
        let _ = std::fs::remove_file(target_dir.join("vault.db"));
        let _ = std::fs::remove_dir_all(target_dir.join("assets"));
    }
    result
}

fn restore_inner(
    file: &Path,
    target_dir: &Path,
    staging: &Path,
    creds: &RestoreCredentials,
    device_keys: &dyn DeviceKeyStore,
    now_ms: i64,
    progress: &dyn Progress,
) -> Result<Restored> {
    // 1. Format and sizes.
    let inner = open_inner(file, creds.backup_password.as_ref(), staging)?;
    let h = parse_header(&inner)?;
    if h.manifest.schema_version > LATEST_VERSION {
        return Err(StoreError::SchemaTooNew {
            found: h.manifest.schema_version,
            known: LATEST_VERSION,
        });
    }
    // 2. Database part, opened defensively.
    crate::vault::create_private_dir(staging)?;
    let db_stage = staging.join("vault.db");
    extract_sqlite(&inner, &h, &db_stage)?;
    let (keys, dek, dek_vault, encrypted, pages, device) = {
        let conn = open_untrusted(&db_stage)?;
        // 3. Exactly the expected objects (including their `CREATE` text).
        verify_schema(&conn)
            .map_err(|_| integrity("the backup's database has unexpected schema objects"))?;
        let raw_id = meta_get(&conn, "vault_id")?.ok_or_else(|| integrity("vault id missing"))?;
        let vault_id = VaultId::from_slice(&raw_id)?;
        if vault_id.to_hex() != h.manifest.vault_id {
            return Err(integrity("the manifest names another vault"));
        }
        // 4. Unlock with the snapshot's keyslots.
        let slots = read_keyslots(&conn)?;
        let find = |k| slots.iter().find(|s| s.kind() == k);
        let (dek, device) = if let Some(dk_hex) = &h.manifest.device_key {
            let bytes =
                zeroize::Zeroizing::new(hex::decode(dk_hex).map_err(|_| integrity("device key"))?);
            let dk = DeviceKey::from_bytes(&bytes)?;
            let slot =
                find(KeyslotKind::Device).ok_or_else(|| integrity("device keyslot missing"))?;
            (slot.unwrap_device(&vault_id, &dk)?, Some(dk))
        } else if let Some(pw) = &creds.password {
            let slot =
                find(KeyslotKind::Password).ok_or_else(|| integrity("password keyslot missing"))?;
            (slot.unwrap_password(&vault_id, pw)?, None)
        } else if let Some(words) = &creds.recovery_words {
            let rk = RecoveryKey::from_words(words)?;
            let slot =
                find(KeyslotKind::Recovery).ok_or_else(|| integrity("recovery keyslot missing"))?;
            (slot.unwrap_recovery(&vault_id, &rk)?, None)
        } else {
            return Err(StoreError::invalid_field(
                "password",
                "the vault password or recovery key is required",
            ));
        };
        let keys = VaultKeys::derive(&dek, &vault_id)?;
        // 5. MAC (over the extracted copy), manifest, integrity, blobs.
        verify_mac(&inner, &h, &db_stage, &keys)?;
        check_against_db(&conn, &h, &keys)?;
        let encrypted = meta_get(&conn, "encryption")?.as_deref() == Some(b"on".as_slice());
        let pages: i64 = conn.query_row(
            "SELECT count(*) FROM pages WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        (
            keys,
            dek,
            vault_id,
            encrypted,
            u64::try_from(pages).unwrap_or(0),
            device,
        )
    };
    check_blobs(&inner, &h, file, Some(&target_dir.join("assets")), progress)?;
    // 6. Into place.
    // The restored vault keeps its vault id, and device keys are stored per vault id. If this device already holds a
    // key for that id (the original vault, whose key may have changed since the backup), saving the backup's key
    // would overwrite it and lock the original vault out. Re-wrap the restored device slot under the existing key
    // instead, so both copies open.
    let device_to_save = match device {
        Some(dk) => match device_keys.load(&dek_vault)? {
            Some(existing) => Some((existing, false)),
            None => Some((dk, true)),
        },
        None => None,
    };
    {
        let c = rusqlite::Connection::open(&db_stage)?;
        crate::db::pragmas::harden(&c)?;
        let tx = c.unchecked_transaction()?;
        if let Some((dk, false)) = &device_to_save {
            let slots = read_keyslots(&tx)?;
            let old = slots
                .iter()
                .find(|s| s.kind() == KeyslotKind::Device)
                .ok_or_else(|| integrity("device keyslot missing"))?;
            let slot = emp_crypto::Keyslot::wrap_device(
                &dek_vault,
                old.slot_id(),
                &dek,
                dk,
                old.created_at(),
            )?;
            let col = slot.to_columns();
            tx.execute(
                "UPDATE keyslots SET nonce = ?2, wrapped_dek = ?3 WHERE slot_id = ?1",
                rusqlite::params![col.slot_id, col.nonce, col.wrapped_dek],
            )?;
            crate::manifest::reseal(&tx, &keys)?;
        }
        tx.execute(
            "INSERT INTO security_log (at, event) VALUES (?1, 'backup_restore')",
            [now_ms],
        )?;
        tx.commit()?;
    }
    std::fs::rename(&db_stage, target_dir.join("vault.db"))?;
    if let Some((dk, true)) = &device_to_save {
        device_keys.save(&dek_vault, dk)?;
    }
    drop(dek);
    drop(keys);
    Ok(Restored {
        vault_id: dek_vault.to_hex(),
        pages,
        dir: target_dir.to_owned(),
        encrypted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use emp_crypto::KdfParams;

    #[test]
    fn mac_covers_the_extracted_database_copy() {
        // Regression: the MAC used to be computed over a second read of the backup file, so a file that changed
        // between extraction and verification (network / sync folder) could smuggle in a different database.
        let dir = tempfile::tempdir().unwrap();
        let mut opts = crate::vault::StoreOptions::new(dir.path().join("device.key"));
        opts.background_indexing = false;
        let created = crate::Store::create(
            dir.path(),
            crate::vault::CreateOptions {
                password: Some(SecretString::from(
                    "correct horse battery staple".to_owned(),
                )),
                kdf: KdfParams::INSECURE_TEST,
                auto_lock: crate::model::AutoLock::default(),
                workspace_name: Some("W".into()),
            },
            opts,
        )
        .unwrap();
        let store = created.store;
        let file = dir.path().join("b.empbackup");
        store
            .backup_create(&file, None, KdfParams::INSECURE_TEST, &crate::NoProgress)
            .unwrap();
        let session = store.session().unwrap();
        let h = parse_header(&file).unwrap();
        let staged = dir.path().join("staged.sqlite");
        extract_sqlite(&file, &h, &staged).unwrap();
        verify_mac(&file, &h, &staged, session.keys()).unwrap();
        // The original file is untouched, but the copy that would be imported differs: the MAC must fail.
        let mut bytes = std::fs::read(&staged).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        std::fs::write(&staged, &bytes).unwrap();
        assert!(matches!(
            verify_mac(&file, &h, &staged, session.keys()),
            Err(StoreError::Integrity(_))
        ));
        // A copy of the wrong length fails too.
        bytes.push(0);
        std::fs::write(&staged, &bytes).unwrap();
        assert!(verify_mac(&file, &h, &staged, session.keys()).is_err());
        drop(session);
        store.close().unwrap();
    }
}
