/**
 * Database formula dialect (§14.6, `Dialect::Row`) in TypeScript for the browser preview: lexer, Pratt parser,
 * static checks (unknown functions/properties, arity, with source spans), and an evaluator with Notion-style
 * semantics (division by zero → empty, empty numbers act as 0 in arithmetic, methods as sugar `x.fn(a)` = `fn(x, a)`).
 *
 * Storage form references properties by id — `prop("#<propId>")` — and is re-printed with current names for display
 * (`toStorage` / `toDisplay`).
 */
import {
  addDays, addHours, addMinutes, addMonths, addWeeks, addYears, differenceInCalendarDays, differenceInHours, differenceInMinutes,
  differenceInMonths, differenceInWeeks, differenceInYears, format as dfmt, getISOWeek, isValid,
} from 'date-fns';
import type { Id, Property, RowDTO } from '@/backend/types';
import { formatCurrency, formatNumber } from '@/lib/format';
import { formatDay, formatClock } from './format';
import { optionById, optionsOf, parseDateString, plainText } from './values';

// ───────────────────────────────────────────────────────────────────────────── values

export class FDate {
  constructor(
    readonly ms: number,
    readonly allDay = false,
    readonly endMs: number | null = null,
  ) {}
}
export class FMoney {
  constructor(
    readonly v: number,
    readonly cur: string,
  ) {}
}
export class FRow {
  constructor(
    readonly row: RowDTO,
    readonly props: Property[],
    readonly title: string,
  ) {}
}
export type FValue = number | string | boolean | FDate | FMoney | FRow | FValue[] | null;

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly from = 0,
    readonly to = 0,
  ) {
    super(message);
  }
}

// ───────────────────────────────────────────────────────────────────────────── lexer

type TokKind = 'num' | 'str' | 'ident' | 'op' | 'eof';
interface Tok {
  k: TokKind;
  v: string;
  from: number;
  to: number;
}

const OPS = ['==', '!=', '>=', '<=', '&&', '||', '+', '-', '*', '/', '%', '^', '>', '<', '!', '?', ':', ',', '(', ')', '[', ']', '.'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new FormulaError('Unclosed comment', i, src.length);
      i = end + 2;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      const v = m ? m[0] : ch;
      out.push({ k: 'num', v, from: i, to: i + v.length });
      i += v.length;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '”') {
      const close = ch === '“' ? '”' : ch;
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== close && !(close === '"' && src[j] === '”')) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new FormulaError('Unclosed string', i, src.length);
      out.push({ k: 'str', v: s, from: i, to: j + 1 });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const v = m ? m[0] : ch;
      out.push({ k: 'ident', v, from: i, to: i + v.length });
      i += v.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected character “${ch}”`, i, i + 1);
    out.push({ k: 'op', v: op, from: i, to: i + op.length });
    i += op.length;
  }
  out.push({ k: 'eof', v: '', from: src.length, to: src.length });
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── parser

export type Ast =
  | { k: 'num'; v: number; from: number; to: number }
  | { k: 'str'; v: string; from: number; to: number }
  | { k: 'bool'; v: boolean; from: number; to: number }
  | { k: 'list'; items: Ast[]; from: number; to: number }
  | { k: 'var'; name: string; from: number; to: number }
  | { k: 'prop'; propId: Id; name: string; from: number; to: number }
  | { k: 'call'; name: string; args: Ast[]; from: number; to: number; nameTo: number }
  | { k: 'unary'; op: string; arg: Ast; from: number; to: number }
  | { k: 'bin'; op: string; l: Ast; r: Ast; from: number; to: number }
  | { k: 'tern'; c: Ast; a: Ast; b: Ast; from: number; to: number };

const BIN_PREC: Record<string, number> = {
  '||': 2, or: 2, '&&': 3, and: 3, '==': 4, '!=': 4, '>': 5, '<': 5, '>=': 5, '<=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 8,
};

interface PropResolver {
  (nameOrRef: string): Property | undefined;
}

class Parser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private resolve: PropResolver,
  ) {}
  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  expectOp(v: string): Tok {
    const t = this.next();
    if (t.k !== 'op' || t.v !== v) throw new FormulaError(t.k === 'eof' ? `Expected “${v}”` : `Expected “${v}” but found “${t.v}”`, t.from, Math.max(t.to, t.from + 1));
    return t;
  }
  parse(): Ast {
    const e = this.expr(0);
    const t = this.peek();
    if (t.k !== 'eof') throw new FormulaError(`Unexpected “${t.v}”`, t.from, t.to);
    return e;
  }
  private binOp(t: Tok): string | null {
    if (t.k === 'op' && BIN_PREC[t.v] !== undefined) return t.v;
    if (t.k === 'ident' && (t.v === 'and' || t.v === 'or')) return t.v;
    return null;
  }
  expr(minPrec: number): Ast {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && t.v === '?' && minPrec <= 1) {
        this.next();
        const a = this.expr(0);
        this.expectOp(':');
        const b = this.expr(1);
        left = { k: 'tern', c: left, a, b, from: left.from, to: b.to };
        continue;
      }
      const op = this.binOp(t);
      if (!op) break;
      const prec = BIN_PREC[op];
      if (prec < minPrec) break;
      this.next();
      const right = this.expr(op === '^' ? prec : prec + 1);
      const norm = op === 'and' ? '&&' : op === 'or' ? '||' : op;
      left = { k: 'bin', op: norm, l: left, r: right, from: left.from, to: right.to };
    }
    return left;
  }
  unary(): Ast {
    const t = this.peek();
    if ((t.k === 'op' && (t.v === '-' || t.v === '!' || t.v === '+')) || (t.k === 'ident' && t.v === 'not' && this.toks[this.i + 1]?.v !== '(')) {
      this.next();
      const arg = this.expr(8);
      return { k: 'unary', op: t.v === 'not' ? '!' : t.v, arg, from: t.from, to: arg.to };
    }
    return this.postfix(this.primary());
  }
  postfix(base: Ast): Ast {
    let e = base;
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && t.v === '.') {
        this.next();
        const name = this.next();
        if (name.k !== 'ident') throw new FormulaError('Expected a function name after “.”', name.from, name.to);
        let args: Ast[] = [];
        let end = name.to;
        if (this.peek().k === 'op' && this.peek().v === '(') {
          const r = this.args();
          args = r.args;
          end = r.to;
        }
        if (name.v === 'prop' && e.k === 'var' && e.name === 'current') {
          // current.prop("Amount") — resolved against the related database at runtime
          const a = args[0];
          if (!a || a.k !== 'str') throw new FormulaError('prop() needs a property name in quotes', name.from, end);
          e = { k: 'call', name: '__rowprop', args: [e, a], from: e.from, to: end, nameTo: name.to };
        } else {
          e = { k: 'call', name: name.v, args: [e, ...args], from: e.from, to: end, nameTo: name.to };
        }
        continue;
      }
      if (t.k === 'op' && t.v === '[') {
        this.next();
        const idx = this.expr(0);
        const close = this.expectOp(']');
        e = { k: 'call', name: 'at', args: [e, idx], from: e.from, to: close.to, nameTo: t.to };
        continue;
      }
      break;
    }
    return e;
  }
  args(): { args: Ast[]; to: number } {
    this.expectOp('(');
    const args: Ast[] = [];
    if (this.peek().k === 'op' && this.peek().v === ')') {
      const c = this.next();
      return { args, to: c.to };
    }
    for (;;) {
      args.push(this.expr(0));
      const t = this.next();
      if (t.k === 'op' && t.v === ')') return { args, to: t.to };
      if (!(t.k === 'op' && t.v === ',')) throw new FormulaError(t.k === 'eof' ? 'Missing “)”' : `Expected “,” or “)” but found “${t.v}”`, t.from, Math.max(t.to, t.from + 1));
    }
  }
  primary(): Ast {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { k: 'num', v: Number(t.v), from: t.from, to: t.to };
      case 'str':
        return { k: 'str', v: t.v, from: t.from, to: t.to };
      case 'ident': {
        if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true', from: t.from, to: t.to };
        const nt = this.peek();
        if (nt.k === 'op' && nt.v === '(') {
          const { args, to } = this.args();
          if (t.v === 'prop') {
            const a = args[0];
            if (!a || a.k !== 'str' || args.length !== 1) throw new FormulaError('prop() needs a property name in quotes', t.from, to);
            const p = this.resolve(a.v);
            if (!p) throw new FormulaError(`There is no property called “${a.v.replace(/^#/, '')}”`, a.from, a.to);
            return { k: 'prop', propId: p.id, name: p.name, from: t.from, to };
          }
          return { k: 'call', name: t.v, args, from: t.from, to, nameTo: t.to };
        }
        return { k: 'var', name: t.v, from: t.from, to: t.to };
      }
      case 'op': {
        if (t.v === '(') {
          const e = this.expr(0);
          this.expectOp(')');
          return e;
        }
        if (t.v === '[') {
          const items: Ast[] = [];
          if (this.peek().k === 'op' && this.peek().v === ']') {
            const c = this.next();
            return { k: 'list', items, from: t.from, to: c.to };
          }
          for (;;) {
            items.push(this.expr(0));
            const s = this.next();
            if (s.k === 'op' && s.v === ']') return { k: 'list', items, from: t.from, to: s.to };
            if (!(s.k === 'op' && s.v === ',')) throw new FormulaError('Expected “,” or “]”', s.from, s.to);
          }
        }
        throw new FormulaError(`Unexpected “${t.v}”`, t.from, t.to);
      }
      default:
        throw new FormulaError('The formula ends too early', t.from, t.from + 1);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────── function table

