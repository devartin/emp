/** Backlinks (§7.10): a pill under the title, "N backlinks"; expands to sources with ±60-char snippets. */
import { AnimatePresence, m } from 'motion/react';
import { ArrowUpRight, ChevronRight, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, listen } from '@/backend';
import type { Backlink, Id } from '@/backend/types';
import { navigate } from '@/app/router';
import { cn } from '@/lib/cn';
import { ease } from '@/ui/motion/tokens';

export function Backlinks({ pageId }: { pageId: Id }) {
  const [links, setLinks] = useState<Backlink[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api.page
        .backlinks({ id: pageId })
        .then((l) => live && setLinks(l))
        .catch(() => live && setLinks([]));
    void load();
    const off = listen('page:changed', (e) => {
      if (e.id === pageId || e.docRev === undefined) return;
      if (t) clearTimeout(t);
      t = setTimeout(load, 600);
    });
    return () => {
      live = false;
      if (t) clearTimeout(t);
      off();
    };
  }, [pageId]);
  if (!links || !links.length) return null;
  const sources = new Set(links.map((l) => l.sourceId)).size;
  return (
    <div className="emp-backlinks">
      <button type="button" className={cn('emp-backlinks-pill', open && 'is-open')} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Link2 size={13} />
        <span>
          {links.length} backlink{links.length === 1 ? '' : 's'}
          {sources !== links.length ? ` · ${sources} page${sources === 1 ? '' : 's'}` : ''}
        </span>
        <ChevronRight size={13} className="emp-backlinks-chev" />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <m.ul
            className="emp-backlinks-list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1, transition: { duration: 0.2, ease: [...ease.out] as [number, number, number, number] } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.14, ease: [...ease.in] as [number, number, number, number] } }}
          >
            {links.map((l, i) => (
              <li key={`${l.sourceId}:${l.blockId ?? i}`}>
                <button type="button" className="emp-backlink" onClick={() => navigate(l.blockId ? { t: 'page', id: l.sourceId, blockId: l.blockId } : { t: 'page', id: l.sourceId })}>
                  <span className="emp-backlink-icon">{l.sourceIcon?.t === 'emoji' ? l.sourceIcon.v : '📄'}</span>
                  <span className="emp-backlink-body">
                    <span className="emp-backlink-title">
                      {l.sourceTitle}
                      <ArrowUpRight size={12} className="emp-backlink-arrow" />
                    </span>
                    <span className="emp-backlink-snippet">{l.snippet}</span>
                  </span>
                </button>
              </li>
            ))}
          </m.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
