import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";
import { Delta } from "./Delta";

export interface DeltaPillProps {
  /** The change. With `format="percent"` it is a fraction (0.042 → 4.2%). */
  value: number;
  format?: "percent" | ((v: number) => string);
  /** Up is bad (expenses, debt): colours swap meaning, the arrow stays truthful. */
  invert?: boolean;
  /** Trailing comparison text, e.g. "vs last month". */
  label?: ReactNode;
  /** @deprecated there is no pill any more; accepted and ignored. */
  plain?: boolean;
  className?: string;
  digits?: number;
}

/**
 * @deprecated use <Delta> (docs/DESIGN.md §6.4). DeltaPill keeps its API but renders text only, through Delta:
 * "↗ 4.2% vs last month". No pill, no fill, no icon. New code should import Delta (the style ratchet counts
 * DeltaPill imports and they may only fall).
 */
export function DeltaPill({ value, format = "percent", invert, label, className, digits = 1 }: DeltaPillProps) {
  const dir = !Number.isFinite(value) || Math.abs(value) < 1e-12 ? "flat" : value > 0 ? "up" : "down";
  const text = typeof format === "function" ? format(value) : formatPercent(Math.abs(value), { digits });
  return <Delta text={text} dir={dir} invert={invert} label={label} className={cn(className)} />;
}

/** Inline signed value coloured by gain/loss (tables, tickers). */
export function GainLoss({ value, children, invert, className }: { value: number; children: ReactNode; invert?: boolean; className?: string }) {
  const up = value > 0 !== !!invert;
  return <span className={cn(value === 0 ? "text-secondary" : up ? "emp-gain" : "emp-loss", "tabular", className)}>{children}</span>;
}
