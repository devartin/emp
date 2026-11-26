//! Known-answer tests (SPEC §9.1) against `tests/vectors/vectors.json`.
//!
//! The vectors are produced by `tests/vectors/gen_vectors.py`, an independent Python implementation of the
//! primitives and EMP formats (hashlib/hmac, `cryptography`'s Argon2id and ChaCha20-Poly1305 plus a local
//! HChaCha20). The published RFC / draft outputs are additionally pinned as literals below.

use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use secrecy::SecretString;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::blob::{BlobHeader, WrappedFileKey};
use crate::envelope::{Compression, Extra, RecordAad, SealOptions, TableTag};
use crate::kdf::{KdfParams, derive_password_kek};
use crate::keys::{Dek, FileKey, RecoveryKey, SubKey, VaultId, VaultKeys};
use crate::keyslot::{Keyslot, SlotKdf};
use crate::mac::{MsetRoot, RowHash};
use crate::stream::{StreamEncryptor, StreamLayout};

const VECTORS: &str = include_str!("../tests/vectors/vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn hx(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}

fn arr<const N: usize>(v: &Value) -> [u8; N] {
    hx(v).try_into().unwrap()
}

fn num(v: &Value) -> u64 {
    v.as_u64().unwrap()
}

#[test]
fn argon2id_rfc9106() {
    let v = &vectors()["argon2id_rfc9106"];
    let ad = hx(&v["ad"]);
    let secret = hx(&v["secret"]);
    let mut b = ParamsBuilder::new();
    b.m_cost(32)
        .t_cost(3)
        .p_cost(4)
        .output_len(32)
        .data(AssociatedData::new(&ad).unwrap());
    let a = Argon2::new_with_secret(
        &secret,
        Algorithm::Argon2id,
        Version::V0x13,
        b.build().unwrap(),
    )
    .unwrap();
    let mut out = [0u8; 32];
    a.hash_password_into(&hx(&v["password"]), &hx(&v["salt"]), &mut out)
        .unwrap();
    assert_eq!(out.to_vec(), hx(&v["tag"]));
    // Published value (RFC 9106 §5.3).
    assert_eq!(
        hex::encode(out),
        "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
    );
}

#[test]
fn argon2id_emp_wrapper() {
    for v in vectors()["argon2id_emp"].as_array().unwrap() {
        let params = KdfParams {
            m_kib: num(&v["m_kib"]) as u32,
            t: num(&v["t"]) as u32,
            p: num(&v["p"]) as u32,
        };
        let pw = SecretString::from(v["password"].as_str().unwrap().to_owned());
        let kek = derive_password_kek(&pw, &hx(&v["salt"]), &params).unwrap();
        assert_eq!(kek.expose().to_vec(), hx(&v["kek"]), "{params:?}");
    }
}

#[test]
fn hkdf_rfc5869() {
    for v in vectors()["hkdf_rfc5869"].as_array().unwrap() {
        let okm_expected = hx(&v["okm"]);
        let salt = hx(&v["salt"]);
        let hk = Hkdf::<Sha256>::new(Some(&salt), &hx(&v["ikm"]));
        let mut okm = vec![0u8; okm_expected.len()];
        hk.expand(&hx(&v["info"]), &mut okm).unwrap();
        assert_eq!(okm, okm_expected);
    }
    assert_eq!(
        vectors()["hkdf_rfc5869"][0]["okm"].as_str().unwrap(),
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    );
}

#[test]
fn hmac_rfc4231() {
    for v in vectors()["hmac_rfc4231"].as_array().unwrap() {
        let mut m = <Hmac<Sha256> as Mac>::new_from_slice(&hx(&v["key"])).unwrap();
        m.update(&hx(&v["data"]));
        assert_eq!(m.finalize().into_bytes().to_vec(), hx(&v["mac"]));
    }
    assert_eq!(
        vectors()["hmac_rfc4231"][0]["mac"].as_str().unwrap(),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
    // The crate's own helper agrees.
    let key = [0x0bu8; 32];
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(&key).unwrap();
    m.update(b"abc");
    assert_eq!(
        crate::mac::hmac(&key, &[b"a", b"bc"]).unwrap().to_vec(),
        m.finalize().into_bytes().to_vec()
    );
}

#[test]
fn xchacha_draft() {
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};
    let v = &vectors()["xchacha_draft"];
    let key: [u8; 32] = arr(&v["key"]);
    let c = XChaCha20Poly1305::new((&key).into());
    let nonce = hx(&v["nonce"]);
    let sealed = c
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &hx(&v["plaintext"]),
                aad: &hx(&v["aad"]),
            },
        )
        .unwrap();
    assert_eq!(sealed, hx(&v["sealed"]));
    // Published tag (draft-irtf-cfrg-xchacha-03 §A.3.1).
    assert_eq!(
        hex::encode(&sealed[sealed.len() - 16..]),
        "c0875924c1c7987947deafd8780acf49"
    );
}

