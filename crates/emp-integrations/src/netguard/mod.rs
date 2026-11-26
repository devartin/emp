//! NetGuard: the single egress path for every integration (SPEC §9.18).
//!
//! One shared `reqwest::Client` (rustls + platform verifier, `https_only`, 10 s connect /
//! 30 s total timeouts, no automatic redirects, no cookies, no compression) wrapped with:
//!
//! - per-connector **host allowlists**, enforced on the first request *and* every redirect hop;
//! - **private-address blocking** via a vetting DNS resolver plus IP-literal checks;
//! - **credential binding**: a credential is sent only to the original request host;
//! - **offline mode**: every request is refused before any socket is opened;
//! - **body caps** (streamed, with `Content-Length` pre-check) and **content-type checks**;
//! - per-connector **governor rate limiters**, **retries** with jittered exponential backoff
//!   honouring `Retry-After`, and a **circuit breaker** (5 failures → 5 minutes);
//! - a **network log** ring buffer without query strings or secrets.

mod addr;
mod breaker;
mod connectors;
mod request;
mod retry;
mod tls;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use governor::clock::{Clock, DefaultClock};
use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};
use parking_lot::Mutex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tokio::time::Instant;
use url::{Host, Url};

pub use addr::{is_blocked_ip, vet_addrs};
pub use breaker::{CircuitBreaker, Health};
pub use connectors::{
    BREAKER_OPEN_FOR, BREAKER_THRESHOLD, BodyCap, ConnectorId, HostPolicy, MAX_BODY_CAP,
};
pub use request::{
    Body, Credential, Expect, Method, NetRequest, NetResponse, decode_json, generic_status_error,
};
pub use retry::{Backoff, parse_retry_after};

use crate::error::{IntegrationError, Result};
use crate::netlog::{NET_LOG_CAPACITY, NetLog, NetLogEntry};

/// User agent sent on every request (SPEC §9.18).
pub const USER_AGENT: &str = concat!("EMP/", env!("CARGO_PKG_VERSION"));

/// Cap applied when reading non-2xx bodies (they are truncated, not rejected).
const ERROR_BODY_CAP: u64 = 64 * 1024;

/// NetGuard configuration. [`Default`] matches SPEC §9.18.
#[derive(Debug, Clone)]
pub struct NetGuardConfig {
    /// TCP+TLS connect timeout.
    pub connect_timeout: Duration,
    /// Total per-request timeout (overridable per request).
    pub timeout: Duration,
    /// Maximum redirects followed (each must stay in the allowlist).
    pub max_redirects: u8,
    /// Attempts for idempotent requests (1 = no retries).
    pub max_attempts: u32,
    /// Backoff between attempts.
    pub backoff: Backoff,
    /// Longest the local rate limiter may delay a request before failing with `RATE_LIMITED`.
    pub max_rate_wait: Duration,
    /// Longest `Retry-After` honoured by sleeping; longer values are returned to the caller.
    pub max_retry_after: Duration,
    /// Consecutive failures that open a connector's breaker.
    pub breaker_threshold: u32,
    /// How long an open breaker stays open.
    pub breaker_open_for: Duration,
    /// Per-connector quota overrides.
    pub quotas: HashMap<ConnectorId, Quota>,
    /// Network log capacity.
    pub log_capacity: usize,
    /// Honour `HTTPS_PROXY`/system proxy settings. Remote-image requests are additionally
    /// pre-resolved and vetted locally, because a proxy would otherwise resolve them.
    pub use_system_proxy: bool,
    /// Test-only routing of allowlisted hosts to local plain-HTTP servers.
    #[cfg(test)]
    pub(crate) test_routes: HashMap<String, std::net::SocketAddr>,
}

impl Default for NetGuardConfig {
    fn default() -> Self {
        NetGuardConfig {
            connect_timeout: Duration::from_secs(10),
            timeout: Duration::from_secs(30),
            max_redirects: 3,
            max_attempts: 3,
            backoff: Backoff::default(),
            max_rate_wait: Duration::from_secs(10),
            max_retry_after: Duration::from_secs(60),
            breaker_threshold: BREAKER_THRESHOLD,
            breaker_open_for: BREAKER_OPEN_FOR,
            quotas: HashMap::new(),
            log_capacity: NET_LOG_CAPACITY,
            use_system_proxy: true,
            #[cfg(test)]
            test_routes: HashMap::new(),
        }
    }
}

