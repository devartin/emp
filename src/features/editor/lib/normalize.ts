/**
 * Lenient normalisation of stored/pasted TipTap JSON into the D-07 shape (§7.1): wraps bare blocks in containers,
 * drops unknown marks, turns unknown nodes into paragraphs, enforces leaf/column invariants and fresh ids. Keeps the
 * editor robust against documents written by other versions, importers and seeds.
 */
import type { TipTapDoc, TipTapNode } from '@/backend/types';
import { ATOM_TYPES, BLOCK_COLOR_NAMES, TEXT_TYPES, allowsChildren } from './blockTypes';
import { BLOCK_ID_RE, newBlockId } from './ids';

const CONTENT_TYPES = new Set([...TEXT_TYPES, ...ATOM_TYPES, 'codeBlock', 'table', 'columnList']);
const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'mathInline']);
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textColor', 'highlight']);
const isColor = (v: unknown) => typeof v === 'string' && (BLOCK_COLOR_NAMES as readonly string[]).includes(v);

function textOf(n: TipTapNode | undefined): string {
  if (!n) return '';
  if (n.type === 'text') return n.text ?? '';
  return (n.content ?? []).map(textOf).join(n.type === 'blockGroup' ? '\n' : '');
}

function inline(nodes: TipTapNode[] | undefined, code = false): TipTapNode[] {
  const out: TipTapNode[] = [];
  for (const n of nodes ?? []) {
    if (!n || typeof n !== 'object') continue;
    if (code) {
      const t = textOf(n);
      if (t) out.push({ type: 'text', text: t });
      continue;
    }
    if (n.type === 'text') {
      if (typeof n.text !== 'string' || !n.text) continue;
      const marks = (n.marks ?? []).filter((m) => m && MARKS.has(m.type));
      out.push(marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text });
    } else if (INLINE.has(n.type)) {
      out.push(n.attrs ? { type: n.type, attrs: n.attrs } : { type: n.type });
    } else {
      const t = textOf(n);
      if (t) out.push({ type: 'text', text: t });
    }
  }
  if (code && out.length > 1) return [{ type: 'text', text: out.map((t) => t.text).join('') }];
  return out;
}

function withContent(base: TipTapNode, content: TipTapNode[]): TipTapNode {
  return content.length ? { ...base, content } : { type: base.type, ...(base.attrs ? { attrs: base.attrs } : {}) };
}

function normContent(c: TipTapNode): TipTapNode {
  const base: TipTapNode = c.attrs ? { type: c.type, attrs: { ...c.attrs } } : { type: c.type };
  if (TEXT_TYPES.has(c.type)) return withContent(base, inline(c.content));
  if (c.type === 'codeBlock') return withContent(base, inline(c.content, true));
  if (ATOM_TYPES.has(c.type)) return base;
  if (c.type === 'table') {
    const rows = (c.content ?? []).filter((r) => r?.type === 'tableRow');
    const width = Math.max(1, ...rows.map((r) => (r.content ?? []).length));
    const fixedRows = (rows.length ? rows : [{ type: 'tableRow', content: [] }]).map((r) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, i) => {
        const cell = (r.content ?? [])[i];
        const kids = inline(cell?.type === 'tableCell' && cell.content?.some((k) => k.type === 'paragraph') ? cell.content.flatMap((p) => p.content ?? []) : cell?.content);
        return kids.length ? { type: 'tableCell', content: kids } : { type: 'tableCell' };
      }),
    }));
    return { ...base, content: fixedRows };
  }
  if (c.type === 'columnList') {
    const cols = (c.content ?? []).filter((col) => col?.type === 'column').slice(0, 5);
    const fixed = cols.map((col) => ({ type: 'column', content: [normGroup(col.content?.[0]?.type === 'blockGroup' ? col.content[0] : { type: 'blockGroup', content: col.content ?? [] }, true)] }));
    while (fixed.length < 2) fixed.push({ type: 'column', content: [normGroup({ type: 'blockGroup', content: [] }, true)] });
    const widths = Array.isArray(c.attrs?.widths) && (c.attrs?.widths as unknown[]).length === fixed.length ? c.attrs?.widths : fixed.map(() => 1 / fixed.length);
    return { type: 'columnList', attrs: { widths }, content: fixed };
  }
  return { type: 'paragraph', ...(textOf(c) ? { content: [{ type: 'text', text: textOf(c) }] } : {}) };
}

