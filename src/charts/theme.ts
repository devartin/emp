/**
 * Chart theme (§13.5): every colour is read from CSS custom properties on <html> and recomputed when
 * data-theme / data-accent / data-numbers / data-contrast change. Charts never hard-code hex values.
 */
import { useSyncExternalStore } from "react";
import { subscribeRootAttrs } from "@/ui/motion/useReducedEffects";

export interface ChartTheme {
  dark: boolean;
  text: string;
  textSecondary: string;
  textTertiary: string;
  grid: string;
  border: string;
  borderSubtle: string;
  surface1: string;
  surface2: string;
  canvas: string;
  overlay: string;
  accent: string;
  accentSoft: string;
  gain: string;
  loss: string;
  gainSoft: string;
  lossSoft: string;
  warning: string;
  info: string;
  categorical: string[];
  other: string;
  areaTop: number;
  fontFamily: string;
  privacy: boolean;
  reducedMotion: boolean;
}

let cached: ChartTheme | null = null;
let cacheKey = "";

function read(): ChartTheme {
  const root = document.documentElement;
  const key = ["data-theme", "data-accent", "data-numbers", "data-contrast", "data-privacy", "data-motion"].map((a) => root.getAttribute(a)).join("|");
  if (cached && key === cacheKey) return cached;
  const cs = getComputedStyle(root);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const theme = root.getAttribute("data-theme");
  cached = {
    dark: theme === "dark" || theme === "midnight",
    text: v("--text-primary"),
    textSecondary: v("--text-secondary"),
    textTertiary: v("--text-tertiary"),
    grid: v("--chart-grid"),
    border: v("--border"),
    borderSubtle: v("--border-subtle"),
    surface1: v("--bg-surface-1"),
    surface2: v("--bg-surface-2"),
    canvas: v("--bg-canvas"),
    overlay: v("--bg-overlay"),
    accent: v("--accent-solid"),
    accentSoft: v("--accent-soft"),
    gain: v("--gain"),
    loss: v("--loss"),
    gainSoft: v("--gain-soft"),
    lossSoft: v("--loss-soft"),
    warning: v("--warning"),
    info: v("--info"),
    categorical: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--cat-${i}`)),
    other: v("--cat-other"),
    areaTop: parseFloat(v("--chart-area-top")) || 0.22,
    fontFamily: v("--font-ui") || "Inter Variable, sans-serif",
    privacy: root.getAttribute("data-privacy") === "on",
    reducedMotion: root.getAttribute("data-motion") === "reduced",
  };
  cacheKey = key;
  return cached;
}

export function getChartTheme(): ChartTheme {
  return read();
}

/** Subscribe to theme changes; stable object identity until an attribute changes. */
export function useChartTheme(): ChartTheme {
  return useSyncExternalStore(subscribeRootAttrs, read, read);
}

/** Series colour for index i (categorical order, §3.5). */
export function seriesColor(t: ChartTheme, i: number): string {
  return i < 0 ? t.other : t.categorical[i % 8];
}

/** Sequential palette: accent at .12/.28/.48/.70/1 (zero → surface-2). */
export const SEQUENTIAL_ALPHAS = [0.12, 0.28, 0.48, 0.7, 1] as const;
export function sequentialColor(t: ChartTheme, level: number): string {
  if (level <= 0) return t.surface2;
  const a = SEQUENTIAL_ALPHAS[Math.min(SEQUENTIAL_ALPHAS.length - 1, level - 1)];
  return `color-mix(in oklab, ${t.accent} ${a * 100}%, transparent)`;
}

/** Diverging palette: loss 1/.6/.3, surface-2 midpoint, gain .3/.6/1 — `x` in [-1, 1]. */
export function divergingColor(t: ChartTheme, x: number): string {
  if (!Number.isFinite(x) || Math.abs(x) < 0.05) return t.surface2;
  const steps = [0.3, 0.6, 1];
  const a = steps[Math.min(2, Math.floor(Math.abs(x) * 3 - 1e-9))];
  return `color-mix(in oklab, ${x > 0 ? t.gain : t.loss} ${a * 100}%, transparent)`;
}

/** Apply alpha to any CSS colour. */
export function alpha(color: string, a: number): string {
  return `color-mix(in oklab, ${color} ${Math.round(a * 1000) / 10}%, transparent)`;
}

/** Resolve `var(--token)` strings to concrete colours (SVG presentation attributes can't use var()). */
export function resolveColor(c: string | undefined): string | undefined {
  if (!c || !c.startsWith("var(")) return c;
  const m = /var\((--[\w-]+)/.exec(c);
  if (!m || typeof document === "undefined") return c;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || c;
}
