/**
 * A small, safe evaluator for the life-app Metric dialect (§14.7): `when` conditions on steps / templates / advisor
 * rules and `{{expr}}` interpolation in copy. No IO, no property access beyond the provided scope.
 *
 *   evalExpr('answers.method == "zero_based" or metrics.inbox_count > 20', scope)
 *   interpolate('{{metrics.inbox_count}} tasks in your inbox', scope)
 *
 * Identifiers: `answers.<id>`, `metrics.<name>`, `pack.<path>`, `today`. Functions: if, and, or, not, min, max, abs,
 * round, coalesce, days_between, months_between, fmt_money, fmt_pct, fmt_months.
 */

export type Scalar = number | string | boolean | null | undefined | unknown[];
export interface Scope {
  answers?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  pack?: Record<string, unknown>;
  /** 'YYYY-MM-DD' */
  today?: string;
  currency?: string;
}

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'lp' }
  | { k: 'rp' }
  | { k: 'comma' };

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      out.push({ k: 'lp' });
      i++;
      continue;
    }
    if (ch === ')') {
      out.push({ k: 'rp' });
      i++;
      continue;
    }
    if (ch === ',') {
      out.push({ k: 'comma' });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j++];
      }
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      out.push({ k: 'num', v: Number(src.slice(i, j).replace(/_/g, '')) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === 'and') out.push({ k: 'op', v: '&&' });
      else if (lower === 'or') out.push({ k: 'op', v: '||' });
      else if (lower === 'not' && src[j] !== '(') out.push({ k: 'op', v: '!' });
      else out.push({ k: 'id', v: word });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ k: 'op', v: op === '=' ? '==' : op });
      i += op.length;
      continue;
    }
    if (ch === '=') {
      out.push({ k: 'op', v: '==' });
      i++;
      continue;
    }
    throw new Error(`Unexpected "${ch}"`);
  }
  return out;
}

type Node =
  | { t: 'lit'; v: Scalar }
  | { t: 'id'; v: string }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

const PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const primary = (): Node => {
    const tk = toks[p++];
    if (!tk) throw new Error('Unexpected end');
    if (tk.k === 'num' || tk.k === 'str') return { t: 'lit', v: tk.v };
    if (tk.k === 'lp') {
      const e = expr(0);
      if (toks[p++]?.k !== 'rp') throw new Error('Expected )');
      return e;
    }
    if (tk.k === 'op' && (tk.v === '!' || tk.v === '-')) return { t: 'un', op: tk.v, a: unary() };
    if (tk.k === 'id') {
      const lower = tk.v.toLowerCase();
      if (lower === 'true') return { t: 'lit', v: true };
      if (lower === 'false') return { t: 'lit', v: false };
      if (lower === 'null') return { t: 'lit', v: null };
      if (peek()?.k === 'lp') {
        p++;
        const args: Node[] = [];
        if (peek()?.k !== 'rp') {
          for (;;) {
            args.push(expr(0));
            if (peek()?.k === 'comma') {
              p++;
              continue;
            }
            break;
          }
        }
        if (toks[p++]?.k !== 'rp') throw new Error('Expected )');
        return { t: 'call', fn: lower, args };
      }
      return { t: 'id', v: tk.v };
    }
    throw new Error('Unexpected token');
  };
  const unary = (): Node => {
    const tk = peek();
    if (tk?.k === 'op' && (tk.v === '!' || tk.v === '-')) {
      p++;
      return { t: 'un', op: tk.v, a: unary() };
    }
    return primary();
  };
  const expr = (minPrec: number): Node => {
    let left = unary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.k !== 'op') break;
      const prec = PREC[tk.v];
      if (prec === undefined || prec < minPrec) break;
      p++;
      const right = expr(prec + 1);
      left = { t: 'bin', op: tk.v, a: left, b: right };
    }
    return left;
  };
  const root = expr(0);
  if (p < toks.length) throw new Error('Unexpected trailing input');
  return root;
}

const cache = new Map<string, Node | Error>();
function compiled(src: string): Node | Error {
  let n = cache.get(src);
  if (!n) {
    try {
      n = parse(src);
    } catch (e) {
      n = e instanceof Error ? e : new Error(String(e));
    }
    if (cache.size > 2000) cache.clear();
    cache.set(src, n);
  }
  return n;
}

function lookup(path: string, scope: Scope): Scalar {
  if (path === 'today') return scope.today ?? new Date().toISOString().slice(0, 10);
  const dot = path.indexOf('.');
  const head = dot < 0 ? path : path.slice(0, dot);
  const rest = dot < 0 ? '' : path.slice(dot + 1);
  let base: unknown;
  if (head === 'answers') base = flattenAnswers(scope.answers ?? {});
  else if (head === 'metrics') base = scope.metrics ?? {};
  else if (head === 'pack') base = scope.pack ?? {};
  else return undefined;
  if (!rest) return undefined;
  let cur: unknown = base;
  // flattened answers use one-level keys; metrics/pack may be nested with dots
  if (head === 'answers') return (base as Record<string, Scalar>)[rest];
  for (const part of rest.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as object)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur as Scalar;
}

