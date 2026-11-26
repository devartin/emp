/**
 * Glass probe — the frame monitor's transparency step (docs/DESIGN.md §4.12 / §5 degrade ladder). Used on Linux while
 * Transparency is Auto: glass starts on, and this measures frames *only while glass overlays (menus, popovers,
 * dialogs, the palette, sheets, toasts) are on screen and animating*. Counting rules match `lib/perf.ts`: a frame is
 * dropped when its interval exceeds 1.5× the refresh interval, and intervals over 100ms are long tasks (chunk load,
 * mount), not compositing cost, so they are skipped.
 *
 * Budget: windows of 60 sampled frames; > 10% dropped makes a window bad; 2 consecutive bad windows exceed the budget
 * (the caller steps glass down and persists that). 6 consecutive clean windows pass the probe for this session and
 * sampling stops. Nothing runs (no rAF loop) while no glass overlay is mounted.
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

/** Floating glass layers. `[data-opaque]` glass (opened inside another overlay) has no backdrop and doesn't count. */
export const GLASS_OVERLAY_SELECTOR = ":is(.glass-1, .glass-2, .glass-3):not([data-opaque])";
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
    if (el.closest("[data-glass-probe-ignore]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }
  return false;
}

function animationsRunning(): boolean {
  try {
    return typeof document.getAnimations === "function" && document.getAnimations().some((a) => a.playState === "running");
  } catch {
    return false;
  }
}

/**
 * Start the probe. Calibrates the refresh interval first (60 idle frames), then sleeps until a glass overlay mounts;
 * while one is on screen it samples frames during its open/close choreography, input over it, or running WAAPI
 * animations, and sleeps (no rAF) in between. Calls `onExceeded` / `onPassed` once and stops itself.
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
      anim = present && animationsRunning();
    }
    const active = t < activeUntil || anim;
    sampling = present && active && renders() && document.visibilityState === "visible";
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

  // Mounts and unmounts of glass layers (portals live under <body>). The callback is O(1); the check is coalesced.
  const mo =
    typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
          if (checkQueued || stopped) return;
          for (const r of records) {
            if (r.addedNodes.length || r.removedNodes.length) {
              checkQueued = true;
              queueMicrotask(() => {
                checkQueued = false;
                // querySelector only (no layout read here); the rAF tick does the full visibility check.
                if (document.querySelector(GLASS_OVERLAY_SELECTOR)) {
                  present = true;
                  wake(ACTIVE_AFTER_MUTATION_MS);
                }
              });
              return;
            }
          }
        })
      : null;
  mo?.observe(document.body, { childList: true, subtree: true });

  const onInput = () => {
    if (present) wake(ACTIVE_AFTER_INPUT_MS);
  };
  const onVis = () => {
    last = 0;
    skipNext = true;
  };
  const inputs = ["pointermove", "pointerdown", "wheel", "keydown"] as const;
  inputs.forEach((e) => window.addEventListener(e, onInput, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", onVis);
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
