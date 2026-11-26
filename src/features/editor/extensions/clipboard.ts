/**
 * Clipboard and drops (§7.7). Copy writes `application/x-emp-blocks` ({v:1, vaultId, blocks}), `text/html` (semantic,
 * plus the same JSON in `data-emp`) and `text/plain` (markdown). Paste tries internal JSON → sanitised HTML →
 * markdown → plain text; images and files go to the asset store; a lone URL becomes a link (internal links offer
 * "Paste as mention"); TSV/CSV grids offer table / database / spreadsheet. ⌘⇧V pastes plain text.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { TipTapNode } from '@/backend/types';
import { useVault } from '@/stores/vault';
import { notify } from '@/stores/toasts';
import { CONTAINER } from '../lib/blockTypes';
import { cloneWithNewIds, deleteBlocks, isEmptyParagraph, currentBlock } from '../lib/blocks';
import { editorContext } from '../lib/context';
import { blocksToHtml, extractEmpPayload, normalisePastedHtml } from '../lib/html';
import { isAllowedHref, normaliseHref, parseInternalHref } from '../lib/links';
import { blocksToMarkdown, gridToTable, looksLikeMarkdown, markdownToBlocks, parseGrid } from '../lib/markdown';
import { uploadBlob } from '../lib/assets';
import { openOverlay } from '../menus/overlay';
import { normaliseDocJson } from '../lib/normalize';
import { blockSelectionKey, selectedBlocks } from './blockSelection';

export const EMP_MIME = 'application/x-emp-blocks';

interface Payload {
  v: 1;
  vaultId: string | null;
  blocks: TipTapNode[];
  openStart: number;
  openEnd: number;
}

const vaultId = () => useVault.getState().status?.vaultId ?? null;

let plainNext = false;
/** Called by the ⌘⇧V keydown so the following paste is treated as plain text. */
export function markPlainPaste(): void {
  plainNext = true;
  setTimeout(() => (plainNext = false), 500);
}

/** Containers inside a slice/fragment (the outermost ones). */
function containersIn(frag: Fragment): PMNode[] {
  const out: PMNode[] = [];
  const walk = (f: Fragment) =>
    f.forEach((n) => {
      if (n.type.name === CONTAINER) out.push(n);
      else if (!n.isTextblock && !n.isAtom) walk(n.content);
    });
  walk(frag);
  return out;
}

function sliceOfBlocks(blocks: PMNode[]): Slice {
  return new Slice(Fragment.from(blocks), 0, 0);
}

export function currentCopySlice(state: EditorState): { slice: Slice; blocks: PMNode[]; whole: boolean } | null {
  const sel = selectedBlocks(state);
  if (sel.length) return { slice: sliceOfBlocks(sel.map((b) => b.node)), blocks: sel.map((b) => b.node), whole: true };
  if (state.selection.empty) return null;
  const slice = state.selection.content();
  return { slice, blocks: containersIn(slice.content), whole: false };
}

export function writeClipboard(data: DataTransfer, state: EditorState): boolean {
  const c = currentCopySlice(state);
  if (!c) return false;
  const json = c.slice.toJSON() ?? { content: [] };
  const payload: Payload = { v: 1, vaultId: vaultId(), blocks: (json.content ?? []) as TipTapNode[], openStart: json.openStart ?? 0, openEnd: json.openEnd ?? 0 };
  const blocksJson = c.blocks.map((b) => b.toJSON() as TipTapNode);
  data.clearData();
  data.setData(EMP_MIME, JSON.stringify(payload));
  data.setData('text/html', blocksToHtml(blocksJson, payload));
  data.setData('text/plain', c.whole || c.blocks.length > 1 ? blocksToMarkdown(blocksJson) : state.doc.textBetween(state.selection.from, state.selection.to, '\n', ' '));
  return true;
}

