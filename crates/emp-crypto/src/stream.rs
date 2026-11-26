//! Chunked streaming AEAD: XChaCha20-Poly1305 STREAM-BE32 in 64 KiB chunks (SPEC §9.7, §9.21).
//!
//! This is the shared engine behind encrypted blobs ([`crate::blob`]) and password-protected backup containers
//! ([`crate::backup`]). A stream file is
//!
//! ```text
//! file      = header || chunk_0 || chunk_1 || … || chunk_{n-1}
//! header    = magic[8] || format fields || prefix[19] || u64be(padded_total_len)
//! plaintext = u64be(content_len) || content || zero padding      (len = padded_total_len = padme(content_len + 8))
//! chunk_i   = AEAD(nonce = prefix || u32be(i) || u8(last), aad = header, plaintext[i·64 KiB ..][..64 KiB]) // +16 B tag
//! ```
//!
//! * The header is the AAD of every chunk, so it cannot be altered (including the padded length, which fixes the
//!   chunk count and therefore which chunk carries the `last` flag).
//! * Truncation (missing chunks or bytes) is reported as [`CryptoError::Truncated`]; reordering, splicing and
//!   bit flips as [`CryptoError::AuthFailed`]; trailing bytes after the final chunk as `Malformed`.
//! * The content length is the first 8 plaintext bytes (EMP-defined; SPEC only fixes the header). Padding bytes
//!   must be zero.
//! * Random access ([`RangeReader`]) decrypts only the chunks a byte range touches (for HTTP `Range` / 206).

use std::io::{Read, Seek, SeekFrom, Write};

use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::KeyInit;
use chacha20poly1305::aead::generic_array::GenericArray;
use chacha20poly1305::aead::stream::{NewStream, StreamBE32, StreamPrimitive};
use zeroize::Zeroizing;

use crate::error::{CryptoError, Result};
use crate::keys::KEY_LEN;
use crate::pad::padme;

/// Plaintext bytes per chunk.
pub const CHUNK_LEN: usize = 64 * 1024;
/// STREAM nonce prefix length (24-byte XChaCha nonce − 4-byte counter − 1-byte last flag).
pub const STREAM_PREFIX_LEN: usize = 19;
/// Per-chunk tag length.
pub const CHUNK_TAG_LEN: usize = 16;
/// Length of the content-length prefix inside the plaintext.
pub const LENGTH_PREFIX_LEN: usize = 8;
/// Hard limit on content length (1 TiB) to keep the chunk counter and arithmetic far from overflow.
pub const MAX_STREAM_CONTENT: u64 = 1 << 40;

const CHUNK_LEN_U64: u64 = CHUNK_LEN as u64;
const CHUNK_CT_LEN_U64: u64 = (CHUNK_LEN + CHUNK_TAG_LEN) as u64;

/// Size bookkeeping of a stream, derived from the padded plaintext length in the header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamLayout {
    padded_len: u64,
}

impl StreamLayout {
    /// Layout for `content_len` bytes of content.
    pub fn for_content(content_len: u64) -> Result<Self> {
        if content_len > MAX_STREAM_CONTENT {
            return Err(CryptoError::TooLarge("stream content"));
        }
        let padded_len = padme(content_len + LENGTH_PREFIX_LEN as u64)
            .ok_or(CryptoError::TooLarge("stream content"))?;
        Ok(Self { padded_len })
    }

    /// Layout from an (authenticated-later) header value; rejects impossible lengths.
    pub fn from_padded_len(padded_len: u64) -> Result<Self> {
        if padded_len < LENGTH_PREFIX_LEN as u64 || padded_len > MAX_STREAM_CONTENT * 2 {
            return Err(CryptoError::Malformed("stream length"));
        }
        if padme(padded_len) != Some(padded_len) {
            return Err(CryptoError::Malformed("stream length"));
        }
        Ok(Self { padded_len })
    }

    /// Padded plaintext length (`padded_total_len` in the header).
    #[must_use]
    pub fn padded_len(&self) -> u64 {
        self.padded_len
    }

    /// Number of chunks (≥ 1).
    #[must_use]
    pub fn chunk_count(&self) -> u64 {
        self.padded_len.div_ceil(CHUNK_LEN_U64).max(1)
    }

