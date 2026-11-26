//! Tax lots (§15.7 `lots::rebuild`): FIFO and average cost, realised gains with short/long-term terms.
//!
//! Invariant: for every (account, security), Σ lot qty equals the position quantity obtained by replaying
//! the executed quantities (tested).

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::{CostMethod, InvTxn, InvTxnType};
use crate::money::normalize;

/// An open lot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lot {
    /// Source transaction id.
    pub source_id: String,
    /// Account.
    pub account_id: String,
    /// Security.
    pub security: String,
    /// Acquisition date (holding period start).
    pub acquired: NaiveDate,
    /// Remaining quantity.
    pub qty: Decimal,
    /// Remaining total cost basis.
    pub basis: Decimal,
}

impl Lot {
    /// Basis per share.
    pub fn unit_basis(&self) -> Decimal {
        if self.qty.is_zero() {
            Decimal::ZERO
        } else {
            self.basis / self.qty
        }
    }
}

/// Holding-period term.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Term {
    /// Held ≤ threshold.
    Short,
    /// Held > threshold.
    Long,
}

/// A realised disposition (IPC `portfolio_realized.lots[]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealizedLot {
    /// Disposing transaction id.
    pub txn_id: String,
    /// Account.
    pub account_id: String,
    /// Security.
    pub symbol: String,
    /// Acquisition date.
    pub acquired: NaiveDate,
    /// Sale date.
    pub sold: NaiveDate,
    /// Quantity (0 for return-of-capital excess).
    pub qty: Decimal,
    /// Proceeds net of fees.
    pub proceeds: Decimal,
    /// Basis.
    pub basis: Decimal,
    /// `proceeds − basis`.
    pub gain: Decimal,
    /// Term.
    pub term: Term,
}

/// Dividend/interest income.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeEvent {
    /// Transaction id.
    pub txn_id: String,
    /// Date.
    pub date: NaiveDate,
    /// Account.
    pub account_id: String,
    /// Security (empty for account interest).
    pub security: String,
    /// `dividend` or `interest`.
    pub kind: InvTxnType,
    /// Cash amount.
    pub amount: Decimal,
    /// Reinvested.
    pub reinvested: bool,
    /// Shares held on the date (for per-share figures).
    pub qty_held: Decimal,
}

/// A fee.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeEvent {
    /// Transaction id.
    pub txn_id: String,
    /// Date.
    pub date: NaiveDate,
    /// Account.
    pub account_id: String,
    /// Amount (positive).
    pub amount: Decimal,
}

/// Rebuild options.
#[derive(Debug, Clone, Default)]
pub struct RebuildOptions {
    /// Default method.
    pub default_method: CostMethod,
    /// Per-account overrides.
    pub methods: HashMap<String, CostMethod>,
    /// Long-term threshold in days (US: 365, "more than").
    pub long_term_days: i64,
}

/// The rebuilt book.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LotBook {
    /// Open lots (zero-quantity lots removed).
    pub lots: Vec<Lot>,
    /// Realised dispositions.
    pub realized: Vec<RealizedLot>,
    /// Income events.
    pub income: Vec<IncomeEvent>,
    /// Fees (trade commissions are inside basis/proceeds; these are separate fee rows plus commissions).
    pub fees: Vec<FeeEvent>,
    /// Problems found while replaying (e.g. selling more than held).
    pub warnings: Vec<String>,
}

impl LotBook {
    /// Quantity per (account, security).
    pub fn positions(&self) -> BTreeMap<(String, String), Decimal> {
        let mut m = BTreeMap::new();
        for l in &self.lots {
            *m.entry((l.account_id.clone(), l.security.clone()))
                .or_insert(Decimal::ZERO) += l.qty;
        }
        m
    }

    /// Total realised gain by term for `year`.
    pub fn realized_totals(&self, year: i32) -> (Decimal, Decimal) {
        let mut st = Decimal::ZERO;
        let mut lt = Decimal::ZERO;
        for r in self
            .realized
            .iter()
            .filter(|r| chrono::Datelike::year(&r.sold) == year)
        {
            match r.term {
                Term::Short => st += r.gain,
                Term::Long => lt += r.gain,
            }
        }
        (st, lt)
    }
}

fn term(acquired: NaiveDate, sold: NaiveDate, days: i64) -> Term {
    if (sold - acquired).num_days() > days {
        Term::Long
    } else {
        Term::Short
    }
}