interface FnSpec {
  min: number;
  max: number;
  /** Lazy functions receive raw ASTs (list callbacks, let, if). */
  lazy?: boolean;
  doc: string;
  sig: string;
  group: 'Logic' | 'Text' | 'Numbers' | 'Dates' | 'Lists' | 'Finance';
}

const INF = 99;
export const FUNCTIONS: Record<string, FnSpec> = {
  if: { min: 3, max: 3, lazy: true, group: 'Logic', sig: 'if(condition, then, else)', doc: 'Returns one value when the condition is true, another when false.' },
  ifs: { min: 2, max: INF, lazy: true, group: 'Logic', sig: 'ifs(cond1, value1, cond2, value2, …, else)', doc: 'The value of the first true condition.' },
  empty: { min: 1, max: 1, group: 'Logic', sig: 'empty(value)', doc: 'True when the value is empty (blank text, 0 items, no date).' },
  and: { min: 2, max: INF, group: 'Logic', sig: 'and(a, b, …)', doc: 'True when every argument is true.' },
  or: { min: 2, max: INF, group: 'Logic', sig: 'or(a, b, …)', doc: 'True when any argument is true.' },
  not: { min: 1, max: 1, group: 'Logic', sig: 'not(value)', doc: 'Flips true and false.' },
  equal: { min: 2, max: 2, group: 'Logic', sig: 'equal(a, b)', doc: 'True when both values are equal.' },
  unequal: { min: 2, max: 2, group: 'Logic', sig: 'unequal(a, b)', doc: 'True when the values differ.' },
  let: { min: 3, max: 3, lazy: true, group: 'Logic', sig: 'let(name, value, expression)', doc: 'Names a value for use inside the expression.' },
  lets: { min: 3, max: INF, lazy: true, group: 'Logic', sig: 'lets(a, 1, b, 2, expression)', doc: 'Names several values at once.' },

  length: { min: 1, max: 1, group: 'Text', sig: 'length(text or list)', doc: 'Number of characters, or of items in a list.' },
  contains: { min: 2, max: 2, group: 'Text', sig: 'contains(text, search)', doc: 'True when the text contains the search string.' },
  lower: { min: 1, max: 1, group: 'Text', sig: 'lower(text)', doc: 'Lowercase text.' },
  upper: { min: 1, max: 1, group: 'Text', sig: 'upper(text)', doc: 'Uppercase text.' },
  format: { min: 1, max: 1, group: 'Text', sig: 'format(value)', doc: 'Turns any value into text.' },
  concat: { min: 1, max: INF, group: 'Text', sig: 'concat(a, b, …)', doc: 'Joins text, or combines lists.' },
  join: { min: 2, max: 2, group: 'Text', sig: 'join(list, separator)', doc: 'Joins the items of a list with a separator.' },
  replace: { min: 3, max: 3, group: 'Text', sig: 'replace(text, pattern, replacement)', doc: 'Replaces the first match of a pattern.' },
  replaceAll: { min: 3, max: 3, group: 'Text', sig: 'replaceAll(text, pattern, replacement)', doc: 'Replaces every match of a pattern.' },
  substring: { min: 2, max: 3, group: 'Text', sig: 'substring(text, start, end?)', doc: 'Part of the text between two positions.' },
  test: { min: 2, max: 2, group: 'Text', sig: 'test(text, pattern)', doc: 'True when the text matches the regular expression.' },
  split: { min: 2, max: 2, group: 'Text', sig: 'split(text, separator)', doc: 'Splits text into a list.' },
  trim: { min: 1, max: 1, group: 'Text', sig: 'trim(text)', doc: 'Removes spaces at both ends.' },

  min: { min: 1, max: INF, group: 'Numbers', sig: 'min(a, b, …)', doc: 'The smallest number.' },
  max: { min: 1, max: INF, group: 'Numbers', sig: 'max(a, b, …)', doc: 'The largest number.' },
  sum: { min: 1, max: INF, group: 'Numbers', sig: 'sum(a, b, …)', doc: 'Adds numbers or a list of numbers.' },
  mean: { min: 1, max: INF, group: 'Numbers', sig: 'mean(a, b, …)', doc: 'The average.' },
  median: { min: 1, max: INF, group: 'Numbers', sig: 'median(a, b, …)', doc: 'The middle value.' },
  abs: { min: 1, max: 1, group: 'Numbers', sig: 'abs(number)', doc: 'Absolute value.' },
  round: { min: 1, max: 2, group: 'Numbers', sig: 'round(number, places?)', doc: 'Rounds to the nearest whole number (or decimal places).' },
  ceil: { min: 1, max: 1, group: 'Numbers', sig: 'ceil(number)', doc: 'Rounds up.' },
  floor: { min: 1, max: 1, group: 'Numbers', sig: 'floor(number)', doc: 'Rounds down.' },
  sqrt: { min: 1, max: 1, group: 'Numbers', sig: 'sqrt(number)', doc: 'Square root.' },
  pow: { min: 2, max: 2, group: 'Numbers', sig: 'pow(base, exponent)', doc: 'Raises to a power.' },
  mod: { min: 2, max: 2, group: 'Numbers', sig: 'mod(a, b)', doc: 'Remainder after division.' },
  toNumber: { min: 1, max: 1, group: 'Numbers', sig: 'toNumber(value)', doc: 'Converts text, dates or booleans to a number.' },

  now: { min: 0, max: 0, group: 'Dates', sig: 'now()', doc: 'The current date and time.' },
  today: { min: 0, max: 0, group: 'Dates', sig: 'today()', doc: "Today's date." },
  year: { min: 1, max: 1, group: 'Dates', sig: 'year(date)', doc: 'The year.' },
  month: { min: 1, max: 1, group: 'Dates', sig: 'month(date)', doc: 'The month (1–12).' },
  day: { min: 1, max: 1, group: 'Dates', sig: 'day(date)', doc: 'The day of the month (1–31).' },
  week: { min: 1, max: 1, group: 'Dates', sig: 'week(date)', doc: 'The ISO week number.' },
  hour: { min: 1, max: 1, group: 'Dates', sig: 'hour(date)', doc: 'The hour (0–23).' },
  minute: { min: 1, max: 1, group: 'Dates', sig: 'minute(date)', doc: 'The minute (0–59).' },
  dateAdd: { min: 3, max: 3, group: 'Dates', sig: 'dateAdd(date, amount, "days")', doc: 'Adds minutes, hours, days, weeks, months or years.' },
  dateSubtract: { min: 3, max: 3, group: 'Dates', sig: 'dateSubtract(date, amount, "days")', doc: 'Subtracts a duration.' },
  dateBetween: { min: 3, max: 3, group: 'Dates', sig: 'dateBetween(a, b, "days")', doc: 'Time between two dates in the given unit.' },
  dateStart: { min: 1, max: 1, group: 'Dates', sig: 'dateStart(date)', doc: 'The start of a date range.' },
  dateEnd: { min: 1, max: 1, group: 'Dates', sig: 'dateEnd(date)', doc: 'The end of a date range.' },
  formatDate: { min: 2, max: 2, group: 'Dates', sig: 'formatDate(date, "MMM d, yyyy")', doc: 'Formats a date with a pattern.' },
  parseDate: { min: 1, max: 1, group: 'Dates', sig: 'parseDate("2026-11-26")', doc: 'Reads an ISO date from text.' },
  timestamp: { min: 1, max: 1, group: 'Dates', sig: 'timestamp(date)', doc: 'Milliseconds since 1970.' },
  fromTimestamp: { min: 1, max: 1, group: 'Dates', sig: 'fromTimestamp(ms)', doc: 'A date from milliseconds since 1970.' },

  at: { min: 2, max: 2, group: 'Lists', sig: 'at(list, index)', doc: 'The item at a position (0-based; negative counts from the end).' },
  first: { min: 1, max: 1, group: 'Lists', sig: 'first(list)', doc: 'The first item.' },
  last: { min: 1, max: 1, group: 'Lists', sig: 'last(list)', doc: 'The last item.' },
  slice: { min: 2, max: 3, group: 'Lists', sig: 'slice(list, start, end?)', doc: 'Part of a list.' },
  sort: { min: 1, max: 1, group: 'Lists', sig: 'sort(list)', doc: 'Sorts a list.' },
  reverse: { min: 1, max: 1, group: 'Lists', sig: 'reverse(list)', doc: 'Reverses a list.' },
  unique: { min: 1, max: 1, group: 'Lists', sig: 'unique(list)', doc: 'Removes duplicates.' },
  includes: { min: 2, max: 2, group: 'Lists', sig: 'includes(list, value)', doc: 'True when the list contains the value.' },
  filter: { min: 2, max: 2, lazy: true, group: 'Lists', sig: 'filter(list, condition)', doc: 'Items where the condition (using current) is true.' },
  map: { min: 2, max: 2, lazy: true, group: 'Lists', sig: 'map(list, expression)', doc: 'Transforms each item (use current and index).' },
  find: { min: 2, max: 2, lazy: true, group: 'Lists', sig: 'find(list, condition)', doc: 'The first item matching the condition.' },
  some: { min: 2, max: 2, lazy: true, group: 'Lists', sig: 'some(list, condition)', doc: 'True when any item matches.' },
  every: { min: 2, max: 2, lazy: true, group: 'Lists', sig: 'every(list, condition)', doc: 'True when all items match.' },
  count: { min: 1, max: 2, lazy: true, group: 'Lists', sig: 'count(list, condition?)', doc: 'Number of items (matching the condition).' },
  flat: { min: 1, max: 1, group: 'Lists', sig: 'flat(list)', doc: 'Flattens nested lists.' },

  pmt: { min: 3, max: 5, group: 'Finance', sig: 'pmt(rate, periods, presentValue, futureValue?, type?)', doc: 'Payment per period for a loan.' },
  fv: { min: 3, max: 5, group: 'Finance', sig: 'fv(rate, periods, payment, presentValue?, type?)', doc: 'Future value of an investment.' },
  pv: { min: 3, max: 5, group: 'Finance', sig: 'pv(rate, periods, payment, futureValue?, type?)', doc: 'Present value of future payments.' },
  npv: { min: 2, max: INF, group: 'Finance', sig: 'npv(rate, cashflows…)', doc: 'Net present value of cash flows.' },
  irr: { min: 1, max: 2, group: 'Finance', sig: 'irr(cashflows, guess?)', doc: 'Internal rate of return.' },
  fx: { min: 2, max: 2, group: 'Finance', sig: 'fx("USD", "EUR")', doc: 'Exchange rate (cached; marked stale offline).' },
};

