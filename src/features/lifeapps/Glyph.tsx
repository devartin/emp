/**
 * A row's glyph (habits, areas): the kit's one glyph language (`PageGlyphWith` against the static registry), no
 * emoji (PROGRAMME-v3 owner ruling). Older rows that still carry an emoji icon render its mapped glyph; an icon stored
 * as a bare lucide name in an emoji slot is accepted too. Unknown names fall back to a neutral dot.
 */
import { CircleDot } from "lucide-react";
import type { Icon } from "@/backend/types";
import { cn } from "@/lib/cn";
import { PageGlyphWith, requestedGlyph } from "@/ui/icons/glyphCore";
import { GLYPHS } from "@/ui/icons/glyphs";

/** The Icon as the registry should see it: a bare lucide name stored as `{ t: 'emoji' }` becomes `{ t: 'lucide' }`. */
function normalise(icon: Icon | undefined): Icon | undefined {
  if (icon?.t === "emoji" && /^[a-z0-9-]+$/.test(icon.v)) return { t: "lucide", v: icon.v };
  return icon;
}

export function glyphName(icon: Icon | undefined): string | undefined {
  const name = requestedGlyph(normalise(icon));
  return name && GLYPHS[name] ? name : undefined;
}

const lookup = (name: string) => GLYPHS[name];

export function Glyph({ icon, size = 16, className }: { icon: Icon | undefined; size?: number; className?: string }) {
  return <PageGlyphWith icon={normalise(icon)} size={size} fallback="file" kindFallback={CircleDot} lookup={lookup} className={cn("text-secondary", className)} />;
}
