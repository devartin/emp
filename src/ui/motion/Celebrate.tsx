import { animate } from "motion/react";
import { useEffect, useRef } from "react";
import { spring } from "./tokens";
import { isReducedEffects, isReducedMotion } from "./useReducedEffects";

let enabled = true;
/** Mirror of VaultSettings.celebrations (Settings → Celebrations). */
export function setCelebrationsEnabled(on: boolean): void {
  enabled = on;
}

const COLORS = ["var(--accent-solid)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)", "var(--cat-6)", "var(--gain)"];
const CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

export interface CelebrateOptions {
  /** Show the check badge (default true). */
  badge?: boolean;
  particles?: number;
}

/**
 * Confetti-lite (§4.2 "Celebration"): 10 particles burst radially 40–80px plus a check badge that pops in with
 * spring.bouncy; 600ms total. No particles under reduced motion / reduced effects; disabled via setting.
 */
export function celebrate(at: HTMLElement | { x: number; y: number }, opts: CelebrateOptions = {}): void {
  if (!enabled || typeof document === "undefined") return;
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  } else {
    x = at.x;
    y = at.y;
  }
  const reduced = isReducedMotion();
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;z-index:95;pointer-events:none;`;
  document.body.appendChild(host);
  const done: Promise<unknown>[] = [];

  if (!reduced && !isReducedEffects()) {
    const n = opts.particles ?? 10;
    const offset = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("span");
      const size = 4 + Math.round(Math.random() * 3);
      const round = i % 3 === 0 ? "1px" : "50%";
      p.style.cssText = `position:absolute;left:${-size / 2}px;top:${-size / 2}px;width:${size}px;height:${size}px;border-radius:${round};background:${COLORS[i % COLORS.length]};will-change:transform,opacity;`;
      host.appendChild(p);
      const angle = offset + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const dist = 40 + Math.random() * 40;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const a = p.animate(
        [
          { transform: "translate3d(0,0,0) scale(1) rotate(0deg)", opacity: 1 },
          { transform: `translate3d(${dx * 0.85}px,${dy * 0.85}px,0) scale(1) rotate(${(Math.random() - 0.5) * 180}deg)`, opacity: 1, offset: 0.55 },
          { transform: `translate3d(${dx}px,${dy + 8}px,0) scale(0.5) rotate(${(Math.random() - 0.5) * 360}deg)`, opacity: 0 },
        ],
        { duration: 600, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
      );
      done.push(a.finished.catch(() => undefined));
    }
  }

  if (opts.badge !== false) {
    const b = document.createElement("span");
    b.innerHTML = CHECK;
    b.style.cssText =
      "position:absolute;left:-10px;top:-10px;width:20px;height:20px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:var(--accent-solid);color:var(--accent-contrast);box-shadow:var(--elev-2);";
    host.appendChild(b);
    if (reduced) {
      done.push(b.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 600 }).finished.catch(() => undefined));
    } else {
      const pop = animate(b, { scale: [0, 1] }, spring.bouncy);
      done.push(
        Promise.resolve(pop).then(() =>
          b.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.9)" }], { duration: 160, delay: 220, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished,
        ).catch(() => undefined),
      );
    }
  }
  Promise.all(done).finally(() => host.remove());
  window.setTimeout(() => host.remove(), 1600);
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
