//! Money HQ metrics (§15.5 Metrics) and report helpers for `finance_spending_breakdown` and
//! `finance_cashflow_sankey`.
//!
//! Transfers are always excluded. Outflows to categories flagged `is_saving` (investment contributions,
//! savings) count as saving, not spending. Uncategorised outflows count as spending.

use std::collections::{BTreeMap, HashMap};

use chrono::{Duration, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::ledger::{Category, Txn};
use crate::money::{median, to_f64};
use crate::payee::payee_key;
use crate::period::{YearMonth, add_months};

fn cat_map(categories: &[Category]) -> HashMap<&str, &Category> {
    categories.iter().map(|c| (c.id.as_str(), c)).collect()
}

/// Income and spending over an inclusive date range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeSpending {
    /// Income (income categories).
    pub income: Decimal,
    /// Net spending (non-income, non-saving).
    pub spending: Decimal,
    /// Net saving outflows (saving categories).
    pub saving: Decimal,
}

/// Sums income, spending and saving for `[from, to]`.
pub fn income_spending(
    txns: &[Txn],
    categories: &[Category],
    from: NaiveDate,
    to: NaiveDate,
) -> IncomeSpending {
    let cats = cat_map(categories);
    let mut r = IncomeSpending::default();
    for t in txns
        .iter()
        .filter(|t| t.counts() && !t.is_transfer() && t.date >= from && t.date <= to)
    {
        match t.category_id.as_deref().and_then(|c| cats.get(c)) {
            Some(c) if c.is_income => r.income += t.amount,
            Some(c) if c.is_saving => r.saving -= t.amount,
            _ => r.spending -= t.amount,
        }
    }
    r
}

/// `savings_rate = (income − spending) / income` for `[from, to]`; `None` without income.
pub fn savings_rate(
    txns: &[Txn],
    categories: &[Category],
    from: NaiveDate,
    to: NaiveDate,
) -> Option<f64> {
    let s = income_spending(txns, categories, from, to);
    (s.income > Decimal::ZERO).then(|| to_f64((s.income - s.spending) / s.income))
}

/// The window of [`savings_rate_3m`]: the trailing 3 calendar months ending `today`, inclusive.
#[must_use]
pub fn savings_window(today: NaiveDate) -> (NaiveDate, NaiveDate) {
    (add_months(today, -3) + Duration::days(1), today)
}

/// Savings rate over the trailing 3 months ending `today` ([`savings_window`]).
pub fn savings_rate_3m(txns: &[Txn], categories: &[Category], today: NaiveDate) -> Option<f64> {
    let (from, to) = savings_window(today);
    savings_rate(txns, categories, from, to)
}

/// Savings rate per calendar month for the `n` months ending with `today`'s month (oldest first).
pub fn savings_rate_by_month(
    txns: &[Txn],
    categories: &[Category],
    today: NaiveDate,
    n: u32,
) -> Vec<(YearMonth, Option<f64>)> {
    let cur = YearMonth::of(today);
    (0..n as i32)
        .rev()
        .map(|k| {
            let m = cur.plus_months(-k);
            (
                m,
                savings_rate(txns, categories, m.first_day(), m.last_day().min(today)),
            )
        })
        .collect()
}

/// Median of the three trailing 30-day sums of spending in `essential` categories (the trailing-90-day
/// median monthly essential spend).
pub fn essential_monthly_spend(txns: &[Txn], categories: &[Category], today: NaiveDate) -> Decimal {
    let cats = cat_map(categories);
    let mut sums = [Decimal::ZERO; 3];
    for t in txns.iter().filter(|t| t.counts() && !t.is_transfer()) {
        let age = (today - t.date).num_days();
        if !(0..90).contains(&age) {
            continue;
        }
        if t.category_id
            .as_deref()
            .and_then(|c| cats.get(c))
            .is_some_and(|c| c.essential && !c.is_income)
        {
            sums[(age / 30) as usize] -= t.amount;
        }
    }
    median(&sums).unwrap_or_default().max(Decimal::ZERO)
}

