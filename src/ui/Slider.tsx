import * as RSl from "@radix-ui/react-slider";
import { useState, type FocusEvent, type PointerEvent } from "react";
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
  /** Engraved tick marks every 10% (default true). */
  ticks?: boolean;
  className?: string;
  /** Pass-throughs (e.g. commit a live preview when the thumb is released or focus leaves). */
  onPointerUp?: (e: PointerEvent<HTMLSpanElement>) => void;
  onBlur?: (e: FocusEvent<HTMLSpanElement>) => void;
  "aria-label"?: string;
}

/**
 * Slider (docs/DESIGN.md §6.2): a 6px recessed groove with engraved ticks every 10%, a lit fill drawn with
 * `scaleX(var(--v))` (transform, never width), and an 18px dome keycap thumb that scales to 1.12 while dragging.
 * The value pill rises in over 120ms. Dragging is 1:1.
 */
export function Slider({ value, defaultValue, onValueChange, onValueCommit, min = 0, max = 100, step = 1, disabled, formatValue = String, ticks = true, className, onPointerUp, onBlur, ...aria }: SliderProps) {
  const [inner, setInner] = useState(defaultValue ?? [min]);
  const v = value ?? inner;
  const [dragging, setDragging] = useState(false);
  const single = v.length === 1;
  const frac = single && max > min ? Math.max(0, Math.min(1, (v[0] - min) / (max - min))) : 0;
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
      onPointerUp={(e) => {
        setDragging(false);
        onPointerUp?.(e);
      }}
      onBlur={onBlur}
      onLostPointerCapture={() => setDragging(false)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-dragging={dragging ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      data-single={single ? "" : undefined}
    >
      <RSl.Track className="emp-slider-track">
        {single ? <span className="emp-slider-fill" style={{ ["--v" as string]: frac }} /> : null}
        <RSl.Range className="emp-slider-range" />
      </RSl.Track>
      {ticks ? (
        <span className="emp-slider-ticks" aria-hidden>
          {Array.from({ length: 11 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      ) : null}
      {v.map((val, i) => (
        <RSl.Thumb key={i} className="emp-slider-thumb" aria-label={aria["aria-label"]}>
          <span className="emp-slider-value tabular">{formatValue(val)}</span>
        </RSl.Thumb>
      ))}
    </RSl.Root>
  );
}