struct ConnectorState {
    limiter: DefaultDirectRateLimiter,
    breaker: Mutex<CircuitBreaker>,
}

struct Inner {
    client: reqwest::Client,
    config: NetGuardConfig,
    offline: AtomicBool,
    dispatched: AtomicU64,
    log: NetLog,
    connectors: HashMap<ConnectorId, ConnectorState>,
    clock: DefaultClock,
}

/// The egress guard. Cheap to clone; all clones share one client, log and limiter set.
#[derive(Clone)]
pub struct NetGuard {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for NetGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetGuard")
            .field("offline", &self.is_offline())
            .field("dispatched", &self.dispatched_count())
            .finish_non_exhaustive()
    }
}

impl NetGuard {
    /// Build the guard and its single HTTP client.
    pub fn new(config: NetGuardConfig) -> Result<Self> {
        #[cfg(test)]
        let test_mode = !config.test_routes.is_empty();
        #[cfg(not(test))]
        let test_mode = false;

        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
        let mut builder = reqwest::Client::builder()
            .use_preconfigured_tls(tls::client_config()?)
            .https_only(!test_mode)
            .connect_timeout(config.connect_timeout)
            .timeout(config.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .dns_resolver(Arc::new(addr::VettingResolver {
                allow_private: test_mode,
            }));
        if !config.use_system_proxy || test_mode {
            builder = builder.no_proxy();
        }
        let client = builder
            .build()
            .map_err(|e| IntegrationError::Internal(format!("HTTP client: {}", e.without_url())))?;

        let connectors = ConnectorId::ALL
            .iter()
            .map(|&id| {
                let quota = config
                    .quotas
                    .get(&id)
                    .copied()
                    .unwrap_or_else(|| id.default_quota());
                (
                    id,
                    ConnectorState {
                        limiter: RateLimiter::direct(quota),
                        breaker: Mutex::new(CircuitBreaker::new(
                            config.breaker_threshold,
                            config.breaker_open_for,
                        )),
                    },
                )
            })
            .collect();

        Ok(NetGuard {
            inner: Arc::new(Inner {
                client,
                log: NetLog::new(config.log_capacity),
                config,
                offline: AtomicBool::new(false),
                dispatched: AtomicU64::new(0),
                connectors,
                clock: DefaultClock::default(),
            }),
        })
    }

    /// Turn offline mode on or off (`network_set_offline`). Returns the new state.
    pub fn set_offline(&self, offline: bool) -> bool {
        self.inner.offline.store(offline, Ordering::SeqCst);
        offline
    }

    /// Whether offline mode is on.
    pub fn is_offline(&self) -> bool {
        self.inner.offline.load(Ordering::SeqCst)
    }

    /// The network log.
    pub fn log(&self) -> &NetLog {
        &self.inner.log
    }

    /// How many HTTP exchanges were handed to the transport (each may open a socket).
    /// Stays at zero while offline (SPEC acceptance criterion 16).
    pub fn dispatched_count(&self) -> u64 {
        self.inner.dispatched.load(Ordering::SeqCst)
    }

    /// A connector's health (breaker state).
    pub fn health(&self, connector: ConnectorId) -> Health {
        self.inner
            .connectors
            .get(&connector)
            .map(|c| c.breaker.lock().health(Instant::now()))
            .unwrap_or(Health::Unknown)
    }

    /// Close a connector's breaker (e.g. after the user changes its API key).
    pub fn reset_breaker(&self, connector: ConnectorId) {
        if let Some(c) = self.inner.connectors.get(&connector) {
            c.breaker.lock().reset();
        }
    }

    /// Execute a request and return the response for any HTTP status. Transport failures,
    /// policy violations and cap violations are errors.
    pub async fn send(&self, req: NetRequest) -> Result<NetResponse> {
        if self.is_offline() {
            return Err(IntegrationError::Offline);
        }
        self.validate_url(&req.url, req.connector)?;
        if req.connector.host_policy() == HostPolicy::AnyPublic && !self.test_mode() {
            self.preflight_public(&req.url).await?;
        }
        let state = self
            .inner
            .connectors
            .get(&req.connector)
            .ok_or_else(|| IntegrationError::Internal("unknown connector".into()))?;

        if let Err(retry_after) = state.breaker.lock().check(Instant::now()) {
            return Err(IntegrationError::CircuitOpen {
                connector: req.connector.as_str(),
                retry_after,
            });
        }

        let attempts = if req.idempotent {
            self.inner.config.max_attempts.max(1)
        } else {
            1
        };
        let mut attempt = 0;
        let outcome = loop {
            self.acquire(state).await?;
            if self.is_offline() {
                return Err(IntegrationError::Offline);
            }
            let result = self.execute(&req).await;
            attempt += 1;
            let more = attempt < attempts;
            match &result {
                Ok(resp) if more && is_retryable_status(resp.status) => {
                    let hinted = resp
                        .retry_after
                        .as_deref()
                        .and_then(|v| parse_retry_after(v, chrono::Utc::now()));
                    match hinted {
                        Some(d) if d > self.inner.config.max_retry_after => break result,
                        Some(d) => tokio::time::sleep(d).await,
                        None => tokio::time::sleep(self.inner.config.backoff.delay(attempt - 1)).await,
                    }
                }
                Err(e) if more && e.is_transient() => {
                    tokio::time::sleep(self.inner.config.backoff.delay(attempt - 1)).await;
                }
                _ => break result,
            }
        };

        let failed = match &outcome {
            Ok(resp) => resp.status >= 500 || resp.status == 429,
            Err(e) => e.is_transient(),
        };
        {
            let mut breaker = state.breaker.lock();
            if failed {
                breaker.record_failure(Instant::now());
            } else if outcome.is_ok() {
                breaker.record_success();
            }
        }
        outcome
    }

    /// `send`, then require 2xx and decode the JSON body.
    pub async fn send_json<T: serde::de::DeserializeOwned>(&self, req: NetRequest) -> Result<T> {
        self.send(req).await?.error_for_status()?.json()
    }

    fn test_mode(&self) -> bool {
        #[cfg(test)]
        {
            !self.inner.config.test_routes.is_empty()
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    /// Scheme, user-info, port and allowlist checks. Returns the lowercase host.
    fn validate_url(&self, url: &Url, connector: ConnectorId) -> Result<String> {
        if url.scheme() != "https" {
            return Err(IntegrationError::InsecureUrl("only https is allowed".into()));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(IntegrationError::InsecureUrl("credentials in URL".into()));
        }
        if url.port().is_some_and(|p| p != 443) {
            return Err(IntegrationError::InsecureUrl("non-default port".into()));
        }
        let host = match url.host() {
            Some(Host::Domain(d)) => d.to_ascii_lowercase(),
            Some(Host::Ipv4(ip)) => {
                return self.validate_ip_host(connector, std::net::IpAddr::V4(ip));
            }
            Some(Host::Ipv6(ip)) => {
                return self.validate_ip_host(connector, std::net::IpAddr::V6(ip));
            }
            None => return Err(IntegrationError::InsecureUrl("missing host".into())),
        };
        if host == "localhost" || host.ends_with(".localhost") {
            return Err(IntegrationError::BlockedAddress { host });
        }
        if !connector.allows_host(&host) {
            return Err(IntegrationError::HostNotAllowed {
                connector: connector.as_str(),
                host,
            });
        }
        Ok(host)
    }

    fn validate_ip_host(&self, connector: ConnectorId, ip: std::net::IpAddr) -> Result<String> {
        let host = ip.to_string();
        match connector.host_policy() {
            HostPolicy::Exact(_) => Err(IntegrationError::HostNotAllowed {
                connector: connector.as_str(),
                host,
            }),
            HostPolicy::AnyPublic if is_blocked_ip(ip) => Err(IntegrationError::BlockedAddress { host }),
            HostPolicy::AnyPublic => Ok(host),
        }
    }

    /// For user-content fetches: resolve locally and refuse if any answer is blocked
    /// (defence in depth when a proxy would resolve on our behalf).
    async fn preflight_public(&self, url: &Url) -> Result<()> {
        let Some(Host::Domain(d)) = url.host() else {
            return Ok(()); // IP literals were vetted in validate_url
        };
        let host = d.to_ascii_lowercase();
        let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), 443))
            .await
            .map_err(|e| IntegrationError::Network(format!("DNS lookup failed: {e}")))?
            .collect();
        if addrs.is_empty() || addrs.iter().any(|a| is_blocked_ip(a.ip())) {
            return Err(IntegrationError::BlockedAddress { host });
        }
        Ok(())
    }

