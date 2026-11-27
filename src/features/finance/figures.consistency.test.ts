/**
 * Cross-screen figure consistency (demo seed): every headline figure has ONE definition, computed in one place,
 * and every screen that shows it reads that one value. Regression tests for the audit that found the net-worth
 * hero, the Accounts tiles, the Home ring and the clock disagreeing.
 */
import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/helpers';
import { createClock, installDateShim } from '@/backend/mock/clock';
import { netWorthAt, openingAsCounted, type Account, type Ledger } from '@/backend/mock/commands/finance';
import { openingAsCounted as uiOpening } from './MoneyHQ/ledger';
import { createDatabase, createRow } from '@/backend/mock/commands/db';
import type { MockCtx } from '@/backend/mock/ctx';
import type { BudgetLine } from '@/backend/types';
import { spendingBudget } from './shared/figures';

const num = (m: { amount: string } | undefined) => Number(m?.amount ?? 0);

describe('one definition per headline figure', () => {
  it('net worth: overview = assets − liabilities = last series point; investments = Portfolio total value', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const pfInst = backend.ctx.seedRefs.get('finance.instance.portfolio')!;
    const ov = await api.finance.overview({ instanceId: inst, month: '2026-11' });
    expect(num(ov.netWorth)).toBeCloseTo(num(ov.assets) - num(ov.liabilities), 2);
    for (const range of ['6m', '1y', '3y', '5y'] as const) {
      const s = await api.finance.networthSeries({ instanceId: inst, range });
      // The hero reads the last point; the Accounts tiles and Home read the overview — they must be equal.
      expect(s.net.at(-1)).toBeCloseTo(num(ov.netWorth), 2);
      expect(s.assets.at(-1)).toBeCloseTo(num(ov.assets), 2);
      expect(s.liabilities.at(-1)).toBeCloseTo(num(ov.liabilities), 2);
    }
    const pf = await api.portfolio.summary({ instanceId: pfInst });
    expect(ov.investments).toBeDefined();
    expect(num(ov.investments)).toBeCloseTo(num(pf.totalValue), 2);
    // Emergency-fund months are exactly balance / essentials.
    expect(ov.efMonths).toBeCloseTo(num(ov.efBalance) / num(ov.essentialMonthly), 6);
  });

  it('net worth: sign decides the side, closed and foreign accounts are excluded, Portfolio replaces investments once', () => {
    const acct = (id: string, type: string, opening: number, extra: Partial<Account> = {}): Account =>
      ({ id, name: id, type, currency: 'USD', opening, closed: false, onBudget: true, minPayment: 0, ...extra }) as Account;
    const accounts = [
      acct('chk', 'checking', -50_00), // overdrawn → liability
      acct('sav', 'savings', 400_00),
      acct('card', 'credit_card', 25_00), // overpaid card → asset
      acct('loan', 'auto_loan', -1000_00),
      acct('brk', 'investment', 300_00),
      acct('brk2', 'investment', 700_00),
      acct('eur', 'savings', 100_00, { currency: 'EUR' }),
      acct('old', 'savings', 999_00, { closed: true }),
    ];
    const txns = [
      { id: 't1', accountId: 'sav', date: '2026-02-01', amount: 500_00 },
      { id: 't2', accountId: 'sav', date: '2026-04-01', amount: -9999_00 }, // future-dated
    ];
    const l = { accounts, txns, acctById: new Map(accounts.map((a) => [a.id, a])) } as unknown as Ledger;
    const ctxWith = (value: number | null) => ({ services: { get: () => (value === null ? undefined : () => value) } }) as unknown as MockCtx;
    const p = netWorthAt(ctxWith(null), l, '2026-03-01');
    expect(p).toEqual({ assets: 900_00 + 25_00 + 300_00 + 700_00, liabilities: 50_00 + 1000_00, investments: null });
    const q = netWorthAt(ctxWith(2000_00), l, '2026-03-01');
    expect(q).toEqual({ assets: 900_00 + 25_00 + 2000_00, liabilities: 1050_00, investments: 2000_00 });
  });

  it('liability openings are amounts owed, either sign (Rust opening_as_counted) — in the mock and the UI ledger', () => {
    for (const f of [openingAsCounted, uiOpening]) {
      expect(f('credit_card', 1800)).toBe(-1800);
      expect(f('student_loan', -950)).toBe(-950);
      expect(f('checking', -50)).toBe(-50);
      expect(f('savings', 400)).toBe(400);
    }
  });

  it('spent vs budget: Home and the Overview envelopes share one definition (savings & debt excluded)', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const ov = await api.finance.overview({ instanceId: inst, month: '2026-11' });
    const b = spendingBudget(ov.budget);
    const spendLines = ov.budget.filter((x) => !/saving/i.test(x.group));
    expect(b.assigned).toBeCloseTo(spendLines.reduce((s, x) => s + num(x.assigned), 0), 2);
    expect(b.spent).toBeCloseTo(-spendLines.reduce((s, x) => s + num(x.activity), 0), 2);
    expect(b.remaining).toBeCloseTo(Math.max(0, b.assigned - b.spent), 2);
    // Savings transfers and debt payments never count as spending.
    const line = (group: string, assigned: string, activity: string): BudgetLine => ({ categoryId: group, name: group, group, color: 'gray', assigned: { amount: assigned, currency: 'USD' }, activity: { amount: activity, currency: 'USD' }, available: { amount: '0', currency: 'USD' }, pace: 0.5 });
    expect(spendingBudget([line('Bills', '100', '-40'), line('Savings & Debt', '500', '-500'), line('Income', '0', '3000')])).toEqual({ assigned: 100, spent: 40, remaining: 60, ratio: 0.4 });
  });

  it('life-app metrics (KPI tiles, insights, Show math) are the overview figures, never a second formula', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const ov = await api.finance.overview({ instanceId: inst, month: '2026-11' });
    const m = await api.lifeapp.metrics({ instanceId: inst, names: [] });
    expect(m.net_worth.value).toBeCloseTo(num(ov.netWorth), 2);
    expect(m.net_worth.math.map((l) => l.label)).toEqual(['Assets', 'Liabilities', 'of which Portfolio']);
    expect(m.net_worth_delta_30d.value).toBeCloseTo(num(ov.netWorthDelta30d), 2);
    expect(m.savings_rate_3m.value).toBeCloseTo(ov.savingsRate3m, 9);
    expect(m.essential_monthly_spend.value).toBeCloseTo(num(ov.essentialMonthly), 2);
    expect(m.ef_balance.value).toBeCloseTo(num(ov.efBalance), 2);
    expect(m.ef_months.value).toBeCloseTo(ov.efMonths, 9);
    // "Show math" reproduces the result: balance ÷ essentials = months.
    expect(m.ef_months.math.map((l) => l.value)).toEqual([m.ef_balance.display, m.essential_monthly_spend.display]);
    expect(m.debt_free_date.value).toBe(ov.debtFreeDate ?? null);
    // Zero-based demo budget: To be assigned is the figure; Left to spend has none (no fallback formula).
    expect(m.to_be_assigned.value).toBeCloseTo(num(ov.toBeAssigned), 2);
    expect(ov.leftToSpend).toBeUndefined();
    expect(m.left_to_spend.value).toBeNull();
    expect(m.budget_headline.value).toBeCloseTo(num(ov.toBeAssigned), 2);
    const b = spendingBudget(ov.budget);
    expect(m.month_spend.value).toBeCloseTo(b.spent, 2);
    expect(m.month_budget.value).toBeCloseTo(b.assigned, 2);
    // Insights quote the same values (Rust advisor format: one line per metric).
    const ins = await api.lifeapp.insights({ instanceId: inst });
    const ef = ins.find((i) => i.ruleId === 'ef-below-target');
    if (ef) expect(ef.math).toEqual([expect.objectContaining({ label: 'ef months', value: m.ef_months.display }), expect.objectContaining({ label: 'essential monthly spend', value: m.essential_monthly_spend.display })]);
  });

  it('debt-free date: minimum payments from next month, the Debt tab planner\'s "minimum" line', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const ov = await api.finance.overview({ instanceId: inst, month: '2026-11' });
    expect(ov.debtFreeDate).toMatch(/^\d{4}-\d{2}$/);
    const m = await api.lifeapp.metrics({ instanceId: inst, names: ['debt_free_date'] });
    expect(m.debt_free_date.value).toBe(ov.debtFreeDate);
    const plan = await api.finance.debtPlan({ debts: [{ name: 'a', balance: '1000', aprPct: '24', minPayment: '20' }], strategy: 'avalanche', extraMonthly: '0', startMonth: '2026-12' });
    // A minimum below the interest never clears the debt (Rust `debt::simulate`): no lender floor in the mock.
    expect(plan.strategies.find((x) => x.strategy === 'minimum')!.months).toBeGreaterThanOrEqual(600);
  });

  it('net-worth series: Rust rules — monthly YYYY-MM points back to Portfolio history, manual snapshots override past months', async () => {
    const { api, backend } = await mockApi();
    const inst = backend.ctx.seedRefs.get('finance.instance.moneyHq')!;
    const ov = await api.finance.overview({ instanceId: inst, month: '2026-11' });
    const all = await api.finance.networthSeries({ instanceId: inst, range: 'all' });
    expect(all.t.every((t) => /^\d{4}-\d{2}$/.test(t))).toBe(true);
    expect(all.t.at(-1)).toBe('2026-11');
    expect(all.t[0] < '2026-05').toBe(true); // Portfolio history predates the 6-month ledger
    expect(all.net.at(-1)).toBeCloseTo(num(ov.netWorth), 2);
    const six = await api.finance.networthSeries({ instanceId: inst, range: '6m' });
    expect(six.t).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    // A user-entered snapshot (Source: Manual) wins for its past month; Auto rows and the current month never do.
    const { db } = createDatabase(backend.ctx, {
      title: 'Net worth snapshots',
      parentId: null,
      appInstanceId: inst,
      properties: [
        { name: 'Month', type: 'title' },
        { name: 'Date', type: 'date', role: 'nw.date' },
        { name: 'Assets', type: 'money', role: 'nw.assets' },
        { name: 'Liabilities', type: 'money', role: 'nw.liabilities' },
        { name: 'Source', type: 'select', config: { options: [{ id: 'auto', name: 'Auto', color: 'gray' }, { id: 'man', name: 'Manual', color: 'blue' }] } },
      ],
    });
    const prop = (name: string) => backend.ctx.db.table<{ id: string; databaseId: string; name: string }>('db_properties').find((p) => p.databaseId === db.id && p.name === name)!.id;
    const row = (month: string, date: string, assets: string, source: string) =>
      createRow(backend.ctx, db.id, { values: { [db.primaryPropId]: { t: 'text', v: [{ text: month }] }, [prop('Date')]: { t: 'date', v: { start: date, time: false } }, [prop('Assets')]: { t: 'money', v: assets, cur: 'USD' }, [prop('Liabilities')]: { t: 'money', v: '0', cur: 'USD' }, [prop('Source')]: { t: 'select', v: source } } });
    row('Sep 2026', '2026-09-30', '1', 'man');
    row('2026-08', '2026-08-31', '2', 'auto');
    row('2026-11', '2026-11-30', '3', 'man');
    const s = await api.finance.networthSeries({ instanceId: inst, range: '6m' });
    const at = (m: string) => s.net[s.t.indexOf(m)];
    expect(at('2026-09')).toBe(1);
    expect(at('2026-08')).not.toBe(2);
    expect(at('2026-11')).toBeCloseTo(num(ov.netWorth), 2);
  });

  it('search snippets keep blocks apart ("net worth.Portfolio" never glued)', async () => {
    const { api } = await mockApi();
    const res = await api.search.query({ q: 'net worth', limit: 20, reqId: 1 });
    const hit = res.hits.find((h) => h.title === 'Apps in Ultranote');
    expect(hit?.snippet?.text).toBeTruthy();
    for (const h of res.hits) expect(h.snippet?.text ?? '').not.toMatch(/[a-z]\.[A-Z]/);
  });
});

