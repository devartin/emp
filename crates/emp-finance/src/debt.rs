//! Debt payoff simulation (§15.5 `debt::simulate`) and the `finance_debt_plan` command shape.
//!
//! Each month: interest accrues at `APR/12` on the balance (rounded to cents, half-up) before payment;
//! minimums are paid; the extra payment plus every freed-up minimum goes to the current target debt and
//! cascades down the strategy order. The simulation stops at 600 months or when every balance is zero.
//! Balances never go below zero.

use std::collections::{BTreeMap, HashSet};

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{FinanceError, Result};
use crate::money::{cents, parse_decimal};
use crate::period::YearMonth;

/// Maximum simulated months.
pub const MAX_MONTHS: u32 = 600;
/// Maximum number of debts per plan.
pub const MAX_DEBTS: usize = 50;

/// A debt (positive balance owed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Debt {
    /// Unique name (the schedule's key).
    pub name: String,
    /// Balance owed (≥ 0).
    pub balance: Decimal,
    /// APR in percent.
    pub apr_pct: Decimal,
    /// Minimum monthly payment.
    pub min_payment: Decimal,
}

/// Payoff strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// APR descending, ties by smaller balance.
    Avalanche,
    /// Balance ascending.
    Snowball,
    /// The two smallest balances first, then avalanche.
    Hybrid,
    /// The user's order.
    Custom,
    /// Minimum payments only (baseline; not user-selectable).
    MinimumsOnly,
}

impl Strategy {
    /// Wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::Avalanche => "avalanche",
            Strategy::Snowball => "snowball",
            Strategy::Hybrid => "hybrid",
            Strategy::Custom => "custom",
            Strategy::MinimumsOnly => "minimums_only",
        }
    }
}

/// One month of the schedule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRow {
    /// Month.
    pub month: YearMonth,
    /// End-of-month balances by debt name.
    pub balances: BTreeMap<String, Decimal>,
    /// Payments made this month by debt name.
    pub payments: BTreeMap<String, Decimal>,
    /// Interest charged this month by debt name.
    pub interest: BTreeMap<String, Decimal>,
}

/// A simulation result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Simulation {
    /// Strategy used.
    pub strategy: Strategy,
    /// Months until every balance reached zero (or [`MAX_MONTHS`]).
    pub months: u32,
    /// Whether every debt was paid off within [`MAX_MONTHS`].
    pub paid_off: bool,
    /// Month in which each debt reached zero.
    pub payoff_dates: BTreeMap<String, YearMonth>,
    /// Total interest paid.
    pub total_interest: Decimal,
    /// Total paid.
    pub total_paid: Decimal,
    /// Month-by-month schedule.
    pub schedule: Vec<ScheduleRow>,
}

impl Simulation {
    /// The month of the final payment (debt-free date).
    pub fn debt_free(&self) -> Option<YearMonth> {
        if self.paid_off {
            self.payoff_dates.values().max().copied()
        } else {
            None
        }
    }
}

fn validate(debts: &[Debt]) -> Result<()> {
    if debts.len() > MAX_DEBTS {
        return Err(FinanceError::invalid(format!("at most {MAX_DEBTS} debts")));
    }
    let mut names = HashSet::new();
    let bound = crate::money::amount_bound();
    for d in debts {
        if d.balance >= bound || d.min_payment >= bound {
            return Err(FinanceError::invalid(format!(
                "{}: amount out of range",
                d.name
            )));
        }
        if d.name.trim().is_empty() || !names.insert(d.name.as_str()) {
            return Err(FinanceError::invalid(format!(
                "debt names must be unique and non-empty ({:?})",
                d.name
            )));
        }
        if d.balance < Decimal::ZERO || d.min_payment < Decimal::ZERO {
            return Err(FinanceError::invalid(format!(
                "{}: balance and minimum must be ≥ 0",
                d.name
            )));
        }
        if d.apr_pct < Decimal::ZERO || d.apr_pct > Decimal::from(100) {
            return Err(FinanceError::invalid(format!(
                "{}: APR must be 0–100%",
                d.name
            )));
        }
    }
    Ok(())
}

