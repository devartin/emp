//! Tax estimator (§15.6 engine steps). Every figure it produces is an **estimate**: results carry the
//! pack's disclaimer and are never presented as "you owe".
//!
//! Steps: SE tax → AGI → deduction → taxable income → ordinary brackets + stacked preferential rates →
//! NIIT and additional Medicare → credits (with phase-outs) → rounding per pack.
//!
//! Simplifications (documented in the pack notes): `ordinary_dividends` excludes qualified dividends; no AMT,
//! QBI, EITC, education credits or passive-loss limits; rental income is taken as net.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::pack::{Bracket, PackRounding, SeTax, TaxPack, Tier, by_status};
use crate::error::{FinanceError, Result};
use crate::money::{Rounding, round, to_f64};

/// Income kinds (`TaxInput.incomes[].kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncomeKind {
    /// W-2 wages.
    Wages,
    /// Net self-employment profit.
    SelfEmployment,
    /// Taxable interest.
    Interest,
    /// Non-qualified ordinary dividends.
    OrdinaryDividends,
    /// Qualified dividends.
    QualifiedDividends,
    /// Short-term capital gain (may be negative).
    Stcg,
    /// Long-term capital gain (may be negative).
    Ltcg,
    /// Taxable retirement distributions.
    Retirement,
    /// Social Security benefits (gross).
    SocialSecurity,
    /// Unemployment compensation.
    Unemployment,
    /// Net rental income (may be negative).
    Rental,
    /// Other ordinary income.
    Other,
}

/// One income line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IncomeLine {
    /// Kind.
    pub kind: IncomeKind,
    /// Amount.
    pub amount: Decimal,
    /// Source chip (e.g. "Money HQ · Salary").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Adjustment kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdjustmentKind {
    /// Traditional IRA deduction.
    Ira,
    /// HSA deduction.
    Hsa,
    /// Student loan interest.
    StudentLoanInterest,
    /// Self-employed health insurance.
    SeHealth,
    /// Other.
    Other,
}

/// One adjustment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdjustmentLine {
    /// Kind.
    pub kind: AdjustmentKind,
    /// Amount.
    pub amount: Decimal,
}

/// An itemised entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemizedEntry {
    /// Kind (`salt`, `mortgage_interest`, `charity`, `medical`, ...).
    pub kind: String,
    /// Amount.
    pub amount: Decimal,
}

/// `standard` or `auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeductionMode {
    /// Standard deduction.
    Standard,
    /// Larger of standard and itemised.
    Auto,
}

/// Which deduction `{ itemized, mode }` takes (PROGRAMME-v3 K5, additive; absent = `auto`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeductionChoice {
    /// The larger of the itemised total and the standard deduction plus the non-itemiser charitable deduction.
    #[default]
    Auto,
    /// The standard deduction plus the non-itemiser charitable deduction (2026+); the entries still report
    /// `itemizedWouldBe`.
    Standard,
    /// Itemise even when the total is smaller (the election of IRC §63(e)); `standardWouldBe` still reports the
    /// alternative.
    Itemized,
}

/// `deductions` field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Deductions {
    /// `standard` / `auto` without entries (so no non-itemiser charitable deduction and no `itemizedWouldBe`).
    Mode(DeductionMode),
    /// `{ itemized: [...], mode? }`: the entries are the itemisable candidates; `mode` picks the deduction.
    Itemized {
        /// Entries.
        itemized: Vec<ItemizedEntry>,
        /// Which deduction to take (default `auto`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<DeductionChoice>,
    },
}

/// A credit claim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditClaim {
    /// Credit id (pack credit or a custom label).
    pub id: String,
    /// Amount for user-entered credits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<Decimal>,
}

/// `TaxInput` (§15.6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaxInput {
    /// Pack id.
    pub pack_id: String,
    /// Tax year.
    pub year: i32,
    /// Filing status.
    pub filing_status: String,
    /// Qualifying children for per-dependent credits.
    pub dependents: u32,
    /// People aged 65+ or blind (each adds the additional standard deduction).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age65_or_blind: Option<u32>,
    /// Incomes.
    pub incomes: Vec<IncomeLine>,
    /// Adjustments.
    #[serde(default)]
    pub adjustments: Vec<AdjustmentLine>,
    /// Deductions.
    pub deductions: Deductions,
    /// Credits claimed.
    #[serde(default)]
    pub credits: Vec<CreditClaim>,
    /// Tax withheld (YTD + expected).
    pub withheld: Decimal,
    /// Estimated payments made.
    pub estimated_paid: Decimal,
    /// Generic/Custom pack parameters (see [`CustomParams`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<serde_json::Map<String, Value>>,
    /// Some answers were "not sure" → compute `range` (extension; default false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incomplete: Option<bool>,
}

/// Parameters the user enters for the Generic pack (`TaxInput.custom`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomParams {
    /// Brackets (ascending, last unbounded).
    #[serde(default)]
    pub brackets: Option<Vec<Bracket>>,
    /// Standard deduction / personal allowance.
    #[serde(default)]
    pub standard_deduction: Option<Decimal>,
    /// Flat self-employment contribution rate.
    #[serde(default)]
    pub se_rate: Option<Decimal>,
    /// Deadlines `{ name, date }`.
    #[serde(default)]
    pub deadlines: Option<Vec<super::pack::Deadline>>,
}

/// Deduction result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeductionResult {
    /// `standard` or `itemized`.
    pub kind: String,
    /// Amount used.
    pub amount: Decimal,
    /// What the standard deduction would be.
    pub standard_would_be: Decimal,
    /// The itemised total after the pack's floors and caps (medical AGI floor, SALT cap, charitable 0.5% AGI floor);
    /// present whenever itemisable entries were supplied, whichever deduction won (PROGRAMME-v3 K5, additive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub itemized_would_be: Option<Decimal>,
}

