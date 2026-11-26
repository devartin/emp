//! Encrypted asset blobs (SPEC §9.7).
//!
//! * Per-blob random file key `FK`, wrapped as
//!   `wrapped_fk = XChaCha20Poly1305(k_assets, nonce, FK, aad = "EMP-BLOBKEY-v1" ‖ vault_id ‖ blob_name ‖ u32be(epoch))`
//!   and stored in the (encrypted) `assets` row payload as [`WrappedFileKey::to_bytes`] (72 bytes).
//! * File: `"EMPBLOB\x01" ‖ prefix[19] ‖ u64be(padded_total_len)` followed by 64 KiB STREAM-BE32 chunks whose
//!   AAD is that 35-byte header (see [`crate::stream`] for the plaintext layout and padding).
//! * Name: [`VaultKeys::blob_name`] over the SHA-256 of the plaintext content.
//!
//! Typical write path: hash content → `blob_name` → `FileKey::generate` → [`BlobWriter`] to
//! `assets/<2>/<name>` (via a temp file + rename) → `wrap_file_key` → store `wrapped_fk` in the assets row.

use std::io::{Read, Seek, SeekFrom, Write};

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{Tag, XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::codec::Reader;
use crate::error::{CryptoError, Result};
use crate::keys::{FileKey, KEY_LEN, VaultKeys};
use crate::mac::BlobName;
use crate::rng;
use crate::stream::{RangeReader, STREAM_PREFIX_LEN, StreamEncryptor, StreamLayout, StreamReader};

/// Blob file magic.
pub const BLOB_MAGIC: &[u8; 8] = b"EMPBLOB\x01";
/// Blob header length: magic (8) + prefix (19) + padded length (8).
pub const BLOB_HEADER_LEN: usize = 8 + STREAM_PREFIX_LEN + 8;
/// Serialized [`WrappedFileKey`] length.
pub const WRAPPED_FILE_KEY_LEN: usize = 24 + 48;

const BLOBKEY_AAD_DOMAIN: &[u8] = b"EMP-BLOBKEY-v1";

/// Parsed blob header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlobHeader {
    /// STREAM nonce prefix.
    pub prefix: [u8; STREAM_PREFIX_LEN],
    /// Size layout (padded plaintext length).
    pub layout: StreamLayout,
}

impl BlobHeader {
    /// Encodes the 35 header bytes.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut h = Vec::with_capacity(BLOB_HEADER_LEN);
        h.extend_from_slice(BLOB_MAGIC);
        h.extend_from_slice(&self.prefix);
        h.extend_from_slice(&self.layout.padded_len().to_be_bytes());
        h
    }

    /// Parses (does not authenticate) a header.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader::new(bytes, "blob header");
        if r.array::<8>()? != *BLOB_MAGIC {
            return Err(CryptoError::Malformed("blob header"));
        }
        let prefix = r.array::<STREAM_PREFIX_LEN>()?;
        let layout = StreamLayout::from_padded_len(r.u64be()?)?;
        r.finish()?;
        Ok(Self { prefix, layout })
    }
}

/// Size on disk of an encrypted blob with `content_len` bytes of content (shows padded sizes, SPEC §9.20).
pub fn encrypted_blob_len(content_len: u64) -> Result<u64> {
    Ok(BLOB_HEADER_LEN as u64 + StreamLayout::for_content(content_len)?.ciphertext_len())
}

/// Streaming blob encryptor. Declare the content length up front, write exactly that many bytes, then
/// call [`finish`](Self::finish).
pub struct BlobWriter<W: Write> {
    inner: StreamEncryptor<W>,
}

impl<W: Write> BlobWriter<W> {
    /// Writes the header to `out` and prepares chunk encryption.
    pub fn new(fk: &FileKey, content_len: u64, out: W) -> Result<Self> {
        let header = BlobHeader {
            prefix: rng::array()?,
            layout: StreamLayout::for_content(content_len)?,
        };
        let inner = StreamEncryptor::new(
            fk.expose(),
            header.to_bytes(),
            &header.prefix,
            content_len,
            out,
        )?;
        Ok(Self { inner })
    }

    /// Appends content.
    pub fn write_content(&mut self, data: &[u8]) -> Result<()> {
        self.inner.write_content(data)
    }

    /// Pads, writes the final chunk, flushes and returns the writer.
    pub fn finish(self) -> Result<W> {
        self.inner.finish()
    }
}

