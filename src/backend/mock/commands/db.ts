/**
 * Databases mock (§8, §11.3 "Databases"): schemas, properties (25 v1 types), views, rows, templates, relations with
 * two-way duals, rollups, formulas (§14.6 in TS), filter/sort/group/aggregate, chart data, CSV/XLSX import and
 * CSV/XLSX export. Everything runs on in-memory tables:
 *
 *   db_databases · db_properties · db_views · db_rows · db_secrets
 *
 * Database id === its page id (kind 'database'). Computed values (formula, rollup, created/updated time) are
 * materialised per query with a cache keyed by the data/schema revs of the database and the databases it relates
 * to. Other mocks (life apps, finance) create databases through `ctx.services.get('db.api')` — see `DbApi`.
 */
import { BackendError } from '../../errors';
import type {
  AggFn, CellValue, ChartData, ChartSpec, DbInfo, DbQueryGroup, DbQueryReq, DbQueryResult, DbSchema, Filter, GroupBy, Icon, Id,
  PageMeta, Property, PropType, RichText, RowDTO, RowTemplate, Sort, TipTapDoc, View, Layout, BlockColor, SelectOptionInput,
} from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import { fnv1a } from '@/lib/hash';
import { compareKeys, generateNKeysBetween } from '@/lib/fractional-index';
import { aggregate, aggregateNumber } from '@/features/databases/engine/aggregate';
import { bucketOf, bucketSeries, type WeekStart } from '@/features/databases/engine/dates';
import { andFilters, cellFor, evalFilter, type FilterEnv } from '@/features/databases/engine/filter';
import { exportCell, formatCell } from '@/features/databases/engine/format';
import {
  cellToValue, compile, evaluate, FormulaError, FRow, toComputed, type Compiled, type FormulaHost, type FValue, type ResultKind,
  kindOf, toStorage,
} from '@/features/databases/engine/formula';
import { NO_VALUE, orderGroups, rowGroupKeys, staticGroups, type GroupKey } from '@/features/databases/engine/group';
import { defaultConfig, isDateLike, TYPE_META } from '@/features/databases/engine/schema';
import { makeComparator } from '@/features/databases/engine/sort';
import {
  cellDateRange, isEmptyCell, isReadOnlyType, optionsOf, plainText, rt, type SelectOption,
} from '@/features/databases/engine/values';
import { inferType, parseBool, parseCsv, parseDateInput, parseMoney, parseNumber, detectDelimiter, toCsv } from '@/features/databases/engine/csv';
import { readXlsx, writeXlsx } from '@/features/databases/engine/xlsx';
import { nextTagColor } from '@/ui/Tag';

// ───────────────────────────────────────────────────────────────────────────── records

export interface DbRecord {
  id: Id;
  primaryPropId: Id;
  schemaRev: number;
  dataRev: number;
  description?: RichText;
  templates: RowTemplate[];
  defaultTemplateId?: Id;
  hideEmptyProps: boolean;
  roles: Record<string, Id>;
  appInstanceId?: Id;
  /** unique_id property → last issued number. */
  uidSeq: Record<Id, number>;
  createdAt: number;
}

export interface PropRecord extends Property {
  databaseId: Id;
  deletedAt?: number;
}

export interface ViewRecord extends View {
  databaseId: Id;
}

export interface RowRecord {
  id: Id;
  databaseId: Id;
  rev: number;
  sortKey: string;
  createdAt: number;
  updatedAt: number;
  values: Record<Id, CellValue>;
  icon?: Icon;
  sample?: boolean;
  deletedAt?: number;
}

interface SecretRec {
  id: string;
  value: string;
}

const T = {
  dbs: (ctx: MockCtx) => ctx.db.table<DbRecord>('db_databases'),
  props: (ctx: MockCtx) => ctx.db.table<PropRecord>('db_properties'),
  views: (ctx: MockCtx) => ctx.db.table<ViewRecord>('db_views'),
  rows: (ctx: MockCtx) => ctx.db.table<RowRecord>('db_rows'),
  secrets: (ctx: MockCtx) => ctx.db.table<SecretRec>('db_secrets'),
};

// ───────────────────────────────────────────────────────────────────────────── per-boot caches

interface Engine {
  mat: Map<Id, { key: string; rows: RowDTO[]; byId: Map<Id, RowDTO> }>;
  queries: Map<string, { order: RowDTO[]; groups?: { g: GroupKey; rows: RowDTO[] }[]; filtered: RowDTO[] }>;
  compiled: Map<string, Compiled | FormulaError>;
  rowIndex: { version: number; byDb: Map<Id, RowRecord[]> } | null;
}
const engines = new WeakMap<object, Engine>();
function eng(ctx: MockCtx): Engine {
  let e = engines.get(ctx.db);
  if (!e) {
    e = { mat: new Map(), queries: new Map(), compiled: new Map(), rowIndex: null };
    engines.set(ctx.db, e);
  }
  return e;
}

const fail = (code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'TOO_LARGE', msg: string, field?: string): never => {
  throw new BackendError(code, msg, field ? { field } : undefined);
};

// ───────────────────────────────────────────────────────────────────────────── basic accessors

export function requireDb(ctx: MockCtx, id: Id): DbRecord {
  const db = T.dbs(ctx).get(id);
  if (!db) fail('NOT_FOUND', 'Database not found');
  const page = ctx.pages.get(id);
  if (!page || page.deletedAt) fail('NOT_FOUND', 'Database not found');
  return db!;
}

export function propsOf(ctx: MockCtx, dbId: Id): PropRecord[] {
  return T.props(ctx)
    .filter((p) => p.databaseId === dbId && !p.deletedAt)
    .sort((a, b) => compareKeys(a.sortKey, b.sortKey));
}

function viewsOf(ctx: MockCtx, dbId: Id): ViewRecord[] {
  return T.views(ctx)
    .filter((v) => v.databaseId === dbId)
    .sort((a, b) => compareKeys(a.sortKey, b.sortKey));
}

function rowIndex(ctx: MockCtx): Map<Id, RowRecord[]> {
  const e = eng(ctx);
  const version = ctx.db.version;
  if (e.rowIndex && e.rowIndex.version === version) return e.rowIndex.byDb;
  const byDb = new Map<Id, RowRecord[]>();
  for (const r of T.rows(ctx).values()) {
    if (r.deletedAt) continue;
    let list = byDb.get(r.databaseId);
    if (!list) byDb.set(r.databaseId, (list = []));
    list.push(r);
  }
  e.rowIndex = { version, byDb };
  return byDb;
}

export function liveRows(ctx: MockCtx, dbId: Id): RowRecord[] {
  return rowIndex(ctx).get(dbId) ?? [];
}

function requireRow(ctx: MockCtx, id: Id): RowRecord {
  const r = T.rows(ctx).get(id);
  if (!r || r.deletedAt) fail('NOT_FOUND', 'Row not found');
  return r!;
}

function requireProp(ctx: MockCtx, id: Id): PropRecord {
  const p = T.props(ctx).get(id);
  if (!p || p.deletedAt) fail('NOT_FOUND', 'Property not found');
  return p!;
}

function requireView(ctx: MockCtx, id: Id): ViewRecord {
  const v = T.views(ctx).get(id);
  if (!v) fail('NOT_FOUND', 'View not found');
  return v!;
}

function stripProp({ databaseId: _d, deletedAt: _x, ...p }: PropRecord): Property {
  return p;
}
function stripView({ databaseId: _d, ...v }: ViewRecord): View {
  return v;
}

function weekStart(ctx: MockCtx): WeekStart {
  const s = ctx.db.meta<{ weekStart?: WeekStart }>('vault.settings');
  return (s?.weekStart ?? 1) as WeekStart;
}

export function schemaOf(ctx: MockCtx, dbId: Id): DbSchema {
  const db = requireDb(ctx, dbId);
  const page = ctx.pages.require(dbId);
  const info: DbInfo = {
    id: db.id,
    title: page.title,
    primaryPropId: db.primaryPropId,
    schemaRev: db.schemaRev,
    dataRev: db.dataRev,
    templates: db.templates,
    hideEmptyProps: db.hideEmptyProps,
    roles: db.roles,
  };
  if (page.icon) info.icon = page.icon;
  if (db.description) info.description = db.description;
  if (db.defaultTemplateId) info.defaultTemplateId = db.defaultTemplateId;
  if (db.appInstanceId) info.appInstanceId = db.appInstanceId;
  return { database: info, properties: propsOf(ctx, dbId).map(stripProp), views: viewsOf(ctx, dbId).map(stripView) };
}

/** Databases whose relations point at `dbId` (their rollups depend on it). */
function dependents(ctx: MockCtx, dbId: Id): Id[] {
  const out = new Set<Id>();
  for (const p of T.props(ctx).values()) {
    if (p.deletedAt || p.type !== 'relation' || p.databaseId === dbId) continue;
    if (p.config.targetDatabaseId === dbId) out.add(p.databaseId);
  }
  return [...out];
}

