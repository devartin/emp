/**
 * Structural editing for the nested block schema (§7.1, §7.3): block lookup, visual order, split/merge, indent,
 * outdent, move, duplicate, delete, turn-into and insertion. Every command is `(state, dispatch?) => boolean` so it can
 * be used from keymaps, menus and the block-selection plugin alike, and each one is a single undo step.
 */
import { Fragment, type Node as PMNode, type ResolvedPos, type Schema } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ATOM_TYPES, CONTAINER, GROUP, allowsChildren, isTextContent, isToggleLike, type TurnIntoTarget } from './blockTypes';
import { newBlockId } from './ids';

export type Dispatch = ((tr: Transaction) => void) | undefined;

export interface BlockInfo {
  /** Position before the blockContainer. */
  pos: number;
  /** Position after the blockContainer. */
  end: number;
  node: PMNode;
  content: PMNode;
  /** Position before the content node. */
  contentPos: number;
  /** Position after the content node. */
  contentEnd: number;
  group: PMNode | null;
  id: string;
}

// ───────────────────────────────────────────────────────────────────────────── lookup

export function infoAt(doc: PMNode, pos: number): BlockInfo | null {
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== CONTAINER || !node.firstChild) return null;
  const content = node.firstChild;
  const contentPos = pos + 1;
  return {
    pos,
    end: pos + node.nodeSize,
    node,
    content,
    contentPos,
    contentEnd: contentPos + content.nodeSize,
    group: node.childCount > 1 ? node.child(1) : null,
    id: String(node.attrs.id ?? ''),
  };
}

export function blockFromResolved($pos: ResolvedPos): BlockInfo | null {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === CONTAINER) return infoAt($pos.doc, $pos.before(d));
  }
  const after = $pos.nodeAfter;
  if (after?.type.name === CONTAINER) return infoAt($pos.doc, $pos.pos);
  return null;
}

/** The block that holds the selection head (or the selected container). */
export function currentBlock(state: EditorState): BlockInfo | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === CONTAINER) return infoAt(state.doc, sel.from);
  return blockFromResolved(sel.$from);
}

export function findBlockById(doc: PMNode, id: string): BlockInfo | null {
  let found: BlockInfo | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === CONTAINER && node.attrs.id === id) {
      found = infoAt(doc, pos);
      return false;
    }
    return node.type.name === GROUP || node.type.name === CONTAINER || node.type.name === 'columnList' || node.type.name === 'column';
  });
  return found;
}

export function parentOf(doc: PMNode, info: BlockInfo): BlockInfo | null {
  const $ = doc.resolve(info.pos);
  if ($.depth >= 2 && $.node($.depth - 1).type.name === CONTAINER) return infoAt(doc, $.before($.depth - 1));
  return null;
}

/** Depth of nesting (0 = top level of its flow, i.e. the root group or a column). */
export function nestingDepth(doc: PMNode, info: BlockInfo): number {
  let d = 0;
  let cur = parentOf(doc, info);
  while (cur) {
    d++;
    cur = parentOf(doc, cur);
  }
  return d;
}

export function siblingIndex(doc: PMNode, info: BlockInfo): { group: PMNode; index: number } {
  const $ = doc.resolve(info.pos);
  return { group: $.parent, index: $.index() };
}

export function prevSibling(doc: PMNode, info: BlockInfo): BlockInfo | null {
  const { group, index } = siblingIndex(doc, info);
  if (index === 0) return null;
  return infoAt(doc, info.pos - group.child(index - 1).nodeSize);
}

export function nextSibling(doc: PMNode, info: BlockInfo): BlockInfo | null {
  const { group, index } = siblingIndex(doc, info);
  if (index >= group.childCount - 1) return null;
  return infoAt(doc, info.end);
}

export function isCollapsed(info: BlockInfo): boolean {
  return isToggleLike(info.content) && !!info.content.attrs.collapsed;
}

export function firstChild(doc: PMNode, info: BlockInfo): BlockInfo | null {
  return info.group ? infoAt(doc, info.contentEnd + 1) : null;
}

export function lastChild(doc: PMNode, info: BlockInfo): BlockInfo | null {
  if (!info.group || !info.group.lastChild) return null;
  return infoAt(doc, info.end - 2 - info.group.lastChild.nodeSize);
}

function lastVisibleDescendant(doc: PMNode, info: BlockInfo): BlockInfo {
  let cur = info;
  for (;;) {
    if (!cur.group || isCollapsed(cur)) return cur;
    const lc = lastChild(doc, cur);
    if (!lc) return cur;
    cur = lc;
  }
}

