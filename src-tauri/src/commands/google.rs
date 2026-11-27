//! Google and calendar commands (SPEC §9.19, §11.3 "Google and calendars", §17.1).
//!
//! * **Client and accounts.** The OAuth client (Desktop app id + optional secret) is a vault secret with provider
//!   `google-client`; every connected account is a secret with provider `google` holding the refresh token, granted
//!   scopes, e-mail and status. Access tokens live only in memory ([`GoogleSession`] per account, dropped on lock).
//! * **Connect** runs the installed-app flow (loopback listener, PKCE, state) from Rust; the browser is opened with
//!   the system opener. `invalid_grant` marks the account `reauth_required`.
//! * **Calendar.** Selected calendars sync incrementally (sync tokens) into the encrypted kv cache (`gcal.*`);
//!   `calendar_events` reads the cache offline, together with imported ICS calendars and dated database rows shown in
//!   calendar views. `sync:status` reports progress (§11.4).
//! * **Docs / Sheets** import into pages, workbooks or databases and export through `drive.file`.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, NaiveDate, Utc};
use emp_integrations::google::GoogleSession;
use emp_integrations::google::calendar::{GcalCalendar, GcalEvent, list_calendars, sync_events};
use emp_integrations::google::sheets::{ExportCell, ExportSheet};
use emp_integrations::oauth::{ClientCredentials, ConnectOptions, GoogleFeature, GoogleOAuth};
use emp_integrations::{IntegrationError, SecretString};
use emp_store::Store;
use emp_store::model::{PageCreate, PageKind, PageMeta, SecretKind};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_opener::OpenerExt;

use super::ics::CalendarEventDto;
use super::import::cancelled_or;
use super::job_sink;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Secret provider of the OAuth client.
pub const CLIENT_PROVIDER: &str = "google-client";
/// Secret provider of connected accounts.
pub const ACCOUNT_PROVIDER: &str = "google";
/// kv namespace of calendar sync settings and tokens.
pub const SYNC_NS: &str = "gcal.sync";
/// kv namespace of cached events.
pub const EVENTS_NS: &str = "gcal.events";
/// kv namespace of cached calendar lists.
pub const CALENDARS_NS: &str = "gcal.calendars";
/// Sync-link provider for exported docs.
pub const DOCS_LINK: &str = "gdocs";
/// Sync-link provider for exported sheets.
pub const SHEETS_LINK: &str = "gsheets";
/// Events returned by `calendar_events`.
pub const MAX_EVENTS: usize = 10_000;
/// Calendars synced per account.
pub const MAX_CALENDARS: usize = 50;
/// Formula cells read back for a Sheets export (others export as values).
pub const MAX_EXPORT_FORMULAS: usize = 5_000;

fn google_hosts() -> Vec<String> {
    use emp_integrations::netguard::{ConnectorId, HostPolicy};
    match ConnectorId::Google.host_policy() {
        HostPolicy::Exact(h) => h.iter().map(|x| (*x).to_owned()).collect(),
        HostPolicy::AnyPublic => Vec::new(),
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

// ───────────────────────────────────────────────────────────────────────────── client and accounts

/// Stored account data (inside the `google` secret).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountData {
    /// Refresh token.
    #[serde(default)]
    pub refresh_token: String,
    /// Granted scopes.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// E-mail (account label).
    #[serde(default)]
    pub email: String,
    /// OpenID subject.
    #[serde(default)]
    pub subject: String,
    /// Connected at.
    #[serde(default)]
    pub connected_at: i64,
    /// `ok` | `reauth_required`.
    #[serde(default)]
    pub status: String,
}

/// `GoogleAccount` (§11.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAccountDto {
    /// Account id (the secret id).
    pub id: String,
    /// E-mail.
    pub email: String,
    /// Granted scopes.
    pub scopes: Vec<String>,
    /// Connected at.
    pub connected_at: i64,
    /// `ok` | `reauth_required`.
    pub status: String,
}

fn dto(id: &str, d: &AccountData) -> GoogleAccountDto {
    GoogleAccountDto {
        id: id.to_owned(),
        email: d.email.clone(),
        scopes: d.scopes.clone(),
        connected_at: d.connected_at,
        status: if d.status.is_empty() {
            "ok".into()
        } else {
            d.status.clone()
        },
    }
}

fn client(store: &Store) -> ApiResult<Option<ClientCredentials>> {
    let Some(info) = store.secret_find(CLIENT_PROVIDER)?.into_iter().next() else {
        return Ok(None);
    };
    let (data, _) = store.secret_data(&info.id)?;
    let id = data
        .get("clientId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if id.is_empty() {
        return Ok(None);
    }
    Ok(Some(ClientCredentials {
        client_id: id,
        client_secret: data
            .get("clientSecret")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(SecretString::from),
    }))
}

fn accounts(store: &Store) -> ApiResult<Vec<(String, AccountData)>> {
    let mut out = Vec::new();
    for info in store.secret_find(ACCOUNT_PROVIDER)? {
        if info.kind != SecretKind::Oauth {
            continue;
        }
        let (data, _) = store.secret_data(&info.id)?;
        if let Ok(d) = serde_json::from_value::<AccountData>(data) {
            out.push((info.id, d));
        }
    }
    Ok(out)
}

fn account(store: &Store, id: &str) -> ApiResult<AccountData> {
    accounts(store)?
        .into_iter()
        .find(|(i, _)| i == id)
        .map(|(_, d)| d)
        .ok_or_else(|| ApiError::not_found("Google account"))
}

fn save_account(store: &Store, id: Option<&str>, d: &AccountData) -> ApiResult<String> {
    let data = serde_json::to_value(d).map_err(|_| ApiError::internal("account json"))?;
    let label = if d.email.is_empty() {
        "Google account".to_owned()
    } else {
        d.email.clone()
    };
    Ok(store
        .secret_put_json(
            id,
            ACCOUNT_PROVIDER,
            &label,
            SecretKind::Oauth,
            data,
            google_hosts(),
            None,
        )?
        .id)
}

// ───────────────────────────────────────────────────────────────────────────── sessions

/// Account id → (vault id, session).
type Sessions = HashMap<String, (String, Arc<GoogleSession>)>;

static SESSIONS: LazyLock<Mutex<Sessions>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Drops every in-memory access token.
pub fn drop_sessions() {
    SESSIONS.lock().clear();
}

/// The session of `account_id` (built from the stored refresh token).
pub fn session_for(
    state: &AppState,
    store: &Store,
    account_id: &str,
) -> ApiResult<Arc<GoogleSession>> {
    let vault = store.vault_id().to_string();
    if let Some((v, s)) = SESSIONS.lock().get(account_id)
        && *v == vault
    {
        return Ok(Arc::clone(s));
    }
    let creds = client(store)?
        .ok_or_else(|| ApiError::new(ErrorCode::AuthRequired, "Set up Google first"))?;
    let d = account(store, account_id)?;
    if d.status == "reauth_required" || d.refresh_token.is_empty() {
        return Err(ApiError::new(ErrorCode::ReauthRequired, "Reconnect Google"));
    }
    let oauth = GoogleOAuth::new(state.net.clone(), creds);
    let s = Arc::new(GoogleSession::new(
        state.net.clone(),
        oauth,
        SecretString::from(d.refresh_token.clone()),
    ));
    SESSIONS
        .lock()
        .insert(account_id.to_owned(), (vault, Arc::clone(&s)));
    Ok(s)
}

