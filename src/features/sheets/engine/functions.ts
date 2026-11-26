/**
 * Function registry (§14.3). One table backs evaluation, `sheet_functions()`, autocomplete and the help panel:
 * every entry carries its signature, description and an example. Argument docs are derived from the signature
 * ("[x]" = optional, "…" = repeatable).
 */
import type { Rect } from '@/backend/types';
import { formatValue } from './numfmt';
import {
  Arr,
  compare,
  dateToSerial,
  Err,
  ERR,
  isArr,
  isErr,
  msToSerial,
  numToText,
  parseDateText,
  round15,
  serialToDate,
  toBool,
  toNum,
  toStr,
  type Scalar,
  type V,
} from './values';

export interface FnCtx {
  /** Calling cell (0-based). */
  row: number;
  col: number;
  sheetId: string;
  nowMs(): number;
  rand(): number;
  /** Values of a rectangle on a sheet (OFFSET / INDIRECT). */
  resolve(sheetId: string, rect: Rect): V;
  /** Parse an A1 reference string relative to the current workbook (INDIRECT). */
  resolveText(text: string): V;
}

export type Thunk = () => V;

export interface FnArgDoc {
  name: string;
  optional: boolean;
  repeat: boolean;
}

export interface FnSpec {
  name: string;
  category: string;
  min: number;
  max: number;
  signature: string;
  description: string;
  example: string;
  args: FnArgDoc[];
  volatile?: boolean;
  /** Receives unevaluated thunks (IF, IFERROR, CHOOSE, …). */
  lazy?: boolean;
  fn: (args: V[], cx: FnCtx) => V;
  lazyFn?: (args: Thunk[], cx: FnCtx) => V;
}

export const FUNCTIONS = new Map<string, FnSpec>();

function argsFromSignature(sig: string): FnArgDoc[] {
  const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')')).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && p !== '…')
    .map((p, i, all) => {
      const optional = p.startsWith('[');
      const name = p.replace(/[[\]…]/g, '').trim();
      const repeat = p.includes('…') || all[i + 1] === '…';
      return { name, optional, repeat };
    });
}

interface DefOpts {
  min?: number;
  max?: number;
  volatile?: boolean;
}

function def(category: string, signature: string, description: string, example: string, fn: FnSpec['fn'], opts: DefOpts = {}): void {
  const name = signature.slice(0, signature.indexOf('('));
  const args = argsFromSignature(signature);
  const required = args.filter((a) => !a.optional).length;
  const repeat = args.some((a) => a.repeat);
  FUNCTIONS.set(name, {
    name,
    category,
    signature,
    description,
    example,
    args,
    min: opts.min ?? required,
    max: opts.max ?? (repeat ? 255 : args.length),
    volatile: opts.volatile,
    fn,
  });
}

function defLazy(category: string, signature: string, description: string, example: string, lazyFn: NonNullable<FnSpec['lazyFn']>, opts: DefOpts = {}): void {
  def(category, signature, description, example, () => ERR.value, opts);
  const spec = FUNCTIONS.get(signature.slice(0, signature.indexOf('(')))!;
  spec.lazy = true;
  spec.lazyFn = lazyFn;
}

function alias(name: string, target: string): void {
  const t = FUNCTIONS.get(target);
  if (t) FUNCTIONS.set(name, { ...t, name, signature: t.signature.replace(target, name) });
}

// ───────────────────────────────────────────────────────────────────────────── helpers

/** Scalar from a value: single-cell arrays collapse; larger arrays take implicit intersection at [0,0]. */
export function scalar(v: V): Scalar {
  if (isArr(v)) return v.rows === 0 || v.cols === 0 ? null : v.get(0, 0);
  return v;
}

function num(v: V | undefined, dflt?: number): number | Err {
  if (v === undefined) return dflt ?? ERR.value;
  const s = scalar(v);
  if (s === null && dflt !== undefined && !isArr(v)) return dflt;
  return toNum(s);
}

function str(v: V | undefined, dflt = ''): string | Err {
  if (v === undefined) return dflt;
  return toStr(scalar(v));
}

function bool(v: V | undefined, dflt: boolean): boolean | Err {
  if (v === undefined) return dflt;
  const s = scalar(v);
  if (s === null) return dflt;
  return toBool(s);
}

/** Error-propagating numeric arguments. */
function nums2<T extends unknown[]>(vals: { [K in keyof T]: number | Err }, f: (...a: T) => V): V {
  for (const v of vals) if (isErr(v)) return v;
  return f(...(vals as unknown as T));
}

const fin = (n: number): V => (Number.isFinite(n) ? n : ERR.num);

/**
 * Numbers for aggregate functions: values inside arrays/ranges count only when numeric (text, bools and blanks are
 * skipped); direct scalar arguments are coerced. Errors propagate.
 */
