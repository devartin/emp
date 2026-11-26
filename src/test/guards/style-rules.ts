/**
 * Style ratchet metrics (PROGRAMME-v3 K6 "Style ratchet" + "Scale checks", chair resolutions applied: the " · "
 * separator is NOT a target). Each metric counts occurrences per file; the baseline may only fall.
 */
import { scanCss, type CssDecl } from './css';
import { read } from './files';
import type { TsFacts } from './tsx';

export const STYLE_METRICS = {
  color_literal: 'raw hex / rgb() / hsl() / oklch() colour outside token definitions',
  shadow_literal: 'box-shadow that is not none or var(--token) only',
  gradient: 'linear-/radial-/conic-gradient( outside token definitions',
  backdrop_filter: 'backdrop-filter outside the .glass-* recipes',
  keyframes: '@keyframes definition',
  infinite_animation: "animation …infinite, repeat: Infinity, animate-spin/pulse/ping/bounce",
  transition_all: "'transition: all' / transition-all",
  font_weight_off_scale: 'font weight outside {400, 500, 600, 700}',
  radius_off_scale: 'border radius outside {0, 4, 6, 10, 12, 999px, 50%} (literal, var(--radius-*) token or rounded-* utility)',
  uppercase: 'text-transform: uppercase / the uppercase class',
  inline_style: 'inline style object (style={{ … }}) in TSX',
  usd_literal: 'hard-coded "USD" literal in UI code',
  sparkles_import: 'Sparkles / Sparkle icon import',
  deltapill_import: 'DeltaPill import',
  tofixed_finance: 'toFixed( in finance features (use the money/number formatters)',
} as const;
export type StyleMetric = keyof typeof STYLE_METRICS;
export type Counts = Partial<Record<string, number>>;

/** Files whose custom-property declarations ARE the tokens (exempt from the colour / shadow / gradient / blur counts). */
const TOKEN_FILES = new Set(['src/styles/tokens.css', 'src/styles/material.css', 'src/styles/theme.css']);
/** Recipes that legitimately own backdrop-filter (one switchable glass token family). */
const GLASS_RECIPE_FILES = new Set(['src/styles/material.css', 'src/styles/components.css']);
/** Data palettes (user-pickable colours, sheet templates, canvas renderer) are colour data, not styling. */
const COLOR_DATA_FILES = [
  /^src\/features\/sheets\/palette\.ts$/,
  /^src\/features\/sheets\/engine\/templates\.ts$/,
  /^src\/features\/sheets\/GridCanvas\.ts$/,
  /^src\/ui\/ColorPicker\.tsx$/,
  /^src\/backend\//,
];
const FINANCE_FEATURES = /^src\/features\/(finance|portfolio|taxes|markets)\//;

const HEX = /(?<![\w&#/-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*[-+.\d]/gi;
const GRADIENT = /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
const WEIGHTS = new Set(['400', '500', '600', '700', 'normal', 'bold', 'inherit', 'initial', 'unset', 'revert']);
const RADII = new Set(['0', '0px', '4px', '6px', '10px', '12px', '999px', '9999px', '50%', '100%', 'inherit', 'initial', 'unset', 'revert']);

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const add = (c: Counts, k: StyleMetric, n = 1) => {
  if (n > 0) c[k] = (c[k] ?? 0) + n;
};
const stripUrls = (v: string) => v.replace(/url\((?:[^()]|\([^()]*\))*\)/gi, 'url()');
/** Remove var(...) calls (nested), so what remains is literal. */
const stripVars = (v: string) => {
  let prev;
  let s = v;
  do {
    prev = s;
    s = s.replace(/var\([^()]*\)/g, '');
  } while (s !== prev);
  return s;
};

export const colorHits = (s: string) => count(s, HEX) + count(s, COLOR_FN);
export const gradientHits = (s: string) => count(s, GRADIENT);

function shadowIsLiteral(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/^(none|inherit|initial|unset|revert)$/.test(v)) return false;
  return stripVars(v).replace(/[\s,]/g, '') !== '';
}

/** Radius tokens (`--radius-*`) as tokens.css and theme.css (Tailwind's @theme, which wins) define them. */
let radiusTokenCache: Map<string, string> | null = null;
export function radiusTokens(): Map<string, string> {
  if (radiusTokenCache) return radiusTokenCache;
  const m = new Map<string, string>();
  for (const f of ['src/styles/tokens.css', 'src/styles/theme.css']) {
    let raw = '';
    try {
      raw = read(f);
    } catch {
      continue;
    }
    for (const d of scanCss(raw).decls) if (/^--radius-[\w-]+$/.test(d.prop) && !d.prop.includes('*')) m.set(d.prop, d.value.trim());
  }
  radiusTokenCache = m;
  return m;
}

/**
 * Replace var(--radius-*) with the token's value and any other var(--x, fallback) with its fallback (a var without a
 * fallback, or an unknown token, drops out), innermost first, so only the radii that would actually render remain.
 */
function resolveRadiusVars(value: string, tokens: Map<string, string>): string {
  let prev;
  let s = value;
  do {
    prev = s;
    s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_, name: string, fb: string | undefined) => {
      const t = tokens.get(name);
      if (t !== undefined && !/var\(/.test(t)) return ` ${t} `;
      return fb !== undefined ? ` ${fb.trim()} ` : ' ';
    });
  } while (s !== prev);
  return s;
}