const LIST_CALLBACK = new Set(['filter', 'map', 'find', 'some', 'every', 'count']);

// ───────────────────────────────────────────────────────────────────────────── storage form

const PROP_RE = /prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;

export function propResolver(props: Property[]): PropResolver {
  return (ref) => {
    if (ref.startsWith('#')) return props.find((p) => p.id === ref.slice(1));
    return props.find((p) => p.name === ref) ?? props.find((p) => p.name.toLowerCase() === ref.toLowerCase());
  };
}

/** Names → `prop("#id")` (unknown names are kept so the check can point at them). */
export function toStorage(expr: string, props: Property[]): string {
  const r = propResolver(props);
  return expr.replace(PROP_RE, (all, name: string) => {
    const p = r(name.replace(/\\"/g, '"'));
    return p ? `prop("#${p.id}")` : all;
  });
}

/** `prop("#id")` → current names. */
export function toDisplay(expr: string, props: Property[]): string {
  return expr.replace(PROP_RE, (all, ref: string) => {
    if (!ref.startsWith('#')) return all;
    const p = props.find((x) => x.id === ref.slice(1));
    return p ? `prop("${p.name.replace(/"/g, '\\"')}")` : all;
  });
}

// ───────────────────────────────────────────────────────────────────────────── compile

export interface Compiled {
  ast: Ast;
  /** Property ids referenced directly. */
  deps: Set<Id>;
  usesNow: boolean;
}

function walk(a: Ast, fn: (a: Ast) => void): void {
  fn(a);
  switch (a.k) {
    case 'list':
      a.items.forEach((x) => walk(x, fn));
      break;
    case 'call':
      a.args.forEach((x) => walk(x, fn));
      break;
    case 'unary':
      walk(a.arg, fn);
      break;
    case 'bin':
      walk(a.l, fn);
      walk(a.r, fn);
      break;
    case 'tern':
      walk(a.c, fn);
      walk(a.a, fn);
      walk(a.b, fn);
      break;
    default:
      break;
  }
}

function check(a: Ast, vars: Set<string>): void {
  switch (a.k) {
    case 'var':
      if (!vars.has(a.name)) {
        if (FUNCTIONS[a.name]) throw new FormulaError(`${a.name} is a function — add parentheses: ${a.name}()`, a.from, a.to);
        throw new FormulaError(`Unknown name “${a.name}”`, a.from, a.to);
      }
      return;
    case 'call': {
      if (a.name === '__rowprop') return;
      const spec = FUNCTIONS[a.name];
      if (!spec) throw new FormulaError(`Unknown function “${a.name}”`, a.from, a.nameTo);
      if (a.args.length < spec.min || a.args.length > spec.max) {
        const want = spec.min === spec.max ? `${spec.min}` : spec.max >= INF ? `at least ${spec.min}` : `${spec.min}–${spec.max}`;
        throw new FormulaError(`${a.name}() takes ${want} argument${spec.min === 1 && spec.max === 1 ? '' : 's'}: ${spec.sig}`, a.from, a.to);
      }
      if (a.name === 'let' || a.name === 'lets') {
        const scope = new Set(vars);
        for (let i = 0; i + 1 < a.args.length; i += 2) {
          const n = a.args[i];
          if (n.k !== 'var') throw new FormulaError('Expected a name to bind', n.from, n.to);
          check(a.args[i + 1], scope);
          scope.add(n.name);
        }
        check(a.args[a.args.length - 1], scope);
        return;
      }
      if (LIST_CALLBACK.has(a.name)) {
        check(a.args[0], vars);
        const scope = new Set([...vars, 'current', 'index']);
        for (const x of a.args.slice(1)) check(x, scope);
        return;
      }
      a.args.forEach((x) => check(x, vars));
      return;
    }
    case 'list':
      a.items.forEach((x) => check(x, vars));
      return;
    case 'unary':
      check(a.arg, vars);
      return;
    case 'bin':
      check(a.l, vars);
      check(a.r, vars);
      return;
    case 'tern':
      check(a.c, vars);
      check(a.a, vars);
      check(a.b, vars);
      return;
    default:
      return;
  }
}

export function compile(expr: string, props: Property[]): Compiled {
  if (expr.length > 8192) throw new FormulaError('This formula is too long (8,192 characters max)', 0, expr.length);
  if (!expr.trim()) throw new FormulaError('Write a formula', 0, 0);
  const ast = new Parser(lex(expr), propResolver(props)).parse();
  check(ast, new Set());
  const deps = new Set<Id>();
  let usesNow = false;
  walk(ast, (n) => {
    if (n.k === 'prop') deps.add(n.propId);
    if (n.k === 'call' && (n.name === 'now' || n.name === 'today')) usesNow = true;
  });
  return { ast, deps, usesNow };
}

// ───────────────────────────────────────────────────────────────────────────── evaluate

export interface FormulaHost {
  now: number;
  /** Value of a property for a row (the host evaluates nested formulas / rollups with cycle detection). */
  value(row: RowDTO, prop: Property): FValue;
  /** Related row (for relation lists and `current.prop("…")`). */
  resolveRow(id: Id): FRow | null;
  fxRate?(from: string, to: string): number | null;
}

interface Scope {
  vars: Map<string, FValue>;
  row: RowDTO;
  props: Property[];
}

const isList = (v: FValue): v is FValue[] => Array.isArray(v);

export function toNum(v: FValue): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof FMoney) return v.v;
  if (v instanceof FDate) return v.ms;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  if (isList(v)) return v.length;
  return NaN;
}

