import { useEffect, useRef } from "react";
import { css } from "./tokens";
import { isReducedEffects, isReducedMotion } from "./useReducedEffects";

let enabled = true;
/** Mirror of VaultSettings.celebrations (Settings → Celebrations). */
export function setCelebrationsEnabled(on: boolean): void {
  enabled = on;
}

const CHECK =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:emp-check-draw 240ms cubic-bezier(.2,0,0,1) 120ms forwards" d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** Isometric mini-slab (the icon's slab geometry: top rhombus + two side faces). Ink tones, or the gain colour. */
function slabSvg(size: number, gain: boolean): string {
  const top = gain ? "var(--gain)" : "var(--chart-line)";
  const left = gain ? "color-mix(in oklab, var(--gain) 70%, black)" : "color-mix(in oklab, var(--chart-line) 62%, var(--bg-canvas))";
  const right = gain ? "color-mix(in oklab, var(--gain) 50%, black)" : "color-mix(in oklab, var(--chart-line) 40%, var(--bg-canvas))";
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">
<path d="M10 3 18 7.2 10 11.4 2 7.2Z" style="fill:${top}"/>
<path d="M2 7.2 10 11.4V15.4L2 11.2Z" style="fill:${left}"/>
<path d="M18 7.2 10 11.4V15.4L18 11.2Z" style="fill:${right}"/>
</svg>`;
}

export interface CelebrateOptions {
  /** Show the check badge (default true). */
  badge?: boolean;
  /** Number of mini-slabs (16–22, default 18). */
  particles?: number;
  /** Badge glow (goal reached). */
  glow?: boolean;
}

function originOf(at: HTMLElement | { x: number; y: number }) {
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return at;
}

function host(x: number, y: number) {
  const h = document.createElement("div");
  h.setAttribute("aria-hidden", "true");
  h.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;z-index:95;pointer-events:none;`;
  document.body.appendChild(h);
  return h;
}

/**
 * Goal reached (docs/DESIGN.md S8): 16–22 isometric mini-slabs burst on precomputed parabolas (WAAPI, gravity,
 * 1100ms, spin ≤ 540°) plus a gain check badge that pops on the `pop` spring with --glow-gain. Particles are skipped
 * under reduced motion / effects; the badge crossfades under reduced motion. Disabled via Settings → Celebrations.
 */
export function celebrate(at: HTMLElement | { x: number; y: number }, opts: CelebrateOptions = {}): void {
  if (!enabled || typeof document === "undefined") return;
  const { x, y } = originOf(at);
  const reduced = isReducedMotion();
  const h = host(x, y);
  const done: Promise<unknown>[] = [];

  if (!reduced && !isReducedEffects()) {
    const n = Math.max(16, Math.min(22, opts.particles ?? 18));
    const gainIdx = Math.floor(Math.random() * n);
    for (let i = 0; i < n; i++) {
      const size = 6 + Math.round(Math.random() * 4) + 6; // svg box incl. padding → 6–10px slab
      const p = document.createElement("span");
      p.innerHTML = slabSvg(size, i === gainIdx || i === (gainIdx + 7) % n);
      p.style.cssText = `position:absolute;left:${-size / 2}px;top:${-size / 2}px;width:${size}px;height:${size}px;will-change:transform,opacity;`;
      h.appendChild(p);
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;
      const v = 150 + Math.random() * 120; // px/s initial speed
      const vx = Math.cos(angle) * v;
      const vy = Math.sin(angle) * v;
      const g = 520; // px/s²
      const spin = (Math.random() - 0.5) * 1080;
      const steps = 8;
      const frames: Keyframe[] = [];
      for (let k = 0; k <= steps; k++) {
        const t = (k / steps) * 1.1;
        const px = vx * t;
        const py = vy * t + 0.5 * g * t * t;
        frames.push({
          transform: `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) rotate(${((spin * k) / steps).toFixed(0)}deg) scale(${k === 0 ? 0.4 : 1})`,
          opacity: k < steps * 0.65 ? 1 : 1 - (k - steps * 0.65) / (steps * 0.35),
        });
      }
      const a = p.animate(frames, { duration: 1100, easing: "linear", fill: "forwards", delay: Math.random() * 40 });
      done.push(a.finished.catch(() => undefined));
    }
  }

  if (opts.badge !== false) {
    const b = document.createElement("span");
    b.innerHTML = CHECK;
    b.className = "emp-celebrate-badge";
    if (opts.glow !== false) b.setAttribute("data-glow", "");
    h.appendChild(b);
    const anim = reduced
      ? b.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 900 })
      : b.animate(
          [
            { transform: "scale(0)", opacity: 0 },
            { transform: "scale(1.21)", opacity: 1, offset: 0.28 },
            { transform: "scale(.955)", offset: 0.55 },
            { transform: "scale(1)", offset: 0.75 },
            { transform: "scale(1)", opacity: 1, offset: 0.85 },
            { transform: "scale(.9)", opacity: 0 },
          ],
          { duration: 1200, easing: css.easeOut, fill: "forwards" },
        );
    done.push(anim.finished.catch(() => undefined));
  }
  Promise.all(done).finally(() => h.remove());
  window.setTimeout(() => h.remove(), 2000);
}

/**
 * Task completion burst (S13): 8 ink rays (1px × 10px) shoot out 280ms around the element (checkbox).
 * Transform/opacity only; skipped under reduced motion or effects.
 */
export function burst(at: HTMLElement | { x: number; y: number }, opts: { rays?: number; radius?: number; color?: string } = {}): void {
  if (!enabled || typeof document === "undefined" || isReducedMotion() || isReducedEffects()) return;
  const { x, y } = originOf(at);
  const h = host(x, y);
  const n = opts.rays ?? 8;
  const r = opts.radius ?? 11;
  const done: Promise<unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const deg = (360 / n) * i;
    const ray = document.createElement("span");
    ray.style.cssText = `position:absolute;left:-0.5px;top:-5px;width:1px;height:10px;border-radius:1px;background:${opts.color ?? "var(--chart-line)"};transform-origin:50% 50%;`;
    h.appendChild(ray);
    done.push(
      ray
        .animate(
          [
            { transform: `rotate(${deg}deg) translateY(${-r + 4}px) scaleY(.2)`, opacity: 0.9 },
            { transform: `rotate(${deg}deg) translateY(${-r - 6}px) scaleY(1)`, opacity: 0.8, offset: 0.5 },
            { transform: `rotate(${deg}deg) translateY(${-r - 10}px) scaleY(.1)`, opacity: 0 },
          ],
          { duration: 280, easing: css.easeOut, fill: "forwards" },
        )
        .finished.catch(() => undefined),
    );
  }
  Promise.all(done).finally(() => h.remove());
  window.setTimeout(() => h.remove(), 800);
}

/** Alias (KIT.md): `confetti(el)` = `celebrate(el, { badge: false })`. */
export function confetti(at: HTMLElement | { x: number; y: number }, particles?: number): void {
  celebrate(at, { badge: false, particles });
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

/** Alias for the KIT: <Confetti fire={n} /> bursts mini-slabs without the badge. */
export function Confetti({ fire }: { fire: unknown }) {
  return <Celebrate fire={fire} badge={false} />;
}
