//! The advisor (§16.1): rules evaluated with the Metric dialect after each metric refresh, producing
//! [`Insight`] records ranked critical > warn > tip > info, then by recency. Muting is per instance and rule.

use std::collections::BTreeMap;

use emp_sheets::dialect::metric;
use serde::Serialize;
use serde_json::{Value, json};

use crate::lifeapps::manifest::{LifeAppManifest, Severity};
use crate::lifeapps::metrics::{MathLine, MetricData, MetricValue, context};

/// An insight action.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InsightAction {
    /// Label.
    pub label: String,
    /// `Route` (§11.2) as JSON.
    pub route: Value,
}

/// `Insight` (§11.2).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    /// `<instanceId>:<ruleId>`.
    pub id: String,
    /// Instance.
    pub app_instance_id: String,
    /// Rule.
    pub rule_id: String,
    /// Severity.
    pub severity: Severity,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// "Show math".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub math: Option<Vec<MathLine>>,
    /// Actions.
    pub actions: Vec<InsightAction>,
    /// Muted until (unix ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted_until: Option<i64>,
    /// When the insight was produced (ranking only; not part of the IPC shape).
    #[serde(skip)]
    pub at: i64,
}

/// Converts a manifest route string into a `Route` (§11.2).
#[must_use]
pub fn route(s: &str, instance_id: &str, key_map: &BTreeMap<String, String>) -> Value {
    let mut parts = s.splitn(3, ':');
    let kind = parts.next().unwrap_or_default();
    let a = parts.next();
    let b = parts.next();
    let id = |k: &str| key_map.get(k).cloned();
    match (kind, a) {
        ("page", Some(k)) => id(k).map_or_else(
            || json!({"t": "app", "instanceId": instance_id}),
            |i| json!({"t": "page", "id": i}),
        ),
        ("db", Some(k)) => match id(k) {
            Some(i) => {
                let mut r = json!({"t": "db", "id": i});
                if let Some(v) = b.and_then(|v| id(&format!("{k}.view:{v}"))) {
                    r["viewId"] = json!(v);
                }
                r
            }
            None => json!({"t": "app", "instanceId": instance_id}),
        },
        ("sheet", Some(k)) => id(k).map_or_else(
            || json!({"t": "app", "instanceId": instance_id}),
            |i| json!({"t": "sheet", "id": i}),
        ),
        ("app", tab) => {
            let mut r = json!({"t": "app", "instanceId": instance_id});
            if let Some(t) = tab {
                r["tab"] = json!(t);
            }
            r
        }
        ("settings", Some(sec)) => json!({"t": "settings", "section": sec}),
        ("lifeapps", app) => app.map_or_else(
            || json!({"t": "lifeapps"}),
            |x| json!({"t": "lifeapps", "appId": x}),
        ),
        ("today", _) => json!({"t": "today"}),
        ("markets", _) => json!({"t": "markets"}),
        _ => json!({"t": "home"}),
    }
}

/// Evaluates every advisor rule. `muted` maps rule ids to a mute deadline (`None` = muted forever); muted rules
/// are returned with `mutedUntil` set while the mute is active.
#[must_use]
pub fn evaluate(
    m: &LifeAppManifest,
    d: &MetricData,
    values: &BTreeMap<String, MetricValue>,
    key_map: &BTreeMap<String, String>,
    muted: &BTreeMap<String, Option<i64>>,
) -> Vec<Insight> {
    let ctx = context(d, values);
    let mut out = Vec::new();
    for r in &m.advisor {
        if !metric::test(&r.when, &ctx).unwrap_or(false) {
            continue;
        }
        let muted_until = match muted.get(&r.id) {
            // Muted "forever": the largest valid JS date (8.64e15 ms), safe as a JSON number.
            Some(None) => Some(8_640_000_000_000_000),
            Some(Some(t)) if *t > d.now_ms => Some(*t),
            _ => None,
        };
        let math: Vec<MathLine> = r
            .math_metrics
            .iter()
            .filter_map(|n| {
                values.get(n).map(|v| MathLine {
                    label: n.replace('_', " "),
                    value: v.display.clone(),
                    source: v.math.first().and_then(|l| l.source.clone()),
                })
            })
            .collect();
        out.push(Insight {
            id: format!("{}:{}", d.instance_id, r.id),
            app_instance_id: d.instance_id.clone(),
            rule_id: r.id.clone(),
            severity: r.severity,
            title: metric::interpolate(&r.title, &ctx),
            body: metric::interpolate(&r.body, &ctx),
            math: (!math.is_empty()).then_some(math),
            actions: r
                .actions
                .iter()
                .map(|a| InsightAction {
                    label: a.label.clone(),
                    route: route(&a.route, &d.instance_id, key_map),
                })
                .collect(),
            muted_until,
            at: values.values().map(|v| v.as_of).max().unwrap_or(d.now_ms),
        });
    }
    out
}

/// Ranks insights: unmuted first, then critical > warn > tip > info, then most recent first.
pub fn rank(list: &mut [Insight]) {
    list.sort_by(|a, b| {
        a.muted_until
            .is_some()
            .cmp(&b.muted_until.is_some())
            .then(b.severity.cmp(&a.severity))
            .then(b.at.cmp(&a.at))
            .then(a.id.cmp(&b.id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ins(id: &str, s: Severity, at: i64, muted: bool) -> Insight {
        Insight {
            id: id.into(),
            app_instance_id: "i".into(),
            rule_id: id.into(),
            severity: s,
            title: String::new(),
            body: String::new(),
            math: None,
            actions: Vec::new(),
            muted_until: muted.then_some(1),
            at,
        }
    }

    #[test]
    fn ranking_and_routes() {
        let mut v = vec![
            ins("a", Severity::Info, 5, false),
            ins("b", Severity::Critical, 1, true),
            ins("c", Severity::Warn, 1, false),
            ins("d", Severity::Warn, 9, false),
            ins("e", Severity::Tip, 1, false),
        ];
        rank(&mut v);
        let ids: Vec<&str> = v.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["d", "c", "e", "a", "b"]);
        let km = BTreeMap::from([
            ("budgets".to_owned(), "db1".to_owned()),
            ("budgets.view:month".to_owned(), "v1".to_owned()),
        ]);
        assert_eq!(
            route("db:budgets:month", "inst", &km),
            json!({"t": "db", "id": "db1", "viewId": "v1"})
        );
        assert_eq!(
            route("app:Budget", "inst", &km),
            json!({"t": "app", "instanceId": "inst", "tab": "Budget"})
        );
        assert_eq!(
            route("settings:security", "inst", &km),
            json!({"t": "settings", "section": "security"})
        );
        assert_eq!(
            route("page:missing", "inst", &km),
            json!({"t": "app", "instanceId": "inst"})
        );
        assert_eq!(route("today", "inst", &km), json!({"t": "today"}));
    }
}
