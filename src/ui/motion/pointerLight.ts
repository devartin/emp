/**
 * Pointer light (docs/DESIGN.md §4.6) + tilt (§6.3 KpiTile, ≤ 3°).
 *
 * ONE global `pointermove` listener on `document`, coalesced with rAF. CSS variables are written only on the
 * element under the pointer:
 *   [data-light]  → data-lit="1" on the host (edge light + specular fade in) and --mx / --my (px, relative to the
 *                   host) on its direct `.emp-edge` / `.emp-specular` children only — never on the host, which would
 *                   restyle every descendant each frame
 *   [data-tilt]   → --rx / --ry (deg, max `data-tilt` value or 3) and data-tilting while tracking
 * Leaving resets the element (the CSS transition returns it on the magnet spring). Effects are skipped under
 * reduced effects (light) and reduced motion (tilt). Installed once by MotionProvider; ref-counted.
 */
import { isReducedEffects, isReducedMotion } from "./useReducedEffects";

let refs = 0;
let frame = 0;
let lastEvent: PointerEvent | null = null;
let litEl: HTMLElement | null = null;
let litSpans: HTMLElement[] = [];
let litRect: { left: number; top: number } | null = null;
let tiltEl: HTMLElement | null = null;
let tiltRect: { cx: number; cy: number; w: number; h: number } | null = null;

/**
 * Host rects are read ONCE when the pointer enters a host (and again after a scroll/resize invalidates them), never
 * per frame: a per-frame getBoundingClientRect after a style write forces layout, and on a tilted host it returns the
 * projected box, feeding the tilt back into the next frame.
 */
function invalidateRects() {
  litRect = null;
  tiltRect = null;
}

function clearLit() {
  if (litEl) litEl.setAttribute("data-lit", "0");
  litEl = null;
  litSpans = [];
  litRect = null;
}
function clearTilt() {
  if (tiltEl) {
    tiltEl.style.removeProperty("--rx");
    tiltEl.style.removeProperty("--ry");
    tiltEl.removeAttribute("data-tilting");
  }
  tiltEl = null;
  tiltRect = null;
}

function apply() {
  frame = 0;
  const e = lastEvent;
  if (!e) return;
  const target = e.target instanceof Element ? e.target : null;
  const fx = !isReducedEffects();

  // Resolve both hosts and read any rects BEFORE writing anything (no read-after-write within the frame).
  const light = fx && target ? (target.closest("[data-light]") as HTMLElement | null) : null;
  const tilt = fx && !isReducedMotion() && target && e.pointerType !== "touch" ? (target.closest("[data-tilt]") as HTMLElement | null) : null;
  if (light !== litEl) {
    clearLit();
    if (light) {
      litEl = light;
      // Variables go on the light spans only, so just 1–2 elements restyle per frame (not the whole card subtree).
      litSpans = Array.from(light.querySelectorAll<HTMLElement>(":scope > .emp-edge, :scope > .emp-specular"));
      light.setAttribute("data-lit", "1");
    }
  }
  if (tilt !== tiltEl) clearTilt();
  if (light && !litRect) {
    if (light === tilt && tiltRect) litRect = { left: tiltRect.cx - tiltRect.w / 2, top: tiltRect.cy - tiltRect.h / 2 };
    else {
      const r = light.getBoundingClientRect();
      // offsetWidth/Height ignore transforms: centre the untransformed box on the (possibly tilted) projected one.
      const w = light.offsetWidth || r.width;
      const h = light.offsetHeight || r.height;
      litRect = { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - h / 2 };
    }
  }
  if (tilt && !tiltRect) {
    const r = tilt.getBoundingClientRect();
    tiltRect = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: tilt.offsetWidth || r.width, h: tilt.offsetHeight || r.height };
  }

  if (light && litRect) {
    const mx = `${Math.round(e.clientX - litRect.left)}px`;
    const my = `${Math.round(e.clientY - litRect.top)}px`;
    for (const sp of litSpans) {
      sp.style.setProperty("--mx", mx);
      sp.style.setProperty("--my", my);
    }
  }
  if (tilt && tiltRect) {
    const max = Math.min(3, Number(tilt.getAttribute("data-tilt")) || 3);
    const px = Math.max(-0.5, Math.min(0.5, (e.clientX - tiltRect.cx) / tiltRect.w));
    const py = Math.max(-0.5, Math.min(0.5, (e.clientY - tiltRect.cy) / tiltRect.h));
    tilt.style.setProperty("--rx", `${(-py * 2 * max).toFixed(2)}deg`);
    tilt.style.setProperty("--ry", `${(px * 2 * max).toFixed(2)}deg`);
    if (tiltEl !== tilt) tilt.setAttribute("data-tilting", "");
    tiltEl = tilt;
  }
}

function onMove(e: PointerEvent) {
  lastEvent = e;
  if (!frame) frame = requestAnimationFrame(apply);
}
function onLeave() {
  lastEvent = null;
  clearLit();
  clearTilt();
}
function onPointerDown() {
  // Pressing a tilted card flattens it so the press reads as straight down.
  clearTilt();
}

/** Install the global listener; returns an uninstall function (ref-counted). */
export function installPointerLight(): () => void {
  if (typeof document === "undefined") return () => undefined;
  if (refs++ === 0) {
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    window.addEventListener("scroll", invalidateRects, { passive: true, capture: true });
    window.addEventListener("resize", invalidateRects, { passive: true });
  }
  return () => {
    if (--refs > 0) return;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerdown", onPointerDown);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
    window.removeEventListener("scroll", invalidateRects, { capture: true });
    window.removeEventListener("resize", invalidateRects);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    onLeave();
  };
}
