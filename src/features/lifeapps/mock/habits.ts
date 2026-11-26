/**
 * Mock-only: Habits generator (§16.7) — Habits + Habit log databases, the dashboard, weekly review and reminders —
 * plus the streak maths (§15.8 grace modes) shared by metrics and the computed Habits columns.
 */
import type { Id, RowDTO } from '@/backend/types';
import type { MockCtx } from '@/backend/mock/ctx';
import { createReminder } from '@/backend/mock/commands/reminder';
import type { DbApi } from '@/backend/mock/commands/db';
import { HABIT_LIBRARY } from '../engine/manifests';
import { streakStats, type HabitDef, type HabitLogEntry } from '../engine/habitMath';
import { md } from './content';
import { c, DAY, emoji, F, isoDay, lucide, P, prng, sel, cellNum, cellOpt, cellText, cellBool, cellDate, cellRel, type DbHandle, type Env, type InstanceRecord } from './env';

interface PickItem {
  name?: string;
  type?: string;
  schedule?: string;
  perWeek?: number;
  target?: number;
  unit?: string;
  twoMinute?: string;
  cue?: string;
  timeOfDay?: string;
}

const TYPE_LABEL: Record<string, string> = { yes_no: 'Yes/no', count: 'Count', duration: 'Duration', quantity: 'Quantity', avoid: 'Avoid' };
const SCHED_LABEL: Record<string, string> = { daily: 'Daily', x_per_week: 'X per week', weekdays: 'Weekdays', every_n_days: 'Every N days' };
const TOD_LABEL: Record<string, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', anytime: 'Anytime' };
const TOD_TIME: Record<string, string> = { morning: '07:30', afternoon: '13:00', evening: '20:00', anytime: '12:00' };

const LIB_DEFAULTS: Record<string, PickItem & { icon: string }> = {
  sleep: { name: 'Sleep 7–9 h', type: 'duration', schedule: 'daily', target: 7.5, unit: 'h', twoMinute: 'Lights out by 11', cue: 'After brushing teeth', timeOfDay: 'evening', icon: '😴' },
  walk: { name: 'Walk 8k steps', type: 'count', schedule: 'daily', target: 8000, unit: 'steps', twoMinute: 'Walk around the block', cue: 'After lunch', timeOfDay: 'afternoon', icon: '🚶' },
  strength: { name: 'Strength train', type: 'yes_no', schedule: 'x_per_week', perWeek: 3, twoMinute: 'Ten push-ups', cue: 'After work', timeOfDay: 'evening', icon: '🏋️' },
  water: { name: 'Water', type: 'quantity', schedule: 'daily', target: 8, unit: 'glasses', twoMinute: 'One glass with breakfast', cue: 'With every meal', timeOfDay: 'anytime', icon: '💧' },
  read: { name: 'Read 20 min', type: 'duration', schedule: 'daily', target: 20, unit: 'min', twoMinute: 'Read one page', cue: 'After dinner', timeOfDay: 'evening', icon: '📖' },
  meditate: { name: 'Meditate', type: 'duration', schedule: 'daily', target: 10, unit: 'min', twoMinute: 'Three slow breaths', cue: 'After morning coffee', timeOfDay: 'morning', icon: '🧘' },
  journal: { name: 'Journal', type: 'yes_no', schedule: 'daily', twoMinute: 'One sentence', cue: 'Before bed', timeOfDay: 'evening', icon: '✍️' },
  nophone: { name: 'No phone first hour', type: 'avoid', schedule: 'daily', twoMinute: 'Phone stays in the hall', cue: 'When I wake up', timeOfDay: 'morning', icon: '📵' },
  inbox: { name: 'Inbox zero', type: 'yes_no', schedule: 'weekdays', twoMinute: 'Archive five emails', cue: 'At 4:30 PM', timeOfDay: 'afternoon', icon: '📥' },
  language: { name: 'Language practice', type: 'duration', schedule: 'daily', target: 15, unit: 'min', twoMinute: 'One lesson', cue: 'On the commute', timeOfDay: 'morning', icon: '🗣️' },
  floss: { name: 'Floss', type: 'yes_no', schedule: 'daily', twoMinute: 'One tooth', cue: 'After brushing', timeOfDay: 'evening', icon: '🦷' },
  budget: { name: 'Budget check-in', type: 'yes_no', schedule: 'x_per_week', perWeek: 1, twoMinute: 'Open Money HQ', cue: 'Sunday coffee', timeOfDay: 'morning', icon: '💰' },
  stretch: { name: 'Stretch', type: 'duration', schedule: 'daily', target: 5, unit: 'min', twoMinute: 'One stretch', cue: 'After standing up from work', timeOfDay: 'afternoon', icon: '🤸' },
};

