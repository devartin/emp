/**
 * Motion helpers for the editor and database areas (docs/DESIGN.md §5, S13/S14/S21/S22).
 *
 * WAAPI cannot read `var(--spring-*)`, so `springEase()` resolves the CSS `linear()` spring curves (material.css) once
 * and hands back `{ easing, duration }` for `el.animate`. Everything here animates transform / opacity / filter only
 * and is a no-op under reduced motion (callers that need a crossfade pass `fadeOnly`).
 */
import { css, type SpringName } from '@/ui/motion/tokens';
import { isReducedEffects, isReducedMotion } from '@/ui/motion/useReducedEffects';

const FALLBACK: Record<SpringName, { easing: string; duration: number }> = {
  release: { easing: 'cubic-bezier(.34,1.4,.64,1)', duration: 490 },
  thumb: { easing: 'cubic-bezier(.34,1.4,.64,1)', duration: 490 },
  pop: { easing: 'cubic-bezier(.34,1.8,.64,1)', duration: 710 },
  glide: { easing: css.easeOutExpo, duration: 440 },
  settle: { easing: css.easeOutExpo, duration: 460 },
  morph: { easing: css.easeOutExpo, duration: 380 },
  roll: { easing: css.easeOutExpo, duration: 600 },
  magnet: { easing: 'cubic-bezier(.34,1.4,.64,1)', duration: 630 },
  drag: { easing: css.easeOutExpo, duration: 520 },
};

const cache = new Map<SpringName, { easing: string; duration: number }>();

/** The CSS spring curve (`linear(…)`) and its settle time in ms, for WAAPI. */
export function springEase(name: SpringName): { easing: string; duration: number } {
  const hit = cache.get(name);
  if (hit) return hit;
  let out = FALLBACK[name];
  try {
    const cs = getComputedStyle(document.documentElement);
    const key = name === 'drag' || name === 'magnet' ? 'release' : name;
    const curve = cs.getPropertyValue(`--spring-${key}`).trim();
    const dur = parseFloat(cs.getPropertyValue(`--dur-${key}`));
    if (curve.startsWith('linear(') && typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', curve)) {
      out = { easing: curve, duration: Number.isFinite(dur) && dur > 0 ? dur : out.duration };
    }
  } catch {
    /* computed style unavailable (tests) */
  }
  cache.set(name, out);
  return out;
}

export const reducedMotion = (): boolean => isReducedMotion();
export const reducedEffects = (): boolean => isReducedEffects();

/** Animate with a named spring; returns null under reduced motion. */
export function springAnimate(el: Element, frames: Keyframe[], name: SpringName, opts: KeyframeAnimationOptions = {}): Animation | null {
  if (isReducedMotion() || typeof (el as HTMLElement).animate !== 'function') return null;
  const s = springEase(name);
  return (el as HTMLElement).animate(frames, { duration: s.duration, easing: s.easing, ...opts });
}

/** Opacity-only crossfade used as the reduced-motion stand-in for travel. */
export function crossfade(el: Element, ms = 140): Animation | null {
  if (typeof (el as HTMLElement).animate !== 'function') return null;
  return (el as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'linear' });
}

/**
 * "Lands" an element that was just placed: it travels from `from` (a viewport rect it visually occupied, e.g. a drag
 * ghost) to its slot on the settle spring, then a 1px contact squash (S14 / S22 physical drop).
 */
export function landFrom(el: HTMLElement, from: { left: number; top: number } | null, opts: { scale?: number; rotate?: number } = {}): void {
  if (isReducedMotion()) {
    crossfade(el, 120);
    return;
  }
  const r = el.getBoundingClientRect();
  const dx = from ? from.left - r.left : 0;
  const dy = from ? from.top - r.top : 0;
  const s = springEase('settle');
  const lifted = `translate(${dx}px, ${dy}px) scale(${opts.scale ?? 1.03}) rotate(${opts.rotate ?? 0}deg)`;
  const a = el.animate([{ transform: lifted }, { transform: 'none' }], { duration: s.duration * 0.8, easing: s.easing });
  a.onfinish = () => {
    // contact squash: the slab meets the surface (transform-origin bottom so it compresses onto its base)
    el.animate(
      [
        { transform: 'scale(1, 1)', transformOrigin: '50% 100%' },
        { transform: 'scale(1.006, 0.985)', transformOrigin: '50% 100%', offset: 0.35 },
        { transform: 'scale(1, 1)', transformOrigin: '50% 100%' },
      ],
      { duration: 200, easing: css.easeOut },
    );
  };
}

/** Rows / cards rise in with a capped stagger (S21: 16ms rows, 40ms cards; cap 12 / 8; total ≤ 320ms). */
export function riseStagger(els: ArrayLike<Element>, opts: { step?: number; cap?: number; y?: number; x?: number; delay?: number } = {}): void {
  const list = Array.from(els) as HTMLElement[];
  if (!list.length) return;
  if (isReducedMotion()) {
    for (const el of list.slice(0, 24)) crossfade(el, 120);
    return;
  }
  const step = opts.step ?? 16;
  const cap = opts.cap ?? 12;
  const s = springEase('settle');
  const y = opts.y ?? 8;
  const x = opts.x ?? 0;
  list.forEach((el, i) => {
    const k = Math.min(i, cap);
    if (i > cap + 24) return; // far below the fold: no animation at all
    // the individual `translate` property composes with any positioning transform (virtualised rows use translateY)
    el.animate([{ opacity: 0, translate: `${x}px ${y}px` }, { opacity: 1, translate: '0 0' }], {
      duration: s.duration,
      easing: s.easing,
      delay: (opts.delay ?? 0) + Math.min(k * step, 320),
      fill: 'backwards',
    });
  });
}

/** Rough font-size (px) of a block content type, for the turn-into text morph. */
export function blockFontPx(type: string, level: number | null, proseEl: Element): number {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
  if (type === 'heading') return ((level === 1 ? 30 : level === 2 ? 24 : 20) * rem) / 14;
  if (type === 'quote') return (18 * rem) / 14;
  return parseFloat(getComputedStyle(proseEl).fontSize) || 16;
}
