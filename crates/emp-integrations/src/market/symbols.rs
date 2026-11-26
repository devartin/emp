//! Symbol keys (`TICKER:MIC`) and default per-provider symbol mapping (SPEC §17.2).

use std::collections::BTreeMap;
use std::fmt;

use crate::error::{IntegrationError, Result};

/// Per-provider overrides from the securities payload, e.g.
/// `{stooq:"aapl.us", tiingo:"AAPL", finnhub:"AAPL", coingecko:"bitcoin"}`.
pub type ProviderSymbols = BTreeMap<String, String>;

/// A parsed `SymbolKey`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Symbol {
    /// Ticker, upper-case (for FX: the pair, e.g. `EURUSD`).
    pub ticker: String,
    /// Market identifier code, `CRYPTO` or `FX`.
    pub mic: String,
}

impl fmt::Display for Symbol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.ticker, self.mic)
    }
}

/// US venues.
const US_MICS: &[&str] = &[
    "XNAS", "XNYS", "ARCX", "BATS", "XASE", "XNGS", "XNMS", "XNCM", "IEXG", "OTCM",
];

impl Symbol {
    /// Parse `TICKER:MIC` (case-insensitive). Tickers are 1–32 chars of `A-Z 0-9 . - ^ = /`.
    pub fn parse(key: &str) -> Result<Self> {
        let key = key.trim();
        let (ticker, mic) = key.rsplit_once(':').ok_or_else(|| {
            IntegrationError::Invalid(format!("symbol `{}` is not TICKER:MIC", short(key)))
        })?;
        let ticker = ticker.to_ascii_uppercase();
        let mic = mic.to_ascii_uppercase();
        let ticker_ok = (1..=32).contains(&ticker.len())
            && ticker
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-^=/".contains(c));
        let mic_ok = (2..=8).contains(&mic.len()) && mic.chars().all(|c| c.is_ascii_alphanumeric());
        if !ticker_ok || !mic_ok {
            return Err(IntegrationError::Invalid(format!(
                "invalid symbol `{}`",
                short(key)
            )));
        }
        if mic == "FX" && !(ticker.len() == 6 && ticker.chars().all(|c| c.is_ascii_alphabetic())) {
            return Err(IntegrationError::Invalid(
                "FX symbols are 6-letter pairs like EURUSD:FX".into(),
            ));
        }
        Ok(Symbol { ticker, mic })
    }

    /// The canonical key string.
    pub fn key(&self) -> String {
        self.to_string()
    }

    /// Crypto asset.
    pub fn is_crypto(&self) -> bool {
        self.mic == "CRYPTO"
    }

    /// Currency pair.
    pub fn is_fx(&self) -> bool {
        self.mic == "FX"
    }

    /// US-listed.
    pub fn is_us(&self) -> bool {
        US_MICS.contains(&self.mic.as_str())
    }

    /// FX base and quote currencies.
    pub fn fx_pair(&self) -> Option<(&str, &str)> {
        self.is_fx().then(|| self.ticker.split_at(3))
    }

    /// Default trading currency by venue.
    pub fn default_currency(&self) -> &'static str {
        match self.mic.as_str() {
            "XLON" => "GBX",
            "XETR" | "XFRA" | "XPAR" | "XAMS" | "XBRU" | "XLIS" | "XMIL" | "XMAD" => "EUR",
            "XTKS" | "XJPX" => "JPY",
            "XTSE" => "CAD",
            "XASX" => "AUD",
            "XHKG" => "HKD",
            "XSWX" => "CHF",
            _ => "USD",
        }
    }
}

fn short(s: &str) -> String {
    s.chars().take(40).collect()
}

/// Built-in CoinGecko ids for common tickers.
pub fn coingecko_id(ticker: &str) -> Option<&'static str> {
    Some(match ticker {
        "BTC" => "bitcoin",
        "ETH" => "ethereum",
        "USDT" => "tether",
        "BNB" => "binancecoin",
        "SOL" => "solana",
        "XRP" => "ripple",
        "USDC" => "usd-coin",
        "ADA" => "cardano",
        "DOGE" => "dogecoin",
        "TRX" => "tron",
        "TON" => "the-open-network",
        "DOT" => "polkadot",
        "AVAX" => "avalanche-2",
        "LINK" => "chainlink",
        "MATIC" | "POL" => "polygon-ecosystem-token",
        "LTC" => "litecoin",
        "BCH" => "bitcoin-cash",
        "XLM" => "stellar",
        "ATOM" => "cosmos",
        "XMR" => "monero",
        "ETC" => "ethereum-classic",
        "UNI" => "uniswap",
        "SHIB" => "shiba-inu",
        "DAI" => "dai",
        "NEAR" => "near",
        "APT" => "aptos",
        "ARB" => "arbitrum",
        "OP" => "optimism",
        "FIL" => "filecoin",
        "ALGO" => "algorand",
        _ => return None,
    })
}

/// Stooq: `aapl.us`, `vod.uk`, `sap.de`, `7203.jp`; FX `eurusd`.
pub fn stooq_symbol(s: &Symbol) -> Option<String> {
    if s.is_fx() {
        return Some(s.ticker.to_ascii_lowercase());
    }
    let suffix = if s.is_us() {
        "us"
    } else {
        match s.mic.as_str() {
            "XLON" => "uk",
            "XETR" | "XFRA" => "de",
            "XTKS" | "XJPX" => "jp",
            _ => return None,
        }
    };
    Some(format!(
        "{}.{suffix}",
        s.ticker.to_ascii_lowercase().replace('.', "-")
    ))
}

