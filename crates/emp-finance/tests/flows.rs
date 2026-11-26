//! Cross-module flows mirroring how the life apps use the engine (Money HQ, Portfolio, Tax Organizer).

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Duration, NaiveDate};
use emp_finance::budget::{
    Assignment, BudgetConfig, BudgetInput, BudgetMethod, compute, on_track, pace,
};
use emp_finance::calendar::HolidayCalendar;
use emp_finance::forecast::{
    ForecastAccount, ForecastInput, Frequency, RecurringItem, Schedule, cashflow,
};
use emp_finance::fx::FxRates;
use emp_finance::ledger::{Account, AccountType, Category, Txn};
use emp_finance::portfolio::alloc::{Target, allocation, max_drift};
use emp_finance::portfolio::holdings::{PriceQuote, SecurityInfo, value};
use emp_finance::portfolio::lots::{RebuildOptions, rebuild};
use emp_finance::portfolio::perf::{contributions, portfolio_xirr};
use emp_finance::portfolio::rebalance::{RebalanceOptions, RebalancePosition, plan};
use emp_finance::portfolio::{CostMethod, InvTxn, InvTxnType, TaxTreatment};
use emp_finance::recurring::{RecurringTxn, detect};
use emp_finance::tax::deadlines::{deadlines, irs_calendar, next_deadline};
use emp_finance::tax::documents::expected_documents;
use emp_finance::tax::estimated::{QuarterlyMethod, QuarterlyRequest};
use emp_finance::{Currency, Decimal, metrics, networth, tax};

fn d(s: &str) -> Decimal {
    s.parse().unwrap()
}

