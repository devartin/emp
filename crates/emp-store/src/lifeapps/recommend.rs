//! Wizard recommenders (`Step.recommend`, `lifeapp_recommend`). Pure functions of the answers so far.
//!
//! Every recommendation carries a short rationale ("Why?" chip) and its source, in the plain v3 register (no
//! "common guideline" / "consider" hedges; the TS mirror is `src/features/lifeapps/engine/plan.ts`).

use chrono::{Datelike, NaiveDate};
use serde::Serialize;
use serde_json::{Map, Value, json};

/// A recommendation.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Recommendation {
    /// Recommended answer.
    pub value: Value,
    /// Rationale.
    pub why: String,
    /// Source ("Your answers", "3–6 months of essential expenses", …).
    pub source: String,
}

fn rec(value: Value, why: &str, source: &str) -> Recommendation {
    Recommendation {
        value,
        why: why.to_owned(),
        source: source.to_owned(),
    }
}

/// Recommender ids.
pub const RECOMMENDERS: &[&str] = &[
    "recommend_budget_method",
    "recommend_ef_months",
    "recommend_debt_strategy",
    "recommend_tax_year",
    "recommend_risk_range",
    "recommend_targets",
    "recommend_rebalance",
    "recommend_grace",
    "recommend_lifeos_style",
];

/// Whether `id` is a known recommender.
#[must_use]
pub fn known(id: &str) -> bool {
    RECOMMENDERS.contains(&id)
}

fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn s(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or_default()
}

/// Monthly factor of a pay frequency.
#[must_use]
pub fn per_month(freq: &str) -> f64 {
    match freq {
        "weekly" => 52.0 / 12.0,
        "biweekly" => 26.0 / 12.0,
        "semimonthly" => 2.0,
        "quarterly" => 1.0 / 3.0,
        "yearly" | "annual" => 1.0 / 12.0,
        _ => 1.0,
    }
}

/// Monthly income from the Money HQ `income` answer (`{items:[{amount, frequency}], stability}` or a list).
#[must_use]
pub fn monthly_income(answers: &Map<String, Value>) -> f64 {
    let items = match answers.get("income") {
        Some(Value::Object(o)) => o
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    items
        .iter()
        .map(|i| num(i.get("amount")) * per_month(s(i.get("frequency"))))
        .sum()
}

/// Monthly bills from the Money HQ `bills` answer.
#[must_use]
pub fn monthly_bills(answers: &Map<String, Value>) -> f64 {
    answers
        .get("bills")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|b| {
                    let f = s(b.get("frequency"));
                    num(b.get("amount")) * if f.is_empty() { 1.0 } else { per_month(f) }
                })
                .sum()
        })
        .unwrap_or(0.0)
}

fn stability(answers: &Map<String, Value>) -> &str {
    match answers.get("income") {
        Some(Value::Object(o)) => s(o.get("stability")),
        _ => "",
    }
}

const DEBT_TYPES: &[&str] = &[
    "credit_card",
    "student_loan",
    "auto_loan",
    "mortgage",
    "personal_loan",
    "other_liability",
];

fn max_debt_apr(answers: &Map<String, Value>) -> Option<f64> {
    answers
        .get("accounts")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .filter(|x| DEBT_TYPES.contains(&s(x.get("type"))))
                .map(|x| num(x.get("apr")))
                .reduce(f64::max)
        })
}

fn recommend_budget_method(a: &Map<String, Value>) -> Recommendation {
    let income = monthly_income(a);
    let bills = monthly_bills(a);
    let stab = stability(a);
    if stab == "irregular" || stab == "variable" {
        return rec(
            json!("zero_based"),
            "Your income varies, so each dollar is assigned as it arrives, with last month's income as a buffer.",
            "Irregular income",
        );
    }
    if max_debt_apr(a).is_some_and(|apr| apr >= 10.0) {
        return rec(
            json!("zero_based"),
            "You carry high-interest debt. Assigning every dollar makes room for extra payments.",
            "Debt above about 10% APR",
        );
    }
    if income > 0.0 && bills / income >= 0.8 {
        return rec(
            json!("zero_based"),
            "Fixed bills take most of your income, so a zero-based plan shows where every dollar goes.",
            "Your answers",
        );
    }
    if income > 0.0 && (income - bills) / income >= 0.5 && stab == "stable" {
        return rec(
            json!("pay_yourself_first"),
            "Stable income with room after bills: savings move out on payday and the rest is free to spend.",
            "Savings rate of 20% or more",
        );
    }
    rec(
        json!("fifty_thirty_twenty"),
        "Stable income and no high-interest debt: three buckets are easy to keep up with.",
        "50% needs, 30% wants, 20% savings",
    )
}

