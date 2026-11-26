/**
 * Habit streak maths (§15.8 `habits::streak` / `completion_rate`), shared by the browser mock and the Habits
 * dashboard. Grace modes:
 *   strict            any expected day without a check-in breaks the streak
 *   never_miss_twice  one miss is forgiven; two consecutive misses break it
 *   skip_days         skipped / frozen days are neutral; misses break it
 * A day that is still in progress (today, not yet done) never counts as a miss.
 */

export type HabitSchedule = 'daily' | 'weekdays' | 'x_per_week' | 'every_n_days';
export type GraceMode = 'strict' | 'never_miss_twice' | 'skip_days';

export interface HabitDef {
  id: string;
  name: string;
  schedule: HabitSchedule;
  perWeek: number;
  everyN?: number;
  active: boolean;
  /** 'YYYY-MM-DD' */
  started: string;
}

export interface HabitLogEntry {
  habitId: string;
  date: string;
  status: 'done' | 'partial' | 'skipped' | 'missed' | 'frozen';
  value: number | null;
}

export interface StreakStats {
  current: number;
  best: number;
  /** done ÷ expected over the last 30 days (0..1). */
  rate30: number;
  rate7: number;
  doneToday: boolean;
  /** The streak grew today (for the flame pop). */
  incrementedToday: boolean;
  /** Last 28 days, oldest first: 1 done · .5 partial · 0 missed · −1 neutral / not expected. */
  last28: number[];
}

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return toIso(toMs(day) + n * DAY);
}

export function isExpected(def: Pick<HabitDef, 'schedule' | 'started' | 'everyN'>, day: string): boolean {
  if (day < def.started) return false;
  const dow = new Date(toMs(day)).getUTCDay();
  switch (def.schedule) {
    case 'weekdays':
      return dow !== 0 && dow !== 6;
    case 'every_n_days': {
      const n = Math.max(1, def.everyN ?? 2);
      return Math.round((toMs(day) - toMs(def.started)) / DAY) % n === 0;
    }
    case 'x_per_week':
      // Flexible: every day is a candidate; completion is judged per week.
      return true;
    default:
      return true;
  }
}

type Mark = 'done' | 'partial' | 'neutral' | 'miss';

function markFor(status: HabitLogEntry['status'] | undefined, grace: GraceMode): Mark {
  if (status === 'done') return 'done';
  if (status === 'partial') return 'partial';
  if (status === 'frozen') return 'neutral';
  if (status === 'skipped') return grace === 'strict' ? 'miss' : 'neutral';
  return 'miss';
}

/** ISO week key (Monday-based) for weekly targets. */
function weekKey(day: string): string {
  const ms = toMs(day);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  return toIso(ms - dow * DAY);
}

