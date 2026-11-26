//! Pure conversions for Google data: colours → block colours (SPEC §3.4), Google Sheets
//! formulas → the EMP Excel dialect (SPEC §14.3, §17.1), A1 sheet-name quoting.

use serde::{Deserialize, Serialize};

/// EMP block colour names (SPEC §3.4). Stored by name, never by hex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockColor {
    /// gray
    Gray,
    /// brown
    Brown,
    /// orange
    Orange,
    /// yellow
    Yellow,
    /// green
    Green,
    /// blue
    Blue,
    /// purple
    Purple,
    /// pink
    Pink,
    /// red
    Red,
}

impl BlockColor {
    /// Lowercase name.
    pub fn as_str(self) -> &'static str {
        match self {
            BlockColor::Gray => "gray",
            BlockColor::Brown => "brown",
            BlockColor::Orange => "orange",
            BlockColor::Yellow => "yellow",
            BlockColor::Green => "green",
            BlockColor::Blue => "blue",
            BlockColor::Purple => "purple",
            BlockColor::Pink => "pink",
            BlockColor::Red => "red",
        }
    }
}

fn parse_hex(hex: &str) -> Option<(f64, f64, f64)> {
    let h = hex.trim().trim_start_matches('#');
    let h = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => h.to_string(),
        _ => return None,
    };
    let v = u32::from_str_radix(&h, 16).ok()?;
    Some((
        f64::from((v >> 16) & 0xff) / 255.0,
        f64::from((v >> 8) & 0xff) / 255.0,
        f64::from(v & 0xff) / 255.0,
    ))
}

/// (hue degrees, saturation, lightness)
fn hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d < 1e-9 {
        return (0.0, 0.0, l);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if (max - r).abs() < 1e-9 {
        60.0 * (((g - b) / d).rem_euclid(6.0))
    } else if (max - g).abs() < 1e-9 {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h, s, l)
}

/// Map any hex colour (Google calendar/event/text colours) to the nearest block colour by
/// hue, with low-saturation colours mapping to gray and dark desaturated oranges to brown.
/// Invalid input maps to blue (Google's default calendar colour family).
pub fn nearest_block_color(hex: &str) -> BlockColor {
    let Some((r, g, b)) = parse_hex(hex) else {
        return BlockColor::Blue;
    };
    let (h, s, l) = hsl(r, g, b);
    if s < 0.18 || l > 0.93 || l < 0.08 {
        return BlockColor::Gray;
    }
    if (10.0..45.0).contains(&h) && (s < 0.45 || l < 0.35) {
        return BlockColor::Brown;
    }
    match h {
        h if !(12.0..335.0).contains(&h) => BlockColor::Red,
        h if h < 40.0 => BlockColor::Orange,
        h if h < 65.0 => BlockColor::Yellow,
        h if h < 165.0 => BlockColor::Green,
        h if h < 245.0 => BlockColor::Blue,
        h if h < 290.0 => BlockColor::Purple,
        _ => BlockColor::Pink,
    }
}

/// Google Calendar event colour palette (`colorId` 1–11).
pub fn event_color_hex(color_id: &str) -> Option<&'static str> {
    Some(match color_id {
        "1" => "#a4bdfc",
        "2" => "#7ae7bf",
        "3" => "#dbadff",
        "4" => "#ff887c",
        "5" => "#fbd75b",
        "6" => "#ffb878",
        "7" => "#46d6db",
        "8" => "#e1e1e1",
        "9" => "#5484ed",
        "10" => "#51b749",
        "11" => "#dc2127",
        _ => return None,
    })
}

/// Quote a sheet title for an A1 range (`'My Sheet'`), doubling embedded quotes.
pub fn quote_sheet_title(title: &str) -> String {
    format!("'{}'", title.replace('\'', "''"))
}