/// A bracket line in the estimate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BracketLine {
    /// Rate.
    pub rate: Decimal,
    /// Lower bound.
    pub from: Decimal,
    /// Upper bound (`null` = unbounded).
    pub to: Option<Decimal>,
    /// Income taxed in this bracket.
    pub taxed: Decimal,
    /// Tax from this bracket (extension).
    pub tax: Decimal,
}

/// A "Show math" line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MathLine {
    /// Label.
    pub label: String,
    /// Value (decimal string).
    pub value: String,
    /// Pack reference (`brackets.single`, `seTax.ssWageBase`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_ref: Option<String>,
}

/// `range` for incomplete inputs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceRange {
    /// Balance with incomes −10%.
    pub low: Decimal,
    /// Balance with incomes +10%.
    pub high: Decimal,
}

/// `TaxEstimate` (§15.6) plus a few additive fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxEstimate {
    /// Total income.
    pub gross: Decimal,
    /// AGI.
    pub agi: Decimal,
    /// Deduction.
    pub deduction: DeductionResult,
    /// Taxable income.
    pub taxable: Decimal,
    /// Tax at ordinary rates.
    pub ordinary_tax: Decimal,
    /// Tax at preferential rates.
    pub preferential_tax: Decimal,
    /// Self-employment tax.
    pub se_tax: Decimal,
    /// Net investment income tax.
    pub niit: Decimal,
    /// Credits applied (nonrefundable + refundable).
    pub credits: Decimal,
    /// Total tax after nonrefundable credits plus other taxes.
    pub total_tax: Decimal,
    /// Ordinary bracket breakdown.
    pub brackets: Vec<BracketLine>,
    /// `total_tax / AGI`.
    pub effective_rate: f64,
    /// Marginal ordinary rate.
    pub marginal_rate: f64,
    /// Positive = estimated balance due; negative = estimated refund.
    pub balance: Decimal,
    /// Sensitivity range when inputs are incomplete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<BalanceRange>,
    /// Show-math lines.
    pub lines: Vec<MathLine>,
    /// Pack version.
    pub pack_version: String,
    /// Pack verification date (empty when unverified).
    pub verified_on: String,
    /// Stale pack.
    pub stale: bool,
    /// Disclaimer.
    pub disclaimer: String,
    /// Additional Medicare tax (extension; included in `total_tax`).
    pub addl_medicare: Decimal,
    /// Refundable credits (extension; reduce `balance`, not `total_tax`).
    pub refundable_credits: Decimal,
    /// Withholding used (extension).
    pub withheld: Decimal,
    /// Estimated payments used (extension).
    pub estimated_paid: Decimal,
    /// Filing status (extension; used by the quarterly planner).
    pub filing_status: String,
    /// Pack id (extension).
    pub pack_id: String,
}

fn get(m: &super::pack::StatusMap<Decimal>, status: &str) -> Decimal {
    by_status(m, status).copied().unwrap_or_default()
}

/// Tax on `income` through `brackets`, with the per-bracket breakdown.
pub fn bracket_tax(brackets: &[Bracket], income: Decimal) -> (Decimal, Vec<BracketLine>) {
    let mut lines = Vec::new();
    let mut tax = Decimal::ZERO;
    let mut from = Decimal::ZERO;
    for b in brackets {
        let to = b.up_to;
        let top = to.map_or(income, |t| t.min(income));
        let taxed = (top - from).max(Decimal::ZERO);
        let t = taxed * b.rate;
        tax += t;
        lines.push(BracketLine {
            rate: b.rate,
            from,
            to,
            taxed,
            tax: t,
        });
        match to {
            Some(t) if t < income => from = t,
            _ => break,
        }
    }
    (tax, lines)
}

/// Applies Generic/Custom parameters to a copy of the pack.
pub fn apply_custom(
    pack: &TaxPack,
    custom: Option<&serde_json::Map<String, Value>>,
) -> Result<TaxPack> {
    let mut p = pack.clone();
    if p.tier != Tier::Custom {
        return Ok(p);
    }
    let params: CustomParams = match custom {
        Some(m) => serde_json::from_value(Value::Object(m.clone()))
            .map_err(|e| FinanceError::invalid(format!("custom tax parameters: {e}")))?,
        None => CustomParams::default(),
    };
    if let Some(b) = params.brackets {
        p.brackets = [("*".to_string(), b)].into();
    }
    if let Some(sd) = params.standard_deduction {
        p.standard_deduction = [("*".to_string(), sd)].into();
    }
    if let Some(r) = params.se_rate {
        p.se_tax = Some(SeTax {
            net_earnings_factor: Decimal::ONE,
            ss_rate: r,
            medicare_rate: Decimal::ZERO,
            ss_wage_base: None,
            deductible_share: Decimal::ZERO,
            minimum_net_earnings: None,
            addl_medicare: None,
        });
    }
    if let Some(d) = params.deadlines {
        p.deadlines = d;
    }
    p.validate()?;
    Ok(p)
}

struct Core {
    gross: Decimal,
    agi: Decimal,
    deduction: DeductionResult,
    taxable: Decimal,
    ordinary_tax: Decimal,
    preferential_tax: Decimal,
    se_tax: Decimal,
    addl_medicare: Decimal,
    niit: Decimal,
    nonrefundable: Decimal,
    refundable: Decimal,
    total_tax: Decimal,
    brackets: Vec<BracketLine>,
    marginal: Decimal,
    lines: Vec<MathLine>,
}

fn line(lines: &mut Vec<MathLine>, label: &str, v: Decimal, pack_ref: Option<&str>) {
    lines.push(MathLine {
        label: label.into(),
        value: v.round_dp(2).normalize().to_string(),
        pack_ref: pack_ref.map(str::to_string),
    });
}

