//! Expected-document checklist (Tax Organizer "Document checklist" database) from `pack.documents` and the
//! user's answers.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::pack::TaxPack;

/// An expected document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedDoc {
    /// Document (e.g. `W-2`).
    pub doc: String,
    /// The answer tag that triggered it.
    pub because: String,
    /// When it is normally available (in the following year).
    pub expected_by: Option<NaiveDate>,
}

/// Builds the checklist. `answers` are tags such as `income:employment`, `event:bought_home`, `hsa`.
/// A rule's `when` may list alternatives separated by `|`. Documents appear once, in pack order.
pub fn expected_documents(pack: &TaxPack, answers: &[String]) -> Vec<ExpectedDoc> {
    let mut out: Vec<ExpectedDoc> = Vec::new();
    for rule in &pack.documents {
        let Some(hit) = rule
            .when
            .split('|')
            .map(str::trim)
            .find(|alt| answers.iter().any(|a| a == alt))
        else {
            continue;
        };
        for doc in &rule.docs {
            if out.iter().any(|d| &d.doc == doc) {
                continue;
            }
            let expected_by = pack.expected_by.get(doc).and_then(|md| {
                NaiveDate::parse_from_str(&format!("{}-{md}", pack.year + 1), "%Y-%m-%d").ok()
            });
            out.push(ExpectedDoc {
                doc: doc.clone(),
                because: hit.to_string(),
                expected_by,
            });
        }
    }
    out
}

/// Whether an expected document is late (`doc-late` rule: not received by expected date + 14 days).
pub fn is_late(doc: &ExpectedDoc, received: bool, today: NaiveDate) -> bool {
    !received && doc.expected_by.is_some_and(|d| (today - d).num_days() > 14)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tax::pack::builtin;

    #[test]
    fn checklist() {
        let us = builtin("us-federal-2026").unwrap();
        let answers: Vec<String> = [
            "income:employment",
            "income:crypto",
            "deduction:mortgage",
            "hsa",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let docs = expected_documents(&us, &answers);
        let names: Vec<&str> = docs.iter().map(|d| d.doc.as_str()).collect();
        assert_eq!(
            names,
            [
                "W-2",
                "1099-B",
                "Consolidated 1099",
                "1098",
                "1099-SA",
                "5498-SA"
            ]
        );
        assert_eq!(docs[0].expected_by.unwrap().to_string(), "2027-01-31");
        assert_eq!(docs[1].because, "income:crypto");
        assert!(is_late(&docs[0], false, "2027-02-15".parse().unwrap()));
        assert!(!is_late(&docs[0], false, "2027-02-14".parse().unwrap()));
        assert!(!is_late(&docs[0], true, "2027-06-01".parse().unwrap()));
    }
}
