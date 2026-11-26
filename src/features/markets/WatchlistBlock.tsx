/** Watchlist block for docs (editor `watchlist` node): live quote rows; click opens the symbol in Markets. */
import { CandlestickChart } from "lucide-react";
import { navigate } from "@/app/router";
import { useQuotes } from "@/stores/market";
import { FreshnessBadge } from "../finance/shared/ui";
import "../finance/shared/finance.css";
import "./markets.css";
import { QuoteRow } from "./QuoteTile";

export interface WatchlistBlockProps {
  symbols: string[];
}

export default function WatchlistBlock({ symbols }: WatchlistBlockProps) {
  const list = symbols.filter(Boolean).slice(0, 50);
  const quotes = useQuotes(list);
  const fresh = quotes.find((q) => q)?.freshness;
  const src = quotes.find((q) => q)?.source;
  return (
    <div className="mk-block" contentEditable={false}>
      <div className="mk-block-head">
        <CandlestickChart size={14} />
        <span className="flex-1">Watchlist · {list.length} {list.length === 1 ? "symbol" : "symbols"}</span>
        {fresh && src ? <FreshnessBadge freshness={fresh} source={src} /> : null}
      </div>
      {list.length ? (
        list.map((s, i) => <QuoteRow key={s} symbol={s} q={quotes[i]} onClick={() => navigate({ t: "markets", symbol: s })} />)
      ) : (
        <div className="px-4 py-5 text-body-sm text-tertiary">Add symbols to this block to watch them here.</div>
      )}
    </div>
  );
}
