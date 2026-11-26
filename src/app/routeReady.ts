/**
 * `emp:route-ready` — the app's "this route has its data and has painted" signal (docs/design/KIT.md §6).
 *
 * Emitted once per route mount by the main outlet (routes.tsx → RouteReadyMark), when:
 *   1. the route's lazy chunk has resolved (the mark lives inside the route's Suspense boundary), and
 *   2. nothing inside the route is loading — no `.emp-route-skeleton`, `.emp-skeleton`, `[aria-busy="true"]` or
 *      `[data-route-busy]` element — and has stayed that way for QUIET_MS (chained loads leave short gaps), and
 *   3. two animation frames have passed after that (first content painted).
 * It fires as `window.dispatchEvent(new CustomEvent('emp:route-ready', { detail }))` plus
 * `performance.mark('emp:route-ready', { startTime: detail.at, detail })`. `detail.at` is the performance timestamp
 * of the first frame from which the route stayed idle — measure settle from there, not from the event. If loading
 * markers never clear it fires after 8 s with `timedOut: true`. Cost per navigation: a few rAFs and one
 * MutationObserver on the route pane until the mark.
 */

export const ROUTE_READY_EVENT = 'emp:route-ready';
const BUSY = '.emp-route-skeleton, .emp-skeleton, [aria-busy="true"], [data-route-busy]';
const QUIET_MS = 100;
const MAX_WAIT_MS = 8000;

export interface RouteReadyDetail {
  route: string;
  /** performance.now() timestamp at which the route became (and stayed) idle. */
  at: number;
  /** Milliseconds from the route's content mounting to `at`. */
  ms: number;
  timedOut: boolean;
}

/** Start watching a freshly mounted route; returns a cleanup that cancels it (unmount, route change). */
export function watchRouteReady(host: HTMLElement | null, route: string): () => void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return () => undefined;
  const t0 = performance.now();
  let done = false;
  let raf = 0;
  let quietSince: number | null = null;
  const timers: number[] = [];
  let observer: MutationObserver | null = null;

  const busy = () => !!host?.isConnected && !!host.querySelector(BUSY);
  const afterTwoFrames = (fn: () => void) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(fn);
    });
  };
  const later = (ms: number) => timers.push(window.setTimeout(() => afterTwoFrames(check), ms));
  const stop = () => {
    done = true;
    cancelAnimationFrame(raf);
    for (const t of timers) window.clearTimeout(t);
    observer?.disconnect();
  };
  const emit = (at: number, timedOut: boolean) => {
    if (done) return;
    stop();
    const detail: RouteReadyDetail = { route, at, ms: Math.round(at - t0), timedOut };
    try {
      performance.mark(ROUTE_READY_EVENT, { startTime: at, detail });
    } catch {
      /* performance.mark options unsupported: the event below still fires */
    }
    window.dispatchEvent(new CustomEvent<RouteReadyDetail>(ROUTE_READY_EVENT, { detail }));
  };
  function check() {
    if (done) return;
    const now = performance.now();
    if (now - t0 > MAX_WAIT_MS) return emit(quietSince ?? now, true);
    if (busy()) {
      quietSince = null;
      return;
    }
    if (quietSince === null) {
      quietSince = now;
      later(QUIET_MS);
      return;
    }
    if (now - quietSince >= QUIET_MS) emit(quietSince, false);
  }

  if (host) {
    observer = new MutationObserver(() => {
      if (busy()) quietSince = null;
      else if (quietSince === null) afterTwoFrames(check);
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-busy', 'data-route-busy'] });
  }
  later(MAX_WAIT_MS + 20);
  // Let the route's own effects run and their loading states commit before the first look.
  afterTwoFrames(check);
  return stop;
}
