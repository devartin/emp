//! Market commands (SPEC §11.3 "Markets", §17.2) and the market-backed formula host for `STOCK` / `FX` / `CRYPTO`.
//!
//! * One [`MarketRouter`] per unlocked vault, built on the app's [`emp_integrations::NetGuard`] (allowlists, offline
//!   mode, rate limits, breakers). Provider API keys live in the vault's secrets (provider = provider id, kind
//!   `api_key`, bound to the provider's hosts); enablement and priority live in the encrypted kv store
//!   (`ns = market.config`). The router — and the keys it holds — is dropped when a command finds the vault locked.
//! * `market_quotes` serves the quote cache; stale entries are refreshed in the background, missing ones are fetched
//!   with a short deadline. Offline mode is honoured by NetGuard (`OFFLINE`), with cached data still served.
//! * `market_subscribe` streams quotes over a channel every quote TTL and evaluates watchlist alerts
//!   (`market:alert`).
//! * [`MarketHost`] answers formula lookups from the same caches and enqueues fetches for misses (§9.17).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::NaiveDate;
use emp_integrations::market::router::{KeyUpdate, MarketRouter, ProviderTest};
use emp_integrations::market::{BarInterval, Bars, FxRates, ProviderInfo, Quote, SearchResult};
use emp_sheets::host::{ExternalKey, ExternalValue, Host};
use emp_store::Store;
use emp_store::model::SecretKind;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::ipc::JavaScriptChannelId;
use tauri::{AppHandle, Manager, Webview};

use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::state::{AppState, blocking};
use crate::validate;

/// kv namespace of market settings.
pub const CONFIG_NS: &str = "market.config";
/// kv key of provider settings.
pub const PROVIDERS_KEY: &str = "providers";
/// kv key of the watchlists.
pub const WATCHLISTS_KEY: &str = "watchlists";
/// Symbols per quote request / subscription.
pub const MAX_SYMBOLS: usize = 200;
/// Watchlists.
pub const MAX_WATCHLISTS: usize = 100;
/// Live subscriptions.
pub const MAX_SUBSCRIPTIONS: usize = 32;
/// How long `market_quotes` waits for uncached symbols.
pub const FIRST_FETCH_DEADLINE: Duration = Duration::from_secs(8);
/// Subscription refresh interval (the quote TTL).
pub const SUBSCRIPTION_INTERVAL: Duration = Duration::from_secs(60);

// ───────────────────────────────────────────────────────────────────────────── router lifecycle

struct RouterSlot {
    vault: String,
    router: Arc<MarketRouter>,
}

static ROUTER: LazyLock<Mutex<Option<RouterSlot>>> = LazyLock::new(|| Mutex::new(None));

/// Drops the router (and the API keys it holds).
pub fn drop_router() {
    *ROUTER.lock() = None;
}

/// Stored provider settings.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    /// Enabled flag by provider id.
    #[serde(default)]
    pub enabled: BTreeMap<String, bool>,
    /// Chain position by provider id.
    #[serde(default)]
    pub priority: BTreeMap<String, usize>,
}

fn load_settings(store: &Store) -> ApiResult<ProviderSettings> {
    Ok(store
        .kv_get_any(CONFIG_NS, PROVIDERS_KEY)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

fn secret_id_for(store: &Store, provider: &str) -> ApiResult<Option<String>> {
    Ok(store
        .secret_find(provider)?
        .into_iter()
        .find(|s| s.kind == SecretKind::ApiKey)
        .map(|s| s.id))
}

fn build_router(state: &AppState, store: &Store) -> ApiResult<MarketRouter> {
    let router = MarketRouter::new(
        state.net.clone(),
        Arc::new(emp_integrations::market::cache::SystemClock),
    );
    let settings = load_settings(store)?;
    for info in router.providers_info() {
        let key = match secret_id_for(store, &info.id)? {
            Some(id) => KeyUpdate::Set(emp_integrations::SecretString::new(
                emp_crypto::ExposeSecret::expose_secret(&store.secret_value(&id)?).to_owned(),
            )),
            None => KeyUpdate::Keep,
        };
        let enabled = settings
            .enabled
            .get(&info.id)
            .copied()
            .unwrap_or(info.enabled);
        let priority = settings.priority.get(&info.id).copied();
        router.configure(&info.id, enabled, key, priority)?;
    }
    Ok(router)
}

/// The router of the unlocked vault (built on first use).
///
/// Uses [`AppState::session_quiet`]: background quote fetches (formula host, subscriptions) must not count as user
/// activity. Commands that call this have already called `session()`.
pub fn router(state: &AppState) -> ApiResult<Arc<MarketRouter>> {
    let store = match state.session_quiet() {
        Ok(s) => s,
        Err(e) => {
            drop_router();
            return Err(e);
        }
    };
    let vault = store.vault_id().to_string();
    {
        let slot = ROUTER.lock();
        if let Some(s) = slot.as_ref().filter(|s| s.vault == vault) {
            return Ok(Arc::clone(&s.router));
        }
    }
    let router = Arc::new(build_router(state, &store)?);
    *ROUTER.lock() = Some(RouterSlot {
        vault,
        router: Arc::clone(&router),
    });
    Ok(router)
}

// ───────────────────────────────────────────────────────────────────────────── validation

/// Validates a `SymbolKey` (`TICKER:MIC`).
pub fn symbol_key(field: &str, s: &str) -> ApiResult<String> {
    validate::non_empty(field, s, 64)?;
    emp_integrations::market::symbols::Symbol::parse(s)
        .map(|x| x.key())
        .map_err(|_| ApiError::invalid(field, "invalid symbol (expected TICKER:MIC)"))
}

fn provider_id(field: &str, s: &str) -> ApiResult<()> {
    if s.is_empty()
        || s.len() > 32
        || !s
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(ApiError::invalid(field, "invalid provider id"));
    }
    Ok(())
}

/// The NetGuard hosts of a market provider (its API key is bound to them).
#[must_use]
pub fn provider_hosts(id: &str) -> Vec<String> {
    use emp_integrations::netguard::{ConnectorId, HostPolicy};
    ConnectorId::ALL
        .iter()
        .find(|c| c.as_str() == id)
        .map(|c| match c.host_policy() {
            HostPolicy::Exact(h) => h.iter().map(|x| (*x).to_owned()).collect(),
            HostPolicy::AnyPublic => Vec::new(),
        })
        .unwrap_or_default()
}

fn currency(field: &str, s: &str) -> ApiResult<String> {
    let c = s.trim().to_ascii_uppercase();
    if c.len() != 3 || !c.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err(ApiError::invalid(field, "must be a 3-letter currency code"));
    }
    Ok(c)
}