    async fn acquire(&self, state: &ConnectorState) -> Result<()> {
        loop {
            match state.limiter.check() {
                Ok(()) => return Ok(()),
                Err(not_until) => {
                    let wait = not_until.wait_time_from(self.inner.clock.now());
                    if wait > self.inner.config.max_rate_wait {
                        return Err(IntegrationError::RateLimited {
                            retry_after: Some(wait),
                        });
                    }
                    tokio::time::sleep(wait).await;
                }
            }
        }
    }

    /// One logical exchange, following up to `max_redirects` allowlisted redirects.
    async fn execute(&self, req: &NetRequest) -> Result<NetResponse> {
        let original_host = self.validate_url(&req.url, req.connector)?;
        let mut url = req.url.clone();
        let mut method = req.method;
        let mut body = req.body.clone();
        let mut credential = req.credential.clone();
        let mut hops: u8 = 0;

        loop {
            let host = self.validate_url(&url, req.connector)?;
            if host != original_host {
                credential = None;
            }
            let wire_url = self.wire_url(&url, &host);
            let mut rb = self.inner.client.request(method.to_reqwest(), wire_url);
            if let Some(t) = req.timeout {
                rb = rb.timeout(t);
            }
            for (name, value) in &req.headers {
                rb = rb.header(*name, value.as_str());
            }
            if let Some(cred) = &credential {
                let name = HeaderName::from_static(cred.header);
                let mut value = HeaderValue::from_str(cred.value.expose())
                    .map_err(|_| IntegrationError::Invalid("credential contains invalid characters".into()))?;
                value.set_sensitive(true);
                rb = rb.header(name, value);
            }
            if let Some(b) = &body {
                rb = rb
                    .header(reqwest::header::CONTENT_TYPE, b.content_type.as_str())
                    .body(b.bytes.clone());
            }

            self.inner.dispatched.fetch_add(1, Ordering::SeqCst);
            let sent = rb.send().await;
            let mut resp = match sent {
                Ok(r) => r,
                Err(e) => {
                    let err = map_reqwest_error(&e, &host);
                    self.log_entry(req, method, &host, hop_path(req, hops), 0, 0);
                    return Err(err);
                }
            };
            let status = resp.status().as_u16();

            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                self.log_entry(req, method, &host, hop_path(req, hops), status, 0);
                hops += 1;
                if hops > self.inner.config.max_redirects {
                    return Err(IntegrationError::TooManyRedirects);
                }
                let location = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| IntegrationError::Provider("redirect without Location".into()))?;
                let next = url
                    .join(location)
                    .map_err(|_| IntegrationError::Provider("invalid redirect Location".into()))?;
                if status == 303 || ((status == 301 || status == 302) && method != Method::Get) {
                    method = Method::Get;
                    body = None;
                }
                url = next;
                continue;
            }

