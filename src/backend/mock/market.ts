/**
 * Mock market data (§13.6, §17.2): fictional tickers (EMPX, NOVA, ORBT, KITE, LUMA, VOLT, BRIX, ZENO), fictional
 * ETFs and indices for the demo portfolio, two crypto assets and an FX table. Daily bars follow a seeded geometric
 * Brownian motion anchored at a fixed start date, so history never changes between reloads; the intraday price is
 * a small random walk from the previous close while the market is open (crypto trades 24/7).
 *
 * Pure module: no ctx; callers pass `now` (the mock clock).
 */
import type { Bars, InstrumentType, MarketState, MarketSearchResult, Quote, SymbolKey } from '../types';
import { createRng, hashString } from './rng';

const DAY = 86_400_000;

export interface Instrument {
  key: SymbolKey;
  ticker: string;
  name: string;
  exchange: string;
  type: InstrumentType;
  currency: string;
  /** Asset class used by the portfolio (§16.3 classes). */
  assetClass: string;
  sector?: string;
  /** Price on the anchor date. */
  start: number;
  /** Annual drift and volatility. */
  mu: number;
  sigma: number;
  /** Expense ratio (ETFs). */
  expenseRatio?: number;
  /** Annual dividend yield (paid quarterly). */
  divYield?: number;
  /** One-line description for the symbol page. */
  about: string;
}

