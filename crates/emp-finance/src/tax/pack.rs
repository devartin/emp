//! Tax pack data model (§15.6). Packs are JSON with `deny_unknown_fields`; the built-in packs are embedded
//! with `include_str!` from `crates/emp-finance/packs/tax/`.
//!
//! Per-status maps are keyed by filing status; the key `"*"` is the fallback for statuses not listed.

use std::collections::BTreeMap;

use chrono::{Months, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};

/// A per-filing-status map with `"*"` fallback.
pub type StatusMap<T> = BTreeMap<String, T>;

/// Looks up `status` in a [`StatusMap`], falling back to `"*"`.
pub fn by_status<'a, T>(m: &'a StatusMap<T>, status: &str) -> Option<&'a T> {
    m.get(status).or_else(|| m.get("*"))
}

/// Pack tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Full estimator (US federal).
    Estimator,
    /// Checklist/organizer only.
    Organizer,
    /// User-entered parameters (Generic).
    Custom,
}

/// A source citation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    /// Label.
    pub label: String,
    /// URL.
    pub url: String,
}

/// An ordinary-income bracket: income up to `up_to` (inclusive; `null` = unbounded) is taxed at `rate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bracket {
    /// Upper bound of taxable income for this bracket.
    pub up_to: Option<Decimal>,
    /// Marginal rate (fraction).
    pub rate: Decimal,
}

/// A preferential-rate band with per-status upper bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefBracket {
    /// Upper bound of *total* taxable income for this rate, per status (`null` = unbounded).
    pub up_to: StatusMap<Option<Decimal>>,
    /// Rate.
    pub rate: Decimal,
}

/// Preferential rates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferentialRates {
    /// Long-term capital gains and qualified dividends.
    pub ltcg_qualified_div: Vec<PrefBracket>,
}

/// Additional Medicare tax.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddlMedicare {
    /// Rate.
    pub rate: Decimal,
    /// Threshold on wages + SE earnings, per status.
    pub threshold: StatusMap<Decimal>,
}

/// Self-employment tax parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeTax {
    /// Net earnings factor (0.9235).
    pub net_earnings_factor: Decimal,
    /// Social Security rate (0.124).
    pub ss_rate: Decimal,
    /// Medicare rate (0.029).
    pub medicare_rate: Decimal,
    /// Social Security wage base (`null` = uncapped).
    #[serde(default)]
    pub ss_wage_base: Option<Decimal>,
    /// Deductible share (0.5).
    pub deductible_share: Decimal,
    /// No SE tax below this amount of net earnings (US: 400).
    #[serde(default)]
    pub minimum_net_earnings: Option<Decimal>,
    /// Additional Medicare tax.
    #[serde(default)]
    pub addl_medicare: Option<AddlMedicare>,
}

/// Net investment income tax.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Niit {
    /// Rate.
    pub rate: Decimal,
    /// MAGI threshold, per status.
    pub threshold: StatusMap<Decimal>,
}

/// Credit phase-out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Phaseout {
    /// MAGI where the phase-out starts, per status.
    pub start: StatusMap<Decimal>,
    /// Reduction per $1,000 (or part) above the start.
    pub per1000: Decimal,
}

/// Credit kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreditKind {
    /// Fixed amount per dependent.
    PerDependent,
    /// User-entered amount (nonrefundable).
    UserAmount,
}

/// A credit definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditDef {
    /// Id (`child_tax_credit`).
    pub id: String,
    /// Display label.
    #[serde(default)]
    pub label: Option<String>,
    /// Kind.
    pub kind: CreditKind,
    /// Amount per dependent.
    #[serde(default)]
    pub amount: Option<Decimal>,
    /// Phase-out.
    #[serde(default)]
    pub phaseout: Option<Phaseout>,
    /// Refundable portion per dependent.
    #[serde(default)]
    pub refundable_per_dependent: Option<Decimal>,
    /// Earned income above which the refundable portion builds up.
    #[serde(default)]
    pub refundable_earned_threshold: Option<Decimal>,
    /// Build-up rate on earned income above the threshold.
    #[serde(default)]
    pub refundable_earned_rate: Option<Decimal>,
}