/// Maps an integration error, marking the account `reauth_required` on `invalid_grant`.
pub fn integration_err(app: &AppHandle, account_id: &str, e: IntegrationError) -> ApiError {
    if matches!(e, IntegrationError::ReauthRequired) {
        SESSIONS.lock().remove(account_id);
        let state = app.state::<AppState>();
        if let Ok(store) = state.session_quiet()
            && let Ok(mut d) = account(&store, account_id)
        {
            d.status = "reauth_required".into();
            let _ = save_account(&store, Some(account_id), &d);
        }
        return ApiError::new(ErrorCode::ReauthRequired, "Reconnect Google");
    }
    e.into()
}

fn sync_status(state: &AppState, s: &str, error: Option<String>) {
    state.events.emit(
        crate::events::SYNC_STATUS,
        json!({ "provider": "google", "state": s, "lastSync": now_ms(), "error": error }),
    );
}

async fn session_async(
    app: &AppHandle,
    account_id: &str,
) -> ApiResult<(Store, Arc<GoogleSession>)> {
    let (app2, id) = (app.clone(), account_id.to_owned());
    blocking(move || {
        let state = app2.state::<AppState>();
        // Quiet: scheduled syncs must not count as user activity (the commands already called `session()`).
        let store = state.session_quiet()?;
        let s = session_for(&state, &store, &id)?;
        Ok((store, s))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── status, client, connect

/// `google_status` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    client_configured: bool,
    accounts: Vec<GoogleAccountDto>,
}

/// `google_status({}) → { clientConfigured, accounts }`.
#[tauri::command]
pub async fn google_status(app: AppHandle, req: super::Empty) -> ApiResult<StatusDto> {
    let _ = req;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(StatusDto {
            client_configured: client(&store)?.is_some(),
            accounts: accounts(&store)?.iter().map(|(id, d)| dto(id, d)).collect(),
        })
    })
    .await
}

/// `google_set_client` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClientReq {
    client_id: String,
    #[serde(default)]
    client_secret: Option<emp_crypto::SecretString>,
}

/// Validates a Google OAuth client id (`<digits>-<id>.apps.googleusercontent.com`).
pub fn client_id(field: &str, s: &str) -> ApiResult<()> {
    let s = s.trim();
    let ok = s.len() <= 256
        && s.ends_with(".apps.googleusercontent.com")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'));
    if ok {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "This is not a Google client ID"))
    }
}

/// `google_set_client({ clientId, clientSecret? }) (reauth) → void`: stores the Desktop-app client as a secret.
#[tauri::command]
pub async fn google_set_client(app: AppHandle, req: SetClientReq) -> ApiResult<()> {
    client_id("clientId", &req.client_id)?;
    if let Some(s) = &req.client_secret {
        validate::bounded(
            "clientSecret",
            emp_crypto::ExposeSecret::expose_secret(s),
            256,
        )?;
    }
    blocking(move || {
        let store = app.state::<AppState>().require_reauth()?;
        let existing = store
            .secret_find(CLIENT_PROVIDER)?
            .into_iter()
            .next()
            .map(|i| i.id);
        let secret = req
            .client_secret
            .as_ref()
            .map(|s| emp_crypto::ExposeSecret::expose_secret(s).trim().to_owned())
            .unwrap_or_default();
        store.secret_put_json(
            existing.as_deref(),
            CLIENT_PROVIDER,
            "Google OAuth client",
            SecretKind::Client,
            json!({ "clientId": req.client_id.trim(), "clientSecret": secret }),
            google_hosts(),
            None,
        )?;
        drop_sessions();
        Ok(())
    })
    .await
}

/// `google_connect` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectReq {
    feature: GoogleFeature,
    #[serde(default)]
    account_id: Option<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `google_connect({ feature, accountId?, onEvent }) (reauth)(job) ⇒ GoogleAccount`: opens the consent page in the
/// system browser and waits (≤ 5 min) for the loopback callback. Scopes are requested incrementally per feature.
#[tauri::command]
pub async fn google_connect(
    webview: Webview,
    state: State<'_, AppState>,
    req: ConnectReq,
) -> ApiResult<JobRef> {
    validate::opt_id("accountId", req.account_id.as_deref())?;
    let store = state.require_reauth()?;
    let creds = client(&store)?
        .ok_or_else(|| ApiError::invalid("feature", "Set up the Google client first"))?;
    let existing = match &req.account_id {
        Some(id) => Some(account(&store, id)?),
        None => None,
    };
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    let net = state.net.clone();
    Ok(state
        .jobs
        .spawn("google_connect", true, store.now(), sink, move |ctx| {
            ctx.report(0, 2, Some("Waiting for Google"));
            let mut opts = ConnectOptions::for_feature(req.feature, existing.is_none());
            if let Some(e) = &existing {
                opts.login_hint = Some(e.email.clone()).filter(|x| !x.is_empty());
            }
            let oauth = GoogleOAuth::new(net, creds);
            let opener = app.clone();
            let cancel = ctx.cancel_flag();
            let tokens = tauri::async_runtime::block_on(async move {
                let connect = oauth.connect(&opts, |url| {
                    opener
                        .opener()
                        .open_url(url.as_str(), None::<&str>)
                        .map_err(|_| IntegrationError::Io("could not open the browser".into()))
                });
                tokio::pin!(connect);
                loop {
                    tokio::select! {
                        r = &mut connect => return r,
                        () = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                                return Err(IntegrationError::Cancelled);
                            }
                        }
                    }
                }
            })
            .map_err(|e| cancelled_or(ctx, e.into()))?;
            ctx.report(1, 2, Some("Saving"));
            let identity = tokens.identity.clone();
            let mut d = existing.clone().unwrap_or_default();
            if let Some(rt) = &tokens.refresh_token {
                d.refresh_token = rt.expose().to_owned();
            }
            if d.refresh_token.is_empty() {
                return Err(ApiError::new(
                    ErrorCode::Provider,
                    "Google did not return a refresh token; try again",
                ));
            }
            for s in &tokens.scopes {
                if !d.scopes.contains(s) {
                    d.scopes.push(s.clone());
                }
            }
            if let Some(i) = identity {
                d.subject = i.subject;
                if let Some(e) = i.email {
                    d.email = e;
                }
            }
            if d.connected_at == 0 {
                d.connected_at = now_ms();
            }
            d.status = "ok".into();
            let state = app.state::<AppState>();
            let store = state.session()?;
            // Reconnecting the same Google identity updates its secret instead of adding a duplicate account.
            let same = req.account_id.clone().or_else(|| {
                accounts(&store)
                    .ok()?
                    .into_iter()
                    .find(|(_, a)| !d.subject.is_empty() && a.subject == d.subject)
                    .map(|(id, _)| id)
            });
            let id = save_account(&store, same.as_deref(), &d)?;
            SESSIONS.lock().remove(&id);
            ctx.report(2, 2, Some("Connected"));
            Ok(dto(&id, &d))
        }))
}

/// `google_disconnect` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisconnectReq {
    account_id: String,
    revoke: bool,
    delete_cache: bool,
}