            let content_type = header_string(resp.headers(), reqwest::header::CONTENT_TYPE);
            let retry_after = header_string(resp.headers(), reqwest::header::RETRY_AFTER);
            let success = (200..300).contains(&status);
            let read = if success {
                if status != 204 {
                    if let Err(e) = req.expect.check(content_type.as_deref()) {
                        self.log_entry(req, method, &host, hop_path(req, hops), status, 0);
                        return Err(e);
                    }
                }
                read_capped(&mut resp, req.cap.bytes(), false).await
            } else {
                read_capped(&mut resp, ERROR_BODY_CAP.min(req.cap.bytes()), true).await
            };
            let body_bytes = match read {
                Ok(b) => b,
                Err(e) => {
                    self.log_entry(req, method, &host, hop_path(req, hops), status, 0);
                    return Err(e);
                }
            };
            self.log_entry(
                req,
                method,
                &host,
                hop_path(req, hops),
                status,
                body_bytes.len() as u64,
            );
            return Ok(NetResponse {
                status,
                content_type,
                retry_after,
                body: body_bytes,
                final_url: url,
            });
        }
    }

    #[cfg(test)]
    fn wire_url(&self, url: &Url, host: &str) -> Url {
        match self.inner.config.test_routes.get(host) {
            Some(addr) => {
                let mut u = url.clone();
                let _ = u.set_scheme("http");
                let _ = u.set_host(Some(&addr.ip().to_string()));
                let _ = u.set_port(Some(addr.port()));
                u
            }
            None => url.clone(),
        }
    }

    #[cfg(not(test))]
    fn wire_url(&self, url: &Url, _host: &str) -> Url {
        url.clone()
    }

    fn log_entry(
        &self,
        req: &NetRequest,
        method: Method,
        host: &str,
        path: String,
        status: u16,
        bytes: u64,
    ) {
        self.inner.log.push(NetLogEntry {
            at: chrono::Utc::now().timestamp_millis(),
            connector: req.connector.as_str().to_string(),
            method: method.as_str().to_string(),
            host: host.to_string(),
            path,
            status,
            bytes,
        });
    }
}

