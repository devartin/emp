//! Money and currency primitives (SPEC §15.1, D-21).
//!
//! Amounts are [`Decimal`] values serialised as decimal strings with scale ≤ 8,
//! paired with an ISO-4217 (or crypto) currency code.

use std::fmt;
use std::str::FromStr;

use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{FinanceError, Result};

/// Maximum decimal scale accepted anywhere in the engine (crypto needs 8).
pub const MAX_SCALE: u32 = 8;

/// Amount bound for imported values: |x| < 10^15 (§9.16).
pub fn amount_bound() -> Decimal {
    Decimal::from(1_000_000_000_000_000_i64)
}

/// A currency code: 3–10 ASCII uppercase letters/digits (ISO-4217 such as `USD`, or crypto such as `BTC`, `USDT`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Currency(String);

impl Currency {
    /// Validates and normalises (uppercases) a code.
    pub fn new(code: &str) -> Result<Self> {
        let c = code.trim().to_ascii_uppercase();
        let ok = (3..=10).contains(&c.len())
            && c.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        if !ok {
            return Err(FinanceError::invalid(format!(
                "invalid currency code {code:?}"
            )));
        }
        Ok(Self(c))
    }

    /// The code as a string slice.
    pub fn code(&self) -> &str {
        &self.0
    }

    /// Number of minor-unit digits used for display/rounding (ISO 4217 exponent; 8 for known crypto).
    pub fn minor_digits(&self) -> u32 {
        match self.0.as_str() {
            "JPY" | "KRW" | "VND" | "CLP" | "ISK" | "HUF" | "TWD" | "UGX" | "XAF" | "XOF"
            | "PYG" => 0,
            "BHD" | "KWD" | "OMR" | "JOD" | "TND" | "LYD" | "IQD" => 3,
            "BTC" | "ETH" | "LTC" | "BCH" | "XMR" | "DOGE" | "SOL" | "ADA" => 8,
            _ => 2,
        }
    }

    /// Whether the code is a well-known crypto asset.
    pub fn is_crypto(&self) -> bool {
        self.minor_digits() == 8
    }
}

impl fmt::Display for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for Currency {
    type Err = FinanceError;
    fn from_str(s: &str) -> Result<Self> {
        Self::new(s)
    }
}

impl Serialize for Currency {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Currency {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Currency::new(&s).map_err(serde::de::Error::custom)
    }
}

/// Rounding modes used by display, invoices and tax packs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rounding {
    /// Banker's rounding (display default).
    HalfEven,
    /// Commercial rounding (invoices, most tax packs).
    HalfUp,
    /// Truncate toward zero.
    Down,
}

impl Rounding {
    fn strategy(self) -> RoundingStrategy {
        match self {
            Rounding::HalfEven => RoundingStrategy::MidpointNearestEven,
            Rounding::HalfUp => RoundingStrategy::MidpointAwayFromZero,
            Rounding::Down => RoundingStrategy::ToZero,
        }
    }

    /// Short label shown next to rounded figures ("half-even").
    pub fn label(self) -> &'static str {
        match self {
            Rounding::HalfEven => "half-even",
            Rounding::HalfUp => "half-up",
            Rounding::Down => "truncated",
        }
    }
}

/// Rounds `d` to `dp` decimal places using `mode`.
pub fn round(d: Decimal, dp: u32, mode: Rounding) -> Decimal {
    d.round_dp_with_strategy(dp, mode.strategy())
}

/// Rounds to cents, half-up — the convention used for interest and payment schedules.
pub fn cents(d: Decimal) -> Decimal {
    round(d, 2, Rounding::HalfUp)
}

/// Parses a plain decimal string (`"-12.34"`), enforcing scale ≤ 8 and finiteness.
///
/// This is the IPC validator for money strings; statement parsing uses
/// [`crate::import::amount::parse_amount`] which understands locale formats.
pub fn parse_decimal(s: &str) -> Result<Decimal> {
    let t = s.trim();
    if t.is_empty() || t.len() > 64 {
        return Err(FinanceError::invalid(format!("invalid decimal {s:?}")));
    }
    let d = Decimal::from_str_exact(t)
        .or_else(|_| Decimal::from_scientific(t))
        .map_err(|_| FinanceError::invalid(format!("invalid decimal {s:?}")))?;
    if d.scale() > MAX_SCALE {
        let r = d.normalize();
        if r.scale() > MAX_SCALE {
            return Err(FinanceError::invalid(format!(
                "scale > {MAX_SCALE} in {s:?}"
            )));
        }
        return Ok(r);
    }
    Ok(d)
}

/// Clamps a computed value to scale ≤ 8 (half-even) for serialisation.
pub fn normalize(d: Decimal) -> Decimal {
    if d.scale() > MAX_SCALE {
        round(d, MAX_SCALE, Rounding::HalfEven).normalize()
    } else {
        d
    }
}

/// Converts a decimal to `f64` for chart series and ratios (never used for stored money).
pub fn to_f64(d: Decimal) -> f64 {
    use rust_decimal::prelude::ToPrimitive;
    d.to_f64().unwrap_or(0.0)
}

/// Converts a finite `f64` into a decimal, rounding to 8 places. Non-finite values become zero.
pub fn from_f64(x: f64) -> Decimal {
    if !x.is_finite() {
        return Decimal::ZERO;
    }
    Decimal::from_f64_retain(x)
        .map(normalize)
        .unwrap_or(Decimal::ZERO)
}

/// A monetary amount in a currency.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    /// Signed amount (decimal string on the wire).
    pub amount: Decimal,
    /// Currency code.
    pub currency: Currency,
}

impl Money {
    /// Creates a money value, normalising scale to ≤ 8.
    pub fn new(amount: Decimal, currency: Currency) -> Self {
        Self {
            amount: normalize(amount),
            currency,
        }
    }

