/**
 * Keyboard semantics (§7.3, §8.7 Formatting/Blocks): Enter/Backspace/Delete on nested blocks, Tab/⇧Tab, ⌘↵,
 * ⌘⇧↑/↓, ⌘D, ⌘⌥0–9, ⌘⌥T, ⌘A, ⌘⇧E, ⌘K (link), ⌘⌥H (last colour), ↑/↓ across atom blocks, tables and code.
 */
import { Extension, type Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { api } from '@/backend';
import { navigate } from '@/app/router';
import { ATOM_TYPES, isTextContent, isToggleLike, TURN_INTO } from '../lib/blockTypes';
import {
  blockFromResolved,
  currentBlock,
  deleteBlocks,
  duplicateBlocks,
  emptyParagraphBlock,
  indent,
  infoAt,
  mergeBackward,
  mergeForward,
  moveBlocks,
  nextSibling,
  nextVisual,
  outdent,
  prevVisual,
  splitBlock,
  toggleAll,
  toggleBlockState,
  turnInto,
  turnIntoNeedsConfirm,
  type BlockInfo,
} from '../lib/blocks';
import { editorContext } from '../lib/context';
import { parseInternalHref } from '../lib/links';
import { applyLastColor } from '../lib/lastColor';
import { setToggleCollapsed } from '../nodeviews/dom';
import { openOverlay } from '../menus/overlay';
import { setBlockSelection } from './blockSelection';

function dispatchOf(editor: Editor) {
  return (tr: Parameters<Editor['view']['dispatch']>[0]) => editor.view.dispatch(tr);
}

function cellDepth(editor: Editor): number | null {
  const $f = editor.state.selection.$from;
  for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === 'tableCell') return d;
  return null;
}

function inCode(editor: Editor): boolean {
  return editor.state.selection.$from.parent.type.name === 'codeBlock';
}

function focusInfo(editor: Editor, info: BlockInfo, atEnd: boolean): void {
  const tr = editor.state.tr;
  if (isTextContent(info.content) || info.content.type.name === 'codeBlock') {
    tr.setSelection(TextSelection.create(tr.doc, atEnd ? info.contentEnd - 1 : info.contentPos + 1));
  } else if (ATOM_TYPES.has(info.content.type.name)) {
    tr.setSelection(NodeSelection.create(tr.doc, info.contentPos));
  } else {
    tr.setSelection(Selection.near(tr.doc.resolve(atEnd ? info.contentEnd - 1 : info.contentPos + 1), atEnd ? -1 : 1));
  }
  editor.view.dispatch(tr.scrollIntoView());
}

export function openHref(href: string): void {
  const internal = parseInternalHref(href);
  if (internal) {
    navigate(internal.blockId ? { t: 'page', id: internal.pageId, blockId: internal.blockId } : { t: 'page', id: internal.pageId });
    return;
  }
  void api.open.external({ url: href }).catch(async (e) => {
    const { notify } = await import('@/stores/toasts');
    notify.fromError(e, "Couldn't open that link");
  });
}

function turnIntoShortcut(editor: Editor, digit: number): boolean {
  const target = TURN_INTO.find((t) => t.shortcut === `mod+alt+${digit}`);
  const info = currentBlock(editor.state);
  if (!target || !info || !editor.isEditable) return true;
  if (target.type === '$page') {
    editorContext(editor).hooks.turnIntoPage?.([info.id]);
    return true;
  }
  if (turnIntoNeedsConfirm([info], target) && !window.confirm('Converting to code flattens nested blocks into text lines. Continue?')) return true;
  turnInto(editor.state, dispatchOf(editor), [info], target);
  return true;
}

