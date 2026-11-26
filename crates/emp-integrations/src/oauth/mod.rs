//! Google OAuth 2.0 for installed apps: PKCE S256 (RFC 7636), `state`, loopback redirect
//! (RFC 8252), token exchange, refresh and revocation (SPEC §9.19).
//!
//! The user supplies their own "Desktop app" client; nothing secret ships in the binary.
//! This module never stores tokens: [`TokenSet`] hands them to the caller as
//! [`SecretString`]s, and the caller stores the refresh token as an encrypted secret.

mod pkce;

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use url::Url;

pub use pkce::{Pkce, random_token};

use crate::error::{IntegrationError, Result, short_message};
use crate::loopback::{DEFAULT_CALLBACK_TIMEOUT, LoopbackListener};
use crate::netguard::{Body, ConnectorId, Expect, Method, NetGuard, NetRequest, NetResponse};
use crate::secret::SecretString;

/// Authorization endpoint (opened in the system browser only).
pub const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// Token endpoint.
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
/// Revocation endpoint.
pub const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";

/// Google OAuth scopes (SPEC §9.19 item 7).
pub mod scopes {
    /// Calendar read.
    pub const CALENDAR_READONLY: &str = "https://www.googleapis.com/auth/calendar.readonly";
    /// Docs read (`documents.get`).
    pub const DOCUMENTS_READONLY: &str = "https://www.googleapis.com/auth/documents.readonly";
    /// Drive read: needed for Drive `files.export` of documents EMP did not create.
    pub const DRIVE_READONLY: &str = "https://www.googleapis.com/auth/drive.readonly";
    /// Sheets read.
    pub const SPREADSHEETS_READONLY: &str = "https://www.googleapis.com/auth/spreadsheets.readonly";
    /// Files EMP creates.
    pub const DRIVE_FILE: &str = "https://www.googleapis.com/auth/drive.file";
    /// OpenID (account id).
    pub const OPENID: &str = "openid";
    /// Account email (label).
    pub const EMAIL: &str = "email";
    /// Calendar write (P1).
    pub const CALENDAR_EVENTS: &str = "https://www.googleapis.com/auth/calendar.events";
}

/// Features that request scopes incrementally (`google_connect({feature})`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoogleFeature {
    /// Calendar read.
    Calendar,
    /// Docs import by URL.
    DocsImport,
    /// Sheets import by URL.
    SheetsImport,
    /// Export of new files EMP creates.
    Export,
}

impl GoogleFeature {
    /// Scopes to request for the feature, always including `openid email` for the label.
    ///
    /// `DocsImport` also requests `drive.readonly`: Drive `files.export` (the import path)
    /// does not accept `documents.readonly`.
    pub fn scopes(self) -> Vec<&'static str> {
        let mut v = match self {
            GoogleFeature::Calendar => vec![scopes::CALENDAR_READONLY],
            GoogleFeature::DocsImport => vec![scopes::DOCUMENTS_READONLY, scopes::DRIVE_READONLY],
            GoogleFeature::SheetsImport => vec![scopes::SPREADSHEETS_READONLY],
            GoogleFeature::Export => vec![scopes::DRIVE_FILE],
        };
        v.extend([scopes::OPENID, scopes::EMAIL]);
        v
    }
}

/// The user's OAuth client ("Desktop app" type).
#[derive(Debug, Clone)]
pub struct ClientCredentials {
    /// Client ID.
    pub client_id: String,
    /// Client secret (Google issues one even for desktop clients; it is not confidential).
    pub client_secret: Option<SecretString>,
}

/// Parameters for the browser authorization URL.
#[derive(Debug, Clone)]
pub struct AuthorizationRequest<'a> {
    /// Client ID.
    pub client_id: &'a str,
    /// Loopback redirect URI.
    pub redirect_uri: &'a str,
    /// Scopes to request.
    pub scopes: &'a [&'a str],
    /// The single-use `state`.
    pub state: &'a SecretString,
    /// PKCE pair.
    pub pkce: &'a Pkce,
    /// Add `prompt=consent` (first connect, so a refresh token is issued).
    pub prompt_consent: bool,
    /// Optional `login_hint` (account email) when reconnecting.
    pub login_hint: Option<&'a str>,
}