export const INSTRUMENTS: Instrument[] = [
  { key: 'EMPX:XNAS', ticker: 'EMPX', name: 'Empyrean Systems', exchange: 'NASDAQ', type: 'equity', currency: 'USD', assetClass: 'US equity', sector: 'Software', start: 182, mu: 0.19, sigma: 0.31, divYield: 0.004, about: 'Workflow and data-platform software for mid-market companies.' },
  { key: 'NOVA:XNAS', ticker: 'NOVA', name: 'Nova Diagnostics', exchange: 'NASDAQ', type: 'equity', currency: 'USD', assetClass: 'US equity', sector: 'Healthcare', start: 64, mu: 0.07, sigma: 0.27, about: 'Point-of-care diagnostic devices and the lab software around them.' },
  { key: 'ORBT:XNYS', ticker: 'ORBT', name: 'Orbit Payments', exchange: 'NYSE', type: 'equity', currency: 'USD', assetClass: 'US equity', sector: 'Fintech', start: 118, mu: 0.12, sigma: 0.29, divYield: 0.009, about: 'Card acquiring, payouts and treasury tools for online merchants.' },
  { key: 'KITE:XNAS', ticker: 'KITE', name: 'Kite Robotics', exchange: 'NASDAQ', type: 'equity', currency: 'USD', assetClass: 'US equity', sector: 'Industrials', start: 41, mu: 0.1, sigma: 0.42, about: 'Autonomous warehouse robots and fleet orchestration.' },
  { key: 'LUMA:XNYS', ticker: 'LUMA', name: 'Luma Energy', exchange: 'NYSE', type: 'equity', currency: 'USD', assetClass: 'US equity', sector: 'Utilities', start: 27, mu: 0.05, sigma: 0.19, divYield: 0.034, about: 'Regulated utility building out grid-scale solar and storage.' },
  { key: 'VOLT:XNAS', ticker: 'VOLT', name: 'Volt Mobility', exchange: 'NASDAQ', type: 'equity', currency: 'USD', assetClass: 'US equity', sector: 'Automotive', start: 236, mu: 0.14, sigma: 0.48, about: 'Electric delivery vans and the charging network behind them.' },
  { key: 'BRIX:XNYS', ticker: 'BRIX', name: 'Brix Realty Trust', exchange: 'NYSE', type: 'equity', currency: 'USD', assetClass: 'REIT', sector: 'Real estate', start: 52, mu: 0.04, sigma: 0.21, divYield: 0.046, about: 'Diversified REIT owning apartments and logistics warehouses.' },
  { key: 'ZENO:XNAS', ticker: 'ZENO', name: 'Zeno Biotech', exchange: 'NASDAQ', type: 'equity', currency: 'USD', assetClass: 'US equity', sector: 'Biotech', start: 15, mu: -0.02, sigma: 0.55, about: 'Clinical-stage biotech developing gene therapies for rare diseases.' },
  { key: 'AXIS:ARCX', ticker: 'AXIS', name: 'Axis Total US Market ETF', exchange: 'NYSE Arca', type: 'etf', currency: 'USD', assetClass: 'US equity', start: 288, mu: 0.1, sigma: 0.16, expenseRatio: 0.0003, divYield: 0.013, about: 'Tracks the whole US stock market: large, mid and small caps.' },
  { key: 'TERRA:ARCX', ticker: 'TERRA', name: 'Terra Developed Markets ETF', exchange: 'NYSE Arca', type: 'etf', currency: 'USD', assetClass: 'Intl developed', start: 61, mu: 0.06, sigma: 0.15, expenseRatio: 0.0006, divYield: 0.029, about: 'Large and mid caps across Europe, Japan, Australia and Canada.' },
  { key: 'MERI:ARCX', ticker: 'MERI', name: 'Meridian Emerging Markets ETF', exchange: 'NYSE Arca', type: 'etf', currency: 'USD', assetClass: 'Emerging', start: 47, mu: 0.04, sigma: 0.19, expenseRatio: 0.0008, divYield: 0.031, about: 'Broad emerging-markets equity across 24 countries.' },
  { key: 'LEDG:ARCX', ticker: 'LEDG', name: 'Ledger Aggregate Bond ETF', exchange: 'NYSE Arca', type: 'etf', currency: 'USD', assetClass: 'Bonds', start: 76, mu: 0.012, sigma: 0.055, expenseRatio: 0.0004, divYield: 0.036, about: 'Investment-grade US bonds: Treasuries, agencies and corporates.' },
  { key: 'SOLR:ARCX', ticker: 'SOLR', name: 'Solar Active Growth Fund', exchange: 'NYSE Arca', type: 'fund', currency: 'USD', assetClass: 'US equity', start: 34, mu: 0.08, sigma: 0.22, expenseRatio: 0.0085, about: 'Actively managed growth fund with a concentrated 40-stock portfolio.' },
  { key: 'BTC:CRYPTO', ticker: 'BTC', name: 'Bitcoin', exchange: 'Crypto', type: 'crypto', currency: 'USD', assetClass: 'Crypto', start: 88000, mu: 0.22, sigma: 0.52, about: 'The first decentralised digital currency. Trades around the clock.' },
  { key: 'ETH:CRYPTO', ticker: 'ETH', name: 'Ether', exchange: 'Crypto', type: 'crypto', currency: 'USD', assetClass: 'Crypto', start: 3100, mu: 0.16, sigma: 0.62, about: 'The native asset of the Ethereum network. Trades around the clock.' },
  { key: 'EMP500:INDEX', ticker: 'US 500', name: 'US 500 Index', exchange: 'Index', type: 'index', currency: 'USD', assetClass: 'US equity', start: 6100, mu: 0.095, sigma: 0.15, about: 'Fictional benchmark of 500 large US companies, used for comparisons in the demo.' },
  { key: 'EMPT100:INDEX', ticker: 'US Tech 100', name: 'US Tech 100 Index', exchange: 'Index', type: 'index', currency: 'USD', assetClass: 'US equity', start: 21500, mu: 0.14, sigma: 0.21, about: 'Fictional index of the 100 largest technology companies.' },
  { key: 'EURUSD:FX', ticker: 'EUR/USD', name: 'Euro / US Dollar', exchange: 'FX', type: 'fx', currency: 'USD', assetClass: 'Cash', start: 1.09, mu: 0.0, sigma: 0.07, about: 'ECB reference rate, daily.' },
  { key: 'GBPUSD:FX', ticker: 'GBP/USD', name: 'British Pound / US Dollar', exchange: 'FX', type: 'fx', currency: 'USD', assetClass: 'Cash', start: 1.27, mu: 0.0, sigma: 0.075, about: 'ECB reference rate, daily.' },
  { key: 'USDJPY:FX', ticker: 'USD/JPY', name: 'US Dollar / Japanese Yen', exchange: 'FX', type: 'fx', currency: 'JPY', assetClass: 'Cash', start: 151, mu: 0.0, sigma: 0.08, about: 'ECB reference rate, daily.' },
];

