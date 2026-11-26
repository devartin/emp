/**
 * Grouping (§8.5): select, status (by option or by group), multi-select (a row appears in each group), checkbox,
 * dates (relative/day/week/month/year), relation, and text (exact value). "No value" is its own group.
 */
import type { BlockColor, GroupBy, Id, Property, RowDTO } from '@/backend/types';
import { bucketOf, type WeekStart } from './dates';
import { cellFor } from './filter';
import { formatCell } from './format';
import { compareText } from './sort';
import { cellBool, cellDateRange, cellOptionIds, isEmptyCell, optionsOf, STATUS_GROUPS } from './values';

export const NO_VALUE = '__none';

export interface GroupKey {
  key: string;
  label: string;
  color?: BlockColor;
  /** Sort order of the group. */
  order: number;
}

export interface GroupEnv {
  now: number;
  weekStart: WeekStart;
  relationTitle?: (id: Id) => string | undefined;
}

const STATUS_GROUP_COLOR: Record<string, BlockColor> = { todo: 'gray', in_progress: 'blue', complete: 'green' };

export function noValueLabel(p: Property): string {
  if (p.type === 'checkbox') return 'Unchecked';
  return `No ${p.name}`;
}

/** The groups a row belongs to. */
export function rowGroupKeys(row: RowDTO, g: GroupBy, p: Property, env: GroupEnv): GroupKey[] {
  const none: GroupKey = { key: NO_VALUE, label: noValueLabel(p), order: -1 };
  const c = cellFor(row, p.id);
  switch (p.type) {
    case 'select':
    case 'status':
    case 'multi_select': {
      const opts = optionsOf(p);
      const ids = cellOptionIds(c);
      if (!ids.length) return [none];
      if (p.type === 'status' && g.byStatusGroup) {
        const o = opts.find((x) => x.id === ids[0]);
        const gid = o?.group ?? 'todo';
        const gi = STATUS_GROUPS.findIndex((x) => x.id === gid);
        return [{ key: gid, label: STATUS_GROUPS[gi]?.name ?? gid, color: STATUS_GROUP_COLOR[gid], order: gi }];
      }
      return ids
        .map((id): GroupKey | null => {
          const i = opts.findIndex((o) => o.id === id);
          return i < 0 ? null : { key: id, label: opts[i].name, color: opts[i].color, order: i };
        })
        .filter((x): x is GroupKey => !!x);
    }
    case 'checkbox':
      return cellBool(c) ? [{ key: 'true', label: 'Checked', order: 1 }] : [{ key: 'false', label: 'Unchecked', order: 0 }];
    case 'date':
    case 'created_time':
    case 'updated_time': {
      const r = cellDateRange(c);
      if (!r) return [{ ...none, order: Number.MAX_SAFE_INTEGER }];
      const b = bucketOf(r.start, g.dateBucket ?? 'relative', env.now, env.weekStart);
      return [{ key: b.key, label: b.label, order: b.order }];
    }
    case 'relation': {
      const ids = c && c.t === 'relation' ? c.v : [];
      if (!ids.length) return [none];
      return ids.map((id) => ({ key: id, label: env.relationTitle?.(id) || 'Untitled', order: 0 }));
    }
    default: {
      if (isEmptyCell(c)) return [{ ...none, order: Number.MAX_SAFE_INTEGER }];
      const s = formatCell(c, p);
      return [{ key: 'v:' + s, label: s, order: 0 }];
    }
  }
}

/** Groups that exist even when empty (every option, both checkbox states). */
export function staticGroups(g: GroupBy, p: Property): GroupKey[] {
  if (p.type === 'select' || p.type === 'multi_select' || (p.type === 'status' && !g.byStatusGroup)) {
    return [
      { key: NO_VALUE, label: noValueLabel(p), order: -1 },
      ...optionsOf(p).map((o, i) => ({ key: o.id, label: o.name, color: o.color, order: i })),
    ];
  }
  if (p.type === 'status' && g.byStatusGroup) {
    return STATUS_GROUPS.map((s, i) => ({ key: s.id, label: s.name, color: STATUS_GROUP_COLOR[s.id], order: i }));
  }
  if (p.type === 'checkbox') {
    return [
      { key: 'false', label: 'Unchecked', order: 0 },
      { key: 'true', label: 'Checked', order: 1 },
    ];
  }
  return [];
}

/** Order groups: manual `order` first, then natural order, then label. */
export function orderGroups(groups: GroupKey[], g: GroupBy): GroupKey[] {
  const manual = new Map((g.order ?? []).map((k, i) => [k, i] as const));
  return [...groups].sort((a, b) => {
    const ma = manual.get(a.key);
    const mb = manual.get(b.key);
    if (ma !== undefined && mb !== undefined) return ma - mb;
    if (ma !== undefined) return -1;
    if (mb !== undefined) return 1;
    if (a.order !== b.order) return a.order - b.order;
    return compareText(a.label, b.label);
  });
}
