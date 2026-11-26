/**
 * Doc page route entry (§6.1, §7): cover, icon, title, backlinks, the block editor, find & replace, page history and
 * conflict handling. Keeps the doc in sync with `page:changed` and flushes autosave on route change.
 *
 *   <PageView pageId="…" blockId?="…" />     // blockId scrolls to and flashes that block
 */
import type { Editor as TEditor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { AnimatePresence, m } from 'motion/react';
import { FileWarning, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, hasCode, listen } from '@/backend';
import type { Cover, Id, PageFlags, PageGetResult, PageMeta, TipTapDoc } from '@/backend/types';
import { registerCommands } from '@/app/commands';
import { navigate } from '@/app/router';
import { cn } from '@/lib/cn';
import { isMac, shortcutLabel } from '@/lib/platform';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { useUi } from '@/stores/ui';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Skeleton, useSkeletonDelay } from '@/ui/Skeleton';
import { spring } from '@/ui/motion/tokens';
import '@/styles/editor.css';
import { Editor } from './Editor';
import { existingSaver } from './useDocSave';
import { REMOTE_META, type ConflictInfo, type DocSaver, type SaverSnapshot } from './useDocSave';
import { findBlockById, makeContainer, revealPos, toggleAll } from './lib/blocks';
import { insertBlocksSlice, insertImageFiles } from './extensions/clipboard';
import { internalHref } from './lib/links';
import { normaliseDocJson } from './lib/normalize';
import { rememberPage } from './lib/pageInfo';
import { scrollToBlock } from './nodeviews/dom';
import { ConflictSheet } from './page/ConflictSheet';
import { FindBar } from './page/FindBar';
import { HistoryDrawer } from './page/HistoryDrawer';
import { PageHeader } from './page/PageHeader';

export interface PageViewProps {
  pageId: Id;
  blockId?: string;
}

const cache = new Map<Id, PageGetResult>();

function usePage(pageId: Id) {
  const [state, setState] = useState<{ data: PageGetResult | null; error: unknown; loading: boolean }>(() => ({ data: cache.get(pageId) ?? null, error: null, loading: !cache.has(pageId) }));
  const load = useCallback(async () => {
    try {
      const res = await api.page.get({ id: pageId });
      cache.set(pageId, res);
      rememberPage(res.meta);
      setState({ data: res, error: null, loading: false });
      return res;
    } catch (e) {
      setState((s) => ({ data: s.data, error: e, loading: false }));
      return null;
    }
  }, [pageId]);
  useEffect(() => {
    setState({ data: cache.get(pageId) ?? null, error: null, loading: !cache.has(pageId) });
    void load();
  }, [pageId, load]);
  return { ...state, reload: load };
}

function textOf(editor: TEditor, blockId: string): string {
  const b = findBlockById(editor.state.doc, blockId);
  return b ? b.content.textContent.trim().slice(0, 200) : '';
}

