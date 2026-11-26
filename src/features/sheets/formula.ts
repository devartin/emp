/**
 * Formula-editing helpers shared by the cell editor and the formula bar: syntax-coloured spans, the autocomplete
 * context at the caret, and the innermost function call (for signature help).
 */
import type { SheetFunctionInfo } from '@/backend/types';
import { api } from '@/backend';
import { tokenize, type Token } from './engine/lexer';
import { refColorIndex } from './GridCanvas';

export interface Span {
  text: string;
  cls: string;
  /** Reference colour index (cat palette) for ref tokens. */
  ref?: number;
}

/** Coloured spans for a formula (refs get the same colours as their grid highlights). */
export function formulaSpans(text: string): Span[] {
  if (!text.startsWith('=')) return [{ text, cls: '' }];
  const seen = new Map<string, number>();
  return tokenize(text).map((t) => {
    switch (t.t) {
      case 'ref': {
        const key = t.v.replace(/\$/g, '').toUpperCase();
        let i = seen.get(key);
        if (i === undefined) {
          i = seen.size;
          seen.set(key, i);
        }
        return { text: t.v, cls: 'tok-ref', ref: refColorIndex(i) + 1 };
      }
      case 'func':
        return { text: t.v, cls: 'tok-fn' };
      case 'num':
        return { text: t.v, cls: 'tok-num' };
      case 'str':
        return { text: t.v, cls: 'tok-str' };
      case 'bool':
        return { text: t.v, cls: 'tok-bool' };
      case 'err':
      case 'bad':
        return { text: t.v, cls: 'tok-err' };
      case 'name':
        return { text: t.v, cls: 'tok-name' };
      case 'op':
      case 'lp':
      case 'rp':
      case 'comma':
        return { text: t.v, cls: 'tok-op' };
      default:
        return { text: t.v, cls: '' };
    }
  });
}

export interface CompletionContext {
  /** Prefix being typed (function or name). */
  prefix: string;
  start: number;
  end: number;
}

/** The identifier being typed at the caret, when completion makes sense there. */
export function completionAt(text: string, caret: number): CompletionContext | null {
  if (!text.startsWith('=')) return null;
  const toks = tokenize(text.slice(0, caret));
  const last = toks[toks.length - 1];
  if (!last) return null;
  if (last.t !== 'name' && last.t !== 'ref' && last.t !== 'bool') return null;
  if (last.e !== caret) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(last.v)) return null;
  // Only after an operator, '(', ',' or '='.
  let prev: Token | undefined;
  for (let i = toks.length - 2; i >= 0; i--) {
    if (toks[i].t !== 'ws') {
      prev = toks[i];
      break;
    }
  }
  if (prev && !(prev.t === 'op' || prev.t === 'lp' || prev.t === 'comma' || prev.t === 'semi')) return null;
  const after = text.slice(caret);
  if (/^[A-Za-z0-9_.(]/.test(after)) return null;
  return { prefix: last.v, start: last.s, end: last.e };
}

export interface CallContext {
  name: string;
  argIndex: number;
  /** Offset of the function name. */
  start: number;
}

/** The innermost function call containing the caret. */
export function callAt(text: string, caret: number): CallContext | null {
  if (!text.startsWith('=')) return null;
  const toks = tokenize(text.slice(0, caret));
  const stack: CallContext[] = [];
  let pendingFn: Token | null = null;
  let depthNonFn = 0;
  const parenKinds: ('fn' | 'group')[] = [];
  for (const t of toks) {
    if (t.t === 'func') {
      pendingFn = t;
      continue;
    }
    if (t.t === 'lp') {
      if (pendingFn) {
        stack.push({ name: pendingFn.v.toUpperCase(), argIndex: 0, start: pendingFn.s });
        parenKinds.push('fn');
      } else {
        parenKinds.push('group');
        depthNonFn++;
      }
      pendingFn = null;
      continue;
    }
    pendingFn = null;
    if (t.t === 'rp') {
      const k = parenKinds.pop();
      if (k === 'fn') stack.pop();
      else if (k === 'group') depthNonFn--;
      continue;
    }
    if (t.t === 'comma' && stack.length && parenKinds[parenKinds.length - 1] === 'fn') stack[stack.length - 1].argIndex++;
  }
  void depthNonFn;
  return stack[stack.length - 1] ?? null;
}

let fnCache: SheetFunctionInfo[] | null = null;
let fnPromise: Promise<SheetFunctionInfo[]> | null = null;

/** The function catalogue (`sheet_functions`), cached for the session. */
export function loadFunctions(): Promise<SheetFunctionInfo[]> {
  if (fnCache) return Promise.resolve(fnCache);
  fnPromise ??= api.sheet
    .functions({})
    .then((list) => {
      fnCache = list;
      return list;
    })
    .catch((e) => {
      fnPromise = null;
      throw e;
    });
  return fnPromise;
}

export function cachedFunctions(): SheetFunctionInfo[] | null {
  return fnCache;
}

/** Ranked completions: prefix matches first (popular functions boosted), then substring matches. */
export function rankFunctions(list: SheetFunctionInfo[], prefix: string, names: { name: string }[] = []): { kind: 'fn' | 'name'; name: string; info?: SheetFunctionInfo }[] {
  const p = prefix.toUpperCase();
  const popular = ['SUM', 'AVERAGE', 'IF', 'COUNT', 'MAX', 'MIN', 'ROUND', 'VLOOKUP', 'XLOOKUP', 'SUMIFS', 'COUNTIF', 'PMT', 'IFERROR', 'INDEX', 'MATCH', 'TODAY', 'TEXT', 'NPV', 'FILTER', 'SORT'];
  const score = (n: string) => {
    if (n === p) return 0;
    if (n.startsWith(p)) return 1 + (popular.includes(n) ? -0.5 + popular.indexOf(n) / 100 : 0) + n.length / 100;
    if (n.includes(p)) return 3 + n.length / 100;
    return 99;
  };
  const fns = list
    .map((f) => ({ kind: 'fn' as const, name: f.name, info: f, s: score(f.name) }))
    .filter((x) => x.s < 99);
  const nm = names.map((n) => ({ kind: 'name' as const, name: n.name, s: score(n.name.toUpperCase()) - 0.25 })).filter((x) => x.s < 99);
  return [...fns, ...nm].sort((a, b) => a.s - b.s || a.name.localeCompare(b.name)).slice(0, 8);
}
