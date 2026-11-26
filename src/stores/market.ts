/**
 * Live quotes (§17.2): reference-counted subscriptions multiplexed onto one `market_subscribe`, cached quotes, and
 * price-flash direction (at most one flash per symbol per second, §4.2).
 *
 *   const q = useQuote('EMPX:XNAS');          // subscribes while mounted
 *   const quotes = useQuotes(['NOVA:XNAS', 'BTC:CRYPTO']);
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/backend';
import type { Quote, SymbolKey } from '@/backend/types';

export interface Flash {
  dir: 'up' | 'down';
  at: number;
}

interface MarketState {
  quotes: Record<SymbolKey, Quote>;
  flashes: Record<SymbolKey, Flash>;
  /** Merge quotes (from market_quotes or the subscription channel). */
  ingest(quotes: Quote[]): void;
  /** Ref-counted; returns the release function. */
  subscribe(symbols: SymbolKey[]): () => void;
  /** One-shot fetch (served from the backend cache). */
  fetch(symbols: SymbolKey[]): Promise<void>;
}

const FLASH_MIN_INTERVAL = 1000;
const refs = new Map<SymbolKey, number>();
let subId: string | null = null;
let resubTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function scheduleResubscribe() {
  if (resubTimer) return;
  resubTimer = setTimeout(() => {
    resubTimer = null;
    void resubscribe();
  }, 40);
}

async function resubscribe() {
  const gen = ++generation;
  const symbols = Array.from(refs.keys()).sort();
  const old = subId;
  subId = null;
  if (old) api.market.unsubscribe({ subId: old }).catch(() => undefined);
  if (!symbols.length) return;
  try {
    const res = await api.market.subscribe({
      symbols,
      onQuote: (quotes) => {
        if (gen === generation) useMarket.getState().ingest(quotes);
      },
    });
    if (gen !== generation) {
      api.market.unsubscribe({ subId: res.subId }).catch(() => undefined);
      return;
    }
    subId = res.subId;
  } catch {
    /* market data unavailable (offline, locked) — cached quotes remain */
  }
}

export const useMarket = create<MarketState>()((set, get) => ({
  quotes: {},
  flashes: {},

  ingest(quotes) {
    if (!quotes.length) return;
    const now = Date.now();
    const prevQuotes = get().quotes;
    const prevFlashes = get().flashes;
    const nextQuotes = { ...prevQuotes };
    let nextFlashes: Record<SymbolKey, Flash> | null = null;
    for (const q of quotes) {
      if (!Number.isFinite(q.price)) continue;
      const before = prevQuotes[q.symbol];
      if (before && before.asOf > q.asOf) continue;
      nextQuotes[q.symbol] = q;
      if (before && before.price !== q.price) {
        const last = prevFlashes[q.symbol];
        if (!last || now - last.at >= FLASH_MIN_INTERVAL) {
          nextFlashes ??= { ...prevFlashes };
          nextFlashes[q.symbol] = { dir: q.price > before.price ? 'up' : 'down', at: now };
        }
      }
    }
    set(nextFlashes ? { quotes: nextQuotes, flashes: nextFlashes } : { quotes: nextQuotes });
  },

  subscribe(symbols) {
    const unique = Array.from(new Set(symbols.filter(Boolean)));
    let added = false;
    for (const s of unique) {
      const n = refs.get(s) ?? 0;
      refs.set(s, n + 1);
      if (n === 0) added = true;
    }
    if (added) {
      scheduleResubscribe();
      void get().fetch(unique.filter((s) => !get().quotes[s]));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      let removed = false;
      for (const s of unique) {
        const n = (refs.get(s) ?? 1) - 1;
        if (n <= 0) {
          refs.delete(s);
          removed = true;
        } else refs.set(s, n);
      }
      if (removed) scheduleResubscribe();
    };
  },

  async fetch(symbols) {
    if (!symbols.length) return;
    try {
      get().ingest(await api.market.quotes({ symbols }));
    } catch {
      /* unavailable */
    }
  },
}));

export function useQuote(symbol: SymbolKey | null | undefined): Quote | undefined {
  useEffect(() => {
    if (!symbol) return;
    return useMarket.getState().subscribe([symbol]);
  }, [symbol]);
  return useMarket((s) => (symbol ? s.quotes[symbol] : undefined));
}

export function useQuotes(symbols: SymbolKey[]): (Quote | undefined)[] {
  const key = symbols.join('|');
  useEffect(() => {
    if (!key) return;
    return useMarket.getState().subscribe(key.split('|'));
  }, [key]);
  const list = useMemo(() => (key ? key.split('|') : []), [key]);
  return useMarket(useShallow((s) => list.map((k) => s.quotes[k])));
}

export function useFlash(symbol: SymbolKey | null | undefined): Flash | undefined {
  return useMarket((s) => (symbol ? s.flashes[symbol] : undefined));
}

/** Drop subscriptions (lock). */
export function resetMarket(): void {
  refs.clear();
  generation++;
  if (subId) api.market.unsubscribe({ subId }).catch(() => undefined);
  subId = null;
  useMarket.setState({ quotes: {}, flashes: {} });
}
