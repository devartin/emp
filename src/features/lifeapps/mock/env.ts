/**
 * Mock-only install environment shared by the per-app generators: page / database / view helpers, typed cell
 * builders, the key map (templateKey → id) and paced progress so the wizard's checklist animates for real.
 */
import type { CellValue, DateValue, Filter, GenerationPlan, Icon, Id, Layout, Property, PropType, RowDTO, Sort, TipTapNode, View } from '@/backend/types';
import type { MockCtx } from '@/backend/mock/ctx';
import type { DbApi, NewProp } from '@/backend/mock/commands/db';
import { makeDoc } from '@/backend/mock/lib/doc';
import type { LifeAppManifest } from '@/backend/types';

export interface InstanceRecord {
  id: Id;
  appId: string;
  version: string;
  workspaceId: Id;
  rootPageId: Id;
  installedAt: number;
  answers: Record<string, unknown>;
  mode: 'quick' | 'guided';
  keyMap: Record<string, Id>;
  created: Id[];
  detached: boolean;
  checklist: Record<string, boolean>;
  muted: Record<string, number | null>;
  sampleData: boolean;
  /** Touched fields (tune-up conflicts): templateKey → field names the user edited. */
  touched: Record<string, string[]>;
  lastReviewAt?: number;
}

export const instancesTable = (ctx: MockCtx) => ctx.db.table<InstanceRecord>('lifeapp_instances');

export interface DbHandle {
  id: Id;
  props: Record<string, Property>;
  views: Record<string, Id>;
  opt(prop: string, name: string): Id | null;
}

export interface Env {
  ctx: MockCtx;
  db: DbApi;
  manifest: LifeAppManifest;
  inst: InstanceRecord;
  answers: Record<string, unknown>;
  plan: GenerationPlan;
  sample: boolean;
  /** Clock "now" and its ISO day. */
  now: number;
  today: string;
  /** Template present in the plan and enabled. */
  on(key: string): boolean;
  keep(key: string, id: Id): void;
  step(label: string): Promise<void>;
  page(key: string, input: { title: string; icon?: Icon; blocks?: TipTapNode[]; kind?: 'doc' | 'dashboard'; parentId?: Id; createdAt?: number }): Id;
  database(key: string, input: { title: string; icon?: Icon; props: NewProp[]; firstView?: { name: string; layout: Layout }; parentId?: Id; description?: string }): DbHandle;
  view(h: DbHandle, name: string, layout: Layout, patch?: Partial<Omit<View, 'id' | 'sortKey' | 'layout' | 'name'>>): Id;
  row(h: DbHandle, values: Record<string, CellValue | SelRef | null | undefined>, extra?: { sample?: boolean; createdAt?: number; icon?: Icon; doc?: ReturnType<typeof makeDoc> }): Id;
  /** Handle for a database the instance already has (tune-up, sample data). */
  handle(key: string): DbHandle | null;
}

// ───────────────────────────────────────────────────────────────────────────── cell builders

export const c = {
  text: (s: string | null | undefined): CellValue | null => (s ? { t: 'text', v: [{ text: s }] } : null),
  num: (n: number | null | undefined): CellValue | null => (n === null || n === undefined || !Number.isFinite(n) ? null : { t: 'number', v: n }),
  money: (n: number | null | undefined, cur = 'USD'): CellValue | null => (n === null || n === undefined || !Number.isFinite(n) ? null : { t: 'money', v: n.toFixed(2), cur }),
  date: (start: string | null | undefined, end?: string, time = false): CellValue | null => {
    if (!start) return null;
    const v: DateValue = { start, time };
    if (end) v.end = end;
    return { t: 'date', v };
  },
  check: (b: boolean): CellValue => ({ t: 'check', v: b }),
  rel: (ids: (Id | null | undefined)[]): CellValue | null => {
    const v = ids.filter((x): x is Id => !!x);
    return v.length ? { t: 'relation', v } : null;
  },
  rating: (n: number | null): CellValue | null => (n === null ? null : { t: 'rating', v: n }),
  progress: (n: number | null): CellValue | null => (n === null ? null : { t: 'progress', v: Math.max(0, Math.min(1, n)) }),
  url: (s: string | null): CellValue | null => (s ? { t: 'url', v: s } : null),
  ticker: (s: string | null): CellValue | null => (s ? { t: 'ticker', v: s } : null),
  recurrence: (rrule: string, dtstart: string, mode: 'schedule' | 'completion' = 'schedule'): CellValue => ({ t: 'recurrence', v: { rrule, dtstart, mode } }),
};

