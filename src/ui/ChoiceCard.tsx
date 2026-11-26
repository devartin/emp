import { Check } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "./Badge";
import { renderIcon, type IconComponent } from "./Button";
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
 * Choice card (§5.11): min 160×120, radius 14, padding 16. Selected = 2px accent inset + accent-soft + a 20px check
 * badge entering with spring.bouncy. Press scales to .985.
 */
export function ChoiceCard({ selected, onSelect, title, description, icon, preview, recommended, disabled, role = "radio", className }: ChoiceCardProps) {
  const reduced = useReducedMotionPref();
  return (
    <m.button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      className={cn("emp-choice", className)}
      data-state={selected ? "checked" : "unchecked"}
      onClick={onSelect}
      whileTap={reduced ? undefined : { scale: 0.985 }}
      transition={spring.snappy}
    >
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
            animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1, transition: spring.bouncy }}
            exit={{ opacity: 0, scale: reduced ? 1 : 0.6, transition: { duration: 0.12 } }}
          >
            <Check aria-hidden />
          </m.span>
        ) : null}
      </AnimatePresence>
    </m.button>
  );
}
