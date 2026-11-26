/**
 * The palette calculator (`=` prefix, §5.9): arithmetic (+ − × ÷ ^ %, parentheses), "15% of 80", unit conversion
 * ("5 km in mi", "72 f to c", "2.5 gb in mb") and currency ("120 usd in eur", via `fx_rates` from the local cache).
 * Never uses `eval`.
 */
import { api } from "@/backend";
import { formatNumber } from "@/lib/format";
import { evalArithmetic } from "@/ui/expression";

export interface CalcResult {
  /** What ↵ copies. */
  copy: string;
  /** Big display, e.g. "11.05 EUR". */
  display: string;
  /** Small line under it, e.g. "120 USD → EUR · ECB rate 2026-11-26". */
  detail: string;
}

type Dim = "length" | "mass" | "volume" | "time" | "data" | "temp" | "speed" | "area";

const UNITS: Record<string, { dim: Dim; f: number; label: string }> = {
  mm: { dim: "length", f: 0.001, label: "mm" }, cm: { dim: "length", f: 0.01, label: "cm" }, m: { dim: "length", f: 1, label: "m" },
  km: { dim: "length", f: 1000, label: "km" }, in: { dim: "length", f: 0.0254, label: "in" }, inch: { dim: "length", f: 0.0254, label: "in" },
  inches: { dim: "length", f: 0.0254, label: "in" }, ft: { dim: "length", f: 0.3048, label: "ft" }, foot: { dim: "length", f: 0.3048, label: "ft" },
  feet: { dim: "length", f: 0.3048, label: "ft" }, yd: { dim: "length", f: 0.9144, label: "yd" }, mi: { dim: "length", f: 1609.344, label: "mi" },
  mile: { dim: "length", f: 1609.344, label: "mi" }, miles: { dim: "length", f: 1609.344, label: "mi" },
  mg: { dim: "mass", f: 0.001, label: "mg" }, g: { dim: "mass", f: 1, label: "g" }, kg: { dim: "mass", f: 1000, label: "kg" },
  oz: { dim: "mass", f: 28.349523125, label: "oz" }, lb: { dim: "mass", f: 453.59237, label: "lb" }, lbs: { dim: "mass", f: 453.59237, label: "lb" },
  st: { dim: "mass", f: 6350.29318, label: "st" }, t: { dim: "mass", f: 1_000_000, label: "t" },
  ml: { dim: "volume", f: 0.001, label: "ml" }, l: { dim: "volume", f: 1, label: "l" }, tsp: { dim: "volume", f: 0.00492892, label: "tsp" },
  tbsp: { dim: "volume", f: 0.0147868, label: "tbsp" }, cup: { dim: "volume", f: 0.236588, label: "cup" }, cups: { dim: "volume", f: 0.236588, label: "cup" },
  floz: { dim: "volume", f: 0.0295735, label: "fl oz" }, pt: { dim: "volume", f: 0.473176, label: "pt" }, gal: { dim: "volume", f: 3.78541, label: "gal" },
  s: { dim: "time", f: 1, label: "s" }, sec: { dim: "time", f: 1, label: "s" }, min: { dim: "time", f: 60, label: "min" },
  h: { dim: "time", f: 3600, label: "h" }, hr: { dim: "time", f: 3600, label: "h" }, hours: { dim: "time", f: 3600, label: "h" },
  day: { dim: "time", f: 86400, label: "days" }, days: { dim: "time", f: 86400, label: "days" }, wk: { dim: "time", f: 604800, label: "weeks" },
  week: { dim: "time", f: 604800, label: "weeks" }, weeks: { dim: "time", f: 604800, label: "weeks" }, yr: { dim: "time", f: 31_557_600, label: "years" },
  b: { dim: "data", f: 1, label: "B" }, kb: { dim: "data", f: 1e3, label: "KB" }, mb: { dim: "data", f: 1e6, label: "MB" },
  gb: { dim: "data", f: 1e9, label: "GB" }, tb: { dim: "data", f: 1e12, label: "TB" }, kib: { dim: "data", f: 1024, label: "KiB" },
  mib: { dim: "data", f: 1024 ** 2, label: "MiB" }, gib: { dim: "data", f: 1024 ** 3, label: "GiB" },
  kmh: { dim: "speed", f: 1 / 3.6, label: "km/h" }, "km/h": { dim: "speed", f: 1 / 3.6, label: "km/h" }, mph: { dim: "speed", f: 0.44704, label: "mph" },
  "m/s": { dim: "speed", f: 1, label: "m/s" }, kn: { dim: "speed", f: 0.514444, label: "kn" },
  m2: { dim: "area", f: 1, label: "m²" }, sqm: { dim: "area", f: 1, label: "m²" }, sqft: { dim: "area", f: 0.092903, label: "sq ft" },
  ft2: { dim: "area", f: 0.092903, label: "sq ft" }, acre: { dim: "area", f: 4046.86, label: "acres" }, ha: { dim: "area", f: 10000, label: "ha" },
  c: { dim: "temp", f: 1, label: "°C" }, "°c": { dim: "temp", f: 1, label: "°C" }, celsius: { dim: "temp", f: 1, label: "°C" },
  f: { dim: "temp", f: 1, label: "°F" }, "°f": { dim: "temp", f: 1, label: "°F" }, fahrenheit: { dim: "temp", f: 1, label: "°F" },
  k: { dim: "temp", f: 1, label: "K" }, kelvin: { dim: "temp", f: 1, label: "K" },
};

const toKelvin = (v: number, u: string) => (u === "°C" ? v + 273.15 : u === "°F" ? (v - 32) * (5 / 9) + 273.15 : v);
const fromKelvin = (v: number, u: string) => (u === "°C" ? v - 273.15 : u === "°F" ? (v - 273.15) * (9 / 5) + 32 : v);