/// `google_disconnect({ accountId, revoke, deleteCache }) → void`: revokes the grant (best effort), deletes the
/// secret and optionally the cached calendar data.
#[tauri::command]
pub async fn google_disconnect(app: AppHandle, req: DisconnectReq) -> ApiResult<()> {
    validate::id("accountId", &req.account_id)?;
    let app2 = app.clone();
    let id = req.account_id.clone();
    let (store, d, creds) = blocking(move || {
        let store = app2.state::<AppState>().session()?;
        let d = account(&store, &id)?;
        let c = client(&store)?;
        Ok((store, d, c))
    })
    .await?;
    if req.revoke
        && let Some(c) = creds
    {
        let oauth = GoogleOAuth::new(app.state::<AppState>().net.clone(), c);
        if let Err(e) = oauth
            .revoke(&SecretString::from(d.refresh_token.clone()))
            .await
        {
            tracing::info!(
                code = e.code().as_str(),
                "Google revoke failed; deleting locally"
            );
        }
    }
    SESSIONS.lock().remove(&req.account_id);
    blocking(move || {
        if req.delete_cache {
            delete_cache(&store, &req.account_id)?;
        }
        store.kv_delete(SYNC_NS, &req.account_id)?;
        store.kv_delete(CALENDARS_NS, &req.account_id)?;
        store.secret_delete(&req.account_id)?;
        Ok(())
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── calendar

/// Sync settings and state of one account.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    /// Selected calendars.
    #[serde(default)]
    pub calendar_ids: Vec<String>,
    /// Interval in minutes.
    #[serde(default = "default_interval")]
    pub interval_min: u32,
    /// Sync token per calendar.
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
    /// Cached chunk count per calendar.
    #[serde(default)]
    pub chunks: BTreeMap<String, usize>,
    /// Last successful sync.
    #[serde(default)]
    pub last_sync: Option<i64>,
}

/// SPEC §17.1: "every 5 minutes (the default) while unlocked".
fn default_interval() -> u32 {
    5
}

fn settings(store: &Store, account_id: &str) -> ApiResult<SyncSettings> {
    Ok(store
        .kv_get_any(SYNC_NS, account_id)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

fn cache_key(account: &str, cal: &str, n: usize) -> String {
    format!("{account}:{cal}:{n}")
}

fn load_cached(
    store: &Store,
    account: &str,
    cal: &str,
    chunks: usize,
) -> ApiResult<Vec<GcalEvent>> {
    let mut out = Vec::new();
    for i in 0..chunks {
        if let Some(Value::Array(items)) =
            store.kv_get_any(EVENTS_NS, &cache_key(account, cal, i))?
        {
            out.extend(
                items
                    .into_iter()
                    .filter_map(|v| serde_json::from_value::<GcalEvent>(v).ok()),
            );
        }
    }
    Ok(out)
}

fn save_cached(
    store: &Store,
    account: &str,
    cal: &str,
    old_chunks: usize,
    events: &[GcalEvent],
) -> ApiResult<usize> {
    let mut chunks: Vec<Value> = Vec::new();
    let mut cur = Vec::new();
    let mut size = 0usize;
    for e in events {
        let v = serde_json::to_value(e).map_err(|_| ApiError::internal("event json"))?;
        let n = v.to_string().len();
        if size + n > super::ics::CHUNK_BYTES && !cur.is_empty() {
            chunks.push(Value::Array(std::mem::take(&mut cur)));
            size = 0;
        }
        size += n + 1;
        cur.push(v);
    }
    if !cur.is_empty() {
        chunks.push(Value::Array(cur));
    }
    for (i, c) in chunks.iter().enumerate() {
        store.kv_set_any(EVENTS_NS, &cache_key(account, cal, i), c.clone(), None)?;
    }
    for i in chunks.len()..old_chunks {
        store.kv_delete(EVENTS_NS, &cache_key(account, cal, i))?;
    }
    Ok(chunks.len())
}

fn delete_cache(store: &Store, account: &str) -> ApiResult<()> {
    let s = settings(store, account)?;
    for (cal, n) in &s.chunks {
        for i in 0..*n {
            store.kv_delete(EVENTS_NS, &cache_key(account, cal, i))?;
        }
    }
    Ok(())
}

fn cached_calendars(store: &Store, account: &str) -> ApiResult<Vec<GcalCalendar>> {
    Ok(store
        .kv_get_any(CALENDARS_NS, account)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

/// An `{ accountId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountReq {
    account_id: String,
}

/// `gcal_calendars({ accountId }) → { id, summary, color, primary, selected }[]` (served from cache when offline).
#[tauri::command]
pub async fn gcal_calendars(app: AppHandle, req: AccountReq) -> ApiResult<Vec<Value>> {
    validate::id("accountId", &req.account_id)?;
    let (store, s) = session_async(&app, &req.account_id).await?;
    let list = match list_calendars(&s).await {
        Ok(l) => {
            let (st, id, l2) = (store.clone(), req.account_id.clone(), l.clone());
            blocking(move || Ok(st.kv_set_any(CALENDARS_NS, &id, json!(l2), None)?)).await?;
            l
        }
        Err(IntegrationError::Offline) => {
            let (st, id) = (store.clone(), req.account_id.clone());
            blocking(move || cached_calendars(&st, &id)).await?
        }
        Err(e) => return Err(integration_err(&app, &req.account_id, e)),
    };
    let (st, id) = (store, req.account_id);
    let sel = blocking(move || settings(&st, &id)).await?;
    Ok(list
        .iter()
        .map(|c| {
            let selected = if sel.calendar_ids.is_empty() { c.selected } else { sel.calendar_ids.contains(&c.id) };
            json!({ "id": c.id, "summary": c.summary, "color": c.color.as_str(), "primary": c.primary, "selected": selected })
        })
        .collect())
}

/// `gcal_set_sync` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSyncReq {
    account_id: String,
    calendar_ids: Vec<String>,
    interval_min: u32,
}

/// `gcal_set_sync({ accountId, calendarIds, intervalMin: 5|15|30|60 }) → void`.
#[tauri::command]
pub async fn gcal_set_sync(app: AppHandle, req: SetSyncReq) -> ApiResult<()> {
    validate::id("accountId", &req.account_id)?;
    if ![5, 15, 30, 60].contains(&req.interval_min) {
        return Err(ApiError::invalid("intervalMin", "must be 5, 15, 30 or 60"));
    }
    validate::list_len("calendarIds", req.calendar_ids.len(), MAX_CALENDARS)?;
    for c in &req.calendar_ids {
        validate::non_empty("calendarIds", c, 512)?;
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        account(&store, &req.account_id)?;
        let mut s = settings(&store, &req.account_id)?;
        for removed in s
            .calendar_ids
            .iter()
            .filter(|c| !req.calendar_ids.contains(c))
        {
            for i in 0..s.chunks.get(removed).copied().unwrap_or(0) {
                store.kv_delete(EVENTS_NS, &cache_key(&req.account_id, removed, i))?;
            }
        }
        s.tokens.retain(|k, _| req.calendar_ids.contains(k));
        s.chunks.retain(|k, _| req.calendar_ids.contains(k));
        s.calendar_ids = req.calendar_ids;
        s.interval_min = req.interval_min;
        store.kv_set_any(SYNC_NS, &req.account_id, json!(s), None)?;
        Ok(())
    })
    .await
}

/// Totals of a sync run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SyncTotals {
    /// New events.
    pub added: usize,
    /// Changed events.
    pub updated: usize,
    /// Removed events.
    pub deleted: usize,
}

/// Merges a sync batch into cached events.
pub fn merge_events(
    cached: Vec<GcalEvent>,
    sync: emp_integrations::google::calendar::EventSync,
    totals: &mut SyncTotals,
) -> Vec<GcalEvent> {
    let mut by_id: BTreeMap<String, GcalEvent> = if sync.full_resync {
        BTreeMap::new()
    } else {
        cached.iter().map(|e| (e.id.clone(), e.clone())).collect()
    };
    let before: BTreeMap<String, GcalEvent> =
        cached.into_iter().map(|e| (e.id.clone(), e)).collect();
    for id in &sync.deleted {
        if by_id.remove(id).is_some() {
            totals.deleted += 1;
        }
    }
    for e in sync.upserts {
        if e.status == emp_integrations::google::calendar::EventStatus::Cancelled {
            if by_id.remove(&e.id).is_some() || before.contains_key(&e.id) {
                totals.deleted += 1;
            }
            continue;
        }
        match before.get(&e.id) {
            Some(old) if *old == e => {}
            Some(_) => totals.updated += 1,
            None => totals.added += 1,
        }
        by_id.insert(e.id.clone(), e);
    }
    if sync.full_resync {
        totals.deleted += before.keys().filter(|k| !by_id.contains_key(*k)).count();
    }
    by_id.into_values().collect()
}

async fn sync_account(app: &AppHandle, account_id: &str, totals: &mut SyncTotals) -> ApiResult<()> {
    let (store, s) = session_async(app, account_id).await?;
    let (st, id) = (store.clone(), account_id.to_owned());
    let mut cfg = blocking(move || settings(&st, &id)).await?;
    if cfg.calendar_ids.is_empty() {
        let cals = list_calendars(&s)
            .await
            .map_err(|e| integration_err(app, account_id, e))?;
        cfg.calendar_ids = cals
            .iter()
            .filter(|c| c.selected || c.primary)
            .map(|c| c.id.clone())
            .take(MAX_CALENDARS)
            .collect();
        let (st, id) = (store.clone(), account_id.to_owned());
        blocking(move || Ok(st.kv_set_any(CALENDARS_NS, &id, json!(cals), None)?)).await?;
    }
    for cal in cfg.calendar_ids.clone() {
        let token = cfg.tokens.get(&cal).cloned();
        let sync = sync_events(&s, &cal, token.as_deref(), Utc::now())
            .await
            .map_err(|e| integration_err(app, account_id, e))?;
        let next = sync.next_sync_token.clone();
        let old = cfg.chunks.get(&cal).copied().unwrap_or(0);
        let (st, id, c) = (store.clone(), account_id.to_owned(), cal.clone());
        let cached = blocking(move || load_cached(&st, &id, &c, old)).await?;
        let merged = merge_events(cached, sync, totals);
        let (st, id, c) = (store.clone(), account_id.to_owned(), cal.clone());
        let n = blocking(move || save_cached(&st, &id, &c, old, &merged)).await?;
        cfg.chunks.insert(cal.clone(), n);
        match next {
            Some(t) => {
                cfg.tokens.insert(cal, t);
            }
            None => {
                cfg.tokens.remove(&cal);
            }
        }
    }
    cfg.last_sync = Some(now_ms());
    let (st, id) = (store, account_id.to_owned());
    blocking(move || Ok(st.kv_set_any(SYNC_NS, &id, json!(cfg), None)?)).await
}

// ───────────────────────────────────────────────────────────────────────────── scheduled sync

/// A nudge (window focus regained, unlock after sleep) syncs accounts last synced longer ago than this.
pub const NUDGE_MIN_AGE_MS: i64 = 60_000;

static SCHEDULED_RUNNING: AtomicBool = AtomicBool::new(false);

/// Whether a connected account can read calendars.
#[must_use]
pub fn has_calendar_scope(scopes: &[String]) -> bool {
    scopes.iter().any(|s| {
        s == emp_integrations::oauth::scopes::CALENDAR_READONLY
            || s == emp_integrations::oauth::scopes::CALENDAR_EVENTS
            || s == "https://www.googleapis.com/auth/calendar"
    })
}

/// Whether a calendar sync is due: never synced, or the interval (with `nudge`: at most [`NUDGE_MIN_AGE_MS`])
/// elapsed since the last one.
#[must_use]
pub fn sync_due(last_sync: Option<i64>, interval_min: u32, now_ms: i64, nudge: bool) -> bool {
    let interval = i64::from(interval_min.max(1)) * 60_000;
    let needed = if nudge {
        interval.min(NUDGE_MIN_AGE_MS)
    } else {
        interval
    };
    last_sync.is_none_or(|t| now_ms.saturating_sub(t) >= needed)
}

/// Accounts with a calendar sync due (connected, calendar scope granted, not awaiting re-consent).
fn due_accounts(store: &Store, now: i64, nudge: bool) -> ApiResult<Vec<String>> {
    let mut out = Vec::new();
    for (id, d) in accounts(store)? {
        if d.status == "reauth_required" || !has_calendar_scope(&d.scopes) {
            continue;
        }
        let cfg = settings(store, &id)?;
        if sync_due(cfg.last_sync, cfg.interval_min, now, nudge) {
            out.push(id);
        }
    }
    Ok(out)
}

/// The scheduled Google Calendar sync (SPEC §17.1 "When it syncs"): every account whose `intervalMin` elapsed, or
/// with `nudge` (window focus regained, unlock) whose last sync is older than a minute. Runs in the background,
/// one pass at a time; skipped while locked or offline. Reports `sync:status` like `gcal_sync_now`.
pub fn scheduled_sync(app: &AppHandle, nudge: bool) {
    if SCHEDULED_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let app2 = app.clone();
        let due = blocking(move || {
            let state = app2.state::<AppState>();
            let store = state.session_quiet()?;
            if state.net.is_offline() || client(&store)?.is_none() {
                return Ok(Vec::new());
            }
            due_accounts(&store, now_ms(), nudge)
        })
        .await
        .unwrap_or_default();
        if !due.is_empty() {
            let state = app.state::<AppState>();
            sync_status(&state, "syncing", None);
            let mut totals = SyncTotals::default();
            let mut error = None;
            for id in &due {
                if let Err(e) = sync_account(&app, id, &mut totals).await {
                    if e.code == ErrorCode::Locked {
                        error = None;
                        break;
                    }
                    tracing::info!(code = e.code.as_str(), "scheduled calendar sync failed");
                    error = Some(e.message);
                }
            }
            match error {
                Some(m) => sync_status(&state, "error", Some(m)),
                None => sync_status(&state, "idle", None),
            }
        }
        SCHEDULED_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// `gcal_sync_now` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncNowReq {
    #[serde(default)]
    account_id: Option<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `gcal_sync_now({ accountId?, onEvent })` (job) ⇒ `{ added, updated, deleted }` (every account when omitted).
#[tauri::command]
pub async fn gcal_sync_now(
    webview: Webview,
    state: State<'_, AppState>,
    req: SyncNowReq,
) -> ApiResult<JobRef> {
    validate::opt_id("accountId", req.account_id.as_deref())?;
    let store = state.session()?;
    let ids: Vec<String> = match &req.account_id {
        Some(id) => vec![id.clone()],
        None => accounts(&store)?
            .into_iter()
            .filter(|(_, d)| d.status != "reauth_required")
            .map(|(id, _)| id)
            .collect(),
    };
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("gcal_sync_now", true, store.now(), sink, move |ctx| {
            let st = app.state::<AppState>();
            sync_status(&st, "syncing", None);
            let mut totals = SyncTotals::default();
            let n = ids.len() as u64;
            for (i, id) in ids.iter().enumerate() {
                ctx.check_cancelled()?;
                ctx.report(i as u64, n, Some("Syncing"));
                if let Err(e) = tauri::async_runtime::block_on(sync_account(&app, id, &mut totals))
                {
                    sync_status(&st, "error", Some(e.message.clone()));
                    return Err(e);
                }
            }
            ctx.report(n, n, Some("Done"));
            sync_status(&st, "idle", None);
            Ok(totals)
        }))
}

// ───────────────────────────────────────────────────────────────────────────── calendar_events

/// Event sources.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Google Calendar cache.
    Google,
    /// Imported ICS calendars.
    Ics,
    /// Dated database rows (calendar views).
    Db,
}

/// `calendar_events` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventsReq {
    from: String,
    to: String,
    #[serde(default)]
    sources: Option<Vec<Source>>,
}