fn hop_path(req: &NetRequest, hops: u8) -> String {
    if hops == 0 {
        req.path_template.to_string()
    } else {
        format!("{} (redirect {hops})", req.path_template)
    }
}

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

fn header_string(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

async fn read_capped(resp: &mut reqwest::Response, cap: u64, truncate: bool) -> Result<Vec<u8>> {
    if !truncate && resp.content_length().is_some_and(|len| len > cap) {
        return Err(IntegrationError::TooLarge { cap });
    }
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(map_reqwest_error(&e, "")),
        };
        let total = buf.len() as u64 + chunk.len() as u64;
        if total > cap {
            if truncate {
                let room = usize::try_from(cap).unwrap_or(usize::MAX).saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..room.min(chunk.len())]);
                break;
            }
            return Err(IntegrationError::TooLarge { cap });
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

fn map_reqwest_error(e: &reqwest::Error, host: &str) -> IntegrationError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    while let Some(s) = source {
        if s.downcast_ref::<addr::BlockedHost>().is_some() {
            return IntegrationError::BlockedAddress {
                host: host.to_string(),
            };
        }
        source = s.source();
    }
    if e.is_timeout() {
        IntegrationError::Timeout
    } else {
        // `without_url` keeps query strings (which may carry keys) out of messages.
        let msg = e.to_string();
        let clean = reqwest_error_text(e).unwrap_or(msg);
        IntegrationError::Network(crate::error::short_message(&clean))
    }
}

fn reqwest_error_text(e: &reqwest::Error) -> Option<String> {
    // reqwest::Error is not Clone; rebuild a URL-free description from its kind and source.
    let kind = if e.is_connect() {
        "connection failed"
    } else if e.is_request() {
        "request failed"
    } else if e.is_body() || e.is_decode() {
        "body error"
    } else {
        "transport error"
    };
    let detail = std::error::Error::source(e).map(|s| s.to_string());
    Some(match detail {
        Some(d) => format!("{kind}: {d}"),
        None => kind.to_string(),
    })
}

#[cfg(test)]
pub(crate) mod testing {
    //! Helpers to build a NetGuard that routes allowlisted hosts to local test servers.
    use super::*;

    /// A guard whose `hosts` are routed to `addr` over plain HTTP, with fast retries.
    pub(crate) fn guard_for(hosts: &[&str], addr: std::net::SocketAddr) -> NetGuard {
        guard_with(hosts, addr, |_| {})
    }

