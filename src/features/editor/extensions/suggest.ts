/**
 * Trigger-character suggestions: `/` (slash menu, §7.5), `@` (mentions), `[[` (page link picker) and `:` + 2 characters
 * (emoji). Triggers only at a line start or after whitespace, never in code / inline code / maths, never during IME
 * composition (ProseMirror doesn't call handleTextInput while composing). Esc closes and leaves the typed text.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

export type SuggestKind = 'slash' | 'mention' | 'pagelink' | 'emoji';

export interface SuggestState {
  active: boolean;
  kind: SuggestKind | null;
  /** Position of the trigger's first character. */
  from: number;
  /** Position of the caret (end of the query). */
  to: number;
  triggerLen: number;
  query: string;
}

type Meta = { open: { kind: SuggestKind; from: number; triggerLen: number } } | { close: true };

const IDLE: SuggestState = { active: false, kind: null, from: 0, to: 0, triggerLen: 0, query: '' };
const MAX_QUERY = 80;

export const suggestKey = new PluginKey<SuggestState>('empSuggest');

type KeyHandler = (e: KeyboardEvent) => boolean;
const keyHandlers = new WeakMap<EditorView, KeyHandler>();
const listeners = new WeakMap<EditorView, Set<() => void>>();

export function registerSuggestKeys(view: EditorView, h: KeyHandler | null): void {
  if (h) keyHandlers.set(view, h);
  else keyHandlers.delete(view);
}

export function subscribeSuggest(view: EditorView, fn: () => void): () => void {
  let set = listeners.get(view);
  if (!set) listeners.set(view, (set = new Set()));
  set.add(fn);
  return () => set?.delete(fn);
}

export function getSuggest(state: EditorState): SuggestState {
  return suggestKey.getState(state) ?? IDLE;
}

export function closeSuggest(view: EditorView): void {
  if (!getSuggest(view.state).active) return;
  view.dispatch(view.state.tr.setMeta(suggestKey, { close: true } satisfies Meta));
}

/** Delete the trigger + query (before running the chosen item). Returns the position where it started. */
export function consumeSuggest(view: EditorView): number {
  const s = getSuggest(view.state);
  if (!s.active) return view.state.selection.from;
  const tr = view.state.tr.delete(s.from, s.to).setMeta(suggestKey, { close: true } satisfies Meta);
  view.dispatch(tr);
  return s.from;
}

function inCodeContext(state: EditorState, pos: number): boolean {
  const $p = state.doc.resolve(pos);
  if ($p.parent.type.spec.code) return true;
  return ($p.marks() ?? []).some((m) => m.type.spec.code);
}

export const Suggest = Extension.create({
  name: 'empSuggest',
  priority: 1100,
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<SuggestState>({
        key: suggestKey,
        state: {
          init: () => IDLE,
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(suggestKey) as Meta | undefined;
            if (meta && 'close' in meta) return IDLE;
            let base = prev;
            if (meta && 'open' in meta) base = { active: true, kind: meta.open.kind, from: meta.open.from, to: meta.open.from, triggerLen: meta.open.triggerLen, query: '' };
            else if (!prev.active) return prev;
            else base = { ...prev, from: tr.mapping.map(prev.from) };
            const sel = state.selection;
            if (!sel.empty) return IDLE;
            const head = sel.from;
            if (head < base.from + base.triggerLen) return IDLE;
            const $f = state.doc.resolve(base.from);
            const $h = state.doc.resolve(head);
            if ($f.parent !== $h.parent) return IDLE;
            const text = state.doc.textBetween(base.from, head, '\n', '￼');
            const trigger = base.kind === 'pagelink' ? '[[' : base.kind === 'slash' ? '/' : base.kind === 'mention' ? '@' : ':';
            if (!text.startsWith(trigger)) return IDLE;
            const query = text.slice(base.triggerLen);
            if (query.length > MAX_QUERY || query.includes('￼') || query.includes('\n')) return IDLE;
            if (base.kind === 'slash' && query.startsWith(' ')) return IDLE;
            if (base.kind === 'emoji' && /\s/.test(query)) return IDLE;
            if (base.kind === 'mention' && /\s\s/.test(query)) return IDLE;
            if (base.kind === 'pagelink' && query.includes(']]')) return IDLE;
            return { ...base, to: head, query };
          },
        },
        props: {
          handleTextInput(view, from, to, text) {
            if (!editor.isEditable) return false;
            const state = view.state;
            if (getSuggest(state).active) return false;
            if (inCodeContext(state, from)) return false;
            const $from = state.doc.resolve(from);
            if (!$from.parent.isTextblock) return false;
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
            let kind: SuggestKind | null = null;
            let start = from;
            let triggerLen = 1;
            if (text === '/' && (before === '' || /\s$/.test(before))) kind = 'slash';
            else if (text === '@' && (before === '' || /[\s(]$/.test(before))) kind = 'mention';
            else if (text === '[' && before.endsWith('[')) {
              kind = 'pagelink';
              start = from - 1;
              triggerLen = 2;
            } else if (/^[\p{L}\p{N}_+-]$/u.test(text)) {
              const m = /(?:^|\s):([\p{L}\p{N}_+-])$/u.exec(before);
              if (m) {
                kind = 'emoji';
                start = from - 2;
              }
            }
            if (!kind) return false;
            const tr = state.tr.insertText(text, from, to).setMeta(suggestKey, { open: { kind, from: start, triggerLen } } satisfies Meta);
            view.dispatch(tr);
            return true;
          },
          handleKeyDown(view, e) {
            const s = getSuggest(view.state);
            if (!s.active || e.isComposing) return false;
            const h = keyHandlers.get(view);
            if (h && h(e)) return true;
            if (e.key === 'Escape') {
              closeSuggest(view);
              return true;
            }
            return false;
          },
          decorations(state) {
            const s = getSuggest(state);
            if (!s.active || s.to <= s.from) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [Decoration.inline(s.from, s.to, { class: 'emp-suggest-query', nodeName: 'span' })]);
          },
        },
        view() {
          return {
            update(view, prev) {
              const a = getSuggest(view.state);
              const b = getSuggest(prev);
              if (a === b) return;
              listeners.get(view)?.forEach((fn) => fn());
            },
          };
        },
      }),
    ];
  },
});
