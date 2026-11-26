/**
 * Glass probe — the frame monitor's transparency step (docs/DESIGN.md §4.12 / §5 degrade ladder). Used on Linux while
 * Transparency is Auto: glass starts on, and this measures frames *only while a glass overlay (menu, popover, dialog,
 * the palette, sheet, floating toolbar) is on screen and that overlay itself is animating or being used*:
 *   - for ~520ms after a glass layer mounts/unmounts or its own subtree changes (not any DOM change on the page),
 *   - for ~320ms after pointer/wheel/key input whose target is inside an open glass layer,
 *   - while a WAAPI/CSS animation runs on (or inside, or around) a glass layer — not page spinners or shimmer.
 * Toasts don't count: they are small, transient and appear during unrelated work (saves, sync, route loads).
 * Sampling pauses for 1s after a route change (hashchange/popstate), as in `lib/perf.ts`: route mounts are CPU work
 * that glass doesn't cause. Frame counting matches `lib/perf.ts`: a frame is dropped when its interval exceeds 1.5×
 * the refresh interval, and intervals over 100ms are long tasks (chunk load, mount), so they are skipped.
 *
 * Budget: windows of 60 sampled frames; > 10% dropped makes a window bad; 2 consecutive bad windows exceed the budget
 * for this session. 6 consecutive clean windows pass it and sampling stops. Nothing runs (no rAF loop) while no glass
 * overlay is active. What a session result means across launches is decided in `app/glassPolicy`.
 */

export interface BudgetOptions {
  /** Sampled frames per window. */
  windowFrames?: number;
  /** Share of dropped frames that makes a window bad. */
  dropRatio?: number;
  /** Consecutive bad windows that exceed the budget. */
  badWindows?: number;
  /** Consecutive clean windows that pass the probe. */
  passWindows?: number;
}

export type BudgetEvent = "none" | "window-good" | "window-bad" | "exceeded" | "passed";

export interface BudgetState {
  frames: number;
  dropped: number;
  windows: number;
  badStreak: number;
  goodStreak: number;
  done: "exceeded" | "passed" | null;
  /** Last closed windows (frames, dropped), newest last; at most 8. */
  history: { frames: number; dropped: number; bad: boolean }[];
}

/** A single frame interval above this is a long task, not jank (same as lib/perf.ts). */
export const LONG_TASK_MS = 100;

export interface FrameBudget {
  /** Feed one frame interval (ms) at the given refresh interval (ms). */
  sample(dt: number, refresh: number): BudgetEvent;
  /** Feed a whole window (dev hook / tests). */
  addWindow(frames: number, dropped: number): BudgetEvent;
  state(): BudgetState;
  reset(): void;
}

export function createFrameBudget({ windowFrames = 60, dropRatio = 0.1, badWindows = 2, passWindows = 6 }: BudgetOptions = {}): FrameBudget {
  const s: BudgetState = { frames: 0, dropped: 0, windows: 0, badStreak: 0, goodStreak: 0, done: null, history: [] };

  const close = (frames: number, dropped: number): BudgetEvent => {
    const bad = frames > 0 && dropped / frames > dropRatio;
    s.windows += 1;
    s.history.push({ frames, dropped, bad });
    if (s.history.length > 8) s.history.shift();
    if (bad) {
      s.badStreak += 1;
      s.goodStreak = 0;
      if (s.badStreak >= badWindows) {
        s.done = "exceeded";
        return "exceeded";
      }
      return "window-bad";
    }
    s.goodStreak += 1;
    s.badStreak = 0;
    if (s.goodStreak >= passWindows) {
      s.done = "passed";
      return "passed";
    }
    return "window-good";
  };

  return {
    sample(dt, refresh) {
      if (s.done || !(dt > 0) || !(refresh > 0) || dt >= LONG_TASK_MS) return "none";
      const n = Math.max(1, Math.round(dt / refresh));
      s.frames += n;
      if (dt > refresh * 1.5) s.dropped += n - 1;
      if (s.frames < windowFrames) return "none";
      const ev = close(s.frames, s.dropped);
      s.frames = 0;
      s.dropped = 0;
      return ev;
    },
    addWindow(frames, dropped) {
      if (s.done) return "none";
      return close(Math.max(0, frames), Math.max(0, Math.min(frames, dropped)));
    },
    state: () => ({ ...s, history: [...s.history] }),
    reset() {
      Object.assign(s, { frames: 0, dropped: 0, windows: 0, badStreak: 0, goodStreak: 0, done: null, history: [] });
    },
  };
}

/** Lower quartile of intervals, clamped to 4–50ms: robust against a few janky frames during calibration. */
export function estimateRefresh(intervals: readonly number[]): number {
  const xs = intervals.filter((x) => x > 0 && x < LONG_TASK_MS).sort((a, b) => a - b);
  if (xs.length < 8) return 1000 / 60;
  const q = xs[Math.floor(xs.length / 4)];
  return Math.min(50, Math.max(4, q));
}

