import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { shortcutKeys, shortcutLabel } from "@/lib/platform";
import { installKeycaps, normalizeKey, specKeys } from "./motion/keycaps";

export interface KbdProps {
  /** Shortcut spec ("mod+shift+l", "⌘K", "esc"). Rendered as one keycap per key, platform-aware (§5.11). */
  keys?: string;
  children?: ReactNode;
  /** xs = 16px mini keycap (menus, buttons, tooltips); sm = 20px keycap. */
  size?: "xs" | "sm";
  className?: string;
  /** Don't depress with the real key (static documentation). */
  inert?: boolean;
}

/**
 * Kbd — living keycaps (docs/DESIGN.md §4.3, S1): a 20px slab (`--edge` 1.5px) per key that physically depresses while
 * the real key is held. Each key renders `data-key`; a module-level listener toggles `data-down`.
 */
export function Kbd({ keys, children, size = "sm", className, inert }: KbdProps) {
  useEffect(() => (inert ? undefined : installKeycaps()), [inert]);
  if (keys) {
    const parts = shortcutKeys(keys);
    const ids = specKeys(keys);
    return (
      <span className={cn("emp-kbd-group", className)} aria-label={shortcutLabel(keys)} role="img">
        {parts.map((k, i) => (
          <kbd key={i} className="emp-kbd keycap" data-size={size === "xs" ? "xs" : undefined} data-key={inert ? undefined : ids[i]} aria-hidden>
            {k}
          </kbd>
        ))}
      </span>
    );
  }
  const key = typeof children === "string" ? normalizeKey(children) : undefined;
  return (
    <kbd className={cn("emp-kbd keycap", className)} data-size={size === "xs" ? "xs" : undefined} data-key={inert ? undefined : key}>
      {children}
    </kbd>
  );
}