impl AuthorizationRequest<'_> {
    /// The URL to open in the system browser.
    pub fn url(&self) -> Url {
        let mut url = Url::parse(AUTH_ENDPOINT).unwrap_or_else(|_| unreachable_url());
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("client_id", self.client_id)
                .append_pair("redirect_uri", self.redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", &self.scopes.join(" "))
                .append_pair("state", self.state.expose())
                .append_pair("code_challenge", self.pkce.challenge())
                .append_pair("code_challenge_method", "S256")
                .append_pair("access_type", "offline")
                .append_pair("include_granted_scopes", "true");
            if self.prompt_consent {
                q.append_pair("prompt", "consent");
            }
            if let Some(hint) = self.login_hint {
                q.append_pair("login_hint", hint);
            }
        }
        url
    }
}

#[cold]
fn unreachable_url() -> Url {
    // AUTH_ENDPOINT is a valid constant; this path cannot be reached.
    Url::parse("https://accounts.google.com/").expect("static URL")
}

/// Account identity from the ID token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountIdentity {
    /// Stable Google account id (`sub`).
    pub subject: String,
    /// Email, if the `email` scope was granted.
    pub email: Option<String>,
}

/// Tokens returned by an exchange or refresh. Store `refresh_token` as an encrypted secret;
/// keep `access_token` in memory only.
#[derive(Debug, Clone)]
pub struct TokenSet {
    /// Short-lived access token.
    pub access_token: SecretString,
    /// When the access token expires.
    pub expires_at: DateTime<Utc>,
    /// Refresh token (present on first consent; usually absent on refresh).
    pub refresh_token: Option<SecretString>,
    /// Granted scopes.
    pub scopes: Vec<String>,
    /// Identity from the ID token, when `openid` was granted.
    pub identity: Option<AccountIdentity>,
}

impl TokenSet {
    /// Whether the access token expires within `margin` of `now`.
    pub fn expires_within(&self, now: DateTime<Utc>, margin: Duration) -> bool {
        let margin = chrono::Duration::from_std(margin).unwrap_or(chrono::Duration::zero());
        self.expires_at <= now + margin
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    scope: Option<String>,
    token_type: Option<String>,
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenErrorResponse {
    error: String,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    sub: String,
    email: Option<String>,
}

/// Token exchange request (authorization code + PKCE verifier).
pub fn exchange_request(
    client: &ClientCredentials,
    code: &SecretString,
    verifier: &SecretString,
    redirect_uri: &str,
) -> Result<NetRequest> {
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", code.expose()),
        ("code_verifier", verifier.expose()),
        ("redirect_uri", redirect_uri),
        ("client_id", client.client_id.as_str()),
    ];
    if let Some(secret) = &client.client_secret {
        pairs.push(("client_secret", secret.expose()));
    }
    token_post(TOKEN_ENDPOINT, "/token", &pairs)
}

/// Refresh request.
pub fn refresh_request(client: &ClientCredentials, refresh_token: &SecretString) -> Result<NetRequest> {
    let mut pairs = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.expose()),
        ("client_id", client.client_id.as_str()),
    ];
    if let Some(secret) = &client.client_secret {
        pairs.push(("client_secret", secret.expose()));
    }
    token_post(TOKEN_ENDPOINT, "/token", &pairs)
}

/// Revocation request (`POST https://oauth2.googleapis.com/revoke`, token in the body).
pub fn revoke_request(token: &SecretString) -> Result<NetRequest> {
    Ok(token_post(REVOKE_ENDPOINT, "/revoke", &[("token", token.expose())])?.expect(Expect::Any))
}

fn token_post(endpoint: &str, template: &'static str, pairs: &[(&str, &str)]) -> Result<NetRequest> {
    let url = Url::parse(endpoint).map_err(|e| IntegrationError::Internal(e.to_string()))?;
    Ok(NetRequest::with_body(ConnectorId::Google, Method::Post, url, template, Body::form(pairs)))
}

/// Parse a token endpoint response. `invalid_grant` → [`IntegrationError::ReauthRequired`].
pub fn parse_token_response(resp: &NetResponse, now: DateTime<Utc>) -> Result<TokenSet> {
    if !resp.is_success() {
        return Err(token_error(resp));
    }
    let t: TokenResponse = resp.json()?;
    if let Some(tt) = &t.token_type {
        if !tt.eq_ignore_ascii_case("bearer") {
            return Err(IntegrationError::OAuth(format!("unexpected token type {}", short_message(tt))));
        }
    }
    if t.access_token.is_empty() {
        return Err(IntegrationError::OAuth("empty access token".into()));
    }
    let expires_in = t.expires_in.unwrap_or(3600).clamp(0, 86_400 * 30);
    let identity = t.id_token.as_deref().and_then(decode_id_token);
    Ok(TokenSet {
        access_token: SecretString::new(t.access_token),
        expires_at: now + chrono::Duration::seconds(expires_in),
        refresh_token: t.refresh_token.filter(|r| !r.is_empty()).map(SecretString::new),
        scopes: t
            .scope
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect(),
        identity,
    })
}

