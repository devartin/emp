//! Password policy helpers (SPEC §9.10): zxcvbn strength report, the new-password policy, a common-password
//! Bloom filter, the EFF passphrase generator and the online unlock backoff schedule.

use std::time::Duration;

use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::codec::Reader;
use crate::error::{CryptoError, Result};
use crate::kdf::{MAX_PASSWORD_BYTES, normalize_password};
use crate::rng;

/// Minimum length in characters (Unicode scalar values after NFKC).
pub const MIN_PASSWORD_CHARS: usize = 10;
/// Minimum zxcvbn score.
pub const MIN_SCORE: u8 = 3;
/// zxcvbn is super-linear in input length; only the first this-many characters are analysed
/// (longer passwords are not penalised: their score can only go up with more characters).
pub const ANALYSIS_MAX_CHARS: usize = 256;
/// Attacker speed assumed by the crack-time estimate (SPEC §9.10 table: 10^6 guesses/s).
pub const GUESSES_PER_SECOND_LOG10: f64 = 6.0;

/// The `password_strength` IPC result: `{ score, crackTime, warning?, suggestions, common }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordStrength {
    /// zxcvbn score 0–4.
    pub score: u8,
    /// Order-of-magnitude time to guess at 10^6 guesses per second, e.g. "3 days", "centuries".
    pub crack_time: String,
    /// zxcvbn warning, if any.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub warning: Option<String>,
    /// zxcvbn suggestions.
    pub suggestions: Vec<String>,
    /// The password is a known common/leaked password.
    pub common: bool,
}

/// Why a new password is not acceptable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PolicyViolation {
    /// Fewer than [`MIN_PASSWORD_CHARS`] characters.
    TooShort {
        /// Required minimum.
        min: usize,
    },
    /// More than 1024 bytes after NFKC.
    TooLong {
        /// Maximum bytes.
        max_bytes: usize,
    },
    /// zxcvbn score below [`MIN_SCORE`].
    TooWeak {
        /// Achieved score.
        score: u8,
        /// Required score.
        min: u8,
    },
    /// Found in the common-password list.
    Common,
}

/// Result of [`check_new_password`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyReport {
    /// Strength details (absent when the password was too long to analyse).
    pub strength: Option<PasswordStrength>,
    /// Every violated rule (empty ⇒ acceptable).
    pub violations: Vec<PolicyViolation>,
}

impl PolicyReport {
    /// `true` if the password satisfies every rule.
    #[must_use]
    pub fn is_acceptable(&self) -> bool {
        self.violations.is_empty()
    }
}

/// Human order-of-magnitude duration for `log10(seconds)`.
fn humanize_log10_seconds(log10_s: f64) -> String {
    if !log10_s.is_finite() || log10_s < 0.0 {
        return "less than a second".into();
    }
    let s = 10f64.powf(log10_s);
    const MIN: f64 = 60.0;
    const HOUR: f64 = 3600.0;
    const DAY: f64 = 86_400.0;
    const MONTH: f64 = DAY * 31.0;
    const YEAR: f64 = DAY * 365.25;
    let plural = |n: f64, unit: &str| {
        let n = n.round().max(1.0);
        if n == 1.0 {
            format!("1 {unit}")
        } else {
            format!("{n:.0} {unit}s")
        }
    };
    if s < MIN {
        plural(s, "second")
    } else if s < HOUR {
        plural(s / MIN, "minute")
    } else if s < DAY {
        plural(s / HOUR, "hour")
    } else if s < MONTH {
        plural(s / DAY, "day")
    } else if s < YEAR {
        plural(s / MONTH, "month")
    } else if s < YEAR * 1e3 {
        plural(s / YEAR, "year")
    } else if s < YEAR * 1e6 {
        format!("{:.0} thousand years", (s / YEAR / 1e3).round().max(1.0))
    } else if s < YEAR * 1e9 {
        format!("{:.0} million years", (s / YEAR / 1e6).round().max(1.0))
    } else {
        "billions of years".into()
    }
}

