import { cn } from "@/lib/cn";
import { monthProgress } from "@/lib/dates";

export interface ProgressProps {
  /** 0..1 */
  value?: number;
  size?: 2 | 4 | 8;
  indeterminate?: boolean;
  color?: string;
  className?: string;
  "aria-label"?: string;
}

/** Linear progress (§5.10): 2/4/8px, track rgba(text,.08), scaleX over 300ms. */
export function Progress({ value = 0, size = 4, indeterminate, color, className, ...aria }: ProgressProps) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      className={cn("emp-progress", className)}
      data-size={size === 4 ? undefined : size}
      data-indeterminate={indeterminate ? "" : undefined}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(v * 100)}
      aria-label={aria["aria-label"]}
      style={color ? { ["--progress-color" as string]: color } : undefined}
    >
      <div className="emp-progress-fill" style={indeterminate ? undefined : { transform: `scaleX(${v})` }} />
    </div>
  );
}

export interface BudgetProgressProps {
  spent: number;
  budget: number;
  /** Fraction of the period elapsed; default = day-of-month ÷ days-in-month. Pass null to hide. */
  pace?: number | null;
  size?: 4 | 8;
  /**
   * Fraction of the budget at which the fill turns amber (default 0.75). Pass `null` to stay ink until the budget
   * is exceeded, so only over-budget carries colour (Money HQ).
   */
  warnAt?: number | null;
  className?: string;
  "aria-label"?: string;
}

/**
 * Budget bar (§5.10): ink below `warnAt` (75% by default), warning from `warnAt` to 100%, loss above 100% with the
 * overflow drawn as a second lap at .5. `warnAt={null}` skips the warning band. Pace marker (2×12) at the
 * elapsed-period fraction.
 */
export function BudgetProgress({ spent, budget, pace, size = 8, warnAt = 0.75, className, ...aria }: BudgetProgressProps) {
  const ratio = budget > 0 ? spent / budget : spent > 0 ? 2 : 0;
  const color = ratio > 1 ? "var(--loss)" : warnAt !== null && ratio >= warnAt ? "var(--warning)" : "var(--accent-solid)";
  const first = Math.min(1, ratio);
  const lap = ratio > 1 ? Math.min(1, ratio - 1) : 0;
  const p = pace === undefined ? monthProgress() : pace;
  return (
    <div
      className={cn("emp-budget", className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={Math.max(budget, 0)}
      aria-valuenow={spent}
      aria-label={aria["aria-label"] ?? `${Math.round(ratio * 100)}% of budget used`}
    >
      <div className="emp-progress" data-size={size === 4 ? undefined : 8} style={{ ["--progress-color" as string]: color }}>
        <div className="emp-progress-fill" style={{ transform: `scaleX(${first})` }} />
        {lap > 0 ? <div className="emp-budget-lap" style={{ transform: `scaleX(${lap})`, opacity: 0.5 }} aria-hidden /> : null}
      </div>
      {p !== null ? <span className="emp-progress-pace" style={{ left: `${Math.max(0, Math.min(1, p)) * 100}%` }} aria-hidden /> : null}
    </div>
  );
}

/** Wizard stepper (§5.10): 4px segments with 4px gap. */
export function Stepper({ total, current, className }: { total: number; current: number; className?: string }) {
  return (
    <div className={cn("emp-stepper", className)} role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={current + 1} aria-label={`Step ${current + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} data-done={i < current ? "" : undefined} data-current={i === current ? "" : undefined} />
      ))}
    </div>
  );
}
