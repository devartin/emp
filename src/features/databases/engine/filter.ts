/**
 * Filter evaluation (§8.4): a tree of and/or groups (≤ 3 levels) over property conditions. Incomplete conditions
 * (no value yet) match everything so a half-built filter never empties the view.
 */
import type { CellValue, Filter, FilterOp, Id, Property, RowDTO } from '@/backend/types';
import { endOfDay, startOfDay } from 'date-fns';
import { withinRange, type WeekStart, type WithinValue } from './dates';
import { formatCell } from './format';
import { familyOf, opNeedsValue } from './schema';
import { cellBool, cellDateRange, cellNumber, cellOptionIds, isEmptyCell, optionsOf, parseDateString } from './values';

export const MAX_FILTER_DEPTH = 3;

export interface FilterEnv {
  props: Map<Id, Property>;
  now: number;
  weekStart: WeekStart;
}

export type Condition = Extract<Filter, { prop: string }>;

export function isGroup(f: Filter): f is { and: Filter[] } | { or: Filter[] } {
  return 'and' in f || 'or' in f;
}
export function groupChildren(f: Filter): Filter[] {
  return 'and' in f ? f.and : 'or' in f ? f.or : [];
}
export function groupKind(f: Filter): 'and' | 'or' {
  return 'or' in f ? 'or' : 'and';
}

/** Number of leaf conditions (filter button badge). */
export function countConditions(f: Filter | undefined): number {
  if (!f) return 0;
  if (isGroup(f)) return groupChildren(f).reduce((n, c) => n + countConditions(c), 0);
  return 1;
}

export function filterDepth(f: Filter | undefined): number {
  if (!f || !isGroup(f)) return 0;
  return 1 + Math.max(0, ...groupChildren(f).map(filterDepth));
}

export function cellFor(row: RowDTO, prop: Id | '$created' | '$updated'): CellValue | undefined {
  if (prop === '$created') return { t: 'ts', v: row.createdAt };
  if (prop === '$updated') return { t: 'ts', v: row.updatedAt };
  return row.values[prop];
}

function dayBounds(v: unknown): [number, number] | null {
  const s = typeof v === 'string' ? v : v && typeof v === 'object' && 'start' in v ? String((v as { start: unknown }).start) : null;
  const ts = parseDateString(s);
  if (ts === null) return null;
  return [startOfDay(ts).getTime(), endOfDay(ts).getTime()];
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return [v];
  return [];
}

function textOf(c: CellValue | undefined, p: Property | undefined): string {
  return formatCell(c, p).toLocaleLowerCase();
}

