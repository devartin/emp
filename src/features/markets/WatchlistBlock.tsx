/** Placeholder entry (owned by the markets feature): a watchlist block embedded in a doc. */
import { Skeleton } from "@/ui/Skeleton";

export interface WatchlistBlockProps {
  symbols: string[];
}

export default function WatchlistBlock({ symbols }: WatchlistBlockProps) {
  return (
    <div className="my-2 rounded-lg border border-subtle py-1" role="status" aria-label="Loading watchlist">
      {(symbols.length ? symbols : ["", "", ""]).slice(0, 8).map((s, i) => (
        <div key={`${s}${i}`} className="flex h-8 items-center gap-3 px-3">
          <Skeleton width={44} height={10} />
          <Skeleton width={96} height={10} />
          <Skeleton width={64} height={16} radius={4} className="ml-auto" />
          <Skeleton width={56} height={10} />
        </div>
      ))}
    </div>
  );
}
