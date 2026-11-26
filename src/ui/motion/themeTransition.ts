/**
 * Theme switch with a View Transitions circular reveal from the toggle centre (420ms ease.inOut, §4.2).
 * Falls back to a 200ms colour crossfade; reduced motion skips the reveal (§4.3).
 */
import { isReducedMotion } from "./useReducedEffects";

export function crossfadeColors(ms = 200): void {
  const root = document.documentElement;
  root.style.setProperty("--emp-switch-ms", `${ms}ms`);
  root.classList.add("emp-accent-switching");
  window.setTimeout(() => root.classList.remove("emp-accent-switching"), ms + 40);
}

export function switchThemeWithReveal(apply: () => void, origin?: { x: number; y: number } | HTMLElement | null): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || isReducedMotion()) {
    crossfadeColors(200);
    apply();
    return;
  }
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  if (origin instanceof HTMLElement) {
    const r = origin.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  } else if (origin) {
    x = origin.x;
    y = origin.y;
  }
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const vt = doc.startViewTransition(() => apply());
  vt.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 420, easing: "cubic-bezier(.65,0,.35,1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {
      /* transition skipped */
    });
}
