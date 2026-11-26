/**
 * calendar_events (§11.3, §17.1 "Storage"): the local, offline-safe merge of the Google event cache, imported ICS
 * events, and database dates that carry a calendar role — Life OS scheduled / due tasks (`task.scheduled`,
 * `task.due`), tax deadlines (`deadline.date`) and event databases (`event.date`). Other databases the user puts on
 * the calendar are merged by the Calendar page through `db_query_range`.
 */
import { BackendError } from '../../errors';
import type { CalendarEvent, Id, Property, RowDTO } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import type { DbApi, DbRecord } from './db';
import { G } from '@/features/integrations/mock/googleStore';

export interface IcsEventRecord {
  id: Id;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  recurring: boolean;
  importId?: Id;
}
export const icsEvents = (ctx: MockCtx) => ctx.db.table<IcsEventRecord>('ics_events');

const toMs = (s: string, endOfDay = false) => {
  if (s.length <= 10) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).getTime();
  }
  return Date.parse(s);
};
const overlaps = (start: string, end: string, from: number, to: number) => toMs(start) <= to && toMs(end || start, true) >= from;

const ROLE_SOURCES: { role: string; color: string; label: string }[] = [
  { role: 'task.scheduled', color: 'blue', label: 'Scheduled task' },
  { role: 'task.due', color: 'blue', label: 'Due' },
  { role: 'deadline.date', color: 'yellow', label: 'Tax deadline' },
  { role: 'event.date', color: 'gray', label: 'Event' },
];

function text(r: RowDTO, p: Property | undefined): string {
  const v = p ? r.values[p.id] : undefined;
  return v && v.t === 'text' ? v.v.map((x) => x.text).join('') : '';
}

function dbEvents(ctx: MockCtx, from: number, to: number): CalendarEvent[] {
  const db = ctx.services.get<DbApi>('db.api');
  if (!db) return [];
  const out: CalendarEvent[] = [];
  for (const rec of ctx.db.table<DbRecord>('db_databases').all()) {
    const page = ctx.pages.get(rec.id);
    if (!page || page.deletedAt) continue;
    let schema;
    try {
      schema = db.schema(ctx, rec.id);
    } catch {
      continue;
    }
    const byId = new Map(schema.properties.map((p) => [p.id, p] as const));
    const role = (r: string) => schema.properties.find((p) => p.role === r) ?? (rec.roles[r] ? byId.get(rec.roles[r]) : undefined);
    const sources: { prop: Property; color: string; kind: string }[] = [];
    for (const s of ROLE_SOURCES) {
      const p = role(s.role);
      if (p && p.type === 'date') sources.push({ prop: p, color: s.color, kind: s.role });
    }
    if (!sources.length) continue;
    const title = byId.get(rec.primaryPropId);
    const status = role('task.status');
    const doneId = status ? ((status.config.options as { id: Id; name: string; group?: string }[]) ?? []).filter((o) => o.group === 'complete').map((o) => o.id) : [];
    const sched = sources.find((s) => s.kind === 'task.scheduled');
    for (const r of db.rows(ctx, rec.id)) {
      if (status) {
        const sv = r.values[status.id];
        if (sv && sv.t === 'status' && sv.v && doneId.includes(sv.v)) continue;
      }
      for (const s of sources) {
        const v = r.values[s.prop.id];
        if (!v || v.t !== 'date' || !v.v) continue;
        // A task with a scheduled block doesn't also show its due date.
        if (s.kind === 'task.due' && sched && r.values[sched.prop.id]) continue;
        const dv = v.v;
        const end = dv.end ?? dv.start;
        if (!overlaps(dv.start, end, from, to)) continue;
        const t = text(r, title) || 'Untitled';
        out.push({
          id: `${r.id}:${s.prop.id}`,
          source: 'db',
          calendarId: rec.id,
          title: s.kind === 'task.due' ? t : t,
          start: dv.start,
          end,
          allDay: !dv.time,
          color: s.color,
          recurring: false,
          description: s.kind === 'task.due' ? 'Due' : undefined,
          link: { t: 'row', id: r.id },
        });
      }
    }
  }
  return out;
}

export function eventsBetween(ctx: MockCtx, fromIso: string, toIso: string, sources?: ('google' | 'ics' | 'db')[]): CalendarEvent[] {
  const from = toMs(fromIso);
  const to = toMs(toIso, true);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new BackendError('INVALID', 'Choose a valid date range');
  if (to - from > 400 * 86_400_000) throw new BackendError('TOO_LARGE', 'Ask for at most about a year of events at a time');
  const want = new Set(sources?.length ? sources : ['google', 'ics', 'db']);
  const out: CalendarEvent[] = [];
  if (want.has('google')) {
    const calColor = new Map(G.calendars(ctx).all().map((c) => [`${c.accountId}|${c.calId}`, c] as const));
    const selected = new Map(G.sync(ctx).all().map((s) => [s.id, new Set(s.calendarIds)] as const));
    for (const e of G.events(ctx).values()) {
      if (!selected.get(e.accountId)?.has(e.calId)) continue;
      if (!overlaps(e.start, e.end, from, to)) continue;
      const cal = calColor.get(`${e.accountId}|${e.calId}`);
      out.push({ id: e.id, source: 'google', calendarId: e.calId, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, description: e.description, color: cal?.color ?? 'blue', recurring: e.recurring });
    }
  }
  if (want.has('ics')) {
    for (const e of icsEvents(ctx).values()) {
      if (!overlaps(e.start, e.end, from, to)) continue;
      out.push({ id: e.id, source: 'ics', calendarId: e.calendarId, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, description: e.description, color: 'orange', recurring: e.recurring });
    }
  }
  if (want.has('db')) out.push(...dbEvents(ctx, from, to));
  return out.sort((a, b) => toMs(a.start) - toMs(b.start) || Number(b.allDay) - Number(a.allDay));
}

export const handlers: MockHandlers = {
  calendar_events: (req, ctx) => eventsBetween(ctx, req.from, req.to, req.sources),
};
