import { describe, expect, test } from 'vitest';

/**
 * Static guards for selector mistakes the CSS pipeline silently drops (Lightning CSS discards a whole rule when one
 * selector in it is invalid, so the bug ships without a build error).
 */
const sheets = import.meta.glob('/src/**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('CSS guards', () => {
  test('found the stylesheets', () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(5);
  });

  test('no pseudo-element inside :is() / :where() / :not() / :has() (invalid → the whole rule is dropped)', () => {
    const bad: string[] = [];
    for (const [file, raw] of Object.entries(sheets)) {
      const css = stripComments(raw);
      const re = /:(?:is|where|not|has)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
      for (let m = re.exec(css); m; m = re.exec(css)) {
        if (/::[a-z-]/i.test(m[1])) {
          const line = css.slice(0, m.index).split('\n').length;
          bad.push(`${file}:${line} ${m[0].slice(0, 120)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
