/**
 * ICS (§17.3): `ics_export` (database rows with a date, or pages) and `import_ics` (VEVENT → calendar events or rows
 * of a database, VTODO → Life OS tasks when installed). Limits follow §9.16 (5,000 events, 5 MiB).
 */
import { BackendError } from '../../errors';
import type { Id, Property } from '../../types';
import type { MockHandlers } from '../ctx';
import type { DbApi } from './db';
import { icsEvents } from './calendar';
import { expand, parseIcs, writeIcs, type IcsEvent } from '@/features/calendar/engine/ics';

const MAX_BYTES = 5 * 1024 * 1024;

export const handlers: MockHandlers = {
  ics_export: (req, ctx) => {
    const db = ctx.services.get<DbApi>('db.api');
    const events: IcsEvent[] = [];
    let name = 'EMP';
    if ('databaseId' in req.source) {
      if (!db) throw new BackendError('INTERNAL', 'Databases are not available');
      const schema = db.schema(ctx, req.source.databaseId);
      name = schema.database.title || 'EMP';
      const dateProp = schema.properties.find((p) => p.id === (req.source as { dateProp: Id }).dateProp);
      if (!dateProp || dateProp.type !== 'date') throw new BackendError('INVALID', 'Pick a date property to export', { field: 'dateProp' });
      const title = schema.properties.find((p) => p.id === schema.database.primaryPropId) as Property;
      for (const r of db.rows(ctx, req.source.databaseId)) {
        const v = r.values[dateProp.id];
        if (!v || v.t !== 'date' || !v.v) continue;
        const t = r.values[title.id];
        events.push({ uid: `${r.id}@emp.local`, kind: 'event', title: t && t.t === 'text' ? t.v.map((x) => x.text).join('') || 'Untitled' : 'Untitled', start: v.v.start, end: v.v.end ?? v.v.start, allDay: !v.v.time });
      }
    } else {
      for (const id of req.source.pageIds) {
        const p = ctx.pages.require(id);
        const day = new Date(p.createdAt).toISOString().slice(0, 10);
        events.push({ uid: `${p.id}@emp.local`, kind: 'event', title: p.title || 'Untitled', start: day, end: day, allDay: true });
      }
    }
    ctx.grants.write(req.grantId, writeIcs(events, name, new Date(ctx.clock.now())), 'text/calendar');
    return { events: events.length };
  },

  import_ics: async (req, ctx) => {
    const file = ctx.grants.read(req.grantId);
    if (file.size > MAX_BYTES) throw new BackendError('TOO_LARGE', 'Calendar files up to 5 MB can be imported');
    ctx.progress(1, 3, 'Reading the calendar file');
    const text = await file.text();
    let parsed;
    try {
      parsed = parseIcs(text);
    } catch (e) {
      throw new BackendError('INVALID', e instanceof Error ? e.message : 'This isn’t an iCalendar file');
    }
    ctx.checkCancelled();
    ctx.progress(2, 3, `Adding ${parsed.events.length} items`);
    const now = new Date(ctx.clock.now());
    const from = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 365 * 86_400_000).toISOString().slice(0, 10);
    const calName = parsed.calendarName || file.name.replace(/\.ics$/i, '');
    const importId = ctx.id();
    let n = 0;
    const db = ctx.services.get<DbApi>('db.api');
    if (req.target === 'calendar') {
      for (const ev of parsed.events.filter((e) => e.kind === 'event')) {
        for (const occ of expand(ev, from, to)) {
          icsEvents(ctx).insert({ id: ctx.id(), calendarId: `ics:${calName}`, title: occ.title, start: occ.start, end: occ.end, allDay: occ.allDay, location: occ.location, description: occ.description, recurring: !!ev.rrule, importId });
          n += 1;
        }
      }
    } else {
      if (!db) throw new BackendError('INTERNAL', 'Databases are not available');
      const target = req.target.databaseId;
      const schema = db.schema(ctx, target);
      const date = schema.properties.find((p) => p.type === 'date');
      if (!date) throw new BackendError('INVALID', 'That database has no date property');
      for (const ev of parsed.events.filter((e) => e.kind === 'event')) {
        for (const occ of expand(ev, from, to)) {
          db.createRow(ctx, target, { values: { [schema.database.primaryPropId]: { t: 'text', v: [{ text: occ.title }] }, [date.id]: { t: 'date', v: { start: occ.start, end: occ.end !== occ.start ? occ.end : undefined, time: !occ.allDay } } }, silent: true });
          n += 1;
        }
      }
      db.emitChanged(ctx, target);
    }
    // VTODO → Life OS tasks (when installed)
    const todos = parsed.events.filter((e) => e.kind === 'todo');
    if (todos.length && db) {
      const api = ctx.services.get<{ byApp(appId: string): { keyMap: Record<string, Id> } | undefined }>('lifeapp.api');
      const tasksId = api?.byApp('life-os')?.keyMap.tasks;
      if (tasksId) {
        const s = db.schema(ctx, tasksId);
        const due = s.properties.find((p) => p.role === 'task.due');
        const status = s.properties.find((p) => p.role === 'task.status');
        const inbox = ((status?.config.options as { id: Id; name: string }[]) ?? []).find((o) => o.name === 'Inbox')?.id;
        for (const t of todos) {
          const values: Record<Id, import('../../types').CellValue> = { [s.database.primaryPropId]: { t: 'text', v: [{ text: t.title }] } };
          if (due && t.start) values[due.id] = { t: 'date', v: { start: t.start.slice(0, 10), time: false } };
          if (status && inbox) values[status.id] = { t: 'status', v: inbox };
          db.createRow(ctx, tasksId, { values, silent: true });
          n += 1;
        }
        db.emitChanged(ctx, tasksId);
      }
    }
    ctx.progress(3, 3, 'Done');
    return { events: n };
  },
};
