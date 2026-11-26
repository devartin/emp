//! Amount parsing (§15.2 Amounts): thousands separators, decimal commas, `(45.00)`, trailing minus,
//! `CR`/`DR` suffixes and currency symbols. Values are bounded to |x| < 10^15 with scale ≤ 8 (§9.16).

use rust_decimal::Decimal;

use crate::error::{FinanceError, Result};
use crate::money::{MAX_SCALE, amount_bound};

/// Parses an amount cell. `decimal_comma` selects `1.234,56` over `1,234.56` when only one separator kind
/// is present; when both appear, the right-most one is the decimal separator.
pub fn parse_amount(raw: &str, decimal_comma: bool) -> Result<Decimal> {
    let err = || FinanceError::parse(format!("invalid amount {raw:?}"));
    let mut s = raw.trim().trim_matches('"').trim().to_string();
    if s.is_empty() || s.len() > 64 {
        return Err(err());
    }
    let mut negative = false;
    let upper = s.to_ascii_uppercase();
    if upper.ends_with("CR") {
        s.truncate(s.len() - 2);
    } else if upper.ends_with("DR") {
        s.truncate(s.len() - 2);
        negative = true;
    }
    let mut s = s.trim().to_string();
    if s.len() >= 2 && s.starts_with('(') && s.ends_with(')') {
        negative = !negative;
        s = s[1..s.len() - 1].trim().to_string();
    }
    // Currency symbols/codes may only surround the number ("USD 12.50", "12,50 €").
    let is_deco = |c: char| c.is_alphabetic() || c.is_whitespace() || is_currency_symbol(c);
    let core = s.trim_matches(is_deco);
    let chars: Vec<char> = core.chars().collect();
    let mut body = String::with_capacity(chars.len());
    let mut sign_seen = false;
    for (i, &c) in chars.iter().enumerate() {
        match c {
            '0'..='9' | '.' | ',' => body.push(c),
            '-' | '\u{2212}' | '+' if !sign_seen && (i == 0 || i == chars.len() - 1) => {
                sign_seen = true;
                if c != '+' {
                    negative = !negative;
                }
            }
            '\'' | '_' | ' ' | '\u{a0}' | '\u{202f}' | '\u{2009}' => {}
            // A currency symbol between the sign and the digits ("-$5.00").
            c if is_currency_symbol(c) && body.is_empty() => {}
            _ => return Err(err()),
        }
    }
    if !body.bytes().any(|b| b.is_ascii_digit()) {
        return Err(err());
    }
    let last_dot = body.rfind('.');
    let last_comma = body.rfind(',');
    let decimal_sep = match (last_dot, last_comma) {
        (Some(d), Some(c)) => Some(if d > c { '.' } else { ',' }),
        (Some(_), None) => {
            // "1.234.567" with several dots is a dotted thousands format.
            // With decimal commas, "1.234" is a thousands-grouped integer.
            let dotted_thousands = body.matches('.').count() > 1
                || (decimal_comma && body.split('.').nth(1).is_some_and(|f| f.len() == 3));
            if dotted_thousands { None } else { Some('.') }
        }
        (None, Some(_)) => {
            if body.matches(',').count() > 1 {
                None
            } else if decimal_comma {
                Some(',')
            } else {
                None
            }
        }
        (None, None) => None,
    };
    let normalized: String = match decimal_sep {
        Some(sep) => {
            let thousands = if sep == '.' { ',' } else { '.' };
            body.chars()
                .filter(|c| *c != thousands)
                .map(|c| if c == sep { '.' } else { c })
                .collect()
        }
        None => body.chars().filter(|c| c.is_ascii_digit()).collect(),
    };
    let mut d = Decimal::from_str_exact(&normalized).map_err(|_| err())?;
    if d.scale() > MAX_SCALE {
        d = d.normalize();
        if d.scale() > MAX_SCALE {
            return Err(err());
        }
    }
    if d.abs() >= amount_bound() {
        return Err(FinanceError::parse(format!("amount out of range {raw:?}")));
    }
    Ok(if negative { -d } else { d })
}

fn is_currency_symbol(c: char) -> bool {
    matches!(
        c,
        '$' | '€'
            | '£'
            | '¥'
            | '₹'
            | '₩'
            | '₽'
            | '₺'
            | '₪'
            | '¢'
            | '฿'
            | '₫'
            | '₱'
            | '₴'
            | '₦'
    )
}

/// Detects decimal-comma formatting: ≥ 80% of non-empty values match `\d+,\d{2}$` (after stripping sign
/// decorations such as `)`, a trailing `-`, `CR`/`DR` and currency text).
pub fn detect_decimal_comma<'a, I: IntoIterator<Item = &'a str>>(values: I) -> bool {
    let mut total = 0usize;
    let mut hits = 0usize;
    for v in values {
        let t = v.trim();
        if t.is_empty() {
            continue;
        }
        total += 1;
        let core = t
            .trim_end_matches(|c: char| {
                c.is_alphabetic() || c.is_whitespace() || matches!(c, ')' | '-' | '€' | '$' | '£')
            })
            .as_bytes();
        let n = core.len();
        if n >= 4
            && core[n - 3] == b','
            && core[n - 2].is_ascii_digit()
            && core[n - 1].is_ascii_digit()
            && core[n - 4].is_ascii_digit()
        {
            hits += 1;
        }
    }
    total > 0 && hits * 100 >= total * 80
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str, dc: bool) -> String {
        parse_amount(s, dc)
            .map(|d| d.to_string())
            .unwrap_or_else(|_| "ERR".into())
    }

    #[test]
    fn formats() {
        assert_eq!(p("1,234.56", false), "1234.56");
        assert_eq!(p("-1,234.56", false), "-1234.56");
        assert_eq!(p("(45.00)", false), "-45.00");
        assert_eq!(p("45.00-", false), "-45.00");
        assert_eq!(p("45.00 CR", false), "45.00");
        assert_eq!(p("45.00DR", false), "-45.00");
        assert_eq!(p("$1,000", false), "1000");
        assert_eq!(p("USD 12.5", false), "12.5");
        assert_eq!(p("1.234,56", true), "1234.56");
        assert_eq!(
            p("1.234,56", false),
            "1234.56",
            "both separators: right-most is decimal"
        );
        assert_eq!(p("12,50 €", true), "12.50");
        assert_eq!(p("1 234,56", true), "1234.56");
        assert_eq!(p("1'234.50", false), "1234.50");
        assert_eq!(p("1.234", true), "1234");
        assert_eq!(p("−7.10", false), "-7.10");
        assert_eq!(p("+3", false), "3");
        assert_eq!(p("1,000,000", false), "1000000");
        assert_eq!(p("0.12345678", false), "0.12345678");
    }

    #[test]
    fn rejects() {
        for bad in [
            "",
            "abc",
            "1.2.3x?",
            "--5",
            "=1+2",
            "0.123456789",
            "1000000000000000",
            "1e5",
        ] {
            assert_eq!(p(bad, false), "ERR", "{bad}");
        }
    }

    #[test]
    fn decimal_comma_detection() {
        assert!(detect_decimal_comma([
            "12,50", "1.234,56", "-3,00", "4,10-"
        ]));
        assert!(!detect_decimal_comma(["12.50", "1,234.56", "3,00"]));
        assert!(!detect_decimal_comma(["", " "]));
    }
}