/// Estimates strength with zxcvbn (on the NFKC-normalised password). `user_inputs` are words to penalise
/// (workspace name, email…). `common` also consults `filter` when given.
pub fn password_strength(
    password: &SecretString,
    user_inputs: &[&str],
    filter: Option<&CommonPasswords>,
) -> Result<PasswordStrength> {
    let normalized = normalize_password(password)?;
    let analysed: Zeroizing<String> =
        Zeroizing::new(normalized.chars().take(ANALYSIS_MAX_CHARS).collect());
    let entropy = zxcvbn::zxcvbn(&analysed, user_inputs);
    let score = u8::from(entropy.score());
    let crack_time = humanize_log10_seconds(entropy.guesses_log10() - GUESSES_PER_SECOND_LOG10);
    let (warning, suggestions) = match entropy.feedback() {
        Some(f) => (
            f.warning().map(|w| w.to_string()),
            f.suggestions().iter().map(ToString::to_string).collect(),
        ),
        None => (None, Vec::new()),
    };
    let char_len = analysed.chars().count();
    let whole_dictionary_password = match entropy.sequence() {
        [m] => {
            m.i == 0
                && m.j + 1 == char_len
                && matches!(&m.pattern, zxcvbn::matching::patterns::MatchPattern::Dictionary(d)
                    // `DictionaryType` is not exported by zxcvbn; its `Default` is the `Passwords` list.
                    if d.dictionary_name == Default::default())
        }
        _ => false,
    };
    let in_filter = filter.is_some_and(|f| f.contains_normalized(&normalized));
    Ok(PasswordStrength {
        score,
        crack_time,
        warning,
        suggestions,
        common: whole_dictionary_password || in_filter,
    })
}

/// Checks a new password against every §9.10 rule (score ≥ 3, ≥ 10 characters, ≤ 1024 bytes after NFKC,
/// not common). Any Unicode is allowed.
pub fn check_new_password(
    password: &SecretString,
    user_inputs: &[&str],
    filter: Option<&CommonPasswords>,
) -> PolicyReport {
    let strength = match password_strength(password, user_inputs, filter) {
        Ok(s) => s,
        Err(_) => {
            return PolicyReport {
                strength: None,
                violations: vec![PolicyViolation::TooLong {
                    max_bytes: MAX_PASSWORD_BYTES,
                }],
            };
        }
    };
    let mut violations = Vec::new();
    let chars = normalize_password(password)
        .map(|n| n.chars().count())
        .unwrap_or(0);
    if chars < MIN_PASSWORD_CHARS {
        violations.push(PolicyViolation::TooShort {
            min: MIN_PASSWORD_CHARS,
        });
    }
    if strength.score < MIN_SCORE {
        violations.push(PolicyViolation::TooWeak {
            score: strength.score,
            min: MIN_SCORE,
        });
    }
    if strength.common {
        violations.push(PolicyViolation::Common);
    }
    PolicyReport {
        strength: Some(strength),
        violations,
    }
}

/// A Bloom filter of common passwords (`resources/common-passwords.bloom`).
///
/// File format: `"EMPBLM\0\x01" || u8 k || u64be m_bits || bitset[ceil(m/8)]`. Items are NFKC-normalised,
/// lowercased and hashed as `SHA-256("EMP-BLOOM-v1" || item)`; probe `i` is `(h1 + i·h2) mod m`
/// (Kirsch–Mitzenmacher double hashing, `h1`/`h2` = the first two big-endian u64 of the digest, `h2 |= 1`).
#[derive(Clone, PartialEq, Eq)]
pub struct CommonPasswords {
    k: u8,
    m_bits: u64,
    bits: Vec<u8>,
}

impl std::fmt::Debug for CommonPasswords {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CommonPasswords(k={}, m={} bits)", self.k, self.m_bits)
    }
}

const BLOOM_MAGIC: &[u8; 8] = b"EMPBLM\0\x01";
/// Largest accepted Bloom filter (64 Mbit = 8 MiB).
pub const MAX_BLOOM_BITS: u64 = 64 * 1024 * 1024;

