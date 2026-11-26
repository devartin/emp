/** Accessible summaries for charts (§13.5 "aria summary"). */

const ISO = /^(\d{4})-(\d{2})(?:-(\d{2}))?/;

/**
 * "from <a> to <b>" for a series' x range. ISO dates are written out with the parts the range needs (DESIGN v3 §6.2:
 * date ranges carry years when they cross a year boundary): daily data keeps the day, a range across years names both
 * years, and two identical labels never appear. Anything else falls back to the chart's own axis format.
 */
export function spanLabel(first: unknown, last: unknown, fallback: (v: unknown) => string): string {
  const a = ISO.exec(String(first ?? ""));
  const b = ISO.exec(String(last ?? ""));
  if (!a || !b) {
    const fa = fallback(first);
    const fb = fallback(last);
    return fa && fb ? (fa === fb ? fa : `${fa} to ${fb}`) : "";
  }
  const daily = !!(a[3] && b[3]);
  const crossYear = a[1] !== b[1];
  const date = (m: RegExpExecArray) => new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1));
  const opts = (withYear: boolean): Intl.DateTimeFormatOptions => ({ month: "short", ...(daily ? { day: "numeric" } : {}), ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
  const fb = new Intl.DateTimeFormat(undefined, opts(true)).format(date(b));
  // One point in time (the same day, or the same month for monthly data) is one date, never "Nov 26 to Nov 26".
  if (a[1] === b[1] && a[2] === b[2] && (!daily || a[3] === b[3])) return fb;
  const fa = new Intl.DateTimeFormat(undefined, opts(crossYear)).format(date(a));
  return `${fa} to ${fb}`;
}
export function summarizeSeries(label: string, values: readonly number[], fmt: (n: number) => string, xFirst?: string, xLast?: string, span?: string): string {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return `${label}: not enough data.`;
  const first = v[0];
  const last = v[v.length - 1];
  const min = Math.min(...v);
  const max = Math.max(...v);
  const change = first !== 0 ? (last - first) / Math.abs(first) : 0;
  const dir = last > first ? "up" : last < first ? "down" : "flat";
  const range = span !== undefined ? (span ? ` ${span.includes(" to ") ? "from " : "in "}${span}` : "") : xFirst && xLast ? ` from ${xFirst} to ${xLast}` : "";
  return `${label}${range}: ${dir} ${Math.abs(change * 100).toFixed(1)}%, from ${fmt(first)} to ${fmt(last)}. Low ${fmt(min)}, high ${fmt(max)}.`;
}

export function summarizeParts(label: string, parts: readonly { name: string; value: number }[], fmt: (n: number) => string): string {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const top = [...parts].sort((a, b) => b.value - a.value).slice(0, 3);
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "0%");
  return `${label}: total ${fmt(total)}. Largest: ${top.map((p) => `${p.name} ${fmt(p.value)} (${pct(p.value)})`).join(", ")}.`;
}
