/**
 * TipTap document helpers for the mock (D-07 / §7.1 BlockNote-style schema):
 *   doc → blockGroup → blockContainer{ id, color, bg, dir } → [blockContent, blockGroup?]
 *
 * Builders (`b.*`) make seed content readable; walkers power search, outline, backlinks and turn-into-page.
 */
import type { BlockColor, DateValue, Icon, TipTapDoc, TipTapMark, TipTapNode } from '../../types';

export const SCHEMA_VERSION = 1;

// ───────────────────────────────────────────────────────────────────────────── inline builders

/** Text, an inline node, or (nested) arrays of them — mark helpers return arrays, so they nest freely. */
export type Inline = TipTapNode | string | readonly Inline[];

function mark(type: string, attrs?: Record<string, unknown>): TipTapMark {
  return attrs ? { type, attrs } : { type };
}

function withMark(content: Inline, m: TipTapMark): TipTapNode[] {
  return toInline(content).map((n) => (n.type === 'text' ? { ...n, marks: [...(n.marks ?? []), m] } : n));
}

export function toInline(content: Inline | undefined): TipTapNode[] {
  if (content === undefined) return [];
  const out: TipTapNode[] = [];
  const visit = (c: Inline) => {
    if (typeof c === 'string') {
      if (c.length) out.push({ type: 'text', text: c });
    } else if (Array.isArray(c)) (c as readonly Inline[]).forEach(visit);
    else out.push(c as TipTapNode);
  };
  visit(content);
  return out;
}

/** Inline helpers: `t.bold('x')`, `t.link('EMP', 'https://…')`, `t.mention(pageId)` … */
export const t = {
  text: (s: string): TipTapNode => ({ type: 'text', text: s }),
  bold: (c: Inline) => withMark(c, mark('bold')),
  italic: (c: Inline) => withMark(c, mark('italic')),
  underline: (c: Inline) => withMark(c, mark('underline')),
  strike: (c: Inline) => withMark(c, mark('strike')),
  code: (c: Inline) => withMark(c, mark('code')),
  link: (c: Inline, href: string) => withMark(c, mark('link', { href })),
  color: (c: Inline, color: BlockColor) => withMark(c, mark('textColor', { color })),
  highlight: (c: Inline, color: BlockColor = 'yellow') => withMark(c, mark('highlight', { color })),
  mention: (pageId: string): TipTapNode => ({ type: 'mention', attrs: { kind: 'page', pageId } }),
  date: (date: DateValue): TipTapNode => ({ type: 'mention', attrs: { kind: 'date', date } }),
  emoji: (native: string, shortcode: string): TipTapNode => ({ type: 'emoji', attrs: { native, shortcode } }),
  math: (latex: string): TipTapNode => ({ type: 'mathInline', attrs: { latex } }),
  br: (): TipTapNode => ({ type: 'hardBreak' }),
};

// ───────────────────────────────────────────────────────────────────────────── block builders

export interface BlockOpts {
  id?: string;
  color?: BlockColor | null;
  bg?: BlockColor | null;
  children?: TipTapNode[];
}

type IdGen = () => string;
let idGen: IdGen = () => Math.random().toString(36).slice(2, 14).padEnd(12, '0');

/** Set the id generator used by `b.*` when no explicit id is given (the mock uses its seeded rng). */
export function setBlockIdGenerator(fn: IdGen): void {
  idGen = fn;
}

function container(contentNode: TipTapNode, opts: BlockOpts = {}): TipTapNode {
  const content: TipTapNode[] = [contentNode];
  if (opts.children && opts.children.length) content.push({ type: 'blockGroup', content: opts.children });
  return {
    type: 'blockContainer',
    attrs: { id: opts.id ?? idGen(), color: opts.color ?? null, bg: opts.bg ?? null, dir: 'auto' },
    content,
  };
}

function inlineNode(type: string, attrs: Record<string, unknown> | undefined, content?: Inline): TipTapNode {
  const inl = toInline(content);
  const node: TipTapNode = { type };
  if (attrs) node.attrs = attrs;
  if (inl.length) node.content = inl;
  return node;
}