export function streakStats(def: HabitDef, entries: HabitLogEntry[], today: string, grace: GraceMode): StreakStats {
  const byDay = new Map<string, HabitLogEntry['status']>();
  for (const e of entries) {
    const prev = byDay.get(e.date);
    // keep the "best" status if several entries exist for a day
    if (!prev || prev === 'missed' || (prev === 'partial' && e.status === 'done')) byDay.set(e.date, e.status);
  }
  const doneToday = byDay.get(today) === 'done' || byDay.get(today) === 'partial';

  if (def.schedule === 'x_per_week') return weeklyStats(def, byDay, today, doneToday);

  // forward pass for best + current
  let best = 0;
  let run = 0;
  let lastMiss = false;
  const start = def.started < addDays(today, -730) ? addDays(today, -730) : def.started;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (!isExpected(def, d)) continue;
    const isToday = d === today;
    const m = markFor(byDay.get(d), grace);
    if (m === 'done' || m === 'partial') {
      run += 1;
      lastMiss = false;
    } else if (m === 'neutral') {
      /* streak frozen */
    } else if (isToday) {
      /* in progress */
    } else if (grace === 'never_miss_twice' && !lastMiss) {
      lastMiss = true;
    } else {
      run = 0;
      lastMiss = false;
    }
    best = Math.max(best, run);
  }
  const current = run;
  const prevRun = (() => {
    if (!doneToday) return current;
    return current - 1;
  })();

  const rate = (days: number) => {
    let exp = 0;
    let got = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(today, -i);
      if (!isExpected(def, d)) continue;
      const m = markFor(byDay.get(d), grace);
      if (d === today && m === 'miss') continue;
      if (m === 'neutral') continue;
      exp += 1;
      got += m === 'done' ? 1 : m === 'partial' ? 0.5 : 0;
    }
    return exp ? got / exp : 0;
  };

  const last28: number[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = addDays(today, -i);
    if (!isExpected(def, d)) {
      last28.push(-1);
      continue;
    }
    const m = markFor(byDay.get(d), grace);
    last28.push(m === 'done' ? 1 : m === 'partial' ? 0.5 : m === 'neutral' || (d === today && m === 'miss') ? -1 : 0);
  }

  return { current, best, rate30: rate(30), rate7: rate(7), doneToday, incrementedToday: doneToday && current > prevRun, last28 };
}

function weeklyStats(def: HabitDef, byDay: Map<string, HabitLogEntry['status']>, today: string, doneToday: boolean): StreakStats {
  const target = Math.max(1, Math.min(7, def.perWeek || 3));
  const counts = new Map<string, number>();
  for (const [d, s] of byDay) if ((s === 'done' || s === 'partial') && d >= def.started && d <= today) counts.set(weekKey(d), (counts.get(weekKey(d)) ?? 0) + 1);
  // current streak = check-ins in consecutive weeks that met the target (this week counts while in progress)
  const thisWeek = weekKey(today);
  let current = counts.get(thisWeek) ?? 0;
  let w = addDays(thisWeek, -7);
  while (w >= weekKey(def.started) && (counts.get(w) ?? 0) >= target) {
    current += counts.get(w) ?? 0;
    w = addDays(w, -7);
  }
  let best = 0;
  let run = 0;
  for (let wk = weekKey(def.started); wk <= thisWeek; wk = addDays(wk, 7)) {
    const n = counts.get(wk) ?? 0;
    if (n >= target || wk === thisWeek) run += n;
    else run = 0;
    best = Math.max(best, run);
  }
  const rateOver = (days: number) => {
    let got = 0;
    for (let i = 0; i < days; i++) {
      const s = byDay.get(addDays(today, -i));
      if (s === 'done') got += 1;
      else if (s === 'partial') got += 0.5;
    }
    return Math.min(1, got / ((target * days) / 7));
  };
  const last28: number[] = [];
  for (let i = 27; i >= 0; i--) {
    const s = byDay.get(addDays(today, -i));
    last28.push(s === 'done' ? 1 : s === 'partial' ? 0.5 : -1);
  }
  return { current, best: Math.max(best, current), rate30: rateOver(30), rate7: rateOver(7), doneToday, incrementedToday: doneToday, last28 };
}

/** The 12×12 heatmap grid (144 days ending today), oldest first, Monday-aligned columns are left to the renderer. */
export function heatCells(def: HabitDef, entries: HabitLogEntry[], today: string, days = 144): { date: string; level: number; expected: boolean; status?: HabitLogEntry['status'] }[] {
  const byDay = new Map(entries.map((e) => [e.date, e] as const));
  const out: { date: string; level: number; expected: boolean; status?: HabitLogEntry['status'] }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const e = byDay.get(d);
    const expected = isExpected(def, d);
    const level = !e ? 0 : e.status === 'done' ? 1 : e.status === 'partial' ? 0.55 : e.status === 'frozen' || e.status === 'skipped' ? 0.18 : 0;
    out.push({ date: d, level, expected, status: e?.status });
  }
  return out;
}
