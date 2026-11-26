/** Ranges (in the transaction's final doc) touched by a transaction — for incremental decoration updates. */
import type { Transaction } from '@tiptap/pm/state';

export function changedRanges(tr: Transaction): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const maps = tr.mapping.maps;
  maps.forEach((map, i) => {
    map.forEach((_os, _oe, ns, ne) => {
      const rest = tr.mapping.slice(i + 1);
      out.push({ from: rest.map(ns, -1), to: rest.map(ne, 1) });
    });
  });
  return out;
}
