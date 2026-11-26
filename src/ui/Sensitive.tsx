import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { usePrivacy } from "./motion/useReducedEffects";

export interface SensitiveProps {
  children: ReactNode;
  /** Mask alignment (right-aligned table numbers use "end"). */
  align?: "start" | "end";
  className?: string;
  as?: "span" | "div";
}

/**
 * Hide-numbers wrapper (§5.10): under html[data-privacy="on"] renders a same-width ••••• mask (CSS) and removes the
 * real value from the accessibility tree. Use for every money / balance / quantity display.
 */
export function Sensitive({ children, align, className, as = "span" }: SensitiveProps) {
  const hidden = usePrivacy();
  const Tag = as;
  return (
    <Tag className={cn(className)} data-sensitive="" data-align={align === "end" ? "end" : undefined} aria-label={hidden ? "Hidden" : undefined} role={hidden ? "img" : undefined}>
      <span aria-hidden={hidden || undefined} style={{ display: "contents" }}>
        {children}
      </span>
    </Tag>
  );
}
