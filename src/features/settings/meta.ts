/**
 * Settings sections and searchable entries (1.0 brief §2.4). Shared with the command palette and breadcrumbs, so keep
 * this file tiny: no React components, only metadata.
 *
 * Five sections, each showing what most people need, with one "More options" disclosure for the rest; About sits at
 * the foot of the list. Every entry anchors a row (`data-setting="<id>"`) that search and deep links scroll to and
 * flash; `more: true` entries live inside the section's More options, which opens first. Old section ids (pre-1.0
 * links, bookmarks, other features) resolve through `SECTION_ALIASES`.
 */
import { Archive, Cable, Info, Palette, Settings2, ShieldCheck, type LucideIcon } from "lucide-react";

export type SectionId = "general" | "appearance" | "security" | "data" | "connections" | "about";

export interface SectionMeta {
  id: SectionId;
  title: string;
  icon: LucideIcon;
  description: string;
  keywords: string[];
  /** Shown as a link at the foot of the settings list, not with the sections. */
  foot?: boolean;
}

export const SECTIONS: SectionMeta[] = [
  { id: "general", title: "General", icon: Settings2, description: "Your name, region, currency and start page.", keywords: ["profile", "name", "region", "language", "locale", "currency", "time zone", "timezone", "date format", "week", "clock", "start page"] },
  { id: "appearance", title: "Appearance", icon: Palette, description: "Theme, accent, text size and motion.", keywords: ["theme", "dark mode", "light", "midnight", "accent", "colour", "color", "text size", "font", "motion", "animation", "reduce motion", "density", "contrast", "editor", "spell check"] },
  { id: "security", title: "Privacy & security", icon: ShieldCheck, description: "Encryption, password, recovery key, auto-lock and privacy.", keywords: ["encryption", "password", "recovery key", "lock", "auto-lock", "privacy", "hide numbers", "offline", "network", "clipboard", "security log"] },
  { id: "data", title: "Backups & data", icon: Archive, description: "Automatic backups, restore, import, export and Trash.", keywords: ["backup", "snapshot", "restore", "import", "export", "trash", "notion", "markdown", "csv", "zip", "search index"] },
  { id: "connections", title: "Connections", icon: Cable, description: "Google and market data.", keywords: ["google", "calendar", "docs", "sheets", "market data", "quotes", "api keys", "providers", "integrations"] },
  { id: "about", title: "About Ultranote", icon: Info, description: "Version, updates, licences, data folder and help.", keywords: ["version", "update", "licences", "licenses", "credits", "data folder", "logs", "diagnostics", "faq", "help"], foot: true },
];

/** Pre-1.0 section ids and friendly words → the section that holds them now. */
export const SECTION_ALIASES: Record<string, SectionId> = {
  editor: "appearance",
  theme: "appearance",
  accessibility: "appearance",
  privacy: "security",
  network: "security",
  "security-center": "security",
  backups: "data",
  backup: "data",
  snapshots: "data",
  import: "data",
  export: "data",
  "import-export": "data",
  advanced: "data",
  integrations: "connections",
  google: "connections",
  markets: "connections",
  "market-data": "connections",
  updates: "about",
  licences: "about",
  licenses: "about",
};

/** Section ids that now open the keyboard shortcuts overlay (`Ctrl+/`) instead of a section. */
export const SHORTCUT_ALIASES = new Set(["shortcuts", "keyboard", "keys"]);

export function resolveSection(section: string | undefined): SectionId {
  const s = (section || "general").toLowerCase();
  if (SECTIONS.some((x) => x.id === s)) return s as SectionId;
  return SECTION_ALIASES[s] ?? "general";
}

/** Individual settings that search (the dialog's filter and the palette) can jump to. */
export interface SettingEntry {
  id: string;
  section: SectionId;
  title: string;
  keywords?: string[];
  /** Inside the section's More options. */
  more?: boolean;
}

