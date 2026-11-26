//! Payee normalisation (§15.2) and the payee alias table.
//!
//! The SPEC regexes are applied in order, case-insensitively. The sixth (city and state) is applied with
//! two safety constraints so it cannot eat a merchant name: the final token must be a real US state or
//! Canadian province code, and the "city" is at most two words, preferring the split that leaves at least
//! two words (or a store number) of merchant name in front of it.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

fn ci(pattern: &str) -> Regex {
    // These patterns are compile-time constants; a failure here is a programming error caught by tests.
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .expect("valid static regex")
}

static R1: LazyLock<Regex> =
    LazyLock::new(|| ci(r"^(POS|DEBIT|PURCHASE|CHECKCARD|ACH|RECURRING|CARD PURCHASE)\s+"));
static R2: LazyLock<Regex> = LazyLock::new(|| ci(r"^(SQ \*|TST\* |SP \*|PAYPAL \*|PP\*)"));
static R3: LazyLock<Regex> = LazyLock::new(|| ci(r"[X*]{4,}\d{4}"));
static R4: LazyLock<Regex> = LazyLock::new(|| ci(r"#\d{3,}"));
static R5: LazyLock<Regex> = LazyLock::new(|| ci(r"\s+\d{2}/\d{2}(/\d{2,4})?"));
static CITY_WORD: LazyLock<Regex> = LazyLock::new(|| ci(r"^[A-Z][A-Z.'-]*$"));

const REGIONS: &[&str] = &[
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
    "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
    "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC", "PR", "VI", "GU", "AS", "MP", "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU",
    "ON", "PE", "QC", "SK", "YT",
];

/// Normalises a raw bank description into a display payee ("SQ *BLUE BOTTLE #1234 OAKLAND CA" → "Blue Bottle").
pub fn normalize(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    // Rule 1 may stack ("POS DEBIT ..."), so apply it until it no longer matches.
    for _ in 0..4 {
        let next = R1.replace(&s, "").into_owned();
        if next == s {
            break;
        }
        s = next;
    }
    s = R2.replace(&s, "").into_owned();
    // Removed noise leaves a boundary marker so the city rule knows where the merchant name ended.
    s = R3.replace_all(&s, MARK_SP).into_owned();
    s = R4.replace_all(&s, MARK_SP).into_owned();
    s = R5.replace_all(&s, MARK_SP).into_owned();
    s = strip_city_state(&s).replace(MARK, " ");
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let out =
        title_case(collapsed.trim_matches(|c: char| c == '*' || c == '-' || c.is_whitespace()));
    if out.is_empty() {
        title_case(
            raw.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .as_str(),
        )
    } else {
        out
    }
}

const MARK: char = '\u{1}';
const MARK_SP: &str = " \u{1} ";

fn has_digits(t: &str) -> bool {
    t.chars().any(|c| c.is_ascii_digit() || c == MARK)
}

fn is_noise_token(t: &str) -> bool {
    t == "\u{1}" || (t.len() >= 3 && t.chars().all(|c| c.is_ascii_digit()))
}

fn strip_city_state(s: &str) -> String {
    let tokens: Vec<&str> = s.split_whitespace().collect();
    let n = tokens.len();
    if n < 3 {
        return s.to_string();
    }
    let last = tokens[n - 1];
    if last.len() != 2 || !REGIONS.contains(&last.to_ascii_uppercase().as_str()) {
        return s.to_string();
    }
    // Candidate city starts, leftmost first: city = tokens[i..n-1], 1–2 words, letters only.
    let candidates: Vec<usize> = (n.saturating_sub(3)..n - 1)
        .filter(|&i| i >= 1 && tokens[i..n - 1].iter().all(|w| CITY_WORD.is_match(w)))
        .collect();
    let good = |i: &usize| *i >= 2 || has_digits(tokens[i - 1]);
    let Some(start) = candidates
        .iter()
        .copied()
        .find(good)
        .or_else(|| candidates.last().copied())
    else {
        return s.to_string();
    };
    let mut prefix: Vec<&str> = tokens[..start].to_vec();
    // A bare store number right before the city goes too ("STARBUCKS 12345 SEATTLE WA").
    while prefix.len() > 1 && prefix.last().is_some_and(|t| is_noise_token(t)) {
        prefix.pop();
    }
    prefix.join(" ")
}