fn day(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn txn(
    id: usize,
    acct: &str,
    date: NaiveDate,
    amount: &str,
    cat: Option<&str>,
    payee: &str,
) -> Txn {
    Txn {
        id: format!("t{id}"),
        account_id: acct.into(),
        date,
        amount: d(amount),
        payee: payee.into(),
        raw: payee.into(),
        memo: String::new(),
        category_id: cat.map(str::to_string),
        transfer_id: None,
        import_id: None,
        split_parent: None,
        has_splits: false,
    }
}

fn cat(id: &str, group: &str, income: bool, essential: bool) -> Category {
    Category {
        id: id.into(),
        name: id.into(),
        group: group.into(),
        is_income: income,
        essential,
        rollover: false,
        variable: !essential,
        is_saving: false,
    }
}

#[test]
fn money_hq_month() {
    let usd = Currency::new("USD").unwrap();
    let cats = vec![
        cat("salary", "Income", true, false),
        cat("rent", "Needs", false, true),
        cat("groceries", "Needs", false, true),
        cat("dining", "Wants", false, false),
    ];
    let mut txns = Vec::new();
    let mut n = 0;
    for m in 1..=6u32 {
        let first = NaiveDate::from_ymd_opt(2026, m, 1).unwrap();
        for (off, amt, c, p) in [
            (0, "4200", "salary", "Acme Payroll"),
            (1, "-1600", "rent", "Riverside Apts"),
            (5, "-120.40", "groceries", "Grocer"),
            (9, "-45", "dining", "Bistro"),
            (14, "-15.49", "dining", "Netflix.com"),
        ] {
            n += 1;
            txns.push(txn(n, "chk", first + Duration::days(off), amt, Some(c), p));
        }
    }
    let cfg = BudgetConfig {
        method: BudgetMethod::ZeroBased,
        month_start_day: 1,
        income_buffer: false,
        savings_target_pct: None,
    };
    let asg: Vec<Assignment> = ["rent", "groceries", "dining"]
        .iter()
        .zip(["1600", "300", "100"])
        .map(|(c, a)| Assignment {
            month: "2026-06".parse().unwrap(),
            category_id: c.to_string(),
            amount: d(a),
        })
        .collect();
    let months = compute(
        &BudgetInput {
            config: &cfg,
            categories: &cats,
            txns: &txns,
            assignments: &asg,
        },
        "2026-06".parse().unwrap(),
        "2026-06".parse().unwrap(),
    )
    .unwrap();
    let june = &months[0];
    assert_eq!(june.to_be_assigned, Some(d("2200")));
    let dining = june.category("dining").unwrap();
    assert!(on_track(
        dining.spent(),
        dining.assigned,
        pace(&june.period, day("2026-06-20"))
    ));

    let today = day("2026-06-30");
    let rate = metrics::savings_rate_3m(&txns, &cats, today).unwrap();
    assert!(rate > 0.4 && rate < 0.6, "{rate}");
    assert_eq!(
        metrics::essential_monthly_spend(&txns, &cats, today),
        d("1720.40")
    );

    let accts = vec![Account {
        id: "chk".into(),
        name: "Checking".into(),
        kind: AccountType::Checking,
        currency: usd.clone(),
        opening_balance: d("1000"),
        opening_date: Some(day("2026-01-01")),
        apr_pct: None,
        min_payment: None,
        credit_limit: None,
        on_budget: true,
        low_threshold: Some(d("500")),
        closed: false,
    }];
    let snaps = networth::backfill_from_transactions(
        &accts,
        &txns,
        "2026-01".parse().unwrap(),
        "2026-06".parse().unwrap(),
        today,
        &usd,
        &FxRates::new(),
        &|_| None,
    );
    assert_eq!(snaps.len(), 6);
    assert!(snaps.windows(2).all(|w| w[1].net_worth > w[0].net_worth));

    let rec_in: Vec<RecurringTxn> = txns
        .iter()
        .map(|t| RecurringTxn {
            id: t.id.clone(),
            date: t.date,
            amount: t.amount,
            payee: t.payee.clone(),
        })
        .collect();
    let found = detect(
        &rec_in,
        &HolidayCalendar::us_federal(2026..=2026),
        Some(today),
    );
    let payees: HashSet<&str> = found.iter().map(|c| c.payee.as_str()).collect();
    assert!(
        payees.contains("Acme Payroll")
            && payees.contains("Netflix.com")
            && payees.contains("Riverside Apts")
    );
    let rec_ids: HashSet<String> = found.iter().flat_map(|c| c.row_ids.clone()).collect();

    let recurring: Vec<RecurringItem> = found
        .iter()
        .map(|c| RecurringItem {
            name: c.payee.clone(),
            amount: c.amount,
            account_id: "chk".into(),
            schedule: Schedule::Every {
                freq: Frequency::Monthly,
                interval: 1,
                anchor: c.next_due,
                until: None,
            },
        })
        .collect();
    let bal = emp_finance::ledger::balance_as_of(&accts[0], &txns, today);
    let fc = cashflow(&ForecastInput {
        today,
        horizon_days: 90,
        accounts: &[ForecastAccount {
            id: "chk".into(),
            balance: bal,
            low_threshold: Some(d("500")),
        }],
        spending_account: None,
        recurring: &recurring,
        history: &txns,
        categories: &cats,
        recurring_txn_ids: &rec_ids,
        band: true,
        seed: emp_finance::rng::seed_from(&["vault", "2026-06"]),
        simulations: 1000,
    })
    .unwrap();
    assert_eq!(fc.t.len(), 90);
    assert!(fc.breaches.is_empty());
    assert!(fc.p10.as_ref().unwrap()[89] <= fc.p90.as_ref().unwrap()[89]);
}

#[test]
fn portfolio_flow() {
    use InvTxnType::*;
    let mk = |id: &str, date: &str, kind, acct: &str, sec: &str, qty: &str, price: &str| InvTxn {
        id: id.into(),
        date: day(date),
        kind,
        account_id: acct.into(),
        security: sec.into(),
        qty: Some(d(qty)),
        price: Some(d(price)),
        amount: None,
        fees: Decimal::ZERO,
        ratio: None,
        acquired: None,
        basis: None,
    };
    let txns = vec![
        mk("1", "2024-01-02", Buy, "brk", "VTI", "40", "230"),
        mk("2", "2024-01-02", Buy, "ira", "BND", "50", "72"),
        mk("3", "2025-01-02", Buy, "brk", "VXUS", "60", "58"),
        mk("4", "2026-02-02", Sell, "brk", "VTI", "5", "300"),
    ];
    let book = rebuild(
        &txns,
        &RebuildOptions {
            default_method: CostMethod::Fifo,
            methods: HashMap::new(),
            long_term_days: 365,
        },
    );
    assert_eq!(book.realized_totals(2026).1, d("350"));
    let today = day("2026-11-20");
    let prices: HashMap<String, PriceQuote> = [("VTI", "320"), ("BND", "73"), ("VXUS", "66")]
        .iter()
        .map(|(s, p)| {
            (
                s.to_string(),
                PriceQuote {
                    price: d(p),
                    prev_close: None,
                    as_of: today,
                },
            )
        })
        .collect();
    let secs: HashMap<String, SecurityInfo> = [
        ("VTI", "US equity"),
        ("BND", "Bonds"),
        ("VXUS", "Intl developed"),
    ]
    .iter()
    .map(|(s, c)| {
        (
            s.to_string(),
            SecurityInfo {
                symbol: s.to_string(),
                name: s.to_string(),
                asset_class: c.to_string(),
                expense_ratio: Some(d("0.0005")),
            },
        )
    })
    .collect();
    let v = value(&book, &prices, &secs, today);
    assert_eq!(v.total_value, d("18810")); // 35×320 + 50×73 + 60×66
    let mut by_class: BTreeMap<String, Decimal> = BTreeMap::new();
    for h in &v.holdings {
        *by_class.entry(h.asset_class.clone()).or_default() += h.value;
    }
    let targets = vec![
        Target {
            asset_class: "US equity".into(),
            target: 50.0,
            band_abs: None,
            band_rel: None,
        },
        Target {
            asset_class: "Intl developed".into(),
            target: 20.0,
            band_abs: None,
            band_rel: None,
        },
        Target {
            asset_class: "Bonds".into(),
            target: 30.0,
            band_abs: None,
            band_rel: None,
        },
    ];
    let rows = allocation(&by_class, &targets);
    assert!(max_drift(&rows) > 5.0);
    let positions: Vec<RebalancePosition> = book
        .positions()
        .into_iter()
        .map(|((acct, sym), qty)| RebalancePosition {
            asset_class: secs[&sym].asset_class.clone(),
            price: prices[&sym].price,
            lots: book
                .lots
                .iter()
                .filter(|l| l.account_id == acct && l.security == sym)
                .cloned()
                .collect(),
            account_id: acct,
            symbol: sym,
            qty,
        })
        .collect();
    let treatment: HashMap<String, TaxTreatment> = [
        ("brk".to_string(), TaxTreatment::Taxable),
        ("ira".to_string(), TaxTreatment::Deferred),
    ]
    .into();
    let p = plan(
        &positions,
        &treatment,
        &targets,
        &RebalanceOptions {
            new_cash: d("2000"),
            cash_account: Some("brk".into()),
            allow_taxable_sells: false,
            min_trade: d("50"),
            fractional: false,
            class_proxies: BTreeMap::new(),
            proxy_prices: BTreeMap::new(),
        },
    )
    .unwrap();
    assert!(!p.trades.is_empty());
    assert!(p.trades.iter().all(|t| t.amount >= d("50")));
    let x = portfolio_xirr(
        &contributions(&txns),
        None,
        emp_finance::money::to_f64(v.total_value),
        today,
    )
    .unwrap();
    assert!(x > 0.05 && x < 0.5, "{x}");
}

#[test]
fn tax_organizer_flow() {
    let us = tax::builtin("us-federal-2026").unwrap();
    let input: tax::TaxInput = serde_json::from_value(serde_json::json!({
        "packId":"us-federal-2026","year":2026,"filingStatus":"mfj","dependents":1,"age65OrBlind":0,
        "incomes":[{"kind":"wages","amount":"120000","source":"Money HQ · Salary"},{"kind":"self_employment","amount":"30000"},
                   {"kind":"qualified_dividends","amount":"2000"},{"kind":"ltcg","amount":"5000"}],
        "adjustments":[{"kind":"hsa","amount":"4000"}],"deductions":"standard","credits":[],"withheld":"14000","estimatedPaid":"0"}))
    .unwrap();
    let today = day("2026-05-01");
    let est = tax::estimate(&us, &input, today).unwrap();
    assert!(est.se_tax > Decimal::ZERO);
    assert_eq!(est.preferential_tax, d("1050")); // 7,000 stacked above the 98,900 0% band
    assert!(est.balance > Decimal::ZERO);
    assert!(est.lines.iter().any(|l| l.label == "Estimated balance due"));
    let cal = irs_calendar(2026);
    let q = tax::estimated::plan(
        &us,
        &QuarterlyRequest {
            pack_id: us.id.clone(),
            year: 2026,
            method: QuarterlyMethod::EvenSplit,
            estimate: est.clone(),
            prior_year_tax: None,
            prior_year_agi: None,
            paid: vec![],
        },
        today,
        &cal,
    )
    .unwrap();
    // Q1 has passed: the balance is spread over Q2–Q4.
    assert_eq!(
        q.due
            .iter()
            .filter(|p| p.suggested > Decimal::ZERO && p.date >= today)
            .count(),
        3
    );
    let items = deadlines(&us, &cal);
    assert_eq!(
        next_deadline(&items, today).unwrap().name,
        "Q2 estimated payment"
    );
    let docs = expected_documents(
        &us,
        &[
            "income:employment".to_string(),
            "income:self_employment".to_string(),
        ],
    );
    assert_eq!(
        docs.iter().map(|d| d.doc.as_str()).collect::<Vec<_>>(),
        ["W-2", "1099-NEC", "1099-K"]
    );
    let json = serde_json::to_value(&est).unwrap();
    for key in [
        "gross",
        "agi",
        "deduction",
        "taxable",
        "ordinaryTax",
        "preferentialTax",
        "seTax",
        "niit",
        "credits",
        "totalTax",
        "brackets",
        "effectiveRate",
        "marginalRate",
        "balance",
        "lines",
        "packVersion",
        "verifiedOn",
        "stale",
        "disclaimer",
    ] {
        assert!(json.get(key).is_some(), "missing {key}");
    }
}