// ───────────────────────────────────────────────────────────────────────────── providers

/// `market_providers({}) → ProviderInfo[]`.
#[tauri::command]
pub async fn market_providers(app: AppHandle, req: super::Empty) -> ApiResult<Vec<ProviderInfo>> {
    let _ = req;
    blocking(move || Ok(router(&app.state::<AppState>())?.providers_info())).await
}

/// `market_provider_configure` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureReq {
    id: String,
    enabled: bool,
    #[serde(default, deserialize_with = "emp_store::model::double_option")]
    api_key: Option<Option<emp_crypto::SecretString>>,
    #[serde(default)]
    priority: Option<u32>,
}

/// `market_provider_configure({ id, enabled, apiKey?: string|null, priority? }) → ProviderInfo`. A key is stored as a
/// vault secret bound to the provider's hosts; `null` removes it.
#[tauri::command]
pub async fn market_provider_configure(
    app: AppHandle,
    req: ConfigureReq,
) -> ApiResult<ProviderInfo> {
    provider_id("id", &req.id)?;
    if let Some(Some(k)) = &req.api_key {
        validate::non_empty("apiKey", emp_crypto::ExposeSecret::expose_secret(k), 512)?;
    }
    if let Some(p) = req.priority
        && p > 32
    {
        return Err(ApiError::invalid("priority", "must be 0–32"));
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let store = state.session()?;
        let r = router(&state)?;
        if !r.providers_info().iter().any(|p| p.id == req.id) {
            return Err(ApiError::not_found("provider"));
        }
        let hosts = provider_hosts(&req.id);
        let key = match req.api_key {
            None => KeyUpdate::Keep,
            Some(None) => {
                if let Some(id) = secret_id_for(&store, &req.id)? {
                    store.secret_delete(&id)?;
                }
                KeyUpdate::Clear
            }
            Some(Some(k)) => {
                let value = emp_crypto::ExposeSecret::expose_secret(&k)
                    .trim()
                    .to_owned();
                let existing = secret_id_for(&store, &req.id)?;
                store.secret_set(emp_store::model::SecretSet {
                    id: existing,
                    provider: req.id.clone(),
                    label: format!("{} API key", req.id),
                    kind: SecretKind::ApiKey,
                    value: emp_crypto::SecretString::from(value.clone()),
                    show_last4: true,
                    allowed_hosts: hosts,
                })?;
                KeyUpdate::Set(emp_integrations::SecretString::new(value))
            }
        };
        let mut settings = load_settings(&store)?;
        settings.enabled.insert(req.id.clone(), req.enabled);
        if let Some(p) = req.priority {
            settings.priority.insert(req.id.clone(), p as usize);
        }
        store.kv_set_any(CONFIG_NS, PROVIDERS_KEY, json!(settings), None)?;
        Ok(r.configure(&req.id, req.enabled, key, req.priority.map(|p| p as usize))?)
    })
    .await
}

/// An `{ id }` request with a string id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderReq {
    id: String,
}

/// `market_provider_test({ id }) → { ok, latencyMs, error? }`.
#[tauri::command]
pub async fn market_provider_test(app: AppHandle, req: ProviderReq) -> ApiResult<ProviderTest> {
    provider_id("id", &req.id)?;
    let r = {
        let app = app.clone();
        blocking(move || router(&app.state::<AppState>())).await?
    };
    Ok(r.test(&req.id).await?)
}

// ───────────────────────────────────────────────────────────────────────────── search, quotes, bars

/// `market_search` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchReq {
    q: String,
    limit: u32,
    req_id: i64,
}

