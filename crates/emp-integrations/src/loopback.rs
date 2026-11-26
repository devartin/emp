//! OAuth loopback redirect listener (RFC 8252 §7.3, SPEC §9.19 item 3).
//!
//! - Binds `127.0.0.1:0`; the redirect URI is `http://127.0.0.1:<port>/oauth/callback`.
//! - Accepts only `GET /oauth/callback` with `Host: 127.0.0.1:<port>`.
//! - Compares `state` in constant time; requests with a wrong state are rejected and the
//!   listener keeps waiting.
//! - Accepts exactly one valid request, then shuts down; times out (default 5 minutes).
//! - Replies with a self-contained page under `Content-Security-Policy: default-src 'none'`.
//!
//! Connections are served concurrently so an idle browser pre-connect cannot block the real
//! callback.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

use crate::error::{IntegrationError, Result};
use crate::secret::SecretString;

/// Callback path.
pub const CALLBACK_PATH: &str = "/oauth/callback";
/// Default wait for the user to finish in the browser.
pub const DEFAULT_CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Text shown in the browser after the redirect.
pub const DONE_TEXT: &str = "You can close this tab and return to EMP.";

const MAX_HEAD: usize = 8 * 1024;
const CONN_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// A bound loopback listener waiting for one OAuth redirect.
#[derive(Debug)]
pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
}

/// What the browser delivered on the valid callback.
#[derive(Debug)]
pub enum CallbackResult {
    /// The authorization code.
    Code(SecretString),
    /// The authorization server reported an error (e.g. `access_denied`).
    Error(String),
}

enum ConnOutcome {
    /// Not a valid callback (bad host/path/method/state); keep listening.
    Ignored,
    /// The single valid callback.
    Done(CallbackResult),
}

impl LoopbackListener {
    /// Bind `127.0.0.1` on an ephemeral port.
    pub async fn bind() -> Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .map_err(|e| IntegrationError::Io(format!("loopback bind failed: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| IntegrationError::Io(e.to_string()))?
            .port();
        Ok(LoopbackListener { listener, port })
    }

    /// The bound port.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://127.0.0.1:<port>/oauth/callback`.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// Wait for the single valid callback whose `state` equals `expected_state`.
    /// Consumes the listener: the socket closes when this returns.
    pub async fn wait(self, expected_state: &SecretString, timeout: Duration) -> Result<CallbackResult> {
        let expected = Arc::new(expected_state.clone());
        let claimed = Arc::new(AtomicBool::new(false));
        let host = format!("127.0.0.1:{}", self.port);
        let deadline = tokio::time::Instant::now() + timeout;
        let mut conns: JoinSet<ConnOutcome> = JoinSet::new();

        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(IntegrationError::AuthTimeout);
                }
                accepted = self.listener.accept() => {
                    let Ok((stream, peer)) = accepted else { continue };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let expected = expected.clone();
                    let claimed = claimed.clone();
                    let host = host.clone();
                    conns.spawn(async move {
                        serve(stream, &host, &expected, &claimed).await.unwrap_or(ConnOutcome::Ignored)
                    });
                }
                Some(joined) = conns.join_next(), if !conns.is_empty() => {
                    if let Ok(ConnOutcome::Done(result)) = joined {
                        return Ok(result);
                    }
                }
            }
        }
    }

    /// Like [`wait`](Self::wait) but maps an `error=` callback to [`IntegrationError::OAuth`].
    pub async fn wait_for_code(self, expected_state: &SecretString, timeout: Duration) -> Result<SecretString> {
        match self.wait(expected_state, timeout).await? {
            CallbackResult::Code(code) => Ok(code),
            CallbackResult::Error(e) => Err(IntegrationError::OAuth(format!("authorization failed: {e}"))),
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    expected_host: &str,
    expected_state: &SecretString,
    claimed: &AtomicBool,
) -> std::io::Result<ConnOutcome> {
    let head = match tokio::time::timeout(CONN_READ_TIMEOUT, read_head(&mut stream)).await {
        Ok(Ok(Some(h))) => h,
        _ => {
            return Ok(ConnOutcome::Ignored);
        }
    };
    let (status, outcome) = evaluate(&head, expected_host, expected_state, claimed);
    let body = match status {
        200 => format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>EMP</title></head><body><p>{DONE_TEXT}</p></body></html>"
        ),
        _ => "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>EMP</title></head><body><p>Invalid request.</p></body></html>".to_string(),
    };
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Security-Policy: default-src 'none'\r\n\
         Cache-Control: no-store\r\n\
         Referrer-Policy: no-referrer\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\
         Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    Ok(outcome)
}

async fn read_head(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            buf.truncate(end);
            return Ok(String::from_utf8(buf).ok());
        }
        if buf.len() > MAX_HEAD {
            return Ok(None);
        }
    }
}