function collectNums(args: V[], opts: { textAsZero?: boolean; countBools?: boolean } = {}): number[] | Err {
  const out: number[] = [];
  for (const a of args) {
    if (isArr(a)) {
      for (const v of a.v) {
        if (typeof v === 'number') out.push(v);
        else if (isErr(v)) return v;
        else if (opts.textAsZero && typeof v === 'string') out.push(0);
        else if (opts.countBools && typeof v === 'boolean') out.push(v ? 1 : 0);
      }
    } else {
      if (a === null) continue;
      const n = toNum(a);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function allScalars(args: V[]): Scalar[] {
  const out: Scalar[] = [];
  for (const a of args) {
    if (isArr(a)) out.push(...a.v);
    else out.push(a);
  }
  return out;
}

function toArr(v: V): Arr {
  return isArr(v) ? v : new Arr(1, 1, [v]);
}

function wildcardRe(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

/** *IF(S) criteria: 5, ">=5", "<>x", "app*", "=" (blank), "<>" (non-blank). */
export function criteria(c: Scalar): (v: Scalar) => boolean {
  if (typeof c === 'number') return (v) => (typeof v === 'number' ? round15(v) === round15(c) : typeof v === 'string' && toNum(v) === c);
  if (typeof c === 'boolean') return (v) => v === c;
  if (c === null) return (v) => v === null || v === '';
  if (isErr(c)) return (v) => isErr(v) && v.code === c.code;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? '=';
  const rest = m[2];
  const n = rest.trim() === '' ? NaN : Number(rest.replace(/,/g, ''));
  const d = parseDateText(rest);
  const target = Number.isFinite(n) ? n : d;
  if (target !== null && Number.isFinite(target)) {
    return (v) => {
      const x = typeof v === 'number' ? v : null;
      if (x === null) return op === '<>';
      const cmp = compare(x, target);
      switch (op) {
        case '=': return cmp === 0;
        case '<>': return cmp !== 0;
        case '<': return cmp < 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        default: return cmp >= 0;
      }
    };
  }
  if (rest === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => !(v === null || v === '');
  }
  if (op === '=' || op === '<>') {
    const re = /[*?~]/.test(rest) ? wildcardRe(rest) : null;
    const low = rest.toLowerCase();
    const eq = (v: Scalar) => {
      if (v === null) return false;
      const s = typeof v === 'string' ? v : toStr(v);
      if (isErr(s)) return false;
      return re ? re.test(s) : s.toLowerCase() === low;
    };
    return op === '=' ? eq : (v) => !eq(v);
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    const cmp = compare(v, rest);
    switch (op) {
      case '<': return cmp < 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      default: return cmp >= 0;
    }
  };
}

/** Pairs of (range, criteria) → boolean mask over the first range's cells. */
function ifsMask(pairs: V[], shape?: Arr): boolean[] | Err {
  const first = shape ?? toArr(pairs[0]);
  const mask = new Array<boolean>(first.rows * first.cols).fill(true);
  for (let i = 0; i < pairs.length; i += 2) {
    const range = toArr(pairs[i]);
    const crit = scalar(pairs[i + 1] ?? null);
    if (range.rows !== first.rows || range.cols !== first.cols) return ERR.value;
    const test = criteria(crit);
    for (let k = 0; k < mask.length; k++) if (mask[k] && !test(range.v[k])) mask[k] = false;
  }
  return mask;
}

function lookupEquals(a: Scalar, b: Scalar, wildcard: boolean): boolean {
  if (wildcard && typeof a === 'string' && typeof b === 'string' && /[*?~]/.test(a)) return wildcardRe(a).test(b);
  if (typeof a === 'string' && typeof b === 'number') return false;
  if (typeof a === 'number' && typeof b === 'string') return false;
  return compare(a, b) === 0;
}

/** MATCH-style search over a vector. type 1: largest ≤; 0: exact; −1: smallest ≥. Returns 0-based index or −1. */
function vectorMatch(vec: Scalar[], x: Scalar, type: number, wildcard = true): number {
  if (type === 0) {
    for (let i = 0; i < vec.length; i++) if (vec[i] !== null && lookupEquals(x, vec[i], wildcard)) return i;
    return -1;
  }
  let best = -1;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (v === null || isErr(v)) continue;
    if (typeof v !== typeof x && !(typeof x === 'number' && typeof v === 'number')) continue;
    const c = compare(v, x);
    if (type > 0) {
      if (c <= 0) best = i;
      else break;
    } else {
      if (c >= 0) best = i;
      else break;
    }
  }
  return best;
}

function rowsOf(a: Arr): Scalar[][] {
  const out: Scalar[][] = [];
  for (let r = 0; r < a.rows; r++) out.push(a.v.slice(r * a.cols, (r + 1) * a.cols));
  return out;
}

function sliceRow(a: Arr, r: number): Arr {
  return new Arr(1, a.cols, a.v.slice(r * a.cols, (r + 1) * a.cols));
}
function sliceCol(a: Arr, c: number): Arr {
  const out: Scalar[] = [];
  for (let r = 0; r < a.rows; r++) out.push(a.v[r * a.cols + c]);
  return new Arr(a.rows, 1, out);
}

function firstErr(...vs: unknown[]): Err | null {
  for (const v of vs) if (isErr(v)) return v;
  return null;
}

function truncate(n: number): number {
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}

function roundTo(n: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const f = 10 ** digits;
  const x = round15(n * f);
  let r: number;
  if (mode === 'half') r = Math.sign(x) * Math.round(Math.abs(x));
  else if (mode === 'up') r = Math.sign(x) * Math.ceil(Math.abs(x));
  else r = Math.sign(x) * Math.floor(Math.abs(x));
  return round15(r / f);
}

function todaySerial(cx: FnCtx): number {
  const d = new Date(cx.nowMs());
  return dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function nowSerial(cx: FnCtx): number {
  const ms = cx.nowMs();
  return msToSerial(ms, new Date(ms).getTimezoneOffset());
}

function addMonths(serial: number, months: number): { y: number; m: number; d: number } {
  const { y, m, d } = serialToDate(serial);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return { y: ny, m: nm, d: Math.min(d, dim) };
}

// Financial core (Excel conventions: cash paid out is negative).
function fvCore(r: number, n: number, pmt: number, pv: number, type: number): number {
  if (r === 0) return -(pv + pmt * n);
  const g = (1 + r) ** n;
  return -(pv * g + (pmt * (1 + r * type) * (g - 1)) / r);
}
function pmtCore(r: number, n: number, pv: number, fv: number, type: number): number {
  if (r === 0) return -(pv + fv) / n;
  const g = (1 + r) ** n;
  return -(r * (fv + pv * g)) / ((1 + r * type) * (g - 1));
}
function ipmtCore(r: number, per: number, n: number, pv: number, fv: number, type: number): number {
  const pmt = pmtCore(r, n, pv, fv, type);
  if (type === 1 && per === 1) return 0;
  const bal = type === 1 ? fvCore(r, per - 2, pmt, pv, 1) - pmt : fvCore(r, per - 1, pmt, pv, 0);
  return bal * r;
}

// ───────────────────────────────────────────────────────────────────────────── math

def('Math', 'SUM(number1, [number2], …)', 'Adds all the numbers in a range or list.', '=SUM(B2:B13)', (a) => {
  const n = collectNums(a);
  return isErr(n) ? n : round15(n.reduce((s, x) => s + x, 0));
}, { min: 1 });

def('Math', 'SUMIF(range, criteria, [sum_range])', 'Adds the cells that meet one condition.', '=SUMIF(C2:C40, "Groceries", D2:D40)', (a) => {
  const range = toArr(a[0]);
  const sumR = a[2] !== undefined ? toArr(a[2]) : range;
  const test = criteria(scalar(a[1]));
  let s = 0;
  for (let i = 0; i < range.v.length; i++) {
    if (!test(range.v[i])) continue;
    const r = Math.floor(i / range.cols);
    const c = i % range.cols;
    const v = r < sumR.rows && c < sumR.cols ? sumR.v[r * sumR.cols + c] : null;
    if (isErr(v)) return v;
    if (typeof v === 'number') s += v;
  }
  return round15(s);
});

def('Math', 'SUMIFS(sum_range, criteria_range1, criteria1, …)', 'Adds the cells that meet every condition.', '=SUMIFS(D:D, C:C, "Rent", B:B, ">=2026-01-01")', (a) => {
  const sumR = toArr(a[0]);
  const mask = ifsMask(a.slice(1), sumR);
  if (isErr(mask)) return mask;
  let s = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const v = sumR.v[i];
    if (isErr(v)) return v;
    if (typeof v === 'number') s += v;
  }
  return round15(s);
}, { min: 3 });

def('Math', 'SUMPRODUCT(array1, [array2], …)', 'Multiplies matching items in arrays and adds the results.', '=SUMPRODUCT(B2:B5, C2:C5)', (a) => {
  const arrs = a.map(toArr);
  const { rows, cols } = arrs[0];
  if (arrs.some((x) => x.rows !== rows || x.cols !== cols)) return ERR.value;
  let s = 0;
  for (let i = 0; i < rows * cols; i++) {
    let p = 1;
    for (const x of arrs) {
      const v = x.v[i];
      if (isErr(v)) return v;
      p *= typeof v === 'number' ? v : typeof v === 'boolean' && a.length === 1 ? Number(v) : 0;
    }
    s += p;
  }
  return round15(s);
}, { min: 1 });

def('Math', 'SUMSQ(number1, [number2], …)', 'Adds the squares of the numbers.', '=SUMSQ(3, 4)', (a) => {
  const n = collectNums(a);
  return isErr(n) ? n : n.reduce((s, x) => s + x * x, 0);
}, { min: 1 });
def('Math', 'PRODUCT(number1, [number2], …)', 'Multiplies all the numbers.', '=PRODUCT(2, 3, 4)', (a) => {
  const n = collectNums(a);
  return isErr(n) ? n : n.length ? fin(n.reduce((s, x) => s * x, 1)) : 0;
}, { min: 1 });
def('Math', 'QUOTIENT(numerator, denominator)', 'The integer part of a division.', '=QUOTIENT(7, 2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (x, y) => (y === 0 ? ERR.div0 : truncate(x / y))));
def('Math', 'MOD(number, divisor)', 'The remainder after division, with the sign of the divisor.', '=MOD(10, 3)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (x, y) => (y === 0 ? ERR.div0 : round15(x - y * Math.floor(x / y)))));
def('Math', 'ABS(number)', 'The absolute value of a number.', '=ABS(-42)', (a) => nums2<[number]>([num(a[0])], Math.abs));
def('Math', 'SIGN(number)', 'Returns 1, 0 or −1 for the sign of a number.', '=SIGN(-3)', (a) => nums2<[number]>([num(a[0])], Math.sign));
def('Math', 'INT(number)', 'Rounds down to the nearest integer.', '=INT(-4.3)', (a) => nums2<[number]>([num(a[0])], Math.floor));
def('Math', 'TRUNC(number, [digits])', 'Truncates a number to the given digits.', '=TRUNC(3.789, 1)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1], 0)], (x, d) => roundTo(x, Math.trunc(d), 'down')));
def('Math', 'ROUND(number, digits)', 'Rounds a number to the given number of digits.', '=ROUND(B4*1.08, 2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (x, d) => roundTo(x, Math.trunc(d), 'half')));
def('Math', 'ROUNDUP(number, digits)', 'Rounds a number away from zero.', '=ROUNDUP(3.14159, 2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (x, d) => roundTo(x, Math.trunc(d), 'up')));
def('Math', 'ROUNDDOWN(number, digits)', 'Rounds a number toward zero.', '=ROUNDDOWN(3.14159, 2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (x, d) => roundTo(x, Math.trunc(d), 'down')));
def('Math', 'MROUND(number, multiple)', 'Rounds to the nearest multiple.', '=MROUND(17, 5)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (x, m) => (m === 0 ? 0 : x * m < 0 ? ERR.num : round15(Math.round(x / m) * m))));
def('Math', 'CEILING(number, [significance])', 'Rounds up to the nearest multiple of significance.', '=CEILING(4.2, 0.5)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1], 1)], (x, s) => (s === 0 ? 0 : round15(Math.ceil(x / s) * s))));
alias('CEILING.MATH', 'CEILING');
def('Math', 'FLOOR(number, [significance])', 'Rounds down to the nearest multiple of significance.', '=FLOOR(4.7, 0.5)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1], 1)], (x, s) => (s === 0 ? ERR.div0 : round15(Math.floor(x / s) * s))));
alias('FLOOR.MATH', 'FLOOR');
def('Math', 'EVEN(number)', 'Rounds away from zero to the nearest even integer.', '=EVEN(3)', (a) =>
  nums2<[number]>([num(a[0])], (x) => Math.sign(x) * Math.ceil(Math.abs(x) / 2) * 2));
def('Math', 'ODD(number)', 'Rounds away from zero to the nearest odd integer.', '=ODD(2)', (a) =>
  nums2<[number]>([num(a[0])], (x) => {
    const v = Math.ceil(Math.abs(x));
    return Math.sign(x || 1) * (v % 2 === 1 ? v : v + 1);
  }));
def('Math', 'SQRT(number)', 'The positive square root.', '=SQRT(144)', (a) => nums2<[number]>([num(a[0])], (x) => (x < 0 ? ERR.num : Math.sqrt(x))));
def('Math', 'POWER(number, power)', 'A number raised to a power.', '=POWER(1.05, 10)', (a) => nums2<[number, number]>([num(a[0]), num(a[1])], (x, y) => fin(x ** y)));
def('Math', 'EXP(number)', 'e raised to a power.', '=EXP(1)', (a) => nums2<[number]>([num(a[0])], (x) => fin(Math.exp(x))));
def('Math', 'LN(number)', 'Natural logarithm.', '=LN(10)', (a) => nums2<[number]>([num(a[0])], (x) => (x <= 0 ? ERR.num : Math.log(x))));
def('Math', 'LOG(number, [base])', 'Logarithm in the given base (10 by default).', '=LOG(8, 2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1], 10)], (x, b) => (x <= 0 || b <= 0 || b === 1 ? ERR.num : round15(Math.log(x) / Math.log(b)))));
def('Math', 'LOG10(number)', 'Base-10 logarithm.', '=LOG10(1000)', (a) => nums2<[number]>([num(a[0])], (x) => (x <= 0 ? ERR.num : Math.log10(x))));
def('Math', 'PI()', 'The number π to 15 digits.', '=PI()*B2^2', () => Math.PI);
def('Math', 'RAND()', 'A random number between 0 and 1. Recalculates on every change.', '=RAND()', (_a, cx) => cx.rand(), { volatile: true });
def('Math', 'RANDBETWEEN(bottom, top)', 'A random integer between two values. Recalculates on every change.', '=RANDBETWEEN(1, 6)', (a, cx) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (lo, hi) => (lo > hi ? ERR.num : Math.floor(cx.rand() * (Math.floor(hi) - Math.ceil(lo) + 1)) + Math.ceil(lo))), { volatile: true });
def('Math', 'FACT(number)', 'The factorial of a number.', '=FACT(5)', (a) =>
  nums2<[number]>([num(a[0])], (x) => {
    if (x < 0) return ERR.num;
    let f = 1;
    for (let i = 2; i <= Math.floor(x); i++) f *= i;
    return fin(f);
  }));
def('Math', 'COMBIN(number, chosen)', 'The number of combinations.', '=COMBIN(10, 3)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (n0, k0) => {
    const n = Math.floor(n0);
    const k = Math.floor(k0);
    if (n < 0 || k < 0 || k > n) return ERR.num;
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }));
def('Math', 'GCD(number1, [number2], …)', 'Greatest common divisor.', '=GCD(24, 36)', (a) => {
  const n = collectNums(a);
  if (isErr(n)) return n;
  const g = (x: number, y: number): number => (y === 0 ? x : g(y, x % y));
  return n.map((x) => Math.floor(Math.abs(x))).reduce((s, x) => g(s, x), 0);
}, { min: 1 });
def('Math', 'LCM(number1, [number2], …)', 'Least common multiple.', '=LCM(4, 6)', (a) => {
  const n = collectNums(a);
  if (isErr(n)) return n;
  const g = (x: number, y: number): number => (y === 0 ? x : g(y, x % y));
  return n.map((x) => Math.floor(Math.abs(x))).reduce((s, x) => (s === 0 || x === 0 ? 0 : (s * x) / g(s, x)), 1);
}, { min: 1 });
def('Math', 'DEGREES(angle)', 'Converts radians to degrees.', '=DEGREES(PI())', (a) => nums2<[number]>([num(a[0])], (x) => (x * 180) / Math.PI));
def('Math', 'RADIANS(angle)', 'Converts degrees to radians.', '=RADIANS(180)', (a) => nums2<[number]>([num(a[0])], (x) => (x * Math.PI) / 180));
for (const [nm, f] of [['SIN', Math.sin], ['COS', Math.cos], ['TAN', Math.tan], ['ASIN', Math.asin], ['ACOS', Math.acos], ['ATAN', Math.atan]] as const) {
  def('Math', `${nm}(number)`, `The ${nm.toLowerCase()} of an angle in radians.`, `=${nm}(0.5)`, (a) => nums2<[number]>([num(a[0])], (x) => fin(f(x))));
}
def('Math', 'SUBTOTAL(function_num, ref1, …)', 'An aggregate (1 AVERAGE, 2 COUNT, 3 COUNTA, 4 MAX, 5 MIN, 9 SUM …) over ranges.', '=SUBTOTAL(9, B2:B20)', (a, cx) => {
  const code = num(a[0]);
  if (isErr(code)) return code;
  const map: Record<number, string> = { 1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV.S', 8: 'STDEV.P', 9: 'SUM', 10: 'VAR.S', 11: 'VAR.P' };
  const name = map[Math.floor(code) % 100];
  const spec = name ? FUNCTIONS.get(name) : undefined;
  return spec ? spec.fn(a.slice(1), cx) : ERR.value;
}, { min: 2 });

// ───────────────────────────────────────────────────────────────────────────── statistical

def('Statistical', 'AVERAGE(number1, [number2], …)', 'The arithmetic mean of the numbers.', '=AVERAGE(B2:B13)', (a) => {
  const n = collectNums(a);
  if (isErr(n)) return n;
  return n.length ? round15(n.reduce((s, x) => s + x, 0) / n.length) : ERR.div0;
}, { min: 1 });
def('Statistical', 'AVERAGEA(value1, [value2], …)', 'Mean counting text as 0 and TRUE as 1.', '=AVERAGEA(B2:B9)', (a) => {
  const n = collectNums(a, { textAsZero: true, countBools: true });
  if (isErr(n)) return n;
  return n.length ? n.reduce((s, x) => s + x, 0) / n.length : ERR.div0;
}, { min: 1 });
def('Statistical', 'AVERAGEIF(range, criteria, [average_range])', 'The mean of cells that meet a condition.', '=AVERAGEIF(C:C, "Dining", D:D)', (a) => {
  const range = toArr(a[0]);
  const avgR = a[2] !== undefined ? toArr(a[2]) : range;
  const test = criteria(scalar(a[1]));
  let s = 0;
  let k = 0;
  for (let i = 0; i < range.v.length; i++) {
    if (!test(range.v[i])) continue;
    const v = avgR.v[i];
    if (isErr(v)) return v;
    if (typeof v === 'number') {
      s += v;
      k++;
    }
  }
  return k ? s / k : ERR.div0;
});
def('Statistical', 'AVERAGEIFS(average_range, criteria_range1, criteria1, …)', 'The mean of cells that meet every condition.', '=AVERAGEIFS(D:D, C:C, "Dining", B:B, ">=2026-06-01")', (a) => {
  const r = toArr(a[0]);
  const mask = ifsMask(a.slice(1), r);
  if (isErr(mask)) return mask;
  let s = 0;
  let k = 0;
  mask.forEach((m, i) => {
    const v = r.v[i];
    if (m && typeof v === 'number') {
      s += v;
      k++;
    }
  });
  return k ? s / k : ERR.div0;
}, { min: 3 });
def('Statistical', 'COUNT(value1, [value2], …)', 'Counts the cells that contain numbers.', '=COUNT(B2:B40)', (a) => {
  let k = 0;
  for (const x of a) {
    if (isArr(x)) k += x.v.filter((v) => typeof v === 'number').length;
    else if (typeof x === 'number' || (typeof x === 'string' && !isErr(toNum(x))) || typeof x === 'boolean') k++;
  }
  return k;
}, { min: 1 });
def('Statistical', 'COUNTA(value1, [value2], …)', 'Counts the cells that are not empty.', '=COUNTA(A2:A40)', (a) => {
  let k = 0;
  for (const x of a) {
    if (isArr(x)) k += x.v.filter((v) => v !== null).length;
    else if (x !== null) k++;
  }
  return k;
}, { min: 1 });
def('Statistical', 'COUNTBLANK(range)', 'Counts empty cells.', '=COUNTBLANK(B2:B40)', (a) => toArr(a[0]).v.filter((v) => v === null || v === '').length);
def('Statistical', 'COUNTIF(range, criteria)', 'Counts the cells that meet a condition.', '=COUNTIF(C2:C40, ">100")', (a) => {
  const test = criteria(scalar(a[1]));
  return toArr(a[0]).v.filter((v) => test(v)).length;
});
def('Statistical', 'COUNTIFS(criteria_range1, criteria1, …)', 'Counts the cells that meet every condition.', '=COUNTIFS(C:C, "Rent", D:D, ">1000")', (a) => {
  const mask = ifsMask(a);
  return isErr(mask) ? mask : mask.filter(Boolean).length;
}, { min: 2 });
def('Statistical', 'MAX(number1, [number2], …)', 'The largest number.', '=MAX(B2:B13)', (a) => {
  const n = collectNums(a);
  return isErr(n) ? n : n.length ? Math.max(...n) : 0;
}, { min: 1 });
def('Statistical', 'MIN(number1, [number2], …)', 'The smallest number.', '=MIN(B2:B13)', (a) => {
  const n = collectNums(a);
  return isErr(n) ? n : n.length ? Math.min(...n) : 0;
}, { min: 1 });
def('Statistical', 'MAXA(value1, [value2], …)', 'The largest value, counting TRUE as 1 and text as 0.', '=MAXA(B2:B13)', (a) => {
  const n = collectNums(a, { textAsZero: true, countBools: true });
  return isErr(n) ? n : n.length ? Math.max(...n) : 0;
}, { min: 1 });
def('Statistical', 'MINA(value1, [value2], …)', 'The smallest value, counting TRUE as 1 and text as 0.', '=MINA(B2:B13)', (a) => {
  const n = collectNums(a, { textAsZero: true, countBools: true });
  return isErr(n) ? n : n.length ? Math.min(...n) : 0;
}, { min: 1 });
for (const kind of ['MAXIFS', 'MINIFS'] as const) {
  def('Statistical', `${kind}(${kind === 'MAXIFS' ? 'max' : 'min'}_range, criteria_range1, criteria1, …)`, `The ${kind === 'MAXIFS' ? 'largest' : 'smallest'} value among cells that meet every condition.`, `=${kind}(D:D, C:C, "Groceries")`, (a) => {
    const r = toArr(a[0]);
    const mask = ifsMask(a.slice(1), r);
    if (isErr(mask)) return mask;
    const vals = r.v.filter((v, i) => mask[i] && typeof v === 'number') as number[];
    return vals.length ? (kind === 'MAXIFS' ? Math.max(...vals) : Math.min(...vals)) : 0;
  }, { min: 3 });
}
def('Statistical', 'MEDIAN(number1, [number2], …)', 'The middle number.', '=MEDIAN(B2:B13)', (a) => {
  const n = collectNums(a);
  if (isErr(n)) return n;
  if (!n.length) return ERR.num;
  const s = [...n].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}, { min: 1 });
def('Statistical', 'MODE.SNGL(number1, [number2], …)', 'The most frequent number.', '=MODE.SNGL(B2:B20)', (a) => {
  const n = collectNums(a);
  if (isErr(n)) return n;
  const counts = new Map<number, number>();
  let best: number | null = null;
  let bestN = 1;
  for (const x of n) {
    const c = (counts.get(x) ?? 0) + 1;
    counts.set(x, c);
    if (c > bestN) {
      bestN = c;
      best = x;
    }
  }
  return best ?? ERR.na;
}, { min: 1 });
alias('MODE', 'MODE.SNGL');
for (const [nm, k] of [['LARGE', -1], ['SMALL', 1]] as const) {
  def('Statistical', `${nm}(array, k)`, `The k-th ${nm === 'LARGE' ? 'largest' : 'smallest'} value.`, `=${nm}(B2:B20, 3)`, (a) => {
    const n = collectNums([a[0]]);
    const kk = num(a[1]);
    if (isErr(n)) return n;
    if (isErr(kk)) return kk;
    const s = [...n].sort((x, y) => (x - y) * k);
    const idx = Math.ceil(kk) - 1;
    return idx < 0 || idx >= s.length ? ERR.num : s[idx];
  });
}
def('Statistical', 'RANK.EQ(number, ref, [order])', 'The rank of a number in a list (0 = descending).', '=RANK.EQ(B2, $B$2:$B$20)', (a) => {
  const x = num(a[0]);
  const list = collectNums([a[1]]);
  const order = num(a[2], 0);
  const e = firstErr(x, list, order);
  if (e) return e;
  const xs = list as number[];
  const xv = x as number;
  if (!xs.some((v) => v === xv)) return ERR.na;
  return 1 + xs.filter((v) => (order ? v < xv : v > xv)).length;
});
alias('RANK', 'RANK.EQ');
def('Statistical', 'RANK.AVG(number, ref, [order])', 'The rank of a number, averaging ties.', '=RANK.AVG(B2, $B$2:$B$20)', (a) => {
  const x = num(a[0]);
  const list = collectNums([a[1]]);
  const order = num(a[2], 0);
  const e = firstErr(x, list, order);
  if (e) return e;
  const xs = list as number[];
  const xv = x as number;
  const ties = xs.filter((v) => v === xv).length;
  if (!ties) return ERR.na;
  const better = xs.filter((v) => (order ? v < xv : v > xv)).length;
  return better + (ties + 1) / 2;
});

function variance(n: number[], sample: boolean): number | Err {
  if (n.length < (sample ? 2 : 1)) return ERR.div0;
  const mean = n.reduce((s, x) => s + x, 0) / n.length;
  const ss = n.reduce((s, x) => s + (x - mean) ** 2, 0);
  return ss / (n.length - (sample ? 1 : 0));
}
for (const [nm, sample, sq] of [['VAR.S', true, false], ['VAR.P', false, false], ['STDEV.S', true, true], ['STDEV.P', false, true]] as const) {
  def('Statistical', `${nm}(number1, [number2], …)`, `${sq ? 'Standard deviation' : 'Variance'} of a ${sample ? 'sample' : 'population'}.`, `=${nm}(B2:B20)`, (a) => {
    const n = collectNums(a);
    if (isErr(n)) return n;
    const v = variance(n, sample);
    return isErr(v) ? v : sq ? Math.sqrt(v) : v;
  }, { min: 1 });
}
alias('STDEV', 'STDEV.S');
alias('VAR', 'VAR.S');
def('Statistical', 'PERCENTILE.INC(array, k)', 'The k-th percentile (0–1, inclusive).', '=PERCENTILE.INC(B2:B20, 0.9)', (a) => {
  const n = collectNums([a[0]]);
  const k = num(a[1]);
  const e = firstErr(n, k);
  if (e) return e;
  const s = [...(n as number[])].sort((x, y) => x - y);
  const kk = k as number;
  if (!s.length || kk < 0 || kk > 1) return ERR.num;
  const pos = kk * (s.length - 1);
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
});
alias('PERCENTILE', 'PERCENTILE.INC');
def('Statistical', 'QUARTILE.INC(array, quart)', 'A quartile (0–4) of the data.', '=QUARTILE.INC(B2:B20, 1)', (a, cx) => {
  const q = num(a[1]);
  if (isErr(q)) return q;
  return FUNCTIONS.get('PERCENTILE.INC')!.fn([a[0], Math.floor(q) / 4], cx);
});
def('Statistical', 'CORREL(array1, array2)', 'The correlation coefficient of two ranges.', '=CORREL(B2:B13, C2:C13)', (a) => {
  const x = toArr(a[0]).v;
  const y = toArr(a[1]).v;
  if (x.length !== y.length) return ERR.na;
  const pairs: [number, number][] = [];
  x.forEach((v, i) => {
    const w = y[i];
    if (typeof v === 'number' && typeof w === 'number') pairs.push([v, w]);
  });
  if (pairs.length < 2) return ERR.div0;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [p, q] of pairs) {
    sxy += (p - mx) * (q - my);
    sxx += (p - mx) ** 2;
    syy += (q - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : ERR.div0;
});
function linreg(a: V[]): { slope: number; intercept: number } | Err {
  const y = toArr(a[0]).v;
  const x = toArr(a[1]).v;
  if (x.length !== y.length) return ERR.na;
  const pts: [number, number][] = [];
  x.forEach((v, i) => {
    const w = y[i];
    if (typeof v === 'number' && typeof w === 'number') pts.push([v, w]);
  });
  if (pts.length < 2) return ERR.div0;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxy = 0;
  let sxx = 0;
  for (const [p, q] of pts) {
    sxy += (p - mx) * (q - my);
    sxx += (p - mx) ** 2;
  }
  if (!sxx) return ERR.div0;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}
def('Statistical', 'SLOPE(known_ys, known_xs)', 'The slope of the linear regression line.', '=SLOPE(C2:C13, B2:B13)', (a) => {
  const r = linreg(a);
  return isErr(r) ? r : r.slope;
});
def('Statistical', 'INTERCEPT(known_ys, known_xs)', 'Where the regression line crosses the y-axis.', '=INTERCEPT(C2:C13, B2:B13)', (a) => {
  const r = linreg(a);
  return isErr(r) ? r : r.intercept;
});
def('Statistical', 'FORECAST.LINEAR(x, known_ys, known_xs)', 'Predicts a value along a linear trend.', '=FORECAST.LINEAR(13, C2:C13, B2:B13)', (a) => {
  const x = num(a[0]);
  const r = linreg([a[1], a[2]]);
  const e = firstErr(x, r);
  if (e) return e;
  const rr = r as { slope: number; intercept: number };
  return rr.intercept + rr.slope * (x as number);
});
alias('FORECAST', 'FORECAST.LINEAR');
def('Statistical', 'GEOMEAN(number1, [number2], …)', 'The geometric mean.', '=GEOMEAN(1.05, 1.08, 0.97)', (a) => {
  const n = collectNums(a);
  if (isErr(n)) return n;
  if (!n.length || n.some((x) => x <= 0)) return ERR.num;
  return Math.exp(n.reduce((s, x) => s + Math.log(x), 0) / n.length);
}, { min: 1 });

// ───────────────────────────────────────────────────────────────────────────── logical

defLazy('Logical', 'IF(logical_test, value_if_true, [value_if_false])', 'Returns one value when a condition is TRUE and another when it is FALSE.', '=IF(D2>Budget, "Over", "OK")', (a) => {
  const t = a[0]();
  if (isArr(t)) {
    // Array IF: evaluate both branches and pick element-wise.
    const yes = a[1] ? a[1]() : true;
    const no = a[2] ? a[2]() : false;
    const out: Scalar[] = [];
    for (let r = 0; r < t.rows; r++)
      for (let c = 0; c < t.cols; c++) {
        const b = toBool(t.get(r, c));
        if (isErr(b)) out.push(b);
        else out.push(b ? (isArr(yes) ? yes.get(r, c) : yes) : isArr(no) ? no.get(r, c) : no);
      }
    return new Arr(t.rows, t.cols, out);
  }
  const b = toBool(t);
  if (isErr(b)) return b;
  if (b) return a[1] ? nullToZero(a[1]()) : true;
  return a[2] ? nullToZero(a[2]()) : false;
});
function nullToZero(v: V): V {
  return v === null ? 0 : v;
}
defLazy('Logical', 'IFS(test1, value1, …)', 'Returns the value for the first condition that is TRUE.', '=IFS(B2>=90, "A", B2>=80, "B", TRUE, "C")', (a) => {
  for (let i = 0; i + 1 < a.length; i += 2) {
    const b = toBool(scalar(a[i]()));
    if (isErr(b)) return b;
    if (b) return nullToZero(a[i + 1]());
  }
  return ERR.na;
}, { min: 2 });
defLazy('Logical', 'IFERROR(value, value_if_error)', 'Returns a fallback when a formula produces an error.', '=IFERROR(B2/C2, 0)', (a) => {
  const v = a[0]();
  if (isErr(v)) return a[1] ? nullToZero(a[1]()) : 0;
  if (isArr(v) && v.v.some(isErr)) {
    const fb = a[1] ? scalar(a[1]()) : 0;
    return v.map((x) => (isErr(x) ? fb : x));
  }
  return nullToZero(v);
});
defLazy('Logical', 'IFNA(value, value_if_na)', 'Returns a fallback when a formula produces #N/A.', '=IFNA(XLOOKUP(A2, Codes, Names), "Unknown")', (a) => {
  const v = a[0]();
  return isErr(v) && v.code === '#N/A' ? (a[1] ? a[1]() : 0) : v;
});
function logicalFold(a: V[], init: boolean, step: (acc: boolean, b: boolean) => boolean): V {
  let acc = init;
  let seen = false;
  for (const x of a) {
    const vals = isArr(x) ? x.v.filter((v) => typeof v === 'boolean' || typeof v === 'number' || isErr(v)) : [x];
    for (const v of vals) {
      if (v === null) continue;
      const b = toBool(v);
      if (isErr(b)) return b;
      acc = step(acc, b);
      seen = true;
    }
  }
  return seen ? acc : ERR.value;
}
def('Logical', 'AND(logical1, [logical2], …)', 'TRUE when every argument is TRUE.', '=AND(B2>0, C2<100)', (a) => logicalFold(a, true, (x, y) => x && y), { min: 1 });
def('Logical', 'OR(logical1, [logical2], …)', 'TRUE when any argument is TRUE.', '=OR(B2="Rent", B2="Mortgage")', (a) => logicalFold(a, false, (x, y) => x || y), { min: 1 });
def('Logical', 'XOR(logical1, [logical2], …)', 'TRUE when an odd number of arguments are TRUE.', '=XOR(B2, C2)', (a) => logicalFold(a, false, (x, y) => x !== y), { min: 1 });
def('Logical', 'NOT(logical)', 'Reverses TRUE and FALSE.', '=NOT(ISBLANK(B2))', (a) => {
  const b = toBool(scalar(a[0]));
  return isErr(b) ? b : !b;
});
def('Logical', 'TRUE()', 'The logical value TRUE.', '=TRUE()', () => true);
def('Logical', 'FALSE()', 'The logical value FALSE.', '=FALSE()', () => false);
defLazy('Logical', 'SWITCH(expression, value1, result1, …, [default])', 'Compares an expression to a list of values and returns the first match.', '=SWITCH(B2, 1, "Mon", 2, "Tue", "Other")', (a) => {
  const x = scalar(a[0]());
  let i = 1;
  for (; i + 1 < a.length; i += 2) {
    if (compare(x, scalar(a[i]())) === 0) return a[i + 1]();
  }
  return i < a.length ? a[i]() : ERR.na;
}, { min: 3 });
defLazy('Lookup', 'CHOOSE(index_num, value1, [value2], …)', 'Picks a value from a list by position.', '=CHOOSE(2, "Low", "Mid", "High")', (a) => {
  const i = toNum(scalar(a[0]()));
  if (isErr(i)) return i;
  const k = Math.floor(i);
  return k >= 1 && k < a.length ? a[k]() : ERR.value;
}, { min: 2 });

// ───────────────────────────────────────────────────────────────────────────── lookup & reference

def('Lookup', 'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])', 'Finds a value in the first column of a table and returns a value from another column in the same row.', '=VLOOKUP(A2, Rates, 2, FALSE)', (a) => {
  const x = scalar(a[0]);
  const t = toArr(a[1]);
  const ci = num(a[2]);
  const approx = bool(a[3], true);
  const e = firstErr(x, ci, approx);
  if (e) return e;
  const col = Math.floor(ci as number) - 1;
  if (col < 0) return ERR.value;
  if (col >= t.cols) return ERR.ref;
  const idx = vectorMatch(sliceCol(t, 0).v, x, approx ? 1 : 0);
  return idx < 0 ? ERR.na : t.get(idx, col);
});
def('Lookup', 'HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])', 'Finds a value in the first row of a table and returns a value from another row in the same column.', '=HLOOKUP("Q2", A1:E5, 3, FALSE)', (a) => {
  const x = scalar(a[0]);
  const t = toArr(a[1]);
  const ri = num(a[2]);
  const approx = bool(a[3], true);
  const e = firstErr(x, ri, approx);
  if (e) return e;
  const row = Math.floor(ri as number) - 1;
  if (row < 0) return ERR.value;
  if (row >= t.rows) return ERR.ref;
  const idx = vectorMatch(sliceRow(t, 0).v, x, approx ? 1 : 0);
  return idx < 0 ? ERR.na : t.get(row, idx);
});
def('Lookup', 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])', 'Searches a range and returns the matching item from another range. Match mode: 0 exact, −1 next smaller, 1 next larger, 2 wildcard.', '=XLOOKUP(A2, Codes, Names, "Not found")', (a) => {
  const x = scalar(a[0]);
  const look = toArr(a[1]);
  const ret = toArr(a[2]);
  const mode = num(a[4], 0);
  const search = num(a[5], 1);
  const e = firstErr(x, mode, search);
  if (e) return e;
  const vec = look.v;
  const order = (search as number) < 0 ? [...vec.keys()].reverse() : [...vec.keys()];
  let found = -1;
  if (mode === 0 || mode === 2) {
    for (const i of order) if (vec[i] !== null && lookupEquals(x, vec[i], mode === 2)) {
      found = i;
      break;
    }
  } else {
    let bestDiff: Scalar = null;
    for (const i of order) {
      const v = vec[i];
      if (v === null || isErr(v)) continue;
      const c = compare(v, x);
      if (c === 0) {
        found = i;
        break;
      }
      if ((mode === -1 && c < 0) || (mode === 1 && c > 0)) {
        if (bestDiff === null || (mode === -1 ? compare(v, bestDiff) > 0 : compare(v, bestDiff) < 0)) {
          bestDiff = v;
          found = i;
        }
      }
    }
  }
  if (found < 0) return a[3] !== undefined && !(isArr(a[3]) && a[3].rows === 0) ? a[3] : ERR.na;
  if (look.cols === 1) return ret.cols === 1 ? ret.get(found, 0) : sliceRow(ret, found);
  return ret.rows === 1 ? ret.get(0, found) : sliceCol(ret, found);
});
def('Lookup', 'LOOKUP(lookup_value, lookup_vector, [result_vector])', 'Approximate lookup in a sorted vector.', '=LOOKUP(4.5, A2:A9, B2:B9)', (a) => {
  const x = scalar(a[0]);
  const look = toArr(a[1]);
  const res = a[2] !== undefined ? toArr(a[2]) : look;
  const idx = vectorMatch(look.v, x, 1);
  return idx < 0 ? ERR.na : res.v[idx] ?? ERR.na;
});
def('Lookup', 'MATCH(lookup_value, lookup_array, [match_type])', 'The position of a value in a range (1 = largest ≤, 0 = exact, −1 = smallest ≥).', '=MATCH("Rent", A2:A20, 0)', (a) => {
  const x = scalar(a[0]);
  const arr = toArr(a[1]);
  const type = num(a[2], 1);
  const e = firstErr(x, type);
  if (e) return e;
  if (arr.rows > 1 && arr.cols > 1) return ERR.na;
  const idx = vectorMatch(arr.v, x, Math.sign(type as number));
  return idx < 0 ? ERR.na : idx + 1;
});
def('Lookup', 'XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])', 'The position of a value in a range (exact by default).', '=XMATCH("Rent", A2:A20)', (a) => {
  const x = scalar(a[0]);
  const arr = toArr(a[1]);
  const mode = num(a[2], 0);
  if (isErr(mode)) return mode;
  const idx = mode === 0 || mode === 2 ? vectorMatch(arr.v, x, 0, mode === 2) : vectorMatch(arr.v, x, mode > 0 ? -1 : 1);
  return idx < 0 ? ERR.na : idx + 1;
});
def('Lookup', 'INDEX(array, row_num, [column_num])', 'The value at a given row and column of a range.', '=INDEX(B2:D20, 5, 2)', (a) => {
  const arr = toArr(a[0]);
  const r0 = num(a[1], 0);
  const c0 = num(a[2], 0);
  const e = firstErr(r0, c0);
  if (e) return e;
  let r = Math.floor(r0 as number);
  let c = Math.floor(c0 as number);
  if (arr.rows === 1 && a[2] === undefined) {
    c = r;
    r = 1;
  }
  if (r < 0 || c < 0 || r > arr.rows || c > arr.cols) return ERR.ref;
  if (r === 0 && c === 0) return arr;
  if (r === 0) return sliceCol(arr, c - 1);
  if (c === 0) return arr.cols === 1 ? arr.get(r - 1, 0) : sliceRow(arr, r - 1);
  return arr.get(r - 1, c - 1);
});
def('Lookup', 'ROW([reference])', 'The row number of a reference (or of this cell).', '=ROW()', (a, cx) => {
  if (!a.length) return cx.row + 1;
  const o = isArr(a[0]) ? a[0].origin : undefined;
  return o ? o.rect.r0 + 1 : ERR.value;
}, { max: 1 });
def('Lookup', 'COLUMN([reference])', 'The column number of a reference (or of this cell).', '=COLUMN()', (a, cx) => {
  if (!a.length) return cx.col + 1;
  const o = isArr(a[0]) ? a[0].origin : undefined;
  return o ? o.rect.c0 + 1 : ERR.value;
}, { max: 1 });
def('Lookup', 'ROWS(array)', 'The number of rows in a range.', '=ROWS(A2:A40)', (a) => toArr(a[0]).rows);
def('Lookup', 'COLUMNS(array)', 'The number of columns in a range.', '=COLUMNS(B1:M1)', (a) => toArr(a[0]).cols);
def('Lookup', 'OFFSET(reference, rows, cols, [height], [width])', 'A reference shifted from a starting cell.', '=SUM(OFFSET(B2, 0, 0, 12, 1))', (a, cx) => {
  const o = isArr(a[0]) ? a[0].origin : undefined;
  if (!o) return ERR.value;
  const dr = num(a[1]);
  const dc = num(a[2]);
  const h = num(a[3], o.rect.r1 - o.rect.r0 + 1);
  const w = num(a[4], o.rect.c1 - o.rect.c0 + 1);
  const e = firstErr(dr, dc, h, w);
  if (e) return e;
  const r0 = o.rect.r0 + Math.floor(dr as number);
  const c0 = o.rect.c0 + Math.floor(dc as number);
  const hh = Math.floor(h as number);
  const ww = Math.floor(w as number);
  if (r0 < 0 || c0 < 0 || hh < 1 || ww < 1) return ERR.ref;
  return cx.resolve(o.sheetId, { r0, c0, r1: r0 + hh - 1, c1: c0 + ww - 1 });
}, { volatile: true });
def('Lookup', 'INDIRECT(ref_text)', 'The reference named by a text string.', '=SUM(INDIRECT("B2:B" & A1))', (a, cx) => {
  const t = str(a[0]);
  return isErr(t) ? t : cx.resolveText(t);
}, { volatile: true, max: 2 });
def('Lookup', 'ADDRESS(row_num, column_num, [abs_num])', 'A cell address as text.', '=ADDRESS(2, 3)', (a) => {
  const r = num(a[0]);
  const c = num(a[1]);
  const k = num(a[2], 1);
  const e = firstErr(r, c, k);
  if (e) return e;
  let n = Math.floor(c as number);
  let col = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    col = String.fromCharCode(65 + m) + col;
    n = Math.floor((n - 1) / 26);
  }
  const kk = k as number;
  return `${kk === 1 || kk === 3 ? '$' : ''}${col}${kk === 1 || kk === 2 ? '$' : ''}${Math.floor(r as number)}`;
});
def('Lookup', 'TRANSPOSE(array)', 'Swaps rows and columns.', '=TRANSPOSE(A1:C3)', (a) => {
  const arr = toArr(a[0]);
  const out: Scalar[] = [];
  for (let c = 0; c < arr.cols; c++) for (let r = 0; r < arr.rows; r++) out.push(arr.v[r * arr.cols + c]);
  return new Arr(arr.cols, arr.rows, out);
});
def('Lookup', 'HYPERLINK(link_location, [friendly_name])', 'Text for a link (shown as its friendly name).', '=HYPERLINK("https://example.com", "Docs")', (a) => (a[1] !== undefined ? scalar(a[1]) : scalar(a[0])));

// ───────────────────────────────────────────────────────────────────────────── dynamic arrays

def('Dynamic arrays', 'SEQUENCE(rows, [columns], [start], [step])', 'A spilled list of sequential numbers.', '=SEQUENCE(12, 1, 1, 1)', (a) => {
  const r = num(a[0]);
  const c = num(a[1], 1);
  const s = num(a[2], 1);
  const st = num(a[3], 1);
  const e = firstErr(r, c, s, st);
  if (e) return e;
  const rows = Math.floor(r as number);
  const cols = Math.floor(c as number);
  if (rows < 1 || cols < 1) return ERR.calc;
  if (rows * cols > 100_000) return ERR.num;
  const out: Scalar[] = [];
  for (let i = 0; i < rows * cols; i++) out.push(round15((s as number) + i * (st as number)));
  return new Arr(rows, cols, out);
});
def('Dynamic arrays', 'FILTER(array, include, [if_empty])', 'The rows of a range that meet a condition.', '=FILTER(A2:C40, C2:C40>100, "None")', (a) => {
  const arr = toArr(a[0]);
  const inc = toArr(a[1]);
  const keep: number[] = [];
  if (inc.cols === 1 && inc.rows === arr.rows) {
    for (let r = 0; r < arr.rows; r++) {
      const b = toBool(inc.get(r, 0));
      if (isErr(b)) return b;
      if (b) keep.push(r);
    }
    if (!keep.length) return a[2] !== undefined ? a[2] : ERR.calc;
    return Arr.of(keep.map((r) => rowsOf(arr)[r]));
  }
  if (inc.rows === 1 && inc.cols === arr.cols) {
    for (let c = 0; c < arr.cols; c++) {
      const b = toBool(inc.get(0, c));
      if (isErr(b)) return b;
      if (b) keep.push(c);
    }
    if (!keep.length) return a[2] !== undefined ? a[2] : ERR.calc;
    return Arr.of(rowsOf(arr).map((row) => keep.map((c) => row[c])));
  }
  return ERR.value;
});
def('Dynamic arrays', 'SORT(array, [sort_index], [sort_order], [by_col])', 'Sorts the rows of a range (1 ascending, −1 descending).', '=SORT(A2:B20, 2, -1)', (a) => {
  const arr = toArr(a[0]);
  const idx = num(a[1], 1);
  const ord = num(a[2], 1);
  const e = firstErr(idx, ord);
  if (e) return e;
  const k = Math.floor(idx as number) - 1;
  if (k < 0 || k >= arr.cols) return ERR.value;
  const rows = rowsOf(arr);
  rows.sort((x, y) => compare(x[k], y[k]) * ((ord as number) < 0 ? -1 : 1));
  return Arr.of(rows);
});
def('Dynamic arrays', 'SORTBY(array, by_array1, [sort_order1], …)', 'Sorts a range by the values of another range.', '=SORTBY(A2:A20, B2:B20, -1)', (a) => {
  const arr = toArr(a[0]);
  const rows = rowsOf(arr).map((row, i) => ({ row, i }));
  const keys: { by: Arr; ord: number }[] = [];
  for (let i = 1; i < a.length; i += 2) {
    const o = num(a[i + 1], 1);
    if (isErr(o)) return o;
    keys.push({ by: toArr(a[i]), ord: o < 0 ? -1 : 1 });
  }
  rows.sort((x, y) => {
    for (const k of keys) {
      const c = compare(k.by.v[x.i] ?? null, k.by.v[y.i] ?? null) * k.ord;
      if (c) return c;
    }
    return x.i - y.i;
  });
  return Arr.of(rows.map((r) => r.row));
}, { min: 2 });
def('Dynamic arrays', 'UNIQUE(array, [by_col], [exactly_once])', 'The distinct rows of a range.', '=UNIQUE(C2:C40)', (a) => {
  const arr = toArr(a[0]);
  const once = bool(a[2], false);
  if (isErr(once)) return once;
  const rows = rowsOf(arr);
  const counts = new Map<string, { row: Scalar[]; n: number }>();
  for (const row of rows) {
    const key = row.map((v) => (typeof v === 'string' ? v.toLowerCase() : String(v))).join('\u0000');
    const hit = counts.get(key);
    if (hit) hit.n++;
    else counts.set(key, { row, n: 1 });
  }
  const out = [...counts.values()].filter((x) => !once || x.n === 1).map((x) => x.row);
  return out.length ? Arr.of(out) : ERR.calc;
});
def('Dynamic arrays', 'TAKE(array, rows, [columns])', 'The first (or last, if negative) rows / columns of a range.', '=TAKE(A2:C40, 5)', (a) => {
  const arr = toArr(a[0]);
  const r = num(a[1], arr.rows);
  const c = num(a[2], arr.cols);
  const e = firstErr(r, c);
  if (e) return e;
  let rows = rowsOf(arr);
  const rr = Math.trunc(r as number);
  const cc = Math.trunc(c as number);
  rows = rr >= 0 ? rows.slice(0, rr) : rows.slice(rr);
  rows = rows.map((row) => (cc >= 0 ? row.slice(0, cc) : row.slice(cc)));
  return rows.length && rows[0].length ? Arr.of(rows) : ERR.calc;
});
def('Dynamic arrays', 'DROP(array, rows, [columns])', 'A range without its first (or last, if negative) rows / columns.', '=DROP(A1:C40, 1)', (a) => {
  const arr = toArr(a[0]);
  const r = num(a[1], 0);
  const c = num(a[2], 0);
  const e = firstErr(r, c);
  if (e) return e;
  let rows = rowsOf(arr);
  const rr = Math.trunc(r as number);
  const cc = Math.trunc(c as number);
  rows = rr >= 0 ? rows.slice(rr) : rows.slice(0, rr);
  rows = rows.map((row) => (cc >= 0 ? row.slice(cc) : row.slice(0, cc)));
  return rows.length && rows[0].length ? Arr.of(rows) : ERR.calc;
});
def('Dynamic arrays', 'VSTACK(array1, [array2], …)', 'Stacks ranges vertically.', '=VSTACK(A1:B3, D1:E3)', (a) => {
  const arrs = a.map(toArr);
  const cols = Math.max(...arrs.map((x) => x.cols));
  const rows: Scalar[][] = [];
  for (const x of arrs) for (const row of rowsOf(x)) rows.push([...row, ...new Array<Scalar>(cols - row.length).fill(ERR.na)]);
  return Arr.of(rows);
}, { min: 1 });
def('Dynamic arrays', 'HSTACK(array1, [array2], …)', 'Stacks ranges side by side.', '=HSTACK(A1:A5, C1:C5)', (a) => {
  const arrs = a.map(toArr);
  const n = Math.max(...arrs.map((x) => x.rows));
  const rows: Scalar[][] = [];
  for (let r = 0; r < n; r++) rows.push(arrs.flatMap((x) => (r < x.rows ? rowsOf(x)[r] : new Array<Scalar>(x.cols).fill(ERR.na))));
  return Arr.of(rows);
}, { min: 1 });

// ───────────────────────────────────────────────────────────────────────────── text

def('Text', 'CONCAT(text1, [text2], …)', 'Joins text from several values or ranges.', '=CONCAT(A2, " ", B2)', (a) => {
  let s = '';
  for (const v of allScalars(a)) {
    const t = toStr(v);
    if (isErr(t)) return t;
    s += t;
  }
  return s;
}, { min: 1 });
alias('CONCATENATE', 'CONCAT');
def('Text', 'TEXTJOIN(delimiter, ignore_empty, text1, …)', 'Joins text with a delimiter.', '=TEXTJOIN(", ", TRUE, A2:A9)', (a) => {
  const d = str(a[0]);
  const ign = bool(a[1], true);
  if (isErr(d)) return d;
  if (isErr(ign)) return ign;
  const parts: string[] = [];
  for (const v of allScalars(a.slice(2))) {
    const t = toStr(v);
    if (isErr(t)) return t;
    if (ign && t === '') continue;
    parts.push(t);
  }
  return parts.join(d);
}, { min: 3 });
def('Text', 'LEFT(text, [num_chars])', 'The first characters of a text.', '=LEFT(A2, 3)', (a) => {
  const t = str(a[0]);
  const n = num(a[1], 1);
  const e = firstErr(t, n);
  return e ?? ((n as number) < 0 ? ERR.value : (t as string).slice(0, Math.floor(n as number)));
});
def('Text', 'RIGHT(text, [num_chars])', 'The last characters of a text.', '=RIGHT(A2, 4)', (a) => {
  const t = str(a[0]);
  const n = num(a[1], 1);
  const e = firstErr(t, n);
  if (e) return e;
  const k = Math.floor(n as number);
  return k < 0 ? ERR.value : k === 0 ? '' : (t as string).slice(-k);
});
def('Text', 'MID(text, start_num, num_chars)', 'Characters from the middle of a text.', '=MID(A2, 4, 2)', (a) => {
  const t = str(a[0]);
  const s = num(a[1]);
  const n = num(a[2]);
  const e = firstErr(t, s, n);
  if (e) return e;
  if ((s as number) < 1 || (n as number) < 0) return ERR.value;
  return (t as string).substr(Math.floor(s as number) - 1, Math.floor(n as number));
});
def('Text', 'LEN(text)', 'The number of characters in a text.', '=LEN(A2)', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t.length;
});
for (const [nm, cs] of [['FIND', true], ['SEARCH', false]] as const) {
  def('Text', `${nm}(find_text, within_text, [start_num])`, `The position of one text inside another (${cs ? 'case-sensitive' : 'not case-sensitive, wildcards allowed'}).`, `=${nm}("-", A2)`, (a) => {
    const f = str(a[0]);
    const w = str(a[1]);
    const s = num(a[2], 1);
    const e = firstErr(f, w, s);
    if (e) return e;
    const start = Math.floor(s as number) - 1;
    if (start < 0 || start > (w as string).length) return ERR.value;
    let idx: number;
    if (cs) idx = (w as string).indexOf(f as string, start);
    else if (/[*?]/.test(f as string)) {
      const re = new RegExp(wildcardRe(f as string).source.slice(1, -1), 'i');
      const m = re.exec((w as string).slice(start));
      idx = m ? m.index + start : -1;
    } else idx = (w as string).toLowerCase().indexOf((f as string).toLowerCase(), start);
    return idx < 0 ? ERR.value : idx + 1;
  });
}
def('Text', 'SUBSTITUTE(text, old_text, new_text, [instance_num])', 'Replaces existing text with new text.', '=SUBSTITUTE(A2, "-", " ")', (a) => {
  const t = str(a[0]);
  const o = str(a[1]);
  const n = str(a[2]);
  const k = a[3] !== undefined ? num(a[3]) : 0;
  const e = firstErr(t, o, n, k);
  if (e) return e;
  if (o === '') return t;
  if (!k) return (t as string).split(o as string).join(n as string);
  let count = 0;
  let pos = -1;
  const tt = t as string;
  while ((pos = tt.indexOf(o as string, pos + 1)) >= 0) {
    if (++count === k) return tt.slice(0, pos) + (n as string) + tt.slice(pos + (o as string).length);
  }
  return tt;
});
def('Text', 'REPLACE(old_text, start_num, num_chars, new_text)', 'Replaces part of a text by position.', '=REPLACE(A2, 1, 3, "XYZ")', (a) => {
  const t = str(a[0]);
  const s = num(a[1]);
  const n = num(a[2]);
  const r = str(a[3]);
  const e = firstErr(t, s, n, r);
  if (e) return e;
  const tt = t as string;
  const st = Math.floor(s as number) - 1;
  return tt.slice(0, st) + (r as string) + tt.slice(st + Math.floor(n as number));
});
def('Text', 'UPPER(text)', 'Converts text to upper case.', '=UPPER(A2)', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t.toUpperCase();
});
def('Text', 'LOWER(text)', 'Converts text to lower case.', '=LOWER(A2)', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t.toLowerCase();
});
def('Text', 'PROPER(text)', 'Capitalises the first letter of each word.', '=PROPER("monthly budget")', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
});
def('Text', 'TRIM(text)', 'Removes extra spaces.', '=TRIM(A2)', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t.trim().replace(/ {2,}/g, ' ');
});
def('Text', 'CLEAN(text)', 'Removes non-printable characters.', '=CLEAN(A2)', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t.replace(/[\u0000-\u001f]/g, ''); // eslint-disable-line no-control-regex
});
def('Text', 'TEXT(value, format_text)', 'Formats a number as text with a number format.', '=TEXT(B2, "$#,##0.00")', (a) => {
  const v = scalar(a[0]);
  const f = str(a[1]);
  if (isErr(v)) return v;
  if (isErr(f)) return f;
  const n = typeof v === 'string' ? toNum(v) : v;
  if (isErr(n)) return v as string;
  return formatValue(n, f).text;
});
def('Text', 'VALUE(text)', 'Converts text that looks like a number to a number.', '=VALUE("1,250.00")', (a) => {
  const v = scalar(a[0]);
  if (typeof v === 'number') return v;
  return toNum(v);
});
def('Text', 'NUMBERVALUE(text, [decimal_separator], [group_separator])', 'Converts text to a number with explicit separators.', '=NUMBERVALUE("1.250,50", ",", ".")', (a) => {
  const t = str(a[0]);
  const d = str(a[1], '.');
  const g = str(a[2], ',');
  const e = firstErr(t, d, g);
  if (e) return e;
  const s = (t as string).split(g as string).join('').replace(d as string, '.');
  return toNum(s);
});
def('Text', 'FIXED(number, [decimals], [no_commas])', 'Rounds a number and returns it as text.', '=FIXED(1234.567, 1)', (a) => {
  const n = num(a[0]);
  const d = num(a[1], 2);
  const nc = bool(a[2], false);
  const e = firstErr(n, d, nc);
  if (e) return e;
  const dd = Math.max(0, Math.floor(d as number));
  return formatValue(n as number, `${nc ? '0' : '#,##0'}${dd ? `.${'0'.repeat(dd)}` : ''}`).text;
});
def('Text', 'DOLLAR(number, [decimals])', 'A number as currency text.', '=DOLLAR(1234.5)', (a) => {
  const n = num(a[0]);
  const d = num(a[1], 2);
  const e = firstErr(n, d);
  if (e) return e;
  const dd = Math.max(0, Math.floor(d as number));
  return formatValue(n as number, `$#,##0${dd ? `.${'0'.repeat(dd)}` : ''};($#,##0${dd ? `.${'0'.repeat(dd)}` : ''})`).text;
});
def('Text', 'EXACT(text1, text2)', 'TRUE when two texts are exactly the same (case-sensitive).', '=EXACT(A2, B2)', (a) => {
  const x = str(a[0]);
  const y = str(a[1]);
  const e = firstErr(x, y);
  return e ?? x === y;
});
def('Text', 'REPT(text, number_times)', 'Repeats text.', '=REPT("★", B2)', (a) => {
  const t = str(a[0]);
  const n = num(a[1]);
  const e = firstErr(t, n);
  if (e) return e;
  const k = Math.floor(n as number);
  return k < 0 || k * (t as string).length > 32767 ? ERR.value : (t as string).repeat(k);
});
def('Text', 'CHAR(number)', 'The character for a code (1–255).', '=CHAR(65)', (a) => nums2<[number]>([num(a[0])], (n) => (n < 1 || n > 255 ? ERR.value : String.fromCharCode(Math.floor(n)))));
def('Text', 'CODE(text)', 'The code of the first character.', '=CODE("A")', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t ? t.charCodeAt(0) : ERR.value;
});
def('Text', 'UNICHAR(number)', 'The Unicode character for a code point.', '=UNICHAR(9731)', (a) => nums2<[number]>([num(a[0])], (n) => (n < 1 ? ERR.value : String.fromCodePoint(Math.floor(n)))));
def('Text', 'UNICODE(text)', 'The code point of the first character.', '=UNICODE("☃")', (a) => {
  const t = str(a[0]);
  return isErr(t) ? t : t ? (t.codePointAt(0) ?? ERR.value) : ERR.value;
});
def('Text', 'T(value)', 'Text if the value is text, otherwise empty text.', '=T(A2)', (a) => {
  const v = scalar(a[0]);
  return typeof v === 'string' ? v : isErr(v) ? v : '';
});
for (const [nm, after] of [['TEXTBEFORE', false], ['TEXTAFTER', true]] as const) {
  def('Text', `${nm}(text, delimiter, [instance_num])`, `The text ${after ? 'after' : 'before'} a delimiter.`, `=${nm}("jane@example.com", "@")`, (a) => {
    const t = str(a[0]);
    const d = str(a[1]);
    const k = num(a[2], 1);
    const e = firstErr(t, d, k);
    if (e) return e;
    const tt = t as string;
    const dd = d as string;
    const kk = Math.floor(k as number);
    if (!kk) return ERR.value;
    const parts = tt.split(dd);
    if (parts.length - 1 < Math.abs(kk)) return ERR.na;
    const i = kk > 0 ? kk : parts.length - 1 + kk + 1;
    return after ? parts.slice(i).join(dd) : parts.slice(0, i).join(dd);
  });
}
def('Text', 'TEXTSPLIT(text, col_delimiter, [row_delimiter])', 'Splits text into a spilled array.', '=TEXTSPLIT("a,b,c", ",")', (a) => {
  const t = str(a[0]);
  const cd = str(a[1]);
  const rd = a[2] !== undefined ? str(a[2]) : '';
  const e = firstErr(t, cd, rd);
  if (e) return e;
  const rows = (rd ? (t as string).split(rd as string) : [t as string]).map((r) => (cd ? r.split(cd as string) : [r]));
  const w = Math.max(...rows.map((r) => r.length));
  return Arr.of(rows.map((r) => [...r, ...new Array<Scalar>(w - r.length).fill(ERR.na)]));
});

// ───────────────────────────────────────────────────────────────────────────── date & time

def('Date', 'TODAY()', 'Today’s date. Recalculates on every change.', '=TODAY()', (_a, cx) => todaySerial(cx), { volatile: true });
def('Date', 'NOW()', 'The current date and time. Recalculates on every change.', '=NOW()', (_a, cx) => nowSerial(cx), { volatile: true });
def('Date', 'DATE(year, month, day)', 'A date from year, month and day (overflow rolls over).', '=DATE(2026, 12, 31)', (a) =>
  nums2<[number, number, number]>([num(a[0]), num(a[1]), num(a[2])], (y, m, d) => {
    let yy = Math.floor(y);
    if (yy < 1900) yy += 1900;
    const dt = new Date(Date.UTC(yy, Math.floor(m) - 1, Math.floor(d)));
    return dateToSerial(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }));
def('Date', 'TIME(hour, minute, second)', 'A time of day as a fraction of a day.', '=TIME(9, 30, 0)', (a) =>
  nums2<[number, number, number]>([num(a[0]), num(a[1]), num(a[2])], (h, m, s) => (((h * 3600 + m * 60 + s) / 86400) % 1 + 1) % 1));
def('Date', 'DATEVALUE(date_text)', 'Converts a date written as text to a serial number.', '=DATEVALUE("2026-03-01")', (a) => {
  const t = str(a[0]);
  if (isErr(t)) return t;
  const d = parseDateText(t);
  return d === null ? ERR.value : Math.floor(d);
});
def('Date', 'TIMEVALUE(time_text)', 'Converts a time written as text to a fraction of a day.', '=TIMEVALUE("6:45 PM")', (a) => {
  const t = str(a[0]);
  if (isErr(t)) return t;
  const d = parseDateText(t);
  return d === null ? ERR.value : d % 1;
});
for (const [nm, part] of [['YEAR', 'y'], ['MONTH', 'm'], ['DAY', 'd']] as const) {
  def('Date', `${nm}(serial_number)`, `The ${nm.toLowerCase()} of a date.`, `=${nm}(A2)`, (a) => nums2<[number]>([num(a[0])], (s) => (s < 0 ? ERR.num : serialToDate(s)[part])));
}
for (const [nm, div, mod] of [['HOUR', 3600, 24], ['MINUTE', 60, 60], ['SECOND', 1, 60]] as const) {
  def('Date', `${nm}(serial_number)`, `The ${nm.toLowerCase()} of a time.`, `=${nm}(A2)`, (a) =>
    nums2<[number]>([num(a[0])], (s) => Math.floor(Math.round((s % 1) * 86400) / div) % mod));
}
def('Date', 'WEEKDAY(serial_number, [return_type])', 'The day of the week (1 = Sunday by default; type 2: 1 = Monday).', '=WEEKDAY(A2, 2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1], 1)], (s, t) => {
    const { y, m, d } = serialToDate(s);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sunday
    if (t === 2) return ((dow + 6) % 7) + 1;
    if (t === 3) return (dow + 6) % 7;
    return dow + 1;
  }));
