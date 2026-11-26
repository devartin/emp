/**
 * page_* (§11.3 Pages and docs): tree CRUD with fractional sort keys, docs with revs + CONFLICT, autosave versions,
 * duplicate (job), turn-into-page, trash/restore/purge, backlinks, outline, block lookup, template flag.
 * Also wires the Getting Started checklist auto-ticks.
 */
import { BackendError } from '../../errors';
import type { Backlink, Id, PageMeta, TipTapDoc } from '../../types';
import type { MockCtx, MockHandlers, PageRecord, WorkspaceRecord } from '../ctx';
import { b, docText, extractBlocks, findBlock, makeDoc, outgoingLinks, outline, regenerateIds, setTodoChecked } from '../lib/doc';
import { TITLE_MAX } from '../lib/pages';
import { byNewest, type VersionRecord } from '../lib/versions';

const RECENTS_MAX = 20;
const AUTO_VERSION_MIN_AGE = 10 * 60_000;
const AUTO_VERSION_MIN_CHARS = 64;

function breadcrumbs(ctx: MockCtx, rec: PageRecord) {
  return [...ctx.pages.ancestors(rec.id), rec].map((p) => {
    const crumb: { id: Id; title: string; icon?: PageRecord['icon'] } = { id: p.id, title: p.title };
    if (p.icon) crumb.icon = p.icon;
    return crumb;
  });
}

export function pushRecent(ctx: MockCtx, workspaceId: Id, pageId: Id): void {
  const t = ctx.db.table<WorkspaceRecord>('workspaces');
  const ws = t.get(workspaceId);
  if (!ws || ws.recents[0] === pageId) return;
  t.update(workspaceId, (w) => {
    w.recents = [pageId, ...w.recents.filter((r) => r !== pageId)].slice(0, RECENTS_MAX);
  });
}

function maybeAutoVersion(ctx: MockCtx, pageId: Id, doc: TipTapDoc): void {
  const versions = ctx.db.table<VersionRecord>('versions').filter((v) => v.targetId === pageId && v.targetKind === 'page_doc');
  const last = versions.sort(byNewest)[0];
  const now = ctx.clock.now();
  if (last && now - last.createdAt < AUTO_VERSION_MIN_AGE) return;
  const newLen = docText(doc).length;
  const oldLen = last ? docText(last.snapshot as TipTapDoc).length : 0;
  if (last && Math.abs(newLen - oldLen) < AUTO_VERSION_MIN_CHARS) {
    // Same length can still hide a rewrite; compare text when lengths are close.
    if (docText(last.snapshot as TipTapDoc) === docText(doc)) return;
    if (Math.abs(newLen - oldLen) < AUTO_VERSION_MIN_CHARS / 4) return;
  }
  ctx.versions.create({ targetId: pageId, targetKind: 'page_doc', reason: 'auto', snapshot: doc });
}

function pageDocOrNull(ctx: MockCtx, rec: PageRecord): { doc: TipTapDoc | null; rev: number } {
  const d = ctx.docs.get(rec.id);
  if (d) return { doc: d.doc, rev: d.rev };
  if (rec.kind === 'doc' || rec.kind === 'dashboard') return { doc: makeDoc([b.p()]), rev: 0 };
  return { doc: null, rev: 0 };
}

function duplicateTree(ctx: MockCtx, rootId: Id, deep: boolean, onStep: (n: number, total: number) => void): PageRecord {
  const root = ctx.pages.require(rootId);
  const subtree = deep ? [root, ...ctx.pages.descendants(rootId)] : [root];
  const map: Record<string, string> = {};
  let n = 0;
  let copyRoot: PageRecord | null = null;
  for (const src of subtree) {
    const isRoot = src.id === rootId;
    const parentId = isRoot ? src.parentId : map[src.parentId as string];
    const copy = ctx.pages.create({
      workspaceId: src.workspaceId,
      parentId: parentId ?? null,
      kind: src.kind,
      title: isRoot ? `${src.title || 'Untitled'} (copy)` : src.title,
      icon: src.icon,
      cover: src.cover,
      flags: { ...src.flags },
      afterId: isRoot ? src.id : undefined,
      silent: true,
    });
    if (!isRoot) {
      // Keep the relative order of the source subtree.
      ctx.pages.table().update(copy.id, (r) => {
        r.sortKey = src.sortKey;
      });
    }
    map[src.id] = copy.id;
    const d = ctx.docs.get(src.id);
    if (d) ctx.docs.save(copy.id, 'page', regenerateIds(d.doc, () => ctx.blockId()));
    if (isRoot) copyRoot = copy;
    onStep(++n, subtree.length);
  }
  if (!copyRoot) throw new BackendError('INTERNAL', 'Duplicate failed');
  ctx.events.internal('page:duplicated', { sourceId: rootId, newId: copyRoot.id, map });
  ctx.pages.emitTree(root.workspaceId, [...Object.values(map), ...(root.parentId ? [root.parentId] : [])]);
  return copyRoot;
}

