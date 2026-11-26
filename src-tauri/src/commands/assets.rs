//! Asset commands (SPEC §11.3 "Assets", §9.7, §9.15).
//!
//! Bytes never travel as JSON: uploads use a raw-body invoke (`asset_import_bytes`), reads go through the
//! `emp-asset` protocol, and files are referenced only by grants.

use emp_integrations::ConnectorId;
use emp_integrations::netguard::{BodyCap, Expect, NetRequest};
use emp_store::model::AssetDto;
use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_opener::OpenerExt;

use super::job_sink;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::grants::{GrantMode, GrantPurpose};
use crate::jobs::JobRef;
use crate::protocol::percent_decode;
use crate::state::{AppState, blocking};
use crate::validate;

/// Largest raw upload accepted by `asset_import_bytes`.
pub const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
/// Most files per `asset_import_grants`.
pub const MAX_IMPORT_FILES: usize = 100;

/// File extensions EMP never hands to the OS opener (they would run code).
pub const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "app", "appimage", "apk", "bat", "bin", "cmd", "com", "command", "cpl", "deb", "desktop",
    "dll", "dmg", "elf", "exe", "gadget", "hta", "inf", "ins", "jar", "js", "jse", "ksh", "lnk",
    "msc", "msi", "msp", "mst", "pif", "pkg", "ps1", "ps2", "psc1", "psm1", "py", "rb", "reg",
    "rpm", "run", "scf", "scr", "sh", "shb", "so", "url", "vb", "vbe", "vbs", "ws", "wsc", "wsf",
    "wsh", "workflow", "xpi",
];

/// `true` when `name` has an executable extension (case-insensitive).
#[must_use]
pub fn is_executable_name(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .is_some_and(|ext| EXECUTABLE_EXTENSIONS.contains(&ext.as_str()))
}

/// A MIME type of the form `type/subtype` (`[a-z0-9.+-]`), ≤ 128 bytes.
#[must_use]
pub fn is_mime(m: &str) -> bool {
    let Some((t, s)) = m.split_once('/') else {
        return false;
    };
    let ok = |p: &str| {
        !p.is_empty()
            && p.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'+' | b'-')
            })
    };
    m.len() <= 128 && ok(t) && ok(s)
}

/// A display name for an asset fetched from `url`: the last path segment, sanitised, or `image`.
#[must_use]
pub fn name_from_url(url: &url::Url) -> String {
    let seg = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .map(percent_decode)
        .unwrap_or_default();
    let name = super::app::sanitize_file_name(&seg);
    if seg.trim().is_empty() || name == "EMP export" {
        "image".into()
    } else {
        name
    }
}

/// `asset_import_grants` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportGrantsReq {
    grant_ids: Vec<String>,
    workspace_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `asset_import_grants({ grantIds, workspaceId, onEvent })` (job) ⇒ `AssetDTO[]`.
#[tauri::command]
pub async fn asset_import_grants(
    webview: Webview,
    state: State<'_, AppState>,
    req: ImportGrantsReq,
) -> ApiResult<JobRef> {
    validate::id("workspaceId", &req.workspace_id)?;
    if req.grant_ids.is_empty() {
        return Err(ApiError::invalid("grantIds", "must not be empty"));
    }
    validate::list_len("grantIds", req.grant_ids.len(), MAX_IMPORT_FILES)?;
    let store = state.session()?;
    // Redeem every grant up front so a bad one fails the call instead of the job.
    let mut files = Vec::with_capacity(req.grant_ids.len());
    for g in &req.grant_ids {
        files.push(state.grants.take_any(
            g,
            &[GrantPurpose::Attach, GrantPurpose::Image],
            GrantMode::Read,
        )?);
    }
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    let ws = req.workspace_id;
    Ok(state
        .jobs
        .spawn("asset_import_grants", true, now, sink, move |ctx| {
            let total = files.len() as u64;
            let mut out = Vec::with_capacity(files.len());
            for (i, f) in files.iter().enumerate() {
                ctx.check_cancelled()?;
                ctx.report(i as u64, total, Some("files"));
                out.push(store.asset_import_file(&ws, &f.path, "upload")?);
            }
            ctx.report(total, total, Some("files"));
            Ok(out)
        }))
}

