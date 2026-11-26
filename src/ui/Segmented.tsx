import * as RR from "@radix-ui/react-radio-group";
import { type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";

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
 * Segmented control (docs/DESIGN.md §5.4): a flat bed with a paper thumb on the selected option. Selection is instant
 * (register.ts C0): the thumb is simply on the new option, no glide and no squash. Arrow keys move selection (Radix
 * roving focus).
 */
export function Segmented<V extends string = string>({ value, onValueChange, options, size = "md", block, className, ...aria }: SegmentedProps<V>) {
  return (
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
          {value === o.value ? (
            <span className="emp-seg-indicator">
              <span className="emp-seg-face" />
            </span>
          ) : null}
          {renderIcon(o.icon)}
          {o.label}
        </RR.Item>
      ))}
    </RR.Root>
  );
}