    /// Parses `amount` (plain decimal string) and `currency`.
    pub fn parse(amount: &str, currency: &str) -> Result<Self> {
        Ok(Self::new(parse_decimal(amount)?, Currency::new(currency)?))
    }

    /// Zero in `currency`.
    pub fn zero(currency: Currency) -> Self {
        Self {
            amount: Decimal::ZERO,
            currency,
        }
    }

    /// Adds two amounts of the same currency.
    pub fn checked_add(&self, other: &Money) -> Result<Money> {
        self.same(other)?;
        Ok(Money::new(
            self.amount + other.amount,
            self.currency.clone(),
        ))
    }

    /// Subtracts two amounts of the same currency.
    pub fn checked_sub(&self, other: &Money) -> Result<Money> {
        self.same(other)?;
        Ok(Money::new(
            self.amount - other.amount,
            self.currency.clone(),
        ))
    }

    fn same(&self, other: &Money) -> Result<()> {
        if self.currency != other.currency {
            return Err(FinanceError::invalid(format!(
                "currency mismatch: {} vs {}",
                self.currency, other.currency
            )));
        }
        Ok(())
    }

    /// Amount in integer minor units (cents for USD), rounded half-even. Saturates at i64 bounds.
    pub fn minor_units(&self) -> i64 {
        minor_units(self.amount, self.currency.minor_digits())
    }

    /// Amount rounded for display in the currency's minor digits (half-even, labelled).
    pub fn display_rounded(&self) -> Decimal {
        round(
            self.amount,
            self.currency.minor_digits(),
            Rounding::HalfEven,
        )
    }

    /// Negated amount.
    pub fn neg(&self) -> Money {
        Money {
            amount: -self.amount,
            currency: self.currency.clone(),
        }
    }
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.display_rounded(), self.currency)
    }
}

/// Integer minor units for `amount` with `digits` minor digits (half-even), saturating.
pub fn minor_units(amount: Decimal, digits: u32) -> i64 {
    use rust_decimal::prelude::ToPrimitive;
    let scaled =
        round(amount, digits, Rounding::HalfEven) * Decimal::from(10_i64.pow(digits.min(18)));
    scaled
        .trunc()
        .to_i64()
        .unwrap_or(if amount.is_sign_negative() {
            i64::MIN
        } else {
            i64::MAX
        })
}

/// Sums an iterator of decimals.
pub fn sum<I: IntoIterator<Item = Decimal>>(it: I) -> Decimal {
    it.into_iter().fold(Decimal::ZERO, |a, b| a + b)
}

/// Median of a slice of decimals (mean of the two middle values for even lengths). `None` when empty.
pub fn median(values: &[Decimal]) -> Option<Decimal> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort();
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / Decimal::TWO
    })
}

/// `x^n` for integer `n ≥ 0` by repeated squaring (exact decimal arithmetic, saturating via checked ops).
pub fn powi(x: Decimal, n: u32) -> Option<Decimal> {
    let mut result = Decimal::ONE;
    let mut base = x;
    let mut e = n;
    while e > 0 {
        if e & 1 == 1 {
            result = result.checked_mul(base)?;
        }
        e >>= 1;
        if e > 0 {
            base = base.checked_mul(base)?;
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        parse_decimal(s).unwrap()
    }

    #[test]
    fn currency_validation() {
        assert_eq!(Currency::new("usd").unwrap().code(), "USD");
        assert!(Currency::new("US").is_err());
        assert!(Currency::new("U$D").is_err());
        assert_eq!(Currency::new("BTC").unwrap().minor_digits(), 8);
        assert_eq!(Currency::new("JPY").unwrap().minor_digits(), 0);
    }

    #[test]
    fn money_serialises_as_strings() {
        let m = Money::parse("12.30", "eur").unwrap();
        let j = serde_json::to_string(&m).unwrap();
        assert_eq!(j, r#"{"amount":"12.30","currency":"EUR"}"#);
        let back: Money = serde_json::from_str(&j).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn scale_limit() {
        assert!(parse_decimal("0.123456789").is_err());
        assert_eq!(parse_decimal("0.123456780").unwrap(), d("0.12345678"));
        assert!(parse_decimal("abc").is_err());
        assert!(parse_decimal("").is_err());
    }

    #[test]
    fn rounding_modes() {
        assert_eq!(round(d("2.345"), 2, Rounding::HalfEven), d("2.34"));
        assert_eq!(round(d("2.345"), 2, Rounding::HalfUp), d("2.35"));
        assert_eq!(round(d("-2.349"), 2, Rounding::Down), d("-2.34"));
        assert_eq!(Rounding::HalfEven.label(), "half-even");
    }

    #[test]
    fn minor_units_and_arith() {
        let a = Money::parse("10.005", "USD").unwrap();
        assert_eq!(a.minor_units(), 1000);
        let b = Money::parse("1", "USD").unwrap();
        assert_eq!(a.checked_add(&b).unwrap().amount, d("11.005"));
        assert!(a.checked_add(&Money::parse("1", "EUR").unwrap()).is_err());
        assert_eq!(Money::parse("-1.5", "JPY").unwrap().minor_units(), -2);
    }

    #[test]
    fn median_and_pow() {
        assert_eq!(median(&[d("3"), d("1"), d("2")]), Some(d("2")));
        assert_eq!(median(&[d("4"), d("1"), d("2"), d("3")]), Some(d("2.5")));
        assert_eq!(median(&[]), None);
        assert_eq!(powi(d("1.1"), 2), Some(d("1.21")));
        assert_eq!(powi(d("5"), 0), Some(Decimal::ONE));
    }
}