function rewritePageRefs(doc: TipTapDoc, map: Record<string, string>): TipTapDoc {
  const visit = (n: TipTapDoc['content'][number]) => {
    if ((n.type === 'pageRef' || n.type === 'pageLink') && n.attrs?.pageId && map[n.attrs.pageId as string]) {
      n.attrs = { ...n.attrs, pageId: map[n.attrs.pageId as string] };
    }
    n.content?.forEach(visit);
  };
  doc.content.forEach(visit);
  return doc;
}

export const handlers: MockHandlers = {
  page_get: (req, ctx) => {
    const rec = ctx.pages.require(req.id);
    const { doc, rev } = pageDocOrNull(ctx, rec);
    if (!ctx.seeding && !rec.flags.template) pushRecent(ctx, rec.workspaceId, rec.id);
    return { meta: ctx.pages.toMeta(rec), doc, docRev: rev, breadcrumbs: breadcrumbs(ctx, rec) };
  },

  page_get_meta: (req, ctx) => {
    const out: PageMeta[] = [];
    for (const id of req.ids.slice(0, 1000)) {
      const rec = ctx.pages.get(id);
      if (rec) out.push(ctx.pages.toMeta(rec));
    }
    return out;
  },

  page_create: (req, ctx) => {
    let doc = req.doc;
    let icon = req.icon;
    let cover: PageRecord['cover'];
    let flags: PageRecord['flags'] = {};
    if (req.templatePageId) {
      const tpl = ctx.pages.require(req.templatePageId);
      const tdoc = ctx.docs.get(tpl.id)?.doc;
      if (tdoc && !doc) doc = regenerateIds(tdoc, () => ctx.blockId());
      icon ??= tpl.icon;
      cover = tpl.cover;
      flags = { ...tpl.flags, template: false };
    }
    if (doc) doc = regenerateIds(doc, () => ctx.blockId());
    const ws = ctx.db.table<WorkspaceRecord>('workspaces').require(req.workspaceId, 'Workspace');
    flags = { font: ws.defaults.font, fullWidth: ws.defaults.fullWidth, smallText: ws.defaults.smallText, ...flags };
    if (req.kind !== 'doc' && req.kind !== 'dashboard') throw new BackendError('INVALID', 'Use db_create or sheet_workbook_create', { field: 'kind' });
    const rec = ctx.pages.create({
      workspaceId: req.workspaceId,
      parentId: req.parentId,
      kind: req.kind,
      title: req.title,
      icon,
      cover,
      flags,
      afterId: req.afterId,
      doc,
    });
    pushRecent(ctx, rec.workspaceId, rec.id);
    if (!ctx.seeding) ctx.events.internal('gettingStarted:tick', { item: 'create_page' });
    return { meta: ctx.pages.toMeta(rec), docRev: ctx.docs.get(rec.id)?.rev ?? 0 };
  },

  page_update_meta: (req, ctx) => {
    const p = req.patch ?? {};
    if (p.title !== undefined && p.title.length > TITLE_MAX) throw new BackendError('INVALID', 'Title is too long', { field: 'title' });
    if (p.cover && p.cover.t === 'asset' && !(p.cover.posY >= 0 && p.cover.posY <= 1)) {
      throw new BackendError('INVALID', 'Cover position must be between 0 and 1', { field: 'cover' });
    }
    const patch: Parameters<MockCtx['pages']['update']>[1] = {};
    if (p.title !== undefined) patch.title = p.title;
    if ('icon' in p) patch.icon = p.icon ?? undefined;
    if ('cover' in p) patch.cover = p.cover ?? undefined;
    if (p.flags) patch.flags = p.flags as PageRecord['flags'];
    return ctx.pages.toMeta(ctx.pages.update(req.id, patch));
  },

  page_save_doc: (req, ctx) => {
    if (req.ownerKind === 'page') {
      const rec = ctx.pages.require(req.ownerId);
      if (rec.flags.locked) throw new BackendError('INVALID', 'This page is locked. Unlock it to edit.');
      const saved = ctx.docs.save(req.ownerId, 'page', req.doc, req.baseRev);
      ctx.pages.touch(rec.id);
      maybeAutoVersion(ctx, rec.id, saved.doc);
      ctx.events.internal('doc:saved', { ownerId: rec.id, ownerKind: 'page', rev: saved.rev });
      ctx.emit('page:changed', { id: rec.id, docRev: saved.rev });
      ctx.pages.emitTree(rec.workspaceId, [rec.id]);
      return { rev: saved.rev };
    }
    const saved = ctx.docs.save(req.ownerId, 'row', req.doc, req.baseRev);
    ctx.events.internal('doc:saved', { ownerId: req.ownerId, ownerKind: 'row', rev: saved.rev });
    return { rev: saved.rev };
  },

  page_move: (req, ctx) => {
    if (req.parentId) {
      const parent = ctx.pages.require(req.parentId);
      if (parent.kind === 'database') throw new BackendError('INVALID', 'Pages cannot be moved into a database', { field: 'parentId' });
    }
    return ctx.pages.toMeta(ctx.pages.move(req.id, req.parentId, { beforeId: req.beforeId, afterId: req.afterId }));
  },

  page_duplicate: async (req, ctx) => {
    ctx.progress(0, 1, 'Copying');
    const copy = duplicateTree(ctx, req.id, req.deep, (n, total) => ctx.progress(n, total, 'Copying pages'));
    // Sub-page blocks inside copied docs should point at the copies.
    if (req.deep) {
      const map: Record<string, string> = {};
      const src = [ctx.pages.require(req.id), ...ctx.pages.descendants(req.id)];
      const dst = [copy, ...ctx.pages.descendants(copy.id)];
      src.forEach((s, i) => {
        if (dst[i]) map[s.id] = dst[i].id;
      });
      for (const d of dst) {
        const rec = ctx.docs.get(d.id);
        if (rec) ctx.docs.save(d.id, 'page', rewritePageRefs(structuredClone(rec.doc), map));
      }
    }
    return ctx.pages.toMeta(copy);
  },

  page_turn_into_page: (req, ctx) => {
    const src = ctx.pages.require(req.sourceId);
    if (!req.title || req.title.length > TITLE_MAX) throw new BackendError('INVALID', 'Give the new page a title', { field: 'title' });
    const docRec = ctx.docs.get(src.id);
    if (!docRec) throw new BackendError('NOT_FOUND', 'Nothing to move');
    const ids = new Set(req.blockIds);
    ctx.versions.create({ targetId: src.id, targetKind: 'page_doc', reason: 'pre_bulk', snapshot: docRec.doc });
    const child = ctx.pages.create({
      workspaceId: src.workspaceId,
      parentId: src.id,
      kind: 'doc',
      title: req.title,
      flags: { font: src.flags.font, smallText: src.flags.smallText, fullWidth: src.flags.fullWidth },
      silent: true,
    });
    const { doc, removed } = extractBlocks(docRec.doc, ids, b.pageRef(child.id));
    if (!removed.length) {
      ctx.pages.purge([child.id]);
      throw new BackendError('NOT_FOUND', 'Those blocks are no longer on the page');
    }
    ctx.docs.save(child.id, 'page', makeDoc(removed));
    const saved = ctx.docs.save(src.id, 'page', doc);
    ctx.emit('page:changed', { id: src.id, docRev: saved.rev });
    ctx.pages.emitTree(src.workspaceId, [child.id, src.id]);
    return { meta: ctx.pages.toMeta(child), newSourceRev: saved.rev };
  },

  page_delete: (req, ctx) => {
    for (const id of req.ids) ctx.pages.require(id);
    ctx.pages.trash(req.ids);
  },

  page_restore: (req, ctx) => ctx.pages.restore(req.ids).map((r) => ctx.pages.toMeta(r)),

  page_purge: (req, ctx) => {
    ctx.pages.purge(req.ids);
  },

  page_backlinks: (req, ctx) => {
    const target = ctx.pages.require(req.id);
    const out: Backlink[] = [];
    for (const p of ctx.pages.table().values()) {
      if (p.deletedAt || p.id === target.id || p.workspaceId !== target.workspaceId) continue;
      const d = ctx.docs.get(p.id);
      if (!d) continue;
      const seenBlocks = new Set<string>();
      for (const link of outgoingLinks(d.doc)) {
        if (link.targetPageId !== target.id || seenBlocks.has(link.blockId)) continue;
        seenBlocks.add(link.blockId);
        const text = link.blockText.replace(/\s+/g, ' ').trim();
        const start = Math.max(0, link.offset - 60);
        const end = Math.min(text.length, link.offset + 60);
        const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` || p.title;
        const bl: Backlink = { sourceId: p.id, sourceTitle: p.title || 'Untitled', blockId: link.blockId, snippet };
        if (p.icon) bl.sourceIcon = p.icon;
        out.push(bl);
      }
    }
    return out.sort((a, b2) => a.sourceTitle.localeCompare(b2.sourceTitle));
  },

  page_outline: (req, ctx) => {
    ctx.pages.require(req.id);
    return outline(ctx.docs.get(req.id)?.doc);
  },

  page_get_block: (req, ctx) => {
    ctx.pages.require(req.pageId);
    const node = findBlock(ctx.docs.get(req.pageId)?.doc, req.blockId);
    return node ? { node } : null;
  },

  page_set_template: (req, ctx) => ctx.pages.toMeta(ctx.pages.update(req.id, { flags: { template: req.template } })),
};

export function setup(ctx: MockCtx): void {
  // Getting Started checklist (§6.2): items tick themselves as the user tries each thing.
  ctx.events.on('gettingStarted:tick', ({ item }) => {
    const gs = ctx.db.meta<{ pageId: Id; items: Record<string, string> }>('gettingStarted');
    if (!gs) return;
    const blockId = gs.items[item];
    const rec = ctx.docs.get(gs.pageId);
    const page = ctx.pages.get(gs.pageId);
    if (!blockId || !rec || !page || page.deletedAt) return;
    const doc = structuredClone(rec.doc);
    if (!setTodoChecked(doc, blockId, true)) return;
    const saved = ctx.docs.save(gs.pageId, 'page', doc);
    ctx.emit('page:changed', { id: gs.pageId, docRev: saved.rev });
  });
}
