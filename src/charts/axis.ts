/** Shared axis/format helpers for Recharts wrappers (§13.5). */
import { createElement } from "react";
import { formatCompact, formatNumber, formatPercent, niceTicks } from "@/lib/format";
import type { ChartTheme } from "./theme";

export type ValueFormat = "money" | "number" | "percent" | ((n: number) => string);

export const MARGIN = { top: 8, right: 0, bottom: 0, left: 0 } as const;
export const X_AXIS_HEIGHT = 24;
export const MASK = "•••";

/** Compact tick formatter ($12.4k, 4.2%), masked under Hide numbers. */
export function tickFormatter(kind: ValueFormat, currency = "USD", privacy = false): (n: number) => string {
  if (privacy) return () => MASK;
  if (typeof kind === "function") return kind;
  if (kind === "money") return (n) => formatCompact(n, { currency });
  if (kind === "percent") return (n) => formatCompact(n, { percent: true });
  return (n) => formatCompact(n);
}

/** Full-precision formatter for tooltips / readouts. */
export function valueFormatter(kind: ValueFormat, currency = "USD"): (n: number) => string {
  if (typeof kind === "function") return kind;
  if (kind === "money") {
    return (n) => {
      const abs = Math.abs(n);
      const s = formatNumber(abs, { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: abs >= 1000 ? 0 : 2, minimumFractionDigits: abs >= 1000 ? 0 : 2 });
      return (n < 0 ? "−" : "") + s;
    };
  }
  if (kind === "percent") return (n) => formatPercent(n, { digits: 1 });
  return (n) => formatNumber(n, { maximumFractionDigits: 2 });
}

/** 4–5 nice ticks covering the values (optionally including zero). */
export function niceDomain(values: readonly number[], opts: { includeZero?: boolean; count?: number } = {}): { domain: [number, number]; ticks: number[] } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { domain: [0, 1], ticks: [0, 1] };
  if (opts.includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const ticks = niceTicks(lo, hi, opts.count ?? 5);
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}

export function tickStyle(t: ChartTheme) {
  return { fontSize: 11, fill: t.textTertiary, fontFamily: t.fontFamily } as const;
}

/** Hex/rgb(a) → rgba string with alpha (lightweight-charts needs concrete colours). */
export function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const [r, g, b] = m[1].split(",").map((x) => parseFloat(x));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return c;
}

/**
 * X-axis tick that keeps edge labels inside the SVG: a centred label that would spill past the left/right edge is
 * anchored to that edge instead (otherwise "Nov '23" at x=0 is clipped to "ov '23").
 */
export function edgeAwareTick(t: ChartTheme, format: (v: unknown) => string, width: number) {
  const style = tickStyle(t);
  return function EdgeTick(p: { x?: number | string; y?: number | string; payload?: { value?: unknown }; visibleTicksCount?: number }) {
    const label = format(p.payload?.value);
    const half = (label.length * style.fontSize * 0.56) / 2;
    const spacing = width / Math.max(1, p.visibleTicksCount ?? 1);
    // Room to slide the label inward before it would collide with its neighbour.
    const room = spacing - 2 * half - 6;
    let x = Number(p.x ?? 0);
    let anchor: "start" | "middle" | "end" = "middle";
    if (x - half < 0) {
      if (half - x > room) return createElement("g");
      anchor = "start";
      x = 0;
    } else if (x + half > width) {
      if (x + half - width > room) return createElement("g");
      anchor = "end";
      x = width;
    }
    return createElement("text", { x, y: Number(p.y ?? 0), dy: "0.71em", textAnchor: anchor, ...style }, label);
  };
}
