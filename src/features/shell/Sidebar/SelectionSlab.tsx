/**
 * Sidebar selection slab + hover ghost (docs/DESIGN.md S11, §5.4.4).
 *
 * Render `<SelectionSlab />` as the FIRST child of a positioned list container (a "host"). The selected row
 * (`.emp-sb-row[aria-current="page"]`) sits on a secondary slab (edge 1.5px) that glides between rows on the `glide`
 * spring and squashes with travel distance; a ghost plate follows the hovered row on the slower `morph` spring so it
 * visibly lags. The slab presses with the row (CSS `:has(:active)`), the ghost turns into a pressed well.
 *
 * The sidebar has two hosts (the fixed primary nav and the scrolling sections). When the selection moves between
 * them, the receiving slab starts from the last rect the other one occupied, so it reads as one slab travelling.
 *
 * Transform/opacity only. Positions are read with getBoundingClientRect (rAF-coalesced, all reads before writes) and
 * tracked for a short window after structural mutations so the slab rides along with section collapse morphs and
 * tree reflows. Width-only host resizes (sidebar drag) take the ResizeObserver entry's width without reading rects. Under reduced
 * motion the slab jumps (no glide, no squash) and the ghost appears in place.
 */
import { useLayoutEffect, useRef } from "react";
import { isReducedMotion } from "@/ui/motion/useReducedEffects";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The last viewport rect a selection slab occupied (any host). */
let lastSel: { box: Box; host: HTMLElement; at: number } | null = null;

const TRACK_MS = 620;
const GLIDE_MS = 440;

export interface SelectionSlabProps {
  /** The selected-row selector inside this host. */
  selector?: string;
  /** Rows that get the hover ghost. */
  rowSelector?: string;
}

