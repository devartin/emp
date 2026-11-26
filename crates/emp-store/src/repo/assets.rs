//! Assets (SPEC §9.7, §10.2 `assets`, §11.3 Assets).
//!
//! Blobs live in `assets/<2 hex>/<blob_name>` where `blob_name = hex(HMAC(k_blob_id, SHA-256(content))[..16])`.
//! In encrypted vaults each blob is a STREAM file under a random per-blob file key `FK`, stored wrapped under
//! `k_assets` in `assets.wrapped_fk`; plaintext vaults store blobs raw (`wrapped_fk IS NULL`). Identical content is
//! stored once (rows share the blob). Imports and reads are streamed; nothing is decrypted to disk except
//! [`Store::asset_open_external`], which writes to the vault's `tmp/` (wiped on lock).
//!
//! Types are sniffed from magic bytes; images are capped at 50 MiB and 16384×16384 px, other files at 2 GiB.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use emp_crypto::blob::{BlobWriter, WrappedFileKey, blob_range_reader, blob_reader};
use emp_crypto::mac::ContentHasher;
use emp_crypto::{BlobName, FileKey, TableTag, VaultKeys};
use rusqlite::{OptionalExtension, params};

use crate::codec::RecordLoc;
use crate::model::ids::{is_asset_id, new_asset_id, new_id};
use crate::model::{AssetDto, AssetImport, AssetPayload};
use crate::{Progress, Result, Store, StoreError};

/// Image size cap.
pub const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
/// Other files' size cap.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Image dimension cap.
pub const MAX_IMAGE_DIM: u32 = 16_384;
const CHUNK: usize = 64 * 1024;

/// MIME types the `emp-asset` handler may serve inline (SPEC §9.7).
pub const INLINE_MIME: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
];

/// Result of sniffing the first bytes of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sniffed {
    /// MIME type.
    pub mime: &'static str,
    /// Width, if known.
    pub width: Option<u32>,
    /// Height, if known.
    pub height: Option<u32>,
}

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])))
}

fn jpeg_dims(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) || marker == 0xFF {
            i += if marker == 0xFF { 1 } else { 2 };
            continue;
        }
        let len = be16(b, i + 2)? as usize;
        let sof = (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker);
        if sof {
            return Some((be16(b, i + 7)?, be16(b, i + 5)?));
        }
        i += 2 + len;
    }
    None
}

/// Sniffs a type from magic bytes (and image dimensions where cheap).
#[must_use]
pub fn sniff(head: &[u8]) -> Option<Sniffed> {
    let s = |mime, d: Option<(u32, u32)>| Sniffed {
        mime,
        width: d.map(|x| x.0),
        height: d.map(|x| x.1),
    };
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        let w = head
            .get(16..20)
            .map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]));
        let h = head
            .get(20..24)
            .map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]));
        return Some(s("image/png", w.zip(h)));
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(s("image/jpeg", jpeg_dims(head)));
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        let w = head
            .get(6..8)
            .map(|x| u32::from(u16::from_le_bytes([x[0], x[1]])));
        let h = head
            .get(8..10)
            .map(|x| u32::from(u16::from_le_bytes([x[0], x[1]])));
        return Some(s("image/gif", w.zip(h)));
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        let dims = (head.get(12..16) == Some(b"VP8X")).then(|| {
            let w = head
                .get(24..27)
                .map(|x| u32::from_le_bytes([x[0], x[1], x[2], 0]) + 1);
            let h = head
                .get(27..30)
                .map(|x| u32::from_le_bytes([x[0], x[1], x[2], 0]) + 1);
            w.zip(h)
        });
        return Some(s("image/webp", dims.flatten()));
    }
    if head.len() >= 12
        && &head[4..8] == b"ftyp"
        && (&head[8..12] == b"avif" || &head[8..12] == b"avis")
    {
        return Some(s("image/avif", None));
    }
    if head.starts_with(b"%PDF-") {
        return Some(s("application/pdf", None));
    }
    let text = String::from_utf8_lossy(&head[..head.len().min(1024)]).to_ascii_lowercase();
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with("<svg") || (t.starts_with("<?xml") && t.contains("<svg")) {
        return Some(s("image/svg+xml", None));
    }
    None
}

