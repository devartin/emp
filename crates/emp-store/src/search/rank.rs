//! Ranking: BM25 over fields (titles boosted), fuzzy-title bonus and a mild recency boost.

/// BM25 `k1`.
pub const K1: f64 = 1.2;
/// BM25 `b`.
pub const B: f64 = 0.75;
/// Weight of title fields relative to body blocks.
pub const TITLE_BOOST: f64 = 3.0;
/// Weight of a prefix-expanded term relative to an exact one.
pub const PREFIX_WEIGHT: f64 = 0.8;
/// Divisor turning a nucleo score into a ranking bonus.
pub const FUZZY_DIVISOR: f64 = 40.0;
/// Maximum recency bonus.
pub const RECENCY_MAX: f64 = 0.5;
/// Recency half-life-ish constant (days).
pub const RECENCY_DAYS: f64 = 30.0;

/// Inverse document frequency.
#[must_use]
pub fn idf(n_docs: usize, df: usize) -> f64 {
    let n = n_docs as f64;
    let df = df as f64;
    (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
}

/// BM25 term score for one field.
#[must_use]
pub fn bm25(tf: u32, field_len: u32, avg_len: f64, idf: f64) -> f64 {
    let tf = f64::from(tf);
    let norm = 1.0 - B + B * f64::from(field_len.max(1)) / avg_len.max(1.0);
    idf * (tf * (K1 + 1.0)) / (tf + K1 * norm)
}

/// Bonus for recently edited documents.
#[must_use]
pub fn recency(now_ms: i64, updated_ms: i64) -> f64 {
    let age_days = ((now_ms - updated_ms).max(0) as f64) / 86_400_000.0;
    RECENCY_MAX * (-age_days / RECENCY_DAYS).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rarer_terms_and_shorter_fields_score_higher() {
        assert!(idf(100, 1) > idf(100, 50));
        assert!(bm25(1, 5, 20.0, 1.0) > bm25(1, 200, 20.0, 1.0));
        assert!(bm25(3, 20, 20.0, 1.0) > bm25(1, 20, 20.0, 1.0));
        assert!(recency(10 * 86_400_000, 10 * 86_400_000) > recency(400 * 86_400_000, 0));
    }
}
