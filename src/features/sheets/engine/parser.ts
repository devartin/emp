/**
 * Pratt parser for the Excel dialect (§14.1). Precedence, lowest → highest: comparison, `&`, `+ -`, `* /`, `^`,
 * postfix `%`, unary `±` (so `-2^2 = 4`). References come pre-assembled from the lexer.
 */
import { tokenize, type RefInfo, type Token } from './lexer';

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: string }
  | { k: 'ref'; ref: RefInfo }
  | { k: 'name'; name: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'un'; op: '-' | '+'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'pct'; a: Node }
  | { k: 'arr'; rows: Node[][] }
  | { k: 'missing' };

export class FormulaParseError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

const INFIX_BP: Record<string, number> = {
  '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10,
  '&': 20,
  '+': 30, '-': 30,
  '*': 40, '/': 40,
  '^': 50,
};
const PCT_BP = 60;
const PREFIX_BP = 70;

class Parser {
  private toks: Token[];
  private i = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
    this.toks = tokenize(src).filter((t) => t.t !== 'ws');
  }
  private peek(): Token | undefined {
    return this.toks[this.i];
  }
  private next(): Token | undefined {
    return this.toks[this.i++];
  }
  private fail(msg: string, tok?: Token): never {
    throw new FormulaParseError(msg, tok ? tok.s : this.src.length);
  }

  parse(): Node {
    const first = this.peek();
    if (first && first.t === 'op' && first.v === '=') this.i++;
    if (!this.peek()) this.fail('The formula is empty');
    const node = this.expr(0);
    const rest = this.peek();
    if (rest) this.fail(rest.t === 'rp' ? 'There’s an extra closing parenthesis' : `Unexpected “${rest.v}”`, rest);
    return node;
  }

  private expr(minBp: number): Node {
    let lhs = this.prefix();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'op' && t.v === '%') {
        if (PCT_BP < minBp) break;
        this.i++;
        lhs = { k: 'pct', a: lhs };
        continue;
      }
      if (t.t !== 'op') break;
      const bp = INFIX_BP[t.v];
      if (bp === undefined || bp <= minBp) break;
      this.i++;
      const rhs = this.expr(bp);
      lhs = { k: 'bin', op: t.v, a: lhs, b: rhs };
    }
    return lhs;
  }

  private prefix(): Node {
    const t = this.next();
    if (!t) this.fail('The formula ends too early');
    switch (t.t) {
      case 'num': {
        const v = Number(t.v);
        if (!Number.isFinite(v)) this.fail('That number is too large', t);
        return { k: 'num', v };
      }
      case 'str':
        return { k: 'str', v: t.v.slice(1, -1).replace(/""/g, '"') };
      case 'bool':
        return { k: 'bool', v: t.v.toUpperCase() === 'TRUE' };
      case 'err':
        return { k: 'err', v: t.v.toUpperCase() };
      case 'ref':
        return { k: 'ref', ref: t.ref! };
      case 'name':
        return { k: 'name', name: t.v };
      case 'func':
        return this.call(t);
      case 'op':
        if (t.v === '-' || t.v === '+') return { k: 'un', op: t.v, a: this.expr(PREFIX_BP) };
        return this.fail(`Unexpected “${t.v}”`, t);
      case 'lp': {
        const inner = this.expr(0);
        const close = this.next();
        if (!close || close.t !== 'rp') this.fail('A closing parenthesis is missing', close);
        return inner;
      }
      case 'lbrace':
        return this.array(t);
      default:
        return this.fail(t.t === 'bad' && t.v.startsWith('"') ? 'A closing quote is missing' : `Unexpected “${t.v}”`, t);
    }
  }

  private call(t: Token): Node {
    const name = t.v.toUpperCase().replace(/^_XLFN\./, '');
    const open = this.next();
    if (!open || open.t !== 'lp') this.fail('Expected “(”', open);
    const args: Node[] = [];
    if (this.peek()?.t === 'rp') {
      this.i++;
      return { k: 'call', name, args };
    }
    for (;;) {
      const p = this.peek();
      if (!p) this.fail(`${name}( is missing a closing parenthesis`);
      if (p.t === 'comma') {
        args.push({ k: 'missing' });
        this.i++;
        continue;
      }
      if (p.t === 'rp') {
        args.push({ k: 'missing' });
        this.i++;
        break;
      }
      args.push(this.expr(0));
      const sep = this.next();
      if (!sep) this.fail(`${name}( is missing a closing parenthesis`);
      if (sep.t === 'rp') break;
      if (sep.t !== 'comma') this.fail(`Unexpected “${sep.v}”`, sep);
      if (this.peek()?.t === 'rp') {
        args.push({ k: 'missing' });
        this.i++;
        break;
      }
    }
    return { k: 'call', name, args };
  }

  private array(open: Token): Node {
    const rows: Node[][] = [[]];
    for (;;) {
      const p = this.peek();
      if (!p) this.fail('A closing brace is missing', open);
      if (p.t === 'rbrace') {
        this.i++;
        break;
      }
      rows[rows.length - 1].push(this.expr(0));
      const sep = this.next();
      if (!sep) this.fail('A closing brace is missing', open);
      if (sep.t === 'rbrace') break;
      if (sep.t === 'semi') rows.push([]);
      else if (sep.t !== 'comma') this.fail(`Unexpected “${sep.v}”`, sep);
    }
    const w = rows[0].length;
    if (!rows.every((r) => r.length === w)) this.fail('Array rows must be the same length', open);
    return { k: 'arr', rows };
  }
}

export function parseFormula(src: string): Node {
  return new Parser(src).parse();
}

/** Walks every node (pre-order). */
export function walk(node: Node, fn: (n: Node) => void): void {
  fn(node);
  switch (node.k) {
    case 'call':
      node.args.forEach((a) => walk(a, fn));
      break;
    case 'un':
    case 'pct':
      walk(node.a, fn);
      break;
    case 'bin':
      walk(node.a, fn);
      walk(node.b, fn);
      break;
    case 'arr':
      node.rows.forEach((r) => r.forEach((a) => walk(a, fn)));
      break;
    default:
      break;
  }
}
