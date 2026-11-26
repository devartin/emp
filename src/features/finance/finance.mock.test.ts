import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/helpers';
import type { FileGrant } from '@/backend/types';

describe('finance mock backend (demo seed)', () => {
  it('serves a coherent Money HQ overview, budget, net worth and Sankey', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    expect(inst).toBeTruthy();
    const ov = await api.finance.overview({ instanceId: inst, month: '2026-11' });
    expect(Number(ov.netWorth.amount)).toBeGreaterThan(50_000);
    expect(ov.budget.length).toBeGreaterThan(15);
    expect(ov.uncategorized).toBeGreaterThan(5);
    expect(ov.savingsRate3m).toBeGreaterThan(0);
    expect(ov.savingsRate3m).toBeLessThan(0.6);
    expect(ov.efMonths).toBeGreaterThan(1);
    expect(ov.debtFreeDate).toMatch(/^\d{4}-\d{2}$/);

    const bm = await api.finance.budgetMonth({ instanceId: inst, month: '2026-11' });
    // Budget identity: available = rollover + assigned + activity
    for (const c of bm.categories) {
      expect(Math.abs(Number(c.available) - (Number(c.rollover) + Number(c.assigned) + Number(c.activity)))).toBeLessThan(0.005);
    }
    const before = Number(bm.toBeAssigned);
    const target = bm.categories[0];
    const res = await api.finance.budgetAssign({ instanceId: inst, month: '2026-11', categoryId: target.categoryId, amount: String(Number(target.assigned) + 25) });
    expect(Number(res.toBeAssigned)).toBeCloseTo(before - 25, 2);

    const nw = await api.finance.networthSeries({ instanceId: inst, range: '1y' });
    expect(nw.t.length).toBe(12); // one point per month, like Rust `networth_series`
    nw.net.forEach((v, i) => expect(v).toBeCloseTo(nw.assets[i] - nw.liabilities[i], 1));

    const sk = await api.finance.cashflowSankey({ instanceId: inst, month: '2026-10' });
    expect(sk.nodes.length).toBeGreaterThan(6);
    expect(sk.links.every((l) => l.value > 0)).toBe(true);

    const br = await api.finance.spendingBreakdown({ instanceId: inst, from: '2026-10-01', to: '2026-10-31', by: 'category' });
    expect(br[0].pct).toBeGreaterThan(0.2);
    expect(br.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(1, 4);
  });

  it('detects recurring payments, plans debt, forecasts and handles rules', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const rec = await api.finance.recurringDetect({ instanceId: inst });
    expect(rec.length).toBeGreaterThan(0);
    const plan = await api.finance.debtPlan({
      debts: [
        { name: 'Card', balance: '4200', aprPct: '22.9', minPayment: '90' },
        { name: 'Car', balance: '9800', aprPct: '6.9', minPayment: '310' },
        { name: 'Student', balance: '15000', aprPct: '5.4', minPayment: '180' },
      ],
      strategy: 'avalanche',
      extraMonthly: '300',
      startMonth: '2026-12',
    });
    const av = plan.strategies.find((s) => s.strategy === 'avalanche')!;
    const sb = plan.strategies.find((s) => s.strategy === 'snowball')!;
    expect(Number(av.totalInterest)).toBeLessThanOrEqual(Number(sb.totalInterest));
    expect(plan.schedule.length).toBe(av.months);
    const fc = await api.finance.forecast({ instanceId: inst, horizonDays: 90, band: true });
    expect(fc.t.length).toBe(90);
    expect(fc.p10!.length).toBe(90);
    expect(fc.p10![89]).toBeLessThanOrEqual(fc.p90![89]);
    const rules = await api.finance.rulesList({ instanceId: inst });
    expect(rules.length).toBeGreaterThan(3);
    const job = await api.finance.rulesApply({ instanceId: inst, scope: 'uncategorized', dryRun: true });
    const out = await job.result;
    expect(out.changed).toBeGreaterThanOrEqual(0);
  });

  it('imports a CSV with dedupe and transfer detection', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const csv = ['Date,Description,Amount', '11/20/2026,"SQ *JUNIPER CAFE",-12.40', '11/21/2026,GREENLEAF MARKET #0231 OAKLAND CA,(84.10)', '11/22/2026,ACH DEPOSIT ACME STUDIO PAYROLL,3185.40'].join('\n');
    const grant: FileGrant = backend.ctx.grants.register(new File([csv], 'checking-nov.csv', { type: 'text/csv' }), 'import');
    const start = await api.finance.importStart({ instanceId: inst, grantId: grant.grantId });
    expect(start.format).toBe('csv');
    expect(start.mappingGuess.dateFormat).toBe('MM/DD/YYYY');
    const pv = await api.finance.importPreview({ importId: start.importId, mapping: start.mappingGuess, accountId: start.accountGuess! });
    expect(pv.rows.length).toBe(3);
    expect(pv.rows[1].amount).toBe('-84.10');
    expect(pv.rows[0].payee).toBe('Juniper Cafe');
    const job = await api.finance.importCommit({ importId: start.importId, mapping: start.mappingGuess, accountId: start.accountGuess!, skip: [], overrides: {} });
    const r = await job.result;
    expect(r.inserted + r.skipped).toBe(3);
  });

  it('values the portfolio, plans a rebalance and estimates tax', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.portfolio')!;
    const s = await api.portfolio.summary({ instanceId: inst });
    expect(s.holdings.length).toBe(8);
    expect(Number(s.totalValue.amount)).toBeGreaterThan(50_000);
    expect(s.holdings.reduce((a, h) => a + h.weight, 0)).toBeLessThanOrEqual(1.0001);
    expect(s.allocation.some((a) => a.status === 'outside_band')).toBe(true);
    expect(s.xirrAll).toBeDefined();
    const perf = await api.portfolio.performance({ instanceId: inst, range: '1y' });
    expect(perf.t.length).toBeGreaterThan(100);
    const plan = await api.portfolio.rebalancePlan({ instanceId: inst, newCash: '5000', allowTaxableSells: false, minTrade: '50', fractional: true });
    expect(plan.trades.length).toBeGreaterThan(0);
    const real = await api.portfolio.realized({ instanceId: inst, year: 2026 });
    expect(real.lots.length).toBeGreaterThan(0);
    const div = await api.portfolio.dividends({ instanceId: inst, year: 2026 });
    expect(div.length).toBe(12);

    const est = await api.tax.estimate({
      packId: 'us-federal-2026',
      year: 2026,
      filingStatus: 'single',
      dependents: 0,
      incomes: [
        { kind: 'wages', amount: '112400' },
        { kind: 'self_employment', amount: '11850' },
      ],
      adjustments: [],
      deductions: 'auto',
      credits: [],
      withheld: '15890',
      estimatedPaid: '2700',
    });
    expect(Number(est.totalTax)).toBeGreaterThan(10_000);
    // "Show math" lines sum to the total
    const taxLines = est.lines.slice(0, est.lines.findIndex((l) => l.label === 'Estimated total tax'));
    expect(taxLines.reduce((a, l) => a + Number(l.value), 0)).toBeCloseTo(Number(est.totalTax), 2);
    expect(est.disclaimer).toContain('Not tax advice');
    const q = await api.tax.quarterlyPlan({ packId: 'us-federal-2026', year: 2026, method: 'safe_harbor', estimate: est, priorYearTax: '16420', priorYearAgi: '118300', paid: [{ date: '2026-04-11', amount: '900' }] });
    expect(q.due.length).toBe(4);
    const quotes = await api.market.quotes({ symbols: ['EMPX:XNAS', 'BTC:CRYPTO'] });
    expect(quotes.length).toBe(2);
    const bars = await api.market.bars({ symbol: 'EMPX:XNAS', interval: '1d', from: '2025-11-01', to: '2026-11-26', adjusted: true });
    expect(bars.c.length).toBeGreaterThan(200);
  });
});
