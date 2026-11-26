/**
 * Markdown bridge for the clipboard (§7.7): `text/plain` is markdown on copy, plain-text pastes that look like markdown
 * (headings, lists, tables, code fences) become blocks. Works on TipTap JSON so it runs without a view.
 */
import type { TipTapNode } from '@/backend/types';
import { newBlockId } from './ids';
import { pageInfo } from './pageInfo';
import { internalHref, isAllowedHref } from './links';

// ───────────────────────────────────────────────────────────────────────────── export

type Mark = { type: string; attrs?: Record<string, unknown> };

function escapeMd(s: string): string {
  return s.replace(/([\\`*_~[\]])/g, '\\$1');
}

export function inlineToMarkdown(nodes: TipTapNode[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      const marks = (n.marks ?? []) as Mark[];
      const has = (t: string) => marks.some((m) => m.type === t);
      let t = has('code') ? `\`${n.text ?? ''}\`` : escapeMd(n.text ?? '');
      if (!has('code')) {
        if (has('bold')) t = `**${t}**`;
        if (has('italic')) t = `_${t}_`;
        if (has('strike')) t = `~~${t}~~`;
      }
      const link = marks.find((m) => m.type === 'link');
      if (link?.attrs?.href) t = `[${t}](${String(link.attrs.href)})`;
      out += t;
    } else if (n.type === 'hardBreak') out += '  \n';
    else if (n.type === 'emoji') out += String(n.attrs?.native ?? '');
    else if (n.type === 'mathInline') out += `$${String(n.attrs?.latex ?? '')}$`;
    else if (n.type === 'mention') {
      if (n.attrs?.kind === 'date') out += String((n.attrs.date as { start?: string } | null)?.start ?? '');
      else {
        const id = String(n.attrs?.pageId ?? '');
        const meta = pageInfo(id);
        out += `[${escapeMd(meta?.title || 'Untitled')}](${internalHref(id)})`;
      }
    }
  }
  return out;
}

function tableToMarkdown(table: TipTapNode): string[] {
  const rows = (table.content ?? []).map((r) => (r.content ?? []).map((c) => inlineToMarkdown(c.content).replace(/\|/g, '\\|').replace(/\n/g, ' ')));
  if (!rows.length) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array.from({ length: cols - r.length }, () => '')];
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
  return lines;
}

function blockToLines(container: TipTapNode, indent: string, numbering: { n: number }): string[] {
  const [content, group] = container.content ?? [];
  if (!content) return [];
  const a = content.attrs ?? {};
  const text = inlineToMarkdown(content.content);
  let lines: string[] = [];
  let childIndent = indent + '  ';
  switch (content.type) {
    case 'paragraph':
      lines = [indent + text];
      break;
    case 'heading':
      lines = [`${indent}${'#'.repeat(Number(a.level) || 1)} ${text}`];
      childIndent = indent;
      break;
    case 'bulletItem':
    case 'toggle':
      lines = [`${indent}- ${text}`];
      break;
    case 'numberedItem':
      lines = [`${indent}${numbering.n}. ${text}`];
      break;
    case 'todoItem':
      lines = [`${indent}- [${a.checked ? 'x' : ' '}] ${text}`];
      break;
    case 'quote':
      lines = [`${indent}> ${text}`];
      break;
    case 'callout': {
      const icon = (a.icon as { t?: string; v?: string } | undefined)?.t === 'emoji' ? `${(a.icon as { v: string }).v} ` : '';
      lines = [`${indent}> ${icon}${text}`];
      break;
    }
    case 'codeBlock': {
      const lang = a.language && a.language !== 'plain' ? String(a.language) : '';
      const code = (content.content ?? []).map((t) => t.text ?? '').join('');
      lines = [`${indent}\`\`\`${lang}`, ...code.split('\n').map((l) => indent + l), `${indent}\`\`\``];
      break;
    }
    case 'divider':
      lines = [`${indent}---`];
      break;
    case 'mathBlock':
      lines = [`${indent}$$`, `${indent}${String(a.latex ?? '')}`, `${indent}$$`];
      break;
    case 'table':
      lines = tableToMarkdown(content).map((l) => indent + l);
      break;
    case 'columnList':
      for (const col of content.content ?? []) lines.push(...groupToLines(col.content?.[0], indent));
      break;
    case 'pageRef':
    case 'pageLink': {
      const id = String(a.pageId ?? '');
      lines = [`${indent}[${escapeMd(pageInfo(id)?.title || 'Untitled')}](${internalHref(id)})`];
      break;
    }
    case 'image':
      lines = [`${indent}![${escapeMd(String(a.caption ?? ''))}](emp-asset:${String(a.assetId ?? '')})`];
      break;
    case 'file':
      lines = [`${indent}[File](emp-asset:${String(a.assetId ?? '')})`];
      break;
    default:
      lines = [];
  }
  if (group) lines.push(...groupToLines(group, childIndent));
  return lines;
}

