import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const lastFlash = new Map<string, number>();

/**
 * Live price tick (docs/DESIGN.md §6.3, S16): the text tint flashes gain/loss and fades back over 600ms (colour only,
 * never a background block); at most once per second per symbol. 140ms under reduced motion.
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
    <span key={flash?.k ?? 0} className={cn(flash && "emp-flash", "tabular", className)} data-dir={flash?.dir}>
      {children}
    </span>
  );
}
