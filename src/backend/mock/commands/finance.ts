/**
 * Mock `finance_*` commands (§11.3 Finance) implementing the §15 engine semantics in TypeScript (CLAUDE.md
 * override 1): budget identities, rollover and to-be-assigned, net worth, savings rate, emergency-fund months,
 * cash-flow Sankey, CSV/OFX/QFX/QIF import with sniffing, payee normalisation, dedupe and transfer detection,
 * rules, recurring detection, debt simulation, forecast with a bootstrap band, amortisation and goal maths.
 *
 * Money HQ data lives in real databases (Accounts, Categories, Transactions, Recurring, Goals) created by
 * seed/finance.ts and read here by semantic role (§15.0). Budget assignments, rules and import profiles are
 * mock tables.
 */
import type { CellValue, Id, ImportMapping, Rule, RuleCondition } from '../../types';
import type { MockCallCtx, MockCtx, MockHandlers } from '../ctx';
import { createRow, liveRows, type DbApi, type DbRecord, type PropRecord, type RowRecord } from './db';
import {
  budgets,
  centsToStr,
  DEBT_TYPES,
  finSets,
  provisionMoneyHq,
  provisionPortfolio,
  provisionTax,
  strToCents,
  V,
  type FinSet,
  type ProvisionOpts,
} from '../seed/finance';
import { createRng } from '../rng';
import { debtMinimum } from '../../figures';

const DAY = 86_400_000;

// ───────────────────────────────────────────────────────────────────────────── ledger model

export interface Account {
  id: Id;
  name: string;
  type: string;
  institution: string;
  currency: string;
  opening: number;
  apr: number | null;
  minPayment: number;
  limit: number | null;
  onBudget: boolean;
  lowThreshold: number | null;
  reconciled: string | null;
  closed: boolean;
}

export interface Category {
  id: Id;
  name: string;
  group: string;
  essential: boolean;
  rollover: boolean;
  color: string;
  icon: string;
  target: number;
  income: boolean;
}

export interface Txn {
  id: Id;
  date: string;
  payee: string;
  raw: string;
  memo: string;
  amount: number;
  accountId: Id | null;
  categoryId: Id | null;
  splitParent: Id | null;
  transferId: Id | null;
  importId: string;
  cleared: string;
  hasSplits: boolean;
}

export interface RecurringItem {
  id: Id;
  name: string;
  amount: number;
  rrule: string;
  dtstart: string;
  accountId: Id | null;
  categoryId: Id | null;
  kind: string;
  autopay: boolean;
  variable: boolean;
  prevAmount: number | null;
}

export interface Goal {
  id: Id;
  name: string;
  kind: string;
  target: number;
  date: string | null;
  saved: number;
  accountId: Id | null;
}

export interface Ledger {
  set: FinSet;
  roles: { acct: Record<string, Id>; cat: Record<string, Id>; txn: Record<string, Id>; rec: Record<string, Id>; goal: Record<string, Id> };
  primary: { acct: Id; cat: Id; txn: Id; rec: Id; goal: Id };
  accounts: Account[];
  categories: Category[];
  txns: Txn[];
  recurring: RecurringItem[];
  goals: Goal[];
  acctById: Map<Id, Account>;
  catById: Map<Id, Category>;
  txnById: Map<Id, Txn>;
}

const dbs = (ctx: MockCtx) => ctx.db.table<DbRecord>('db_databases');

function text(v: CellValue | undefined): string {
  if (!v) return '';
  if (v.t === 'text') return v.v.map((x) => x.text).join('');
  if (v.t === 'url' || v.t === 'email' || v.t === 'phone') return v.v ?? '';
  return '';
}
const moneyOf = (v: CellValue | undefined): number | null => (v && v.t === 'money' && v.v !== null ? strToCents(v.v) : null);
const numOf = (v: CellValue | undefined): number | null => (v && v.t === 'number' ? v.v : null);
const dateOf = (v: CellValue | undefined): string | null => (v && v.t === 'date' && v.v ? v.v.start.slice(0, 10) : null);
const relOf = (v: CellValue | undefined): Id | null => (v && v.t === 'relation' ? (v.v[0] ?? null) : null);
const selOf = (v: CellValue | undefined): string | null => (v && (v.t === 'select' || v.t === 'status') ? v.v : null);
const checkOf = (v: CellValue | undefined): boolean => !!(v && v.t === 'check' && v.v);

const ledgerCache = new WeakMap<object, Map<Id, { version: number; ledger: Ledger }>>();

function optionName(ctx: MockCtx, propId: Id | undefined, optId: string | null): string {
  if (!propId || !optId) return '';
  const p = ctx.db.table<PropRecord>('db_properties').get(propId);
  const opts = (p?.config.options as { id: string; name: string }[] | undefined) ?? [];
  return opts.find((o) => o.id === optId)?.name ?? optId;
}

/** A liability's opening balance is the amount owed, either sign: counted as `−|opening|` (Rust `opening_as_counted`). */
export function openingAsCounted(type: string, opening: number): number {
  return DEBT_TYPES.has(type) ? -Math.abs(opening) : opening;
}

export function readLedger(ctx: MockCtx, set: FinSet): Ledger {
  let m = ledgerCache.get(ctx.db);
  if (!m) ledgerCache.set(ctx.db, (m = new Map()));
  const hit = m.get(set.id);
  if (hit && hit.version === ctx.db.version) return hit.ledger;
  const d = (id: Id) => dbs(ctx).require(id);
  const A = d(set.dbs.accounts);
  const C = d(set.dbs.categories);
  const X = d(set.dbs.txns);
  const R = d(set.dbs.recurring);
  const G = d(set.dbs.goals);
  const ra = A.roles;
  const rc = C.roles;
  const rx = X.roles;
  const rr = R.roles;
  const rg = G.roles;

  const accounts: Account[] = liveRows(ctx, A.id).map((r) => ({
    id: r.id,
    name: text(r.values[A.primaryPropId]) || 'Untitled account',
    type: selOf(r.values[ra['acct.type']]) ?? 'other_asset',
    institution: text(r.values[findProp(ctx, A.id, 'Institution')]),
    currency: text(r.values[ra['acct.currency']]) || set.baseCurrency,
    // Card and loan openings are amounts owed, whichever sign they were entered with (Rust `opening_as_counted`).
    opening: openingAsCounted(selOf(r.values[ra['acct.type']]) ?? 'other_asset', moneyOf(r.values[ra['acct.opening']]) ?? 0),
    apr: numOf(r.values[ra['acct.apr']]),
    minPayment: moneyOf(r.values[ra['acct.min_payment']]) ?? 0,
    limit: moneyOf(r.values[ra['acct.limit']]),
    onBudget: checkOf(r.values[ra['acct.on_budget']]),
    lowThreshold: moneyOf(r.values[ra['acct.low_threshold']]),
    reconciled: dateOf(r.values[ra['acct.reconciled']]),
    closed: checkOf(r.values[ra['acct.closed']]),
  }));
  const categories: Category[] = liveRows(ctx, C.id)
    .slice()
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
    .map((r) => {
      const group = optionName(ctx, rc['cat.group'], selOf(r.values[rc['cat.group']])) || 'Everyday';
      return {
        id: r.id,
        name: text(r.values[C.primaryPropId]) || 'Untitled',
        group,
        essential: checkOf(r.values[rc['cat.essential']]),
        rollover: checkOf(r.values[rc['cat.rollover']]),
        color: selOf(r.values[rc['cat.color']]) ?? 'gray',
        icon: text(r.values[rc['cat.icon']]) || 'circle',
        target: moneyOf(r.values[rc['cat.target']]) ?? 0,
        income: group === 'Income',
      };
    });
  const rows = liveRows(ctx, X.id);
  const parents = new Set<Id>();
  for (const r of rows) {
    const p = relOf(r.values[rx['txn.split_parent']]);
    if (p) parents.add(p);
  }
  const txns: Txn[] = rows.map((r) => ({
    id: r.id,
    date: dateOf(r.values[rx['txn.date']]) ?? '1970-01-01',
    payee: text(r.values[X.primaryPropId]),
    raw: text(r.values[rx['txn.raw']]),
    memo: text(r.values[rx['txn.memo']]),
    amount: moneyOf(r.values[rx['txn.amount']]) ?? 0,
    accountId: relOf(r.values[rx['txn.account']]),
    categoryId: relOf(r.values[rx['txn.category']]),
    splitParent: relOf(r.values[rx['txn.split_parent']]),
    transferId: relOf(r.values[rx['txn.transfer']]),
    importId: text(r.values[rx['txn.import_id']]),
    cleared: selOf(r.values[rx['txn.cleared']]) ?? 'uncleared',
    hasSplits: parents.has(r.id),
  }));
  txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const recurring: RecurringItem[] = liveRows(ctx, R.id).map((r) => {
    const rec = r.values[rr['rec.schedule']];
    const rv = rec && rec.t === 'recurrence' ? rec.v : null;
    return {
      id: r.id,
      name: text(r.values[R.primaryPropId]),
      amount: moneyOf(r.values[rr['rec.amount']]) ?? 0,
      rrule: rv?.rrule ?? 'FREQ=MONTHLY',
      dtstart: rv?.dtstart?.slice(0, 10) ?? ctx.clock.today(),
      accountId: relOf(r.values[rr['rec.account']]),
      categoryId: relOf(r.values[rr['rec.category']]),
      kind: selOf(r.values[rr['rec.kind']]) ?? 'bill',
      autopay: checkOf(r.values[rr['rec.autopay']]),
      variable: checkOf(r.values[rr['rec.variable']]),
      prevAmount: moneyOf(r.values[rr['rec.prev_amount']]),
    };
  });
  const goals: Goal[] = liveRows(ctx, G.id).map((r) => ({
    id: r.id,
    name: text(r.values[G.primaryPropId]),
    kind: selOf(r.values[rg['goal.kind']]) ?? 'savings',
    target: moneyOf(r.values[rg['goal.target']]) ?? 0,
    date: dateOf(r.values[rg['goal.date']]),
    saved: moneyOf(r.values[rg['goal.saved']]) ?? 0,
    accountId: relOf(r.values[rg['goal.account']]),
  }));
  const ledger: Ledger = {
    set,
    roles: { acct: ra, cat: rc, txn: rx, rec: rr, goal: rg },
    primary: { acct: A.primaryPropId, cat: C.primaryPropId, txn: X.primaryPropId, rec: R.primaryPropId, goal: G.primaryPropId },
    accounts,
    categories,
    txns,
    recurring,
    goals,
    acctById: new Map(accounts.map((a) => [a.id, a])),
    catById: new Map(categories.map((c) => [c.id, c])),
    txnById: new Map(txns.map((t) => [t.id, t])),
  };
  m.set(set.id, { version: ctx.db.version, ledger });
  return ledger;
}

function findProp(ctx: MockCtx, dbId: Id, name: string): Id {
  return ctx.db.table<PropRecord>('db_properties').find((p) => p.databaseId === dbId && p.name === name && !p.deletedAt)?.id ?? '';
}

export function resolveSet(ctx: MockCtx, instanceId: Id | undefined | null): FinSet {
  const all = finSets(ctx).all();
  const live = all.filter((s) => dbs(ctx).has(s.dbs.txns) && !ctx.pages.get(s.dbs.txns)?.deletedAt);
  const exact = instanceId ? live.find((s) => s.instanceId === instanceId) : undefined;
  if (exact) return exact;
  // An instance installed by the life-apps mock without our provisioning: adopt databases that carry our roles.
  if (instanceId) {
    const byRole = (role: string) => dbs(ctx).find((d) => d.appInstanceId === instanceId && !!d.roles[role] && !ctx.pages.get(d.id)?.deletedAt)?.id;
    const txns = byRole('txn.amount');
    const accounts = byRole('acct.type');
    const categories = byRole('cat.group');
    const recurring = byRole('rec.amount');
    const goals = byRole('goal.target');
    if (txns && accounts && categories && recurring && goals) {
      const set: FinSet = { id: ctx.id(), instanceId, rootPageId: ctx.pages.get(txns)?.parentId ?? null, dbs: { accounts, categories, txns, recurring, goals }, baseCurrency: 'USD', method: 'zero_based', monthStartDay: 1, createdAt: ctx.clock.now() };
      finSets(ctx).insert(set);
      return set;
    }
  }
  if (live[0]) return live[0];
  return ctx.fail('NOT_FOUND', 'Money HQ is not set up yet');
}