    /// Plaintext length of chunk `i`.
    #[must_use]
    pub fn chunk_plain_len(&self, i: u64) -> u64 {
        self.padded_len
            .saturating_sub(i.saturating_mul(CHUNK_LEN_U64))
            .min(CHUNK_LEN_U64)
    }

    /// Total ciphertext length of all chunks (excluding the header).
    #[must_use]
    pub fn ciphertext_len(&self) -> u64 {
        self.padded_len + self.chunk_count() * CHUNK_TAG_LEN as u64
    }
}

type Stream = StreamBE32<XChaCha20Poly1305>;

fn make_stream(key: &[u8; KEY_LEN], prefix: &[u8; STREAM_PREFIX_LEN]) -> Stream {
    let aead = XChaCha20Poly1305::new(key.into());
    Stream::from_aead(aead, GenericArray::from_slice(prefix))
}

fn chunk_index(i: u64) -> Result<u32> {
    u32::try_from(i).map_err(|_| CryptoError::TooLarge("stream chunk count"))
}

/// Streaming encryptor. Writes the header immediately, then one chunk per 64 KiB of plaintext.
///
/// The total content length must be declared up front (it is part of the header/AAD). Call
/// [`finish`](Self::finish) after writing exactly that many bytes; dropping without `finish` leaves an incomplete
/// (undecryptable) file.
pub(crate) struct StreamEncryptor<W: Write> {
    stream: Stream,
    aad: Vec<u8>,
    out: W,
    buf: Zeroizing<Vec<u8>>,
    layout: StreamLayout,
    index: u64,
    fed: u64,
    content_len: u64,
    content_written: u64,
}

impl<W: Write> StreamEncryptor<W> {
    pub(crate) fn new(
        key: &[u8; KEY_LEN],
        header: Vec<u8>,
        prefix: &[u8; STREAM_PREFIX_LEN],
        content_len: u64,
        mut out: W,
    ) -> Result<Self> {
        let layout = StreamLayout::for_content(content_len)?;
        out.write_all(&header)?;
        let mut buf = Zeroizing::new(Vec::with_capacity(CHUNK_LEN + CHUNK_TAG_LEN));
        buf.extend_from_slice(&content_len.to_be_bytes());
        Ok(Self {
            stream: make_stream(key, prefix),
            aad: header,
            out,
            buf,
            layout,
            index: 0,
            fed: LENGTH_PREFIX_LEN as u64,
            content_len,
            content_written: 0,
        })
    }

    fn flush_chunk(&mut self, last: bool) -> Result<()> {
        let idx = chunk_index(self.index)?;
        self.stream
            .encrypt_in_place(idx, last, &self.aad, &mut *self.buf)
            .map_err(|_| CryptoError::Internal)?;
        self.out.write_all(&self.buf)?;
        self.buf.clear();
        self.index += 1;
        Ok(())
    }

    fn feed(&mut self, mut data: &[u8]) -> Result<()> {
        while !data.is_empty() {
            let space = CHUNK_LEN - self.buf.len();
            let (now, rest) = data.split_at(space.min(data.len()));
            self.buf.extend_from_slice(now);
            self.fed += now.len() as u64;
            data = rest;
            if self.buf.len() == CHUNK_LEN {
                let last = self.fed == self.layout.padded_len;
                self.flush_chunk(last)?;
            }
        }
        Ok(())
    }

    /// Absorbs content bytes.
    pub(crate) fn write_content(&mut self, data: &[u8]) -> Result<()> {
        let n = data.len() as u64;
        if self.content_written.saturating_add(n) > self.content_len {
            return Err(CryptoError::InvalidArgument(
                "more bytes written than the declared content length",
            ));
        }
        self.content_written += n;
        self.feed(data)
    }

    /// Pads, writes the final chunk and returns the writer.
    pub(crate) fn finish(mut self) -> Result<W> {
        if self.content_written != self.content_len {
            return Err(CryptoError::InvalidArgument(
                "fewer bytes written than the declared content length",
            ));
        }
        const ZEROS: [u8; 4096] = [0u8; 4096];
        while self.fed < self.layout.padded_len {
            let n = usize::try_from((self.layout.padded_len - self.fed).min(ZEROS.len() as u64))
                .map_err(|_| CryptoError::Internal)?;
            self.feed(ZEROS.get(..n).ok_or(CryptoError::Internal)?)?;
        }
        if !self.buf.is_empty() {
            self.flush_chunk(true)?;
        }
        if self.index != self.layout.chunk_count() {
            return Err(CryptoError::Internal);
        }
        self.out.flush()?;
        Ok(self.out)
    }
}

