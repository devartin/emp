/**
 * Mock `portfolio_*` commands (§11.3 Portfolio, §15.7): FIFO / average-cost lots rebuilt from the Investment
 * transactions database, realised gains (long-term after 365 days), XIRR (Newton–Raphson with a bisection
 * fallback), daily TWR, allocation drift with absolute/relative bands, the rebalance plan (new cash first,
 * tax-advantaged trades next, taxable sells last — losses first), dividends TTM / forward and calendar.
 *
 * Units: holding `weight`, `gainPct`, `dayPct` and `dayChangePct` are fractions; allocation `current`, `target`,
 * `drift` and `maxDrift` are percentage points (§15.7 "drift … in percentage points").
 */
import type { CellValue, Id, SymbolKey } from '../../types';
import type { MockCallCtx, MockCtx, MockHandlers } from '../ctx';
import { liveRows, type DbRecord, type PropRecord } from './db';
import { quoteNow } from './market';
import { closeOn, instrument, priceNow } from '../market';
import { centsToStr, pfSets, strToCents, type PfSet } from '../seed/finance';

const DAY = 86_400_000;

// ───────────────────────────────────────────────────────────────────────────── model

export interface PfAccount {
  id: Id;
  name: string;
  type: string;
  tax: 'taxable' | 'deferred' | 'free';
  basis: 'fifo' | 'average';
}
export interface PfSecurity {
  id: Id;
  name: string;
  key: SymbolKey;
  cls: string;
  er: number;
}
export interface PfTxn {
  id: Id;
  date: string;
  type: string;
  secId: Id | null;
  qty: number;
  price: number;
  amount: number;
  fees: number;
  accountId: Id | null;
}
export interface PfTarget {
  cls: string;
  target: number;
  bandAbs: number;
  bandRel: number;
}
export interface Lot {
  accountId: Id;
  secId: Id;
  acquired: string;
  qty: number;
  /** cost per unit in cents */
  cost: number;
}
export interface RealizedEvent {
  accountId: Id;
  secId: Id;
  acquired: string;
  sold: string;
  qty: number;
  proceeds: number;
  basis: number;
  gain: number;
  term: 'short' | 'long';
}
interface PfLedger {
  set: PfSet;
  accounts: PfAccount[];
  securities: PfSecurity[];
  txns: PfTxn[];
  targets: PfTarget[];
  acctById: Map<Id, PfAccount>;
  secById: Map<Id, PfSecurity>;
}

const dbs = (ctx: MockCtx) => ctx.db.table<DbRecord>('db_databases');

function text(v: CellValue | undefined): string {
  return v && v.t === 'text' ? v.v.map((x) => x.text).join('') : '';
}
const num = (v: CellValue | undefined): number | null => (v && v.t === 'number' ? v.v : null);
const cents = (v: CellValue | undefined): number => (v && v.t === 'money' && v.v !== null ? strToCents(v.v) : 0);
const date = (v: CellValue | undefined): string | null => (v && v.t === 'date' && v.v ? v.v.start.slice(0, 10) : null);
const rel = (v: CellValue | undefined): Id | null => (v && v.t === 'relation' ? (v.v[0] ?? null) : null);
const sel = (v: CellValue | undefined): string | null => (v && (v.t === 'select' || v.t === 'status') ? v.v : null);

function optName(ctx: MockCtx, propId: Id | undefined, id: string | null): string {
  if (!propId || !id) return '';
  const p = ctx.db.table<PropRecord>('db_properties').get(propId);
  return ((p?.config.options as { id: string; name: string }[] | undefined) ?? []).find((o) => o.id === id)?.name ?? id;
}

const cache = new WeakMap<object, Map<Id, { v: number; l: PfLedger }>>();

