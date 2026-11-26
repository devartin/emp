import * as RS from "@radix-ui/react-switch";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

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

/**
 * Switch (docs/DESIGN.md §6.2): a recessed well track whose lit fill crossfades in (180ms); the dome thumb travels
 * on the `thumb` spring and stretches ×1.28 from its leading edge while held. All CSS — transform/opacity only.
 */
export function Switch({ checked, defaultChecked, onCheckedChange, disabled, size = "md", label, description, labelFirst, id, className, ...aria }: SwitchProps) {
  const auto = useId();
  const sid = id ?? `sw${auto}`;
  const [inner, setInner] = useState(!!defaultChecked);
  const on = checked ?? inner;
  const [pressed, setPressed] = useState(false);

  const sw = (
    <RS.Root
      id={sid}
      className={cn("emp-switch", !label && className)}
      data-size={size === "sm" ? "sm" : undefined}
      data-pressing={pressed ? "" : undefined}
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
      onPointerCancel={() => setPressed(false)}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setPressed(true)}
      onKeyUp={() => setPressed(false)}
      onBlur={() => setPressed(false)}
    >
      <RS.Thumb className="emp-switch-thumb" />
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
