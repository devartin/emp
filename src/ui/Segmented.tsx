import * as RR from "@radix-ui/react-radio-group";
import { LayoutGroup, m } from "motion/react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { spring } from "./motion/tokens";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label?: ReactNode;
  icon?: IconComponent | ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
}

export interface SegmentedProps<V extends string = string> {
  value: V;
  onValueChange: (v: V) => void;
  options: SegmentedOption<V>[];
  size?: "sm" | "md";
  block?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Segmented control (§5.5): radiogroup with a sliding pill indicator (shared layoutId, spring.ui).
 * Arrow keys move selection (Radix roving focus).
 */
export function Segmented<V extends string = string>({ value, onValueChange, options, size = "md", block, className, ...aria }: SegmentedProps<V>) {
  const group = useId();
  return (
    <LayoutGroup id={group}>
      <RR.Root
        className={cn("emp-seg", className)}
        data-size={size === "sm" ? "sm" : undefined}
        data-block={block ? "" : undefined}
        value={value}
        onValueChange={(v) => onValueChange(v as V)}
        orientation="horizontal"
        loop
        aria-label={aria["aria-label"]}
      >
        {options.map((o) => (
          <RR.Item key={o.value} value={o.value} disabled={o.disabled} className="emp-seg-item" aria-label={o["aria-label"]}>
            {value === o.value ? <m.span layoutId="seg-pill" className="emp-seg-indicator" transition={spring.ui} /> : null}
            {renderIcon(o.icon)}
            {o.label}
          </RR.Item>
        ))}
      </RR.Root>
    </LayoutGroup>
  );
}
