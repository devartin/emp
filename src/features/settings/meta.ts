/**
 * Settings sections and searchable entries (shared with the command palette, so keep this file tiny: no React
 * components, only metadata). Each entry anchors a row (`data-setting="<id>"`) the page scrolls to and flashes.
 */
import {
  Archive, Cable, Info, Keyboard, Palette, PencilLine, Settings2, ShieldCheck, SlidersHorizontal, ArrowDownUp, EyeOff,
  type LucideIcon,
} from "lucide-react";

export type SectionId =
  | "general" | "appearance" | "editor" | "shortcuts" | "security" | "privacy" | "integrations" | "backups" | "data" | "advanced" | "about";

export interface SectionMeta {
  id: SectionId;
  title: string;
  icon: LucideIcon;
  group: "Workspace" | "Privacy & security" | "Data" | "Ultra Note";
  description: string;
  keywords: string[];
}

export const SECTIONS: SectionMeta[] = [
  { id: "general", title: "General", icon: Settings2, group: "Workspace", description: "Your name, region, start page and updates.", keywords: ["profile", "name", "language", "region", "currency", "timezone", "date format", "week", "updates", "trash"] },
  { id: "appearance", title: "Appearance", icon: Palette, group: "Workspace", description: "Theme, accent, density, text size and motion.", keywords: ["theme", "dark mode", "light", "midnight", "accent", "colour", "color", "density", "compact", "text size", "font", "motion", "animation", "reduced motion", "contrast", "glass", "effects"] },
  { id: "editor", title: "Editor", icon: PencilLine, group: "Workspace", description: "Writing defaults, typography and images.", keywords: ["spellcheck", "smart quotes", "markdown", "font", "serif", "mono", "full width", "small text", "images"] },
  { id: "shortcuts", title: "Keyboard shortcuts", icon: Keyboard, group: "Workspace", description: "Every shortcut in Ultra Note.", keywords: ["keys", "hotkeys", "cheat sheet", "keyboard"] },
  { id: "security", title: "Security Center", icon: ShieldCheck, group: "Privacy & security", description: "Encryption, password, recovery key and auto-lock.", keywords: ["encryption", "password", "recovery key", "lock", "auto-lock", "re-auth", "integrity", "security log", "argon2", "disk"] },
  { id: "privacy", title: "Privacy & network", icon: EyeOff, group: "Privacy & security", description: "Hide numbers, clipboard, offline mode and the request log.", keywords: ["privacy", "hide numbers", "blur", "clipboard", "offline", "network", "requests", "telemetry", "location"] },
  { id: "integrations", title: "Integrations", icon: Cable, group: "Privacy & security", description: "Google, market data and API keys.", keywords: ["google", "calendar", "drive", "market data", "api keys", "providers", "finnhub", "connections"] },
  { id: "backups", title: "Backups & snapshots", icon: Archive, group: "Data", description: "Automatic snapshots, backup files and restore.", keywords: ["backup", "snapshot", "restore", "verify", "retention", "empbackup"] },
  { id: "data", title: "Import & export", icon: ArrowDownUp, group: "Data", description: "Bring in Notion, Markdown and CSV; export anything.", keywords: ["import", "export", "notion", "markdown", "csv", "xlsx", "excel", "pdf", "json", "zip", "everything"] },
  { id: "advanced", title: "Advanced", icon: SlidersHorizontal, group: "Ultra Note", description: "Search index, jobs, diagnostics and data folder.", keywords: ["index", "reindex", "jobs", "diagnostics", "data folder", "debug", "reset"] },
  { id: "about", title: "About", icon: Info, group: "Ultra Note", description: "Version, licences and what Ultra Note promises.", keywords: ["version", "licenses", "licences", "credits", "open source", "update"] },
];

export const SECTION_ALIASES: Record<string, SectionId> = {
  import: "data", export: "data", "import-export": "data", backup: "backups", snapshots: "backups", network: "privacy",
  keyboard: "shortcuts", keys: "shortcuts", google: "integrations", theme: "appearance", accessibility: "appearance",
  connections: "integrations", markets: "integrations", "market-data": "integrations",
};

export function resolveSection(section: string | undefined): SectionId {
  const s = (section || "general").toLowerCase();
  if (SECTIONS.some((x) => x.id === s)) return s as SectionId;
  return SECTION_ALIASES[s] ?? "general";
}

/** Individual settings that search (page filter and palette) can jump to. */
export interface SettingEntry {
  id: string;
  section: SectionId;
  title: string;
  keywords?: string[];
}