export function SelectionSlab({ selector = '.emp-sb-row[aria-current="page"]', rowSelector = ".emp-sb-row" }: SelectionSlabProps) {
  const slabRef = useRef<HTMLSpanElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const slab = slabRef.current;
    const ghost = ghostRef.current;
    const host = slab?.parentElement;
    if (!slab || !ghost || !host) return;
    const face = slab.firstElementChild as HTMLElement | null;
    host.setAttribute("data-sel-host", "");

    let target: HTMLElement | null = null;
    let placed: Box | null = null;
    let glideUntil = 0;
    let trackUntil = 0;
    let raf = 0;
    let hover: HTMLElement | null = null;
    let ghostOn = false;
    let hostW = -1;
    let hostH = -1;

    const local = (r: DOMRect, hr: DOMRect): Box => ({ x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height });
    const write = (el: HTMLElement, b: Box) => {
      el.style.width = `${b.w}px`;
      el.style.height = `${b.h}px`;
      el.style.transform = `translate3d(${b.x}px, ${b.y}px, 0)`;
    };

    // A jump writes the box with transitions off (data-jump) and re-enables them two frames later — no forced
    // reflow. A glide queued behind a jump (cross-host travel) is written in that same later frame so it animates
    // from the jumped position.
    const jumping = new Map<HTMLElement, Box | null>();
    let unjumpRaf = 0;
    const unjump = () => {
      // Only release jumps that have been through at least one style pass (they were queued before this frame).
      const ready = [...jumping.entries()];
      unjumpRaf = requestAnimationFrame(() => {
        unjumpRaf = 0;
        for (const [el] of ready) {
          const then = jumping.get(el);
          if (then === undefined) continue;
          jumping.delete(el);
          el.removeAttribute("data-jump");
          if (then) glideTo(el, then);
        }
        if (jumping.size) unjumpRaf = requestAnimationFrame(unjump);
      });
    };
    const jump = (el: HTMLElement, b: Box, then: Box | null = null) => {
      el.setAttribute("data-jump", "");
      write(el, b);
      jumping.set(el, then);
      if (!unjumpRaf) unjumpRaf = requestAnimationFrame(unjump);
    };
    // will-change only while the glide is in flight (cleared on transitionend).
    const glideTo = (el: HTMLElement, b: Box) => {
      if (jumping.has(el)) {
        jumping.set(el, b);
        return;
      }
      el.setAttribute("data-gliding", "");
      write(el, b);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === "transform" && (e.target === slab || e.target === ghost)) (e.target as HTMLElement).removeAttribute("data-gliding");
    };

    const squash = (dist: number) => {
      if (!face || isReducedMotion() || dist < 4) return;
      const s = Math.min(dist / 1040, 0.14);
      face.animate(
        [
          { transform: "scale(1, 1)" },
          { transform: `scale(${1 - s * 0.35}, ${1 + s})`, offset: 0.32 },
          { transform: "scale(1, 1)" },
        ],
        { duration: GLIDE_MS, easing: "cubic-bezier(.3,0,.3,1)" },
      );
    };

    const update = () => {
      raf = 0;
      const now = performance.now();
      // ── read phase: every rect first ──
      const next = host.querySelector<HTMLElement>(selector);
      const hostRect = host.getBoundingClientRect();
      const vr = next ? next.getBoundingClientRect() : null;
      if (hover && !hover.isConnected) hover = null;
      const hr = hover && ghostOn ? hover.getBoundingClientRect() : null;
      const reduced = isReducedMotion();

      // ── write phase ──
      if (!next || !vr) {
        if (target) {
          slab.removeAttribute("data-on");
          target = null;
          placed = null;
        }
      } else {
        const b = local(vr, hostRect);
        if (next !== target) {
          const from = placed ?? (lastSel && lastSel.host !== host && now - lastSel.at < 900 ? local(new DOMRect(lastSel.box.x, lastSel.box.y, lastSel.box.w, lastSel.box.h), hostRect) : null);
          if (from && !reduced) {
            if (!placed) jump(slab, from, b);
            else glideTo(slab, b);
            glideUntil = now + GLIDE_MS;
            squash(Math.abs(b.y - from.y));
          } else {
            jump(slab, b);
          }
          slab.setAttribute("data-on", "");
          target = next;
          placed = b;
        } else if (!placed || Math.abs(placed.x - b.x) > 0.5 || Math.abs(placed.y - b.y) > 0.5 || Math.abs(placed.w - b.w) > 0.5 || Math.abs(placed.h - b.h) > 0.5) {
          // Same row, moved (section morph, tree reflow, resize): ride along exactly unless a glide is in flight.
          if (now < glideUntil) glideTo(slab, b);
          else jump(slab, b);
          placed = b;
        }
        lastSel = { box: { x: vr.left, y: vr.top, w: vr.width, h: vr.height }, host, at: now };
      }
      // the ghost rides with its row too
      if (!hover && ghostOn) {
        ghost.removeAttribute("data-on");
        ghostOn = false;
      } else if (hr) {
        const gb = local(hr, hostRect);
        const cur = ghost.dataset.y ? Number(ghost.dataset.y) : NaN;
        if (Math.abs(cur - gb.y) > 0.5 && !ghost.hasAttribute("data-moving")) jump(ghost, gb);
        ghost.dataset.y = String(gb.y);
      }
      if (now < trackUntil) raf = requestAnimationFrame(update);
    };
    /** Track for a short window (rides along with section morphs / tree reflows). */
    const schedule = () => {
      trackUntil = performance.now() + TRACK_MS;
      if (!raf) raf = requestAnimationFrame(update);
    };
    /** Measure once on the next frame. */
    const measure = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    let ghostTimer = 0;
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const row = (e.target as Element | null)?.closest<HTMLElement>(rowSelector);
      if (!row || !host.contains(row) || row === hover) return;
      const b = local(row.getBoundingClientRect(), host.getBoundingClientRect());
      hover = row;
      ghost.dataset.y = String(b.y);
      if (!ghostOn || isReducedMotion()) jump(ghost, b);
      else {
        glideTo(ghost, b);
        ghost.setAttribute("data-moving", "");
        window.clearTimeout(ghostTimer);
        ghostTimer = window.setTimeout(() => ghost.removeAttribute("data-moving"), 400);
      }
      ghost.setAttribute("data-on", "");
      ghostOn = true;
    };
    const onLeave = () => {
      ghost.removeAttribute("data-on");
      ghostOn = false;
      hover = null;
    };

    // Style writes are not observed: tree rows and motion write inline styles every frame, which would keep the
    // tracking loop (and its rect reads) alive during any layout animation.
    const mo = new MutationObserver(schedule);
    mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "aria-expanded", "data-collapsed"] });
    // Width-only host resizes (sidebar drag) resize the slab/ghost straight from the entry — rows are full-width, so
    // no rect reads. Anything else measures once on the next frame.
    const ro = new ResizeObserver((entries) => {
      const cr = entries[entries.length - 1]?.contentRect;
      if (!cr) return;
      const first = hostW < 0;
      const widthOnly = !first && Math.abs(cr.height - hostH) < 0.5 && Math.abs(cr.width - hostW) >= 0.5;
      hostW = cr.width;
      hostH = cr.height;
      if (widthOnly && !raf) {
        const w = `${cr.width}px`;
        slab.style.width = w;
        ghost.style.width = w;
        if (placed) placed = { ...placed, w: cr.width };
        if (lastSel && lastSel.host === host) lastSel = { ...lastSel, box: { ...lastSel.box, w: cr.width } };
        return;
      }
      if (!first) measure();
    });
    ro.observe(host);
    host.addEventListener("pointerover", onOver);
    host.addEventListener("pointerleave", onLeave);
    slab.addEventListener("transitionend", onEnd);
    ghost.addEventListener("transitionend", onEnd);
    window.addEventListener("resize", measure);
    schedule();
    return () => {
      mo.disconnect();
      ro.disconnect();
      host.removeEventListener("pointerover", onOver);
      host.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", measure);
      slab.removeEventListener("transitionend", onEnd);
      ghost.removeEventListener("transitionend", onEnd);
      window.clearTimeout(ghostTimer);
      if (raf) cancelAnimationFrame(raf);
      if (unjumpRaf) cancelAnimationFrame(unjumpRaf);
      host.removeAttribute("data-sel-host");
    };
  }, [selector, rowSelector]);

  return (
    <>
      <span ref={ghostRef} className="sb-ghost" aria-hidden />
      <span ref={slabRef} className="sb-slab" aria-hidden>
        <span className="sb-slab-face" />
      </span>
    </>
  );
}
