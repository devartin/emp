//! Advisor helpers for the finance life apps (§16.2–16.4 advisor rule tables).
//!
//! Each evaluator is pure: the app gathers a context from the engine outputs, calls the evaluator, and turns
//! each [`Finding`] into an IPC `Insight` (adding ids, routes and mute state). Every finding carries its
//! "Show math" lines. Amounts are estimates; wording avoids "you owe".

use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::money::to_f64;

/// Severity (ranked critical > warn > tip > info).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Informational.
    Info,
    /// Suggestion.
    Tip,
    /// Warning.
    Warn,
    /// Critical.
    Critical,
}

/// A "Show math" line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Math {
    /// Label.
    pub label: String,
    /// Value.
    pub value: String,
    /// Source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// A triggered advisor rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Rule id (`cat-90pct`, ...).
    pub rule_id: String,
    /// Subject key so several findings of one rule can coexist (category id, symbol, ...).
    pub subject: String,
    /// Severity.
    pub severity: Severity,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// Show-math lines.
    pub math: Vec<Math>,
}

fn m(label: &str, value: impl ToString) -> Math {
    Math {
        label: label.into(),
        value: value.to_string(),
        source: None,
    }
}

fn f(
    rule: &str,
    subject: &str,
    severity: Severity,
    title: String,
    body: String,
    math: Vec<Math>,
) -> Finding {
    Finding {
        rule_id: rule.into(),
        subject: subject.into(),
        severity,
        title,
        body,
        math,
    }
}

fn money(d: Decimal) -> String {
    d.round_dp(2).to_string()
}

fn pct(x: f64) -> String {
    format!("{:.1}%", x * 100.0)
}

/// Sorts findings: severity descending, then rule id and subject (stable "recency" is the caller's order).
pub fn rank(findings: &mut [Finding]) {
    findings.sort_by_key(|f| std::cmp::Reverse(f.severity));
}

// ---------------------------------------------------------------- Money HQ

/// A budget category line for the advisor.
#[derive(Debug, Clone, PartialEq)]
pub struct CategoryStatus {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Assigned.
    pub assigned: Decimal,
    /// Net spent (positive).
    pub spent: Decimal,
    /// Available.
    pub available: Decimal,
}

/// A subscription for the advisor: name, next charge and an optional price change `(from, to)`.
pub type SubscriptionStatus = (String, NaiveDate, Option<(Decimal, Decimal)>);

/// Inputs for the Money HQ rules.
#[derive(Debug, Clone, Default)]
pub struct MoneyHqContext {
    /// Today.
    pub today: Option<NaiveDate>,
    /// Days left in the budget month (including today).
    pub days_left: i64,
    /// Categories this month.
    pub categories: Vec<CategoryStatus>,
    /// Earliest forecast breach: (date, account name, projected balance, top outflows).
    pub forecast_breach: Option<(NaiveDate, String, Decimal, Vec<String>)>,
    /// Emergency fund balance.
    pub ef_balance: Decimal,
    /// Starter fund target (default one month of essentials).
    pub ef_starter: Decimal,
    /// Full target.
    pub ef_target: Decimal,
    /// Subscriptions.
    pub subscriptions: Vec<SubscriptionStatus>,
    /// Uncategorised transactions.
    pub uncategorized: usize,
    /// Accounts and their last reconcile date.
    pub reconciled: Vec<(String, Option<NaiveDate>)>,
    /// Card utilisation by card name.
    pub utilization: Vec<(String, f64)>,
    /// Highest debt APR (percent).
    pub max_debt_apr: Option<Decimal>,
    /// Non-emergency savings balances at the last 4 month-ends (oldest first).
    pub non_emergency_savings: Vec<Decimal>,
    /// Savings rate for the last 4 months (oldest first).
    pub savings_rates: Vec<Option<f64>>,
    /// Possible duplicates in review.
    pub possible_duplicates: usize,
}

