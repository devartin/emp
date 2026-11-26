//! Typed views of property configuration (`Property.config`, an open JSON object on the wire).
//!
//! Unknown keys are preserved by the repositories; these structs only read what the engine needs and fall back
//! to defaults on malformed input (configuration is validated when it is written).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::model::{Property, PropertyPayload, RollupFn, SelectOption};
use crate::model::Id;

/// Reads a config struct (defaults on mismatch).
#[must_use]
pub fn read<T: DeserializeOwned + Default>(config: &Map<String, Value>) -> T {
    serde_json::from_value(Value::Object(config.clone())).unwrap_or_default()
}

/// `select` / `multi_select` / `status` configuration.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectConfig {
    /// Options in manual order.
    #[serde(default)]
    pub options: Vec<SelectOption>,
    /// `manual|alpha`.
    #[serde(default)]
    pub sort: Option<String>,
}

/// The dual side of a two-way relation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DualRef {
    /// The paired property in the target database (`None` while being created).
    #[serde(default)]
    pub property_id: Option<Id>,
}

/// `relation` configuration.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationConfig {
    /// Target database.
    #[serde(default)]
    pub target_database_id: Id,
    /// Two-way pairing.
    #[serde(default)]
    pub dual: Option<DualRef>,
    /// `one|many`.
    #[serde(default)]
    pub limit: Option<String>,
    /// Name of the dual property to create (creation only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dual_name: Option<String>,
}

impl RelationConfig {
    /// `true` for `limit: 'one'`.
    #[must_use]
    pub fn single(&self) -> bool {
        self.limit.as_deref() == Some("one")
    }

    /// The paired property id.
    #[must_use]
    pub fn dual_prop(&self) -> Option<&str> {
        self.dual.as_ref().and_then(|d| d.property_id.as_deref())
    }
}

/// `rollup` configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollupConfig {
    /// Relation property of this database.
    pub relation_prop_id: Id,
    /// Property of the target database.
    pub target_prop_id: Id,
    /// Function.
    #[serde(rename = "fn")]
    pub func: RollupFn,
}

impl Default for RollupConfig {
    fn default() -> Self {
        Self {
            relation_prop_id: String::new(),
            target_prop_id: String::new(),
            func: RollupFn::ShowOriginal,
        }
    }
}

/// `formula` configuration.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormulaConfig {
    /// Expression in storage form (`prop("#<id>")`).
    #[serde(default)]
    pub expression: String,
}

/// `money` configuration.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyConfig {
    /// Default currency.
    #[serde(default)]
    pub currency: Option<String>,
    /// Each row may carry its own currency.
    #[serde(default)]
    pub per_row_currency: bool,
    /// Display decimals.
    #[serde(default)]
    pub decimals: Option<u32>,
}

/// `number` configuration.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberConfig {
    /// `number|comma|percent`.
    #[serde(default)]
    pub format: Option<String>,
    /// Display decimals.
    #[serde(default)]
    pub decimals: Option<u32>,
}

/// `unique_id` configuration.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UidConfig {
    /// Prefix (`TASK` → `TASK-12`).
    #[serde(default)]
    pub prefix: Option<String>,
}

/// `rating` configuration.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RatingConfig {
    /// `5|10`.
    #[serde(default)]
    pub max: Option<u32>,
}

/// Options of a select-like property.
#[must_use]
pub fn options(config: &Map<String, Value>) -> Vec<SelectOption> {
    read::<SelectConfig>(config).options
}

/// Option name by id.
#[must_use]
pub fn option_name(config: &Map<String, Value>, id: &str) -> Option<String> {
    options(config)
        .into_iter()
        .find(|o| o.id == id)
        .map(|o| o.name)
}

/// Accessor trait over [`Property`] and [`PropertyPayload`].
pub trait HasConfig {
    /// The configuration.
    fn config(&self) -> &Map<String, Value>;

    /// Relation configuration.
    fn relation(&self) -> RelationConfig {
        read(self.config())
    }

    /// Rollup configuration (`None` when incomplete).
    fn rollup(&self) -> Option<RollupConfig> {
        serde_json::from_value(Value::Object(self.config().clone())).ok()
    }

    /// Formula expression.
    fn formula(&self) -> String {
        read::<FormulaConfig>(self.config()).expression
    }

    /// Select options.
    fn select_options(&self) -> Vec<SelectOption> {
        options(self.config())
    }

    /// Money configuration.
    fn money(&self) -> MoneyConfig {
        read(self.config())
    }
}

impl HasConfig for Property {
    fn config(&self) -> &Map<String, Value> {
        &self.config
    }
}

impl HasConfig for PropertyPayload {
    fn config(&self) -> &Map<String, Value> {
        &self.config
    }
}

/// Writes a serialisable value under `key` of a config object.
pub fn set(config: &mut Map<String, Value>, key: &str, value: impl Serialize) {
    if let Ok(v) = serde_json::to_value(value) {
        config.insert(key.to_owned(), v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn configs_read_with_defaults() {
        let c = json!({"targetDatabaseId":"db2","dual":{"propertyId":"p9"},"limit":"one"});
        let r: RelationConfig = read(c.as_object().unwrap());
        assert!(r.single());
        assert_eq!(r.dual_prop(), Some("p9"));
        let bad: RelationConfig = read(json!({"limit": 3}).as_object().unwrap());
        assert_eq!(bad, RelationConfig::default());
        let ro: RollupConfig =
            serde_json::from_value(json!({"relationPropId":"r","targetPropId":"t","fn":"sum"}))
                .unwrap();
        assert_eq!(ro.func, RollupFn::Sum);
    }
}
