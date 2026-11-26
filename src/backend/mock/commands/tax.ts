/**
 * Mock `tax_*` commands (§11.3 Portfolio and tax, §15.6): pack listing, the estimator engine and the quarterly plan
 * (safe harbor, 90% of current year, even split).
 *
 * The estimator is a step-for-step port of `crates/emp-finance/src/tax/engine.rs` (`compute`) over the **same**
 * pack files the desktop app embeds (`crates/emp-finance/packs/tax/*.json`), so the demo and desktop produce the
 * same figures for the same input (PROGRAMME-v3 K5 parity; `src/backend/mock/parity.test.ts`). Only the "Show math"
 * `lines` keep the mock's summing layout (the finance UI test sums them to `totalTax`).
 *
 * Definitions shared with Rust:
 *   - `effectiveRate` = total tax ÷ AGI (N-MO3 `tax.effective`; IRS SOI "average tax rate" uses AGI:
 *     https://www.irs.gov/statistics/soi-tax-stats-individual-income-tax-rates-and-tax-shares).
 *   - `deduction`: `{ itemized, mode }` — `auto` (default) takes the larger of the itemised total after floors and
 *     caps (`itemizedWouldBe`) and the standard deduction plus the 2026 non-itemiser charitable deduction
 *     ($1,000 / $2,000 MFJ, cash; IRS Pub 505 (2026) What's New, https://www.irs.gov/publications/p505);
 *     `standard` takes the latter; `itemized` itemises even when smaller (IRC §63(e)). Bare `'standard'` /
 *     `'auto'` carry no entries, so neither the cash-gift deduction nor `itemizedWouldBe` applies.
 *   - Itemised charitable gifts count only above 0.5% of AGI from 2026 (same source).
 */
import type { TaxEstimate, TaxInput, TaxPackInfo } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import usFederal2026 from '../../../../crates/emp-finance/packs/tax/us-federal-2026.json';
import genericPack from '../../../../crates/emp-finance/packs/tax/generic.json';

type StatusMap<T> = Record<string, T>;
type Dec = string | number;

interface PackJson {
  id: string;
  name: string;
  year: number;
  tier: 'estimator' | 'organizer' | 'custom';
  version: string;
  verifiedOn: string | null;
  country?: string;
  currency?: string;
  filingStatuses: string[];
  brackets: StatusMap<{ upTo: Dec | null; rate: Dec }[]>;
  standardDeduction: StatusMap<Dec>;
  additionalStdDeduction65OrBlind?: StatusMap<Dec>;
  preferentialRates?: { ltcgQualifiedDiv: { upTo: StatusMap<Dec | null>; rate: Dec }[] };
  seTax?: SeTax;
  niit?: { rate: Dec; threshold: StatusMap<Dec> };
  credits?: { id: string; label?: string; kind: 'per_dependent' | 'user_amount'; amount?: Dec; phaseout?: { start: StatusMap<Dec>; per1000: Dec }; refundablePerDependent?: Dec; refundableEarnedThreshold?: Dec; refundableEarnedRate?: Dec }[];
  capitalLossLimit?: StatusMap<Dec>;
  socialSecurity?: { base1: StatusMap<Dec>; base2: StatusMap<Dec> };
  itemizedRules?: { kind: string; cap?: StatusMap<Dec>; capPhasedown?: { start: StatusMap<Dec>; rate: Dec; floor: StatusMap<Dec> }; agiFloorPct?: Dec }[];
  nonItemizerCharity?: { kinds: string[]; cap: StatusMap<Dec> };
  estimated?: { periods: { id: string; due: string }[]; safeHarbor: { priorYearPct: Dec; highIncomePct: Dec; highIncomeAgi: StatusMap<Dec>; currentYearPct: Dec } };
  rounding: 'whole_dollar_half_up' | 'cents_half_up';
}

interface SeTax {
  netEarningsFactor: Dec;
  ssRate: Dec;
  medicareRate: Dec;
  ssWageBase?: Dec | null;
  deductibleShare: Dec;
  minimumNetEarnings?: Dec | null;
  addlMedicare?: { rate: Dec; threshold: StatusMap<Dec> } | null;
}

const PACKS: PackJson[] = [usFederal2026 as unknown as PackJson, genericPack as unknown as PackJson];

function packFor(id: string): PackJson | undefined {
  return PACKS.find((p) => p.id === id);
}

