/**
 * Mock-only: life-app metrics (§16.1 "Metrics and the advisor") computed from the generated databases by role, and
 * advisor evaluation into ranked `Insight`s. Finance apps may be overridden by hooks the finance mocks register as
 * `ctx.services.provide('lifeapp.hooks.<appId>', { metrics, insights })`.
 */
import type { Id, Insight, InsightMath, LifeAppMetric, Property, Route, RowDTO } from '@/backend/types';
import type { MockCtx } from '@/backend/mock/ctx';
import type { DbApi } from '@/backend/mock/commands/db';
import { evalExpr, interpolate, test } from '../engine/expr';
import { manifestById } from '../engine/manifests';
import { streakStats, addDays } from '../engine/habitMath';
import { readHabits } from './habits';
import { cellBool, cellDate, cellNum, cellOpt, cellRel, cellText, DAY, isoDay, type InstanceRecord } from './env';

type MaybePromise<T> = T | Promise<T>;

export interface LifeAppHooks {
  metrics?: (ctx: MockCtx, instanceId: Id, names: string[]) => MaybePromise<Record<string, LifeAppMetric> | null | undefined>;
  insights?: (ctx: MockCtx, instanceId: Id) => MaybePromise<Insight[] | null | undefined>;
}

export type Raw = Record<string, { value: unknown; display: string; math?: InsightMath[] }>;

const fmtMoney = (n: number, cur = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n).replace('-', '−');
  } catch {
    return `$${n.toFixed(0)}`;
  }
};
const fmtPct = (f: number) => `${(f * 100).toFixed(Math.abs(f) < 0.1 ? 1 : 0)}%`;
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

interface Table {
  id: Id;
  rows: RowDTO[];
  role: (r: string, ...alts: string[]) => Property | undefined;
  name: (n: string) => Property | undefined;
}