/// Decide the response for a request head. Pure, for testing.
fn evaluate(
    head: &str,
    expected_host: &str,
    expected_state: &SecretString,
    claimed: &AtomicBool,
) -> (u16, ConnOutcome) {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return (400, ConnOutcome::Ignored);
    };
    if parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return (400, ConnOutcome::Ignored);
    }
    let mut hosts = lines
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim());
    let host = hosts.next();
    if host != Some(expected_host) || hosts.next().is_some() {
        return (400, ConnOutcome::Ignored);
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return (404, ConnOutcome::Ignored);
    }
    if method != "GET" {
        return (405, ConnOutcome::Ignored);
    }
    let mut state = None;
    let mut code = None;
    let mut error = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        let slot = match k.as_ref() {
            "state" => &mut state,
            "code" => &mut code,
            "error" => &mut error,
            _ => continue,
        };
        if slot.is_some() {
            // Duplicate parameters are a red flag.
            return (400, ConnOutcome::Ignored);
        }
        *slot = Some(SecretString::new(v.into_owned()));
    }
    let Some(state) = state else {
        return (400, ConnOutcome::Ignored);
    };
    if !expected_state.ct_eq_str(state.expose()) {
        return (400, ConnOutcome::Ignored);
    }
    if claimed.swap(true, Ordering::SeqCst) {
        // State is single-use.
        return (400, ConnOutcome::Ignored);
    }
    match (code, error) {
        (_, Some(err)) => {
            let err: String = err
                .expose()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .take(64)
                .collect();
            (200, ConnOutcome::Done(CallbackResult::Error(err)))
        }
        (Some(code), None) if !code.is_empty() => (200, ConnOutcome::Done(CallbackResult::Code(code))),
        _ => (200, ConnOutcome::Done(CallbackResult::Error("missing_code".into()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn raw_request(port: u16, request: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    fn get(port: u16, target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: test\r\n\r\n")
    }

    #[tokio::test]
    async fn accepts_valid_callback_after_rejecting_bad_ones() {
        let listener = LoopbackListener::bind().await.unwrap();
        let port = listener.port();
        assert_eq!(listener.redirect_uri(), format!("http://127.0.0.1:{port}/oauth/callback"));
        let state = SecretString::new("expected-state");
        let waiter = tokio::spawn(async move { listener.wait_for_code(&state, Duration::from_secs(10)).await });

        // An idle pre-connect that never sends anything must not block the real callback.
        let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

        let r = raw_request(port, &get(port, "/oauth/callback?code=c&state=wrong")).await;
        assert!(r.starts_with("HTTP/1.1 400"), "{r}");
        let r = raw_request(port, &format!("GET /oauth/callback?code=c&state=expected-state HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 400"), "host check: {r}");
        let r = raw_request(port, &get(port, "/favicon.ico")).await;
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        let r = raw_request(port, &format!("POST /oauth/callback?code=c&state=expected-state HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 405"), "{r}");

        let r = raw_request(port, &get(port, "/oauth/callback?code=4%2F0Abc&scope=email&state=expected-state")).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert!(r.contains("Content-Security-Policy: default-src 'none'"));
        assert!(r.contains(DONE_TEXT));

        let code = waiter.await.unwrap().unwrap();
        assert_eq!(code.expose(), "4/0Abc");

        // Listener is gone after one valid request.
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test]
    async fn error_callback_is_reported() {
        let listener = LoopbackListener::bind().await.unwrap();
        let port = listener.port();
        let state = SecretString::new("s1");
        let waiter = tokio::spawn(async move { listener.wait_for_code(&state, Duration::from_secs(10)).await });
        let r = raw_request(port, &get(port, "/oauth/callback?error=access_denied&state=s1")).await;
        assert!(r.starts_with("HTTP/1.1 200"));
        let err = waiter.await.unwrap().unwrap_err();
        assert!(matches!(err, IntegrationError::OAuth(ref m) if m.contains("access_denied")), "{err:?}");
    }

    #[tokio::test]
    async fn times_out() {
        let listener = LoopbackListener::bind().await.unwrap();
        let err = listener
            .wait_for_code(&SecretString::new("s"), Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::AuthTimeout));
        assert_eq!(err.code(), crate::ErrorCode::Cancelled);
    }

    #[test]
    fn evaluate_rules() {
        let st = SecretString::new("abc");
        let host = "127.0.0.1:5000";
        let check = |head: &str| {
            let claimed = AtomicBool::new(false);
            evaluate(head, host, &st, &claimed).0
        };
        assert_eq!(check("GET /oauth/callback?state=abc&code=x HTTP/1.1\r\nHost: 127.0.0.1:5000"), 200);
        assert_eq!(check("GET /oauth/callback?state=abc&code=x HTTP/1.1\r\nHost: 127.0.0.1:5001"), 400);
        assert_eq!(check("GET /oauth/callback?state=abc&code=x HTTP/1.1"), 400);
        assert_eq!(
            check("GET /oauth/callback?state=abc&code=x HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nHost: 127.0.0.1:5000"),
            400
        );
        assert_eq!(check("GET /oauth/callback?state=abc&state=abc&code=x HTTP/1.1\r\nHost: 127.0.0.1:5000"), 400);
        assert_eq!(check("GET /oauth/callback?code=x HTTP/1.1\r\nHost: 127.0.0.1:5000"), 400);
        assert_eq!(check("GET http://127.0.0.1:5000/oauth/callback?state=abc HTTP/1.1\r\nHost: 127.0.0.1:5000"), 404);
        assert_eq!(check("GARBAGE"), 400);

        // Single use.
        let claimed = AtomicBool::new(false);
        let head = "GET /oauth/callback?state=abc&code=x HTTP/1.1\r\nHost: 127.0.0.1:5000";
        assert_eq!(evaluate(head, host, &st, &claimed).0, 200);
        assert_eq!(evaluate(head, host, &st, &claimed).0, 400);
    }
}
