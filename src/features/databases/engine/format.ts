/**
 * Display formatting for database cells (§8.1 configs): number formats, money, dates, options, recurrence.
 * Used by cells, cards, CSV export and the mock's aggregation strings, so every surface reads the same.
 */
import Decimal from 'decimal.js-light';
import { differenceInCalendarDays, format as dfmt, formatDistanceStrict, isValid } from 'date-fns';
import type { CellValue, Property, RecurrenceValue } from '@/backend/types';
import { formatCurrency, formatNumber, MINUS } from '@/lib/format';
import { cellNumber, optionById, parseDateString, plainText } from './values';

export type NumberFormat = 'number' | 'comma' | 'percent';
export type DateFormat = 'full' | 'mdy' | 'dmy' | 'ymd' | 'relative';

export interface NumberConfig {
  format?: NumberFormat;
  decimals?: number;
  display?: 'number' | 'bar' | 'ring';
  divideBy?: number;
}

export function numberConfig(p: Property | undefined): NumberConfig {
  const c = (p?.config ?? {}) as Record<string, unknown>;
  return {
    format: (c.format as NumberFormat) ?? 'number',
    decimals: typeof c.decimals === 'number' ? c.decimals : undefined,
    display: (c.display as NumberConfig['display']) ?? 'number',
    divideBy: typeof c.divideBy === 'number' && c.divideBy > 0 ? c.divideBy : undefined,
  };
}

/** Format a number with a property's number config. */
export function formatNumberValue(n: number, cfg: NumberConfig = {}): string {
  if (!Number.isFinite(n)) return '';
  const d = cfg.decimals;
  const opts: Intl.NumberFormatOptions = d === undefined ? { maximumFractionDigits: 8 } : { minimumFractionDigits: d, maximumFractionDigits: d };
  switch (cfg.format) {
    case 'percent':
      return formatNumber(n * 100, { ...opts, maximumFractionDigits: d ?? 2 }) + '%';
    case 'comma':
      return formatNumber(n, { ...opts, useGrouping: true });
    default:
      return formatNumber(n, { ...opts, useGrouping: false });
  }
}

export function moneyCurrency(p: Property | undefined, c?: CellValue | null): string {
  if (c && c.t === 'money' && c.cur) return c.cur;
  return String(p?.config?.currency ?? 'USD');
}

export function formatMoneyValue(amount: string | number, currency: string, decimals?: number): string {
  let n: number;
  try {
    n = new Decimal(amount).toNumber();
  } catch {
    return '';
  }
  const opts: Intl.NumberFormatOptions = decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  return formatCurrency(n, currency, opts);
}

const DATE_PATTERNS: Record<Exclude<DateFormat, 'relative'>, string> = {
  full: 'MMM d, yyyy',
  mdy: 'MM/dd/yyyy',
  dmy: 'dd/MM/yyyy',
  ymd: 'yyyy-MM-dd',
};

export function formatDay(ts: number, fmt: DateFormat = 'full', now = Date.now()): string {
  const d = new Date(ts);
  if (!isValid(d)) return '';
  if (fmt === 'relative') {
    const diff = differenceInCalendarDays(d, new Date(now));
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff > 1 && diff < 7) return dfmt(d, 'EEEE');
    if (diff < -1 && diff > -7) return 'Last ' + dfmt(d, 'EEEE');
    return dfmt(d, d.getFullYear() === new Date(now).getFullYear() ? 'MMM d' : 'MMM d, yyyy');
  }
  return dfmt(d, DATE_PATTERNS[fmt] ?? DATE_PATTERNS.full);
}

export function formatClock(ts: number, clock: 12 | 24 = 12): string {
  const d = new Date(ts);
  return clock === 24 ? dfmt(d, 'HH:mm') : dfmt(d, d.getMinutes() === 0 ? 'h a' : 'h:mm a');
}

export function formatDateCell(
  v: { start: string; end?: string; time: boolean } | null,
  p?: Property,
  now = Date.now(),
): string {
  if (!v) return '';
  const fmt = (p?.config?.format as DateFormat) ?? 'full';
  const clock = (p?.config?.clock as 12 | 24) ?? 12;
  const one = (s: string) => {
    const ts = parseDateString(s);
    if (ts === null) return '';
    return v.time ? `${formatDay(ts, fmt, now)} ${formatClock(ts, clock)}` : formatDay(ts, fmt, now);
  };
  return v.end && v.end !== v.start ? `${one(v.start)} → ${one(v.end)}` : one(v.start);
}

export function formatTimestamp(ts: number, p?: Property, now = Date.now()): string {
  if (!ts) return '';
  const fmt = (p?.config?.format as DateFormat) ?? 'full';
  if (fmt === 'relative') {
    const diff = now - ts;
    if (Math.abs(diff) < 60_000) return 'Just now';
    if (diff > 0 && diff < 7 * 86_400_000) return formatDistanceStrict(ts, now) + ' ago';
  }
  return `${formatDay(ts, fmt === 'relative' ? 'full' : fmt, now)} ${formatClock(ts, (p?.config?.clock as 12 | 24) ?? 12)}`;
}