/// Evaluates every Money HQ rule.
pub fn money_hq(c: &MoneyHqContext) -> Vec<Finding> {
    let mut out = Vec::new();
    for cat in &c.categories {
        if cat.available < Decimal::ZERO {
            out.push(f(
                "cat-over",
                &cat.id,
                Severity::Warn,
                format!("{} is overspent", cat.name),
                format!(
                    "{} is {} over. Move money from another category to cover it.",
                    cat.name,
                    money(-cat.available)
                ),
                vec![
                    m("Assigned", money(cat.assigned)),
                    m("Spent", money(cat.spent)),
                    m("Available", money(cat.available)),
                ],
            ));
        } else if cat.assigned > Decimal::ZERO
            && cat.spent >= cat.assigned * Decimal::new(9, 1)
            && c.days_left >= 10
        {
            let used = to_f64(cat.spent / cat.assigned);
            out.push(f(
                "cat-90pct",
                &cat.id,
                Severity::Tip,
                format!("{} is {} spent", cat.name, pct(used)),
                format!(
                    "{} days are left this month and {} remains in {}.",
                    c.days_left,
                    money(cat.available),
                    cat.name
                ),
                vec![
                    m("Assigned", money(cat.assigned)),
                    m("Spent", money(cat.spent)),
                    m("Days left", c.days_left),
                ],
            ));
        }
    }
    if let (Some((date, acct, bal, outs)), Some(today)) = (&c.forecast_breach, c.today)
        && (*date - today).num_days() <= 30
    {
        out.push(f(
            "forecast-breach",
            acct,
            Severity::Warn,
            format!("{acct} may dip below its threshold"),
            format!(
                "The forecast shows about {} on {date}. Largest outflows: {}.",
                money(*bal),
                outs.join(", ")
            ),
            vec![m("Projected balance", money(*bal)), m("Date", date)],
        ));
    }
    if c.ef_starter > Decimal::ZERO && c.ef_balance < c.ef_starter {
        out.push(f(
            "ef-below-starter",
            "ef",
            Severity::Warn,
            "Emergency fund is below the starter amount".into(),
            format!(
                "{} saved of a {} starter fund.",
                money(c.ef_balance),
                money(c.ef_starter)
            ),
            vec![
                m("Saved", money(c.ef_balance)),
                m("Starter", money(c.ef_starter)),
            ],
        ));
    } else if c.ef_target > Decimal::ZERO && c.ef_balance < c.ef_target {
        out.push(f(
            "ef-below-target",
            "ef",
            Severity::Tip,
            "Keep building your emergency fund".into(),
            format!("{} saved of {}.", money(c.ef_balance), money(c.ef_target)),
            vec![
                m("Saved", money(c.ef_balance)),
                m("Target", money(c.ef_target)),
            ],
        ));
    }
    for (name, next, change) in &c.subscriptions {
        if let Some((from, to)) = change
            && to.abs() > from.abs()
        {
            out.push(f(
                "sub-price-up",
                name,
                Severity::Info,
                format!("{name} went up"),
                format!(
                    "The latest charge was {} (was {}).",
                    money(to.abs()),
                    money(from.abs())
                ),
                vec![m("Before", money(from.abs())), m("Now", money(to.abs()))],
            ));
        }
        if let Some(today) = c.today {
            let d = (*next - today).num_days();
            if (0..=14).contains(&d) {
                out.push(f(
                    "sub-renewal-14d",
                    name,
                    Severity::Tip,
                    format!("{name} renews in {d} days"),
                    format!("Next charge on {next}. Still using it?"),
                    vec![m("Next charge", next)],
                ));
            }
        }
    }
    if c.uncategorized >= 10 {
        out.push(f(
            "uncategorized",
            "txns",
            Severity::Info,
            format!("{} transactions need a category", c.uncategorized),
            "Categorise them so budgets and reports stay accurate.".into(),
            vec![m("Uncategorised", c.uncategorized)],
        ));
    }
    if let Some(today) = c.today {
        for (acct, last) in &c.reconciled {
            if last.is_none_or(|d| (today - d).num_days() > 30) {
                out.push(f(
                    "reconcile-30d",
                    acct,
                    Severity::Tip,
                    format!("Reconcile {acct}"),
                    "It has not been reconciled in the last 30 days.".into(),
                    vec![m(
                        "Last reconciled",
                        last.map_or_else(|| "never".to_string(), |d| d.to_string()),
                    )],
                ));
            }
        }
    }
    for (card, u) in &c.utilization {
        if *u > 0.30 {
            out.push(f(
                "util-30",
                card,
                Severity::Tip,
                format!("{card} utilisation is {}", pct(*u)),
                "Keeping card balances under 30% of the limit can help your credit score.".into(),
                vec![m("Utilisation", pct(*u))],
            ));
        }
    }
    let grew_3 = c.non_emergency_savings.len() >= 4
        && c.non_emergency_savings
            .windows(2)
            .rev()
            .take(3)
            .all(|w| w[1] > w[0]);
    if c.max_debt_apr.is_some_and(|a| a >= Decimal::from(10)) && grew_3 {
        out.push(f(
            "debt-vs-savings",
            "debt",
            Severity::Info,
            "Savings are growing while high-interest debt remains".into(),
            "Paying the debt down may save more than the savings earn.".into(),
            vec![m(
                "Highest APR",
                format!("{}%", c.max_debt_apr.unwrap_or_default().normalize()),
            )],
        ));
    }
    let rates: Vec<f64> = c.savings_rates.iter().flatten().copied().collect();
    if rates.len() >= 4 && rates.windows(2).rev().take(3).all(|w| w[1] < w[0]) {
        out.push(f(
            "savings-rate-down-3m",
            "savings",
            Severity::Info,
            "Savings rate is down 3 months in a row".into(),
            format!("Latest {}.", pct(*rates.last().unwrap_or(&0.0))),
            rates.iter().map(|r| m("Month", pct(*r))).collect(),
        ));
    }
    if c.possible_duplicates > 0 {
        out.push(f(
            "possible-dupes",
            "dupes",
            Severity::Tip,
            format!("{} possible duplicate(s) to review", c.possible_duplicates),
            "Keep or skip them in the import review.".into(),
            vec![m("Possible duplicates", c.possible_duplicates)],
        ));
    }
    out
}

