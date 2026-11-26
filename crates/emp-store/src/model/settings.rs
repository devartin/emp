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
            accent: "iris".into(),
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
        if self.profile_name.chars().count() > 1024 || self.start_page.len() > 64 {
            return Err(crate::StoreError::invalid("value too long"));
        }
        Ok(())
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
