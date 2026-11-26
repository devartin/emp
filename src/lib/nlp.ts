/**
 * Natural-language date parsing for LIVE CHIPS ONLY (§15.8). Rust `nlp_dates::parse` is authoritative.
 * Supports "today", "tomorrow", "next fri", "in 3 weeks", "Dec 3 3pm", "eom", "every weekday",
 * "every 2 weeks", "for 45m", plus tokens `#tag` and `!high|!med|!low`.
 */
import * as chrono from "chrono-node";
import { endOfMonth } from "date-fns";

export type Priority = "high" | "med" | "low";
export interface Recurrence {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  byDay?: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[];
}
export interface NlpSpan {
  index: number;
  length: number;
  kind: "date" | "recurrence" | "duration" | "tag" | "priority";
}
export interface NlpResult {
  /** Text with recognised tokens removed and whitespace collapsed. */
  title: string;
  start?: Date;
  end?: Date;
  hasTime: boolean;
  recurrence?: Recurrence;
  durationMinutes?: number;
  tags: string[];
  priority?: Priority;
  spans: NlpSpan[];
}

const DAYS: Record<string, NonNullable<Recurrence["byDay"]>[number]> = {
  mon: "MO", monday: "MO", tue: "TU", tues: "TU", tuesday: "TU", wed: "WE", wednesday: "WE", thu: "TH", thur: "TH", thurs: "TH",
  thursday: "TH", fri: "FR", friday: "FR", sat: "SA", saturday: "SA", sun: "SU", sunday: "SU",
};

export function parseNatural(input: string, ref: Date = new Date()): NlpResult {
  const spans: NlpSpan[] = [];
  const tags: string[] = [];
  let priority: Priority | undefined;
  let recurrence: Recurrence | undefined;
  let durationMinutes: number | undefined;
  let start: Date | undefined;
  let end: Date | undefined;
  let hasTime = false;

  const take = (re: RegExp, kind: NlpSpan["kind"], fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input))) {
      spans.push({ index: m.index, length: m[0].length, kind });
      fn(m);
    }
  };

  take(/(^|\s)#([\p{L}\p{N}_-]+)/gu, "tag", (m) => tags.push(m[2]));
  take(/(^|\s)!(high|med|medium|low)\b/gi, "priority", (m) => {
    const p = m[2].toLowerCase();
    priority = p === "medium" ? "med" : (p as Priority);
  });
  take(/\bfor (\d+(?:\.\d+)?)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/gi, "duration", (m) => {
    const n = parseFloat(m[1]);
    durationMinutes = Math.round(m[2].toLowerCase().startsWith("h") ? n * 60 : n);
  });
  take(/\bevery\s+(?:(\d+)\s+)?(day|days|week|weeks|month|months|year|years|weekday|weekdays|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi, "recurrence", (m) => {
    const interval = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
    const unit = m[2].toLowerCase();
    if (unit.startsWith("weekday")) recurrence = { freq: "weekly", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] };
    else if (unit.startsWith("day")) recurrence = { freq: "daily", interval };
    else if (unit.startsWith("week")) recurrence = { freq: "weekly", interval };
    else if (unit.startsWith("month")) recurrence = { freq: "monthly", interval };
    else if (unit.startsWith("year")) recurrence = { freq: "yearly", interval };
    else if (DAYS[unit]) recurrence = { freq: "weekly", interval, byDay: [DAYS[unit]] };
  });
  take(/\beom\b/gi, "date", () => {
    start = endOfMonth(ref);
  });

  if (!start) {
    // Mask already-consumed spans so chrono doesn't re-read them.
    const masked = maskSpans(input, spans);
    const results = chrono.parse(masked, ref, { forwardDate: true });
    const r = results[0];
    if (r) {
      start = r.start.date();
      hasTime = r.start.isCertain("hour");
      if (r.end) end = r.end.date();
      spans.push({ index: r.index, length: r.text.length, kind: "date" });
    }
  }
  if (start && durationMinutes && !end) end = new Date(start.getTime() + durationMinutes * 60_000);

  const title = maskSpans(input, spans).replace(/\s+/g, " ").trim();
  spans.sort((a, b) => a.index - b.index);
  return { title, start, end, hasTime, recurrence, durationMinutes, tags, priority, spans };
}

function maskSpans(s: string, spans: NlpSpan[]): string {
  let out = s;
  for (const sp of [...spans].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, sp.index) + " ".repeat(sp.length) + out.slice(sp.index + sp.length);
  }
  return out;
}

/** Human label for a recurrence ("Every weekday", "Every 2 weeks on Mon"). */
export function describeRecurrence(r: Recurrence): string {
  if (r.byDay && r.byDay.join() === "MO,TU,WE,TH,FR") return "Every weekday";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  const base = r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`;
  if (r.byDay?.length) {
    const names = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
    return `${base} on ${r.byDay.map((d) => names[d]).join(", ")}`;
  }
  return base;
}
