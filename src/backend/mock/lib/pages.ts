/** Page tree service: records, sort keys, moves with cycle checks, trash/restore/purge, tree events. */
import { BackendError } from '../../errors';
import type { Id, PageMeta } from '../../types';
import type { CreatePageInput, MockCtx, PageRecord, PagesService } from '../ctx';

export const TITLE_MAX = 1024;

export function createPagesService(ctx: MockCtx): PagesService {
  const table = () => ctx.db.table<PageRecord>('pages');

  // child-count cache, invalidated by db.version
  let countsVersion = -1;
  let counts = new Map<Id | null, number>();
  const childCounts = () => {
    if (countsVersion !== ctx.db.version) {
      counts = new Map();
      for (const p of table().values()) {
        if (p.deletedAt) continue;
        counts.set(p.parentId, (counts.get(p.parentId) ?? 0) + 1);
      }
      countsVersion = ctx.db.version;
    }
    return counts;
  };

  const toMeta = (rec: PageRecord): PageMeta => {
    const meta: PageMeta = {
      id: rec.id,
      workspaceId: rec.workspaceId,
      parentId: rec.parentId,
      kind: rec.kind,
      sortKey: rec.sortKey,
      title: rec.title,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      rev: rec.rev,
      flags: { ...rec.flags },
      hasChildren: (childCounts().get(rec.id) ?? 0) > 0,
    };
    if (rec.icon) meta.icon = rec.icon;
    if (rec.cover) meta.cover = rec.cover;
    if (rec.deletedAt) meta.deletedAt = rec.deletedAt;
    if (rec.appInstanceId) meta.appInstanceId = rec.appInstanceId;
    return meta;
  };

  const get = (id: Id) => table().get(id);

  const require = (id: Id): PageRecord => {
    const rec = table().get(id);
    if (!rec || rec.deletedAt) throw new BackendError('NOT_FOUND', 'Page not found');
    return rec;
  };

  const children = (parentId: Id | null, workspaceId?: Id): PageRecord[] => {
    const ws = workspaceId ?? (parentId ? get(parentId)?.workspaceId : undefined);
    return table()
      .filter((p) => !p.deletedAt && p.parentId === parentId && (ws === undefined || p.workspaceId === ws))
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1));
  };

  const ancestors = (id: Id): PageRecord[] => {
    const out: PageRecord[] = [];
    const seen = new Set<Id>();
    let cur = get(id);
    while (cur && cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const parent = get(cur.parentId);
      if (!parent) break;
      out.unshift(parent);
      cur = parent;
    }
    return out;
  };

  const descendantsAll = (id: Id, includeDeleted: boolean): PageRecord[] => {
    const byParent = new Map<Id, PageRecord[]>();
    for (const p of table().values()) {
      if (!includeDeleted && p.deletedAt) continue;
      if (!p.parentId) continue;
      let list = byParent.get(p.parentId);
      if (!list) byParent.set(p.parentId, (list = []));
      list.push(p);
    }
    const out: PageRecord[] = [];
    const stack = [...(byParent.get(id) ?? [])].reverse();
    while (stack.length) {
      const p = stack.pop() as PageRecord;
      out.push(p);
      const kids = byParent.get(p.id);
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  };

  const sortKeyFor: PagesService['sortKeyFor'] = (parentId, workspaceId, opts = {}) => {
    const sibs = children(parentId, workspaceId).filter((p) => p.id !== opts.excludeId);
    if (opts.afterId) {
      const i = sibs.findIndex((s) => s.id === opts.afterId);
      if (i >= 0) return ctx.keyBetween(sibs[i].sortKey, sibs[i + 1]?.sortKey ?? null);
    }
    if (opts.beforeId) {
      const i = sibs.findIndex((s) => s.id === opts.beforeId);
      if (i >= 0) return ctx.keyBetween(sibs[i - 1]?.sortKey ?? null, sibs[i].sortKey);
    }
    return ctx.keyBetween(sibs[sibs.length - 1]?.sortKey ?? null, null);
  };

  const emitTree: PagesService['emitTree'] = (workspaceId, upserted, removed = []) => {
    const ids = new Set(upserted);
    const metas: PageMeta[] = [];
    for (const id of ids) {
      const rec = get(id);
      if (rec && !rec.deletedAt) metas.push(toMeta(rec));
    }
    ctx.emit('tree:changed', { workspaceId, upserted: metas, removed });
  };

  const validateTitle = (title: string | undefined) => {
    if (title !== undefined && title.length > TITLE_MAX) {
      throw new BackendError('INVALID', 'Title is too long', { field: 'title' });
    }
  };

  const create: PagesService['create'] = (input: CreatePageInput) => {
    validateTitle(input.title);
    const workspaceId = input.workspaceId ?? ctx.workspaceId();
    if (input.parentId) {
      const parent = require(input.parentId);
      if (parent.workspaceId !== workspaceId) throw new BackendError('INVALID', 'Parent is in another workspace');
    }
    const now = ctx.clock.now();
    const rec: PageRecord = {
      id: ctx.id(),
      workspaceId,
      parentId: input.parentId,
      kind: input.kind,
      sortKey: sortKeyFor(input.parentId, workspaceId, { afterId: input.afterId, beforeId: input.beforeId }),
      title: input.title ?? '',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
      rev: 1,
      flags: { ...(input.flags ?? {}) },
    };
    if (input.icon) rec.icon = input.icon;
    if (input.cover) rec.cover = input.cover;
    if (input.appInstanceId) rec.appInstanceId = input.appInstanceId;
    if (input.templateKey) rec.templateKey = input.templateKey;
    table().insert(rec);
    if (input.doc) ctx.docs.save(rec.id, 'page', input.doc);
    if (!input.silent) emitTree(workspaceId, input.parentId ? [rec.id, input.parentId] : [rec.id]);
    return rec;
  };

  const update: PagesService['update'] = (id, patch) => {
    validateTitle(patch.title);
    const rec = require(id);
    table().update(id, (r) => {
      if (patch.title !== undefined) r.title = patch.title;
      if ('icon' in patch) {
        if (patch.icon) r.icon = patch.icon;
        else delete r.icon;
      }
      if ('cover' in patch) {
        if (patch.cover) r.cover = patch.cover;
        else delete r.cover;
      }
      if (patch.flags) r.flags = { ...r.flags, ...patch.flags };
      if ('appInstanceId' in patch) {
        if (patch.appInstanceId) r.appInstanceId = patch.appInstanceId;
        else delete r.appInstanceId;
      }
      r.updatedAt = ctx.clock.now();
    });
    emitTree(rec.workspaceId, [id]);
    ctx.emit('page:changed', { id, metaRev: rec.rev });
    return rec;
  };

  const touch: PagesService['touch'] = (id) => {
    const rec = get(id);
    if (!rec) return;
    rec.updatedAt = ctx.clock.now();
    ctx.db.table<PageRecord>('pages').put(rec);
  };

  const move: PagesService['move'] = (id, parentId, opts = {}) => {
    const rec = require(id);
    if (parentId) {
      const parent = require(parentId);
      if (parent.workspaceId !== rec.workspaceId) throw new BackendError('INVALID', 'Cannot move across workspaces');
      if (parentId === id || ancestors(parentId).some((a) => a.id === id)) {
        throw new BackendError('INVALID', 'A page cannot be moved inside itself', { field: 'parentId' });
      }
    }
    const oldParent = rec.parentId;
    const sortKey = sortKeyFor(parentId, rec.workspaceId, { ...opts, excludeId: id });
    table().update(id, (r) => {
      r.parentId = parentId;
      r.sortKey = sortKey;
      r.updatedAt = ctx.clock.now();
    });
    const ups = [id];
    if (oldParent) ups.push(oldParent);
    if (parentId) ups.push(parentId);
    emitTree(rec.workspaceId, ups);
    return rec;
  };

  const trash: PagesService['trash'] = (ids) => {
    const now = ctx.clock.now();
    const byWs = new Map<Id, { removed: Id[]; parents: Set<Id> }>();
    for (const id of ids) {
      const rec = get(id);
      if (!rec || rec.deletedAt) continue;
      const subtree = [rec, ...descendantsAll(id, false)];
      for (const p of subtree) {
        table().update(p.id, (r) => {
          r.deletedAt = now;
          r.trashRoot = p.id === id;
        });
      }
      let entry = byWs.get(rec.workspaceId);
      if (!entry) byWs.set(rec.workspaceId, (entry = { removed: [], parents: new Set() }));
      entry.removed.push(...subtree.map((p) => p.id));
      if (rec.parentId) entry.parents.add(rec.parentId);
      // Unfavourite and drop from recents.
      const ws = ctx.db.table<{ id: Id; favorites: Id[]; recents: Id[] }>('workspaces').get(rec.workspaceId);
      if (ws) {
        const gone = new Set(subtree.map((p) => p.id));
        if (ws.favorites.some((f) => gone.has(f)) || ws.recents.some((f) => gone.has(f))) {
          ctx.db.table<{ id: Id; favorites: Id[]; recents: Id[] }>('workspaces').update(ws.id, (w) => {
            w.favorites = w.favorites.filter((f) => !gone.has(f));
            w.recents = w.recents.filter((f) => !gone.has(f));
          });
        }
      }
    }
    for (const [ws, { removed, parents }] of byWs) {
      emitTree(ws, Array.from(parents), removed);
      ctx.events.internal('page:deleted', { ids: removed, workspaceId: ws });
    }
  };

  const restore: PagesService['restore'] = (ids) => {
    const out: PageRecord[] = [];
    const byWs = new Map<Id, Id[]>();
    for (const id of ids) {
      const rec = get(id);
      if (!rec || !rec.deletedAt) continue;
      const stamp = rec.deletedAt;
      const subtree = [rec, ...descendantsAll(id, true).filter((d) => d.deletedAt === stamp)];
      const parent = rec.parentId ? get(rec.parentId) : undefined;
      const parentGone = !!rec.parentId && (!parent || !!parent.deletedAt);
      for (const p of subtree) {
        table().update(p.id, (r) => {
          delete r.deletedAt;
          delete r.trashRoot;
          if (r.id === id && parentGone) {
            r.parentId = null;
            r.sortKey = sortKeyFor(null, r.workspaceId, { excludeId: r.id });
          }
        });
      }
      out.push(rec);
      const list = byWs.get(rec.workspaceId) ?? [];
      list.push(...subtree.map((p) => p.id));
      if (rec.parentId) list.push(rec.parentId);
      byWs.set(rec.workspaceId, list);
    }
    for (const [ws, list] of byWs) {
      emitTree(ws, list);
      ctx.events.internal('page:restored', { ids: list, workspaceId: ws });
    }
    return out;
  };

  const purge: PagesService['purge'] = (ids) => {
    const byWs = new Map<Id, Id[]>();
    for (const id of ids) {
      const rec = get(id);
      if (!rec) continue;
      const subtree = [rec, ...descendantsAll(id, true)];
      for (const p of subtree) {
        table().delete(p.id);
        ctx.docs.delete(p.id);
        ctx.db.table<{ id: Id; targetId: Id }>('versions').deleteWhere((v) => v.targetId === p.id);
      }
      const list = byWs.get(rec.workspaceId) ?? [];
      list.push(...subtree.map((p) => p.id));
      byWs.set(rec.workspaceId, list);
      if (!rec.deletedAt && rec.parentId) emitTree(rec.workspaceId, [rec.parentId], subtree.map((p) => p.id));
    }
    for (const [ws, list] of byWs) ctx.events.internal('page:purged', { ids: list, workspaceId: ws });
  };

  return {
    table,
    require,
    get,
    meta: (id) => toMeta(require(id)),
    toMeta,
    create,
    update,
    touch,
    children,
    ancestors,
    descendants: (id) => descendantsAll(id, false),
    sortKeyFor,
    move,
    trash,
    restore,
    purge,
    emitTree,
  };
}
