import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const lastFlash = new Map<string, number>();

/**
 * Live price tick (§4.2): background flash of gain/loss soft at .24 fading over 900ms; at most once per second per
 * symbol. Disabled under reduced motion via CSS.
 */
export function PriceFlash({ value, symbol, children, className }: { value: number; symbol: string; children: ReactNode; className?: string }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ dir: "up" | "down"; k: number } | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (value === p) return;
    const now = Date.now();
    if (now - (lastFlash.get(symbol) ?? 0) < 1000) return;
    lastFlash.set(symbol, now);
    setFlash((f) => ({ dir: value > p ? "up" : "down", k: (f?.k ?? 0) + 1 }));
  }, [value, symbol]);
  return (
    <span key={flash?.k ?? 0} className={cn(flash && "emp-flash", "tabular", className)} data-dir={flash?.dir} style={{ padding: "0 2px", margin: "0 -2px" }}>
      {children}
    </span>
  );
}
