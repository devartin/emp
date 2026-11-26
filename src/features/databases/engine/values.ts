/**
 * Cell value helpers shared by the databases UI and the browser mock (§8.1). Pure functions, no React.
 *
 * Computed properties (formula, rollup, created/updated time) reach the UI already materialised in `row.values`:
 * formula/rollup → `{t:'computed'}`, created/updated → `{t:'ts'}`.
 */
import type { CellValue, DateValue, Id, Property, PropType, RichText, RowDTO } from '@/backend/types';

export interface SelectOption {
  id: Id;
  name: string;
  color: import('@/backend/types').BlockColor;
  group?: 'todo' | 'in_progress' | 'complete';
}

export const COMPUTED_TYPES: readonly PropType[] = ['rollup', 'formula', 'created_time', 'updated_time', 'computed'];
export const READONLY_TYPES: readonly PropType[] = ['rollup', 'formula', 'created_time', 'updated_time', 'unique_id', 'computed'];

export function isReadOnlyType(t: PropType): boolean {
  return READONLY_TYPES.includes(t);
}

export function rt(text: string): RichText {
  return text ? [{ text }] : [];
}

export function plainText(v: RichText | null | undefined): string {
  if (!v || !Array.isArray(v)) return '';
  let s = '';
  for (const span of v) s += span?.text ?? '';
  return s;
}

export function optionsOf(p: Property | undefined): SelectOption[] {
  const o = p?.config?.options;
  return Array.isArray(o) ? (o as SelectOption[]) : [];
}

export function optionById(p: Property | undefined, id: Id | null | undefined): SelectOption | undefined {
  if (!id) return undefined;
  return optionsOf(p).find((o) => o.id === id);
}

export const STATUS_GROUPS = [
  { id: 'todo', name: 'To-do' },
  { id: 'in_progress', name: 'In progress' },
  { id: 'complete', name: 'Complete' },
] as const;

/** An empty value of the right shape for a property type. */
export function emptyCell(p: Property): CellValue | null {
  switch (p.type) {
    case 'title':
    case 'text':
      return { t: 'text', v: [] };
    case 'number':
      return { t: 'number', v: null };
    case 'money':
      return { t: 'money', v: null, cur: String(p.config.currency ?? 'USD') };
    case 'select':
      return { t: 'select', v: null };
    case 'status':
      return { t: 'status', v: null };
    case 'multi_select':
      return { t: 'multi', v: [] };
    case 'date':
      return { t: 'date', v: null };
    case 'checkbox':
      return { t: 'check', v: false };
    case 'url':
      return { t: 'url', v: null };
    case 'email':
      return { t: 'email', v: null };
    case 'phone':
      return { t: 'phone', v: null };
    case 'files':
      return { t: 'files', v: [] };
    case 'relation':
      return { t: 'relation', v: [] };
    case 'rating':
      return { t: 'rating', v: null };
    case 'progress':
      return { t: 'progress', v: null };
    case 'ticker':
      return { t: 'ticker', v: null };
    case 'recurrence':
      return { t: 'recurrence', v: null };
    case 'secret':
      return { t: 'secret', v: null };
    default:
      return null;
  }
}

export function isEmptyCell(c: CellValue | null | undefined): boolean {
  if (!c) return true;
  switch (c.t) {
    case 'text':
      return plainText(c.v).trim() === '';
    case 'number':
    case 'rating':
    case 'progress':
      return c.v === null || c.v === undefined || Number.isNaN(c.v);
    case 'money':
      return c.v === null || c.v === undefined || c.v === '';
    case 'select':
    case 'status':
    case 'ticker':
    case 'recurrence':
    case 'secret':
    case 'date':
      return !c.v;
    case 'url':
    case 'email':
    case 'phone':
    case 'uid':
      return !c.v;
    case 'multi':
    case 'files':
    case 'relation':
      return !c.v || c.v.length === 0;
    case 'check':
      return !c.v;
    case 'computed': {
      const k = c.v?.kind;
      if (k === 'error') return true;
      const val = c.v?.value;
      if (val === null || val === undefined || val === '') return true;
      if (Array.isArray(val)) return val.length === 0;
      return false;
    }
    case 'ts':
      return !c.v;
    default:
      return true;
  }
}

/** Numeric projection (number, money, rating, progress, numeric computed). */
export function cellNumber(c: CellValue | null | undefined): number | null {
  if (!c) return null;
  switch (c.t) {
    case 'number':
    case 'rating':
    case 'progress':
      return typeof c.v === 'number' && Number.isFinite(c.v) ? c.v : null;
    case 'money': {
      if (c.v === null || c.v === '') return null;
      const n = Number(c.v);
      return Number.isFinite(n) ? n : null;
    }
    case 'computed': {
      const v = c.v?.value;
      if ((c.v?.kind === 'number' || c.v?.kind === 'money') && v !== null && v !== undefined) {
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }
    case 'check':
      return c.v ? 1 : 0;
    case 'ts':
      return c.v;
    default:
      return null;
  }
}

/** Date projection as epoch ms (start, end). All-day dates are local midnight. */
export function cellDateRange(c: CellValue | null | undefined): { start: number; end: number; allDay: boolean } | null {
  if (!c) return null;
  if (c.t === 'date') {
    if (!c.v) return null;
    const s = parseDateString(c.v.start);
    if (s === null) return null;
    const e = c.v.end ? parseDateString(c.v.end) : null;
    return { start: s, end: e ?? s, allDay: !c.v.time };
  }
  if (c.t === 'ts') return c.v ? { start: c.v, end: c.v, allDay: false } : null;
  if (c.t === 'computed' && c.v?.kind === 'date') {
    const v = c.v.value;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseDateString(v) : null;
    return n === null ? null : { start: n, end: n, allDay: false };
  }
  return null;
}

/** 'YYYY-MM-DD' → local midnight; RFC 3339 → instant. */
export function parseDateString(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function isoDayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dateValueDay(day: string, end?: string): DateValue {
  return end && end !== day ? { start: day, end, time: false } : { start: day, time: false };
}

/** Option ids held by a select / status / multi cell. */
export function cellOptionIds(c: CellValue | null | undefined): Id[] {
  if (!c) return [];
  if (c.t === 'select' || c.t === 'status') return c.v ? [c.v] : [];
  if (c.t === 'multi') return c.v ?? [];
  return [];
}

export function cellBool(c: CellValue | null | undefined): boolean {
  if (!c) return false;
  if (c.t === 'check') return !!c.v;
  if (c.t === 'computed') return c.v?.kind === 'bool' ? !!c.v.value : false;
  return !isEmptyCell(c);
}

export function rowTitle(row: RowDTO | undefined, primaryPropId: Id): string {
  if (!row) return '';
  const c = row.values[primaryPropId];
  return c && c.t === 'text' ? plainText(c.v) : '';
}

/** Shallow structural equality for cells (optimistic reconcile). */
export function sameCell(a: CellValue | null | undefined, b: CellValue | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Result type of a computed property, for filters/aggregations (formula & rollup). */
export function computedKindOf(p: Property): string | undefined {
  const k = p.config?.resultType;
  return typeof k === 'string' ? k : undefined;
}