/// Title-cases words: first letter upper, the rest lower ("JOE'S" → "Joe's").
pub fn title_case(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            let mut out = String::with_capacity(w.len());
            let mut first = true;
            for c in w.chars() {
                if first && c.is_alphabetic() {
                    out.extend(c.to_uppercase());
                    first = false;
                } else {
                    out.extend(c.to_lowercase());
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Key used for grouping and alias lookups: lowercase, whitespace-collapsed.
pub fn payee_key(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// A payee alias target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayeeRef {
    /// Payee row id.
    pub payee_id: String,
    /// Display name.
    pub name: String,
    /// Default category, if set on the payee row.
    #[serde(default)]
    pub default_category_id: Option<String>,
}

/// Maps raw strings (or normalised names) to payee rows.
#[derive(Debug, Clone, Default)]
pub struct PayeeAliases {
    map: HashMap<String, PayeeRef>,
}

impl PayeeAliases {
    /// Empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `alias` (raw or normalised text) for `payee`.
    pub fn insert(&mut self, alias: &str, payee: PayeeRef) {
        self.map.insert(payee_key(alias), payee);
    }

    /// Resolves a raw description: exact raw alias first, then the normalised name.
    pub fn resolve(&self, raw: &str) -> Option<&PayeeRef> {
        self.map
            .get(&payee_key(raw))
            .or_else(|| self.map.get(&payee_key(&normalize(raw))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_rules() {
        assert_eq!(
            normalize("POS STARBUCKS STORE 12345 SEATTLE WA"),
            "Starbucks Store"
        );
        assert_eq!(
            normalize("SQ *BLUE BOTTLE COFFEE #1234 OAKLAND CA"),
            "Blue Bottle Coffee"
        );
        assert_eq!(normalize("CHECKCARD AMAZON.COM XXXX1234"), "Amazon.com");
        assert_eq!(normalize("PAYPAL *SPOTIFY 01/15"), "Spotify");
        assert_eq!(normalize("ACH DEBIT NETFLIX.COM 12/31/2026"), "Netflix.com");
        assert_eq!(normalize("TRADER JOE'S #552 BROOKLYN NY"), "Trader Joe's");
        assert_eq!(
            normalize("CARD PURCHASE WHOLEFDS MKT 10234 AUSTIN TX"),
            "Wholefds Mkt"
        );
        assert_eq!(normalize("TST* SHAKE SHACK"), "Shake Shack");
        assert_eq!(normalize("Payroll Deposit"), "Payroll Deposit");
    }

    #[test]
    fn city_rule_is_conservative() {
        // "XX" is not a region code → nothing stripped.
        assert_eq!(normalize("ACME WIDGETS XX"), "Acme Widgets Xx");
        // Two words only: never strip down to nothing.
        assert_eq!(normalize("SHELL TX"), "Shell Tx");
        assert_eq!(normalize("UBER 8005928996 SAN FRANCISCO CA"), "Uber");
    }

    #[test]
    fn never_empty() {
        assert_eq!(normalize("POS #12345"), "Pos #12345");
        assert_eq!(title_case("hello WORLD"), "Hello World");
    }

    #[test]
    fn aliases() {
        let mut a = PayeeAliases::new();
        a.insert(
            "Starbucks Store",
            PayeeRef {
                payee_id: "p1".into(),
                name: "Starbucks".into(),
                default_category_id: None,
            },
        );
        assert_eq!(
            a.resolve("POS STARBUCKS STORE 999 SEATTLE WA")
                .unwrap()
                .payee_id,
            "p1"
        );
        assert!(a.resolve("Dunkin").is_none());
    }
}