function toBool(v: FValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof FMoney) return v.v !== 0;
  if (isList(v)) return v.length > 0;
  return true;
}

export function toText(v: FValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : formatNumber(v, { maximumFractionDigits: 6, useGrouping: false });
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof FMoney) return formatCurrency(v.v, v.cur);
  if (v instanceof FDate) return v.allDay ? formatDay(v.ms, 'full') : `${formatDay(v.ms, 'full')} ${formatClock(v.ms)}`;
  if (v instanceof FRow) return v.title;
  if (isList(v)) return v.map(toText).join(', ');
  return '';
}

function isEmptyV(v: FValue): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (isList(v)) return v.length === 0;
  if (typeof v === 'number') return Number.isNaN(v);
  return false;
}

function eqV(a: FValue, b: FValue): boolean {
  if (a instanceof FDate && b instanceof FDate) return a.ms === b.ms;
  if (a instanceof FMoney || b instanceof FMoney) return toNum(a) === toNum(b);
  if (a instanceof FRow && b instanceof FRow) return a.row.id === b.row.id;
  if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => eqV(x, b[i]));
  if (typeof a === 'number' || typeof b === 'number') return toNum(a) === toNum(b);
  return toText(a) === toText(b);
}

function cmpV(a: FValue, b: FValue): number {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return toNum(a) - toNum(b);
}

