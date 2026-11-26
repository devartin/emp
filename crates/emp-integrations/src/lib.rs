//! # emp-integrations
//!
//! Everything in EMP that talks to the network, plus the calendar file format:
//!
//! - [`netguard`]: the single egress client (SPEC §9.18) — allowlists, offline switch, caps,
//!   redirect policy, rate limits, retries, circuit breakers — and [`netlog`], its request log.
//! - [`oauth`] and [`loopback`]: Google OAuth 2.0 for installed apps (RFC 8252 + RFC 7636 PKCE,
//!   SPEC §9.19). Token *storage* is the caller's job; tokens are returned as zeroizing
//!   [`SecretString`]s.
//! - [`google`]: Calendar read with incremental sync, Docs import/export via Drive, Sheets
//!   import/export (SPEC §17.1).
//! - [`market`]: market data providers behind [`market::MarketProvider`] and a caching,
//!   fallback-chain [`market::MarketRouter`] (SPEC §17.2).
//! - [`ics`]: RFC 5545 parse/generate with RRULE passthrough, timezones and capped expansion
//!   (SPEC §17.3, §9.16).
//!
//! The crate has no internal workspace dependencies. Integrations must only be driven while
//! the vault is unlocked (SPEC §9.19 item 8); enforcing that is the app's job.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod error;
pub mod google;
pub mod ics;
pub mod loopback;
pub mod market;
pub mod netguard;
pub mod netlog;
pub mod oauth;
mod secret;

#[cfg(test)]
pub(crate) mod testutil;

pub use error::{ErrorCode, IntegrationError, Result};
pub use netguard::{ConnectorId, NetGuard, NetGuardConfig};
pub use netlog::{NetLog, NetLogEntry};
pub use secret::SecretString;
