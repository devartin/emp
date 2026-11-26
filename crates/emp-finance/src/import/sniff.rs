//! Format sniffing (§15.2): magic bytes first, then the file extension.

use super::ImportFormat;

/// Detects the statement format from the decoded text and the optional file name.
///
/// * OFX 1.x starts with `OFXHEADER:100` (a header-less `<OFX>` is also accepted).
/// * OFX 2.x starts with `<?xml` followed by `<?OFX`.
/// * QIF starts with `!Type:` (also `!Account` / `!Option:` preambles).
/// * Anything else is CSV.
///
/// OFX content is reported as QFX when the extension is `.qfx` or Intuit's `<INTU.BID>` tag is present.
pub fn sniff(text: &str, filename: Option<&str>) -> ImportFormat {
    let head: String = text
        .trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n'])
        .chars()
        .take(4096)
        .collect();
    let upper = head.to_ascii_uppercase();
    let ext = filename
        .and_then(|f| f.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
        .unwrap_or_default();
    let is_ofx = upper.starts_with("OFXHEADER:")
        || (upper.starts_with("<?XML") && upper.contains("<?OFX"))
        || upper.starts_with("<OFX>")
        || (matches!(ext.as_str(), "ofx" | "qfx") && upper.contains("<OFX>"));
    if is_ofx {
        return if ext == "qfx" || upper.contains("<INTU.BID>") {
            ImportFormat::Qfx
        } else {
            ImportFormat::Ofx
        };
    }
    if upper.starts_with("!TYPE:") || upper.starts_with("!ACCOUNT") || upper.starts_with("!OPTION:")
    {
        return ImportFormat::Qif;
    }
    ImportFormat::Csv
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic() {
        assert_eq!(
            sniff("OFXHEADER:100\nDATA:OFXSGML", None),
            ImportFormat::Ofx
        );
        assert_eq!(
            sniff(
                "OFXHEADER:100\n<OFX><SIGNONMSGSRSV1><INTU.BID>1",
                Some("x.ofx")
            ),
            ImportFormat::Qfx
        );
        assert_eq!(
            sniff("OFXHEADER:100", Some("Export.QFX")),
            ImportFormat::Qfx
        );
        assert_eq!(
            sniff("<?xml version=\"1.0\"?>\n<?OFX OFXHEADER=\"200\"?>", None),
            ImportFormat::Ofx
        );
        assert_eq!(
            sniff("<?xml version=\"1.0\"?><root/>", Some("a.ofx")),
            ImportFormat::Csv
        );
        assert_eq!(sniff("\n!Type:Bank\nD1/2/26", None), ImportFormat::Qif);
        assert_eq!(sniff("Date,Amount\n", Some("x.qif")), ImportFormat::Csv);
    }
}