function iconFor(name: string): string {
  const lib = HABIT_LIBRARY.find((l) => l.label.toLowerCase() === name.toLowerCase());
  if (lib) return lib.icon;
  const n = name.toLowerCase();
  if (/run|walk|step/.test(n)) return '🚶';
  if (/read|book/.test(n)) return '📖';
  if (/water|drink/.test(n)) return '💧';
  if (/sleep|bed/.test(n)) return '😴';
  if (/medit|breath/.test(n)) return '🧘';
  if (/gym|lift|strength|push/.test(n)) return '🏋️';
  return '✨';
}

export function habitItems(answers: Record<string, unknown>): (PickItem & { icon: string })[] {
  const raw = Array.isArray(answers.pick) ? (answers.pick as unknown[]) : [];
  const out: (PickItem & { icon: string })[] = [];
  for (const x of raw) {
    if (typeof x === 'string') {
      const lib = LIB_DEFAULTS[x];
      out.push(lib ? { ...lib } : { name: x, type: 'yes_no', schedule: 'daily', timeOfDay: 'anytime', icon: iconFor(x) });
    } else if (x && typeof x === 'object') {
      const it = x as PickItem;
      const name = String(it.name ?? '').trim();
      if (!name) continue;
      const lib = Object.values(LIB_DEFAULTS).find((l) => l.name === name);
      out.push({ ...(lib ?? {}), ...it, name, icon: lib?.icon ?? iconFor(name) });
    }
  }
  return out.slice(0, 30);
}

export async function installHabits(env: Env): Promise<void> {
  const { ctx, answers } = env;
  const items = habitItems(answers);

  await env.step('Building your habit dashboard');
  const dashId = env.inst.rootPageId;
  env.keep('dash', dashId);

  await env.step('Creating the Habits database');
  const habits = env.database('habits_db', {
    title: 'Habits',
    icon: emoji('🌱'),
    props: [
      P.title('Name', 'habit.name'),
      P.select('Type', Object.values(TYPE_LABEL), 'habit.type'),
      P.select('Schedule', Object.values(SCHED_LABEL), 'habit.schedule'),
      P.num('Per week', 'habit.per_week'),
      P.num('Target', 'habit.target'),
      P.text('Unit', 'habit.unit'),
      P.text('Two-minute version', 'habit.two_min'),
      P.text('Cue', 'habit.cue'),
      P.select('Time of day', Object.values(TOD_LABEL), 'habit.time'),
      P.select('Area', ['Health', 'Mind', 'Learning', 'Home', 'Money', 'Work']),
      P.check('Active', 'habit.active'),
      P.date('Started', 'habit.started'),
      P.num('Current streak', 'habit.streak'),
      P.num('Best streak', 'habit.best'),
      P.num('30-day rate', 'habit.rate30', 'percent'),
    ],
    firstView: { name: 'Active habits', layout: 'table' },
  });
  setFilter(ctx, habits, 'Active habits', { prop: habits.props.Active.id, op: 'checked' });
  env.view(habits, 'By time of day', 'board', { groupBy: { prop: habits.props['Time of day'].id } });

  await env.step('Creating the Habit log');
  const log = env.database('log', {
    title: 'Habit log',
    icon: emoji('🗒️'),
    props: [
      P.title('Entry'),
      P.date('Date', 'log.date'),
      P.rel('Habit', habits.id, 'log.habit', 'one'),
      P.num('Value', 'log.value'),
      P.select('Status', [{ name: 'Done', color: 'green' }, { name: 'Partial', color: 'yellow' }, { name: 'Skipped', color: 'gray' }, { name: 'Missed', color: 'red' }, { name: 'Frozen', color: 'blue' }], 'log.status'),
      P.text('Note', 'log.note'),
      P.rating('Mood', 'log.mood'),
    ],
    firstView: { name: 'Recent', layout: 'table' },
  });
  setSort(ctx, log, 'Recent', [F.sort(log, 'Date', 'desc')]);
  env.view(log, 'Calendar', 'calendar', { calendar: { dateProp: log.props.Date.id, showWeekends: true } });

  const habitIds: { id: Id; item: PickItem & { icon: string } }[] = [];
  const started = isoDay(env.sample ? env.now - 150 * DAY : env.now);
  items.forEach((it, i) => {
    const id = env.row(
      habits,
      {
        Name: c.text(it.name ?? 'Habit'),
        Type: sel(TYPE_LABEL[it.type ?? 'yes_no'] ?? 'Yes/no'),
        Schedule: sel(SCHED_LABEL[it.schedule ?? 'daily'] ?? 'Daily'),
        'Per week': c.num(it.schedule === 'x_per_week' ? (it.perWeek ?? 3) : null),
        Target: c.num(it.target ?? null),
        Unit: c.text(it.unit),
        'Two-minute version': c.text(it.twoMinute),
        Cue: c.text(it.cue),
        'Time of day': sel(TOD_LABEL[it.timeOfDay ?? 'anytime'] ?? 'Anytime'),
        Area: sel(/walk|run|sleep|water|strength|stretch|floss/i.test(it.name ?? '') ? 'Health' : /read|language/i.test(it.name ?? '') ? 'Learning' : /budget/i.test(it.name ?? '') ? 'Money' : /inbox/i.test(it.name ?? '') ? 'Work' : 'Mind'),
        Active: c.check(true),
        Started: c.date(env.sample ? isoDay(env.now - (150 - i * 18) * DAY) : started),
      },
      { icon: emoji(it.icon), sample: false },
    );
    habitIds.push({ id, item: it });
  });

  if (env.on('weekly')) {
    await env.step('Writing the weekly reflection');
    env.page('weekly', {
      title: 'Weekly habit review',
      icon: emoji('🪞'),
      blocks: md(`> [!tip] Five minutes every Sunday. Be curious, not critical.
${typeof answers.identity === 'string' && answers.identity.trim() ? `> I’m becoming someone who ${answers.identity.trim().replace(/^who\s+/i, '')}\n` : ''}
## What went well?
-
## What got in the way?
-
## One tweak for next week
- [ ] Make one habit smaller, or attach it to a stronger cue
- [ ] Decide which day you will plan to skip (and freeze it)
## Score
How would you rate the week out of 5?`),
    });
  }

  if (env.on('habit_rem')) {
    await env.step('Setting gentle reminders');
    for (const { id, item } of habitIds) {
      const [h, m] = (TOD_TIME[item.timeOfDay ?? 'anytime'] ?? '12:00').split(':').map(Number);
      let fire = Math.floor(env.now / DAY) * DAY + (h * 60 + m) * 60_000;
      while (fire <= env.now) fire += DAY;
      createReminder(ctx, { fireAt: fire, targetKind: 'row', targetId: id, text: `${item.name}${item.twoMinute ? ` — or just: ${item.twoMinute.toLowerCase()}` : ''}`, instanceId: env.inst.id, everyMs: DAY });
    }
  }

  if (env.sample) {
    await env.step('Adding 5 months of check-ins');
    sampleLog(env, log, habitIds);
  }
  refreshHabitStats(ctx, env.db, env.inst, { habits, log });
  if (!ctx.seeding) {
    env.db.emitChanged(ctx, habits.id);
    env.db.emitChanged(ctx, log.id);
  }
  void lucide;
}