    pub(crate) fn guard_with(
        hosts: &[&str],
        addr: std::net::SocketAddr,
        tweak: impl FnOnce(&mut NetGuardConfig),
    ) -> NetGuard {
        let mut config = NetGuardConfig {
            backoff: Backoff {
                base: Duration::from_millis(1),
                max: Duration::from_millis(5),
            },
            timeout: Duration::from_secs(5),
            ..NetGuardConfig::default()
        };
        for h in hosts {
            config.test_routes.insert((*h).to_string(), addr);
        }
        tweak(&mut config);
        NetGuard::new(config).expect("guard")
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::testutil::{Reply, TestServer};
    use std::num::NonZeroU32;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[tokio::test]
    async fn get_json_and_log_without_query() {
        let server = TestServer::start(vec![Reply::json(200, r#"{"ok":true}"#)]).await;
        let guard = guard_for(&["api.frankfurter.app"], server.addr());
        let req = NetRequest::get(
            ConnectorId::Frankfurter,
            url("https://api.frankfurter.app/latest?from=USD&secret=1"),
            "/latest",
        );
        let v: serde_json::Value = guard.send_json(req).await.unwrap();
        assert_eq!(v["ok"], true);
        let log = guard.log().recent(10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].host, "api.frankfurter.app");
        assert_eq!(log[0].path, "/latest");
        assert_eq!(log[0].status, 200);
        assert_eq!(log[0].bytes, 11);
        let seen = server.requests();
        assert_eq!(seen[0].path, "/latest?from=USD&secret=1");
        assert!(seen[0].header("user-agent").unwrap().starts_with("EMP/"));
    }

    #[tokio::test]
    async fn offline_mode_opens_no_sockets() {
        let server = TestServer::start(vec![Reply::json(200, "{}")]).await;
        let guard = guard_for(&["stooq.com"], server.addr());
        guard.set_offline(true);
        let req = NetRequest::get(ConnectorId::Stooq, url("https://stooq.com/q/d/l/?s=aapl.us"), "/q/d/l/");
        let err = guard.send(req).await.unwrap_err();
        assert!(matches!(err, IntegrationError::Offline));
        assert_eq!(guard.dispatched_count(), 0);
        assert_eq!(server.requests().len(), 0);
        assert!(guard.log().is_empty());
        guard.set_offline(false);
        assert!(!guard.is_offline());
    }

    #[tokio::test]
    async fn allowlist_enforced_before_any_socket() {
        let server = TestServer::start(vec![]).await;
        let guard = guard_for(&["stooq.com"], server.addr());
        for (connector, u) in [
            (ConnectorId::Stooq, "https://evil.example.com/x"),
            (ConnectorId::Google, "https://accounts.google.com/o/oauth2/v2/auth"),
            (ConnectorId::Finnhub, "https://1.2.3.4/api"),
        ] {
            let err = guard.send(NetRequest::get(connector, url(u), "/")).await.unwrap_err();
            assert!(matches!(err, IntegrationError::HostNotAllowed { .. }), "{u}: {err:?}");
        }
        for u in [
            "http://stooq.com/x",
            "https://user:pw@stooq.com/x",
            "https://stooq.com:8443/x",
        ] {
            let err = guard
                .send(NetRequest::get(ConnectorId::Stooq, url(u), "/"))
                .await
                .unwrap_err();
            assert!(matches!(err, IntegrationError::InsecureUrl(_)), "{u}: {err:?}");
        }
        assert_eq!(guard.dispatched_count(), 0);
    }

    #[tokio::test]
    async fn private_ip_blocked_for_user_content() {
        let server = TestServer::start(vec![]).await;
        let guard = guard_for(&["unused.example"], server.addr());
        for u in [
            "https://127.0.0.1/a.png",
            "https://10.0.0.8/a.png",
            "https://[::1]/a.png",
            "https://169.254.169.254/latest/meta-data",
            "https://localhost/a.png",
        ] {
            let err = guard
                .send(NetRequest::get(ConnectorId::RemoteImage, url(u), "/img").expect(Expect::Image))
                .await
                .unwrap_err();
            assert!(matches!(err, IntegrationError::BlockedAddress { .. }), "{u}: {err:?}");
        }
        assert_eq!(guard.dispatched_count(), 0);
    }

    #[tokio::test]
    async fn redirects_must_stay_in_allowlist_and_drop_credentials_cross_host() {
        // Redirect within allowlist (www → sheets): followed, credential dropped.
        let server = TestServer::start(vec![
            Reply::redirect(302, "https://sheets.googleapis.com/v4/next"),
            Reply::json(200, "{}"),
        ])
        .await;
        let guard = guard_for(&["www.googleapis.com", "sheets.googleapis.com"], server.addr());
        let req = NetRequest::get(ConnectorId::Google, url("https://www.googleapis.com/x"), "/x")
            .credential(Credential::bearer(&crate::SecretString::new("tok")));
        let resp = guard.send(req).await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.final_url.host_str(), Some("sheets.googleapis.com"));
        let seen = server.requests();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].header("authorization"), Some("Bearer tok"));
        assert_eq!(seen[1].header("authorization"), None);

        // Redirect outside the allowlist: refused.
        let server = TestServer::start(vec![Reply::redirect(302, "https://evil.example.com/steal")]).await;
        let guard = guard_for(&["www.googleapis.com"], server.addr());
        let err = guard
            .send(NetRequest::get(ConnectorId::Google, url("https://www.googleapis.com/x"), "/x"))
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::HostNotAllowed { .. }));
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn too_many_redirects() {
        let r = || Reply::redirect(301, "/loop");
        let server = TestServer::start(vec![r(), r(), r(), r(), r()]).await;
        let guard = guard_for(&["stooq.com"], server.addr());
        let err = guard
            .send(NetRequest::get(ConnectorId::Stooq, url("https://stooq.com/a"), "/a"))
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::TooManyRedirects));
        assert_eq!(server.requests().len(), 4);
    }

    #[tokio::test]
    async fn size_caps_by_content_length_and_stream() {
        let big = "x".repeat(2048);
        let server = TestServer::start(vec![
            Reply::new(200, "text/csv", big.clone()),
            Reply::new(200, "text/csv", big).chunked(),
        ])
        .await;
        let guard = guard_for(&["stooq.com"], server.addr());
        for _ in 0..2 {
            let err = guard
                .send(
                    NetRequest::get(ConnectorId::Stooq, url("https://stooq.com/q"), "/q")
                        .expect(Expect::Csv)
                        .cap(BodyCap::Bytes(1024)),
                )
                .await
                .unwrap_err();
            assert!(matches!(err, IntegrationError::TooLarge { cap: 1024 }), "{err:?}");
        }
    }

    #[tokio::test]
    async fn content_type_must_match() {
        let server = TestServer::start(vec![Reply::new(200, "text/html", "<html>")]).await;
        let guard = guard_for(&["finnhub.io"], server.addr());
        let err = guard
            .send(NetRequest::get(ConnectorId::Finnhub, url("https://finnhub.io/api/v1/quote"), "/api/v1/quote"))
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::UnexpectedContentType { .. }));
    }

    #[tokio::test]
    async fn retries_transient_statuses_and_honours_retry_after() {
        let server = TestServer::start(vec![
            Reply::json(503, "{}"),
            Reply::json(429, "{}").header("retry-after", "0"),
            Reply::json(200, r#"{"n":1}"#),
        ])
        .await;
        let guard = guard_for(&["api.coingecko.com"], server.addr());
        let v: serde_json::Value = guard
            .send_json(NetRequest::get(
                ConnectorId::Coingecko,
                url("https://api.coingecko.com/api/v3/ping"),
                "/api/v3/ping",
            ))
            .await
            .unwrap();
        assert_eq!(v["n"], 1);
        assert_eq!(server.requests().len(), 3);
        assert_eq!(guard.health(ConnectorId::Coingecko), Health::Ok);
    }

    #[tokio::test]
    async fn long_retry_after_is_returned_not_slept() {
        let server = TestServer::start(vec![Reply::json(429, "{}").header("retry-after", "3600")]).await;
        let guard = guard_for(&["finnhub.io"], server.addr());
        let resp = guard
            .send(NetRequest::get(ConnectorId::Finnhub, url("https://finnhub.io/api/v1/quote"), "/q"))
            .await
            .unwrap();
        assert_eq!(resp.status, 429);
        let err = resp.error_for_status().unwrap_err();
        assert_eq!(err.retry_after_ms(), Some(3_600_000));
    }

    #[tokio::test]
    async fn non_idempotent_requests_are_not_retried() {
        let server = TestServer::start(vec![Reply::json(503, "{}"), Reply::json(200, "{}")]).await;
        let guard = guard_for(&["oauth2.googleapis.com"], server.addr());
        let req = NetRequest::with_body(
            ConnectorId::Google,
            Method::Post,
            url("https://oauth2.googleapis.com/token"),
            "/token",
            Body::form(&[("a", "b")]),
        );
        let resp = guard.send(req).await.unwrap();
        assert_eq!(resp.status, 503);
        assert_eq!(server.requests().len(), 1);
        assert_eq!(server.requests()[0].body, b"a=b");
    }

    #[tokio::test]
    async fn breaker_opens_after_five_failures() {
        let replies = (0..5).map(|_| Reply::json(500, "{}")).collect();
        let server = TestServer::start(replies).await;
        let guard = guard_with(&["stooq.com"], server.addr(), |c| c.max_attempts = 1);
        for _ in 0..5 {
            let r = guard
                .send(NetRequest::get(ConnectorId::Stooq, url("https://stooq.com/q"), "/q"))
                .await
                .unwrap();
            assert_eq!(r.status, 500);
        }
        assert_eq!(guard.health(ConnectorId::Stooq), Health::Down);
        let err = guard
            .send(NetRequest::get(ConnectorId::Stooq, url("https://stooq.com/q"), "/q"))
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::CircuitOpen { .. }));
        assert!(err.retry_after_ms().unwrap() > 290_000);
        assert_eq!(server.requests().len(), 5);
        guard.reset_breaker(ConnectorId::Stooq);
        assert_eq!(guard.health(ConnectorId::Stooq), Health::Unknown);
    }

    #[tokio::test]
    async fn local_rate_limit_rejects_beyond_wait_budget() {
        let server = TestServer::start(vec![Reply::json(200, "{}"), Reply::json(200, "{}")]).await;
        let guard = guard_with(&["finnhub.io"], server.addr(), |c| {
            c.quotas.insert(
                ConnectorId::Finnhub,
                Quota::per_hour(NonZeroU32::new(2).unwrap()),
            );
            c.max_rate_wait = Duration::from_millis(10);
        });
        let mk = || NetRequest::get(ConnectorId::Finnhub, url("https://finnhub.io/api/v1/quote"), "/q");
        guard.send(mk()).await.unwrap();
        guard.send(mk()).await.unwrap();
        let err = guard.send(mk()).await.unwrap_err();
        assert!(matches!(err, IntegrationError::RateLimited { retry_after: Some(_) }));
        assert_eq!(server.requests().len(), 2);
    }

    #[tokio::test]
    async fn error_bodies_are_truncated_not_rejected() {
        let server = TestServer::start(vec![Reply::new(500, "text/plain", "e".repeat(100_000))]).await;
        let guard = guard_with(&["stooq.com"], server.addr(), |c| c.max_attempts = 1);
        let r = guard
            .send(NetRequest::get(ConnectorId::Stooq, url("https://stooq.com/q"), "/q"))
            .await
            .unwrap();
        assert_eq!(r.status, 500);
        assert_eq!(r.body.len() as u64, ERROR_BODY_CAP);
    }

    #[tokio::test]
    async fn transport_failure_is_network_error() {
        // Bind and drop to get a closed port.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let guard = guard_with(&["stooq.com"], addr, |c| c.max_attempts = 2);
        let err = guard
            .send(NetRequest::get(ConnectorId::Stooq, url("https://stooq.com/q?k=SECRET"), "/q"))
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::Network(_)), "{err:?}");
        assert!(!err.to_string().contains("SECRET"));
        assert_eq!(guard.dispatched_count(), 2);
        assert_eq!(guard.health(ConnectorId::Stooq), Health::Degraded);
    }
}