fn header<'a>(req: &'a Request<'_>, name: &str) -> ApiResult<&'a str> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::invalid(name, "missing header"))
}

/// `asset_import_bytes(<raw body>; headers: { x-emp-workspace, x-emp-name, x-emp-mime }) → AssetDTO`.
///
/// The one command without a `req` object: the body is the file and the metadata travels in headers (the name is
/// percent-encoded by the frontend).
#[tauri::command]
pub async fn asset_import_bytes(app: AppHandle, request: Request<'_>) -> ApiResult<AssetDto> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(ApiError::invalid("body", "expected a raw binary body"));
    };
    if bytes.is_empty() {
        return Err(ApiError::invalid("body", "the file is empty"));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError::new(ErrorCode::TooLarge, "The file is too large").with_field("body"));
    }
    let workspace = header(&request, "x-emp-workspace")?.to_owned();
    validate::id("x-emp-workspace", &workspace)?;
    let name = percent_decode(header(&request, "x-emp-name")?);
    validate::non_empty("x-emp-name", &name, 255)?;
    let name = super::app::sanitize_file_name(&name);
    let mime = header(&request, "x-emp-mime")?.to_ascii_lowercase();
    let mime = if is_mime(&mime) {
        mime
    } else {
        "application/octet-stream".to_owned()
    };
    let bytes = bytes.clone();
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(store.asset_import_bytes(&workspace, &name, &mime, &bytes)?)
    })
    .await
}

/// `asset_get` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetIdsReq {
    ids: Vec<String>,
}

/// `asset_get({ ids }) → AssetDTO[]`.
#[tauri::command]
pub async fn asset_get(app: AppHandle, req: AssetIdsReq) -> ApiResult<Vec<AssetDto>> {
    validate::list_len("ids", req.ids.len(), validate::MAX_LIST)?;
    for id in &req.ids {
        validate::asset_id("ids", id)?;
    }
    blocking(move || Ok(app.state::<AppState>().session()?.asset_get(&req.ids)?)).await
}

/// An `{ id }` request for an asset.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetIdReq {
    id: String,
}

/// `asset_open_external({ id })`: decrypts to the vault's `tmp/` (wiped on lock) and opens it with the OS. Executables
/// are refused (save them instead).
#[tauri::command]
pub async fn asset_open_external(app: AppHandle, req: AssetIdReq) -> ApiResult<()> {
    validate::asset_id("id", &req.id)?;
    let handle = app.clone();
    let path = blocking(move || {
        let store = handle.state::<AppState>().session()?;
        let meta = store
            .asset_get(std::slice::from_ref(&req.id))?
            .into_iter()
            .next()
            .ok_or_else(|| ApiError::not_found("asset"))?;
        if is_executable_name(&meta.name) {
            return Err(ApiError::unsupported(
                "EMP doesn't open programs. Use Save as… instead.",
            ));
        }
        Ok(store.asset_open_external(&req.id)?)
    })
    .await?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|_| ApiError::new(ErrorCode::Io, "Could not open the file"))
}

/// `asset_save_as` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAsReq {
    id: String,
    grant_id: String,
}

/// `asset_save_as({ id, grantId })`: decrypts the asset to a file chosen with `file_save_grant({ purpose: 'export' })`.
#[tauri::command]
pub async fn asset_save_as(app: AppHandle, req: SaveAsReq) -> ApiResult<()> {
    validate::asset_id("id", &req.id)?;
    validate::grant_id("grantId", &req.grant_id)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let target = state
            .grants
            .take(&req.grant_id, GrantPurpose::Export, GrantMode::Write)?;
        store.asset_save_to(&req.id, &target.path)?;
        Ok(())
    })
    .await
}

/// `asset_import_url` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportUrlReq {
    workspace_id: String,
    url: String,
}

