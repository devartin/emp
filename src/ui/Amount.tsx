import { cn } from "@/lib/cn";
import { formatMoney, isNegative, moneyParts, toNumber, type Money, type MoneyFormatOptions } from "@/lib/money";
import { Sensitive } from "./Sensitive";

/**
 * Money roles (docs/DESIGN.md §6, Money N-MO4 with the chair's resolutions):
 *   hero  32/38 w600 — one per view. Summaries ≥ 1,000 drop cents; `exact` shows superscript cents (0.55em, raised).
 *   lg    20/26 w500 — secondary figures (replaces KPI cards). Summaries ≥ 1,000 drop cents.
 *   row   14/20 w400 (totals w600) — ledgers: cents full size in tertiary ink.
 *   axis  11/14 w400 tertiary.
 */
export type AmountRole = "hero" | "lg" | "row" | "axis";

export interface AmountProps extends MoneyFormatOptions {
  value: Money;
  /** Typesetting role (size, weight and the cents rule). Omit to inherit the surrounding type. */
  role?: AmountRole;
  /** Row totals set in w600. */
  total?: boolean;
  /** Hero only: an exact balance with superscript cents. */
  exact?: boolean;
  /** Colour by sign (gain/loss). Ordinary expenses are never red: use this for deltas and over-budget amounts only. */
  colored?: boolean;
  /** Dim the fraction digits (ledger style). Default true for `role="row"`. */
  dimCents?: boolean;
  align?: "start" | "end";
  className?: string;
}

/**
 * Money, set like a bank statement: tabular figures, the currency symbol at full size (Intl `narrowSymbol`, never a
 * concatenated "$"), U+2212 before the symbol for negatives, no parentheses. Masked under Hide numbers.
 */
export function Amount({ value, role, total, exact, colored, dimCents, align, className, ...opts }: AmountProps) {
  const neg = isNegative(value);
  const summary = role === "hero" || role === "lg";
  const big = Math.abs(toNumber(value)) >= 1000;
  const fmt: MoneyFormatOptions = { ...opts, noCents: opts.noCents ?? (summary && !exact && big ? true : undefined) };
  const tone = colored ? (neg ? "loss" : Number(value.amount) > 0 ? "gain" : undefined) : undefined;
  const cls = cn(className);
  const data = { className: "emp-amount", "data-role": role, "data-total": total ? "" : undefined, "data-tone": tone } as const;
  const mode = fmt.compact ? "plain" : role === "hero" && exact ? "sup" : (dimCents ?? role === "row") ? "dim" : "plain";
  if (mode !== "plain") {
    const p = moneyParts(value, fmt);
    return (
      <Sensitive align={align} className={cls}>
        <span {...data}>
          {p.sign}
          {p.symbolPosition === "prefix" ? p.symbol : null}
          {p.integer}
          {p.fraction ? (
            <span className={mode === "sup" ? "emp-amount-sup" : "emp-amount-cents"}>
              {/* Superscript cents keep the separator in the DOM (visually hidden) so copy and screen readers get "4,218.37". */}
              {mode === "sup" ? <span className="emp-amount-sep">{p.decimal}</span> : p.decimal}
              {p.fraction}
            </span>
          ) : null}
          {p.symbolPosition === "suffix" ? p.symbol : null}
        </span>
      </Sensitive>
    );
  }
  return (
    <Sensitive align={align} className={cls}>
      <span {...data}>{formatMoney(value, fmt)}</span>
    </Sensitive>
  );
}
