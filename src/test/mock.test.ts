import { describe, expect, test } from 'vitest';
import type { JobEvent, TipTapDoc } from '@/backend/types';
import { b, makeDoc, t } from '@/backend/mock/lib/doc';
import { expectCode, mockApi } from './helpers';

const doc = (...blocks: ReturnType<typeof b.p>[]): TipTapDoc => makeDoc(blocks);

describe('vault', () => {
  test('empty seed starts uninitialised; data commands are LOCKED until vault_create', async () => {
    const { api } = await mockApi({ seed: 'empty' });
    expect((await api.vault.status()).state).toBe('uninitialized');
    await expectCode(api.workspace.list(), 'LOCKED');
    expect((await api.settings.get()).vault).toBeUndefined();
    const res = await api.vault.create({
      password: 'correct horse battery',
      profile: 'standard',
      autoLock: { idleMinutes: 15, onSleep: true, onScreenLock: true, onBlurMinutes: null, maxSessionHours: null },
    });
    expect(res.status.state).toBe('unlocked');
    expect(res.status.encrypted).toBe(true);
    expect(res.recoveryWords).toHaveLength(24);
    const [ws] = await api.workspace.list();
    const open = await api.workspace.open({ id: ws.id });
    expect(open.pages.map((p) => p.title)).toContain('Getting Started');
    expect(open.workspace.favorites).toHaveLength(1);
  });

  test('lock, wrong password with backoff, unlock with "demo"', async () => {
    const { api, backend } = await mockApi({ encrypted: true });
    const events: string[] = [];
    backend.listen('vault:will-lock', () => events.push('will-lock'));
    backend.listen('vault:locked', (e) => events.push(`locked:${e.reason}`));
    await api.vault.lock({ reason: 'manual' });
    expect((await api.vault.status()).state).toBe('locked');
    await expectCode(api.page.get({ id: 'x' }), 'LOCKED');
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['will-lock', 'locked:manual']);

    for (let i = 0; i < 4; i++) await expectCode(api.vault.unlock({ password: 'nope' }), 'BAD_PASSWORD');
    await expectCode(api.vault.unlock({ password: 'nope' }), 'BAD_PASSWORD'); // 5th → 1 s backoff
    const st = await api.vault.status();
    expect(st.failedAttempts).toBe(5);
    expect(st.retryAfterMs).toBeGreaterThan(0);
    await expectCode(api.vault.unlock({ password: 'demo' }), 'RATE_LIMITED');
    backend.ctx.clock.advance(1500);
    const ok = await api.vault.unlock({ password: 'demo' });
    expect(ok.state).toBe('unlocked');
    expect(ok.failedAttempts).toBe(0);
  }, 15_000);

  test('re-auth gates recovery key and expires after 5 minutes', async () => {
    const { api, backend } = await mockApi({ encrypted: true });
    await expectCode(api.vault.recoveryRegenerate(), 'REAUTH_REQUIRED');
    await api.vault.reauth({ password: 'demo' });
    const { words } = await api.vault.recoveryRegenerate();
    expect(words).toHaveLength(24);
    const confirm = await api.vault.recoveryConfirm({ positions: [0, 5, 23], words: [words[0], words[5], words[23]] });
    expect(confirm.confirmed).toBe(true);
    await expectCode(api.vault.recoveryView(), 'UNSUPPORTED');
    backend.ctx.clock.advance(5 * 60_000 + 1);
    await expectCode(api.vault.recoveryRegenerate(), 'REAUTH_REQUIRED');
  }, 15_000);

  test('idle auto-lock trips from the clock', async () => {
    const { api, backend } = await mockApi({ encrypted: true });
    const soon: number[] = [];
    backend.listen('vault:autolock-soon', (e) => soon.push(e.secondsLeft));
    const locked = new Promise<string>((res) => backend.listen('vault:locked', (e) => res(e.reason)));
    backend.ctx.clock.advance(14 * 60_000 + 30_000);
    await new Promise((r) => setTimeout(r, 1100));
    expect(soon.length).toBeGreaterThan(0);
    backend.ctx.clock.advance(60_000);
    expect(await locked).toBe('idle');
    expect((await api.vault.status()).state).toBe('locked');
  }, 15_000);
});

