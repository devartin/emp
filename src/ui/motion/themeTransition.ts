/**
 * Theme switch with a View Transitions circular reveal from the toggle centre (420ms ease.inOut, §4.2), and the
 * accent / theme colour crossfade (§3.2).
 *
 * The crossfade is ONE root View Transition (old/new snapshots crossfade on the compositor). It replaces the old
 * `* { transition-property: … !important }` class, which restyled every element (250ms+ style tasks at 4× CPU) and
 * replaced in-flight transform transitions so slabs, glides and route entrances snapped to their end values.
 * Without View Transitions, or under reduced motion, colours switch instantly.
 */
import { isViewTransitionActive } from "./viewTransition";
import { isReducedMotion } from "./useReducedEffects";

type VTDoc = Document & { startViewTransition?: (cb: () => void | Promise<void>) => { ready: Promise<void>; finished: Promise<void> } };

const ATTRS = ["data-theme", "data-accent", "data-contrast", "data-numbers"] as const;
type Snap = { attrs: (string | null)[]; scheme: string };

let busy = false;
let armed = false;

function snap(root: HTMLElement): Snap {
  return { attrs: ATTRS.map((a) => root.getAttribute(a)), scheme: root.style.colorScheme };
}
function restore(root: HTMLElement, s: Snap) {
  ATTRS.forEach((a, i) => {
    const v = s.attrs[i];
    if (root.getAttribute(a) === v) return;
    if (v === null) root.removeAttribute(a);
    else root.setAttribute(a, v);
  });
  root.style.colorScheme = s.scheme;
}
function same(a: Snap, b: Snap) {
  return a.scheme === b.scheme && a.attrs.every((v, i) => v === b.attrs[i]);
}

function canTransition(): boolean {
  const doc = document as VTDoc;
  return !!doc.startViewTransition && !busy && !isViewTransitionActive() && !isReducedMotion();
}

function runCrossfade(ms: number, apply: () => void) {
  const doc = document as VTDoc;
  const root = document.documentElement;
  if (!doc.startViewTransition) return apply();
  busy = true;
  root.style.setProperty("--emp-switch-ms", `${ms}ms`);
  root.classList.add("emp-vt-crossfade");
  let t: { finished: Promise<void> };
  try {
    t = doc.startViewTransition(() => apply());
  } catch {
    busy = false;
    root.classList.remove("emp-vt-crossfade");
    apply();
    return;
  }
  t.finished
    .catch(() => undefined)
    .finally(() => {
      busy = false;
      root.classList.remove("emp-vt-crossfade");
    });
}

/**
 * Crossfade the next colour change over `ms`.
 *
 * - `crossfadeColors(ms, apply)`: runs `apply` inside the crossfade.
 * - `crossfadeColors(ms)` then change `data-theme` / `data-accent` synchronously (legacy "arm" form): the change is
 *   picked up in a microtask — before anything paints — rolled back for the old snapshot and re-applied inside the
 *   transition, so callers keep their simple synchronous code.
 */
export function crossfadeColors(ms = 200, apply?: () => void): void {
  if (!canTransition()) {
    apply?.();
    return;
  }
  if (apply) {
    runCrossfade(ms, apply);
    return;
  }
  if (armed) return;
  armed = true;
  const root = document.documentElement;
  const before = snap(root);
  queueMicrotask(() => {
    armed = false;
    const after = snap(root);
    if (same(before, after) || !canTransition()) return;
    restore(root, before);
    runCrossfade(ms, () => restore(root, after));
  });
}

export function switchThemeWithReveal(apply: () => void, origin?: { x: number; y: number } | HTMLElement | null): void {
  const doc = document as VTDoc;
  if (!doc.startViewTransition || isReducedMotion() || busy || isViewTransitionActive()) {
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
  busy = true;
  const vt = doc.startViewTransition(() => apply());
  vt.finished.catch(() => undefined).finally(() => {
    busy = false;
  });
  vt.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 480, easing: "cubic-bezier(.16,1,.3,1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {
      /* transition skipped */
    });
}