export function readPortfolio(ctx: MockCtx, set: PfSet): PfLedger {
  let m = cache.get(ctx.db);
  if (!m) cache.set(ctx.db, (m = new Map()));
  const hit = m.get(set.id);
  if (hit && hit.v === ctx.db.version) return hit.l;
  const A = dbs(ctx).require(set.dbs.accounts);
  const S = dbs(ctx).require(set.dbs.securities);
  const X = dbs(ctx).require(set.dbs.txns);
  const T = dbs(ctx).require(set.dbs.targets);
  const accounts: PfAccount[] = liveRows(ctx, A.id).map((r) => ({
    id: r.id,
    name: text(r.values[A.primaryPropId]) || 'Account',
    type: sel(r.values[A.roles['iacct.type']]) ?? 'taxable',
    tax: (sel(r.values[A.roles['iacct.tax']]) ?? 'taxable') as PfAccount['tax'],
    basis: (sel(r.values[A.roles['iacct.basis']]) ?? 'fifo') as PfAccount['basis'],
  }));
  const securities: PfSecurity[] = liveRows(ctx, S.id).map((r) => {
    const tv = r.values[S.roles['sec.ticker']];
    const key = tv && tv.t === 'ticker' && tv.v ? tv.v : text(r.values[S.primaryPropId]);
    return { id: r.id, name: text(r.values[S.primaryPropId]) || key, key, cls: optName(ctx, S.roles['sec.class'], sel(r.values[S.roles['sec.class']])) || instrument(key)?.assetClass || 'Other', er: num(r.values[S.roles['sec.expense_ratio']]) ?? 0 };
  });
  const txns: PfTxn[] = liveRows(ctx, X.id)
    .map((r) => ({
      id: r.id,
      date: date(r.values[X.roles['inv.date']]) ?? '1970-01-01',
      type: sel(r.values[X.roles['inv.type']]) ?? 'buy',
      secId: rel(r.values[X.roles['inv.security']]),
      qty: num(r.values[X.roles['inv.qty']]) ?? 0,
      price: cents(r.values[X.roles['inv.price']]),
      amount: cents(r.values[X.roles['inv.amount']]),
      fees: cents(r.values[X.roles['inv.fees']]),
      accountId: rel(r.values[X.roles['inv.account']]),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : typeRank(a.type) - typeRank(b.type)));
  const targets: PfTarget[] = liveRows(ctx, T.id).map((r) => ({
    cls: text(r.values[T.primaryPropId]),
    target: num(r.values[T.roles['alloc.target']]) ?? 0,
    bandAbs: num(r.values[T.roles['alloc.band_abs']]) ?? 5,
    bandRel: num(r.values[T.roles['alloc.band_rel']]) ?? 0.25,
  }));
  const l: PfLedger = { set, accounts, securities, txns, targets, acctById: new Map(accounts.map((a) => [a.id, a])), secById: new Map(securities.map((s) => [s.id, s])) };
  m.set(set.id, { v: ctx.db.version, l });
  return l;
}

function typeRank(t: string): number {
  return ['transfer_in', 'dividend', 'interest', 'buy', 'reinvest', 'split', 'return_of_capital', 'sell', 'fee', 'transfer_out'].indexOf(t);
}

export function resolvePf(ctx: MockCtx, instanceId: Id | undefined | null): PfSet {
  const live = pfSets(ctx).filter((s) => dbs(ctx).has(s.dbs.txns) && !ctx.pages.get(s.dbs.txns)?.deletedAt);
  return (instanceId ? live.find((s) => s.instanceId === instanceId) : undefined) ?? live[0] ?? ctx.fail('NOT_FOUND', 'Portfolio is not set up yet');
}

// ───────────────────────────────────────────────────────────────────────────── lots

interface Book {
  lots: Lot[];
  realized: RealizedEvent[];
  /** cash per account, cents */
  cash: Map<Id, number>;
  /** inferred external contributions (date, cents) */
  contributions: { date: string; amount: number }[];
  dividends: { date: string; secId: Id | null; accountId: Id | null; amount: number }[];
}

/** Replay transactions up to and including `through` (default: all). */
export function rebuild(l: PfLedger, through?: string): Book {
  const lots: Lot[] = [];
  const realized: RealizedEvent[] = [];
  const cash = new Map<Id, number>();
  const contributions: Book['contributions'] = [];
  const dividends: Book['dividends'] = [];
  const addCash = (a: Id | null, v: number, d: string) => {
    if (!a) return;
    let c = (cash.get(a) ?? 0) + v;
    if (c < 0) {
      // Buys beyond the available cash were funded by a new contribution.
      contributions.push({ date: d, amount: -c });
      c = 0;
    }
    cash.set(a, c);
  };
  for (const t of l.txns) {
    if (through && t.date > through) break;
    const a = t.accountId ?? '';
    const acct = l.acctById.get(a);
    switch (t.type) {
      case 'buy':
      case 'reinvest':
      case 'transfer_in': {
        if (t.secId && t.qty > 0) {
          const costTotal = Math.abs(t.amount) || Math.round(t.qty * t.price) + t.fees;
          lots.push({ accountId: a, secId: t.secId, acquired: t.date, qty: t.qty, cost: costTotal / t.qty });
          if (t.type !== 'transfer_in') addCash(a, -costTotal, t.date);
        } else if (!t.secId && t.type === 'transfer_in') {
          addCash(a, Math.abs(t.amount), t.date);
          contributions.push({ date: t.date, amount: Math.abs(t.amount) });
        }
        break;
      }
      case 'sell':
      case 'transfer_out': {
        if (!t.secId) {
          addCash(a, -Math.abs(t.amount), t.date);
          if (t.type === 'transfer_out') contributions.push({ date: t.date, amount: -Math.abs(t.amount) });
          break;
        }
        let left = t.qty;
        const proceedsPerUnit = t.qty ? (Math.abs(t.amount) - t.fees) / t.qty : 0;
        const open = lots.filter((x) => x.accountId === a && x.secId === t.secId && x.qty > 1e-9);
        if (acct?.basis === 'average' && open.length) {
          const q = open.reduce((s, x) => s + x.qty, 0);
          const avg = open.reduce((s, x) => s + x.qty * x.cost, 0) / q;
          for (const x of open) x.cost = avg;
        }
        for (const lot of open) {
          if (left <= 1e-9) break;
          const take = Math.min(lot.qty, left);
          lot.qty -= take;
          left -= take;
          if (t.type === 'sell') {
            const held = (new Date(`${t.date}T12:00:00`).getTime() - new Date(`${lot.acquired}T12:00:00`).getTime()) / DAY;
            const basis = Math.round(take * lot.cost);
            const proceeds = Math.round(take * proceedsPerUnit);
            realized.push({ accountId: a, secId: t.secId, acquired: lot.acquired, sold: t.date, qty: take, proceeds, basis, gain: proceeds - basis, term: held > 365 ? 'long' : 'short' });
          }
        }
        if (t.type === 'sell') addCash(a, Math.abs(t.amount), t.date);
        break;
      }
      case 'split': {
        const ratio = t.qty > 0 ? t.qty : 1;
        for (const x of lots) if (x.secId === t.secId && x.accountId === a) {
          x.qty *= ratio;
          x.cost /= ratio;
        }
        break;
      }
      case 'return_of_capital': {
        const open = lots.filter((x) => x.accountId === a && x.secId === t.secId && x.qty > 0);
        const q = open.reduce((s, x) => s + x.qty, 0);
        for (const x of open) x.cost = Math.max(0, x.cost - Math.abs(t.amount) / q);
        addCash(a, Math.abs(t.amount), t.date);
        break;
      }
      case 'dividend':
      case 'interest':
        dividends.push({ date: t.date, secId: t.secId, accountId: t.accountId, amount: Math.abs(t.amount) });
        addCash(a, Math.abs(t.amount), t.date);
        break;
      case 'fee':
        addCash(a, -Math.abs(t.amount), t.date);
        break;
    }
  }
  return { lots: lots.filter((x) => x.qty > 1e-9), realized, cash, contributions, dividends };
}

// ───────────────────────────────────────────────────────────────────────────── valuation

function priceFor(ctx: MockCtx, key: SymbolKey, day: string, today: string): number | null {
  if (day >= today) return priceNow(key, ctx.clock.now());
  return closeOn(key, new Date(`${day}T12:00:00Z`).getTime());
}

function valueOfBook(ctx: MockCtx, l: PfLedger, book: Book, day: string, today: string): number {
  let v = 0;
  for (const lot of book.lots) {
    const s = l.secById.get(lot.secId);
    if (!s) continue;
    const p = priceFor(ctx, s.key, day, today);
    if (p !== null) v += lot.qty * p * 100;
  }
  for (const c of book.cash.values()) v += c;
  return Math.round(v);
}

/** Daily value / contributions sweep from `from` to `today` (weekdays; `step` days). */
function sweep(ctx: MockCtx, l: PfLedger, from: string, today: string, step: number) {
  const out: { day: string; value: number; contrib: number; flow: number }[] = [];
  let lastContribCount = 0;
  let cumContrib = 0;
  const full = rebuild(l);
  const allContrib = full.contributions.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  // contributions before `from`
  for (const c of allContrib) if (c.date < from) cumContrib += c.amount;
  let ci = allContrib.findIndex((c) => c.date >= from);
  if (ci < 0) ci = allContrib.length;
  for (let d = from; d <= today; d = addDays(d, step)) {
    const wd = new Date(`${d}T12:00:00`).getDay();
    if (step === 1 && (wd === 0 || wd === 6) && d !== today) continue;
    const book = rebuild(l, d);
    let flow = 0;
    while (ci < allContrib.length && allContrib[ci].date <= d) {
      flow += allContrib[ci].amount;
      cumContrib += allContrib[ci].amount;
      ci++;
    }
    out.push({ day: d, value: valueOfBook(ctx, l, book, d, today), contrib: cumContrib, flow });
    lastContribCount = ci;
  }
  if (out[out.length - 1]?.day !== today) {
    const book = rebuild(l, today);
    let flow = 0;
    while (ci < allContrib.length) {
      flow += allContrib[ci].amount;
      cumContrib += allContrib[ci].amount;
      ci++;
    }
    out.push({ day: today, value: valueOfBook(ctx, l, book, today, today), contrib: cumContrib, flow });
  }
  void lastContribCount;
  return out;
}

export function xirr(flows: { date: string; amount: number }[]): number | undefined {
  if (flows.length < 2 || !flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return undefined;
  const t0 = new Date(`${flows[0].date}T12:00:00`).getTime();
  const yrs = flows.map((f) => (new Date(`${f.date}T12:00:00`).getTime() - t0) / (365 * DAY));
  const npv = (r: number) => flows.reduce((s, f, i) => s + f.amount / (1 + r) ** yrs[i], 0);
  const d = (r: number) => flows.reduce((s, f, i) => s - (yrs[i] * f.amount) / (1 + r) ** (yrs[i] + 1), 0);
  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r);
    const df = d(r);
    if (!Number.isFinite(f) || !Number.isFinite(df) || df === 0) break;
    const next = r - f / df;
    if (Math.abs(next - r) < 1e-7) return next > -0.9999 ? next : undefined;
    r = next;
    if (r <= -0.9999 || r > 10) break;
  }
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-6 || hi - lo < 1e-9) return mid;
    if (fm * flo < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return undefined;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface HoldingAgg {
  sec: PfSecurity;
  qty: number;
  cost: number;
  accounts: Set<Id>;
}

function holdingsOf(l: PfLedger, book: Book): HoldingAgg[] {
  const m = new Map<Id, HoldingAgg>();
  for (const lot of book.lots) {
    const sec = l.secById.get(lot.secId);
    if (!sec) continue;
    const h = m.get(lot.secId) ?? { sec, qty: 0, cost: 0, accounts: new Set<Id>() };
    h.qty += lot.qty;
    h.cost += lot.qty * lot.cost;
    h.accounts.add(lot.accountId);
    m.set(lot.secId, h);
  }
  return [...m.values()];
}

function summary(ctx: MockCtx, l: PfLedger) {
  const today = ctx.clock.today();
  const now = ctx.clock.now();
  const book = rebuild(l);
  const hs = holdingsOf(l, book);
  const cashTotal = [...book.cash.values()].reduce((s, v) => s + v, 0);
  let total = cashTotal;
  let dayChange = 0;
  let unrealized = 0;
  let costTotal = 0;
  const rows = hs.map((h) => {
    const q = quoteNow(ctx, h.sec.key);
    const price = q?.price ?? priceNow(h.sec.key, now);
    const value = price !== null ? Math.round(h.qty * price * 100) : 0;
    const gain = value - Math.round(h.cost);
    total += value;
    unrealized += gain;
    costTotal += h.cost;
    if (q) dayChange += h.qty * q.change * 100;
    const stale = !!q && q.marketState === 'closed' && now - q.asOf > 3 * DAY;
    return { h, price, value, gain, q, stale };
  });
  const byClass = new Map<string, number>();
  for (const r of rows) byClass.set(r.h.sec.cls, (byClass.get(r.h.sec.cls) ?? 0) + r.value);
  if (cashTotal > 0) byClass.set('Cash', (byClass.get('Cash') ?? 0) + cashTotal);
  const classes = new Set([...l.targets.map((t) => t.cls), ...byClass.keys()]);
  const allocation = [...classes].map((cls) => {
    const t = l.targets.find((x) => x.cls === cls);
    const current = total > 0 ? ((byClass.get(cls) ?? 0) / total) * 100 : 0;
    const target = t?.target ?? 0;
    const drift = current - target;
    const out = Math.abs(drift) > (t?.bandAbs ?? 5) || (target > 0 && Math.abs(drift) > (t?.bandRel ?? 0.25) * target);
    return { assetClass: cls, current: round2(current), target, drift: round2(drift), status: (out ? 'outside_band' : 'ok') as 'ok' | 'outside_band' };
  });
  const order = ['US equity', 'Intl developed', 'Emerging', 'Bonds', 'Inflation-linked', 'REIT', 'Cash', 'Crypto', 'Other'];
  allocation.sort((a, b) => (order.indexOf(a.assetClass) + 99) % 99 - ((order.indexOf(b.assetClass) + 99) % 99));
  // XIRR: contributions negative, current value positive.
  const flowsAll = [...book.contributions.map((c) => ({ date: c.date, amount: -c.amount })), { date: today, amount: total }].sort((a, b) => (a.date < b.date ? -1 : 1));
  const jan1 = `${today.slice(0, 4)}-01-01`;
  const startBook = rebuild(l, addDays(jan1, -1));
  const startVal = valueOfBook(ctx, l, startBook, addDays(jan1, -1), today);
  const flowsYtd = [{ date: jan1, amount: -startVal }, ...book.contributions.filter((c) => c.date >= jan1).map((c) => ({ date: c.date, amount: -c.amount })), { date: today, amount: total }];
  const ytdYears = Math.max(1 / 365, (new Date(`${today}T12:00:00`).getTime() - new Date(`${jan1}T12:00:00`).getTime()) / (365 * DAY));
  const xYtdAnnual = xirr(flowsYtd);
  // Report YTD as the period return (de-annualised) — what people expect to read next to "YTD".
  const xirrYtd = xYtdAnnual !== undefined ? (1 + xYtdAnnual) ** ytdYears - 1 : undefined;
  const yearAgo = addDays(today, -365);
  const divTtm = book.dividends.filter((d) => d.date > yearAgo).reduce((s, d) => s + d.amount, 0);
  let divFwd = 0;
  for (const h of hs) {
    const last = book.dividends.filter((d) => d.secId === h.sec.id).at(-1);
    if (!last) continue;
    const qtyThen = rebuild(l, last.date).lots.filter((x) => x.secId === h.sec.id).reduce((s, x) => s + x.qty, 0);
    if (qtyThen > 0) divFwd += (book.dividends.filter((d) => d.secId === h.sec.id && d.date === last.date).reduce((s, d) => s + d.amount, 0) / qtyThen) * h.qty * 4;
  }
  const fees = rows.reduce((s, r) => s + r.value * (r.h.sec.er || 0), 0) + l.txns.filter((t) => t.type === 'fee' && t.date > yearAgo).reduce((s, t) => s + Math.abs(t.amount), 0);
  const prevTotal = total - dayChange;
  return {
    totalValue: m$(total),
    dayChange: m$(Math.round(dayChange)),
    dayChangePct: prevTotal > 0 ? dayChange / prevTotal : 0,
    unrealized: m$(unrealized),
    unrealizedPct: costTotal > 0 ? unrealized / costTotal : 0,
    xirrYtd,
    xirrAll: xirr(flowsAll),
    divTtm: m$(divTtm),
    divFwd12m: m$(Math.round(divFwd)),
    maxDrift: round2(Math.max(0, ...allocation.map((a) => Math.abs(a.drift)))),
    feesPerYear: m$(Math.round(fees)),
    holdings: rows
      .sort((a, b) => b.value - a.value)
      .map((r) => ({
        symbol: r.h.sec.key,
        name: r.h.sec.name,
        qty: String(Math.round(r.h.qty * 10_000) / 10_000),
        price: r.price,
        value: m$(r.value),
        costBasis: m$(Math.round(r.h.cost)),
        gain: m$(r.gain),
        gainPct: r.h.cost > 0 ? r.gain / r.h.cost : 0,
        weight: total > 0 ? r.value / total : 0,
        dayPct: r.q?.changePct,
        stale: r.stale,
        assetClass: r.h.sec.cls,
      })),
    allocation,
    asOf: now,
  };
}

const m$ = (c: number) => ({ amount: centsToStr(c), currency: 'USD' });
const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────────────────────────────────────────────────────────────────────── rebalance

function rebalance(ctx: MockCtx, l: PfLedger, req: { newCash: string; allowTaxableSells: boolean; minTrade: string; fractional: boolean }) {
  const s = summary(ctx, l);
  const book = rebuild(l);
  const newCash = Math.max(0, strToCents(req.newCash));
  const minTrade = Math.max(0, strToCents(req.minTrade));
  const total = strToCents(s.totalValue.amount) + newCash;
  const classValue = new Map<string, number>(s.allocation.map((a) => [a.assetClass, (a.current / 100) * strToCents(s.totalValue.amount)]));
  const target = new Map<string, number>(s.allocation.map((a) => [a.assetClass, (a.target / 100) * total]));
  const band = new Map(l.targets.map((t) => [t.cls, t] as const));
  const price = (key: SymbolKey) => priceNow(key, ctx.clock.now()) ?? 0;
  // Representative security per class: the cheapest held fund in the class (or the first held).
  const rep = new Map<string, PfSecurity>();
  for (const h of holdingsOf(l, book).sort((a, b) => a.sec.er - b.sec.er || b.qty * price(b.sec.key) - a.qty * price(a.sec.key))) {
    if (!rep.has(h.sec.cls) && (instrument(h.sec.key)?.type !== 'equity' || !rep.has(h.sec.cls))) rep.set(h.sec.cls, h.sec);
  }
  const trades: { accountId: Id; symbol: SymbolKey; side: 'buy' | 'sell'; qty: string; amount: string; estRealizedGain?: string }[] = [];
  const taxable = l.accounts.find((a) => a.tax === 'taxable' && a.type === 'taxable') ?? l.accounts[0];
  const sheltered = l.accounts.filter((a) => a.tax !== 'taxable');
  const heldQty = (accountId: Id, secId: Id) => book.lots.filter((x) => x.accountId === accountId && x.secId === secId).reduce((a, x) => a + x.qty, 0) - soldQty.get(`${accountId}|${secId}`)!;
  const soldQty = new Map<string, number>();
  const pushTrade = (accountId: Id, sec: PfSecurity, side: 'buy' | 'sell', dollars: number, gain?: number) => {
    const p = price(sec.key) * 100;
    if (p <= 0 || dollars < minTrade || dollars <= 0) return 0;
    let qty = dollars / p;
    const whole = !req.fractional && instrument(sec.key)?.type !== 'crypto';
    if (whole) qty = Math.floor(qty);
    if (side === 'sell') {
      const k = `${accountId}|${sec.id}`;
      if (!soldQty.has(k)) soldQty.set(k, 0);
      qty = Math.min(qty, Math.max(0, heldQty(accountId, sec.id)));
      if (whole) qty = Math.floor(qty);
      soldQty.set(k, (soldQty.get(k) ?? 0) + qty);
    }
    if (qty <= 0) return 0;
    const amt = Math.round(qty * p);
    if (amt < minTrade) return 0;
    trades.push({ accountId, symbol: sec.key, side, qty: String(Math.round(qty * 10_000) / 10_000), amount: centsToStr(amt), ...(gain !== undefined ? { estRealizedGain: centsToStr(Math.round(gain)) } : {}) });
    classValue.set(sec.cls, (classValue.get(sec.cls) ?? 0) + (side === 'buy' ? amt : -amt));
    return amt;
  };
  const deficit = (c: string) => (target.get(c) ?? 0) - (classValue.get(c) ?? 0);
  const outOfBand = (c: string) => {
    const t = band.get(c);
    const cur = ((classValue.get(c) ?? 0) / total) * 100;
    const tg = t?.target ?? 0;
    const d = Math.abs(cur - tg);
    return d > (t?.bandAbs ?? 5) || (tg > 0 && d > (t?.bandRel ?? 0.25) * tg);
  };
  // 1. New cash → most underweight classes, in proportion to their deficit.
  if (newCash > 0) {
    const under = [...target.keys()].filter((c) => deficit(c) > 0 && rep.has(c) && c !== 'Cash');
    const sum = under.reduce((acc, c) => acc + deficit(c), 0);
    let left = newCash;
    for (const c of under.sort((a, b) => deficit(b) - deficit(a))) {
      const share = sum > 0 ? Math.min(left, Math.round((newCash * deficit(c)) / sum)) : 0;
      left -= pushTrade(taxable.id, rep.get(c)!, 'buy', share);
    }
  }
  // 2. Still out of band → trade inside tax-advantaged accounts (sell over, buy under, same account).
  for (const acct of sheltered) {
    const over = [...target.keys()].filter((c) => deficit(c) < 0 && outOfBand(c));
    for (const c of over) {
      const lotsHere = book.lots.filter((x) => x.accountId === acct.id && l.secById.get(x.secId)?.cls === c);
      for (const lot of lotsHere) {
        const sec = l.secById.get(lot.secId)!;
        const avail = lot.qty * price(sec.key) * 100;
        const need = -deficit(c);
        if (need <= minTrade) break;
        const sold = pushTrade(acct.id, sec, 'sell', Math.min(avail, need));
        if (!sold) continue;
        // buy the most underweight class with the proceeds, in the same account
        let left = sold;
        for (const u of [...target.keys()].filter((x) => deficit(x) > 0 && rep.has(x) && x !== 'Cash').sort((a, b) => deficit(b) - deficit(a))) {
          if (left < minTrade) break;
          left -= pushTrade(acct.id, rep.get(u)!, 'buy', Math.min(left, deficit(u)));
        }
      }
    }
  }
  // 3. Taxable sells only if allowed: losses first, then highest basis.
  let estGain = 0;
  if (req.allowTaxableSells) {
    const over = [...target.keys()].filter((c) => deficit(c) < 0 && outOfBand(c));
    for (const c of over) {
      const lots = book.lots
        .filter((x) => l.acctById.get(x.accountId)?.tax === 'taxable' && l.secById.get(x.secId)?.cls === c)
        .map((x) => ({ x, sec: l.secById.get(x.secId)!, gainPer: price(l.secById.get(x.secId)!.key) * 100 - x.cost }))
        .sort((a, b) => (a.gainPer < 0 ? -1 : 0) - (b.gainPer < 0 ? -1 : 0) || a.gainPer - b.gainPer || b.x.cost - a.x.cost);
      for (const { x, sec, gainPer } of lots) {
        const need = -deficit(c);
        if (need <= minTrade) break;
        const dollars = Math.min(x.qty * price(sec.key) * 100, need);
        const qty = dollars / (price(sec.key) * 100);
        const sold = pushTrade(x.accountId, sec, 'sell', dollars, gainPer * qty);
        if (!sold) continue;
        estGain += gainPer * qty;
        let left = sold;
        for (const u of [...target.keys()].filter((y) => deficit(y) > 0 && rep.has(y) && y !== 'Cash').sort((a, b) => deficit(b) - deficit(a))) {
          if (left < minTrade) break;
          left -= pushTrade(x.accountId, rep.get(u)!, 'buy', Math.min(left, deficit(u)));
        }
      }
    }
  }
  const finalTotal = [...classValue.values()].reduce((a, v) => a + v, 0) + (newCash - trades.filter((t) => t.side === 'buy').reduce((a, t) => a + strToCents(t.amount), 0) + trades.filter((t) => t.side === 'sell').reduce((a, t) => a + strToCents(t.amount), 0) - 0);
  const denom = finalTotal > 0 ? finalTotal : total;
  // One line per account × symbol × side.
  const merged = new Map<string, (typeof trades)[number]>();
  for (const t of trades) {
    const k = `${t.accountId}|${t.symbol}|${t.side}`;
    const m = merged.get(k);
    if (!m) merged.set(k, { ...t });
    else {
      m.qty = String(Math.round((Number(m.qty) + Number(t.qty)) * 10_000) / 10_000);
      m.amount = centsToStr(strToCents(m.amount) + strToCents(t.amount));
      if (t.estRealizedGain !== undefined) m.estRealizedGain = centsToStr(strToCents(m.estRealizedGain ?? '0') + strToCents(t.estRealizedGain));
    }
  }
  return {
    trades: [...merged.values()].sort((a, b) => (a.side === b.side ? strToCents(b.amount) - strToCents(a.amount) : a.side === 'sell' ? -1 : 1)),
    after: [...classValue.entries()].map(([assetClass, v]) => ({ assetClass, pct: round2((v / denom) * 100) })),
    estRealizedGain: centsToStr(Math.round(estGain)),
  };
}

// ───────────────────────────────────────────────────────────────────────────── handlers

export const handlers: MockHandlers = {
  portfolio_rebuild: async (req, ctx) => {
    const l = readPortfolio(ctx, resolvePf(ctx, req.instanceId));
    const c = ctx as MockCallCtx;
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      c.checkCancelled();
      c.progress(i, steps, ['Reading transactions', 'Replaying lots', 'Matching sales', 'Classifying gains', 'Valuing positions', 'Checking invariants'][i]);
      await ctx.sleep(90);
    }
    const book = rebuild(l);
    c.progress(steps, steps, 'Done');
    return { lots: book.lots.length, realizedEvents: book.realized.length };
  },

  portfolio_summary: (req, ctx) => summary(ctx, readPortfolio(ctx, resolvePf(ctx, req.instanceId))),

  portfolio_performance: (req, ctx) => {
    const l = readPortfolio(ctx, resolvePf(ctx, req.instanceId));
    const today = ctx.clock.today();
    const first = l.txns[0]?.date ?? today;
    const back = (days: number) => addDays(today, -days);
    const from = (() => {
      switch (req.range) {
        case '1m':
          return back(31);
        case '3m':
          return back(92);
        case 'ytd':
          return `${today.slice(0, 4)}-01-01`;
        case '1y':
          return back(365);
        case '5y':
          return back(365 * 5);
        default:
          return first;
      }
    })();
    const start = from < first ? first : from;
    const span = (new Date(`${today}T12:00:00`).getTime() - new Date(`${start}T12:00:00`).getTime()) / DAY;
    const step = span > 800 ? 7 : span > 400 ? 3 : 1;
    const pts = sweep(ctx, l, start, today, step);
    const twr: number[] = [];
    let idx = 1;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && pts[i - 1].value > 0) idx *= (pts[i].value - pts[i].flow) / pts[i - 1].value;
      twr.push(idx - 1);
    }
    const bench = req.benchmark ?? l.set.benchmark;
    let benchmark: number[] | undefined;
    if (bench && instrument(bench)) {
      const b0 = priceFor(ctx, bench, pts[0].day, today) ?? 1;
      benchmark = pts.map((p) => (priceFor(ctx, bench, p.day, today) ?? b0) / b0 - 1);
    }
    const flows = [{ date: pts[0].day, amount: -pts[0].value }, ...pts.slice(1).filter((p) => p.flow).map((p) => ({ date: p.day, amount: -p.flow })), { date: today, amount: pts[pts.length - 1].value }].filter((f) => f.amount !== 0);
    return {
      t: pts.map((p) => new Date(`${p.day}T12:00:00`).getTime()),
      value: pts.map((p) => p.value / 100),
      contributions: pts.map((p) => p.contrib / 100),
      twr,
      benchmark,
      xirr: xirr(flows),
    };
  },

  portfolio_rebalance_plan: (req, ctx) => rebalance(ctx, readPortfolio(ctx, resolvePf(ctx, req.instanceId)), req),

  portfolio_dividends: (req, ctx) => {
    const l = readPortfolio(ctx, resolvePf(ctx, req.instanceId));
    const book = rebuild(l);
    const today = ctx.clock.today();
    const year = Number(req.year) || Number(today.slice(0, 4));
    const out: { month: string; paid: string; projected: string }[] = [];
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      const paid = book.dividends.filter((d) => d.date.startsWith(key)).reduce((s, d) => s + d.amount, 0);
      let projected = 0;
      if (key >= today.slice(0, 7)) {
        // Same month last year, scaled by today's position sizes.
        const ly = `${year - 1}-${String(m).padStart(2, '0')}`;
        const last = book.dividends.filter((d) => d.date.startsWith(ly));
        for (const d of last) {
          const qtyThen = rebuild(l, d.date).lots.filter((x) => x.secId === d.secId && x.accountId === d.accountId).reduce((s, x) => s + x.qty, 0);
          const qtyNow = book.lots.filter((x) => x.secId === d.secId && x.accountId === d.accountId).reduce((s, x) => s + x.qty, 0);
          projected += qtyThen > 0 ? (d.amount * qtyNow) / qtyThen : 0;
        }
        if (key === today.slice(0, 7)) projected = Math.max(0, projected - paid);
      }
      out.push({ month: key, paid: centsToStr(paid), projected: centsToStr(Math.round(projected)) });
    }
    return out;
  },

  portfolio_realized: (req, ctx) => {
    const l = readPortfolio(ctx, resolvePf(ctx, req.instanceId));
    const year = String(req.year);
    const ev = rebuild(l).realized.filter((e) => e.sold.startsWith(year));
    const lots = ev.map((e) => ({ symbol: l.secById.get(e.secId)?.key ?? '', acquired: e.acquired, sold: e.sold, qty: String(Math.round(e.qty * 10_000) / 10_000), proceeds: centsToStr(e.proceeds), basis: centsToStr(e.basis), gain: centsToStr(e.gain), term: e.term }));
    return { lots, totals: { short: centsToStr(ev.filter((e) => e.term === 'short').reduce((s, e) => s + e.gain, 0)), long: centsToStr(ev.filter((e) => e.term === 'long').reduce((s, e) => s + e.gain, 0)) } };
  },
};

