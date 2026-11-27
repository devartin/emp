/**
 * Shell motion gate (brief §4, §2.1). The sidebar's hide/show is a 200ms transform and the columns beside it glide
 * with a FLIP, but **no resting position depends on an animation finishing**:
 *
 * - the sidebar's resting transform comes from its `data-state` in CSS; a CSS transition only runs while the gate is
 *   open (`data-motion`), so a state change made while the window is hidden (WebKitGTK doesn't run frames for a
 *   hidden window) simply lands at rest;
 * - the FLIPs use the Web Animations API, which never writes the element's style: if one is dropped, the element is
 *   already where it belongs.
 *
 * The gate opens 400ms after the window is visible and closes when it is hidden or motion is reduced (everything is
 * then instant).
 */
import { useEffect, useState } from "react";
import { css } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";

/** Sidebar show / hide and the FLIPs that accompany them (brief §4: a 200ms transform both ways; register: sidebarToggle). */
export const SIDEBAR_MS = 200;
export const SIDEBAR_OUT_MS = 200;

function visible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

export function useShellMotion(): boolean {
  const reduced = useReducedMotionPref();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let t: number | undefined;
    const update = () => {
      window.clearTimeout(t);
      if (visible()) t = window.setTimeout(() => setReady(true), 400);
      else setReady(false);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return ready && !reduced;
}

/** Slide `el` from `dx` px back to where it now rests (transform only, never written to its style). */
export function flipX(el: HTMLElement | null, dx: number, ms = SIDEBAR_MS): void {
  if (!el || !dx || !visible() || typeof el.animate !== "function") return;
  try {
    el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: ms, easing: css.easeOut });
  } catch {
    /* no WAAPI: the element is already at rest */
  }
}