export const SETTING_ENTRIES: SettingEntry[] = [
  { id: "profile-name", section: "general", title: "Your name", keywords: ["profile", "greeting"] },
  { id: "start-page", section: "general", title: "Start page", keywords: ["open on launch", "home"] },
  { id: "locale", section: "general", title: "Region and number format", keywords: ["locale", "language", "decimal"] },
  { id: "timezone", section: "general", title: "Time zone" },
  { id: "currency", section: "general", title: "Base currency", keywords: ["money", "usd", "eur"] },
  { id: "week-start", section: "general", title: "First day of the week" },
  { id: "date-format", section: "general", title: "Date format" },
  { id: "clock", section: "general", title: "Clock", keywords: ["24-hour", "12-hour", "time format"] },
  { id: "trash-retention", section: "general", title: "Keep items in Trash", keywords: ["delete", "purge"] },
  { id: "celebrations", section: "general", title: "Celebrations", keywords: ["confetti", "particles"] },
  { id: "updates", section: "general", title: "Check for updates automatically", keywords: ["github", "version"] },
  { id: "theme", section: "appearance", title: "Theme", keywords: ["dark", "light", "midnight", "system"] },
  { id: "accent", section: "appearance", title: "Accent colour", keywords: ["color", "iris", "jade", "graphite"] },
  { id: "density", section: "appearance", title: "Density", keywords: ["compact", "comfortable"] },
  { id: "text-size", section: "appearance", title: "Text size", keywords: ["font size", "bigger", "smaller"] },
  { id: "motion", section: "appearance", title: "Motion", keywords: ["animation", "reduced motion"] },
  { id: "effects", section: "appearance", title: "Visual effects", keywords: ["glass", "blur", "transparency", "shadows"] },
  { id: "transparency", section: "appearance", title: "Transparency", keywords: ["glass", "blur", "frosted", "translucent", "opaque", "linux"] },
  { id: "contrast", section: "appearance", title: "Contrast", keywords: ["accessibility", "borders"] },
  { id: "number-colors", section: "appearance", title: "Gain and loss colours", keywords: ["colour blind", "cvd", "east asian", "red green"] },
  { id: "readable-font", section: "appearance", title: "Readable font", keywords: ["atkinson", "dyslexia", "accessibility"] },
  { id: "page-font", section: "editor", title: "Default page font", keywords: ["serif", "mono", "sans"] },
  { id: "full-width", section: "editor", title: "Full width pages" },
  { id: "small-text", section: "editor", title: "Small text" },
  { id: "spellcheck", section: "editor", title: "Spell check" },
  { id: "typography", section: "editor", title: "Smart quotes and dashes", keywords: ["typography"] },
  { id: "markdown-shortcuts", section: "editor", title: "Markdown shortcuts" },
  { id: "remote-images", section: "editor", title: "Images from the web", keywords: ["remote", "tracking"] },
  { id: "security-score", section: "security", title: "Security checklist", keywords: ["score"] },
  { id: "encryption", section: "security", title: "Encryption", keywords: ["encrypt", "decrypt", "xchacha20"] },
  { id: "change-password", section: "security", title: "Change password" },
  { id: "recovery-key", section: "security", title: "Recovery key", keywords: ["24 words", "regenerate"] },
  { id: "auto-lock", section: "security", title: "Auto-lock", keywords: ["idle", "sleep", "lock"] },
  { id: "integrity", section: "security", title: "Integrity check", keywords: ["tamper", "damaged"] },
  { id: "security-log", section: "security", title: "Security log", keywords: ["history", "events"] },
  { id: "disk-visibility", section: "security", title: "What’s visible on disk", keywords: ["metadata", "full-disk encryption", "filevault", "bitlocker"] },
  { id: "hide-numbers", section: "privacy", title: "Hide numbers on launch", keywords: ["privacy", "mask"] },
  { id: "blur-inactive", section: "privacy", title: "Blur when inactive" },
  { id: "clipboard", section: "privacy", title: "Clear clipboard after", keywords: ["copy", "secrets"] },
  { id: "image-location", section: "privacy", title: "Remove image location data", keywords: ["gps", "exif"] },
  { id: "offline", section: "privacy", title: "Offline mode", keywords: ["network", "internet"] },
  { id: "network-log", section: "privacy", title: "Network requests", keywords: ["log", "requests"] },
  { id: "google", section: "integrations", title: "Google account", keywords: ["calendar", "drive", "docs", "sheets"] },
  { id: "market-data", section: "integrations", title: "Market data providers", keywords: ["quotes", "stocks", "api key"] },
  { id: "api-keys", section: "integrations", title: "Saved keys and connections", keywords: ["secrets", "credentials"] },
  { id: "snapshots", section: "backups", title: "Automatic snapshots", keywords: ["retention", "daily"] },
  { id: "backup-file", section: "backups", title: "Create a backup file", keywords: ["empbackup", "manual backup"] },
  { id: "restore", section: "backups", title: "Restore from a backup" },
  { id: "import", section: "data", title: "Import", keywords: ["notion", "markdown", "csv", "excel", "obsidian"] },
  { id: "export", section: "data", title: "Export pages", keywords: ["markdown", "json", "pdf", "csv", "xlsx"] },
  { id: "export-everything", section: "data", title: "Export everything", keywords: ["zip", "archive", "take out"] },
  { id: "search-index", section: "advanced", title: "Search index", keywords: ["rebuild", "reindex"] },
  { id: "jobs", section: "advanced", title: "Background jobs" },
  { id: "diagnostics", section: "advanced", title: "Copy diagnostics", keywords: ["support", "bug report"] },
  { id: "licences", section: "about", title: "Open-source licences", keywords: ["licenses", "credits"] },
];