/// `market_search` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDto {
    req_id: i64,
    results: Vec<SearchResult>,
}

/// `market_search({ q, limit, reqId }) → { reqId, results }`.
#[tauri::command]
pub async fn market_search(app: AppHandle, req: SearchReq) -> ApiResult<SearchDto> {
    validate::query("q", &req.q)?;
    let limit = validate::limit("limit", req.limit, 50)?;
    if req.q.trim().is_empty() {
        return Ok(SearchDto {
            req_id: req.req_id,
            results: Vec::new(),
        });
    }
    let r = blocking(move || router(&app.state::<AppState>())).await?;
    let results = r.search(req.q.trim(), limit).await?;
    Ok(SearchDto {
        req_id: req.req_id,
        results,
    })
}

/// `market_quotes` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotesReq {
    symbols: Vec<String>,
}

fn check_symbols(field: &str, symbols: &[String]) -> ApiResult<Vec<String>> {
    validate::list_len(field, symbols.len(), MAX_SYMBOLS)?;
    let mut out = Vec::new();
    for s in symbols {
        let k = symbol_key(field, s)?;
        if !out.contains(&k) {
            out.push(k);
        }
    }
    Ok(out)
}

/// The keys of `keys` whose fetch in `fetched` (same order) succeeded.
fn arrived_keys<T, E>(keys: &[String], fetched: &[Result<T, E>]) -> Vec<String> {
    keys.iter()
        .zip(fetched)
        .filter(|(_, r)| r.is_ok())
        .map(|(k, _)| k.clone())
        .collect()
}

/// Quotes for `keys`: fresh cache hits immediately, stale hits now plus a background refresh, misses fetched with a
/// deadline. Symbols that cannot be priced are omitted.
pub async fn quotes_for(r: &Arc<MarketRouter>, keys: &[String]) -> Vec<Quote> {
    let mut out: Vec<Option<Quote>> = Vec::with_capacity(keys.len());
    let mut stale = Vec::new();
    let mut missing = Vec::new();
    for k in keys {
        match r.cached_quote(k) {
            Some((q, true)) => out.push(Some(q)),
            Some((q, false)) => {
                stale.push(k.clone());
                out.push(Some(q));
            }
            None => {
                missing.push(k.clone());
                out.push(None);
            }
        }
    }
    if !stale.is_empty() {
        let r2 = Arc::clone(r);
        tauri::async_runtime::spawn(async move {
            let fetched = r2.quotes(&stale, &HashMap::new()).await;
            note_quote_arrival(&arrived_keys(&stale, &fetched));
        });
    }
    if !missing.is_empty()
        && let Ok(fetched) =
            tokio::time::timeout(FIRST_FETCH_DEADLINE, r.quotes(&missing, &HashMap::new())).await
    {
        note_quote_arrival(&arrived_keys(&missing, &fetched));
        let mut it = fetched.into_iter();
        for slot in &mut out {
            if slot.is_none() {
                *slot = it.next().and_then(Result::ok);
            }
        }
    }
    out.into_iter().flatten().collect()
}

/// `market_quotes({ symbols }) → Quote[]` (served from cache; stale entries refresh in the background).
#[tauri::command]
pub async fn market_quotes(app: AppHandle, req: QuotesReq) -> ApiResult<Vec<Quote>> {
    let keys = check_symbols("symbols", &req.symbols)?;
    let r = blocking(move || router(&app.state::<AppState>())).await?;
    Ok(quotes_for(&r, &keys).await)
}

/// `market_bars` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BarsReq {
    symbol: String,
    interval: BarInterval,
    from: String,
    to: String,
    adjusted: bool,
}

/// `market_bars({ symbol, interval: '1d'|'1wk'|'1mo', from, to, adjusted }) → { t, o, h, l, c, v, currency, source,
/// stale }`.
#[tauri::command]
pub async fn market_bars(app: AppHandle, req: BarsReq) -> ApiResult<Bars> {
    let key = symbol_key("symbol", &req.symbol)?;
    let from = validate::ymd("from", &req.from)?;
    let to = validate::ymd("to", &req.to)?;
    if to < from {
        return Err(ApiError::invalid("to", "must not be before from"));
    }
    let r = blocking(move || router(&app.state::<AppState>())).await?;
    let s = r
        .bars(&key, req.interval, from, to, req.adjusted, &BTreeMap::new())
        .await?;
    Ok(s.to_ipc())
}

/// One requested indicator.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndicatorSpec {
    kind: emp_finance::portfolio::indicators::IndicatorKind,
    period: u32,
}

/// `market_indicators` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndicatorsReq {
    symbol: String,
    from: String,
    to: String,
    ind: Vec<IndicatorSpec>,
}