export function evalCondition(row: RowDTO, cond: Condition, env: FilterEnv): boolean {
  const op: FilterOp = cond.op;
  const p = cond.prop === '$created' || cond.prop === '$updated' ? undefined : env.props.get(cond.prop);
  if (!p && cond.prop !== '$created' && cond.prop !== '$updated') return true; // deleted property → ignore
  const c = cellFor(row, cond.prop);
  if (op === 'empty') return isEmptyCell(c);
  if (op === 'not_empty') return !isEmptyCell(c);
  if (op === 'checked') return cellBool(c);
  if (op === 'unchecked') return !cellBool(c);
  const v = cond.value;
  if (opNeedsValue(op) && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) return true;

  const fam = p ? familyOf(p) : 'date';
  if (p?.type === 'relation') {
    const ids = c && c.t === 'relation' ? c.v : [];
    const want = asArray(v);
    const has = want.some((w) => ids.includes(w));
    return op === 'not_contains' ? !has : has;
  }

  switch (fam) {
    case 'text': {
      const s = textOf(c, p);
      const q = String(v).toLocaleLowerCase();
      switch (op) {
        case 'eq':
          return s === q;
        case 'neq':
          return s !== q;
        case 'contains':
          return s.includes(q);
        case 'not_contains':
          return !s.includes(q);
        case 'starts_with':
          return s.startsWith(q);
        case 'ends_with':
          return s.endsWith(q);
        default:
          return true;
      }
    }
    case 'number': {
      const n = cellNumber(c);
      // Values are stored units (progress / percent numbers are fractions; the filter UI converts).
      const q = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(q)) return true;
      if (n === null) return op === 'neq';
      switch (op) {
        case 'eq':
          return Math.abs(n - q) < 1e-9;
        case 'neq':
          return Math.abs(n - q) >= 1e-9;
        case 'gt':
          return n > q;
        case 'gte':
          return n >= q;
        case 'lt':
          return n < q;
        case 'lte':
          return n <= q;
        default:
          return true;
      }
    }
    case 'select':
    case 'status': {
      const id = cellOptionIds(c)[0] ?? null;
      switch (op) {
        case 'eq':
          return id === String(asArray(v)[0] ?? v);
        case 'neq':
          return id !== String(asArray(v)[0] ?? v);
        case 'any_of':
          return !!id && asArray(v).includes(id);
        case 'none_of':
          return !id || !asArray(v).includes(id);
        case 'group_eq': {
          const opt = optionsOf(p).find((o) => o.id === id);
          return !!opt && asArray(v).includes(opt.group ?? 'todo');
        }
        default:
          return true;
      }
    }
    case 'multi': {
      const ids = cellOptionIds(c);
      const want = asArray(v);
      switch (op) {
        case 'any_of':
          return want.some((w) => ids.includes(w));
        case 'all_of':
          return want.every((w) => ids.includes(w));
        case 'none_of':
          return !want.some((w) => ids.includes(w));
        case 'eq':
          return want.some((w) => ids.includes(w));
        default:
          return true;
      }
    }
    case 'date': {
      const r = cellDateRange(c);
      if (op === 'within') {
        const range = withinRange(v as WithinValue, env.now, env.weekStart);
        if (!range || !r) return !r ? false : true;
        return r.start <= range[1] && r.end >= range[0];
      }
      if (op === 'between') {
        const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? [(v as { start?: string }).start, (v as { end?: string }).end] : [];
        const a = dayBounds(arr[0]);
        const b = dayBounds(arr[1] ?? arr[0]);
        if (!a || !b) return true;
        if (!r) return false;
        return r.start <= b[1] && r.end >= a[0];
      }
      const b = dayBounds(v);
      if (!b) return true;
      if (!r) return false;
      switch (op) {
        case 'eq':
          return r.start <= b[1] && r.end >= b[0];
        case 'before':
          return r.start < b[0];
        case 'after':
          return r.start > b[1];
        case 'on_or_before':
          return r.start <= b[1];
        case 'on_or_after':
          return r.start >= b[0] || r.end >= b[0];
        default:
          return true;
      }
    }
    case 'checkbox':
      return true;
    default:
      return true;
  }
}

export function evalFilter(row: RowDTO, f: Filter | undefined, env: FilterEnv, depth = 0): boolean {
  if (!f) return true;
  if ('and' in f) {
    if (depth > MAX_FILTER_DEPTH) return true;
    return f.and.every((c) => evalFilter(row, c, env, depth + 1));
  }
  if ('or' in f) {
    if (depth > MAX_FILTER_DEPTH) return true;
    if (f.or.length === 0) return true;
    return f.or.some((c) => evalFilter(row, c, env, depth + 1));
  }
  return evalCondition(row, f, env);
}

/** Combine two filters with AND (view filter + override). */
export function andFilters(a: Filter | undefined, b: Filter | undefined): Filter | undefined {
  if (!a) return b;
  if (!b) return a;
  return { and: [a, b] };
}

/** Property ids referenced by a filter (to know which computed values to materialise). */
export function filterProps(f: Filter | undefined, out: Set<string> = new Set()): Set<string> {
  if (!f) return out;
  if (isGroup(f)) for (const c of groupChildren(f)) filterProps(c, out);
  else out.add(f.prop);
  return out;
}
