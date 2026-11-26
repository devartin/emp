/**
 * The one glyph language (docs/DESIGN.md §8). Renders a page / app / habit / category `Icon` (SPEC §11.2) as a
 * monochrome Lucide glyph, always with absoluteStrokeWidth:
 *   row     16px @ 1.25  sidebar, breadcrumb, lists, menus (secondary ink)
 *   inline  14px @ 1.25  inside running text and chips
 *   header  40px @ 1.75  the page header (ink)
 * `{ t: 'lucide' }` renders directly. A legacy `{ t: 'emoji' }` is mapped through emoji-map.json at render time and
 * is never drawn as an emoji. With no icon (or an unmapped emoji) the header shows nothing, and rows show a neutral
 * file-text glyph in tertiary ink so the list stays aligned (chair resolution). Asset icons are drawn by the caller
 * (`asset` render prop), because loading an asset needs the backend.
 */
import type { ReactNode } from "react";
import type { Icon } from "@/backend/types";
import { cn } from "@/lib/cn";
import EMOJI_MAP from "./emoji-map.json";
import { GLYPHS } from "./glyphs";

export type GlyphContext = "row" | "inline" | "header";

const SIZE: Record<GlyphContext, { size: number; stroke: number }> = {
  row: { size: 16, stroke: 1.25 },
  inline: { size: 14, stroke: 1.25 },
  header: { size: 40, stroke: 1.75 },
};

const MAP = EMOJI_MAP as Record<string, string>;

/** Normalise an emoji for lookup: NFC, variation selectors stripped (the map's key convention). */
export function normaliseEmoji(e: string): string {
  return e.normalize("NFC").replace(/[︎️]/g, "").trim();
}

/** The Lucide icon name an emoji maps to, or null when the map has no entry. */
export function emojiToGlyph(emoji: string): string | null {
  const k = normaliseEmoji(emoji);
  if (MAP[k]) return MAP[k];
  // Drop skin tones and ZWJ tails ("🏃‍♀️" → "🏃"), then try the base pictograph.
  const base = Array.from(k.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "").split("‍")[0] ?? "")[0];
  return base && MAP[base] ? MAP[base] : null;
}

/** The glyph name an Icon resolves to (lucide name, mapped emoji), or null. */
export function glyphName(icon: Icon | null | undefined): string | null {
  if (!icon) return null;
  if (icon.t === "lucide") return GLYPHS[icon.v] ? icon.v : null;
  if (icon.t === "emoji") return emojiToGlyph(icon.v);
  return null;
}

/** True when a glyph name is in the registry. */
export function hasGlyph(name: string): boolean {
  return !!GLYPHS[name];
}

export interface GlyphProps {
  /** A Lucide name from the registry (pageIcons.ts or an emoji-map target). */
  name: string;
  context?: GlyphContext;
  /** Override the context size (px). Stroke stays absolute. */
  size?: number;
  className?: string;
  "aria-label"?: string;
}

/** One registered Lucide glyph at a context size, absoluteStrokeWidth. Renders nothing for unknown names. */
export function Glyph({ name, context = "row", size, className, ...aria }: GlyphProps) {
  const G = GLYPHS[name];
  if (!G) return null;
  const s = SIZE[context];
  const label = aria["aria-label"];
  return <G size={size ?? s.size} strokeWidth={s.stroke} absoluteStrokeWidth className={cn("flex-none", className)} aria-hidden={label ? undefined : true} aria-label={label} />;
}

export interface PageGlyphProps {
  icon?: Icon | null;
  context?: GlyphContext;
  size?: number;
  /** What to show with no icon: "auto" = nothing in the header, a tertiary file-text glyph elsewhere. */
  fallback?: "auto" | "none" | "file";
  /** Renders `{ t: 'asset' }` icons (the caller owns asset loading). */
  asset?: (assetId: string, size: number) => ReactNode;
  className?: string;
}

/** A page / app icon in the one glyph language. Header glyphs are ink; row and inline glyphs are secondary ink. */
export function PageGlyph({ icon, context = "row", size, fallback = "auto", asset, className }: PageGlyphProps) {
  const px = size ?? SIZE[context].size;
  if (icon?.t === "asset") return asset ? <>{asset(icon.assetId, px)}</> : null;
  const name = glyphName(icon);
  const tone = context === "header" ? "text-primary" : "text-secondary";
  if (name) return <Glyph name={name} context={context} size={px} className={cn(tone, className)} />;
  const showFile = fallback === "file" || (fallback === "auto" && context !== "header");
  return showFile ? <Glyph name="file-text" context={context} size={px} className={cn("text-tertiary", className)} /> : null;
}
