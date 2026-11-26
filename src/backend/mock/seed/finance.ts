/**
 * Finance seed (demo) and provisioning for the Money HQ, Portfolio and Tax Organizer life apps.
 *
 *   provisionMoneyHq(ctx, { instanceId, parentId, sample })   — Accounts, Categories, Transactions, Recurring, Goals
 *   provisionPortfolio(ctx, { … })                            — Investment accounts, Securities, Investment
 *                                                               transactions, Target allocation (+ watchlist)
 *   provisionTax(ctx, { … })                                  — Document checklist, Deductions & credits, Estimated payments
 *
 * Every database carries semantic roles (§15.0) so the engines in commands/{finance,portfolio,tax}.ts read rows by
 * role, never by name. The services `finance.provision`, `portfolio.provision` and `tax.provision` let the life-apps
 * mock reuse this when it installs an app. The demo seed adopts installed instances when the life-apps mock has
 * created them; otherwise it creates the three hubs itself (and a fallback `lifeapp.instances` service).
 *
 * Sample data: six months of realistic transactions (two pay cycles a month, bills, groceries, dining, a trip,
 * transfers between own accounts, a subscription price rise, a dozen uncategorised rows), eight holdings bought
 * over three years with dividends and a couple of sales, a watchlist, and a tax year in progress.
 */
import type { BlockColor, CellValue, Icon, Id, LifeAppInstance, WatchlistSymbol } from '../../types';
import { createDatabase, createProperty, createRow, type DbRecord, type NewProp, type PropRecord, type RowRecord } from '../commands/db';
import { kvWrite } from '../commands/kv';
import type { KnownServices, MockCtx } from '../ctx';
import { closeOn, instrument } from '../market';
import { createRng, type Rng } from '../rng';
import { TAX_DEDUCTION_CATEGORIES, type TaxDeductionCategory } from '../../taxDeductions';

const TAX_CATEGORY_COLORS: Record<TaxDeductionCategory['key'], BlockColor> = {
  charity: 'pink',
  medical: 'red',
  salt: 'blue',
  mortgage: 'brown',
  home_office: 'purple',
  business: 'orange',
  education: 'green',
  childcare: 'yellow',
  hsa: 'yellow',
  ira: 'gray',
  other: 'gray',
};

export const order = 150;

const DAY = 86_400_000;

// ───────────────────────────────────────────────────────────────────────────── records

export interface FinSet {
  id: Id;
  instanceId: Id | null;
  rootPageId: Id | null;
  dbs: { accounts: Id; categories: Id; txns: Id; recurring: Id; goals: Id };
  baseCurrency: string;
  method: 'zero_based' | 'fifty_thirty_twenty' | 'pay_yourself_first' | 'envelopes' | 'track_only';
  monthStartDay: number;
  createdAt: number;
}

export interface PfSet {
  id: Id;
  instanceId: Id | null;
  rootPageId: Id | null;
  dbs: { accounts: Id; securities: Id; txns: Id; targets: Id };
  benchmark: string;
  createdAt: number;
}

export interface TaxSet {
  id: Id;
  instanceId: Id | null;
  rootPageId: Id | null;
  dbs: { documents: Id; deductions: Id; payments: Id };
  year: number;
  createdAt: number;
}

export interface BudgetRec {
  id: string;
  setId: Id;
  month: string;
  categoryId: Id;
  /** cents */
  assigned: number;
}

export interface SnapshotRec {
  id: string;
  setId: Id;
  month: string;
  assets: number;
  liabilities: number;
  source: 'backfill' | 'snapshot';
}

export const finSets = (ctx: MockCtx) => ctx.db.table<FinSet>('fin_sets');
export const pfSets = (ctx: MockCtx) => ctx.db.table<PfSet>('pf_sets');
export const taxSets = (ctx: MockCtx) => ctx.db.table<TaxSet>('tax_sets');
export const budgets = (ctx: MockCtx) => ctx.db.table<BudgetRec>('fin_budget');
export const snapshots = (ctx: MockCtx) => ctx.db.table<SnapshotRec>('fin_snapshots');

// ───────────────────────────────────────────────────────────────────────────── cell helpers

export const V = {
  text: (s: string): CellValue => ({ t: 'text', v: s ? [{ text: s }] : [] }),
  num: (n: number | null): CellValue => ({ t: 'number', v: n }),
  money: (cents: number, cur = 'USD'): CellValue => ({ t: 'money', v: centsToStr(cents), cur }),
  sel: (id: string): CellValue => ({ t: 'select', v: id }),
  status: (id: string): CellValue => ({ t: 'status', v: id }),
  multi: (...ids: string[]): CellValue => ({ t: 'multi', v: ids }),
  date: (start: string): CellValue => ({ t: 'date', v: { start, time: false } }),
  check: (v: boolean): CellValue => ({ t: 'check', v }),
  rel: (ids: Id[]): CellValue => ({ t: 'relation', v: ids }),
  ticker: (v: string): CellValue => ({ t: 'ticker', v }),
  rec: (rrule: string, dtstart: string): CellValue => ({ t: 'recurrence', v: { rrule, dtstart, mode: 'schedule' } }),
};

