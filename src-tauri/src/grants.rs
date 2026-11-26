//! File grants (SPEC §9.14).
//!
//! The webview never sees a path. Native dialogs and drag-and-drop run in Rust; each chosen file becomes a grant
//! with a 128-bit random id, the canonicalised path, a purpose and a mode. Grants expire after 10 minutes and are
//! single use: commands that take files accept only a `grantId` and redeem it with [`GrantRegistry::take`], which
//! rejects a mismatched purpose, an expired grant or a reused grant.
//!
//! Commands that only *inspect* a file before the real import (`import_detect`, `db_import_preview`,
//! `finance_import_start`) use [`GrantRegistry::peek`]: the same checks, but the grant stays valid (its lifetime is
//! not extended) for the command that redeems it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};

/// Grant lifetime.
pub const GRANT_TTL: Duration = Duration::from_secs(10 * 60);
/// Upper bound on live grants (old ones are evicted first).
pub const MAX_GRANTS: usize = 4_096;

/// Why a file was granted. Read purposes come from `file_pick` / drag-and-drop, write purposes from
/// `file_save_grant`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantPurpose {
    /// Import into the workspace.
    Import,
    /// Attach as an asset.
    Attach,
    /// Restore a backup.
    Restore,
    /// Insert an image.
    Image,
    /// Export target.
    Export,
    /// Backup target.
    Backup,
    /// Dropped onto the window (usable for import, attach and image).
    Drop,
}

impl GrantPurpose {
    /// Whether a grant of this purpose may be redeemed for `wanted`.
    #[must_use]
    pub fn satisfies(self, wanted: GrantPurpose) -> bool {
        self == wanted
            || (self == GrantPurpose::Drop
                && matches!(
                    wanted,
                    GrantPurpose::Import | GrantPurpose::Attach | GrantPurpose::Image
                ))
    }
}

/// Read or write access.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantMode {
    /// Read an existing file.
    Read,
    /// Create or overwrite the file.
    Write,
}

/// `FileGrant` (SPEC §11.2): what the webview receives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGrant {
    /// The grant id.
    pub grant_id: String,
    /// File name only (never the directory).
    pub display_name: String,
    /// Size in bytes (0 for write grants).
    pub size: u64,
}

/// A redeemed grant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Granted {
    /// Canonicalised path (for write grants: canonical parent + file name).
    pub path: PathBuf,
    /// The purpose it was issued for.
    pub purpose: GrantPurpose,
    /// Read or write.
    pub mode: GrantMode,
    /// Display name.
    pub display_name: String,
}

struct Entry {
    granted: Granted,
    expires: Instant,
    issued: Instant,
}

/// Live grants.
#[derive(Default)]
pub struct GrantRegistry {
    grants: Mutex<HashMap<String, Entry>>,
}

fn new_grant_id() -> ApiResult<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|_| ApiError::internal("rng"))?;
    Ok(hex::encode(b))
}

/// The file name of `path` for display (`"file"` when it has none).
#[must_use]
pub fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map_or_else(|| "file".to_owned(), str::to_owned)
}

/// Canonicalises a path for a grant. Write targets may not exist yet: their parent is canonicalised instead.
pub fn canonicalize_for(path: &Path, mode: GrantMode) -> ApiResult<PathBuf> {
    match mode {
        GrantMode::Read => {
            let p = std::fs::canonicalize(path)?;
            let meta = std::fs::metadata(&p)?;
            if !(meta.is_file() || meta.is_dir()) {
                return Err(ApiError::invalid("grantId", "not a regular file"));
            }
            Ok(p)
        }
        GrantMode::Write => {
            let name = path
                .file_name()
                .ok_or_else(|| ApiError::invalid("grantId", "no file name"))?;
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            Ok(std::fs::canonicalize(parent)?.join(name))
        }
    }
}

impl GrantRegistry {
    /// Issues a grant for an already canonicalised `path`.
    pub fn issue(
        &self,
        path: PathBuf,
        purpose: GrantPurpose,
        mode: GrantMode,
    ) -> ApiResult<FileGrant> {
        self.issue_at(path, purpose, mode, Instant::now())
    }

    fn issue_at(
        &self,
        path: PathBuf,
        purpose: GrantPurpose,
        mode: GrantMode,
        now: Instant,
    ) -> ApiResult<FileGrant> {
        let size = match mode {
            GrantMode::Read => std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            GrantMode::Write => 0,
        };
        let display_name = display_name(&path);
        let id = new_grant_id()?;
        let mut grants = self.grants.lock();
        grants.retain(|_, e| e.expires > now);
        if grants.len() >= MAX_GRANTS {
            if let Some(oldest) = grants
                .iter()
                .min_by_key(|(_, e)| e.issued)
                .map(|(k, _)| k.clone())
            {
                grants.remove(&oldest);
            }
        }
        grants.insert(
            id.clone(),
            Entry {
                granted: Granted {
                    path,
                    purpose,
                    mode,
                    display_name: display_name.clone(),
                },
                expires: now + GRANT_TTL,
                issued: now,
            },
        );
        Ok(FileGrant {
            grant_id: id,
            display_name,
            size,
        })
    }

