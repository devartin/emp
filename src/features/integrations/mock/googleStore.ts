/**
 * Mock-only Google state (§9.19, §17.1): the user's OAuth client, connected accounts with their granted scopes,
 * calendar lists and the encrypted event cache (`kv ns=gcal.events` in Rust — a table here). Every simulated request
 * goes through `logNetwork` so the Network log and the activity pulse stay honest.
 */
import { BackendError } from '@/backend/errors';
import type { GoogleAccount, GoogleFeature, Id } from '@/backend/types';
import type { MockCtx } from '@/backend/mock/ctx';
import { logNetwork } from '@/backend/mock/commands/network';

export const SCOPES: Record<GoogleFeature | 'label', string[]> = {
  label: ['openid', 'email'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
  docs_import: ['https://www.googleapis.com/auth/documents.readonly'],
  sheets_import: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  export: ['https://www.googleapis.com/auth/drive.file'],
};

export interface ClientRecord {
  id: 'client';
  clientId: string;
  hasSecret: boolean;
  updatedAt: number;
}
export interface AccountRecord extends GoogleAccount {
  /** Testing-mode grants expire after 7 days (§9.19 step 5). */
  testing: boolean;
}
export interface CalendarRecord {
  id: string;
  accountId: Id;
  calId: string;
  summary: string;
  color: string;
  primary: boolean;
  selected: boolean;
}
export interface EventRecord {
  id: Id;
  accountId: Id;
  calId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  recurring: boolean;
}
export interface SyncRecord {
  id: Id;
  calendarIds: string[];
  intervalMin: 5 | 15 | 30 | 60;
  lastSync?: number;
}

export const G = {
  client: (ctx: MockCtx) => ctx.db.table<ClientRecord>('google_client'),
  accounts: (ctx: MockCtx) => ctx.db.table<AccountRecord>('google_accounts'),
  calendars: (ctx: MockCtx) => ctx.db.table<CalendarRecord>('gcal_calendars'),
  events: (ctx: MockCtx) => ctx.db.table<EventRecord>('gcal_events'),
  sync: (ctx: MockCtx) => ctx.db.table<SyncRecord>('gcal_sync'),
};

export function toAccount(a: AccountRecord): GoogleAccount {
  return { id: a.id, email: a.email, scopes: [...a.scopes], connectedAt: a.connectedAt, status: a.status };
}

export function requireOnline(ctx: MockCtx): void {
  if (ctx.isOffline()) throw new BackendError('OFFLINE', 'Offline mode is on. Turn it off in Settings → Network to reach Google.');
}

export function requireAccount(ctx: MockCtx, accountId: Id | undefined, scope?: string): AccountRecord {
  const a = accountId ? G.accounts(ctx).get(accountId) : G.accounts(ctx).all()[0];
  if (!a) throw new BackendError('AUTH_REQUIRED', 'Connect a Google account first');
  if (a.status === 'reauth_required') throw new BackendError('AUTH_REQUIRED', 'Reconnect Google — access expired');
  if (scope && !a.scopes.includes(scope)) throw new BackendError('AUTH_REQUIRED', 'Google hasn’t granted this permission yet', { field: scope });
  return a;
}

export function gLog(ctx: MockCtx, method: string, host: string, path: string, status = 200, bytes = 1200): void {
  logNetwork(ctx, { connector: 'google', method, host, path, status, bytes });
}

/** Google calendar colours → nearest block colour (§17.1). */
export const GCAL_COLORS: Record<string, string> = { '#4285f4': 'blue', '#33b679': 'green', '#8e24aa': 'purple', '#e67c73': 'red', '#f6bf26': 'yellow', '#f4511e': 'orange', '#616161': 'gray', '#d81b60': 'pink' };
