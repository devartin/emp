/**
 * Shortcut labels in seeded tour text, for the platform the page is created on (mirrors Rust
 * `repo/tour.rs::platform_keys`): macOS keeps the ⌘ ⌥ ⇧ glyphs, Windows and Linux get "Ctrl+Shift+N" spelling.
 */
import type { TipTapDoc, TipTapNode } from '../../types';

/** "⌘⇧L" → "Ctrl+Shift+L" (and ⌥ → Alt, ↵ after a modifier → Enter). */
export function spellKeys(s: string): string {
  return s
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .replace(/\+↵/g, '+Enter');
}

function walk(n: TipTapNode): TipTapNode {
  const out: TipTapNode = { ...n };
  if (typeof out.text === 'string') out.text = spellKeys(out.text);
  if (out.content) out.content = out.content.map(walk);
  return out;
}

/** The doc with every text node's shortcut glyphs spelled out, unless `mac`. */
export function platformKeys<D extends TipTapDoc>(doc: D, mac: boolean): D {
  return mac ? doc : (walk(doc as unknown as TipTapNode) as unknown as D);
}
