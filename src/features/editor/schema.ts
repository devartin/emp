/**
 * D-07 document schema (§7.1), BlockNote-style nesting:
 *
 *   doc            := blockGroup
 *   blockGroup     := blockContainer+
 *   blockContainer := blockContent blockGroup?        attrs { id, color, bg, dir }
 *   columnList     := column{2,5}                     attrs { widths }
 *   column         := blockGroup
 *   table          := tableRow+ ; tableRow := tableCell+ ; tableCell := inline*
 *
 * The schema is the security boundary (§9.15): no generic HTML node, no script/iframe, no `on*` attributes.
 * `schemaManifest()` exports the node/mark/attr shape that a CI test compares with Rust `emp_store::doc::SCHEMA`.
 */
import { Extension, Mark, Node, mergeAttributes, type AnyExtension, type Attributes } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import HardBreak from '@tiptap/extension-hard-break';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import Strike from '@tiptap/extension-strike';
import Text from '@tiptap/extension-text';
import Underline from '@tiptap/extension-underline';
import { BLOCK_COLOR_NAMES } from './lib/blockTypes';
import { isAllowedHref } from './lib/links';
import {
  calloutView,
  codeBlockView,
  containerView,
  emojiView,
  fileView,
  headingView,
  mathInlineView,
  mentionView,
  pageLinkView,
  pageRefView,
  todoView,
  toggleView,
  tocView,
  tableView,
  columnListView,
} from './nodeviews/dom';
import { reactBlockViews } from './nodeviews/react';

export const SCHEMA_VERSION = 1;

// ───────────────────────────────────────────────────────────────────────────── attribute helpers

const isColor = (v: unknown): v is string => typeof v === 'string' && (BLOCK_COLOR_NAMES as readonly string[]).includes(v);

function plain(def: unknown): Attributes[string] {
  return { default: def, rendered: false };
}

/** JSON-valued attr carried on `data-<name>` for clipboard round-trips. */
function jsonAttr(name: string, def: unknown): Attributes[string] {
  return {
    default: def,
    parseHTML: (el) => {
      const raw = el.getAttribute(`data-${name}`);
      if (raw == null) return def;
      try {
        return JSON.parse(raw);
      } catch {
        return def;
      }
    },
    renderHTML: (attrs) => (attrs[name] == null ? {} : { [`data-${name}`]: JSON.stringify(attrs[name]) }),
  };
}

function strAttr(name: string, def: string | null): Attributes[string] {
  return {
    default: def,
    parseHTML: (el) => el.getAttribute(`data-${name}`) ?? def,
    renderHTML: (attrs) => (attrs[name] == null || attrs[name] === '' ? {} : { [`data-${name}`]: String(attrs[name]) }),
  };
}

