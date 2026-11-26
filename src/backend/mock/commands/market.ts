/**
 * Mock `market_*` commands (§11.3 Markets, §17.2): providers, search, quotes, daily bars, indicators and
 * ref-counted live subscriptions. Watchlist alerts are evaluated on every quote refresh and fire `market:alert`
 * at most once per symbol per rule per day.
 */
import type { Id, ProviderInfo, Quote, SymbolKey, Watchlist } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import { barsFor, indicators, instrument, quoteFor, resolveSymbol, search } from '../market';

interface ProviderRec extends ProviderInfo {
  priority: number;
  hasKey: boolean;
}

interface SubRec {
  id: Id;
  symbols: SymbolKey[];
  stop: () => void;
}

const DEFAULT_PROVIDERS: ProviderRec[] = [
  { id: 'frankfurter', name: 'Frankfurter (ECB)', needsKey: false, configured: true, enabled: true, termsUrl: 'https://www.frankfurter.app/docs/', community: false, caps: ['fx'], rateLimit: 'Generous · daily rates', health: 'ok', priority: 0, hasKey: false },
  { id: 'stooq', name: 'Stooq', needsKey: false, configured: true, enabled: true, termsUrl: 'https://stooq.com/', community: false, caps: ['daily'], rateLimit: 'End of day only', health: 'ok', priority: 1, hasKey: false },
  { id: 'coingecko', name: 'CoinGecko', needsKey: false, configured: true, enabled: true, termsUrl: 'https://www.coingecko.com/en/api_terms', community: false, caps: ['crypto', 'quote', 'daily'], rateLimit: 'About 5–15 requests/min', health: 'ok', priority: 2, hasKey: false },
  { id: 'finnhub', name: 'Finnhub', needsKey: true, configured: true, enabled: true, termsUrl: 'https://finnhub.io/terms-of-service', community: false, caps: ['quote', 'search', 'dividends'], rateLimit: 'About 60 requests/min', health: 'ok', priority: 3, hasKey: true },
  { id: 'tiingo', name: 'Tiingo', needsKey: true, configured: false, enabled: false, termsUrl: 'https://www.tiingo.com/about/terms', community: false, caps: ['daily', 'dividends', 'search'], rateLimit: 'About 1,000 requests/day', health: 'unknown', priority: 4, hasKey: false },
];

const providers = (ctx: MockCtx) => ctx.db.table<ProviderRec>('market_providers');
const quoteCaches = new WeakMap<object, Map<SymbolKey, Quote>>();
/** Last delivered quotes (memory only: ticking must not churn the persisted tables). */
function quoteCache(ctx: MockCtx): Map<SymbolKey, Quote> {
  let m = quoteCaches.get(ctx.db);
  if (!m) quoteCaches.set(ctx.db, (m = new Map()));
  return m;
}
const fired = (ctx: MockCtx) => ctx.db.table<{ id: string; at: number }>('market_alerts_fired');

const subs = new WeakMap<object, Map<Id, SubRec>>();
function subsOf(ctx: MockCtx): Map<Id, SubRec> {
  let m = subs.get(ctx.db);
  if (!m) subs.set(ctx.db, (m = new Map()));
  return m;
}

function ensureProviders(ctx: MockCtx): void {
  if (providers(ctx).all().length) return;
  for (const p of DEFAULT_PROVIDERS) providers(ctx).insert({ ...p });
}

function publicInfo(p: ProviderRec): ProviderInfo {
  const { priority: _p, hasKey: _k, ...info } = p;
  return { ...info, configured: !p.needsKey || p.hasKey };
}

function liveEquities(ctx: MockCtx): boolean {
  const f = providers(ctx).get('finnhub');
  return !!f && f.enabled && f.hasKey;
}

/** Quote now, or the last cached quote while offline. */
export function quoteNow(ctx: MockCtx, key: SymbolKey): Quote | null {
  const resolved = resolveSymbol(key) ?? key;
  if (ctx.isOffline()) {
    const c = quoteCache(ctx).get(resolved);
    if (c) return { ...c, freshness: 'eod', marketState: 'closed' };
  }
  const q = quoteFor(resolved, ctx.clock.now(), { liveEquities: liveEquities(ctx) });
  if (!q) return null;
  quoteCache(ctx).set(q.symbol, q);
  return q;
}

function checkAlerts(ctx: MockCtx, quotes: Quote[]): void {
  const lists = ctx.db.table<Watchlist>('watchlists').all();
  if (!lists.length) return;
  const today = ctx.clock.today();
  for (const q of quotes) {
    for (const wl of lists) {
      for (const s of wl.symbols) {
        if (s.key !== q.symbol) continue;
        const hits: ('above' | 'below' | 'pct')[] = [];
        if (s.alertAbove !== undefined && q.price >= s.alertAbove) hits.push('above');
        if (s.alertBelow !== undefined && q.price <= s.alertBelow) hits.push('below');
        if (s.alertPct !== undefined && Math.abs(q.changePct) * 100 >= s.alertPct) hits.push('pct');
        for (const kind of hits) {
          const id = `${q.symbol}:${kind}:${today}`;
          if (fired(ctx).has(id)) continue;
          fired(ctx).insert({ id, at: ctx.clock.now() });
          ctx.emit('market:alert', { symbol: q.symbol, kind, price: q.price });
        }
      }
    }
  }
}