/// Decrypts and checks one chunk in `buf` (ciphertext in, plaintext out).
fn open_chunk(
    stream: &Stream,
    aad: &[u8],
    layout: &StreamLayout,
    i: u64,
    buf: &mut Vec<u8>,
    first_err: &CryptoError,
) -> Result<()> {
    let last = i + 1 == layout.chunk_count();
    stream
        .decrypt_in_place(chunk_index(i)?, last, aad, buf)
        .map_err(|_| {
            if i == 0 {
                first_err.clone()
            } else {
                CryptoError::AuthFailed
            }
        })
}

/// Reads the content length from chunk 0 plaintext and checks it against the layout.
fn content_len_from_first(layout: &StreamLayout, chunk0: &[u8]) -> Result<u64> {
    let len_bytes: [u8; 8] = chunk0
        .get(..LENGTH_PREFIX_LEN)
        .and_then(|s| s.try_into().ok())
        .ok_or(CryptoError::Malformed("stream length"))?;
    let content_len = u64::from_be_bytes(len_bytes);
    if StreamLayout::for_content(content_len).ok() != Some(*layout) {
        return Err(CryptoError::Malformed("stream length"));
    }
    Ok(content_len)
}

/// Content byte range `[start, end)` within chunk `i`'s plaintext.
fn content_range_in_chunk(layout: &StreamLayout, content_len: u64, i: u64) -> (usize, usize) {
    let chunk_start = i * CHUNK_LEN_U64;
    let chunk_len = layout.chunk_plain_len(i);
    let c_start = LENGTH_PREFIX_LEN as u64;
    let c_end = c_start + content_len;
    let s = c_start.max(chunk_start).min(chunk_start + chunk_len) - chunk_start;
    let e = c_end.max(chunk_start).min(chunk_start + chunk_len) - chunk_start;
    // Both are ≤ CHUNK_LEN, so the conversions cannot fail.
    (
        usize::try_from(s).unwrap_or(0),
        usize::try_from(e.max(s)).unwrap_or(0),
    )
}

/// Sequential streaming decryptor. Implements [`Read`]; use [`read_to_end_checked`](Self::read_to_end_checked)
/// for typed errors. Content is only released after its chunk's tag verified, but a caller that consumes a
/// partially-read stream must still treat everything as invalid if a later chunk fails.
pub struct StreamReader<R: Read> {
    stream: Stream,
    aad: Vec<u8>,
    inner: R,
    layout: StreamLayout,
    first_err: CryptoError,
    index: u64,
    buf: Zeroizing<Vec<u8>>,
    pos: usize,
    end: usize,
    content_len: u64,
    done: bool,
}

impl<R: Read> StreamReader<R> {
    /// `inner` must be positioned right after the header.
    pub(crate) fn new(
        key: &[u8; KEY_LEN],
        header: Vec<u8>,
        prefix: &[u8; STREAM_PREFIX_LEN],
        layout: StreamLayout,
        inner: R,
        first_err: CryptoError,
    ) -> Self {
        Self {
            stream: make_stream(key, prefix),
            aad: header,
            inner,
            layout,
            first_err,
            index: 0,
            buf: Zeroizing::new(Vec::with_capacity(CHUNK_LEN + CHUNK_TAG_LEN)),
            pos: 0,
            end: 0,
            content_len: 0,
            done: false,
        }
    }

