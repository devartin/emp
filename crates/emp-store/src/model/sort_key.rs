//! Base-62 fractional indexing for `sort_key` columns (SPEC §10.2), byte-compatible with the
//! rocicorp `fractional-indexing` scheme used by `src/lib/fractional-index.ts`, so keys generated in Rust and
//! TypeScript interleave. Keys compare with plain byte order.

use crate::{Result, StoreError};

/// The digit alphabet.
pub const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: u8 = b'0';
const MAX_DIGIT: u8 = b'z';
/// The key returned for an empty list.
pub const INTEGER_ZERO: &str = "a0";

fn err(msg: &str) -> StoreError {
    StoreError::invalid_field("sortKey", format!("invalid sort key: {msg}"))
}

fn digit_index(c: u8) -> Result<usize> {
    DIGITS
        .iter()
        .position(|&d| d == c)
        .ok_or_else(|| err("non base-62 digit"))
}

fn digit(i: usize) -> Result<u8> {
    DIGITS
        .get(i)
        .copied()
        .ok_or_else(|| err("digit out of range"))
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> Result<Vec<u8>> {
    if let Some(b) = b
        && a >= b
    {
        return Err(err("a >= b"));
    }
    if a.last() == Some(&ZERO) || b.and_then(|b| b.last()) == Some(&ZERO) {
        return Err(err("trailing zero"));
    }
    if let Some(b) = b {
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(ZERO) == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..]))?);
            return Ok(out);
        }
    }
    let digit_a = match a.first() {
        Some(&c) => digit_index(c)?,
        None => 0,
    };
    let digit_b = match b {
        Some(b) => match b.first() {
            Some(&c) => digit_index(c)?,
            None => return Err(err("empty upper bound")),
        },
        None => DIGITS.len(),
    };
    if digit_b - digit_a > 1 {
        // Math.round(0.5 * (a + b)) rounds .5 up.
        return Ok(vec![digit((digit_a + digit_b).div_ceil(2))?]);
    }
    if let Some(b) = b
        && b.len() > 1
    {
        return Ok(vec![b[0]]);
    }
    let mut out = vec![digit(digit_a)?];
    out.extend(midpoint(a.get(1..).unwrap_or(&[]), None)?);
    Ok(out)
}

fn integer_length(head: u8) -> Result<usize> {
    match head {
        b'a'..=b'z' => Ok(usize::from(head - b'a') + 2),
        b'A'..=b'Z' => Ok(usize::from(b'Z' - head) + 2),
        _ => Err(err("invalid head")),
    }
}

fn validate_integer(int: &[u8]) -> Result<()> {
    let head = *int.first().ok_or_else(|| err("empty"))?;
    if int.len() != integer_length(head)? {
        return Err(err("invalid integer part"));
    }
    Ok(())
}

fn integer_part(key: &[u8]) -> Result<&[u8]> {
    let head = *key.first().ok_or_else(|| err("empty"))?;
    let len = integer_length(head)?;
    key.get(..len)
        .ok_or_else(|| err("integer part longer than key"))
}

/// Validates a stored or client-supplied key.
pub fn validate_key(key: &str) -> Result<()> {
    let k = key.as_bytes();
    if k.len() > 256 {
        return Err(err("too long"));
    }
    if k.first() == Some(&b'A') && k.len() == 27 && k[1..].iter().all(|&c| c == ZERO) {
        return Err(err("smallest key is reserved"));
    }
    let i = integer_part(k)?;
    let frac = &k[i.len()..];
    if frac.last() == Some(&ZERO) {
        return Err(err("trailing zero"));
    }
    for &c in k {
        digit_index(c)?;
    }
    Ok(())
}