function setFilter(ctx: MockCtx, h: DbHandle, view: string, filter: unknown) {
  const id = h.views[view];
  if (id) ctx.db.table<{ id: Id; filter?: unknown }>('db_views').update(id, (v) => void (v.filter = filter));
}
function setSort(ctx: MockCtx, h: DbHandle, view: string, sorts: unknown[]) {
  const id = h.views[view];
  if (id) ctx.db.table<{ id: Id; sorts: unknown[] }>('db_views').update(id, (v) => void (v.sorts = sorts));
}

/** Consistency profiles make the demo heatmaps look lived-in: strong, building, wobbly, recent. */
export function sampleLog(env: Env, log: DbHandle, habits: { id: Id; item: PickItem & { icon: string } }[]) {
  const rnd = prng(42);
  const profiles = [0.9, 0.78, 0.62, 0.84, 0.55, 0.7];
  habits.forEach(({ id, item }, hi) => {
    const base = profiles[hi % profiles.length];
    const startOffset = 150 - hi * 18;
    for (let d = startOffset; d >= 0; d--) {
      if (d === 0 && hi % 2 === 1) continue; // today: half the habits still to do
      const date = new Date(env.now - d * DAY);
      const dow = date.getUTCDay();
      if (item.schedule === 'weekdays' && (dow === 0 || dow === 6)) continue;
      if (item.schedule === 'x_per_week' && ![1, 3, 5].includes(dow) && rnd() > 0.15) continue;
      // improving over time + a wobble around week 6
      const trend = Math.min(0.97, base + (startOffset - d) / 900 - (d > 40 && d < 52 ? 0.25 : 0));
      const r = rnd();
      if (d === 1 && hi === 2) continue; // a miss yesterday → "don't miss twice"
      let status: string | null = null;
      if (r < trend) status = 'Done';
      else if (r < trend + 0.06) status = 'Partial';
      else if (r < trend + 0.09) status = 'Skipped';
      if (!status) continue;
      const target = item.target ?? 1;
      const value = item.type === 'yes_no' || item.type === 'avoid' ? null : status === 'Partial' ? Math.round(target * (0.4 + rnd() * 0.4) * 10) / 10 : Math.round(target * (0.95 + rnd() * 0.35) * 10) / 10;
      env.row(log, {
        Entry: c.text(`${item.name} · ${isoDay(date.getTime())}`),
        Date: c.date(isoDay(date.getTime())),
        Habit: c.rel([id]),
        Value: c.num(value),
        Status: sel(status),
        Mood: d % 4 === 0 ? c.rating(3 + Math.round(rnd() * 2)) : null,
      });
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────── stats (computed Habits columns)

export interface HabitsDbs {
  habits: { id: Id; props: Record<string, { id: Id }> };
  log: { id: Id; props: Record<string, { id: Id }> };
}

export function readHabits(ctx: MockCtx, db: DbApi, inst: InstanceRecord): { defs: HabitDef[]; entries: HabitLogEntry[]; rows: RowDTO[] } | null {
  const hid = inst.keyMap.habits_db;
  const lid = inst.keyMap.log;
  if (!hid || !lid) return null;
  let hs, ls;
  try {
    hs = db.schema(ctx, hid);
    ls = db.schema(ctx, lid);
  } catch {
    return null;
  }
  const hp = Object.fromEntries(hs.properties.map((p) => [p.role ?? p.name, p]));
  const lp = Object.fromEntries(ls.properties.map((p) => [p.role ?? p.name, p]));
  const rows = db.rows(ctx, hid);
  const defs: HabitDef[] = rows.map((r) => ({
    id: r.id,
    name: cellText(r, hp['habit.name']),
    schedule: ((): HabitDef['schedule'] => {
      const s = cellOpt(r, hp['habit.schedule']);
      return s === 'X per week' ? 'x_per_week' : s === 'Weekdays' ? 'weekdays' : s === 'Every N days' ? 'every_n_days' : 'daily';
    })(),
    perWeek: cellNum(r, hp['habit.per_week']) ?? 3,
    active: cellBool(r, hp['habit.active']),
    started: cellDate(r, hp['habit.started'])?.start ?? isoDay(r.createdAt),
  }));
  const entries: HabitLogEntry[] = [];
  for (const r of db.rows(ctx, lid)) {
    const d = cellDate(r, lp['log.date'])?.start;
    const habit = cellRel(r, lp['log.habit'])[0];
    if (!d || !habit) continue;
    const st = (cellOpt(r, lp['log.status']) ?? 'Done').toLowerCase() as HabitLogEntry['status'];
    entries.push({ habitId: habit, date: d.slice(0, 10), status: st, value: cellNum(r, lp['log.value']) });
  }
  return { defs, entries, rows };
}

export function refreshHabitStats(ctx: MockCtx, db: DbApi, inst: InstanceRecord, _h?: unknown): void {
  const data = readHabits(ctx, db, inst);
  if (!data) return;
  const grace = (String(inst.answers.grace ?? 'never_miss_twice') as 'strict' | 'never_miss_twice' | 'skip_days');
  const today = isoDay(ctx.clock.now());
  const hs = db.schema(ctx, inst.keyMap.habits_db);
  const byRole = Object.fromEntries(hs.properties.map((p) => [p.role ?? p.name, p]));
  const updates: { id: Id; values: Record<Id, { t: 'number'; v: number }> }[] = [];
  for (const def of data.defs) {
    const s = streakStats(def, data.entries.filter((e) => e.habitId === def.id), today, grace);
    const row = data.rows.find((r) => r.id === def.id);
    if (!row) continue;
    const want = { streak: s.current, best: s.best, rate: Math.round(s.rate30 * 1000) / 1000 };
    const have = { streak: cellNum(row, byRole['habit.streak']), best: cellNum(row, byRole['habit.best']), rate: cellNum(row, byRole['habit.rate30']) };
    if (have.streak === want.streak && have.best === want.best && have.rate === want.rate) continue;
    updates.push({ id: def.id, values: { [byRole['habit.streak'].id]: { t: 'number', v: want.streak }, [byRole['habit.best'].id]: { t: 'number', v: want.best }, [byRole['habit.rate30'].id]: { t: 'number', v: want.rate } } });
  }
  if (updates.length) db.updateRows(ctx, updates);
}
