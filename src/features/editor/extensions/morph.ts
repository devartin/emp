/**
 * Turn-into morph (docs/DESIGN.md S22): when a block's content type (or heading level) changes — slash "Turn into",
 * the bubble toolbar, markdown shortcuts ("# "), ⌘⌥1…, undo — the block's row morphs from the old type instead of
 * snapping: text size scales from the old size on the `morph` spring, list markers / check boxes slide in, and code or
 * callout wells settle in. Transform / opacity / filter only; nothing runs under reduced motion or for pure typing.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CONTAINER } from '../lib/blockTypes';
import { blockFontPx, springEase } from '../lib/fx';
import { isReducedMotion } from '@/ui/motion/useReducedEffects';

interface Change {
  id: string;
  from: string;
  fromLevel: number | null;
  to: string;
  toLevel: number | null;
}

interface MorphState {
  seq: number;
  changes: Change[];
}

const key = new PluginKey<MorphState>('empMorph');
const MAX = 6;

const sig = (n: PMNode | null | undefined) => (n ? { t: n.type.name, l: n.type.name === 'heading' ? Number(n.attrs.level) || 1 : null } : null);

function detect(tr: Transaction, oldDoc: PMNode): Change[] {
  if (!tr.docChanged || tr.getMeta('uiEvent') === 'paste' || tr.getMeta('uiEvent') === 'drop') return [];
  // Pure text typing never changes a block's type: skip the scan.
  const structural = tr.steps.some((s) => s instanceof ReplaceAroundStep || (s instanceof ReplaceStep && s.slice.content.firstChild?.isBlock));
  if (!structural) return [];
  const ranges: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_os, _oe, ns, ne) => ranges.push([rest.map(ns, -1), rest.map(ne, 1)]));
  });
  const inv = tr.mapping.invert();
  const out: Change[] = [];
  const seen = new Set<string>();
  const doc = tr.doc;
  for (const [a, b] of ranges) {
    if (out.length > MAX) return [];
    doc.nodesBetween(Math.max(0, a), Math.min(doc.content.size, Math.max(a, b)), (node, pos) => {
      if (out.length > MAX) return false;
      if (node.type.name !== CONTAINER) return true;
      const id = String(node.attrs.id ?? '');
      if (!id || seen.has(id)) return true;
      seen.add(id);
      const oldPos = inv.map(pos, 1);
      const old = oldDoc.nodeAt(oldPos);
      if (!old || old.type.name !== CONTAINER || old.attrs.id !== id) return true;
      const was = sig(old.firstChild);
      const now = sig(node.firstChild);
      if (was && now && (was.t !== now.t || was.l !== now.l)) out.push({ id, from: was.t, fromLevel: was.l, to: now.t, toLevel: now.l });
      return true;
    });
  }
  return out.length > MAX ? [] : out;
}

const LISTY = new Set(['bulletListItem', 'numberedListItem', 'todoItem', 'toggle']);
const WELLS = new Set(['codeBlock', 'callout']);

function play(root: HTMLElement, c: Change) {
  const block = root.querySelector<HTMLElement>(`.emp-block[data-id="${CSS.escape(c.id)}"]`);
  const row = block?.firstElementChild as HTMLElement | null;
  if (!block || !row || typeof row.animate !== 'function') return;
  const s = springEase('morph');
  const oldPx = blockFontPx(c.from, c.fromLevel, root);
  const newPx = blockFontPx(c.to, c.toLevel, root);
  const ratio = oldPx / newPx;
  if (WELLS.has(c.to) && !WELLS.has(c.from)) {
    // the well presses in under the text
    const settle = springEase('settle');
    block.animate([{ opacity: 0.4, transform: 'scale(.97)', filter: 'blur(1.5px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: settle.duration, easing: settle.easing });
    return;
  }
  if (Math.abs(ratio - 1) > 0.04) {
    row.animate(
      [
        { transform: `scale(${ratio.toFixed(3)})`, transformOrigin: '0 50%', opacity: 0.55, filter: 'blur(1px)' },
        { transform: 'none', transformOrigin: '0 50%', opacity: 1, filter: 'blur(0)', offset: 1 },
      ],
      { duration: s.duration, easing: s.easing },
    );
    return;
  }
  if (LISTY.has(c.to) !== LISTY.has(c.from) || LISTY.has(c.to)) {
    // a marker / box appears (or goes): the text glides sideways into its new indent
    const dx = LISTY.has(c.to) && !LISTY.has(c.from) ? -18 : LISTY.has(c.from) && !LISTY.has(c.to) ? 18 : -6;
    row.animate([{ transform: `translateX(${dx}px)`, opacity: 0.5 }, { transform: 'none', opacity: 1 }], { duration: s.duration, easing: s.easing });
    return;
  }
  row.animate([{ opacity: 0.45, filter: 'blur(1px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 220, easing: 'cubic-bezier(.2,0,0,1)' });
}

export const BlockMorph = Extension.create({
  name: 'empBlockMorph',
  addProseMirrorPlugins() {
    return [
      new Plugin<MorphState>({
        key,
        state: {
          init: () => ({ seq: 0, changes: [] }),
          apply(tr, prev, oldState) {
            const changes = isReducedMotion() ? [] : detect(tr, oldState.doc);
            return changes.length ? { seq: prev.seq + 1, changes } : prev.changes.length ? { seq: prev.seq, changes: [] } : prev;
          },
        },
        view() {
          let last = 0;
          return {
            update(view) {
              const st = key.getState(view.state);
              if (!st || !st.changes.length || st.seq === last) return;
              last = st.seq;
              const list = st.changes;
              requestAnimationFrame(() => list.forEach((c) => play(view.dom as HTMLElement, c)));
            },
          };
        },
      }),
    ];
  },
});
