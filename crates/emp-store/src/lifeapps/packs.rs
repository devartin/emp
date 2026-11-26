//! Account-type and holiday packs (`crates/emp-store/packs/`). Tax packs live in `emp-finance`; the app passes
//! the chosen tax pack to [`crate::Store::lifeapps_register_pack`] so Tax Organizer can read `pack.*`.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::{Result, StoreError};

/// One account type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountType {
    /// Id (`roth_ira`).
    pub id: String,
    /// Label.
    pub label: String,
    /// `taxable|deferred|free`.
    pub tax_treatment: String,
    /// Explanation.
    pub note: String,
}

/// `packs/accounts/<country>.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPack {
    /// ISO country (`*` = generic).
    pub country: String,
    /// Name.
    pub name: String,
    /// Holding period for long-term gains (days, strictly more than).
    pub long_term_holding_days: u32,
    /// Account types.
    pub types: Vec<AccountType>,
}

/// One holiday.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Holiday {
    /// Date.
    pub date: NaiveDate,
    /// Name.
    pub name: String,
}

/// `packs/holidays/<country>.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HolidayPack {
    /// ISO country.
    pub country: String,
    /// Name.
    pub name: String,
    /// Verified on.
    pub verified_on: NaiveDate,
    /// Source.
    pub source: String,
    /// Holidays.
    pub dates: Vec<Holiday>,
}

const ACCOUNT_SOURCES: &[&str] = &[
    include_str!("../../packs/accounts/us.json"),
    include_str!("../../packs/accounts/generic.json"),
];
const HOLIDAY_SOURCES: &[&str] = &[include_str!("../../packs/holidays/us.json")];

fn parse_all<T: for<'de> Deserialize<'de>>(srcs: &[&str]) -> Result<Vec<T>> {
    srcs.iter()
        .map(|s| serde_json::from_str(s).map_err(|e| StoreError::invalid(format!("pack: {e}"))))
        .collect()
}

static ACCOUNTS: LazyLock<Vec<AccountPack>> =
    LazyLock::new(|| parse_all(ACCOUNT_SOURCES).unwrap_or_default());
static HOLIDAYS: LazyLock<Vec<HolidayPack>> =
    LazyLock::new(|| parse_all(HOLIDAY_SOURCES).unwrap_or_default());

/// The account pack of a country (falls back to the generic pack).
#[must_use]
pub fn accounts(country: &str) -> Option<&'static AccountPack> {
    ACCOUNTS
        .iter()
        .find(|p| p.country.eq_ignore_ascii_case(country))
        .or_else(|| ACCOUNTS.iter().find(|p| p.country == "*"))
}

/// Holidays of a country (empty when no pack exists).
#[must_use]
pub fn holidays(country: &str) -> BTreeSet<NaiveDate> {
    HOLIDAYS
        .iter()
        .filter(|p| p.country.eq_ignore_ascii_case(country))
        .flat_map(|p| p.dates.iter().map(|h| h.date))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_parse() {
        assert_eq!(parse_all::<AccountPack>(ACCOUNT_SOURCES).unwrap().len(), 2);
        assert_eq!(parse_all::<HolidayPack>(HOLIDAY_SOURCES).unwrap().len(), 1);
        let us = accounts("us").unwrap();
        assert!(
            us.types
                .iter()
                .any(|t| t.id == "roth_ira" && t.tax_treatment == "free")
        );
        assert_eq!(accounts("FR").unwrap().country, "*");
        let h = holidays("US");
        assert!(h.contains(&NaiveDate::from_ymd_opt(2026, 11, 26).unwrap()));
        assert!(holidays("XX").is_empty());
    }
}
