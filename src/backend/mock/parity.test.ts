/**
 * Mock ↔ desktop parity (PROGRAMME-v3 K5, "every truth fix gets a Rust test and a mock↔desktop parity test").
 *
 * Runs `crates/emp-finance/tests/fixtures/parity/fixture.json` — accounts, transactions, statement imports (OFX,
 * an oldest-first CSV, a newest-first CSV, an inverted card CSV, QIF, then the OFX again), tax inputs in every
 * deduction mode and Tax Organizer deduction rows (option → engine kind → `TaxInput`) — through the browser mock and
 * compares every figure with the fixture's `expect`. The Deductions category options must equal the desktop
 * manifest's (`crates/emp-store/lifeapps/tax-organizer.json`) and `TAX_DEDUCTION_CATEGORIES`. The desktop side runs the same fixture through the app's command path
 * (`src-tauri/src/commands/finance.rs`, `parity_fixture_matches_the_mock`) against the same `expect`, so any
 * mock↔desktop difference fails one of the two.
 *
 * `PARITY_PRINT=1 npx vitest run src/backend/mock/parity.test.ts` prints the mock's figures.
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/helpers';
import type { CellValue, FileGrant, Id, ImportMapping, TaxInput } from '@/backend/types';
import { createRow, type DbRecord, type PropRecord, type RowRecord } from './commands/db';
import { provisionMoneyHq, provisionTax, V } from './seed/finance';
import { TAX_DEDUCTION_CATEGORIES, taxDeductionKind } from '../taxDeductions';

const DIR = new URL('../../../crates/emp-finance/tests/fixtures/parity/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, DIR), 'utf8');

interface Fixture {
  today: string;
  month: string;
  accounts: { name: string; type: string; opening: string }[];
  transactions: { account: string; date: string; amount: string; payee: string; category: string }[];
  imports: { file: string; account: string; mapping?: ImportMapping }[];
  tax: { name: string; input: TaxInput }[];
  deductionCategories: { key: string; name: string; kind?: string }[];
  deductionRows: { rows: { desc: string; category: string; amount: string; pct: number }[]; input: TaxInput };
  expect: unknown;
}

const fx = JSON.parse(read('fixture.json')) as Fixture;
const cents = (s: string) => Math.round(Number(s) * 100);
/** Money as a fixed 2-decimal string, so "1234.5" and "1234.50" compare equal across both sides. */
const m2 = (s: string | number) => (Math.round(Number(s) * 100) / 100).toFixed(2);
/** Same rounding as the Rust side (`(x * 1e10).round() / 1e10`). */
const rate = (x: number) => Math.round(x * 1e10) / 1e10;