function exitCode(editor: Editor): boolean {
  const info = currentBlock(editor.state);
  if (!info) return false;
  const { schema } = editor.state;
  const tr = editor.state.tr;
  let next = nextSibling(editor.state.doc, info);
  if (!next || next.content.type.name !== 'paragraph' || next.content.content.size) {
    tr.insert(info.end, emptyParagraphBlock(schema));
    next = infoAt(tr.doc, info.end);
  }
  if (!next) return false;
  tr.setSelection(TextSelection.create(tr.doc, next.contentPos + 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function modEnter(editor: Editor): boolean {
  const { state } = editor;
  const sel = state.selection;
  if (inCode(editor)) return exitCode(editor);
  if (sel instanceof NodeSelection) {
    const n = sel.node;
    if ((n.type.name === 'pageRef' || n.type.name === 'pageLink') && n.attrs.pageId) {
      navigate({ t: 'page', id: String(n.attrs.pageId) });
      return true;
    }
    if (n.type.name === 'mention' && n.attrs.kind === 'page' && n.attrs.pageId) {
      navigate({ t: 'page', id: String(n.attrs.pageId) });
      return true;
    }
  }
  const link = sel.$from.marks().find((m) => m.type.name === 'link') ?? sel.$from.nodeAfter?.marks.find((m) => m.type.name === 'link');
  if (link?.attrs.href) {
    openHref(String(link.attrs.href));
    return true;
  }
  const info = currentBlock(state);
  if (!info) return true;
  if (isToggleLike(info.content)) {
    setToggleCollapsed(editor.view, info.contentPos, !info.content.attrs.collapsed);
    return true;
  }
  toggleBlockState(state, dispatchOf(editor), info);
  return true;
}

function selectAll(editor: Editor): boolean {
  const { state } = editor;
  const sel = state.selection;
  const info = currentBlock(state);
  if (!info) return false;
  const text = isTextContent(info.content) || info.content.type.name === 'codeBlock';
  const cell = cellDepth(editor);
  if (cell != null && sel instanceof TextSelection) {
    const $f = sel.$from;
    const from = $f.start(cell);
    const to = $f.end(cell);
    if (sel.from !== from || sel.to !== to) {
      editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
      return true;
    }
  } else if (text) {
    const from = info.contentPos + 1;
    const to = info.contentEnd - 1;
    if ((sel.from !== from || sel.to !== to) && to > from) {
      editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
      return true;
    }
  }
  const all: string[] = [];
  state.doc.firstChild?.forEach((c) => all.push(String(c.attrs.id)));
  setBlockSelection(editor.view, all);
  return true;
}

function arrowAcross(editor: Editor, dir: 'up' | 'down'): boolean {
  const { state } = editor;
  const sel = state.selection;
  if (sel instanceof NodeSelection && ATOM_TYPES.has(sel.node.type.name)) {
    const info = blockFromResolved(sel.$from);
    if (!info) return false;
    const target = dir === 'up' ? prevVisual(state.doc, info) : nextVisual(state.doc, info);
    if (!target) return true;
    focusInfo(editor, target, dir === 'up');
    return true;
  }
  if (!(sel instanceof TextSelection) || !sel.empty || cellDepth(editor) != null) return false;
  if (!editor.view.endOfTextblock(dir)) return false;
  const info = currentBlock(state);
  if (!info) return false;
  const target = dir === 'up' ? prevVisual(state.doc, info) : nextVisual(state.doc, info);
  if (target && ATOM_TYPES.has(target.content.type.name)) {
    editor.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, target.contentPos)).scrollIntoView());
    return true;
  }
  return false;
}

function tableTab(editor: Editor, back: boolean): boolean {
  const d = cellDepth(editor);
  if (d == null) return false;
  const { state } = editor;
  const $f = state.selection.$from;
  const tableDepth = d - 2;
  const tableStart = $f.before(tableDepth);
  const tableEnd = $f.after(tableDepth);
  const found = back ? Selection.findFrom(state.doc.resolve($f.before(d)), -1, true) : Selection.findFrom(state.doc.resolve($f.after(d)), 1, true);
  if (found && found.from > tableStart && found.to < tableEnd) {
    const $c = found.$from;
    const cell = $c.node($c.depth);
    const tr = state.tr.setSelection(cell.content.size ? TextSelection.create(state.doc, $c.start(), $c.end()) : found);
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  }
  if (back) return true;
  // Tab in the last cell adds a row.
  const table = $f.node(tableDepth);
  const cols = table.lastChild?.childCount ?? 1;
  const { schema } = state;
  const row = schema.nodes.tableRow.create(null, Array.from({ length: cols }, () => schema.nodes.tableCell.create()));
  const at = tableEnd - 1;
  const tr = state.tr.insert(at, row);
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function tableEnter(editor: Editor): boolean {
  const d = cellDepth(editor);
  if (d == null) return false;
  const { state } = editor;
  const $f = state.selection.$from;
  const col = $f.index(d - 1);
  const rowIdx = $f.index(d - 2);
  const table = $f.node(d - 2);
  const tableStart = $f.start(d - 2);
  if (rowIdx < table.childCount - 1) {
    let pos = tableStart;
    for (let r = 0; r <= rowIdx; r++) pos += table.child(r).nodeSize;
    const row = table.child(rowIdx + 1);
    pos += 1;
    for (let c = 0; c < Math.min(col, row.childCount - 1); c++) pos += row.child(c).nodeSize;
    editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)).scrollIntoView());
    return true;
  }
  const info = currentBlock(state);
  if (!info) return true;
  const next = nextVisual(state.doc, info);
  if (next) focusInfo(editor, next, false);
  else exitCode(editor);
  return true;
}

