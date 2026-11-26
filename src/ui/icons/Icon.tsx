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
import type { Icon } from "@/backend/types";
import { cn } from "@/lib/cn";
import { GLYPHS } from "./glyphs";
import { canonicalGlyph, emojiToGlyph, PageGlyphWith, GLYPH_SIZE, type GlyphContext, type GlyphLookup, type PageGlyphProps } from "./glyphCore";

export { canonicalGlyph, emojiToGlyph, GLYPH_ALIASES, normaliseEmoji, PageGlyphWith, requestedGlyph, type GlyphContext, type GlyphLookup, type PageGlyphProps } from "./glyphCore";


/** The glyph name an Icon resolves to (lucide name, mapped emoji), or null. */
export function glyphName(icon: Icon | null | undefined): string | null {
  if (!icon) return null;
  if (icon.t === "lucide") {
    const n = canonicalGlyph(icon.v);
    return GLYPHS[n] ? n : null;
  }
  if (icon.t === "emoji") return emojiToGlyph(icon.v);
  return null;
}

/** True when a glyph name is in the registry. */
export function hasGlyph(name: string): boolean {
  return !!GLYPHS[canonicalGlyph(name)];
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
  const G = GLYPHS[canonicalGlyph(name)];
  if (!G) return null;
  const s = GLYPH_SIZE[context];
  const label = aria["aria-label"];
  return <G size={size ?? s.size} strokeWidth={s.stroke} absoluteStrokeWidth className={cn("flex-none", className)} aria-hidden={label ? undefined : true} aria-label={label} />;
}

const registryLookup: GlyphLookup = (name) => GLYPHS[canonicalGlyph(name)];

/** A page / app icon in the one glyph language. Header glyphs are ink; row and inline glyphs are secondary ink. */
export function PageGlyph(props: PageGlyphProps) {
  return <PageGlyphWith {...props} lookup={registryLookup} />;
}