fn bloom_item(s: &str) -> Zeroizing<String> {
    let norm = normalize_password(&SecretString::from(s.to_owned()))
        .unwrap_or_else(|_| Zeroizing::new(String::new()));
    Zeroizing::new(norm.chars().flat_map(char::to_lowercase).collect())
}

fn bloom_hashes(item: &str) -> (u64, u64) {
    let d: [u8; 32] = Sha256::new()
        .chain_update(b"EMP-BLOOM-v1")
        .chain_update(item.as_bytes())
        .finalize()
        .into();
    let mut a = [0u8; 8];
    let mut b = [0u8; 8];
    a.copy_from_slice(d.get(..8).unwrap_or(&[0; 8]));
    b.copy_from_slice(d.get(8..16).unwrap_or(&[0; 8]));
    (u64::from_be_bytes(a), u64::from_be_bytes(b) | 1)
}

impl CommonPasswords {
    /// Builds a filter for `items` at false-positive rate `fp_rate` (e.g. `1e-6`).
    pub fn build<'a>(
        items: impl IntoIterator<Item = &'a str> + Clone,
        fp_rate: f64,
    ) -> Result<Self> {
        if !(fp_rate > 0.0 && fp_rate < 1.0) {
            return Err(CryptoError::InvalidArgument("fp_rate must be in (0, 1)"));
        }
        let n = items.clone().into_iter().count().max(1) as f64;
        let ln2 = std::f64::consts::LN_2;
        let m = (-(n * fp_rate.ln()) / (ln2 * ln2)).ceil().max(64.0);
        if m > MAX_BLOOM_BITS as f64 {
            return Err(CryptoError::TooLarge("bloom filter"));
        }
        let m_bits = m as u64;
        let k = ((m / n) * ln2).round().clamp(1.0, 32.0) as u8;
        let len = usize::try_from(m_bits.div_ceil(8))
            .map_err(|_| CryptoError::TooLarge("bloom filter"))?;
        let mut f = Self {
            k,
            m_bits,
            bits: vec![0u8; len],
        };
        for item in items {
            f.insert(&bloom_item(item));
        }
        Ok(f)
    }

    fn positions(&self, item: &str) -> impl Iterator<Item = u64> + '_ {
        let (h1, h2) = bloom_hashes(item);
        (0..u64::from(self.k)).map(move |i| h1.wrapping_add(i.wrapping_mul(h2)) % self.m_bits)
    }

    fn insert(&mut self, item: &str) {
        let pos: Vec<u64> = self.positions(item).collect();
        for p in pos {
            if let Some(byte) = usize::try_from(p / 8)
                .ok()
                .and_then(|i| self.bits.get_mut(i))
            {
                *byte |= 1 << (p % 8);
            }
        }
    }

    fn contains_normalized(&self, normalized: &str) -> bool {
        let item: Zeroizing<String> =
            Zeroizing::new(normalized.chars().flat_map(char::to_lowercase).collect());
        self.positions(&item).all(|p| {
            usize::try_from(p / 8)
                .ok()
                .and_then(|i| self.bits.get(i))
                .is_some_and(|b| b & (1 << (p % 8)) != 0)
        })
    }

    /// `true` if `password` is (probably) in the list.
    #[must_use]
    pub fn contains(&self, password: &str) -> bool {
        self.contains_normalized(&bloom_item(password))
    }

    /// Serialises the filter.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(17 + self.bits.len());
        out.extend_from_slice(BLOOM_MAGIC);
        out.push(self.k);
        out.extend_from_slice(&self.m_bits.to_be_bytes());
        out.extend_from_slice(&self.bits);
        out
    }

    /// Parses a serialised filter (validates magic, `k`, size bounds and exact length).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader::new(bytes, "bloom filter");
        if r.array::<8>()? != *BLOOM_MAGIC {
            return Err(CryptoError::Malformed("bloom filter"));
        }
        let k = r.u8()?;
        let m_bits = r.u64be()?;
        if k == 0 || k > 32 || m_bits == 0 || m_bits > MAX_BLOOM_BITS {
            return Err(CryptoError::Malformed("bloom filter"));
        }
        let len = usize::try_from(m_bits.div_ceil(8))
            .map_err(|_| CryptoError::Malformed("bloom filter"))?;
        let bits = r.take(len)?.to_vec();
        r.finish()?;
        Ok(Self { k, m_bits, bits })
    }
}

