import * as RC from "@radix-ui/react-checkbox";
import { useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { burst } from "./motion/Celebrate";

export interface CheckboxProps {
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  error?: boolean;
  id?: string;
  name?: string;
  className?: string;
  /**
   * Task completion (S13 — editor to-dos, Today, habits): checking fires an 8-ray ink burst and draws a
   * strike-through across the label, which fades to tertiary.
   */
  celebrate?: boolean;
  "aria-label"?: string;
}

/**
 * Checkbox (docs/DESIGN.md §6.2): a 16px well with a ≥3:1 rim; checked pops into a lit mini-slab (scale .6 → 1 on the
 * `thumb` spring) and the tick draws over 220ms after 60ms. Press squashes to .9. 24×24 hit area.
 */
export function Checkbox({ checked, defaultChecked, onCheckedChange, disabled, label, description, error, id, name, className, celebrate, ...aria }: CheckboxProps) {
  const auto = useId();
  const cid = id ?? `cb${auto}`;
  const ref = useRef<HTMLButtonElement>(null);
  const isOn = checked === true || (checked === undefined && !!defaultChecked);
  const box = (
    <span className="emp-check-hit">
      <RC.Root
        ref={ref}
        id={cid}
        name={name}
        className={cn("emp-check", !label && className)}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(v) => {
          if (celebrate && v === true && ref.current) burst(ref.current);
          onCheckedChange?.(v === true);
        }}
        disabled={disabled}
        data-error={error ? "" : undefined}
        aria-label={aria["aria-label"]}
      >
        <span className="emp-check-cap" aria-hidden />
        <RC.Indicator forceMount className="emp-check-ind">
          <svg viewBox="0 0 12 12" fill="none" aria-hidden>
            {checked === "indeterminate" ? (
              <path className="emp-check-dash" pathLength={1} d="M3.2 6h5.6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            ) : (
              <path className="emp-check-tick" pathLength={1} d="M2.5 6.4 4.9 8.7 9.6 3.6" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </RC.Indicator>
      </RC.Root>
    </span>
  );
  if (!label) return box;
  return (
    <div
      className={cn("emp-check-row items-start", className)}
      data-disabled={disabled ? "" : undefined}
      data-celebrate={celebrate ? "" : undefined}
      data-checked={celebrate && isOn ? "" : undefined}
    >
      <span style={{ paddingTop: 2 }}>{box}</span>
      <label htmlFor={cid} className="flex flex-col gap-0.5" style={{ paddingLeft: 4 }}>
        <span className="emp-check-label">{label}</span>
        {description ? <span className="text-body-sm text-tertiary">{description}</span> : null}
      </label>
    </div>
  );
}
