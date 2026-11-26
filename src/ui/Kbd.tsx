import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { shortcutKeys, shortcutLabel } from "@/lib/platform";
import { chordOf, installKeycaps, normalizeKey, specChord } from "./motion/keycaps";

export interface KbdProps {
  /** Shortcut spec ("mod+shift+l", "⌘K", "esc"). Rendered as one chip per key, platform-aware. */
  keys?: string;
  children?: ReactNode;
  /** xs = 16px chip (menus, buttons, tooltips); sm = 18px chip. */
  size?: "xs" | "sm";
  className?: string;
  /** Never goes down (static documentation). */
  inert?: boolean;
}

/**
 * Kbd — flat outlined chips (docs/DESIGN.md §5.2): 18px, radius 4, a 1px ring and a 1px bottom edge. A hint goes down
 * for 120ms only when its exact shortcut fires outside a text field (motion/keycaps.ts); typing never moves it.
 */
export function Kbd({ keys, children, size = "sm", className, inert }: KbdProps) {
  useEffect(() => (inert ? undefined : installKeycaps()), [inert]);
  if (keys) {
    const parts = shortcutKeys(keys);
    return (
      <span className={cn("emp-kbd-group", className)} aria-label={shortcutLabel(keys)} role="img" data-chord={inert ? undefined : specChord(keys)}>
        {parts.map((k, i) => (
          <kbd key={i} className="emp-kbd keycap" data-size={size === "xs" ? "xs" : undefined} aria-hidden>
            {k}
          </kbd>
        ))}
      </span>
    );
  }
  const key = typeof children === "string" ? normalizeKey(children) : undefined;
  return (
    <kbd className={cn("emp-kbd keycap", className)} data-size={size === "xs" ? "xs" : undefined} data-chord={inert || !key ? undefined : chordOf([key])}>
      {children}
    </kbd>
  );
}
