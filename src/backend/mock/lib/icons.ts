/**
 * Emoji → Lucide mapping for the mock (owner ruling: no emoji in the app). Uses the kit's canonical table
 * (`src/ui/icons/emoji-map.json`), the same one the Rust store migration and importers embed
 * (`crates/emp-store/src/icons.rs`), so the demo maps exactly like the desktop app. Unmapped emoji give no icon.
 */
import type { Icon } from '../../types';
import table from '../../../ui/icons/emoji-map.json';

const MAP = new Map<string, string>();
const normalise = (s: string) => [...s.trim()].filter((c) => !/[︎️]/.test(c) && !/\p{Emoji_Modifier}/u.test(c)).join('');
for (const [k, v] of Object.entries(table as Record<string, string>)) if (/^[a-z0-9-]{1,64}$/.test(v)) MAP.set(normalise(k), v);

/** The Lucide icon name for `emoji` (exact sequence, then the first code point of a ZWJ sequence). */
export function lucideForEmoji(emoji: string): string | undefined {
  const key = normalise(emoji);
  if (!key) return undefined;
  return MAP.get(key) ?? MAP.get([...key][0]);
}

/** The icon generated and migrated callouts fall back to (Rust `icons::CALLOUT_FALLBACK`). */
export const CALLOUT_FALLBACK = 'lightbulb';

/** A Lucide icon value. */
export const lucide = (v: string, color?: Extract<Icon, { t: 'lucide' }>['color']): Icon => (color ? { t: 'lucide', v, color } : { t: 'lucide', v });

/** `lucide:<name>`, a bare Lucide name, or a legacy emoji (mapped) → icon; `undefined` when unmapped or empty. */
export function iconOf(s: string | null | undefined): Icon | undefined {
  const v = (s ?? '').trim();
  if (!v) return undefined;
  if (v.startsWith('lucide:')) return lucide(v.slice(7));
  if (/^[a-z0-9-]{1,64}$/.test(v)) return lucide(v);
  const name = lucideForEmoji(v);
  return name ? lucide(name) : undefined;
}

/** Converts a stored icon: emoji become Lucide (or nothing), everything else passes through. */
export function migrateIcon(icon: Icon | null | undefined): Icon | undefined {
  if (!icon) return undefined;
  if (icon.t !== 'emoji') return icon;
  const name = lucideForEmoji(icon.v);
  return name ? lucide(name) : undefined;
}
