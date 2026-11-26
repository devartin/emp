//! Zeroizing secret strings. Tokens, API keys, client secrets and PKCE verifiers are carried as
//! [`SecretString`]: memory is wiped on drop and `Debug` never prints the value.

use std::fmt;

use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

/// A string secret that is zeroized on drop and redacted in `Debug`.
///
/// Storing it (encrypted, as a `secret:` record) is the caller's job; this crate only hands
/// secrets out and takes them back in.
#[derive(Clone, Default)]
pub struct SecretString(Zeroizing<String>);

impl SecretString {
    /// Wrap a string. The original allocation moves into the zeroizing wrapper.
    pub fn new(value: impl Into<String>) -> Self {
        SecretString(Zeroizing::new(value.into()))
    }

    /// Borrow the secret value. Never log the result.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }

    /// Length in bytes.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the secret is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Constant-time equality with another byte string.
    pub fn ct_eq_str(&self, other: &str) -> bool {
        let a = self.0.as_bytes();
        let b = other.as_bytes();
        // Length is not secret for our uses (fixed-size random values), but compare anyway.
        a.len() == b.len() && bool::from(a.ct_eq(b))
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(***)")
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        SecretString::new(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        SecretString::new(value)
    }
}

impl PartialEq for SecretString {
    fn eq(&self, other: &Self) -> bool {
        self.ct_eq_str(other.expose())
    }
}

impl Eq for SecretString {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let s = SecretString::new("ya29.very-secret");
        assert_eq!(format!("{s:?}"), "SecretString(***)");
        assert_eq!(s.expose(), "ya29.very-secret");
    }

    #[test]
    fn equality_is_value_based() {
        assert_eq!(SecretString::new("a"), SecretString::from("a"));
        assert_ne!(SecretString::new("a"), SecretString::from("ab"));
        assert!(SecretString::new("xyz").ct_eq_str("xyz"));
        assert!(!SecretString::new("xyz").ct_eq_str("xyZ"));
    }
}
