/**
 * Markdown shortcuts and typography replacements (§7.2). TipTap input rules never fire inside code, inline code, during
 * IME composition or on paste. ⌘Z / Backspace right after a rule reverts just the conversion (`undoInputRule`).
 */
import { Extension, InputRule, markInputRule } from '@tiptap/core';
import type { NodeType } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useSettings } from '@/stores/settings';
import { isTextContent } from '../lib/blockTypes';
import { blockFromResolved, emptyParagraphBlock, nextSibling, rebuildContainer, infoAt } from '../lib/blocks';

const setting = (k: 'typography' | 'markdownShortcuts'): boolean => useSettings.getState().vault?.[k] !== false;

type Make = (m: RegExpMatchArray) => { type: string; attrs?: Record<string, unknown> } | null;

/** Block-level rule: only at the very start of a text block. */
function blockRule(find: RegExp, make: Make): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      if (!setting('markdownShortcuts')) return null;
      const $from = state.doc.resolve(range.from);
      const info = blockFromResolved($from);
      if (!info || !isTextContent(info.content) || $from.parent !== info.content) return null;
      if (range.from !== info.contentPos + 1) return null;
      const target = make(match);
      if (!target) return null;
      const { schema } = state;
      const type: NodeType | undefined = schema.nodes[target.type];
      if (!type) return null;
      const tr = state.tr;
      tr.delete(range.from, range.to);
      const blk = infoAt(tr.doc, info.pos);
      if (!blk) return null;
      if (type.name === 'divider' || type.name === 'mathBlock') {
        const node = type.create(target.attrs ?? null);
        const rebuilt = rebuildContainer(schema, blk, node, null);
        tr.replaceWith(blk.pos, blk.end, rebuilt);
        if (blk.group) tr.insert(blk.pos + rebuilt.nodeSize, blk.group.content);
        const placed = infoAt(tr.doc, blk.pos);
        if (!placed) return null;
        if (type.name === 'divider') {
          let next = nextSibling(tr.doc, placed);
          if (!next) {
            tr.insert(placed.end, emptyParagraphBlock(schema));
            next = infoAt(tr.doc, placed.end);
          }
          if (next) tr.setSelection(TextSelection.near(tr.doc.resolve(next.contentPos + 1)));
        } else {
          tr.setSelection(NodeSelection.create(tr.doc, placed.contentPos));
        }
        return;
      }
      if (type.name === 'codeBlock') {
        const text = blk.content.textContent;
        tr.replaceWith(blk.contentPos, blk.contentEnd, type.create(target.attrs ?? null, text ? schema.text(text) : null));
        tr.setSelection(TextSelection.create(tr.doc, blk.contentPos + 1));
        return;
      }
      tr.setNodeMarkup(blk.contentPos, type, target.attrs ?? null);
    },
  });
}

function typo(find: RegExp, replace: string): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      if (!setting('typography')) return null;
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.spec.code) return null;
      state.tr.insertText(replace, range.from, range.to);
    },
  });
}

export const MarkdownShortcuts = Extension.create({
  name: 'empInputRules',
  priority: 120,
  addInputRules() {
    const { schema } = this.editor;
    return [
      blockRule(/^(#{1,3})\s$/, (m) => ({ type: 'heading', attrs: { level: m[1].length, toggle: false, collapsed: false } })),
      blockRule(/^[-*+]\s$/, () => ({ type: 'bulletItem' })),
      blockRule(/^(\d{1,3}|[a-z]|i{1,3}|iv|v)\.\s$/, () => ({ type: 'numberedItem', attrs: { start: null } })),
      blockRule(/^\[( ?)\]\s$/, () => ({ type: 'todoItem', attrs: { checked: false } })),
      blockRule(/^\[[xX]\]\s$/, () => ({ type: 'todoItem', attrs: { checked: true } })),
      blockRule(/^>\s$/, () => ({ type: 'toggle', attrs: { collapsed: false } })),
      blockRule(/^["“]\s$/, () => ({ type: 'quote' })),
      blockRule(/^(?:---|—-)$/, () => ({ type: 'divider' })),
      blockRule(/^```([\w+#.-]*)\s$/, (m) => ({ type: 'codeBlock', attrs: { language: m[1] ? m[1].toLowerCase() : 'plain', wrap: false, caption: '' } })),
      blockRule(/^\$\$\s$/, () => ({ type: 'mathBlock', attrs: { latex: '' } })),
      markInputRule({ find: /(?:^|\s)(~(?!\s)([^~]+)(?<!\s)~)$/, type: schema.marks.strike }),
      new InputRule({
        find: /\$\$([^$\n]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return null;
          const latex = match[1].trim();
          if (!latex) return null;
          state.tr.replaceWith(range.from, range.to, schema.nodes.mathInline.create({ latex }));
        },
      }),
      typo(/<->$/, '↔'),
      typo(/←>$/, '↔'),
      typo(/->$/, '→'),
      typo(/<-$/, '←'),
      typo(/>=$/, '≥'),
      typo(/<=$/, '≤'),
      typo(/!=$/, '≠'),
      typo(/(?<!-)--$/, '—'),
      typo(/\.\.\.$/, '…'),
      typo(/\([cC]\)$/, '©'),
    ];
  },
});
