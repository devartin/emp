//! A tiny deterministic PRNG (SplitMix64) for bootstrap resampling. Determinism matters: forecast bands are
//! seeded with `vault_id ‖ month` so the same data always yields the same band.

use sha2::{Digest, Sha256};

/// SplitMix64 generator.
#[derive(Debug, Clone)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    /// Creates a generator from a seed.
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform index in `0..n` (`n > 0`), using Lemire's multiply-shift reduction.
    pub fn below(&mut self, n: usize) -> usize {
        if n <= 1 {
            return 0;
        }
        ((u128::from(self.next_u64()) * n as u128) >> 64) as usize
    }

    /// Uniform `f64` in `[0, 1)`.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Derives a seed from text parts (e.g. `vault_id`, `"2026-11"`) by hashing them with a unit separator.
pub fn seed_from(parts: &[&str]) -> u64 {
    let mut h = Sha256::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            h.update([0x1f]);
        }
        h.update(p.as_bytes());
    }
    let d = h.finalize();
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[..8]);
    u64::from_be_bytes(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_bounded() {
        let mut a = SplitMix64::new(seed_from(&["vault", "2026-11"]));
        let mut b = SplitMix64::new(seed_from(&["vault", "2026-11"]));
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
            assert!(a.below(7) < 7);
            let f = a.next_f64();
            assert!((0.0..1.0).contains(&f));
            b.below(7);
            b.next_f64();
        }
        assert_ne!(seed_from(&["a", "b"]), seed_from(&["ab"]));
    }
}
