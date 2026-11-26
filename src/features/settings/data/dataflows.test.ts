import { describe, expect, test } from 'vitest';
import { docToMarkdown } from '@/backend/mock/commands/export';
import { parseMarkdown } from '@/backend/mock/commands/import';
import { makeDoc } from '@/backend/mock/lib/doc';
import type { TipTapDoc, TipTapNode } from '@/backend/types';
import { expectCode, mockApi } from '@/test/helpers';

const types = (doc: TipTapDoc) => {
  const out: string[] = [];
  const walk = (n: TipTapNode, depth: number) => {
    if (n.type === 'blockContainer') out.push(`${depth}:${n.content?.[0]?.type}`);
    for (const c of n.content ?? []) walk(c, n.type === 'blockGroup' ? depth : n.type === 'blockContainer' ? depth + 1 : depth);
  };
  doc.content.forEach((c) => walk(c, 0));
  return out;
};

const MD = `---
title: Trip
---
# Trip

Intro with **bold**, *italic*, \`code\` and a [link](https://example.com).

- one
  - nested
- [x] done
- [ ] todo

1. first
2. second

> [!warning] Mind the gap

> A quote

| a | b |
| --- | --- |
| 1 | 2 |

\`\`\`ts
const x = 1;
\`\`\`

$$
a^2
$$

---
`;

function captureWrites(backend: Awaited<ReturnType<typeof mockApi>>['backend']) {
  const out: { data: string | Blob }[] = [];
  const grants = backend.ctx.grants;
  const orig = grants.write.bind(grants);
  grants.write = (id, data, mime) => {
    out.push({ data });
    return orig(id, data, mime);
  };
  return out;
}

describe('markdown', () => {
  test('parse → export → parse keeps the block structure', () => {
    const first = parseMarkdown(MD, {}, { takeTitle: true });
    expect(first.title).toBe('Trip');
    const doc1 = makeDoc(first.blocks);
    const md2 = docToMarkdown(doc1);
    const doc2 = makeDoc(parseMarkdown(md2).blocks);
    expect(types(doc2)).toEqual(types(doc1));
    expect(types(doc1)).toContain('1:bulletItem');
    expect(types(doc1)).toContain('0:callout');
    expect(types(doc1)).toContain('0:table');
    expect(types(doc1)).toContain('0:mathBlock');
  });

  test('wikilinks resolve; unresolved ones are reported', () => {
    const unresolved: { title: string; ref: string }[] = [];
    const parsed = parseMarkdown('See [[Home]] and [[Gone|old page]].', { unresolved, resolvePage: (t) => (t === 'Home' ? 'p1' : undefined) });
    const para = parsed.blocks[0].content?.[0];
    expect(para?.content?.some((n) => n.type === 'mention' && (n.attrs as { pageId?: string }).pageId === 'p1')).toBe(true);
    expect(unresolved).toEqual([{ title: 'old page', ref: 'Gone' }]);
  });
});

describe('import & export (mock)', () => {
  test('import a Markdown file, then undo it as one step', async () => {
    const { api, backend } = await mockApi();
    const [ws] = await api.workspace.list();
    const g = backend.ctx.grants.register(new File([MD], 'trip.md'), 'import');
    expect((await api.import.detect({ grantId: g.grantId })).kind).toBe('markdown');
    const job = await api.import.markdown({ grantId: g.grantId, workspaceId: ws.id, parentId: null });
    expect((await job.result).pages).toBe(1);
    const pages = (await api.workspace.open({ id: ws.id })).pages;
    expect(pages.some((p) => p.title === 'Trip')).toBe(true);
    const { removed } = await api.import.undo({ importJobId: job.jobId });
    expect(removed).toBe(1);
    expect((await api.workspace.open({ id: ws.id })).pages.some((p) => p.title === 'Trip')).toBe(false);
  });

  test('export everything needs re-auth when encrypted and writes a manifest', async () => {
    const { api, backend } = await mockApi({ encrypted: true });
    const writes = captureWrites(backend);
    const g = backend.ctx.grants.saveGrant('export', 'All.zip');
    await expectCode(api.export.everything({ grantId: g.grantId }), 'REAUTH_REQUIRED');
    await api.vault.reauth({ password: 'demo' });
    const g2 = backend.ctx.grants.saveGrant('export', 'All.zip');
    const res = await (await api.export.everything({ grantId: g2.grantId })).result;
    expect(res.bytes).toBeGreaterThan(1000);
    const blob = writes[writes.length - 1].data as Blob;
    const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
    expect(text).toContain('manifest.json');
    expect(text).toContain('"format": "emp-export"');
    expect(text).not.toContain('"password"');
  });
});

describe('backups (mock)', () => {
  test('backup → restore with the backup password; wrong password and tampering are rejected', async () => {
    const { api, backend } = await mockApi();
    const writes = captureWrites(backend);
    const g = backend.ctx.grants.saveGrant('backup', 'x.empbackup');
    await (await api.backup.create({ grantId: g.grantId, password: 'hunter2hunter2' })).result;
    const text = writes[writes.length - 1].data as string;
    expect(text.startsWith('EMPBACKUP\n')).toBe(true);

    const bad = backend.ctx.grants.register(new File([text], 'x.empbackup'), 'restore');
    await expectCode((await api.backup.restore({ grantId: bad.grantId, password: 'nope' })).result, 'BAD_PASSWORD');

    const tampered = text.replace(/"bytes":(\d+)/, (_m, n: string) => `"bytes":${Number(n) + 1}`);
    const t = backend.ctx.grants.register(new File([tampered], 'x.empbackup'), 'restore');
    await expectCode((await api.backup.restore({ grantId: t.grantId, password: 'hunter2hunter2' })).result, 'INTEGRITY');

    const ok = backend.ctx.grants.register(new File([text], 'x.empbackup'), 'restore');
    const before = (await api.vault.status()).vaultId;
    const r = await (await api.backup.restore({ grantId: ok.grantId, password: 'hunter2hunter2' })).result;
    expect(r.pages).toBeGreaterThan(10);
    expect(r.vaultId).not.toBe(before);
  });

  test('snapshots need encryption; with it they are listed, pruned and verified', async () => {
    const plain = await mockApi();
    await expectCode((await plain.api.snapshot.now({} as never)).result, 'UNSUPPORTED');
    const { api } = await mockApi({ encrypted: true });
    const list = await api.snapshot.list();
    expect(list.length).toBeGreaterThan(5);
    const { id } = await (await api.snapshot.now({} as never)).result;
    expect((await api.snapshot.list())[0].id).toBe(id);
    expect((await (await api.snapshot.verify({ id })).result).ok).toBe(true);
  });
});
