/**
 * Page header (§6.1): a 40px ink glyph (docs/DESIGN.md §8; legacy emoji icons render through the emoji map, unmapped
 * ones show nothing), hover controls (Add icon · Add cover · Style · History), the title in `display` style with an
 * "Untitled" placeholder, and the backlinks pill. Icons are picked from the curated Lucide set (IconPicker).
 */
import { AlertCircle, Check, CloudOff, History, ImagePlus, Loader2, Shapes, Type, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Cover as CoverT, PageFlags, PageMeta } from '@/backend/types';
import { PageIcon } from '@/features/shell/PageIcon';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { glyphName, PageGlyph } from '@/ui/icons/Icon';
import { IconPicker } from '@/ui/IconPicker';
import { vt, vtStyle } from '@/ui/motion/viewTransition';
import { Tooltip } from '@/ui/Tooltip';
import type { SaverSnapshot } from '../useDocSave';
import { Backlinks } from './Backlinks';
import { pickFiles, uploadBlob } from '../lib/assets';
import { Cover } from './Cover';
import { PageStyle } from './PageStyle';

export interface PageHeaderProps {
  meta: PageMeta;
  readOnly: boolean;
  status: SaverSnapshot | null;
  onTitle: (title: string) => void;
  onTitleExit: (where: 'start' | 'end') => void;
  /** Removing the icon (null). Picking one writes `{ t: 'lucide' }` through the tree store. */
  onIcon: (emoji: string | null) => void;
  onCover: (c: CoverT | null) => void;
  onFlags: (patch: Partial<PageFlags>) => void;
  onHistory: () => void;
  /** Backlinks list expanded — owned by PageView so the body below can FLIP when it changes. */
  backlinksOpen: boolean;
  onBacklinksOpen: (open: boolean) => void;
  titleRef?: React.RefObject<HTMLTextAreaElement | null>;
}

function SaveIndicator({ status }: { status: SaverSnapshot | null }) {
  const [flash, setFlash] = useState(false);
  const savedAt = status?.savedAt ?? null;
  useEffect(() => {
    if (!savedAt) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);
  const [slow, setSlow] = useState(false);
  const saving = status?.state === 'saving';
  useEffect(() => {
    if (!saving) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 700);
    return () => clearTimeout(t);
  }, [saving]);
  if (!status) return null;
  const s = status.state;
  let content: React.ReactNode = null;
  if (s === 'saving' && slow) content = (
    <>
      <Loader2 size={12} className="emp-spin" /> Saving…
    </>
  );
  else if (s === 'offline') content = (
    <>
      <CloudOff size={12} /> Saved on this device
    </>
  );
  else if (s === 'error') content = (
    <>
      <AlertCircle size={12} /> {status.error ?? 'Not saved yet'}
    </>
  );
  else if (s === 'conflict') content = (
    <>
      <AlertCircle size={12} /> Changed elsewhere
    </>
  );
  else if (flash) content = (
    <>
      <Check size={12} /> Saved
    </>
  );
  return (
    <span className={cn('emp-save-ind', (s === 'error' || s === 'conflict') && 'is-error')} data-visible={content ? '' : undefined} aria-live="polite">
      {content}
    </span>
  );
}

