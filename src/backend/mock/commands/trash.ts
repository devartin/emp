/** trash_list / trash_empty — deleted roots, kept for `trashRetentionDays` (default 30, D-24). */
import type { Id, PageMeta } from '../../types';
import type { MockCtx, MockHandlers, PageRecord } from '../ctx';
import { fold } from '../lib/search';
import { vaultSettings } from '../lib/settings';

const DAY = 86_400_000;

/** Purge trash roots older than the retention window. */
export function purgeExpired(ctx: MockCtx, workspaceId?: Id): number {
  const keepMs = vaultSettings(ctx).trashRetentionDays * DAY;
  const cutoff = ctx.clock.now() - keepMs;
  const expired = ctx.pages
    .table()
    .filter((p) => !!p.trashRoot && !!p.deletedAt && p.deletedAt < cutoff && (!workspaceId || p.workspaceId === workspaceId));
  if (expired.length) ctx.pages.purge(expired.map((p) => p.id));
  return expired.length;
}

function roots(ctx: MockCtx, workspaceId: Id): PageRecord[] {
  return ctx.pages.table().filter((p) => p.workspaceId === workspaceId && !!p.deletedAt && !!p.trashRoot);
}

export const handlers: MockHandlers = {
  trash_list: (req, ctx) => {
    purgeExpired(ctx, req.workspaceId);
    const q = req.q ? fold(req.q.trim()) : '';
    return roots(ctx, req.workspaceId)
      .filter((p) => !q || fold(p.title).includes(q))
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .map((p): PageMeta => ctx.pages.toMeta(p));
  },
  trash_empty: async (req, ctx) => {
    const list = roots(ctx, req.workspaceId);
    let n = 0;
    for (const p of list) {
      ctx.checkCancelled();
      ctx.pages.purge([p.id]);
      n++;
      ctx.progress(n, list.length, 'Emptying Trash');
      if (list.length > 20 && n % 20 === 0) await ctx.sleep(0);
    }
    return { purged: n };
  },
};