/// `ef_months = ef_balance / essential_monthly_spend` (`None` when essential spend is zero).
pub fn ef_months(ef_balance: Decimal, essential_monthly: Decimal) -> Option<f64> {
    (essential_monthly > Decimal::ZERO).then(|| to_f64(ef_balance / essential_monthly))
}

/// `utilization = card balance owed / limit`. Card balances are negative while owed.
pub fn utilization(balance: Decimal, limit: Decimal) -> Option<f64> {
    (limit > Decimal::ZERO).then(|| to_f64((-balance).max(Decimal::ZERO) / limit))
}

/// Breakdown dimension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BreakdownBy {
    /// By category.
    Category,
    /// By category group.
    Group,
    /// By normalised payee.
    Payee,
    /// By account.
    Account,
}

/// A breakdown row (IPC `finance_spending_breakdown`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownRow {
    /// Key (id or payee key).
    pub key: String,
    /// Label.
    pub label: String,
    /// Net spending.
    pub amount: Decimal,
    /// Share of total (0–1).
    pub pct: f64,
    /// Change vs the previous equal-length period (fraction), when it had spending.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_pct: Option<f64>,
}

fn spend_by(
    txns: &[Txn],
    cats: &HashMap<&str, &Category>,
    by: BreakdownBy,
    from: NaiveDate,
    to: NaiveDate,
) -> BTreeMap<String, (String, Decimal)> {
    let mut m: BTreeMap<String, (String, Decimal)> = BTreeMap::new();
    for t in txns
        .iter()
        .filter(|t| t.counts() && !t.is_transfer() && t.date >= from && t.date <= to)
    {
        let cat = t.category_id.as_deref().and_then(|c| cats.get(c));
        if cat.is_some_and(|c| c.is_income) {
            continue;
        }
        let (key, label) = match by {
            BreakdownBy::Category => cat
                .map_or(("uncategorized".into(), "Uncategorized".into()), |c| {
                    (c.id.clone(), c.name.clone())
                }),
            BreakdownBy::Group => cat
                .map_or(("uncategorized".into(), "Uncategorized".into()), |c| {
                    (c.group.clone(), c.group.clone())
                }),
            BreakdownBy::Payee => (payee_key(&t.payee), t.payee.clone()),
            BreakdownBy::Account => (t.account_id.clone(), t.account_id.clone()),
        };
        let e = m.entry(key).or_insert((label, Decimal::ZERO));
        e.1 -= t.amount;
    }
    m
}

/// Spending breakdown for `[from, to]`, largest first. Keys with zero or negative net spending are omitted.
pub fn spending_breakdown(
    txns: &[Txn],
    categories: &[Category],
    by: BreakdownBy,
    from: NaiveDate,
    to: NaiveDate,
) -> Vec<BreakdownRow> {
    let cats = cat_map(categories);
    let cur = spend_by(txns, &cats, by, from, to);
    let len = (to - from).num_days() + 1;
    let prev = spend_by(
        txns,
        &cats,
        by,
        from - Duration::days(len),
        from - Duration::days(1),
    );
    let total: Decimal = cur
        .values()
        .map(|v| v.1)
        .filter(|v| *v > Decimal::ZERO)
        .sum();
    let mut rows: Vec<BreakdownRow> = cur
        .into_iter()
        .filter(|(_, (_, a))| *a > Decimal::ZERO)
        .map(|(key, (label, amount))| {
            let delta_pct = prev
                .get(&key)
                .map(|p| p.1)
                .filter(|p| *p > Decimal::ZERO)
                .map(|p| to_f64((amount - p) / p));
            BreakdownRow {
                pct: if total.is_zero() {
                    0.0
                } else {
                    to_f64(amount / total)
                },
                key,
                label,
                amount,
                delta_pct,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.amount.cmp(&a.amount).then_with(|| a.key.cmp(&b.key)));
    rows
}

/// A Sankey node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyNode {
    /// Label.
    pub name: String,
}

/// A Sankey link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyLink {
    /// Source node index.
    pub source: usize,
    /// Target node index.
    pub target: usize,
    /// Value.
    pub value: f64,
}

