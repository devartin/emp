/** FNV-1a 32-bit — stable colour assignment for categories, avatars and tags (§3.5). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const BLOCK_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type BlockColorName = (typeof BLOCK_COLORS)[number];

/** Hashed block colour (skips gray so avatars feel alive). */
export function hashBlockColor(key: string): BlockColorName {
  const palette = BLOCK_COLORS.slice(1);
  return palette[fnv1a(key) % palette.length];
}

/**
 * Categorical palette indices (0..7) with collision resolution: `fnv1a(id) % 8`, then next free index (§3.5).
 * Returns a Map id → index; ids beyond 8 get -1 ("Other").
 */
export function assignCategorical(ids: readonly string[]): Map<string, number> {
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const id of ids) {
    if (used.size >= 8) {
      out.set(id, -1);
      continue;
    }
    let i = fnv1a(id) % 8;
    while (used.has(i)) i = (i + 1) % 8;
    used.add(i);
    out.set(id, i);
  }
  return out;
}

export const categoricalVar = (i: number) => (i < 0 ? "var(--cat-other)" : `var(--cat-${i + 1})`);
