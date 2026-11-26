/**
 * Data-level sheet operations used by the mock backend: structural edits (insert / delete rows and columns with
 * reference rewriting across the workbook), fill series, paste, sort, merge and TSV clipboard text.
 */
import type { CondFormatRule, Rect } from '@/backend/types';
import { cellKey, keyCol, keyRow, MAX_COLS, MAX_ROWS, rectContains, rectsIntersect, splitSheetRef } from './addr';
import { parseLiteral, type Calc, type CellRec, type SheetData, type WorkbookData } from './calc';
import { isDateFormat } from './numfmt';
import { adjustFormula, adjustSpan, isFormula, shiftFormula, type StructuralEdit } from './refs';
import { compare, type Scalar } from './values';

export interface CellEdit {
  r: number;
  c: number;
  input: string | null;
  style?: number;
}

// ───────────────────────────────────────────────────────────────────────────── structural

/** Inserts (count > 0) or deletes (count < 0) rows / columns on `target`, rewriting every affected reference. */
export function applyStructural(wb: WorkbookData, sheets: SheetData[], target: SheetData, axis: 'rows' | 'cols', at: number, count: number): void {
  const edit: StructuralEdit = { sheetName: target.name, axis, at, count };
  const max = axis === 'rows' ? MAX_ROWS : MAX_COLS;
  // Move cells on the target sheet.
  const moved: Record<string, CellRec> = {};
  for (const [k, rec] of Object.entries(target.cells)) {
    const key = Number(k);
    let r = keyRow(key);
    let c = keyCol(key);
    const idx = axis === 'rows' ? r : c;
    let next = idx;
    if (count > 0) {
      if (idx >= at) next = idx + count;
    } else {
      const end = at - count - 1;
      if (idx >= at && idx <= end) continue;
      if (idx > end) next = idx + count;
    }
    if (next >= max) continue;
    if (axis === 'rows') r = next;
    else c = next;
    moved[String(cellKey(r, c))] = rec;
  }
  target.cells = moved;
  // Sizes.
  const sizes = axis === 'rows' ? target.rowHeights : target.colWidths;
  const nextSizes: Record<string, number> = {};
  for (const [k, v] of Object.entries(sizes)) {
    const idx = Number(k);
    if (count > 0) nextSizes[String(idx >= at ? idx + count : idx)] = v;
    else {
      const end = at - count - 1;
      if (idx >= at && idx <= end) continue;
      nextSizes[String(idx > end ? idx + count : idx)] = v;
    }
  }
  if (axis === 'rows') target.rowHeights = nextSizes;
  else target.colWidths = nextSizes;
  // Merges and conditional formats.
  const adjustRect = (rect: Rect): Rect | null => {
    const span = axis === 'rows' ? adjustSpan(rect.r0, rect.r1, at, count, MAX_ROWS) : adjustSpan(rect.c0, rect.c1, at, count, MAX_COLS);
    if (!span) return null;
    return axis === 'rows' ? { ...rect, r0: span[0], r1: span[1] } : { ...rect, c0: span[0], c1: span[1] };
  };
  target.merges = target.merges.map(adjustRect).filter((m): m is Rect => !!m && (m.r1 > m.r0 || m.c1 > m.c0));
  target.cf = target.cf
    .map((rule) => {
      const rect = adjustRect(rule.rect);
      if (!rect) return null;
      const next: CondFormatRule = { ...rule, rect };
      if (rule.formula) next.formula = adjustFormula(rule.formula.startsWith('=') ? rule.formula : `=${rule.formula}`, target.name, edit);
      return next;
    })
    .filter((r): r is CondFormatRule => !!r);
  if (axis === 'rows' && count < 0 && at < target.frozen.rows) target.frozen = { ...target.frozen, rows: Math.max(at, target.frozen.rows + count) };
  if (axis === 'cols' && count < 0 && at < target.frozen.cols) target.frozen = { ...target.frozen, cols: Math.max(at, target.frozen.cols + count) };
  if (axis === 'rows' && count > 0 && at < target.frozen.rows) target.frozen = { ...target.frozen, rows: target.frozen.rows + count };
  if (axis === 'cols' && count > 0 && at < target.frozen.cols) target.frozen = { ...target.frozen, cols: target.frozen.cols + count };
  // Formulas everywhere.
  for (const sh of sheets) {
    for (const rec of Object.values(sh.cells)) {
      if (isFormula(rec.i)) rec.i = adjustFormula(rec.i, sh.name, edit);
    }
  }
  const first = sheets[0]?.name ?? target.name;
  wb.namedRanges = wb.namedRanges.map((n) => {
    const { sheet } = splitSheetRef(n.ref);
    const out = adjustFormula(`=${n.ref.replace(/^=/, '')}`, sheet ?? first, edit).slice(1);
    return { ...n, ref: out };
  });
}

