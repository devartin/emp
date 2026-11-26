import { animate, AnimatePresence, m, useMotionValue, useTransform } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { ease, spring, stagger } from "./tokens";
import { isReducedMotion, usePrivacy, useReducedMotionPref } from "./useReducedEffects";

export interface RollingNumberProps {
  value: number;
  /** Formats the number to its display string (digits roll, other glyphs stay static). */
  format?: (n: number) => string;
  /** Count up on first mount (from `from`, default 0). Skipped when |value| < 10 or reduced motion. */
  countUp?: boolean;
  from?: number;
  /**
   * Count up only once per session for this key (an in-memory Set): later mounts roll from the previous value.
   * Use for hero numbers (S5, S19).
   */
  countUpKey?: string;
  /** Count-up length in seconds (default .9; hero numbers use 1.3). */
  countUpDuration?: number;
  /** Scrub mode (chart hover): 90ms ease-out, no stagger, aria-live off. */
  scrubbing?: boolean;
  className?: string;
  /** Mark as sensitive (masked under Hide numbers; never rolls while masked, and screen readers hear "Hidden"). */
  sensitive?: boolean;
  /**
   * Pre-formatted text to show instead of `format(value)` (digits in it roll; `value` still sets the roll direction).
   * Count-up is skipped in this mode.
   */
  display?: string;
  /**
   * Announce changes to screen readers (aria-live polite), throttled to one announcement per 5s. Off by default:
   * live prices would otherwise talk constantly. Use for user-initiated results (calculator, "Balanced", goal reached).
   */
  announce?: boolean;
  "aria-label"?: string;
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const LINE = 1.2; // em per glyph
const seenKeys = new Set<string>();
const lastValues = new Map<string, number>();

type Mode = "roll" | "scrub";

const DigitColumn = memo(function DigitColumn({ digit, order, dir, mode, enter }: { digit: number; order: number; dir: number; mode: Mode; enter: boolean }) {
  const pos = useMotionValue(digit);
  const y = useTransform(pos, (p) => `${-p * LINE}em`);
  const prev = useRef(digit);
  const [rolling, setRolling] = useState(false);

  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = digit;
    if (was === digit) {
      // Same digit, but a roll may have been cut short: `dir`/`order`/`mode` changed mid-flight (common while scrubbing
      // back and forth), the cleanup stopped it and nothing restarted it — the column would freeze between glyphs.
      const p = pos.get();
      if (p === digit || p === digit + 10) return;
      if (isReducedMotion()) {
        pos.set(digit);
        setRolling(false);
        return;
      }
      const settle = animate(pos, Math.abs(p - (digit + 10)) < Math.abs(p - digit) ? digit + 10 : digit, { duration: 0.09, ease: ease.out });
      settle.then(() => {
        pos.set(digit);
        setRolling(false);
      });
      return () => settle.stop();
    }
    if (isReducedMotion()) {
      pos.set(digit);
      return;
    }
    let to = digit;
    if (dir > 0 && digit < was) to = digit + 10; // roll up past 9
    if (dir < 0 && digit > was) pos.set(was + 10); // roll down past 0
    setRolling(true);
    const ctl = animate(
      pos,
      to,
      mode === "scrub" ? { duration: 0.09, ease: ease.out } : { ...spring.roll, delay: Math.min(order * stagger.digits, 0.2) },
    );
    ctl.then(() => {
      pos.set(digit);
      setRolling(false);
    });
    return () => ctl.stop();
  }, [digit, dir, mode, order, pos]);

  return (
    <m.span
      className="emp-roll-col"
      data-rolling={rolling ? "" : undefined}
      initial={enter ? { y: "60%", opacity: 0 } : false}
      animate={{ y: 0, opacity: 1, transition: spring.settle }}
    >
      <span className="emp-roll-ghost">0</span>
      <m.span className="emp-roll-strip" style={{ y }}>
        {DIGITS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </m.span>
    </m.span>
  );
});

