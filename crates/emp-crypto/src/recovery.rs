//! BIP39 English 24-word recovery keys (SPEC §9.2, D-06) and the "type 3 random words" verification ceremony.
//!
//! Word input is forgiving: surrounding whitespace and case are ignored, and an unambiguous prefix of at least
//! four letters is expanded (every BIP39 English word is unique in its first four letters).

use bip39::{Language, Mnemonic};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::error::{CryptoError, RecoveryKeyError, Result};
use crate::hkdf_labels::KEK_RECOVERY;
use crate::keys::{KEY_LEN, Kek, RecoveryKey, VaultId, hkdf_into};
use crate::rng;

/// Number of words in a recovery key.
pub const WORD_COUNT: usize = 24;
/// Number of words the user must type back to confirm they saved the key.
pub const CHALLENGE_WORDS: usize = 3;
/// Minimum prefix length that is expanded to a full word.
pub const MIN_PREFIX_LEN: usize = 4;

/// The 24 words of a recovery key, zeroized on drop.
pub type RecoveryWords = Zeroizing<Vec<String>>;

/// Normalises one typed word: NFKC, trimmed, lowercase.
#[must_use]
pub fn normalize_word(word: &str) -> Zeroizing<String> {
    Zeroizing::new(word.trim().nfkc().flat_map(char::to_lowercase).collect())
}

/// Resolves a typed word (or unambiguous ≥ 4-letter prefix) to its BIP39 English word.
#[must_use]
pub fn resolve_word(word: &str) -> Option<&'static str> {
    let w = normalize_word(word);
    let lang = Language::English;
    if let Some(i) = lang.find_word(&w) {
        return lang.word_list().get(usize::from(i)).copied();
    }
    if w.len() >= MIN_PREFIX_LEN {
        if let [only] = lang.words_by_prefix(&w) {
            return Some(*only);
        }
    }
    None
}

/// Autocomplete helper: up to `limit` BIP39 English words starting with `prefix` (normalised).
#[must_use]
pub fn suggest_words(prefix: &str, limit: usize) -> Vec<&'static str> {
    let p = normalize_word(prefix);
    if p.is_empty() {
        return Vec::new();
    }
    Language::English
        .words_by_prefix(&p)
        .iter()
        .take(limit)
        .copied()
        .collect()
}

impl RecoveryKey {
    /// Generates a new random 256-bit recovery key.
    pub fn generate() -> Result<Self> {
        Self::random()
    }

