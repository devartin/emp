/**
 * A1 addressing (§14.1): column letters ↔ indices, cell / range names and parsing. All indices are 0-based and
 * rects are inclusive (`Rect` from §11.2). Shared by the browser mock engine and the grid UI.
 */
import type { Rect } from '@/backend/types';

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;
/** Packs (row, col) into one safe integer: row * MAX_COLS + col. */
export const cellKey = (r: number, c: number): number => r * MAX_COLS + c;
export const keyRow = (k: number): number => Math.floor(k / MAX_COLS);
export const keyCol = (k: number): number => k % MAX_COLS;

export function colName(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 'A' → 0, 'XFD' → 16383; −1 when not a valid column. */
export function colIndex(s: string): number {
  if (!s || s.length > 3) return -1;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i) & ~32; // upper-case
    if (ch < 65 || ch > 90) return -1;
    n = n * 26 + (ch - 64);
  }
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

export const cellName = (r: number, c: number): string => `${colName(c)}${r + 1}`;

export function isFullCols(rect: Rect): boolean {
  return rect.r0 === 0 && rect.r1 >= MAX_ROWS - 1;
}
export function isFullRows(rect: Rect): boolean {
  return rect.c0 === 0 && rect.c1 >= MAX_COLS - 1;
}

/** 'B3', 'A1:C9', 'A:C' (whole columns), '2:5' (whole rows). */
export function rectName(rect: Rect): string {
  const full = isFullCols(rect);
  const rows = isFullRows(rect);
  if (full && rows) return `A:${colName(MAX_COLS - 1)}`;
  if (full) return `${colName(rect.c0)}:${colName(rect.c1)}`;
  if (rows) return `${rect.r0 + 1}:${rect.r1 + 1}`;
  if (rect.r0 === rect.r1 && rect.c0 === rect.c1) return cellName(rect.r0, rect.c0);
  return `${cellName(rect.r0, rect.c0)}:${cellName(rect.r1, rect.c1)}`;
}

export function normRect(r0: number, c0: number, r1: number, c1: number): Rect {
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}

export const rectContains = (rect: Rect, r: number, c: number): boolean => r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
export const rectsIntersect = (a: Rect, b: Rect): boolean => a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
export const rectEquals = (a: Rect, b: Rect): boolean => a.r0 === b.r0 && a.c0 === b.c0 && a.r1 === b.r1 && a.c1 === b.c1;
export const rectArea = (a: Rect): number => (a.r1 - a.r0 + 1) * (a.c1 - a.c0 + 1);
export function rectUnion(a: Rect, b: Rect): Rect {
  return { r0: Math.min(a.r0, b.r0), c0: Math.min(a.c0, b.c0), r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1) };
}
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const r = { r0: Math.max(a.r0, b.r0), c0: Math.max(a.c0, b.c0), r1: Math.min(a.r1, b.r1), c1: Math.min(a.c1, b.c1) };
  return r.r0 <= r.r1 && r.c0 <= r.c1 ? r : null;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const COL_RE = /^\$?([A-Za-z]{1,3})$/;
const ROW_RE = /^\$?(\d{1,7})$/;

export function parseCell(s: string): { r: number; c: number } | null {
  const m = CELL_RE.exec(s.trim());
  if (!m) return null;
  const c = colIndex(m[1]);
  const r = Number(m[2]) - 1;
  if (c < 0 || r < 0 || r >= MAX_ROWS) return null;
  return { r, c };
}

/** Parses a reference without a sheet prefix: 'A1', 'A1:B2', 'A:A', '1:3'. */
export function parseRect(s: string): Rect | null {
  const t = s.trim();
  const i = t.indexOf(':');
  if (i < 0) {
    const p = parseCell(t);
    return p ? { r0: p.r, c0: p.c, r1: p.r, c1: p.c } : null;
  }
  const a = t.slice(0, i);
  const b = t.slice(i + 1);
  const pa = parseCell(a);
  const pb = parseCell(b);
  if (pa && pb) return normRect(pa.r, pa.c, pb.r, pb.c);
  const ca = COL_RE.exec(a);
  const cb = COL_RE.exec(b);
  if (ca && cb) {
    const c0 = colIndex(ca[1]);
    const c1 = colIndex(cb[1]);
    if (c0 < 0 || c1 < 0) return null;
    return { r0: 0, r1: MAX_ROWS - 1, c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
  }
  const ra = ROW_RE.exec(a);
  const rb = ROW_RE.exec(b);
  if (ra && rb) {
    const r0 = Number(ra[1]) - 1;
    const r1 = Number(rb[1]) - 1;
    if (r0 < 0 || r1 < 0 || r0 >= MAX_ROWS || r1 >= MAX_ROWS) return null;
    return { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: 0, c1: MAX_COLS - 1 };
  }
  return null;
}

/** Splits an optional sheet prefix: "'My Sheet'!A1:B2" → { sheet: 'My Sheet', ref: 'A1:B2' }. */
export function splitSheetRef(s: string): { sheet?: string; ref: string } {
  const t = s.trim();
  const bang = t.lastIndexOf('!');
  if (bang < 0) return { ref: t };
  let sheet = t.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet, ref: t.slice(bang + 1) };
}

/** Quotes a sheet name for use in a formula when needed. */
export function quoteSheet(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !CELL_RE.test(name) && !/^(TRUE|FALSE)$/i.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/** Display a range compactly in the name box / status: "C4", "A1:D9", "3R × 2C". */
export function rectSizeLabel(rect: Rect): string {
  const rows = rect.r1 - rect.r0 + 1;
  const cols = rect.c1 - rect.c0 + 1;
  return `${rows}R × ${cols}C`;
}
