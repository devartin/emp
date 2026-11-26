/**
 * Data hooks shared by the finance hubs. Server state lives in component state fed by commands and refreshed by
 * `db:changed` events (§13.1 — no TanStack Query). Life-app databases are located by semantic role (§15.0), so the
 * hubs never depend on database titles.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage, listen } from "@/backend";
import type { CellValue, DbSchema, Id, RowDTO } from "@/backend/types";
import { useTree } from "@/stores/tree";
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

const schemaCache = new Map<Id, Promise<DbSchema>>();

export function getSchema(id: Id, fresh = false): Promise<DbSchema> {
  if (fresh || !schemaCache.has(id)) {
    const p = api.db.getSchema({ id });
    p.catch(() => schemaCache.delete(id));
    schemaCache.set(id, p);
  }
  return schemaCache.get(id)!;
}

/**
 * Find the instance's databases by role: `{ txns: 'txn.amount', accounts: 'acct.type' }` → schemas.
 * Prefers databases linked to the instance; falls back to any database carrying the role.
 */
export function useRoleDbs<K extends string>(instanceId: Id, roles: Record<K, string>): { schemas: Partial<Record<K, DbSchema>>; ready: boolean; error: string | null } {
  const dbPages = useTree(
    useCallback(
      (s: ReturnType<typeof useTree.getState>) => {
        const out: string[] = [];
        for (const p of s.byId.values()) if (p.kind === "database" && !p.deletedAt) out.push(`${p.id}:${p.appInstanceId ?? ""}`);
        return out.sort().join("|");
      },
      [],
    ),
  );
  const rolesKey = JSON.stringify(roles);
  const [state, setState] = useState<{ schemas: Partial<Record<K, DbSchema>>; ready: boolean; error: string | null }>({ schemas: {}, ready: false, error: null });
  useEffect(() => {
    let live = true;
    const entries = dbPages ? dbPages.split("|").map((x) => x.split(":") as [Id, string]) : [];
    const ranked = [...entries.filter(([, inst]) => inst === instanceId), ...entries.filter(([, inst]) => inst !== instanceId)];
    const want = Object.entries(roles) as [K, string][];
    (async () => {
      const out: Partial<Record<K, DbSchema>> = {};
      const score: Partial<Record<K, number>> = {};
      for (const [id, inst] of ranked) {
        const missing = want.filter(([k]) => !out[k]);
        if (!missing.length) break;
        let sch: DbSchema;
        try {
          sch = await getSchema(id);
        } catch {
          continue;
        }
        for (const [k, role] of missing) {
          if (!sch.database.roles[role]) continue;
          const sc = (inst === instanceId ? 1000 : 0) + Object.keys(sch.database.roles).length;
          if (score[k] === undefined || sc > (score[k] as number)) {
            out[k] = sch;
            score[k] = sc;
          }
        }
      }
      if (live) setState({ schemas: out, ready: true, error: want.some(([k]) => !out[k]) ? "Some of this app's databases are missing." : null });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbPages, instanceId, rolesKey]);
  return state;
}

/** Every row of a database (paged by 500, §11.1 query windows). */
export async function queryAll(databaseId: Id, override?: Parameters<typeof api.db.query>[0]["override"]): Promise<RowDTO[]> {
  const out: RowDTO[] = [];
  for (let offset = 0; offset < 20_000; offset += 500) {
    const res = await api.db.query({ databaseId, override, window: { offset, limit: 500 }, reqId: Date.now() + offset });
    if ("notModified" in res) break;
    out.push(...res.rows);
    if (out.length >= res.total || !res.rows.length) break;
  }
  return out;
}

// ── cell readers

export const cell = {
  text(v: CellValue | undefined): string {
    if (!v) return "";
    if (v.t === "text") return v.v.map((x) => x.text).join("");
    if (v.t === "url" || v.t === "email" || v.t === "phone") return v.v ?? "";
    if (v.t === "computed") return v.v.display;
    return "";
  },
  money(v: CellValue | undefined): string | null {
    return v && v.t === "money" ? v.v : null;
  },
  num(v: CellValue | undefined): number | null {
    return v && v.t === "number" ? v.v : null;
  },
  date(v: CellValue | undefined): string | null {
    return v && v.t === "date" && v.v ? v.v.start.slice(0, 10) : null;
  },
  rel(v: CellValue | undefined): Id | null {
    return v && v.t === "relation" ? (v.v[0] ?? null) : null;
  },
  sel(v: CellValue | undefined): string | null {
    return v && (v.t === "select" || v.t === "status") ? v.v : null;
  },
  multi(v: CellValue | undefined): string[] {
    return v && v.t === "multi" ? v.v : [];
  },
  check(v: CellValue | undefined): boolean {
    return !!(v && v.t === "check" && v.v);
  },
  ticker(v: CellValue | undefined): string | null {
    return v && v.t === "ticker" ? v.v : null;
  },
};

export const V = {
  text: (s: string): CellValue => ({ t: "text", v: s ? [{ text: s }] : [] }),
  money: (amount: string, cur = "USD"): CellValue => ({ t: "money", v: amount, cur }),
  num: (n: number | null): CellValue => ({ t: "number", v: n }),
  date: (d: string): CellValue => ({ t: "date", v: { start: d, time: false } }),
  rel: (ids: Id[]): CellValue => ({ t: "relation", v: ids }),
  sel: (id: string | null): CellValue => ({ t: "select", v: id }),
  status: (id: string | null): CellValue => ({ t: "status", v: id }),
  check: (b: boolean): CellValue => ({ t: "check", v: b }),
};

/** Select option label/colour for a property. */
export function optionOf(schema: DbSchema | undefined, propId: Id | undefined, optId: string | null): { name: string; color: string } | null {
  if (!schema || !propId || !optId) return null;
  const p = schema.properties.find((x) => x.id === propId);
  const o = ((p?.config.options as { id: string; name: string; color: string }[] | undefined) ?? []).find((x) => x.id === optId);
  return o ? { name: o.name, color: o.color } : null;
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
