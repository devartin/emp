/**
 * Mock `tax_*` commands (§11.3 Portfolio and tax, §15.6): pack listing, the estimator engine (SE tax, AGI,
 * standard vs itemised, ordinary brackets with LTCG/qualified dividends stacked on top, NIIT, additional Medicare,
 * credits with phase-outs, pack rounding) and the quarterly plan (safe harbor, 90% of current year, even split).
 *
 * The US pack values below exist only so the browser preview behaves realistically. The desktop app reads the
 * authoritative `crates/emp-store/packs/tax/us-federal-2026.json`, transcribed and verified from IRS publications
 * (§15.6); this mock pack is versioned `-preview` so it can never be mistaken for it.
 */
import type { TaxEstimate, TaxInput, TaxPackInfo } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';

type Status = 'single' | 'mfj' | 'mfs' | 'hoh' | 'qss';

interface Pack {
  info: Omit<TaxPackInfo, 'stale'>;
  brackets: Record<Status, { upTo: number | null; rate: number }[]>;
  standard: Record<Status, number>;
  addl65: Record<Status, number>;
  ltcg: { upTo: Record<Status, number | null>; rate: number }[];
  se: { factor: number; ss: number; medicare: number; wageBase: number; addl: number; addlThreshold: Record<Status, number> };
  niit: { rate: number; threshold: Record<Status, number> };
  ctc: { amount: number; start: Record<Status, number>; per1000: number };
  periods: { id: string; due: string }[];
  safeHarbor: { prior: number; high: number; highAgi: Record<string, number>; current: number };
  deadlines: { name: string; date: string }[];
}

const S = (single: number, mfj: number, mfs: number, hoh: number, qss = mfj): Record<Status, number> => ({ single, mfj, mfs, hoh, qss });

function brackets(rows: [number | null, number | null, number | null, number | null, number][]): Pack['brackets'] {
  const pick = (i: number) => rows.map((r) => ({ upTo: r[i] as number | null, rate: r[4] }));
  return { single: pick(0), mfj: pick(1), mfs: pick(2), hoh: pick(3), qss: pick(1) };
}

const US_2026: Pack = {
  info: { id: 'us-federal-2026', name: 'US Federal', year: 2026, tier: 'estimator', version: '1.0.0-preview', verifiedOn: '2026-01-12' },
  brackets: brackets([
    [12_400, 24_800, 12_400, 17_700, 0.1],
    [50_400, 100_800, 50_400, 67_450, 0.12],
    [105_700, 211_400, 105_700, 105_700, 0.22],
    [201_775, 403_550, 201_775, 201_750, 0.24],
    [256_225, 512_450, 256_225, 256_200, 0.32],
    [640_600, 768_700, 384_350, 640_600, 0.35],
    [null, null, null, null, 0.37],
  ]),
  standard: S(16_100, 32_200, 16_100, 24_150),
  addl65: S(2_050, 1_650, 1_650, 2_050),
  ltcg: [
    { upTo: S(49_450, 98_900, 49_450, 66_200), rate: 0 },
    { upTo: S(545_500, 613_700, 306_850, 579_600), rate: 0.15 },
    { upTo: { single: null, mfj: null, mfs: null, hoh: null, qss: null }, rate: 0.2 },
  ],
  se: { factor: 0.9235, ss: 0.124, medicare: 0.029, wageBase: 184_500, addl: 0.009, addlThreshold: S(200_000, 250_000, 125_000, 200_000) },
  niit: { rate: 0.038, threshold: S(200_000, 250_000, 125_000, 200_000) },
  ctc: { amount: 2_200, start: S(200_000, 400_000, 200_000, 200_000), per1000: 50 },
  periods: [
    { id: 'Q1', due: '2026-04-15' },
    { id: 'Q2', due: '2026-06-15' },
    { id: 'Q3', due: '2026-09-15' },
    { id: 'Q4', due: '2027-01-15' },
  ],
  safeHarbor: { prior: 1, high: 1.1, highAgi: { single: 150_000, mfs: 75_000, '*': 150_000 }, current: 0.9 },
  deadlines: [{ name: 'Federal return due', date: '2027-04-15' }],
};

const GENERIC: Pack = {
  ...US_2026,
  info: { id: 'generic', name: 'Generic / custom', year: 2026, tier: 'custom', version: '1.0.0', verifiedOn: '2026-01-12' },
};

const PACKS = [US_2026, GENERIC];

function packFor(id: string): Pack | undefined {
  return PACKS.find((p) => p.info.id === id);
}

function isStale(p: Pack, year: number, today: string): boolean {
  if (p.info.tier !== 'custom' && p.info.year !== year) return true;
  const v = new Date(`${p.info.verifiedOn}T12:00:00`);
  v.setMonth(v.getMonth() + 13);
  return v.toISOString().slice(0, 10) < today;
}

