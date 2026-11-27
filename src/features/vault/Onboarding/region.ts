/**
 * Region detection for first run (1.0 brief §2.5): the locale, time zone, first day of the week and clock come from
 * the operating system (through `Intl` and `navigator.languages`, which the desktop webview takes from the OS) and
 * are saved into the workspace settings, so dates, "this week" filters and app schedules match the person's region
 * from the first minute instead of Rust's defaults (en-US, UTC, Sunday).
 */
import type { VaultSettings } from "@/backend/types";

export type Region = Pick<VaultSettings, "locale" | "timezone" | "weekStart" | "clock">;

/** Regions whose week starts on Sunday (CLDR `weekData.firstDay`), used when `Intl.Locale#weekInfo` is missing. */
const SUNDAY = new Set([
  "AG", "AS", "BD", "BR", "BS", "BT", "BW", "BZ", "CA", "CN", "CO", "DM", "DO", "ET", "GT", "GU", "HK", "HN", "ID",
  "IL", "IN", "JM", "JP", "KE", "KH", "KR", "LA", "MH", "MM", "MO", "MT", "MX", "MZ", "NI", "NP", "PA", "PE", "PH",
  "PK", "PR", "PT", "PY", "SA", "SG", "SV", "TH", "TT", "TW", "UM", "US", "VE", "VI", "WS", "YE", "ZA", "ZW",
]);
/** Regions whose week starts on Saturday. */
const SATURDAY = new Set(["AE", "AF", "BH", "DJ", "DZ", "EG", "IQ", "IR", "JO", "KW", "LY", "OM", "QA", "SD", "SY"]);

function regionOf(locale: string): string | undefined {
  try {
    const loc = new Intl.Locale(locale);
    return (loc.maximize?.() ?? loc).region;
  } catch {
    return /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase();
  }
}

/** First day of the week for `locale`: 1 Monday, 0 Sunday or 6 Saturday (the values settings accept). */
export function weekStartFor(locale: string): 0 | 1 | 6 {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    if (first === 7) return 0;
    if (first === 6) return 6;
    if (first === 1) return 1;
  } catch {
    /* fall back to the table */
  }
  const r = regionOf(locale);
  if (r && SATURDAY.has(r)) return 6;
  if (r && SUNDAY.has(r)) return 0;
  return 1;
}

/** 12- or 24-hour clock as the locale writes times. */
export function clockFor(locale: string): 12 | 24 {
  try {
    const h12 = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12;
    return h12 === false ? 24 : 12;
  } catch {
    return 12;
  }
}

/** A locale `Intl` accepts, preferring the OS's first language. */
export function systemLocale(): string {
  const candidates = [
    ...(typeof navigator !== "undefined" ? (navigator.languages ?? []) : []),
    typeof navigator !== "undefined" ? navigator.language : undefined,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  for (const c of candidates) {
    if (!c || c === "C" || c === "POSIX") continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(c.replace(/_/g, "-").replace(/\..*$/, ""));
      if (canonical) return canonical;
    } catch {
      /* try the next one */
    }
  }
  return "en-US";
}

export function detectRegion(): Region {
  const locale = systemLocale();
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* keep UTC */
  }
  return { locale, timezone, weekStart: weekStartFor(locale), clock: clockFor(locale) };
}
