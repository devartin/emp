/** List view (§8.3): title plus chosen properties, with grouping; virtualised when flat. */
import { useVirtualizer } from '@tanstack/react-virtual';
import { m } from 'motion/react';
import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { Id, Property, RowDTO } from '@/backend/types';
import { cn } from '@/lib/cn';
import { IconButton } from '@/ui/IconButton';
import { Skeleton } from '@/ui/Skeleton';
import { Tag } from '@/ui/Tag';
import { spring } from '@/ui/motion/tokens';
import { useDbView } from '../context';
import { cellFor } from '../engine/filter';
import { NO_VALUE } from '../engine/group';
import { isEmptyCell, plainText } from '../engine/values';
import { CellView, RowIcon } from '../properties/CellView';
import { useController } from '../ViewController';
import { groupCellValue } from './TableView';

const ROW_H = 40;

function ListRow({ row, titleProp, props, onOpen }: { row: RowDTO | undefined; titleProp: Property; props: Property[]; onOpen: (id: Id) => void }) {
  if (!row)
    return (
      <div className="edb-li is-loading">
        <Skeleton width={180} height={10} />
      </div>
    );
  const t = row.values[titleProp.id];
  const title = t?.t === 'text' ? plainText(t.v) : '';
  return (
    <div className="edb-li" role="button" tabIndex={0} onClick={() => onOpen(row.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(row.id))}>
      <span className="edb-li-icon">{row.icon ? <RowIcon icon={row.icon} /> : <span className="edb-li-dot" />}</span>
      <span className={cn('edb-li-title', !title && 'is-empty')}>{title || 'Untitled'}</span>
      <span className="edb-li-props">
        {props.map((p) => {
          const c = cellFor(row, p.type === 'created_time' ? '$created' : p.type === 'updated_time' ? '$updated' : p.id);
          if (isEmptyCell(c) && p.type !== 'checkbox') return null;
          return (
            <span key={p.id} className="edb-li-prop" data-type={p.type} title={p.name}>
              <CellView prop={p} cell={c} variant="list" readOnly />
            </span>
          );
        })}
      </span>
    </div>
  );
}

export function ListView() {
  const { schema, view, controller, propsById, openRow, patchView, newRow, readOnly, inline } = useDbView();
  const snap = useController(controller);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleProp = propsById.get(schema.database.primaryPropId)!;
  const props = useMemo(() => view.visibleProps.map((id) => propsById.get(id)).filter((p): p is Property => !!p && p.id !== titleProp.id), [view.visibleProps, propsById, titleProp.id]);
  const grouped = !!snap.groups;
  const virtualizer = useVirtualizer({ count: grouped ? 0 : snap.total, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 8 });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (!grouped && snap.ready) void controller.ensureRange(first, last);
  }, [first, last, grouped, controller, snap.ready]);
  const gp = view.groupBy ? propsById.get(view.groupBy.prop) : undefined;
  const collapsed = new Set(view.collapsedGroups);

  return (
    <div ref={scrollRef} className={cn('edb-list', inline && 'is-inline')}>
      {grouped ? (
        (snap.groups ?? []).filter((g) => !collapsed.has('h:' + g.key)).map((g) => {
          const isC = collapsed.has(g.key);
          const value = gp ? groupCellValue(gp, g.key) : undefined;
          return (
            <section key={g.key} className="edb-list-group">
              <div className="edb-group-head">
                <button type="button" className="edb-group-toggle" aria-expanded={!isC} onClick={() => patchView({ collapsedGroups: isC ? view.collapsedGroups.filter((k) => k !== g.key) : [...view.collapsedGroups, g.key] })}>
                  <m.span animate={{ rotate: isC ? 0 : 90 }} transition={spring.release} className="flex">
                    <ChevronRight size={14} aria-hidden />
                  </m.span>
                  {g.color ? <Tag color={g.color}>{g.label}</Tag> : <span className={cn('font-medium', g.key === NO_VALUE && 'text-tertiary')}>{g.label}</span>}
                  <span className="edb-group-count tabular-nums">{g.count}</span>
                </button>
                {!readOnly && value !== undefined ? <IconButton size="xs" icon={Plus} label={`New in ${g.label}`} onClick={() => void newRow(value && gp ? { [gp.id]: value } : undefined, { group: g.key, open: true })} /> : null}
              </div>
              {!isC
                ? g.ids.map((id) => <ListRow key={id} row={snap.rows.get(id)} titleProp={titleProp} props={props} onOpen={(rid) => openRow(rid)} />)
                : null}
              {!isC && g.ids.length < g.count ? (
                <button type="button" className="edb-tnew" onClick={() => void controller.loadGroup(g.key)}>
                  Load more
                </button>
              ) : null}
            </section>
          );
        })
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((it) => (
            <div key={it.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${it.start}px)` }}>
              <ListRow row={controller.rowAt(it.index)} titleProp={titleProp} props={props} onOpen={(id) => openRow(id)} />
            </div>
          ))}
        </div>
      )}
      {!grouped && !readOnly ? (
        <button type="button" className="edb-tnew" onClick={() => void newRow(undefined, { open: true })}>
          <Plus size={14} aria-hidden /> New
        </button>
      ) : null}
      {snap.ready && snap.total === 0 && !grouped ? <div className="edb-table-empty">{view.filter ? 'No rows match these filters.' : 'Nothing here yet.'}</div> : null}
    </div>
  );
}
