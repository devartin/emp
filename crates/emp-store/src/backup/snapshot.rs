//! Creating snapshots (`.empsnap`) and backups (`.empbackup`), listing and retention (SPEC §9.21).

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use emp_crypto::backup::{BackupMac, PasswordContainerWriter, SnapshotPrefix};
use emp_crypto::mac::ContentHasher;
use emp_crypto::{ExposeSecret, KdfParams, SecretString};
use serde::Serialize;

use super::{BACKUP_PASSWORD_PROVIDER, SnapManifest};
use crate::db::migrate::user_version;
use crate::manifest::read_state;
use crate::model::SecretKind;
use crate::model::SecurityEvent;
use crate::model::ids::new_id;
use crate::{Progress, Result, Store, StoreError};

/// Copy buffer size.
const BUF: usize = 64 * 1024;
/// Store-internal kv namespace (never reachable from the webview) holding the chosen snapshot folder.
const SNAPSHOT_NS: &str = "snapshots";
/// Key of the chosen snapshot folder (an absolute path string).
const SNAPSHOT_FOLDER_KEY: &str = "folder";

/// `snapshot_list` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    /// Snapshot id (file stem).
    pub id: String,
    /// Creation time.
    pub at: i64,
    /// Size on disk (file plus blob directory).
    pub bytes: u64,
    /// Schema version.
    pub schema_version: i64,
    /// `local` (vault directory) or `folder` (user folder; set by the app).
    pub location: String,
}

/// Options of [`Store::backup_write`].
pub struct BackupOptions {
    /// Pack blobs into the file (`.empbackup`) instead of a sibling `<file>.blobs/` directory (`.empsnap`).
    pub packed: bool,
    /// Wrap the file in a password container. Required for plaintext vaults.
    pub password: Option<SecretString>,
    /// Argon2id parameters of the password container.
    pub kdf: KdfParams,
}

struct MacWriter<'a, W: Write> {
    inner: W,
    mac: &'a mut BackupMac,
    written: u64,
}

impl<W: Write> Write for MacWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.mac.update(&buf[..n]);
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn file_sha256(path: &Path) -> Result<(u64, [u8; 32])> {
    let mut f = BufReader::new(File::open(path)?);
    let mut h = ContentHasher::new();
    let mut buf = vec![0u8; BUF];
    let mut n_total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        n_total += n as u64;
    }
    Ok((n_total, h.finalize()))
}

/// Which snapshots to delete: keep the newest per day for `daily` days, per ISO week for `weekly` weeks and per
/// month for `monthly` months (D-22 / §9.21: 7 daily, 4 weekly, 6 monthly).
#[must_use]
pub fn retention_plan(
    snaps: &[(String, i64)],
    daily: u32,
    weekly: u32,
    monthly: u32,
) -> Vec<String> {
    use chrono::Datelike;
    let mut sorted: Vec<&(String, i64)> = snaps.iter().collect();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.1));
    let mut keep = std::collections::HashSet::new();
    let mut days = Vec::new();
    let mut weeks = Vec::new();
    let mut months = Vec::new();
    for (id, at) in &sorted {
        let Some(dt) = chrono::DateTime::from_timestamp_millis(*at) else {
            continue;
        };
        let d = dt.date_naive();
        let day = (d.year(), d.ordinal());
        let week = (d.iso_week().year(), d.iso_week().week());
        let month = (d.year(), d.month());
        if !days.contains(&day) && days.len() < daily as usize {
            days.push(day);
            keep.insert(id.clone());
        }
        if !weeks.contains(&week) && weeks.len() < weekly as usize {
            weeks.push(week);
            keep.insert(id.clone());
        }
        if !months.contains(&month) && months.len() < monthly as usize {
            months.push(month);
            keep.insert(id.clone());
        }
    }
    sorted
        .into_iter()
        .filter(|(id, _)| !keep.contains(id))
        .map(|(id, _)| id.clone())
        .collect()
}