fn parse_bound(field: &str, s: &str, end: bool) -> ApiResult<DateTime<Utc>> {
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let t = if end {
            d.and_hms_opt(23, 59, 59)
        } else {
            d.and_hms_opt(0, 0, 0)
        };
        return t
            .map(|t| t.and_utc())
            .ok_or_else(|| ApiError::invalid(field, "invalid date"));
    }
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| ApiError::invalid(field, "must be a date or RFC 3339 time"))
}

fn event_bounds(start: &str, end: &str) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let s = parse_bound("start", start, false).ok()?;
    let e = parse_bound("end", end, true).ok().unwrap_or(s);
    Some((s, e))
}

/// Google events of every account overlapping `[from, to]` from the cache.
pub fn google_events(
    store: &Store,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> ApiResult<Vec<CalendarEventDto>> {
    let mut out = Vec::new();
    for (id, _) in accounts(store)? {
        let cfg = settings(store, &id)?;
        let colors: HashMap<String, emp_integrations::google::convert::BlockColor> =
            cached_calendars(store, &id)?
                .into_iter()
                .map(|c| (c.id, c.color))
                .collect();
        for cal in &cfg.calendar_ids {
            let color = colors
                .get(cal)
                .copied()
                .unwrap_or(emp_integrations::google::convert::BlockColor::Blue);
            for e in load_cached(store, &id, cal, cfg.chunks.get(cal).copied().unwrap_or(0))? {
                let d = e.to_dto(color);
                let Some((s, en)) = event_bounds(&d.start, &d.end) else {
                    continue;
                };
                if en < from || s > to {
                    continue;
                }
                out.push(CalendarEventDto {
                    id: d.id,
                    source: d.source,
                    calendar_id: d.calendar_id,
                    title: d.title,
                    start: d.start,
                    end: d.end,
                    all_day: d.all_day,
                    tz: d.tz,
                    location: d.location,
                    description: d.description,
                    color: d.color,
                    recurring: d.recurring,
                    link: None,
                });
            }
        }
    }
    Ok(out)
}

/// Dated rows of every database with a calendar view, overlapping `[from, to]` (≤ 400 days).
pub fn db_events(
    store: &Store,
    from: NaiveDate,
    to: NaiveDate,
) -> ApiResult<Vec<CalendarEventDto>> {
    let mut out = Vec::new();
    let (f, t) = (from.to_string(), to.to_string());
    for ws in store.workspace_list()? {
        for meta in store.db_list(&ws.id)? {
            let Ok(schema) = store.db_get_schema(&meta.id) else {
                continue;
            };
            let Some(view) = schema.views.iter().find(|v| v.calendar.is_some()) else {
                continue;
            };
            let Some(cal) = &view.calendar else { continue };
            let Ok(rows) = store.db_query_range(&meta.id, &view.id, &cal.date_prop, &f, &t) else {
                continue;
            };
            for r in rows {
                let Some(emp_store::dbmodel::CellValue::Date { v: Some(d) }) =
                    r.values.get(&cal.date_prop)
                else {
                    continue;
                };
                let title = super::finance::text(r.values.get(&schema.database.primary_prop_id));
                out.push(CalendarEventDto {
                    id: r.id.clone(),
                    source: "db".into(),
                    calendar_id: meta.id.clone(),
                    title: if title.trim().is_empty() {
                        "Untitled".into()
                    } else {
                        title
                    },
                    start: d.start.clone(),
                    end: d.end.clone().unwrap_or_else(|| d.start.clone()),
                    all_day: !d.time,
                    tz: d.tz.clone(),
                    location: None,
                    description: None,
                    color: "gray".into(),
                    recurring: false,
                    link: Some(json!({ "t": "row", "id": r.id })),
                });
                if out.len() >= MAX_EVENTS {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

/// `calendar_events({ from, to, sources? }) → CalendarEvent[]` from local caches only (works offline).
#[tauri::command]
pub async fn calendar_events(app: AppHandle, req: EventsReq) -> ApiResult<Vec<CalendarEventDto>> {
    let from = parse_bound("from", &req.from, false)?;
    let to = parse_bound("to", &req.to, true)?;
    if to < from || (to - from).num_days() > 400 {
        return Err(ApiError::invalid("to", "ranges are limited to 400 days"));
    }
    let sources = req
        .sources
        .unwrap_or_else(|| vec![Source::Google, Source::Ics, Source::Db]);
    validate::list_len("sources", sources.len(), 3)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let mut out = Vec::new();
        if sources.contains(&Source::Google) {
            out.extend(google_events(&store, from, to)?);
        }
        if sources.contains(&Source::Ics) {
            out.extend(super::ics::local_events(&store, from, to, MAX_EVENTS)?);
        }
        if sources.contains(&Source::Db) {
            out.extend(db_events(&store, from.date_naive(), to.date_naive())?);
        }
        out.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.title.cmp(&b.title)));
        out.truncate(MAX_EVENTS);
        Ok(out)
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── Docs

/// `gdocs_import` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocsImportReq {
    account_id: String,
    url: String,
    workspace_id: String,
    parent_id: Option<String>,
    on_event: tauri::ipc::JavaScriptChannelId,
}

fn google_url(field: &str, url: &str, host: &str) -> ApiResult<()> {
    validate::non_empty(field, url, validate::MAX_URL)?;
    let u = url::Url::parse(url.trim()).map_err(|_| ApiError::invalid(field, "invalid URL"))?;
    if u.scheme() != "https" || u.host_str() != Some(host) {
        return Err(ApiError::invalid(
            field,
            format!("must be a https://{host}/ link"),
        ));
    }
    Ok(())
}

struct NoResolve;
impl emp_store::import::markdown::Resolve for NoResolve {}

/// `gdocs_import({ accountId, url, workspaceId, parentId, onEvent })` (job) ⇒ `{ page, warnings }`.
#[tauri::command]
pub async fn gdocs_import(
    webview: Webview,
    state: State<'_, AppState>,
    req: DocsImportReq,
) -> ApiResult<JobRef> {
    validate::id("accountId", &req.account_id)?;
    google_url("url", &req.url, "docs.google.com")?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    let store = state.session()?;
    let s = session_for(&state, &store, &req.account_id)?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("gdocs_import", true, store.now(), sink, move |ctx| {
            ctx.report(0, 2, Some("Downloading"));
            let doc = tauri::async_runtime::block_on(
                emp_integrations::google::docs::import_document(&s, &req.url),
            )
            .map_err(|e| integration_err(&app, &req.account_id, e))?;
            ctx.check_cancelled()?;
            ctx.report(1, 2, Some("Converting"));
            let conv = crate::jobs::catch_panics(|| {
                emp_store::import::html::convert(&doc.content, &mut NoResolve)
            })
            .map_err(|_| ApiError::invalid("url", "This document could not be converted"))??;
            let mut warnings = doc.warnings;
            warnings.extend(
                conv.unsupported
                    .iter()
                    .map(|u| format!("Converted approximately: {u}")),
            );
            let title: String = conv
                .title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| doc.file.name.clone())
                .chars()
                .filter(|c| !c.is_control())
                .take(validate::MAX_TITLE)
                .collect();
            let created = store.page_create(PageCreate {
                workspace_id: req.workspace_id.clone(),
                parent_id: req.parent_id.clone(),
                kind: PageKind::Doc,
                title: Some(title),
                icon: None,
                after_id: None,
                template_page_id: None,
                doc: Some(conv.doc),
                flags: None,
            })?;
            ctx.report(2, 2, Some("Done"));
            Ok(json!({ "page": created.meta, "warnings": warnings }))
        }))
}

/// `gdocs_export` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocsExportReq {
    account_id: String,
    page_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

struct TitleResolver(HashMap<String, String>);
impl emp_store::doc::PageResolver for TitleResolver {
    fn title(&self, page_id: &str) -> Option<String> {
        self.0.get(page_id).cloned()
    }
}

/// `gdocs_export({ accountId, pageId, onEvent })` (job) ⇒ `{ fileId, webViewLink }` ("Export again" updates the same
/// file through its sync link).
#[tauri::command]
pub async fn gdocs_export(
    webview: Webview,
    state: State<'_, AppState>,
    req: DocsExportReq,
) -> ApiResult<JobRef> {
    validate::id("accountId", &req.account_id)?;
    validate::id("pageId", &req.page_id)?;
    let store = state.session()?;
    let s = session_for(&state, &store, &req.account_id)?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("gdocs_export", true, store.now(), sink, move |ctx| {
            ctx.report(0, 2, Some("Preparing"));
            let page = store.page_get(&req.page_id)?;
            let doc = page
                .doc
                .ok_or_else(|| ApiError::invalid("pageId", "This page has no document"))?;
            let titles: HashMap<String, String> = store
                .page_tree(&page.meta.workspace_id)?
                .into_iter()
                .map(|m| (m.id, m.title))
                .collect();
            let html = emp_store::doc::html::to_html(&doc, &TitleResolver(titles));
            let link = store
                .sync_links_for_local(&req.page_id)?
                .into_iter()
                .find(|l| l.provider == DOCS_LINK);
            ctx.check_cancelled()?;
            ctx.report(1, 2, Some("Uploading"));
            let (file, _) =
                tauri::async_runtime::block_on(emp_integrations::google::docs::export_document(
                    &s,
                    &page.meta.title,
                    &html,
                    link.as_ref().map(|l| l.remote_id.as_str()),
                ))
                .map_err(|e| integration_err(&app, &req.account_id, e))?;
            record_link(
                &store,
                DOCS_LINK,
                &req.page_id,
                &file.file_id,
                &req.account_id,
                link.as_ref(),
            )?;
            ctx.report(2, 2, Some("Done"));
            Ok(json!({ "fileId": file.file_id, "webViewLink": file.web_view_link }))
        }))
}

fn record_link(
    store: &Store,
    provider: &str,
    local: &str,
    remote: &str,
    account: &str,
    existing: Option<&emp_store::repo::sync_links::SyncLink>,
) -> ApiResult<()> {
    let link = emp_store::repo::sync_links::SyncLink {
        id: existing.map(|l| l.id.clone()).unwrap_or_default(),
        provider: provider.to_owned(),
        local_id: local.to_owned(),
        remote_id: remote.to_owned(),
        etag: None,
        account_id: Some(account.to_owned()),
        last_synced_rev: existing.map_or(0, |l| l.last_synced_rev),
        updated_at: now_ms(),
    };
    store.sync_link_upsert(provider, local, link)?;
    Ok(())
}

// ───────────────────────────────────────────────────────────────────────────── Sheets

/// `gsheets_import` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetsImportReq {
    account_id: String,
    url: String,
    workspace_id: String,
    parent_id: Option<String>,
    as_database: bool,
    on_event: tauri::ipc::JavaScriptChannelId,
}