/// Functions the EMP formula engine supports (SPEC §14.3, v1).
pub const SUPPORTED_FUNCTIONS: &[&str] = &[
    // Math
    "SUM", "SUMIF", "SUMIFS", "SUMPRODUCT", "SUMSQ", "PRODUCT", "QUOTIENT", "MOD", "ABS", "SIGN",
    "INT", "TRUNC", "ROUND", "ROUNDUP", "ROUNDDOWN", "MROUND", "CEILING", "CEILING.MATH", "FLOOR",
    "FLOOR.MATH", "EVEN", "ODD", "SQRT", "POWER", "EXP", "LN", "LOG", "LOG10", "PI", "RAND",
    "RANDBETWEEN", "GCD", "LCM", "FACT", "COMBIN", "PERMUT", "SUBTOTAL", "AGGREGATE", "DEGREES",
    "RADIANS", "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN", "ATAN2",
    // Statistical
    "AVERAGE", "AVERAGEA", "AVERAGEIF", "AVERAGEIFS", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF",
    "COUNTIFS", "MIN", "MAX", "MINA", "MAXA", "MINIFS", "MAXIFS", "MEDIAN", "MODE.SNGL", "STDEV.S",
    "STDEV.P", "STDEV", "VAR.S", "VAR.P", "LARGE", "SMALL", "RANK.EQ", "RANK.AVG",
    "PERCENTILE.INC", "PERCENTILE.EXC", "QUARTILE.INC", "PERCENTRANK.INC", "CORREL",
    "COVARIANCE.S", "SLOPE", "INTERCEPT", "RSQ", "FORECAST.LINEAR", "TREND", "GROWTH", "GEOMEAN",
    "NORM.DIST", "NORM.INV", "NORM.S.DIST",
    // Logical
    "IF", "IFS", "IFERROR", "IFNA", "AND", "OR", "NOT", "XOR", "SWITCH", "TRUE", "FALSE", "LET",
    // Lookup
    "VLOOKUP", "HLOOKUP", "XLOOKUP", "LOOKUP", "INDEX", "MATCH", "XMATCH", "CHOOSE", "OFFSET",
    "INDIRECT", "ROW", "ROWS", "COLUMN", "COLUMNS", "ADDRESS", "TRANSPOSE", "HYPERLINK",
    // Dynamic arrays
    "FILTER", "SORT", "SORTBY", "UNIQUE", "SEQUENCE", "RANDARRAY", "TAKE", "DROP", "CHOOSECOLS",
    "CHOOSEROWS", "VSTACK", "HSTACK", "TEXTSPLIT",
    // Text
    "CONCAT", "CONCATENATE", "TEXTJOIN", "LEFT", "RIGHT", "MID", "LEN", "FIND", "SEARCH",
    "SUBSTITUTE", "REPLACE", "UPPER", "LOWER", "PROPER", "TRIM", "CLEAN", "TEXT", "VALUE",
    "NUMBERVALUE", "FIXED", "DOLLAR", "EXACT", "REPT", "CHAR", "CODE", "UNICHAR", "UNICODE", "T",
    "TEXTBEFORE", "TEXTAFTER",
    // Date and time
    "TODAY", "NOW", "DATE", "TIME", "DATEVALUE", "TIMEVALUE", "YEAR", "MONTH", "DAY", "HOUR",
    "MINUTE", "SECOND", "WEEKDAY", "WEEKNUM", "ISOWEEKNUM", "EDATE", "EOMONTH", "DATEDIF", "DAYS",
    "DAYS360", "NETWORKDAYS", "NETWORKDAYS.INTL", "WORKDAY", "WORKDAY.INTL", "YEARFRAC",
    // Financial
    "PMT", "IPMT", "PPMT", "PV", "FV", "NPER", "RATE", "NPV", "XNPV", "IRR", "XIRR", "MIRR",
    "CUMIPMT", "CUMPRINC", "EFFECT", "NOMINAL", "SLN", "DB", "DDB", "SYD", "FVSCHEDULE",
    "PDURATION", "RRI",
    // Information
    "ISBLANK", "ISNUMBER", "ISTEXT", "ISNONTEXT", "ISLOGICAL", "ISERROR", "ISERR", "ISNA", "ISREF",
    "ISEVEN", "ISODD", "ISFORMULA", "NA", "N", "TYPE", "ERROR.TYPE",
    // EMP extensions
    "STOCK", "FX", "CRYPTO",
];

/// A Google formula translated to the EMP dialect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedFormula {
    /// Translated formula text (starts with `=`).
    pub text: String,
    /// Upper-case names of functions EMP does not support. When non-empty, keep the cached
    /// value and flag the cell "Unsupported function – value frozen at import".
    pub unsupported: Vec<String>,
}

impl MappedFormula {
    /// Whether every function is supported.
    pub fn is_supported(&self) -> bool {
        self.unsupported.is_empty()
    }
}

