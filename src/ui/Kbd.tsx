import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { shortcutKeys, shortcutLabel } from "@/lib/platform";

export interface KbdProps {
  /** Shortcut spec ("mod+shift+l", "⌘K", "esc"). Rendered as one key cap per key, platform-aware (§5.11). */
  keys?: string;
  children?: ReactNode;
  size?: "xs" | "sm";
  className?: string;
}

export function Kbd({ keys, children, size = "sm", className }: KbdProps) {
  if (keys) {
    const parts = shortcutKeys(keys);
    return (
      <span className={cn("emp-kbd-group", className)} aria-label={shortcutLabel(keys)} role="img">
        {parts.map((k, i) => (
          <kbd key={i} className="emp-kbd" data-size={size === "xs" ? "xs" : undefined} aria-hidden>
            {k}
          </kbd>
        ))}
      </span>
    );
  }
  return (
    <kbd className={cn("emp-kbd", className)} data-size={size === "xs" ? "xs" : undefined}>
      {children}
    </kbd>
  );
}
