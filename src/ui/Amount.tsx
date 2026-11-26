import { cn } from "@/lib/cn";
import { formatMoney, isNegative, moneyParts, type Money, type MoneyFormatOptions } from "@/lib/money";
import { Sensitive } from "./Sensitive";

export interface AmountProps extends MoneyFormatOptions {
  value: Money;
  /** Colour by sign (gain/loss). */
  colored?: boolean;
  /** Dim the fraction digits. */
  dimCents?: boolean;
  align?: "start" | "end";
  className?: string;
}

/** Money display: tabular, U+2212 negatives, optional gain/loss colour, masked under Hide numbers. */
export function Amount({ value, colored, dimCents, align, className, ...opts }: AmountProps) {
  const neg = isNegative(value);
  const cls = cn("tabular whitespace-nowrap", colored && (neg ? "emp-loss" : Number(value.amount) > 0 ? "emp-gain" : undefined), className);
  if (dimCents && !opts.compact) {
    const p = moneyParts(value, opts);
    return (
      <Sensitive align={align} className={cls}>
        {p.sign}
        {p.symbolPosition === "prefix" ? p.symbol : null}
        {p.integer}
        {p.fraction ? (
          <span className="text-tertiary">
            {p.decimal}
            {p.fraction}
          </span>
        ) : null}
        {p.symbolPosition === "suffix" ? p.symbol : null}
      </Sensitive>
    );
  }
  return (
    <Sensitive align={align} className={cls}>
      {formatMoney(value, opts)}
    </Sensitive>
  );
}