/** Rust `TaxPack::currency_code`: the explicit currency, else USD for a US pack, else none (user-entered figures). */
function currencyOf(p: PackJson): string | undefined {
  return p.currency?.trim() || (p.country === 'US' ? 'USD' : undefined);
}

function infoOf(p: PackJson, selectedYear: number, today: string): TaxPackInfo {
  const currency = currencyOf(p);
  return { id: p.id, name: p.name, year: p.year, tier: p.tier as TaxPackInfo['tier'], version: p.version, verifiedOn: p.verifiedOn ?? '', stale: isStale(p, selectedYear, today), ...(currency ? { currency } : {}) };
}

/** Rust `TaxPack::is_stale`: another year, unverified, or verified more than 13 months before today. */
function isStale(p: PackJson, year: number, today: string): boolean {
  if (p.tier === 'custom') return false;
  if (p.year !== year) return true;
  if (!p.verifiedOn) return true;
  const [y, m, d] = p.verifiedOn.split('-').map(Number);
  const lim = new Date(Date.UTC(y, m - 1 + 13, 1));
  // chrono's checked_add_months clamps the day to the target month's length.
  const last = new Date(Date.UTC(lim.getUTCFullYear(), lim.getUTCMonth() + 1, 0)).getUTCDate();
  lim.setUTCDate(Math.min(d, last));
  return today > lim.toISOString().slice(0, 10);
}

