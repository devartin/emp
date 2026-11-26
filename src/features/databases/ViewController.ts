/**
 * ViewController (§13.2): a plain class per mounted view that owns the row windows of one `db_query`, read by
 * components through `useSyncExternalStore`.
 *
 * - Flat mode: windows of 200 rows aligned to 100-row pages, ±1 page prefetch in the scroll direction, LRU of
 *   2,000 rows, `knownQueryRev` on refresh.
 * - Grouped mode (board, grouped table/list): the group list first, then 50 rows per expanded group (infinite).
 * - Edits are optimistic and reconcile with the response; on error they roll back and toast.
 */
import { useSyncExternalStore } from 'react';
import { api, listen, latestRequest } from '@/backend';
import type { CellValue, DbQueryGroup, DbQueryOverride, DbQueryResult, Id, RowDTO } from '@/backend/types';
import { notify } from '@/stores/toasts';
import { undoable, useUndo } from '@/stores/undo';

export const PAGE = 100;
export const WINDOW = 200;
export const LRU_MAX = 2000;
export const GROUP_PAGE = 50;

export interface GroupState extends DbQueryGroup {
  ids: Id[];
  loaded: boolean;
  loading: boolean;
}

export interface ControllerSnapshot {
  version: number;
  total: number;
  /** index → row id (flat mode). */
  index: Map<number, Id>;
  rows: Map<Id, RowDTO>;
  groups: GroupState[] | null;
  aggs: Record<Id, string>;
  loading: boolean;
  ready: boolean;
  error: unknown;
  tookMs: number;
}

type Loaded = Extract<DbQueryResult, { rows: RowDTO[] }>;

export interface ControllerOptions {
  databaseId: Id;
  viewId?: Id;
  grouped: boolean;
  override?: DbQueryOverride;
  /** Collapsed groups are not fetched. */
  collapsed?: string[];
}

export class ViewController {
  readonly databaseId: Id;
  private viewId?: Id;
  private grouped: boolean;
  private override: DbQueryOverride;
  private collapsed: Set<string>;
  private snap: ControllerSnapshot;
  private listeners = new Set<() => void>();
  private pages = new Map<number, { rev?: string; at: number }>();
  private groupRevs = new Map<string, string>();
  private lastRange: [number, number] = [0, 0];
  private dir: 1 | -1 = 1;
  private req = latestRequest();
  private epoch = 0;
  private off: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rows being edited optimistically: id → values sent. */
  private pending = new Map<Id, number>();
  private disposed = false;

  constructor(o: ControllerOptions) {
    this.databaseId = o.databaseId;
    this.viewId = o.viewId;
    this.grouped = o.grouped;
    this.override = o.override ?? {};
    this.collapsed = new Set(o.collapsed ?? []);
    this.snap = this.empty();
    this.attach();
  }

  /** (Re)subscribe to `db:changed` — StrictMode mounts effects twice, so detach/attach must be reversible. */
  attach() {
    this.disposed = false;
    if (this.off) return;
    this.off = listen('db:changed', (e) => {
      if (e.databaseId === this.databaseId) this.scheduleRefresh();
    });
  }

  private empty(): ControllerSnapshot {
    return { version: 0, total: 0, index: new Map(), rows: new Map(), groups: null, aggs: {}, loading: true, ready: false, error: null, tookMs: 0 };
  }

  dispose() {
    this.disposed = true;
    this.off?.();
    this.off = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  // ── store protocol
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private commit(patch: Partial<ControllerSnapshot>) {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 };
    for (const l of this.listeners) l();
  }

  // ── configuration
  configure(o: Partial<ControllerOptions>) {
    let reset = false;
    let hard = false;
    if (o.viewId !== undefined && o.viewId !== this.viewId) {
      this.viewId = o.viewId;
      reset = hard = true;
    }
    if (o.grouped !== undefined && o.grouped !== this.grouped) {
      this.grouped = o.grouped;
      reset = hard = true;
    }
    if (o.override !== undefined && JSON.stringify(o.override) !== JSON.stringify(this.override)) {
      this.override = o.override;
      reset = true;
    }
    if (o.collapsed) {
      const next = new Set(o.collapsed);
      const opened = [...this.collapsed].filter((k) => !next.has(k));
      this.collapsed = next;
      if (!reset && opened.length && this.snap.groups) for (const k of opened) void this.loadGroup(k, true);
    }
    if (reset) this.reset(hard);
  }

