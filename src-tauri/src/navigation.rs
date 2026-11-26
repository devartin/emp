//! Navigation policy and external links (SPEC §9.13 "Navigation", §11.3 `open_external`).
//!
//! The webview may only navigate inside the app origin. Every other URL is denied; http(s) URLs are routed to the
//! `open_external` confirmation flow instead. `open_external` accepts `https:`, `http:` (with a warning) and
//! `mailto:`; the UI confirms the host (shown in Unicode and punycode) unless the user remembered it.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use url::Url;

use crate::error::{ApiError, ApiResult};
use crate::validate::MAX_URL;

/// How long a pending confirmation stays answerable.
pub const CONFIRM_TTL: Duration = Duration::from_secs(5 * 60);
/// At most this many remembered hosts.
pub const MAX_REMEMBERED_HOSTS: usize = 1_000;

/// `true` for URLs the main webview may navigate to: the bundled app (`tauri://localhost/*`,
/// `http(s)://tauri.localhost/*`) and, in debug builds only, the configured dev server origin.
#[must_use]
pub fn is_app_url(url: &Url, dev_origin: Option<&Url>) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "tauri" => host == "localhost",
        "http" | "https" if host == "tauri.localhost" => true,
        _ => cfg!(debug_assertions) && dev_origin.is_some_and(|d| d.origin() == url.origin()),
    }
}

/// A validated external link.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalUrl {
    /// The normalised URL to hand to the OS opener.
    pub url: String,
    /// The host for display (Unicode).
    pub host: String,
    /// The host as sent on the wire (punycode / ASCII).
    pub punycode: String,
    /// `http:` (unencrypted) — the UI shows a warning.
    pub insecure: bool,
}

/// Validates a URL for `open_external`.
pub fn classify_external(raw: &str) -> ApiResult<ExternalUrl> {
    if raw.len() > MAX_URL {
        return Err(ApiError::invalid("url", "the link is too long"));
    }
    let url = Url::parse(raw.trim()).map_err(|_| ApiError::invalid("url", "not a valid link"))?;
    match url.scheme() {
        "https" | "http" => {
            if !url.username().is_empty() || url.password().is_some() {
                return Err(ApiError::invalid(
                    "url",
                    "links with embedded credentials are not opened",
                ));
            }
            let ascii = url
                .host_str()
                .filter(|h| !h.is_empty())
                .ok_or_else(|| ApiError::invalid("url", "the link has no host"))?
                .to_ascii_lowercase();
            let (unicode, _) = idna::domain_to_unicode(&ascii);
            Ok(ExternalUrl {
                insecure: url.scheme() == "http",
                url: url.to_string(),
                host: unicode,
                punycode: ascii,
            })
        }
        "mailto" => {
            let addr = url.path();
            let domain = addr
                .split(',')
                .next()
                .and_then(|a| a.rsplit_once('@'))
                .map(|(_, d)| d.to_ascii_lowercase())
                .filter(|d| !d.is_empty())
                .ok_or_else(|| ApiError::invalid("url", "not a valid email link"))?;
            let ascii = idna::domain_to_ascii(&percent_decode(&domain))
                .map_err(|_| ApiError::invalid("url", "not a valid email link"))?;
            let (unicode, _) = idna::domain_to_unicode(&ascii);
            Ok(ExternalUrl {
                url: url.to_string(),
                host: unicode,
                punycode: ascii,
                insecure: false,
            })
        }
        _ => Err(ApiError::invalid(
            "url",
            "only https, http and mailto links can be opened",
        )),
    }
}

fn percent_decode(s: &str) -> String {
    crate::protocol::percent_decode(s)
}

struct Pending {
    target: ExternalUrl,
    created: Instant,
}

/// Pending confirmations and remembered hosts.
#[derive(Default)]
pub struct ExternalLinks {
    pending: Mutex<HashMap<String, Pending>>,
    remembered: Mutex<HashSet<String>>,
}

impl ExternalLinks {
    /// `true` if the user chose "always open links to this host".
    #[must_use]
    pub fn is_remembered(&self, punycode_host: &str) -> bool {
        self.remembered.lock().contains(punycode_host)
    }

    /// Replaces the remembered set (loaded from the vault after unlock).
    pub fn set_remembered(&self, hosts: impl IntoIterator<Item = String>) {
        let mut set = self.remembered.lock();
        set.clear();
        set.extend(hosts.into_iter().take(MAX_REMEMBERED_HOSTS));
    }