/** The block visually above (skipping collapsed children); null at the top of a flow. */
export function prevVisual(doc: PMNode, info: BlockInfo): BlockInfo | null {
  const prev = prevSibling(doc, info);
  if (prev) return lastVisibleDescendant(doc, prev);
  return parentOf(doc, info);
}

/** The block visually below; null at the end of a flow. */
export function nextVisual(doc: PMNode, info: BlockInfo): BlockInfo | null {
  if (info.group && !isCollapsed(info)) return firstChild(doc, info);
  let cur: BlockInfo | null = info;
  while (cur) {
    const n = nextSibling(doc, cur);
    if (n) return n;
    cur = parentOf(doc, cur);
  }
  return null;
}

/** All blocks in document order (optionally only the visible ones), with nesting depth within their flow. */
export function allBlocks(doc: PMNode, opts: { visibleOnly?: boolean } = {}): (BlockInfo & { depth: number; inColumn: boolean })[] {
  const out: (BlockInfo & { depth: number; inColumn: boolean })[] = [];
  const walk = (group: PMNode, groupPos: number, depth: number, inColumn: boolean) => {
    let pos = groupPos + 1;
    group.forEach((child) => {
      const info = infoAt(doc, pos);
      if (info) {
        out.push({ ...info, depth, inColumn });
        if (info.content.type.name === 'columnList') {
          let colPos = info.contentPos + 1;
          info.content.forEach((col) => {
            const g = col.firstChild;
            if (g) walk(g, colPos + 1, 0, true);
            colPos += col.nodeSize;
          });
        }
        if (info.group && !(opts.visibleOnly && isCollapsed(info))) walk(info.group, info.contentEnd, depth + 1, inColumn);
      }
      pos += child.nodeSize;
    });
  };
  const root = doc.firstChild;
  if (root) walk(root, 0, 0, false);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── construction

export function makeContainer(schema: Schema, content: PMNode, children?: readonly PMNode[] | Fragment | null, attrs: Record<string, unknown> = {}): PMNode {
  const kids = children instanceof Fragment ? children : children && children.length ? Fragment.from(children as PMNode[]) : null;
  const parts: PMNode[] = [content];
  if (kids && kids.size && allowsChildren(content)) parts.push(schema.nodes[GROUP].create(null, kids));
  return schema.nodes[CONTAINER].create({ id: newBlockId(), color: null, bg: null, dir: 'auto', ...attrs }, parts);
}

export function emptyParagraphBlock(schema: Schema): PMNode {
  return makeContainer(schema, schema.nodes.paragraph.create());
}

/** Rebuild a container with new content and/or children (null removes the child group). */
export function rebuildContainer(schema: Schema, info: BlockInfo, content: PMNode, children: Fragment | null | 'keep' = 'keep'): PMNode {
  const kids = children === 'keep' ? info.group?.content ?? null : children;
  const parts: PMNode[] = [content];
  if (kids && kids.size) parts.push(schema.nodes[GROUP].create(null, kids));
  return info.node.type.create(info.node.attrs, parts, info.node.marks);
}

function withCollapsed(content: PMNode, collapsed: boolean): PMNode {
  if (!isToggleLike(content) || !!content.attrs.collapsed === collapsed) return content;
  return content.type.create({ ...content.attrs, collapsed }, content.content, content.marks);
}

// ───────────────────────────────────────────────────────────────────────────── deletion

/** Delete a container; an emptied child group is removed, an emptied root/column group gets an empty paragraph. */
export function deleteContainer(tr: Transaction, pos: number): void {
  const node = tr.doc.nodeAt(pos);
  if (!node) return;
  const $ = tr.doc.resolve(pos);
  const group = $.parent;
  if (group.childCount > 1) {
    tr.delete(pos, pos + node.nodeSize);
  } else if ($.depth >= 2 && $.node($.depth - 1).type.name === CONTAINER) {
    tr.delete($.before(), $.after());
  } else {
    tr.replaceWith(pos, pos + node.nodeSize, emptyParagraphBlock(tr.doc.type.schema));
  }
}

/** Replace a block with its own children (used when merging its text elsewhere). */
function liftOut(tr: Transaction, info: BlockInfo): void {
  if (info.group && info.group.childCount) tr.replaceWith(info.pos, info.end, info.group.content);
  else deleteContainer(tr, info.pos);
}

function mapRelative(sel: Selection, oldStart: number, oldEnd: number, newStart: number, doc: PMNode): Selection | null {
  if (sel.from < oldStart || sel.to > oldEnd) return null;
  const delta = newStart - oldStart;
  try {
    if (sel instanceof NodeSelection) return NodeSelection.create(doc, sel.from + delta);
    return TextSelection.create(doc, sel.anchor + delta, sel.head + delta);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────── Enter

const KEEP_TYPE_ON_SPLIT = new Set(['bulletItem', 'numberedItem', 'todoItem']);
const EMPTY_EXITS = new Set(['bulletItem', 'numberedItem', 'todoItem', 'toggle', 'quote', 'callout']);

function nextContentFor(schema: Schema, content: PMNode, atEnd: boolean, inline: Fragment): PMNode {
  const name = content.type.name;
  if (KEEP_TYPE_ON_SPLIT.has(name)) {
    return content.type.create(name === 'todoItem' ? { checked: false } : name === 'numberedItem' ? { start: null } : content.attrs, inline);
  }
  if (!atEnd && name !== 'heading') return content.type.create(name === 'toggle' ? { ...content.attrs, collapsed: false } : content.attrs, inline);
  if (!atEnd && name === 'heading') return content.type.create({ ...content.attrs, collapsed: false }, inline);
  return schema.nodes.paragraph.create(null, inline);
}

export function splitBlock(state: EditorState, dispatch: Dispatch): boolean {
  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return false;
  const info = blockFromResolved(sel.$from);
  if (!info || !isTextContent(info.content) || sel.$from.parent !== info.content || sel.$to.parent !== info.content) return false;
  const { schema } = state;
  const tr = state.tr;
  if (!sel.empty) tr.deleteSelection();
  const $c = tr.selection.$from;
  const content = $c.parent;
  const containerPos = $c.before($c.depth - 1);
  const blk = infoAt(tr.doc, containerPos);
  if (!blk) return false;
  const offset = $c.parentOffset;
  const isEmpty = content.content.size === 0;
  const name = content.type.name;

  // Code fence typed on its own line: ``` or ```lang + Enter.
  if (name === 'paragraph') {
    const fence = /^```([\w+#.-]*)$/.exec(content.textContent);
    if (fence && offset === content.content.size) {
      const lang = fence[1] ? fence[1].toLowerCase() : 'plain';
      tr.replaceWith(blk.contentPos, blk.contentEnd, schema.nodes.codeBlock.create({ language: lang, wrap: false, caption: '' }));
      tr.setSelection(TextSelection.create(tr.doc, blk.contentPos + 1));
      dispatch?.(tr.scrollIntoView());
      return true;
    }
  }

  // An empty last paragraph inside a toggle/callout/list item steps back out.
  if (isEmpty && name === 'paragraph' && sel.empty) {
    const parent = parentOf(state.doc, info);
    if (parent && !nextSibling(state.doc, info)) return outdent(state, dispatch);
  }

  // Empty list / to-do / toggle: outdent, or become a paragraph at the top level.
  if (isEmpty && EMPTY_EXITS.has(name) && sel.empty) {
    if (parentOf(state.doc, info)) return outdent(state, dispatch);
    tr.setNodeMarkup(blk.contentPos, schema.nodes.paragraph);
    dispatch?.(tr.scrollIntoView());
    return true;
  }

  // Caret at the start of a non-empty block: push it down, leave an empty block above.
  if (offset === 0 && !isEmpty) {
    const above = KEEP_TYPE_ON_SPLIT.has(name)
      ? content.type.create(name === 'todoItem' ? { checked: false } : content.attrs)
      : schema.nodes.paragraph.create();
    tr.insert(containerPos, makeContainer(schema, above));
    dispatch?.(tr.scrollIntoView());
    return true;
  }

  const atEnd = offset === content.content.size;
  const after = content.content.cut(offset);
  tr.delete($c.pos, $c.end());
  const updated = infoAt(tr.doc, containerPos);
  if (!updated) return false;
  const nextContent = nextContentFor(schema, content, atEnd, after);
  const newBlock = makeContainer(schema, nextContent);
  const collapsed = isCollapsed(updated);
  const childFirst = atEnd && !collapsed && (isToggleLike(content) || name === 'callout' || (!!updated.group && allowsChildren(content)));
  let caret: number;
  if (childFirst) {
    if (updated.group) {
      const at = updated.contentEnd + 1;
      tr.insert(at, newBlock);
      caret = at + 2;
    } else {
      const at = updated.contentEnd;
      tr.insert(at, schema.nodes[GROUP].create(null, newBlock));
      caret = at + 3;
    }
  } else {
    const at = updated.end;
    tr.insert(at, newBlock);
    caret = at + 2;
  }
  tr.setSelection(TextSelection.create(tr.doc, caret));
  const marks = state.storedMarks ?? (atEnd ? sel.$from.marks() : null);
  if (marks && marks.length && atEnd) tr.setStoredMarks(marks.filter((m) => m.type.name !== 'link'));
  dispatch?.(tr.scrollIntoView());
  return true;
}

// ───────────────────────────────────────────────────────────────────────────── Backspace / Delete

function selectBlockContent(tr: Transaction, info: BlockInfo, atEnd = true): void {
  if (isTextContent(info.content) || info.content.type.name === 'codeBlock') {
    tr.setSelection(TextSelection.create(tr.doc, atEnd ? info.contentEnd - 1 : info.contentPos + 1));
  } else if (info.content.type.name === 'table' || info.content.type.name === 'columnList') {
    tr.setSelection(Selection.near(tr.doc.resolve(atEnd ? info.contentEnd - 1 : info.contentPos + 1), atEnd ? -1 : 1));
  } else {
    tr.setSelection(NodeSelection.create(tr.doc, info.contentPos));
  }
}

export function mergeBackward(state: EditorState, dispatch: Dispatch): boolean {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const $f = sel.$from;
  const info = blockFromResolved($f);
  if (!info || $f.parent !== info.content || $f.parentOffset !== 0) return false;
  const { schema, doc } = state;
  const name = info.content.type.name;

  if (name === 'codeBlock') {
    if (info.content.content.size > 0) return true;
    if (dispatch) dispatch(state.tr.setNodeMarkup(info.contentPos, schema.nodes.paragraph, null));
    return true;
  }
  if (!isTextContent(info.content)) return false;

  if (name !== 'paragraph') {
    if (dispatch) {
      const tr = state.tr;
      if (info.group && !allowsChildren(schema.nodes.paragraph.create())) tr.replaceWith(info.pos, info.end, rebuildContainer(schema, info, schema.nodes.paragraph.create(null, info.content.content), null));
      else tr.setNodeMarkup(info.contentPos, schema.nodes.paragraph, null);
      dispatch(tr);
    }
    return true;
  }

  if (parentOf(doc, info)) return outdent(state, dispatch);

  const prev = prevVisual(doc, info);
  if (!prev) {
    // First block of its flow: an empty one with a block below simply goes away.
    const next = nextSibling(doc, info);
    if (info.content.content.size === 0 && !info.group && next && dispatch) {
      const tr = state.tr.delete(info.pos, info.end);
      const moved = infoAt(tr.doc, info.pos);
      if (moved) selectBlockContent(tr, moved, false);
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  if (!isTextContent(prev.content)) {
    if (!dispatch) return true;
    const tr = state.tr;
    if (info.content.content.size === 0 && !info.group) {
      tr.delete(info.pos, info.end);
      const p = infoAt(tr.doc, prev.pos);
      if (p) selectBlockContent(tr, p, true);
    } else {
      selectBlockContent(tr, prev, true);
    }
    dispatch(tr.scrollIntoView());
    return true;
  }

  if (!dispatch) return true;
  const tr = state.tr;
  const inline = info.content.content;
  liftOut(tr, info);
  const at = prev.contentEnd - 1;
  tr.insert(at, inline);
  tr.setSelection(TextSelection.create(tr.doc, at));
  dispatch(tr.scrollIntoView());
  return true;
}

export function mergeForward(state: EditorState, dispatch: Dispatch): boolean {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const $f = sel.$from;
  const info = blockFromResolved($f);
  if (!info || $f.parent !== info.content || $f.parentOffset !== info.content.content.size) return false;
  if (!isTextContent(info.content)) return false;
  const next = nextVisual(state.doc, info);
  if (!next) return true;
  if (!dispatch) return true;
  const tr = state.tr;
  if (!isTextContent(next.content)) {
    selectBlockContent(tr, next, false);
    dispatch(tr.scrollIntoView());
    return true;
  }
  const inline = next.content.content;
  liftOut(tr, next);
  const at = info.contentEnd - 1;
  tr.insert(at, inline);
  tr.setSelection(TextSelection.create(tr.doc, at));
  dispatch(tr.scrollIntoView());
  return true;
}

// ───────────────────────────────────────────────────────────────────────────── indent / outdent

/** Normalise a block list to one run of consecutive siblings (the run that contains the first block). */
export function siblingRun(_doc: PMNode, blocks: BlockInfo[]): BlockInfo[] {
  if (blocks.length <= 1) return blocks;
  const sorted = [...blocks].sort((a, b) => a.pos - b.pos);
  const run = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = run[run.length - 1];
    if (sorted[i].pos === prev.end) run.push(sorted[i]);
    else if (sorted[i].pos > prev.end) break;
  }
  return run;
}

export function indent(state: EditorState, dispatch: Dispatch, blocks?: BlockInfo[]): boolean {
  const { doc, schema } = state;
  const list = siblingRun(doc, blocks ?? [currentBlock(state)].filter((b): b is BlockInfo => !!b));
  const first = list[0];
  if (!first) return false;
  if (list.length === 1 && ATOM_TYPES.has(first.content.type.name)) return true;
  if (first.content.type.name === 'columnList') return true;
  const prev = prevSibling(doc, first);
  if (!prev || !allowsChildren(prev.content)) return true;
  if (!dispatch) return true;
  const last = list[list.length - 1];
  const moved = Fragment.from(list.map((b) => b.node));
  const prevContent = withCollapsed(prev.content, false);
  const kids = prev.group ? prev.group.content.append(moved) : moved;
  const newPrev = rebuildContainer(schema, prev, prevContent, kids);
  const tr = state.tr.replaceWith(prev.pos, last.end, newPrev);
  const newStart = prev.pos + 1 + prevContent.nodeSize + 1 + (prev.group ? prev.group.content.size : 0);
  const mapped = mapRelative(state.selection, first.pos, last.end, newStart, tr.doc);
  if (mapped) tr.setSelection(mapped);
  dispatch(tr.scrollIntoView());
  return true;
}

export function outdent(state: EditorState, dispatch: Dispatch, blocks?: BlockInfo[]): boolean {
  const { doc, schema } = state;
  const list = siblingRun(doc, blocks ?? [currentBlock(state)].filter((b): b is BlockInfo => !!b));
  const first = list[0];
  if (!first) return false;
  const parent = parentOf(doc, first);
  if (!parent || !parent.group) return true;
  if (!dispatch) return true;
  const last = list[list.length - 1];
  const group = parent.group;
  const startIdx = siblingIndex(doc, first).index;
  const endIdx = siblingIndex(doc, last).index;
  const before: PMNode[] = [];
  const following: PMNode[] = [];
  group.forEach((child, _o, i) => {
    if (i < startIdx) before.push(child);
    else if (i > endIdx) following.push(child);
  });
  const moved: PMNode[] = list.map((b) => b.node);
  let trailing: PMNode[] = [];
  if (following.length) {
    const lastInfo = list[list.length - 1];
    if (allowsChildren(lastInfo.content)) {
      const kids = (lastInfo.group?.content ?? Fragment.empty).append(Fragment.from(following));
      moved[moved.length - 1] = rebuildContainer(schema, lastInfo, lastInfo.content, kids);
    } else {
      trailing = following;
    }
  }
  const remaining = [...before, ...trailing];
  const newParent = rebuildContainer(schema, parent, parent.content, remaining.length ? Fragment.from(remaining) : null);
  const tr = state.tr.replaceWith(parent.pos, parent.end, Fragment.from([newParent, ...moved]));
  const newStart = parent.pos + newParent.nodeSize;
  const mapped = mapRelative(state.selection, first.pos, last.end, newStart, tr.doc);
  if (mapped) tr.setSelection(mapped);
  dispatch(tr.scrollIntoView());
  return true;
}

// ───────────────────────────────────────────────────────────────────────────── move / duplicate / delete

export function moveBlocks(state: EditorState, dispatch: Dispatch, dir: -1 | 1, blocks?: BlockInfo[]): boolean {
  const { doc, schema } = state;
  const list = siblingRun(doc, blocks ?? [currentBlock(state)].filter((b): b is BlockInfo => !!b));
  if (!list.length) return false;
  const first = list[0];
  const last = list[list.length - 1];
  const moved = Fragment.from(list.map((b) => b.node));
  const tr = state.tr;
  let newStart: number;
  if (dir < 0) {
    const prev = prevSibling(doc, first);
    if (prev) {
      tr.replaceWith(prev.pos, last.end, moved.append(Fragment.from(prev.node)));
      newStart = prev.pos;
    } else {
      const parent = parentOf(doc, first);
      if (!parent || !parent.group) return true;
      const rest: PMNode[] = [];
      parent.group.forEach((c, _o, i) => {
        if (i >= list.length) rest.push(c);
      });
      const newParent = rebuildContainer(schema, parent, parent.content, rest.length ? Fragment.from(rest) : null);
      tr.replaceWith(parent.pos, parent.end, moved.append(Fragment.from(newParent)));
      newStart = parent.pos;
    }
  } else {
    const next = nextSibling(doc, last);
    if (next) {
      tr.replaceWith(first.pos, next.end, Fragment.from(next.node).append(moved));
      newStart = first.pos + next.node.nodeSize;
    } else {
      const parent = parentOf(doc, first);
      if (!parent || !parent.group) return true;
      const keep: PMNode[] = [];
      const startIdx = siblingIndex(doc, first).index;
      parent.group.forEach((c, _o, i) => {
        if (i < startIdx) keep.push(c);
      });
      const newParent = rebuildContainer(schema, parent, parent.content, keep.length ? Fragment.from(keep) : null);
      tr.replaceWith(parent.pos, parent.end, Fragment.from(newParent).append(moved));
      newStart = parent.pos + newParent.nodeSize;
    }
  }
  if (!dispatch) return true;
  const mapped = mapRelative(state.selection, first.pos, last.end, newStart, tr.doc);
  if (mapped) tr.setSelection(mapped);
  tr.setMeta('emp:moved', list.map((b) => b.id));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Deep copy with fresh block ids (§7.1: duplicate always regenerates ids). */
export function cloneWithNewIds(node: PMNode): PMNode {
  if (node.isText) return node;
  const kids: PMNode[] = [];
  node.forEach((c) => kids.push(cloneWithNewIds(c)));
  const attrs = node.type.name === CONTAINER ? { ...node.attrs, id: newBlockId() } : node.attrs;
  return node.type.create(attrs, kids.length ? Fragment.from(kids) : node.content, node.marks);
}

export function duplicateBlocks(state: EditorState, dispatch: Dispatch, blocks?: BlockInfo[]): { ids: string[] } | false {
  const list = siblingRun(state.doc, blocks ?? [currentBlock(state)].filter((b): b is BlockInfo => !!b));
  if (!list.length) return false;
  const copies = list.map((b) => cloneWithNewIds(b.node));
  const last = list[list.length - 1];
  if (dispatch) {
    const tr = state.tr.insert(last.end, Fragment.from(copies));
    const sel = state.selection;
    const first = list[0];
    const delta = last.end - first.pos;
    try {
      if (sel.from >= first.pos && sel.to <= last.end && sel instanceof TextSelection) {
        tr.setSelection(TextSelection.create(tr.doc, sel.anchor + delta, sel.head + delta));
      }
    } catch {
      /* keep */
    }
    dispatch(tr.scrollIntoView());
  }
  return { ids: copies.map((c) => String(c.attrs.id)) };
}

export function deleteBlocks(state: EditorState, dispatch: Dispatch, blocks: BlockInfo[]): boolean {
  if (!blocks.length) return false;
  if (!dispatch) return true;
  const sorted = topLevelOnly(blocks).sort((a, b) => b.pos - a.pos);
  const tr = state.tr;
  const firstPos = sorted[sorted.length - 1].pos;
  for (const b of sorted) deleteContainer(tr, tr.mapping.map(b.pos));
  const near = Math.min(tr.mapping.map(firstPos), tr.doc.content.size - 1);
  const $near = tr.doc.resolve(Math.max(1, near));
  const after = blockFromResolved($near) ?? infoAt(tr.doc, near);
  if (after && isTextContent(after.content)) tr.setSelection(TextSelection.create(tr.doc, after.contentPos + 1));
  else tr.setSelection(Selection.near($near));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Drop blocks whose ancestor is also in the list. */
export function topLevelOnly(blocks: BlockInfo[]): BlockInfo[] {
  const sorted = [...blocks].sort((a, b) => a.pos - b.pos);
  const out: BlockInfo[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.pos > last.pos && b.end <= last.end) continue;
    out.push(b);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── turn into

function inlineFromText(schema: Schema, text: string): Fragment {
  const parts: PMNode[] = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) parts.push(schema.nodes.hardBreak.create());
    if (line) parts.push(schema.text(line));
  });
  return Fragment.from(parts);
}

function textOfInline(content: PMNode): string {
  let s = '';
  content.forEach((n) => {
    if (n.isText) s += n.text;
    else if (n.type.name === 'hardBreak') s += '\n';
    else if (n.type.name === 'emoji') s += String(n.attrs.native ?? '');
    else if (n.type.name === 'mathInline') s += `$${String(n.attrs.latex ?? '')}$`;
  });
  return s;
}

function flattenText(info: BlockInfo, doc: PMNode): string {
  const lines = [textOfInline(info.content)];
  if (info.group) {
    for (const b of allBlocks(doc).filter((x) => x.pos > info.pos && x.end <= info.end)) {
      if (isTextContent(b.content)) lines.push(textOfInline(b.content));
      else if (b.content.type.name === 'codeBlock') lines.push(b.content.textContent);
    }
  }
  return lines.join('\n');
}

export function targetAttrs(t: TurnIntoTarget, prev: PMNode | null): Record<string, unknown> | null {
  switch (t.type) {
    case 'heading':
      return { level: t.attrs?.level ?? 1, toggle: !!t.attrs?.toggle, collapsed: false };
    case 'todoItem':
      return { checked: prev?.type.name === 'todoItem' ? !!prev.attrs.checked : false };
    case 'toggle':
      return { collapsed: false };
    case 'callout':
      return prev?.type.name === 'callout' ? prev.attrs : { icon: { t: 'lucide', v: 'lightbulb' }, color: 'gray' };
    case 'codeBlock':
      return { language: 'plain', wrap: false, caption: '' };
    case 'numberedItem':
      return { start: null };
    default:
      return null;
  }
}

/** Would converting these blocks to code flatten children (needs a confirmation, §7.4)? */
export function turnIntoNeedsConfirm(blocks: BlockInfo[], t: TurnIntoTarget): boolean {
  return t.type === 'codeBlock' && blocks.some((b) => !!b.group && b.group.childCount > 0);
}

export function turnInto(state: EditorState, dispatch: Dispatch, blocks: BlockInfo[], t: TurnIntoTarget): boolean {
  const { schema } = state;
  const type = schema.nodes[t.type];
  if (!type) return false;
  const list = topLevelOnly(blocks).filter((b) => isTextContent(b.content) || b.content.type.name === 'codeBlock');
  if (!list.length) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  const single = list.length === 1 && state.selection instanceof TextSelection ? state.selection : null;
  for (const b of [...list].sort((a, z) => z.pos - a.pos)) {
    const pos = tr.mapping.map(b.pos);
    const info = infoAt(tr.doc, pos);
    if (!info) continue;
    const attrs = targetAttrs(t, info.content);
    const fromCode = info.content.type.name === 'codeBlock';
    if (t.type === 'codeBlock') {
      if (fromCode) continue;
      const text = flattenText(info, tr.doc);
      const code = type.create(attrs, text ? schema.text(text) : null);
      tr.replaceWith(info.pos, info.end, rebuildContainer(schema, info, code, null));
      continue;
    }
    const inline = fromCode ? inlineFromText(schema, info.content.textContent) : info.content.content;
    const next = type.create(attrs, inline);
    if (!allowsChildren(next) && info.group) {
      tr.replaceWith(info.pos, info.end, Fragment.from(rebuildContainer(schema, info, next, null)).append(info.group.content));
    } else if (!fromCode) {
      tr.setNodeMarkup(info.contentPos, type, attrs);
    } else {
      tr.replaceWith(info.contentPos, info.contentEnd, next);
    }
  }
  if (single) {
    try {
      tr.setSelection(TextSelection.create(tr.doc, Math.min(tr.mapping.map(single.anchor), tr.doc.content.size - 1), Math.min(tr.mapping.map(single.head), tr.doc.content.size - 1)));
    } catch {
      /* mapped selection is fine */
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
}

// ───────────────────────────────────────────────────────────────────────────── colours

export function setBlockColor(state: EditorState, dispatch: Dispatch, blocks: BlockInfo[], kind: 'color' | 'bg', value: string | null): boolean {
  if (!blocks.length) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  for (const b of blocks) {
    const attrs = { ...b.node.attrs, [kind]: value };
    if (kind === 'color' && value) attrs.bg = null;
    if (kind === 'bg' && value) attrs.color = null;
    tr.setNodeMarkup(b.pos, undefined, attrs);
  }
  dispatch(tr);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────── insertion

export interface InsertOpts {
  /** Replace the current block when it is an empty paragraph (slash menu). */
  replaceEmpty?: boolean;
  /** Insert above instead of below. */
  above?: boolean;
  /** Where to put the caret afterwards. */
  focus?: 'inside' | 'node' | 'after';
  /** Target block (defaults to the selection's block). */
  at?: BlockInfo | null;
  children?: PMNode[];
}

export function isEmptyParagraph(info: BlockInfo | null): boolean {
  return !!info && info.content.type.name === 'paragraph' && info.content.content.size === 0;
}

/** Insert a block (content node) next to / in place of the current block. Returns the new block's position. */
export function insertBlock(state: EditorState, dispatch: Dispatch, content: PMNode, opts: InsertOpts = {}): number | null {
  const { schema } = state;
  const info = opts.at ?? currentBlock(state);
  const tr = state.tr;
  let pos: number;
  if (!info) {
    pos = 1;
    tr.insert(pos, makeContainer(schema, content, opts.children));
  } else if (opts.replaceEmpty && isEmptyParagraph(info)) {
    pos = info.pos;
    const kids = info.group?.content ?? null;
    if (allowsChildren(content)) {
      const extra = opts.children?.length ? Fragment.from(opts.children) : Fragment.empty;
      tr.replaceWith(info.pos, info.end, rebuildContainer(schema, info, content, kids ? kids.append(extra) : extra.size ? extra : null));
    } else {
      tr.replaceWith(info.pos, info.end, Fragment.from(rebuildContainer(schema, info, content, null)).append(kids ?? Fragment.empty));
    }
  } else {
    pos = opts.above ? info.pos : info.end;
    tr.insert(pos, makeContainer(schema, content, opts.children));
  }
  const inserted = infoAt(tr.doc, pos);
  if (!inserted) return null;
  const focus = opts.focus ?? (isTextContent(content) || content.type.name === 'codeBlock' ? 'inside' : 'node');
  if (focus === 'inside') {
    if (content.type.name === 'table' || content.type.name === 'columnList') tr.setSelection(Selection.near(tr.doc.resolve(inserted.contentPos + 1)));
    else tr.setSelection(TextSelection.create(tr.doc, inserted.contentEnd - 1));
  } else if (focus === 'node') {
    tr.setSelection(NodeSelection.create(tr.doc, inserted.contentPos));
  } else {
    let after = nextSibling(tr.doc, inserted);
    if (!after || !isEmptyParagraph(after)) {
      tr.insert(inserted.end, emptyParagraphBlock(schema));
      after = infoAt(tr.doc, inserted.end);
    }
    if (after) tr.setSelection(TextSelection.create(tr.doc, after.contentPos + 1));
  }
  dispatch?.(tr.scrollIntoView());
  return pos;
}

/** Toggle a to-do / expand-collapse a toggle at the given block. */
export function toggleBlockState(state: EditorState, dispatch: Dispatch, info: BlockInfo): boolean {
  const c = info.content;
  if (c.type.name === 'todoItem') {
    dispatch?.(state.tr.setNodeMarkup(info.contentPos, undefined, { ...c.attrs, checked: !c.attrs.checked }));
    return true;
  }
  if (isToggleLike(c)) {
    dispatch?.(state.tr.setNodeMarkup(info.contentPos, undefined, { ...c.attrs, collapsed: !c.attrs.collapsed }));
    return true;
  }
  return false;
}

/** Expand or collapse every toggle (⌘⌥T): collapse all if any is open, else expand all. */
export function toggleAll(state: EditorState, dispatch: Dispatch): boolean {
  const toggles = allBlocks(state.doc).filter((b) => isToggleLike(b.content));
  if (!toggles.length) return false;
  const anyOpen = toggles.some((b) => !b.content.attrs.collapsed);
  if (!dispatch) return true;
  const tr = state.tr;
  for (const b of toggles) tr.setNodeMarkup(b.contentPos, undefined, { ...b.content.attrs, collapsed: anyOpen });
  dispatch(tr);
  return true;
}

/** Expand every collapsed toggle above `pos` so it becomes visible (find, backlinks, drag hover). */
export function revealPos(state: EditorState, pos: number): Transaction | null {
  const $ = state.doc.resolve(Math.min(pos, state.doc.content.size));
  let tr: Transaction | null = null;
  for (let d = $.depth; d > 0; d--) {
    const n = $.node(d);
    if (n.type.name !== CONTAINER) continue;
    const content = n.firstChild;
    const inside = $.pos > $.before(d) + 1 + (content?.nodeSize ?? 0);
    if (content && inside && isToggleLike(content) && content.attrs.collapsed) {
      tr ??= state.tr;
      tr.setNodeMarkup($.before(d) + 1, undefined, { ...content.attrs, collapsed: false });
    }
  }
  return tr;
}
