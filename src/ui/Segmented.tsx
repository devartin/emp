import * as RR from "@radix-ui/react-radio-group";
import { LayoutGroup, m } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { spring } from "./motion/tokens";
import { isReducedMotion } from "./motion/useReducedEffects";

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
 * Segmented control (docs/DESIGN.md §6.2): a recessed well bed with a secondary-slab indicator that glides between
 * options by layout projection (never `width`) on the `glide` spring, squashing with travel distance. Press squashes
 * the indicator to .975. Arrow keys move selection (Radix roving focus).
 */
export function Segmented<V extends string = string>({ value, onValueChange, options, size = "md", block, className, ...aria }: SegmentedProps<V>) {
  const group = useId();
  const root = useRef<HTMLDivElement>(null);
  const prev = useRef(value);

  // Velocity squash: scaleX = 1 + min(|travel| / 900, .14), as a one-shot on the face (projection owns the box).
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (from === value || isReducedMotion() || !root.current) return;
    const items = Array.from(root.current.querySelectorAll<HTMLElement>(".emp-seg-item"));
    const a = items[options.findIndex((o) => o.value === from)];
    const b = items[options.findIndex((o) => o.value === value)];
    const face = root.current.querySelector<HTMLElement>(".emp-seg-face");
    if (!a || !b || !face) return;
    const dist = Math.abs(b.offsetLeft - a.offsetLeft);
    const s = 1 + Math.min(dist / 900, 0.14);
    face.animate([{ transform: "scaleX(1)" }, { transform: `scaleX(${s}) scaleY(${(1 / Math.sqrt(s)).toFixed(3)})`, offset: 0.35 }, { transform: "scaleX(1)" }], {
      duration: 440,
      easing: "cubic-bezier(.2,0,0,1)",
    });
  }, [value, options]);

  return (
    <LayoutGroup id={group}>
      <RR.Root
        ref={root}
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
              <m.span layoutId="seg-pill" className="emp-seg-indicator" transition={spring.glide} style={{ borderRadius: 7 }}>
                <span className="emp-seg-face" />
              </m.span>
            ) : null}
            {renderIcon(o.icon)}
            {o.label}
          </RR.Item>
        ))}
      </RR.Root>
    </LayoutGroup>
  );
}
