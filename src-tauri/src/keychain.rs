//! Device-key storage in the OS keychain (SPEC §9.2).
//!
//! The device key of an unencrypted vault lives in the OS keychain under service `com.devartin.ultranote` (the
//! bundle identifier), account `device-key/<vault_id hex>`. When no keychain is available (headless Linux without
//! a Secret Service, a locked keychain…) the key falls back to `<data>/device.key` (mode 0600) and Security Center
//! warns that API keys are obfuscated, not protected.

use std::sync::Arc;

use emp_crypto::{DeviceKey, VaultId};
use emp_store::{DeviceKeyStore, FileDeviceKeyStore, Result as StoreResult, StoreError};

/// Keychain service name.
pub const SERVICE: &str = "com.devartin.ultranote";

/// The keychain account for a vault's device key.
#[must_use]
pub fn account_for(vault_id: &VaultId) -> String {
    format!("device-key/{}", vault_id.to_hex())
}

/// Device-key store backed by the OS keychain, with a file fallback.
pub struct KeychainDeviceKeyStore {
    keychain: bool,
    file: FileDeviceKeyStore,
}

impl KeychainDeviceKeyStore {
    /// Probes the keychain; uses `fallback` when it is unavailable.
    #[must_use]
    pub fn new(fallback: FileDeviceKeyStore) -> Arc<Self> {
        let keychain = probe();
        if !keychain {
            tracing::warn!("no OS keychain available; device keys fall back to device.key");
        }
        Arc::new(Self {
            keychain,
            file: fallback,
        })
    }

    /// Whether the OS keychain is in use (`VaultStatus.keychainAvailable`, `app_info.features`).
    #[must_use]
    pub fn keychain_available(&self) -> bool {
        self.keychain
    }
}

fn entry(vault_id: &VaultId) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, &account_for(vault_id))
}

fn probe() -> bool {
    let Ok(e) = keyring::Entry::new(SERVICE, "probe") else {
        return false;
    };
    matches!(e.get_secret(), Ok(_) | Err(keyring::Error::NoEntry))
}

fn kc_err(e: &keyring::Error) -> StoreError {
    tracing::warn!(kind = %keychain_error_kind(e), "keychain error");
    StoreError::Io(std::io::Error::other("keychain unavailable"))
}

fn keychain_error_kind(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::PlatformFailure(_) => "platform_failure",
        keyring::Error::NoStorageAccess(_) => "no_storage_access",
        keyring::Error::NoEntry => "no_entry",
        keyring::Error::BadEncoding(_) => "bad_encoding",
        keyring::Error::TooLong(..) => "too_long",
        keyring::Error::Invalid(..) => "invalid",
        keyring::Error::Ambiguous(_) => "ambiguous",
        _ => "other",
    }
}

impl DeviceKeyStore for KeychainDeviceKeyStore {
    fn load(&self, vault_id: &VaultId) -> StoreResult<Option<DeviceKey>> {
        if self.keychain {
            match entry(vault_id).and_then(|e| e.get_secret()) {
                Ok(bytes) => {
                    let bytes = zeroize::Zeroizing::new(bytes);
                    return Ok(Some(DeviceKey::from_bytes(&bytes)?));
                }
                Err(keyring::Error::NoEntry) => {}
                Err(e) => {
                    // Fall through to the file: a key may have been written there while the keychain was down.
                    let _ = kc_err(&e);
                }
            }
        }
        self.file.load(vault_id)
    }

    fn save(&self, vault_id: &VaultId, key: &DeviceKey) -> StoreResult<()> {
        if self.keychain {
            match entry(vault_id).and_then(|e| e.set_secret(key.expose_secret())) {
                Ok(()) => {
                    // Never keep a second copy on disk once the keychain holds it.
                    let _ = self.file.delete(vault_id);
                    return Ok(());
                }
                Err(e) => {
                    let _ = kc_err(&e);
                }
            }
        }
        self.file.save(vault_id, key)
    }

    fn delete(&self, vault_id: &VaultId) -> StoreResult<()> {
        if self.keychain {
            match entry(vault_id).and_then(|e| e.delete_credential()) {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(kc_err(&e)),
            }
        }
        self.file.delete(vault_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_names_follow_spec() {
        let id = VaultId::generate().unwrap();
        let a = account_for(&id);
        assert!(a.starts_with("device-key/"));
        assert_eq!(a.len(), "device-key/".len() + 32);
    }

    #[test]
    fn falls_back_to_file_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = KeychainDeviceKeyStore {
            keychain: false,
            file: FileDeviceKeyStore::new(dir.path().join("device.key")),
        };
        let id = VaultId::generate().unwrap();
        assert!(store.load(&id).unwrap().is_none());
        let key = DeviceKey::generate().unwrap();
        store.save(&id, &key).unwrap();
        let back = store.load(&id).unwrap().unwrap();
        assert_eq!(back.expose_secret(), key.expose_secret());
        store.delete(&id).unwrap();
        assert!(store.load(&id).unwrap().is_none());
    }
}
