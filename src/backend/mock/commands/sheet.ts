/**
 * Sheets namespace (§11.3 "Sheets") for the browser mock. The TypeScript engine in `features/sheets/engine`
 * (CLAUDE.md override 1) does parsing, dependency-tracked recalculation, spill, number formats, conditional
 * formats, fill / paste / sort and xlsx / csv IO. Stored records:
 *   'sheet_workbooks'  WorkbookData (id = the workbook page id)
 *   'sheet_sheets'     SheetData (cells keyed by row * 16384 + col)
 * Undo (200 groups per workbook) and revs live in memory only.
 */
import type {
  CellStyle,
  CondFormatRule,
  DirtyRect,
  Id,
  PackedCells,
  PageMeta,
  Rect,
  SheetCellInfo,
  SheetLintIssue,
  SheetMeta,
  SheetRange,
} from '../../types';
import { BackendError } from '../../errors';
import type { MockCallCtx, MockCtx, MockHandlers } from '../ctx';
import {
  cellKey,
  cellName,
  keyCol,
  keyRow,
  MAX_COLS,
  MAX_ROWS,
  quoteSheet,
  rectContains,
  rectName,
  rectsIntersect,
  splitSheetRef,
  parseRect,
} from '@/features/sheets/engine/addr';
import { autoFormatFor, Calc, cleanStyle, type CellRec, type CellView, type Changed, type SheetData, type WorkbookData, evalScalar } from '@/features/sheets/engine/calc';
import { functionDocs } from '@/features/sheets/engine/functions';
import { formatScalar } from '@/features/sheets/engine/numfmt';
import { applyStructural, fillEdits, mergeRects, parseDelimited, pasteClipEdits, pasteTextEdits, sortEdits, toTSV, type CellEdit, type ClipPayload } from '@/features/sheets/engine/ops';
import { FormulaParseError, parseFormula } from '@/features/sheets/engine/parser';
import { formulaRefs, isFormula, renameSheetRefs, shiftFormula } from '@/features/sheets/engine/refs';
import { tokenize, sheetPrefixText } from '@/features/sheets/engine/lexer';
import { BookBuilder, TEMPLATES } from '@/features/sheets/engine/templates';
import { isArr, isErr, toPlain } from '@/features/sheets/engine/values';
import { scalar } from '@/features/sheets/engine/functions';
import { readXlsx, sniffDelimiter, writeXlsx, type XlsxCellStyle, type XlsxWriteSheet } from '@/features/sheets/engine/xlsx';

const WB = 'sheet_workbooks';
const SH = 'sheet_sheets';
const MAX_FORMULA = 8192;
const MAX_TEXT = 32_767;
const UNDO_CAP = 200;

// ───────────────────────────────────────────────────────────────────────────── storage & engine cache

const engines = new WeakMap<WorkbookData, Calc>();
const revs = new Map<Id, number>();
const lastSheetOf = new Map<Id, Id>();

type Snapshot = Pick<SheetData, 'cells' | 'colWidths' | 'rowHeights' | 'merges' | 'cf' | 'frozen'>;
type UndoEntry =
  | { kind: 'cells'; sheetId: Id; before: [number, CellRec | null][]; after: [number, CellRec | null][] }
  | { kind: 'book'; before: Record<Id, Snapshot>; after: Record<Id, Snapshot>; namesBefore: WorkbookData['namedRanges']; namesAfter: WorkbookData['namedRanges'] }
  | { kind: 'meta'; sheetId: Id; before: Partial<Snapshot>; after: Partial<Snapshot> };
interface UndoGroup {
  label: string;
  group?: string;
  at: number;
  entries: UndoEntry[];
}
const undoStacks = new Map<Id, { past: UndoGroup[]; future: UndoGroup[] }>();

function stacks(workbookId: Id) {
  let s = undoStacks.get(workbookId);
  if (!s) undoStacks.set(workbookId, (s = { past: [], future: [] }));
  return s;
}

function pushUndo(ctx: MockCtx, workbookId: Id, label: string, entries: UndoEntry[], group?: string): void {
  if (!entries.length) return;
  const s = stacks(workbookId);
  const now = ctx.clock.now();
  const last = s.past[s.past.length - 1];
  if (group && last && last.group === group && now - last.at < 2000) {
    last.entries.push(...entries);
    last.at = now;
  } else {
    s.past.push({ label, group, at: now, entries });
    if (s.past.length > UNDO_CAP) s.past.shift();
  }
  s.future = [];
}

function wbTable(ctx: MockCtx) {
  return ctx.db.table<WorkbookData>(WB);
}
function shTable(ctx: MockCtx) {
  return ctx.db.table<SheetData>(SH);
}

