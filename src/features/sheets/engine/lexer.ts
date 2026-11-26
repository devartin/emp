/**
 * Formula tokenizer (§14.1). Lossless: concatenating every token's text gives back the input, so the same tokens
 * drive the parser, reference rewriting (fill / paste / insert / rename) and the cell editor's syntax colouring.
 */
import type { Rect } from '@/backend/types';
import { colIndex, MAX_COLS, MAX_ROWS } from './addr';

export type TokType =
  | 'num' | 'str' | 'bool' | 'err' | 'ref' | 'func' | 'name' | 'op' | 'lp' | 'rp' | 'comma' | 'semi' | 'lbrace' | 'rbrace' | 'ws' | 'bad';

export interface RefInfo {
  /** Sheet name as written (unquoted), when the reference carries a prefix. */
  sheet?: string;
  kind: 'cell' | 'range' | 'cols' | 'rows';
  rect: Rect;
  /** `$` flags per edge. */
  abs: { r0: boolean; c0: boolean; r1: boolean; c1: boolean };
}

export interface Token {
  t: TokType;
  /** Source text. */
  v: string;
  /** Byte offsets [s, e). */
  s: number;
  e: number;
  ref?: RefInfo;
}

export const ERROR_LITERALS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#SPILL!', '#CALC!', '#CIRC!', '#FETCH', '#GETTING_DATA'];