struct Emp {
    v: Value,
    keys: VaultKeys,
    vid: VaultId,
}

fn emp() -> Emp {
    let v = vectors()["emp"].clone();
    let dek = Dek::from_parts(
        SubKey::copy_from(&hx(&v["dek"])).unwrap(),
        num(&v["epoch"]) as u16,
    );
    let vid = VaultId::from_slice(&hx(&v["vault_id"])).unwrap();
    let keys = VaultKeys::derive(&dek, &vid).unwrap();
    Emp { v, keys, vid }
}

fn emp_dek(e: &Emp) -> Dek {
    Dek::from_parts(SubKey::copy_from(&hx(&e.v["dek"])).unwrap(), 1)
}

#[test]
fn emp_subkeys() {
    let e = emp();
    for (label, k) in e.v["subkeys"].as_object().unwrap() {
        assert_eq!(
            e.keys.subkey_bytes(label).unwrap().to_vec(),
            hx(k),
            "{label}"
        );
    }
}

#[test]
fn emp_envelopes() {
    let e = emp();
    for env in e.v["envelopes"].as_array().unwrap() {
        let table = TableTag::from_u8(num(&env["table_tag"]) as u8).unwrap();
        let extra_bytes = hx(&env["extra"]);
        let extra = match table {
            TableTag::Kv => Extra::kv("ui", "sidebar.width").unwrap(),
            _ => Extra::none(),
        };
        assert_eq!(extra.as_bytes(), extra_bytes.as_slice());
        let loc = RecordAad::new(
            table,
            env["id"].as_str().unwrap(),
            env["kind"].as_str().unwrap(),
            num(&env["rev"]),
        )
        .with_extra(extra);
        let body = hx(&env["body"]);
        let opts = SealOptions {
            compression: Compression::Auto,
            pad: env["pad"].as_bool().unwrap(),
        };
        let sealed = e
            .keys
            .seal_record_with_nonce(&loc, &body, opts, arr(&env["nonce"]))
            .unwrap();
        assert_eq!(sealed, hx(&env["envelope"]), "{table:?}");
        assert_eq!(
            e.keys
                .open_record(&loc, &hx(&env["envelope"]))
                .unwrap()
                .as_slice(),
            body.as_slice()
        );
    }
}

#[test]
fn emp_keyslots() {
    let e = emp();
    let dek = emp_dek(&e);
    let ks = &e.v["keyslot_password"];
    let params = KdfParams {
        m_kib: num(&ks["m_kib"]) as u32,
        t: num(&ks["t"]) as u32,
        p: num(&ks["p"]) as u32,
    };
    assert_eq!(params.to_cbor(), hx(&ks["kdf_params"]));
    let pw = SecretString::from(ks["password"].as_str().unwrap().to_owned());
    let slot = Keyslot::wrap_password_fixed(
        &e.vid,
        num(&ks["slot_id"]) as u32,
        &dek,
        &pw,
        &params,
        arr(&ks["salt"]),
        arr(&ks["nonce"]),
        0,
    )
    .unwrap();
    assert_eq!(slot.to_columns().wrapped_dek, hx(&ks["wrapped_dek"]));
    assert_eq!(
        slot.unwrap_password(&e.vid, &pw).unwrap().expose(),
        dek.expose()
    );

    let rs = &e.v["keyslot_recovery"];
    let rk = RecoveryKey::copy_from(&hx(&rs["recovery_entropy"])).unwrap();
    let words = rk.words().unwrap();
    assert_eq!(words[23], "art");
    let kek = rk.derive_kek(&e.vid).unwrap();
    assert_eq!(kek.expose().to_vec(), hx(&rs["kek"]));
    let slot = Keyslot::wrap(
        &kek,
        &e.vid,
        2,
        SlotKdf::HkdfSha256,
        &dek,
        0,
        arr(&rs["nonce"]),
    )
    .unwrap();
    assert_eq!(slot.to_columns().wrapped_dek, hx(&rs["wrapped_dek"]));
    let rk2 = RecoveryKey::from_words(&words).unwrap();
    assert_eq!(
        slot.unwrap_recovery(&e.vid, &rk2).unwrap().expose(),
        dek.expose()
    );
}

