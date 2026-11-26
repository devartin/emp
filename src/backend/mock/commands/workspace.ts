/** workspace_* — v1 has a single "Personal" workspace, but the commands are general. */
import { BackendError } from '../../errors';
import type { LifeAppInstance, Route, Workspace } from '../../types';
import type { KnownServices, MockCtx, MockHandlers, WorkspaceRecord } from '../ctx';
import { kvRead } from './kv';

const table = (ctx: MockCtx) => ctx.db.table<WorkspaceRecord>('workspaces');

export function toWorkspace(r: WorkspaceRecord): Workspace {
  const ws: Workspace = { id: r.id, name: r.name, favorites: [...r.favorites], defaults: { ...r.defaults } };
  if (r.icon) ws.icon = r.icon;
  return ws;
}

function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new BackendError('INVALID', 'Give your workspace a name', { field: 'name' });
  if (n.length > 100) throw new BackendError('INVALID', 'That name is too long', { field: 'name' });
  return n;
}

export const handlers: MockHandlers = {
  workspace_list: (_req, ctx) =>
    table(ctx)
      .all()
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
      .map(toWorkspace),

  workspace_create: (req, ctx) => {
    const last = table(ctx)
      .all()
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
      .pop();
    const now = ctx.clock.now();
    const rec: WorkspaceRecord = {
      id: ctx.id(),
      sortKey: ctx.keyBetween(last?.sortKey ?? null, null),
      name: validName(req.name),
      favorites: [],
      recents: [],
      defaults: { font: 'sans', fullWidth: false, smallText: false },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    if (req.icon) rec.icon = req.icon;
    table(ctx).insert(rec);
    return toWorkspace(rec);
  },

  workspace_update: (req, ctx) => {
    const p = req.patch ?? {};
    const rec = table(ctx).update(req.id, (w) => {
      if (p.name !== undefined) w.name = validName(p.name);
      if ('icon' in p) {
        if (p.icon) w.icon = p.icon;
        else delete w.icon;
      }
      if (p.favorites) {
        const live = new Set(ctx.pages.table().filter((pg) => !pg.deletedAt && pg.workspaceId === w.id).map((pg) => pg.id));
        w.favorites = Array.from(new Set(p.favorites)).filter((id) => live.has(id)).slice(0, 200);
      }
      if (p.defaults) w.defaults = { ...w.defaults, ...p.defaults };
      w.updatedAt = ctx.clock.now();
    });
    return toWorkspace(rec);
  },

  workspace_open: (req, ctx) => {
    const rec = table(ctx).require(req.id, 'Workspace');
    const pages = ctx.pages
      .table()
      .filter((p) => p.workspaceId === rec.id && !p.deletedAt)
      .map((p) => ctx.pages.toMeta(p));
    const live = new Set(pages.map((p) => p.id));
    const lastRoute = kvRead(ctx, 'ui.nav', 'lastRoute') as Route | null;
    const instances = ctx.services.get<KnownServices['lifeapp.instances']>('lifeapp.instances');
    let lifeapps: LifeAppInstance[] = [];
    try {
      lifeapps = instances ? instances(rec.id) : [];
    } catch (err) {
      console.error('[emp mock] lifeapp.instances failed', err);
    }
    const out: ReturnType<NonNullable<MockHandlers['workspace_open']>> = {
      workspace: toWorkspace(rec),
      pages,
      recents: rec.recents.filter((id) => live.has(id)),
      lifeapps,
    };
    if (lastRoute) (out as { lastRoute?: Route }).lastRoute = lastRoute;
    return out;
  },
};
