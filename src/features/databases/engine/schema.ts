/**
 * Property-type metadata (§8.1, §8.4, §8.5): labels, filter operators, aggregate functions, groupability and the
 * default config of each of the 25 v1 types. Formula and rollup use the operators of their result type.
 */
import type { AggFn, FilterOp, Property, PropType } from '@/backend/types';

export type TypeFamily = 'text' | 'number' | 'select' | 'status' | 'multi' | 'date' | 'checkbox' | 'relation' | 'files' | 'other';

export interface TypeMeta {
  type: PropType;
  label: string;
  family: TypeFamily;
  description: string;
  /** Can be created from the "+ property" menu. */
  creatable: boolean;
}

export const TYPE_META: Record<PropType, TypeMeta> = {
  title: { type: 'title', label: 'Title', family: 'text', description: 'The name of each row', creatable: false },
  text: { type: 'text', label: 'Text', family: 'text', description: 'Notes, descriptions, anything', creatable: true },
  number: { type: 'number', label: 'Number', family: 'number', description: 'Numbers, percentages, bars', creatable: true },
  money: { type: 'money', label: 'Money', family: 'number', description: 'Exact amounts with a currency', creatable: true },
  select: { type: 'select', label: 'Select', family: 'select', description: 'One option from a list', creatable: true },
  multi_select: { type: 'multi_select', label: 'Multi-select', family: 'multi', description: 'Several tags', creatable: true },
  status: { type: 'status', label: 'Status', family: 'status', description: 'To-do, in progress, complete', creatable: true },
  date: { type: 'date', label: 'Date', family: 'date', description: 'A day, a time or a range', creatable: true },
  checkbox: { type: 'checkbox', label: 'Checkbox', family: 'checkbox', description: 'Done or not', creatable: true },
  url: { type: 'url', label: 'URL', family: 'text', description: 'A web link', creatable: true },
  email: { type: 'email', label: 'Email', family: 'text', description: 'An email address', creatable: true },
  phone: { type: 'phone', label: 'Phone', family: 'text', description: 'A phone number', creatable: true },
  files: { type: 'files', label: 'Files & media', family: 'files', description: 'Attachments and images', creatable: true },
  relation: { type: 'relation', label: 'Relation', family: 'relation', description: 'Link rows in another database', creatable: true },
  rollup: { type: 'rollup', label: 'Rollup', family: 'other', description: 'Summarise related rows', creatable: true },
  formula: { type: 'formula', label: 'Formula', family: 'other', description: 'Compute from other properties', creatable: true },
  created_time: { type: 'created_time', label: 'Created time', family: 'date', description: 'When the row was created', creatable: true },
  updated_time: { type: 'updated_time', label: 'Last edited', family: 'date', description: 'When the row last changed', creatable: true },
  unique_id: { type: 'unique_id', label: 'ID', family: 'text', description: 'Auto-incrementing ID like TASK-12', creatable: true },
  rating: { type: 'rating', label: 'Rating', family: 'number', description: 'Stars or hearts', creatable: true },
  progress: { type: 'progress', label: 'Progress', family: 'number', description: 'A bar or ring from 0–100%', creatable: true },
  ticker: { type: 'ticker', label: 'Ticker', family: 'text', description: 'A stock, fund or crypto symbol', creatable: true },
  recurrence: { type: 'recurrence', label: 'Repeat', family: 'other', description: 'Repeats on a schedule', creatable: true },
  secret: { type: 'secret', label: 'Secret', family: 'other', description: 'Encrypted, masked, re-auth to reveal', creatable: true },
  computed: { type: 'computed', label: 'Computed', family: 'other', description: 'Maintained by a life app', creatable: false },
};

export const CREATE_ORDER: PropType[] = [
  'text', 'number', 'money', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'files', 'relation',
  'rollup', 'formula', 'created_time', 'updated_time', 'unique_id', 'rating', 'progress', 'ticker', 'recurrence', 'secret',
];

/** Result family of a formula/rollup from its cached result type ('number'|'money'|'text'|'bool'|'date'|'list'). */
export function resultFamily(kind: string | undefined): TypeFamily {
  switch (kind) {
    case 'number':
    case 'money':
      return 'number';
    case 'bool':
      return 'checkbox';
    case 'date':
      return 'date';
    default:
      return 'text';
  }
}

