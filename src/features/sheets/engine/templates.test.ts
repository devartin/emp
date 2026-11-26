import { describe, expect, it } from 'vitest';
import { cellKey, parseCell } from './addr';
import { Calc } from './calc';
import { BookBuilder, buildBudget, buildLoan, buildSavings } from './templates';
import { readXlsx, writeXlsx } from './xlsx';

let n = 0;
const newId = () => `id${++n}`;
const env = { now: () => Date.UTC(2026, 10, 26, 10), rand: () => 0.42 };

function at(calc: Calc, sheetId: string, a1: string) {
  const p = parseCell(a1)!;
  return calc.cellView(sheetId, p.r, p.c);
}

describe('templates', () => {
  it('builds a consistent mortgage model', () => {
    const b = new BookBuilder('wb1', newId);
    buildLoan(b);
    const t0 = performance.now();
    const calc = new Calc(b.wb, b.sheets, env);
    const ms = performance.now() - t0;
    const inputs = b.sheets[0].id;
    expect(at(calc, inputs, 'B13')?.d).toBe('$2,586.01');
    expect(at(calc, inputs, 'B24')?.value).toBe(true);
    expect(at(calc, inputs, 'B25')?.value).toBe(true);
    expect((at(calc, inputs, 'B17')?.value as number) < 360).toBe(true);
    expect(ms).toBeLessThan(1500);
    // Edit an input and recalc the chain.
    const t1 = performance.now();
    calc.setInputs(inputs, [{ r: 9, c: 1, input: '0' }]);
    expect(performance.now() - t1).toBeLessThan(500);
    expect(at(calc, inputs, 'B17')?.value).toBe(360);
    expect(at(calc, inputs, 'B24')?.value).toBe(true);
  });

  it('builds the household budget with passing checks', () => {
    const b = new BookBuilder('wb2', newId);
    buildBudget(b);
    const calc = new Calc(b.wb, b.sheets, env);
    const [budget, overview] = b.sheets;
    expect(at(calc, overview.id, 'B17')?.value).toBe(true);
    expect(at(calc, overview.id, 'B18')?.value).toBe(true);
    const rent = at(calc, budget.id, 'O12');
    expect(rent?.value).toBe(2150 * 11);
    expect(at(calc, overview.id, 'D5')?.d).toBe('Rent');
    expect(at(calc, overview.id, 'D6')?.f).toBe(2);
    expect(calc.condFormats(budget.id, { r0: 0, c0: 0, r1: 40, c1: 20 }).length).toBeGreaterThan(5);
  });

  it('savings model', () => {
    const b = new BookBuilder('wb3', newId);
    buildSavings(b);
    const calc = new Calc(b.wb, b.sheets, env);
    expect(at(calc, b.sheets[0].id, 'B36')?.d).toBe('$391,147');
  });

  it('round-trips through xlsx', async () => {
    const b = new BookBuilder('wb4', newId);
    buildLoan(b);
    const calc = new Calc(b.wb, b.sheets, env);
    const sheets = b.sheets.map((s) => ({
      name: s.name,
      hidden: false,
      frozen: s.frozen,
      merges: s.merges,
      colWidths: Object.entries(s.colWidths).map(([k, v]) => [Number(k), v] as [number, number]),
      rowHeights: [],
      cells: [...calc.inputs(s.id)].map((c) => ({ r: c.r, c: c.c, input: c.input, value: calc.value(s.id, c.r, c.c) as number | string | boolean | null, style: { numFmt: calc.style(c.style).numFmt } })),
    }));
    const bytes = writeXlsx(sheets, b.wb.namedRanges);
    const back = await readXlsx(bytes);
    expect(back.sheets.map((s) => s.name)).toEqual(['Inputs', 'Schedule', 'Rate scenarios']);
    expect(back.sheets[1].cells.get(cellKey(5, 2))?.input).toBe('=H5');
    expect(back.names.find((x) => x.name === 'Rate')?.ref).toBe('Inputs!$B$6');
    expect(back.sheets[1].frozen).toEqual({ rows: 4, cols: 1 });
  });
});
