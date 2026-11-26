/**
 * Search (§11.3 search_query, §5.9): debounced queries with stale-response dropping (`reqId`), index status, recent
 * queries and open-frequency (kv `ui.search`) for palette ranking:
 *   score = match × (1 + 0.3·recency + 0.2·frequency + 0.1·favorite)
 */
import { create } from 'zustand';
import { api, latestRequest } from '@/backend';
import type { Id, SearchFilters, SearchHit } from '@/backend/types';

interface SearchState {
  query: string;
  hits: SearchHit[];
  loading: boolean;
  indexReady: boolean;
  docs: number;
  tookMs: number;
  recent: string[];
  /** id → open count (decayed). */
  frequency: Record<Id, number>;
  error: string | null;

  /** Debounced (60 ms); stale responses are dropped. */
  run(q: string, filters?: SearchFilters, limit?: number): void;
  /** Immediate query that does not touch store state (e.g. link pickers). */
  query1(q: string, filters?: SearchFilters, limit?: number): Promise<SearchHit[]>;
  clear(): void;
  addRecent(q: string): void;
  recordOpen(id: Id): void;
  setIndexReady(ready: boolean, docs?: number): void;
  load(): Promise<void>;
}

const DEBOUNCE_MS = 60;
const RECENT_MAX = 8;
const latest = latestRequest();
let timer: ReturnType<typeof setTimeout> | null = null;

function save(key: string, value: unknown) {
  api.kv.set({ ns: 'ui.search', key, value }).catch(() => undefined);
}

export const useSearch = create<SearchState>()((set, get) => ({
  query: '',
  hits: [],
  loading: false,
  indexReady: true,
  docs: 0,
  tookMs: 0,
  recent: [],
  frequency: {},
  error: null,

  run(q, filters, limit = 30) {
    set({ query: q });
    if (timer) clearTimeout(timer);
    if (!q.trim() && !filters) {
      latest.next();
      set({ hits: [], loading: false, error: null });
      return;
    }
    set({ loading: true });
    timer = setTimeout(async () => {
      timer = null;
      const reqId = latest.next();
      try {
        const res = await api.search.query({ q, filters, limit, reqId });
        if (!latest.isLatest(res.reqId)) return;
        set({ hits: res.hits, loading: false, indexReady: res.indexReady, tookMs: res.tookMs, error: null });
      } catch (e) {
        if (!latest.isLatest(reqId)) return;
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    }, DEBOUNCE_MS);
  },

  async query1(q, filters, limit = 10) {
    const res = await api.search.query({ q, filters, limit, reqId: 0 });
    return res.hits;
  },

  clear() {
    if (timer) clearTimeout(timer);
    latest.next();
    set({ query: '', hits: [], loading: false, error: null });
  },

  addRecent(q) {
    const t = q.trim();
    if (!t) return;
    const recent = [t, ...get().recent.filter((r) => r !== t)].slice(0, RECENT_MAX);
    set({ recent });
    save('recent', recent);
  },

  recordOpen(id) {
    const freq = { ...get().frequency };
    // Gentle decay keeps the map small and favours what you open now.
    for (const k of Object.keys(freq)) {
      freq[k] *= 0.98;
      if (freq[k] < 0.05) delete freq[k];
    }
    freq[id] = (freq[id] ?? 0) + 1;
    set({ frequency: freq });
    save('frequency', freq);
  },

  setIndexReady: (ready, docs) => set((s) => ({ indexReady: ready, docs: docs ?? s.docs })),

  async load() {
    try {
      const [kv, status] = await Promise.all([
        api.kv.getMany({ ns: 'ui.search', keys: ['recent', 'frequency'] }),
        api.search.status(),
      ]);
      const recent = Array.isArray(kv.recent) ? (kv.recent as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const frequency =
        kv.frequency && typeof kv.frequency === 'object' ? (kv.frequency as Record<string, number>) : {};
      set({ recent, frequency, indexReady: status.ready, docs: status.docs });
    } catch {
      /* defaults */
    }
  },
}));

/** Palette ranking boost (§5.9). `match` is the backend score; recency in [0,1] from updatedAt. */
export function rankHit(hit: SearchHit, opts: { favorites?: Id[]; frequency?: Record<Id, number>; now?: number } = {}): number {
  const now = opts.now ?? Date.now();
  const recency = Math.exp(-(now - hit.updatedAt) / (7 * 86_400_000));
  const f = opts.frequency?.[hit.id] ?? 0;
  const frequency = f > 0 ? Math.min(1, Math.log2(1 + f) / 4) : 0;
  const favorite = opts.favorites?.includes(hit.id) ? 1 : 0;
  return hit.score * (1 + 0.3 * recency + 0.2 * frequency + 0.1 * favorite);
}
