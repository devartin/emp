//! Export commands (SPEC §11.3 "Backup, import, export", §17.5).
//!
//! * `export_pages` writes Markdown (with front matter and relative asset links) or JSON for the chosen pages into a
//!   new folder at the export grant's path. PDF is printed by the frontend (`window.print()`); this command returns
//!   `UNSUPPORTED` for it (§11.3).
//! * `export_everything` *(reauth)* writes a portable folder: every document tree as Markdown with assets, every
//!   database as CSV and every workbook as XLSX, grouped by workspace, plus a `manifest.json`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use emp_store::Store;
use emp_store::backup::export::{ExportFormat, ExportOptions, safe_file_name};
use emp_store::model::PageKind;
use serde::Deserialize;
use serde_json::json;
use tauri::{State, Webview};

use super::import::{cancelled_or, take_export_target};
use super::job_sink;
use crate::error::{ApiError, ApiResult};
use crate::jobs::{JobCtx, JobRef};
use crate::state::AppState;
use crate::validate;

/// Export formats on the wire.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PageFormat {
    /// Markdown.
    Markdown,
    /// JSON (TipTap documents).
    Json,
    /// PDF (printed by the frontend; `UNSUPPORTED` here).
    Pdf,
}

/// `export_pages` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportPagesReq {
    page_ids: Vec<String>,
    format: PageFormat,
    include_children: bool,
    include_assets: bool,
    grant_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// Creates the export folder at a save-grant path (an existing non-empty folder is refused).
pub fn export_dir(path: &Path) -> ApiResult<PathBuf> {
    let dir = match path.extension().and_then(|e| e.to_str()) {
        Some("zip" | "md" | "json" | "emp") => path.with_extension(""),
        _ => path.to_path_buf(),
    };
    if dir.exists() {
        let empty = std::fs::read_dir(&dir)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if !dir.is_dir() || !empty {
            return Err(ApiError::invalid(
                "grantId",
                "Choose a new folder name for the export",
            ));
        }
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// SPEC §9.10 "export unencrypted data": a plaintext export out of an **encrypted** vault (`export_pages`,
/// `db_export`, `sheet_export`) needs the 5-minute re-auth window. Unencrypted vaults have nothing to protect.
pub fn require_export_reauth(store: &Store) -> ApiResult<()> {
    if store.is_encrypted()? {
        store.require_reauth()?;
    }
    Ok(())
}

/// Total size of the regular files under `dir` (no symlinks followed).
#[must_use]
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(m) = e.path().symlink_metadata() else {
                continue;
            };
            if m.is_dir() {
                stack.push(e.path());
            } else if m.is_file() {
                total += m.len();
            }
        }
    }
    total
}

/// `export_pages({ pageIds, format, includeChildren, includeAssets, grantId, onEvent })` (job) ⇒ `{ files }`
/// *(reauth when the vault is encrypted)*.
#[tauri::command]
pub async fn export_pages(
    webview: Webview,
    state: State<'_, AppState>,
    req: ExportPagesReq,
) -> ApiResult<JobRef> {
    validate::ids("pageIds", &req.page_ids, false)?;
    validate::grant_id("grantId", &req.grant_id)?;
    let format = match req.format {
        PageFormat::Markdown => ExportFormat::Markdown,
        PageFormat::Json => ExportFormat::Json,
        PageFormat::Pdf => {
            return Err(ApiError::unsupported(
                "PDF export is printed from the page view",
            ));
        }
    };
    let store = state.session()?;
    require_export_reauth(&store)?;
    let target = take_export_target(&state, &req.grant_id)?;
    let sink = job_sink(&webview, &req.on_event);
    Ok(state
        .jobs
        .spawn("export_pages", true, store.now(), sink, move |ctx| {
            let dir = export_dir(&target)?;
            let opts = ExportOptions {
                format,
                include_children: req.include_children,
                include_assets: req.include_assets,
            };
            let files = store
                .export_pages(&req.page_ids, &dir, opts, ctx)
                .map_err(|e| cancelled_or(ctx, e.into()))?;
            Ok(json!({ "files": files }))
        }))
}

