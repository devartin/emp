/** Quote tile and quote row (§17.2): live price with tick flash, signed change, sparkline, freshness chip. */
import type { Quote, SymbolKey } from "@/backend/types";
import { Sparkline } from "@/charts/Sparkline";
import { cn } from "@/lib/cn";
import { useQuote } from "@/stores/market";
import { Delta } from "@/ui/Delta";
import { GainLoss } from "@/ui/DeltaPill";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { PriceFlash } from "@/ui/PriceFlash";
import { Skeleton } from "@/ui/Skeleton";
import { fmtPrice } from "../finance/shared/format";
import { FreshnessBadge } from "../finance/shared/ui";
import { ticker, useSparkline, useSymbolInfo } from "./data";

export function QuoteTile({ symbol, onClick, selected, compact }: { symbol: SymbolKey; onClick?: () => void; selected?: boolean; compact?: boolean }) {
  const q = useQuote(symbol);
  const info = useSymbolInfo(symbol);
  const spark = useSparkline(symbol);
  return (
    <button
      type="button"
      className={cn("mk-tile", selected && "is-selected")}
      data-compact={compact ? "" : undefined}
      aria-pressed={onClick ? !!selected : undefined}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2 w-full">
        <div className="min-w-0 text-left">
          <div className="mk-tile-ticker">{ticker(symbol)}</div>
          <div className="mk-tile-name truncate">{info?.name ?? " "}</div>
        </div>
        {q ? <FreshnessBadge freshness={q.freshness} source={q.source} delayedMin={q.delayedMin} /> : null}
      </div>
      <div className="flex items-end justify-between gap-2 w-full mt-2">
        <div className="text-left">
          {q ? (
            <>
              <div className="mk-tile-price">
                <PriceFlash value={q.price} symbol={symbol}>
                  <RollingNumber value={q.price} format={(n) => fmtPrice(n, q.currency)} countUp={false} />
                </PriceFlash>
              </div>
              <Delta percent={q.changePct} digits={2} className="text-caption" />
            </>
          ) : (
            <>
              <Skeleton width={90} height={20} />
              <Skeleton width={60} height={16} className="mt-1.5" radius={4} />
            </>
          )}
        </div>
        <div className="w-[88px] flex-none">{spark.length > 1 ? <Sparkline data={spark} height={34} live={q?.freshness === "live"} aria-label={`${ticker(symbol)} last month`} /> : null}</div>
      </div>
    </button>
  );
}

/** One quote line (watchlists, doc blocks). */
export function QuoteRow({ symbol, q, onClick, selected, trailing }: { symbol: SymbolKey; q?: Quote; onClick?: () => void; selected?: boolean; trailing?: React.ReactNode }) {
  const live = useQuote(symbol);
  const quote = q ?? live;
  const info = useSymbolInfo(symbol);
  const spark = useSparkline(symbol);
  return (
    <div role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} className={cn("mk-row", selected && "is-selected")} onClick={onClick} onKeyDown={(e) => onClick && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick())}>
      <div className="min-w-0 flex-1">
        <div className="mk-row-ticker">{ticker(symbol)}</div>
        <div className="mk-row-name truncate">{info?.name ?? ""}</div>
      </div>
      <div className="w-[48px] flex-none">{spark.length > 1 ? <Sparkline data={spark} height={22} endDot={false} aria-label={`${ticker(symbol)} trend`} /> : null}</div>
      <div className="w-[92px] text-right flex-none">
        {quote ? (
          <>
            <div className="mk-row-price">
              <PriceFlash value={quote.price} symbol={symbol}>
                <RollingNumber value={quote.price} format={(n) => fmtPrice(n, quote.currency)} countUp={false} />
              </PriceFlash>
            </div>
            <GainLoss value={quote.changePct} className="text-caption font-semibold">
              {quote.changePct >= 0 ? "+" : "−"}
              {Math.abs(quote.changePct * 100).toFixed(2)}%
            </GainLoss>
          </>
        ) : (
          <Skeleton width={70} height={12} className="ml-auto" />
        )}
      </div>
      {trailing}
    </div>
  );
}
