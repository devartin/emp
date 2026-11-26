//! Fuzz-style property tests: every parser and decryptor that sees bytes from disk, a backup file or IPC must
//! return a typed error — never panic, overflow or allocate without bound — on arbitrary and on mutated valid input.

use proptest::prelude::*;
use secrecy::SecretString;

use crate::backup::{
    PasswordContainerHeader, SnapshotPrefix, open_password_container, open_with_password,
    seal_with_password,
};
use crate::blob::{
    BLOB_HEADER_LEN, BlobHeader, WrappedFileKey, blob_range_reader, open_blob, seal_blob,
};
use crate::envelope::{EnvelopeHeader, decompress_bounded};
use crate::kdf::KdfParams;
use crate::keys::FileKey;
use crate::keys::test_support::fixed_keys;
use crate::keyslot::Keyslot;
use crate::mac::BlobName;
use crate::password::CommonPasswords;
use crate::stream::StreamLayout;
use crate::{CryptoError, RecoveryKey};

fn pw(s: &str) -> SecretString {
    SecretString::from(s.to_owned())
}

fn mutate(mut data: Vec<u8>, flips: &[(usize, u8)], cut: Option<usize>, extra: &[u8]) -> Vec<u8> {
    for &(pos, mask) in flips {
        if data.is_empty() {
            break;
        }
        let i = pos % data.len();
        data[i] ^= mask.max(1);
    }
    if let Some(c) = cut
        && !data.is_empty()
    {
        data.truncate(c % data.len());
    }
    data.extend_from_slice(extra);
    data
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn parsers_never_panic(data in proptest::collection::vec(any::<u8>(), 0..256)) {
        let _ = Keyslot::decode(&data);
        let _ = KdfParams::from_cbor(&data);
        let _ = BlobHeader::parse(&data);
        let _ = WrappedFileKey::from_bytes(&data);
        let _ = PasswordContainerHeader::parse(&data);
        let _ = SnapshotPrefix::parse(&data);
        let _ = EnvelopeHeader::peek(&data);
        let _ = CommonPasswords::from_bytes(&data);
        let _ = decompress_bounded(&data, 1 << 20);
        let _ = fixed_keys(1).verify_snapshot_bytes(&data);
        let _ = BlobName::parse(&String::from_utf8_lossy(&data));
        let _ = RecoveryKey::from_phrase(&String::from_utf8_lossy(&data));
    }

    #[test]
    fn keyslot_columns_never_panic(
        slot_id in any::<i64>(),
        kind in prop::sample::select(vec!["password", "recovery", "device", "x", ""]),
        kdf in prop::sample::select(vec!["argon2id-v13", "hkdf-sha256", "none", "argon2id"]),
        params in proptest::collection::vec(any::<u8>(), 0..24),
        salt in proptest::collection::vec(any::<u8>(), 0..20),
        nonce in proptest::collection::vec(any::<u8>(), 0..30),
        wrapped in proptest::collection::vec(any::<u8>(), 0..60),
        epoch in any::<i64>(),
        created in any::<i64>(),
    ) {
        if let Ok(slot) = Keyslot::from_columns(slot_id, kind, kdf, &params, &salt, &nonce, &wrapped, epoch, created) {
            // Anything accepted round-trips and stays within the KDF bounds.
            let enc = slot.encode().unwrap();
            prop_assert_eq!(Keyslot::decode(&enc).unwrap(), slot.clone());
            if let Some(p) = slot.kdf_params() {
                prop_assert!(p.validate().is_ok());
            }
            // Unwrapping with the wrong key fails cleanly (the wrapped DEK is random bytes here).
            let vid = crate::VaultId::from_bytes([3; 16]);
            if slot.kind() == crate::KeyslotKind::Recovery {
                let rk = RecoveryKey::generate().unwrap();
                prop_assert!(slot.unwrap_recovery(&vid, &rk).is_err());
            }
            if slot.kind() == crate::KeyslotKind::Device {
                let dk = crate::DeviceKey::generate().unwrap();
                prop_assert!(slot.unwrap_device(&vid, &dk).is_err());
            }
        }
    }

    #[test]
    fn stream_layout_arithmetic_never_overflows(padded in any::<u64>()) {
        if let Ok(l) = StreamLayout::from_padded_len(padded) {
            let n = l.chunk_count();
            prop_assert!(n >= 1);
            prop_assert!(l.ciphertext_len() >= l.padded_len());
            let _ = l.chunk_plain_len(n.saturating_sub(1));
            let _ = l.chunk_plain_len(u64::MAX);
        }
    }

    #[test]
    fn mutated_blobs_fail_cleanly(
        content in proptest::collection::vec(any::<u8>(), 0..3000),
        flips in proptest::collection::vec((any::<usize>(), any::<u8>()), 0..3),
        cut in proptest::option::of(any::<usize>()),
        extra in proptest::collection::vec(any::<u8>(), 0..3),
        ranges in proptest::collection::vec((any::<u64>(), any::<u64>()), 1..4),
    ) {
        let fk = FileKey::generate().unwrap();
        let sealed = seal_blob(&fk, &content).unwrap();
        let data = mutate(sealed.clone(), &flips, cut, &extra);
        let unchanged = data == sealed;
        match open_blob(&fk, &data) {
            Ok(out) => prop_assert!(unchanged && out.as_slice() == content.as_slice()),
            Err(e) => prop_assert!(!unchanged, "{e:?}"),
        }
        // Random access over the same (possibly damaged) bytes, with arbitrary ranges.
        if let Ok(mut rr) = blob_range_reader(&fk, std::io::Cursor::new(&data)) {
            for (off, len) in ranges {
                if let Ok(part) = rr.read_range(off, len.min(1 << 16)) {
                    prop_assert!(unchanged);
                    let start = usize::try_from(off.min(content.len() as u64)).unwrap();
                    prop_assert_eq!(part.as_slice(), &content[start..start + part.len()]);
                }
            }
        }
        // A wrong key never decrypts.
        prop_assert!(open_blob(&FileKey::generate().unwrap(), &data).is_err());
        prop_assert!(data.len() >= BLOB_HEADER_LEN || open_blob(&fk, &data).is_err());
    }

    #[test]
    fn mutated_password_containers_fail_cleanly(
        content in proptest::collection::vec(any::<u8>(), 0..2000),
        flips in proptest::collection::vec((any::<usize>(), any::<u8>()), 0..3),
        cut in proptest::option::of(any::<usize>()),
    ) {
        let sealed = seal_with_password(&pw("container password"), &KdfParams::INSECURE_TEST, &content).unwrap();
        let data = mutate(sealed.clone(), &flips, cut, &[]);
        let unchanged = data == sealed;
        match open_with_password(&pw("container password"), &data) {
            Ok(out) => prop_assert!(unchanged && out.as_slice() == content.as_slice()),
            Err(e) => prop_assert!(!unchanged, "{e:?}"),
        }
        if let Ok(r) = open_password_container(&pw("wrong password!"), data.as_slice()) {
            prop_assert!(r.read_to_end_checked().is_err());
        }
    }
}

#[test]
fn password_container_with_out_of_bounds_kdf_is_rejected_before_the_kdf() {
    // A crafted header asking for 4 TiB of Argon2 memory (or 0 passes) must fail the bounds check, not run.
    let sealed =
        seal_with_password(&pw("container password"), &KdfParams::INSECURE_TEST, b"x").unwrap();
    for (offset, value) in [(9usize, u32::MAX), (13, 0), (17, 0), (17, 1000)] {
        let mut bad = sealed.clone();
        bad[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
        assert!(matches!(
            open_with_password(&pw("container password"), &bad),
            Err(CryptoError::InvalidKdfParams(_))
        ));
    }
}