async function runMock() {
  const { api, backend } = await mockApi({ freeze: Date.parse(`${fx.today}T15:30:00Z`) });
  const ctx = backend.ctx;
  const set = provisionMoneyHq(ctx, { instanceId: 'parity-hq', parentId: null, sample: false, workspaceId: ctx.workspaceId() });
  const dbT = ctx.db.table<DbRecord>('db_databases');
  const roles = (id: Id) => dbT.require(id).roles;
  const primary = (id: Id) => dbT.require(id).primaryPropId;
  const A = roles(set.dbs.accounts);
  const T = roles(set.dbs.txns);
  const acct = new Map<string, Id>();
  for (const a of fx.accounts) {
    const r = createRow(ctx, set.dbs.accounts, {
      silent: true,
      values: { [primary(set.dbs.accounts)]: V.text(a.name), [A['acct.type']]: V.sel(a.type), [A['acct.opening']]: V.money(cents(a.opening)), [A['acct.on_budget']]: V.check(true) },
    });
    acct.set(a.name, r.id);
  }
  const rows = ctx.db.table<RowRecord>('db_rows');
  const catId = (name: string) => rows.all().find((r) => r.databaseId === set.dbs.categories && !r.deletedAt && r.values[primary(set.dbs.categories)]?.t === 'text' && (r.values[primary(set.dbs.categories)] as { v: { text: string }[] }).v.map((x) => x.text).join('') === name)?.id;
  for (const t of fx.transactions) {
    const c = catId(t.category);
    if (!c) throw new Error(`mock has no category ${t.category}`);
    const values: Record<Id, CellValue> = {
      [primary(set.dbs.txns)]: V.text(t.payee),
      [T['txn.date']]: V.date(t.date),
      [T['txn.amount']]: V.money(cents(t.amount)),
      [T['txn.account']]: V.rel([acct.get(t.account)!]),
      [T['txn.category']]: V.rel([c]),
      [T['txn.cleared']]: V.status('cleared'),
      [T['txn.source']]: V.sel('manual'),
      [T['txn.reviewed']]: V.check(true),
    };
    createRow(ctx, set.dbs.txns, { silent: true, values });
  }

  const imports = [];
  const before = new Set(rows.all().filter((r) => r.databaseId === set.dbs.txns).map((r) => r.id));
  for (const imp of fx.imports) {
    const grant: FileGrant = ctx.grants.register(new File([read(imp.file)], imp.file), 'import');
    const start = await api.finance.importStart({ instanceId: 'parity-hq', grantId: grant.grantId });
    const mapping = imp.mapping ?? start.mappingGuess;
    const accountId = acct.get(imp.account)!;
    const pv = await api.finance.importPreview({ importId: start.importId, mapping, accountId });
    const job = await api.finance.importCommit({ importId: start.importId, mapping, accountId, skip: [], overrides: {} });
    const r = await job.result;
    imports.push({
      file: imp.file,
      inserted: r.inserted,
      skipped: r.skipped,
      newCount: pv.newCount,
      duplicates: pv.duplicates,
      statement: pv.statement ? { ...pv.statement, balance: m2(pv.statement.balance) } : null,
    });
  }
  const sel = (v: CellValue | undefined) => (v && (v.t === 'select' || v.t === 'status') ? v.v : null);
  const imported = rows
    .all()
    .filter((r) => r.databaseId === set.dbs.txns && !before.has(r.id) && !r.deletedAt)
    .map((r) => {
      const amt = r.values[T['txn.amount']];
      const date = r.values[T['txn.date']];
      return {
        date: date?.t === 'date' ? date.v?.start ?? '' : '',
        amount: amt?.t === 'money' ? m2(amt.v ?? '0') : '',
        cleared: sel(r.values[T['txn.cleared']]),
        source: sel(r.values[T['txn.source']]),
        reviewed: r.values[T['txn.reviewed']]?.t === 'check' ? (r.values[T['txn.reviewed']] as { v: boolean }).v : null,
      };
    })
    .sort((a, b) => (a.date + a.amount < b.date + b.amount ? -1 : 1));

  const ov = await api.finance.overview({ instanceId: 'parity-hq', month: fx.month });
  const from = `${fx.month}-01`;
  const spentRows = await api.finance.spendingBreakdown({ instanceId: 'parity-hq', from, to: fx.today, by: 'category' });
  const tax = [];
  for (const t of fx.tax) {
    const e = await api.tax.estimate(t.input);
    tax.push({
      name: t.name,
      agi: m2(e.agi),
      taxable: m2(e.taxable),
      deduction: { kind: e.deduction.kind, amount: m2(e.deduction.amount), standardWouldBe: m2(e.deduction.standardWouldBe), itemizedWouldBe: e.deduction.itemizedWouldBe === undefined ? null : m2(e.deduction.itemizedWouldBe) },
      totalTax: m2(e.totalTax),
      balance: m2(e.balance),
      effectiveRate: rate(e.effectiveRate),
    });
  }
  // Tax Organizer Deductions rows → TaxInput, the way the Tax hub builds it: option → engine kind, amount × pct.
  const taxSet = provisionTax(ctx, { instanceId: 'parity-tax', parentId: null, sample: false, workspaceId: ctx.workspaceId(), year: 2026 });
  const X = roles(taxSet.dbs.deductions);
  const props = ctx.db.table<PropRecord>('db_properties');
  const catProp = props.require(X['taxded.category']);
  const options = (catProp.config.options ?? []) as { id: string; name: string }[];
  for (const r of fx.deductionRows.rows) {
    const opt = options.find((o) => o.name === r.category);
    if (!opt) throw new Error(`mock has no deduction category ${r.category}`);
    createRow(ctx, taxSet.dbs.deductions, {
      silent: true,
      values: { [primary(taxSet.dbs.deductions)]: V.text(r.desc), [X['taxded.category']]: V.sel(opt.id), [X['taxded.amount']]: V.money(cents(r.amount)), [X['taxded.pct']]: V.num(r.pct) },
    });
  }
  const itemized = rows
    .all()
    .filter((r) => r.databaseId === taxSet.dbs.deductions && !r.deletedAt)
    .flatMap((r) => {
      const c = r.values[X['taxded.category']];
      const opt = options.find((o) => c?.t === 'select' && o.id === c.v);
      const kind = taxDeductionKind(opt);
      const amt = r.values[X['taxded.amount']];
      const pct = r.values[X['taxded.pct']];
      if (!kind || amt?.t !== 'money') return [];
      return [{ kind, amount: m2(Number(amt.v ?? 0) * (pct?.t === 'number' && pct.v !== null ? pct.v : 1)) }];
    });
  const dInput = fx.deductionRows.input;
  const dMode = typeof dInput.deductions === 'object' ? dInput.deductions.mode : undefined;
  const dEst = await api.tax.estimate({ ...dInput, deductions: { itemized, ...(dMode ? { mode: dMode } : {}) } });
  const deductionRows = {
    categories: options.map((o) => o.name),
    itemized,
    deduction: { kind: dEst.deduction.kind, amount: m2(dEst.deduction.amount), standardWouldBe: m2(dEst.deduction.standardWouldBe), itemizedWouldBe: dEst.deduction.itemizedWouldBe === undefined ? null : m2(dEst.deduction.itemizedWouldBe) },
    totalTax: m2(dEst.totalTax),
  };

  return {
    // The ledger's own figures: the demo workspace's Portfolio (counted in `assets` as `investments`) is left out,
    // as the desktop side runs without Portfolio installed.
    netWorth: m2(Number(ov.netWorth.amount) - Number(ov.investments?.amount ?? 0)),
    assets: m2(Number(ov.assets.amount) - Number(ov.investments?.amount ?? 0)),
    liabilities: m2(ov.liabilities.amount),
    savingsRate3m: rate(ov.savingsRate3m),
    spent: m2(spentRows.reduce((s, r) => s + Number(r.amount), 0)),
    toReview: imported.filter((r) => r.reviewed === false).length,
    imports,
    imported,
    tax,
    deductionRows,
  };
}

