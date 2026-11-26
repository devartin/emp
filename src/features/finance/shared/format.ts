/** Display helpers shared by Money HQ, Portfolio, Markets and Taxes. Money stays decimal strings until display. */
import { formatCompact, formatNumber, formatPercent, getFormatLocale, MINUS } from "@/lib/format";
import { currencyDecimals, formatMoney, moneyParts, type Money } from "@/lib/money";
import { baseCurrency } from "./currency";

/** A UI-computed amount as `Money`, in the workspace base currency unless the figure has its own. */
export const toMoney = (amount: string | number, currency = baseCurrency()): Money => ({
  amount: typeof amount === "number" ? (Number.isFinite(amount) ? amount.toFixed(2) : "0") : amount,
  currency,
});

export const num = (s: string | number | null | undefined): number => {
  if (s === null || s === undefined || s === "") return 0;
  const n = typeof s === "number" ? s : Number(String(s).replace(/[−]/g, "-"));
  return Number.isFinite(n) ? n : 0;
};

// Per-locale+currency symbol placement, resolved once: moneyParts builds Intl formatters on every call, which made
// per-frame readouts (scrub, count-ups) spend most of their time constructing formatters.
const shapes = new Map<string, { symbol: string; prefix: boolean; decimal: string; digits: number }>();
function moneyShape(currency: string) {
  const key = `${getFormatLocale()}|${currency}`;
  let sh = shapes.get(key);
  if (!sh) {
    const p = moneyParts(toMoney(1.5, currency));
    sh = { symbol: p.symbol, prefix: p.symbolPosition === "prefix", decimal: p.decimal, digits: currencyDecimals(currency) };
    shapes.set(key, sh);
  }
  return sh;
}

/** $1,234.56 · −$12.00 */
export function fmtMoney(v: string | number, currency = baseCurrency(), opts: { noCents?: boolean; signed?: boolean } = {}): string {
  // Strings keep the exact decimal path; numbers (UI maths, animated readouts) take the cached fast path below, which
  // matches formatMoney's output: cents first, then half-up to the shown digits.
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) >= 1e15) return formatMoney(toMoney(v, currency), opts);
  const sh = moneyShape(currency);
  const digits = opts.noCents ? 0 : sh.digits;
  const cents = Number(Math.abs(v).toFixed(2));
  const f = 10 ** digits;
  const [i, frac = ""] = (Math.round(cents * f) / f).toFixed(digits).split(".");
  const zero = cents === 0;
  const sign = v < 0 && !zero ? MINUS : opts.signed && !zero ? "+" : "";
  const body = formatNumber(Number(i), { maximumFractionDigits: 0 }) + (frac ? sh.decimal + frac : "");
  return sign + (sh.prefix ? sh.symbol + body : body + sh.symbol);
}

/**
 * Whole units, no cents (N-MO4: summaries ≥ 1,000 and headline figures carry no cents). Base currency unless the
 * figure has its own (`currency`: pass `m.currency` for backend `Money`).
 */
export function fmtWhole(v: string | number, opts: { signed?: boolean; currency?: string } = {}): string {
  return fmtMoney(v, opts.currency ?? baseCurrency(), { noCents: true, signed: opts.signed });
}

/** $12.4k · −$340 */
export function fmtCompact(v: number, currency = baseCurrency(), signed = false): string {
  return formatCompact(v, { currency, signed });
}

export function fmtPct(fraction: number, digits = 1, signed = false): string {
  return formatPercent(fraction, { digits, signed });
}

/**
 * Percentage points (N-MO4 rule 5): a difference between two rates, or an allocation drift — "+3.4 pts", with a
 * no-break space. A change *of* a value is a percent (`fmtPct`), never points.
 */
export function fmtPp(pp: number, digits = 1): string {
  const s = formatNumber(Math.abs(pp), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const zero = Number(s.replace(/[^0-9]/g, "")) === 0;
  return `${pp > 0 && !zero ? "+" : pp < 0 && !zero ? MINUS : ""}${s}\u00a0pts`;
}

export function fmtQty(q: number | string, max = 4): string {
  return formatNumber(num(q), { maximumFractionDigits: max });
}

export function fmtPrice(p: number | null | undefined, currency = baseCurrency()): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  const digits = Math.abs(p) < 2 ? 4 : 2;
  return formatNumber(p, { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A price change, unsigned, at the decimals of the price it changes ($283.62 moves by $0.09, a $0.4123 coin by $0.0021). */
export function fmtPriceMove(change: number, price: number, currency = baseCurrency()): string {
  if (!Number.isFinite(change)) return "—";
  const digits = Math.abs(price) < 2 ? 4 : 2;
  return formatNumber(Math.abs(change), { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** '2026-11' → 'Nov 2026'; short → 'Nov' */
export function monthLabel(m: string, short = false): string {
  const [y, mm] = m.split("-").map(Number);
  if (!y || !mm) return m;
  return short ? MONTHS[mm - 1] : `${MONTHS[mm - 1]} ${y}`;
}

/** '2026-11-26' → 'Nov 26' (+ year when not the current one) */
export function dayLabel(d: string, withYear?: boolean): string {
  const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
  if (!y || !m || !dd) return d;
  const thisYear = new Date().getFullYear();
  return `${MONTHS[m - 1]} ${dd}${withYear || y !== thisYear ? `, ${y}` : ""}`;
}

export function weekdayLabel(d: string): string {
  return new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b.slice(0, 10)}T12:00:00`).getTime() - new Date(`${a.slice(0, 10)}T12:00:00`).getTime()) / 86_400_000);
}

export function relDays(d: string): string {
  const n = daysBetween(todayIso(), d);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n > 1 && n < 7) return `In ${n} days`;
  if (n < 0 && n > -7) return `${-n} days ago`;
  return dayLabel(d);
}

/** Stable categorical colour index for an id (§3.5: fnv1a(id) % 8). */
export function catIndex(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 8;
}

/** Assign palette slots with collision probing (§3.5). */
export function assignColors(ids: string[]): Map<string, number> {
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const id of ids) {
    let k = catIndex(id);
    for (let i = 0; i < 8 && used.has(k); i++) k = (k + 1) % 8;
    used.add(k);
    out.set(id, k);
  }
  return out;
}

export const catVar = (i: number) => (i < 0 ? "var(--cat-other)" : `var(--cat-${(i % 8) + 1})`);

export const blockText = (c: string) => `var(--block-${c}-text)`;
export const blockBg = (c: string) => `var(--block-${c}-bg)`;