/// `market_indicators({ symbol, from, to, ind }) → Record<string, (number|null)[]>` over daily closes (keys such as
/// `sma20`, `bollinger20.upper`, `macd.signal`; aligned with `market_bars` for the same range).
#[tauri::command]
pub async fn market_indicators(
    app: AppHandle,
    req: IndicatorsReq,
) -> ApiResult<BTreeMap<String, Vec<Option<f64>>>> {
    let key = symbol_key("symbol", &req.symbol)?;
    let from = validate::ymd("from", &req.from)?;
    let to = validate::ymd("to", &req.to)?;
    if to < from {
        return Err(ApiError::invalid("to", "must not be before from"));
    }
    validate::list_len("ind", req.ind.len(), 16)?;
    for i in &req.ind {
        if i.period == 0 || i.period > 500 {
            return Err(ApiError::invalid("ind.period", "must be 1–500"));
        }
    }
    let r = blocking(move || router(&app.state::<AppState>())).await?;
    let s = r
        .bars(&key, BarInterval::Day, from, to, true, &BTreeMap::new())
        .await?;
    let closes: Vec<f64> = s.bars.iter().map(|b| b.close).collect();
    let specs: Vec<_> = req
        .ind
        .iter()
        .map(|i| (i.kind, i.period as usize))
        .collect();
    Ok(emp_finance::portfolio::indicators::series(&closes, &specs))
}

// ───────────────────────────────────────────────────────────────────────────── subscriptions and alerts

static SUBS: LazyLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `market_subscribe` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribeReq {
    symbols: Vec<String>,
    on_quote: JavaScriptChannelId,
}

/// `market_subscribe` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubDto {
    sub_id: String,
}

/// `market:alert` payload.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketAlert {
    /// Symbol.
    pub symbol: String,
    /// `above` | `below` | `pct`.
    pub kind: &'static str,
    /// Price that triggered it.
    pub price: f64,
}

static ALERTED: LazyLock<Mutex<HashSet<(String, &'static str)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Alerts of `lists` triggered by `quotes` (each `(symbol, kind)` fires once until it clears).
pub fn evaluate_alerts(lists: &[Watchlist], quotes: &[Quote]) -> Vec<MarketAlert> {
    let mut out = Vec::new();
    let mut fired = ALERTED.lock();
    for q in quotes {
        for w in lists {
            for s in w.symbols.iter().filter(|s| s.key == q.symbol) {
                let checks: [(&'static str, bool); 3] = [
                    ("above", s.alert_above.is_some_and(|a| q.price >= a)),
                    ("below", s.alert_below.is_some_and(|b| q.price <= b)),
                    (
                        "pct",
                        s.alert_pct.is_some_and(|p| q.change_pct.abs() >= p.abs()),
                    ),
                ];
                for (kind, hit) in checks {
                    let k = (q.symbol.clone(), kind);
                    if hit {
                        if fired.insert(k) {
                            out.push(MarketAlert {
                                symbol: q.symbol.clone(),
                                kind,
                                price: q.price,
                            });
                        }
                    } else {
                        fired.remove(&k);
                    }
                }
            }
        }
    }
    out
}

/// `market_subscribe({ symbols, onQuote }) → { subId }`: pushes `Quote[]` now and every minute until
/// `market_unsubscribe` (or the vault locks). Watchlist alerts are evaluated on each push.
#[tauri::command]
pub async fn market_subscribe(webview: Webview, req: SubscribeReq) -> ApiResult<SubDto> {
    let app = webview.app_handle().clone();
    let keys = check_symbols("symbols", &req.symbols)?;
    if keys.is_empty() {
        return Err(ApiError::invalid("symbols", "must not be empty"));
    }
    {
        let mut subs = SUBS.lock();
        subs.retain(|_, h| !h.inner().is_finished());
        if subs.len() >= MAX_SUBSCRIPTIONS {
            return Err(ApiError::new(
                ErrorCode::RateLimited,
                "Too many live quote subscriptions",
            ));
        }
    }
    let sub_id = emp_store::model::ids::new_id();
    let channel = req
        .on_quote
        .channel_on::<tauri::Wry, Vec<Quote>>(webview.clone());
    let handle_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let app2 = handle_app.clone();
            let ctx = blocking(move || {
                let state = app2.state::<AppState>();
                let r = router(&state)?;
                let lists = load_watchlists(&state.session_quiet()?)?;
                Ok((r, lists))
            })
            .await;
            let Ok((r, lists)) = ctx else { break };
            let quotes = quotes_for(&r, &keys).await;
            if !quotes.is_empty() {
                let state = handle_app.state::<AppState>();
                for a in evaluate_alerts(&lists, &quotes) {
                    state.events.emit(crate::events::MARKET_ALERT, a);
                }
                if channel.send(quotes).is_err() {
                    break;
                }
            }
            tokio::time::sleep(SUBSCRIPTION_INTERVAL).await;
        }
    });
    SUBS.lock().insert(sub_id.clone(), handle);
    Ok(SubDto { sub_id })
}

/// Stops every live quote subscription (on lock: they must not outlive the session).
pub fn stop_subscriptions() {
    let subs: Vec<_> = SUBS.lock().drain().map(|(_, h)| h).collect();
    for h in subs {
        h.abort();
    }
}

/// `market_unsubscribe` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsubscribeReq {
    sub_id: String,
}

/// `market_unsubscribe({ subId }) → void`.
#[tauri::command]
pub async fn market_unsubscribe(req: UnsubscribeReq) -> ApiResult<()> {
    validate::id("subId", &req.sub_id)?;
    if let Some(h) = SUBS.lock().remove(&req.sub_id) {
        h.abort();
    }
    Ok(())
}

