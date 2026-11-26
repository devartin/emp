import { useEffect, useRef } from "react";
import { css } from "./tokens";
import { isReducedMotion } from "./useReducedEffects";

let enabled = true;
/** Mirror of VaultSettings.celebrations (Settings → Celebrations). */
export function setCelebrationsEnabled(on: boolean): void {
  enabled = on;
}

const CHECK =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

export interface CelebrateOptions {
  /** Show the check badge (default true). Without it, celebrate() does nothing. */
  badge?: boolean;
  /** @deprecated particles are retired (no confetti in v3). */
  particles?: number;
  /** @deprecated glows are retired. */
  glow?: boolean;
}

function originOf(at: HTMLElement | { x: number; y: number }) {
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return at;
}

/**
 * A quiet confirmation (register.ts C2): an ink check badge fades in over the element (180ms), holds, then fades out.
 * v3 retired the mini-slab confetti and the ray burst; the three signature moments (vault unlock, life-app build,
 * reconcile success) own their own scenes. Disabled via Settings → Celebrations; a crossfade under reduced motion.
 */
export function celebrate(at: HTMLElement | { x: number; y: number }, opts: CelebrateOptions = {}): void {
  if (!enabled || typeof document === "undefined" || opts.badge === false) return;
  const { x, y } = originOf(at);
  const h = document.createElement("div");
  h.setAttribute("aria-hidden", "true");
  h.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;z-index:95;pointer-events:none;`;
  document.body.appendChild(h);
  const b = document.createElement("span");
  b.innerHTML = CHECK;
  b.className = "emp-celebrate-badge";
  h.appendChild(b);
  const frames = isReducedMotion()
    ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
    : [
        { opacity: 0, transform: "scale(.9)" },
        { opacity: 1, transform: "scale(1)", offset: 0.2 },
        { opacity: 1, transform: "scale(1)", offset: 0.8 },
        { opacity: 0, transform: "scale(1)" },
      ];
  const anim = b.animate(frames, { duration: 900, easing: css.easeOut, fill: "forwards" });
  void anim.finished.catch(() => undefined).finally(() => h.remove());
  window.setTimeout(() => h.remove(), 1500);
}

/** @deprecated the ray burst is retired (register.ts: "the 8-ray burst" removed). A no-op. */
export function burst(_at: HTMLElement | { x: number; y: number }, _opts: { rays?: number; radius?: number; color?: string } = {}): void {
  void _at;
  void _opts;
}

/** @deprecated confetti is retired (no confetti for chores, or at all). A no-op. */
export function confetti(_at: HTMLElement | { x: number; y: number }, _particles?: number): void {
  void _at;
  void _particles;
}

/** Declarative trigger: renders nothing; fires `celebrate` at its parent element whenever `fire` changes (not on mount). */
export function Celebrate({ fire, badge = true }: { fire: unknown; badge?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!fire) return;
    const parent = ref.current?.parentElement;
    if (parent) celebrate(parent, { badge });
  }, [fire, badge]);
  return <span ref={ref} hidden />;
}

/** @deprecated confetti is retired: renders nothing and fires nothing. */
export function Confetti({ fire }: { fire: unknown }) {
  return <Celebrate fire={fire} badge={false} />;
}
