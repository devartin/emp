//! The import preview pipeline (`finance_import_preview` / `finance_import_commit`): payee normalisation and
//! aliasing, import ids, dedupe, rules, learned categories and transfer pairing for parsed statement rows.

use std::collections::HashSet;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::{ImportFormat, StatementTxn};
use crate::dedupe::{
    DedupeVerdict, Existing, Incoming, classify, hashed_import_id, occurrence_indexes,
    ofx_import_id,
};
use crate::payee::{PayeeAliases, normalize};
use crate::rules::{CategoryLearner, RuleSet, RuleTxn};
use crate::transfers::{TransferCandidate, detect};

/// How a category was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// A rule matched.
    Rule,
    /// The payee's most used category (or the payee row's default).
    Learned,
    /// Nothing.
    None,
}

/// A preview row (IPC `finance_import_preview.rows[]` plus `importId`, `tags`, `markTransfer`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRow {
    /// Source row index.
    pub idx: usize,
    /// Date.
    pub date: NaiveDate,
    /// Display payee (alias, rule rename or normalised).
    pub payee: String,
    /// Raw payee text.
    pub raw_payee: String,
    /// Signed amount.
    pub amount: Decimal,
    /// Category.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    /// How it was categorised.
    pub confidence: Confidence,
    /// Rule that categorised it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    /// Exact duplicate of an existing row (skipped by default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
    /// Possible duplicate (review lane).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub possible_duplicate: Option<String>,
    /// Counterpart row id when this looks like a transfer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_pair: Option<String>,
    /// Import id to store in `txn.import_id`.
    pub import_id: String,
    /// Tags from rules.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// A rule asked to mark this as a transfer.
    #[serde(default)]
    pub mark_transfer: bool,
}

/// Preview totals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// Rows.
    pub rows: Vec<PreviewRow>,
    /// Rows that are not exact duplicates.
    pub new_count: usize,
    /// Exact duplicates.
    pub duplicates: usize,
    /// Rows with a category.
    pub categorized: usize,
}

/// Context for the preview.
#[derive(Debug, Clone, Copy)]
pub struct PreviewContext<'a> {
    /// Target account id.
    pub account_id: &'a str,
    /// Statement format (selects the import-id scheme).
    pub format: ImportFormat,
    /// Existing rows in the target account.
    pub existing: &'a [Existing],
    /// Payee aliases.
    pub aliases: &'a PayeeAliases,
    /// Compiled rules.
    pub rules: &'a RuleSet,
    /// Learned categories.
    pub learner: &'a CategoryLearner,
    /// Unlinked rows in the user's other accounts (for transfer pairing).
    pub other_accounts: &'a [TransferCandidate],
    /// Account ids the user owns.
    pub owned_accounts: &'a HashSet<String>,
}

