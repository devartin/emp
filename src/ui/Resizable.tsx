import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ResizableProps {
  width: number;
  onWidthChange: (w: number) => void;
  /** Fired once at the end of a drag (persist here). */
  onResizeEnd?: (w: number) => void;
  min: number;
  max: number;
  /** Double-click resets to this width (§5.8). */
  defaultWidth?: number;
  /** Which edge carries the 6px handle. */
  side?: "right" | "left";
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

/**
 * Horizontally resizable panel with a 6px handle; a 1px accent line appears after 150ms of hover (§5.8).
 * Keyboard: ←/→ resize by 8px (Shift 32px) when the handle is focused. Uses pointer capture; no layout thrash.
 */
export function Resizable({ width, onWidthChange, onResizeEnd, min, max, defaultWidth, side = "right", children, className, style, ...aria }: ResizableProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });
  const latest = useRef(width);
  latest.current = width;
  const clamp = useCallback((w: number) => Math.round(Math.max(min, Math.min(max, w))), [min, max]);

  return (
    <div className={cn("relative flex-none", className)} style={{ width, ...style }}>
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={width}
        aria-label={aria["aria-label"] ?? "Resize"}
        tabIndex={0}
        className="emp-resize-handle no-drag"
        data-side={side}
        data-dragging={dragging ? "" : undefined}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, w: latest.current };
          setDragging(true);
          document.body.style.cursor = "col-resize";
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const dx = e.clientX - start.current.x;
          onWidthChange(clamp(start.current.w + (side === "right" ? dx : -dx)));
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          setDragging(false);
          document.body.style.cursor = "";
          onResizeEnd?.(latest.current);
        }}
        onDoubleClick={() => {
          if (defaultWidth !== undefined) {
            onWidthChange(defaultWidth);
            onResizeEnd?.(defaultWidth);
          }
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 32 : 8;
          const grow = side === "right" ? "ArrowRight" : "ArrowLeft";
          const shrink = side === "right" ? "ArrowLeft" : "ArrowRight";
          if (e.key === grow || e.key === shrink) {
            e.preventDefault();
            const w = clamp(latest.current + (e.key === grow ? step : -step));
            onWidthChange(w);
            onResizeEnd?.(w);
          }
        }}
      />
    </div>
  );
}
