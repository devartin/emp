//! Duplicate detection for imports (§15.2 Dedupe).
//!
//! * Exact: OFX/QFX match on `(account, FITID)`; CSV/QIF match on
//!   `sha256(account ‖ date ‖ amount_minor ‖ normalized_payee ‖ occurrence_index)`.
//! * Fuzzy: same amount, within ±3 days and Jaro-Winkler(payee) ≥ 0.90 → "possible duplicate"
//!   review lane. Fuzzy matches are never dropped automatically.

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::money::minor_units;
use crate::payee::payee_key;

/// Fuzzy window in days.
pub const FUZZY_DAYS: i64 = 3;
/// Fuzzy payee similarity threshold.
pub const FUZZY_JW: f64 = 0.90;

/// Lower-case hex of a byte slice.
pub fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

/// The exact import id for OFX/QFX rows: `ofx:<account>:<fitid>`.
pub fn ofx_import_id(account_id: &str, fitid: &str) -> String {
    format!("ofx:{account_id}:{}", fitid.trim())
}

/// The exact import id for CSV/QIF rows (hex sha256 over the unit-separator-joined fields).
pub fn hashed_import_id(
    account_id: &str,
    date: NaiveDate,
    amount: Decimal,
    normalized_payee: &str,
    occurrence: u32,
) -> String {
    let mut h = Sha256::new();
    let minor = minor_units(amount, 2).to_string();
    let payee = payee_key(normalized_payee);
    for (i, part) in [
        account_id,
        &date.to_string(),
        &minor,
        &payee,
        &occurrence.to_string(),
    ]
    .iter()
    .enumerate()
    {
        if i > 0 {
            h.update([0x1f]);
        }
        h.update(part.as_bytes());
    }
    format!("h:{}", hex(&h.finalize()))
}

/// Assigns occurrence indexes so identical (date, amount, payee) rows within one file get distinct ids.
pub fn occurrence_indexes(rows: &[(NaiveDate, Decimal, String)]) -> Vec<u32> {
    let mut seen: HashMap<(NaiveDate, i64, String), u32> = HashMap::new();
    rows.iter()
        .map(|(d, a, p)| {
            let n = seen
                .entry((*d, minor_units(*a, 2), payee_key(p)))
                .or_default();
            let idx = *n;
            *n += 1;
            idx
        })
        .collect()
}

/// An incoming row to classify.
#[derive(Debug, Clone, PartialEq)]
pub struct Incoming {
    /// Exact import id (from [`ofx_import_id`] or [`hashed_import_id`]).
    pub import_id: String,
    /// Date.
    pub date: NaiveDate,
    /// Signed amount.
    pub amount: Decimal,
    /// Normalised payee.
    pub payee: String,
}

/// An existing ledger row in the same account.
#[derive(Debug, Clone, PartialEq)]
pub struct Existing {
    /// Row id.
    pub id: String,
    /// Stored import id, if the row was imported.
    pub import_id: Option<String>,
    /// Date.
    pub date: NaiveDate,
    /// Signed amount.
    pub amount: Decimal,
    /// Normalised payee.
    pub payee: String,
}

/// Classification of one incoming row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DedupeVerdict {
    /// Not seen before.
    New,
    /// Exact duplicate of an existing row (skipped by default).
    Duplicate {
        /// Existing row id.
        of: String,
    },
    /// Possible duplicate (review lane; imported unless the user skips it).
    Possible {
        /// Existing row id.
        of: String,
        /// Payee similarity.
        similarity: u32,
    },
}