impl Store {
    /// Sets (or clears) the backup password used for snapshots of plaintext vaults. Stored as an internal secret.
    pub fn set_backup_password(&self, password: Option<SecretString>) -> Result<()> {
        for s in self.secret_find(BACKUP_PASSWORD_PROVIDER)? {
            self.secret_delete(&s.id)?;
        }
        if let Some(pw) = password {
            if pw.expose_secret().chars().count() < 10 {
                return Err(StoreError::invalid_field(
                    "password",
                    "backup passwords need at least 10 characters",
                ));
            }
            self.secret_put_json(
                None,
                BACKUP_PASSWORD_PROVIDER,
                "Backup password",
                SecretKind::Field,
                serde_json::Value::String(pw.expose_secret().to_owned()),
                Vec::new(),
                None,
            )?;
        }
        Ok(())
    }

    /// Whether a backup password is set ("Automatic backups are off: set a backup password").
    pub fn has_backup_password(&self) -> Result<bool> {
        Ok(!self.secret_find(BACKUP_PASSWORD_PROVIDER)?.is_empty())
    }

    fn backup_password(&self) -> Result<Option<SecretString>> {
        match self.secret_find(BACKUP_PASSWORD_PROVIDER)?.first() {
            Some(s) => Ok(Some(self.secret_value(&s.id)?)),
            None => Ok(None),
        }
    }