describe('pages and docs', () => {
  test('create, save with revs, CONFLICT on stale base, outline + block lookup', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const { meta, docRev } = await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Plan' });
    expect(docRev).toBe(0);
    const d = doc(b.h1('Goals', { id: 'blk000000001' }), b.p('Ship it.'), b.h2('Risks', { id: 'blk000000002' }));
    const { rev } = await api.page.saveDoc({ ownerId: meta.id, ownerKind: 'page', doc: d, baseRev: 0 });
    expect(rev).toBe(1);
    await expectCode(api.page.saveDoc({ ownerId: meta.id, ownerKind: 'page', doc: d, baseRev: 0 }), 'CONFLICT');
    try {
      await api.page.saveDoc({ ownerId: meta.id, ownerKind: 'page', doc: d, baseRev: 0 });
    } catch (e) {
      expect((e as { details?: { currentRev?: number } }).details?.currentRev).toBe(1);
    }
    const got = await api.page.get({ id: meta.id });
    expect(got.docRev).toBe(1);
    expect(got.breadcrumbs.map((c) => c.title)).toEqual(['Plan']);
    expect(await api.page.outline({ id: meta.id })).toEqual([
      { blockId: 'blk000000001', level: 1, text: 'Goals' },
      { blockId: 'blk000000002', level: 2, text: 'Risks' },
    ]);
    const block = await api.page.getBlock({ pageId: meta.id, blockId: 'blk000000002' });
    expect(block?.node.type).toBe('blockContainer');
  });

  test('responses are structured clones (mutating them never touches the store)', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const a = await api.workspace.open({ id: ws.id });
    a.pages[0].title = 'hacked';
    const b2 = await api.workspace.open({ id: ws.id });
    expect(b2.pages[0].title).not.toBe('hacked');
  });

  test('move rejects cycles; delete/restore/purge with trash listing', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const p = (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Root' })).meta;
    const c = (await api.page.create({ workspaceId: ws.id, parentId: p.id, kind: 'doc', title: 'Child' })).meta;
    await expectCode(api.page.move({ id: p.id, parentId: c.id }), 'INVALID');

    await api.page.delete({ ids: [p.id] });
    await expectCode(api.page.get({ id: c.id }), 'NOT_FOUND');
    const trash = await api.trash.list({ workspaceId: ws.id });
    expect(trash.map((x) => x.title)).toContain('Root');
    expect(trash.map((x) => x.title)).not.toContain('Child'); // only roots
    expect((await api.trash.list({ workspaceId: ws.id, q: 'roo' })).map((x) => x.title)).toEqual(['Root']);

    const restored = await api.page.restore({ ids: [p.id] });
    expect(restored[0].title).toBe('Root');
    expect((await api.page.get({ id: c.id })).meta.parentId).toBe(p.id);

    await api.page.delete({ ids: [c.id] });
    await api.page.purge({ ids: [c.id] });
    expect(await api.page.getMeta({ ids: [c.id] })).toEqual([]);
  });

  test('restore goes to the root when the parent is gone', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const p = (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'P' })).meta;
    const c = (await api.page.create({ workspaceId: ws.id, parentId: p.id, kind: 'doc', title: 'C' })).meta;
    await api.page.delete({ ids: [c.id] });
    await api.page.delete({ ids: [p.id] });
    await api.page.purge({ ids: [p.id] });
    // Purging the parent purges the subtree too, so c is gone with it.
    expect(await api.page.getMeta({ ids: [c.id] })).toEqual([]);

    const p2 = (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'P2' })).meta;
    const c2 = (await api.page.create({ workspaceId: ws.id, parentId: p2.id, kind: 'doc', title: 'C2' })).meta;
    await api.page.delete({ ids: [c2.id] });
    await api.page.delete({ ids: [p2.id] });
    const [back] = await api.page.restore({ ids: [c2.id] });
    expect(back.parentId).toBeNull();
  });

  test('backlinks from mentions, page links and internal links, with snippets', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const target = (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Target' })).meta;
    const src = (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Source' })).meta;
    await api.page.saveDoc({
      ownerId: src.id,
      ownerKind: 'page',
      baseRev: 0,
      doc: doc(
        b.p(['See ', t.mention(target.id), ' for the plan.'], { id: 'mention00001' }),
        b.p([...t.link('this link', `emp://page/${target.id}`)], { id: 'link00000001' }),
        b.pageLink(target.id, { id: 'pagelink0001' }),
      ),
    });
    const links = await api.page.backlinks({ id: target.id });
    expect(links.map((l) => l.blockId).sort()).toEqual(['link00000001', 'mention00001', 'pagelink0001']);
    expect(links.find((l) => l.blockId === 'mention00001')?.snippet).toContain('for the plan');
    expect(links.every((l) => l.sourceTitle === 'Source')).toBe(true);
  });

  test('turn into page moves blocks into a new child and leaves a sub-page block', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const src = (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Long' })).meta;
    await api.page.saveDoc({
      ownerId: src.id,
      ownerKind: 'page',
      baseRev: 0,
      doc: doc(b.p('keep', { id: 'keep00000001' }), b.p('move 1', { id: 'move00000001' }), b.p('move 2', { id: 'move00000002' })),
    });
    const res = await api.page.turnIntoPage({ sourceId: src.id, blockIds: ['move00000001', 'move00000002'], title: 'Extracted' });
    expect(res.meta.parentId).toBe(src.id);
    const child = await api.page.get({ id: res.meta.id });
    expect(JSON.stringify(child.doc)).toContain('move 2');
    const parent = await api.page.get({ id: src.id });
    expect(parent.docRev).toBe(res.newSourceRev);
    expect(JSON.stringify(parent.doc)).not.toContain('move 1');
    expect(JSON.stringify(parent.doc)).toContain(res.meta.id);
  });

  test('duplicate (job) streams progress, copies the subtree with fresh block ids', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const open = await api.workspace.open({ id: ws.id });
    const gs = open.pages.find((p) => p.title === 'Getting Started');
    expect(gs).toBeDefined();
    const events: JobEvent[] = [];
    const job = await api.page.duplicate({ id: gs!.id, deep: true, onEvent: (e) => events.push(e) });
    expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/);
    const copy = await job.result;
    expect(copy.title).toBe('Getting Started (copy)');
    expect(events.some((e) => e.kind === 'progress' && e.total >= 5)).toBe(true);
    expect(events[events.length - 1].kind).toBe('done');
    const after = await api.workspace.open({ id: ws.id });
    expect(after.pages.filter((p) => p.parentId === copy.id).map((p) => p.title)).toEqual([
      'Writing in Ultranote',
      'Keyboard shortcuts',
      'Privacy & encryption',
      'Money & life apps',
    ]);
    const a = await api.page.get({ id: gs!.id });
    const c = await api.page.get({ id: copy.id });
    const ids = (d: unknown) => [...JSON.stringify(d).matchAll(/"id":"([^"]{12})"/g)].map((m) => m[1]);
    expect(ids(a.doc).some((id) => ids(c.doc).includes(id))).toBe(false);
  });

  test('versions: auto version on first save, manual create, restore keeps a pre_restore copy', async () => {
    const { api, backend } = await mockApi();
    const [ws] = await api.workspace.list();
    const p = (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'V' })).meta;
    await api.page.saveDoc({ ownerId: p.id, ownerKind: 'page', baseRev: 0, doc: doc(b.p('first draft')) });
    const v1 = await api.version.create({ targetId: p.id, targetKind: 'page_doc', label: 'Draft 1' });
    backend.ctx.clock.advance(11 * 60_000);
    await api.page.saveDoc({ ownerId: p.id, ownerKind: 'page', baseRev: 1, doc: doc(b.p('a completely rewritten second draft with plenty more words in it than before')) });
    const list = await api.version.list({ targetId: p.id, targetKind: 'page_doc' });
    expect(list.map((v) => v.reason)).toEqual(['auto', 'manual', 'auto']);
    const { rev } = await api.version.restore({ id: v1.id });
    expect(rev).toBe(3);
    expect(JSON.stringify((await api.page.get({ id: p.id })).doc)).toContain('first draft');
    expect((await api.version.list({ targetId: p.id, targetKind: 'page_doc' }))[0].reason).toBe('pre_restore');
  });

  test('daily notes are created once, under Journal, newest first', async () => {
    const { api } = await mockApi();
    const a = await api.daily.noteOpen({ date: '2026-11-27' });
    const again = await api.daily.noteOpen({ date: '2026-11-27' });
    expect(again.id).toBe(a.id);
    expect(a.title).toBe('Friday, Nov 27, 2026');
    const [ws] = await api.workspace.list();
    const open = await api.workspace.open({ id: ws.id });
    const journal = open.pages.find((p) => p.title === 'Journal');
    const notes = open.pages.filter((p) => p.parentId === journal?.id).sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1));
    expect(notes[0].id).toBe(a.id);
    await expectCode(api.daily.noteOpen({ date: '2026-02-30' }), 'INVALID');
  });

  test('templates: builtins + page templates; apply regenerates ids', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const list = await api.template.list({ workspaceId: ws.id });
    expect(list.find((x) => x.id === 'builtin:meeting-notes')?.builtin).toBe(true);
    const mine = list.find((x) => !x.builtin);
    expect(mine?.title).toBe('Weekly 1:1');
    const page = await api.template.apply({ templateId: mine!.id, workspaceId: ws.id, parentId: null });
    expect(page.flags.template).toBeFalsy();
    const meeting = await api.template.apply({ templateId: 'builtin:meeting-notes', workspaceId: ws.id, parentId: null });
    expect((await api.page.get({ id: meeting.id })).doc?.content[0].content?.length).toBeGreaterThan(4);
  });

  test('Getting Started ticks itself', async () => {
    const { api } = await mockApi();
    const [ws] = await api.workspace.list();
    const open = await api.workspace.open({ id: ws.id });
    const gs = open.pages.find((p) => p.title === 'Getting Started')!;
    const checked = async () => (JSON.stringify((await api.page.get({ id: gs.id })).doc).match(/"checked":true/g) ?? []).length;
    expect(await checked()).toBe(0);
    await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Mine' });
    await api.kv.set({ ns: 'ui.gettingStarted', key: 'open_palette', value: 1 });
    await api.template.list({ workspaceId: ws.id });
    expect(await checked()).toBe(3);
  });
});