fn imported_input(c: &emp_integrations::google::sheets::ImportedCell) -> Option<String> {
    use emp_integrations::google::sheets::CellValue as G;
    if let Some(f) = &c.formula
        && f.is_supported()
    {
        let t = f.text.trim();
        return Some(if t.starts_with('=') {
            t.to_owned()
        } else {
            format!("={t}")
        });
    }
    match &c.value {
        G::Empty => None,
        G::Bool(b) => Some(if *b { "TRUE".into() } else { "FALSE".into() }),
        G::Number(n) => n.is_finite().then(|| n.to_string()),
        // Text that would parse as a formula or number stays text.
        G::Text(t) if t.starts_with(['=', '+', '-', '@']) => Some(format!("'{t}")),
        G::Text(t) => Some(t.clone()),
    }
}

fn imported_text(c: &emp_integrations::google::sheets::ImportedCell) -> String {
    use emp_integrations::google::sheets::CellValue as G;
    match &c.value {
        G::Empty => String::new(),
        G::Bool(b) => b.to_string(),
        G::Number(n) => n.to_string(),
        G::Text(t) => t.clone(),
    }
}

/// CSV with quoting of every field that needs it.
#[must_use]
pub fn to_csv(rows: &[Vec<String>]) -> String {
    let mut out = String::new();
    for r in rows {
        let line: Vec<String> = r
            .iter()
            .map(|f| {
                if f.contains([',', '"', '\n', '\r']) {
                    format!("\"{}\"", f.replace('"', "\"\""))
                } else {
                    f.clone()
                }
            })
            .collect();
        out.push_str(&line.join(","));
        out.push_str("\r\n");
    }
    out
}

