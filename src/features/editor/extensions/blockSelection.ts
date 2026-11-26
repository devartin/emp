/**
 * Block selection (§7.3): its own plugin state + decorations (accent overlay at .12). Esc selects the current block,
 * Esc again clears; ⇧↑/↓ extends; ⌘A selects block text, then all blocks. While blocks are selected, Delete, ⌘C/X/V,
 * ⌘D, Tab/⇧Tab, ⌘⇧↑/↓, ⌘⌥0–9 and ⌘/ act on the selection, Enter edits the first block and typing replaces it.
 * A click clears it.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { isMac } from '@/lib/platform';
import { isTextContent, TURN_INTO } from '../lib/blockTypes';
import {
  allBlocks,
  currentBlock,
  deleteBlocks,
  duplicateBlocks,
  indent,
  makeContainer,
  moveBlocks,
  outdent,
  topLevelOnly,
  turnInto,
  type BlockInfo,
} from '../lib/blocks';
import { editorContext } from '../lib/context';
import { openOverlay } from '../menus/overlay';

export interface BlockSelState {
  ids: string[];
  anchor: string | null;
  head: string | null;
  decos: DecorationSet;
}

type Meta = { set: { ids: string[]; anchor?: string | null; head?: string | null } } | { clear: true };

export const blockSelectionKey = new PluginKey<BlockSelState>('empBlockSelection');
/** Transactions carrying this meta keep the block selection even though they move the text selection. */
export const KEEP_BLOCK_SEL = 'emp:keepBlockSel';

function buildDecos(state: EditorState, ids: string[]): { ids: string[]; decos: DecorationSet } {
  if (!ids.length) return { ids, decos: DecorationSet.empty };
  const decos: Decoration[] = [];
  const alive: string[] = [];
  const want = new Set(ids);
  for (const b of allBlocks(state.doc)) {
    if (!want.has(b.id)) continue;
    alive.push(b.id);
    decos.push(Decoration.node(b.pos, b.end, { class: 'emp-block-selected' }));
  }
  return { ids: alive, decos: DecorationSet.create(state.doc, decos) };
}

export function selectedBlockIds(state: EditorState): string[] {
  return blockSelectionKey.getState(state)?.ids ?? [];
}

export function selectedBlocks(state: EditorState): BlockInfo[] {
  const ids = selectedBlockIds(state);
  if (!ids.length) return [];
  const want = new Set(ids);
  return topLevelOnly(allBlocks(state.doc).filter((b) => want.has(b.id)));
}

export function setBlockSelection(view: EditorView, ids: string[], anchor?: string | null, head?: string | null): void {
  const meta: Meta = { set: { ids, anchor: anchor ?? ids[0] ?? null, head: head ?? ids[ids.length - 1] ?? null } };
  view.dispatch(view.state.tr.setMeta(blockSelectionKey, meta).setMeta(KEEP_BLOCK_SEL, true));
}

export function clearBlockSelection(view: EditorView): void {
  if (!selectedBlockIds(view.state).length) return;
  view.dispatch(view.state.tr.setMeta(blockSelectionKey, { clear: true } satisfies Meta));
}

/** Visible blocks in the same flow as `id` (top-level flow or a column) for ⇧↑/↓ ranges. */
function flowOf(state: EditorState, id: string) {
  const all = allBlocks(state.doc, { visibleOnly: true });
  const at = all.find((b) => b.id === id);
  if (!at) return all;
  if (!at.inColumn) return all.filter((b) => !b.inColumn);
  // Same column: blocks between the column's bounds.
  const $ = state.doc.resolve(at.pos);
  for (let d = $.depth; d > 0; d--) {
    if ($.node(d).type.name === 'column') {
      const start = $.before(d);
      const end = $.after(d);
      return all.filter((b) => b.pos > start && b.end < end);
    }
  }
  return all;
}