def('Date', 'WEEKNUM(serial_number, [return_type])', 'The week number of the year.', '=WEEKNUM(A2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1], 1)], (s, t) => {
    const { y } = serialToDate(s);
    const jan1 = dateToSerial(y, 1, 1);
    const { m: _m, ...rest } = serialToDate(jan1);
    const dow = new Date(Date.UTC(rest.y, 0, 1)).getUTCDay();
    const offset = t === 2 ? (dow + 6) % 7 : dow;
    return Math.floor((Math.floor(s) - jan1 + offset) / 7) + 1;
  }));
def('Date', 'ISOWEEKNUM(date)', 'The ISO week number of the year.', '=ISOWEEKNUM(A2)', (a) =>
  nums2<[number]>([num(a[0])], (s) => {
    const { y, m, d } = serialToDate(s);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const day = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((dt.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  }));
def('Date', 'EDATE(start_date, months)', 'The same day a number of months before or after a date.', '=EDATE(A2, 1)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (s, mo) => {
    const r = addMonths(s, Math.trunc(mo));
    return dateToSerial(r.y, r.m, r.d);
  }));
def('Date', 'EOMONTH(start_date, months)', 'The last day of the month, a number of months away.', '=EOMONTH(TODAY(), 0)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (s, mo) => {
    const r = addMonths(s, Math.trunc(mo));
    const dim = new Date(Date.UTC(r.y, r.m, 0)).getUTCDate();
    return dateToSerial(r.y, r.m, dim);
  }));