fn increment_integer(x: &[u8]) -> Result<Option<Vec<u8>>> {
    validate_integer(x)?;
    let head = x[0];
    let mut digs = x[1..].to_vec();
    let mut carry = true;
    for d in digs.iter_mut().rev() {
        if !carry {
            break;
        }
        let i = digit_index(*d)? + 1;
        if i == DIGITS.len() {
            *d = ZERO;
        } else {
            *d = digit(i)?;
            carry = false;
        }
    }
    if !carry {
        let mut out = vec![head];
        out.extend(digs);
        return Ok(Some(out));
    }
    if head == b'Z' {
        return Ok(Some(vec![b'a', ZERO]));
    }
    if head == b'z' {
        return Ok(None);
    }
    let h = head + 1;
    if h > b'a' {
        digs.push(ZERO);
    } else {
        digs.pop();
    }
    let mut out = vec![h];
    out.extend(digs);
    Ok(Some(out))
}

fn decrement_integer(x: &[u8]) -> Result<Option<Vec<u8>>> {
    validate_integer(x)?;
    let head = x[0];
    let mut digs = x[1..].to_vec();
    let mut borrow = true;
    for d in digs.iter_mut().rev() {
        if !borrow {
            break;
        }
        let i = digit_index(*d)?;
        if i == 0 {
            *d = MAX_DIGIT;
        } else {
            *d = digit(i - 1)?;
            borrow = false;
        }
    }
    if !borrow {
        let mut out = vec![head];
        out.extend(digs);
        return Ok(Some(out));
    }
    if head == b'a' {
        return Ok(Some(vec![b'Z', MAX_DIGIT]));
    }
    if head == b'A' {
        return Ok(None);
    }
    let h = head - 1;
    if h < b'Z' {
        digs.push(MAX_DIGIT);
    } else {
        digs.pop();
    }
    let mut out = vec![h];
    out.extend(digs);
    Ok(Some(out))
}

fn into_string(v: Vec<u8>) -> Result<String> {
    String::from_utf8(v).map_err(|_| err("non-ASCII"))
}

/// `generateKeyBetween(a, b)`: a key strictly between `a` and `b` (either may be open).
pub fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String> {
    if let Some(a) = a {
        validate_key(a)?;
    }
    if let Some(b) = b {
        validate_key(b)?;
    }
    if let (Some(a), Some(b)) = (a, b)
        && a >= b
    {
        return Err(err("a >= b"));
    }
    match (a.map(str::as_bytes), b.map(str::as_bytes)) {
        (None, None) => Ok(INTEGER_ZERO.to_owned()),
        (None, Some(b)) => {
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if ib.first() == Some(&b'A') && ib.len() == 27 {
                let mut out = ib.to_vec();
                out.extend(midpoint(&[], Some(fb))?);
                return into_string(out);
            }
            if ib.len() < b.len() {
                return into_string(ib.to_vec());
            }
            match decrement_integer(ib)? {
                Some(r) => into_string(r),
                None => Err(err("cannot decrement any more")),
            }
        }
        (Some(a), None) => {
            let ia = integer_part(a)?;
            let fa = &a[ia.len()..];
            match increment_integer(ia)? {
                Some(i) => into_string(i),
                None => {
                    let mut out = ia.to_vec();
                    out.extend(midpoint(fa, None)?);
                    into_string(out)
                }
            }
        }
        (Some(a), Some(b)) => {
            let ia = integer_part(a)?;
            let fa = &a[ia.len()..];
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if ia == ib {
                let mut out = ia.to_vec();
                out.extend(midpoint(fa, Some(fb))?);
                return into_string(out);
            }
            let i = increment_integer(ia)?.ok_or_else(|| err("cannot increment any more"))?;
            if i.as_slice() < b {
                return into_string(i);
            }
            let mut out = ia.to_vec();
            out.extend(midpoint(fa, None)?);
            into_string(out)
        }
    }
}

