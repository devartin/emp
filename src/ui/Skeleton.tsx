import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  shape?: "rect" | "circle" | "text";
  radius?: number;
  className?: string;
  style?: CSSProperties;
}

/** Skeleton block (§5.10): rgba(text,.06/.07) with a 1.6s linear shimmer (removed under reduced motion). */
export function Skeleton({ width, height = 12, shape = "rect", radius, className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cn("emp-skeleton", className)}
      data-shape={shape === "rect" ? undefined : shape}
      style={{ width, height: shape === "text" ? undefined : height, borderRadius: radius, ...style }}
    />
  );
}

/** Lines of text skeleton with a natural ragged last line. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cn("flex flex-col", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shape="text" width={i === lines - 1 ? "62%" : i % 2 ? "92%" : "100%"} />
      ))}
    </span>
  );
}

/**
 * Skeleton visibility policy (§5.10): only shown when loading lasts > 150ms; once shown, stays ≥ 300ms.
 */
export function useSkeletonDelay(loading: boolean, delay = 150, minShow = 300): boolean {
  const [show, setShow] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    let t: number | undefined;
    if (loading) {
      t = window.setTimeout(() => {
        shownAt.current = Date.now();
        setShow(true);
      }, delay);
    } else if (show) {
      const left = minShow - (Date.now() - shownAt.current);
      t = window.setTimeout(() => setShow(false), Math.max(0, left));
    }
    return () => window.clearTimeout(t);
  }, [loading, delay, minShow, show]);
  return show;
}

/** Skeleton → content crossfade (160ms ease.out) following the delay policy. */
export function SkeletonSwap({ loading, skeleton, children, className }: { loading: boolean; skeleton: ReactNode; children: ReactNode; className?: string }) {
  const show = useSkeletonDelay(loading);
  const pending = loading && !show;
  return (
    <div className={cn("relative", className)} aria-busy={loading || undefined}>
      <AnimatePresence initial={false} mode="popLayout">
        {show ? (
          <m.div key="sk" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
            {skeleton}
          </m.div>
        ) : pending ? (
          <div key="pending" style={{ visibility: "hidden" }}>
            {skeleton}
          </div>
        ) : (
          <m.div key="ct" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