export const handlers: MockHandlers = {
  market_providers: (_req, ctx) => {
    ensureProviders(ctx);
    return providers(ctx)
      .all()
      .sort((a, b) => a.priority - b.priority)
      .map(publicInfo);
  },

  market_provider_configure: (req, ctx) => {
    ensureProviders(ctx);
    const p = providers(ctx).get(req.id);
    if (!p) ctx.fail('NOT_FOUND', 'Unknown market data provider');
    if (req.apiKey !== undefined && req.apiKey !== null && req.apiKey.length > 512) ctx.fail('INVALID', 'That key looks too long', { field: 'apiKey' });
    const next = providers(ctx).update(req.id, (x) => {
      if (req.apiKey !== undefined) x.hasKey = !!req.apiKey;
      x.enabled = req.enabled && (!x.needsKey || x.hasKey);
      if (typeof req.priority === 'number' && Number.isFinite(req.priority)) x.priority = req.priority;
      x.health = x.enabled ? 'ok' : 'unknown';
    });
    return publicInfo(next);
  },

  market_provider_test: async (req, ctx) => {
    ensureProviders(ctx);
    const p = providers(ctx).get(req.id);
    if (!p) ctx.fail('NOT_FOUND', 'Unknown market data provider');
    if (ctx.isOffline()) return { ok: false, latencyMs: 0, error: 'Offline mode is on' };
    const latency = 60 + Math.round(ctx.rng.next() * 180);
    await ctx.sleep(Math.min(400, latency));
    if (p!.needsKey && !p!.hasKey) return { ok: false, latencyMs: latency, error: 'Add an API key first' };
    return { ok: true, latencyMs: latency };
  },

  market_search: (req) => {
    const q = String(req.q ?? '').slice(0, 512);
    return { reqId: req.reqId, results: search(q, req.limit || 10) };
  },

  market_quotes: (req, ctx) => {
    if (!Array.isArray(req.symbols)) ctx.fail('INVALID', 'symbols must be a list', { field: 'symbols' });
    const out: Quote[] = [];
    for (const s of req.symbols.slice(0, 500)) {
      const q = quoteNow(ctx, s);
      if (q) out.push(q);
    }
    if (out.length) checkAlerts(ctx, out);
    return out;
  },

  market_bars: (req, ctx) => {
    const key = resolveSymbol(req.symbol) ?? req.symbol;
    const bars = barsFor(key, req.interval, req.from, req.to, ctx.clock.now());
    if (!bars) ctx.fail('NOT_FOUND', `No data for ${req.symbol}`);
    if (ctx.isOffline()) bars!.stale = true;
    return bars!;
  },

  market_indicators: (req, ctx) => {
    const key = resolveSymbol(req.symbol) ?? req.symbol;
    const bars = barsFor(key, '1d', req.from, req.to, ctx.clock.now());
    if (!bars) ctx.fail('NOT_FOUND', `No data for ${req.symbol}`);
    return indicators(bars!.c, req.ind ?? []);
  },

  market_subscribe: (req, ctx) => {
    const onQuote = (req as unknown as { onQuote?: (q: Quote[]) => void }).onQuote;
    const symbols = Array.from(new Set((req.symbols ?? []).map((s) => resolveSymbol(s) ?? s))).filter((s) => instrument(s));
    const id = ctx.id();
    const last = new Map<SymbolKey, number>();
    const tick = () => {
      if (ctx.isOffline() || !onQuote) return;
      const out: Quote[] = [];
      for (const s of symbols) {
        const q = quoteNow(ctx, s);
        if (!q) continue;
        if (last.get(s) === q.price) continue;
        last.set(s, q.price);
        out.push(q);
      }
      if (!out.length) return;
      checkAlerts(ctx, out);
      try {
        onQuote(structuredClone(out));
      } catch (err) {
        console.error('[emp mock] onQuote listener failed', err);
      }
    };
    const stop = ctx.every(1500, tick);
    subsOf(ctx).set(id, { id, symbols, stop });
    setTimeout(tick, 0);
    return { subId: id };
  },

  market_unsubscribe: (req, ctx) => {
    const s = subsOf(ctx).get(req.subId);
    if (s) {
      s.stop();
      subsOf(ctx).delete(req.subId);
    }
  },
};

export function setup(ctx: MockCtx): void {
  ensureProviders(ctx);
}
