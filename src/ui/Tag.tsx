import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { BLOCK_COLORS, fnv1a, type BlockColorName } from "@/lib/hash";

export type TagColor = BlockColorName | "default";

export interface TagProps {
  children: ReactNode;
  color?: TagColor;
  /** Show a remove button (always, or only on hover inside editors). */
  onRemove?: () => void;
  removeOnHover?: boolean;
  className?: string;
  title?: string;
}

/** Select/multi-select tag pill (§5.3): 20px, px 6, radius 4, 12/16 500, block colours (§3.4). */
export function Tag({ children, color = "gray", onRemove, removeOnHover, className, title }: TagProps) {
  const c = color === "default" ? "gray" : color;
  return (
    <span
      className={cn("emp-tag", className)}
      data-removable-hover={onRemove && removeOnHover ? "" : undefined}
      style={{ ["--tag-fg" as string]: `var(--block-${c}-text)`, ["--tag-bg" as string]: `var(--block-${c}-bg)` }}
      title={title}
    >
      <span className="emp-tag-label">{children}</span>
      {onRemove ? (
        <button type="button" className="emp-tag-remove" aria-label="Remove" onClick={onRemove}>
          <X aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** Next colour in a seeded rotation for newly created options (§5.3). */
export function nextTagColor(seed: string, existing: readonly TagColor[] = []): BlockColorName {
  const palette = BLOCK_COLORS.filter((c) => c !== "gray");
  const start = fnv1a(seed) % palette.length;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[(start + i) % palette.length];
    if (!existing.includes(c)) return c;
  }
  return palette[(start + existing.length) % palette.length];
}
