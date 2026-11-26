/**
 * Multi-level sorting (§8.5): select/status by option order, empty values last (in both directions), locale-aware
 * case- and diacritic-insensitive collation with natural numbers, manual `sortKey` when no sort is active.
 */
import type { Id, Property, RowDTO, Sort } from '@/backend/types';
import { compareKeys } from '@/lib/fractional-index';
import { cellFor } from './filter';
import { formatCell } from './format';
import { familyOf } from './schema';
import { cellBool, cellDateRange, cellNumber, cellOptionIds, isEmptyCell, optionsOf } from './values';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}

type KeyFn = (row: RowDTO) => string | number | null;

function keyFn(prop: Id | '$created' | '$updated', p: Property | undefined): KeyFn {
  if (prop === '$created') return (r) => r.createdAt;
  if (prop === '$updated') return (r) => r.updatedAt;
  if (!p) return () => null;
  const fam = familyOf(p);
  if (p.type === 'select' || p.type === 'status' || p.type === 'multi_select') {
    const opts = optionsOf(p);
    const alpha = p.config?.sort === 'alpha';
    const order = new Map(
      (alpha ? [...opts].sort((x, y) => compareText(x.name, y.name)) : opts).map((o, i) => [o.id, i] as const),
    );
    return (r) => {
      const ids = cellOptionIds(r.values[p.id]);
      if (!ids.length) return null;
      return Math.min(...ids.map((id) => order.get(id) ?? 9999));
    };
  }
  switch (fam) {
    case 'number':
      return (r) => cellNumber(r.values[p.id]);
    case 'date':
      return (r) => cellDateRange(cellFor(r, p.id))?.start ?? null;
    case 'checkbox':
      return (r) => (cellBool(r.values[p.id]) ? 1 : 0);
    default:
      return (r) => {
        const c = r.values[p.id];
        if (isEmptyCell(c)) return null;
        return formatCell(c, p);
      };
  }
}

/** Build a comparator for `sorts` (falls back to manual order, then id for stability). */
export function makeComparator(sorts: Sort[], props: Map<Id, Property>): (a: RowDTO, b: RowDTO) => number {
  const levels = sorts
    .filter((s) => s.prop !== '$manual')
    .map((s) => ({ dir: s.dir === 'desc' ? -1 : 1, key: keyFn(s.prop as Id, props.get(s.prop)) }))
    .filter((l) => !!l.key);
  return (a, b) => {
    for (const l of levels) {
      const ka = l.key(a);
      const kb = l.key(b);
      if (ka === null && kb === null) continue;
      if (ka === null) return 1; // empties last regardless of direction
      if (kb === null) return -1;
      let d: number;
      if (typeof ka === 'number' && typeof kb === 'number') d = ka - kb;
      else d = compareText(String(ka), String(kb));
      if (d !== 0) return d * l.dir;
    }
    const m = compareKeys(a.sortKey, b.sortKey);
    if (m !== 0) return m;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

export function sortProps(sorts: Sort[]): Set<string> {
  return new Set(sorts.map((s) => s.prop));
}
