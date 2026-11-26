/**
 * Life apps (§11.3 "Life apps", §16): catalogue, manifests, recommendations, plan preview, install (job, paced so the
 * wizard's checklist animates for real), instances, tune-up, detach / uninstall, metrics, insights, sample data and
 * checklists. Content generators live in `features/lifeapps/mock/*` (mock-only); planning in `features/lifeapps/engine`.
 *
 * Cross-mock services:
 *   'lifeapp.instances'        (workspaceId) → LifeAppInstance[]          (workspace_open)
 *   'lifeapp.api'              { list(), get(id), byApp(appId), install(...) }
 *   'lifeapp.hooks.<appId>'    provided BY other mocks (finance) to override metrics / insights
 * Seed refs: 'lifeapp.instance.<appId>', 'lifeapp.root.<appId>'.
 */
import { BackendError } from '../../errors';
import type { GenerationPlan, Id, LifeAppInstance, LifeAppSummary, PlanDiff, Insight } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import type { DbApi, RowRecord } from './db';
import { reminders } from './reminder';
import { MANIFESTS, manifestById } from '@/features/lifeapps/engine/manifests';
import { buildPlan, recommend, resolveAnswers } from '@/features/lifeapps/engine/plan';
import { createEnv, instancesTable, isoDay, lucide, type InstanceRecord, type Env } from '@/features/lifeapps/mock/env';
import { installLifeOs, sampleLifeOs } from '@/features/lifeapps/mock/lifeos';
import { habitItems, installHabits, refreshHabitStats, sampleLog } from '@/features/lifeapps/mock/habits';
import { installMoneyHq, installPortfolio, installTax } from '@/features/lifeapps/mock/finance';
import { installSheets, addWorkbook } from '@/features/lifeapps/mock/sheets';
import { insightsFor, metricsFor, rawMetrics } from '@/features/lifeapps/mock/metrics';
import { cellDate, cellText, c } from '@/features/lifeapps/mock/env';
import { iconOf } from '../lib/icons';
import { nextOccurrence } from '@/features/lifeapps/engine/recurrence';
import type { LifeAppHooks, Raw } from '@/features/lifeapps/mock/metrics';
import type { MockCallCtx } from '../ctx';
import { debtsOf, flows, handlers as financeHandlers, readLedger, resolveSet, savingsWindow } from './finance';
import { spendingBudget } from '../../figures';
import { handlers as portfolioHandlers } from './portfolio';

const dbApi = (ctx: MockCtx): DbApi => {
  const api = ctx.services.get<DbApi>('db.api');
  if (!api) throw new BackendError('INTERNAL', 'Databases are not available');
  return api;
};

const GENERATORS: Record<string, (env: Env) => Promise<void>> = {
  'life-os': installLifeOs,
  habits: installHabits,
  'spreadsheet-studio': installSheets,
  'money-hq': installMoneyHq,
  portfolio: installPortfolio,
  'tax-organizer': installTax,
};

function requireManifest(id: string) {
  const m = manifestById(id);
  if (!m) throw new BackendError('NOT_FOUND', 'That life app does not exist');
  return m;
}

function requireInstance(ctx: MockCtx, id: Id): InstanceRecord {
  const inst = instancesTable(ctx).get(id);
  if (!inst) throw new BackendError('NOT_FOUND', 'That life app is not installed');
  return inst;
}

function checkAnswers(answers: unknown): Record<string, unknown> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new BackendError('INVALID', 'Answers must be an object', { field: 'answers' });
  let size = 0;
  try {
    size = JSON.stringify(answers).length;
  } catch {
    throw new BackendError('INVALID', 'Answers are not serialisable', { field: 'answers' });
  }
  if (size > 256 * 1024) throw new BackendError('TOO_LARGE', 'Those answers are too large');
  return answers as Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────── checklist auto-ticks