fn token_error(resp: &NetResponse) -> IntegrationError {
    match resp.json::<TokenErrorResponse>() {
        Ok(e) if e.error == "invalid_grant" => IntegrationError::ReauthRequired,
        Ok(e) => {
            let desc = e.error_description.as_deref().map(short_message).unwrap_or_default();
            IntegrationError::OAuth(if desc.is_empty() {
                short_message(&e.error)
            } else {
                format!("{}: {desc}", short_message(&e.error))
            })
        }
        Err(_) => crate::netguard::generic_status_error(resp.status, &resp.body, resp.retry_after.as_deref()),
    }
}

/// Extract `sub`/`email` from an ID token received directly from the token endpoint over TLS
/// (OIDC Core §3.1.3.7 permits skipping signature validation in that case). The identity is
/// used only as an account label.
pub fn decode_id_token(id_token: &str) -> Option<AccountIdentity> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: IdTokenClaims = serde_json::from_slice(&bytes).ok()?;
    Some(AccountIdentity {
        subject: claims.sub,
        email: claims.email,
    })
}

/// Options for [`GoogleOAuth::connect`].
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// Scopes to request (see [`GoogleFeature::scopes`]).
    pub scopes: Vec<String>,
    /// First connect: adds `prompt=consent` so Google issues a refresh token.
    pub first_connect: bool,
    /// Account email hint when reconnecting.
    pub login_hint: Option<String>,
    /// How long to wait for the browser redirect (default 5 minutes).
    pub timeout: Duration,
}

impl ConnectOptions {
    /// Options for a feature with the default timeout.
    pub fn for_feature(feature: GoogleFeature, first_connect: bool) -> Self {
        ConnectOptions {
            scopes: feature.scopes().into_iter().map(str::to_string).collect(),
            first_connect,
            login_hint: None,
            timeout: DEFAULT_CALLBACK_TIMEOUT,
        }
    }
}

/// The OAuth client: drives the installed-app flow and token maintenance through NetGuard.
#[derive(Debug, Clone)]
pub struct GoogleOAuth {
    guard: NetGuard,
    client: ClientCredentials,
}

impl GoogleOAuth {
    /// New OAuth client for the user's credentials.
    pub fn new(guard: NetGuard, client: ClientCredentials) -> Self {
        GoogleOAuth { guard, client }
    }

    /// The client credentials.
    pub fn client(&self) -> &ClientCredentials {
        &self.client
    }

    /// Run the full flow: bind the loopback listener, build the authorization URL, call
    /// `open_browser` with it (the app opens the system browser), wait for the callback and
    /// exchange the code. Drop the future to cancel.
    pub async fn connect<F>(&self, options: &ConnectOptions, open_browser: F) -> Result<TokenSet>
    where
        F: FnOnce(&Url) -> Result<()>,
    {
        if self.guard.is_offline() {
            return Err(IntegrationError::Offline);
        }
        if self.client.client_id.trim().is_empty() {
            return Err(IntegrationError::Invalid("Google client ID is not configured".into()));
        }
        let listener = LoopbackListener::bind().await?;
        let redirect_uri = listener.redirect_uri();
        let pkce = Pkce::generate();
        let state = random_token();
        let scope_refs: Vec<&str> = options.scopes.iter().map(String::as_str).collect();
        let url = AuthorizationRequest {
            client_id: &self.client.client_id,
            redirect_uri: &redirect_uri,
            scopes: &scope_refs,
            state: &state,
            pkce: &pkce,
            prompt_consent: options.first_connect,
            login_hint: options.login_hint.as_deref(),
        }
        .url();
        open_browser(&url)?;
        let code = listener.wait_for_code(&state, options.timeout).await?;
        self.exchange_code(&code, pkce.verifier(), &redirect_uri).await
    }

    /// Exchange an authorization code.
    pub async fn exchange_code(
        &self,
        code: &SecretString,
        verifier: &SecretString,
        redirect_uri: &str,
    ) -> Result<TokenSet> {
        let resp = self
            .guard
            .send(exchange_request(&self.client, code, verifier, redirect_uri)?)
            .await?;
        parse_token_response(&resp, Utc::now())
    }

    /// Refresh the access token. On `invalid_grant` returns
    /// [`IntegrationError::ReauthRequired`]: set the account to `reauth_required`.
    pub async fn refresh(&self, refresh_token: &SecretString) -> Result<TokenSet> {
        let resp = self.guard.send(refresh_request(&self.client, refresh_token)?).await?;
        parse_token_response(&resp, Utc::now())
    }

