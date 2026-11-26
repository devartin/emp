/**
 * Workbook builders: the demo seed's household budget and mortgage model, and the `sheet_workbook_create`
 * templates (`blank`, `budget`, `loan`, `savings`). Conventions (§16.5): inputs use `role:'input'`, outputs are bold,
 * a legend row sits at the top, constants live in named ranges on Inputs, header rows are frozen, dates are ISO.
 */
import type { CellStyle, CondFormatRule, Rect } from '@/backend/types';
import { generateKeyBetween } from '@/lib/fractional-index';
import { cellKey, colIndex, parseCell, parseRect } from './addr';
import { cleanStyle, stableStyleKey, type SheetData, type WorkbookData } from './calc';

export class BookBuilder {
  readonly wb: WorkbookData;
  readonly sheets: SheetData[] = [];
  private styleIds = new Map<string, number>();
  private newId: () => string;
  constructor(id: string, newId: () => string) {
    this.wb = { id, styles: {}, nextStyleId: 1, namedRanges: [], calc: { iterative: false, date1904: false } };
    this.newId = newId;
  }
  style(s: CellStyle | undefined): number {
    if (!s) return 0;
    const clean = cleanStyle(s);
    if (!Object.keys(clean).length) return 0;
    const k = stableStyleKey(clean);
    let id = this.styleIds.get(k);
    if (id === undefined) {
      id = this.wb.nextStyleId++;
      this.wb.styles[id] = clean;
      this.styleIds.set(k, id);
    }
    return id;
  }
  sheet(name: string): SheetBuilder {
    const prev = this.sheets[this.sheets.length - 1]?.sortKey ?? null;
    const data: SheetData = {
      id: this.newId(),
      workbookId: this.wb.id,
      name,
      hidden: false,
      frozen: { rows: 0, cols: 0 },
      sortKey: generateKeyBetween(prev, null),
      cells: {},
      colWidths: {},
      rowHeights: {},
      merges: [],
      cf: [],
    };
    this.sheets.push(data);
    return new SheetBuilder(this, data);
  }
  name(name: string, ref: string): this {
    this.wb.namedRanges.push({ name, ref });
    return this;
  }
}

export class SheetBuilder {
  readonly data: SheetData;
  private book: BookBuilder;
  constructor(book: BookBuilder, data: SheetData) {
    this.book = book;
    this.data = data;
  }
  set(a1: string, input: string | number, style?: CellStyle): this {
    const p = parseCell(a1);
    if (!p) throw new Error(`bad ref ${a1}`);
    return this.at(p.r, p.c, input, style);
  }
  at(r: number, c: number, input: string | number, style?: CellStyle): this {
    const s = this.book.style(style);
    const i = typeof input === 'number' ? String(input) : input;
    this.data.cells[String(cellKey(r, c))] = s ? { i, s } : { i };
    return this;
  }
  /** Writes values left-to-right from `a1`. */
  row(a1: string, values: (string | number | null)[], style?: CellStyle): this {
    const p = parseCell(a1)!;
    values.forEach((v, i) => {
      if (v !== null) this.at(p.r, p.c + i, v, style);
    });
    return this;
  }
  /** Applies a style to every cell of a range (keeping inputs). */
  styleRange(range: string, style: CellStyle): this {
    const rect = parseRect(range)!;
    for (let r = rect.r0; r <= rect.r1; r++)
      for (let c = rect.c0; c <= rect.c1; c++) {
        const k = String(cellKey(r, c));
        const cur = this.data.cells[k];
        const base = cur?.s ? this.book.wb.styles[cur.s] : {};
        const merged: CellStyle = { ...base, ...style, font: { ...base.font, ...style.font }, align: { ...base.align, ...style.align }, border: { ...base.border, ...style.border } };
        const s = this.book.style(merged);
        this.data.cells[k] = s ? { i: cur?.i ?? '', s } : { i: cur?.i ?? '' };
      }
    return this;
  }
  width(col: string, px: number): this {
    this.data.colWidths[String(colIndex(col))] = px;
    return this;
  }
  height(row: number, px: number): this {
    this.data.rowHeights[String(row - 1)] = px;
    return this;
  }
  freeze(rows: number, cols: number): this {
    this.data.frozen = { rows, cols };
    return this;
  }
  merge(range: string): this {
    this.data.merges.push(parseRect(range) as Rect);
    return this;
  }
  cf(range: string, rule: Omit<CondFormatRule, 'rect' | 'styleId'> & { style?: CellStyle }): this {
    const { style, ...rest } = rule;
    this.data.cf.push({ id: `cf${this.data.cf.length + 1}`, ...rest, rect: parseRect(range)!, styleId: style ? this.book.style(style) : undefined });
    return this;
  }
}