  /** Clear windows and start over (filters/sorts changed). Keeps rows visible until the first response. */
  reset(hard = false) {
    this.epoch++;
    this.pages.clear();
    this.groupRevs.clear();
    if (hard) {
      this.lastRange = [0, 0];
      this.commit({ loading: true, error: null, ready: false, index: new Map(), groups: null, total: 0, aggs: {} });
    } else this.commit({ loading: true, error: null, ...(this.grouped ? {} : { groups: null }) });
    if (this.grouped) void this.loadGroups();
    else void this.ensureRange(this.lastRange[0], Math.max(this.lastRange[1], 60), true);
  }

  start() {
    if (this.grouped) void this.loadGroups();
    else void this.ensureRange(0, 60);
  }

  private base() {
    const o: { databaseId: Id; viewId?: Id; override?: DbQueryOverride } = { databaseId: this.databaseId };
    if (this.viewId) o.viewId = this.viewId;
    if (Object.keys(this.override).length) o.override = this.override;
    return o;
  }

  // ── flat windows
  async ensureRange(start: number, end: number, replace = false) {
    if (this.grouped) return;
    this.dir = start >= this.lastRange[0] ? 1 : -1;
    this.lastRange = [start, end];
    const first = Math.max(0, Math.floor((start - PAGE) / PAGE));
    let last = Math.floor((end + PAGE) / PAGE);
    if (this.dir > 0) last += 1;
    const wanted: number[] = [];
    for (let p = first; p <= last; p++) {
      if (this.snap.ready && p * PAGE >= this.snap.total) break;
      if (replace || !this.pages.has(p)) wanted.push(p);
    }
    if (!wanted.length) return;
    // batch contiguous pages into ≤200-row windows
    const windows: [number, number][] = [];
    for (const p of wanted) {
      const w = windows[windows.length - 1];
      if (w && w[1] === p - 1 && (w[1] - w[0] + 1) * PAGE < WINDOW) w[1] = p;
      else windows.push([p, p]);
    }
    const epoch = this.epoch;
    for (const p of wanted) this.pages.set(p, { at: Date.now() });
    await Promise.all(windows.map(([a, b]) => this.fetchWindow(a * PAGE, (b - a + 1) * PAGE, epoch)));
  }

  private async fetchWindow(offset: number, limit: number, epoch: number, known?: string) {
    const reqId = this.req.next();
    try {
      const res = await api.db.query({ ...this.base(), window: { offset, limit }, reqId, ...(known ? { knownQueryRev: known } : {}) });
      if (this.disposed || epoch !== this.epoch) return;
      if ('notModified' in res) return;
      this.applyWindow(res, offset);
    } catch (e) {
      if (epoch !== this.epoch) return;
      for (let p = offset / PAGE; p < (offset + limit) / PAGE; p++) this.pages.delete(p);
      this.commit({ loading: false, error: e, ready: true });
    }
  }

  private applyWindow(res: Loaded, offset: number) {
    const index = new Map(this.snap.index);
    const rows = new Map(this.snap.rows);
    // drop index entries past the new total
    if (res.total < this.snap.total) for (const k of [...index.keys()]) if (k >= res.total) index.delete(k);
    res.rows.forEach((r, i) => {
      const prev = index.get(offset + i);
      if (prev && prev !== r.id && ![...index.entries()].some(([k, v]) => v === prev && k !== offset + i)) rows.delete(prev);
      index.set(offset + i, r.id);
      const old = rows.get(r.id);
      // keep object identity for unchanged rows so memoised rows don't re-render
      if (!this.pending.has(r.id) && !(old && old.rev === r.rev && old.updatedAt === r.updatedAt && JSON.stringify(old.values) === JSON.stringify(r.values))) rows.set(r.id, r);
    });
    for (let p = offset / PAGE; p < (offset + res.rows.length) / PAGE; p++) this.pages.set(p, { rev: res.queryRev, at: Date.now() });
    this.evict(index, rows);
    this.commit({ index, rows, total: res.total, aggs: res.aggs, loading: false, ready: true, error: null, tookMs: res.tookMs });
  }

