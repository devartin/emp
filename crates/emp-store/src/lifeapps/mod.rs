//! # Life apps (SPEC §16)
//!
//! Guided, manifest-driven mini apps that generate ordinary EMP content — pages, databases, views, dashboards,
//! workbooks and reminders — from a short wizard, then keep it useful with metrics, advisor insights and a
//! checklist.
//!
//! * [`manifest`]: `LifeAppManifest` and the typed template specs (`deny_unknown_fields`, D-11). The six v1
//!   manifests live in `crates/emp-store/lifeapps/*.json` and are embedded below.
//! * [`answers`]: quick / guided resolution (defaults and [`recommend`]ations), Metric-dialect contexts and the
//!   `${path}` / `{{expr}}` templating of specs.
//! * [`plan`]: the pure `GenerationPlan` (preview) and `PlanDiff` (tune-up) DTOs.
//! * [`build`]: materialisation of a plan into records with `UUIDv5(instance, key)` ids ([`ids`]), generated
//!   documents ([`content`]) and workbooks ([`workbook`], with [`settle`] for split expenses).
//! * [`metrics`] and [`advisor`]: built-in metric functions (overridable by a [`metrics::MetricProvider`]),
//!   expression metrics and insight rules.
//! * [`sample`]: deterministic sample data.
//! * [`packs`]: account-type and holiday packs (`crates/emp-store/packs/`).
//!
//! The store-facing commands (`lifeapp_*` of §11.3) are `Store` methods in [`crate::repo::lifeapps`].

pub mod advisor;
pub mod answers;
pub mod build;
pub mod content;
pub mod ids;
pub mod manifest;
pub mod metrics;
pub mod packs;
pub mod plan;
pub mod recommend;
pub mod sample;
pub mod settle;
pub mod workbook;

use std::sync::LazyLock;

use serde::Serialize;

pub use manifest::LifeAppManifest;

/// The embedded manifests (`crates/emp-store/lifeapps/<id>.json`).
pub const MANIFEST_SOURCES: &[(&str, &str)] = &[
    ("money-hq", include_str!("../../lifeapps/money-hq.json")),
    ("portfolio", include_str!("../../lifeapps/portfolio.json")),
    (
        "tax-organizer",
        include_str!("../../lifeapps/tax-organizer.json"),
    ),
    (
        "spreadsheet-studio",
        include_str!("../../lifeapps/spreadsheet-studio.json"),
    ),
    ("life-os", include_str!("../../lifeapps/life-os.json")),
    ("habits", include_str!("../../lifeapps/habits.json")),
];

static CATALOG: LazyLock<Vec<LifeAppManifest>> = LazyLock::new(|| {
    MANIFEST_SOURCES
        .iter()
        .filter_map(|(_, src)| LifeAppManifest::parse(src).ok())
        .collect()
});

/// Every valid embedded manifest (a manifest that fails validation is left out; the test suite rejects it).
#[must_use]
pub fn catalog() -> &'static [LifeAppManifest] {
    &CATALOG
}

/// A manifest by app id.
#[must_use]
pub fn manifest(id: &str) -> Option<&'static LifeAppManifest> {
    catalog().iter().find(|m| m.id == id)
}

/// `LifeAppSummary` (§11.3).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeAppSummary {
    /// App id.
    pub id: String,
    /// Manifest version.
    pub version: String,
    /// Title.
    pub title: String,
    /// Tagline.
    pub tagline: String,
    /// Icon.
    pub icon: String,
    /// Colour.
    pub color: String,
    /// Category.
    pub category: String,
    /// Estimated minutes.
    pub est_minutes: u32,
    /// Installed instances (in the workspace asked about, or overall).
    pub installed: u32,
    /// Part of v1.
    pub v1: bool,
}

impl LifeAppSummary {
    /// Summary of a manifest.
    #[must_use]
    pub fn of(m: &LifeAppManifest, installed: u32) -> Self {
        Self {
            id: m.id.clone(),
            version: m.version.clone(),
            title: m.title.clone(),
            tagline: m.tagline.clone(),
            icon: m.icon.clone(),
            color: m.color.clone(),
            category: m.category.as_str().to_owned(),
            est_minutes: m.est_minutes,
            installed,
            v1: true,
        }
    }
}

/// Semver comparison (`a < b`).
#[must_use]
pub fn version_lt(a: &str, b: &str) -> bool {
    let p = |s: &str| -> Vec<u64> { s.split('.').map(|x| x.parse().unwrap_or(0)).collect() };
    p(a) < p(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_manifest_parses_and_validates() {
        for (id, src) in MANIFEST_SOURCES {
            let m = LifeAppManifest::parse(src).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert_eq!(&m.id, id);
            assert!(m.steps.iter().any(|s| s.quick), "{id}: needs quick steps");
            for t in &m.templates {
                t.typed().unwrap_or_else(|e| panic!("{id}/{}: {e}", t.key));
            }
        }
        assert_eq!(catalog().len(), MANIFEST_SOURCES.len());
        assert!(manifest("money-hq").is_some());
        assert!(manifest("nope").is_none());
        assert!(version_lt("1.0.0", "1.2.0"));
        assert!(!version_lt("1.10.0", "1.9.9"));
    }
}