describe('search', () => {
  test('titles and body text with snippets, prefix matching and operators', async () => {
    const { api } = await mockApi();
    const res = await api.search.query({ q: 'argon', limit: 5, reqId: 7 });
    expect(res.reqId).toBe(7);
    expect(res.hits[0].title).toBe('Privacy & encryption');
    expect(res.hits[0].snippet?.text.toLowerCase()).toContain('argon2id');
    const [s, e] = res.hits[0].snippet!.ranges[0];
    expect(res.hits[0].snippet!.text.slice(s, e).toLowerCase()).toBe('argon');
    expect(res.hits[0].blockId).toBeTruthy();

    const prefix = await api.search.query({ q: 'kitch', limit: 5, reqId: 1 });
    // Both the "Kitchen renovation" page and the Life OS "Kitchen refresh" project match the prefix.
    expect(prefix.hits[0].title.startsWith('Kitchen')).toBe(true);
    expect(prefix.hits.map((h) => h.title)).toContain('Kitchen renovation');

    const scoped = await api.search.query({ q: 'in:"Getting Started" shortcuts', limit: 10, reqId: 2 });
    expect(scoped.hits.every((h) => h.path[0] === 'Getting Started' || h.title === 'Getting Started')).toBe(true);

    const none = await api.search.query({ q: 'zzzxqv', limit: 5, reqId: 3 });
    expect(none.hits).toEqual([]);
    await expectCode(api.search.query({ q: 'x'.repeat(600), limit: 5, reqId: 4 }), 'INVALID');
  });
});