// ───────────────────────────────────────────────────────────────────────────── dates

export function iso(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d.getTime());
}
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function dayDiff(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / DAY);
}
function validMonth(ctx: MockCtx, m: string | undefined): string {
  if (typeof m === 'string' && /^\d{4}-\d{2}$/.test(m)) return m;
  if (typeof m === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m)) return m.slice(0, 7);
  return ctx.clock.today().slice(0, 7);
}

// ───────────────────────────────────────────────────────────────────────────── core quantities

/** Rows that move an account balance (split children duplicate their parent's amount). */
function balanceRows(l: Ledger): Txn[] {
  return l.txns.filter((t) => !t.splitParent);
}

/** Rows that carry spending/income meaning (split parents replaced by their children). */
function spendRows(l: Ledger): Txn[] {
  return l.txns.filter((t) => !t.hasSplits);
}

function isTransfer(l: Ledger, t: Txn): boolean {
  if (t.transferId) return true;
  const parent = t.splitParent ? l.txnById.get(t.splitParent) : undefined;
  return !!parent?.transferId;
}

/** A transfer between two on-budget accounts has no budget meaning at all. */
function isOnBudgetTransfer(l: Ledger, t: Txn): boolean {
  if (!t.transferId) return false;
  const a = t.accountId ? l.acctById.get(t.accountId) : undefined;
  const twin = l.txnById.get(t.transferId);
  const b = twin?.accountId ? l.acctById.get(twin.accountId) : undefined;
  return !!a?.onBudget && !!b?.onBudget;
}

export function balanceAt(l: Ledger, accountId: Id, day: string): number {
  const a = l.acctById.get(accountId);
  let b = a?.opening ?? 0;
  for (const t of balanceRows(l)) if (t.accountId === accountId && t.date <= day) b += t.amount;
  return b;
}

function balances(l: Ledger, day: string): Map<Id, number> {
  const out = new Map<Id, number>(l.accounts.map((a) => [a.id, a.opening]));
  for (const t of balanceRows(l)) {
    if (t.date > day || !t.accountId) continue;
    out.set(t.accountId, (out.get(t.accountId) ?? 0) + t.amount);
  }
  return out;
}

/** Portfolio valuation hook (provided by commands/portfolio.ts). */
type ValueAt = (ctx: MockCtx, day: string) => number | null;

function investmentValue(ctx: MockCtx, day: string): number | null {
  const fn = ctx.services.get<ValueAt>('portfolio.valueAt');
  if (!fn) return null;
  try {
    return fn(ctx, day);
  } catch {
    return null;
  }
}

export interface NetWorthPoint {
  assets: number;
  liabilities: number;
  /** Portfolio market value counted in `assets` (null when the investment accounts are at their ledger balance). */
  investments: number | null;
}

/**
 * Net worth as of `day` — THE definition every Money HQ figure uses (overview hero, Accounts tiles, Net worth tab,
 * Home widget), mirrored by the Rust backend (`emp_finance::networth::point`):
 *  - open accounts only (closed accounts are excluded at every date);
 *  - each balance is opening + every transaction dated on or before `day` (future-dated rows don't count);
 *  - sign decides the side, not the account type: a positive balance is an asset (an overpaid card too), a negative
 *    one a liability (debts carry negative balances; an overdrawn checking account is a liability);
 *  - only accounts in the base currency count (the ledger keeps no FX rates; Rust reports others as missing rates);
 *  - when Portfolio is installed, its market value (holdings at the day's price + cash) replaces the ledger balances
 *    of every open investment account, once (§16.8); otherwise investment accounts count at their ledger balance.
 */
export function netWorthAt(ctx: MockCtx, l: Ledger, day: string, bal = balances(l, day), base = 'USD'): NetWorthPoint {
  let assets = 0;
  let liabilities = 0;
  const inv = investmentValue(ctx, day);
  for (const a of l.accounts) {
    if (a.closed || (a.currency && a.currency !== base)) continue;
    if (a.type === 'investment' && inv !== null) continue;
    const b = bal.get(a.id) ?? 0;
    if (b >= 0) assets += b;
    else liabilities -= b;
  }
  if (inv !== null) assets += inv;
  return { assets, liabilities, investments: inv };
}

/** Date of Portfolio's first transaction (provided by commands/portfolio.ts), or null without Portfolio. */
function portfolioFirstDate(ctx: MockCtx): string | null {
  const fn = ctx.services.get<(c: MockCtx) => string | null>('portfolio.firstDate');
  try {
    return fn ? fn(ctx) : null;
  } catch {
    return null;
  }
}

/**
 * Net worth snapshot rows the user entered, by month (Rust `networth_series` / `snapshot_month`): rows of the
 * instance's Net worth database whose Source is not Auto/Automatic; the month is the title (`YYYY-MM`), else the
 * Date column's month.
 */
function manualSnapshots(ctx: MockCtx, set: FinSet): Map<string, NetWorthPoint> {
  const out = new Map<string, NetWorthPoint>();
  if (!set.instanceId) return out;
  const db = dbs(ctx).find((d) => d.appInstanceId === set.instanceId && !!d.roles['nw.assets'] && !ctx.pages.get(d.id)?.deletedAt);
  if (!db) return out;
  const src = findProp(ctx, db.id, 'Source');
  for (const r of liveRows(ctx, db.id)) {
    const source = optionName(ctx, src, selOf(r.values[src])).toLowerCase();
    if (source === 'auto' || source === 'automatic') continue;
    const title = text(r.values[db.primaryPropId]).trim();
    const month = /^\d{4}-\d{2}$/.test(title) ? title : dateOf(r.values[db.roles['nw.date']])?.slice(0, 7);
    if (!month) continue;
    const assets = moneyOf(r.values[db.roles['nw.assets']]) ?? 0;
    const liabilities = Math.abs(moneyOf(r.values[db.roles['nw.liabilities']]) ?? 0);
    out.set(month, { assets, liabilities, investments: null });
  }
  return out;
}

// ── budget

interface CatMonth {
  assigned: number;
  activity: number;
  available: number;
  rollover: number;
}

interface BudgetCalc {
  months: string[];
  cats: Map<string, Map<Id, CatMonth>>;
  tba: Map<string, number>;
  income: Map<string, number>;
}

function budgetActivity(l: Ledger): Map<string, Map<Id, number>> {
  const out = new Map<string, Map<Id, number>>();
  for (const t of spendRows(l)) {
    if (!t.categoryId) continue;
    if (isOnBudgetTransfer(l, t)) continue;
    const acct = t.accountId ? l.acctById.get(t.accountId) : undefined;
    // Off-budget accounts only matter for transfers in from the budget (debt payments, investing).
    if (acct && !acct.onBudget) continue;
    const m = t.date.slice(0, 7);
    let mm = out.get(m);
    if (!mm) out.set(m, (mm = new Map()));
    mm.set(t.categoryId, (mm.get(t.categoryId) ?? 0) + t.amount);
  }
  return out;
}

function computeBudget(ctx: MockCtx, l: Ledger, through: string): BudgetCalc {
  const act = budgetActivity(l);
  const assignedRows = budgets(ctx).filter((b) => b.setId === l.set.id);
  const assigned = new Map<string, number>();
  for (const b of assignedRows) assigned.set(`${b.month}|${b.categoryId}`, b.assigned);
  const first = [l.txns[0]?.date.slice(0, 7), ...assignedRows.map((b) => b.month)].filter(Boolean).sort()[0] ?? through;
  const months: string[] = [];
  for (let m = first < through ? first : through; m <= through; m = addMonths(m, 1)) months.push(m);
  const cats = new Map<string, Map<Id, CatMonth>>();
  const tba = new Map<string, number>();
  const income = new Map<string, number>();
  let prevTba = 0;
  let prev: Map<Id, CatMonth> | null = null;
  for (const m of months) {
    const mm = new Map<Id, CatMonth>();
    let inc = 0;
    for (const c of l.categories) if (c.income) inc += act.get(m)?.get(c.id) ?? 0;
    // Uncategorised inflows to on-budget accounts count as income to assign.
    let overspendCarry = 0;
    let sumAssigned = 0;
    for (const c of l.categories) {
      if (c.income) continue;
      const a = assigned.get(`${m}|${c.id}`) ?? 0;
      const activity = act.get(m)?.get(c.id) ?? 0;
      const p = prev?.get(c.id);
      let rollover = 0;
      if (p) {
        if (c.rollover) rollover = p.available;
        else if (p.available < 0) overspendCarry += p.available;
      }
      mm.set(c.id, { assigned: a, activity, available: rollover + a + activity, rollover });
      sumAssigned += a;
    }
    income.set(m, inc);
    const t = inc + prevTba + overspendCarry - sumAssigned;
    tba.set(m, t);
    prevTba = t;
    prev = mm;
    cats.set(m, mm);
  }
  return { months, cats, tba, income };
}

function pace(ctx: MockCtx, month: string): number {
  const today = ctx.clock.today();
  if (month < today.slice(0, 7)) return 1;
  if (month > today.slice(0, 7)) return 0;
  return Number(today.slice(8, 10)) / daysInMonth(month);
}

// ── income / spending metrics

/** A savings / investing category: its outflows count as saving, not spending (Rust `Category::is_saving`). */
function isSavingCat(c: Category | undefined): boolean {
  return !!c && !c.income && c.group.toLowerCase().includes('saving');
}

/**
 * Income and spending over `[from, to]` — the §15.5 definition shared with Rust `metrics::income_spending`:
 * transfers never count; income = rows in income categories; rows in saving categories are saving (neither);
 * every other row — uncategorised ones and refunds included — is (net) spending. Split parents are replaced by
 * their parts.
 */
export function flows(l: Ledger, from: string, to: string): { income: number; spending: number } {
  let income = 0;
  let spending = 0;
  for (const t of spendRows(l)) {
    if (t.date < from || t.date > to || isTransfer(l, t)) continue;
    const cat = t.categoryId ? l.catById.get(t.categoryId) : undefined;
    if (cat?.income) income += t.amount;
    else if (!isSavingCat(cat)) spending += -t.amount;
  }
  return { income, spending };
}

/** `day` moved by `n` calendar months, the day clamped to the target month (Rust `period::add_months`). */
function addMonthsToDay(day: string, n: number): string {
  const m = addMonths(day.slice(0, 7), n);
  return `${m}-${String(Math.min(Number(day.slice(8, 10)), daysInMonth(m))).padStart(2, '0')}`;
}

/** The window of {@link savingsRate3m}: the trailing 3 calendar months ending `today` (Rust `metrics::savings_window`). */
export function savingsWindow(today: string): [string, string] {
  return [addDays(addMonthsToDay(today, -3), 1), today];
}

/** Savings rate over the trailing 3 months ending `today` (Rust `metrics::savings_rate_3m`); 0 without income. */
export function savingsRate3m(l: Ledger, today: string): number {
  const fl = flows(l, ...savingsWindow(today));
  return fl.income > 0 ? (fl.income - fl.spending) / fl.income : 0;
}

/**
 * Essential monthly spend (Rust `metrics::essential_monthly_spend`): the median of the three trailing 30-day sums
 * (days 0–29, 30–59, 60–89 before `today`) of net outflows in categories marked essential; never negative.
 */
export function essentialMonthly(l: Ledger, today: string): number {
  const sums = [0, 0, 0];
  for (const t of spendRows(l)) {
    if (isTransfer(l, t)) continue;
    const age = dayDiff(t.date, today);
    if (age < 0 || age >= 90) continue;
    const c = t.categoryId ? l.catById.get(t.categoryId) : undefined;
    if (c?.essential && !c.income) sums[Math.floor(age / 30)] += -t.amount;
  }
  sums.sort((a, b) => a - b);
  return Math.max(0, sums[1]);
}

