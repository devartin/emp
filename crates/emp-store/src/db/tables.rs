//! Descriptors of every payload-carrying table: key columns, `kind` / `rev` columns and how a row's AAD
//! location ([`RecordLoc`]) is built. Used by the integrity manifest, re-encryption and integrity checks, so a new
//! table only needs an entry here to be covered everywhere.

use emp_crypto::TableTag;
use rusqlite::types::ValueRef;

use crate::codec::RecordLoc;
use crate::{Result, StoreError};

/// How a table is keyed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyShape {
    /// A single `TEXT` primary key column.
    Id(&'static str),
    /// `sheet_bands (sheet_id, band)`.
    SheetBand,
    /// `settings (scope, key)`.
    Setting,
    /// `kv (ns, key)`.
    Kv,
}

impl KeyShape {
    /// The two key column names (the second is `NULL` for single-column keys).
    #[must_use]
    pub const fn columns(self) -> (&'static str, &'static str) {
        match self {
            Self::Id(c) => (c, "NULL"),
            Self::SheetBand => ("sheet_id", "band"),
            Self::Setting => ("scope", "key"),
            Self::Kv => ("ns", "key"),
        }
    }
}

/// One payload table.
#[derive(Clone, Copy, Debug)]
pub struct TableDesc {
    /// AAD table tag.
    pub tag: TableTag,
    /// Key shape.
    pub key: KeyShape,
    /// The table's `kind` column (bound into the AAD), if any.
    pub kind_col: Option<&'static str>,
    /// Whether the table has a `rev` column.
    pub has_rev: bool,
}

impl TableDesc {
    /// SQLite table name.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        self.tag.table_name()
    }

    /// `true` for tables that are always encrypted (`secrets`).
    #[must_use]
    pub fn always_encrypted(&self) -> bool {
        self.tag == TableTag::Secrets
    }

    /// `SELECT k1, k2, kind, rev, enc, payload FROM <table>` (followed by the caller's `WHERE`).
    #[must_use]
    pub fn select_sql(&self) -> String {
        let (k1, k2) = self.key.columns();
        format!(
            "SELECT {k1}, {k2}, {kind}, {rev}, enc, payload FROM {t}",
            kind = self.kind_col.unwrap_or("''"),
            rev = if self.has_rev { "rev" } else { "0" },
            t = self.name()
        )
    }

    /// `WHERE` clause matching one row by its key columns (`?1`, `?2`).
    #[must_use]
    pub fn key_where(&self) -> String {
        match self.key {
            KeyShape::Id(c) => format!("{c} = ?1"),
            k => {
                let (a, b) = k.columns();
                format!("{a} = ?1 AND {b} = ?2")
            }
        }
    }

    /// Builds the AAD location of a row from its key values, kind and rev.
    pub fn loc(&self, k1: &str, k2: ValueRef<'_>, kind: &str, rev: i64) -> Result<RecordLoc> {
        let rev = u64::try_from(rev).map_err(|_| StoreError::Integrity("negative rev".into()))?;
        Ok(match self.key {
            KeyShape::Id(_) => RecordLoc::new(self.tag, k1, kind, rev),
            KeyShape::SheetBand => {
                let band = match k2 {
                    ValueRef::Integer(i) => u32::try_from(i)
                        .map_err(|_| StoreError::Integrity("band out of range".into()))?,
                    _ => return Err(StoreError::Integrity("band is not an integer".into())),
                };
                RecordLoc::sheet_band(k1, band, rev)?
            }
            KeyShape::Setting => RecordLoc::setting(k1, &text(k2)?)?,
            KeyShape::Kv => RecordLoc::kv(k1, &text(k2)?)?,
        })
    }

    /// A display key for damaged-item reports.
    #[must_use]
    pub fn display_key(&self, k1: &str, k2: ValueRef<'_>) -> String {
        match (self.key, k2) {
            (KeyShape::Id(_), _) => k1.to_owned(),
            (_, ValueRef::Integer(i)) => format!("{k1}/{i}"),
            (_, ValueRef::Text(t)) => format!("{k1}/{}", String::from_utf8_lossy(t)),
            _ => k1.to_owned(),
        }
    }
}

fn text(v: ValueRef<'_>) -> Result<String> {
    match v {
        ValueRef::Text(t) => std::str::from_utf8(t)
            .map(str::to_owned)
            .map_err(|_| StoreError::Integrity("non UTF-8 key".into())),
        _ => Err(StoreError::Integrity("key is not text".into())),
    }
}

const fn id(
    tag: TableTag,
    col: &'static str,
    kind_col: Option<&'static str>,
    has_rev: bool,
) -> TableDesc {
    TableDesc {
        tag,
        key: KeyShape::Id(col),
        kind_col,
        has_rev,
    }
}

/// Every table with an `enc` / `payload` pair (SPEC §10.2).
pub const PAYLOAD_TABLES: &[TableDesc] = &[
    id(TableTag::Workspaces, "id", None, true),
    id(TableTag::Pages, "id", Some("kind"), true),
    id(TableTag::PageDocs, "owner_id", None, true),
    id(TableTag::Databases, "id", None, true),
    id(TableTag::DbProperties, "id", None, true),
    id(TableTag::DbRows, "id", None, true),
    id(TableTag::DbViews, "id", None, true),
    id(TableTag::Workbooks, "id", None, true),
    id(TableTag::Sheets, "id", None, true),
    TableDesc {
        tag: TableTag::SheetBands,
        key: KeyShape::SheetBand,
        kind_col: None,
        has_rev: true,
    },
    id(TableTag::Assets, "id", None, true),
    id(TableTag::Versions, "id", None, false),
    TableDesc {
        tag: TableTag::Settings,
        key: KeyShape::Setting,
        kind_col: None,
        has_rev: false,
    },
    id(TableTag::Secrets, "id", None, true),
    TableDesc {
        tag: TableTag::Kv,
        key: KeyShape::Kv,
        kind_col: None,
        has_rev: false,
    },
    id(TableTag::Watchlists, "id", None, true),
    id(TableTag::LifeappInstances, "id", None, true),
    id(TableTag::SyncLinks, "id", None, true),
    id(TableTag::Outbox, "id", None, true),
    id(TableTag::Reminders, "id", None, true),
];

/// Looks a descriptor up by tag.
pub fn desc(tag: TableTag) -> Result<&'static TableDesc> {
    PAYLOAD_TABLES
        .iter()
        .find(|d| d.tag == tag)
        .ok_or_else(|| StoreError::Internal(format!("no descriptor for {}", tag.table_name())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_payload_table_in_ddl_has_a_descriptor() {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate::migrate(&mut c, None, 0).unwrap();
        let mut st = c
            .prepare("SELECT m.name FROM sqlite_master m WHERE m.type='table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='payload')")
            .unwrap();
        let names: Vec<String> = st
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(names.len(), PAYLOAD_TABLES.len());
        for n in names {
            let d = PAYLOAD_TABLES.iter().find(|d| d.name() == n).unwrap();
            // The select statement must compile against the real schema.
            c.prepare(&d.select_sql()).unwrap();
        }
    }
}
