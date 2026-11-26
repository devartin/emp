/** Google Calendar (§17.1 "Calendar (read)"): calendar list, sync selection and the sync job (−90…+365 days). */
import { BackendError } from '../../errors';
import type { MockCtx, MockHandlers } from '../ctx';
import { G, gLog, requireAccount, requireOnline, SCOPES } from '@/features/integrations/mock/googleStore';
import { sampleEvents } from '@/features/integrations/mock/sampleCalendar';

export async function syncAccount(ctx: MockCtx, accountId: string, opts: { progress?: (d: number, t: number, l?: string) => void; signal?: AbortSignal } = {}) {
  const acct = requireAccount(ctx, accountId, SCOPES.calendar[0]);
  const sync = G.sync(ctx).get(acct.id);
  const cals = G.calendars(ctx).filter((c) => c.accountId === acct.id && (sync ? sync.calendarIds.includes(c.calId) : c.selected));
  let added = 0;
  let deleted = 0;
  const before = G.events(ctx).filter((e) => e.accountId === acct.id).length;
  const fresh = sampleEvents({ accountId: acct.id, now: ctx.clock.now(), newId: () => ctx.id(), calendars: cals });
  let i = 0;
  for (const c of cals) {
    i += 1;
    opts.progress?.(i, cals.length + 1, `Syncing ${c.summary}`);
    gLog(ctx, 'GET', 'www.googleapis.com', `/calendar/v3/calendars/{calendarId}/events`, 200, 18_000 + Math.round(Math.random() * 9_000));
    if (!ctx.seeding) await ctx.sleep(220, opts.signal);
  }
  // First sync stores everything; later syncs (syncToken) only diff — the sample is deterministic, so keep the cache.
  if (before === 0) {
    for (const e of fresh) G.events(ctx).insert(e);
    added = fresh.length;
  } else {
    const selected = new Set(cals.map((c) => c.calId));
    deleted = G.events(ctx).deleteWhere((e) => e.accountId === acct.id && !selected.has(e.calId));
    const have = new Set(G.events(ctx).filter((e) => e.accountId === acct.id).map((e) => `${e.calId}|${e.title}|${e.start}`));
    for (const e of fresh) if (!have.has(`${e.calId}|${e.title}|${e.start}`)) {
      G.events(ctx).insert(e);
      added += 1;
    }
  }
  G.sync(ctx).put({ id: acct.id, calendarIds: cals.map((c) => c.calId), intervalMin: sync?.intervalMin ?? 5, lastSync: ctx.clock.now() });
  ctx.emit('sync:status', { provider: 'google', state: 'idle', lastSync: ctx.clock.now() });
  return { added, updated: 0, deleted };
}

export const handlers: MockHandlers = {
  gcal_calendars: (req, ctx) => {
    requireAccount(ctx, req.accountId);
    const sync = G.sync(ctx).get(req.accountId);
    return G.calendars(ctx)
      .filter((c) => c.accountId === req.accountId)
      .map((c) => ({ id: c.calId, summary: c.summary, color: c.color, primary: c.primary, selected: sync ? sync.calendarIds.includes(c.calId) : c.selected }));
  },
  gcal_set_sync: (req, ctx) => {
    requireAccount(ctx, req.accountId);
    if (![5, 15, 30, 60].includes(req.intervalMin)) throw new BackendError('INVALID', 'Sync every 5, 15, 30 or 60 minutes', { field: 'intervalMin' });
    const known = new Set(G.calendars(ctx).filter((c) => c.accountId === req.accountId).map((c) => c.calId));
    const ids = req.calendarIds.filter((id) => known.has(id));
    const prev = G.sync(ctx).get(req.accountId);
    G.sync(ctx).put({ id: req.accountId, calendarIds: ids, intervalMin: req.intervalMin, lastSync: prev?.lastSync });
    for (const c of G.calendars(ctx).filter((x) => x.accountId === req.accountId)) G.calendars(ctx).update(c.id, (x) => void (x.selected = ids.includes(x.calId)));
  },
  gcal_sync_now: async (req, ctx) => {
    requireOnline(ctx);
    const accounts = req.accountId ? [requireAccount(ctx, req.accountId)] : G.accounts(ctx).filter((a) => a.status === 'ok' && a.scopes.includes(SCOPES.calendar[0]));
    if (!accounts.length) throw new BackendError('AUTH_REQUIRED', 'Connect Google Calendar first');
    ctx.emit('sync:status', { provider: 'google', state: 'syncing' });
    const total = { added: 0, updated: 0, deleted: 0 };
    try {
      for (const a of accounts) {
        const r = await syncAccount(ctx, a.id, { progress: ctx.progress, signal: ctx.signal });
        total.added += r.added;
        total.deleted += r.deleted;
      }
    } catch (e) {
      ctx.emit('sync:status', { provider: 'google', state: 'error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    return total;
  },
};
