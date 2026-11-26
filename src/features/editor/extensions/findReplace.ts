/**
 * Find & replace (§7.9): incremental matches with decorations, case-sensitive and whole-word toggles, next/previous,
 * replace and replace-all (a single undo step). Matches inside collapsed toggles expand them when visited.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { revealPos } from '../lib/blocks';

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  index: number;
  matches: FindMatch[];
  decos: DecorationSet;
}

type Meta = { set: Partial<Pick<FindState, 'open' | 'query' | 'caseSensitive' | 'wholeWord' | 'index'>> };

export const findKey = new PluginKey<FindState>('empFind');

const CLOSED: FindState = { open: false, query: '', caseSensitive: false, wholeWord: false, index: 0, matches: [], decos: DecorationSet.empty };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function search(doc: PMNode, query: string, caseSensitive: boolean, wholeWord: boolean): FindMatch[] {
  if (!query) return [];
  const out: FindMatch[] = [];
  const src = wholeWord ? `(?<![\\p{L}\\p{N}_])${escapeRe(query)}(?![\\p{L}\\p{N}_])` : escapeRe(query);
  let re: RegExp;
  try {
    re = new RegExp(src, caseSensitive ? 'gu' : 'giu');
  } catch {
    return [];
  }
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach((child) => {
      text += child.isText ? (child.text ?? '') : '￼'.repeat(child.nodeSize);
    });
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex++;
        continue;
      }
      out.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      if (out.length > 5000) return false;
    }
    return false;
  });
  return out;
}

function decorate(doc: PMNode, matches: FindMatch[], index: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? 'emp-find-match is-current' : 'emp-find-match' })),
  );
}

function nearestIndex(matches: FindMatch[], pos: number): number {
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}

export function getFind(state: EditorState): FindState {
  return findKey.getState(state) ?? CLOSED;
}

export function setFind(view: EditorView, patch: Meta['set']): void {
  view.dispatch(view.state.tr.setMeta(findKey, { set: patch } satisfies Meta).setMeta('addToHistory', false));
}

function goTo(view: EditorView, index: number): void {
  const s = getFind(view.state);
  const m = s.matches[index];
  if (!m) return;
  const reveal = revealPos(view.state, m.from);
  if (reveal) {
    reveal.setMeta('addToHistory', false);
    view.dispatch(reveal);
  }
  const tr = view.state.tr.setMeta(findKey, { set: { index } } satisfies Meta).setMeta('addToHistory', false);
  tr.setSelection(TextSelection.create(tr.doc, m.from, m.to));
  view.dispatch(tr);
  requestAnimationFrame(() => {
    const el = view.dom.querySelector('.emp-find-match.is-current');
    el?.scrollIntoView({ block: 'center' });
  });
}

export function findStep(view: EditorView, dir: 1 | -1): void {
  const s = getFind(view.state);
  if (!s.matches.length) return;
  const next = (s.index + dir + s.matches.length) % s.matches.length;
  goTo(view, next);
}

export function revealCurrent(view: EditorView): void {
  const s = getFind(view.state);
  if (s.matches.length) goTo(view, Math.min(s.index, s.matches.length - 1));
}

export function replaceCurrent(view: EditorView, replacement: string): void {
  const s = getFind(view.state);
  const m = s.matches[s.index];
  if (!m) return;
  const tr = view.state.tr;
  if (replacement) tr.insertText(replacement, m.from, m.to);
  else tr.delete(m.from, m.to);
  view.dispatch(tr);
  const after = getFind(view.state);
  if (after.matches.length) goTo(view, Math.min(nearestIndex(after.matches, m.from + replacement.length), after.matches.length - 1));
}

export function replaceAll(view: EditorView, replacement: string): number {
  const s = getFind(view.state);
  if (!s.matches.length) return 0;
  const tr = view.state.tr;
  for (const m of [...s.matches].reverse()) {
    if (replacement) tr.insertText(replacement, m.from, m.to);
    else tr.delete(m.from, m.to);
  }
  view.dispatch(tr);
  return s.matches.length;
}

export const FindReplace = Extension.create({
  name: 'empFind',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => CLOSED,
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(findKey) as Meta | undefined;
            if (!meta && !prev.open) return prev;
            if (meta) {
              const next = { ...prev, ...meta.set };
              if (meta.set.open === false) return CLOSED;
              const recompute =
                meta.set.query !== undefined || meta.set.caseSensitive !== undefined || meta.set.wholeWord !== undefined || meta.set.open === true || tr.docChanged;
              const matches = recompute ? search(state.doc, next.query, next.caseSensitive, next.wholeWord) : prev.matches;
              let index = meta.set.index ?? (recompute ? nearestIndex(matches, state.selection.from) : next.index);
              if (index >= matches.length) index = 0;
              return { ...next, matches, index, decos: decorate(state.doc, matches, index) };
            }
            if (tr.docChanged) {
              const matches = search(state.doc, prev.query, prev.caseSensitive, prev.wholeWord);
              const index = Math.min(prev.index, Math.max(0, matches.length - 1));
              return { ...prev, matches, index, decos: decorate(state.doc, matches, index) };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => getFind(state).decos,
        },
      }),
    ];
  },
});