struct Ctx<'a> {
    opts: &'a RebuildOptions,
    book: LotBook,
    open: BTreeMap<(String, String), Vec<Lot>>,
    in_transit: HashMap<String, Vec<Lot>>,
}

impl Ctx<'_> {
    fn method(&self, account: &str) -> CostMethod {
        self.opts
            .methods
            .get(account)
            .copied()
            .unwrap_or(self.opts.default_method)
    }

    fn held(&self, key: &(String, String)) -> Decimal {
        self.open
            .get(key)
            .map_or(Decimal::ZERO, |v| v.iter().map(|l| l.qty).sum())
    }

    /// Removes `qty` from the position (FIFO order of lots). Under average cost the removed basis is the
    /// pooled average and remaining lots are re-based to the average. Returns the removed slices.
    fn take(&mut self, key: &(String, String), qty: Decimal) -> Vec<Lot> {
        let avg = self.method(&key.0) == CostMethod::AverageCost;
        let lots = self.open.entry(key.clone()).or_default();
        let total_q: Decimal = lots.iter().map(|l| l.qty).sum();
        let total_b: Decimal = lots.iter().map(|l| l.basis).sum();
        let avg_unit = if total_q.is_zero() {
            Decimal::ZERO
        } else {
            total_b / total_q
        };
        let mut remaining = qty;
        let mut out = Vec::new();
        for lot in lots.iter_mut() {
            if remaining <= Decimal::ZERO {
                break;
            }
            let t = remaining.min(lot.qty);
            if t <= Decimal::ZERO {
                continue;
            }
            let b = if t == lot.qty {
                lot.basis
            } else {
                normalize(lot.basis * t / lot.qty)
            };
            let b = if avg { normalize(avg_unit * t) } else { b };
            out.push(Lot {
                qty: t,
                basis: b,
                ..lot.clone()
            });
            lot.qty -= t;
            lot.basis = if avg {
                normalize(avg_unit * lot.qty)
            } else {
                lot.basis - b
            };
            remaining -= t;
        }
        if avg {
            for lot in lots.iter_mut() {
                lot.basis = normalize(avg_unit * lot.qty);
            }
        }
        lots.retain(|l| l.qty > Decimal::ZERO);
        out
    }
}

