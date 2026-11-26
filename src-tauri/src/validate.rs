//! Input validation shared by every command (SPEC §11.1 "Validation").
//!
//! The workspace crates validate again where it matters; these checks bound inputs at the IPC edge so oversized or
//! malformed requests are rejected with `INVALID` (naming the field) before any work is done.

use crate::error::{ApiError, ApiResult};

/// Titles and labels: at most 1,024 characters.
pub const MAX_TITLE: usize = 1_024;
/// Search and filter queries: at most 512 characters.
pub const MAX_QUERY: usize = 512;
/// Formulas: at most 8,192 characters.
pub const MAX_FORMULA: usize = 8_192;
/// URLs: at most 4,096 characters.
pub const MAX_URL: usize = 4_096;
/// List pages: at most 1,000 items.
pub const MAX_LIST: usize = 1_000;
/// Query windows: at most 500 rows.
pub const MAX_WINDOW: usize = 500;
/// Passwords and passphrases on the wire (the KDF enforces 1,024 bytes after NFKC).
pub const MAX_PASSWORD_CHARS: usize = 4_096;
/// Secret values (`secret_set`).
pub const MAX_SECRET_CHARS: usize = 16_384;
/// Money values: at most 8 fractional digits (D-21).
pub const MAX_MONEY_SCALE: usize = 8;

/// Fails unless `s` has at most `max` characters.
pub fn bounded(field: &str, s: &str, max: usize) -> ApiResult<()> {
    if s.chars().count() > max {
        return Err(ApiError::invalid(
            field,
            format!("must be at most {max} characters"),
        ));
    }
    Ok(())
}

/// A non-empty string of at most `max` characters.
pub fn non_empty(field: &str, s: &str, max: usize) -> ApiResult<()> {
    if s.trim().is_empty() {
        return Err(ApiError::invalid(field, "must not be empty"));
    }
    bounded(field, s, max)
}

/// A title or label: at most 1,024 characters and no control characters.
pub fn title(field: &str, s: &str) -> ApiResult<()> {
    bounded(field, s, MAX_TITLE)?;
    if s.chars().any(char::is_control) {
        return Err(ApiError::invalid(
            field,
            "must not contain control characters",
        ));
    }
    Ok(())
}

/// A query (≤ 512 characters).
pub fn query(field: &str, s: &str) -> ApiResult<()> {
    bounded(field, s, MAX_QUERY)
}

/// A formula (≤ 8,192 characters).
pub fn formula(field: &str, s: &str) -> ApiResult<()> {
    bounded(field, s, MAX_FORMULA)
}

/// A record id (UUID-like text; see `emp_store::model::ids::is_record_id`).
pub fn id(field: &str, s: &str) -> ApiResult<()> {
    if emp_store::model::ids::is_record_id(s) {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "invalid id"))
    }
}

/// An optional record id.
pub fn opt_id(field: &str, s: Option<&str>) -> ApiResult<()> {
    s.map_or(Ok(()), |s| id(field, s))
}

/// A list of record ids: non-empty unless `allow_empty`, at most [`MAX_LIST`].
pub fn ids(field: &str, v: &[String], allow_empty: bool) -> ApiResult<()> {
    if v.is_empty() && !allow_empty {
        return Err(ApiError::invalid(field, "must not be empty"));
    }
    list_len(field, v.len(), MAX_LIST)?;
    v.iter().try_for_each(|s| id(field, s))
}

/// A list length bound.
pub fn list_len(field: &str, len: usize, max: usize) -> ApiResult<()> {
    if len > max {
        return Err(ApiError::invalid(
            field,
            format!("at most {max} items are allowed"),
        ));
    }
    Ok(())
}

/// A positive page size `1..=max`.
pub fn limit(field: &str, n: u32, max: usize) -> ApiResult<usize> {
    let n = n as usize;
    if n == 0 || n > max {
        return Err(ApiError::invalid(field, format!("must be 1–{max}")));
    }
    Ok(n)
}

/// A block id (12 characters of `[0-9A-Za-z_-]`).
pub fn block_id(field: &str, s: &str) -> ApiResult<()> {
    if emp_store::model::ids::is_block_id(s) {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "invalid block id"))
    }
}

/// An asset id (32 lowercase hex characters).
pub fn asset_id(field: &str, s: &str) -> ApiResult<()> {
    if emp_store::model::ids::is_asset_id(s) {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "invalid asset id"))
    }
}

/// A grant id (32 lowercase hex characters, 128 random bits).
pub fn grant_id(field: &str, s: &str) -> ApiResult<()> {
    if s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "invalid grant id"))
    }
}

/// A finite float.
pub fn finite(field: &str, x: f64) -> ApiResult<()> {
    if x.is_finite() {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "must be a finite number"))
    }
}

/// A money / decimal string: optional `-`, digits, optional `.` and at most 8 fractional digits (D-21).
pub fn money(field: &str, s: &str) -> ApiResult<()> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = digits.split_once('.').unwrap_or((digits, ""));
    let ok = !int.is_empty()
        && int.len() <= 20
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.len() <= MAX_MONEY_SCALE
        && frac.bytes().all(|b| b.is_ascii_digit())
        && !(digits.contains('.') && frac.is_empty());
    if ok {
        Ok(())
    } else {
        Err(ApiError::invalid(
            field,
            "must be a decimal string with at most 8 decimal places",
        ))
    }
}