/** Copy the given blocks as markdown text (block menu → Copy as Markdown). */
export async function copyAsMarkdown(blocks: PMNode[]): Promise<void> {
  const md = blocksToMarkdown(blocks.map((b) => b.toJSON() as TipTapNode));
  await navigator.clipboard.writeText(md);
  notify.success('Copied as Markdown');
}

// ───────────────────────────────────────────────────────────────────────────── paste

function regenerateSlice(slice: Slice): Slice {
  let frag = Fragment.empty;
  slice.content.forEach((n) => (frag = frag.addToEnd(regenerateTree(n))));
  return new Slice(frag, slice.openStart, slice.openEnd);
}

function regenerateTree(n: PMNode): PMNode {
  if (n.type.name === CONTAINER) return cloneWithNewIds(n);
  if (n.isText || n.isLeaf) return n;
  let frag = Fragment.empty;
  n.content.forEach((c) => (frag = frag.addToEnd(regenerateTree(c))));
  return n.copy(frag);
}

/** Assets from another vault can't be resolved: replace them with a note (§7.7). */
function dropForeignAssets(nodes: TipTapNode[]): TipTapNode[] {
  const fix = (n: TipTapNode): TipTapNode => {
    if (n.type === 'image' || n.type === 'file') {
      return { type: 'paragraph', content: [{ type: 'text', text: n.type === 'image' ? '[Image from another vault]' : '[File from another vault]', marks: [{ type: 'italic' }] }] };
    }
    if (n.type === 'callout' && (n.attrs?.icon as { t?: string } | undefined)?.t === 'asset') return { ...n, attrs: { ...n.attrs, icon: { t: 'lucide', v: 'lightbulb' } } };
    return n.content ? { ...n, content: n.content.map(fix) } : n;
  };
  return nodes.map(fix);
}

function payloadToSlice(schema: Schema, p: Payload): Slice | null {
  try {
    const blocks = p.vaultId && p.vaultId === vaultId() ? p.blocks : dropForeignAssets(p.blocks);
    return regenerateSlice(Slice.fromJSON(schema, { content: blocks, openStart: p.openStart, openEnd: p.openEnd }));
  } catch {
    return null;
  }
}

function blocksSlice(schema: Schema, blocks: TipTapNode[]): Slice | null {
  if (!blocks.length) return null;
  try {
    const doc = normaliseDocJson({ type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'blockGroup', content: blocks }] });
    const nodes = (doc.content[0].content ?? []).map((b) => schema.nodeFromJSON(b));
    return new Slice(Fragment.from(nodes), 0, 0);
  } catch {
    return null;
  }
}

/** Insert whole blocks: replaces an empty current block, otherwise goes after it. */
export function insertBlocksSlice(view: EditorView, slice: Slice): void {
  const state = view.state;
  const blocks = selectedBlocks(state);
  let tr = state.tr;
  if (blocks.length) {
    deleteBlocks(state, (t) => (tr = t), blocks);
    tr.setMeta(blockSelectionKey, { clear: true });
  }
  const st = state.apply(tr);
  const info = currentBlock(st);
  const onlyInline = slice.content.childCount === 1 && slice.openStart > 0;
  if (onlyInline || (!info && !slice.content.firstChild)) {
    view.dispatch(tr.replaceSelection(slice).scrollIntoView());
    return;
  }
  const allContainers = slice.content.firstChild?.type.name === CONTAINER;
  if (!info || !allContainers) {
    view.dispatch(tr.replaceSelection(slice).scrollIntoView());
    return;
  }
  // Text block with text: let ProseMirror merge the first/last blocks into the surrounding text.
  if (!isEmptyParagraph(info) && st.selection.$from.parent.isTextblock && st.selection.$from.parent.content.size) {
    view.dispatch(tr.replaceSelection(slice).scrollIntoView());
    return;
  }
  const at = isEmptyParagraph(info) ? info.pos : info.end;
  if (isEmptyParagraph(info) && !info.group) tr.replaceWith(tr.mapping.map(info.pos), tr.mapping.map(info.end), slice.content);
  else tr.insert(tr.mapping.map(at), slice.content);
  const end = tr.mapping.map(at) + slice.content.size;
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(end - 2, tr.doc.content.size))), -1));
  } catch {
    /* keep */
  }
  view.dispatch(tr.scrollIntoView());
}

