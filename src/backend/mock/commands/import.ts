/**
 * import_detect / import_markdown / import_notion / import_undo (§17.4, §17.5, §9.16) for the browser preview.
 *
 * - Detection is by name first (so CSV/XLSX/ICS grants stay unread for the importers that own them) and by content
 *   for zips: a Notion export is recognised by its 32-hex id suffixes; anything else with .md files is a folder.
 * - Markdown → EMP blocks: front matter (callout), headings, nested lists and to-dos, quotes and `> [!note]` callouts,
 *   fenced code (keeps the language; `emp-block` fences restore EMP blocks losslessly), `$$` math, GFM tables,
 *   images, `[[Wikilinks]]` / `[[Page|alias]]` → mentions resolved in pass 2, `#tags` → a "Tags" line.
 * - Notion zips (nested Part-N.zip, limits from §9.16): HTML is preferred when present (details → toggle, aside →
 *   callout, column-list → columns, block colours, equations), databases come from CSV (preferring `_all.csv`) with
 *   inferred property types and row bodies from the sibling folder, attachments become assets, links between pages
 *   become mentions (unresolved ones are reported). The whole import is one `import_undo` unit.
 */
import { BackendError } from '../../errors';
import type { BlockColor, CellValue, Id, ImportKind, PropType, TipTapDoc, TipTapNode } from '../../types';
import type { GrantsService, MockCallCtx, MockCtx, MockHandlers } from '../ctx';
import { b, makeDoc, SCHEMA_VERSION } from '../lib/doc';
import { iconOf, lucide } from '../lib/icons';
import type { DbApi } from './db';
import { inferType, parseBool, parseCsv, parseDateInput, parseNumber } from '@/features/databases/engine/csv';
import { unzip } from '@/features/sheets/engine/xlsx';

const MAX_ENTRIES = 10_000;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_MD_BYTES = 20 * 1024 * 1024;
const NOTION_ID = /\s?([0-9a-f]{32})$/i;

// ───────────────────────────────────────────────────────────────────────────── grant bookkeeping

interface GrantMeta {
  displayName: string;
  size: number;
}

/** grantId → name/size (recorded when the grant is created) and files we had to read to detect. */
const grantMeta = new WeakMap<object, Map<Id, GrantMeta>>();
const readCache = new WeakMap<object, Map<Id, File>>();
const metaOf = (ctx: MockCtx) => {
  let m = grantMeta.get(ctx.db);
  if (!m) grantMeta.set(ctx.db, (m = new Map()));
  return m;
};
const cacheOf = (ctx: MockCtx) => {
  let m = readCache.get(ctx.db);
  if (!m) readCache.set(ctx.db, (m = new Map()));
  return m;
};

/** Read a grant once; detection may already have consumed it. */
function fileFor(ctx: MockCtx, grantId: Id): File {
  const cached = cacheOf(ctx).get(grantId);
  if (cached) {
    cacheOf(ctx).delete(grantId);
    return cached;
  }
  return ctx.grants.read(grantId);
}

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

// ───────────────────────────────────────────────────────────────────────────── import records (undo)

interface ImportRecord {
  id: Id; // job id
  kind: 'markdown' | 'notion';
  at: number;
  workspaceId: Id;
  /** Top-level pages created by the import (purging them removes every descendant). */
  rootIds: Id[];
  pageIds: Id[];
  assetIds: Id[];
}

const imports = (ctx: MockCtx) => ctx.db.table<ImportRecord>('imports');

function jobIdOf(ctx: MockCallCtx): Id {
  for (const j of ctx.jobs.values()) if (j.controller.signal === ctx.signal) return j.jobId;
  return ctx.id();
}

// ───────────────────────────────────────────────────────────────────────────── inline markdown

type Mark = NonNullable<TipTapNode['marks']>[number];

export interface MdContext {
  /** Resolve `[[Title]]` or a relative link to a page id (pass 2). */
  resolvePage?: (target: string) => Id | undefined;
  /** Resolve an image path to an asset id. */
  resolveAsset?: (path: string) => Id | undefined;
  tags?: Set<string>;
  unresolved?: { title: string; ref: string }[];
}

const addMark = (nodes: TipTapNode[], m: Mark): TipTapNode[] =>
  nodes.map((n) => (n.type === 'text' ? { ...n, marks: [...(n.marks ?? []), m] } : n));