    /// Parses 24 words (case-insensitive, prefixes of ≥ 4 letters accepted) and checks the BIP39 checksum.
    pub fn from_words<S: AsRef<str>>(words: &[S]) -> Result<Self> {
        if words.len() != WORD_COUNT {
            return Err(CryptoError::InvalidRecoveryKey(
                RecoveryKeyError::WrongWordCount { got: words.len() },
            ));
        }
        let mut phrase = Zeroizing::new(String::with_capacity(WORD_COUNT * 9));
        for (index, w) in words.iter().enumerate() {
            let resolved = resolve_word(w.as_ref()).ok_or(CryptoError::InvalidRecoveryKey(
                RecoveryKeyError::UnknownWord { index },
            ))?;
            if index > 0 {
                phrase.push(' ');
            }
            phrase.push_str(resolved);
        }
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, &phrase).map_err(|e| {
            CryptoError::InvalidRecoveryKey(match e {
                bip39::Error::UnknownWord(index) => RecoveryKeyError::UnknownWord { index },
                bip39::Error::BadWordCount(got) => RecoveryKeyError::WrongWordCount { got },
                _ => RecoveryKeyError::BadChecksum,
            })
        })?;
        let (entropy, len) = mnemonic.to_entropy_array();
        let entropy = Zeroizing::new(entropy);
        let bytes = entropy.get(..len).ok_or(CryptoError::Internal)?;
        if bytes.len() != KEY_LEN {
            return Err(CryptoError::InvalidRecoveryKey(
                RecoveryKeyError::WrongWordCount { got: WORD_COUNT },
            ));
        }
        Self::copy_from(bytes)
    }

    /// Parses a whitespace-separated phrase. See [`from_words`](Self::from_words).
    pub fn from_phrase(phrase: &str) -> Result<Self> {
        let words: Vec<&str> = phrase.split_whitespace().collect();
        Self::from_words(&words)
    }

    /// The 24 words (for the recovery ceremony, "Copy", "Save as file…", "Print").
    pub fn words(&self) -> Result<RecoveryWords> {
        let m = Mnemonic::from_entropy_in(Language::English, self.expose())
            .map_err(|_| CryptoError::Internal)?;
        Ok(Zeroizing::new(m.words().map(str::to_owned).collect()))
    }

    /// Checks the confirmation challenge: `words[i]` must be word number `positions[i]` (0-based).
    ///
    /// Requires exactly [`CHALLENGE_WORDS`] distinct in-range positions. The comparison does not short-circuit.
    #[must_use]
    pub fn verify_challenge<S: AsRef<str>>(&self, positions: &[usize], words: &[S]) -> bool {
        if positions.len() != CHALLENGE_WORDS || words.len() != CHALLENGE_WORDS {
            return false;
        }
        if !positions_are_valid(positions) {
            return false;
        }
        let Ok(all) = self.words() else { return false };
        let mut ok = subtle::Choice::from(1u8);
        for (&pos, typed) in positions.iter().zip(words) {
            let expected = all.get(pos).map_or("", String::as_str);
            let typed = resolve_word(typed.as_ref()).unwrap_or("");
            // Pad both to a fixed width so length differences do not short-circuit either.
            ok &= fixed_width(expected)
                .as_slice()
                .ct_eq(fixed_width(typed).as_slice());
        }
        bool::from(ok)
    }

    /// `KEK_rec = HKDF-SHA256(ikm = RK, salt = vault_id, info = "emp/v1/kek/recovery")`.
    pub(crate) fn derive_kek(&self, vault_id: &VaultId) -> Result<Kek> {
        Kek::fill_with(|out| hkdf_into(self.expose(), vault_id.as_bytes(), KEK_RECOVERY, out))
    }
}

fn fixed_width(word: &str) -> Zeroizing<[u8; 16]> {
    let mut out = Zeroizing::new([0u8; 16]);
    for (o, b) in out.iter_mut().zip(word.bytes()) {
        *o = b;
    }
    out
}

fn positions_are_valid(positions: &[usize]) -> bool {
    positions.iter().all(|&p| p < WORD_COUNT)
        && positions
            .iter()
            .enumerate()
            .all(|(i, p)| !positions.iter().skip(i + 1).any(|q| q == p))
}