// ───────────────────────────────────────────────────────────────────────────── watchlists

/// One watchlist entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchSymbol {
    /// Symbol key.
    pub key: String,
    /// Alert when the price is at or above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_above: Option<f64>,
    /// Alert when the price is at or below.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_below: Option<f64>,
    /// Alert when the day move exceeds this percentage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_pct: Option<f64>,
}

/// A watchlist.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watchlist {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Symbols.
    pub symbols: Vec<WatchSymbol>,
}

/// Id of the starter watchlist (kept when the user edits it, so it is saved under the same id).
pub const STARTER_WATCHLIST_ID: &str = "starter-watchlist";

/// Real, widely quoted symbols the keyless providers price (Yahoo, Stooq, CoinGecko, Frankfurter): broad US index
/// funds, two large companies, Bitcoin and the euro. Indices themselves have no `TICKER:MIC` key, so the Markets
/// strip uses the funds that track them.
pub const STARTER_SYMBOLS: &[&str] = &[
    "SPY:ARCX",
    "QQQ:XNAS",
    "AAPL:XNAS",
    "MSFT:XNAS",
    "BTC:CRYPTO",
    "EURUSD:FX",
];

/// The watchlist a workspace starts with until the user saves their own (nothing is stored until then).
fn starter_watchlist() -> Watchlist {
    Watchlist {
        id: STARTER_WATCHLIST_ID.to_owned(),
        name: "Watchlist".to_owned(),
        symbols: STARTER_SYMBOLS
            .iter()
            .map(|k| WatchSymbol {
                key: (*k).to_owned(),
                alert_above: None,
                alert_below: None,
                alert_pct: None,
            })
            .collect(),
    }
}

fn load_watchlists(store: &Store) -> ApiResult<Vec<Watchlist>> {
    Ok(match store.kv_get_any(CONFIG_NS, WATCHLISTS_KEY)? {
        Some(v) => serde_json::from_value(v).unwrap_or_default(),
        None => vec![starter_watchlist()],
    })
}

/// `watchlist_list({}) → { id, name, symbols }[]`.
#[tauri::command]
pub async fn watchlist_list(app: AppHandle, req: super::Empty) -> ApiResult<Vec<Watchlist>> {
    let _ = req;
    blocking(move || load_watchlists(&app.state::<AppState>().session()?)).await
}

/// `watchlist_save` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchlistSaveReq {
    #[serde(default)]
    id: Option<String>,
    name: String,
    symbols: Vec<WatchSymbol>,
}

/// `watchlist_save({ id?, name, symbols }) → { id }` (creates or replaces; an empty name with no symbols deletes).
#[tauri::command]
pub async fn watchlist_save(app: AppHandle, req: WatchlistSaveReq) -> ApiResult<Value> {
    validate::opt_id("id", req.id.as_deref())?;
    validate::title("name", &req.name)?;
    validate::list_len("symbols", req.symbols.len(), 500)?;
    let mut symbols = Vec::with_capacity(req.symbols.len());
    for s in req.symbols {
        let key = symbol_key("symbols.key", &s.key)?;
        for x in [s.alert_above, s.alert_below, s.alert_pct]
            .into_iter()
            .flatten()
        {
            validate::finite("symbols.alert", x)?;
        }
        if !symbols.iter().any(|w: &WatchSymbol| w.key == key) {
            symbols.push(WatchSymbol { key, ..s });
        }
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let mut lists = load_watchlists(&store)?;
        let id = req.id.unwrap_or_else(emp_store::model::ids::new_id);
        let delete = req.name.trim().is_empty() && symbols.is_empty();
        lists.retain(|w| w.id != id || !delete);
        if !delete {
            let name = if req.name.trim().is_empty() {
                "Watchlist".to_owned()
            } else {
                req.name
            };
            let w = Watchlist {
                id: id.clone(),
                name,
                symbols,
            };
            match lists.iter_mut().find(|w| w.id == id) {
                Some(existing) => *existing = w,
                None => {
                    if lists.len() >= MAX_WATCHLISTS {
                        return Err(ApiError::invalid("id", "too many watchlists"));
                    }
                    lists.push(w);
                }
            }
        }
        store.kv_set_any(CONFIG_NS, WATCHLISTS_KEY, json!(lists), None)?;
        Ok(json!({ "id": id }))
    })
    .await
}

// ───────────────────────────────────────────────────────────────────────────── FX

/// `fx_rates` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FxReq {
    base: String,
    #[serde(default)]
    symbols: Option<Vec<String>>,
    #[serde(default)]
    date: Option<String>,
}

