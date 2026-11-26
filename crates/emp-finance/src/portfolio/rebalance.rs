//! Rebalance planner (§15.7 `rebalance::plan`). EMP never places trades; this proposes them.
//!
//! Steps, in order:
//! 1. New cash goes to the most underweight classes, in proportion to their deficit (any excess beyond the
//!    total deficit is spread by target weight).
//! 2. If any class is still outside its band, trade inside tax-advantaged accounts (sell overweight, buy
//!    underweight in the same account).
//! 3. Only if `allow_taxable_sells`: sell taxable lots, losses first and then the highest basis.
//! 4. Every trade respects `min_trade`, and whole-share rounding unless `fractional`.

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::TaxTreatment;
use super::alloc::{Target, outside_band, validate_targets};
use super::lots::Lot;
use crate::error::{FinanceError, Result};
use crate::money::{normalize, to_f64};

/// A position available to the planner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebalancePosition {
    /// Account.
    pub account_id: String,
    /// Symbol.
    pub symbol: String,
    /// Asset class.
    pub asset_class: String,
    /// Quantity.
    pub qty: Decimal,
    /// Current price.
    pub price: Decimal,
    /// Open lots (taxable accounts; used for lot selection and gain estimates).
    #[serde(default)]
    pub lots: Vec<Lot>,
}

/// Planner options (IPC `portfolio_rebalance_plan` plus context the app resolves).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebalanceOptions {
    /// New cash to invest.
    pub new_cash: Decimal,
    /// Account receiving new cash (required when `new_cash > 0`).
    #[serde(default)]
    pub cash_account: Option<String>,
    /// Allow selling in taxable accounts.
    pub allow_taxable_sells: bool,
    /// Minimum trade amount.
    pub min_trade: Decimal,
    /// Allow fractional shares.
    pub fractional: bool,
    /// Preferred symbol to buy per class.
    #[serde(default)]
    pub class_proxies: BTreeMap<String, String>,
    /// Prices for proxies not currently held.
    #[serde(default)]
    pub proxy_prices: BTreeMap<String, Decimal>,
}

/// Trade side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// Buy.
    Buy,
    /// Sell.
    Sell,
}

/// A proposed trade.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    /// Account.
    pub account_id: String,
    /// Symbol.
    pub symbol: String,
    /// Side.
    pub side: Side,
    /// Quantity.
    pub qty: Decimal,
    /// Amount.
    pub amount: Decimal,
    /// Estimated realised gain (taxable sells).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub est_realized_gain: Option<Decimal>,
}

/// Class weight after the plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterRow {
    /// Asset class.
    pub asset_class: String,
    /// Percent after trades.
    pub pct: f64,
}

/// The plan (IPC `portfolio_rebalance_plan` response plus diagnostics).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebalancePlan {
    /// Trades.
    pub trades: Vec<Trade>,
    /// Allocation after trades.
    pub after: Vec<AfterRow>,
    /// Total estimated realised gain.
    pub est_realized_gain: Decimal,
    /// Classes still outside their band.
    pub still_outside: Vec<String>,
    /// Uninvested cash left over.
    pub cash_left: Decimal,
    /// Notes (missing proxies, etc.).
    pub notes: Vec<String>,
}

struct State<'a> {
    pos: Vec<RebalancePosition>,
    treatment: &'a HashMap<String, TaxTreatment>,
    targets: &'a [Target],
    opts: &'a RebalanceOptions,
    trades: Vec<Trade>,
    gain: Decimal,
    notes: Vec<String>,
    total: Decimal,
}