function radiusOffScale(value: string, tokens: Map<string, string> = radiusTokens()): boolean {
  const v = resolveRadiusVars(value, tokens).replace(/calc\([^()]*\)/g, '').trim();
  if (!v) return false;
  return v
    .split(/[\s/]+/)
    .filter(Boolean)
    .some((t) => !RADII.has(t.toLowerCase()));
}

function weightOffScale(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.startsWith('var(') || v.startsWith('calc(')) return false;
  return !WEIGHTS.has(v);
}

const FONT_KEYWORD_WEIGHTS = /^(bold|bolder|lighter|normal)$/;
/** The weight token of a `font:` shorthand (before the size), or null when there is none / it is a var(). */
function fontShorthandWeight(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v || /^(inherit|initial|unset|revert)$/.test(v) || v.startsWith('var(')) return null;
  for (const tok of v.split(/\s+/)) {
    if (/^\d+(\.\d+)?$/.test(tok) || FONT_KEYWORD_WEIGHTS.test(tok)) return tok;
    // Reached the size (12px, 1rem, 12px/1.4, small, var(--size)…): no explicit weight.
    if (!/^(italic|oblique|small-caps|normal|condensed|expanded|semi-condensed|semi-expanded|ultra-condensed|ultra-expanded|extra-condensed|extra-expanded)$/.test(tok)) return null;
  }
  return null;
}

const isRadiusProp = (p: string) => /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/.test(p);

export function cssStyleCounts(file: string, raw: string): Counts {
  const c: Counts = {};
  const { decls, blocks } = scanCss(raw);
  const isTokenFile = TOKEN_FILES.has(file);
  for (const b of blocks) if (/^@(-webkit-)?keyframes\b/i.test(b.header)) add(c, 'keyframes');
  for (const d of decls) {
    const custom = d.prop.startsWith('--');
    const tokenDef = custom && isTokenFile;
    const value = stripUrls(d.value);
    if (!tokenDef) {
      add(c, 'color_literal', colorHits(value));
      add(c, 'gradient', gradientHits(value));
    }
    if ((d.prop === 'box-shadow' || d.prop === '-webkit-box-shadow') && shadowIsLiteral(value)) add(c, 'shadow_literal');
    if (/^(-webkit-)?backdrop-filter$/.test(d.prop) && !/^(none|inherit|initial|unset)$/i.test(value) && !isGlassRecipe(file, d)) add(c, 'backdrop_filter');
    if (/^(-webkit-)?animation(-iteration-count)?$/.test(d.prop) && /\binfinite\b/i.test(value)) add(c, 'infinite_animation');
    if (/^(-webkit-)?transition(-property)?$/.test(d.prop) && /(^|,)\s*all\b/i.test(value)) add(c, 'transition_all');
    // @font-face font-weight is the variable font's supported range ("100 900"), not a weight in use.
    const fontFace = d.atRules.some((a) => /^@font-face\b/i.test(a));
    if (!fontFace && (d.prop === 'font-weight' || (custom && /weight/i.test(d.prop) && /^\d+$/.test(value.trim()))) && weightOffScale(value)) add(c, 'font_weight_off_scale');
    if (d.prop === 'font' && !fontFace) {
      const w = fontShorthandWeight(value);
      if (w !== null && weightOffScale(w)) add(c, 'font_weight_off_scale');
    }
    // Custom radius properties count where defined (a literal or an alias of an off-scale token), uses where used.
    if ((isRadiusProp(d.prop) || (custom && /radius/i.test(d.prop) && /^([\d.]|var\()/.test(value.trim()))) && radiusOffScale(value)) add(c, 'radius_off_scale');
    if (d.prop === 'text-transform' && /uppercase/i.test(value)) add(c, 'uppercase');
  }
  return c;
}

function isGlassRecipe(file: string, d: CssDecl): boolean {
  return GLASS_RECIPE_FILES.has(file) && /\.glass-|--glass/.test(d.selector);
}

const TAILWIND_WEIGHT_OFF = /(?<![\w-])font-(?:thin|extralight|light|extrabold|black)(?![\w-])/g;
const TAILWIND_WEIGHT_ARB = /(?<![\w-])font-\[(\d+)\]/g;
const TAILWIND_RADIUS_ARB = /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[([^\]]+)\]/g;
/** Named radius utilities (rounded-md, rounded-t-xl, md:rounded-2xl…) resolve through --radius-<name>. */
const TAILWIND_RADIUS_NAMED = /(?<![\w-])rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?-([a-z0-9]+)(?![\w[-])/g;
/** Tailwind v4 gradient utilities (bg-linear-to-r, bg-linear-45, bg-radial, bg-conic-*, legacy bg-gradient-to-*). */
const TAILWIND_GRADIENT = /(?<![\w-])-?bg-(?:linear|radial|conic|gradient)(?:-[\w[\]().%/-]+)?(?![\w-])/g;
const TAILWIND_GRADIENT_STOP = /(?<![\w-])(?:from|via|to)-(?:[a-z]+-\d{2,3}|\[[^\]]+\]|[a-z]+(?:-[a-z]+)*)(?:\/[\w.]+)?(?![\w-])/;

