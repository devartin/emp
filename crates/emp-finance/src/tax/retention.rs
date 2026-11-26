//! Record retention (§15.6 `keep_until(docType, filedDate)`).

use chrono::{Months, NaiveDate};
use serde::{Deserialize, Serialize};

use super::pack::TaxPack;

/// How long to keep a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeepUntil {
    /// Until this date.
    Date {
        /// Date.
        date: NaiveDate,
        /// Pack note.
        note: Option<String>,
    },
    /// Until N years after the return for the year the asset is sold (sale date unknown yet).
    UntilSoldPlus {
        /// Years after filing for the year of sale.
        years: u32,
        /// Pack note.
        note: Option<String>,
    },
    /// Keep indefinitely.
    Indefinitely {
        /// Pack note.
        note: Option<String>,
    },
}

fn plus_years(d: NaiveDate, years: u32) -> NaiveDate {
    d.checked_add_months(Months::new(years * 12)).unwrap_or(d)
}

/// Computes the retention for `doc_type` filed on `filed`. A return filed early counts as filed on the due
/// date (`due`), so the later of the two is used. For `until_sold_plus_N` rules, pass the filing date of the
/// return for the year of sale as `sale_return_filed` when known.
pub fn keep_until(
    pack: &TaxPack,
    doc_type: &str,
    filed: NaiveDate,
    due: Option<NaiveDate>,
    sale_return_filed: Option<NaiveDate>,
) -> KeepUntil {
    let rule = pack
        .retention
        .iter()
        .find(|r| r.doc_type == doc_type)
        .or_else(|| pack.retention.iter().find(|r| r.doc_type == "*"));
    let base = due.map_or(filed, |d| d.max(filed));
    let Some(r) = rule else {
        return KeepUntil::Date {
            date: plus_years(base, 3),
            note: None,
        };
    };
    let note = r.note.clone();
    match r.rule.as_deref() {
        Some("indefinite") => KeepUntil::Indefinitely { note },
        Some(s) if s.starts_with("until_sold_plus_") => {
            let years = s
                .trim_start_matches("until_sold_plus_")
                .parse()
                .unwrap_or(3);
            match sale_return_filed {
                Some(sf) => KeepUntil::Date {
                    date: plus_years(sf, years),
                    note,
                },
                None => KeepUntil::UntilSoldPlus { years, note },
            }
        }
        _ => KeepUntil::Date {
            date: plus_years(base, r.years.unwrap_or(3)),
            note,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tax::pack::builtin;

    #[test]
    fn rules() {
        let us = builtin("us-federal-2026").unwrap();
        let d = |s: &str| s.parse::<NaiveDate>().unwrap();
        // Filed early → counts from the due date.
        assert_eq!(
            keep_until(&us, "W-2", d("2027-02-20"), Some(d("2027-04-15")), None),
            KeepUntil::Date {
                date: d("2030-04-15"),
                note: us.retention[0].note.clone()
            }
        );
        assert!(
            matches!(keep_until(&us, "employment_tax", d("2027-04-15"), None, None), KeepUntil::Date { date, .. } if date == d("2031-04-15"))
        );
        assert!(matches!(
            keep_until(&us, "property_basis", d("2027-04-15"), None, None),
            KeepUntil::UntilSoldPlus { years: 3, .. }
        ));
        assert!(
            matches!(keep_until(&us, "property_basis", d("2027-04-15"), None, Some(d("2035-04-10"))), KeepUntil::Date { date, .. } if date == d("2038-04-10"))
        );
        assert!(matches!(
            keep_until(&us, "no_return_or_fraud", d("2027-04-15"), None, None),
            KeepUntil::Indefinitely { .. }
        ));
    }
}
