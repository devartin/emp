import { cn } from "@/lib/cn";

export interface SpinnerProps {
  size?: number;
  className?: string;
  /** Accessible label; omit when the parent already announces busy state. */
  label?: string;
}

/** 270° arc at stroke 1.5, one rotation per 700ms, linear (§5.10). Keeps spinning under reduced motion (§4.3). */
export function Spinner({ size = 16, className, label }: SpinnerProps) {
  const r = 6.25;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={cn("emp-spinner", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="8" cy="8" r={r} stroke="currentColor" strokeOpacity="0.16" strokeWidth="1.5" />
      <circle
        cx="8"
        cy="8"
        r={r}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={`${c * 0.75} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