// ───────────────────────────────────────────────────────────────────────────── shared styles

const MONEY = '$#,##0;-$#,##0;"–"';
const MONEY2 = '$#,##0.00';
const S = {
  title: { font: { b: true, size: 18 } } as CellStyle,
  subtitle: { font: { i: true, color: '#8A8A94' } } as CellStyle,
  header: { font: { b: true }, fill: '#F1F1F0', border: { b: { style: 'thin', color: '#D4D4D8' } } } as CellStyle,
  section: { font: { b: true, size: 11, color: '#6E6E77' } } as CellStyle,
  input: { role: 'input' } as CellStyle,
  output: { role: 'output', font: { b: true } } as CellStyle,
  check: { role: 'check', align: { h: 'center' } } as CellStyle,
  total: { font: { b: true }, border: { t: { style: 'thin', color: '#A1A1AA' } } } as CellStyle,
};

function legend(sh: SheetBuilder, a1: string): void {
  const p = parseCell(a1)!;
  sh.at(p.r, p.c, 'Legend', { font: { color: '#8A8A94', size: 11 } });
  sh.at(p.r, p.c + 1, 'Input', { ...S.input, align: { h: 'center' } });
  sh.at(p.r, p.c + 2, 'Formula', { font: { b: true }, align: { h: 'center' } });
  sh.at(p.r, p.c + 3, 'Check', S.check);
}

// Small deterministic PRNG so the demo workbook is identical on every load.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ───────────────────────────────────────────────────────────────────────────── budget

interface Txn {
  date: string;
  desc: string;
  cat: string;
  amount: number;
  account: string;
}

const EXPENSES: { cat: string; budget: number }[] = [
  { cat: 'Rent', budget: 2150 },
  { cat: 'Utilities', budget: 210 },
  { cat: 'Groceries', budget: 680 },
  { cat: 'Dining out', budget: 320 },
  { cat: 'Transport', budget: 240 },
  { cat: 'Insurance', budget: 185 },
  { cat: 'Subscriptions', budget: 70 },
  { cat: 'Health & fitness', budget: 120 },
  { cat: 'Shopping', budget: 300 },
  { cat: 'Travel', budget: 400 },
  { cat: 'Gifts & giving', budget: 90 },
  { cat: 'Savings & investing', budget: 1200 },
];
const INCOME: { cat: string; budget: number }[] = [
  { cat: 'Salary', budget: 6850 },
  { cat: 'Freelance', budget: 750 },
  { cat: 'Interest', budget: 35 },
];