function boolAttr(name: string, def: boolean): Attributes[string] {
  return {
    default: def,
    parseHTML: (el) => {
      const v = el.getAttribute(`data-${name}`);
      return v == null ? def : v === 'true' || v === '';
    },
    renderHTML: (attrs) => (attrs[name] ? { [`data-${name}`]: 'true' } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────── structure

export const Doc = Node.create({
  name: 'doc',
  topNode: true,
  content: 'blockGroup',
  addAttributes() {
    return { schemaVersion: plain(SCHEMA_VERSION) };
  },
});

export const BlockGroup = Node.create({
  name: 'blockGroup',
  content: 'blockContainer+',
  parseHTML() {
    return [{ tag: 'div[data-node-type="blockGroup"]', priority: 100 }];
  },
  renderHTML() {
    return ['div', { class: 'emp-group', 'data-node-type': 'blockGroup' }, 0];
  },
});

export const BlockContainer = Node.create({
  name: 'blockContainer',
  content: 'blockContent blockGroup?',
  defining: true,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-id'), renderHTML: (a) => (a.id ? { 'data-id': a.id } : {}) },
      color: {
        default: null,
        parseHTML: (el) => (isColor(el.getAttribute('data-color')) ? el.getAttribute('data-color') : null),
        renderHTML: (a) => (a.color ? { 'data-color': a.color } : {}),
      },
      bg: {
        default: null,
        parseHTML: (el) => (isColor(el.getAttribute('data-bg')) ? el.getAttribute('data-bg') : null),
        renderHTML: (a) => (a.bg ? { 'data-bg': a.bg } : {}),
      },
      dir: {
        default: 'auto',
        parseHTML: (el) => {
          const d = el.getAttribute('dir');
          return d === 'ltr' || d === 'rtl' ? d : 'auto';
        },
        renderHTML: (a) => ({ dir: a.dir ?? 'auto' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-node-type="blockContainer"]', priority: 100 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'emp-block', 'data-node-type': 'blockContainer' }, HTMLAttributes), 0];
  },
  addNodeView() {
    return containerView;
  },
});

// ───────────────────────────────────────────────────────────────────────────── text blocks

const contentAttrs = (type: string) => ({ 'data-content-type': type });

export const Paragraph = Node.create({
  name: 'paragraph',
  group: 'blockContent',
  content: 'inline*',
  parseHTML() {
    return [{ tag: 'p' }, { tag: '[data-content-type="paragraph"]' }];
  },
  renderHTML() {
    return ['p', { class: 'emp-p', ...contentAttrs('paragraph') }, 0];
  },
});

export const Heading = Node.create({
  name: 'heading',
  group: 'blockContent',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      level: {
        default: 1,
        parseHTML: (el) => {
          const fromData = Number(el.getAttribute('data-level'));
          if (fromData >= 1 && fromData <= 3) return fromData;
          const m = /^H([1-6])$/.exec(el.tagName);
          return m ? Math.min(3, Number(m[1])) : 1;
        },
        renderHTML: () => ({}),
      },
      toggle: boolAttr('toggle', false),
      collapsed: boolAttr('collapsed', false),
    };
  },
  parseHTML() {
    return [{ tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }, { tag: 'h4' }, { tag: 'h5' }, { tag: 'h6' }, { tag: '[data-content-type="heading"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [`h${node.attrs.level}`, mergeAttributes({ class: 'emp-h', 'data-level': node.attrs.level, ...contentAttrs('heading') }, HTMLAttributes), 0];
  },
  addNodeView() {
    return headingView;
  },
});

function listLike(name: string, cls: string, tagRule: string) {
  return Node.create({
    name,
    group: 'blockContent',
    content: 'inline*',
    parseHTML() {
      return [{ tag: `[data-content-type="${name}"]` }, ...(tagRule ? [{ tag: tagRule }] : [])];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ class: cls, ...contentAttrs(name) }, HTMLAttributes), 0];
    },
  });
}

export const BulletItem = listLike('bulletItem', 'emp-bullet', '');
export const NumberedItem = listLike('numberedItem', 'emp-numbered', '').extend({
  addAttributes() {
    return { start: plain(null) };
  },
});

export const TodoItem = Node.create({
  name: 'todoItem',
  group: 'blockContent',
  content: 'inline*',
  addAttributes() {
    return { checked: boolAttr('checked', false) };
  },
  parseHTML() {
    return [{ tag: '[data-content-type="todoItem"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'emp-todo', ...contentAttrs('todoItem') }, HTMLAttributes), 0];
  },
  addNodeView() {
    return todoView;
  },
});

export const Toggle = Node.create({
  name: 'toggle',
  group: 'blockContent',
  content: 'inline*',
  addAttributes() {
    return { collapsed: boolAttr('collapsed', false) };
  },
  parseHTML() {
    return [{ tag: '[data-content-type="toggle"]' }, { tag: 'summary' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'emp-toggle', ...contentAttrs('toggle') }, HTMLAttributes), 0];
  },
  addNodeView() {
    return toggleView;
  },
});

export const QuoteBlock = Node.create({
  name: 'quote',
  group: 'blockContent',
  content: 'inline*',
  parseHTML() {
    return [{ tag: '[data-content-type="quote"]' }, { tag: 'blockquote' }];
  },
  renderHTML() {
    return ['blockquote', { class: 'emp-quote', ...contentAttrs('quote') }, 0];
  },
});

export const Callout = Node.create({
  name: 'callout',
  group: 'blockContent',
  content: 'inline*',
  addAttributes() {
    return {
      icon: jsonAttr('icon', { t: 'emoji', v: '💡' }),
      color: {
        default: 'gray',
        parseHTML: (el) => (isColor(el.getAttribute('data-tone')) ? el.getAttribute('data-tone') : 'gray'),
        renderHTML: (a) => ({ 'data-tone': a.color ?? 'gray' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: '[data-content-type="callout"]' }, { tag: 'aside' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'emp-callout', ...contentAttrs('callout') }, HTMLAttributes), 0];
  },
  addNodeView() {
    return calloutView;
  },
});

export const CodeBlock = Node.create({
  name: 'codeBlock',
  group: 'blockContent',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() {
    return {
      language: {
        default: 'plain',
        parseHTML: (el) => {
          const data = el.getAttribute('data-language');
          if (data) return data;
          const cls = (el.querySelector('code')?.className || el.className || '').match(/language-([\w+#-]+)/);
          return cls ? cls[1].toLowerCase() : 'plain';
        },
        renderHTML: (a) => ({ 'data-language': a.language }),
      },
      wrap: boolAttr('wrap', false),
      caption: strAttr('caption', ''),
    };
  },
  parseHTML() {
    return [{ tag: 'pre', preserveWhitespace: 'full' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['pre', mergeAttributes({ class: 'emp-code', ...contentAttrs('codeBlock') }, HTMLAttributes), ['code', { class: `language-${node.attrs.language}` }, 0]];
  },
  addNodeView() {
    return codeBlockView;
  },
});

// ───────────────────────────────────────────────────────────────────────────── leaf blocks

function atomBlock(name: string, attrs: Record<string, Attributes[string]>, tag = 'div', extra: Partial<Parameters<typeof Node.create>[0]> = {}) {
  return Node.create({
    name,
    group: 'blockContent',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return attrs;
    },
    parseHTML() {
      return [{ tag: `[data-content-type="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes({ class: `emp-${name}`, ...contentAttrs(name) }, HTMLAttributes)];
    },
    ...extra,
  });
}

export const Divider = atomBlock('divider', {}, 'div', {
  parseHTML() {
    return [{ tag: '[data-content-type="divider"]' }, { tag: 'hr' }];
  },
  renderHTML() {
    return ['div', { class: 'emp-divider', ...contentAttrs('divider') }, ['hr']];
  },
});

export const MathBlock = atomBlock('mathBlock', { latex: strAttr('latex', '') });
export const PageRef = atomBlock('pageRef', { pageId: strAttr('page-id', null) }, 'div', {
  addNodeView() {
    return pageRefView;
  },
});
export const PageLink = atomBlock('pageLink', { pageId: strAttr('page-id', null) }, 'div', {
  addNodeView() {
    return pageLinkView;
  },
});
export const ImageBlock = atomBlock('image', {
  assetId: strAttr('asset-id', null),
  width: jsonAttr('width', null),
  align: strAttr('align', 'center'),
  caption: strAttr('caption', ''),
  /** Pending source (data: URI or a remote https URL) until it is stored as an asset (§9.15). */
  pendingUrl: strAttr('pending-url', null),
}, 'figure', {
  parseHTML() {
    return [
      { tag: '[data-content-type="image"]' },
      {
        tag: 'img[src]',
        getAttrs: (el) => {
          const src = (el as HTMLElement).getAttribute('src') ?? '';
          if (!/^(https?:|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(src)) return false;
          return { pendingUrl: src, caption: (el as HTMLElement).getAttribute('alt') ?? '' };
        },
      },
    ];
  },
});
export const FileBlock = atomBlock('file', { assetId: strAttr('asset-id', null) }, 'div', {
  addNodeView() {
    return fileView;
  },
});
export const Toc = atomBlock('toc', {}, 'nav', {
  addNodeView() {
    return tocView;
  },
});
export const DatabaseView = atomBlock('databaseView', {
  databaseId: strAttr('database-id', null),
  viewId: strAttr('view-id', null),
  linked: boolAttr('linked', false),
  height: jsonAttr('height', null),
});
export const ChartBlock = atomBlock('chart', { source: jsonAttr('source', null), spec: jsonAttr('spec', null) });
export const KpiBlock = atomBlock('kpi', {
  source: jsonAttr('source', null),
  agg: strAttr('agg', 'sum'),
  label: strAttr('label', ''),
  format: strAttr('format', 'number'),
});
export const SheetEmbedBlock = atomBlock('sheetEmbed', {
  workbookId: strAttr('workbook-id', null),
  sheetId: strAttr('sheet-id', null),
  range: strAttr('range', ''),
});
export const WatchlistBlockNode = atomBlock('watchlist', { watchlistId: strAttr('watchlist-id', null) });

// ───────────────────────────────────────────────────────────────────────────── table & columns

export const Table = Node.create({
  name: 'table',
  group: 'blockContent',
  content: 'tableRow+',
  isolating: true,
  addAttributes() {
    return {
      headerRow: boolAttr('header-row', true),
      headerCol: boolAttr('header-col', false),
      colWidths: jsonAttr('col-widths', []),
      cellColors: jsonAttr('cell-colors', {}),
    };
  },
  parseHTML() {
    return [
      { tag: '[data-content-type="table"]' },
      {
        tag: 'table',
        getAttrs: (el) => ({ headerRow: !!(el as HTMLElement).querySelector('tr:first-child th, thead'), headerCol: false }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['table', mergeAttributes({ class: 'emp-table', ...contentAttrs('table') }, HTMLAttributes), ['tbody', 0]];
  },
  addNodeView() {
    return tableView;
  },
});

export const TableRow = Node.create({
  name: 'tableRow',
  content: 'tableCell+',
  parseHTML() {
    return [{ tag: 'tr' }];
  },
  renderHTML() {
    return ['tr', 0];
  },
});

export const TableCell = Node.create({
  name: 'tableCell',
  content: 'inline*',
  isolating: true,
  parseHTML() {
    return [{ tag: 'td' }, { tag: 'th' }];
  },
  renderHTML() {
    return ['td', 0];
  },
});

export const ColumnList = Node.create({
  name: 'columnList',
  group: 'blockContent',
  content: 'column{2,5}',
  isolating: true,
  addAttributes() {
    return { widths: jsonAttr('widths', [0.5, 0.5]) };
  },
  parseHTML() {
    return [{ tag: '[data-content-type="columnList"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'emp-columns', ...contentAttrs('columnList') }, HTMLAttributes), 0];
  },
  addNodeView() {
    return columnListView;
  },
});

export const Column = Node.create({
  name: 'column',
  content: 'blockGroup',
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-node-type="column"]' }];
  },
  renderHTML() {
    return ['div', { class: 'emp-column', 'data-node-type': 'column' }, 0];
  },
});

// ───────────────────────────────────────────────────────────────────────────── inline nodes

export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: strAttr('kind', 'page'),
      pageId: strAttr('page-id', null),
      date: jsonAttr('date', null),
      reminderId: strAttr('reminder-id', null),
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'emp-mention', 'data-mention': '' }, HTMLAttributes)];
  },
  renderText({ node }) {
    if (node.attrs.kind === 'date') return String((node.attrs.date as { start?: string } | null)?.start ?? '');
    return '@page';
  },
  addNodeView() {
    return mentionView;
  },
});

export const Emoji = Node.create({
  name: 'emoji',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { native: strAttr('native', ''), shortcode: strAttr('shortcode', '') };
  },
  parseHTML() {
    return [{ tag: 'span[data-emoji]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'emp-emoji', 'data-emoji': '' }, HTMLAttributes), String(node.attrs.native ?? '')];
  },
  renderText({ node }) {
    return String(node.attrs.native ?? '');
  },
  addNodeView() {
    return emojiView;
  },
});

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: strAttr('latex', '') };
  },
  parseHTML() {
    return [{ tag: 'span[data-math-inline]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'emp-math-inline', 'data-math-inline': '' }, HTMLAttributes)];
  },
  renderText({ node }) {
    return `$${String(node.attrs.latex ?? '')}$`;
  },
  addNodeView() {
    return mathInlineView;
  },
});

export const Break = HardBreak.extend({
  addKeyboardShortcuts() {
    return { 'Shift-Enter': () => this.editor.commands.setHardBreak() };
  },
});

// ───────────────────────────────────────────────────────────────────────────── marks

export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => (isColor(el.getAttribute('data-color')) ? el.getAttribute('data-color') : null),
        renderHTML: (a) => (a.color ? { 'data-color': a.color } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-text-color]', getAttrs: (el) => (isColor((el as HTMLElement).getAttribute('data-color')) ? null : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'emp-tc', 'data-text-color': '' }, HTMLAttributes), 0];
  },
});

export const Highlight = Mark.create({
  name: 'highlight',
  addAttributes() {
    return {
      color: {
        default: 'yellow',
        parseHTML: (el) => (isColor(el.getAttribute('data-bg')) ? el.getAttribute('data-bg') : 'yellow'),
        renderHTML: (a) => ({ 'data-bg': a.color ?? 'yellow' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'mark' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes({ class: 'emp-hl' }, HTMLAttributes), 0];
  },
});

export const SafeLink = Link.extend({
  inclusive: false,
  addAttributes() {
    return { href: { default: null, parseHTML: (el) => el.getAttribute('href') } };
  },
  renderHTML({ HTMLAttributes }) {
    const href = typeof HTMLAttributes.href === 'string' && isAllowedHref(HTMLAttributes.href) ? HTMLAttributes.href : null;
    return ['a', { href, rel: 'noopener noreferrer nofollow', class: 'emp-link' }, 0];
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: false,
  defaultProtocol: 'https',
  isAllowedUri: (url) => isAllowedHref(url),
  shouldAutoLink: (url) => isAllowedHref(/^(https?:|mailto:)/i.test(url) ? url : `https://${url}`),
});

/** Strike with the spec's `~x~` rule instead of `~~x~~` (input rules live in extensions/inputRules.ts). */
export const StrikeMark = Strike.extend({
  addInputRules() {
    return [];
  },
  addPasteRules() {
    return [];
  },
});

// ───────────────────────────────────────────────────────────────────────────── bundles

export const STRUCTURE_NODES: AnyExtension[] = [Doc, BlockGroup, BlockContainer];
export const CONTENT_NODES: AnyExtension[] = [
  Paragraph, Heading, BulletItem, NumberedItem, TodoItem, Toggle, QuoteBlock, Callout, CodeBlock, Divider, MathBlock, PageRef, PageLink,
  ImageBlock, FileBlock, Toc, DatabaseView, ChartBlock, KpiBlock, SheetEmbedBlock, WatchlistBlockNode, Table, TableRow, TableCell, ColumnList,
  Column,
];
export const INLINE_NODES: AnyExtension[] = [Text, Break, Mention, Emoji, MathInline];
export const MARKS: AnyExtension[] = [Bold, Italic, Underline, StrikeMark, Code, SafeLink, TextColor, Highlight];

/** React node views (databaseView, chart, kpi, sheetEmbed, watchlist, image, mathBlock — §7.1) are attached here. */
const ReactViews = Extension.create({ name: 'empReactViews' });

export function schemaExtensions(): AnyExtension[] {
  return [...STRUCTURE_NODES, ...reactBlockViews(CONTENT_NODES), ...INLINE_NODES, ...MARKS, ReactViews];
}

/** Manifest compared against Rust `emp_store::doc::SCHEMA` in CI (§7.1). */
export function schemaManifest(): { version: number; nodes: Record<string, { content?: string; group?: string; attrs: string[] }>; marks: Record<string, { attrs: string[] }> } {
  const nodes: Record<string, { content?: string; group?: string; attrs: string[] }> = {
    doc: { content: 'blockGroup', attrs: ['schemaVersion'] },
    blockGroup: { content: 'blockContainer+', attrs: [] },
    blockContainer: { content: 'blockContent blockGroup?', attrs: ['id', 'color', 'bg', 'dir'] },
    paragraph: { content: 'inline*', group: 'blockContent', attrs: [] },
    heading: { content: 'inline*', group: 'blockContent', attrs: ['level', 'toggle', 'collapsed'] },
    bulletItem: { content: 'inline*', group: 'blockContent', attrs: [] },
    numberedItem: { content: 'inline*', group: 'blockContent', attrs: ['start'] },
    todoItem: { content: 'inline*', group: 'blockContent', attrs: ['checked'] },
    toggle: { content: 'inline*', group: 'blockContent', attrs: ['collapsed'] },
    quote: { content: 'inline*', group: 'blockContent', attrs: [] },
    callout: { content: 'inline*', group: 'blockContent', attrs: ['icon', 'color'] },
    codeBlock: { content: 'text*', group: 'blockContent', attrs: ['language', 'wrap', 'caption'] },
    divider: { group: 'blockContent', attrs: [] },
    mathBlock: { group: 'blockContent', attrs: ['latex'] },
    table: { content: 'tableRow+', group: 'blockContent', attrs: ['headerRow', 'headerCol', 'colWidths', 'cellColors'] },
    tableRow: { content: 'tableCell+', attrs: [] },
    tableCell: { content: 'inline*', attrs: [] },
    columnList: { content: 'column{2,5}', group: 'blockContent', attrs: ['widths'] },
    column: { content: 'blockGroup', attrs: [] },
    pageRef: { group: 'blockContent', attrs: ['pageId'] },
    pageLink: { group: 'blockContent', attrs: ['pageId'] },
    image: { group: 'blockContent', attrs: ['assetId', 'width', 'align', 'caption', 'pendingUrl'] },
    file: { group: 'blockContent', attrs: ['assetId'] },
    toc: { group: 'blockContent', attrs: [] },
    databaseView: { group: 'blockContent', attrs: ['databaseId', 'viewId', 'linked', 'height'] },
    chart: { group: 'blockContent', attrs: ['source', 'spec'] },
    kpi: { group: 'blockContent', attrs: ['source', 'agg', 'label', 'format'] },
    sheetEmbed: { group: 'blockContent', attrs: ['workbookId', 'sheetId', 'range'] },
    watchlist: { group: 'blockContent', attrs: ['watchlistId'] },
    text: { group: 'inline', attrs: [] },
    hardBreak: { group: 'inline', attrs: [] },
    mention: { group: 'inline', attrs: ['kind', 'pageId', 'date', 'reminderId'] },
    emoji: { group: 'inline', attrs: ['native', 'shortcode'] },
    mathInline: { group: 'inline', attrs: ['latex'] },
  };
  const marks: Record<string, { attrs: string[] }> = {
    bold: { attrs: [] },
    italic: { attrs: [] },
    underline: { attrs: [] },
    strike: { attrs: [] },
    code: { attrs: [] },
    link: { attrs: ['href'] },
    textColor: { attrs: ['color'] },
    highlight: { attrs: ['color'] },
  };
  return { version: SCHEMA_VERSION, nodes, marks };
}