/// `fx_rates({ base, symbols?, date? }) → { base, date, rates, source, stale }`.
#[tauri::command]
pub async fn fx_rates(app: AppHandle, req: FxReq) -> ApiResult<FxRates> {
    let base = currency("base", &req.base)?;
    let symbols: Vec<String> = req
        .symbols
        .unwrap_or_default()
        .iter()
        .map(|s| currency("symbols", s))
        .collect::<ApiResult<_>>()?;
    validate::list_len("symbols", symbols.len(), 200)?;
    let date: Option<NaiveDate> = req
        .date
        .as_deref()
        .map(|d| validate::ymd("date", d))
        .transpose()?;
    let r = blocking(move || router(&app.state::<AppState>())).await?;
    let rates = r.fx(&base, &symbols, date).await?;
    FX_SNAPSHOT.record(&rates);
    note_fx_arrival(&base, req.date.as_deref());
    Ok(rates)
}

// ───────────────────────────────────────────────────────────────────────────── formula host

/// `(from, to, date)` of a cached FX rate (`None` = latest).
type FxKey = (String, String, Option<String>);

/// Latest FX rates seen by the app, for the formula host.
#[derive(Default)]
pub struct FxSnapshot {
    rates: Mutex<HashMap<FxKey, f64>>,
}

impl FxSnapshot {
    /// Records `rates` (latest when `stale` is false and the date is today or unknown).
    pub fn record(&self, rates: &FxRates) {
        let mut m = self.rates.lock();
        if m.len() > 50_000 {
            m.clear();
        }
        for (to, r) in &rates.rates {
            m.insert((rates.base.clone(), to.clone(), None), *r);
            m.insert(
                (rates.base.clone(), to.clone(), Some(rates.date.clone())),
                *r,
            );
        }
    }

    fn get(&self, from: &str, to: &str, date: Option<&str>) -> Option<f64> {
        if from == to {
            return Some(1.0);
        }
        let m = self.rates.lock();
        let key = |a: &str, b: &str| (a.to_owned(), b.to_owned(), date.map(str::to_owned));
        m.get(&key(from, to)).copied().or_else(|| {
            m.get(&key(to, from))
                .filter(|r| **r != 0.0)
                .map(|r| 1.0 / r)
        })
    }
}

static FX_SNAPSHOT: LazyLock<FxSnapshot> = LazyLock::new(FxSnapshot::default);

/// Maps a `STOCK` symbol argument to a `SymbolKey` (bare US tickers default to `XNAS`).
#[must_use]
pub fn stock_key(symbol: &str) -> Option<String> {
    let s = symbol.trim().to_ascii_uppercase();
    let candidate = if s.contains(':') {
        s
    } else {
        format!("{s}:XNAS")
    };
    emp_integrations::market::symbols::Symbol::parse(&candidate)
        .ok()
        .map(|x| x.key())
}

/// The value of `field` of a quote.
#[must_use]
pub fn quote_field(q: &Quote, field: &str) -> Option<emp_sheets::Value> {
    use emp_sheets::Value as V;
    let n = |x: Option<f64>| x.filter(|v| v.is_finite()).map(V::Number);
    match field {
        "" | "price" | "last" => n(Some(q.price)),
        "change" => n(Some(q.change)),
        "changepct" | "change_pct" | "pct" => n(Some(q.change_pct / 100.0)),
        "open" => n(q.open),
        "high" => n(q.high),
        "low" => n(q.low),
        "prevclose" | "close" | "previousclose" => n(q.prev_close),
        "volume" => n(q.volume),
        "currency" => Some(V::Text(Arc::from(q.currency.as_str()))),
        "source" => Some(V::Text(Arc::from(q.source.as_str()))),
        _ => None,
    }
}

/// The formula host backed by the market caches (§9.17): cache reads only; misses are queued and fetched outside the
/// engine, so the next recalculation sees them.
///
/// The host also remembers which formula keys (`STOCK("aapl","price")`, `FX("EUR","USD")`, …) read which cache
/// entry, so that when a quote or rate arrives the workbooks reading it are refreshed and get `sheet:changed`
/// (see [`super::sheet::queue_external_refresh`]).
pub struct MarketHost {
    app: AppHandle,
    pending: Mutex<HashSet<String>>,
    fx_pending: Mutex<HashSet<(String, Option<String>)>>,
    /// Quote cache key (`TICKER:MIC`) → formula keys that read it.
    readers: Mutex<HashMap<String, HashSet<ExternalKey>>>,
    /// `FX` formula keys seen.
    fx_readers: Mutex<HashSet<ExternalKey>>,
}

/// Bound on remembered formula keys (each map is cleared when it grows past this; it refills on the next recalc).
pub const MAX_TRACKED_KEYS: usize = 4_096;

