//! Device and vault settings (SPEC §11.3 Settings and kv) and auto-lock configuration (§9.9).
//!
//! Every field has a default, so stored documents missing newer fields still deserialize.

use serde::{Deserialize, Serialize};

/// Auto-lock configuration (`AutoLock`). Stored device-scope so it can be shown on the lock screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLock {
    /// Idle timeout (`null` = never; requires re-auth).
    pub idle_minutes: Option<u32>,
    /// Lock on system sleep.
    pub on_sleep: bool,
    /// Lock on screen lock / user switch.
    pub on_screen_lock: bool,
    /// Lock when unfocused for this long (`null` = off).
    pub on_blur_minutes: Option<u32>,
    /// Maximum session length (`null` = unlimited).
    pub max_session_hours: Option<u32>,
}

impl Default for AutoLock {
    fn default() -> Self {
        Self {
            idle_minutes: Some(15),
            on_sleep: true,
            on_screen_lock: true,
            on_blur_minutes: None,
            max_session_hours: None,
        }
    }
}

impl AutoLock {
    /// Validates the option sets of §9.9.
    pub fn validate(&self) -> crate::Result<()> {
        if let Some(m) = self.idle_minutes
            && ![1, 5, 15, 30, 60, 240].contains(&m)
        {
            return Err(crate::StoreError::invalid_field(
                "idleMinutes",
                "idle timeout must be 1, 5, 15, 30, 60 or 240 minutes",
            ));
        }
        if let Some(m) = self.on_blur_minutes
            && ![0, 1, 5].contains(&m)
        {
            return Err(crate::StoreError::invalid_field(
                "onBlurMinutes",
                "blur timeout must be 0, 1 or 5 minutes",
            ));
        }
        if let Some(h) = self.max_session_hours
            && (h == 0 || h > 24 * 30)
        {
            return Err(crate::StoreError::invalid_field(
                "maxSessionHours",
                "maximum session length out of range",
            ));
        }
        Ok(())
    }
}

/// `DeviceSettings` (device scope: plaintext, readable before unlock, never sensitive).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[allow(missing_docs)]
pub struct DeviceSettings {
    pub theme: String,
    pub accent: String,
    pub density: String,
    pub text_size: String,
    pub motion: String,
    pub effects: String,
    pub contrast: String,
    pub number_colors: String,
    pub readable_font: bool,
    pub letter_spacing: bool,
    pub updates: String,
    pub language: String,
}

impl Default for DeviceSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            // Ultranote 1.0 default (brief §4). Stored documents keep whatever they hold: a device document is written
            // whole, so an `iris` in it cannot be told apart from a deliberate choice.
            accent: "graphite".into(),
            density: "comfortable".into(),
            text_size: "m".into(),
            motion: "system".into(),
            effects: "auto".into(),
            contrast: "system".into(),
            number_colors: "standard".into(),
            readable_font: false,
            letter_spacing: false,
            updates: "off".into(),
            language: "en".into(),
        }
    }
}

fn one_of(field: &'static str, v: &str, allowed: &[&str]) -> crate::Result<()> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        Err(crate::StoreError::invalid_field(
            field,
            format!("must be one of {}", allowed.join(", ")),
        ))
    }
}

impl DeviceSettings {
    /// Validates enumerated fields.
    pub fn validate(&self) -> crate::Result<()> {
        one_of(
            "theme",
            &self.theme,
            &["system", "light", "dark", "midnight"],
        )?;
        one_of(
            "accent",
            &self.accent,
            &[
                "iris", "ocean", "jade", "amber", "ruby", "orchid", "graphite",
            ],
        )?;
        one_of("density", &self.density, &["comfortable", "compact"])?;
        one_of("textSize", &self.text_size, &["s", "m", "l"])?;
        one_of("motion", &self.motion, &["system", "reduced", "full"])?;
        one_of("effects", &self.effects, &["auto", "full", "reduced"])?;
        one_of("contrast", &self.contrast, &["system", "more"])?;
        one_of(
            "numberColors",
            &self.number_colors,
            &["standard", "cvd", "eastasian", "mono"],
        )?;
        one_of("updates", &self.updates, &["off", "check"])?;
        if self.language.is_empty() || self.language.len() > 35 {
            return Err(crate::StoreError::invalid_field(
                "language",
                "invalid language tag",
            ));
        }
        Ok(())
    }
}

