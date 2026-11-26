//! Google APIs (SPEC §17.1): Calendar read with incremental sync, Docs import/export through
//! Drive, Sheets import/export.
//!
//! Every API module exposes **pure request builders** (`*_request`) and **pure parsers**
//! (`parse_*`) plus an async convenience function driven by a [`GoogleSession`], which keeps
//! the access token in memory and refreshes it on demand.

pub mod calendar;
pub mod convert;
pub mod docs;
pub mod docs_html;
pub mod drive;
pub mod sheets;

use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::Mutex;

use crate::error::{IntegrationError, Result};
use crate::netguard::{NetGuard, NetRequest, NetResponse};
use crate::oauth::{GoogleOAuth, TokenSet};
use crate::secret::SecretString;

pub use convert::BlockColor;

/// Refresh the access token when it expires within this margin.
pub const REFRESH_MARGIN: Duration = Duration::from_secs(60);

/// A connected Google account: the refresh token (owned by the caller's secret store) plus an
/// in-memory access token.
#[derive(Debug)]
pub struct GoogleSession {
    oauth: GoogleOAuth,
    guard: NetGuard,
    refresh_token: SecretString,
    access: Mutex<Option<(SecretString, DateTime<Utc>)>>,
}

impl GoogleSession {
    /// A session that will obtain access tokens with `refresh_token`.
    pub fn new(guard: NetGuard, oauth: GoogleOAuth, refresh_token: SecretString) -> Self {
        GoogleSession {
            oauth,
            guard,
            refresh_token,
            access: Mutex::new(None),
        }
    }

    /// A session seeded with the tokens from a fresh connect, so no refresh is needed yet.
    /// Returns `None` when the token set carries no refresh token.
    pub fn from_tokens(guard: NetGuard, oauth: GoogleOAuth, tokens: &TokenSet) -> Option<Self> {
        let refresh = tokens.refresh_token.clone()?;
        Some(GoogleSession {
            oauth,
            guard,
            refresh_token: refresh,
            access: Mutex::new(Some((tokens.access_token.clone(), tokens.expires_at))),
        })
    }

    /// The NetGuard this session sends through.
    pub fn guard(&self) -> &NetGuard {
        &self.guard
    }

    /// A valid access token, refreshing if missing or about to expire.
    /// `invalid_grant` surfaces as [`IntegrationError::ReauthRequired`].
    pub async fn access_token(&self) -> Result<SecretString> {
        let mut slot = self.access.lock().await;
        let margin = chrono::Duration::from_std(REFRESH_MARGIN).unwrap_or(chrono::Duration::zero());
        if let Some((token, expires_at)) = slot.as_ref()
            && *expires_at > Utc::now() + margin
        {
            return Ok(token.clone());
        }
        let fresh = self.oauth.refresh(&self.refresh_token).await?;
        *slot = Some((fresh.access_token.clone(), fresh.expires_at));
        Ok(fresh.access_token)
    }

    /// Forget the cached access token (e.g. after a 401).
    pub async fn invalidate(&self) {
        *self.access.lock().await = None;
    }

    /// Build a request with the current access token and send it. On HTTP 401 the token is
    /// refreshed once and the request retried.
    pub async fn send<F>(&self, build: F) -> Result<NetResponse>
    where
        F: Fn(&SecretString) -> Result<NetRequest>,
    {
        let token = self.access_token().await?;
        let resp = self.guard.send(build(&token)?).await?;
        if resp.status != 401 {
            return Ok(resp);
        }
        self.invalidate().await;
        let token = self.access_token().await?;
        let resp = self.guard.send(build(&token)?).await?;
        if resp.status == 401 {
            return Err(IntegrationError::AuthRequired);
        }
        Ok(resp)
    }
}

