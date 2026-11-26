import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";

export type BadgeTone = "neutral" | "accent" | "solid" | "gain" | "loss" | "success" | "danger" | "warning" | "info" | "outline";

/** Badge (§5.11): 18px, full radius, 11/14 600. */
export function Badge({ tone = "neutral", icon, dot, children, className }: { tone?: BadgeTone; icon?: IconComponent | ReactNode; dot?: boolean; children?: ReactNode; className?: string }) {
  return (
    <span className={cn("emp-badge", className)} data-tone={tone === "neutral" ? undefined : tone}>
      {dot ? <span className="emp-badge-dot" aria-hidden /> : null}
      {renderIcon(icon)}
      {children}
    </span>
  );
}
