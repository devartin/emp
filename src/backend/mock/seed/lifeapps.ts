/**
 * Life-apps demo seed (§13.6 "demo: all 6 life apps installed with sample data"). Installs every v1 app through the
 * same code path as the wizard, with realistic answers, then backdates installs and ticks a few checklist items so
 * Getting-started lists look lived-in. Runs before the finance seed (150), which adopts these instances.
 * Refs: 'lifeapp.instance.<appId>', 'lifeapp.root.<appId>'.
 */
import type { MockCtx } from '../ctx';
import { installApp } from '../commands/lifeapp';
import { instancesTable } from '@/features/lifeapps/mock/env';

export const order = 60;

const DAY = 86_400_000;

const DEMO: { appId: string; answers: Record<string, unknown>; daysAgo: number; ticks?: string[] }[] = [
  {
    appId: 'money-hq',
    daysAgo: 190,
    ticks: ['categorize'],
    answers: {
      currency: { code: 'USD', numberFormat: 'en-US', monthStartDay: 1 },
      household: { mode: 'single', dependents: 0, splitPct: 50 },
      income: { items: [{ name: 'Northwind Labs salary', amount: 3425, frequency: 'semimonthly', net: true, nextPayDate: null }], stability: 'stable' },
      method: 'zero_based',
      accounts: [
        { name: 'Everyday Checking', type: 'checking', balance: 4250, onBudget: true },
        { name: 'High-yield Savings', type: 'savings', balance: 14800, onBudget: true },
        { name: 'Rewards Visa', type: 'credit_card', balance: 1287, apr: 0.2199, limit: 6000, minPayment: 35, onBudget: true },
      ],
      emergency: { current: 14800, months: 6, starter: 1000 },
      data: { source: 'sample' },
    },
  },
  {
    appId: 'portfolio',
    daysAgo: 160,
    answers: {
      experience: 'intermediate',
      accounts: [{ name: 'Brokerage', broker: 'Harbor Invest', currency: 'USD', type: 'taxable', taxTreatment: 'taxable' }, { name: 'Roth IRA', broker: 'Harbor Invest', currency: 'USD', type: 'roth_ira', taxTreatment: 'free' }],
      depth: 'history',
      targets: 'three_fund',
      rebalance: 'hybrid',
      risk: { horizon: 'long', drop: 'hold' },
    },
  },
  {
    appId: 'tax-organizer',
    daysAgo: 70,
    answers: {
      jurisdiction: { country: 'US', region: 'CA', year: 2026, residency: 'resident' },
      household: { status: 'single', dependents: 0, over65: 0 },
      income: ['employment', 'self_employment', 'interest', 'dividends', 'brokerage'],
      preparer: 'professional',
    },
  },
  { appId: 'spreadsheet-studio', daysAgo: 45, ticks: ['inputs'], answers: { intent: 'decision', structure: ['inputs', 'calculations', 'output', 'checks', 'changelog'], chart: 'bar' } },
  {
    appId: 'life-os',
    daysAgo: 120,
    ticks: ['capture5'],
    answers: { style: 'mix', areas: ['Work', 'Health', 'Home', 'Money', 'Learning', 'Fun', 'Relationships', 'Side project'], priority: 'p1p4' },
  },
  {
    appId: 'habits',
    daysAgo: 150,
    answers: {
      pick: ['read', 'walk', 'meditate', 'strength', 'water', 'nophone'],
      identity: 'takes care of their body and mind',
      grace: 'never_miss_twice',
      review: true,
    },
  },
];

export async function seed(ctx: MockCtx): Promise<void> {
  if (ctx.seedKind !== 'demo') return;
  let ws: string;
  try {
    ws = ctx.workspaceId();
  } catch {
    return;
  }
  for (const app of DEMO) {
    try {
      const res = await installApp(ctx, { appId: app.appId, answers: app.answers, mode: 'guided', disabledKeys: [], workspaceId: ws, sampleData: true });
      const installedAt = ctx.clock.now() - app.daysAgo * DAY;
      instancesTable(ctx).update(res.instanceId, (x) => {
        x.installedAt = installedAt;
        for (const t of app.ticks ?? []) x.checklist[t] = true;
        if (app.appId === 'life-os') x.lastReviewAt = ctx.clock.now() - 9 * DAY;
      });
      ctx.pages.table().update(res.rootPageId, (p) => {
        p.createdAt = installedAt;
      });
      ctx.seedRefs.set(`lifeapp.instance.${app.appId}`, res.instanceId);
      ctx.seedRefs.set(`lifeapp.root.${app.appId}`, res.rootPageId);
    } catch (err) {
      console.error(`[emp mock] demo install of ${app.appId} failed`, err);
    }
  }
  ctx.pages.emitTree(ws, Array.from(ctx.seedRefs.entries()).filter(([k]) => k.startsWith('lifeapp.root.')).map(([, v]) => v));
}
