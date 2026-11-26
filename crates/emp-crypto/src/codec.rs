//! Small, bounds-checked binary encoding helpers (`lp(x) = u32be(len(x)) || x`, big-endian integers, hex).

use crate::error::{CryptoError, Result};

/// Appends `lp(bytes) = u32be(len) || bytes`.
pub(crate) fn put_lp(out: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    let len =
        u32::try_from(bytes.len()).map_err(|_| CryptoError::TooLarge("length-prefixed field"))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

/// Returns `lp(bytes)` as a new vector.
pub(crate) fn lp(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut v = Vec::with_capacity(bytes.len().saturating_add(4));
    put_lp(&mut v, bytes)?;
    Ok(v)
}

/// A forward-only cursor over a byte slice. Every read is bounds-checked and returns `Malformed(what)` on underrun.
pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    what: &'static str,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8], what: &'static str) -> Self {
        Self { buf, what }
    }

    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let (head, tail) = self
            .buf
            .split_at_checked(n)
            .ok_or(CryptoError::Malformed(self.what))?;
        self.buf = tail;
        Ok(head)
    }

    pub(crate) fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        let s = self.take(N)?;
        s.try_into().map_err(|_| CryptoError::Malformed(self.what))
    }

    pub(crate) fn u8(&mut self) -> Result<u8> {
        Ok(u8::from_be_bytes(self.array::<1>()?))
    }

    pub(crate) fn u16be(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    pub(crate) fn u32be(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    pub(crate) fn u64be(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    pub(crate) fn i64be(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.array()?))
    }

    /// Reads `lp(x)` and returns `x`, refusing lengths above `max`.
    pub(crate) fn lp(&mut self, max: usize) -> Result<&'a [u8]> {
        let len = usize::try_from(self.u32be()?).map_err(|_| CryptoError::Malformed(self.what))?;
        if len > max {
            return Err(CryptoError::Malformed(self.what));
        }
        self.take(len)
    }

    pub(crate) fn remaining(&self) -> usize {
        self.buf.len()
    }

    /// Fails unless every byte was consumed.
    pub(crate) fn finish(self) -> Result<()> {
        if self.buf.is_empty() {
            Ok(())
        } else {
            Err(CryptoError::Malformed(self.what))
        }
    }
}

/// Lowercase hex encoding.
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        s.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap_or('0'));
    }
    s
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// Decodes lowercase hex into exactly `N` bytes. Uppercase is rejected (ids are canonical lowercase).
pub fn hex_decode_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    let bytes = s.as_bytes();
    if bytes.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (o, pair) in out.iter_mut().zip(bytes.chunks_exact(2)) {
        let (hi, lo) = (*pair.first()?, *pair.get(1)?);
        *o = (hex_val(hi)? << 4) | hex_val(lo)?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lp_and_reader() {
        let mut v = Vec::new();
        put_lp(&mut v, b"abc").unwrap();
        v.extend_from_slice(&7u64.to_be_bytes());
        let mut r = Reader::new(&v, "t");
        assert_eq!(r.lp(10).unwrap(), b"abc");
        assert_eq!(r.u64be().unwrap(), 7);
        r.finish().unwrap();

        let mut r = Reader::new(&v, "t");
        assert_eq!(r.lp(2), Err(CryptoError::Malformed("t")));
        let mut r = Reader::new(&[0, 0, 0, 9, 1], "t");
        assert!(r.lp(100).is_err());
    }

    #[test]
    fn hex() {
        assert_eq!(hex_encode(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(hex_decode_array::<3>("00abff"), Some([0x00, 0xab, 0xff]));
        assert_eq!(hex_decode_array::<3>("00ABff"), None);
        assert_eq!(hex_decode_array::<3>("00ab"), None);
        assert_eq!(hex_decode_array::<1>("zz"), None);
    }
}
