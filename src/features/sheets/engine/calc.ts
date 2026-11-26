/**
 * Workbook calculation engine (§14.2), the TypeScript stand-in for emp-sheets in the browser mock
 * (CLAUDE.md override 1). Stored records (`SheetData.cells`: input + style per cell) are the source of truth; this
 * class compiles formulas, keeps a bucketed dependency index (256 rows × 32 columns per bucket, whole-column refs in
 * a "big" list), recalculates only the dirty closure of an edit (with change cut-off), handles dynamic-array spill
 * (`#SPILL!` when blocked), detects cycles (`#CIRC!`) and evaluates conditional formats.
 */
import type { BlockColor, CellStyle, CondFormatRule, Rect, SortKey } from '@/backend/types';
import { cellKey, keyCol, keyRow, MAX_COLS, MAX_ROWS, parseRect, rectContains, rectsIntersect, splitSheetRef } from './addr';
import { FUNCTIONS, scalar, type FnCtx, type Thunk } from './functions';
import { formatScalar } from './numfmt';
import { FormulaParseError, parseFormula, walk, type Node } from './parser';
import { shiftFormula } from './refs';
import {
  Arr,
  compare,
  Err,
  ERR,
  isArr,
  isErr,
  parseDateText,
  parseNumberText,
  round15,
  toNum,
  toStr,
  type ErrCode,
  type Scalar,
  type V,
} from './values';
import { ERROR_LITERALS } from './lexer';

// ───────────────────────────────────────────────────────────────────────────── stored shapes

export interface CellRec {
  /** What the user typed (formulas start with '='). Empty for style-only cells. */
  i: string;
  /** Style id (0 / absent = default). */
  s?: number;
}

export interface SheetData {
  id: string;
  workbookId: string;
  name: string;
  color?: BlockColor;
  hidden: boolean;
  frozen: { rows: number; cols: number };
  sortKey: SortKey;
  /** Keyed by `cellKey(r, c)`. */
  cells: Record<string, CellRec>;
  colWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  merges: Rect[];
  cf: CondFormatRule[];
}

export interface WorkbookData {
  id: string;
  styles: Record<number, CellStyle>;
  nextStyleId: number;
  namedRanges: { name: string; ref: string }[];
  calc: { iterative: boolean; date1904: boolean };
}

export interface CalcEnv {
  now(): number;
  rand(): number;
}

interface Dep {
  sheetId: string;
  rect: Rect;
}

class Cell {
  readonly sheet: SheetState;
  readonly r: number;
  readonly c: number;
  readonly key: number;
  input = '';
  style = 0;
  formula = false;
  ast: Node | null = null;
  deps: Dep[] = [];
  buckets: string[] = [];
  big = false;
  volatile = false;
  value: Scalar = null;
  arr: Arr | null = null;
  /** Rect actually spilled into (including the anchor). */
  spill: Rect | null = null;
  /** Rect the result wants to spill into (kept while blocked). */
  want: Rect | null = null;
  constructor(sheet: SheetState, r: number, c: number) {
    this.sheet = sheet;
    this.r = r;
    this.c = c;
    this.key = cellKey(r, c);
  }
}

class SheetState {
  readonly data: SheetData;
  readonly cells = new Map<number, Cell>();
  readonly spillOwner = new Map<number, Cell>();
  readonly anchors = new Set<Cell>();
  extent: { r: number; c: number } | null = null;
  index = 0;
  constructor(data: SheetData) {
    this.data = data;
  }
  get id(): string {
    return this.data.id;
  }
}

export type Changed = Map<string, Set<number>>;

export interface CellView {
  r: number;
  c: number;
  /** Display string. */
  d: string;
  /** 0 empty, 1 num, 2 text, 3 bool, 4 err. */
  k: number;
  /** 1 formula, 2 spill child. */
  f: number;
  s: number;
  value: Scalar;
}

const BR = 256;
const BC = 32;
const BIG_BUCKETS = 64;

const ERR_BY_CODE = new Map<string, Err>(ERROR_LITERALS.map((c) => [c, new Err((c === '#GETTING_DATA' ? '#FETCH' : c) as ErrCode)]));

/** Literal value of a non-formula input. */
export function parseLiteral(input: string): Scalar {
  if (input === '') return null;
  if (input.startsWith("'")) return input.slice(1);
  const up = input.trim().toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  const err = ERR_BY_CODE.get(up);
  if (err) return err;
  const n = parseNumberText(input);
  if (n) return n.n;
  const d = parseDateText(input);
  if (d !== null) return d;
  return input;
}

/** Number format implied by what was typed ("$1,200" → currency, "12%" → percent, "2026-03-01" → date). */
export function autoFormatFor(input: string): string | undefined {
  if (!input || input.startsWith('=') || input.startsWith("'")) return undefined;
  const n = parseNumberText(input);
  if (n) {
    const dec = n.decimals > 0 ? `.${'0'.repeat(Math.min(n.decimals, 4))}` : '';
    if (n.kind === 'currency') return `${n.symbol ?? '$'}#,##0${n.decimals ? '.00' : ''}`;
    if (n.kind === 'percent') return `0${dec}%`;
    if (n.grouped) return `#,##0${dec}`;
    return undefined;
  }
  const t = input.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return 'yyyy-mm-dd';
  if (/^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}/.test(t)) return 'yyyy-mm-dd hh:mm';
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) return 'm/d/yyyy';
  if (/^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}$/.test(t)) return 'd mmm yyyy';
  if (/^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/.test(t)) return 'mmm d, yyyy';
  if (/^\d{1,2}:\d{2}(:\d{2})?\s*[AaPp][Mm]$/.test(t)) return 'h:mm AM/PM';
  if (/^\d{1,2}:\d{2}$/.test(t)) return 'h:mm';
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(t)) return 'h:mm:ss';
  return undefined;
}

