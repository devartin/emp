//! The provider trait. Implementations build requests and parse responses with pure helper
//! functions (unit-tested on fixtures) and send through NetGuard.

use async_trait::async_trait;
use chrono::NaiveDate;

use super::{Bar, Capability, Dividend, FxRates, Quote, SearchResult, Symbol};
use crate::error::{IntegrationError, Result};
use crate::netguard::ConnectorId;
use crate::secret::SecretString;

/// Static provider description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderMeta {
    /// Provider id (`stooq`, …).
    pub id: &'static str,
    /// Display name.
    pub name: &'static str,
    /// NetGuard connector.
    pub connector: ConnectorId,
    /// Needs a user API key.
    pub needs_key: bool,
    /// Terms of use URL.
    pub terms_url: &'static str,
    /// Unofficial "Community source".
    pub community: bool,
    /// Capabilities.
    pub caps: &'static [Capability],
    /// Enabled by default.
    pub default_enabled: bool,
}

fn unsupported<T>(what: &str) -> Result<T> {
    Err(IntegrationError::Unsupported(what.to_string()))
}

/// A market data provider. Every method has an "unsupported" default so providers only
/// implement their capabilities.
#[async_trait]
pub trait MarketProvider: Send + Sync {
    /// Static description.
    fn meta(&self) -> ProviderMeta;

    /// Provider id.
    fn id(&self) -> &'static str {
        self.meta().id
    }

    /// Ready to use (key present when needed).
    fn configured(&self) -> bool {
        !self.meta().needs_key
    }

    /// Install or clear the user's API key (kept in memory; storage is the caller's job).
    fn set_api_key(&self, _key: Option<SecretString>) {}

    /// Provider-specific symbol for `symbol`, or `None` if the provider cannot serve it.
    /// `override_symbol` comes from the securities payload's `providerSymbols`.
    fn map_symbol(&self, symbol: &Symbol, override_symbol: Option<&str>) -> Option<String>;

    /// Latest quote.
    async fn quote(&self, _symbol: &Symbol, _provider_symbol: &str) -> Result<Quote> {
        unsupported("quote")
    }

    /// Several quotes; the default calls [`quote`](Self::quote) for each.
    async fn quotes(&self, items: &[(Symbol, String)]) -> Vec<Result<Quote>> {
        let mut out = Vec::with_capacity(items.len());
        for (s, p) in items {
            out.push(self.quote(s, p).await);
        }
        out
    }

    /// Daily bars in `[from, to]`, ascending.
    async fn daily(
        &self,
        _symbol: &Symbol,
        _provider_symbol: &str,
        _from: NaiveDate,
        _to: NaiveDate,
        _adjusted: bool,
    ) -> Result<Vec<Bar>> {
        unsupported("daily bars")
    }

    /// Symbol search.
    async fn search(&self, _query: &str, _limit: usize) -> Result<Vec<SearchResult>> {
        unsupported("search")
    }

    /// FX rates for `base` (all currencies when `symbols` is empty), latest or on `date`.
    async fn fx(
        &self,
        _base: &str,
        _symbols: &[String],
        _date: Option<NaiveDate>,
    ) -> Result<FxRates> {
        unsupported("fx")
    }

    /// Dividends with ex-date in `[from, to]`.
    async fn dividends(
        &self,
        _symbol: &Symbol,
        _provider_symbol: &str,
        _from: NaiveDate,
        _to: NaiveDate,
    ) -> Result<Vec<Dividend>> {
        unsupported("dividends")
    }

    /// Cheap connectivity check for `market_provider_test`.
    async fn ping(&self) -> Result<()>;
}