const n = (s: string | number | undefined | null) => {
  const x = typeof s === 'number' ? s : Number(String(s ?? '0').replace(/[−]/g, '-').replace(/[, $]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const r0 = (x: number) => Math.round(x); // whole_dollar_half_up for positives
const money = (x: number) => (Math.round(x * 100) / 100).toFixed(2);

function customOverrides(p: Pack, input: TaxInput): Pack {
  const c = input.custom as { brackets?: { upTo: number | null; rate: number }[]; standard?: number; seRate?: number } | undefined;
  if (p.info.tier !== 'custom' || !c) return p;
  const st = input.filingStatus as Status;
  return {
    ...p,
    brackets: c.brackets?.length ? { ...p.brackets, [st]: c.brackets } : p.brackets,
    standard: c.standard !== undefined ? { ...p.standard, [st]: c.standard } : p.standard,
    se: c.seRate !== undefined ? { ...p.se, ss: c.seRate * 0.8, medicare: c.seRate * 0.2 } : p.se,
  };
}

export function estimate(input: TaxInput, today: string, scale = 1): TaxEstimate {
  const base = packFor(input.packId) ?? US_2026;
  const p = customOverrides(base, input);
  const st = (['single', 'mfj', 'mfs', 'hoh', 'qss'].includes(input.filingStatus) ? input.filingStatus : 'single') as Status;
  const inc = (k: string) => input.incomes.filter((i) => i.kind === k).reduce((s, i) => s + n(i.amount), 0) * scale;
  const wages = inc('wages');
  const se = Math.max(0, inc('self_employment'));
  const interest = inc('interest');
  const ordDiv = inc('ordinary_dividends');
  const qualDiv = Math.min(inc('qualified_dividends'), ordDiv || inc('qualified_dividends'));
  const stcg = inc('stcg');
  const ltcg = inc('ltcg');
  const other = inc('retirement') + inc('unemployment') + inc('rental') + inc('other') + inc('social_security') * 0.85;
  // Qualified dividends are a subset of ordinary dividends; count dividends once.
  const dividends = Math.max(ordDiv, qualDiv);
  const netCap = stcg + ltcg;
  const capForIncome = Math.max(-3_000, netCap);
  const gross = wages + se + interest + dividends + capForIncome + other;

  // 1. Self-employment tax
  const netSe = se * p.se.factor;
  const ssRoom = Math.max(0, p.se.wageBase - wages);
  const seSs = Math.min(netSe, ssRoom) * p.se.ss;
  const seMed = netSe * p.se.medicare;
  const addlMedBase = Math.max(0, wages + netSe - p.se.addlThreshold[st]);
  const addlMed = addlMedBase * p.se.addl;
  const seTax = se > 400 ? seSs + seMed : 0;
  const seHalf = seTax * 0.5;

  // 2. AGI
  const adj = input.adjustments.reduce((s, a) => s + Math.max(0, n(a.amount)), 0);
  const agi = Math.max(0, gross - adj - seHalf);

  // 3. Deduction
  const std = p.standard[st] + (input.age65OrBlind ?? 0) * p.addl65[st];
  const itemized = typeof input.deductions === 'object' ? input.deductions.itemized.reduce((s, d) => s + Math.max(0, n(d.amount)), 0) : 0;
  const useItemized = typeof input.deductions === 'object' && itemized > std;
  const deduction = useItemized ? itemized : std;

  // 4. Taxable
  const taxable = Math.max(0, agi - deduction);
  const pref = Math.min(taxable, Math.max(0, qualDiv + Math.max(0, ltcg + Math.min(0, stcg))));
  const ordinaryTaxable = Math.max(0, taxable - pref);

  // 5. Ordinary brackets, then preferential stacked on top
  const bands: TaxEstimate['brackets'] = [];
  let prev = 0;
  let ordinaryTax = 0;
  for (const b of p.brackets[st]) {
    const top = b.upTo ?? Infinity;
    const taxed = Math.max(0, Math.min(ordinaryTaxable, top) - prev);
    ordinaryTax += taxed * b.rate;
    bands.push({ rate: String(b.rate), from: money(prev), to: b.upTo === null ? null : money(b.upTo), taxed: money(taxed) });
    prev = top;
    if (top === Infinity) break;
  }
  let preferentialTax = 0;
  let stackFrom = ordinaryTaxable;
  let left = pref;
  for (const b of p.ltcg) {
    if (left <= 0) break;
    const top = b.upTo[st] ?? Infinity;
    const room = Math.max(0, top - stackFrom);
    const take = Math.min(room, left);
    preferentialTax += take * b.rate;
    stackFrom += take;
    left -= take;
  }
  const marginal = (() => {
    let m = p.brackets[st][0].rate;
    let lo = 0;
    for (const b of p.brackets[st]) {
      if (ordinaryTaxable > lo) m = b.rate;
      lo = b.upTo ?? Infinity;
    }
    return m;
  })();
  // NIIT
  const nii = Math.max(0, interest + dividends + Math.max(0, netCap) + inc('rental'));
  const niit = Math.min(nii, Math.max(0, agi - p.niit.threshold[st])) * p.niit.rate;

  // 6. Credits with phase-outs
  let credits = 0;
  if (input.dependents > 0) {
    const over = Math.max(0, agi - p.ctc.start[st]);
    credits += Math.max(0, input.dependents * p.ctc.amount - Math.ceil(over / 1000) * p.ctc.per1000);
  }
  for (const c of input.credits) credits += Math.max(0, n(c.amount));
  const preCredit = ordinaryTax + preferentialTax;
  const creditsUsed = Math.min(credits, preCredit);

  // 7. Rounding (whole dollars)
  const R = { ordinaryTax: r0(ordinaryTax), preferentialTax: r0(preferentialTax), seTax: r0(seTax), addlMed: r0(addlMed), niit: r0(niit), credits: r0(creditsUsed) };
  const totalTax = Math.max(0, R.ordinaryTax + R.preferentialTax - R.credits) + R.seTax + R.addlMed + R.niit;
  const paid = n(input.withheld) + n(input.estimatedPaid);
  const balance = totalTax - paid;
  const lines: TaxEstimate['lines'] = [
    { label: 'Ordinary income tax', value: money(R.ordinaryTax), packRef: 'brackets' },
    { label: 'Tax on qualified dividends & long-term gains', value: money(R.preferentialTax), packRef: 'preferentialRates.ltcgQualifiedDiv' },
    { label: 'Credits', value: money(-R.credits), packRef: 'credits' },
    { label: 'Self-employment tax', value: money(R.seTax), packRef: 'seTax' },
    ...(R.addlMed ? [{ label: 'Additional Medicare tax', value: money(R.addlMed), packRef: 'seTax.addlMedicare' }] : []),
    ...(R.niit ? [{ label: 'Net investment income tax', value: money(R.niit), packRef: 'niit' }] : []),
    { label: 'Estimated total tax', value: money(totalTax) },
    { label: 'Withholding', value: money(-n(input.withheld)) },
    { label: 'Estimated payments made', value: money(-n(input.estimatedPaid)) },
    { label: balance >= 0 ? 'Estimated balance due' : 'Estimated refund', value: money(balance) },
  ];
  const stale = isStale(base, input.year, today);
  return {
    gross: money(gross),
    agi: money(agi),
    deduction: { kind: useItemized ? 'itemized' : 'standard', amount: money(deduction), standardWouldBe: money(std) },
    taxable: money(taxable),
    ordinaryTax: money(R.ordinaryTax),
    preferentialTax: money(R.preferentialTax),
    seTax: money(R.seTax + R.addlMed),
    niit: money(R.niit),
    credits: money(R.credits),
    totalTax: money(totalTax),
    brackets: bands,
    effectiveRate: gross > 0 ? totalTax / gross : 0,
    marginalRate: marginal,
    balance: money(balance),
    lines,
    packVersion: base.info.version,
    verifiedOn: base.info.verifiedOn,
    stale,
    disclaimer: `Estimates for planning only, based on ${base.info.name} ${base.info.year} v${base.info.version} verified ${base.info.verifiedOn}. Not tax advice. Verify with official sources or a qualified professional.`,
  };
}

export const handlers: MockHandlers = {
  tax_packs: (_req, ctx) => {
    const today = ctx.clock.today();
    return PACKS.map((p) => ({ ...p.info, stale: isStale(p, p.info.year, today) }));
  },

  tax_estimate: (req, ctx) => {
    if (!req || !Array.isArray(req.incomes)) ctx.fail('INVALID', 'Add at least one income', { field: 'incomes' });
    if (!packFor(req.packId)) ctx.fail('NOT_FOUND', `Unknown tax pack ${req.packId}`, { field: 'packId' });
    const today = ctx.clock.today();
    const est = estimate(req, today);
    const unsure = (req.custom as { unsure?: boolean } | undefined)?.unsure;
    if (unsure) {
      const lo = estimate(req, today, 0.9);
      const hi = estimate(req, today, 1.1);
      est.range = { low: lo.balance, high: hi.balance };
    }
    return est;
  },

  tax_quarterly_plan: (req, ctx) => {
    const p = packFor(req.packId) ?? US_2026;
    const today = ctx.clock.today();
    const year = req.year || p.info.year;
    const shift = (d: string) => d.replace(/^\d{4}/, (y) => String(Number(y) + (year - p.info.year)));
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
