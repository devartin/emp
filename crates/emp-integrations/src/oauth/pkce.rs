//! PKCE (RFC 7636, method S256) and random `state` values.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::secret::SecretString;

/// A PKCE verifier/challenge pair.
#[derive(Debug, Clone)]
pub struct Pkce {
    verifier: SecretString,
    challenge: String,
}

impl Pkce {
    /// `code_verifier` = base64url(32 random bytes) (43 chars);
    /// `code_challenge` = base64url(SHA-256(verifier)).
    pub fn generate() -> Self {
        let verifier = random_token();
        let challenge = Self::challenge_for(&verifier);
        Pkce {
            verifier,
            challenge,
        }
    }

    /// The S256 challenge for a verifier.
    pub fn challenge_for(verifier: &SecretString) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.expose().as_bytes()))
    }

    /// The verifier (sent only in the token exchange).
    pub fn verifier(&self) -> &SecretString {
        &self.verifier
    }

    /// The challenge (sent in the authorization URL).
    pub fn challenge(&self) -> &str {
        &self.challenge
    }
}

/// base64url of 32 bytes from the OS CSPRNG (used for `state` and the PKCE verifier).
pub fn random_token() -> SecretString {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let out = SecretString::new(URL_SAFE_NO_PAD.encode(bytes));
    bytes.zeroize();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_vector() {
        let v = SecretString::new("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(
            Pkce::challenge_for(&v),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn tokens_are_random_and_url_safe() {
        let a = random_token();
        let b = random_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(
            a.expose()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }
}