// ───────────────────────────────────────────────────────────────────────────── DOM driver

/**
 * Floating glass layers: the `.glass-*` recipes plus the kit overlays that carry their own backdrop blur (menu,
 * popover/select/combobox/date picker, dialog, sheet), the editor's floating toolbar, the markets search list and the
 * floating sidebar. Persistent bars (topbar, bulk-action bars) aren't overlays and don't count; neither do toasts
 * (see above). `[data-opaque]` glass (opened inside another overlay) has no backdrop and doesn't count either.
 */
export const GLASS_OVERLAY_SELECTOR =
  ":is(.glass-1, .glass-2, .glass-3, .emp-menu, .emp-popover, .emp-dialog, .emp-sheet, .emp-floating, .mk-search-list, .emp-sidebar[data-floating]):not([data-opaque])";
const IGNORE_SELECTOR = "[data-glass-probe-ignore]";
/** Route mounts are not glass cost: no sampling this long after hashchange/popstate (same as lib/perf.ts). */
export const ROUTE_SETTLE_MS = 1000;

/** The DOM surface the relevance checks need (duck-typed so they can be unit-tested without a DOM). */
export interface ElementLike {
  closest(selector: string): unknown;
  matches(selector: string): boolean;
  querySelector(selector: string): unknown;
}

function asElement(n: unknown): ElementLike | null {
  const e = n as Partial<ElementLike> | null;
  return e && typeof e.closest === "function" && typeof e.matches === "function" && typeof e.querySelector === "function" ? (e as ElementLike) : null;
}

/** `el` is a counted glass layer or inside one. */
export function insideGlass(n: unknown): boolean {
  const el = asElement(n);
  return !!el && !!el.closest(GLASS_OVERLAY_SELECTOR) && !el.closest(IGNORE_SELECTOR);
}

/** `el` is, or contains, a counted glass layer (a mounted/unmounted portal subtree). */
export function holdsGlass(n: unknown): boolean {
  const el = asElement(n);
  if (!el || el.closest(IGNORE_SELECTOR)) return false;
  return el.matches(GLASS_OVERLAY_SELECTOR) || !!el.querySelector(GLASS_OVERLAY_SELECTOR);
}

export interface MutationLike {
  /** Element target, or a text node's parent element. */
  target: unknown;
  addedNodes: ArrayLike<unknown>;
  removedNodes: ArrayLike<unknown>;
}

/** A childList mutation is glass choreography: a glass layer (un)mounted, or an open glass layer's content changed. */
export function mutationTouchesGlass(r: MutationLike): boolean {
  if (!r.addedNodes.length && !r.removedNodes.length) return false;
  if (insideGlass(r.target)) return true;
  for (let i = 0; i < r.addedNodes.length; i++) if (holdsGlass(r.addedNodes[i])) return true;
  for (let i = 0; i < r.removedNodes.length; i++) if (holdsGlass(r.removedNodes[i])) return true;
  return false;
}

/** An animation counts when its target is a glass layer, inside one, or wraps one (portal/scrim wrapper). */
export function animationTouchesGlass(target: unknown): boolean {
  return insideGlass(target) || holdsGlass(target);
}
/** After a glass layer mounts or unmounts, its open/close choreography runs for about this long. */
const ACTIVE_AFTER_MUTATION_MS = 520;
/** Pointer/scroll/key input over open glass repaints it (highlight plate, list scroll, typing in the palette). */
const ACTIVE_AFTER_INPUT_MS = 320;

export interface GlassProbeOptions extends BudgetOptions {
  onExceeded: () => void;
  onPassed?: () => void;
  /** Glass actually renders (data-glass on, effects full, normal contrast); re-checked every frame. */
  glassRenders?: () => boolean;
}

export interface GlassProbeHandle {
  stop(): void;
  state(): BudgetState & { refresh: number; sampling: boolean };
  /** Dev/test hook: inject a measured window. */
  feedWindow(frames: number, dropped: number): BudgetEvent;
}

