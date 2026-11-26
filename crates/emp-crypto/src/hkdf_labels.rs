//! HKDF-SHA256 info strings (SPEC §9.2, §9.4). `salt = vault_id`, output 32 bytes.

/// `k_records`: record envelopes for every table except `secrets`.
pub const RECORDS: &str = "emp/v1/records";
/// `k_assets`: wraps per-blob file keys.
pub const ASSETS: &str = "emp/v1/assets";
/// `k_secrets`: record envelopes for the `secrets` table.
pub const SECRETS: &str = "emp/v1/secrets";
/// `k_manifest`: integrity manifest row hashes and the state MAC.
pub const MANIFEST: &str = "emp/v1/manifest";
/// `k_blob_id`: keyed blob names.
pub const BLOB_ID: &str = "emp/v1/blob-id";
/// `k_backup_mac`: snapshot / backup container MAC.
pub const BACKUP_MAC: &str = "emp/v1/backup-mac";
/// `k_header_mac`: MAC over canonical `vault_meta`.
pub const HEADER_MAC: &str = "emp/v1/header-mac";
/// `k_search`: encrypted search-index snapshot (P1).
pub const SEARCH: &str = "emp/v1/search";
/// `k_blind`: keyed hashes of remote ids and cache keys.
pub const BLIND_INDEX: &str = "emp/v1/blind-index";
/// `KEK_rec`: recovery-key KEK (`ikm` = the 32-byte recovery entropy).
pub const KEK_RECOVERY: &str = "emp/v1/kek/recovery";

/// Every DEK subkey label, in §9.4 table order.
pub const ALL_SUBKEYS: [&str; 9] = [
    RECORDS,
    ASSETS,
    SECRETS,
    MANIFEST,
    BLOB_ID,
    BACKUP_MAC,
    HEADER_MAC,
    SEARCH,
    BLIND_INDEX,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_distinct() {
        let mut v: Vec<&str> = ALL_SUBKEYS.to_vec();
        v.push(KEK_RECOVERY);
        let n = v.len();
        v.sort_unstable();
        v.dedup();
        assert_eq!(v.len(), n);
        assert!(v.iter().all(|l| l.starts_with("emp/v1/")));
    }
}
