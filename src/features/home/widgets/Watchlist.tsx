/** Watchlist (§6.4 row 3): 32px rows — ticker (600), name, 64×20 sparkline, price with tick flash, delta chip. */
import { ArrowRight, LineChart } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/backend";
import type { MarketSearchResult, SymbolKey, Watchlist } from "@/backend/types";
import { navigate } from "@/app/router";
import { Sparkline } from "@/charts/Sparkline";
import { formatNumber } from "@/lib/format";
import { useQuotes } from "@/stores/market";
import { Button } from "@/ui/Button";
import { DeltaPill } from "@/ui/DeltaPill";
import { PriceFlash } from "@/ui/PriceFlash";
import { Skeleton } from "@/ui/Skeleton";

const sparkCache = new Map<SymbolKey, number[]>();

function useSpark(symbol: SymbolKey) {
  const [data, setData] = useState<number[] | null>(() => sparkCache.get(symbol) ?? null);
  useEffect(() => {
    if (sparkCache.has(symbol)) return;
    const to = new Date();
    const from = new Date(to.getTime() - 40 * 86_400_000);
    api.market
      .bars({ symbol, interval: "1d", from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), adjusted: true })
      .then((b) => {
        const c = b.c.slice(-30);
        sparkCache.set(symbol, c);
        setData(c);
      })
      .catch(() => setData([]));
  }, [symbol]);
  return data;
}

function Row({ symbol, name, quote }: { symbol: SymbolKey; name: string; quote?: { price: number; changePct: number; currency: string } }) {
  const spark = useSpark(symbol);
  const ticker = symbol.split(":")[0];
  return (
    <button type="button" className="hm-wl-row" onClick={() => navigate({ t: "markets", symbol })}>
      <span className="w-[52px] flex-none truncate text-body-sm font-semibold text-primary">{ticker}</span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-tertiary">{name}</span>
      <span className="w-16 flex-none">{spark && spark.length > 1 ? <Sparkline data={spark} width={64} height={20} endDot={false} area={false} aria-label={`${ticker} last 30 days`} /> : <Skeleton width={64} height={12} />}</span>
      <span className="w-[76px] flex-none text-right text-body-sm tabular text-primary">
        {quote ? <PriceFlash value={quote.price} symbol={symbol}>{formatNumber(quote.price, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</PriceFlash> : <Skeleton width={56} height={12} />}
      </span>
      <span className="w-[72px] flex-none text-right">{quote ? <DeltaPill value={quote.changePct > 1 || quote.changePct < -1 ? quote.changePct / 100 : quote.changePct} /> : null}</span>
    </button>
  );
}

export function WatchlistWidget() {
  const [list, setList] = useState<Watchlist | null | undefined>(undefined);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    api.watchlist
      .list()
      .then((l) => setList(l[0] ?? null))
      .catch(() => setList(null));
  }, []);
  const symbols = (list?.symbols ?? []).slice(0, 6).map((s) => s.key);
  const quotes = useQuotes(symbols);
  useEffect(() => {
    for (const s of symbols) {
      if (names[s]) continue;
      api.market
        .search({ q: s.split(":")[0], limit: 3, reqId: 1 })
        .then((r) => {
          const hit = r.results.find((x: MarketSearchResult) => x.symbol === s) ?? r.results[0];
          if (hit) setNames((n) => ({ ...n, [s]: hit.name }));
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join(",")]);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="hm-title"><LineChart size={15} aria-hidden />{list?.name ?? "Watchlist"}</h2>
        <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => navigate({ t: "markets" })}>Markets</Button>
      </div>
      {list === undefined ? (
        <div className="flex flex-col gap-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={24} />)}</div>
      ) : !symbols.length ? (
        <p className="py-3 text-body-sm text-tertiary">Add symbols in Markets to watch them here.</p>
      ) : (
        <div className="flex flex-col">
          {symbols.map((s, i) => (
            <Row key={s} symbol={s} name={names[s] ?? ""} quote={quotes[i]} />
          ))}
        </div>
      )}
      <p className="mt-auto text-[11px] text-tertiary">Delayed data · providers see only the symbols, never your positions.</p>
    </div>
  );
}
