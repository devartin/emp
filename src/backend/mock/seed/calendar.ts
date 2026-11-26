/**
 * Calendar & Google demo seed: a configured Desktop OAuth client, one connected account with four calendars (first
 * sync done, events cached), an imported ICS calendar, and a believable Network log of past syncs.
 */
import type { MockCtx } from '../ctx';
import { syncAccount } from '../commands/gcal';
import { icsEvents } from '../commands/calendar';
import { logNetwork } from '../commands/network';
import { G, SCOPES } from '@/features/integrations/mock/googleStore';
import { SAMPLE_CALENDARS } from '@/features/integrations/mock/sampleCalendar';

export const order = 70;

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export async function seed(ctx: MockCtx): Promise<void> {
  if (ctx.seedKind !== 'demo') return;
  const now = ctx.clock.now();
  G.client(ctx).put({ id: 'client', clientId: '481516234200-q8v3k2m9h1t7ns0abcdef4567example.apps.googleusercontent.com', hasSecret: true, updatedAt: now - 40 * DAY });
  const acct = G.accounts(ctx).insert({
    id: ctx.id(),
    email: 'alex.rivera@example.com',
    scopes: [...SCOPES.label, ...SCOPES.calendar, ...SCOPES.docs_import, ...SCOPES.sheets_import],
    connectedAt: now - 40 * DAY,
    status: 'ok',
    testing: false,
  });
  for (const c of SAMPLE_CALENDARS) G.calendars(ctx).insert({ ...c, id: `${acct.id}:${c.calId}`, accountId: acct.id });
  G.sync(ctx).put({ id: acct.id, calendarIds: SAMPLE_CALENDARS.filter((c) => c.selected).map((c) => c.calId), intervalMin: 5 });
  await syncAccount(ctx, acct.id);

  // An imported race calendar (ICS)
  const start = new Date(now);
  const base = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const ics: [number, string, string | null, string | null, string][] = [
    [18, 'Winter 10K', '08:00', '10:00', 'Harbor Park'],
    [46, 'Trail half — registration closes', null, null, ''],
    [74, 'Spring half marathon expo', '10:00', '18:00', 'Convention Center'],
    [75, 'Spring half marathon', '07:30', '10:30', 'Start: City Hall'],
  ];
  for (const [d, title, s, e, loc] of ics) {
    const day = localDay(base + d * DAY);
    icsEvents(ctx).insert({ id: ctx.id(), calendarId: 'ics:Race calendar', title, start: s ? `${day}T${s}:00` : day, end: e ? `${day}T${e}:00` : day, allDay: !s, location: loc || undefined, recurring: false });
  }

  // Past Google syncs in the network log (every few hours over the last days).
  for (let i = 1; i <= 24; i++) {
    const at = now - i * 3 * 3_600_000 - 7 * 60_000;
    logNetwork(ctx, { at, connector: 'google', method: 'GET', host: 'www.googleapis.com', path: '/calendar/v3/calendars/{calendarId}/events', status: i === 9 ? 503 : 200, bytes: i === 9 ? 0 : 900 + ((i * 7919) % 4000) });
    if (i % 8 === 0) logNetwork(ctx, { at: at - 1200, connector: 'google', method: 'POST', host: 'oauth2.googleapis.com', path: '/token', status: 200, bytes: 1320 });
  }
  ctx.seedRefs.set('google.account', acct.id);
}
