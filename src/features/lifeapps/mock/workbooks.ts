/**
 * Mock-only: Spreadsheet Studio workbooks (§16.5) not covered by the sheets feature's templates — decision matrix,
 * project budget, timesheet, inventory, split expenses and a best-practice blank. Conventions: inputs use
 * role:'input', outputs are bold, a legend row on top, constants as named ranges, frozen headers, ISO dates.
 */
import type { CellStyle } from '@/backend/types';
import { BookBuilder, buildBudget, buildLoan, buildSavings, type SheetBuilder } from '@/features/sheets/engine/templates';

const S = {
  title: { font: { b: true, size: 18 } } as CellStyle,
  subtitle: { font: { i: true, color: '#8A8A94' } } as CellStyle,
  header: { font: { b: true }, fill: '#F1F1F0', border: { b: { style: 'thin', color: '#D4D4D8' } } } as CellStyle,
  input: { role: 'input' } as CellStyle,
  output: { role: 'output', font: { b: true } } as CellStyle,
  check: { role: 'check', align: { h: 'center' } } as CellStyle,
  total: { font: { b: true }, border: { t: { style: 'thin', color: '#A1A1AA' } } } as CellStyle,
};
const MONEY = '$#,##0.00';

function legend(sh: SheetBuilder, a1: string): void {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const col = m[1].charCodeAt(0) - 65;
  const row = Number(m[2]) - 1;
  sh.at(row, col, 'Legend', { font: { color: '#8A8A94', size: 11 } });
  sh.at(row, col + 1, 'Input', { ...S.input, align: { h: 'center' } });
  sh.at(row, col + 2, 'Formula', { font: { b: true }, align: { h: 'center' } });
  sh.at(row, col + 3, 'Check', S.check);
}

function changelog(b: BookBuilder, today: string): void {
  const sh = b.sheet('Changelog');
  sh.row('A1', ['Date', 'Change', 'By'], S.header);
  sh.row('A2', [today, 'Created with Spreadsheet Studio', 'You']);
  sh.freeze(1, 0).width('A', 110).width('B', 360);
}