/// `export_everything` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportEverythingReq {
    grant_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// Windows device names: a file called `CON.csv` or `nul.xlsx` opens the device instead of a file.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    "conin$", "conout$",
];

/// `safe_file_name`, plus a suffix for names Windows reserves for devices (checked on every platform, since an
/// export folder may be copied to Windows later).
#[must_use]
pub fn portable_file_name(title: &str) -> String {
    let base = safe_file_name(title);
    let stem = base
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_lowercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        format!("{base}_")
    } else {
        base
    }
}

/// A file name unique within `used`.
pub fn unique_name(used: &mut HashSet<String>, title: &str, ext: &str) -> String {
    let base = portable_file_name(title);
    let mut name = format!("{base}.{ext}");
    let mut n = 2;
    while !used.insert(name.to_lowercase()) {
        name = format!("{base} ({n}).{ext}");
        n += 1;
    }
    name
}

fn export_all(store: &Store, dir: &Path, ctx: &JobCtx) -> ApiResult<u64> {
    let workspaces = store.workspace_list()?;
    let mut manifest = Vec::new();
    let total = workspaces.len() as u64;
    let mut used_ws = HashSet::new();
    for (wi, ws) in workspaces.iter().enumerate() {
        ctx.check_cancelled()?;
        ctx.report(wi as u64, total, Some("Exporting"));
        let ws_dir = dir.join(unique_name(&mut used_ws, &ws.name, "d").trim_end_matches(".d"));
        std::fs::create_dir_all(&ws_dir)?;
        let tree = store.page_tree(&ws.id)?;
        let roots: Vec<String> = tree
            .iter()
            .filter(|m| {
                m.parent_id.is_none()
                    && matches!(m.kind, PageKind::Doc | PageKind::Dashboard | PageKind::App)
            })
            .map(|m| m.id.clone())
            .collect();
        let mut files = 0usize;
        for chunk in roots.chunks(1_000) {
            let pages = ws_dir.join("pages");
            std::fs::create_dir_all(&pages)?;
            files += store
                .export_pages(
                    chunk,
                    &pages,
                    ExportOptions {
                        format: ExportFormat::Markdown,
                        include_children: true,
                        include_assets: true,
                    },
                    &emp_store::NoProgress,
                )
                .map_err(|e| cancelled_or(ctx, e.into()))?;
        }
        let mut used = HashSet::new();
        let mut databases = 0usize;
        let mut sheets = 0usize;
        for m in tree.iter().filter(|m| m.deleted_at.is_none()) {
            ctx.check_cancelled()?;
            match m.kind {
                PageKind::Database => {
                    let (bytes, _) = store
                        .db_export(&m.id, None, "csv", &emp_store::NoProgress)
                        .map_err(|e| cancelled_or(ctx, e.into()))?;
                    let d = ws_dir.join("databases");
                    std::fs::create_dir_all(&d)?;
                    std::fs::write(d.join(unique_name(&mut used, &m.title, "csv")), bytes)?;
                    databases += 1;
                }
                PageKind::Sheet => {
                    let bytes = store.sheet_export(&m.id, "xlsx", None)?;
                    let d = ws_dir.join("sheets");
                    std::fs::create_dir_all(&d)?;
                    std::fs::write(d.join(unique_name(&mut used, &m.title, "xlsx")), bytes)?;
                    sheets += 1;
                }
                _ => {}
            }
        }
        manifest.push(json!({ "workspace": ws.name, "pageFiles": files, "databases": databases, "sheets": sheets }));
    }
    let man = json!({
        "app": "Ultranote",
        "version": env!("CARGO_PKG_VERSION"),
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "workspaces": manifest,
    });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&man).map_err(|_| ApiError::internal("manifest"))?,
    )?;
    ctx.report(total, total, Some("Done"));
    Ok(dir_size(dir))
}