/** Special markers resolved against the db's options: `sel('Status', 'Inbox')`. */
export const SEL = Symbol('sel');
export interface SelRef {
  [SEL]: true;
  names: string[];
  multi: boolean;
}
export const sel = (name: string | null | undefined): SelRef | null => (name ? { [SEL]: true, names: [name], multi: false } : null);
export const multi = (names: string[]): SelRef | null => (names.length ? { [SEL]: true, names, multi: true } : null);

export const lucide = (v: string): Icon => ({ t: 'lucide', v });
export const emoji = (v: string): Icon => ({ t: 'emoji', v });

/** 'YYYY-MM-DD' for a ms timestamp (local calendar day, like `ctx.clock.today()`). */
export const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const DAY = 86_400_000;

/** Deterministic PRNG for sample data. */
export function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ───────────────────────────────────────────────────────────────────────────── env factory

const sleepMs = (ctx: MockCtx, ms: number) => (ctx.seeding ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)));

export function createEnv(input: {
  ctx: MockCtx;
  db: DbApi;
  manifest: LifeAppManifest;
  inst: InstanceRecord;
  answers: Record<string, unknown>;
  plan: GenerationPlan;
  sample: boolean;
  progress: (done: number, total: number, label?: string) => void;
  checkCancelled: () => void;
}): Env {
  const { ctx, db, inst, plan } = input;
  const now = ctx.clock.now();
  const enabledKeys = new Set(plan.items.filter((i) => i.enabled).map((i) => i.key));
  const total = plan.items.filter((i) => i.enabled).length + 2;
  let done = 1;
  const silent = ctx.seeding;
  const parentOf = (parentId?: Id) => parentId ?? inst.rootPageId;

  const handleFor = (id: Id): DbHandle => {
    const schema = db.schema(ctx, id);
    const props: Record<string, Property> = {};
    for (const p of schema.properties) props[p.name] = p;
    const views: Record<string, Id> = {};
    for (const v of schema.views) views[v.name] = v.id;
    return {
      id,
      props,
      views,
      opt(prop, name) {
        const p = props[prop];
        const opts = (p?.config.options as { id: Id; name: string }[] | undefined) ?? [];
        return opts.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id ?? null;
      },
    };
  };

  const env: Env = {
    ctx,
    db,
    manifest: input.manifest,
    inst,
    answers: input.answers,
    plan,
    sample: input.sample,
    now,
    today: isoDay(now),
    on: (key) => enabledKeys.has(key),
    keep(key, id) {
      inst.keyMap[key] = id;
      inst.created.push(id);
    },
    async step(label) {
      input.checkCancelled();
      done = Math.min(total - 1, done + 1);
      input.progress(done, total, label);
      await sleepMs(ctx, 140 + Math.round(Math.random() * 80));
    },
    page(key, p) {
      const rec = ctx.pages.create({
        workspaceId: inst.workspaceId,
        parentId: parentOf(p.parentId),
        kind: p.kind ?? 'doc',
        title: p.title,
        icon: p.icon,
        appInstanceId: inst.id,
        templateKey: `${inst.appId}:${key}`,
        doc: p.kind === 'dashboard' ? undefined : makeDoc(p.blocks ?? []),
        createdAt: p.createdAt,
        silent,
      });
      env.keep(key, rec.id);
      return rec.id;
    },
    database(key, d) {
      const res = db.createDatabase(ctx, {
        workspaceId: inst.workspaceId,
        parentId: parentOf(d.parentId),
        title: d.title,
        icon: d.icon,
        properties: d.props,
        views: [d.firstView ?? { name: 'All', layout: 'table' }],
        appInstanceId: inst.id,
        description: d.description,
        silent,
      });
      // The title property's role (createDatabase only records roles of non-title properties).
      const titleRole = d.props.find((p) => p.type === 'title')?.role;
      if (titleRole) {
        ctx.db.table<{ id: Id; roles: Record<string, Id>; primaryPropId: Id }>('db_databases').update(res.db.id, (x) => void (x.roles[titleRole] = x.primaryPropId));
        ctx.db.table<{ id: Id; role?: string }>('db_properties').update(res.db.primaryPropId, (p) => void (p.role = titleRole));
      }
      env.keep(key, res.db.id);
      return handleFor(res.db.id);
    },
    view(h, name, layout, patch) {
      const v = db.createView(ctx, h.id, { name, layout, patch });
      h.views[name] = v.id;
      return v.id;
    },
    handle(key) {
      const id = inst.keyMap[key];
      if (!id) return null;
      try {
        return handleFor(id);
      } catch {
        return null;
      }
    },
    row(h, values, extra) {
      const out: Record<Id, CellValue> = {};
      for (const [name, v] of Object.entries(values)) {
        const p = h.props[name];
        if (!p || v === null || v === undefined) continue;
        if (typeof v === 'object' && SEL in v) {
          const ref = v as unknown as SelRef;
          const ids = ref.names.map((n) => h.opt(name, n)).filter((x): x is Id => !!x);
          if (!ids.length) continue;
          if (p.type === 'multi_select') out[p.id] = { t: 'multi', v: ids };
          else out[p.id] = { t: p.type === 'status' ? 'status' : 'select', v: ids[0] };
          continue;
        }
        out[p.id] = v as CellValue;
      }
      const rec = db.createRow(ctx, h.id, { values: out, sample: extra?.sample ?? input.sample, createdAt: extra?.createdAt, icon: extra?.icon, doc: extra?.doc, silent: true });
      return rec.id;
    },
  };
  return env;
}

