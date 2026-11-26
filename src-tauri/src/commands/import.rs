//! Import commands (SPEC §11.3 "Backup, import, export", §9.16, §17.3–§17.5) and the file-staging helpers the other
//! domain modules share.
//!
//! ## File staging
//! Grants are single use (§9.14), but several flows read a file twice: `import_detect` → `import_*`,
//! `db_import_preview` → `db_import_csv`, `finance_import_start` → `finance_import_commit`. A command that only
//! *inspects* a file redeems its grant, then **stages** the bytes under the same grant id for [`STAGE_TTL`]; the next
//! command redeems the staged copy instead of the (already used) grant. Staged files are bounded in count and total
//! size and expire with the grant lifetime.
//!
//! ## Undo
//! Every importer records an undo log in the store under an *import id*. Job results carry `importId`; in addition the
//! job id of the importing job is mapped to its import id so `import_undo({ importJobId })` accepts either.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use emp_store::import::files::ImportFile;
use emp_store::import::{ImportKind, detect};
use emp_store::{Store, ZipLimits};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, Webview};

use super::job_sink;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::grants::{GrantMode, GrantPurpose};
use crate::jobs::{JobCtx, JobRef};
use crate::state::{AppState, blocking};
use crate::validate;

// ───────────────────────────────────────────────────────────────────────────── staging

/// How long a staged file stays available (the grant lifetime).
pub const STAGE_TTL: Duration = crate::grants::GRANT_TTL;
/// Maximum number of staged files.
pub const STAGE_MAX_FILES: usize = 16;
/// Maximum total size of staged files.
pub const STAGE_MAX_BYTES: usize = 512 * 1024 * 1024;

/// Read caps per kind of input (§9.16).
pub mod caps {
    /// CSV / TSV tables (the spec allows 1 GiB streaming; v1 reads tables in memory).
    pub const TABLE: u64 = 256 * 1024 * 1024;
    /// XLSX / ODS workbooks.
    pub const WORKBOOK: u64 = 256 * 1024 * 1024;
    /// Bank statements (CSV, OFX, QFX, QIF).
    pub const STATEMENT: u64 = 64 * 1024 * 1024;
    /// Calendar files.
    pub const ICS: u64 = 64 * 1024 * 1024;
    /// A single Markdown file.
    pub const MARKDOWN_FILE: u64 = 16 * 1024 * 1024;
    /// A Markdown folder (all files together).
    pub const MARKDOWN_FOLDER: u64 = 512 * 1024 * 1024;
    /// Files in a Markdown folder.
    pub const MARKDOWN_FOLDER_FILES: usize = 10_000;
    /// Notion export zips (the importer pre-scans the uncompressed size).
    pub const NOTION_ZIP: u64 = 512 * 1024 * 1024;
    /// Bytes read for format detection.
    pub const SNIFF: usize = 64 * 1024;
}

/// A file read from a grant (or from the staging area).
#[derive(Clone, Debug)]
pub struct InputFile {
    /// Display name (file name only).
    pub name: String,
    /// Content.
    pub bytes: Arc<Vec<u8>>,
}

struct Staged {
    file: InputFile,
    expires: Instant,
}

static STAGED: LazyLock<Mutex<HashMap<String, Staged>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Keeps `file` available under `grant_id` for one more redemption.
pub fn stage(grant_id: &str, file: &InputFile) {
    let now = Instant::now();
    let mut m = STAGED.lock();
    m.retain(|_, s| s.expires > now);
    while m.len() >= STAGE_MAX_FILES
        || m.values().map(|s| s.file.bytes.len()).sum::<usize>() + file.bytes.len()
            > STAGE_MAX_BYTES
    {
        let Some(oldest) = m
            .iter()
            .min_by_key(|(_, s)| s.expires)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        m.remove(&oldest);
    }
    if file.bytes.len() <= STAGE_MAX_BYTES {
        m.insert(
            grant_id.to_owned(),
            Staged {
                file: file.clone(),
                expires: now + STAGE_TTL,
            },
        );
    }
}

fn take_staged(grant_id: &str) -> Option<InputFile> {
    let now = Instant::now();
    let mut m = STAGED.lock();
    m.retain(|_, s| s.expires > now);
    m.remove(grant_id).map(|s| s.file)
}

/// Drops every staged file (tests and lock hygiene).
pub fn clear_staged() {
    STAGED.lock().clear();
}

