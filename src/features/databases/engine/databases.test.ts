import { describe, expect, it } from 'vitest';
import { createMockBackend } from '@/backend/mock';
import type { DbQueryResult, DbSchema, RowDTO } from '@/backend/types';
import { compile, evaluate, toComputed, type FormulaHost } from './formula';
import { parseCsv, inferType } from './csv';
import { plainText } from './values';

const host: FormulaHost = { now: Date.UTC(2026, 10, 26), value: () => null, resolveRow: () => null };
const row: RowDTO = { id: 'r', rev: 1, sortKey: 'a', createdAt: 0, updatedAt: 0, values: {}, hasBody: false };

function run(expr: string) {
  return toComputed(evaluate(compile(expr, []), row, [], host)).display;
}

describe('formula engine', () => {
  it('evaluates arithmetic, text and lists', () => {
    expect(run('1 + 2 * 3')).toBe('7');
    expect(run('"a" + "b"')).toBe('ab');
    expect(run('[3, 1, 2].sort().join("-")')).toBe('1-2-3');
    expect(run('[1,2,3,4].filter(current > 2).sum()')).toBe('7');
    expect(run('if(true, "y", "n")')).toBe('y');
    expect(run('let(x, 4, x * x)')).toBe('16');
    expect(run('10 / 0')).toBe('');
    expect(run('round(pmt(0.05/12, 360, 300000), 2)')).toBe('−1,610.46');
  });
  it('reports errors with spans', () => {
    expect(() => compile('foo(1)', [])).toThrow(/Unknown function/);
    expect(() => compile('prop("Nope")', [])).toThrow(/no property/);
    expect(() => compile('1 +', [])).toThrow();
  });
});

describe('csv', () => {
  it('parses quotes and infers types', () => {
    const rows = parseCsv('Name,Amount,When\n"Smith, J",$12.50,2026-01-02\nLee,$3,2026-02-03\n');
    expect(rows[1][0]).toBe('Smith, J');
    expect(inferType(['$12.50', '$3'], false)).toBe('money');
    expect(inferType(['2026-01-02', '2026-02-03'], false)).toBe('date');
  });
});

describe('databases mock', () => {
  it('seeds and queries with filter, sort, group and aggregates', async () => {
    const be = await createMockBackend({ seed: 'demo' });
    const pages = (await be.call('search_query', { q: 'Client CRM', reqId: 1, limit: 5 }).catch(() => null)) as unknown;
    void pages;
    const dbs = be.ctx.db.table<{ id: string }>('db_databases').all();
    expect(dbs.length).toBeGreaterThanOrEqual(4);
    const crmId = be.ctx.seedRefs.get('db.crm')!;
    const schema = (await be.call('db_get_schema', { id: crmId })) as DbSchema;
    const pipeline = schema.views.find((v) => v.name === 'Pipeline')!;
    const res = (await be.call('db_query', { databaseId: crmId, viewId: pipeline.id, window: { offset: 0, limit: 100 }, reqId: 1 })) as Extract<DbQueryResult, { rows: RowDTO[] }>;
    expect(res.total).toBe(18);
    const deal = schema.properties.find((p) => p.name === 'Deal value')!;
    expect(res.aggs[deal.id]).toMatch(/\$/);
    const weighted = schema.properties.find((p) => p.name === 'Weighted')!;
    const first = res.rows[0];
    expect(first.values[weighted.id]?.t).toBe('computed');
    // sorted desc by deal value
    expect(Number((res.rows[0].values[deal.id] as { v: string }).v)).toBeGreaterThanOrEqual(Number((res.rows[1].values[deal.id] as { v: string }).v));
    // rollup
    const roll = schema.properties.find((p) => p.name === 'Project budget');
    expect(roll).toBeTruthy();
    // board groups
    const board = schema.views.find((v) => v.name === 'By stage')!;
    const g = (await be.call('db_query', { databaseId: crmId, viewId: board.id, window: { offset: 0, limit: 0 }, reqId: 2 })) as Extract<DbQueryResult, { rows: RowDTO[] }>;
    expect(g.groups?.length).toBeGreaterThan(3);
    // search
    const s = (await be.call('db_query', { databaseId: crmId, override: { search: 'ledger' }, window: { offset: 0, limit: 10 }, reqId: 3 })) as Extract<DbQueryResult, { rows: RowDTO[] }>;
    expect(s.total).toBe(1);
    expect(plainText((s.rows[0].values[schema.database.primaryPropId] as unknown as { v: never }).v)).toBe('Ledgerline');
    // formula check
    const fc = (await be.call('db_formula_check', { databaseId: crmId, expression: 'prop("Deal value") * 2' })) as { ok: boolean; type?: string; preview: string[] };
    expect(fc.ok).toBe(true);
    expect(fc.type).toBe('money');
    // chart
    const chart = (await be.call('db_chart_data', { databaseId: crmId, spec: { type: 'bar', x: { prop: schema.properties.find((p) => p.name === 'Stage')!.id }, y: [{ agg: 'sum', prop: deal.id }] } })) as { x: string[]; series: { values: number[] }[] };
    expect(chart.x.length).toBe(6);
    // create + update + move
    const r = (await be.call('db_row_create', { databaseId: crmId, values: {} })) as RowDTO;
    const upd = (await be.call('db_rows_update', { updates: [{ id: r.id, values: { [schema.database.primaryPropId]: { t: 'text', v: [{ text: 'Acme' }] } } }] })) as RowDTO[];
    expect(plainText((upd[0].values[schema.database.primaryPropId] as unknown as { v: never }).v)).toBe('Acme');
    const acct = schema.properties.find((p) => p.name === 'Account')!;
    expect((upd[0].values[acct.id] as { v: string }).v).toBe('ACC-19');
  });

  it('builds the perf seed quickly and windows 10k rows', async () => {
    const be = await createMockBackend({ seed: 'perf' });
    const db = be.ctx.db.table<{ id: string }>('db_databases').all()[0];
    const t0 = performance.now();
    const res = (await be.call('db_query', { databaseId: db.id, window: { offset: 9800, limit: 200 }, reqId: 1 })) as Extract<DbQueryResult, { rows: RowDTO[] }>;
    const t1 = performance.now();
    expect(res.total).toBe(10_000);
    expect(res.rows.length).toBe(200);
    const res2 = (await be.call('db_query', { databaseId: db.id, window: { offset: 0, limit: 200 }, reqId: 2 })) as Extract<DbQueryResult, { rows: RowDTO[] }>;
    expect(res2.rows.length).toBe(200);
    expect(performance.now() - t1).toBeLessThan(t1 - t0 + 50);
  }, 60_000);
});