export function centsToStr(c: number): string {
  const neg = c < 0;
  const a = Math.abs(Math.round(c));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function strToCents(s: string | number | null | undefined): number {
  if (s === null || s === undefined || s === '') return 0;
  const n = typeof s === 'number' ? s : Number(String(s).replace(/[−]/g, '-'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const lucide = (v: string, color?: BlockColor): Icon => (color ? { t: 'lucide', v, color } : { t: 'lucide', v });

function iso(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d.getTime());
}
function monthStart(day: string, offsetMonths = 0): string {
  const d = new Date(`${day.slice(0, 7)}-01T12:00:00`);
  d.setMonth(d.getMonth() + offsetMonths);
  return iso(d.getTime());
}
function dayOfWeek(day: string): number {
  return new Date(`${day}T12:00:00`).getDay();
}
function withDay(month: string, dom: number): string {
  const d = new Date(`${month.slice(0, 7)}-01T12:00:00`);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dom, last));
  return iso(d.getTime());
}

// ───────────────────────────────────────────────────────────────────────────── Money HQ schema

export const ACCOUNT_TYPES: [string, string, string][] = [
  ['checking', 'Checking', 'blue'],
  ['savings', 'Savings', 'green'],
  ['credit_card', 'Credit card', 'orange'],
  ['student_loan', 'Student loan', 'purple'],
  ['auto_loan', 'Auto loan', 'brown'],
  ['mortgage', 'Mortgage', 'red'],
  ['personal_loan', 'Personal loan', 'pink'],
  ['investment', 'Investment', 'blue'],
  ['cash', 'Cash', 'gray'],
  ['other_asset', 'Other asset', 'gray'],
  ['other_liability', 'Other liability', 'gray'],
];
export const DEBT_TYPES = new Set(['credit_card', 'student_loan', 'auto_loan', 'mortgage', 'personal_loan', 'other_liability']);

export const CATEGORY_GROUPS = ['Income', 'Bills', 'Everyday', 'Fun', 'Savings & Debt'] as const;
const BLOCK_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

interface CatDef {
  name: string;
  group: (typeof CATEGORY_GROUPS)[number];
  color: string;
  target: number;
  essential?: boolean;
  rollover?: boolean;
  icon: string;
}

/** Default taxonomy (BRAINSTORM §5.3, zero-based groups). Targets in dollars per month. */
const CATEGORIES: CatDef[] = [
  { name: 'Paycheck', group: 'Income', color: 'green', target: 0, icon: 'briefcase' },
  { name: 'Side income', group: 'Income', color: 'green', target: 0, icon: 'sparkles' },
  { name: 'Interest earned', group: 'Income', color: 'green', target: 0, icon: 'percent' },
  { name: 'Rent', group: 'Bills', color: 'blue', target: 2150, essential: true, icon: 'home' },
  { name: 'Utilities', group: 'Bills', color: 'blue', target: 160, essential: true, icon: 'zap' },
  { name: 'Phone & internet', group: 'Bills', color: 'blue', target: 135, essential: true, icon: 'wifi' },
  { name: 'Insurance', group: 'Bills', color: 'blue', target: 185, essential: true, icon: 'shield' },
  { name: 'Subscriptions', group: 'Bills', color: 'purple', target: 85, icon: 'repeat' },
  { name: 'Transit', group: 'Bills', color: 'blue', target: 100, essential: true, icon: 'train-front' },
  { name: 'Groceries', group: 'Everyday', color: 'green', target: 680, essential: true, icon: 'shopping-basket' },
  { name: 'Dining out', group: 'Everyday', color: 'orange', target: 320, icon: 'utensils' },
  { name: 'Fuel', group: 'Everyday', color: 'yellow', target: 150, essential: true, icon: 'fuel' },
  { name: 'Household', group: 'Everyday', color: 'brown', target: 110, icon: 'sofa' },
  { name: 'Health', group: 'Everyday', color: 'red', target: 90, essential: true, icon: 'heart-pulse' },
  { name: 'Personal care', group: 'Everyday', color: 'pink', target: 60, icon: 'sparkle' },
  { name: 'Entertainment', group: 'Fun', color: 'purple', target: 90, icon: 'clapperboard' },
  { name: 'Shopping', group: 'Fun', color: 'pink', target: 200, icon: 'shopping-bag' },
  { name: 'Travel', group: 'Fun', color: 'blue', target: 250, rollover: true, icon: 'plane' },
  { name: 'Gifts', group: 'Fun', color: 'red', target: 75, rollover: true, icon: 'gift' },
  { name: 'Hobbies', group: 'Fun', color: 'orange', target: 60, icon: 'palette' },
  { name: 'Emergency fund', group: 'Savings & Debt', color: 'green', target: 400, rollover: true, icon: 'life-buoy' },
  { name: 'Vacation fund', group: 'Savings & Debt', color: 'blue', target: 250, rollover: true, icon: 'palmtree' },
  { name: 'Car replacement', group: 'Savings & Debt', color: 'gray', target: 150, rollover: true, icon: 'car' },
  { name: 'Annual insurance', group: 'Savings & Debt', color: 'yellow', target: 60, rollover: true, icon: 'umbrella' },
  { name: 'Investing', group: 'Savings & Debt', color: 'purple', target: 500, icon: 'trending-up' },
  { name: 'Debt payments', group: 'Savings & Debt', color: 'red', target: 555, icon: 'landmark' },
];

function moneyHqSchemas(accountsDb?: Id, categoriesDb?: Id) {
  const accounts: NewProp[] = [
    { name: 'Name', type: 'title' },
    { name: 'Type', type: 'select', role: 'acct.type', config: { options: ACCOUNT_TYPES.map(([id, name, color]) => ({ id, name, color })) } },
    { name: 'Institution', type: 'text' },
    { name: 'Currency', type: 'text', role: 'acct.currency' },
    { name: 'Opening balance', type: 'money', role: 'acct.opening', config: { currency: 'USD' } },
    { name: 'APR', type: 'number', role: 'acct.apr', config: { format: 'number', decimals: 2, suffix: '%' } },
    { name: 'Min payment', type: 'money', role: 'acct.min_payment', config: { currency: 'USD' } },
    { name: 'Credit limit', type: 'money', role: 'acct.limit', config: { currency: 'USD' } },
    { name: 'On budget', type: 'checkbox', role: 'acct.on_budget' },
    { name: 'Low-balance threshold', type: 'money', role: 'acct.low_threshold', config: { currency: 'USD' } },
    { name: 'Last reconciled', type: 'date', role: 'acct.reconciled' },
    { name: 'Closed', type: 'checkbox', role: 'acct.closed' },
  ];
  const categories: NewProp[] = [
    { name: 'Name', type: 'title' },
    { name: 'Group', type: 'select', role: 'cat.group', config: { options: CATEGORY_GROUPS.map((g, i) => ({ id: slugify(g), name: g, color: ['green', 'blue', 'orange', 'pink', 'purple'][i] })) } },
    { name: 'Essential', type: 'checkbox', role: 'cat.essential' },
    { name: 'Rollover', type: 'checkbox', role: 'cat.rollover' },
    { name: 'Color', type: 'select', role: 'cat.color', config: { options: BLOCK_COLORS.map((c) => ({ id: c, name: c[0].toUpperCase() + c.slice(1), color: c })) } },
    { name: 'Icon', type: 'text', role: 'cat.icon' },
    { name: 'Target type', type: 'select', role: 'cat.target_type', config: { options: [{ id: 'monthly', name: 'Monthly', color: 'blue' }, { id: 'by_date', name: 'By date', color: 'purple' }, { id: 'none', name: 'None', color: 'gray' }] } },
    { name: 'Target', type: 'money', role: 'cat.target', config: { currency: 'USD' } },
  ];
  return { accounts, categories, accountsDb, categoriesDb };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export interface ProvisionOpts {
  instanceId: Id | null;
  parentId: Id | null;
  sample: boolean;
  workspaceId?: Id;
}

export function provisionMoneyHq(ctx: MockCtx, o: ProvisionOpts): FinSet {
  const existing = o.instanceId ? finSets(ctx).find((s) => s.instanceId === o.instanceId) : undefined;
  if (existing) return existing;
  const now = ctx.clock.now();
  const ws = o.workspaceId ?? ctx.workspaceId();
  const common = { workspaceId: ws, parentId: o.parentId, appInstanceId: o.instanceId ?? undefined, createdAt: now - 190 * DAY, silent: true };
  const s = moneyHqSchemas();
  const acc = createDatabase(ctx, { ...common, title: 'Accounts', icon: lucide('landmark', 'green'), description: 'Every account you own or owe — balances are computed from transactions.', properties: s.accounts, views: [{ name: 'All accounts', layout: 'table' }, { name: 'By type', layout: 'board' }] });
  const cat = createDatabase(ctx, { ...common, title: 'Categories', icon: lucide('shapes', 'green'), description: 'Budget categories, grouped. Targets drive the suggested assignment each month.', properties: s.categories, views: [{ name: 'All categories', layout: 'table' }, { name: 'By group', layout: 'board' }] });
  const txProps: NewProp[] = [
    { name: 'Payee', type: 'title', role: 'txn.payee' },
    { name: 'Date', type: 'date', role: 'txn.date' },
    { name: 'Amount', type: 'money', role: 'txn.amount', config: { currency: 'USD' } },
    { name: 'Account', type: 'relation', role: 'txn.account', config: { targetDatabaseId: acc.db.id, limit: 'one' } },
    { name: 'Category', type: 'relation', role: 'txn.category', config: { targetDatabaseId: cat.db.id, limit: 'one' } },
    { name: 'Raw description', type: 'text', role: 'txn.raw' },
    { name: 'Memo', type: 'text', role: 'txn.memo' },
    { name: 'Cleared', type: 'status', role: 'txn.cleared', config: { options: [{ id: 'uncleared', name: 'Uncleared', color: 'gray', group: 'todo' }, { id: 'cleared', name: 'Cleared', color: 'blue', group: 'in_progress' }, { id: 'reconciled', name: 'Reconciled', color: 'green', group: 'complete' }] } },
    { name: 'Tags', type: 'multi_select', role: 'txn.tags', config: { options: [{ id: 'tax', name: 'Tax', color: 'yellow' }, { id: 'reimbursable', name: 'Reimbursable', color: 'blue' }, { id: 'trip', name: 'Trip', color: 'purple' }, { id: 'work', name: 'Work', color: 'gray' }] } },
    { name: 'Source', type: 'select', role: 'txn.source', config: { options: [{ id: 'manual', name: 'Manual', color: 'gray' }, { id: 'import', name: 'Import', color: 'blue' }, { id: 'rule', name: 'Rule', color: 'purple' }] } },
    { name: 'Import ID', type: 'text', role: 'txn.import_id', hidden: true },
    // §16 role table: `txn.reviewed` (PROGRAMME-v3 K5). Imports write false; the review lane ticks it.
    { name: 'Reviewed', type: 'checkbox', role: 'txn.reviewed' },
  ];
  const tx = createDatabase(ctx, { ...common, title: 'Transactions', icon: lucide('arrow-left-right', 'green'), description: 'Signed amounts: money in is positive, money out is negative.', properties: txProps, views: [{ name: 'All transactions', layout: 'table' }, { name: 'Spending by month', layout: 'chart' }] });
  // Self relations need the database to exist first.
  const self = (name: string, role: string) => ({ name, type: 'relation' as const, role, hidden: true, config: { targetDatabaseId: tx.db.id, limit: 'one' } });
  const addProp = (np: NewProp) => {
    const rec = createProperty(ctx, tx.db.id, np, undefined, { silent: true });
    ctx.db.table<DbRecord>('db_databases').update(tx.db.id, (d) => void (d.roles[np.role!] = rec.id));
  };
  addProp(self('Transfer', 'txn.transfer'));
  addProp(self('Split parent', 'txn.split_parent'));

  const rec = createDatabase(ctx, {
    ...common,
    title: 'Recurring',
    icon: lucide('calendar-clock', 'green'),
    description: 'Bills, subscriptions and income on a schedule. Upcoming items appear on the Money HQ dashboard.',
    properties: [
      { name: 'Name', type: 'title' },
      { name: 'Amount', type: 'money', role: 'rec.amount', config: { currency: 'USD' } },
      { name: 'Schedule', type: 'recurrence', role: 'rec.schedule' },
      { name: 'Account', type: 'relation', role: 'rec.account', config: { targetDatabaseId: acc.db.id, limit: 'one' } },
      { name: 'Category', type: 'relation', role: 'rec.category', config: { targetDatabaseId: cat.db.id, limit: 'one' } },
      { name: 'Kind', type: 'select', role: 'rec.kind', config: { options: [{ id: 'bill', name: 'Bill', color: 'blue' }, { id: 'subscription', name: 'Subscription', color: 'purple' }, { id: 'income', name: 'Income', color: 'green' }] } },
      { name: 'Autopay', type: 'checkbox', role: 'rec.autopay' },
      { name: 'Reminder days', type: 'number', role: 'rec.reminder_days' },
      { name: 'Variable', type: 'checkbox', role: 'rec.variable' },
      { name: 'Previous amount', type: 'money', role: 'rec.prev_amount', config: { currency: 'USD' } },
      { name: 'Cancel URL', type: 'url', role: 'rec.cancel_url' },
    ],
    views: [{ name: 'All recurring', layout: 'table' }, { name: 'Calendar', layout: 'calendar' }],
  });
  const goals = createDatabase(ctx, {
    ...common,
    title: 'Goals',
    icon: lucide('target', 'green'),
    description: 'Emergency fund, sinking funds and savings goals with the monthly amount each needs.',
    properties: [
      { name: 'Name', type: 'title' },
      { name: 'Kind', type: 'select', role: 'goal.kind', config: { options: [{ id: 'emergency', name: 'Emergency', color: 'green' }, { id: 'sinking', name: 'Sinking fund', color: 'blue' }, { id: 'savings', name: 'Savings', color: 'purple' }] } },
      { name: 'Target', type: 'money', role: 'goal.target', config: { currency: 'USD' } },
      { name: 'Target date', type: 'date', role: 'goal.date' },
      { name: 'Saved', type: 'money', role: 'goal.saved', config: { currency: 'USD' } },
      { name: 'Linked account', type: 'relation', role: 'goal.account', config: { targetDatabaseId: acc.db.id, limit: 'one' } },
      { name: 'Priority', type: 'select', role: 'goal.priority', config: { options: [{ id: 'high', name: 'High', color: 'red' }, { id: 'medium', name: 'Medium', color: 'yellow' }, { id: 'low', name: 'Low', color: 'gray' }] } },
      { name: 'Icon', type: 'text', role: 'goal.icon' },
    ],
    views: [{ name: 'All goals', layout: 'table' }, { name: 'Gallery', layout: 'gallery' }],
  });

  const set: FinSet = {
    id: ctx.id(),
    instanceId: o.instanceId,
    rootPageId: o.parentId,
    dbs: { accounts: acc.db.id, categories: cat.db.id, txns: tx.db.id, recurring: rec.db.id, goals: goals.db.id },
    baseCurrency: 'USD',
    method: 'zero_based',
    monthStartDay: 1,
    createdAt: now,
  };
  finSets(ctx).insert(set);
  seedCategories(ctx, set);
  if (o.sample) seedMoneySample(ctx, set);
  return set;
}

function roleIds(ctx: MockCtx, dbId: Id): Record<string, Id> {
  return ctx.db.table<DbRecord>('db_databases').require(dbId).roles;
}

function seedCategories(ctx: MockCtx, set: FinSet): Map<string, Id> {
  const R = roleIds(ctx, set.dbs.categories);
  const primary = ctx.db.table<DbRecord>('db_databases').require(set.dbs.categories).primaryPropId;
  const ids = new Map<string, Id>();
  for (const c of CATEGORIES) {
    const r = createRow(ctx, set.dbs.categories, {
      silent: true,
      values: {
        [primary]: V.text(c.name),
        [R['cat.group']]: V.sel(slugify(c.group)),
        [R['cat.essential']]: V.check(!!c.essential),
        [R['cat.rollover']]: V.check(!!c.rollover),
        [R['cat.color']]: V.sel(c.color),
        [R['cat.icon']]: V.text(c.icon),
        [R['cat.target_type']]: V.sel(c.target > 0 ? 'monthly' : 'none'),
        [R['cat.target']]: V.money(c.target * 100),
      },
    });
    ids.set(c.name, r.id);
  }
  return ids;
}

// ───────────────────────────────────────────────────────────────────────────── Money HQ sample data

interface AcctDef {
  key: string;
  name: string;
  type: string;
  institution: string;
  opening: number;
  apr?: number;
  min?: number;
  limit?: number;
  onBudget: boolean;
  low?: number;
}

const ACCOUNTS: AcctDef[] = [
  { key: 'checking', name: 'Everyday Checking', type: 'checking', institution: 'Northbank', opening: 3_850_00, onBudget: true, low: 500_00 },
  { key: 'savings', name: 'High-Yield Savings', type: 'savings', institution: 'Northbank', opening: 12_400_00, onBudget: true, low: 0 },
  { key: 'card', name: 'Sapphire Rewards Card', type: 'credit_card', institution: 'Meridian Card', opening: -1_184_32, apr: 22.99, min: 75_00, limit: 8_000_00, onBudget: true },
  { key: 'student', name: 'Student Loan', type: 'student_loan', institution: 'Federal Direct', opening: -9_850_00, apr: 5.4, min: 210_00, onBudget: false },
  { key: 'auto', name: 'Auto Loan', type: 'auto_loan', institution: 'Harbor Credit Union', opening: -12_600_00, apr: 6.9, min: 345_00, onBudget: false },
  { key: 'brokerage', name: 'Brokerage', type: 'investment', institution: 'Harbor Brokerage', opening: 0, onBudget: false },
];

interface TxDraft {
  date: string;
  payee: string;
  raw: string;
  amount: number;
  account: string;
  category?: string;
  memo?: string;
  transferTo?: string;
  tags?: string[];
  splits?: { category: string; amount: number }[];
}

function money(rng: Rng, lo: number, hi: number): number {
  return Math.round((lo + rng.next() * (hi - lo)) * 100);
}

function generateTransactions(rng: Rng, start: string, end: string): TxDraft[] {
  const out: TxDraft[] = [];
  const add = (d: TxDraft) => {
    if (d.date >= start && d.date <= end) out.push(d);
  };
  // Paychecks: every other Friday, anchored to a fixed Friday.
  let pay = '2026-01-09';
  while (pay < start) pay = addDays(pay, 14);
  for (; pay <= end; pay = addDays(pay, 14)) {
    add({ date: pay, payee: 'Acme Studio', raw: 'ACH DEPOSIT ACME STUDIO PAYROLL PPD ID 9876543210', amount: 3_084_20, account: 'checking', category: 'Paycheck', memo: 'Net pay' });
  }
  // Monthly cadence
  for (let m = monthStart(start); m <= end; m = monthStart(m, 1)) {
    const mi = Number(m.slice(5, 7));
    add({ date: withDay(m, 1), payee: 'Parkside Residences', raw: 'ACH DEBIT PARKSIDE RESIDENCES RENT', amount: -2_150_00, account: 'checking', category: 'Rent' });
    add({ date: withDay(m, 2), payee: 'High-Yield Savings', raw: 'ONLINE TRANSFER TO SAV XXXX4471', amount: -600_00, account: 'checking', transferTo: 'savings', memo: 'Pay yourself first' });
    add({ date: withDay(m, 3), payee: 'Harbor Brokerage', raw: 'ACH DEBIT HARBOR BROKERAGE CONTRIB', amount: -500_00, account: 'checking', transferTo: 'brokerage', category: 'Investing', memo: 'Monthly investment' });
    add({ date: withDay(m, 5), payee: 'Harbor Credit Union', raw: 'ACH DEBIT HARBOR CU AUTO LOAN PMT', amount: -345_00, account: 'checking', transferTo: 'auto', category: 'Debt payments' });
    const util = money(rng, 118, 172) + (mi === 7 || mi === 8 ? 38_00 : mi === 12 || mi === 1 ? 26_00 : 0);
    add({ date: withDay(m, 8), payee: 'City Power & Light', raw: 'CITY POWER & LIGHT AUTOPAY 0412', amount: -util, account: 'checking', category: 'Utilities' });
    add({ date: withDay(m, 11), payee: 'Lumen Mobile', raw: 'LUMEN MOBILE AUTOPAY', amount: -65_00, account: 'card', category: 'Phone & internet' });
    add({ date: withDay(m, 12), payee: 'Fibrewave', raw: 'FIBREWAVE INTERNET 800-555-0199 CA', amount: -70_00, account: 'card', category: 'Phone & internet' });
    add({ date: withDay(m, 14), payee: 'Harbor Mutual', raw: 'HARBOR MUTUAL INS PREM', amount: -182_40, account: 'checking', category: 'Insurance' });
    add({ date: withDay(m, 15), payee: 'Federal Direct', raw: 'FED LOAN SERVICING STUDENT LN', amount: -210_00, account: 'checking', transferTo: 'student', category: 'Debt payments' });
    // Subscriptions — Streamflix raised its price two months ago.
    const lateMonths = m >= monthStart(end, -2);
    add({ date: withDay(m, 6), payee: 'Streamflix', raw: 'STREAMFLIX.COM 866-555-0110', amount: lateMonths ? -17_99 : -15_49, account: 'card', category: 'Subscriptions' });
    add({ date: withDay(m, 9), payee: 'Melodia Music', raw: 'SQ *MELODIA MUSIC', amount: -10_99, account: 'card', category: 'Subscriptions' });
    add({ date: withDay(m, 17), payee: 'Cloudbox', raw: 'CLOUDBOX STORAGE 2TB', amount: -9_99, account: 'card', category: 'Subscriptions' });
    add({ date: withDay(m, 20), payee: 'Fitlab Gym', raw: 'FITLAB GYM MEMBERSHIP #4471', amount: -39_00, account: 'card', category: 'Subscriptions' });
    add({ date: withDay(m, 24), payee: 'The Daily Ledger', raw: 'PAYPAL *DAILYLEDGER', amount: -8_00, account: 'card', category: 'Subscriptions' });
    add({ date: withDay(m, 1), payee: 'Metro Transit', raw: 'METRO TRANSIT MONTHLY PASS', amount: -98_00, account: 'card', category: 'Transit' });
    // Interest on savings
    add({ date: withDay(m, 28), payee: 'Northbank', raw: 'INTEREST PAYMENT', amount: money(rng, 41, 52), account: 'savings', category: 'Interest earned' });
  }
  // Card statement payments: pay the previous month's card spend on the 22nd.
  // (computed after daily spend below)

  // Daily life
  const groceries = ['Greenleaf Market', 'Corner Grocer', 'FreshCo'];
  const groceryRaw: Record<string, string> = { 'Greenleaf Market': 'POS PURCHASE GREENLEAF MARKET #0231 OAKLAND CA', 'Corner Grocer': 'CHECKCARD CORNER GROCER 11/02', FreshCo: 'FRESHCO #112' };
  const dining = ['Juniper Cafe', 'Tako Taqueria', 'Saffron Kitchen', 'Noodle Bar 88', 'Morning Ritual Coffee', 'Little Fig Bakery', 'Harbor Pizza Co.'];
  const diningRaw = (p: string) => (rng.chance(0.4) ? `SQ *${p.toUpperCase()}` : rng.chance(0.5) ? `TST* ${p.toUpperCase()}` : `${p.toUpperCase()} SAN FRANCISCO CA`);
  const shops = ['Arcadia Online', 'Northwind Outfitters', 'Paper & Pine', 'Volta Electronics'];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dow = dayOfWeek(d);
    // groceries ~2×/week
    if ((dow === 0 || dow === 3) && rng.chance(0.9)) {
      const g = rng.pick(groceries);
      add({ date: d, payee: g, raw: groceryRaw[g], amount: -money(rng, 42, 138), account: rng.chance(0.75) ? 'checking' : 'card', category: 'Groceries' });
    }
    // coffee & dining
    if (rng.chance(dow >= 1 && dow <= 5 ? 0.42 : 0.6)) {
      const p = rng.pick(dining);
      const coffee = p.includes('Coffee') || p.includes('Bakery');
      add({ date: d, payee: p, raw: diningRaw(p), amount: -(coffee ? money(rng, 4.5, 14) : money(rng, 16, 68)), account: 'card', category: 'Dining out' });
    }
    if (rng.chance(0.1)) add({ date: d, payee: 'Northline Fuel', raw: 'NORTHLINE FUEL 0042 DALY CITY CA', amount: -money(rng, 38, 64), account: 'card', category: 'Fuel' });
    if (rng.chance(0.07)) {
      const s = rng.pick(shops);
      add({ date: d, payee: s, raw: s === 'Arcadia Online' ? 'ARCADIA MKTPLACE*2K4H81 SEATTLE WA' : s.toUpperCase(), amount: -money(rng, 18, 140), account: 'card', category: 'Shopping' });
    }
    if (rng.chance(0.05)) add({ date: d, payee: 'Hearth & Home', raw: 'HEARTH AND HOME SUPPLY', amount: -money(rng, 12, 85), account: 'checking', category: 'Household' });
    if (rng.chance(0.035)) add({ date: d, payee: 'Wellspring Pharmacy', raw: 'WELLSPRING PHARMACY #87', amount: -money(rng, 9, 46), account: 'card', category: 'Health' });
    if (rng.chance(0.035)) add({ date: d, payee: 'Starlight Cinema', raw: 'STARLIGHT CINEMA 7', amount: -money(rng, 14, 38), account: 'card', category: 'Entertainment' });
    if (rng.chance(0.02)) add({ date: d, payee: 'Clip Joint Barbers', raw: 'SQ *CLIP JOINT', amount: -money(rng, 28, 45), account: 'card', category: 'Personal care' });
    if (rng.chance(0.015)) add({ date: d, payee: 'Kiln Pottery Studio', raw: 'KILN POTTERY STUDIO', amount: -money(rng, 25, 70), account: 'card', category: 'Hobbies' });
  }
  // A trip in the third month, split across flights, hotel and meals.
  const trip = withDay(monthStart(start, 2), 17);
  add({ date: addDays(trip, -21), payee: 'Skyway Airlines', raw: 'SKYWAY AIR 0062384719921', amount: -412_80, account: 'card', category: 'Travel', tags: ['trip'] });
  add({ date: trip, payee: 'Harborview Hotel', raw: 'HARBORVIEW HOTEL LISBON', amount: -386_00, account: 'card', category: 'Travel', tags: ['trip'] });
  add({ date: addDays(trip, 1), payee: 'Tasca do Rio', raw: 'TASCA DO RIO LISBOA PT', amount: -54_20, account: 'card', category: 'Travel', tags: ['trip'] });
  // Freelance
  add({ date: withDay(monthStart(start, 1), 19), payee: 'Northwind Analytics', raw: 'ACH CREDIT NORTHWIND ANALYTI INV 1042', amount: 1_450_00, account: 'checking', category: 'Side income', tags: ['tax', 'work'] });
  add({ date: withDay(monthStart(start, 3), 23), payee: 'Lumen Books', raw: 'ACH CREDIT LUMEN BOOKS LLC', amount: 820_00, account: 'checking', category: 'Side income', tags: ['tax', 'work'] });
  add({ date: withDay(monthStart(start, 5), 12), payee: 'Northwind Analytics', raw: 'ACH CREDIT NORTHWIND ANALYTI INV 1077', amount: 1_780_00, account: 'checking', category: 'Side income', tags: ['tax', 'work'] });
  // Gifts and an annual bill
  add({ date: withDay(monthStart(start, 4), 10), payee: 'Paper & Pine', raw: 'PAPER AND PINE GIFTS', amount: -86_40, account: 'card', category: 'Gifts' });
  add({ date: withDay(monthStart(start, 2), 3), payee: 'Costco Warehouse', raw: 'COSTCO WHSE #0144', amount: -214_67, account: 'checking', splits: [{ category: 'Groceries', amount: -132_18 }, { category: 'Household', amount: -58_49 }, { category: 'Health', amount: -24_00 }] });

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Card payments: previous month's card spend, paid on the 22nd.
  for (let m = monthStart(start, 1); m <= end; m = monthStart(m, 1)) {
    const prev = monthStart(m, -1);
    const spend = out.filter((t) => t.account === 'card' && t.date >= prev && t.date < m && t.amount < 0).reduce((s, t) => s + t.amount, 0);
    add({ date: withDay(m, 22), payee: 'Meridian Card', raw: 'ONLINE PAYMENT TO MERIDIAN CARD XXXX9902', amount: spend, account: 'checking', transferTo: 'card', memo: 'Statement balance' });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

function seedMoneySample(ctx: MockCtx, set: FinSet): void {
  const rng = createRng('emp:finance:sample');
  const today = ctx.clock.today();
  const start = monthStart(today, -6);
  const A = roleIds(ctx, set.dbs.accounts);
  const T = roleIds(ctx, set.dbs.txns);
  const RR = roleIds(ctx, set.dbs.recurring);
  const G = roleIds(ctx, set.dbs.goals);
  const dbs = ctx.db.table<DbRecord>('db_databases');
  const primary = (id: Id) => dbs.require(id).primaryPropId;

  // Categories by name
  const catIds = new Map<string, Id>();
  for (const r of ctx.db.table<RowRecord>('db_rows').filter((r) => r.databaseId === set.dbs.categories)) {
    const t = (r.values[primary(set.dbs.categories)] as { v?: { text: string }[] } | undefined)?.v?.map((x) => x.text).join('') ?? '';
    catIds.set(t, r.id);
  }

  const acctIds = new Map<string, Id>();
  for (const a of ACCOUNTS) {
    const r = createRow(ctx, set.dbs.accounts, {
      silent: true,
      values: {
        [primary(set.dbs.accounts)]: V.text(a.name),
        [A['acct.type']]: V.sel(a.type),
        [A['acct.currency']]: V.text('USD'),
        [A['acct.opening']]: V.money(a.opening),
        ...(a.apr !== undefined ? { [A['acct.apr']]: V.num(a.apr) } : {}),
        ...(a.min !== undefined ? { [A['acct.min_payment']]: V.money(a.min) } : {}),
        ...(a.limit !== undefined ? { [A['acct.limit']]: V.money(a.limit) } : {}),
        [A['acct.on_budget']]: V.check(a.onBudget),
        ...(a.low !== undefined ? { [A['acct.low_threshold']]: V.money(a.low) } : {}),
        ...(a.type === 'checking' ? { [A['acct.reconciled']]: V.date(addDays(today, -41)) } : {}),
      },
    });
    acctIds.set(a.key, r.id);
  }
  // Institution text
  const inst = ctx.db.table<PropRecord>('db_properties').find((p) => p.databaseId === set.dbs.accounts && p.name === 'Institution');
  if (inst) {
    for (const a of ACCOUNTS) {
      ctx.db.table<RowRecord>('db_rows').update(acctIds.get(a.key)!, (r) => void (r.values[inst.id] = V.text(a.institution)));
    }
  }

  const drafts = generateTransactions(rng, start, today);
  // A dozen recent rows stay uncategorised so the inbox has something to do.
  const recent = drafts.filter((d) => d.date >= addDays(today, -12) && d.category && !d.transferTo && d.amount < 0 && !['Rent', 'Insurance', 'Utilities'].includes(d.category));
  const uncategorised = new Set(recent.slice(-11));
  const txPrimary = primary(set.dbs.txns);
  const counters = new Map<string, number>();
  for (const d of drafts) {
    const created = new Date(`${d.date}T12:00:00`).getTime();
    const key = `${d.account}|${d.date}|${d.amount}|${d.payee}`;
    const occ = (counters.get(key) ?? 0) + 1;
    counters.set(key, occ);
    const cleared = d.date < addDays(today, -41) ? 'reconciled' : d.date < addDays(today, -3) ? 'cleared' : 'uncleared';
    // Everything is reviewed except the uncategorised inbox rows and the last three days' imports.
    const reviewed = !uncategorised.has(d) && d.date < addDays(today, -3);
    const values: Record<Id, CellValue> = {
      [txPrimary]: V.text(d.payee),
      [T['txn.date']]: V.date(d.date),
      [T['txn.amount']]: V.money(d.amount),
      [T['txn.account']]: V.rel([acctIds.get(d.account)!]),
      [T['txn.raw']]: V.text(d.raw),
      [T['txn.cleared']]: V.status(cleared),
      [T['txn.source']]: V.sel('import'),
      [T['txn.import_id']]: V.text(`sample:${d.account}:${d.date}:${d.amount}:${occ}`),
      [T['txn.reviewed']]: V.check(reviewed),
    };
    if (d.memo) values[T['txn.memo']] = V.text(d.memo);
    if (d.tags?.length) values[T['txn.tags']] = V.multi(...d.tags);
    if (d.category && !uncategorised.has(d)) values[T['txn.category']] = V.rel([catIds.get(d.category)!]);
    const row = createRow(ctx, set.dbs.txns, { values, silent: true, sample: true, createdAt: created, updatedAt: created });
    if (d.splits) {
      for (const s of d.splits) {
        createRow(ctx, set.dbs.txns, {
          silent: true,
          sample: true,
          createdAt: created,
          values: {
            [txPrimary]: V.text(d.payee),
            [T['txn.date']]: V.date(d.date),
            [T['txn.amount']]: V.money(s.amount),
            [T['txn.account']]: V.rel([acctIds.get(d.account)!]),
            [T['txn.category']]: V.rel([catIds.get(s.category)!]),
            [T['txn.split_parent']]: V.rel([row.id]),
            [T['txn.cleared']]: V.status(cleared),
            [T['txn.source']]: V.sel('manual'),
            [T['txn.reviewed']]: V.check(reviewed),
          },
        });
      }
    }
    if (d.transferTo) {
      const twin = createRow(ctx, set.dbs.txns, {
        silent: true,
        sample: true,
        createdAt: created,
        values: {
          [txPrimary]: V.text(ACCOUNTS.find((a) => a.key === d.account)?.name ?? 'Transfer'),
          [T['txn.date']]: V.date(d.date),
          [T['txn.amount']]: V.money(-d.amount),
          [T['txn.account']]: V.rel([acctIds.get(d.transferTo)!]),
          [T['txn.raw']]: V.text(`TRANSFER FROM ${ACCOUNTS.find((a) => a.key === d.account)?.name.toUpperCase()}`),
          [T['txn.cleared']]: V.status(cleared),
          [T['txn.source']]: V.sel('import'),
          [T['txn.transfer']]: V.rel([row.id]),
          [T['txn.import_id']]: V.text(`sample:${d.transferTo}:${d.date}:${-d.amount}:${occ}`),
          [T['txn.reviewed']]: V.check(reviewed),
        },
      });
      ctx.db.table<RowRecord>('db_rows').update(row.id, (r) => void (r.values[T['txn.transfer']] = V.rel([twin.id])));
    }
  }

  // One side of a transfer whose other side arrives with the next checking import (shows transfer detection).
  const pending = addDays(today, -3);
  createRow(ctx, set.dbs.txns, {
    silent: true,
    sample: true,
    values: {
      [txPrimary]: V.text('Everyday Checking'),
      [T['txn.date']]: V.date(pending),
      [T['txn.amount']]: V.money(250_00),
      [T['txn.account']]: V.rel([acctIds.get('savings')!]),
      [T['txn.raw']]: V.text('ONLINE TRANSFER FROM CHK XXXX0187'),
      [T['txn.cleared']]: V.status('uncleared'),
      [T['txn.source']]: V.sel('import'),
      [T['txn.import_id']]: V.text(`sample:savings:${pending}:25000:1`),
      [T['txn.reviewed']]: V.check(false),
    },
  });

  // Budget assignments: category targets each month; a few deliberate overspends come from the data itself.
  for (let m = monthStart(start); m <= today; m = monthStart(m, 1)) {
    for (const c of CATEGORIES) {
      if (c.group === 'Income' || c.target <= 0) continue;
      const id = catIds.get(c.name)!;
      let amt = c.target * 100;
      if (c.name === 'Dining out' && m === monthStart(today)) amt = 300_00;
      budgets(ctx).put({ id: `${set.id}|${m.slice(0, 7)}|${id}`, setId: set.id, month: m.slice(0, 7), categoryId: id, assigned: amt });
    }
  }

  // Recurring items (bills, subscriptions, income)
  const recP = primary(set.dbs.recurring);
  const recur: { name: string; amount: number; rrule: string; start: string; kind: string; category: string; account: string; autopay: boolean; prev?: number; variable?: boolean; cancel?: string }[] = [
    { name: 'Paycheck · Acme Studio', amount: 3_084_20, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', start: '2026-01-09', kind: 'income', category: 'Paycheck', account: 'checking', autopay: true },
    { name: 'Rent · Parkside Residences', amount: -2_150_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', start: start, kind: 'bill', category: 'Rent', account: 'checking', autopay: true },
    { name: 'City Power & Light', amount: -145_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=8', start: start, kind: 'bill', category: 'Utilities', account: 'checking', autopay: true, variable: true },
    { name: 'Lumen Mobile', amount: -65_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=11', start: start, kind: 'bill', category: 'Phone & internet', account: 'card', autopay: true },
    { name: 'Fibrewave Internet', amount: -70_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=12', start: start, kind: 'bill', category: 'Phone & internet', account: 'card', autopay: true },
    { name: 'Harbor Mutual Insurance', amount: -182_40, rrule: 'FREQ=MONTHLY;BYMONTHDAY=14', start: start, kind: 'bill', category: 'Insurance', account: 'checking', autopay: false },
    { name: 'Metro Transit pass', amount: -98_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', start: start, kind: 'bill', category: 'Transit', account: 'card', autopay: true },
    { name: 'Streamflix', amount: -17_99, rrule: 'FREQ=MONTHLY;BYMONTHDAY=6', start: start, kind: 'subscription', category: 'Subscriptions', account: 'card', autopay: true, prev: -15_49, cancel: 'https://streamflix.example/account' },
    { name: 'Melodia Music', amount: -10_99, rrule: 'FREQ=MONTHLY;BYMONTHDAY=9', start: start, kind: 'subscription', category: 'Subscriptions', account: 'card', autopay: true },
    { name: 'Cloudbox 2 TB', amount: -9_99, rrule: 'FREQ=MONTHLY;BYMONTHDAY=17', start: start, kind: 'subscription', category: 'Subscriptions', account: 'card', autopay: true },
    { name: 'Fitlab Gym', amount: -39_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=20', start: start, kind: 'subscription', category: 'Subscriptions', account: 'card', autopay: true },
    { name: 'Savings transfer', amount: -600_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=2', start: start, kind: 'bill', category: 'Emergency fund', account: 'checking', autopay: true },
    { name: 'Brokerage contribution', amount: -500_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=3', start: start, kind: 'bill', category: 'Investing', account: 'checking', autopay: true },
    { name: 'Harbor CU auto loan', amount: -345_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=5', start: start, kind: 'bill', category: 'Car replacement', account: 'checking', autopay: true },
    { name: 'Federal Direct student loan', amount: -210_00, rrule: 'FREQ=MONTHLY;BYMONTHDAY=15', start: start, kind: 'bill', category: 'Phone & internet', account: 'checking', autopay: true },
  ];
  for (const r of recur) {
    createRow(ctx, set.dbs.recurring, {
      silent: true,
      sample: true,
      values: {
        [recP]: V.text(r.name),
        [RR['rec.amount']]: V.money(r.amount),
        [RR['rec.schedule']]: V.rec(r.rrule, r.start),
        [RR['rec.account']]: V.rel([acctIds.get(r.account)!]),
        [RR['rec.category']]: V.rel([catIds.get(r.name.includes('loan') ? 'Debt payments' : r.category)!]),
        [RR['rec.kind']]: V.sel(r.kind),
        [RR['rec.autopay']]: V.check(r.autopay),
        [RR['rec.reminder_days']]: V.num(3),
        [RR['rec.variable']]: V.check(!!r.variable),
        ...(r.prev ? { [RR['rec.prev_amount']]: V.money(r.prev) } : {}),
        ...(r.cancel ? { [RR['rec.cancel_url']]: { t: 'url', v: r.cancel } as CellValue } : {}),
      },
    });
  }

  // Goals
  const gp = primary(set.dbs.goals);
  const goalsDef: { name: string; kind: string; target: number; date?: string; saved?: number; account?: string; priority: string; icon: string }[] = [
    { name: 'Emergency fund', kind: 'emergency', target: 21_000_00, account: 'savings', priority: 'high', icon: 'life-buoy' },
    { name: 'Lisbon & Porto, spring', kind: 'sinking', target: 3_200_00, date: monthStart(today, 6).slice(0, 8) + '15', saved: 1_340_00, priority: 'medium', icon: 'palmtree' },
    { name: 'New laptop', kind: 'sinking', target: 2_400_00, date: monthStart(today, 4).slice(0, 8) + '01', saved: 1_650_00, priority: 'medium', icon: 'laptop' },
    { name: 'Car replacement', kind: 'savings', target: 9_000_00, date: '2029-06-01', saved: 2_150_00, priority: 'low', icon: 'car' },
    { name: 'Annual insurance premium', kind: 'sinking', target: 720_00, date: monthStart(today, 2).slice(0, 8) + '10', saved: 540_00, priority: 'high', icon: 'umbrella' },
  ];
  for (const g of goalsDef) {
    createRow(ctx, set.dbs.goals, {
      silent: true,
      sample: true,
      values: {
        [gp]: V.text(g.name),
        [G['goal.kind']]: V.sel(g.kind),
        [G['goal.target']]: V.money(g.target),
        ...(g.date ? { [G['goal.date']]: V.date(g.date) } : {}),
        ...(g.saved !== undefined ? { [G['goal.saved']]: V.money(g.saved) } : {}),
        ...(g.account ? { [G['goal.account']]: V.rel([acctIds.get(g.account)!]) } : {}),
        [G['goal.priority']]: V.sel(g.priority),
        [G['goal.icon']]: V.text(g.icon),
      },
    });
  }

}

// ───────────────────────────────────────────────────────────────────────────── Portfolio

export const ASSET_CLASSES = ['US equity', 'Intl developed', 'Emerging', 'Bonds', 'Inflation-linked', 'REIT', 'Cash', 'Crypto', 'Other'];
export const INV_TYPES = ['buy', 'sell', 'dividend', 'reinvest', 'fee', 'split', 'transfer_in', 'transfer_out', 'return_of_capital', 'interest'];

export function provisionPortfolio(ctx: MockCtx, o: ProvisionOpts): PfSet {
  const existing = o.instanceId ? pfSets(ctx).find((s) => s.instanceId === o.instanceId) : undefined;
  if (existing) return existing;
  const now = ctx.clock.now();
  const ws = o.workspaceId ?? ctx.workspaceId();
  const common = { workspaceId: ws, parentId: o.parentId, appInstanceId: o.instanceId ?? undefined, createdAt: now - 1_200 * DAY, silent: true };
  const opt = (list: string[], colors: string[]) => list.map((id, i) => ({ id, name: labelOf(id), color: colors[i % colors.length] }));
  const accounts = createDatabase(ctx, {
    ...common,
    title: 'Investment accounts',
    icon: lucide('briefcase', 'blue'),
    description: 'Brokerage and retirement accounts. Only ticker symbols ever leave this device.',
    properties: [
      { name: 'Name', type: 'title' },
      { name: 'Broker', type: 'text', role: 'iacct.broker' },
      { name: 'Type', type: 'select', role: 'iacct.type', config: { options: opt(['401k', '403b', 'ira', 'roth_ira', 'hsa', 'taxable', '529', 'crypto'], ['blue', 'purple', 'green', 'orange']) } },
      { name: 'Tax treatment', type: 'select', role: 'iacct.tax', config: { options: [{ id: 'taxable', name: 'Taxable', color: 'orange' }, { id: 'deferred', name: 'Tax-deferred', color: 'blue' }, { id: 'free', name: 'Tax-free', color: 'green' }] } },
      { name: 'Basis method', type: 'select', role: 'iacct.basis', config: { options: [{ id: 'fifo', name: 'FIFO', color: 'gray' }, { id: 'average', name: 'Average cost', color: 'gray' }] } },
      { name: 'Currency', type: 'text', role: 'iacct.currency' },
    ],
  });
  const securities = createDatabase(ctx, {
    ...common,
    title: 'Securities',
    icon: lucide('candlestick-chart', 'blue'),
    properties: [
      { name: 'Name', type: 'title' },
      { name: 'Ticker', type: 'ticker', role: 'sec.ticker', config: { showQuote: true } },
      { name: 'Asset class', type: 'select', role: 'sec.class', config: { options: ASSET_CLASSES.map((c, i) => ({ id: slugify(c), name: c, color: ['blue', 'purple', 'orange', 'green', 'yellow', 'brown', 'gray', 'pink', 'gray'][i] })) } },
      { name: 'Type', type: 'select', role: 'sec.type', config: { options: opt(['equity', 'etf', 'fund', 'crypto', 'bond'], ['blue', 'green', 'purple', 'orange', 'gray']) } },
      { name: 'Expense ratio', type: 'number', role: 'sec.expense_ratio', config: { format: 'percent', decimals: 2 } },
    ],
  });
  const txns = createDatabase(ctx, {
    ...common,
    title: 'Investment transactions',
    icon: lucide('receipt', 'blue'),
    description: 'Buys, sells, dividends and transfers. Lots and gains are rebuilt from this ledger.',
    properties: [
      { name: 'Description', type: 'title' },
      { name: 'Date', type: 'date', role: 'inv.date' },
      { name: 'Type', type: 'select', role: 'inv.type', config: { options: opt(INV_TYPES, ['green', 'red', 'blue', 'purple', 'gray', 'yellow', 'brown', 'brown', 'pink', 'blue']) } },
      { name: 'Security', type: 'relation', role: 'inv.security', config: { targetDatabaseId: securities.db.id, limit: 'one' } },
      { name: 'Quantity', type: 'number', role: 'inv.qty', config: { decimals: 4 } },
      { name: 'Price', type: 'money', role: 'inv.price', config: { currency: 'USD' } },
      { name: 'Amount', type: 'money', role: 'inv.amount', config: { currency: 'USD' } },
      { name: 'Fees', type: 'money', role: 'inv.fees', config: { currency: 'USD' } },
      { name: 'Account', type: 'relation', role: 'inv.account', config: { targetDatabaseId: accounts.db.id, limit: 'one' } },
    ],
  });
  const targets = createDatabase(ctx, {
    ...common,
    title: 'Target allocation',
    icon: lucide('pie-chart', 'blue'),
    description: 'Example starting point, not a recommendation. Targets must add up to 100%.',
    properties: [
      { name: 'Asset class', type: 'title', role: 'alloc.class' },
      { name: 'Target %', type: 'number', role: 'alloc.target', config: { decimals: 1, suffix: '%' } },
      { name: 'Band (pp)', type: 'number', role: 'alloc.band_abs', config: { decimals: 1 } },
      { name: 'Band (relative)', type: 'number', role: 'alloc.band_rel', config: { format: 'percent' } },
    ],
  });
  const set: PfSet = { id: ctx.id(), instanceId: o.instanceId, rootPageId: o.parentId, dbs: { accounts: accounts.db.id, securities: securities.db.id, txns: txns.db.id, targets: targets.db.id }, benchmark: 'EMP500:INDEX', createdAt: now };
  pfSets(ctx).insert(set);
  if (o.sample) seedPortfolioSample(ctx, set);
  return set;
}

function labelOf(id: string): string {
  const map: Record<string, string> = { '401k': '401(k)', '403b': '403(b)', ira: 'IRA', roth_ira: 'Roth IRA', hsa: 'HSA', taxable: 'Taxable', '529': '529 plan', crypto: 'Crypto', etf: 'ETF', return_of_capital: 'Return of capital', transfer_in: 'Transfer in', transfer_out: 'Transfer out' };
  return map[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');
}

function seedPortfolioSample(ctx: MockCtx, set: PfSet): void {
  const dbs = ctx.db.table<DbRecord>('db_databases');
  const P = (id: Id) => dbs.require(id).primaryPropId;
  const A = roleIds(ctx, set.dbs.accounts);
  const S = roleIds(ctx, set.dbs.securities);
  const X = roleIds(ctx, set.dbs.txns);
  const TG = roleIds(ctx, set.dbs.targets);
  const now = ctx.clock.now();
  const today = ctx.clock.today(now);

  const accts: { key: string; name: string; broker: string; type: string; tax: string }[] = [
    { key: 'taxable', name: 'Harbor Brokerage', broker: 'Harbor Brokerage', type: 'taxable', tax: 'taxable' },
    { key: 'k401', name: 'Acme Studio 401(k)', broker: 'Summit Retirement', type: '401k', tax: 'deferred' },
    { key: 'roth', name: 'Roth IRA', broker: 'Harbor Brokerage', type: 'roth_ira', tax: 'free' },
    { key: 'crypto', name: 'Crypto wallet', broker: 'Ledgerline Exchange', type: 'crypto', tax: 'taxable' },
  ];
  const acctId = new Map<string, Id>();
  for (const a of accts) {
    const r = createRow(ctx, set.dbs.accounts, { silent: true, sample: true, values: { [P(set.dbs.accounts)]: V.text(a.name), [A['iacct.broker']]: V.text(a.broker), [A['iacct.type']]: V.sel(a.type), [A['iacct.tax']]: V.sel(a.tax), [A['iacct.basis']]: V.sel('fifo'), [A['iacct.currency']]: V.text('USD') } });
    acctId.set(a.key, r.id);
  }
  const held = ['AXIS:ARCX', 'TERRA:ARCX', 'MERI:ARCX', 'LEDG:ARCX', 'BRIX:XNYS', 'EMPX:XNAS', 'NOVA:XNAS', 'BTC:CRYPTO'];
  const secId = new Map<string, Id>();
  for (const key of held) {
    const i = instrument(key)!;
    const r = createRow(ctx, set.dbs.securities, {
      silent: true,
      sample: true,
      values: {
        [P(set.dbs.securities)]: V.text(i.name),
        [S['sec.ticker']]: V.ticker(i.key),
        [S['sec.class']]: V.sel(slugify(i.assetClass)),
        [S['sec.type']]: V.sel(i.type === 'index' || i.type === 'fx' ? 'equity' : i.type),
        ...(i.expenseRatio !== undefined ? { [S['sec.expense_ratio']]: V.num(i.expenseRatio) } : {}),
      },
    });
    secId.set(key, r.id);
  }
  const targets: [string, number][] = [
    ['US equity', 45],
    ['Intl developed', 18],
    ['Emerging', 7],
    ['Bonds', 20],
    ['REIT', 5],
    ['Cash', 2],
    ['Crypto', 3],
  ];
  for (const [cls, pct] of targets) {
    createRow(ctx, set.dbs.targets, { silent: true, sample: true, values: { [P(set.dbs.targets)]: V.text(cls), [TG['alloc.target']]: V.num(pct), [TG['alloc.band_abs']]: V.num(5), [TG['alloc.band_rel']]: V.num(0.25) } });
  }

  type Tx = { date: string; type: string; sec?: string; qty?: number; price?: number; amount: number; fees?: number; account: string; desc: string };
  const tx: Tx[] = [];
  const priceOn = (key: string, day: string) => closeOn(key, new Date(`${day}T12:00:00Z`).getTime()) ?? 1;
  const buy = (account: string, key: string, day: string, dollars: number, fee = 0) => {
    const price = priceOn(key, day);
    const qty = Math.floor((dollars / price) * 10_000) / 10_000;
    if (qty <= 0) return;
    tx.push({ date: day, type: 'buy', sec: key, qty, price, amount: -Math.round(qty * price * 100) / 100 - fee, fees: fee, account, desc: `Buy ${instrument(key)!.ticker}` });
  };
  const sell = (account: string, key: string, day: string, qty: number) => {
    const price = priceOn(key, day);
    tx.push({ date: day, type: 'sell', sec: key, qty, price, amount: Math.round(qty * price * 100) / 100, account, desc: `Sell ${instrument(key)!.ticker}` });
  };
  const bizDay = (d: string) => {
    let x = d;
    while (dayOfWeek(x) === 0 || dayOfWeek(x) === 6) x = addDays(x, 1);
    return x;
  };
  // Opening positions (early 2023)
  buy('taxable', 'EMPX:XNAS', '2023-01-17', 9_000, 0);
  buy('taxable', 'NOVA:XNAS', '2023-02-06', 6_500, 0);
  buy('taxable', 'AXIS:ARCX', '2023-01-10', 18_000);
  buy('roth', 'MERI:ARCX', '2023-01-05', 3_000);
  buy('roth', 'BRIX:XNYS', '2023-01-05', 3_000);
  buy('k401', 'AXIS:ARCX', '2023-01-06', 22_000);
  buy('k401', 'LEDG:ARCX', '2023-01-06', 14_000);
  buy('k401', 'TERRA:ARCX', '2023-01-06', 9_000);
  buy('crypto', 'BTC:CRYPTO', '2023-02-14', 3_600, 12);
  buy('crypto', 'BTC:CRYPTO', '2024-06-03', 2_400, 9);
  // Monthly contributions
  for (let m = '2023-02-01'; m <= today; m = monthStart(m, 1)) {
    const d401 = bizDay(withDay(m, 15));
    if (d401 > today) break;
    buy('k401', 'AXIS:ARCX', d401, 520);
    buy('k401', 'TERRA:ARCX', d401, 210);
    buy('k401', 'LEDG:ARCX', d401, 270);
    const dtx = bizDay(withDay(m, 3));
    if (dtx <= today) buy('taxable', 'AXIS:ARCX', dtx, m >= '2026-05-01' ? 380 : 300);
    if (dtx <= today && m >= '2026-05-01') buy('taxable', 'TERRA:ARCX', dtx, 120);
    if (m.endsWith('-01') && ['01', '04', '07', '10'].includes(m.slice(5, 7)) && dtx <= today) {
      buy('roth', 'MERI:ARCX', dtx, 600);
      buy('roth', 'BRIX:XNYS', dtx, 450);
      buy('roth', 'LEDG:ARCX', dtx, 450);
    }
  }
  // Sales: trim EMPX (long-term) and harvest NOVA (short-term lot).
  buy('taxable', 'NOVA:XNAS', '2025-11-04', 2_000);
  sell('taxable', 'EMPX:XNAS', bizDay('2026-03-09'), 18);
  sell('taxable', 'NOVA:XNAS', bizDay('2026-08-17'), 25);
  // Dividends (quarterly, from yields); 401(k) reinvests.
  tx.sort((a, b) => (a.date < b.date ? -1 : 1));
  const qtyAt = (account: string, key: string, day: string) => tx.filter((t) => t.account === account && t.sec === key && t.date <= day).reduce((s, t) => s + (t.type === 'buy' || t.type === 'reinvest' ? t.qty ?? 0 : t.type === 'sell' ? -(t.qty ?? 0) : 0), 0);
  const divs: Tx[] = [];
  for (let m = '2023-03-01'; m <= today; m = monthStart(m, 3)) {
    const day = bizDay(withDay(m, 24));
    if (day > today) break;
    for (const a of accts) {
      for (const key of held) {
        const i = instrument(key)!;
        if (!i.divYield) continue;
        const q = qtyAt(a.key, key, day);
        if (q <= 0.0001) continue;
        const amount = Math.round(q * priceOn(key, day) * (i.divYield / 4) * 100) / 100;
        if (amount < 0.5) continue;
        divs.push({ date: day, type: 'dividend', sec: key, amount, account: a.key, desc: `${i.ticker} dividend` });
        if (a.key === 'k401') {
          const price = priceOn(key, day);
          divs.push({ date: day, type: 'reinvest', sec: key, qty: Math.floor((amount / price) * 10_000) / 10_000, price, amount: -amount, account: a.key, desc: `Reinvest ${i.ticker}` });
        }
      }
    }
  }
  tx.push(...divs);
  tx.push({ date: '2026-02-02', type: 'fee', amount: -25, account: 'taxable', desc: 'Annual account fee' });
  tx.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const t of tx) {
    const created = new Date(`${t.date}T15:00:00`).getTime();
    createRow(ctx, set.dbs.txns, {
      silent: true,
      sample: true,
      createdAt: created,
      updatedAt: created,
      values: {
        [P(set.dbs.txns)]: V.text(t.desc),
        [X['inv.date']]: V.date(t.date),
        [X['inv.type']]: V.sel(t.type),
        ...(t.sec ? { [X['inv.security']]: V.rel([secId.get(t.sec)!]) } : {}),
        ...(t.qty !== undefined ? { [X['inv.qty']]: V.num(t.qty) } : {}),
        ...(t.price !== undefined ? { [X['inv.price']]: V.money(Math.round(t.price * 100)) } : {}),
        [X['inv.amount']]: V.money(Math.round(t.amount * 100)),
        ...(t.fees ? { [X['inv.fees']]: V.money(Math.round(t.fees * 100)) } : {}),
        [X['inv.account']]: V.rel([acctId.get(t.account)!]),
      },
    });
  }
  void now;
}

// ───────────────────────────────────────────────────────────────────────────── Tax Organizer

export function provisionTax(ctx: MockCtx, o: ProvisionOpts & { year?: number }): TaxSet {
  const existing = o.instanceId ? taxSets(ctx).find((s) => s.instanceId === o.instanceId) : undefined;
  if (existing) return existing;
  const now = ctx.clock.now();
  const today = ctx.clock.today(now);
  const year = o.year ?? (today.slice(5) < '04-16' ? Number(today.slice(0, 4)) - 1 : Number(today.slice(0, 4)));
  const ws = o.workspaceId ?? ctx.workspaceId();
  const common = { workspaceId: ws, parentId: o.parentId, appInstanceId: o.instanceId ?? undefined, createdAt: now - 120 * DAY, silent: true };
  const docs = createDatabase(ctx, {
    ...common,
    title: `Tax ${year} · Document checklist`,
    icon: lucide('folder-check', 'yellow'),
    description: 'Generated from the US pack and your answers. Status moves Expected → Received → Reviewed → Sent to preparer.',
    properties: [
      { name: 'Document', type: 'title', role: 'taxdoc.name' },
      { name: 'Issuer', type: 'text', role: 'taxdoc.issuer' },
      { name: 'For', type: 'text', role: 'taxdoc.for' },
      { name: 'Expected by', type: 'date', role: 'taxdoc.expected' },
      { name: 'Status', type: 'status', role: 'taxdoc.status', config: { options: [{ id: 'expected', name: 'Expected', color: 'gray', group: 'todo' }, { id: 'received', name: 'Received', color: 'blue', group: 'in_progress' }, { id: 'reviewed', name: 'Reviewed', color: 'purple', group: 'in_progress' }, { id: 'sent', name: 'Sent to preparer', color: 'green', group: 'complete' }, { id: 'na', name: 'N/A', color: 'gray', group: 'complete' }] } },
      { name: 'Amount summary', type: 'text', role: 'taxdoc.summary' },
      { name: 'Notes', type: 'text', role: 'taxdoc.notes' },
    ],
    views: [{ name: 'Checklist', layout: 'table' }, { name: 'By status', layout: 'board' }],
  });
  const deductions = createDatabase(ctx, {
    ...common,
    title: `Tax ${year} · Deductions & credits`,
    icon: lucide('hand-coins', 'yellow'),
    properties: [
      { name: 'Description', type: 'title', role: 'taxded.desc' },
      { name: 'Date', type: 'date', role: 'taxded.date' },
      // The same keys and names as the desktop manifest (`TAX_DEDUCTION_CATEGORIES`, held by the parity test).
      { name: 'Category', type: 'select', role: 'taxded.category', config: { options: TAX_DEDUCTION_CATEGORIES.map((c) => ({ id: c.key, name: c.name, color: TAX_CATEGORY_COLORS[c.key] })) } },
      { name: 'Amount', type: 'money', role: 'taxded.amount', config: { currency: 'USD' } },
      // A fraction (1 = 100%), as on desktop.
      { name: 'Deductible %', type: 'number', role: 'taxded.pct', config: { format: 'percent' } },
      { name: 'Payee', type: 'text', role: 'taxded.payee' },
      { name: 'Receipt', type: 'checkbox', role: 'taxded.receipt' },
      { name: 'Tax year', type: 'number', role: 'taxded.year' },
    ],
  });
  const payments = createDatabase(ctx, {
    ...common,
    title: `Tax ${year} · Estimated payments`,
    icon: lucide('calendar-check', 'yellow'),
    properties: [
      { name: 'Period', type: 'title', role: 'taxpay.period' },
      { name: 'Due date', type: 'date', role: 'taxpay.due' },
      { name: 'Paid amount', type: 'money', role: 'taxpay.amount', config: { currency: 'USD' } },
      { name: 'Paid date', type: 'date', role: 'taxpay.date' },
      { name: 'Method', type: 'select', role: 'taxpay.method', config: { options: [{ id: 'direct_pay', name: 'IRS Direct Pay', color: 'blue' }, { id: 'eftps', name: 'EFTPS', color: 'purple' }, { id: 'check', name: 'Check', color: 'gray' }] } },
    ],
  });
  const set: TaxSet = { id: ctx.id(), instanceId: o.instanceId, rootPageId: o.parentId, dbs: { documents: docs.db.id, deductions: deductions.db.id, payments: payments.db.id }, year, createdAt: now };
  taxSets(ctx).insert(set);
  if (o.sample) seedTaxSample(ctx, set);
  return set;
}

function seedTaxSample(ctx: MockCtx, set: TaxSet): void {
  const dbs = ctx.db.table<DbRecord>('db_databases');
  const P = (id: Id) => dbs.require(id).primaryPropId;
  const D = roleIds(ctx, set.dbs.documents);
  const X = roleIds(ctx, set.dbs.deductions);
  const Q = roleIds(ctx, set.dbs.payments);
  const y = set.year;
  const next = y + 1;
  const docs: [string, string, string, string, string, string?][] = [
    ['W-2', 'Acme Studio', 'Wages', `${next}-01-31`, 'expected'],
    ['1099-NEC', 'Northwind Analytics', 'Freelance income', `${next}-01-31`, 'expected'],
    ['1099-NEC', 'Lumen Books LLC', 'Freelance income', `${next}-01-31`, 'expected'],
    ['1099-INT', 'Northbank', 'Savings interest', `${next}-01-31`, 'expected'],
    ['Consolidated 1099', 'Harbor Brokerage', 'Dividends and sales', `${next}-02-15`, 'expected'],
    ['1098-E', 'Federal Direct', 'Student loan interest', `${next}-01-31`, 'expected'],
    ['5498', 'Harbor Brokerage', 'Roth IRA contributions', `${next}-05-31`, 'expected'],
    ['1099-K', 'Ledgerline Exchange', 'Crypto platform activity', `${next}-01-31`, 'na', 'Below reporting threshold'],
    [`Prior-year return (${y - 1})`, 'Self', 'Safe-harbor amounts', `${y}-04-15`, 'reviewed', 'AGI and total tax for safe harbor'],
  ];
  for (const [doc, issuer, purpose, by, status, notes] of docs) {
    createRow(ctx, set.dbs.documents, { silent: true, sample: true, values: { [P(set.dbs.documents)]: V.text(doc), [D['taxdoc.issuer']]: V.text(issuer), [D['taxdoc.for']]: V.text(purpose), [D['taxdoc.expected']]: V.date(by), [D['taxdoc.status']]: V.status(status), ...(notes ? { [D['taxdoc.notes']]: V.text(notes) } : {}) } });
  }
  const ded: [string, string, string, number, number, string, boolean][] = [
    ['Food bank year-end gift', `${y}-02-11`, 'charity', 250_00, 1, 'Bay Area Food Bank', true],
    ['Public radio membership', `${y}-05-03`, 'charity', 180_00, 1, 'KQPR Public Radio', true],
    ['Dental crown', `${y}-06-19`, 'medical', 1_240_00, 1, 'Bright Smiles Dental', true],
    ['Home office (simplified method)', `${y}-09-30`, 'home_office', 1_500_00, 1, 'Self', false],
    ['Design software subscription', `${y}-03-01`, 'business', 659_88, 1, 'Studio Suite', true],
    ['Co-working day passes', `${y}-07-14`, 'business', 340_00, 1, 'Commons Workspace', false],
    // Made directly to the HSA, not through payroll: only those are an adjustment (`adjustments: hsa` below).
    // Payroll (cafeteria-plan) contributions are already left out of W-2 wages and are not deductible again
    // (IRS Pub 969, https://www.irs.gov/publications/p969).
    ['HSA contributions (direct, not through payroll)', `${y}-10-31`, 'hsa', 2_400_00, 1, 'Northbank HSA', true],
  ];
  for (const [desc, date, cat, amt, pct, payee, receipt] of ded) {
    createRow(ctx, set.dbs.deductions, { silent: true, sample: true, values: { [P(set.dbs.deductions)]: V.text(desc), [X['taxded.date']]: V.date(date), [X['taxded.category']]: V.sel(cat), [X['taxded.amount']]: V.money(amt), [X['taxded.pct']]: V.num(pct), [X['taxded.payee']]: V.text(payee), [X['taxded.receipt']]: V.check(receipt), [X['taxded.year']]: V.num(y) } });
  }
  const pays: [string, string, number | null, string | null][] = [
    ['Q1', `${y}-04-15`, 900_00, `${y}-04-11`],
    ['Q2', `${y}-06-15`, 900_00, `${y}-06-12`],
    ['Q3', `${y}-09-15`, 900_00, `${y}-09-14`],
    ['Q4', `${next}-01-15`, null, null],
  ];
  for (const [period, due, amt, paid] of pays) {
    createRow(ctx, set.dbs.payments, { silent: true, sample: true, values: { [P(set.dbs.payments)]: V.text(period), [Q['taxpay.due']]: V.date(due), ...(amt ? { [Q['taxpay.amount']]: V.money(amt), [Q['taxpay.method']]: V.sel('direct_pay') } : {}), ...(paid ? { [Q['taxpay.date']]: V.date(paid) } : {}) } });
  }
  // Household profile (wizard answers) used by the estimator; editable in the hub.
  kvWrite(ctx, 'ui.tax', 'profile', {
    v: 1,
    packId: `us-federal-${y}`,
    year: y,
    filingStatus: 'single',
    dependents: 0,
    age65OrBlind: 0,
    incomes: [
      { kind: 'wages', amount: '112400', source: 'W-2 · Acme Studio (projected)' },
      { kind: 'self_employment', amount: '11850', source: 'Money HQ · Side income (net of expenses)' },
      { kind: 'interest', amount: '585', source: 'Money HQ · Interest earned' },
    ],
    adjustments: [{ kind: 'hsa', amount: '2400' }],
    deductions: 'auto',
    credits: [],
    withheld: '15890',
    estimatedPaid: '2700',
    priorYearTax: '16420',
    priorYearAgi: '118300',
    method: 'safe_harbor',
    pullPortfolio: true,
    unsure: false,
  });
}

// ───────────────────────────────────────────────────────────────────────────── demo seed

const APP_META: Record<string, { title: string; icon: Icon; color: string }> = {
  'money-hq': { title: 'Money HQ', icon: lucide('wallet', 'green'), color: 'jade' },
  portfolio: { title: 'Portfolio', icon: lucide('candlestick-chart', 'blue'), color: 'ocean' },
  'tax-organizer': { title: 'Tax Organizer', icon: lucide('receipt-text', 'yellow'), color: 'amber' },
};

interface FallbackInstance extends LifeAppInstance {
  workspaceId: Id;
}
const fallbackInstances = (ctx: MockCtx) => ctx.db.table<FallbackInstance>('fin_fallback_instances');

function fallbackChecklist(appId: string) {
  const items: Record<string, [string, string, boolean][]> = {
    'money-hq': [
      ['import', 'Import transactions', true],
      ['categorize', 'Categorise last month', true],
      ['budget', 'Set a budget', true],
      ['ef', 'Set an emergency-fund goal', true],
      ['subs', 'Review subscriptions', false],
      ['checkin', 'Do your first weekly check-in', false],
    ],
    portfolio: [
      ['accounts', 'Add accounts', true],
      ['positions', 'Import or enter positions', true],
      ['targets', 'Set target allocation', true],
      ['ips', 'Write your IPS', false],
      ['rebalance', 'Run your first rebalance check', false],
    ],
    'tax-organizer': [
      ['status', 'Confirm filing status', true],
      ['docs', 'Add expected documents', true],
      ['deduction', 'Log your first deduction', true],
      ['quarterly', 'Review quarterly plan', false],
      ['preparer', 'Choose a preparer path', false],
    ],
  };
  return (items[appId] ?? []).map(([id, label, done]) => ({ id, label, done }));
}

function ensureInstance(ctx: MockCtx, ws: Id, appId: string): { instanceId: Id; rootPageId: Id } {
  const svc = ctx.services.get<KnownServices['lifeapp.instances']>('lifeapp.instances');
  let list: LifeAppInstance[] = [];
  try {
    list = svc ? svc(ws) : [];
  } catch {
    list = [];
  }
  const found = list.find((i) => i.appId === appId && !i.detached);
  if (found) return { instanceId: found.id, rootPageId: found.rootPageId };
  // Fallback: the life-apps mock has not installed this app — create the hub page and instance record here.
  const meta = APP_META[appId];
  const id = ctx.id();
  const page = ctx.pages.create({ workspaceId: ws, parentId: null, kind: 'app', title: meta.title, icon: meta.icon, appInstanceId: id, templateKey: `${appId}:root`, createdAt: ctx.clock.now() - 190 * DAY, silent: true });
  fallbackInstances(ctx).insert({ id, appId, version: '1.0.0', rootPageId: page.id, installedAt: ctx.clock.now() - 190 * DAY, upgradeAvailable: false, detached: false, checklist: fallbackChecklist(appId), workspaceId: ws });
  return { instanceId: id, rootPageId: page.id };
}

export function seed(ctx: MockCtx): void {
  if (ctx.seedKind !== 'demo') return;
  let ws: Id;
  try {
    ws = ctx.workspaceId();
  } catch {
    return;
  }
  const money = ensureInstance(ctx, ws, 'money-hq');
  const pf = ensureInstance(ctx, ws, 'portfolio');
  const tax = ensureInstance(ctx, ws, 'tax-organizer');
  if (fallbackInstances(ctx).all().length) {
    const prev = ctx.services.get<KnownServices['lifeapp.instances']>('lifeapp.instances');
    ctx.services.provide<KnownServices['lifeapp.instances']>('lifeapp.instances', (workspaceId) => {
      const theirs = prev ? safe(() => prev(workspaceId)) : [];
      const mine = fallbackInstances(ctx)
        .filter((i) => i.workspaceId === workspaceId && !theirs.some((t) => t.appId === i.appId))
        .map(({ workspaceId: _w, ...i }) => i);
      return [...theirs, ...mine];
    });
  }
  provisionMoneyHq(ctx, { instanceId: money.instanceId, parentId: money.rootPageId, sample: true, workspaceId: ws });
  provisionPortfolio(ctx, { instanceId: pf.instanceId, parentId: pf.rootPageId, sample: true, workspaceId: ws });
  provisionTax(ctx, { instanceId: tax.instanceId, parentId: tax.rootPageId, sample: true, workspaceId: ws });
  seedWatchlists(ctx);
  ctx.seedRefs.set('finance.instance.moneyHq', money.instanceId);
  ctx.seedRefs.set('finance.instance.portfolio', pf.instanceId);
  ctx.seedRefs.set('finance.instance.tax', tax.instanceId);
  ctx.pages.emitTree(ws, [money.rootPageId, pf.rootPageId, tax.rootPageId]);
}

function safe<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function seedWatchlists(ctx: MockCtx): void {
  const t = ctx.db.table<{ id: string; name: string; symbols: WatchlistSymbol[]; sortKey: string }>('watchlists');
  if (t.all().length) return;
  const add = (name: string, symbols: WatchlistSymbol[], after: string | null) => {
    const id = ctx.id();
    const sortKey = ctx.keyBetween(after, null);
    t.insert({ id, name, symbols, sortKey });
    return sortKey;
  };
  const k = add(
    'Watching',
    [
      { key: 'EMPX:XNAS', alertAbove: Math.round((closeOn('EMPX:XNAS', ctx.clock.now()) ?? 100) * 1.08) },
      { key: 'ORBT:XNYS' },
      { key: 'KITE:XNAS', alertBelow: Math.round((closeOn('KITE:XNAS', ctx.clock.now()) ?? 30) * 0.9) },
      { key: 'VOLT:XNAS', alertPct: 5 },
      { key: 'LUMA:XNYS' },
      { key: 'ZENO:XNAS' },
      { key: 'BTC:CRYPTO' },
      { key: 'ETH:CRYPTO' },
    ],
    null,
  );
  add('Income ideas', [{ key: 'BRIX:XNYS' }, { key: 'LUMA:XNYS' }, { key: 'LEDG:ARCX' }, { key: 'TERRA:ARCX' }], k);
}