function bump(ctx: MockCtx, dbId: Id, what: 'data' | 'schema' | 'both', rowIds?: Id[]): void {
  const db = T.dbs(ctx).get(dbId);
  if (!db) return;
  T.dbs(ctx).update(dbId, (d) => {
    if (what !== 'schema') d.dataRev += 1;
    if (what !== 'data') d.schemaRev += 1;
  });
  const payload: { databaseId: Id; dataRev: number; schemaRev: number; rowIds?: Id[] } = { databaseId: dbId, dataRev: db.dataRev, schemaRev: db.schemaRev };
  if (rowIds) payload.rowIds = rowIds;
  ctx.emit('db:changed', payload);
  if (what !== 'schema') {
    for (const dep of dependents(ctx, dbId)) {
      const d = T.dbs(ctx).get(dep);
      if (!d) continue;
      T.dbs(ctx).update(dep, (x) => {
        x.dataRev += 1;
      });
      ctx.emit('db:changed', { databaseId: dep, dataRev: d.dataRev, schemaRev: d.schemaRev });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────── computed values

function compiledFor(ctx: MockCtx, p: PropRecord): Compiled | FormulaError {
  const expr = String(p.config.expression ?? '');
  const props = propsOf(ctx, p.databaseId);
  const key = `${p.id}|${expr}|${props.map((x) => x.id + x.name).join(',')}`;
  const e = eng(ctx);
  let c = e.compiled.get(key);
  if (!c) {
    try {
      c = compile(expr, props);
    } catch (err) {
      c = err instanceof FormulaError ? err : new FormulaError(String(err));
    }
    if (e.compiled.size > 500) e.compiled.clear();
    e.compiled.set(key, c);
  }
  return c;
}

function fxRate(from: string, to: string): number | null {
  // Mirrors the fixed FX table of the market mock (USD base).
  const usd: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 151.2, CHF: 0.88, CAD: 1.37, AUD: 1.52, SEK: 10.6, NOK: 10.8, INR: 83.4 };
  const a = usd[from];
  const b = usd[to];
  if (!a || !b) return null;
  return b / a;
}

interface MatHost extends FormulaHost {
  rollupCell(row: RowRecord | RowDTO, p: PropRecord): CellValue;
}

function makeHost(ctx: MockCtx): MatHost {
  const memo = new Map<string, FValue>();
  const inProgress = new Set<string>();
  const rollMemo = new Map<string, CellValue>();
  const propCache = new Map<Id, PropRecord[]>();
  const dbProps = (dbId: Id) => {
    let ps = propCache.get(dbId);
    if (!ps) propCache.set(dbId, (ps = propsOf(ctx, dbId)));
    return ps;
  };
  const host: MatHost = {
    now: ctx.clock.now(),
    fxRate,
    resolveRow(id) {
      const r = T.rows(ctx).get(id);
      if (!r || r.deletedAt) return null;
      const db = T.dbs(ctx).get(r.databaseId);
      const props = dbProps(r.databaseId);
      const title = db ? plainText((r.values[db.primaryPropId] as { v?: RichText } | undefined)?.v ?? []) : '';
      return new FRow(r as unknown as RowDTO, props, title || 'Untitled');
    },
    value(row, prop) {
      const p = prop as PropRecord;
      if (p.type === 'formula') {
        const key = row.id + '|' + p.id;
        if (memo.has(key)) return memo.get(key) ?? null;
        if (inProgress.has(key)) throw new FormulaError('Circular reference');
        const c = compiledFor(ctx, p);
        if (c instanceof FormulaError) throw c;
        inProgress.add(key);
        try {
          const v = evaluate(c, row as RowDTO, dbProps(p.databaseId), host);
          memo.set(key, v);
          return v;
        } finally {
          inProgress.delete(key);
        }
      }
      if (p.type === 'rollup') {
        const cell = host.rollupCell(row as unknown as RowRecord, p);
        return cell.t === 'computed' ? cellToValue({ ...(row as RowDTO), values: { [p.id]: cell } }, p, host) : null;
      }
      return cellToValue(row as RowDTO, p, host);
    },
    rollupCell(row, p) {
      const key = row.id + '|' + p.id;
      const hit = rollMemo.get(key);
      if (hit) return hit;
      if (inProgress.has(key)) return { t: 'computed', v: { kind: 'error', value: 'Circular reference', display: 'Circular reference' } };
      inProgress.add(key);
      try {
        const cell = computeRollup(ctx, row, p, host, dbProps);
        rollMemo.set(key, cell);
        return cell;
      } finally {
        inProgress.delete(key);
      }
    },
  };
  return host;
}

function computeRollup(ctx: MockCtx, row: RowRecord | RowDTO, p: PropRecord, host: MatHost, dbProps: (id: Id) => PropRecord[]): CellValue {
  const relId = p.config.relationPropId as Id | undefined;
  const targetId = p.config.targetPropId as Id | undefined;
  const fn = String(p.config.fn ?? 'count_all');
  const rel = relId ? T.props(ctx).get(relId) : undefined;
  if (!rel || rel.deletedAt || rel.type !== 'relation') return { t: 'computed', v: { kind: 'error', value: 'Pick a relation', display: '' } };
  const ids = ((row.values[rel.id] as { v?: Id[] } | undefined)?.v ?? []) as Id[];
  const related = ids.map((id) => T.rows(ctx).get(id)).filter((r): r is RowRecord => !!r && !r.deletedAt);
  const targetDb = String(rel.config.targetDatabaseId ?? '');
  const target = targetId ? dbProps(targetDb).find((x) => x.id === targetId) : undefined;
  const cells: (CellValue | undefined)[] = related.map((r) => {
    if (!target) return { t: 'text', v: rt(host.resolveRow(r.id)?.title ?? '') } as CellValue;
    if (target.type === 'formula') {
      try {
        const v = host.value(r as unknown as RowDTO, target);
        return { t: 'computed', v: toComputed(v) } as CellValue;
      } catch (e) {
        return { t: 'computed', v: { kind: 'error', value: String(e), display: '' } } as CellValue;
      }
    }
    if (target.type === 'rollup') return host.rollupCell(r, target);
    return cellFor(r as unknown as RowDTO, target.type === 'created_time' ? '$created' : target.type === 'updated_time' ? '$updated' : target.id);
  });
  const tp: Property = target ?? ({ id: 'title', name: 'Title', type: 'title', config: {}, hidden: false, sortKey: 'a' } as Property);
  const n = cells.length;
  const count = (pred: (c: CellValue | undefined) => boolean) => cells.filter(pred).length;
  const num = (v: number, display?: string): CellValue => ({ t: 'computed', v: { kind: 'number', value: v, display: display ?? String(Math.round(v * 100) / 100) } });
  const pct = (k: number) => num(n ? k / n : 0, `${Math.round((n ? k / n : 0) * 1000) / 10}%`);
  switch (fn) {
    case 'show_original':
    case 'show_unique': {
      let list = cells.map((c) => formatCell(c, tp)).filter((s) => s !== '');
      if (fn === 'show_unique') list = [...new Set(list)];
      return { t: 'computed', v: { kind: 'list', value: list, display: list.join(', ') } };
    }
    case 'count_all':
      return num(n, String(n));
    case 'count_values':
      return num(count((c) => !isEmptyCell(c)), String(count((c) => !isEmptyCell(c))));
    case 'count_unique': {
      const k = new Set(cells.filter((c) => !isEmptyCell(c)).map((c) => formatCell(c, tp))).size;
      return num(k, String(k));
    }
    case 'count_empty':
      return num(count((c) => isEmptyCell(c)), String(count((c) => isEmptyCell(c))));
    case 'count_not_empty':
      return num(count((c) => !isEmptyCell(c)), String(count((c) => !isEmptyCell(c))));
    case 'pct_empty':
      return pct(count((c) => isEmptyCell(c)));
    case 'pct_not_empty':
      return pct(count((c) => !isEmptyCell(c)));
    case 'checked':
    case 'unchecked': {
      const k = count((c) => (c?.t === 'check' ? c.v : false) === (fn === 'checked'));
      return num(k, String(k));
    }
    case 'pct_checked':
    case 'pct_unchecked':
      return pct(count((c) => (c?.t === 'check' ? c.v : false) === (fn === 'pct_checked')));
    case 'earliest':
    case 'latest': {
      const ds = cells.map((c) => cellDateRange(c)?.start).filter((x): x is number => typeof x === 'number');
      if (!ds.length) return { t: 'computed', v: { kind: 'date', value: null, display: '' } };
      const v = fn === 'earliest' ? Math.min(...ds) : Math.max(...ds);
      return { t: 'computed', v: { kind: 'date', value: v, display: aggregate(fn, [{ t: 'ts', v }], { ...tp, type: 'date' }) } };
    }
    case 'date_range': {
      const ds = cells.map((c) => cellDateRange(c)?.start).filter((x): x is number => typeof x === 'number');
      if (!ds.length) return { t: 'computed', v: { kind: 'number', value: null, display: '' } };
      const days = Math.round((Math.max(...ds) - Math.min(...ds)) / 86_400_000);
      return num(days, `${days} ${days === 1 ? 'day' : 'days'}`);
    }
    default: {
      const map: Record<string, AggFn> = { sum: 'sum', average: 'avg', median: 'median', min: 'min', max: 'max', range: 'range' };
      const agg = map[fn];
      if (!agg) return { t: 'computed', v: { kind: 'error', value: 'Unknown rollup', display: '' } };
      const v = aggregateNumber(agg, cells);
      const isMoney = tp.type === 'money' || cells.some((c) => c?.t === 'money') || cells.some((c) => c?.t === 'computed' && c.v.kind === 'money');
      return { t: 'computed', v: { kind: isMoney ? 'money' : 'number', value: v, display: v === null ? '' : aggregate(agg, cells, isMoney && tp.type !== 'money' ? { ...tp, type: 'money', config: { currency: 'USD' } } : tp) } };
    }
  }
}

function matKey(ctx: MockCtx, db: DbRecord, props: PropRecord[]): string {
  let k = `${db.dataRev}.${db.schemaRev}`;
  const seen = new Set<Id>([db.id]);
  const stack = [db.id];
  // Rollups and relation-reading formulas depend on related databases (transitively, bounded).
  while (stack.length && seen.size < 12) {
    const id = stack.pop()!;
    for (const p of id === db.id ? props : propsOf(ctx, id)) {
      if (p.type !== 'relation') continue;
      const t = String(p.config.targetDatabaseId ?? '');
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const td = T.dbs(ctx).get(t);
      if (td) k += `|${t.slice(-6)}.${td.dataRev}.${td.schemaRev}`;
      stack.push(t);
    }
  }
  if (props.some((p) => p.type === 'formula' && /now\(|today\(/.test(String(p.config.expression ?? '')))) k += `|m${Math.floor(ctx.clock.now() / 60_000)}`;
  return k;
}

function hasBody(ctx: MockCtx, id: Id): boolean {
  const d = ctx.docs.get(id);
  if (!d) return false;
  return ctx.docs.text(id).trim().length > 0 || JSON.stringify(d.doc).includes('"image"');
}

function toDto(ctx: MockCtx, r: RowRecord, extra?: Record<Id, CellValue>): RowDTO {
  const dto: RowDTO = {
    id: r.id,
    rev: r.rev,
    sortKey: r.sortKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    values: extra ? { ...r.values, ...extra } : { ...r.values },
    hasBody: hasBody(ctx, r.id),
  };
  if (r.icon) dto.icon = r.icon;
  if (r.sample) dto.sample = true;
  return dto;
}

/** Rows of a database with computed values filled in (cached by revs). */
function materialize(ctx: MockCtx, dbId: Id): { rows: RowDTO[]; byId: Map<Id, RowDTO> } {
  const db = requireDb(ctx, dbId);
  const props = propsOf(ctx, dbId);
  const key = matKey(ctx, db, props);
  const e = eng(ctx);
  const hit = e.mat.get(dbId);
  if (hit && hit.key === key) return hit;
  const computed = props.filter((p) => p.type === 'formula' || p.type === 'rollup' || p.type === 'created_time' || p.type === 'updated_time');
  const host = makeHost(ctx);
  const rows = liveRows(ctx, dbId).map((r) => {
    if (!computed.length) return toDto(ctx, r);
    const extra: Record<Id, CellValue> = {};
    for (const p of computed) {
      if (p.type === 'created_time') extra[p.id] = { t: 'ts', v: r.createdAt };
      else if (p.type === 'updated_time') extra[p.id] = { t: 'ts', v: r.updatedAt };
      else if (p.type === 'rollup') extra[p.id] = host.rollupCell(r, p);
      else {
        try {
          extra[p.id] = { t: 'computed', v: toComputed(host.value(r as unknown as RowDTO, p), p.config.resultType as ResultKind | undefined) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          extra[p.id] = { t: 'computed', v: { kind: 'error', value: msg, display: msg } };
        }
      }
    }
    return toDto(ctx, r, extra);
  });
  // Formulas created before any rows existed learn their result type from the first real value.
  for (const p of computed) {
    if (p.type !== 'formula' || p.config.resultType !== undefined) continue;
    const kind = rows.map((r) => r.values[p.id]).find((c) => c?.t === 'computed' && c.v.value !== null && c.v.kind !== 'error');
    if (kind && kind.t === 'computed') T.props(ctx).update(p.id, (x) => void (x.config = { ...x.config, resultType: kind.v.kind }));
  }
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out = { key, rows, byId };
  e.mat.set(dbId, out);
  return out;
}

function resultTypeOf(ctx: MockCtx, p: PropRecord): string | undefined {
  if (p.type === 'rollup') {
    const fn = String(p.config.fn ?? 'count_all');
    if (fn === 'show_original' || fn === 'show_unique') return 'list';
    if (fn === 'earliest' || fn === 'latest') return 'date';
    if (['sum', 'average', 'median', 'min', 'max', 'range'].includes(fn)) {
      const rel = p.config.relationPropId ? T.props(ctx).get(String(p.config.relationPropId)) : undefined;
      const tgt = rel && p.config.targetPropId ? T.props(ctx).get(String(p.config.targetPropId)) : undefined;
      return tgt?.type === 'money' ? 'money' : 'number';
    }
    return 'number';
  }
  if (p.type === 'formula') {
    const c = compiledFor(ctx, p);
    if (c instanceof FormulaError) return undefined;
    const host = makeHost(ctx);
    const sample = liveRows(ctx, p.databaseId).slice(0, 25);
    if (!sample.length) return undefined;
    for (const r of sample) {
      try {
        const k = kindOf(evaluate(c, r as unknown as RowDTO, propsOf(ctx, p.databaseId), host));
        if (k) return k;
      } catch {
        /* keep looking */
      }
    }
    return 'text';
  }
  return undefined;
}

export function refreshResultTypes(ctx: MockCtx, dbId: Id): void {
  for (const p of propsOf(ctx, dbId)) {
    if (p.type !== 'formula' && p.type !== 'rollup') continue;
    const rt = resultTypeOf(ctx, p);
    if (rt !== p.config.resultType) T.props(ctx).update(p.id, (x) => void (x.config = { ...x.config, resultType: rt }));
  }
}

// ───────────────────────────────────────────────────────────────────────────── query

function relationTitleFn(ctx: MockCtx) {
  const host = makeHost(ctx);
  return (id: Id) => host.resolveRow(id)?.title;
}

function searchMatch(row: RowDTO, props: PropRecord[], terms: string[]): boolean {
  if (!terms.length) return true;
  let hay = '';
  for (const p of props) {
    if (p.type === 'secret') continue;
    const c = row.values[p.id];
    if (!c) continue;
    if (p.type === 'title' || p.type === 'text' || p.type === 'url' || p.type === 'email' || p.type === 'phone' || p.type === 'select' || p.type === 'multi_select' || p.type === 'status' || p.type === 'unique_id' || p.type === 'ticker')
      hay += ' ' + formatCell(c, p);
  }
  hay = hay.toLocaleLowerCase();
  return terms.every((t) => hay.includes(t));
}

interface Resolved {
  filter?: Filter;
  sorts: Sort[];
  groupBy?: GroupBy;
  search: string;
  view?: ViewRecord;
}

function resolveQuery(ctx: MockCtx, dbId: Id, viewId: Id | undefined, override: DbQueryReq['override']): Resolved {
  const view = viewId ? requireView(ctx, viewId) : undefined;
  if (view && view.databaseId !== dbId) fail('INVALID', 'That view belongs to another database', 'viewId');
  const o = override ?? {};
  return {
    view,
    filter: andFilters(view?.filter, o.filter),
    sorts: o.sorts ?? view?.sorts ?? [],
    groupBy: o.groupBy === null ? undefined : (o.groupBy ?? view?.groupBy),
    search: (o.search ?? '').trim().slice(0, 512),
  };
}

function runQuery(ctx: MockCtx, dbId: Id, q: Resolved) {
  const db = requireDb(ctx, dbId);
  const props = propsOf(ctx, dbId);
  const propMap = new Map<Id, Property>(props.map((p) => [p.id, p] as const));
  const { rows, byId } = materialize(ctx, dbId);
  const mk = matKey(ctx, db, props);
  const qkey = `${dbId}|${mk}|${JSON.stringify([q.filter, q.sorts, q.groupBy, q.search])}`;
  const e = eng(ctx);
  const cached = e.queries.get(qkey);
  if (cached) return { db, props, propMap, byId, qkey, ...cached };
  const env: FilterEnv = { props: propMap, now: ctx.clock.now(), weekStart: weekStart(ctx) };
  const terms = q.search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = rows.filter((r) => evalFilter(r, q.filter, env) && searchMatch(r, props, terms));
  const order = [...filtered].sort(makeComparator(q.sorts, propMap));
  let groups: { g: GroupKey; rows: RowDTO[] }[] | undefined;
  const gp = q.groupBy ? propMap.get(q.groupBy.prop) : undefined;
  if (q.groupBy && gp) {
    const gEnv = { now: env.now, weekStart: env.weekStart, relationTitle: relationTitleFn(ctx) };
    const map = new Map<string, { g: GroupKey; rows: RowDTO[] }>();
    for (const s of staticGroups(q.groupBy, gp)) map.set(s.key, { g: s, rows: [] });
    for (const r of order) {
      for (const k of rowGroupKeys(r, q.groupBy, gp, gEnv)) {
        let b = map.get(k.key);
        if (!b) map.set(k.key, (b = { g: k, rows: [] }));
        b.rows.push(r);
      }
    }
    let list = [...map.values()];
    if (q.groupBy.hideEmpty) list = list.filter((b) => b.rows.length > 0);
    // "No value" is only shown when something lands there (or for boards: always for select/status).
    list = list.filter((b) => b.g.key !== NO_VALUE || b.rows.length > 0);
    const ordered = orderGroups(list.map((b) => b.g), q.groupBy);
    groups = ordered.map((g) => map.get(g.key)!);
  }
  const entry = { order, groups, filtered };
  if (e.queries.size > 16) e.queries.delete(e.queries.keys().next().value as string);
  e.queries.set(qkey, entry);
  return { db, props, propMap, byId, qkey, ...entry };
}

function aggsFor(rows: RowDTO[], footer: Record<Id, AggFn> | undefined, propMap: Map<Id, Property>): Record<Id, string> {
  const out: Record<Id, string> = {};
  if (!footer) return out;
  for (const [pid, fn] of Object.entries(footer)) {
    const p = propMap.get(pid);
    if (!p) continue;
    out[pid] = aggregate(fn, rows.map((r) => cellFor(r, pid)), p);
  }
  return out;
}

function projectRow(r: RowDTO, keep: Set<Id> | null): RowDTO {
  if (!keep) return r;
  const values: Record<Id, CellValue> = {};
  for (const k of Object.keys(r.values)) if (keep.has(k)) values[k] = r.values[k];
  return { ...r, values };
}

function dbQuery(ctx: MockCtx, req: DbQueryReq): DbQueryResult {
  const t0 = performance.now();
  if (!req.window || req.window.limit < 0 || req.window.offset < 0) fail('INVALID', 'Bad window', 'window');
  const limit = Math.min(500, req.window.limit);
  const q = resolveQuery(ctx, req.databaseId, req.viewId, req.override);
  const res = runQuery(ctx, req.databaseId, q);
  const queryRev = `${fnv1a(res.qkey + '|' + (req.group ?? '') + '|' + req.window.offset + '|' + limit + '|' + (req.props ?? []).join(',')).toString(36)}`;
  if (req.knownQueryRev && req.knownQueryRev === queryRev) return { reqId: req.reqId, notModified: true };
  const keep = req.props ? new Set([...req.props, res.db.primaryPropId]) : null;
  const footer = q.view?.footerAggs;
  let list = res.order;
  let groups: DbQueryGroup[] | undefined;
  if (res.groups) {
    groups = res.groups.map((b) => {
      const g: DbQueryGroup = { key: b.g.key, label: b.g.label, count: b.rows.length, aggs: aggsFor(b.rows, footer, res.propMap) };
      if (b.g.color) g.color = b.g.color;
      return g;
    });
    if (req.group !== undefined) list = res.groups.find((b) => b.g.key === req.group)?.rows ?? [];
  }
  return {
    reqId: req.reqId,
    queryRev,
    total: list.length,
    rows: list.slice(req.window.offset, req.window.offset + limit).map((r) => projectRow(r, keep)),
    ...(groups ? { groups } : {}),
    aggs: aggsFor(res.filtered, footer, res.propMap),
    tookMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

// ───────────────────────────────────────────────────────────────────────────── value validation

function sanitizeValue(ctx: MockCtx, p: PropRecord, v: CellValue | null, rowId: Id): CellValue | null {
  if (v === null) return null;
  if (isReadOnlyType(p.type)) fail('INVALID', `${p.name} is calculated and can't be edited`, p.id);
  const bad = () => fail('INVALID', `That isn't a valid ${TYPE_META[p.type].label.toLowerCase()}`, p.id);
  switch (p.type) {
    case 'title':
    case 'text':
      if (v.t !== 'text' || !Array.isArray(v.v)) bad();
      if (plainText((v as { v: RichText }).v).length > 100_000) fail('TOO_LARGE', 'Text is too long', p.id);
      return v;
    case 'number':
      if (v.t !== 'number' || (v.v !== null && !Number.isFinite(v.v))) bad();
      return v;
    case 'money': {
      if (v.t !== 'money') bad();
      const m = v as Extract<CellValue, { t: 'money' }>;
      if (m.v !== null && !/^-?\d{1,20}(\.\d{1,8})?$/.test(m.v)) bad();
      return { t: 'money', v: m.v, cur: p.config.perRowCurrency ? m.cur || String(p.config.currency ?? 'USD') : String(p.config.currency ?? 'USD') };
    }
    case 'select':
    case 'status': {
      if (v.t !== p.type) bad();
      const id = (v as { v: Id | null }).v;
      if (id && !optionsOf(p).some((o) => o.id === id)) fail('INVALID', 'Unknown option', p.id);
      return v;
    }
    case 'multi_select': {
      if (v.t !== 'multi' || !Array.isArray(v.v)) bad();
      const opts = new Set(optionsOf(p).map((o) => o.id));
      return { t: 'multi', v: [...new Set((v as { v: Id[] }).v.filter((id) => opts.has(id)))] };
    }
    case 'date':
      if (v.t !== 'date') bad();
      return v;
    case 'checkbox':
      if (v.t !== 'check') bad();
      return { t: 'check', v: !!(v as { v: boolean }).v };
    case 'url': {
      if (v.t !== 'url') bad();
      const s = ((v as { v: string | null }).v ?? '').trim();
      if (!s) return { t: 'url', v: null };
      if (s.length > 4096) fail('TOO_LARGE', 'That link is too long', p.id);
      const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
      if (!/^(https?|mailto):/i.test(withScheme)) fail('INVALID', 'Only http, https and mailto links are allowed', p.id);
      return { t: 'url', v: withScheme };
    }
    case 'email':
    case 'phone':
      if (v.t !== p.type) bad();
      return { t: p.type, v: ((v as { v: string | null }).v ?? '').trim() || null };
    case 'files':
      if (v.t !== 'files') bad();
      return v;
    case 'relation': {
      if (v.t !== 'relation') bad();
      const target = String(p.config.targetDatabaseId ?? '');
      let ids = [...new Set((v as { v: Id[] }).v)].filter((id) => {
        const r = T.rows(ctx).get(id);
        return !!r && !r.deletedAt && r.databaseId === target;
      });
      if (p.config.limit === 'one') ids = ids.slice(-1);
      return { t: 'relation', v: ids };
    }
    case 'rating': {
      if (v.t !== 'rating') bad();
      const n = (v as { v: number | null }).v;
      const max = Number(p.config.max ?? 5);
      return { t: 'rating', v: n === null || n <= 0 ? null : Math.min(max, Math.max(1, Math.round(n))) };
    }
    case 'progress': {
      if (v.t !== 'progress') bad();
      const n = (v as { v: number | null }).v;
      return { t: 'progress', v: n === null ? null : Math.min(1, Math.max(0, n)) };
    }
    case 'ticker': {
      if (v.t !== 'ticker') bad();
      const s = ((v as { v: string | null }).v ?? '').trim().toUpperCase();
      if (!s) return { t: 'ticker', v: null };
      return { t: 'ticker', v: s.includes(':') ? s : `${s}:XNAS` };
    }
    case 'recurrence': {
      if (v.t !== 'recurrence') bad();
      const r = (v as Extract<CellValue, { t: 'recurrence' }>).v;
      if (r && !/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i.test(r.rrule)) fail('INVALID', 'Unsupported repeat rule', p.id);
      return v;
    }
    case 'secret': {
      // Writes carry the new plaintext in `masked`; only a mask of the last 4 characters is stored on the row.
      if (v.t !== 'secret') bad();
      const raw = (v as Extract<CellValue, { t: 'secret' }>).v?.masked ?? '';
      const sid = `secret:${rowId}:${p.id}`;
      if (!raw) {
        T.secrets(ctx).delete(sid);
        return { t: 'secret', v: null };
      }
      if (/^•+.{0,4}$/.test(raw) && T.secrets(ctx).has(sid)) return { t: 'secret', v: { masked: raw } }; // unchanged mask
      T.secrets(ctx).put({ id: sid, value: raw });
      return { t: 'secret', v: { masked: '••••' + raw.slice(-4) } };
    }
    default:
      return v;
  }
}

/** Two-way relations: mirror adds/removes on the dual property of the target rows. */
function syncDual(ctx: MockCtx, p: PropRecord, rowId: Id, before: Id[], after: Id[], touched: Set<Id>): void {
  const dualId = (p.config.dual as { propertyId?: Id } | null)?.propertyId;
  if (!dualId) return;
  const dual = T.props(ctx).get(dualId);
  if (!dual || dual.deletedAt) return;
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  const now = ctx.clock.now();
  for (const id of [...added, ...removed]) {
    const r = T.rows(ctx).get(id);
    if (!r || r.deletedAt) continue;
    const cur = ((r.values[dualId] as { v?: Id[] } | undefined)?.v ?? []) as Id[];
    let next = added.includes(id) ? [...new Set([...cur, rowId])] : cur.filter((x) => x !== rowId);
    if (dual.config.limit === 'one') next = next.slice(-1);
    T.rows(ctx).update(id, (x) => {
      x.values[dualId] = { t: 'relation', v: next };
      x.updatedAt = now;
    });
    touched.add(r.databaseId);
  }
}

// ───────────────────────────────────────────────────────────────────────────── templates

function resolveTemplateValue(ctx: MockCtx, p: PropRecord, v: CellValue | string): CellValue | null {
  if (typeof v !== 'string') return v;
  const now = ctx.clock.now();
  const m = /^@today(?:([+-])(\d+)([dwm]))?$/.exec(v);
  if (m || v === '@now') {
    const d = new Date(now);
    if (m && m[1]) {
      const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
      if (m[3] === 'd') d.setDate(d.getDate() + n);
      if (m[3] === 'w') d.setDate(d.getDate() + n * 7);
      if (m[3] === 'm') d.setMonth(d.getMonth() + n);
    }
    if (p.type !== 'date') return null;
    if (v === '@now') return { t: 'date', v: { start: d.toISOString(), time: true } };
    return { t: 'date', v: { start: ctx.clock.today(d.getTime()), time: false } };
  }
  const name = String(ctx.db.meta<{ profileName?: string }>('vault.settings')?.profileName ?? 'Me');
  const db = T.dbs(ctx).get(p.databaseId);
  const seqProp = db ? Object.keys(db.uidSeq)[0] : undefined;
  const seq = seqProp && db ? String((db.uidSeq[seqProp] ?? 0) + 1) : String(liveRows(ctx, p.databaseId).length + 1);
  const text = v.replace(/@name/g, name).replace(/@seq/g, seq).replace(/@today/g, ctx.clock.today());
  if (p.type === 'title' || p.type === 'text') return { t: 'text', v: rt(text) };
  if (p.type === 'url' || p.type === 'email' || p.type === 'phone') return { t: p.type, v: text };
  return null;
}

// ───────────────────────────────────────────────────────────────────────────── row create / update

function nextUids(db: DbRecord, props: PropRecord[]): Record<Id, CellValue> {
  const out: Record<Id, CellValue> = {};
  for (const p of props) {
    if (p.type !== 'unique_id') continue;
    const n = (db.uidSeq[p.id] ?? 0) + 1;
    db.uidSeq[p.id] = n;
    const prefix = String(p.config.prefix ?? '');
    out[p.id] = { t: 'uid', v: prefix ? `${prefix}-${n}` : String(n) };
  }
  return out;
}

export interface CreateRowInput {
  values?: Record<Id, CellValue>;
  afterId?: Id;
  beforeId?: Id;
  templateId?: Id;
  icon?: Icon;
  sample?: boolean;
  createdAt?: number;
  updatedAt?: number;
  doc?: TipTapDoc;
  silent?: boolean;
}

export function createRow(ctx: MockCtx, dbId: Id, input: CreateRowInput = {}): RowRecord {
  const db = requireDb(ctx, dbId);
  const props = propsOf(ctx, dbId);
  const byId = new Map(props.map((p) => [p.id, p] as const));
  const values: Record<Id, CellValue> = {};
  const tpl = input.templateId ? db.templates.find((t) => t.id === input.templateId) : undefined;
  if (input.templateId && !tpl) fail('NOT_FOUND', 'Template not found', 'templateId');
  const rowId = ctx.id();
  const touched = new Set<Id>();
  const relPending: [PropRecord, Id[]][] = [];
  const apply = (pid: Id, raw: CellValue | string) => {
    const p = byId.get(pid);
    if (!p || isReadOnlyType(p.type)) return;
    const v = resolveTemplateValue(ctx, p, raw);
    if (!v) return;
    const s = sanitizeValue(ctx, p, v, rowId);
    if (s) {
      values[pid] = s;
      if (p.type === 'relation') relPending.push([p, (s as { v: Id[] }).v]);
    }
  };
  if (tpl) for (const [pid, v] of Object.entries(tpl.values)) apply(pid, v);
  for (const [pid, v] of Object.entries(input.values ?? {})) apply(pid, v);
  if (!values[db.primaryPropId]) values[db.primaryPropId] = { t: 'text', v: [] };
  Object.assign(values, nextUids(db, props));
  T.dbs(ctx).update(db.id, (d) => void (d.uidSeq = db.uidSeq));

  const siblings = liveRows(ctx, dbId).slice().sort((a, b) => compareKeys(a.sortKey, b.sortKey));
  let sortKey: string;
  if (input.afterId) {
    const i = siblings.findIndex((r) => r.id === input.afterId);
    sortKey = ctx.keyBetween(siblings[i]?.sortKey ?? siblings[siblings.length - 1]?.sortKey, i >= 0 ? siblings[i + 1]?.sortKey : null);
  } else if (input.beforeId) {
    const i = siblings.findIndex((r) => r.id === input.beforeId);
    sortKey = ctx.keyBetween(i > 0 ? siblings[i - 1].sortKey : null, siblings[i]?.sortKey ?? null);
  } else sortKey = ctx.keyBetween(siblings[siblings.length - 1]?.sortKey ?? null, null);

  const now = ctx.clock.now();
  const rec: RowRecord = {
    id: rowId,
    databaseId: dbId,
    rev: 1,
    sortKey,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
    values,
  };
  const icon = input.icon ?? tpl?.icon;
  if (icon) rec.icon = icon;
  if (input.sample) rec.sample = true;
  T.rows(ctx).insert(rec);
  for (const [p, ids] of relPending) syncDual(ctx, p, rowId, [], ids, touched);
  const doc = input.doc ?? tpl?.doc;
  if (doc) ctx.docs.save(rowId, 'row', structuredClone(doc));
  if (!input.silent) {
    bump(ctx, dbId, 'data', [rowId]);
    for (const t of touched) if (t !== dbId) bump(ctx, t, 'data');
  }
  return rec;
}

function updateRows(ctx: MockCtx, updates: { id: Id; values: Record<Id, CellValue | null>; baseRev?: number }[]): RowDTO[] {
  if (updates.length > 1000) fail('TOO_LARGE', 'At most 1,000 rows per update');
  const touched = new Map<Id, Id[]>();
  const extra = new Set<Id>();
  const now = ctx.clock.now();
  for (const u of updates) {
    const r = requireRow(ctx, u.id);
    if (u.baseRev !== undefined && u.baseRev !== r.rev) throw new BackendError('CONFLICT', 'This row changed somewhere else', { currentRev: r.rev });
    const props = new Map(propsOf(ctx, r.databaseId).map((p) => [p.id, p] as const));
    const next: Record<Id, CellValue | null> = {};
    for (const [pid, v] of Object.entries(u.values)) {
      const p = props.get(pid);
      if (!p) fail('NOT_FOUND', 'Property not found', pid);
      next[pid] = sanitizeValue(ctx, p!, v, r.id);
    }
    for (const [pid, v] of Object.entries(next)) {
      const p = props.get(pid)!;
      if (p.type === 'relation') {
        const before = ((r.values[pid] as { v?: Id[] } | undefined)?.v ?? []) as Id[];
        const after = ((v as { v?: Id[] } | null)?.v ?? []) as Id[];
        syncDual(ctx, p, r.id, before, after, extra);
      }
    }
    T.rows(ctx).update(r.id, (x) => {
      for (const [pid, v] of Object.entries(next)) {
        if (v === null) delete x.values[pid];
        else x.values[pid] = v;
      }
      x.updatedAt = now;
      delete x.sample;
    });
    const list = touched.get(r.databaseId) ?? [];
    list.push(r.id);
    touched.set(r.databaseId, list);
  }
  for (const [dbId, ids] of touched) bump(ctx, dbId, 'data', ids);
  for (const d of extra) if (!touched.has(d)) bump(ctx, d, 'data');
  return updates.map((u) => rowDto(ctx, u.id));
}

/** One row with computed values. */
function rowDto(ctx: MockCtx, id: Id): RowDTO {
  const r = requireRow(ctx, id);
  const m = materialize(ctx, r.databaseId);
  return m.byId.get(id) ?? toDto(ctx, r);
}

// ───────────────────────────────────────────────────────────────────────────── database & property creation

function optionId(ctx: MockCtx): Id {
  return 'opt_' + ctx.id().replace(/-/g, '').slice(-10);
}

function normalizeConfig(ctx: MockCtx, type: PropType, config: Record<string, unknown> | undefined): Record<string, unknown> {
  const c: Record<string, unknown> = { ...defaultConfig(type), ...(config ?? {}) };
  if (type === 'select' || type === 'multi_select' || type === 'status') {
    const used: BlockColor[] = [];
    c.options = (Array.isArray(c.options) ? (c.options as Partial<SelectOption>[]) : []).map((o) => {
      const color = (o.color as BlockColor) ?? nextTagColor(String(o.name), used);
      used.push(color);
      const opt: SelectOption = { id: o.id ?? optionId(ctx), name: String(o.name ?? 'Option').slice(0, 200), color };
      if (type === 'status') opt.group = o.group ?? 'todo';
      return opt;
    });
  }
  return c;
}

export interface NewProp {
  name: string;
  type: PropType;
  config?: Record<string, unknown>;
  id?: Id;
  hidden?: boolean;
  role?: string;
  description?: string;
}

function insertProp(ctx: MockCtx, dbId: Id, np: NewProp, afterId?: Id): PropRecord {
  const props = propsOf(ctx, dbId);
  if (np.type === 'title' && props.some((p) => p.type === 'title')) fail('INVALID', 'A database has exactly one title property');
  if (!TYPE_META[np.type]) fail('INVALID', 'Unknown property type', 'type');
  const name = np.name.trim().slice(0, 200) || TYPE_META[np.type].label;
  let unique = name;
  let n = 2;
  while (props.some((p) => p.name.toLowerCase() === unique.toLowerCase())) unique = `${name} ${n++}`;
  const i = afterId ? props.findIndex((p) => p.id === afterId) : props.length - 1;
  const sortKey = ctx.keyBetween(props[i]?.sortKey ?? null, i >= 0 ? (props[i + 1]?.sortKey ?? null) : (props[0]?.sortKey ?? null));
  const rec: PropRecord = {
    id: np.id ?? ctx.id(),
    databaseId: dbId,
    name: unique,
    type: np.type,
    config: normalizeConfig(ctx, np.type, np.config),
    hidden: !!np.hidden,
    sortKey,
  };
  if (np.role) rec.role = np.role;
  if (np.description) rec.description = np.description;
  if (np.type === 'formula' && typeof rec.config.expression === 'string') rec.config.expression = toStorage(rec.config.expression, [...props, rec]);
  T.props(ctx).insert(rec);
  return rec;
}

function backfillUids(ctx: MockCtx, db: DbRecord, p: PropRecord): void {
  const rows = liveRows(ctx, db.id).slice().sort((a, b) => a.createdAt - b.createdAt || compareKeys(a.sortKey, b.sortKey));
  let n = db.uidSeq[p.id] ?? 0;
  const prefix = String(p.config.prefix ?? '');
  for (const r of rows) {
    if (r.values[p.id]) continue;
    n += 1;
    T.rows(ctx).update(r.id, (x) => void (x.values[p.id] = { t: 'uid', v: prefix ? `${prefix}-${n}` : String(n) }));
  }
  T.dbs(ctx).update(db.id, (d) => void (d.uidSeq = { ...d.uidSeq, [p.id]: n }));
}

export function createProperty(ctx: MockCtx, dbId: Id, np: NewProp, afterId?: Id, opts: { silent?: boolean } = {}): PropRecord {
  const db = requireDb(ctx, dbId);
  const config = { ...(np.config ?? {}) };
  let twoWay = false;
  if (np.type === 'relation') {
    const target = String(config.targetDatabaseId ?? '');
    if (!target) fail('INVALID', 'Choose a database to link to', 'targetDatabaseId');
    requireDb(ctx, target);
    twoWay = config.twoWay === true || (config.dual !== null && typeof config.dual === 'object' && !(config.dual as { propertyId?: Id }).propertyId);
    delete config.twoWay;
    config.dual = null;
  }
  const rec = insertProp(ctx, dbId, { ...np, config }, afterId);
  if (np.type === 'relation' && twoWay) {
    const target = String(config.targetDatabaseId);
    const page = ctx.pages.require(dbId);
    const dual = insertProp(ctx, target, {
      name: target === dbId ? `Related ${rec.name}` : page.title || 'Related',
      type: 'relation',
      config: { targetDatabaseId: dbId, dual: { propertyId: rec.id }, limit: 'many' },
    });
    T.props(ctx).update(rec.id, (x) => void (x.config = { ...x.config, dual: { propertyId: dual.id } }));
    if (target !== dbId && !opts.silent) bump(ctx, target, 'schema');
  }
  if (np.type === 'unique_id') backfillUids(ctx, db, rec);
  if (np.type === 'formula' || np.type === 'rollup') {
    const t = resultTypeOf(ctx, T.props(ctx).require(rec.id));
    if (t) T.props(ctx).update(rec.id, (x) => void (x.config = { ...x.config, resultType: t }));
  }
  if (!opts.silent) bump(ctx, dbId, 'schema');
  return T.props(ctx).require(rec.id);
}

export interface NewView {
  name: string;
  layout: Layout;
  id?: Id;
  patch?: Partial<Omit<View, 'id' | 'sortKey' | 'layout' | 'name'>>;
}

function defaultViewFor(ctx: MockCtx, dbId: Id, layout: Layout, base?: View): Omit<View, 'id' | 'name' | 'sortKey'> {
  const props = propsOf(ctx, dbId);
  const primary = T.dbs(ctx).require(dbId).primaryPropId;
  const visible = base?.visibleProps ?? props.filter((p) => !p.hidden).map((p) => p.id);
  const v: Omit<View, 'id' | 'name' | 'sortKey'> = {
    layout,
    sorts: base?.sorts ?? [],
    visibleProps: visible.includes(primary) ? visible : [primary, ...visible],
    propWidths: base?.propWidths ?? {},
    wrap: base?.wrap ?? {},
    footerAggs: base?.footerAggs ?? {},
    collapsedGroups: [],
    openIn: base?.openIn ?? 'side_peek',
  };
  if (base?.filter) v.filter = base.filter;
  if (layout === 'board') {
    const g = props.find((p) => p.type === 'status') ?? props.find((p) => p.type === 'select') ?? props.find((p) => p.type === 'checkbox');
    if (g) v.groupBy = base?.groupBy && props.find((p) => p.id === base.groupBy!.prop && (p.type === 'select' || p.type === 'status' || p.type === 'checkbox' || p.type === 'multi_select')) ? base.groupBy : { prop: g.id };
    v.card = base?.card ?? { preview: 'none', size: 'm', fit: false };
    v.visibleProps = visible.filter((id) => id !== v.groupBy?.prop).slice(0, 5);
  } else if (base?.groupBy && layout !== 'calendar' && layout !== 'chart' && layout !== 'gallery') v.groupBy = base.groupBy;
  if (layout === 'gallery') {
    v.card = base?.card ?? { preview: 'cover', size: 'm', fit: false };
    v.visibleProps = visible.slice(0, 4);
  }
  if (layout === 'list') v.visibleProps = visible.slice(0, 5);
  if (layout === 'calendar') {
    const d = props.find((p) => p.type === 'date') ?? props.find((p) => p.type === 'created_time');
    v.calendar = base?.calendar ?? { dateProp: d?.id ?? '', showWeekends: true };
    v.visibleProps = visible.slice(0, 3);
  }
  if (layout === 'chart') {
    const x = props.find((p) => p.type === 'status' || p.type === 'select') ?? props.find((p) => p.type === 'date');
    const y = props.find((p) => p.type === 'money' || p.type === 'number');
    v.chart = base?.chart ?? {
      type: 'bar',
      x: x ? { prop: x.id, ...(isDateLike(x) ? { bucket: 'month' as const } : {}) } : { prop: '$created', bucket: 'month' },
      y: [y ? { agg: 'sum', prop: y.id } : { agg: 'count' }],
    };
  }
  return v;
}

export function createView(ctx: MockCtx, dbId: Id, nv: NewView, fromViewId?: Id, afterLast = true): ViewRecord {
  requireDb(ctx, dbId);
  const views = viewsOf(ctx, dbId);
  const base = fromViewId ? requireView(ctx, fromViewId) : undefined;
  const v: ViewRecord = {
    id: nv.id ?? ctx.id(),
    databaseId: dbId,
    name: nv.name.trim().slice(0, 200) || 'Untitled view',
    sortKey: afterLast ? ctx.keyBetween(views[views.length - 1]?.sortKey ?? null, null) : ctx.keyBetween(null, views[0]?.sortKey ?? null),
    ...defaultViewFor(ctx, dbId, nv.layout, base && base.layout === nv.layout ? structuredClone(stripView(base)) : base ? { ...structuredClone(stripView(base)), card: undefined, chart: undefined, calendar: undefined } : undefined),
    ...(nv.patch ?? {}),
  };
  if (base && base.layout === nv.layout) {
    const copy = structuredClone(stripView(base));
    Object.assign(v, { ...copy, id: v.id, name: v.name, sortKey: v.sortKey });
  }
  T.views(ctx).insert(v);
  return v;
}

export interface NewDatabase {
  workspaceId?: Id;
  parentId: Id | null;
  title: string;
  icon?: Icon;
  inline?: boolean;
  afterId?: Id;
  description?: string;
  /** First property is the title unless one of type 'title' is given. */
  properties?: NewProp[];
  views?: NewView[];
  appInstanceId?: Id;
  createdAt?: number;
  silent?: boolean;
  id?: Id;
}

export function createDatabase(ctx: MockCtx, input: NewDatabase): { page: PageMeta; db: DbRecord } {
  const ws = input.workspaceId ?? ctx.workspaceId();
  if (input.parentId) {
    const parent = ctx.pages.require(input.parentId);
    if (parent.kind === 'database') fail('INVALID', 'Databases cannot be nested inside databases', 'parentId');
  }
  const page = ctx.pages.create({
    workspaceId: ws,
    parentId: input.parentId,
    kind: 'database',
    title: input.title.slice(0, 1024),
    icon: input.icon,
    flags: input.inline ? { inline: true } : {},
    afterId: input.afterId,
    appInstanceId: input.appInstanceId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    silent: input.silent,
  });
  const titleIn = input.properties?.find((p) => p.type === 'title');
  const titleId = titleIn?.id ?? ctx.id();
  const db: DbRecord = {
    id: page.id,
    primaryPropId: titleId,
    schemaRev: 1,
    dataRev: 1,
    templates: [],
    hideEmptyProps: false,
    roles: {},
    uidSeq: {},
    createdAt: page.createdAt,
  };
  if (input.description) db.description = rt(input.description);
  if (input.appInstanceId) db.appInstanceId = input.appInstanceId;
  T.dbs(ctx).insert(db);
  insertProp(ctx, db.id, { name: titleIn?.name ?? 'Name', type: 'title', id: titleId });
  const rest = input.properties?.filter((p) => p.type !== 'title') ?? [
    { name: 'Tags', type: 'multi_select' as const },
    { name: 'Date', type: 'date' as const },
  ];
  // relations/rollups/formulas after plain properties so references resolve
  const order = [...rest].sort((a, b) => Number(a.type === 'rollup' || a.type === 'formula') - Number(b.type === 'rollup' || b.type === 'formula'));
  const placed = new Map<string, PropRecord>();
  for (const p of order) {
    const rec = createProperty(ctx, db.id, p, undefined, { silent: true });
    placed.set(p.name, rec);
    if (p.role) db.roles[p.role] = rec.id;
  }
  // restore declared order
  const declared = [titleId, ...rest.map((p) => placed.get(p.name)?.id).filter((x): x is Id => !!x)];
  const keys = generateNKeysBetween(null, null, declared.length);
  declared.forEach((id, i) => T.props(ctx).update(id, (x) => void (x.sortKey = keys[i])));
  const views = input.views?.length ? input.views : [{ name: 'Table', layout: 'table' as const }];
  for (const v of views) createView(ctx, db.id, v);
  return { page: ctx.pages.meta(page.id), db: T.dbs(ctx).require(db.id) };
}

// ───────────────────────────────────────────────────────────────────────────── conversions (§8.2)

function convertCell(from: PropRecord, to: PropRecord, c: CellValue | undefined): CellValue | null {
  if (!c) return null;
  const text = formatCell(c, from);
  switch (to.type) {
    case 'text':
    case 'title':
      return { t: 'text', v: c.t === 'text' ? c.v : rt(c.t === 'check' ? (c.v ? 'Yes' : 'No') : text) };
    case 'number': {
      if (c.t === 'money') return { t: 'number', v: c.v === null ? null : Number(c.v) };
      const n = parseNumber(text);
      return { t: 'number', v: n };
    }
    case 'money': {
      if (c.t === 'number') return { t: 'money', v: c.v === null ? null : String(c.v), cur: String(to.config.currency ?? 'USD') };
      return { t: 'money', v: parseMoney(text), cur: String(to.config.currency ?? 'USD') };
    }
    case 'select':
    case 'status': {
      const name = c.t === 'multi' ? text.split(',')[0]?.trim() : text.trim();
      const opt = optionsOf(to).find((o) => o.name === name);
      return { t: to.type, v: opt?.id ?? null };
    }
    case 'multi_select': {
      const names = text.split(',').map((s) => s.trim()).filter(Boolean);
      const opts = optionsOf(to);
      return { t: 'multi', v: names.map((n) => opts.find((o) => o.name === n)?.id).filter((x): x is Id => !!x) };
    }
    case 'checkbox':
      return { t: 'check', v: c.t === 'check' ? c.v : parseBool(text) };
    case 'date': {
      const d = parseDateInput(text);
      return d ? { t: 'date', v: d } : null;
    }
    case 'url':
    case 'email':
    case 'phone':
      return { t: to.type, v: text || null };
    default:
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────── chart data

function chartData(ctx: MockCtx, dbId: Id, viewId: Id | undefined, extra: Filter | undefined, spec: ChartSpec, maxPoints = 200): ChartData {
  const q = resolveQuery(ctx, dbId, viewId, { filter: extra, groupBy: null });
  const res = runQuery(ctx, dbId, { ...q, groupBy: undefined, sorts: [] });
  const rows = res.filtered;
  const env = { now: ctx.clock.now(), weekStart: weekStart(ctx), relationTitle: relationTitleFn(ctx) };
  const xProp: Property | undefined = spec.x.prop === '$created' ? ({ id: '$created', name: 'Created', type: 'created_time', config: {}, hidden: false, sortKey: '' } as Property) : res.propMap.get(spec.x.prop);
  if (!xProp) return { x: [], series: [] };
  const dateX = spec.x.prop === '$created' || isDateLike(xProp);
  const bucket = spec.x.bucket ?? 'month';
  const xKeys = new Map<string, { label: string; order: number }>();
  const keysOf = (r: RowDTO): { key: string; label: string; order: number }[] => {
    if (dateX) {
      const range = cellDateRange(cellFor(r, spec.x.prop === '$created' ? '$created' : xProp.id));
      if (!range) return [];
      return [bucketOf(range.start, bucket, env.now, env.weekStart)];
    }
    return rowGroupKeys(r, { prop: xProp.id }, xProp, env);
  };
  const seriesProp = spec.series ? res.propMap.get(spec.series.prop) : undefined;
  const ys = spec.series ? spec.y.slice(0, 1) : spec.y.length ? spec.y : [{ agg: 'count' as AggFn }];
  // bucket rows
  const cellsBy = new Map<string, Map<string, RowDTO[]>>(); // seriesKey → xKey → rows
  const seriesMeta = new Map<string, { label: string; order: number; color?: BlockColor }>();
  for (const r of rows) {
    const xs = keysOf(r);
    const ss: GroupKey[] = seriesProp ? rowGroupKeys(r, { prop: seriesProp.id }, seriesProp, env) : [{ key: '_', label: '', order: 0 }];
    for (const xk of xs) {
      if (!xKeys.has(xk.key)) xKeys.set(xk.key, { label: xk.label, order: xk.order });
      for (const sk of ss) {
        if (!seriesMeta.has(sk.key)) seriesMeta.set(sk.key, { label: sk.label, order: sk.order, color: sk.color });
        let m = cellsBy.get(sk.key);
        if (!m) cellsBy.set(sk.key, (m = new Map()));
        const list = m.get(xk.key) ?? [];
        list.push(r);
        m.set(xk.key, list);
      }
    }
  }
  // include empty options for category axes; fill date gaps
  if (!dateX) for (const g of staticGroups({ prop: xProp.id }, xProp)) if (g.key !== NO_VALUE && !xKeys.has(g.key)) xKeys.set(g.key, { label: g.label, order: g.order });
  if (dateX && xKeys.size > 1 && !spec.omitZero && bucket !== 'relative' as string) {
    const orders = [...xKeys.values()].map((v) => v.order);
    for (const ts of bucketSeries(Math.min(...orders), Math.max(...orders), bucket, env.weekStart, maxPoints)) {
      const b = bucketOf(ts, bucket, env.now, env.weekStart);
      if (!xKeys.has(b.key)) xKeys.set(b.key, { label: b.label, order: b.order });
    }
  }
  let xs = [...xKeys.entries()].sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label));
  if (xs.length > maxPoints) xs = xs.slice(-maxPoints);
  const yProp = (i: number) => (ys[i]?.prop ? res.propMap.get(ys[i].prop!) : undefined);
  const series: ChartData['series'] = [];
  const sKeys = [...seriesMeta.entries()].sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label));
  for (const [sk, meta] of sKeys) {
    for (let yi = 0; yi < ys.length; yi++) {
      const y = ys[yi];
      const yp = yProp(yi);
      const m = cellsBy.get(sk);
      let acc = 0;
      const values = xs.map(([xk]) => {
        const list = m?.get(xk) ?? [];
        let v = y.agg === 'count' || !yp ? list.length : aggregateNumber(y.agg, list.map((r) => cellFor(r, yp.id)));
        if (spec.cumulative) {
          acc += v ?? 0;
          v = acc;
        }
        return v;
      });
      const label = seriesProp ? meta.label : yp ? `${y.agg === 'count' ? 'Count' : y.agg[0].toUpperCase() + y.agg.slice(1)} of ${yp.name}` : 'Count';
      series.push({ key: seriesProp ? `s:${sk}` : `y${yi}`, label, values });
    }
  }
  if (!series.length) series.push({ key: 'y0', label: 'Count', values: xs.map(() => 0) });
  let keepIdx = xs.map((_, i) => i);
  if (spec.omitZero) keepIdx = keepIdx.filter((i) => series.some((s) => (s.values[i] ?? 0) !== 0));
  const out: ChartData = { x: keepIdx.map((i) => xs[i][1].label), series: series.map((s) => ({ ...s, values: keepIdx.map((i) => s.values[i]) })) };
  const yp0 = yProp(0);
  if (yp0?.type === 'money' && ys[0].agg !== 'count') out.currency = String(yp0.config.currency ?? 'USD');
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── import / export

async function readImport(ctx: MockCtx, grantId: Id): Promise<{ rows: string[][]; delimiter: string; sheets?: string[] }> {
  const file = ctx.grants.read(grantId);
  if (file.size > 50 * 1024 * 1024) fail('TOO_LARGE', 'Files over 50 MB cannot be imported');
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    try {
      const r = await readXlsx(await file.arrayBuffer());
      return { rows: r.rows, delimiter: 'xlsx', sheets: r.sheets };
    } catch (e) {
      fail('INVALID', e instanceof Error ? e.message : 'Could not read that workbook');
    }
  }
  const text = await file.text();
  const delimiter = name.endsWith('.tsv') ? '\t' : detectDelimiter(text);
  return { rows: parseCsv(text, delimiter), delimiter };
}

// Import grants are single-use; preview keeps the parsed file for the follow-up import.
const previewCache = new Map<Id, { rows: string[][]; delimiter: string; sheets?: string[]; at: number }>();

function columnsOf(rows: string[][]) {
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  return header.map((name, i) => {
    const vals = body.slice(0, 200).map((r) => r[i] ?? '');
    return { name: name.trim() || `Column ${i + 1}`, inferred: inferType(vals, i === 0), sample: vals.slice(0, 5) };
  });
}

function importValue(ctx: MockCtx, p: PropRecord, raw: string, optCache: Map<Id, Map<string, Id>>): CellValue | null {
  const s = raw.trim();
  if (!s) return null;
  switch (p.type) {
    case 'title':
    case 'text':
      return { t: 'text', v: rt(raw) };
    case 'number': {
      const n = parseNumber(s);
      return n === null ? null : { t: 'number', v: n };
    }
    case 'money': {
      const m = parseMoney(s);
      return m === null ? null : { t: 'money', v: m, cur: String(p.config.currency ?? 'USD') };
    }
    case 'checkbox':
      return { t: 'check', v: parseBool(s) };
    case 'date': {
      const d = parseDateInput(s);
      return d ? { t: 'date', v: d } : null;
    }
    case 'url':
    case 'email':
    case 'phone':
      return { t: p.type, v: s };
    case 'select':
    case 'status':
    case 'multi_select': {
      let m = optCache.get(p.id);
      if (!m) optCache.set(p.id, (m = new Map(optionsOf(p).map((o) => [o.name.toLowerCase(), o.id] as const))));
      const names = p.type === 'multi_select' ? s.split(',').map((x) => x.trim()).filter(Boolean) : [s];
      const ids: Id[] = [];
      for (const n of names) {
        let id = m.get(n.toLowerCase());
        if (!id) {
          const opts = optionsOf(T.props(ctx).require(p.id));
          if (opts.length >= 200) continue;
          id = optionId(ctx);
          const opt: SelectOption = { id, name: n.slice(0, 200), color: nextTagColor(n, opts.map((o) => o.color)) };
          if (p.type === 'status') opt.group = 'todo';
          T.props(ctx).update(p.id, (x) => void (x.config = { ...x.config, options: [...optionsOf(x), opt] }));
          m.set(n.toLowerCase(), id);
        }
        ids.push(id);
      }
      if (p.type === 'multi_select') return { t: 'multi', v: ids };
      return ids[0] ? { t: p.type, v: ids[0] } : null;
    }
    case 'rating': {
      const n = parseNumber(s);
      return n === null ? null : { t: 'rating', v: Math.round(n) };
    }
    case 'progress': {
      const n = parseNumber(s);
      return n === null ? null : { t: 'progress', v: n > 1 ? n / 100 : n };
    }
    default:
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────── handlers

function viewPatchSanitize(ctx: MockCtx, v: ViewRecord, patch: Partial<View>): Partial<View> {
  const p = { ...patch } as Partial<View> & Record<string, unknown>;
  delete p.id;
  delete p.sortKey;
  if (p.name !== undefined) p.name = String(p.name).trim().slice(0, 200) || v.name;
  if (p.layout && p.layout !== v.layout) {
    const d = defaultViewFor(ctx, v.databaseId, p.layout, stripView(v));
    for (const k of ['groupBy', 'card', 'calendar', 'chart'] as const) if (!(k in patch)) (p as Record<string, unknown>)[k] = d[k];
    if (!('visibleProps' in patch) && (p.layout === 'table' || v.layout !== 'table')) p.visibleProps = v.layout === 'table' ? v.visibleProps : d.visibleProps;
  }
  if (p.filter) {
    const depth = (f: Filter, n: number): number => ('and' in f ? Math.max(n, ...f.and.map((c) => depth(c, n + 1))) : 'or' in f ? Math.max(n, ...f.or.map((c) => depth(c, n + 1))) : n);
    if (depth(p.filter as Filter, 0) > 3) fail('INVALID', 'Filters can nest at most 3 levels', 'filter');
  }
  return p;
}

export const handlers: MockHandlers = {
  db_create: (req, ctx) => {
    if (typeof req.title !== 'string' || req.title.length > 1024) fail('INVALID', 'Title is too long', 'title');
    const { page, db } = createDatabase(ctx, {
      workspaceId: req.workspaceId,
      parentId: req.parentId,
      title: req.title,
      inline: req.inline,
      afterId: req.afterId,
      properties: req.properties?.map((p) => ({ name: p.name, type: p.type, config: p.config })),
    });
    // A fresh database starts with three empty rows so it's ready to type into.
    if (!req.properties) for (let i = 0; i < 3; i++) createRow(ctx, db.id, { silent: true });
    bump(ctx, db.id, 'both');
    return { page: ctx.pages.meta(page.id), schema: schemaOf(ctx, db.id) };
  },

  db_get_schema: (req, ctx) => schemaOf(ctx, req.id),

  db_update: (req, ctx) => {
    requireDb(ctx, req.id);
    const patch = req.patch ?? {};
    T.dbs(ctx).update(req.id, (d) => {
      if (patch.description !== undefined) d.description = patch.description;
      if (patch.templates !== undefined) {
        if (patch.templates.length > 50) fail('TOO_LARGE', 'At most 50 templates');
        d.templates = patch.templates.map((t) => ({ ...t, id: t.id || ctx.id(), name: String(t.name || 'Untitled template').slice(0, 200) }));
        if (d.defaultTemplateId && !d.templates.some((t) => t.id === d.defaultTemplateId)) delete d.defaultTemplateId;
      }
      if (patch.defaultTemplateId !== undefined) {
        if (patch.defaultTemplateId === null) delete d.defaultTemplateId;
        else if (d.templates.some((t) => t.id === patch.defaultTemplateId)) d.defaultTemplateId = patch.defaultTemplateId;
      }
      if (patch.hideEmptyProps !== undefined) d.hideEmptyProps = patch.hideEmptyProps;
    });
    if (patch.inline !== undefined) {
      const page = ctx.pages.require(req.id);
      ctx.pages.update(req.id, { flags: { ...page.flags, inline: patch.inline } });
    }
    bump(ctx, req.id, 'schema');
    return schemaOf(ctx, req.id);
  },

  db_duplicate: async (req, ctx) => {
    const src = requireDb(ctx, req.id);
    const page = ctx.pages.require(req.id);
    const map = new Map<Id, Id>();
    const props = propsOf(ctx, src.id);
    ctx.progress(0, 3, 'Copying properties');
    const dup = ctx.pages.create({ workspaceId: page.workspaceId, parentId: page.parentId, kind: 'database', title: `${page.title || 'Untitled'} (copy)`, icon: page.icon, flags: { ...page.flags }, afterId: page.id });
    const db: DbRecord = { ...structuredClone(src), id: dup.id, schemaRev: 1, dataRev: 1, uidSeq: {}, createdAt: dup.createdAt };
    for (const p of props) map.set(p.id, ctx.id());
    db.primaryPropId = map.get(src.primaryPropId)!;
    db.roles = Object.fromEntries(Object.entries(src.roles).map(([k, v]) => [k, map.get(v) ?? v]));
    T.dbs(ctx).insert(db);
    const remap = (s: string) => {
      let out = s;
      for (const [a, b] of map) out = out.split(a).join(b);
      return out;
    };
    for (const p of props) {
      const cfg = JSON.parse(remap(JSON.stringify(p.config))) as Record<string, unknown>;
      if (p.type === 'relation') cfg.dual = null;
      T.props(ctx).insert({ ...structuredClone(p), id: map.get(p.id)!, databaseId: db.id, config: cfg });
    }
    for (const v of viewsOf(ctx, src.id)) T.views(ctx).insert({ ...(JSON.parse(remap(JSON.stringify(v))) as ViewRecord), id: ctx.id(), databaseId: db.id });
    ctx.progress(1, 3, 'Copying rows');
    let rows = 0;
    if (req.withRows) {
      for (const r of liveRows(ctx, src.id)) {
        ctx.checkCancelled();
        const values = JSON.parse(remap(JSON.stringify(r.values))) as Record<Id, CellValue>;
        const id = ctx.id();
        T.rows(ctx).insert({ ...structuredClone(r), id, databaseId: db.id, values, rev: 1 });
        const doc = ctx.docs.get(r.id);
        if (doc) ctx.docs.save(id, 'row', structuredClone(doc.doc));
        rows++;
      }
      T.dbs(ctx).update(db.id, (d) => void (d.uidSeq = { ...Object.fromEntries(Object.entries(src.uidSeq).map(([k, v]) => [map.get(k) ?? k, v])) }));
    }
    ctx.progress(2, 3, `${rows} rows`);
    bump(ctx, db.id, 'both');
    return { page: ctx.pages.meta(dup.id) };
  },

  db_property_create: (req, ctx) => stripProp(createProperty(ctx, req.databaseId, { name: req.name, type: req.type, config: req.config }, req.afterId)),

  db_property_update: (req, ctx) => {
    const p = requireProp(ctx, req.id);
    const patch = req.patch ?? {};
    const props = propsOf(ctx, p.databaseId);
    if (patch.name !== undefined) {
      const n = patch.name.trim().slice(0, 200);
      if (!n) fail('INVALID', 'Give the property a name', 'name');
      if (props.some((x) => x.id !== p.id && x.name.toLowerCase() === n.toLowerCase())) fail('CONFLICT', `There is already a property called “${n}”`, 'name');
    }
    if (patch.hidden && p.type === 'title') fail('INVALID', "The title can't be hidden");
    T.props(ctx).update(p.id, (x) => {
      if (patch.name !== undefined) x.name = patch.name.trim().slice(0, 200);
      if (patch.hidden !== undefined) x.hidden = patch.hidden;
      if (patch.description !== undefined) x.description = patch.description;
      if (patch.config !== undefined) {
        const cfg = { ...x.config, ...patch.config };
        if (x.type === 'formula' && typeof cfg.expression === 'string') cfg.expression = toStorage(cfg.expression, props);
        if (x.type === 'select' || x.type === 'multi_select' || x.type === 'status') cfg.options = normalizeConfig(ctx, x.type, { options: cfg.options }).options;
        if (x.type === 'relation') {
          cfg.dual = x.config.dual ?? null;
          cfg.targetDatabaseId = x.config.targetDatabaseId;
        }
        x.config = cfg;
      }
    });
    const cur = T.props(ctx).require(p.id);
    if (patch.config && (cur.type === 'formula' || cur.type === 'rollup')) {
      const t = resultTypeOf(ctx, cur);
      T.props(ctx).update(p.id, (x) => void (x.config = { ...x.config, resultType: t }));
    }
    if (patch.config && cur.type === 'unique_id' && patch.config.prefix !== undefined) {
      const prefix = String(patch.config.prefix ?? '');
      for (const r of liveRows(ctx, p.databaseId)) {
        const c = r.values[p.id];
        if (c?.t !== 'uid') continue;
        const num = c.v.split('-').pop() ?? c.v;
        T.rows(ctx).update(r.id, (x) => void (x.values[p.id] = { t: 'uid', v: prefix ? `${prefix}-${num}` : num }));
      }
    }
    bump(ctx, p.databaseId, patch.config ? 'both' : 'schema');
    refreshResultTypes(ctx, p.databaseId);
    return stripProp(T.props(ctx).require(p.id));
  },

  db_property_convert: async (req, ctx) => {
    const p = requireProp(ctx, req.id);
    if (p.type === 'title') fail('INVALID', "The title property can't change type");
    if (!TYPE_META[req.to]) fail('INVALID', 'Unknown type', 'to');
    if (req.to === 'title') fail('INVALID', 'A database has exactly one title property');
    const rows = liveRows(ctx, p.databaseId);
    // pre_bulk schema version (restorable)
    ctx.versions.create({ targetId: p.databaseId, targetKind: 'db_schema', reason: 'pre_bulk', label: `Before converting “${p.name}”`, snapshot: { propId: p.id, property: stripProp(p), rows: rows.map((r) => ({ id: r.id, v: r.values[p.id] })) } });
    const from = structuredClone(p);
    let config = normalizeConfig(ctx, req.to, req.config);
    if ((req.to === 'select' || req.to === 'multi_select' || req.to === 'status') && !(Array.isArray(req.config?.options) && (req.config.options as unknown[]).length)) {
      const names = new Set<string>();
      for (const r of rows) {
        const t = formatCell(r.values[p.id], from);
        const parts = req.to === 'multi_select' || from.type === 'multi_select' ? t.split(',') : [t];
        for (const s of parts) if (s.trim() && names.size < 200) names.add(s.trim());
      }
      const used: BlockColor[] = [];
      config = normalizeConfig(ctx, req.to, {
        options: [...names].map((n) => {
          const color = nextTagColor(n, used);
          used.push(color);
          return { name: n, color };
        }),
      });
    }
    if (req.to === 'money' && from.type === 'number') config.currency = req.config?.currency ?? 'USD';
    T.props(ctx).update(p.id, (x) => {
      x.type = req.to;
      x.config = config;
    });
    const to = T.props(ctx).require(p.id);
    const total = rows.length;
    let i = 0;
    for (const r of rows) {
      ctx.checkCancelled();
      const next = isReadOnlyType(req.to) ? null : convertCell(from, to, r.values[p.id]);
      T.rows(ctx).update(r.id, (x) => {
        if (next) x.values[p.id] = next;
        else delete x.values[p.id];
      });
      if (++i % 500 === 0) ctx.progress(i, total, `${i} of ${total} rows`);
    }
    if (req.to === 'unique_id') backfillUids(ctx, T.dbs(ctx).require(p.databaseId), to);
    if (req.to === 'formula' || req.to === 'rollup') T.props(ctx).update(p.id, (x) => void (x.config = { ...x.config, resultType: resultTypeOf(ctx, x) }));
    bump(ctx, p.databaseId, 'both');
    return stripProp(T.props(ctx).require(p.id));
  },

  db_property_delete: (req, ctx) => {
    const p = requireProp(ctx, req.id);
    if (p.type === 'title') fail('INVALID', "The title property can't be deleted");
    const now = ctx.clock.now();
    T.props(ctx).update(p.id, (x) => void (x.deletedAt = now));
    const dualId = (p.config.dual as { propertyId?: Id } | null)?.propertyId;
    if (dualId) {
      const dual = T.props(ctx).get(dualId);
      if (dual && !dual.deletedAt) {
        if (req.alsoDual) {
          T.props(ctx).update(dualId, (x) => void (x.deletedAt = now));
        } else T.props(ctx).update(dualId, (x) => void (x.config = { ...x.config, dual: null }));
        bump(ctx, dual.databaseId, 'schema');
      }
    }
    // drop references from views
    for (const v of viewsOf(ctx, p.databaseId)) {
      T.views(ctx).update(v.id, (x) => {
        x.visibleProps = x.visibleProps.filter((id) => id !== p.id);
        x.sorts = x.sorts.filter((s) => s.prop !== p.id);
        if (x.groupBy?.prop === p.id) delete x.groupBy;
        delete x.footerAggs[p.id];
        if (x.calendar?.dateProp === p.id) x.calendar = { ...x.calendar, dateProp: '' };
      });
    }
    bump(ctx, p.databaseId, 'both');
  },

  db_property_reorder: (req, ctx) => {
    const p = requireProp(ctx, req.id);
    const others = propsOf(ctx, p.databaseId).filter((x) => x.id !== p.id);
    let key: string;
    if (req.beforeId) {
      const i = others.findIndex((x) => x.id === req.beforeId);
      key = ctx.keyBetween(i > 0 ? others[i - 1].sortKey : null, others[i]?.sortKey ?? null);
    } else if (req.afterId) {
      const i = others.findIndex((x) => x.id === req.afterId);
      key = ctx.keyBetween(others[i]?.sortKey ?? null, others[i + 1]?.sortKey ?? null);
    } else key = ctx.keyBetween(others[others.length - 1]?.sortKey ?? null, null);
    T.props(ctx).update(p.id, (x) => void (x.sortKey = key));
    bump(ctx, p.databaseId, 'schema');
    return stripProp(T.props(ctx).require(p.id));
  },

  db_select_option_upsert: (req, ctx) => {
    const p = requireProp(ctx, req.propertyId);
    if (p.type !== 'select' && p.type !== 'multi_select' && p.type !== 'status') fail('INVALID', 'Not a select property');
    const o: SelectOptionInput = req.option;
    const name = String(o.name ?? '').trim().slice(0, 200);
    if (!name) fail('INVALID', 'Give the option a name', 'name');
    const opts = [...optionsOf(p)];
    const clash = opts.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== o.id);
    if (clash) fail('CONFLICT', `“${name}” already exists`, 'name');
    if (o.id) {
      const i = opts.findIndex((x) => x.id === o.id);
      if (i < 0) fail('NOT_FOUND', 'Option not found');
      opts[i] = { ...opts[i], name, color: o.color ?? opts[i].color, ...(p.type === 'status' ? { group: o.group ?? opts[i].group ?? 'todo' } : {}) };
    } else {
      if (opts.length >= 500) fail('TOO_LARGE', 'Too many options');
      const opt: SelectOption = { id: optionId(ctx), name, color: o.color ?? nextTagColor(name, opts.map((x) => x.color)) };
      if (p.type === 'status') {
        opt.group = o.group ?? 'todo';
        // keep status options grouped
        const order = ['todo', 'in_progress', 'complete'];
        const lastIdx = opts.map((x, i) => [x, i] as const).filter(([x]) => order.indexOf(x.group ?? 'todo') <= order.indexOf(opt.group!)).pop()?.[1];
        opts.splice(lastIdx === undefined ? 0 : lastIdx + 1, 0, opt);
      } else opts.push(opt);
    }
    T.props(ctx).update(p.id, (x) => void (x.config = { ...x.config, options: opts }));
    bump(ctx, p.databaseId, 'schema');
    return stripProp(T.props(ctx).require(p.id));
  },

  db_select_option_delete: (req, ctx) => {
    const p = requireProp(ctx, req.propertyId);
    const opts = optionsOf(p).filter((o) => o.id !== req.optionId);
    T.props(ctx).update(p.id, (x) => void (x.config = { ...x.config, options: opts }));
    const touched: Id[] = [];
    for (const r of liveRows(ctx, p.databaseId)) {
      const c = r.values[p.id];
      if (!c) continue;
      if ((c.t === 'select' || c.t === 'status') && c.v === req.optionId) {
        T.rows(ctx).update(r.id, (x) => void delete x.values[p.id]);
        touched.push(r.id);
      } else if (c.t === 'multi' && c.v.includes(req.optionId)) {
        T.rows(ctx).update(r.id, (x) => void (x.values[p.id] = { t: 'multi', v: c.v.filter((id) => id !== req.optionId) }));
        touched.push(r.id);
      }
    }
    bump(ctx, p.databaseId, 'both', touched);
    return stripProp(T.props(ctx).require(p.id));
  },

  db_query: (req, ctx) => dbQuery(ctx, req),

  db_query_range: (req, ctx) => {
    const q = resolveQuery(ctx, req.databaseId, req.viewId, { groupBy: null });
    const res = runQuery(ctx, req.databaseId, { ...q, groupBy: undefined });
    const from = Date.parse(req.from.length === 10 ? req.from + 'T00:00:00' : req.from);
    const to = Date.parse(req.to.length === 10 ? req.to + 'T23:59:59' : req.to);
    const dp = req.dateProp === '$created' ? '$created' : req.dateProp;
    return res.order
      .filter((r) => {
        const range = cellDateRange(cellFor(r, dp as Id));
        return !!range && range.start <= to && range.end >= from;
      })
      .slice(0, 2000);
  },

  db_chart_data: (req, ctx) => chartData(ctx, req.databaseId, req.viewId, req.filter, req.spec, Math.min(1000, req.maxPoints ?? 200)),

  db_row_get: (req, ctx) => {
    const r = requireRow(ctx, req.id);
    const dto = rowDto(ctx, req.id);
    const doc = ctx.docs.get(r.id);
    const view = viewsOf(ctx, r.databaseId)[0];
    const q = resolveQuery(ctx, r.databaseId, view?.id, { groupBy: null });
    const order = runQuery(ctx, r.databaseId, { ...q, groupBy: undefined }).order;
    const i = order.findIndex((x) => x.id === r.id);
    const out: ReturnType<NonNullable<MockHandlers['db_row_get']>> extends Promise<infer X> ? X : ReturnType<NonNullable<MockHandlers['db_row_get']>> = {
      row: dto,
      doc: doc?.doc ?? null,
      docRev: doc?.rev ?? 0,
      databaseId: r.databaseId,
    };
    if (i > 0) out.prevId = order[i - 1].id;
    if (i >= 0 && i < order.length - 1) out.nextId = order[i + 1].id;
    return out;
  },

  db_row_create: (req, ctx) => {
    const db = requireDb(ctx, req.databaseId);
    const templateId = req.templateId ?? (req.values ? undefined : db.defaultTemplateId);
    // New rows in a filtered view start out matching its simple top-level conditions (so they don't vanish).
    const values: Record<Id, CellValue> = { ...(req.values ?? {}) };
    const view = req.viewId ? T.views(ctx).get(req.viewId) : undefined;
    if (view?.filter) {
      const conds = 'and' in view.filter ? view.filter.and : 'or' in view.filter ? [] : [view.filter];
      const props = new Map(propsOf(ctx, req.databaseId).map((p) => [p.id, p] as const));
      for (const c of conds) {
        if (!('prop' in c) || values[c.prop]) continue;
        const p = props.get(c.prop);
        if (!p) continue;
        const first = Array.isArray(c.value) ? (c.value[0] as string | undefined) : (c.value as string | undefined);
        if ((p.type === 'select' || p.type === 'status') && (c.op === 'eq' || c.op === 'any_of') && first) values[p.id] = { t: p.type, v: first };
        else if (p.type === 'multi_select' && (c.op === 'any_of' || c.op === 'all_of') && Array.isArray(c.value)) values[p.id] = { t: 'multi', v: c.value as Id[] };
        else if (p.type === 'checkbox' && (c.op === 'checked' || c.op === 'unchecked')) values[p.id] = { t: 'check', v: c.op === 'checked' };
        else if ((p.type === 'text' || p.type === 'url' || p.type === 'email') && c.op === 'eq' && typeof c.value === 'string') values[p.id] = p.type === 'text' ? { t: 'text', v: rt(c.value) } : { t: p.type, v: c.value };
      }
    }
    const rec = createRow(ctx, req.databaseId, { values: Object.keys(values).length ? values : undefined, afterId: req.afterId, templateId });
    return rowDto(ctx, rec.id);
  },

  db_rows_update: (req, ctx) => updateRows(ctx, req.updates),

  db_rows_delete: (req, ctx) => {
    const now = ctx.clock.now();
    const dbs = new Map<Id, Id[]>();
    for (const id of req.ids) {
      const r = T.rows(ctx).get(id);
      if (!r || r.deletedAt) continue;
      T.rows(ctx).update(id, (x) => void (x.deletedAt = now));
      dbs.set(r.databaseId, [...(dbs.get(r.databaseId) ?? []), id]);
    }
    for (const [d, ids] of dbs) bump(ctx, d, 'data', ids);
  },

  db_rows_restore: (req, ctx) => {
    const dbs = new Map<Id, Id[]>();
    for (const id of req.ids) {
      const r = T.rows(ctx).get(id);
      if (!r || !r.deletedAt) continue;
      T.rows(ctx).update(id, (x) => void delete x.deletedAt);
      dbs.set(r.databaseId, [...(dbs.get(r.databaseId) ?? []), id]);
    }
    for (const [d, ids] of dbs) bump(ctx, d, 'data', ids);
    return req.ids.filter((id) => T.rows(ctx).get(id) && !T.rows(ctx).get(id)!.deletedAt).map((id) => rowDto(ctx, id));
  },

  db_rows_move: (req, ctx) => {
    if (!req.ids.length) return [];
    const first = requireRow(ctx, req.ids[0]);
    const dbId = first.databaseId;
    const moving = new Set(req.ids);
    const others = liveRows(ctx, dbId).filter((r) => !moving.has(r.id)).sort((a, b) => compareKeys(a.sortKey, b.sortKey));
    let lo: string | null = null;
    let hi: string | null = null;
    if (req.beforeId) {
      const i = others.findIndex((r) => r.id === req.beforeId);
      if (i >= 0) {
        hi = others[i].sortKey;
        lo = i > 0 ? others[i - 1].sortKey : null;
      }
    } else if (req.afterId) {
      const i = others.findIndex((r) => r.id === req.afterId);
      if (i >= 0) {
        lo = others[i].sortKey;
        hi = others[i + 1]?.sortKey ?? null;
      }
    } else if (!req.groupValue) {
      lo = others[others.length - 1]?.sortKey ?? null;
    }
    const keys = req.beforeId || req.afterId || !req.groupValue ? generateNKeysBetween(lo, hi, req.ids.length) : null;
    const gv = req.groupValue;
    const gp = gv ? requireProp(ctx, gv.prop) : undefined;
    const now = ctx.clock.now();
    const touched = new Set<Id>();
    req.ids.forEach((id, i) => {
      const r = requireRow(ctx, id);
      if (r.databaseId !== dbId) fail('INVALID', 'Rows must belong to one database');
      let value: CellValue | null | undefined;
      if (gp && gv) value = sanitizeValue(ctx, gp, gv.value, r.id);
      if (gp?.type === 'relation' && value) syncDual(ctx, gp, r.id, ((r.values[gp.id] as { v?: Id[] })?.v ?? []) as Id[], (value as { v: Id[] }).v, touched);
      T.rows(ctx).update(id, (x) => {
        if (keys) x.sortKey = keys[i];
        if (gp) {
          if (value === null || (value && isEmptyCell(value) && value.t !== 'check')) delete x.values[gp.id];
          else if (value) x.values[gp.id] = value;
          x.updatedAt = now;
        }
      });
    });
    bump(ctx, dbId, 'data', req.ids);
    for (const t of touched) if (t !== dbId) bump(ctx, t, 'data');
    return req.ids.map((id) => rowDto(ctx, id));
  },

  db_rows_duplicate: (req, ctx) => {
    const out: Id[] = [];
    let dbId: Id | null = null;
    for (const id of req.ids) {
      const r = requireRow(ctx, id);
      dbId = r.databaseId;
      const db = T.dbs(ctx).require(r.databaseId);
      const props = propsOf(ctx, r.databaseId);
      const values = structuredClone(r.values);
      for (const p of props) {
        if (p.type === 'secret') delete values[p.id];
        if (p.type === 'relation' && p.config.dual) delete values[p.id];
      }
      const t = values[db.primaryPropId];
      if (t && t.t === 'text' && plainText(t.v)) values[db.primaryPropId] = { t: 'text', v: rt(plainText(t.v) + ' (copy)') };
      const copy = createRow(ctx, r.databaseId, { afterId: r.id, icon: r.icon, silent: true, doc: ctx.docs.get(r.id)?.doc });
      T.rows(ctx).update(copy.id, (x) => void (x.values = { ...values, ...Object.fromEntries(Object.entries(x.values).filter(([k]) => props.find((p) => p.id === k)?.type === 'unique_id')) }));
      out.push(copy.id);
    }
    if (dbId) bump(ctx, dbId, 'data', out);
    return out.map((id) => rowDto(ctx, id));
  },

  db_view_create: (req, ctx) => {
    const v = createView(ctx, req.databaseId, { name: req.name, layout: req.layout }, req.fromViewId);
    bump(ctx, req.databaseId, 'schema');
    return stripView(v);
  },

  db_view_update: (req, ctx) => {
    const v = requireView(ctx, req.id);
    const patch = viewPatchSanitize(ctx, v, req.patch ?? {});
    T.views(ctx).update(v.id, (x) => {
      for (const [k, val] of Object.entries(patch)) {
        if (val === undefined || val === null) delete (x as unknown as Record<string, unknown>)[k];
        else (x as unknown as Record<string, unknown>)[k] = val;
      }
    });
    bump(ctx, v.databaseId, 'schema');
    return stripView(T.views(ctx).require(v.id));
  },

  db_view_delete: (req, ctx) => {
    const v = requireView(ctx, req.id);
    if (viewsOf(ctx, v.databaseId).length <= 1) fail('INVALID', 'A database needs at least one view');
    T.views(ctx).delete(v.id);
    bump(ctx, v.databaseId, 'schema');
  },

  db_view_reorder: (req, ctx) => {
    const v = requireView(ctx, req.id);
    const others = viewsOf(ctx, v.databaseId).filter((x) => x.id !== v.id);
    let key: string;
    if (req.beforeId) {
      const i = others.findIndex((x) => x.id === req.beforeId);
      key = ctx.keyBetween(i > 0 ? others[i - 1].sortKey : null, others[i]?.sortKey ?? null);
    } else if (req.afterId) {
      const i = others.findIndex((x) => x.id === req.afterId);
      key = ctx.keyBetween(others[i]?.sortKey ?? null, others[i + 1]?.sortKey ?? null);
    } else key = ctx.keyBetween(others[others.length - 1]?.sortKey ?? null, null);
    T.views(ctx).update(v.id, (x) => void (x.sortKey = key));
    bump(ctx, v.databaseId, 'schema');
    return stripView(T.views(ctx).require(v.id));
  },

  db_relation_options: (req, ctx) => {
    const p = requireProp(ctx, req.propertyId);
    if (p.type !== 'relation') fail('INVALID', 'Not a relation property');
    const target = String(p.config.targetDatabaseId ?? '');
    const tdb = requireDb(ctx, target);
    const q = (req.search ?? '').trim().toLocaleLowerCase();
    const out: { id: Id; title: string; icon?: Icon }[] = [];
    const rows = liveRows(ctx, target).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    for (const r of rows) {
      const title = plainText(((r.values[tdb.primaryPropId] as { v?: RichText }) ?? {}).v ?? []);
      if (q && !title.toLocaleLowerCase().includes(q)) continue;
      const o: { id: Id; title: string; icon?: Icon } = { id: r.id, title: title || 'Untitled' };
      if (r.icon) o.icon = r.icon;
      out.push(o);
      if (out.length >= Math.min(1000, Math.max(1, req.limit))) break;
    }
    return out;
  },

  db_formula_check: (req, ctx) => {
    requireDb(ctx, req.databaseId);
    const props = propsOf(ctx, req.databaseId);
    let c: Compiled;
    try {
      c = compile(req.expression, props);
    } catch (e) {
      const fe = e instanceof FormulaError ? e : new FormulaError(String(e));
      return { ok: false, error: { message: fe.message, from: fe.from, to: fe.to }, preview: [] };
    }
    // cycle check against other formulas
    const formulas = new Map(props.filter((p) => p.type === 'formula').map((p) => [p.id, p] as const));
    const seen = new Set<Id>();
    const stack = [...c.deps];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const f = formulas.get(id);
      if (!f) continue;
      const fc = compiledFor(ctx, f);
      if (fc instanceof FormulaError) continue;
      if ([...fc.deps].some((d) => d === (req as { propertyId?: Id }).propertyId)) return { ok: false, error: { message: 'Circular reference', from: 0, to: req.expression.length }, preview: [] };
      stack.push(...fc.deps);
    }
    const host = makeHost(ctx);
    const preview: string[] = [];
    let type: string | undefined;
    const sample = liveRows(ctx, req.databaseId).slice().sort((a, b) => compareKeys(a.sortKey, b.sortKey)).slice(0, 5);
    try {
      for (const r of sample) {
        const v = evaluate(c, r as unknown as RowDTO, props, host);
        const comp = toComputed(v);
        type ??= kindOf(v) ?? undefined;
        const title = plainText(((r.values[T.dbs(ctx).require(req.databaseId).primaryPropId] as { v?: RichText }) ?? {}).v ?? []) || 'Untitled';
        preview.push(`${title}\u0000${comp.display}`);
      }
    } catch (e) {
      const fe = e instanceof FormulaError ? e : new FormulaError(String(e));
      return { ok: false, error: { message: fe.message, from: fe.from, to: fe.to }, preview };
    }
    return { ok: true, type: type ?? 'text', preview };
  },

  db_import_preview: async (req, ctx) => {
    const parsed = await readImport(ctx, req.grantId);
    previewCache.set(req.grantId, { ...parsed, at: Date.now() });
    const cols = columnsOf(parsed.rows);
    const out = { columns: cols, rows: Math.max(0, parsed.rows.length - 1), delimiter: parsed.delimiter, encoding: 'utf-8' } as Awaited<ReturnType<NonNullable<MockHandlers['db_import_preview']>>>;
    if (parsed.sheets) out.sheets = parsed.sheets;
    return out;
  },

  db_import_csv: async (req, ctx) => {
    let parsed = previewCache.get(req.grantId);
    previewCache.delete(req.grantId);
    if (!parsed) parsed = { ...(await readImport(ctx, req.grantId)), at: Date.now() };
    const rows = parsed.rows;
    if (rows.length < 1) fail('INVALID', 'That file has no rows');
    const header = rows[0];
    const body = rows.slice(1);
    const cols = columnsOf(rows);
    let dbId: Id;
    const mapping = new Map<number, PropRecord>();
    ctx.progress(0, body.length, 'Preparing');
    if ('databaseId' in req.target) {
      dbId = req.target.databaseId;
      requireDb(ctx, dbId);
      const m = req.target.mapping;
      for (let i = 0; i < header.length; i++) {
        const name = cols[i].name;
        const to = m[name] ?? m[header[i]] ?? 'skip';
        if (to === 'skip') continue;
        if (to === 'new') {
          const t = cols[i].inferred === 'title' ? 'text' : cols[i].inferred;
          mapping.set(i, createProperty(ctx, dbId, { name, type: t }, undefined, { silent: true }));
        } else {
          const p = requireProp(ctx, to);
          if (p.databaseId !== dbId) fail('INVALID', 'Mapping points at another database');
          mapping.set(i, p);
        }
      }
    } else {
      const created = createDatabase(ctx, {
        workspaceId: req.target.workspaceId,
        parentId: req.target.parentId,
        title: req.target.title || 'Imported data',
        icon: { t: 'lucide', v: 'inbox' },
        properties: cols.map((c) => ({ name: c.name, type: c.inferred })),
      });
      dbId = created.db.id;
      const props = propsOf(ctx, dbId);
      cols.forEach((c, i) => {
        const p = props.find((x) => x.name === c.name || (i === 0 && x.type === 'title'));
        if (p) mapping.set(i, p);
      });
    }
    const optCache = new Map<Id, Map<string, Id>>();
    let inserted = 0;
    for (const line of body) {
      ctx.checkCancelled();
      const values: Record<Id, CellValue> = {};
      for (const [i, p] of mapping) {
        const v = importValue(ctx, T.props(ctx).require(p.id), line[i] ?? '', optCache);
        if (v) values[p.id] = v;
      }
      createRow(ctx, dbId, { values, silent: true });
      inserted++;
      if (inserted % 250 === 0) {
        ctx.progress(inserted, body.length, `${inserted} of ${body.length} rows`);
        await ctx.sleep(0, ctx.signal);
      }
    }
    refreshResultTypes(ctx, dbId);
    bump(ctx, dbId, 'both');
    return { databaseId: dbId, inserted };
  },

  db_export: async (req, ctx) => {
    const db = requireDb(ctx, req.databaseId);
    const page = ctx.pages.require(db.id);
    const view = req.viewId ? requireView(ctx, req.viewId) : viewsOf(ctx, db.id)[0];
    const q = resolveQuery(ctx, db.id, view?.id, { groupBy: null });
    const res = runQuery(ctx, db.id, { ...q, groupBy: undefined });
    const props = propsOf(ctx, db.id).filter((p) => p.type !== 'secret' && (!view || view.layout !== 'table' || view.visibleProps.includes(p.id) || p.id === db.primaryPropId));
    const relTitle = relationTitleFn(ctx);
    ctx.progress(0, res.order.length, 'Exporting');
    if (req.format === 'xlsx') {
      const grid: (string | number | null)[][] = [props.map((p) => p.name)];
      for (const r of res.order) {
        grid.push(
          props.map((p) => {
            const c = cellFor(r, p.type === 'created_time' ? '$created' : p.type === 'updated_time' ? '$updated' : p.id);
            if (c?.t === 'number') return c.v;
            if (c?.t === 'money' && c.v !== null) return Number(c.v);
            if (c?.t === 'computed' && (c.v.kind === 'number' || c.v.kind === 'money') && typeof c.v.value === 'number') return c.v.value;
            return exportCell(c, p, { relationTitle: relTitle });
          }),
        );
      }
      ctx.grants.write(req.grantId, writeXlsx(grid, page.title || 'Database'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } else {
      const grid: string[][] = [props.map((p) => p.name)];
      for (const r of res.order) grid.push(props.map((p) => exportCell(cellFor(r, p.type === 'created_time' ? '$created' : p.type === 'updated_time' ? '$updated' : p.id), p, { relationTitle: relTitle })));
      ctx.grants.write(req.grantId, toCsv(grid), 'text/csv');
    }
    ctx.progress(res.order.length, res.order.length, 'Done');
    return { rows: res.order.length };
  },
};

// ───────────────────────────────────────────────────────────────────────────── services for other mocks

export interface DbApi {
  createDatabase: typeof createDatabase;
  createRow: typeof createRow;
  createProperty: typeof createProperty;
  createView: typeof createView;
  schema: typeof schemaOf;
  /** Live rows with computed values. */
  rows: (ctx: MockCtx, dbId: Id) => RowDTO[];
  updateRows: (ctx: MockCtx, updates: { id: Id; values: Record<Id, CellValue | null> }[]) => RowDTO[];
  setTemplates: (ctx: MockCtx, dbId: Id, templates: RowTemplate[], defaultId?: Id) => void;
  /** Mark rows as sample data (life apps). */
  emitChanged: (ctx: MockCtx, dbId: Id) => void;
}

export function setup(ctx: MockCtx): void {
  const dbApi: DbApi = {
    createDatabase,
    createRow,
    createProperty,
    createView,
    schema: schemaOf,
    rows: (c, id) => materialize(c, id).rows,
    updateRows,
    setTemplates: (c, id, templates, defaultId) => {
      T.dbs(c).update(id, (d) => {
        d.templates = templates;
        if (defaultId) d.defaultTemplateId = defaultId;
      });
    },
    emitChanged: (c, id) => bump(c, id, 'both'),
  };
  ctx.services.provide('db.api', dbApi);

  // Rows in search (§5.9 '#' prefix and plain queries): titles plus text properties.
  ctx.search.register('db.rows', (q, filters) => {
    if (!q.trim() && !filters.db) return [];
    const out: ReturnType<Parameters<MockCtx['search']['register']>[1]> = [];
    for (const db of T.dbs(ctx).values()) {
      if (filters.db && filters.db !== db.id) continue;
      const page = ctx.pages.get(db.id);
      if (!page || page.deletedAt) continue;
      const props = propsOf(ctx, db.id).filter((p) => p.type === 'text');
      const path = [...ctx.pages.ancestors(db.id).map((a) => a.title || 'Untitled'), page.title || 'Untitled'];
      for (const r of liveRows(ctx, db.id)) {
        const title = plainText(((r.values[db.primaryPropId] as { v?: RichText }) ?? {}).v ?? []);
        if (!title) continue;
        const c: (typeof out)[number] = {
          id: r.id,
          kind: 'row',
          title,
          path,
          updatedAt: r.updatedAt,
          text: props.map((p) => plainText(((r.values[p.id] as { v?: RichText }) ?? {}).v ?? [])).join(' ').slice(0, 2000),
          databaseId: db.id,
          ancestorIds: [db.id, ...ctx.pages.ancestors(db.id).map((a) => a.id)],
        };
        if (r.icon) c.icon = r.icon;
        out.push(c);
      }
    }
    return out;
  });

  // Row bodies: hasBody + updated_time follow body edits.
  ctx.events.on('doc:saved', (e) => {
    if (e.ownerKind !== 'row') return;
    const r = T.rows(ctx).get(e.ownerId);
    if (!r || r.deletedAt) return;
    T.rows(ctx).update(r.id, (x) => void (x.updatedAt = ctx.clock.now()));
    bump(ctx, r.databaseId, 'data', [r.id]);
  });

  // Duplicating a page subtree copies inline databases inside it.
  ctx.events.on('page:duplicated', (e) => {
    for (const [srcId, newId] of Object.entries(e.map)) {
      const src = T.dbs(ctx).get(srcId);
      if (!src || T.dbs(ctx).has(newId)) continue;
      const map = new Map<Id, Id>();
      const props = propsOf(ctx, srcId);
      for (const p of props) map.set(p.id, ctx.id());
      const remap = (s: string) => {
        let out = s;
        for (const [a, b] of map) out = out.split(a).join(b);
        return out;
      };
      T.dbs(ctx).insert({ ...structuredClone(src), id: newId, primaryPropId: map.get(src.primaryPropId)!, schemaRev: 1, dataRev: 1, roles: {} });
      for (const p of props) T.props(ctx).insert({ ...(JSON.parse(remap(JSON.stringify(p))) as PropRecord), id: map.get(p.id)!, databaseId: newId });
      for (const v of viewsOf(ctx, srcId)) T.views(ctx).insert({ ...(JSON.parse(remap(JSON.stringify(v))) as ViewRecord), id: ctx.id(), databaseId: newId });
      for (const r of liveRows(ctx, srcId)) T.rows(ctx).insert({ ...(JSON.parse(remap(JSON.stringify(r))) as RowRecord), id: ctx.id(), databaseId: newId, rev: 1 });
    }
  });

  // Schema-version restore (pre_bulk conversions): put the property's type/config and its cell values back.
  ctx.versions.onRestore('db_schema', (targetId, snapshot) => {
    const snap = snapshot as { propId?: Id; property?: Property; rows?: { id: Id; v?: CellValue }[] };
    if (!snap?.propId || !snap.property) return T.dbs(ctx).get(targetId)?.schemaRev ?? 0;
    const pid = snap.propId;
    if (T.props(ctx).get(pid)) {
      T.props(ctx).update(pid, (x) => {
        x.type = snap.property!.type;
        x.config = structuredClone(snap.property!.config);
        x.name = snap.property!.name;
        delete x.deletedAt;
      });
    }
    for (const r of snap.rows ?? []) {
      if (!T.rows(ctx).get(r.id)) continue;
      T.rows(ctx).update(r.id, (x) => {
        if (r.v) x.values[pid] = structuredClone(r.v);
        else delete x.values[pid];
      });
    }
    bump(ctx, targetId, 'both');
    return T.dbs(ctx).get(targetId)?.schemaRev ?? 0;
  });
}