function codeShiftTab(editor: Editor): boolean {
  const { state } = editor;
  const $f = state.selection.$from;
  const text = $f.parent.textContent;
  const lineStart = text.lastIndexOf('\n', $f.parentOffset - 1) + 1;
  const spaces = /^ {1,2}/.exec(text.slice(lineStart))?.[0].length ?? 0;
  if (!spaces) return true;
  const at = $f.start() + lineStart;
  editor.view.dispatch(state.tr.delete(at, at + spaces));
  return true;
}

function inlineEquation(editor: Editor): boolean {
  const { state } = editor;
  if (inCode(editor)) return false;
  const { from, to, empty } = state.selection;
  const latex = empty ? '' : state.doc.textBetween(from, to, ' ');
  const node = state.schema.nodes.mathInline.create({ latex });
  const tr = state.tr.replaceSelectionWith(node);
  const pos = tr.mapping.map(from, -1);
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  editor.view.dispatch(tr);
  if (!latex) {
    requestAnimationFrame(() => {
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
      const r = dom?.getBoundingClientRect();
      if (r) openOverlay({ kind: 'mathInline', editorId: editor.instanceId, pos, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, data: { latex: '' } });
    });
  }
  return true;
}

/** ⌘↵ in a read-only page still follows links and page blocks. */
function modEnterReadOnly(editor: Editor): boolean {
  const sel = editor.state.selection;
  if (sel instanceof NodeSelection && (sel.node.type.name === 'pageRef' || sel.node.type.name === 'pageLink') && sel.node.attrs.pageId) {
    navigate({ t: 'page', id: String(sel.node.attrs.pageId) });
    return true;
  }
  const link = sel.$from.marks().find((m) => m.type.name === 'link');
  if (link?.attrs.href) {
    openHref(String(link.attrs.href));
    return true;
  }
  return false;
}

export function openLinkPopover(editor: Editor): boolean {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (empty || inCode(editor)) return false;
  const start = editor.view.coordsAtPos(from);
  const end = editor.view.coordsAtPos(to);
  const link = state.doc.rangeHasMark(from, to, state.schema.marks.link)
    ? state.selection.$from.marks().find((m) => m.type.name === 'link')?.attrs.href
    : undefined;
  openOverlay({
    kind: 'link',
    editorId: editor.instanceId,
    pos: from,
    to,
    rect: { x: Math.min(start.left, end.left), y: start.top, width: Math.abs(end.right - start.left), height: start.bottom - start.top },
    data: { href: link ?? '' },
  });
  return true;
}

/** Printable keys typed in the editor never reach app-level single-key shortcuts (e.g. `?` → cheat sheet). */
const ContainTyping = new Plugin({
  key: new PluginKey('empContainTyping'),
  props: {
    /** ⌘/Ctrl-click follows a link (a plain click does in read-only pages). */
    handleClick(view, pos, event) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod && view.editable) return false;
      const $pos = view.state.doc.resolve(pos);
      const link = $pos.marks().find((m) => m.type.name === 'link') ?? $pos.nodeAfter?.marks.find((m) => m.type.name === 'link');
      if (!link?.attrs.href) return false;
      event.preventDefault();
      openHref(String(link.attrs.href));
      return true;
    },
    handleDOMEvents: {
      keydown(_view, e) {
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
        return false;
      },
    },
  },
});

