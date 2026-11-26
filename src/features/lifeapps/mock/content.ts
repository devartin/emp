/**
 * Mock-only: a tiny Markdown → TipTap converter for generated life-app pages (headings, paragraphs, bullets, numbered
 * lists, to-dos, quotes, callouts via "> [!note]", tables, dividers; inline **bold**, *italic*, `code`).
 */
import type { TipTapNode } from '@/backend/types';
import { b, t, type Inline } from '@/backend/mock/lib/doc';

function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(t.bold(tok.slice(2, -2)));
    else if (tok.startsWith('`')) out.push(t.code(tok.slice(1, -1)));
    else out.push(t.italic(tok.slice(1, -1)));
    last = m.index! + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function md(src: string): TipTapNode[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: TipTapNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      out.push(b.divider());
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      out.push(lvl === 1 ? b.h1(inline(h[2])) : lvl === 2 ? b.h2(inline(h[2])) : b.h3(inline(h[2])));
      i++;
      continue;
    }
    const todo = /^\s*[-*]\s+\[( |x)\]\s+(.*)$/.exec(line);
    if (todo) {
      out.push(b.todo(inline(todo[2]), todo[1] === 'x'));
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(b.bullet(inline(bullet[1])));
      i++;
      continue;
    }
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (num) {
      out.push(b.numbered(inline(num[1])));
      i++;
      continue;
    }
    const callout = /^>\s*\[!(note|tip|warn|info)\]\s*(.*)$/i.exec(line);
    if (callout) {
      const tone = callout[1].toLowerCase();
      const icon = tone === 'warn' ? '⚠️' : tone === 'tip' ? '💡' : 'ℹ️';
      out.push(b.callout(inline(callout[2]), { icon: { t: 'emoji', v: icon }, tone: tone === 'warn' ? 'yellow' : tone === 'tip' ? 'green' : 'blue' }));
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      out.push(b.quote(inline(line.replace(/^>\s?/, ''))));
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: Inline[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells.map((c) => inline(c)));
        i++;
      }
      if (rows.length) out.push(b.table(rows));
      continue;
    }
    out.push(b.p(inline(line)));
    i++;
  }
  return out;
}
