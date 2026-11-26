/**
 * Editor actions shared by the slash menu, block menu, bubble toolbar and palette: block creation (text types, atoms,
 * tables, columns, sub-pages, databases, spreadsheets), mentions, move-to-page.
 */
import type { Editor } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { api } from '@/backend';
import type { DateValue, Id, Layout, TipTapDoc, TipTapNode } from '@/backend/types';
import { navigate } from '@/app/router';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { isTextContent, type TurnIntoTarget } from './blockTypes';
import {
  cloneWithNewIds,
  currentBlock,
  deleteBlocks,
  insertBlock,
  isEmptyParagraph,
  makeContainer,
  targetAttrs,
  turnInto,
  type BlockInfo,
} from './blocks';
import { editorContext } from './context';
import { rememberPage } from './pageInfo';
import { normaliseDocJson } from './normalize';

const dispatchOf = (editor: Editor) => (tr: Parameters<Editor['view']['dispatch']>[0]) => editor.view.dispatch(tr);

/** Text-type targets convert the current text block; otherwise a new block is inserted below. */
export function applyTextType(editor: Editor, t: TurnIntoTarget): void {
  const info = currentBlock(editor.state);
  const type = editor.schema.nodes[t.type];
  if (!type) return;
  if (info && (isTextContent(info.content) || info.content.type.name === 'codeBlock')) {
    turnInto(editor.state, dispatchOf(editor), [info], t);
    editor.view.focus();
    return;
  }
  const node = type.create(targetAttrs(t, null));
  insertBlock(editor.state, dispatchOf(editor), node, { focus: 'inside' });
  editor.view.focus();
}

export function insertAtom(editor: Editor, name: string, attrs: Record<string, unknown> | null = null, focus: 'node' | 'after' = 'node'): number | null {
  const type = editor.schema.nodes[name];
  if (!type) return null;
  const pos = insertBlock(editor.state, dispatchOf(editor), type.create(attrs), { replaceEmpty: true, focus });
  editor.view.focus();
  return pos;
}

export function insertTable(editor: Editor, rows = 3, cols = 3): void {
  const { schema } = editor;
  const table = schema.nodes.table.create(
    { headerRow: true, headerCol: false, colWidths: Array.from({ length: cols }, () => 160), cellColors: {} },
    Array.from({ length: rows }, () => schema.nodes.tableRow.create(null, Array.from({ length: cols }, () => schema.nodes.tableCell.create()))),
  );
  insertBlock(editor.state, dispatchOf(editor), table, { replaceEmpty: true, focus: 'inside' });
  editor.view.focus();
}

export function insertColumns(editor: Editor, n: number): void {
  const { schema } = editor;
  const count = Math.max(2, Math.min(5, n));
  const cols = Array.from({ length: count }, () =>
    schema.nodes.column.create(null, schema.nodes.blockGroup.create(null, makeContainer(schema, schema.nodes.paragraph.create()))),
  );
  const list = schema.nodes.columnList.create({ widths: Array.from({ length: count }, () => Math.round((1 / count) * 1000) / 1000) }, cols);
  const pos = insertBlock(editor.state, dispatchOf(editor), list, { replaceEmpty: true, focus: 'node' });
  if (pos != null) {
    // Caret into the first column.
    const $p = editor.state.doc.resolve(pos + 1);
    const sel = TextSelection.near(editor.state.doc.resolve($p.pos + 4));
    editor.view.dispatch(editor.state.tr.setSelection(sel));
  }
  editor.view.focus();
}

function newPageParent(editor: Editor): Id | null {
  return editorContext(editor).parentPageId;
}

/** "Page": create a sub-page, leave a `pageRef` block, open it. */
export async function createSubPage(editor: Editor, opts: { title?: string; open?: boolean; link?: 'ref' | 'mention' | 'pageLink' } = {}): Promise<Id | null> {
  try {
    const meta = await useTree.getState().createPage({ parentId: newPageParent(editor), title: opts.title ?? '' });
    rememberPage(meta);
    const how = opts.link ?? 'ref';
    if (how === 'mention') insertPageMention(editor, meta.id);
    else insertAtom(editor, how === 'pageLink' ? 'pageLink' : 'pageRef', { pageId: meta.id }, 'after');
    if (opts.open !== false) navigate({ t: 'page', id: meta.id });
    return meta.id;
  } catch (e) {
    notify.fromError(e, "Couldn't create the page");
    return null;
  }
}

