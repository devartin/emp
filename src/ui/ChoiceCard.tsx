import { Check } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "./Badge";
import { renderIcon, type IconComponent } from "./Button";

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
 * Choice card (docs/DESIGN.md §5.8): a hairline frame; hover is an instant ink wash; selected = a 2px ink frame and an
 * ink check badge that fades in (100ms). In a radio group each card selects on its own. No lift, no tilt, no light.
 */
export function ChoiceCard({ selected, onSelect, title, description, icon, preview, recommended, disabled, role = "radio", className }: ChoiceCardProps) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      className={cn("emp-choice panel", className)}
      data-state={selected ? "checked" : "unchecked"}
      onClick={onSelect}
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
          <m.span key="b" className="emp-choice-badge" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.1 } }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
            <Check aria-hidden />
          </m.span>
        ) : null}
      </AnimatePresence>
    </button>
  );
}