function groupToLines(group: TipTapNode | undefined, indent: string): string[] {
  const out: string[] = [];
  const numbering = { n: 0 };
  let prevType = '';
  for (const c of group?.content ?? []) {
    const type = c.content?.[0]?.type ?? '';
    numbering.n = type === 'numberedItem' ? (prevType === 'numberedItem' ? numbering.n + 1 : 1) : 0;
    const lines = blockToLines(c, indent, numbering);
    const listy = /^(bulletItem|numberedItem|todoItem|toggle)$/.test(type);
    const prevListy = /^(bulletItem|numberedItem|todoItem|toggle)$/.test(prevType);
    if (out.length && !(listy && prevListy) && indent === '') out.push('');
    out.push(...lines);
    prevType = type;
  }
  return out;
}

/** Blocks (blockContainer JSON) → markdown. */
export function blocksToMarkdown(blocks: TipTapNode[]): string {
  return groupToLines({ type: 'blockGroup', content: blocks }, '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ───────────────────────────────────────────────────────────────────────────── import

function text(t: string, marks?: Mark[]): TipTapNode {
  return marks && marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t };
}

/** Inline markdown → TipTap inline nodes (bold, italic, strike, code, links, $math$). */
export function parseInline(src: string, marks: Mark[] = []): TipTapNode[] {
  const out: TipTapNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(text(buf, marks));
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (rest[0] === '\\' && rest.length > 1) {
      buf += rest[1];
      i += 2;
      continue;
    }
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push(text(m[1], [...marks, { type: 'code' }]));
      i += m[0].length;
      continue;
    }
    if ((m = /^\$([^$\n]+)\$/.exec(rest))) {
      flush();
      out.push({ type: 'mathInline', attrs: { latex: m[1] } });
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      const href = m[2];
      const inner = parseInline(m[1], isAllowedHref(href) ? [...marks, { type: 'link', attrs: { href } }] : marks);
      out.push(...inner);
      i += m[0].length;
      continue;
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
      flush();
      out.push(...parseInline(m[2], [...marks, { type: 'bold' }]));
      i += m[0].length;
      continue;
    }
    if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      flush();
      out.push(...parseInline(m[1], [...marks, { type: 'strike' }]));
      i += m[0].length;
      continue;
    }
    if ((m = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/u.exec(rest)) && (i === 0 || !/[\p{L}\p{N}]/u.test(src[i - 1]))) {
      flush();
      out.push(...parseInline(m[2], [...marks, { type: 'italic' }]));
      i += m[0].length;
      continue;
    }
    buf += rest[0];
    i += 1;
  }
  flush();
  return out;
}

function container(content: TipTapNode, children?: TipTapNode[]): TipTapNode {
  const c: TipTapNode[] = [content];
  if (children && children.length) c.push({ type: 'blockGroup', content: children });
  return { type: 'blockContainer', attrs: { id: newBlockId(), color: null, bg: null, dir: 'auto' }, content: c };
}