    /// Decrypts the next chunk; returns `false` once the final chunk has been consumed and EOF verified.
    fn next_chunk(&mut self) -> Result<bool> {
        if self.done {
            return Ok(false);
        }
        let i = self.index;
        let ct_len = usize::try_from(self.layout.chunk_plain_len(i))
            .map_err(|_| CryptoError::Internal)?
            + CHUNK_TAG_LEN;
        self.buf.clear();
        self.buf.resize(ct_len, 0);
        self.inner
            .read_exact(&mut self.buf)
            .map_err(CryptoError::from)?;
        open_chunk(
            &self.stream,
            &self.aad,
            &self.layout,
            i,
            &mut self.buf,
            &self.first_err,
        )?;
        if i == 0 {
            self.content_len = content_len_from_first(&self.layout, &self.buf)?;
        }
        let (s, e) = content_range_in_chunk(&self.layout, self.content_len, i);
        // Content is contiguous from offset 8, so everything after it in a chunk is padding and must be zero.
        if self.buf.get(e..).is_some_and(|p| p.iter().any(|&b| b != 0)) {
            return Err(CryptoError::Malformed("stream padding"));
        }
        self.pos = s;
        self.end = e;
        self.index += 1;
        if self.index == self.layout.chunk_count() {
            self.done = true;
            let mut probe = [0u8; 1];
            loop {
                match self.inner.read(&mut probe) {
                    Ok(0) => break,
                    Ok(_) => return Err(CryptoError::Malformed("trailing data after stream")),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(e.into()),
                }
            }
        }
        Ok(true)
    }

    /// Fills `out`; `Ok(0)` means the stream is complete and fully authenticated.
    pub fn read_checked(&mut self, out: &mut [u8]) -> Result<usize> {
        while self.pos == self.end {
            if !self.next_chunk()? {
                return Ok(0);
            }
        }
        let avail = self
            .buf
            .get(self.pos..self.end)
            .ok_or(CryptoError::Internal)?;
        let n = avail.len().min(out.len());
        out.get_mut(..n)
            .ok_or(CryptoError::Internal)?
            .copy_from_slice(avail.get(..n).ok_or(CryptoError::Internal)?);
        self.pos += n;
        Ok(n)
    }

    /// Decrypts the whole stream into memory, with typed errors.
    pub fn read_to_end_checked(mut self) -> Result<Zeroizing<Vec<u8>>> {
        let mut out = Zeroizing::new(Vec::new());
        // Reserve from the first chunk's authenticated length, never from unauthenticated input alone.
        if self.pos == self.end && !self.next_chunk()? {
            return Ok(out);
        }
        // `try_reserve_exact`: an (authenticated) multi-GiB length must surface as `TooLarge`, not abort the process
        // on allocation failure.
        out.try_reserve_exact(
            usize::try_from(self.content_len)
                .map_err(|_| CryptoError::TooLarge("stream content"))?,
        )
        .map_err(|_| CryptoError::TooLarge("stream content"))?;
        let mut tmp = Zeroizing::new([0u8; 8192]);
        loop {
            let n = self.read_checked(tmp.as_mut_slice())?;
            if n == 0 {
                break;
            }
            out.extend_from_slice(tmp.get(..n).ok_or(CryptoError::Internal)?);
        }
        Ok(out)
    }

    /// Copies all content into `w`, returning the number of content bytes.
    pub fn copy_to<W: Write>(mut self, w: &mut W) -> Result<u64> {
        let mut tmp = Zeroizing::new([0u8; 8192]);
        let mut total = 0u64;
        loop {
            let n = self.read_checked(tmp.as_mut_slice())?;
            if n == 0 {
                return Ok(total);
            }
            w.write_all(tmp.get(..n).ok_or(CryptoError::Internal)?)?;
            total += n as u64;
        }
    }

    /// Content length (known after the first chunk was read; 0 before).
    #[must_use]
    pub fn content_len_hint(&self) -> u64 {
        self.content_len
    }
}

impl<R: Read> Read for StreamReader<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.read_checked(out).map_err(std::io::Error::from)
    }
}

/// Random-access decryptor over a seekable stream file (blobs served with HTTP `Range`).
pub struct RangeReader<R: Read + Seek> {
    stream: Stream,
    aad: Vec<u8>,
    inner: R,
    layout: StreamLayout,
    header_len: u64,
    content_len: u64,
}