impl MarketHost {
    /// A host for `app`.
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Mutex::new(HashSet::new()),
            fx_pending: Mutex::new(HashSet::new()),
            readers: Mutex::new(HashMap::new()),
            fx_readers: Mutex::new(HashSet::new()),
        }
    }

    fn track_quote_reader(&self, quote_key: &str, key: &ExternalKey) {
        let mut m = self.readers.lock();
        if !m.contains_key(quote_key) && m.len() >= MAX_TRACKED_KEYS {
            m.clear();
        }
        let set = m.entry(quote_key.to_owned()).or_default();
        if set.len() < MAX_TRACKED_KEYS {
            set.insert(key.clone());
        }
    }

    fn track_fx_reader(&self, key: &ExternalKey) {
        let mut s = self.fx_readers.lock();
        if s.len() >= MAX_TRACKED_KEYS {
            s.clear();
        }
        s.insert(key.clone());
    }

    /// Formula keys that read the quotes of `quote_keys`.
    #[must_use]
    pub fn quote_readers(&self, quote_keys: &[String]) -> Vec<ExternalKey> {
        let m = self.readers.lock();
        let mut out: Vec<ExternalKey> = quote_keys
            .iter()
            .filter_map(|k| m.get(k))
            .flatten()
            .cloned()
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// `FX` formula keys answered by rates against `base` on `date` (`None` = latest).
    #[must_use]
    pub fn fx_readers(&self, base: &str, date: Option<&str>) -> Vec<ExternalKey> {
        let mut out: Vec<ExternalKey> = self
            .fx_readers
            .lock()
            .iter()
            .filter(|k| match k {
                ExternalKey::Fx { from, to, date: d } => {
                    (from.eq_ignore_ascii_case(base) || to.eq_ignore_ascii_case(base))
                        && d.as_deref() == date
                }
                _ => false,
            })
            .cloned()
            .collect();
        out.sort();
        out
    }

    fn cached_router(&self) -> Option<Arc<MarketRouter>> {
        ROUTER.lock().as_ref().map(|s| Arc::clone(&s.router))
    }

    fn queue_quote(&self, key: String) {
        if !self.pending.lock().insert(key.clone()) {
            return;
        }
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let app2 = app.clone();
            let mut arrived = false;
            if let Ok(r) = blocking(move || router(&app2.state::<AppState>())).await {
                arrived = r
                    .quotes(std::slice::from_ref(&key), &HashMap::new())
                    .await
                    .iter()
                    .any(Result::is_ok);
            }
            let host = HOST.lock().clone();
            if let Some(h) = host {
                h.pending.lock().remove(&key);
                if arrived {
                    notify_quotes(&h, std::slice::from_ref(&key));
                }
            }
        });
    }

    fn queue_fx(&self, base: String, date: Option<String>) {
        if !self.fx_pending.lock().insert((base.clone(), date.clone())) {
            return;
        }
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let app2 = app.clone();
            if let Ok(r) = blocking(move || router(&app2.state::<AppState>())).await {
                let d = date
                    .as_deref()
                    .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
                if let Ok(rates) = r.fx(&base, &[], d).await {
                    FX_SNAPSHOT.record(&rates);
                    note_fx_arrival(&base, date.as_deref());
                }
            }
            let host = HOST.lock().clone();
            if let Some(h) = host {
                h.fx_pending.lock().remove(&(base, date));
            }
        });
    }
}

impl Host for MarketHost {
    fn now(&self) -> chrono::NaiveDateTime {
        chrono::Local::now().naive_local()
    }

