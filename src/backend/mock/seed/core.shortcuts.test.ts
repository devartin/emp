/**
 * Keyboard shortcuts page parity: the mock seed (core.ts) and the desktop tour (crates/emp-store/src/repo/tour.rs
 * `SHORTCUTS`) carry the same rows, and every key chord is a code chip (the Getting Started style), never plain text.
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { mockApi } from '@/test/helpers';
import { isMac } from '@/lib/platform';
import type { TipTapNode } from '@/backend/types';
import { spellKeys } from '../lib/keys';

const TOUR_RS = readFileSync(new URL('../../../../crates/emp-store/src/repo/tour.rs', import.meta.url), 'utf8');

/** `SHORTCUTS` table rows from tour.rs as [keys markdown, action], spelled for this platform like `platform_keys`. */
function rustRows(): [string, string][] {
  const start = TOUR_RS.indexOf('const SHORTCUTS: &str = "');
  const body = TOUR_RS.slice(start, TOUR_RS.indexOf('";\n', start)).replace(/\\\\/g, '\\');
  return body
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Keys') && !l.startsWith('| ---'))
    .map((l) => l.slice(2, -2).split(' | ') as [string, string])
    .map(([k, a]) => [isMac ? k : spellKeys(k), a]);
}

/** A table cell as markdown: code-marked text in backticks, plain text as is. */
function cellMd(cell: TipTapNode): string {
  const out: string[] = [];
  const walk = (n: TipTapNode) => {
    if (typeof n.text === 'string') out.push(n.marks?.some((m) => m.type === 'code') ? `\`${n.text}\`` : n.text);
    n.content?.forEach(walk);
  };
  walk(cell);
  return out.join('');
}

function tableRows(doc: TipTapNode): TipTapNode[][] {
  const rows: TipTapNode[][] = [];
  const walk = (n: TipTapNode) => {
    if (n.type === 'tableRow') rows.push(n.content ?? []);
    else n.content?.forEach(walk);
  };
  walk(doc);
  return rows;
}

describe('Keyboard shortcuts page', () => {
  test('mock seed rows match tour.rs, keys as code chips', async () => {
    const { backend } = await mockApi();
    const id = backend.ctx.seedRefs.get('core.page.shortcuts');
    expect(id).toBeTruthy();
    const doc = backend.ctx.docs.get(id!)!.doc as unknown as TipTapNode;
    const rows = tableRows(doc)
      .map((cells) => [cellMd(cells[0]), cellMd(cells[1])] as [string, string])
      .filter(([k]) => k !== 'Keys');
    for (const [k] of rows) expect(k.startsWith('`'), k).toBe(true);
    expect(rows).toEqual(rustRows());
  });
});
