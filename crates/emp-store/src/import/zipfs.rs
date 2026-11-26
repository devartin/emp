//! In-memory zip archives with the §9.16 pre-scan. Nested archives (`*.zip` entries, e.g. Notion's
//! `Export-…-Part-1.zip`) are opened recursively in memory; limits apply to the expanded total. Nothing is written
//! to disk.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use crate::{Result, StoreError};

/// Limits of one archive tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZipLimits {
    /// Maximum entries (across nested archives).
    pub max_entries: usize,
    /// Maximum total uncompressed bytes (across nested archives).
    pub max_total: u64,
    /// Maximum compression ratio per entry (checked for entries above 64 KiB).
    pub max_ratio: u64,
    /// Maximum archive nesting.
    pub max_depth: usize,
}

impl ZipLimits {
    /// The default (§9.16): 10,000 entries, 512 MiB, 100:1.
    pub const DEFAULT: Self = Self {
        max_entries: 10_000,
        max_total: 512 * 1024 * 1024,
        max_ratio: 100,
        max_depth: 3,
    };
    /// Notion imports after the user confirmed a large export: 4 GiB.
    pub const NOTION_CONFIRMED: Self = Self {
        max_total: 4 * 1024 * 1024 * 1024,
        ..Self::DEFAULT
    };
}

/// Normalises an entry path: `\` → `/`, rejects absolute paths, drive letters, `..`, NUL and empty components.
pub fn normalize_path(name: &str) -> Result<String> {
    let n = name.replace('\\', "/");
    if n.starts_with('/') || n.contains('\0') || n.len() > 4096 {
        return Err(StoreError::invalid(format!("unsafe archive path: {name}")));
    }
    let mut parts = Vec::new();
    for (i, p) in n.split('/').enumerate() {
        match p {
            "" | "." => continue,
            ".." => return Err(StoreError::invalid(format!("unsafe archive path: {name}"))),
            p if i == 0 && p.len() == 2 && p.ends_with(':') => {
                return Err(StoreError::invalid(format!("unsafe archive path: {name}")));
            }
            p => parts.push(p),
        }
    }
    Ok(parts.join("/"))
}

/// Pre-scan summary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Scan {
    /// Entries.
    pub entries: usize,
    /// Declared uncompressed bytes.
    pub total: u64,
}

fn scan_into(bytes: &[u8], limits: &ZipLimits, acc: &mut Scan) -> Result<()> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| StoreError::invalid("not a valid zip archive"))?;
    for i in 0..z.len() {
        let f = z
            .by_index_raw(i)
            .map_err(|_| StoreError::invalid("damaged zip entry"))?;
        acc.entries += 1;
        if acc.entries > limits.max_entries {
            return Err(StoreError::TooLarge(
                "the archive has more than 10,000 entries",
            ));
        }
        if f.encrypted() {
            return Err(StoreError::Unsupported(
                "encrypted archive entries are not supported",
            ));
        }
        if f.is_symlink() {
            return Err(StoreError::invalid(format!(
                "symbolic link in archive: {}",
                f.name()
            )));
        }
        normalize_path(f.name())?;
        let size = f.size();
        let csize = f.compressed_size().max(1);
        if size > 64 * 1024 && size / csize > limits.max_ratio {
            return Err(StoreError::TooLarge(
                "an archive entry is compressed more than 100:1",
            ));
        }
        acc.total = acc.total.saturating_add(size);
        if acc.total > limits.max_total {
            return Err(StoreError::TooLarge(
                "the archive expands beyond the size limit",
            ));
        }
    }
    Ok(())
}

/// Pre-scans one archive level (before anything is decompressed).
pub fn prescan(bytes: &[u8], limits: &ZipLimits) -> Result<Scan> {
    let mut s = Scan::default();
    scan_into(bytes, limits, &mut s)?;
    Ok(s)
}

/// The expanded file tree of an archive.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ZipFs {
    /// Files by normalised path (nested archives contribute their entries under the same root).
    pub files: BTreeMap<String, Vec<u8>>,
}

impl ZipFs {
    /// Opens an archive (and nested `.zip` entries) in memory.
    pub fn open(bytes: &[u8], limits: &ZipLimits) -> Result<Self> {
        let mut fs = Self::default();
        let mut acc = Scan::default();
        fs.expand(bytes, limits, &mut acc, 0)?;
        Ok(fs)
    }

