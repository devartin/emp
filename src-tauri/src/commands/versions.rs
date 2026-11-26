//! Version commands (SPEC §11.3 "Versions", D-24).

use emp_store::model::{VersionMeta, VersionTargetKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::pages::RevDto;
use super::workspaces::IdReq;
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, blocking};
use crate::validate;

/// `version_list` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionListReq {
    target_id: String,
    target_kind: VersionTargetKind,
}

/// `version_list({ targetId, targetKind }) → VersionMeta[]` (newest first).
#[tauri::command]
pub async fn version_list(app: AppHandle, req: VersionListReq) -> ApiResult<Vec<VersionMeta>> {
    validate::id("targetId", &req.target_id)?;
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .version_list(&req.target_id, req.target_kind)?)
    })
    .await
}

/// `version_get` result.
#[derive(Debug, Serialize)]
pub struct VersionSnapshot {
    snapshot: Value,
}

/// `version_get({ id }) → { snapshot }`.
#[tauri::command]
pub async fn version_get(app: AppHandle, req: IdReq) -> ApiResult<VersionSnapshot> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let snapshot = app.state::<AppState>().session()?.version_get(&req.id)?;
        Ok(VersionSnapshot { snapshot })
    })
    .await
}

/// `version_create` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionCreateReq {
    target_id: String,
    target_kind: CreateTarget,
    label: String,
}

/// Targets `version_create` accepts.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateTarget {
    /// A page document.
    PageDoc,
    /// A workbook.
    Workbook,
}

/// `version_create({ targetId, targetKind: 'page_doc'|'workbook', label }) → VersionMeta`.
///
/// Workbook versions are created by the sheets workstream (`sheet_*` commands); here they report `UNSUPPORTED`
/// until the store exposes a manual workbook checkpoint.
#[tauri::command]
pub async fn version_create(app: AppHandle, req: VersionCreateReq) -> ApiResult<VersionMeta> {
    validate::id("targetId", &req.target_id)?;
    validate::non_empty("label", &req.label, validate::MAX_TITLE)?;
    validate::title("label", &req.label)?;
    let kind = match req.target_kind {
        CreateTarget::PageDoc => VersionTargetKind::PageDoc,
        CreateTarget::Workbook => {
            return Err(ApiError::unsupported(
                "Named workbook versions are created from the sheet",
            ));
        }
    };
    blocking(move || {
        Ok(app.state::<AppState>().session()?.version_create(
            &req.target_id,
            kind,
            req.label.trim(),
        )?)
    })
    .await
}

/// `version_restore({ id }) → { rev }` (a `pre_restore` version is saved first).
#[tauri::command]
pub async fn version_restore(app: AppHandle, req: IdReq) -> ApiResult<RevDto> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let rev = app
            .state::<AppState>()
            .session()?
            .version_restore(&req.id)?;
        Ok(RevDto { rev })
    })
    .await
}

/// `version_delete({ id })`.
#[tauri::command]
pub async fn version_delete(app: AppHandle, req: IdReq) -> ApiResult<()> {
    validate::id("id", &req.id)?;
    blocking(move || Ok(app.state::<AppState>().session()?.version_delete(&req.id)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_accepts_page_doc_and_workbook_only() {
        let r = |k: &str| {
            serde_json::from_value::<VersionCreateReq>(serde_json::json!({
                "targetId": "p", "targetKind": k, "label": "v1"
            }))
        };
        assert!(r("page_doc").is_ok());
        assert!(r("workbook").is_ok());
        assert!(r("db_row").is_err());
    }
}