fn recommend_ef_months(a: &Map<String, Value>) -> Recommendation {
    let household = a.get("household");
    let dependents = household.map(|h| num(h.get("dependents"))).unwrap_or(0.0);
    let partner = household.is_some_and(|h| s(h.get("mode")).starts_with("partner"));
    let stab = stability(a);
    let self_employed = a
        .get("income")
        .and_then(|i| i.get("items"))
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|x| s(x.get("frequency")) == "irregular"));
    let (months, why, source) = if stab == "irregular" || stab == "variable" || self_employed {
        (
            9,
            "Irregular or self-employed income needs a deeper cushion.",
            "9–12 months of essential expenses",
        )
    } else if partner && dependents == 0.0 {
        (
            3,
            "Two stable incomes and no dependents: a shorter cushion is usually enough.",
            "3–6 months of essential expenses",
        )
    } else {
        (
            6,
            "One income or dependents relying on you: six months gives more room.",
            "3–6 months of essential expenses",
        )
    };
    // Starter fund: about one month of essential bills, at least the common $1,000 minimum.
    let starter = monthly_bills(a).round().max(1000.0);
    rec(json!({ "months": months, "starter": starter }), why, source)
}

fn recommend_debt_strategy(_a: &Map<String, Value>) -> Recommendation {
    rec(
        json!({ "strategy": "avalanche", "extra": 100 }),
        "Paying the highest APR first minimises total interest. Snowball (smallest balance first) clears the first debt sooner.",
        "Debt avalanche",
    )
}

fn recommend_tax_year(_a: &Map<String, Value>, today: NaiveDate) -> Recommendation {
    let before_deadline = today.month() < 4 || (today.month() == 4 && today.day() < 16);
    let year = if before_deadline {
        today.year() - 1
    } else {
        today.year()
    };
    rec(
        json!({ "country": "US", "year": year, "residency": "resident" }),
        if before_deadline {
            "Before April 16 most people are still preparing last year's return."
        } else {
            "After the April deadline, organise the current tax year."
        },
        "Filing calendar",
    )
}

fn risk_score(a: &Map<String, Value>) -> i32 {
    let r = a.get("risk");
    let horizon = r.map(|x| s(x.get("horizon"))).unwrap_or_default();
    let drop = r.map(|x| s(x.get("drop"))).unwrap_or_default();
    let stable = r.map(|x| s(x.get("income"))).unwrap_or_default();
    let mut score = 0;
    score += match horizon {
        "lt3" => -2,
        "gt10" => 2,
        _ => 0,
    };
    score += match drop {
        "sell" => -2,
        "buy" => 1,
        _ => 0,
    };
    score += match stable {
        "unstable" => -1,
        "stable" => 1,
        _ => 0,
    };
    score
}

fn recommend_risk_range(a: &Map<String, Value>) -> Recommendation {
    let score = risk_score(a);
    let (lo, hi) = match score {
        i32::MIN..=-3 => (10, 30),
        -2..=-1 => (30, 50),
        0..=1 => (50, 70),
        2..=3 => (70, 90),
        _ => (80, 100),
    };
    rec(
        json!({ "stocksMin": lo, "stocksMax": hi }),
        "An educational stock/bond range from your horizon, how you would react to a 30% drop and your income stability. Not a recommendation.",
        "Education",
    )
}

fn recommend_targets(a: &Map<String, Value>) -> Recommendation {
    let score = risk_score(a);
    let preset = if score >= 4 {
        "all_equity"
    } else if score >= 1 {
        "three_fund"
    } else {
        "sixty_forty"
    };
    rec(
        json!({ "preset": preset }),
        "An example starting point matched to your risk answers, not a recommendation. Targets must sum to 100%.",
        "Example starting point",
    )
}

fn recommend_rebalance(_a: &Map<String, Value>) -> Recommendation {
    rec(
        json!({ "mode": "hybrid", "calendar": "annual", "bandAbs": 5, "bandRel": 25, "cashFlowFirst": true, "avoidTaxableSells": true, "minTrade": 50 }),
        "Check on a schedule; trade only when a class drifts outside its band (5 percentage points or 25% of its target). New contributions go to underweight classes first.",
        "5/25 bands",
    )
}