/**
 * Emergency-fund balance (`ef_balance`, shared with Rust `ef_balance`): the balance as of `today` of the account
 * linked to the emergency-fund goal; else that goal's saved amount; else the total of the open savings accounts.
 */
export function emergencyBalance(l: Ledger, today: string): number {
  const ef = l.goals.find((g) => g.kind === 'emergency');
  if (ef?.accountId && l.acctById.has(ef.accountId)) return balanceAt(l, ef.accountId, today);
  if (ef) return ef.saved;
  return l.accounts.filter((a) => a.type === 'savings' && !a.closed).reduce((s, a) => s + balanceAt(l, a.id, today), 0);
}

// ───────────────────────────────────────────────────────────────────────────── recurrence

const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Occurrences of a (subset of) RRULE between `from` and `to` inclusive: FREQ, INTERVAL, BYDAY, BYMONTHDAY. */
export function occurrences(rrule: string, dtstart: string, from: string, to: string, cap = 500): string[] {
  const parts = Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((p) => p.split('=') as [string, string])
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]),
  );
  const freq = parts.FREQ ?? 'MONTHLY';
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const out: string[] = [];
  const startD = new Date(`${dtstart}T12:00:00`);
  if (!Number.isFinite(startD.getTime())) return out;
  if (freq === 'WEEKLY' || freq === 'DAILY') {
    const step = freq === 'DAILY' ? interval : 7 * interval;
    let d = dtstart;
    if (freq === 'WEEKLY' && parts.BYDAY) {
      const want = BYDAY[parts.BYDAY.split(',')[0]] ?? startD.getDay();
      while (new Date(`${d}T12:00:00`).getDay() !== want) d = addDays(d, 1);
    }
    if (d < from) d = addDays(d, Math.floor(dayDiff(d, from) / step) * step);
    for (; d <= to && out.length < cap; d = addDays(d, step)) if (d >= from) out.push(d);
    return out;
  }
  const monthsStep = freq === 'YEARLY' ? 12 * interval : freq === 'QUARTERLY' ? 3 : interval;
  const dom = Number(parts.BYMONTHDAY) || startD.getDate();
  let m = dtstart.slice(0, 7);
  const skip = Math.max(0, Math.floor(((Number(from.slice(0, 4)) - Number(m.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(m.slice(5, 7))) / monthsStep) - 1);
  m = addMonths(m, skip * monthsStep);
  for (let guard = 0; guard < 2000 && out.length < cap; guard++, m = addMonths(m, monthsStep)) {
    const day = `${m}-${String(Math.min(dom, daysInMonth(m))).padStart(2, '0')}`;
    if (day > to) break;
    if (day >= from && day >= dtstart) out.push(day);
  }
  return out;
}

function nextDue(r: RecurringItem, after: string): string | null {
  return occurrences(r.rrule, r.dtstart, after, addDays(after, 800), 1)[0] ?? null;
}

// ───────────────────────────────────────────────────────────────────────────── debt simulation (§15.5)

interface DebtIn {
  name: string;
  balance: number;
  apr: number;
  min: number;
}

interface SimResult {
  months: number;
  totalInterest: number;
  schedule: { month: string; balances: Record<string, string>; payments: Record<string, string> }[];
}

function orderFor(strategy: string, debts: DebtIn[], custom?: string[]): DebtIn[] {
  const list = debts.slice();
  if (strategy === 'snowball') return list.sort((a, b) => a.balance - b.balance);
  if (strategy === 'hybrid') {
    const small = list.slice().sort((a, b) => a.balance - b.balance).slice(0, 2);
    const rest = list.filter((d) => !small.includes(d)).sort((a, b) => b.apr - a.apr || a.balance - b.balance);
    return [...small, ...rest];
  }
  if (strategy === 'custom' && custom?.length) {
    return list.sort((a, b) => {
      const ia = custom.indexOf(a.name);
      const ib = custom.indexOf(b.name);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }
  return list.sort((a, b) => b.apr - a.apr || a.balance - b.balance);
}

function simulate(debts: DebtIn[], strategy: string, extra: number, startMonth: string, custom?: string[], minimumsOnly = false): SimResult {
  const order = orderFor(strategy, debts, custom).map((d) => d.name);
  const bal = new Map(debts.map((d) => [d.name, d.balance]));
  const info = new Map(debts.map((d) => [d.name, d]));
  let totalInterest = 0;
  const schedule: SimResult['schedule'] = [];
  let months = 0;
  const totalMin = debts.reduce((s, d) => s + d.min, 0);
  for (; months < 600; months++) {
    if ([...bal.values()].every((b) => b <= 0)) break;
    const payments: Record<string, number> = {};
    // interest accrues before payment
    for (const [n, b] of bal) {
      if (b <= 0) continue;
      const i = Math.round((b * (info.get(n)!.apr / 100)) / 12);
      totalInterest += i;
      bal.set(n, b + i);
    }
    let pool = minimumsOnly ? 0 : extra;
    // freed-up minimums roll into the pool
    for (const d of debts) if ((bal.get(d.name) ?? 0) <= 0 && !minimumsOnly) pool += d.min;
    for (const d of debts) {
      const b = bal.get(d.name) ?? 0;
      if (b <= 0) continue;
      // The minimum, as Rust `debt::simulate` pays it (a minimum below the interest never clears the debt).
      const p = Math.min(b, d.min);
      bal.set(d.name, b - p);
      payments[d.name] = p;
      if (p < d.min && !minimumsOnly) pool += d.min - p;
      if (p > d.min && !minimumsOnly) pool -= p - d.min;
    }
    if (!minimumsOnly) {
      for (const n of order) {
        if (pool <= 0) break;
        const b = bal.get(n) ?? 0;
        if (b <= 0) continue;
        const p = Math.min(b, pool);
        bal.set(n, b - p);
        payments[n] = (payments[n] ?? 0) + p;
        pool -= p;
      }
    }
    const month = addMonths(startMonth, months);
    schedule.push({
      month,
      balances: Object.fromEntries([...bal].map(([n, b]) => [n, centsToStr(Math.max(0, b))])),
      payments: Object.fromEntries(Object.entries(payments).map(([n, p]) => [n, centsToStr(p)])),
    });
    void totalMin;
  }
  return { months, totalInterest, schedule };
}

export function debtPlan(input: { debts: { name: string; balance: string; aprPct: string; minPayment: string }[]; strategy: string; extraMonthly: string; order?: string[]; startMonth: string }) {
  const debts: DebtIn[] = input.debts
    .map((d, i) => ({ name: d.name || `Debt ${i + 1}`, balance: Math.abs(strToCents(d.balance)), apr: Number(d.aprPct) || 0, min: Math.abs(strToCents(d.minPayment)) }))
    .filter((d) => d.balance > 0);
  const extra = Math.max(0, strToCents(input.extraMonthly));
  const start = /^\d{4}-\d{2}/.test(input.startMonth ?? '') ? input.startMonth.slice(0, 7) : iso(Date.now()).slice(0, 7);
  const base = simulate(debts, 'avalanche', 0, start, undefined, true);
  const names = ['avalanche', 'snowball', 'hybrid', ...(input.order?.length ? ['custom'] : [])];
  const results = new Map<string, SimResult>();
  for (const s of names) results.set(s, simulate(debts, s, extra, start, input.order));
  const req = results.get(input.strategy) ?? results.get('avalanche')!;
  return {
    strategies: [
      ...names.map((s) => {
        const r = results.get(s)!;
        return { strategy: s, months: r.months, payoffDate: addMonths(start, Math.max(0, r.months - 1)), totalInterest: centsToStr(r.totalInterest), interestSavedVsMin: centsToStr(Math.max(0, base.totalInterest - r.totalInterest)) };
      }),
      { strategy: 'minimum', months: base.months, payoffDate: addMonths(start, Math.max(0, base.months - 1)), totalInterest: centsToStr(base.totalInterest), interestSavedVsMin: '0.00' },
    ],
    schedule: req.schedule,
  };
}

/**
 * The debts Money HQ plans with (Rust `ledger_debts`, the Debt tab's `debtInputs`): open liability accounts owing
 * money today, at their minimum payment, or `max($25, 2% of the balance)` without one ({@link debtMinimum}).
 */
export function debtsOf(l: Ledger, today: string): DebtIn[] {
  return l.accounts
    .filter((a) => DEBT_TYPES.has(a.type) && !a.closed)
    .map((a) => {
      const owed = Math.max(0, -balanceAt(l, a.id, today));
      return { name: a.name, balance: owed, apr: a.apr ?? 0, min: Math.round(debtMinimum(a.minPayment / 100, owed / 100) * 100) };
    })
    .filter((d) => d.balance > 0);
}

// ───────────────────────────────────────────────────────────────────────────── import (§15.2)

interface ImportSession {
  id: Id;
  setId: Id;
  format: 'csv' | 'ofx' | 'qfx' | 'qif';
  columns: string[];
  rows: string[][];
  fingerprint: string;
  fileName: string;
  /** FITID column index for OFX/QFX. */
  fitid?: number;
  /** OFX/QFX `<LEDGERBAL>` per statement section (mirrors Rust `ParsedStatement::closing_balance`). */
  ledger?: OfxLedger[];
  /** QIF `C` (cleared status) text per row, aligned with `rows`. */
  qifCleared?: string[];
  createdAt: number;
}

interface OfxLedger {
  acctId: string;
  /** cents */
  balance: number;
  asOf?: string;
  currency?: string;
  maxDate?: string;
}

interface ProfileRec {
  id: Id;
  setId: Id;
  name: string;
  fingerprint: string;
  mapping: ImportMapping;
  accountId?: Id;
}

const sessions = new WeakMap<object, Map<Id, ImportSession>>();
function sessionsOf(ctx: MockCtx): Map<Id, ImportSession> {
  let m = sessions.get(ctx.db);
  if (!m) sessions.set(ctx.db, (m = new Map()));
  return m;
}
const profiles = (ctx: MockCtx) => ctx.db.table<ProfileRec>('fin_profiles');
const rulesTable = (ctx: MockCtx) => ctx.db.table<Rule & { setId: Id }>('fin_rules');

function parseCsv(textIn: string): string[][] {
  const textS = textIn.replace(/^﻿/, '');
  const firstLine = textS.split(/\r?\n/, 1)[0] ?? '';
  const delims = [',', ';', '\t', '|'];
  const delim = delims.map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < textS.length; i++) {
    const ch = textS[i];
    if (quoted) {
      if (ch === '"') {
        if (textS[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && textS[i + 1] === '\n') i++;
      row.push(cell.trim());
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

function parseOfx(textS: string): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  const blocks = textS.split(/<STMTTRN>/i).slice(1);
  const tag = (b: string, name: string) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(b);
    return m ? m[1].trim() : '';
  };
  for (const b of blocks) {
    const dt = tag(b, 'DTPOSTED');
    const date = dt.length >= 8 ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}` : dt;
    rows.push([date, tag(b, 'TRNAMT'), tag(b, 'NAME') || tag(b, 'PAYEE'), tag(b, 'MEMO'), tag(b, 'FITID'), tag(b, 'TRNTYPE')]);
  }
  return { columns: ['Date', 'Amount', 'Payee', 'Memo', 'FITID', 'Type'], rows };
}

/** `<LEDGERBAL>` of each statement section (`<STMTRS>` / `<CCSTMTRS>`), with the section's account and currency. */
function parseOfxLedgers(textS: string): OfxLedger[] {
  const tag = (b: string, name: string) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(b);
    return m ? m[1].trim() : '';
  };
  const ymd = (dt: string) => (/^\d{8}/.test(dt) ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}` : undefined);
  const out: OfxLedger[] = [];
  for (const sec of textS.split(/<(?:CC)?STMTRS>/i).slice(1)) {
    const lb = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<\/(?:CC)?STMTRS>|$)/i.exec(sec);
    if (!lb) continue;
    const bal = parseAmount(tag(lb[1], 'BALAMT'), false);
    if (bal === null) continue;
    const dates = sec
      .split(/<STMTTRN>/i)
      .slice(1)
      .map((b) => ymd(tag(b, 'DTPOSTED')))
      .filter((d): d is string => !!d)
      .sort();
    out.push({ acctId: tag(sec, 'ACCTID'), balance: bal, asOf: ymd(tag(lb[1], 'DTASOF')), currency: tag(sec, 'CURDEF') || undefined, maxDate: dates[dates.length - 1] });
  }
  return out;
}

/** Whether row `idx` of an import is cleared at the bank (see `finance_import_commit`). */
function importCleared(s: ImportSession, idx: number): boolean {
  if (s.format === 'ofx' || s.format === 'qfx') return true;
  if (s.format === 'qif') return qifCleared(s.qifCleared?.[idx]);
  return false;
}

/** QIF cleared-status text the bank has cleared (`*`, `c`, `X`, `R`); mirrors Rust `import::qif_cleared`. */
function qifCleared(flag: string | undefined): boolean {
  return ['*', 'c', 'C', 'x', 'X', 'R', 'r'].includes((flag ?? '').trim());
}

function parseQif(textS: string): { columns: string[]; rows: string[][]; cleared: string[] } {
  const rows: string[][] = [];
  const cleared: string[] = [];
  let cur: Record<string, string> = {};
  const push = () => {
    if (!(cur.D || cur.T)) return;
    rows.push([cur.D ?? '', cur.T ?? cur.U ?? '', cur.P ?? '', cur.M ?? '', cur.N ?? '']);
    cleared.push(cur.C ?? '');
  };
  for (const line of textS.split(/\r?\n/)) {
    if (!line || line.startsWith('!')) continue;
    if (line.startsWith('^')) {
      push();
      cur = {};
      continue;
    }
    cur[line[0]] = line.slice(1).trim();
  }
  push();
  return { columns: ['Date', 'Amount', 'Payee', 'Memo', 'Number'], rows, cleared };
}

function fingerprintOf(cols: string[]): string {
  // sha256 in Rust; a stable FNV-1a over the normalised headers is enough for the mock.
  const s = cols.map((c) => c.trim().toLowerCase()).join('\u001f');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'D MMM YYYY', "MM/DD'YY", 'excel'] as const;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseDate(raw: string, fmt: string): string | null {
  const s = raw.trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ok = (y: number, m: number, d: number) => (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);
  let m: RegExpExecArray | null;
  switch (fmt) {
    case 'YYYY-MM-DD':
      m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
      return m ? ok(+m[1], +m[2], +m[3]) : null;
    case 'MM/DD/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
      return m ? ok(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]) : null;
    case 'DD/MM/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
      return m ? ok(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]) : null;
    case 'DD.MM.YYYY':
      m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
      return m ? ok(+m[3], +m[2], +m[1]) : null;
    case 'D MMM YYYY':
      m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]+(\d{4})$/.exec(s);
      return m ? ok(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]) : null;
    case "MM/DD'YY":
      m = /^(\d{1,2})\/\s?(\d{1,2})'(\d{2})$/.exec(s);
      return m ? ok(2000 + +m[3], +m[1], +m[2]) : null;
    case 'excel': {
      const n = Number(s);
      if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
      return iso(Date.UTC(1899, 11, 30) + n * DAY + 12 * 3_600_000);
    }
    default:
      return null;
  }
}