/// A generated passphrase (`password_generate` IPC result).
pub struct GeneratedPassphrase {
    /// The passphrase; zeroized on drop.
    pub passphrase: Zeroizing<String>,
    /// Entropy in bits from the word choices (separator not counted): `5 · log2(7776) ≈ 64.6`.
    pub bits: f64,
}

impl std::fmt::Debug for GeneratedPassphrase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GeneratedPassphrase([REDACTED], {:.1} bits)", self.bits)
    }
}

/// The EFF Long Wordlist (CC BY 3.0 US, Electronic Frontier Foundation), one word per line. See `data/README.md`.
const EFF_LONG_WORDLIST: &str = include_str!("../data/eff_large_wordlist.txt");
/// Number of words in the EFF Long Wordlist.
const EFF_LONG_WORDLIST_LEN: usize = 7776;

/// Returns word `idx` (0-based) of the EFF Long Wordlist.
fn eff_word(idx: usize) -> Option<&'static str> {
    EFF_LONG_WORDLIST.lines().nth(idx)
}

/// Number of words in a generated passphrase.
pub const PASSPHRASE_WORDS: usize = 5;
/// Separators the generator picks from.
pub const PASSPHRASE_SEPARATORS: [char; 5] = ['-', '.', '_', '/', ' '];

/// Generates 5 EFF-long-list words joined by one random separator from `- . _ / space` (OS CSPRNG,
/// unbiased).
pub fn generate_passphrase() -> Result<GeneratedPassphrase> {
    let n = u32::try_from(EFF_LONG_WORDLIST_LEN).map_err(|_| CryptoError::Internal)?;
    let sep_idx = rng::uniform_u32(PASSPHRASE_SEPARATORS.len() as u32)? as usize;
    let sep = *PASSPHRASE_SEPARATORS
        .get(sep_idx)
        .ok_or(CryptoError::Internal)?;
    let mut out = Zeroizing::new(String::with_capacity(64));
    for i in 0..PASSPHRASE_WORDS {
        let idx = rng::uniform_u32(n)? as usize;
        let word = eff_word(idx).ok_or(CryptoError::Internal)?;
        if i > 0 {
            out.push(sep);
        }
        out.push_str(word);
    }
    Ok(GeneratedPassphrase {
        passphrase: out,
        bits: PASSPHRASE_WORDS as f64 * f64::from(n).log2(),
    })
}

/// Number of failures allowed before delays start.
pub const BACKOFF_FREE_FAILURES: u32 = 4;
/// Maximum enforced delay.
pub const BACKOFF_MAX: Duration = Duration::from_secs(300);

/// Delay to enforce before returning the result of the attempt after `failures` consecutive failures
/// (SPEC §9.10): failures 1–4 → 0; 5 → 1 s; then doubling (2, 4, 8 s…) capped at 300 s.
#[must_use]
pub fn unlock_backoff(failures: u32) -> Duration {
    if failures <= BACKOFF_FREE_FAILURES {
        return Duration::ZERO;
    }
    let exp = failures - BACKOFF_FREE_FAILURES - 1;
    if exp >= 9 {
        return BACKOFF_MAX; // 2^9 = 512 s > 300 s
    }
    Duration::from_secs(1u64 << exp).min(BACKOFF_MAX)
}

/// `lockout_until` (unix ms) to persist in `vault_meta` after `failures` consecutive failures at `now_ms`.
#[must_use]
pub fn lockout_until(now_ms: i64, failures: u32) -> i64 {
    let delay = i64::try_from(unlock_backoff(failures).as_millis()).unwrap_or(i64::MAX);
    now_ms.saturating_add(delay)
}