    /// Redeems a grant (single use). Fails with `INVALID` for an unknown, reused or expired grant, or one issued for
    /// another purpose or mode.
    pub fn take(&self, id: &str, purpose: GrantPurpose, mode: GrantMode) -> ApiResult<Granted> {
        self.take_at(id, purpose, mode, Instant::now())
    }

    fn take_at(
        &self,
        id: &str,
        purpose: GrantPurpose,
        mode: GrantMode,
        now: Instant,
    ) -> ApiResult<Granted> {
        crate::validate::grant_id("grantId", id)?;
        let mut grants = self.grants.lock();
        let entry = grants.remove(id).ok_or_else(|| {
            ApiError::invalid("grantId", "this file grant is unknown or was already used")
        })?;
        if entry.expires <= now {
            return Err(ApiError::invalid(
                "grantId",
                "this file grant expired; choose the file again",
            ));
        }
        if !entry.granted.purpose.satisfies(purpose) || entry.granted.mode != mode {
            return Err(ApiError::invalid(
                "grantId",
                "this file was chosen for a different purpose",
            ));
        }
        Ok(entry.granted)
    }

    /// Checks a grant without redeeming it: the same checks as [`GrantRegistry::take`] (format, unknown, expired,
    /// purpose, mode), but the grant stays valid for the command that follows. A failed peek does not consume the
    /// grant either (an expired one is dropped). Peeking never extends a grant's lifetime.
    pub fn peek(&self, id: &str, purpose: GrantPurpose, mode: GrantMode) -> ApiResult<Granted> {
        self.peek_any(id, &[purpose], mode)
    }

    /// Like [`GrantRegistry::peek`], accepting a grant issued for any of `purposes`.
    pub fn peek_any(
        &self,
        id: &str,
        purposes: &[GrantPurpose],
        mode: GrantMode,
    ) -> ApiResult<Granted> {
        self.peek_at(id, purposes, mode, Instant::now())
    }

    fn peek_at(
        &self,
        id: &str,
        purposes: &[GrantPurpose],
        mode: GrantMode,
        now: Instant,
    ) -> ApiResult<Granted> {
        crate::validate::grant_id("grantId", id)?;
        let mut grants = self.grants.lock();
        let entry = grants.get(id).ok_or_else(|| {
            ApiError::invalid("grantId", "this file grant is unknown or was already used")
        })?;
        if entry.expires <= now {
            grants.remove(id);
            return Err(ApiError::invalid(
                "grantId",
                "this file grant expired; choose the file again",
            ));
        }
        if !purposes.iter().any(|p| entry.granted.purpose.satisfies(*p))
            || entry.granted.mode != mode
        {
            return Err(ApiError::invalid(
                "grantId",
                "this file was chosen for a different purpose",
            ));
        }
        Ok(entry.granted.clone())
    }

    /// Like [`GrantRegistry::take`], accepting a grant issued for any of `purposes`.
    pub fn take_any(
        &self,
        id: &str,
        purposes: &[GrantPurpose],
        mode: GrantMode,
    ) -> ApiResult<Granted> {
        crate::validate::grant_id("grantId", id)?;
        let issued = self
            .grants
            .lock()
            .get(id)
            .map(|e| e.granted.purpose)
            .ok_or_else(|| {
                ApiError::invalid("grantId", "this file grant is unknown or was already used")
            })?;
        let wanted = purposes
            .iter()
            .copied()
            .find(|p| issued.satisfies(*p))
            .unwrap_or(purposes.first().copied().unwrap_or(GrantPurpose::Import));
        self.take(id, wanted, mode)
    }

    /// Drops every grant (on lock).
    pub fn clear(&self) {
        self.grants.lock().clear();
    }

    /// Number of live (unexpired) grants.
    #[must_use]
    pub fn len(&self) -> usize {
        let now = Instant::now();
        self.grants
            .lock()
            .values()
            .filter(|e| e.expires > now)
            .count()
    }