function cur(...vs: FValue[]): string | null {
  for (const v of vs) if (v instanceof FMoney) return v.cur;
  return null;
}
function wrap(n: number, c: string | null): FValue {
  if (!Number.isFinite(n)) return null;
  return c ? new FMoney(n, c) : n;
}

function flatNums(args: FValue[]): FValue[] {
  const out: FValue[] = [];
  for (const a of args) if (isList(a)) out.push(...flatNums(a));
  else if (a !== null) out.push(a);
  return out;
}

function toDate(v: FValue, at: Ast): FDate {
  if (v instanceof FDate) return v;
  if (typeof v === 'number') return new FDate(v);
  if (typeof v === 'string') {
    const t = parseDateString(v);
    if (t !== null) return new FDate(t, /^\d{4}-\d{2}-\d{2}$/.test(v));
  }
  throw new FormulaError('Expected a date', at.from, at.to);
}

function regex(src: string, flags: string, at: Ast): RegExp {
  if (src.length > 512) throw new FormulaError('Pattern is too long', at.from, at.to);
  try {
    return new RegExp(src, flags);
  } catch {
    throw new FormulaError('Invalid pattern', at.from, at.to);
  }
}

function addUnit(d: FDate, n: number, unit: string, at: Ast): FDate {
  const u = unit.toLowerCase().replace(/s$/, '');
  const base = new Date(d.ms);
  let r: Date;
  switch (u) {
    case 'minute':
      r = addMinutes(base, n);
      break;
    case 'hour':
      r = addHours(base, n);
      break;
    case 'day':
      r = addDays(base, n);
      break;
    case 'week':
      r = addWeeks(base, n);
      break;
    case 'month':
      r = addMonths(base, n);
      break;
    case 'year':
      r = addYears(base, n);
      break;
    case 'quarter':
      r = addMonths(base, n * 3);
      break;
    default:
      throw new FormulaError(`Unknown unit “${unit}” — use days, weeks, months or years`, at.from, at.to);
  }
  return new FDate(r.getTime(), d.allDay);
}

function between(a: FDate, b: FDate, unit: string, at: Ast): number {
  const x = new Date(a.ms);
  const y = new Date(b.ms);
  switch (unit.toLowerCase().replace(/s$/, '')) {
    case 'minute':
      return differenceInMinutes(x, y);
    case 'hour':
      return differenceInHours(x, y);
    case 'day':
      return differenceInCalendarDays(x, y);
    case 'week':
      return differenceInWeeks(x, y);
    case 'month':
      return differenceInMonths(x, y);
    case 'year':
      return differenceInYears(x, y);
    default:
      throw new FormulaError(`Unknown unit “${unit}”`, at.from, at.to);
  }
}

function finance(name: string, n: number[]): number | null {
  const [rate, nper, a, b = 0, type = 0] = n;
  switch (name) {
    case 'pmt': {
      const pv = a;
      const fv = b;
      if (rate === 0) return -(pv + fv) / nper;
      const f = Math.pow(1 + rate, nper);
      return -((rate * (pv * f + fv)) / ((1 + rate * type) * (f - 1)));
    }
    case 'fv': {
      const pmt = a;
      const pv = b;
      if (rate === 0) return -(pv + pmt * nper);
      const f = Math.pow(1 + rate, nper);
      return -(pv * f + (pmt * (1 + rate * type) * (f - 1)) / rate);
    }
    case 'pv': {
      const pmt = a;
      const fv = b;
      if (rate === 0) return -(fv + pmt * nper);
      const f = Math.pow(1 + rate, nper);
      return -(fv + (pmt * (1 + rate * type) * (f - 1)) / rate) / f;
    }
    default:
      return null;
  }
}

