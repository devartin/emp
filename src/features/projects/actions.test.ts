/**
 * "Moved X to project · Undo" (brief §2.2): the toast's Undo reverts that move, not whatever command is newest.
 * Runs the real tree store against the mock backend.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { Id } from '@/backend/types';

const toasts: { title: string; onUndo: () => void | Promise<void> }[] = [];

vi.mock('@/backend', async (orig) => {
  const real = await orig<typeof import('@/backend')>();
  const { mockApi } = await import('@/test/helpers');
  const { api } = await mockApi();
  return { ...real, api, default: api };
});
vi.mock('@/stores/toasts', () => {
  const quiet = () => 'id';
  return {
    notify: {
      success: quiet,
      info: quiet,
      warning: quiet,
      error: quiet,
      fromError: quiet,
      undo: (title: string, onUndo: () => void | Promise<void>) => {
        toasts.push({ title, onUndo });
        return 'id';
      },
    },
  };
});

describe('moving into a project', () => {
  let ids: Record<string, Id> = {};
  beforeAll(async () => {
    const { api } = await import('@/backend');
    const { useTree } = await import('@/stores/tree');
    const [ws] = await api.workspace.list();
    const make = async (title: string, project = false) => (await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title, ...(project ? { flags: { project: true } } : {}) })).meta;
    const proj = await make('Garden', true);
    const a = await make('Seeds');
    const b = await make('Tools');
    const { pages } = await api.workspace.open({ id: ws.id });
    useTree.getState().load(ws.id, pages);
    ids = { proj: proj.id, a: a.id, b: b.id };
  });

  test("the first toast's Undo reverts the first move, not the second", async () => {
    const { useTree } = await import('@/stores/tree');
    const { moveIntoProject } = await import('./actions');
    expect(await moveIntoProject(ids.a, ids.proj)).toBe(true);
    expect(await moveIntoProject(ids.b, ids.proj)).toBe(true);
    expect(toasts.map((t) => t.title)).toEqual(['Moved “Seeds” to “Garden”', 'Moved “Tools” to “Garden”']);
    await toasts[0].onUndo();
    const byId = useTree.getState().byId;
    expect(byId.get(ids.a)?.parentId).toBeNull();
    expect(byId.get(ids.b)?.parentId).toBe(ids.proj);
  });
});