/// Snapshot settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[allow(missing_docs)]
pub struct SnapshotSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_grant_label: Option<String>,
    pub keep_daily: u32,
    pub keep_weekly: u32,
    pub keep_monthly: u32,
}

impl Default for SnapshotSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            folder_grant_label: None,
            keep_daily: 7,
            keep_weekly: 4,
            keep_monthly: 6,
        }
    }
}

/// Market provider settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[allow(missing_docs)]
pub struct MarketProviderSettings {
    pub order: Vec<String>,
    pub refresh_seconds: u32,
}

impl Default for MarketProviderSettings {
    fn default() -> Self {
        Self {
            order: vec!["frankfurter".into(), "stooq".into(), "coingecko".into()],
            refresh_seconds: 60,
        }
    }
}

/// `VaultSettings` (vault scope: encrypted with the vault).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[allow(missing_docs)]
pub struct VaultSettings {
    pub profile_name: String,
    pub base_currency: String,
    pub locale: String,
    pub timezone: String,
    pub week_start: u8,
    pub date_format: String,
    pub clock: u8,
    pub spellcheck: bool,
    pub typography: bool,
    pub markdown_shortcuts: bool,
    pub strip_image_location: bool,
    pub remote_images: String,
    pub trash_retention_days: u32,
    pub hide_numbers_on_launch: bool,
    pub blur_when_inactive: bool,
    pub clipboard_clear_seconds: u32,
    pub celebrations: bool,
    pub start_page: String,
    pub snapshots: SnapshotSettings,
    pub market_providers: MarketProviderSettings,
    pub offline: bool,
}

impl Default for VaultSettings {
    fn default() -> Self {
        Self {
            profile_name: String::new(),
            base_currency: "USD".into(),
            locale: "en-US".into(),
            timezone: "UTC".into(),
            week_start: 0,
            date_format: "full".into(),
            clock: 12,
            spellcheck: true,
            typography: true,
            markdown_shortcuts: true,
            strip_image_location: true,
            remote_images: "ask".into(),
            trash_retention_days: 30,
            hide_numbers_on_launch: false,
            blur_when_inactive: false,
            clipboard_clear_seconds: 30,
            celebrations: true,
            start_page: "home".into(),
            snapshots: SnapshotSettings::default(),
            market_providers: MarketProviderSettings::default(),
            offline: false,
        }
    }
}

impl VaultSettings {
    /// Validates enumerated and bounded fields.
    pub fn validate(&self) -> crate::Result<()> {
        if ![0, 1, 6].contains(&self.week_start) {
            return Err(crate::StoreError::invalid_field(
                "weekStart",
                "must be 0, 1 or 6",
            ));
        }
        one_of(
            "dateFormat",
            &self.date_format,
            &["full", "mdy", "dmy", "ymd"],
        )?;
        if ![12, 24].contains(&self.clock) {
            return Err(crate::StoreError::invalid_field(
                "clock",
                "must be 12 or 24",
            ));
        }
        one_of(
            "remoteImages",
            &self.remote_images,
            &["ask", "allow", "block"],
        )?;
        if !(1..=3650).contains(&self.trash_retention_days) {
            return Err(crate::StoreError::invalid_field(
                "trashRetentionDays",
                "must be between 1 and 3650",
            ));
        }
        if self.base_currency.is_empty() || self.base_currency.len() > 10 {
            return Err(crate::StoreError::invalid_field(
                "baseCurrency",
                "invalid currency",
            ));
        }
        if !valid_timezone(&self.timezone) {
            return Err(crate::StoreError::invalid_field(
                "timezone",
                "unknown time zone",
            ));
        }
        if !valid_locale(&self.locale) {
            return Err(crate::StoreError::invalid_field("locale", "invalid locale"));
        }
        if !(5..=600).contains(&self.clipboard_clear_seconds) {
            return Err(crate::StoreError::invalid_field(
                "clipboardClearSeconds",
                "must be between 5 and 600 seconds",
            ));
        }
        if self.profile_name.chars().count() > 1024 || self.start_page.len() > 64 {
            return Err(crate::StoreError::invalid("value too long"));
        }
        Ok(())
    }
}

impl VaultSettings {
    /// `true` while locale, time zone, week start, clock and date format still hold the pre-1.0 built-in defaults
    /// (`en-US`, `UTC`, Sunday, 12-hour, `full`): the region was never detected nor chosen.
    #[must_use]
    pub fn region_is_untouched(&self) -> bool {
        self.locale == "en-US"
            && self.timezone == "UTC"
            && self.week_start == 0
            && self.clock == 12
            && self.date_format == "full"
    }
}