// ───────────────────────────────────────────────────────────────────────────── fill

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LISTS = [MONTHS_SHORT, MONTHS_LONG, DAYS_SHORT, DAYS_LONG];

function listIndex(s: string): { list: string[]; i: number; upper: boolean; lower: boolean } | null {
  for (const list of LISTS) {
    const i = list.findIndex((x) => x.toLowerCase() === s.toLowerCase());
    if (i >= 0) return { list, i, upper: s === s.toUpperCase() && s.length > 1, lower: s === s.toLowerCase() };
  }
  return null;
}

function caseLike(word: string, like: { upper: boolean; lower: boolean }): string {
  return like.upper ? word.toUpperCase() : like.lower ? word.toLowerCase() : word;
}

type SeriesFn = (k: number) => string;

/** Builds the generator for one line of source inputs (k = 1 is the first cell after the source). */
function seriesFor(inputs: string[], dateLike: boolean, mode: 'series' | 'copy'): SeriesFn | null {
  if (mode === 'copy' || inputs.some((s) => isFormula(s) || s === '')) return null;
  const vals = inputs.map((s) => parseLiteral(s));
  if (vals.every((v) => typeof v === 'number')) {
    const nums = vals as number[];
    if (nums.length === 1) {
      if (!dateLike) return null;
      return (k) => String(nums[0] + k);
    }
    // Least-squares linear trend, as Excel's fill does for 2+ numbers.
    const n = nums.length;
    const mx = (n - 1) / 2;
    const my = nums.reduce((s, x) => s + x, 0) / n;
    let sxy = 0;
    let sxx = 0;
    nums.forEach((y, x) => {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) ** 2;
    });
    const slope = sxx ? sxy / sxx : 0;
    const icept = my - slope * mx;
    const round = (x: number) => String(Number.parseFloat(x.toPrecision(15)));
    return (k) => round(icept + slope * (n - 1 + k));
  }
  if (inputs.length >= 1 && vals.every((v) => typeof v === 'string')) {
    const lis = inputs.map(listIndex);
    if (lis.every((x) => x && x.list === lis[0]!.list)) {
      const first = lis[0]!;
      const step = lis.length > 1 ? (lis[1]!.i - first.i + first.list.length) % first.list.length || 1 : 1;
      const last = lis[lis.length - 1]!;
      return (k) => caseLike(first.list[(((last.i + step * k) % first.list.length) + first.list.length) % first.list.length], first);
    }
    const nm = inputs.map((s) => /^(.*?)(\d+)(\D*)$/.exec(s));
    if (nm.every((m) => m && m[1] === nm[0]![1] && m[3] === nm[0]![3])) {
      const nums = nm.map((m) => Number(m![2]));
      const step = nums.length > 1 ? nums[nums.length - 1] - nums[nums.length - 2] : 1;
      const width = nm[0]![2].startsWith('0') ? nm[0]![2].length : 0;
      return (k) => `${nm[0]![1]}${String(nums[nums.length - 1] + step * k).padStart(width, '0')}${nm[0]![3]}`;
    }
  }
  return null;
}

