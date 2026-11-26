/**
 * Pointer light (docs/DESIGN.md §4.6) + tilt (§6.3 KpiTile, ≤ 3°).
 *
 * ONE global `pointermove` listener on `document`, coalesced with rAF. CSS variables are written only on the
 * element under the pointer:
 *   [data-light]  → --mx / --my (px, relative to the element) and data-lit="1" (edge light + specular fade in)
 *   [data-tilt]   → --rx / --ry (deg, max `data-tilt` value or 3) and data-tilting while tracking
 * Leaving resets the element (the CSS transition returns it on the magnet spring). Effects are skipped under
 * reduced effects (light) and reduced motion (tilt). Installed once by MotionProvider; ref-counted.
 */
import { isReducedEffects, isReducedMotion } from "./useReducedEffects";

let refs = 0;
let frame = 0;
let lastEvent: PointerEvent | null = null;
let litEl: HTMLElement | null = null;
let tiltEl: HTMLElement | null = null;

function clearLit() {
  if (litEl) litEl.setAttribute("data-lit", "0");
  litEl = null;
}
function clearTilt() {
  if (tiltEl) {
    tiltEl.style.removeProperty("--rx");
    tiltEl.style.removeProperty("--ry");
    tiltEl.removeAttribute("data-tilting");
  }
  tiltEl = null;
}

function apply() {
  frame = 0;
  const e = lastEvent;
  if (!e) return;
  const target = e.target instanceof Element ? e.target : null;
  const fx = !isReducedEffects();

  const light = fx && target ? (target.closest("[data-light]") as HTMLElement | null) : null;
  if (light !== litEl) clearLit();
  if (light) {
    const r = light.getBoundingClientRect();
    light.style.setProperty("--mx", `${Math.round(e.clientX - r.left)}px`);
    light.style.setProperty("--my", `${Math.round(e.clientY - r.top)}px`);
    if (litEl !== light) light.setAttribute("data-lit", "1");
    litEl = light;
  }

  const tilt = fx && !isReducedMotion() && target && e.pointerType !== "touch" ? (target.closest("[data-tilt]") as HTMLElement | null) : null;
  if (tilt !== tiltEl) clearTilt();
  if (tilt) {
    const r = tilt.getBoundingClientRect();
    const max = Math.min(3, Number(tilt.getAttribute("data-tilt")) || 3);
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    tilt.style.setProperty("--rx", `${(-py * 2 * max).toFixed(2)}deg`);
    tilt.style.setProperty("--ry", `${(px * 2 * max).toFixed(2)}deg`);
    tilt.setAttribute("data-tilting", "");
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
  }
  return () => {
    if (--refs > 0) return;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerdown", onPointerDown);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    onLeave();
  };
}
