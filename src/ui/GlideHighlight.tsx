import { useLayoutEffect, useRef } from "react";

export interface GlideHighlightProps {
  /** Selector for the highlighted item inside the container (Radix menus: `[data-highlighted]`; cmdk: `[data-selected="true"]`). */
  selector?: string;
  /** Plate tone: a ghost plate (default), or a raised secondary slab (palette / sidebar style selections). */
  tone?: "ghost" | "slab";
  /** Watched attributes (defaults cover Radix and cmdk). */
  attributes?: string[];
  /**
   * @deprecated the velocity squash is retired in v3 (accepted and ignored). Formerly: the plate stretched along its travel, proportional to the distance jumped
   * (≤ 14%), then settles — the S11 sidebar feel. Uses the independent `scale` property, so it composes with the
   * glide's transform. Off under reduced motion.
   */
  squash?: boolean;
}



/**
 * A single highlight plate under the highlighted item of a menu / palette / list (docs/DESIGN.md §5.5). Render it as a
 * child of the positioned scroll container that holds the items. It moves instantly (register.ts C0): highlight
 * follows the pointer and the arrow keys with no glide.
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
    // v3: the plate moves instantly (register.ts C0); the velocity squash is retired.
    const doSquash = (_dx: number, _dy: number) => {
      void _dx;
      void _dy;
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
