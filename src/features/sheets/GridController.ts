/**
 * GridController (§13.2): a plain class that owns a workbook's client state — sheets, styles, axis sizes, a tile
 * cache (256 rows × 32 columns per tile, LRU of 64 tiles per sheet), merges, selection, the in-cell edit, the copy
 * marquee and find results. React reads it through `useGridVersion` (useSyncExternalStore); the canvas subscribes to
 * paint requests. Every mutation goes through `api.sheet.*` and reconciles with `changed` / `dirtyRects`.
 */
import { useSyncExternalStore } from 'react';
import { api, listen, type Unlisten } from '@/backend';
import type { CellStyle, CondFormatRule, PackedCells, Rect, SheetMeta } from '@/backend/types';
import { notify } from '@/stores/toasts';
import { Axis } from './axis';
import { cellKey, cellName, colName, MAX_COLS, MAX_ROWS, normRect, parseCell, rectContains, rectName, rectsIntersect } from './engine/addr';
import { tokenize } from './engine/lexer';
import { adjustDecimals } from './engine/numfmt';
import { toTSV } from './engine/ops';
import { shiftFormula } from './engine/refs';

export const TILE_ROWS = 256;
export const TILE_COLS = 32;
const TILE_LRU = 64;
export const DEFAULT_ROW_H = 24;
export const DEFAULT_COL_W = 100;
export const HEADER_H = 24;
const MIN_ROWS = 200;
const MIN_COLS = 26;

export interface CellData {
  d: string;
  /** 0 empty, 1 num, 2 text, 3 bool, 4 err, 5 pending */
  k: number;
  /** 1 formula, 2 spill child */
  f: number;
  s: number;
  /** Conditional-format style overlay. */
  cf?: number;
  /** Data bar length 0..1 and its colour style. */
  bar?: number;
  barStyle?: number;
}

interface Tile {
  key: string;
  tr: number;
  tc: number;
  cells: Map<number, CellData>;
  state: 'loading' | 'ready';
  stale: boolean;
  req: number;
  used: number;
}

export interface Pos {
  r: number;
  c: number;
}

export interface Selection {
  ranges: Rect[];
  active: Pos;
  anchor: Pos;
}

export interface PointState {
  /** Text span of the reference being pointed at. */
  start: number;
  end: number;
  anchor: Pos;
  head: Pos;
}

export interface EditState {
  sheetId: string;
  r: number;
  c: number;
  text: string;
  caret: number;
  /** 'enter' (typed over the cell: arrows commit / point) or 'edit' (F2 / double-click: arrows move the caret). */
  mode: 'enter' | 'edit';
  origin: 'cell' | 'bar';
  error?: string;
  point: PointState | null;
  /** The input before editing (for Esc). */
  original: string;
}

export interface FindState {
  open: boolean;
  replace: boolean;
  query: string;
  replacement: string;
  matchCase: boolean;
  wholeCell: boolean;
  inFormulas: boolean;
  results: { sheetId: string; row: number; col: number }[];
  index: number;
  busy: boolean;
}

export interface Viewport {
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
}

export interface Layout {
  headerW: number;
  headerH: number;
  frozenW: number;
  frozenH: number;
  fr: number;
  fc: number;
}

export type PaintLayer = 'base' | 'overlay';

const tileKey = (tr: number, tc: number) => `${tr}:${tc}`;
export const posEq = (a: Pos | null | undefined, b: Pos | null | undefined) => !!a && !!b && a.r === b.r && a.c === b.c;

export class GridController {
  readonly workbookId: string;
  sheets: SheetMeta[] = [];
  styles: Record<number, CellStyle> = {};
  names: { name: string; ref: string }[] = [];
  sheetId = '';
  loaded = false;
  loadError: string | null = null;
  rows = new Axis(DEFAULT_ROW_H, 1000);
  cols = new Axis(DEFAULT_COL_W, MIN_COLS);
  merges = new Map<string, Rect>();
  cf: CondFormatRule[] = [];
  sel: Selection = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
  edit: EditState | null = null;
  marquee: { sheetId: string; rect: Rect; cut: boolean } | null = null;
  find: FindState = { open: false, replace: false, query: '', replacement: '', matchCase: false, wholeCell: false, inFormulas: false, results: [], index: -1, busy: false };
  fillPreview: Rect | null = null;
  /** Live column / row resize guide (content px). */
  resizeGuide: { axis: 'rows' | 'cols'; index: number; size: number } | null = null;
  /** Input of the active cell (formula bar). */
  activeInput = '';
  activeInfo: { error?: string; spillOf?: string; spill?: Rect | null } = {};
  /** For spill children: the anchor's formula, shown dimmed in the formula bar. */
  activeGhost = '';
  vp: Viewport = { scrollLeft: 0, scrollTop: 0, width: 800, height: 600 };
  version = 0;
  /** Bumps whenever cell data changes (status bar, toolbar). */
  dataVersion = 0;
  /** Set by the view: scroll so a content rect is visible. */
  scrollIntoView: ((r: number, c: number) => void) | null = null;
  /** Set by the view: focus the cell editor (keyboard target). */
  focusGrid: (() => void) | null = null;
  /** Set by the renderer: called after a single-cell commit is written (S15 committed results roll). */
  onCommitted: ((r: number, c: number, before: string, sheetId: string) => void) | null = null;

  private tiles = new Map<string, Tile>();
  private listeners = new Set<() => void>();
  private painters = new Set<(layer: PaintLayer) => void>();
  private emitQueued = false;
  private paintQueued = new Set<PaintLayer>();
  private paintRaf = 0;
  private reqSeq = 0;
  private fetchQueued = false;
  private stylesFetching = false;
  private infoReq = 0;
  private lastMutation = 0;
  private unlisten: Unlisten | null = null;
  private clip: { sheetId: string; rect: Rect; tsv: string; token: string | null; cut: boolean } | null = null;
  private disposed = false;
  private extentByUse = { r: 0, c: 0 };

  constructor(workbookId: string, initialSheetId?: string) {
    this.workbookId = workbookId;
    if (initialSheetId) this.sheetId = initialSheetId;
  }

  // ───────────────────────────────────────────────────────────── subscriptions

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  onPaint(fn: (layer: PaintLayer) => void): () => void {
    this.painters.add(fn);
    return () => this.painters.delete(fn);
  }