export function stableStyleKey(s: CellStyle): string {
  const sortObj = (o: unknown): unknown => {
    if (!o || typeof o !== 'object') return o;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o as Record<string, unknown>).sort()) {
      const v = (o as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = sortObj(v);
    }
    return out;
  };
  return JSON.stringify(sortObj(s));
}

/** Remove empty sub-objects so equal styles intern to the same id. */
export function cleanStyle(s: CellStyle): CellStyle {
  const out: CellStyle = {};
  if (s.font) {
    const f = Object.fromEntries(Object.entries(s.font).filter(([, v]) => v !== undefined && v !== false && v !== null)) as CellStyle['font'];
    if (f && Object.keys(f).length) out.font = f;
  }
  if (s.fill) out.fill = s.fill;
  if (s.align) {
    const a = Object.fromEntries(Object.entries(s.align).filter(([, v]) => v !== undefined && v !== false && v !== null)) as CellStyle['align'];
    if (a && Object.keys(a).length) out.align = a;
  }
  if (s.numFmt && !/^general$/i.test(s.numFmt)) out.numFmt = s.numFmt;
  if (s.border) {
    const b = Object.fromEntries(Object.entries(s.border).filter(([, v]) => v)) as CellStyle['border'];
    if (b && Object.keys(b).length) out.border = b;
  }
  if (s.role) out.role = s.role;
  return out;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a) ?? [255, 255, 255];
  const y = hexToRgb(b) ?? [255, 255, 255];
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export class Calc {
  readonly wb: WorkbookData;
  private env: CalcEnv;
  private sheets = new Map<string, SheetState>();
  private order: SheetState[] = [];
  private index = new Map<string, Set<Cell>>();
  private big = new Set<Cell>();
  private volatiles = new Set<Cell>();
  private dirty = new Set<Cell>();
  private computing = new Set<Cell>();
  private changed: Changed = new Map();
  private spillMoved: Dep[] = [];
  private styleIds = new Map<string, number>();
  private cfStats = new Map<string, { min: number; max: number; mid: number; version: number }>();
  private cfFormula = new Map<string, Node | null>();
  private version = 0;

  constructor(wb: WorkbookData, sheets: SheetData[], env: CalcEnv) {
    this.wb = wb;
    this.env = env;
    for (const [id, st] of Object.entries(wb.styles)) this.styleIds.set(stableStyleKey(st), Number(id));
    this.syncSheets(sheets);
  }

  // ───────────────────────────────────────────────────────────── sheets

  /** Call after sheets are added, removed, renamed or reordered. Rebuilds and recalculates everything. */
  syncSheets(sheets: SheetData[]): void {
    this.sheets.clear();
    this.order = [...sheets].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)).map((d) => new SheetState(d));
    this.order.forEach((s, i) => {
      s.index = i;
      this.sheets.set(s.id, s);
    });
    this.rebuild();
  }

  /** Recompiles every cell from the stored records and recalculates the whole workbook. */
  rebuild(): Changed {
    this.index.clear();
    this.big.clear();
    this.volatiles.clear();
    this.dirty.clear();
    this.cfFormula.clear();
    for (const sh of this.order) {
      sh.cells.clear();
      sh.spillOwner.clear();
      sh.anchors.clear();
      sh.extent = null;
      for (const [k, rec] of Object.entries(sh.data.cells)) {
        const key = Number(k);
        const cell = new Cell(sh, keyRow(key), keyCol(key));
        cell.input = rec.i ?? '';
        cell.style = rec.s ?? 0;
        sh.cells.set(key, cell);
      }
    }
    for (const sh of this.order) for (const cell of sh.cells.values()) this.compile(cell);
    for (const sh of this.order) for (const cell of sh.cells.values()) if (cell.input !== '') this.dirty.add(cell);
    return this.run(false);
  }

  sheet(id: string): SheetData | undefined {
    return this.sheets.get(id)?.data;
  }

  sheetByName(name: string): SheetState | undefined {
    const low = name.toLowerCase();
    return this.order.find((s) => s.data.name.toLowerCase() === low);
  }

  sheetList(): SheetData[] {
    return this.order.map((s) => s.data);
  }

  // ───────────────────────────────────────────────────────────── styles

  style(id: number): CellStyle {
    return this.wb.styles[id] ?? {};
  }

  intern(style: CellStyle): number {
    const clean = cleanStyle(style);
    if (!Object.keys(clean).length) return 0;
    const key = stableStyleKey(clean);
    const hit = this.styleIds.get(key);
    if (hit !== undefined) return hit;
    const id = this.wb.nextStyleId++;
    this.wb.styles[id] = clean;
    this.styleIds.set(key, id);
    return id;
  }

  // ───────────────────────────────────────────────────────────── compile & index

  private compile(cell: Cell): void {
    this.unindex(cell);
    cell.formula = cell.input.length > 1 && cell.input.startsWith('=');
    cell.ast = null;
    cell.deps = [];
    cell.volatile = false;
    if (!cell.formula) return;
    try {
      cell.ast = parseFormula(cell.input);
    } catch {
      cell.ast = { k: 'err', v: '#NAME?' };
      return;
    }
    const deps: Dep[] = [];
    walk(cell.ast, (n) => {
      if (n.k === 'ref') {
        const sh = n.ref.sheet ? this.sheetByName(n.ref.sheet) : cell.sheet;
        if (sh) deps.push({ sheetId: sh.id, rect: n.ref.rect });
      } else if (n.k === 'name') {
        const target = this.resolveName(n.name);
        if (target) deps.push(target);
      } else if (n.k === 'call') {
        const spec = FUNCTIONS.get(n.name);
        if (spec?.volatile) cell.volatile = true;
      }
    });
    cell.deps = deps;
    for (const d of deps) {
      const rows = Math.floor(d.rect.r1 / BR) - Math.floor(d.rect.r0 / BR) + 1;
      const cols = Math.floor(d.rect.c1 / BC) - Math.floor(d.rect.c0 / BC) + 1;
      if (rows * cols > BIG_BUCKETS) {
        cell.big = true;
        this.big.add(cell);
        continue;
      }
      for (let br = Math.floor(d.rect.r0 / BR); br <= Math.floor(d.rect.r1 / BR); br++)
        for (let bc = Math.floor(d.rect.c0 / BC); bc <= Math.floor(d.rect.c1 / BC); bc++) {
          const k = `${d.sheetId}:${br}:${bc}`;
          let set = this.index.get(k);
          if (!set) this.index.set(k, (set = new Set()));
          set.add(cell);
          cell.buckets.push(k);
        }
    }
    if (cell.volatile) this.volatiles.add(cell);
  }

  private unindex(cell: Cell): void {
    for (const k of cell.buckets) this.index.get(k)?.delete(cell);
    cell.buckets = [];
    if (cell.big) this.big.delete(cell);
    cell.big = false;
    this.volatiles.delete(cell);
  }

  resolveName(name: string): Dep | null {
    const nr = this.wb.namedRanges.find((n) => n.name.toLowerCase() === name.toLowerCase());
    if (!nr) return null;
    const { sheet, ref } = splitSheetRef(nr.ref.replace(/^=/, ''));
    const sh = sheet ? this.sheetByName(sheet) : this.order[0];
    const rect = parseRect(ref.replace(/\$/g, ''));
    return sh && rect ? { sheetId: sh.id, rect } : null;
  }

  private dependents(sheetId: string, rect: Rect): Cell[] {
    const out = new Set<Cell>();
    const rows = Math.floor(rect.r1 / BR) - Math.floor(rect.r0 / BR) + 1;
    const cols = Math.floor(rect.c1 / BC) - Math.floor(rect.c0 / BC) + 1;
    const test = (c: Cell) => {
      for (const d of c.deps) if (d.sheetId === sheetId && rectsIntersect(d.rect, rect)) return true;
      return false;
    };
    if (rows * cols <= 256) {
      for (let br = Math.floor(rect.r0 / BR); br <= Math.floor(rect.r1 / BR); br++)
        for (let bc = Math.floor(rect.c0 / BC); bc <= Math.floor(rect.c1 / BC); bc++) {
          const set = this.index.get(`${sheetId}:${br}:${bc}`);
          if (set) for (const c of set) if (!out.has(c) && test(c)) out.add(c);
        }
    } else {
      for (const set of this.index.values()) for (const c of set) if (!out.has(c) && test(c)) out.add(c);
    }
    for (const c of this.big) if (!out.has(c) && test(c)) out.add(c);
    return [...out];
  }

  private markDirtyFrom(seeds: Dep[]): void {
    const queue = [...seeds];
    while (queue.length) {
      const p = queue.pop()!;
      for (const d of this.dependents(p.sheetId, p.rect)) {
        if (this.dirty.has(d)) continue;
        this.dirty.add(d);
        queue.push({ sheetId: d.sheet.id, rect: d.spill ?? d.want ?? { r0: d.r, c0: d.c, r1: d.r, c1: d.c } });
      }
    }
  }

  // ───────────────────────────────────────────────────────────── edits

  /**
   * Sets cell inputs (null clears contents, keeping the style) and recalculates dependents. Returns every position
   * whose display changed.
   */
  setInputs(sheetId: string, edits: { r: number; c: number; input: string | null; style?: number }[]): Changed {
    const sh = this.sheets.get(sheetId);
    if (!sh) return new Map();
    const seeds: Dep[] = [];
    for (const e of edits) {
      const key = cellKey(e.r, e.c);
      let cell = sh.cells.get(key);
      const input = e.input ?? '';
      if (!cell) {
        if (input === '' && e.style === undefined) continue;
        cell = new Cell(sh, e.r, e.c);
        sh.cells.set(key, cell);
      }
      if (e.style !== undefined) cell.style = e.style;
      const prevSpill = cell.spill ?? cell.want;
      cell.input = input;
      this.compile(cell);
      if (cell.input === '') {
        this.clearSpill(cell);
        cell.value = null;
        cell.arr = null;
        if (!cell.style) sh.cells.delete(key);
      } else this.dirty.add(cell);
      this.mark(sh.id, key);
      this.writeRec(sh, cell);
      sh.extent = null;
      seeds.push({ sheetId: sh.id, rect: prevSpill ?? { r0: e.r, c0: e.c, r1: e.r, c1: e.c } });
      // An edit inside (or next to) a spill area re-evaluates its anchor.
      const owner = sh.spillOwner.get(key);
      if (owner && owner !== cell) this.dirty.add(owner);
      for (const a of sh.anchors) if (a !== cell && a.want && rectContains(a.want, e.r, e.c)) this.dirty.add(a);
    }
    this.markDirtyFrom(seeds);
    return this.run(true);
  }

  /** Changes styles only (display may change through number formats). */
  setStyles(sheetId: string, styles: { r: number; c: number; style: number }[]): Changed {
    const sh = this.sheets.get(sheetId);
    if (!sh) return new Map();
    this.changed = new Map();
    for (const e of styles) {
      const key = cellKey(e.r, e.c);
      let cell = sh.cells.get(key);
      if (!cell) {
        if (!e.style) continue;
        cell = new Cell(sh, e.r, e.c);
        sh.cells.set(key, cell);
      }
      cell.style = e.style;
      if (cell.input === '' && !cell.style) sh.cells.delete(key);
      this.writeRec(sh, cell);
      this.mark(sh.id, key);
      if (cell.spill) this.markRect(sh.id, cell.spill);
    }
    const out = this.changed;
    this.changed = new Map();
    this.version++;
    return out;
  }

  private writeRec(sh: SheetState, cell: Cell): void {
    const k = String(cell.key);
    if (cell.input === '' && !cell.style) delete sh.data.cells[k];
    else sh.data.cells[k] = cell.style ? { i: cell.input, s: cell.style } : { i: cell.input };
  }

  private mark(sheetId: string, key: number): void {
    let set = this.changed.get(sheetId);
    if (!set) this.changed.set(sheetId, (set = new Set()));
    set.add(key);
  }

  private markRect(sheetId: string, rect: Rect): void {
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) this.mark(sheetId, cellKey(r, c));
  }

  // ───────────────────────────────────────────────────────────── evaluation

  private run(withVolatile: boolean): Changed {
    if (withVolatile && this.volatiles.size) {
      const seeds: Dep[] = [];
      for (const v of this.volatiles) {
        this.dirty.add(v);
        seeds.push({ sheetId: v.sheet.id, rect: { r0: v.r, c0: v.c, r1: v.r, c1: v.c } });
      }
      this.markDirtyFrom(seeds);
    }
    const sortFn = (a: Cell, b: Cell) => a.sheet.index - b.sheet.index || a.key - b.key;
    let guard = 0;
    while (this.dirty.size && guard++ < 12) {
      const order = [...this.dirty].sort(sortFn);
      for (const c of order) this.ensure(c);
      if (this.spillMoved.length) this.markDirtyFrom(this.spillMoved.splice(0));
    }
    this.dirty.clear();
    this.version++;
    const out = this.changed;
    this.changed = new Map();
    return out;
  }

  private ensure(cell: Cell): void {
    if (!this.dirty.has(cell) || this.computing.has(cell)) return;
    this.computing.add(cell);
    const prev = cell.value;
    const prevArr = cell.arr;
    let result: V;
    try {
      result = cell.formula ? (cell.ast ? this.evalNode(cell.ast, cell.sheet, cell.r, cell.c) : ERR.name) : parseLiteral(cell.input);
    } catch (e) {
      result = e instanceof FormulaParseError ? ERR.name : ERR.calc;
    }
    this.computing.delete(cell);
    this.dirty.delete(cell);
    if (isArr(result) && (result.rows > 1 || result.cols > 1)) this.applySpill(cell, result);
    else {
      this.clearSpill(cell);
      cell.arr = null;
      const s = isArr(result) ? scalar(result) : result;
      cell.value = s === null && cell.formula ? 0 : s;
      if (cell.formula && typeof cell.value === 'number' && !Number.isFinite(cell.value)) cell.value = ERR.num;
    }
    if (!sameScalar(prev, cell.value) || prevArr !== cell.arr) this.mark(cell.sheet.id, cell.key);
  }

  private clearSpill(cell: Cell): void {
    const sh = cell.sheet;
    if (cell.spill) {
      const old = cell.spill;
      for (let r = old.r0; r <= old.r1; r++)
        for (let c = old.c0; c <= old.c1; c++) {
          const k = cellKey(r, c);
          if (sh.spillOwner.get(k) === cell) sh.spillOwner.delete(k);
        }
      this.markRect(sh.id, old);
      this.spillMoved.push({ sheetId: sh.id, rect: old });
      sh.extent = null;
    }
    cell.spill = null;
    cell.want = null;
    sh.anchors.delete(cell);
  }

  private applySpill(cell: Cell, arr: Arr): void {
    const sh = cell.sheet;
    const want: Rect = { r0: cell.r, c0: cell.c, r1: cell.r + arr.rows - 1, c1: cell.c + arr.cols - 1 };
    let blocked = want.r1 >= MAX_ROWS || want.c1 >= MAX_COLS;
    if (!blocked) {
      outer: for (let r = want.r0; r <= want.r1; r++)
        for (let c = want.c0; c <= want.c1; c++) {
          if (r === cell.r && c === cell.c) continue;
          const k = cellKey(r, c);
          const other = sh.cells.get(k);
          if (other && other.input !== '') {
            blocked = true;
            break outer;
          }
          const owner = sh.spillOwner.get(k);
          if (owner && owner !== cell) {
            blocked = true;
            break outer;
          }
        }
    }
    if (!blocked) for (const m of sh.data.merges) if (rectsIntersect(m, want)) blocked = true;
    const old = cell.spill;
    if (blocked) {
      this.clearSpill(cell);
      cell.want = want;
      sh.anchors.add(cell);
      cell.arr = null;
      cell.value = ERR.spill;
      return;
    }
    if (old) {
      for (let r = old.r0; r <= old.r1; r++)
        for (let c = old.c0; c <= old.c1; c++) {
          const k = cellKey(r, c);
          if (!rectContains(want, r, c) && sh.spillOwner.get(k) === cell) sh.spillOwner.delete(k);
        }
      this.markRect(sh.id, old);
    }
    for (let r = want.r0; r <= want.r1; r++) for (let c = want.c0; c <= want.c1; c++) if (r !== cell.r || c !== cell.c) sh.spillOwner.set(cellKey(r, c), cell);
    const moved = !old || old.r1 !== want.r1 || old.c1 !== want.c1;
    cell.spill = want;
    cell.want = want;
    sh.anchors.add(cell);
    cell.arr = arr;
    cell.value = arr.get(0, 0);
    sh.extent = null;
    this.markRect(sh.id, want);
    // Dependents of the spill area need the new values.
    this.spillMoved.push({ sheetId: sh.id, rect: moved && old ? { r0: want.r0, c0: want.c0, r1: Math.max(old.r1, want.r1), c1: Math.max(old.c1, want.c1) } : want });
  }

  private readPos(sh: SheetState, r: number, c: number): Scalar {
    const k = cellKey(r, c);
    const cell = sh.cells.get(k);
    if (cell && cell.input !== '') {
      if (this.computing.has(cell)) return ERR.circ;
      if (this.dirty.has(cell)) this.ensure(cell);
      return cell.value;
    }
    let owner = sh.spillOwner.get(k);
    if (owner) {
      if (this.computing.has(owner)) return ERR.circ;
      if (this.dirty.has(owner)) this.ensure(owner);
      owner = sh.spillOwner.get(k);
      if (owner?.arr) return owner.arr.get(r - owner.r, c - owner.c);
    }
    return null;
  }

  extent(sheetId: string): { r: number; c: number } {
    const sh = this.sheets.get(sheetId);
    return sh ? this.extentOf(sh) : { r: -1, c: -1 };
  }

  private extentOf(sh: SheetState): { r: number; c: number } {
    if (sh.extent) return sh.extent;
    let r = -1;
    let c = -1;
    for (const cell of sh.cells.values()) {
      if (cell.input === '') continue;
      if (cell.r > r) r = cell.r;
      if (cell.c > c) c = cell.c;
      if (cell.spill) {
        if (cell.spill.r1 > r) r = cell.spill.r1;
        if (cell.spill.c1 > c) c = cell.spill.c1;
      }
    }
    sh.extent = { r, c };
    return sh.extent;
  }

  private readRect(sh: SheetState, rect: Rect): Arr {
    let { r1, c1 } = rect;
    if (r1 >= MAX_ROWS - 1 || c1 >= MAX_COLS - 1) {
      const ext = this.extentOf(sh);
      if (r1 >= MAX_ROWS - 1) r1 = Math.max(rect.r0, ext.r);
      if (c1 >= MAX_COLS - 1) c1 = Math.max(rect.c0, ext.c);
    }
    const rows = r1 - rect.r0 + 1;
    const cols = c1 - rect.c0 + 1;
    const area = rows * cols;
    if (area > 5_000_000) {
      const a = new Arr(1, 1, [ERR.num]);
      return a;
    }
    const v = new Array<Scalar>(area).fill(null);
    if (area > 4096 && sh.cells.size * 2 < area) {
      for (const cell of sh.cells.values()) {
        if (cell.input === '' || cell.r < rect.r0 || cell.r > r1 || cell.c < rect.c0 || cell.c > c1) continue;
        v[(cell.r - rect.r0) * cols + (cell.c - rect.c0)] = this.readPos(sh, cell.r, cell.c);
      }
      for (const [k] of sh.spillOwner) {
        const r = keyRow(k);
        const c = keyCol(k);
        if (r < rect.r0 || r > r1 || c < rect.c0 || c > c1) continue;
        v[(r - rect.r0) * cols + (c - rect.c0)] = this.readPos(sh, r, c);
      }
    } else {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) v[r * cols + c] = this.readPos(sh, rect.r0 + r, rect.c0 + c);
    }
    const arr = new Arr(rows, cols, v);
    arr.origin = { sheetId: sh.id, rect: { r0: rect.r0, c0: rect.c0, r1, c1 } };
    return arr;
  }

  private fnCtx(sh: SheetState, r: number, c: number): FnCtx {
    return {
      row: r,
      col: c,
      sheetId: sh.id,
      nowMs: () => this.env.now(),
      rand: () => this.env.rand(),
      resolve: (sheetId, rect) => {
        const target = this.sheets.get(sheetId);
        return target ? this.readRect(target, rect) : ERR.ref;
      },
      resolveText: (text) => {
        const { sheet, ref } = splitSheetRef(text);
        const target = sheet ? this.sheetByName(sheet) : sh;
        const rect = parseRect(ref);
        if (target && rect) return this.readRect(target, rect);
        const named = this.resolveName(text);
        const t2 = named ? this.sheets.get(named.sheetId) : undefined;
        return named && t2 ? this.readRect(t2, named.rect) : ERR.ref;
      },
    };
  }

  evalNode(node: Node, sh: SheetState, r: number, c: number): V {
    switch (node.k) {
      case 'num':
        return node.v;
      case 'str':
        return node.v;
      case 'bool':
        return node.v;
      case 'err':
        return ERR_BY_CODE.get(node.v) ?? ERR.value;
      case 'missing':
        return null;
      case 'ref': {
        const target = node.ref.sheet ? this.sheetByName(node.ref.sheet) : sh;
        if (!target) return ERR.ref;
        return this.readRect(target, node.ref.rect);
      }
      case 'name': {
        const d = this.resolveName(node.name);
        if (!d) return ERR.name;
        const target = this.sheets.get(d.sheetId);
        return target ? this.readRect(target, d.rect) : ERR.ref;
      }
      case 'arr': {
        const rows = node.rows.map((row) => row.map((n) => scalar(this.evalNode(n, sh, r, c))));
        return Arr.of(rows);
      }
      case 'un': {
        const v = this.evalNode(node.a, sh, r, c);
        if (node.op === '+') return v;
        return unary(v, (x) => {
          const n = toNum(x);
          return isErr(n) ? n : -n;
        });
      }
      case 'pct': {
        const v = this.evalNode(node.a, sh, r, c);
        return unary(v, (x) => {
          const n = toNum(x);
          return isErr(n) ? n : n / 100;
        });
      }
      case 'bin': {
        const a = this.evalNode(node.a, sh, r, c);
        const b = this.evalNode(node.b, sh, r, c);
        return binary(node.op, a, b);
      }
      case 'call': {
        const spec = FUNCTIONS.get(node.name);
        if (!spec) return ERR.name;
        if (node.args.length < spec.min || node.args.length > spec.max) return ERR.value;
        const cx = this.fnCtx(sh, r, c);
        if (spec.lazy && spec.lazyFn) {
          const thunks: Thunk[] = node.args.map((a) => () => (a.k === 'missing' ? null : this.evalNode(a, sh, r, c)));
          return spec.lazyFn(thunks, cx);
        }
        const args = node.args.map((a) => (a.k === 'missing' ? (undefined as unknown as V) : this.evalNode(a, sh, r, c)));
        return spec.fn(args, cx);
      }
      default:
        return ERR.value;
    }
  }

  /** Evaluates a formula in the context of a sheet (or with no workbook at all). Throws FormulaParseError. */
  evalFormula(sheetId: string | null, formula: string, at?: { r: number; c: number }): V {
    const ast = parseFormula(formula.startsWith('=') ? formula : `=${formula}`);
    const sh = (sheetId ? this.sheets.get(sheetId) : undefined) ?? this.order[0] ?? new SheetState(emptySheetData());
    return this.evalNode(ast, sh, at?.r ?? 0, at?.c ?? 0);
  }

  // ───────────────────────────────────────────────────────────── reading

  private view(sh: SheetState, r: number, c: number, cell: Cell | undefined): CellView | null {
    const k = cellKey(r, c);
    if (cell && cell.input !== '') {
      if (this.dirty.has(cell)) this.ensure(cell);
      const st = this.style(cell.style);
      const fmt = formatScalar(cell.value, st.numFmt);
      return { r, c, d: fmt.text, k: kindOf(cell.value), f: cell.formula ? 1 : 0, s: cell.style, value: cell.value };
    }
    const owner = sh.spillOwner.get(k);
    if (owner?.arr) {
      const v = owner.arr.get(r - owner.r, c - owner.c);
      const sid = cell?.style || owner.style;
      return { r, c, d: formatScalar(v, this.style(sid).numFmt).text, k: kindOf(v), f: 2, s: sid, value: v };
    }
    if (cell && cell.style) return { r, c, d: '', k: 0, f: 0, s: cell.style, value: null };
    return null;
  }

  cellView(sheetId: string, r: number, c: number): CellView | null {
    const sh = this.sheets.get(sheetId);
    if (!sh) return null;
    return this.view(sh, r, c, sh.cells.get(cellKey(r, c)));
  }

  /** Non-empty (or styled) cells in a rect, row-major. */
  cellsIn(sheetId: string, rect: Rect): CellView[] {
    const sh = this.sheets.get(sheetId);
    if (!sh) return [];
    const out: CellView[] = [];
    const area = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
    if (area > sh.cells.size + sh.spillOwner.size) {
      const keys = new Set<number>();
      for (const cell of sh.cells.values()) if (rectContains(rect, cell.r, cell.c)) keys.add(cell.key);
      for (const k of sh.spillOwner.keys()) if (rectContains(rect, keyRow(k), keyCol(k))) keys.add(k);
      for (const k of [...keys].sort((a, b) => a - b)) {
        const v = this.view(sh, keyRow(k), keyCol(k), sh.cells.get(k));
        if (v) out.push(v);
      }
      return out;
    }
    for (let r = rect.r0; r <= rect.r1; r++)
      for (let c = rect.c0; c <= rect.c1; c++) {
        const k = cellKey(r, c);
        const cell = sh.cells.get(k);
        if (!cell && !sh.spillOwner.has(k)) continue;
        const v = this.view(sh, r, c, cell);
        if (v) out.push(v);
      }
    return out;
  }

  value(sheetId: string, r: number, c: number): Scalar {
    const sh = this.sheets.get(sheetId);
    return sh ? this.readPos(sh, r, c) : null;
  }

  input(sheetId: string, r: number, c: number): string {
    return this.sheets.get(sheetId)?.cells.get(cellKey(r, c))?.input ?? '';
  }

  styleAt(sheetId: string, r: number, c: number): number {
    return this.sheets.get(sheetId)?.cells.get(cellKey(r, c))?.style ?? 0;
  }

  spillInfo(sheetId: string, r: number, c: number): { anchor: { r: number; c: number }; rect: Rect } | null {
    const sh = this.sheets.get(sheetId);
    if (!sh) return null;
    const k = cellKey(r, c);
    const cell = sh.cells.get(k);
    const owner = cell?.spill ? cell : sh.spillOwner.get(k);
    return owner?.spill ? { anchor: { r: owner.r, c: owner.c }, rect: owner.spill } : null;
  }

  precedents(sheetId: string, r: number, c: number): Dep[] {
    return this.sheets.get(sheetId)?.cells.get(cellKey(r, c))?.deps ?? [];
  }

  /** Every formula cell (lint). */
  *formulaCells(): Generator<{ sheetId: string; r: number; c: number; input: string; value: Scalar }> {
    for (const sh of this.order)
      for (const cell of sh.cells.values()) if (cell.formula) yield { sheetId: sh.id, r: cell.r, c: cell.c, input: cell.input, value: cell.value };
  }

  /** All stored cells of a sheet with input. */
  *inputs(sheetId: string): Generator<{ r: number; c: number; input: string; style: number }> {
    const sh = this.sheets.get(sheetId);
    if (!sh) return;
    for (const cell of sh.cells.values()) yield { r: cell.r, c: cell.c, input: cell.input, style: cell.style };
  }

  // ───────────────────────────────────────────────────────────── conditional formats

  /** Conditional-format hits for cells in a rect: style overlays and data-bar lengths (0..1). */
  condFormats(sheetId: string, rect: Rect): { r: number; c: number; styleId: number; bar?: number }[] {
    const sh = this.sheets.get(sheetId);
    if (!sh || !sh.data.cf.length) return [];
    const out: { r: number; c: number; styleId: number; bar?: number }[] = [];
    // Per cell: a colour-scale fill and the first matching highlight rule combine into one overlay style.
    const scaleFill = new Map<number, string>();
    const ruleStyle = new Map<number, number>();
    const styled = new Set<number>();
    sh.data.cf.forEach((rule, idx) => {
      const area = rect && rectsIntersect(rule.rect, rect) ? intersect(rule.rect, rect) : null;
      if (!area) return;
      const ruleId = rule.id ?? `${idx}`;
      if (rule.kind === 'color_scale' || rule.kind === 'data_bar') {
        const stats = this.statsFor(sh, rule, ruleId);
        if (!stats) return;
        const colors = rule.colors?.length ? rule.colors : rule.kind === 'data_bar' ? ['#5E5CE6'] : ['#F8696B', '#FFEB84', '#63BE7B'];
        const barStyle = rule.kind === 'data_bar' ? this.intern({ fill: colors[0] }) : 0;
        for (const v of this.cellsIn(sheetId, area)) {
          if (typeof v.value !== 'number') continue;
          if (rule.kind === 'data_bar') {
            const lo = Math.min(0, stats.min);
            const hi = Math.max(0, stats.max);
            const bar = hi === lo ? 0 : Math.max(0, Math.min(1, (v.value - lo) / (hi - lo)));
            out.push({ r: v.r, c: v.c, styleId: barStyle, bar: Math.round(bar * 1000) / 1000 });
          } else {
            const key = cellKey(v.r, v.c);
            if (scaleFill.has(key)) continue;
            const span = stats.max - stats.min;
            let t = span === 0 ? 0.5 : (v.value - stats.min) / span;
            t = Math.round(Math.max(0, Math.min(1, t)) * 24) / 24;
            let color: string;
            if (colors.length >= 3) {
              const midT = span === 0 ? 0.5 : (stats.mid - stats.min) / span;
              color = t <= midT ? mix(colors[0], colors[1], midT === 0 ? 1 : t / midT) : mix(colors[1], colors[2], midT === 1 ? 1 : (t - midT) / (1 - midT));
            } else color = mix(colors[0], colors[1] ?? colors[0], t);
            scaleFill.set(key, color);
          }
        }
        return;
      }
      if (rule.styleId === undefined) return;
      for (let r = area.r0; r <= area.r1; r++)
        for (let c = area.c0; c <= area.c1; c++) {
          const key = cellKey(r, c);
          if (styled.has(key)) continue;
          const val = this.readPos(sh, r, c);
          let hit = false;
          if (rule.kind === 'cell') hit = cellRuleHit(rule, val);
          else if (rule.kind === 'formula' && rule.formula) {
            const dr = r - rule.rect.r0;
            const dc = c - rule.rect.c0;
            const ck = `${ruleId}|${rule.formula}|${dr}|${dc}`;
            let ast = this.cfFormula.get(ck);
            if (ast === undefined) {
              try {
                ast = parseFormula(shiftFormula(rule.formula.startsWith('=') ? rule.formula : `=${rule.formula}`, dr, dc));
              } catch {
                ast = null;
              }
              if (this.cfFormula.size > 20_000) this.cfFormula.clear();
              this.cfFormula.set(ck, ast);
            }
            if (ast) {
              const res = scalar(this.evalNode(ast, sh, r, c));
              hit = res === true || (typeof res === 'number' && res !== 0);
            }
          }
          if (hit) {
            ruleStyle.set(key, rule.styleId!);
            styled.add(key);
          }
        }
    });
    for (const key of new Set([...scaleFill.keys(), ...ruleStyle.keys()])) {
      const r = keyRow(key);
      const c = keyCol(key);
      const fill = scaleFill.get(key);
      const sid = ruleStyle.get(key);
      if (sid !== undefined && !fill) out.push({ r, c, styleId: sid });
      else if (fill && sid === undefined) out.push({ r, c, styleId: this.intern({ fill }) });
      else if (fill && sid !== undefined) {
        const st = this.style(sid);
        out.push({ r, c, styleId: this.intern({ ...st, fill: st.fill ?? fill }) });
      }
    }
    return out;
  }

  private statsFor(sh: SheetState, rule: CondFormatRule, ruleId: string): { min: number; max: number; mid: number } | null {
    const key = `${sh.id}|${ruleId}|${rule.rect.r0},${rule.rect.c0},${rule.rect.r1},${rule.rect.c1}`;
    const hit = this.cfStats.get(key);
    if (hit && hit.version === this.version) return hit;
    const nums: number[] = [];
    for (const v of this.cellsIn(sh.id, rule.rect)) if (typeof v.value === 'number') nums.push(v.value);
    if (!nums.length) return null;
    nums.sort((a, b) => a - b);
    const mid = nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
    const stats = { min: nums[0], max: nums[nums.length - 1], mid, version: this.version };
    this.cfStats.set(key, stats);
    return stats;
  }
}