impl<R: Read + Seek> RangeReader<R> {
    /// Verifies the total file size, then authenticates chunk 0 to learn the content length.
    pub(crate) fn new(
        key: &[u8; KEY_LEN],
        header: Vec<u8>,
        prefix: &[u8; STREAM_PREFIX_LEN],
        layout: StreamLayout,
        mut inner: R,
        first_err: CryptoError,
    ) -> Result<Self> {
        let header_len = header.len() as u64;
        let file_len = inner.seek(SeekFrom::End(0))?;
        let expected = header_len + layout.ciphertext_len();
        if file_len < expected {
            return Err(CryptoError::Truncated);
        }
        if file_len > expected {
            return Err(CryptoError::Malformed("trailing data after stream"));
        }
        let mut me = Self {
            stream: make_stream(key, prefix),
            aad: header,
            inner,
            layout,
            header_len,
            content_len: 0,
        };
        let chunk0 = me.chunk(0, &first_err)?;
        me.content_len = content_len_from_first(&me.layout, &chunk0)?;
        Ok(me)
    }

    fn chunk(&mut self, i: u64, first_err: &CryptoError) -> Result<Zeroizing<Vec<u8>>> {
        let plain = self.layout.chunk_plain_len(i);
        let ct_len = usize::try_from(plain).map_err(|_| CryptoError::Internal)? + CHUNK_TAG_LEN;
        self.inner
            .seek(SeekFrom::Start(self.header_len + i * CHUNK_CT_LEN_U64))?;
        let mut buf = Zeroizing::new(vec![0u8; ct_len]);
        self.inner.read_exact(&mut buf).map_err(CryptoError::from)?;
        open_chunk(
            &self.stream,
            &self.aad,
            &self.layout,
            i,
            &mut buf,
            first_err,
        )?;
        Ok(buf)
    }

    /// Content length in bytes.
    #[must_use]
    pub fn content_len(&self) -> u64 {
        self.content_len
    }