impl State<'_> {
    fn class_value(&self, class: &str) -> Decimal {
        self.pos
            .iter()
            .filter(|p| p.asset_class == class)
            .map(|p| p.qty * p.price)
            .sum()
    }

    fn target_value(&self, t: &Target) -> Decimal {
        self.total * crate::money::from_f64(t.target) / Decimal::ONE_HUNDRED
    }

    fn any_outside(&self) -> bool {
        !self.outside().is_empty()
    }

    fn outside(&self) -> Vec<String> {
        if self.total.is_zero() {
            return Vec::new();
        }
        let mut classes: Vec<String> = self.targets.iter().map(|t| t.asset_class.clone()).collect();
        for p in &self.pos {
            if !classes.contains(&p.asset_class) {
                classes.push(p.asset_class.clone());
            }
        }
        classes
            .into_iter()
            .filter(|c| {
                let cur = to_f64(self.class_value(c) / self.total) * 100.0;
                let t = self.targets.iter().find(|t| &t.asset_class == c);
                let tgt = t.map_or(0.0, |t| t.target);
                outside_band(
                    cur - tgt,
                    tgt,
                    t.and_then(|t| t.band_abs),
                    t.and_then(|t| t.band_rel),
                )
            })
            .collect()
    }

    fn proxy(&self, class: &str, account: &str) -> Option<(String, Decimal)> {
        let price_of = |sym: &str| {
            self.pos
                .iter()
                .find(|p| p.symbol == sym && !p.price.is_zero())
                .map(|p| p.price)
                .or_else(|| self.opts.proxy_prices.get(sym).copied())
        };
        if let Some(sym) = self.opts.class_proxies.get(class) {
            return price_of(sym).map(|p| (sym.clone(), p));
        }
        let best = |pred: &dyn Fn(&RebalancePosition) -> bool| {
            self.pos
                .iter()
                .filter(|p| p.asset_class == class && !p.price.is_zero() && pred(p))
                .max_by(|a, b| (a.qty * a.price).cmp(&(b.qty * b.price)))
                .map(|p| (p.symbol.clone(), p.price))
        };
        best(&|p| p.account_id == account).or_else(|| best(&|_| true))
    }

    fn round_qty(&self, q: Decimal) -> Decimal {
        if self.opts.fractional {
            normalize(q.round_dp(6))
        } else {
            q.floor()
        }
    }

    /// Buys up to `amount` of `class` in `account`; returns the amount actually spent.
    fn buy(&mut self, account: &str, class: &str, amount: Decimal) -> Decimal {
        if amount < self.opts.min_trade || amount <= Decimal::ZERO {
            return Decimal::ZERO;
        }
        let Some((sym, price)) = self.proxy(class, account) else {
            self.notes
                .push(format!("No security to buy for {class}; set a class proxy"));
            return Decimal::ZERO;
        };
        let qty = self.round_qty(amount / price);
        let spent = qty * price;
        if qty <= Decimal::ZERO || spent < self.opts.min_trade {
            return Decimal::ZERO;
        }
        match self
            .pos
            .iter_mut()
            .find(|p| p.account_id == account && p.symbol == sym)
        {
            Some(p) => p.qty += qty,
            None => self.pos.push(RebalancePosition {
                account_id: account.into(),
                symbol: sym.clone(),
                asset_class: class.into(),
                qty,
                price,
                lots: Vec::new(),
            }),
        }
        self.trades.push(Trade {
            account_id: account.into(),
            symbol: sym,
            side: Side::Buy,
            qty,
            amount: spent,
            est_realized_gain: None,
        });
        spent
    }

    /// Sells up to `amount` of `class` in `account` (largest positions first); returns proceeds.
    fn sell(&mut self, account: &str, class: &str, amount: Decimal) -> Decimal {
        let taxable = !self
            .treatment
            .get(account)
            .copied()
            .unwrap_or_default()
            .is_advantaged();
        let mut idx: Vec<usize> = (0..self.pos.len())
            .filter(|&i| {
                self.pos[i].account_id == account
                    && self.pos[i].asset_class == class
                    && self.pos[i].qty > Decimal::ZERO
                    && !self.pos[i].price.is_zero()
            })
            .collect();
        idx.sort_by(|&a, &b| {
            (self.pos[b].qty * self.pos[b].price).cmp(&(self.pos[a].qty * self.pos[a].price))
        });
        let mut proceeds = Decimal::ZERO;
        for i in idx {
            let left = amount - proceeds;
            if left < self.opts.min_trade || left <= Decimal::ZERO {
                break;
            }
            let price = self.pos[i].price;
            let qty = self.round_qty((left / price).min(self.pos[i].qty));
            let value = qty * price;
            if qty <= Decimal::ZERO || value < self.opts.min_trade {
                continue;
            }
            let gain = taxable.then(|| {
                // Losses first, then highest basis: highest unit basis first covers both.
                let lots = &mut self.pos[i].lots;
                lots.sort_by_key(|l| std::cmp::Reverse(l.unit_basis()));
                let mut need = qty;
                let mut g = Decimal::ZERO;
                for l in lots.iter_mut() {
                    if need <= Decimal::ZERO {
                        break;
                    }
                    let t = need.min(l.qty);
                    let ub = l.unit_basis();
                    g += (price - ub) * t;
                    l.basis -= ub * t;
                    l.qty -= t;
                    need -= t;
                }
                lots.retain(|l| l.qty > Decimal::ZERO);
                normalize(g)
            });
            if let Some(g) = gain {
                self.gain += g;
            }
            self.pos[i].qty -= qty;
            proceeds += value;
            self.trades.push(Trade {
                account_id: account.into(),
                symbol: self.pos[i].symbol.clone(),
                side: Side::Sell,
                qty,
                amount: value,
                est_realized_gain: gain,
            });
        }
        proceeds
    }

    /// Sell-overweight / buy-underweight inside the given accounts.
    fn swap_within(&mut self, accounts: &[String]) {
        for acct in accounts {
            for _round in 0..4 {
                if !self.any_outside() {
                    return;
                }
                let mut over: Vec<(String, Decimal)> = Vec::new();
                let mut under: Vec<(String, Decimal)> = Vec::new();
                let mut classes: Vec<&Target> = self.targets.iter().collect();
                classes.sort_by(|a, b| a.asset_class.cmp(&b.asset_class));
                for t in classes {
                    let diff = self.class_value(&t.asset_class) - self.target_value(t);
                    if diff > Decimal::ZERO {
                        over.push((t.asset_class.clone(), diff));
                    } else if diff < Decimal::ZERO {
                        under.push((t.asset_class.clone(), -diff));
                    }
                }
                // Holdings in untargeted classes are fully overweight.
                let untargeted: Vec<String> = self
                    .pos
                    .iter()
                    .filter(|p| !self.targets.iter().any(|t| t.asset_class == p.asset_class))
                    .map(|p| p.asset_class.clone())
                    .collect();
                for c in untargeted {
                    if !over.iter().any(|o| o.0 == c) {
                        over.push((c.clone(), self.class_value(&c)));
                    }
                }
                over.sort_by_key(|o| std::cmp::Reverse(o.1));
                under.sort_by_key(|u| std::cmp::Reverse(u.1));
                let mut moved = false;
                for (oc, oamt) in &over {
                    let held: Decimal = self
                        .pos
                        .iter()
                        .filter(|p| &p.account_id == acct && &p.asset_class == oc)
                        .map(|p| p.qty * p.price)
                        .sum();
                    let mut avail = (*oamt).min(held);
                    for (uc, uamt) in under.iter_mut() {
                        let x = avail.min(*uamt);
                        if x < self.opts.min_trade || x <= Decimal::ZERO {
                            continue;
                        }
                        if self.proxy(uc, acct).is_none() {
                            self.notes
                                .push(format!("No security to buy for {uc}; set a class proxy"));
                            continue;
                        }
                        let got = self.sell(acct, oc, x);
                        if got.is_zero() {
                            continue;
                        }
                        let spent = self.buy(acct, uc, got);
                        avail -= got;
                        *uamt -= spent;
                        moved = true;
                    }
                }
                if !moved {
                    break;
                }
            }
        }
    }
}

