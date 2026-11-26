/** requestIdleCallback with a Safari/WebKitGTK fallback, plus a cooperative idle task queue. */

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining(): number };
type IdleCb = (d: IdleDeadlineLike) => void;

const hasRIC = typeof window !== "undefined" && "requestIdleCallback" in window;

export function requestIdle(cb: IdleCb, opts: { timeout?: number } = {}): number {
  if (hasRIC) return window.requestIdleCallback(cb as IdleRequestCallback, opts);
  const start = performance.now();
  return window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => Math.max(0, 12 - (performance.now() - start)) }), 1);
}

export function cancelIdle(id: number): void {
  if (hasRIC) window.cancelIdleCallback(id);
  else window.clearTimeout(id);
}

/** Resolve on the next idle period (or after `timeout`). */
export function whenIdle(timeout = 2000): Promise<void> {
  return new Promise((r) => requestIdle(() => r(), { timeout }));
}

const queue: (() => void)[] = [];
let running = false;

/** Run small tasks during idle time, yielding when the frame budget is used. */
export function idleTask(task: () => void): void {
  queue.push(task);
  if (running) return;
  running = true;
  const pump = (d: IdleDeadlineLike) => {
    while (queue.length && (d.timeRemaining() > 2 || d.didTimeout)) {
      const t = queue.shift();
      try {
        t?.();
      } catch (e) {
        console.error("idle task failed", e);
      }
    }
    if (queue.length) requestIdle(pump, { timeout: 1000 });
    else running = false;
  };
  requestIdle(pump, { timeout: 1000 });
}
