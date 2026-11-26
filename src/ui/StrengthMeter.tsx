import { cn } from "@/lib/cn";

const LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;

/** Password strength meter (§5.11): 4 segments 4px tall, 4px gap; 0–1 loss, 2 warning, 3–4 gain. */
export function StrengthMeter({ score, className, showLabel }: { score: 0 | 1 | 2 | 3 | 4 | null; className?: string; showLabel?: boolean }) {
  const on = score === null ? 0 : Math.max(1, score);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="emp-strength" data-score={score ?? undefined} role="meter" aria-valuemin={0} aria-valuemax={4} aria-valuenow={score ?? 0} aria-label={score === null ? "Password strength" : `Password strength: ${LABELS[score]}`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} data-on={i < on && score !== null ? "" : undefined} />
        ))}
      </div>
      {showLabel && score !== null ? <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>{LABELS[score]}</span> : null}
    </div>
  );
}
