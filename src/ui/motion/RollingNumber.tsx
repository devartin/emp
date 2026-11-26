import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { css } from "./tokens";
import { isReducedMotion, usePrivacy } from "./useReducedEffects";

export interface RollingNumberProps {
  value: number;
  /** Formats the number to its display string (digits roll, other glyphs stay static). */
  format?: (n: number) => string;
  /**
   * @deprecated v3 (motion register): numbers never count up on arrival. Accepted and ignored, so the final value is in
   * the DOM from the first frame.
   */
  countUp?: boolean;
  /** @deprecated ignored (count-up is retired). */
  from?: number;
  /** @deprecated ignored (count-up is retired). */
  countUpKey?: string;
  /** @deprecated ignored (count-up is retired). */
  countUpDuration?: number;
  /** Scrub mode (chart crosshair): the text is rewritten in place, never rolled. */
  scrubbing?: boolean;
  /**
   * When to roll a change: "edit" (default) rolls only when the change follows the user's own input within 1.5s
   * (a typed amount, a ticked box), "always" rolls every change, "never" never rolls.
   */
  roll?: "edit" | "always" | "never";
  className?: string;
  /** Mark as sensitive (masked under Hide numbers; never rolls while masked). */
  sensitive?: boolean;
  /** Pre-formatted text to show instead of `format(value)` (digits in it roll; `value` still sets the direction). */
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
/** Continuity class C2 (register.ts): 240ms, ease-out, no overshoot, no stagger. */
const ROLL_MS = 240;
const USER_WINDOW_MS = 1500;

/** When the user last pressed a key, pointer or changed a field (one passive module-level listener). */
let lastUserInput = Number.NEGATIVE_INFINITY;
let listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const mark = () => {
    lastUserInput = performance.now();
  };
  for (const t of ["pointerup", "keydown", "input", "change"]) window.addEventListener(t, mark, { capture: true, passive: true });
}
/** Tell the roll that the next value change is the user's own (for edits that arrive outside a DOM event). */
export function markUserEdit(): void {
  lastUserInput = typeof performance === "undefined" ? 0 : performance.now();
}
const userCaused = () => typeof performance !== "undefined" && performance.now() - lastUserInput < USER_WINDOW_MS;

function Column({ from, to, dir }: { from: number; to: number; dir: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  let a = from;
  let b = to;
  if (dir > 0 && b < a) b += 10; // roll up past 9
  if (dir < 0 && b > a) a += 10; // roll down past 0
  useLayoutEffect(() => {
    ref.current?.animate([{ transform: `translateY(${-a * LINE}em)` }, { transform: `translateY(${-b * LINE}em)` }], { duration: ROLL_MS, easing: css.easeOut, fill: "both" });
  }, [a, b]);
  return (
    <span className="emp-roll-col">
      <span className="emp-roll-ghost">0</span>
      <span ref={ref} className="emp-roll-strip" style={{ transform: `translateY(${-b * LINE}em)` }}>
        {DIGITS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </span>
    </span>
  );
}

/** The aria-hidden, unselectable roll overlay: `to` set right-aligned over `from`, only changed digits move. */
function Overlay({ from, to, dir }: { from: string; to: string; dir: number }) {
  const f = Array.from(from);
  const t = Array.from(to);
  return (
    <span className="emp-roll-overlay" aria-hidden>
      {t.map((ch, i) => {
        const fromRight = t.length - 1 - i;
        const prev = f[f.length - 1 - fromRight];
        const d = ch.charCodeAt(0) - 48;
        const p = prev === undefined ? NaN : prev.charCodeAt(0) - 48;
        if (d >= 0 && d <= 9 && p >= 0 && p <= 9 && p !== d) return <Column key={`d${fromRight}`} from={p} to={d} dir={dir} />;
        return (
          <span key={`s${fromRight}`} className="emp-roll-sym">
            {ch}
          </span>
        );
      })}
    </span>
  );
}

/**
 * RollingNumber v3 (docs/DESIGN.md §7, motion register C2). The DOM, the copied text and the accessibility text all
 * hold the final value from the first frame: the visible value is a plain text node. A roll happens only when the
 * change follows the user's own edit (or `roll="always"`): an aria-hidden, `user-select: none` overlay rolls the
 * changed digits for 240ms while the real text underneath is transparent. Arrival, data refreshes, scrubbing,
 * Hide numbers and reduced motion never roll.
 */
export function RollingNumber({ value, format = defaultFormat, scrubbing, roll = "edit", className, sensitive, display, announce, countUp: _cu, from: _f, countUpKey: _k, countUpDuration: _d, ...rest }: RollingNumberProps) {
  void _cu;
  void _f;
  void _k;
  void _d;
  const text = display ?? format(value);
  const privacy = usePrivacy();
  const masked = !!(privacy && sensitive);
  const [anim, setAnim] = useState<{ from: string; to: string; dir: number; id: number } | null>(null);
  const prev = useRef({ text, value });
  const changed = useRef(false);

  useEffect(() => {
    if (roll === "edit") listen();
  }, [roll]);

  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = { text, value };
    if (was.text === text) return;
    changed.current = true;
    const wants = roll === "always" || (roll === "edit" && userCaused());
    if (!wants || scrubbing || masked || isReducedMotion()) {
      setAnim(null);
      return;
    }
    const id = (anim?.id ?? 0) + 1;
    setAnim({ from: was.text, to: text, dir: value === was.value ? 0 : value > was.value ? 1 : -1, id });
    const t = window.setTimeout(() => setAnim((a) => (a && a.id === id ? null : a)), ROLL_MS + 20);
    return () => window.clearTimeout(t);
    // anim is read for its id only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, value, roll, scrubbing, masked]);

  const spoken = useThrottledText(masked ? "Hidden" : text, announce && !scrubbing && !masked ? ANNOUNCE_MS : 0);
  const rolling = !!anim && !masked;

  return (
    <span className={cn("emp-roll", className)} data-sensitive={sensitive ? "" : undefined} data-rolling={rolling ? "" : undefined} {...rest}>
      <span className="emp-roll-value">{text}</span>
      {rolling && anim ? <Overlay key={anim.id} from={anim.from} to={anim.to} dir={anim.dir} /> : null}
      {announce ? (
        <span className="sr-only" aria-live="polite">
          {changed.current ? spoken : ""}
        </span>
      ) : null}
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