// ───────────────────────────────────────────────────────────────────────────── property builders

type Opt = string | { name: string; color?: string; group?: 'todo' | 'in_progress' | 'complete' };
const opts = (list: Opt[]) => list.map((o) => (typeof o === 'string' ? { name: o } : o));

export const P = {
  title: (name: string, role?: string): NewProp => ({ name, type: 'title', ...(role ? { role } : {}) }),
  text: (name: string, role?: string): NewProp => ({ name, type: 'text', ...(role ? { role } : {}) }),
  num: (name: string, role?: string, format: 'number' | 'percent' = 'number'): NewProp => ({ name, type: 'number', config: { format, display: 'number' }, ...(role ? { role } : {}) }),
  money: (name: string, role?: string, currency = 'USD'): NewProp => ({ name, type: 'money', config: { currency, perRowCurrency: false, decimals: 2 }, ...(role ? { role } : {}) }),
  select: (name: string, options: Opt[], role?: string): NewProp => ({ name, type: 'select', config: { options: opts(options), sort: 'manual' }, ...(role ? { role } : {}) }),
  multi: (name: string, options: Opt[], role?: string): NewProp => ({ name, type: 'multi_select', config: { options: opts(options), sort: 'manual' }, ...(role ? { role } : {}) }),
  status: (name: string, options: Opt[], role?: string): NewProp => ({ name, type: 'status', config: { options: opts(options), sort: 'manual' }, ...(role ? { role } : {}) }),
  date: (name: string, role?: string): NewProp => ({ name, type: 'date', ...(role ? { role } : {}) }),
  check: (name: string, role?: string): NewProp => ({ name, type: 'checkbox', ...(role ? { role } : {}) }),
  rel: (name: string, target: Id, role?: string, limit: 'one' | 'many' = 'many'): NewProp => ({ name, type: 'relation', config: { targetDatabaseId: target, limit }, ...(role ? { role } : {}) }),
  rating: (name: string, role?: string): NewProp => ({ name, type: 'rating', config: { max: 5, icon: 'star' }, ...(role ? { role } : {}) }),
  progress: (name: string, role?: string): NewProp => ({ name, type: 'progress', config: { display: 'bar' }, ...(role ? { role } : {}) }),
  url: (name: string, role?: string): NewProp => ({ name, type: 'url', ...(role ? { role } : {}) }),
  ticker: (name: string, role?: string): NewProp => ({ name, type: 'ticker', config: { showQuote: true }, ...(role ? { role } : {}) }),
  recurrence: (name: string, role?: string): NewProp => ({ name, type: 'recurrence', ...(role ? { role } : {}) }),
  files: (name: string, role?: string): NewProp => ({ name, type: 'files', ...(role ? { role } : {}) }),
  hidden: (p: NewProp): NewProp => ({ ...p, hidden: true }),
  typed: (name: string, type: PropType, config?: Record<string, unknown>, role?: string): NewProp => ({ name, type, ...(config ? { config } : {}), ...(role ? { role } : {}) }),
};