function autoChecklist(ctx: MockCtx, inst: InstanceRecord): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  let raw: ReturnType<typeof rawMetrics> = {};
  try {
    raw = rawMetrics(ctx, dbApi(ctx), inst);
  } catch {
    return out;
  }
  const n = (k: string) => Number(raw[k]?.value ?? 0);
  const rows = (key: string) => {
    const id = inst.keyMap[key];
    if (!id) return 0;
    try {
      return dbApi(ctx).rows(ctx, id).length;
    } catch {
      return 0;
    }
  };
  switch (inst.appId) {
    case 'life-os':
      out.capture5 = rows('tasks') >= 5;
      out.inbox = rows('tasks') > 0 && n('inbox_count') === 0;
      out.project = rows('projects') > 0 && n('projects_without_next') < rows('projects');
      out.review = !!inst.lastReviewAt;
      break;
    case 'habits':
      out.checkin = n('today_done_pct') > 0;
      out.streak3 = n('best_streak') >= 3;
      break;
    case 'money-hq':
      out.import = rows('transactions') > 0;
      out.budget = rows('budgets') > 0;
      out.ef_goal = rows('goals') > 0;
      break;
    case 'portfolio':
      out.accounts = rows('inv_accounts') > 0;
      out.positions = rows('inv_txns') > 0;
      out.targets = rows('targets_db') > 0;
      break;
    case 'tax-organizer':
      out.status = true;
      out.docs = rows('documents_db') > 0;
      out.deduction = rows('deductions_db') > 0;
      break;
    default:
      break;
  }
  return out;
}

function toInstance(ctx: MockCtx, inst: InstanceRecord): LifeAppInstance {
  const m = manifestById(inst.appId);
  const auto = autoChecklist(ctx, inst);
  return {
    id: inst.id,
    appId: inst.appId,
    version: inst.version,
    rootPageId: inst.rootPageId,
    installedAt: inst.installedAt,
    upgradeAvailable: !!m && m.version !== inst.version,
    detached: inst.detached,
    checklist: (m?.checklist ?? []).map((c2) => ({ id: c2.id, label: c2.label, done: !!inst.checklist[c2.id] || !!auto[c2.id] })),
  };
}

function listInstances(ctx: MockCtx, workspaceId?: Id): LifeAppInstance[] {
  const order = MANIFESTS.map((m) => m.id);
  return instancesTable(ctx)
    .filter((i) => !workspaceId || i.workspaceId === workspaceId)
    .sort((a, b) => order.indexOf(a.appId) - order.indexOf(b.appId) || a.installedAt - b.installedAt)
    .map((i) => toInstance(ctx, i));
}

// ───────────────────────────────────────────────────────────────────────────── install

export interface InstallInput {
  appId: string;
  answers: Record<string, unknown>;
  mode: 'quick' | 'guided';
  disabledKeys: string[];
  workspaceId: Id;
  sampleData: boolean;
}

export async function installApp(
  ctx: MockCtx,
  input: InstallInput,
  progress: (done: number, total: number, label?: string) => void = () => undefined,
  checkCancelled: () => void = () => undefined,
): Promise<{ instanceId: Id; rootPageId: Id; created: Id[] }> {
  const m = requireManifest(input.appId);
  const answers = checkAnswers(input.answers);
  if (instancesTable(ctx).find((i) => i.appId === m.id && i.workspaceId === input.workspaceId && !i.detached)) {
    throw new BackendError('CONFLICT', `${m.title} is already set up. Use Tune-up to change it.`);
  }
  const today = isoDay(ctx.clock.now());
  const plan: GenerationPlan = buildPlan(m, answers, input.mode, input.disabledKeys ?? [], today);
  const resolved = resolveAnswers(m, answers, input.mode, today).answers;
  const total = plan.items.filter((i) => i.enabled).length + 2;
  progress(0, total, `Preparing ${m.title}`);

  const instanceId = ctx.id();
  const rootTitle = plan.items.find((i) => i.kind === 'dashboard')?.title ?? m.title;
  const root = ctx.pages.create({
    workspaceId: input.workspaceId,
    parentId: null,
    kind: 'app',
    title: rootTitle,
    icon: lucide(m.icon),
    appInstanceId: instanceId,
    templateKey: `${m.id}:root`,
    silent: ctx.seeding,
  });
  const inst: InstanceRecord = {
    id: instanceId,
    appId: m.id,
    version: m.version,
    workspaceId: input.workspaceId,
    rootPageId: root.id,
    installedAt: ctx.clock.now(),
    answers: resolved,
    mode: input.mode,
    keyMap: {},
    created: [root.id],
    detached: false,
    checklist: {},
    muted: {},
    sampleData: !!input.sampleData,
    touched: {},
  };
  const firstKey = plan.items.find((i) => i.kind === 'dashboard')?.key;
  if (firstKey) inst.keyMap[firstKey] = root.id;
  instancesTable(ctx).insert(inst);
  const env = createEnv({ ctx, db: dbApi(ctx), manifest: m, inst, answers: resolved, plan, sample: !!input.sampleData, progress, checkCancelled });
  try {
    await GENERATORS[m.id](env);
  } catch (e) {
    // Roll back: one transaction in Rust — here, remove whatever was created.
    ctx.pages.trash([root.id]);
    ctx.pages.purge([root.id]);
    reminders(ctx).deleteWhere((r) => r.instanceId === instanceId);
    instancesTable(ctx).delete(instanceId);
    throw e;
  }
  instancesTable(ctx).update(instanceId, (x) => {
    x.keyMap = inst.keyMap;
    x.created = inst.created;
  });
  if (!ctx.seeding) {
    ctx.pages.emitTree(input.workspaceId, [root.id, ...inst.created.filter((id) => ctx.pages.get(id))]);
  }
  progress(total, total, `${m.title} is ready`);
  return { instanceId, rootPageId: root.id, created: inst.created };
}

