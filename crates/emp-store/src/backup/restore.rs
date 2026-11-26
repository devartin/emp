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
use crate::db::migrate::{LATEST_VERSION, expected_schema_objects, schema_objects};
use crate::manifest::{read_keyslots, read_state, verify};
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
    std::fs::create_dir_all(staging)?;
    let out_path = staging.join("inner.bin");
    let mut out = BufWriter::new(File::create(&out_path)?);
    reader.copy_to(&mut out)?;
    out.flush()?;
    Ok(out_path)
}

struct Header {
    manifest: SnapManifest,
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
    let mut mbytes = vec![0u8; p.manifest_len as usize];
    f.read_exact(&mut mbytes)
        .map_err(|_| integrity("the manifest is truncated"))?;
    let manifest: SnapManifest = ciborium::from_reader(mbytes.as_slice())
        .map_err(|_| integrity("the manifest is malformed"))?;
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
        sqlite_off,
        inner_len,
    })
}

fn verify_mac(inner: &Path, h: &Header, keys: &VaultKeys) -> Result<()> {
    let mut f = BufReader::new(File::open(inner)?);
    let mut mac = keys.backup_mac()?;
    let mut remaining = h.inner_len - 32;
    let mut buf = vec![0u8; BUF];
    while remaining > 0 {
        let want = usize::try_from(remaining.min(BUF as u64)).unwrap_or(BUF);
        f.read_exact(&mut buf[..want])?;
        mac.update(&buf[..want]);
        remaining -= want as u64;
    }
    let mut tag = [0u8; 32];
    f.read_exact(&mut tag)?;
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
                std::fs::create_dir_all(&d)?;
                Some(BufWriter::new(File::create(d.join(name))?))
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
    let mut out = BufWriter::new(File::create(dest)?);
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
        verify_mac(&inner, &h, keys)?;
        let db = staging.join("check.sqlite");
        std::fs::create_dir_all(&staging)?;
        extract_sqlite(&inner, &h, &db)?;
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
    std::fs::create_dir_all(staging)?;
    let db_stage = staging.join("vault.db");
    extract_sqlite(&inner, &h, &db_stage)?;
    let (keys, dek_vault, encrypted, pages, device) = {
        let conn = open_untrusted(&db_stage)?;
        // 3. Exactly the expected objects.
        if schema_objects(&conn)? != expected_schema_objects()? {
            return Err(integrity(
                "the backup's database has unexpected schema objects",
            ));
        }
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
        // 5. MAC, manifest, integrity, blobs.
        verify_mac(&inner, &h, &keys)?;
        check_against_db(&conn, &h, &keys)?;
        let encrypted = meta_get(&conn, "encryption")?.as_deref() == Some(b"on".as_slice());
        let pages: i64 = conn.query_row(
            "SELECT count(*) FROM pages WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        (
            keys,
            vault_id,
            encrypted,
            u64::try_from(pages).unwrap_or(0),
            device,
        )
    };
    check_blobs(&inner, &h, file, Some(&target_dir.join("assets")), progress)?;
    // 6. Into place.
    {
        let c = rusqlite::Connection::open(&db_stage)?;
        c.execute(
            "INSERT INTO security_log (at, event) VALUES (?1, 'backup_restore')",
            [now_ms],
        )?;
    }
    std::fs::rename(&db_stage, target_dir.join("vault.db"))?;
    if let Some(dk) = device {
        device_keys.save(&dek_vault, &dk)?;
    }
    drop(keys);
    Ok(Restored {
        vault_id: dek_vault.to_hex(),
        pages,
        dir: target_dir.to_owned(),
        encrypted,
    })
}