export default function PageView({ pageId, blockId }: PageViewProps) {
  const { data, error, loading, reload } = usePage(pageId);
  const treeMeta = useTree((s) => s.byId.get(pageId));
  const meta: PageMeta | null = useMemo(() => {
    if (!data) return treeMeta ?? null;
    if (treeMeta && treeMeta.updatedAt >= data.meta.updatedAt) return { ...data.meta, ...treeMeta };
    return data.meta;
  }, [data, treeMeta]);
  const [editor, setEditor] = useState<TEditor | null>(null);
  const saverRef = useRef<DocSaver | null>(null);
  const [status, setStatus] = useState<SaverSnapshot | null>(null);
  const [find, setFindOpen] = useState<{ replace: boolean; token: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Keyed by page so navigating resets it without an effect.
  const [backlinks, setBacklinks] = useState<{ id: Id; open: boolean }>({ id: pageId, open: false });
  const backlinksOpen = backlinks.id === pageId && backlinks.open;
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const showSkeleton = useSkeletonDelay(loading && !data);

  const readOnly = !!meta?.flags.locked || !!meta?.deletedAt;

  // ── meta edits (optimistic through the tree store)
  const patchMeta = useCallback(
    (patch: { title?: string; icon?: PageMeta['icon'] | null; cover?: Cover | null; flags?: Partial<PageFlags> }) => {
      void useTree.getState().updateMeta(pageId, patch);
      const cur = cache.get(pageId);
      if (cur) {
        const next: PageMeta = { ...cur.meta };
        if (patch.title !== undefined) next.title = patch.title;
        if ('icon' in patch) next.icon = patch.icon ?? undefined;
        if ('cover' in patch) next.cover = patch.cover ?? undefined;
        if (patch.flags) next.flags = { ...next.flags, ...patch.flags };
        next.updatedAt = Date.now();
        cache.set(pageId, { ...cur, meta: next });
      }
    },
    [pageId],
  );
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTitle = useCallback(
    (title: string) => {
      if (titleTimer.current) clearTimeout(titleTimer.current);
      titleTimer.current = setTimeout(() => patchMeta({ title }), 300);
    },
    [patchMeta],
  );
  useEffect(() => () => {
    if (titleTimer.current) clearTimeout(titleTimer.current);
  }, []);

  // ── remote changes
  useEffect(() => {
    return listen('page:changed', (e) => {
      if (e.id !== pageId || e.docRev === undefined) return;
      const saver = saverRef.current;
      if (!editor || !saver) return;
      if (saver.saving || e.docRev <= saver.rev) return;
      if (saver.isDirty) return; // the next save will surface a conflict
      void api.page.get({ id: pageId }).then((res) => {
        cache.set(pageId, res);
        if (res.docRev <= saver.rev || saver.isDirty || editor.isDestroyed) return;
        const sel = editor.state.selection;
        editor.chain().setMeta(REMOTE_META, true).setMeta('addToHistory', false).setContent(normaliseDocJson(res.doc), { emitUpdate: true }).run();
        saver.setRev(res.docRev);
        try {
          editor.commands.setTextSelection({ from: Math.min(sel.from, editor.state.doc.content.size - 1), to: Math.min(sel.to, editor.state.doc.content.size - 1) });
        } catch {
          /* selection reset */
        }
      });
    });
  }, [pageId, editor]);

  // ── files dropped from the OS in the desktop app (file:dropped → ui.droppedFiles)
  const dropped = useUi((s) => s.droppedFiles);
  useEffect(() => {
    if (!dropped || !editor || readOnly || !meta) return;
    useUi.getState().setDroppedFiles(null);
    void (async () => {
      try {
        const job = await api.asset.importGrants({ grantIds: dropped.grants.map((g) => g.grantId), workspaceId: meta.workspaceId });
        const assets = await job.result;
        const at = editor.view.posAtCoords({ left: dropped.x, top: dropped.y })?.pos;
        if (at != null) editor.commands.setTextSelection(at);
        const nodes = assets.map((a) =>
          makeContainer(editor.schema, a.mime.startsWith('image/') ? editor.schema.nodes.image.create({ assetId: a.id, width: null, align: 'center', caption: '', pendingUrl: null }) : editor.schema.nodes.file.create({ assetId: a.id })),
        );
        insertBlocksSlice(editor.view, new Slice(Fragment.from(nodes), 0, 0));
      } catch (e) {
        notify.fromError(e, "Couldn't add those files");
      }
    })();
  }, [dropped, editor, readOnly, meta]);

  // ── very large documents (§7.11): suggest splitting
  const large = useMemo(() => (data?.doc ? JSON.stringify(data.doc).length > 2 * 1024 * 1024 : false), [data?.doc]);

  // ── scroll to a block (backlinks, search, links)
  useEffect(() => {
    if (!editor || !blockId) return;
    const t = setTimeout(() => {
      const b = findBlockById(editor.state.doc, blockId);
      if (!b) return;
      const tr = revealPos(editor.state, b.pos + 1);
      if (tr) editor.view.dispatch(tr.setMeta('addToHistory', false));
      requestAnimationFrame(() => scrollToBlock(editor.view, blockId));
    }, 60);
    return () => clearTimeout(t);
  }, [editor, blockId]);

  // ── focus: empty pages focus the title, otherwise nothing steals focus
  useEffect(() => {
    if (!data || !editor || readOnly) return;
    if (!data.meta.title && (data.doc?.content?.[0]?.content?.length ?? 0) <= 1 && !blockId) titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, data?.meta.id]);

  const flush = useCallback(async () => {
    await saverRef.current?.flush();
  }, []);

  // ── turn into page (⌘⌥9, block menu)
  const turnIntoPage = useCallback(
    async (ids: string[]) => {
      const ed = editor;
      if (!ed || !ids.length) return;
      const title = ids.length === 1 ? textOf(ed, ids[0]) || 'Untitled' : 'Untitled';
      try {
        await saverRef.current?.flush();
        const res = await api.page.turnIntoPage({ sourceId: pageId, blockIds: ids, title });
        useTree.getState().upsert([res.meta]);
        rememberPage(res.meta);
        // Mirror the backend's edit locally: the first block becomes a pageRef, the others go away.
        const blocks = ids.map((id) => findBlockById(ed.state.doc, id)).filter((b): b is NonNullable<typeof b> => !!b).sort((a, b) => a.pos - b.pos);
        if (blocks.length) {
          const tr = ed.state.tr;
          for (const b of [...blocks].slice(1).reverse()) tr.delete(tr.mapping.map(b.pos), tr.mapping.map(b.end));
          const first = blocks[0];
          tr.replaceWith(first.pos, first.end, Fragment.from(makeContainer(ed.schema, ed.schema.nodes.pageRef.create({ pageId: res.meta.id }))));
          ed.view.dispatch(tr.setMeta(REMOTE_META, true));
        }
        saverRef.current?.setRev(res.newSourceRev);
        notify.success(`Moved to “${res.meta.title || 'Untitled'}”`, { action: { label: 'Open', onClick: () => navigate({ t: 'page', id: res.meta.id }) } });
      } catch (e) {
        notify.fromError(e, "Couldn't turn that into a page");
      }
    },
    [editor, pageId],
  );

  const hooks = useMemo(
    () => ({
      find: (replace: boolean) => setFindOpen((f) => ({ replace: replace || !!f?.replace, token: (f?.token ?? 0) + 1 })),
      turnIntoPage: (ids: string[]) => void turnIntoPage(ids),
      blockLink: (id: string) => internalHref(pageId, id),
    }),
    [turnIntoPage, pageId],
  );

  // ⌘F / ⌘⌥F anywhere on the page (the editor handles them itself when focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.code !== 'KeyF' || e.shiftKey) return;
      e.preventDefault();
      hooks.find(e.altKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hooks]);

  // Palette commands while a page is open.
  useEffect(() => {
    return registerCommands([
      { id: 'page.find', title: 'Find in page', section: 'Page', icon: 'search', shortcut: 'mod+f', run: () => hooks.find(false) },
      { id: 'page.findReplace', title: 'Find and replace', section: 'Page', icon: 'replace', shortcut: 'mod+alt+f', run: () => hooks.find(true) },
      { id: 'page.history', title: 'Page history', section: 'Page', icon: 'history', keywords: ['versions', 'restore', 'undo'], run: () => setHistoryOpen(true) },
      { id: 'page.saveVersion', title: 'Save a version of this page', section: 'Page', icon: 'save', keywords: ['snapshot', 'version'], run: () => setHistoryOpen(true) },
      { id: 'page.font.sans', title: 'Page font: Default', section: 'Page', icon: 'type', run: () => patchMeta({ flags: { font: 'sans' } }) },
      { id: 'page.font.serif', title: 'Page font: Serif', section: 'Page', icon: 'type', run: () => patchMeta({ flags: { font: 'serif' } }) },
      { id: 'page.font.mono', title: 'Page font: Mono', section: 'Page', icon: 'type', run: () => patchMeta({ flags: { font: 'mono' } }) },
      { id: 'page.fullWidth', title: 'Toggle full width', section: 'Page', icon: 'move-horizontal', run: () => patchMeta({ flags: { fullWidth: !meta?.flags.fullWidth } }) },
      { id: 'page.smallText', title: 'Toggle small text', section: 'Page', icon: 'a-large-small', run: () => patchMeta({ flags: { smallText: !meta?.flags.smallText } }) },
      { id: 'page.lock', title: meta?.flags.locked ? 'Unlock page' : 'Lock page', section: 'Page', icon: 'lock', run: () => patchMeta({ flags: { locked: !meta?.flags.locked } }) },
      { id: 'page.toggleAll', title: 'Expand or collapse all toggles', section: 'Page', icon: 'chevrons-up-down', shortcut: 'mod+alt+t', run: () => void (editor && toggleAll(editor.state, (tr) => editor.view.dispatch(tr))) },
    ]);
  }, [hooks, patchMeta, meta?.flags.fullWidth, meta?.flags.smallText, meta?.flags.locked, editor]);

  // Flush when leaving the page.
  useEffect(() => () => void saverRef.current?.flush(), [pageId]);

  const onReady = useCallback((ed: TEditor, saver: DocSaver | null) => {
    setEditor(ed);
    saverRef.current = saver ?? existingSaver(ed) ?? null;
  }, []);

  const focusEditorStart = () => {
    if (!editor) return;
    const first = editor.state.doc.firstChild?.firstChild;
    if (!first) return;
    const content = first.firstChild;
    const tr = editor.state.tr;
    if (content && !content.isTextblock) tr.insert(1, makeContainer(editor.schema, editor.schema.nodes.paragraph.create()));
    tr.setSelection(TextSelection.create(tr.doc, 3)).scrollIntoView();
    editor.view.dispatch(tr);
    // Focus synchronously so the next keystroke lands in the editor, not the title.
    editor.view.focus();
  };

  // ── render
  if (error && !data) {
    const missing = hasCode(error, 'NOT_FOUND');
    return (
      <div className="emp-page-missing">
        <EmptyState
          icon={FileWarning}
          title={missing ? 'This page doesn’t exist' : 'This page couldn’t be opened'}
          body={missing ? 'It may have been deleted permanently, or the link is out of date.' : 'Something went wrong while loading it. Try again in a moment.'}
          actions={
            <Button variant="secondary" onClick={() => (missing ? navigate({ t: 'home' }) : void reload())}>
              {missing ? 'Open Home' : 'Try again'}
            </Button>
          }
        />
      </div>
    );
  }

  if (!data || !meta) {
    return (
      <div className="emp-page" aria-busy="true">
        {showSkeleton ? (
          <div className="emp-page-column">
            <div className="emp-page-head">
              <Skeleton height={40} width="55%" radius={6} className="mt-16" />
            </div>
            <div className="mt-8 flex flex-col gap-3">
              {[92, 84, 96, 60, 88, 72].map((w, i) => (
                <Skeleton key={i} height={14} width={`${w}%`} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const font = meta.flags.font ?? 'sans';
  return (
    <div
      ref={rootRef}
      className={cn('emp-page', meta.flags.fullWidth && 'is-full-width', meta.cover && 'has-cover')}
      data-font={font}
      data-small-text={meta.flags.smallText ? '' : undefined}
      onMouseDown={(e) => {
        // Clicks in the page margins place the caret on that line (and below the last block, at the end).
        if (!editor || readOnly || e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (t.closest('.ProseMirror, .emp-page-head, .emp-cover, .emp-find, button, input, textarea, a, [role="dialog"], .emp-editor-tail')) return;
        const r = editor.view.dom.getBoundingClientRect();
        if (e.clientY < r.top) return;
        e.preventDefault();
        if (e.clientY > r.bottom) {
          (rootRef.current?.querySelector('.emp-editor-tail') as HTMLElement | null)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          return;
        }
        const hit = editor.view.posAtCoords({ left: Math.min(Math.max(e.clientX, r.left + 4), r.right - 4), top: e.clientY });
        if (!hit) return;
        try {
          editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(hit.pos))));
        } catch {
          return;
        }
        editor.view.focus();
      }}
      onDragEnter={(e) => {
        if (!readOnly && e.dataTransfer.types.includes('Files')) setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!readOnly && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        setDragOver(false);
        if (readOnly || !editor || !e.dataTransfer.files.length) return;
        if ((e.target as HTMLElement).closest('.ProseMirror')) return; // the editor handles drops inside itself
        e.preventDefault();
        insertImageFiles(editor, Array.from(e.dataTransfer.files));
      }}
    >
      <div className="emp-find-anchor">
        <AnimatePresence>
          {find && editor ? <FindBar key="find" editor={editor} replace={find.replace} focusToken={find.token} onClose={() => setFindOpen(null)} /> : null}
        </AnimatePresence>
      </div>
      {meta.deletedAt ? (
        <Banner
          tone="danger"
          icon={Trash2}
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={RotateCcw}
              onClick={async () => {
                try {
                  const restored = await api.page.restore({ ids: [pageId] });
                  useTree.getState().upsert(restored);
                  await reload();
                } catch (e) {
                  notify.fromError(e, "Couldn't restore the page");
                }
              }}
            >
              Restore
            </Button>
          }
        >
          This page is in Trash.
        </Banner>
      ) : null}
      {large ? (
        <Banner tone="warning" icon={FileWarning}>
          This page is very large, which can make it slower to edit. Splitting sections into sub-pages helps ({shortcutLabel('mod+alt+9')} turns a block into a page).
        </Banner>
      ) : null}
      <PageHeader
        meta={meta}
        readOnly={readOnly}
        status={status}
        titleRef={titleRef}
        onTitle={onTitle}
        onTitleExit={focusEditorStart}
        onIcon={(emoji) => patchMeta({ icon: emoji ? { t: 'emoji', v: emoji } : null })}
        onCover={(cover) => patchMeta({ cover })}
        onFlags={(flags) => patchMeta({ flags })}
        onHistory={() => setHistoryOpen(true)}
        backlinksOpen={backlinksOpen}
        onBacklinksOpen={(open) => setBacklinks({ id: pageId, open })}
      />
      {/* FLIPs (transform only) when the backlinks list above opens/closes; layoutDependency keeps every other render
          measurement-free. */}
      <m.div className="emp-page-column emp-page-body" layout="position" layoutDependency={backlinksOpen} transition={spring.morph}>
        <Editor
          key={pageId}
          ownerId={pageId}
          ownerKind="page"
          workspaceId={meta.workspaceId}
          doc={data.doc}
          docRev={data.docRev}
          readOnly={readOnly}
          font={font}
          smallText={!!meta.flags.smallText}
          fullWidth={!!meta.flags.fullWidth}
          hooks={hooks}
          hoverRoot={rootRef.current}
          onReady={onReady}
          onStatus={setStatus}
          onConflict={setConflict}
        />
      </m.div>
      <AnimatePresence>
        {dragOver ? (
          <m.div className="emp-drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            <div className="emp-drop-card">Drop to add to this page</div>
          </m.div>
        ) : null}
      </AnimatePresence>
      <HistoryDrawer
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        pageId={pageId}
        workspaceId={meta.workspaceId}
        title={meta.title}
        beforeAction={flush}
        onRestored={(doc: TipTapDoc, rev: number) => {
          if (!editor) return;
          saverRef.current?.setRev(rev);
          editor.chain().setMeta(REMOTE_META, true).setContent(doc, { emitUpdate: true }).run();
          cache.delete(pageId);
        }}
      />
      <ConflictSheet
        open={!!conflict}
        pageId={pageId}
        draft={conflict?.draft ?? null}
        onOpenChange={(o) => !o && setConflict(null)}
        onResolved={({ doc, rev }) => {
          setConflict(null);
          const saver = saverRef.current;
          saver?.setRev(rev);
          saver?.discard();
          if (doc && editor) editor.chain().setMeta(REMOTE_META, true).setMeta('addToHistory', false).setContent(doc, { emitUpdate: true }).run();
        }}
      />
    </div>
  );
}
