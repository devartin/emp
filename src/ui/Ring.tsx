import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type RingSize = 16 | 24 | 40 | 64 | 96;
const STROKE: Record<RingSize, number> = { 16: 2, 24: 2.5, 40: 3.5, 64: 5, 96: 7 };

export interface RingProps {
  /** 0..1 */
  value: number;
  size?: RingSize;
  color?: string;
  /** Centre content (64/96 sizes). */
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/** Progress ring (§5.10) — diameters 16/24/40/64/96 with spec strokes; dashoffset transitions over 300ms. */
export function Ring({ value, size = 24, color, children, className, ...aria }: RingProps) {
  const sw = STROKE[size];
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
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
        <circle
          className="emp-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={v === 0 ? { opacity: 0 } : undefined}
        />
      </svg>
      {children ? <span className="absolute inset-0 flex items-center justify-center tabular">{children}</span> : null}
    </span>
  );
}