/// Reads at most `max` bytes of a regular file; `TOO_LARGE` above that.
pub fn read_capped(path: &Path, max: u64) -> ApiResult<Vec<u8>> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(ApiError::invalid("grantId", "choose a file, not a folder"));
    }
    if meta.len() > max {
        return Err(ApiError::new(
            ErrorCode::TooLarge,
            format!("This file is larger than {} MB", max / (1024 * 1024)),
        ));
    }
    Ok(std::fs::read(path)?)
}

/// Redeems `grant_id` (or its staged copy) for one of `purposes` and reads the file (≤ `max` bytes).
pub fn take_file(
    state: &AppState,
    grant_id: &str,
    purposes: &[GrantPurpose],
    max: u64,
) -> ApiResult<InputFile> {
    validate::grant_id("grantId", grant_id)?;
    if let Some(f) = take_staged(grant_id) {
        if f.bytes.len() as u64 > max {
            return Err(ApiError::new(ErrorCode::TooLarge, "This file is too large"));
        }
        return Ok(f);
    }
    let g = state.grants.take_any(grant_id, purposes, GrantMode::Read)?;
    let bytes = read_capped(&g.path, max)?;
    Ok(InputFile {
        name: g.display_name,
        bytes: Arc::new(bytes),
    })
}

/// Redeems a read grant that may name a folder; returns the path (staged files are never folders).
pub fn take_path(state: &AppState, grant_id: &str) -> ApiResult<(PathBuf, String)> {
    validate::grant_id("grantId", grant_id)?;
    let g = state
        .grants
        .take_any(grant_id, &[GrantPurpose::Import], GrantMode::Read)?;
    Ok((g.path, g.display_name))
}

/// Redeems a write grant issued by `file_save_grant({ purpose: 'export' })`.
pub fn take_export_target(state: &AppState, grant_id: &str) -> ApiResult<PathBuf> {
    validate::grant_id("grantId", grant_id)?;
    Ok(state
        .grants
        .take_any(
            grant_id,
            &[GrantPurpose::Export, GrantPurpose::Backup],
            GrantMode::Write,
        )?
        .path)
}

/// Writes `bytes` to `path` atomically (temp file in the same directory, then rename).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> ApiResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| ApiError::invalid("grantId", "invalid target"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| ApiError::invalid("grantId", "invalid target"))?;
    let tmp = dir.join(format!(".{name}.emp-tmp"));
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// The current time in unix ms.
#[must_use]
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Maps a job body error (running inside `catch_panics`) so a cancelled job reports `CANCELLED`.
pub fn cancelled_or(ctx: &JobCtx, e: ApiError) -> ApiError {
    if ctx.is_cancelled() {
        ApiError::new(ErrorCode::Cancelled, "Cancelled")
    } else {
        e
    }
}

// ───────────────────────────────────────────────────────────────────────────── undo bookkeeping

static JOB_IMPORTS: LazyLock<Mutex<HashMap<String, Arc<Mutex<Option<String>>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Remembered job → import mappings.
const MAX_JOB_IMPORTS: usize = 256;

/// A cell an import job fills with its import id; register it with [`remember_job`].
#[must_use]
pub fn import_cell() -> Arc<Mutex<Option<String>>> {
    Arc::new(Mutex::new(None))
}

/// Associates a job id with the import id its body writes into `cell`.
pub fn remember_job(job: &JobRef, cell: Arc<Mutex<Option<String>>>) {
    let mut m = JOB_IMPORTS.lock();
    if m.len() >= MAX_JOB_IMPORTS {
        m.retain(|_, c| c.lock().is_some());
        if m.len() >= MAX_JOB_IMPORTS {
            if let Some(k) = m.keys().next().cloned() {
                m.remove(&k);
            }
        }
    }
    m.insert(job.job_id.clone(), cell);
}

/// The import id for `id` (a job id of an import job, or an import id itself).
#[must_use]
pub fn resolve_import_id(id: &str) -> String {
    JOB_IMPORTS
        .lock()
        .get(id)
        .and_then(|c| c.lock().clone())
        .unwrap_or_else(|| id.to_owned())
}

// ───────────────────────────────────────────────────────────────────────────── import_detect

/// A `{ grantId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantReq {
    /// The file grant.
    pub grant_id: String,
}

/// `import_detect` result.
#[derive(Debug, Serialize)]
pub struct DetectDto {
    kind: &'static str,
    details: Value,
}

