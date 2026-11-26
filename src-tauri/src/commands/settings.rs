//! Settings and kv commands (SPEC §11.3 "Settings and kv").
//!
//! Device settings are readable and writable while locked (they are plaintext and never sensitive). Before a vault
//! exists they live in `<data>/device-settings.json` and move into the vault when it is created.

use std::collections::BTreeMap;

use emp_store::model::{DeviceSettings, SettingsBundle, VaultSettings};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::Empty;
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, blocking};
use crate::validate;

/// Largest settings patch accepted.
pub const MAX_PATCH_BYTES: usize = 64 * 1024;
/// Largest kv value accepted.
pub const MAX_KV_VALUE_BYTES: usize = 256 * 1024;
/// Most keys per `kv_get_many`.
pub const MAX_KV_KEYS: usize = 200;

/// `settings_get({}) → { device, vault? }`.
#[tauri::command]
pub async fn settings_get(app: AppHandle, req: Empty) -> ApiResult<SettingsBundle> {
    let _ = req;
    blocking(move || {
        let state = app.state::<AppState>();
        match state.store_opt() {
            Some(store) => Ok(store.settings_get()?),
            None => Ok(SettingsBundle {
                device: state.pending_device_settings_resolved(),
                vault: None,
            }),
        }
    })
    .await
}

/// A settings patch request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchReq {
    patch: Value,
}

fn check_patch(patch: &Value) -> ApiResult<()> {
    if !patch.is_object() {
        return Err(ApiError::invalid("patch", "must be an object"));
    }
    validate::json_size("patch", patch, MAX_PATCH_BYTES)
}

/// `settings_set_device({ patch }) → DeviceSettings` (works while locked).
#[tauri::command]
pub async fn settings_set_device(app: AppHandle, req: PatchReq) -> ApiResult<DeviceSettings> {
    check_patch(&req.patch)?;
    blocking(move || {
        let state = app.state::<AppState>();
        match state.store_opt() {
            Some(store) => Ok(store.settings_set_device(&req.patch)?),
            None => state.patch_pending_device_settings(&req.patch),
        }
    })
    .await
}

/// `settings_set_vault({ patch }) → VaultSettings`. Applies `offline` to NetGuard immediately.
#[tauri::command]
pub async fn settings_set_vault(app: AppHandle, req: PatchReq) -> ApiResult<VaultSettings> {
    check_patch(&req.patch)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let next = store.settings_set_vault(&req.patch)?;
        state.net.set_offline(next.offline);
        Ok(next)
    })
    .await
}

/// `kv_get` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KvGetReq {
    ns: String,
    key: String,
}

/// `kv_get({ ns: 'ui.*', key }) → unknown | null`.
#[tauri::command]
pub async fn kv_get(app: AppHandle, req: KvGetReq) -> ApiResult<Value> {
    validate::kv_key(&req.ns, &req.key)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(store.kv_get(&req.ns, &req.key)?.unwrap_or(Value::Null))
    })
    .await
}

/// `kv_set` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KvSetReq {
    ns: String,
    key: String,
    value: Value,
}

/// `kv_set({ ns: 'ui.*', key, value })`.
#[tauri::command]
pub async fn kv_set(app: AppHandle, req: KvSetReq) -> ApiResult<()> {
    validate::kv_key(&req.ns, &req.key)?;
    validate::json_size("value", &req.value, MAX_KV_VALUE_BYTES)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(store.kv_set(&req.ns, &req.key, req.value)?)
    })
    .await
}

/// `kv_get_many` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KvGetManyReq {
    ns: String,
    keys: Vec<String>,
}

/// `kv_get_many({ ns: 'ui.*', keys }) → Record<string, unknown>`.
#[tauri::command]
pub async fn kv_get_many(app: AppHandle, req: KvGetManyReq) -> ApiResult<BTreeMap<String, Value>> {
    validate::list_len("keys", req.keys.len(), MAX_KV_KEYS)?;
    for k in &req.keys {
        validate::kv_key(&req.ns, k)?;
    }
    if req.keys.is_empty() {
        validate::kv_key(&req.ns, "_")?;
        return Ok(BTreeMap::new());
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(store.kv_get_many(&req.ns, &req.keys)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_must_be_small_objects() {
        assert!(check_patch(&serde_json::json!({ "theme": "dark" })).is_ok());
        assert!(check_patch(&serde_json::json!([1])).is_err());
        let big = serde_json::json!({ "x": "a".repeat(70_000) });
        assert!(check_patch(&big).is_err());
    }
}
