//! Seeded sample-data generators (§16.1 "Sample data"). Output is deterministic for a seed and a "today", tagged
//! `sample` when written, and removed again by `lifeapp_sample_data(off)`.
//!
//! The data is realistic enough that the dashboards fill and several advisor rules fire (an overspent category,
//! uncategorised imports, high card utilisation, a stale price, an overloaded day, a missed habit, …).

use chrono::{Datelike, Duration, NaiveDate};
use serde_json::{Map, Value, json};

use crate::lifeapps::build::ExtraRow;

/// Generator ids.
pub const GENERATORS: &[&str] = &[
    "money_hq",
    "portfolio",
    "tax_organizer",
    "spreadsheet_studio",
    "life_os",
    "habits",
];

/// Whether `id` is a known generator.
#[must_use]
pub fn known(id: &str) -> bool {
    GENERATORS.contains(&id)
}

/// SplitMix64.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// A generator for `seed`.
    #[must_use]
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    /// Next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[lo, hi)`, rounded to cents.
    pub fn amount(&mut self, lo: f64, hi: f64) -> f64 {
        let u = (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64;
        ((lo + u * (hi - lo)) * 100.0).round() / 100.0
    }

    /// Uniform integer in `[0, n)`.
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next_u64() % n }
    }
}

struct Rows(Vec<ExtraRow>);

impl Rows {
    fn add(&mut self, db: &str, key: &str, values: Value) {
        let values: Map<String, Value> = values.as_object().cloned().unwrap_or_default();
        self.0.push(ExtraRow {
            db: db.into(),
            key: format!("sample:{key}"),
            values,
        });
    }
}

