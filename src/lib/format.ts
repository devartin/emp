/**
 * Number formatting with cached Intl instances. All output uses U+2212 (−) for negatives (§3.3).
 * Locale defaults to the browser locale; app-core calls `setFormatLocale(vaultSettings.locale)` after unlock.
 */
export const MINUS = "−";

let locale: string = (typeof navigator !== "undefined" && navigator.language) || "en-US";
const cache = new Map<string, Intl.NumberFormat>();

export function setFormatLocale(next: string): void {
  if (!next || next === locale) return;
  try {
    new Intl.NumberFormat(next);
    locale = next;
    cache.clear();
  } catch {
    /* invalid locale → keep previous */
  }
}

export function getFormatLocale(): string {
  return locale;
}

export function numberFormat(opts: Intl.NumberFormatOptions = {}, loc: string = locale): Intl.NumberFormat {
  const key = loc + "|" + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(loc, opts);
    } catch {
      // Unknown currency code (e.g. crypto tickers longer than 3 chars) → plain decimal.
      const { currency: _c, style: _s, currencyDisplay: _d, ...rest } = opts;
      f = new Intl.NumberFormat(loc, rest);
    }
    cache.set(key, f);
  }
  return f;
}

/** Replace ASCII hyphen-minus produced by Intl with a true minus sign. */
export function fixMinus(s: string): string {
  return s.replace(/-/g, MINUS);
}

export function formatNumber(n: number, opts: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(n)) return "—";
  return fixMinus(numberFormat(opts).format(n));
}

export function formatInteger(n: number): string {
  return formatNumber(n, { maximumFractionDigits: 0 });
}

/** Fixed-decimals helper ("1,234.50"). */
export function formatFixed(n: number, digits = 2): string {
  return formatNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatCurrency(n: number, currency = "USD", opts: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(n)) return "—";
  const f = numberFormat({ style: "currency", currency, currencyDisplay: "narrowSymbol", ...opts });
  const s = f.format(n);
  if (f.resolvedOptions().style !== "currency") return fixMinus(s) + " " + currency;
  return fixMinus(s);
}

const UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

/**
 * Compact formats per §13.5: `$12.4k`, `$1.2M`, `−$340`, `4.2%`.
 * - `currency` → currency symbol prefix.
 * - `percent` → value is a fraction (0.042 → 4.2%).
 */
export function formatCompact(
  n: number,
  opts: { currency?: string; percent?: boolean; digits?: number; signed?: boolean } = {},
): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? MINUS : opts.signed && n > 0 ? "+" : "";
  const abs = Math.abs(n);
  if (opts.percent) {
    const pct = abs * 100;
    const digits = opts.digits ?? (pct >= 100 ? 0 : 1);
    return sign + trimZeros(pct.toFixed(digits)) + "%";
  }
  let body: string;
  const unit = UNITS.find(([v]) => abs >= v);
  if (unit) {
    const scaled = abs / unit[0];
    const digits = opts.digits ?? (scaled >= 100 ? 0 : 1);
    body = trimZeros(scaled.toFixed(digits)) + unit[1];
  } else {
    const digits = opts.digits ?? (abs >= 100 || Number.isInteger(abs) ? 0 : abs >= 1 ? 1 : 2);
    body = trimZeros(abs.toFixed(digits));
  }
  if (opts.currency) {
    return sign + currencySymbol(opts.currency) + body;
  }
  return sign + body;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

const symbolCache = new Map<string, string>();
export function currencySymbol(currency: string): string {
  let s = symbolCache.get(currency);
  if (s === undefined) {
    try {
      const parts = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0);
      s = parts.find((p) => p.type === "currency")?.value ?? currency + " ";
      // Alphabetic symbols ("BTC", "CHF") need a thin gap before digits.
      if (/^[A-Za-z]{2,}$/.test(s)) s = s + "\u00A0";
    } catch {
      s = currency + " ";
    }
    symbolCache.set(currency, s);
  }
  return s;
}

/** "+4.2%" / "−1.3%" from a fraction. */
export function formatPercent(fraction: number, opts: { digits?: number; signed?: boolean } = {}): string {
  if (!Number.isFinite(fraction)) return "—";
  const digits = opts.digits ?? 1;
  const abs = Math.abs(fraction * 100).toFixed(digits);
  const sign = fraction < 0 && Number(abs) !== 0 ? MINUS : opts.signed && fraction > 0 ? "+" : "";
  return sign + abs + "%";
}

/** Signed number with explicit + and U+2212. */
export function formatSigned(n: number, opts: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(n)) return "—";
  const s = numberFormat({ ...opts, signDisplay: "exceptZero" }).format(n);
  return fixMinus(s);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v.toFixed(0) : trimZeros(v.toFixed(v >= 100 ? 0 : 1))) + " " + units[i];
}

/** "1h 05m", "45m", "12s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Nice-number ticks (4–5) for chart axes (§13.5). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const span = niceNum(max - min, false);
  const step = niceNum(span / (count - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : +v.toPrecision(12));
  return out;
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const f = range / Math.pow(10, exp);
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}
