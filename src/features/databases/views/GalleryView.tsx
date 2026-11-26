/** Gallery view (§8.3): responsive card grid with cover images (files property, first image, or page content), S/M/L, fit. */
import { m } from 'motion/react';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { Property } from '@/backend/types';
import { cn } from '@/lib/cn';
import { Skeleton } from '@/ui/Skeleton';
import { spring } from '@/ui/motion/tokens';
import { useDbView } from '../context';
import { useController } from '../ViewController';
import { Card } from './Card';

const MIN: Record<string, number> = { s: 168, m: 232, l: 312 };
const MIN_INLINE: Record<string, number> = { s: 132, m: 172, l: 240 };

export function GalleryView() {
  const { schema, view, controller, propsById, openRow, newRow, readOnly, inline } = useDbView();
  const snap = useController(controller);
  const sentinel = useRef<HTMLDivElement>(null);
  const titleProp = propsById.get(schema.database.primaryPropId)!;
  const props = useMemo(() => view.visibleProps.map((id) => propsById.get(id)).filter((p): p is Property => !!p && p.id !== titleProp.id), [view.visibleProps, propsById, titleProp.id]);
  const card = view.card ?? { preview: 'cover' as const, size: 'm' as const, fit: false };
  const loaded = useMemo(() => {
    let n = 0;
    while (snap.index.has(n)) n++;
    const count = snap.ready ? Math.min(snap.total, n + Math.min(12, Math.max(0, snap.total - n))) : 8;
    return Array.from({ length: count }, (_, i) => {
      const id = snap.index.get(i);
      return id ? snap.rows.get(id) : undefined;
    });
  }, [snap]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) void controller.ensureRange(loaded.length, loaded.length + 100);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [controller, loaded.length]);

  return (
    <div className={cn('edb-gallery-wrap', inline && 'is-inline')}>
      <div className="edb-gallery" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${(inline ? MIN_INLINE : MIN)[card.size]}px, 1fr))` }}>
        {loaded.map((row, i) =>
          row ? (
            <m.div key={row.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.gentle, delay: Math.min(i, 12) * 0.02 }}>
              <Card row={row} titleProp={titleProp} props={props} allProps={schema.properties} card={card} variant="gallery" onOpen={() => openRow(row.id)} />
            </m.div>
          ) : (
            <div key={'sk' + i} className="edb-card is-gallery is-skeleton">
              <div className="edb-card-preview">
                <Skeleton height="100%" radius={0} />
              </div>
              <div className="edb-card-body">
                <Skeleton width="70%" height={10} />
              </div>
            </div>
          ),
        )}
        {!readOnly ? (
          <button type="button" className="edb-card is-gallery edb-card-new" onClick={() => void newRow(undefined, { open: true })}>
            <Plus size={18} aria-hidden />
            <span>New</span>
          </button>
        ) : null}
      </div>
      {loaded.length < snap.total ? <div ref={sentinel} className="edb-col-more">Loading more…</div> : null}
      {snap.ready && snap.total === 0 && view.filter ? <div className="edb-table-empty">No rows match these filters.</div> : null}
    </div>
  );
}
