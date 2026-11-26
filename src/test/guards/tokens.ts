/**
 * Resolve the design tokens (custom properties on :root) for one appearance state — theme × accent — from the token
 * stylesheets, honouring selector specificity and source order the way the browser would for <html>.
 */
import { scanCss } from './css';
import { mix, parseColor, type Rgba } from './color';

export interface Appearance {
  theme: 'light' | 'dark' | 'midnight';
  accent: string;
}

interface Decl {
  prop: string;
  value: string;
  selectors: string[];
  /** Tailwind @theme variables live in a lower cascade layer than unlayered tokens. */
  layered: boolean;
  order: number;
}

export function collectRootDecls(sheets: string[]): Decl[] {
  const out: Decl[] = [];
  let order = 0;
  for (const css of sheets) {
    for (const d of scanCss(css).decls) {
      if (!d.prop.startsWith('--')) continue;
      const theme = d.atRules.some((a) => /^@theme\b/.test(a));
      if (d.atRules.some((a) => !/^@theme\b/.test(a) && !/^@layer\b/.test(a))) continue; // @media, @supports: not the default state
      if (theme && !d.selector) out.push({ prop: d.prop, value: d.value, selectors: [':root'], layered: true, order: order++ });
      else if (d.selector) out.push({ prop: d.prop, value: d.value, selectors: splitTop(d.selector), layered: false, order: order++ });
    }
  }
  return out;
}

/** Split on top-level commas. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Specificity (as one number, attrs/pseudo-classes only) if `sel` matches <html> in `app`, else null. */
export function matchRoot(sel: string, app: Appearance): number | null {
  const s = sel.trim();
  if (!s.startsWith(':root')) return null;
  const attrs: Record<string, string> = { 'data-theme': app.theme, 'data-accent': app.accent };
  const one = (x: string): number | null => {
    // a compound of [attr], [attr="v"], :is(), :where(), :not()
    let rest = x.trim();
    let spec = 0;
    while (rest) {
      let m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
      if (m) {
        const v = attrs[m[1]];
        if (v === undefined || (m[2] !== undefined && v !== m[2])) return null;
        spec += 1;
        rest = rest.slice(m[0].length);
        continue;
      }
      m = /^:(is|where|not)\(/.exec(rest);
      if (m) {
        let depth = 0;
        let k = m[0].length - 1;
        for (; k < rest.length; k++) {
          if (rest[k] === '(') depth++;
          else if (rest[k] === ')' && --depth === 0) break;
        }
        const inner = splitTop(rest.slice(m[0].length, k));
        const specs = inner.map(one);
        const best = Math.max(...specs.map((v) => (v === null ? -1 : v)));
        if (m[1] === 'not') {
          if (specs.some((v) => v !== null)) return null;
          spec += 1; // :not([attr…]) has the specificity of its (attribute) argument
        } else {
          if (best < 0) return null;
          if (m[1] === 'is') spec += best;
        }
        rest = rest.slice(k + 1);
        continue;
      }
      return null; // descendant combinator, class, pseudo-element: not <html> itself
    }
    return spec;
  };
  const r = one(s.slice(':root'.length));
  return r === null ? null : r + 1;
}

export function resolveTokens(decls: Decl[], app: Appearance): Map<string, string> {
  const best = new Map<string, { layer: number; spec: number; order: number; value: string }>();
  for (const d of decls) {
    let spec: number | null = null;
    for (const sel of d.selectors) {
      const m = matchRoot(sel, app);
      if (m !== null && (spec === null || m > spec)) spec = m;
    }
    if (spec === null) continue;
    const layer = d.layered ? 0 : 1;
    const cur = best.get(d.prop);
    if (!cur || layer > cur.layer || (layer === cur.layer && (spec > cur.spec || (spec === cur.spec && d.order > cur.order)))) {
      best.set(d.prop, { layer, spec, order: d.order, value: d.value });
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.value]));
}

/** Substitute var() references (with fallbacks) until none remain. */
export function substitute(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 20) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    let d = 0;
    let k = at + 3;
    for (; k < value.length; k++) {
      if (value[k] === '(') d++;
      else if (value[k] === ')' && --d === 0) break;
    }
    const [name, ...fb] = splitTop(value.slice(at + 4, k));
    const v = tokens.get(name.trim());
    out += v !== undefined ? substitute(v, tokens, depth + 1) : fb.length ? substitute(fb.join(','), tokens, depth + 1) : `var(${name})`;
    i = k + 1;
  }
  return out;
}

/** Evaluate a resolved colour value: a literal or a color-mix() of literals. */
export function evalColor(value: string): Rgba | null {
  const v = value.trim();
  const m = /^color-mix\(\s*in\s+(srgb|oklab)\s*,([\s\S]*)\)$/i.exec(v);
  if (!m) return parseColor(v);
  const parts = splitTop(m[2]);
  if (parts.length !== 2) return null;
  const parsed = parts.map((p) => {
    const pm = /^([\s\S]*?)\s+([\d.]+)%$/.exec(p.trim());
    return pm ? { c: evalColor(pm[1]), p: parseFloat(pm[2]) / 100 } : { c: evalColor(p), p: NaN };
  });
  const [a, b] = parsed;
  if (!a.c || !b.c) return null;
  let p1 = a.p;
  let p2 = b.p;
  if (Number.isNaN(p1) && Number.isNaN(p2)) p1 = p2 = 0.5;
  else if (Number.isNaN(p1)) p1 = 1 - p2;
  else if (Number.isNaN(p2)) p2 = 1 - p1;
  return mix(m[1].toLowerCase() as 'srgb' | 'oklab', a.c, p1, b.c, p2);
}