/// Social Security benefit taxability base amounts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SocialSecurityRules {
    /// First base amount (50% tier), per status.
    pub base1: StatusMap<Decimal>,
    /// Second base amount (85% tier), per status.
    pub base2: StatusMap<Decimal>,
}

/// An itemised-deduction rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemizedRule {
    /// Itemised entry kind it applies to (`salt`, `medical`).
    pub kind: String,
    /// Cap per status.
    #[serde(default)]
    pub cap: Option<StatusMap<Decimal>>,
    /// Cap phase-down: reduced by `rate × (MAGI − start)`, not below `floor`.
    #[serde(default)]
    pub cap_phasedown: Option<CapPhasedown>,
    /// Only the part above `agiFloorPct × AGI` counts.
    #[serde(default)]
    pub agi_floor_pct: Option<Decimal>,
}

/// SALT-style cap phase-down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapPhasedown {
    /// MAGI where the phase-down starts, per status.
    pub start: StatusMap<Decimal>,
    /// Reduction rate.
    pub rate: Decimal,
    /// Minimum cap, per status.
    pub floor: StatusMap<Decimal>,
}

/// An estimated-payment period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EstPeriod {
    /// `Q1`..`Q4`.
    pub id: String,
    /// Statutory due date (shifted for weekends/holidays at use).
    pub due: NaiveDate,
}

/// Safe-harbor rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeHarbor {
    /// Share of prior-year tax (1.00).
    pub prior_year_pct: Decimal,
    /// Share when prior AGI is above the threshold (1.10).
    pub high_income_pct: Decimal,
    /// Prior-year AGI threshold, per status.
    pub high_income_agi: StatusMap<Decimal>,
    /// Share of current-year tax (0.90).
    pub current_year_pct: Decimal,
}

/// Estimated-tax parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Estimated {
    /// Periods.
    pub periods: Vec<EstPeriod>,
    /// Safe harbor.
    pub safe_harbor: SafeHarbor,
    /// Expected balance below which estimates are generally not required (US: 1,000).
    #[serde(default)]
    pub minimum_balance: Option<Decimal>,
}

/// Pack rounding mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackRounding {
    /// Whole dollars, half up.
    WholeDollarHalfUp,
    /// Cents, half up.
    CentsHalfUp,
}

/// A retention rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionRule {
    /// Document type (`*` = default).
    pub doc_type: String,
    /// Years after filing.
    #[serde(default)]
    pub years: Option<u32>,
    /// Special rule: `until_sold_plus_3` or `indefinite`.
    #[serde(default)]
    pub rule: Option<String>,
    /// Explanation.
    #[serde(default)]
    pub note: Option<String>,
}

/// A document checklist rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRule {
    /// Answer tags, `|`-separated alternatives (`event:bought_home|deduction:mortgage`).
    pub when: String,
    /// Documents to expect.
    pub docs: Vec<String>,
}

/// A deadline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deadline {
    /// Name.
    pub name: String,
    /// Statutory date.
    pub date: NaiveDate,
    /// Move to the next business day when it falls on a weekend or holiday.
    #[serde(default)]
    pub shift_weekend_holiday: bool,
}

/// Expected results of a pack test.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackExpect {
    /// Total tax.
    #[serde(default)]
    pub tax: Option<Decimal>,
    /// Taxable income.
    #[serde(default)]
    pub taxable: Option<Decimal>,
    /// AGI.
    #[serde(default)]
    pub agi: Option<Decimal>,
    /// Ordinary-rate tax.
    #[serde(default)]
    pub ordinary_tax: Option<Decimal>,
    /// SE tax.
    #[serde(default)]
    pub se_tax: Option<Decimal>,
}

/// A worked example the pack must reproduce.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackTest {
    /// Description.
    #[serde(default)]
    pub name: Option<String>,
    /// Input (a `TaxInput`).
    pub input: super::engine::TaxInput,
    /// Expected values.
    pub expect: PackExpect,
    /// Source of the example.
    pub source: String,
}