function irr(flows: number[], guess = 0.1): number | null {
  let r = guess;
  for (let i = 0; i < 64; i++) {
    let f = 0;
    let df = 0;
    for (let t = 0; t < flows.length; t++) {
      const d = Math.pow(1 + r, t);
      f += flows[t] / d;
      df -= (t * flows[t]) / (d * (1 + r));
    }
    if (Math.abs(df) < 1e-12) return null;
    const next = r - f / df;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  return null;
}

const MAX_STEPS = 200_000;

export function evaluate(c: Compiled, row: RowDTO, props: Property[], host: FormulaHost): FValue {
  let steps = 0;
  const ev = (a: Ast, s: Scope): FValue => {
    if (++steps > MAX_STEPS) throw new FormulaError('This formula does too much work', a.from, a.to);
    switch (a.k) {
      case 'num':
        return a.v;
      case 'str':
        return a.v;
      case 'bool':
        return a.v;
      case 'list':
        return a.items.map((x) => ev(x, s));
      case 'var': {
        if (s.vars.has(a.name)) return s.vars.get(a.name) ?? null;
        throw new FormulaError(`Unknown name “${a.name}”`, a.from, a.to);
      }
      case 'prop': {
        const p = s.props.find((x) => x.id === a.propId);
        if (!p) throw new FormulaError(`Property “${a.name}” was deleted`, a.from, a.to);
        return host.value(s.row, p);
      }
      case 'unary': {
        const v = ev(a.arg, s);
        if (a.op === '!') return !toBool(v);
        if (a.op === '-') return wrap(-toNum(v), cur(v));
        return v;
      }
      case 'tern':
        return toBool(ev(a.c, s)) ? ev(a.a, s) : ev(a.b, s);
      case 'bin': {
        if (a.op === '&&') return toBool(ev(a.l, s)) && toBool(ev(a.r, s));
        if (a.op === '||') return toBool(ev(a.l, s)) || toBool(ev(a.r, s));
        const l = ev(a.l, s);
        const r = ev(a.r, s);
        switch (a.op) {
          case '+': {
            if (typeof l === 'string' || typeof r === 'string') return toText(l) + toText(r);
            if (isList(l) && isList(r)) return [...l, ...r];
            if (l instanceof FDate && typeof r === 'number') return new FDate(l.ms + r, l.allDay);
            return wrap(toNum(l) + toNum(r), cur(l, r));
          }
          case '-':
            if (l instanceof FDate && r instanceof FDate) return l.ms - r.ms;
            return wrap(toNum(l) - toNum(r), cur(l, r));
          case '*':
            return wrap(toNum(l) * toNum(r), cur(l, r));
          case '/': {
            const d = toNum(r);
            if (d === 0 || r === null) return null;
            return wrap(toNum(l) / d, l instanceof FMoney && !(r instanceof FMoney) ? l.cur : null);
          }
          case '%': {
            const d = toNum(r);
            if (d === 0) return null;
            return wrap(toNum(l) % d, cur(l));
          }
          case '^':
            return wrap(Math.pow(toNum(l), toNum(r)), null);
          case '==':
            return eqV(l, r);
          case '!=':
            return !eqV(l, r);
          case '>':
            return cmpV(l, r) > 0;
          case '<':
            return cmpV(l, r) < 0;
          case '>=':
            return cmpV(l, r) >= 0;
          case '<=':
            return cmpV(l, r) <= 0;
          default:
            throw new FormulaError(`Unknown operator ${a.op}`, a.from, a.to);
        }
      }
      case 'call':
        return call(a, s);
      default:
        return null;
    }
  };

  const listArg = (v: FValue): FValue[] => (isList(v) ? v : v === null ? [] : [v]);

  const callback = (a: Extract<Ast, { k: 'call' }>, s: Scope) => {
    const list = listArg(ev(a.args[0], s));
    const body = a.args[1];
    const run = (item: FValue, i: number) => {
      const vars = new Map(s.vars);
      vars.set('current', item);
      vars.set('index', i);
      return ev(body, { ...s, vars });
    };
    return { list, run, body };
  };

  const call = (a: Extract<Ast, { k: 'call' }>, s: Scope): FValue => {
    const n = a.name;
    // lazy forms first
    switch (n) {
      case 'if':
        return toBool(ev(a.args[0], s)) ? ev(a.args[1], s) : ev(a.args[2], s);
      case 'ifs': {
        let i = 0;
        for (; i + 1 < a.args.length; i += 2) if (toBool(ev(a.args[i], s))) return ev(a.args[i + 1], s);
        return i < a.args.length ? ev(a.args[i], s) : null;
      }
      case 'let':
      case 'lets': {
        const vars = new Map(s.vars);
        for (let i = 0; i + 1 < a.args.length; i += 2) {
          const nm = a.args[i];
          if (nm.k !== 'var') throw new FormulaError('Expected a name', nm.from, nm.to);
          vars.set(nm.name, ev(a.args[i + 1], { ...s, vars }));
        }
        return ev(a.args[a.args.length - 1], { ...s, vars });
      }
      case 'filter': {
        const { list, run } = callback(a, s);
        return list.filter((x, i) => toBool(run(x, i)));
      }
      case 'map': {
        const { list, run } = callback(a, s);
        return list.map((x, i) => run(x, i));
      }
      case 'find': {
        const { list, run } = callback(a, s);
        return list.find((x, i) => toBool(run(x, i))) ?? null;
      }
      case 'some': {
        const { list, run } = callback(a, s);
        return list.some((x, i) => toBool(run(x, i)));
      }
      case 'every': {
        const { list, run } = callback(a, s);
        return list.every((x, i) => toBool(run(x, i)));
      }
      case 'count': {
        if (a.args.length === 1) return listArg(ev(a.args[0], s)).length;
        const { list, run } = callback(a, s);
        return list.filter((x, i) => toBool(run(x, i))).length;
      }
      case '__rowprop': {
        const target = ev(a.args[0], s);
        const nameAst = a.args[1];
        const name = nameAst.k === 'str' ? nameAst.v : '';
        if (!(target instanceof FRow)) return null;
        const p = propResolver(target.props)(name);
        if (!p) throw new FormulaError(`The related database has no property “${name}”`, nameAst.from, nameAst.to);
        return host.value(target.row, p);
      }
      default:
        break;
    }
    const v = a.args.map((x) => ev(x, s));
    const at = (i: number) => a.args[i] ?? a;
    switch (n) {
      case 'empty':
        return isEmptyV(v[0]);
      case 'and':
        return v.every(toBool);
      case 'or':
        return v.some(toBool);
      case 'not':
        return !toBool(v[0]);
      case 'equal':
        return eqV(v[0], v[1]);
      case 'unequal':
        return !eqV(v[0], v[1]);
      case 'length':
        return isList(v[0]) ? v[0].length : toText(v[0]).length;
      case 'contains':
        return isList(v[0]) ? v[0].some((x) => eqV(x, v[1])) : toText(v[0]).includes(toText(v[1]));
      case 'lower':
        return toText(v[0]).toLowerCase();
      case 'upper':
        return toText(v[0]).toUpperCase();
      case 'format':
        return toText(v[0]);
      case 'concat':
        return v.every(isList) ? v.flatMap((x) => x as FValue[]) : v.map(toText).join('');
      case 'join':
        return listArg(v[0]).map(toText).join(toText(v[1]));
      case 'replace':
        return toText(v[0]).replace(regex(toText(v[1]), '', at(1)), toText(v[2]));
      case 'replaceAll':
        return toText(v[0]).replace(regex(toText(v[1]), 'g', at(1)), toText(v[2]));
      case 'substring': {
        const t = toText(v[0]);
        return t.substring(toNum(v[1]), v.length > 2 ? toNum(v[2]) : t.length);
      }
      case 'test':
        return regex(toText(v[1]), '', at(1)).test(toText(v[0]));
      case 'split':
        return toText(v[0]).split(toText(v[1]));
      case 'trim':
        return toText(v[0]).trim();
      case 'min':
      case 'max':
      case 'sum':
      case 'mean':
      case 'median': {
        const xs = flatNums(v);
        const c = cur(...xs);
        const ns = xs.map(toNum).filter((x) => Number.isFinite(x));
        if (!ns.length) return n === 'sum' ? wrap(0, c) : null;
        if (n === 'min') return wrap(Math.min(...ns), c);
        if (n === 'max') return wrap(Math.max(...ns), c);
        const total = ns.reduce((p, q) => p + q, 0);
        if (n === 'sum') return wrap(total, c);
        if (n === 'mean') return wrap(total / ns.length, c);
        const sorted = [...ns].sort((p, q) => p - q);
        const m = Math.floor(sorted.length / 2);
        return wrap(sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2, c);
      }
      case 'abs':
        return wrap(Math.abs(toNum(v[0])), cur(v[0]));
      case 'round': {
        const places = v.length > 1 ? Math.max(0, Math.min(10, Math.trunc(toNum(v[1])))) : 0;
        const f = Math.pow(10, places);
        return wrap(Math.round(toNum(v[0]) * f) / f, cur(v[0]));
      }
      case 'ceil':
        return wrap(Math.ceil(toNum(v[0])), cur(v[0]));
      case 'floor':
        return wrap(Math.floor(toNum(v[0])), cur(v[0]));
      case 'sqrt': {
        const x = toNum(v[0]);
        return x < 0 ? null : Math.sqrt(x);
      }
      case 'pow':
        return wrap(Math.pow(toNum(v[0]), toNum(v[1])), null);
      case 'mod': {
        const d = toNum(v[1]);
        return d === 0 ? null : toNum(v[0]) % d;
      }
      case 'toNumber': {
        const x = toNum(v[0]);
        return Number.isFinite(x) ? x : null;
      }
      case 'now':
        return new FDate(host.now);
      case 'today': {
        const d = new Date(host.now);
        return new FDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), true);
      }
      case 'year':
        return new Date(toDate(v[0], at(0)).ms).getFullYear();
      case 'month':
        return new Date(toDate(v[0], at(0)).ms).getMonth() + 1;
      case 'day':
        return new Date(toDate(v[0], at(0)).ms).getDate();
      case 'week':
        return getISOWeek(new Date(toDate(v[0], at(0)).ms));
      case 'hour':
        return new Date(toDate(v[0], at(0)).ms).getHours();
      case 'minute':
        return new Date(toDate(v[0], at(0)).ms).getMinutes();
      case 'dateAdd':
        return v[0] === null ? null : addUnit(toDate(v[0], at(0)), toNum(v[1]), toText(v[2]), at(2));
      case 'dateSubtract':
        return v[0] === null ? null : addUnit(toDate(v[0], at(0)), -toNum(v[1]), toText(v[2]), at(2));
      case 'dateBetween':
        if (v[0] === null || v[1] === null) return null;
        return between(toDate(v[0], at(0)), toDate(v[1], at(1)), toText(v[2]), at(2));
      case 'dateStart':
        return v[0] === null ? null : new FDate(toDate(v[0], at(0)).ms, toDate(v[0], at(0)).allDay);
      case 'dateEnd': {
        if (v[0] === null) return null;
        const d = toDate(v[0], at(0));
        return new FDate(d.endMs ?? d.ms, d.allDay);
      }
      case 'formatDate': {
        if (v[0] === null) return '';
        const d = new Date(toDate(v[0], at(0)).ms);
        try {
          return dfmt(d, toText(v[1]) || 'MMM d, yyyy');
        } catch {
          throw new FormulaError('Invalid date pattern', at(1).from, at(1).to);
        }
      }
      case 'parseDate': {
        const t = parseDateString(toText(v[0]));
        return t === null ? null : new FDate(t, /^\d{4}-\d{2}-\d{2}$/.test(toText(v[0])));
      }
      case 'timestamp':
        return v[0] === null ? null : toDate(v[0], at(0)).ms;
      case 'fromTimestamp': {
        const d = new Date(toNum(v[0]));
        return isValid(d) ? new FDate(d.getTime()) : null;
      }
      case 'at': {
        const l = listArg(v[0]);
        const i = Math.trunc(toNum(v[1]));
        return l[i < 0 ? l.length + i : i] ?? null;
      }
      case 'first':
        return listArg(v[0])[0] ?? null;
      case 'last': {
        const l = listArg(v[0]);
        return l[l.length - 1] ?? null;
      }
      case 'slice':
        return listArg(v[0]).slice(toNum(v[1]), v.length > 2 ? toNum(v[2]) : undefined);
      case 'sort':
        return [...listArg(v[0])].sort(cmpV);
      case 'reverse':
        return [...listArg(v[0])].reverse();
      case 'unique': {
        const out: FValue[] = [];
        for (const x of listArg(v[0])) if (!out.some((y) => eqV(x, y))) out.push(x);
        return out;
      }
      case 'includes':
        return listArg(v[0]).some((x) => eqV(x, v[1]));
      case 'flat':
        return listArg(v[0]).flatMap((x) => (isList(x) ? x : [x]));
      case 'pmt':
      case 'fv':
      case 'pv':
        return finance(n, v.map(toNum));
      case 'npv': {
        const rate = toNum(v[0]);
        const flows = flatNums(v.slice(1)).map(toNum);
        return flows.reduce((acc, f, i) => acc + f / Math.pow(1 + rate, i + 1), 0);
      }
      case 'irr':
        return irr(flatNums([v[0]]).map(toNum), v.length > 1 ? toNum(v[1]) : 0.1);
      case 'fx': {
        const from = toText(v[0]).toUpperCase();
        const to = toText(v[1]).toUpperCase();
        if (from === to) return 1;
        return host.fxRate?.(from, to) ?? null;
      }
      default:
        throw new FormulaError(`Unknown function “${n}”`, a.from, a.nameTo);
    }
  };

  return ev(c.ast, { vars: new Map(), row, props });
}

