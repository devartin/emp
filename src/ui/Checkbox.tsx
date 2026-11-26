import * as RC from "@radix-ui/react-checkbox";
import { m } from "motion/react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ease } from "./motion/tokens";

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
  "aria-label"?: string;
}

/** Checkbox (§5.4): 16px, radius 4, fill 100ms, check path draws 0→1 over 180ms ease.out; 24×24 hit area. */
export function Checkbox({ checked, defaultChecked, onCheckedChange, disabled, label, description, error, id, name, className, ...aria }: CheckboxProps) {
  const auto = useId();
  const cid = id ?? `cb${auto}`;
  const box = (
    <span className="emp-check-hit">
      <RC.Root
        id={cid}
        name={name}
        className={cn("emp-check", !label && className)}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(v) => onCheckedChange?.(v === true)}
        disabled={disabled}
        data-error={error ? "" : undefined}
        aria-label={aria["aria-label"]}
      >
        <RC.Indicator className="flex items-center justify-center" style={{ color: "var(--accent-contrast)" }}>
          {checked === "indeterminate" ? (
            <span className="emp-check-bar" />
          ) : (
            <CheckMark />
          )}
        </RC.Indicator>
      </RC.Root>
    </span>
  );
  if (!label) return box;
  return (
    <div className={cn("emp-check-row items-start", className)} data-disabled={disabled ? "" : undefined}>
      <span style={{ paddingTop: 2 }}>{box}</span>
      <label htmlFor={cid} className="flex flex-col gap-0.5" style={{ paddingLeft: 4 }}>
        <span>{label}</span>
        {description ? <span className="text-body-sm text-tertiary">{description}</span> : null}
      </label>
    </div>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden>
      <m.path
        d="M2.5 6.4 4.9 8.7 9.6 3.6"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.18, ease: ease.out }}
      />
    </svg>
  );
}
