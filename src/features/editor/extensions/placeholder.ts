/**
 * Placeholders: the focused empty paragraph shows "Type '/' for commands"; empty headings, lists, to-dos, toggles,
 * quotes and callouts carry `is-empty` (CSS supplies their text). The set of empty blocks is kept incrementally so
 * typing in long documents stays O(changed blocks).
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { CONTAINER, TEXT_TYPES } from '../lib/blockTypes';
import { blockFromResolved } from '../lib/blocks';
import { changedRanges } from '../lib/changed';

export const placeholderKey = new PluginKey<DecorationSet>('empPlaceholder');

function emptyDeco(content: PMNode, pos: number): Decoration | null {
  if (!TEXT_TYPES.has(content.type.name) || content.content.size > 0 || content.type.name === 'paragraph') return null;
  return Decoration.node(pos, pos + content.nodeSize, { class: 'is-empty' }, { empty: true });
}

function collect(doc: PMNode, from: number, to: number, out: Decoration[]): void {
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === CONTAINER) {
      const content = node.firstChild;
      if (content) {
        const d = emptyDeco(content, pos + 1);
        if (d) out.push(d);
      }
      return true;
    }
    return node.type.name === 'blockGroup' || node.type.name === 'columnList' || node.type.name === 'column';
  });
}

function build(doc: PMNode): DecorationSet {
  const out: Decoration[] = [];
  collect(doc, 0, doc.content.size, out);
  return DecorationSet.create(doc, out);
}

function update(old: DecorationSet, tr: Transaction): DecorationSet {
  let set = old.map(tr.mapping, tr.doc);
  const doc = tr.doc;
  for (const r of changedRanges(tr)) {
    const $from = doc.resolve(Math.max(0, Math.min(r.from, doc.content.size)));
    const $to = doc.resolve(Math.max(0, Math.min(r.to, doc.content.size)));
    const from = $from.depth > 1 ? $from.before(Math.max(1, $from.depth - 1)) : 0;
    const to = $to.depth > 1 ? $to.after(Math.max(1, $to.depth - 1)) : doc.content.size;
    set = set.remove(set.find(from, to));
    const add: Decoration[] = [];
    collect(doc, from, to, add);
    if (add.length) set = set.add(doc, add);
  }
  return set;
}

export const Placeholders = Extension.create<{ emptyDoc: string }>({
  name: 'empPlaceholder',
  addOptions() {
    return { emptyDoc: "Write something, or press '/' for commands…" };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const emptyDoc = this.options.emptyDoc;
    return [
      new Plugin<DecorationSet>({
        key: placeholderKey,
        state: {
          init: (_c, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? update(old, tr) : old),
        },
        props: {
          decorations(state) {
            if (!editor.isEditable) return DecorationSet.empty;
            let set = placeholderKey.getState(state) ?? DecorationSet.empty;
            const sel = state.selection;
            const cur = sel.empty ? blockFromResolved(sel.$from) : null;
            const focused = editor.view.hasFocus();
            const root = state.doc.firstChild;
            const only = root?.childCount === 1 ? root.firstChild : null;
            const extra: Decoration[] = [];
            if (cur && cur.content.content.size === 0 && TEXT_TYPES.has(cur.content.type.name)) {
              if (cur.content.type.name === 'paragraph') {
                const text = focused ? "Type '/' for commands" : cur.node === only ? emptyDoc : '';
                if (text) extra.push(Decoration.node(cur.contentPos, cur.contentEnd, { class: 'is-empty', 'data-placeholder': text }));
              } else if (focused) {
                extra.push(Decoration.node(cur.contentPos, cur.contentEnd, { class: 'is-current' }));
              }
            } else if (only && only.firstChild?.type.name === 'paragraph' && only.firstChild.content.size === 0) {
              extra.push(Decoration.node(1 + 1, 1 + 1 + only.firstChild.nodeSize, { class: 'is-empty', 'data-placeholder': emptyDoc }));
            }
            if (extra.length) set = set.add(state.doc, extra);
            return set;
          },
        },
      }),
    ];
  },
});
