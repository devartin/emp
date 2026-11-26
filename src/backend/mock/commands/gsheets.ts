/** Google Sheets import / export (§17.1): workbook or database import with frozen unsupported functions. */
import { BackendError } from '../../errors';
import type { MockHandlers } from '../ctx';
import type { DbApi } from './db';
import { createWorkbook } from './sheet';
import { gLog, requireAccount, requireOnline, SCOPES } from '@/features/integrations/mock/googleStore';

const SHEET_RE = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
const ROWS: [string, string, number, number][] = [
  ['Flights', 'Travel', 864.4, 3],
  ['Hotel — 5 nights', 'Travel', 742.15, 3],
  ['Dinner at Taberna', 'Food', 126.8, 3],
  ['Tram passes', 'Transport', 48.6, 2],
  ['Sintra day trip', 'Activities', 154, 3],
];

export const handlers: MockHandlers = {
  gsheets_import: async (req, ctx) => {
    requireOnline(ctx);
    const m = SHEET_RE.exec(req.url ?? '');
    if (!m) throw new BackendError('INVALID', 'Paste a Google Sheets link — it contains /spreadsheets/d/…', { field: 'url' });
    requireAccount(ctx, req.accountId, SCOPES.sheets_import[0]);
    ctx.progress(1, 3, 'Reading sheets and formats');
    gLog(ctx, 'GET', 'sheets.googleapis.com', '/v4/spreadsheets/{spreadsheetId}', 200, 6_400);
    await ctx.sleep(400, ctx.signal);
    ctx.progress(2, 3, 'Reading formulas and values');
    gLog(ctx, 'GET', 'sheets.googleapis.com', '/v4/spreadsheets/{spreadsheetId}/values:batchGet', 200, 21_800);
    gLog(ctx, 'GET', 'sheets.googleapis.com', '/v4/spreadsheets/{spreadsheetId}/values:batchGet', 200, 18_300);
    await ctx.sleep(400, ctx.signal);
    if (req.asDatabase) {
      const db = ctx.services.get<DbApi>('db.api');
      if (!db) throw new BackendError('INTERNAL', 'Databases are not available');
      const res = db.createDatabase(ctx, {
        workspaceId: req.workspaceId,
        parentId: req.parentId,
        title: 'Trip expenses',
        icon: { t: 'emoji', v: '🧳' },
        properties: [{ name: 'Item', type: 'title' }, { name: 'Category', type: 'select', config: { options: [{ name: 'Travel' }, { name: 'Food' }, { name: 'Transport' }, { name: 'Activities' }] } }, { name: 'Amount', type: 'money', config: { currency: 'USD' } }, { name: 'People', type: 'number' }],
      });
      const schema = db.schema(ctx, res.db.id);
      const p = Object.fromEntries(schema.properties.map((x) => [x.name, x]));
      const opt = (name: string) => ((p.Category.config.options as { id: string; name: string }[]) ?? []).find((o) => o.name === name)?.id ?? null;
      for (const [item, cat, amt, people] of ROWS) db.createRow(ctx, res.db.id, { values: { [p.Item.id]: { t: 'text', v: [{ text: item }] }, [p.Category.id]: { t: 'select', v: opt(cat) }, [p.Amount.id]: { t: 'money', v: amt.toFixed(2), cur: 'USD' }, [p.People.id]: { t: 'number', v: people } } });
      ctx.progress(3, 3, 'Done');
      return { page: res.page, warnings: [] };
    }
    const wb = createWorkbook(ctx, {
      workspaceId: req.workspaceId,
      parentId: req.parentId,
      title: 'Trip expenses',
      icon: { t: 'emoji', v: '🧳' },
      build: (b) => {
        const sh = b.sheet('Expenses');
        sh.row('A1', ['Item', 'Category', 'Amount', 'People', 'Per person'], { font: { b: true }, fill: '#F1F1F0' });
        ROWS.forEach(([item, cat, amt, people], i) => {
          sh.row(`A${i + 2}`, [item, cat, amt, people]);
          sh.set(`E${i + 2}`, `=C${i + 2}/D${i + 2}`, { numFmt: '$#,##0.00' });
        });
        sh.set('A8', 'EUR → USD');
        sh.set('C8', '1.08', { numFmt: '0.0000' });
        sh.freeze(1, 0).width('A', 180);
      },
    });
    ctx.progress(3, 3, 'Done');
    return { page: wb.page, warnings: ['1 cell used GOOGLETRANSLATE, which EMP doesn’t support — its value was frozen at import (amber corner flag).'] };
  },
  gsheets_export: async (req, ctx) => {
    requireOnline(ctx);
    requireAccount(ctx, req.accountId, SCOPES.export[0]);
    ctx.progress(1, 3, 'Creating the spreadsheet');
    gLog(ctx, 'POST', 'sheets.googleapis.com', '/v4/spreadsheets', 200, 640);
    await ctx.sleep(300, ctx.signal);
    ctx.progress(2, 3, 'Writing values');
    gLog(ctx, 'POST', 'sheets.googleapis.com', '/v4/spreadsheets/{spreadsheetId}/values:batchUpdate', 200, 2_100);
    await ctx.sleep(300, ctx.signal);
    ctx.progress(3, 3, 'Formatting header, frozen row and widths');
    gLog(ctx, 'POST', 'sheets.googleapis.com', '/v4/spreadsheets/{spreadsheetId}:batchUpdate', 200, 480);
    const fileId = `1${ctx.id().replace(/-/g, '').slice(0, 32)}`;
    return { fileId, webViewLink: `https://docs.google.com/spreadsheets/d/${fileId}/edit` };
  },
};
