import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { RollingNumber } from "./motion/RollingNumber";

export type BadgeTone = "neutral" | "accent" | "solid" | "gain" | "loss" | "success" | "danger" | "warning" | "info" | "outline";

/**
 * Badge (docs/DESIGN.md §6.3): an 18px pill, a raised half-slab (1px edge) with a semantic soft face, 11/14 600.
 * A numeric child rolls when it changes. `dot` renders a status LED (`live` makes it breathe).
 */
export function Badge({ tone = "neutral", icon, dot, live, children, className }: { tone?: BadgeTone; icon?: IconComponent | ReactNode; dot?: boolean; live?: boolean; children?: ReactNode; className?: string }) {
  return (
    <span className={cn("emp-badge", className)} data-tone={tone === "neutral" ? undefined : tone}>
      {dot ? <span className="emp-badge-dot" data-live={live ? "" : undefined} aria-hidden /> : null}
      {renderIcon(icon)}
      {typeof children === "number" ? <RollingNumber value={children} countUp={false} format={(n) => String(Math.round(n))} /> : children}
    </span>
  );
}