    /// Writes a snapshot / backup container to `dest`. Returns the bytes written (excluding a `.blobs/` directory).
    pub fn backup_write(
        &self,
        dest: &Path,
        mut opts: BackupOptions,
        progress: &dyn Progress,
    ) -> Result<u64> {
        let s = self.session()?;
        let encrypted = s.codec.encrypting();
        if !encrypted && opts.password.is_none() {
            return Err(StoreError::invalid_field(
                "password",
                "backups of an unencrypted vault need a backup password",
            ));
        }
        // A plaintext vault stores its attachments raw. Beside the file (`<snap>.blobs/`) they would sit outside
        // the backup-password container in plain sight (often in a synced folder), so they are always packed in.
        if !encrypted {
            opts.packed = true;
        }
        let now = self.now();
        // 1. Consistent copy of the database.
        let tmp_db = self
            .inner
            .paths
            .tmp()
            .join(format!("snap-{}.sqlite", new_id()));
        let tmp_str = tmp_db
            .to_str()
            .ok_or_else(|| StoreError::Internal("non UTF-8 path".into()))?
            .to_owned();
        self.inner.writer.run(move |c| {
            c.execute("VACUUM INTO ?1", [tmp_str])?;
            Ok(())
        })?;
        let result = (|| -> Result<u64> {
            let (state, schema, blobs) = {
                let c = crate::db::conn::open_ro(&tmp_db)?;
                let state = read_state(&c)?
                    .ok_or_else(|| StoreError::Integrity("vault_state missing".into()))?;
                let schema = user_version(&c)?;
                let mut st = c.prepare(
                    "SELECT blob_name FROM assets GROUP BY blob_name ORDER BY blob_name",
                )?;
                let names: Vec<String> = st
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                (state, schema, names)
            };
            progress.progress(0, blobs.len() as u64 + 1, "database");
            let mut blob_entries = Vec::with_capacity(blobs.len());
            let mut blob_paths = Vec::with_capacity(blobs.len());
            for name in &blobs {
                let p = self.blob_file(name);
                let (size, digest) = file_sha256(&p)?;
                blob_entries.push((name.clone(), size, hex::encode(digest)));
                blob_paths.push(p);
            }
            let device_key = if encrypted {
                None
            } else {
                let dk = self
                    .inner
                    .opts
                    .device_keys
                    .load(&self.inner.vault_id)?
                    .ok_or(StoreError::NotFound("device key"))?;
                Some(hex::encode(dk.expose_secret()))
                // (`SnapManifest` zeroizes this copy on drop; `mbytes` below is zeroizing too.)
            };
            let sqlite_len = std::fs::metadata(&tmp_db)?.len();
            let manifest = SnapManifest {
                vault_id: self.inner.vault_id.to_hex(),
                created_at: now,
                app_version: self.inner.opts.app_version.clone(),
                schema_version: schema,
                write_counter: state.write_counter,
                mset_root: hex::encode(state.mset_root),
                blobs: blob_entries.clone(),
                sqlite_len,
                packed: opts.packed,
                encrypted,
                device_key,
            };
            let mut mbytes = zeroize::Zeroizing::new(Vec::new());
            ciborium::into_writer(&manifest, &mut *mbytes)
                .map_err(|e| StoreError::Internal(format!("manifest encoding: {e}")))?;
            let prefix = SnapshotPrefix {
                manifest_len: u32::try_from(mbytes.len())
                    .map_err(|_| StoreError::TooLarge("manifest"))?,
            }
            .encode()?;
            let packed_len: u64 = if opts.packed {
                blob_entries.iter().map(|b| 8 + b.1).sum()
            } else {
                0
            };
            let inner_len =
                prefix.len() as u64 + mbytes.len() as u64 + sqlite_len + packed_len + 32;
            if let Some(dir) = dest.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let partial = dest.with_extension("partial");
            let file = BufWriter::new(crate::vault::create_private_file(&partial)?);
            let mut mac = s.keys().backup_mac()?;
            let write_body = |w: &mut dyn Write, mac: &mut BackupMac| -> Result<()> {
                let mut mw = MacWriter {
                    inner: w,
                    mac,
                    written: 0,
                };
                mw.write_all(&prefix)?;
                mw.write_all(&mbytes)?;
                std::io::copy(&mut BufReader::new(File::open(&tmp_db)?), &mut mw)?;
                if opts.packed {
                    for (i, (p, e)) in blob_paths.iter().zip(&blob_entries).enumerate() {
                        mw.write_all(&e.1.to_be_bytes())?;
                        let n = std::io::copy(&mut BufReader::new(File::open(p)?), &mut mw)?;
                        if n != e.1 {
                            return Err(StoreError::Integrity(
                                "a blob changed while it was being backed up".into(),
                            ));
                        }
                        progress.progress(
                            i as u64 + 1,
                            blob_entries.len() as u64 + 1,
                            "attachments",
                        );
                    }
                }
                Ok(())
            };
            let total = match &opts.password {
                Some(pw) => {
                    let mut w = PasswordContainerWriter::new(pw, &opts.kdf, inner_len, file)?;
                    write_body(&mut w, &mut mac)?;
                    let tag = mac.finalize();
                    w.write_content(&tag)?;
                    let mut f = w.finish()?;
                    f.flush()?;
                    f.into_inner()
                        .map_err(|e| StoreError::Io(e.into_error()))?
                        .sync_all()?;
                    std::fs::metadata(&partial)?.len()
                }
                None => {
                    let mut f = file;
                    write_body(&mut f, &mut mac)?;
                    let tag = mac.finalize();
                    f.write_all(&tag)?;
                    f.flush()?;
                    f.into_inner()
                        .map_err(|e| StoreError::Io(e.into_error()))?
                        .sync_all()?;
                    inner_len
                }
            };
            if !opts.packed && !blob_paths.is_empty() {
                let dir = blobs_dir(dest);
                std::fs::create_dir_all(&dir)?;
                for (i, (p, e)) in blob_paths.iter().zip(&blob_entries).enumerate() {
                    std::fs::copy(p, dir.join(&e.0))?;
                    progress.progress(i as u64 + 1, blob_entries.len() as u64 + 1, "attachments");
                }
            }
            std::fs::rename(&partial, dest)?;
            Ok(total)
        })();
        let _ = std::fs::remove_file(&tmp_db);
        let total = result?;
        self.log_security_event(SecurityEvent::BackupCreate)?;
        Ok(total)
    }

    /// `backup_create`: a packed `.empbackup` file at `dest`, optionally under a separate backup password
    /// (required for unencrypted vaults).
    pub fn backup_create(
        &self,
        dest: &Path,
        password: Option<SecretString>,
        kdf: KdfParams,
        progress: &dyn Progress,
    ) -> Result<u64> {
        self.backup_write(
            dest,
            BackupOptions {
                packed: true,
                password,
                kdf,
            },
            progress,
        )
    }

