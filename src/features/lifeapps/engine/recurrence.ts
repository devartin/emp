/**
 * Minimal RRULE stepping for the common life-app rules (§15.8): FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL,
 * BYDAY (incl. "1SA" ordinals for monthly) and BYMONTHDAY. Days are 'YYYY-MM-DD' (UTC calendar).
 */
const DAY = 86_400_000;
const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parse(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rrule.replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v) out[k.toUpperCase()] = v.toUpperCase();
  }
  return out;
}

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function matches(r: Record<string, string>, t: number): boolean {
  const d = new Date(t);
  const byday = r.BYDAY?.split(',').filter(Boolean) ?? [];
  const bymd = r.BYMONTHDAY?.split(',').map(Number).filter(Number.isFinite) ?? [];
  if (bymd.length) {
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    if (!bymd.some((n) => (n > 0 ? Math.min(n, dim) : dim + n + 1) === d.getUTCDate())) return false;
  }
  if (byday.length) {
    const ok = byday.some((code) => {
      const m = /^(-?\d+)?([A-Z]{2})$/.exec(code);
      if (!m) return false;
      if (CODES.indexOf(m[2]) !== d.getUTCDay()) return false;
      if (!m[1]) return true;
      const n = Number(m[1]);
      const nth = Math.ceil(d.getUTCDate() / 7);
      if (n > 0) return nth === n;
      const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return Math.ceil((dim - d.getUTCDate() + 1) / 7) === -n;
    });
    if (!ok) return false;
  }
  return true;
}

/** The first occurrence strictly after `after` (null if none within 3 years). */
export function nextOccurrence(rrule: string, after: string): string | null {
  const r = parse(rrule);
  const freq = r.FREQ ?? 'DAILY';
  const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
  const start = ms(after);
  if (!Number.isFinite(start)) return null;
  const hasBy = !!(r.BYDAY || r.BYMONTHDAY);
  if (!hasBy) {
    const d = new Date(start);
    if (freq === 'DAILY') return iso(start + interval * DAY);
    if (freq === 'WEEKLY') return iso(start + interval * 7 * DAY);
    if (freq === 'MONTHLY') return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + interval, d.getUTCDate()));
    if (freq === 'YEARLY') return iso(Date.UTC(d.getUTCFullYear() + interval, d.getUTCMonth(), d.getUTCDate()));
  }
  for (let i = 1; i <= 366 * 3; i++) {
    const t = start + i * DAY;
    if (!matches(r, t)) continue;
    if (interval > 1 && freq === 'WEEKLY' && Math.floor((t - start) / (7 * DAY)) % interval !== 0) continue;
    return iso(t);
  }
  return null;
}

/** Up to `count` occurrences after `after`. */
export function occurrences(rrule: string, after: string, count: number): string[] {
  const out: string[] = [];
  let cur = after;
  for (let i = 0; i < count; i++) {
    const n = nextOccurrence(rrule, cur);
    if (!n) break;
    out.push(n);
    cur = n;
  }
  return out;
}

const DAY_NAMES: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const SHORT: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

/** "Every weekday", "Every Friday", "First Saturday of the month", "Monthly on the 1st" … */
export function describeRRule(rrule: string): string {
  const r = parse(rrule);
  const freq = r.FREQ ?? 'DAILY';
  const days = r.BYDAY?.split(',').filter(Boolean) ?? [];
  if (freq === 'DAILY' && !days.length) return Number(r.INTERVAL ?? 1) > 1 ? `Every ${r.INTERVAL} days` : 'Every day';
  if ((freq === 'DAILY' || freq === 'WEEKLY') && days.length) {
    if (days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.includes(d))) return 'Every weekday';
    if (days.length === 7) return 'Every day';
    if (days.length === 1) return `Every ${DAY_NAMES[days[0]] ?? days[0]}`;
    return `Every ${days.map((d) => SHORT[d] ?? d).join(', ')}`;
  }
  if (freq === 'MONTHLY') {
    const m = /^(-?\d)([A-Z]{2})$/.exec(days[0] ?? '');
    if (m) {
      const ord = ({ '1': 'First', '2': 'Second', '3': 'Third', '4': 'Fourth', '-1': 'Last' } as Record<string, string>)[m[1]] ?? m[1];
      return `${ord} ${DAY_NAMES[m[2]] ?? m[2]} of the month`;
    }
    if (r.BYMONTHDAY) {
      const n = Number(r.BYMONTHDAY);
      const sfx = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
      return `Monthly on the ${n}${sfx}`;
    }
    return 'Every month';
  }
  if (freq === 'WEEKLY') return Number(r.INTERVAL ?? 1) > 1 ? `Every ${r.INTERVAL} weeks` : 'Every week';
  if (freq === 'YEARLY') return 'Every year';
  return 'Repeats';
}