/// Builds the preview for parsed rows.
pub fn preview(rows: &[StatementTxn], cx: &PreviewContext<'_>) -> Preview {
    let normalized: Vec<String> = rows.iter().map(|r| normalize(&r.payee)).collect();
    let occ = occurrence_indexes(
        &rows
            .iter()
            .zip(&normalized)
            .map(|(r, p)| (r.date, r.amount, p.clone()))
            .collect::<Vec<_>>(),
    );
    let ids: Vec<String> = rows
        .iter()
        .zip(&normalized)
        .zip(&occ)
        .map(|((r, p), o)| match (&r.fitid, cx.format) {
            (Some(f), ImportFormat::Ofx | ImportFormat::Qfx) if !f.trim().is_empty() => {
                ofx_import_id(cx.account_id, f)
            }
            _ => hashed_import_id(cx.account_id, r.date, r.amount, p, *o),
        })
        .collect();
    let incoming: Vec<Incoming> = rows
        .iter()
        .zip(&normalized)
        .zip(&ids)
        .map(|((r, p), id)| Incoming {
            import_id: id.clone(),
            date: r.date,
            amount: r.amount,
            payee: p.clone(),
        })
        .collect();
    let verdicts = classify(&incoming, cx.existing);

    // Transfer pairing against the other accounts (new, non-duplicate rows only).
    let mut cands: Vec<TransferCandidate> = cx
        .other_accounts
        .iter()
        .filter(|c| c.account_id != cx.account_id)
        .cloned()
        .collect();
    for (i, r) in rows.iter().enumerate() {
        if !matches!(verdicts[i], DedupeVerdict::Duplicate { .. }) {
            cands.push(TransferCandidate {
                id: format!("#new:{i}"),
                account_id: cx.account_id.to_string(),
                date: r.date,
                amount: r.amount,
                linked: false,
            });
        }
    }
    let pairs = detect(&cands, cx.owned_accounts);
    let pair_for = |i: usize| {
        let me = format!("#new:{i}");
        pairs.iter().find_map(|p| {
            if p.outflow == me && !p.inflow.starts_with("#new:") {
                Some(p.inflow.clone())
            } else if p.inflow == me && !p.outflow.starts_with("#new:") {
                Some(p.outflow.clone())
            } else {
                None
            }
        })
    };

    let mut out = Vec::with_capacity(rows.len());
    let (mut dups, mut cats) = (0, 0);
    for (i, r) in rows.iter().enumerate() {
        let alias = cx.aliases.resolve(&r.payee);
        let mut payee = alias.map_or_else(|| normalized[i].clone(), |a| a.name.clone());
        let outcome = cx.rules.apply(&RuleTxn {
            payee: &payee,
            raw: &r.payee,
            memo: r.memo.as_deref().unwrap_or(""),
            amount: r.amount,
            account_id: cx.account_id,
            date: r.date,
        });
        if let Some(n) = &outcome.rename_payee {
            payee.clone_from(n);
        }
        let (category_id, confidence, rule_id) = if let Some(c) = outcome.category_id.clone() {
            (
                Some(c),
                Confidence::Rule,
                outcome.first_rule().map(str::to_string),
            )
        } else if let Some(c) = alias
            .and_then(|a| a.default_category_id.clone())
            .or_else(|| cx.learner.suggest(&payee).map(str::to_string))
        {
            (Some(c), Confidence::Learned, None)
        } else {
            (None, Confidence::None, None)
        };
        let (duplicate_of, possible_duplicate) = match &verdicts[i] {
            DedupeVerdict::Duplicate { of } => (Some(of.clone()), None),
            DedupeVerdict::Possible { of, .. } => (None, Some(of.clone())),
            DedupeVerdict::New => (None, None),
        };
        if duplicate_of.is_some() {
            dups += 1;
        }
        if category_id.is_some() {
            cats += 1;
        }
        out.push(PreviewRow {
            idx: r.idx,
            date: r.date,
            payee,
            raw_payee: r.payee.clone(),
            amount: r.amount,
            category_id,
            confidence,
            rule_id,
            duplicate_of,
            possible_duplicate,
            transfer_pair: pair_for(i),
            import_id: ids[i].clone(),
            tags: outcome.tags,
            mark_transfer: outcome.mark_transfer,
        });
    }
    Preview {
        new_count: rows.len() - dups,
        duplicates: dups,
        categorized: cats,
        rows: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payee::PayeeRef;
    use crate::rules::{Condition, Field, Op, Rule, Then, When};

    fn st(idx: usize, date: &str, amount: &str, payee: &str, fitid: Option<&str>) -> StatementTxn {
        let mut t = StatementTxn::new(
            idx,
            date.parse().unwrap(),
            amount.parse().unwrap(),
            payee.into(),
        );
        t.fitid = fitid.map(str::to_string);
        t
    }

    #[test]
    fn full_pipeline() {
        let rows = vec![
            st(
                0,
                "2026-01-05",
                "-4.50",
                "POS STARBUCKS STORE 123 SEATTLE WA",
                Some("F1"),
            ),
            st(
                1,
                "2026-01-06",
                "-500.00",
                "ONLINE TRANSFER TO SAVINGS",
                Some("F2"),
            ),
            st(2, "2026-01-07", "-60.00", "SHELL OIL #5744", Some("F3")),
            st(3, "2026-01-08", "-15.49", "NETFLIX.COM", Some("F4")),
        ];
        let existing = vec![
            Existing {
                id: "e1".into(),
                import_id: Some("ofx:chk:F1".into()),
                date: "2026-01-05".parse().unwrap(),
                amount: "-4.50".parse().unwrap(),
                payee: "Starbucks Store".into(),
            },
            Existing {
                id: "e2".into(),
                import_id: None,
                date: "2026-01-09".parse().unwrap(),
                amount: "-15.49".parse().unwrap(),
                payee: "Netflix.com".into(),
            },
        ];
        let mut aliases = PayeeAliases::new();
        aliases.insert(
            "Shell Oil",
            PayeeRef {
                payee_id: "p-shell".into(),
                name: "Shell".into(),
                default_category_id: Some("fuel".into()),
            },
        );
        let rules = RuleSet::compile(&[Rule {
            id: "r1".into(),
            name: "Streaming".into(),
            priority: 1,
            when: When {
                all: vec![Condition {
                    field: Field::Payee,
                    op: Op::Contains,
                    value: "netflix".into(),
                }],
            },
            then: Then {
                category_id: Some("subs".into()),
                tags: Some(vec!["streaming".into()]),
                ..Then::default()
            },
            continue_: false,
            times_applied: 0,
        }])
        .unwrap();
        let mut learner = CategoryLearner::new();
        learner.observe("Online Transfer To Savings", "xfer-cat");
        let others = vec![TransferCandidate {
            id: "s1".into(),
            account_id: "sav".into(),
            date: "2026-01-07".parse().unwrap(),
            amount: "500.00".parse().unwrap(),
            linked: false,
        }];
        let owned: HashSet<String> = ["chk", "sav"].iter().map(|s| s.to_string()).collect();
        let cx = PreviewContext {
            account_id: "chk",
            format: ImportFormat::Ofx,
            existing: &existing,
            aliases: &aliases,
            rules: &rules,
            learner: &learner,
            other_accounts: &others,
            owned_accounts: &owned,
        };
        let p = preview(&rows, &cx);
        assert_eq!(p.duplicates, 1);
        assert_eq!(p.new_count, 3);
        assert_eq!(p.rows[0].duplicate_of.as_deref(), Some("e1"));
        assert_eq!(p.rows[1].transfer_pair.as_deref(), Some("s1"));
        assert_eq!(p.rows[1].confidence, Confidence::Learned);
        assert_eq!(
            (p.rows[2].payee.as_str(), p.rows[2].category_id.as_deref()),
            ("Shell", Some("fuel"))
        );
        assert_eq!(p.rows[3].confidence, Confidence::Rule);
        assert_eq!(p.rows[3].rule_id.as_deref(), Some("r1"));
        assert_eq!(p.rows[3].possible_duplicate.as_deref(), Some("e2"));
        assert_eq!(p.rows[3].import_id, "ofx:chk:F4");
        assert_eq!(p.categorized, 3);
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["rows"][3]["confidence"], "rule");
        assert_eq!(j["newCount"], 3);
    }
}
