/**
 * Shell seed (demo): a few more pages in Trash at different ages — one with sub-pages — so the Trash view shows
 * grouping, original locations and nested restores. Runs after the core seed (which creates the workspace).
 */
import type { Icon } from '../../types';
import type { MockCtx } from '../ctx';
import { b, makeDoc } from '../lib/doc';

export const order = 90;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const lucide = (v: string): Icon => ({ t: 'lucide', v });

export function seed(ctx: MockCtx): void {
  if (ctx.seedKind !== 'demo') return;
  const ws = ctx.db.table<{ id: string }>('workspaces').all()[0]?.id;
  if (!ws) return;
  const projects = ctx.seedRefs.get('core.page.projects') ?? null;
  const now = ctx.clock.now();

  const items: { title: string; icon: Icon; parent: string | null; age: number; doc: ReturnType<typeof makeDoc>; kids?: string[] }[] = [
    {
      title: 'Kitchen renovation quotes',
      icon: lucide('hammer'),
      parent: null,
      age: 2 * HOUR,
      doc: makeDoc([b.p('Three quotes so far; the second one includes the worktop.'), b.bullet('Quote A — 6 weeks'), b.bullet('Quote B — 4 weeks')]),
      kids: ['Contractor shortlist', 'Tile samples'],
    },
    {
      title: 'Q2 offsite agenda (draft)',
      icon: lucide('calendar'),
      parent: projects,
      age: 26 * HOUR,
      doc: makeDoc([b.h2('Day one'), b.p('Morning: retrospective. Afternoon: planning.')]),
    },
    {
      title: 'Untitled',
      icon: lucide('notebook-pen'),
      parent: null,
      age: 9 * DAY,
      doc: makeDoc([b.p('')]),
    },
  ];

  for (const it of items) {
    const created = now - it.age - 12 * DAY;
    const page = ctx.pages.create({
      workspaceId: ws,
      parentId: it.parent && ctx.pages.get(it.parent) ? it.parent : null,
      kind: 'doc',
      title: it.title,
      icon: it.icon,
      createdAt: created,
      updatedAt: created + DAY,
      silent: true,
      doc: it.doc,
    });
    for (const k of it.kids ?? []) {
      ctx.pages.create({ workspaceId: ws, parentId: page.id, kind: 'doc', title: k, createdAt: created, updatedAt: created, silent: true, doc: makeDoc([b.p('')]) });
    }
    ctx.pages.trash([page.id]);
    const deletedAt = now - it.age;
    for (const rec of [page, ...ctx.pages.table().all().filter((r) => r.parentId === page.id)]) {
      ctx.pages.table().update(rec.id, (r) => {
        r.deletedAt = deletedAt;
      });
    }
  }
}
