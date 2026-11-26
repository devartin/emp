import { describe, expect, it } from 'vitest';
import { cellKey } from './addr';
import { Calc, type SheetData, type WorkbookData } from './calc';
import { formatValue } from './numfmt';
import { adjustFormula, renameSheetRefs, shiftFormula } from './refs';
import { tokenize } from './lexer';

function book(cells: Record<string, string>, name = 'Sheet1'): { calc: Calc; sheet: SheetData } {
  const sheet: SheetData = { id: 's1', workbookId: 'w', name, hidden: false, frozen: { rows: 0, cols: 0 }, sortKey: 'a0', cells: {}, colWidths: {}, rowHeights: {}, merges: [], cf: [] };
  for (const [a1, input] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
    const c = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    sheet.cells[String(cellKey(Number(m[2]) - 1, c))] = { i: input };
  }
  const wb: WorkbookData = { id: 'w', styles: {}, nextStyleId: 1, namedRanges: [], calc: { iterative: false, date1904: false } };
  return { calc: new Calc(wb, [sheet], { now: () => Date.UTC(2026, 10, 26, 10), rand: () => 0.5 }), sheet };
}
const v = (calc: Calc, a1: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const c = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return calc.cellView('s1', Number(m[2]) - 1, c);
};

describe('formula engine', () => {
  it('evaluates arithmetic with Excel precedence', () => {
    const { calc } = book({ A1: '=-2^2', A2: '=1+2*3', A3: '=(1+2)*3', A4: '=10%', A5: '="a"&1+1', A6: '=0.1+0.2' });
    expect(v(calc, 'A1')?.value).toBe(4);
    expect(v(calc, 'A2')?.value).toBe(7);
    expect(v(calc, 'A3')?.value).toBe(9);
    expect(v(calc, 'A4')?.value).toBe(0.1);
    expect(v(calc, 'A5')?.value).toBe('a2');
    expect(v(calc, 'A6')?.d).toBe('0.3');
  });

  it('recalculates dependents transitively', () => {
    const { calc } = book({ A1: '1', A2: '=A1*2', A3: '=A2+A1', B1: '=SUM(A1:A3)' });
    expect(v(calc, 'B1')?.value).toBe(6);
    const changed = calc.setInputs('s1', [{ r: 0, c: 0, input: '10' }]);
    expect(v(calc, 'A3')?.value).toBe(30);
    expect(v(calc, 'B1')?.value).toBe(60);
    expect(changed.get('s1')?.size).toBe(4);
  });

  it('detects cycles', () => {
    const { calc } = book({ A1: '=B1', B1: '=A1+1' });
    expect(v(calc, 'A1')?.k).toBe(4);
  });

  it('spills dynamic arrays and blocks with #SPILL!', () => {
    const { calc } = book({ A1: '=SEQUENCE(3)', B1: '=SUM(A1:A3)' });
    expect(v(calc, 'A3')?.value).toBe(3);
    expect(v(calc, 'A3')?.f).toBe(2);
    expect(v(calc, 'B1')?.value).toBe(6);
    calc.setInputs('s1', [{ r: 1, c: 0, input: 'x' }]);
    expect(v(calc, 'A1')?.d).toBe('#SPILL!');
    calc.setInputs('s1', [{ r: 1, c: 0, input: null }]);
    expect(v(calc, 'A2')?.value).toBe(2);
  });

  it('financial functions match Excel', () => {
    const { calc } = book({ A1: '=PMT(0.06/12, 360, -300000)', A2: '=FV(0.05/12, 120, -100, -1000)', A3: '=NPV(0.1, -10000, 3000, 4200, 6800)', A4: '=IPMT(0.1/12, 1, 36, 8000)', A5: '=IRR({-70000,12000,15000,18000,21000,26000})', A6: '=CUMPRINC(0.09/12, 360, 125000, 13, 24, 0)' });
    expect(v(calc, 'A1')?.value as number).toBeCloseTo(1798.65, 2);
    expect(v(calc, 'A2')?.value as number).toBeCloseTo(17175.24, 1);
    expect(v(calc, 'A3')?.value as number).toBeCloseTo(1188.44, 2);
    expect(v(calc, 'A4')?.value as number).toBeCloseTo(-66.67, 2);
    expect(v(calc, 'A5')?.value as number).toBeCloseTo(0.0866, 4);
    expect(v(calc, 'A6')?.value as number).toBeCloseTo(-934.1071, 3);
  });

  it('lookups, criteria and text', () => {
    const { calc } = book({
      A1: 'apple', B1: '3', A2: 'banana', B2: '5', A3: 'cherry', B3: '7',
      C1: '=VLOOKUP("banana", A1:B3, 2, FALSE)', C2: '=SUMIF(A1:A3, "<>apple", B1:B3)', C3: '=COUNTIF(B1:B3, ">4")',
      C4: '=XLOOKUP("ch*", A1:A3, B1:B3, "none", 2)', C5: '=TEXTJOIN(", ", TRUE, A1:A3)', C6: '=INDEX(A1:B3, MATCH(7, B1:B3, 0), 1)',
      C7: '=IFERROR(1/0, "n/a")', C8: '=TEXT(1234.5, "$#,##0.00")', C9: '=AVERAGE(B1:B3)',
    });
    expect(v(calc, 'C1')?.value).toBe(5);
    expect(v(calc, 'C2')?.value).toBe(12);
    expect(v(calc, 'C3')?.value).toBe(2);
    expect(v(calc, 'C4')?.value).toBe(7);
    expect(v(calc, 'C5')?.value).toBe('apple, banana, cherry');
    expect(v(calc, 'C6')?.value).toBe('cherry');
    expect(v(calc, 'C7')?.value).toBe('n/a');
    expect(v(calc, 'C8')?.value).toBe('$1,234.50');
    expect(v(calc, 'C9')?.value).toBe(5);
  });

  it('dates', () => {
    const { calc } = book({ A1: '=DATE(2026,1,31)', A2: '=EOMONTH(A1, 1)', A3: '=YEAR(A2)*100+MONTH(A2)', A4: '=EDATE(A1, 1)', A5: '=DATEDIF(DATE(2000,5,1), DATE(2026,4,30), "Y")' });
    expect(v(calc, 'A1')?.value).toBe(46053);
    expect(v(calc, 'A3')?.value).toBe(202602);
    expect(v(calc, 'A4')?.value).toBe(46081);
    expect(v(calc, 'A5')?.value).toBe(25);
  });
});