describe('dispatcher', () => {
  test('fail injection and UNSUPPORTED for unimplemented commands', async () => {
    const { api } = await mockApi({ fail: [{ command: 'workspace_list', code: 'IO', prob: 1 }] });
    await expectCode(api.workspace.list(), 'IO');
    const { api: api2 } = await mockApi();
    await expectCode(api2.app.revealDataDir(), 'UNSUPPORTED');
  });

  test('kv validates namespaces; settings validate values', async () => {
    const { api } = await mockApi();
    await expectCode(api.kv.set({ ns: 'secret.x' as `ui.${string}`, key: 'k', value: 1 }), 'INVALID');
    await api.kv.set({ ns: 'ui.test', key: 'k', value: { a: 1 } });
    expect(await api.kv.get({ ns: 'ui.test', key: 'k' })).toEqual({ a: 1 });
    expect(await api.kv.getMany({ ns: 'ui.test', keys: ['k', 'missing'] })).toEqual({ k: { a: 1 } });
    await expectCode(api.settings.setDevice({ patch: { theme: 'neon' as 'dark' } }), 'INVALID');
    expect((await api.settings.setDevice({ patch: { theme: 'midnight' } })).theme).toBe('midnight');
  });

  test('secrets are write-only', async () => {
    const { api } = await mockApi();
    const s = await api.secret.set({ provider: 'finnhub', label: 'Finnhub key', kind: 'api_key', value: 'sk_live_abcdef123456', showLast4: true });
    expect(s.id.startsWith('secret:')).toBe(true);
    expect(s.last4).toBe('3456');
    const list = await api.secret.list();
    expect(JSON.stringify(list)).not.toContain('sk_live');
  });

  test('password strength and passphrase generation', async () => {
    const { api } = await mockApi();
    const weak = await api.password.strength({ password: 'password1' });
    expect(weak.score).toBeLessThan(2);
    expect(weak.common).toBe(true);
    const strong = await api.password.strength({ password: 'violin-harbor-tundra-saffron-quiver' });
    expect(strong.score).toBeGreaterThanOrEqual(3);
    const gen = await api.password.generate();
    expect(gen.passphrase.split(/[-._/ ]/)).toHaveLength(5);
    expect(gen.bits).toBeCloseTo(64.6);
  });

  test('job cancel reports CANCELLED', async () => {
    const { api } = await mockApi();
    const job = await api.search.reindex();
    await job.cancel();
    await expectCode(job.result, 'CANCELLED');
  });
});