const BY_KEY = new Map(INSTRUMENTS.map((i) => [i.key, i] as const));

export function instrument(key: SymbolKey): Instrument | undefined {
  return BY_KEY.get(key) ?? BY_KEY.get(resolveSymbol(key) ?? '');
}

/** Accept 'EMPX', 'empx', 'EMPX:XNAS'. */
export function resolveSymbol(input: string): SymbolKey | null {
  const s = input.trim().toUpperCase();
  if (BY_KEY.has(s)) return s;
  const hit = INSTRUMENTS.find((i) => i.ticker.toUpperCase() === s || i.key.split(':')[0] === s);
  return hit?.key ?? null;
}

// ───────────────────────────────────────────────────────────────────────────── daily bars (GBM)

/** History starts here for every instrument. */
const ANCHOR = Date.UTC(2019, 0, 2);

const tradesEveryDay = (i: Instrument) => i.type === 'crypto';
const isWeekend = (ts: number) => {
  const d = new Date(ts).getUTCDay();
  return d === 0 || d === 6;
};

interface Series {
  /** UTC midnight of each bar. */
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /** Unscaled, unrounded path (open, high, low, close per bar), kept so extensions continue the exact same walk. */
  raw: { o: number; h: number; l: number; c: number }[];
  /** Factor that puts the REF_DAY close at `Instrument.start` (fixed when the series is first built). */
  scale: number;
}

const seriesCache = new Map<SymbolKey, Series>();

