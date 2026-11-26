/**
 * Markets (§17.2): index strip, watchlists with live quotes, a symbol page with the price chart, key stats,
 * 52-week range, your position (from Portfolio) and alerts. Only ticker symbols ever leave the device.
 */
import { Bell, CandlestickChart, Plus, ShieldCheck } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { SymbolKey } from "@/backend/types";
import { navigate } from "@/app/router";
import { useQuote } from "@/stores/market";
import { useWorkspace } from "@/stores/workspace";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { DeltaPill } from "@/ui/DeltaPill";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/ui/Menu";
import { EdgeLight } from "@/ui/motion/EdgeLight";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { PriceFlash } from "@/ui/PriceFlash";
import { Sensitive } from "@/ui/Sensitive";
import { Skeleton } from "@/ui/Skeleton";
import { fmtPrice, fmtQty, fmtWhole } from "../finance/shared/format";
import { baseCurrency } from "../finance/shared/currency";
import { useAsync } from "../finance/shared/hooks";
import { FreshnessBadge, HubPage, MarketStateChip } from "../finance/shared/ui";
import "./markets.css";
import PriceChart from "./CandleChart";
import { ticker, useBars, useSymbolInfo, useWatchlists, useWatchlistsLoaded } from "./data";
import { QuoteTile } from "./QuoteTile";
import { SymbolSearch } from "./SymbolSearch";
import { AlertDialog, WatchlistPanel } from "./Watchlist";

export interface MarketsPageProps {
  symbol?: SymbolKey;
}

const INDICES: SymbolKey[] = ["EMP500:INDEX", "EMPT100:INDEX", "BTC:CRYPTO", "EURUSD:FX"];

export default function MarketsPage({ symbol }: MarketsPageProps) {
  const lists = useWatchlistsLoaded();
  const fallback = lists[0]?.symbols[0]?.key ?? "EMPX:XNAS";
  const selected = symbol ?? fallback;
  const bench = useQuote("EMP500:INDEX");
  const select = (s: SymbolKey) => navigate({ t: "markets", symbol: s }, { replace: true });
  return (
    <HubPage
      icon={CandlestickChart}
      tone="iris"
      title="Markets"
      subtitle={bench ? <MarketStateChip state={bench.marketState} asOf={bench.asOf} /> : "Quotes, charts and watchlists"}
      actions={<SymbolSearch onPick={select} className="w-[300px]" />}
      wide
      footer={
        <footer className="fh-disclaimer">
          <ShieldCheck size={13} aria-hidden />
          <span>Providers see which symbols you look up and your IP address. Ultra Note never sends quantities, cost basis, account names or balances. Market data is for information only — not investment advice.</span>
        </footer>
      }
    >
      <div className="mk-indices">
        {INDICES.map((s) => (
          <div key={s}>
            <QuoteTile symbol={s} onClick={() => select(s)} selected={s === selected} />
          </div>
        ))}
      </div>
      <div className="fh-grid">
        <div className="fh-span-4">
          <WatchlistPanel selected={selected} onSelect={select} />
        </div>
        <div className="fh-span-8">
          <SymbolDetail key={selected} symbol={selected} />
        </div>
      </div>
    </HubPage>
  );
}

