import { currencySymbol } from "@/lib/format";
import { selectBaseCurrency, useSettings } from "@/stores/settings";
import { currencyDecimals, formatMoney, parseMoneyInput } from "@/lib/money";
import { NumberField, type NumberFieldProps } from "./NumberField";

export interface MoneyFieldProps extends Omit<NumberFieldProps, "value" | "onChange" | "onCommit" | "format" | "parse" | "prefix"> {
  /** Decimal string amount (scale ≤ 8) or null. */
  value: string | null;
  /** Live per keystroke (parsed) and again on commit; see NumberField. */
  onChange: (amount: string | null) => void;
  /** Commit only (blur, Enter, steps): use it for writes that persist. */
  onCommit?: (amount: string | null) => void;
  /** ISO 4217 code. Defaults to the workspace base currency (Settings, General). */
  currency?: string;
}

/**
 * Money input (§5.2): NumberField semantics with currency symbol prefix and currency-precision formatting.
 * Emits decimal strings (never floats) so values round-trip to Rust losslessly.
 */
export function MoneyField({ value, onChange, onCommit, currency: currencyProp, ...rest }: MoneyFieldProps) {
  const base = useSettings(selectBaseCurrency);
  const currency = currencyProp ?? base;
  const digits = currencyDecimals(currency);
  const num = value === null || value === "" ? null : Number(value);
  return (
    <NumberField
      {...rest}
      value={num !== null && Number.isFinite(num) ? num : null}
      prefix={currencySymbol(currency).trim()}
      format={(n) => formatMoney({ amount: n.toFixed(digits), currency }).replace(currencySymbol(currency), "").trim()}
      parse={(t) => {
        const d = parseMoneyInput(t);
        return d === null ? null : Number(d);
      }}
      onChange={(n) => onChange(n === null ? null : n.toFixed(digits))}
      onCommit={onCommit ? (n) => onCommit(n === null ? null : n.toFixed(digits)) : undefined}
    />
  );
}