/// Remaining wait (for `RATE_LIMITED { retryAfterMs }`), zero if `lockout_until_ms` has passed.
///
/// Capped at [`BACKOFF_MAX`]: a lockout is never set more than 300 s ahead, so a larger remainder means the wall
/// clock moved backwards (or `vault_meta` was edited) and must not lock the user out for longer than the policy.
#[must_use]
pub fn retry_after_ms(now_ms: i64, lockout_until_ms: i64) -> u64 {
    let max = u64::try_from(BACKOFF_MAX.as_millis()).unwrap_or(u64::MAX);
    u64::try_from(lockout_until_ms.saturating_sub(now_ms))
        .unwrap_or(0)
        .min(max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pw(s: &str) -> SecretString {
        SecretString::from(s.to_owned())
    }

    #[test]
    fn strength_levels() {
        let weak = password_strength(&pw("password"), &[], None).unwrap();
        assert!(weak.score <= 1);
        assert!(weak.common);
        assert!(weak.warning.is_some());
        let strong =
            password_strength(&pw("correct-horse-battery-staple-orbit"), &[], None).unwrap();
        assert!(strong.score >= 3);
        assert!(!strong.common);
        assert_ne!(strong.crack_time, "less than a second");
        // User inputs are penalised.
        let a = password_strength(&pw("emp-workspace-acme"), &["acme", "workspace"], None).unwrap();
        let b = password_strength(&pw("emp-workspace-acme"), &[], None).unwrap();
        assert!(a.score <= b.score);
    }

    #[test]
    fn json_shape() {
        let s = password_strength(&pw("password"), &[], None).unwrap();
        let v = serde_json::to_value(&s).unwrap();
        assert!(
            v.get("crackTime").is_some()
                && v.get("suggestions").is_some()
                && v.get("common").is_some()
        );
        let s = PasswordStrength {
            score: 4,
            crack_time: "x".into(),
            warning: None,
            suggestions: vec![],
            common: false,
        };
        assert!(serde_json::to_value(&s).unwrap().get("warning").is_none());
    }

    #[test]
    fn policy() {
        let r = check_new_password(&pw("short"), &[], None);
        assert!(
            r.violations
                .contains(&PolicyViolation::TooShort { min: 10 })
        );
        assert!(!r.is_acceptable());
        let r = check_new_password(&pw("password12"), &[], None);
        assert!(
            r.violations
                .iter()
                .any(|v| matches!(v, PolicyViolation::TooWeak { .. }))
        );
        let r = check_new_password(&pw("glacier-tunnel-pepper-ivory"), &[], None);
        assert!(r.is_acceptable(), "{r:?}");
        let r = check_new_password(&pw(&"a".repeat(1025)), &[], None);
        assert_eq!(
            r.violations,
            vec![PolicyViolation::TooLong { max_bytes: 1024 }]
        );
        // Any Unicode is fine (and counted in characters, not bytes).
        let r = check_new_password(&pw("日本語のとても長いパスフレーズ森"), &[], None);
        assert!(
            !r.violations
                .contains(&PolicyViolation::TooShort { min: 10 })
        );
        // Very long passwords are analysed quickly (truncated analysis).
        let start = std::time::Instant::now();
        let _ = password_strength(&pw(&"ab1!".repeat(250)), &[], None).unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn bloom() {
        let list = ["123456", "Password", "qwerty", "letmein", "dragon"];
        let f = CommonPasswords::build(list.iter().copied(), 1e-6).unwrap();
        for p in list {
            assert!(f.contains(p));
        }
        assert!(f.contains("password")); // case-folded
        assert!(!f.contains("glacier-tunnel-pepper-ivory"));
        let f2 = CommonPasswords::from_bytes(&f.to_bytes()).unwrap();
        assert_eq!(f, f2);
        let r = check_new_password(&pw("Letmein"), &[], Some(&f2));
        assert!(r.violations.contains(&PolicyViolation::Common));
        // A strong password that happens to be in the list is still refused.
        let g = CommonPasswords::build(["glacier-tunnel-pepper-ivory"], 1e-6).unwrap();
        let r = check_new_password(&pw("glacier-tunnel-pepper-ivory"), &[], Some(&g));
        assert_eq!(r.violations, vec![PolicyViolation::Common]);
        // Malformed inputs.
        let bytes = f.to_bytes();
        assert!(CommonPasswords::from_bytes(&bytes[..bytes.len() - 1]).is_err());
        let mut bad_k = bytes.clone();
        bad_k[8] = 0;
        assert!(CommonPasswords::from_bytes(&bad_k).is_err());
        assert!(CommonPasswords::from_bytes(b"garbage").is_err());
        assert!(CommonPasswords::build(["x"], 0.0).is_err());
    }

    #[test]
    fn bloom_false_positive_rate() {
        let items: Vec<String> = (0..2000).map(|i| format!("pw{i}")).collect();
        let f = CommonPasswords::build(items.iter().map(String::as_str), 1e-4).unwrap();
        let fps = (0..20_000)
            .filter(|i| f.contains(&format!("other{i}")))
            .count();
        assert!(fps <= 10, "fps = {fps}");
    }

    #[test]
    fn passphrase() {
        let p = generate_passphrase().unwrap();
        assert!((p.bits - 64.6).abs() < 0.1);
        let sep = PASSPHRASE_SEPARATORS
            .iter()
            .find(|c| p.passphrase.contains(**c))
            .copied();
        let words: Vec<&str> = match sep {
            Some(c) => p.passphrase.split(c).collect(),
            None => vec![],
        };
        // A word may itself contain '-' (EFF long list has a few), so allow ≥ 5 parts.
        assert!(words.len() >= 5, "{:?}", p);
        assert!(!format!("{p:?}").contains(p.passphrase.as_str()));
        assert_ne!(generate_passphrase().unwrap().passphrase, p.passphrase);
        assert_eq!(EFF_LONG_WORDLIST.lines().count(), EFF_LONG_WORDLIST_LEN);
        assert_eq!(eff_word(0), Some("abacus"));
        assert_eq!(eff_word(7775), Some("zoom"));
        assert!(
            EFF_LONG_WORDLIST
                .lines()
                .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'))
        );
    }

    #[test]
    fn backoff_schedule() {
        let s = |n| unlock_backoff(n).as_secs();
        assert_eq!([s(0), s(1), s(4)], [0, 0, 0]);
        assert_eq!([s(5), s(6), s(7), s(8)], [1, 2, 4, 8]);
        assert_eq!(s(13), 256);
        assert_eq!(s(14), 300);
        assert_eq!(s(u32::MAX), 300);
        assert_eq!(lockout_until(1000, 5), 2000);
        assert_eq!(retry_after_ms(1500, 2000), 500);
        assert_eq!(retry_after_ms(2500, 2000), 0);
        // Regression: a clock that jumped back a day (or a hand-edited lockout_until) must not lock the vault for a
        // day; the remainder is capped at the 300 s policy maximum.
        assert_eq!(retry_after_ms(0, 86_400_000), 300_000);
        assert_eq!(retry_after_ms(i64::MIN, i64::MAX), 300_000);
    }

    #[test]
    fn humanize() {
        assert_eq!(humanize_log10_seconds(-3.0), "less than a second");
        assert_eq!(humanize_log10_seconds(1.0), "10 seconds");
        assert_eq!(humanize_log10_seconds(5.3), "2 days");
        assert_eq!(humanize_log10_seconds(10.0), "317 years");
        assert_eq!(humanize_log10_seconds(13.73), "2 million years");
        assert_eq!(humanize_log10_seconds(11.0), "3 thousand years");
        assert_eq!(humanize_log10_seconds(19.0), "billions of years");
        assert_eq!(humanize_log10_seconds(f64::NAN), "less than a second");
    }
}