/// `gsheets_import({ accountId, url, workspaceId, parentId, asDatabase, onEvent })` (job) ⇒ `{ page, warnings }`:
/// a workbook with every sheet (supported formulas are mapped; others import as values) or, with `asDatabase`, the
/// first sheet as a database.
#[tauri::command]
pub async fn gsheets_import(
    webview: Webview,
    state: State<'_, AppState>,
    req: SheetsImportReq,
) -> ApiResult<JobRef> {
    validate::id("accountId", &req.account_id)?;
    google_url("url", &req.url, "docs.google.com")?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    let store = state.session()?;
    let s = session_for(&state, &store, &req.account_id)?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("gsheets_import", true, store.now(), sink, move |ctx| {
            ctx.report(0, 3, Some("Downloading"));
            let sp = tauri::async_runtime::block_on(
                emp_integrations::google::sheets::import_spreadsheet(
                    &s,
                    &req.url,
                    emp_integrations::google::sheets::DEFAULT_MAX_CELLS,
                ),
            )
            .map_err(|e| integration_err(&app, &req.account_id, e))?;
            ctx.check_cancelled()?;
            let mut warnings = sp.warnings.clone();
            let title: String = sp
                .meta
                .title
                .chars()
                .filter(|c| !c.is_control())
                .take(validate::MAX_TITLE)
                .collect();
            let title = if title.trim().is_empty() {
                "Imported sheet".to_owned()
            } else {
                title
            };
            ctx.report(1, 3, Some("Creating"));
            if req.as_database {
                let first = sp
                    .sheets
                    .first()
                    .ok_or_else(|| ApiError::invalid("url", "This spreadsheet is empty"))?;
                let rows: Vec<Vec<String>> = first
                    .rows
                    .iter()
                    .map(|r| r.iter().map(imported_text).collect())
                    .collect();
                let (page, w) = store
                    .sheet_import_file(
                        &format!("{title}.csv"),
                        to_csv(&rows).as_bytes(),
                        &req.workspace_id,
                        req.parent_id.as_deref(),
                        true,
                        ctx,
                    )
                    .map_err(|e| cancelled_or(ctx, e.into()))?;
                warnings.extend(w);
                if sp.sheets.len() > 1 {
                    warnings.push("Only the first sheet was imported as a database.".into());
                }
                ctx.report(3, 3, Some("Done"));
                return Ok(json!({ "page": page, "warnings": warnings }));
            }
            super::market::ensure_sheet_host(&app, &store);
            let created = store.sheet_workbook_create(
                &req.workspace_id,
                req.parent_id.as_deref(),
                &title,
                None,
            )?;
            let mut sheet_ids: Vec<String> = created.sheets.iter().map(|m| m.id.clone()).collect();
            let n = sp.sheets.len() as u64;
            for (i, sh) in sp.sheets.iter().enumerate() {
                ctx.check_cancelled()?;
                ctx.report(1 + i as u64 / n.max(1), 3, Some("Filling sheets"));
                let name: String = super::sheet::sheet_name("name", &sh.meta.title)
                    .map(|()| sh.meta.title.clone())
                    .unwrap_or_else(|_| format!("Sheet{}", i + 1));
                let sid = if i == 0 {
                    let id = sheet_ids
                        .first()
                        .cloned()
                        .ok_or_else(|| ApiError::internal("workbook has no sheet"))?;
                    let _ = store.sheet_update(
                        &id,
                        serde_json::from_value(json!({ "name": name }))
                            .map_err(|_| ApiError::internal("patch"))?,
                    );
                    id
                } else {
                    let m = store.sheet_add(
                        &created.page.id,
                        Some(&name),
                        sheet_ids.last().map(String::as_str),
                    )?;
                    sheet_ids.push(m.id.clone());
                    m.id
                };
                let mut edits = Vec::new();
                for (r, row) in sh.rows.iter().enumerate() {
                    for (c, cell) in row.iter().enumerate() {
                        if let Some(input) = imported_input(cell)
                            && let (Ok(row), Ok(col)) = (u32::try_from(r), u32::try_from(c))
                        {
                            edits.push(emp_sheets::CellEdit {
                                row,
                                col,
                                input: Some(input),
                            });
                        }
                        if let Some(f) = &cell.formula
                            && !f.is_supported()
                        {
                            warnings.push(format!(
                                "{}: a formula was imported as its value",
                                sh.meta.title
                            ));
                        }
                    }
                }
                for chunk in edits.chunks(50_000) {
                    store.sheet_set_cells(
                        &sid,
                        chunk.to_vec(),
                        emp_sheets::Rect::default(),
                        None,
                    )?;
                }
            }
            warnings.sort();
            warnings.dedup();
            ctx.report(3, 3, Some("Done"));
            Ok(json!({ "page": created.page, "warnings": warnings }))
        }))
}

