/**
 * Page tree (§13.1): `byId`, `children` (sorted by sort key), `expanded` (persisted to kv `ui.tree`/`expanded`) and a
 * memoised flat list of visible rows for the virtualised sidebar. Updated optimistically from commands and
 * authoritatively from `tree:changed`.
 */
import { create } from 'zustand';
import { api } from '@/backend';
import type { Icon, Id, PageMeta, PageMetaPatch } from '@/backend/types';
import { generateKeyBetween } from '@/lib/fractional-index';
import { notify } from './toasts';
import { undoable } from './undo';

export interface TreeRow {
  id: Id;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  meta: PageMeta;
}

interface TreeState {
  workspaceId: Id | null;
  byId: Map<Id, PageMeta>;
  children: Map<Id | null, Id[]>;
  expanded: Set<Id>;
  /** Bumped on every structural change (cheap equality for memoised selectors). */
  version: number;

  load(workspaceId: Id, pages: PageMeta[]): void;
  /** Apply metas from a command result or `tree:changed`. */
  upsert(metas: PageMeta[]): void;
  remove(ids: Id[]): void;
  applyChange(change: { workspaceId: Id; upserted: PageMeta[]; removed: Id[] }): void;
  reset(): void;

  toggle(id: Id): void;
  setExpanded(id: Id, open: boolean): void;
  /** Expand every ancestor so `id` is visible. */
  reveal(id: Id): void;
  loadExpanded(): Promise<void>;

  createPage(opts: { parentId: Id | null; afterId?: Id; title?: string; icon?: Icon; kind?: 'doc' | 'dashboard' }): Promise<PageMeta>;
  updateMeta(id: Id, patch: PageMetaPatch): Promise<void>;
  rename(id: Id, title: string): Promise<void>;
  /** Optimistic move with cycle check; undoable. */
  move(id: Id, parentId: Id | null, pos?: { beforeId?: Id; afterId?: Id }): Promise<void>;
  /** Move to Trash with a "· Undo" toast. */
  trash(ids: Id[]): Promise<void>;
  duplicate(id: Id, deep?: boolean): Promise<PageMeta | null>;
}

const byKey = (a: PageMeta, b: PageMeta) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);

function buildChildren(byId: Map<Id, PageMeta>): Map<Id | null, Id[]> {
  const groups = new Map<Id | null, PageMeta[]>();
  for (const p of byId.values()) {
    const key = p.parentId;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(p);
  }
  const out = new Map<Id | null, Id[]>();
  for (const [k, list] of groups) out.set(k, list.sort(byKey).map((p) => p.id));
  return out;
}

function withHasChildren(byId: Map<Id, PageMeta>, children: Map<Id | null, Id[]>): Map<Id, PageMeta> {
  let changed = false;
  const next = new Map(byId);
  for (const [id, meta] of byId) {
    const has = (children.get(id)?.length ?? 0) > 0;
    if (meta.hasChildren !== has) {
      next.set(id, { ...meta, hasChildren: has });
      changed = true;
    }
  }
  return changed ? next : byId;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistExpanded(expanded: Set<Id>) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    api.kv.set({ ns: 'ui.tree', key: 'expanded', value: Array.from(expanded).slice(0, 2000) }).catch(() => undefined);
  }, 400);
}

