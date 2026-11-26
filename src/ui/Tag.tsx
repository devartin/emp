import { Check, X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { BLOCK_COLORS, fnv1a, type BlockColorName } from "@/lib/hash";
import { renderIcon, type IconComponent } from "./Button";

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

/** Tag (docs/DESIGN.md §6.3): printed, not raised — 20px, radius 5, block-colour face with a 1px inner rim. */
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

export interface FilterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Latched (on). */
  active?: boolean;
  children: ReactNode;
  icon?: IconComponent | ReactNode;
  /** Trailing count (tertiary). */
  count?: number;
}

/**
 * Filter chip (docs/DESIGN.md §6.3): a tag-shaped keycap (`.slab`, 1.5px edge). Active = latched half-down with a
 * check sliding in (x −4 → 0, 120ms). Use for database / Money HQ filter rows; give the row 4px of bottom room.
 */
export function FilterChip({ active, children, icon, count, className, ...rest }: FilterChipProps) {
  return (
    <button type="button" className={cn("emp-chip slab", className)} aria-pressed={!!active} data-check="" {...rest}>
      <span className="emp-chip-check" aria-hidden>
        <Check strokeWidth={2.6} />
      </span>
      {renderIcon(icon)}
      <span>{children}</span>
      {count !== undefined ? <span className="emp-chip-count tabular">{count}</span> : null}
    </button>
  );
}
