import * as RSl from "@radix-ui/react-slider";
import { useState } from "react";
import { cn } from "@/lib/cn";

export interface SliderProps {
  value?: number[];
  defaultValue?: number[];
  onValueChange?: (v: number[]) => void;
  onValueCommit?: (v: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Format for the value tooltip above the thumb. */
  formatValue?: (n: number) => string;
  className?: string;
  "aria-label"?: string;
}

/** Slider (§5.4): 4px track, accent fill, 16px white thumb that scales to 1.15 while dragging, value tooltip. */
export function Slider({ value, defaultValue, onValueChange, onValueCommit, min = 0, max = 100, step = 1, disabled, formatValue = String, className, ...aria }: SliderProps) {
  const [inner, setInner] = useState(defaultValue ?? [min]);
  const v = value ?? inner;
  const [dragging, setDragging] = useState(false);
  return (
    <RSl.Root
      className={cn("emp-slider", className)}
      value={v}
      onValueChange={(nv) => {
        setInner(nv);
        onValueChange?.(nv);
      }}
      onValueCommit={(nv) => {
        setDragging(false);
        onValueCommit?.(nv);
      }}
      onPointerDown={() => setDragging(true)}
      onPointerUp={() => setDragging(false)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-dragging={dragging ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
    >
      <RSl.Track className="emp-slider-track">
        <RSl.Range className="emp-slider-range" />
      </RSl.Track>
      {v.map((val, i) => (
        <RSl.Thumb key={i} className="emp-slider-thumb" aria-label={aria["aria-label"]}>
          <span className="emp-slider-value tabular">{formatValue(val)}</span>
        </RSl.Thumb>
      ))}
    </RSl.Root>
  );
}
