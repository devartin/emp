import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isReducedMotion } from "./motion/useReducedEffects";

export type RingSize = 16 | 24 | 40 | 64 | 96;
const STROKE: Record<RingSize, number> = { 16: 2, 24: 2.5, 40: 3.5, 64: 5, 96: 7 };

export interface RingProps {
  /** 0..1 */
  value: number;
  size?: RingSize;
  color?: string;
  /** Centre content (64/96 sizes). */
  children?: ReactNode;
  /**
   * Completion: when the value reaches 100% a centre check appears (no glow, no pop). Defaults to on for rings
   * ≥ 40px without centre content. (Money, Portfolio and Tax use 4px bars instead of rings.)
   */
  completeMoment?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Progress ring (docs/DESIGN.md §6.3): an engraved groove track and a lit stroke; sweeps in on mount and animates
 * dashoffset on `settle` over 700ms. Diameters 16/24/40/64/96.
 */
export function Ring({ value, size = 24, color, children, completeMoment, className, ...aria }: RingProps) {
  const sw = STROKE[size];
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const [shown, setShown] = useState(() => (isReducedMotion() ? v : 0));
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(v));
    return () => cancelAnimationFrame(id);
  }, [v]);

  const moment = completeMoment ?? (!children && size >= 40);
  const prev = useRef(v);
  const [done, setDone] = useState(() => (moment && v >= 1 ? 1 : 0));
  useEffect(() => {
    if (moment && v >= 1 && prev.current < 1) setDone((n) => n + 1);
    prev.current = v;
  }, [v, moment]);

  return (
    <span
      className={cn("relative inline-flex items-center justify-center flex-none", className)}
      style={{ width: size, height: size, ["--progress-color" as string]: color }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-label={aria["aria-label"]}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }} aria-hidden>
        <circle className="emp-ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={sw} />
        {size >= 40 ? <circle className="emp-ring-rim" cx={size / 2} cy={size / 2} r={r - sw / 2 + 0.5} fill="none" strokeWidth={1} /> : null}
        <circle
          className="emp-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - shown)}
          style={shown === 0 ? { opacity: 0 } : undefined}
        />
      </svg>
      {children ? (
        <span className="absolute inset-0 flex items-center justify-center tabular">{children}</span>
      ) : done ? (
        <span key={`c${done}`} className="emp-ring-check absolute inset-0" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}
