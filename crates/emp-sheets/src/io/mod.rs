//! xlsx and csv import/export (SPEC §14.5) with the import hardening of §9.16.
//!
//! * [`xlsx_import::import_xlsx`]: values, formulas (with cached results), merges, sheet visibility,
//!   defined names, number formats, bold/italic/underline, fills, column widths, row heights, freeze panes,
//!   the 1904 date system.
//! * [`xlsx_export::export_xlsx`]: values and formulas with cached results, styles and number formats,
//!   sizes, merges, freeze panes, defined names and conditional formats (cell rules and data bars).
//! * [`csv`]: delimiter and encoding sniffing, streaming import, export with formula-injection protection.

pub mod csv;
pub mod xlsx_export;
pub mod xlsx_import;
pub mod xlsx_styles;

use crate::limits::IMPORT_CELL_CAP;
use crate::workbook::SheetError;
use std::io::{Read, Seek};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Options shared by importers.
#[derive(Clone, Debug)]
pub struct ImportOptions {
    /// Maximum number of cells (default 5,000,000; above that the UI asks for confirmation).
    pub max_cells: usize,
    /// CSV: cells starting with `= + - @` become formulas instead of text.
    pub csv_formulas: bool,
    /// Cancellation flag.
    pub cancel: Option<Arc<AtomicBool>>,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            max_cells: IMPORT_CELL_CAP,
            csv_formulas: false,
            cancel: None,
        }
    }
}

impl ImportOptions {
    pub(crate) fn check_cancel(&self) -> Result<(), SheetError> {
        if self
            .cancel
            .as_ref()
            .is_some_and(|c| c.load(Ordering::Relaxed))
        {
            return Err(SheetError::Io("cancelled".into()));
        }
        Ok(())
    }
}

/// Zip pre-scan limits (§9.16).
pub const ZIP_MAX_ENTRIES: usize = 10_000;
/// Total uncompressed size limit.
pub const ZIP_MAX_TOTAL: u64 = 512 * 1024 * 1024;
/// Per-entry compression ratio limit.
pub const ZIP_MAX_RATIO: u64 = 100;

/// Pre-scan a zip archive before anything is decompressed: entry count, total size, compression ratio,
/// encryption, path traversal and symlinks.
pub fn prescan_zip<R: Read + Seek>(reader: R) -> Result<(), SheetError> {
    let mut z = zip::ZipArchive::new(reader)
        .map_err(|e| SheetError::Io(format!("not a valid xlsx file: {e}")))?;
    if z.len() > ZIP_MAX_ENTRIES {
        return Err(SheetError::TooLarge(format!(
            "archive has more than {ZIP_MAX_ENTRIES} entries"
        )));
    }
    let mut total: u64 = 0;
    for i in 0..z.len() {
        let f = z
            .by_index_raw(i)
            .map_err(|e| SheetError::Io(e.to_string()))?;
        let name = f.name().to_string();
        if f.encrypted() {
            return Err(SheetError::Invalid(
                "encrypted archive entries are not supported".into(),
            ));
        }
        if name.contains("..")
            || name.starts_with('/')
            || name.starts_with('\\')
            || name.contains(':')
            || f.is_symlink()
        {
            return Err(SheetError::Invalid(format!("unsafe archive entry: {name}")));
        }
        let size = f.size();
        let csize = f.compressed_size().max(1);
        if size / csize > ZIP_MAX_RATIO && size > 1024 * 1024 {
            return Err(SheetError::TooLarge(format!(
                "entry {name} is compressed more than {ZIP_MAX_RATIO}:1"
            )));
        }
        total = total.saturating_add(size);
        if total > ZIP_MAX_TOTAL {
            return Err(SheetError::TooLarge(
                "archive expands to more than 512 MiB".into(),
            ));
        }
    }
    // The checks above trust the sizes declared in the central directory, but the decompressor
    // does not stop at the declared size, and calamine reads entries itself. Inflate every entry
    // once (into a sink) and refuse any that produces more than it declared, so a lying header
    // cannot smuggle a deflate bomb past the size and ratio limits.
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(|e| SheetError::Io(e.to_string()))?;
        let declared = f.size();
        let mut limited = f.take(declared.saturating_add(1));
        let actual = std::io::copy(&mut limited, &mut std::io::sink())
            .map_err(|e| SheetError::Io(format!("damaged archive entry: {e}")))?;
        if actual > declared {
            return Err(SheetError::TooLarge(
                "an archive entry is larger than its declared size".into(),
            ));
        }
    }
    Ok(())
}

/// Read a zip entry fully, bounded by its declared size (and the global limit).
pub(crate) fn read_entry<R: Read + Seek>(
    z: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<Vec<u8>> {
    let f = z.by_name(name).ok()?;
    let limit = f.size().min(ZIP_MAX_TOTAL);
    let mut out = Vec::with_capacity(limit.min(64 * 1024 * 1024) as usize);
    f.take(limit + 1).read_to_end(&mut out).ok()?;
    if out.len() as u64 > limit {
        return None;
    }
    Some(out)
}