function SymbolDetail({ symbol }: { symbol: SymbolKey }) {
  const q = useQuote(symbol);
  const info = useSymbolInfo(symbol);
  const lists = useWatchlists((s) => s.lists);
  const [alertOpen, setAlertOpen] = useState(false);
  const year = useBars(symbol, "1y");
  const hi52 = year.bars.length ? Math.max(...year.bars.map((b) => b.high)) : null;
  const lo52 = year.bars.length ? Math.min(...year.bars.map((b) => b.low)) : null;
  const pfInstance = useWorkspace((s) => s.lifeapps.find((i) => i.appId === "portfolio")?.id);
  const pf = useAsync(() => (pfInstance ? api.portfolio.summary({ instanceId: pfInstance }) : Promise.resolve(null)), [pfInstance]);
  const holding = pf.data?.holdings.find((h) => h.symbol === symbol);
  const inList = lists.find((l) => l.symbols.some((s) => s.key === symbol));
  const item = inList?.symbols.find((s) => s.key === symbol);
  const [listForAlert, setListForAlert] = useState<string | null>(null);
  useEffect(() => setListForAlert(inList?.id ?? null), [inList?.id]);
  const reduced = useReducedMotionPref();
  const pos = useMemo(() => (q && lo52 !== null && hi52 !== null && hi52 > lo52 ? (q.price - lo52) / (hi52 - lo52) : null), [q, lo52, hi52]);
  return (
    <section className="fh-card mk-detail" data-light="">
      <EdgeLight />
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-h3">{ticker(symbol)}</h2>
            <span className="text-body text-secondary truncate">{info?.name}</span>
            {info ? <Badge tone="outline">{info.exchange}</Badge> : null}
          </div>
          <div className="flex items-baseline gap-3 mt-1.5">
            {q ? (
              <>
                <span className="mk-price">
                  <PriceFlash value={q.price} symbol={symbol}>
                    <RollingNumber value={q.price} format={(n) => fmtPrice(n, q.currency)} countUp={false} />
                  </PriceFlash>
                </span>
                <span className={q.change >= 0 ? "emp-gain tabular font-semibold" : "emp-loss tabular font-semibold"}>
                  <RollingNumber value={q.change} format={(n) => `${n >= 0 ? "+" : "\u2212"}${fmtPrice(Math.abs(n), q.currency)}`} countUp={false} />
                </span>
                <DeltaPill value={q.changePct} digits={2} label="today" />
              </>
            ) : (
              <Skeleton width={200} height={34} />
            )}
          </div>
          <div className="flex items-center gap-3 mt-2">
            {q ? <FreshnessBadge freshness={q.freshness} source={q.source} delayedMin={q.delayedMin} /> : null}
            {q ? <MarketStateChip state={q.marketState} asOf={q.asOf} /> : null}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {inList ? (
            <Button size="sm" variant="secondary" icon={Bell} onClick={() => setAlertOpen(true)}>
              {item?.alertAbove || item?.alertBelow || item?.alertPct ? "Edit alerts" : "Set alert"}
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant={inList ? "ghost" : "primary"} icon={Plus}>
                {inList ? `In ${inList.name}` : "Watch"}
              </Button>
            </MenuTrigger>
            <MenuContent align="end" width={220}>
              <MenuLabel>Add to watchlist</MenuLabel>
              {lists.map((l) => (
                <MenuItem key={l.id} disabled={l.symbols.some((s) => s.key === symbol)} onSelect={() => void useWatchlists.getState().add(l.id, symbol)}>
                  {l.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
      </div>

      <div className="mt-4">
        <PriceChart symbol={symbol} currency={q?.currency ?? baseCurrency()} height={330} />
      </div>

      <div className="mk-stats">
        <Stat label="Open" value={q?.open !== undefined ? fmtPrice(q.open, q.currency) : "—"} />
        <Stat label="Day high" value={q?.high !== undefined ? fmtPrice(q.high, q.currency) : "—"} />
        <Stat label="Day low" value={q?.low !== undefined ? fmtPrice(q.low, q.currency) : "—"} />
        <Stat label="Prev close" value={q?.prevClose !== undefined ? fmtPrice(q.prevClose, q.currency) : "—"} />
        <Stat label="Volume" value={q?.volume ? compactVol(q.volume) : "—"} />
        <div className="mk-stat mk-stat-wide">
          <span className="mk-stat-label">52-week range</span>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-caption tabular text-secondary">{lo52 !== null ? fmtPrice(lo52) : "—"}</span>
            <span className="mk-range">
              {pos !== null ? (
                <m.span className="mk-range-rail" initial={reduced ? false : { x: "0%" }} animate={{ x: `${Math.max(0, Math.min(1, pos)) * 100}%` }} transition={reduced ? { duration: 0 } : { ...spring.settle, delay: 0.2 }}>
                  <i />
                </m.span>
              ) : null}
            </span>
            <span className="text-caption tabular text-secondary">{hi52 !== null ? fmtPrice(hi52) : "—"}</span>
          </div>
        </div>
      </div>

      {holding && pfInstance ? (
        <button type="button" className="mk-position" onClick={() => navigate({ t: "app", instanceId: pfInstance, tab: `holding:${symbol}` })}>
          <span className="text-caption text-secondary" style={{ fontWeight: 500 }}>
            Your position
          </span>
          <span className="flex items-baseline gap-4 tabular">
            <span className="text-body font-semibold">
              <Sensitive>{fmtQty(holding.qty)} sh · {fmtWhole(holding.value.amount, { currency: holding.value.currency })}</Sensitive>
            </span>
            <span className={Number(holding.gain.amount) >= 0 ? "emp-gain text-body-sm font-semibold" : "emp-loss text-body-sm font-semibold"}>
              <Sensitive>{fmtWhole(holding.gain.amount, { signed: true, currency: holding.gain.currency })}</Sensitive> ({holding.gainPct >= 0 ? "+" : "−"}
              {Math.abs(holding.gainPct * 100).toFixed(1)}%)
            </span>
            <span className="text-caption text-tertiary">{(holding.weight * 100).toFixed(1)}% of portfolio · open in Portfolio →</span>
          </span>
        </button>
      ) : null}
      {alertOpen && listForAlert && item ? <AlertDialog listId={listForAlert} item={item} onClose={() => setAlertOpen(false)} /> : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="mk-stat">
      <span className="mk-stat-label">{label}</span>
      <span className="mk-stat-value tabular">{value}</span>
    </div>
  );
}

function compactVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