const FREQ_LABEL: Record<string, [string, string]> = {
  DAILY: ['day', 'days'],
  WEEKLY: ['week', 'weeks'],
  MONTHLY: ['month', 'months'],
  YEARLY: ['year', 'years'],
};
const DAY_NAMES: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

/** "Every 2 weeks on Mon, Thu" from an RRULE string. */
export function describeRRule(r: RecurrenceValue | null | undefined): string {
  if (!r?.rrule) return '';
  const parts = Object.fromEntries(
    r.rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((kv) => kv.split('=') as [string, string])
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]),
  ) as Record<string, string>;
  const freq = FREQ_LABEL[parts.FREQ];
  if (!freq) return 'Custom';
  const n = Number(parts.INTERVAL ?? 1) || 1;
  let s = n === 1 ? `Every ${freq[0]}` : `Every ${n} ${freq[1]}`;
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',').map((d) => DAY_NAMES[d.slice(-2)] ?? d);
    if (days.length === 5 && !days.includes('Sat') && !days.includes('Sun')) s = n === 1 ? 'Every weekday' : `${s} on weekdays`;
    else s += ` on ${days.join(', ')}`;
  }
  if (parts.BYMONTHDAY) s += ` on day ${parts.BYMONTHDAY}`;
  if (r.mode === 'completion') s += ' after completion';
  return s;
}

export function tickerLabel(sym: string | null | undefined): string {
  if (!sym) return '';
  return sym.split(':')[0] ?? sym;
}

export interface FormatOptions {
  /** Titles for relation ids (UI); defaults to the count. */
  relationTitle?: (id: string) => string | undefined;
  now?: number;
}

/** Plain-text display of a cell (cards, CSV, aggregates, sort fallback). */
export function formatCell(c: CellValue | null | undefined, p: Property | undefined, o: FormatOptions = {}): string {
  if (!c) return '';
  const now = o.now ?? Date.now();
  switch (c.t) {
    case 'text':
      return plainText(c.v);
    case 'number': {
      if (c.v === null || c.v === undefined) return '';
      const cfg = numberConfig(p);
      return formatNumberValue(cfg.divideBy ? c.v / cfg.divideBy : c.v, cfg);
    }
    case 'money':
      return c.v === null || c.v === '' ? '' : formatMoneyValue(c.v, moneyCurrency(p, c), typeof p?.config?.decimals === 'number' ? (p.config.decimals as number) : undefined);
    case 'select':
    case 'status':
      return optionById(p, c.v)?.name ?? '';
    case 'multi':
      return (c.v ?? []).map((id) => optionById(p, id)?.name).filter(Boolean).join(', ');
    case 'date':
      return formatDateCell(c.v, p, now);
    case 'check':
      return c.v ? 'Yes' : 'No';
    case 'url':
    case 'email':
    case 'phone':
      return c.v ?? '';
    case 'files':
      return (c.v ?? []).map((f) => f.name).join(', ');
    case 'relation':
      return (c.v ?? []).map((id) => o.relationTitle?.(id) ?? '').filter(Boolean).join(', ') || (c.v?.length ? `${c.v.length} linked` : '');
    case 'uid':
      return c.v ?? '';
    case 'rating':
      return c.v ? `${c.v}/${Number(p?.config?.max ?? 5)}` : '';
    case 'progress':
      return c.v === null || c.v === undefined ? '' : `${Math.round(c.v * 100)}%`;
    case 'ticker':
      return tickerLabel(c.v);
    case 'recurrence':
      return describeRRule(c.v);
    case 'secret':
      return c.v?.masked ?? '';
    case 'computed':
      return c.v?.display ?? '';
    case 'ts':
      return formatTimestamp(c.v, p, now);
    default:
      return '';
  }
}

/** Machine-friendly value for CSV export (ISO dates, raw numbers). */
export function exportCell(c: CellValue | null | undefined, p: Property | undefined, o: FormatOptions = {}): string {
  if (!c) return '';
  switch (c.t) {
    case 'number':
      return c.v === null ? '' : String(c.v);
    case 'money':
      return c.v ?? '';
    case 'date':
      return c.v ? (c.v.end ? `${c.v.start}/${c.v.end}` : c.v.start) : '';
    case 'ts':
      return c.v ? new Date(c.v).toISOString() : '';
    case 'progress':
      return c.v === null ? '' : String(c.v);
    case 'rating':
      return c.v === null ? '' : String(c.v);
    case 'secret':
      return '';
    case 'ticker':
      return c.v ?? '';
    case 'computed': {
      const v = c.v?.value;
      if ((c.v?.kind === 'number' || c.v?.kind === 'money') && typeof v === 'number') return String(Math.round(v * 1e8) / 1e8);
      return c.v?.display ?? '';
    }
    default:
      return formatCell(c, p, o);
  }
}

/** Compact signed money/number for chips. */
export function signed(n: number): string {
  return n < 0 ? MINUS + Math.abs(n) : String(n);
}

export function cellNumericDisplay(c: CellValue | null | undefined, p: Property | undefined): string {
  const n = cellNumber(c);
  if (n === null) return '';
  return formatCell(c, p);
}
