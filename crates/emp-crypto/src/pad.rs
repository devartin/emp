//! PADMÉ padding (SPEC §9.5, D-05).
//!
//! `E = floor(log2 L)`, `S = floor(log2 E) + 1`, `lastBits = E − S`, and `L` is rounded up to a multiple of
//! `2^lastBits`. The padded length leaks only `O(log log L)` bits and the overhead is at most ~12%.

/// Returns the PADMÉ length for `len`, or `None` if rounding up would overflow `u64`.
///
/// Lengths 0–1 are returned unchanged (the formula is undefined for them and they need no padding).
#[must_use]
pub fn padme(len: u64) -> Option<u64> {
    if len < 2 {
        return Some(len);
    }
    let e = u64::from(len.ilog2()); // ≥ 1
    let s = u64::from(e.ilog2()) + 1;
    let last_bits = e - s; // e ≥ s for every e ≥ 1
    let mask = (1u64 << last_bits) - 1;
    len.checked_add(mask).map(|v| v & !mask)
}

/// [`padme`] for in-memory sizes.
#[must_use]
pub fn padme_usize(len: usize) -> Option<usize> {
    u64::try_from(len)
        .ok()
        .and_then(padme)
        .and_then(|v| usize::try_from(v).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn known_values() {
        // Small sizes are never padded.
        for l in 0..=7u64 {
            assert_eq!(padme(l), Some(l));
        }
        assert_eq!(padme(9), Some(10)); // E=3, S=2, lastBits=1
        assert_eq!(padme(10), Some(10));
        assert_eq!(padme(17), Some(18)); // E=4, S=3, lastBits=1
        assert_eq!(padme(33), Some(36)); // E=5, S=3, lastBits=2
        assert_eq!(padme(1000), Some(1024)); // E=9, S=4, lastBits=5
        assert_eq!(padme(1025), Some(1088)); // E=10, S=4, lastBits=6
        assert_eq!(padme(65536), Some(65536));
        assert_eq!(padme(65537), Some(67584)); // E=16, S=5, lastBits=11
        assert_eq!(padme(u64::MAX), None);
    }

    proptest! {
        #[test]
        fn monotone_bounded_idempotent(l in 0u64..(1u64 << 40)) {
            let p = padme(l).unwrap();
            prop_assert!(p >= l);
            // Overhead bounded by 12% (+ the tiny-size slack).
            prop_assert!((p - l) as f64 <= (l as f64) * 0.12 + 1.0);
            prop_assert_eq!(padme(p), Some(p));
            prop_assert!(padme(l + 1).unwrap() >= p);
        }
    }
}