/// `true` for an IANA time zone name the store can compute local dates in.
#[must_use]
pub fn valid_timezone(tz: &str) -> bool {
    !tz.is_empty() && tz.len() <= 64 && tz.parse::<chrono_tz::Tz>().is_ok()
}

/// `true` for a BCP 47-shaped locale tag (`en`, `en-US`, `zh-Hant-TW`).
#[must_use]
pub fn valid_locale(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let lang_ok = parts
        .next()
        .is_some_and(|l| (2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_alphabetic()));
    lang_ok
        && tag.len() <= 35
        && parts.all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Normalises an OS or browser locale (`de_DE.UTF-8`, `en_GB@euro`, `fr-ca`, `de`) to `ll-CC`. A bare language gets
/// its most common country. `C`, `POSIX` and malformed values give `None`.
#[must_use]
pub fn normalize_locale(raw: &str) -> Option<String> {
    let base = raw.trim().split(['.', '@']).next().unwrap_or_default();
    if base.is_empty() || base.eq_ignore_ascii_case("c") || base.eq_ignore_ascii_case("posix") {
        return None;
    }
    let mut parts = base.split(['_', '-']).filter(|p| !p.is_empty());
    let lang = parts.next()?.to_ascii_lowercase();
    if !(2..=3).contains(&lang.len()) || !lang.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    // The region is the first two-letter (or three-digit) subtag; scripts (`Hant`) are skipped.
    let region = parts
        .find(|p| {
            (p.len() == 2 && p.bytes().all(|b| b.is_ascii_alphabetic()))
                || (p.len() == 3 && p.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(str::to_ascii_uppercase)
        .or_else(|| default_country(&lang).map(str::to_owned));
    let tag = match region {
        Some(r) => format!("{lang}-{r}"),
        None => lang,
    };
    valid_locale(&tag).then_some(tag)
}

fn default_country(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "en" => "US",
        "de" => "DE",
        "fr" => "FR",
        "es" => "ES",
        "it" => "IT",
        "pt" => "BR",
        "nl" => "NL",
        "sv" => "SE",
        "da" => "DK",
        "nb" | "nn" | "no" => "NO",
        "fi" => "FI",
        "pl" => "PL",
        "cs" => "CZ",
        "ja" => "JP",
        "ko" => "KR",
        "zh" => "CN",
        "tr" => "TR",
        "ru" => "RU",
        "uk" => "UA",
        "he" => "IL",
        "ar" => "SA",
        "hi" => "IN",
        "el" => "GR",
        "hu" => "HU",
        "ro" => "RO",
        _ => return None,
    })
}

/// Formats implied by a region: first day of the week, clock and currency (CLDR-style, common regions only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegionFormats {
    /// `0` Sunday, `1` Monday, `6` Saturday.
    pub week_start: u8,
    /// `12` or `24`.
    pub clock: u8,
    /// ISO 4217 code, when the region has a well-known one.
    pub currency: Option<&'static str>,
    /// `full` (written out, month first), `dmy` or `ymd`.
    pub date_format: &'static str,
}

/// Region formats for a normalised locale (`ll-CC`). Unknown regions get ISO weeks and a 24-hour clock.
#[must_use]
pub fn region_formats(locale: &str) -> RegionFormats {
    let country = locale
        .rsplit('-')
        .next()
        .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()))
        .unwrap_or("");
    let (week_start, clock, currency): (u8, u8, Option<&'static str>) = match country {
        "US" => (0, 12, Some("USD")),
        "CA" => (
            0,
            if locale.starts_with("fr") { 24 } else { 12 },
            Some("CAD"),
        ),
        "MX" => (0, 12, Some("MXN")),
        "BR" => (0, 24, Some("BRL")),
        "GB" => (1, 24, Some("GBP")),
        "IE" => (1, 24, Some("EUR")),
        "AU" => (1, 12, Some("AUD")),
        "NZ" => (1, 12, Some("NZD")),
        "IN" => (0, 12, Some("INR")),
        "ZA" => (0, 24, Some("ZAR")),
        "DE" | "AT" | "FR" | "BE" | "LU" | "NL" | "ES" | "IT" | "PT" | "FI" | "GR" | "SK"
        | "SI" | "EE" | "LV" | "LT" | "MT" | "CY" | "HR" => (1, 24, Some("EUR")),
        "CH" => (1, 24, Some("CHF")),
        "SE" => (1, 24, Some("SEK")),
        "NO" => (1, 24, Some("NOK")),
        "DK" => (1, 24, Some("DKK")),
        "PL" => (1, 24, Some("PLN")),
        "CZ" => (1, 24, Some("CZK")),
        "HU" => (1, 24, Some("HUF")),
        "RO" => (1, 24, Some("RON")),
        "TR" => (1, 24, Some("TRY")),
        "RU" => (1, 24, Some("RUB")),
        "UA" => (1, 24, Some("UAH")),
        "JP" => (0, 24, Some("JPY")),
        "KR" => (0, 12, Some("KRW")),
        "CN" => (1, 24, Some("CNY")),
        "TW" => (0, 12, Some("TWD")),
        "HK" => (0, 12, Some("HKD")),
        "SG" => (0, 12, Some("SGD")),
        "IL" => (0, 24, Some("ILS")),
        "AE" => (6, 12, Some("AED")),
        "SA" => (0, 12, Some("SAR")),
        "EG" => (6, 12, Some("EGP")),
        _ => (1, 24, None),
    };
    // Month-first written dates for the US; year-first where ISO-style dates are the norm; day-first elsewhere.
    let date_format = match country {
        "US" => "full",
        "CA" | "SE" | "LT" | "HU" | "CN" | "JP" | "KR" | "TW" => "ymd",
        _ => "dmy",
    };
    RegionFormats {
        week_start,
        clock,
        currency,
        date_format,
    }
}

