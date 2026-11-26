/** Searchable page / database picker (Move to…, link a database, choose a sheet or watchlist source). */
import { Database, FileText, Search, Sheet as SheetIcon } from 'lucide-react';
import { PageGlyphWith } from '@/ui/icons/glyphCore';
import { GLYPHS } from '@/ui/icons/glyphs';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/backend';
import type { Id, SearchHit, SearchHitKind } from '@/backend/types';
import { cn } from '@/lib/cn';
import { useTree } from '@/stores/tree';
import { useWorkspace } from '@/stores/workspace';
import { Floating, type RectLike } from './Floating';

export interface PagePickerProps {
  open: boolean;
  anchor: RectLike | (() => RectLike | null) | null;
  title: string;
  kinds?: SearchHitKind[];
  excludeId?: Id;
  onPick: (id: Id, hit: SearchHit) => void;
  onClose: () => void;
  placeholder?: string;
}

export function PagePicker({ open, anchor, title, kinds = ['page'], excludeId, onPick, onClose, placeholder = 'Search pages…' }: PagePickerProps) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const req = useRef(0);
  const kindKey = kinds.join(',');

  useEffect(() => {
    if (!open) return;
    const id = ++req.current;
    const t = setTimeout(() => {
      if (!q.trim() && kinds.includes('page')) {
        const byId = useTree.getState().byId;
        const recents = useWorkspace.getState().recents;
        const list = recents
          .map((r) => byId.get(r))
          .filter((p): p is NonNullable<typeof p> => !!p && p.id !== excludeId && kinds.includes(p.kind === 'doc' ? 'page' : (p.kind as SearchHitKind)))
          .slice(0, 8)
          .map((p) => ({ id: p.id, kind: 'page' as const, title: p.title, icon: p.icon, path: [], score: 1, updatedAt: p.updatedAt }));
        if (list.length) {
          setHits(list);
          return;
        }
      }
      void api.search
        .query({ q, filters: { type: kinds }, limit: 12, reqId: id })
        .then((res) => res.reqId === req.current && setHits(res.hits.filter((h) => h.id !== excludeId)))
        .catch(() => setHits([]));
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, kindKey, excludeId]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  return (
    <Floating open={open} anchor={anchor} onClose={onClose} className="emp-picker" role="dialog" ariaLabel={title} zIndex={45}>
      <div className="emp-picker-head">
        <Search size={14} className="text-tertiary" />
        <input
          autoFocus
          className="emp-picker-input"
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const h = hits[active];
              if (h) onPick(h.id, h);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <div className="emp-menu-header">{title}</div>
      <div className="emp-picker-list">
        {hits.length ? (
          hits.map((h, i) => (
            <button
              key={h.id}
              type="button"
              className={cn('emp-picker-item', i === active && 'is-active')}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(h.id, h)}
            >
              <span className="emp-picker-icon">
                <PageGlyphWith icon={h.icon} size={15} fallback="file" kindFallback={h.kind === 'database' ? Database : h.kind === 'sheet' ? SheetIcon : FileText} lookup={(n) => GLYPHS[n]} />
              </span>
              <span className="emp-picker-title">{h.title || 'Untitled'}</span>
              {h.path.length ? <span className="emp-picker-path">{h.path.join(' / ')}</span> : null}
            </button>
          ))
        ) : (
          <div className="emp-slash-empty">Nothing found</div>
        )}
      </div>
    </Floating>
  );
}
