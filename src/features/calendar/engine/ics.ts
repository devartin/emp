/**
 * Minimal iCalendar (RFC 5545) reader/writer for ICS import/export (§17.3) in the browser preview. Handles line
 * folding, TEXT escaping, DATE vs DATE-TIME (UTC `Z` and floating), DURATION ends, and expands simple RRULEs
 * (DAILY / WEEKLY with BYDAY / MONTHLY / YEARLY, COUNT / UNTIL) inside a window, capped like §9.16.
 */
export interface IcsEvent {
  uid: string;
  kind: 'event' | 'todo';
  title: string;
  /** 'YYYY-MM-DD' (all-day) or ISO date-time. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  rrule?: string;
}

const MAX_EVENTS = 5000;

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

function parseDate(value: string, params: string): { iso: string; allDay: boolean } | null {
  const v = value.trim();
  if (/VALUE=DATE(;|$)/i.test(params) || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    return m ? { iso: `${m[1]}-${m[2]}-${m[3]}`, allDay: true } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`;
  return { iso: m[7] ? new Date(iso).toISOString() : iso, allDay: false };
}

function parseDuration(d: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d.trim());
  if (!m) return 0;
  const [, sign, w, dd, h, mi, s] = m;
  const ms = ((Number(w ?? 0) * 7 + Number(dd ?? 0)) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

const addDaysIso = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function parseIcs(text: string): { events: IcsEvent[]; calendarName?: string; warnings: string[] } {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  const warnings: string[] = [];
  let cur: Partial<IcsEvent> & { kind?: IcsEvent['kind']; dur?: number } | null = null;
  let calendarName: string | undefined;
  if (!lines.some((l) => l.trim().toUpperCase() === 'BEGIN:VCALENDAR')) throw new Error('This isn’t an iCalendar file');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(';');
    const params = paramParts.join(';');
    const key = name.toUpperCase();
    if (key === 'BEGIN' && (value === 'VEVENT' || value === 'VTODO')) {
      cur = { kind: value === 'VTODO' ? 'todo' : 'event' };
      continue;
    }
    if (key === 'END' && (value === 'VEVENT' || value === 'VTODO') && cur) {
      if (cur.start) {
        let end = cur.end;
        if (!end && cur.dur) end = cur.allDay ? addDaysIso(cur.start, Math.max(0, Math.round(cur.dur / 86_400_000) - 1)) : new Date(new Date(cur.start).getTime() + cur.dur).toISOString();
        if (!end) end = cur.start;
        // DTEND for all-day events is exclusive in iCalendar; we store inclusive ends.
        if (cur.allDay && cur.end && cur.end > cur.start) end = addDaysIso(cur.end, -1);
        events.push({ uid: cur.uid ?? `ics-${events.length}`, kind: cur.kind ?? 'event', title: cur.title || 'Untitled event', start: cur.start, end, allDay: !!cur.allDay, location: cur.location, description: cur.description, rrule: cur.rrule });
      } else if (cur.kind === 'todo') {
        events.push({ uid: cur.uid ?? `todo-${events.length}`, kind: 'todo', title: cur.title || 'Untitled task', start: '', end: '', allDay: true, description: cur.description });
      }
      cur = null;
      if (events.length > MAX_EVENTS) {
        warnings.push(`Stopped after ${MAX_EVENTS.toLocaleString()} events.`);
        break;
      }
      continue;
    }
    if (key === 'X-WR-CALNAME' && !cur) calendarName = unescapeText(value);
    if (!cur) continue;
    switch (key) {
      case 'UID':
        cur.uid = value;
        break;
      case 'SUMMARY':
        cur.title = unescapeText(value).slice(0, 1024);
        break;
      case 'LOCATION':
        cur.location = unescapeText(value).slice(0, 1024);
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(value).slice(0, 8000);
        break;
      case 'DTSTART':
      case 'DUE': {
        const d = parseDate(value, params);
        if (d) {
          cur.start = d.iso;
          cur.allDay = d.allDay;
        }
        break;
      }
      case 'DTEND': {
        const d = parseDate(value, params);
        if (d) cur.end = d.iso;
        break;
      }
      case 'DURATION':
        cur.dur = parseDuration(value);
        break;
      case 'RRULE':
        cur.rrule = value;
        break;
      default:
        break;
    }
  }
  return { events, calendarName, warnings };
}

/** Expand recurring events into occurrences overlapping [from, to] (ISO days), at most `cap` per series. */
export function expand(ev: IcsEvent, from: string, to: string, cap = 500): IcsEvent[] {
  if (!ev.rrule || ev.kind !== 'event') return [ev];
  const parts = Object.fromEntries(ev.rrule.split(';').map((p) => p.split('=') as [string, string]));
  const freq = parts.FREQ;
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1);
  const count = parts.COUNT ? Number(parts.COUNT) : Infinity;
  const until = parts.UNTIL ? (parseDate(parts.UNTIL, '')?.iso ?? '').slice(0, 10) : '9999-12-31';
  const byday = (parts.BYDAY ?? '').split(',').filter(Boolean);
  const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const startDay = ev.start.slice(0, 10);
  const lenMs = new Date(ev.end.length > 10 ? ev.end : `${ev.end}T00:00:00`).getTime() - new Date(ev.start.length > 10 ? ev.start : `${ev.start}T00:00:00`).getTime();
  const out: IcsEvent[] = [];
  let n = 0;
  const emit = (day: string) => {
    n += 1;
    if (day < from || day > to) return;
    const shift = (iso: string) => (iso.length > 10 ? `${day}${iso.slice(10)}` : day);
    const start = shift(ev.start);
    const end = ev.allDay ? addDaysIso(day, Math.round(lenMs / 86_400_000)) : new Date(new Date(start).getTime() + lenMs).toISOString();
    out.push({ ...ev, uid: `${ev.uid}:${day}`, start, end });
  };
  for (let i = 0, day = startDay; i < 366 * 5 && n < count && day <= until && out.length < cap; i++, day = addDaysIso(day, 1)) {
    const d = new Date(`${day}T12:00:00`);
    const diffDays = Math.round((d.getTime() - new Date(`${startDay}T12:00:00`).getTime()) / 86_400_000);
    let hit = false;
    if (freq === 'DAILY') hit = diffDays % interval === 0 && (!byday.length || byday.includes(codes[d.getDay()]));
    else if (freq === 'WEEKLY') hit = Math.floor(diffDays / 7) % interval === 0 && (byday.length ? byday.includes(codes[d.getDay()]) : d.getDay() === new Date(`${startDay}T12:00:00`).getDay());
    else if (freq === 'MONTHLY') hit = d.getDate() === new Date(`${startDay}T12:00:00`).getDate();
    else if (freq === 'YEARLY') hit = day.slice(5) === startDay.slice(5);
    else hit = diffDays === 0;
    if (hit) emit(day);
  }
  return out;
}

function fmtDate(iso: string, allDay: boolean): string {
  if (allDay) return iso.slice(0, 10).replace(/-/g, '');
  const d = new Date(iso);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function writeIcs(events: IcsEvent[], name = 'EMP', stamp = new Date()): string {
  const dtstamp = fmtDate(stamp.toISOString(), false);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EMP//EMP Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(name)}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${dtstamp}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(e.start, true)}`, `DTEND;VALUE=DATE:${fmtDate(addDaysIso(e.end.slice(0, 10) || e.start.slice(0, 10), 1), true)}`);
    } else {
      lines.push(`DTSTART:${fmtDate(e.start, false)}`, `DTEND:${fmtDate(e.end || e.start, false)}`);
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
