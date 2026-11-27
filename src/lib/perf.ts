/**
 * Performance marks, reported to Rust with `app_ready({ marks })` and readable as `performance.mark('emp:<name>')`.
 *
 * There is no frame monitor any more (1.0 brief §4: "No idle loops: nothing animates when nothing changes"); it
 * only fed the removed glass / visual-effects step-down.
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

/**
 * @deprecated No-op: the frame monitor is gone. Kept so `ui/Dialog` and `ui/Sheet` keep compiling until their owner
 * drops the call.
 */
export function pauseFrameMonitor(_ms = 600): void {
  void _ms;
}
