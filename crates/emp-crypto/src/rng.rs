//! OS CSPRNG access (SPEC §9.1: OS CSPRNG only). No userspace PRNG is ever seeded or used.

use crate::error::{CryptoError, Result};

/// Fills `buf` from the operating system CSPRNG.
pub(crate) fn fill(buf: &mut [u8]) -> Result<()> {
    getrandom::getrandom(buf).map_err(|_| CryptoError::Rng)
}

/// Returns `N` random bytes.
pub(crate) fn array<const N: usize>() -> Result<[u8; N]> {
    let mut a = [0u8; N];
    fill(&mut a)?;
    Ok(a)
}

/// Returns a uniformly distributed integer in `0..bound` (rejection sampling, no modulo bias).
pub(crate) fn uniform_u32(bound: u32) -> Result<u32> {
    if bound == 0 {
        return Err(CryptoError::InvalidArgument("uniform bound must be > 0"));
    }
    // Largest multiple of `bound` that fits in u32 space; values at or above it are rejected.
    let zone = u32::MAX - (u32::MAX % bound);
    loop {
        let v = u32::from_be_bytes(array::<4>()?);
        if v < zone {
            return Ok(v % bound);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uniform_in_range() {
        for bound in [1u32, 2, 3, 24, 7776] {
            for _ in 0..200 {
                assert!(uniform_u32(bound).unwrap() < bound);
            }
        }
        assert!(uniform_u32(0).is_err());
    }

    #[test]
    fn random_differs() {
        assert_ne!(array::<32>().unwrap(), array::<32>().unwrap());
    }
}
