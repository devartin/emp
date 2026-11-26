/**
 * Date helpers (date-fns v4). Display-oriented; Rust owns recurrence and authoritative parsing.
 */
import {
  addDays, differenceInCalendarDays, format as fmt, formatDistanceToNowStrict, getDaysInMonth, isSameDay, isToday, isTomorrow,
  isValid, isYesterday, parseISO, startOfDay, startOfMonth, startOfWeek,
} from "date-fns";

export type DateFormatStyle = "full" | "mdy" | "dmy" | "ymd";

/** Mirrors §11.2 DateValue. */
export interface DateValue {
  start: string;
  end?: string;
  time: boolean;
  tz?: string;
}

let dateStyle: DateFormatStyle = "full";
let clock: 12 | 24 = 12;
let weekStart: 0 | 1 | 6 = 1;

export function setDatePrefs(p: { dateFormat?: DateFormatStyle; clock?: 12 | 24; weekStart?: 0 | 1 | 6 }): void {
  if (p.dateFormat) dateStyle = p.dateFormat;
  if (p.clock) clock = p.clock;
  if (p.weekStart !== undefined) weekStart = p.weekStart;
}
export function getWeekStart(): 0 | 1 | 6 {
  return weekStart;
}

export function toDate(v: Date | string | number): Date {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  // 'YYYY-MM-DD' must be local midnight, not UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return parseISO(v);
}

/** 'YYYY-MM-DD' in local time. */
export function isoDay(d: Date | number = new Date()): string {
  const x = typeof d === "number" ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

export function formatDate(v: Date | string | number, style: DateFormatStyle = dateStyle): string {
  const d = toDate(v);
  if (!isValid(d)) return "—";
  switch (style) {
    case "mdy": return fmt(d, "MM/dd/yyyy");
    case "dmy": return fmt(d, "dd/MM/yyyy");
    case "ymd": return fmt(d, "yyyy-MM-dd");
    default: return fmt(d, d.getFullYear() === new Date().getFullYear() ? "MMM d" : "MMM d, yyyy");
  }
}

export function formatTime(v: Date | string | number): string {
  const d = toDate(v);
  if (!isValid(d)) return "—";
  return clock === 24 ? fmt(d, "HH:mm") : fmt(d, d.getMinutes() === 0 ? "h a" : "h:mm a");
}

export function formatDateTime(v: Date | string | number): string {
  return `${formatDate(v)} ${formatTime(v)}`;
}

/** "Today", "Tomorrow", "Yesterday", weekday within ±6 days, else formatDate. */
export function formatDayLabel(v: Date | string | number, now: Date = new Date()): string {
  const d = toDate(v);
  if (!isValid(d)) return "—";
  if (isToday(d)) return "Today";
  if (isTomorrow(d)) return "Tomorrow";
  if (isYesterday(d)) return "Yesterday";
  const diff = differenceInCalendarDays(d, now);
  if (diff > 0 && diff < 7) return fmt(d, "EEEE");
  if (diff < 0 && diff > -7) return "Last " + fmt(d, "EEEE");
  return formatDate(d);
}

export function formatDateValue(v: DateValue): string {
  const start = v.time ? `${formatDayLabel(v.start)} ${formatTime(v.start)}` : formatDayLabel(v.start);
  if (!v.end) return start;
  const end = v.time ? (isSameDay(toDate(v.start), toDate(v.end)) ? formatTime(v.end) : `${formatDayLabel(v.end)} ${formatTime(v.end)}`) : formatDayLabel(v.end);
  return `${start} → ${end}`;
}

/** "just now", "2m ago", "3h ago", "Mar 4". */
export function formatRelative(v: Date | string | number, now: number = Date.now()): string {
  const d = toDate(v);
  const ms = now - d.getTime();
  if (ms < 45_000 && ms > -45_000) return "just now";
  if (ms > 0 && ms < 86_400_000 * 7) {
    const s = formatDistanceToNowStrict(d, { roundingMethod: "floor" });
    const [n, unit] = s.split(" ");
    const short = unit.startsWith("second") ? "s" : unit.startsWith("minute") ? "m" : unit.startsWith("hour") ? "h" : "d";
    return `${n}${short} ago`;
  }
  return formatDate(d);
}

/** Fraction of the month elapsed (budget pace marker, §5.10). */
export function monthProgress(now: Date = new Date()): number {
  return now.getDate() / getDaysInMonth(now);
}

export function daysInMonth(d: Date = new Date()): number {
  return getDaysInMonth(d);
}

/** 6×7 grid of days for a month view starting on the configured week start. */
export function monthGrid(month: Date, ws: 0 | 1 | 6 = weekStart): Date[] {
  const first = startOfWeek(startOfMonth(month), { weekStartsOn: ws });
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export { startOfDay, isSameDay, isToday };