function insertImageFiles(editor: Editor, files: File[], at?: number): void {
  const view = editor.view;
  const { schema } = view.state;
  const ws = editorContext(editor).workspaceId;
  const images = files.filter((f) => /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/.test(f.type));
  const others = files.filter((f) => !images.includes(f));
  const nodes: PMNode[] = images.map((f) =>
    schema.nodes[CONTAINER].create(null, schema.nodes.image.create({ assetId: null, width: null, align: 'center', caption: '', pendingUrl: URL.createObjectURL(f) })),
  );
  if (nodes.length) {
    if (at != null) {
      const $at = view.state.doc.resolve(at);
      const info = currentBlock(view.state.apply(view.state.tr.setSelection(TextSelection.near($at))));
      const pos = info ? info.end : view.state.doc.content.size - 1;
      view.dispatch(view.state.tr.insert(pos, Fragment.from(nodes)));
    } else insertBlocksSlice(view, sliceOfBlocks(nodes));
  }
  for (const f of others) {
    const toastId = notify.info(`Uploading ${f.name}…`);
    void uploadBlob(ws, f, f.name)
      .then((asset) => {
        if (toastId) notify.dismiss(toastId);
        const node = schema.nodes[CONTAINER].create(null, schema.nodes.file.create({ assetId: asset.id }));
        insertBlocksSlice(editor.view, sliceOfBlocks([node]));
      })
      .catch((e) => {
        if (toastId) notify.dismiss(toastId);
        notify.fromError(e, `Couldn't upload ${f.name}`);
      });
  }
}

function pasteUrl(editor: Editor, url: string): boolean {
  const view = editor.view;
  const { state } = view;
  const href = normaliseHref(url);
  if (!href) return false;
  const linkMark = state.schema.marks.link.create({ href });
  const { from, to, empty } = state.selection;
  if (!empty) {
    view.dispatch(state.tr.addMark(from, to, linkMark));
    return true;
  }
  const label = url.trim();
  const tr = state.tr.replaceSelectionWith(state.schema.text(label, [linkMark]), false);
  view.dispatch(tr);
  const internal = parseInternalHref(href);
  if (internal) {
    requestAnimationFrame(() => {
      const c = view.coordsAtPos(from);
      openOverlay({ kind: 'pastePrompt', editorId: editor.instanceId, pos: from, to: from + label.length, rect: { x: c.left, y: c.bottom + 4, width: 0, height: 0 }, data: { mode: 'mention', pageId: internal.pageId } });
    });
  }
  return true;
}

function pasteGrid(editor: Editor, rows: string[][]): void {
  const view = editor.view;
  const slice = blocksSlice(view.state.schema, [gridToTable(rows)]);
  if (!slice) return;
  const before = view.state.selection.from;
  insertBlocksSlice(view, slice);
  requestAnimationFrame(() => {
    const c = view.coordsAtPos(Math.min(before, view.state.doc.content.size));
    openOverlay({ kind: 'pastePrompt', editorId: editor.instanceId, pos: before, rect: { x: c.left, y: c.top - 40, width: 0, height: 0 }, data: { mode: 'grid', rows } });
  });
}