/// `export_everything({ grantId, onEvent })` *(reauth)* (job) ⇒ `{ bytes }`: a portable, unencrypted copy of every
/// workspace (Markdown + assets, CSV, XLSX) in a new folder at the grant's path.
#[tauri::command]
pub async fn export_everything(
    webview: Webview,
    state: State<'_, AppState>,
    req: ExportEverythingReq,
) -> ApiResult<JobRef> {
    validate::grant_id("grantId", &req.grant_id)?;
    let store = state.require_reauth()?;
    let target = take_export_target(&state, &req.grant_id)?;
    let sink = job_sink(&webview, &req.on_event);
    Ok(state
        .jobs
        .spawn("export_everything", true, store.now(), sink, move |ctx| {
            let dir = export_dir(&target)?;
            let bytes = export_all(&store, &dir, ctx)?;
            Ok(json!({ "bytes": bytes }))
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_safe() {
        let mut used = HashSet::new();
        assert_eq!(unique_name(&mut used, "Budget", "csv"), "Budget.csv");
        assert_eq!(unique_name(&mut used, "budget", "csv"), "budget (2).csv");
        assert_eq!(unique_name(&mut used, "a/b:c", "md"), "a-b-c.md");
    }

    #[test]
    fn windows_device_names_are_never_used() {
        let mut used = HashSet::new();
        assert_eq!(unique_name(&mut used, "CON", "csv"), "CON_.csv");
        assert_eq!(unique_name(&mut used, "nul", "xlsx"), "nul_.xlsx");
        assert_eq!(
            unique_name(&mut used, "Com1.backup", "csv"),
            "Com1.backup_.csv"
        );
        assert_eq!(unique_name(&mut used, "Console", "csv"), "Console.csv");
        assert_eq!(unique_name(&mut used, "aux ", "d"), "aux_.d");
    }

    #[test]
    fn export_dirs_must_be_new() {
        let tmp = tempfile::tempdir().unwrap();
        let d = export_dir(&tmp.path().join("Export.zip")).unwrap();
        assert!(d.ends_with("Export"));
        std::fs::write(d.join("x"), b"1").unwrap();
        assert!(export_dir(&tmp.path().join("Export")).is_err());
        assert_eq!(dir_size(&d), 1);
    }

    fn temp_store(password: Option<&str>) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = emp_store::StoreOptions::new(dir.path().join("device.key"));
        opts.background_indexing = false;
        let created = Store::create(
            dir.path(),
            emp_store::CreateOptions {
                password: password.map(|p| emp_crypto::SecretString::from(p.to_owned())),
                kdf: emp_crypto::KdfParams::INSECURE_TEST,
                auto_lock: emp_store::model::AutoLock::default(),
                workspace_name: Some("Test".into()),
            },
            opts,
        )
        .unwrap();
        (dir, created.store)
    }

    #[test]
    fn plaintext_exports_of_encrypted_vaults_need_reauth() {
        let pw = "plinth-ocelot-marzipan-quaver-87";
        let (_d, store) = temp_store(Some(pw));
        assert_eq!(
            require_export_reauth(&store).unwrap_err().code,
            crate::error::ErrorCode::ReauthRequired
        );
        store
            .reauth(&emp_crypto::SecretString::from(pw.to_owned()))
            .unwrap();
        assert!(require_export_reauth(&store).is_ok());
        store.close().unwrap();

        let (_d, plain) = temp_store(None);
        assert!(require_export_reauth(&plain).is_ok());
        plain.close().unwrap();
    }

    #[test]
    fn pdf_is_a_known_format() {
        let f: PageFormat = serde_json::from_value(json!("pdf")).unwrap();
        assert_eq!(f, PageFormat::Pdf);
    }
}