impl<W: Write> Write for BlobWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.write_content(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Encrypts a whole blob in memory.
pub fn seal_blob(fk: &FileKey, content: &[u8]) -> Result<Vec<u8>> {
    let mut w = BlobWriter::new(fk, content.len() as u64, Vec::new())?;
    w.write_content(content)?;
    w.finish()
}

fn read_header<R: Read>(r: &mut R) -> Result<BlobHeader> {
    let mut h = [0u8; BLOB_HEADER_LEN];
    r.read_exact(&mut h).map_err(CryptoError::from)?;
    BlobHeader::parse(&h)
}

/// Opens a blob for sequential decryption; `r` must be at the start of the file.
pub fn blob_reader<R: Read>(fk: &FileKey, mut r: R) -> Result<StreamReader<R>> {
    let h = read_header(&mut r)?;
    Ok(StreamReader::new(
        fk.expose(),
        h.to_bytes(),
        &h.prefix,
        h.layout,
        r,
        CryptoError::AuthFailed,
    ))
}

/// Opens a blob for random access (HTTP `Range`). Checks the file size against the header.
pub fn blob_range_reader<R: Read + Seek>(fk: &FileKey, mut r: R) -> Result<RangeReader<R>> {
    r.seek(SeekFrom::Start(0))?;
    let h = read_header(&mut r)?;
    RangeReader::new(
        fk.expose(),
        h.to_bytes(),
        &h.prefix,
        h.layout,
        r,
        CryptoError::AuthFailed,
    )
}

/// Decrypts a whole blob in memory.
pub fn open_blob(fk: &FileKey, file: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    blob_reader(fk, file)?.read_to_end_checked()
}

/// A file key wrapped under `k_assets`: `nonce[24] ‖ ciphertext[32] ‖ tag[16]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WrappedFileKey {
    nonce: [u8; 24],
    sealed: [u8; 48],
}

impl WrappedFileKey {
    /// 72-byte serialization.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; WRAPPED_FILE_KEY_LEN] {
        let mut out = [0u8; WRAPPED_FILE_KEY_LEN];
        let (n, s) = out.split_at_mut(24);
        n.copy_from_slice(&self.nonce);
        s.copy_from_slice(&self.sealed);
        out
    }

    /// Parses the 72-byte serialization.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader::new(bytes, "wrapped file key");
        let nonce = r.array()?;
        let sealed = r.array()?;
        r.finish()?;
        Ok(Self { nonce, sealed })
    }
}

fn blobkey_aad(keys: &VaultKeys, name: &BlobName) -> Vec<u8> {
    let mut a = Vec::with_capacity(BLOBKEY_AAD_DOMAIN.len() + 16 + 32 + 4);
    a.extend_from_slice(BLOBKEY_AAD_DOMAIN);
    a.extend_from_slice(keys.vault_id.as_bytes());
    a.extend_from_slice(name.as_str().as_bytes());
    a.extend_from_slice(&u32::from(keys.epoch).to_be_bytes());
    a
}

impl VaultKeys {
    /// Wraps a blob's file key under `k_assets`, bound to the vault, blob name and key epoch.
    pub fn wrap_file_key(&self, name: &BlobName, fk: &FileKey) -> Result<WrappedFileKey> {
        self.wrap_file_key_with_nonce(name, fk, rng::array::<24>()?)
    }

    pub(crate) fn wrap_file_key_with_nonce(
        &self,
        name: &BlobName,
        fk: &FileKey,
        nonce: [u8; 24],
    ) -> Result<WrappedFileKey> {
        let mut sealed = Zeroizing::new([0u8; 48]);
        let (k, t) = sealed.split_at_mut(KEY_LEN);
        k.copy_from_slice(fk.expose());
        let tag = XChaCha20Poly1305::new(self.assets.expose().into())
            .encrypt_in_place_detached(XNonce::from_slice(&nonce), &blobkey_aad(self, name), k)
            .map_err(|_| CryptoError::Internal)?;
        t.copy_from_slice(&tag);
        Ok(WrappedFileKey {
            nonce,
            sealed: *sealed,
        })
    }