const SHEET = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*)!`;
const CELLP = String.raw`(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})`;
const REF_RE = new RegExp(
  String.raw`(${SHEET})?(?:${CELLP}(?::${CELLP})?|(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})|(\$?)([0-9]{1,7}):(\$?)([0-9]{1,7}))`,
  'y',
);
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_\\À-￿][A-Za-z0-9_.À-￿]*/y;
const IDENT_CHAR = /[A-Za-z0-9_.(À-￿]/;

function unquoteSheet(raw: string): string {
  const s = raw.slice(0, -1); // drop '!'
  return s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
}

function tryRef(src: string, i: number): Token | null {
  REF_RE.lastIndex = i;
  const m = REF_RE.exec(src);
  if (!m) return null;
  const end = i + m[0].length;
  const next = src[end];
  if (next && IDENT_CHAR.test(next)) return null; // e.g. LOG10( or A1B
  if (next === '!') return null;
  const sheet = m[1] ? unquoteSheet(m[1]) : undefined;
  if (m[3] !== undefined) {
    // cell or cell:cell
    const c0 = colIndex(m[3]);
    const r0 = Number(m[5]) - 1;
    if (c0 < 0 || r0 < 0 || r0 >= MAX_ROWS) return null;
    if (m[7] !== undefined) {
      const c1 = colIndex(m[7]);
      const r1 = Number(m[9]) - 1;
      if (c1 < 0 || r1 < 0 || r1 >= MAX_ROWS) return null;
      const abs = { r0: !!m[4], c0: !!m[2], r1: !!m[8], c1: !!m[6] };
      return {
        t: 'ref',
        v: m[0],
        s: i,
        e: end,
        ref: { sheet, kind: 'range', rect: { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) }, abs },
      };
    }
    return { t: 'ref', v: m[0], s: i, e: end, ref: { sheet, kind: 'cell', rect: { r0, c0, r1: r0, c1: c0 }, abs: { r0: !!m[4], c0: !!m[2], r1: !!m[4], c1: !!m[2] } } };
  }
  if (m[11] !== undefined) {
    const c0 = colIndex(m[11]);
    const c1 = colIndex(m[13]);
    if (c0 < 0 || c1 < 0) return null;
    return {
      t: 'ref',
      v: m[0],
      s: i,
      e: end,
      ref: { sheet, kind: 'cols', rect: { r0: 0, r1: MAX_ROWS - 1, c0: Math.min(c0, c1), c1: Math.max(c0, c1) }, abs: { r0: false, r1: false, c0: !!m[10], c1: !!m[12] } },
    };
  }
  if (m[15] !== undefined) {
    const r0 = Number(m[15]) - 1;
    const r1 = Number(m[17]) - 1;
    if (r0 < 0 || r1 < 0 || r0 >= MAX_ROWS || r1 >= MAX_ROWS) return null;
    return {
      t: 'ref',
      v: m[0],
      s: i,
      e: end,
      ref: { sheet, kind: 'rows', rect: { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: 0, c1: MAX_COLS - 1 }, abs: { r0: !!m[14], r1: !!m[16], c0: false, c1: false } },
    };
  }
  return null;
}

/** Tokenizes formula text. A leading '=' (if any) comes back as an 'op' token. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      out.push({ t: 'ws', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      const closed = j < n;
      const e = closed ? j + 1 : n;
      out.push({ t: closed ? 'str' : 'bad', v: src.slice(i, e), s: i, e });
      i = e;
      continue;
    }
    if (ch === '#') {
      const up = src.slice(i).toUpperCase();
      const lit = ERROR_LITERALS.find((x) => up.startsWith(x));
      if (lit) {
        out.push({ t: 'err', v: src.slice(i, i + lit.length), s: i, e: i + lit.length });
        i += lit.length;
        continue;
      }
    }
    if (ch === "'" || ch === '$' || /[A-Za-z0-9_À-￿]/.test(ch)) {
      const ref = tryRef(src, i);
      if (ref) {
        out.push(ref);
        i = ref.e;
        continue;
      }
    }
    if (/[0-9.]/.test(ch)) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      if (m && m[0].length) {
        out.push({ t: 'num', v: m[0], s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_\\À-￿]/.test(ch)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(src);
      if (m) {
        const e = i + m[0].length;
        const up = m[0].toUpperCase();
        if (src[e] === '(') out.push({ t: 'func', v: m[0], s: i, e });
        else if (up === 'TRUE' || up === 'FALSE') out.push({ t: 'bool', v: m[0], s: i, e });
        else out.push({ t: 'name', v: m[0], s: i, e });
        i = e;
        continue;
      }
    }
    if (ch === "'") {
      // An unterminated / invalid quoted sheet reference.
      const j = src.indexOf("'", i + 1);
      const e = j < 0 ? n : j + 1;
      out.push({ t: 'bad', v: src.slice(i, e), s: i, e });
      i = e;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two, s: i, e: i + 2 });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>%'.includes(ch)) {
      out.push({ t: 'op', v: ch, s: i, e: i + 1 });
      i++;
      continue;
    }
    const simple: Record<string, TokType> = { '(': 'lp', ')': 'rp', ',': 'comma', ';': 'semi', '{': 'lbrace', '}': 'rbrace' };
    if (simple[ch]) {
      out.push({ t: simple[ch], v: ch, s: i, e: i + 1 });
      i++;
      continue;
    }
    out.push({ t: 'bad', v: ch, s: i, e: i + 1 });
    i++;
  }
  return out;
}

/** Formats a reference edge-by-edge, keeping `$` flags. */
export function formatRef(info: RefInfo, sheetText?: string): string {
  const { rect, abs } = info;
  const col = (c: number, a: boolean) => `${a ? '$' : ''}${colLetters(c)}`;
  const row = (r: number, a: boolean) => `${a ? '$' : ''}${r + 1}`;
  let body: string;
  if (info.kind === 'cell') body = `${col(rect.c0, abs.c0)}${row(rect.r0, abs.r0)}`;
  else if (info.kind === 'range') body = `${col(rect.c0, abs.c0)}${row(rect.r0, abs.r0)}:${col(rect.c1, abs.c1)}${row(rect.r1, abs.r1)}`;
  else if (info.kind === 'cols') body = `${col(rect.c0, abs.c0)}:${col(rect.c1, abs.c1)}`;
  else body = `${row(rect.r0, abs.r0)}:${row(rect.r1, abs.r1)}`;
  return sheetText ? `${sheetText}!${body}` : body;
}

function colLetters(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The raw sheet-prefix text of a ref token ("'My Sheet'" or "Sheet2"), if any. */
export function sheetPrefixText(tok: Token): string | undefined {
  const bang = tok.v.lastIndexOf('!');
  return bang < 0 ? undefined : tok.v.slice(0, bang);
}

export const MAX_COL_INDEX = MAX_COLS - 1;
