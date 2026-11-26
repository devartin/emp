import { Check } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "./Badge";
import { renderIcon, type IconComponent } from "./Button";
import { EdgeLight } from "./motion/EdgeLight";
import { spring } from "./motion/tokens";
import { useReducedMotionPref } from "./motion/useReducedEffects";

export interface ChoiceCardProps {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: IconComponent | ReactNode;
  /** Visual preview slot (theme cards). */
  preview?: ReactNode;
  recommended?: boolean | string;
  disabled?: boolean;
  /** "radio" for single choice groups, "checkbox" for multi. */
  role?: "radio" | "checkbox";
  className?: string;
}

/**
 * Choice card (docs/DESIGN.md §6.2): a raised panel with edge light and ≤ 3° tilt. Selected latches (presses 1px, inset
 * top shadow, ring rim) and a lit check badge pops on `thumb`. In a radio group each card latches on its own.
 */
export function ChoiceCard({ selected, onSelect, title, description, icon, preview, recommended, disabled, role = "radio", className }: ChoiceCardProps) {
  const reduced = useReducedMotionPref();
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      className={cn("emp-choice panel", className)}
      data-state={selected ? "checked" : "unchecked"}
      data-raise=""
      data-light=""
      data-tilt="3"
      onClick={onSelect}
    >
      <EdgeLight />
      {recommended ? (
        <span className="emp-choice-ribbon">
          <Badge tone="solid">{typeof recommended === "string" ? recommended : "Recommended"}</Badge>
        </span>
      ) : null}
      {preview}
      {icon ? <span className="emp-choice-icon">{renderIcon(icon)}</span> : null}
      <span className="emp-choice-title">{title}</span>
      {description ? <span className="emp-choice-desc">{description}</span> : null}
      <AnimatePresence>
        {selected ? (
          <m.span
            key="b"
            className="emp-choice-badge"
            initial={reduced ? { opacity: 0 } : { scale: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1, transition: spring.thumb }}
            exit={{ opacity: 0, scale: reduced ? 1 : 0.6, transition: { duration: 0.12 } }}
          >
            <Check aria-hidden />
          </m.span>
        ) : null}
      </AnimatePresence>
    </button>
  );
}
