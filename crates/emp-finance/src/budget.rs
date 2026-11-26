//! Budgets (§15.3): 50/30/20, zero-based, pay-yourself-first, envelopes and track-only.
//!
//! Core quantities per category and budget month:
//! * `activity` — sum of the category's transactions in the month, excluding transfers.
//! * `available = rollover_prev + assigned + activity`.
//! * `rollover_prev` — the previous month's `available` when the category rolls over (always under
//!   `envelopes`). Otherwise negative balances are carried as overspend and positive balances are released
//!   back to *To be assigned* (so money is never created or lost).
//! * `to_be_assigned = income_this_month + carry_tba_prev − Σ assigned` (zero-based and envelopes), where
//!   `carry_tba_prev` is last month's TBA plus balances released by non-rollover categories.
//!
//! Invariant (tested on random ledgers): `Σ available + TBA = Σ income + Σ activity` over all months so far.

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};
use crate::ledger::{Category, Txn};
use crate::money::to_f64;
use crate::period::{Period, YearMonth, budget_month_of, budget_period};

/// Budget method (Money HQ `method` question).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetMethod {
    /// Needs 50% / Wants 30% / Savings & Debt 20% of net income.
    FiftyThirtyTwenty,
    /// Every unit of income is assigned.
    ZeroBased,
    /// A savings target comes off the top; the rest is free to spend.
    PayYourselfFirst,
    /// Zero-based with persistent envelope balances (every category rolls over).
    Envelopes,
    /// No plan; tracks income and spending only.
    TrackOnly,
}

impl BudgetMethod {
    /// Whether the method reports *To be assigned*.
    pub fn uses_tba(self) -> bool {
        matches!(self, Self::ZeroBased | Self::Envelopes)
    }
}

/// 50/30/20 group names.
pub const GROUP_NEEDS: &str = "Needs";
/// 50/30/20 group names.
pub const GROUP_WANTS: &str = "Wants";
/// 50/30/20 group names.
pub const GROUP_SAVINGS: &str = "Savings & Debt";

/// Budget configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetConfig {
    /// Method.
    pub method: BudgetMethod,
    /// First day of the budget month (1–28).
    pub month_start_day: u8,
    /// "Budget last month's income": this month's assignable income is last month's income.
    #[serde(default)]
    pub income_buffer: bool,
    /// Pay-yourself-first savings share of income (default 20%).
    #[serde(default)]
    pub savings_target_pct: Option<Decimal>,
}

/// Money assigned to a category for a month.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    /// Budget month.
    pub month: YearMonth,
    /// Category id.
    pub category_id: String,
    /// Assigned amount.
    pub amount: Decimal,
}

/// Inputs for budget computation.
#[derive(Debug, Clone, Copy)]
pub struct BudgetInput<'a> {
    /// Configuration.
    pub config: &'a BudgetConfig,
    /// All categories (income categories included).
    pub categories: &'a [Category],
    /// Transactions of on-budget accounts.
    pub txns: &'a [Txn],
    /// Assignments (later duplicates for the same month/category override earlier ones).
    pub assignments: &'a [Assignment],
}

/// One category in one month.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMonth {
    /// Category id.
    pub category_id: String,
    /// Assigned this month.
    pub assigned: Decimal,
    /// Activity this month (negative = spending).
    pub activity: Decimal,
    /// Available at month end.
    pub available: Decimal,
    /// Amount carried in from last month (`rollover_prev`).
    pub rollover: Decimal,
}

impl CategoryMonth {
    /// Net spending (`max(0, −activity)`).
    pub fn spent(&self) -> Decimal {
        (-self.activity).max(Decimal::ZERO)
    }

    /// Whether the category is overspent.
    pub fn overspent(&self) -> bool {
        self.available < Decimal::ZERO
    }
}

/// A 50/30/20 (or pay-yourself-first) group line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupTarget {
    /// Group name.
    pub group: String,
    /// Share of net income (0–1).
    pub share: Decimal,
    /// Target amount.
    pub target: Decimal,
    /// Actual net spending in the group.
    pub actual: Decimal,
}