fn compute(p: &TaxPack, input: &TaxInput, income_scale: Decimal) -> Result<Core> {
    let status = input.filing_status.as_str();
    let rd = |d: Decimal| match p.rounding {
        PackRounding::WholeDollarHalfUp => round(d, 0, Rounding::HalfUp),
        PackRounding::CentsHalfUp => round(d, 2, Rounding::HalfUp),
    };
    let sum = |k: IncomeKind| -> Decimal {
        input
            .incomes
            .iter()
            .filter(|i| i.kind == k)
            .map(|i| i.amount * income_scale)
            .sum()
    };
    let wages = sum(IncomeKind::Wages);
    let se_profit = sum(IncomeKind::SelfEmployment);
    let interest = sum(IncomeKind::Interest);
    let odiv = sum(IncomeKind::OrdinaryDividends);
    let qdiv = sum(IncomeKind::QualifiedDividends);
    let stcg = sum(IncomeKind::Stcg);
    let ltcg = sum(IncomeKind::Ltcg);
    let retirement = sum(IncomeKind::Retirement);
    let ss = sum(IncomeKind::SocialSecurity);
    let unemployment = sum(IncomeKind::Unemployment);
    let rental = sum(IncomeKind::Rental);
    let other = sum(IncomeKind::Other);
    let mut lines = Vec::new();

    // 1. Self-employment tax.
    let (mut se_tax, mut se_deductible, mut net_se) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    if let Some(se) = &p.se_tax {
        net_se = (se_profit * se.net_earnings_factor).max(Decimal::ZERO);
        if se.minimum_net_earnings.is_some_and(|m| net_se < m) {
            net_se = Decimal::ZERO;
        }
        let ss_base = se
            .ss_wage_base
            .map_or(net_se, |wb| net_se.min((wb - wages).max(Decimal::ZERO)));
        let ss_part = ss_base * se.ss_rate;
        let med_part = net_se * se.medicare_rate;
        se_tax = rd(ss_part + med_part);
        se_deductible = round(
            (ss_part + med_part) * se.deductible_share,
            2,
            Rounding::HalfUp,
        );
        if net_se > Decimal::ZERO {
            line(
                &mut lines,
                "Net SE earnings",
                net_se,
                Some("seTax.netEarningsFactor"),
            );
            line(
                &mut lines,
                "Social Security part of SE tax",
                ss_part,
                Some("seTax.ssWageBase"),
            );
            line(
                &mut lines,
                "Medicare part of SE tax",
                med_part,
                Some("seTax.medicareRate"),
            );
        }
    }
    let addl_medicare = p
        .se_tax
        .as_ref()
        .and_then(|s| s.addl_medicare.as_ref())
        .map_or(Decimal::ZERO, |am| {
            rd(((wages + net_se) - get(&am.threshold, status)).max(Decimal::ZERO) * am.rate)
        });

    // Capital gains netting.
    let net_cap = stcg + ltcg;
    let (cap_in_income, pref_cap) = if net_cap < Decimal::ZERO {
        let limit = p
            .capital_loss_limit
            .as_ref()
            .map_or(Decimal::from(3000), |m| get(m, status));
        (net_cap.max(-limit), Decimal::ZERO)
    } else {
        (net_cap, ltcg.min(net_cap).max(Decimal::ZERO))
    };
    let adjustments: Decimal = input
        .adjustments
        .iter()
        .map(|a| a.amount.max(Decimal::ZERO))
        .sum();
    let non_ss_income = wages
        + se_profit
        + interest
        + odiv
        + qdiv
        + cap_in_income
        + retirement
        + unemployment
        + rental
        + other;

    // Taxable Social Security (provisional income method).
    let taxable_ss = match &p.social_security {
        None => ss,
        Some(rules) if ss > Decimal::ZERO => {
            let half = Decimal::new(5, 1);
            let pct85 = Decimal::new(85, 2);
            let provisional = non_ss_income - adjustments - se_deductible + ss * half;
            let (b1, b2) = (get(&rules.base1, status), get(&rules.base2, status));
            if provisional <= b1 {
                Decimal::ZERO
            } else if provisional <= b2 {
                (ss * half).min((provisional - b1) * half)
            } else {
                (ss * pct85).min(pct85 * (provisional - b2) + (ss * half).min((b2 - b1) * half))
            }
        }
        Some(_) => Decimal::ZERO,
    };
    if ss > Decimal::ZERO {
        line(
            &mut lines,
            "Taxable Social Security",
            taxable_ss,
            Some("socialSecurity"),
        );
    }
    let gross = rd(non_ss_income + taxable_ss);
    // 2. AGI.
    let agi = rd(gross - adjustments - se_deductible);
    line(&mut lines, "Total income", gross, None);
    if adjustments > Decimal::ZERO {
        line(&mut lines, "Adjustments", adjustments, None);
    }
    if se_deductible > Decimal::ZERO {
        line(
            &mut lines,
            "Deductible part of SE tax",
            se_deductible,
            Some("seTax.deductibleShare"),
        );
    }
    line(&mut lines, "Adjusted gross income", agi, None);

    // 3. Deduction.
    let standard = rd(get(&p.standard_deduction, status)
        + get(&p.additional_std_deduction65_or_blind, status)
            * Decimal::from(input.age65_or_blind.unwrap_or(0)));
    // Entries are itemisable candidates. `auto` takes the larger of the itemised total (after floors and caps) and
    // the standard deduction plus the non-itemiser charitable deduction; `standard` takes the latter; `itemized`
    // itemises regardless (§15.6 step 3; same in the mock).
    let (entries, choice): (&[ItemizedEntry], DeductionChoice) = match &input.deductions {
        Deductions::Itemized { itemized, mode } => (itemized, mode.unwrap_or_default()),
        Deductions::Mode(_) => (&[], DeductionChoice::Standard),
    };
    let itemized_would_be = (!entries.is_empty() || choice == DeductionChoice::Itemized)
        .then(|| rd(itemized_amount(p, entries, agi, status)));
    let charity_non_itemizer = p.non_itemizer_charity.as_ref().map_or(Decimal::ZERO, |nc| {
        let gifts: Decimal = entries
            .iter()
            .filter(|e| nc.kinds.iter().any(|k| k == &e.kind))
            .map(|e| e.amount.max(Decimal::ZERO))
            .sum();
        rd(gifts.min(get(&nc.cap, status)))
    });
    let itemize = match (choice, itemized_would_be) {
        (DeductionChoice::Itemized, _) => true,
        (DeductionChoice::Auto, Some(it)) => it > standard + charity_non_itemizer,
        _ => false,
    };
    let deduction = match itemized_would_be {
        Some(it) if itemize => DeductionResult {
            kind: "itemized".into(),
            amount: it,
            standard_would_be: standard,
            itemized_would_be,
        },
        _ => DeductionResult {
            kind: "standard".into(),
            amount: standard + charity_non_itemizer,
            standard_would_be: standard,
            itemized_would_be,
        },
    };
    if let Some(it) = itemized_would_be {
        line(
            &mut lines,
            "Itemized deductions (after floors and caps)",
            it,
            Some("itemizedRules"),
        );
    }
    if deduction.kind == "standard" && charity_non_itemizer > Decimal::ZERO {
        line(
            &mut lines,
            "Standard deduction",
            standard,
            Some("standardDeduction"),
        );
        line(
            &mut lines,
            "Charitable gifts (without itemizing)",
            charity_non_itemizer,
            Some("nonItemizerCharity"),
        );
    }
    line(
        &mut lines,
        &format!("Deduction ({})", deduction.kind),
        deduction.amount,
        Some(if deduction.kind == "itemized" {
            "itemizedRules"
        } else {
            "standardDeduction"
        }),
    );
    // 4. Taxable income.
    let taxable = (agi - deduction.amount).max(Decimal::ZERO);
    line(&mut lines, "Taxable income", taxable, None);

    // 5. Ordinary + preferential stacking.
    let brackets = by_status(&p.brackets, status)
        .ok_or_else(|| FinanceError::invalid(format!("no brackets for {status}")))?;
    let pref_income = if p.preferential_rates.is_some() {
        (qdiv + pref_cap).max(Decimal::ZERO).min(taxable)
    } else {
        Decimal::ZERO
    };
    let ordinary_taxable = taxable - pref_income;
    let (ord_tax_exact, bracket_lines) = bracket_tax(brackets, ordinary_taxable);
    let ordinary_tax = rd(ord_tax_exact);
    let marginal = brackets
        .iter()
        .find(|b| b.up_to.is_none_or(|u| ordinary_taxable <= u))
        .map_or(Decimal::ZERO, |b| b.rate);
    let mut pref_exact = Decimal::ZERO;
    if let Some(pr) = &p.preferential_rates {
        let mut lo = ordinary_taxable;
        let hi = taxable;
        for band in &pr.ltcg_qualified_div {
            if lo >= hi {
                break;
            }
            let cap = by_status(&band.up_to, status).copied().flatten();
            let top = cap.map_or(hi, |c| c.min(hi));
            if top > lo {
                let amt = top - lo;
                pref_exact += amt * band.rate;
                line(
                    &mut lines,
                    &format!(
                        "Gains/qualified dividends at {}%",
                        (band.rate * Decimal::ONE_HUNDRED).normalize()
                    ),
                    amt,
                    Some("preferentialRates.ltcgQualifiedDiv"),
                );
                lo = top;
            }
        }
    }
    let preferential_tax = rd(pref_exact);
    line(
        &mut lines,
        "Tax at ordinary rates",
        ordinary_tax,
        Some("brackets"),
    );
    if preferential_tax > Decimal::ZERO {
        line(
            &mut lines,
            "Tax at preferential rates",
            preferential_tax,
            Some("preferentialRates"),
        );
    }

    // NIIT.
    let niit = p.niit.as_ref().map_or(Decimal::ZERO, |n| {
        let nii = (interest + odiv + qdiv + net_cap.max(Decimal::ZERO) + rental.max(Decimal::ZERO))
            .max(Decimal::ZERO);
        let over = (agi - get(&n.threshold, status)).max(Decimal::ZERO);
        rd(nii.min(over) * n.rate)
    });
    if niit > Decimal::ZERO {
        line(&mut lines, "Net investment income tax", niit, Some("niit"));
    }
    if se_tax > Decimal::ZERO {
        line(&mut lines, "Self-employment tax", se_tax, Some("seTax"));
    }
    if addl_medicare > Decimal::ZERO {
        line(
            &mut lines,
            "Additional Medicare tax",
            addl_medicare,
            Some("seTax.addlMedicare"),
        );
    }

    // 6. Credits.
    let income_tax = ordinary_tax + preferential_tax;
    let mut nonref_wanted = Decimal::ZERO;
    let mut refundable = Decimal::ZERO;
    let earned = wages + se_profit - se_deductible;
    for c in &p.credits {
        if c.kind != super::pack::CreditKind::PerDependent || input.dependents == 0 {
            continue;
        }
        let deps = Decimal::from(input.dependents);
        let mut amt = c.amount.unwrap_or_default() * deps;
        if let Some(ph) = &c.phaseout {
            let over = (agi - get(&ph.start, status)).max(Decimal::ZERO);
            let steps = (over / Decimal::from(1000)).ceil();
            amt = (amt - steps * ph.per1000).max(Decimal::ZERO);
        }
        let label = c.label.clone().unwrap_or_else(|| c.id.clone());
        line(
            &mut lines,
            &format!("{label} (after phase-out)"),
            amt,
            Some("credits"),
        );
        // Nonrefundable first; the refundable part only covers what tax cannot absorb.
        let room = (income_tax - nonref_wanted).max(Decimal::ZERO);
        let used = amt.min(room);
        nonref_wanted += used;
        let leftover = amt - used;
        if leftover > Decimal::ZERO
            && let Some(per) = c.refundable_per_dependent
        {
            let earned_cap = c.refundable_earned_rate.map_or(Decimal::MAX, |r| {
                (earned - c.refundable_earned_threshold.unwrap_or_default()).max(Decimal::ZERO) * r
            });
            refundable += leftover.min(per * deps).min(earned_cap);
        }
    }
    for claim in &input.credits {
        let in_pack = p.credits.iter().find(|c| c.id == claim.id);
        if in_pack.is_some_and(|c| c.kind == super::pack::CreditKind::PerDependent) {
            continue;
        }
        if let Some(a) = claim.amount.filter(|a| *a > Decimal::ZERO) {
            let room = (income_tax - nonref_wanted).max(Decimal::ZERO);
            nonref_wanted += a.min(room);
            line(
                &mut lines,
                &format!("Credit: {}", claim.id),
                a.min(room),
                None,
            );
        }
    }
    let nonrefundable = rd(nonref_wanted);
    let refundable = rd(refundable);
    let total_tax = (income_tax - nonrefundable).max(Decimal::ZERO) + se_tax + addl_medicare + niit;
    line(&mut lines, "Total tax (estimate)", total_tax, None);
    Ok(Core {
        gross,
        agi,
        deduction,
        taxable: rd(taxable),
        ordinary_tax,
        preferential_tax,
        se_tax,
        addl_medicare,
        niit,
        nonrefundable,
        refundable,
        total_tax,
        brackets: bracket_lines,
        marginal,
        lines,
    })
}

