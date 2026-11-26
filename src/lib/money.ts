/**
 * Money helpers for DISPLAY ONLY (decimal.js-light). Authoritative maths lives in Rust (emp-finance).
 * Money is `{ amount: decimal string (scale ≤ 8), currency: ISO-4217 or crypto code }` (D-21).
 */
import Decimal from "decimal.js-light";
import { currencySymbol, fixMinus, formatCompact, getFormatLocale, MINUS, numberFormat } from "./format";

export interface Money {
  amount: string;
  currency: string;
}

const CRYPTO_DECIMALS: Record<string, number> = { BTC: 8, ETH: 6, SOL: 4, USDC: 2, USDT: 2 };

export function money(amount: string | number, currency = "USD"): Money {
  return { amount: new Decimal(amount).toString(), currency };
}

export function toDecimal(m: Money | string | number): Decimal {
  try {
    return new Decimal(typeof m === "object" ? m.amount : m);
  } catch {
    return new Decimal(0);
  }
}

export function toNumber(m: Money): number {
  return toDecimal(m).toNumber();
}

export function add(a: Money, b: Money): Money {
  return { amount: toDecimal(a).plus(toDecimal(b)).toString(), currency: a.currency };
}
export function sub(a: Money, b: Money): Money {
  return { amount: toDecimal(a).minus(toDecimal(b)).toString(), currency: a.currency };
}
export function neg(a: Money): Money {
  return { amount: toDecimal(a).negated().toString(), currency: a.currency };
}
export function sum(items: Money[], currency = items[0]?.currency ?? "USD"): Money {
  let d = new Decimal(0);
  for (const m of items) d = d.plus(toDecimal(m));
  return { amount: d.toString(), currency };
}
export function isNegative(m: Money): boolean {
  return toDecimal(m).isNegative() && !toDecimal(m).isZero();
}
export function isZero(m: Money): boolean {
  return toDecimal(m).isZero();
}
export function compare(a: Money, b: Money): number {
  return toDecimal(a).comparedTo(toDecimal(b));
}

export function currencyDecimals(currency: string): number {
  if (CRYPTO_DECIMALS[currency] !== undefined) return CRYPTO_DECIMALS[currency];
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export interface MoneyFormatOptions {
  /** Always show "+" for positive values (gain/loss displays). */
  signed?: boolean;
  /** Compact (`$12.4k`). */
  compact?: boolean;
  /** Drop the minor units (`$1,240`). */
  noCents?: boolean;
  /** Override fraction digits. */
  digits?: number;
}

export function formatMoney(m: Money, opts: MoneyFormatOptions = {}): string {
  const d = toDecimal(m);
  if (opts.compact) return formatCompact(d.toNumber(), { currency: m.currency, signed: opts.signed });
  const p = moneyParts(m, opts);
  return p.sign + (p.symbolPosition === "prefix" ? p.symbol : "") + p.integer + (p.fraction ? p.decimal + p.fraction : "") +
    (p.symbolPosition === "suffix" ? p.symbol : "");
}

export interface MoneyParts {
  sign: "" | "+" | typeof MINUS;
  symbol: string;
  symbolPosition: "prefix" | "suffix";
  integer: string;
  decimal: string;
  fraction: string;
  negative: boolean;
}

/** Split into parts so KPI tiles can render the symbol at 0.7× (§5.10). */
export function moneyParts(m: Money, opts: MoneyFormatOptions = {}): MoneyParts {
  const d = toDecimal(m);
  const negative = d.isNegative() && !d.isZero();
  const digits = opts.digits ?? (opts.noCents ? 0 : currencyDecimals(m.currency));
  const abs = d.abs().toDecimalPlaces(digits, Decimal.ROUND_HALF_UP);
  const fmt = numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }, getFormatLocale());
  // Intl formats JS numbers; for huge/precise values format integer and fraction separately.
  const [intStr, fracStr = ""] = abs.toFixed(digits).split(".");
  const intFormatted = numberFormat({ maximumFractionDigits: 0 }, getFormatLocale()).format(BigInt(intStr || "0"));
  const decimal = fmt.formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  let symbolPosition: "prefix" | "suffix" = "prefix";
  let symbol = currencySymbol(m.currency);
  try {
    const parts = new Intl.NumberFormat(getFormatLocale(), { style: "currency", currency: m.currency, currencyDisplay: "narrowSymbol" }).formatToParts(1);
    const ci = parts.findIndex((p) => p.type === "currency");
    const ii = parts.findIndex((p) => p.type === "integer");
    symbolPosition = ci > ii ? "suffix" : "prefix";
    if (symbolPosition === "suffix") symbol = " " + symbol.trim();
  } catch {
    symbol = "";
    symbolPosition = "suffix";
    symbol = " " + m.currency;
  }
  return {
    sign: negative ? MINUS : opts.signed && !d.isZero() ? "+" : "",
    symbol,
    symbolPosition,
    integer: fixMinus(intFormatted),
    decimal,
    fraction: fracStr,
    negative,
  };
}

/** Parse user input ("1,234.5", "$12", "(40)") into a decimal string, or null. */
export function parseMoneyInput(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[−‒–]/g, "-");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  const decimalSep = numberFormat({}).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  s = s.replace(/[^\d.,]/g, "");
  if (decimalSep === ",") s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  try {
    const d = new Decimal(s);
    return (negative ? d.negated() : d).toString();
  } catch {
    return null;
  }
}