/// Picks [`CHALLENGE_WORDS`] distinct random positions in `0..24`, sorted ascending (show them 1-based in the UI).
pub fn challenge_positions() -> Result<[usize; CHALLENGE_WORDS]> {
    let mut chosen: Vec<usize> = Vec::with_capacity(CHALLENGE_WORDS);
    while chosen.len() < CHALLENGE_WORDS {
        let p = usize::try_from(rng::uniform_u32(WORD_COUNT as u32)?)
            .map_err(|_| CryptoError::Internal)?;
        if !chosen.contains(&p) {
            chosen.push(p);
        }
    }
    chosen.sort_unstable();
    chosen.try_into().map_err(|_| CryptoError::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    // BIP39 test vector: 32 bytes of 0x00 → "abandon" × 23 + "art".
    fn zero_key() -> RecoveryKey {
        RecoveryKey::copy_from(&[0u8; 32]).unwrap()
    }

    #[test]
    fn bip39_vector() {
        let w = zero_key().words().unwrap();
        assert_eq!(w.len(), 24);
        assert!(w[..23].iter().all(|x| x == "abandon"));
        assert_eq!(w[23], "art");
        // 0x7f… vector from the BIP39 reference tests.
        let k = RecoveryKey::copy_from(&[0x7f; 32]).unwrap();
        let w = k.words().unwrap();
        assert_eq!(
            w.join(" "),
            "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth \
             useful legal winner thank year wave sausage worth title"
        );
    }

    #[test]
    fn roundtrip_and_forgiving_input() {
        let k = RecoveryKey::generate().unwrap();
        let w = k.words().unwrap();
        let k2 = RecoveryKey::from_words(&w).unwrap();
        assert_eq!(k.expose(), k2.expose());
        // Upper case, whitespace and 4-letter prefixes.
        let sloppy: Vec<String> = w
            .iter()
            .enumerate()
            .map(|(i, s)| {
                if i % 2 == 0 {
                    format!("  {}", s.to_uppercase())
                } else {
                    s[..4.min(s.len())].to_owned()
                }
            })
            .collect();
        let k3 = RecoveryKey::from_words(&sloppy).unwrap();
        assert_eq!(k.expose(), k3.expose());
        let k4 = RecoveryKey::from_phrase(&w.join("\n ")).unwrap();
        assert_eq!(k.expose(), k4.expose());
    }

    #[test]
    fn rejects_bad_input() {
        let w = zero_key().words().unwrap();
        assert_eq!(
            RecoveryKey::from_words(&w[..23]).err(),
            Some(CryptoError::InvalidRecoveryKey(
                RecoveryKeyError::WrongWordCount { got: 23 }
            ))
        );
        let mut bad = w.to_vec();
        bad[5] = "notaword".into();
        assert_eq!(
            RecoveryKey::from_words(&bad).err(),
            Some(CryptoError::InvalidRecoveryKey(
                RecoveryKeyError::UnknownWord { index: 5 }
            ))
        );
        // Ambiguous short prefix is not expanded.
        bad[5] = "ab".into();
        assert!(RecoveryKey::from_words(&bad).is_err());
        // Swapped valid word ⇒ checksum failure.
        let mut swapped = w.to_vec();
        swapped[23] = "abandon".into();
        assert_eq!(
            RecoveryKey::from_words(&swapped).err(),
            Some(CryptoError::InvalidRecoveryKey(
                RecoveryKeyError::BadChecksum
            ))
        );
        // 12-word phrases are not recovery keys.
        let twelve: Vec<&str> = std::iter::repeat_n("abandon", 11)
            .chain(["about"])
            .collect();
        assert!(RecoveryKey::from_words(&twelve).is_err());
    }

    #[test]
    fn challenge() {
        let k = RecoveryKey::generate().unwrap();
        let w = k.words().unwrap();
        let pos = challenge_positions().unwrap();
        assert!(pos.windows(2).all(|p| p[0] < p[1]) && pos.iter().all(|&p| p < 24));
        let typed: Vec<String> = pos.iter().map(|&p| w[p].to_uppercase()).collect();
        assert!(k.verify_challenge(&pos, &typed));
        let mut wrong = typed.clone();
        wrong[1] = if w[pos[1]] == "zoo" {
            "zone".into()
        } else {
            "zoo".into()
        };
        assert!(!k.verify_challenge(&pos, &wrong));
        // Duplicate / out-of-range positions and wrong counts are refused.
        assert!(!k.verify_challenge(&[0, 0, 1], &[&w[0], &w[0], &w[1]]));
        assert!(!k.verify_challenge(&[0, 1, 24], &[&w[0], &w[1], "x"]));
        assert!(!k.verify_challenge(&[0, 1], &[&w[0], &w[1]]));
        assert!(!k.verify_challenge(&[0, 1, 2], &[&w[0], &w[1]]));
    }

    #[test]
    fn suggestions_and_resolve() {
        assert_eq!(resolve_word(" Abandon "), Some("abandon"));
        assert_eq!(resolve_word("aban"), Some("abandon"));
        assert_eq!(resolve_word("aba"), None);
        assert_eq!(resolve_word("zzzz"), None);
        let s = suggest_words("ab", 3);
        assert_eq!(s, vec!["abandon", "ability", "able"]);
        assert!(suggest_words("", 5).is_empty());
    }

    #[test]
    fn kek_depends_on_vault() {
        let k = zero_key();
        let a = k.derive_kek(&VaultId::from_bytes([1; 16])).unwrap();
        let b = k.derive_kek(&VaultId::from_bytes([2; 16])).unwrap();
        assert_ne!(a.expose(), b.expose());
    }
}