/**
 * RollingNumber v2 — the odometer (docs/DESIGN.md §5.5). Only changed digits roll, in the direction of change
 * (an increase rolls up), on the `roll` spring with a 28ms right-to-left stagger; the moving column is masked top and
 * bottom for a motion-blur feel. Gained columns rise in; separators and currency marks are static. Scrub mode is
 * 90ms with no stagger. Masked values swap instantly; reduced motion crossfades in 140ms.
 */
export function RollingNumber({
  value,
  format = defaultFormat,
  countUp = true,
  from = 0,
  countUpKey,
  countUpDuration = 0.9,
  scrubbing,
  className,
  sensitive,
  display,
  announce,
  ...rest
}: RollingNumberProps) {
  const text = display ?? format(value);
  const privacy = usePrivacy();
  const reduced = useReducedMotionPref();
  const [phase, setPhase] = useState<"count" | "roll">(() => {
    if (display !== undefined || !countUp || Math.abs(value) < 10 || isReducedMotion()) return "roll";
    if (countUpKey && seenKeys.has(countUpKey)) return "roll";
    return "count";
  });
  const countRef = useRef<HTMLSpanElement>(null);
  const startFrom = countUpKey && lastValues.has(countUpKey) ? (lastValues.get(countUpKey) as number) : from;

  useLayoutEffect(() => {
    if (phase !== "count") return;
    if (countUpKey) seenKeys.add(countUpKey);
    const el = countRef.current;
    if (el) el.textContent = format(startFrom);
    const controls = animate(startFrom, value, {
      duration: countUpDuration,
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

  // Direction of the latest change.
  const prevValue = useRef(value);
  const dirRef = useRef(0);
  if (prevValue.current !== value) {
    dirRef.current = value > prevValue.current ? 1 : -1;
    prevValue.current = value;
  }
  useEffect(() => {
    if (countUpKey) lastValues.set(countUpKey, value);
  }, [countUpKey, value]);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const chars = useMemo(() => Array.from(text), [text]);
  const mode: Mode = scrubbing ? "scrub" : "roll";
  const masked = !!(privacy && sensitive);
  const live = announce && !scrubbing && !masked ? "polite" : "off";
  const spoken = useThrottledText(masked ? "Hidden" : text, announce && !scrubbing && !masked ? ANNOUNCE_MS : 0);

  let body;
  if (phase === "count") {
    body = (
      <span ref={countRef} aria-hidden>
        {format(startFrom)}
      </span>
    );
  } else if (masked) {
    body = <span aria-hidden>{text}</span>;
  } else if (reduced) {
    body = (
      <AnimatePresence initial={false} mode="popLayout">
        <m.span key={text} aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
          {text}
        </m.span>
      </AnimatePresence>
    );
  } else {
    body = (
      <span aria-hidden className="emp-roll-row">
        {chars.map((ch, i) => {
          const fromRight = chars.length - 1 - i;
          const d = ch.charCodeAt(0) - 48;
          return d >= 0 && d <= 9 ? (
            <DigitColumn key={`d${fromRight}`} digit={d} order={fromRight} dir={dirRef.current} mode={mode} enter={mounted.current && !scrubbing} />
          ) : (
            <span key={`s${fromRight}`} className="emp-roll-sym">
              {ch}
            </span>
          );
        })}
      </span>
    );
  }

  return (
    <span className={cn("emp-roll", className)} data-sensitive={sensitive ? "" : undefined} aria-live={live} {...rest}>
      <span className="sr-only">{spoken}</span>
      {body}
    </span>
  );
}

const ANNOUNCE_MS = 5000;

/** `text`, updated at most once per `ms` (trailing edge); passes straight through when `ms` is 0. */
function useThrottledText(text: string, ms: number): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (!ms) return;
    if (text === shown) return;
    const wait = Math.max(0, last.current + ms - Date.now());
    const id = window.setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, wait);
    return () => window.clearTimeout(id);
  }, [text, ms, shown]);
  return ms ? shown : text;
}

/** Alias for discoverability (KIT.md). */
export const NumberRoll = RollingNumber;

function defaultFormat(n: number): string {
  return formatNumber(n, { maximumFractionDigits: 2 });
}