    fn expand(
        &mut self,
        bytes: &[u8],
        limits: &ZipLimits,
        acc: &mut Scan,
        depth: usize,
    ) -> Result<()> {
        if depth > limits.max_depth {
            return Err(StoreError::TooLarge("archives are nested too deeply"));
        }
        scan_into(bytes, limits, acc)?;
        let mut z = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|_| StoreError::invalid("not a valid zip archive"))?;
        for i in 0..z.len() {
            let f = z
                .by_index(i)
                .map_err(|_| StoreError::invalid("damaged zip entry"))?;
            if f.is_dir() {
                continue;
            }
            let path = normalize_path(f.name())?;
            if path.is_empty() {
                continue;
            }
            let declared = f.size();
            let mut out = Vec::with_capacity(usize::try_from(declared.min(64 << 20)).unwrap_or(0));
            f.take(declared.saturating_add(1)).read_to_end(&mut out)?;
            if out.len() as u64 > declared {
                return Err(StoreError::invalid(
                    "an archive entry is larger than declared",
                ));
            }
            if path.to_ascii_lowercase().ends_with(".zip") {
                self.expand(&out, limits, acc, depth + 1)?;
            } else {
                self.files.insert(path, out);
            }
        }
        Ok(())
    }

    /// A file by path (exact, then case-insensitive).
    #[must_use]
    pub fn get(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path).map(Vec::as_slice).or_else(|| {
            let l = path.to_lowercase();
            self.files
                .iter()
                .find(|(k, _)| k.to_lowercase() == l)
                .map(|(_, v)| v.as_slice())
        })
    }
}

/// `true` when the first local file name of a zip carries a Notion-style 32-hex id.
#[must_use]
pub fn looks_like_notion(head: &[u8]) -> bool {
    if !head.starts_with(b"PK\x03\x04") || head.len() < 30 {
        return false;
    }
    let n = usize::from(u16::from_le_bytes([head[26], head[27]]));
    let name = head
        .get(30..30 + n)
        .map(String::from_utf8_lossy)
        .unwrap_or_default();
    has_notion_id(&name) || name.to_ascii_lowercase().contains("export-")
}

/// `true` if some path component ends with ` <32 hex>`.
#[must_use]
pub fn has_notion_id(path: &str) -> bool {
    path.split('/')
        .any(|c| split_notion_id(strip_ext(c)).1.is_some())
}

/// The file name without its extension.
#[must_use]
pub fn strip_ext(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((a, e)) if !a.is_empty() && e.len() <= 5 && !e.contains(' ') => a,
        _ => name,
    }
}

/// Splits `Title 0123…abcd` into `("Title", Some("0123…abcd"))`.
#[must_use]
pub fn split_notion_id(stem: &str) -> (&str, Option<&str>) {
    if stem.len() > 33 {
        let (a, b) = stem.split_at(stem.len() - 32);
        if b.bytes().all(|c| c.is_ascii_hexdigit()) && a.ends_with(' ') {
            return (a.trim_end(), Some(b));
        }
    }
    if stem.len() == 32 && stem.bytes().all(|c| c.is_ascii_hexdigit()) {
        return ("", Some(stem));
    }
    (stem, None)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    pub fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, data) in files {
                z.start_file(*name, opts).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn paths_and_ids() {
        assert_eq!(normalize_path("a\\b/./c.md").unwrap(), "a/b/c.md");
        assert!(normalize_path("../etc/passwd").is_err());
        assert!(normalize_path("/abs").is_err());
        assert!(normalize_path("C:/x").is_err());
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            split_notion_id(&format!("My Page {id}")),
            ("My Page", Some(id))
        );
        assert_eq!(split_notion_id("Plain"), ("Plain", None));
        assert_eq!(strip_ext("My Page.md"), "My Page");
    }

    #[test]
    fn nested_archives_and_limits() {
        let inner = make_zip(&[("Page 0123456789abcdef0123456789abcdef.md", b"# Hi")]);
        let outer = make_zip(&[("Export-1-Part-1.zip", &inner), ("readme.txt", b"x")]);
        let fs = ZipFs::open(&outer, &ZipLimits::DEFAULT).unwrap();
        assert_eq!(fs.files.len(), 2);
        assert!(fs.get("page 0123456789abcdef0123456789abcdef.md").is_some());
        // Too many entries.
        let names: Vec<String> = (0..20).map(|i| format!("f{i}.txt")).collect();
        let files: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), b"x" as &[u8])).collect();
        let z = make_zip(&files);
        let tight = ZipLimits {
            max_entries: 10,
            ..ZipLimits::DEFAULT
        };
        assert!(matches!(
            ZipFs::open(&z, &tight),
            Err(StoreError::TooLarge(_))
        ));
        // Bomb ratio.
        let big = vec![0u8; 4 * 1024 * 1024];
        let z = make_zip(&[("zeros.bin", &big)]);
        assert!(matches!(
            prescan(&z, &ZipLimits::DEFAULT),
            Err(StoreError::TooLarge(_))
        ));
        // Total size.
        let small = ZipLimits {
            max_total: 10,
            ..ZipLimits::DEFAULT
        };
        let z = make_zip(&[("a.txt", b"hello world, this is long")]);
        assert!(matches!(prescan(&z, &small), Err(StoreError::TooLarge(_))));
        assert!(looks_like_notion(&inner));
        assert!(ZipFs::open(b"not a zip", &ZipLimits::DEFAULT).is_err());
    }
}