    fn random(&self) -> f64 {
        let mut b = [0u8; 8];
        if getrandom::getrandom(&mut b).is_err() {
            return 0.5;
        }
        (u64::from_le_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn external(&self, key: &ExternalKey) -> ExternalValue {
        match key {
            ExternalKey::Stock { symbol, field } | ExternalKey::Crypto { id: symbol, field } => {
                let sym = match key {
                    ExternalKey::Crypto { .. } => format!("{}:CRYPTO", symbol.to_ascii_uppercase()),
                    _ => symbol.clone(),
                };
                let Some(k) = stock_key(&sym) else {
                    return ExternalValue::Unavailable;
                };
                self.track_quote_reader(&k, key);
                match self.cached_router().and_then(|r| r.cached_quote(&k)) {
                    Some((q, fresh)) => {
                        if !fresh {
                            self.queue_quote(k);
                        }
                        quote_field(&q, &field.to_ascii_lowercase())
                            .map_or(ExternalValue::Unavailable, ExternalValue::Ready)
                    }
                    None => {
                        self.queue_quote(k);
                        ExternalValue::Pending
                    }
                }
            }
            ExternalKey::Fx { from, to, date } => {
                self.track_fx_reader(key);
                let (f, t) = (from.to_ascii_uppercase(), to.to_ascii_uppercase());
                match FX_SNAPSHOT.get(&f, &t, date.as_deref()) {
                    Some(r) => ExternalValue::Ready(emp_sheets::Value::Number(r)),
                    None => {
                        self.queue_fx(f, date.clone());
                        ExternalValue::Pending
                    }
                }
            }
        }
    }
}

static HOST: LazyLock<Mutex<Option<Arc<MarketHost>>>> = LazyLock::new(|| Mutex::new(None));
static HOST_VAULT: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

fn notify_quotes(host: &MarketHost, quote_keys: &[String]) {
    let keys = host.quote_readers(quote_keys);
    if !keys.is_empty() {
        super::sheet::queue_external_refresh(&host.app, keys);
    }
}

/// Quotes for `quote_keys` were fetched (by any path): refresh the workbooks whose formulas read them.
pub fn note_quote_arrival(quote_keys: &[String]) {
    if quote_keys.is_empty() {
        return;
    }
    let host = HOST.lock().clone();
    if let Some(h) = host {
        notify_quotes(&h, quote_keys);
    }
}

/// FX rates against `base` (on `date`, `None` = latest) were fetched: refresh the workbooks whose `FX` formulas
/// read them.
pub fn note_fx_arrival(base: &str, date: Option<&str>) {
    let host = HOST.lock().clone();
    if let Some(h) = host {
        let keys = h.fx_readers(base, date);
        if !keys.is_empty() {
            super::sheet::queue_external_refresh(&h.app, keys);
        }
    }
}

/// Installs the [`MarketHost`] into `store`'s sheet engines once per vault.
pub fn ensure_sheet_host(app: &AppHandle, store: &Store) {
    let vault = store.vault_id().to_string();
    let mut current = HOST_VAULT.lock();
    if current.as_deref() == Some(vault.as_str()) {
        return;
    }
    let host = {
        let mut h = HOST.lock();
        Arc::clone(h.get_or_insert_with(|| Arc::new(MarketHost::new(app.clone()))))
    };
    store.sheets_set_host(host);
    *current = Some(vault);
}

#[cfg(test)]
mod tests {
    use super::*;
    use emp_integrations::market::{Freshness, MarketState};

    fn quote(sym: &str, price: f64, pct: f64) -> Quote {
        Quote {
            symbol: sym.into(),
            price,
            change: 1.0,
            change_pct: pct,
            open: None,
            high: None,
            low: None,
            prev_close: Some(price - 1.0),
            volume: None,
            currency: "USD".into(),
            market_state: MarketState::Open,
            as_of: 0,
            source: "test".into(),
            freshness: Freshness::Delayed,
            delayed_min: 15,
        }
    }

    #[test]
    fn symbols_are_normalised() {
        assert_eq!(symbol_key("s", "aapl:xnas").unwrap(), "AAPL:XNAS");
        assert!(symbol_key("s", "").is_err());
        assert!(symbol_key("s", "../etc").is_err());
        assert_eq!(stock_key("msft").as_deref(), Some("MSFT:XNAS"));
        assert_eq!(currency("c", "eur").unwrap(), "EUR");
        assert!(currency("c", "EURO").is_err());
    }

    #[test]
    fn quote_fields_map_to_values() {
        let q = quote("AAPL:XNAS", 190.5, 2.0);
        assert_eq!(
            quote_field(&q, "price"),
            Some(emp_sheets::Value::Number(190.5))
        );
        assert_eq!(
            quote_field(&q, "changepct"),
            Some(emp_sheets::Value::Number(0.02))
        );
        assert_eq!(quote_field(&q, "open"), None);
        assert!(quote_field(&q, "nonsense").is_none());
    }

    #[test]
    fn alerts_fire_once_until_cleared() {
        let lists = vec![Watchlist {
            id: "w".into(),
            name: "W".into(),
            symbols: vec![WatchSymbol {
                key: "ZZTEST:XNAS".into(),
                alert_above: Some(100.0),
                alert_below: None,
                alert_pct: Some(5.0),
            }],
        }];
        let a = evaluate_alerts(&lists, &[quote("ZZTEST:XNAS", 101.0, 1.0)]);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, "above");
        assert!(evaluate_alerts(&lists, &[quote("ZZTEST:XNAS", 102.0, 1.0)]).is_empty());
        assert!(evaluate_alerts(&lists, &[quote("ZZTEST:XNAS", 99.0, 1.0)]).is_empty());
        let again = evaluate_alerts(&lists, &[quote("ZZTEST:XNAS", 103.0, -6.0)]);
        assert_eq!(again.len(), 2);
    }

    #[test]
    fn fx_snapshot_inverts_rates() {
        let s = FxSnapshot::default();
        let mut rates = BTreeMap::new();
        rates.insert("USD".to_owned(), 1.25);
        s.record(&FxRates {
            base: "EUR".into(),
            date: "2026-11-26".into(),
            rates,
            source: "test".into(),
            stale: false,
        });
        assert_eq!(s.get("EUR", "USD", None), Some(1.25));
        assert_eq!(s.get("USD", "EUR", None), Some(0.8));
        assert_eq!(s.get("EUR", "USD", Some("2026-11-26")), Some(1.25));
        assert_eq!(s.get("EUR", "EUR", None), Some(1.0));
        assert_eq!(s.get("EUR", "JPY", None), None);
    }

    #[test]
    fn starter_watchlist_uses_real_parseable_symbols() {
        let w = starter_watchlist();
        assert!(validate::id("id", &w.id).is_ok());
        assert_eq!(w.symbols.len(), STARTER_SYMBOLS.len());
        for s in &w.symbols {
            assert!(symbol_key("key", &s.key).is_ok(), "{}", s.key);
            assert!(!s.key.starts_with("EMP"), "no demo tickers on desktop");
        }
    }

    #[test]
    fn watchlist_entries_reject_unknown_fields() {
        let ok: Result<WatchSymbol, _> =
            serde_json::from_value(json!({ "key": "AAPL:XNAS", "alertAbove": 200 }));
        assert!(ok.is_ok());
        let bad: Result<WatchSymbol, _> =
            serde_json::from_value(json!({ "key": "AAPL:XNAS", "x": 1 }));
        assert!(bad.is_err());
    }
}