/** Fill handle / ⌘D / ⌘R: extends `source` over `target` (which contains it). */
export function fillEdits(calc: Calc, sheetId: string, source: Rect, target: Rect, mode: 'series' | 'copy'): CellEdit[] {
  const edits: CellEdit[] = [];
  const down = target.r1 > source.r1;
  const up = target.r0 < source.r0;
  const right = target.c1 > source.c1;
  const left = target.c0 < source.c0;
  const vertical = down || up;
  const style = (r: number, c: number) => calc.styleAt(sheetId, r, c);
  const input = (r: number, c: number) => calc.input(sheetId, r, c);
  if (vertical) {
    const h = source.r1 - source.r0 + 1;
    for (let c = source.c0; c <= source.c1; c++) {
      const col = Array.from({ length: h }, (_, i) => input(source.r0 + i, c));
      const dateLike = isDateFormat(calc.style(style(source.r1, c)).numFmt);
      const gen = seriesFor(up ? [...col].reverse() : col, dateLike, mode);
      const rows: number[] = [];
      if (down) for (let r = source.r1 + 1; r <= target.r1; r++) rows.push(r);
      if (up) for (let r = source.r0 - 1; r >= target.r0; r--) rows.push(r);
      rows.forEach((r, i) => {
        const k = i + 1;
        const srcR = up ? source.r1 - ((k - 1) % h) : source.r0 + ((k - 1) % h);
        const src = input(srcR, c);
        const st = style(srcR, c);
        const value = gen ? gen(k) : isFormula(src) ? shiftFormula(src, r - srcR, 0) : src;
        edits.push({ r, c, input: value || null, style: st });
      });
    }
  } else if (right || left) {
    const w = source.c1 - source.c0 + 1;
    for (let r = source.r0; r <= source.r1; r++) {
      const row = Array.from({ length: w }, (_, i) => input(r, source.c0 + i));
      const dateLike = isDateFormat(calc.style(style(r, source.c1)).numFmt);
      const gen = seriesFor(left ? [...row].reverse() : row, dateLike, mode);
      const cols: number[] = [];
      if (right) for (let c = source.c1 + 1; c <= target.c1; c++) cols.push(c);
      if (left) for (let c = source.c0 - 1; c >= target.c0; c--) cols.push(c);
      cols.forEach((c, i) => {
        const k = i + 1;
        const srcC = left ? source.c1 - ((k - 1) % w) : source.c0 + ((k - 1) % w);
        const src = input(r, srcC);
        const st = style(r, srcC);
        const value = gen ? gen(k) : isFormula(src) ? shiftFormula(src, 0, c - srcC) : src;
        edits.push({ r, c, input: value || null, style: st });
      });
    }
  }
  return edits;
}

// ───────────────────────────────────────────────────────────────────────────── clipboard