// ───────────────────────────────────────────────────────────────────────────── results

export type ResultKind = 'number' | 'money' | 'text' | 'bool' | 'date' | 'list' | 'error';

export function kindOf(v: FValue): ResultKind | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'text';
  if (typeof v === 'boolean') return 'bool';
  if (v instanceof FMoney) return 'money';
  if (v instanceof FDate) return 'date';
  if (v instanceof FRow) return 'text';
  return 'list';
}

/** Serializable cell form: `{kind, value, display}` (value is JSON-safe). */
export function toComputed(v: FValue, kindHint?: ResultKind): { kind: ResultKind; value: unknown; display: string } {
  const kind = kindOf(v) ?? kindHint ?? 'text';
  if (v === null) return { kind, value: null, display: '' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { kind: 'number', value: null, display: '' };
    return { kind: 'number', value: v, display: formatNumber(v, { maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 }) };
  }
  if (typeof v === 'boolean') return { kind: 'bool', value: v, display: v ? 'Yes' : 'No' };
  if (v instanceof FMoney) return { kind: 'money', value: v.v, display: formatCurrency(v.v, v.cur) };
  if (v instanceof FDate) return { kind: 'date', value: v.ms, display: toText(v) };
  if (v instanceof FRow) return { kind: 'text', value: v.title, display: v.title };
  if (Array.isArray(v)) return { kind: 'list', value: v.map((x) => (x instanceof FRow ? x.title : toText(x))), display: toText(v) };
  return { kind: 'text', value: v, display: v };
}

