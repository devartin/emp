/**
 * Relative date ranges for filters (§8.4 `within`) and date buckets for grouping / charts (§8.5, §8.3).
 * Evaluated in the local timezone with the vault week start.
 */
import {
  addDays, addMonths, addWeeks, addYears, differenceInCalendarDays, endOfDay, endOfMonth, endOfQuarter, endOfWeek, endOfYear,
  format as dfmt, getISOWeek, startOfDay, startOfMonth, startOfQuarter, startOfWeek, startOfYear, subDays,
} from 'date-fns';

export type WeekStart = 0 | 1 | 6;

export type WithinValue =
  | 'today' | 'tomorrow' | 'yesterday' | 'this_week' | 'past_week' | 'next_week' | 'this_month' | 'past_month' | 'next_month'
  | 'this_quarter' | 'this_year' | 'past_year' | 'next_year' | { past_days: number } | { next_days: number };

export const WITHIN_OPTIONS: { value: Exclude<WithinValue, object>; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'past_week', label: 'Past week' },
  { value: 'next_week', label: 'Next week' },
  { value: 'this_month', label: 'This month' },
  { value: 'past_month', label: 'Past month' },
  { value: 'next_month', label: 'Next month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'past_year', label: 'Past year' },
  { value: 'next_year', label: 'Next year' },
];

/** [from, to] inclusive epoch-ms bounds. */
export function withinRange(v: WithinValue, now: number, ws: WeekStart = 1): [number, number] | null {
  const d = new Date(now);
  const opts = { weekStartsOn: ws } as const;
  if (typeof v === 'object' && v) {
    if ('past_days' in v) return [startOfDay(subDays(d, Math.max(0, v.past_days))).getTime(), endOfDay(d).getTime()];
    if ('next_days' in v) return [startOfDay(d).getTime(), endOfDay(addDays(d, Math.max(0, v.next_days))).getTime()];
    return null;
  }
  switch (v) {
    case 'today':
      return [startOfDay(d).getTime(), endOfDay(d).getTime()];
    case 'tomorrow':
      return [startOfDay(addDays(d, 1)).getTime(), endOfDay(addDays(d, 1)).getTime()];
    case 'yesterday':
      return [startOfDay(subDays(d, 1)).getTime(), endOfDay(subDays(d, 1)).getTime()];
    case 'this_week':
      return [startOfWeek(d, opts).getTime(), endOfWeek(d, opts).getTime()];
    case 'past_week':
      return [startOfDay(subDays(d, 7)).getTime(), endOfDay(d).getTime()];
    case 'next_week':
      return [startOfDay(d).getTime(), endOfDay(addDays(d, 7)).getTime()];
    case 'this_month':
      return [startOfMonth(d).getTime(), endOfMonth(d).getTime()];
    case 'past_month':
      return [startOfDay(addMonths(d, -1)).getTime(), endOfDay(d).getTime()];
    case 'next_month':
      return [startOfDay(d).getTime(), endOfDay(addMonths(d, 1)).getTime()];
    case 'this_quarter':
      return [startOfQuarter(d).getTime(), endOfQuarter(d).getTime()];
    case 'this_year':
      return [startOfYear(d).getTime(), endOfYear(d).getTime()];
    case 'past_year':
      return [startOfDay(addYears(d, -1)).getTime(), endOfDay(d).getTime()];
    case 'next_year':
      return [startOfDay(d).getTime(), endOfDay(addYears(d, 1)).getTime()];
    default:
      return null;
  }
}

export function withinLabel(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as { past_days?: number; next_days?: number };
    if (typeof o.past_days === 'number') return `Past ${o.past_days} days`;
    if (typeof o.next_days === 'number') return `Next ${o.next_days} days`;
  }
  return WITHIN_OPTIONS.find((o) => o.value === v)?.label ?? 'Pick a range';
}

export type Bucket = 'relative' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Stable sortable key + label for a date in a bucket. */
export function bucketOf(ts: number, bucket: Bucket, now: number, ws: WeekStart = 1): { key: string; label: string; order: number } {
  const d = new Date(ts);
  switch (bucket) {
    case 'day':
      return { key: dfmt(d, 'yyyy-MM-dd'), label: dfmt(d, 'MMM d, yyyy'), order: startOfDay(d).getTime() };
    case 'week': {
      const s = startOfWeek(d, { weekStartsOn: ws });
      return { key: 'w' + dfmt(s, 'yyyy-MM-dd'), label: `Week ${getISOWeek(s)} · ${dfmt(s, 'MMM d')}`, order: s.getTime() };
    }
    case 'month': {
      const s = startOfMonth(d);
      return { key: dfmt(s, 'yyyy-MM'), label: dfmt(s, 'MMM yyyy'), order: s.getTime() };
    }
    case 'quarter': {
      const s = startOfQuarter(d);
      return { key: `${s.getFullYear()}-Q${Math.floor(s.getMonth() / 3) + 1}`, label: `Q${Math.floor(s.getMonth() / 3) + 1} ${s.getFullYear()}`, order: s.getTime() };
    }
    case 'year': {
      const s = startOfYear(d);
      return { key: String(s.getFullYear()), label: String(s.getFullYear()), order: s.getTime() };
    }
    case 'relative':
    default: {
      const diff = differenceInCalendarDays(d, new Date(now));
      const R: [number, number, string, string][] = [
        [-Infinity, -31, 'older', 'Older'],
        [-30, -8, 'past30', 'Previous 30 days'],
        [-7, -2, 'past7', 'Previous 7 days'],
        [-1, -1, 'yesterday', 'Yesterday'],
        [0, 0, 'today', 'Today'],
        [1, 1, 'tomorrow', 'Tomorrow'],
        [2, 7, 'next7', 'Next 7 days'],
        [8, 30, 'next30', 'Next 30 days'],
        [31, Infinity, 'later', 'Later'],
      ];
      const i = R.findIndex(([lo, hi]) => diff >= lo && diff <= hi);
      const r = R[i < 0 ? 0 : i];
      return { key: r[2], label: r[3], order: i };
    }
  }
}

/** Iterate bucket starts between two instants (charts fill gaps with zeros). */
export function bucketSeries(from: number, to: number, bucket: Exclude<Bucket, 'relative'>, ws: WeekStart = 1, max = 400): number[] {
  const out: number[] = [];
  let cur: Date;
  switch (bucket) {
    case 'day':
      cur = startOfDay(new Date(from));
      break;
    case 'week':
      cur = startOfWeek(new Date(from), { weekStartsOn: ws });
      break;
    case 'month':
      cur = startOfMonth(new Date(from));
      break;
    case 'quarter':
      cur = startOfQuarter(new Date(from));
      break;
    default:
      cur = startOfYear(new Date(from));
  }
  while (cur.getTime() <= to && out.length < max) {
    out.push(cur.getTime());
    cur =
      bucket === 'day' ? addDays(cur, 1) : bucket === 'week' ? addWeeks(cur, 1) : bucket === 'month' ? addMonths(cur, 1) : bucket === 'quarter' ? addMonths(cur, 3) : addYears(cur, 1);
  }
  return out;
}