export function setup(ctx: MockCtx): void {
  // Money HQ values the investment account through this (§16.8 cross-app link).
  ctx.services.provide('portfolio.valueAt', (c: MockCtx, day: string): number | null => {
    const set = pfSets(c).all()[0];
    if (!set || !dbs(c).has(set.dbs.txns)) return null;
    const l = readPortfolio(c, set);
    const today = c.clock.today();
    // Today's value IS portfolio_summary.totalValue (same quotes and rounding), so Money HQ's Brokerage row, net
    // worth and Portfolio's "Total value" can never differ — not even by a cent.
    if (day >= today) return strToCents(summary(c, l).totalValue.amount);
    return valueOfBook(c, l, rebuild(l, day), day, today);
  });
  /** Date of Portfolio's first transaction (Money HQ's net-worth series reaches back to it, like Rust). */
  ctx.services.provide('portfolio.firstDate', (c: MockCtx): string | null => {
    const set = pfSets(c).all()[0];
    if (!set || !dbs(c).has(set.dbs.txns)) return null;
    const days = readPortfolio(c, set).txns.map((t) => t.date).filter((d) => d > '1970-01-01');
    return days.length ? days.reduce((a, b) => (a < b ? a : b)) : null;
  });
  /** Realised gains and dividends for the tax estimator (§16.4). */
  ctx.services.provide('portfolio.taxYear', (instanceId: Id | null, year: number) => {
    const set = resolvePf(ctx, instanceId);
    const l = readPortfolio(ctx, set);
    const book = rebuild(l);
    const y = String(year);
    const taxableIds = new Set(l.accounts.filter((a) => a.tax === 'taxable').map((a) => a.id));
    const ev = book.realized.filter((e) => e.sold.startsWith(y) && taxableIds.has(e.accountId));
    const div = book.dividends.filter((d) => d.date.startsWith(y) && d.accountId && taxableIds.has(d.accountId)).reduce((s, d) => s + d.amount, 0);
    return { stcg: ev.filter((e) => e.term === 'short').reduce((s, e) => s + e.gain, 0), ltcg: ev.filter((e) => e.term === 'long').reduce((s, e) => s + e.gain, 0), dividends: div };
  });
}