def('Date', 'DAYS(end_date, start_date)', 'The number of days between two dates.', '=DAYS(B2, A2)', (a) => nums2<[number, number]>([num(a[0]), num(a[1])], (e, s) => Math.floor(e) - Math.floor(s)));
def('Date', 'DAYS360(start_date, end_date)', 'Days between two dates on a 360-day year.', '=DAYS360(A2, B2)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (s, e) => {
    const x = serialToDate(s);
    const y = serialToDate(e);
    const d1 = Math.min(x.d, 30);
    const d2 = y.d === 31 && d1 === 30 ? 30 : y.d;
    return (y.y - x.y) * 360 + (y.m - x.m) * 30 + (d2 - d1);
  }));
def('Date', 'DATEDIF(start_date, end_date, unit)', 'Whole years ("Y"), months ("M") or days ("D") between dates; also "YM", "MD", "YD".', '=DATEDIF(A2, TODAY(), "Y")', (a) => {
  const s = num(a[0]);
  const e = num(a[1]);
  const u = str(a[2]);
  const er = firstErr(s, e, u);
  if (er) return er;
  if ((s as number) > (e as number)) return ERR.num;
  const x = serialToDate(s as number);
  const y = serialToDate(e as number);
  let months = (y.y - x.y) * 12 + (y.m - x.m);
  if (y.d < x.d) months--;
  switch ((u as string).toUpperCase()) {
    case 'Y': return Math.floor(months / 12);
    case 'M': return months;
    case 'D': return Math.floor(e as number) - Math.floor(s as number);
    case 'YM': return months % 12;
    case 'MD': {
      const prev = addMonths(e as number, -1);
      return y.d >= x.d ? y.d - x.d : Math.floor(e as number) - dateToSerial(prev.y, prev.m, Math.min(x.d, new Date(Date.UTC(prev.y, prev.m, 0)).getUTCDate()));
    }
    case 'YD': {
      let anchor = dateToSerial(y.y, x.m, x.d);
      if (anchor > (e as number)) anchor = dateToSerial(y.y - 1, x.m, x.d);
      return Math.floor(e as number) - anchor;
    }
    default: return ERR.num;
  }
});
function isWeekend(serial: number): boolean {
  const { y, m, d } = serialToDate(serial);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}