    /// The remembered hosts, sorted.
    #[must_use]
    pub fn remembered(&self) -> Vec<String> {
        let mut v: Vec<String> = self.remembered.lock().iter().cloned().collect();
        v.sort();
        v
    }

    /// Registers a pending confirmation and returns its request id.
    pub fn begin(&self, target: ExternalUrl) -> ApiResult<String> {
        let mut b = [0u8; 16];
        getrandom::getrandom(&mut b).map_err(|_| ApiError::internal("rng"))?;
        let id = hex::encode(b);
        let now = Instant::now();
        let mut p = self.pending.lock();
        p.retain(|_, v| now.duration_since(v.created) < CONFIRM_TTL);
        if p.len() >= 64 {
            return Err(ApiError::new(
                crate::error::ErrorCode::RateLimited,
                "too many links are waiting for confirmation",
            ));
        }
        p.insert(
            id.clone(),
            Pending {
                target,
                created: now,
            },
        );
        Ok(id)
    }

    /// Resolves a pending confirmation (single use). Returns the target when `allow` is true.
    pub fn answer(
        &self,
        request_id: &str,
        allow: bool,
        remember: bool,
    ) -> ApiResult<Option<ExternalUrl>> {
        let pending = self
            .pending
            .lock()
            .remove(request_id)
            .ok_or_else(|| ApiError::not_found("link request"))?;
        if pending.created.elapsed() >= CONFIRM_TTL {
            return Err(ApiError::invalid("requestId", "this request expired"));
        }
        if !allow {
            return Ok(None);
        }
        if remember {
            let mut set = self.remembered.lock();
            if set.len() < MAX_REMEMBERED_HOSTS {
                set.insert(pending.target.punycode.clone());
            }
        }
        Ok(Some(pending.target))
    }

    /// Forgets pending requests and remembered hosts (on lock).
    pub fn clear(&self) {
        self.pending.lock().clear();
        self.remembered.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_urls() {
        let app = |s: &str| is_app_url(&Url::parse(s).unwrap(), None);
        assert!(app("tauri://localhost/#/home"));
        assert!(app("http://tauri.localhost/index.html"));
        assert!(!app("https://example.com/"));
        assert!(!app("tauri://evil/"));
        assert!(!app("file:///etc/passwd"));
        let dev = Url::parse("http://localhost:1420").unwrap();
        assert_eq!(
            is_app_url(
                &Url::parse("http://localhost:1420/#/x").unwrap(),
                Some(&dev)
            ),
            cfg!(debug_assertions)
        );
        assert!(!is_app_url(
            &Url::parse("http://localhost:1421/").unwrap(),
            Some(&dev)
        ));
        assert!(!is_app_url(
            &Url::parse("http://tauri.localhost.evil.com/").unwrap(),
            None
        ));
    }

    #[test]
    fn classifies_external_links() {
        let e = classify_external("https://Example.com/path?q=1").unwrap();
        assert_eq!(e.punycode, "example.com");
        assert!(!e.insecure);
        let e = classify_external("http://example.com").unwrap();
        assert!(e.insecure);
        let e = classify_external("https://xn--mnchen-3ya.de/").unwrap();
        assert_eq!(e.host, "münchen.de");
        assert_eq!(e.punycode, "xn--mnchen-3ya.de");
        let e = classify_external("https://bücher.example/").unwrap();
        assert_eq!(e.punycode, "xn--bcher-kva.example");
        let e = classify_external("mailto:someone@example.org?subject=hi").unwrap();
        assert_eq!(e.punycode, "example.org");
    }

    #[test]
    fn rejects_dangerous_links() {
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "emp://page/x",
            "https://user:pw@example.com/",
            "mailto:nobody",
            "not a url",
            "vbscript:x",
        ] {
            assert!(classify_external(bad).is_err(), "{bad}");
        }
        assert!(classify_external(&format!("https://e.com/{}", "a".repeat(5000))).is_err());
    }

    #[test]
    fn confirmations_are_single_use_and_remember_hosts() {
        let links = ExternalLinks::default();
        let target = classify_external("https://example.com/a").unwrap();
        let id = links.begin(target.clone()).unwrap();
        assert!(!links.is_remembered("example.com"));
        assert_eq!(links.answer(&id, true, true).unwrap(), Some(target));
        assert!(links.is_remembered("example.com"));
        assert!(links.answer(&id, true, false).is_err());
        let id = links
            .begin(classify_external("https://other.com").unwrap())
            .unwrap();
        assert_eq!(links.answer(&id, false, true).unwrap(), None);
        assert!(!links.is_remembered("other.com"));
        links.clear();
        assert!(links.remembered().is_empty());
    }
}
