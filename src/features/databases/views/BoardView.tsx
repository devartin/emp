/**
 * Board view (§8.3, §4.2 DnD): columns from select / status / checkbox groups, 50 cards per column with infinite
 * scroll, a "No value" group, per-group rolling counts, collapse/hide groups, and pointer-driven drag between columns
 * with physics (S14) — pickup lifts the card into a raised plate (panel-raise, scale 1.03) that leans ≤ 3° into the
 * drag's horizontal velocity; siblings glide out of the way on the morph spring around a recessed landing slot; the
 * drop flies home on the drag spring and lands with a contact squash. Moving sets the group property and the manual
 * position in one call.
 * Layout animations are disabled above 300 visible cards.
 */
import { animate, AnimatePresence, m, useMotionValue, useReducedMotion } from 'motion/react';
import { ChevronsLeft, ChevronsRight, EyeOff, MoreHorizontal, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Id, Property, RowDTO } from '@/backend/types';
import { cn } from '@/lib/cn';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/ui/Menu';
import { Tag } from '@/ui/Tag';
import { spring } from '@/ui/motion/tokens';
import { RollingNumber } from '@/ui/motion/RollingNumber';
import { useDbView } from '../context';
import { NO_VALUE } from '../engine/group';
import { rt } from '../engine/values';
import { useController, type GroupState } from '../ViewController';
import { Card } from './Card';
import { groupCellValue } from './TableView';

interface Drag {
  id: Id;
  from: string;
  w: number;
  h: number;
  dx: number;
  dy: number;
  to: string;
  index: number;
  origin: DOMRect;
}

const LAYOUT_LIMIT = 300;