    /// Unwraps a blob's file key. Fails with `AuthFailed` if the name, vault, epoch or bytes do not match.
    pub fn unwrap_file_key(&self, name: &BlobName, wrapped: &WrappedFileKey) -> Result<FileKey> {
        let (ct, tag) = wrapped.sealed.split_at(KEY_LEN);
        FileKey::fill_with(|out| {
            out.copy_from_slice(ct);
            XChaCha20Poly1305::new(self.assets.expose().into())
                .decrypt_in_place_detached(
                    XNonce::from_slice(&wrapped.nonce),
                    &blobkey_aad(self, name),
                    out,
                    Tag::from_slice(tag),
                )
                .map_err(|_| CryptoError::AuthFailed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::test_support::fixed_keys;
    use crate::mac::sha256;
    use crate::stream::CHUNK_LEN;
    use std::io::Cursor;

    #[test]
    fn blob_roundtrip() {
        let fk = FileKey::generate().unwrap();
        for n in [0usize, 10, CHUNK_LEN * 2 + 5] {
            let content: Vec<u8> = (0..n).map(|i| i as u8).collect();
            let file = seal_blob(&fk, &content).unwrap();
            assert_eq!(&file[..8], BLOB_MAGIC);
            assert_eq!(file.len() as u64, encrypted_blob_len(n as u64).unwrap());
            assert_eq!(
                open_blob(&fk, &file).unwrap().as_slice(),
                content.as_slice()
            );
            let mut rr = blob_range_reader(&fk, Cursor::new(file.clone())).unwrap();
            assert_eq!(rr.content_len(), n as u64);
            assert_eq!(
                rr.read_range(3, 4).unwrap().as_slice(),
                &content[3.min(n)..7.min(n)]
            );
        }
    }

    #[test]
    fn wrong_key_and_header_tamper() {
        let fk = FileKey::generate().unwrap();
        let file = seal_blob(&fk, b"hello blob").unwrap();
        assert_eq!(
            open_blob(&FileKey::generate().unwrap(), &file),
            Err(CryptoError::AuthFailed)
        );
        let mut bad_magic = file.clone();
        bad_magic[0] = b'X';
        assert!(matches!(
            open_blob(&fk, &bad_magic),
            Err(CryptoError::Malformed(_))
        ));
        for i in 8..BLOB_HEADER_LEN - 8 {
            let mut t = file.clone();
            t[i] ^= 1;
            assert_eq!(
                open_blob(&fk, &t),
                Err(CryptoError::AuthFailed),
                "prefix byte {i}"
            );
        }
        assert!(open_blob(&fk, &file[..20]).is_err());
    }

    #[test]
    fn streaming_writer_matches() {
        let fk = FileKey::generate().unwrap();
        let content = vec![42u8; 150_000];
        let mut w = BlobWriter::new(&fk, content.len() as u64, Vec::new()).unwrap();
        std::io::copy(&mut &content[..], &mut w).unwrap();
        let file = w.finish().unwrap();
        let mut out = Vec::new();
        blob_reader(&fk, &file[..])
            .unwrap()
            .copy_to(&mut out)
            .unwrap();
        assert_eq!(out, content);
    }

    #[test]
    fn file_key_wrap() {
        let k = fixed_keys(1);
        let name = k.blob_name(&sha256(b"content")).unwrap();
        let fk = FileKey::generate().unwrap();
        let w = k.wrap_file_key(&name, &fk).unwrap();
        let w2 = WrappedFileKey::from_bytes(&w.to_bytes()).unwrap();
        assert_eq!(k.unwrap_file_key(&name, &w2).unwrap().expose(), fk.expose());
        // Other name, other vault keys, tampered bytes.
        let other = k.blob_name(&sha256(b"other")).unwrap();
        assert_eq!(
            k.unwrap_file_key(&other, &w).err(),
            Some(CryptoError::AuthFailed)
        );
        assert_eq!(
            fixed_keys(2).unwrap_file_key(&name, &w).err(),
            Some(CryptoError::AuthFailed)
        );
        let bytes = w.to_bytes();
        for i in 0..bytes.len() {
            let mut t = bytes;
            t[i] ^= 1;
            let tw = WrappedFileKey::from_bytes(&t).unwrap();
            assert_eq!(
                k.unwrap_file_key(&name, &tw).err(),
                Some(CryptoError::AuthFailed)
            );
        }
        assert!(WrappedFileKey::from_bytes(&bytes[..71]).is_err());
        // Fresh nonce each wrap.
        assert_ne!(k.wrap_file_key(&name, &fk).unwrap(), w);
    }
}