export function familyOf(p: Pick<Property, 'type' | 'config'>): TypeFamily {
  if (p.type === 'formula' || p.type === 'rollup' || p.type === 'computed') {
    return resultFamily(typeof p.config?.resultType === 'string' ? (p.config.resultType as string) : undefined);
  }
  if (p.type === 'recurrence' || p.type === 'secret') return 'other';
  return TYPE_META[p.type]?.family ?? 'other';
}

const TEXT_OPS: FilterOp[] = ['contains', 'not_contains', 'eq', 'neq', 'starts_with', 'ends_with', 'empty', 'not_empty'];
const NUM_OPS: FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'];
const SELECT_OPS: FilterOp[] = ['eq', 'neq', 'any_of', 'none_of', 'empty', 'not_empty'];
const MULTI_OPS: FilterOp[] = ['any_of', 'all_of', 'none_of', 'empty', 'not_empty'];
const DATE_OPS: FilterOp[] = ['eq', 'before', 'after', 'on_or_before', 'on_or_after', 'between', 'within', 'empty', 'not_empty'];

export function operatorsFor(p: Pick<Property, 'type' | 'config'>): FilterOp[] {
  if (p.type === 'status') return [...SELECT_OPS.slice(0, 4), 'group_eq', 'empty', 'not_empty'];
  if (p.type === 'files') return ['empty', 'not_empty'];
  if (p.type === 'relation') return ['contains', 'not_contains', 'empty', 'not_empty'];
  if (p.type === 'secret' || p.type === 'recurrence') return ['empty', 'not_empty'];
  switch (familyOf(p)) {
    case 'text':
      return TEXT_OPS;
    case 'number':
      return NUM_OPS;
    case 'select':
      return SELECT_OPS;
    case 'multi':
      return MULTI_OPS;
    case 'date':
      return DATE_OPS;
    case 'checkbox':
      return ['checked', 'unchecked'];
    default:
      return ['empty', 'not_empty'];
  }
}

export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  empty: 'is empty',
  not_empty: 'is not empty',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'is between',
  any_of: 'is any of',
  none_of: 'is none of',
  all_of: 'has all of',
  group_eq: 'is in group',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
  within: 'is within',
  checked: 'is checked',
  unchecked: 'is unchecked',
};

export function opNeedsValue(op: FilterOp): boolean {
  return !['empty', 'not_empty', 'checked', 'unchecked'].includes(op);
}

export const AGG_LABEL: Record<AggFn, string> = {
  count: 'Count all',
  count_values: 'Count values',
  count_unique: 'Count unique',
  empty: 'Count empty',
  not_empty: 'Count not empty',
  pct_empty: 'Percent empty',
  pct_not_empty: 'Percent not empty',
  sum: 'Sum',
  avg: 'Average',
  median: 'Median',
  min: 'Min',
  max: 'Max',
  range: 'Range',
  earliest: 'Earliest',
  latest: 'Latest',
  checked: 'Checked',
  unchecked: 'Unchecked',
  pct_checked: 'Percent checked',
};

/** Short prefix shown in the footer cell before the value. */
export const AGG_SHORT: Record<AggFn, string> = {
  count: 'Count',
  count_values: 'Values',
  count_unique: 'Unique',
  empty: 'Empty',
  not_empty: 'Not empty',
  pct_empty: 'Empty',
  pct_not_empty: 'Not empty',
  sum: 'Sum',
  avg: 'Avg',
  median: 'Median',
  min: 'Min',
  max: 'Max',
  range: 'Range',
  earliest: 'Earliest',
  latest: 'Latest',
  checked: 'Done',
  unchecked: 'Left',
  pct_checked: 'Done',
};

const BASE_AGGS: AggFn[] = ['count', 'count_values', 'count_unique', 'empty', 'not_empty', 'pct_empty', 'pct_not_empty'];