    /// `snapshot_now`: an `.empsnap` in `snapshots/`. Plaintext vaults use the stored backup password and fail with
    /// `UNSUPPORTED` when none is set. Applies retention from the vault settings afterwards.
    pub fn snapshot_now(&self, kdf: KdfParams, progress: &dyn Progress) -> Result<String> {
        let s = self.session()?;
        let password = if s.codec.encrypting() {
            None
        } else {
            Some(self.backup_password()?.ok_or(StoreError::Unsupported(
                "Automatic backups are off: set a backup password",
            ))?)
        };
        let now = self.now();
        let schema = crate::db::migrate::LATEST_VERSION;
        let id = format!("{now}-v{schema}");
        let (dir, _) = self.snapshot_target()?;
        crate::vault::create_private_dir(&dir)?;
        self.backup_write(
            &dir.join(format!("{id}.empsnap")),
            BackupOptions {
                packed: false,
                password,
                kdf,
            },
            progress,
        )?;
        let settings = self.vault_settings()?.snapshots;
        self.snapshot_prune(
            settings.keep_daily,
            settings.keep_weekly,
            settings.keep_monthly,
        )?;
        Ok(id)
    }

    /// The folder snapshots are written to when the user chose one (`<chosen>/Ultranote snapshots <id>/`), or
    /// `None` for the vault's own `snapshots/` directory.
    pub fn snapshot_folder(&self) -> Result<Option<PathBuf>> {
        Ok(self
            .kv_get_any(SNAPSHOT_NS, SNAPSHOT_FOLDER_KEY)?
            .and_then(|v| v.as_str().map(PathBuf::from))
            .filter(|p| p.is_absolute()))
    }

    /// Chooses where snapshots go. `Some(folder)` must be an existing, writable directory the user picked (the app
    /// gets it from the native folder dialog); snapshots then go to a subfolder named after this vault, so one folder
    /// can serve several workspaces. `None` goes back to the vault directory. Existing snapshots stay where they are
    /// and keep being listed. Returns the snapshot directory in use.
    pub fn set_snapshot_folder(&self, folder: Option<&Path>) -> Result<PathBuf> {
        self.session()?;
        let Some(folder) = folder else {
            delete_kv(self)?;
            return Ok(self.inner.paths.snapshots());
        };
        if !folder.is_absolute() || !folder.is_dir() {
            return Err(StoreError::invalid_field(
                "folder",
                "choose an existing folder",
            ));
        }
        let hex = self.inner.vault_id.to_hex();
        let dir = folder.join(format!(
            "Ultranote snapshots {}",
            hex.get(..8).unwrap_or(&hex)
        ));
        crate::vault::create_private_dir(&dir)?;
        // Prove the folder takes files before relying on it (read-only mounts, permission problems).
        let probe = dir.join(format!(".write-test-{}", new_id()));
        crate::vault::create_private_file(&probe)?;
        let _ = std::fs::remove_file(&probe);
        let path = dir
            .to_str()
            .ok_or_else(|| {
                StoreError::invalid_field("folder", "the folder name is not valid Unicode")
            })?
            .to_owned();
        self.kv_set_any(
            SNAPSHOT_NS,
            SNAPSHOT_FOLDER_KEY,
            serde_json::Value::String(path),
            None,
        )?;
        Ok(dir)
    }

    /// Where the next snapshot is written, and whether that is the chosen folder. A chosen folder that is not
    /// reachable right now (an unplugged drive, an unmounted share) falls back to the vault directory, so automatic
    /// snapshots keep happening.
    pub fn snapshot_target(&self) -> Result<(PathBuf, bool)> {
        match self.snapshot_folder()? {
            Some(dir) if dir.is_dir() => Ok((dir, true)),
            Some(dir) if dir.parent().is_some_and(Path::is_dir) => Ok((dir, true)),
            _ => Ok((self.inner.paths.snapshots(), false)),
        }
    }

    /// Snapshot directories with their `location` label: the vault directory, then the chosen folder.
    fn snapshot_dirs(&self) -> Result<Vec<(PathBuf, &'static str)>> {
        let local = self.inner.paths.snapshots();
        let mut dirs = vec![(local.clone(), "local")];
        if let Some(folder) = self.snapshot_folder()?
            && folder != local
        {
            dirs.push((folder, "folder"));
        }
        Ok(dirs)
    }