/** Block builders: each returns a `blockContainer`. */
export const b = {
  p: (content?: Inline, opts?: BlockOpts) => container(inlineNode('paragraph', undefined, content), opts),
  h1: (content: Inline, opts?: BlockOpts) =>
    container(inlineNode('heading', { level: 1, toggle: false, collapsed: false }, content), opts),
  h2: (content: Inline, opts?: BlockOpts) =>
    container(inlineNode('heading', { level: 2, toggle: false, collapsed: false }, content), opts),
  h3: (content: Inline, opts?: BlockOpts) =>
    container(inlineNode('heading', { level: 3, toggle: false, collapsed: false }, content), opts),
  toggleHeading: (level: 1 | 2 | 3, content: Inline, opts?: BlockOpts & { collapsed?: boolean }) =>
    container(inlineNode('heading', { level, toggle: true, collapsed: opts?.collapsed ?? true }, content), opts),
  bullet: (content: Inline, opts?: BlockOpts) => container(inlineNode('bulletItem', undefined, content), opts),
  numbered: (content: Inline, opts?: BlockOpts) =>
    container(inlineNode('numberedItem', { start: null }, content), opts),
  todo: (content: Inline, checked = false, opts?: BlockOpts) =>
    container(inlineNode('todoItem', { checked }, content), opts),
  toggle: (content: Inline, opts?: BlockOpts & { collapsed?: boolean }) =>
    container(inlineNode('toggle', { collapsed: opts?.collapsed ?? true }, content), opts),
  quote: (content: Inline, opts?: BlockOpts) => container(inlineNode('quote', undefined, content), opts),
  callout: (content: Inline, opts?: BlockOpts & { icon?: Icon; tone?: BlockColor }) =>
    container(
      inlineNode('callout', { icon: opts?.icon ?? { t: 'emoji', v: '💡' }, color: opts?.tone ?? 'gray' }, content),
      opts,
    ),
  code: (code: string, language = 'plain', opts?: BlockOpts & { caption?: string; wrap?: boolean }) =>
    container(
      {
        type: 'codeBlock',
        attrs: { language, wrap: opts?.wrap ?? false, caption: opts?.caption ?? '' },
        ...(code ? { content: [{ type: 'text', text: code }] } : {}),
      },
      opts,
    ),
  divider: (opts?: BlockOpts) => container({ type: 'divider' }, opts),
  math: (latex: string, opts?: BlockOpts) => container({ type: 'mathBlock', attrs: { latex } }, opts),
  pageRef: (pageId: string, opts?: BlockOpts) => container({ type: 'pageRef', attrs: { pageId } }, opts),
  pageLink: (pageId: string, opts?: BlockOpts) => container({ type: 'pageLink', attrs: { pageId } }, opts),
  image: (
    assetId: string,
    opts?: BlockOpts & { caption?: string; width?: number | null; align?: 'left' | 'center' | 'right' },
  ) =>
    container(
      { type: 'image', attrs: { assetId, width: opts?.width ?? null, align: opts?.align ?? 'center', caption: opts?.caption ?? '' } },
      opts,
    ),
  file: (assetId: string, opts?: BlockOpts) => container({ type: 'file', attrs: { assetId } }, opts),
  toc: (opts?: BlockOpts) => container({ type: 'toc' }, opts),
  databaseView: (databaseId: string, viewId: string | null = null, opts?: BlockOpts & { linked?: boolean; height?: number | null }) =>
    container(
      { type: 'databaseView', attrs: { databaseId, viewId, linked: opts?.linked ?? false, height: opts?.height ?? null } },
      opts,
    ),
  table: (
    rows: (Inline)[][],
    opts?: BlockOpts & { headerRow?: boolean; headerCol?: boolean; colWidths?: number[] },
  ) =>
    container(
      {
        type: 'table',
        attrs: {
          headerRow: opts?.headerRow ?? true,
          headerCol: opts?.headerCol ?? false,
          colWidths: opts?.colWidths ?? [],
          cellColors: {},
        },
        content: rows.map((cells) => ({
          type: 'tableRow',
          content: cells.map((c) => inlineNode('tableCell', undefined, c)),
        })),
      },
      opts,
    ),
  /** 2–5 columns; each column is a list of blockContainers. */
  columns: (cols: TipTapNode[][], opts?: BlockOpts & { widths?: number[] }) => {
    const n = Math.min(5, Math.max(2, cols.length));
    const widths = opts?.widths ?? Array.from({ length: n }, () => 1 / n);
    return container(
      {
        type: 'columnList',
        attrs: { widths },
        content: cols.slice(0, n).map((blocks) => ({ type: 'column', content: [{ type: 'blockGroup', content: blocks }] })),
      },
      opts,
    );
  },
};

