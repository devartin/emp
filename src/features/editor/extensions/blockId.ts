/**
 * Block ids and structural invariants (§7.1), in `appendTransaction`:
 *   - every blockContainer has a unique 12-char id (duplicates are regenerated, the first occurrence keeps its id);
 *   - leaf blocks never have children (children are lifted out after the block);
 *   - no columnList inside a column (the nested columns are flattened into the column).
 * Pure text edits skip the scan, so typing stays cheap.
 */
import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep, AttrStep } from '@tiptap/pm/transform';
import { allowsChildren, CONTAINER } from '../lib/blockTypes';
import { BLOCK_ID_RE, newBlockId } from '../lib/ids';

const STRUCTURAL = new Set([CONTAINER, 'blockGroup', 'column', 'columnList']);

function sliceHasStructure(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((n) => {
    if (found) return false;
    if (STRUCTURAL.has(n.type.name)) found = true;
    return !found;
  });
  return found;
}

function trivial(tr: Transaction): boolean {
  return tr.steps.every((s) => (s instanceof ReplaceStep && !sliceHasStructure(s.slice) && (s as unknown as { structure?: boolean }).structure !== true) || s instanceof AttrStep);
}

export const blockIdKey = new PluginKey('empBlockIds');

/** Returns a transaction that fixes ids/invariants in `doc`, or null when nothing needs fixing. */
export function fixDocument(tr: Transaction): Transaction | null {
  const doc = tr.doc;
  const seen = new Set<string>();
  let changed = false;
  const lifts: { pos: number; node: PMNode }[] = [];
  const flattens: { pos: number; node: PMNode }[] = [];
  const visit = (node: PMNode, pos: number, inColumn: boolean): void => {
    if (node.type.name === CONTAINER) {
      const id = node.attrs.id as string | null;
      if (!id || !BLOCK_ID_RE.test(id) || seen.has(id)) {
        const fresh = newBlockId();
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: fresh });
        seen.add(fresh);
        changed = true;
      } else seen.add(id);
      const content = node.firstChild;
      if (content && node.childCount > 1 && !allowsChildren(content)) lifts.push({ pos, node });
      if (content?.type.name === 'columnList' && inColumn) flattens.push({ pos, node });
    }
    if (node.isTextblock || node.isAtom) return;
    let childPos = pos + 1;
    const childInColumn = inColumn || node.type.name === 'column';
    node.forEach((child) => {
      visit(child, childPos, childInColumn);
      childPos += child.nodeSize;
    });
  };
  let p = 0;
  doc.forEach((child) => {
    visit(child, p, false);
    p += child.nodeSize;
  });
  const structural = [...lifts.map((l) => ({ ...l, kind: 'lift' as const })), ...flattens.map((f) => ({ ...f, kind: 'flatten' as const }))].sort(
    (a, b) => b.pos - a.pos,
  );
  for (const fix of structural) {
    const pos = tr.mapping.map(fix.pos);
    const node = tr.doc.nodeAt(pos);
    if (!node || node.type.name !== CONTAINER) continue;
    const content = node.firstChild as PMNode;
    if (fix.kind === 'lift') {
      const group = node.child(1);
      const bare = node.type.create(node.attrs, content, node.marks);
      tr.replaceWith(pos, pos + node.nodeSize, Fragment.from(bare).append(group.content));
    } else {
      const blocks: PMNode[] = [];
      content.forEach((col) => col.firstChild?.forEach((b) => blocks.push(b)));
      tr.replaceWith(pos, pos + node.nodeSize, Fragment.from(blocks));
    }
    changed = true;
  }
  return changed ? tr : null;
}

export const BlockIds = Extension.create({
  name: 'empBlockIds',
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdKey,
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.docChanged)) return null;
          if (trs.every((t) => !t.docChanged || trivial(t))) return null;
          const tr = state.tr;
          const fixed = fixDocument(tr);
          if (fixed) fixed.setMeta('addToHistory', trs.every((t) => t.getMeta('addToHistory') !== false));
          return fixed;
        },
      }),
    ];
  },
});
