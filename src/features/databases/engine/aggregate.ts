/**
 * Footer and group aggregates (§8.5 AggFn). Money sums run in Decimal so they are exact; results come back as
 * display strings formatted with the property's own format.
 */
import Decimal from 'decimal.js-light';
import type { AggFn, CellValue, Property } from '@/backend/types';
import { formatCurrency, formatNumber } from '@/lib/format';
import { formatDay, formatMoneyValue, formatNumberValue, moneyCurrency, numberConfig } from './format';
import { familyOf } from './schema';
import { cellBool, cellDateRange, cellNumber, isEmptyCell } from './values';
import { formatCell } from './format';

function pct(n: number, d: number): string {
  if (!d) return '0%';
  return formatNumber((n / d) * 100, { maximumFractionDigits: 1 }) + '%';
}

function fmtNum(n: number, p: Property, cells: (CellValue | undefined)[]): string {
  if (p.type === 'money' || (p.type !== 'number' && cells.some((c) => c?.t === 'money' || (c?.t === 'computed' && c.v?.kind === 'money')))) {
    const cur = moneyCurrency(p, cells.find((c) => c?.t === 'money'));
    return formatCurrency(n, cur, Number.isInteger(n) || Math.abs(n) >= 1000 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {});
  }
  if (p.type === 'progress') return formatNumber(n * 100, { maximumFractionDigits: 1 }) + '%';
  if (p.type === 'rating') return formatNumber(n, { maximumFractionDigits: 1 });
  if (p.type === 'number') {
    const cfg = numberConfig(p);
    return formatNumberValue(cfg.divideBy ? n / cfg.divideBy : n, { ...cfg, format: cfg.format === 'number' ? 'comma' : cfg.format, decimals: cfg.decimals ?? (Number.isInteger(n) ? 0 : 2) });
  }
  return formatNumber(n, { maximumFractionDigits: 2 });
}

