//! Pure document model helpers for the D-07 TipTap schema (SPEC §7.1): schema manifest and normalisation
//! ([`schema`]), traversal ([`walk`]), text / outline / link extraction and the backlink index ([`index`]),
//! `schemaVersion` upgrades ([`migrate`]) and exports ([`markdown`], [`html`], [`clipboard`]).

pub mod clipboard;
pub mod html;
pub mod index;
pub mod markdown;
pub mod migrate;
pub mod schema;
pub mod walk;

pub use schema::{SCHEMA, SCHEMA_VERSION};

/// Resolves page ids to display information during export.
pub trait PageResolver {
    /// Title of a page, if it exists.
    fn title(&self, page_id: &str) -> Option<String>;
    /// Relative link target for a page in an export (e.g. `../Other.md`); `None` for "no link".
    fn href(&self, page_id: &str) -> Option<String> {
        let _ = page_id;
        None
    }
    /// File name / URL used for an asset in an export (e.g. `assets/<id>-photo.png`).
    fn asset_href(&self, asset_id: &str) -> Option<String> {
        let _ = asset_id;
        None
    }
}

/// A resolver that knows nothing (titles fall back to "Untitled").
#[derive(Debug, Default, Clone, Copy)]
pub struct NoResolver;

impl PageResolver for NoResolver {
    fn title(&self, _page_id: &str) -> Option<String> {
        None
    }
}

/// Extracts the target page id (and block id) of an internal `emp://page/<id>[#block]` link.
#[must_use]
pub fn parse_internal_href(href: &str) -> Option<(String, Option<String>)> {
    let rest = href.strip_prefix("emp://page/")?;
    let (id, block) = match rest.split_once('#') {
        Some((a, b)) => (a, Some(b.to_owned()).filter(|b| !b.is_empty())),
        None => (rest, None),
    };
    if id.is_empty() || !crate::model::ids::is_record_id(id) {
        return None;
    }
    Some((id.to_owned(), block))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_links() {
        assert_eq!(
            parse_internal_href("emp://page/0190-ab#blk"),
            Some(("0190-ab".into(), Some("blk".into())))
        );
        assert_eq!(
            parse_internal_href("emp://page/abc"),
            Some(("abc".into(), None))
        );
        assert_eq!(parse_internal_href("https://x.com"), None);
        assert_eq!(parse_internal_href("emp://page/../x"), None);
    }
}
