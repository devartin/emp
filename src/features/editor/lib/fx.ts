/**
 * Motion helpers for the editor and database areas (docs/DESIGN.md §5, S13/S14/S21/S22).
 *
 * WAAPI cannot read `var(--spring-*)`, so `springEase()` resolves the CSS `linear()` spring curves (material.css) once
 * and hands back `{ easing, duration }` for `el.animate`. Everything here animates transform / opacity / filter only
 * and is a no-op under reduced motion (callers that need a crossfade pass `fadeOnly`).
 */
import { css, type SpringName } from '@/ui/motion/tokens';
import { isReducedEffects, isReducedMotion } from '@/ui/motion/useReducedEffects';

/**
 * v3 (docs/DESIGN.md §7): no overshoot outside the three C3 moments, so every named curve is the ease-out tween and
 * travel is capped at the C2 budget (220ms). The names are kept so callers need not change.
 */
const C2_MAX = 220;

/** The ease-out curve and a C2-capped duration in ms, for WAAPI. */
export function springEase(name: SpringName): { easing: string; duration: number } {
  void name;
  return { easing: css.easeOut, duration: C2_MAX };
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

/** A dropped element travels from where the drag ghost was to its slot (C2 drag and drop, 220ms, no squash). */
export function landFrom(el: HTMLElement, from: { left: number; top: number } | null): void {
  if (isReducedMotion() || !from || typeof el.animate !== 'function') return;
  const r = el.getBoundingClientRect();
  const dx = from.left - r.left;
  const dy = from.top - r.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: C2_MAX, easing: css.easeOut });
}

/** Retired: content is present at frame 1 and stagger is 0 (docs/DESIGN.md §7). Kept as a no-op for callers. */
export function riseStagger(els: ArrayLike<Element>, opts: { step?: number; cap?: number; y?: number; x?: number; delay?: number } = {}): void {
  void els;
  void opts;
}
