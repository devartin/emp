/**
 * Performance marks (reported via `app_ready({ marks })`) and the frame-drop monitor that flips
 * `data-effects="reduced"` when > 10% of frames drop over a 5 s window (§4.4).
 */
import { restoreEffects } from "./bootPrefs";

const marks: Record<string, number> = {};

export function mark(name: string): number {
  const t = performance.now();
  marks[name] = Math.round(t * 10) / 10;
  try {
    performance.mark(`emp:${name}`);
  } catch {
    /* ignore */
  }
  return t;
}

export function measure(from: string, to?: string): number | undefined {
  const a = marks[from];
  const b = to ? marks[to] : performance.now();
  if (a === undefined || b === undefined) return undefined;
  return b - a;
}

export function getMarks(): Record<string, number> {
  return { ...marks };
}

/** Time a synchronous function, recording `name` duration in ms. */
export function time<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    marks[name] = Math.round((performance.now() - t0) * 10) / 10;
  }
}

export interface FrameMonitorOptions {
  windowMs?: number;
  dropRatio?: number;
  /** Consecutive bad windows (each with animations running) before degrading. */
  badWindows?: number;
  onDegrade: () => void;
  /**
   * Called once after a degrade when the next `recoverWindows` animated windows are all clean — the monitor re-arms
   * instead of stopping for good. A second degrade is final for the session (no flip-flopping).
   */
  onRecover?: () => void;
  recoverWindows?: number;
}

/** A single frame interval above this is a long task (chunk load, data parse, chart mount), not animation jank. */
const LONG_TASK_MS = 100;
/**
 * Sampling pause after a route change, overlay open or visibility change: route mounts (React render, data, chart
 * mount) are CPU work the effects tier can't fix, so they must not count as effect jank. Covers the entry
 * choreography (≤ ~1s).
 */
const SETTLE_MS = 1000;
/** A window only counts when at least this share of its expected frames were actually sampled (not paused/skipped). */
const MIN_COVERAGE = 0.5;

let pausedUntil = 0;

export interface FrameWindow {
  frames: number;
  dropped: number;
  animated: boolean;
  bad: boolean;
}
const recent: FrameWindow[] = [];
/** The last 12 sampled windows (diagnostics: Settings › About / devtools). */
export function getFrameStats(): readonly FrameWindow[] {
  return recent;
}
if (import.meta.env.DEV && typeof window !== "undefined") Object.assign(window, { __empFrameStats: getFrameStats });

/**
 * Suspend frame sampling for `ms` (default 600). Call around one-off heavy work — overlay open, a big import — so its
 * long tasks don't count as dropped frames. Route changes (hashchange/popstate, 1s) and visibility changes pause
 * automatically.
 */
export function pauseFrameMonitor(ms = 600): void {
  if (typeof performance === "undefined") return;
  pausedUntil = Math.max(pausedUntil, performance.now() + ms);
}

function animationsRunning(): boolean {
  try {
    return typeof document.getAnimations === "function" && document.getAnimations().some((a) => a.playState === "running");
  } catch {
    return false;
  }
}

/**
 * Samples frame intervals while the page is visible (§4.4). A frame counts as dropped when its interval exceeds 1.5×
 * the median refresh interval; intervals over 100ms are long tasks and are skipped, as is everything for 1s after a
 * route change and 600ms after an overlay open / visibility change. A 5s window only counts if animations were
 * running in it and at least half its frames were sampled; the app degrades after 2 consecutive bad windows (> 10%
 * dropped). After degrading it keeps sampling and can recover once (see `onRecover`).
 */
export function startFrameMonitor({
  windowMs = 5000,
  dropRatio = 0.1,
  badWindows = 2,
  onDegrade,
  onRecover = restoreEffects,
  recoverWindows = 6,
}: FrameMonitorOptions): () => void {
  let raf = 0;
  let last = 0;
  let frames = 0;
  let dropped = 0;
  let windowStart = 0;
  let animated = false;
  let bad = 0;
  let good = 0;
  let degraded = false;
  let degrades = 0;
  const intervals: number[] = [];
  let refresh = 1000 / 60;
  let stopped = false;

  const onNav = () => pauseFrameMonitor(SETTLE_MS);
  const onVis = () => {
    pauseFrameMonitor();
    last = 0;
  };
  window.addEventListener("hashchange", onNav);
  window.addEventListener("popstate", onNav);
  document.addEventListener("visibilitychange", onVis);

  const closeWindow = (t: number) => {
    recent.push({ frames, dropped, animated, bad: animated && frames >= (windowMs / refresh) * MIN_COVERAGE && dropped / frames > dropRatio });
    if (recent.length > 12) recent.shift();
    const covered = frames >= (windowMs / refresh) * MIN_COVERAGE;
    if (animated && covered) {
      const isBad = dropped / frames > dropRatio;
      if (!degraded) {
        bad = isBad ? bad + 1 : 0;
        if (bad >= badWindows) {
          degraded = true;
          degrades += 1;
          bad = 0;
          good = 0;
          onDegrade();
        }
      } else if (onRecover && degrades < 2) {
        good = isBad ? 0 : good + 1;
        if (good >= recoverWindows) {
          degraded = false;
          good = 0;
          onRecover();
        }
      }
    }
    frames = 0;
    dropped = 0;
    animated = false;
    windowStart = t;
  };

  const tick = (t: number) => {
    if (stopped) return;
    if (document.visibilityState === "visible" && last && t >= pausedUntil) {
      const dt = t - last;
      if (intervals.length < 60) {
        intervals.push(dt);
        if (intervals.length === 60) refresh = [...intervals].sort((a, b) => a - b)[30];
      } else if (dt < LONG_TASK_MS) {
        frames += Math.max(1, Math.round(dt / refresh));
        if (dt > refresh * 1.5) dropped += Math.round(dt / refresh) - 1;
      }
      if (!windowStart) windowStart = t;
      // Cheap enough at a 500ms cadence; a window with nothing animating says nothing about animation smoothness.
      if (!animated && Math.floor((t - windowStart) / 500) !== Math.floor((last - windowStart) / 500)) animated = animationsRunning();
      if (t - windowStart >= windowMs) closeWindow(t);
    } else if (t < pausedUntil) {
      windowStart = windowStart || t;
    }
    last = t;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("hashchange", onNav);
    window.removeEventListener("popstate", onNav);
    document.removeEventListener("visibilitychange", onVis);
  };
}