/// A tax pack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaxPack {
    /// Id (`us-federal-2026`).
    pub id: String,
    /// Display name.
    pub name: String,
    /// ISO country (`US`; `*` for generic).
    pub country: String,
    /// Tax year.
    pub year: i32,
    /// Tier.
    pub tier: Tier,
    /// Pack version.
    pub version: String,
    /// Date the figures were verified against official sources (`null` = unverified).
    pub verified_on: Option<NaiveDate>,
    /// Sources.
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Notes on scope and simplifications.
    #[serde(default)]
    pub notes: Vec<String>,
    /// Filing statuses.
    pub filing_statuses: Vec<String>,
    /// Ordinary brackets per status.
    pub brackets: StatusMap<Vec<Bracket>>,
    /// Standard deduction per status.
    pub standard_deduction: StatusMap<Decimal>,
    /// Additional standard deduction per 65+/blind person, per status.
    #[serde(default)]
    pub additional_std_deduction65_or_blind: StatusMap<Decimal>,
    /// Preferential rates.
    #[serde(default)]
    pub preferential_rates: Option<PreferentialRates>,
    /// SE tax.
    #[serde(default)]
    pub se_tax: Option<SeTax>,
    /// NIIT.
    #[serde(default)]
    pub niit: Option<Niit>,
    /// Credits.
    #[serde(default)]
    pub credits: Vec<CreditDef>,
    /// Net capital loss deductible against ordinary income, per status.
    #[serde(default)]
    pub capital_loss_limit: Option<StatusMap<Decimal>>,
    /// Social Security taxability.
    #[serde(default)]
    pub social_security: Option<SocialSecurityRules>,
    /// Itemised deduction rules.
    #[serde(default)]
    pub itemized_rules: Vec<ItemizedRule>,
    /// Estimated payments.
    #[serde(default)]
    pub estimated: Option<Estimated>,
    /// Rounding.
    pub rounding: PackRounding,
    /// Retention rules.
    #[serde(default)]
    pub retention: Vec<RetentionRule>,
    /// Document checklist rules.
    #[serde(default)]
    pub documents: Vec<DocumentRule>,
    /// Expected-by dates per document (`MM-DD` in the following year).
    #[serde(default)]
    pub expected_by: BTreeMap<String, String>,
    /// Deadlines.
    #[serde(default)]
    pub deadlines: Vec<Deadline>,
    /// Worked examples.
    #[serde(default)]
    pub tests: Vec<PackTest>,
}

/// Embedded US federal TY2026 pack JSON.
pub const US_FEDERAL_2026_JSON: &str = include_str!("../../packs/tax/us-federal-2026.json");
/// Embedded Generic/Custom pack JSON.
pub const GENERIC_JSON: &str = include_str!("../../packs/tax/generic.json");

/// Pack listing row (IPC `tax_packs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Year.
    pub year: i32,
    /// Tier.
    pub tier: Tier,
    /// Version.
    pub version: String,
    /// Verified date (`null` when unverified).
    pub verified_on: Option<NaiveDate>,
    /// Stale for the current year.
    pub stale: bool,
}

impl TaxPack {
    /// Parses and validates a pack.
    pub fn from_json(json: &str) -> Result<Self> {
        let p: TaxPack = serde_json::from_str(json)
            .map_err(|e| FinanceError::parse(format!("invalid tax pack: {e}")))?;
        p.validate()?;
        Ok(p)
    }