/// Parses a remote-image URL: absolute `https:` only (NetGuard is https-only), no embedded credentials.
pub fn parse_image_url(raw: &str) -> ApiResult<url::Url> {
    validate::bounded("url", raw, validate::MAX_URL)?;
    let u =
        url::Url::parse(raw.trim()).map_err(|_| ApiError::invalid("url", "not a valid link"))?;
    if u.scheme() != "https" {
        return Err(ApiError::invalid("url", "only https images can be loaded"));
    }
    if !u.username().is_empty() || u.password().is_some() || u.host_str().is_none() {
        return Err(ApiError::invalid("url", "not a valid image link"));
    }
    Ok(u)
}

/// `asset_import_url({ workspaceId, url }) → AssetDTO`: the remote image "Load" button (NetGuard user-content
/// policy: public hosts only, 20 MiB cap, image types only).
#[tauri::command]
pub async fn asset_import_url(app: AppHandle, req: ImportUrlReq) -> ApiResult<AssetDto> {
    validate::id("workspaceId", &req.workspace_id)?;
    let url = parse_image_url(&req.url)?;
    let state = app.state::<AppState>();
    let store = state.session()?;
    let settings = blocking({
        let store = store.clone();
        move || Ok(store.vault_settings()?)
    })
    .await?;
    if settings.remote_images == "block" {
        return Err(ApiError::unsupported(
            "Remote images are blocked in Settings",
        ));
    }
    let name = name_from_url(&url);
    let host = url.host_str().unwrap_or_default().to_owned();
    let request = NetRequest::get(ConnectorId::RemoteImage, url, "/{image}")
        .expect(Expect::Image)
        .cap(BodyCap::Image);
    let resp = state.net.send(request).await?;
    state.events.emit(
        crate::events::NET_ACTIVITY,
        crate::events::NetActivity {
            connector: ConnectorId::RemoteImage.as_str().to_owned(),
            host,
        },
    );
    if !resp.is_success() {
        return Err(ApiError::new(
            ErrorCode::Network,
            format!("The image could not be loaded (HTTP {})", resp.status),
        ));
    }
    let mime = resp
        .content_type
        .as_deref()
        .and_then(|c| c.split(';').next())
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|m| is_mime(m) && m.starts_with("image/"))
        .unwrap_or_else(|| "application/octet-stream".into());
    let ws = req.workspace_id;
    blocking(move || {
        Ok(store.asset_import(
            emp_store::model::AssetImport {
                workspace_id: ws,
                name,
                mime,
                len: resp.body.len() as u64,
                source: "remote".into(),
                origin_url: Some(resp.final_url.to_string()),
            },
            resp.body.as_slice(),
        )?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_executables() {
        for n in ["setup.EXE", "run.sh", "x.app", "a.b.ps1", "Installer.dmg"] {
            assert!(is_executable_name(n), "{n}");
        }
        for n in ["photo.png", "report.pdf", "notes", "archive.tar.gz"] {
            assert!(!is_executable_name(n), "{n}");
        }
    }

    #[test]
    fn validates_mime_types() {
        assert!(is_mime("image/png"));
        assert!(is_mime(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ));
        assert!(!is_mime("image"));
        assert!(!is_mime("image/png; charset=x"));
        assert!(!is_mime("Image/PNG"));
    }

    #[test]
    fn image_urls() {
        assert!(parse_image_url("https://example.com/a.png").is_ok());
        assert!(parse_image_url("http://example.com/a.png").is_err());
        assert!(parse_image_url("https://u:p@example.com/a.png").is_err());
        assert!(parse_image_url("file:///etc/passwd").is_err());
        assert!(parse_image_url("data:image/png;base64,AAAA").is_err());
    }

    #[test]
    fn names_from_urls() {
        let u = url::Url::parse("https://e.com/img/caf%C3%A9.png?x=1").unwrap();
        assert_eq!(name_from_url(&u), "café.png");
        let u = url::Url::parse("https://e.com/").unwrap();
        assert_eq!(name_from_url(&u), "image");
    }
}
