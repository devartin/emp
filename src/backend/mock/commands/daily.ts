/** daily_note_open — finds or creates the note for a date under "Journal", newest first. */
import { BackendError } from '../../errors';
import type { MockHandlers, PageRecord } from '../ctx';
import { dailyNoteDoc, dailyTitle, isIsoDate } from '../lib/templates';
import { pushRecent } from './page';

export const handlers: MockHandlers = {
  daily_note_open: (req, ctx) => {
    if (!isIsoDate(req.date)) throw new BackendError('INVALID', 'Dates look like 2026-11-26', { field: 'date' });
    const workspaceId = ctx.workspaceId();
    const pages = ctx.pages.table();
    const key = `daily:${req.date}`;
    const existing = pages.find((p) => p.templateKey === key && !p.deletedAt && p.workspaceId === workspaceId);
    if (existing) {
      pushRecent(ctx, workspaceId, existing.id);
      return ctx.pages.toMeta(existing);
    }
    let root: PageRecord | undefined = pages.find((p) => p.templateKey === 'daily:root' && !p.deletedAt && p.workspaceId === workspaceId);
    if (!root) {
      root = ctx.pages.create({
        workspaceId,
        parentId: null,
        kind: 'doc',
        title: 'Journal',
        icon: { t: 'emoji', v: '📓' },
        templateKey: 'daily:root',
      });
    }
    // Keep notes in descending date order.
    const siblings = ctx.pages.children(root.id, workspaceId).filter((p) => p.templateKey?.startsWith('daily:'));
    const before = siblings.find((p) => (p.templateKey as string).slice(6) < req.date);
    const rec = ctx.pages.create({
      workspaceId,
      parentId: root.id,
      kind: 'doc',
      title: dailyTitle(req.date),
      icon: { t: 'emoji', v: req.date === ctx.clock.today() ? '☀️' : '🗓️' },
      templateKey: key,
      beforeId: before?.id,
      doc: dailyNoteDoc(),
    });
    pushRecent(ctx, workspaceId, rec.id);
    return ctx.pages.toMeta(rec);
  },
};