function intersect(a: Rect, b: Rect): Rect {
  return { r0: Math.max(a.r0, b.r0), c0: Math.max(a.c0, b.c0), r1: Math.min(a.r1, b.r1), c1: Math.min(a.c1, b.c1) };
}

function cellRuleHit(rule: CondFormatRule, v: Scalar): boolean {
  const vals = rule.values ?? [];
  if (rule.op === 'text_contains') {
    const s = toStr(v);
    return !isErr(s) && !!vals[0] && s.toLowerCase().includes(vals[0].toLowerCase());
  }
  if (v === null) return false;
  const lit = (s: string | undefined): Scalar => (s === undefined ? null : parseLiteral(s));
  const a = lit(vals[0]);
  const b = lit(vals[1]);
  switch (rule.op) {
    case 'gt': return compare(v, a) > 0;
    case 'lt': return compare(v, a) < 0;
    case 'eq': return compare(v, a) === 0;
    case 'between': return compare(v, a) >= 0 && compare(v, b) <= 0;
    default: return false;
  }
}

function kindOf(v: Scalar): number {
  if (v === null) return 0;
  if (typeof v === 'number') return 1;
  if (typeof v === 'string') return 2;
  if (typeof v === 'boolean') return 3;
  return 4;
}

function sameScalar(a: Scalar, b: Scalar): boolean {
  if (a === b) return true;
  if (isErr(a) && isErr(b)) return a.code === b.code;
  return false;
}