  private evict(index: Map<number, Id>, rows: Map<Id, RowDTO>) {
    if (rows.size <= LRU_MAX) return;
    const [lo, hi] = this.lastRange;
    const mid = (lo + hi) / 2;
    const far = [...index.entries()].sort((a, b) => Math.abs(b[0] - mid) - Math.abs(a[0] - mid));
    for (const [k, id] of far) {
      if (rows.size <= LRU_MAX * 0.8) break;
      if (k >= lo - WINDOW && k <= hi + WINDOW) continue;
      index.delete(k);
      rows.delete(id);
      this.pages.delete(Math.floor(k / PAGE));
    }
  }

  // ── groups
  private async loadGroups() {
    const epoch = this.epoch;
    const reqId = this.req.next();
    try {
      const res = await api.db.query({ ...this.base(), window: { offset: 0, limit: 0 }, reqId });
      if (this.disposed || epoch !== this.epoch || 'notModified' in res) return;
      const prev = new Map((this.snap.groups ?? []).map((g) => [g.key, g] as const));
      const groups: GroupState[] = (res.groups ?? []).map((g) => {
        const p = prev.get(g.key);
        return { ...g, ids: p?.ids ?? [], loaded: false, loading: false };
      });
      this.commit({ groups, total: res.total, aggs: res.aggs, ready: true, loading: false, error: null, tookMs: res.tookMs });
      await Promise.all(groups.filter((g) => !this.collapsed.has(g.key)).map((g) => this.loadGroup(g.key, true, Math.max(GROUP_PAGE, prev.get(g.key)?.ids.length ?? 0))));
    } catch (e) {
      if (epoch === this.epoch) this.commit({ loading: false, error: e, ready: true });
    }
  }

  async loadGroup(key: string, replace = false, limit = GROUP_PAGE) {
    const g = this.snap.groups?.find((x) => x.key === key);
    if (!g || g.loading) return;
    const offset = replace ? 0 : g.ids.length;
    if (!replace && offset >= g.count) return;
    const epoch = this.epoch;
    this.patchGroup(key, { loading: true });
    const reqId = this.req.next();
    try {
      const res = await api.db.query({ ...this.base(), window: { offset, limit: Math.min(500, limit) }, group: key, reqId });
      if (this.disposed || epoch !== this.epoch || 'notModified' in res) return;
      const rows = new Map(this.snap.rows);
      for (const r of res.rows) if (!this.pending.has(r.id)) rows.set(r.id, r);
      const ids = replace ? res.rows.map((r) => r.id) : [...g.ids, ...res.rows.map((r) => r.id)];
      this.groupRevs.set(key, res.queryRev);
      this.snap = { ...this.snap, rows };
      this.patchGroup(key, { ids, loaded: true, loading: false, count: res.total });
    } catch (e) {
      this.patchGroup(key, { loading: false });
      notify.fromError(e, "Couldn't load rows");
    }
  }

  private patchGroup(key: string, patch: Partial<GroupState>) {
    if (!this.snap.groups) return;
    this.commit({ groups: this.snap.groups.map((g) => (g.key === key ? { ...g, ...patch } : g)) });
  }