fn itemized_amount(p: &TaxPack, entries: &[ItemizedEntry], agi: Decimal, status: &str) -> Decimal {
    let mut total = Decimal::ZERO;
    let mut kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    for k in kinds {
        let mut amt: Decimal = entries
            .iter()
            .filter(|e| e.kind == k)
            .map(|e| e.amount.max(Decimal::ZERO))
            .sum();
        if let Some(rule) = p.itemized_rules.iter().find(|r| r.kind == k) {
            if let Some(pct) = rule.agi_floor_pct {
                amt = (amt - agi * pct).max(Decimal::ZERO);
            }
            if let Some(cap_map) = &rule.cap {
                let mut cap = get(cap_map, status);
                if let Some(ph) = &rule.cap_phasedown {
                    let over = (agi - get(&ph.start, status)).max(Decimal::ZERO);
                    cap = (cap - over * ph.rate).max(get(&ph.floor, status));
                }
                amt = amt.min(cap);
            }
        }
        total += amt;
    }
    total
}

/// Validates input against the pack.
pub fn validate_input(p: &TaxPack, input: &TaxInput) -> Result<()> {
    if !p.filing_statuses.iter().any(|s| s == &input.filing_status) {
        return Err(FinanceError::invalid(format!(
            "filing status {:?} is not in pack {}",
            input.filing_status, p.id
        )));
    }
    if input.dependents > 30 || input.age65_or_blind.unwrap_or(0) > 2 {
        return Err(FinanceError::invalid(
            "dependents ≤ 30 and age65OrBlind ≤ 2",
        ));
    }
    if input.incomes.len() > 500 || input.adjustments.len() > 100 || input.credits.len() > 100 {
        return Err(FinanceError::invalid("too many lines"));
    }
    let bound = crate::money::amount_bound();
    let bad = input
        .incomes
        .iter()
        .map(|i| i.amount)
        .chain(input.adjustments.iter().map(|a| a.amount))
        .chain([input.withheld, input.estimated_paid])
        .any(|a| a.abs() >= bound);
    if bad {
        return Err(FinanceError::invalid("amount out of range"));
    }
    if input.incomes.iter().any(|i| {
        i.amount < Decimal::ZERO
            && !matches!(
                i.kind,
                IncomeKind::Stcg
                    | IncomeKind::Ltcg
                    | IncomeKind::Rental
                    | IncomeKind::SelfEmployment
                    | IncomeKind::Other
            )
    }) {
        return Err(FinanceError::invalid(
            "only gains, rental, self-employment and other income may be negative",
        ));
    }
    Ok(())
}

