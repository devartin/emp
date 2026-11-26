//! Importers and database exports (SPEC §9.16 hardening, §11.3 "Backup, import, export", §17.4–§17.5).
//!
//! * [`guard`]: the common wrapper — `catch_unwind`, cancellation, a wall-time budget, progress.
//! * [`zipfs`]: in-memory zip reading with the §9.16 pre-scan (entry count, total size, ratio, encryption, unsafe
//!   paths, symlinks) and recursive nested archives (Notion `Part-N.zip`). Entries are never extracted to disk.
//! * [`markdown`]: Markdown → TipTap (GFM, wikilinks, callouts, math, to-dos, front matter, `emp-block` round trip).
//! * [`html`]: a tolerant HTML → TipTap converter for Notion HTML exports (no scripts, no entities beyond the
//!   basic set, no DTD).
//! * [`files`]: Markdown file / folder import into the page tree with pass-2 link resolution.
//! * [`notion`]: Notion export zips (pages, nested pages, databases from CSV, assets, report).
//! * [`table`]: CSV / XLSX → database import (preview with type inference, new or existing database), database →
//!   CSV / XLSX export, sheet range → database.
//!
//! Every import records what it created under an import id so that `import_undo` removes it as one unit.

pub mod files;
pub mod guard;
pub mod html;
pub mod markdown;
pub mod notion;
pub mod table;
pub mod zipfs;

use serde::{Deserialize, Serialize};

use crate::model::Id;
use crate::repo::kv::{delete_internal, get_internal, put_internal};
use crate::{Result, Store, StoreError};

/// Namespace of import undo records.
const UNDO_NS: &str = "import.undo";

/// What an import created (for `import_undo`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoLog {
    /// Root pages created (purging them removes their subtrees, databases and rows).
    pub pages: Vec<Id>,
    /// Assets created.
    pub assets: Vec<Id>,
    /// Rows inserted into existing databases.
    #[serde(default)]
    pub rows: Vec<Id>,
}

/// `import_detect` kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum ImportKind {
    Markdown,
    MarkdownFolder,
    NotionZip,
    Csv,
    Xlsx,
    Ofx,
    Qfx,
    Qif,
    Ics,
    Empbackup,
    Unknown,
}

/// Detects the kind of an import from its name and first bytes.
#[must_use]
pub fn detect(name: &str, head: &[u8]) -> ImportKind {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let text = String::from_utf8_lossy(&head[..head.len().min(4096)]).to_ascii_uppercase();
    match ext {
        "md" | "markdown" | "mdown" | "txt" => ImportKind::Markdown,
        "csv" | "tsv" => ImportKind::Csv,
        "xlsx" | "xlsm" | "xls" | "ods" => ImportKind::Xlsx,
        "ofx" => ImportKind::Ofx,
        "qfx" => ImportKind::Qfx,
        "qif" => ImportKind::Qif,
        "ics" => ImportKind::Ics,
        "empbackup" => ImportKind::Empbackup,
        "zip" => {
            if zipfs::looks_like_notion(head) {
                ImportKind::NotionZip
            } else {
                ImportKind::Unknown
            }
        }
        _ if head.starts_with(b"PK\x03\x04") => {
            if zipfs::looks_like_notion(head) {
                ImportKind::NotionZip
            } else {
                ImportKind::Xlsx
            }
        }
        _ if text.contains("BEGIN:VCALENDAR") => ImportKind::Ics,
        _ if text.contains("OFXHEADER") || text.contains("<OFX>") => ImportKind::Ofx,
        _ if text.starts_with("!TYPE:") => ImportKind::Qif,
        _ => ImportKind::Unknown,
    }
}

/// Characters a page title may not contain after import (control characters are dropped).
pub(crate) fn clean_title(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = t.trim();
    let t: String = t.chars().take(1024).collect();
    if t.is_empty() { "Untitled".into() } else { t }
}

impl Store {
    pub(crate) fn import_log_save(&self, import_id: &str, log: &UndoLog) -> Result<()> {
        let s = self.session()?;
        put_internal(self, &s, UNDO_NS, import_id, log)
    }

    /// `import_undo`: removes everything an import created (pages with their subtrees, assets, appended rows).
    /// Returns the number of removed items.
    pub fn import_undo(&self, import_id: &str) -> Result<usize> {
        let s = self.session()?;
        let log: UndoLog =
            get_internal(self, &s, UNDO_NS, import_id)?.ok_or(StoreError::NotFound("import"))?;
        let mut n = 0;
        if !log.rows.is_empty() {
            for chunk in log.rows.chunks(crate::repo::rows::MAX_BATCH) {
                self.db_rows_purge(chunk)?;
                n += chunk.len();
            }
        }
        for chunk in log.pages.chunks(100) {
            self.page_purge(chunk)?;
            n += chunk.len();
        }
        for a in &log.assets {
            match self.asset_delete(a) {
                Ok(()) => n += 1,
                Err(StoreError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        delete_internal(self, UNDO_NS, import_id)?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection() {
        assert_eq!(detect("notes.md", b"# hi"), ImportKind::Markdown);
        assert_eq!(detect("data.CSV", b"a,b"), ImportKind::Csv);
        assert_eq!(detect("cal", b"BEGIN:VCALENDAR\r\n"), ImportKind::Ics);
        assert_eq!(detect("x.bin", b"\x00\x01"), ImportKind::Unknown);
        assert_eq!(clean_title("  a\u{0007}b "), "ab");
        assert_eq!(clean_title(""), "Untitled");
    }
}
