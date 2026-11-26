/**
 * Row page (§8.6): opens in the side peek by default (↑/↓ walk the view that opened it) or as a full page.
 * Icon + title, the properties block, then the row body — a document (`owner_kind='row'`) created on first edit.
 */
import { AnimatePresence, m } from 'motion/react';
import { ChevronDown, ChevronUp, Database } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, hasCode, listen } from '@/backend';
import type { CellValue, DbRowGetResult, Id } from '@/backend/types';
import { navigate, useRoute } from '@/app/router';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { useUi } from '@/stores/ui';
import { undoable } from '@/stores/undo';
import { useWorkspace } from '@/stores/workspace';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { IconButton } from '@/ui/IconButton';
import { Skeleton } from '@/ui/Skeleton';
import { Editor } from '@/features/editor/Editor';
import '@/styles/editor.css';
import { plainText, rt } from './engine/values';
import { RowProperties } from './properties/RowProperties';
import { peekNeighbours, useSchema } from './store';
import './databases.css';
import { PageGlyph } from '@/ui/icons/Icon';

export interface RowPageProps {
  rowId: Id;
}

export default function RowPage({ rowId }: RowPageProps) {
  const [data, setData] = useState<DbRowGetResult | null>(null);
  const [missing, setMissing] = useState(false);
  const route = useRoute();
  const peek = useUi((s) => s.peek);
  const inPeek = !!peek && peek.t === 'row' && peek.id === rowId && !(route.t === 'row' && route.id === rowId);
  const wsId = useWorkspace((s) => s.workspace?.id);
  const { schema } = useSchema(data?.databaseId);
  const dbMeta = useTree((s) => (data ? s.byId.get(data.databaseId) : undefined));
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.db.rowGet({ id: rowId });
      setData(r);
      setMissing(false);
    } catch (e) {
      if (hasCode(e, 'NOT_FOUND')) setMissing(true);
      else notify.fromError(e, "Couldn't open the row");
    }
  }, [rowId]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  useEffect(
    () =>
      listen('db:changed', (e) => {
        if (data && e.databaseId === data.databaseId && (!e.rowIds || e.rowIds.includes(rowId))) {
          void api.db.rowGet({ id: rowId }).then((r) => setData((d) => (d ? { ...r, doc: d.doc, docRev: d.docRev } : r))).catch(() => undefined);
        }
      }),
    [data?.databaseId, rowId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const row = data?.row ?? null;
  const update = useCallback(
    async (values: Record<Id, CellValue | null>, label = 'Edit') => {
      if (!row) return;
      const prev: Record<Id, CellValue | null> = {};
      for (const k of Object.keys(values)) prev[k] = row.values[k] ?? null;
      const apply = async (vals: Record<Id, CellValue | null>) => {
        setData((d) => {
          if (!d) return d;
          const nv = { ...d.row.values };
          for (const [k, v] of Object.entries(vals)) v === null ? delete nv[k] : (nv[k] = v);
          return { ...d, row: { ...d.row, values: nv } };
        });
        const [res] = await api.db.rowsUpdate({ updates: [{ id: rowId, values: vals }] });
        if (res) setData((d) => (d ? { ...d, row: res } : d));
      };
      try {
        await undoable({ label, do: () => apply(values), undo: () => apply(prev) });
      } catch (e) {
        notify.fromError(e, "Couldn't save");
        void load();
      }
    },
    [row, rowId, load],
  );

  const nb = peekNeighbours(rowId) ?? { prev: data?.prevId, next: data?.nextId };
  const go = (id?: Id) => {
    if (!id) return;
    if (inPeek) useUi.getState().openPeek({ t: 'row', id });
    else navigate({ t: 'row', id }, { replace: true });
  };

  useEffect(() => {
    if (!inPeek) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
      if (e.key === 'k' || (e.altKey && e.key === 'ArrowUp')) go(nb.prev);
      if (e.key === 'j' || (e.altKey && e.key === 'ArrowDown')) go(nb.next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });


  if (missing) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center p-8">
        <EmptyState icon={Database} title="This row doesn't exist" body="It may have been deleted. Rows deleted from a database can be restored with Undo." actions={<Button variant="secondary" onClick={() => (useUi.getState().closePeek(), navigate({ t: 'home' }))}>Open Home</Button>} />
      </div>
    );
  }

  const primary = schema?.database.primaryPropId;
  const titleCell = row && primary ? row.values[primary] : undefined;
  const title = titleCell?.t === 'text' ? plainText(titleCell.v) : '';

  return (
    <div className={cn('edb-rowpage', inPeek && 'is-peek')}>
      <div className="edb-rowpage-bar">
        <IconButton size="sm" icon={ChevronUp} label="Previous row" shortcut="k" disabled={!nb.prev} onClick={() => go(nb.prev)} />
        <IconButton size="sm" icon={ChevronDown} label="Next row" shortcut="j" disabled={!nb.next} onClick={() => go(nb.next)} />
        {data ? (
          <button type="button" className="edb-rowpage-db" onClick={() => (useUi.getState().closePeek(), navigate({ t: 'db', id: data.databaseId }))}>
            {dbMeta?.icon ? <PageGlyph icon={dbMeta.icon} context="row" fallback="none" /> : <Database size={16} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />}
            <span className="truncate">{dbMeta?.title || schema?.database.title || 'Database'}</span>
          </button>
        ) : null}
        <span className="flex-1" />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {!data || !schema || !row ? (
          <m.div key="sk" className="edb-rowpage-inner" initial={false} exit={{ opacity: 0, transition: { duration: 0 } }}>
            <Skeleton width={48} height={48} radius={10} />
            <Skeleton width="60%" height={28} className="mt-4" />
            <div className="mt-6 flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex gap-6">
                  <Skeleton width={120} height={12} />
                  <Skeleton width={180 - i * 18} height={12} />
                </div>
              ))}
            </div>
          </m.div>
        ) : (
          <m.div key={rowId} className="edb-rowpage-inner" initial={false} exit={{ opacity: 0, transition: { duration: 0 } }}>
            <div className="edb-rowpage-head">
              {row.icon && row.icon.t !== 'asset' ? (
                <span className="edb-rowpage-icon" aria-hidden>
                  <PageGlyph icon={row.icon} context="header" fallback="none" />
                </span>
              ) : null}
              <TitleArea key={rowId} ref={titleRef} value={title} onSave={(t) => primary && t !== title && void update({ [primary]: { t: 'text', v: rt(t) } }, 'Rename row')} />
            </div>
            <RowProperties schema={schema} row={row} values={row.values} onChange={(pid, v) => void update({ [pid]: v })} />
            <div className="edb-rowpage-divider" />
            {wsId ? (
              <div className="edb-rowpage-doc">
                <Editor key={rowId} ownerId={rowId} ownerKind="row" workspaceId={wsId} parentPageId={null} doc={data.doc} docRev={data.docRev} pooled={false} placeholder="Write something, or press / for commands…" />
              </div>
            ) : null}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TitleArea({ value, onSave, ref }: { value: string; onSave: (t: string) => void; ref?: React.Ref<HTMLTextAreaElement> }) {
  const [v, setV] = useState(value);
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 'px';
  }, [v]);
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      }}
      className="edb-rowpage-title"
      rows={1}
      value={v}
      placeholder="Untitled"
      onChange={(e) => setV(e.target.value.replace(/\n/g, ''))}
      onBlur={() => onSave(v.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      aria-label="Title"
    />
  );
}