#[test]
fn emp_manifest() {
    let e = emp();
    let m = &e.v["manifest"];
    let envs = e.v["envelopes"].as_array().unwrap();
    let h0 = e
        .keys
        .row_hash(
            TableTag::Pages,
            envs[0]["id"].as_str().unwrap(),
            &Extra::none(),
            7,
            &hx(&envs[0]["envelope"]),
        )
        .unwrap();
    assert_eq!(h0.as_bytes().to_vec(), hx(&m["row_hash_0"]));
    let h2 = e
        .keys
        .row_hash(
            TableTag::Kv,
            "",
            &Extra::kv("ui", "sidebar.width").unwrap(),
            0,
            &hx(&envs[2]["envelope"]),
        )
        .unwrap();
    assert_eq!(h2.as_bytes().to_vec(), hx(&m["row_hash_2"]));
    let root = MsetRoot::from_hashes([&h0, &h2] as [&RowHash; 2]);
    assert_eq!(root.as_bytes().to_vec(), hx(&m["mset_root"]));
    let mac = e
        .keys
        .state_mac(num(&m["write_counter"]), &root, &arr(&m["keyslots_digest"]))
        .unwrap();
    assert_eq!(mac.to_vec(), hx(&m["state_mac"]));
}

#[test]
fn emp_blob() {
    let e = emp();
    let b = &e.v["blob"];
    let content: Vec<u8> = (0..num(&b["content_len"]) as usize)
        .map(|i| ((i * 7) % 256) as u8)
        .collect();
    let digest: [u8; 32] = Sha256::digest(&content).into();
    assert_eq!(digest.to_vec(), hx(&b["content_sha256"]));
    let name = e.keys.blob_name(&digest).unwrap();
    assert_eq!(name.as_str(), b["blob_name"].as_str().unwrap());

    let fk = FileKey::copy_from(&hx(&b["file_key"])).unwrap();
    let wrapped = e
        .keys
        .wrap_file_key_with_nonce(&name, &fk, arr(&b["wrap_nonce"]))
        .unwrap();
    assert_eq!(wrapped.to_bytes().to_vec(), hx(&b["wrapped_fk"]));
    let unwrapped = e
        .keys
        .unwrap_file_key(
            &name,
            &WrappedFileKey::from_bytes(&hx(&b["wrapped_fk"])).unwrap(),
        )
        .unwrap();
    assert_eq!(unwrapped.expose(), fk.expose());

    let header = BlobHeader {
        prefix: arr(&b["prefix"]),
        layout: StreamLayout::for_content(content.len() as u64).unwrap(),
    };
    let mut enc = StreamEncryptor::new(
        fk.expose(),
        header.to_bytes(),
        &header.prefix,
        content.len() as u64,
        Vec::new(),
    )
    .unwrap();
    enc.write_content(&content).unwrap();
    let file = enc.finish().unwrap();
    assert_eq!(file.len() as u64, num(&b["file_len"]));
    assert_eq!(Sha256::digest(&file).to_vec(), hx(&b["file_sha256"]));
    assert_eq!(
        crate::blob::open_blob(&fk, &file).unwrap().as_slice(),
        content.as_slice()
    );
}