/** Parses an IPC decimal string (or a pack value); bad input reads as 0, like the mock always has. */
const n = (s: Dec | undefined | null) => {
  const x = typeof s === 'number' ? s : Number(String(s ?? '0').replace(/[−]/g, '-').replace(/[, $]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const get = (m: StatusMap<Dec> | undefined, status: string) => n(m ? (m[status] ?? m['*']) : 0);
/** Half away from zero at `dp` decimals (rust_decimal `MidpointAwayFromZero`), robust to binary float noise. */
function roundHalfUp(x: number, dp: number): number {
  const f = 10 ** dp;
  const v = Math.abs(x) * f;
  const r = Math.round(v + 1e-7 * Math.max(1, v / 1e6)) / f;
  return x < 0 ? -r : r === 0 ? 0 : r;
}
const money = (x: number) => roundHalfUp(x, 2).toFixed(2);
/** Rust renders `Decimal` without trailing zeros (`normalize`); keep strings comparable. */
const dec = (x: number) => String(Number(roundHalfUp(x, 8).toFixed(8)));

function customOverrides(p: PackJson, input: TaxInput): PackJson {
  if (p.tier !== 'custom') return p;
  const c = (input.custom ?? {}) as { brackets?: { upTo: Dec | null; rate: Dec }[]; standardDeduction?: Dec; seRate?: Dec };
  const out: PackJson = { ...p };
  if (c.brackets?.length) out.brackets = { '*': c.brackets };
  if (c.standardDeduction !== undefined) out.standardDeduction = { '*': c.standardDeduction };
  if (c.seRate !== undefined) out.seTax = { netEarningsFactor: 1, ssRate: c.seRate, medicareRate: 0, ssWageBase: null, deductibleShare: 0, minimumNetEarnings: null, addlMedicare: null };
  return out;
}

interface Core {
  gross: number;
  agi: number;
  deduction: TaxEstimate['deduction'];
  taxable: number;
  ordinaryTax: number;
  preferentialTax: number;
  seTax: number;
  addlMedicare: number;
  niit: number;
  nonrefundable: number;
  refundable: number;
  totalTax: number;
  brackets: TaxEstimate['brackets'];
  marginal: number;
}

function bracketsFor(p: PackJson, status: string) {
  return p.brackets[status] ?? p.brackets['*'];
}

/** Port of Rust `itemized_amount`: per kind, minus the AGI floor, then capped (with the SALT-style phase-down). */
function itemizedAmount(p: PackJson, entries: { kind: string; amount: string }[], agi: number, status: string): number {
  let total = 0;
  for (const k of [...new Set(entries.map((e) => e.kind))].sort()) {
    let amt = entries.filter((e) => e.kind === k).reduce((s, e) => s + Math.max(0, n(e.amount)), 0);
    const rule = p.itemizedRules?.find((r) => r.kind === k);
    if (rule) {
      if (rule.agiFloorPct !== undefined) amt = Math.max(0, amt - agi * n(rule.agiFloorPct));
      if (rule.cap) {
        let cap = get(rule.cap, status);
        const ph = rule.capPhasedown;
        if (ph) cap = Math.max(cap - Math.max(0, agi - get(ph.start, status)) * n(ph.rate), get(ph.floor, status));
        amt = Math.min(amt, cap);
      }
    }
    total += amt;
  }
  return total;
}

/** Port of Rust `compute` (crates/emp-finance/src/tax/engine.rs). */
function compute(p: PackJson, input: TaxInput, scale: number): Core {
  const status = input.filingStatus;
  const rd = (d: number) => roundHalfUp(d, p.rounding === 'whole_dollar_half_up' ? 0 : 2);
  const sum = (k: string) => input.incomes.filter((i) => i.kind === k).reduce((s, i) => s + n(i.amount) * scale, 0);
  const wages = sum('wages');
  const seProfit = sum('self_employment');
  const interest = sum('interest');
  const odiv = sum('ordinary_dividends');
  const qdiv = sum('qualified_dividends');
  const stcg = sum('stcg');
  const ltcg = sum('ltcg');
  const retirement = sum('retirement');
  const ss = sum('social_security');
  const unemployment = sum('unemployment');
  const rental = sum('rental');
  const other = sum('other');

  // 1. Self-employment tax.
  let seTax = 0;
  let seDeductible = 0;
  let netSe = 0;
  const se = p.seTax;
  if (se) {
    netSe = Math.max(0, seProfit * n(se.netEarningsFactor));
    if (se.minimumNetEarnings != null && netSe < n(se.minimumNetEarnings)) netSe = 0;
    const ssBase = se.ssWageBase != null ? Math.min(netSe, Math.max(0, n(se.ssWageBase) - wages)) : netSe;
    const ssPart = ssBase * n(se.ssRate);
    const medPart = netSe * n(se.medicareRate);
    seTax = rd(ssPart + medPart);
    seDeductible = roundHalfUp((ssPart + medPart) * n(se.deductibleShare), 2);
  }
  const am = se?.addlMedicare;
  const addlMedicare = am ? rd(Math.max(0, wages + netSe - get(am.threshold, status)) * n(am.rate)) : 0;

  // Capital gains netting.
  const netCap = stcg + ltcg;
  let capInIncome: number;
  let prefCap: number;
  if (netCap < 0) {
    const limit = p.capitalLossLimit ? get(p.capitalLossLimit, status) : 3000;
    capInIncome = Math.max(netCap, -limit);
    prefCap = 0;
  } else {
    capInIncome = netCap;
    prefCap = Math.max(0, Math.min(ltcg, netCap));
  }
  const adjustments = input.adjustments.reduce((s, a) => s + Math.max(0, n(a.amount)), 0);
  const nonSs = wages + seProfit + interest + odiv + qdiv + capInIncome + retirement + unemployment + rental + other;

  // Taxable Social Security (provisional income method).
  let taxableSs = ss;
  if (p.socialSecurity) {
    if (ss > 0) {
      const provisional = nonSs - adjustments - seDeductible + ss * 0.5;
      const b1 = get(p.socialSecurity.base1, status);
      const b2 = get(p.socialSecurity.base2, status);
      if (provisional <= b1) taxableSs = 0;
      else if (provisional <= b2) taxableSs = Math.min(ss * 0.5, (provisional - b1) * 0.5);
      else taxableSs = Math.min(ss * 0.85, 0.85 * (provisional - b2) + Math.min(ss * 0.5, (b2 - b1) * 0.5));
    } else taxableSs = 0;
  }
  const gross = rd(nonSs + taxableSs);
  // 2. AGI.
  const agi = rd(gross - adjustments - seDeductible);

  // 3. Deduction (`mode`, default auto): auto = the larger of itemised (after floors/caps) and standard + the
  // non-itemiser charitable deduction; standard = the latter; itemized = itemise regardless (IRC §63(e) election).
  const standard = rd(get(p.standardDeduction, status) + get(p.additionalStdDeduction65OrBlind, status) * (input.age65OrBlind ?? 0));
  const obj = typeof input.deductions === 'object' && input.deductions ? input.deductions : undefined;
  const entries = obj?.itemized ?? [];
  const choice = obj ? (obj.mode ?? 'auto') : 'standard';
  const itemizedWouldBe = entries.length || choice === 'itemized' ? rd(itemizedAmount(p, entries, agi, status)) : undefined;
  const nc = p.nonItemizerCharity;
  const charityNi = nc ? rd(Math.min(entries.filter((e) => nc.kinds.includes(e.kind)).reduce((s, e) => s + Math.max(0, n(e.amount)), 0), get(nc.cap, status))) : 0;
  const useItemized = itemizedWouldBe !== undefined && (choice === 'itemized' || (choice === 'auto' && itemizedWouldBe > standard + charityNi));
  const deductionAmount = useItemized ? itemizedWouldBe! : standard + charityNi;
  const deduction: TaxEstimate['deduction'] = {
    kind: useItemized ? 'itemized' : 'standard',
    amount: dec(deductionAmount),
    standardWouldBe: dec(standard),
    ...(itemizedWouldBe !== undefined ? { itemizedWouldBe: dec(itemizedWouldBe) } : {}),
  };
  // 4. Taxable income.
  const taxable = Math.max(0, agi - deductionAmount);

  // 5. Ordinary + preferential stacking.
  const brackets = bracketsFor(p, status) ?? [];
  const prefIncome = p.preferentialRates ? Math.min(Math.max(0, qdiv + prefCap), taxable) : 0;
  const ordinaryTaxable = taxable - prefIncome;
  let ordExact = 0;
  const bands: TaxEstimate['brackets'] = [];
  let from = 0;
  for (const b of brackets) {
    const to = b.upTo === null ? null : n(b.upTo);
    const top = to === null ? ordinaryTaxable : Math.min(to, ordinaryTaxable);
    const taxed = Math.max(0, top - from);
    ordExact += taxed * n(b.rate);
    bands.push({ rate: dec(n(b.rate)), from: dec(from), to: to === null ? null : dec(to), taxed: dec(taxed) });
    if (to !== null && to < ordinaryTaxable) from = to;
    else break;
  }
  const ordinaryTax = rd(ordExact);
  const marginal = n(brackets.find((b) => b.upTo === null || ordinaryTaxable <= n(b.upTo))?.rate ?? 0);
  let prefExact = 0;
  if (p.preferentialRates) {
    let lo = ordinaryTaxable;
    const hi = taxable;
    for (const band of p.preferentialRates.ltcgQualifiedDiv) {
      if (lo >= hi) break;
      const capRaw = band.upTo[status] !== undefined ? band.upTo[status] : band.upTo['*'];
      const top = capRaw == null ? hi : Math.min(n(capRaw), hi);
      if (top > lo) {
        prefExact += (top - lo) * n(band.rate);
        lo = top;
      }
    }
  }
  const preferentialTax = rd(prefExact);

  // NIIT.
  const niit = p.niit ? rd(Math.min(Math.max(0, interest + odiv + qdiv + Math.max(0, netCap) + Math.max(0, rental)), Math.max(0, agi - get(p.niit.threshold, status))) * n(p.niit.rate)) : 0;

  // 6. Credits.
  const incomeTax = ordinaryTax + preferentialTax;
  let nonref = 0;
  let refundable = 0;
  const earned = wages + seProfit - seDeductible;
  for (const c of p.credits ?? []) {
    if (c.kind !== 'per_dependent' || input.dependents === 0) continue;
    const deps = input.dependents;
    let amt = n(c.amount) * deps;
    if (c.phaseout) {
      const over = Math.max(0, agi - get(c.phaseout.start, status));
      amt = Math.max(0, amt - Math.ceil(over / 1000) * n(c.phaseout.per1000));
    }
    const room = Math.max(0, incomeTax - nonref);
    const used = Math.min(amt, room);
    nonref += used;
    const leftover = amt - used;
    if (leftover > 0 && c.refundablePerDependent !== undefined) {
      const earnedCap = c.refundableEarnedRate !== undefined ? Math.max(0, earned - n(c.refundableEarnedThreshold)) * n(c.refundableEarnedRate) : Infinity;
      refundable += Math.min(leftover, n(c.refundablePerDependent) * deps, earnedCap);
    }
  }
  for (const claim of input.credits) {
    const inPack = p.credits?.find((c) => c.id === claim.id);
    if (inPack?.kind === 'per_dependent') continue;
    const a = n(claim.amount);
    if (a > 0) nonref += Math.min(a, Math.max(0, incomeTax - nonref));
  }
  const nonrefundable = rd(nonref);
  const refundableR = rd(refundable);
  const totalTax = Math.max(0, incomeTax - nonrefundable) + seTax + addlMedicare + niit;
  return { gross, agi, deduction, taxable: rd(taxable), ordinaryTax, preferentialTax, seTax, addlMedicare, niit, nonrefundable, refundable: refundableR, totalTax, brackets: bands, marginal };
}

/** Port of Rust `validate_input`; failures surface as `INVALID` (the mock's `ctx.fail`). */
function validate(p: PackJson, input: TaxInput): string | null {
  if (!p.filingStatuses.includes(input.filingStatus)) return `filing status ${JSON.stringify(input.filingStatus)} is not in pack ${p.id}`;
  if (input.dependents > 30 || (input.age65OrBlind ?? 0) > 2) return 'dependents ≤ 30 and age65OrBlind ≤ 2';
  if (input.incomes.some((i) => n(i.amount) < 0 && !['stcg', 'ltcg', 'rental', 'self_employment', 'other'].includes(i.kind))) return 'only gains, rental, self-employment and other income may be negative';
  return null;
}

export function estimate(input: TaxInput, today: string): TaxEstimate {
  const base = packFor(input.packId) ?? PACKS[0];
  const p = customOverrides(base, input);
  const c = compute(p, input, 1);
  const withheld = n(input.withheld);
  const estimatedPaid = n(input.estimatedPaid);
  const balance = c.totalTax - c.refundable - withheld - estimatedPaid;
  const unsure = (input.custom as { unsure?: boolean } | undefined)?.unsure;
  let range: TaxEstimate['range'];
  if (unsure) {
    const b = (x: Core) => x.totalTax - x.refundable - withheld - estimatedPaid;
    const lo = b(compute(p, input, 0.9));
    const hi = b(compute(p, input, 1.1));
    range = { low: dec(Math.min(lo, hi)), high: dec(Math.max(lo, hi)) };
  }
  const lines: TaxEstimate['lines'] = [
    { label: 'Ordinary income tax', value: money(c.ordinaryTax), packRef: 'brackets' },
    { label: 'Tax on qualified dividends & long-term gains', value: money(c.preferentialTax), packRef: 'preferentialRates.ltcgQualifiedDiv' },
    { label: 'Credits', value: money(-c.nonrefundable), packRef: 'credits' },
    { label: 'Self-employment tax', value: money(c.seTax), packRef: 'seTax' },
    ...(c.addlMedicare ? [{ label: 'Additional Medicare tax', value: money(c.addlMedicare), packRef: 'seTax.addlMedicare' }] : []),
    ...(c.niit ? [{ label: 'Net investment income tax', value: money(c.niit), packRef: 'niit' }] : []),
    { label: 'Estimated total tax', value: money(c.totalTax) },
    ...(c.refundable ? [{ label: 'Refundable credits', value: money(-c.refundable), packRef: 'credits' }] : []),
    { label: 'Withholding', value: money(-withheld) },
    { label: 'Estimated payments made', value: money(-estimatedPaid) },
    { label: balance >= 0 ? 'Estimated balance due' : 'Estimated refund', value: money(balance) },
  ];
  return {
    gross: dec(c.gross),
    agi: dec(c.agi),
    deduction: c.deduction,
    taxable: dec(c.taxable),
    ordinaryTax: dec(c.ordinaryTax),
    preferentialTax: dec(c.preferentialTax),
    seTax: dec(c.seTax),
    niit: dec(c.niit),
    credits: dec(c.nonrefundable + c.refundable),
    totalTax: dec(c.totalTax),
    brackets: c.brackets,
    // Total tax ÷ AGI — the same definition as Rust (see the header).
    effectiveRate: c.agi > 0 ? c.totalTax / c.agi : 0,
    marginalRate: c.marginal,
    balance: dec(balance),
    ...(range ? { range } : {}),
    lines,
    packVersion: p.version,
    verifiedOn: p.verifiedOn ?? '',
    stale: isStale(p, input.year, today),
    disclaimer: `Estimates for planning only, based on ${p.name} v${p.version} verified ${p.verifiedOn ?? 'unverified'}. Not tax advice. Verify with official sources or a qualified professional.`,
    ...(currencyOf(p) ? { currency: currencyOf(p) } : {}),
  };
}

export const handlers: MockHandlers = {
  tax_packs: (_req, ctx) => {
    const today = ctx.clock.today();
    const year = Number(today.slice(0, 4));
    return PACKS.map((p) => infoOf(p, Math.max(year, p.year), today));
  },

  tax_estimate: (req, ctx) => {
    if (!req || !Array.isArray(req.incomes)) ctx.fail('INVALID', 'Add at least one income', { field: 'incomes' });
    const p = packFor(req.packId);
    if (!p) ctx.fail('NOT_FOUND', `Unknown tax pack ${req.packId}`, { field: 'packId' });
    const bad = validate(p!, req);
    if (bad) ctx.fail('INVALID', bad);
    return estimate(req, ctx.clock.today());
  },

  tax_quarterly_plan: (req, ctx) => {
    const pk = packFor(req.packId) ?? PACKS[0];
    const est0 = (pk.estimated ?? PACKS[0].estimated)!;
    const p = {
      periods: est0.periods,
      safeHarbor: { prior: n(est0.safeHarbor.priorYearPct), high: n(est0.safeHarbor.highIncomePct), highAgi: { '*': get(est0.safeHarbor.highIncomeAgi, '*') }, current: n(est0.safeHarbor.currentYearPct) },
    };
    const today = ctx.clock.today();
    const year = req.year || pk.year;
    const shift = (d: string) => d.replace(/^\d{4}/, (y) => String(Number(y) + (year - pk.year)));
    const periods = p.periods.map((x) => ({ id: x.id, due: shift(x.due) }));
    const paidList = (req.paid ?? []).map((x) => ({ date: x.date, amount: n(x.amount) })).sort((a, b) => (a.date < b.date ? -1 : 1));
    // Allocate payments to periods in order (each payment covers the earliest period whose due date it precedes).
    const paidBy = new Map<string, number>();
    for (const pay of paidList) {
      const per = periods.find((x) => pay.date <= addDays(x.due, 0)) ?? periods[periods.length - 1];
      paidBy.set(per.id, (paidBy.get(per.id) ?? 0) + pay.amount);
    }
    const est = req.estimate;
    const total = n(est.totalTax);
    const withheld = Math.max(0, total - n(est.balance) - paidList.reduce((s, x) => s + x.amount, 0));
    const remaining = periods.filter((x) => x.due >= today && !(paidBy.get(x.id) ?? 0));
    const k = Math.max(1, remaining.length);
    const already = paidList.reduce((s, x) => s + x.amount, 0);
    let required = 0;
    let note = '';
    if (req.method === 'safe_harbor') {
      const agi = n(req.priorYearAgi);
      const high = agi > p.safeHarbor.highAgi['*'];
      const pct = high ? p.safeHarbor.high : p.safeHarbor.prior;
      required = Math.max(0, pct * n(req.priorYearTax) - withheld - already);
      note = `Safe harbor: ${Math.round(pct * 100)}% of last year's tax (${fmt(n(req.priorYearTax))}), minus expected withholding and payments already made, spread over the remaining ${k === 1 ? 'payment' : `${k} payments`}.`;
    } else if (req.method === 'current_90') {
      required = Math.max(0, p.safeHarbor.current * total - withheld - already);
      note = `90% of this year's estimated tax (${fmt(total)}), minus expected withholding and payments already made, over ${k === 1 ? 'one remaining payment' : `${k} remaining payments`}.`;
    } else {
      required = Math.max(0, n(est.balance));
      note = `The estimated balance due, split evenly over ${k === 1 ? 'the last payment' : `the ${k} remaining payments`}.`;
    }
    const each = Math.ceil(required / k);
    const due = periods.map((x) => {
      const paid = paidBy.get(x.id) ?? 0;
      const isRemaining = remaining.some((r) => r.id === x.id);
      const days = Math.round((new Date(`${x.due}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000);
      const status: 'upcoming' | 'due_soon' | 'paid' | 'late' = paid > 0 ? 'paid' : days < 0 ? 'late' : days <= 21 ? 'due_soon' : 'upcoming';
      return { period: x.id, date: x.due, suggested: (isRemaining ? each : 0).toFixed(2), paid: paid.toFixed(2), status };
    });
    return { due, method: req.method, note };
  },
};

function addDays(day: string, k: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + k);
  return d.toISOString().slice(0, 10);
}

function fmt(x: number): string {
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

export function setup(_ctx: MockCtx): void {
  /* packs are static */
}
