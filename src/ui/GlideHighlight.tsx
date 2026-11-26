import { useLayoutEffect, useRef } from "react";
import { isReducedMotion } from "./motion/useReducedEffects";

export interface GlideHighlightProps {
  /** Selector for the highlighted item inside the container (Radix menus: `[data-highlighted]`; cmdk: `[data-selected="true"]`). */
  selector?: string;
  /** Plate tone: a ghost plate (default), or a raised secondary slab (palette / sidebar style selections). */
  tone?: "ghost" | "slab";
  /** Watched attributes (defaults cover Radix and cmdk). */
  attributes?: string[];
  /**
   * Velocity squash: the plate stretches along its travel and thins across it, proportional to the distance jumped
   * (≤ 14%), then settles — the S11 sidebar feel. Uses the independent `scale` property, so it composes with the
   * glide's transform. Off under reduced motion.
   */
  squash?: boolean;
}

const SQUASH_MS = 380;

/**
 * A single highlight plate that glides between items on the `morph` spring instead of each item lighting up on its
 * own (docs/DESIGN.md §6.1 menus, S7 palette). Render it as a child of the positioned scroll container that holds the
 * items. Transform-only; the plate jumps (no glide) when it first appears or under reduced motion.
 */
export function GlideHighlight({ selector = '[data-highlighted], [data-selected="true"]', tone = "ghost", attributes = ["data-highlighted", "data-selected", "aria-selected"], squash = false }: GlideHighlightProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const plate = ref.current;
    const host = plate?.parentElement;
    if (!plate || !host) return;
    host.setAttribute("data-glide-ready", "");
    let shown = false;
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    const doSquash = (dx: number, dy: number) => {
      const dist = Math.hypot(dx, dy);
      if (!squash || dist < 4 || isReducedMotion() || typeof plate.animate !== "function") return;
      const s = Math.min(dist / 1040, 0.14);
      const along = 1 + s;
      const across = 1 - s * 0.35;
      const mid = Math.abs(dy) >= Math.abs(dx) ? `${across} ${along}` : `${along} ${across}`;
      plate.animate([{ scale: "1 1" }, { scale: mid, offset: 0.32 }, { scale: "1 1" }], { duration: SQUASH_MS, easing: "cubic-bezier(.3,0,.3,1)" });
    };
    const update = () => {
      raf = 0;
      const item = host.querySelector<HTMLElement>(selector);
      if (!item || item === plate) {
        plate.removeAttribute("data-on");
        shown = false;
        last = null;
        return;
      }
      const hr = host.getBoundingClientRect();
      const ir = item.getBoundingClientRect();
      const x = ir.left - hr.left + host.scrollLeft;
      const y = ir.top - hr.top + host.scrollTop;
      if (!shown) plate.setAttribute("data-jump", "");
      else if (last && (last.x !== x || last.y !== y)) doSquash(x - last.x, y - last.y);
      last = { x, y };
      plate.style.width = `${ir.width}px`;
      plate.style.height = `${ir.height}px`;
      plate.style.transform = `translate(${x}px, ${y}px)`;
      plate.setAttribute("data-tone", item.hasAttribute("data-destructive") ? "danger" : tone);
      if (!shown) {
        // force the jump to apply before re-enabling the glide transition
        void plate.offsetWidth;
        plate.removeAttribute("data-jump");
      }
      plate.setAttribute("data-on", "");
      shown = true;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(host, { subtree: true, attributes: true, attributeFilter: attributes, childList: true });
    update();
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      host.removeAttribute("data-glide-ready");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector, tone, squash]);
  return <span ref={ref} className="emp-glide" aria-hidden data-tone={tone} />;
}
