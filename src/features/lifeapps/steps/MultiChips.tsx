/**
 * multi_chips (§16): toggle chips with a check that pops in; a live "N selected" counter. The check's 15px slot is
 * always reserved (the label sits centred over it while off), so latching only scales / fades the check and slides
 * the label with a transform — no chip or row relayout per frame.
 */
import { Check } from "lucide-react";
import { m } from "motion/react";
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
            <button key={o.value} type="button" aria-pressed={on} className="la-chip la-chip-latch slab" onClick={() => toggle(o.value)}>
              <m.span className="la-chip-check" initial={false} animate={on ? { scale: 1, opacity: 1, x: 0 } : { scale: 0.4, opacity: 0, x: -3 }} transition={on ? spring.pop : { duration: 0.12, ease: [0.4, 0, 1, 1] }} aria-hidden>
                <Check size={13} strokeWidth={3} />
              </m.span>
              <m.span className="la-chip-label" initial={false} animate={{ x: on ? 0 : -9.5 }} transition={spring.glide}>
                {o.label}
              </m.span>
            </button>
          );
        })}
      </div>
      <p className="text-caption text-tertiary" aria-live="polite">
        {sel.length ? `${sel.length} selected` : "Nothing selected yet"}
      </p>
    </div>
  );
}
