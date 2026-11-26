//! Emoji → Lucide icon mapping (owner ruling: no emoji in the app; PROGRAMME-v3 "Icons").
//!
//! The canonical table is `src/ui/icons/emoji-map.json` (kit lane), embedded here so the store migration, the
//! importers (Notion, Markdown, HTML), generated callouts and life-app manifests all map the same way the UI does.
//! Unmapped emoji map to *no icon*. The `Icon::Emoji` variant stays deserialisable so old vaults and backups load.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

use crate::model::Icon;

/// The canonical table (keys are emoji without variation selectors; values are Lucide icon names).
const EMOJI_MAP_JSON: &str = include_str!("../../../src/ui/icons/emoji-map.json");

static MAP: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    // A malformed table must never take the store down: it degrades to "no icon" for every emoji.
    serde_json::from_str::<HashMap<String, String>>(EMOJI_MAP_JSON)
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (normalise(&k), v))
        .filter(|(k, v)| !k.is_empty() && is_lucide_name(v))
        .collect()
});

/// Variation selectors and skin-tone modifiers never change which glyph an emoji maps to.
fn is_modifier(c: char) -> bool {
    matches!(c, '\u{FE0E}' | '\u{FE0F}' | '\u{1F3FB}'..='\u{1F3FF}')
}

fn normalise(s: &str) -> String {
    s.trim().chars().filter(|c| !is_modifier(*c)).collect()
}

/// `kebab-case` ASCII, as Lucide names are.
fn is_lucide_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The Lucide icon name for `emoji`, if the canonical table has one. Tries the exact sequence (without variation
/// selectors or skin tones), then the first code point of a ZWJ sequence or flag.
#[must_use]
pub fn lucide_for_emoji(emoji: &str) -> Option<&'static str> {
    let key = normalise(emoji);
    if key.is_empty() {
        return None;
    }
    if let Some(v) = MAP.get(&key) {
        return Some(v.as_str());
    }
    let first: String = key.chars().take(1).collect();
    MAP.get(&first).map(String::as_str)
}

/// Converts an emoji icon to its Lucide equivalent (`None` when unmapped); other icons pass through.
#[must_use]
pub fn migrate_icon(icon: Icon) -> Option<Icon> {
    match icon {
        Icon::Emoji { v } => lucide_for_emoji(&v).map(|name| Icon::Lucide {
            v: name.to_owned(),
            color: None,
        }),
        other => Some(other),
    }
}

/// [`migrate_icon`] for an optional icon.
#[must_use]
pub fn migrate_opt(icon: Option<Icon>) -> Option<Icon> {
    icon.and_then(migrate_icon)
}

/// Rewrites a JSON icon value in place (`{t:'emoji', v}` → `{t:'lucide', v}` or removed). Returns whether the
/// value changed. `slot` is the object that owns the `key` field.
pub fn migrate_icon_field(slot: &mut serde_json::Map<String, Value>, key: &str) -> bool {
    let Some(icon) = slot.get(key) else {
        return false;
    };
    if icon.get("t").and_then(Value::as_str) != Some("emoji") {
        return false;
    }
    let mapped = icon
        .get("v")
        .and_then(Value::as_str)
        .and_then(lucide_for_emoji);
    match mapped {
        Some(name) => {
            slot.insert(key.to_owned(), serde_json::json!({ "t": "lucide", "v": name }));
        }
        None => {
            slot.remove(key);
        }
    }
    true
}

/// A callout `icon` attribute (the editor's `Icon` JSON) for a Lucide name.
#[must_use]
pub fn lucide_attr(name: &str) -> Value {
    serde_json::json!({ "t": "lucide", "v": name })
}

/// A callout `icon` attribute for an emoji found in imported content: its Lucide icon, or `None` when unmapped
/// (the callout then shows the editor's default glyph).
#[must_use]
pub fn callout_attr_for_emoji(emoji: &str) -> Option<Value> {
    lucide_for_emoji(emoji).map(lucide_attr)
}

/// `true` when `s` contains an emoji pictograph (used to keep generated content emoji-free).
#[must_use]
pub fn has_pictograph(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c as u32,
            0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_loads_and_maps() {
        assert!(MAP.len() > 100, "emoji map has {} entries", MAP.len());
        assert_eq!(lucide_for_emoji("\u{1F680}"), Some("rocket"));
        // Variation selector and skin tone are ignored.
        assert_eq!(lucide_for_emoji("\u{2708}\u{FE0F}"), Some("plane"));
        assert_eq!(lucide_for_emoji("\u{1F44B}\u{1F3FD}"), Some("hand"));
        assert_eq!(lucide_for_emoji(""), None);
        assert_eq!(lucide_for_emoji("abc"), None);
    }

    #[test]
    fn icons_migrate() {
        assert_eq!(
            migrate_icon(Icon::Emoji {
                v: "\u{1F680}".into()
            }),
            Some(Icon::Lucide {
                v: "rocket".into(),
                color: None
            })
        );
        // Unmapped → no icon.
        assert_eq!(migrate_icon(Icon::Emoji { v: "zz".into() }), None);
        let l = Icon::Lucide {
            v: "star".into(),
            color: Some("blue".into()),
        };
        assert_eq!(migrate_icon(l.clone()), Some(l));
    }

    #[test]
    fn json_fields_migrate() {
        let mut m = serde_json::json!({"icon": {"t": "emoji", "v": "\u{1F680}"}, "title": "x"});
        let o = m.as_object_mut().unwrap();
        assert!(migrate_icon_field(o, "icon"));
        assert_eq!(o["icon"], serde_json::json!({"t": "lucide", "v": "rocket"}));
        assert!(!migrate_icon_field(o, "icon"), "idempotent");
        let mut m = serde_json::json!({"icon": {"t": "emoji", "v": "qq"}});
        let o = m.as_object_mut().unwrap();
        assert!(migrate_icon_field(o, "icon"));
        assert!(!o.contains_key("icon"));
        assert!(has_pictograph("a \u{1F4A1} b"));
        assert!(!has_pictograph("plain (c) text"));
    }
}
