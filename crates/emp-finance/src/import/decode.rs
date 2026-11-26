//! Text decoding (§9.16): UTF-8, UTF-16 with a BOM, otherwise detected with `chardetng` (Windows-1252 in
//! practice) and decoded with `encoding_rs`.

use encoding_rs::{Encoding, UTF_8, WINDOWS_1252};

/// Decodes `bytes` and returns the text and the encoding name. Never fails: malformed sequences become U+FFFD.
pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return (text.into_owned(), enc.name());
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), UTF_8.name());
    }
    if let Some(enc) = ofx_charset_hint(bytes) {
        let (text, _) = enc.decode_without_bom_handling(bytes);
        return (text.into_owned(), enc.name());
    }
    let mut det = chardetng::EncodingDetector::new();
    // Feeding a bounded prefix keeps detection cheap on very large files.
    let probe = &bytes[..bytes.len().min(1 << 20)];
    det.feed(probe, probe.len() == bytes.len());
    let guess = det.guess(None, true);
    // Only single-byte Western encodings or UTF-8 are expected from banks; anything else falls back to 1252.
    let enc = if guess == UTF_8
        || guess.name().starts_with("windows-125")
        || guess.name().starts_with("ISO-8859")
    {
        guess
    } else {
        WINDOWS_1252
    };
    let (text, _) = enc.decode_without_bom_handling(bytes);
    (text.into_owned(), enc.name())
}

/// OFX 1.x headers declare `CHARSET:1252` / `ENCODING:USASCII`; honour an explicit 1252 declaration.
fn ofx_charset_hint(bytes: &[u8]) -> Option<&'static Encoding> {
    let head = &bytes[..bytes.len().min(1024)];
    let head = String::from_utf8_lossy(head);
    if !head.trim_start().starts_with("OFXHEADER") {
        return None;
    }
    head.lines()
        .find_map(|l| l.trim().strip_prefix("CHARSET:"))
        .filter(|c| c.trim() == "1252")
        .map(|_| WINDOWS_1252)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_and_bom() {
        assert_eq!(decode("café".as_bytes()), ("café".to_string(), "UTF-8"));
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"a,b");
        assert_eq!(decode(&b).0, "a,b");
    }

    #[test]
    fn utf16_bom() {
        let mut b = vec![0xFF, 0xFE];
        for u in "Date,Amount".encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        let (t, e) = decode(&b);
        assert_eq!(t, "Date,Amount");
        assert_eq!(e, "UTF-16LE");
    }

    #[test]
    fn windows_1252() {
        // "Café Müller" in 1252
        let b = b"Date,Payee\n2026-01-01,Caf\xe9 M\xfcller r\xe9sum\xe9 na\xefve\n";
        let (t, e) = decode(b);
        assert!(t.contains("Café Müller"), "{t}");
        assert!(
            e.starts_with("windows-125") || e.starts_with("ISO-8859"),
            "{e}"
        );
    }
}