function detectDateFormat(values: string[]): { format: string; ambiguous: boolean } {
  const vals = values.filter(Boolean);
  const fits: string[] = [];
  for (const f of DATE_FORMATS) {
    const parsed = vals.map((v) => parseDate(v, f));
    if (!parsed.length || parsed.some((p) => p === null)) continue;
    let out = 0;
    for (let i = 1; i < parsed.length; i++) if ((parsed[i] as string) < (parsed[i - 1] as string)) out++;
    let back = 0;
    for (let i = 1; i < parsed.length; i++) if ((parsed[i] as string) > (parsed[i - 1] as string)) back++;
    if (Math.min(out, back) <= Math.max(1, parsed.length * 0.05)) fits.push(f);
  }
  return { format: fits[0] ?? 'YYYY-MM-DD', ambiguous: fits.includes('MM/DD/YYYY') && fits.includes('DD/MM/YYYY') };
}

/** Amount text → cents (§15.2: thousands, decimal comma, (45.00), trailing minus, CR/DR). */
export function parseAmount(raw: string, decimalComma: boolean): number | null {
  let s = raw.trim().replace(/[−–]/g, '-').replace(/\s/g, '');
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/CR$/i.test(s)) s = s.slice(0, -2);
  else if (/DR$/i.test(s)) {
    sign = -sign;
    s = s.slice(0, -2);
  }
  if (s.endsWith('-')) {
    sign = -sign;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/[^\d.,]/g, '');
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!s || !Number.isFinite(n)) return null;
  return sign * Math.round(n * 100);
}