export function aggsFor(p: Pick<Property, 'type' | 'config'>): AggFn[] {
  switch (familyOf(p)) {
    case 'number':
      return [...BASE_AGGS, 'sum', 'avg', 'median', 'min', 'max', 'range'];
    case 'date':
      return [...BASE_AGGS, 'earliest', 'latest', 'range'];
    case 'checkbox':
      return ['count', 'checked', 'unchecked', 'pct_checked'];
    default:
      return BASE_AGGS;
  }
}

export const GROUPABLE_TYPES: PropType[] = ['select', 'status', 'multi_select', 'checkbox', 'date', 'created_time', 'updated_time', 'relation', 'text', 'title', 'url', 'email', 'phone', 'rating'];

export function isGroupable(p: Pick<Property, 'type'>): boolean {
  return GROUPABLE_TYPES.includes(p.type);
}

/** Board columns come from select / status / checkbox (§8.3). */
export function isBoardGroupable(p: Pick<Property, 'type'>): boolean {
  return p.type === 'select' || p.type === 'status' || p.type === 'checkbox' || p.type === 'multi_select';
}

export function isDateLike(p: Pick<Property, 'type' | 'config'>): boolean {
  return familyOf(p) === 'date';
}

export function isNumeric(p: Pick<Property, 'type' | 'config'>): boolean {
  return familyOf(p) === 'number';
}

export const DEFAULT_STATUS_OPTIONS = [
  { name: 'Not started', color: 'gray', group: 'todo' },
  { name: 'In progress', color: 'blue', group: 'in_progress' },
  { name: 'Done', color: 'green', group: 'complete' },
] as const;

/** Default config for a new property of `type` (the mock adds ids to options). */
export function defaultConfig(type: PropType): Record<string, unknown> {
  switch (type) {
    case 'number':
      return { format: 'number', display: 'number' };
    case 'money':
      return { currency: 'USD', perRowCurrency: false, decimals: 2 };
    case 'select':
    case 'multi_select':
      return { options: [], sort: 'manual' };
    case 'status':
      return { options: DEFAULT_STATUS_OPTIONS.map((o) => ({ ...o })), sort: 'manual' };
    case 'date':
      return { format: 'full', clock: 12 };
    case 'created_time':
    case 'updated_time':
      return { format: 'full', clock: 12 };
    case 'unique_id':
      return { prefix: '' };
    case 'rating':
      return { max: 5, icon: 'star' };
    case 'progress':
      return { display: 'bar' };
    case 'ticker':
      return { showQuote: true };
    case 'relation':
      return { targetDatabaseId: null, dual: null, limit: 'many' };
    case 'rollup':
      return { relationPropId: null, targetPropId: null, fn: 'count_all' };
    case 'formula':
      return { expression: '' };
    default:
      return {};
  }
}

export const ROLLUP_FNS: { fn: string; label: string; family?: TypeFamily[] }[] = [
  { fn: 'show_original', label: 'Show original' },
  { fn: 'show_unique', label: 'Show unique values' },
  { fn: 'count_all', label: 'Count all' },
  { fn: 'count_values', label: 'Count values' },
  { fn: 'count_unique', label: 'Count unique values' },
  { fn: 'count_empty', label: 'Count empty' },
  { fn: 'count_not_empty', label: 'Count not empty' },
  { fn: 'pct_empty', label: 'Percent empty' },
  { fn: 'pct_not_empty', label: 'Percent not empty' },
  { fn: 'sum', label: 'Sum', family: ['number'] },
  { fn: 'average', label: 'Average', family: ['number'] },
  { fn: 'median', label: 'Median', family: ['number'] },
  { fn: 'min', label: 'Min', family: ['number'] },
  { fn: 'max', label: 'Max', family: ['number'] },
  { fn: 'range', label: 'Range', family: ['number'] },
  { fn: 'earliest', label: 'Earliest date', family: ['date'] },
  { fn: 'latest', label: 'Latest date', family: ['date'] },
  { fn: 'date_range', label: 'Date range', family: ['date'] },
  { fn: 'checked', label: 'Checked', family: ['checkbox'] },
  { fn: 'unchecked', label: 'Unchecked', family: ['checkbox'] },
  { fn: 'pct_checked', label: 'Percent checked', family: ['checkbox'] },
  { fn: 'pct_unchecked', label: 'Percent unchecked', family: ['checkbox'] },
];
