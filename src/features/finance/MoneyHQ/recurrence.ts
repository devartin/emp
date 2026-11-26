/** Client-side expansion of the RRULE subset Money HQ writes (FREQ, INTERVAL, BYDAY, BYMONTHDAY) — display only. */

const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function diff(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
}

export function parseRule(rrule: string): { freq: string; interval: number; byday?: number; bymonthday?: number } {
  const parts = Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((p) => p.split("="))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]),
  );
  return { freq: parts.FREQ ?? "MONTHLY", interval: Math.max(1, Number(parts.INTERVAL) || 1), byday: parts.BYDAY ? BYDAY[parts.BYDAY.split(",")[0]] : undefined, bymonthday: Number(parts.BYMONTHDAY) || undefined };
}

export function occurrences(rrule: string, dtstart: string, from: string, to: string, cap = 400): string[] {
  const r = parseRule(rrule);
  const out: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dtstart)) return out;
  if (r.freq === "WEEKLY" || r.freq === "DAILY") {
    const step = r.freq === "DAILY" ? r.interval : 7 * r.interval;
    let d = dtstart;
    if (r.freq === "WEEKLY" && r.byday !== undefined) while (new Date(`${d}T12:00:00`).getDay() !== r.byday) d = addDays(d, 1);
    if (d < from) d = addDays(d, Math.floor(diff(d, from) / step) * step);
    for (; d <= to && out.length < cap; d = addDays(d, step)) if (d >= from) out.push(d);
    return out;
  }
  const months = r.freq === "YEARLY" ? 12 * r.interval : r.interval;
  const dom = r.bymonthday ?? Number(dtstart.slice(8, 10));
  const start = new Date(`${dtstart.slice(0, 7)}-01T12:00:00`);
  for (let k = 0; k < 2400 && out.length < cap; k += months) {
    const d = new Date(start.getFullYear(), start.getMonth() + k, 1, 12);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dom, last));
    const s = iso(d);
    if (s > to) break;
    if (s >= from && s >= dtstart) out.push(s);
  }
  return out;
}

export function nextDue(rrule: string, dtstart: string, after: string): string | null {
  return occurrences(rrule, dtstart, after, addDays(after, 800), 1)[0] ?? null;
}

/** Monthly-equivalent multiplier for a schedule. */
export function perMonth(rrule: string): number {
  const r = parseRule(rrule);
  switch (r.freq) {
    case "DAILY":
      return 30.44 / r.interval;
    case "WEEKLY":
      return 4.345 / r.interval;
    case "YEARLY":
      return 1 / (12 * r.interval);
    default:
      return 1 / r.interval;
  }
}

export function cadenceLabel(rrule: string): string {
  const r = parseRule(rrule);
  if (r.freq === "WEEKLY") return r.interval === 2 ? "Every 2 weeks" : r.interval === 1 ? "Weekly" : `Every ${r.interval} weeks`;
  if (r.freq === "MONTHLY") return r.interval === 3 ? "Quarterly" : r.interval === 1 ? "Monthly" : `Every ${r.interval} months`;
  if (r.freq === "YEARLY") return "Yearly";
  return r.interval === 1 ? "Daily" : `Every ${r.interval} days`;
}