/// `generateNKeysBetween(a, b, n)`: `n` ascending keys strictly between `a` and `b`.
pub fn n_keys_between(a: Option<&str>, b: Option<&str>, n: usize) -> Result<Vec<String>> {
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![key_between(a, b)?]);
    }
    match (a, b) {
        (_, None) => {
            let mut out = Vec::with_capacity(n);
            let mut c = key_between(a, None)?;
            out.push(c.clone());
            for _ in 1..n {
                c = key_between(Some(&c), None)?;
                out.push(c.clone());
            }
            Ok(out)
        }
        (None, Some(_)) => {
            let mut out = Vec::with_capacity(n);
            let mut c = key_between(None, b)?;
            out.push(c.clone());
            for _ in 1..n {
                c = key_between(None, Some(&c))?;
                out.push(c.clone());
            }
            out.reverse();
            Ok(out)
        }
        (Some(_), Some(_)) => {
            let mid = n / 2;
            let c = key_between(a, b)?;
            let mut out = n_keys_between(a, Some(&c), mid)?;
            out.push(c.clone());
            out.extend(n_keys_between(Some(&c), b, n - mid - 1)?);
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_reference_vectors() {
        // Vectors from the rocicorp/fractional-indexing test-suite.
        let cases: &[(Option<&str>, Option<&str>, &str)] = &[
            (None, None, "a0"),
            (None, Some("a0"), "Zz"),
            (None, Some("Zz"), "Zy"),
            (Some("a0"), None, "a1"),
            (Some("a1"), None, "a2"),
            (Some("a0"), Some("a1"), "a0V"),
            (Some("a1"), Some("a2"), "a1V"),
            (Some("a0V"), Some("a1"), "a0l"),
            (Some("Zz"), Some("a0"), "ZzV"),
            (Some("Zz"), Some("a1"), "a0"),
            (None, Some("Y00"), "Xzzz"),
            (Some("bzz"), None, "c000"),
            (Some("a0"), Some("a0V"), "a0G"),
            (Some("a0"), Some("a0G"), "a08"),
            (Some("b125"), Some("b129"), "b127"),
            (Some("a0"), Some("a1V"), "a1"),
            (Some("Zz"), Some("a01"), "a0"),
            (None, Some("a0V"), "a0"),
            (None, Some("b999"), "b99"),
            (
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzy"),
                None,
                "zzzzzzzzzzzzzzzzzzzzzzzzzzz",
            ),
            (
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz"),
                None,
                "zzzzzzzzzzzzzzzzzzzzzzzzzzzV",
            ),
        ];
        for (a, b, want) in cases {
            assert_eq!(
                &key_between(*a, *b).unwrap(),
                want,
                "between {a:?} and {b:?}"
            );
        }
    }

    #[test]
    fn rejects_bad_input() {
        assert!(key_between(Some("a0"), Some("a0")).is_err());
        assert!(key_between(Some("a00"), None).is_err());
        assert!(key_between(Some("A00000000000000000000000000"), None).is_err());
        assert!(key_between(Some("a"), None).is_err());
        assert!(key_between(Some("a1"), Some("a0")).is_err());
        assert!(key_between(Some("a!"), None).is_err());
    }

    #[test]
    fn n_keys_are_sorted_and_bounded() {
        for (a, b) in [
            (None, None),
            (Some("a0"), None),
            (None, Some("a0")),
            (Some("a0"), Some("a1")),
        ] {
            let keys = n_keys_between(a, b, 25).unwrap();
            assert_eq!(keys.len(), 25);
            for w in keys.windows(2) {
                assert!(w[0] < w[1]);
            }
            if let Some(a) = a {
                assert!(a < keys[0].as_str());
            }
            if let Some(b) = b {
                assert!(keys[24].as_str() < b);
            }
        }
    }

    #[test]
    fn repeated_insertion_stays_ordered() {
        let mut lo = "a0".to_owned();
        let hi = "a1".to_owned();
        for _ in 0..200 {
            let m = key_between(Some(&lo), Some(&hi)).unwrap();
            assert!(lo < m && m < hi);
            lo = m;
        }
    }
}