function transactions(throughMonth: number, throughDay: number): Txn[] {
  const rnd = prng(2026);
  const out: Txn[] = [];
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const amt = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
  for (let m = 1; m <= throughMonth; m++) {
    const last = m === throughMonth ? throughDay : new Date(Date.UTC(2026, m, 0)).getUTCDate();
    const add = (d: number, desc: string, cat: string, amount: number, account = 'Checking') => {
      if (d <= last) out.push({ date: iso(2026, m, d), desc, cat, amount, account });
    };
    add(1, 'Payroll — Northwind Labs', 'Salary', 3425);
    add(15, 'Payroll — Northwind Labs', 'Salary', 3425);
    add(1, 'Rent — Maple Court Apt 4B', 'Rent', 2150);
    add(5, 'Home & auto insurance', 'Insurance', 185);
    add(12, 'City Power & Water', 'Utilities', amt(128, m <= 2 || m >= 11 ? 214 : 162));
    add(14, 'Fiber internet', 'Utilities', 54.99);
    add(3, 'Streaming bundle', 'Subscriptions', 22.99, 'Credit card');
    add(9, 'Cloud storage', 'Subscriptions', 2.99, 'Credit card');
    add(18, 'Climbing gym', 'Health & fitness', 39, 'Credit card');
    add(20, 'Music', 'Subscriptions', 11.99, 'Credit card');
    add(28, 'Transfer to brokerage', 'Savings & investing', 1200);
    add(27, 'Savings interest', 'Interest', amt(28, 44));
    const groceries = 6 + Math.floor(rnd() * 3);
    for (let i = 0; i < groceries; i++) add(1 + Math.floor(rnd() * 28), pick(['Green Basket Market', 'Corner Grocer', 'Farmers market', 'Wholesale Club']), 'Groceries', amt(38, 142), 'Credit card');
    const dining = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < dining; i++) add(1 + Math.floor(rnd() * 28), pick(['Osteria Lumen', 'Pho 88', 'Blue Door Coffee', 'Taqueria Sol', 'Sushi Kame']), 'Dining out', amt(16, 92), 'Credit card');
    const transport = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < transport; i++) add(1 + Math.floor(rnd() * 28), pick(['Metro card top-up', 'Fuel — Shell', 'Rideshare', 'Parking']), 'Transport', amt(18, 74), 'Credit card');
    const shopping = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < shopping; i++) add(1 + Math.floor(rnd() * 28), pick(['Hardware store', 'Bookshop', 'Outdoor gear', 'Home goods', 'Electronics']), 'Shopping', amt(24, m === 11 ? 340 : 180), 'Credit card');
    if (rnd() < 0.45) add(1 + Math.floor(rnd() * 28), pick(['Pharmacy', 'Dentist co-pay', 'Physio session']), 'Health & fitness', amt(18, 140), 'Credit card');
    if (m === 3) {
      add(8, 'Flights — Lisbon', 'Travel', 864.4, 'Credit card');
      add(19, 'Hotel — Alfama, 5 nights', 'Travel', 742.15, 'Credit card');
      add(21, 'Tram & ferry passes', 'Travel', 48.6, 'Credit card');
    } else if (m === 7) {
      add(2, 'Cabin rental — Lake Tahoe', 'Travel', 1380, 'Credit card');
      add(4, 'Rental car', 'Travel', 412.9, 'Credit card');
    } else if (rnd() < 0.35) add(1 + Math.floor(rnd() * 28), 'Weekend train tickets', 'Travel', amt(60, 180), 'Credit card');
    if (m === 2 || m === 5 || m === 9 || m === 11 || rnd() < 0.25) add(1 + Math.floor(rnd() * 28), pick(['Birthday gift', 'Charity donation', 'Wedding gift']), 'Gifts & giving', amt(30, 160), 'Credit card');
    if (m % 2 === 0 || rnd() < 0.4) add(10 + Math.floor(rnd() * 15), pick(['Logo design — Acme Bakery', 'Website audit', 'Workshop facilitation']), 'Freelance', amt(450, 1650));
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function buildBudget(b: BookBuilder, opts: { throughMonth?: number; throughDay?: number } = {}): void {
  const txns = transactions(opts.throughMonth ?? 11, opts.throughDay ?? 25);
  const budget = b.sheet('Budget');
  const overview = b.sheet('Overview');
  const tx = b.sheet('Transactions');

  // Transactions
  tx.row('A1', ['Date', 'Description', 'Category', 'Amount', 'Account'], S.header);
  txns.forEach((t, i) => {
    const r = i + 1;
    tx.at(r, 0, t.date, { numFmt: 'yyyy-mm-dd' });
    tx.at(r, 1, t.desc);
    tx.at(r, 2, t.cat);
    tx.at(r, 3, t.amount, { numFmt: MONEY2 });
    tx.at(r, 4, t.account, { font: { color: '#8A8A94' } });
  });
  tx.freeze(1, 0).width('A', 104).width('B', 232).width('C', 160).width('D', 104).width('E', 112);
  tx.cf(`D2:D${txns.length + 1}`, { kind: 'data_bar', colors: ['#7D7BF5'] });
  const last = txns.length + 1;

  // Budget
  budget.set('A1', 'Household budget 2026', S.title);
  budget.set('A2', 'Actuals are summed from Transactions with SUMIFS · edit the blue budget column', S.subtitle);
  legend(budget, 'M2');
  budget.height(1, 34);
  const months = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];
  budget.row('A4', ['Category', 'Budget / mo'], S.header);
  months.forEach((col, i) => budget.set(`${col}4`, `=DATE(2026, ${i + 1}, 1)`, { ...S.header, numFmt: 'mmm', align: { h: 'right' } }));
  budget.row('O4', ['Total', 'Avg / mo', '% of budget'], { ...S.header, align: { h: 'right' } });
  budget.styleRange('B4', { align: { h: 'right' } });
  const sumifs = (row: number, col: string) =>
    `=SUMIFS(Transactions!$D$2:$D$${last}, Transactions!$C$2:$C$${last}, $A${row}, Transactions!$A$2:$A$${last}, ">="&${col}$4, Transactions!$A$2:$A$${last}, "<="&EOMONTH(${col}$4, 0))`;
  const writeBlock = (startRow: number, items: { cat: string; budget: number }[]) => {
    items.forEach((it, i) => {
      const r = startRow + i;
      budget.set(`A${r}`, it.cat);
      budget.set(`B${r}`, it.budget, { ...S.input, numFmt: MONEY });
      months.forEach((col) => budget.set(`${col}${r}`, sumifs(r, col), { numFmt: MONEY }));
      budget.set(`O${r}`, `=SUM(C${r}:N${r})`, { font: { b: true }, numFmt: MONEY });
      budget.set(`P${r}`, `=AVERAGEIF(C${r}:N${r}, "<>0")`, { numFmt: MONEY });
      budget.set(`Q${r}`, `=IFERROR(O${r}/(B${r}*COUNTIF($C$9:$N$9, ">0")), 0)`, { numFmt: '0%' });
    });
  };
  budget.set('A5', 'INCOME', S.section);
  writeBlock(6, INCOME);
  budget.set('A9', 'Total income', S.total);
  budget.set('B9', '=SUM(B6:B8)', { ...S.total, numFmt: MONEY });
  [...months, 'O', 'P'].forEach((col) => budget.set(`${col}9`, `=SUM(${col}6:${col}8)`, { ...S.total, numFmt: MONEY }));
  budget.set('Q9', '=IFERROR(O9/(B9*COUNTIF($C$9:$N$9, ">0")), 0)', { ...S.total, numFmt: '0%' });
  budget.set('A11', 'EXPENSES', S.section);
  writeBlock(12, EXPENSES);
  budget.set('A24', 'Total expenses', S.total);
  budget.set('B24', '=SUM(B12:B23)', { ...S.total, numFmt: MONEY });
  [...months, 'O', 'P'].forEach((col) => budget.set(`${col}24`, `=SUM(${col}12:${col}23)`, { ...S.total, numFmt: MONEY }));
  budget.set('Q24', '=IFERROR(O24/(B24*COUNTIF($C$9:$N$9, ">0")), 0)', { ...S.total, numFmt: '0%' });
  budget.set('A26', 'Net cash flow', { font: { b: true } });
  budget.set('B26', '=B9-B24', { font: { b: true }, numFmt: '$#,##0;[Red]-$#,##0' });
  [...months, 'O', 'P'].forEach((col) => budget.set(`${col}26`, `=IF(${col}9=0, 0, ${col}9-${col}24)`, { font: { b: true }, numFmt: '$#,##0;[Red]-$#,##0;"–"' }));
  budget.set('A27', 'Savings rate', { font: { color: '#6E6E77' } });
  budget.set('B27', '=IFERROR((B26+B23)/B9, 0)', { numFmt: '0%', font: { color: '#6E6E77' } });
  months.forEach((col) => budget.set(`${col}27`, `=IFERROR((${col}26+${col}23)/${col}9, "")`, { numFmt: '0%' }));
  budget.set('O27', '=IFERROR((O26+O23)/O9, 0)', { numFmt: '0%', font: { b: true } });
  budget.set('A28', 'Running balance', { font: { color: '#6E6E77' } });
  budget.set('C28', '=C26', { numFmt: MONEY });
  months.slice(1).forEach((col, i) => budget.set(`${col}28`, `=IF(${col}9=0, "", ${months[i]}28+${col}26)`, { numFmt: MONEY }));
  budget.freeze(4, 1).width('A', 176).width('B', 104).width('O', 104).width('P', 96).width('Q', 104);
  months.forEach((col) => budget.width(col, 84));
  budget.cf('O12:O23', { kind: 'data_bar', colors: ['#7D7BF5'] });
  budget.cf('Q12:Q23', { kind: 'cell', op: 'gt', values: ['1.05'], style: { font: { color: '#C9302C', b: true } } });
  budget.cf('Q12:Q23', { kind: 'cell', op: 'between', values: ['0.9', '1.05'], style: { font: { color: '#A15C00' } } });
  budget.cf('C27:N27', { kind: 'color_scale', colors: ['#FBE3E4', '#FBF3D9', '#DCF2E3'] });

  // Overview
  overview.set('A1', 'Year to date', S.title);
  overview.set('A2', 'Everything here is calculated from the Budget sheet', S.subtitle);
  overview.height(1, 34);
  overview.row('A4', ['Metric', 'Value'], S.header);
  const kpis: [string, string, string][] = [
    ['Income', '=Budget!O9', MONEY],
    ['Expenses', '=Budget!O24', MONEY],
    ['Net cash flow', '=Budget!O26', '$#,##0;[Red]-$#,##0'],
    ['Savings rate (incl. investing)', '=Budget!O27', '0.0%'],
    ['Average monthly spend', '=AVERAGEIF(Budget!C24:N24, ">0")', MONEY],
    ['Months with data', '=COUNTIF(Budget!C9:N9, ">0")', '0'],
    ['Months over budget', '=COUNTIF(Budget!C24:N24, ">"&Budget!B24)', '0'],
    ['Largest category', '=INDEX(Budget!A12:A23, MATCH(MAX(Budget!O12:O22), Budget!O12:O23, 0))', ''],
    ['Projected year-end savings', '=Budget!O23 + Budget!P26*(12-B10)', MONEY],
  ];
  kpis.forEach(([label, f, fmt], i) => {
    overview.set(`A${5 + i}`, label);
    overview.set(`B${5 + i}`, f, { ...S.output, ...(fmt ? { numFmt: fmt } : {}), align: { h: 'right' } });
  });
  overview.row('D4', ['Top categories', 'Spent', 'Share'], S.header);
  overview.set('D5', '=TAKE(SORTBY(Budget!A12:A22, Budget!O12:O22, -1), 6)');
  overview.set('E5', '=TAKE(SORT(Budget!O12:O22, 1, -1), 6)', { numFmt: MONEY });
  for (let i = 0; i < 6; i++) overview.set(`F${5 + i}`, `=IFERROR(E${5 + i}/SUM(Budget!O12:O22), 0)`, { numFmt: '0.0%' });
  overview.cf('E5:E10', { kind: 'data_bar', colors: ['#14B8A6'] });
  overview.row('A16', ['Checks', ''], S.header);
  overview.set('A17', 'Every transaction has a category');
  overview.set('B17', `=COUNTA(Transactions!C2:C${last})=COUNTA(Transactions!A2:A${last})`, S.check);
  overview.set('A18', 'Categories match the budget');
  overview.set('B18', `=SUM(Budget!O9)=SUMIF(Transactions!C2:C${last}, "Salary", Transactions!D2:D${last})+SUMIF(Transactions!C2:C${last}, "Freelance", Transactions!D2:D${last})+SUMIF(Transactions!C2:C${last}, "Interest", Transactions!D2:D${last})`, S.check);
  overview.cf('B17:B18', { kind: 'cell', op: 'eq', values: ['TRUE'], style: { fill: '#DCF2E3', font: { color: '#0B7F45', b: true } } });
  overview.cf('B17:B18', { kind: 'cell', op: 'eq', values: ['FALSE'], style: { fill: '#FBE3E4', font: { color: '#C9302C', b: true } } });
  overview.freeze(4, 0).width('A', 220).width('B', 120).width('C', 32).width('D', 180).width('E', 112).width('F', 88);
}