function sheetsOf(ctx: MockCtx, workbookId: Id): SheetData[] {
  return shTable(ctx)
    .filter((s) => s.workbookId === workbookId)
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

function requireWorkbook(ctx: MockCtx, id: Id): WorkbookData {
  const wb = wbTable(ctx).get(id);
  if (!wb) {
    const page = ctx.pages.get(id);
    if (page && page.kind === 'sheet' && !page.deletedAt) return createWorkbookData(ctx, id, 'blank').wb;
    throw new BackendError('NOT_FOUND', 'Workbook not found');
  }
  const page = ctx.pages.get(id);
  if (page?.deletedAt) throw new BackendError('NOT_FOUND', 'This workbook is in Trash');
  return wb;
}

function engineFor(ctx: MockCtx, workbookId: Id): Calc {
  const wb = requireWorkbook(ctx, workbookId);
  let calc = engines.get(wb);
  if (!calc) {
    calc = new Calc(wb, sheetsOf(ctx, workbookId), { now: () => ctx.clock.now(), rand: () => ctx.rng.next() });
    engines.set(wb, calc);
  }
  return calc;
}

function requireSheet(ctx: MockCtx, sheetId: Id): { sheet: SheetData; calc: Calc; wb: WorkbookData } {
  const sheet = shTable(ctx).get(sheetId);
  if (!sheet) throw new BackendError('NOT_FOUND', 'Sheet not found');
  const calc = engineFor(ctx, sheet.workbookId);
  return { sheet, calc, wb: calc.wb };
}

function touch(ctx: MockCtx, sheet: SheetData): number {
  const next = (revs.get(sheet.id) ?? 1) + 1;
  revs.set(sheet.id, next);
  wbTable(ctx).update(sheet.workbookId, () => undefined);
  if (ctx.pages.get(sheet.workbookId)) ctx.pages.touch(sheet.workbookId);
  lastSheetOf.set(sheet.workbookId, sheet.id);
  return next;
}

function sheetMeta(calc: Calc | null, s: SheetData): SheetMeta {
  const ext = calc ? calc.extent(s.id) : { r: -1, c: -1 };
  const meta: SheetMeta = { id: s.id, name: s.name, hidden: s.hidden, frozen: { ...s.frozen }, maxRow: Math.max(0, ext.r), maxCol: Math.max(0, ext.c), sortKey: s.sortKey };
  if (s.color) meta.color = s.color;
  return meta;
}

function createWorkbookData(ctx: MockCtx, id: Id, template: string): { wb: WorkbookData; sheets: SheetData[] } {
  const b = new BookBuilder(id, () => ctx.id());
  (TEMPLATES[template] ?? TEMPLATES.blank).build(b);
  wbTable(ctx).put(b.wb);
  for (const s of b.sheets) shTable(ctx).put(s);
  return { wb: b.wb, sheets: b.sheets };
}

/** Creates a workbook page (seed + handlers). */
export function createWorkbook(ctx: MockCtx, input: { workspaceId?: Id; parentId: Id | null; title: string; template?: string; build?: (b: BookBuilder) => void; createdAt?: number; silent?: boolean; icon?: PageMeta['icon'] }): { page: PageMeta; sheets: SheetData[] } {
  const rec = ctx.pages.create({ workspaceId: input.workspaceId, parentId: input.parentId, kind: 'sheet', title: input.title, icon: input.icon, createdAt: input.createdAt, silent: input.silent });
  let sheets: SheetData[];
  if (input.build) {
    const b = new BookBuilder(rec.id, () => ctx.id());
    input.build(b);
    if (!b.sheets.length) b.sheet('Sheet1');
    wbTable(ctx).put(b.wb);
    for (const s of b.sheets) shTable(ctx).put(s);
    sheets = b.sheets;
  } else sheets = createWorkbookData(ctx, rec.id, input.template ?? 'blank').sheets;
  return { page: ctx.pages.meta(rec.id), sheets };
}

// ───────────────────────────────────────────────────────────────────────────── packing

function emptyPacked(): PackedCells {
  return { r: [], c: [], d: [], k: [], f: [], s: [] };
}

function pack(views: (CellView | { r: number; c: number; d: string; k: number; f: number; s: number })[]): PackedCells {
  const p = emptyPacked();
  for (const v of views) {
    p.r.push(v.r);
    p.c.push(v.c);
    p.d.push(v.d);
    p.k.push(v.k);
    p.f.push(v.f);
    p.s.push(v.s);
  }
  return p;
}

function viewOrEmpty(calc: Calc, sheetId: Id, r: number, c: number) {
  return calc.cellView(sheetId, r, c) ?? { r, c, d: '', k: 0, f: 0, s: 0 };
}

/** Splits changed positions into the visible packed cells and dirty rects elsewhere. */
function report(calc: Calc, changed: Changed, sheetId: Id, visible: Rect | null): { changed: PackedCells; dirtyRects: DirtyRect[] } {
  const views: ReturnType<typeof viewOrEmpty>[] = [];
  const dirty: DirtyRect[] = [];
  for (const [sid, keys] of changed) {
    let bound: Rect | null = null;
    for (const k of keys) {
      const r = keyRow(k);
      const c = keyCol(k);
      if (sid === sheetId && visible && rectContains(visible, r, c)) views.push(viewOrEmpty(calc, sid, r, c));
      else bound = bound ? { r0: Math.min(bound.r0, r), c0: Math.min(bound.c0, c), r1: Math.max(bound.r1, r), c1: Math.max(bound.c1, c) } : { r0: r, c0: c, r1: r, c1: c };
    }
    if (bound) dirty.push({ sheetId: sid, rect: bound });
    // Value-dependent conditional formats repaint their whole range.
    const data = calc.sheet(sid);
    if (data?.cf.length && keys.size) {
      for (const rule of data.cf) {
        if (rule.kind === 'cell') continue;
        const touches = rule.kind === 'formula' || [...keys].some((k) => rectContains(rule.rect, keyRow(k), keyCol(k)));
        if (touches) dirty.push({ sheetId: sid, rect: rule.rect });
      }
    }
  }
  views.sort((a, b) => a.r - b.r || a.c - b.c);
  return { changed: pack(views), dirtyRects: dirty };
}

function emitChanged(ctx: MockCtx, workbookId: Id, dirty: DirtyRect[], extra?: { sheetId: Id; rect: Rect }): void {
  const bySheet = new Map<Id, Rect[]>();
  for (const d of [...dirty, ...(extra ? [extra] : [])]) {
    const list = bySheet.get(d.sheetId) ?? [];
    list.push(d.rect);
    bySheet.set(d.sheetId, list);
  }
  for (const [sheetId, rects] of bySheet) ctx.emit('sheet:changed', { workbookId, sheetId, rects });
}

// ───────────────────────────────────────────────────────────────────────────── edits with undo

function recOf(sheet: SheetData, key: number): CellRec | null {
  const r = sheet.cells[String(key)];
  return r ? { ...r } : null;
}

/** Applies cell edits with undo capture; returns the engine's changed set. */
function applyEdits(ctx: MockCtx, calc: Calc, sheet: SheetData, edits: CellEdit[], label: string, group?: string): Changed {
  if (!edits.length) return new Map();
  const keys = [...new Set(edits.map((e) => cellKey(e.r, e.c)))];
  const before = keys.map((k) => [k, recOf(sheet, k)] as [number, CellRec | null]);
  const changed = calc.setInputs(sheet.id, edits.map((e) => ({ r: e.r, c: e.c, input: e.input, style: e.style })));
  const after = keys.map((k) => [k, recOf(sheet, k)] as [number, CellRec | null]);
  pushUndo(ctx, sheet.workbookId, label, [{ kind: 'cells', sheetId: sheet.id, before, after }], group);
  touch(ctx, sheet);
  return changed;
}

function snapshotSheet(s: SheetData): Snapshot {
  return structuredClone({ cells: s.cells, colWidths: s.colWidths, rowHeights: s.rowHeights, merges: s.merges, cf: s.cf, frozen: s.frozen });
}

function bookChange(ctx: MockCtx, workbookId: Id, label: string, fn: () => void): void {
  const calc = engineFor(ctx, workbookId);
  const sheets = sheetsOf(ctx, workbookId);
  const before = Object.fromEntries(sheets.map((s) => [s.id, snapshotSheet(s)]));
  const namesBefore = structuredClone(calc.wb.namedRanges);
  fn();
  calc.rebuild();
  const after = Object.fromEntries(sheets.map((s) => [s.id, snapshotSheet(s)]));
  pushUndo(ctx, workbookId, label, [{ kind: 'book', before, after, namesBefore, namesAfter: structuredClone(calc.wb.namedRanges) }]);
  for (const s of sheets) touch(ctx, s);
}

function metaChange(ctx: MockCtx, sheet: SheetData, label: string, fields: (keyof Snapshot)[], fn: () => void): void {
  const pick = () => structuredClone(Object.fromEntries(fields.map((f) => [f, sheet[f]])) as Partial<Snapshot>);
  const before = pick();
  fn();
  const after = pick();
  pushUndo(ctx, sheet.workbookId, label, [{ kind: 'meta', sheetId: sheet.id, before, after }]);
  touch(ctx, sheet);
}

function applyUndo(ctx: MockCtx, workbookId: Id, entries: UndoEntry[], dir: 'before' | 'after'): Id[] {
  const calc = engineFor(ctx, workbookId);
  const changedSheets = new Set<Id>();
  let rebuild = false;
  const list = dir === 'before' ? [...entries].reverse() : entries;
  for (const e of list) {
    if (e.kind === 'cells') {
      const sheet = shTable(ctx).get(e.sheetId);
      if (!sheet) continue;
      const recs = e[dir];
      calc.setInputs(sheet.id, recs.map(([k, rec]) => ({ r: keyRow(k), c: keyCol(k), input: rec?.i ?? null, style: rec?.s ?? 0 })));
      changedSheets.add(sheet.id);
    } else if (e.kind === 'meta') {
      const sheet = shTable(ctx).get(e.sheetId);
      if (!sheet) continue;
      Object.assign(sheet, structuredClone(e[dir]));
      if ('merges' in e[dir] || 'cells' in e[dir]) rebuild = true;
      changedSheets.add(sheet.id);
    } else {
      const snaps = e[dir];
      for (const [id, snap] of Object.entries(snaps)) {
        const sheet = shTable(ctx).get(id);
        if (!sheet) continue;
        Object.assign(sheet, structuredClone(snap));
        changedSheets.add(id);
      }
      calc.wb.namedRanges = structuredClone(dir === 'before' ? e.namesBefore : e.namesAfter);
      rebuild = true;
    }
  }
  if (rebuild) calc.rebuild();
  for (const id of changedSheets) {
    const s = shTable(ctx).get(id);
    if (s) touch(ctx, s);
  }
  return [...changedSheets];
}

// ───────────────────────────────────────────────────────────────────────────── validation helpers

function checkRect(rect: Rect, what = 'rect'): Rect {
  const ok = [rect.r0, rect.c0, rect.r1, rect.c1].every((n) => Number.isInteger(n) && n >= 0);
  if (!ok || rect.r1 >= MAX_ROWS || rect.c1 >= MAX_COLS) throw new BackendError('INVALID', `Invalid ${what}`, { field: what });
  return { r0: Math.min(rect.r0, rect.r1), c0: Math.min(rect.c0, rect.c1), r1: Math.max(rect.r0, rect.r1), c1: Math.max(rect.c0, rect.c1) };
}

/** Clamps whole-row / whole-column rects to the used area (plus a margin) for cell-wise work. */
function clampToUsed(calc: Calc, sheetId: Id, rect: Rect, margin = 0): Rect {
  const ext = calc.extent(sheetId);
  const sheet = calc.sheet(sheetId);
  let maxR = ext.r;
  let maxC = ext.c;
  if (sheet) {
    for (const k of Object.keys(sheet.cells)) {
      const key = Number(k);
      maxR = Math.max(maxR, keyRow(key));
      maxC = Math.max(maxC, keyCol(key));
    }
  }
  return { r0: rect.r0, c0: rect.c0, r1: Math.min(rect.r1, Math.max(rect.r0, maxR + margin)), c1: Math.min(rect.c1, Math.max(rect.c0, maxC + margin)) };
}

function mergeStyle(base: CellStyle, patch: Partial<CellStyle>): CellStyle {
  const out: CellStyle = { ...base };
  const del = (v: unknown) => v === null || v === '';
  for (const [k, v] of Object.entries(patch) as [keyof CellStyle, unknown][]) {
    if (k === 'font' || k === 'align' || k === 'border') {
      if (v === null) {
        delete out[k];
        continue;
      }
      const merged: Record<string, unknown> = { ...(out[k] as Record<string, unknown> | undefined) };
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        if (del(vv) || vv === undefined) delete merged[kk];
        else merged[kk] = vv;
      }
      (out as Record<string, unknown>)[k] = merged;
    } else if (del(v)) delete out[k];
    else (out as Record<string, unknown>)[k] = v;
  }
  return cleanStyle(out);
}

