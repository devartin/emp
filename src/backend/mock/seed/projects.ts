/**
 * Projects seed (demo; brief §2.2). Runs after the core and database seeds and gives the demo the 1.0 layout:
 *
 *   Projects       Website relaunch (a document, a spreadsheet, a database) · Lisbon in March (two documents and a
 *                  spreadsheet)
 *   Documents      Kitchen renovation moves to the top level; the old "Projects" folder page goes away
 *
 * Refs: 'projects.relaunch', 'projects.trip'; 'core.page.projects' now points at "Website relaunch" (the shell seed
 * files a trashed draft there).
 */
import type { Icon, Id } from '../../types';
import type { MockCtx, PageRecord } from '../ctx';
import { createWorkbook } from '../commands/sheet';
import { b, makeDoc } from '../lib/doc';

export const order = 25;

const DAY = 86_400_000;
const lucide = (v: string): Icon => ({ t: 'lucide', v });

export function seed(ctx: MockCtx): void {
  if (ctx.seedKind !== 'demo') return;
  const ws = ctx.db.table<{ id: string }>('workspaces').all()[0]?.id;
  if (!ws) return;
  const now = ctx.clock.now();
  const pages = ctx.pages;
  const live = (title: string, kind?: PageRecord['kind']) =>
    pages.table().find((p: PageRecord) => p.workspaceId === ws && !p.deletedAt && p.title === title && (!kind || p.kind === kind));

  const relaunch = live('Website relaunch', 'doc');
  const trip = live('Lisbon in March', 'doc');
  if (!relaunch || !trip) return;
  const folder = relaunch.parentId ? pages.get(relaunch.parentId) : undefined;
  const kitchen = live('Kitchen renovation', 'doc');
  const tracker = live('Project tracker', 'database');
  const gettingStarted = ctx.seedRefs.get('core.page.gettingStarted');
  // Seeding rearranges, it doesn't edit: keep each page's "last edited".
  const place = (id: Id, parentId: Id | null, opts: { afterId?: Id } = {}) => {
    const at = pages.require(id).updatedAt;
    pages.move(id, parentId, opts);
    pages.table().update(id, (r) => void (r.updatedAt = at));
  };
  const makeProject = (id: Id) => pages.table().update(id, (r) => void (r.flags = { ...r.flags, project: true }));

  // Website relaunch: a top-level project holding its checklist, the tracker and a budget.
  place(relaunch.id, null, gettingStarted ? { afterId: gettingStarted } : {});
  makeProject(relaunch.id);
  if (tracker && tracker.parentId !== relaunch.id) place(tracker.id, relaunch.id);
  const budget = createWorkbook(ctx, {
    workspaceId: ws,
    parentId: relaunch.id,
    title: 'Launch budget',
    icon: lucide('receipt'),
    createdAt: now - 18 * DAY,
    silent: true,
    build: (bk) => {
      const sh = bk.sheet('Budget');
      const head = { font: { b: true } };
      sh.at(0, 0, 'Item', head).at(0, 1, 'Owner', head).at(0, 2, 'Estimate', head).at(0, 3, 'Spent', head);
      const rows: [string, string, number, number][] = [
        ['Copywriting', 'Sam', 2400, 1800],
        ['Illustrations', 'Maya', 3200, 3200],
        ['Performance audit', 'Jonah', 1500, 0],
        ['Launch ads', 'Sam', 4000, 650],
      ];
      rows.forEach(([item, owner, est, spent], i) => {
        sh.at(i + 1, 0, item).at(i + 1, 1, owner).at(i + 1, 2, est, { numFmt: '$#,##0' }).at(i + 1, 3, spent, { numFmt: '$#,##0' });
      });
      const last = rows.length + 1;
      sh.at(last, 0, 'Total', head).at(last, 2, `=SUM(C2:C${last})`, { numFmt: '$#,##0', font: { b: true } }).at(last, 3, `=SUM(D2:D${last})`, { numFmt: '$#,##0', font: { b: true } });
      sh.freeze(1, 0).width('A', 180).width('B', 100);
    },
  });

  // Lisbon in March: a top-level project with its plans and a trip budget.
  makeProject(trip.id);
  const doc = (title: string, icon: string, age: number, blocks: Parameters<typeof makeDoc>[0]): Id =>
    pages.create({ workspaceId: ws, parentId: trip.id, kind: 'doc', title, icon: lucide(icon), createdAt: now - age * DAY, updatedAt: now - (age / 3) * DAY, silent: true, doc: makeDoc(blocks) }).id;
  doc('Flights and stay', 'plane', 11, [
    b.h2('Flights'),
    b.bullet('Out on the 9:40 from Gatwick, back on the Sunday evening flight'),
    b.bullet('Seats 14A and 14B, one cabin bag each'),
    b.h2('Stay'),
    b.p('Apartment in Alfama, five minutes from the tram 28 stop. Check-in from 3 pm, key box by the door.'),
    b.todo('Send passport details to the host', true),
    b.todo('Book the airport transfer'),
  ]);
  doc('Places to eat', 'utensils', 9, [
    b.p('Shortlist from friends and the food blog. Book the first two ahead.'),
    b.todo('Taberna da Rua das Flores'),
    b.todo('Cervejaria Ramiro for seafood'),
    b.todo('Pastéis de Belém, early before the queue'),
    b.todo('A Cevicheria in Príncipe Real'),
  ]);
  const tripBudget = createWorkbook(ctx, {
    workspaceId: ws,
    parentId: trip.id,
    title: 'Trip budget',
    icon: lucide('wallet'),
    createdAt: now - 10 * DAY,
    silent: true,
    build: (bk) => {
      const sh = bk.sheet('Budget');
      const head = { font: { b: true } };
      sh.at(0, 0, 'Category', head).at(0, 1, 'Planned', head).at(0, 2, 'Booked', head);
      const rows: [string, number, number][] = [
        ['Flights', 360, 360],
        ['Stay', 780, 780],
        ['Food', 420, 0],
        ['Trips and tickets', 180, 46],
      ];
      rows.forEach(([cat, plan, booked], i) => {
        sh.at(i + 1, 0, cat).at(i + 1, 1, plan, { numFmt: '€#,##0' }).at(i + 1, 2, booked, { numFmt: '€#,##0' });
      });
      const last = rows.length + 1;
      sh.at(last, 0, 'Total', head).at(last, 1, `=SUM(B2:B${last})`, { numFmt: '€#,##0', font: { b: true } }).at(last, 2, `=SUM(C2:C${last})`, { numFmt: '€#,##0', font: { b: true } });
      sh.freeze(1, 0).width('A', 160);
    },
  });

  // Kitchen renovation becomes an ordinary top-level document; the old folder page has nothing left to hold.
  if (kitchen && kitchen.parentId) place(kitchen.id, null, { afterId: trip.id });
  if (folder && folder.title === 'Projects' && !pages.children(folder.id).length) pages.purge([folder.id]);

  ctx.seedRefs.set('core.page.projects', relaunch.id);
  ctx.seedRefs.set('projects.relaunch', relaunch.id);
  ctx.seedRefs.set('projects.trip', trip.id);
  pages.emitTree(ws, [relaunch.id, trip.id, budget.page.id, tripBudget.page.id, ...(kitchen ? [kitchen.id] : [])]);
}