function round(n: number, i: Instrument): number {
  const d = i.type === 'fx' ? 4 : n < 2 ? 4 : 2;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** `Instrument.start` is the close on this day; the GBM path is generated from ANCHOR and rescaled to it. */
const REF_DAY = Date.UTC(2026, 5, 1);

/**
 * Generate (and extend) the daily series up to and including `untilDay` (UTC midnight).
 *
 * Deterministic regardless of call order (PROGRAMME-v3 K5 "data truth"): bar `n`'s random draws come from a
 * generator seeded by `(symbol, n)` alone, the walk continues from the unrounded previous close, and the scale is
 * fixed by the REF_DAY close, which the first build always reaches. So opening Portfolio first or Home first gives
 * the same prices to the cent.
 */
function series(i: Instrument, untilDay: number): Series {
  let s = seriesCache.get(i.key);
  const fresh = !s;
  if (!s) {
    s = { t: [], o: [], h: [], l: [], c: [], v: [], raw: [], scale: 1 };
    seriesCache.set(i.key, s);
  }
  const lastT = s.t.length ? s.t[s.t.length - 1] : ANCHOR - DAY;
  const until = fresh ? Math.max(untilDay, REF_DAY) : untilDay;
  if (lastT >= until) return s;
  const dt = 1 / 252;
  const drift = (i.mu - (i.sigma * i.sigma) / 2) * dt;
  const vol = i.sigma * Math.sqrt(dt);
  let prev = s.raw.length ? s.raw[s.raw.length - 1].c : 1;
  const phase = hashString(i.key) % 7;
  const first = s.t.length;
  for (let day = lastT + DAY; day <= until; day += DAY) {
    if (!tradesEveryDay(i) && isWeekend(day)) continue;
    const n = s.t.length;
    const rng = createRng(hashString(`${i.key}:bar:${n}`));
    // A gentle regime cycle keeps charts from looking like pure noise.
    const cycle = Math.sin(n / 70 + phase) * 0.0006 * (i.sigma / 0.25);
    const ret = drift + cycle + vol * rng.normal();
    const close = prev * Math.exp(ret);
    const open = prev * Math.exp(vol * 0.25 * rng.normal());
    const span = Math.abs(vol) * (0.6 + rng.next() * 0.9);
    const high = Math.max(open, close) * (1 + span * rng.next());
    const low = Math.min(open, close) * (1 - span * rng.next());
    const baseVol = i.type === 'crypto' ? 28_000 : i.type === 'index' || i.type === 'fx' ? 0 : i.type === 'etf' ? 4_200_000 : 2_600_000 * (60 / Math.max(10, i.start));
    const volume = baseVol ? Math.round(baseVol * Math.exp(0.35 * rng.normal()) * (1 + Math.abs(ret) * 25)) : 0;
    s.t.push(day);
    s.raw.push({ o: open, h: high, l: low, c: close });
    s.v.push(volume);
    prev = close;
  }
  if (fresh) {
    let k = s.t.length - 1;
    while (k > 0 && s.t[k] > REF_DAY) k--;
    s.scale = s.raw[k] && s.raw[k].c > 0 ? i.start / s.raw[k].c : 1;
  }
  for (let k = first; k < s.t.length; k++) {
    const r = s.raw[k];
    s.o.push(round(r.o * s.scale, i));
    s.h.push(round(r.h * s.scale, i));
    s.l.push(round(r.l * s.scale, i));
    s.c.push(round(r.c * s.scale, i));
  }
  return s;
}

/** Test hook: forget generated series (to prove that call order doesn't change prices). */
export function resetMarketCache(): void {
  seriesCache.clear();
  live.clear();
}

const utcDay = (ts: number) => Math.floor(ts / DAY) * DAY;

// ───────────────────────────────────────────────────────────────────────────── market hours

function nyParts(now: number): { weekday: number; minutes: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const parts = Object.fromEntries(f.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
  return { weekday: wd, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function marketState(i: Instrument, now: number): MarketState {
  if (i.type === 'crypto') return 'open';
  if (i.type === 'fx') {
    const { weekday } = nyParts(now);
    return weekday === 0 || weekday === 6 ? 'closed' : 'open';
  }
  const { weekday, minutes } = nyParts(now);
  if (weekday === 0 || weekday === 6) return 'closed';
  if (minutes >= 570 && minutes < 960) return 'open';
  if (minutes >= 240 && minutes < 570) return 'pre';
  if (minutes >= 960 && minutes < 1200) return 'post';
  return 'closed';
}

/** The last completed daily bar index at `now` (today's bar counts once the session closed). */
function lastClosedIndex(i: Instrument, now: number): { s: Series; idx: number } {
  const today = utcDay(now);
  const s = series(i, today);
  let idx = s.t.length - 1;
  if (idx >= 0 && s.t[idx] === today) {
    const st = marketState(i, now);
    const sessionDone = i.type !== 'crypto' && (st === 'post' || (st === 'closed' && nyParts(now).minutes >= 960));
    if (!sessionDone) idx -= 1;
  }
  return { s, idx: Math.max(0, idx) };
}

// ───────────────────────────────────────────────────────────────────────────── live intraday

interface Live {
  day: number;
  base: number;
  w: number;
  at: number;
  high: number;
  low: number;
  volume: number;
}
const live = new Map<SymbolKey, Live>();

/** Current price: today's random walk from the previous close while open; the close otherwise. */
export function currentPrice(i: Instrument, now: number): { price: number; prevClose: number; open: number; high: number; low: number; volume: number; state: MarketState } {
  const { s, idx } = lastClosedIndex(i, now);
  const state = marketState(i, now);
  const today = utcDay(now);
  const todayBar = s.t[s.t.length - 1] === today ? s.t.length - 1 : -1;
  if (state !== 'open' || todayBar < 0 || idx === todayBar) {
    // Closed: last close, change vs the bar before it.
    const close = s.c[idx];
    const prev = s.c[Math.max(0, idx - 1)];
    return { price: close, prevClose: prev, open: s.o[idx], high: s.h[idx], low: s.l[idx], volume: s.v[idx], state };
  }
  // Open: walk from the previous close toward today's (hidden) close, with noise.
  const prevClose = s.c[idx];
  let st = live.get(i.key);
  if (!st || st.day !== today) {
    // Start the session part-way to today's bar so first paint already shows a realistic move.
    const target = Math.log(s.c[todayBar] / prevClose);
    const rng = createRng(hashString(`${i.key}:${today}:live`));
    const w = target * (0.35 + rng.next() * 0.4);
    const p = prevClose * Math.exp(w);
    st = { day: today, base: prevClose, w, at: now, high: Math.max(p, s.o[todayBar]), low: Math.min(p, s.o[todayBar]), volume: Math.round(s.v[todayBar] * 0.45) };
    live.set(i.key, st);
  }
  const elapsed = Math.max(0, Math.min(60_000, now - st.at));
  if (elapsed >= 900) {
    const steps = Math.min(8, Math.floor(elapsed / 900));
    const target = Math.log(s.c[todayBar] / prevClose);
    const perStep = (i.sigma / Math.sqrt(252)) * Math.sqrt(0.9 / 23_400) * 3;
    for (let k = 0; k < steps; k++) {
      // Mean-revert gently toward the day's close so the bar and the live price agree over time.
      st.w += (target - st.w) * 0.002 + perStep * gaussian();
    }
    st.at = now;
    const p = st.base * Math.exp(st.w);
    st.high = Math.max(st.high, p);
    st.low = Math.min(st.low, p);
    st.volume += Math.round((s.v[todayBar] || 0) * 0.0006 * steps * (0.5 + Math.random()));
  }
  const price = round(st.base * Math.exp(st.w), i);
  return { price, prevClose, open: s.o[todayBar], high: round(st.high, i), low: round(st.low, i), volume: st.volume, state };
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface QuoteOptions {
  /** Provider with live equity quotes configured (finnhub key). */
  liveEquities: boolean;
}

export function quoteFor(key: SymbolKey, now: number, opts: QuoteOptions = { liveEquities: true }): Quote | null {
  const i = instrument(key);
  if (!i) return null;
  const p = currentPrice(i, now);
  const change = p.price - p.prevClose;
  const crypto = i.type === 'crypto';
  const fx = i.type === 'fx';
  const liveEq = opts.liveEquities && !crypto && !fx && p.state === 'open';
  return {
    symbol: i.key,
    price: p.price,
    change: round(change, i),
    changePct: p.prevClose ? change / p.prevClose : 0,
    open: p.open,
    high: p.high,
    low: p.low,
    prevClose: p.prevClose,
    volume: p.volume || undefined,
    currency: i.currency,
    marketState: p.state,
    asOf: p.state === 'open' ? now : closeTimestamp(i, now),
    source: crypto ? 'coingecko' : fx ? 'frankfurter' : liveEq ? 'finnhub' : 'stooq',
    freshness: crypto || liveEq ? 'live' : fx ? 'delayed' : 'eod',
    delayedMin: crypto || liveEq ? 0 : fx ? 15 : 0,
  };
}

/** 4:00 PM ET of the last session (approximate: 21:00 UTC). */
function closeTimestamp(i: Instrument, now: number): number {
  const { s, idx } = lastClosedIndex(i, now);
  return s.t[idx] + 21 * 3_600_000;
}

/** Close on (or before) a calendar day — for valuation. */
export function closeOn(key: SymbolKey, ts: number): number | null {
  const i = instrument(key);
  if (!i) return null;
  const day = utcDay(ts);
  const s = series(i, day);
  // binary search for the last bar ≤ day
  let lo = 0;
  let hi = s.t.length - 1;
  if (hi < 0 || s.t[0] > day) return s.c[0] ?? null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.t[mid] <= day) lo = mid;
    else hi = mid - 1;
  }
  return s.c[lo];
}

/** Price for valuation now: live while open, else the last close. */
export function priceNow(key: SymbolKey, now: number): number | null {
  const i = instrument(key);
  if (!i) return null;
  return currentPrice(i, now).price;
}

// ───────────────────────────────────────────────────────────────────────────── bars + indicators

function parseDay(s: string): number {
  const t = Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t : NaN;
}

export function barsFor(key: SymbolKey, interval: '1d' | '1wk' | '1mo', from: string, to: string, now: number): Bars | null {
  const i = instrument(key);
  if (!i) return null;
  const today = utcDay(now);
  const s = series(i, today);
  const f = Number.isFinite(parseDay(from)) ? parseDay(from) : ANCHOR;
  const tt = Math.min(today, Number.isFinite(parseDay(to)) ? parseDay(to) : today);
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [], currency: i.currency, source: i.type === 'crypto' ? 'coingecko' : 'stooq', stale: false };
  // Include today's partial bar from the live price while open.
  const cur = currentPrice(i, now);
  const push = (t: number, o: number, h: number, l: number, c: number, v: number) => {
    out.t.push(t);
    out.o.push(o);
    out.h.push(h);
    out.l.push(l);
    out.c.push(c);
    out.v.push(v);
  };
  let bucket: { key: number; t: number; o: number; h: number; l: number; c: number; v: number } | null = null;
  const bucketKey = (t: number) => {
    const d = new Date(t);
    if (interval === '1mo') return d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (interval === '1wk') return Math.floor((t / DAY + 3) / 7);
    return t;
  };
  for (let k = 0; k < s.t.length; k++) {
    const t = s.t[k];
    if (t < f || t > tt) continue;
    let o = s.o[k];
    let h = s.h[k];
    let l = s.l[k];
    let c = s.c[k];
    let v = s.v[k];
    if (t === today && cur.state === 'open') {
      c = cur.price;
      h = Math.max(o, cur.high, c);
      l = Math.min(o, cur.low, c);
      v = cur.volume;
    } else if (t === today && i.type !== 'crypto' && cur.state !== 'post' && !(cur.state === 'closed' && nyParts(now).minutes >= 960)) {
      continue; // today's session has not started
    }
    if (interval === '1d') {
      push(t, o, h, l, c, v);
      continue;
    }
    const bk = bucketKey(t);
    if (!bucket || bucket.key !== bk) {
      if (bucket) push(bucket.t, bucket.o, bucket.h, bucket.l, bucket.c, bucket.v);
      bucket = { key: bk, t, o, h, l, c, v };
    } else {
      bucket.h = Math.max(bucket.h, h);
      bucket.l = Math.min(bucket.l, l);
      bucket.c = c;
      bucket.v += v;
    }
  }
  if (bucket) push(bucket.t, bucket.o, bucket.h, bucket.l, bucket.c, bucket.v);
  // seconds, like lightweight-charts UTCTimestamp
  out.t = out.t.map((t) => Math.floor(t / 1000));
  return out;
}

export function sma(values: readonly number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let k = 0; k < values.length; k++) {
    sum += values[k];
    if (k >= n) sum -= values[k - n];
    out.push(k >= n - 1 ? sum / n : null);
  }
  return out;
}

export function ema(values: readonly number[], n: number): (number | null)[] {
  const a = 2 / (n + 1);
  const out: (number | null)[] = [];
  let e: number | null = null;
  for (let k = 0; k < values.length; k++) {
    if (k < n - 1) {
      out.push(null);
      continue;
    }
    if (e === null) {
      let s = 0;
      for (let j = k - n + 1; j <= k; j++) s += values[j];
      e = s / n;
    } else e = values[k] * a + e * (1 - a);
    out.push(e);
  }
  return out;
}

export function rsi(values: readonly number[], n = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let gain = 0;
  let loss = 0;
  for (let k = 1; k < values.length; k++) {
    const d = values[k] - values[k - 1];
    const g = Math.max(0, d);
    const l = Math.max(0, -d);
    if (k <= n) {
      gain += g / n;
      loss += l / n;
      out.push(k === n ? (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)) : null);
    } else {
      // Wilder smoothing
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
    }
  }
  return out;
}