/// Translate a Google Sheets formula: `GOOGLEFINANCE(sym[, attr])` → `STOCK(sym[, field])`
/// (literal `"EXCH:TICKER"` symbols become `TICKER:MIC` symbol keys) and collect functions
/// outside [`SUPPORTED_FUNCTIONS`]. Text inside string literals is never touched.
pub fn map_google_formula(formula: &str) -> MappedFormula {
    let chars: Vec<char> = formula.chars().collect();
    let mut out = String::with_capacity(formula.len());
    let mut unsupported: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            let end = skip_string(&chars, i);
            out.extend(&chars[i..end]);
            i = end;
            continue;
        }
        if c == '\'' {
            // Quoted sheet name: copy verbatim.
            let mut j = i + 1;
            while j < chars.len() {
                if chars[j] == '\'' {
                    if chars.get(j + 1) == Some(&'\'') {
                        j += 2;
                        continue;
                    }
                    j += 1;
                    break;
                }
                j += 1;
            }
            out.extend(&chars[i..j.min(chars.len())]);
            i = j;
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_' || chars[j] == '.') {
                j += 1;
            }
            let name: String = chars[start..j].iter().collect();
            if chars.get(j) == Some(&'(') {
                let upper = name.to_ascii_uppercase();
                if upper == "GOOGLEFINANCE" {
                    if let Some((replacement, close)) = map_googlefinance(&chars, j) {
                        out.push_str(&replacement);
                        i = close + 1;
                        continue;
                    }
                    push_unique(&mut unsupported, upper);
                } else if !SUPPORTED_FUNCTIONS.contains(&upper.as_str()) {
                    push_unique(&mut unsupported, upper);
                }
            }
            out.push_str(&name);
            i = j;
            continue;
        }
        out.push(c);
        i += 1;
    }
    MappedFormula {
        text: out,
        unsupported,
    }
}

fn push_unique(v: &mut Vec<String>, s: String) {
    if !v.contains(&s) {
        v.push(s);
    }
}

/// Index just past the string literal starting at `start` (`""` escapes a quote).
fn skip_string(chars: &[char], start: usize) -> usize {
    let mut j = start + 1;
    while j < chars.len() {
        if chars[j] == '"' {
            if chars.get(j + 1) == Some(&'"') {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j += 1;
    }
    chars.len()
}

/// Split the argument list starting at `open` (the `(`). Returns args and the index of `)`.
fn split_args(chars: &[char], open: usize) -> Option<(Vec<String>, usize)> {
    let mut depth = 0usize;
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut i = open + 1;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' => {
                let end = skip_string(chars, i);
                cur.extend(&chars[i..end]);
                i = end;
                continue;
            }
            '(' | '{' => depth += 1,
            ')' | '}' if depth > 0 => depth -= 1,
            ')' => {
                args.push(cur.trim().to_string());
                return Some((args, i));
            }
            ',' if depth == 0 => {
                args.push(cur.trim().to_string());
                cur.clear();
                i += 1;
                continue;
            }
            _ => {}
        }
        cur.push(c);
        i += 1;
    }
    None
}

fn map_googlefinance(chars: &[char], open: usize) -> Option<(String, usize)> {
    let (args, close) = split_args(chars, open)?;
    if args.is_empty() || args.len() > 2 || args[0].is_empty() {
        return None; // historical form (start/end dates) is unsupported
    }
    let symbol = map_symbol_literal(&args[0]);
    let field = match args.get(1) {
        None => None,
        Some(a) => {
            let lit = string_literal(a)?;
            let mapped = match lit.to_ascii_lowercase().as_str() {
                "price" => "price",
                "priceopen" => "open",
                "high" => "high",
                "low" => "low",
                "volume" => "volume",
                "change" => "change",
                "changepct" => "changepct",
                "closeyest" => "prevclose",
                "currency" => "currency",
                "name" => "name",
                _ => return None,
            };
            Some(mapped)
        }
    };
    let text = match field {
        Some(f) => format!("STOCK({symbol},\"{f}\")"),
        None => format!("STOCK({symbol})"),
    };
    Some((text, close))
}

fn string_literal(arg: &str) -> Option<String> {
    let a = arg.trim();
    if a.len() >= 2 && a.starts_with('"') && a.ends_with('"') {
        Some(a[1..a.len() - 1].replace("\"\"", "\""))
    } else {
        None
    }
}

/// `"NASDAQ:GOOG"` → `"GOOG:XNAS"`; non-literals pass through unchanged.
fn map_symbol_literal(arg: &str) -> String {
    let Some(lit) = string_literal(arg) else {
        return arg.to_string();
    };
    let key = match lit.split_once(':') {
        Some((exch, ticker)) => match google_exchange_to_mic(exch) {
            Some(mic) => format!("{}:{mic}", ticker.to_ascii_uppercase()),
            None => lit.to_ascii_uppercase(),
        },
        None => lit.to_ascii_uppercase(),
    };
    format!("\"{}\"", key.replace('"', "\"\""))
}

