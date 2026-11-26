/**
 * Mock-only: deterministic Google Calendar content for the browser preview — what a first sync of a typical personal
 * account returns (`events.list singleEvents=true`, window −90…+365 days, recurring series expanded).
 */
import type { Id } from '@/backend/types';
import type { CalendarRecord, EventRecord } from './googleStore';

const DAY = 86_400_000;

export const SAMPLE_CALENDARS: Omit<CalendarRecord, 'id' | 'accountId'>[] = [
  { calId: 'primary', summary: 'Personal', color: 'blue', primary: true, selected: true },
  { calId: 'work@group.calendar.google.com', summary: 'Work', color: 'purple', primary: false, selected: true },
  { calId: 'family@group.calendar.google.com', summary: 'Family', color: 'green', primary: false, selected: true },
  { calId: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States', color: 'red', primary: false, selected: true },
];

function rnd(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Local wall-clock time on `day` as RFC3339 with the local offset. */
function at(day: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  const dt = new Date(y, mo - 1, d, h, m);
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${day}T${pad(h)}:${pad(m)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
function addMin(hhmm: string, min: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + min;
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}

/** US federal holidays + a few observances for the given years. */
function holidays(years: number[]): [string, string][] {
  const out: [string, string][] = [];
  const nth = (y: number, month: number, dow: number, n: number) => {
    const first = new Date(y, month, 1).getDay();
    return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  };
  const last = (y: number, month: number, dow: number) => {
    const lastDay = new Date(y, month + 1, 0);
    return lastDay.getDate() - ((lastDay.getDay() - dow + 7) % 7);
  };
  for (const y of years) {
    const d = (m: number, day: number) => `${y}-${pad(m + 1)}-${pad(day)}`;
    out.push([d(0, 1), 'New Year’s Day'], [d(0, nth(y, 0, 1, 3)), 'Martin Luther King Jr. Day'], [d(1, nth(y, 1, 1, 3)), 'Presidents’ Day'], [d(1, 14), 'Valentine’s Day']);
    out.push([d(4, last(y, 4, 1)), 'Memorial Day'], [d(5, 19), 'Juneteenth'], [d(6, 4), 'Independence Day'], [d(8, nth(y, 8, 1, 1)), 'Labor Day']);
    out.push([d(9, nth(y, 9, 1, 2)), 'Columbus Day'], [d(9, 31), 'Halloween'], [d(10, 11), 'Veterans Day'], [d(10, nth(y, 10, 4, 4)), 'Thanksgiving Day']);
    out.push([d(11, 24), 'Christmas Eve'], [d(11, 25), 'Christmas Day'], [d(11, 31), 'New Year’s Eve']);
  }
  return out;
}

export function sampleEvents(input: { accountId: Id; now: number; newId: () => Id; calendars: { calId: string }[] }): EventRecord[] {
  const r = rnd(1126);
  const out: EventRecord[] = [];
  const today = new Date(input.now);
  const startMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const has = (id: string) => input.calendars.some((c) => c.calId === id);
  const push = (calId: string, title: string, day: string, start: string | null, end: string | null, extra: Partial<EventRecord> = {}) => {
    if (!has(calId)) return;
    out.push({
      id: input.newId(),
      accountId: input.accountId,
      calId,
      title,
      start: start ? at(day, start) : day,
      end: end ? at(day, end) : day,
      allDay: !start,
      recurring: false,
      ...extra,
    });
  };
  const WORK = 'work@group.calendar.google.com';
  const FAM = 'family@group.calendar.google.com';
  for (let i = -60; i <= 120; i++) {
    const ms = startMs + i * DAY;
    const day = localDay(ms);
    const dow = new Date(ms).getDay();
    const weekday = dow >= 1 && dow <= 5;
    if (weekday && !(i >= 0 && i <= 0 && false)) {
      push(WORK, 'Daily stand-up', day, '09:30', '09:45', { recurring: true, location: 'Meet', description: 'Yesterday · today · blockers' });
      if (dow === 2) push(WORK, '1:1 with Maya', day, '14:00', '14:30', { recurring: true, location: 'Meet' });
      if (dow === 3) push(WORK, 'Design review', day, '11:00', '12:00', { recurring: true, location: 'Room 4B' });
      if (dow === 4) push(WORK, 'Website relaunch sync', day, '15:30', '16:15', { recurring: true });
      if (dow === 5) push(WORK, 'Team lunch', day, '12:30', '13:30', { recurring: true, location: 'Osteria Lumen' });
      if (r() < 0.18) {
        const startH = ['10:30', '13:00', '16:00'][Math.floor(r() * 3)];
        push(WORK, ['Customer interview', 'Roadmap planning', 'Hiring panel', 'Analytics deep-dive', 'Copy review'][Math.floor(r() * 5)], day, startH, addMin(startH, 45));
      }
    }
    if (dow === 6) push('primary', 'Long run', day, '08:00', '09:30', { recurring: true, location: 'Riverside loop' });
    if (dow === 2 || dow === 4) push('primary', 'Climbing gym', day, '18:30', '20:00', { recurring: true, location: 'Granite Works' });
    if (dow === 0) push(FAM, 'Call Mom', day, '17:00', '17:30', { recurring: true });
    if (dow === 0 && Math.abs(i) % 14 === 0) push(FAM, 'Family dinner', day, '18:30', '21:00', { location: 'Grandma’s' });
  }
  const one = (offset: number, cal: string, title: string, s: string | null, e: string | null, extra: Partial<EventRecord> = {}) => push(cal, title, localDay(startMs + offset * DAY), s, e, extra);
  one(0, 'primary', 'Thanksgiving dinner', '16:00', '20:00', { location: 'Sam & Jordan’s' });
  one(1, 'primary', 'Dinner with Sam', '19:30', '21:30', { location: 'Pho 88' });
  one(2, 'primary', 'Dentist check-up', '10:00', '10:45', { location: 'Bright Smile Dental' });
  one(3, FAM, 'Lena’s birthday', null, null);
  one(5, 'primary', 'Haircut', '11:00', '11:45');
  one(8, 'primary', 'Concert — Lumen Quartet', '20:00', '22:00', { location: 'City Hall' });
  one(12, WORK, 'Website launch 🚀', null, null);
  one(12, WORK, 'Launch go/no-go', '10:00', '10:30');
  one(16, 'primary', 'Book club', '19:00', '20:30', { location: 'Blue Door Coffee' });
  one(21, FAM, 'Holiday party', '18:00', '22:00');
  one(-3, 'primary', 'Physio session', '08:30', '09:15');
  one(-6, FAM, 'Kids’ school play', '17:30', '19:00');
  one(-12, 'primary', 'Car service', '09:00', '10:00');
  // multi-day trip
  const tripStart = localDay(startMs + 109 * DAY);
  const tripEnd = localDay(startMs + 115 * DAY);
  if (has('primary')) out.push({ id: input.newId(), accountId: input.accountId, calId: 'primary', title: 'Lisbon trip ✈️', start: tripStart, end: tripEnd, allDay: true, recurring: false, location: 'Lisbon, Portugal' });
  const years = [today.getFullYear(), today.getFullYear() + 1];
  for (const [day, title] of holidays(years)) {
    const t = new Date(`${day}T12:00:00`).getTime();
    if (t < startMs - 90 * DAY || t > startMs + 365 * DAY) continue;
    push('en.usa#holiday@group.v.calendar.google.com', title, day, null, null);
  }
  return out;
}