/// A computed budget month.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetMonth {
    /// Month.
    pub month: YearMonth,
    /// Date range.
    pub period: Period,
    /// Income assignable this month (last month's income under the income buffer).
    pub income: Decimal,
    /// Income actually received this month.
    pub income_received: Decimal,
    /// Σ assigned.
    pub assigned_total: Decimal,
    /// Net spending across non-income categories (`−Σ activity`).
    pub spending: Decimal,
    /// TBA carried in (`carry_tba_prev`).
    pub carry_tba_prev: Decimal,
    /// To be assigned (zero-based and envelopes).
    pub to_be_assigned: Option<Decimal>,
    /// Left to spend (50/30/20, pay-yourself-first, track-only).
    pub left_to_spend: Option<Decimal>,
    /// Per-category lines (non-income categories).
    pub categories: Vec<CategoryMonth>,
    /// Group targets (50/30/20 and pay-yourself-first).
    pub groups: Vec<GroupTarget>,
    /// Transactions in the month with no category (excluding transfers).
    pub uncategorized: usize,
}

impl BudgetMonth {
    /// Looks up a category line.
    pub fn category(&self, id: &str) -> Option<&CategoryMonth> {
        self.categories.iter().find(|c| c.category_id == id)
    }
}

/// 50/30/20 targets for a net income.
pub fn fifty_thirty_twenty(income: Decimal) -> [(String, Decimal, Decimal); 3] {
    let s = |p: i64| Decimal::new(p, 2);
    [
        (GROUP_NEEDS.to_string(), s(50), income * s(50)),
        (GROUP_WANTS.to_string(), s(30), income * s(30)),
        (GROUP_SAVINGS.to_string(), s(20), income * s(20)),
    ]
}