/// `gsheets_export.source`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum SheetsSource {
    /// A workbook.
    #[serde(rename_all = "camelCase")]
    Workbook {
        /// Workbook.
        workbook_id: String,
    },
    /// A database (optionally through a view).
    #[serde(rename_all = "camelCase")]
    Database {
        /// Database.
        database_id: String,
        /// View.
        #[serde(default)]
        view_id: Option<String>,
    },
}

/// `gsheets_export` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetsExportReq {
    account_id: String,
    source: SheetsSource,
    on_event: tauri::ipc::JavaScriptChannelId,
}

fn text_cell(s: &str) -> ExportCell {
    if s.is_empty() {
        ExportCell::Empty
    } else if let Ok(n) = s.trim().parse::<f64>() {
        if n.is_finite() {
            ExportCell::Number(n)
        } else {
            ExportCell::Text(s.to_owned())
        }
    } else {
        ExportCell::Text(s.to_owned())
    }
}

fn workbook_sheets(store: &Store, workbook_id: &str) -> ApiResult<Vec<ExportSheet>> {
    let wb = store.sheet_workbook_get(workbook_id)?;
    let mut out = Vec::new();
    let mut formulas = 0usize;
    for m in wb.sheets.iter().filter(|m| !m.hidden) {
        let (rows, cols) = (m.max_row + 1, m.max_col + 1);
        let mut grid = vec![vec![ExportCell::Empty; cols as usize]; rows as usize];
        let band = (1_000_000 / cols.max(1)).max(1);
        let mut r0 = 0;
        while r0 < rows {
            let r1 = (r0 + band - 1).min(rows - 1);
            let range = store.sheet_get_range(
                &m.id,
                emp_sheets::Rect {
                    r0,
                    c0: 0,
                    r1,
                    c1: cols - 1,
                },
            )?;
            let p = &range.data.cells;
            for i in 0..p.r.len() {
                let (r, c) = (p.r[i] as usize, p.c[i] as usize);
                let Some(slot) = grid.get_mut(r).and_then(|row| row.get_mut(c)) else {
                    continue;
                };
                let d = p.d.get(i).cloned().unwrap_or_default();
                *slot = if p.f.get(i) == Some(&1) && formulas < MAX_EXPORT_FORMULAS {
                    formulas += 1;
                    match store.sheet_get_cell(&m.id, p.r[i], p.c[i]) {
                        Ok(info) if info.input.starts_with('=') => ExportCell::Formula(info.input),
                        _ => text_cell(&d),
                    }
                } else {
                    match p.k.get(i) {
                        Some(1) => text_cell(&d),
                        Some(3) => ExportCell::Bool(d.eq_ignore_ascii_case("true")),
                        Some(0) | None => ExportCell::Empty,
                        _ => ExportCell::Text(d),
                    }
                };
            }
            r0 = r1 + 1;
        }
        out.push(ExportSheet {
            title: m.name.clone(),
            rows: grid,
            frozen_rows: m.frozen.rows,
            ..ExportSheet::default()
        });
    }
    Ok(out)
}

