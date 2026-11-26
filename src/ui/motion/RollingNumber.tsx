import { animate, m } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { spring, ease } from "./tokens";
import { isReducedMotion } from "./useReducedEffects";

export interface RollingNumberProps {
  value: number;
  /** Formats the number to its display string (digits roll, other glyphs swap). */
  format?: (n: number) => string;
  /** Count up on first mount (from `from`, default 0). Skipped when |value| < 10 or reduced motion (§4.2). */
  countUp?: boolean;
  from?: number;
  className?: string;
  /** Mark as sensitive (masked under Hide numbers). */
  sensitive?: boolean;
  "aria-label"?: string;
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const LINE = 1.2; // em, per column

const DigitColumn = memo(function DigitColumn({ digit, order }: { digit: number; order: number }) {
  return (
    <span className="emp-roll-col">
      <span className="emp-roll-ghost">0</span>
      <m.span
        className="emp-roll-strip"
        initial={false}
        animate={{ y: `${-digit * LINE}em` }}
        transition={{ ...spring.ui, delay: order * 0.02 }}
      >
        {DIGITS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </m.span>
    </span>
  );
});

/**
 * Rolling-digit ticker (§4.2 "KPI number change"): each digit column translates on Y, staggered 20ms from the right,
 * with spring.ui. First mount counts up over 600ms ease.outExpo.
 */
export function RollingNumber({ value, format = defaultFormat, countUp = true, from = 0, className, sensitive, ...rest }: RollingNumberProps) {
  const text = format(value);
  const [phase, setPhase] = useState<"count" | "roll">(() =>
    countUp && Math.abs(value) >= 10 && !isReducedMotion() ? "count" : "roll",
  );
  const countRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (phase !== "count") return;
    const el = countRef.current;
    if (el) el.textContent = format(from);
    const controls = animate(from, value, {
      duration: 0.6,
      ease: ease.outExpo,
      onUpdate: (v) => {
        if (countRef.current) countRef.current.textContent = format(v);
      },
      onComplete: () => setPhase("roll"),
    });
    return () => controls.stop();
    // count-up runs once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value change during the count-up jumps straight to rolling.
  const first = useRef(value);
  useEffect(() => {
    if (phase === "count" && value !== first.current) setPhase("roll");
  }, [value, phase]);

  const chars = useMemo(() => Array.from(text), [text]);
  return (
    <span className={cn("emp-roll", className)} data-sensitive={sensitive ? "" : undefined} {...rest}>
      <span className="sr-only">{text}</span>
      {phase === "count" ? (
        <span ref={countRef} aria-hidden>
          {format(from)}
        </span>
      ) : (
        <span aria-hidden className="emp-roll-row">
          {chars.map((ch, i) => {
            const fromRight = chars.length - 1 - i;
            const d = ch.charCodeAt(0) - 48;
            return d >= 0 && d <= 9 ? (
              <DigitColumn key={`d${fromRight}`} digit={d} order={fromRight} />
            ) : (
              <span key={`s${fromRight}`} className="emp-roll-sym">
                {ch}
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

function defaultFormat(n: number): string {
  return formatNumber(n, { maximumFractionDigits: 2 });
}
