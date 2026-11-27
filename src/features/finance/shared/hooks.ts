/**
 * Data hooks shared by the finance hubs. Server state lives in component state fed by commands (the backend's
 * compact views: `finance_ledger`, `portfolio_book`, `tax_records`, …) and refreshed by `db:changed` events
 * (§13.1 — no TanStack Query). The hubs never read whole databases or generated option ids.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage, listen } from "@/backend";
import type { Id } from "@/backend/types";
import { isReducedMotion } from "@/ui/motion/useReducedEffects";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Replace the data optimistically. */
  set: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** Run `fn` when `deps` change; keep the previous data while reloading (no flashes on refresh). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean } = {}): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const id = ++seq.current;
    setLoading(true);
    fn()
      .then((v) => {
        if (id !== seq.current) return;
        setData(v);
        setError(null);
      })
      .catch((e) => {
        if (id !== seq.current) return;
        setError(errorMessage(e) || "Something went wrong");
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((f: (prev: T | undefined) => T | undefined) => setData((p) => f(p)), []);
  return { data, error, loading, reload, set };
}

/** Call `onChange` (debounced) whenever any of the databases changes. */
export function useDbChanged(dbIds: (Id | undefined)[], onChange: () => void, delay = 180): void {
  const key = dbIds.filter(Boolean).join("|");
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!key) return;
    const ids = new Set(key.split("|"));
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = listen("db:changed", (e) => {
      if (!ids.has(e.databaseId)) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => cb.current(), delay);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [key, delay]);
}

/** Re-render every `ms` (relative times, countdowns). */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useStableMemo<T>(fn: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(fn, deps);
}

// ───────────────────────────────────────────────────────────────────────────── chart scrub

export interface ScrubStore {
  get: () => number | null;
  set: (i: number | null) => void;
  subscribe: (fn: () => void) => () => void;
  hostRef: (el: HTMLElement | null) => void;
}

/** Scrub index outside React state: subscribers re-render, the owner (and its chart) does not. Mirrors
 * `data-scrub` on the hero host for CSS. */
export function useScrubStore(): ScrubStore {
  const [store] = useState<ScrubStore>(() => {
    let idx: number | null = null;
    let host: HTMLElement | null = null;
    const subs = new Set<() => void>();
    return {
      get: () => idx,
      set: (i) => {
        if (i === idx) return;
        idx = i;
        if (host) {
          if (i === null) host.removeAttribute("data-scrub");
          else host.setAttribute("data-scrub", "");
        }
        subs.forEach((fn) => fn());
      },
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      hostRef: (el) => {
        host = el;
      },
    };
  });
  return store;
}

export function useScrubIdx(store: ScrubStore): number | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ───────────────────────────────────────────────────────────────────────────── disclosure glide (FLIP)

const GLIDE = { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/**
 * Siblings displaced by a disclosure glide into place on the compositor instead of the disclosure animating `height`
 * (DESIGN §5.4 rule 5). When `dep` changes, the children's offsets are read once during render (the DOM still shows
 * the previous commit), again after the commit, and each moved child plays a `translate` FLIP (`translate` composes
 * with any transform the element already has). Pair with `AnimatePresence mode="popLayout"` so exits leave the flow in
 * the same commit. `ref` targets the container; pass `self` to glide the element itself instead of its children.
 */
export function useFlip<T extends HTMLElement>(dep: unknown, opts: { self?: boolean } = {}) {
  const ref = useRef<T>(null);
  const last = useRef(dep);
  const before = useRef<Map<HTMLElement, number> | null>(null);
  const targets = (): HTMLElement[] => {
    const host = ref.current;
    if (!host) return [];
    return opts.self ? [host] : (Array.from(host.children) as HTMLElement[]);
  };
  if (last.current !== dep) {
    last.current = dep;
    before.current = new Map(targets().map((el) => [el, el.offsetTop]));
  }
  useLayoutEffect(() => {
    const prev = before.current;
    before.current = null;
    if (!prev || isReducedMotion()) return;
    for (const el of targets()) {
      const b = prev.get(el);
      if (b === undefined) continue;
      const dy = b - el.offsetTop;
      if (Math.abs(dy) < 0.5) continue;
      el.animate?.([{ translate: `0 ${dy}px` }, { translate: "0 0" }], GLIDE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return ref;
}