function inlineBlock(type: string, src: string, attrs?: Record<string, unknown>): TipTapNode {
  const inl = parseInline(src);
  const n: TipTapNode = { type };
  if (attrs) n.attrs = attrs;
  if (inl.length) n.content = inl;
  return n;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/;

/** Markdown → blockContainer JSON. */
export function markdownToBlocks(md: string): TipTapNode[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const root: TipTapNode[] = [];
  // Stack of open list items for nesting: indent width → children array.
  let stack: { indent: number; children: TipTapNode[] }[] = [];
  const target = (indent: number): TipTapNode[] => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    return stack.length ? stack[stack.length - 1].children : root;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      root.push(container(inlineBlock('paragraph', para.join(' '))));
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      flushPara();
      stack = [];
      continue;
    }
    if ((m = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line))) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      const code = body.join('\n');
      root.push(container({ type: 'codeBlock', attrs: { language: m[1] ? m[1].toLowerCase() : 'plain', wrap: false, caption: '' }, ...(code ? { content: [{ type: 'text', text: code }] } : {}) }));
      stack = [];
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
      root.push(container({ type: 'mathBlock', attrs: { latex: body.join('\n').trim() } }));
      stack = [];
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara();
      root.push(container(inlineBlock('heading', m[2].replace(/\s+#+\s*$/, ''), { level: Math.min(3, m[1].length), toggle: false, collapsed: false })));
      stack = [];
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      root.push(container({ type: 'divider' }));
      stack = [];
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara();
      const rows: string[][] = [];
      const split = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      rows.push(split(line));
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(split(lines[i++]));
      i--;
      const cols = Math.max(...rows.map((r) => r.length));
      root.push(
        container({
          type: 'table',
          attrs: { headerRow: true, headerCol: false, colWidths: [], cellColors: {} },
          content: rows.map((r) => ({
            type: 'tableRow',
            content: Array.from({ length: cols }, (_, c) => {
              const inl = parseInline(r[c] ?? '');
              return inl.length ? { type: 'tableCell', content: inl } : { type: 'tableCell' };
            }),
          })),
        }),
      );
      stack = [];
      continue;
    }
    if ((m = LIST_RE.exec(line))) {
      flushPara();
      const indent = m[1].replace(/\t/g, '    ').length;
      const marker = m[2];
      const todo = m[3];
      const body = m[4];
      const node = todo
        ? inlineBlock('todoItem', body, { checked: /x/i.test(todo) })
        : /\d/.test(marker)
          ? inlineBlock('numberedItem', body, { start: null })
          : inlineBlock('bulletItem', body);
      const children: TipTapNode[] = [];
      const block = container(node);
      Object.defineProperty(block, '__kids', { value: children, enumerable: false });
      target(indent).push(block);
      stack.push({ indent, children });
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushPara();
      const parts = [m[1]];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) parts.push(lines[++i].replace(/^\s*>\s?/, ''));
      root.push(container(inlineBlock('quote', parts.join(' '))));
      stack = [];
      continue;
    }
    if ((m = /^\s*!\[([^\]]*)\]\((https?:[^)\s]+)\)\s*$/.exec(line))) {
      flushPara();
      root.push(container({ type: 'image', attrs: { assetId: null, width: null, align: 'center', caption: m[1], pendingUrl: m[2] } }));
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  const attach = (blocks: TipTapNode[]) => {
    for (const b of blocks) {
      const kids = (b as unknown as { __kids?: TipTapNode[] }).__kids;
      if (kids && kids.length) {
        attach(kids);
        b.content = [...(b.content ?? []).slice(0, 1), { type: 'blockGroup', content: kids }];
      }
    }
  };
  attach(root);
  return root;
}

/** Heuristic: does plain text look like markdown worth converting? */
export function looksLikeMarkdown(s: string): boolean {
  const lines = s.split(/\r?\n/);
  if (lines.length < 2 && !/^(#{1,6}\s|```)/.test(s)) return false;
  let hits = 0;
  for (const l of lines) {
    if (/^(#{1,6}\s|\s*[-*+]\s|\s*\d{1,3}[.)]\s|>\s|```|\s*\|.*\|\s*$|\s*-\s\[[ xX]\]\s)/.test(l)) hits++;
    else if (/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/.test(l)) hits += 0.5;
  }
  return hits >= 1;
}

/** Plain text lines → paragraph containers. */
export function textToBlocks(s: string): TipTapNode[] {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => container(l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' }));
}

/** TSV/CSV grid detection (≥2 rows, ≥2 consistent columns). */
export function parseGrid(s: string): string[][] | null {
  const lines = s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length < 2) return null;
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : null;
  if (!sep) return null;
  const rows = lines.map((l) => (sep === ',' ? splitCsv(l) : l.split('\t')));
  const cols = rows[0].length;
  if (cols < 2 || rows.some((r) => r.length !== cols)) return null;
  if (sep === ',' && rows.some((r) => r.some((c) => c.length > 200))) return null;
  return rows.slice(0, 500);
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function gridToTable(rows: string[][]): TipTapNode {
  return container({
    type: 'table',
    attrs: { headerRow: true, headerCol: false, colWidths: [], cellColors: {} },
    content: rows.map((r) => ({ type: 'tableRow', content: r.map((c) => (c ? { type: 'tableCell', content: [{ type: 'text', text: c }] } : { type: 'tableCell' })) })),
  });
}