/** Filter / sort helpers over a handle. */
export const F = {
  eq: (h: DbHandle, prop: string, option: string): Filter => ({ prop: h.props[prop]?.id ?? '', op: 'eq', value: h.opt(prop, option) }),
  anyOf: (h: DbHandle, prop: string, options: string[]): Filter => ({ prop: h.props[prop]?.id ?? '', op: 'any_of', value: options.map((o) => h.opt(prop, o)).filter(Boolean) }),
  noneOf: (h: DbHandle, prop: string, options: string[]): Filter => ({ prop: h.props[prop]?.id ?? '', op: 'none_of', value: options.map((o) => h.opt(prop, o)).filter(Boolean) }),
  within: (h: DbHandle, prop: string, value: unknown): Filter => ({ prop: h.props[prop]?.id ?? '', op: 'within', value }),
  before: (h: DbHandle, prop: string, value: string): Filter => ({ prop: h.props[prop]?.id ?? '', op: 'before', value }),
  notEmpty: (h: DbHandle, prop: string): Filter => ({ prop: h.props[prop]?.id ?? '', op: 'not_empty' }),
  and: (...f: Filter[]): Filter => ({ and: f }),
  or: (...f: Filter[]): Filter => ({ or: f }),
  sort: (h: DbHandle, prop: string, dir: 'asc' | 'desc' = 'asc'): Sort => ({ prop: h.props[prop]?.id ?? '$created', dir }),
  visible: (h: DbHandle, names: string[]): Id[] => names.map((n) => h.props[n]?.id).filter((x): x is Id => !!x),
};

/** Read helpers over computed rows. */
export function cellText(r: RowDTO, p: Property | undefined): string {
  if (!p) return '';
  const v = r.values[p.id];
  if (!v) return '';
  if (v.t === 'text') return v.v.map((s) => s.text).join('');
  if (v.t === 'computed') return v.v.display;
  return '';
}
export function cellOpt(r: RowDTO, p: Property | undefined): string | null {
  if (!p) return null;
  const v = r.values[p.id];
  if (!v || (v.t !== 'select' && v.t !== 'status')) return null;
  const opts2 = (p.config.options as { id: Id; name: string }[] | undefined) ?? [];
  return opts2.find((o) => o.id === v.v)?.name ?? null;
}
export function cellNum(r: RowDTO, p: Property | undefined): number | null {
  if (!p) return null;
  const v = r.values[p.id];
  if (!v) return null;
  if (v.t === 'number' || v.t === 'rating' || v.t === 'progress') return v.v;
  if (v.t === 'money') return v.v === null ? null : Number(v.v);
  if (v.t === 'computed' && typeof v.v.value === 'number') return v.v.value;
  return null;
}
export function cellDate(r: RowDTO, p: Property | undefined): DateValue | null {
  if (!p) return null;
  const v = r.values[p.id];
  return v && v.t === 'date' ? v.v : null;
}
export function cellBool(r: RowDTO, p: Property | undefined): boolean {
  if (!p) return false;
  const v = r.values[p.id];
  return !!v && v.t === 'check' && v.v;
}
export function cellRel(r: RowDTO, p: Property | undefined): Id[] {
  if (!p) return [];
  const v = r.values[p.id];
  return v && v.t === 'relation' ? v.v : [];
}
