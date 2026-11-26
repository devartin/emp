/**
 * Table view (§8.3, §5.11 "Database table grid"): row virtualisation (overscan 8) over the ViewController windows
 * and column virtualisation (overscan 2), sticky header + title column, resizable and reorderable columns, per-column
 * wrap, inline editors per type, keyboard grid (arrows / Enter / Esc / Tab, Space → peek, ⌘↵ → open, ⌘⇧⌫ → delete,
 * ⌥⇧N → new), checkbox selection with bulk edit/duplicate/delete, manual drag reorder, footer calculations,
 * and grouped sections when the view has a group-by.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, m } from 'motion/react';
import { ChevronRight, Copy, GripVertical, PanelRight, Plus, Trash2, X } from 'lucide-react';
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
} from 'react';
import { api } from '@/backend';
import type { AggFn, CellValue, Id, Property, RowDTO } from '@/backend/types';
import { cn } from '@/lib/cn';
import { isMac } from '@/lib/platform';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/ui/Menu';
import { Tag } from '@/ui/Tag';
import { Tooltip } from '@/ui/Tooltip';
import { spring } from '@/ui/motion/tokens';
import { transitions } from '@/ui/motion/presets';
import { useDbView } from '../context';
import { aggsFor, AGG_LABEL, AGG_SHORT } from '../engine/schema';
import { cellFor } from '../engine/filter';
import { NO_VALUE } from '../engine/group';
import { isReadOnlyType, plainText, rowTitle } from '../engine/values';
import { CellEditor, CellEditorPopover, editorKind } from '../properties/CellEditor';
import { CellView, isRightAligned, MiniCheck, RowIcon } from '../properties/CellView';
import { TypeIcon } from '../properties/meta';
import { AddPropertyMenu, PropertyMenu } from '../properties/PropertyMenu';
import { useController, type ControllerSnapshot } from '../ViewController';
import { RollText } from './RollText';
import { RollingNumber } from '@/ui/motion/RollingNumber';
import { riseStagger } from '@/features/editor/lib/fx';

const GUTTER = 44;
const MIN_W = 64;
const MAX_W = 900;

export function defaultWidth(p: Property): number {
  switch (p.type) {
    case 'title':
      return 280;
    case 'text':
      return 240;
    case 'checkbox':
      return 96;
    case 'number':
    case 'money':
    case 'rating':
    case 'unique_id':
      return 128;
    case 'progress':
      return 150;
    case 'date':
    case 'created_time':
    case 'updated_time':
      return 170;
    case 'multi_select':
    case 'relation':
    case 'files':
      return 210;
    case 'url':
    case 'email':
      return 200;
    default:
      return 160;
  }
}

function readRowHeight(): number {
  if (typeof document === 'undefined') return 36;
  const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-table'), 10);
  return Number.isFinite(v) && v > 0 ? v : 36;
}

interface Col {
  prop: Property;
  width: number;
  left: number;
}

type Active = { r: number; c: number } | null;

// ───────────────────────────────────────────────────────────────────────────── header

function HeaderCell({ col, sticky, onOpen, onResize, onResizeEnd, onDragStart, dragging, sort }: { col: Col; sticky?: boolean; onOpen: (el: HTMLElement) => void; onResize: (w: number) => void; onResizeEnd: (w: number) => void; onDragStart?: (e: RPointerEvent, el: HTMLElement) => void; dragging?: boolean; sort?: 'asc' | 'desc' }) {
  const ref = useRef<HTMLDivElement>(null);
  const startResize = (e: RPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = col.width;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.max(MIN_W, Math.min(MAX_W, Math.round(w0 + ev.clientX - x0)));
      onResize(w);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onResizeEnd(w);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div
      ref={ref}
      role="columnheader"
      className={cn('edb-th', sticky && 'is-sticky', dragging && 'is-dragging', isRightAligned(col.prop) && 'is-num')}
      style={{ width: col.width, ...(sticky ? { left: GUTTER } : null) }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !onDragStart || !ref.current) return;
        onDragStart(e, ref.current);
      }}
      onClick={() => ref.current && onOpen(ref.current)}
      title={col.prop.description || undefined}
    >
      <TypeIcon type={col.prop.type} size={14} />
      <span className="edb-th-label">{col.prop.name}</span>
      {sort ? <span className="edb-th-sort" aria-label={sort === 'asc' ? 'Sorted ascending' : 'Sorted descending'}>{sort === 'asc' ? '↑' : '↓'}</span> : null}
      <span className="edb-th-resize" onPointerDown={startResize} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => (e.stopPropagation(), onResizeEnd(defaultWidth(col.prop)))} aria-hidden />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── row

interface RowProps {
  row: RowDTO | undefined;
  index: number;
  cols: Col[];
  title: Col;
  range: [number, number];
  padLeft: number;
  padRight: number;
  /** Active column in this row (-1 when the active cell is elsewhere). */
  active: number;
  selected: boolean;
  wrap: Record<Id, boolean>;
  readOnly: boolean;
  canDrag: boolean;
  top: number | null;
  height: number;
  wrapRows: boolean;
  measure?: (el: HTMLElement | null) => void;
  onCell: (index: number, c: number, el: HTMLElement, dbl: boolean) => void;
  onSelect: (id: Id, on: boolean, shift: boolean) => void;
  onOpen: (id: Id, mode?: 'peek' | 'page') => void;
  onToggle: (row: RowDTO, prop: Property, v: CellValue | null) => void;
  onDragHandle?: (e: RPointerEvent, row: RowDTO, index: number) => void;
  dropLine?: 'above' | 'below' | null;
}

