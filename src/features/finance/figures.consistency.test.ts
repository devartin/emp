/**
 * Cross-screen figure consistency (demo seed): every headline figure has ONE definition, computed in one place,
 * and every screen that shows it reads that one value. Regression tests for the audit that found the net-worth
 * hero, the Accounts tiles, the Home ring and the clock disagreeing.
 */
import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/helpers';
import { createClock, installDateShim } from '@/backend/mock/clock';
import { netWorthAt, type Account, type Ledger } from '@/backend/mock/commands/finance';
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

  it('search snippets keep blocks apart ("net worth.Portfolio" never glued)', async () => {
    const { api } = await mockApi();
    const res = await api.search.query({ q: 'net worth', limit: 20, reqId: 1 });
    const hit = res.hits.find((h) => h.title === 'Money & life apps');
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