/// Runs the estimator. `today` drives staleness. `deductions: auto` compares standard with the itemised
/// entries supplied via [`estimate_auto`]; plain `auto` without entries uses the standard deduction.
pub fn estimate(pack: &TaxPack, input: &TaxInput, today: chrono::NaiveDate) -> Result<TaxEstimate> {
    estimate_inner(pack, input, today, None)
}

/// `auto` deduction with itemised candidates: uses the larger of standard and itemised.
pub fn estimate_auto(
    pack: &TaxPack,
    input: &TaxInput,
    itemized: &[ItemizedEntry],
    today: chrono::NaiveDate,
) -> Result<TaxEstimate> {
    estimate_inner(pack, input, today, Some(itemized))
}

fn estimate_inner(
    pack: &TaxPack,
    input: &TaxInput,
    today: chrono::NaiveDate,
    auto_items: Option<&[ItemizedEntry]>,
) -> Result<TaxEstimate> {
    let p = apply_custom(pack, input.custom.as_ref())?;
    validate_input(&p, input)?;
    let mut inp = input.clone();
    if let (Deductions::Mode(DeductionMode::Auto), Some(items)) = (&input.deductions, auto_items) {
        let std_core = compute(&p, input, Decimal::ONE)?;
        let mut it = input.clone();
        it.deductions = Deductions::Itemized {
            itemized: items.to_vec(),
            mode: None,
        };
        let it_core = compute(&p, &it, Decimal::ONE)?;
        if it_core.deduction.amount > std_core.deduction.amount {
            inp = it;
        }
    }
    let c = compute(&p, &inp, Decimal::ONE)?;
    let balance = c.total_tax - c.refundable - input.withheld - input.estimated_paid;
    let range = if input.incomplete == Some(true) {
        let lo = compute(&p, &inp, Decimal::new(9, 1))?;
        let hi = compute(&p, &inp, Decimal::new(11, 1))?;
        let b = |x: &Core| x.total_tax - x.refundable - input.withheld - input.estimated_paid;
        Some(BalanceRange {
            low: b(&lo).min(b(&hi)),
            high: b(&lo).max(b(&hi)),
        })
    } else {
        None
    };
    let mut lines = c.lines;
    if input.withheld > Decimal::ZERO {
        line(&mut lines, "Withholding", input.withheld, None);
    }
    if input.estimated_paid > Decimal::ZERO {
        line(&mut lines, "Estimated payments", input.estimated_paid, None);
    }
    if c.refundable > Decimal::ZERO {
        line(
            &mut lines,
            "Refundable credits",
            c.refundable,
            Some("credits"),
        );
    }
    line(
        &mut lines,
        if balance >= Decimal::ZERO {
            "Estimated balance due"
        } else {
            "Estimated refund"
        },
        balance.abs(),
        None,
    );
    Ok(TaxEstimate {
        gross: c.gross,
        agi: c.agi,
        deduction: c.deduction,
        taxable: c.taxable,
        ordinary_tax: c.ordinary_tax,
        preferential_tax: c.preferential_tax,
        se_tax: c.se_tax,
        niit: c.niit,
        credits: c.nonrefundable + c.refundable,
        total_tax: c.total_tax,
        brackets: c.brackets,
        // Effective rate = total tax ÷ AGI (PROGRAMME-v3 N-MO3 `tax.effective`; the IRS SOI "average tax rate" uses
        // AGI as the denominator: https://www.irs.gov/statistics/soi-tax-stats-individual-income-tax-rates-and-tax-shares).
        // The mock computes the same (`src/backend/mock/commands/tax.ts`).
        effective_rate: if c.agi > Decimal::ZERO {
            to_f64(c.total_tax / c.agi)
        } else {
            0.0
        },
        marginal_rate: to_f64(c.marginal),
        balance,
        range,
        lines,
        pack_version: p.version.clone(),
        verified_on: p.verified_on.map(|d| d.to_string()).unwrap_or_default(),
        stale: p.is_stale(input.year, today),
        disclaimer: p.disclaimer(),
        addl_medicare: c.addl_medicare,
        refundable_credits: c.refundable,
        withheld: input.withheld,
        estimated_paid: input.estimated_paid,
        filing_status: input.filing_status.clone(),
        pack_id: p.id.clone(),
    })
}