export function makeDoc(blocks: TipTapNode[]): TipTapDoc {
  return {
    type: 'doc',
    attrs: { schemaVersion: SCHEMA_VERSION },
    content: [{ type: 'blockGroup', content: blocks.length ? blocks : [b.p()] }],
  };
}

export function emptyDoc(): TipTapDoc {
  return makeDoc([b.p()]);
}

// ───────────────────────────────────────────────────────────────────────────── walkers

export interface BlockVisit {
  /** blockContainer node */
  container: TipTapNode;
  /** blockContent node (paragraph, heading, …) */
  content: TipTapNode;
  id: string;
  depth: number;
  /** Plain text of the content node (not children). */
  text: string;
}

export function inlineText(node: TipTapNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'emoji') return String((node.attrs as { native?: string } | undefined)?.native ?? '');
  if (node.type === 'mathInline') return String((node.attrs as { latex?: string } | undefined)?.latex ?? '');
  if (node.type === 'mention') {
    const a = node.attrs as { label?: string; kind?: string; date?: { start?: string } } | undefined;
    if (a?.label) return a.label;
    if (a?.kind === 'date' && a.date?.start) return a.date.start;
    return '';
  }
  if (!node.content) return '';
  const sep = node.type === 'tableRow' ? ' · ' : node.type === 'table' ? '\n' : '';
  return node.content.map(inlineText).join(sep);
}

function contentText(content: TipTapNode): string {
  switch (content.type) {
    case 'mathBlock':
      return String((content.attrs as { latex?: string } | undefined)?.latex ?? '');
    case 'image':
      return String((content.attrs as { caption?: string } | undefined)?.caption ?? '');
    case 'codeBlock':
    case 'table':
    default:
      return inlineText(content);
  }
}

/** Depth-first walk over every blockContainer (including those inside columns). Return false to stop. */
export function walkBlocks(doc: TipTapDoc | TipTapNode | null | undefined, fn: (v: BlockVisit) => void | false): void {
  if (!doc) return;
  let stopped = false;
  const visitGroup = (group: TipTapNode | undefined, depth: number) => {
    if (!group?.content) return;
    for (const c of group.content) {
      if (stopped) return;
      if (c.type !== 'blockContainer') continue;
      const content = c.content?.[0];
      if (!content) continue;
      const id = String((c.attrs as { id?: string } | undefined)?.id ?? '');
      if (fn({ container: c, content, id, depth, text: contentText(content) }) === false) {
        stopped = true;
        return;
      }
      if (content.type === 'columnList') {
        for (const col of content.content ?? []) for (const g of col.content ?? []) visitGroup(g, depth + 1);
      }
      const childGroup = c.content?.[1];
      if (childGroup?.type === 'blockGroup') visitGroup(childGroup, depth + 1);
    }
  };
  if ((doc as TipTapNode).type === 'blockContainer') {
    visitGroup({ type: 'blockGroup', content: [doc as TipTapNode] }, 0);
    return;
  }
  for (const top of doc.content ?? []) {
    if (top.type === 'blockGroup') visitGroup(top, 0);
  }
}

export function docText(doc: TipTapDoc | null | undefined): string {
  const parts: string[] = [];
  walkBlocks(doc, (v) => {
    if (v.text) parts.push(v.text);
  });
  return parts.join('\n');
}

export function outline(doc: TipTapDoc | null | undefined): { blockId: string; level: 1 | 2 | 3; text: string }[] {
  const out: { blockId: string; level: 1 | 2 | 3; text: string }[] = [];
  walkBlocks(doc, (v) => {
    if (v.content.type === 'heading') {
      const level = Number((v.content.attrs as { level?: number } | undefined)?.level ?? 1);
      if (v.text.trim()) out.push({ blockId: v.id, level: (level >= 1 && level <= 3 ? level : 1) as 1 | 2 | 3, text: v.text });
    }
  });
  return out;
}

export interface OutgoingLink {
  targetPageId: string;
  blockId: string;
  /** Plain text of the block holding the link. */
  blockText: string;
  /** Character offset of the link inside blockText (for snippets). */
  offset: number;
}