/// `gsheets_export({ accountId, source: { workbookId } | { databaseId, viewId? }, onEvent })` (job)
/// ⇒ `{ fileId, webViewLink }` (a new spreadsheet in the user's Drive, scope `drive.file`).
#[tauri::command]
pub async fn gsheets_export(
    webview: Webview,
    state: State<'_, AppState>,
    req: SheetsExportReq,
) -> ApiResult<JobRef> {
    validate::id("accountId", &req.account_id)?;
    match &req.source {
        SheetsSource::Workbook { workbook_id } => validate::id("source.workbookId", workbook_id)?,
        SheetsSource::Database {
            database_id,
            view_id,
        } => {
            validate::id("source.databaseId", database_id)?;
            validate::opt_id("source.viewId", view_id.as_deref())?;
        }
    }
    let store = state.session()?;
    let s = session_for(&state, &store, &req.account_id)?;
    let sink = job_sink(&webview, &req.on_event);
    let app = webview.app_handle().clone();
    Ok(state
        .jobs
        .spawn("gsheets_export", true, store.now(), sink, move |ctx| {
            ctx.report(0, 2, Some("Preparing"));
            let (title, local, sheets) = match &req.source {
                SheetsSource::Workbook { workbook_id } => {
                    super::market::ensure_sheet_host(&app, &store);
                    let meta: PageMeta = store
                        .page_get_meta(std::slice::from_ref(workbook_id))?
                        .into_iter()
                        .next()
                        .ok_or_else(|| ApiError::not_found("workbook"))?;
                    (
                        meta.title,
                        workbook_id.clone(),
                        workbook_sheets(&store, workbook_id)?,
                    )
                }
                SheetsSource::Database {
                    database_id,
                    view_id,
                } => {
                    let schema = store.db_get_schema(database_id)?;
                    let rows = store.db_export_table(database_id, view_id.as_deref())?;
                    let grid = rows
                        .iter()
                        .enumerate()
                        .map(|(i, r)| {
                            r.iter()
                                .map(|c| {
                                    if i == 0 {
                                        ExportCell::Text(c.clone())
                                    } else {
                                        text_cell(c)
                                    }
                                })
                                .collect()
                        })
                        .collect();
                    let sheet = ExportSheet {
                        title: schema.database.title.clone(),
                        rows: grid,
                        bold_header: true,
                        frozen_rows: 1,
                        ..ExportSheet::default()
                    };
                    (
                        schema.database.title.clone(),
                        database_id.clone(),
                        vec![sheet],
                    )
                }
            };
            ctx.check_cancelled()?;
            ctx.report(1, 2, Some("Uploading"));
            let file = tauri::async_runtime::block_on(
                emp_integrations::google::sheets::export_spreadsheet(&s, &title, sheets),
            )
            .map_err(|e| integration_err(&app, &req.account_id, e))?;
            let existing = store
                .sync_links_for_local(&local)?
                .into_iter()
                .find(|l| l.provider == SHEETS_LINK);
            record_link(
                &store,
                SHEETS_LINK,
                &local,
                &file.file_id,
                &req.account_id,
                existing.as_ref(),
            )?;
            ctx.report(2, 2, Some("Done"));
            Ok(json!({ "fileId": file.file_id, "webViewLink": file.web_view_link }))
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_sync_is_due_by_interval_or_nudge() {
        let now = 10_000_000;
        assert!(sync_due(None, 15, now, false));
        assert!(!sync_due(Some(now - 4 * 60_000), 5, now, false));
        assert!(sync_due(Some(now - 5 * 60_000), 5, now, false));
        // A nudge syncs anything older than a minute, but never more often.
        assert!(sync_due(Some(now - 2 * 60_000), 30, now, true));
        assert!(!sync_due(Some(now - 30_000), 30, now, true));
        assert!(!sync_due(Some(now - 2 * 60_000), 30, now, false));
        assert_eq!(default_interval(), 5);
    }

    #[test]
    fn calendar_scope_is_required() {
        assert!(has_calendar_scope(&[
            "openid".into(),
            emp_integrations::oauth::scopes::CALENDAR_READONLY.into()
        ]));
        assert!(!has_calendar_scope(&[
            "https://www.googleapis.com/auth/drive.file".into()
        ]));
    }
    use emp_integrations::google::calendar::{EventStatus, EventSync, EventTime};

    fn ev(id: &str, title: &str) -> GcalEvent {
        GcalEvent {
            id: id.into(),
            calendar_id: "primary".into(),
            status: EventStatus::Confirmed,
            title: title.into(),
            description: None,
            location: None,
            start: EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 26).unwrap()),
            end: EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 27).unwrap()),
            all_day: true,
            tz: None,
            recurring: false,
            recurring_event_id: None,
            color_hex: None,
            html_link: None,
            updated: None,
        }
    }

    #[test]
    fn incremental_merges_count_changes() {
        let cached = vec![ev("a", "A"), ev("b", "B")];
        let mut cancelled = ev("b", "B");
        cancelled.status = EventStatus::Cancelled;
        let sync = EventSync {
            upserts: vec![ev("a", "A2"), ev("c", "C"), cancelled],
            deleted: vec![],
            next_sync_token: Some("t".into()),
            full_resync: false,
        };
        let mut t = SyncTotals::default();
        let merged = merge_events(cached, sync, &mut t);
        assert_eq!(
            t,
            SyncTotals {
                added: 1,
                updated: 1,
                deleted: 1
            }
        );
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn full_resync_replaces_the_cache() {
        let cached = vec![ev("a", "A"), ev("b", "B")];
        let sync = EventSync {
            upserts: vec![ev("a", "A")],
            deleted: vec![],
            next_sync_token: None,
            full_resync: true,
        };
        let mut t = SyncTotals::default();
        let merged = merge_events(cached, sync, &mut t);
        assert_eq!(merged.len(), 1);
        assert_eq!(
            t,
            SyncTotals {
                added: 0,
                updated: 0,
                deleted: 1
            }
        );
    }

    #[test]
    fn client_ids_are_checked() {
        assert!(client_id("c", "1234-abc.apps.googleusercontent.com").is_ok());
        assert!(client_id("c", "evil.example.com").is_err());
        assert!(
            google_url(
                "u",
                "https://docs.google.com/document/d/x/edit",
                "docs.google.com"
            )
            .is_ok()
        );
        assert!(
            google_url(
                "u",
                "http://docs.google.com/document/d/x",
                "docs.google.com"
            )
            .is_err()
        );
        assert!(google_url("u", "https://docs.google.com.evil.io/x", "docs.google.com").is_err());
    }

    #[test]
    fn csv_quotes_fields() {
        let rows = vec![
            vec!["a".to_owned(), "b,c".to_owned()],
            vec!["\"q\"".to_owned(), String::new()],
        ];
        assert_eq!(to_csv(&rows), "a,\"b,c\"\r\n\"\"\"q\"\"\",\r\n");
    }

    #[test]
    fn bounds_accept_dates_and_times() {
        let a = parse_bound("f", "2026-11-26", false).unwrap();
        let b = parse_bound("t", "2026-11-26", true).unwrap();
        assert!(b > a);
        assert!(parse_bound("f", "2026-11-26T10:00:00+01:00", false).is_ok());
        assert!(parse_bound("f", "yesterday", false).is_err());
        assert_eq!(text_cell("12.5"), ExportCell::Number(12.5));
        assert_eq!(text_cell(""), ExportCell::Empty);
    }

    #[test]
    fn account_status_defaults_to_ok() {
        let d = AccountData {
            email: "a@b.c".into(),
            ..AccountData::default()
        };
        assert_eq!(dto("id", &d).status, "ok");
    }
}