/// Classifies incoming rows against existing ones (same account). Each existing row is matched at most
/// once per lane, and incoming rows with the same import id inside one batch are duplicates of the first.
pub fn classify(incoming: &[Incoming], existing: &[Existing]) -> Vec<DedupeVerdict> {
    let by_id: HashMap<&str, &str> = existing
        .iter()
        .filter_map(|e| e.import_id.as_deref().map(|i| (i, e.id.as_str())))
        .collect();
    let mut used_fuzzy: HashSet<usize> = HashSet::new();
    let mut batch_ids: HashMap<&str, usize> = HashMap::new();
    let mut out = Vec::with_capacity(incoming.len());
    for (k, row) in incoming.iter().enumerate() {
        if let Some(of) = by_id.get(row.import_id.as_str()) {
            out.push(DedupeVerdict::Duplicate {
                of: (*of).to_string(),
            });
            continue;
        }
        if let Some(first) = batch_ids.get(row.import_id.as_str()) {
            out.push(DedupeVerdict::Duplicate {
                of: format!("#{first}"),
            });
            continue;
        }
        batch_ids.insert(row.import_id.as_str(), k);
        let key = payee_key(&row.payee);
        let best = existing
            .iter()
            .enumerate()
            .filter(|(i, e)| {
                !used_fuzzy.contains(i)
                    && e.amount == row.amount
                    && (e.date - row.date).num_days().abs() <= FUZZY_DAYS
                    && e.import_id.as_deref() != Some(row.import_id.as_str())
            })
            .map(|(i, e)| (i, strsim::jaro_winkler(&key, &payee_key(&e.payee))))
            .filter(|(_, s)| *s >= FUZZY_JW)
            .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(&a.0)));
        match best {
            Some((i, s)) => {
                used_fuzzy.insert(i);
                out.push(DedupeVerdict::Possible {
                    of: existing[i].id.clone(),
                    similarity: (s * 100.0).round() as u32,
                });
            }
            None => out.push(DedupeVerdict::New),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn hashes_are_stable_and_distinct() {
        let a = hashed_import_id(
            "acc",
            d("2026-01-02"),
            "-4.50".parse().unwrap(),
            "Starbucks",
            0,
        );
        let b = hashed_import_id(
            "acc",
            d("2026-01-02"),
            "-4.5".parse().unwrap(),
            "STARBUCKS",
            0,
        );
        let c = hashed_import_id(
            "acc",
            d("2026-01-02"),
            "-4.50".parse().unwrap(),
            "Starbucks",
            1,
        );
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 2 + 64);
        assert_eq!(ofx_import_id("acc", " 123 "), "ofx:acc:123");
    }

    #[test]
    fn occurrences() {
        let r = vec![
            (d("2026-01-01"), "-5".parse().unwrap(), "A".to_string()),
            (d("2026-01-01"), "-5.00".parse().unwrap(), "a".to_string()),
            (d("2026-01-01"), "-6".parse().unwrap(), "A".to_string()),
        ];
        assert_eq!(occurrence_indexes(&r), vec![0, 1, 0]);
    }

    #[test]
    fn exact_fuzzy_and_new() {
        let existing = vec![
            Existing {
                id: "e1".into(),
                import_id: Some("X".into()),
                date: d("2026-01-01"),
                amount: "-10".parse().unwrap(),
                payee: "Shell".into(),
            },
            Existing {
                id: "e2".into(),
                import_id: None,
                date: d("2026-01-05"),
                amount: "-42.10".parse().unwrap(),
                payee: "Whole Foods Market".into(),
            },
        ];
        let incoming = vec![
            Incoming {
                import_id: "X".into(),
                date: d("2026-01-01"),
                amount: "-10".parse().unwrap(),
                payee: "Shell".into(),
            },
            Incoming {
                import_id: "Y".into(),
                date: d("2026-01-07"),
                amount: "-42.10".parse().unwrap(),
                payee: "Whole Foods Mkt".into(),
            },
            Incoming {
                import_id: "Z".into(),
                date: d("2026-01-12"),
                amount: "-42.10".parse().unwrap(),
                payee: "Whole Foods Market".into(),
            },
            Incoming {
                import_id: "Z".into(),
                date: d("2026-01-12"),
                amount: "-42.10".parse().unwrap(),
                payee: "Whole Foods Market".into(),
            },
        ];
        let v = classify(&incoming, &existing);
        assert_eq!(v[0], DedupeVerdict::Duplicate { of: "e1".into() });
        assert!(matches!(&v[1], DedupeVerdict::Possible { of, .. } if of == "e2"));
        assert_eq!(v[2], DedupeVerdict::New, "outside ±3 days");
        assert_eq!(v[3], DedupeVerdict::Duplicate { of: "#2".into() });
    }
}