const PAYEE_RX = [
  /^(POS|DEBIT|PURCHASE|CHECKCARD|ACH|RECURRING|CARD PURCHASE)\s+/i,
  /^(SQ \*|TST\* |SP \*|PAYPAL \*|PP\*)/i,
  /[X*]{4,}\d{4}/gi,
  /#\d{3,}/g,
  /\s+\d{2}\/\d{2}(\/\d{2,4})?/g,
  // City + state: one city word (the spec's greedy form also ate merchant words, e.g. "GREENLEAF MARKET OAKLAND CA").
  /\s+[A-Z][A-Z.'-]+\s+[A-Z]{2}$/,
];

export function normalizePayee(raw: string): string {
  let s = raw.trim();
  for (let pass = 0; pass < 2; pass++) for (const rx of PAYEE_RX) s = s.replace(rx, ' ').trim();
  s = s.replace(/\b(DEBIT|DEPOSIT|CREDIT|AUTOPAY|PPD ID.*|INV \d+|ONLINE PAYMENT TO|ONLINE TRANSFER TO)\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = raw.trim();
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 2 && /\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\b(Llc|Inc|Co)\b/g, (x) => (x === 'Llc' ? 'LLC' : x));
}

function jaroWinkler(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  if (s1 === s2) return 1;
  const md = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    for (let j = Math.max(0, i - md); j < Math.min(s2.length, i + md + 1); j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3;
  let p = 0;
  while (p < 4 && s1[p] === s2[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

function guessMapping(columns: string[], rows: string[][]): ImportMapping {
  const find = (...names: RegExp[]) => {
    for (const rx of names) {
      const i = columns.findIndex((c) => rx.test(c));
      if (i >= 0) return i;
    }
    return undefined;
  };
  const mapping: ImportMapping = { invert: false, decimalComma: false };
  mapping.date = find(/^(transaction |posted |posting |booking )?date$/i, /date/i);
  mapping.amount = find(/^amount$/i, /amount|betrag|montant/i);
  mapping.debit = find(/debit|withdrawal|money out|paid out/i);
  mapping.credit = find(/credit|deposit|money in|paid in/i);
  if (mapping.debit !== undefined && mapping.credit !== undefined && mapping.amount === undefined) {
    /* split columns */
  } else {
    if (mapping.amount === undefined) mapping.amount = columns.findIndex((_, i) => rows.slice(0, 10).every((r) => parseAmount(r[i] ?? '', false) !== null && /\d/.test(r[i] ?? '')));
    if (mapping.amount !== undefined && mapping.amount < 0) mapping.amount = undefined;
    if (mapping.amount !== undefined) {
      mapping.debit = undefined;
      mapping.credit = undefined;
    }
  }
  mapping.payee = find(/payee|description|merchant|name|details|narrative/i);
  mapping.memo = find(/memo|note|reference|category/i);
  mapping.balance = find(/balance/i);
  if (mapping.memo === mapping.payee) mapping.memo = undefined;
  if (mapping.date === undefined) mapping.date = columns.findIndex((_, i) => rows.slice(0, 5).every((r) => DATE_FORMATS.some((f) => parseDate(r[i] ?? '', f))));
  if (mapping.date !== undefined && mapping.date < 0) mapping.date = undefined;
  const amtCol = mapping.amount ?? mapping.debit;
  if (amtCol !== undefined) {
    const vals = rows.map((r) => r[amtCol] ?? '').filter(Boolean);
    mapping.decimalComma = vals.length > 0 && vals.filter((v) => /\d+,\d{2}$/.test(v)).length / vals.length >= 0.8;
  }
  if (mapping.date !== undefined) mapping.dateFormat = detectDateFormat(rows.map((r) => r[mapping.date!] ?? '')).format;
  return mapping;
}

interface ParsedRow {
  idx: number;
  date: string | null;
  amount: number | null;
  rawPayee: string;
  payee: string;
  memo: string;
  fitid?: string;
}

/** Signed amount of one raw row under `mapping`, in cents (after `invert`). */
function rowAmount(r: string[], mapping: ImportMapping): number | null {
  let amount: number | null = null;
  if (mapping.amount !== undefined) amount = parseAmount(r[mapping.amount] ?? '', mapping.decimalComma);
  else if (mapping.debit !== undefined || mapping.credit !== undefined) {
    const d = mapping.debit !== undefined ? parseAmount(r[mapping.debit] ?? '', mapping.decimalComma) : null;
    const c = mapping.credit !== undefined ? parseAmount(r[mapping.credit] ?? '', mapping.decimalComma) : null;
    amount = d || c ? (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0) : null;
  }
  if (amount !== null && mapping.invert) amount = -amount;
  return amount;
}

function parseRows(s: ImportSession, mapping: ImportMapping): ParsedRow[] {
  const fmt = mapping.dateFormat ?? 'YYYY-MM-DD';
  return s.rows.map((r, idx) => {
    const date = mapping.date !== undefined ? parseDate(r[mapping.date] ?? '', fmt) : null;
    const amount = rowAmount(r, mapping);
    const rawPayee = mapping.payee !== undefined ? (r[mapping.payee] ?? '') : '';
    return { idx, date, amount, rawPayee, payee: normalizePayee(rawPayee || 'Unknown payee'), memo: mapping.memo !== undefined ? (r[mapping.memo] ?? '') : '', fitid: s.fitid !== undefined ? r[s.fitid] : undefined };
  });
}

function importKey(accountId: Id, date: string, amount: number, payee: string, occ: number): string {
  const s = `${accountId}|${date}|${amount}|${payee.toLowerCase()}|${occ}`;
  let h = 0xcbf29ce4;
  let h2 = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x0100019d) >>> 0;
  }
  return `csv:${h.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

// ── rules

function matchCondition(c: RuleCondition, ctx: { payee: string; raw: string; memo: string; amount: number; accountId: Id | null; accountName: string; date: string }): boolean {
  const v = c.value;
  const str = (f: string) => f.toLowerCase();
  const field = (() => {
    switch (c.field) {
      case 'payee':
        return ctx.payee;
      case 'raw':
        return ctx.raw;
      case 'memo':
        return ctx.memo;
      case 'amount':
        return ctx.amount / 100;
      case 'abs_amount':
        return Math.abs(ctx.amount) / 100;
      case 'account':
        return ctx.accountName;
      case 'day_of_month':
        return Number(ctx.date.slice(8, 10));
    }
  })();
  if (c.field === 'account' && typeof v === 'string' && ctx.accountId === v) return c.op === 'equals' || c.op === 'in';
  switch (c.op) {
    case 'contains':
      return str(String(field)).includes(str(String(v ?? '')));
    case 'equals':
      return typeof field === 'number' ? field === Number(v) : str(String(field)) === str(String(v ?? ''));
    case 'starts_with':
      return str(String(field)).startsWith(str(String(v ?? '')));
    case 'regex': {
      const src = String(v ?? '');
      if (src.length > 262_144) return false;
      try {
        return new RegExp(src, 'i').test(String(field));
      } catch {
        return false;
      }
    }
    case 'lt':
      return Number(field) < Number(v);
    case 'gt':
      return Number(field) > Number(v);
    case 'between': {
      const [lo, hi] = Array.isArray(v) ? v.map(Number) : [NaN, NaN];
      return Number(field) >= lo && Number(field) <= hi;
    }
    case 'in':
      return Array.isArray(v) && v.map((x) => str(String(x))).includes(str(String(field)));
    default:
      return false;
  }
}

function rulesOf(ctx: MockCtx, setId: Id): Rule[] {
  const set = finSets(ctx).get(setId);
  if (set) ensureDefaultRules(ctx, set);
  return rulesTable(ctx)
    .filter((r) => r.setId === setId)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .map(({ setId: _s, ...r }) => r);
}

function applyRules(rules: Rule[], tx: { payee: string; raw: string; memo: string; amount: number; accountId: Id | null; accountName: string; date: string }): { rule?: Rule; then: Rule['then'] } {
  const merged: Rule['then'] = {};
  let first: Rule | undefined;
  for (const r of rules) {
    if (!r.when.all.length || !r.when.all.every((c) => matchCondition(c, tx))) continue;
    first ??= r;
    Object.assign(merged, Object.fromEntries(Object.entries(r.then).filter(([, v]) => v !== undefined)));
    if (!r.continue) break;
  }
  return { rule: first, then: merged };
}

function learnedCategory(l: Ledger, payee: string): Id | undefined {
  const counts = new Map<Id, number>();
  const p = payee.toLowerCase();
  for (const t of l.txns) {
    if (!t.categoryId || t.payee.toLowerCase() !== p) continue;
    counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
  }
  let best: Id | undefined;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

function emitChanged(ctx: MockCtx, dbId: Id): void {
  ctx.services.get<DbApi>('db.api')?.emitChanged(ctx, dbId);
}

function updateTxnRows(ctx: MockCtx, updates: { id: Id; values: Record<Id, CellValue | null> }[]): void {
  const api = ctx.services.get<DbApi>('db.api');
  for (let i = 0; i < updates.length; i += 500) {
    if (api) api.updateRows(ctx, updates.slice(i, i + 500));
  }
}

// ───────────────────────────────────────────────────────────────────────────── handlers

function blockColor(c: string): import('../../types').BlockColor {
  const allowed = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
  return (allowed.includes(c) ? c : 'gray') as import('../../types').BlockColor;
}

const money = (cents: number, cur = 'USD') => ({ amount: centsToStr(cents), currency: cur });

export const handlers: MockHandlers = {
  finance_overview: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const today = ctx.clock.today();
    const month = validMonth(ctx, req.month);
    const cur = set.baseCurrency;
    const nw = netWorthAt(ctx, l, today, undefined, cur);
    const nw30 = netWorthAt(ctx, l, addDays(today, -30), undefined, cur);
    const b = computeBudget(ctx, l, month > today.slice(0, 7) ? month : today.slice(0, 7));
    const cm = b.cats.get(month) ?? new Map<Id, CatMonth>();
    const pc = pace(ctx, month);
    const lines = l.categories
      .filter((c) => !c.income)
      .map((c) => {
        const v = cm.get(c.id) ?? { assigned: 0, activity: 0, available: 0, rollover: 0 };
        return { categoryId: c.id, name: c.name, group: c.group, color: blockColor(c.color), assigned: money(v.assigned, cur), activity: money(v.activity, cur), available: money(v.available, cur), pace: pc };
      });
    const ess = essentialMonthly(l, today);
    const ef = emergencyBalance(l, today);
    // `debtFreeDate` (Rust `debt_free_date`): minimums only, starting next month (this month's payments are in the
    // ledger) — the Overview tile, the `debt_free_date` metric and its KPI tile all show this one date.
    const debts = debtsOf(l, today);
    const debtStart = addMonths(today.slice(0, 7), 1);
    const plan = debts.length ? simulate(debts, 'avalanche', 0, debtStart, undefined, true) : null;
    const upcoming: { rowId: Id; name: string; due: string; amount: { amount: string; currency: string }; autopay: boolean }[] = [];
    for (const r of l.recurring) {
      if (r.kind === 'income') continue;
      const due = nextDue(r, today);
      if (due && due <= addDays(today, 14)) upcoming.push({ rowId: r.id, name: r.name, due, amount: money(r.amount, cur), autopay: r.autopay });
    }
    upcoming.sort((a, b2) => (a.due < b2.due ? -1 : 1));
    const spendable = lines.filter((x) => x.group !== 'Savings & Debt').reduce((s, x) => s + strToCents(x.available.amount), 0);
    return {
      netWorth: money(nw.assets - nw.liabilities, cur),
      netWorthDelta30d: money(nw.assets - nw.liabilities - (nw30.assets - nw30.liabilities), cur),
      assets: money(nw.assets, cur),
      liabilities: money(nw.liabilities, cur),
      investments: nw.investments !== null ? money(nw.investments, cur) : undefined,
      efBalance: money(ef, cur),
      essentialMonthly: money(ess, cur),
      toBeAssigned: set.method === 'zero_based' || set.method === 'envelopes' ? money(b.tba.get(month) ?? 0, cur) : undefined,
      // Like Rust `budget::compute`: zero-based and envelope budgets report To be assigned instead.
      leftToSpend: set.method === 'zero_based' || set.method === 'envelopes' ? undefined : money(spendable, cur),
      savingsRate3m: savingsRate3m(l, today),
      efMonths: ess > 0 ? ef / ess : 0,
      debtFreeDate: plan && plan.months < 600 ? addMonths(debtStart, plan.months - 1) : undefined,
      budget: lines,
      upcoming: upcoming.slice(0, 12),
      uncategorized: spendRows(l).filter((t) => !t.categoryId && !isTransfer(l, t)).length,
      asOf: ctx.clock.now(),
    };
  },

  /**
   * Rust `networth_series`, rule for rule: one {@link netWorthAt} point per month (`YYYY-MM`) — month ends, the
   * current month as of today, so the last point is the overview's net worth — from the first ledger or Portfolio
   * transaction (before the ledger starts, accounts sit at their opening balance); Net worth snapshot rows the user
   * entered (any source but Auto/Automatic) override past months; the current month is always live.
   */
  finance_networth_series: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const today = ctx.clock.today();
    const cur = set.baseCurrency;
    const span: Record<string, number> = { '6m': 6, '1y': 12, '3y': 36, '5y': 60 };
    const n = span[req.range];
    if (n === undefined && req.range !== 'all') ctx.fail('INVALID', 'Range must be 6m, 1y, 3y, 5y or all', { field: 'range' });
    const to = today.slice(0, 7);
    const firsts = [l.txns.reduce<string | null>((m, t) => (m === null || t.date < m ? t.date : m), null), portfolioFirstDate(ctx)].filter((d): d is string => !!d);
    const earliest = firsts.length ? firsts.reduce((a, b2) => (a < b2 ? a : b2)).slice(0, 7) : to;
    const from = n !== undefined ? addMonths(to, -(n - 1)) : earliest;
    const points = new Map<string, NetWorthPoint>();
    for (let m = from > earliest ? from : earliest; m <= to; m = addMonths(m, 1)) {
      points.set(m, netWorthAt(ctx, l, m === to ? today : `${m}-${String(daysInMonth(m)).padStart(2, '0')}`, undefined, cur));
    }
    for (const [m, p] of manualSnapshots(ctx, set)) if (m >= from && m < to) points.set(m, p);
    const months = [...points.keys()].sort();
    const at = (m: string) => points.get(m)!;
    return {
      t: months,
      assets: months.map((m) => at(m).assets / 100),
      liabilities: months.map((m) => at(m).liabilities / 100),
      net: months.map((m) => (at(m).assets - at(m).liabilities) / 100),
      currency: cur,
    };
  },

  finance_spending_breakdown: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const from = req.from?.slice(0, 10);
    const to = req.to?.slice(0, 10);
    if (!from || !to || from > to) ctx.fail('INVALID', 'Choose a valid date range', { field: 'from' });
    const len = dayDiff(from, to) + 1;
    const prevFrom = addDays(from, -len);
    const prevTo = addDays(from, -1);
    const keyOf = (t: Txn): { key: string; label: string; color?: string } => {
      const c = t.categoryId ? l.catById.get(t.categoryId) : undefined;
      switch (req.by) {
        case 'group':
          return { key: c?.group ?? 'Uncategorised', label: c?.group ?? 'Uncategorised' };
        case 'payee':
          return { key: t.payee.toLowerCase(), label: t.payee };
        case 'account': {
          const a = t.accountId ? l.acctById.get(t.accountId) : undefined;
          return { key: a?.id ?? 'none', label: a?.name ?? 'No account' };
        }
        default:
          return { key: c?.id ?? 'uncategorized', label: c?.name ?? 'Uncategorised', color: c?.color };
      }
    };
    const sum = (a: string, b2: string) => {
      const m = new Map<string, { label: string; color?: string; amount: number }>();
      for (const t of spendRows(l)) {
        if (t.date < a || t.date > b2 || isTransfer(l, t) || t.amount >= 0) continue;
        const c = t.categoryId ? l.catById.get(t.categoryId) : undefined;
        if (c?.income) continue;
        const k = keyOf(t);
        const e = m.get(k.key) ?? { label: k.label, color: k.color, amount: 0 };
        e.amount += -t.amount;
        m.set(k.key, e);
      }
      return m;
    };
    const curr = sum(from, to);
    const prev = sum(prevFrom, prevTo);
    const total = [...curr.values()].reduce((s, e) => s + e.amount, 0);
    return [...curr.entries()]
      .sort((a, b2) => b2[1].amount - a[1].amount)
      .map(([key, e]) => {
        const p = prev.get(key)?.amount;
        return { key, label: e.label, color: e.color, amount: centsToStr(e.amount), pct: total ? e.amount / total : 0, deltaPct: p ? (e.amount - p) / p : undefined };
      });
  },

  finance_cashflow_sankey: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const month = validMonth(ctx, req.month);
    const inMonth = (t: Txn) => t.date.slice(0, 7) === month;
    const incomeBy = new Map<string, number>();
    const spendBy = new Map<string, Map<string, number>>();
    let saved = 0;
    let invested = 0;
    let debt = 0;
    for (const t of spendRows(l)) {
      if (!inMonth(t)) continue;
      const acct = t.accountId ? l.acctById.get(t.accountId) : undefined;
      if (isTransfer(l, t)) {
        // Outflows from on-budget accounts to savings / investments / debts are where the surplus went.
        if (t.amount >= 0 || !acct?.onBudget) continue;
        const twin = t.transferId ? l.txnById.get(t.transferId) : undefined;
        const dest = twin?.accountId ? l.acctById.get(twin.accountId) : undefined;
        if (!dest || dest.type === 'checking' || dest.type === 'credit_card') continue;
        if (dest.type === 'investment') invested += -t.amount;
        else if (DEBT_TYPES.has(dest.type)) debt += -t.amount;
        else saved += -t.amount;
        continue;
      }
      if (acct && acct.type === 'investment') continue;
      const c = t.categoryId ? l.catById.get(t.categoryId) : undefined;
      if (c?.income || (!c && t.amount > 0)) {
        const k = c?.name ?? 'Other income';
        incomeBy.set(k, (incomeBy.get(k) ?? 0) + t.amount);
        continue;
      }
      if (t.amount >= 0) continue;
      const g = c?.group ?? 'Uncategorised';
      const name = c?.name ?? 'Uncategorised';
      let gm = spendBy.get(g);
      if (!gm) spendBy.set(g, (gm = new Map()));
      gm.set(name, (gm.get(name) ?? 0) + -t.amount);
    }
    const income = [...incomeBy.values()].reduce((s, v) => s + v, 0);
    const spent = [...spendBy.values()].reduce((s, m) => s + [...m.values()].reduce((a, v) => a + v, 0), 0);
    const leftover = Math.max(0, income - spent - saved - invested - debt);
    const nodes: { name: string; color?: string }[] = [];
    const links: { source: number; target: number; value: number }[] = [];
    const node = (name: string, color?: string) => {
      nodes.push({ name, color });
      return nodes.length - 1;
    };
    const incomeSources = [...incomeBy.entries()].sort((a, b2) => b2[1] - a[1]);
    const hub = node('Income');
    for (const [name, v] of incomeSources) links.push({ source: node(name), target: hub, value: v / 100 });
    const groupOrder = ['Bills', 'Everyday', 'Fun', 'Uncategorised'];
    for (const g of [...groupOrder, ...[...spendBy.keys()].filter((k) => !groupOrder.includes(k))]) {
      const gm = spendBy.get(g);
      if (!gm) continue;
      const total = [...gm.values()].reduce((s, v) => s + v, 0);
      if (total <= 0) continue;
      const gi = node(g);
      links.push({ source: hub, target: gi, value: total / 100 });
      const cats = [...gm.entries()].sort((a, b2) => b2[1] - a[1]);
      const top = cats.slice(0, 4);
      const rest = cats.slice(4).reduce((s, [, v]) => s + v, 0);
      for (const [name, v] of top) links.push({ source: gi, target: node(name), value: v / 100 });
      if (rest > 0) links.push({ source: gi, target: node(`Other ${g.toLowerCase()}`), value: rest / 100 });
    }
    const savingsTotal = saved + invested + debt + leftover;
    if (savingsTotal > 0) {
      const si = node('Saved & paid down');
      links.push({ source: hub, target: si, value: savingsTotal / 100 });
      if (saved) links.push({ source: si, target: node('Savings'), value: saved / 100 });
      if (invested) links.push({ source: si, target: node('Investing'), value: invested / 100 });
      if (debt) links.push({ source: si, target: node('Debt payments'), value: debt / 100 });
      if (leftover) links.push({ source: si, target: node('Left over'), value: leftover / 100 });
    }
    return { nodes, links };
  },

  finance_budget_month: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const month = validMonth(ctx, req.month);
    const today = ctx.clock.today().slice(0, 7);
    const b = computeBudget(ctx, l, month > today ? month : today);
    const cm = b.cats.get(month) ?? new Map<Id, CatMonth>();
    return {
      categories: l.categories
        .filter((c) => !c.income)
        .map((c) => {
          const v = cm.get(c.id) ?? { assigned: 0, activity: 0, available: 0, rollover: 0 };
          return { categoryId: c.id, assigned: centsToStr(v.assigned), activity: centsToStr(v.activity), available: centsToStr(v.available), rollover: centsToStr(v.rollover) };
        }),
      toBeAssigned: centsToStr(b.tba.get(month) ?? 0),
      currency: set.baseCurrency,
    };
  },

  finance_budget_assign: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const month = validMonth(ctx, req.month);
    if (!l.catById.has(req.categoryId)) ctx.fail('NOT_FOUND', 'Category not found', { field: 'categoryId' });
    const n = Number(String(req.amount).replace(/[−]/g, '-'));
    if (!Number.isFinite(n) || Math.abs(n) > 1e10) ctx.fail('INVALID', 'Enter an amount', { field: 'amount' });
    budgets(ctx).put({ id: `${set.id}|${month}|${req.categoryId}`, setId: set.id, month, categoryId: req.categoryId, assigned: Math.round(n * 100) });
    const today = ctx.clock.today().slice(0, 7);
    const b = computeBudget(ctx, readLedger(ctx, set), month > today ? month : today);
    ctx.services.get<(id: Id | null, item: string) => void>('lifeapp.checklist.tick')?.(set.instanceId, 'budget');
    return { available: centsToStr(b.cats.get(month)?.get(req.categoryId)?.available ?? 0), toBeAssigned: centsToStr(b.tba.get(month) ?? 0) };
  },

  finance_import_start: async (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const file = ctx.grants.read(req.grantId);
    if (file.size > 25 * 1024 * 1024) ctx.fail('TOO_LARGE', 'Statements over 25 MB are not supported');
    const buf = await file.text();
    const head = buf.slice(0, 400).trimStart();
    const lower = file.name.toLowerCase();
    let format: ImportSession['format'] = 'csv';
    if (/^OFXHEADER:\s*100/i.test(head) || /<OFX>/i.test(head.slice(0, 400))) format = lower.endsWith('.qfx') ? 'qfx' : 'ofx';
    else if (/^<\?xml/i.test(head) && /<\?OFX/i.test(buf.slice(0, 600))) format = lower.endsWith('.qfx') ? 'qfx' : 'ofx';
    else if (/^!Type:/i.test(head)) format = 'qif';
    let columns: string[];
    let rows: string[][];
    let fitid: number | undefined;
    let ledger: OfxLedger[] | undefined;
    let qifC: string[] | undefined;
    if (format === 'ofx' || format === 'qfx') {
      ({ columns, rows } = parseOfx(buf));
      fitid = 4;
      ledger = parseOfxLedgers(buf);
    } else if (format === 'qif') ({ columns, rows, cleared: qifC } = parseQif(buf));
    else {
      const all = parseCsv(buf);
      if (!all.length) ctx.fail('INVALID', 'That file has no rows');
      const first = all[0];
      const looksHeader = first.some((c) => /[a-z]/i.test(c)) && !first.some((c) => DATE_FORMATS.some((f) => parseDate(c, f)));
      columns = looksHeader ? first.map((c, i) => c || `Column ${i + 1}`) : first.map((_, i) => `Column ${i + 1}`);
      rows = looksHeader ? all.slice(1) : all;
    }
    if (rows.length > 100_000) ctx.fail('TOO_LARGE', 'At most 100,000 rows per import');
    if (!rows.length) ctx.fail('INVALID', 'No transactions found in that file');
    const fingerprint = fingerprintOf(columns);
    const prof = profiles(ctx).find((p) => p.setId === set.id && p.fingerprint === fingerprint);
    const mapping = prof ? prof.mapping : guessMapping(columns, rows);
    const l = readLedger(ctx, set);
    const accountGuess =
      prof?.accountId ??
      l.accounts.find((a) => lower.includes(a.name.toLowerCase().split(' ')[0]) || lower.includes(a.type.replace('_', '')) || (a.type === 'credit_card' && /card|visa|amex|master/.test(lower)))?.id ??
      l.accounts.find((a) => a.type === 'checking')?.id;
    const id = ctx.id();
    sessionsOf(ctx).set(id, { id, setId: set.id, format, columns, rows, fingerprint, fileName: file.name, fitid, ledger, qifCleared: qifC, createdAt: ctx.clock.now() });
    return {
      importId: id,
      format,
      columns,
      sample: rows.slice(0, 8),
      mappingGuess: mapping,
      profileMatch: prof ? { id: prof.id, name: prof.name } : undefined,
      accountGuess,
      rowCount: rows.length,
      encoding: 'utf-8',
    };
  },

  finance_import_preview: (req, ctx) => {
    const s = sessionsOf(ctx).get(req.importId);
    if (!s) ctx.fail('NOT_FOUND', 'This import expired — choose the file again');
    const set = finSets(ctx).require(s!.setId);
    const l = readLedger(ctx, set);
    if (!l.acctById.has(req.accountId)) ctx.fail('INVALID', 'Choose an account', { field: 'accountId' });
    return previewRows(ctx, l, s!, req.mapping, req.accountId).result;
  },

  finance_import_commit: async (req, ctx) => {
    const s = sessionsOf(ctx).get(req.importId);
    if (!s) ctx.fail('NOT_FOUND', 'This import expired — choose the file again');
    const set = finSets(ctx).require(s!.setId);
    const l = readLedger(ctx, set);
    const acct = l.acctById.get(req.accountId);
    if (!acct) ctx.fail('INVALID', 'Choose an account', { field: 'accountId' });
    const { result: preview, keys } = previewRows(ctx, l, s!, req.mapping, req.accountId);
    const skip = new Set(req.skip ?? []);
    const R = l.roles.txn;
    const parsed = parseRows(s!, req.mapping);
    const total = preview.rows.length;
    let inserted = 0;
    let skipped = 0;
    let transfersLinked = 0;
    const rulesUsed = new Map<Id, number>();
    const rows = ctx.db.table<RowRecord>('db_rows');
    for (let k = 0; k < preview.rows.length; k++) {
      const pr = preview.rows[k];
      if (k % 25 === 0) {
        (ctx as MockCallCtx).checkCancelled?.();
        (ctx as MockCallCtx).progress?.(k, total, 'Importing transactions');
        await ctx.sleep(8);
      }
      if (skip.has(pr.idx) || pr.duplicateOf) {
        skipped++;
        continue;
      }
      const o = req.overrides?.[pr.idx] ?? {};
      const raw = parsed[pr.idx];
      const values: Record<Id, CellValue> = {
        [l.primary.txn]: V.text(o.payee ?? pr.payee),
        [R['txn.date']]: V.date(pr.date),
        [R['txn.amount']]: V.money(strToCents(pr.amount), acct!.currency),
        [R['txn.account']]: V.rel([acct!.id]),
        [R['txn.raw']]: V.text(pr.rawPayee),
        // Same rule as Rust `finance_import_commit`: OFX/QFX rows are bank-posted (cleared); QIF follows its `C`
        // field; CSV carries no status, so rows stay uncleared until the user reconciles. Source is always
        // "import" (a rule's category is provenance, not source) and every imported row starts unreviewed.
        [R['txn.import_id']]: V.text(keys.get(pr.idx) ?? `import:${s!.id}:${pr.idx}`),
      };
      if (R['txn.cleared']) values[R['txn.cleared']] = V.status(importCleared(s!, pr.idx) ? 'cleared' : 'uncleared');
      if (R['txn.source']) values[R['txn.source']] = V.sel('import');
      if (R['txn.reviewed']) values[R['txn.reviewed']] = V.check(false);
      if (raw?.memo) values[R['txn.memo']] = V.text(raw.memo);
      const cat = o.categoryId ?? pr.categoryId;
      if (cat && l.catById.has(cat)) values[R['txn.category']] = V.rel([cat]);
      if (pr.transferPair && R['txn.transfer']) values[R['txn.transfer']] = V.rel([pr.transferPair]);
      const row = createRow(ctx, set.dbs.txns, { values, silent: true });
      if (pr.transferPair && R['txn.transfer'] && rows.has(pr.transferPair)) {
        rows.update(pr.transferPair, (x) => void (x.values[R['txn.transfer']] = V.rel([row.id])));
        transfersLinked++;
      }
      if (pr.ruleId) rulesUsed.set(pr.ruleId, (rulesUsed.get(pr.ruleId) ?? 0) + 1);
      inserted++;
    }
    for (const [rid, n] of rulesUsed) if (rulesTable(ctx).has(rid)) rulesTable(ctx).update(rid, (r) => void (r.timesApplied += n));
    if (req.saveProfileAs?.trim()) {
      const existing = profiles(ctx).find((p) => p.setId === set.id && p.fingerprint === s!.fingerprint);
      const rec: ProfileRec = { id: existing?.id ?? ctx.id(), setId: set.id, name: req.saveProfileAs.trim().slice(0, 120), fingerprint: s!.fingerprint, mapping: req.mapping, accountId: acct!.id };
      profiles(ctx).put(rec);
    }
    (ctx as MockCallCtx).progress?.(total, total, 'Done');
    emitChanged(ctx, set.dbs.txns);
    sessionsOf(ctx).delete(s!.id);
    ctx.services.get<(id: Id | null, item: string) => void>('lifeapp.checklist.tick')?.(set.instanceId, 'import');
    return { inserted, skipped, transfersLinked };
  },

  finance_rules_list: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    ensureDefaultRules(ctx, set);
    return rulesOf(ctx, set.id);
  },

  finance_rule_upsert: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const r = req.rule;
    if (!r || typeof r.name !== 'string') ctx.fail('INVALID', 'A rule needs a name', { field: 'name' });
    if (!Array.isArray(r.when?.all) || !r.when.all.length) ctx.fail('INVALID', 'Add at least one condition', { field: 'when' });
    for (const c of r.when.all) {
      if (c.op === 'regex') {
        try {
          new RegExp(String(c.value ?? ''));
        } catch {
          ctx.fail('INVALID', 'That regular expression is not valid', { field: 'when' });
        }
      }
    }
    const existing = r.id ? rulesTable(ctx).get(r.id) : undefined;
    const rec = {
      id: existing?.id ?? ctx.id(),
      setId: set.id,
      name: r.name.trim().slice(0, 200) || 'Untitled rule',
      priority: Number.isFinite(r.priority) ? r.priority : (rulesOf(ctx, set.id).at(-1)?.priority ?? 0) + 10,
      when: { all: r.when.all.slice(0, 20) },
      then: r.then ?? {},
      continue: !!r.continue,
      timesApplied: existing?.timesApplied ?? 0,
    };
    rulesTable(ctx).put(rec);
    const { setId: _s, ...out } = rec;
    return out;
  },

  finance_rule_delete: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const r = rulesTable(ctx).get(req.id);
    if (!r || r.setId !== set.id) ctx.fail('NOT_FOUND', 'Rule not found');
    rulesTable(ctx).delete(req.id);
  },

  finance_rules_apply: async (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const rules = rulesOf(ctx, set.id);
    const R = l.roles.txn;
    const updates: { id: Id; values: Record<Id, CellValue | null> }[] = [];
    const sample: { rowId: Id; from?: string; to: string }[] = [];
    const used = new Map<Id, number>();
    const list = spendRows(l).filter((t) => !isTransfer(l, t) && (req.scope === 'all' || !t.categoryId));
    for (let k = 0; k < list.length; k++) {
      const t = list[k];
      if (k % 100 === 0) {
        (ctx as MockCallCtx).checkCancelled?.();
        (ctx as MockCallCtx).progress?.(k, list.length, req.dryRun ? 'Checking rules' : 'Applying rules');
        await ctx.sleep(4);
      }
      const acct = t.accountId ? l.acctById.get(t.accountId) : undefined;
      const { rule, then } = applyRules(rules, { payee: t.payee, raw: t.raw, memo: t.memo, amount: t.amount, accountId: t.accountId, accountName: acct?.name ?? '', date: t.date });
      if (!rule) continue;
      const values: Record<Id, CellValue | null> = {};
      if (then.categoryId && then.categoryId !== t.categoryId && l.catById.has(then.categoryId)) values[R['txn.category']] = V.rel([then.categoryId]);
      if (then.renamePayee && then.renamePayee !== t.payee) values[l.primary.txn] = V.text(then.renamePayee);
      if (!Object.keys(values).length) continue;
      used.set(rule.id, (used.get(rule.id) ?? 0) + 1);
      updates.push({ id: t.id, values });
      if (sample.length < 12) {
        const from = t.categoryId ? l.catById.get(t.categoryId)?.name : undefined;
        const to = then.categoryId ? (l.catById.get(then.categoryId)?.name ?? '') : (then.renamePayee ?? '');
        sample.push({ rowId: t.id, from, to: `${t.payee} → ${to}` });
      }
    }
    if (!req.dryRun && updates.length) {
      updateTxnRows(ctx, updates);
      for (const [rid, n] of used) rulesTable(ctx).update(rid, (r) => void (r.timesApplied += n));
    }
    (ctx as MockCallCtx).progress?.(list.length, list.length);
    return { changed: updates.length, sample };
  },

  finance_recurring_detect: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    return detectRecurring(ctx, l);
  },

  finance_recurring_accept: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    const RR = l.roles.rec;
    const created: Id[] = [];
    const rrules: Record<string, (d: string) => string> = {
      weekly: (d) => `FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${d}T12:00:00`).getDay()]}`,
      biweekly: (d) => `FREQ=WEEKLY;INTERVAL=2;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${d}T12:00:00`).getDay()]}`,
      monthly: (d) => `FREQ=MONTHLY;BYMONTHDAY=${Number(d.slice(8, 10))}`,
      quarterly: (d) => `FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=${Number(d.slice(8, 10))}`,
      yearly: (d) => `FREQ=YEARLY;BYMONTHDAY=${Number(d.slice(8, 10))}`,
    };
    for (const it of req.items ?? []) {
      const due = /^\d{4}-\d{2}-\d{2}$/.test(it.nextDue) ? it.nextDue : ctx.clock.today();
      const cand = detectRecurring(ctx, l).find((c) => c.payee === it.payee);
      const lastTxn = cand ? l.txnById.get(cand.rowIds[cand.rowIds.length - 1]) : undefined;
      const values: Record<Id, CellValue> = {
        [l.primary.rec]: V.text(it.payee.slice(0, 200)),
        [RR['rec.amount']]: V.money(strToCents(it.amount.amount), it.amount.currency),
        [RR['rec.schedule']]: V.rec((rrules[it.cadence] ?? rrules.monthly)(due), due),
        [RR['rec.kind']]: V.sel(it.kind),
        [RR['rec.autopay']]: V.check(it.kind === 'subscription'),
        [RR['rec.reminder_days']]: V.num(3),
      };
      if (lastTxn?.accountId) values[RR['rec.account']] = V.rel([lastTxn.accountId]);
      if (lastTxn?.categoryId) values[RR['rec.category']] = V.rel([lastTxn.categoryId]);
      created.push(createRow(ctx, set.dbs.recurring, { values, silent: true }).id);
    }
    if (created.length) emitChanged(ctx, set.dbs.recurring);
    return { created };
  },

  finance_debt_plan: (req) => debtPlan(req),

  finance_forecast: (req, ctx) => {
    const set = resolveSet(ctx, req.instanceId);
    const l = readLedger(ctx, set);
    return forecast(ctx, l, Math.max(7, Math.min(365, Math.round(req.horizonDays || 90))), !!req.band);
  },

  finance_amortization: (req, ctx) => {
    const P = strToCents(req.principal);
    const r = Number(req.annualRatePct) / 100 / 12;
    const n = Math.round(req.termMonths);
    if (!(P > 0) || !Number.isFinite(r) || r < 0 || !(n > 0) || n > 1200) ctx.fail('INVALID', 'Check the loan amount, rate and term');
    const extra = Math.max(0, strToCents(req.extraMonthly ?? '0'));
    const pay = r === 0 ? Math.round(P / n) : Math.round((P * r) / (1 - (1 + r) ** -n));
    let bal = P;
    let interest = 0;
    const rows: { n: number; date: string; payment: string; principal: string; interest: string; balance: string }[] = [];
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.startDate) ? req.startDate : ctx.clock.today();
    for (let k = 1; k <= n && bal > 0; k++) {
      const i = Math.round(bal * r);
      const p = Math.min(bal, pay + extra - i);
      bal -= p;
      interest += i;
      rows.push({ n: k, date: `${addMonths(start.slice(0, 7), k - 1)}-${start.slice(8, 10)}`, payment: centsToStr(p + i), principal: centsToStr(p), interest: centsToStr(i), balance: centsToStr(Math.max(0, bal)) });
    }
    return { payment: centsToStr(pay), totalInterest: centsToStr(interest), payoffDate: rows[rows.length - 1]?.date ?? start, rows };
  },

  finance_goal_plan: (req, ctx) => {
    const target = strToCents(req.target);
    const current = strToCents(req.current);
    const today = ctx.clock.today();
    const by = /^\d{4}-\d{2}-\d{2}/.test(req.by) ? req.by.slice(0, 10) : today;
    const months = Math.max(0, (Number(by.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(by.slice(5, 7)) - Number(today.slice(5, 7)));
    const r = (Number(req.annualYieldPct) || 0) / 100 / 12;
    let monthly: number;
    if (months <= 0) monthly = Math.max(0, target - current);
    else if (r > 0) {
      const g = (1 + r) ** months;
      monthly = Math.max(0, ((target - current * g) * r) / (g - 1));
    } else monthly = Math.max(0, (target - current) / months);
    return { monthlyRequired: centsToStr(Math.ceil(monthly)), onTrack: current >= target };
  },
};

function previewRows(ctx: MockCtx, l: Ledger, s: ImportSession, mapping: ImportMapping, accountId: Id) {
  const rows = parseRows(s, mapping);
  const rules = rulesOf(ctx, l.set.id);
  const acct = l.acctById.get(accountId)!;
  const existingIds = new Map<string, Id>();
  for (const t of l.txns) if (t.importId) existingIds.set(t.importId, t.id);
  const inAccount = l.txns.filter((t) => t.accountId === accountId && !t.splitParent);
  const others = l.txns.filter((t) => t.accountId && t.accountId !== accountId && !t.transferId && !t.splitParent);
  const occ = new Map<string, number>();
  const out: import('../../types').FinanceImportPreviewRow[] = [];
  const keys = new Map<number, string>();
  let duplicates = 0;
  let categorized = 0;
  const usedPairs = new Set<Id>();
  // Payee alias table (§15.2): a raw description seen before maps to the payee name and category used then.
  const alias = new Map<string, { payee: string; categoryId: Id | null }>();
  for (const t of l.txns) if (t.raw && !t.transferId) alias.set(normalizePayee(t.raw).toLowerCase(), { payee: t.payee, categoryId: t.categoryId ?? alias.get(normalizePayee(t.raw).toLowerCase())?.categoryId ?? null });
  for (const r of rows) {
    const known = alias.get(r.payee.toLowerCase());
    if (known) r.payee = known.payee;
    if (!r.date || r.amount === null) continue;
    const k = `${r.date}|${r.amount}|${r.payee.toLowerCase()}`;
    const n = (occ.get(k) ?? 0) + 1;
    occ.set(k, n);
    const exactKey = r.fitid ? `ofx:${accountId}:${r.fitid}` : importKey(accountId, r.date, r.amount, r.payee, n);
    keys.set(r.idx, exactKey);
    // Sample rows carry readable import ids: match those by (date, amount, payee) as well.
    let duplicateOf = existingIds.get(exactKey);
    if (!duplicateOf) duplicateOf = inAccount.find((t) => t.importId.startsWith('sample:') && t.date === r.date && t.amount === r.amount && (t.payee.toLowerCase() === r.payee.toLowerCase() || t.raw === r.rawPayee))?.id;
    let possibleDuplicate: Id | undefined;
    if (!duplicateOf) possibleDuplicate = inAccount.find((t) => t.amount === r.amount && Math.abs(dayDiff(t.date, r.date as string)) <= 3 && jaroWinkler(t.payee, r.payee) >= 0.9)?.id;
    let transferPair: Id | undefined;
    if (!duplicateOf) {
      const twin = others.find((t) => t.amount === -(r.amount as number) && !usedPairs.has(t.id) && Math.abs(dayDiff(t.date, r.date as string)) <= 3);
      if (twin) {
        transferPair = twin.id;
        usedPairs.add(twin.id);
      }
    }
    const { rule, then } = applyRules(rules, { payee: r.payee, raw: r.rawPayee, memo: r.memo, amount: r.amount, accountId, accountName: acct.name, date: r.date });
    let categoryId = then.categoryId;
    let confidence: 'rule' | 'learned' | 'none' = rule && categoryId ? 'rule' : 'none';
    const twinAcct = transferPair ? l.acctById.get(l.txnById.get(transferPair)?.accountId ?? '') : undefined;
    const payee = then.renamePayee ?? (twinAcct ? twinAcct.name : r.payee);
    if (!categoryId && !transferPair) {
      categoryId = learnedCategory(l, payee) ?? alias.get(r.payee.toLowerCase())?.categoryId ?? undefined;
      if (categoryId) confidence = 'learned';
    }
    if (duplicateOf) duplicates++;
    if (categoryId) categorized++;
    out.push({
      idx: r.idx,
      date: r.date,
      payee,
      rawPayee: r.rawPayee,
      amount: centsToStr(r.amount),
      categoryId: transferPair ? undefined : categoryId,
      confidence: transferPair ? 'none' : confidence,
      ruleId: rule?.id,
      duplicateOf,
      possibleDuplicate,
      transferPair,
    });
  }
  const statement = closingBalance(s, mapping, acct.name);
  return { result: { rows: out, newCount: out.filter((r) => !r.duplicateOf).length, duplicates, categorized, ...(statement ? { statement } : {}) }, keys };
}

/**
 * `FinanceImportPreview.statement`: the closing balance the file reports. Mirrors Rust
 * `ParsedStatement::closing_balance` — OFX: the section whose account number's last four digits appear in the
 * account name, else the only section with a balance; CSV: the balance column on the latest-dated row (last in file
 * order on ties); QIF: none.
 */
function closingBalance(s: ImportSession, mapping: ImportMapping, accountName: string): import('../../types').FinanceImportStatement | undefined {
  if (s.format === 'ofx' || s.format === 'qfx') {
    const with_ = s.ledger ?? [];
    const sec = with_.find((l) => l.acctId.length > 0 && accountName.includes(l.acctId.slice(-4))) ?? (with_.length === 1 ? with_[0] : undefined);
    if (!sec) return undefined;
    const asOf = sec.asOf ?? sec.maxDate;
    return { balance: centsToStr(sec.balance), ...(asOf ? { asOf } : {}), ...(sec.currency ? { currency: sec.currency } : {}), source: 'ofx' };
  }
  if (s.format === 'csv' && mapping.balance !== undefined) {
    const fmt = mapping.dateFormat ?? 'YYYY-MM-DD';
    let best: { date: string; bal: number } | undefined;
    for (const r of s.rows) {
      const date = mapping.date !== undefined ? parseDate(r[mapping.date] ?? '', fmt) : null;
      const bal = parseAmount(r[mapping.balance] ?? '', mapping.decimalComma);
      if (!date || bal === null) continue;
      // Rust drops rows without a valid amount before it looks at balances; do the same.
      if (rowAmount(r, mapping) === null) continue;
      if (!best || date >= best.date) best = { date, bal };
    }
    return best ? { balance: centsToStr(best.bal), asOf: best.date, source: 'csv' } : undefined;
  }
  return undefined;
}

const CADENCES: { cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'; days: number; tol: number }[] = [
  { cadence: 'weekly', days: 7, tol: 1 },
  { cadence: 'biweekly', days: 14, tol: 2 },
  { cadence: 'monthly', days: 30.44, tol: 3 },
  { cadence: 'quarterly', days: 91.31, tol: 7 },
  { cadence: 'yearly', days: 365.25, tol: 10 },
];

function detectRecurring(ctx: MockCtx, l: Ledger) {
  const groups = new Map<string, Txn[]>();
  for (const t of spendRows(l)) {
    if (isTransfer(l, t)) continue;
    const key = `${t.payee.toLowerCase()}|${t.amount < 0 ? '-' : '+'}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(t);
  }
  const known = l.recurring.map((r) => r.name.toLowerCase());
  const today = ctx.clock.today();
  const out: import('../../types').RecurringCandidate[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.date < b.date ? -1 : 1));
    const intervals: number[] = [];
    for (let i = 1; i < g.length; i++) intervals.push(dayDiff(g[i - 1].date, g[i].date));
    const med = intervals.slice().sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
    const cad = CADENCES.find((c) => Math.abs(med - c.days) <= c.tol);
    if (!cad) continue;
    if (g.length < (cad.cadence === 'yearly' ? 2 : 3)) continue;
    const amounts = g.map((t) => Math.abs(t.amount));
    const mean = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    const sd = Math.sqrt(amounts.reduce((s, v) => s + (v - mean) ** 2, 0) / amounts.length);
    const cv = mean ? sd / mean : 0;
    const fit = 1 - Math.min(1, intervals.reduce((s, v) => s + Math.min(1, Math.abs(v - cad.days) / (cad.tol * 2)), 0) / intervals.length);
    const amountFit = cv < 0.1 ? 1 - cv * 5 : 0.3;
    const confidence = 0.5 * fit + 0.3 * amountFit + 0.2 * Math.min(g.length / 6, 1);
    if (confidence < 0.6) continue;
    const last = g[g.length - 1];
    const prior = amounts.slice(-4, -1).sort((a, b) => a - b);
    const priorMed = prior[Math.floor(prior.length / 2)];
    const latest = Math.abs(last.amount);
    const priceChange = prior.length >= 2 && Math.abs(latest - priorMed) > Math.max(priorMed * 0.02, 50) ? { from: centsToStr(priorMed), to: centsToStr(latest) } : undefined;
    let next = addDays(last.date, Math.round(cad.days));
    while (next < today) next = addDays(next, Math.round(cad.days));
    const d = new Date(`${next}T12:00:00`).getDay();
    if (d === 6) next = addDays(next, 2);
    else if (d === 0) next = addDays(next, 1);
    if (known.some((k) => k.includes(last.payee.toLowerCase()) || last.payee.toLowerCase().includes(k.split(' · ')[0]))) continue;
    out.push({ payee: last.payee, cadence: cad.cadence, amount: money(last.amount, l.set.baseCurrency), nextDue: next, confidence: Math.round(confidence * 100) / 100, rowIds: g.map((t) => t.id), priceChange });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function forecast(ctx: MockCtx, l: Ledger, horizon: number, band: boolean) {
  const today = ctx.clock.today();
  const acct = l.accounts.filter((a) => a.type === 'checking' && !a.closed).sort((a, b) => (b.lowThreshold ?? 0) - (a.lowThreshold ?? 0))[0] ?? l.accounts.find((a) => a.onBudget);
  if (!acct) return { t: [], balance: [], breaches: [] };
  const start = balanceAt(l, acct.id, today);
  const end = addDays(today, horizon);
  const days: string[] = [];
  for (let d = addDays(today, 1); d <= end; d = addDays(d, 1)) days.push(d);
  // Scheduled flows for this account.
  const sched = new Map<string, { amount: number; name: string }[]>();
  for (const r of l.recurring) {
    if (r.accountId !== acct.id) continue;
    for (const d of occurrences(r.rrule, r.dtstart, addDays(today, 1), end)) {
      const list = sched.get(d) ?? [];
      list.push({ amount: r.amount, name: r.name });
      sched.set(d, list);
    }
  }
  // Card statement payments: average of the last three.
  const card = l.accounts.find((a) => a.type === 'credit_card');
  if (card) {
    const pays = l.txns.filter((t) => t.accountId === acct.id && t.transferId && l.txnById.get(t.transferId)?.accountId === card.id).slice(-3);
    if (pays.length) {
      const avg = Math.round(pays.reduce((s, t) => s + t.amount, 0) / pays.length);
      const dom = Number(pays[pays.length - 1].date.slice(8, 10));
      for (const d of occurrences(`FREQ=MONTHLY;BYMONTHDAY=${dom}`, pays[0].date, addDays(today, 1), end)) {
        const list = sched.get(d) ?? [];
        list.push({ amount: avg, name: `${card.name} payment` });
        sched.set(d, list);
      }
    }
  }
  // Discretionary daily spend (non-recurring, variable categories) over the trailing 90 days, from this account.
  const recurringPayees = new Set(l.recurring.map((r) => r.name.toLowerCase().split(' · ')[0]));
  const daily: number[] = [];
  for (let d = addDays(today, -90); d <= today; d = addDays(d, 1)) daily.push(0);
  const from = addDays(today, -90);
  for (const t of spendRows(l)) {
    if (t.accountId !== acct.id || t.date < from || t.date > today || t.amount >= 0 || isTransfer(l, t)) continue;
    const c = t.categoryId ? l.catById.get(t.categoryId) : undefined;
    if (c && c.group === 'Bills') continue;
    if ([...recurringPayees].some((p) => p && t.payee.toLowerCase().includes(p))) continue;
    daily[dayDiff(from, t.date)] += -t.amount;
  }
  const sorted = daily.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const mean = daily.reduce((s, v) => s + v, 0) / Math.max(1, daily.length);
  const disc = Math.round(median * 0.5 + mean * 0.5);
  const balance: number[] = [];
  let b = start;
  for (const d of days) {
    for (const f of sched.get(d) ?? []) b += f.amount;
    b -= disc;
    balance.push(b / 100);
  }
  let p10: number[] | undefined;
  let p90: number[] | undefined;
  if (band) {
    const rng = createRng(`emp:forecast:${l.set.id}:${today.slice(0, 7)}`);
    const N = 1000;
    const paths: Float64Array[] = [];
    for (let k = 0; k < N; k++) {
      const p = new Float64Array(days.length);
      let x = start;
      for (let i = 0; i < days.length; i++) {
        for (const f of sched.get(days[i]) ?? []) x += f.amount;
        x -= daily[Math.floor(rng.next() * daily.length)];
        p[i] = x;
      }
      paths.push(p);
    }
    p10 = [];
    p90 = [];
    const col = new Float64Array(N);
    for (let i = 0; i < days.length; i++) {
      for (let k = 0; k < N; k++) col[k] = paths[k][i];
      col.sort();
      p10.push(col[Math.floor(N * 0.1)] / 100);
      p90.push(col[Math.floor(N * 0.9)] / 100);
    }
  }
  const threshold = acct.lowThreshold ?? undefined;
  const breaches: { date: string; accountId: Id; amount: string; topOutflows: string[] }[] = [];
  if (threshold !== undefined) {
    const idx = balance.findIndex((v) => v * 100 < threshold);
    if (idx >= 0) {
      const windowFlows = days
        .slice(0, idx + 1)
        .flatMap((d) => sched.get(d) ?? [])
        .filter((f) => f.amount < 0)
        .sort((a, b2) => a.amount - b2.amount);
      const names = Array.from(new Set(windowFlows.map((f) => f.name))).slice(0, 3);
      breaches.push({ date: days[idx], accountId: acct.id, amount: centsToStr(Math.round(balance[idx] * 100)), topOutflows: names });
    }
  }
  return { t: days, balance, p10, p90, threshold: threshold !== undefined ? threshold / 100 : undefined, breaches };
}