def('Date', 'NETWORKDAYS(start_date, end_date, [holidays])', 'Working days (Mon–Fri) between two dates, inclusive.', '=NETWORKDAYS(A2, B2, Holidays)', (a) => {
  const s = num(a[0]);
  const e = num(a[1]);
  const er = firstErr(s, e);
  if (er) return er;
  const hol = new Set(a[2] !== undefined ? (toArr(a[2]).v.filter((v) => typeof v === 'number') as number[]).map(Math.floor) : []);
  let lo = Math.floor(s as number);
  let hi = Math.floor(e as number);
  const sign = lo <= hi ? 1 : -1;
  if (sign < 0) [lo, hi] = [hi, lo];
  let k = 0;
  for (let d = lo; d <= hi; d++) if (!isWeekend(d) && !hol.has(d)) k++;
  return k * sign;
});
def('Date', 'WORKDAY(start_date, days, [holidays])', 'The date a number of working days away.', '=WORKDAY(TODAY(), 10)', (a) => {
  const s = num(a[0]);
  const n = num(a[1]);
  const er = firstErr(s, n);
  if (er) return er;
  const hol = new Set(a[2] !== undefined ? (toArr(a[2]).v.filter((v) => typeof v === 'number') as number[]).map(Math.floor) : []);
  let d = Math.floor(s as number);
  let left = Math.trunc(n as number);
  const step = left >= 0 ? 1 : -1;
  while (left !== 0) {
    d += step;
    if (!isWeekend(d) && !hol.has(d)) left -= step;
  }
  return d;
});
def('Date', 'YEARFRAC(start_date, end_date, [basis])', 'The fraction of a year between two dates (basis 0 = 30/360, 1 = actual).', '=YEARFRAC(A2, B2, 1)', (a) => {
  const s = num(a[0]);
  const e = num(a[1]);
  const b = num(a[2], 0);
  const er = firstErr(s, e, b);
  if (er) return er;
  const [lo, hi] = [Math.min(s as number, e as number), Math.max(s as number, e as number)];
  if (b === 0) {
    const x = serialToDate(lo);
    const y = serialToDate(hi);
    const d1 = Math.min(x.d, 30);
    const d2 = y.d === 31 && d1 === 30 ? 30 : y.d;
    return ((y.y - x.y) * 360 + (y.m - x.m) * 30 + (d2 - d1)) / 360;
  }
  return (hi - lo) / (b === 2 ? 360 : 365);
});