describe('number formats', () => {
  it('formats numbers', () => {
    expect(formatValue(1234.567, '#,##0.00').text).toBe('1,234.57');
    expect(formatValue(-1234.5, '$#,##0.00').text).toBe('-$1,234.50');
    expect(formatValue(-1234.5, '#,##0.00;(#,##0.00)').text).toBe('(1,234.50)');
    expect(formatValue(0.256, '0.0%').text).toBe('25.6%');
    expect(formatValue(1500000, '#,##0.0,,"M"').text).toBe('1.5M');
    expect(formatValue(46053, 'yyyy-mm-dd').text).toBe('2026-01-31');
    expect(formatValue(46053, 'mmm d, yyyy').text).toBe('Jan 31, 2026');
    expect(formatValue(0.75, 'h:mm AM/PM').text).toBe('6:00 PM');
    expect(formatValue(12345.678, '0.00E+00').text).toBe('1.23E+04');
    expect(formatValue(1.005, '0.00').text).toBe('1.01');
    expect(formatValue(0, '$#,##0.00;($#,##0.00);"–"').text).toBe('–');
  });
});

describe('reference rewriting', () => {
  it('shifts relative references', () => {
    expect(shiftFormula('=A1+$B$2+C$3+Sheet2!D4', 1, 1)).toBe('=B2+$B$2+D$3+Sheet2!E5');
    expect(shiftFormula('=A1', -1, 0)).toBe('=#REF!');
  });
  it('adjusts for inserted / deleted rows', () => {
    expect(adjustFormula('=SUM(A1:A10)', 'Sheet1', { sheetName: 'Sheet1', axis: 'rows', at: 4, count: 2 })).toBe('=SUM(A1:A12)');
    expect(adjustFormula('=A5+A6', 'Sheet1', { sheetName: 'Sheet1', axis: 'rows', at: 4, count: -1 })).toBe('=#REF!+A5');
    expect(adjustFormula('=Data!B3', 'Sheet1', { sheetName: 'Data', axis: 'cols', at: 0, count: 1 })).toBe('=Data!C3');
  });
  it('renames sheets', () => {
    expect(renameSheetRefs("=Budget!A1+'Old name'!B2", 'Old name', 'New Sheet')).toBe("=Budget!A1+'New Sheet'!B2");
  });
  it('tokenizes losslessly', () => {
    const src = "=IF(SUM('My Sheet'!A1:B2) >= 10, \"ok\", #N/A)";
    expect(tokenize(src).map((t) => t.v).join('')).toBe(src);
  });
});
