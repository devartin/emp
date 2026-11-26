/**
 * Syntax highlighting for code blocks (§7.11): lowlight decorations, cached per node so unchanged blocks are free.
 * Grammars load lazily; the plugin re-renders once a grammar arrives.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { grammarFor, lowlight, onGrammarLoaded } from '../lib/languages';
import { changedRanges } from '../lib/changed';

interface Span {
  from: number;
  to: number;
  cls: string;
}

type HastNode = { type: string; value?: string; children?: HastNode[]; properties?: { className?: string[] | string } };

const cache = new WeakMap<PMNode, { grammar: string | null; spans: Span[] }>();

function walk(nodes: HastNode[] | undefined, classes: string[], offset: number, out: Span[]): number {
  if (!nodes) return offset;
  for (const n of nodes) {
    if (n.type === 'text') {
      const len = n.value?.length ?? 0;
      if (classes.length && len) out.push({ from: offset, to: offset + len, cls: classes.join(' ') });
      offset += len;
    } else if (n.type === 'element') {
      const c = n.properties?.className;
      const extra = Array.isArray(c) ? c : c ? [c] : [];
      offset = walk(n.children, extra.length ? [...classes, ...extra] : classes, offset, out);
    }
  }
  return offset;
}

function spansFor(node: PMNode): Span[] {
  const grammar = grammarFor(node.attrs.language as string);
  const hit = cache.get(node);
  if (hit && hit.grammar === grammar) return hit.spans;
  const spans: Span[] = [];
  if (grammar && node.textContent.length < 200_000) {
    try {
      const tree = lowlight.highlight(grammar, node.textContent) as unknown as { children: HastNode[] };
      walk(tree.children, [], 0, spans);
    } catch {
      /* unhighlighted */
    }
  }
  cache.set(node, { grammar, spans });
  return spans;
}

function decosForBlock(node: PMNode, pos: number): Decoration[] {
  return spansFor(node).map((s) => Decoration.inline(pos + 1 + s.from, pos + 1 + s.to, { class: s.cls }));
}

/** Re-highlight only the code blocks a transaction touched. */
function update(old: DecorationSet, tr: Transaction): DecorationSet {
  let set = old.map(tr.mapping, tr.doc);
  const doc = tr.doc;
  const seen = new Set<number>();
  for (const r of changedRanges(tr)) {
    const from = Math.max(0, Math.min(r.from, doc.content.size));
    const to = Math.max(from, Math.min(r.to, doc.content.size));
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'codeBlock') {
        if (!seen.has(pos)) {
          seen.add(pos);
          set = set.remove(set.find(pos, pos + node.nodeSize)).add(doc, decosForBlock(node, pos));
        }
        return false;
      }
      return !node.isTextblock && !node.isAtom;
    });
  }
  return set;
}

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      for (const s of spansFor(node)) decos.push(Decoration.inline(pos + 1 + s.from, pos + 1 + s.to, { class: s.cls }));
      return false;
    }
    return !node.isTextblock && !node.isAtom;
  });
  return DecorationSet.create(doc, decos);
}

export const codeHighlightKey = new PluginKey<DecorationSet>('empCodeHighlight');

export const CodeHighlight = Extension.create({
  name: 'empCodeHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: codeHighlightKey,
        state: {
          init: (_c, state) => build(state.doc),
          apply: (tr, old) => (tr.getMeta(codeHighlightKey) ? build(tr.doc) : tr.docChanged ? update(old, tr) : old),
        },
        props: { decorations: (state) => codeHighlightKey.getState(state) },
        view(view) {
          const off = onGrammarLoaded(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(codeHighlightKey, true).setMeta('addToHistory', false));
          });
          return { destroy: off };
        },
      }),
    ];
  },
});