/// Tiingo: US tickers with `.` → `-` (e.g. `BRK-B`).
pub fn tiingo_symbol(s: &Symbol) -> Option<String> {
    s.is_us().then(|| s.ticker.replace('.', "-"))
}

/// Finnhub: US tickers as-is, other venues with Finnhub suffixes.
pub fn finnhub_symbol(s: &Symbol) -> Option<String> {
    if s.is_us() {
        return Some(s.ticker.clone());
    }
    let suffix = match s.mic.as_str() {
        "XLON" => "L",
        "XETR" => "DE",
        "XFRA" => "F",
        "XTKS" | "XJPX" => "T",
        "XPAR" => "PA",
        "XAMS" => "AS",
        "XBRU" => "BR",
        "XMIL" => "MI",
        "XMAD" => "MC",
        "XTSE" => "TO",
        "XASX" => "AX",
        "XHKG" => "HK",
        "XSWX" => "SW",
        _ => return None,
    };
    Some(format!("{}.{suffix}", s.ticker))
}

/// Yahoo: suffixed equities, `BTC-USD` crypto, `EURUSD=X` FX.
pub fn yahoo_symbol(s: &Symbol) -> Option<String> {
    if s.is_crypto() {
        return Some(format!("{}-USD", s.ticker));
    }
    if s.is_fx() {
        return Some(format!("{}=X", s.ticker));
    }
    if s.is_us() {
        return Some(s.ticker.replace('.', "-"));
    }
    finnhub_symbol(s)
}

/// Reverse of the Finnhub/Yahoo suffix convention: `VOD.L` → (`VOD`, `XLON`).
/// Unsuffixed tickers are assumed US and get MIC `XNAS` (venue unknown).
pub fn from_suffixed(symbol: &str) -> (String, &'static str) {
    if let Some((t, suffix)) = symbol.rsplit_once('.') {
        let mic = match suffix {
            "L" => Some("XLON"),
            "DE" => Some("XETR"),
            "F" => Some("XFRA"),
            "T" => Some("XTKS"),
            "PA" => Some("XPAR"),
            "AS" => Some("XAMS"),
            "BR" => Some("XBRU"),
            "MI" => Some("XMIL"),
            "MC" => Some("XMAD"),
            "TO" => Some("XTSE"),
            "AX" => Some("XASX"),
            "HK" => Some("XHKG"),
            "SW" => Some("XSWX"),
            _ => None,
        };
        if let Some(mic) = mic {
            return (t.to_ascii_uppercase(), mic);
        }
    }
    (symbol.to_ascii_uppercase(), "XNAS")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keys() {
        let s = Symbol::parse("aapl:xnas").unwrap();
        assert_eq!(s.key(), "AAPL:XNAS");
        assert!(s.is_us());
        assert!(Symbol::parse("BTC:CRYPTO").unwrap().is_crypto());
        let fx = Symbol::parse("EURUSD:FX").unwrap();
        assert_eq!(fx.fx_pair(), Some(("EUR", "USD")));
        for bad in [
            "AAPL",
            ":XNAS",
            "AAPL:",
            "AA PL:XNAS",
            "EURUS:FX",
            "A;B:XNAS",
        ] {
            assert!(Symbol::parse(bad).is_err(), "{bad}");
        }
        assert_eq!(Symbol::parse("BRK.B:XNYS").unwrap().ticker, "BRK.B");
    }

    #[test]
    fn provider_mapping() {
        let p = |k: &str| Symbol::parse(k).unwrap();
        assert_eq!(stooq_symbol(&p("AAPL:XNAS")).unwrap(), "aapl.us");
        assert_eq!(stooq_symbol(&p("BRK.B:XNYS")).unwrap(), "brk-b.us");
        assert_eq!(stooq_symbol(&p("VOD:XLON")).unwrap(), "vod.uk");
        assert_eq!(stooq_symbol(&p("SAP:XETR")).unwrap(), "sap.de");
        assert_eq!(stooq_symbol(&p("7203:XTKS")).unwrap(), "7203.jp");
        assert_eq!(stooq_symbol(&p("EURUSD:FX")).unwrap(), "eurusd");
        assert_eq!(stooq_symbol(&p("BTC:CRYPTO")), None);
        assert_eq!(tiingo_symbol(&p("BRK.B:XNYS")).unwrap(), "BRK-B");
        assert_eq!(tiingo_symbol(&p("VOD:XLON")), None);
        assert_eq!(finnhub_symbol(&p("VOD:XLON")).unwrap(), "VOD.L");
        assert_eq!(yahoo_symbol(&p("ETH:CRYPTO")).unwrap(), "ETH-USD");
        assert_eq!(yahoo_symbol(&p("EURUSD:FX")).unwrap(), "EURUSD=X");
        assert_eq!(coingecko_id("BTC"), Some("bitcoin"));
        assert_eq!(from_suffixed("VOD.L"), ("VOD".to_string(), "XLON"));
        assert_eq!(from_suffixed("BRK.B"), ("BRK.B".to_string(), "XNAS"));
        assert_eq!(p("VOD:XLON").default_currency(), "GBX");
    }
}