export function buildDecision(b: BookBuilder): void {
  const sh = b.sheet('Decision');
  b.name('Weights', 'Decision!$B$6:$F$6');
  sh.set('A1', 'Decision matrix — choosing a new laptop', S.title);
  sh.set('A2', 'Score = SUMPRODUCT(Weights, Scores). Weights must add up to 100%.', S.subtitle);
  legend(sh, 'E3');
  sh.row('A5', ['Criteria →', 'Performance', 'Battery', 'Price', 'Weight', 'Screen', 'Score', 'Rank'], { ...S.header, align: { h: 'center' } });
  sh.set('A6', 'Weight', { font: { b: true } });
  [0.3, 0.2, 0.25, 0.1, 0.15].forEach((w, i) => sh.at(5, 1 + i, w, { ...S.input, numFmt: '0%', align: { h: 'center' } }));
  const options: [string, number[]][] = [
    ['Aurora 14', [9, 7, 5, 8, 9]],
    ['Nimbus Air', [7, 9, 7, 9, 7]],
    ['Vector Pro 16', [10, 6, 3, 5, 10]],
    ['Pebble 13', [6, 8, 9, 10, 6]],
  ];
  options.forEach(([name, scores], i) => {
    const r = 7 + i;
    sh.set(`A${r}`, name, { font: { b: true } });
    scores.forEach((s, j) => sh.at(r - 1, 1 + j, s, { ...S.input, align: { h: 'center' } }));
    sh.set(`G${r}`, `=SUMPRODUCT(Weights, B${r}:F${r})`, { ...S.output, numFmt: '0.00', align: { h: 'center' } });
    sh.set(`H${r}`, `=RANK.EQ(G${r}, $G$7:$G$10)`, { align: { h: 'center' } });
  });
  sh.set('A12', 'Checks', { font: { b: true } });
  sh.set('A13', 'Weights add up to 100%');
  sh.set('B13', '=IF(ROUND(SUM(Weights), 4)=1, "OK", "Fix weights")', S.check);
  sh.set('A15', 'Sensitivity — score if each weight moves ±10%', { font: { b: true } });
  sh.row('A16', ['Option', '−10% Performance', '+10% Performance', '−10% Price', '+10% Price'], S.header);
  options.forEach(([name], i) => {
    const r = 17 + i;
    const src = 7 + i;
    sh.set(`A${r}`, name);
    sh.set(`B${r}`, `=G${src}-0.1*$B$6*B${src}`, { numFmt: '0.00' });
    sh.set(`C${r}`, `=G${src}+0.1*$B$6*B${src}`, { numFmt: '0.00' });
    sh.set(`D${r}`, `=G${src}-0.1*$D$6*D${src}`, { numFmt: '0.00' });
    sh.set(`E${r}`, `=G${src}+0.1*$D$6*D${src}`, { numFmt: '0.00' });
  });
  sh.cf('G7:G10', { kind: 'data_bar', colors: ['#5E5CE6'] });
  sh.freeze(5, 1).width('A', 150);
  ['B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((c) => sh.width(c, 110));
}

export function buildProjectBudget(b: BookBuilder): void {
  const sh = b.sheet('Budget');
  b.name('Contingency', 'Budget!$B$4');
  sh.set('A1', 'Project budget — kitchen refresh', S.title);
  legend(sh, 'E2');
  sh.set('A4', 'Contingency');
  sh.set('B4', 0.1, { ...S.input, numFmt: '0%' });
  sh.row('A6', ['Line item', 'Category', 'Estimate', 'Actual', 'Variance', 'Status'], S.header);
  const items: [string, string, number, number | null][] = [
    ['Cabinet paint & primer', 'Materials', 420, 465],
    ['Under-cabinet lighting', 'Materials', 380, 352],
    ['Electrician', 'Labour', 600, null],
    ['Hardware (pulls & hinges)', 'Materials', 240, 228],
    ['Backsplash tiles', 'Materials', 520, null],
    ['Tiler', 'Labour', 900, null],
    ['Skip hire', 'Other', 180, 180],
  ];
  items.forEach(([name, cat, est, act], i) => {
    const r = 7 + i;
    sh.set(`A${r}`, name);
    sh.set(`B${r}`, cat);
    sh.set(`C${r}`, est, { ...S.input, numFmt: MONEY });
    if (act !== null) sh.set(`D${r}`, act, { ...S.input, numFmt: MONEY });
    else sh.set(`D${r}`, '', S.input);
    sh.set(`E${r}`, `=IF(D${r}="", "", D${r}-C${r})`, { numFmt: '$#,##0.00;[Red]-$#,##0.00' });
    sh.set(`F${r}`, `=IF(D${r}="", "Pending", IF(D${r}>C${r}, "Over", "OK"))`);
  });
  const last = 6 + items.length;
  sh.set(`A${last + 2}`, 'Subtotal', S.total);
  sh.set(`C${last + 2}`, `=SUM(C7:C${last})`, { ...S.total, numFmt: MONEY });
  sh.set(`D${last + 2}`, `=SUM(D7:D${last})`, { ...S.total, numFmt: MONEY });
  sh.set(`A${last + 3}`, 'With contingency', { font: { b: true } });
  sh.set(`C${last + 3}`, `=C${last + 2}*(1+Contingency)`, { ...S.output, numFmt: MONEY });
  sh.set(`A${last + 5}`, 'Spent so far');
  sh.set(`C${last + 5}`, `=IFERROR(D${last + 2}/C${last + 2}, 0)`, { ...S.output, numFmt: '0%' });
  sh.freeze(6, 1).width('A', 200).width('B', 110).width('C', 110).width('D', 110).width('E', 110).width('F', 90);
}

export function buildTimesheet(b: BookBuilder, today: string): void {
  const sh = b.sheet('Timesheet');
  b.name('Overtime', 'Timesheet!$B$4');
  sh.set('A1', 'Timesheet', S.title);
  sh.set('A2', 'Hours = MOD(End − Start, 1) × 24 − Break ÷ 60', S.subtitle);
  legend(sh, 'E2');
  sh.set('A4', 'Weekly overtime after (h)');
  sh.set('B4', 40, { ...S.input, numFmt: '0' });
  sh.row('A6', ['Date', 'Start', 'End', 'Break (min)', 'Hours', 'Week'], S.header);
  const start = Date.parse(`${today}T00:00:00Z`) - 13 * 86_400_000;
  let r = 7;
  for (let i = 0; i < 14; i++) {
    const d = new Date(start + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    sh.set(`A${r}`, d.toISOString().slice(0, 10), { numFmt: 'yyyy-mm-dd' });
    sh.set(`B${r}`, ['08:30', '09:00', '08:45', '09:15', '08:30'][i % 5], { ...S.input, numFmt: 'hh:mm' });
    sh.set(`C${r}`, ['17:15', '18:10', '17:30', '17:45', '16:30'][i % 5], { ...S.input, numFmt: 'hh:mm' });
    sh.set(`D${r}`, [45, 30, 60, 30, 30][i % 5], { ...S.input, numFmt: '0' });
    sh.set(`E${r}`, `=MOD(C${r}-B${r},1)*24-D${r}/60`, { numFmt: '0.00' });
    sh.set(`F${r}`, `=WEEKNUM(A${r})`);
    r++;
  }
  const last = r - 1;
  sh.set(`A${r + 1}`, 'Week', S.header);
  sh.set(`B${r + 1}`, 'Hours', S.header);
  sh.set(`C${r + 1}`, 'Overtime', S.header);
  sh.set(`A${r + 2}`, `=F7`);
  sh.set(`B${r + 2}`, `=SUMIFS(E7:E${last}, F7:F${last}, A${r + 2})`, { ...S.output, numFmt: '0.0' });
  sh.set(`C${r + 2}`, `=MAX(0, B${r + 2}-Overtime)`, { numFmt: '0.0' });
  sh.set(`A${r + 3}`, `=F${last}`);
  sh.set(`B${r + 3}`, `=SUMIFS(E7:E${last}, F7:F${last}, A${r + 3})`, { ...S.output, numFmt: '0.0' });
  sh.set(`C${r + 3}`, `=MAX(0, B${r + 3}-Overtime)`, { numFmt: '0.0' });
  sh.freeze(6, 1).width('A', 110).width('D', 100);
}

export function buildInventory(b: BookBuilder): void {
  const sh = b.sheet('Inventory');
  sh.set('A1', 'Inventory', S.title);
  legend(sh, 'E2');
  sh.row('A4', ['Item', 'SKU', 'Qty', 'Unit cost', 'Value', 'Reorder point'], S.header);
  const items: [string, string, number, number, number][] = [
    ['Notebook A5', 'NB-A5', 42, 3.2, 20],
    ['Gel pen, black', 'PEN-BK', 12, 0.9, 30],
    ['Sticky notes', 'STK-3X3', 64, 1.1, 25],
    ['Printer paper (ream)', 'PPR-A4', 6, 4.5, 8],
    ['Desk lamp bulbs', 'BLB-E27', 3, 2.8, 4],
    ['Shipping boxes (M)', 'BOX-M', 140, 0.65, 50],
  ];
  items.forEach(([name, sku, q, cost, rp], i) => {
    const r = 5 + i;
    sh.set(`A${r}`, name);
    sh.set(`B${r}`, sku);
    sh.set(`C${r}`, q, { ...S.input, numFmt: '0' });
    sh.set(`D${r}`, cost, { ...S.input, numFmt: MONEY });
    sh.set(`E${r}`, `=C${r}*D${r}`, { numFmt: MONEY });
    sh.set(`F${r}`, rp, { ...S.input, numFmt: '0' });
  });
  const last = 4 + items.length;
  sh.set(`A${last + 2}`, 'Total value', S.total);
  sh.set(`E${last + 2}`, `=SUM(E5:E${last})`, { ...S.output, numFmt: MONEY });
  sh.set(`A${last + 4}`, 'Reorder now', { font: { b: true } });
  sh.set(`A${last + 5}`, `=FILTER(A5:A${last}, C5:C${last}<=F5:F${last}, "Nothing to reorder")`);
  sh.cf(`A5:F${last}`, { kind: 'formula', formula: '=$C5<=$F5', style: { fill: '#FBE3E4', font: { color: '#B4232F' } } });
  sh.freeze(4, 1).width('A', 190).width('B', 90);
}

export function buildSplit(b: BookBuilder): void {
  const sh = b.sheet('Expenses');
  sh.set('A1', 'Split expenses — Lisbon trip', S.title);
  legend(sh, 'E2');
  sh.row('A4', ['Date', 'What', 'Paid by', 'Amount', 'Split between'], S.header);
  const rows: [string, string, string, number][] = [
    ['2026-03-08', 'Flights', 'Alex', 864.4],
    ['2026-03-19', 'Hotel — 5 nights', 'Sam', 742.15],
    ['2026-03-20', 'Dinner at Taberna', 'Jordan', 126.8],
    ['2026-03-21', 'Tram & ferry passes', 'Alex', 48.6],
    ['2026-03-22', 'Sintra day trip', 'Sam', 154],
  ];
  rows.forEach(([d, w, p, a], i) => {
    const r = 5 + i;
    sh.set(`A${r}`, d, { numFmt: 'yyyy-mm-dd' });
    sh.set(`B${r}`, w);
    sh.set(`C${r}`, p, S.input);
    sh.set(`D${r}`, a, { ...S.input, numFmt: MONEY });
    sh.set(`E${r}`, 3, { ...S.input, numFmt: '0' });
  });
  const bal = b.sheet('Balances');
  bal.row('A1', ['Person', 'Paid', 'Share', 'Balance'], S.header);
  ['Alex', 'Sam', 'Jordan'].forEach((p, i) => {
    const r = 2 + i;
    bal.set(`A${r}`, p, { font: { b: true } });
    bal.set(`B${r}`, `=SUMIFS(Expenses!D5:D9, Expenses!C5:C9, A${r})`, { numFmt: MONEY });
    bal.set(`C${r}`, `=SUM(Expenses!D5:D9)/3`, { numFmt: MONEY });
    bal.set(`D${r}`, `=B${r}-C${r}`, { ...S.output, numFmt: '$#,##0.00;[Red]-$#,##0.00' });
  });
  bal.set('A7', 'Who pays whom', { font: { b: true } });
  bal.row('A8', ['From', 'To', 'Amount'], S.header);
  // minimal transfers (largest debtor pays largest creditor), written as values (§16.5)
  const paid: Record<string, number> = { Alex: 0, Sam: 0, Jordan: 0 };
  for (const [, , p, a] of rows) paid[p] += a;
  const share = Object.values(paid).reduce((s, x) => s + x, 0) / 3;
  const bals = Object.entries(paid).map(([p, v]) => [p, Math.round((v - share) * 100) / 100] as [string, number]);
  let r = 9;
  const debtors = bals.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  const creditors = bals.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  while (debtors.length && creditors.length) {
    const d = debtors[0];
    const cr = creditors[0];
    const amt = Math.min(-d[1], cr[1]);
    bal.row(`A${r++}`, [d[0], cr[0], Math.round(amt * 100) / 100]);
    d[1] += amt;
    cr[1] -= amt;
    if (Math.abs(d[1]) < 0.01) debtors.shift();
    if (Math.abs(cr[1]) < 0.01) creditors.shift();
  }
  sh.freeze(4, 0).width('B', 180);
  bal.width('A', 120).width('B', 110).width('C', 110).width('D', 110);
}

export function buildStructured(b: BookBuilder): void {
  const inputs = b.sheet('Inputs');
  inputs.set('A1', 'Inputs', S.title);
  inputs.set('A2', 'Every constant lives here, named and coloured as an input.', S.subtitle);
  legend(inputs, 'E2');
  inputs.row('A4', ['Name', 'Value', 'Notes'], S.header);
  inputs.set('A5', 'Growth rate');
  inputs.set('B5', 0.05, { ...S.input, numFmt: '0.0%' });
  b.name('Growth', 'Inputs!$B$5');
  inputs.width('A', 160).width('C', 240).freeze(4, 0);
  const calc = b.sheet('Calculations');
  calc.row('A1', ['Year', 'Value'], S.header);
  for (let y = 0; y <= 10; y++) {
    calc.set(`A${y + 2}`, y);
    calc.set(`B${y + 2}`, y === 0 ? '=100' : `=B${y + 1}*(1+Growth)`, { numFmt: '0.00' });
  }
  calc.freeze(1, 0);
  const out = b.sheet('Output');
  out.set('A1', 'Output', S.title);
  out.set('A3', 'Value after 10 years');
  out.set('B3', '=Calculations!B12', { ...S.output, numFmt: '0.00' });
  const checks = b.sheet('Checks');
  checks.row('A1', ['Check', 'Status'], S.header);
  checks.set('A2', 'Growth is between 0% and 100%');
  checks.set('B2', '=IF(AND(Growth>=0, Growth<=1), "OK", "Check input")', S.check);
  checks.width('A', 260);
}

/** Builds the workbook for a Spreadsheet Studio intent. */
export function buildForIntent(b: BookBuilder, intent: string, opts: { structure: string[]; today: string }): void {
  switch (intent) {
    case 'loan':
      buildLoan(b);
      break;
    case 'budget':
      buildBudget(b);
      break;
    case 'savings':
      buildSavings(b);
      break;
    case 'decision':
      buildDecision(b);
      break;
    case 'project_budget':
      buildProjectBudget(b);
      break;
    case 'timesheet':
      buildTimesheet(b, opts.today);
      break;
    case 'inventory':
      buildInventory(b);
      break;
    case 'split':
      buildSplit(b);
      break;
    default:
      buildStructured(b);
  }
  if (opts.structure.includes('changelog')) changelog(b, opts.today);
}