    /// Revoke a refresh or access token. An already-invalid token counts as revoked.
    pub async fn revoke(&self, token: &SecretString) -> Result<()> {
        let resp = self.guard.send(revoke_request(token)?).await?;
        if resp.is_success() {
            return Ok(());
        }
        match resp.json::<TokenErrorResponse>() {
            Ok(e) if e.error == "invalid_token" => Ok(()),
            _ => Err(token_error(&resp)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netguard::testing::guard_for;
    use crate::testutil::{Reply, TestServer};
    use sha2::{Digest, Sha256};

    fn response(status: u16, body: &str) -> NetResponse {
        NetResponse {
            status,
            content_type: Some("application/json".into()),
            retry_after: None,
            body: body.as_bytes().to_vec(),
            final_url: Url::parse(TOKEN_ENDPOINT).unwrap(),
        }
    }

    fn id_token(claims: &str) -> String {
        format!("eyJhbGciOiJSUzI1NiJ9.{}.sig", URL_SAFE_NO_PAD.encode(claims))
    }

    #[test]
    fn authorization_url_has_required_params() {
        let pkce = Pkce::generate();
        let state = SecretString::new("st");
        let url = AuthorizationRequest {
            client_id: "cid.apps.googleusercontent.com",
            redirect_uri: "http://127.0.0.1:4567/oauth/callback",
            scopes: &GoogleFeature::Calendar.scopes(),
            state: &state,
            pkce: &pkce,
            prompt_consent: true,
            login_hint: Some("me@example.com"),
        }
        .url();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], pkce.challenge());
        assert_eq!(q["state"], "st");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["include_granted_scopes"], "true");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:4567/oauth/callback");
        assert_eq!(
            q["scope"],
            "https://www.googleapis.com/auth/calendar.readonly openid email"
        );
        assert_eq!(q["login_hint"], "me@example.com");
        // No verifier in the URL.
        assert!(!url.as_str().contains(pkce.verifier().expose()));

        let url = AuthorizationRequest {
            prompt_consent: false,
            login_hint: None,
            client_id: "c",
            redirect_uri: "r",
            scopes: &[],
            state: &state,
            pkce: &pkce,
        }
        .url();
        assert!(!url.query().unwrap().contains("prompt="));
    }

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let p = Pkce::generate();
        let digest = Sha256::digest(p.verifier().expose().as_bytes());
        assert_eq!(p.challenge(), URL_SAFE_NO_PAD.encode(digest));
        assert_eq!(p.verifier().len(), 43);
    }

    #[test]
    fn exchange_and_refresh_requests_are_form_posts() {
        let client = ClientCredentials {
            client_id: "cid".into(),
            client_secret: Some(SecretString::new("csecret")),
        };
        let req = exchange_request(
            &client,
            &SecretString::new("code/1"),
            &SecretString::new("verif"),
            "http://127.0.0.1:1/oauth/callback",
        )
        .unwrap();
        assert_eq!(req.method, Method::Post);
        assert_eq!(req.url.as_str(), TOKEN_ENDPOINT);
        assert!(!req.idempotent);
        let body = String::from_utf8(req.body.unwrap().bytes).unwrap();
        let pairs: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
        assert_eq!(pairs["grant_type"], "authorization_code");
        assert_eq!(pairs["code"], "code/1");
        assert_eq!(pairs["code_verifier"], "verif");
        assert_eq!(pairs["client_secret"], "csecret");
        assert!(req.url.query().is_none(), "secrets never go in the URL");

        let req = refresh_request(&client, &SecretString::new("rt")).unwrap();
        let body = String::from_utf8(req.body.unwrap().bytes).unwrap();
        assert!(body.contains("grant_type=refresh_token") && body.contains("refresh_token=rt"));

        let req = revoke_request(&SecretString::new("rt")).unwrap();
        assert_eq!(req.url.as_str(), REVOKE_ENDPOINT);
        assert_eq!(String::from_utf8(req.body.unwrap().bytes).unwrap(), "token=rt");
    }

    #[test]
    fn parses_token_response_with_identity() {
        let now = Utc::now();
        let body = format!(
            r#"{{"access_token":"ya29.a","expires_in":3599,"refresh_token":"1//r","scope":"openid https://www.googleapis.com/auth/calendar.readonly email","token_type":"Bearer","id_token":"{}"}}"#,
            id_token(r#"{"sub":"1234","email":"me@example.com","email_verified":true}"#)
        );
        let t = parse_token_response(&response(200, &body), now).unwrap();
        assert_eq!(t.access_token.expose(), "ya29.a");
        assert_eq!(t.refresh_token.as_ref().unwrap().expose(), "1//r");
        assert_eq!(t.scopes.len(), 3);
        assert_eq!(t.expires_at, now + chrono::Duration::seconds(3599));
        assert_eq!(t.identity.as_ref().unwrap().email.as_deref(), Some("me@example.com"));
        assert!(t.expires_within_check(now));
    }

    impl TokenSet {
        fn expires_within_check(&self, now: DateTime<Utc>) -> bool {
            !self.expires_within(now, Duration::from_secs(60))
                && self.expires_within(now, Duration::from_secs(3600))
        }
    }

    #[test]
    fn invalid_grant_maps_to_reauth_required() {
        let err = parse_token_response(
            &response(400, r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#),
            Utc::now(),
        )
        .unwrap_err();
        assert!(matches!(err, IntegrationError::ReauthRequired));
        assert_eq!(err.code().as_str(), "REAUTH_REQUIRED");

        let err = parse_token_response(
            &response(401, r#"{"error":"invalid_client","error_description":"The OAuth client was not found."}"#),
            Utc::now(),
        )
        .unwrap_err();
        assert!(matches!(err, IntegrationError::OAuth(ref m) if m.starts_with("invalid_client")));
    }

    #[test]
    fn id_token_decoding_is_tolerant() {
        assert!(decode_id_token("garbage").is_none());
        assert!(decode_id_token("a.!!!.c").is_none());
        let t = id_token(r#"{"sub":"9"}"#);
        assert_eq!(decode_id_token(&t).unwrap().subject, "9");
    }

    #[tokio::test]
    async fn refresh_and_revoke_through_netguard() {
        let server = TestServer::start(vec![
            Reply::json(200, r#"{"access_token":"new","expires_in":3600,"token_type":"Bearer","scope":"email"}"#),
            Reply::json(400, r#"{"error":"invalid_grant"}"#),
            Reply::new(200, "text/html", ""),
            Reply::json(400, r#"{"error":"invalid_token"}"#),
        ])
        .await;
        let guard = guard_for(&["oauth2.googleapis.com"], server.addr());
        let oauth = GoogleOAuth::new(
            guard,
            ClientCredentials {
                client_id: "cid".into(),
                client_secret: None,
            },
        );
        let rt = SecretString::new("refresh-1");
        let t = oauth.refresh(&rt).await.unwrap();
        assert_eq!(t.access_token.expose(), "new");
        assert!(t.refresh_token.is_none());
        assert!(matches!(oauth.refresh(&rt).await.unwrap_err(), IntegrationError::ReauthRequired));
        oauth.revoke(&rt).await.unwrap();
        oauth.revoke(&rt).await.unwrap();
        let reqs = server.requests();
        assert_eq!(reqs[2].path, "/revoke");
        assert_eq!(reqs[2].body_str(), "token=refresh-1");
        assert_eq!(reqs[0].header("content-type"), Some("application/x-www-form-urlencoded"));
    }

    #[tokio::test]
    async fn full_connect_flow_with_local_browser() {
        let server = TestServer::start(vec![Reply::json(
            200,
            r#"{"access_token":"at","expires_in":3600,"refresh_token":"rt","token_type":"Bearer","scope":"openid email"}"#,
        )])
        .await;
        let guard = guard_for(&["oauth2.googleapis.com"], server.addr());
        let oauth = GoogleOAuth::new(
            guard,
            ClientCredentials {
                client_id: "cid".into(),
                client_secret: Some(SecretString::new("cs")),
            },
        );
        let opts = ConnectOptions::for_feature(GoogleFeature::Calendar, true);
        let tokens = oauth
            .connect(&opts, |url| {
                // Simulate the browser: follow the redirect with the given state.
                let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
                let redirect = q["redirect_uri"].clone();
                let state = q["state"].clone();
                tokio::spawn(async move {
                    let u = Url::parse(&redirect).unwrap();
                    let port = u.port().unwrap();
                    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                    let req = format!(
                        "GET /oauth/callback?code=the-code&state={state} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
                    );
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    s.write_all(req.as_bytes()).await.unwrap();
                    let mut out = String::new();
                    let _ = s.read_to_string(&mut out).await;
                });
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(tokens.access_token.expose(), "at");
        assert_eq!(tokens.refresh_token.unwrap().expose(), "rt");
        let body = server.requests()[0].body_str();
        let pairs: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
        assert_eq!(pairs["code"], "the-code");
        assert_eq!(pairs["code_verifier"].len(), 43);
        assert!(pairs["redirect_uri"].starts_with("http://127.0.0.1:"));
    }
}