export const BlockKeymap = Extension.create({
  name: 'empKeymap',
  priority: 800,
  addProseMirrorPlugins() {
    return [ContainTyping];
  },
  addKeyboardShortcuts() {
    const e = this.editor;
    const shortcuts: Record<string, () => boolean> = {
      Enter: () => {
        if (inCode(e)) return e.commands.insertContent('\n');
        if (tableEnter(e)) return true;
        const sel = e.state.selection;
        if (sel instanceof NodeSelection && ATOM_TYPES.has(sel.node.type.name)) {
          const n = sel.node;
          if ((n.type.name === 'pageRef' || n.type.name === 'pageLink') && n.attrs.pageId) {
            navigate({ t: 'page', id: String(n.attrs.pageId) });
            return true;
          }
          const info = blockFromResolved(sel.$from);
          if (!info) return false;
          const tr = e.state.tr.insert(info.end, emptyParagraphBlock(e.state.schema));
          tr.setSelection(TextSelection.create(tr.doc, info.end + 2));
          e.view.dispatch(tr.scrollIntoView());
          return true;
        }
        return splitBlock(e.state, dispatchOf(e));
      },
      'Shift-Enter': () => {
        if (inCode(e)) return e.commands.insertContent('\n');
        return e.commands.setHardBreak();
      },
      Backspace: () => {
        if (e.commands.undoInputRule()) return true;
        const sel = e.state.selection;
        if (sel instanceof NodeSelection && ATOM_TYPES.has(sel.node.type.name)) {
          const info = blockFromResolved(sel.$from);
          if (!info) return false;
          const prev = prevVisual(e.state.doc, info);
          deleteBlocks(e.state, dispatchOf(e), [info]);
          if (prev) {
            const p = infoAt(e.state.doc, prev.pos);
            if (p) focusInfo(e, p, true);
          }
          return true;
        }
        if (cellDepth(e) != null && sel.empty && sel.$from.parentOffset === 0) return true;
        return mergeBackward(e.state, dispatchOf(e));
      },
      Delete: () => {
        const sel = e.state.selection;
        if (sel instanceof NodeSelection && ATOM_TYPES.has(sel.node.type.name)) {
          const info = blockFromResolved(sel.$from);
          if (!info) return false;
          deleteBlocks(e.state, dispatchOf(e), [info]);
          return true;
        }
        if (cellDepth(e) != null && sel.empty && sel.$from.parentOffset === sel.$from.parent.content.size) return true;
        return mergeForward(e.state, dispatchOf(e));
      },
      Tab: () => {
        if (inCode(e)) return e.commands.insertContent('  ');
        if (tableTab(e, false)) return true;
        if (!e.isEditable) return true;
        return indent(e.state, dispatchOf(e)) || true;
      },
      'Shift-Tab': () => {
        if (inCode(e)) return codeShiftTab(e);
        if (tableTab(e, true)) return true;
        if (!e.isEditable) return true;
        return outdent(e.state, dispatchOf(e)) || true;
      },
      'Mod-Enter': () => modEnter(e),
      'Mod-Shift-ArrowUp': () => moveBlocks(e.state, dispatchOf(e), -1),
      'Mod-Shift-ArrowDown': () => moveBlocks(e.state, dispatchOf(e), 1),
      'Mod-d': () => {
        duplicateBlocks(e.state, dispatchOf(e));
        return true;
      },
      'Mod-Alt-t': () => {
        toggleAll(e.state, dispatchOf(e));
        return true;
      },
      'Mod-a': () => selectAll(e),
      ArrowUp: () => arrowAcross(e, 'up'),
      ArrowDown: () => arrowAcross(e, 'down'),
      'Mod-Shift-e': () => inlineEquation(e),
      'Mod-k': () => openLinkPopover(e),
      'Mod-Alt-h': () => applyLastColor(e),
      'Mod-z': () => e.commands.undoInputRule() || e.commands.undo(),
      'Mod-Shift-z': () => e.commands.redo(),
      'Mod-y': () => e.commands.redo(),
      'Mod-f': () => {
        const h = editorContext(e).hooks.find;
        if (!h) return false;
        h(false);
        return true;
      },
      'Mod-Alt-f': () => {
        const h = editorContext(e).hooks.find;
        if (!h) return false;
        h(true);
        return true;
      },
    };
    for (let d = 0; d <= 9; d++) shortcuts[`Mod-Alt-${d}`] = () => turnIntoShortcut(e, d);
    // Read-only (locked pages, trash): only navigation-type keys run.
    const SAFE = new Set(['Mod-a', 'ArrowUp', 'ArrowDown', 'Mod-f', 'Mod-Alt-f']);
    for (const k of Object.keys(shortcuts)) {
      if (SAFE.has(k)) continue;
      const run = shortcuts[k];
      shortcuts[k] = () => {
        if (!e.isEditable) return k === 'Mod-Enter' ? modEnterReadOnly(e) : k === 'Tab' || k === 'Shift-Tab';
        return run();
      };
    }
    return shortcuts;
  },
});