/// Google Finance exchange prefix → ISO 10383 MIC.
pub fn google_exchange_to_mic(exchange: &str) -> Option<&'static str> {
    Some(match exchange.to_ascii_uppercase().as_str() {
        "NASDAQ" => "XNAS",
        "NYSE" => "XNYS",
        "NYSEARCA" => "ARCX",
        "NYSEAMERICAN" | "NYSEMKT" => "XASE",
        "BATS" => "BATS",
        "LON" => "XLON",
        "ETR" => "XETR",
        "FRA" => "XFRA",
        "TYO" => "XTKS",
        "EPA" => "XPAR",
        "AMS" => "XAMS",
        "EBR" => "XBRU",
        "ELI" => "XLIS",
        "TSE" => "XTSE",
        "ASX" => "XASX",
        "HKG" => "XHKG",
        "SWX" => "XSWX",
        "BIT" => "XMIL",
        "BME" => "XMAD",
        "CURRENCY" => "FX",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_palette_maps_sensibly() {
        let cases = [
            ("#ac725e", BlockColor::Brown),
            ("#d06b64", BlockColor::Red),
            ("#f83a22", BlockColor::Red),
            ("#ff7537", BlockColor::Orange),
            ("#ffad46", BlockColor::Orange),
            ("#42d692", BlockColor::Green),
            ("#16a765", BlockColor::Green),
            ("#7bd148", BlockColor::Green),
            ("#fbe983", BlockColor::Yellow),
            ("#fad165", BlockColor::Yellow),
            ("#9fc6e7", BlockColor::Blue),
            ("#4986e7", BlockColor::Blue),
            ("#9a9cff", BlockColor::Blue),
            ("#b99aff", BlockColor::Purple),
            ("#c2c2c2", BlockColor::Gray),
            ("#cabdbf", BlockColor::Gray),
            ("#f691b2", BlockColor::Pink),
            ("#cd74e6", BlockColor::Purple),
            ("#a47ae2", BlockColor::Purple),
            ("#dc2127", BlockColor::Red),
            ("#039be5", BlockColor::Blue),
            ("not-a-colour", BlockColor::Blue),
            ("#fff", BlockColor::Gray),
        ];
        for (hex, want) in cases {
            assert_eq!(nearest_block_color(hex), want, "{hex}");
        }
        // Spec block text colours map to themselves.
        for (hex, want) in [
            ("#8A5A3F", BlockColor::Brown),
            ("#B85A00", BlockColor::Orange),
            ("#9A6700", BlockColor::Yellow),
            ("#2F7A4F", BlockColor::Green),
            ("#1F6FA8", BlockColor::Blue),
            ("#7E4FA8", BlockColor::Purple),
            ("#B03A78", BlockColor::Pink),
            ("#C23B36", BlockColor::Red),
            ("#6F6E69", BlockColor::Gray),
        ] {
            assert_eq!(nearest_block_color(hex), want, "{hex}");
        }
        assert_eq!(event_color_hex("11"), Some("#dc2127"));
        assert_eq!(event_color_hex("12"), None);
    }

    #[test]
    fn googlefinance_maps_to_stock() {
        let m = map_google_formula("=GOOGLEFINANCE(\"NASDAQ:goog\",\"price\")*A1");
        assert_eq!(m.text, "=STOCK(\"GOOG:XNAS\",\"price\")*A1");
        assert!(m.is_supported());
        let m = map_google_formula("=googlefinance(B2, \"closeyest\")");
        assert_eq!(m.text, "=STOCK(B2,\"prevclose\")");
        let m = map_google_formula("=GOOGLEFINANCE(\"AAPL\")");
        assert_eq!(m.text, "=STOCK(\"AAPL\")");
        // Historical form is unsupported and left alone.
        let m = map_google_formula("=GOOGLEFINANCE(\"AAPL\",\"price\",DATE(2020,1,1),DATE(2020,2,1))");
        assert_eq!(m.unsupported, vec!["GOOGLEFINANCE"]);
        assert!(m.text.starts_with("=GOOGLEFINANCE("));
    }

    #[test]
    fn unsupported_functions_are_reported_and_strings_untouched() {
        let m = map_google_formula("=IMPORTRANGE(\"url\",\"A1\")+SUM(A1:A3)+QUERY(A:B,\"select GOOGLEFINANCE(x)\")");
        assert_eq!(m.unsupported, vec!["IMPORTRANGE", "QUERY"]);
        assert!(m.text.contains("\"select GOOGLEFINANCE(x)\""));
        let m = map_google_formula("=SUM('Sheet (1)'!A1:A2, IF(A1>0,\"a\"\"(b\",0))");
        assert!(m.is_supported(), "{:?}", m.unsupported);
        assert_eq!(m.text, "=SUM('Sheet (1)'!A1:A2, IF(A1>0,\"a\"\"(b\",0))");
        let m = map_google_formula("=STDEV.S(A1:A9)+ARRAYFORMULA(A1:A2*2)");
        assert_eq!(m.unsupported, vec!["ARRAYFORMULA"]);
    }

    #[test]
    fn sheet_titles_are_quoted() {
        assert_eq!(quote_sheet_title("Q1 Budget"), "'Q1 Budget'");
        assert_eq!(quote_sheet_title("Bob's"), "'Bob''s'");
    }
}