const INTERNAL_HREF = /^emp:\/\/page\/([0-9a-f-]{8,})(?:#(.+))?$/i;

/** Mentions, pageLink, pageRef and internal `emp://page/<id>` links (§7.10). */
export function outgoingLinks(doc: TipTapDoc | null | undefined): OutgoingLink[] {
  const out: OutgoingLink[] = [];
  walkBlocks(doc, (v) => {
    if (v.content.type === 'pageRef' || v.content.type === 'pageLink') {
      const pid = (v.content.attrs as { pageId?: string } | undefined)?.pageId;
      if (pid) out.push({ targetPageId: pid, blockId: v.id, blockText: v.text, offset: 0 });
      return;
    }
    let offset = 0;
    const scan = (n: TipTapNode) => {
      if (n.type === 'mention') {
        const a = n.attrs as { kind?: string; pageId?: string } | undefined;
        if (a?.kind === 'page' && a.pageId) out.push({ targetPageId: a.pageId, blockId: v.id, blockText: v.text, offset });
      }
      if (n.type === 'text') {
        for (const m of n.marks ?? []) {
          if (m.type !== 'link') continue;
          const href = String((m.attrs as { href?: string } | undefined)?.href ?? '');
          const hit = INTERNAL_HREF.exec(href);
          if (hit) out.push({ targetPageId: hit[1], blockId: v.id, blockText: v.text, offset });
        }
      }
      offset += inlineText(n).length;
      if (n.type !== 'text' && n.type !== 'mention') n.content?.forEach(scan);
    };
    v.content.content?.forEach(scan);
  });
  return out;
}

export function findBlock(doc: TipTapDoc | null | undefined, blockId: string): TipTapNode | null {
  let found: TipTapNode | null = null;
  walkBlocks(doc, (v) => {
    if (v.id === blockId) {
      found = v.container;
      return false;
    }
  });
  return found;
}

/** Deep-clone `nodes`, giving every blockContainer a fresh id (paste/duplicate/template instantiation, §7.1). */
export function regenerateIds<T extends TipTapNode | TipTapDoc>(node: T, gen: () => string): T {
  const clone = structuredClone(node) as T;
  const visit = (n: TipTapNode) => {
    if (n.type === 'blockContainer') n.attrs = { ...(n.attrs ?? {}), id: gen() };
    n.content?.forEach(visit);
  };
  (clone as TipTapNode).content?.forEach(visit);
  if ((clone as TipTapNode).type === 'blockContainer') visit(clone as TipTapNode);
  return clone;
}

/**
 * Remove the blockContainers with `ids` from the doc (wherever they are) and insert `replacement` at the position
 * of the first removed one. Returns the removed containers in document order.
 */
export function extractBlocks(
  doc: TipTapDoc,
  ids: ReadonlySet<string>,
  replacement: TipTapNode | null,
): { doc: TipTapDoc; removed: TipTapNode[] } {
  const next = structuredClone(doc);
  const removed: TipTapNode[] = [];
  let placed = replacement === null;
  const visitGroup = (group: TipTapNode) => {
    if (!group.content) return;
    const kept: TipTapNode[] = [];
    for (const c of group.content) {
      const id = String((c.attrs as { id?: string } | undefined)?.id ?? '');
      if (c.type === 'blockContainer' && ids.has(id)) {
        removed.push(c);
        if (!placed && replacement) {
          kept.push(replacement);
          placed = true;
        }
        continue;
      }
      const content = c.content?.[0];
      if (content?.type === 'columnList') {
        for (const col of content.content ?? []) for (const g of col.content ?? []) visitGroup(g);
      }
      const child = c.content?.[1];
      if (child?.type === 'blockGroup') {
        visitGroup(child);
        if (!child.content?.length) c.content = c.content?.slice(0, 1);
      }
      kept.push(c);
    }
    group.content = kept;
  };
  for (const top of next.content) if (top.type === 'blockGroup') visitGroup(top);
  const root = next.content.find((n) => n.type === 'blockGroup');
  if (root && !root.content?.length) root.content = [b.p()];
  return { doc: next, removed };
}

/** Set `checked` on the todoItem inside blockContainer `blockId`. Returns true when something changed. */
export function setTodoChecked(doc: TipTapDoc, blockId: string, checked: boolean): boolean {
  let changed = false;
  walkBlocks(doc, (v) => {
    if (v.id === blockId && v.content.type === 'todoItem') {
      const attrs = (v.content.attrs ?? {}) as { checked?: boolean };
      if (attrs.checked !== checked) {
        v.content.attrs = { ...attrs, checked };
        changed = true;
      }
      return false;
    }
  });
  return changed;
}

/** Character length of a doc's text, used for the version-threshold heuristic (§7.8). */
export function docSize(doc: TipTapDoc | null | undefined): number {
  return doc ? JSON.stringify(doc).length : 0;
}
