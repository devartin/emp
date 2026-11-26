/**
 * The grid surface: two canvases (cells / overlay) under a transparent native scroll layer, so trackpad and wheel
 * scrolling stay on the compositor at 60fps while we paint only what's visible. Pointer interactions: click /
 * shift / ⌘ selection, drag-select with auto-scroll, header selection, column / row resize (double-click to fit),
 * the fill handle (⌥ to copy instead of extending a series), point mode while typing a formula, and the context menu.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isMac } from '@/lib/platform';
import { ContextMenu, ContextMenuTrigger } from '@/ui/ContextMenu';
import { CellEditor } from './CellEditor';
import { MAX_COLS, MAX_ROWS, normRect, rectContains } from './engine/addr';
import { GridCanvas } from './GridCanvas';
import { GridContextMenu } from './GridContextMenu';
import { useGridVersion, type GridController, type Pos } from './GridController';
import type { GridKeyUi } from './keys';

type Drag =
  | { kind: 'select'; extend: boolean }
  | { kind: 'cols'; anchor: number }
  | { kind: 'rows'; anchor: number }
  | { kind: 'resize-col'; index: number; start: number; size: number; indices: number[] }
  | { kind: 'resize-row'; index: number; start: number; size: number; indices: number[] }
  | { kind: 'fill'; copy: boolean }
  | { kind: 'point'; anchor: Pos };

export interface GridViewProps {
  ctrl: GridController;
  ui: GridKeyUi & { openCondFormat(): void };
  barRef: React.RefObject<HTMLTextAreaElement | null>;
}

const EDGE = 4;

export function GridView({ ctrl, ui, barRef }: GridViewProps) {
  useGridVersion(ctrl);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const overRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<GridCanvas | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const autoRaf = useRef(0);
  const [menuZone, setMenuZone] = useState<'cell' | 'colhead' | 'rowhead'>('cell');

  // Canvas renderer lifecycle.
  useLayoutEffect(() => {
    if (!baseRef.current || !overRef.current) return;
    const gc = new GridCanvas(ctrl, baseRef.current, overRef.current);
    canvasRef.current = gc;
    const root = rootRef.current!;
    const scroll = scrollRef.current!;
    const ro = new ResizeObserver(() => {
      const w = scroll.clientWidth;
      const h = scroll.clientHeight;
      gc.resize(w, h);
      ctrl.setViewport({ width: w, height: h, scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop });
    });
    ro.observe(root);
    return () => {
      ro.disconnect();
      gc.dispose();
      canvasRef.current = null;
    };
  }, [ctrl]);

  // Scroll a cell into view (keyboard navigation, find, name box).
  useEffect(() => {
    ctrl.scrollIntoView = (r: number, c: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const l = ctrl.layout();
      let { scrollLeft, scrollTop } = el;
      if (c >= l.fc) {
        const x0 = ctrl.cols.offset(c);
        const x1 = ctrl.cols.end(c);
        const maxLeft = x0 - l.frozenW;
        const minLeft = l.headerW + x1 - el.clientWidth;
        if (scrollLeft > maxLeft) scrollLeft = maxLeft;
        else if (scrollLeft < minLeft) scrollLeft = Math.min(maxLeft, minLeft);
      }
      if (r >= l.fr) {
        const y0 = ctrl.rows.offset(r);
        const y1 = ctrl.rows.end(r);
        const maxTop = y0 - l.frozenH;
        const minTop = l.headerH + y1 - el.clientHeight;
        if (scrollTop > maxTop) scrollTop = maxTop;
        else if (scrollTop < minTop) scrollTop = Math.min(maxTop, minTop);
      }
      if (scrollLeft !== el.scrollLeft || scrollTop !== el.scrollTop) {
        // Grow the spacer first if we are jumping beyond the current extent.
        ctrl.updateCounts();
        el.scrollTo({ left: Math.max(0, scrollLeft), top: Math.max(0, scrollTop) });
      }
    };
    return () => {
      ctrl.scrollIntoView = null;
    };
  }, [ctrl]);

  // Focus the grid on mount.
  useEffect(() => {
    const t = window.setTimeout(() => ctrl.focusGrid?.(), 60);
    return () => window.clearTimeout(t);
  }, [ctrl]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    ctrl.setViewport({ scrollLeft: el.scrollLeft, scrollTop: el.scrollTop });
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Which border (if any) a header point sits on. */
  const borderAt = (x: number, y: number): { axis: 'cols' | 'rows'; index: number } | null => {
    const l = ctrl.layout();
    if (y < l.headerH && x > l.headerW) {
      const h = ctrl.hit(x, y);
      const right = ctrl.colX(h.c, l) + ctrl.cols.size(h.c);
      const left = ctrl.colX(h.c, l);
      if (Math.abs(x - right) <= EDGE) return { axis: 'cols', index: h.c };
      if (Math.abs(x - left) <= EDGE && h.c > 0) return { axis: 'cols', index: h.c - 1 };
    }
    if (x < l.headerW && y > l.headerH) {
      const h = ctrl.hit(x, y);
      const bottom = ctrl.rowY(h.r, l) + ctrl.rows.size(h.r);
      const top = ctrl.rowY(h.r, l);
      if (Math.abs(y - bottom) <= EDGE) return { axis: 'rows', index: h.r };
      if (Math.abs(y - top) <= EDGE && h.r > 0) return { axis: 'rows', index: h.r - 1 };
    }
    return null;
  };

  const onFillHandle = (x: number, y: number): boolean => {
    if (ctrl.edit || ctrl.sel.ranges.length !== 1) return false;
    const p = ctrl.primary;
    if (p.r1 >= MAX_ROWS - 1 || p.c1 >= MAX_COLS - 1) return false;
    const rp = ctrl.rectPx(p);
    const hx = rp.x + rp.w - 1;
    const hy = rp.y + rp.h - 1;
    return Math.abs(x - hx) <= 6 && Math.abs(y - hy) <= 6;
  };

  const cursorFor = (x: number, y: number): string => {
    const b = borderAt(x, y);
    if (b) return b.axis === 'cols' ? 'col-resize' : 'row-resize';
    if (onFillHandle(x, y)) return 'crosshair';
    const h = ctrl.hit(x, y);
    if (h.zone === 'colhead') return 's-resize';
    if (h.zone === 'rowhead') return 'e-resize';
    if (h.zone === 'corner') return 'default';
    return 'cell';
  };

  // ── drag updates (also driven by the auto-scroll loop)
  const applyDrag = useCallback(
    (x: number, y: number) => {
      const d = dragRef.current;
      if (!d) return;
      const h = ctrl.hit(x, y);
      switch (d.kind) {
        case 'select':
          ctrl.extendTo({ r: h.r, c: h.c }, false);
          break;
        case 'cols':
          ctrl.selectCols(d.anchor, h.c);
          break;
        case 'rows':
          ctrl.selectRows(d.anchor, h.r);
          break;
        case 'resize-col': {
          const size = Math.max(16, d.size + (x - d.start));
          for (const i of d.indices) ctrl.cols.set(i, size);
          ctrl.previewResize('cols', d.index, size);
          break;
        }
        case 'resize-row': {
          const size = Math.max(12, d.size + (y - d.start));
          for (const i of d.indices) ctrl.rows.set(i, size);
          ctrl.previewResize('rows', d.index, size);
          break;
        }
        case 'fill': {
          const p = ctrl.primary;
          const dr = h.r > p.r1 ? h.r - p.r1 : h.r < p.r0 ? h.r - p.r0 : 0;
          const dc = h.c > p.c1 ? h.c - p.c1 : h.c < p.c0 ? h.c - p.c0 : 0;
          if (!dr && !dc) ctrl.fillPreview = null;
          else if (Math.abs(dr) * 24 >= Math.abs(dc) * 100) ctrl.fillPreview = { r0: Math.min(p.r0, h.r), r1: Math.max(p.r1, h.r), c0: p.c0, c1: p.c1 };
          else ctrl.fillPreview = { r0: p.r0, r1: p.r1, c0: Math.min(p.c0, h.c), c1: Math.max(p.c1, h.c) };
          ctrl.paint('overlay');
          break;
        }
        case 'point':
          ctrl.pointTo({ r: h.r, c: h.c }, { extend: true });
          break;
        default:
          break;
      }
    },
    [ctrl],
  );

  const autoScroll = useCallback(() => {
    if (autoRaf.current) return;
    const tick = () => {
      autoRaf.current = 0;
      const el = scrollRef.current;
      const p = pointer.current;
      const d = dragRef.current;
      if (!el || !p || !d || d.kind.startsWith('resize')) return;
      const l = ctrl.layout();
      const w = el.clientWidth;
      const h = el.clientHeight;
      let dx = 0;
      let dy = 0;
      if (p.x > w - 8) dx = Math.min(40, (p.x - w + 8) / 2);
      else if (p.x < l.headerW + l.frozenW && d.kind !== 'rows') dx = -Math.min(40, (l.headerW + l.frozenW - p.x) / 2);
      if (p.y > h - 8) dy = Math.min(40, (p.y - h + 8) / 2);
      else if (p.y < l.headerH + l.frozenH && d.kind !== 'cols') dy = -Math.min(40, (l.headerH + l.frozenH - p.y) / 2);
      if (d.kind === 'cols') dy = 0;
      if (d.kind === 'rows') dx = 0;
      if (dx || dy) {
        el.scrollBy(dx, dy);
        applyDrag(Math.max(l.headerW + 1, Math.min(p.x, w - 2)), Math.max(l.headerH + 1, Math.min(p.y, h - 2)));
        autoRaf.current = requestAnimationFrame(tick);
      }
    };
    autoRaf.current = requestAnimationFrame(tick);
  }, [applyDrag, ctrl]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const el = scrollRef.current!;
    // Ignore clicks on the native scrollbars.
    if (x > el.clientWidth || y > el.clientHeight) return;
    const h = ctrl.hit(x, y);
    const add = isMac ? e.metaKey : e.ctrlKey;
    if (e.button === 2) {
      setMenuZone(h.zone === 'corner' ? 'cell' : h.zone);
      const inside = ctrl.sel.ranges.some((r) => rectContains(r, h.r, h.c));
      if (!inside) {
        if (ctrl.edit) void ctrl.commitEdit(null);
        if (h.zone === 'colhead') ctrl.selectCols(h.c, h.c);
        else if (h.zone === 'rowhead') ctrl.selectRows(h.r, h.r);
        else ctrl.select({ r: h.r, c: h.c }, { scroll: false });
      }
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const border = borderAt(x, y);
    if (border) {
      const sel = ctrl.selectedIndices(border.axis);
      const indices = sel.includes(border.index) ? sel : [border.index];
      const size = border.axis === 'cols' ? ctrl.cols.size(border.index) : ctrl.rows.size(border.index);
      dragRef.current = border.axis === 'cols' ? { kind: 'resize-col', index: border.index, start: x, size, indices } : { kind: 'resize-row', index: border.index, start: y, size, indices };
      ctrl.previewResize(border.axis, border.index, size);
    } else if (onFillHandle(x, y)) {
      dragRef.current = { kind: 'fill', copy: e.altKey };
    } else if (ctrl.edit && h.zone === 'cell' && ctrl.canPoint()) {
      ctrl.pointTo({ r: h.r, c: h.c }, { extend: e.shiftKey });
      dragRef.current = { kind: 'point', anchor: { r: h.r, c: h.c } };
      // Keep focus in the editor.
      if (ctrl.edit?.origin === 'bar') barRef.current?.focus();
      else ctrl.focusGrid?.();
    } else {
      if (ctrl.edit) void ctrl.commitEdit(null);
      if (h.zone === 'corner') ctrl.selectAll();
      else if (h.zone === 'colhead') {
        if (e.shiftKey) ctrl.selectCols(ctrl.sel.anchor.c, h.c);
        else ctrl.selectCols(h.c, h.c, { add });
        dragRef.current = { kind: 'cols', anchor: e.shiftKey ? ctrl.sel.anchor.c : h.c };
      } else if (h.zone === 'rowhead') {
        if (e.shiftKey) ctrl.selectRows(ctrl.sel.anchor.r, h.r);
        else ctrl.selectRows(h.r, h.r, { add });
        dragRef.current = { kind: 'rows', anchor: e.shiftKey ? ctrl.sel.anchor.r : h.r };
      } else {
        ctrl.select({ r: h.r, c: h.c }, { extend: e.shiftKey, add, scroll: false });
        dragRef.current = { kind: 'select', extend: e.shiftKey };
      }
      ctrl.focusGrid?.();
    }
    pointer.current = { x, y };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    pointer.current = { x, y };
    const el = scrollRef.current!;
    if (!dragRef.current) {
      el.style.cursor = cursorFor(x, y);
      return;
    }
    applyDrag(x, y);
    autoScroll();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    const el = scrollRef.current!;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'resize-col' || d.kind === 'resize-row') {
      const axis = d.kind === 'resize-col' ? 'cols' : 'rows';
      const size = (axis === 'cols' ? ctrl.cols : ctrl.rows).size(d.index);
      void ctrl.resize(axis, d.indices, size);
    } else if (d.kind === 'fill') {
      const target = ctrl.fillPreview;
      ctrl.fillPreview = null;
      if (target) void ctrl.fill(ctrl.primary, target, d.copy || e.altKey ? 'copy' : 'series');
      ctrl.paint('overlay');
    } else if (d.kind === 'select') {
      void ctrl.refreshActive();
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const border = borderAt(x, y);
    if (border) {
      const sel = ctrl.selectedIndices(border.axis);
      void ctrl.resize(border.axis, sel.includes(border.index) ? sel : [border.index], 'auto');
      return;
    }
    if (onFillHandle(x, y)) {
      // Double-click the fill handle: fill down as far as the column to the left has data.
      const p = ctrl.primary;
      let r = p.r1;
      const probe = p.c0 > 0 ? p.c0 - 1 : p.c1 + 1;
      while ((ctrl.cell(r + 1, probe)?.k ?? 0) !== 0 && r - p.r1 < 100_000) r++;
      if (r > p.r1) void ctrl.fill(p, { ...p, r1: r }, 'series');
      return;
    }
    const h = ctrl.hit(x, y);
    if (h.zone === 'cell') {
      ctrl.select({ r: h.r, c: h.c }, { scroll: false });
      ctrl.beginEdit({ mode: 'edit' });
    }
  };

  useEffect(() => () => cancelAnimationFrame(autoRaf.current), []);

  const l = ctrl.layout();
  const spacerW = l.headerW + ctrl.cols.total();
  const spacerH = l.headerH + ctrl.rows.total();
  return (
    <div ref={rootRef} className="emp-sheet-grid" data-undo-scope="" role="grid" aria-label={`${ctrl.sheet?.name ?? 'Sheet'} grid`} aria-rowcount={ctrl.rows.count} aria-colcount={ctrl.cols.count}>
      <canvas ref={baseRef} className="emp-sheet-canvas" aria-hidden />
      <canvas ref={overRef} className="emp-sheet-canvas" aria-hidden />
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            className="emp-sheet-scroll"
            onScroll={onScroll}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
          >
            <div style={{ width: spacerW, height: spacerH }} />
          </div>
        </ContextMenuTrigger>
        <GridContextMenu ctrl={ctrl} zone={menuZone} onCondFormat={ui.openCondFormat} />
      </ContextMenu>
      <CellEditor ctrl={ctrl} ui={ui} gridRef={rootRef} barRef={barRef} />
    </div>
  );
}

export { normRect };
export default GridView;
