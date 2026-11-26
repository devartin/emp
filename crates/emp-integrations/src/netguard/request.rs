//! Request/response value types. API modules build [`NetRequest`]s as plain data (so request
//! builders are unit-testable) and [`super::NetGuard`] executes them.

use std::borrow::Cow;
use std::time::Duration;

use serde::de::DeserializeOwned;
use url::Url;

use super::connectors::{BodyCap, ConnectorId};
use crate::error::{IntegrationError, Result, short_message};
use crate::secret::SecretString;

/// HTTP method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// GET
    Get,
    /// POST
    Post,
    /// PUT
    Put,
    /// PATCH
    Patch,
    /// DELETE
    Delete,
}

impl Method {
    /// Upper-case method name.
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }

    pub(crate) fn to_reqwest(self) -> reqwest::Method {
        match self {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        }
    }
}

/// A credential bound to its connector's hosts. NetGuard attaches it only to the original
/// request host and drops it on any cross-host redirect. The value is marked sensitive.
#[derive(Clone, Debug)]
pub struct Credential {
    /// Header name, e.g. `authorization` or `x-finnhub-token`.
    pub header: &'static str,
    /// Full header value (e.g. `Bearer ya29…`).
    pub value: SecretString,
}

impl Credential {
    /// `Authorization: Bearer <token>`.
    pub fn bearer(token: &SecretString) -> Self {
        Credential {
            header: "authorization",
            value: SecretString::new(format!("Bearer {}", token.expose())),
        }
    }

    /// `Authorization: Token <key>` (Tiingo).
    pub fn token(key: &SecretString) -> Self {
        Credential {
            header: "authorization",
            value: SecretString::new(format!("Token {}", key.expose())),
        }
    }

    /// An API key in a custom header.
    pub fn header(header: &'static str, key: &SecretString) -> Self {
        Credential {
            header,
            value: key.clone(),
        }
    }
}

/// Expected response media type (checked on 2xx responses).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    /// `application/json` or `*+json`.
    Json,
    /// CSV (`text/csv`, `text/plain`, `application/csv`, `application/octet-stream`).
    Csv,
    /// `text/html`.
    Html,
    /// `text/markdown`, `text/x-markdown` or `text/plain`.
    Markdown,
    /// Any `text/*`.
    Text,
    /// `image/png|jpeg|gif|webp|avif`.
    Image,
    /// No check (e.g. empty-bodied revoke responses).
    Any,
}

impl Expect {
    fn describe(self) -> &'static str {
        match self {
            Expect::Json => "JSON",
            Expect::Csv => "CSV",
            Expect::Html => "HTML",
            Expect::Markdown => "Markdown",
            Expect::Text => "text",
            Expect::Image => "an image",
            Expect::Any => "anything",
        }
    }

    /// Whether `content_type` (full header value) is acceptable.
    pub fn matches(self, content_type: Option<&str>) -> bool {
        if self == Expect::Any {
            return true;
        }
        let Some(ct) = content_type else {
            return false;
        };
        let essence = ct
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        match self {
            Expect::Json => essence == "application/json" || essence.ends_with("+json"),
            Expect::Csv => matches!(
                essence.as_str(),
                "text/csv" | "text/plain" | "application/csv" | "application/octet-stream"
            ),
            Expect::Html => essence == "text/html",
            Expect::Markdown => matches!(
                essence.as_str(),
                "text/markdown" | "text/x-markdown" | "text/plain"
            ),
            Expect::Text => essence.starts_with("text/"),
            Expect::Image => matches!(
                essence.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
            ),
            Expect::Any => true,
        }
    }

    pub(crate) fn check(self, content_type: Option<&str>) -> Result<()> {
        if self.matches(content_type) {
            Ok(())
        } else {
            Err(IntegrationError::UnexpectedContentType {
                got: content_type.unwrap_or("<none>").chars().take(80).collect(),
                expected: self.describe(),
            })
        }
    }
}

/// A request body with its content type.
#[derive(Clone, Debug)]
pub struct Body {
    /// `Content-Type` header value.
    pub content_type: String,
    /// Raw bytes (may contain secrets for token requests; never logged).
    pub bytes: Vec<u8>,
}

impl Body {
    /// `application/json` body.
    pub fn json(value: &serde_json::Value) -> Self {
        Body {
            content_type: "application/json; charset=utf-8".into(),
            bytes: value.to_string().into_bytes(),
        }
    }

    /// `application/x-www-form-urlencoded` body.
    pub fn form(pairs: &[(&str, &str)]) -> Self {
        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in pairs {
            ser.append_pair(k, v);
        }
        Body {
            content_type: "application/x-www-form-urlencoded".into(),
            bytes: ser.finish().into_bytes(),
        }
    }
}

/// A fully described outbound request.
#[derive(Clone, Debug)]
pub struct NetRequest {
    /// Connector whose allowlist, limiter and breaker apply.
    pub connector: ConnectorId,
    /// HTTP method.
    pub method: Method,
    /// Absolute `https` URL.
    pub url: Url,
    /// Path template for the network log (no ids, no query).
    pub path_template: Cow<'static, str>,
    /// Extra non-secret headers.
    pub headers: Vec<(&'static str, String)>,
    /// Optional body.
    pub body: Option<Body>,
    /// Optional credential (bound to the request host).
    pub credential: Option<Credential>,
    /// Expected media type of a 2xx response.
    pub expect: Expect,
    /// Body cap.
    pub cap: BodyCap,
    /// Whether retries are safe. Defaults to `true` for GET.
    pub idempotent: bool,
    /// Per-request total timeout override (default 30 s).
    pub timeout: Option<Duration>,
}

impl NetRequest {
    /// A GET request expecting JSON with the default cap.
    pub fn get(
        connector: ConnectorId,
        url: Url,
        path_template: impl Into<Cow<'static, str>>,
    ) -> Self {
        NetRequest {
            connector,
            method: Method::Get,
            url,
            path_template: path_template.into(),
            headers: Vec::new(),
            body: None,
            credential: None,
            expect: Expect::Json,
            cap: BodyCap::Default,
            idempotent: true,
            timeout: None,
        }
    }

