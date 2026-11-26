import * as RR from "@radix-ui/react-radio-group";
import { m } from "motion/react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { spring } from "./motion/tokens";

export interface RadioOption<V extends string = string> {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<V extends string = string> {
  value?: V;
  defaultValue?: V;
  onValueChange?: (v: V) => void;
  options: RadioOption<V>[];
  orientation?: "vertical" | "horizontal";
  disabled?: boolean;
  name?: string;
  className?: string;
  "aria-label"?: string;
}

/** Radio group (§5.4): 16px, 1.5px border; checked = accent fill + 6px dot scaling in with spring.snappy. */
export function RadioGroup<V extends string = string>({ value, defaultValue, onValueChange, options, orientation = "vertical", disabled, name, className, ...aria }: RadioGroupProps<V>) {
  const base = useId();
  return (
    <RR.Root
      className={cn("flex gap-3", orientation === "vertical" ? "flex-col" : "flex-row flex-wrap gap-5", className)}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => onValueChange?.(v as V)}
      orientation={orientation}
      disabled={disabled}
      name={name}
      aria-label={aria["aria-label"]}
    >
      {options.map((o) => {
        const id = `${base}-${o.value}`;
        return (
          <div key={o.value} className="emp-check-row items-start" data-disabled={o.disabled || disabled ? "" : undefined}>
            <span className="emp-check-hit" style={{ marginTop: -2 }}>
              <RR.Item id={id} value={o.value} disabled={o.disabled} className="emp-radio">
                <RR.Indicator asChild>
                  <m.span className="emp-radio-dot" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring.snappy} />
                </RR.Indicator>
              </RR.Item>
            </span>
            <label htmlFor={id} className="flex flex-col gap-0.5" style={{ paddingLeft: 4 }}>
              <span>{o.label}</span>
              {o.description ? <span className="text-body-sm text-tertiary">{o.description}</span> : null}
            </label>
          </div>
        );
      })}
    </RR.Root>
  );
}

/** Single radio item for custom layouts inside <RadioGroupRoot>. */
export const RadioGroupRoot = RR.Root;
export function Radio({ value, disabled, id, "aria-label": label }: { value: string; disabled?: boolean; id?: string; "aria-label"?: string }) {
  return (
    <RR.Item value={value} disabled={disabled} id={id} className="emp-radio" aria-label={label}>
      <RR.Indicator asChild>
        <m.span className="emp-radio-dot" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring.snappy} />
      </RR.Indicator>
    </RR.Item>
  );
}