/// Builds a rebalance plan.
pub fn plan(
    positions: &[RebalancePosition],
    treatment: &HashMap<String, TaxTreatment>,
    targets: &[Target],
    opts: &RebalanceOptions,
) -> Result<RebalancePlan> {
    validate_targets(targets)?;
    let lim = Decimal::from(1_000_000_000_000_i64);
    if positions.len() > 10_000
        || positions
            .iter()
            .any(|p| p.qty.abs() >= lim || p.price.abs() >= lim || p.price < Decimal::ZERO)
    {
        return Err(FinanceError::invalid("positions out of range"));
    }
    if opts.new_cash >= crate::money::amount_bound()
        || opts.proxy_prices.values().any(|p| p.abs() >= lim)
    {
        return Err(FinanceError::invalid("amounts out of range"));
    }
    if opts.new_cash < Decimal::ZERO || opts.min_trade < Decimal::ZERO {
        return Err(FinanceError::invalid(
            "new cash and minimum trade must be ≥ 0",
        ));
    }
    if opts.new_cash > Decimal::ZERO && opts.cash_account.is_none() {
        return Err(FinanceError::invalid(
            "choose the account that receives the new cash",
        ));
    }
    let holdings_total: Decimal = positions.iter().map(|p| p.qty * p.price).sum();
    let mut st = State {
        pos: positions.to_vec(),
        treatment,
        targets,
        opts,
        trades: Vec::new(),
        gain: Decimal::ZERO,
        notes: Vec::new(),
        total: holdings_total + opts.new_cash,
    };
    // 1. New cash by deficit.
    let mut cash = opts.new_cash;
    if let Some(acct) = opts.cash_account.clone().filter(|_| cash > Decimal::ZERO) {
        let deficits: Vec<(String, Decimal)> = targets
            .iter()
            .map(|t| {
                (
                    t.asset_class.clone(),
                    (st.target_value(t) - st.class_value(&t.asset_class)).max(Decimal::ZERO),
                )
            })
            .filter(|d| d.1 > Decimal::ZERO)
            .collect();
        let total_def: Decimal = deficits.iter().map(|d| d.1).sum();
        let mut alloc: Vec<(String, Decimal)> = if total_def >= cash {
            deficits
                .iter()
                .map(|(c, d)| (c.clone(), cash * *d / total_def))
                .collect()
        } else {
            let extra = cash - total_def;
            targets
                .iter()
                .map(|t| {
                    let d = deficits
                        .iter()
                        .find(|d| d.0 == t.asset_class)
                        .map_or(Decimal::ZERO, |d| d.1);
                    (
                        t.asset_class.clone(),
                        d + extra * crate::money::from_f64(t.target) / Decimal::ONE_HUNDRED,
                    )
                })
                .collect()
        };
        alloc.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        for (c, amt) in alloc {
            let spent = st.buy(&acct, &c, amt.min(cash));
            cash -= spent;
        }
    }
    // 2. Advantaged accounts.
    let mut accounts: Vec<String> = st.pos.iter().map(|p| p.account_id.clone()).collect();
    accounts.sort();
    accounts.dedup();
    let (adv, taxable): (Vec<String>, Vec<String>) = accounts.into_iter().partition(|a| {
        treatment
            .get(a)
            .copied()
            .unwrap_or_default()
            .is_advantaged()
    });
    if st.any_outside() {
        st.swap_within(&adv);
    }
    // 3. Taxable sells.
    if opts.allow_taxable_sells && st.any_outside() {
        st.swap_within(&taxable);
    }
    // Merge trades per (account, symbol, side).
    let mut merged: Vec<Trade> = Vec::new();
    for t in std::mem::take(&mut st.trades) {
        match merged
            .iter_mut()
            .find(|m| m.account_id == t.account_id && m.symbol == t.symbol && m.side == t.side)
        {
            Some(m) => {
                m.qty += t.qty;
                m.amount += t.amount;
                m.est_realized_gain = match (m.est_realized_gain, t.est_realized_gain) {
                    (None, None) => None,
                    (a, b) => Some(a.unwrap_or_default() + b.unwrap_or_default()),
                };
            }
            None => merged.push(t),
        }
    }
    let final_total: Decimal = st.pos.iter().map(|p| p.qty * p.price).sum();
    let mut classes: Vec<String> = targets.iter().map(|t| t.asset_class.clone()).collect();
    for p in &st.pos {
        if !classes.contains(&p.asset_class) {
            classes.push(p.asset_class.clone());
        }
    }
    let after = classes
        .iter()
        .map(|c| AfterRow {
            asset_class: c.clone(),
            pct: if final_total.is_zero() {
                0.0
            } else {
                to_f64(st.class_value(c) / final_total) * 100.0
            },
        })
        .collect();
    let mut notes = st.notes.clone();
    notes.dedup();
    st.total = final_total + cash;
    Ok(RebalancePlan {
        trades: merged,
        after,
        est_realized_gain: st.gain,
        still_outside: st.outside(),
        cash_left: cash,
        notes,
    })
}