// ---------------------------------------------------------------- Portfolio

/// Inputs for the Portfolio rules.
#[derive(Debug, Clone, Default)]
pub struct PortfolioContext {
    /// Today.
    pub today: Option<NaiveDate>,
    /// Allocation rows: (class, drift pp, outside band).
    pub allocation: Vec<(String, f64, bool)>,
    /// Holdings: (symbol, weight 0–1, expense ratio fraction, stale price).
    pub holdings: Vec<(String, f64, Option<Decimal>, bool)>,
    /// Consecutive days cash has been above 5% of the portfolio.
    pub cash_above_5pct_days: u32,
    /// Last IPS review date.
    pub ips_reviewed: Option<NaiveDate>,
    /// Unrealised losses in taxable accounts (positive number).
    pub taxable_unrealized_losses: Decimal,
}

/// Evaluates every Portfolio rule.
pub fn portfolio(c: &PortfolioContext) -> Vec<Finding> {
    let mut out = Vec::new();
    for (class, drift, outside) in &c.allocation {
        if *outside {
            out.push(f(
                "drift-band",
                class,
                Severity::Warn,
                format!("{class} is outside its band"),
                format!("Drift is {drift:+.1} pp. Consider the rebalance planner (Ultra Note never places trades)."),
                vec![m("Drift (pp)", format!("{drift:+.1}"))],
            ));
        }
    }
    let mut stale = 0;
    for (sym, w, er, is_stale) in &c.holdings {
        if *w > 0.10 && !sym.to_ascii_uppercase().contains("CASH") {
            out.push(f(
                "concentration-10",
                sym,
                Severity::Tip,
                format!("{sym} is {} of the portfolio", pct(*w)),
                "A single position above 10% concentrates risk.".into(),
                vec![m("Weight", pct(*w))],
            ));
        }
        if let Some(er) = er.filter(|e| *e > Decimal::new(5, 3)) {
            out.push(f(
                "high-er",
                sym,
                Severity::Info,
                format!("{sym} has a {} expense ratio", pct(to_f64(er))),
                "Lower-cost funds with similar exposure may exist.".into(),
                vec![m("Expense ratio", pct(to_f64(er)))],
            ));
        }
        if *is_stale {
            stale += 1;
        }
    }
    if c.cash_above_5pct_days >= 60 {
        out.push(f(
            "cash-drag",
            "cash",
            Severity::Info,
            "Cash has been above 5% for 60 days".into(),
            "Uninvested cash can drag on long-term returns.".into(),
            vec![m("Days", c.cash_above_5pct_days)],
        ));
    }
    if stale > 0 {
        out.push(f(
            "stale-prices",
            "prices",
            Severity::Info,
            format!("{stale} price(s) are more than 3 days old"),
            "Values may be out of date.".into(),
            vec![m("Stale", stale)],
        ));
    }
    if let Some(today) = c.today {
        if c.ips_reviewed.is_none_or(|d| (today - d).num_days() >= 365) {
            out.push(f(
                "ips-review",
                "ips",
                Severity::Tip,
                "Time to review your Investment Policy Statement".into(),
                "An annual check keeps it aligned with your goals.".into(),
                vec![],
            ));
        }
        if today.month() == 12 && c.taxable_unrealized_losses > Decimal::ZERO {
            out.push(f(
                "harvest-review",
                "harvest",
                Severity::Info,
                "Review unrealised losses before year end".into(),
                format!("Taxable accounts hold about {} in unrealised losses. Wash-sale rules apply; this is not tax advice.", money(c.taxable_unrealized_losses)),
                vec![m("Unrealised losses", money(c.taxable_unrealized_losses))],
            ));
        }
    }
    out
}