    /// `true` when there is no live grant.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.md");
        std::fs::write(&p, b"# hi").unwrap();
        let p = canonicalize_for(&p, GrantMode::Read).unwrap();
        (dir, p)
    }

    #[test]
    fn grants_are_single_use() {
        let (_d, p) = temp_file();
        let reg = GrantRegistry::default();
        let g = reg
            .issue(p.clone(), GrantPurpose::Import, GrantMode::Read)
            .unwrap();
        assert_eq!(g.display_name, "notes.md");
        assert_eq!(g.size, 4);
        assert_eq!(g.grant_id.len(), 32);
        let got = reg
            .take(&g.grant_id, GrantPurpose::Import, GrantMode::Read)
            .unwrap();
        assert_eq!(got.path, p);
        assert!(
            reg.take(&g.grant_id, GrantPurpose::Import, GrantMode::Read)
                .is_err()
        );
    }

    #[test]
    fn purpose_and_mode_must_match() {
        let (_d, p) = temp_file();
        let reg = GrantRegistry::default();
        let g = reg
            .issue(p.clone(), GrantPurpose::Image, GrantMode::Read)
            .unwrap();
        assert!(
            reg.take(&g.grant_id, GrantPurpose::Restore, GrantMode::Read)
                .is_err()
        );
        // A failed redemption still consumes the grant.
        assert!(
            reg.take(&g.grant_id, GrantPurpose::Image, GrantMode::Read)
                .is_err()
        );
        let g = reg
            .issue(p, GrantPurpose::Export, GrantMode::Write)
            .unwrap();
        assert!(
            reg.take(&g.grant_id, GrantPurpose::Export, GrantMode::Read)
                .is_err()
        );
    }

    #[test]
    fn grants_expire() {
        let (_d, p) = temp_file();
        let reg = GrantRegistry::default();
        let t0 = Instant::now();
        let g = reg
            .issue_at(p, GrantPurpose::Attach, GrantMode::Read, t0)
            .unwrap();
        let err = reg
            .take_at(
                &g.grant_id,
                GrantPurpose::Attach,
                GrantMode::Read,
                t0 + GRANT_TTL + Duration::from_secs(1),
            )
            .unwrap_err();
        assert!(err.message.contains("expired"));
    }

    #[test]
    fn peek_checks_without_consuming() {
        let (_d, p) = temp_file();
        let reg = GrantRegistry::default();
        let g = reg
            .issue(p.clone(), GrantPurpose::Drop, GrantMode::Read)
            .unwrap();
        let peeked = reg
            .peek(&g.grant_id, GrantPurpose::Import, GrantMode::Read)
            .unwrap();
        assert_eq!(peeked.path, p);
        assert_eq!(peeked.display_name, "notes.md");
        // Wrong purpose or mode fails but does not burn the grant.
        assert!(
            reg.peek(&g.grant_id, GrantPurpose::Restore, GrantMode::Read)
                .is_err()
        );
        assert!(
            reg.peek(&g.grant_id, GrantPurpose::Import, GrantMode::Write)
                .is_err()
        );
        assert!(
            reg.peek_any(
                &g.grant_id,
                &[GrantPurpose::Restore, GrantPurpose::Attach],
                GrantMode::Read
            )
            .is_ok()
        );
        // Still redeemable exactly once.
        assert!(
            reg.take(&g.grant_id, GrantPurpose::Import, GrantMode::Read)
                .is_ok()
        );
        assert!(
            reg.peek(&g.grant_id, GrantPurpose::Import, GrantMode::Read)
                .is_err()
        );
        assert!(
            reg.peek("../../etc", GrantPurpose::Import, GrantMode::Read)
                .is_err()
        );
    }

    #[test]
    fn peek_honours_expiry() {
        let (_d, p) = temp_file();
        let reg = GrantRegistry::default();
        let t0 = Instant::now();
        let g = reg
            .issue_at(p, GrantPurpose::Import, GrantMode::Read, t0)
            .unwrap();
        let err = reg
            .peek_at(
                &g.grant_id,
                &[GrantPurpose::Import],
                GrantMode::Read,
                t0 + GRANT_TTL,
            )
            .unwrap_err();
        assert!(err.message.contains("expired"));
        assert!(reg.is_empty());
    }

    #[test]
    fn dropped_files_serve_read_purposes_only() {
        assert!(GrantPurpose::Drop.satisfies(GrantPurpose::Attach));
        assert!(GrantPurpose::Drop.satisfies(GrantPurpose::Import));
        assert!(!GrantPurpose::Drop.satisfies(GrantPurpose::Restore));
        assert!(!GrantPurpose::Import.satisfies(GrantPurpose::Attach));
    }

    #[test]
    fn write_targets_canonicalise_parent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let target = dir.path().join("sub/../out.empbackup");
        let p = canonicalize_for(&target, GrantMode::Write).unwrap();
        assert_eq!(p.file_name().unwrap(), "out.empbackup");
        assert!(!p.to_string_lossy().contains(".."));
    }

    #[test]
    fn clear_drops_everything() {
        let (_d, p) = temp_file();
        let reg = GrantRegistry::default();
        reg.issue(p, GrantPurpose::Import, GrantMode::Read).unwrap();
        assert_eq!(reg.len(), 1);
        reg.clear();
        assert!(reg.is_empty());
    }

    #[test]
    fn rejects_malformed_ids() {
        let reg = GrantRegistry::default();
        assert!(
            reg.take("../../etc", GrantPurpose::Import, GrantMode::Read)
                .is_err()
        );
    }
}