export const SETTING_ENTRIES: SettingEntry[] = [
  // General
  { id: "profile-name", section: "general", title: "Your name", keywords: ["profile", "greeting"] },
  { id: "locale", section: "general", title: "Region", keywords: ["locale", "language", "number format", "decimal", "date format"] },
  { id: "timezone", section: "general", title: "Time zone" },
  { id: "week-start", section: "general", title: "First day of the week", keywords: ["monday", "sunday"] },
  { id: "currency", section: "general", title: "Currency", keywords: ["money", "usd", "eur", "base currency"] },
  { id: "start-page", section: "general", title: "Start page", keywords: ["open on launch", "home"] },
  { id: "date-format", section: "general", title: "Date format", more: true },
  { id: "clock", section: "general", title: "Clock", keywords: ["24-hour", "12-hour", "time format"], more: true },
  // Appearance
  { id: "theme", section: "appearance", title: "Theme", keywords: ["dark", "light", "midnight", "system"] },
  { id: "accent", section: "appearance", title: "Accent colour", keywords: ["color", "iris", "jade", "graphite"] },
  { id: "text-size", section: "appearance", title: "Text size", keywords: ["font size", "bigger", "smaller", "zoom"] },
  { id: "motion", section: "appearance", title: "Reduce motion", keywords: ["animation", "motion"] },
  { id: "density", section: "appearance", title: "Density", keywords: ["compact", "comfortable"], more: true },
  { id: "page-font", section: "appearance", title: "New page style", keywords: ["serif", "mono", "font", "full width", "small text"], more: true },
  { id: "spellcheck", section: "appearance", title: "Spell check", keywords: ["spelling", "dictionary"], more: true },
  { id: "typography", section: "appearance", title: "Smart quotes and dashes", keywords: ["typography"], more: true },
  { id: "markdown-shortcuts", section: "appearance", title: "Markdown shortcuts", more: true },
  { id: "number-colors", section: "appearance", title: "Gain and loss colours", keywords: ["colour blind", "cvd", "east asian", "red green", "numbers"], more: true },
  { id: "contrast", section: "appearance", title: "Contrast", keywords: ["accessibility", "borders"], more: true },
  { id: "readable-font", section: "appearance", title: "Readable font", keywords: ["atkinson", "dyslexia", "accessibility"], more: true },
  { id: "letter-spacing", section: "appearance", title: "Wider letter spacing", keywords: ["accessibility", "spacing"], more: true },
  { id: "celebrations", section: "appearance", title: "Celebrations", keywords: ["confetti"], more: true },
  // Privacy & security
  { id: "encryption", section: "security", title: "Encryption", keywords: ["encrypt", "decrypt", "password"] },
  { id: "change-password", section: "security", title: "Password", keywords: ["change password"] },
  { id: "recovery-key", section: "security", title: "Recovery key", keywords: ["24 words", "regenerate"] },
  { id: "auto-lock", section: "security", title: "Lock when idle", keywords: ["auto-lock", "idle", "lock now"] },
  { id: "hide-numbers", section: "security", title: "Hide numbers on launch", keywords: ["privacy", "mask", "amounts"] },
  { id: "offline", section: "security", title: "Offline mode", keywords: ["network", "internet"] },
  { id: "security-checklist", section: "security", title: "Security checklist", keywords: ["score"], more: true },
  { id: "lock-triggers", section: "security", title: "Lock on sleep and screen lock", keywords: ["sleep", "screen lock", "background", "session"], more: true },
  { id: "blur-inactive", section: "security", title: "Blur when inactive", more: true },
  { id: "clipboard", section: "security", title: "Clear copied secrets", keywords: ["clipboard", "copy"], more: true },
  { id: "remote-images", section: "security", title: "Images from the web", keywords: ["remote", "tracking"], more: true },
  { id: "network-log", section: "security", title: "Request log", keywords: ["network", "requests", "log"], more: true },
  { id: "security-log", section: "security", title: "Security log", keywords: ["history", "events"], more: true },
  { id: "integrity", section: "security", title: "Integrity check", keywords: ["tamper", "damaged"], more: true },
  { id: "key-strength", section: "security", title: "Key strength", keywords: ["benchmark", "strengthen", "kdf"], more: true },
  { id: "disk-visibility", section: "security", title: "What’s visible on disk", keywords: ["metadata", "full-disk encryption", "filevault", "bitlocker"], more: true },
  // Backups & data
  { id: "snapshots", section: "data", title: "Automatic backups", keywords: ["snapshot", "backup password", "daily"] },
  { id: "backup-location", section: "data", title: "Backup folder", keywords: ["where", "location", "synced folder"] },
  { id: "backup-keep", section: "data", title: "Backups to keep", keywords: ["retention", "how many"] },
  { id: "backup-now", section: "data", title: "Back up now", keywords: ["snapshot now"] },
  { id: "restore", section: "data", title: "Restore from a backup", keywords: ["restore"] },
  { id: "import", section: "data", title: "Import", keywords: ["notion", "markdown", "csv", "excel", "obsidian"] },
  { id: "export-everything", section: "data", title: "Export everything", keywords: ["zip", "archive", "take out"] },
  { id: "trash-retention", section: "data", title: "Keep items in Trash", keywords: ["delete", "purge"] },
  { id: "snapshot-list", section: "data", title: "Backup history", keywords: ["verify", "snapshots"], more: true },
  { id: "backup-file", section: "data", title: "Save a backup file", keywords: ["empbackup", "manual backup", "move computer"], more: true },
  { id: "search-index", section: "data", title: "Search index", keywords: ["rebuild", "reindex"], more: true },
  { id: "jobs", section: "data", title: "Background jobs", more: true },
  { id: "reset-layout", section: "data", title: "Reset window layout", keywords: ["sidebar width", "zoom"], more: true },
  // Connections
  { id: "google", section: "connections", title: "Google", keywords: ["calendar", "drive", "docs", "sheets"] },
  { id: "market-data", section: "connections", title: "Market data", keywords: ["quotes", "stocks", "prices"] },
  { id: "market-providers", section: "connections", title: "Market data providers", keywords: ["finnhub", "tiingo", "api key"], more: true },
  { id: "api-keys", section: "connections", title: "Saved keys and connections", keywords: ["secrets", "credentials"], more: true },
  // About
  { id: "updates", section: "about", title: "Check for updates", keywords: ["github", "version", "new version"] },
  { id: "data-folder", section: "about", title: "Data folder", keywords: ["show in folder", "files"] },
  { id: "logs", section: "about", title: "Logs", keywords: ["log files", "bug report"] },
  { id: "diagnostics", section: "about", title: "Copy diagnostics", keywords: ["support", "bug report"] },
  { id: "faq", section: "about", title: "Questions about encryption", keywords: ["how encryption works", "password strength", "faq"] },
  { id: "licences", section: "about", title: "Open-source licences", keywords: ["licenses", "credits"] },
];

