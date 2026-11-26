/**
 * Value model (§14.1): Empty | Number | Text | Bool | Error | Array, with Excel coercion rules
 * ("1"+1 = 2, TRUE+1 = 2, case-insensitive text comparison, number < text < bool).
 */

export type ErrCode = '#NULL!' | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A' | '#SPILL!' | '#CALC!' | '#CIRC!' | '#FETCH';

export class Err {
  readonly code: ErrCode;
  readonly message?: string;
  constructor(code: ErrCode, message?: string) {
    this.code = code;
    this.message = message;
  }
  toString(): string {
    return this.code;
  }
}

export const ERR = {
  div0: new Err('#DIV/0!'),
  value: new Err('#VALUE!'),
  ref: new Err('#REF!'),
  name: new Err('#NAME?'),
  num: new Err('#NUM!'),
  na: new Err('#N/A'),
  spill: new Err('#SPILL!'),
  calc: new Err('#CALC!'),
  circ: new Err('#CIRC!'),
  null: new Err('#NULL!'),
} as const;

export type Scalar = number | string | boolean | null | Err;

/** A rectangular array (range values or array results). Row-major. */
export class Arr {
  readonly rows: number;
  readonly cols: number;
  readonly v: Scalar[];
  /** Set when the array came straight from a reference (ROW, COLUMN, OFFSET, ISREF need it). */
  origin?: { sheetId: string; rect: { r0: number; c0: number; r1: number; c1: number } };
  constructor(rows: number, cols: number, v: Scalar[]) {
    this.rows = rows;
    this.cols = cols;
    this.v = v;
  }
  get(r: number, c: number): Scalar {
    // Broadcast single rows / columns (Excel array semantics).
    const rr = this.rows === 1 ? 0 : r;
    const cc = this.cols === 1 ? 0 : c;
    if (rr >= this.rows || cc >= this.cols) return ERR.na;
    return this.v[rr * this.cols + cc];
  }
  static of(rows: Scalar[][]): Arr {
    const cols = rows[0]?.length ?? 0;
    return new Arr(rows.length, cols, rows.flat());
  }
  static col(values: Scalar[]): Arr {
    return new Arr(values.length, 1, values);
  }
  static row(values: Scalar[]): Arr {
    return new Arr(1, values.length, values);
  }
  map(fn: (v: Scalar) => Scalar): Arr {
    return new Arr(this.rows, this.cols, this.v.map(fn));
  }
}

export type V = Scalar | Arr;

export const isErr = (v: unknown): v is Err => v instanceof Err;
export const isArr = (v: unknown): v is Arr => v instanceof Arr;

/** Display precision (15 significant digits). */
export function round15(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  return Number.parseFloat(n.toPrecision(15));
}