/// A calendar date `YYYY-MM-DD`.
pub fn ymd(field: &str, s: &str) -> ApiResult<chrono::NaiveDate> {
    if s.len() != 10 {
        return Err(ApiError::invalid(field, "must be a date (YYYY-MM-DD)"));
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| ApiError::invalid(field, "must be a date (YYYY-MM-DD)"))
}

/// A unix-ms timestamp within a sane range (1970 … 9999).
pub fn ts(field: &str, t: i64) -> ApiResult<()> {
    if (0..=253_402_300_799_999).contains(&t) {
        Ok(())
    } else {
        Err(ApiError::invalid(field, "timestamp out of range"))
    }
}

/// A wire password: bounded length (the KDF rejects more than 1,024 bytes after NFKC).
pub fn password(field: &str, s: &str) -> ApiResult<()> {
    if s.is_empty() {
        return Err(ApiError::invalid(field, "must not be empty"));
    }
    bounded(field, s, MAX_PASSWORD_CHARS)
}

/// A UI kv namespace (`ui.<name>`, `[a-z0-9._-]`, ≤ 64 bytes) and key (≤ 256 characters).
pub fn kv_key(ns: &str, key: &str) -> ApiResult<()> {
    let name_ok = ns.len() <= 64
        && ns.strip_prefix("ui.").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
        });
    if !name_ok {
        return Err(ApiError::invalid(
            "ns",
            "only ui.* namespaces are accessible",
        ));
    }
    non_empty("key", key, 256)
}

/// Fails if a JSON value is larger than `max` bytes when serialised.
pub fn json_size(field: &str, v: &serde_json::Value, max: usize) -> ApiResult<()> {
    let n = serde_json::to_vec(v).map(|b| b.len()).unwrap_or(usize::MAX);
    if n > max {
        return Err(ApiError::new(
            crate::error::ErrorCode::TooLarge,
            format!("{field} is too large"),
        )
        .with_field(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_strings_by_characters() {
        assert!(title("title", &"é".repeat(1024)).is_ok());
        assert!(title("title", &"a".repeat(1025)).is_err());
        assert!(title("title", "line\nbreak").is_err());
        assert!(query("q", &"x".repeat(512)).is_ok());
        assert!(query("q", &"x".repeat(513)).is_err());
        assert!(formula("f", &"=".repeat(8193)).is_err());
    }

    #[test]
    fn validates_ids() {
        assert!(id("id", "0190f6c4-3b1e-7c3a-9d2e-1f2a3b4c5d6e").is_ok());
        assert!(id("id", "").is_err());
        assert!(id("id", "../etc/passwd").is_err());
        assert!(id("id", "UPPER").is_err());
        assert!(ids("ids", &[], false).is_err());
        assert!(ids("ids", &[], true).is_ok());
        let many = vec!["a".to_owned(); 1001];
        assert!(ids("ids", &many, false).is_err());
        assert!(block_id("blockId", "abcDEF012_-x").is_ok());
        assert!(block_id("blockId", "short").is_err());
        assert!(asset_id("id", &"a".repeat(32)).is_ok());
        assert!(asset_id("id", &"g".repeat(32)).is_err());
        assert!(grant_id("grantId", &"0".repeat(32)).is_ok());
        assert!(grant_id("grantId", "0").is_err());
    }

    #[test]
    fn validates_money() {
        for ok in ["0", "12", "-12.5", "1234.12345678", "0.1"] {
            assert!(money("amount", ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-",
            "1.",
            ".5",
            "1.123456789",
            "1e5",
            "NaN",
            "1,000",
            "+1",
            " 1",
        ] {
            assert!(money("amount", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn validates_numbers_dates_and_limits() {
        assert!(finite("x", 1.5).is_ok());
        assert!(finite("x", f64::NAN).is_err());
        assert!(finite("x", f64::INFINITY).is_err());
        assert!(ymd("date", "2026-11-26").is_ok());
        assert!(ymd("date", "2026-13-01").is_err());
        assert!(ymd("date", "2026-1-1").is_err());
        assert_eq!(limit("limit", 10, MAX_LIST).unwrap(), 10);
        assert!(limit("limit", 0, MAX_LIST).is_err());
        assert!(limit("limit", 1001, MAX_LIST).is_err());
        assert!(ts("at", 0).is_ok());
        assert!(ts("at", -1).is_err());
    }

    #[test]
    fn validates_kv_namespaces() {
        assert!(kv_key("ui.sidebar", "width").is_ok());
        assert!(kv_key("ui.", "k").is_err());
        assert!(kv_key("net.log", "k").is_err());
        assert!(kv_key("ui.Side", "k").is_err());
        assert!(kv_key("ui.nav", "").is_err());
    }

    #[test]
    fn reports_field_names() {
        let e = title("title", &"a".repeat(2000)).unwrap_err();
        assert_eq!(e.details.unwrap().field.as_deref(), Some("title"));
    }
}