    /// `snapshot_list`, newest first, across the vault directory and the chosen folder.
    pub fn snapshot_list(&self) -> Result<Vec<SnapshotInfo>> {
        self.session()?;
        let mut out = Vec::new();
        for (dir, location) in self.snapshot_dirs()? {
            if !dir.is_dir() {
                continue;
            }
            for e in std::fs::read_dir(&dir)? {
                let p = e?.path();
                if p.extension().and_then(|x| x.to_str()) != Some("empsnap") {
                    continue;
                }
                let Some(stem) = p.file_stem().and_then(|x| x.to_str()) else {
                    continue;
                };
                let Some((at, ver)) = stem.split_once("-v") else {
                    continue;
                };
                let (Ok(at), Ok(ver)) = (at.parse::<i64>(), ver.parse::<i64>()) else {
                    continue;
                };
                let mut bytes = std::fs::metadata(&p)?.len();
                let bd = blobs_dir(&p);
                if bd.is_dir() {
                    for b in std::fs::read_dir(&bd)? {
                        bytes += b?.metadata()?.len();
                    }
                }
                out.push(SnapshotInfo {
                    id: stem.to_owned(),
                    at,
                    bytes,
                    schema_version: ver,
                    location: location.into(),
                });
            }
        }
        out.sort_by_key(|s| std::cmp::Reverse(s.at));
        out.dedup_by(|a, b| a.id == b.id);
        Ok(out)
    }

    /// Path of a snapshot by id (the chosen folder first, then the vault directory).
    pub fn snapshot_path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'-' || b == b'v')
        {
            return Err(StoreError::invalid_field("id", "invalid snapshot id"));
        }
        for (dir, _) in self.snapshot_dirs()?.into_iter().rev() {
            let p = dir.join(format!("{id}.empsnap"));
            if p.is_file() {
                return Ok(p);
            }
        }
        Err(StoreError::NotFound("snapshot"))
    }

    /// Deletes snapshots outside the retention policy. Returns how many were removed.
    pub fn snapshot_prune(&self, daily: u32, weekly: u32, monthly: u32) -> Result<usize> {
        let list: Vec<(String, i64)> = self
            .snapshot_list()?
            .into_iter()
            .map(|s| (s.id, s.at))
            .collect();
        let del = retention_plan(&list, daily, weekly, monthly);
        for id in &del {
            let Ok(p) = self.snapshot_path(id) else {
                continue;
            };
            let _ = std::fs::remove_dir_all(blobs_dir(&p));
            let _ = std::fs::remove_file(&p);
        }
        Ok(del.len())
    }

    /// `snapshot_verify`: checks the MAC, manifest and blob hashes of a snapshot with the session keys.
    pub fn snapshot_verify(&self, id: &str, progress: &dyn Progress) -> Result<bool> {
        let s = self.session()?;
        let path = self.snapshot_path(id)?;
        let password = if s.codec.encrypting() {
            None
        } else {
            self.backup_password()?
        };
        match super::restore::verify_with_keys(&path, password.as_ref(), s.keys(), progress) {
            Ok(()) => Ok(true),
            Err(StoreError::Integrity(_) | StoreError::Crypto(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

fn delete_kv(store: &Store) -> Result<()> {
    crate::repo::kv::delete_internal(store, SNAPSHOT_NS, SNAPSHOT_FOLDER_KEY)
}

/// `<file>.blobs/` beside a snapshot.
#[must_use]
pub fn blobs_dir(snapshot: &Path) -> PathBuf {
    let mut name = snapshot
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".blobs");
    snapshot.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    #[test]
    fn retention_keeps_daily_weekly_monthly() {
        let now = 1_800_000_000_000;
        // Two snapshots a day for 400 days.
        let snaps: Vec<(String, i64)> = (0..800)
            .map(|i| (format!("s{i}"), now - i64::from(i) * DAY / 2))
            .collect();
        let del = retention_plan(&snaps, 7, 4, 6);
        let kept = snaps.len() - del.len();
        // 7 daily + up to 4 weekly + up to 6 monthly, with overlaps.
        assert!((7..=17).contains(&kept), "kept {kept}");
        assert!(!del.contains(&"s0".to_string()));
    }
}
