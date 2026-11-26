//! Id generation: UUIDv7 record ids, 32-hex asset ids, `secret:` ids and 12-character block ids.

use crate::{Result, StoreError};

/// Alphabet of block ids (`[0-9A-Za-z_-]`, SPEC §7.1).
pub const BLOCK_ID_ALPHABET: &[u8; 64] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
/// Block id length.
pub const BLOCK_ID_LEN: usize = 12;

/// A new lowercase hyphenated UUIDv7 (the default record id).
#[must_use]
pub fn new_id() -> String {
    uuid::Uuid::now_v7().hyphenated().to_string()
}

/// A new asset id: UUIDv7 as 32 lowercase hex characters, matching the `emp-asset` protocol's
/// `^[0-9a-f]{32}$` (SPEC §9.7).
#[must_use]
pub fn new_asset_id() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

/// `true` if `s` is a valid asset id.
#[must_use]
pub fn is_asset_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Fills `buf` from the OS CSPRNG.
pub fn random_bytes(buf: &mut [u8]) -> Result<()> {
    getrandom::getrandom(buf).map_err(|_| StoreError::Internal("OS RNG failure".into()))
}

/// A new random secret id: `secret:<32 hex>` (SPEC §9.20).
pub fn new_secret_id() -> Result<String> {
    let mut b = [0u8; 16];
    random_bytes(&mut b)?;
    Ok(format!("secret:{}", hex::encode(b)))
}

/// A new 12-character nanoid block id.
pub fn new_block_id() -> Result<String> {
    let mut b = [0u8; BLOCK_ID_LEN];
    random_bytes(&mut b)?;
    Ok(b.iter()
        .map(|x| char::from(BLOCK_ID_ALPHABET[usize::from(x & 63)]))
        .collect())
}

/// `true` if `s` is a well-formed block id.
#[must_use]
pub fn is_block_id(s: &str) -> bool {
    s.len() == BLOCK_ID_LEN && s.bytes().all(|b| BLOCK_ID_ALPHABET.contains(&b))
}

/// `true` if `s` looks like a record id (UUID text, any version, lowercase) — used to bound inputs.
#[must_use]
pub fn is_record_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'z' | b'-' | b':' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_expected_shapes() {
        let id = new_id();
        assert_eq!(id.len(), 36);
        assert!(is_record_id(&id));
        assert!(is_asset_id(&new_asset_id()));
        let b = new_block_id().unwrap();
        assert!(is_block_id(&b));
        let s = new_secret_id().unwrap();
        assert!(s.starts_with("secret:") && s.len() == 39);
        assert!(!is_asset_id("../etc/passwd"));
    }

    #[test]
    fn uuid_v7_sorts_by_time() {
        let a = new_id();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = new_id();
        assert!(a < b);
    }
}