function emptyContainer(): TipTapNode {
  return { type: 'blockContainer', attrs: { id: newBlockId(), color: null, bg: null, dir: 'auto' }, content: [{ type: 'paragraph' }] };
}

function normContainer(n: TipTapNode, seen: Set<string>, inColumn: boolean): TipTapNode[] {
  if (!n || typeof n !== 'object') return [];
  if (n.type !== 'blockContainer') {
    if (n.type === 'blockGroup') return (n.content ?? []).flatMap((c) => normContainer(c, seen, inColumn));
    if (CONTENT_TYPES.has(n.type) || n.type === 'tableCell' || n.type === 'heading') return normContainer({ type: 'blockContainer', content: [n] }, seen, inColumn);
    const t = textOf(n);
    return normContainer({ type: 'blockContainer', content: [{ type: 'paragraph', ...(t ? { content: [{ type: 'text', text: t }] } : {}) }] }, seen, inColumn);
  }
  const [first, second] = n.content ?? [];
  let content = first && CONTENT_TYPES.has(first.type) ? normContent(first) : { type: 'paragraph' };
  const a = n.attrs ?? {};
  let id = typeof a.id === 'string' && BLOCK_ID_RE.test(a.id) && !seen.has(a.id) ? a.id : newBlockId();
  seen.add(id);
  const attrs = { id, color: isColor(a.color) ? a.color : null, bg: isColor(a.bg) ? a.bg : null, dir: a.dir === 'ltr' || a.dir === 'rtl' ? a.dir : 'auto' };
  if (content.type === 'columnList') {
    if (inColumn) return (content.content ?? []).flatMap((col) => col.content?.[0]?.content ?? []);
    content = {
      ...content,
      content: (content.content ?? []).map((col) => ({ type: 'column', content: [{ type: 'blockGroup', content: (col.content?.[0]?.content ?? []).flatMap((b) => normContainer(b, seen, true)) }] })),
    };
    for (const col of content.content ?? []) if (!col.content?.[0]?.content?.length) col.content = [{ type: 'blockGroup', content: [emptyContainer()] }];
  }
  const kids = second?.type === 'blockGroup' ? (second.content ?? []).flatMap((c) => normContainer(c, seen, inColumn)) : [];
  const self: TipTapNode = { type: 'blockContainer', attrs, content: [content] };
  if (kids.length && allowsChildren({ type: { name: content.type }, attrs: content.attrs ?? {} })) {
    self.content = [content, { type: 'blockGroup', content: kids }];
    return [self];
  }
  id = '';
  return [self, ...kids];
}

function normGroup(g: TipTapNode, inColumn = false, seen = new Set<string>()): TipTapNode {
  const blocks = (g.content ?? []).flatMap((c) => normContainer(c, seen, inColumn));
  return { type: 'blockGroup', content: blocks.length ? blocks : [emptyContainer()] };
}

export function normaliseDocJson(raw: unknown): TipTapDoc {
  const doc = raw && typeof raw === 'object' ? (raw as TipTapDoc) : null;
  const seen = new Set<string>();
  let group: TipTapNode;
  if (!doc || !Array.isArray(doc.content) || !doc.content.length) group = { type: 'blockGroup', content: [emptyContainer()] };
  else if (doc.content.length === 1 && doc.content[0]?.type === 'blockGroup') group = normGroup(doc.content[0], false, seen);
  else group = normGroup({ type: 'blockGroup', content: doc.content }, false, seen);
  return { type: 'doc', attrs: { schemaVersion: 1 }, content: [group] };
}

export function emptyDocJson(): TipTapDoc {
  return { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'blockGroup', content: [emptyContainer()] }] };
}

/** Plain text of a doc (backlink snippets, version previews). */
export function docPlainText(doc: TipTapDoc | null | undefined): string {
  return doc ? textOf({ type: 'blockGroup', content: doc.content }) : '';
}
