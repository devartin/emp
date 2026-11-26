import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatMoney, type Money } from "@/lib/money";
import { formatPercent } from "@/lib/format";

const MINUS = "−";

export interface DeltaProps {
  /** An amount change ("↗ $1,342"). */
  money?: Money;
  /** A relative change as a fraction (0.046 → "4.6%"). Shown in brackets after `money`, or alone. */
  percent?: number;
  /** A difference between two rates, in percentage points (1.2 → "1.2 pts"). Never mix with `percent`. */
  points?: number;
  /** Pre-formatted text (the sign / direction still comes from `dir`). */
  text?: string;
  /** Direction when only `text` is given. */
  dir?: "up" | "down" | "flat";
  /** Up is bad (spending, debt): colours swap meaning; the arrow stays truthful. */
  invert?: boolean;
  /** Decimals for percent / points (returns 1, drift and tax rates 0). */
  digits?: number;
  /** Comparison label in secondary ink, e.g. "vs last month". */
  label?: ReactNode;
  /** Arrow glyph (↗ / ↘) instead of a +/− sign. Default true. */
  arrow?: boolean;
  className?: string;
}

function direction(n: number | undefined): "up" | "down" | "flat" {
  if (n === undefined || !Number.isFinite(n) || Math.abs(n) < 1e-12) return "flat";
  return n > 0 ? "up" : "down";
}

/**
 * Delta — a change written as text (docs/DESIGN.md §6.4): "↗ $1,342 (4.6%) vs last month". No pill, no fill, no icon.
 * Gain / loss colour appears only here and on over-budget amounts. Rate differences are written in points.
 */
export function Delta({ money, percent, points, text, dir, invert, digits = 1, label, arrow = true, className }: DeltaProps) {
  const lead = money ? Number(money.amount) : points ?? percent;
  const d = dir ?? direction(lead);
  const good = d === "flat" ? undefined : (d === "up") !== !!invert ? "up" : "down";
  const abs = (n: number) => Math.abs(n);
  const signed = (s: string, n: number) => (arrow ? s : (n > 0 ? "+" : n < 0 ? MINUS : "") + s);
  const parts: string[] = [];
  if (text !== undefined) parts.push(text);
  if (money) {
    const a = abs(Number(money.amount));
    // Summaries of 1,000 or more drop cents (never mix 0 and 2 decimals in one line).
    parts.push(signed(formatMoney({ ...money, amount: String(a) }, { noCents: a >= 1000 }), Number(money.amount)));
  }
  if (points !== undefined && Number.isFinite(points)) parts.push(signed(`${abs(points).toFixed(digits)} pts`, points));
  else if (percent !== undefined && Number.isFinite(percent)) {
    const p = signed(formatPercent(abs(percent), { digits }), percent);
    parts.push(parts.length ? `(${p})` : p);
  }
  const up = d === "up";
  const Arrow = arrow && d !== "flat" ? (up ? ArrowUpRight : ArrowDownRight) : null;
  // The arrow is drawn (the UI face's subsets carry no U+2197 / U+2198, and a fallback font would set it in another
  // weight). Copied and spoken text is plain words: "Down 2.8% vs last month".
  return (
    <span className={cn("emp-delta", className)} data-dir={good} data-sensitive="">
      <span>
        {Arrow ? (
          <>
            <Arrow className="emp-delta-arrow" size="0.85em" absoluteStrokeWidth strokeWidth={1.5} aria-hidden focusable={false} />
            <span className="sr-only">{up ? "Up" : "Down"}</span>{" "}
          </>
        ) : null}
        {parts.join(" ")}
      </span>
      {label ? (
        <>
          {" "}
          <span className="emp-delta-label">{label}</span>
        </>
      ) : null}
    </span>
  );
}