  /** Notify React (batched). */
  emit(): void {
    this.version++;
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      for (const fn of this.listeners) fn();
    });
  }

  /** Request a repaint of one or both canvas layers on the next frame. */
  paint(layer: PaintLayer | 'all' = 'all'): void {
    if (layer === 'all') {
      this.paintQueued.add('base');
      this.paintQueued.add('overlay');
    } else this.paintQueued.add(layer);
    if (this.paintRaf || typeof requestAnimationFrame === 'undefined') return;
    this.paintRaf = requestAnimationFrame(() => {
      this.paintRaf = 0;
      const layers = [...this.paintQueued];
      this.paintQueued.clear();
      for (const l of layers) for (const fn of this.painters) fn(l);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    if (this.paintRaf) cancelAnimationFrame(this.paintRaf);
    this.paintRaf = 0;
  }

  // ───────────────────────────────────────────────────────────── loading

  async load(): Promise<void> {
    this.disposed = false;
    try {
      const wb = await api.sheet.workbookGet({ id: this.workbookId });
      if (this.disposed) return;
      this.sheets = wb.sheets;
      this.styles = wb.styles;
      this.names = wb.namedRanges;
      const visible = wb.sheets.filter((s) => !s.hidden);
      const pick = wb.sheets.find((s) => s.id === this.sheetId) ?? visible[0] ?? wb.sheets[0];
      if (!pick) throw new Error('This workbook has no sheets');
      await this.activate(pick.id, false);
      this.loaded = true;
      this.unlisten?.();
      this.unlisten = listen('sheet:changed', (e) => {
        if (e.workbookId !== this.workbookId) return;
        // Our own edits reconcile from their responses.
        if (performance.now() - this.lastMutation < 600) return;
        if (e.sheetId === this.sheetId) {
          for (const r of e.rects) this.invalidate(r);
          void this.refreshMeta();
        }
      });
      this.emit();
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : 'This workbook couldn’t be opened';
      this.emit();
    }
  }

  get sheet(): SheetMeta | undefined {
    return this.sheets.find((s) => s.id === this.sheetId);
  }

  get frozen(): { rows: number; cols: number } {
    return this.sheet?.frozen ?? { rows: 0, cols: 0 };
  }

  private async activate(sheetId: string, keepSel: boolean): Promise<void> {
    this.sheetId = sheetId;
    this.tiles.clear();
    this.merges.clear();
    this.rows = new Axis(DEFAULT_ROW_H, MIN_ROWS);
    this.cols = new Axis(DEFAULT_COL_W, MIN_COLS);
    this.marquee = this.marquee?.sheetId === sheetId ? this.marquee : null;
    if (!keepSel) this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
    this.updateCounts();
    // Sizes for the whole sheet: one thin strip per axis.
    const [colStrip, rowStrip] = await Promise.all([
      api.sheet.getRange({ sheetId, rect: { r0: 0, c0: 0, r1: 0, c1: MAX_COLS - 1 } }),
      api.sheet.getRange({ sheetId, rect: { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: 0 } }),
    ]);
    if (this.sheetId !== sheetId || this.disposed) return;
    this.cols.setMany(colStrip.colWidths);
    this.rows.setMany(rowStrip.rowHeights);
    this.cf = (colStrip as typeof colStrip & { rules?: CondFormatRule[] }).rules ?? [];
    this.updateCounts();
    this.ensureTiles();
    void this.refreshActive();
    this.paint();
    this.emit();
  }

  async setSheet(id: string): Promise<void> {
    if (id === this.sheetId || !this.sheets.some((s) => s.id === id)) return;
    // While pointing in a formula, other sheets can be browsed for references (Excel); otherwise commit first.
    if (this.edit && !this.canPoint()) await this.commitEdit(null);
    await this.activate(id, false);
  }

  async refreshMeta(): Promise<void> {
    try {
      const wb = await api.sheet.workbookGet({ id: this.workbookId });
      this.sheets = wb.sheets;
      this.styles = wb.styles;
      this.names = wb.namedRanges;
      if (!this.sheets.some((s) => s.id === this.sheetId)) {
        const next = this.sheets.find((s) => !s.hidden) ?? this.sheets[0];
        if (next) await this.activate(next.id, false);
      }
      this.updateCounts();
      this.paint();
      this.emit();
    } catch {
      /* keep the last known meta */
    }
  }

  private async refreshStyles(): Promise<void> {
    if (this.stylesFetching) return;
    this.stylesFetching = true;
    try {
      const wb = await api.sheet.workbookGet({ id: this.workbookId });
      this.styles = wb.styles;
      this.paint('base');
      this.emit();
    } finally {
      this.stylesFetching = false;
    }
  }

  updateCounts(): void {
    const meta = this.sheet;
    const maxR = Math.max(meta?.maxRow ?? 0, this.extentByUse.r, this.sel.active.r);
    const maxC = Math.max(meta?.maxCol ?? 0, this.extentByUse.c, this.sel.active.c);
    this.rows.count = Math.min(MAX_ROWS, Math.max(this.rows.count, MIN_ROWS, maxR + 100));
    this.cols.count = Math.min(MAX_COLS, Math.max(this.cols.count, MIN_COLS, maxC + 6));
  }

  /** Grows the grid as the user scrolls towards its end (an "infinite" sheet). */
  growIfNeeded(): boolean {
    const l = this.layout();
    let grew = false;
    const bottom = this.vp.scrollTop + this.vp.height - l.headerH;
    if (this.rows.total() - bottom < 600 && this.rows.count < MAX_ROWS) {
      this.rows.count = Math.min(MAX_ROWS, this.rows.count + 500);
      grew = true;
    }
    const right = this.vp.scrollLeft + this.vp.width - l.headerW;
    if (this.cols.total() - right < 400 && this.cols.count < MAX_COLS) {
      this.cols.count = Math.min(MAX_COLS, this.cols.count + 13);
      grew = true;
    }
    if (grew) this.emit();
    return grew;
  }

  // ───────────────────────────────────────────────────────────── geometry

  layout(): Layout {
    const digits = String(Math.min(this.rows.count, MAX_ROWS)).length;
    const headerW = Math.max(40, 14 + digits * 7);
    const { rows: fr, cols: fc } = this.frozen;
    return { headerW, headerH: HEADER_H, frozenW: this.cols.offset(fc), frozenH: this.rows.offset(fr), fr, fc };
  }

  /** Screen x (relative to the grid's top-left) of column c's left edge. */
  colX(c: number, l = this.layout()): number {
    return l.headerW + this.cols.offset(c) - (c >= l.fc ? this.vp.scrollLeft : 0);
  }

  rowY(r: number, l = this.layout()): number {
    return l.headerH + this.rows.offset(r) - (r >= l.fr ? this.vp.scrollTop : 0);
  }

  /** Screen rect of a cell range (clipped to nothing; callers clip by pane). */
  rectPx(rect: Rect, l = this.layout()): { x: number; y: number; w: number; h: number } {
    const x0 = this.colX(rect.c0, l);
    const y0 = this.rowY(rect.r0, l);
    // A range that straddles the frozen boundary spans both panes.
    const x1 = rect.c1 >= l.fc && rect.c0 < l.fc ? l.headerW + this.cols.end(rect.c1) - this.vp.scrollLeft : this.colX(rect.c1, l) + this.cols.size(rect.c1);
    const y1 = rect.r1 >= l.fr && rect.r0 < l.fr ? l.headerH + this.rows.end(rect.r1) - this.vp.scrollTop : this.rowY(rect.r1, l) + this.rows.size(rect.r1);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  /** Cell under a screen point (in grid coordinates); null over headers. */
  hit(x: number, y: number): { r: number; c: number; zone: 'cell' | 'colhead' | 'rowhead' | 'corner' } {
    const l = this.layout();
    const cx = x - l.headerW;
    const cy = y - l.headerH;
    const c = cx < 0 ? 0 : cx < l.frozenW ? this.cols.indexAt(cx) : this.cols.indexAt(cx + this.vp.scrollLeft);
    const r = cy < 0 ? 0 : cy < l.frozenH ? this.rows.indexAt(cy) : this.rows.indexAt(cy + this.vp.scrollTop);
    const zone = x < l.headerW && y < l.headerH ? 'corner' : y < l.headerH ? 'colhead' : x < l.headerW ? 'rowhead' : 'cell';
    return { r: Math.max(0, Math.min(r, this.rows.count - 1)), c: Math.max(0, Math.min(c, this.cols.count - 1)), zone };
  }

  /** Visible index ranges for the scrolled pane. */
  visible(): { r0: number; r1: number; c0: number; c1: number } {
    const l = this.layout();
    const top = this.vp.scrollTop + l.frozenH;
    const left = this.vp.scrollLeft + l.frozenW;
    const r0 = Math.max(l.fr, this.rows.indexAt(top));
    const c0 = Math.max(l.fc, this.cols.indexAt(left));
    const r1 = this.rows.indexAt(this.vp.scrollTop + this.vp.height - l.headerH);
    const c1 = this.cols.indexAt(this.vp.scrollLeft + this.vp.width - l.headerW);
    return { r0, r1: Math.max(r0, r1), c0, c1: Math.max(c0, c1) };
  }

  visibleRect(): Rect {
    const v = this.visible();
    return { r0: 0, c0: 0, r1: Math.min(MAX_ROWS - 1, v.r1 + 1), c1: Math.min(MAX_COLS - 1, v.c1 + 1) };
  }

  setViewport(vp: Partial<Viewport>): void {
    const prevTop = this.vp.scrollTop;
    this.vp = { ...this.vp, ...vp };
    this.growIfNeeded();
    this.ensureTiles(this.vp.scrollTop >= prevTop ? 1 : -1);
    this.paint();
  }

  // ───────────────────────────────────────────────────────────── tiles

  private tileFor(r: number, c: number): Tile | undefined {
    return this.tiles.get(tileKey(Math.floor(r / TILE_ROWS), Math.floor(c / TILE_COLS)));
  }

  cell(r: number, c: number): CellData | undefined {
    return this.tileFor(r, c)?.cells.get(cellKey(r, c));
  }

  isLoaded(r: number, c: number): boolean {
    return this.tileFor(r, c)?.state === 'ready';
  }

  style(id: number | undefined): CellStyle {
    return (id && this.styles[id]) || {};
  }

  /** Requests tiles intersecting the visible area (plus the frozen panes and one tile of prefetch). */
  ensureTiles(dir: 1 | -1 = 1): void {
    if (!this.sheetId) return;
    const v = this.visible();
    const l = this.layout();
    const want = new Set<string>();
    const addRange = (r0: number, r1: number, c0: number, c1: number) => {
      for (let tr = Math.floor(r0 / TILE_ROWS); tr <= Math.floor(r1 / TILE_ROWS); tr++)
        for (let tc = Math.floor(c0 / TILE_COLS); tc <= Math.floor(c1 / TILE_COLS); tc++) want.add(tileKey(tr, tc));
    };
    addRange(v.r0, v.r1, v.c0, v.c1);
    if (l.fr) addRange(0, l.fr - 1, v.c0, v.c1);
    if (l.fc) addRange(v.r0, v.r1, 0, l.fc - 1);
    if (l.fr && l.fc) addRange(0, l.fr - 1, 0, l.fc - 1);
    // Prefetch the next tile in the scroll direction.
    const pr = dir > 0 ? v.r1 + TILE_ROWS / 2 : Math.max(0, v.r0 - TILE_ROWS / 2);
    addRange(Math.min(pr, this.rows.count - 1), Math.min(pr, this.rows.count - 1), v.c0, v.c1);
    const now = performance.now();
    let need = false;
    for (const k of want) {
      const t = this.tiles.get(k);
      if (t) {
        t.used = now;
        if (t.stale && t.state === 'ready') need = true;
        continue;
      }
      const [tr, tc] = k.split(':').map(Number);
      this.tiles.set(k, { key: k, tr, tc, cells: new Map(), state: 'loading', stale: true, req: 0, used: now });
      need = true;
    }
    if (need) this.queueFetch(want);
    this.evict(want);
  }

  private evict(keep: Set<string>): void {
    if (this.tiles.size <= TILE_LRU) return;
    const victims = [...this.tiles.values()].filter((t) => !keep.has(t.key)).sort((a, b) => a.used - b.used);
    while (this.tiles.size > TILE_LRU && victims.length) this.tiles.delete(victims.shift()!.key);
  }

  private queueFetch(keys: Set<string>): void {
    if (this.fetchQueued) return;
    this.fetchQueued = true;
    queueMicrotask(() => {
      this.fetchQueued = false;
      for (const k of keys) {
        const t = this.tiles.get(k);
        if (t && t.stale) void this.fetchTile(t);
      }
    });
  }

  private async fetchTile(t: Tile): Promise<void> {
    const req = ++this.reqSeq;
    t.req = req;
    t.stale = false;
    const sheetId = this.sheetId;
    const rect = { r0: t.tr * TILE_ROWS, c0: t.tc * TILE_COLS, r1: t.tr * TILE_ROWS + TILE_ROWS - 1, c1: t.tc * TILE_COLS + TILE_COLS - 1 };
    try {
      const res = await api.sheet.getRange({ sheetId, rect });
      if (sheetId !== this.sheetId || t.req !== req || this.tiles.get(t.key) !== t) return;
      t.cells.clear();
      this.unpack(res.cells, t.cells);
      for (const e of res.cf) {
        const cd = t.cells.get(cellKey(e.r, e.c));
        if (!cd) continue;
        if (e.bar !== undefined) {
          cd.bar = e.bar;
          cd.barStyle = e.styleId;
        } else cd.cf = e.styleId;
      }
      // Merges that touch the tile are authoritative from this response.
      for (const [k, m] of this.merges) if (rectsIntersect(m, rect)) this.merges.delete(k);
      for (const m of res.merges) this.merges.set(`${m.r0}:${m.c0}`, m);
      const rules = (res as typeof res & { rules?: CondFormatRule[] }).rules;
      if (rules) this.cf = rules;
      t.state = 'ready';
      let unknownStyle = false;
      for (const cd of t.cells.values()) {
        if ((cd.s && !this.styles[cd.s]) || (cd.cf && !this.styles[cd.cf]) || (cd.barStyle && !this.styles[cd.barStyle])) unknownStyle = true;
        if (cd.k) {
          /* noop: used extent tracked by sheet meta */
        }
      }
      if (unknownStyle) void this.refreshStyles();
      this.paint();
      if (t.cells.has(cellKey(this.sel.active.r, this.sel.active.c)) || this.edit) this.emit();
    } catch (e) {
      if (this.tiles.get(t.key) === t) {
        t.stale = true;
        t.state = 'ready';
      }
      console.warn('[sheets] tile fetch failed', e);
    }
  }

  private unpack(p: PackedCells, into: Map<number, CellData>): void {
    for (let i = 0; i < p.r.length; i++) into.set(cellKey(p.r[i], p.c[i]), { d: p.d[i], k: p.k[i], f: p.f[i], s: p.s[i] });
  }

  /** Applies cells returned by a mutation into loaded tiles. */
  private applyChanged(p: PackedCells): void {
    for (let i = 0; i < p.r.length; i++) {
      const t = this.tileFor(p.r[i], p.c[i]);
      if (!t) continue;
      const k = cellKey(p.r[i], p.c[i]);
      if (p.k[i] === 0 && !p.s[i] && p.f[i] === 0) t.cells.delete(k);
      else {
        const prev = t.cells.get(k);
        t.cells.set(k, { d: p.d[i], k: p.k[i], f: p.f[i], s: p.s[i], cf: prev?.cf, bar: prev?.bar, barStyle: prev?.barStyle });
        if (p.s[i] && !this.styles[p.s[i]]) void this.refreshStyles();
      }
      if (p.r[i] > this.extentByUse.r || p.c[i] > this.extentByUse.c) {
        this.extentByUse = { r: Math.max(this.extentByUse.r, p.r[i]), c: Math.max(this.extentByUse.c, p.c[i]) };
      }
    }
  }

  /** Marks tiles intersecting a rect stale and refetches the visible ones. */
  invalidate(rect: Rect): void {
    let any = false;
    for (const t of this.tiles.values()) {
      const tr = { r0: t.tr * TILE_ROWS, c0: t.tc * TILE_COLS, r1: t.tr * TILE_ROWS + TILE_ROWS - 1, c1: t.tc * TILE_COLS + TILE_COLS - 1 };
      if (rectsIntersect(tr, rect)) {
        t.stale = true;
        any = true;
      }
    }
    if (any) this.ensureTiles();
  }

  private invalidateAll(): void {
    for (const t of this.tiles.values()) t.stale = true;
    this.ensureTiles();
  }

  // ───────────────────────────────────────────────────────────── merges & selection

  mergeAt(r: number, c: number): Rect | undefined {
    for (const m of this.merges.values()) if (rectContains(m, r, c)) return m;
    return undefined;
  }

  /** Expands a rect so it never cuts through a merged area. */
  expandMerges(rect: Rect): Rect {
    let out = { ...rect };
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 20) {
      changed = false;
      for (const m of this.merges.values()) {
        if (!rectsIntersect(m, out)) continue;
        const u = { r0: Math.min(out.r0, m.r0), c0: Math.min(out.c0, m.c0), r1: Math.max(out.r1, m.r1), c1: Math.max(out.c1, m.c1) };
        if (u.r0 !== out.r0 || u.c0 !== out.c0 || u.r1 !== out.r1 || u.c1 !== out.c1) {
          out = u;
          changed = true;
        }
      }
    }
    return out;
  }

  get primary(): Rect {
    return this.sel.ranges[this.sel.ranges.length - 1];
  }

  get active(): Pos {
    return this.sel.active;
  }

  private setSel(sel: Selection, opts: { scroll?: boolean } = {}): void {
    this.sel = sel;
    if (this.marquee && !this.edit) {
      /* the marquee stays until Esc, an edit or a paste (Excel) */
    }
    if (opts.scroll !== false) this.scrollIntoView?.(sel.active.r, sel.active.c);
    const grewR = sel.active.r > this.rows.count - 50;
    const grewC = sel.active.c > this.cols.count - 4;
    if (grewR || grewC) this.updateCounts();
    this.paint('overlay');
    void this.refreshActive();
    this.emit();
  }

  /** Click / shift-click / ⌘-click. */
  select(pos: Pos, opts: { extend?: boolean; add?: boolean; scroll?: boolean } = {}): void {
    const p = { r: clamp(pos.r, 0, MAX_ROWS - 1), c: clamp(pos.c, 0, MAX_COLS - 1) };
    if (opts.extend) {
      const rect = this.expandMerges(normRect(this.sel.anchor.r, this.sel.anchor.c, p.r, p.c));
      const ranges = [...this.sel.ranges.slice(0, -1), rect];
      this.setSel({ ranges, active: this.sel.active, anchor: this.sel.anchor }, { scroll: opts.scroll });
      return;
    }
    const m = this.mergeAt(p.r, p.c);
    const rect = m ?? { r0: p.r, c0: p.c, r1: p.r, c1: p.c };
    const active = m ? { r: m.r0, c: m.c0 } : p;
    const ranges = opts.add ? [...this.sel.ranges, rect] : [rect];
    this.setSel({ ranges, active, anchor: active }, { scroll: opts.scroll });
  }

  /** Extend the primary range so its far corner is `head` (drag-select, shift+arrows). */
  extendTo(head: Pos, scroll = true): void {
    const rect = this.expandMerges(normRect(this.sel.anchor.r, this.sel.anchor.c, clamp(head.r, 0, MAX_ROWS - 1), clamp(head.c, 0, MAX_COLS - 1)));
    const ranges = [...this.sel.ranges.slice(0, -1), rect];
    this.sel = { ...this.sel, ranges };
    if (scroll) this.scrollIntoView?.(head.r, head.c);
    this.paint('overlay');
    this.emit();
  }

  selectRect(rect: Rect, active?: Pos): void {
    const a = active ?? { r: rect.r0, c: rect.c0 };
    this.setSel({ ranges: [rect], active: a, anchor: a });
  }

  selectAll(): void {
    this.setSel({ ranges: [{ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 }], active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } }, { scroll: false });
  }

  selectCols(c0: number, c1: number, opts: { add?: boolean; keepActive?: boolean } = {}): void {
    const rect = { r0: 0, r1: MAX_ROWS - 1, c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
    const active = opts.keepActive ? this.sel.active : { r: this.visible().r0, c: c0 };
    this.sel = { ranges: opts.add ? [...this.sel.ranges, rect] : [rect], active: opts.keepActive ? active : { r: 0, c: c0 }, anchor: opts.keepActive ? this.sel.anchor : { r: 0, c: c0 } };
    this.paint('overlay');
    void this.refreshActive();
    this.emit();
  }

  selectRows(r0: number, r1: number, opts: { add?: boolean; keepActive?: boolean } = {}): void {
    const rect = { c0: 0, c1: MAX_COLS - 1, r0: Math.min(r0, r1), r1: Math.max(r0, r1) };
    this.sel = { ranges: opts.add ? [...this.sel.ranges, rect] : [rect], active: opts.keepActive ? this.sel.active : { r: r0, c: 0 }, anchor: opts.keepActive ? this.sel.anchor : { r: r0, c: 0 } };
    this.paint('overlay');
    void this.refreshActive();
    this.emit();
  }

  /** Arrow keys. With `extend`, moves the far corner of the primary range. */
  move(dr: number, dc: number, extend = false): void {
    if (extend) {
      const p = this.primary;
      const a = this.sel.anchor;
      const head = { r: a.r === p.r0 ? p.r1 : p.r0, c: a.c === p.c0 ? p.c1 : p.c0 };
      this.extendTo({ r: clamp(head.r + dr, 0, MAX_ROWS - 1), c: clamp(head.c + dc, 0, MAX_COLS - 1) });
      return;
    }
    const a = this.sel.active;
    const m = this.mergeAt(a.r, a.c);
    let r = a.r + dr;
    let c = a.c + dc;
    if (m) {
      if (dr > 0) r = m.r1 + 1;
      if (dc > 0) c = m.c1 + 1;
    }
    this.select({ r: clamp(r, 0, MAX_ROWS - 1), c: clamp(c, 0, MAX_COLS - 1) });
  }

  /** ⌘ + arrow: jump to the edge of the data region (Excel semantics, using loaded tiles). */
  jump(dr: number, dc: number, extend = false): void {
    const p = this.primary;
    const a = this.sel.anchor;
    const from = extend ? { r: a.r === p.r0 ? p.r1 : p.r0, c: a.c === p.c0 ? p.c1 : p.c0 } : this.sel.active;
    const filled = (r: number, c: number) => {
      const cd = this.cell(r, c);
      return !!cd && cd.k !== 0;
    };
    const maxR = Math.max(this.sheet?.maxRow ?? 0, this.extentByUse.r);
    const maxC = Math.max(this.sheet?.maxCol ?? 0, this.extentByUse.c);
    let r = from.r;
    let c = from.c;
    const step = () => {
      r += dr;
      c += dc;
    };
    const inBounds = () => r >= 0 && c >= 0 && r <= Math.max(maxR, from.r) + 1 && c <= Math.max(maxC, from.c) + 1;
    const startFilled = filled(r, c);
    step();
    if (!inBounds()) {
      r = dr < 0 ? 0 : dr > 0 ? Math.max(maxR, from.r) : from.r;
      c = dc < 0 ? 0 : dc > 0 ? Math.max(maxC, from.c) : from.c;
    } else if (startFilled && filled(r, c)) {
      while (inBounds() && filled(r + dr, c + dc)) step();
    } else {
      while (inBounds() && !filled(r, c)) step();
      if (!inBounds()) {
        r = clamp(r - dr, 0, MAX_ROWS - 1);
        c = clamp(c - dc, 0, MAX_COLS - 1);
      }
    }
    const target = { r: clamp(r, 0, MAX_ROWS - 1), c: clamp(c, 0, MAX_COLS - 1) };
    if (extend) this.extendTo(target);
    else this.select(target);
  }

  /** Enter / Tab inside a multi-cell selection cycle through it; otherwise move one cell. */
  advance(dir: 'down' | 'up' | 'right' | 'left'): void {
    const p = this.primary;
    const multi = p.r1 > p.r0 || p.c1 > p.c0;
    const isFull = p.r1 >= MAX_ROWS - 1 || p.c1 >= MAX_COLS - 1;
    if (!multi || isFull || this.sel.ranges.length > 1) {
      const d = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1] }[dir];
      this.move(d[0], d[1]);
      return;
    }
    let { r, c } = this.sel.active;
    if (dir === 'down' || dir === 'up') {
      r += dir === 'down' ? 1 : -1;
      if (r > p.r1) {
        r = p.r0;
        c = c + 1 > p.c1 ? p.c0 : c + 1;
      } else if (r < p.r0) {
        r = p.r1;
        c = c - 1 < p.c0 ? p.c1 : c - 1;
      }
    } else {
      c += dir === 'right' ? 1 : -1;
      if (c > p.c1) {
        c = p.c0;
        r = r + 1 > p.r1 ? p.r0 : r + 1;
      } else if (c < p.c0) {
        c = p.c1;
        r = r - 1 < p.r0 ? p.r1 : r - 1;
      }
    }
    this.sel = { ...this.sel, active: { r, c } };
    this.scrollIntoView?.(r, c);
    this.paint('overlay');
    void this.refreshActive();
    this.emit();
  }

  pageMove(dir: 1 | -1, extend = false): void {
    const v = this.visible();
    const rows = Math.max(1, v.r1 - v.r0 - 1);
    if (extend) this.move(rows * dir, 0, true);
    else this.select({ r: clamp(this.sel.active.r + rows * dir, 0, MAX_ROWS - 1), c: this.sel.active.c });
  }

  /** Loads the active cell's input (formula bar) and error / spill info. */
  async refreshActive(): Promise<void> {
    const { r, c } = this.sel.active;
    const sheetId = this.sheetId;
    if (!sheetId) return;
    const req = ++this.infoReq;
    try {
      const info = await api.sheet.getCell({ sheetId, row: r, col: c });
      if (req !== this.infoReq) return;
      this.activeInput = info.input;
      this.activeInfo = { error: info.error, spillOf: info.spillOf };
      this.activeGhost = '';
      const anchor = info.spillOf && !info.input ? parseCell(info.spillOf) : null;
      if (anchor) {
        const a = await api.sheet.getCell({ sheetId, row: anchor.r, col: anchor.c });
        if (req !== this.infoReq) return;
        this.activeGhost = a.input;
      }
      this.emit();
      this.paint('overlay');
    } catch {
      /* the formula bar keeps its last value */
    }
  }

  get selectionLabel(): string {
    const p = this.primary;
    if (p.r0 === p.r1 && p.c0 === p.c1) return cellName(this.sel.active.r, this.sel.active.c);
    const m = this.mergeAt(p.r0, p.c0);
    if (m && m.r0 === p.r0 && m.c0 === p.c0 && m.r1 === p.r1 && m.c1 === p.c1) return cellName(p.r0, p.c0);
    return rectName(p);
  }

  // ───────────────────────────────────────────────────────────── editing

  beginEdit(opts: { mode: 'enter' | 'edit'; text?: string; origin?: 'cell' | 'bar' } = { mode: 'edit' }): void {
    if (this.edit) return;
    const { r, c } = this.sel.active;
    const original = this.activeInput;
    const text = opts.text ?? original;
    this.edit = { sheetId: this.sheetId, r, c, text, caret: text.length, mode: opts.mode, origin: opts.origin ?? 'cell', point: null, original };
    this.marquee = null;
    this.scrollIntoView?.(r, c);
    this.paint('overlay');
    this.emit();
  }

  setEditText(text: string, caret: number, opts: { keepPoint?: boolean } = {}): void {
    if (!this.edit) return;
    this.edit = { ...this.edit, text, caret, error: undefined, point: opts.keepPoint ? this.edit.point : null };
    this.paint('overlay');
    this.emit();
  }

  setEditMode(mode: 'enter' | 'edit'): void {
    if (!this.edit || this.edit.mode === mode) return;
    this.edit = { ...this.edit, mode, point: null };
    this.emit();
  }

  setEditOrigin(origin: 'cell' | 'bar'): void {
    if (!this.edit || this.edit.origin === origin) return;
    this.edit = { ...this.edit, origin };
    this.emit();
  }

  cancelEdit(): void {
    if (!this.edit) return;
    this.edit = null;
    this.paint('overlay');
    this.emit();
    this.focusGrid?.();
  }

  /** Is the caret at a spot where pointing at a cell inserts a reference? */
  canPoint(): boolean {
    const e = this.edit;
    if (!e || !e.text.startsWith('=')) return false;
    if (e.point && e.caret === e.point.end) return true;
    const before = e.text.slice(0, e.caret).replace(/\s+$/, '');
    const after = e.text.slice(e.caret).trimStart();
    if (after && !/^[),;+\-*/^&<>=:]/.test(after)) return false;
    return /[=(,;+\-*/^&<>:]$/.test(before);
  }

  /** Point mode: insert / replace a reference to `head` (extending from `anchor` with shift / drag). */
  pointTo(head: Pos, opts: { extend?: boolean; sheetName?: string } = {}): void {
    const e = this.edit;
    if (!e) return;
    const anchor = opts.extend && e.point ? e.point.anchor : head;
    const rect = normRect(anchor.r, anchor.c, head.r, head.c);
    const prefix = e.sheetId !== this.sheetId ? `${quoteName(this.sheet?.name ?? '')}!` : '';
    const ref = prefix + (rect.r0 === rect.r1 && rect.c0 === rect.c1 ? cellName(rect.r0, rect.c0) : rectName(rect));
    const start = e.point && e.caret === e.point.end ? e.point.start : e.caret;
    const end = e.point && e.caret === e.point.end ? e.point.end : e.caret;
    const text = e.text.slice(0, start) + ref + e.text.slice(end);
    this.edit = { ...e, text, caret: start + ref.length, point: { start, end: start + ref.length, anchor, head } };
    this.scrollIntoView?.(head.r, head.c);
    this.paint('overlay');
    this.emit();
  }

  /** Arrow keys in point mode. */
  pointMove(dr: number, dc: number, extend: boolean): void {
    const e = this.edit;
    if (!e) return;
    const from = e.point ? e.point.head : { r: e.r, c: e.c };
    const head = { r: clamp(from.r + dr, 0, MAX_ROWS - 1), c: clamp(from.c + dc, 0, MAX_COLS - 1) };
    this.pointTo(head, { extend });
  }

  /** Commits the edit; `fillSelection` writes the same input into every selected cell (⌘↵). */
  async commitEdit(move: 'down' | 'up' | 'right' | 'left' | null, opts: { fillSelection?: boolean } = {}): Promise<boolean> {
    const e = this.edit;
    if (!e) return true;
    let text = e.text;
    // Auto-close parentheses like Excel does.
    if (text.startsWith('=')) {
      const open = (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
      if (open > 0 && open < 8 && !/"[^"]*$/.test(text)) text += ')'.repeat(open);
      // Excel normalises function names and references to upper case.
      text = tokenize(text)
        .map((t) => (t.t === 'func' || t.t === 'bool' || (t.t === 'ref' && !t.ref?.sheet) ? t.v.toUpperCase() : t.v))
        .join('');
    }
    const sheetId = e.sheetId;
    const edits: { row: number; col: number; input: string | null }[] = [];
    if (opts.fillSelection) {
      for (const rect of this.sel.ranges) {
        const area = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
        if (area > 50_000) continue;
        for (let r = rect.r0; r <= rect.r1; r++)
          for (let c = rect.c0; c <= rect.c1; c++) {
            const dr = r - e.r;
            const dc = c - e.c;
            edits.push({ row: r, col: c, input: text === '' ? null : text.startsWith('=') ? shiftFormula(text, dr, dc) : text });
          }
      }
    } else edits.push({ row: e.r, col: e.c, input: text === '' ? null : text });
    const before = edits.length === 1 && sheetId === this.sheetId ? (this.cell(e.r, e.c)?.d ?? '') : null;
    // Optimistic paint for plain values.
    if (!text.startsWith('=') && sheetId === this.sheetId) {
      for (const ed of edits) {
        const t = this.tileFor(ed.row, ed.col);
        if (!t) continue;
        const prev = t.cells.get(cellKey(ed.row, ed.col));
        if (text === '') {
          if (prev) t.cells.set(cellKey(ed.row, ed.col), { ...prev, d: '', k: 0 });
        } else t.cells.set(cellKey(ed.row, ed.col), { d: text.startsWith("'") ? text.slice(1) : text, k: /^-?[\d.,$%]+$/.test(text) ? 1 : 2, f: 0, s: prev?.s ?? 0, cf: prev?.cf });
      }
    }
    this.edit = null;
    if (sheetId !== this.sheetId) await this.setSheet(sheetId);
    if (move) this.advance(move);
    else this.paint();
    this.emit();
    this.focusGrid?.();
    const ok = await this.writeCells(edits, sheetId);
    if (!ok.ok && ok.error) {
      // Reopen the editor with the text so nothing is lost.
      this.sel = { ranges: [{ r0: e.r, c0: e.c, r1: e.r, c1: e.c }], active: { r: e.r, c: e.c }, anchor: { r: e.r, c: e.c } };
      this.edit = { ...e, text, caret: text.length, error: ok.error, point: null };
      this.scrollIntoView?.(e.r, e.c);
      this.invalidate({ r0: e.r, c0: e.c, r1: e.r, c1: e.c });
      this.paint();
      this.emit();
      return false;
    }
    if (before !== null && ok.ok) this.onCommitted?.(e.r, e.c, before, sheetId);
    return true;
  }

  /** Writes inputs; reconciles tiles. */
  async writeCells(edits: { row: number; col: number; input: string | null }[], sheetId = this.sheetId, undoGroup?: string): Promise<{ ok: boolean; error?: string }> {
    if (!edits.length) return { ok: true };
    this.lastMutation = performance.now();
    try {
      const res = await api.sheet.setCells({ sheetId, edits, visible: this.visibleRect(), undoGroup });
      this.lastMutation = performance.now();
      if (sheetId === this.sheetId) {
        this.applyChanged(res.changed);
        for (const d of res.dirtyRects) if (d.sheetId === this.sheetId) this.invalidate(d.rect);
      }
      this.afterMutation();
      if (res.errors?.length) {
        const first = res.errors[0];
        return { ok: false, error: first.message };
      }
      return { ok: true };
    } catch (e) {
      notify.fromError(e, 'Couldn’t save that cell');
      this.invalidate(boundsOf(edits));
      return { ok: false };
    }
  }

  private afterMutation(): void {
    this.lastMutation = performance.now();
    this.dataVersion++;
    void this.refreshActive();
    void this.refreshMetaQuiet();
    this.paint();
    this.emit();
  }

  private metaTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshMetaQuiet(): Promise<void> {
    if (this.metaTimer) clearTimeout(this.metaTimer);
    return new Promise((resolve) => {
      this.metaTimer = setTimeout(() => {
        this.metaTimer = null;
        void api.sheet
          .workbookGet({ id: this.workbookId })
          .then((wb) => {
            this.sheets = wb.sheets;
            this.styles = wb.styles;
            this.names = wb.namedRanges;
            this.updateCounts();
            this.paint();
            this.emit();
          })
          .catch(() => undefined)
          .finally(resolve);
      }, 120);
    });
  }

  // ───────────────────────────────────────────────────────────── commands

  private async run<T>(label: string, fn: () => Promise<T>, opts: { reload?: 'tiles' | 'all' | 'none' } = {}): Promise<T | undefined> {
    this.lastMutation = performance.now();
    try {
      const out = await fn();
      this.lastMutation = performance.now();
      if (opts.reload === 'all') await this.reloadSheet();
      else if (opts.reload !== 'none') this.invalidateAll();
      this.afterMutation();
      return out;
    } catch (e) {
      notify.fromError(e, `Couldn’t ${label}`);
      return undefined;
    }
  }

  /** Refetches sizes + tiles of the active sheet (structural edits, undo). */
  async reloadSheet(): Promise<void> {
    const id = this.sheetId;
    const keep = this.sel;
    await this.refreshMeta();
    if (this.sheetId !== id) return;
    await this.activate(id, true);
    this.sel = keep;
    this.paint();
  }

  async clear(what: 'all' | 'contents' | 'formats' = 'contents'): Promise<void> {
    const rects = this.sel.ranges;
    // Optimistic: blank loaded cells right away.
    if (what !== 'formats')
      for (const rect of rects)
        for (const t of this.tiles.values())
          for (const [k, cd] of t.cells) {
            const r = Math.floor(k / MAX_COLS);
            const c = k % MAX_COLS;
            if (rectContains(rect, r, c)) t.cells.set(k, { ...cd, d: '', k: 0, f: 0, bar: undefined });
          }
    this.paint('base');
    await this.run('clear the cells', () => api.sheet.clear({ sheetId: this.sheetId, rects, what }), { reload: 'tiles' });
  }

  async applyStyle(patch: Partial<CellStyle>): Promise<void> {
    const rects = this.sel.ranges;
    await this.run('format the cells', async () => {
      const res = await api.sheet.setStyle({ sheetId: this.sheetId, rects, patch });
      this.styles = res.styles;
      this.applyChanged(res.changed);
      return res;
    }, { reload: 'none' });
    for (const r of rects) this.invalidate(r);
  }

  /** The style of the active cell (toolbar state). */
  get activeStyle(): CellStyle {
    const cd = this.cell(this.sel.active.r, this.sel.active.c);
    return this.style(cd?.s);
  }

  get activeCell(): CellData | undefined {
    return this.cell(this.sel.active.r, this.sel.active.c);
  }

  toggleFont(key: 'b' | 'i' | 'u' | 's'): Promise<void> {
    const cur = !!this.activeStyle.font?.[key];
    return this.applyStyle({ font: { [key]: !cur } } as Partial<CellStyle>);
  }

  setNumFmt(code: string | null): Promise<void> {
    return this.applyStyle({ numFmt: (code ?? '') as string });
  }

  adjustDecimals(delta: number): Promise<void> {
    const cur = this.activeStyle.numFmt;
    const d = this.activeCell?.d;
    const sample = d ? Number(d.replace(/[^0-9.\-]/g, '')) : undefined;
    return this.setNumFmt(adjustDecimals(cur, delta, Number.isFinite(sample) ? sample : undefined));
  }

  async merge(merge: boolean): Promise<void> {
    const rect = this.primary;
    await this.run(merge ? 'merge the cells' : 'unmerge the cells', () => api.sheet.merge({ sheetId: this.sheetId, rect, merge }));
    if (merge) this.selectRect(rect);
  }

  async freeze(rows: number, cols: number): Promise<void> {
    const meta = await this.run('freeze panes', () => api.sheet.freeze({ sheetId: this.sheetId, rows, cols }), { reload: 'none' });
    if (meta) {
      this.sheets = this.sheets.map((s) => (s.id === meta.id ? meta : s));
      this.ensureTiles();
      this.paint();
      this.emit();
    }
  }

  async insert(axis: 'rows' | 'cols', where: 'before' | 'after'): Promise<void> {
    const p = this.primary;
    const count = axis === 'rows' ? p.r1 - p.r0 + 1 : p.c1 - p.c0 + 1;
    const at = axis === 'rows' ? (where === 'before' ? p.r0 : p.r1 + 1) : where === 'before' ? p.c0 : p.c1 + 1;
    if (count > 10_000) return;
    await this.run(axis === 'rows' ? 'insert rows' : 'insert columns', () => api.sheet.insert({ sheetId: this.sheetId, axis, at, count }), { reload: 'all' });
  }

  async deleteSpan(axis: 'rows' | 'cols'): Promise<void> {
    const p = this.primary;
    const at = axis === 'rows' ? p.r0 : p.c0;
    const count = axis === 'rows' ? p.r1 - p.r0 + 1 : p.c1 - p.c0 + 1;
    await this.run(axis === 'rows' ? 'delete rows' : 'delete columns', () => api.sheet.deleteSpan({ sheetId: this.sheetId, axis, at, count: Math.min(count, 100_000) }), { reload: 'all' });
  }

  /** Live resize (no IPC) then commit. */
  previewResize(axis: 'rows' | 'cols', index: number, size: number): void {
    this.resizeGuide = { axis, index, size };
    (axis === 'rows' ? this.rows : this.cols).set(index, size);
    this.paint();
  }

  async resize(axis: 'rows' | 'cols', indices: number[], size: number | 'auto'): Promise<void> {
    this.resizeGuide = null;
    if (typeof size === 'number') for (const i of indices) (axis === 'rows' ? this.rows : this.cols).set(i, Math.round(size));
    this.paint();
    this.emit();
    await this.run(axis === 'rows' ? 'resize rows' : 'resize columns', () => api.sheet.resize({ sheetId: this.sheetId, axis, indices, size }), { reload: 'none' });
    if (size === 'auto') {
      const strip = await api.sheet.getRange({ sheetId: this.sheetId, rect: axis === 'cols' ? { r0: 0, c0: 0, r1: 0, c1: MAX_COLS - 1 } : { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: 0 } });
      if (axis === 'cols') this.cols.setMany(strip.colWidths, [0, MAX_COLS - 1]);
      else this.rows.setMany(strip.rowHeights, [0, MAX_ROWS - 1]);
      this.paint();
      this.emit();
    }
  }

  /** Columns / rows fully covered by the selection (for resize-all and header menus). */
  selectedIndices(axis: 'rows' | 'cols'): number[] {
    const out = new Set<number>();
    for (const r of this.sel.ranges) {
      const full = axis === 'cols' ? r.r0 === 0 && r.r1 >= MAX_ROWS - 1 : r.c0 === 0 && r.c1 >= MAX_COLS - 1;
      if (!full) continue;
      const [a, b] = axis === 'cols' ? [r.c0, Math.min(r.c1, this.cols.count - 1)] : [r.r0, Math.min(r.r1, this.rows.count - 1)];
      for (let i = a; i <= b && out.size < 2000; i++) out.add(i);
    }
    return [...out];
  }

  async sort(dir: 'asc' | 'desc'): Promise<void> {
    let rect = this.primary;
    const single = rect.r0 === rect.r1 && rect.c0 === rect.c1;
    const col = this.sel.active.c;
    if (single) {
      // Sort the contiguous data region around the active cell.
      rect = this.currentRegion(this.sel.active);
    }
    const hasHeader = this.looksLikeHeader(rect);
    await this.run('sort', () => api.sheet.sort({ sheetId: this.sheetId, rect, keys: [{ col, dir }], hasHeader }));
  }

  /** The contiguous non-empty block around a cell (Excel's "current region"), from loaded tiles. */
  currentRegion(p: Pos): Rect {
    const filled = (r: number, c: number) => (this.cell(r, c)?.k ?? 0) !== 0;
    let rect = { r0: p.r, c0: p.c, r1: p.r, c1: p.c };
    for (let guard = 0; guard < 6; guard++) {
      let grew = false;
      const tryGrow = (cond: boolean, fn: () => void) => {
        if (cond) {
          fn();
          grew = true;
        }
      };
      const rowHas = (r: number) => r >= 0 && Array.from({ length: rect.c1 - rect.c0 + 3 }, (_, i) => rect.c0 - 1 + i).some((c) => c >= 0 && filled(r, c));
      const colHas = (c: number) => c >= 0 && Array.from({ length: rect.r1 - rect.r0 + 3 }, (_, i) => rect.r0 - 1 + i).some((r) => r >= 0 && filled(r, c));
      while (rowHas(rect.r0 - 1)) tryGrow(true, () => (rect = { ...rect, r0: rect.r0 - 1 }));
      while (rowHas(rect.r1 + 1) && rect.r1 < 100_000) tryGrow(true, () => (rect = { ...rect, r1: rect.r1 + 1 }));
      while (colHas(rect.c0 - 1)) tryGrow(true, () => (rect = { ...rect, c0: rect.c0 - 1 }));
      while (colHas(rect.c1 + 1) && rect.c1 < 1000) tryGrow(true, () => (rect = { ...rect, c1: rect.c1 + 1 }));
      if (!grew) break;
    }
    return rect;
  }

  private looksLikeHeader(rect: Rect): boolean {
    if (rect.r1 <= rect.r0) return false;
    let textTop = 0;
    let numBelow = 0;
    let boldTop = 0;
    for (let c = rect.c0; c <= Math.min(rect.c1, rect.c0 + 20); c++) {
      const top = this.cell(rect.r0, c);
      const below = this.cell(rect.r0 + 1, c);
      if (top?.k === 2) textTop++;
      if (below && below.k === 1) numBelow++;
      if (top && this.style(top.s).font?.b) boldTop++;
    }
    return boldTop > 0 || (textTop > 0 && numBelow > 0);
  }

  async fill(source: Rect, target: Rect, mode: 'series' | 'copy' = 'series'): Promise<void> {
    this.fillPreview = null;
    const res = await this.run('fill', () => api.sheet.fill({ sheetId: this.sheetId, source, target, mode }), { reload: 'none' });
    if (res) {
      this.applyChanged(res.changed);
      this.invalidate(target);
      this.selectRect(target, this.sel.active);
    }
  }

  fillDown(): Promise<void> {
    const p = this.primary;
    if (p.r1 === p.r0) return this.fill({ ...p, r0: Math.max(0, p.r0 - 1), r1: Math.max(0, p.r0 - 1) }, { ...p, r0: Math.max(0, p.r0 - 1) }, 'copy');
    return this.fill({ ...p, r1: p.r0 }, p, 'copy');
  }

  fillRight(): Promise<void> {
    const p = this.primary;
    if (p.c1 === p.c0) return this.fill({ ...p, c0: Math.max(0, p.c0 - 1), c1: Math.max(0, p.c0 - 1) }, { ...p, c0: Math.max(0, p.c0 - 1) }, 'copy');
    return this.fill({ ...p, c1: p.c0 }, p, 'copy');
  }

  // ───────────────────────────────────────────────────────────── clipboard

  /** Synchronous TSV/HTML from loaded tiles (null when the range isn't fully loaded or too large). */
  private clipFromCache(rect: Rect): { tsv: string; html: string } | null {
    const area = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
    if (area > 200_000) return null;
    const rows: string[][] = [];
    const html: string[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row: string[] = [];
      const tds: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        if (!this.isLoaded(r, c)) return null;
        const cd = this.cell(r, c);
        row.push(cd?.d ?? '');
        const st = this.style(cd?.s);
        const css = [st.font?.b ? 'font-weight:bold' : '', st.font?.i ? 'font-style:italic' : '', st.fill ? `background:${st.fill}` : '', cd?.k === 1 ? 'text-align:right' : ''].filter(Boolean).join(';');
        tds.push(`<td${css ? ` style="${css}"` : ''}>${escapeHtml(cd?.d ?? '')}</td>`);
      }
      rows.push(row);
      html.push(`<tr>${tds.join('')}</tr>`);
    }
    return { tsv: toTSV(rows), html: `<meta charset="utf-8"><table>${html.join('')}</table>` };
  }

  /** `copy` / `cut` DOM events on the focused grid. */
  onCopy(e: ClipboardEvent, cut: boolean): void {
    const rect = this.clampRect(this.primary);
    const sheetId = this.sheetId;
    const cached = this.clipFromCache(rect);
    this.clip = { sheetId, rect, tsv: cached?.tsv ?? '', token: null, cut };
    this.marquee = { sheetId, rect, cut };
    if (cached && e.clipboardData) {
      e.clipboardData.setData('text/plain', cached.tsv);
      e.clipboardData.setData('text/html', cached.html);
      e.preventDefault();
    }
    const clip = this.clip;
    void api.sheet
      .copy({ sheetId, rect })
      .then((res) => {
        if (this.clip !== clip) return;
        clip.token = res.clip;
        if (!cached) {
          clip.tsv = res.tsv;
          void navigator.clipboard?.writeText(res.tsv).catch(() => undefined);
        }
      })
      .catch((err) => notify.fromError(err, 'Couldn’t copy'));
    this.paint('overlay');
    this.emit();
  }

  /** `paste` DOM event (or a menu action with explicit text). */
  async pasteText(text: string, html: string | undefined, mode: 'all' | 'values' | 'formats' = 'all'): Promise<void> {
    const at = { row: this.primary.r0, col: this.primary.c0 };
    const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const internal = this.clip && this.clip.token && (norm(text) === norm(this.clip.tsv) || !text) ? this.clip : null;
    const sheetId = this.sheetId;
    this.lastMutation = performance.now();
    try {
      const res = internal
        ? await api.sheet.paste({ sheetId, at, clip: internal.token!, mode, visible: this.visibleRect() })
        : await api.sheet.paste({ sheetId, at, tsv: text, html, mode: mode === 'formats' ? 'all' : mode, visible: this.visibleRect() });
      this.applyChanged(res.changed);
      for (const d of res.dirtyRects) if (d.sheetId === this.sheetId) this.invalidate(d.rect);
      // Select the pasted block.
      const h = internal ? internal.rect.r1 - internal.rect.r0 : Math.max(0, text.replace(/\r?\n$/, '').split(/\r?\n/).length - 1);
      const w = internal ? internal.rect.c1 - internal.rect.c0 : Math.max(0, (text.split(/\r?\n/)[0] ?? '').split('\t').length - 1);
      if (internal?.cut && mode === 'all') {
        // Cut + paste moves: clear the source (outside the destination).
        const src = internal.rect;
        const dst = { r0: at.row, c0: at.col, r1: at.row + h, c1: at.col + w };
        if (!(internal.sheetId === sheetId && rectsIntersect(src, dst) && src.r0 === dst.r0 && src.c0 === dst.c0)) {
          await api.sheet.clear({ sheetId: internal.sheetId, rects: [src], what: 'all' });
          if (internal.sheetId === this.sheetId) this.invalidate(src);
        }
        this.clip = null;
      }
      this.marquee = null;
      this.invalidate({ r0: at.row, c0: at.col, r1: at.row + h, c1: at.col + w });
      this.selectRect({ r0: at.row, c0: at.col, r1: Math.min(MAX_ROWS - 1, at.row + h), c1: Math.min(MAX_COLS - 1, at.col + w) });
      this.afterMutation();
    } catch (e) {
      notify.fromError(e, 'Couldn’t paste');
    }
  }

  clearMarquee(): void {
    if (!this.marquee) return;
    this.marquee = null;
    this.paint('overlay');
    this.emit();
  }

  /** Paste values / formatting from the last EMP copy (context menu). */
  hasInternalClip(): boolean {
    return !!this.clip?.token;
  }

  async pasteSpecial(mode: 'values' | 'formats'): Promise<void> {
    if (!this.clip?.token) return;
    await this.pasteText(this.clip.tsv, undefined, mode);
  }

  private clampRect(rect: Rect): Rect {
    const maxR = Math.max(this.sheet?.maxRow ?? 0, this.extentByUse.r);
    const maxC = Math.max(this.sheet?.maxCol ?? 0, this.extentByUse.c);
    return { r0: rect.r0, c0: rect.c0, r1: rect.r1 >= MAX_ROWS - 1 ? Math.max(rect.r0, maxR) : rect.r1, c1: rect.c1 >= MAX_COLS - 1 ? Math.max(rect.c0, maxC) : rect.c1 };
  }

  // ───────────────────────────────────────────────────────────── undo

  async undo(): Promise<void> {
    await this.undoRedo('undo');
  }

  async redo(): Promise<void> {
    await this.undoRedo('redo');
  }

  private async undoRedo(kind: 'undo' | 'redo'): Promise<void> {
    this.lastMutation = performance.now();
    try {
      const res = kind === 'undo' ? await api.sheet.undo({ workbookId: this.workbookId }) : await api.sheet.redo({ workbookId: this.workbookId });
      this.lastMutation = performance.now();
      if (!res.changedSheets.length) return;
      if (!res.changedSheets.includes(this.sheetId)) await this.setSheet(res.changedSheets[0]);
      await this.reloadSheet();
      this.afterMutation();
    } catch (e) {
      notify.fromError(e, kind === 'undo' ? 'Couldn’t undo' : 'Couldn’t redo');
    }
  }

  // ───────────────────────────────────────────────────────────── conditional formats

  async loadCondFormats(): Promise<CondFormatRule[]> {
    // Rules aren't part of the range payload; the workbook keeps them per sheet. Read them from our cache.
    return this.cf;
  }

  async setCondFormats(rules: CondFormatRule[]): Promise<void> {
    this.cf = rules;
    await this.run('apply conditional formatting', () => api.sheet.condFormatSet({ sheetId: this.sheetId, rules }));
  }

  // ───────────────────────────────────────────────────────────── sheets

  async addSheet(): Promise<void> {
    const meta = await this.run('add a sheet', () => api.sheet.add({ workbookId: this.workbookId, afterId: this.sheetId }), { reload: 'none' });
    if (!meta) return;
    await this.refreshMeta();
    await this.setSheet(meta.id);
    this.focusGrid?.();
  }

  async renameSheet(id: string, name: string): Promise<boolean> {
    const meta = await this.run('rename the sheet', () => api.sheet.update({ id, patch: { name } }), { reload: 'tiles' });
    if (!meta) return false;
    await this.refreshMeta();
    return true;
  }

  async colorSheet(id: string, color: SheetMeta['color'] | null): Promise<void> {
    this.sheets = this.sheets.map((s) => (s.id === id ? { ...s, color: color ?? undefined } : s));
    this.emit();
    await this.run('change the tab colour', () => api.sheet.update({ id, patch: { color } }), { reload: 'none' });
  }

  async hideSheet(id: string, hidden: boolean): Promise<void> {
    await this.run(hidden ? 'hide the sheet' : 'show the sheet', () => api.sheet.update({ id, patch: { hidden } }), { reload: 'none' });
    await this.refreshMeta();
    if (hidden && id === this.sheetId) {
      const next = this.sheets.find((s) => !s.hidden);
      if (next) await this.setSheet(next.id);
    }
    if (!hidden) await this.setSheet(id);
  }

  async removeSheet(id: string): Promise<void> {
    await this.run('delete the sheet', () => api.sheet.remove({ id }), { reload: 'none' });
    await this.refreshMeta();
  }

  async reorderSheet(id: string, beforeId?: string, afterId?: string): Promise<void> {
    // Optimistic order.
    const list = [...this.sheets];
    const from = list.findIndex((s) => s.id === id);
    const item = list.splice(from, 1)[0];
    const to = beforeId ? list.findIndex((s) => s.id === beforeId) : afterId ? list.findIndex((s) => s.id === afterId) + 1 : list.length;
    list.splice(to, 0, item);
    this.sheets = list;
    this.emit();
    await this.run('move the sheet', () => api.sheet.reorder({ id, beforeId, afterId }), { reload: 'none' });
    await this.refreshMeta();
  }

  // ───────────────────────────────────────────────────────────── find

  setFind(patch: Partial<FindState>): void {
    this.find = { ...this.find, ...patch };
    this.paint('overlay');
    this.emit();
  }

  private findReq = 0;
  async runFind(): Promise<void> {
    const f = this.find;
    const req = ++this.findReq;
    if (!f.query) {
      this.setFind({ results: [], index: -1, busy: false });
      return;
    }
    this.setFind({ busy: true });
    try {
      const results = await api.sheet.find({ workbookId: this.workbookId, query: f.query, matchCase: f.matchCase, wholeCell: f.wholeCell, inFormulas: f.inFormulas });
      if (req !== this.findReq) return;
      // Start from the first match at or after the active cell on this sheet.
      const order = this.sheets.map((s) => s.id);
      const a = this.sel.active;
      let index = results.findIndex((m) => order.indexOf(m.sheetId) > order.indexOf(this.sheetId) || (m.sheetId === this.sheetId && (m.row > a.r || (m.row === a.r && m.col >= a.c))));
      if (index < 0) index = results.length ? 0 : -1;
      this.setFind({ results, index, busy: false });
      if (index >= 0) await this.gotoMatch(index);
    } catch (e) {
      this.setFind({ busy: false });
      notify.fromError(e, 'Couldn’t search the workbook');
    }
  }

  async stepFind(dir: 1 | -1): Promise<void> {
    const n = this.find.results.length;
    if (!n) return;
    const index = (((this.find.index + dir) % n) + n) % n;
    this.setFind({ index });
    await this.gotoMatch(index);
  }

  private async gotoMatch(index: number): Promise<void> {
    const m = this.find.results[index];
    if (!m) return;
    if (m.sheetId !== this.sheetId) await this.setSheet(m.sheetId);
    this.select({ r: m.row, c: m.col });
  }

  async replace(all: boolean): Promise<void> {
    const f = this.find;
    if (!f.query) return;
    if (all) {
      const res = await this.run('replace', () => api.sheet.replace({ workbookId: this.workbookId, query: f.query, replacement: f.replacement, matchCase: f.matchCase, wholeCell: f.wholeCell }));
      if (res) notify.success(res.count ? `Replaced ${res.count} ${res.count === 1 ? 'match' : 'matches'}` : 'Nothing to replace');
      await this.runFind();
      return;
    }
    const m = f.results[f.index];
    if (!m) return;
    if (m.sheetId !== this.sheetId) await this.setSheet(m.sheetId);
    const info = await api.sheet.getCell({ sheetId: m.sheetId, row: m.row, col: m.col });
    const re = new RegExp(f.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), f.matchCase ? 'g' : 'gi');
    const next = f.wholeCell ? f.replacement : info.input.replace(re, () => f.replacement);
    await this.writeCells([{ row: m.row, col: m.col, input: next || null }], m.sheetId);
    await this.runFind();
  }

  // ───────────────────────────────────────────────────────────── misc

  /** AutoSum: SUM of the numbers above (or to the left of) the active cell. */
  autoSumFormula(fn = 'SUM'): string {
    const { r, c } = this.sel.active;
    const isNum = (rr: number, cc: number) => this.cell(rr, cc)?.k === 1;
    if (r > 0 && isNum(r - 1, c)) {
      let top = r - 1;
      while (top > 0 && isNum(top - 1, c)) top--;
      return `=${fn}(${cellName(top, c)}:${cellName(r - 1, c)})`;
    }
    if (c > 0 && isNum(r, c - 1)) {
      let left = c - 1;
      while (left > 0 && isNum(r, left - 1)) left--;
      return `=${fn}(${cellName(r, left)}:${cellName(r, c - 1)})`;
    }
    return `=${fn}()`;
  }

  colLabel(c: number): string {
    return colName(c);
  }
}

export function useGridVersion(ctrl: GridController): number {
  return useSyncExternalStore(ctrl.subscribe, ctrl.getVersion, ctrl.getVersion);
}

/**
 * Subscribe to one slice of the controller: the component re-renders only when `select(ctrl)` returns a different
 * value (compare with `Object.is`, so return a primitive — a number or a string key). Use it for chrome that does
 * not depend on every selection move (tabs, header, toolbar, closed popovers) so arrow keys only re-render the
 * parts that actually show the selection.
 */
export function useGridSelector<T extends string | number | boolean | null | undefined>(ctrl: GridController, select: (c: GridController) => T): T {
  const get = () => select(ctrl);
  return useSyncExternalStore(ctrl.subscribe, get, get);
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function boundsOf(edits: { row: number; col: number }[]): Rect {
  let r0 = Infinity;
  let c0 = Infinity;
  let r1 = 0;
  let c1 = 0;
  for (const e of edits) {
    r0 = Math.min(r0, e.row);
    c0 = Math.min(c0, e.col);
    r1 = Math.max(r1, e.row);
    c1 = Math.max(c1, e.col);
  }
  return { r0: r0 === Infinity ? 0 : r0, c0: c0 === Infinity ? 0 : c0, r1, c1 };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quoteName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}
