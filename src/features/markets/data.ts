/** Market data helpers: symbol metadata cache, bars → OHLCV, ranges, watchlist store. */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, backendMode } from "@/backend";
import type { MarketSearchResult, SymbolKey, Watchlist, WatchlistSymbol } from "@/backend/types";
import type { Ohlcv } from "@/charts/Candles";
import { notify } from "@/stores/toasts";

export type ChartRange = "1m" | "3m" | "6m" | "ytd" | "1y" | "5y";

export function rangeFrom(r: ChartRange, today = new Date()): string {
  const d = new Date(today);
  if (r === "ytd") return `${d.getFullYear()}-01-01`;
  const months = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "5y": 60 }[r];
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function intervalFor(r: ChartRange): "1d" | "1wk" | "1mo" {
  return r === "5y" ? "1wk" : "1d";
}

const infoCache = new Map<SymbolKey, Promise<MarketSearchResult | null>>();

/** Name / exchange / type for a symbol (served by `market_search`, cached for the session). */
export function symbolInfo(key: SymbolKey): Promise<MarketSearchResult | null> {
  if (!infoCache.has(key)) {
    const ticker = key.split(":")[0];
    const p = api.market
      .search({ q: ticker, limit: 10, reqId: Date.now() })
      .then((r) => r.results.find((x) => x.symbol === key) ?? r.results[0] ?? null)
      .catch(() => null);
    infoCache.set(key, p);
  }
  return infoCache.get(key)!;
}

export function useSymbolInfo(key: SymbolKey | null | undefined): MarketSearchResult | null {
  const [info, setInfo] = useState<MarketSearchResult | null>(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    if (key) void symbolInfo(key).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [key]);
  return info;
}

/**
 * The Markets index strip. On desktop: real symbols the keyless providers price (index funds stand in for the
 * indices, which have no `TICKER:MIC` key). The browser preview's mock serves fictional demo instruments instead.
 */
export const DEFAULT_STRIP: SymbolKey[] = backendMode === "tauri" ? ["SPY:ARCX", "QQQ:XNAS", "BTC:CRYPTO", "EURUSD:FX"] : ["EMP500:INDEX", "EMPT100:INDEX", "BTC:CRYPTO", "EURUSD:FX"];

/** Symbols for a new watchlist (e.g. the editor's watchlist block): real ones on desktop, demo ones in the preview. */
export const STARTER_WATCHLIST: SymbolKey[] = backendMode === "tauri" ? ["SPY:ARCX", "AAPL:XNAS", "MSFT:XNAS"] : ["EMPX:XNAS", "NOVA:XNAS", "ORBT:XNYS"];

export type MarketAvailability = "checking" | "ok" | "offline" | "unavailable";

/**
 * Whether prices can be loaded at all: one `market_quotes` probe for `symbols` (the backend waits up to ~8 s for
 * uncached symbols and returns what it got). No quote at all means offline mode is on or no provider answered; the
 * probe repeats every minute until prices arrive, and `retry` runs it now.
 */
export function useMarketAvailability(symbols: SymbolKey[], offlineMode: boolean): { status: MarketAvailability; retry: () => void } {
  const [status, setStatus] = useState<MarketAvailability>("checking");
  const [tick, setTick] = useState(0);
  const key = symbols.join("|");
  useEffect(() => {
    let live = true;
    if (!key) return;
    setStatus((s) => (s === "ok" ? s : "checking"));
    api.market
      .quotes({ symbols: key.split("|") })
      .then((q) => live && setStatus(q.length ? "ok" : offlineMode ? "offline" : "unavailable"))
      .catch(() => live && setStatus(offlineMode ? "offline" : "unavailable"));
    return () => {
      live = false;
    };
  }, [key, offlineMode, tick]);
  useEffect(() => {
    if (status !== "offline" && status !== "unavailable") return;
    const h = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(h);
  }, [status]);
  return { status, retry: () => setTick((n) => n + 1) };
}

/** Display names for the fictional demo indices; the symbol keys (EMP500, EMPT100) are stable data ids. */
const INDEX_TICKERS: Record<string, string> = { EMP500: "US 500", EMPT100: "US Tech 100" };

