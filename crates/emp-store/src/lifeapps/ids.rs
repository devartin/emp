//! Deterministic ids for generated content (SPEC §16.1 "Generation").
//!
//! Every record a life app creates gets `UUIDv5(namespace = instance_id, name = templateKey [+ ":" + rowKey])`
//! (RFC 9562 §5.5, SHA-1 based). Re-running a plan therefore yields the same ids, which is what lets tune-ups
//! diff generated content against what is on disk. Block ids inside generated documents are derived the same way
//! so that generated documents are byte-for-byte reproducible.
//!
//! The SHA-1 here is only used as the RFC's name-hashing function, never for security.

use crate::model::ids::BLOCK_ID_ALPHABET;
use crate::{Result, StoreError};

/// Minimal SHA-1 (FIPS 180-4) over a byte slice.
#[must_use]
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// `UUIDv5(namespace, name)` as lowercase hyphenated text.
#[must_use]
pub fn uuid_v5(namespace: &uuid::Uuid, name: &str) -> String {
    let mut buf = Vec::with_capacity(16 + name.len());
    buf.extend_from_slice(namespace.as_bytes());
    buf.extend_from_slice(name.as_bytes());
    let digest = sha1(&buf);
    let mut b = [0u8; 16];
    b.copy_from_slice(&digest[..16]);
    uuid::Builder::from_sha1_bytes(b)
        .into_uuid()
        .hyphenated()
        .to_string()
}

/// Id generator bound to one life-app instance.
#[derive(Clone, Debug)]
pub struct IdGen {
    ns: uuid::Uuid,
}

impl IdGen {
    /// A generator for `instance_id` (must be a UUID).
    pub fn new(instance_id: &str) -> Result<Self> {
        let ns = uuid::Uuid::parse_str(instance_id)
            .map_err(|_| StoreError::invalid_field("instanceId", "not a UUID"))?;
        Ok(Self { ns })
    }

    /// Record id of a template key (`hq`, `accounts`, `accounts:checking`, `accounts.prop:balance`, …).
    #[must_use]
    pub fn id(&self, key: &str) -> String {
        uuid_v5(&self.ns, key)
    }

    /// A 12-character block id derived from `owner` and the block's ordinal.
    #[must_use]
    pub fn block_id(&self, owner: &str, n: usize) -> String {
        let d = sha1(format!("{}|{owner}|{n}", self.ns).as_bytes());
        d.iter()
            .take(crate::model::ids::BLOCK_ID_LEN)
            .map(|x| char::from(BLOCK_ID_ALPHABET[usize::from(x & 63)]))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hexs(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn sha1_vectors() {
        assert_eq!(hexs(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hexs(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hexs(&sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(
            hexs(&sha1(&million)),
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
    }

    #[test]
    fn uuid_v5_matches_rfc_example() {
        // RFC 9562 Appendix A.4: UUIDv5 of "www.example.com" in the DNS namespace.
        let dns = uuid::Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap();
        assert_eq!(
            uuid_v5(&dns, "www.example.com"),
            "2ed6657d-e927-568b-95e1-2665a8aea6a2"
        );
    }

    #[test]
    fn generator_is_deterministic() {
        let g = IdGen::new("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b").unwrap();
        assert_eq!(g.id("hq"), g.id("hq"));
        assert_ne!(g.id("hq"), g.id("accounts"));
        let b = g.block_id("page", 3);
        assert!(crate::model::ids::is_block_id(&b));
        assert_eq!(b, g.block_id("page", 3));
        assert!(IdGen::new("nope").is_err());
    }
}