export function indicators(closes: readonly number[], ind: { kind: 'sma' | 'ema' | 'bollinger' | 'rsi' | 'macd'; period: number }[]): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const spec of ind) {
    const n = Math.max(1, Math.min(400, Math.round(spec.period || 14)));
    switch (spec.kind) {
      case 'sma':
        out[`sma${n}`] = sma(closes, n);
        break;
      case 'ema':
        out[`ema${n}`] = ema(closes, n);
        break;
      case 'rsi':
        out[`rsi${n}`] = rsi(closes, n);
        break;
      case 'bollinger': {
        const mid = sma(closes, n);
        const up: (number | null)[] = [];
        const lo: (number | null)[] = [];
        for (let k = 0; k < closes.length; k++) {
          const m = mid[k];
          if (m === null) {
            up.push(null);
            lo.push(null);
            continue;
          }
          let v = 0;
          for (let j = k - n + 1; j <= k; j++) v += (closes[j] - m) ** 2;
          const sd = Math.sqrt(v / n);
          up.push(m + 2 * sd);
          lo.push(m - 2 * sd);
        }
        out[`bb${n}_mid`] = mid;
        out[`bb${n}_upper`] = up;
        out[`bb${n}_lower`] = lo;
        break;
      }
      case 'macd': {
        const e12 = ema(closes, 12);
        const e26 = ema(closes, 26);
        const line = closes.map((_, k) => (e12[k] !== null && e26[k] !== null ? (e12[k] as number) - (e26[k] as number) : null));
        const firstIdx = line.findIndex((v) => v !== null);
        const sig: (number | null)[] = line.map(() => null);
        if (firstIdx >= 0) {
          const sub = ema(line.slice(firstIdx) as number[], 9);
          sub.forEach((v, j) => (sig[firstIdx + j] = v));
        }
        out.macd = line;
        out.macd_signal = sig;
        out.macd_hist = line.map((v, k) => (v !== null && sig[k] !== null ? v - (sig[k] as number) : null));
        break;
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── search

export function search(q: string, limit: number): MarketSearchResult[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const scored: { r: MarketSearchResult; score: number }[] = [];
  for (const i of INSTRUMENTS) {
    const ticker = i.ticker.toLowerCase();
    const name = i.name.toLowerCase();
    let score = 0;
    const key = i.key.toLowerCase();
    if (ticker === s || key === s || key.split(':')[0] === s) score = 100;
    else if (ticker.startsWith(s)) score = 80 - ticker.length;
    else if (name.startsWith(s)) score = 60;
    else if (name.split(/\s+/).some((w) => w.startsWith(s))) score = 45;
    else if (name.includes(s) || ticker.includes(s)) score = 25;
    else if (i.sector?.toLowerCase().includes(s)) score = 15;
    if (score > 0) scored.push({ r: { symbol: i.key, name: i.name, exchange: i.exchange, type: i.type, currency: i.currency }, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((x) => x.r);
}

// ───────────────────────────────────────────────────────────────────────────── FX

/** Fixed ECB-style table, units per 1 USD. */
export const FX_PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.9187,
  GBP: 0.7874,
  JPY: 151.62,
  CAD: 1.3712,
  CHF: 0.8841,
  AUD: 1.5296,
  NZD: 1.6738,
  SEK: 10.684,
  NOK: 10.912,
  DKK: 6.8547,
  SGD: 1.3448,
  HKD: 7.8132,
  INR: 83.41,
  MXN: 17.08,
  BRL: 4.97,
  ZAR: 18.62,
  CNY: 7.2041,
  KRW: 1_338.5,
  PLN: 3.982,
};

export function fxRate(from: string, to: string): number | null {
  const a = FX_PER_USD[from.toUpperCase()];
  const b = FX_PER_USD[to.toUpperCase()];
  if (!a || !b) return null;
  return b / a;
}
