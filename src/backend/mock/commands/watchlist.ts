/** Mock `watchlist_*` commands (§11.3 Markets). Lists live in the `watchlists` table; alerts are checked by market.ts. */
import type { Watchlist, WatchlistSymbol } from '../../types';
import type { MockCtx, MockHandlers } from '../ctx';
import { resolveSymbol } from '../market';

const lists = (ctx: MockCtx) => ctx.db.table<Watchlist & { sortKey: string }>('watchlists');

function clean(symbols: WatchlistSymbol[]): WatchlistSymbol[] {
  const seen = new Set<string>();
  const out: WatchlistSymbol[] = [];
  for (const s of symbols ?? []) {
    const key = resolveSymbol(String(s.key ?? '')) ?? String(s.key ?? '').toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row: WatchlistSymbol = { key };
    for (const f of ['alertAbove', 'alertBelow', 'alertPct'] as const) {
      const v = s[f];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) row[f] = v;
    }
    out.push(row);
  }
  return out.slice(0, 200);
}

export const handlers: MockHandlers = {
  watchlist_list: (_req, ctx) =>
    lists(ctx)
      .all()
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
      .map(({ id, name, symbols }) => ({ id, name, symbols })),

  watchlist_save: (req, ctx) => {
    const name = String(req.name ?? '').trim().slice(0, 120) || 'Watchlist';
    const symbols = clean(req.symbols);
    if (req.id) {
      if (!lists(ctx).has(req.id)) ctx.fail('NOT_FOUND', 'Watchlist not found');
      lists(ctx).update(req.id, (w) => {
        w.name = name;
        w.symbols = symbols;
      });
      return { id: req.id };
    }
    const all = lists(ctx).all().sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
    const id = ctx.id();
    lists(ctx).insert({ id, name, symbols, sortKey: ctx.keyBetween(all[all.length - 1]?.sortKey ?? null, null) });
    return { id };
  },
};

/** Seed helper (finance seed). */
export function seedWatchlist(ctx: MockCtx, name: string, symbols: WatchlistSymbol[]): string {
  const all = lists(ctx).all();
  const id = ctx.id();
  lists(ctx).insert({ id, name, symbols: clean(symbols), sortKey: ctx.keyBetween(all[all.length - 1]?.sortKey ?? null, null) });
  return id;
}
