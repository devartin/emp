/**
 * App tile — the app's keycap: its colour on the face, a darker side hanging below (lifeapps.css `.la-tile`).
 * Sizes: sm 22 · md 36 · lg 40 · xl 48 · hero 72. Decorative unless `label` is given.
 */
import type { CSSProperties, Ref } from "react";
import { cn } from "@/lib/cn";
import { identity } from "./identity";

const ICON = { sm: 12, md: 18, lg: 20, xl: 24, hero: 34 } as const;

export function AppTile({ appId, size = "md", className, style, label, ref }: { appId: string; size?: keyof typeof ICON; className?: string; style?: CSSProperties; label?: string; ref?: Ref<HTMLSpanElement> }) {
  const id = identity(appId);
  const Icon = id.icon;
  return (
    <span
      ref={ref}
      className={cn("la-tile", size !== "md" && `la-tile-${size}`, className)}
      style={{ background: id.color, ["--app" as string]: id.color, ...style }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Icon size={ICON[size]} strokeWidth={size === "hero" ? 1.9 : 2.1} aria-hidden />
    </span>
  );
}