fn recommend_grace(_a: &Map<String, Value>) -> Recommendation {
    rec(
        json!("never_miss_twice"),
        "Missing once is normal; missing twice starts a new pattern. Streaks forgive one miss without losing their meaning.",
        "Habit research",
    )
}

fn recommend_lifeos_style(a: &Map<String, Value>) -> Recommendation {
    let areas = a.get("areas").and_then(Value::as_array).map_or(0, Vec::len);
    if areas >= 6 {
        rec(
            json!("gtd"),
            "With many areas of responsibility, GTD's inbox, next actions and weekly review keep everything current.",
            "Your answers",
        )
    } else {
        rec(
            json!("simple"),
            "Inbox and next tasks only; projects and contexts can be added later.",
            "Your answers",
        )
    }
}

/// Runs recommender `id` over `answers`.
#[must_use]
pub fn run(id: &str, answers: &Map<String, Value>, today: NaiveDate) -> Option<Recommendation> {
    Some(match id {
        "recommend_budget_method" => recommend_budget_method(answers),
        "recommend_ef_months" => recommend_ef_months(answers),
        "recommend_debt_strategy" => recommend_debt_strategy(answers),
        "recommend_tax_year" => recommend_tax_year(answers, today),
        "recommend_risk_range" => recommend_risk_range(answers),
        "recommend_targets" => recommend_targets(answers),
        "recommend_rebalance" => recommend_rebalance(answers),
        "recommend_grace" => recommend_grace(answers),
        "recommend_lifeos_style" => recommend_lifeos_style(answers),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }
    fn d(y: i32, m: u32, dd: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, dd).unwrap()
    }

    #[test]
    fn budget_method_rules() {
        let t = d(2026, 11, 26);
        let irregular = a(
            json!({"income": {"items": [{"amount": 3000, "frequency": "monthly"}], "stability": "irregular"}}),
        );
        assert_eq!(
            run("recommend_budget_method", &irregular, t).unwrap().value,
            json!("zero_based")
        );
        let debt = a(
            json!({"income": {"items": [{"amount": 3000, "frequency": "monthly"}], "stability": "stable"},
            "accounts": [{"type": "credit_card", "apr": 24.9}]}),
        );
        assert_eq!(
            run("recommend_budget_method", &debt, t).unwrap().value,
            json!("zero_based")
        );
        let rich = a(
            json!({"income": {"items": [{"amount": 4000, "frequency": "biweekly"}], "stability": "stable"},
            "bills": [{"amount": 2000}]}),
        );
        assert_eq!(
            run("recommend_budget_method", &rich, t).unwrap().value,
            json!("pay_yourself_first")
        );
        let plain = a(
            json!({"income": {"items": [{"amount": 3000, "frequency": "monthly"}], "stability": "stable"},
            "bills": [{"amount": 2000}]}),
        );
        assert_eq!(
            run("recommend_budget_method", &plain, t).unwrap().value,
            json!("fifty_thirty_twenty")
        );
    }

    #[test]
    fn emergency_and_tax_year() {
        let t = d(2026, 3, 1);
        let dual = a(
            json!({"household": {"mode": "partner_joint", "dependents": 0}, "income": {"stability": "stable"}}),
        );
        assert_eq!(
            run("recommend_ef_months", &dual, t).unwrap().value["months"],
            json!(3)
        );
        let kids = a(
            json!({"household": {"mode": "single", "dependents": 2}, "income": {"stability": "stable"}}),
        );
        assert_eq!(
            run("recommend_ef_months", &kids, t).unwrap().value["months"],
            json!(6)
        );
        let irr = a(json!({"income": {"stability": "irregular"}}));
        assert_eq!(
            run("recommend_ef_months", &irr, t).unwrap().value["months"],
            json!(9)
        );
        assert_eq!(
            run("recommend_tax_year", &Map::new(), d(2026, 4, 15))
                .unwrap()
                .value["year"],
            json!(2025)
        );
        assert_eq!(
            run("recommend_tax_year", &Map::new(), d(2026, 4, 16))
                .unwrap()
                .value["year"],
            json!(2026)
        );
        assert!(run("nope", &Map::new(), t).is_none());
        for r in RECOMMENDERS {
            assert!(run(r, &Map::new(), t).is_some());
        }
    }
}
