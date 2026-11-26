import * as RS from "@radix-ui/react-switch";
import { m } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { spring } from "./motion/tokens";
import { useReducedMotionPref } from "./motion/useReducedEffects";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (v: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  label?: ReactNode;
  description?: ReactNode;
  /** Put the label before the switch (settings rows). */
  labelFirst?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

const DIMS = { sm: { thumb: 12, travel: 10 }, md: { thumb: 14, travel: 14 } } as const;

/**
 * Switch (§5.4, §4.2): thumb travels with spring.snappy and stretches +4px while pressed
 * (anchored to the travel direction); track crossfades over 150ms.
 */
export function Switch({ checked, defaultChecked, onCheckedChange, disabled, size = "md", label, description, labelFirst, id, className, ...aria }: SwitchProps) {
  const auto = useId();
  const sid = id ?? `sw${auto}`;
  const [inner, setInner] = useState(!!defaultChecked);
  const on = checked ?? inner;
  const [pressed, setPressed] = useState(false);
  const reduced = useReducedMotionPref();
  const d = DIMS[size];
  const stretch = pressed && !reduced ? 4 : 0;
  const x = on ? d.travel - stretch : 0;

  const sw = (
    <RS.Root
      id={sid}
      className={cn("emp-switch", !label && className)}
      data-size={size === "sm" ? "sm" : undefined}
      checked={on}
      onCheckedChange={(v) => {
        setInner(v);
        onCheckedChange?.(v);
      }}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setPressed(true)}
      onKeyUp={() => setPressed(false)}
    >
      <RS.Thumb asChild>
        <m.span
          className="emp-switch-thumb"
          initial={false}
          animate={{ x, width: d.thumb + stretch }}
          transition={spring.snappy}
        />
      </RS.Thumb>
    </RS.Root>
  );
  if (!label) return sw;
  return (
    <div className={cn("emp-check-row", labelFirst ? "justify-between w-full gap-4" : "gap-2.5", className)} data-disabled={disabled ? "" : undefined}>
      {labelFirst ? null : sw}
      <label htmlFor={sid} className="flex flex-col gap-0.5 min-w-0">
        <span>{label}</span>
        {description ? <span className="text-body-sm text-tertiary">{description}</span> : null}
      </label>
      {labelFirst ? sw : null}
    </div>
  );
}
