/** Symbol search (§11.3 market_search): debounced, stale responses dropped via reqId, keyboard navigable. */
import { Search } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, latestRequest } from "@/backend";
import type { MarketSearchResult, SymbolKey } from "@/backend/types";
import { cn } from "@/lib/cn";
import { Kbd } from "@/ui/Kbd";
import { Spinner } from "@/ui/Spinner";
import { ticker } from "./data";

const TYPE_LABEL: Record<string, string> = { equity: "Stock", etf: "ETF", fund: "Fund", crypto: "Crypto", fx: "FX", index: "Index" };

export function SymbolSearch({ onPick, placeholder = "Search symbols or companies", autoFocus, className }: { onPick: (s: SymbolKey) => void; placeholder?: string; autoFocus?: boolean; className?: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<MarketSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [loading, setLoading] = useState(false);
  const seq = useRef(latestRequest());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const needle = q.replace(/^\$/, "").trim();
    if (!needle) {
      setResults([]);
      return;
    }
    const id = seq.current.next();
    setLoading(true);
    const t = setTimeout(() => {
      api.market
        .search({ q: needle, limit: 8, reqId: id })
        .then((r) => {
          if (!seq.current.isLatest(r.reqId)) return;
          setResults(r.results);
          setHi(0);
        })
        .catch(() => undefined)
        .finally(() => seq.current.isLatest(id) && setLoading(false));
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (s: SymbolKey) => {
    onPick(s);
    setQ("");
    setOpen(false);
  };

  return (
    <div ref={box} className={cn("mk-search", className)}>
      <div className="emp-input" data-size="sm">
        <span className="emp-input-icon">{loading ? <Spinner size={14} /> : <Search size={15} />}</span>
        <input
          autoFocus={autoFocus}
          value={q}
          placeholder={placeholder}
          aria-label="Search symbols"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="mk-search-list"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => Math.min(results.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter" && results[hi]) {
              e.preventDefault();
              pick(results[hi].symbol);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
        {!q ? <Kbd>/</Kbd> : null}
      </div>
      <AnimatePresence>
        {open && results.length ? (
          <m.ul id="mk-search-list" role="listbox" className="mk-search-list emp-pop" initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.16, ease: [0.16, 1, 0.3, 1] } }} exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}>
            {results.map((r, i) => (
              <li key={r.symbol} role="option" aria-selected={i === hi} className="mk-search-item" data-hi={i === hi ? "" : undefined} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(r.symbol); }}>
                <span className="mk-search-ticker">{ticker(r.symbol)}</span>
                <span className="flex-1 truncate">{r.name}</span>
                <span className="text-caption text-tertiary">{TYPE_LABEL[r.type] ?? r.type} · {r.exchange}</span>
              </li>
            ))}
          </m.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
