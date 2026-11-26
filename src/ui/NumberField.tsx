import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatNumber, getFormatLocale } from "@/lib/format";
import { evaluateExpression } from "./expression";
import { Input, type InputProps } from "./Input";

export interface NumberFieldProps extends Omit<InputProps, "value" | "defaultValue" | "onChange" | "type"> {
  value: number | null;
  onChange: (value: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Display formatting on blur (locale aware). */
  formatOptions?: Intl.NumberFormatOptions;
  /** Custom display format (overrides formatOptions). */
  format?: (n: number) => string;
  /** Parse display text → number (MoneyField supplies a decimal-safe parser). */
  parse?: (text: string) => number | null;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

function clamp(n: number, min?: number, max?: number) {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

export function parseLocaleNumber(text: string): number | null {
  const t = text.trim().replace(/[−]/g, "-");
  if (!t) return null;
  const dec = new Intl.NumberFormat(getFormatLocale()).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  let s = t.replace(/[^\d.,\-]/g, "");
  s = dec === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = Number(s);
  return s && Number.isFinite(n) ? n : null;
}

/**
 * Numeric input (§5.2): right-aligned tabular; ↑/↓ step ±1, Shift ±10, Alt ±0.1; `=` expressions evaluate on blur and
 * show a ghost "= result" for 800ms before committing; raw while editing, locale-formatted on blur.
 */
export function NumberField({
  value,
  onChange,
  step = 1,
  min,
  max,
  formatOptions = { maximumFractionDigits: 6 },
  format,
  parse = parseLocaleNumber,
  onBlur,
  onFocus,
  onKeyDown,
  ...rest
}: NumberFieldProps) {
  const fmt = (n: number | null) => (n === null ? "" : format ? format(n) : formatNumber(n, formatOptions));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => fmt(value));
  const [ghost, setGhost] = useState<string | null>(null);
  const ghostTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!editing && ghost === null) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing]);
  useEffect(() => () => window.clearTimeout(ghostTimer.current), []);

  const commit = (n: number | null) => {
    const v = n === null ? null : clamp(n, min, max);
    onChange(v);
    setText(fmt(v));
  };

  const stepBy = (delta: number) => {
    const base = parse(text) ?? value ?? 0;
    const next = clamp(+(base + delta).toPrecision(12), min, max);
    setText(String(next));
    onChange(next);
  };

  return (
    <Input
      {...rest}
      inputMode="decimal"
      align="end"
      className={rest.className ?? "tabular"}
      value={text}
      ghost={ghost}
      onChange={(e) => setText(e.currentTarget.value)}
      onFocus={(e) => {
        setEditing(true);
        if (value !== null && !text.startsWith("=")) setText(String(value));
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setEditing(false);
        const t = text.trim();
        if (t.startsWith("=")) {
          void evaluateExpression(t).then((n) => {
            if (n === null) {
              setText(t);
              return;
            }
            setGhost("= " + fmt(n));
            window.clearTimeout(ghostTimer.current);
            ghostTimer.current = window.setTimeout(() => {
              setGhost(null);
              commit(n);
            }, 800);
          });
        } else {
          commit(t === "" ? null : parse(t));
        }
        onBlur?.(e);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          if (text.trim().startsWith("=")) return;
          e.preventDefault();
          const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
          stepBy((e.key === "ArrowUp" ? 1 : -1) * step * mult);
        } else if (e.key === "Enter") {
          (e.currentTarget as HTMLInputElement).blur();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
