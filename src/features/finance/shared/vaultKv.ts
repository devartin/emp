/**
 * A small per-key cache over the vault's `kv` table (`kv_get` / `kv_set`, `ui.*` namespaces, SPEC §11.3) for finance
 * UI choices that are vault data: a remembered statement balance, the chosen debt plan. They live in the vault with
 * everything else — never in localStorage, sessionStorage or IndexedDB (SPEC §9.11: decrypted data never reaches
 * browser storage) — and the in-memory copy is dropped when the vault locks.
 *
 * `values[key]`: `undefined` until loaded, `null` when the vault holds nothing (or a value that does not parse).
 * This module has no backend import so it can be tested with a fake `io`; callers pass the real one.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";

export interface KvIo {
  get(ns: `ui.${string}`, key: string): Promise<unknown>;
  set(ns: `ui.${string}`, key: string, value: unknown): Promise<void>;
}

export interface VaultKvState<T> {
  values: Record<string, T | null>;
  /** Load `key` once (idempotent while loaded or in flight). A failed read counts as "nothing stored". */
  load(key: string): Promise<void>;
  /** Write `value` (null deletes). The cache updates first; a failed write keeps it for this session only. */
  put(key: string, value: T | null): Promise<void>;
  /** Forget every cached value (on lock). */
  reset(): void;
}

export function createVaultKv<T>(ns: `ui.${string}`, parse: (raw: unknown) => T | null, io: KvIo): UseBoundStore<StoreApi<VaultKvState<T>>> {
  const inflight = new Map<string, Promise<void>>();
  let epoch = 0;
  return create<VaultKvState<T>>()((set, get) => ({
    values: {},
    load(key) {
      if (key in get().values) return Promise.resolve();
      const running = inflight.get(key);
      if (running) return running;
      const at = epoch;
      const p = io
        .get(ns, key)
        .then(
          (raw) => {
            let v: T | null = null;
            try {
              v = raw === null || raw === undefined ? null : parse(raw);
            } catch {
              v = null;
            }
            return v;
          },
          () => null,
        )
        .then((v) => {
          // A lock (reset) while the read was in flight discards it; a put that raced ahead wins.
          if (at === epoch && !(key in get().values)) set((s) => ({ values: { ...s.values, [key]: v } }));
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    async put(key, value) {
      set((s) => ({ values: { ...s.values, [key]: value } }));
      try {
        await io.set(ns, key, value);
      } catch {
        /* the vault refused the write (locked, read-only): keep it in memory for this session */
      }
    },
    reset() {
      epoch++;
      inflight.clear();
      set({ values: {} });
    },
  }));
}