/// Replays transactions (sorted by date; same-day order preserved) into lots, realised gains and income.
pub fn rebuild(txns: &[InvTxn], opts: &RebuildOptions) -> LotBook {
    let mut sorted: Vec<(usize, &InvTxn)> = txns.iter().enumerate().collect();
    sorted.sort_by(|a, b| a.1.date.cmp(&b.1.date).then(a.0.cmp(&b.0)));
    let lt_days = if opts.long_term_days > 0 {
        opts.long_term_days
    } else {
        super::US_LONG_TERM_DAYS
    };
    let mut cx = Ctx {
        opts,
        book: LotBook::default(),
        open: BTreeMap::new(),
        in_transit: HashMap::new(),
    };
    let lim = Decimal::from(1_000_000_000_000_i64);
    for (_, t) in sorted {
        let too_big = |x: Option<Decimal>| x.is_some_and(|v| v.abs() >= lim);
        if too_big(t.qty)
            || too_big(t.price)
            || too_big(t.amount)
            || too_big(t.basis)
            || t.fees.abs() >= lim
            || too_big(t.ratio)
        {
            cx.book.warnings.push(format!(
                "{}: values out of range; transaction ignored",
                t.id
            ));
            continue;
        }
        let key = (t.account_id.clone(), t.security.clone());
        let qty = t.qty.unwrap_or_default().abs();
        let price = t.price.unwrap_or_default();
        let gross = t.amount.map(|a| a.abs()).unwrap_or(qty * price);
        let fees = t.fees.abs();
        if fees > Decimal::ZERO && !matches!(t.kind, InvTxnType::Fee) {
            cx.book.fees.push(FeeEvent {
                txn_id: t.id.clone(),
                date: t.date,
                account_id: t.account_id.clone(),
                amount: fees,
            });
        }
        match t.kind {
            InvTxnType::Buy | InvTxnType::Reinvest => {
                if qty.is_zero() {
                    cx.book.warnings.push(format!(
                        "{}: {:?} without a quantity was ignored",
                        t.id, t.kind
                    ));
                    continue;
                }
                if t.kind == InvTxnType::Reinvest {
                    let held = cx.held(&key);
                    cx.book.income.push(IncomeEvent {
                        txn_id: t.id.clone(),
                        date: t.date,
                        account_id: t.account_id.clone(),
                        security: t.security.clone(),
                        kind: InvTxnType::Dividend,
                        amount: gross,
                        reinvested: true,
                        qty_held: held,
                    });
                }
                let lot = Lot {
                    source_id: t.id.clone(),
                    account_id: t.account_id.clone(),
                    security: t.security.clone(),
                    acquired: t.date,
                    qty,
                    basis: gross + fees,
                };
                cx.open.entry(key).or_default().push(lot);
            }
            InvTxnType::Sell => {
                let held = cx.held(&key);
                if qty.is_zero() {
                    cx.book
                        .warnings
                        .push(format!("{}: sell without a quantity was ignored", t.id));
                    continue;
                }
                let exec = qty.min(held);
                if exec < qty {
                    cx.book.warnings.push(format!("{}: sold {qty} {} but only {held} were held; short sales are not supported", t.id, t.security));
                }
                if exec.is_zero() {
                    continue;
                }
                let proceeds_total = gross * exec / qty - fees;
                let slices = cx.take(&key, exec);
                let mut allocated = Decimal::ZERO;
                let n = slices.len();
                for (i, s) in slices.into_iter().enumerate() {
                    let p = if i + 1 == n {
                        proceeds_total - allocated
                    } else {
                        normalize(proceeds_total * s.qty / exec)
                    };
                    allocated += p;
                    cx.book.realized.push(RealizedLot {
                        txn_id: t.id.clone(),
                        account_id: t.account_id.clone(),
                        symbol: t.security.clone(),
                        acquired: s.acquired,
                        sold: t.date,
                        qty: s.qty,
                        proceeds: p,
                        basis: s.basis,
                        gain: p - s.basis,
                        term: term(s.acquired, t.date, lt_days),
                    });
                }
            }
            InvTxnType::Dividend | InvTxnType::Interest => {
                let held = cx.held(&key);
                cx.book.income.push(IncomeEvent {
                    txn_id: t.id.clone(),
                    date: t.date,
                    account_id: t.account_id.clone(),
                    security: t.security.clone(),
                    kind: t.kind,
                    amount: gross,
                    reinvested: false,
                    qty_held: held,
                });
            }
            InvTxnType::Fee => {
                let amt = if gross.is_zero() { fees } else { gross };
                cx.book.fees.push(FeeEvent {
                    txn_id: t.id.clone(),
                    date: t.date,
                    account_id: t.account_id.clone(),
                    amount: amt,
                });
            }
            InvTxnType::Split => {
                let Some(r) = t.ratio.filter(|r| *r > Decimal::ZERO) else {
                    cx.book.warnings.push(format!(
                        "{}: split without a positive ratio was ignored",
                        t.id
                    ));
                    continue;
                };
                for lot in cx.open.entry(key).or_default() {
                    lot.qty = normalize(lot.qty * r);
                }
            }
            InvTxnType::TransferOut => {
                let held = cx.held(&key);
                let exec = qty.min(held);
                if exec < qty {
                    cx.book.warnings.push(format!(
                        "{}: transferred out {qty} but only {held} were held",
                        t.id
                    ));
                }
                let slices = cx.take(&key, exec);
                cx.in_transit
                    .entry(t.security.clone())
                    .or_default()
                    .extend(slices);
            }
            InvTxnType::TransferIn => {
                if qty.is_zero() {
                    continue;
                }
                let lots = cx.open.entry(key.clone()).or_default();
                if let Some(b) = t.basis {
                    lots.push(Lot {
                        source_id: t.id.clone(),
                        account_id: t.account_id.clone(),
                        security: t.security.clone(),
                        acquired: t.acquired.unwrap_or(t.date),
                        qty,
                        basis: b.abs(),
                    });
                    continue;
                }
                // Match shares previously transferred out (basis and dates kept).
                let pool = cx.in_transit.entry(t.security.clone()).or_default();
                let mut need = qty;
                while need > Decimal::ZERO && !pool.is_empty() {
                    let mut s = pool.remove(0);
                    if s.qty > need {
                        let part = normalize(s.basis * need / s.qty);
                        pool.insert(
                            0,
                            Lot {
                                qty: s.qty - need,
                                basis: s.basis - part,
                                ..s.clone()
                            },
                        );
                        s.qty = need;
                        s.basis = part;
                    }
                    need -= s.qty;
                    lots.push(Lot {
                        account_id: t.account_id.clone(),
                        ..s
                    });
                }
                if need > Decimal::ZERO {
                    cx.book.warnings.push(format!(
                        "{}: transfer in without known basis; using price × quantity",
                        t.id
                    ));
                    lots.push(Lot {
                        source_id: t.id.clone(),
                        account_id: t.account_id.clone(),
                        security: t.security.clone(),
                        acquired: t.acquired.unwrap_or(t.date),
                        qty: need,
                        basis: need * price,
                    });
                }
            }
            InvTxnType::ReturnOfCapital => {
                let lots = cx.open.entry(key).or_default();
                let total_q: Decimal = lots.iter().map(|l| l.qty).sum();
                if total_q.is_zero() {
                    cx.book
                        .warnings
                        .push(format!("{}: return of capital with no shares held", t.id));
                    continue;
                }
                for lot in lots.iter_mut() {
                    let share = normalize(gross * lot.qty / total_q);
                    if share <= lot.basis {
                        lot.basis -= share;
                    } else {
                        let excess = share - lot.basis;
                        lot.basis = Decimal::ZERO;
                        cx.book.realized.push(RealizedLot {
                            txn_id: t.id.clone(),
                            account_id: t.account_id.clone(),
                            symbol: t.security.clone(),
                            acquired: lot.acquired,
                            sold: t.date,
                            qty: Decimal::ZERO,
                            proceeds: excess,
                            basis: Decimal::ZERO,
                            gain: excess,
                            term: term(lot.acquired, t.date, lt_days),
                        });
                    }
                }
            }
        }
    }
    for (_, lots) in cx.open {
        cx.book
            .lots
            .extend(lots.into_iter().filter(|l| l.qty > Decimal::ZERO));
    }
    for (sec, rest) in cx.in_transit {
        if rest.iter().any(|l| l.qty > Decimal::ZERO) {
            cx.book.warnings.push(format!(
                "{sec}: shares transferred out were never transferred in"
            ));
        }
    }
    cx.book
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::SplitMix64;
    use crate::testutil::dec;

    fn tx(
        id: &str,
        date: &str,
        kind: InvTxnType,
        acct: &str,
        sec: &str,
        qty: &str,
        price: &str,
    ) -> InvTxn {
        InvTxn {
            id: id.into(),
            date: date.parse().unwrap(),
            kind,
            account_id: acct.into(),
            security: sec.into(),
            qty: (!qty.is_empty()).then(|| dec(qty)),
            price: (!price.is_empty()).then(|| dec(price)),
            amount: None,
            fees: Decimal::ZERO,
            ratio: None,
            acquired: None,
            basis: None,
        }
    }

    fn opts(m: CostMethod) -> RebuildOptions {
        RebuildOptions {
            default_method: m,
            methods: HashMap::new(),
            long_term_days: 365,
        }
    }

    #[test]
    fn fifo_realised_terms() {
        use InvTxnType::*;
        let mut buy1 = tx("b1", "2024-01-10", Buy, "a", "VTI", "10", "200");
        buy1.fees = dec("5");
        let txns = vec![
            buy1,
            tx("b2", "2025-06-01", Buy, "a", "VTI", "10", "250"),
            tx("s1", "2025-08-01", Sell, "a", "VTI", "15", "300"),
        ];
        let b = rebuild(&txns, &opts(CostMethod::Fifo));
        assert_eq!(b.realized.len(), 2);
        let (r1, r2) = (&b.realized[0], &b.realized[1]);
        assert_eq!(
            (r1.qty, r1.basis, r1.proceeds, r1.term),
            (dec("10"), dec("2005"), dec("3000"), Term::Long)
        );
        assert_eq!(
            (r2.qty, r2.basis, r2.proceeds, r2.term),
            (dec("5"), dec("1250"), dec("1500"), Term::Short)
        );
        assert_eq!(b.lots.len(), 1);
        assert_eq!((b.lots[0].qty, b.lots[0].basis), (dec("5"), dec("1250")));
        assert_eq!(b.realized_totals(2025), (dec("250"), dec("995")));
    }

    #[test]
    fn average_cost() {
        use InvTxnType::*;
        let txns = vec![
            tx("b1", "2025-01-01", Buy, "a", "X", "10", "10"),
            tx("b2", "2025-02-01", Buy, "a", "X", "10", "20"),
            tx("s1", "2025-03-01", Sell, "a", "X", "5", "30"),
        ];
        let b = rebuild(&txns, &opts(CostMethod::AverageCost));
        assert_eq!(b.realized[0].basis, dec("75"));
        assert_eq!(b.realized[0].gain, dec("75"));
        let total_basis: Decimal = b.lots.iter().map(|l| l.basis).sum();
        assert_eq!(total_basis, dec("225"));
        assert!(b.lots.iter().all(|l| l.unit_basis() == dec("15")));
    }

    #[test]
    fn split_dividend_roc_transfer() {
        use InvTxnType::*;
        let mut split = tx("sp", "2025-03-01", Split, "a", "X", "", "");
        split.ratio = Some(dec("2"));
        let mut div = tx("d", "2025-04-01", Dividend, "a", "X", "", "");
        div.amount = Some(dec("12"));
        let mut roc = tx("r", "2025-05-01", ReturnOfCapital, "a", "X", "", "");
        roc.amount = Some(dec("1100"));
        let mut reinv = tx("ri", "2025-06-01", Reinvest, "a", "X", "1", "50");
        reinv.amount = Some(dec("50"));
        let txns = vec![
            tx("b", "2025-01-01", Buy, "a", "X", "10", "100"),
            split,
            div,
            roc,
            reinv,
            tx("to", "2025-07-01", TransferOut, "a", "X", "21", ""),
            tx("ti", "2025-07-02", TransferIn, "ira", "X", "21", ""),
        ];
        let b = rebuild(&txns, &opts(CostMethod::Fifo));
        // Split doubles qty, keeps basis 1000; RoC 1100 wipes basis with 100 excess gain.
        assert_eq!(b.realized.len(), 1);
        assert_eq!(b.realized[0].gain, dec("100"));
        assert_eq!(b.income.len(), 2);
        assert_eq!(b.income[0].qty_held, dec("20"));
        assert!(b.income[1].reinvested);
        let pos = b.positions();
        assert_eq!(pos.get(&("ira".into(), "X".into())), Some(&dec("21")));
        assert_eq!(pos.get(&("a".into(), "X".into())), None);
        // Transferred lots keep their acquisition dates.
        assert!(
            b.lots
                .iter()
                .any(|l| l.acquired.to_string() == "2025-01-01" && l.account_id == "ira")
        );
        assert!(b.warnings.is_empty(), "{:?}", b.warnings);
    }

    #[test]
    fn oversell_warns() {
        use InvTxnType::*;
        let b = rebuild(
            &[
                tx("b", "2025-01-01", Buy, "a", "X", "1", "10"),
                tx("s", "2025-01-02", Sell, "a", "X", "3", "10"),
            ],
            &opts(CostMethod::Fifo),
        );
        assert_eq!(b.realized[0].qty, dec("1"));
        assert_eq!(b.realized[0].proceeds, dec("10"));
        assert_eq!(b.warnings.len(), 1);
    }

    #[test]
    fn invariant_random() {
        use InvTxnType::*;
        let mut rng = SplitMix64::new(9);
        for case in 0..40 {
            let mut txns = Vec::new();
            let mut expected: HashMap<(String, String), Decimal> = HashMap::new();
            for k in 0..60 {
                let acct = if rng.below(2) == 0 { "a" } else { "b" };
                let sec = ["X", "Y"][rng.below(2)];
                let date = chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap()
                    + chrono::Duration::days(k * 5);
                let q = Decimal::new(1 + rng.below(1000) as i64, 1);
                let key = (acct.to_string(), sec.to_string());
                let held = expected.get(&key).copied().unwrap_or_default();
                let kind = match rng.below(4) {
                    0 | 1 => Buy,
                    2 => Sell,
                    _ => Split,
                };
                let mut t = tx(
                    &k.to_string(),
                    &date.to_string(),
                    kind,
                    acct,
                    sec,
                    &q.to_string(),
                    "10",
                );
                match kind {
                    Buy => *expected.entry(key).or_default() += q,
                    Sell => *expected.entry(key).or_default() = held - q.min(held),
                    _ => {
                        t.ratio = Some(dec("1.5"));
                        *expected.entry(key).or_default() = normalize(held * dec("1.5"));
                    }
                }
                txns.push(t);
            }
            let method = if case % 2 == 0 {
                CostMethod::Fifo
            } else {
                CostMethod::AverageCost
            };
            let book = rebuild(&txns, &opts(method));
            let pos = book.positions();
            for (k, v) in expected {
                let got = pos.get(&k).copied().unwrap_or_default();
                assert!(
                    (got - v).abs() < dec("0.000001"),
                    "case {case} {k:?}: {got} vs {v}"
                );
            }
            assert!(book.lots.iter().all(|l| l.basis >= Decimal::ZERO));
        }
    }
}
