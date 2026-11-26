/**
 * Database schemas on the client: one cached `DbSchema` per database, refreshed on `db:changed` when the schema rev
 * moves, with optimistic view/property edits (rolled back with a toast on error). Also caches relation titles.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { api, listen } from '@/backend';
import type { DbSchema, Icon, Id, Property, View } from '@/backend/types';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';

interface SchemaState {
  schemas: Record<Id, DbSchema>;
  errors: Record<Id, unknown>;
  load(id: Id, force?: boolean): Promise<DbSchema | null>;
  set(schema: DbSchema): void;
  patchView(dbId: Id, viewId: Id, patch: Partial<View>): Promise<void>;
  patchProp(dbId: Id, propId: Id, patch: Partial<Property>): void;
}

const inflight = new Map<Id, Promise<DbSchema | null>>();

export const useSchemas = create<SchemaState>()((set, get) => ({
  schemas: {},
  errors: {},
  load(id, force) {
    if (!force && get().schemas[id]) return Promise.resolve(get().schemas[id]);
    let p = inflight.get(id);
    if (p && !force) return p;
    p = api.db
      .getSchema({ id })
      .then((s) => {
        set((st) => ({ schemas: { ...st.schemas, [id]: s }, errors: { ...st.errors, [id]: undefined } }));
        return s;
      })
      .catch((e) => {
        set((st) => ({ errors: { ...st.errors, [id]: e } }));
        return null;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  },
  set(schema) {
    set((st) => ({ schemas: { ...st.schemas, [schema.database.id]: schema } }));
  },
  async patchView(dbId, viewId, patch) {
    const before = get().schemas[dbId];
    if (!before) return;
    const optimistic: DbSchema = { ...before, views: before.views.map((v) => (v.id === viewId ? { ...v, ...patch } : v)) };
    // `undefined` in a patch clears the key
    for (const v of optimistic.views) if (v.id === viewId) for (const [k, val] of Object.entries(patch)) if (val === undefined) delete (v as unknown as Record<string, unknown>)[k];
    get().set(optimistic);
    try {
      const wire = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v])) as Partial<View>;
      const view = await api.db.viewUpdate({ id: viewId, patch: wire });
      const cur = get().schemas[dbId];
      if (cur) get().set({ ...cur, views: cur.views.map((v) => (v.id === viewId ? view : v)) });
    } catch (e) {
      get().set(before);
      notify.fromError(e, "Couldn't update the view");
    }
  },
  patchProp(dbId, propId, patch) {
    const cur = get().schemas[dbId];
    if (!cur) return;
    get().set({ ...cur, properties: cur.properties.map((p) => (p.id === propId ? { ...p, ...patch } : p)) });
  },
}));

let listening = false;
function ensureListening() {
  if (listening) return;
  listening = true;
  listen('db:changed', (e) => {
    const cur = useSchemas.getState().schemas[e.databaseId];
    if (cur && cur.database.schemaRev < e.schemaRev) void useSchemas.getState().load(e.databaseId, true);
    relationCache.invalidateDb(e.databaseId);
  });
}

export function useSchema(id: Id | null | undefined): { schema: DbSchema | null; error: unknown } {
  const schema = useSchemas((s) => (id ? (s.schemas[id] ?? null) : null));
  const error = useSchemas((s) => (id ? s.errors[id] : undefined));
  useEffect(() => {
    ensureListening();
    if (id) void useSchemas.getState().load(id);
  }, [id]);
  return { schema, error };
}

export function reloadSchema(id: Id): Promise<DbSchema | null> {
  return useSchemas.getState().load(id, true);
}

/** Title of a database (tree store first, then schema). */
export function useDbTitle(id: Id): { title: string; icon?: Icon } {
  const meta = useTree((s) => s.byId.get(id));
  const schema = useSchemas((s) => s.schemas[id]);
  return { title: meta?.title ?? schema?.database.title ?? '', icon: meta?.icon ?? schema?.database.icon };
}

// ───────────────────────────────────────────────────────────────────────────── relation titles

type Listener = () => void;

class RelationTitles {
  private byProp = new Map<Id, { targetDb: Id; map: Map<Id, { title: string; icon?: Icon }>; loading?: Promise<void> }>();
  private listeners = new Set<Listener>();
  version = 0;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  ensure(prop: Property): void {
    if (prop.type !== 'relation') return;
    const targetDb = String(prop.config.targetDatabaseId ?? '');
    const cur = this.byProp.get(prop.id);
    if (cur && cur.targetDb === targetDb) return;
    const entry = { targetDb, map: new Map<Id, { title: string; icon?: Icon }>(), loading: undefined as Promise<void> | undefined };
    this.byProp.set(prop.id, entry);
    entry.loading = api.db
      .relationOptions({ propertyId: prop.id, search: '', limit: 1000 })
      .then((list) => {
        for (const o of list) entry.map.set(o.id, { title: o.title, icon: o.icon });
        this.emit();
      })
      .catch(() => undefined);
  }

  title(propId: Id, rowId: Id): { title: string; icon?: Icon } | undefined {
    return this.byProp.get(propId)?.map.get(rowId);
  }

  remember(propId: Id, rowId: Id, title: string, icon?: Icon) {
    const e = this.byProp.get(propId);
    if (e) {
      e.map.set(rowId, { title, icon });
      this.emit();
    }
  }

  invalidateDb(dbId: Id) {
    let hit = false;
    for (const [k, v] of this.byProp) {
      if (v.targetDb === dbId) {
        this.byProp.delete(k);
        hit = true;
      }
    }
    if (hit) this.emit();
  }
}

export const relationCache = new RelationTitles();

// ───────────────────────────────────────────────────────────────────────────── peek context

/** Row order of the view that opened the side peek (↑/↓ in the peek header follow it). */
let peekOrder: { databaseId: Id; ids: Id[] } | null = null;
export function setPeekOrder(databaseId: Id, ids: Id[]): void {
  peekOrder = { databaseId, ids };
}
export function peekNeighbours(rowId: Id): { prev?: Id; next?: Id } | null {
  if (!peekOrder) return null;
  const i = peekOrder.ids.indexOf(rowId);
  if (i < 0) return null;
  return { prev: peekOrder.ids[i - 1], next: peekOrder.ids[i + 1] };
}