/// Sankey data (`finance_cashflow_sankey`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sankey {
    /// Nodes.
    pub nodes: Vec<SankeyNode>,
    /// Links.
    pub links: Vec<SankeyLink>,
}

/// Income sources → groups (plus "Saved") → categories for `[from, to]`. If spending exceeds income a
/// "From savings" source balances the flow. Flows are conserved at every node.
pub fn cashflow_sankey(
    txns: &[Txn],
    categories: &[Category],
    from: NaiveDate,
    to: NaiveDate,
) -> Sankey {
    let cats = cat_map(categories);
    let mut sources: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut groups: BTreeMap<String, BTreeMap<String, Decimal>> = BTreeMap::new();
    for t in txns
        .iter()
        .filter(|t| t.counts() && !t.is_transfer() && t.date >= from && t.date <= to)
    {
        match t.category_id.as_deref().and_then(|c| cats.get(c)) {
            Some(c) if c.is_income => *sources.entry(c.name.clone()).or_default() += t.amount,
            Some(c) => {
                *groups
                    .entry(c.group.clone())
                    .or_default()
                    .entry(c.name.clone())
                    .or_default() -= t.amount
            }
            None => {
                *groups
                    .entry("Uncategorized".into())
                    .or_default()
                    .entry("Uncategorized".into())
                    .or_default() -= t.amount
            }
        }
    }
    sources.retain(|_, v| *v > Decimal::ZERO);
    for g in groups.values_mut() {
        g.retain(|_, v| *v > Decimal::ZERO);
    }
    groups.retain(|_, g| !g.is_empty());
    let income: Decimal = sources.values().sum();
    let group_tot: BTreeMap<String, Decimal> = groups
        .iter()
        .map(|(k, g)| (k.clone(), g.values().sum()))
        .collect();
    let spend: Decimal = group_tot.values().sum();
    if income.is_zero() && spend.is_zero() {
        return Sankey::default();
    }
    if spend > income {
        sources.insert("From savings".into(), spend - income);
    }
    let saved = (income - spend).max(Decimal::ZERO);
    let total = spend + saved;
    let mut s = Sankey::default();
    let node = |s: &mut Sankey, name: &str| {
        s.nodes.push(SankeyNode {
            name: name.to_string(),
        });
        s.nodes.len() - 1
    };
    let src_idx: Vec<(usize, Decimal)> =
        sources.iter().map(|(n, v)| (node(&mut s, n), *v)).collect();
    type Target<'a> = (usize, Decimal, Option<&'a BTreeMap<String, Decimal>>);
    let mut targets: Vec<Target<'_>> = groups
        .iter()
        .map(|(n, g)| (node(&mut s, n), group_tot[n], Some(g)))
        .collect();
    if saved > Decimal::ZERO {
        targets.push((node(&mut s, "Saved"), saved, None));
    }
    for &(si, sv) in &src_idx {
        for &(ti, tv, _) in &targets {
            let v = to_f64(sv * tv / total);
            if v > 0.0 {
                s.links.push(SankeyLink {
                    source: si,
                    target: ti,
                    value: v,
                });
            }
        }
    }
    for (gi, _, g) in targets {
        for (cname, v) in g.into_iter().flatten() {
            let ci = node(&mut s, cname);
            s.links.push(SankeyLink {
                source: gi,
                target: ci,
                value: to_f64(*v),
            });
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{dec, txn};

    fn cats() -> Vec<Category> {
        let c = |id: &str, group: &str, income: bool, essential: bool, saving: bool| Category {
            id: id.into(),
            name: id.into(),
            group: group.into(),
            is_income: income,
            essential,
            rollover: false,
            variable: true,
            is_saving: saving,
        };
        vec![
            c("salary", "Income", true, false, false),
            c("rent", "Needs", false, true, false),
            c("food", "Needs", false, true, false),
            c("fun", "Wants", false, false, false),
            c("invest", "Savings & Debt", false, false, true),
        ]
    }

    fn t(id: &str, date: &str, amt: &str, cat: Option<&str>) -> Txn {
        let mut x = txn(id, "chk", date, amt);
        x.category_id = cat.map(str::to_string);
        x.payee = format!("P{}", id.len());
        x
    }

    fn ledger() -> Vec<Txn> {
        let mut v = Vec::new();
        for m in 1..=3 {
            v.push(t(
                &format!("s{m}"),
                &format!("2026-0{m}-01"),
                "5000",
                Some("salary"),
            ));
            v.push(t(
                &format!("r{m}"),
                &format!("2026-0{m}-02"),
                "-1500",
                Some("rent"),
            ));
            v.push(t(
                &format!("f{m}"),
                &format!("2026-0{m}-10"),
                "-500",
                Some("food"),
            ));
            v.push(t(
                &format!("u{m}"),
                &format!("2026-0{m}-12"),
                "-250",
                Some("fun"),
            ));
            v.push(t(
                &format!("i{m}"),
                &format!("2026-0{m}-15"),
                "-1000",
                Some("invest"),
            ));
        }
        let mut tr = t("x", "2026-02-20", "-3000", None);
        tr.transfer_id = Some("y".into());
        v.push(tr);
        v.push(t("unc", "2026-03-20", "-250", None));
        v
    }

    #[test]
    fn savings_and_essentials() {
        let l = ledger();
        let c = cats();
        let r = savings_rate_3m(&l, &c, "2026-03-31".parse().unwrap()).unwrap();
        // income 15000, spending 3*2250 + 250 = 7000 → 0.5333
        assert!((r - 8000.0 / 15000.0).abs() < 1e-9, "{r}");
        let by_month = savings_rate_by_month(&l, &c, "2026-03-31".parse().unwrap(), 3);
        assert!((by_month[0].1.unwrap() - 0.55).abs() < 1e-9);
        assert_eq!(
            essential_monthly_spend(&l, &c, "2026-03-31".parse().unwrap()),
            dec("2000")
        );
        assert!((ef_months(dec("6000"), dec("2000")).unwrap() - 3.0).abs() < 1e-12);
        assert_eq!(ef_months(dec("1"), dec("0")), None);
        assert!((utilization(dec("-450"), dec("1500")).unwrap() - 0.3).abs() < 1e-12);
        assert_eq!(utilization(dec("20"), dec("1500")), Some(0.0));
    }

    #[test]
    fn breakdown_and_sankey() {
        let l = ledger();
        let c = cats();
        let rows = spending_breakdown(
            &l,
            &c,
            BreakdownBy::Group,
            "2026-03-01".parse().unwrap(),
            "2026-03-31".parse().unwrap(),
        );
        assert_eq!(rows[0].key, "Needs");
        assert_eq!(rows[0].amount, dec("2000"));
        assert!((rows.iter().map(|r| r.pct).sum::<f64>() - 1.0).abs() < 1e-9);
        let rows = spending_breakdown(
            &l,
            &c,
            BreakdownBy::Category,
            "2026-03-01".parse().unwrap(),
            "2026-03-31".parse().unwrap(),
        );
        assert_eq!(
            rows.iter().find(|r| r.key == "rent").unwrap().delta_pct,
            Some(0.0)
        );
        let s = cashflow_sankey(
            &l,
            &c,
            "2026-03-01".parse().unwrap(),
            "2026-03-31".parse().unwrap(),
        );
        // Conservation: inflow to each node equals its outflow (except sources/leaves).
        for (i, n) in s.nodes.iter().enumerate() {
            let inflow: f64 = s
                .links
                .iter()
                .filter(|l| l.target == i)
                .map(|l| l.value)
                .sum();
            let outflow: f64 = s
                .links
                .iter()
                .filter(|l| l.source == i)
                .map(|l| l.value)
                .sum();
            if inflow > 0.0 && outflow > 0.0 {
                assert!((inflow - outflow).abs() < 1e-6, "{}", n.name);
            }
        }
        assert!(s.nodes.iter().any(|n| n.name == "Saved"));
        let empty = cashflow_sankey(
            &[],
            &c,
            "2026-03-01".parse().unwrap(),
            "2026-03-31".parse().unwrap(),
        );
        assert!(empty.nodes.is_empty());
    }
}