    /// Structural validation: brackets ascending with a final unbounded bracket, every status covered.
    pub fn validate(&self) -> Result<()> {
        if self.filing_statuses.is_empty() {
            return Err(FinanceError::invalid(format!(
                "{}: no filing statuses",
                self.id
            )));
        }
        for s in &self.filing_statuses {
            let br = by_status(&self.brackets, s).ok_or_else(|| {
                FinanceError::invalid(format!("{}: no brackets for {s}", self.id))
            })?;
            if br.is_empty() || br.last().is_some_and(|b| b.up_to.is_some()) {
                return Err(FinanceError::invalid(format!(
                    "{}: brackets for {s} must end unbounded",
                    self.id
                )));
            }
            let mut prev = Decimal::ZERO;
            for b in br.iter().filter_map(|b| b.up_to) {
                if b <= prev {
                    return Err(FinanceError::invalid(format!(
                        "{}: brackets for {s} must ascend",
                        self.id
                    )));
                }
                prev = b;
            }
            if br
                .iter()
                .any(|b| b.rate < Decimal::ZERO || b.rate > Decimal::ONE)
            {
                return Err(FinanceError::invalid(format!(
                    "{}: bracket rate out of range",
                    self.id
                )));
            }
            by_status(&self.standard_deduction, s).ok_or_else(|| {
                FinanceError::invalid(format!("{}: no standard deduction for {s}", self.id))
            })?;
        }
        Ok(())
    }

    /// Whether the pack is stale for `selected_year` on `today`: its year differs, or (for non-custom packs)
    /// `verifiedOn` is missing or more than 13 months old.
    pub fn is_stale(&self, selected_year: i32, today: NaiveDate) -> bool {
        if self.tier == Tier::Custom {
            return false;
        }
        if self.year != selected_year {
            return true;
        }
        match self.verified_on {
            None => true,
            Some(v) => v
                .checked_add_months(Months::new(13))
                .is_none_or(|limit| today > limit),
        }
    }

    /// Listing row.
    pub fn info(&self, selected_year: i32, today: NaiveDate) -> PackInfo {
        PackInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            year: self.year,
            tier: self.tier,
            version: self.version.clone(),
            verified_on: self.verified_on,
            stale: self.is_stale(selected_year, today),
        }
    }

    /// The persistent disclaimer.
    pub fn disclaimer(&self) -> String {
        let date = self
            .verified_on
            .map_or_else(|| "unverified".to_string(), |d| d.to_string());
        format!(
            "Estimates for planning only, based on {} v{} verified {}. Not tax advice. Verify with official sources or a qualified professional.",
            self.name, self.version, date
        )
    }
}

/// The built-in packs.
pub fn builtin_packs() -> Result<Vec<TaxPack>> {
    Ok(vec![
        TaxPack::from_json(US_FEDERAL_2026_JSON)?,
        TaxPack::from_json(GENERIC_JSON)?,
    ])
}

/// Finds a built-in pack by id.
pub fn builtin(id: &str) -> Result<TaxPack> {
    builtin_packs()?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| FinanceError::invalid(format!("unknown tax pack {id:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_parse_and_validate() {
        let packs = builtin_packs().unwrap();
        assert_eq!(packs.len(), 2);
        let us = &packs[0];
        assert_eq!(us.id, "us-federal-2026");
        assert_eq!(us.filing_statuses, ["single", "mfj", "mfs", "hoh", "qss"]);
        assert_eq!(us.tier, Tier::Estimator);
        assert!(us.verified_on.is_some());
        assert_eq!(packs[1].tier, Tier::Custom);
    }

    #[test]
    fn unknown_fields_rejected() {
        let mut v: serde_json::Value = serde_json::from_str(GENERIC_JSON).unwrap();
        v["surprise"] = serde_json::json!(1);
        assert!(TaxPack::from_json(&v.to_string()).is_err());
    }

    #[test]
    fn staleness_and_disclaimer() {
        let us = builtin("us-federal-2026").unwrap();
        let v = us.verified_on.unwrap();
        assert!(!us.is_stale(2026, v));
        assert!(us.is_stale(2025, v));
        assert!(us.is_stale(2026, v.checked_add_months(Months::new(14)).unwrap()));
        assert!(
            us.disclaimer()
                .starts_with("Estimates for planning only, based on US Federal v")
        );
        let g = builtin("generic").unwrap();
        assert!(!g.is_stale(2031, v));
        assert!(builtin("nope").is_err());
    }
}
