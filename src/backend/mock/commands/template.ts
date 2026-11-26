/** template_list / template_apply — built-in templates plus pages flagged as templates. */
import { BackendError } from '../../errors';
import type { TemplateInfo } from '../../types';
import type { MockHandlers } from '../ctx';
import { regenerateIds } from '../lib/doc';
import { BUILTIN_TEMPLATES, findBuiltin } from '../lib/templates';
import { pushRecent } from './page';

export const handlers: MockHandlers = {
  template_list: (req, ctx) => {
    const builtin: TemplateInfo[] = BUILTIN_TEMPLATES.map((tpl) => ({
      id: tpl.id,
      title: tpl.title,
      icon: tpl.icon,
      builtin: true,
      category: tpl.category,
      kind: tpl.kind,
    }));
    const mine: TemplateInfo[] = ctx.pages
      .table()
      .filter((p) => p.workspaceId === req.workspaceId && !p.deletedAt && !!p.flags.template)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((p) => {
        const info: TemplateInfo = { id: p.id, title: p.title || 'Untitled', builtin: false, category: 'My templates', kind: p.kind };
        if (p.icon) info.icon = p.icon;
        return info;
      });
    if (!ctx.seeding) ctx.events.internal('gettingStarted:tick', { item: 'templates' });
    return [...mine, ...builtin];
  },

  template_apply: (req, ctx) => {
    const builtin = findBuiltin(req.templateId);
    if (builtin) {
      const rec = ctx.pages.create({
        workspaceId: req.workspaceId,
        parentId: req.parentId,
        kind: builtin.kind,
        title: builtin.title,
        icon: builtin.icon,
        doc: builtin.doc(),
      });
      pushRecent(ctx, req.workspaceId, rec.id);
      return ctx.pages.toMeta(rec);
    }
    const tpl = ctx.pages.get(req.templateId);
    if (!tpl || tpl.deletedAt || !tpl.flags.template) throw new BackendError('NOT_FOUND', 'Template not found');
    if (tpl.kind !== 'doc' && tpl.kind !== 'dashboard') throw new BackendError('UNSUPPORTED', 'Only page templates can be applied here');
    const d = ctx.docs.get(tpl.id);
    const rec = ctx.pages.create({
      workspaceId: req.workspaceId,
      parentId: req.parentId,
      kind: tpl.kind,
      title: tpl.title,
      icon: tpl.icon,
      cover: tpl.cover,
      flags: { ...tpl.flags, template: false },
      doc: d ? regenerateIds(d.doc, () => ctx.blockId()) : undefined,
    });
    pushRecent(ctx, req.workspaceId, rec.id);
    return ctx.pages.toMeta(rec);
  },
};
