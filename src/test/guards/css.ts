/**
 * A tiny CSS scanner for the style ratchet: comments stripped, strings and parentheses respected, nested at-rules
 * tracked. It yields declarations with their enclosing selector / at-rule chain, which is all the guards need (no
 * dependency on a full CSS parser).
 */

export interface CssDecl {
  prop: string;
  value: string;
  /** Innermost style-rule selector ('' at the top level or directly inside an at-rule such as @theme). */
  selector: string;
  /** Enclosing at-rule headers, outermost first ('@media (…)', '@keyframes spin', '@theme'). */
  atRules: string[];
  line: number;
}

export interface CssBlock {
  header: string;
  line: number;
}

export interface CssScan {
  decls: CssDecl[];
  /** Every block header ('@keyframes x', '.a:hover', …). */
  blocks: CssBlock[];
}

/** Replace comments by spaces of the same shape so line numbers survive. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

export function scanCss(raw: string): CssScan {
  const css = stripCssComments(raw);
  const decls: CssDecl[] = [];
  const blocks: CssBlock[] = [];
  const stack: string[] = [];
  let start = 0;
  let paren = 0;
  let line = 1;
  let segLine = 1;
  const lineAt = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (css.charCodeAt(k) === 10) line++;
  };
  let scanned = 0;
  const advance = (to: number) => {
    lineAt(scanned, to);
    scanned = to;
  };
  const flushDecl = (end: number) => {
    const seg = css.slice(start, end);
    const text = seg.trim();
    if (!text || !stack.length) return;
    const colon = text.indexOf(':');
    if (colon <= 0) return;
    const prop = text.slice(0, colon).trim().toLowerCase();
    if (!/^-?-?[a-z][\w-]*$/i.test(prop)) return;
    const value = text
      .slice(colon + 1)
      .replace(/!important\s*$/i, '')
      .trim();
    const atRules = stack.filter((h) => h.startsWith('@'));
    const selector = [...stack].reverse().find((h) => !h.startsWith('@')) ?? '';
    decls.push({ prop, value, selector, atRules, line: segLine + leadingNewlines(seg) });
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const close = findQuoteEnd(css, i);
      i = close;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    if (paren > 0) continue;
    if (ch === '{') {
      advance(start);
      const header = css.slice(start, i).trim().replace(/\s+/g, ' ');
      const hdrLine = line + leadingNewlines(css.slice(start, i));
      blocks.push({ header, line: hdrLine });
      stack.push(header);
      start = i + 1;
      advance(start);
      segLine = line;
    } else if (ch === ';') {
      advance(start);
      segLine = line;
      flushDecl(i);
      start = i + 1;
    } else if (ch === '}') {
      advance(start);
      segLine = line;
      flushDecl(i);
      stack.pop();
      start = i + 1;
    }
  }
  return { decls, blocks };
}

function leadingNewlines(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === '\n') n++;
    else if (c !== ' ' && c !== '\t' && c !== '\r') break;
  }
  return n;
}

function findQuoteEnd(s: string, i: number): number {
  const q = s[i];
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === q || s[k] === '\n') return k;
  }
  return s.length - 1;
}