export const useTree = create<TreeState>()((set, get) => {
  const commit = (byId: Map<Id, PageMeta>) => {
    const children = buildChildren(byId);
    const fixed = withHasChildren(byId, children);
    set((s) => ({ byId: fixed, children, version: s.version + 1 }));
  };

  return {
    workspaceId: null,
    byId: new Map(),
    children: new Map(),
    expanded: new Set(),
    version: 0,

    load(workspaceId, pages) {
      const byId = new Map<Id, PageMeta>();
      for (const p of pages) if (!p.deletedAt) byId.set(p.id, p);
      set({ workspaceId });
      commit(byId);
    },

    upsert(metas) {
      if (!metas.length) return;
      const byId = new Map(get().byId);
      let changed = false;
      for (const m of metas) {
        const cur = byId.get(m.id);
        if (m.deletedAt) {
          if (byId.delete(m.id)) changed = true;
          continue;
        }
        if (cur && cur.rev > m.rev && cur.updatedAt >= m.updatedAt) continue; // stale
        byId.set(m.id, m);
        changed = true;
      }
      if (changed) commit(byId);
    },

    remove(ids) {
      if (!ids.length) return;
      const byId = new Map(get().byId);
      let changed = false;
      for (const id of ids) if (byId.delete(id)) changed = true;
      if (changed) commit(byId);
    },

    applyChange(change) {
      const ws = get().workspaceId;
      if (ws && change.workspaceId !== ws) return;
      const byId = new Map(get().byId);
      for (const id of change.removed) byId.delete(id);
      for (const m of change.upserted) {
        if (m.deletedAt) byId.delete(m.id);
        else byId.set(m.id, m);
      }
      commit(byId);
    },

    reset: () => set({ workspaceId: null, byId: new Map(), children: new Map(), expanded: new Set(), version: 0 }),

    toggle(id) {
      get().setExpanded(id, !get().expanded.has(id));
    },
    setExpanded(id, open) {
      const cur = get().expanded;
      if (cur.has(id) === open) return;
      const next = new Set(cur);
      if (open) next.add(id);
      else next.delete(id);
      set((s) => ({ expanded: next, version: s.version + 1 }));
      persistExpanded(next);
    },
    reveal(id) {
      const { byId, expanded } = get();
      const next = new Set(expanded);
      let cur = byId.get(id);
      const seen = new Set<Id>();
      while (cur?.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        next.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
      if (next.size !== expanded.size) {
        set((s) => ({ expanded: next, version: s.version + 1 }));
        persistExpanded(next);
      }
    },
    async loadExpanded() {
      try {
        const v = await api.kv.get({ ns: 'ui.tree', key: 'expanded' });
        if (Array.isArray(v)) set((s) => ({ expanded: new Set(v.filter((x): x is string => typeof x === 'string')), version: s.version + 1 }));
      } catch {
        /* first run */
      }
    },

    async createPage({ parentId, afterId, title, icon, kind = 'doc' }) {
      const workspaceId = get().workspaceId;
      if (!workspaceId) throw new Error('No workspace open');
      const { meta } = await api.page.create({ workspaceId, parentId, kind, title, icon, afterId });
      get().upsert([meta]);
      if (parentId) get().setExpanded(parentId, true);
      return meta;
    },

    async updateMeta(id, patch) {
      const prev = get().byId.get(id);
      if (!prev) return;
      const optimistic: PageMeta = { ...prev };
      if (patch.title !== undefined) optimistic.title = patch.title;
      if ('icon' in patch) {
        if (patch.icon) optimistic.icon = patch.icon;
        else delete optimistic.icon;
      }
      if ('cover' in patch) {
        if (patch.cover) optimistic.cover = patch.cover;
        else delete optimistic.cover;
      }
      if (patch.flags) optimistic.flags = { ...prev.flags, ...patch.flags };
      get().upsert([{ ...optimistic, rev: prev.rev + 1 }]);
      try {
        const saved = await api.page.updateMeta({ id, patch });
        get().upsert([saved]);
      } catch (e) {
        get().upsert([prev]);
        notify.fromError(e, "Couldn't update the page");
      }
    },

    rename: (id, title) => get().updateMeta(id, { title }),

    async move(id, parentId, pos = {}) {
      const { byId, children } = get();
      const meta = byId.get(id);
      if (!meta) return;
      // Cycle check (Rust checks too).
      for (let cur: Id | null = parentId; cur; cur = byId.get(cur)?.parentId ?? null) {
        if (cur === id) {
          notify.warning("A page can't be moved inside itself");
          return;
        }
      }
      const prevParent = meta.parentId;
      const prevSibs = children.get(prevParent) ?? [];
      const prevIndex = prevSibs.indexOf(id);
      const prevAfter = prevIndex > 0 ? prevSibs[prevIndex - 1] : undefined;
      const prevBefore = prevIndex >= 0 ? prevSibs[prevIndex + 1] : undefined;

      const sibs = (children.get(parentId) ?? []).filter((s) => s !== id);
      let lo: string | null = null;
      let hi: string | null = null;
      if (pos.afterId && sibs.includes(pos.afterId)) {
        const i = sibs.indexOf(pos.afterId);
        lo = byId.get(sibs[i])?.sortKey ?? null;
        hi = sibs[i + 1] ? byId.get(sibs[i + 1])?.sortKey ?? null : null;
      } else if (pos.beforeId && sibs.includes(pos.beforeId)) {
        const i = sibs.indexOf(pos.beforeId);
        hi = byId.get(sibs[i])?.sortKey ?? null;
        lo = i > 0 ? byId.get(sibs[i - 1])?.sortKey ?? null : null;
      } else {
        lo = sibs.length ? byId.get(sibs[sibs.length - 1])?.sortKey ?? null : null;
      }
      let sortKey = meta.sortKey;
      try {
        sortKey = generateKeyBetween(lo, hi);
      } catch {
        /* server decides */
      }

      const doMove = async (to: Id | null, p: { beforeId?: Id; afterId?: Id }, optimisticKey?: string) => {
        const before = get().byId.get(id);
        if (before && optimisticKey) get().upsert([{ ...before, parentId: to, sortKey: optimisticKey, rev: before.rev + 1 }]);
        try {
          const saved = await api.page.move({ id, parentId: to, ...p });
          get().upsert([saved]);
          if (to) get().setExpanded(to, true);
        } catch (e) {
          if (before) get().upsert([before]);
          throw e;
        }
      };

      try {
        await undoable({
          label: 'Move page',
          do: () => doMove(parentId, pos, sortKey),
          undo: () =>
            doMove(prevParent, prevAfter ? { afterId: prevAfter } : prevBefore ? { beforeId: prevBefore } : {}),
        });
      } catch (e) {
        notify.fromError(e, "Couldn't move the page");
      }
    },

    async trash(ids) {
      if (!ids.length) return;
      const { byId } = get();
      const titles = ids.map((id) => byId.get(id)?.title || 'Untitled');
      // Optimistically hide the pages and their subtrees.
      const hidden = new Set<Id>();
      const stack = [...ids];
      while (stack.length) {
        const cur = stack.pop() as Id;
        hidden.add(cur);
        for (const c of get().children.get(cur) ?? []) stack.push(c);
      }
      const snapshot = Array.from(hidden)
        .map((id) => byId.get(id))
        .filter((m): m is PageMeta => !!m);
      get().remove(Array.from(hidden));
      try {
        await undoable(
          {
            label: 'Delete page',
            do: () => api.page.delete({ ids }),
            undo: async () => {
              const restored = await api.page.restore({ ids });
              get().upsert([...snapshot.filter((m) => !ids.includes(m.id)), ...restored]);
            },
          },
          { toast: ids.length === 1 ? `Moved “${titles[0]}” to Trash` : `Moved ${ids.length} pages to Trash` },
        );
      } catch (e) {
        get().upsert(snapshot);
        notify.fromError(e, "Couldn't delete the page");
      }
    },

    async duplicate(id, deep = true) {
      try {
        const job = await api.page.duplicate({ id, deep });
        const meta = await job.result;
        get().upsert([meta]);
        return meta;
      } catch (e) {
        notify.fromError(e, "Couldn't duplicate the page");
        return null;
      }
    },
  };
});

// ───────────────────────────────────────────────────────────────────────────── selectors

/** Pages that belong in the sidebar's Pages section (templates live under Templates). */
export function isTreeVisible(meta: PageMeta): boolean {
  return !meta.flags.template && !meta.deletedAt;
}

export const MAX_INDENT_LEVELS = 8;

const rowCache = new Map<string, { version: number; rows: TreeRow[] }>();

/**
 * The flattened visible rows under `rootId` (null = workspace root), honouring `expanded`. Memoised per
 * (root, filter key, version), so components can call it inside a selector without re-rendering on unrelated changes.
 */
export function selectVisibleRows(
  s: Pick<TreeState, 'byId' | 'children' | 'expanded' | 'version'>,
  rootId: Id | null = null,
  filter: (meta: PageMeta) => boolean = isTreeVisible,
  filterKey = 'default',
): TreeRow[] {
  const key = `${rootId ?? ''}|${filterKey}`;
  const hit = rowCache.get(key);
  if (hit && hit.version === s.version) return hit.rows;
  const rows: TreeRow[] = [];
  const walk = (parent: Id | null, depth: number) => {
    for (const id of s.children.get(parent) ?? []) {
      const meta = s.byId.get(id);
      if (!meta || !filter(meta)) continue;
      const kids = (s.children.get(id) ?? []).filter((c) => {
        const m = s.byId.get(c);
        return !!m && filter(m);
      });
      const expanded = s.expanded.has(id);
      rows.push({ id, depth, hasChildren: kids.length > 0, expanded, meta });
      if (expanded && kids.length) walk(id, depth + 1);
    }
  };
  walk(rootId, 0);
  rowCache.set(key, { version: s.version, rows });
  return rows;
}

export function selectChildren(s: Pick<TreeState, 'byId' | 'children'>, parentId: Id | null): PageMeta[] {
  return (s.children.get(parentId) ?? []).map((id) => s.byId.get(id)).filter((m): m is PageMeta => !!m);
}

export function selectAncestors(s: Pick<TreeState, 'byId'>, id: Id): PageMeta[] {
  const out: PageMeta[] = [];
  const seen = new Set<Id>();
  let cur = s.byId.get(id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const p = s.byId.get(cur.parentId);
    if (!p) break;
    out.unshift(p);
    cur = p;
  }
  return out;
}

export function selectPathTitles(s: Pick<TreeState, 'byId'>, id: Id): string[] {
  return selectAncestors(s, id).map((p) => p.title || 'Untitled');
}