/** Returns the display string for an aggregate over a column (already filtered). */
export function aggregate(fn: AggFn, cells: (CellValue | undefined)[], p: Property): string {
  const total = cells.length;
  switch (fn) {
    case 'count':
      return formatNumber(total);
    case 'count_values': {
      let n = 0;
      for (const c of cells) {
        if (!c || isEmptyCell(c)) continue;
        if (c.t === 'multi' || c.t === 'relation' || c.t === 'files') n += c.v.length;
        else n += 1;
      }
      return formatNumber(n);
    }
    case 'count_unique': {
      const s = new Set<string>();
      for (const c of cells) {
        if (!c || isEmptyCell(c)) continue;
        if (c.t === 'multi' || c.t === 'relation') for (const v of c.v) s.add(v);
        else s.add(formatCell(c, p));
      }
      return formatNumber(s.size);
    }
    case 'empty':
      return formatNumber(cells.filter((c) => isEmptyCell(c)).length);
    case 'not_empty':
      return formatNumber(cells.filter((c) => !isEmptyCell(c)).length);
    case 'pct_empty':
      return pct(cells.filter((c) => isEmptyCell(c)).length, total);
    case 'pct_not_empty':
      return pct(cells.filter((c) => !isEmptyCell(c)).length, total);
    case 'checked':
      return formatNumber(cells.filter((c) => cellBool(c)).length);
    case 'unchecked':
      return formatNumber(cells.filter((c) => !cellBool(c)).length);
    case 'pct_checked':
      return pct(cells.filter((c) => cellBool(c)).length, total);
    case 'earliest':
    case 'latest': {
      const ds = cells.map((c) => cellDateRange(c)?.start).filter((x): x is number => typeof x === 'number');
      if (!ds.length) return '';
      return formatDay(fn === 'earliest' ? Math.min(...ds) : Math.max(...ds), 'full');
    }
    default:
      break;
  }
  // numeric (or date range)
  if (familyOf(p) === 'date') {
    if (fn !== 'range') return '';
    const ds = cells.map((c) => cellDateRange(c)?.start).filter((x): x is number => typeof x === 'number');
    if (!ds.length) return '';
    const days = Math.round((Math.max(...ds) - Math.min(...ds)) / 86_400_000);
    return `${formatNumber(days)} ${days === 1 ? 'day' : 'days'}`;
  }
  const isMoney = p.type === 'money';
  if (isMoney && (fn === 'sum' || fn === 'avg' || fn === 'range' || fn === 'min' || fn === 'max' || fn === 'median')) {
    const ds: Decimal[] = [];
    let cur = String(p.config?.currency ?? 'USD');
    for (const c of cells) {
      if (c && c.t === 'money' && c.v !== null && c.v !== '') {
        try {
          ds.push(new Decimal(c.v));
          if (c.cur) cur = c.cur;
        } catch {
          /* skip unparsable */
        }
      }
    }
    if (!ds.length) return fn === 'sum' ? formatMoneyValue(0, cur, typeof p.config?.decimals === 'number' ? (p.config.decimals as number) : undefined) : '';
    const sorted = [...ds].sort((a, b) => a.comparedTo(b));
    const sum = ds.reduce((a, b) => a.plus(b), new Decimal(0));
    let out: Decimal;
    switch (fn) {
      case 'sum':
        out = sum;
        break;
      case 'avg':
        out = sum.dividedBy(ds.length);
        break;
      case 'min':
        out = sorted[0];
        break;
      case 'max':
        out = sorted[sorted.length - 1];
        break;
      case 'range':
        out = sorted[sorted.length - 1].minus(sorted[0]);
        break;
      default: {
        const m = Math.floor(sorted.length / 2);
        out = sorted.length % 2 ? sorted[m] : sorted[m - 1].plus(sorted[m]).dividedBy(2);
      }
    }
    return formatMoneyValue(out.toString(), cur, typeof p.config?.decimals === 'number' ? (p.config.decimals as number) : undefined);
  }
  const ns = cells.map((c) => cellNumber(c)).filter((x): x is number => x !== null);
  if (!ns.length) return fn === 'sum' ? fmtNum(0, p, cells) : '';
  const sorted = [...ns].sort((a, b) => a - b);
  const sum = ns.reduce((a, b) => a + b, 0);
  switch (fn) {
    case 'sum':
      return fmtNum(sum, p, cells);
    case 'avg':
      return fmtNum(sum / ns.length, p, cells);
    case 'min':
      return fmtNum(sorted[0], p, cells);
    case 'max':
      return fmtNum(sorted[sorted.length - 1], p, cells);
    case 'range':
      return fmtNum(sorted[sorted.length - 1] - sorted[0], p, cells);
    case 'median': {
      const m = Math.floor(sorted.length / 2);
      return fmtNum(sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2, p, cells);
    }
    default:
      return '';
  }
}

/** Raw numeric aggregate for charts (count / sum / avg / min / max / median). */
export function aggregateNumber(fn: AggFn, cells: (CellValue | undefined)[]): number | null {
  if (fn === 'count') return cells.length;
  if (fn === 'count_values' || fn === 'not_empty') return cells.filter((c) => !isEmptyCell(c)).length;
  if (fn === 'empty') return cells.filter((c) => isEmptyCell(c)).length;
  if (fn === 'checked') return cells.filter((c) => cellBool(c)).length;
  if (fn === 'unchecked') return cells.filter((c) => !cellBool(c)).length;
  const ns = cells.map((c) => cellNumber(c)).filter((x): x is number => x !== null);
  if (!ns.length) return fn === 'sum' ? 0 : null;
  const sorted = [...ns].sort((a, b) => a - b);
  const sum = ns.reduce((a, b) => a + b, 0);
  switch (fn) {
    case 'sum':
      return sum;
    case 'avg':
      return sum / ns.length;
    case 'min':
      return sorted[0];
    case 'max':
      return sorted[sorted.length - 1];
    case 'range':
      return sorted[sorted.length - 1] - sorted[0];
    case 'median': {
      const m = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    }
    default:
      return ns.length;
  }
}
