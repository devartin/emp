/** Controllable clock for the mock (`&freeze=…`, `__EMP_MOCK__.clock.set/advance`). */

export interface MockClock {
  /** Current mock time in ms. */
  now(): number;
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
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createClock(freeze: number | null): MockClock {
  let frozenAt: number | null = freeze;
  let offset = 0;
  return {
    now: () => (frozenAt !== null ? frozenAt : Date.now() + offset),
    today(ts) {
      return localDay(ts ?? this.now());
    },
    set(ts) {
      if (frozenAt !== null) frozenAt = ts;
      else offset = ts - Date.now();
    },
    advance(ms) {
      if (frozenAt !== null) frozenAt += ms;
      else offset += ms;
    },
    get frozen() {
      return frozenAt !== null;
    },
    snapshot: () => ({ frozenAt, offset }),
    restore(s) {
      frozenAt = s.frozenAt;
      offset = s.offset;
    },
  };
}