/// The wire name of an [`ImportKind`].
#[must_use]
pub fn kind_name(k: ImportKind) -> &'static str {
    match k {
        ImportKind::Markdown => "markdown",
        ImportKind::MarkdownFolder => "markdown_folder",
        ImportKind::NotionZip => "notion_zip",
        ImportKind::Csv => "csv",
        ImportKind::Xlsx => "xlsx",
        ImportKind::Ofx => "ofx",
        ImportKind::Qfx => "qfx",
        ImportKind::Qif => "qif",
        ImportKind::Ics => "ics",
        ImportKind::Empbackup => "empbackup",
        ImportKind::Unknown => "unknown",
    }
}

fn is_markdown_name(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".md") || l.ends_with(".markdown") || l.ends_with(".mdown")
}

/// Walks a folder (no symlinks, bounded) and returns relative paths of the regular files in it.
pub fn walk_folder(root: &Path, max_files: usize) -> ApiResult<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        for e in std::fs::read_dir(&dir)?.flatten() {
            let p = e.path();
            let Ok(meta) = p.symlink_metadata() else {
                continue;
            };
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') || meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if depth < 32 {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            if meta.is_file() {
                let rel = p
                    .strip_prefix(root)
                    .map_err(|_| ApiError::internal("walk"))?
                    .components()
                    .filter_map(|c| c.as_os_str().to_str())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((rel, p));
                if out.len() > max_files {
                    return Err(ApiError::new(
                        ErrorCode::TooLarge,
                        format!("This folder has more than {max_files} files"),
                    ));
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// `import_detect({ grantId }) → { kind, details }`. The file stays staged for the import that follows.
#[tauri::command]
pub async fn import_detect(app: AppHandle, req: GrantReq) -> ApiResult<DetectDto> {
    validate::grant_id("grantId", &req.grant_id)?;
    blocking(move || {
        let state = app.state::<AppState>();
        state.session()?;
        let (path, name) = take_path(&state, &req.grant_id)?;
        if path.is_dir() {
            let files = walk_folder(&path, caps::MARKDOWN_FOLDER_FILES)?;
            let md = files.iter().filter(|(r, _)| is_markdown_name(r)).count();
            let kind = if md > 0 {
                ImportKind::MarkdownFolder
            } else {
                ImportKind::Unknown
            };
            // Folders cannot be staged as bytes: re-issue a folder grant under a new id.
            let g = state
                .grants
                .issue(path, GrantPurpose::Import, GrantMode::Read)?;
            return Ok(DetectDto {
                kind: kind_name(kind),
                details: json!({ "name": name, "files": files.len(), "markdownFiles": md, "grantId": g.grant_id }),
            });
        }
        let bytes = read_capped(&path, caps::NOTION_ZIP.max(caps::TABLE))?;
        let file = InputFile {
            name: name.clone(),
            bytes: Arc::new(bytes),
        };
        let head = &file.bytes[..file.bytes.len().min(caps::SNIFF)];
        let mut kind = detect(&name, head);
        if kind == ImportKind::Unknown && is_markdown_name(&name) {
            kind = ImportKind::Markdown;
        }
        let details = json!({ "name": name, "size": file.bytes.len() });
        stage(&req.grant_id, &file);
        Ok(DetectDto {
            kind: kind_name(kind),
            details,
        })
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── import_markdown

/// `import_markdown` / `import_notion` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeImportReq {
    grant_id: String,
    workspace_id: String,
    parent_id: Option<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `import_markdown` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDto {
    pages: usize,
    warnings: Vec<String>,
    import_id: String,
}

fn markdown_files(state: &AppState, grant_id: &str) -> ApiResult<Vec<ImportFile>> {
    if let Some(f) = take_staged(grant_id) {
        return Ok(vec![ImportFile {
            path: f.name.clone(),
            bytes: f.bytes.as_ref().clone(),
        }]);
    }
    let (path, name) = take_path(state, grant_id)?;
    if path.is_file() {
        let bytes = read_capped(&path, caps::MARKDOWN_FILE)?;
        return Ok(vec![ImportFile { path: name, bytes }]);
    }
    let mut total = 0u64;
    let mut out = Vec::new();
    for (rel, p) in walk_folder(&path, caps::MARKDOWN_FOLDER_FILES)? {
        let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        total += len;
        if total > caps::MARKDOWN_FOLDER {
            return Err(ApiError::new(ErrorCode::TooLarge, "This folder is too large"));
        }
        // Attachments of a Markdown folder are capped like single files; bigger files are skipped by the importer.
        if len > caps::MARKDOWN_FILE * 4 {
            continue;
        }
        out.push(ImportFile {
            path: rel,
            bytes: std::fs::read(&p)?,
        });
    }
    Ok(out)
}

/// `import_markdown({ grantId, workspaceId, parentId, onEvent })` (job) ⇒ `{ pages, warnings, importId }`: a Markdown
/// file or a folder of Markdown files (with relative images) under `parentId`.
#[tauri::command]
pub async fn import_markdown(
    webview: Webview,
    state: State<'_, AppState>,
    req: TreeImportReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    let cell = import_cell();
    let out = Arc::clone(&cell);
    let job = state
        .jobs
        .spawn("import_markdown", true, store.now(), sink, move |ctx| {
            let state = app.state::<AppState>();
            ctx.report(0, 0, Some("Reading"));
            let files = markdown_files(&state, &req.grant_id)?;
            let r = store
                .import_markdown(&req.workspace_id, req.parent_id.as_deref(), files, ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))?;
            *out.lock() = Some(r.import_id.clone());
            Ok(MarkdownDto {
                pages: r.pages,
                warnings: r.warnings,
                import_id: r.import_id,
            })
        });
    remember_job(&job, cell);
    Ok(job)
}

/// `import_notion({ grantId, workspaceId, parentId, onEvent })` (job) ⇒ `{ pages, databases, rows, assets, unresolved,
/// warnings, importId }`: a Notion "Markdown & CSV" or "HTML" export zip.
#[tauri::command]
pub async fn import_notion(
    webview: Webview,
    state: State<'_, AppState>,
    req: TreeImportReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    let cell = import_cell();
    let out = Arc::clone(&cell);
    let job = state
        .jobs
        .spawn("import_notion", true, store.now(), sink, move |ctx| {
            let state = app.state::<AppState>();
            ctx.report(0, 0, Some("Reading"));
            let f = take_file(
                &state,
                &req.grant_id,
                &[GrantPurpose::Import],
                caps::NOTION_ZIP,
            )?;
            let r = store
                .import_notion(
                    &req.workspace_id,
                    req.parent_id.as_deref(),
                    &f.bytes,
                    ZipLimits::DEFAULT,
                    ctx,
                )
                .map_err(|e| cancelled_or(ctx, e.into()))?;
            *out.lock() = Some(r.import_id.clone());
            Ok(r)
        });
    remember_job(&job, cell);
    Ok(job)
}

// ───────────────────────────────────────────────────────────────────────────── import_ics

/// `import_ics.target`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum IcsTarget {
    /// The local calendar (`'calendar'`).
    Calendar(CalendarLiteral),
    /// Rows of a database with a date property.
    Database {
        /// Database id.
        #[serde(rename = "databaseId")]
        database_id: String,
    },
}

/// The literal `'calendar'`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalendarLiteral {
    /// Local calendar.
    Calendar,
}

/// `import_ics` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IcsImportReq {
    grant_id: String,
    target: IcsTarget,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `import_ics({ grantId, target: 'calendar'|{ databaseId }, onEvent })` (job) ⇒ `{ events, importId? }`.
///
/// `'calendar'` keeps the file as a local read-only calendar served by `calendar_events` (source `ics`); a database
/// target appends one row per event (title, date range, description/location when such properties exist).
#[tauri::command]
pub async fn import_ics(
    webview: Webview,
    state: State<'_, AppState>,
    req: IcsImportReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    if let IcsTarget::Database { database_id } = &req.target {
        validate::id("target.databaseId", database_id)?;
    }
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    let cell = import_cell();
    let out = Arc::clone(&cell);
    let job = state
        .jobs
        .spawn("import_ics", true, store.now(), sink, move |ctx| {
            let state = app.state::<AppState>();
            ctx.report(0, 2, Some("Reading"));
            let f = take_file(&state, &req.grant_id, &[GrantPurpose::Import], caps::ICS)?;
            let cal = crate::jobs::catch_panics(|| {
                emp_integrations::ics::parse_ics(&f.bytes, &emp_integrations::ics::IcsLimits::default())
            })
            .map_err(|_| ApiError::invalid("grantId", "This calendar file could not be read"))??;
            ctx.check_cancelled()?;
            ctx.report(1, 2, Some("Importing"));
            let result = match req.target {
                IcsTarget::Calendar(_) => {
                    let n = super::ics::store_local_calendar(&store, &f.name, &cal)?;
                    json!({ "events": n })
                }
                IcsTarget::Database { database_id } => {
                    let (n, import_id) =
                        super::ics::import_into_database(&store, &database_id, &cal)?;
                    super::db::emit_db_changed(&state, &store, &database_id, None);
                    *out.lock() = Some(import_id.clone());
                    json!({ "events": n, "importId": import_id })
                }
            };
            ctx.report(2, 2, Some("Done"));
            Ok(result)
        });
    remember_job(&job, cell);
    Ok(job)
}

// ───────────────────────────────────────────────────────────────────────────── import_undo

/// `import_undo` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoReq {
    import_job_id: String,
}

/// `import_undo` result.
#[derive(Debug, Serialize)]
pub struct UndoDto {
    removed: usize,
}

/// `import_undo({ importJobId }) → { removed }`: removes everything an import created. Accepts the job id of the
/// import job or the `importId` from its result.
#[tauri::command]
pub async fn import_undo(app: AppHandle, req: UndoReq) -> ApiResult<UndoDto> {
    validate::id("importJobId", &req.import_job_id)?;
    blocking(move || {
        let store: Store = app.state::<AppState>().session()?;
        let id = resolve_import_id(&req.import_job_id);
        let removed = match super::ics::undo_rows(&store, &id)? {
            Some(n) => n,
            None => store.import_undo(&id)?,
        };
        Ok(UndoDto { removed })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(n: usize) -> InputFile {
        InputFile {
            name: "a.csv".into(),
            bytes: Arc::new(vec![0u8; n]),
        }
    }

    #[test]
    fn staged_files_are_single_use() {
        let id = "0123456789abcdef0123456789abcdef";
        stage(id, &file(3));
        assert_eq!(take_staged(id).map(|f| f.bytes.len()), Some(3));
        assert!(take_staged(id).is_none());
    }

    #[test]
    fn staging_is_bounded_in_count() {
        for i in 0..(STAGE_MAX_FILES + 4) {
            stage(&format!("{i:032x}"), &file(1));
        }
        assert!(STAGED.lock().len() <= STAGE_MAX_FILES);
        clear_staged();
    }

    #[test]
    fn kind_names_match_the_contract() {
        assert_eq!(kind_name(ImportKind::NotionZip), "notion_zip");
        assert_eq!(kind_name(ImportKind::MarkdownFolder), "markdown_folder");
        assert_eq!(kind_name(ImportKind::Empbackup), "empbackup");
    }

    #[test]
    fn read_capped_rejects_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.csv");
        std::fs::write(&p, b"0123456789").unwrap();
        assert_eq!(read_capped(&p, 100).unwrap().len(), 10);
        assert_eq!(read_capped(&p, 5).unwrap_err().code, ErrorCode::TooLarge);
        assert_eq!(
            read_capped(dir.path(), 100).unwrap_err().code,
            ErrorCode::Invalid
        );
    }

    #[test]
    fn walks_folders_without_hidden_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("a.md"), b"# A").unwrap();
        std::fs::write(dir.path().join("sub/b.md"), b"# B").unwrap();
        std::fs::write(dir.path().join(".hidden"), b"x").unwrap();
        let files: Vec<String> = walk_folder(dir.path(), 10)
            .unwrap()
            .into_iter()
            .map(|(r, _)| r)
            .collect();
        assert_eq!(files, vec!["a.md".to_owned(), "sub/b.md".to_owned()]);
        assert_eq!(
            walk_folder(dir.path(), 1).unwrap_err().code,
            ErrorCode::TooLarge
        );
    }

    #[test]
    fn writes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.csv");
        write_atomic(&p, b"a,b").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"a,b");
        assert!(!dir.path().join(".out.csv.emp-tmp").exists());
    }

    #[test]
    fn job_ids_resolve_to_import_ids() {
        let cell = import_cell();
        let job = JobRef {
            job_id: "job-1".into(),
        };
        remember_job(&job, Arc::clone(&cell));
        assert_eq!(resolve_import_id("job-1"), "job-1");
        *cell.lock() = Some("imp-9".into());
        assert_eq!(resolve_import_id("job-1"), "imp-9");
        assert_eq!(resolve_import_id("imp-9"), "imp-9");
    }
}