/// The strategy's payoff order (indexes into `debts`).
pub fn order(debts: &[Debt], strategy: Strategy, custom: Option<&[String]>) -> Result<Vec<usize>> {
    let mut idx: Vec<usize> = (0..debts.len()).collect();
    let avalanche = |v: &mut Vec<usize>| {
        v.sort_by(|&a, &b| {
            debts[b]
                .apr_pct
                .cmp(&debts[a].apr_pct)
                .then(debts[a].balance.cmp(&debts[b].balance))
                .then(a.cmp(&b))
        })
    };
    match strategy {
        Strategy::Avalanche | Strategy::MinimumsOnly => avalanche(&mut idx),
        Strategy::Snowball => {
            idx.sort_by(|&a, &b| debts[a].balance.cmp(&debts[b].balance).then(a.cmp(&b)))
        }
        Strategy::Hybrid => {
            idx.sort_by(|&a, &b| debts[a].balance.cmp(&debts[b].balance).then(a.cmp(&b)));
            let mut rest = idx.split_off(idx.len().min(2));
            avalanche(&mut rest);
            idx.extend(rest);
        }
        Strategy::Custom => {
            let names =
                custom.ok_or_else(|| FinanceError::invalid("custom strategy needs an order"))?;
            let mut out = Vec::new();
            for n in names {
                let i = debts
                    .iter()
                    .position(|d| &d.name == n)
                    .ok_or_else(|| FinanceError::invalid(format!("unknown debt {n:?} in order")))?;
                if !out.contains(&i) {
                    out.push(i);
                }
            }
            let mut rest: Vec<usize> = idx.into_iter().filter(|i| !out.contains(i)).collect();
            avalanche(&mut rest);
            out.extend(rest);
            idx = out;
        }
    }
    Ok(idx)
}

/// Simulates a strategy. `extra_monthly` is added to the minimums every month; freed minimums roll into the
/// target debt. [`Strategy::MinimumsOnly`] pays minimums only, with no extra and no rollover.
pub fn simulate(
    debts: &[Debt],
    strategy: Strategy,
    extra_monthly: Decimal,
    custom: Option<&[String]>,
    start: YearMonth,
) -> Result<Simulation> {
    validate(debts)?;
    if extra_monthly < Decimal::ZERO {
        return Err(FinanceError::invalid("extra payment must be ≥ 0"));
    }
    let ord = order(debts, strategy, custom)?;
    let mut bal: Vec<Decimal> = debts.iter().map(|d| d.balance).collect();
    let rollover = strategy != Strategy::MinimumsOnly;
    let budget = if rollover {
        debts.iter().map(|d| d.min_payment).sum::<Decimal>() + extra_monthly
    } else {
        Decimal::ZERO
    };
    let mut sim = Simulation {
        strategy,
        months: 0,
        paid_off: false,
        payoff_dates: BTreeMap::new(),
        total_interest: Decimal::ZERO,
        total_paid: Decimal::ZERO,
        schedule: Vec::new(),
    };
    let start_prev = start.prev();
    for (i, d) in debts.iter().enumerate() {
        if bal[i].is_zero() {
            sim.payoff_dates.insert(d.name.clone(), start_prev);
        }
    }
    let mut month = start;
    while bal.iter().any(|b| *b > Decimal::ZERO) && sim.months < MAX_MONTHS {
        let mut pay = vec![Decimal::ZERO; debts.len()];
        let mut interest = vec![Decimal::ZERO; debts.len()];
        for i in 0..debts.len() {
            if bal[i] > Decimal::ZERO {
                interest[i] = cents(bal[i] * debts[i].apr_pct / Decimal::from(1200));
                bal[i] += interest[i];
            }
        }
        let mut spent = Decimal::ZERO;
        for i in 0..debts.len() {
            let p = debts[i].min_payment.min(bal[i]);
            pay[i] += p;
            bal[i] -= p;
            spent += p;
        }
        if rollover {
            let mut pool = (budget - spent).max(Decimal::ZERO);
            for &i in &ord {
                if pool <= Decimal::ZERO {
                    break;
                }
                let p = pool.min(bal[i]);
                pay[i] += p;
                bal[i] -= p;
                pool -= p;
            }
        }
        let mut row = ScheduleRow {
            month,
            balances: BTreeMap::new(),
            payments: BTreeMap::new(),
            interest: BTreeMap::new(),
        };
        for (i, d) in debts.iter().enumerate() {
            sim.total_interest += interest[i];
            sim.total_paid += pay[i];
            if bal[i].is_zero() && !sim.payoff_dates.contains_key(&d.name) {
                sim.payoff_dates.insert(d.name.clone(), month);
            }
            row.balances.insert(d.name.clone(), bal[i]);
            row.payments.insert(d.name.clone(), pay[i]);
            row.interest.insert(d.name.clone(), interest[i]);
        }
        sim.schedule.push(row);
        sim.months += 1;
        month = month.next();
    }
    sim.paid_off = bal.iter().all(|b| b.is_zero());
    Ok(sim)
}

/// IPC debt input (`finance_debt_plan.debts[]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebtInput {
    /// Name.
    pub name: String,
    /// Balance (decimal string).
    pub balance: String,
    /// APR percent (decimal string).
    pub apr_pct: String,
    /// Minimum payment (decimal string).
    pub min_payment: String,
}