/** Pre-1.0 anchors → the row that replaced them. */
export const ANCHOR_ALIASES: Record<string, string> = {
  "security-score": "security-checklist",
  "image-location": "remote-images",
  export: "export-everything",
  "full-width": "page-font",
  "small-text": "page-font",
  transparency: "motion",
  effects: "motion",
};

export interface SettingsTarget {
  section: SectionId;
  anchor?: string;
  /** The anchor sits in More options. */
  more: boolean;
  /** The old id meant the keyboard shortcuts overlay. */
  shortcuts?: boolean;
}

/** `general`, `appearance:accent`, `backups:snapshots`, `shortcuts` → where to go. */
export function resolveTarget(raw: string | undefined): SettingsTarget {
  const [rawSection = "general", rawAnchor] = (raw || "general").split(":");
  const lower = rawSection.toLowerCase();
  if (SHORTCUT_ALIASES.has(lower)) return { section: "general", more: false, shortcuts: true };
  // An anchor alone (`#/settings/timezone`) finds its section.
  const direct = !SECTIONS.some((s) => s.id === lower) && !SECTION_ALIASES[lower] ? SETTING_ENTRIES.find((e) => e.id === lower) : undefined;
  const anchorId = rawAnchor ? (ANCHOR_ALIASES[rawAnchor] ?? rawAnchor) : direct?.id;
  const entry = anchorId ? SETTING_ENTRIES.find((e) => e.id === anchorId) : undefined;
  const section = entry?.section ?? (direct ? direct.section : resolveSection(lower));
  return { section, anchor: anchorId, more: !!entry?.more };
}