/** Number → text the way Excel's General format concatenates it. */
export function numToText(n: number): string {
  const r = round15(n);
  if (Object.is(r, -0)) return '0';
  const abs = Math.abs(r);
  if (abs !== 0 && (abs >= 1e21 || abs < 1e-9)) {
    const [m, e] = r.toExponential().split('e');
    const exp = Number(e);
    return `${m.replace(/\.?0+$/, '')}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return String(r);
}

const NUM_TEXT_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Parses a number typed or stored as text: "1,234.5", "$12", "(40)", "12%", "1e3". Null when it isn't one. */
export function parseNumberText(raw: string): { n: number; kind?: 'currency' | 'percent' | 'number'; symbol?: string; decimals: number; grouped: boolean } | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('−')) s = `-${s.slice(1)}`;
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) s = s.slice(1).trim();
  let kind: 'currency' | 'percent' | 'number' | undefined;
  let symbol: string | undefined;
  const cur = /^([$€£¥])\s?/.exec(s);
  if (cur) {
    kind = 'currency';
    symbol = cur[1];
    s = s.slice(cur[0].length);
    if (s.startsWith('-')) {
      neg = !neg;
      s = s.slice(1);
    }
  }
  let pct = false;
  if (s.endsWith('%')) {
    pct = true;
    kind = 'percent';
    s = s.slice(0, -1).trim();
  }
  if (!s || !NUM_TEXT_RE.test(s) || s === '.') return null;
  const grouped = s.includes(',');
  const n0 = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n0)) return null;
  const dot = s.indexOf('.');
  const decimals = dot < 0 || /e/i.test(s) ? 0 : s.length - dot - 1;
  let n = pct ? n0 / 100 : n0;
  if (neg) n = -n;
  return { n, kind: kind ?? (grouped ? 'number' : undefined), symbol, decimals, grouped };
}

export function toNum(v: Scalar): number | Err {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Err) return v;
  const p = parseNumberText(v);
  if (p) return p.n;
  const d = parseDateText(v);
  if (d !== null) return d;
  return ERR.value;
}

export function toStr(v: Scalar): string | Err {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  if (typeof v === 'number') return numToText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

export function toBool(v: Scalar): boolean | Err {
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof Err) return v;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return ERR.value;
}

const typeRank = (v: Scalar): number => (typeof v === 'number' || v === null ? 0 : typeof v === 'string' ? 1 : 2);

/** Excel comparison: −1 / 0 / 1. Empty compares as 0 or "" depending on the other side. */
export function compare(a: Scalar, b: Scalar): number {
  if (a === null && typeof b === 'string') a = '';
  if (b === null && typeof a === 'string') b = '';
  if (a === null && typeof b === 'boolean') a = false;
  if (b === null && typeof a === 'boolean') b = false;
  if (a === null) a = 0;
  if (b === null) b = 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') {
    const x = round15(a);
    const y = round15(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a === b ? 0 : a ? 1 : -1;
}

// ───────────────────────────────────────────────────────────────────────────── dates (1900 system)

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

/** Serial number for a calendar date, with Excel's 1900 leap-year bug preserved. */
export function dateToSerial(y: number, m: number, d: number): number {
  const ms = Date.UTC(y, m - 1, d);
  let serial = Math.round((ms - EPOCH) / DAY_MS);
  if (serial < 61) serial -= 1; // before 1900-03-01: Excel counts a fictitious 1900-02-29
  return serial;
}

export function serialToDate(serial: number): { y: number; m: number; d: number; ms: number } {
  let s = Math.floor(serial);
  if (s === 60) return { y: 1900, m: 2, d: 29, ms: 0 };
  if (s < 60) s += 1;
  const ms = EPOCH + s * DAY_MS;
  const dt = new Date(ms);
  const frac = serial - Math.floor(serial);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), ms: Math.round(frac * DAY_MS) };
}

export function msToSerial(ms: number, tzOffsetMin = 0): number {
  const local = ms - tzOffsetMin * 60_000;
  const days = Math.floor((local - EPOCH) / DAY_MS);
  const frac = (local - EPOCH) / DAY_MS - days;
  return (days < 61 ? days - 1 : days) + frac;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** ISO dates ("2026-01-31"), "31 Jan 2026", "Jan 31, 2026" and "1/31/2026" → serial. */
export function parseDateText(raw: string): number | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let serial = dateToSerial(y, mo, d);
    if (m[4]) serial += (+m[4] * 3600 + +m[5] * 60 + (m[6] ? +m[6] : 0)) / 86400;
    return serial;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mo = +m[1];
    const d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return dateToSerial(+m[3], mo, d);
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mo < 0) return null;
    return dateToSerial(+m[3], mo + 1, +m[1]);
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mo < 0) return null;
    return dateToSerial(+m[3], mo + 1, +m[2]);
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s);
  if (m) {
    let h = +m[1];
    if (m[4]) {
      const pm = m[4].toLowerCase() === 'pm';
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    if (h > 23 || +m[2] > 59) return null;
    return (h * 3600 + +m[2] * 60 + (m[3] ? +m[3] : 0)) / 86400;
  }
  return null;
}

/** Plain-data form for IPC (`sheet_eval.value`). */
export function toPlain(v: V): unknown {
  if (v instanceof Err) return v.code;
  if (v instanceof Arr) {
    const out: unknown[][] = [];
    for (let r = 0; r < v.rows; r++) {
      const row: unknown[] = [];
      for (let c = 0; c < v.cols; c++) row.push(toPlain(v.get(r, c)));
      out.push(row);
    }
    return out;
  }
  return v;
}
