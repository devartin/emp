import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatNumber, getFormatLocale } from "@/lib/format";
import { evaluateExpression } from "./expression";
import { Input, type InputProps } from "./Input";

export interface NumberFieldProps extends Omit<InputProps, "value" | "defaultValue" | "onChange" | "type"> {
  value: number | null;
  /**
   * Fires live on every keystroke with the parsed value (when the text parses and is within min/max; a pending `=`
   * expression waits), and again with the committed value on blur, Enter and steps.
   */
  onChange: (value: number | null) => void;
  /** Fires only on commit (blur, Enter, steps, an evaluated `=` expression): use it for writes that persist. */
  onCommit?: (value: number | null) => void;
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
  /** Two stacked mini keycaps inside the well's right end; hold to auto-repeat (400ms → 60ms). */
  steppers?: boolean;
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
  onCommit,
  step = 1,
  min,
  max,
  formatOptions = { maximumFractionDigits: 6 },
  format,
  parse = parseLocaleNumber,
  onBlur,
  onFocus,
  onKeyDown,
  steppers,
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
    onCommit?.(v);
    setText(fmt(v));
  };

  const textRef = useRef(text);
  textRef.current = text;
  const stepBy = (delta: number) => {
    const base = parse(textRef.current) ?? value ?? 0;
    const next = clamp(+(base + delta).toPrecision(12), min, max);
    textRef.current = String(next);
    setText(String(next));
    onChange(next);
    onCommit?.(next);
  };

  const repeat = useRef<number | undefined>(undefined);
  const stopRepeat = () => window.clearTimeout(repeat.current);
  useEffect(() => stopRepeat, []);
  const hold = (dir: 1 | -1) => {
    stepBy(dir * step);
    let delay = 400;
    const tick = () => {
      stepBy(dir * step);
      delay = Math.max(60, delay * 0.7);
      repeat.current = window.setTimeout(tick, delay);
    };
    repeat.current = window.setTimeout(tick, delay);
  };
  const stepperKeys = steppers ? (
    <span className="emp-stepper-keys">
      {([1, -1] as const).map((dir) => (
        <button
          key={dir}
          type="button"
          tabIndex={-1}
          aria-label={dir > 0 ? "Increase" : "Decrease"}
          className="emp-stepper-key slab"
          disabled={rest.disabled || rest.readOnly}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            hold(dir);
          }}
          onPointerUp={stopRepeat}
          onPointerLeave={stopRepeat}
          onPointerCancel={stopRepeat}
        >
          {dir > 0 ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </button>
      ))}
    </span>
  ) : null;

  return (
    <Input
      {...rest}
      trailing={
        stepperKeys || rest.trailing ? (
          <>
            {rest.trailing}
            {stepperKeys}
          </>
        ) : undefined
      }
      inputMode="decimal"
      align="end"
      className={rest.className ?? "tabular"}
      value={text}
      ghost={ghost}
      onChange={(e) => {
        const t = e.currentTarget.value;
        setText(t);
        // Live value: parsed per keystroke so dependent figures update as you type (the reconcile difference). An
        // unfinished `=` expression or text that does not parse (a lone "-") waits for the commit.
        const trimmed = t.trim();
        if (trimmed.startsWith("=")) return;
        if (trimmed === "") return onChange(null);
        const n = parse(trimmed);
        if (n === null || (min !== undefined && n < min) || (max !== undefined && n > max)) return;
        if (n !== value) onChange(n);
      }}
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
          const input = e.currentTarget as HTMLInputElement;
          const form = input.form;
          // Inside a form, Enter would submit before the parent saw the committed value (the commit happens on
          // blur and React hasn't re-rendered yet). Commit first, then submit once the new value has landed.
          if (form && !text.trim().startsWith("=") && !e.defaultPrevented) {
            e.preventDefault();
            input.blur();
            window.setTimeout(() => {
              if (form.isConnected) form.requestSubmit();
            }, 0);
          } else input.blur();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
