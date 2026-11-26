/**
 * A row's glyph (habits, areas): one monochrome Lucide family, no emoji (PROGRAMME-v3 owner ruling). Older rows that
 * still carry an emoji icon render its mapped glyph; an icon stored as a bare lucide name is accepted too.
 */
import { CircleDot } from "lucide-react";
import type { Icon } from "@/backend/types";
import { cn } from "@/lib/cn";
import { glyphForEmoji, useLucide } from "@/features/shell/icons";

export function glyphName(icon: Icon | undefined): string | undefined {
  if (!icon) return undefined;
  if (icon.t === "lucide") return icon.v;
  if (icon.t === "emoji") return glyphForEmoji(icon.v) ?? (/^[a-z0-9-]+$/.test(icon.v) ? icon.v : undefined);
  return undefined;
}

export function Glyph({ icon, size = 16, className }: { icon: Icon | undefined; size?: number; className?: string }) {
  const L = useLucide(glyphName(icon)) ?? CircleDot;
  return <L size={size} strokeWidth={1.5} absoluteStrokeWidth className={cn("flex-none text-secondary", className)} aria-hidden />;
}