  // ── refresh
  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 40);
  }

  async refresh() {
    if (this.disposed) return;
    if (this.grouped) return this.loadGroups();
    const epoch = this.epoch;
    const pages = [...this.pages.keys()].sort((a, b) => a - b);
    const [lo, hi] = this.lastRange;
    const near = pages.filter((p) => p * PAGE <= hi + WINDOW && (p + 1) * PAGE >= lo - WINDOW);
    // pages far from view are dropped and refetched on demand
    for (const p of pages) if (!near.includes(p)) this.pages.delete(p);
    const list = near.length ? near : [0];
    await Promise.all(list.map((p) => this.fetchWindow(p * PAGE, PAGE, epoch, this.pages.get(p)?.rev)));
  }

  // ── accessors
  hasSearch(): boolean {
    return !!this.override.search;
  }

  rowAt(i: number): RowDTO | undefined {
    const id = this.snap.index.get(i);
    return id ? this.snap.rows.get(id) : undefined;
  }

  /** All loaded row ids in order (flat) or group order (grouped). */
  orderedIds(): Id[] {
    if (this.snap.groups) return this.snap.groups.flatMap((g) => (this.collapsed.has(g.key) ? [] : g.ids));
    return [...this.snap.index.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
  }

  // ── mutations
  /** Optimistic cell edit with undo (§13.4). */
  async updateCells(rowId: Id, values: Record<Id, CellValue | null>, opts: { label?: string; undo?: boolean } = {}) {
    const before = this.snap.rows.get(rowId);
    const prevValues: Record<Id, CellValue | null> = {};
    for (const k of Object.keys(values)) prevValues[k] = before?.values[k] ?? null;
    const apply = async (vals: Record<Id, CellValue | null>) => {
      const cur = this.snap.rows.get(rowId);
      if (cur) {
        const nextVals = { ...cur.values };
        for (const [k, v] of Object.entries(vals)) {
          if (v === null) delete nextVals[k];
          else nextVals[k] = v;
        }
        const rows = new Map(this.snap.rows);
        rows.set(rowId, { ...cur, values: nextVals, updatedAt: Date.now() });
        this.commit({ rows });
      }
      this.pending.set(rowId, (this.pending.get(rowId) ?? 0) + 1);
      try {
        const [res] = await api.db.rowsUpdate({ updates: [{ id: rowId, values: vals }] });
        if (res) {
          const rows = new Map(this.snap.rows);
          rows.set(rowId, res);
          this.commit({ rows });
        }
      } catch (e) {
        if (before) {
          const rows = new Map(this.snap.rows);
          rows.set(rowId, before);
          this.commit({ rows });
        }
        throw e;
      } finally {
        const n = (this.pending.get(rowId) ?? 1) - 1;
        if (n <= 0) this.pending.delete(rowId);
        else this.pending.set(rowId, n);
      }
    };
    try {
      if (opts.undo === false) await apply(values);
      else
        await undoable({
          label: opts.label ?? 'Edit',
          do: () => apply(values),
          undo: () => apply(prevValues),
        });
    } catch (e) {
      notify.fromError(e, "Couldn't save that change");
    }
  }

  /** Local-only patch (e.g. while dragging). */
  patchRowLocal(rowId: Id, values: Record<Id, CellValue | null>) {
    const cur = this.snap.rows.get(rowId);
    if (!cur) return;
    const nextVals = { ...cur.values };
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete nextVals[k];
      else nextVals[k] = v;
    }
    const rows = new Map(this.snap.rows);
    rows.set(rowId, { ...cur, values: nextVals });
    this.commit({ rows });
  }

  async createRow(input: { values?: Record<Id, CellValue>; afterId?: Id; templateId?: Id; group?: string } = {}): Promise<RowDTO | null> {
    try {
      const row = await api.db.rowCreate({ databaseId: this.databaseId, ...(this.viewId ? { viewId: this.viewId } : {}), ...(input.values ? { values: input.values } : {}), ...(input.afterId ? { afterId: input.afterId } : {}), ...(input.templateId ? { templateId: input.templateId } : {}) });
      const rows = new Map(this.snap.rows);
      rows.set(row.id, row);
      const groups = this.snap.groups;
      if (groups && input.group !== undefined) {
        this.snap = { ...this.snap, rows };
        this.commit({ groups: groups.map((g) => (g.key === input.group ? { ...g, ids: [...g.ids, row.id], count: g.count + 1 } : g)) });
      } else if (!this.snap.groups) {
        const index = new Map(this.snap.index);
        const at = input.afterId ? [...index.entries()].find(([, id]) => id === input.afterId)?.[0] : undefined;
        if (at === undefined) index.set(this.snap.total, row.id);
        else {
          const shifted = new Map<number, Id>();
          for (const [k, id] of index) shifted.set(k > at ? k + 1 : k, id);
          shifted.set(at + 1, row.id);
          index.clear();
          for (const [k, v] of shifted) index.set(k, v);
        }
        this.commit({ rows, index, total: this.snap.total + 1 });
      } else this.commit({ rows });
      useUndoPushCreate(this.databaseId, row.id);
      return row;
    } catch (e) {
      notify.fromError(e, "Couldn't add a row");
      return null;
    }
  }

  async deleteRows(ids: Id[]) {
    if (!ids.length) return;
    const set = new Set(ids);
    const before = this.snap;
    // optimistic removal
    if (this.snap.groups) this.commit({ groups: this.snap.groups.map((g) => ({ ...g, ids: g.ids.filter((id) => !set.has(id)), count: g.count - g.ids.filter((id) => set.has(id)).length })) });
    else {
      const kept = this.orderedIds().filter((id) => !set.has(id));
      const index = new Map<number, Id>();
      kept.forEach((id, i) => index.set(i, id));
      this.commit({ index, total: Math.max(0, this.snap.total - ids.length) });
    }
    try {
      await undoable(
        {
          label: ids.length === 1 ? 'Delete row' : `Delete ${ids.length} rows`,
          do: () => api.db.rowsDelete({ ids }),
          undo: () => api.db.rowsRestore({ ids }),
        },
        { toast: ids.length === 1 ? 'Row deleted' : `${ids.length} rows deleted` },
      );
    } catch (e) {
      this.snap = before;
      this.commit({});
      notify.fromError(e, "Couldn't delete");
    }
  }

  async duplicateRows(ids: Id[]) {
    try {
      const rows = await api.db.rowsDuplicate({ ids });
      notify.success(rows.length === 1 ? 'Row duplicated' : `${rows.length} rows duplicated`);
    } catch (e) {
      notify.fromError(e, "Couldn't duplicate");
    }
  }

  /**
   * Board move: optimistic re-parenting between groups + manual position. `groupValue` sets the grouped property.
   */
  async moveCard(rowId: Id, from: string, to: string, index: number, groupValue?: { prop: Id; value: CellValue }) {
    const groups = this.snap.groups;
    if (!groups) return;
    const target = groups.find((g) => g.key === to);
    if (!target) return;
    const without = target.ids.filter((id) => id !== rowId);
    const clamped = Math.max(0, Math.min(index, without.length));
    const beforeId = without[clamped];
    const afterId = clamped > 0 ? without[clamped - 1] : undefined;
    const next = groups.map((g) => {
      if (g.key === to) {
        const ids = [...without];
        ids.splice(clamped, 0, rowId);
        return { ...g, ids, count: g.key === from ? g.count : g.count + 1 };
      }
      if (g.key === from) return { ...g, ids: g.ids.filter((id) => id !== rowId), count: g.count - 1 };
      return g;
    });
    const prevGroups = groups;
    const prevRow = this.snap.rows.get(rowId);
    if (groupValue && from !== to) this.patchRowLocal(rowId, { [groupValue.prop]: groupValue.value });
    this.commit({ groups: next });
    this.pending.set(rowId, (this.pending.get(rowId) ?? 0) + 1);
    try {
      const req: { ids: Id[]; beforeId?: Id; afterId?: Id; groupValue?: { prop: Id; value: CellValue } } = { ids: [rowId] };
      if (beforeId) req.beforeId = beforeId;
      else if (afterId) req.afterId = afterId;
      if (groupValue && from !== to) req.groupValue = groupValue;
      const [res] = await api.db.rowsMove(req);
      if (res) {
        const rows = new Map(this.snap.rows);
        rows.set(rowId, res);
        this.commit({ rows });
      }
    } catch (e) {
      const rows = new Map(this.snap.rows);
      if (prevRow) rows.set(rowId, prevRow);
      this.commit({ groups: prevGroups, rows });
      notify.fromError(e, "Couldn't move the card");
    } finally {
      const n = (this.pending.get(rowId) ?? 1) - 1;
      if (n <= 0) this.pending.delete(rowId);
      else this.pending.set(rowId, n);
    }
  }

  /** Manual reorder in flat mode (table drag handle). */
  async moveRow(rowId: Id, toIndex: number) {
    const ids = this.orderedIds();
    const from = ids.indexOf(rowId);
    if (from < 0) return;
    const rest = ids.filter((id) => id !== rowId);
    const at = Math.max(0, Math.min(toIndex, rest.length));
    rest.splice(at, 0, rowId);
    const index = new Map<number, Id>();
    rest.forEach((id, i) => index.set(i, id));
    const prev = this.snap.index;
    this.commit({ index });
    try {
      const beforeId = rest[at + 1];
      const afterId = rest[at - 1];
      await api.db.rowsMove(beforeId ? { ids: [rowId], beforeId } : afterId ? { ids: [rowId], afterId } : { ids: [rowId] });
    } catch (e) {
      this.commit({ index: prev });
      notify.fromError(e, "Couldn't move the row");
    }
  }
}

function useUndoPushCreate(_dbId: Id, rowId: Id) {
  useUndo.getState().push({
    label: 'New row',
    do: () => api.db.rowsRestore({ ids: [rowId] }),
    undo: () => api.db.rowsDelete({ ids: [rowId] }),
  });
}

export function useController(c: ViewController): ControllerSnapshot {
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}