export const Clipboard = Extension.create({
  name: 'empClipboard',
  priority: 950,
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-v': () => {
        markPlainPaste();
        return false;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('empClipboard'),
        props: {
          transformPastedHTML: (html) => normalisePastedHtml(html),
          transformPasted: (slice) => regenerateSlice(slice),
          clipboardTextSerializer: (slice) => {
            const blocks = containersIn(slice.content).map((b) => b.toJSON() as TipTapNode);
            return blocks.length > 1 ? blocksToMarkdown(blocks) : slice.content.textBetween(0, slice.content.size, '\n', ' ');
          },
          handleDOMEvents: {
            copy(view, e) {
              if (!e.clipboardData || !writeClipboard(e.clipboardData, view.state)) return false;
              e.preventDefault();
              return true;
            },
            cut(view, e) {
              if (!e.clipboardData || !editor.isEditable || !writeClipboard(e.clipboardData, view.state)) return false;
              e.preventDefault();
              const blocks = selectedBlocks(view.state);
              if (blocks.length) deleteBlocks(view.state, (tr) => view.dispatch(tr.setMeta(blockSelectionKey, { clear: true })), blocks);
              else view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
              return true;
            },
          },
          handlePaste(view, event) {
            if (!editor.isEditable) return true;
            const data = event.clipboardData;
            if (!data) return false;
            const plain = plainNext;
            plainNext = false;
            const inCode = view.state.selection.$from.parent.type.spec.code;
            const text = data.getData('text/plain');
            if (inCode) {
              if (!text) return false;
              view.dispatch(view.state.tr.insertText(text.replace(/\r\n?/g, '\n')).scrollIntoView());
              return true;
            }
            if (plain) {
              if (!text.includes('\n')) view.dispatch(view.state.tr.insertText(text).scrollIntoView());
              else {
                const s = blocksSlice(view.state.schema, text.split(/\r?\n/).map((l) => ({ type: 'blockContainer', content: [l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' }] })));
                if (s) insertBlocksSlice(view, s);
              }
              return true;
            }
            // 1. Internal JSON (custom type, or embedded in HTML for WebKitGTK).
            const raw = data.getData(EMP_MIME);
            let payload: Payload | null = null;
            if (raw) {
              try {
                payload = JSON.parse(raw) as Payload;
              } catch {
                payload = null;
              }
            }
            const html = data.getData('text/html');
            if (!payload && html) payload = extractEmpPayload(html) as Payload | null;
            if (payload && payload.v === 1 && Array.isArray(payload.blocks)) {
              const slice = payloadToSlice(view.state.schema, payload);
              if (slice) {
                if (slice.openStart === 0) insertBlocksSlice(view, slice);
                else view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
                return true;
              }
            }
            // Files and images.
            const files = Array.from(data.files ?? []);
            if (files.length && !html) {
              insertImageFiles(editor, files);
              return true;
            }
            // Grids from Excel / Sheets / TSV on an empty line.
            const info = currentBlock(view.state);
            const emptyLine = isEmptyParagraph(info);
            if (text && emptyLine) {
              const grid = parseGrid(text);
              if (grid && (!html || /<table/i.test(html))) {
                pasteGrid(editor, grid);
                return true;
              }
            }
            // A lone URL → link.
            const trimmed = text.trim();
            if (trimmed && !/\s/.test(trimmed) && (isAllowedHref(trimmed) || /^www\./i.test(trimmed)) && (!html || /^<a[^>]*>[^<]*<\/a>$/i.test(html.replace(/<\/?(meta|span|html|body|head)[^>]*>/gi, '').trim()) || !/<(p|div|h\d|li|table)/i.test(html))) {
              if (pasteUrl(editor, trimmed)) return true;
            }
            // HTML → let ProseMirror parse the sanitised HTML (transformPastedHTML) through the schema.
            if (html) return false;
            // Markdown.
            if (text && looksLikeMarkdown(text)) {
              const slice = blocksSlice(view.state.schema, markdownToBlocks(text));
              if (slice) {
                insertBlocksSlice(view, slice);
                return true;
              }
            }
            // Plain text: multiple lines become paragraphs.
            if (text && text.includes('\n')) {
              const s = blocksSlice(view.state.schema, text.replace(/\n+$/, '').split(/\r?\n/).map((l) => ({ type: 'blockContainer', content: [l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' }] })));
              if (s) {
                insertBlocksSlice(view, s);
                return true;
              }
            }
            return false;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved || !editor.isEditable) return false;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!files.length) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            insertImageFiles(editor, files, at);
            return true;
          },
        },
      }),
    ];
  },
});

export { insertImageFiles };