describe('mock ↔ desktop parity fixture', () => {
  it('uses one list of Tax Organizer deduction categories', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../crates/emp-store/lifeapps/tax-organizer.json', import.meta.url), 'utf8')) as {
      templates: { key: string; spec?: { properties?: { role?: string; format?: string; options?: { key: string; name: string }[] }[]; rowTemplates?: { values?: Record<string, unknown> }[] } }[];
    };
    const ded = manifest.templates.find((t) => t.key === 'deductions')?.spec;
    const cat = ded?.properties?.find((p) => p.role === 'taxded.category');
    const pct = ded?.properties?.find((p) => p.role === 'taxded.pct');
    const want = fx.deductionCategories.map((c) => ({ key: c.key, name: c.name }));
    expect(cat?.options?.map((o) => ({ key: o.key, name: o.name }))).toEqual(want);
    expect(TAX_DEDUCTION_CATEGORIES.map((c) => ({ key: c.key, name: c.name, ...('kind' in c ? { kind: c.kind } : {}) }))).toEqual(fx.deductionCategories);
    // `pct` is a fraction on both sides (1 = 100%).
    expect(pct?.format).toBe('percent');
    expect(ded?.rowTemplates?.[0]?.values?.pct).toBe(1);
    // Desktop option ids are generated, so the name maps too.
    expect(taxDeductionKind({ id: 'h4sh', name: 'Mortgage interest' })).toBe('mortgage');
    expect(taxDeductionKind({ id: 'charity', name: 'renamed' })).toBe('charity');
    expect(taxDeductionKind({ id: 'h4sh', name: 'Traditional IRA contribution' })).toBeUndefined();
  });

  it('produces exactly the fixture figures', async () => {
    const got = await runMock();
    if (process.env.PARITY_PRINT === '1') console.log(JSON.stringify(got, null, 2));
    expect(got).toEqual(fx.expect);
  });
});