function removeInstanceContent(ctx: MockCtx, inst: InstanceRecord): void {
  const root = ctx.pages.get(inst.rootPageId);
  if (root) {
    if (!root.deletedAt) ctx.pages.trash([root.id]);
    ctx.pages.purge([root.id]);
  }
  for (const id of inst.created) {
    const p = ctx.pages.get(id);
    if (p) {
      if (!p.deletedAt) ctx.pages.trash([id]);
      ctx.pages.purge([id]);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────── tune-up

function changedSteps(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

function tuneupDiff(ctx: MockCtx, inst: InstanceRecord, answers: Record<string, unknown>): PlanDiff {
  const m = requireManifest(inst.appId);
  const today = isoDay(ctx.clock.now());
  const next = resolveAnswers(m, { ...inst.answers, ...answers }, 'guided', today).answers;
  const plan = buildPlan(m, next, 'guided', [], today);
  const changed = changedSteps(inst.answers, next);
  const add = plan.items.filter((i) => i.enabled && !inst.keyMap[i.key] && i.kind !== 'reminder' && i.kind !== 'rule' && i.kind !== 'recurring');
  const update: PlanDiff['update'] = [];
  const keep: string[] = [];
  const affects: Record<string, string[]> = {
    'life-os': ['areas_db:areas', 'tasks:priority', 'weekly:rituals'],
    habits: ['habits_db:pick', 'weekly:identity'],
    'spreadsheet-studio': ['workbook:intent'],
    'money-hq': ['categories:method', 'how:method', 'accounts:accounts', 'recurring:bills', 'goals:goals'],
    portfolio: ['targets_db:targets', 'ips:targets', 'ips:rebalance', 'inv_accounts:accounts'],
    'tax-organizer': ['documents_db:income', 'hub:jurisdiction', 'estimates_db:income'],
  };
  const map = affects[inst.appId] ?? [];
  for (const key of Object.keys(inst.keyMap)) {
    const fields = map.filter((s) => s.startsWith(`${key}:`)).map((s) => s.split(':')[1]).filter((f) => changed.includes(f));
    if (fields.length) update.push({ key, fields, conflict: fields.some((f) => (inst.touched[key] ?? []).includes(f)) });
    else keep.push(key);
  }
  if (inst.appId === 'spreadsheet-studio' && changed.includes('intent')) {
    const intent = String(next.intent ?? 'blank');
    add.push({ key: `workbook:${intent}`, kind: 'sheet', title: plan.items.find((i) => i.key === 'workbook')?.title ?? 'Workbook', optional: false, enabled: true });
    const idx = update.findIndex((u) => u.key === 'workbook');
    if (idx >= 0) update.splice(idx, 1);
  }
  return { add, update, keep };
}

async function applyTuneup(ctx: MockCtx, inst: InstanceRecord, answers: Record<string, unknown>, progress: (d: number, t: number, l?: string) => void): Promise<Id[]> {
  const m = requireManifest(inst.appId);
  const today = isoDay(ctx.clock.now());
  const next = resolveAnswers(m, { ...inst.answers, ...answers }, 'guided', today).answers;
  const diff = tuneupDiff(ctx, inst, answers);
  const db = dbApi(ctx);
  const changed: Id[] = [];
  const total = Math.max(1, diff.add.length + diff.update.length) + 1;
  let done = 0;
  const tick = async (label: string) => {
    done += 1;
    progress(done, total, label);
    if (!ctx.seeding) await ctx.sleep(160);
  };
  if (inst.appId === 'spreadsheet-studio') {
    for (const a of diff.add.filter((x) => x.key.startsWith('workbook:'))) {
      await tick(`Building ${a.title}`);
      changed.push(addWorkbook(ctx, inst, String(next.intent ?? 'blank'), (next.structure as string[]) ?? []));
    }
  }
  if (inst.appId === 'life-os' && inst.keyMap.areas_db) {
    const prev = new Set((inst.answers.areas as string[] | undefined) ?? []);
    const added = ((next.areas as string[] | undefined) ?? []).filter((a) => !prev.has(a));
    if (added.length) {
      await tick('Adding areas');
      const schema = db.schema(ctx, inst.keyMap.areas_db);
      const title = schema.properties.find((p) => p.type === 'title')!;
      for (const a of added) changed.push(db.createRow(ctx, inst.keyMap.areas_db, { values: { [title.id]: c.text(a)! } }).id);
    }
  }
  if (inst.appId === 'habits' && inst.keyMap.habits_db) {
    const prev = new Set(habitItems(inst.answers).map((h) => h.name));
    const added = habitItems(next).filter((h) => !prev.has(h.name));
    if (added.length) {
      await tick('Adding habits');
      const schema = db.schema(ctx, inst.keyMap.habits_db);
      const byName = Object.fromEntries(schema.properties.map((p) => [p.name, p]));
      const optId = (prop: string, name: string) => ((byName[prop]?.config.options as { id: Id; name: string }[] | undefined) ?? []).find((o) => o.name === name)?.id ?? null;
      for (const h of added) {
        const values: Record<Id, ReturnType<typeof c.check>> = {};
        values[byName.Name.id] = c.text(h.name)!;
        values[byName.Active.id] = c.check(true);
        values[byName.Started.id] = c.date(today)!;
        const sched = optId('Schedule', h.schedule === 'x_per_week' ? 'X per week' : h.schedule === 'weekdays' ? 'Weekdays' : 'Daily');
        if (sched) values[byName.Schedule.id] = { t: 'select', v: sched };
        changed.push(db.createRow(ctx, inst.keyMap.habits_db, { values, icon: iconOf(h.icon) }).id);
      }
    }
  }
  for (const u of diff.update) if (!changed.includes(inst.keyMap[u.key])) await tick(`Updating ${u.key.replace(/_/g, ' ')}`);
  instancesTable(ctx).update(inst.id, (x) => {
    x.answers = next;
  });
  progress(total, total, 'Tune-up complete');
  return changed;
}

// ───────────────────────────────────────────────────────────────────────────── reactive upkeep

/** Completing a recurring Life OS task spawns the next occurrence (§15.8); habit log changes refresh streak columns. */
function onDbChanged(ctx: MockCtx, databaseId: Id, rowIds: Id[] | undefined): void {
  const inst = instancesTable(ctx).find((i) => !i.detached && Object.values(i.keyMap).includes(databaseId));
  if (!inst) return;
  const db = dbApi(ctx);
  if (inst.appId === 'habits' && inst.keyMap.log === databaseId) {
    refreshHabitStats(ctx, db, inst);
    return;
  }
  if (inst.appId === 'life-os' && inst.keyMap.tasks === databaseId && rowIds?.length) {
    const schema = db.schema(ctx, databaseId);
    const role = (r: string) => schema.properties.find((p) => p.role === r);
    const status = role('task.status');
    const repeat = role('task.recurrence');
    const due = role('task.due');
    const completed = role('task.completed');
    if (!status) return;
    const doneOpt = ((status.config.options as { id: Id; name: string }[]) ?? []).find((o) => o.name === 'Done')?.id;
    const nextOpt = ((status.config.options as { id: Id; name: string }[]) ?? []).find((o) => o.name === 'Next')?.id;
    const spawned = ctx.db.table<{ id: Id }>('lifeapp_spawned');
    for (const row of db.rows(ctx, databaseId).filter((r) => rowIds.includes(r.id))) {
      const st = row.values[status.id];
      if (!st || st.t !== 'status' || st.v !== doneOpt) continue;
      const updates: Record<Id, ReturnType<typeof c.date>> = {};
      if (completed && !row.values[completed.id]) updates[completed.id] = c.date(isoDay(ctx.clock.now()));
      if (Object.keys(updates).length) db.updateRows(ctx, [{ id: row.id, values: updates as Record<Id, NonNullable<ReturnType<typeof c.date>>> }]);
      const rr = repeat ? row.values[repeat.id] : undefined;
      if (!rr || rr.t !== 'recurrence' || !rr.v || spawned.has(row.id)) continue;
      const base = (due && cellDate(row, due)?.start?.slice(0, 10)) || isoDay(ctx.clock.now());
      const from = rr.v.mode === 'completion' ? isoDay(ctx.clock.now()) : base;
      const nextDay = nextOccurrence(rr.v.rrule, from);
      if (!nextDay) continue;
      spawned.put({ id: row.id });
      const values: Record<Id, (typeof row.values)[string]> = {};
      for (const p of schema.properties) {
        if (p.id === completed?.id || p.type === 'created_time' || p.type === 'updated_time' || p.type === 'formula' || p.type === 'rollup') continue;
        if (row.values[p.id]) values[p.id] = row.values[p.id];
      }
      values[status.id] = { t: 'status', v: nextOpt ?? null };
      if (due) values[due.id] = c.date(nextDay)!;
      db.createRow(ctx, databaseId, { values, afterId: row.id });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────── finance metrics (default hooks)

const money = (m: { amount: string; currency: string } | undefined) => (m ? Number(m.amount) : 0);
const fmtM = (n: number, cur = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n).replace('-', '−');
  } catch {
    return `$${n.toFixed(0)}`;
  }
};
const pct = (f: number) => `${(f * 100).toFixed(Math.abs(f) < 0.1 ? 1 : 0)}%`;

function asMetrics(ctx: MockCtx, raw: Raw) {
  const asOf = ctx.clock.now();
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { value: v.value, display: v.display, math: v.math ?? [], asOf }]));
}

/**
 * Money HQ's headline metrics exactly as `finance_overview` computes them — the same metric set, values, "no
 * value" nulls and "Show math" lines as the desktop app's `FinanceMetrics` provider (Rust
 * `money_metric_overrides`), so KPI tiles, insights and editor KPI blocks never show a second formula. The mock's
 * extra `month_spend` / `month_budget` metrics use the shared {@link spendingBudget} (Home ring, Overview).
 */
const moneyHook: LifeAppHooks = {
  async metrics(ctx, instanceId) {
    const fn = financeHandlers.finance_overview;
    if (!fn) return null;
    const today = isoDay(ctx.clock.now());
    const o = await fn({ instanceId, month: today.slice(0, 7) }, ctx as MockCallCtx);
    const l = readLedger(ctx, resolveSet(ctx, instanceId));
    const cur = o.netWorth.currency;
    const f = fmtM;
    const nw = money(o.netWorth);
    const assets = money(o.assets);
    const liab = money(o.liabilities);
    const d30 = money(o.netWorthDelta30d);
    const none = (math: Raw[string]['math'] = []) => ({ value: null, display: '—', math });
    const nwMath = [
      { label: 'Assets', value: f(assets, cur), source: 'Accounts' },
      { label: 'Liabilities', value: f(-liab, cur), source: 'Accounts' },
      ...(o.investments ? [{ label: 'of which Portfolio', value: f(money(o.investments), cur), source: 'Portfolio' }] : []),
    ];
    const [from, to] = savingsWindow(today);
    const fl = flows(l, from, to);
    const rateMath = [
      { label: 'Income (3 months)', value: f(fl.income / 100, cur), source: 'Transactions' },
      { label: 'Spending (3 months)', value: f(fl.spending / 100, cur), source: 'Transactions' },
      { label: 'Savings rate', value: '(income − spending) ÷ income' },
    ];
    const ess = money(o.essentialMonthly);
    const ef = money(o.efBalance);
    const sb = spendingBudget(o.budget);
    const over = o.budget.filter((b) => money(b.available) < 0).length;
    const until = isoDay(ctx.clock.now() + 7 * 86_400_000);
    const bills = o.upcoming.filter((u) => u.due <= until);
    const billSum = bills.reduce((s2, u) => s2 + Math.abs(money(u.amount)), 0);
    const debtMath = [
      { label: 'Debts', value: String(debtsOf(l, today).length), source: 'Accounts' },
      { label: 'Paying', value: 'minimums only' },
    ];
    const budgetLine = (label: string, m: { amount: string; currency: string } | undefined) => (m ? { value: money(m), display: f(money(m), cur), math: [{ label, value: f(money(m), cur), source: 'Budget' }] } : none());
    const raw: Raw = {
      net_worth: { value: nw, display: f(nw, cur), math: nwMath },
      net_worth_delta_30d: { value: d30, display: f(d30, cur), math: [{ label: 'Net worth today', value: f(nw, cur), source: 'Accounts' }, { label: '30 days ago', value: f(nw - d30, cur), source: 'Accounts' }] },
      to_be_assigned: budgetLine('To be assigned', o.toBeAssigned),
      left_to_spend: budgetLine('Left to spend', o.leftToSpend),
      savings_rate_3m: fl.income > 0 ? { value: o.savingsRate3m, display: pct(o.savingsRate3m), math: rateMath } : none(rateMath),
      essential_monthly_spend: { value: ess, display: f(ess, cur), math: [{ label: 'Essentials / month (median of the last three 30-day periods)', value: f(ess, cur), source: 'Transactions' }] },
      ef_balance: { value: ef, display: f(ef, cur), math: [{ label: 'Emergency fund', value: f(ef, cur), source: 'Goals' }] },
      ef_months: { value: o.efMonths, display: `${o.efMonths.toFixed(1)} mo`, math: [{ label: 'Emergency fund', value: f(ef, cur), source: 'Goals' }, { label: 'Essentials / month', value: f(ess, cur), source: 'Transactions' }] },
      debt_free_date: o.debtFreeDate
        ? { value: o.debtFreeDate, display: new Date(`${o.debtFreeDate.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), math: debtMath }
        : none(debtMath),
      uncategorized_count: { value: o.uncategorized, display: String(o.uncategorized) },
      upcoming_bills_7d: { value: billSum, display: f(billSum, cur), math: bills.map((b) => ({ label: b.name, value: f(Math.abs(money(b.amount)), cur), source: b.due })) },
      upcoming_bills_7d_count: { value: bills.length, display: String(bills.length) },
      month_budget: { value: sb.assigned, display: f(sb.assigned, cur) },
      month_spend: { value: sb.spent, display: f(sb.spent, cur) },
      cat_over_count: { value: over, display: String(over) },
    };
    // Rust's manifest expression: To be assigned for zero-based / envelopes, else Left to spend — the overview
    // reports exactly one of the two.
    raw.budget_headline = o.toBeAssigned ? raw.to_be_assigned : raw.left_to_spend;
    return asMetrics(ctx, raw);
  },
};

const portfolioHook: LifeAppHooks = {
  async metrics(ctx, instanceId) {
    const fn = portfolioHandlers.portfolio_summary;
    if (!fn) return null;
    const s2 = await fn({ instanceId }, ctx as MockCallCtx);
    const cur = s2.totalValue.currency;
    const raw: Raw = {
      total_value: { value: money(s2.totalValue), display: fmtM(money(s2.totalValue), cur) },
      day_change: { value: money(s2.dayChange), display: fmtM(money(s2.dayChange), cur) },
      day_change_pct: { value: s2.dayChangePct, display: pct(s2.dayChangePct) },
      unrealized: { value: money(s2.unrealized), display: fmtM(money(s2.unrealized), cur) },
      div_ttm: { value: money(s2.divTtm), display: fmtM(money(s2.divTtm), cur) },
      div_fwd_12m: { value: money(s2.divFwd12m), display: fmtM(money(s2.divFwd12m), cur) },
      // portfolio drift is in percentage points (§15.7); metrics carry fractions
      max_drift: { value: s2.maxDrift / 100, display: `${s2.maxDrift.toFixed(1)} pp`, math: s2.allocation.map((a) => ({ label: a.assetClass, value: `${a.drift >= 0 ? '+' : '−'}${Math.abs(a.drift).toFixed(1)} pp`, source: 'Target allocation' })) },
      fees_per_year: { value: money(s2.feesPerYear), display: fmtM(money(s2.feesPerYear), cur) },
    };
    if (s2.xirrYtd !== undefined) raw.xirr_ytd = { value: s2.xirrYtd, display: pct(s2.xirrYtd) };
    if (s2.xirrAll !== undefined) raw.xirr_all = { value: s2.xirrAll, display: pct(s2.xirrAll) };
    return asMetrics(ctx, raw);
  },
};

let listening = new WeakSet<object>();

export function setup(ctx: MockCtx): void {
  ctx.services.provide('lifeapp.instances', (workspaceId: Id) => listInstances(ctx, workspaceId));
  // Finance mocks call this when their events happen (§16.1 checklist auto-tick).
  ctx.services.provide('lifeapp.checklist.tick', (instanceId: Id | null, itemId: string) => {
    if (!instanceId) return;
    const inst = instancesTable(ctx).get(instanceId);
    if (inst) instancesTable(ctx).update(inst.id, (x) => void (x.checklist = { ...x.checklist, [itemId]: true }));
  });
  if (!ctx.services.get('lifeapp.hooks.money-hq')) ctx.services.provide('lifeapp.hooks.money-hq', moneyHook);
  if (!ctx.services.get('lifeapp.hooks.portfolio')) ctx.services.provide('lifeapp.hooks.portfolio', portfolioHook);
  ctx.services.provide('lifeapp.api', {
    list: () => instancesTable(ctx).all(),
    get: (id: Id) => instancesTable(ctx).get(id),
    byApp: (appId: string) => instancesTable(ctx).find((i) => i.appId === appId && !i.detached),
    install: (input: InstallInput) => installApp(ctx, input),
  });
  if (!listening.has(ctx.events)) {
    listening.add(ctx.events);
    ctx.events.listen('db:changed', (e) => {
      try {
        onDbChanged(ctx, e.databaseId, e.rowIds);
      } catch (err) {
        console.error('[emp mock] life-app upkeep failed', err);
      }
    });
  }
}

/** Test hook: forget listeners between independent mock instances. */
export function __resetListeners(): void {
  listening = new WeakSet<object>();
}

// ───────────────────────────────────────────────────────────────────────────── handlers

export const handlers: MockHandlers = {
  lifeapp_list: (_req, ctx) => {
    const counts = new Map<string, number>();
    for (const i of instancesTable(ctx).all()) if (!i.detached) counts.set(i.appId, (counts.get(i.appId) ?? 0) + 1);
    return MANIFESTS.map(
      (m): LifeAppSummary => ({ id: m.id, version: m.version, title: m.title, tagline: m.tagline, icon: m.icon, color: m.color, category: m.category, estMinutes: m.estMinutes, installed: counts.get(m.id) ?? 0, v1: true }),
    );
  },
  lifeapp_manifest: (req) => requireManifest(req.id),
  lifeapp_recommend: (req) => {
    const m = requireManifest(req.appId);
    const step = m.steps.find((s) => s.id === req.stepId);
    if (!step) throw new BackendError('NOT_FOUND', 'Unknown step');
    const rec = recommend(m, req.stepId, checkAnswers(req.answers ?? {}));
    return rec ?? { value: step.default ?? null, why: step.why ?? 'Default starting point you can change later.', source: 'Default' };
  },
  lifeapp_preview: (req, ctx) => {
    const m = requireManifest(req.appId);
    return buildPlan(m, checkAnswers(req.answers ?? {}), req.mode === 'guided' ? 'guided' : 'quick', req.disabledKeys ?? [], isoDay(ctx.clock.now()));
  },
  lifeapp_install: async (req, ctx) =>
    installApp(ctx, { appId: req.appId, answers: req.answers ?? {}, mode: req.mode === 'guided' ? 'guided' : 'quick', disabledKeys: req.disabledKeys ?? [], workspaceId: req.workspaceId, sampleData: !!req.sampleData }, ctx.progress, ctx.checkCancelled),
  lifeapp_instances: (req, ctx) => listInstances(ctx, req.workspaceId),
  lifeapp_tuneup_preview: (req, ctx) => tuneupDiff(ctx, requireInstance(ctx, req.instanceId), checkAnswers(req.answers ?? {})),
  lifeapp_tuneup_apply: async (req, ctx) => {
    const inst = requireInstance(ctx, req.instanceId);
    if (inst.detached) throw new BackendError('CONFLICT', 'This app was detached; tune-ups no longer change its content');
    return { changed: await applyTuneup(ctx, inst, checkAnswers(req.answers ?? {}), ctx.progress) };
  },
  lifeapp_detach: (req, ctx) => {
    const inst = requireInstance(ctx, req.instanceId);
    instancesTable(ctx).update(inst.id, (x) => void (x.detached = true));
    reminders(ctx).deleteWhere((r) => r.instanceId === inst.id && !!r.everyMs);
  },
  lifeapp_uninstall: (req, ctx) => {
    const inst = requireInstance(ctx, req.instanceId);
    reminders(ctx).deleteWhere((r) => r.instanceId === inst.id);
    if (!req.keepContent) removeInstanceContent(ctx, inst);
    else {
      for (const id of [inst.rootPageId, ...inst.created]) {
        const p = ctx.pages.get(id);
        if (p && !p.deletedAt && p.appInstanceId === inst.id && p.kind !== 'app' && p.kind !== 'dashboard') ctx.pages.update(id, { appInstanceId: undefined });
      }
      const root = ctx.pages.get(inst.rootPageId);
      if (root && !root.deletedAt) {
        // Keep the content: lift the hub's children to the top level, then the (now empty) hub goes to Trash.
        for (const child of ctx.pages.children(root.id)) ctx.pages.move(child.id, null);
        ctx.pages.trash([root.id]);
      }
    }
    instancesTable(ctx).delete(inst.id);
  },
  lifeapp_metrics: async (req, ctx) => {
    const inst = requireInstance(ctx, req.instanceId);
    if ((req.names ?? []).length > 64) throw new BackendError('INVALID', 'Ask for at most 64 metrics');
    return metricsFor(ctx, dbApi(ctx), inst, req.names ?? []);
  },
  lifeapp_insights: async (req, ctx) => {
    const list = req.instanceId ? [requireInstance(ctx, req.instanceId)] : instancesTable(ctx).all();
    const out: Insight[] = [];
    for (const inst of list) {
      try {
        out.push(...(await insightsFor(ctx, dbApi(ctx), inst)));
      } catch (err) {
        console.error('[emp mock] insights failed for', inst.appId, err);
      }
    }
    const rank = { critical: 0, warn: 1, tip: 2, info: 3 } as const;
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  },
  lifeapp_insight_mute: (req, ctx) => {
    requireInstance(ctx, req.instanceId);
    if (req.until !== null && !Number.isFinite(req.until)) throw new BackendError('INVALID', 'Pick when to show it again');
    instancesTable(ctx).update(req.instanceId, (x) => void (x.muted = { ...x.muted, [req.ruleId]: req.until }));
  },
  lifeapp_sample_data: async (req, ctx) => {
    const inst = requireInstance(ctx, req.instanceId);
    const db = dbApi(ctx);
    const dbIds = Object.values(inst.keyMap).filter((id) => ctx.db.table<{ id: Id }>('db_databases').has(id));
    if (!req.on) {
      const rows = ctx.db.table<RowRecord>('db_rows');
      let n = 0;
      for (const id of dbIds) n += rows.deleteWhere((r) => r.databaseId === id && !!r.sample);
      for (const id of dbIds) db.emitChanged(ctx, id);
      instancesTable(ctx).update(inst.id, (x) => void (x.sampleData = false));
      return { rows: n };
    }
    if (inst.sampleData) return { rows: 0 };
    const before = dbIds.reduce((s2, id) => s2 + db.rows(ctx, id).length, 0);
    const m = requireManifest(inst.appId);
    const plan = buildPlan(m, inst.answers, 'guided', [], isoDay(ctx.clock.now()));
    const env = createEnv({ ctx, db, manifest: m, inst, answers: inst.answers, plan, sample: true, progress: () => undefined, checkCancelled: () => undefined });
    if (inst.appId === 'life-os') {
      const tasks = env.handle('tasks');
      const projects = env.handle('projects');
      const areasDb = env.handle('areas_db');
      const daily = env.handle('daily');
      if (tasks && projects && areasDb && daily) {
        const titleOf = (h: NonNullable<typeof areasDb>) => Object.values(h.props).find((p) => p.type === 'title');
        const areaIds: Record<string, Id> = {};
        for (const r of db.rows(ctx, areasDb.id)) areaIds[cellText(r, titleOf(areasDb))] = r.id;
        sampleLifeOs(env, { tasks, projects, areasDb, daily, goals: env.handle('goals'), resources: env.handle('resources'), areaIds, prioName: tasks.props.Quadrant ? 'Quadrant' : 'Priority' });
      }
    } else if (inst.appId === 'habits') {
      const log = env.handle('log');
      const habits = env.handle('habits_db');
      if (log && habits) {
        const items = habitItems(inst.answers);
        const title = Object.values(habits.props).find((p) => p.type === 'title');
        const rows = db.rows(ctx, habits.id).map((r) => ({ id: r.id, item: items.find((i) => i.name === cellText(r, title)) ?? { name: cellText(r, title), icon: 'lucide:sparkle', type: 'yes_no', schedule: 'daily' } }));
        sampleLog(env, log, rows);
        refreshHabitStats(ctx, db, inst);
      }
    }
    for (const id of dbIds) db.emitChanged(ctx, id);
    instancesTable(ctx).update(inst.id, (x) => void (x.sampleData = true));
    const after = dbIds.reduce((s2, id) => s2 + db.rows(ctx, id).length, 0);
    return { rows: Math.max(0, after - before) };
  },
  lifeapp_checklist_tick: (req, ctx) => {
    const inst = requireInstance(ctx, req.instanceId);
    const m = requireManifest(inst.appId);
    if (!m.checklist.some((x) => x.id === req.itemId)) throw new BackendError('NOT_FOUND', 'Unknown checklist item');
    instancesTable(ctx).update(inst.id, (x) => {
      x.checklist = { ...x.checklist, [req.itemId]: true };
      if (inst.appId === 'life-os' && req.itemId === 'review') x.lastReviewAt = ctx.clock.now();
    });
  },
};

export { listInstances };