fn valid_mime(m: &str) -> bool {
    let mut parts = m.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty()
                && p.len() <= 64
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-' | b'_'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .take(200)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_owned();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

/// An open asset stream.
pub struct AssetStream {
    /// Metadata.
    pub asset: AssetDto,
    /// Plaintext content length.
    pub len: u64,
    /// The content.
    pub reader: Box<dyn Read + Send>,
}

impl std::fmt::Debug for AssetStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssetStream")
            .field("asset", &self.asset)
            .finish_non_exhaustive()
    }
}

/// `(blob_name, wrapped_fk, rev, enc, payload)`.
type RawAssetRow = (String, Option<Vec<u8>>, i64, i64, Vec<u8>);

#[derive(Debug, Clone)]
struct AssetRow {
    id: String,
    blob_name: String,
    wrapped_fk: Option<Vec<u8>>,
    payload: AssetPayload,
}

impl Store {
    fn blob_path(&self, name: &str) -> PathBuf {
        let prefix = name.get(..2).unwrap_or("00");
        self.inner.paths.assets().join(prefix).join(name)
    }

    fn dto(&self, row: &AssetRow) -> AssetDto {
        AssetDto {
            id: row.id.clone(),
            name: row.payload.name.clone(),
            mime: row.payload.mime.clone(),
            size: row.payload.size,
            width: row.payload.width,
            height: row.payload.height,
            url: format!("{}{}", self.inner.opts.asset_url_base, row.id),
        }
    }