export function glassOverlayVisible(doc: Document = document): boolean {
  const els = doc.querySelectorAll<HTMLElement>(GLASS_OVERLAY_SELECTOR);
  for (const el of els) {
    if (el.closest(IGNORE_SELECTOR)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }
  return false;
}

/** A running WAAPI/CSS animation on, inside or around a glass layer (page spinners and shimmer don't count). */
function glassAnimationRunning(): boolean {
  try {
    if (typeof document.getAnimations !== "function") return false;
    return document.getAnimations().some((a) => a.playState === "running" && a.effect instanceof KeyframeEffect && animationTouchesGlass(a.effect.target));
  } catch {
    return false;
  }
}

/**
 * Start the probe. Calibrates the refresh interval first (60 idle frames), then sleeps until a glass overlay mounts;
 * while one is on screen it samples frames during its open/close choreography, input inside it, or animations on it,
 * and sleeps (no rAF) in between. Calls `onExceeded` / `onPassed` once and stops itself.
 */
export function startGlassProbe(opts: GlassProbeOptions): GlassProbeHandle {
  const budget = createFrameBudget(opts);
  const renders = opts.glassRenders ?? (() => true);
  let refresh = 1000 / 60;
  let stopped = false;
  let raf = 0;
  let last = 0;
  let activeUntil = 0;
  let skipNext = true;
  let present = false;
  let sampling = false;
  let calib: number[] | null = [];
  let checkQueued = false;
  let anim = false;
  let animCheckedAt = 0;
  let pausedUntil = 0;

  const finish = (ev: BudgetEvent) => {
    if (ev === "exceeded") {
      handle.stop();
      opts.onExceeded();
    } else if (ev === "passed") {
      handle.stop();
      opts.onPassed?.();
    }
  };

  const tick = (t: number) => {
    raf = 0;
    if (stopped) return;
    if (calib) {
      if (last) calib.push(t - last);
      last = t;
      if (calib.length >= 60) {
        refresh = estimateRefresh(calib);
        calib = null;
        last = 0;
        present = glassOverlayVisible();
        if (!present) return; // sleep until a glass layer mounts
        activeUntil = t + ACTIVE_AFTER_MUTATION_MS;
        skipNext = true;
      }
      raf = requestAnimationFrame(tick);
      return;
    }
    present = glassOverlayVisible();
    if (t - animCheckedAt >= 250) {
      animCheckedAt = t;
      anim = present && glassAnimationRunning();
    }
    const active = t < activeUntil || anim;
    sampling = present && active && t >= pausedUntil && renders() && document.visibilityState === "visible";
    if (sampling && last && !skipNext) {
      const ev = budget.sample(t - last, refresh);
      if (ev === "exceeded" || ev === "passed") return finish(ev);
    }
    skipNext = !sampling;
    last = t;
    // Tick only through active stretches; mutations and input over open glass wake the loop again.
    if (present && active) raf = requestAnimationFrame(tick);
    else {
      sampling = false;
      anim = false;
      last = 0;
    }
  };

  const wake = (activeMs: number) => {
    if (stopped) return;
    const now = performance.now();
    activeUntil = Math.max(activeUntil, now + activeMs);
    if (!raf && !calib) {
      skipNext = true; // the first interval after waking spans the idle gap / mount commit
      last = 0;
      animCheckedAt = 0;
      raf = requestAnimationFrame(tick);
    }
  };

  // Mounts/unmounts of glass layers (portals live under <body>) and changes inside an open one. Route renders and
  // other page mutations are ignored. No layout reads here; the rAF tick does the full visibility check.
  const mo =
    typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
          if (checkQueued || stopped) return;
          for (const r of records) {
            if (r.type !== "childList" || !mutationTouchesGlass(r)) continue;
            checkQueued = true;
            queueMicrotask(() => {
              checkQueued = false;
              // Mount → open choreography; unmount → close choreography (the layer may already be gone; the tick
              // re-checks visibility and goes back to sleep if nothing glassy is left).
              present = present || !!document.querySelector(GLASS_OVERLAY_SELECTOR);
              wake(ACTIVE_AFTER_MUTATION_MS);
            });
            return;
          }
        })
      : null;
  mo?.observe(document.body, { childList: true, subtree: true });

  const onInput = (e: Event) => {
    // Cheap early-out while already awake; otherwise only input inside an open glass layer repaints glass.
    if (stopped || performance.now() < activeUntil - 100) return;
    if (insideGlass(e.target)) {
      present = true;
      wake(ACTIVE_AFTER_INPUT_MS);
    }
  };
  const onNav = () => {
    pausedUntil = Math.max(pausedUntil, performance.now() + ROUTE_SETTLE_MS);
  };
  const onVis = () => {
    last = 0;
    skipNext = true;
  };
  const inputs = ["pointermove", "pointerdown", "wheel", "keydown"] as const;
  inputs.forEach((e) => window.addEventListener(e, onInput, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("hashchange", onNav);
  window.addEventListener("popstate", onNav);
  raf = requestAnimationFrame(tick);

  const handle: GlassProbeHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      sampling = false;
      mo?.disconnect();
      inputs.forEach((e) => window.removeEventListener(e, onInput, { capture: true }));
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    },
    state: () => ({ ...budget.state(), refresh, sampling }),
    feedWindow(frames, dropped) {
      const ev = budget.addWindow(frames, dropped);
      if (ev === "exceeded" || ev === "passed") finish(ev);
      return ev;
    },
  };
  return handle;
}