/** Converts a stored cell into a formula value (relations need the host). */
export function cellToValue(row: RowDTO, p: Property, host: Pick<FormulaHost, 'resolveRow'>): FValue {
  const c = p.type === 'created_time' ? ({ t: 'ts', v: row.createdAt } as const) : p.type === 'updated_time' ? ({ t: 'ts', v: row.updatedAt } as const) : row.values[p.id];
  if (!c) {
    if (p.type === 'checkbox') return false;
    if (p.type === 'multi_select' || p.type === 'relation' || p.type === 'files') return [];
    return null;
  }
  switch (c.t) {
    case 'text':
      return plainText(c.v);
    case 'number':
    case 'rating':
    case 'progress':
      return c.v ?? null;
    case 'money':
      return c.v === null || c.v === '' ? null : new FMoney(Number(c.v), c.cur || String(p.config.currency ?? 'USD'));
    case 'select':
    case 'status':
      return optionById(p, c.v)?.name ?? null;
    case 'multi': {
      const opts = optionsOf(p);
      return c.v.map((id) => opts.find((o) => o.id === id)?.name).filter((x): x is string => !!x);
    }
    case 'date': {
      if (!c.v) return null;
      const s = parseDateString(c.v.start);
      if (s === null) return null;
      const e = c.v.end ? parseDateString(c.v.end) : null;
      return new FDate(s, !c.v.time, e);
    }
    case 'check':
      return !!c.v;
    case 'url':
    case 'email':
    case 'phone':
    case 'uid':
    case 'ticker':
      return c.v ?? null;
    case 'files':
      return c.v.map((f) => f.name);
    case 'relation':
      return c.v.map((id) => host.resolveRow(id)).filter((x): x is FRow => !!x);
    case 'ts':
      return new FDate(c.v);
    case 'computed': {
      const k = c.v?.kind;
      const val = c.v?.value;
      if (k === 'number') return typeof val === 'number' ? val : null;
      if (k === 'money') return typeof val === 'number' ? new FMoney(val, String(p.config.currency ?? 'USD')) : null;
      if (k === 'bool') return !!val;
      if (k === 'date') return typeof val === 'number' ? new FDate(val) : null;
      if (k === 'list') return Array.isArray(val) ? (val as FValue[]) : [];
      return c.v?.display ?? null;
    }
    case 'recurrence':
      return c.v?.rrule ?? null;
    case 'secret':
      return null; // never exposed to formulas
    default:
      return null;
  }
}

/** Highlight tokens for the editor (kind per character range). */
export function highlight(expr: string): { from: number; to: number; cls: 'num' | 'str' | 'fn' | 'prop' | 'op' | 'kw' | 'cmt' | 'id' }[] {
  const out: { from: number; to: number; cls: 'num' | 'str' | 'fn' | 'prop' | 'op' | 'kw' | 'cmt' | 'id' }[] = [];
  const re = /\/\*[\s\S]*?(\*\/|$)|"(?:[^"\\]|\\.)*"?|\d+\.?\d*(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|==|!=|>=|<=|&&|\|\||[-+*/%^<>!?:,()[\].]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const t = m[0];
    const from = m.index;
    const to = from + t.length;
    let cls: (typeof out)[number]['cls'];
    if (t.startsWith('/*')) cls = 'cmt';
    else if (t.startsWith('"')) cls = expr.slice(Math.max(0, from - 5), from).replace(/\s/g, '').endsWith('prop(') ? 'prop' : 'str';
    else if (/^\d/.test(t)) cls = 'num';
    else if (/^[A-Za-z_]/.test(t)) {
      if (['true', 'false', 'and', 'or', 'not', 'current', 'index'].includes(t)) cls = 'kw';
      else if (FUNCTIONS[t] || t === 'prop') cls = 'fn';
      else cls = 'id';
    } else cls = 'op';
    out.push({ from, to, cls });
  }
  return out;
}
