/**
 * Watchlist block for docs (editor `watchlist` node): live quote rows; click opens the symbol in Markets. When no
 * price can be loaded (offline mode, no connection) the rows show a dash and the block says why, instead of
 * placeholders that never resolve.
 */
import { CandlestickChart } from "lucide-react";
import { navigate } from "@/app/router";
import { useQuotes } from "@/stores/market";
import { useSettings } from "@/stores/settings";
import { FreshnessBadge } from "../finance/shared/ui";
import "../finance/shared/finance.css";
import "./markets.css";
import { useMarketAvailability } from "./data";
import { QuoteRow } from "./QuoteTile";

export interface WatchlistBlockProps {
  symbols: string[];
}

export default function WatchlistBlock({ symbols }: WatchlistBlockProps) {
  const list = symbols.filter(Boolean).slice(0, 50);
  const quotes = useQuotes(list);
  const offlineMode = useSettings((s) => s.vault?.offline ?? false);
  const { status } = useMarketAvailability(list, offlineMode);
  const down = status === "offline" || status === "unavailable";
  const fresh = quotes.find((q) => q)?.freshness;
  const src = quotes.find((q) => q)?.source;
  return (
    <div className="mk-block" contentEditable={false}>
      <div className="mk-block-head">
        <CandlestickChart size={14} />
        <span className="flex-1">Watchlist · {list.length} {list.length === 1 ? "symbol" : "symbols"}</span>
        {fresh && src ? <FreshnessBadge freshness={fresh} source={src} /> : null}
      </div>
      {down && !quotes.some(Boolean) ? (
        <div className="px-4 py-2 text-caption text-tertiary">{status === "offline" ? "Offline mode is on, so there are no new prices." : "Prices aren’t available right now."}</div>
      ) : null}
      {list.length ? (
        list.map((s, i) => <QuoteRow key={s} symbol={s} q={quotes[i]} unavailable={down} onClick={() => navigate({ t: "markets", symbol: s })} />)
      ) : (
        <div className="px-4 py-5 text-body-sm text-tertiary">Add symbols to this block to watch them here.</div>
      )}
    </div>
  );
}