    fn asset_row(&self, id: &str) -> Result<AssetRow> {
        if !is_asset_id(id) {
            return Err(StoreError::NotFound("asset"));
        }
        let s = self.session()?;
        let raw: Option<RawAssetRow> = self.read(|c| {
            Ok(c.prepare_cached(
                "SELECT blob_name, wrapped_fk, rev, enc, payload FROM assets WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .optional()?)
        })?;
        let (blob_name, wrapped_fk, rev, enc, payload) =
            raw.ok_or(StoreError::NotFound("asset"))?;
        let loc = RecordLoc::row(TableTag::Assets, id, u64::try_from(rev).unwrap_or(0));
        Ok(AssetRow {
            id: id.to_owned(),
            blob_name,
            wrapped_fk,
            payload: s.codec.decode(&loc, enc, &payload)?,
        })
    }

    fn file_key(keys: &VaultKeys, blob_name: &str, wrapped: &[u8]) -> Result<FileKey> {
        let name = BlobName::parse(blob_name)?;
        Ok(keys.unwrap_file_key(&name, &WrappedFileKey::from_bytes(wrapped)?)?)
    }

    /// Imports an asset from a stream of exactly `meta.len` bytes.
    pub fn asset_import(&self, meta: AssetImport, mut reader: impl Read) -> Result<AssetDto> {
        let s = self.session()?;
        if meta.len > MAX_FILE_BYTES {
            return Err(StoreError::TooLarge("file"));
        }
        // Sniff from the first chunk.
        let mut head = vec![0u8; CHUNK.min(usize::try_from(meta.len).unwrap_or(CHUNK))];
        let mut filled = 0;
        while filled < head.len() {
            let n = reader.read(&mut head[filled..])?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        head.truncate(filled);
        let sniffed = sniff(&head);
        let mime = match &sniffed {
            Some(sn) => sn.mime.to_owned(),
            None if meta.mime.starts_with("image/") || !valid_mime(&meta.mime) => {
                "application/octet-stream".to_owned()
            }
            None => meta.mime.to_ascii_lowercase(),
        };
        if mime.starts_with("image/") {
            if meta.len > MAX_IMAGE_BYTES {
                return Err(StoreError::TooLarge("image"));
            }
            if let Some(sn) = &sniffed {
                if sn.width.unwrap_or(0) > MAX_IMAGE_DIM || sn.height.unwrap_or(0) > MAX_IMAGE_DIM {
                    return Err(StoreError::TooLarge("image dimensions"));
                }
            }
        }
        let encrypted = s.codec.encrypting();
        let tmp_dir = self.inner.paths.tmp();
        std::fs::create_dir_all(&tmp_dir)?;
        let tmp = tmp_dir.join(format!("import-{}", new_id()));
        let result = (|| -> Result<(String, Option<Vec<u8>>, u64)> {
            let file = File::create(&tmp)?;
            let mut hasher = ContentHasher::new();
            let mut total = head.len() as u64;
            hasher.update(&head);
            let fk = if encrypted {
                Some(FileKey::generate()?)
            } else {
                None
            };
            let mut enc_writer = None;
            let mut plain_writer = None;
            if let Some(fk) = &fk {
                let mut w = BlobWriter::new(fk, meta.len, std::io::BufWriter::new(file))?;
                w.write_content(&head)?;
                enc_writer = Some(w);
            } else {
                let mut w = std::io::BufWriter::new(file);
                w.write_all(&head)?;
                plain_writer = Some(w);
            }
            let mut buf = vec![0u8; CHUNK];
            loop {
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > meta.len {
                    return Err(StoreError::invalid("the stream is longer than declared"));
                }
                hasher.update(&buf[..n]);
                if let Some(w) = enc_writer.as_mut() {
                    w.write_content(&buf[..n])?;
                } else if let Some(w) = plain_writer.as_mut() {
                    w.write_all(&buf[..n])?;
                }
            }
            if total != meta.len {
                return Err(StoreError::invalid("the stream is shorter than declared"));
            }
            let stored_file = if let Some(w) = enc_writer {
                w.finish()?
                    .into_inner()
                    .map_err(|e| StoreError::Io(e.into_error()))?
            } else if let Some(w) = plain_writer {
                w.into_inner().map_err(|e| StoreError::Io(e.into_error()))?
            } else {
                return Err(StoreError::Internal("no writer".into()));
            };
            stored_file.sync_all()?;
            let stored = stored_file.metadata()?.len();
            let name = s.keys().blob_name(&hasher.finalize())?;
            let wrapped = fk
                .as_ref()
                .map(|fk| {
                    s.keys()
                        .wrap_file_key(&name, fk)
                        .map(|w| w.to_bytes().to_vec())
                })
                .transpose()?;
            Ok((name.as_str().to_owned(), wrapped, stored))
        })();
        let (blob_name, mut wrapped, mut stored) = match result {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        };
        // Dedupe: reuse an existing blob with the same content.
        let existing: Option<(Option<Vec<u8>>, i64)> = self.read(|c| {
            Ok(c.prepare_cached(
                "SELECT wrapped_fk, stored_size FROM assets WHERE blob_name = ?1 LIMIT 1",
            )?
            .query_row([&blob_name], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?)
        })?;
        let path = self.blob_path(&blob_name);
        match existing {
            Some((w, size)) if w.is_some() == encrypted && path.is_file() => {
                let _ = std::fs::remove_file(&tmp);
                wrapped = w;
                stored = u64::try_from(size).unwrap_or(0);
            }
            _ => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::rename(&tmp, &path)?;
            }
        }
        let id = new_asset_id();
        let payload = AssetPayload {
            v: 1,
            name: sanitize_name(&meta.name),
            mime,
            size: meta.len,
            width: sniffed.as_ref().and_then(|x| x.width),
            height: sniffed.as_ref().and_then(|x| x.height),
            source: meta.source.clone(),
            origin_url: meta.origin_url.clone(),
        };
        let e = s
            .codec
            .encode(&RecordLoc::row(TableTag::Assets, &id, 1), &payload)?;
        let now = self.now();
        let (rid, ws, bn) = (id.clone(), meta.workspace_id.clone(), blob_name.clone());
        let stored_i = i64::try_from(stored).unwrap_or(i64::MAX);
        self.write(move |tx| {
            tx.prepare_cached(
                "INSERT INTO assets (id, workspace_id, blob_name, stored_size, wrapped_fk, key_epoch, created_at, rev, enc, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 1, ?7, ?8)",
            )?
            .execute(params![rid, ws, bn, stored_i, wrapped, now, e.enc, e.payload])?;
            Ok(())
        })?;
        Ok(self.dto(&AssetRow {
            id,
            blob_name,
            wrapped_fk: None,
            payload,
        }))
    }

    /// `asset_import_bytes`.
    pub fn asset_import_bytes(
        &self,
        workspace_id: &str,
        name: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<AssetDto> {
        self.asset_import(
            AssetImport {
                workspace_id: workspace_id.to_owned(),
                name: name.to_owned(),
                mime: mime.to_owned(),
                len: bytes.len() as u64,
                source: "upload".into(),
                origin_url: None,
            },
            bytes,
        )
    }

    /// Imports a local file (after the app resolved a file grant).
    pub fn asset_import_file(
        &self,
        workspace_id: &str,
        path: &Path,
        source: &str,
    ) -> Result<AssetDto> {
        let f = File::open(path)?;
        let len = f.metadata()?.len();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_owned();
        self.asset_import(
            AssetImport {
                workspace_id: workspace_id.to_owned(),
                name,
                mime: "application/octet-stream".into(),
                len,
                source: source.to_owned(),
                origin_url: None,
            },
            BufReader::new(f),
        )
    }

    /// `asset_get` (missing ids are skipped).
    pub fn asset_get(&self, ids: &[String]) -> Result<Vec<AssetDto>> {
        if ids.len() > 1000 {
            return Err(StoreError::TooLarge("too many ids"));
        }
        let mut out = Vec::new();
        for id in ids {
            match self.asset_row(id) {
                Ok(r) => out.push(self.dto(&r)),
                Err(StoreError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    /// Opens an asset for streaming (the `emp-asset` protocol handler, `asset_save_as`).
    pub fn asset_open(&self, id: &str) -> Result<AssetStream> {
        let s = self.session()?;
        let row = self.asset_row(id)?;
        let file = File::open(self.blob_path(&row.blob_name))?;
        let reader: Box<dyn Read + Send> = match &row.wrapped_fk {
            Some(w) => {
                let fk = Self::file_key(s.keys(), &row.blob_name, w)?;
                Box::new(blob_reader(&fk, BufReader::new(file))?)
            }
            None => Box::new(BufReader::new(file)),
        };
        Ok(AssetStream {
            asset: self.dto(&row),
            len: row.payload.size,
            reader,
        })
    }

    /// Reads `[offset, offset + len)` of an asset (HTTP `Range`, 206 responses).
    pub fn asset_read_range(&self, id: &str, offset: u64, len: u64) -> Result<Vec<u8>> {
        let s = self.session()?;
        let row = self.asset_row(id)?;
        let size = row.payload.size;
        if offset > size {
            return Err(StoreError::invalid("range start beyond the end"));
        }
        let len = len.min(size - offset).min(16 * 1024 * 1024);
        let mut file = File::open(self.blob_path(&row.blob_name))?;
        match &row.wrapped_fk {
            Some(w) => {
                let fk = Self::file_key(s.keys(), &row.blob_name, w)?;
                let mut rr = blob_range_reader(&fk, file)?;
                Ok(rr.read_range(offset, len)?.to_vec())
            }
            None => {
                file.seek(SeekFrom::Start(offset))?;
                let mut buf = vec![0u8; usize::try_from(len).unwrap_or(0)];
                file.read_exact(&mut buf)?;
                Ok(buf)
            }
        }
    }

    /// Decrypts an asset to `dest` (`asset_save_as` after grant resolution; exports).
    pub fn asset_save_to(&self, id: &str, dest: &Path) -> Result<u64> {
        let mut stream = self.asset_open(id)?;
        let mut out = std::io::BufWriter::new(File::create(dest)?);
        let n = std::io::copy(&mut stream.reader, &mut out)?;
        out.flush()?;
        Ok(n)
    }

    /// `asset_open_external`: decrypts to the vault's `tmp/` (wiped on lock) and returns the path for the opener.
    pub fn asset_open_external(&self, id: &str) -> Result<PathBuf> {
        let row = self.asset_row(id)?;
        let dir = self.inner.paths.tmp().join(new_id());
        crate::vault::create_private_dir(&dir)?;
        let path = dir.join(sanitize_name(&row.payload.name));
        self.asset_save_to(id, &path)?;
        Ok(path)
    }

    /// Deletes an asset row; the blob is removed when no other row references it.
    pub fn asset_delete(&self, id: &str) -> Result<()> {
        let row = self.asset_row(id)?;
        let (rid, bn) = (row.id.clone(), row.blob_name.clone());
        let orphan = self.write(move |tx| {
            tx.execute("DELETE FROM assets WHERE id = ?1", [&rid])?;
            let left: i64 = tx.query_row(
                "SELECT count(*) FROM assets WHERE blob_name = ?1",
                [&bn],
                |r| r.get(0),
            )?;
            Ok(left == 0)
        })?;
        if orphan {
            let _ = std::fs::remove_file(self.blob_path(&row.blob_name));
        }
        Ok(())
    }

    pub(crate) fn blob_file(&self, name: &str) -> PathBuf {
        self.blob_path(name)
    }

    /// Rewrites every blob into the `target` mode (encryption toggles).
    pub(crate) fn reencrypt_assets(&self, target: bool, progress: &dyn Progress) -> Result<()> {
        let s = self.session()?;
        let blobs: Vec<(String, Option<Vec<u8>>)> = self.read(|c| {
            let cond = if target {
                "wrapped_fk IS NULL"
            } else {
                "wrapped_fk IS NOT NULL"
            };
            let mut st = c.prepare(&format!(
                "SELECT blob_name, max(wrapped_fk) FROM assets WHERE {cond} GROUP BY blob_name"
            ))?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })?;
        let total = blobs.len() as u64;
        for (i, (name, wrapped)) in blobs.into_iter().enumerate() {
            if progress.cancelled() {
                return Err(StoreError::Cancelled);
            }
            let path = self.blob_path(&name);
            let tmp = self.inner.paths.tmp().join(format!("reenc-{}", new_id()));
            let (new_wrapped, stored) = if target {
                let len = std::fs::metadata(&path)?.len();
                let fk = FileKey::generate()?;
                let mut w =
                    BlobWriter::new(&fk, len, std::io::BufWriter::new(File::create(&tmp)?))?;
                let mut src = BufReader::new(File::open(&path)?);
                std::io::copy(&mut src, &mut w)?;
                let f = w
                    .finish()?
                    .into_inner()
                    .map_err(|e| StoreError::Io(e.into_error()))?;
                f.sync_all()?;
                let bn = BlobName::parse(&name)?;
                (
                    Some(s.keys().wrap_file_key(&bn, &fk)?.to_bytes().to_vec()),
                    f.metadata()?.len(),
                )
            } else {
                let w = wrapped.ok_or_else(|| StoreError::Integrity("missing file key".into()))?;
                let fk = Self::file_key(s.keys(), &name, &w)?;
                let mut r = blob_reader(&fk, BufReader::new(File::open(&path)?))?;
                let mut out = std::io::BufWriter::new(File::create(&tmp)?);
                std::io::copy(&mut r, &mut out)?;
                let f = out
                    .into_inner()
                    .map_err(|e| StoreError::Io(e.into_error()))?;
                f.sync_all()?;
                (None, f.metadata()?.len())
            };
            std::fs::rename(&tmp, &path)?;
            let stored = i64::try_from(stored).unwrap_or(i64::MAX);
            self.write(move |tx| {
                tx.prepare_cached(
                    "UPDATE assets SET wrapped_fk = ?2, stored_size = ?3 WHERE blob_name = ?1",
                )?
                .execute(params![name, new_wrapped, stored])?;
                Ok(())
            })?;
            progress.progress(i as u64 + 1, total, "assets");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_types() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        let s = sniff(&png).unwrap();
        assert_eq!(
            (s.mime, s.width, s.height),
            ("image/png", Some(640), Some(480))
        );
        let gif = b"GIF89a\x10\x00\x20\x00";
        assert_eq!(sniff(gif).unwrap().height, Some(32));
        assert_eq!(sniff(b"  <svg xmlns='x'>").unwrap().mime, "image/svg+xml");
        assert_eq!(sniff(b"%PDF-1.7").unwrap().mime, "application/pdf");
        assert!(sniff(b"hello world").is_none());
        // Minimal JPEG with an SOF0 segment.
        let jpg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x40,
            0x00, 0x80, 0x03,
        ];
        let s = sniff(&jpg).unwrap();
        assert_eq!((s.width, s.height), (Some(128), Some(64)));
    }

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_name(""), "file");
        assert!(valid_mime("text/plain"));
        assert!(!valid_mime("text/plain; charset=utf-8"));
    }
}