const Row = memo(function Row({ row, index, cols, title, range, padLeft, padRight, active, selected, wrap, readOnly, canDrag, top, height, wrapRows, measure, onCell, onSelect, onOpen, onToggle, onDragHandle, dropLine }: RowProps) {
  const style: CSSProperties = top === null ? { position: 'relative', height } : { transform: `translateY(${top}px)`, height: wrapRows ? undefined : height, minHeight: height };
  if (!row) {
    // Static placeholders (no shimmer): fast scrolling through 10k rows shouldn't repaint animated gradients.
    return (
      <div className="edb-tr is-loading" style={style} role="row" aria-busy>
        <div className="edb-gutter" />
        <div className="edb-td is-sticky" style={{ width: title.width, left: GUTTER }}>
          <span className="edb-ph" style={{ width: Math.min(title.width - 40, 120 + ((index * 37) % 80)) }} />
        </div>
        <div style={{ width: padLeft, flex: 'none' }} />
        {cols.slice(range[0], range[1]).map((c, i) => (
          <div key={c.prop.id} className="edb-td" style={{ width: c.width }}>
            {(index + i) % 3 ? <span className="edb-ph" style={{ width: Math.min(c.width - 24, 48 + (((index + i) * 13) % 60)) }} /> : null}
          </div>
        ))}
        <div style={{ width: padRight, flex: 'none' }} />
      </div>
    );
  }
  const cell = (c: Col, ci: number, sticky?: boolean) => {
    const isActive = active === ci;
    const p = c.prop;
    const v = cellFor(row, p.type === 'created_time' ? '$created' : p.type === 'updated_time' ? '$updated' : p.id);
    const ro = readOnly || isReadOnlyType(p.type);
    return (
      <div
        key={p.id}
        role="gridcell"
        aria-selected={isActive || undefined}
        data-active={isActive ? '' : undefined}
        data-col={ci}
        className={cn('edb-td', sticky && 'is-sticky is-title', isRightAligned(p) && 'is-num', wrap[p.id] && 'is-wrap', ro && 'is-ro')}
        style={{ width: c.width, ...(sticky ? { left: GUTTER } : null) }}
        onClick={(e) => onCell(index, ci, e.currentTarget, false)}
        onDoubleClick={(e) => onCell(index, ci, e.currentTarget, true)}
      >
        {sticky ? (
          <>
            <RowIcon icon={row.icon} />
            <span className={cn('edb-title-text', !plainText((v as { v?: never[] } | undefined)?.v ?? []) && 'is-empty')}>
              {plainText(v?.t === 'text' ? v.v : []) || 'Untitled'}
            </span>
            {row.hasBody ? <span className="edb-has-body" title="Has page content" /> : null}
            <span className="edb-open">
              <button type="button" className="edb-open-btn" onClick={(e) => (e.stopPropagation(), onOpen(row.id))} title="Open in side peek">
                <PanelRight size={12} aria-hidden /> Open
              </button>
            </span>
          </>
        ) : (
          <CellView prop={p} cell={v} wrap={wrap[p.id]} onChange={ro ? undefined : (nv) => onToggle(row, p, nv)} readOnly={ro} />
        )}
      </div>
    );
  };
  return (
    <div ref={measure} data-index={index} className={cn('edb-tr', selected && 'is-selected', row.sample && 'is-sample')} style={style} role="row" aria-rowindex={index + 2} aria-selected={selected || undefined} data-drop={dropLine ?? undefined}>
      <div className="edb-gutter">
        {canDrag && onDragHandle ? (
          <span className="edb-drag" onPointerDown={(e) => onDragHandle(e, row, index)} aria-label="Drag to reorder" role="button" tabIndex={-1}>
            <GripVertical size={14} aria-hidden />
          </span>
        ) : null}
        <span className="edb-rowcheck" onClick={(e) => e.stopPropagation()}>
          <MiniCheck checked={selected} onChange={(on) => onSelect(row.id, on, false)} label={`Select ${rowTitle(row, title.prop.id) || 'row'}`} />
        </span>
      </div>
      {cell(title, 0, true)}
      <div style={{ width: padLeft, flex: 'none' }} />
      {cols.slice(range[0], range[1]).map((c, i) => cell(c, range[0] + i + 1))}
      <div style={{ width: padRight, flex: 'none' }} />
      <div className="edb-td-fill" />
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────── footer

function FooterCell({ col, fn, value, onChange, sticky }: { col: Col; fn?: AggFn; value?: string; onChange: (fn: AggFn | null) => void; sticky?: boolean }) {
  const fns = aggsFor(col.prop);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={cn('edb-tf', sticky && 'is-sticky', isRightAligned(col.prop) && 'is-num', !fn && 'is-empty')} style={{ width: col.width, ...(sticky ? { left: GUTTER } : null) }}>
          {fn ? (
            <>
              <span className="edb-tf-label">{AGG_SHORT[fn]}</span>
              <span className="edb-tf-value tabular-nums" data-sensitive={col.prop.type === 'money' ? '' : undefined}>
                {value == null ? '…' : <RollText text={value} sensitive={col.prop.type === 'money'} countUpKey={`edb-tf:${col.prop.id}:${fn}`} />}
              </span>
            </>
          ) : (
            <span className="edb-tf-hint">Calculate</span>
          )}
        </button>
      </MenuTrigger>
      <MenuContent width={220} side="top">
        <MenuLabel>{col.prop.name}</MenuLabel>
        <MenuItem onSelect={() => onChange(null)} trailing={!fn ? '✓' : undefined}>
          None
        </MenuItem>
        <MenuSeparator />
        {fns.map((f) => (
          <MenuItem key={f} onSelect={() => onChange(f)} trailing={fn === f ? '✓' : undefined}>
            {AGG_LABEL[f]}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

// ───────────────────────────────────────────────────────────────────────────── table

export function TableView() {
  const ctx = useDbView();
  const { schema, view, controller, readOnly, inline, patchView, openRow, propsById } = ctx;
  const snap = useController(controller);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowH] = useState(readRowHeight);
  const [widths, setWidths] = useState<Record<Id, number>>({});
  const [active, setActive] = useState<Active>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; rect: DOMRect; initial?: string } | null>(null);
  const [selected, setSelected] = useState<Set<Id>>(new Set());
  const [menu, setMenu] = useState<{ prop: Property; el: HTMLElement } | null>(null);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState({ top: false, left: false });
  const [scroll, setScroll] = useState({ left: 0, width: 1200 });
  const [colDrag, setColDrag] = useState<{ id: Id; x: number; offset: number; target: number } | null>(null);
  const [rowDrag, setRowDrag] = useState<{ id: Id; from: number; to: number } | null>(null);
  const [bulkEdit, setBulkEdit] = useState<{ prop: Property; rect: DOMRect } | null>(null);
  const lastSel = useRef<number | null>(null);

  useEffect(() => setWidths({}), [view.propWidths]);

  // ── columns
  const titleProp = propsById.get(schema.database.primaryPropId)!;
  const visible = useMemo(() => view.visibleProps.map((id) => propsById.get(id)).filter((p): p is Property => !!p && p.id !== titleProp.id), [view.visibleProps, propsById, titleProp.id]);
  const widthOf = useCallback((p: Property) => widths[p.id] ?? view.propWidths[p.id] ?? defaultWidth(p), [widths, view.propWidths]);
  const titleW = widthOf(titleProp);
  const title: Col = useMemo(() => ({ prop: titleProp, width: titleW, left: GUTTER }), [titleProp, titleW]);
  const cols: Col[] = useMemo(() => {
    let left = GUTTER + widthOf(titleProp);
    return visible.map((p) => {
      const c = { prop: p, width: widthOf(p), left };
      left += c.width;
      return c;
    });
  }, [visible, widthOf, titleProp]);
  const allCols = useMemo(() => [title, ...cols], [title, cols]);
  const totalW = GUTTER + title.width + cols.reduce((s, c) => s + c.width, 0);

  // column virtualisation (overscan 2)
  const range: [number, number] = useMemo(() => {
    if (cols.length <= 16) return [0, cols.length];
    const lo = scroll.left + GUTTER + title.width;
    const hi = scroll.left + scroll.width;
    let a = cols.findIndex((c) => c.left + c.width >= lo);
    let b = cols.findIndex((c) => c.left > hi);
    if (a < 0) a = 0;
    if (b < 0) b = cols.length;
    return [Math.max(0, a - 2), Math.min(cols.length, b + 2)];
  }, [cols, scroll, title.width]);
  const padLeft = range[0] > 0 ? cols[range[0]].left - (GUTTER + title.width) : 0;
  const padRight = range[1] < cols.length ? cols.slice(range[1]).reduce((s, c) => s + c.width, 0) : 0;

  // ── rows (flat)
  const grouped = !!snap.groups;
  const wrapAny = Object.values(view.wrap).some(Boolean);
  const virtualizer = useVirtualizer({
    count: grouped ? 0 : snap.total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 8,
    measureElement: wrapAny ? (el) => (el as HTMLElement).getBoundingClientRect().height : undefined,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (!grouped && snap.ready) void controller.ensureRange(first, last);
  }, [first, last, grouped, controller, snap.ready]);

  const rowList: RowDTO[] = useMemo(() => {
    if (snap.groups) return snap.groups.flatMap((g) => g.ids.map((id) => snap.rows.get(id)).filter((r): r is RowDTO => !!r));
    return [];
  }, [snap]);
  const rowAtIndex = useCallback((i: number): RowDTO | undefined => (grouped ? rowList[i] : controller.rowAt(i)), [grouped, rowList, controller]);
  const rowCount = grouped ? rowList.length : snap.total;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop > 0;
    const left = el.scrollLeft > 0;
    setScrolled((s) => (s.top === top && s.left === left ? s : { top, left }));
    if (cols.length > 16) setScroll((s) => (Math.abs(s.left - el.scrollLeft) < 40 && s.width === el.clientWidth ? s : { left: el.scrollLeft, width: el.clientWidth }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) setScroll({ left: el.scrollLeft, width: el.clientWidth });
  }, []);

  // ── editing
  const propAt = (c: number) => allCols[c]?.prop;
  const cellEl = (r: number, c: number) => gridRef.current?.querySelector<HTMLElement>(`[data-index="${r}"] [data-col="${c}"]`) ?? null;
  const beginEdit = (r: number, c: number, initial?: string) => {
    const p = propAt(c);
    const row = rowAtIndex(r);
    if (!p || !row || readOnly || isReadOnlyType(p.type)) return;
    if (p.type === 'checkbox') {
      const cur = row.values[p.id];
      void controller.updateCells(row.id, { [p.id]: { t: 'check', v: !(cur?.t === 'check' && cur.v) } }, { label: `Edit ${p.name}` });
      return;
    }
    if (editorKind(p) === 'none') return;
    const el = cellEl(r, c);
    if (!el) return;
    setEditing({ r, c, rect: el.getBoundingClientRect(), initial });
  };
  const moveActive = (r: number, c: number) => {
    const nr = Math.max(0, Math.min(rowCount - 1, r));
    const nc = Math.max(0, Math.min(allCols.length - 1, c));
    setActive({ r: nr, c: nc });
    if (!grouped) virtualizer.scrollToIndex(nr, { align: 'auto' });
    // horizontal reveal
    requestAnimationFrame(() => cellEl(nr, nc)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  };
  const onCell = useCallback((r: number, c: number, el: HTMLElement, dbl: boolean) => {
    setActive({ r, c });
    gridRef.current?.focus({ preventScroll: true });
    const p = (c === 0 ? title.prop : cols[c - 1]?.prop);
    if (!p) return;
    if (c === 0 && !dbl) return; // title: single click selects, Enter/double-click edits
    if (p.type === 'checkbox' || p.type === 'rating') return;
    if (dbl || editorKind(p) === 'popover' || c > 0) {
      const row = rowAtIndex(r);
      if (!row || readOnly || isReadOnlyType(p.type)) return;
      setEditing({ r, c, rect: el.getBoundingClientRect() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title.prop, cols, rowAtIndex, readOnly]);

  const commit = (r: number, c: number, v: CellValue | null) => {
    const row = rowAtIndex(r);
    const p = propAt(c);
    if (!row || !p) return;
    void controller.updateCells(row.id, { [p.id]: v }, { label: `Edit ${p.name}` });
  };

  const onToggle = useCallback((row: RowDTO, p: Property, v: CellValue | null) => void controller.updateCells(row.id, { [p.id]: v }, { label: `Edit ${p.name}` }), [controller]);
  const onSelect = useCallback((id: Id, on: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);
  const onOpen = useCallback((id: Id, mode?: 'peek' | 'page') => openRow(id, mode), [openRow]);

  const newRow = async (group?: string, values?: Record<Id, CellValue>) => {
    const id = await ctx.newRow(values, { group });
    if (!id) return;
    requestAnimationFrame(() => {
      const idx = grouped ? controller.orderedIds().indexOf(id) : snap.total;
      if (idx >= 0) {
        if (!grouped) virtualizer.scrollToIndex(idx, { align: 'auto' });
        setActive({ r: idx, c: 0 });
        setTimeout(() => {
          const el = cellEl(idx, 0);
          if (el) setEditing({ r: idx, c: 0, rect: el.getBoundingClientRect() });
        }, 60);
      }
    });
  };

  const deleteSelected = () => {
    const ids = selected.size ? [...selected] : active ? [rowAtIndex(active.r)?.id].filter((x): x is Id => !!x) : [];
    if (!ids.length) return;
    void controller.deleteRows(ids);
    setSelected(new Set());
  };

  const onKeyDown = (e: RKeyboardEvent) => {
    if (editing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (e.altKey && e.shiftKey && e.code === 'KeyN') {
      e.preventDefault();
      void newRow();
      return;
    }
    if (!active) {
      if (e.key.startsWith('Arrow') && rowCount) {
        e.preventDefault();
        setActive({ r: 0, c: 0 });
      }
      return;
    }
    const { r, c } = active;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return moveActive(r + 1, c);
      case 'ArrowUp':
        e.preventDefault();
        return moveActive(r - 1, c);
      case 'ArrowLeft':
        e.preventDefault();
        return moveActive(r, c - 1);
      case 'ArrowRight':
        e.preventDefault();
        return moveActive(r, c + 1);
      case 'Tab':
        e.preventDefault();
        return moveActive(r, c + (e.shiftKey ? -1 : 1));
      case 'Escape':
        e.preventDefault();
        if (selected.size) setSelected(new Set());
        else setActive(null);
        return;
      case 'Enter': {
        e.preventDefault();
        const row = rowAtIndex(r);
        if (mod && c === 0 && row) return openRow(row.id, 'page');
        return beginEdit(r, c);
      }
      case ' ': {
        e.preventDefault();
        const row = rowAtIndex(r);
        if (row) openRow(row.id, 'peek');
        return;
      }
      case 'Backspace':
      case 'Delete': {
        const p = propAt(c);
        const row = rowAtIndex(r);
        if (!p || !row || readOnly || isReadOnlyType(p.type) || p.type === 'title') return;
        e.preventDefault();
        void controller.updateCells(row.id, { [p.id]: null }, { label: `Clear ${p.name}` });
        return;
      }
      default: {
        if (mod && e.key === 'c') {
          const row = rowAtIndex(r);
          const p = propAt(c);
          if (row && p) {
            const el = cellEl(r, c);
            void navigator.clipboard?.writeText(el?.innerText ?? '').catch(() => undefined);
          }
          return;
        }
        if (e.key.length === 1 && !mod && !e.altKey) {
          const p = propAt(c);
          if (p && ['title', 'text', 'number', 'money', 'url', 'email', 'phone', 'ticker'].includes(p.type)) {
            e.preventDefault();
            beginEdit(r, c, e.key);
          } else if (p) beginEdit(r, c);
        }
      }
    }
  };

  // ── column drag-reorder
  const startColDrag = (e: RPointerEvent, col: Col, el: HTMLElement) => {
    if (readOnly) return;
    const x0 = e.clientX;
    const rect = el.getBoundingClientRect();
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - x0) < 5) return;
      started = true;
      const sc = scrollRef.current;
      const base = (sc?.getBoundingClientRect().left ?? 0) - (sc?.scrollLeft ?? 0);
      const x = ev.clientX - base;
      // find insertion index among cols
      let target = cols.length;
      for (let i = 0; i < cols.length; i++) if (x < cols[i].left + cols[i].width / 2) {
        target = i;
        break;
      }
      setColDrag({ id: col.prop.id, x: ev.clientX - (x0 - rect.left), offset: rect.top, target });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setColDrag((d) => {
        if (d) {
          const ids = cols.map((c) => c.prop.id);
          const from = ids.indexOf(d.id);
          const next = ids.filter((x) => x !== d.id);
          const at = d.target > from ? d.target - 1 : d.target;
          next.splice(at, 0, d.id);
          if (next.join() !== ids.join()) patchView({ visibleProps: [titleProp.id, ...next] });
          // swallow the click that ends a drag
          window.addEventListener('click', (ce) => ce.stopPropagation(), { capture: true, once: true });
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ── row drag-reorder (manual order only)
  const canDrag = !readOnly && !grouped && view.sorts.length === 0 && !snap.groups;
  const totalRef = useRef(snap.total);
  totalRef.current = snap.total;
  const startRowDrag = useCallback((e: RPointerEvent, row: RowDTO, index: number) => {
    e.preventDefault();
    const body = gridRef.current?.querySelector<HTMLElement>('.edb-tbody');
    if (!body) return;
    const move = (ev: PointerEvent) => {
      const y = ev.clientY - body.getBoundingClientRect().top;
      const to = Math.max(0, Math.min(totalRef.current, Math.round(y / rowH)));
      setRowDrag({ id: row.id, from: index, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRowDrag((d) => {
        if (d && d.to !== d.from && d.to !== d.from + 1) void controller.moveRow(d.id, d.to > d.from ? d.to - 1 : d.to);
        return null;
      });
    };
    setRowDrag({ id: row.id, from: index, to: index });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [controller, rowH]);

  // ── selection helpers
  const loadedIds = grouped ? rowList.map((r) => r.id) : controller.orderedIds();
  const allSel = loadedIds.length > 0 && loadedIds.every((id) => selected.has(id));
  const someSel = selected.size > 0 && !allSel;
  useEffect(() => {
    lastSel.current = null;
  }, [view.id]);

  const footerFor = (c: Col, sticky?: boolean) => (
    <FooterCell
      key={c.prop.id}
      col={c}
      sticky={sticky}
      fn={view.footerAggs[c.prop.id]}
      value={snap.aggs[c.prop.id]}
      onChange={(fn) => {
        const next = { ...view.footerAggs };
        if (fn) next[c.prop.id] = fn;
        else delete next[c.prop.id];
        patchView({ footerAggs: next });
      }}
    />
  );

  const rowProps = (row: RowDTO | undefined, index: number, top: number | null, measure?: (el: HTMLElement | null) => void): RowProps => ({
    row,
    index,
    cols,
    title,
    range,
    padLeft,
    padRight,
    active: active && active.r === index ? active.c : -1,
    top,
    height: rowH,
    wrapRows: wrapAny,
    selected: !!row && selected.has(row.id),
    wrap: view.wrap,
    readOnly,
    canDrag,
    measure,
    onCell,
    onSelect,
    onOpen,
    onToggle,
    onDragHandle: canDrag ? startRowDrag : undefined,
    dropLine: rowDrag && rowDrag.to === index && rowDrag.from !== index && rowDrag.from + 1 !== index ? 'above' : rowDrag && rowDrag.to === index + 1 && index === snap.total - 1 && rowDrag.from !== index ? 'below' : null,
  });

  const editingRow = editing ? rowAtIndex(editing.r) : undefined;
  const editingProp = editing ? propAt(editing.c) : undefined;

  const header = (
    <div className={cn('edb-thead', scrolled.top && 'is-scrolled')} role="row" style={{ width: totalW + 120 }}>
      <div className="edb-gutter is-head">
        <span className="edb-rowcheck is-head" data-visible={selected.size ? '' : undefined}>
          <MiniCheck checked={allSel} indeterminate={someSel} onChange={(on) => setSelected(on && !someSel ? new Set(loadedIds) : new Set())} label="Select all rows" />
        </span>
      </div>
      <HeaderCell col={title} sticky onOpen={(el) => setMenu({ prop: title.prop, el })} onResize={(w) => setWidths((x) => ({ ...x, [title.prop.id]: w }))} onResizeEnd={(w) => patchView({ propWidths: { ...view.propWidths, [title.prop.id]: w } })} sort={view.sorts.find((s) => s.prop === title.prop.id)?.dir} />
      <div style={{ width: padLeft, flex: 'none' }} />
      {cols.slice(range[0], range[1]).map((c) => (
        <HeaderCell
          key={c.prop.id}
          col={c}
          dragging={colDrag?.id === c.prop.id}
          onOpen={(el) => setMenu({ prop: c.prop, el })}
          onResize={(w) => setWidths((x) => ({ ...x, [c.prop.id]: w }))}
          onResizeEnd={(w) => patchView({ propWidths: { ...view.propWidths, [c.prop.id]: w } })}
          onDragStart={(e, el) => startColDrag(e, c, el)}
          sort={view.sorts.find((s) => s.prop === c.prop.id)?.dir}
        />
      ))}
      <div style={{ width: padRight, flex: 'none' }} />
      {!readOnly ? (
        <button type="button" className="edb-th edb-th-add" onClick={(e) => setAdding(e.currentTarget)} aria-label="Add a property">
          <Plus size={14} aria-hidden />
        </button>
      ) : null}
      <div className="edb-th-fill" />
      {colDrag ? (
        <span className="edb-col-drop" style={{ left: colDrag.target < cols.length ? cols[colDrag.target].left : (cols[cols.length - 1]?.left ?? 0) + (cols[cols.length - 1]?.width ?? 0) }} aria-hidden />
      ) : null}
    </div>
  );

  const footer = (
    <div className="edb-tfoot" style={{ width: totalW + 120 }}>
      <div className="edb-gutter" />
      {footerFor(title, true)}
      <div style={{ width: padLeft, flex: 'none' }} />
      {cols.slice(range[0], range[1]).map((c) => footerFor(c))}
      <div style={{ width: padRight, flex: 'none' }} />
      <div className="edb-th-fill" />
    </div>
  );

  return (
    <div className={cn('edb-table-wrap', inline && 'is-inline')}>
      <div
        ref={scrollRef}
        className={cn('edb-table-scroll', scrolled.left && 'is-scrolled-x')}
        onScroll={onScroll}
      >
        <div
          ref={gridRef}
          className="edb-table"
          role="grid"
          aria-rowcount={rowCount + 1}
          aria-colcount={allCols.length}
          aria-label={`${schema.database.title || 'Database'} — ${view.name}`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          style={{ minWidth: totalW + 120 }}
        >
          {header}
          {grouped ? (
            <GroupedBody snap={snap} rowProps={rowProps} onNew={(g, values) => void newRow(g, values)} totalW={totalW} />
          ) : (
            <div className="edb-tbody" style={{ height: virtualizer.getTotalSize(), width: totalW + 120 }}>
              {items.map((it) => (
                <Row key={it.key} {...rowProps(controller.rowAt(it.index), it.index, it.start, wrapAny ? virtualizer.measureElement : undefined)} />
              ))}
            </div>
          )}
          {!grouped && !readOnly ? (
            <button type="button" className="edb-tnew" onClick={() => void newRow()} style={{ width: totalW }}>
              <Plus size={14} aria-hidden /> New
            </button>
          ) : null}
          {!grouped && snap.ready && snap.total === 0 ? <div className="edb-table-empty">{view.filter || controller.hasSearch() ? 'No rows match.' : 'No rows yet. Press New or ⌥⇧N to add one.'}</div> : null}
          {footer}
        </div>
      </div>
      {colDrag ? (
        <div className="edb-col-ghost" style={{ left: colDrag.x, top: colDrag.offset, width: cols.find((c) => c.prop.id === colDrag.id)?.width }} aria-hidden>
          <TypeIcon type={propsById.get(colDrag.id)?.type ?? 'text'} size={14} /> {propsById.get(colDrag.id)?.name}
        </div>
      ) : null}
      {editing && editingRow && editingProp ? (
        <CellEditorPopover anchor={editing.rect} overlay={editorKind(editingProp) === 'overlay'} width={editingProp.type === 'title' || editingProp.type === 'text' ? Math.max(editing.rect.width, 260) : undefined} onOutside={() => setEditing(null)}>
          <CellEditor
            databaseId={schema.database.id}
            prop={editingProp}
            row={editingRow}
            cell={editingRow.values[editingProp.id]}
            initialText={editing.initial}
            onCommit={(v) => commit(editing.r, editing.c, v)}
            onClose={(reason) => {
              const { r, c } = editing;
              setEditing(null);
              gridRef.current?.focus({ preventScroll: true });
              if (reason === 'tab') moveActive(r, c + 1);
              else if (reason === 'enter' && editorKind(editingProp) === 'overlay' && editingProp.type !== 'text') moveActive(r + 1, c);
            }}
          />
        </CellEditorPopover>
      ) : null}
      {menu ? <PropertyMenu schema={schema} view={view} prop={menu.prop} anchor={menu.el} open onOpenChange={(o) => !o && setMenu(null)} patchView={patchView} openFilter={ctx.openFilter} readOnly={readOnly} /> : null}
      {adding ? <AddPropertyMenu schema={schema} view={view} patchView={patchView} anchor={adding} open onOpenChange={(o) => !o && setAdding(null)} /> : null}
      <AnimatePresence>
        {selected.size ? (
          <m.div className="edb-bulk" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: spring.ui }} exit={{ opacity: 0, y: 8, transition: transitions.menuOut }} role="toolbar" aria-label="Selected rows">
            <span className="edb-bulk-count tabular-nums">{selected.size} selected</span>
            <span className="edb-bulk-sep" />
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm" variant="ghost">
                  Edit property
                </Button>
              </MenuTrigger>
              <MenuContent width={220} side="top">
                {schema.properties
                  .filter((p) => !isReadOnlyType(p.type) && p.type !== 'title' && p.type !== 'secret')
                  .map((p) => (
                    <MenuItem
                      key={p.id}
                      icon={<TypeIcon type={p.type} size={16} />}
                      onSelect={() => {
                        const bar = document.querySelector('.edb-bulk');
                        if (bar) setBulkEdit({ prop: p, rect: bar.getBoundingClientRect() });
                      }}
                    >
                      {p.name}
                    </MenuItem>
                  ))}
              </MenuContent>
            </Menu>
            <Button size="sm" variant="ghost" icon={Copy} onClick={() => void controller.duplicateRows([...selected])}>
              Duplicate
            </Button>
            <Tooltip content="Delete" shortcut="mod+shift+backspace">
              <Button size="sm" variant="destructive-ghost" icon={Trash2} onClick={deleteSelected}>
                Delete
              </Button>
            </Tooltip>
            <IconButton size="sm" icon={X} label="Clear selection" onClick={() => setSelected(new Set())} />
          </m.div>
        ) : null}
      </AnimatePresence>
      {bulkEdit ? (
        <CellEditorPopover anchor={new DOMRect(bulkEdit.rect.left, bulkEdit.rect.top - 8, 1, 1)} overlay={false} onOutside={() => setBulkEdit(null)}>
          <CellEditor
            databaseId={schema.database.id}
            prop={bulkEdit.prop}
            row={null}
            cell={undefined}
            onCommit={(v) => {
              const ids = [...selected];
              void api.db
                .rowsUpdate({ updates: ids.map((id) => ({ id, values: { [bulkEdit.prop.id]: v } })) })
                .then(() => notify.success(`Updated ${ids.length} ${ids.length === 1 ? 'row' : 'rows'}`))
                .catch((e) => notify.fromError(e, "Couldn't update rows"));
            }}
            onClose={() => setBulkEdit(null)}
          />
        </CellEditorPopover>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── grouped body

function GroupedBody({ snap, rowProps, onNew, totalW }: { snap: ControllerSnapshot; rowProps: (row: RowDTO | undefined, index: number, top: number | null) => RowProps; onNew: (group: string, values?: Record<Id, CellValue>) => void; totalW: number }) {
  const { view, patchView, controller, propsById, readOnly } = useDbView();
  const collapsed = new Set(view.collapsedGroups);
  const gp = view.groupBy ? propsById.get(view.groupBy.prop) : undefined;
  // group collapse: sections below glide (layout morph) and a re-opened group's rows rise in (16ms, cap 12)
  const prevCollapsed = useRef(collapsed);
  const opened = new Set([...prevCollapsed.current].filter((k) => !collapsed.has(k)));
  useEffect(() => {
    prevCollapsed.current = collapsed;
  });
  const glide = (snap.groups ?? []).reduce((n, g) => n + g.ids.length, 0) <= 300;
  let index = -1;
  return (
    <div className="edb-groups">
      {(snap.groups ?? []).filter((g) => !collapsed.has('h:' + g.key)).map((g) => {
        const isCollapsed = collapsed.has(g.key);
        const groupValue = gp ? groupCellValue(gp, g.key) : undefined;
        return (
          <m.section key={g.key} className="edb-group-sec" layout={glide ? 'position' : false} transition={spring.morph}>
            <div className="edb-group-head" style={{ width: Math.min(totalW, 99999) }}>
              <button
                type="button"
                className="edb-group-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => patchView({ collapsedGroups: isCollapsed ? view.collapsedGroups.filter((k) => k !== g.key) : [...view.collapsedGroups, g.key] })}
              >
                <m.span animate={{ rotate: isCollapsed ? 0 : 90 }} transition={spring.release} className="flex">
                  <ChevronRight size={14} aria-hidden />
                </m.span>
                {g.color ? <Tag color={g.color}>{g.label}</Tag> : <span className="font-medium">{g.key === NO_VALUE ? <span className="text-tertiary">{g.label}</span> : g.label}</span>}
                <span className="edb-group-count tabular-nums">
                  <RollingNumber value={g.count} countUp={false} />
                </span>
              </button>
              <span className="edb-group-aggs">
                {Object.entries(g.aggs).filter(([pid]) => view.footerAggs[pid] !== 'count').map(([pid, v]) => (
                  <span key={pid} className="edb-group-agg">
                    <span className="text-tertiary">{propsById.get(pid)?.name}</span> <span className="tabular-nums">{v}</span>
                  </span>
                ))}
              </span>
              {!readOnly && groupValue !== undefined ? (
                <IconButton size="xs" icon={Plus} label={`New in ${g.label}`} onClick={() => onNew(g.key, groupValue && gp ? { [gp.id]: groupValue } : undefined)} />
              ) : null}
            </div>
            {!isCollapsed ? (
              <div className="edb-group-rows" ref={opened.has(g.key) ? riseRows : undefined}>
                {g.ids.map((id) => {
                  index += 1;
                  const row = snap.rows.get(id);
                  return <Row key={id + ':' + g.key} {...rowProps(row, index, null)} />;
                })}
                {g.ids.length < g.count ? (
                  <button type="button" className="edb-tnew" onClick={() => void controller.loadGroup(g.key)}>
                    Load {Math.min(50, g.count - g.ids.length)} more
                  </button>
                ) : null}
              </div>
            ) : null}
          </m.section>
        );
      })}
    </div>
  );
}

/** Callback ref: a group that was just re-opened has its rows rise in under the header. */
function riseRows(el: HTMLDivElement | null) {
  if (el) riseStagger(el.querySelectorAll('.edb-tr'), { step: 16, cap: 12, y: -6 });
}

/** The cell value that puts a row into group `key` (for "New" in a group and board drops). */
export function groupCellValue(p: Property, key: string): CellValue | null | undefined {
  const none = key === NO_VALUE;
  switch (p.type) {
    case 'select':
      return { t: 'select', v: none ? null : key };
    case 'status':
      if (key === 'todo' || key === 'in_progress' || key === 'complete') {
        const opt = ((p.config.options as { id: string; group?: string }[]) ?? []).find((o) => (o.group ?? 'todo') === key);
        return { t: 'status', v: opt?.id ?? null };
      }
      return { t: 'status', v: none ? null : key };
    case 'multi_select':
      return { t: 'multi', v: none ? [] : [key] };
    case 'checkbox':
      return { t: 'check', v: key === 'true' };
    case 'relation':
      return { t: 'relation', v: none ? [] : [key] };
    case 'text':
    case 'title':
      return none ? null : { t: 'text', v: [{ text: key.replace(/^v:/, '') }] };
    default:
      return undefined;
  }
}