/// Computes budget months `from..=to` (inclusive). Months before `from` are not computed, so pass the
/// first month the budget existed as `from` for correct rollovers.
pub fn compute(
    input: &BudgetInput<'_>,
    from: YearMonth,
    to: YearMonth,
) -> Result<Vec<BudgetMonth>> {
    let cfg = input.config;
    if !(1..=28).contains(&cfg.month_start_day) {
        return Err(FinanceError::invalid("monthStartDay must be 1–28"));
    }
    if from.months_until(to) > 1200 {
        return Err(FinanceError::invalid("budget range too long"));
    }
    let income_cats: HashMap<&str, &Category> = input
        .categories
        .iter()
        .filter(|c| c.is_income)
        .map(|c| (c.id.as_str(), c))
        .collect();
    let spend_cats: Vec<&Category> = input.categories.iter().filter(|c| !c.is_income).collect();

    // Bucket transactions by budget month.
    let mut activity: HashMap<(YearMonth, &str), Decimal> = HashMap::new();
    let mut income: BTreeMap<YearMonth, Decimal> = BTreeMap::new();
    let mut uncategorized: HashMap<YearMonth, usize> = HashMap::new();
    for t in input.txns.iter().filter(|t| t.counts() && !t.is_transfer()) {
        let m = budget_month_of(t.date, cfg.month_start_day);
        match t.category_id.as_deref() {
            Some(c) if income_cats.contains_key(c) => *income.entry(m).or_default() += t.amount,
            Some(c) => *activity.entry((m, c)).or_default() += t.amount,
            None => *uncategorized.entry(m).or_default() += 1,
        }
    }
    let mut assigned: HashMap<(YearMonth, &str), Decimal> = HashMap::new();
    for a in input.assignments {
        assigned.insert((a.month, a.category_id.as_str()), a.amount);
    }

    let mut out = Vec::new();
    let mut prev_avail: HashMap<&str, Decimal> = HashMap::new();
    let mut prev_tba = Decimal::ZERO;
    let mut m = from;
    while m <= to {
        let received = income.get(&m).copied().unwrap_or_default();
        let assignable = if cfg.income_buffer {
            income.get(&m.prev()).copied().unwrap_or_default()
        } else {
            received
        };
        let mut cats = Vec::with_capacity(spend_cats.len());
        let mut released = Decimal::ZERO;
        let mut assigned_total = Decimal::ZERO;
        let mut spending = Decimal::ZERO;
        let mut group_actual: HashMap<&str, Decimal> = HashMap::new();
        for c in &spend_cats {
            let prev = prev_avail.get(c.id.as_str()).copied().unwrap_or_default();
            let rolls = c.rollover || cfg.method == BudgetMethod::Envelopes;
            let rollover = if rolls || prev < Decimal::ZERO {
                prev
            } else {
                Decimal::ZERO
            };
            if !rolls && prev > Decimal::ZERO {
                released += prev;
            }
            let a = assigned
                .get(&(m, c.id.as_str()))
                .copied()
                .unwrap_or_default();
            let act = activity
                .get(&(m, c.id.as_str()))
                .copied()
                .unwrap_or_default();
            let avail = rollover + a + act;
            assigned_total += a;
            spending -= act;
            *group_actual.entry(c.group.as_str()).or_default() -= act;
            cats.push(CategoryMonth {
                category_id: c.id.clone(),
                assigned: a,
                activity: act,
                available: avail,
                rollover,
            });
        }
        for (c, cm) in spend_cats.iter().zip(&cats) {
            prev_avail.insert(c.id.as_str(), cm.available);
        }
        let carry = prev_tba + released;
        let tba = assignable + carry - assigned_total;
        let (groups, left_to_spend) = match cfg.method {
            BudgetMethod::FiftyThirtyTwenty => {
                let g: Vec<GroupTarget> = fifty_thirty_twenty(assignable)
                    .into_iter()
                    .map(|(group, share, target)| GroupTarget {
                        actual: group_actual
                            .get(group.as_str())
                            .copied()
                            .unwrap_or_default(),
                        group,
                        share,
                        target,
                    })
                    .collect();
                let lts = g
                    .iter()
                    .filter(|x| x.group != GROUP_SAVINGS)
                    .map(|x| x.target - x.actual)
                    .sum();
                (g, Some(lts))
            }
            BudgetMethod::PayYourselfFirst => {
                let share =
                    cfg.savings_target_pct.unwrap_or(Decimal::new(20, 0)) / Decimal::ONE_HUNDRED;
                let saving_ids: Vec<&str> = spend_cats
                    .iter()
                    .filter(|c| c.is_saving)
                    .map(|c| c.id.as_str())
                    .collect();
                let saved: Decimal = cats
                    .iter()
                    .filter(|c| saving_ids.contains(&c.category_id.as_str()))
                    .map(|c| -c.activity)
                    .sum();
                let target = assignable * share;
                let g = vec![GroupTarget {
                    group: GROUP_SAVINGS.into(),
                    share,
                    target,
                    actual: saved,
                }];
                (g, Some(assignable - target - (spending - saved)))
            }
            BudgetMethod::TrackOnly => (Vec::new(), Some(assignable - spending)),
            BudgetMethod::ZeroBased | BudgetMethod::Envelopes => (Vec::new(), None),
        };
        out.push(BudgetMonth {
            month: m,
            period: budget_period(m, cfg.month_start_day),
            income: assignable,
            income_received: received,
            assigned_total,
            spending,
            carry_tba_prev: carry,
            to_be_assigned: cfg.method.uses_tba().then_some(tba),
            left_to_spend,
            categories: cats,
            groups,
            uncategorized: uncategorized.get(&m).copied().unwrap_or_default(),
        });
        prev_tba = tba;
        m = m.next();
    }
    Ok(out)
}

/// `day_of_period / days_in_period` for `today` (clamped to 0–1).
pub fn pace(period: &Period, today: NaiveDate) -> f64 {
    if today < period.start {
        return 0.0;
    }
    if today > period.end {
        return 1.0;
    }
    period.day_of(today) as f64 / period.days() as f64
}

/// "On track" when spent ÷ assigned ≤ pace + 0.1. Nothing spent is always on track; spending with nothing
/// assigned never is.
pub fn on_track(spent: Decimal, assigned: Decimal, pace: f64) -> bool {
    if spent <= Decimal::ZERO {
        return true;
    }
    if assigned <= Decimal::ZERO {
        return false;
    }
    to_f64(spent / assigned) <= pace + 0.1
}

/// Income stability answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncomeStability {
    /// Predictable.
    Stable,
    /// Varies somewhat.
    Variable,
    /// Irregular / freelance.
    Irregular,
}

