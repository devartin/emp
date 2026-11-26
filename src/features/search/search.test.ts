import { describe, expect, test } from 'vitest';
import { calcSync, prettyExpr } from './calc';
import { fuzzy } from './fuzzy';

describe('fuzzy', () => {
  test('prefix beats word start beats scattered', () => {
    const a = fuzzy('lis', 'Lisbon in March')!;
    const b = fuzzy('lis', 'Reading list')!;
    const c = fuzzy('lis', 'Life OS')!;
    expect(a.match).toBeGreaterThan(b.match);
    expect(b.match).toBeGreaterThan(c.match);
    expect(a.ranges).toEqual([[0, 3]]);
  });
  test('non-matches return null; multi-word matches any order', () => {
    expect(fuzzy('xyz', 'Lisbon')).toBeNull();
    expect(fuzzy('march lis', 'Lisbon in March')).not.toBeNull();
  });
});

describe('calculator', () => {
  test('arithmetic, percent of, units and temperature', () => {
    expect(calcSync('= 12 * 4.5')?.copy).toBe('54');
    expect(calcSync('15% of 80')?.copy).toBe('12');
    expect(Number(calcSync('5 km in mi')?.copy)).toBeCloseTo(3.10686, 4);
    expect(Number(calcSync('212 f to c')?.copy)).toBeCloseTo(100, 6);
    expect(calcSync('5 km in kg')).toBeNull();
    expect(calcSync('hello world')).toBeNull();
  });
});

describe('calculator echo', () => {
  test('binary operators are evenly spaced with thin spaces; unary minus stays attached', () => {
    const t = '\u2009';
    expect(prettyExpr('1200*12+340')).toBe(`1200${t}×${t}12${t}+${t}340`);
    expect(prettyExpr('1200 × 12+340')).toBe(`1200${t}×${t}12${t}+${t}340`);
    expect(prettyExpr('-3*(2-1)')).toBe(`−3${t}×${t}(2${t}−${t}1)`);
    expect(prettyExpr('15% of 80')).toBe('15% of 80');
  });
});
