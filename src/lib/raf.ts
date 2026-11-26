/** requestAnimationFrame helpers: throttling, frame promises and a read/write batcher (avoids layout thrash). */

export function nextFrame(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r));
}

/** Resolves after the browser has painted the next frame (double rAF). */
export function afterPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/** Coalesce calls to at most one per frame, invoked with the latest arguments. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): ((...args: A) => void) & { cancel(): void } {
  let id = 0;
  let last: A;
  const wrapped = (...args: A) => {
    last = args;
    if (id) return;
    id = requestAnimationFrame(() => {
      id = 0;
      fn(...last);
    });
  };
  wrapped.cancel = () => {
    if (id) cancelAnimationFrame(id);
    id = 0;
  };
  return wrapped;
}

type Job = () => void;
const reads: Job[] = [];
const writes: Job[] = [];
let scheduled = false;

function flush() {
  scheduled = false;
  const r = reads.splice(0);
  const w = writes.splice(0);
  for (const j of r) j();
  for (const j of w) j();
}

function schedule() {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}

/** Batch DOM reads before writes within a frame (fastdom-style). */
export const frame = {
  measure(job: Job) {
    reads.push(job);
    schedule();
  },
  mutate(job: Job) {
    writes.push(job);
    schedule();
  },
};
