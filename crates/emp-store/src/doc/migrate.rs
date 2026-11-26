//! `schemaVersion` upgrades (`doc::migrate`, SPEC §7.1). Version 1 is current; documents without a version are
//! treated as version 1. Documents from a newer schema are rejected rather than silently mangled.

use serde_json::Value;

use super::schema::SCHEMA_VERSION;
use crate::model::TipTapDoc;
use crate::{Result, StoreError};

/// Parses a stored or imported document, upgrading it to [`SCHEMA_VERSION`].
pub fn migrate(mut value: Value) -> Result<TipTapDoc> {
    let obj = value
        .as_object_mut()
        .ok_or_else(|| StoreError::invalid("document must be an object"))?;
    let version = obj
        .get("attrs")
        .and_then(|a| a.get("schemaVersion"))
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if version > u64::from(SCHEMA_VERSION) {
        return Err(StoreError::Unsupported(
            "document from a newer schema version",
        ));
    }
    // v0 / missing → v1: ensure attrs exist.
    let attrs = obj
        .entry("attrs")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Some(a) = attrs.as_object_mut() {
        a.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    }
    obj.entry("content")
        .or_insert_with(|| Value::Array(Vec::new()));
    serde_json::from_value(value).map_err(|e| StoreError::invalid(format!("invalid document: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_version_becomes_v1() {
        let d = migrate(json!({"type": "doc", "content": []})).unwrap();
        assert_eq!(d.attrs.schema_version, 1);
    }

    #[test]
    fn newer_version_is_rejected() {
        assert!(
            migrate(json!({"type": "doc", "attrs": {"schemaVersion": 9}, "content": []})).is_err()
        );
    }
}
