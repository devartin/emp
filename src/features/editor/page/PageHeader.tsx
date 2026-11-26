/**
 * Page header (§6.1): 78px icon overlapping the cover by 39px, hover controls (Add icon · Add cover · Style ·
 * History), the title in `display` style with an "Untitled" placeholder, and the backlinks pill.
 */
import { m } from 'motion/react';
import { AlertCircle, Check, CloudOff, History, ImagePlus, Loader2, Smile, Type, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Cover as CoverT, PageFlags, PageMeta } from '@/backend/types';
import { PageIcon } from '@/features/shell/PageIcon';
import { cn } from '@/lib/cn';
import { spring } from '@/ui/motion/tokens';
import { vt, vtStyle } from '@/ui/motion/viewTransition';
import { EmojiPicker } from '@/ui/EmojiPicker';
import { Tooltip } from '@/ui/Tooltip';
import type { SaverSnapshot } from '../useDocSave';
import { Backlinks } from './Backlinks';
import { Cover, randomGradient } from './Cover';
import { PageStyle } from './PageStyle';

const STARTER_EMOJI = ['📝', '🌿', '🪐', '🧭', '📌', '✨', '🗂️', '🔖', '🌙', '🧠', '📚', '🎯'];

export interface PageHeaderProps {
  meta: PageMeta;
  readOnly: boolean;
  status: SaverSnapshot | null;
  onTitle: (title: string) => void;
  onTitleExit: (where: 'start' | 'end') => void;
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
  const hasCover = !!meta.cover;
  return (
    <>
      {meta.cover ? <Cover cover={meta.cover} workspaceId={meta.workspaceId} readOnly={readOnly} onChange={onCover} /> : null}
      <div className="emp-page-head" data-has-cover={hasCover ? '' : undefined} data-has-icon={icon ? '' : undefined}>
        {icon ? (
          <EmojiPicker open={iconOpen} onOpenChange={(o) => !readOnly && setIconOpen(o)} onSelect={(e) => onIcon(e)}>
            <m.button
              type="button"
              className="emp-page-icon"
              aria-label="Change icon"
              disabled={readOnly}
              style={vtStyle(vt.pageIcon(meta.id))}
              initial={{ opacity: 0, scale: 0.9, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={spring.pop}
            >
              <PageIcon icon={icon} size={78} />
            </m.button>
          </EmojiPicker>
        ) : null}
        {!readOnly ? (
          <div className="emp-page-controls">
            {icon ? (
              <button type="button" className="emp-page-ctl" onClick={() => onIcon(null)}>
                <X size={14} /> Remove icon
              </button>
            ) : (
              <button type="button" className="emp-page-ctl" onClick={() => onIcon(STARTER_EMOJI[Math.floor(Math.random() * STARTER_EMOJI.length)])}>
                <Smile size={14} /> Add icon
              </button>
            )}
            {!hasCover ? (
              <button type="button" className="emp-page-ctl" onClick={() => onCover({ t: 'gradient', v: randomGradient() })}>
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