// ───────────────────────────────────────────────────────────────────────────── loan / mortgage

export function buildLoan(b: BookBuilder, opts: { principal?: number; rate?: number; years?: number; extra?: number; start?: string } = {}): void {
  const inputs = b.sheet('Inputs');
  const sched = b.sheet('Schedule');
  const rates = b.sheet('Rate scenarios');
  const principal = opts.principal ?? 420_000;
  const rate = opts.rate ?? 0.0625;
  const years = opts.years ?? 30;
  const n = years * 12;
  b.name('Principal', 'Inputs!$B$5')
    .name('Rate', 'Inputs!$B$6')
    .name('Years', 'Inputs!$B$7')
    .name('PPY', 'Inputs!$B$8')
    .name('StartDate', 'Inputs!$B$9')
    .name('Extra', 'Inputs!$B$10')
    .name('Payment', 'Inputs!$B$13');

  inputs.set('A1', 'Mortgage calculator', S.title);
  inputs.set('A2', 'Change the blue inputs — the schedule, payoff date and scenarios update instantly', S.subtitle);
  legend(inputs, 'D3');
  inputs.height(1, 34);
  inputs.row('A4', ['Inputs', ''], S.header);
  const rowsIn: [string, number | string, string][] = [
    ['Loan amount', principal, '$#,##0'],
    ['Annual interest rate', rate, '0.00%'],
    ['Term (years)', years, '0'],
    ['Payments per year', 12, '0'],
    ['First payment', opts.start ?? '2026-02-01', 'yyyy-mm-dd'],
    ['Extra payment per period', opts.extra ?? 250, '$#,##0'],
  ];
  rowsIn.forEach(([label, v, fmt], i) => {
    inputs.set(`A${5 + i}`, label);
    inputs.set(`B${5 + i}`, v, { ...S.input, numFmt: fmt, align: { h: 'right' } });
  });
  inputs.row('A12', ['Results', ''], S.header);
  const out: [string, string, string, boolean?][] = [
    ['Payment per period', '=PMT(Rate/PPY, Years*PPY, -Principal)', '$#,##0.00', true],
    ['Total of payments', '=Payment*Years*PPY', '$#,##0'],
    ['Total interest', '=B14-Principal', '$#,##0'],
    ['With extra payments', '', ''],
    ['Payments until paid off', `=COUNTIF(Schedule!C5:C${4 + n}, ">0.005")`, '0', true],
    ['Payoff date', '=EDATE(StartDate, (B17-1)*12/PPY)', 'mmm yyyy', true],
    ['Total interest', `=SUM(Schedule!E5:E${4 + n})`, '$#,##0'],
    ['Interest saved', '=B15-B19', '$#,##0', true],
    ['Time saved', '=TEXT((Years*PPY-B17)/PPY, "0.0") & " years"', ''],
  ];
  out.forEach(([label, f, fmt, bold], i) => {
    const r = 13 + i;
    if (!f) {
      inputs.set(`A${r}`, label, S.section);
      return;
    }
    inputs.set(`A${r}`, label);
    inputs.set(`B${r}`, f, { ...(bold ? S.output : {}), ...(fmt ? { numFmt: fmt } : {}), align: { h: 'right' } });
  });
  inputs.styleRange('B20', { font: { color: '#0B7F45', b: true } });
  inputs.row('A23', ['Checks', ''], S.header);
  inputs.set('A24', 'Schedule pays the loan off');
  inputs.set('B24', `=ABS(INDEX(Schedule!H5:H${4 + n}, B17))<0.01`, S.check);
  inputs.set('A25', 'Principal paid equals the loan');
  inputs.set('B25', `=ROUND(SUM(Schedule!F5:G${4 + n}), 2)=ROUND(Principal, 2)`, S.check);
  inputs.cf('B24:B25', { kind: 'cell', op: 'eq', values: ['TRUE'], style: { fill: '#DCF2E3', font: { color: '#0B7F45', b: true } } });
  inputs.cf('B24:B25', { kind: 'cell', op: 'eq', values: ['FALSE'], style: { fill: '#FBE3E4', font: { color: '#C9302C', b: true } } });
  inputs.width('A', 220).width('B', 132).width('C', 32);

  sched.set('A1', 'Amortization schedule', S.title);
  sched.set('A2', 'Each row is one payment · extra payments go straight to principal', S.subtitle);
  sched.height(1, 34);
  sched.row('A4', ['#', 'Date', 'Opening balance', 'Payment', 'Interest', 'Principal', 'Extra', 'Closing balance'], { ...S.header, align: { h: 'right' } });
  for (let i = 0; i < n; i++) {
    const r = 5 + i;
    sched.set(`A${r}`, i === 0 ? '1' : `=A${r - 1}+1`, { font: { color: '#8A8A94' } });
    sched.set(`B${r}`, `=EDATE(StartDate, (A${r}-1)*12/PPY)`, { numFmt: 'yyyy-mm-dd' });
    sched.set(`C${r}`, i === 0 ? '=Principal' : `=H${r - 1}`, { numFmt: MONEY2 });
    sched.set(`D${r}`, `=IF(C${r}<=0, 0, MIN(Payment, C${r}*(1+Rate/PPY)))`, { numFmt: MONEY2 });
    sched.set(`E${r}`, `=C${r}*Rate/PPY`, { numFmt: MONEY2 });
    sched.set(`F${r}`, `=D${r}-E${r}`, { numFmt: MONEY2 });
    sched.set(`G${r}`, `=IF(C${r}<=0, 0, MIN(Extra, C${r}-F${r}))`, { numFmt: MONEY2 });
    sched.set(`H${r}`, `=MAX(0, C${r}-F${r}-G${r})`, { numFmt: MONEY2, font: { b: true } });
  }
  sched.freeze(4, 1).width('A', 56).width('B', 104).width('C', 132).width('D', 112).width('E', 104).width('F', 104).width('G', 96).width('H', 140);
  sched.cf(`H5:H${4 + n}`, { kind: 'data_bar', colors: ['#7D7BF5'] });
  sched.cf(`A5:H${4 + n}`, { kind: 'formula', formula: '=AND($C5>0, $H5=0)', style: { fill: '#DCF2E3', font: { b: true } } });

  rates.set('A1', 'Payment by rate and term', S.title);
  rates.set('A2', 'Monthly payment for the loan amount on Inputs · your current rate is highlighted', S.subtitle);
  rates.height(1, 34);
  rates.set('A4', 'Rate \\ Term', S.header);
  [10, 15, 20, 25, 30].forEach((t, i) => rates.at(3, 1 + i, t, { ...S.header, numFmt: '0" yrs"', align: { h: 'right' } }));
  for (let i = 0; i < 13; i++) {
    const r = 5 + i;
    rates.set(`A${r}`, Math.round((0.045 + i * 0.0025) * 10000) / 10000, { numFmt: '0.00%', font: { b: true } });
    ['B', 'C', 'D', 'E', 'F'].forEach((col) => rates.set(`${col}${r}`, `=PMT($A${r}/PPY, ${col}$4*PPY, -Principal)`, { numFmt: '$#,##0' }));
  }
  rates.cf('B5:F17', { kind: 'color_scale', colors: ['#DCF2E3', '#FBF3D9', '#FBE3E4'] });
  rates.cf('A5:F17', { kind: 'formula', formula: '=ROUND($A5, 4)=ROUND(Rate, 4)', style: { font: { b: true }, border: { t: { style: 'medium', color: '#5E5CE6' }, b: { style: 'medium', color: '#5E5CE6' } } } });
  rates.freeze(4, 1).width('A', 120);
  ['B', 'C', 'D', 'E', 'F'].forEach((c) => rates.width(c, 104));
}