describe('one "now" for the preview', () => {
  it('the UI clock starts at the frozen instant and ticks; the data clock stays frozen', () => {
    let real = 1_000_000;
    const c = createClock(Date.parse('2026-11-26T15:30:00Z'), () => real);
    expect(c.wallNow()).toBe(Date.parse('2026-11-26T15:30:00Z'));
    real += 90_000;
    expect(c.now()).toBe(Date.parse('2026-11-26T15:30:00Z'));
    expect(c.wallNow()).toBe(Date.parse('2026-11-26T15:31:30Z'));
    c.set(Date.parse('2026-11-27T09:00:00Z'));
    expect(c.wallNow()).toBe(Date.parse('2026-11-27T09:00:00Z'));
    const live = createClock(null, () => real);
    live.advance(60_000);
    expect(live.wallNow()).toBe(live.now());
  });

  it('the Date shim routes Date.now(), new Date() and Date() through the mock clock', () => {
    const at = Date.parse('2026-11-26T15:30:00Z');
    const undo = installDateShim(() => at);
    try {
      expect(Date.now()).toBe(at);
      expect(new Date().getTime()).toBe(at);
      expect(new Date(0).getTime()).toBe(0);
      expect(new Date() instanceof Date).toBe(true);
      expect(typeof Date()).toBe('string');
      expect(Date.parse('2026-01-01T00:00:00Z')).toBe(1767225600000);
    } finally {
      undo();
    }
    expect(Math.abs(Date.now() - at)).toBeGreaterThan(0);
  });
});
