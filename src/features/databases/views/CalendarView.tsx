/**
 * Calendar view (§8.3, §5.11 month): pick the date property, multi-day bars spanning weeks (lane packing),
 * "+N more" overflow, "+" on a day creates a row dated that day, weekends toggle, Today, and drag a chip to
 * reschedule (duration and time of day are preserved). Rows come from `db_query_range` for the visible weeks.
 */
import { addDays, addMonths, differenceInCalendarDays, format as dfmt, isSameMonth, isToday, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { AnimatePresence, m } from 'motion/react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, listen } from '@/backend';
import type { CellValue, DateValue, Id, Property, RowDTO } from '@/backend/types';
import { cn } from '@/lib/cn';
import { getWeekStart } from '@/lib/dates';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { IconButton } from '@/ui/IconButton';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/Popover';
import { useDbView } from '../context';
import { cellFor } from '../engine/filter';
import { isDateLike } from '../engine/schema';
import { cellDateRange, isoDayOf, optionById, plainText } from '../engine/values';
import { RowIcon } from '../properties/CellView';

const LANE_H = 22;
const MAX_LANES = 5;

interface Ev {
  row: RowDTO;
  start: Date;
  end: Date;
  title: string;
  color?: string;
}

interface Seg {
  ev: Ev;
  col: number;
  span: number;
  lane: number;
  contL: boolean;
  contR: boolean;
}

function shiftDate(v: DateValue, days: number): DateValue {
  const mv = (s: string) => {
    if (!v.time) {
      const [y, mo, d] = s.split('-').map(Number);
      return isoDayOf(new Date(y, mo - 1, d + days).getTime());
    }
    const t = new Date(s);
    t.setDate(t.getDate() + days);
    return t.toISOString();
  };
  return { ...v, start: mv(v.start), ...(v.end ? { end: mv(v.end) } : {}) };
}

export function CalendarView() {
  const { schema, view, propsById, openRow, newRow, readOnly, inline, databaseId, patchView } = useDbView();
  const dateProp = view.calendar?.dateProp ? propsById.get(view.calendar.dateProp) : undefined;
  const weekends = view.calendar?.showWeekends ?? true;
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [rows, setRows] = useState<RowDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState<{ day: Date; el: HTMLElement } | null>(null);
  const [drag, setDrag] = useState<{ id: Id; fromDay: string; overDay: string | null; x: number; y: number; title: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const ws = getWeekStart();
  const titleProp = propsById.get(schema.database.primaryPropId)!;
  const colorProp = useMemo(() => view.visibleProps.map((id) => propsById.get(id)).find((p): p is Property => !!p && (p.type === 'select' || p.type === 'status')), [view.visibleProps, propsById]);

  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: ws });
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const dayCols = useMemo(() => days.slice(0, 7).map((d, i) => ({ i, weekend: d.getDay() === 0 || d.getDay() === 6 })).filter((c) => weekends || !c.weekend), [days, weekends]);

  const load = useCallback(async () => {
    if (!dateProp) return;
    try {
      const r = await api.db.queryRange({ databaseId, viewId: view.id, dateProp: dateProp.id, from: isoDayOf(days[0].getTime()), to: isoDayOf(days[41].getTime()) });
      setRows(r);
    } catch (e) {
      notify.fromError(e, "Couldn't load the calendar");
    } finally {
      setLoading(false);
    }
  }, [databaseId, view.id, dateProp, days]);
  useEffect(() => {
    void load();
  }, [load, view.filter]);
  useEffect(() => listen('db:changed', (e) => e.databaseId === databaseId && void load()), [databaseId, load]);

  const events: Ev[] = useMemo(() => {
    if (!dateProp) return [];
    return rows
      .map((row): Ev | null => {
        const r = cellDateRange(cellFor(row, dateProp.type === 'created_time' ? '$created' : dateProp.type === 'updated_time' ? '$updated' : dateProp.id));
        if (!r) return null;
        const t = row.values[titleProp.id];
        const opt = colorProp ? optionById(colorProp, (row.values[colorProp.id] as { v?: string } | undefined)?.v ?? null) : undefined;
        return { row, start: startOfDay(r.start), end: startOfDay(r.end), title: t?.t === 'text' ? plainText(t.v) : '', color: opt?.color };
      })
      .filter((x): x is Ev => !!x)
      .sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - b.start.getTime() - (a.end.getTime() - a.start.getTime()));
  }, [rows, dateProp, titleProp.id, colorProp]);

  const weeks = useMemo(() => {
    const out: { days: Date[]; segs: Seg[]; overflow: Map<number, number>; height: number }[] = [];
    for (let w = 0; w < 6; w++) {
      const wd = days.slice(w * 7, w * 7 + 7);
      const ws0 = wd[0];
      const we = wd[6];
      const lanes: number[][] = [];
      const segs: Seg[] = [];
      const overflow = new Map<number, number>();
      for (const ev of events) {
        if (ev.end < ws0 || ev.start > we) continue;
        const a = Math.max(0, differenceInCalendarDays(ev.start, ws0));
        const b = Math.min(6, differenceInCalendarDays(ev.end, ws0));
        let lane = 0;
        while (lanes[lane]?.some((x) => x >= a && x <= b)) lane++;
        (lanes[lane] ??= []).push(...Array.from({ length: b - a + 1 }, (_, k) => a + k));
        if (lane >= MAX_LANES) {
          for (let k = a; k <= b; k++) overflow.set(k, (overflow.get(k) ?? 0) + 1);
          continue;
        }
        segs.push({ ev, col: a, span: b - a + 1, lane, contL: ev.start < ws0, contR: ev.end > we });
      }
      const used = Math.min(MAX_LANES, lanes.length);
      out.push({ days: wd, segs, overflow, height: Math.max(112, 30 + used * LANE_H + (overflow.size ? LANE_H : 0) + 6) });
    }
    return out;
  }, [days, events]);

  // map day index → visible column index (weekends hidden)
  const colOf = (i: number) => dayCols.findIndex((c) => c.i === i);
  const visSpan = (s: Seg) => {
    const cols = Array.from({ length: s.span }, (_, k) => colOf(s.col + k)).filter((x) => x >= 0);
    return cols.length ? { start: cols[0], span: cols[cols.length - 1] - cols[0] + 1 } : null;
  };

  const create = async (day: Date) => {
    if (!dateProp || dateProp.type !== 'date') return;
    await newRow({ [dateProp.id]: { t: 'date', v: { start: isoDayOf(day.getTime()), time: false } } }, { open: true });
    void load();
  };

  // ── drag to reschedule
  const startDrag = (e: React.PointerEvent, ev: Ev, fromDay: Date) => {
    if (readOnly || !dateProp || dateProp.type !== 'date' || e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    const dayAt = (px: number, py: number) => {
      const el = document.elementsFromPoint(px, py).find((n) => (n as HTMLElement).dataset?.day) as HTMLElement | undefined;
      return el?.dataset.day ?? null;
    };
    const move = (pe: PointerEvent) => {
      if (!started && Math.hypot(pe.clientX - x0, pe.clientY - y0) < 5) return;
      started = true;
      setDrag({ id: ev.row.id, fromDay: isoDayOf(fromDay.getTime()), overDay: dayAt(pe.clientX, pe.clientY), x: pe.clientX, y: pe.clientY, title: ev.title || 'Untitled' });
    };
    const up = (pe: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!started) return;
      window.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true });
      const to = dayAt(pe.clientX, pe.clientY);
      setDrag(null);
      if (!to) return;
      const delta = differenceInCalendarDays(new Date(to + 'T00:00:00'), new Date(isoDayOf(fromDay.getTime()) + 'T00:00:00'));
      if (!delta) return;
      const cur = ev.row.values[dateProp.id];
      if (cur?.t !== 'date' || !cur.v) return;
      const next: CellValue = { t: 'date', v: shiftDate(cur.v, delta) };
      setRows((rs) => rs.map((r) => (r.id === ev.row.id ? { ...r, values: { ...r.values, [dateProp.id]: next } } : r)));
      api.db.rowsUpdate({ updates: [{ id: ev.row.id, values: { [dateProp.id]: next } }] }).catch((err) => {
        notify.fromError(err, "Couldn't reschedule");
        void load();
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!dateProp) {
    const dateProps = schema.properties.filter((p) => isDateLike(p));
    return (
      <div className="edb-empty-view">
        <span>Show rows on a calendar by one of their dates.</span>
        <div className="flex gap-2 flex-wrap justify-center">
          {dateProps.map((p) => (
            <Button key={p.id} size="sm" variant="secondary" onClick={() => patchView({ calendar: { dateProp: p.id, showWeekends: true } })}>
              Use {p.name}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  const moreList = more ? events.filter((e) => e.start <= more.day && e.end >= more.day) : [];

  return (
    <div className={cn('edb-cal-wrap', inline && 'is-inline')}>
      <div className="edb-cal-head">
        <h3 className="edb-cal-month">
          <AnimatePresence mode="popLayout" initial={false}>
            <m.span key={month.toISOString()} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
              {dfmt(month, 'MMMM')} <span className="text-tertiary font-normal">{dfmt(month, 'yyyy')}</span>
            </m.span>
          </AnimatePresence>
        </h3>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => setMonth(startOfMonth(new Date()))}>
          Today
        </Button>
        <IconButton size="sm" icon={ChevronLeft} label="Previous month" onClick={() => setMonth((x) => addMonths(x, -1))} />
        <IconButton size="sm" icon={ChevronRight} label="Next month" onClick={() => setMonth((x) => addMonths(x, 1))} />
      </div>
      <div className="edb-cal" style={{ ['--cols' as string]: dayCols.length }} ref={gridRef} data-loading={loading ? '' : undefined}>
        <div className="edb-cal-dows">
          {dayCols.map((c) => (
            <span key={c.i} className={cn('edb-cal-dow', c.weekend && 'is-weekend')}>
              {dfmt(days[c.i], 'EEE')}
            </span>
          ))}
        </div>
        {weeks.map((w, wi) => (
          <div key={wi} className="edb-cal-week" style={{ minHeight: w.height }}>
            {dayCols.map((c) => {
              const d = w.days[c.i];
              const key = isoDayOf(d.getTime());
              const over = w.overflow.get(c.i) ?? 0;
              return (
                <div key={c.i} className={cn('edb-cal-day', !isSameMonth(d, month) && 'is-outside', c.weekend && 'is-weekend', drag?.overDay === key && 'is-drop')} data-day={key} onDoubleClick={() => !readOnly && void create(d)}>
                  <div className="edb-cal-daynum">
                    <span className={cn(isToday(d) && 'emp-month-today edb-today')}>{d.getDate() === 1 ? dfmt(d, 'MMM d') : d.getDate()}</span>
                    {!readOnly && dateProp.type === 'date' ? (
                      <button type="button" className="edb-cal-add" aria-label={`New on ${dfmt(d, 'MMM d')}`} onClick={() => void create(d)}>
                        <Plus size={12} aria-hidden />
                      </button>
                    ) : null}
                  </div>
                  {over ? (
                    <button type="button" className="edb-cal-more" style={{ top: 28 + Math.min(MAX_LANES, Math.max(...w.segs.map((x) => x.lane + 1), 0)) * LANE_H }} onClick={(e) => setMore({ day: d, el: e.currentTarget })}>
                      +{over} more
                    </button>
                  ) : null}
                </div>
              );
            })}
            <div className="edb-cal-lanes">
              {w.segs.map((s) => {
                const vs = visSpan(s);
                if (!vs) return null;
                return (
                  <m.button
                    key={s.ev.row.id + ':' + wi}
                    type="button"
                    className={cn('edb-ev', s.ev.color && 'is-colored', s.contL && 'cont-l', s.contR && 'cont-r', drag?.id === s.ev.row.id && 'is-dragging')}
                    style={{
                      left: `calc(${vs.start} * (100% / var(--cols)) + 4px)`,
                      width: `calc(${vs.span} * (100% / var(--cols)) - 8px)`,
                      top: 28 + s.lane * LANE_H,
                      ...(s.ev.color ? { ['--ev-fg' as string]: `var(--block-${s.ev.color}-text)`, ['--ev-bg' as string]: `var(--block-${s.ev.color}-bg)` } : null),
                    }}
                    onClick={() => openRow(s.ev.row.id)}
                    onPointerDown={(e) => startDrag(e, s.ev, w.days[s.col])}
                    title={s.ev.title}
                  >
                    {s.ev.row.icon ? <RowIcon icon={s.ev.row.icon} size={12} /> : null}
                    <span className="truncate">{s.ev.title || 'Untitled'}</span>
                  </m.button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {drag ? (
        <div className="edb-ev edb-ev-ghost" style={{ left: drag.x + 8, top: drag.y - 10 }} aria-hidden>
          {drag.title}
        </div>
      ) : null}
      {more ? (
        <Popover open onOpenChange={(o) => !o && setMore(null)}>
          <PopoverAnchor virtualRef={{ current: more.el }} />
          <PopoverContent className="edb-cal-pop">
            <div className="emp-menu-header !px-1">{dfmt(more.day, 'EEEE, MMM d')}</div>
            {moreList.map((e) => (
              <button key={e.row.id} type="button" className="emp-menu-item w-full" onClick={() => (setMore(null), openRow(e.row.id))}>
                <span className="edb-ev-dot" style={e.color ? { background: `var(--block-${e.color}-text)` } : undefined} />
                <span className="emp-menu-label text-left">{e.title || 'Untitled'}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
