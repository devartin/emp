/**
 * Controllable clock for the mock (`&freeze=…`, `__EMP_MOCK__.clock.set/advance`).
 *
 * Time zone: the mock has no zone of its own. Every "day" (`today()`, seed dates, budget months) is the *browser's*
 * local calendar day, exactly like the desktop app, whose Rust side uses the device's local zone
 * (`finance::local_today`). `freeze` is an absolute instant (`2026-11-26T15:30:00Z` is 15:30 in UTC, 07:30 in
 * Los Angeles).
 *
 * One "now" for the whole preview: the mock backend reads `clock.now()`, and the UI — which calls `Date.now()` /
 * `new Date()` directly, as it must in the desktop build — reads the same clock through {@link installDateShim}.
 * Before the shim existed the UI used the real wall clock while handlers used the frozen one, so with
 * `freeze=…15:30Z` Home and Life OS placed "now" at whatever the real time was (e.g. ~2 PM) while the data said
 * 3:30 PM. The shim is browser-preview only (installed by `createMockTransport`); desktop builds never load it.
 */

/** The real wall clock, captured before any shim is installed. */
const RealDate = globalThis.Date;
const realNow: () => number = RealDate.now.bind(RealDate);

export interface MockClock {
  /** Current mock time in ms (constant while frozen — handler output stays deterministic). */
  now(): number;
  /**
   * The time the UI should see: `now()` plus the real time elapsed since the clock was frozen/last moved, so UI
   * timers (toasts, countdowns, "x seconds ago") keep working while the data clock stays frozen. Equal to `now()`
   * when not frozen.
   */
  wallNow(): number;
  /** Local calendar day of `ts` (default now) as 'YYYY-MM-DD'. */
  today(ts?: number): string;
  set(ts: number): void;
  advance(ms: number): void;
  readonly frozen: boolean;
  /** @internal */
  snapshot(): { frozenAt: number | null; offset: number };
  /** @internal */
  restore(s: { frozenAt: number | null; offset: number }): void;
}

export function localDay(ts: number): string {
  const d = new RealDate(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createClock(freeze: number | null, real: () => number = realNow): MockClock {
  let frozenAt: number | null = freeze;
  let offset = 0;
  /** Real time at which `frozenAt` was last set (the UI clock ticks on from there). */
  let anchor = real();
  return {
    now: () => (frozenAt !== null ? frozenAt : real() + offset),
    wallNow: () => (frozenAt !== null ? frozenAt + Math.max(0, real() - anchor) : real() + offset),
    today(ts) {
      return localDay(ts ?? this.now());
    },
    set(ts) {
      if (frozenAt !== null) {
        frozenAt = ts;
        anchor = real();
      } else offset = ts - real();
    },
    advance(ms) {
      if (frozenAt !== null) {
        frozenAt += ms;
        anchor = real();
      } else offset += ms;
    },
    get frozen() {
      return frozenAt !== null;
    },
    snapshot: () => ({ frozenAt, offset }),
    restore(s) {
      frozenAt = s.frozenAt;
      offset = s.offset;
      anchor = real();
    },
  };
}

let shimmed = false;

/**
 * Routes the global `Date` (`Date.now()`, `new Date()`, `Date()`) through `now` so UI code that reads the wall clock
 * agrees with the mock's clock. Dates built from explicit arguments are untouched; `instanceof Date` still holds.
 * Idempotent; returns an uninstaller (tests).
 */
export function installDateShim(now: () => number): () => void {
  if (shimmed || typeof globalThis === 'undefined') return () => undefined;
  const Shim = new Proxy(RealDate, {
    construct(target, args: unknown[], newTarget) {
      return Reflect.construct(target, args.length ? args : [now()], newTarget) as object;
    },
    apply() {
      return new RealDate(now()).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return now;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  globalThis.Date = Shim;
  shimmed = true;
  return () => {
    globalThis.Date = RealDate;
    shimmed = false;
  };
}