function validateInput(input: string | null): string | null {
  if (input === null) return null;
  if (isFormula(input)) {
    if (input.length > MAX_FORMULA) throw new FormulaParseError('Formulas are limited to 8,192 characters', 0);
    parseFormula(input);
    return input;
  }
  return input.length > MAX_TEXT ? input.slice(0, MAX_TEXT) : input;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Replaces references to a sheet with #REF! (the sheet is being deleted). */
function breakSheetRefs(input: string, name: string): string {
  if (!isFormula(input) || !input.includes('!')) return input;
  let changed = false;
  const out = tokenize(input)
    .map((t) => {
      if (t.t === 'ref' && t.ref?.sheet && t.ref.sheet.toLowerCase() === name.toLowerCase()) {
        changed = true;
        return '#REF!';
      }
      return t.v;
    })
    .join('');
  return changed ? out : input;
}

function uniqueSheetName(existing: SheetData[], base: string): string {
  const names = new Set(existing.map((s) => s.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base.replace(/\s+\d+$/, '')} ${i}`;
    if (!names.has(n.toLowerCase())) return n;
  }
}

function sanitizeSheetName(name: string): string {
  const n = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  if (!n) throw new BackendError('INVALID', 'Sheet names can’t be empty', { field: 'name' });
  if (/^history$/i.test(n)) throw new BackendError('INVALID', '“History” is reserved', { field: 'name' });
  return n;
}

function styleToXlsx(st: CellStyle): XlsxCellStyle | undefined {
  const out: XlsxCellStyle = {};
  if (st.numFmt) out.numFmt = st.numFmt;
  if (st.font?.b || st.role === 'output') out.bold = true;
  if (st.font?.i) out.italic = true;
  if (st.font?.color) out.color = st.font.color;
  if (st.fill) out.fill = st.fill;
  else if (st.role === 'input') out.fill = '#E8E8FC';
  if (st.align?.h) out.align = st.align.h;
  return Object.keys(out).length ? out : undefined;
}

// ───────────────────────────────────────────────────────────────────────────── lint

function lint(ctx: MockCtx, workbookId: Id): SheetLintIssue[] {
  const calc = engineFor(ctx, workbookId);
  const issues: SheetLintIssue[] = [];
  const add = (sheetId: Id, rect: Rect, rule: SheetLintIssue['rule'], message: string, fix?: string) =>
    issues.push({ id: `${rule}:${sheetId}:${rect.r0}:${rect.c0}`, sheetId, rect, rule, message, ...(fix ? { fix } : {}) });
  const byPos = new Map<string, string>();
  const normalized = (input: string, r: number, c: number) => {
    // R1C1-style form: shift every relative reference back to the origin.
    return shiftFormula(input, -r, -c);
  };
  let volatile = 0;
  for (const f of calc.formulaCells()) byPos.set(`${f.sheetId}:${f.r}:${f.c}`, normalized(f.input, f.r, f.c));
  const usedNames = new Set<string>();
  for (const f of calc.formulaCells()) {
    const rect = { r0: f.r, c0: f.c, r1: f.r, c1: f.c };
    const where = cellName(f.r, f.c);
    if (/#REF!/i.test(f.input) || (isErr(f.value) && f.value.code === '#REF!')) add(f.sheetId, rect, 'ref_error', `${where} refers to cells that no longer exist.`, 'Rewrite the formula or undo the deletion.');
    else if (isErr(f.value) && f.value.code === '#DIV/0!') add(f.sheetId, rect, 'div0', `${where} divides by zero.`, `Wrap it: =IFERROR(${f.input.slice(1)}, 0)`);
    else if (isErr(f.value) && f.value.code === '#CIRC!') add(f.sheetId, rect, 'circular', `${where} is part of a circular reference.`);
    if (/\b(RAND|RANDBETWEEN|NOW|TODAY|OFFSET|INDIRECT)\s*\(/i.test(f.input)) volatile++;
    for (const t of tokenize(f.input)) if (t.t === 'name') usedNames.add(t.v.toLowerCase());
    // Hard-coded constants (numbers other than small counts / percentages) inside formulas.
    const consts = tokenize(f.input).filter((t) => t.t === 'num' && !['0', '1', '2', '12', '100', '1000', '24', '60', '365', '52', '7'].includes(t.v));
    const insideFns = /SUMIFS|COUNTIF|DATE\(|EDATE|EOMONTH|TAKE|SORT|INDEX|ROUND|TEXT\(|SEQUENCE/i.test(f.input);
    if (consts.length && !insideFns) add(f.sheetId, rect, 'hardcoded_constant', `${where} contains the constant ${consts[0].v}.`, 'Move it to an input cell or a named range.');
    // Inconsistent formula: both neighbours agree with each other but not with this cell.
    const me = byPos.get(`${f.sheetId}:${f.r}:${f.c}`);
    const up = byPos.get(`${f.sheetId}:${f.r - 1}:${f.c}`);
    const down = byPos.get(`${f.sheetId}:${f.r + 1}:${f.c}`);
    const left = byPos.get(`${f.sheetId}:${f.r}:${f.c - 1}`);
    const right = byPos.get(`${f.sheetId}:${f.r}:${f.c + 1}`);
    if ((up && down && up === down && me !== up) || (left && right && left === right && me !== left && !up && !down)) {
      add(f.sheetId, rect, 'inconsistent_formula', `${where} doesn’t match the formulas around it.`, 'Fill the neighbouring formula into this cell.');
    }
  }
  for (const s of calc.sheetList()) {
    for (const c of calc.inputs(s.id)) {
      if (c.input.startsWith("'") && /^'\s*-?[\d,]+(\.\d+)?\s*$/.test(c.input)) add(s.id, { r0: c.r, c0: c.c, r1: c.r, c1: c.c }, 'number_as_text', `${cellName(c.r, c.c)} is a number stored as text.`, 'Remove the leading apostrophe.');
    }
    for (const m of s.merges) {
      const below = calc.cellsIn(s.id, { r0: m.r1 + 1, c0: m.c0, r1: m.r1 + 3, c1: m.c1 }).some((v) => v.k !== 0);
      const above = m.r0 > 0 && calc.cellsIn(s.id, { r0: Math.max(0, m.r0 - 3), c0: m.c0, r1: m.r0 - 1, c1: m.c1 }).some((v) => v.k !== 0);
      if (below && above) add(s.id, m, 'merged_in_data', `${rectName(m)} is merged inside a data range.`, 'Unmerge it so sorting and filtering work.');
    }
  }
  for (const n of calc.wb.namedRanges) if (!usedNames.has(n.name.toLowerCase())) add(calc.sheetList()[0]?.id ?? '', { r0: 0, c0: 0, r1: 0, c1: 0 }, 'unused_name', `The name “${n.name}” isn’t used by any formula.`);
  if (volatile > 100) add(calc.sheetList()[0]?.id ?? '', { r0: 0, c0: 0, r1: 0, c1: 0 }, 'volatile_heavy', `${volatile} formulas recalculate on every change (TODAY, NOW, RAND, OFFSET, INDIRECT).`);
  return issues.slice(0, 500);
}

// ───────────────────────────────────────────────────────────────────────────── handlers

export const handlers: MockHandlers = {
  sheet_workbook_create: (req, ctx) => {
    const title = (req.title ?? '').slice(0, 1024);
    const res = createWorkbook(ctx, { workspaceId: req.workspaceId, parentId: req.parentId, title: title || TEMPLATES[req.template ?? 'blank']?.title || 'Untitled spreadsheet', template: req.template });
    const calc = engineFor(ctx, res.page.id);
    return { page: ctx.pages.meta(res.page.id), sheets: res.sheets.map((s) => sheetMeta(calc, s)) };
  },

  sheet_workbook_get: (req, ctx) => {
    const calc = engineFor(ctx, req.id);
    return {
      sheets: sheetsOf(ctx, req.id).map((s) => sheetMeta(calc, s)),
      styles: calc.wb.styles,
      namedRanges: calc.wb.namedRanges,
      calc: calc.wb.calc,
    };
  },

  sheet_get_range: (req, ctx): SheetRange => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const rect = checkRect(req.rect);
    const area = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
    const cellsRect = area > 2_000_000 ? clampToUsed(calc, sheet.id, rect) : rect;
    const views = calc.cellsIn(sheet.id, cellsRect);
    const rowHeights: [number, number][] = Object.entries(sheet.rowHeights)
      .map(([k, v]) => [Number(k), v] as [number, number])
      .filter(([k]) => k >= rect.r0 && k <= rect.r1)
      .sort((a, b) => a[0] - b[0]);
    const colWidths: [number, number][] = Object.entries(sheet.colWidths)
      .map(([k, v]) => [Number(k), v] as [number, number])
      .filter(([k]) => k >= rect.c0 && k <= rect.c1)
      .sort((a, b) => a[0] - b[0]);
    return {
      rev: revs.get(sheet.id) ?? 1,
      cells: pack(views),
      rowHeights,
      colWidths,
      merges: sheet.merges.filter((m) => rectsIntersect(m, rect)),
      cf: calc.condFormats(sheet.id, cellsRect),
      // Extension (requested for §11.3): the sheet's conditional-format rules, so the UI can edit them.
      rules: sheet.cf,
    } as SheetRange;
  },

  sheet_get_cell: (req, ctx): SheetCellInfo => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const v = calc.cellView(sheet.id, req.row, req.col);
    const input = calc.input(sheet.id, req.row, req.col);
    const spill = calc.spillInfo(sheet.id, req.row, req.col);
    const info: SheetCellInfo = {
      input,
      display: v?.d ?? '',
      kind: v?.k ?? 0,
      styleId: calc.styleAt(sheet.id, req.row, req.col),
      precedents: formulaRefs(input).map((r) => (r.sheet ? `${quoteSheet(r.sheet)}!` : '') + rectName(r.rect)),
    };
    if (v && v.k === 4) info.error = errorHelp(v.d);
    if (spill && (spill.anchor.r !== req.row || spill.anchor.c !== req.col)) info.spillOf = cellName(spill.anchor.r, spill.anchor.c);
    return info;
  },

  sheet_set_cells: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const t0 = performance.now();
    const errors: { row: number; col: number; message: string }[] = [];
    const edits: CellEdit[] = [];
    if (req.edits.length > 200_000) throw new BackendError('TOO_LARGE', 'Too many cells in one edit');
    for (const e of req.edits) {
      if (!Number.isInteger(e.row) || !Number.isInteger(e.col) || e.row < 0 || e.col < 0 || e.row >= MAX_ROWS || e.col >= MAX_COLS) {
        errors.push({ row: e.row, col: e.col, message: 'Outside the grid' });
        continue;
      }
      try {
        const input = validateInput(e.input);
        let style: number | undefined;
        const fmt = input ? autoFormatFor(input) : undefined;
        if (fmt) {
          const cur = calc.style(calc.styleAt(sheet.id, e.row, e.col));
          if (!cur.numFmt) style = calc.intern({ ...cur, numFmt: fmt });
        }
        edits.push({ r: e.row, c: e.col, input: input === '' ? null : input, style });
      } catch (err) {
        errors.push({ row: e.row, col: e.col, message: err instanceof Error ? err.message : 'Invalid formula' });
      }
    }
    // Typing into a merged area writes to its anchor.
    for (const e of edits) {
      const m = sheet.merges.find((mm) => rectContains(mm, e.r, e.c));
      if (m && (m.r0 !== e.r || m.c0 !== e.c) && edits.length === 1) {
        e.r = m.r0;
        e.c = m.c0;
      }
    }
    const changed = applyEdits(ctx, calc, sheet, edits, edits.length === 1 ? 'Typing' : 'Edit cells', req.undoGroup);
    const out = report(calc, changed, sheet.id, req.visible ? checkRect(req.visible, 'visible') : null);
    emitChanged(ctx, sheet.workbookId, out.dirtyRects);
    const res = { rev: revs.get(sheet.id) ?? 1, changed: out.changed, dirtyRects: out.dirtyRects, recalcMs: Math.round((performance.now() - t0) * 10) / 10 };
    return errors.length ? { ...res, errors } : res;
  },

  sheet_set_style: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const styleEdits: { r: number; c: number; style: number }[] = [];
    const keys = new Set<number>();
    const memo = new Map<number, number>();
    for (const raw of req.rects) {
      const rect = clampToUsed(calc, sheet.id, checkRect(raw), 0);
      const full = raw.r1 >= MAX_ROWS - 1 || raw.c1 >= MAX_COLS - 1;
      const area = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
      if (area > 1_000_000) throw new BackendError('TOO_LARGE', 'Select fewer cells to format');
      for (let r = rect.r0; r <= rect.r1; r++)
        for (let c = rect.c0; c <= rect.c1; c++) {
          const k = cellKey(r, c);
          if (keys.has(k)) continue;
          if (full && !sheet.cells[String(k)]) continue;
          keys.add(k);
          const cur = calc.styleAt(sheet.id, r, c);
          let next = memo.get(cur);
          if (next === undefined) {
            next = calc.intern(mergeStyle(calc.style(cur), req.patch));
            memo.set(cur, next);
          }
          if (next !== cur) styleEdits.push({ r, c, style: next });
        }
    }
    const before = styleEdits.map((e) => [cellKey(e.r, e.c), recOf(sheet, cellKey(e.r, e.c))] as [number, CellRec | null]);
    const changed = calc.setStyles(sheet.id, styleEdits);
    const after = styleEdits.map((e) => [cellKey(e.r, e.c), recOf(sheet, cellKey(e.r, e.c))] as [number, CellRec | null]);
    pushUndo(ctx, sheet.workbookId, 'Format cells', [{ kind: 'cells', sheetId: sheet.id, before, after }]);
    touch(ctx, sheet);
    const views: ReturnType<typeof viewOrEmpty>[] = [];
    const set = changed.get(sheet.id);
    if (set && set.size <= 20_000) for (const k of set) views.push(viewOrEmpty(calc, sheet.id, keyRow(k), keyCol(k)));
    return { styles: calc.wb.styles, changed: pack(views) };
  },

  sheet_clear: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const edits: CellEdit[] = [];
    for (const raw of req.rects) {
      const rect = checkRect(raw);
      for (const [k, rec] of Object.entries(sheet.cells)) {
        const key = Number(k);
        const r = keyRow(key);
        const c = keyCol(key);
        if (!rectContains(rect, r, c)) continue;
        if (req.what === 'contents') {
          if (rec.i) edits.push({ r, c, input: null, style: rec.s ?? 0 });
        } else if (req.what === 'formats') edits.push({ r, c, input: rec.i || null, style: 0 });
        else edits.push({ r, c, input: null, style: 0 });
      }
    }
    const changed = applyEdits(ctx, calc, sheet, edits, req.what === 'formats' ? 'Clear formats' : 'Clear');
    if (req.what !== 'contents') {
      const mergesLeft = sheet.merges.filter((m) => !req.rects.some((r) => rectsIntersect(r, m)));
      if (req.what === 'all' && mergesLeft.length !== sheet.merges.length) sheet.merges = mergesLeft;
    }
    const out = report(calc, changed, sheet.id, null);
    emitChanged(ctx, sheet.workbookId, out.dirtyRects);
    return { changed: emptyPacked(), dirtyRects: out.dirtyRects };
  },

  sheet_insert: (req, ctx) => {
    const { sheet } = requireSheet(ctx, req.sheetId);
    if (!Number.isInteger(req.at) || req.at < 0 || !Number.isInteger(req.count) || req.count < 1 || req.count > 10_000) throw new BackendError('INVALID', 'Invalid insert');
    bookChange(ctx, sheet.workbookId, req.axis === 'rows' ? 'Insert rows' : 'Insert columns', () => {
      const calc = engineFor(ctx, sheet.workbookId);
      applyStructural(calc.wb, sheetsOf(ctx, sheet.workbookId), sheet, req.axis, req.at, req.count);
    });
    emitChanged(ctx, sheet.workbookId, [], { sheetId: sheet.id, rect: { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 } });
    return { rev: revs.get(sheet.id) ?? 1 };
  },

  sheet_delete_span: (req, ctx) => {
    const { sheet } = requireSheet(ctx, req.sheetId);
    if (!Number.isInteger(req.at) || req.at < 0 || !Number.isInteger(req.count) || req.count < 1) throw new BackendError('INVALID', 'Invalid delete');
    bookChange(ctx, sheet.workbookId, req.axis === 'rows' ? 'Delete rows' : 'Delete columns', () => {
      const calc = engineFor(ctx, sheet.workbookId);
      applyStructural(calc.wb, sheetsOf(ctx, sheet.workbookId), sheet, req.axis, req.at, -req.count);
    });
    emitChanged(ctx, sheet.workbookId, [], { sheetId: sheet.id, rect: { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 } });
    return { rev: revs.get(sheet.id) ?? 1 };
  },

  sheet_resize: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const field = req.axis === 'rows' ? 'rowHeights' : 'colWidths';
    metaChange(ctx, sheet, req.axis === 'rows' ? 'Resize rows' : 'Resize columns', [field], () => {
      const map = { ...sheet[field] };
      for (const i of req.indices.slice(0, 16_384)) {
        if (!Number.isInteger(i) || i < 0) continue;
        if (req.size === 'auto') {
          if (req.axis === 'rows') {
            delete map[String(i)];
            continue;
          }
          let max = 0;
          for (const v of calc.cellsIn(sheet.id, clampToUsed(calc, sheet.id, { r0: 0, c0: i, r1: MAX_ROWS - 1, c1: i }))) {
            const st = calc.style(v.s);
            const w = v.d.length * (st.font?.b ? 7.6 : 7.1) * ((st.font?.size ?? 13) / 13) + 20;
            if (w > max) max = w;
          }
          if (max) map[String(i)] = Math.round(Math.min(560, Math.max(40, max)));
          else delete map[String(i)];
        } else {
          const size = Math.round(Math.max(req.axis === 'rows' ? 12 : 16, Math.min(req.axis === 'rows' ? 400 : 1200, req.size)));
          map[String(i)] = size;
        }
      }
      sheet[field] = map;
    });
  },

  sheet_merge: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const rect = checkRect(req.rect);
    if ((rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) > 100_000) throw new BackendError('TOO_LARGE', 'That range is too large to merge');
    const before = structuredClone(sheet.merges);
    const clearEdits: CellEdit[] = [];
    if (req.merge) {
      for (const [k, rec] of Object.entries(sheet.cells)) {
        const key = Number(k);
        const r = keyRow(key);
        const c = keyCol(key);
        if (rectContains(rect, r, c) && (r !== rect.r0 || c !== rect.c0) && rec.i) clearEdits.push({ r, c, input: null, style: rec.s ?? 0 });
      }
    }
    sheet.merges = mergeRects(sheet.merges, rect, req.merge);
    const keys = clearEdits.map((e) => cellKey(e.r, e.c));
    const cb = keys.map((k) => [k, recOf(sheet, k)] as [number, CellRec | null]);
    if (clearEdits.length) calc.setInputs(sheet.id, clearEdits);
    else calc.rebuild();
    const ca = keys.map((k) => [k, recOf(sheet, k)] as [number, CellRec | null]);
    pushUndo(ctx, sheet.workbookId, req.merge ? 'Merge cells' : 'Unmerge cells', [
      { kind: 'meta', sheetId: sheet.id, before: { merges: before }, after: { merges: structuredClone(sheet.merges) } },
      ...(clearEdits.length ? [{ kind: 'cells' as const, sheetId: sheet.id, before: cb, after: ca }] : []),
    ]);
    touch(ctx, sheet);
  },

  sheet_freeze: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const rows = Math.max(0, Math.min(200, Math.floor(req.rows)));
    const cols = Math.max(0, Math.min(50, Math.floor(req.cols)));
    metaChange(ctx, sheet, 'Freeze panes', ['frozen'], () => {
      sheet.frozen = { rows, cols };
    });
    return sheetMeta(calc, sheet);
  },

  sheet_copy: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const rect = clampToUsed(calc, sheet.id, checkRect(req.rect));
    if ((rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) > 2_000_000) throw new BackendError('TOO_LARGE', 'Copy fewer cells');
    const rows: string[][] = [];
    const html: string[] = [];
    const cells: ClipPayload['cells'] = [];
    const views = new Map(calc.cellsIn(sheet.id, rect).map((v) => [cellKey(v.r, v.c), v]));
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row: string[] = [];
      const tds: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        const v = views.get(cellKey(r, c));
        row.push(v?.d ?? '');
        const st = calc.style(v?.s ?? 0);
        const css = [st.font?.b ? 'font-weight:bold' : '', st.font?.i ? 'font-style:italic' : '', st.fill ? `background:${st.fill}` : '', st.font?.color ? `color:${st.font.color}` : '', st.align?.h ? `text-align:${st.align.h}` : v?.k === 1 ? 'text-align:right' : '']
          .filter(Boolean)
          .join(';');
        tds.push(`<td${css ? ` style="${css}"` : ''}>${htmlEscape(v?.d ?? '')}</td>`);
        const input = calc.input(sheet.id, r, c);
        if (input || v?.s) cells.push({ r, c, i: input, s: calc.styleAt(sheet.id, r, c), d: v?.d ?? '' });
      }
      rows.push(row);
      html.push(`<tr>${tds.join('')}</tr>`);
    }
    const clip: ClipPayload = { v: 1, workbookId: sheet.workbookId, sheetId: sheet.id, rect: req.rect, cells, merges: sheet.merges.filter((m) => rectsIntersect(m, rect)) };
    return { tsv: toTSV(rows), html: `<meta charset="utf-8"><table>${html.join('')}</table>`, clip: JSON.stringify(clip) };
  },

  sheet_paste: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    let edits: CellEdit[] = [];
    let label = 'Paste';
    let clip: ClipPayload | null = null;
    if (req.clip) {
      try {
        const parsed = JSON.parse(req.clip) as ClipPayload;
        if (parsed && parsed.v === 1 && Array.isArray(parsed.cells)) clip = parsed;
      } catch {
        clip = null;
      }
    }
    if (clip) {
      // Styles come from the source workbook; another workbook's style ids are re-interned.
      if (clip.workbookId !== sheet.workbookId) {
        try {
          const src = engineFor(ctx, clip.workbookId);
          clip = { ...clip, cells: clip.cells.map((x) => ({ ...x, s: x.s ? calc.intern(src.style(x.s)) : 0 })) };
        } catch {
          clip = { ...clip, cells: clip.cells.map((x) => ({ ...x, s: 0 })) };
        }
      }
      edits = pasteClipEdits(clip, req.at, req.mode, calc, sheet.id);
      label = req.mode === 'values' ? 'Paste values' : req.mode === 'formats' ? 'Paste formatting' : 'Paste';
    } else {
      const text = req.tsv ?? '';
      if (text.length > 20_000_000) throw new BackendError('TOO_LARGE', 'The clipboard is too large to paste');
      const delim = text.includes('\t') || !text.includes(',') ? '\t' : sniffDelimiter(text);
      const rows = parseDelimited(text, delim);
      edits = pasteTextEdits(rows, req.at, calc, sheet.id).map((e) => {
        if (!e.input) return e;
        try {
          validateInput(e.input);
        } catch {
          return { ...e, input: `'${e.input}` };
        }
        const fmt = autoFormatFor(e.input);
        if (fmt && !calc.style(e.style ?? 0).numFmt) return { ...e, style: calc.intern({ ...calc.style(e.style ?? 0), numFmt: fmt }) };
        return e;
      });
    }
    const changed = applyEdits(ctx, calc, sheet, edits, label);
    if (clip && req.mode === 'all' && clip.merges.length) {
      const dr = req.at.row - clip.rect.r0;
      const dc = req.at.col - clip.rect.c0;
      for (const m of clip.merges) sheet.merges = mergeRects(sheet.merges, { r0: m.r0 + dr, c0: m.c0 + dc, r1: m.r1 + dr, c1: m.c1 + dc }, true);
    }
    const out = report(calc, changed, sheet.id, req.visible ? checkRect(req.visible, 'visible') : null);
    emitChanged(ctx, sheet.workbookId, out.dirtyRects);
    return out;
  },

  sheet_fill: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const source = checkRect(req.source, 'source');
    const target = checkRect(req.target, 'target');
    if ((target.r1 - target.r0 + 1) * (target.c1 - target.c0 + 1) > 1_000_000) throw new BackendError('TOO_LARGE', 'Fill a smaller range');
    const edits = fillEdits(calc, sheet.id, source, target, req.mode);
    const changed = applyEdits(ctx, calc, sheet, edits, 'Fill');
    const out = report(calc, changed, sheet.id, target);
    emitChanged(ctx, sheet.workbookId, out.dirtyRects);
    return { changed: out.changed };
  },

  sheet_sort: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const rect = clampToUsed(calc, sheet.id, checkRect(req.rect));
    if (!req.keys.length) throw new BackendError('INVALID', 'Choose a column to sort by', { field: 'keys' });
    const edits = sortEdits(calc, sheet.id, rect, req.keys, req.hasHeader);
    const changed = applyEdits(ctx, calc, sheet, edits, 'Sort');
    const out = report(calc, changed, sheet.id, rect);
    emitChanged(ctx, sheet.workbookId, out.dirtyRects);
    return { changed: out.changed };
  },

  sheet_find: (req, ctx) => {
    const calc = engineFor(ctx, req.workbookId);
    const q = req.query.slice(0, 512);
    if (!q) return [];
    const needle = req.matchCase ? q : q.toLowerCase();
    const out: { sheetId: Id; row: number; col: number }[] = [];
    for (const s of calc.sheetList()) {
      const hits: { row: number; col: number }[] = [];
      const ext = calc.extent(s.id);
      if (ext.r < 0) continue;
      for (const v of calc.cellsIn(s.id, { r0: 0, c0: 0, r1: ext.r, c1: ext.c })) {
        const hay0 = req.inFormulas ? calc.input(s.id, v.r, v.c) || v.d : v.d;
        const hay = req.matchCase ? hay0 : hay0.toLowerCase();
        if (req.wholeCell ? hay === needle : hay.includes(needle)) hits.push({ row: v.r, col: v.c });
      }
      hits.sort((a, b) => a.row - b.row || a.col - b.col);
      for (const h of hits) out.push({ sheetId: s.id, ...h });
      if (out.length > 10_000) break;
    }
    return out.slice(0, 10_000);
  },

  sheet_replace: (req, ctx) => {
    const calc = engineFor(ctx, req.workbookId);
    if (!req.query) return { count: 0 };
    let count = 0;
    const flags = req.matchCase ? 'g' : 'gi';
    const re = new RegExp(req.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    for (const s of calc.sheetList()) {
      const edits: CellEdit[] = [];
      for (const c of calc.inputs(s.id)) {
        if (!c.input) continue;
        const hay = req.matchCase ? c.input : c.input.toLowerCase();
        const needle = req.matchCase ? req.query : req.query.toLowerCase();
        if (req.wholeCell ? hay !== needle : !hay.includes(needle)) continue;
        const next = req.wholeCell ? req.replacement : c.input.replace(re, () => req.replacement);
        try {
          validateInput(next);
        } catch {
          continue;
        }
        edits.push({ r: c.r, c: c.c, input: next || null, style: c.style });
        count += req.wholeCell ? 1 : (c.input.match(re) ?? []).length;
      }
      if (edits.length) {
        const changed = applyEdits(ctx, calc, s, edits, 'Replace');
        const out = report(calc, changed, s.id, null);
        emitChanged(ctx, s.workbookId, out.dirtyRects);
      }
    }
    return { count };
  },

  sheet_add: (req, ctx) => {
    const calc = engineFor(ctx, req.workbookId);
    const sheets = sheetsOf(ctx, req.workbookId);
    const name = uniqueSheetName(sheets, req.name ? sanitizeSheetName(req.name) : `Sheet${sheets.length + 1}`);
    const idx = req.afterId ? sheets.findIndex((s) => s.id === req.afterId) : sheets.length - 1;
    const prev = sheets[idx]?.sortKey ?? null;
    const next = sheets[idx + 1]?.sortKey ?? null;
    const data: SheetData = { id: ctx.id(), workbookId: req.workbookId, name, hidden: false, frozen: { rows: 0, cols: 0 }, sortKey: ctx.keyBetween(prev, next), cells: {}, colWidths: {}, rowHeights: {}, merges: [], cf: [] };
    shTable(ctx).insert(data);
    calc.syncSheets(sheetsOf(ctx, req.workbookId));
    touch(ctx, data);
    return sheetMeta(calc, data);
  },

  sheet_update: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.id);
    const sheets = sheetsOf(ctx, sheet.workbookId);
    if (req.patch.name !== undefined && req.patch.name !== sheet.name) {
      const name = sanitizeSheetName(req.patch.name);
      if (sheets.some((s) => s.id !== sheet.id && s.name.toLowerCase() === name.toLowerCase())) throw new BackendError('CONFLICT', `There’s already a sheet called “${name}”`, { field: 'name' });
      const old = sheet.name;
      for (const s of sheets) for (const rec of Object.values(s.cells)) if (isFormula(rec.i)) rec.i = renameSheetRefs(rec.i, old, name);
      for (const s of sheets) for (const rule of s.cf) if (rule.formula) rule.formula = renameSheetRefs(rule.formula.startsWith('=') ? rule.formula : `=${rule.formula}`, old, name);
      calc.wb.namedRanges = calc.wb.namedRanges.map((n) => ({ ...n, ref: renameSheetRefs(`=${n.ref.replace(/^=/, '')}`, old, name).slice(1) }));
      sheet.name = name;
      calc.syncSheets(sheetsOf(ctx, sheet.workbookId));
    }
    if (req.patch.color !== undefined) {
      if (req.patch.color === null) delete sheet.color;
      else sheet.color = req.patch.color;
    }
    if (req.patch.hidden !== undefined) {
      if (req.patch.hidden && sheets.filter((s) => !s.hidden && s.id !== sheet.id).length === 0) throw new BackendError('INVALID', 'A workbook needs at least one visible sheet');
      sheet.hidden = req.patch.hidden;
    }
    touch(ctx, sheet);
    return sheetMeta(calc, sheet);
  },

  sheet_remove: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.id);
    const sheets = sheetsOf(ctx, sheet.workbookId);
    if (sheets.length <= 1) throw new BackendError('INVALID', 'A workbook needs at least one sheet');
    for (const s of sheets) if (s.id !== sheet.id) for (const rec of Object.values(s.cells)) if (isFormula(rec.i)) rec.i = breakSheetRefs(rec.i, sheet.name);
    calc.wb.namedRanges = calc.wb.namedRanges.filter((n) => (splitSheetRef(n.ref).sheet ?? '').toLowerCase() !== sheet.name.toLowerCase());
    shTable(ctx).delete(sheet.id);
    revs.delete(sheet.id);
    calc.syncSheets(sheetsOf(ctx, sheet.workbookId));
    // Undo history may reference the removed sheet; keep entries for the others.
    const st = stacks(sheet.workbookId);
    st.past = st.past.filter((g) => !g.entries.some((e) => e.kind !== 'book' && e.sheetId === sheet.id) && !g.entries.some((e) => e.kind === 'book'));
    st.future = [];
    if (ctx.pages.get(sheet.workbookId)) ctx.pages.touch(sheet.workbookId);
    emitChanged(ctx, sheet.workbookId, sheetsOf(ctx, sheet.workbookId).map((s) => ({ sheetId: s.id, rect: { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 } })));
  },

  sheet_reorder: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.id);
    const others = sheetsOf(ctx, sheet.workbookId).filter((s) => s.id !== sheet.id);
    let prev: string | null = null;
    let next: string | null = null;
    if (req.beforeId) {
      const i = others.findIndex((s) => s.id === req.beforeId);
      next = others[i]?.sortKey ?? null;
      prev = i > 0 ? others[i - 1].sortKey : null;
    } else if (req.afterId) {
      const i = others.findIndex((s) => s.id === req.afterId);
      prev = others[i]?.sortKey ?? null;
      next = others[i + 1]?.sortKey ?? null;
    } else prev = others[others.length - 1]?.sortKey ?? null;
    sheet.sortKey = ctx.keyBetween(prev, next);
    calc.syncSheets(sheetsOf(ctx, sheet.workbookId));
    touch(ctx, sheet);
    return sheetMeta(calc, sheet);
  },

  sheet_named_range_set: (req, ctx) => {
    const calc = engineFor(ctx, req.workbookId);
    const name = req.name.trim();
    if (!/^[A-Za-z_\\][A-Za-z0-9_.]{0,254}$/.test(name) || /^[A-Za-z]{1,3}\d+$/.test(name) || /^(TRUE|FALSE)$/i.test(name)) throw new BackendError('INVALID', 'Names start with a letter and can’t look like a cell reference', { field: 'name' });
    const rest = calc.wb.namedRanges.filter((n) => n.name.toLowerCase() !== name.toLowerCase());
    if (req.ref !== null) {
      const { sheet, ref } = splitSheetRef(req.ref.replace(/^=/, ''));
      if (!parseRect(ref.replace(/\$/g, '')) || (sheet && !calc.sheetByName(sheet))) throw new BackendError('INVALID', 'That isn’t a valid range', { field: 'ref' });
      rest.push({ name, ref: req.ref.replace(/^=/, '') });
    }
    calc.wb.namedRanges = rest;
    calc.rebuild();
    for (const s of sheetsOf(ctx, req.workbookId)) touch(ctx, s);
  },

  sheet_cond_format_set: (req, ctx) => {
    const { sheet, calc } = requireSheet(ctx, req.sheetId);
    const rules: CondFormatRule[] = req.rules.slice(0, 200).map((r, i) => {
      const rect = checkRect(r.rect);
      if (r.kind === 'formula' && r.formula) {
        try {
          parseFormula(r.formula.startsWith('=') ? r.formula : `=${r.formula}`);
        } catch (e) {
          throw new BackendError('INVALID', e instanceof Error ? e.message : 'Invalid formula', { field: `rules.${i}.formula` });
        }
      }
      if (r.styleId !== undefined && !calc.wb.styles[r.styleId] && r.styleId !== 0) throw new BackendError('INVALID', 'Unknown style', { field: `rules.${i}.styleId` });
      // Highlight rules may describe their look inline: colors = [fill, text colour] (interned to a style).
      let styleId = r.styleId;
      if (styleId === undefined && (r.kind === 'cell' || r.kind === 'formula') && r.colors?.length) {
        const [fill, text] = r.colors;
        styleId = calc.intern({ ...(fill ? { fill } : {}), font: { ...(text ? { color: text } : {}), b: true } });
      }
      return { ...r, rect, id: r.id ?? ctx.id(), ...(styleId !== undefined ? { styleId } : {}) };
    });
    metaChange(ctx, sheet, 'Conditional formatting', ['cf'], () => {
      sheet.cf = rules;
    });
    emitChanged(ctx, sheet.workbookId, [], { sheetId: sheet.id, rect: { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 } });
    void calc;
  },

  sheet_undo: (req, ctx) => {
    engineFor(ctx, req.workbookId);
    const s = stacks(req.workbookId);
    const g = s.past.pop();
    if (!g) return { changedSheets: [] };
    s.future.push(g);
    const changedSheets = applyUndo(ctx, req.workbookId, g.entries, 'before');
    emitChanged(ctx, req.workbookId, changedSheets.map((id) => ({ sheetId: id, rect: { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 } })));
    return { changedSheets };
  },

  sheet_redo: (req, ctx) => {
    engineFor(ctx, req.workbookId);
    const s = stacks(req.workbookId);
    const g = s.future.pop();
    if (!g) return { changedSheets: [] };
    s.past.push(g);
    const changedSheets = applyUndo(ctx, req.workbookId, g.entries, 'after');
    emitChanged(ctx, req.workbookId, changedSheets.map((id) => ({ sheetId: id, rect: { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 } })));
    return { changedSheets };
  },

  sheet_eval: (req, ctx) => {
    if (req.formula.length > MAX_FORMULA) throw new BackendError('INVALID', 'Formulas are limited to 8,192 characters', { field: 'formula' });
    const workbookId = req.workbookId ?? (req.sheetId ? shTable(ctx).get(req.sheetId)?.workbookId : undefined);
    if (!workbookId) {
      const r = evalScalar(req.formula, { now: () => ctx.clock.now(), rand: () => ctx.rng.next() });
      return { display: r.display, value: toPlain(r.value), ...(r.error ? { error: r.error } : {}) };
    }
    const calc = engineFor(ctx, workbookId);
    try {
      const v = calc.evalFormula(req.sheetId ?? null, req.formula);
      const s = isArr(v) ? scalar(v) : v;
      const disp = formatScalar(s, undefined).text;
      return { display: disp, value: toPlain(v), ...(isErr(s) ? { error: s.code } : {}) };
    } catch (e) {
      return { display: '', value: null, error: e instanceof Error ? e.message : 'Invalid formula' };
    }
  },

  sheet_functions: () => functionDocs(),

  sheet_lint: (req, ctx) => lint(ctx, req.workbookId),

  sheet_import_file: async (req, ctx: MockCallCtx) => {
    const file = ctx.grants.read(req.grantId);
    if (req.asDatabase) throw new BackendError('UNSUPPORTED', 'Use “Import CSV as database” for databases');
    if (file.size > 50 * 1024 * 1024) throw new BackendError('TOO_LARGE', 'Files over 50 MB can’t be imported in the browser preview');
    ctx.progress(0, 3, 'Reading file');
    const name = file.name.replace(/\.[^.]+$/, '') || 'Imported workbook';
    const lower = file.name.toLowerCase();
    const warnings: string[] = [];
    let build: (b: BookBuilder) => void;
    if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
      const text = await file.text();
      const delim = lower.endsWith('.tsv') ? '\t' : sniffDelimiter(text);
      const rows = parseDelimited(text, delim);
      ctx.checkCancelled();
      ctx.progress(1, 3, 'Building sheet');
      build = (b) => {
        const sh = b.sheet(name.slice(0, 31));
        rows.forEach((row, r) =>
          row.forEach((v, c) => {
            if (v === '' || c >= MAX_COLS) return;
            const fmt = autoFormatFor(v);
            const input = isFormula(v) ? `'${v}` : v;
            sh.at(r, c, input, r === 0 ? { font: { b: true } } : fmt ? { numFmt: fmt } : undefined);
          }),
        );
        if (rows.length > 1) sh.freeze(1, 0);
      };
      if (delim !== ',') warnings.push(`Columns were separated by “${delim === '\t' ? 'tab' : delim}”.`);
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let book;
      try {
        book = await readXlsx(bytes, (d, t) => ctx.progress(1 + d / Math.max(1, t), 3, 'Reading sheets'));
      } catch (e) {
        throw new BackendError('INVALID', e instanceof Error ? e.message : 'This file couldn’t be read');
      }
      ctx.checkCancelled();
      warnings.push(...book.warnings);
      const known = new Set(functionDocs().map((f) => f.name));
      const unknown = new Set<string>();
      build = (b) => {
        for (const n of book.names) b.name(n.name, n.ref);
        for (const xs of book.sheets) {
          const sh = b.sheet(xs.name);
          sh.data.hidden = xs.hidden;
          sh.data.frozen = xs.frozen;
          sh.data.merges = xs.merges;
          for (const [c, w] of xs.colWidths) sh.data.colWidths[String(c)] = w;
          for (const [r, h] of xs.rowHeights) sh.data.rowHeights[String(r)] = h;
          for (const [k, cell] of xs.cells) {
            const st: CellStyle = {};
            if (cell.style?.numFmt) st.numFmt = cell.style.numFmt;
            if (cell.style?.bold || cell.style?.italic || cell.style?.color) st.font = { b: cell.style.bold, i: cell.style.italic, color: cell.style.color };
            if (cell.style?.fill) st.fill = cell.style.fill;
            if (cell.style?.align) st.align = { h: cell.style.align };
            if (isFormula(cell.input)) for (const t of tokenize(cell.input)) if (t.t === 'func' && !known.has(t.v.toUpperCase().replace(/^_XLFN\./, ''))) unknown.add(t.v.toUpperCase());
            sh.at(keyRow(k), keyCol(k), cell.input, Object.keys(st).length ? st : undefined);
          }
        }
        if (!b.sheets.length) b.sheet('Sheet1');
      };
      if (unknown.size) warnings.push(`${unknown.size} function${unknown.size === 1 ? '' : 's'} aren’t supported yet and show #NAME?: ${[...unknown].slice(0, 6).join(', ')}.`);
    }
    ctx.progress(2, 3, 'Calculating');
    const res = createWorkbook(ctx, { workspaceId: req.workspaceId, parentId: req.parentId, title: name, build, icon: { t: 'lucide', v: 'sheet', color: 'green' } });
    engineFor(ctx, res.page.id);
    ctx.progress(3, 3, 'Done');
    return { page: ctx.pages.meta(res.page.id), warnings };
  },

  sheet_export: async (req, ctx: MockCallCtx) => {
    const calc = engineFor(ctx, req.workbookId);
    const sheets = calc.sheetList();
    ctx.progress(0, sheets.length + 1, 'Preparing');
    if (req.format === 'csv') {
      const sheet = (req.sheetId ? sheets.find((s) => s.id === req.sheetId) : undefined) ?? sheets.find((s) => s.id === lastSheetOf.get(req.workbookId)) ?? sheets.find((s) => !s.hidden) ?? sheets[0];
      if (!sheet) throw new BackendError('NOT_FOUND', 'Sheet not found');
      const ext = calc.extent(sheet.id);
      const rows: string[][] = [];
      if (ext.r >= 0) {
        const views = new Map(calc.cellsIn(sheet.id, { r0: 0, c0: 0, r1: ext.r, c1: ext.c }).map((v) => [cellKey(v.r, v.c), v.d]));
        for (let r = 0; r <= ext.r; r++) {
          const row: string[] = [];
          for (let c = 0; c <= ext.c; c++) row.push(views.get(cellKey(r, c)) ?? '');
          rows.push(row);
        }
      }
      const csv = rows.map((row) => row.map((v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
      const bytes = ctx.grants.write(req.grantId, `﻿${csv}`, 'text/csv;charset=utf-8');
      ctx.progress(1, 1, 'Done');
      return { bytes };
    }
    const out: XlsxWriteSheet[] = [];
    sheets.forEach((s, i) => {
      ctx.checkCancelled();
      const cells: XlsxWriteSheet['cells'] = [];
      for (const c of calc.inputs(s.id)) {
        const v = calc.value(s.id, c.r, c.c);
        const st = calc.style(c.style);
        cells.push({ r: c.r, c: c.c, input: c.input, value: isErr(v) ? v.code : (v as number | string | boolean | null), isError: isErr(v), style: styleToXlsx(st) });
      }
      out.push({
        name: s.name,
        hidden: s.hidden,
        cells,
        colWidths: Object.entries(s.colWidths).map(([k, w]) => [Number(k), w] as [number, number]),
        rowHeights: Object.entries(s.rowHeights).map(([k, h]) => [Number(k), h] as [number, number]),
        merges: s.merges,
        frozen: s.frozen,
      });
      ctx.progress(i + 1, sheets.length + 1, `Writing ${s.name}`);
    });
    const data = writeXlsx(out, calc.wb.namedRanges);
    const bytes = ctx.grants.write(req.grantId, new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    ctx.progress(sheets.length + 1, sheets.length + 1, 'Done');
    return { bytes };
  },
};

function errorHelp(code: string): string {
  switch (code) {
    case '#DIV/0!': return 'The formula divides by zero or by an empty cell.';
    case '#VALUE!': return 'A value has the wrong type — for example text where a number is needed.';
    case '#REF!': return 'The formula refers to cells that were deleted.';
    case '#NAME?': return 'The formula uses a name or function Ultranote doesn’t recognise.';
    case '#NUM!': return 'The result isn’t a valid number.';
    case '#N/A': return 'A lookup didn’t find a match.';
    case '#SPILL!': return 'The result needs more room — clear the cells it would spill into.';
    case '#CIRC!': return 'The formula refers to itself through a circular reference.';
    case '#CALC!': return 'The calculation returned an empty array.';
    default: return 'The formula returned an error.';
  }
}

// ───────────────────────────────────────────────────────────────────────────── lifecycle hooks

export function setup(ctx: MockCtx): void {
  undoStacks.clear();
  revs.clear();
  // Duplicated pages get their own copy of the workbook.
  ctx.events.on('page:duplicated', ({ map }) => {
    for (const [src, dst] of Object.entries(map)) {
      const wb = wbTable(ctx).get(src);
      if (!wb) continue;
      const copy: WorkbookData = structuredClone({ ...wb, id: dst });
      wbTable(ctx).put(copy);
      for (const s of sheetsOf(ctx, src)) shTable(ctx).put({ ...structuredClone(s), id: ctx.id(), workbookId: dst });
    }
  });
  ctx.events.on('page:purged', ({ ids }) => {
    for (const id of ids) {
      if (!wbTable(ctx).get(id)) continue;
      shTable(ctx).deleteWhere((s) => s.workbookId === id);
      wbTable(ctx).delete(id);
      undoStacks.delete(id);
    }
  });
}

/** Exposed for seeds. */
export const sheetSeedApi = { createWorkbook, sheetPrefixText };
