import { describe, expect, test } from 'vitest';
import { generateKeyBetween, generateNKeysBetween } from '@/lib/fractional-index';
import { mockApi } from './helpers';

describe('fractional sort keys', () => {
  test('keys stay ordered under repeated inserts at the front, back and middle', () => {
    const keys: string[] = [generateKeyBetween(null, null)];
    for (let i = 0; i < 200; i++) {
      const pick = i % 3;
      if (pick === 0) keys.unshift(generateKeyBetween(null, keys[0]));
      else if (pick === 1) keys.push(generateKeyBetween(keys[keys.length - 1], null));
      else {
        const j = Math.floor(keys.length / 2);
        keys.splice(j, 0, generateKeyBetween(keys[j - 1], keys[j]));
      }
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('generateNKeysBetween spreads keys strictly inside the bounds', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const mid = generateNKeysBetween(a, b, 10);
    expect(mid).toHaveLength(10);
    expect([a, ...mid, b]).toEqual([a, ...mid, b].slice().sort());
  });
});

describe('page tree ordering (mock backend)', () => {
  test('create with afterId and move with before/after place pages exactly', async () => {
    const { api } = await mockApi({ seed: 'demo' });
    const [ws] = await api.workspace.list();
    const { meta: parent } = await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Parent' });
    const a = (await api.page.create({ workspaceId: ws.id, parentId: parent.id, kind: 'doc', title: 'A' })).meta;
    const c = (await api.page.create({ workspaceId: ws.id, parentId: parent.id, kind: 'doc', title: 'C' })).meta;
    const b = (await api.page.create({ workspaceId: ws.id, parentId: parent.id, kind: 'doc', title: 'B', afterId: a.id })).meta;

    const titles = async () => {
      const { pages } = await api.workspace.open({ id: ws.id });
      return pages.filter((p) => p.parentId === parent.id).sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1)).map((p) => p.title);
    };
    expect(await titles()).toEqual(['A', 'B', 'C']);

    await api.page.move({ id: c.id, parentId: parent.id, beforeId: a.id });
    expect(await titles()).toEqual(['C', 'A', 'B']);
    await api.page.move({ id: c.id, parentId: parent.id, afterId: b.id });
    expect(await titles()).toEqual(['A', 'B', 'C']);
    await api.page.move({ id: a.id, parentId: parent.id, afterId: b.id });
    expect(await titles()).toEqual(['B', 'A', 'C']);
  });
});