// ───────────────────────────────────────────────────────────────────────────── financial

def('Financial', 'PMT(rate, nper, pv, [fv], [type])', 'The payment for a loan with constant payments and a constant interest rate.', '=PMT(Rate/12, Years*12, -Principal)', (a) =>
  nums2<[number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3], 0), num(a[4], 0)], (r, n, pv, fv, t) =>
    n === 0 ? ERR.num : fin(pmtCore(r, n, pv, fv, t ? 1 : 0))));
def('Financial', 'IPMT(rate, per, nper, pv, [fv], [type])', 'The interest part of a payment for a given period.', '=IPMT(Rate/12, A5, Years*12, -Principal)', (a) =>
  nums2<[number, number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4], 0), num(a[5], 0)], (r, per, n, pv, fv, t) =>
    per < 1 || per > n ? ERR.num : fin(ipmtCore(r, Math.round(per), n, pv, fv, t ? 1 : 0))));
def('Financial', 'PPMT(rate, per, nper, pv, [fv], [type])', 'The principal part of a payment for a given period.', '=PPMT(Rate/12, A5, Years*12, -Principal)', (a) =>
  nums2<[number, number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4], 0), num(a[5], 0)], (r, per, n, pv, fv, t) =>
    per < 1 || per > n ? ERR.num : fin(pmtCore(r, n, pv, fv, t ? 1 : 0) - ipmtCore(r, Math.round(per), n, pv, fv, t ? 1 : 0))));
