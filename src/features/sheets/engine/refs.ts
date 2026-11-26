/**
 * Reference rewriting (§14.2 "Structural edits"): token-level, so the user's spacing and casing survive.
 *   shiftFormula   — fill / copy-paste: relative edges move, `$` edges stay; off-grid edges become #REF!.
 *   adjustFormula  — insert / delete rows or columns on a sheet; references to deleted cells become #REF!.
 *   renameSheetRefs — a sheet was renamed.
 */
import { MAX_COLS, MAX_ROWS, quoteSheet } from './addr';
import { formatRef, sheetPrefixText, tokenize, type RefInfo } from './lexer';

export const isFormula = (input: string): boolean => input.length > 1 && input.startsWith('=');

export function shiftFormula(input: string, dr: number, dc: number): string {
  if (!isFormula(input) || (dr === 0 && dc === 0)) return input;
  let out = '';
  for (const tok of tokenize(input)) {
    if (tok.t !== 'ref' || !tok.ref) {
      out += tok.v;
      continue;
    }
    const { rect, abs, kind } = tok.ref;
    const next = { ...rect };
    if (kind !== 'cols') {
      if (!abs.r0) next.r0 += dr;
      if (!abs.r1) next.r1 += dr;
    }
    if (kind !== 'rows') {
      if (!abs.c0) next.c0 += dc;
      if (!abs.c1) next.c1 += dc;
    }
    if (next.r0 < 0 || next.c0 < 0 || next.r1 >= MAX_ROWS || next.c1 >= MAX_COLS || next.r1 < 0 || next.c1 < 0) {
      out += `${sheetPrefixText(tok) ? `${sheetPrefixText(tok)}!` : ''}#REF!`;
      continue;
    }
    const info: RefInfo = { ...tok.ref, rect: normalize(next) };
    out += formatRef(info, sheetPrefixText(tok));
  }
  return out;
}

function normalize(r: { r0: number; c0: number; r1: number; c1: number }) {
  return { r0: Math.min(r.r0, r.r1), c0: Math.min(r.c0, r.c1), r1: Math.max(r.r0, r.r1), c1: Math.max(r.c0, r.c1) };
}

export interface StructuralEdit {
  /** Name of the sheet whose rows / columns changed. */
  sheetName: string;
  axis: 'rows' | 'cols';
  at: number;
  /** > 0 inserts, < 0 deletes. */
  count: number;
}

const sameSheet = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Adjusts an edge pair [lo, hi] for an insert / delete. Returns null when the span was deleted entirely. */
export function adjustSpan(lo: number, hi: number, at: number, count: number, max: number): [number, number] | null {
  if (count > 0) {
    const nlo = lo >= at ? lo + count : lo;
    const nhi = hi >= at ? hi + count : hi;
    return [Math.min(nlo, max - 1), Math.min(nhi, max - 1)];
  }
  const n = -count;
  const end = at + n - 1;
  const nlo = lo < at ? lo : lo > end ? lo - n : at;
  const nhi = hi < at ? hi : hi > end ? hi - n : at - 1;
  return nhi < nlo ? null : [nlo, nhi];
}

export function adjustFormula(input: string, ownSheetName: string, edit: StructuralEdit): string {
  if (!isFormula(input)) return input;
  let changed = false;
  let out = '';
  for (const tok of tokenize(input)) {
    if (tok.t !== 'ref' || !tok.ref) {
      out += tok.v;
      continue;
    }
    const target = tok.ref.sheet ?? ownSheetName;
    if (!sameSheet(target, edit.sheetName)) {
      out += tok.v;
      continue;
    }
    const { rect, kind } = tok.ref;
    const next = { ...rect };
    if (edit.axis === 'rows' && kind !== 'cols') {
      const span = adjustSpan(rect.r0, rect.r1, edit.at, edit.count, MAX_ROWS);
      if (!span) {
        out += `${sheetPrefixText(tok) ? `${sheetPrefixText(tok)}!` : ''}#REF!`;
        changed = true;
        continue;
      }
      [next.r0, next.r1] = span;
    }
    if (edit.axis === 'cols' && kind !== 'rows') {
      const span = adjustSpan(rect.c0, rect.c1, edit.at, edit.count, MAX_COLS);
      if (!span) {
        out += `${sheetPrefixText(tok) ? `${sheetPrefixText(tok)}!` : ''}#REF!`;
        changed = true;
        continue;
      }
      [next.c0, next.c1] = span;
    }
    if (next.r0 !== rect.r0 || next.r1 !== rect.r1 || next.c0 !== rect.c0 || next.c1 !== rect.c1) changed = true;
    out += formatRef({ ...tok.ref, rect: next }, sheetPrefixText(tok));
  }
  return changed ? out : input;
}

export function renameSheetRefs(input: string, oldName: string, newName: string): string {
  if (!isFormula(input) || !input.includes('!')) return input;
  let changed = false;
  let out = '';
  for (const tok of tokenize(input)) {
    if (tok.t === 'ref' && tok.ref?.sheet && sameSheet(tok.ref.sheet, oldName)) {
      out += formatRef(tok.ref, quoteSheet(newName));
      changed = true;
    } else out += tok.v;
  }
  return changed ? out : input;
}

/** Every reference in a formula (for highlighting and precedents). */
export function formulaRefs(input: string): RefInfo[] {
  if (!isFormula(input)) return [];
  return tokenize(input)
    .filter((t) => t.t === 'ref' && t.ref)
    .map((t) => t.ref!);
}