/** Flatten answers the same way the Rust side does (answers.rs): objects → `<id>_<field>`, lists → `<id>_count` … */
export function flattenAnswers(answers: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined) {
      out[k] = null;
      return;
    }
    if (Array.isArray(v)) {
      out[k] = v as unknown[];
      out[`${k}_count`] = v.length;
      for (const el of v) {
        if (typeof el === 'string') out[`${k}_${el}`] = true;
        else if (el && typeof el === 'object') {
          for (const [f, fv] of Object.entries(el as Record<string, unknown>)) {
            if (typeof fv === 'string') out[`${k}_${f}_${fv}`] = true;
            else if (typeof fv === 'number') out[`${k}_${f}_sum`] = ((out[`${k}_${f}_sum`] as number) ?? 0) + fv;
          }
        }
      }
      return;
    }
    if (typeof v === 'object') {
      for (const [f, fv] of Object.entries(v as Record<string, unknown>)) put(`${k}_${f}`, fv);
      return;
    }
    out[k] = v as Scalar;
  };
  for (const [k, v] of Object.entries(answers)) put(k, v);
  return out;
}

const num = (v: Scalar): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
};
const truthy = (v: Scalar): boolean => {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  return !!v;
};
const eq = (a: Scalar, b: Scalar): boolean => {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === 'number' || typeof b === 'number') {
    if (typeof a === 'string' && !Number.isFinite(Number(a))) return false;
    if (typeof b === 'string' && !Number.isFinite(Number(b))) return false;
    return num(a) === num(b);
  }
  return a === b;
};
const dayMs = (s: Scalar): number | null => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? t : null;
};

function fmtMoney(v: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v).replace('-', '−');
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

function run(n: Node, scope: Scope): Scalar {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'id':
      return lookup(n.v, scope);
    case 'un': {
      const a = run(n.a, scope);
      return n.op === '!' ? !truthy(a) : -num(a);
    }
    case 'bin': {
      if (n.op === '&&') return truthy(run(n.a, scope)) && truthy(run(n.b, scope));
      if (n.op === '||') return truthy(run(n.a, scope)) || truthy(run(n.b, scope));
      const a = run(n.a, scope);
      const b = run(n.b, scope);
      switch (n.op) {
        case '==':
          return eq(a, b);
        case '!=':
          return !eq(a, b);
        case '<':
          return typeof a === 'string' && typeof b === 'string' ? a < b : num(a) < num(b);
        case '<=':
          return typeof a === 'string' && typeof b === 'string' ? a <= b : num(a) <= num(b);
        case '>':
          return typeof a === 'string' && typeof b === 'string' ? a > b : num(a) > num(b);
        case '>=':
          return typeof a === 'string' && typeof b === 'string' ? a >= b : num(a) >= num(b);
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : num(a) + num(b);
        case '-':
          return num(a) - num(b);
        case '*':
          return num(a) * num(b);
        case '/':
          return num(b) === 0 ? null : num(a) / num(b);
        case '%':
          return num(b) === 0 ? null : num(a) % num(b);
        default:
          return null;
      }
    }
    case 'call': {
      const args = () => n.args.map((x) => run(x, scope));
      switch (n.fn) {
        case 'if': {
          const c = n.args[0] ? truthy(run(n.args[0], scope)) : false;
          return c ? (n.args[1] ? run(n.args[1], scope) : null) : n.args[2] ? run(n.args[2], scope) : null;
        }
        case 'and':
          return n.args.every((x) => truthy(run(x, scope)));
        case 'or':
          return n.args.some((x) => truthy(run(x, scope)));
        case 'not':
          return !truthy(n.args[0] ? run(n.args[0], scope) : null);
        case 'min':
          return Math.min(...args().map(num));
        case 'max':
          return Math.max(...args().map(num));
        case 'abs':
          return Math.abs(num(args()[0]));
        case 'round': {
          const [v, d] = args();
          const f = 10 ** num(d ?? 0);
          return Math.round(num(v) * f) / f;
        }
        case 'coalesce':
          return args().find((v) => v !== null && v !== undefined && v !== '') ?? null;
        case 'days_between': {
          const [a, b] = args().map(dayMs);
          return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
        }
        case 'months_between': {
          const [a, b] = args().map(dayMs);
          return a === null || b === null ? null : Math.round(((b - a) / 86_400_000 / 30.4375) * 10) / 10;
        }
        case 'fmt_money':
          return fmtMoney(num(args()[0]), scope.currency);
        case 'fmt_pct':
          return `${(num(args()[0]) * 100).toFixed(Math.abs(num(args()[0])) < 0.1 ? 1 : 0)}%`;
        case 'fmt_months': {
          const v = num(args()[0]);
          return `${v.toFixed(v < 10 ? 1 : 0)} months`;
        }
        default:
          return null;
      }
    }
  }
}

/** Evaluates an expression; parse errors and unknown identifiers evaluate to null. */
export function evalExpr(src: string, scope: Scope): Scalar {
  const n = compiled(src);
  if (n instanceof Error) return null;
  try {
    return run(n, scope);
  } catch {
    return null;
  }
}

/** True when the condition holds; empty / missing conditions are true. */
export function test(src: string | undefined, scope: Scope): boolean {
  if (!src || !src.trim()) return true;
  return truthy(evalExpr(src, scope));
}

/** Replaces `{{expr}}` segments with their values. */
export function interpolate(text: string, scope: Scope): string {
  return text.replace(/\{\{([\s\S]+?)\}\}/g, (_m, e: string) => {
    const v = evalExpr(e, scope);
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  });
}