def('Financial', 'PV(rate, nper, pmt, [fv], [type])', 'The present value of a series of future payments.', '=PV(5%/12, 60, -500)', (a) =>
  nums2<[number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3], 0), num(a[4], 0)], (r, n, pmt, fv, t) => {
    if (r === 0) return -(fv + pmt * n);
    const g = (1 + r) ** n;
    return fin(-(fv + (pmt * (1 + r * (t ? 1 : 0)) * (g - 1)) / r) / g);
  }));
def('Financial', 'FV(rate, nper, pmt, [pv], [type])', 'The future value of an investment with periodic payments.', '=FV(7%/12, 30*12, -500, -10000)', (a) =>
  nums2<[number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3], 0), num(a[4], 0)], (r, n, pmt, pv, t) => fin(fvCore(r, n, pmt, pv, t ? 1 : 0))));
def('Financial', 'NPER(rate, pmt, pv, [fv], [type])', 'The number of periods needed to pay off a loan or reach a goal.', '=NPER(6%/12, -800, 25000)', (a) =>
  nums2<[number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3], 0), num(a[4], 0)], (r, pmt, pv, fv, t) => {
    if (r === 0) return pmt === 0 ? ERR.num : -(pv + fv) / pmt;
    const k = pmt * (1 + r * (t ? 1 : 0));
    const x = (k - fv * r) / (k + pv * r);
    return x <= 0 ? ERR.num : fin(Math.log(x) / Math.log(1 + r));
  }));
