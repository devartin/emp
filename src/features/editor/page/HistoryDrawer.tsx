/**
 * Page history (§7.8, D-24): versions grouped by day, a read-only preview of the selected snapshot, "Save version"
 * with a name and "Restore". Restoring keeps the current doc as a `pre_restore` version (backend).
 */
import { History, RotateCcw, Save } from 'lucide-react';
import { m } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/backend';
import type { Id, TipTapDoc, VersionMeta } from '@/backend/types';
import { cn } from '@/lib/cn';
import { spring } from '@/ui/motion/tokens';
import { formatBytes } from '@/lib/format';
import { formatDayLabel, formatTime } from '@/lib/dates';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Sheet } from '@/ui/Sheet';
import { Skeleton } from '@/ui/Skeleton';
import { Editor } from '../Editor';
import { normaliseDocJson } from '../lib/normalize';

const REASON: Record<string, string> = {
  auto: 'Auto-saved',
  manual: 'Saved version',
  pre_restore: 'Before restore',
  pre_import: 'Before import',
  pre_bulk: 'Before a big change',
  pre_migration: 'Before an update',
  pre_lifeapp: 'Before a life-app change',
};

export interface HistoryDrawerProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pageId: Id;
  workspaceId: Id;
  title: string;
  /** Flush pending edits first (so "current" is current). */
  beforeAction: () => Promise<void>;
  /** Called with the restored doc and its rev. */
  onRestored: (doc: TipTapDoc, rev: number) => void;
}

export function HistoryDrawer({ open, onOpenChange, pageId, workspaceId, title, beforeAction, onRestored }: HistoryDrawerProps) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [selected, setSelected] = useState<Id | null>(null);
  const [snapshot, setSnapshot] = useState<{ id: Id; doc: TipTapDoc } | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<'save' | 'restore' | null>(null);

  const reload = async () => {
    try {
      const list = await api.version.list({ targetId: pageId, targetKind: 'page_doc' });
      setVersions(list);
      setSelected((s) => s ?? list[0]?.id ?? null);
    } catch (e) {
      notify.fromError(e, "Couldn't load the history");
      setVersions([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    setSelected(null);
    void beforeAction().finally(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageId]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setSnapshot(null);
    api.version
      .get({ id: selected })
      .then((v) => live && setSnapshot({ id: selected, doc: normaliseDocJson(v.snapshot) }))
      .catch(() => live && setSnapshot(null));
    return () => {
      live = false;
    };
  }, [selected]);

  const groups = useMemo(() => {
    const out: { day: string; items: VersionMeta[] }[] = [];
    for (const v of versions ?? []) {
      const day = formatDayLabel(v.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(v);
      else out.push({ day, items: [v] });
    }
    return out;
  }, [versions]);

  const current = versions?.find((v) => v.id === selected);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="wizard"
      title="Page history"
      description={`Versions of “${title || 'Untitled'}”. Restoring keeps a copy of the current page.`}
      bodyClassName="emp-history-body"
      footer={
        <div className="emp-history-foot">
          <form
            className="emp-history-save"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy('save');
              try {
                await beforeAction();
                const v = await api.version.create({ targetId: pageId, targetKind: 'page_doc', label: label.trim() });
                setLabel('');
                notify.success('Version saved');
                await reload();
                setSelected(v.id);
              } catch (err) {
                notify.fromError(err, "Couldn't save a version");
              } finally {
                setBusy(null);
              }
            }}
          >
            <input className="emp-history-label" placeholder="Name this version (optional)" value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
            <Button size="sm" variant="secondary" icon={Save} type="submit" loading={busy === 'save'}>
              Save version
            </Button>
          </form>
          <Button
            size="sm"
            variant="primary"
            icon={RotateCcw}
            disabled={!current}
            loading={busy === 'restore'}
            onClick={async () => {
              if (!current) return;
              setBusy('restore');
              try {
                await beforeAction();
                const { rev } = await api.version.restore({ id: current.id });
                const page = await api.page.get({ id: pageId });
                onRestored(normaliseDocJson(page.doc), rev);
                notify.success(`Restored the version from ${formatDayLabel(current.createdAt)} ${formatTime(current.createdAt)}`);
                onOpenChange(false);
              } catch (err) {
                notify.fromError(err, "Couldn't restore that version");
              } finally {
                setBusy(null);
              }
            }}
          >
            Restore this version
          </Button>
        </div>
      }
    >
      <div className="emp-history">
        <div className="emp-history-list" role="listbox" aria-label="Versions">
          {versions === null ? (
            Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={44} radius={8} className="mb-1.5" />)
          ) : !versions.length ? (
            <EmptyState icon={History} title="No versions yet" body="EMP keeps a version every 10 minutes while you edit, and whenever you save one." />
          ) : (
            groups.map((g) => (
              <div key={g.day} className="emp-history-group">
                <div className="emp-menu-header">{g.day}</div>
                {g.items.map((v, i) => (
                  <button
                    key={v.id}
                    type="button"
                    role="option"
                    aria-selected={v.id === selected}
                    className={cn('emp-history-item', v.id === selected && 'is-active')}
                    onClick={() => setSelected(v.id)}
                  >
                    {v.id === selected ? <m.span layoutId="history-hl" className="emp-history-hl" transition={spring.glide} /> : null}
                    <span className="emp-history-time">{formatTime(v.createdAt)}</span>
                    <span className="emp-history-meta">
                      <span className="emp-history-reason">{v.label || REASON[v.reason] || 'Version'}</span>
                      <span className="emp-history-size">
                        {v.label ? `${REASON[v.reason] ?? 'Version'} · ` : ''}
                        {formatBytes(v.size)}
                        {g === groups[0] && i === 0 ? ' · latest' : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="emp-history-preview">
          {snapshot ? (
            <Editor key={snapshot.id} ownerId={`${pageId}:v:${snapshot.id}`} ownerKind="page" workspaceId={workspaceId} doc={snapshot.doc} docRev={0} readOnly pooled={false} autosave={false} />
          ) : selected ? (
            <div className="p-6">
              <Skeleton height={28} width="60%" radius={6} />
              <div className="mt-4 flex flex-col gap-2.5">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} height={12} width={`${70 + ((i * 13) % 30)}%`} />
                ))}
              </div>
            </div>
          ) : (
            <div className="emp-history-none">
              <History size={20} />
              <span>{versions && !versions.length ? 'Save a version to keep a snapshot you can come back to.' : 'Select a version to preview it.'}</span>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
