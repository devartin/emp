/**
 * Google account commands (§9.19, §11.3 "Google and calendars"): client config, connect (simulated installed-app
 * OAuth with PKCE — the browser preview never contacts Google), incremental scopes and disconnect / revoke.
 */
import { BackendError } from '../../errors';
import type { GoogleFeature } from '../../types';
import type { MockHandlers } from '../ctx';
import { G, gLog, requireOnline, SCOPES, toAccount, type AccountRecord } from '@/features/integrations/mock/googleStore';
import { SAMPLE_CALENDARS } from '@/features/integrations/mock/sampleCalendar';

const CLIENT_RE = /^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;

export const handlers: MockHandlers = {
  google_status: (_req, ctx) => ({
    clientConfigured: !!G.client(ctx).get('client'),
    accounts: G.accounts(ctx)
      .all()
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map(toAccount),
  }),

  google_set_client: (req, ctx) => {
    const clientId = (req.clientId ?? '').trim();
    if (!CLIENT_RE.test(clientId)) throw new BackendError('INVALID', 'That doesn’t look like a Desktop client ID — it ends in .apps.googleusercontent.com', { field: 'clientId' });
    const secret = (req.clientSecret ?? '').trim();
    if (secret && !/^GOCSPX-[A-Za-z0-9_-]{20,}$/.test(secret)) throw new BackendError('INVALID', 'Client secrets start with GOCSPX-', { field: 'clientSecret' });
    G.client(ctx).put({ id: 'client', clientId, hasSecret: !!secret || !!G.client(ctx).get('client')?.hasSecret, updatedAt: ctx.clock.now() });
  },

  google_connect: async (req, ctx) => {
    if (!G.client(ctx).get('client')) throw new BackendError('AUTH_REQUIRED', 'Add your Google client ID first');
    requireOnline(ctx);
    const feature = req.feature as GoogleFeature;
    if (!SCOPES[feature]) throw new BackendError('INVALID', 'Unknown Google feature', { field: 'feature' });
    const existing = req.accountId ? G.accounts(ctx).get(req.accountId) : undefined;
    if (req.accountId && !existing) throw new BackendError('NOT_FOUND', 'That Google account is not connected');
    ctx.progress(1, 4, 'Opening Google in your browser…');
    await ctx.sleep(650, ctx.signal);
    ctx.progress(2, 4, 'Waiting for you to approve access…');
    await ctx.sleep(1100, ctx.signal);
    ctx.checkCancelled();
    ctx.progress(3, 4, 'Exchanging the code for tokens…');
    gLog(ctx, 'POST', 'oauth2.googleapis.com', '/token', 200, 1320);
    await ctx.sleep(350, ctx.signal);
    const now = ctx.clock.now();
    const scopes = [...new Set([...(existing?.scopes ?? SCOPES.label), ...SCOPES[feature]])];
    let acct: AccountRecord;
    if (existing) {
      acct = G.accounts(ctx).update(existing.id, (a) => {
        a.scopes = scopes;
        a.status = 'ok';
      });
    } else {
      gLog(ctx, 'GET', 'www.googleapis.com', '/oauth2/v3/userinfo', 200, 410);
      const n = G.accounts(ctx).size;
      acct = G.accounts(ctx).insert({ id: ctx.id(), email: n ? `alex.${n + 1}@example.com` : 'alex.rivera@example.com', scopes, connectedAt: now, status: 'ok', testing: false });
    }
    if (feature === 'calendar' && !G.calendars(ctx).find((c) => c.accountId === acct.id)) {
      ctx.progress(4, 4, 'Fetching your calendars…');
      gLog(ctx, 'GET', 'www.googleapis.com', '/calendar/v3/users/me/calendarList', 200, 2840);
      for (const c of SAMPLE_CALENDARS) G.calendars(ctx).insert({ ...c, id: `${acct.id}:${c.calId}`, accountId: acct.id });
      G.sync(ctx).put({ id: acct.id, calendarIds: SAMPLE_CALENDARS.filter((c) => c.selected).map((c) => c.calId), intervalMin: 5 });
    } else ctx.progress(4, 4, 'Connected');
    return toAccount(acct);
  },

  google_disconnect: (req, ctx) => {
    const acct = G.accounts(ctx).get(req.accountId);
    if (!acct) throw new BackendError('NOT_FOUND', 'That Google account is not connected');
    if (req.revoke) {
      if (ctx.isOffline()) throw new BackendError('OFFLINE', 'Offline mode is on — turn it off to revoke access at Google, or disconnect without revoking.');
      gLog(ctx, 'POST', 'oauth2.googleapis.com', '/revoke', 200, 0);
    }
    G.accounts(ctx).delete(acct.id);
    G.sync(ctx).delete(acct.id);
    G.calendars(ctx).deleteWhere((c) => c.accountId === acct.id);
    if (req.deleteCache) G.events(ctx).deleteWhere((e) => e.accountId === acct.id);
    ctx.emit('sync:status', { provider: 'google', state: 'idle' });
  },
};