    /// A non-idempotent request with a body.
    pub fn with_body(
        connector: ConnectorId,
        method: Method,
        url: Url,
        path_template: impl Into<Cow<'static, str>>,
        body: Body,
    ) -> Self {
        NetRequest {
            method,
            body: Some(body),
            idempotent: false,
            ..NetRequest::get(connector, url, path_template)
        }
    }

    /// Set the expected content type.
    pub fn expect(mut self, expect: Expect) -> Self {
        self.expect = expect;
        self
    }

    /// Set the body cap.
    pub fn cap(mut self, cap: BodyCap) -> Self {
        self.cap = cap;
        self
    }

    /// Attach a credential.
    pub fn credential(mut self, credential: Credential) -> Self {
        self.credential = Some(credential);
        self
    }

    /// Add a non-secret header.
    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    /// Override the total timeout.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Mark the request as safe to retry.
    pub fn idempotent(mut self, idempotent: bool) -> Self {
        self.idempotent = idempotent;
        self
    }
}

/// A received response with a capped body.
#[derive(Debug, Clone)]
pub struct NetResponse {
    /// HTTP status.
    pub status: u16,
    /// `Content-Type` header, if any.
    pub content_type: Option<String>,
    /// `Retry-After` header, if any.
    pub retry_after: Option<String>,
    /// Body bytes (at most the cap).
    pub body: Vec<u8>,
    /// Final URL after redirects.
    pub final_url: Url,
}

impl NetResponse {
    /// Whether the status is 2xx.
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Decode a JSON body into `T`.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        decode_json(&self.body)
    }

    /// Body as UTF-8 text (lossy).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// `Ok(self)` for 2xx; otherwise a generic error derived from the status and body.
    pub fn error_for_status(self) -> Result<Self> {
        if self.is_success() {
            return Ok(self);
        }
        Err(generic_status_error(
            self.status,
            &self.body,
            self.retry_after.as_deref(),
        ))
    }
}

/// Decode JSON into a strict serde struct.
pub fn decode_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|e| IntegrationError::Decode(e.to_string()))
}

/// Map a non-success status to an error, extracting a short message from common JSON error
/// shapes (`{"error":{"message":…}}`, `{"error":"…"}`, `{"message":…}`).
pub fn generic_status_error(
    status: u16,
    body: &[u8],
    retry_after: Option<&str>,
) -> IntegrationError {
    let message = extract_error_message(body).unwrap_or_else(|| {
        reqwest::StatusCode::from_u16(status)
            .ok()
            .and_then(|s| s.canonical_reason())
            .unwrap_or("error")
            .to_string()
    });
    match status {
        401 => IntegrationError::AuthRequired,
        404 => IntegrationError::NotFound(message),
        410 => IntegrationError::Http { status, message },
        429 => IntegrationError::RateLimited {
            retry_after: retry_after
                .and_then(|v| super::retry::parse_retry_after(v, chrono::Utc::now())),
        },
        _ => IntegrationError::Http { status, message },
    }
}

fn extract_error_message(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let pick = |v: &serde_json::Value| v.as_str().map(short_message);
    v.get("error")
        .and_then(|e| e.get("message").and_then(pick).or_else(|| pick(e)))
        .or_else(|| v.get("message").and_then(pick))
        .or_else(|| v.get("error_description").and_then(pick))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expect_matches_media_types() {
        assert!(Expect::Json.matches(Some("application/json; charset=UTF-8")));
        assert!(Expect::Json.matches(Some("application/problem+json")));
        assert!(!Expect::Json.matches(Some("text/html")));
        assert!(!Expect::Json.matches(None));
        assert!(Expect::Csv.matches(Some("text/csv")));
        assert!(Expect::Image.matches(Some("image/webp")));
        assert!(!Expect::Image.matches(Some("image/svg+xml")));
        assert!(Expect::Any.matches(None));
        assert!(Expect::Html.check(Some("application/json")).is_err());
    }

    #[test]
    fn status_errors_extract_messages() {
        let body = br#"{"error":{"code":403,"message":"Calendar API disabled"}}"#;
        match generic_status_error(403, body, None) {
            IntegrationError::Http { status, message } => {
                assert_eq!(status, 403);
                assert_eq!(message, "Calendar API disabled");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            generic_status_error(401, b"", None),
            IntegrationError::AuthRequired
        ));
        match generic_status_error(429, b"", Some("7")) {
            IntegrationError::RateLimited { retry_after } => {
                assert_eq!(retry_after, Some(Duration::from_secs(7)))
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn credential_debug_is_redacted() {
        let c = Credential::bearer(&SecretString::new("tok"));
        assert_eq!(c.value.expose(), "Bearer tok");
        assert!(!format!("{c:?}").contains("tok"));
    }

    #[test]
    fn form_body_encodes() {
        let b = Body::form(&[("a", "x y"), ("b", "&=")]);
        assert_eq!(String::from_utf8(b.bytes).unwrap(), "a=x+y&b=%26%3D");
    }
}