function focusBlock(view: EditorView, info: BlockInfo, atEnd = true) {
  const tr = view.state.tr.setMeta(blockSelectionKey, { clear: true } satisfies Meta);
  if (isTextContent(info.content) || info.content.type.name === 'codeBlock') {
    tr.setSelection(TextSelection.create(tr.doc, atEnd ? info.contentEnd - 1 : info.contentPos + 1));
  } else if (info.content.isAtom) {
    tr.setSelection(NodeSelection.create(tr.doc, info.contentPos));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(info.contentPos + 1)));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function scrollBlockIntoView(view: EditorView, id: string) {
  const el = view.dom.querySelector<HTMLElement>(`.emp-block[data-id="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

const isMod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

function handleKey(editor: Editor, view: EditorView, e: KeyboardEvent): boolean {
  const state = view.state;
  const ps = blockSelectionKey.getState(state);
  if (!ps || !ps.ids.length) return false;
  const blocks = selectedBlocks(state);
  if (!blocks.length) {
    clearBlockSelection(view);
    return false;
  }
  const mod = isMod(e);
  const dispatch = (tr: Parameters<EditorView['dispatch']>[0]) => view.dispatch(tr.setMeta(KEEP_BLOCK_SEL, true));
  const readOnly = !editor.isEditable;

  switch (e.key) {
    case 'Escape':
      clearBlockSelection(view);
      return true;
    case 'Enter':
      if (mod) return false;
      focusBlock(view, blocks[0], true);
      return true;
    case 'ArrowUp':
    case 'ArrowDown': {
      if (mod && e.shiftKey) {
        if (!readOnly) moveBlocks(state, dispatch, e.key === 'ArrowUp' ? -1 : 1, blocks);
        requestAnimationFrame(() => ps.head && scrollBlockIntoView(view, ps.head));
        return true;
      }
      if (mod || e.altKey) return false;
      const headId = ps.head ?? ps.ids[ps.ids.length - 1];
      const flow = flowOf(state, headId);
      const i = flow.findIndex((b) => b.id === headId);
      if (i < 0) return true;
      const j = Math.max(0, Math.min(flow.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)));
      const target = flow[j];
      if (e.shiftKey) {
        const anchorId = ps.anchor ?? headId;
        const a = flow.findIndex((b) => b.id === anchorId);
        const lo = Math.min(a < 0 ? j : a, j);
        const hi = Math.max(a < 0 ? j : a, j);
        setBlockSelection(view, flow.slice(lo, hi + 1).map((b) => b.id), anchorId, target.id);
      } else {
        setBlockSelection(view, [target.id]);
      }
      scrollBlockIntoView(view, target.id);
      return true;
    }
    case 'Backspace':
    case 'Delete':
      if (readOnly) return true;
      deleteBlocks(state, (tr) => view.dispatch(tr.setMeta(blockSelectionKey, { clear: true } satisfies Meta)), blocks);
      return true;
    case 'Tab':
      if (!readOnly) (e.shiftKey ? outdent : indent)(state, dispatch, blocks);
      return true;
    default:
      break;
  }

  if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyD') {
    if (readOnly) return true;
    const res = duplicateBlocks(state, dispatch, blocks);
    if (res) setBlockSelection(view, res.ids);
    return true;
  }
  if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyA') {
    const all = allBlocks(view.state.doc, { visibleOnly: true }).filter((b) => !b.inColumn);
    setBlockSelection(view, all.map((b) => b.id), all[0]?.id, all[all.length - 1]?.id);
    return true;
  }
  if (mod && e.code === 'Slash') {
    const el = view.dom.querySelector<HTMLElement>(`.emp-block[data-id="${CSS.escape(blocks[0].id)}"]`);
    const r = el?.getBoundingClientRect();
    openOverlay({ kind: 'blockMenu', editorId: editor.instanceId, pos: blocks[0].pos, rect: r ? { x: r.left - 28, y: r.top, width: 20, height: 24 } : { x: 0, y: 0, width: 0, height: 0 }, data: { ids: blocks.map((b) => b.id) } });
    return true;
  }
  if (mod && e.altKey && /^Digit[0-9]$/.test(e.code)) {
    if (readOnly) return true;
    const digit = Number(e.code.slice(5));
    const target = TURN_INTO.find((t) => t.shortcut === `mod+alt+${digit}`);
    if (target?.type === '$page') editorContext(editor).hooks.turnIntoPage?.(blocks.map((b) => b.id));
    else if (target) turnInto(state, dispatch, blocks, target);
    return true;
  }
  if (mod || e.altKey || e.ctrlKey || e.metaKey) return false; // ⌘C/X/V, app shortcuts
  if (e.key.length === 1 && !readOnly) {
    // Typing replaces the selection with a new paragraph that starts with the typed character.
    const { schema } = state;
    const first = blocks[0];
    const tr = state.tr.setMeta(blockSelectionKey, { clear: true } satisfies Meta);
    const sorted = [...blocks].sort((a, b) => b.pos - a.pos);
    for (const b of sorted) tr.delete(tr.mapping.map(b.pos), tr.mapping.map(b.end));
    const at = tr.mapping.map(first.pos);
    tr.insert(at, makeContainer(schema, schema.nodes.paragraph.create(null, schema.text(e.key))));
    tr.setSelection(TextSelection.create(tr.doc, at + 3));
    view.dispatch(tr.scrollIntoView());
    return true;
  }
  return true;
}

export const BlockSelection = Extension.create({
  name: 'empBlockSelection',
  priority: 900,
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<BlockSelState>({
        key: blockSelectionKey,
        state: {
          init: () => ({ ids: [], anchor: null, head: null, decos: DecorationSet.empty }),
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(blockSelectionKey) as Meta | undefined;
            if (meta && 'clear' in meta) return { ids: [], anchor: null, head: null, decos: DecorationSet.empty };
            if (meta && 'set' in meta) {
              const { ids, decos } = buildDecos(next, meta.set.ids);
              return { ids, anchor: meta.set.anchor ?? ids[0] ?? null, head: meta.set.head ?? ids[ids.length - 1] ?? null, decos };
            }
            if (!prev.ids.length) return prev;
            if (tr.selectionSet && !tr.getMeta(KEEP_BLOCK_SEL) && !tr.docChanged) return { ids: [], anchor: null, head: null, decos: DecorationSet.empty };
            if (tr.docChanged) {
              const { ids, decos } = buildDecos(next, prev.ids);
              return { ...prev, ids, decos };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => blockSelectionKey.getState(state)?.decos ?? DecorationSet.empty,
          attributes: (state): Record<string, string> => (selectedBlockIds(state).length ? { class: 'has-block-selection' } : {}),
          handleKeyDown(view, e) {
            if (e.isComposing) return false;
            if (selectedBlockIds(view.state).length) return handleKey(editor, view, e);
            if (e.key === 'Escape' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const info = currentBlock(view.state);
              if (!info) return false;
              setBlockSelection(view, [info.id]);
              return true;
            }
            return false;
          },
          handleDOMEvents: {
            mousedown(view, e) {
              if (selectedBlockIds(view.state).length && !(e.target as HTMLElement).closest?.('.emp-block-handle')) clearBlockSelection(view);
              return false;
            },
          },
        },
      }),
    ];
  },
});