const INLINE = [
  { re: /`([^`]+)`/, make: (m: RegExpExecArray): TipTapNode[] => [{ type: 'text', text: m[1], marks: [{ type: 'code' }] }] },
  { re: /\$([^$\s][^$]*?)\$/, make: (m: RegExpExecArray): TipTapNode[] => [{ type: 'mathInline', attrs: { latex: m[1] } }] },
  { re: /!\[\[([^\]]+)\]\]/, make: (m: RegExpExecArray): TipTapNode[] => [{ type: 'text', text: m[1] }] },
  { re: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/, make: null },
  { re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, make: null },
  { re: /<(https?:\/\/[^>\s]+)>/, make: (m: RegExpExecArray): TipTapNode[] => [{ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[1] } }] }] },
  { re: /\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*|__([^_]+)__/, make: null },
  { re: /~~([^~]+)~~/, make: null },
  { re: /(?<![\w*])\*([^*\s][^*]*?)\*(?!\*)|(?<![\w_])_([^_\s][^_]*?)_(?![\w_])/, make: null },
  { re: /==([^=]+)==/, make: null },
] as const;

function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  return null;
}

export function parseInline(src: string, cx: MdContext = {}): TipTapNode[] {
  const out: TipTapNode[] = [];
  let rest = src;
  while (rest.length) {
    let best: { idx: number; m: RegExpExecArray; k: number } | null = null;
    INLINE.forEach((p, k) => {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, m, k };
    });
    if (!best) {
      out.push({ type: 'text', text: rest });
      break;
    }
    const { idx, m, k } = best as { idx: number; m: RegExpExecArray; k: number };
    if (idx > 0) out.push({ type: 'text', text: rest.slice(0, idx) });
    const p = INLINE[k];
    if (p.make) out.push(...p.make(m));
    else if (k === 3) {
      const target = m[1].trim();
      const alias = m[2]?.trim();
      const id = cx.resolvePage?.(target);
      if (id) out.push({ type: 'mention', attrs: { kind: 'page', pageId: id, ...(alias ? { label: alias } : {}) } });
      else {
        cx.unresolved?.push({ title: alias ?? target, ref: target });
        out.push({ type: 'text', text: alias ?? target });
      }
    } else if (k === 4) {
      const label = parseInline(m[1], cx);
      const href = decodeURI(m[2]);
      const pageId = !/^[a-z]+:/i.test(href) ? cx.resolvePage?.(href) : undefined;
      if (pageId) out.push({ type: 'mention', attrs: { kind: 'page', pageId } });
      else {
        const safe = safeHref(href);
        if (safe) out.push(...addMark(label, { type: 'link', attrs: { href: safe } }));
        else {
          if (/\.(md|html)$/i.test(href)) cx.unresolved?.push({ title: m[1], ref: href });
          out.push(...label);
        }
      }
    } else if (k === 6) out.push(...addMark(parseInline(m[1] ?? m[2], cx), { type: 'bold' }));
    else if (k === 7) out.push(...addMark(parseInline(m[1], cx), { type: 'strike' }));
    else if (k === 8) out.push(...addMark(parseInline(m[1] ?? m[2], cx), { type: 'italic' }));
    else if (k === 9) out.push(...addMark(parseInline(m[1], cx), { type: 'highlight', attrs: { color: 'yellow' } }));
    rest = rest.slice(idx + m[0].length);
  }
  if (cx.tags) for (const t of src.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_/-]*)/gu)) cx.tags.add(t[1]);
  // merge adjacent plain text
  const merged: TipTapNode[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'text' && n.type === 'text' && !prev.marks && !n.marks) prev.text = (prev.text ?? '') + (n.text ?? '');
    else if (n.type !== 'text' || n.text) merged.push(n);
  }
  return merged;
}

// ───────────────────────────────────────────────────────────────────────────── block markdown

/** Alert/callout kinds → Lucide icons (no emoji; same names the Rust importer uses for GitHub alerts). */
const CALLOUT_ICON: Record<string, string> = {
  note: 'info', info: 'info', tip: 'lightbulb', hint: 'lightbulb', important: 'circle-alert', warning: 'triangle-alert', caution: 'octagon-x', danger: 'siren',
  success: 'circle-check', question: 'circle-help', example: 'paperclip', quote: 'message-circle', abstract: 'clipboard-list', todo: 'square-check', bug: 'bug',
};
const CALLOUT_TONE: Record<string, BlockColor> = {
  note: 'blue', info: 'blue', tip: 'green', hint: 'green', important: 'purple', warning: 'yellow', caution: 'orange',
  danger: 'red', success: 'green', question: 'yellow', example: 'gray', quote: 'gray', abstract: 'gray', todo: 'blue', bug: 'red',
};

interface ListFrame {
  indent: number;
  node: TipTapNode;
}

function withChildren(node: TipTapNode, child: TipTapNode): void {
  const content = node.content ?? (node.content = []);
  const group = content[1];
  if (group && group.type === 'blockGroup') (group.content ?? (group.content = [])).push(child);
  else content.push({ type: 'blockGroup', content: [child] });
}

function regenerateBlockIds(node: TipTapNode, gen: () => string): TipTapNode {
  const copy = structuredClone(node);
  const walk = (n: TipTapNode) => {
    if (n.type === 'blockContainer') n.attrs = { ...(n.attrs ?? {}), id: gen() };
    n.content?.forEach(walk);
  };
  walk(copy);
  return copy;
}

export interface ParsedMarkdown {
  title?: string;
  frontMatter?: Record<string, string>;
  blocks: TipTapNode[];
}

/** Markdown → blockContainers. `title` is the first H1 when `takeTitle`. */
export function parseMarkdown(md: string, cx: MdContext = {}, opts: { takeTitle?: boolean; blockId?: () => string } = {}): ParsedMarkdown {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: TipTapNode[] = [];
  const out: ParsedMarkdown = { blocks };
  let i = 0;

  // front matter
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) {
      const fm: Record<string, string> = {};
      for (const l of lines.slice(1, end)) {
        const m = /^([\w .-]+):\s*(.*)$/.exec(l);
        if (m) fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
      out.frontMatter = fm;
      if (fm.title) out.title = fm.title;
      i = end + 1;
    }
  }

  let list: ListFrame[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join('\n').trim();
    para = [];
    if (!text) return;
    const content = parseInline(text.replace(/ {2,}\n/g, '\n'), cx).flatMap((n) => {
      if (n.type !== 'text' || !n.text?.includes('\n')) return [n];
      const parts = n.text.split('\n');
      return parts.flatMap((p, k) => [...(k ? [{ type: 'hardBreak' } as TipTapNode] : []), ...(p ? [{ ...n, text: p }] : [])]);
    });
    blocks.push(b.p(content));
  };
  const push = (node: TipTapNode) => {
    flushPara();
    list = [];
    blocks.push(node);
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // fenced code (and lossless emp-block fences)
    const fence = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[2];
      const lang = fence[3] || 'plain';
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(close); i++) body.push(lines[i].slice(Math.min(fence[1].length, lines[i].length - lines[i].trimStart().length)));
      if (lang === 'emp-block') {
        try {
          const node = JSON.parse(body.join('\n')) as TipTapNode;
          if (node && node.type === 'blockContainer') {
            push(opts.blockId ? regenerateBlockIds(node, opts.blockId) : node);
            continue;
          }
        } catch {
          /* fall back to a code block */
        }
      }
      push(b.code(body.join('\n'), lang.toLowerCase()));
      continue;
    }

    // $$ math
    if (trimmed.startsWith('$$')) {
      const one = /^\$\$(.+)\$\$$/.exec(trimmed);
      if (one) {
        push(b.math(one[1].trim()));
        continue;
      }
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('$$'); i++) body.push(lines[i]);
      push(b.math(body.join('\n').trim()));
      continue;
    }

    if (!trimmed) {
      flushPara();
      list = [];
      continue;
    }

    // headings
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (h) {
      const level = Math.min(3, h[1].length) as 1 | 2 | 3;
      if (opts.takeTitle && level === 1 && out.title === undefined && !blocks.length && !para.length) {
        out.title = h[2];
        continue;
      }
      const inl = parseInline(h[2], cx);
      push(level === 1 ? b.h1(inl) : level === 2 ? b.h2(inl) : b.h3(inl));
      continue;
    }

    // divider
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(trimmed)) {
      push(b.divider());
      continue;
    }

    // block quote / callout
    if (trimmed.startsWith('>')) {
      const quoted: string[] = [];
      for (; i < lines.length && lines[i].trim().startsWith('>'); i++) quoted.push(lines[i].trim().replace(/^>\s?/, ''));
      i--;
      const call = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(quoted[0] ?? '');
      if (call) {
        const kind = call[1].toLowerCase();
        const text = [call[2], ...quoted.slice(1)].filter(Boolean).join('\n');
        push(b.callout(parseInline(text, cx), { icon: lucide(CALLOUT_ICON[kind] ?? 'lightbulb'), tone: CALLOUT_TONE[kind] ?? 'gray' }));
      } else push(b.quote(parseInline(quoted.join('\n'), cx)));
      continue;
    }

    // table
    if (trimmed.startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const rows: string[][] = [cells(line)];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
      i--;
      const width = Math.max(...rows.map((r) => r.length));
      push(b.table(rows.map((r) => Array.from({ length: width }, (_, c) => parseInline(r[c] ?? '', cx)))));
      continue;
    }

    // standalone image
    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(trimmed) ?? /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(trimmed);
    if (img) {
      const path = decodeURI(img[2] ?? img[1]);
      const assetId = cx.resolveAsset?.(path);
      if (assetId) push(b.image(assetId, { caption: img[2] ? img[1] : '' }));
      else {
        const href = safeHref(path);
        push(b.p(href ? [{ type: 'text', text: img[1] || path, marks: [{ type: 'link', attrs: { href } }] }] : [{ type: 'text', text: `Image: ${img[1] || path}` }]));
      }
      continue;
    }

    // lists
    const li = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, '    ').length;
      const inl = parseInline(li[4], cx);
      const node = li[3] ? b.todo(inl, /x/i.test(li[3])) : /\d/.test(li[2]) ? b.numbered(inl) : b.bullet(inl);
      while (list.length && list[list.length - 1].indent >= indent) list.pop();
      if (list.length) withChildren(list[list.length - 1].node, node);
      else blocks.push(node);
      list.push({ indent, node });
      continue;
    }
    // continuation of a list item
    if (list.length && /^\s{2,}\S/.test(line) && !para.length) {
      const last = list[list.length - 1].node.content?.[0];
      if (last) last.content = [...(last.content ?? []), { type: 'hardBreak' }, ...parseInline(trimmed, cx)];
      continue;
    }

    list = [];
    para.push(line);
  }
  flushPara();
  if (cx.tags?.size) blocks.push(b.p([{ type: 'text', text: 'Tags: ', marks: [{ type: 'bold' }] }, { type: 'text', text: Array.from(cx.tags).map((t) => `#${t}`).join(' ') }]));
  if (out.frontMatter && Object.keys(out.frontMatter).length) {
    const text = Object.entries(out.frontMatter)
      .filter(([k]) => k !== 'title')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    if (text) blocks.unshift(b.callout([{ type: 'text', text }], { icon: lucide('clipboard-list'), tone: 'gray' }));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── Notion HTML

const NOTION_COLORS: Record<string, BlockColor> = {
  gray: 'gray', brown: 'brown', orange: 'orange', yellow: 'yellow', teal: 'green', green: 'green', blue: 'blue',
  purple: 'purple', pink: 'pink', red: 'red',
};

function colorFromClass(cls: string): { color?: BlockColor; bg?: BlockColor } {
  const m = /(?:block-color|highlight)-(\w+?)(_background)?(?:\s|$)/.exec(cls);
  if (!m) return {};
  const c = NOTION_COLORS[m[1]];
  if (!c) return {};
  return m[2] ? { bg: c } : { color: c };
}

interface HtmlCx extends MdContext {
  baseDir: string;
  /** href → page id */
  linkTarget: (href: string) => Id | undefined;
  assetFor: (src: string) => Id | undefined;
  unsupported: Map<string, number>;
}

function htmlInline(node: Node, cx: HtmlCx, marks: Mark[] = []): TipTapNode[] {
  const out: TipTapNode[] = [];
  node.childNodes.forEach((ch) => {
    if (ch.nodeType === 3) {
      const t = (ch.textContent ?? '').replace(/\s+/g, ' ');
      if (t) out.push(marks.length ? { type: 'text', text: t, marks: [...marks] } : { type: 'text', text: t });
      return;
    }
    if (ch.nodeType !== 1) return;
    const el = ch as Element;
    const tag = el.tagName.toLowerCase();
    const cls = el.getAttribute('class') ?? '';
    if (tag === 'br') return void out.push({ type: 'hardBreak' });
    if (cls.includes('notion-text-equation-token') || tag === 'math') {
      const tex = el.querySelector('annotation')?.textContent ?? el.textContent ?? '';
      return void out.push({ type: 'mathInline', attrs: { latex: tex.trim() } });
    }
    if (tag === 'img') {
      const alt = el.getAttribute('alt') ?? '';
      if (alt) out.push({ type: 'text', text: alt });
      return;
    }
    if (tag === 'style' || tag === 'script') return;
    let next = marks;
    if (tag === 'strong' || tag === 'b') next = [...next, { type: 'bold' }];
    else if (tag === 'em' || tag === 'i') next = [...next, { type: 'italic' }];
    else if (tag === 'u') next = [...next, { type: 'underline' }];
    else if (tag === 's' || tag === 'del' || tag === 'strike') next = [...next, { type: 'strike' }];
    else if (tag === 'code') next = [...next, { type: 'code' }];
    else if (tag === 'mark') next = [...next, { type: 'highlight', attrs: { color: 'yellow' } }];
    else if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      const target = cx.linkTarget(href);
      if (target) return void out.push({ type: 'mention', attrs: { kind: 'page', pageId: target } });
      const safe = safeHref(href);
      if (safe) next = [...next, { type: 'link', attrs: { href: safe } }];
      else if (/\.(md|html)(#.*)?$/i.test(href)) cx.unresolved?.push({ title: (el.textContent ?? '').trim() || href, ref: decodeURIComponent(href) });
    }
    if (tag === 'span' && cls) {
      const c = colorFromClass(cls);
      if (c.color) next = [...next, { type: 'textColor', attrs: { color: c.color } }];
      if (c.bg) next = [...next, { type: 'highlight', attrs: { color: c.bg } }];
    }
    out.push(...htmlInline(el, cx, next));
  });
  return out;
}

function trimInline(nodes: TipTapNode[]): TipTapNode[] {
  const out = nodes.slice();
  while (out[0]?.type === 'text' && !out[0].text?.trim()) out.shift();
  while (out.length && out[out.length - 1].type === 'text' && !out[out.length - 1].text?.trim()) out.pop();
  if (out[0]?.type === 'text') out[0] = { ...out[0], text: out[0].text?.replace(/^\s+/, '') };
  const last = out[out.length - 1];
  if (last?.type === 'text') out[out.length - 1] = { ...last, text: last.text?.replace(/\s+$/, '') };
  return out;
}

/** Inline content of an element, excluding nested block children (lists, details). */
function ownInline(el: Element, cx: HtmlCx): TipTapNode[] {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(':scope > ul, :scope > ol, :scope > details, :scope > div, :scope > figure').forEach((n) => n.remove());
  return trimInline(htmlInline(clone, cx));
}

function nestedBlocks(el: Element, cx: HtmlCx): TipTapNode[] {
  const out: TipTapNode[] = [];
  el.querySelectorAll(':scope > ul, :scope > ol, :scope > div, :scope > figure, :scope > details').forEach((c) => out.push(...htmlBlocks(c, cx)));
  return out;
}

function htmlBlocks(el: Element, cx: HtmlCx): TipTapNode[] {
  const tag = el.tagName.toLowerCase();
  const cls = el.getAttribute('class') ?? '';
  const colors = colorFromClass(cls);
  const opts = { color: colors.color ?? null, bg: colors.bg ?? null };
  const kids = (): TipTapNode[] => Array.from(el.children).flatMap((c) => htmlBlocks(c, cx));
  switch (tag) {
    case 'h1':
      return [b.h1(trimInline(htmlInline(el, cx)), opts)];
    case 'h2':
      return [b.h2(trimInline(htmlInline(el, cx)), opts)];
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return [b.h3(trimInline(htmlInline(el, cx)), opts)];
    case 'p': {
      const inl = trimInline(htmlInline(el, cx));
      return inl.length ? [b.p(inl, opts)] : [];
    }
    case 'hr':
      return [b.divider()];
    case 'blockquote':
      return [b.quote(trimInline(htmlInline(el, cx)), opts)];
    case 'pre': {
      const code = el.querySelector('code') ?? el;
      const lang = /language-([\w+#-]+)/.exec(code.getAttribute('class') ?? '')?.[1] ?? 'plain';
      return [b.code(code.textContent ?? '', lang.toLowerCase())];
    }
    case 'ul':
    case 'ol': {
      const todo = cls.includes('to-do-list');
      const toggle = cls.includes('toggle');
      return Array.from(el.children)
        .filter((c) => c.tagName.toLowerCase() === 'li')
        .map((li) => {
          const details = li.querySelector(':scope > details');
          if (toggle && details) return htmlBlocks(details, cx)[0];
          const children = nestedBlocks(li, cx);
          const liColors = colorFromClass(li.getAttribute('class') ?? '');
          const o = { color: liColors.color ?? opts.color, bg: liColors.bg ?? opts.bg, children };
          const inl = ownInline(li, cx);
          if (todo) {
            const checked = !!li.querySelector('.checkbox-on, input[checked]');
            return b.todo(inl, checked, o);
          }
          return tag === 'ol' ? b.numbered(inl, o) : b.bullet(inl, o);
        })
        .filter(Boolean) as TipTapNode[];
    }
    case 'details': {
      const summary = el.querySelector(':scope > summary');
      const children = Array.from(el.children)
        .filter((c) => c.tagName.toLowerCase() !== 'summary')
        .flatMap((c) => htmlBlocks(c, cx));
      return [b.toggle(summary ? trimInline(htmlInline(summary, cx)) : [], { ...opts, children, collapsed: true })];
    }
    case 'aside': {
      const iconEl = el.querySelector('.icon');
      // Notion's callout emoji → its Lucide icon (unmapped: the default lightbulb).
      const icon = iconOf(iconEl?.textContent) ?? lucide('lightbulb');
      iconEl?.closest('div,span')?.remove();
      const body = el.querySelector(':scope > div:last-child') ?? el;
      return [b.callout(trimInline(htmlInline(body, cx)), { icon, tone: colors.bg ?? colors.color ?? 'gray' })];
    }
    case 'figure': {
      if (cls.includes('callout')) {
        const iconEl = el.querySelector('.icon');
        const icon = iconOf(iconEl?.textContent) ?? lucide('lightbulb');
        const parts = Array.from(el.children);
        const body = parts.find((c) => !c.querySelector('.icon') && !c.classList.contains('icon')) ?? parts[parts.length - 1] ?? el;
        return [b.callout(trimInline(htmlInline(body, cx)), { icon, tone: colors.bg ?? colors.color ?? 'gray' })];
      }
      if (cls.includes('equation')) {
        const tex = el.querySelector('annotation')?.textContent ?? el.textContent ?? '';
        return [b.math(tex.trim())];
      }
      if (cls.includes('link-to-page')) {
        const a = el.querySelector('a');
        const target = a ? cx.linkTarget(a.getAttribute('href') ?? '') : undefined;
        if (target) return [b.pageLink(target)];
        if (a) cx.unresolved?.push({ title: (a.textContent ?? '').trim(), ref: decodeURIComponent(a.getAttribute('href') ?? '') });
        return a ? [b.p(trimInline(htmlInline(a, cx)))] : [];
      }
      const img = el.querySelector('img');
      if (img) {
        const caption = (el.querySelector('figcaption')?.textContent ?? '').trim();
        const src = img.getAttribute('src') ?? '';
        const assetId = cx.assetFor(src);
        if (assetId) return [b.image(assetId, { caption })];
        const href = safeHref(src);
        return [b.p(href ? [{ type: 'text', text: caption || href, marks: [{ type: 'link', attrs: { href } }] }] : [{ type: 'text', text: `Image: ${caption || decodeURIComponent(src)}` }])];
      }
      const a = el.querySelector('a');
      if (a) {
        if (cls.includes('bookmark') || cls.includes('embed')) cx.unsupported.set('Embeds (kept as links)', (cx.unsupported.get('Embeds (kept as links)') ?? 0) + (cls.includes('embed') ? 1 : 0));
        const href = safeHref(a.getAttribute('href') ?? '');
        const text = (a.querySelector('.bookmark-title')?.textContent ?? a.textContent ?? '').trim();
        return href ? [b.p([{ type: 'text', text: text || href, marks: [{ type: 'link', attrs: { href } }] }])] : [];
      }
      return kids();
    }
    case 'img': {
      const assetId = cx.assetFor(el.getAttribute('src') ?? '');
      return assetId ? [b.image(assetId)] : [];
    }
    case 'table': {
      const rows = Array.from(el.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((td) => trimInline(htmlInline(td, cx))));
      if (!rows.length) return [];
      const width = Math.max(...rows.map((r) => r.length));
      return [b.table(rows.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? [])), { headerRow: !!el.querySelector('thead') || cls.includes('simple-table-header') })];
    }
    case 'iframe':
    case 'video':
    case 'audio':
    case 'embed':
    case 'object': {
      cx.unsupported.set('Embeds (kept as links)', (cx.unsupported.get('Embeds (kept as links)') ?? 0) + 1);
      const href = safeHref(el.getAttribute('src') ?? '');
      return href ? [b.p([{ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }])] : [];
    }
    case 'div': {
      if (cls.includes('column-list')) {
        const cols = Array.from(el.children)
          .filter((c) => (c.getAttribute('class') ?? '').includes('column'))
          .map((c) => Array.from(c.children).flatMap((x) => htmlBlocks(x, cx)));
        if (cols.length >= 2) return [b.columns(cols.map((c) => (c.length ? c : [b.p()])))];
        return cols.flat();
      }
      if (cls.includes('table_of_contents') || cls.includes('table-of-contents')) return [b.toc()];
      return kids();
    }
    case 'header':
    case 'style':
    case 'script':
    case 'nav':
      return [];
    default: {
      if (el.children.length) return kids();
      const inl = trimInline(htmlInline(el, cx));
      return inl.length ? [b.p(inl, opts)] : [];
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────── zip helpers

type Files = Map<string, Uint8Array>;

async function readZip(bytes: Uint8Array, depth = 0, acc: Files = new Map(), prefix = ''): Promise<Files> {
  let entries: Files;
  try {
    entries = await unzip(bytes, MAX_TOTAL);
  } catch (e) {
    throw new BackendError('INVALID', e instanceof Error ? e.message : 'This zip file can’t be read');
  }
  if (entries.size + acc.size > MAX_ENTRIES) throw new BackendError('TOO_LARGE', 'This archive has more than 10,000 files');
  for (const [name, data] of entries) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
    if (/\.zip$/i.test(name) && depth < 3) {
      await readZip(data, depth + 1, acc, prefix);
      continue;
    }
    acc.set(prefix + name, data);
  }
  return acc;
}

const stripId = (seg: string) => {
  const base = seg.replace(/\.[a-z0-9]+$/i, '');
  const m = NOTION_ID.exec(base);
  return { title: (m ? base.slice(0, m.index) : base).trim(), id: m?.[1]?.toLowerCase() };
};

function isNotion(files: Files): boolean {
  let hits = 0;
  for (const name of files.keys()) {
    const last = name.split('/').pop() ?? '';
    if (/\.(md|html|csv)$/i.test(last) && NOTION_ID.test(last.replace(/(_all)?\.[a-z]+$/i, ''))) hits++;
    if (hits >= 1) return true;
  }
  return false;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function joinPath(base: string, rel: string): string {
  const parts = (base ? base.split('/') : []).concat(rel.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };

// ───────────────────────────────────────────────────────────────────────────── importers

interface Created {
  rootIds: Id[];
  pageIds: Id[];
  assetIds: Id[];
}

function record(ctx: MockCallCtx, kind: ImportRecord['kind'], workspaceId: Id, c: Created): void {
  imports(ctx).put({ id: jobIdOf(ctx), kind, at: ctx.clock.now(), workspaceId, ...c });
}

function assetFromBytes(ctx: MockCtx, workspaceId: Id, path: string, data: Uint8Array, created: Created): Id | undefined {
  const e = ext(path);
  const mime = MIME[e];
  if (!mime || data.length > 20 * 1024 * 1024) return undefined;
  const dto = ctx.assets.create({ workspaceId, name: path.split('/').pop() ?? path, mime, blob: new Blob([data.slice()], { type: mime }), source: 'import' });
  created.assetIds.push(dto.id);
  return dto.id;
}

/** `[[Wikilinks]]` may point at pages that already exist in the workspace. */
function existingByTitle(ctx: MockCtx, workspaceId: Id, title: string): Id | undefined {
  if (!title) return undefined;
  return ctx.pages.table().find((p) => !p.deletedAt && p.workspaceId === workspaceId && !p.flags.template && (p.title || '').toLowerCase() === title)?.id;
}

async function importMarkdownFiles(ctx: MockCallCtx, files: Files, workspaceId: Id, parentId: Id | null): Promise<{ pages: number; warnings: string[]; created: Created }> {
  const created: Created = { rootIds: [], pageIds: [], assetIds: [] };
  const warnings: string[] = [];
  const md = Array.from(files.keys()).filter((n) => /\.(md|markdown)$/i.test(n)).sort();
  if (!md.length) throw new BackendError('INVALID', 'There are no Markdown files in this archive');
  // Folder pages first (the hierarchy becomes the page tree).
  const folderPage = new Map<string, Id>();
  const pageByTitle = new Map<string, Id>();
  const pageByPath = new Map<string, Id>();
  const ensureFolder = (dir: string): Id | null => {
    if (!dir) return parentId;
    const found = folderPage.get(dir);
    if (found) return found;
    // A file "X.md" next to folder "X/" acts as the folder's page.
    const sibling = md.find((p) => p.replace(/\.(md|markdown)$/i, '') === dir);
    const parent = ensureFolder(dirOf(dir));
    const title = dir.split('/').pop() ?? dir;
    const rec = ctx.pages.create({ workspaceId, parentId: parent, kind: 'doc', title, icon: sibling ? undefined : lucide('folder'), silent: true });
    if (parent === parentId) created.rootIds.push(rec.id);
    created.pageIds.push(rec.id);
    folderPage.set(dir, rec.id);
    pageByTitle.set(title.toLowerCase(), rec.id);
    if (sibling) pageByPath.set(sibling, rec.id);
    return rec.id;
  };
  // pass 1: create every page
  for (const path of md) {
    if (pageByPath.has(path)) continue;
    const dir = dirOf(path);
    const parent = ensureFolder(dir);
    const title = (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '');
    const asFolder = folderPage.get(path.replace(/\.(md|markdown)$/i, ''));
    if (asFolder) {
      pageByPath.set(path, asFolder);
      continue;
    }
    const rec = ctx.pages.create({ workspaceId, parentId: parent, kind: 'doc', title, silent: true });
    if (parent === parentId) created.rootIds.push(rec.id);
    created.pageIds.push(rec.id);
    pageByPath.set(path, rec.id);
    pageByTitle.set(title.toLowerCase(), rec.id);
  }
  // pass 2: content, wikilinks, assets
  const decoder = new TextDecoder();
  let n = 0;
  for (const path of md) {
    ctx.checkCancelled();
    const id = pageByPath.get(path);
    if (!id) continue;
    const data = files.get(path) as Uint8Array;
    if (data.length > MAX_MD_BYTES) {
      warnings.push(`${path} is larger than 20 MB and was skipped`);
      continue;
    }
    const tags = new Set<string>();
    const unresolved: { title: string; ref: string }[] = [];
    const cx: MdContext = {
      tags,
      unresolved,
      resolvePage: (target) => {
        const clean = target.split('#')[0].replace(/\.(md|markdown)$/i, '');
        const key = clean.split('/').pop()?.toLowerCase() ?? '';
        return pageByTitle.get(key) ?? pageByPath.get(joinPath(dirOf(path), `${clean}.md`)) ?? existingByTitle(ctx, workspaceId, key);
      },
      resolveAsset: (p) => {
        const full = files.has(p) ? p : joinPath(dirOf(path), p);
        const hit = files.get(full) ?? Array.from(files.entries()).find(([k]) => k.endsWith(`/${p}`) || k === p)?.[1];
        return hit ? assetFromBytes(ctx, workspaceId, full, hit, created) : undefined;
      },
    };
    const parsed = parseMarkdown(decoder.decode(data), cx, { takeTitle: true, blockId: () => ctx.blockId() });
    if (parsed.title) ctx.pages.update(id, { title: parsed.title.slice(0, 1024) });
    ctx.docs.save(id, 'page', makeDoc(parsed.blocks));
    for (const u of unresolved) warnings.push(`“${u.title}” in ${path.split('/').pop()} doesn’t match a page`);
    n++;
    if (n % 5 === 0 || n === md.length) {
      ctx.progress(n, md.length, `Converting ${path.split('/').pop()}`);
      await ctx.sleep(0, ctx.signal);
    }
  }
  return { pages: created.pageIds.length, warnings: warnings.slice(0, 50), created };
}

interface NotionItem {
  nid: string;
  title: string;
  path: string;
  kind: 'page' | 'database';
  format: 'html' | 'md' | 'csv';
  parentNid: string | null;
  icon?: string;
  newId?: Id;
}

function parseHtml(text: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  // DOMParser never executes scripts or loads resources.
  return new DOMParser().parseFromString(text, 'text/html');
}

const NOTION_DATE = /^([A-Z][a-z]+ \d{1,2}, \d{4})(?: (\d{1,2}:\d{2} ?[AP]M))?(?: → (.+))?$/;

function notionValue(type: PropType, raw: string, optionIds: Map<string, Id>): CellValue | null {
  const s = raw.trim();
  if (!s) return null;
  switch (type) {
    case 'number': {
      const n = parseNumber(s);
      return n === null ? null : { t: 'number', v: n };
    }
    case 'checkbox':
      return { t: 'check', v: parseBool(s) };
    case 'date': {
      const m = NOTION_DATE.exec(s);
      if (m) {
        const start = new Date(`${m[1]}${m[2] ? ` ${m[2]}` : ''}`);
        if (!Number.isNaN(start.getTime())) {
          const iso = m[2] ? start.toISOString() : `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
          return { t: 'date', v: { start: iso, time: !!m[2] } };
        }
      }
      const d = parseDateInput(s);
      return d ? { t: 'date', v: d } : null;
    }
    case 'url':
    case 'email':
    case 'phone':
      return { t: type, v: s };
    case 'select':
      return optionIds.has(s.toLowerCase()) ? { t: 'select', v: optionIds.get(s.toLowerCase()) as Id } : null;
    case 'multi_select':
      return { t: 'multi', v: s.split(',').map((x) => optionIds.get(x.trim().toLowerCase())).filter((x): x is Id => !!x) };
    default:
      return { t: 'text', v: [{ text: raw }] };
  }
}

const TAG_COLORS: BlockColor[] = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray'];

async function importNotionFiles(ctx: MockCallCtx, files: Files, workspaceId: Id, parentId: Id | null) {
  const created: Created = { rootIds: [], pageIds: [], assetIds: [] };
  const warnings: string[] = [];
  const unresolved: { title: string; ref: string }[] = [];
  const unsupported = new Map<string, number>();
  const decoder = new TextDecoder();
  const db = ctx.services.get<DbApi>('db.api');

  // Catalogue items by Notion id. HTML wins over Markdown; `_all.csv` wins over the filtered CSV.
  const items = new Map<string, NotionItem>();
  const folderNid = (dir: string): string | null => {
    const seg = dir.split('/').pop() ?? '';
    return stripId(seg).id ?? null;
  };
  for (const path of files.keys()) {
    const file = path.split('/').pop() ?? '';
    const e = ext(file);
    if (e !== 'md' && e !== 'html' && e !== 'csv') continue;
    const all = /_all\.csv$/i.test(file);
    const { title, id } = stripId(file.replace(/_all\.csv$/i, '.csv'));
    if (!id) continue;
    const parentNid = (() => {
      let d = dirOf(path);
      while (d) {
        const nid = folderNid(d);
        if (nid) return nid;
        d = dirOf(d);
      }
      return null;
    })();
    const prev = items.get(id);
    const kind = e === 'csv' ? 'database' : 'page';
    const rank = (it: { format: string; path: string }) => (it.format === 'csv' ? (/_all\.csv$/i.test(it.path) ? 4 : 3) : it.format === 'html' ? 2 : 1);
    const cand: NotionItem = { nid: id, title, path, kind, format: e as NotionItem['format'], parentNid };
    if (!prev || rank(cand) > rank(prev) || (all && prev.format === 'csv')) items.set(id, cand);
  }
  if (!items.size) throw new BackendError('INVALID', 'This doesn’t look like a Notion export');

  // Row pages live in the database's folder; they become row bodies instead of pages.
  const dbIds = new Set(Array.from(items.values()).filter((i) => i.kind === 'database').map((i) => i.nid));
  const rowPages = new Map<string, NotionItem[]>();
  for (const it of items.values()) {
    if (it.kind === 'page' && it.parentNid && dbIds.has(it.parentNid)) {
      const list = rowPages.get(it.parentNid) ?? [];
      list.push(it);
      rowPages.set(it.parentNid, list);
    }
  }

  // Order: parents before children.
  const depth = (it: NotionItem): number => {
    let d = 0;
    let p = it.parentNid;
    while (p && items.has(p) && d < 64) {
      d++;
      p = items.get(p)?.parentNid ?? null;
    }
    return d;
  };
  const ordered = Array.from(items.values())
    .filter((it) => !(it.kind === 'page' && it.parentNid && dbIds.has(it.parentNid)))
    .sort((a, b2) => depth(a) - depth(b2) || a.title.localeCompare(b2.title));

  const total = ordered.length + 1;
  let done = 0;
  ctx.progress(0, total, 'Reading the export');

  // pass 1: pages (empty) so links can resolve
  const docsHtml = new Map<string, Document>();
  for (const it of ordered) {
    if (it.kind !== 'page') continue;
    const parent = it.parentNid && items.get(it.parentNid)?.newId ? (items.get(it.parentNid)?.newId as Id) : parentId;
    let icon: string | undefined;
    let title = it.title;
    if (it.format === 'html') {
      const doc = parseHtml(decoder.decode(files.get(it.path)));
      if (doc) {
        docsHtml.set(it.nid, doc);
        icon = (doc.querySelector('.page-header-icon .icon')?.textContent ?? doc.querySelector('.page-header-icon')?.textContent ?? '').trim() || undefined;
        title = (doc.querySelector('.page-title')?.textContent ?? '').trim() || title;
      }
    }
    const rec = ctx.pages.create({ workspaceId, parentId: parent, kind: 'doc', title: title || 'Untitled', icon: iconOf(icon), silent: true });
    it.newId = rec.id;
    created.pageIds.push(rec.id);
    if (parent === parentId) created.rootIds.push(rec.id);
  }

  const idFromHref = (href: string): string | undefined => {
    let h = href;
    try {
      h = decodeURIComponent(href);
    } catch {
      /* keep raw */
    }
    const file = h.split('#')[0].split('/').pop() ?? '';
    return stripId(file).id;
  };
  const linkTarget = (href: string): Id | undefined => {
    if (/^[a-z]+:/i.test(href)) {
      const m = /notion\.so\/.*?([0-9a-f]{32})/i.exec(href);
      return m ? items.get(m[1].toLowerCase())?.newId : undefined;
    }
    const nid = idFromHref(href);
    return nid ? items.get(nid)?.newId : undefined;
  };
  const assetCache = new Map<string, Id | undefined>();
  const assetFor = (base: string) => (src: string): Id | undefined => {
    let s = src;
    try {
      s = decodeURIComponent(src);
    } catch {
      /* keep raw */
    }
    if (/^[a-z]+:/i.test(s)) return undefined;
    const full = joinPath(base, s);
    if (assetCache.has(full)) return assetCache.get(full);
    const data = files.get(full);
    const id = data ? assetFromBytes(ctx, workspaceId, full, data, created) : undefined;
    assetCache.set(full, id);
    return id;
  };

  const contentOf = (it: NotionItem, html?: Document): TipTapNode[] => {
    const base = dirOf(it.path);
    if (it.format === 'html') {
      const doc = html ?? parseHtml(decoder.decode(files.get(it.path)));
      if (doc) {
        const body = doc.querySelector('.page-body') ?? doc.body;
        const cx: HtmlCx = { baseDir: base, linkTarget, assetFor: assetFor(base), unsupported, unresolved };
        return Array.from(body.children).flatMap((c) => htmlBlocks(c, cx));
      }
    }
    const text = decoder.decode(files.get(it.path));
    const parsed = parseMarkdown(text, {
      unresolved,
      resolvePage: (target) => {
        const nid = idFromHref(target);
        return nid ? items.get(nid)?.newId : undefined;
      },
      resolveAsset: assetFor(base),
    }, { takeTitle: true, blockId: () => ctx.blockId() });
    return parsed.blocks;
  };

  // pass 2: databases + page content
  let dbCount = 0;
  let rowCount = 0;
  for (const it of ordered) {
    ctx.checkCancelled();
    done++;
    if (it.kind === 'page' && it.newId) {
      ctx.docs.save(it.newId, 'page', makeDoc(contentOf(it, docsHtml.get(it.nid))));
      ctx.progress(done, total, `Converting “${it.title}”`);
    } else if (it.kind === 'database') {
      if (!db) {
        warnings.push(`Database “${it.title}” was skipped`);
        continue;
      }
      ctx.progress(done, total, `Rebuilding database “${it.title}”`);
      const rows = parseCsv(decoder.decode(files.get(it.path)).replace(/^﻿/, ''));
      if (!rows.length) continue;
      const header = rows[0].map((h, k) => h.trim() || `Column ${k + 1}`);
      const body = rows.slice(1).filter((r) => r.some((c) => c.trim()));
      const types: PropType[] = header.map((_, k) => {
        if (k === 0) return 'title';
        const values = body.map((r) => r[k] ?? '').filter((v) => v.trim());
        if (values.length && values.every((v) => NOTION_DATE.test(v.trim()))) return 'date';
        if (values.length && values.every((v) => /^(yes|no)$/i.test(v.trim()))) return 'checkbox';
        if (values.some((v) => /\.(md|html)\)?$/i.test(v) || /%20[0-9a-f]{32}/i.test(v))) return 'text';
        const commaVals = new Set(values.flatMap((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)));
        if (values.some((v) => v.includes(',')) && commaVals.size <= 50 && values.length >= 2) return 'multi_select';
        const t = inferType(values, false);
        return t === 'title' ? 'text' : t;
      });
      const options = header.map((_, k) => {
        const t = types[k];
        if (t !== 'select' && t !== 'multi_select') return null;
        const names = new Map<string, string>();
        for (const r of body) for (const v of (t === 'multi_select' ? (r[k] ?? '').split(',') : [r[k] ?? ''])) if (v.trim()) names.set(v.trim().toLowerCase(), v.trim());
        return Array.from(names.values()).slice(0, 200).map((name, n) => ({ id: `opt_${ctx.blockId()}`, name, color: TAG_COLORS[n % TAG_COLORS.length] }));
      });
      const parent = it.parentNid && items.get(it.parentNid)?.newId ? (items.get(it.parentNid)?.newId as Id) : parentId;
      const { db: dbRec, page } = db.createDatabase(ctx, {
        workspaceId,
        parentId: parent,
        title: it.title || 'Untitled database',
        icon: lucide('folder-open'),
        properties: header.map((name, k) => ({ name, type: types[k], ...(options[k] ? { config: { options: options[k] } } : {}) })),
        silent: true,
      });
      it.newId = page.id;
      created.pageIds.push(page.id);
      if (parent === parentId) created.rootIds.push(page.id);
      dbCount++;
      const props = db.schema(ctx, dbRec.id).properties;
      const propFor = header.map((name, k) => (k === 0 ? props.find((p) => p.type === 'title') : props.find((p) => p.name === name)));
      const optionMaps = options.map((o) => new Map((o ?? []).map((x) => [x.name.toLowerCase(), x.id] as const)));
      const bodies = new Map((rowPages.get(it.nid) ?? []).map((rp) => [rp.title.toLowerCase(), rp] as const));
      for (const r of body) {
        const values: Record<Id, CellValue> = {};
        header.forEach((_, k) => {
          const p = propFor[k];
          if (!p) return;
          const v = k === 0 ? { t: 'text' as const, v: [{ text: (r[0] ?? '').trim() }] } : notionValue(types[k], r[k] ?? '', optionMaps[k]);
          if (v) values[p.id] = v;
        });
        const rp = bodies.get((r[0] ?? '').trim().toLowerCase());
        const rowDoc: TipTapDoc | undefined = rp ? makeDoc(contentOf(rp)) : undefined;
        db.createRow(ctx, dbRec.id, { values, silent: true, ...(rowDoc && rowDoc.content[0]?.content?.length ? { doc: rowDoc } : {}) });
        rowCount++;
      }
      db.emitChanged(ctx, dbRec.id);
    }
    if (done % 4 === 0) await ctx.sleep(0, ctx.signal);
  }

  for (const [, count] of unsupported) if (count) warnings.push(`${count} ${count === 1 ? 'embed was' : 'embeds were'} kept as links`);
  ctx.progress(total, total, 'Linking pages');
  return {
    result: {
      pages: created.pageIds.length - dbCount,
      databases: dbCount,
      rows: rowCount,
      assets: created.assetIds.length,
      unresolved: dedupe(unresolved).slice(0, 100),
      warnings,
    },
    created,
  };
}

function dedupe<T extends { ref: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.ref) ? false : (seen.add(x.ref), true)));
}

function finish(ctx: MockCallCtx, workspaceId: Id, created: Created): void {
  const parents = new Set<Id>();
  for (const id of created.rootIds) {
    const p = ctx.pages.get(id);
    if (p?.parentId) parents.add(p.parentId);
  }
  ctx.pages.emitTree(workspaceId, [...created.pageIds, ...parents]);
}

// ───────────────────────────────────────────────────────────────────────────── detect

async function detectZip(file: File): Promise<{ kind: ImportKind; details: Record<string, unknown> }> {
  const files = await readZip(new Uint8Array(await file.arrayBuffer()));
  const names = Array.from(files.keys());
  const md = names.filter((n) => /\.(md|markdown)$/i.test(n)).length;
  const html = names.filter((n) => /\.html$/i.test(n)).length;
  const csv = names.filter((n) => /\.csv$/i.test(n) && !/_all\.csv$/i.test(n)).length;
  const attachments = names.filter((n) => MIME[ext(n)]).length;
  const name = file.name;
  if (isNotion(files)) return { kind: 'notion_zip', details: { name, size: file.size, pages: Math.max(md, html), databases: csv, attachments, files: names.length } };
  if (md) {
    const folders = new Set(names.filter((n) => /\.(md|markdown)$/i.test(n)).map(dirOf).filter(Boolean)).size;
    return { kind: 'markdown_folder', details: { name, size: file.size, files: md, folders, attachments } };
  }
  return { kind: 'unknown', details: { name, size: file.size, reason: 'This zip has no Markdown or Notion pages' } };
}

const BY_EXT: Record<string, ImportKind> = {
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', txt: 'markdown',
  csv: 'csv', tsv: 'csv', xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xlsx', ods: 'xlsx',
  ofx: 'ofx', qfx: 'qfx', qif: 'qif', ics: 'ics', ical: 'ics',
  empbackup: 'empbackup', empsnap: 'empbackup',
};

export const handlers: MockHandlers = {
  import_detect: async (req, ctx) => {
    const meta = metaOf(ctx).get(req.grantId);
    if (!meta) {
      // Unknown to us (e.g. a desktop drop): read it once and sniff the content.
      const file = ctx.grants.read(req.grantId);
      cacheOf(ctx).set(req.grantId, file);
      const head = await file.slice(0, 64).text();
      if (head.startsWith('PK')) return detectZip(file);
      if (head.startsWith('EMPBACKUP') || head.startsWith('EMPSNAP')) return { kind: 'empbackup', details: { name: file.name, size: file.size } };
      if (/^BEGIN:VCALENDAR/i.test(head)) return { kind: 'ics', details: { name: file.name, size: file.size } };
      if (/OFXHEADER|<OFX>/i.test(head)) return { kind: 'ofx', details: { name: file.name, size: file.size } };
      return { kind: BY_EXT[ext(file.name)] ?? 'unknown', details: { name: file.name, size: file.size } };
    }
    const e = ext(meta.displayName);
    if (e === 'zip') {
      const file = ctx.grants.read(req.grantId);
      cacheOf(ctx).set(req.grantId, file);
      return detectZip(file);
    }
    const kind = BY_EXT[e] ?? 'unknown';
    const details: Record<string, unknown> = { name: meta.displayName, size: meta.size };
    if (kind === 'markdown') {
      const file = ctx.grants.read(req.grantId);
      cacheOf(ctx).set(req.grantId, file);
      const text = await file.slice(0, 2 * 1024 * 1024).text();
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? meta.displayName.replace(/\.[^.]+$/, '');
      details.title = title;
      details.words = text.split(/\s+/).filter(Boolean).length;
      details.headings = (text.match(/^#{1,6}\s/gm) ?? []).length;
    }
    if (kind === 'unknown') details.reason = 'Ultra Note can’t import this kind of file';
    return { kind, details };
  },

  import_markdown: async (req, ctx) => {
    const file = fileFor(ctx, req.grantId);
    ctx.progress(0, 1, 'Reading');
    if (req.parentId) ctx.pages.require(req.parentId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let files: Files;
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) files = await readZip(bytes);
    else {
      if (bytes.length > MAX_MD_BYTES) throw new BackendError('TOO_LARGE', 'Markdown files up to 20 MB can be imported');
      const base = file.name.replace(/\.(md|markdown|mdown|txt)$/i, '') || 'Imported';
      files = new Map([[`${base}.md`, bytes]]);
    }
    const { pages, warnings, created } = await importMarkdownFiles(ctx, files, req.workspaceId, req.parentId);
    finish(ctx, req.workspaceId, created);
    record(ctx, 'markdown', req.workspaceId, created);
    ctx.progress(1, 1, 'Done');
    return { pages, warnings };
  },

  import_notion: async (req, ctx) => {
    const file = fileFor(ctx, req.grantId);
    if (req.parentId) ctx.pages.require(req.parentId);
    ctx.progress(0, 1, 'Unpacking the export');
    const files = await readZip(new Uint8Array(await file.arrayBuffer()));
    if (!isNotion(files)) throw new BackendError('INVALID', 'This doesn’t look like a Notion export. Export from Notion with “Markdown & CSV” or “HTML”.');
    const { result, created } = await importNotionFiles(ctx, files, req.workspaceId, req.parentId);
    finish(ctx, req.workspaceId, created);
    record(ctx, 'notion', req.workspaceId, created);
    return result;
  },

  import_undo: (req, ctx) => {
    const rec = imports(ctx).get(req.importJobId);
    if (!rec) throw new BackendError('NOT_FOUND', 'That import can no longer be undone');
    const live = rec.pageIds.filter((id) => ctx.pages.table().has(id));
    const roots = rec.rootIds.filter((id) => ctx.pages.table().has(id));
    ctx.pages.purge(roots);
    // Pages moved out of the imported subtree are purged too (the import is one unit).
    const rest = live.filter((id) => ctx.pages.table().has(id));
    if (rest.length) ctx.pages.purge(rest);
    for (const a of rec.assetIds) {
      ctx.db.table('assets').delete(a);
      ctx.db.table('asset_blobs').delete(a);
    }
    ctx.pages.emitTree(rec.workspaceId, [], live);
    imports(ctx).delete(rec.id);
    return { removed: live.length + rec.assetIds.length };
  },
};

export function setup(ctx: MockCtx): void {
  // Remember each grant's name and size so detection never has to consume grants other importers will read.
  const grants = ctx.grants as GrantsService;
  const pick = grants.pick.bind(grants);
  const register = grants.register.bind(grants);
  grants.pick = async (purpose, accept, multiple) => {
    const list = await pick(purpose, accept, multiple);
    for (const g of list) metaOf(ctx).set(g.grantId, { displayName: g.displayName, size: g.size });
    return list;
  };
  grants.register = (file, purpose) => {
    const g = register(file, purpose);
    metaOf(ctx).set(g.grantId, { displayName: g.displayName, size: g.size });
    return g;
  };
}

/** For tests: parse Markdown into a TipTap doc. */
export function markdownToDoc(md: string, cx: MdContext = {}): TipTapDoc {
  const parsed = parseMarkdown(md, cx);
  return { type: 'doc', attrs: { schemaVersion: SCHEMA_VERSION }, content: [{ type: 'blockGroup', content: parsed.blocks.length ? parsed.blocks : [b.p()] }] };
}