function table(ctx: MockCtx, db: DbApi, inst: InstanceRecord, key: string): Table | null {
  const id = inst.keyMap[key];
  if (!id) return null;
  try {
    const s = db.schema(ctx, id);
    const byRole = new Map(s.properties.filter((p) => p.role).map((p) => [p.role as string, p]));
    const byName = new Map(s.properties.map((p) => [p.name, p]));
    return { id, rows: db.rows(ctx, id), role: (r, ...alts) => byRole.get(r) ?? alts.map((a) => byRole.get(a)).find(Boolean), name: (n) => byName.get(n) };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────── per-app metrics

function lifeOsMetrics(ctx: MockCtx, db: DbApi, inst: InstanceRecord): Raw {
  const today = isoDay(ctx.clock.now());
  const t = table(ctx, db, inst, 'tasks');
  const out: Raw = {};
  if (!t) return out;
  const status = (r: RowDTO) => cellOpt(r, t.role('task.status'));
  const open = t.rows.filter((r) => status(r) !== 'Done');
  const inbox = open.filter((r) => status(r) === 'Inbox').length;
  const overdue = open.filter((r) => {
    const d = cellDate(r, t.role('task.due'))?.start;
    return !!d && d.slice(0, 10) < today;
  }).length;
  const dueToday = open.filter((r) => cellDate(r, t.role('task.due'))?.start?.slice(0, 10) === today).length;
  let schedMin = 0;
  for (const r of open) {
    const s = cellDate(r, t.role('task.scheduled'));
    if (!s?.start || s.start.slice(0, 10) !== today) continue;
    const est = cellNum(r, t.role('task.estimate'));
    if (est) schedMin += est;
    else if (s.end) schedMin += Math.max(0, (Date.parse(s.end) - Date.parse(s.start)) / 60_000);
  }
  const done7 = t.rows.filter((r) => {
    const d = cellDate(r, t.role('task.completed'))?.start;
    return status(r) === 'Done' && !!d && d.slice(0, 10) >= addDays(today, -6);
  }).length;
  const p = table(ctx, db, inst, 'projects');
  let noNext = 0;
  if (p) {
    const nextByProject = new Set<Id>();
    for (const r of open) if (status(r) === 'Next' || status(r) === 'Scheduled') for (const pid of cellRel(r, t.role('task.project'))) nextByProject.add(pid);
    noNext = p.rows.filter((r) => cellOpt(r, p.role('project.status')) === 'Active' && !nextByProject.has(r.id)).length;
  }
  const hours = (inst.answers.hours ?? {}) as { start?: string; end?: string };
  const toMin = (s: string | undefined, d: number) => (s && /^\d{2}:\d{2}$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : d);
  const working = Math.max(60, toMin(hours.end, 17 * 60 + 30) - toMin(hours.start, 9 * 60) - 60);
  const last = inst.lastReviewAt ? isoDay(inst.lastReviewAt) : null;
  const daysSince = last ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / DAY) : 0;
  out.inbox_count = { value: inbox, display: String(inbox), math: [{ label: 'Tasks with status Inbox', value: String(inbox), source: 'Tasks' }] };
  out.overdue_count = { value: overdue, display: String(overdue), math: [{ label: 'Open tasks due before today', value: String(overdue), source: 'Tasks' }] };
  out.due_today = { value: dueToday, display: String(dueToday) };
  out.today_scheduled_min = { value: Math.round(schedMin), display: `${Math.round(schedMin)} min`, math: [{ label: 'Scheduled today', value: `${Math.round(schedMin)} min`, source: 'Tasks · Scheduled + Estimate' }] };
  out.working_min = { value: working, display: `${working} min`, math: [{ label: 'Working minutes (minus a lunch hour)', value: String(working), source: 'Your hours' }] };
  out.projects_without_next = { value: noNext, display: String(noNext), math: [{ label: 'Active projects without a Next or Scheduled task', value: String(noNext), source: 'Projects' }] };
  out.last_review_date = { value: last, display: last ? fmtDay(last) : 'Not yet' };
  out.days_since_review = { value: daysSince, display: `${daysSince} days` };
  out.done_7d = { value: done7, display: String(done7) };
  out.open_count = { value: open.length, display: String(open.length) };
  return out;
}

function habitsMetrics(ctx: MockCtx, db: DbApi, inst: InstanceRecord): Raw {
  const out: Raw = {};
  const data = readHabits(ctx, db, inst);
  if (!data) return out;
  const today = isoDay(ctx.clock.now());
  const grace = String(inst.answers.grace ?? 'never_miss_twice') as 'strict' | 'never_miss_twice' | 'skip_days';
  const active = data.defs.filter((d) => d.active);
  const stats = active.map((d) => ({ d, s: streakStats(d, data.entries.filter((e) => e.habitId === d.id), today, grace) }));
  const doneToday = stats.filter((x) => x.s.doneToday).length;
  const best = stats.reduce((m, x) => Math.max(m, x.s.best), 0);
  const avg = stats.length ? stats.reduce((s, x) => s + x.s.rate30, 0) / stats.length : 0;
  const yesterday = addDays(today, -1);
  const missed = stats.filter((x) => {
    if (x.d.schedule === 'x_per_week' || yesterday < x.d.started) return false;
    return !data.entries.some((e) => e.habitId === x.d.id && e.date === yesterday && (e.status === 'done' || e.status === 'partial' || e.status === 'frozen'));
  });
  const struggling = stats.filter((x) => x.s.rate30 < 0.4 && x.d.started < addDays(today, -21));
  const thriving = stats.filter((x) => x.s.rate30 >= 0.9 && x.s.current >= 21);
  const recent = active.filter((d) => d.started >= addDays(today, -14)).length;
  out.active_count = { value: active.length, display: String(active.length) };
  out.today_done_pct = { value: active.length ? doneToday / active.length : 0, display: fmtPct(active.length ? doneToday / active.length : 0), math: [{ label: 'Checked in today', value: `${doneToday} of ${active.length}`, source: 'Habit log' }] };
  out.best_streak = { value: best, display: `${best} days` };
  out.rate_30d_avg = { value: avg, display: fmtPct(avg), math: stats.map((x) => ({ label: x.d.name, value: fmtPct(x.s.rate30), source: '30-day rate' })) };
  out.missed_yesterday = { value: missed.length, display: String(missed.length) };
  out.missed_yesterday_names = { value: missed.map((x) => x.d.name).join(', '), display: missed.map((x) => x.d.name).join(', ') };
  out.struggling_count = { value: struggling.length, display: String(struggling.length) };
  out.struggling_name = { value: struggling[0]?.d.name ?? '', display: struggling[0]?.d.name ?? '' };
  out.thriving_count = { value: thriving.length, display: String(thriving.length) };
  out.thriving_name = { value: thriving[0]?.d.name ?? '', display: thriving[0]?.d.name ?? '' };
  out.recent_started = { value: recent, display: String(recent) };
  return out;
}

function sheetsMetrics(ctx: MockCtx): Raw {
  const n = ctx.pages.table().filter((p) => p.kind === 'sheet' && !p.deletedAt).length;
  return { workbook_count: { value: n, display: String(n) }, lint_issues: { value: 0, display: '0' } };
}

function moneyMetrics(ctx: MockCtx, db: DbApi, inst: InstanceRecord): Raw {
  const out: Raw = {};
  const now = ctx.clock.now();
  const today = isoDay(now);
  const cur = typeof inst.answers.currency === 'object' && inst.answers.currency ? String((inst.answers.currency as { code?: string }).code ?? 'USD') : 'USD';
  const acc = table(ctx, db, inst, 'accounts');
  const tx = table(ctx, db, inst, 'transactions');
  const cats = table(ctx, db, inst, 'categories');
  const goals = table(ctx, db, inst, 'goals');
  const rec = table(ctx, db, inst, 'recurring');
  const nw = table(ctx, db, inst, 'networth');
  if (acc) {
    let assets = 0;
    let liab = 0;
    let util = 0;
    for (const r of acc.rows) {
      if (cellBool(r, acc.name('Closed'))) continue;
      const bal = cellNum(r, acc.role('acct.balance')) ?? cellNum(r, acc.role('acct.opening')) ?? 0;
      if (bal >= 0) assets += bal;
      else liab += -bal;
      const lim = cellNum(r, acc.role('acct.limit'));
      if (lim && bal < 0) util = Math.max(util, -bal / lim);
    }
    out.net_worth = { value: assets - liab, display: fmtMoney(assets - liab, cur), math: [{ label: 'Assets', value: fmtMoney(assets, cur), source: 'Accounts' }, { label: 'Liabilities', value: fmtMoney(-liab, cur), source: 'Accounts' }] };
    out.utilization_max = { value: util, display: fmtPct(util), math: [{ label: 'Highest card balance ÷ limit', value: fmtPct(util), source: 'Accounts' }] };
  }
  if (nw && nw.rows.length >= 2) {
    const sorted = [...nw.rows].sort((a, b) => (cellDate(a, nw.role('nw.date'))?.start ?? '').localeCompare(cellDate(b, nw.role('nw.date'))?.start ?? ''));
    const a = cellNum(sorted[sorted.length - 2], nw.role('nw.net')) ?? 0;
    const b = cellNum(sorted[sorted.length - 1], nw.role('nw.net')) ?? 0;
    out.net_worth_delta_30d = { value: a ? (b - a) / Math.abs(a) : 0, display: fmtPct(a ? (b - a) / Math.abs(a) : 0) };
    out.net_worth_series = { value: sorted.map((r) => cellNum(r, nw.role('nw.net')) ?? 0), display: '' };
  }
  if (tx && cats) {
    const catName = new Map(cats.rows.map((r) => [r.id, cellText(r, cats.name('Name'))] as const));
    const catRow = new Map(cats.rows.map((r) => [r.id, r] as const));
    const essential = new Set(cats.rows.filter((r) => cellBool(r, cats.role('cat.essential'))).map((r) => r.id));
    const savingsCats = new Set(cats.rows.filter((r) => ['Savings & Debt'].includes(cellOpt(r, cats.role('cat.group')) ?? '')).map((r) => r.id));
    const from90 = addDays(today, -90);
    const month = today.slice(0, 7);
    let income = 0;
    let spend = 0;
    let essentialSpend = 0;
    let uncategorized = 0;
    let monthSpend = 0;
    const byCat = new Map<Id, number>();
    for (const r of tx.rows) {
      const d = cellDate(r, tx.role('txn.date'))?.start?.slice(0, 10);
      const amt = cellNum(r, tx.role('txn.amount')) ?? 0;
      const cat = cellRel(r, tx.role('txn.category'))[0];
      if (!cat) uncategorized++;
      if (!d) continue;
      if (d >= from90) {
        if (amt > 0) income += amt;
        else if (!cat || !savingsCats.has(cat)) spend += -amt;
        if (amt < 0 && cat && essential.has(cat)) essentialSpend += -amt;
      }
      if (d.slice(0, 7) === month && amt < 0) {
        if (!cat || !savingsCats.has(cat)) monthSpend += -amt;
        if (cat) byCat.set(cat, (byCat.get(cat) ?? 0) + -amt);
      }
    }
    const rate = income ? (income - spend) / income : 0;
    const essMonthly = essentialSpend / 3;
    out.savings_rate_3m = { value: rate, display: fmtPct(rate), math: [{ label: 'Income (90 days)', value: fmtMoney(income, cur), source: 'Transactions' }, { label: 'Spending (90 days)', value: fmtMoney(spend, cur), source: 'Transactions' }] };
    out.essential_monthly_spend = { value: essMonthly, display: fmtMoney(essMonthly, cur) };
    out.uncategorized_count = { value: uncategorized, display: String(uncategorized) };
    out.month_spend = { value: monthSpend, display: fmtMoney(monthSpend, cur) };
    let budget = 0;
    let over = 0;
    let near = 0;
    const dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const daysLeft = dim - Number(today.slice(8, 10));
    for (const r of cats.rows) {
      const tgt = cellNum(r, cats.role('cat.target'));
      if (!tgt || savingsCats.has(r.id) || cellOpt(r, cats.role('cat.group')) === 'Income') continue;
      budget += tgt;
      const s = byCat.get(r.id) ?? 0;
      if (s > tgt) over++;
      else if (s >= tgt * 0.9 && daysLeft >= 10) near++;
    }
    out.month_budget = { value: budget, display: fmtMoney(budget, cur) };
    out.left_to_spend = { value: budget - monthSpend, display: fmtMoney(budget - monthSpend, cur), math: [{ label: 'Budgeted this month', value: fmtMoney(budget, cur), source: 'Categories' }, { label: 'Spent this month', value: fmtMoney(monthSpend, cur), source: 'Transactions' }] };
    out.budget_headline = out.left_to_spend;
    out.cat_over_count = { value: over, display: String(over) };
    out.cat_90pct_count = { value: near, display: String(near) };
    void catName;
    void catRow;
    if (goals) {
      const ef = goals.rows.find((r) => cellOpt(r, goals.role('goal.kind')) === 'Emergency');
      const saved = ef ? cellNum(ef, goals.role('goal.saved')) ?? 0 : 0;
      const months = essMonthly ? saved / essMonthly : 0;
      out.ef_months = { value: months, display: `${months.toFixed(1)} mo`, math: [{ label: 'Emergency fund', value: fmtMoney(saved, cur), source: 'Goals' }, { label: 'Essential spending / month', value: fmtMoney(essMonthly, cur), source: 'Transactions (3 months)' }] };
    }
  }
  if (rec) {
    const until = addDays(today, 7);
    let sum = 0;
    let n = 0;
    for (const r of rec.rows) {
      const d = cellDate(r, rec.role('rec.next'))?.start?.slice(0, 10);
      if (d && d >= today && d <= until && cellOpt(r, rec.role('rec.kind')) !== 'Income') {
        sum += Math.abs(cellNum(r, rec.role('rec.amount')) ?? 0);
        n++;
      }
    }
    out.upcoming_bills_7d = { value: sum, display: fmtMoney(sum, cur), math: [{ label: `${n} bills due in 7 days`, value: fmtMoney(sum, cur), source: 'Recurring' }] };
  }
  if (acc) {
    let months = 0;
    for (const r of acc.rows) {
      const bal = cellNum(r, acc.role('acct.balance')) ?? 0;
      const min = cellNum(r, acc.role('acct.min_payment')) ?? 0;
      if (bal < 0 && min > 0) months = Math.max(months, Math.ceil(-bal / min));
    }
    const d = months ? isoDay(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + months, 1)) : null;
    out.debt_free_date = { value: d, display: d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Debt-free' };
  }
  return out;
}

function portfolioMetrics(ctx: MockCtx, db: DbApi, inst: InstanceRecord): Raw {
  const out: Raw = {};
  const secs = table(ctx, db, inst, 'securities');
  const tx = table(ctx, db, inst, 'inv_txns');
  const tg = table(ctx, db, inst, 'targets_db');
  const dv = table(ctx, db, inst, 'dividends');
  if (!secs || !tx) return out;
  const qty = new Map<Id, number>();
  const cost = new Map<Id, number>();
  for (const r of tx.rows) {
    const type = cellOpt(r, tx.role('inv.type'));
    const sid = cellRel(r, tx.role('inv.security'))[0];
    if (!sid) continue;
    const q = cellNum(r, tx.role('inv.qty')) ?? 0;
    const p = cellNum(r, tx.role('inv.price')) ?? 0;
    if (type === 'Buy') {
      qty.set(sid, (qty.get(sid) ?? 0) + q);
      cost.set(sid, (cost.get(sid) ?? 0) + q * p);
    } else if (type === 'Sell') {
      const held = qty.get(sid) ?? 0;
      const avg = held ? (cost.get(sid) ?? 0) / held : 0;
      qty.set(sid, held - q);
      cost.set(sid, (cost.get(sid) ?? 0) - avg * q);
    }
  }
  let value = 0;
  let basis = 0;
  let fees = 0;
  let day = 0;
  for (const r of secs.rows) {
    const q = qty.get(r.id) ?? 0;
    const price = cellNum(r, secs.role('sec.price')) ?? 0;
    const v = q * price;
    value += v;
    basis += cost.get(r.id) ?? 0;
    fees += v * (cellNum(r, secs.role('sec.expense_ratio')) ?? 0);
    const seed = cellText(r, secs.name('Name')).length;
    day += v * (((seed * 37) % 23) - 9) / 1000;
  }
  out.total_value = { value, display: fmtMoney(value), math: [{ label: 'Σ quantity × last price', value: fmtMoney(value), source: 'Securities' }] };
  out.day_change = { value: day, display: fmtMoney(day) };
  out.day_change_pct = { value: value ? day / value : 0, display: fmtPct(value ? day / value : 0) };
  out.unrealized = { value: value - basis, display: fmtMoney(value - basis), math: [{ label: 'Value', value: fmtMoney(value) }, { label: 'Cost basis', value: fmtMoney(basis), source: 'FIFO lots' }] };
  out.fees_per_year = { value: fees, display: fmtMoney(fees) };
  if (tg) {
    const drift = tg.rows.reduce((m, r) => Math.max(m, Math.abs(cellNum(r, tg.role('alloc.drift')) ?? 0)), 0);
    out.max_drift = { value: drift, display: fmtPct(drift), math: tg.rows.map((r) => ({ label: cellText(r, tg.role('alloc.class')), value: fmtPct(cellNum(r, tg.role('alloc.drift')) ?? 0), source: 'Target allocation' })) };
  }
  if (dv) {
    const from = addDays(isoDay(ctx.clock.now()), -365);
    const ttm = dv.rows.filter((r) => (cellDate(r, dv.role('div.date'))?.start ?? '') >= from).reduce((s, r) => s + (cellNum(r, dv.role('div.amount')) ?? 0), 0);
    out.div_ttm = { value: ttm, display: fmtMoney(ttm) };
    out.div_fwd_12m = { value: ttm * 1.03, display: fmtMoney(ttm * 1.03) };
  }
  return out;
}

function taxMetrics(ctx: MockCtx, db: DbApi, inst: InstanceRecord): Raw {
  const out: Raw = {};
  const today = isoDay(ctx.clock.now());
  const docs = table(ctx, db, inst, 'documents_db');
  const dl = table(ctx, db, inst, 'deadlines_db');
  const ded = table(ctx, db, inst, 'deductions_db');
  const est = table(ctx, db, inst, 'estimates_db');
  if (docs) {
    const relevant = docs.rows.filter((r) => cellOpt(r, docs.role('doc.status', 'taxdoc.status')) !== 'N/A');
    const got = relevant.filter((r) => ['Received', 'Reviewed', 'Sent to preparer'].includes(cellOpt(r, docs.role('doc.status', 'taxdoc.status')) ?? '')).length;
    out.docs_received_pct = { value: relevant.length ? got / relevant.length : 0, display: `${got} of ${relevant.length}`, math: [{ label: 'Documents received', value: `${got} of ${relevant.length}`, source: 'Document checklist' }] };
  }
  if (dl) {
    const next = dl.rows
      .filter((r) => !cellBool(r, dl.name('Done')) && (cellDate(r, dl.role('deadline.date'))?.start ?? '') >= today)
      .sort((a, b) => (cellDate(a, dl.role('deadline.date'))?.start ?? '').localeCompare(cellDate(b, dl.role('deadline.date'))?.start ?? ''))[0];
    if (next) {
      const d = cellDate(next, dl.role('deadline.date'))!.start.slice(0, 10);
      const days = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
      out.next_deadline = { value: d, display: fmtDay(d) };
      out.next_deadline_label = { value: cellText(next, dl.name('Deadline')), display: cellText(next, dl.name('Deadline')) };
      out.days_to_deadline = { value: days, display: `${days} days` };
    }
  }
  const dedTotal = ded ? ded.rows.reduce((s, r) => s + (cellNum(r, ded.role('ded.amount', 'taxded.amount')) ?? 0), 0) : 0;
  out.deductions_total = { value: dedTotal, display: fmtMoney(dedTotal) };
  // Rough federal estimate (single filer brackets, standard deduction) — the finance engine replaces this on desktop.
  const wages = 82_200;
  const taxable = Math.max(0, wages - 15_000);
  const brackets: [number, number][] = [[11_925, 0.1], [48_475, 0.12], [103_350, 0.22], [197_300, 0.24], [Infinity, 0.32]];
  let tax = 0;
  let prev = 0;
  for (const [cap, rate] of brackets) {
    if (taxable <= prev) break;
    tax += (Math.min(taxable, cap) - prev) * rate;
    prev = cap;
  }
  const paid = (est ? est.rows.reduce((s, r) => s + (cellNum(r, est.role('est.paid', 'taxpay.amount')) ?? 0), 0) : 0) + wages * 0.085;
  out.est_balance = { value: Math.round(tax - paid), display: fmtMoney(Math.abs(Math.round(tax - paid))), math: [{ label: 'Estimated federal tax', value: fmtMoney(Math.round(tax)), source: 'Single · standard deduction' }, { label: 'Withholding + estimates paid', value: fmtMoney(Math.round(paid)), source: 'Estimated payments' }] };
  out.est_effective_rate = { value: tax / wages, display: fmtPct(tax / wages) };
  if (est) {
    const next = est.rows.filter((r) => !cellNum(r, est.role('est.paid', 'taxpay.amount')) && (cellDate(r, est.role('est.due', 'taxpay.due'))?.start ?? '') >= today).sort((a, b) => (cellDate(a, est.role('est.due', 'taxpay.due'))?.start ?? '').localeCompare(cellDate(b, est.role('est.due', 'taxpay.due'))?.start ?? ''))[0];
    if (next) out.quarterly_next = { value: cellNum(next, est.role('est.suggested', 'taxpay.suggested')) ?? 0, display: `${fmtMoney(cellNum(next, est.role('est.suggested', 'taxpay.suggested')) ?? 0)} by ${fmtDay(cellDate(next, est.role('est.due', 'taxpay.due'))!.start.slice(0, 10))}` };
  }
  return out;
}

export function rawMetrics(ctx: MockCtx, db: DbApi, inst: InstanceRecord): Raw {
  switch (inst.appId) {
    case 'life-os':
      return lifeOsMetrics(ctx, db, inst);
    case 'habits':
      return habitsMetrics(ctx, db, inst);
    case 'spreadsheet-studio':
      return sheetsMetrics(ctx);
    case 'money-hq':
      return moneyMetrics(ctx, db, inst);
    case 'portfolio':
      return portfolioMetrics(ctx, db, inst);
    case 'tax-organizer':
      return taxMetrics(ctx, db, inst);
    default:
      return {};
  }
}

/** Built-in metrics merged with the app's hook (finance engines), hook values winning. */
export async function collectMetrics(ctx: MockCtx, db: DbApi, inst: InstanceRecord, names: string[] = []): Promise<Raw> {
  const raw = rawMetrics(ctx, db, inst);
  const hooks = ctx.services.get<LifeAppHooks>(`lifeapp.hooks.${inst.appId}`);
  if (hooks?.metrics) {
    try {
      const extra = await hooks.metrics(ctx, inst.id, names);
      if (extra) for (const [k, v] of Object.entries(extra)) raw[k] = { value: v.value, display: v.display, math: v.math };
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err)) console.error('[emp mock] life-app metrics hook failed', err);
    }
  }
  return raw;
}