function ensureDefaultRules(ctx: MockCtx, set: FinSet): void {
  if (rulesTable(ctx).find((r) => r.setId === set.id)) return;
  const meta = ctx.db.meta<Record<string, boolean>>('fin_rules_seeded') ?? {};
  if (meta[set.id]) return;
  const l = readLedger(ctx, set);
  const cat = (name: string) => l.categories.find((c) => c.name === name)?.id;
  const defs: { name: string; when: RuleCondition[]; then: Rule['then']; times: number }[] = [
    { name: 'Payroll deposits', when: [{ field: 'raw', op: 'contains', value: 'PAYROLL' }], then: { categoryId: cat('Paycheck') }, times: 13 },
    { name: 'Coffee and bakeries', when: [{ field: 'payee', op: 'regex', value: 'coffee|bakery|cafe' }], then: { categoryId: cat('Dining out') }, times: 41 },
    { name: 'Groceries', when: [{ field: 'payee', op: 'in', value: ['Greenleaf Market', 'Corner Grocer', 'FreshCo'] }], then: { categoryId: cat('Groceries') }, times: 52 },
    { name: 'Arcadia orders', when: [{ field: 'raw', op: 'starts_with', value: 'ARCADIA' }], then: { categoryId: cat('Shopping'), renamePayee: 'Arcadia Online' }, times: 9 },
    { name: 'Streaming & music', when: [{ field: 'payee', op: 'in', value: ['Streamflix', 'Melodia Music'] }], then: { categoryId: cat('Subscriptions') }, times: 12 },
    { name: 'Fuel stations', when: [{ field: 'raw', op: 'contains', value: 'FUEL' }, { field: 'abs_amount', op: 'lt', value: 120 }], then: { categoryId: cat('Fuel') }, times: 17 },
  ];
  defs.forEach((d, i) => {
    rulesTable(ctx).insert({ id: ctx.id(), setId: set.id, name: d.name, priority: (i + 1) * 10, when: { all: d.when }, then: d.then, continue: false, timesApplied: d.times });
  });
  ctx.db.setMeta('fin_rules_seeded', { ...meta, [set.id]: true });
}

// ───────────────────────────────────────────────────────────────────────────── services

export function setup(ctx: MockCtx): void {
  ctx.services.provide('finance.provision', (o: ProvisionOpts) => provisionMoneyHq(ctx, o));
  ctx.services.provide('portfolio.provision', (o: ProvisionOpts) => provisionPortfolio(ctx, o));
  ctx.services.provide('tax.provision', (o: ProvisionOpts & { year?: number }) => provisionTax(ctx, o));
  /** Cross-app figures for the tax estimator (§16.4 "Pulls figures from Money HQ income categories"). */
  ctx.services.provide('finance.incomeYtd', (instanceId: Id | null, year: number) => {
    const set = resolveSet(ctx, instanceId);
    const l = readLedger(ctx, set);
    const out: Record<string, number> = {};
    for (const t of spendRows(l)) {
      if (!t.date.startsWith(String(year)) || isTransfer(l, t)) continue;
      const c = t.categoryId ? l.catById.get(t.categoryId) : undefined;
      if (c?.income) out[c.name] = (out[c.name] ?? 0) + t.amount;
    }
    return out;
  });
}

export { DAY };