export function PageHeader({ meta, readOnly, status, onTitle, onTitleExit, onIcon, onCover, onFlags, onHistory, backlinksOpen, onBacklinksOpen, titleRef }: PageHeaderProps) {
  const [title, setTitle] = useState(meta.title);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = titleRef ?? localRef;
  const editingRef = useRef(false);
  const [iconOpen, setIconOpen] = useState(false);

  useEffect(() => {
    if (!editingRef.current) setTitle(meta.title);
  }, [meta.title]);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(resize, [title, meta.flags.font, meta.flags.fullWidth]);
  useEffect(() => {
    const ro = new ResizeObserver(resize);
    if (ref.current) ro.observe(ref.current.parentElement ?? ref.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const icon = meta.icon;
  const glyph = glyphName(icon);
  const showIcon = icon?.t === 'asset' || !!glyph;
  const pickIcon = (name: string) => void useTree.getState().updateMeta(meta.id, { icon: { t: 'lucide', v: name } });
  // v3: covers are images only. Stored gradient covers (v2) are not drawn — a flat slab reads as a missing image.
  const cover = meta.cover?.t === 'asset' ? meta.cover : null;
  const hasCover = !!cover;
  const addCover = async () => {
    const [f] = await pickFiles('image/png,image/jpeg,image/webp,image/gif,image/avif');
    if (!f) return;
    try {
      const a = await uploadBlob(meta.workspaceId, f, f.name);
      onCover({ t: 'asset', assetId: a.id, posY: 0.5 });
    } catch (e) {
      notify.fromError(e, "Couldn't upload that image");
    }
  };
  return (
    <>
      {cover ? <Cover cover={cover} workspaceId={meta.workspaceId} readOnly={readOnly} onChange={onCover} /> : null}
      <div className="emp-page-head" data-has-cover={hasCover ? '' : undefined} data-has-icon={showIcon ? '' : undefined}>
        {showIcon ? (
          <IconPicker open={iconOpen} onOpenChange={(o) => !readOnly && setIconOpen(o)} value={glyph} onSelect={pickIcon} onRemove={() => onIcon(null)}>
            <button type="button" className="emp-page-icon" data-glyph={glyph ? '' : undefined} aria-label="Change icon" disabled={readOnly} style={vtStyle(vt.pageIcon(meta.id))}>
              {icon?.t === 'asset' ? <PageIcon icon={icon} size={78} /> : <PageGlyph icon={icon} context="header" />}
            </button>
          </IconPicker>
        ) : null}
        {!readOnly ? (
          <div className="emp-page-controls">
            {showIcon ? (
              <button type="button" className="emp-page-ctl" onClick={() => onIcon(null)}>
                <X size={14} /> Remove icon
              </button>
            ) : (
              <IconPicker onSelect={pickIcon}>
                <button type="button" className="emp-page-ctl">
                  <Shapes size={14} /> Add icon
                </button>
              </IconPicker>
            )}
            {!hasCover ? (
              <button type="button" className="emp-page-ctl" onClick={() => void addCover()}>
                <ImagePlus size={14} /> Add cover
              </button>
            ) : null}
            <PageStyle flags={meta.flags} onChange={onFlags}>
              <button type="button" className="emp-page-ctl">
                <Type size={14} /> Style
              </button>
            </PageStyle>
            <Tooltip content="Versions and restore">
              <button type="button" className="emp-page-ctl" onClick={onHistory}>
                <History size={14} /> History
              </button>
            </Tooltip>
            <span className="flex-1" />
            <SaveIndicator status={status} />
          </div>
        ) : (
          <div className="emp-page-controls is-readonly">
            {meta.flags.locked ? <span className="emp-page-ctl is-static">Locked page</span> : null}
            <span className="flex-1" />
            <SaveIndicator status={status} />
          </div>
        )}
        <textarea
          ref={ref}
          className="emp-title"
          style={vtStyle(vt.pageTitle(meta.id))}
          rows={1}
          value={title}
          placeholder="Untitled"
          readOnly={readOnly}
          spellCheck
          aria-label="Page title"
          maxLength={1024}
          onFocus={() => (editingRef.current = true)}
          onBlur={() => {
            editingRef.current = false;
            if (title !== meta.title) onTitle(title);
          }}
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, ' ');
            setTitle(v);
            onTitle(v);
          }}
          onKeyDown={(e) => {
            const el = e.currentTarget;
            if (e.key === 'Enter') {
              e.preventDefault();
              onTitleExit('start');
            } else if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
              if (e.key === 'ArrowDown' || el.value.length === el.selectionStart) {
                e.preventDefault();
                onTitleExit('start');
              }
            }
          }}
        />
        <Backlinks pageId={meta.id} open={backlinksOpen} onOpenChange={onBacklinksOpen} />
      </div>
    </>
  );
}