/** Excel-compatible TSV: cells containing tabs, newlines or quotes are quoted. */
export function toTSV(rows: string[][]): string {
  return rows.map((row) => row.map((v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\r\n');
}

export function parseDelimited(text: string, delim = '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  let i = 0;
  const src = text.replace(/\r\n?/g, '\n');
  while (i < src.length) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        q = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' && cur === '') {
      q = true;
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  // Excel appends a trailing newline: drop a final empty row.
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  return rows;
}

export interface ClipPayload {
  v: 1;
  workbookId: string;
  sheetId: string;
  rect: Rect;
  cells: { r: number; c: number; i: string; s: number; d: string }[];
  merges: Rect[];
}

/** Paste edits for an internal clip (formulas shift relative to the destination). */
export function pasteClipEdits(clip: ClipPayload, at: { row: number; col: number }, mode: 'all' | 'values' | 'formats' | 'formulas', calc: Calc, sheetId: string): CellEdit[] {
  const dr = at.row - clip.rect.r0;
  const dc = at.col - clip.rect.c0;
  const h = clip.rect.r1 - clip.rect.r0 + 1;
  const w = clip.rect.c1 - clip.rect.c0 + 1;
  const byKey = new Map(clip.cells.map((x) => [cellKey(x.r, x.c), x]));
  const edits: CellEdit[] = [];
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const src = byKey.get(cellKey(clip.rect.r0 + r, clip.rect.c0 + c));
      const tr = at.row + r;
      const tc = at.col + c;
      if (tr >= MAX_ROWS || tc >= MAX_COLS) continue;
      const curStyle = calc.styleAt(sheetId, tr, tc);
      if (mode === 'formats') {
        edits.push({ r: tr, c: tc, input: calc.input(sheetId, tr, tc) || null, style: src?.s ?? 0 });
        continue;
      }
      let input = src?.i ?? '';
      if (isFormula(input)) input = mode === 'values' ? valueInput(src!.d) : shiftFormula(input, dr, dc);
      edits.push({ r: tr, c: tc, input: input || null, style: mode === 'all' ? src?.s ?? 0 : curStyle });
    }
  return edits;
}

/** A displayed value turned back into an input that keeps it as-is (numbers as numbers, text as text). */
function valueInput(display: string): string {
  if (display === '') return '';
  const lit = parseLiteral(display);
  return typeof lit === 'string' && lit !== display ? `'${display}` : display;
}

export function pasteTextEdits(rows: string[][], at: { row: number; col: number }, calc: Calc, sheetId: string): CellEdit[] {
  const edits: CellEdit[] = [];
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      const tr = at.row + r;
      const tc = at.col + c;
      if (tr >= MAX_ROWS || tc >= MAX_COLS) return;
      edits.push({ r: tr, c: tc, input: v === '' ? null : v.length > 32_767 ? v.slice(0, 32_767) : v, style: calc.styleAt(sheetId, tr, tc) });
    }),
  );
  return edits;
}

// ───────────────────────────────────────────────────────────────────────────── sort

export function sortEdits(calc: Calc, sheetId: string, rect: Rect, keys: { col: number; dir: 'asc' | 'desc' }[], hasHeader: boolean): CellEdit[] {
  const r0 = hasHeader ? rect.r0 + 1 : rect.r0;
  if (r0 > rect.r1) return [];
  const rows: { r: number; vals: Scalar[] }[] = [];
  for (let r = r0; r <= rect.r1; r++) rows.push({ r, vals: keys.map((k) => calc.value(sheetId, r, k.col)) });
  const sorted = [...rows].sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const x = a.vals[i];
      const y = b.vals[i];
      // Blanks always sort last.
      if (x === null && y === null) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = compare(x, y) * (keys[i].dir === 'desc' ? -1 : 1);
      if (c) return c;
    }
    return a.r - b.r;
  });
  const edits: CellEdit[] = [];
  sorted.forEach((src, i) => {
    const tr = r0 + i;
    for (let c = rect.c0; c <= rect.c1; c++) {
      const input = calc.input(sheetId, src.r, c);
      edits.push({ r: tr, c, input: (isFormula(input) ? shiftFormula(input, tr - src.r, 0) : input) || null, style: calc.styleAt(sheetId, src.r, c) });
    }
  });
  return edits;
}

// ───────────────────────────────────────────────────────────────────────────── merges

export function mergeRects(merges: Rect[], rect: Rect, merge: boolean): Rect[] {
  const rest = merges.filter((m) => !rectsIntersect(m, rect));
  if (merge && (rect.r1 > rect.r0 || rect.c1 > rect.c0)) rest.push(rect);
  return rest;
}

/** The merge containing (r, c), if any. */
export function mergeAt(merges: Rect[], r: number, c: number): Rect | undefined {
  return merges.find((m) => rectContains(m, r, c));
}