export function BoardView() {
  const { schema, view, controller, propsById, openRow, patchView, readOnly, inline } = useDbView();
  const snap = useController(controller);
  const reduced = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dropping, setDropping] = useState(false);
  const [editTitle, setEditTitle] = useState<Id | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const rotate = useMotionValue(0);

  const gp = view.groupBy ? propsById.get(view.groupBy.prop) : undefined;
  const titleProp = propsById.get(schema.database.primaryPropId)!;
  const cardProps = useMemo(() => view.visibleProps.map((id) => propsById.get(id)).filter((p): p is Property => !!p && p.id !== gp?.id), [view.visibleProps, propsById, gp?.id]);
  const card = view.card ?? { preview: 'none' as const, size: 'm' as const, fit: false };
  const collapsed = new Set(view.collapsedGroups);
  const groups = (snap.groups ?? []).filter((g) => !collapsed.has('h:' + g.key));
  const open = groups.filter((g) => !collapsed.has(g.key));
  const folded = groups.filter((g) => collapsed.has(g.key));
  const visibleCards = open.reduce((n, g) => n + g.ids.length, 0);
  const layoutOn = !reduced && !inline && visibleCards <= LAYOUT_LIMIT;
  const canDrag = !readOnly && !!gp && gp.type !== 'multi_select';

  // ── drag
  const colRects = useRef<{ key: string; rect: DOMRect; cards: { id: Id; mid: number }[] }[]>([]);
  const measure = () => {
    const root = scrollRef.current;
    if (!root) return;
    colRects.current = Array.from(root.querySelectorAll<HTMLElement>('[data-col-key]')).map((el) => ({
      key: el.dataset.colKey!,
      rect: el.getBoundingClientRect(),
      cards: Array.from(el.querySelectorAll<HTMLElement>('[data-card-id]')).map((c) => {
        const r = c.getBoundingClientRect();
        return { id: c.dataset.cardId!, mid: r.top + r.height / 2 };
      }),
    }));
  };
  const target = (px: number, py: number, id: Id): { to: string; index: number } | null => {
    const col = colRects.current.find((c) => px >= c.rect.left - 6 && px <= c.rect.right + 6) ?? null;
    if (!col) return null;
    const cards = col.cards.filter((c) => c.id !== id);
    let index = cards.findIndex((c) => py < c.mid);
    if (index < 0) index = cards.length;
    return { to: col.key, index };
  };

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, row: RowDTO, from: string) => {
      if (!canDrag || e.button !== 0) return;
      const el = e.currentTarget;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let started = false;
      let lastX = x0;
      let lastT = 0;
      let vxs = 0;
      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
          started = true;
          const r = el.getBoundingClientRect();
          measure();
          const d: Drag = { id: row.id, from, w: r.width, h: r.height, dx: x0 - r.left, dy: y0 - r.top, to: from, index: Math.max(0, colRects.current.find((c) => c.key === from)?.cards.findIndex((c) => c.id === row.id) ?? 0), origin: r };
          dragRef.current = d;
          x.set(r.left);
          y.set(r.top);
          setDrag(d);
          animate(scale, reduced ? 1 : 1.03, spring.release);
          animate(rotate, reduced ? 0 : 1.5, spring.release);
          lastX = ev.clientX;
          lastT = performance.now();
          document.body.classList.add('edb-dragging');
        }
        const d = dragRef.current;
        if (!d) return;
        x.set(ev.clientX - d.dx);
        y.set(ev.clientY - d.dy);
        if (!reduced) {
          // lean into the horizontal velocity (S14 "rotate in the drag direction"), resting at +1.5°
          const now = performance.now();
          const vx = (ev.clientX - lastX) / Math.max(1, now - lastT);
          lastX = ev.clientX;
          lastT = now;
          vxs = vxs * 0.7 + vx * 0.3;
          rotate.set(Math.max(-3, Math.min(3, 1.5 + vxs * 3)));
        }
        const sc = scrollRef.current;
        if (sc) {
          const b = sc.getBoundingClientRect();
          if (ev.clientX > b.right - 60) sc.scrollLeft += 12;
          else if (ev.clientX < b.left + 60) sc.scrollLeft -= 12;
        }
        const t = target(ev.clientX, ev.clientY, d.id);
        if (t && (t.to !== d.to || t.index !== d.index)) {
          const next = { ...d, ...t };
          dragRef.current = next;
          setDrag(next);
        }
      };
      const finish = (cancel: boolean) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('keydown', onKey);
        const d = dragRef.current;
        if (!started || !d) return;
        document.body.classList.remove('edb-dragging');
        window.addEventListener('click', (ce) => ce.stopPropagation(), { capture: true, once: true });
        setDropping(true);
        const ph = scrollRef.current?.querySelector<HTMLElement>('[data-placeholder]');
        const dest = cancel || !ph ? d.origin : ph.getBoundingClientRect();
        animate(rotate, 0, spring.drag);
        animate(scale, 1, spring.drag);
        animate(y, dest.top, spring.drag);
        void animate(x, dest.left, spring.drag).then(() => {
          if (!cancel && (d.to !== d.from || d.index !== (colRects.current.find((c) => c.key === d.from)?.cards.findIndex((c) => c.id === d.id) ?? -1))) {
            const value = gp ? groupCellValue(gp, d.to) : undefined;
            void controller.moveCard(d.id, d.from, d.to, d.index, gp && value !== undefined && value !== null ? { prop: gp.id, value } : gp && value === null ? { prop: gp.id, value: { t: gp.type === 'select' ? 'select' : 'status', v: null } as never } : undefined);
          }
          dragRef.current = null;
          setDrag(null);
          setDropping(false);
          // contact squash once the real card is back in its slot
          requestAnimationFrame(() => {
            const landed = scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(d.id)}"] > .edb-card`);
            if (landed && !reduced) {
              landed.animate(
                [
                  { transform: 'scale(1, 1)', transformOrigin: '50% 100%' },
                  { transform: 'scale(1.012, 0.975)', transformOrigin: '50% 100%', offset: 0.3 },
                  { transform: 'scale(1, 1)', transformOrigin: '50% 100%' },
                ],
                { duration: 240, easing: 'cubic-bezier(.2,0,0,1)' },
              );
            }
          });
        });
      };
      const onUp = () => finish(false);
      const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && finish(true);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canDrag, gp, controller, reduced],
  );

  const newCard = async (g: GroupState) => {
    const value = gp ? groupCellValue(gp, g.key) : undefined;
    const row = await controller.createRow({ values: value && gp ? { [gp.id]: value } : undefined, group: g.key });
    if (row) setEditTitle(row.id);
  };

  const ids = (g: GroupState) => {
    if (!drag) return g.ids;
    const rest = g.ids.filter((id) => id !== drag.id);
    if (g.key === drag.to) {
      const list: (Id | '__ph')[] = [...rest];
      list.splice(Math.min(drag.index, list.length), 0, '__ph');
      return list;
    }
    return rest;
  };

  if (!gp) {
    return <div className="edb-empty-view">Pick a select, status or checkbox property to group the board by — open Group in the toolbar.</div>;
  }

  const dragRow = drag ? snap.rows.get(drag.id) : undefined;

  return (
    <div className={cn('edb-board-wrap', inline && 'is-inline')}>
      <m.div ref={scrollRef} layoutScroll className="edb-board" data-dragging={drag ? '' : undefined}>
        {open.map((g) => (
          <Column
            key={g.key}
            g={g}
            ids={ids(g)}
            rows={snap.rows}
            gpName={gp.name}
            layoutOn={layoutOn}
            drag={drag}
            titleProp={titleProp}
            cardProps={cardProps}
            allProps={schema.properties}
            card={card}
            readOnly={readOnly}
            editTitle={editTitle}
            onTitle={(rowId, t) => {
              setEditTitle(null);
              if (t.trim()) void controller.updateCells(rowId, { [titleProp.id]: { t: 'text', v: rt(t.trim()) } }, { undo: false });
            }}
            onOpen={(id) => openRow(id)}
            onDragStart={startDrag}
            onNew={() => void newCard(g)}
            onMore={() => void controller.loadGroup(g.key)}
            onCollapse={() => patchView({ collapsedGroups: [...view.collapsedGroups, g.key] })}
            onHide={() => patchView({ collapsedGroups: [...view.collapsedGroups, 'h:' + g.key] })}
          />
        ))}
        {folded.length ? (
          <div className="edb-board-folded">
            <div className="edb-folded-title">Collapsed</div>
            {folded.map((g) => (
              <button key={g.key} type="button" className="edb-folded" data-col-key={g.key} onClick={() => patchView({ collapsedGroups: view.collapsedGroups.filter((k) => k !== g.key) })}>
                <ChevronsRight size={14} aria-hidden />
                {g.color ? <Tag color={g.color}>{g.label}</Tag> : <span>{g.label}</span>}
                <span className="edb-group-count tabular-nums">{g.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="edb-board-pad" />
      </m.div>
      <AnimatePresence>
        {drag && dragRow ? (
          <m.div
            className="edb-drag-ghost"
            style={{ x, y, scale, rotate, width: drag.w, height: drag.h, position: 'fixed', left: 0, top: 0 }}
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            data-dropping={dropping ? '' : undefined}
          >
            <Card row={dragRow} titleProp={titleProp} props={cardProps} allProps={schema.properties} card={card} variant="board" />
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

interface ColumnProps {
  g: GroupState;
  ids: (Id | '__ph')[];
  rows: Map<Id, RowDTO>;
  gpName: string;
  layoutOn: boolean;
  drag: Drag | null;
  titleProp: Property;
  cardProps: Property[];
  allProps: Property[];
  card: { preview: string; size: 's' | 'm' | 'l'; fit: boolean };
  readOnly: boolean;
  editTitle: Id | null;
  onTitle: (id: Id, t: string) => void;
  onOpen: (id: Id) => void;
  onDragStart: (e: React.PointerEvent<HTMLDivElement>, row: RowDTO, from: string) => void;
  onNew: () => void;
  onMore: () => void;
  onCollapse: () => void;
  onHide: () => void;
}

function Column({ g, ids, rows, gpName, layoutOn, drag, titleProp, cardProps, allProps, card, readOnly, editTitle, onTitle, onOpen, onDragStart, onNew, onMore, onCollapse, onHide }: ColumnProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const hasMore = g.ids.length < g.count;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && onMore(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onMore, g.ids.length]);
  const isTarget = drag && drag.to === g.key && drag.from !== g.key;
  return (
    <section className={cn('edb-col', isTarget && 'is-target')} data-col-key={g.key} aria-label={g.label}>
      <header className="edb-col-head">
        {g.color ? <Tag color={g.color}>{g.label}</Tag> : <span className={cn('edb-col-label', g.key === NO_VALUE && 'text-tertiary')}>{g.key === NO_VALUE ? `No ${gpName}` : g.label}</span>}
        <span className="edb-group-count tabular-nums">
          <RollingNumber value={g.count} />
        </span>
        <span className="flex-1" />
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" icon={MoreHorizontal} label="Group options" className="edb-col-action" />
          </MenuTrigger>
          <MenuContent width={200} align="end">
            <MenuItem icon={ChevronsLeft} onSelect={onCollapse}>
              Collapse group
            </MenuItem>
            <MenuItem icon={EyeOff} onSelect={onHide}>
              Hide group
            </MenuItem>
          </MenuContent>
        </Menu>
        {!readOnly ? <IconButton size="xs" icon={Plus} label={`New in ${g.label}`} className="edb-col-action" onClick={onNew} /> : null}
      </header>
      <div className="edb-col-body">
        {ids.map((id) => {
          if (id === '__ph') return <m.div key="__ph" layout={layoutOn} transition={spring.morph} initial={layoutOn ? { opacity: 0, scaleY: 0.6 } : false} animate={{ opacity: 1, scaleY: 1 }} className="edb-card-ph" data-placeholder="" style={{ height: drag?.h }} />;
          const row = rows.get(id);
          if (!row) return null;
          return (
            <m.div key={id} layout={layoutOn ? 'position' : false} transition={spring.morph} data-card-id={id}>
              <Card
                row={row}
                titleProp={titleProp}
                props={cardProps}
                allProps={allProps}
                card={card as never}
                variant="board"
                onOpen={() => editTitle !== id && onOpen(id)}
                onPointerDown={(e) => onDragStart(e, row, g.key)}
                editTitle={editTitle === id}
                onTitle={(t) => onTitle(id, t)}
              />
            </m.div>
          );
        })}
        {hasMore ? (
          <div ref={sentinel} className="edb-col-more">
            {g.loading ? 'Loading…' : `${g.count - g.ids.length} more`}
          </div>
        ) : null}
        {!readOnly ? (
          <button type="button" className="edb-col-new" onClick={onNew}>
            <Plus size={14} aria-hidden /> New
          </button>
        ) : null}
      </div>
    </section>
  );
}