// ---------------------------------------------------------------- Tax Organizer

/// Inputs for the Tax Organizer rules.
#[derive(Debug, Clone, Default)]
pub struct TaxContext {
    /// Today.
    pub today: Option<NaiveDate>,
    /// Upcoming deadlines (name, date).
    pub deadlines: Vec<(String, NaiveDate)>,
    /// Late documents (name).
    pub late_documents: Vec<String>,
    /// Next suggested quarterly payment implied by YTD self-employment income.
    pub se_quarterly_suggested: Option<Decimal>,
    /// Estimated payments recorded this year.
    pub estimated_payments_recorded: usize,
    /// US pack threshold for `se-no-estimates` (1,000).
    pub se_threshold: Decimal,
    /// Itemised total and standard deduction.
    pub itemized_vs_standard: Option<(Decimal, Decimal)>,
    /// Pack is stale.
    pub pack_stale: bool,
    /// Deductions over $250 without a receipt (description).
    pub missing_receipts: Vec<String>,
    /// Money HQ "Taxes" sinking fund balance and the estimated balance due.
    pub setaside: Option<(Decimal, Decimal)>,
}

/// Evaluates every Tax Organizer rule.
pub fn tax(c: &TaxContext) -> Vec<Finding> {
    let mut out = Vec::new();
    if let Some(today) = c.today {
        for (name, date) in &c.deadlines {
            let d = (*date - today).num_days();
            if (0..=3).contains(&d) {
                out.push(f(
                    "deadline-3",
                    name,
                    Severity::Warn,
                    format!("{name} in {d} day(s)"),
                    format!("Due {date}."),
                    vec![m("Due", date)],
                ));
            } else if (4..=14).contains(&d) {
                out.push(f(
                    "deadline-14",
                    name,
                    Severity::Tip,
                    format!("{name} in {d} days"),
                    format!("Due {date}."),
                    vec![m("Due", date)],
                ));
            }
        }
    }
    for doc in &c.late_documents {
        out.push(f(
            "doc-late",
            doc,
            Severity::Tip,
            format!("{doc} hasn't arrived"),
            "It is more than 14 days past when it is usually available. Check the issuer's portal."
                .into(),
            vec![],
        ));
    }
    if let Some(s) = c.se_quarterly_suggested
        && s > c.se_threshold
        && c.estimated_payments_recorded == 0
    {
        out.push(f(
            "se-no-estimates",
            "se",
            Severity::Warn,
            "Self-employment income suggests quarterly estimated payments".into(),
            format!(
                "The estimated next payment is about {} and none are recorded.",
                money(s)
            ),
            vec![m("Suggested payment (estimate)", money(s))],
        ));
    }
    if let Some((it, st)) = c.itemized_vs_standard
        && st > Decimal::ZERO
        && it >= st * Decimal::new(9, 1)
    {
        out.push(f(
            "itemize-close",
            "itemize",
            Severity::Info,
            "Itemised deductions are close to the standard deduction".into(),
            format!(
                "Itemised {} vs standard {}. Bunching deductions could help.",
                money(it),
                money(st)
            ),
            vec![m("Itemised", money(it)), m("Standard", money(st))],
        ));
    }
    if c.pack_stale {
        out.push(f(
            "pack-stale",
            "pack",
            Severity::Warn,
            "Tax figures may be out of date".into(),
            "The tax pack is for a different year or was verified more than 13 months ago.".into(),
            vec![],
        ));
    }
    for d in &c.missing_receipts {
        out.push(f(
            "receipt-missing",
            d,
            Severity::Tip,
            format!("Attach a receipt for {d}"),
            "Deductions over $250 generally need written records.".into(),
            vec![],
        ));
    }
    if let Some((fund, due)) = c.setaside
        && due > Decimal::ZERO
        && fund < due
    {
        out.push(f(
            "setaside-short",
            "setaside",
            Severity::Info,
            "Tax set-aside is below the estimated balance due".into(),
            format!(
                "{} set aside vs about {} estimated.",
                money(fund),
                money(due)
            ),
            vec![
                m("Set aside", money(fund)),
                m("Estimated balance due", money(due)),
            ],
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::dec;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn ids(v: &[Finding]) -> Vec<&str> {
        v.iter().map(|f| f.rule_id.as_str()).collect()
    }

    #[test]
    fn money_hq_triggers_and_not() {
        let quiet = MoneyHqContext {
            today: Some(d("2026-03-10")),
            days_left: 22,
            ef_balance: dec("10000"),
            ef_starter: dec("2000"),
            ef_target: dec("9000"),
            ..Default::default()
        };
        assert!(money_hq(&quiet).is_empty());
        let loud = MoneyHqContext {
            today: Some(d("2026-03-10")),
            days_left: 22,
            categories: vec![
                CategoryStatus {
                    id: "a".into(),
                    name: "Dining".into(),
                    assigned: dec("100"),
                    spent: dec("95"),
                    available: dec("5"),
                },
                CategoryStatus {
                    id: "b".into(),
                    name: "Fuel".into(),
                    assigned: dec("100"),
                    spent: dec("130"),
                    available: dec("-30"),
                },
            ],
            forecast_breach: Some((
                d("2026-03-25"),
                "Checking".into(),
                dec("120"),
                vec!["Rent".into()],
            )),
            ef_balance: dec("500"),
            ef_starter: dec("2000"),
            ef_target: dec("9000"),
            subscriptions: vec![(
                "Netflix".into(),
                d("2026-03-15"),
                Some((dec("-15.49"), dec("-17.99"))),
            )],
            uncategorized: 12,
            reconciled: vec![("Checking".into(), Some(d("2026-01-01")))],
            utilization: vec![("Visa".into(), 0.45)],
            max_debt_apr: Some(dec("24.99")),
            non_emergency_savings: vec![dec("1"), dec("2"), dec("3"), dec("4")],
            savings_rates: vec![Some(0.3), Some(0.2), Some(0.1), Some(0.05)],
            possible_duplicates: 2,
        };
        let mut v = money_hq(&loud);
        rank(&mut v);
        let got = ids(&v);
        for r in [
            "cat-90pct",
            "cat-over",
            "forecast-breach",
            "ef-below-starter",
            "sub-price-up",
            "sub-renewal-14d",
            "uncategorized",
            "reconcile-30d",
            "util-30",
            "debt-vs-savings",
            "savings-rate-down-3m",
            "possible-dupes",
        ] {
            assert!(got.contains(&r), "missing {r}");
        }
        assert_eq!(v[0].severity, Severity::Warn);
        assert!(v.iter().all(|f| !f.body.to_lowercase().contains("you owe")));
        let target_only = MoneyHqContext {
            ef_balance: dec("5000"),
            ef_starter: dec("2000"),
            ef_target: dec("9000"),
            ..Default::default()
        };
        assert_eq!(ids(&money_hq(&target_only)), ["ef-below-target"]);
    }

    #[test]
    fn portfolio_rules() {
        let c = PortfolioContext {
            today: Some(d("2026-12-05")),
            allocation: vec![
                ("US equity".into(), 6.2, true),
                ("Bonds".into(), -1.0, false),
            ],
            holdings: vec![
                ("AAPL".into(), 0.15, None, false),
                ("ARKK".into(), 0.05, Some(dec("0.0075")), true),
            ],
            cash_above_5pct_days: 61,
            ips_reviewed: Some(d("2025-01-01")),
            taxable_unrealized_losses: dec("1200"),
        };
        let got = portfolio(&c);
        let got = ids(&got);
        for r in [
            "drift-band",
            "concentration-10",
            "high-er",
            "cash-drag",
            "stale-prices",
            "ips-review",
            "harvest-review",
        ] {
            assert!(got.contains(&r), "missing {r}");
        }
        let calm = PortfolioContext {
            today: Some(d("2026-06-05")),
            ips_reviewed: Some(d("2026-01-01")),
            ..Default::default()
        };
        assert!(portfolio(&calm).is_empty());
    }

    #[test]
    fn tax_rules() {
        let c = TaxContext {
            today: Some(d("2027-04-12")),
            deadlines: vec![
                ("Federal return due".into(), d("2027-04-15")),
                ("Extended".into(), d("2027-04-24")),
            ],
            late_documents: vec!["1099-B".into()],
            se_quarterly_suggested: Some(dec("1500")),
            estimated_payments_recorded: 0,
            se_threshold: dec("1000"),
            itemized_vs_standard: Some((dec("15000"), dec("16100"))),
            pack_stale: true,
            missing_receipts: vec!["Laptop".into()],
            setaside: Some((dec("100"), dec("900"))),
        };
        let got = tax(&c);
        let got = ids(&got);
        for r in [
            "deadline-3",
            "deadline-14",
            "doc-late",
            "se-no-estimates",
            "itemize-close",
            "pack-stale",
            "receipt-missing",
            "setaside-short",
        ] {
            assert!(got.contains(&r), "missing {r}");
        }
        let calm = TaxContext {
            today: Some(d("2027-01-01")),
            se_threshold: dec("1000"),
            se_quarterly_suggested: Some(dec("500")),
            ..Default::default()
        };
        assert!(tax(&calm).is_empty());
    }
}
