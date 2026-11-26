import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/helpers';

const visible = { r0: 0, c0: 0, r1: 99, c1: 25 };

describe('sheets mock backend', () => {
  it('works end-to-end on the demo seed', async () => {
    const { api, backend } = await mockApi();
    const ws = backend.ctx.workspaceId();
    const { page, sheets } = await api.sheet.workbookCreate({ workspaceId: ws, parentId: null, title: 'Test' });
    const sheetId = sheets[0].id;
    const r1 = await api.sheet.setCells({ sheetId, edits: [{ row: 0, col: 0, input: '2' }, { row: 1, col: 0, input: '=A1*21' }, { row: 2, col: 0, input: '$1,200' }], visible });
    expect(r1.changed.d).toContain('42');
    expect(r1.changed.d).toContain('$1,200');
    const bad = await api.sheet.setCells({ sheetId, edits: [{ row: 5, col: 0, input: '=SUM(' }], visible });
    expect(bad.errors?.length).toBe(1);
    const r2 = await api.sheet.setCells({ sheetId, edits: [{ row: 0, col: 0, input: '3' }], visible });
    expect(r2.changed.d).toContain('63');
    await api.sheet.undo({ workbookId: page.id });
    const cell = await api.sheet.getCell({ sheetId, row: 1, col: 0 });
    expect(cell.display).toBe('42');
    expect(cell.input).toBe('=A1*21');
    // fill series
    await api.sheet.setCells({ sheetId, edits: [{ row: 0, col: 1, input: 'Jan' }], visible });
    const fill = await api.sheet.fill({ sheetId, source: { r0: 0, c0: 1, r1: 0, c1: 1 }, target: { r0: 0, c0: 1, r1: 3, c1: 1 }, mode: 'series' });
    expect(fill.changed.d).toEqual(['Feb', 'Mar', 'Apr']);
    // copy + paste with formula shift
    const copy = await api.sheet.copy({ sheetId, rect: { r0: 1, c0: 0, r1: 1, c1: 0 } });
    expect(copy.tsv).toBe('42');
    const paste = await api.sheet.paste({ sheetId, at: { row: 1, col: 2 }, clip: copy.clip, mode: 'all', visible });
    const pasted = await api.sheet.getCell({ sheetId, row: 1, col: 2 });
    expect(pasted.input).toBe('=C1*21');
    expect(paste.changed.r.length).toBeGreaterThan(0);
    // insert a row above row 1: references move
    await api.sheet.insert({ sheetId, axis: 'rows', at: 0, count: 1 });
    const moved = await api.sheet.getCell({ sheetId, row: 2, col: 0 });
    expect(moved.input).toBe('=A2*21');
    // sheets
    const s2 = await api.sheet.add({ workbookId: page.id });
    await api.sheet.setCells({ sheetId: s2.id, edits: [{ row: 0, col: 0, input: `=${sheets[0].name}!A2+1` }], visible });
    await api.sheet.update({ id: sheetId, patch: { name: 'Inputs' } });
    const ref = await api.sheet.getCell({ sheetId: s2.id, row: 0, col: 0 });
    expect(ref.input).toBe('=Inputs!A2+1');
    expect(ref.display).toBe('3');
    const range = await api.sheet.getRange({ sheetId, rect: { r0: 0, c0: 0, r1: 255, c1: 31 } });
    expect(range.cells.r.length).toBeGreaterThan(3);
    const fns = await api.sheet.functions({});
    expect(fns.length).toBeGreaterThan(150);
    const ev = await api.sheet.eval({ formula: '=PMT(5%/12, 60, -20000)' });
    expect(ev.display).toBe('377.4246729');
  });

  it('seeds demo workbooks', async () => {
    const { api, backend } = await mockApi();
    const id = backend.ctx.seedRefs.get('sheets.page.mortgage')!;
    const wb = await api.sheet.workbookGet({ id });
    expect(wb.sheets.map((s) => s.name)).toEqual(['Inputs', 'Schedule', 'Rate scenarios']);
    const lint = await api.sheet.lint({ workbookId: id });
    expect(lint.filter((l) => l.rule === 'ref_error')).toEqual([]);
  });
});