// ───────────────────────────────────────────────────────────────────────────── savings / compound interest

export function buildSavings(b: BookBuilder): void {
  const sh = b.sheet('Growth');
  b.name('Start', 'Growth!$B$5').name('Monthly', 'Growth!$B$6').name('Return', 'Growth!$B$7').name('Inflation', 'Growth!$B$8').name('Horizon', 'Growth!$B$9');
  sh.set('A1', 'Savings & compound interest', S.title);
  sh.set('A2', 'FV(Rate/12, Years*12, −Monthly, −Start) with an inflation-adjusted column', S.subtitle);
  legend(sh, 'D3');
  sh.row('A4', ['Inputs', ''], S.header);
  ([['Starting balance', 10_000, '$#,##0'], ['Monthly contribution', 500, '$#,##0'], ['Expected annual return', 0.06, '0.0%'], ['Inflation', 0.025, '0.0%'], ['Years', 25, '0']] as const).forEach(([l, v, f], i) => {
    sh.set(`A${5 + i}`, l);
    sh.set(`B${5 + i}`, v, { ...S.input, numFmt: f, align: { h: 'right' } });
  });
  sh.row('A11', ['Year', 'Balance', 'Contributions', 'Growth', "In today's money"], { ...S.header, align: { h: 'right' } });
  for (let y = 1; y <= 40; y++) {
    const r = 11 + y;
    sh.set(`A${r}`, `=IF(${y}>Horizon, "", ${y})`);
    sh.set(`B${r}`, `=IF(A${r}="", "", FV(Return/12, A${r}*12, -Monthly, -Start))`, { numFmt: '$#,##0', font: { b: true } });
    sh.set(`C${r}`, `=IF(A${r}="", "", Start+Monthly*12*A${r})`, { numFmt: '$#,##0' });
    sh.set(`D${r}`, `=IF(A${r}="", "", B${r}-C${r})`, { numFmt: '$#,##0' });
    sh.set(`E${r}`, `=IF(A${r}="", "", B${r}/(1+Inflation)^A${r})`, { numFmt: '$#,##0' });
  }
  sh.cf('B12:B51', { kind: 'data_bar', colors: ['#14B8A6'] });
  sh.freeze(11, 0).width('A', 200).width('B', 120).width('C', 120).width('D', 120).width('E', 140);
}

export function buildBlank(b: BookBuilder, name = 'Sheet1'): void {
  b.sheet(name);
}

export const TEMPLATES: Record<string, { title: string; build: (b: BookBuilder) => void }> = {
  blank: { title: 'Untitled spreadsheet', build: (b) => buildBlank(b) },
  budget: { title: 'Budget', build: (b) => buildBudget(b) },
  loan: { title: 'Loan calculator', build: (b) => buildLoan(b) },
  mortgage: { title: 'Mortgage calculator', build: (b) => buildLoan(b) },
  savings: { title: 'Savings growth', build: (b) => buildSavings(b) },
};
