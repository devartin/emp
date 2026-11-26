import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";

export interface DeltaPillProps {
  /** The change. With `format="percent"` it is a fraction (0.042 → +4.2%). */
  value: number;
  format?: "percent" | ((v: number) => string);
  /** Up is bad (expenses, debt): colours swap meaning, sign stays truthful. */
  invert?: boolean;
  /** Trailing comparison text, e.g. "vs last month" (tertiary, outside the pill). */
  label?: ReactNode;
  /** No pill background (inline table use). */
  plain?: boolean;
  className?: string;
  digits?: number;
}

/**
 * Delta pill (docs/DESIGN.md §6.3): 20px, a gain/loss soft face with a 1px rim at 30% and an inset top highlight; the
 * 12px arrow nudges on change; arrow-up-right /
 * arrow-down-right; always signed with "+" or U+2212.
 */
export function DeltaPill({ value, format = "percent", invert, label, plain, className, digits = 1 }: DeltaPillProps) {
  const dir = !Number.isFinite(value) || Math.abs(value) < 1e-12 ? "flat" : value > 0 ? "up" : "down";
  const good = dir === "flat" ? "flat" : (dir === "up") !== !!invert ? "up" : "down";
  const text =
    typeof format === "function"
      ? format(value)
      : formatPercent(value, { digits, signed: true });
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  // The arrow nudges y ∓1px when the value changes (not on mount).
  const [nudge, setNudge] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) setNudge((n) => n + 1);
    prev.current = value;
  }, [value]);
  const pill = (
    <span className={cn("emp-delta", !label && className)} data-dir={good === "flat" ? undefined : good} data-plain={plain ? "" : undefined} data-sensitive="">
      <span key={nudge} className="emp-delta-arrow" data-nudge={nudge ? "" : undefined}>
        <Icon aria-hidden />
      </span>
      <span>{text}</span>
    </span>
  );
  if (!label) return pill;
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0", className)}>
      {pill}
      <span className="text-caption text-tertiary truncate" style={{ fontWeight: 400 }}>
        {label}
      </span>
    </span>
  );
}

/** Inline signed value coloured by gain/loss (tables, tickers). */
export function GainLoss({ value, children, invert, className }: { value: number; children: ReactNode; invert?: boolean; className?: string }) {
  const up = value > 0 !== !!invert;
  return <span className={cn(value === 0 ? "text-secondary" : up ? "emp-gain" : "emp-loss", "tabular", className)}>{children}</span>;
}