/// Result of running a pack's embedded tests.
#[derive(Debug, Clone, PartialEq)]
pub struct PackTestFailure {
    /// Test name or index.
    pub name: String,
    /// What differed.
    pub message: String,
}

/// Runs the pack's `tests` and returns failures (empty = pass). CI calls this for every built-in pack.
pub fn run_pack_tests(pack: &TaxPack, today: chrono::NaiveDate) -> Vec<PackTestFailure> {
    let mut out = Vec::new();
    for (i, t) in pack.tests.iter().enumerate() {
        let name = t.name.clone().unwrap_or_else(|| format!("test {i}"));
        match estimate(pack, &t.input, today) {
            Err(e) => out.push(PackTestFailure {
                name,
                message: e.to_string(),
            }),
            Ok(est) => {
                let checks = [
                    ("tax", t.expect.tax, est.total_tax),
                    ("taxable", t.expect.taxable, est.taxable),
                    ("agi", t.expect.agi, est.agi),
                    ("ordinaryTax", t.expect.ordinary_tax, est.ordinary_tax),
                    ("seTax", t.expect.se_tax, est.se_tax),
                ];
                for (field, want, got) in checks {
                    if let Some(w) = want
                        && w != got
                    {
                        out.push(PackTestFailure {
                            name: name.clone(),
                            message: format!("{field}: expected {w}, got {got}"),
                        });
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tax::pack::builtin;
    use crate::testutil::dec;
    use serde_json::json;

    fn today() -> chrono::NaiveDate {
        "2026-11-26".parse().unwrap()
    }

    fn input(v: Value) -> TaxInput {
        let mut base = json!({"packId":"us-federal-2026","year":2026,"filingStatus":"single","dependents":0,"incomes":[],
            "deductions":"standard","credits":[],"withheld":"0","estimatedPaid":"0"});
        for (k, val) in v.as_object().unwrap() {
            base[k] = val.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn pack_tests_pass() {
        for p in crate::tax::pack::builtin_packs().unwrap() {
            let f = run_pack_tests(&p, today());
            assert!(f.is_empty(), "{}: {f:?}", p.id);
        }
    }

    #[test]
    fn single_wages() {
        let us = builtin("us-federal-2026").unwrap();
        let e = estimate(
            &us,
            &input(json!({"incomes":[{"kind":"wages","amount":"80000"}],"withheld":"9000"})),
            today(),
        )
        .unwrap();
        assert_eq!(e.taxable, dec("63900"));
        assert_eq!(e.ordinary_tax, dec("8770"));
        assert_eq!(e.balance, dec("-230"));
        assert!((e.marginal_rate - 0.22).abs() < 1e-12);
        assert_eq!(e.brackets.len(), 3);
        assert_eq!(e.brackets[2].taxed, dec("13500"));
        assert!(!e.stale);
        assert!(e.disclaimer.contains("Not tax advice"));
        assert!(e.lines.iter().any(|l| l.label == "Estimated refund"));
        let j = serde_json::to_value(&e).unwrap();
        assert_eq!(j["deduction"]["standardWouldBe"], "16100");
        assert!(j["effectiveRate"].is_number());
    }

    #[test]
    fn preferential_stacking_and_niit() {
        let us = builtin("us-federal-2026").unwrap();
        // Ordinary taxable 33,900; gains 100,000 span the 0% (to 49,450) and 15% bands.
        let e = estimate(&us, &input(json!({"incomes":[{"kind":"wages","amount":"50000"},{"kind":"ltcg","amount":"100000"}]})), today()).unwrap();
        assert_eq!(e.taxable, dec("133900"));
        assert_eq!(e.preferential_tax, dec("12668")); // (133,900 − 49,450) × 15% = 12,667.50 → 12,668
        assert_eq!(e.niit, Decimal::ZERO);
        let rich = estimate(&us, &input(json!({"incomes":[{"kind":"wages","amount":"250000"},{"kind":"qualified_dividends","amount":"30000"}]})), today()).unwrap();
        assert_eq!(rich.niit, dec("1140")); // min(30,000, 280,000 − 200,000) × 3.8%
        assert_eq!(rich.addl_medicare, dec("450"));
    }

    #[test]
    fn capital_losses_and_social_security() {
        let us = builtin("us-federal-2026").unwrap();
        let e = estimate(&us, &input(json!({"incomes":[{"kind":"wages","amount":"60000"},{"kind":"stcg","amount":"-10000"}]})), today()).unwrap();
        assert_eq!(e.agi, dec("57000"));
        let e = estimate(&us, &input(json!({"filingStatus":"mfj","incomes":[{"kind":"social_security","amount":"30000"},{"kind":"retirement","amount":"30000"}]})), today()).unwrap();
        // Provisional 45,000 > 44,000: 0.85 × 1,000 + min(15,000, 6,000) = 6,850.
        assert_eq!(e.gross, dec("36850"));
    }

    #[test]
    fn se_tax_wage_base_and_credits() {
        let us = builtin("us-federal-2026").unwrap();
        let e = estimate(&us, &input(json!({"incomes":[{"kind":"wages","amount":"180000"},{"kind":"self_employment","amount":"20000"}]})), today()).unwrap();
        // SS part limited to 184,500 − 180,000 = 4,500 → 558; Medicare 18,470 × 2.9% = 535.63 → 1,093.63.
        assert_eq!(e.se_tax, dec("1094"));
        let kids = estimate(&us, &input(json!({"filingStatus":"hoh","dependents":2,"incomes":[{"kind":"wages","amount":"30000"}]})), today()).unwrap();
        // Tax on 5,850 is 585; CTC 4,400 → 585 nonrefundable, refundable min(3,815, 3,400, 15% × 27,500 = 4,125) = 3,400.
        assert_eq!(kids.total_tax, Decimal::ZERO);
        assert_eq!(kids.refundable_credits, dec("3400"));
        assert_eq!(kids.balance, dec("-3400"));
        let phased = estimate(
            &us,
            &input(json!({"dependents":1,"incomes":[{"kind":"wages","amount":"210500"}]})),
            today(),
        )
        .unwrap();
        assert!(
            phased
                .lines
                .iter()
                .any(|l| l.label.starts_with("Child tax credit") && l.value == "1650")
        );
    }

    #[test]
    fn itemized_and_auto() {
        let us = builtin("us-federal-2026").unwrap();
        let items = vec![
            ItemizedEntry {
                kind: "salt".into(),
                amount: dec("60000"),
            },
            ItemizedEntry {
                kind: "mortgage_interest".into(),
                amount: dec("12000"),
            },
            ItemizedEntry {
                kind: "medical".into(),
                amount: dec("10000"),
            },
        ];
        let base = input(
            json!({"filingStatus":"mfj","deductions":"auto","incomes":[{"kind":"wages","amount":"100000"}]}),
        );
        let e = estimate_auto(&us, &base, &items, today()).unwrap();
        // SALT capped at 40,400; medical counts above 7.5% × 100,000 = 7,500 → 40,400 + 12,000 + 2,500.
        assert_eq!(e.deduction.kind, "itemized");
        assert_eq!(e.deduction.amount, dec("54900"));
        let small = vec![ItemizedEntry {
            kind: "charity".into(),
            amount: dec("1000"),
        }];
        let e = estimate_auto(&us, &base, &small, today()).unwrap();
        assert_eq!(e.deduction.kind, "standard");
        // Standard 32,200 plus the 2026 non-itemiser cash gift deduction (1,000, under the 2,000 MFJ cap).
        assert_eq!(e.deduction.amount, dec("33200"));
        assert_eq!(e.deduction.standard_would_be, dec("32200"));
        // Itemised, the gift only counts above 0.5% × 100,000 = 500.
        assert_eq!(e.deduction.itemized_would_be, Some(dec("500")));
        let rich = input(
            json!({"deductions":{"itemized":[{"kind":"salt","amount":"50000"}]},"incomes":[{"kind":"wages","amount":"700000"}]}),
        );
        // The SALT cap phases down to its 10,000 floor, so the standard deduction wins; itemizedWouldBe still says why.
        let e = estimate(&us, &rich, today()).unwrap();
        assert_eq!(e.deduction.itemized_would_be, Some(dec("10000")));
        assert_eq!(e.deduction.kind, "standard");
        assert_eq!(e.deduction.amount, dec("16100"));
        // `standard` mode carries no entries, so no itemizedWouldBe.
        let plain = estimate(
            &us,
            &input(json!({"incomes":[{"kind":"wages","amount":"50000"}]})),
            today(),
        )
        .unwrap();
        assert_eq!(plain.deduction.itemized_would_be, None);
    }

    /// N-MO5: the 2026 charitable rules (IRS Pub 505 (2026) "What's New", https://www.irs.gov/publications/p505;
    /// https://www.irs.gov/newsroom/irs-reminder-permanent-charitable-contribution-deduction-begins-for-returns-filed-next-year-for-taxpayers-who-do-not-itemize).
    #[test]
    fn charity_2026_cap_and_floor() {
        let us = builtin("us-federal-2026").unwrap();
        let gifts = |status: &str, wages: &str, gift: &str| {
            estimate(
                &us,
                &input(
                    json!({"filingStatus": status, "incomes":[{"kind":"wages","amount": wages}],
                    "deductions":{"itemized":[{"kind":"charity","amount": gift}]}}),
                ),
                today(),
            )
            .unwrap()
        };
        // Non-itemiser cap: $1,000 single, $2,000 married filing jointly.
        let single = gifts("single", "80000", "1500");
        assert_eq!(single.deduction.kind, "standard");
        assert_eq!(single.deduction.amount, dec("17100"));
        let small = gifts("single", "80000", "400");
        assert_eq!(small.deduction.amount, dec("16500"));
        let mfj = gifts("mfj", "120000", "3000");
        assert_eq!(mfj.deduction.amount, dec("34200"));
        // Head of household and MFS get the single cap.
        assert_eq!(gifts("hoh", "80000", "5000").deduction.amount, dec("25150"));
        // Itemisers: only the part above 0.5% of AGI counts (200,000 × 0.5% = 1,000).
        let e = estimate(
            &us,
            &input(json!({"incomes":[{"kind":"wages","amount":"200000"}],
                "deductions":{"itemized":[{"kind":"salt","amount":"15000"},{"kind":"mortgage","amount":"12000"},{"kind":"charity","amount":"5000"}]}})),
            today(),
        )
        .unwrap();
        assert_eq!(e.deduction.kind, "itemized");
        assert_eq!(e.deduction.amount, dec("31000"));
        assert_eq!(e.deduction.itemized_would_be, Some(dec("31000")));
        assert_eq!(e.taxable, dec("169000"));
        // Effective rate is total tax over AGI.
        assert!((e.effective_rate - 33158.0 / 200_000.0).abs() < 1e-12);
    }

    /// `{ itemized, mode }`: `standard` keeps the 2026 non-itemiser cash-gift deduction, `itemized` itemises even
    /// when smaller (IRC §63(e) election, https://www.law.cornell.edu/uscode/text/26/63), `auto`/absent takes the
    /// larger. Every mode reports both alternatives.
    #[test]
    fn deduction_modes() {
        let us = builtin("us-federal-2026").unwrap();
        let run = |mode: Option<&str>| {
            let mut d = json!({"itemized":[{"kind":"charity","amount":"1500"},{"kind":"salt","amount":"5200"},
                {"kind":"mortgage","amount":"4800"}]});
            if let Some(m) = mode {
                d["mode"] = json!(m);
            }
            estimate(
                &us,
                &input(json!({"incomes":[{"kind":"wages","amount":"72000"}],"deductions": d})),
                today(),
            )
            .unwrap()
        };
        // Itemised: 5,200 + 4,800 + (1,500 − 0.5% × 72,000 = 360) = 11,140.
        let auto = run(None);
        assert_eq!(auto.deduction.kind, "standard");
        assert_eq!(auto.deduction.amount, dec("17100"));
        assert_eq!(auto.deduction.itemized_would_be, Some(dec("11140")));
        assert_eq!(run(Some("auto")).deduction, auto.deduction);
        let std = run(Some("standard"));
        assert_eq!(std.deduction, auto.deduction);
        let it = run(Some("itemized"));
        assert_eq!(it.deduction.kind, "itemized");
        assert_eq!(it.deduction.amount, dec("11140"));
        assert_eq!(it.deduction.standard_would_be, dec("16100"));
        assert_eq!(it.taxable, dec("60860"));
        // A large itemised total under `standard` stays standard.
        let big = estimate(
            &us,
            &input(json!({"incomes":[{"kind":"wages","amount":"72000"}],
                "deductions": {"itemized":[{"kind":"mortgage","amount":"30000"}], "mode": "standard"}})),
            today(),
        )
        .unwrap();
        assert_eq!(big.deduction.kind, "standard");
        assert_eq!(big.deduction.amount, dec("16100"));
        assert_eq!(big.deduction.itemized_would_be, Some(dec("30000")));
        // Forced itemising without entries itemises zero.
        let none = estimate(
            &us,
            &input(json!({"incomes":[{"kind":"wages","amount":"72000"}],
                "deductions": {"itemized":[], "mode": "itemized"}})),
            today(),
        )
        .unwrap();
        assert_eq!(none.deduction.kind, "itemized");
        assert_eq!(none.deduction.amount, dec("0"));
        assert_eq!(none.deduction.itemized_would_be, Some(dec("0")));
        assert!(serde_json::from_value::<TaxInput>(json!({"packId":"us-federal-2026","year":2026,
            "filingStatus":"single","dependents":0,"incomes":[],"deductions":{"itemized":[],"mode":"bogus"},
            "withheld":"0","estimatedPaid":"0"})).is_err());
    }

    #[test]
    fn range_validation_and_generic() {
        let us = builtin("us-federal-2026").unwrap();
        let e = estimate(
            &us,
            &input(json!({"incomes":[{"kind":"wages","amount":"80000"}],"incomplete":true})),
            today(),
        )
        .unwrap();
        let r = e.range.unwrap();
        assert!(r.low < e.balance && e.balance < r.high);
        assert!(estimate(&us, &input(json!({"filingStatus":"joint"})), today()).is_err());
        assert!(
            estimate(
                &us,
                &input(json!({"incomes":[{"kind":"wages","amount":"-5"}]})),
                today()
            )
            .is_err()
        );
        assert!(
            estimate(&us, &input(json!({"year":2025})), today())
                .unwrap()
                .stale
        );

        let g = builtin("generic").unwrap();
        let gi = input(
            json!({"packId":"generic","incomes":[{"kind":"wages","amount":"50000"},{"kind":"self_employment","amount":"10000"}],
            "custom":{"brackets":[{"upTo":"20000","rate":"0.1"},{"upTo":null,"rate":"0.3"}],"standardDeduction":"10000","seRate":"0.08"}}),
        );
        let e = estimate(&g, &gi, today()).unwrap();
        // Taxable 50,000: 2,000 + 9,000 = 11,000; SE 800.
        assert_eq!(e.ordinary_tax, dec("11000"));
        assert_eq!(e.se_tax, dec("800"));
        assert!(!e.stale);
        assert!(e.disclaimer.contains("unverified"));
    }
}