const CURRENCY = /^[a-z]{3}$/i;
const SYMBOLS: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "₣": "CHF" };

function fmt(n: number, digits = 6): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const max = abs >= 1000 ? 2 : abs >= 1 ? 4 : digits;
  return formatNumber(n, { maximumFractionDigits: max });
}

function evalNum(src: string): number | null {
  const s = src.trim();
  if (!s) return null;
  const pct = /^(.+?)%\s+of\s+(.+)$/i.exec(s);
  if (pct) {
    const a = evalNum(pct[1]);
    const b = evalNum(pct[2]);
    return a === null || b === null ? null : (a / 100) * b;
  }
  const v = evalArithmetic(s.replace(/[×x](?=\s*[\d(])/g, "*").replace(/÷/g, "/"));
  return v === null || !Number.isFinite(v) ? null : v;
}

let fxCache: { base: string; at: number; rates: Record<string, number>; date: string; source: string; stale: boolean } | null = null;

async function rate(from: string, to: string): Promise<{ r: number; date: string; source: string; stale: boolean } | null> {
  if (from === to) return { r: 1, date: "", source: "", stale: false };
  if (!fxCache || fxCache.base !== from || Date.now() - fxCache.at > 5 * 60_000) {
    try {
      const res = await api.fx.rates({ base: from });
      fxCache = { base: res.base, at: Date.now(), rates: res.rates, date: res.date, source: res.source, stale: res.stale };
    } catch {
      return null;
    }
  }
  const r = fxCache.rates[to];
  return r ? { r, date: fxCache.date, source: fxCache.source, stale: fxCache.stale } : null;
}

/** Synchronous part: arithmetic and units. Returns null when the query needs FX or is not a calculation. */
export function calcSync(input: string): CalcResult | null {
  const q = input.trim().replace(/^=\s*/, "");
  if (!q) return null;
  const conv = /^(.+?)\s*([a-z°/²0-9]+)\s+(?:in|to|as|→|->)\s+([a-z°/²0-9]+)$/i.exec(q);
  if (conv) {
    const from = UNITS[conv[2].toLowerCase()];
    const to = UNITS[conv[3].toLowerCase()];
    if (from && to && from.dim === to.dim) {
      const v = evalNum(conv[1]);
      if (v === null) return null;
      const out = from.dim === "temp" ? fromKelvin(toKelvin(v, from.label), to.label) : (v * from.f) / to.f;
      const display = `${fmt(out)} ${to.label}`;
      return { copy: String(Math.round(out * 1e8) / 1e8), display, detail: `${fmt(v)} ${from.label} = ${display}` };
    }
    if (from && to && from.dim !== to.dim) return null;
  }
  if (/[a-z]{2,}/i.test(q.replace(/\bof\b/gi, ""))) return null;
  const v = evalNum(q);
  if (v === null) return null;
  return { copy: String(Math.round(v * 1e10) / 1e10), display: fmt(v, 10), detail: prettyExpr(q) };
}

const THIN = "\u2009";

/**
 * Echo of an arithmetic expression with typographic operators and even spacing: every binary operator gets a thin
 * space on both sides ("1200 × 12 + 340"); a unary minus stays attached to its operand ("−3 × −2").
 */
export function prettyExpr(q: string): string {
  const tokens = q.replace(/\s+/g, "").match(/\d[\d,]*(?:\.\d+)?|\.\d+|[a-z]+|[-+*/×÷x^()%]|./gi) ?? [];
  let out = "";
  let prev: "start" | "value" | "op" = "start";
  for (const t of tokens) {
    if (/^[-+*/×÷^]$/.test(t) || (t === "x" && prev === "value")) {
      const sym = t === "*" || t === "x" ? "×" : t === "/" ? "÷" : t === "-" ? "−" : t;
      if (prev === "value") {
        out += `${THIN}${sym}${THIN}`;
        prev = "op";
      } else out += sym; // unary sign
      continue;
    }
    if (t === "(") {
      out += t;
      prev = "start";
      continue;
    }
    if (/^[a-z]+$/i.test(t)) {
      // words such as "of" in "15% of 80"
      out += ` ${t} `;
      prev = "op";
      continue;
    }
    out += t;
    prev = "value";
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** Full calculator including currency conversion. */
export async function calc(input: string): Promise<CalcResult | null> {
  const sync = calcSync(input);
  if (sync) return sync;
  const q = input.trim().replace(/^=\s*/, "");
  const m = /^([$€£¥₹₩₣])?\s*(.+?)\s*([a-z]{3})?\s+(?:in|to|as|→|->)\s+([a-z]{3})$/i.exec(q);
  if (!m) return null;
  const from = (m[3] ?? (m[1] ? SYMBOLS[m[1]] : "")).toUpperCase();
  const to = m[4].toUpperCase();
  if (!CURRENCY.test(from) || !CURRENCY.test(to)) return null;
  const v = evalNum(m[2]);
  if (v === null) return null;
  const fx = await rate(from, to);
  if (!fx) return { copy: "", display: `${from} → ${to}`, detail: "No rate cached for this pair yet. Connect a market data provider or go online." };
  const out = v * fx.r;
  const display = `${formatNumber(out, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${to}`;
  return {
    copy: (Math.round(out * 100) / 100).toFixed(2),
    display,
    detail: `${formatNumber(v, { maximumFractionDigits: 2 })} ${from} at ${fmt(fx.r)}${fx.date ? ` · ${fx.source || "rate"} ${fx.date}` : ""}${fx.stale ? " · cached" : ""}`,
  };
}
