//! Settings and kv commands (SPEC §11.3 "Settings and kv").
//!
//! Device settings are readable and writable while locked (they are plaintext and never sensitive). Before a vault
//! exists they live in `<data>/device-settings.json` and move into the vault when it is created.

use std::collections::BTreeMap;

use emp_store::model::{
    DeviceSettings, SettingsBundle, VaultSettings, normalize_locale, region_formats, valid_timezone,
};
use serde::{Deserialize, Serialize};
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

// ───────────────────────────────────────────────────────────────────────────── region detection

/// Store-internal kv entry recording that the region was detected for this vault (never reachable from the webview).
const REGION_NS: &str = "settings.region";
const REGION_KEY: &str = "detected";

/// `settings_detect_region` request. `locale` / `timeZone` are what the webview reports (`navigator.language`,
/// `Intl.DateTimeFormat().resolvedOptions().timeZone`); they are used where the OS gives no answer.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectRegionReq {
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    time_zone: Option<String>,
    /// Save the detected region into the vault settings (once per vault, and only while locale, time zone, week
    /// start and clock still hold the built-in defaults).
    #[serde(default)]
    apply: bool,
}

/// `settings_detect_region` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionInfo {
    /// `ll-CC` locale for number, date and time formats.
    pub locale: String,
    /// IANA time zone.
    pub timezone: String,
    /// `0` Sunday, `1` Monday, `6` Saturday.
    pub week_start: u8,
    /// `12` or `24`.
    pub clock: u8,
    /// `full`, `dmy` or `ymd`.
    pub date_format: String,
    /// The region's currency, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// `true` when this call saved the values into the vault settings.
    pub applied: bool,
}

/// The OS locale for formats on Unix-like systems (`LC_ALL`, `LC_TIME`, `LC_NUMERIC`, `LANG`).
fn env_locale() -> Option<String> {
    ["LC_ALL", "LC_TIME", "LC_NUMERIC", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find_map(|v| normalize_locale(&v))
}

/// The OS time zone (IANA name).
fn os_timezone() -> Option<String> {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|tz| valid_timezone(tz))
}

/// Detects the region: the OS time zone, else the webview's, else UTC; the webview's locale (it follows the OS
/// language on every platform), else the environment, else `en-US`. Week start, clock and currency follow the
/// locale's region.
#[must_use]
pub fn detect_region(
    hint_locale: Option<&str>,
    hint_tz: Option<&str>,
    os_tz: Option<String>,
    env_loc: Option<String>,
) -> RegionInfo {
    let timezone = os_tz
        .or_else(|| hint_tz.filter(|tz| valid_timezone(tz)).map(str::to_owned))
        .unwrap_or_else(|| "UTC".into());
    let locale = hint_locale
        .and_then(normalize_locale)
        .or(env_loc)
        .unwrap_or_else(|| "en-US".into());
    let f = region_formats(&locale);
    RegionInfo {
        locale,
        timezone,
        week_start: f.week_start,
        clock: f.clock,
        date_format: f.date_format.to_owned(),
        currency: f.currency.map(str::to_owned),
        applied: false,
    }
}

/// Writes a detected region into vault settings when they still hold the built-in defaults (`en-US`, `UTC`,
/// Sunday, 12-hour, written-out dates) and the region was never applied to this vault. The currency follows only while it is still the
/// default `USD`. Returns whether anything was written.
pub fn apply_region(store: &emp_store::Store, region: &RegionInfo) -> emp_store::Result<bool> {
    if store.kv_get_any(REGION_NS, REGION_KEY)?.is_some() {
        return Ok(false);
    }
    let current = store.vault_settings()?;
    let mut applied = false;
    if current.region_is_untouched() {
        let mut patch = serde_json::json!({
            "locale": region.locale,
            "timezone": region.timezone,
            "weekStart": region.week_start,
            "clock": region.clock,
            "dateFormat": region.date_format,
        });
        if let Some(c) = &region.currency
            && current.base_currency == "USD"
        {
            patch["baseCurrency"] = Value::String(c.clone());
        }
        store.settings_set_vault(&patch)?;
        applied = true;
    }
    store.kv_set_any(REGION_NS, REGION_KEY, Value::Bool(true), None)?;
    Ok(applied)
}

/// `settings_detect_region({ locale?, timeZone?, apply? }) → RegionInfo`. Works while locked and before a vault
/// exists (first run shows the values); `apply` needs an unlocked vault and saves them once (see [`apply_region`]).
#[tauri::command]
pub async fn settings_detect_region(app: AppHandle, req: DetectRegionReq) -> ApiResult<RegionInfo> {
    if let Some(l) = &req.locale {
        validate::bounded("locale", l, 64)?;
    }
    if let Some(t) = &req.time_zone {
        validate::bounded("timeZone", t, 64)?;
    }
    blocking(move || {
        let mut region = detect_region(
            req.locale.as_deref(),
            req.time_zone.as_deref(),
            os_timezone(),
            env_locale(),
        );
        if req.apply {
            let store = app.state::<AppState>().session()?;
            region.applied = apply_region(&store, &region)?;
        }
        Ok(region)
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
    fn region_detection_prefers_os_zone_and_webview_locale() {
        let r = detect_region(
            Some("de-DE"),
            Some("America/New_York"),
            Some("Europe/Berlin".into()),
            Some("en-US".into()),
        );
        assert_eq!(r.locale, "de-DE");
        assert_eq!(r.timezone, "Europe/Berlin");
        assert_eq!((r.week_start, r.clock), (1, 24));
        assert_eq!(r.date_format, "dmy");
        assert_eq!(r.currency.as_deref(), Some("EUR"));
        // No OS zone: the webview's (if valid), else UTC.
        assert_eq!(
            detect_region(None, Some("Asia/Tokyo"), None, None).timezone,
            "Asia/Tokyo"
        );
        assert_eq!(
            detect_region(None, Some("Not/AZone"), None, None).timezone,
            "UTC"
        );
        // No webview locale: the environment, else en-US.
        assert_eq!(
            detect_region(None, None, None, Some("en-GB".into())).locale,
            "en-GB"
        );
        let us = detect_region(Some("garbage!!"), None, None, None);
        assert_eq!(us.locale, "en-US");
        assert_eq!((us.week_start, us.clock), (0, 12));
        let wire = serde_json::to_value(&us).unwrap();
        assert_eq!(wire["weekStart"], 0);
        assert_eq!(wire["applied"], false);
    }

    #[test]
    fn detect_region_request_shape() {
        let r: DetectRegionReq = serde_json::from_value(serde_json::json!({
            "locale": "fr-FR", "timeZone": "Europe/Paris", "apply": true
        }))
        .unwrap();
        assert!(r.apply);
        assert!(serde_json::from_value::<DetectRegionReq>(serde_json::json!({})).is_ok());
        assert!(
            serde_json::from_value::<DetectRegionReq>(serde_json::json!({ "tz": "x" })).is_err()
        );
    }

    #[test]
    fn patches_must_be_small_objects() {
        assert!(check_patch(&serde_json::json!({ "theme": "dark" })).is_ok());
        assert!(check_patch(&serde_json::json!([1])).is_err());
        let big = serde_json::json!({ "x": "a".repeat(70_000) });
        assert!(check_patch(&big).is_err());
    }
}
