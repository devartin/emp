/** version_* — history for page docs (built in) and other targets (via ctx.versions.onRestore / snapshot services). */
import { BackendError } from '../../errors';
import type { TipTapDoc } from '../../types';
import type { MockHandlers } from '../ctx';
import { byNewest, toVersionMeta, type VersionRecord, type VersionsEngine } from '../lib/versions';

export const handlers: MockHandlers = {
  version_list: (req, ctx) =>
    ctx.db
      .table<VersionRecord>('versions')
      .filter((v) => v.targetId === req.targetId && v.targetKind === req.targetKind)
      .sort(byNewest)
      .map(toVersionMeta),

  version_get: (req, ctx) => ({ snapshot: ctx.db.table<VersionRecord>('versions').require(req.id, 'Version').snapshot }),

  version_create: (req, ctx) => {
    const label = (req.label ?? '').trim();
    if (label.length > 200) throw new BackendError('INVALID', 'That name is too long', { field: 'label' });
    let snapshot: unknown;
    if (req.targetKind === 'page_doc') {
      ctx.pages.require(req.targetId);
      snapshot = ctx.docs.get(req.targetId)?.doc ?? ctx.docs.emptyDoc();
    } else {
      const snap = ctx.services.get<(id: string) => unknown>(`versions.snapshot:${req.targetKind}`);
      if (!snap) throw new BackendError('UNSUPPORTED', 'Versions for this item are not available in the browser preview');
      snapshot = snap(req.targetId);
    }
    return ctx.versions.create({ targetId: req.targetId, targetKind: req.targetKind, reason: 'manual', label: label || undefined, snapshot });
  },

  version_restore: (req, ctx) => {
    const v = ctx.db.table<VersionRecord>('versions').require(req.id, 'Version');
    if (v.targetKind === 'page_doc') {
      const page = ctx.pages.require(v.targetId);
      const current = ctx.docs.get(page.id);
      if (current) ctx.versions.create({ targetId: page.id, targetKind: 'page_doc', reason: 'pre_restore', snapshot: current.doc });
      const saved = ctx.docs.save(page.id, 'page', structuredClone(v.snapshot as TipTapDoc));
      ctx.pages.touch(page.id);
      ctx.emit('page:changed', { id: page.id, docRev: saved.rev });
      return { rev: saved.rev };
    }
    const restore = (ctx.versions as VersionsEngine).restorer(v.targetKind);
    if (!restore) throw new BackendError('UNSUPPORTED', 'Restoring this item is not available in the browser preview');
    return { rev: restore(v.targetId, structuredClone(v.snapshot)) };
  },

  version_delete: (req, ctx) => {
    if (!ctx.db.table<VersionRecord>('versions').delete(req.id)) throw new BackendError('NOT_FOUND', 'Version not found');
  },
};