function unary(v: V, f: (x: Scalar) => Scalar): V {
  if (isArr(v) && (v.rows > 1 || v.cols > 1)) return v.map(f);
  return f(scalar(v));
}

function arith(op: string, x: Scalar, y: Scalar): Scalar {
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  if (op === '&') {
    const a = toStr(x);
    const b = toStr(y);
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    return a + b;
  }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    const c = compare(x, y);
    switch (op) {
      case '=': return c === 0;
      case '<>': return c !== 0;
      case '<': return c < 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      default: return c >= 0;
    }
  }
  const a = toNum(x);
  const b = toNum(y);
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  let r: number;
  switch (op) {
    case '+': r = a + b; break;
    case '-': r = a - b; break;
    case '*': r = a * b; break;
    case '/':
      if (b === 0) return ERR.div0;
      r = a / b;
      break;
    case '^':
      if (a === 0 && b < 0) return ERR.div0;
      r = a ** b;
      break;
    default: return ERR.value;
  }
  if (!Number.isFinite(r)) return ERR.num;
  return op === '+' || op === '-' ? round15(r) : r;
}

function binary(op: string, a: V, b: V): V {
  const aa = isArr(a) && (a.rows > 1 || a.cols > 1);
  const bb = isArr(b) && (b.rows > 1 || b.cols > 1);
  if (!aa && !bb) return arith(op, scalar(a), scalar(b));
  const A = aa ? (a as Arr) : null;
  const B = bb ? (b as Arr) : null;
  const rows = Math.max(A?.rows ?? 1, B?.rows ?? 1);
  const cols = Math.max(A?.cols ?? 1, B?.cols ?? 1);
  const sa = A ? null : scalar(a);
  const sb = B ? null : scalar(b);
  const out: Scalar[] = new Array(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) out[r * cols + c] = arith(op, A ? A.get(r, c) : sa, B ? B.get(r, c) : sb);
  return new Arr(rows, cols, out);
}

export function emptySheetData(): SheetData {
  return { id: '', workbookId: '', name: 'Sheet1', hidden: false, frozen: { rows: 0, cols: 0 }, sortKey: 'a0', cells: {}, colWidths: {}, rowHeights: {}, merges: [], cf: [] };
}

/** Scalar formula evaluation without a workbook (NumberField `=` expressions, `sheet_eval` scalar mode). */
export function evalScalar(formula: string, env: CalcEnv = { now: () => Date.now(), rand: Math.random }): { value: V; display: string; error?: string } {
  const calc = new Calc({ id: '', styles: {}, nextStyleId: 1, namedRanges: [], calc: { iterative: false, date1904: false } }, [], env);
  try {
    const v = calc.evalFormula(null, formula);
    const s = isArr(v) ? scalar(v) : v;
    return { value: v, display: formatScalar(s, undefined).text, error: isErr(s) ? s.code : undefined };
  } catch (e) {
    return { value: null, display: '', error: e instanceof Error ? e.message : 'Invalid formula' };
  }
}
