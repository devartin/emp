/// <reference types="node" />
/**
 * Token contrast test (PROGRAMME-v3 K6): resolve the tokens for light, dark and midnight (× every accent where the
 * pair involves the accent) and check WCAG 2.x ratios: body and secondary text ≥ 4.5:1, tertiary text and UI
 * boundaries (focus ring, strong border) ≥ 3:1. Pairs that fail today are listed in contrast-allowlist.ts.
 */
import { describe, expect, test } from 'vitest';
import { read } from './files';
import { contrast, hex, over, type Rgba } from './color';
import { collectRootDecls, evalColor, resolveTokens, substitute, type Appearance } from './tokens';
import { CONTRAST_ALLOWLIST } from './contrast-allowlist';

const SHEETS = ['src/styles/tokens.css', 'src/styles/material.css', 'src/styles/theme.css'];
const THEMES: Appearance['theme'][] = ['light', 'dark', 'midnight'];
const ACCENTS = ['graphite', 'iris', 'ocean', 'jade', 'amber', 'ruby', 'orchid'];

const SURFACES = ['--bg-window', '--bg-canvas', '--bg-surface-1', '--bg-surface-2', '--bg-surface-3', '--bg-overlay', '--panel-top', '--well-bg'];
const READING_SURFACES = ['--bg-canvas', '--bg-surface-1', '--panel-top'];

interface Pair {
  fg: string;
  bg: string;
  min: number;
  /** Depends on the accent: checked for every accent, otherwise only for graphite. */
  accent?: boolean;
}

const PAIRS: Pair[] = [
  ...['--text-primary', '--text-secondary'].flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: 4.5 }))),
  ...SURFACES.map((bg) => ({ fg: '--text-tertiary', bg, min: 3 })),
  ...['--gain-text', '--loss-text', '--warning-text', '--info-text'].flatMap((fg) => READING_SURFACES.map((bg) => ({ fg, bg, min: 4.5 }))),
  ...READING_SURFACES.map((bg) => ({ fg: '--accent-text', bg, min: 4.5, accent: true })),
  { fg: '--accent-contrast', bg: '--accent-solid', min: 4.5, accent: true },
  { fg: '--text-on-inverse', bg: '--bg-inverse', min: 4.5 },
  { fg: '--tooltip-fg', bg: '--tooltip-bg', min: 4.5 },
  ...['--bg-canvas', '--bg-surface-1', '--panel-top'].map((bg) => ({ fg: '--ring', bg, min: 3, accent: true })),
  ...['--bg-canvas', '--bg-surface-1'].map((bg) => ({ fg: '--border-strong', bg, min: 3 })),
];

const pairId = (app: Appearance, p: Pair) => `${app.theme}/${app.accent}: ${p.fg} on ${p.bg}`;

interface Result {
  id: string;
  ratio: number;
  min: number;
  detail: string;
}

function evaluate(): { results: Result[]; unresolved: string[] } {
  const decls = collectRootDecls(SHEETS.map(read));
  const results: Result[] = [];
  const unresolved: string[] = [];
  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      const app = { theme, accent };
      const tokens = resolveTokens(decls, app);
      const color = (name: string): Rgba | null => {
        const raw = tokens.get(name);
        return raw === undefined ? null : evalColor(substitute(raw, tokens));
      };
      const window = color('--bg-window');
      for (const p of PAIRS) {
        if (!p.accent && accent !== 'graphite') continue;
        const fg = color(p.fg);
        let bg = color(p.bg);
        if (!fg || !bg || !window) {
          unresolved.push(pairId(app, p));
          continue;
        }
        if (bg.a < 1) bg = over(bg, window);
        const ratio = contrast(fg, bg);
        results.push({ id: pairId(app, p), ratio, min: p.min, detail: `${hex(fg)} on ${hex(bg)} = ${ratio.toFixed(2)}:1 (needs ${p.min}:1)` });
      }
    }
  }
  return { results, unresolved };
}

describe('token contrast', () => {
  const { results, unresolved } = evaluate();
  const allow = new Set(CONTRAST_ALLOWLIST);

  test('every token pair resolves to a colour', () => {
    expect(unresolved).toEqual([]);
    expect(results.length).toBeGreaterThan(100);
  });

  test('text ≥ 4.5:1, tertiary text and UI boundaries ≥ 3:1 (except the listed known failures)', () => {
    const failing = results.filter((r) => r.ratio + 1e-9 < r.min);
    const regressions = failing.filter((r) => !allow.has(r.id)).map((r) => `${r.id}  ${r.detail}`);
    const nowPassing = [...allow].filter((id) => results.some((r) => r.id === id && r.ratio + 1e-9 >= r.min));
    if (nowPassing.length) console.info(`[contrast] these allowlisted pairs pass now; delete them from contrast-allowlist.ts:\n  ${nowPassing.join('\n  ')}`);
    if (process.env.GUARDS_REPORT === '1') console.info(`[contrast] ${results.length} pairs, ${failing.length} below target:\n  ${failing.map((r) => `${r.id}  ${r.detail}`).join('\n  ')}`);
    expect(regressions, 'New contrast failures (fix the token, do not extend the allowlist)').toEqual([]);
  });

  test('the allowlist only names real pairs', () => {
    const ids = new Set(results.map((r) => r.id));
    expect(CONTRAST_ALLOWLIST.filter((id) => !ids.has(id))).toEqual([]);
  });
});