def('Financial', 'RATE(nper, pmt, pv, [fv], [type], [guess])', 'The interest rate per period of an annuity.', '=RATE(60, -450, 22000)*12', (a) =>
  nums2<[number, number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3], 0), num(a[4], 0), num(a[5], 0.1)], (n, pmt, pv, fv, t, guess) => {
    let r = guess;
    const f = (x: number) => (x === 0 ? pv + pmt * n + fv : pv * (1 + x) ** n + (pmt * (1 + x * t) * ((1 + x) ** n - 1)) / x + fv);
    for (let i = 0; i < 100; i++) {
      const y = f(r);
      const h = 1e-7;
      const d = (f(r + h) - y) / h;
      if (!Number.isFinite(d) || d === 0) return ERR.num;
      const next = r - y / d;
      if (Math.abs(next - r) < 1e-10) return next;
      r = next;
    }
    return ERR.num;
  }));
def('Financial', 'NPV(rate, value1, [value2], …)', 'The net present value of periodic cash flows (first flow at the end of period 1).', '=NPV(8%, C2:C11) + C1', (a) => {
  const r = num(a[0]);
  if (isErr(r)) return r;
  const n = collectNums(a.slice(1));
  if (isErr(n)) return n;
  return fin(n.reduce((s, x, i) => s + x / (1 + r) ** (i + 1), 0));
}, { min: 2 });
def('Financial', 'XNPV(rate, values, dates)', 'The net present value of cash flows on specific dates.', '=XNPV(8%, B2:B9, A2:A9)', (a) => {
  const r = num(a[0]);
  if (isErr(r)) return r;
  const v = toArr(a[1]).v;
  const d = toArr(a[2]).v;
  if (v.length !== d.length) return ERR.num;
  const d0 = d[0];
  if (typeof d0 !== 'number') return ERR.value;
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    const di = d[i];
    if (typeof x !== 'number' || typeof di !== 'number') return ERR.value;
    s += x / (1 + r) ** ((di - d0) / 365);
  }
  return fin(s);
});
function irrSolve(f: (r: number) => number, guess: number): number | Err {
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(r);
    const h = 1e-7;
    const d = (f(r + h) - y) / h;
    if (!Number.isFinite(d) || d === 0) break;
    const next = r - y / d;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
    if (r <= -1) r = -0.999999;
  }
  // Fallback: bisection on (−0.99, 10).
  let lo = -0.99;
  let hi = 10;
  let flo = f(lo);
  if (flo * f(hi) > 0) return ERR.num;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-10) return mid;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}
def('Financial', 'IRR(values, [guess])', 'The internal rate of return of periodic cash flows.', '=IRR(B2:B12)', (a) => {
  const n = collectNums([a[0]]);
  const g = num(a[1], 0.1);
  const e = firstErr(n, g);
  if (e) return e;
  const v = n as number[];
  if (!v.some((x) => x > 0) || !v.some((x) => x < 0)) return ERR.num;
  return irrSolve((r) => v.reduce((s, x, i) => s + x / (1 + r) ** i, 0), g as number);
});
def('Financial', 'XIRR(values, dates, [guess])', 'The internal rate of return of cash flows on specific dates.', '=XIRR(B2:B9, A2:A9)', (a) => {
  const v = toArr(a[0]).v;
  const d = toArr(a[1]).v;
  const g = num(a[2], 0.1);
  if (isErr(g)) return g;
  if (v.length !== d.length || !v.length) return ERR.num;
  const pairs: [number, number][] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    const di = d[i];
    if (typeof x !== 'number' || typeof di !== 'number') return ERR.value;
    pairs.push([x, di]);
  }
  const d0 = pairs[0][1];
  return irrSolve((r) => pairs.reduce((s, [x, di]) => s + x / (1 + r) ** ((di - d0) / 365), 0), g);
});
def('Financial', 'MIRR(values, finance_rate, reinvest_rate)', 'The modified internal rate of return.', '=MIRR(B2:B12, 6%, 4%)', (a) => {
  const n = collectNums([a[0]]);
  const fr = num(a[1]);
  const rr = num(a[2]);
  const e = firstErr(n, fr, rr);
  if (e) return e;
  const v = n as number[];
  const k = v.length;
  const pvNeg = v.reduce((s, x, i) => s + (x < 0 ? x / (1 + (fr as number)) ** i : 0), 0);
  const fvPos = v.reduce((s, x, i) => s + (x > 0 ? x * (1 + (rr as number)) ** (k - 1 - i) : 0), 0);
  if (!pvNeg || !fvPos) return ERR.div0;
  return (-fvPos / pvNeg) ** (1 / (k - 1)) - 1;
});
for (const [nm, principal] of [['CUMIPMT', false], ['CUMPRINC', true]] as const) {
  def('Financial', `${nm}(rate, nper, pv, start_period, end_period, type)`, `The cumulative ${principal ? 'principal' : 'interest'} paid between two periods.`, `=${nm}(Rate/12, 360, Principal, 1, 12, 0)`, (a) =>
    nums2<[number, number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])], (r, n, pv, s, e, t) => {
      if (r <= 0 || n <= 0 || pv <= 0 || s < 1 || e < s || e > n || (t !== 0 && t !== 1)) return ERR.num;
      const pmt = pmtCore(r, n, pv, 0, t);
      let sum = 0;
      for (let per = Math.ceil(s); per <= Math.floor(e); per++) {
        const ip = ipmtCore(r, per, n, pv, 0, t);
        sum += principal ? pmt - ip : ip;
      }
      return fin(sum);
    }));
}
def('Financial', 'EFFECT(nominal_rate, npery)', 'The effective annual interest rate.', '=EFFECT(5.25%, 12)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (r, n) => (r <= 0 || n < 1 ? ERR.num : (1 + r / Math.floor(n)) ** Math.floor(n) - 1)));
def('Financial', 'NOMINAL(effect_rate, npery)', 'The nominal annual interest rate.', '=NOMINAL(5.38%, 12)', (a) =>
  nums2<[number, number]>([num(a[0]), num(a[1])], (r, n) => (r <= 0 || n < 1 ? ERR.num : Math.floor(n) * ((1 + r) ** (1 / Math.floor(n)) - 1))));
def('Financial', 'SLN(cost, salvage, life)', 'Straight-line depreciation for one period.', '=SLN(30000, 7500, 10)', (a) =>
  nums2<[number, number, number]>([num(a[0]), num(a[1]), num(a[2])], (c, s, l) => (l === 0 ? ERR.div0 : (c - s) / l)));
def('Financial', 'SYD(cost, salvage, life, per)', 'Sum-of-years’-digits depreciation for a period.', '=SYD(30000, 7500, 10, 1)', (a) =>
  nums2<[number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3])], (c, s, l, p) => (l <= 0 ? ERR.num : ((c - s) * (l - p + 1) * 2) / (l * (l + 1)))));
def('Financial', 'DDB(cost, salvage, life, period, [factor])', 'Double-declining balance depreciation for a period.', '=DDB(2400, 300, 10, 1)', (a) =>
  nums2<[number, number, number, number, number]>([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4], 2)], (c, s, l, p, f) => {
    let book = c;
    let dep = 0;
    for (let i = 1; i <= p; i++) {
      dep = Math.min(book * (f / l), Math.max(0, book - s));
      book -= dep;
    }
    return dep;
  }));
def('Financial', 'FVSCHEDULE(principal, schedule)', 'The future value after a schedule of compound rates.', '=FVSCHEDULE(1000, B2:B6)', (a) => {
  const p = num(a[0]);
  const s = collectNums([a[1]]);
  const e = firstErr(p, s);
  if (e) return e;
  return (s as number[]).reduce((acc, r) => acc * (1 + r), p as number);
});
def('Financial', 'PDURATION(rate, pv, fv)', 'Periods needed for an investment to reach a value.', '=PDURATION(5%, 10000, 20000)', (a) =>
  nums2<[number, number, number]>([num(a[0]), num(a[1]), num(a[2])], (r, pv, fv) => (r <= 0 || pv <= 0 || fv <= 0 ? ERR.num : (Math.log(fv) - Math.log(pv)) / Math.log(1 + r))));
def('Financial', 'RRI(nper, pv, fv)', 'The equivalent interest rate for the growth of an investment.', '=RRI(10, 10000, 20000)', (a) =>
  nums2<[number, number, number]>([num(a[0]), num(a[1]), num(a[2])], (n, pv, fv) => (n <= 0 || pv === 0 ? ERR.num : (fv / pv) ** (1 / n) - 1)));

// ───────────────────────────────────────────────────────────────────────────── information

const isfn = (nm: string, desc: string, test: (v: Scalar) => boolean) =>
  def('Information', `${nm}(value)`, desc, `=${nm}(A2)`, (a) => test(scalar(a[0] ?? null)));
isfn('ISBLANK', 'TRUE when the cell is empty.', (v) => v === null);
isfn('ISNUMBER', 'TRUE when the value is a number.', (v) => typeof v === 'number');
isfn('ISTEXT', 'TRUE when the value is text.', (v) => typeof v === 'string');
isfn('ISNONTEXT', 'TRUE when the value is not text.', (v) => typeof v !== 'string');
isfn('ISLOGICAL', 'TRUE when the value is TRUE or FALSE.', (v) => typeof v === 'boolean');
isfn('ISERROR', 'TRUE when the value is any error.', (v) => isErr(v));
isfn('ISERR', 'TRUE when the value is an error other than #N/A.', (v) => isErr(v) && v.code !== '#N/A');
isfn('ISNA', 'TRUE when the value is #N/A.', (v) => isErr(v) && v.code === '#N/A');
def('Information', 'ISEVEN(number)', 'TRUE when the number is even.', '=ISEVEN(A2)', (a) => nums2<[number]>([num(a[0])], (n) => Math.floor(Math.abs(n)) % 2 === 0));
def('Information', 'ISODD(number)', 'TRUE when the number is odd.', '=ISODD(A2)', (a) => nums2<[number]>([num(a[0])], (n) => Math.floor(Math.abs(n)) % 2 === 1));
def('Information', 'ISREF(value)', 'TRUE when the value is a reference.', '=ISREF(A2)', (a) => isArr(a[0]) && !!a[0].origin);
def('Information', 'NA()', 'The #N/A error value.', '=NA()', () => ERR.na);
def('Information', 'N(value)', 'A value converted to a number (text becomes 0).', '=N(A2)', (a) => {
  const v = scalar(a[0]);
  return typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : isErr(v) ? v : 0;
});
def('Information', 'TYPE(value)', 'The type of a value: 1 number, 2 text, 4 logical, 16 error, 64 array.', '=TYPE(A2)', (a) => {
  const v = a[0];
  if (isArr(v) && (v.rows > 1 || v.cols > 1)) return 64;
  const s = scalar(v);
  return typeof s === 'number' || s === null ? 1 : typeof s === 'string' ? 2 : typeof s === 'boolean' ? 4 : 16;
});
def('Information', 'ERROR.TYPE(error_val)', 'A number for an error type.', '=ERROR.TYPE(A2)', (a) => {
  const v = scalar(a[0]);
  if (!isErr(v)) return ERR.na;
  const order = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!'];
  const i = order.indexOf(v.code);
  return i < 0 ? ERR.na : i + 1;
});

// ───────────────────────────────────────────────────────────────────────────── docs

export interface FnDoc {
  name: string;
  category: string;
  signature: string;
  description: string;
  example: string;
  args: FnArgDoc[];
}

/** Every function, sorted by name (`sheet_functions`). */
export function functionDocs(): FnDoc[] {
  return [...FUNCTIONS.values()]
    .map((f) => ({ name: f.name, category: f.category, signature: f.signature, description: f.description, example: f.example, args: f.args }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export { numToText };