export async function metricsFor(ctx: MockCtx, db: DbApi, inst: InstanceRecord, names: string[]): Promise<Record<string, LifeAppMetric>> {
  const asOf = ctx.clock.now();
  const raw = await collectMetrics(ctx, db, inst, names);
  const out: Record<string, LifeAppMetric> = {};
  const want = names.length ? names : Object.keys(raw);
  for (const n of want) {
    const m = raw[n];
    if (m) out[n] = { value: m.value, display: m.display, math: m.math ?? [], asOf };
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── advisor

const RANK: Record<Insight['severity'], number> = { critical: 0, warn: 1, tip: 2, info: 3 };

function routeFor(inst: InstanceRecord, s: string): Route {
  const [kind, key] = s.split(':');
  if (kind === 'tab') return { t: 'app', instanceId: inst.id, tab: key };
  if (kind === 'page' && inst.keyMap[key]) return { t: 'page', id: inst.keyMap[key] };
  if (kind === 'db' && inst.keyMap[key]) return { t: 'db', id: inst.keyMap[key] };
  return { t: 'app', instanceId: inst.id };
}

export async function insightsFor(ctx: MockCtx, db: DbApi, inst: InstanceRecord): Promise<Insight[]> {
  const m = manifestById(inst.appId);
  if (!m || inst.detached) return [];
  const now = ctx.clock.now();
  const raw = await collectMetrics(ctx, db, inst);
  const metrics: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) metrics[k] = v.value;
  const scope = { answers: inst.answers, metrics, today: isoDay(now) };
  const out: Insight[] = [];
  for (const rule of m.advisor) {
    const muted = inst.muted[rule.id];
    if (muted === null || (typeof muted === 'number' && muted > now)) continue;
    if (!test(rule.when, scope)) continue;
    // Rust `advisor::insights`: one line per math metric — its name, its displayed value, its first source.
    const math: InsightMath[] = [];
    for (const mm of rule.mathMetrics) {
      const r = raw[mm];
      if (!r) continue;
      const source = r.math?.[0]?.source;
      math.push({ label: mm.replace(/_/g, ' '), value: r.display, ...(source ? { source } : {}) });
    }
    out.push({
      id: `${inst.id}:${rule.id}`,
      appInstanceId: inst.id,
      ruleId: rule.id,
      severity: rule.severity,
      title: interpolate(rule.title, scope),
      body: interpolate(rule.body, scope),
      math: math.slice(0, 8),
      actions: rule.actions.map((a) => ({ label: a.label, route: routeFor(inst, a.route) })),
    });
  }
  const hooks = ctx.services.get<LifeAppHooks>(`lifeapp.hooks.${inst.appId}`);
  try {
    const extra = await hooks?.insights?.(ctx, inst.id);
    if (extra) for (const e of extra) if (!out.some((o) => o.ruleId === e.ruleId) && !(e.mutedUntil && e.mutedUntil > now)) out.push(e);
  } catch (err) {
    console.error('[emp mock] life-app insights hook failed', err);
  }
  void evalExpr;
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