function namedRadiusOffScale(name: string, tokens: Map<string, string>): boolean {
  if (name === 'none' || name === 'full') return false;
  const t = tokens.get(`--radius-${name}`);
  return t !== undefined && radiusOffScale(t, tokens);
}

export function tsStyleCounts(file: string, f: TsFacts, tokens: Map<string, string> = radiusTokens()): Counts {
  const c: Counts = {};
  const colorData = COLOR_DATA_FILES.some((re) => re.test(file));
  const ui = !file.startsWith('src/backend/');
  for (const s of f.strings) {
    if (!colorData) add(c, 'color_literal', colorHits(s.text));
    add(c, 'gradient', gradientHits(s.text));
    if (s.kind !== 'jsxText' && /\banimation\s*:[^;]*\binfinite\b/i.test(s.text)) add(c, 'infinite_animation');
    if (s.kind !== 'jsxText' && /transition\s*:\s*all\b/i.test(s.text)) add(c, 'transition_all');
    if (ui && s.text === 'USD') add(c, 'usd_literal');
    if (s.inClass) {
      add(c, 'uppercase', count(s.text, /(?<![\w-:])uppercase(?![\w-])/g));
      add(c, 'transition_all', count(s.text, /(?<![\w-])transition-all(?![\w-])/g));
      add(c, 'infinite_animation', count(s.text, /(?<![\w-])animate-(?:spin|pulse|ping|bounce)(?![\w-])/g));
      add(c, 'backdrop_filter', count(s.text, /(?<![\w-])backdrop-(?:blur|filter|saturate)(?:-[\w[\].]+)?(?![\w-])/g));
      add(c, 'shadow_literal', count(s.text, /(?<![\w-])shadow-\[/g));
      add(c, 'font_weight_off_scale', count(s.text, TAILWIND_WEIGHT_OFF));
      for (const m of s.text.matchAll(TAILWIND_WEIGHT_ARB)) if (!WEIGHTS.has(m[1])) add(c, 'font_weight_off_scale');
      for (const m of s.text.matchAll(TAILWIND_RADIUS_ARB)) if (radiusOffScale(m[1].replace(/_/g, ' '), tokens)) add(c, 'radius_off_scale');
      for (const m of s.text.matchAll(TAILWIND_RADIUS_NAMED)) if (namedRadiusOffScale(m[1], tokens)) add(c, 'radius_off_scale');
      // One gradient per gradient utility; stops without a direction utility in the same string still make one.
      const grads = count(s.text, TAILWIND_GRADIENT);
      add(c, 'gradient', grads || (TAILWIND_GRADIENT_STOP.test(s.text) ? 1 : 0));
    }
  }
  for (const p of f.styleProps) {
    const lit = p.literal;
    if (lit === null) continue;
    switch (p.name) {
      case 'fontWeight':
        if (weightOffScale(lit)) add(c, 'font_weight_off_scale');
        break;
      case 'borderRadius':
        if (radiusOffScale(p.isNumber ? (lit === '0' ? '0' : `${lit}px`) : lit, tokens)) add(c, 'radius_off_scale');
        break;
      case 'font':
        if (!p.isNumber) {
          const w = fontShorthandWeight(lit);
          if (w !== null && weightOffScale(w)) add(c, 'font_weight_off_scale');
        }
        break;
      case 'boxShadow':
        if (shadowIsLiteral(lit)) add(c, 'shadow_literal');
        break;
      case 'backdropFilter':
      case 'WebkitBackdropFilter':
        if (!/^none$/i.test(lit)) add(c, 'backdrop_filter');
        break;
      case 'textTransform':
        if (/uppercase/i.test(lit)) add(c, 'uppercase');
        break;
      case 'transition':
      case 'transitionProperty':
        if (/(^|,)\s*all\b/i.test(lit)) add(c, 'transition_all');
        break;
      default:
        break;
    }
  }
  for (const r of f.radiusAttrs) if (radiusOffScale(r.value === 0 ? '0' : `${r.value}px`, tokens)) add(c, 'radius_off_scale');
  add(c, 'inline_style', file.endsWith('.tsx') ? f.inlineStyleAttrs.length : 0);
  add(c, 'infinite_animation', f.repeatInfinity.length);
  for (const imp of f.imports) {
    if (imp.from === 'lucide-react') add(c, 'sparkles_import', imp.names.filter((n) => /^(Lucide)?Sparkles?(Icon)?$/.test(n)).length);
    if (/(^|\/)DeltaPill$/.test(imp.from) || imp.names.includes('DeltaPill')) add(c, 'deltapill_import');
  }
  if (FINANCE_FEATURES.test(file)) add(c, 'tofixed_finance', f.toFixedCalls.length);
  return c;
}
