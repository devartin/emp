/** multi_chips (§16): toggle chips with a drawn check; a live "N selected" counter. */
import { Check } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { cn } from "@/lib/cn";
import { spring } from "@/ui/motion/tokens";
import type { StepProps } from "./types";

export function MultiChips({ step, value, onChange }: StepProps) {
  const sel = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (v: string) => onChange(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label={step.title}>
        {(step.options ?? []).map((o) => {
          const on = sel.includes(o.value);
          return (
            <m.button
              key={o.value}
              type="button"
              aria-pressed={on}
              className={cn("la-chip", on && "is-on")}
              onClick={() => toggle(o.value)}
              whileTap={{ scale: 0.96 }}
              transition={spring.snappy}
              layout="position"
            >
              <AnimatePresence initial={false}>
                {on ? (
                  <m.span key="c" className="la-chip-check" initial={{ width: 0, opacity: 0 }} animate={{ width: 14, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={spring.snappy}>
                    <Check size={13} strokeWidth={3} aria-hidden />
                  </m.span>
                ) : null}
              </AnimatePresence>
              {o.label}
            </m.button>
          );
        })}
      </div>
      <p className="text-caption text-tertiary" aria-live="polite">
        {sel.length ? `${sel.length} selected` : "Nothing selected yet"}
      </p>
    </div>
  );
}
