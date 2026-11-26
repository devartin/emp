//! Workspace commands (SPEC §11.3 "Workspaces").

use emp_store::LifeAppInstance;
use emp_store::model::{Icon, PageMeta, Workspace, WorkspacePatch};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::Empty;
use crate::error::ApiResult;
use crate::state::{AppState, blocking};
use crate::validate;

/// kv namespace and key where the UI stores the last content route (`startPage: 'last'`).
pub const LAST_ROUTE: (&str, &str) = ("ui.nav", "lastRoute");

/// Validates an icon payload (emoji / lucide names / asset ids are bounded).
pub fn check_icon(field: &str, icon: &Icon) -> ApiResult<()> {
    let v = serde_json::to_value(icon).unwrap_or(Value::Null);
    if let Some(s) = v.get("v").and_then(Value::as_str) {
        validate::bounded(field, s, 64)?;
    }
    if let Some(id) = v.get("assetId").and_then(Value::as_str) {
        validate::asset_id(field, id)?;
    }
    Ok(())
}

/// `workspace_list({}) → Workspace[]`.
#[tauri::command]
pub async fn workspace_list(app: AppHandle, req: Empty) -> ApiResult<Vec<Workspace>> {
    let _ = req;
    blocking(move || Ok(app.state::<AppState>().session()?.workspace_list()?)).await
}

/// `workspace_create` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCreateReq {
    name: String,
    #[serde(default)]
    icon: Option<Icon>,
}

/// `workspace_create({ name, icon? }) → Workspace`.
#[tauri::command]
pub async fn workspace_create(app: AppHandle, req: WorkspaceCreateReq) -> ApiResult<Workspace> {
    validate::non_empty("name", &req.name, validate::MAX_TITLE)?;
    validate::title("name", &req.name)?;
    if let Some(i) = &req.icon {
        check_icon("icon", i)?;
    }
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .workspace_create(req.name.trim(), req.icon)?)
    })
    .await
}

/// `workspace_update` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceUpdateReq {
    id: String,
    patch: WorkspacePatch,
}

/// `workspace_update({ id, patch: { name?, icon?, favorites?, defaults? } }) → Workspace`.
#[tauri::command]
pub async fn workspace_update(app: AppHandle, req: WorkspaceUpdateReq) -> ApiResult<Workspace> {
    validate::id("id", &req.id)?;
    if let Some(n) = &req.patch.name {
        validate::non_empty("patch.name", n, validate::MAX_TITLE)?;
        validate::title("patch.name", n)?;
    }
    if let Some(Some(i)) = &req.patch.icon {
        check_icon("patch.icon", i)?;
    }
    if let Some(f) = &req.patch.favorites {
        validate::ids("patch.favorites", f, true)?;
    }
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .workspace_update(&req.id, req.patch)?)
    })
    .await
}

/// `workspace_open` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdReq {
    /// The id.
    pub id: String,
}

/// `workspace_open` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpened {
    workspace: Workspace,
    pages: Vec<PageMeta>,
    recents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_route: Option<Value>,
    lifeapps: Vec<LifeAppInstance>,
}

/// `workspace_open({ id }) → { workspace, pages, recents, lastRoute?, lifeapps }` (`lifeapps`: the life-app
/// instances installed in the workspace, as `lifeapp_instances` lists them).
#[tauri::command]
pub async fn workspace_open(app: AppHandle, req: IdReq) -> ApiResult<WorkspaceOpened> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let opened = store.workspace_open(&req.id)?;
        let last_route = store
            .kv_get(LAST_ROUTE.0, LAST_ROUTE.1)
            .ok()
            .flatten()
            .filter(|v| v.is_object());
        Ok(WorkspaceOpened {
            workspace: opened.workspace,
            pages: opened.pages,
            recents: opened.recents,
            last_route,
            lifeapps: opened.lifeapps,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_are_bounded() {
        let ok: Icon =
            serde_json::from_value(serde_json::json!({ "t": "emoji", "v": "📒" })).unwrap();
        assert!(check_icon("icon", &ok).is_ok());
        let long: Icon =
            serde_json::from_value(serde_json::json!({ "t": "lucide", "v": "x".repeat(100) }))
                .unwrap();
        assert!(check_icon("icon", &long).is_err());
        let bad_asset: Icon =
            serde_json::from_value(serde_json::json!({ "t": "asset", "assetId": "../x" })).unwrap();
        assert!(check_icon("icon", &bad_asset).is_err());
    }
}
