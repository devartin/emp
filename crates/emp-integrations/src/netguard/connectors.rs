//! Static connector table: host allowlists and default rate quotas (SPEC §9.18, §17).

use std::num::NonZeroU32;
use std::time::Duration;

use governor::Quota;
use serde::{Deserialize, Serialize};

/// Every egress connector. A request always names exactly one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorId {
    /// Google OAuth and APIs.
    Google,
    /// Frankfurter (ECB FX rates).
    Frankfurter,
    /// Stooq daily CSV.
    Stooq,
    /// CoinGecko public API.
    Coingecko,
    /// Finnhub (user key).
    Finnhub,
    /// Tiingo (user key).
    Tiingo,
    /// Yahoo Finance (community source, P1, off by default).
    Yahoo,
    /// App updater (P1).
    Updater,
    /// User-content remote images: any public host, private ranges blocked.
    RemoteImage,
}

/// Which hosts a connector may reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPolicy {
    /// Exactly these hosts (lowercase).
    Exact(&'static [&'static str]),
    /// Any public host (user content); private addresses are blocked.
    AnyPublic,
}

const GOOGLE_HOSTS: &[&str] = &[
    "oauth2.googleapis.com",
    "www.googleapis.com",
    "sheets.googleapis.com",
    "docs.googleapis.com",
];

impl ConnectorId {
    /// All connectors.
    pub const ALL: [ConnectorId; 9] = [
        ConnectorId::Google,
        ConnectorId::Frankfurter,
        ConnectorId::Stooq,
        ConnectorId::Coingecko,
        ConnectorId::Finnhub,
        ConnectorId::Tiingo,
        ConnectorId::Yahoo,
        ConnectorId::Updater,
        ConnectorId::RemoteImage,
    ];

    /// The id used in logs and IPC (`google`, `remote-image`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectorId::Google => "google",
            ConnectorId::Frankfurter => "frankfurter",
            ConnectorId::Stooq => "stooq",
            ConnectorId::Coingecko => "coingecko",
            ConnectorId::Finnhub => "finnhub",
            ConnectorId::Tiingo => "tiingo",
            ConnectorId::Yahoo => "yahoo",
            ConnectorId::Updater => "updater",
            ConnectorId::RemoteImage => "remote-image",
        }
    }

    /// The connector's host allowlist. `accounts.google.com` is deliberately absent: it is
    /// only ever opened in the system browser.
    pub fn host_policy(self) -> HostPolicy {
        match self {
            ConnectorId::Google => HostPolicy::Exact(GOOGLE_HOSTS),
            ConnectorId::Frankfurter => HostPolicy::Exact(&["api.frankfurter.app"]),
            ConnectorId::Stooq => HostPolicy::Exact(&["stooq.com"]),
            ConnectorId::Coingecko => HostPolicy::Exact(&["api.coingecko.com"]),
            ConnectorId::Finnhub => HostPolicy::Exact(&["finnhub.io"]),
            ConnectorId::Tiingo => HostPolicy::Exact(&["api.tiingo.com"]),
            ConnectorId::Yahoo => {
                HostPolicy::Exact(&["query1.finance.yahoo.com", "query2.finance.yahoo.com"])
            }
            ConnectorId::Updater => HostPolicy::Exact(&[
                // Keyless "latest release" lookup for the update check (Settings › About).
                "api.github.com",
                "github.com",
                "objects.githubusercontent.com",
                "release-assets.githubusercontent.com",
            ]),
            ConnectorId::RemoteImage => HostPolicy::AnyPublic,
        }
    }

    /// Whether `host` (already lowercased) is allowed for this connector by name.
    /// For [`HostPolicy::AnyPublic`] address vetting happens separately.
    pub fn allows_host(self, host: &str) -> bool {
        match self.host_policy() {
            HostPolicy::Exact(hosts) => hosts.contains(&host),
            HostPolicy::AnyPublic => true,
        }
    }

    /// Default request quota for the connector's governor limiter.
    pub fn default_quota(self) -> Quota {
        let n = |v: u32| NonZeroU32::new(v).unwrap_or(NonZeroU32::MIN);
        match self {
            // 300 requests/minute/project (SPEC §17.1).
            ConnectorId::Google => Quota::per_minute(n(300)),
            ConnectorId::Frankfurter => Quota::per_minute(n(60)),
            ConnectorId::Stooq => Quota::per_minute(n(30)),
            // Public API: about 5–15 requests/minute.
            ConnectorId::Coingecko => Quota::per_minute(n(10)),
            // About 60 requests/minute.
            ConnectorId::Finnhub => Quota::per_minute(n(60)),
            // Free tier: 50/hour, 1,000/day.
            ConnectorId::Tiingo => Quota::per_hour(n(50)),
            ConnectorId::Yahoo => Quota::per_minute(n(30)),
            ConnectorId::Updater => Quota::per_minute(n(10)),
            ConnectorId::RemoteImage => Quota::per_minute(n(60)),
        }
    }

    /// Human-readable rate limit for `ProviderInfo.rateLimit`.
    pub fn rate_limit_label(self) -> &'static str {
        match self {
            ConnectorId::Google => "300/min",
            ConnectorId::Frankfurter => "60/min",
            ConnectorId::Stooq => "30/min",
            ConnectorId::Coingecko => "10/min",
            ConnectorId::Finnhub => "60/min",
            ConnectorId::Tiingo => "50/hour, 1,000/day",
            ConnectorId::Yahoo => "30/min",
            ConnectorId::Updater => "10/min",
            ConnectorId::RemoteImage => "60/min",
        }
    }
}

