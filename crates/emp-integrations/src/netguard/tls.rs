//! rustls client configuration: ring provider + the platform certificate verifier, falling back
//! to the bundled Mozilla roots if the platform verifier cannot be initialised.

use std::sync::Arc;

use rustls::ClientConfig;
use rustls_platform_verifier::BuilderVerifierExt;

use crate::error::{IntegrationError, Result};

/// Build the TLS configuration used by the NetGuard client.
pub(crate) fn client_config() -> Result<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| IntegrationError::Internal(format!("TLS setup: {e}")))?;
    let mut config = match builder.with_platform_verifier() {
        Ok(b) => b.with_no_client_auth(),
        Err(e) => {
            tracing::warn!("platform TLS verifier unavailable ({e}); using bundled roots");
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| IntegrationError::Internal(format!("TLS setup: {e}")))?
                .with_root_certificates(roots)
                .with_no_client_auth()
        }
    };
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_config_with_alpn() {
        let c = super::client_config().unwrap();
        assert_eq!(c.alpn_protocols[0], b"h2");
    }
}
