/**
 * Performance marks (reported via `app_ready({ marks })`) and the frame-drop monitor that flips
 * `data-effects="reduced"` when > 10% of frames drop over a 5 s window (§4.4).
 */
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
  onDegrade: () => void;
}

/**
 * Samples frame intervals while the page is visible. A frame counts as dropped when its interval
 * exceeds 1.5× the median refresh interval. Stops itself after degrading once.
 */
export function startFrameMonitor({ windowMs = 5000, dropRatio = 0.1, onDegrade }: FrameMonitorOptions): () => void {
  let raf = 0;
  let last = 0;
  let frames = 0;
  let dropped = 0;
  let windowStart = 0;
  const intervals: number[] = [];
  let refresh = 1000 / 60;
  let stopped = false;

  const tick = (t: number) => {
    if (stopped) return;
    if (document.visibilityState === "visible" && last) {
      const dt = t - last;
      if (intervals.length < 60) {
        intervals.push(dt);
        if (intervals.length === 60) refresh = [...intervals].sort((a, b) => a - b)[30];
      } else if (dt < 250) {
        // ignore long gaps (tab switches, debugger) — they are not jank
        frames += Math.max(1, Math.round(dt / refresh));
        if (dt > refresh * 1.5) dropped += Math.round(dt / refresh) - 1;
      }
      if (!windowStart) windowStart = t;
      if (t - windowStart >= windowMs) {
        if (frames > 0 && dropped / frames > dropRatio) {
          stopped = true;
          onDegrade();
          return;
        }
        frames = 0;
        dropped = 0;
        windowStart = t;
      }
    }
    last = t;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