/// `settings_get` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBundle {
    /// Device scope.
    pub device: DeviceSettings,
    /// Vault scope (only while unlocked).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault: Option<VaultSettings>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_graphite() {
        assert_eq!(DeviceSettings::default().accent, "graphite");
        DeviceSettings::default().validate().unwrap();
        VaultSettings::default().validate().unwrap();
        assert!(VaultSettings::default().region_is_untouched());
    }

    #[test]
    fn locales_normalise() {
        assert_eq!(normalize_locale("de_DE.UTF-8").as_deref(), Some("de-DE"));
        assert_eq!(normalize_locale("en_GB@euro").as_deref(), Some("en-GB"));
        assert_eq!(normalize_locale("fr-ca").as_deref(), Some("fr-CA"));
        assert_eq!(normalize_locale("de").as_deref(), Some("de-DE"));
        assert_eq!(normalize_locale("zh-Hant-TW").as_deref(), Some("zh-TW"));
        assert_eq!(normalize_locale("es-419").as_deref(), Some("es-419"));
        assert_eq!(normalize_locale("C.UTF-8"), None);
        assert_eq!(normalize_locale("POSIX"), None);
        assert_eq!(normalize_locale(""), None);
        assert_eq!(normalize_locale("x"), None);
        assert_eq!(normalize_locale("../../etc"), None);
    }

    #[test]
    fn regions_imply_formats() {
        assert_eq!(
            region_formats("en-US"),
            RegionFormats {
                week_start: 0,
                clock: 12,
                currency: Some("USD"),
                date_format: "full"
            }
        );
        assert_eq!(
            region_formats("de-DE"),
            RegionFormats {
                week_start: 1,
                clock: 24,
                currency: Some("EUR"),
                date_format: "dmy"
            }
        );
        assert_eq!(region_formats("en-GB").currency, Some("GBP"));
        assert_eq!(region_formats("fr-CA").clock, 24);
        assert_eq!(region_formats("ar-AE").week_start, 6);
        assert_eq!(
            region_formats("xx-ZZ"),
            RegionFormats {
                week_start: 1,
                clock: 24,
                currency: None,
                date_format: "dmy"
            }
        );
    }

    #[test]
    fn validation_checks_zone_locale_and_clipboard() {
        let mut v = VaultSettings {
            timezone: "Europe/Berlin".into(),
            ..VaultSettings::default()
        };
        v.validate().unwrap();
        v.timezone = "Mars/Olympus".into();
        assert!(v.validate().is_err());
        v.timezone = "UTC".into();
        v.locale = "en_US; DROP".into();
        assert!(v.validate().is_err());
        v.locale = "pt-BR".into();
        v.clipboard_clear_seconds = 2;
        assert!(v.validate().is_err());
        v.clipboard_clear_seconds = 30;
        v.validate().unwrap();
        assert!(!v.region_is_untouched());
    }
}