/// Response body caps by response type (SPEC §9.18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyCap {
    /// 5 MiB.
    Default,
    /// 20 MiB.
    Image,
    /// 50 MiB.
    DriveExport,
    /// 20 MiB.
    MarketHistory,
    /// An explicit cap in bytes (never above 50 MiB).
    Bytes(u64),
}

/// Largest cap NetGuard will ever honour.
pub const MAX_BODY_CAP: u64 = 50 * 1024 * 1024;

impl BodyCap {
    /// The cap in bytes.
    pub fn bytes(self) -> u64 {
        const MIB: u64 = 1024 * 1024;
        match self {
            BodyCap::Default => 5 * MIB,
            BodyCap::Image => 20 * MIB,
            BodyCap::DriveExport => 50 * MIB,
            BodyCap::MarketHistory => 20 * MIB,
            BodyCap::Bytes(b) => b.min(MAX_BODY_CAP),
        }
    }
}

/// Circuit breaker: consecutive failures before opening.
pub const BREAKER_THRESHOLD: u32 = 5;
/// Circuit breaker: how long it stays open.
pub const BREAKER_OPEN_FOR: Duration = Duration::from_secs(5 * 60);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_match_spec() {
        assert!(ConnectorId::Google.allows_host("sheets.googleapis.com"));
        assert!(!ConnectorId::Google.allows_host("accounts.google.com"));
        assert!(!ConnectorId::Google.allows_host("evil.googleapis.com.attacker.net"));
        assert!(ConnectorId::Stooq.allows_host("stooq.com"));
        assert!(!ConnectorId::Stooq.allows_host("www.stooq.com"));
        assert!(ConnectorId::RemoteImage.allows_host("example.org"));
        assert_eq!(ConnectorId::RemoteImage.as_str(), "remote-image");
    }

    #[test]
    fn caps_match_spec() {
        assert_eq!(BodyCap::Default.bytes(), 5 * 1024 * 1024);
        assert_eq!(BodyCap::Image.bytes(), 20 * 1024 * 1024);
        assert_eq!(BodyCap::DriveExport.bytes(), 50 * 1024 * 1024);
        assert_eq!(BodyCap::MarketHistory.bytes(), 20 * 1024 * 1024);
        assert_eq!(BodyCap::Bytes(u64::MAX).bytes(), MAX_BODY_CAP);
    }

    #[test]
    fn serde_ids_are_kebab() {
        assert_eq!(
            serde_json::to_string(&ConnectorId::RemoteImage).unwrap(),
            "\"remote-image\""
        );
    }
}