    /// Decrypts content bytes `[offset, offset + len)`, clamped to the content length.
    pub fn read_range(&mut self, offset: u64, len: u64) -> Result<Zeroizing<Vec<u8>>> {
        let start = offset.min(self.content_len);
        let end = offset.saturating_add(len).min(self.content_len);
        let mut out = Zeroizing::new(Vec::with_capacity(
            usize::try_from(end - start).map_err(|_| CryptoError::TooLarge("range"))?,
        ));
        if start == end {
            return Ok(out);
        }
        // Stream offsets of the requested content.
        let s_start = start + LENGTH_PREFIX_LEN as u64;
        let s_end = end + LENGTH_PREFIX_LEN as u64;
        let first = s_start / CHUNK_LEN_U64;
        let last = (s_end - 1) / CHUNK_LEN_U64;
        for i in first..=last {
            let chunk = self.chunk(i, &CryptoError::AuthFailed)?;
            let c0 = i * CHUNK_LEN_U64;
            let a = usize::try_from(s_start.max(c0) - c0).map_err(|_| CryptoError::Internal)?;
            let b = usize::try_from(s_end.min(c0 + self.layout.chunk_plain_len(i)) - c0)
                .map_err(|_| CryptoError::Internal)?;
            out.extend_from_slice(chunk.get(a..b).ok_or(CryptoError::Internal)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const KEY: [u8; 32] = [9u8; 32];
    const PREFIX: [u8; STREAM_PREFIX_LEN] = [3u8; STREAM_PREFIX_LEN];

    fn header(layout: &StreamLayout) -> Vec<u8> {
        let mut h = b"EMPTEST\x01".to_vec();
        h.extend_from_slice(&PREFIX);
        h.extend_from_slice(&layout.padded_len().to_be_bytes());
        h
    }

    fn seal(content: &[u8], write_sizes: usize) -> Vec<u8> {
        let layout = StreamLayout::for_content(content.len() as u64).unwrap();
        let mut enc = StreamEncryptor::new(
            &KEY,
            header(&layout),
            &PREFIX,
            content.len() as u64,
            Vec::new(),
        )
        .unwrap();
        for part in content.chunks(write_sizes.max(1)) {
            enc.write_content(part).unwrap();
        }
        enc.finish().unwrap()
    }

    fn open(file: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let hlen = 8 + STREAM_PREFIX_LEN + 8;
        let h = file.get(..hlen).ok_or(CryptoError::Truncated)?;
        let padded = u64::from_be_bytes(h[hlen - 8..].try_into().unwrap());
        let layout = StreamLayout::from_padded_len(padded)?;
        StreamReader::new(
            &KEY,
            h.to_vec(),
            &PREFIX,
            layout,
            &file[hlen..],
            CryptoError::AuthFailed,
        )
        .read_to_end_checked()
    }

    fn content(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 31 % 251) as u8).collect()
    }

    #[test]
    fn layout_math() {
        let l = StreamLayout::for_content(0).unwrap();
        assert_eq!((l.padded_len(), l.chunk_count()), (8, 1));
        let l = StreamLayout::for_content(CHUNK_LEN as u64 - 8).unwrap();
        assert_eq!(l.chunk_count(), 1);
        let l = StreamLayout::for_content(CHUNK_LEN as u64 * 3).unwrap();
        assert_eq!(l.chunk_count(), 4);
        assert_eq!(l.ciphertext_len(), l.padded_len() + 4 * 16);
        assert!(StreamLayout::from_padded_len(7).is_err());
        assert!(StreamLayout::from_padded_len(1001).is_err()); // not a PADMÉ value
        assert!(StreamLayout::for_content(MAX_STREAM_CONTENT + 1).is_err());
    }

    #[test]
    fn roundtrip_sizes() {
        for n in [
            0usize,
            1,
            100,
            CHUNK_LEN - 8,
            CHUNK_LEN - 7,
            CHUNK_LEN,
            CHUNK_LEN + 1,
            3 * CHUNK_LEN + 12_345,
            700_000,
        ] {
            let c = content(n);
            for ws in [1usize << 20, 4096, 7] {
                if n > 100_000 && ws == 7 {
                    continue;
                }
                let file = seal(&c, ws);
                let layout = StreamLayout::for_content(n as u64).unwrap();
                assert_eq!(file.len() as u64, 35 + layout.ciphertext_len());
                assert_eq!(
                    open(&file).unwrap().as_slice(),
                    c.as_slice(),
                    "n={n} ws={ws}"
                );
            }
        }
    }

    #[test]
    fn length_mismatch_rejected_by_writer() {
        let layout = StreamLayout::for_content(5).unwrap();
        let mut enc = StreamEncryptor::new(&KEY, header(&layout), &PREFIX, 5, Vec::new()).unwrap();
        assert!(enc.write_content(b"123456").is_err());
        enc.write_content(b"1234").unwrap();
        assert!(matches!(enc.finish(), Err(CryptoError::InvalidArgument(_))));
    }

    #[test]
    fn truncation_reorder_and_flips() {
        let c = content(3 * CHUNK_LEN + 100);
        let file = seal(&c, 1 << 20);
        let hlen = 35;
        // Drop the last chunk.
        let one = CHUNK_LEN + CHUNK_TAG_LEN;
        let cut = &file[..hlen + 3 * one];
        assert_eq!(open(cut), Err(CryptoError::Truncated));
        // Drop a byte anywhere at the end.
        assert_eq!(open(&file[..file.len() - 1]), Err(CryptoError::Truncated));
        // Trailing data.
        let mut longer = file.clone();
        longer.push(0);
        assert!(matches!(open(&longer), Err(CryptoError::Malformed(_))));
        // Swap chunks 1 and 2.
        let mut swapped = file.clone();
        let (a, b) = (hlen + one, hlen + 2 * one);
        let c1 = file[a..a + one].to_vec();
        let c2 = file[b..b + one].to_vec();
        swapped[a..a + one].copy_from_slice(&c2);
        swapped[b..b + one].copy_from_slice(&c1);
        assert_eq!(open(&swapped), Err(CryptoError::AuthFailed));
        // Header field flips (magic, prefix) and chunk flips.
        for i in (0..hlen - 8).chain([hlen + 5, hlen + one + 7, file.len() - 1]) {
            let mut t = file.clone();
            t[i] ^= 0x80;
            assert!(open(&t).is_err(), "flip at {i}");
        }
        // Changing the length field to another PADMÉ value breaks authentication or framing.
        let mut t = file.clone();
        let other = StreamLayout::for_content(2 * CHUNK_LEN as u64)
            .unwrap()
            .padded_len();
        t[hlen - 8..hlen].copy_from_slice(&other.to_be_bytes());
        assert!(open(&t).is_err());
    }

    #[test]
    fn last_chunk_cannot_be_dropped_when_aligned() {
        // Content filling an exact number of chunks: the final chunk must still be flagged last.
        let c = content(2 * CHUNK_LEN - 8);
        let layout = StreamLayout::for_content(c.len() as u64).unwrap();
        assert_eq!(layout.padded_len(), 2 * CHUNK_LEN as u64);
        let file = seal(&c, 1 << 20);
        assert_eq!(open(&file).unwrap().as_slice(), c.as_slice());
        assert_eq!(
            open(&file[..35 + CHUNK_LEN + CHUNK_TAG_LEN]),
            Err(CryptoError::Truncated)
        );
    }

    #[test]
    fn range_reads() {
        let c = content(3 * CHUNK_LEN + 777);
        let file = seal(&c, 1 << 20);
        let layout = StreamLayout::for_content(c.len() as u64).unwrap();
        let h = file[..35].to_vec();
        let mut rr = RangeReader::new(
            &KEY,
            h.clone(),
            &PREFIX,
            layout,
            Cursor::new(file.clone()),
            CryptoError::AuthFailed,
        )
        .unwrap();
        assert_eq!(rr.content_len(), c.len() as u64);
        for (off, len) in [
            (0u64, 10u64),
            (CHUNK_LEN as u64 - 20, 40),
            (5, 3 * CHUNK_LEN as u64),
            (c.len() as u64 - 1, 100),
            (c.len() as u64 + 5, 10),
            (0, c.len() as u64),
        ] {
            let got = rr.read_range(off, len).unwrap();
            let s = (off as usize).min(c.len());
            let e = ((off + len) as usize).min(c.len());
            assert_eq!(got.as_slice(), &c[s..e], "off={off} len={len}");
        }
        // Size checks.
        assert!(matches!(
            RangeReader::new(
                &KEY,
                h.clone(),
                &PREFIX,
                layout,
                Cursor::new(file[..file.len() - 1].to_vec()),
                CryptoError::AuthFailed
            ),
            Err(CryptoError::Truncated)
        ));
        let mut longer = file.clone();
        longer.push(1);
        assert!(
            RangeReader::new(
                &KEY,
                h.clone(),
                &PREFIX,
                layout,
                Cursor::new(longer),
                CryptoError::AuthFailed
            )
            .is_err()
        );
        // Corrupt chunk 2 → range touching it fails, others succeed.
        let mut bad = file.clone();
        bad[35 + 2 * (CHUNK_LEN + CHUNK_TAG_LEN) + 3] ^= 1;
        let mut rr = RangeReader::new(
            &KEY,
            h,
            &PREFIX,
            layout,
            Cursor::new(bad),
            CryptoError::AuthFailed,
        )
        .unwrap();
        assert!(rr.read_range(0, 100).is_ok());
        assert_eq!(
            rr.read_range(2 * CHUNK_LEN as u64, 10),
            Err(CryptoError::AuthFailed)
        );
    }

    #[test]
    fn read_trait_and_copy() {
        let c = content(200_000);
        let file = seal(&c, 1 << 20);
        let layout = StreamLayout::for_content(c.len() as u64).unwrap();
        let mut r = StreamReader::new(
            &KEY,
            file[..35].to_vec(),
            &PREFIX,
            layout,
            &file[35..],
            CryptoError::AuthFailed,
        );
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(out, c);
        let r = StreamReader::new(
            &KEY,
            file[..35].to_vec(),
            &PREFIX,
            layout,
            &file[35..],
            CryptoError::AuthFailed,
        );
        let mut sink = Vec::new();
        assert_eq!(r.copy_to(&mut sink).unwrap(), c.len() as u64);
        assert_eq!(sink, c);
        // io::Error carries the typed error.
        let mut bad = file.clone();
        bad[40] ^= 1;
        let mut r = StreamReader::new(
            &KEY,
            bad[..35].to_vec(),
            &PREFIX,
            layout,
            &bad[35..],
            CryptoError::BadPassword,
        );
        let err = r.read_to_end(&mut Vec::new()).unwrap_err();
        assert_eq!(CryptoError::from(err), CryptoError::BadPassword);
    }
}