/// Extract the file id following `/<kind>/d/` in a Google URL on `expected_host`, or accept a
/// bare id. Ids are `[A-Za-z0-9_-]+` (SPEC §17.1).
pub(crate) fn extract_file_id(input: &str, kind: &str, expected_host: &str) -> Result<String> {
    let s = input.trim();
    if s.len() > 4096 {
        return Err(IntegrationError::Invalid("URL too long".into()));
    }
    let valid_id = |id: &str| {
        (10..=200).contains(&id.len())
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    if !s.contains('/') {
        return if valid_id(s) {
            Ok(s.to_string())
        } else {
            Err(IntegrationError::Invalid("not a Google file id".into()))
        };
    }
    let url =
        url::Url::parse(s).map_err(|_| IntegrationError::Invalid("not a valid URL".into()))?;
    if url.scheme() != "https" || url.host_str() != Some(expected_host) {
        return Err(IntegrationError::Invalid(format!(
            "expected a {expected_host} link"
        )));
    }
    let segments: Vec<&str> = url.path_segments().map(|p| p.collect()).unwrap_or_default();
    let pos = segments
        .windows(2)
        .position(|w| w[0] == kind && w[1] == "d")
        .ok_or_else(|| IntegrationError::Invalid(format!("no /{kind}/d/ id in the link")))?;
    let id = segments.get(pos + 2).copied().unwrap_or("");
    if valid_id(id) {
        Ok(id.to_string())
    } else {
        Err(IntegrationError::Invalid("malformed file id".into()))
    }
}

/// Percent-encode one URL path segment.
pub(crate) fn path_segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netguard::testing::guard_for;
    use crate::netguard::{ConnectorId, Credential};
    use crate::oauth::ClientCredentials;
    use crate::testutil::{Reply, TestServer};

    #[test]
    fn file_id_extraction() {
        let id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789";
        assert_eq!(
            extract_file_id(
                &format!("https://docs.google.com/document/d/{id}/edit#heading=h.1"),
                "document",
                "docs.google.com"
            )
            .unwrap(),
            id
        );
        assert_eq!(
            extract_file_id(
                &format!("https://docs.google.com/a/example.com/spreadsheets/d/{id}/edit?gid=0"),
                "spreadsheets",
                "docs.google.com"
            )
            .unwrap(),
            id
        );
        assert_eq!(
            extract_file_id(id, "document", "docs.google.com").unwrap(),
            id
        );
        for bad in [
            format!("https://evil.com/document/d/{id}/edit"),
            format!("http://docs.google.com/document/d/{id}/edit"),
            "https://docs.google.com/document/u/0/".to_string(),
            "https://docs.google.com/document/d/short/edit".to_string(),
            "abc".to_string(),
            format!("https://docs.google.com/spreadsheets/d/{id}"),
        ] {
            assert!(
                extract_file_id(&bad, "document", "docs.google.com").is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn path_segments_are_encoded() {
        assert_eq!(path_segment("a b/c@d"), "a%20b%2Fc%40d");
        assert_eq!(path_segment("primary"), "primary");
    }

    #[tokio::test]
    async fn session_refreshes_and_retries_on_401() {
        let server = TestServer::start(vec![
            Reply::json(
                200,
                r#"{"access_token":"t1","expires_in":3600,"token_type":"Bearer"}"#,
            ),
            Reply::json(401, r#"{"error":{"message":"expired"}}"#),
            Reply::json(
                200,
                r#"{"access_token":"t2","expires_in":3600,"token_type":"Bearer"}"#,
            ),
            Reply::json(200, r#"{"items":[]}"#),
        ])
        .await;
        let guard = guard_for(
            &["oauth2.googleapis.com", "www.googleapis.com"],
            server.addr(),
        );
        let oauth = GoogleOAuth::new(
            guard.clone(),
            ClientCredentials {
                client_id: "cid".into(),
                client_secret: None,
            },
        );
        let session = GoogleSession::new(guard, oauth, SecretString::new("rt"));
        let resp = session
            .send(|tok| {
                Ok(NetRequest::get(
                    ConnectorId::Google,
                    url::Url::parse("https://www.googleapis.com/calendar/v3/users/me/calendarList")
                        .unwrap(),
                    "/calendar/v3/users/me/calendarList",
                )
                .credential(Credential::bearer(tok)))
            })
            .await
            .unwrap();
        assert_eq!(resp.status, 200);
        let reqs = server.requests();
        assert_eq!(reqs.len(), 4);
        assert_eq!(reqs[1].header("authorization"), Some("Bearer t1"));
        assert_eq!(reqs[3].header("authorization"), Some("Bearer t2"));
        // Cached afterwards.
        assert_eq!(session.access_token().await.unwrap().expose(), "t2");
    }

    #[tokio::test]
    async fn session_surfaces_reauth_required() {
        let server =
            TestServer::start(vec![Reply::json(400, r#"{"error":"invalid_grant"}"#)]).await;
        let guard = guard_for(&["oauth2.googleapis.com"], server.addr());
        let oauth = GoogleOAuth::new(
            guard.clone(),
            ClientCredentials {
                client_id: "cid".into(),
                client_secret: None,
            },
        );
        let session = GoogleSession::new(guard, oauth, SecretString::new("rt"));
        let err = session.access_token().await.unwrap_err();
        assert_eq!(err.code().as_str(), "REAUTH_REQUIRED");
    }
}