/// `finance_debt_plan` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebtPlanRequest {
    /// Debts.
    pub debts: Vec<DebtInput>,
    /// Requested strategy (its schedule is returned).
    pub strategy: Strategy,
    /// Extra per month (decimal string).
    pub extra_monthly: String,
    /// Custom order of names.
    #[serde(default)]
    pub order: Option<Vec<String>>,
    /// First month (`YYYY-MM`).
    pub start_month: YearMonth,
}

/// One strategy summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategySummary {
    /// Strategy name.
    pub strategy: String,
    /// Months to debt-free.
    pub months: u32,
    /// Debt-free month (`YYYY-MM`); `null` when not paid off within 600 months.
    pub payoff_date: Option<YearMonth>,
    /// Total interest.
    pub total_interest: Decimal,
    /// Interest saved compared with minimums only.
    pub interest_saved_vs_min: Decimal,
}

/// IPC schedule row (balances and payments as decimal strings).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    /// Month (`YYYY-MM`).
    pub month: YearMonth,
    /// Balances by name.
    pub balances: BTreeMap<String, Decimal>,
    /// Payments by name.
    pub payments: BTreeMap<String, Decimal>,
}

/// `finance_debt_plan` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPlanResponse {
    /// Avalanche, snowball, hybrid (and custom when an order is given), then the minimums-only baseline as
    /// `"minimum"` (what the browser mock returns too; the Debt tab's "Months sooner" and Money HQ's debt-free date
    /// read it).
    pub strategies: Vec<StrategySummary>,
    /// Schedule for the requested strategy.
    pub schedule: Vec<PlanRow>,
}

