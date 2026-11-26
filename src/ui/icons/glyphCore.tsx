/**
 * Registry-free core of the glyph language (docs/DESIGN.md §8): context sizes, the emoji → glyph mapping and
 * `PageGlyphWith`, which renders against any registry lookup. `Icon.tsx` binds it to the static registry; the shell's
 * sidebar binds it to its boot set plus the lazily loaded registry, so the boot chunk does not carry every glyph.
 */
import { FileText, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Icon } from "@/backend/types";
import { cn } from "@/lib/cn";
import EMOJI_MAP from "./emoji-map.json";

export type GlyphContext = "row" | "inline" | "header";

export const GLYPH_SIZE: Record<GlyphContext, { size: number; stroke: number }> = {
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

/** Looks a Lucide component up by registry name (null when unknown, or not loaded yet). */
export type GlyphLookup = (name: string) => LucideIcon | null | undefined;

/**
 * Older or banned Lucide names that stored data and manifests still use, resolved to a registered glyph: lucide's
 * renamed charts, and the Sparkles family (never shown, DESIGN §8: ✨ maps to `star`, so a sparkle does too).
 */
export const GLYPH_ALIASES: Readonly<Record<string, string>> = {
  "pie-chart": "chart-pie",
  "area-chart": "chart-area",
  "line-chart": "chart-line",
  "bar-chart": "chart-column",
  "candlestick-chart": "chart-candlestick",
  "receipt-text": "receipt",
  sparkle: "star",
  sparkles: "star",
};

/** A stored lucide name in its registry spelling (aliases resolved; unknown names pass through unchanged). */
export function canonicalGlyph(name: string): string {
  return GLYPH_ALIASES[name] ?? name;
}

/** The registry name an Icon asks for, before checking the registry: a lucide name or a mapped emoji. */
export function requestedGlyph(icon: Icon | null | undefined): string | null {
  if (!icon) return null;
  if (icon.t === "lucide") return canonicalGlyph(icon.v);
  if (icon.t === "emoji") return emojiToGlyph(icon.v);
  return null;
}

/**
 * `PageGlyph` against any registry lookup. The shell's sidebar uses it with its boot set plus the lazily loaded kit
 * registry, so the boot chunk does not carry every glyph; everything else uses `PageGlyph` (the static registry).
 * `kindFallback` replaces the neutral file-text row glyph (e.g. a database or sheet glyph for that page kind).
 */
export function PageGlyphWith({ icon, context = "row", size, fallback = "auto", asset, className, lookup, kindFallback }: PageGlyphProps & { lookup: GlyphLookup; kindFallback?: LucideIcon }) {
  const px = size ?? GLYPH_SIZE[context].size;
  const stroke = GLYPH_SIZE[context].stroke;
  if (icon?.t === "asset") return asset ? <>{asset(icon.assetId, px)}</> : null;
  const want = requestedGlyph(icon);
  const G = want ? lookup(want) : null;
  const tone = context === "header" ? "text-primary" : "text-secondary";
  if (G) return <G size={px} strokeWidth={stroke} absoluteStrokeWidth className={cn("flex-none", tone, className)} aria-hidden />;
  const showFile = fallback === "file" || (fallback === "auto" && context !== "header");
  if (!showFile) return null;
  const F = kindFallback ?? lookup("file-text") ?? FileText;
  return F ? <F size={px} strokeWidth={stroke} absoluteStrokeWidth className={cn("flex-none text-tertiary", className)} aria-hidden /> : null;
}