/// Inputs for [`recommend_budget_method`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodAnswers {
    /// Income stability.
    pub stability: IncomeStability,
    /// Any debt with APR ≥ [`HIGH_APR_PCT`].
    pub has_high_apr_debt: bool,
    /// Cash is tight (balances near zero / frequent overdrafts).
    pub tight_cash: bool,
    /// Current savings rate (0–1), if known.
    pub savings_rate: Option<f64>,
    /// The user asked for something simple.
    pub prefers_simple: bool,
}

/// APR (percent) at or above which debt counts as high-interest.
pub const HIGH_APR_PCT: i64 = 10;

/// A recommendation with a short reason for the wizard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodRecommendation {
    /// Recommended method.
    pub method: BudgetMethod,
    /// Turn on "Budget last month's income".
    pub income_buffer: bool,
    /// Reason id (`irregular_income`, `high_apr_or_tight_cash`, `strong_saver`, `simple`, `default`).
    pub reason: String,
}

/// `recommend_budget_method` (§16.2 Q4): irregular income → zero-based with income buffer; high-APR debt or
/// tight cash → zero-based; stable income with savings rate ≥ 20% → pay-yourself-first; "simple" → 50/30/20.
pub fn recommend_budget_method(a: &MethodAnswers) -> MethodRecommendation {
    let rec = |method, income_buffer, reason: &str| MethodRecommendation {
        method,
        income_buffer,
        reason: reason.into(),
    };
    if a.stability == IncomeStability::Irregular {
        return rec(BudgetMethod::ZeroBased, true, "irregular_income");
    }
    if a.has_high_apr_debt || a.tight_cash {
        return rec(BudgetMethod::ZeroBased, false, "high_apr_or_tight_cash");
    }
    if a.stability == IncomeStability::Stable && a.savings_rate.is_some_and(|r| r >= 0.20) {
        return rec(BudgetMethod::PayYourselfFirst, false, "strong_saver");
    }
    if a.prefers_simple {
        return rec(BudgetMethod::FiftyThirtyTwenty, false, "simple");
    }
    rec(BudgetMethod::FiftyThirtyTwenty, false, "default")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::SplitMix64;
    use crate::testutil::{dec, txn};

    fn cat(id: &str, group: &str, income: bool, rollover: bool) -> Category {
        Category {
            id: id.into(),
            name: id.into(),
            group: group.into(),
            is_income: income,
            essential: false,
            rollover,
            variable: true,
            is_saving: group == GROUP_SAVINGS,
        }
    }

    fn ym(s: &str) -> YearMonth {
        s.parse().unwrap()
    }

    fn with_cat(mut t: Txn, c: &str) -> Txn {
        t.category_id = Some(c.into());
        t
    }

    fn cfg(method: BudgetMethod) -> BudgetConfig {
        BudgetConfig {
            method,
            month_start_day: 1,
            income_buffer: false,
            savings_target_pct: None,
        }
    }

    #[test]
    fn zero_based_rollover_and_release() {
        let cats = vec![
            cat("inc", "Income", true, false),
            cat("food", GROUP_NEEDS, false, false),
            cat("trip", GROUP_WANTS, false, true),
        ];
        let txns = vec![
            with_cat(txn("1", "a", "2026-01-01", "3000"), "inc"),
            with_cat(txn("2", "a", "2026-01-10", "-450"), "food"),
            with_cat(txn("3", "a", "2026-01-15", "-50"), "trip"),
            with_cat(txn("4", "a", "2026-02-01", "3000"), "inc"),
            with_cat(txn("5", "a", "2026-02-10", "-650"), "food"),
            {
                let mut t = with_cat(txn("6", "a", "2026-02-11", "-999"), "food");
                t.transfer_id = Some("x".into());
                t
            },
            txn("7", "a", "2026-02-12", "-5"),
        ];
        let asg = vec![
            Assignment {
                month: ym("2026-01"),
                category_id: "food".into(),
                amount: dec("500"),
            },
            Assignment {
                month: ym("2026-01"),
                category_id: "trip".into(),
                amount: dec("200"),
            },
            Assignment {
                month: ym("2026-02"),
                category_id: "food".into(),
                amount: dec("500"),
            },
        ];
        let c = cfg(BudgetMethod::ZeroBased);
        let input = BudgetInput {
            config: &c,
            categories: &cats,
            txns: &txns,
            assignments: &asg,
        };
        let months = compute(&input, ym("2026-01"), ym("2026-03")).unwrap();
        let jan = &months[0];
        assert_eq!(jan.to_be_assigned, Some(dec("2300")));
        assert_eq!(jan.category("food").unwrap().available, dec("50"));
        assert_eq!(jan.category("trip").unwrap().available, dec("150"));
        let feb = &months[1];
        // food's +50 is released to TBA; trip rolls 150.
        assert_eq!(feb.carry_tba_prev, dec("2350"));
        assert_eq!(feb.to_be_assigned, Some(dec("4850")));
        assert_eq!(feb.category("food").unwrap().available, dec("-150"));
        assert!(feb.category("food").unwrap().overspent());
        assert_eq!(feb.category("trip").unwrap().rollover, dec("150"));
        assert_eq!(feb.uncategorized, 1);
        let mar = &months[2];
        // Overspend carries even without rollover.
        assert_eq!(mar.category("food").unwrap().rollover, dec("-150"));
        assert_eq!(mar.to_be_assigned, Some(dec("4850")));
    }

    #[test]
    fn fifty_thirty_twenty_left_to_spend() {
        let cats = vec![
            cat("inc", "Income", true, false),
            cat("rent", GROUP_NEEDS, false, false),
            cat("fun", GROUP_WANTS, false, false),
        ];
        let txns = vec![
            with_cat(txn("1", "a", "2026-03-01", "4000"), "inc"),
            with_cat(txn("2", "a", "2026-03-02", "-1500"), "rent"),
            with_cat(txn("3", "a", "2026-03-05", "-300"), "fun"),
        ];
        let c = cfg(BudgetMethod::FiftyThirtyTwenty);
        let input = BudgetInput {
            config: &c,
            categories: &cats,
            txns: &txns,
            assignments: &[],
        };
        let m = &compute(&input, ym("2026-03"), ym("2026-03")).unwrap()[0];
        assert_eq!(m.to_be_assigned, None);
        assert_eq!(m.groups[0].target, dec("2000.00"));
        assert_eq!(m.groups[0].actual, dec("1500"));
        // (2000 − 1500) + (1200 − 300)
        assert_eq!(m.left_to_spend, Some(dec("1400.00")));
    }

    #[test]
    fn income_buffer_and_start_day() {
        let cats = vec![cat("inc", "Income", true, false)];
        let txns = vec![
            with_cat(txn("1", "a", "2026-01-20", "1000"), "inc"),
            with_cat(txn("2", "a", "2026-02-14", "700"), "inc"),
        ];
        let mut c = cfg(BudgetMethod::ZeroBased);
        c.income_buffer = true;
        c.month_start_day = 15;
        let input = BudgetInput {
            config: &c,
            categories: &cats,
            txns: &txns,
            assignments: &[],
        };
        let months = compute(&input, ym("2026-01"), ym("2026-02")).unwrap();
        // Jan 15–Feb 14 receives both; February assigns January's income.
        assert_eq!(months[0].income_received, dec("1700"));
        assert_eq!(months[0].income, dec("0"));
        assert_eq!(months[1].income, dec("1700"));
        assert!(
            compute(
                &BudgetInput {
                    config: &BudgetConfig {
                        month_start_day: 29,
                        ..c.clone()
                    },
                    ..input
                },
                ym("2026-01"),
                ym("2026-01")
            )
            .is_err()
        );
    }

    #[test]
    fn envelopes_roll_everything() {
        let cats = vec![cat("food", GROUP_NEEDS, false, false)];
        let asg = vec![Assignment {
            month: ym("2026-01"),
            category_id: "food".into(),
            amount: dec("100"),
        }];
        let c = cfg(BudgetMethod::Envelopes);
        let input = BudgetInput {
            config: &c,
            categories: &cats,
            txns: &[],
            assignments: &asg,
        };
        let months = compute(&input, ym("2026-01"), ym("2026-02")).unwrap();
        assert_eq!(months[1].category("food").unwrap().available, dec("100"));
        assert_eq!(months[1].to_be_assigned, Some(dec("-100")));
    }

    #[test]
    fn identity_holds_on_random_ledgers() {
        let mut rng = SplitMix64::new(42);
        for case in 0..60 {
            let cats: Vec<Category> = (0..5)
                .map(|i| {
                    cat(
                        &format!("c{i}"),
                        [GROUP_NEEDS, GROUP_WANTS, GROUP_SAVINGS][i % 3],
                        i == 0,
                        rng.below(2) == 1,
                    )
                })
                .collect();
            let mut txns = Vec::new();
            for k in 0..80 {
                let d = NaiveDate::from_ymd_opt(
                    2026,
                    1 + rng.below(6) as u32,
                    1 + rng.below(28) as u32,
                )
                .unwrap();
                let c = rng.below(6);
                let amt = Decimal::new(rng.below(200_000) as i64 - 100_000, 2);
                let mut t = txn(&k.to_string(), "a", &d.to_string(), &amt.to_string());
                if c < 5 {
                    t.category_id = Some(format!("c{c}"));
                }
                if c == 0 {
                    t.amount = t.amount.abs();
                }
                txns.push(t);
            }
            let asg: Vec<Assignment> = (0..20)
                .map(|_| Assignment {
                    month: YearMonth::new(2026, 1 + rng.below(6) as u32).unwrap(),
                    category_id: format!("c{}", 1 + rng.below(4)),
                    amount: Decimal::new(rng.below(100_000) as i64, 2),
                })
                .collect();
            let method = if case % 2 == 0 {
                BudgetMethod::ZeroBased
            } else {
                BudgetMethod::Envelopes
            };
            let c = BudgetConfig {
                method,
                month_start_day: 1 + rng.below(28) as u8,
                income_buffer: case % 3 == 0,
                savings_target_pct: None,
            };
            let input = BudgetInput {
                config: &c,
                categories: &cats,
                txns: &txns,
                assignments: &asg,
            };
            let months = compute(&input, ym("2025-12"), ym("2026-07")).unwrap();
            let mut income = Decimal::ZERO;
            let mut activity = Decimal::ZERO;
            for m in &months {
                income += m.income;
                activity += m.categories.iter().map(|c| c.activity).sum::<Decimal>();
                let avail: Decimal = m.categories.iter().map(|c| c.available).sum();
                assert_eq!(
                    avail + m.to_be_assigned.unwrap(),
                    income + activity,
                    "case {case} month {}",
                    m.month
                );
            }
        }
    }

    #[test]
    fn pace_and_track() {
        let p = budget_period(ym("2026-04"), 1);
        assert!((pace(&p, "2026-04-15".parse().unwrap()) - 0.5).abs() < 1e-9);
        assert_eq!(pace(&p, "2026-05-15".parse().unwrap()), 1.0);
        assert!(on_track(dec("55"), dec("100"), 0.5));
        assert!(!on_track(dec("61"), dec("100"), 0.5));
        assert!(!on_track(dec("1"), dec("0"), 0.5));
        assert!(on_track(dec("0"), dec("0"), 0.0));
    }

    #[test]
    fn recommendations() {
        let base = MethodAnswers {
            stability: IncomeStability::Stable,
            has_high_apr_debt: false,
            tight_cash: false,
            savings_rate: Some(0.25),
            prefers_simple: false,
        };
        assert_eq!(
            recommend_budget_method(&base).method,
            BudgetMethod::PayYourselfFirst
        );
        let r = recommend_budget_method(&MethodAnswers {
            stability: IncomeStability::Irregular,
            ..base.clone()
        });
        assert_eq!((r.method, r.income_buffer), (BudgetMethod::ZeroBased, true));
        assert_eq!(
            recommend_budget_method(&MethodAnswers {
                has_high_apr_debt: true,
                ..base.clone()
            })
            .method,
            BudgetMethod::ZeroBased
        );
        assert_eq!(
            recommend_budget_method(&MethodAnswers {
                savings_rate: Some(0.05),
                prefers_simple: true,
                ..base
            })
            .method,
            BudgetMethod::FiftyThirtyTwenty
        );
    }
}
