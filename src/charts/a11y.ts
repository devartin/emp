/** Accessible summaries for charts (§13.5 "aria summary"). */
export function summarizeSeries(label: string, values: readonly number[], fmt: (n: number) => string, xFirst?: string, xLast?: string): string {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return `${label}: not enough data.`;
  const first = v[0];
  const last = v[v.length - 1];
  const min = Math.min(...v);
  const max = Math.max(...v);
  const change = first !== 0 ? (last - first) / Math.abs(first) : 0;
  const dir = last > first ? "up" : last < first ? "down" : "flat";
  const span = xFirst && xLast ? ` from ${xFirst} to ${xLast}` : "";
  return `${label}${span}: ${dir} ${Math.abs(change * 100).toFixed(1)}%, from ${fmt(first)} to ${fmt(last)}. Low ${fmt(min)}, high ${fmt(max)}.`;
}

export function summarizeParts(label: string, parts: readonly { name: string; value: number }[], fmt: (n: number) => string): string {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const top = [...parts].sort((a, b) => b.value - a.value).slice(0, 3);
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "0%");
  return `${label}: total ${fmt(total)}. Largest: ${top.map((p) => `${p.name} ${fmt(p.value)} (${pct(p.value)})`).join(", ")}.`;
}