fn day(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn month_start(d: NaiveDate) -> NaiveDate {
    d.with_day(1).unwrap_or(d)
}

fn months_back(d: NaiveDate, n: u32) -> NaiveDate {
    let mut m = month_start(d);
    for _ in 0..n {
        m = month_start(m - Duration::days(1));
    }
    m
}

/// Runs generator `id`.
#[must_use]
pub fn generate(id: &str, seed: u64, today: NaiveDate) -> Vec<ExtraRow> {
    let mut rng = Rng::new(seed);
    let mut r = Rows(Vec::new());
    match id {
        "money_hq" => money_hq(&mut r, &mut rng, today),
        "portfolio" => portfolio(&mut r, &mut rng, today),
        "tax_organizer" => tax(&mut r, today),
        "life_os" => life_os(&mut r, &mut rng, today),
        "habits" => habits(&mut r, &mut rng, today),
        _ => {}
    }
    r.0
}

fn money_hq(r: &mut Rows, rng: &mut Rng, today: NaiveDate) {
    r.add("accounts", "checking", json!({"name": "Everyday Checking", "type": "checking", "institution": "Sample Bank", "opening": 2400, "on_budget": true, "low_threshold": 500, "last_reconciled": day(today - Duration::days(45))}));
    r.add("accounts", "savings", json!({"name": "High-Yield Savings", "type": "savings", "institution": "Sample Bank", "opening": 3000, "on_budget": true}));
    r.add("accounts", "card", json!({"name": "Rewards Visa", "type": "credit_card", "institution": "Sample Card Co", "opening": 1850, "apr": 24.99, "min_payment": 55, "limit": 5000, "on_budget": true}));
    r.add("accounts", "student", json!({"name": "Student Loan", "type": "student_loan", "opening": 12400, "apr": 5.5, "min_payment": 140}));
    let mut n = 0;
    let mut txn = |r: &mut Rows,
                   date: NaiveDate,
                   desc: &str,
                   amount: f64,
                   account: &str,
                   category: Option<&str>| {
        n += 1;
        let mut v = json!({"desc": desc, "date": day(date), "amount": amount, "account": [format!("sample:{account}")], "cleared": "cleared", "source": "import"});
        if let Some(c) = category {
            v["category"] = json!([c]);
        }
        r.add("transactions", &format!("t{n}"), v);
    };
    for back in (0..4u32).rev() {
        let m = months_back(today, back);
        let last = if back == 0 {
            today
        } else {
            months_back(today, back - 1) - Duration::days(1)
        };
        let in_month = |d: u32| m.with_day(d).filter(|x| *x <= last);
        for d in [1u32, 15] {
            if let Some(x) = in_month(d) {
                txn(
                    r,
                    x,
                    "ACME CORP PAYROLL",
                    3200.0,
                    "checking",
                    Some("Paycheck"),
                );
            }
        }
        if let Some(x) = in_month(1) {
            txn(
                r,
                x,
                "Rent payment",
                -1500.0,
                "checking",
                Some("Rent / Mortgage"),
            );
        }
        if let Some(x) = in_month(3) {
            txn(
                r,
                x,
                "City Power & Water",
                -rng.amount(90.0, 140.0),
                "checking",
                Some("Utilities"),
            );
            // A transfer pair: both sides point at each other.
            let amt = 400.0 + f64::from(3 - back.min(3)) * 25.0;
            for (side, account, sign, other) in
                [("a", "savings", 1.0, "b"), ("b", "checking", -1.0, "a")]
            {
                r.add(
                    "transactions",
                    &format!("tr{back}{side}"),
                    json!({"desc": "Transfer to savings", "date": day(x), "amount": sign * amt, "account": [format!("sample:{account}")],
                           "transfer": [format!("sample:tr{back}{other}")], "cleared": "cleared", "source": "import"}),
                );
            }
        }
        if let Some(x) = in_month(5) {
            txn(r, x, "Mobile Co", -65.0, "checking", Some("Phone"));
            txn(
                r,
                x,
                "StreamFlix",
                -15.49,
                "checking",
                Some("Subscriptions"),
            );
        }
        for w in 0..4u32 {
            if let Some(x) = in_month(2 + w * 7) {
                let big = if back == 0 { 1.6 } else { 1.0 };
                txn(
                    r,
                    x,
                    "FreshMart",
                    -rng.amount(95.0, 130.0) * big,
                    "checking",
                    Some("Groceries"),
                );
            }
            if let Some(x) = in_month(4 + w * 7) {
                txn(
                    r,
                    x,
                    "Corner Bistro",
                    -rng.amount(30.0, 55.0),
                    "checking",
                    Some("Dining out"),
                );
            }
        }
    }
    // Fresh imports that still need a category, and an accidental double charge.
    for i in 0..12u32 {
        let d = today - Duration::days(i64::from(i % 5));
        txn(
            r,
            d,
            &format!("POS PURCHASE {}", 1000 + i),
            -rng.amount(4.0, 60.0),
            "checking",
            None,
        );
    }
    let dupe = today - Duration::days(1);
    txn(
        r,
        dupe,
        "Bean There Coffee",
        -4.75,
        "checking",
        Some("Coffee"),
    );
    txn(
        r,
        dupe,
        "Bean There Coffee",
        -4.75,
        "checking",
        Some("Coffee"),
    );
    let month = today.format("%Y-%m").to_string();
    for (cat, amt) in [
        ("Groceries", 400.0),
        ("Dining out", 210.0),
        ("Rent / Mortgage", 1500.0),
        ("Utilities", 140.0),
        ("Phone", 65.0),
        ("Subscriptions", 40.0),
    ] {
        r.add("budgets", &format!("b:{cat}"), json!({"name": format!("{month} · {cat}"), "month": month, "category": [cat], "assigned": amt}));
    }
    r.add("recurring", "rent", json!({"name": "Rent", "amount": 1500, "schedule": {"rrule": "FREQ=MONTHLY;BYMONTHDAY=1", "dtstart": day(months_back(today, 3))}, "kind": "bill", "account": ["sample:checking"], "autopay": true, "reminder_days": 3}));
    r.add("recurring", "pay", json!({"name": "Paycheck", "amount": 3200, "schedule": {"rrule": "FREQ=MONTHLY;BYMONTHDAY=1,15", "dtstart": day(months_back(today, 3))}, "kind": "income", "account": ["sample:checking"]}));
    r.add("recurring", "phone", json!({"name": "Mobile Co", "amount": 65, "schedule": {"rrule": "FREQ=MONTHLY;BYMONTHDAY=5", "dtstart": day(months_back(today, 3))}, "kind": "bill", "account": ["sample:checking"], "autopay": true}));
    r.add("subscriptions", "stream", json!({"service": "StreamFlix", "amount": 15.49, "cycle": "monthly", "next_charge": day(today + Duration::days(20)), "status": "active", "last_price_change": day(today - Duration::days(10)), "value_rating": 3}));
    r.add("subscriptions", "gym", json!({"service": "Pulse Gym", "amount": 39, "cycle": "monthly", "next_charge": day(today + Duration::days(7)), "status": "active", "value_rating": 2}));
    r.add("goals", "vacation", json!({"name": "Summer trip", "kind": "sinking", "target": 2400, "date": day(today + Duration::days(240)), "saved": 600, "priority": "medium"}));
    for back in 1..=3u32 {
        let m = months_back(today, back);
        r.add("networth", &format!("nw{back}"), json!({"month": m.format("%Y-%m").to_string(), "assets": 5200.0 + f64::from(3 - back) * 400.0, "liabilities": 14600.0 - f64::from(3 - back) * 200.0, "source": "backfill"}));
    }
}

fn portfolio(r: &mut Rows, rng: &mut Rng, today: NaiveDate) {
    r.add("inv_accounts", "brokerage", json!({"name": "Sample Brokerage", "broker": "Sample Broker", "type": "taxable", "tax_treatment": "taxable"}));
    r.add("inv_accounts", "roth", json!({"name": "Roth IRA", "broker": "Sample Broker", "type": "roth_ira", "tax_treatment": "free"}));
    let stale = day(today - Duration::days(5));
    for (k, name, class, er, price, pct) in [
        (
            "VTI",
            "Total US Stock Market ETF",
            "us_equity",
            0.03,
            281.4,
            0.006,
        ),
        (
            "VXUS",
            "Total International Stock ETF",
            "intl_developed",
            0.07,
            62.1,
            -0.002,
        ),
        ("BND", "Total Bond Market ETF", "bonds", 0.03, 72.3, 0.001),
        ("ARKK", "Innovation Fund", "us_equity", 0.75, 48.2, 0.021),
    ] {
        r.add("securities", k, json!({"ticker": k, "name": name, "class": class, "expense_ratio": er, "last_price": price, "day_pct": pct, "price_as_of": stale, "type": "etf"}));
    }
    let mut n = 0;
    let mut buy = |r: &mut Rows, d: NaiveDate, sec: &str, acct: &str, qty: f64, price: f64| {
        n += 1;
        r.add("inv_txns", &format!("i{n}"), json!({"name": format!("Buy {sec}"), "date": day(d), "type": "buy", "security": [format!("sample:{sec}")], "account": [format!("sample:{acct}")], "qty": qty, "price": price, "amount": (qty * price * 100.0).round() / 100.0, "fees": 0}));
    };
    for q in 0..8i64 {
        let d = today - Duration::days(730 - q * 90);
        buy(
            r,
            d,
            "VTI",
            "brokerage",
            6.0,
            220.0 + q as f64 * 7.0 + rng.amount(0.0, 5.0),
        );
        buy(r, d, "VXUS", "roth", 10.0, 55.0 + q as f64 * 0.8);
        buy(r, d, "BND", "roth", 4.0, 73.0 - q as f64 * 0.2);
    }
    buy(
        r,
        today - Duration::days(400),
        "ARKK",
        "brokerage",
        40.0,
        61.0,
    );
    for q in 1..=4i64 {
        r.add("dividends", &format!("d{q}"), json!({"name": "VTI dividend", "date": day(today - Duration::days(q * 91 - 30)), "security": ["sample:VTI"], "amount": 38.0 + q as f64}));
    }
}

fn tax(r: &mut Rows, today: NaiveDate) {
    r.add("documents", "w2-late", json!({"name": "W-2 (second employer)", "issuer": "Former Employer LLC", "for": "self", "expected_by": day(today - Duration::days(30)), "status": "expected"}));
    r.add("documents", "1099int", json!({"name": "1099-INT", "issuer": "Sample Bank", "for": "self", "expected_by": day(today - Duration::days(40)), "status": "received", "amount_summary": "Interest $212"}));
    r.add("deductions", "laptop", json!({"name": "Laptop for client work", "date": day(today - Duration::days(60)), "category": "business_expense", "amount": 1240, "pct": 100}));
    r.add("deductions", "charity", json!({"name": "Food bank donation", "date": day(today - Duration::days(20)), "category": "charitable", "amount": 300, "pct": 100}));
    r.add("deadlines", "property", json!({"name": "Property tax installment", "date": day(today + Duration::days(10)), "kind": "local"}));
    r.add("deadlines", "hsa", json!({"name": "Send HSA receipts to preparer", "date": day(today + Duration::days(2)), "kind": "personal"}));
}

fn life_os(r: &mut Rows, rng: &mut Rng, today: NaiveDate) {
    r.add("projects", "vacation", json!({"name": "Plan summer vacation", "status": "active", "outcome": "Flights and lodging booked", "deadline": day(today + Duration::days(60))}));
    r.add("projects", "garage", json!({"name": "Clean out the garage", "status": "active", "outcome": "Garage fits the car again"}));
    for i in 0..22u32 {
        r.add("tasks", &format!("inbox{i}"), json!({"title": format!("Captured idea #{}", i + 1), "status": "inbox", "source": "quick add"}));
    }
    for i in 0..6i64 {
        r.add("tasks", &format!("late{i}"), json!({"title": format!("Overdue errand {}", i + 1), "status": "next", "due": day(today - Duration::days(i + 1)), "estimate": 20}));
    }
    for (i, t) in [
        "Write project brief",
        "Review budget",
        "Call the plumber",
        "Draft newsletter",
        "Prepare slides",
    ]
    .iter()
    .enumerate()
    {
        r.add("tasks", &format!("today{i}"), json!({"title": t, "status": "scheduled", "scheduled": day(today), "estimate": 90 + rng.below(60), "project": ["sample:garage"]}));
    }
    r.add("tasks", "garage-next", json!({"title": "Buy storage bins", "status": "next", "project": ["sample:garage"], "estimate": 30}));
}

fn habits(r: &mut Rows, rng: &mut Rng, today: NaiveDate) {
    let start = today - Duration::days(40);
    r.add("habits", "walk", json!({"name": "Walk 8k steps", "type": "count", "schedule": "daily", "target": 8000, "unit": "steps", "two_minute": "Walk to the corner", "active": true, "started": day(start)}));
    r.add("habits", "read", json!({"name": "Read 20 minutes", "type": "duration", "schedule": "daily", "target": 20, "unit": "min", "two_minute": "Read one page", "active": true, "started": day(start)}));
    r.add("habits", "floss", json!({"name": "Floss", "type": "yes_no", "schedule": "daily", "active": true, "started": day(start)}));
    for back in 0..40i64 {
        let d = today - Duration::days(back);
        // Walk: done most days but not yesterday.
        if back != 1 && back != 0 && rng.below(10) < 8 {
            r.add("log", &format!("walk{back}"), json!({"name": "Walk", "date": day(d), "habit": ["sample:walk"], "status": "done", "value": 8000 + rng.below(3000)}));
        }
        // Read: about one day in five.
        if back % 5 == 2 {
            r.add("log", &format!("read{back}"), json!({"name": "Read", "date": day(d), "habit": ["sample:read"], "status": "done", "value": 20}));
        }
        // Floss: every day including today.
        r.add(
            "log",
            &format!("floss{back}"),
            json!({"name": "Floss", "date": day(d), "habit": ["sample:floss"], "status": "done"}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_known() {
        let t = NaiveDate::from_ymd_opt(2026, 11, 26).unwrap();
        for g in GENERATORS {
            assert!(known(g));
            let a = generate(g, 7, t);
            let b = generate(g, 7, t);
            assert_eq!(a.len(), b.len());
            for (x, y) in a.iter().zip(&b) {
                assert_eq!(x.key, y.key);
                assert_eq!(x.values, y.values);
            }
        }
        assert!(generate("money_hq", 1, t).len() > 40);
        assert!(generate("spreadsheet_studio", 1, t).is_empty());
    }
}