/// Classes that would be bought/sold and the date — helper for the "annual review" note.
pub fn summary_line(plan: &RebalancePlan, on: NaiveDate) -> String {
    let buys = plan.trades.iter().filter(|t| t.side == Side::Buy).count();
    let sells = plan.trades.len() - buys;
    format!("Rebalance plan for {on}: {buys} buy(s), {sells} sell(s). EMP never places trades.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::dec;

    fn pos(acct: &str, sym: &str, class: &str, qty: &str, price: &str) -> RebalancePosition {
        RebalancePosition {
            account_id: acct.into(),
            symbol: sym.into(),
            asset_class: class.into(),
            qty: dec(qty),
            price: dec(price),
            lots: Vec::new(),
        }
    }

    fn t(c: &str, p: f64) -> Target {
        Target {
            asset_class: c.into(),
            target: p,
            band_abs: None,
            band_rel: None,
        }
    }

    fn opts(cash: &str) -> RebalanceOptions {
        RebalanceOptions {
            new_cash: dec(cash),
            cash_account: Some("tax".into()),
            allow_taxable_sells: false,
            min_trade: dec("50"),
            fractional: false,
            class_proxies: BTreeMap::new(),
            proxy_prices: BTreeMap::new(),
        }
    }

    fn treat() -> HashMap<String, TaxTreatment> {
        [
            ("tax".to_string(), TaxTreatment::Taxable),
            ("ira".to_string(), TaxTreatment::Deferred),
        ]
        .into()
    }

    #[test]
    fn new_cash_goes_to_deficits() {
        let p = vec![
            pos("tax", "VTI", "Stocks", "70", "100"),
            pos("tax", "BND", "Bonds", "30", "100"),
        ];
        let plan = plan(
            &p,
            &treat(),
            &[t("Stocks", 60.0), t("Bonds", 40.0)],
            &opts("1000"),
        )
        .unwrap();
        // Total 11000 → bonds target 4400, deficit 1400 > cash → all cash to bonds.
        assert_eq!(plan.trades.len(), 1);
        assert_eq!(plan.trades[0].symbol, "BND");
        assert_eq!(plan.trades[0].qty, dec("10"));
        assert!(plan.trades.iter().all(|t| t.side == Side::Buy));
        assert!(plan.still_outside.is_empty(), "{:?}", plan.after);
    }

    #[test]
    fn advantaged_first_then_taxable_with_lots() {
        let mut taxable = pos("tax", "VTI", "Stocks", "80", "100");
        taxable.lots = vec![
            Lot {
                source_id: "l1".into(),
                account_id: "tax".into(),
                security: "VTI".into(),
                acquired: "2020-01-01".parse().unwrap(),
                qty: dec("40"),
                basis: dec("2000"),
            },
            Lot {
                source_id: "l2".into(),
                account_id: "tax".into(),
                security: "VTI".into(),
                acquired: "2024-01-01".parse().unwrap(),
                qty: dec("40"),
                basis: dec("4800"),
            },
        ];
        let p = vec![
            taxable,
            pos("ira", "VXUS", "Stocks", "10", "100"),
            pos("tax", "BND", "Bonds", "10", "100"),
        ];
        // 9000 stocks / 1000 bonds vs 60/40.
        let targets = [t("Stocks", 60.0), t("Bonds", 40.0)];
        let no_tax = plan(&p, &treat(), &targets, &opts("0")).unwrap();
        // IRA has no bond fund held, but BND exists in the portfolio → bought in the IRA.
        assert!(
            no_tax
                .trades
                .iter()
                .any(|t| t.account_id == "ira" && t.side == Side::Sell)
        );
        assert!(no_tax.trades.iter().all(|t| t.account_id != "tax"));
        assert!(!no_tax.still_outside.is_empty());
        let mut o = opts("0");
        o.allow_taxable_sells = true;
        let full = plan(&p, &treat(), &targets, &o).unwrap();
        assert!(full.still_outside.is_empty(), "{:?}", full.after);
        let sell = full
            .trades
            .iter()
            .find(|t| t.account_id == "tax" && t.side == Side::Sell)
            .unwrap();
        // Highest basis (loss) lot first: unit basis 120 > price 100 → negative gain.
        assert!(sell.est_realized_gain.unwrap() < Decimal::ZERO);
        assert_eq!(full.est_realized_gain, sell.est_realized_gain.unwrap());
        assert!(full.trades.iter().all(|t| t.qty.fract().is_zero()));
        assert!(full.trades.iter().all(|t| t.amount >= dec("50")));
    }

    #[test]
    fn validation_and_proxies() {
        let p = vec![pos("tax", "VTI", "Stocks", "10", "100")];
        assert!(plan(&p, &treat(), &[t("Stocks", 90.0)], &opts("0")).is_err());
        let mut o = opts("500");
        o.cash_account = None;
        assert!(plan(&p, &treat(), &[t("Stocks", 100.0)], &o).is_err());
        let mut o = opts("1000");
        o.fractional = true;
        let r = plan(&p, &treat(), &[t("Stocks", 50.0), t("Bonds", 50.0)], &o).unwrap();
        assert!(r.notes.iter().any(|n| n.contains("Bonds")));
        o.class_proxies.insert("Bonds".into(), "BND".into());
        o.proxy_prices.insert("BND".into(), dec("72.5"));
        let r = plan(&p, &treat(), &[t("Stocks", 50.0), t("Bonds", 50.0)], &o).unwrap();
        assert_eq!(r.trades[0].symbol, "BND");
        assert!(r.cash_left < dec("0.01"), "{}", r.cash_left);
    }
}