export function ticker(key: SymbolKey): string {
  const [t, mic] = key.split(":");
  if (mic === "FX" && t.length === 6) return `${t.slice(0, 3)}/${t.slice(3)}`;
  if (mic === "INDEX") return INDEX_TICKERS[t] ?? t.replace(/(\d+)$/, " $1");
  return t;
}

const barsCache = new Map<string, Promise<{ bars: Ohlcv[]; stale: boolean; source: string }>>();

export function loadBars(key: SymbolKey, range: ChartRange): Promise<{ bars: Ohlcv[]; stale: boolean; source: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const k = `${key}|${range}|${today}`;
  if (!barsCache.has(k)) {
    const p = api.market.bars({ symbol: key, interval: intervalFor(range), from: rangeFrom(range), to: today, adjusted: true }).then((b) => ({
      bars: b.t.map((t, i) => ({ time: t, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i], volume: b.v[i] })),
      stale: b.stale,
      source: b.source,
    }));
    p.catch(() => barsCache.delete(k));
    barsCache.set(k, p);
  }
  return barsCache.get(k)!;
}

export function useBars(key: SymbolKey | null | undefined, range: ChartRange) {
  const [state, setState] = useState<{ bars: Ohlcv[]; stale: boolean; source: string; loading: boolean; error: string | null }>({ bars: [], stale: false, source: "", loading: true, error: null });
  useEffect(() => {
    if (!key) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    loadBars(key, range)
      .then((r) => live && setState({ ...r, loading: false, error: null }))
      .catch((e) => live && setState({ bars: [], stale: false, source: "", loading: false, error: e instanceof Error ? e.message : "No data" }));
    return () => {
      live = false;
    };
  }, [key, range]);
  return state;
}

/** Last ~30 closes for sparklines. */
export function useSparkline(key: SymbolKey): number[] {
  const { bars } = useBars(key, "1m");
  return bars.map((b) => b.close);
}

// ───────────────────────────────────────────────────────────────────────────── watchlists

interface WatchState {
  lists: Watchlist[];
  loaded: boolean;
  load(): Promise<void>;
  save(list: Watchlist): Promise<void>;
  create(name: string, symbols?: WatchlistSymbol[]): Promise<string | null>;
  add(listId: string, key: SymbolKey): Promise<void>;
  remove(listId: string, key: SymbolKey): Promise<void>;
  setAlerts(listId: string, key: SymbolKey, alerts: Omit<WatchlistSymbol, "key">): Promise<void>;
}

export const useWatchlists = create<WatchState>()((set, get) => ({
  lists: [],
  loaded: false,
  async load() {
    try {
      set({ lists: await api.watchlist.list({}), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async save(list) {
    const prev = get().lists;
    set({ lists: prev.map((l) => (l.id === list.id ? list : l)) });
    try {
      await api.watchlist.save({ id: list.id, name: list.name, symbols: list.symbols });
    } catch (e) {
      set({ lists: prev });
      notify.fromError(e, "Couldn't save the watchlist");
    }
  },
  async create(name, symbols = []) {
    try {
      const { id } = await api.watchlist.save({ name, symbols });
      set({ lists: [...get().lists, { id, name, symbols }] });
      return id;
    } catch (e) {
      notify.fromError(e, "Couldn't create the watchlist");
      return null;
    }
  },
  async add(listId, key) {
    const l = get().lists.find((x) => x.id === listId);
    if (!l || l.symbols.some((s) => s.key === key)) return;
    await get().save({ ...l, symbols: [...l.symbols, { key }] });
  },
  async remove(listId, key) {
    const l = get().lists.find((x) => x.id === listId);
    if (!l) return;
    await get().save({ ...l, symbols: l.symbols.filter((s) => s.key !== key) });
  },
  async setAlerts(listId, key, alerts) {
    const l = get().lists.find((x) => x.id === listId);
    if (!l) return;
    await get().save({ ...l, symbols: l.symbols.map((s) => (s.key === key ? { key, ...alerts } : s)) });
  },
}));

export function useWatchlistsLoaded(): Watchlist[] {
  const lists = useWatchlists((s) => s.lists);
  const loaded = useWatchlists((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useWatchlists.getState().load();
  }, [loaded]);
  return lists;
}
