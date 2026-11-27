/**
 * Region detection for the browser preview, mirroring Rust (`emp_store::model::settings::{normalize_locale,
 * region_formats}` and `commands::settings::detect_region`): the browser's time zone and language stand in for the
 * OS, and week start, clock and currency follow the locale's region from the same table.
 */
import type { RegionInfo, VaultSettings } from '../../types';

const DEFAULT_COUNTRY: Record<string, string> = {
  en: 'US', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'BR', nl: 'NL', sv: 'SE', da: 'DK', nb: 'NO', nn: 'NO', no: 'NO',
  fi: 'FI', pl: 'PL', cs: 'CZ', ja: 'JP', ko: 'KR', zh: 'CN', tr: 'TR', ru: 'RU', uk: 'UA', he: 'IL', ar: 'SA', hi: 'IN',
  el: 'GR', hu: 'HU', ro: 'RO',
};

const EURO = ['DE', 'AT', 'FR', 'BE', 'LU', 'NL', 'ES', 'IT', 'PT', 'FI', 'GR', 'SK', 'SI', 'EE', 'LV', 'LT', 'MT', 'CY', 'HR'];

/** `[weekStart, clock, currency]` per country (same table as Rust). */
const FORMATS: Record<string, [0 | 1 | 6, 12 | 24, string]> = {
  US: [0, 12, 'USD'], CA: [0, 12, 'CAD'], MX: [0, 12, 'MXN'], BR: [0, 24, 'BRL'], GB: [1, 24, 'GBP'], IE: [1, 24, 'EUR'],
  AU: [1, 12, 'AUD'], NZ: [1, 12, 'NZD'], IN: [0, 12, 'INR'], ZA: [0, 24, 'ZAR'], CH: [1, 24, 'CHF'], SE: [1, 24, 'SEK'],
  NO: [1, 24, 'NOK'], DK: [1, 24, 'DKK'], PL: [1, 24, 'PLN'], CZ: [1, 24, 'CZK'], HU: [1, 24, 'HUF'], RO: [1, 24, 'RON'],
  TR: [1, 24, 'TRY'], RU: [1, 24, 'RUB'], UA: [1, 24, 'UAH'], JP: [0, 24, 'JPY'], KR: [0, 12, 'KRW'], CN: [1, 24, 'CNY'],
  TW: [0, 12, 'TWD'], HK: [0, 12, 'HKD'], SG: [0, 12, 'SGD'], IL: [0, 24, 'ILS'], AE: [6, 12, 'AED'], SA: [0, 12, 'SAR'],
  EG: [6, 12, 'EGP'],
  ...Object.fromEntries(EURO.map((c) => [c, [1, 24, 'EUR'] as [0 | 1 | 6, 12 | 24, string]])),
};

export function validLocale(tag: string): boolean {
  return tag.length <= 35 && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag);
}

export function validTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `de_DE.UTF-8` / `fr-ca` / `de` → `de-DE`, `fr-CA`, `de-DE`; `C`, `POSIX` and junk → null. */
export function normalizeLocale(raw: string): string | null {
  const base = raw.trim().split(/[.@]/)[0] ?? '';
  if (!base || /^(c|posix)$/i.test(base)) return null;
  const parts = base.split(/[-_]/).filter(Boolean);
  const lang = (parts.shift() ?? '').toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang)) return null;
  const region = parts.find((p) => /^[A-Za-z]{2}$/.test(p) || /^\d{3}$/.test(p))?.toUpperCase() ?? DEFAULT_COUNTRY[lang];
  const tag = region ? `${lang}-${region}` : lang;
  return validLocale(tag) ? tag : null;
}

const YMD = new Set(['CA', 'SE', 'LT', 'HU', 'CN', 'JP', 'KR', 'TW']);

export function regionFormats(locale: string): { weekStart: 0 | 1 | 6; clock: 12 | 24; dateFormat: 'full' | 'dmy' | 'ymd'; currency?: string } {
  const country = /-([A-Z]{2})$/.exec(locale)?.[1] ?? '';
  const dateFormat = country === 'US' ? 'full' : YMD.has(country) ? 'ymd' : 'dmy';
  const f = FORMATS[country];
  if (!f) return { weekStart: 1, clock: 24, dateFormat };
  const clock = country === 'CA' && locale.startsWith('fr') ? 24 : f[1];
  return { weekStart: f[0], clock, dateFormat, currency: f[2] };
}

function browserTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && validTimezone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/** `settings_detect_region` without `apply`. The browser zone stands in for the OS zone. */
export function detectRegion(hint: { locale?: string; timeZone?: string }): RegionInfo {
  const timezone = browserTimezone() ?? (hint.timeZone && validTimezone(hint.timeZone) ? hint.timeZone : null) ?? 'UTC';
  const browserLocale = typeof navigator !== 'undefined' ? navigator.language : undefined;
  const locale = (hint.locale ? normalizeLocale(hint.locale) : null) ?? (browserLocale ? normalizeLocale(browserLocale) : null) ?? 'en-US';
  const f = regionFormats(locale);
  return { locale, timezone, weekStart: f.weekStart, clock: f.clock, dateFormat: f.dateFormat, ...(f.currency ? { currency: f.currency } : {}), applied: false };
}

/** Pre-1.0 built-in defaults, i.e. the region was never detected nor chosen. */
export function regionUntouched(v: VaultSettings): boolean {
  return v.locale === 'en-US' && v.timezone === 'UTC' && v.weekStart === 0 && v.clock === 12 && v.dateFormat === 'full';
}