export function insertPageMention(editor: Editor, pageId: Id): void {
  const node = editor.schema.nodes.mention.create({ kind: 'page', pageId, date: null, reminderId: null });
  editor.chain().focus().insertContent([node.toJSON(), { type: 'text', text: ' ' }]).run();
}

export function insertDateMention(editor: Editor, date: DateValue): void {
  const node = editor.schema.nodes.mention.create({ kind: 'date', pageId: null, date, reminderId: null });
  editor.chain().focus().insertContent([node.toJSON(), { type: 'text', text: ' ' }]).run();
}

/** Inline / full-page databases (slash "Table view" … "Database full page"). */
export async function insertDatabase(editor: Editor, layout: Layout, opts: { fullPage?: boolean } = {}): Promise<void> {
  const ctx = editorContext(editor);
  try {
    const res = await api.db.create({ workspaceId: ctx.workspaceId, parentId: ctx.parentPageId, title: '', inline: !opts.fullPage });
    useTree.getState().upsert([res.page]);
    rememberPage(res.page);
    if (opts.fullPage) {
      insertAtom(editor, 'pageRef', { pageId: res.page.id }, 'after');
      navigate({ t: 'page', id: res.page.id });
      return;
    }
    let viewId: Id | null = res.schema.views[0]?.id ?? null;
    if (layout !== 'table') {
      const name = layout[0].toUpperCase() + layout.slice(1);
      if (viewId) {
        const v = await api.db.viewUpdate({ id: viewId, patch: { layout, name } }).catch(() => null);
        viewId = v?.id ?? viewId;
      } else {
        const v = await api.db.viewCreate({ databaseId: res.schema.database.id, name, layout });
        viewId = v.id;
      }
    }
    insertAtom(editor, 'databaseView', { databaseId: res.schema.database.id, viewId, linked: false, height: null }, 'after');
  } catch (e) {
    notify.fromError(e, "Couldn't create the database");
  }
}

export function insertLinkedDatabase(editor: Editor, databaseId: Id, viewId: Id | null = null): void {
  insertAtom(editor, 'databaseView', { databaseId, viewId, linked: true, height: null }, 'after');
}

export async function insertSpreadsheet(editor: Editor): Promise<void> {
  const ctx = editorContext(editor);
  try {
    const res = await api.sheet.workbookCreate({ workspaceId: ctx.workspaceId, parentId: ctx.parentPageId, title: 'Untitled spreadsheet' });
    useTree.getState().upsert([res.page]);
    rememberPage(res.page);
    insertAtom(editor, 'sheetEmbed', { workbookId: res.page.id, sheetId: res.sheets[0]?.id ?? null, range: '' }, 'after');
  } catch (e) {
    notify.fromError(e, "Couldn't create the spreadsheet");
  }
}

/** Move blocks to the end of another page (block menu "Move to…"). */
export async function moveBlocksToPage(editor: Editor, blocks: BlockInfo[], targetId: Id): Promise<void> {
  if (!blocks.length) return;
  const json = blocks.map((b) => cloneWithNewIds(b.node).toJSON() as TipTapNode);
  try {
    const target = await api.page.get({ id: targetId });
    const doc = normaliseDocJson(target.doc);
    const group = doc.content[0];
    const existing = group.content ?? [];
    const onlyEmpty = existing.length === 1 && existing[0].content?.[0]?.type === 'paragraph' && !existing[0].content?.[0]?.content?.length;
    group.content = [...(onlyEmpty ? [] : existing), ...json];
    await api.page.saveDoc({ ownerId: targetId, ownerKind: 'page', doc: doc as TipTapDoc, baseRev: target.docRev });
    deleteBlocks(editor.state, dispatchOf(editor), blocks);
    const title = target.meta.title || 'Untitled';
    notify.success(`Moved to ${title}`, { action: { label: 'Open', onClick: () => navigate({ t: 'page', id: targetId }) } });
  } catch (e) {
    notify.fromError(e, "Couldn't move those blocks");
  }
}

/** Replace the current (empty) block or insert after it, selecting a node block for configuration. */
export function selectNodeAt(editor: Editor, pos: number): void {
  try {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  } catch {
    /* not selectable */
  }
}

export function isOnEmptyLine(editor: Editor): boolean {
  return isEmptyParagraph(currentBlock(editor.state));
}

export function fragmentOf(nodes: PMNode[]): Fragment {
  return Fragment.from(nodes);
}