/// Runs every strategy and returns the IPC response.
pub fn plan(req: &DebtPlanRequest) -> Result<DebtPlanResponse> {
    let debts: Vec<Debt> = req
        .debts
        .iter()
        .map(|d| {
            Ok(Debt {
                name: d.name.clone(),
                balance: parse_decimal(&d.balance)?,
                apr_pct: parse_decimal(&d.apr_pct)?,
                min_payment: parse_decimal(&d.min_payment)?,
            })
        })
        .collect::<Result<_>>()?;
    let extra = parse_decimal(&req.extra_monthly)?;
    let order = req.order.as_deref();
    let baseline = simulate(
        &debts,
        Strategy::MinimumsOnly,
        Decimal::ZERO,
        None,
        req.start_month,
    )?;
    let mut list = vec![Strategy::Avalanche, Strategy::Snowball, Strategy::Hybrid];
    if order.is_some() || req.strategy == Strategy::Custom {
        list.push(Strategy::Custom);
    }
    let mut strategies = Vec::new();
    let mut schedule = Vec::new();
    for s in list {
        let sim = simulate(&debts, s, extra, order, req.start_month)?;
        strategies.push(StrategySummary {
            strategy: s.as_str().into(),
            months: sim.months,
            payoff_date: sim.debt_free(),
            total_interest: sim.total_interest,
            interest_saved_vs_min: (baseline.total_interest - sim.total_interest)
                .max(Decimal::ZERO),
        });
        if s == req.strategy {
            schedule = sim
                .schedule
                .into_iter()
                .map(|r| PlanRow {
                    month: r.month,
                    balances: r.balances,
                    payments: r.payments,
                })
                .collect();
        }
    }
    strategies.push(StrategySummary {
        strategy: "minimum".into(),
        months: baseline.months,
        payoff_date: baseline.debt_free(),
        total_interest: baseline.total_interest,
        interest_saved_vs_min: Decimal::ZERO,
    });
    if req.strategy == Strategy::MinimumsOnly {
        schedule = baseline
            .schedule
            .into_iter()
            .map(|r| PlanRow {
                month: r.month,
                balances: r.balances,
                payments: r.payments,
            })
            .collect();
    }
    Ok(DebtPlanResponse {
        strategies,
        schedule,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::dec;

    fn debts() -> Vec<Debt> {
        vec![
            Debt {
                name: "Card".into(),
                balance: dec("5000"),
                apr_pct: dec("22.99"),
                min_payment: dec("150"),
            },
            Debt {
                name: "Store".into(),
                balance: dec("800"),
                apr_pct: dec("26.99"),
                min_payment: dec("35"),
            },
            Debt {
                name: "Car".into(),
                balance: dec("12000"),
                apr_pct: dec("6.5"),
                min_payment: dec("300"),
            },
            Debt {
                name: "Medical".into(),
                balance: dec("400"),
                apr_pct: dec("0"),
                min_payment: dec("25"),
            },
        ]
    }

    fn ym(s: &str) -> YearMonth {
        s.parse().unwrap()
    }

    #[test]
    fn orders() {
        let d = debts();
        let names = |v: Vec<usize>| {
            v.into_iter()
                .map(|i| d[i].name.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(order(&d, Strategy::Avalanche, None).unwrap()),
            ["Store", "Card", "Car", "Medical"]
        );
        assert_eq!(
            names(order(&d, Strategy::Snowball, None).unwrap()),
            ["Medical", "Store", "Card", "Car"]
        );
        assert_eq!(
            names(order(&d, Strategy::Hybrid, None).unwrap()),
            ["Medical", "Store", "Card", "Car"]
        );
        let custom = vec!["Car".to_string()];
        assert_eq!(
            names(order(&d, Strategy::Custom, Some(&custom)).unwrap()),
            ["Car", "Store", "Card", "Medical"]
        );
        assert!(order(&d, Strategy::Custom, Some(&["Nope".to_string()])).is_err());
    }

    #[test]
    fn single_debt_matches_hand_calculation() {
        let d = vec![Debt {
            name: "A".into(),
            balance: dec("1000"),
            apr_pct: dec("12"),
            min_payment: dec("100"),
        }];
        let s = simulate(&d, Strategy::Avalanche, dec("0"), None, ym("2026-01")).unwrap();
        // Month 1: interest 10.00, pay 100 → 910.00.
        assert_eq!(s.schedule[0].interest["A"], dec("10.00"));
        assert_eq!(s.schedule[0].balances["A"], dec("910.00"));
        assert!(s.paid_off);
        assert_eq!(s.months, 11);
        assert_eq!(s.total_paid - s.total_interest, dec("1000"));
        assert_eq!(s.debt_free(), Some(ym("2026-11")));
        assert!(s.schedule.iter().all(|r| r.balances["A"] >= Decimal::ZERO));
    }

    #[test]
    fn strategies_and_savings() {
        let d = debts();
        let start = ym("2026-01");
        let av = simulate(&d, Strategy::Avalanche, dec("200"), None, start).unwrap();
        let sb = simulate(&d, Strategy::Snowball, dec("200"), None, start).unwrap();
        let min = simulate(&d, Strategy::MinimumsOnly, dec("0"), None, start).unwrap();
        assert!(av.paid_off && sb.paid_off && min.paid_off);
        assert!(
            av.total_interest <= sb.total_interest,
            "avalanche minimises interest"
        );
        assert!(av.months < min.months);
        // Snowball pays the smallest first.
        assert!(sb.payoff_dates["Medical"] <= sb.payoff_dates["Store"]);
        // Total budget is constant for rollover strategies until the final month.
        let budget = dec("710");
        for r in &av.schedule[..av.schedule.len() - 1] {
            assert_eq!(
                r.payments.values().copied().sum::<Decimal>(),
                budget,
                "{}",
                r.month
            );
        }
        let resp = plan(&DebtPlanRequest {
            debts: d
                .iter()
                .map(|x| DebtInput {
                    name: x.name.clone(),
                    balance: x.balance.to_string(),
                    apr_pct: x.apr_pct.to_string(),
                    min_payment: x.min_payment.to_string(),
                })
                .collect(),
            strategy: Strategy::Snowball,
            extra_monthly: "200".into(),
            order: None,
            start_month: start,
        })
        .unwrap();
        assert_eq!(resp.strategies.len(), 4);
        let base = resp.strategies.last().unwrap();
        assert_eq!(base.strategy, "minimum");
        assert_eq!(base.months, min.months);
        assert_eq!(base.payoff_date, min.debt_free());
        assert_eq!(resp.schedule.len() as u32, sb.months);
        let a = &resp.strategies[0];
        assert_eq!(
            a.interest_saved_vs_min,
            min.total_interest - av.total_interest
        );
        let j = serde_json::to_value(&resp).unwrap();
        assert!(j["strategies"][0]["payoffDate"].is_string());
        assert!(j["schedule"][0]["balances"]["Card"].is_string());
    }

    #[test]
    fn never_pays_off_when_minimum_below_interest() {
        let d = vec![Debt {
            name: "X".into(),
            balance: dec("10000"),
            apr_pct: dec("30"),
            min_payment: dec("100"),
        }];
        let s = simulate(&d, Strategy::Avalanche, dec("0"), None, ym("2026-01")).unwrap();
        assert!(!s.paid_off);
        assert_eq!(s.months, MAX_MONTHS);
        assert_eq!(s.debt_free(), None);
    }

    #[test]
    fn validation() {
        let mut d = debts();
        d[1].name = "Card".into();
        assert!(simulate(&d, Strategy::Avalanche, dec("0"), None, ym("2026-01")).is_err());
        let d = vec![Debt {
            name: "X".into(),
            balance: dec("-1"),
            apr_pct: dec("1"),
            min_payment: dec("1"),
        }];
        assert!(simulate(&d, Strategy::Avalanche, dec("0"), None, ym("2026-01")).is_err());
        let s = simulate(&[], Strategy::Avalanche, dec("0"), None, ym("2026-01")).unwrap();
        assert!(s.paid_off && s.months == 0);
    }
}
